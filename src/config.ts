import { readFile } from 'node:fs/promises';
import path from 'node:path';

export type FieldValue = string | number | boolean | string[];

export interface FieldConfig {
  label: string;
  occurrence?: number;
  value?: FieldValue;
  lookup?: { search: string; select: string };
  overwrite?: boolean;
  skip?: boolean;
  optional?: boolean;
}

export interface UploadConfig {
  label: string;
  occurrence?: number;
  files?: string[];
  count?: number;
  extensions?: string[];
  maxSizeBytes?: number;
  maxFiles?: number;
  invalid?: 'type' | 'size';
  expect?: 'success' | 'error';
  expectedError?: string;
  skip?: boolean;
}

export interface ScreenConfig {
  match?: { step?: number; text?: string };
  fields?: FieldConfig[];
  uploads?: UploadConfig[];
  expect?: { texts?: string[]; errors?: string[] };
  action?: 'next' | 'previous' | 'finish' | 'stop';
}

export interface ExpectedOutcome {
  type: 'finished' | 'screen' | 'validationError';
  texts?: string[];
  errors?: string[];
}

export interface Scenario {
  name: string;
  seed: number;
  startUrl: string;
  urlParameters: Record<string, string>;
  allowedOrgUrls: string[];
  flowContainer: { selector: string; frame?: string };
  browser: { channel?: string; executablePath?: string; profileDirectory: string };
  documentsDirectory?: string;
  autoFill: 'all' | 'required' | 'none';
  allowFinish: boolean;
  maxSteps: number;
  timeouts: { actionMs: number; navigationMs: number; uploadMs: number; loginMs: number; settleMs: number };
  locale: { dateFormat?: string; timeFormat?: string };
  navigation: { next: string[]; previous: string[]; finish: string[] };
  uploadDialog: { confirmButtons: string[]; successPatterns: string[]; errorPatterns: string[] };
  dualListboxMoveButtons: string[];
  faultPatterns: string[];
  knownNamespaces: Record<string, { owner: string; package?: string; source?: string }>;
  screens: ScreenConfig[];
  expectedOutcome?: ExpectedOutcome;
  reporting: { directory: string; maskValues: boolean };
  file?: string;
}

const defaults = {
  urlParameters: {},
  flowContainer: { selector: 'flowruntime-flow' },
  autoFill: 'all',
  allowFinish: false,
  maxSteps: 15,
  timeouts: { actionMs: 10_000, navigationMs: 30_000, uploadMs: 60_000, loginMs: 600_000, settleMs: 5_000 },
  locale: {},
  navigation: {
    next: ['Next', 'Volgende'],
    previous: ['Previous', 'Vorige'],
    finish: ['Finish', 'Voltooien'],
  },
  uploadDialog: {
    confirmButtons: ['Done', 'Gereed', 'Klaar'],
    successPatterns: ['\\b(\\d+) (?:of|van) \\1 (?:files?|bestand(?:en)?) (?:uploaded|geüpload)'],
    errorPatterns: ['mislukt', 'failed', 'niet toegestaan', 'not allowed', 'not supported', 'te groot', 'too large', 'exceeds', 'error', 'fout'],
  },
  dualListboxMoveButtons: ['Move selection to Selected', 'Move selection to Chosen'],
  faultPatterns: ['unhandled fault', 'onverwerkte fout', 'an error occurred', 'er is een fout opgetreden'],
  knownNamespaces: {},
  screens: [],
  reporting: { directory: 'reports', maskValues: true },
} satisfies Partial<Scenario>;

const topLevelKeys = new Set([
  '$schema', 'name', 'seed', 'startUrl', 'urlParameters', 'allowedOrgUrls', 'flowContainer', 'browser',
  'documentsDirectory', 'autoFill', 'allowFinish', 'maxSteps', 'timeouts', 'locale', 'navigation',
  'uploadDialog', 'dualListboxMoveButtons', 'faultPatterns', 'knownNamespaces', 'screens',
  'expectedOutcome', 'reporting', 'description',
]);

export class ConfigError extends Error {}

export async function loadScenario(file: string, cwd = process.cwd()): Promise<Scenario> {
  const absolute = path.resolve(cwd, file);
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(absolute, 'utf8'));
  } catch (error) {
    throw new ConfigError(`Scenario ${absolute} kan niet worden gelezen: ${(error as Error).message}`);
  }
  return parseScenario(raw, { baseDir: path.dirname(absolute), cwd, file: absolute });
}

