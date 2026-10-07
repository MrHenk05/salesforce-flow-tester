import type { Locator } from 'playwright';
import type { FieldValue, Scenario } from './config.js';
import { labelPattern, locateField, type ScannedField } from './scan.js';
import { formatDate, formatTime, isPlaceholderOption, pick, type Rng } from './values.js';

export type FillResult = { ok: true; value: FieldValue; note?: string } | { ok: false; reason: string };

export interface FillContext {
  scope: Locator;
  scenario: Scenario;
}

const isoDate = /^\d{4}-\d{2}-\d{2}$/;
const isoTime = /^\d{2}:\d{2}$/;

export async function setFieldValue(ctx: FillContext, field: ScannedField, value: FieldValue): Promise<FillResult> {
  const located = await locateField(ctx.scope, field);
  if (typeof located === 'string') return { ok: false, reason: located };
  const loc = located;
  const timeout = ctx.scenario.timeouts.actionMs;

  switch (field.kind) {
    case 'checkbox':
    case 'toggle': {
      const wanted = value === true || value === 'true';
      if (typeof value !== 'boolean' && value !== 'true' && value !== 'false') {
        return { ok: false, reason: `checkbox verwacht true of false, kreeg ${JSON.stringify(value)}` };
      }
      return (await setChecked(loc, wanted, field.locate.name, ctx.scope, timeout)) ? { ok: true, value: wanted } : { ok: false, reason: 'vinkje niet bevestigd na klikken' };
    }
    case 'radio': {
      const option = String(value);
      const unknown = unknownOptions(field, [option]);
      if (unknown) return unknown;
      const radio = loc.getByRole('radio', { name: labelPattern(option) });
      if ((await radio.count()) !== 1) return { ok: false, reason: `radioknop "${option}" niet eenduidig te vinden` };
      return (await setChecked(radio, true, option, loc, timeout)) ? { ok: true, value: option } : { ok: false, reason: `keuze "${option}" niet bevestigd` };
    }
    case 'checkboxGroup': {
      const wanted = Array.isArray(value) ? value : [String(value)];
      const unknown = unknownOptions(field, wanted);
      if (unknown) return unknown;
      for (const option of field.options ?? []) {
        const box = loc.getByRole('checkbox', { name: labelPattern(option) });
        if ((await box.count()) !== 1) return { ok: false, reason: `checkbox "${option}" niet eenduidig te vinden` };
        if (!(await setChecked(box, wanted.includes(option), option, loc, timeout))) return { ok: false, reason: `checkbox "${option}" niet bevestigd` };
      }
      return { ok: true, value: wanted };
    }
    case 'picklist':
    case 'multiselect':
      return selectOptions(ctx, field, loc, Array.isArray(value) ? value : [String(value)]);
    case 'lookup':
      return { ok: false, reason: 'lookup vereist "lookup": { "search", "select" } in het scenario' };
    case 'password':
    case 'unknown':
      return { ok: false, reason: `veldtype "${field.kind}" wordt niet automatisch ingevuld` };
  }

  let text = String(value);
  if (field.kind === 'date' && field.variant === 'text' && isoDate.test(text)) {
    if (!ctx.scenario.locale.dateFormat) return { ok: false, reason: 'ISO-datum kan niet worden omgezet: stel locale.dateFormat in' };
    text = formatDate(text, ctx.scenario.locale.dateFormat);
  }
  if (field.kind === 'time' && field.variant === 'text' && isoTime.test(text)) {
    if (!ctx.scenario.locale.timeFormat) return { ok: false, reason: 'tijd kan niet worden omgezet: stel locale.timeFormat in' };
    text = formatTime(text, ctx.scenario.locale.timeFormat);
  }
  await loc.fill(text, { timeout });
  await loc.blur({ timeout }).catch(() => undefined);
  const actual = field.kind === 'richtext' ? await loc.innerText() : await loc.inputValue().catch(() => text);
  const note = actual.replace(/\s/g, '') === text.replace(/\s/g, '') ? undefined : 'veld heeft de invoer opnieuw opgemaakt';
  return { ok: true, value: text, note };
}

