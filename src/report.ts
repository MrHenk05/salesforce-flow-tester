import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Scenario } from './config.js';
import type { ComponentInfo, FieldKind, ScannedField, ScannedUpload } from './scan.js';
import type { UploadOutcome } from './upload.js';

export type Status = 'geslaagd' | 'mislukt' | 'geblokkeerd' | 'geen_eindcontrole' | 'inventarisatie';

export interface ScreenRecord {
  step: number;
  url: string;
  headings: string[];
  matchedScreen?: number;
  fields: Array<Omit<ScannedField, 'locate'>>;
  uploads: Array<Omit<ScannedUpload, 'regionText'>>;
  errors: string[];
  buttons: string[];
  components: ComponentInfo[];
  inaccessible: string[];
  text?: string;
  screenshot?: string;
}

export interface ActionRecord {
  step: number;
  target: string;
  kind: string;
  action: string;
  value?: unknown;
  source: 'scenario' | 'automatisch' | 'bestaand';
  note?: string;
}

export interface UploadRecord {
  step: number;
  label: string;
  file?: string;
  sizeBytes?: number;
  outcome: UploadOutcome;
  message?: string;
  expected?: 'success' | 'error';
}

export interface CheckRecord {
  step?: number;
  description: string;
  expected: string;
  actual: string;
  passed: boolean;
}

export interface Issue {
  step?: number;
  severity: 'fout' | 'blokkerend' | 'waarschuwing';
  subject: string;
  message: string;
}

export interface RunReport {
  tool: 'salesforce-flow-tester';
  scenario: { name: string; file?: string; seed: number };
  mode: 'inspect' | 'run';
  startedAt: string;
  finishedAt?: string;
  startUrl: string;
  status: Status;
  statusReason: string;
  endState?: string;
  screens: ScreenRecord[];
  actions: ActionRecord[];
  uploads: UploadRecord[];
  checks: CheckRecord[];
  issues: Issue[];
  artifacts: { directory: string; trace?: string; screenshots: string[] };
  privacyNote: string;
}

const privacyNote =
  'Waarden in dit rapport zijn gemaskeerd waar ingesteld, maar screenshots en de Playwright-trace bevatten het ' +
  'werkelijke scherm en kunnen persoonsgegevens bevatten. Deel ze alleen met mensen die deze gegevens mogen zien.';

export function createReport(scenario: Scenario, mode: 'inspect' | 'run', startUrl: string, directory: string): RunReport {
  return {
    tool: 'salesforce-flow-tester',
    scenario: { name: scenario.name, file: scenario.file, seed: scenario.seed },
    mode,
    startedAt: new Date().toISOString(),
    startUrl,
    status: mode === 'inspect' ? 'inventarisatie' : 'geen_eindcontrole',
    statusReason: '',
    screens: [],
    actions: [],
    uploads: [],
    checks: [],
    issues: [],
    artifacts: { directory, screenshots: [] },
    privacyNote,
  };
}

export function namespaceOwner(namespace: string, scenario: Scenario): string {
  const known = scenario.knownNamespaces[namespace];
  if (known) return `${known.owner}${known.package ? `, package ${known.package}` : ''}${known.source ? ` (bron: ${known.source})` : ''}`;
  if (namespace === 'c') return 'namespace "c": component zonder namespace (eigen ontwikkeling of unmanaged package), geen managed package';
  return 'eigenaar/package niet verifieerbaar vanuit de pagina; controleer Setup > Installed Packages en vul knownNamespaces aan';
}

const visibleKinds = new Set<FieldKind>(['checkbox', 'toggle', 'radio', 'checkboxGroup', 'picklist', 'multiselect']);

/** Free text may contain personal data; option labels and booleans come from the flow definition. */
export function maskValue(value: unknown, kind: FieldKind | string, mask: boolean): unknown {
  if (!mask || value === null || value === undefined || typeof value === 'boolean') return value;
  if (visibleKinds.has(kind as FieldKind)) return value;
  if (Array.isArray(value)) return value.map((v) => maskValue(v, kind, mask));
  const text = String(value);
  return text ? `•••• (${text.length} tekens)` : '';
}

