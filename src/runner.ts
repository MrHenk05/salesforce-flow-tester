import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { JSHandle, Locator, Page } from 'playwright';
import { ensureLoggedIn, isLoginPage } from './browser.js';
import { resolveStartUrl, type FieldConfig, type Scenario, type ScreenConfig, type UploadConfig } from './config.js';
import { selectDocuments } from './documents.js';
import { chooseOption, selectLookup, setFieldValue, type FillContext, type FillResult } from './fill.js';
import { maskValue, namespaceOwner, screenRecord, type Issue, type RunReport } from './report.js';
import { scanScreen, settleScreen, type ScannedField, type ScreenScan } from './scan.js';
import { uploadFiles } from './upload.js';
import { createRng, generateValue, isPlaceholderOption } from './values.js';

export interface RunOptions {
  mode: 'inspect' | 'run';
  log?: (message: string) => void;
}

type NavResult = 'transition' | 'errors' | 'fault' | 'gone' | 'login' | 'busy' | 'nochange';

const textKinds = new Set(['text', 'textarea', 'richtext', 'email', 'tel', 'url', 'number', 'date', 'time', 'datetime']);
const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();

export class AllowedOrgError extends Error {}

export function assertRunAllowed(scenario: Scenario): void {
  if (!scenario.allowedOrgUrls.length) {
    throw new AllowedOrgError('Run geweigerd: "allowedOrgUrls" is leeg. Stel expliciet de org-URL in waarop gegevens mogen worden aangemaakt.');
  }
  const origin = resolveStartUrl(scenario).origin;
  if (!scenario.allowedOrgUrls.includes(origin)) {
    throw new AllowedOrgError(`Run geweigerd: start-URL ${origin} staat niet in allowedOrgUrls (${scenario.allowedOrgUrls.join(', ')}).`);
  }
}

export async function runFlow(page: Page, scenario: Scenario, report: RunReport, opts: RunOptions): Promise<void> {
  const flow = new FlowRun(page, scenario, report, opts);
  try {
    await flow.execute();
  } finally {
    report.finishedAt = new Date().toISOString();
    flow.decideStatus();
  }
}

class FlowRun {
  private scope!: Locator;
  private frameRoot!: Locator;
  private step = 0;
  private stopped: 'blocked' | 'failed' | undefined;
  private outcomeDone = false;
  private readonly performedUploads = new Set<string>();
  private readonly log: (message: string) => void;

  constructor(
    private readonly page: Page,
    private readonly scenario: Scenario,
    private readonly report: RunReport,
    private readonly opts: RunOptions,
  ) {
    this.log = opts.log ?? (() => undefined);
  }

  async execute() {
    const { scenario, page } = this;
    if (this.opts.mode === 'run') assertRunAllowed(scenario);
    const target = resolveStartUrl(scenario);
    this.log(`Openen: ${target.origin}${target.pathname}`);
    await page.goto(target.href, { timeout: scenario.timeouts.navigationMs });
    await ensureLoggedIn(page, scenario, target, this.log);

    if (this.opts.mode === 'run' && !scenario.allowedOrgUrls.includes(new URL(page.url()).origin)) {
      return this.issue('blokkerend', 'org', `pagina staat op ${new URL(page.url()).origin}, niet in allowedOrgUrls; er is niets ingevuld`);
    }
    const container = await this.findContainer();
    if (typeof container === 'string') return this.issue('blokkerend', 'flowcontainer', container);
    ({ scope: this.scope, frameRoot: this.frameRoot } = container);

    if (this.opts.mode === 'inspect') return this.inspect();
    await this.walk();
    if (!this.stopped) await this.evaluateOutcome();
  }

  private async inspect() {
    this.step = 1;
    const scan = await settleScreen(this.scope, this.scenario.timeouts.settleMs);
    await this.recordScreen(scan);
    for (const text of scan.inaccessible) this.issue('waarschuwing', 'ontoegankelijk component', text);
    for (const c of scan.components) {
      this.issue('waarschuwing', `namespace ${c.namespace}`, `${c.tags.join(', ')}: ${namespaceOwner(c.namespace, this.scenario)}`);
    }
    this.log(`Inspect: ${scan.fields.length} velden, ${scan.uploads.length} uploadcomponenten, ${scan.inaccessible.length} ontoegankelijke onderdelen.`);
  }