export function parseScenario(raw: unknown, opts: { baseDir: string; cwd: string; file?: string }): Scenario {
  const problems: string[] = [];
  if (!isObject(raw)) throw new ConfigError('Scenario moet een JSON-object zijn.');

  for (const key of Object.keys(raw)) {
    if (!topLevelKeys.has(key)) problems.push(`onbekende sleutel "${key}"`);
  }
  if (typeof raw.name !== 'string' || !raw.name.trim()) problems.push('"name" ontbreekt');
  if (!Number.isInteger(raw.seed)) problems.push('"seed" moet een geheel getal zijn');
  if (typeof raw.startUrl !== 'string' || !raw.startUrl) problems.push('"startUrl" ontbreekt');
  if (raw.allowedOrgUrls !== undefined && !isStringArray(raw.allowedOrgUrls)) {
    problems.push('"allowedOrgUrls" moet een lijst met URL\'s zijn');
  }
  if (raw.autoFill !== undefined && !['all', 'required', 'none'].includes(raw.autoFill as string)) {
    problems.push('"autoFill" moet "all", "required" of "none" zijn');
  }
  if (raw.screens !== undefined && !Array.isArray(raw.screens)) problems.push('"screens" moet een lijst zijn');
  for (const [i, screen] of ((raw.screens as unknown[]) ?? []).entries()) {
    problems.push(...checkScreen(screen, i + 1));
  }
  const outcome = raw.expectedOutcome;
  if (outcome !== undefined) {
    if (!isObject(outcome) || !['finished', 'screen', 'validationError'].includes(outcome.type as string)) {
      problems.push('"expectedOutcome.type" moet "finished", "screen" of "validationError" zijn');
    } else if (outcome.type === 'validationError' && !isStringArray(outcome.errors)) {
      problems.push('"expectedOutcome.errors" is verplicht bij type "validationError"');
    } else if (outcome.type !== 'validationError' && !isStringArray(outcome.texts)) {
      problems.push(`"expectedOutcome.texts" is verplicht bij type "${outcome.type}"`);
    }
  }
  if (problems.length) throw new ConfigError(`Ongeldig scenario:\n- ${problems.join('\n- ')}`);

  const r = raw as Record<string, any>;
  const browser = { profileDirectory: '.edge-profile', channel: 'msedge', ...r.browser };
  const scenario: Scenario = {
    ...defaults,
    ...r,
    name: r.name,
    seed: r.seed,
    startUrl: r.startUrl,
    urlParameters: { ...defaults.urlParameters, ...r.urlParameters },
    allowedOrgUrls: (r.allowedOrgUrls ?? []).map((u: string) => new URL(u).origin),
    flowContainer: { ...defaults.flowContainer, ...r.flowContainer },
    browser: {
      ...browser,
      profileDirectory: path.resolve(opts.cwd, browser.profileDirectory),
      executablePath: browser.executablePath && path.resolve(opts.cwd, browser.executablePath),
    },
    documentsDirectory: r.documentsDirectory && path.resolve(opts.baseDir, r.documentsDirectory),
    timeouts: { ...defaults.timeouts, ...r.timeouts },
    locale: { ...defaults.locale, ...r.locale },
    navigation: { ...defaults.navigation, ...r.navigation },
    uploadDialog: { ...defaults.uploadDialog, ...r.uploadDialog },
    reporting: {
      ...defaults.reporting,
      ...r.reporting,
      directory: path.resolve(opts.cwd, r.reporting?.directory ?? defaults.reporting.directory),
    },
    file: opts.file,
  };
  return scenario;
}

function checkScreen(screen: unknown, n: number): string[] {
  const problems: string[] = [];
  if (!isObject(screen)) return [`screens[${n}] moet een object zijn`];
  if (screen.action !== undefined && !['next', 'previous', 'finish', 'stop'].includes(screen.action as string)) {
    problems.push(`screens[${n}].action moet "next", "previous", "finish" of "stop" zijn`);
  }
  for (const field of (screen.fields as unknown[]) ?? []) {
    if (!isObject(field) || typeof field.label !== 'string') {
      problems.push(`screens[${n}].fields: ieder veld heeft een "label" nodig`);
    } else if (field.lookup !== undefined) {
      const l = field.lookup;
      if (!isObject(l) || typeof l.search !== 'string' || typeof l.select !== 'string') {
        problems.push(`screens[${n}] veld "${field.label}": lookup vereist "search" en "select"`);
      }
    }
  }
  for (const upload of (screen.uploads as unknown[]) ?? []) {
    if (!isObject(upload) || typeof upload.label !== 'string') {
      problems.push(`screens[${n}].uploads: iedere upload heeft een "label" nodig`);
      continue;
    }
    if (upload.files !== undefined && !isStringArray(upload.files)) {
      problems.push(`screens[${n}] upload "${upload.label}": "files" moet een lijst met bestandsnamen zijn`);
    }
    if (upload.invalid !== undefined && !['type', 'size'].includes(upload.invalid as string)) {
      problems.push(`screens[${n}] upload "${upload.label}": "invalid" moet "type" of "size" zijn`);
    }
    if (upload.invalid !== undefined && upload.expect !== 'error') {
      problems.push(`screens[${n}] upload "${upload.label}": ongeldige bestanden alleen met "expect": "error"`);
    }
  }
  return problems;
}

export function resolveStartUrl(scenario: Scenario): URL {
  const base = scenario.allowedOrgUrls[0];
  const url = base ? new URL(scenario.startUrl, base) : new URL(scenario.startUrl);
  for (const [key, value] of Object.entries(scenario.urlParameters)) url.searchParams.set(key, value);
  return url;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string');
}