/** Picks a seeded option for a choice field that has no scenario value. */
export async function chooseOption(ctx: FillContext, field: ScannedField, rng: Rng): Promise<FillResult> {
  if (field.kind === 'picklist' && field.variant === 'combobox') {
    const located = await locateField(ctx.scope, field);
    if (typeof located === 'string') return { ok: false, reason: located };
    const options = await openCombobox(ctx, located);
    if (typeof options === 'string') return { ok: false, reason: options };
    const choices = options.filter((o) => !isPlaceholderOption(o));
    if (!choices.length) {
      await located.press('Escape').catch(() => undefined);
      return { ok: false, reason: 'picklist heeft geen keuzemogelijkheden' };
    }
    return clickOption(ctx, located, pick(rng, choices));
  }
  const choices = (field.options ?? []).filter((o) => !isPlaceholderOption(o));
  if (!choices.length) return { ok: false, reason: field.optionsNote ?? 'geen keuzemogelijkheden gevonden' };
  const choice = pick(rng, choices);
  return setFieldValue(ctx, field, field.kind === 'checkboxGroup' || field.kind === 'multiselect' ? [choice] : choice);
}

export async function selectLookup(ctx: FillContext, field: ScannedField, search: string, select: string): Promise<FillResult> {
  const located = await locateField(ctx.scope, field);
  if (typeof located === 'string') return { ok: false, reason: located };
  const timeout = ctx.scenario.timeouts.actionMs;
  await located.fill('', { timeout });
  await located.pressSequentially(search, { delay: 40, timeout });

  const options = await optionsOf(ctx, located);
  const names = await stableTexts(options, timeout, (texts) => texts.length > 0 && !texts.some((t) => /^(searching|zoeken|loading|laden)/i.test(t)));
  if (!names.length) {
    await located.fill('').catch(() => undefined);
    return { ok: false, reason: `geen zoekresultaten voor "${search}"` };
  }
  const wanted = select.trim().toLowerCase();
  const rows = names.map((n, i) => ({ i, lines: n.split('\n').map((l) => l.trim().toLowerCase()).filter(Boolean) }))
    .filter((r) => !/^\+?\s*(new|nieuw)\b|^(show|toon) (all|more|alle|meer)/.test(r.lines[0] ?? ''));
  let matches = rows.filter((r) => r.lines[0] === wanted);
  if (!matches.length) matches = rows.filter((r) => r.lines.join(' ').includes(wanted));
  if (matches.length !== 1) {
    await located.press('Escape').catch(() => undefined);
    await located.fill('').catch(() => undefined);
    // Result names can be people (person accounts); only show them when values are not masked.
    const shown = ctx.scenario.reporting.maskValues ? `${names.length} resultaten` : names.map((n) => n.split('\n')[0]).join(', ');
    return {
      ok: false,
      reason: matches.length
        ? `${matches.length} resultaten passen bij "${select}" (${shown}); maak "select" specifieker`
        : `geen resultaat "${select}" voor zoekterm "${search}" (gevonden: ${shown})`,
    };
  }
  await options.nth(matches[0].i).click({ timeout });
  return { ok: true, value: select };
}

async function setChecked(loc: Locator, checked: boolean, label: string, container: Locator, timeout: number): Promise<boolean> {
  if ((await loc.isChecked()) === checked) return true;
  const box = await loc.boundingBox();
  if (box && box.width > 2 && box.height > 2) {
    await loc.setChecked(checked, { timeout: Math.min(timeout, 3000) }).catch(() => undefined);
  } else {
    // SLDS hides the native input; a user clicks the visible label instead.
    const text = container.getByText(labelPattern(label)).visible();
    if ((await text.count()) === 1) await text.click({ timeout });
  }
  if ((await loc.isChecked()) !== checked) await loc.dispatchEvent('click');
  return (await loc.isChecked()) === checked;
}