export function screenRecord(step: number, url: string, scan: import('./scan.js').ScreenScan, mask: boolean): ScreenRecord {
  return {
    step,
    url: url.split('?')[0],
    headings: scan.headings,
    fields: scan.fields.map(({ locate, ...f }) => ({ ...f, value: maskValue(f.value, f.kind, mask) as ScannedField['value'] })),
    uploads: scan.uploads.map(({ regionText, ...u }) => u),
    errors: scan.errors,
    buttons: scan.buttons,
    components: scan.components,
    inaccessible: scan.inaccessible,
    text: mask ? undefined : scan.text,
  };
}

export async function writeReport(report: RunReport, scenario: Scenario): Promise<{ json: string; html: string }> {
  const dir = report.artifacts.directory;
  await mkdir(dir, { recursive: true });
  const json = path.join(dir, 'report.json');
  const html = path.join(dir, 'report.html');
  await writeFile(json, JSON.stringify(report, null, 2));
  await writeFile(html, renderHtml(report, scenario));
  return { json, html };
}

const esc = (value: unknown) =>
  String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const show = (value: unknown) => (Array.isArray(value) ? value.join(', ') : typeof value === 'boolean' ? (value ? 'ja' : 'nee') : String(value ?? ''));

const statusLabels: Record<Status, string> = {
  geslaagd: 'Geslaagd',
  mislukt: 'Mislukt',
  geblokkeerd: 'Geblokkeerd',
  geen_eindcontrole: 'Geen eindcontrole',
  inventarisatie: 'Inventarisatie (inspect)',
};

function table(headers: string[], rows: unknown[][]): string {
  if (!rows.length) return '<p class="muted">Geen.</p>';
  return `<table><thead><tr>${headers.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows
    .map((r) => `<tr>${r.map((c) => `<td>${esc(show(c))}</td>`).join('')}</tr>`)
    .join('')}</tbody></table>`;
}

