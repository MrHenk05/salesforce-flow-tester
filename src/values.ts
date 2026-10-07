import type { ScannedField } from './scan.js';

export type Rng = () => number;

export function createRng(seed: number, ...context: Array<string | number>): Rng {
  // Derive a separate stream per field/upload so values stay stable when fields appear in another order.
  let state = hash([seed, ...context].join('|'));
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function pick<T>(rng: Rng, items: readonly T[]): T {
  return items[Math.floor(rng() * items.length)];
}

export function shuffle<T>(rng: Rng, items: readonly T[]): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

const digits = (rng: Rng, n: number) => Array.from({ length: n }, () => Math.floor(rng() * 10)).join('');

const textHints: Array<[RegExp, (rng: Rng) => string]> = [
  [/voornaam|first ?name|roepnaam/i, (rng) => pick(rng, ['Anna', 'Daan', 'Sanne', 'Pieter', 'Fatima', 'Lucas', 'Noor', 'Milan'])],
  [/achternaam|last ?name|surname/i, (rng) => pick(rng, ['Jansen', 'de Vries', 'Bakker', 'Visser', 'Smit', 'Meijer'])],
  [/kvk|chamber of commerce/i, (rng) => digits(rng, 8)],
  [/iban/i, () => 'NL91ABNA0417164300'],
  [/postcode|zip|postal/i, (rng) => `${1000 + Math.floor(rng() * 9000)} ${pick(rng, ['AB', 'CD', 'GH', 'KL'])}`],
  [/woonplaats|plaats|city|town/i, (rng) => pick(rng, ['Utrecht', 'Zwolle', 'Breda', 'Groningen', 'Leiden'])],
  [/huisnummer|house ?number/i, (rng) => String(1 + Math.floor(rng() * 200))],
  [/straat|street|adres|address/i, (rng) => `Teststraat ${1 + Math.floor(rng() * 200)}`],
  [/bedrijf|company|organisatie|organi[sz]ation/i, (rng) => `Testbedrijf ${digits(rng, 3)}`],
];

export type Generated = { value: string } | { unresolved: string };

export interface GenerateOptions {
  dateFormat?: string;
  timeFormat?: string;
  today?: Date;
}

/** Generates a plausible value for text-like and date fields. Choice fields are handled by the filler. */
export function generateValue(field: ScannedField, rng: Rng, opts: GenerateOptions = {}): Generated {
  const c = field.constraints;
  const label = field.label;
  let value: string;
  switch (field.kind) {
    case 'email':
      value = `test.${pick(rng, ['anna', 'daan', 'sanne', 'pieter'])}${digits(rng, 3)}@example.com`;
      break;
    case 'tel':
      value = `06${digits(rng, 8)}`;
      break;
    case 'url':
      value = `https://www.example.com/test-${digits(rng, 4)}`;
      break;
    case 'number':
      return numberValue(field, rng);
    case 'date': {
      const date = dateValue(field, rng, opts.today);
      if (field.nativeType === 'date') return { value: isoDate(date) };
      if (!opts.dateFormat) return { unresolved: 'Salesforce-datumveld: stel locale.dateFormat in (bijv. "d-M-yyyy")' };
      return { value: formatDate(date, opts.dateFormat) };
    }
    case 'time': {
      const time = timeValue(rng);
      if (field.nativeType === 'time') return { value: time };
      if (!opts.timeFormat) return { unresolved: 'Salesforce-tijdveld: stel locale.timeFormat in (bijv. "HH:mm")' };
      return { value: formatTime(time, opts.timeFormat) };
    }
    case 'datetime':
      if (field.nativeType !== 'datetime-local') return { unresolved: 'samengesteld datum/tijd-component wordt per deelveld ingevuld' };
      return { value: `${isoDate(dateValue(field, rng, opts.today))}T${timeValue(rng)}` };
    case 'textarea':
    case 'richtext':
      value = `Testtoelichting ${digits(rng, 4)}: automatisch ingevuld door de flowtester.`;
      break;
    case 'text': {
      const hint = textHints.find(([re]) => re.test(label));
      value = hint ? hint[1](rng) : `Test ${label}`.trim();
      break;
    }
    default:
      return { unresolved: `geen automatische waarde voor type "${field.kind}"` };
  }

  if (c.pattern && !matchesPattern(value, c.pattern)) {
    const fixed = digitsForPattern(c.pattern, rng);
    if (!fixed) return { unresolved: `invoerpatroon "${c.pattern}" kan niet betrouwbaar automatisch worden ingevuld` };
    value = fixed;
  }
  if (c.maxLength && value.length > c.maxLength) {
    if (field.kind === 'email' || field.kind === 'url' || c.pattern) {
      return { unresolved: `maximale lengte ${c.maxLength} te kort voor een geldige ${field.kind}-waarde` };
    }
    value = value.slice(0, c.maxLength).trim();
  }
  if (c.minLength && value.length < c.minLength) value = value.padEnd(c.minLength, 'x');
  return { value };
}

function numberValue(field: ScannedField, rng: Rng): Generated {
  const c = field.constraints;
  const min = c.min !== undefined ? Number(c.min) : 1;
  const max = c.max !== undefined ? Number(c.max) : Math.max(min, 100);
  if (!Number.isFinite(min) || !Number.isFinite(max) || max < min) {
    return { unresolved: `onbruikbare grenzen min=${c.min} max=${c.max}` };
  }
  const step = c.step && c.step !== 'any' ? Number(c.step) : 1;
  const steps = Math.floor((max - min) / step);
  const n = min + Math.floor(rng() * (steps + 1)) * step;
  const decimals = String(step).split('.')[1]?.length ?? 0;
  return { value: n.toFixed(decimals) };
}

function dateValue(field: ScannedField, rng: Rng, today = new Date()): Date {
  const base = new Date(Date.UTC(today.getFullYear(), today.getMonth(), today.getDate()));
  const day = 86_400_000;
  let date = /geboorte|birth/i.test(field.label)
    ? new Date(base.getTime() - (25 * 365 + Math.floor(rng() * 35 * 365)) * day)
    : new Date(base.getTime() + (1 + Math.floor(rng() * 60)) * day);
  const { min, max } = field.constraints;
  if (min && /^\d{4}-\d{2}-\d{2}/.test(min) && date < new Date(min.slice(0, 10))) date = new Date(min.slice(0, 10));
  if (max && /^\d{4}-\d{2}-\d{2}/.test(max) && date > new Date(max.slice(0, 10))) date = new Date(max.slice(0, 10));
  return date;
}

function timeValue(rng: Rng): string {
  const quarter = Math.floor(rng() * 32);
  const h = 9 + Math.floor(quarter / 4);
  return `${String(h).padStart(2, '0')}:${String((quarter % 4) * 15).padStart(2, '0')}`;
}

export function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function formatDate(date: Date | string, format: string): string {
  const d = typeof date === 'string' ? new Date(`${date}T00:00:00Z`) : date;
  const parts: Record<string, string> = {
    yyyy: String(d.getUTCFullYear()),
    MM: String(d.getUTCMonth() + 1).padStart(2, '0'),
    M: String(d.getUTCMonth() + 1),
    dd: String(d.getUTCDate()).padStart(2, '0'),
    d: String(d.getUTCDate()),
  };
  return format.replace(/yyyy|MM|M|dd|d/g, (token) => parts[token]);
}

export function formatTime(time: string, format: string): string {
  const [h, m] = time.split(':').map(Number);
  const h12 = h % 12 || 12;
  const parts: Record<string, string> = {
    HH: String(h).padStart(2, '0'),
    H: String(h),
    hh: String(h12).padStart(2, '0'),
    h: String(h12),
    mm: String(m).padStart(2, '0'),
    a: h < 12 ? 'AM' : 'PM',
  };
  return format.replace(/HH|H|hh|h|mm|a/g, (token) => parts[token]);
}

function matchesPattern(value: string, pattern: string): boolean {
  try {
    return new RegExp(`^(?:${pattern})$`, 'v').test(value);
  } catch {
    return false;
  }
}

function digitsForPattern(pattern: string, rng: Rng): string | undefined {
  const m = /^(?:\\d|\[0-9\])\{(\d+)(?:,(\d+))?\}$/.exec(pattern);
  return m ? digits(rng, Number(m[1])) : undefined;
}

const placeholderOption = /^(--\s*(none|geen)\s*--|select an option|selecteer een optie|kies een optie|maak een keuze|-+)?$/i;

export function isPlaceholderOption(text: string): boolean {
  return placeholderOption.test(text.trim());
}