  private async walk() {
    const { scenario } = this;
    const visits = new Map<string, number>();
    let finishing = false;

    while (!this.stopped) {
      if (this.step >= scenario.maxSteps) {
        return this.issue('blokkerend', 'schermstappen', `maximaal aantal schermstappen (${scenario.maxSteps}) bereikt`);
      }
      this.step++;
      const scan = await settleScreen(this.scope, scenario.timeouts.settleMs);
      const matched = this.matchScreen(scan);
      await this.recordScreen(scan, matched?.index);
      this.log(`Stap ${this.step}: ${scan.headings[0] ?? '(geen kop)'} — ${scan.fields.length} velden, ${scan.uploads.length} uploads`);

      if (finishing) {
        this.report.endState = 'afgerond';
        return;
      }
      for (const text of scan.inaccessible) this.issue('waarschuwing', 'ontoegankelijk component', text);
      if (!scan.settled) this.issue('waarschuwing', 'scherm', `scherm bleef veranderen of laden binnen ${scenario.timeouts.settleMs} ms`);
      if (this.isFault(scan)) return this.issue('fout', 'flowfout', scan.errors.join(' | ') || 'flowfout gedetecteerd');
      const seen = (visits.get(scan.structure) ?? 0) + 1;
      visits.set(scan.structure, seen);
      if (seen > 2) return this.issue('blokkerend', 'navigatie', 'hetzelfde scherm is drie keer bereikt; mogelijke navigatielus');

      const cfg = matched?.screen;
      for (const text of cfg?.expect?.texts ?? []) await this.checkText(text, 'Verwachte schermtekst');
      if (await this.reachedTargetScreen()) return;

      await this.fillScreen(scan, cfg);
      if (this.stopped) return;
      await this.handleUploads(cfg);
      if (this.stopped) return;

      const after = await settleScreen(this.scope, scenario.timeouts.settleMs);
      if (after.errors.length) return this.handleErrors(after.errors, cfg, 'na invullen');
      if (this.report.issues.some((i) => i.severity === 'blokkerend' && i.step === this.step)) {
        this.stopped = 'blocked';
        return;
      }

      const action = await this.chooseAction(cfg, after);
      if (!action) return;
      if (action.kind === 'finish') finishing = true;
      this.report.actions.push({ step: this.step, target: action.name, kind: 'knop', action: 'geklikt', source: cfg?.action ? 'scenario' : 'automatisch' });
      const result = await this.navigate(action.button, after);
      if (result.kind === 'transition') {
        if (cfg?.expect?.errors?.length) {
          for (const e of cfg.expect.errors) this.check('Verwachte validatiefout na navigeren', e, 'scherm ging door zonder melding', false);
          this.stopped = 'failed';
        }
        continue;
      }
      if (result.kind === 'errors') return this.handleErrors(result.scan!.errors, cfg, 'na navigeren');
      if (result.kind === 'fault') return this.issue('fout', 'flowfout', result.scan?.errors.join(' | ') || 'flowfout na navigeren');
      if (result.kind === 'gone') {
        this.report.endState = finishing ? 'afgerond (flowcontainer gesloten)' : 'flowcontainer verdwenen';
        if (!finishing) this.issue('waarschuwing', 'navigatie', 'flowcontainer verdween na navigeren');
        return;
      }
      if (result.kind === 'login') return this.issue('blokkerend', 'sessie', 'sessie verlopen tijdens de uitvoering; flow niet hervat');
      if (result.kind === 'busy') return this.issue('fout', 'navigatie', `flow bleef laden na "${action.name}" (${scenario.timeouts.navigationMs} ms)`);
      return this.issue('blokkerend', 'navigatie', `vastgelopen scherm: geen reactie op "${action.name}" binnen ${scenario.timeouts.navigationMs} ms`);
    }
  }