function renderHtml(r: RunReport, scenario: Scenario): string {
  const screens = r.screens
    .map((s) => {
      const fields = table(
        ['Label', 'Type', 'Verplicht', 'Bewerkbaar', 'Waarde', 'Opties', 'Fouten', 'Opmerking'],
        s.fields.map((f) => [
          f.label || '(geen label)', f.kind, f.required, f.editable, f.value, f.options ?? f.optionsNote ?? '', f.errors,
          [f.labelSource !== 'label' && f.labelSource !== 'aria-labelledby' ? `label via ${f.labelSource}` : '', f.hint ?? ''].filter(Boolean).join('; '),
        ]),
      );
      const uploads = table(
        ['Label', 'Via', 'Toegestane types', 'Meerdere', 'Max. grootte', 'Max. aantal', 'Aanwezige bestanden'],
        s.uploads.map((u) => [u.label, u.via, u.accept ?? 'niet zichtbaar', u.multiple ?? 'onbekend', u.maxBytes ?? 'niet zichtbaar', u.maxFiles ?? 'niet zichtbaar', u.existingFiles]),
      );
      const components = table(
        ['Namespace', 'Componenten', 'Eigenaar / package', 'Ontoegankelijk'],
        s.components.map((c) => [c.namespace, c.tags, namespaceOwner(c.namespace, scenario), c.inaccessible]),
      );
      return `<section class="screen"><h3>Stap ${s.step}: ${esc(s.headings[0] ?? '(geen kop)')}</h3>
<p class="muted">${esc(s.url)}${s.matchedScreen ? ` · scenario-scherm ${s.matchedScreen}` : ''}</p>
${s.screenshot ? `<a href="${esc(s.screenshot)}"><img src="${esc(s.screenshot)}" alt="Screenshot stap ${s.step}"></a>` : ''}
<h4>Velden</h4>${fields}<h4>Uploadcomponenten</h4>${uploads}
${s.errors.length ? `<h4>Meldingen op scherm</h4><ul>${s.errors.map((e) => `<li>${esc(e)}</li>`).join('')}</ul>` : ''}
${s.inaccessible.length ? `<h4>Ontoegankelijk of niet herkend</h4><ul>${s.inaccessible.map((e) => `<li>${esc(e)}</li>`).join('')}</ul>` : ''}
${s.components.length ? `<h4>Niet-standaard componenten</h4>${components}` : ''}</section>`;
    })
    .join('\n');

  return `<!doctype html>
<html lang="nl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Flowtest: ${esc(r.scenario.name)}</title>
<style>
body{font:14px/1.45 system-ui,Segoe UI,sans-serif;margin:24px;color:#1b1b1b;background:#fff}
h1{font-size:22px;margin:0 0 4px}h2{margin-top:32px;border-bottom:1px solid #ddd;padding-bottom:4px}h3{margin:0 0 4px}
table{border-collapse:collapse;width:100%;margin:6px 0 14px}th,td{border:1px solid #ddd;padding:4px 8px;text-align:left;vertical-align:top}
th{background:#f4f4f4}.muted{color:#666}.screen{border:1px solid #ddd;border-radius:6px;padding:12px;margin:12px 0}
.screen img{max-width:420px;border:1px solid #ccc;display:block;margin:8px 0}
.status{display:inline-block;padding:4px 12px;border-radius:12px;font-weight:600;color:#fff}
.geslaagd{background:#2e7d32}.mislukt{background:#c62828}.geblokkeerd{background:#ef6c00}.geen_eindcontrole,.inventarisatie{background:#546e7a}
.ok{color:#2e7d32;font-weight:600}.nok{color:#c62828;font-weight:600}.note{background:#fff8e1;border:1px solid #ffe082;padding:8px 12px;border-radius:4px}
</style></head><body>
<h1>${esc(r.scenario.name)}</h1>
<p><span class="status ${r.status}">${esc(statusLabels[r.status])}</span> ${esc(r.statusReason)}</p>
<p class="muted">Modus: ${esc(r.mode)} · seed ${esc(r.scenario.seed)} · start ${esc(r.startedAt)} · einde ${esc(r.finishedAt)}${r.endState ? ` · eindtoestand: ${esc(r.endState)}` : ''}</p>
<p class="muted">Start-URL: ${esc(r.startUrl)}</p>
<p class="note">${esc(r.privacyNote)}${r.artifacts.trace ? ` Trace: <code>${esc(path.basename(r.artifacts.trace))}</code> (open met <code>npx playwright show-trace</code>).` : ''}</p>
<h2>Controles</h2>
${r.checks.length
    ? `<table><thead><tr><th>Stap</th><th>Controle</th><th>Verwacht</th><th>Werkelijk</th><th>Resultaat</th></tr></thead><tbody>${r.checks
        .map((c) => `<tr><td>${esc(c.step ?? '')}</td><td>${esc(c.description)}</td><td>${esc(c.expected)}</td><td>${esc(c.actual)}</td><td class="${c.passed ? 'ok' : 'nok'}">${c.passed ? 'OK' : 'NIET OK'}</td></tr>`)
        .join('')}</tbody></table>`
    : '<p class="muted">Geen expliciete controles uitgevoerd.</p>'}
<h2>Fouten, blokkades en waarschuwingen</h2>
${table(['Stap', 'Ernst', 'Onderwerp', 'Melding'], r.issues.map((i) => [i.step ?? '', i.severity, i.subject, i.message]))}
<h2>Documentuploads</h2>
${table(['Stap', 'Uploadveld', 'Bestand', 'Grootte (bytes)', 'Uitkomst', 'Verwacht', 'Melding'], r.uploads.map((u) => [u.step, u.label, u.file ?? '', u.sizeBytes ?? '', u.outcome, u.expected ?? '', u.message ?? '']))}
<h2>Uitgevoerde acties</h2>
${table(['Stap', 'Veld / knop', 'Type', 'Actie', 'Waarde', 'Bron', 'Opmerking'], r.actions.map((a) => [a.step, a.target, a.kind, a.action, a.value ?? '', a.source, a.note ?? '']))}
<h2>Herkende schermen</h2>
${screens || '<p class="muted">Geen schermen herkend.</p>'}
</body></html>
`;
}
