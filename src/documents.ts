import { lstat, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import type { UploadConfig } from './config.js';
import { createRng, shuffle } from './values.js';

export interface DocumentFile {
  name: string;
  path: string;
  size: number;
}

export interface UploadConstraints {
  accept?: string;
  multiple: boolean | null;
  maxBytes?: number;
  maxFiles?: number;
}

export type Selection =
  | { ok: true; files: DocumentFile[]; notes: string[] }
  | { ok: false; reason: string };

const ignored = /^(\.|~\$)|^(desktop\.ini|thumbs\.db)$/i;

/** Lists regular files directly inside the directory. Symlinks and subfolders are never followed. */
export async function listDocuments(directory: string | undefined): Promise<{ ok: true; files: DocumentFile[] } | { ok: false; reason: string }> {
  if (!directory) return { ok: false, reason: 'documentsDirectory is niet ingesteld in het scenario' };
  let base: string;
  try {
    base = await realpath(directory);
    if (!(await lstat(base)).isDirectory()) return { ok: false, reason: `documentsDirectory is geen map: ${directory}` };
  } catch {
    return { ok: false, reason: `documentsDirectory bestaat niet: ${directory}` };
  }
  const files: DocumentFile[] = [];
  for (const name of await readdir(base)) {
    if (ignored.test(name)) continue;
    const stat = await lstat(path.join(base, name));
    if (stat.isFile()) files.push({ name, path: path.join(base, name), size: stat.size });
  }
  if (!files.length) return { ok: false, reason: `documentsDirectory bevat geen bruikbare bestanden: ${directory}` };
  files.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { ok: true, files };
}

const mimeByExtension: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.txt': 'text/plain',
  '.csv': 'text/csv',
  '.md': 'text/markdown',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

export function matchesAccept(fileName: string, accept: string | undefined): boolean {
  if (!accept) return true;
  const ext = path.extname(fileName).toLowerCase();
  const mime = mimeByExtension[ext];
  return accept
    .split(',')
    .map((a) => a.trim().toLowerCase())
    .filter(Boolean)
    .some((a) => (a.startsWith('.') ? a === ext : a.endsWith('/*') ? !!mime?.startsWith(a.slice(0, -1)) : a === mime));
}

function extensionAllowed(name: string, extensions: string[] | undefined) {
  if (!extensions?.length) return true;
  const ext = path.extname(name).toLowerCase();
  return extensions.some((e) => (e.startsWith('.') ? e : `.${e}`).toLowerCase() === ext);
}

/**
 * Picks the files for one upload component. Random choices are reproducible: candidates are sorted by
 * name and shuffled with a stream derived from the scenario seed and the upload label.
 */
export async function selectDocuments(
  directory: string | undefined,
  config: UploadConfig | undefined,
  component: UploadConstraints,
  seed: number,
  key: string,
): Promise<Selection> {
  const listing = await listDocuments(directory);
  if (!listing.ok) return listing;

  const negative = config?.expect === 'error';
  const maxBytes = config?.maxSizeBytes ?? component.maxBytes;
  const maxFiles = config?.maxFiles ?? component.maxFiles;
  const count = config?.files?.length ?? config?.count ?? 1;
  const notes: string[] = [];

  if (!negative) {
    if (count > 1 && component.multiple === false) {
      return { ok: false, reason: `component accepteert één bestand, scenario vraagt ${count}` };
    }
    if (maxFiles !== undefined && count > maxFiles) {
      return { ok: false, reason: `scenario vraagt ${count} bestanden, maximum is ${maxFiles}` };
    }
  }

  const suitable = (f: DocumentFile) =>
    matchesAccept(f.name, component.accept) &&
    extensionAllowed(f.name, config?.extensions) &&
    (maxBytes === undefined || f.size <= maxBytes);

  if (config?.files?.length) {
    const files: DocumentFile[] = [];
    for (const name of config.files) {
      if (path.basename(name) !== name || name === '..' || name === '.' || path.isAbsolute(name)) {
        return { ok: false, reason: `"${name}" is geen bestandsnaam binnen documentsDirectory; paden zijn niet toegestaan` };
      }
      const file = listing.files.find((f) => f.name === name);
      if (!file) return { ok: false, reason: `scenario-bestand "${name}" niet gevonden in documentsDirectory (of het is geen gewoon bestand)` };
      if (!suitable(file)) {
        if (!negative) return { ok: false, reason: `"${name}" voldoet niet aan de toegestane bestandstypen/grootte; alleen toegestaan in een negatief scenario` };
        notes.push(`"${name}" voldoet bewust niet aan de beperkingen (negatief scenario)`);
      }
      files.push(file);
    }
    return { ok: true, files, notes };
  }

  let candidates: DocumentFile[];
  if (config?.invalid === 'type') {
    if (!component.accept && !config.extensions?.length) {
      return { ok: false, reason: 'geen bestandstypebeperking bekend; kan geen ongeldig bestandstype kiezen' };
    }
    candidates = listing.files.filter((f) => !(matchesAccept(f.name, component.accept) && extensionAllowed(f.name, config.extensions)));
  } else if (config?.invalid === 'size') {
    if (maxBytes === undefined) return { ok: false, reason: 'geen maximale bestandsgrootte bekend; kan geen te groot bestand kiezen' };
    candidates = listing.files.filter((f) => f.size > maxBytes);
  } else {
    candidates = listing.files.filter(suitable);
  }
  if (candidates.length < count) {
    const what = config?.invalid ? `ongeldige (${config.invalid}) bestanden` : 'geschikte bestanden';
    return { ok: false, reason: `onvoldoende ${what} in documentsDirectory: ${candidates.length} gevonden, ${count} nodig` };
  }
  const rng = createRng(seed, 'upload', key);
  return { ok: true, files: shuffle(rng, candidates).slice(0, count), notes };
}