  private async fillScreen(initial: ScreenScan, cfg: ScreenConfig | undefined) {
    const ctx: FillContext = { scope: this.scope, scenario: this.scenario };
    const handled = new Set<string>();
    const waitedFor = new Set<string>();
    const matchedConfigs = new Set<FieldConfig>();
    let scan: ScreenScan = initial;

    for (let round = 0; round < 200; round++) {
      for (const f of scan.fields) {
        const c = this.fieldConfig(cfg, f);
        if (c) matchedConfigs.add(c);
      }
      const next = scan.fields.find((f) => f.editable && !handled.has(f.key) && !this.waitingForOptions(f));
      if (!next) {
        // Dependent picklists stay disabled or empty until their controlling value has loaded.
        const pending = scan.fields.find((f) => !handled.has(f.key) && !waitedFor.has(f.key) && (f.required || f.kind === 'picklist') &&
          (this.waitingForOptions(f) || (!f.editable && !hasValue(f))));
        if (!pending) break;
        waitedFor.add(pending.key);
        scan = await this.waitForField(pending);
        continue;
      }
      handled.add(next.key);
      await this.fillField(ctx, next, this.fieldConfig(cfg, next));
      if (this.stopped) return;
      scan = await settleScreen(this.scope, this.scenario.timeouts.settleMs);
    }

    for (const c of cfg?.fields ?? []) {
      if (!matchedConfigs.has(c) && !c.optional) {
        this.issue('blokkerend', c.label, `scenario-veld "${c.label}"${c.occurrence ? ` (#${c.occurrence})` : ''} niet gevonden op dit scherm`);
      }
    }
  }

  private async fillField(ctx: FillContext, field: ScannedField, cfg: FieldConfig | undefined) {
    const mask = this.scenario.reporting.maskValues;
    const record = (action: string, value: unknown, source: 'scenario' | 'automatisch' | 'bestaand', note?: string) =>
      this.report.actions.push({ step: this.step, target: field.occurrence > 1 ? `${field.label} (#${field.occurrence})` : field.label, kind: field.kind, action, value: maskValue(value, field.kind, mask), source, note });
    const unresolved = (reason: string, blocking: boolean) =>
      this.issue(blocking ? 'blokkerend' : 'waarschuwing', field.label || '(geen label)', `onopgelost: ${reason}`);

    if (cfg?.skip) return record('overgeslagen', undefined, 'scenario');

    if (cfg?.lookup) {
      const result = await selectLookup(ctx, field, cfg.lookup.search, cfg.lookup.select);
      if (!result.ok) return unresolved(result.reason, true);
      const confirmed = await this.confirmValue(field, (v) => typeof v === 'string' && norm(v).includes(norm(cfg.lookup!.select)));
      if (!confirmed) return unresolved(`lookupselectie "${cfg.lookup.select}" niet bevestigd`, true);
      return record('lookup geselecteerd', cfg.lookup.select, 'scenario', mask ? undefined : `zoekterm "${cfg.lookup.search}"`);
    }

    if (cfg?.value !== undefined) {
      if (textKinds.has(field.kind) && hasValue(field) && !sameValue(field.value, cfg.value)) {
        if (!cfg.overwrite) return unresolved('veld heeft al een waarde; zet "overwrite": true om te overschrijven', true);
      } else if (hasValue(field) && sameValue(field.value, cfg.value)) {
        return record('behouden', field.value, 'bestaand', 'gelijk aan scenario-waarde');
      }
      return this.apply(field, await setFieldValue(ctx, field, cfg.value), 'scenario', record, unresolved);
    }

    if (hasValue(field)) return record('behouden', field.value, 'bestaand');
    const auto = this.scenario.autoFill;
    if (field.kind === 'lookup') {
      return unresolved('lookup zonder "lookup": { "search", "select" } in het scenario; er wordt nooit zomaar een resultaat gekozen', field.required);
    }
    if (field.kind === 'password' || field.kind === 'unknown') {
      return unresolved(`veldtype "${field.kind}" wordt niet automatisch ingevuld`, field.required);
    }
    if (auto === 'none' || (auto === 'required' && !field.required)) {
      if (field.required) unresolved('verplicht veld zonder scenario-waarde (autoFill staat uit)', true);
      return;
    }
    if (field.kind === 'checkbox' || field.kind === 'toggle') {
      if (!field.required) return;
      return this.apply(field, await setFieldValue(ctx, field, true), 'automatisch', record, unresolved);
    }
    const rng = createRng(this.scenario.seed, 'veld', field.label, field.occurrence);
    if (['radio', 'checkboxGroup', 'picklist', 'multiselect'].includes(field.kind)) {
      return this.apply(field, await chooseOption(ctx, field, rng), 'automatisch', record, unresolved);
    }
    const generated = generateValue(field, rng, { ...this.scenario.locale });
    if ('unresolved' in generated) return unresolved(generated.unresolved, field.required);
    return this.apply(field, await setFieldValue(ctx, field, generated.value), 'automatisch', record, unresolved);
  }

  private async apply(
    field: ScannedField,
    result: FillResult,
    source: 'scenario' | 'automatisch',
    record: (action: string, value: unknown, source: 'scenario' | 'automatisch', note?: string) => void,
    unresolved: (reason: string, blocking: boolean) => void,
  ) {
    if (!result.ok) return unresolved(result.reason, source === 'scenario' || field.required);
    if (!textKinds.has(field.kind)) {
      const confirmed = await this.confirmValue(field, (v) => sameValue(v, result.value));
      if (!confirmed) return unresolved(`gekozen waarde "${String(result.value)}" niet bevestigd na herlezen`, true);
    }
    record(field.kind === 'checkbox' || field.kind === 'toggle' ? 'aangevinkt' : textKinds.has(field.kind) ? 'ingevuld' : 'gekozen', result.value, source, result.note);
  }

  /** Re-reads the screen; a field that disappeared after the action is fine (conditional screens). */
  private async confirmValue(field: ScannedField, ok: (value: ScannedField['value']) => boolean): Promise<boolean> {
    const scan = await settleScreen(this.scope, this.scenario.timeouts.settleMs);
    const now = scan.fields.find((f) => f.label === field.label && f.occurrence === field.occurrence);
    return !now || ok(now.value);
  }

  private waitingForOptions(f: ScannedField) {
    return f.kind === 'picklist' && f.variant === 'select' && !(f.options ?? []).some((o) => !isPlaceholderOption(o));
  }

  private async waitForField(field: ScannedField): Promise<ScreenScan> {
    const deadline = Date.now() + this.scenario.timeouts.actionMs;
    let scan = await scanScreen(this.scope);
    while (Date.now() < deadline) {
      const now = scan.fields.find((f) => f.key === field.key);
      if (!now || (now.editable && !this.waitingForOptions(now))) return settleScreen(this.scope, this.scenario.timeouts.settleMs);
      await this.page.waitForTimeout(250);
      scan = await scanScreen(this.scope);
    }
    if (field.required) this.issue('waarschuwing', field.label, 'verplicht veld bleef uitgeschakeld of zonder opties');
    return scan;
  }

  private async handleUploads(cfg: ScreenConfig | undefined) {
    const scan = await settleScreen(this.scope, this.scenario.timeouts.settleMs);
    const matched = new Set<UploadConfig>();
    for (const upload of scan.uploads) {
      const ucfg = cfg?.uploads?.find((u) => norm(u.label) === norm(upload.label) && (u.occurrence ?? 1) === upload.occurrence);
      if (ucfg) matched.add(ucfg);
      const record = (outcome: 'geblokkeerd' | 'overgeslagen', message: string) =>
        this.report.uploads.push({ step: this.step, label: upload.label, outcome, message, expected: ucfg?.expect });

      if (this.performedUploads.has(upload.key)) {
        record('overgeslagen', 'in deze uitvoering al geüpload; niet herhaald');
        continue;
      }
      if (ucfg?.skip) {
        record('overgeslagen', 'scenario: skip');
        continue;
      }
      if (!ucfg) {
        if (this.scenario.autoFill !== 'all') {
          record('overgeslagen', 'geen scenario-instelling en autoFill is niet "all"');
          continue;
        }
        if (upload.existingFiles.length) {
          record('overgeslagen', `component bevat al bestanden: ${upload.existingFiles.join(', ')}`);
          continue;
        }
      }
      if (upload.disabled) {
        record('geblokkeerd', 'uploadcomponent is uitgeschakeld');
        this.issue('blokkerend', upload.label, 'uploadcomponent is uitgeschakeld');
        continue;
      }
      const attempt = await uploadFiles(this.scope, this.frameRoot, upload, this.scenario, (constraints) =>
        selectDocuments(this.scenario.documentsDirectory, ucfg, constraints, this.scenario.seed, upload.key));
      if (!attempt.files.length) {
        record('geblokkeerd', attempt.message ?? 'upload niet uitgevoerd');
        this.issue('blokkerend', upload.label, `upload geblokkeerd: ${attempt.message}`);
        continue;
      }
      this.log(`Upload "${upload.label}": ${attempt.files.map((f) => f.name).join(', ')} — ${attempt.outcome}`);
      this.performedUploads.add(upload.key);
      for (const file of attempt.files) {
        this.report.uploads.push({
          step: this.step, label: upload.label, file: file.name, sizeBytes: file.size,
          outcome: attempt.outcome, message: [attempt.message, ...attempt.notes].filter(Boolean).join(' | '), expected: ucfg?.expect,
        });
      }
      this.report.actions.push({
        step: this.step, target: upload.label, kind: 'upload', action: `upload: ${attempt.outcome}`,
        value: attempt.files.map((f) => f.name), source: ucfg ? 'scenario' : 'automatisch',
      });

      const expect = ucfg?.expect ?? 'success';
      if (attempt.outcome === 'onzeker' || attempt.outcome === 'geblokkeerd') {
        this.issue('blokkerend', upload.label, `upload ${attempt.outcome}: ${attempt.message}`);
      } else if (expect === 'error') {
        const matchesText = !ucfg?.expectedError || norm(attempt.message ?? '').includes(norm(ucfg.expectedError));
        this.check(`Uploadfout verwacht voor "${upload.label}"`, ucfg?.expectedError ?? 'een uploadfout', `${attempt.outcome}: ${attempt.message ?? ''}`, attempt.outcome === 'fout' && matchesText);
      } else if (attempt.outcome === 'fout') {
        this.issue('fout', upload.label, `uploadfout: ${attempt.message}`);
      } else if (ucfg?.expect) {
        this.check(`Upload geslaagd voor "${upload.label}"`, 'geüpload', attempt.outcome, true);
      }
    }
    for (const u of cfg?.uploads ?? []) {
      if (!matched.has(u)) this.issue('blokkerend', u.label, `uploadcomponent "${u.label}" uit het scenario niet gevonden op dit scherm`);
    }
  }

  private async chooseAction(cfg: ScreenConfig | undefined, scan: ScreenScan): Promise<{ kind: string; name: string; button: Locator } | undefined> {
    const nav = this.scenario.navigation;
    const find = async (names: string[]) => {
      for (const name of names) {
        const button = this.scope.getByRole('button', { name, exact: true }).visible();
        if ((await button.count()) === 1 && (await button.isEnabled())) return { name, button };
      }
      return undefined;
    };
    if (cfg?.action === 'stop') {
      this.report.endState = 'gestopt volgens scenario';
      return undefined;
    }
    const next = await find(nav.next);
    const finish = await find(nav.finish);
    const previous = await find(nav.previous);
    const wanted = cfg?.action ?? (next ? 'next' : finish ? 'finish' : undefined);

    if (wanted === 'finish') {
      if (!finish) return void this.issue('blokkerend', 'navigatie', `Finish-knop (${nav.finish.join('/')}) niet gevonden`);
      if (!this.scenario.allowFinish) {
        this.report.endState = 'gestopt vóór Finish (allowFinish is false)';
        this.log('Finish niet aangeklikt: allowFinish staat uit.');
        return undefined;
      }
      return { kind: 'finish', ...finish };
    }
    if (wanted === 'next') {
      if (!next) return void this.issue('blokkerend', 'navigatie', `Volgende-knop (${nav.next.join('/')}) niet gevonden`);
      return { kind: 'next', ...next };
    }
    if (wanted === 'previous') {
      if (!previous) return void this.issue('blokkerend', 'navigatie', `Vorige-knop (${nav.previous.join('/')}) niet gevonden`);
      return { kind: 'previous', ...previous };
    }
    this.report.endState = scan.buttons.length
      ? `geen navigatieknop herkend (knoppen: ${scan.buttons.join(', ')})`
      : 'geen navigatieknoppen; flow lijkt afgerond';
    return undefined;
  }

  private async navigate(button: Locator, before: ScreenScan): Promise<{ kind: NavResult; scan?: ScreenScan }> {
    const marker = await this.scope.evaluateHandle((root) => {
      const find = (node: Element | ShadowRoot): Element | null => {
        for (const child of Array.from(node.children)) {
          if (child.matches('input, select, textarea, h1, h2, h3, h4, h5, h6, button')) return child;
          const inner = (child.shadowRoot && find(child.shadowRoot)) || find(child);
          if (inner) return inner;
        }
        return null;
      };
      return find(root) ?? root;
    });
    try {
      await button.click({ timeout: this.scenario.timeouts.actionMs });
      return await this.waitForTransition(marker, before);
    } finally {
      await marker.dispose().catch(() => undefined);
    }
  }

  private async waitForTransition(marker: JSHandle, before: ScreenScan): Promise<{ kind: NavResult; scan?: ScreenScan }> {
    const deadline = Date.now() + this.scenario.timeouts.navigationMs;
    let busy = false;
    while (Date.now() < deadline) {
      await this.page.waitForTimeout(250);
      if (await isLoginPage(this.page)) return { kind: 'login' };
      if (!(await this.scope.count())) return { kind: 'gone' };
      const scan = await scanScreen(this.scope).catch(() => undefined);
      if (!scan) return { kind: 'gone' };
      if (this.isFault(scan)) return { kind: 'fault', scan };
      busy = scan.busy;
      if (busy) continue;
      const detached = await marker.evaluate((n) => !n.isConnected).catch(() => true);
      const newErrors = scan.errors.length > 0 && JSON.stringify(scan.errors) !== JSON.stringify(before.errors);
      if (!detached && scan.structure === before.structure && !newErrors) continue;
      const settled = await settleScreen(this.scope, this.scenario.timeouts.settleMs);
      if (this.isFault(settled)) return { kind: 'fault', scan: settled };
      if (settled.structure === before.structure && settled.errors.length) return { kind: 'errors', scan: settled };
      return { kind: 'transition', scan: settled };
    }
    return { kind: busy ? 'busy' : 'nochange' };
  }

  private handleErrors(errors: string[], cfg: ScreenConfig | undefined, moment: string) {
    const outcome = this.scenario.expectedOutcome;
    const expected = [...(cfg?.expect?.errors ?? []), ...(outcome?.type === 'validationError' ? outcome.errors ?? [] : [])];
    this.report.endState = `validatiefout ${moment}`;
    if (!expected.length) {
      this.issue('fout', 'validatie', `onverwachte validatiefout(en) ${moment}: ${errors.join(' | ')}`);
      return;
    }
    for (const e of expected) {
      this.check(`Verwachte validatiefout (${moment})`, e, errors.join(' | '), errors.some((a) => norm(a).includes(norm(e))));
    }
    if (outcome?.type === 'validationError') this.outcomeDone = true;
  }

  private async evaluateOutcome() {
    const outcome = this.scenario.expectedOutcome;
    if (!outcome || this.outcomeDone) return;
    if (outcome.type === 'validationError') {
      this.check('Einduitkomst: validatiefout', (outcome.errors ?? []).join(' | '), `geen validatiefout; eindtoestand: ${this.report.endState ?? 'onbekend'}`, false);
      return;
    }
    if (outcome.type === 'screen') {
      this.check('Einduitkomst: doelscherm bereikt', (outcome.texts ?? []).join(' | '), `niet bereikt; eindtoestand: ${this.report.endState ?? 'onbekend'}`, false);
      return;
    }
    if (!this.report.endState?.startsWith('afgerond')) {
      if (!this.scenario.allowFinish) {
        this.issue('blokkerend', 'einduitkomst', 'expectedOutcome "finished" vereist "allowFinish": true');
      } else {
        this.check('Einduitkomst: flow afgerond', 'afgerond', this.report.endState ?? 'onbekend', false);
      }
      return;
    }
    for (const text of outcome.texts ?? []) await this.checkText(text, 'Einduitkomst: tekst na afronden', this.frameRoot);
  }

  private async reachedTargetScreen(): Promise<boolean> {
    const outcome = this.scenario.expectedOutcome;
    if (outcome?.type !== 'screen') return false;
    for (const text of outcome.texts ?? []) {
      if (!(await this.scope.getByText(text).visible().count())) return false;
    }
    for (const text of outcome.texts ?? []) this.check('Einduitkomst: doelscherm bereikt', text, 'gevonden', true);
    this.outcomeDone = true;
    this.report.endState = 'doelscherm bereikt';
    return true;
  }

  private async checkText(text: string, description: string, root: Locator = this.scope) {
    const found = (await root.getByText(text).visible().count()) > 0;
    this.check(description, text, found ? 'gevonden' : 'niet gevonden', found);
  }

  private check(description: string, expected: string, actual: string, passed: boolean) {
    this.report.checks.push({ step: this.step || undefined, description, expected, actual, passed });
    if (!passed) this.log(`Controle NIET OK: ${description}: verwacht "${expected}", werkelijk "${actual}"`);
  }

  private issue(severity: Issue['severity'], subject: string, message: string) {
    this.report.issues.push({ step: this.step || undefined, severity, subject, message });
    this.log(`${severity.toUpperCase()}: ${subject}: ${message}`);
    if (severity === 'fout' && this.opts.mode === 'run') this.stopped = 'failed';
    if (severity === 'blokkerend' && this.opts.mode === 'run' && this.isStopping(subject)) this.stopped = 'blocked';
  }

  // Field-level blockers are collected for the whole screen first; structural ones stop at once.
  private isStopping(subject: string) {
    return ['org', 'flowcontainer', 'schermstappen', 'navigatie', 'sessie', 'einduitkomst'].includes(subject);
  }

  private isFault(scan: ScreenScan) {
    const patterns = this.scenario.faultPatterns.map((p) => new RegExp(p, 'i'));
    return patterns.some((re) => re.test(scan.text) || scan.errors.some((e) => re.test(e)));
  }

  private matchScreen(scan: ScreenScan): { screen: ScreenConfig; index: number } | undefined {
    const headings = scan.headings.map(norm);
    const body = norm(scan.text);
    // Exact heading first, so "Aanvraag" does not claim a screen that merely mentions "uw aanvraag".
    const tests: Array<(text: string) => boolean> = [
      (t) => headings.includes(t),
      (t) => headings.some((h) => h.includes(t)),
      (t) => body.includes(t),
    ];
    for (const test of [(s: ScreenConfig) => s.match?.step === this.step, ...tests.map((t) => (s: ScreenConfig) =>
      s.match?.step === undefined && !!s.match?.text && t(norm(s.match.text)))]) {
      const index = this.scenario.screens.findIndex(test);
      if (index >= 0) return { screen: this.scenario.screens[index], index: index + 1 };
    }
    return undefined;
  }

  private fieldConfig(cfg: ScreenConfig | undefined, field: ScannedField) {
    return cfg?.fields?.find((c) => norm(c.label) === norm(field.label) && (c.occurrence ?? 1) === field.occurrence);
  }

  private async recordScreen(scan: ScreenScan, matched?: number) {
    const record = screenRecord(this.step, this.page.url(), scan, this.scenario.reporting.maskValues);
    record.matchedScreen = matched;
    const file = path.join('screenshots', `stap-${String(this.step).padStart(2, '0')}.png`);
    const dir = this.report.artifacts.directory;
    await mkdir(path.join(dir, 'screenshots'), { recursive: true });
    try {
      await this.page.screenshot({ path: path.join(dir, file), fullPage: true });
      record.screenshot = file.split(path.sep).join('/');
      this.report.artifacts.screenshots.push(record.screenshot);
    } catch (error) {
      this.issue('waarschuwing', 'screenshot', (error as Error).message);
    }
    this.report.screens.push(record);
  }

  private async findContainer(): Promise<{ scope: Locator; frameRoot: Locator } | string> {
    const { selector, frame } = this.scenario.flowContainer;
    const deadline = Date.now() + this.scenario.timeouts.navigationMs;
    while (Date.now() < deadline) {
      if (frame) {
        const fl = this.page.frameLocator(frame);
        const scope = fl.locator(selector);
        if ((await scope.count()) === 1) return { scope, frameRoot: fl.locator(':root') };
      } else {
        const found: Array<{ scope: Locator; frameRoot: Locator }> = [];
        for (const f of this.page.frames()) {
          const scope = f.locator(selector);
          const n = await scope.count().catch(() => 0);
          if (n > 1) return `${n} flowcontainers "${selector}" gevonden; maak flowContainer.selector specifieker`;
          if (n === 1) found.push({ scope, frameRoot: f.locator(':root') });
        }
        if (found.length > 1) return `flowcontainer "${selector}" in meerdere frames gevonden; stel flowContainer.frame in`;
        if (found.length === 1) return found[0];
      }
      await this.page.waitForTimeout(500);
    }
    return `flowcontainer "${selector}" niet gevonden binnen ${this.scenario.timeouts.navigationMs} ms`;
  }

  decideStatus() {
    const r = this.report;
    if (r.mode === 'inspect') {
      r.status = 'inventarisatie';
      r.statusReason = 'alleen geïnventariseerd; niets gewijzigd, geüpload of aangeklikt';
      return;
    }
    const failedChecks = r.checks.filter((c) => !c.passed);
    const errors = r.issues.filter((i) => i.severity === 'fout');
    const blockers = r.issues.filter((i) => i.severity === 'blokkerend');
    if (failedChecks.length || errors.length) {
      r.status = 'mislukt';
      r.statusReason = [...failedChecks.map((c) => `${c.description}: ${c.expected}`), ...errors.map((e) => e.message)].join('; ');
    } else if (blockers.length) {
      r.status = 'geblokkeerd';
      r.statusReason = blockers.map((b) => `${b.subject}: ${b.message}`).join('; ');
    } else if (!r.checks.length) {
      r.status = 'geen_eindcontrole';
      r.statusReason = `uitvoering afgerond (${r.endState ?? 'onbekend'}), maar er zijn geen controles ingesteld`;
    } else {
      r.status = 'geslaagd';
      r.statusReason = `${r.checks.length} controle(s) gehaald${this.scenario.expectedOutcome ? '' : '; let op: geen expectedOutcome ingesteld'}`;
    }
  }
}

function hasValue(field: ScannedField): boolean {
  const v = field.value;
  if (v === null || v === undefined || v === false) return false;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === 'string') return !!v.trim() && !(field.kind === 'picklist' && isPlaceholderOption(v));
  return true;
}

function sameValue(actual: ScannedField['value'], wanted: unknown): boolean {
  if (Array.isArray(wanted)) {
    const a = Array.isArray(actual) ? actual : [actual];
    return a.length === wanted.length && wanted.every((w) => a.some((x) => norm(String(x)) === norm(String(w))));
  }
  if (typeof wanted === 'boolean' || wanted === 'true' || wanted === 'false') return String(actual) === String(wanted);
  return norm(String(actual ?? '')) === norm(String(wanted));
}