function unknownOptions(field: ScannedField, values: string[]): FillResult | undefined {
  if (!field.options) return undefined;
  const missing = values.filter((v) => !field.options!.some((o) => o.toLowerCase() === v.toLowerCase()));
  if (!missing.length) return undefined;
  return { ok: false, reason: `optie(s) ${missing.map((m) => `"${m}"`).join(', ')} bestaan niet; beschikbaar: ${field.options.join(', ')}` };
}

async function selectOptions(ctx: FillContext, field: ScannedField, loc: Locator, values: string[]): Promise<FillResult> {
  const timeout = ctx.scenario.timeouts.actionMs;
  if (field.variant === 'select') {
    const unknown = unknownOptions(field, values);
    if (unknown) return unknown;
    const labels = values.map((v) => field.options!.find((o) => o.toLowerCase() === v.toLowerCase())!);
    await loc.selectOption(labels.map((label) => ({ label })), { timeout });
    return { ok: true, value: field.kind === 'multiselect' ? labels : labels[0] };
  }
  if (field.variant === 'dualListbox') {
    const unknown = unknownOptions(field, values);
    if (unknown) return unknown;
    const move = await firstUnique(loc, ctx.scenario.dualListboxMoveButtons);
    if (!move) return { ok: false, reason: `verplaatsknop niet gevonden; stel dualListboxMoveButtons in (gezocht: ${ctx.scenario.dualListboxMoveButtons.join(', ')})` };
    for (const value of values) {
      await loc.getByRole('listbox').first().getByRole('option', { name: labelPattern(value) }).click({ timeout });
      await move.click({ timeout });
    }
    return { ok: true, value: values };
  }
  if (values.length !== 1) return { ok: false, reason: 'deze picklist accepteert één waarde' };
  const options = await openCombobox(ctx, loc);
  if (typeof options === 'string') return { ok: false, reason: options };
  return clickOption(ctx, loc, values[0]);
}

/** Options of the listbox this combobox controls, so native <option>s elsewhere on the screen never match. */
async function optionsOf(ctx: FillContext, combobox: Locator): Promise<Locator> {
  const id = await combobox.getAttribute('aria-controls');
  const listbox = id ? ctx.scope.locator(`[id="${id.replace(/"/g, '\\"')}"]`) : undefined;
  if (listbox && (await listbox.count()) === 1) return listbox.getByRole('option').visible();
  return ctx.scope.locator('[role="option"]').visible();
}

async function openCombobox(ctx: FillContext, loc: Locator): Promise<string[] | string> {
  await loc.click({ timeout: ctx.scenario.timeouts.actionMs });
  const options = await optionsOf(ctx, loc);
  const texts = await stableTexts(options, ctx.scenario.timeouts.actionMs, (t) => t.length > 0);
  return texts.length ? texts.map((t) => t.split('\n')[0].trim()) : 'geen opties zichtbaar na openen van de picklist';
}

async function clickOption(ctx: FillContext, combobox: Locator, value: string): Promise<FillResult> {
  const option = (await optionsOf(ctx, combobox)).and(ctx.scope.getByRole('option', { name: labelPattern(value) }));
  if ((await option.count()) !== 1) {
    await combobox.press('Escape').catch(() => undefined);
    return { ok: false, reason: `optie "${value}" niet eenduidig gevonden in de geopende picklist` };
  }
  await option.click({ timeout: ctx.scenario.timeouts.actionMs });
  return { ok: true, value };
}

async function firstUnique(scope: Locator, names: string[]): Promise<Locator | undefined> {
  for (const name of names) {
    const button = scope.getByRole('button', { name, exact: true });
    if ((await button.count()) === 1) return button;
  }
  return undefined;
}

/** Polls option texts until they are non-empty (per `ready`) and unchanged between two reads. */
async function stableTexts(options: Locator, timeout: number, ready: (texts: string[]) => boolean): Promise<string[]> {
  const deadline = Date.now() + timeout;
  let previous: string | undefined;
  while (Date.now() < deadline) {
    const texts = await options.allInnerTexts();
    const key = JSON.stringify(texts);
    if (ready(texts) && key === previous) return texts;
    previous = key;
    await options.page().waitForTimeout(300);
  }
  return [];
}
