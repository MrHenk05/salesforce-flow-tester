import { mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { listDocuments, matchesAccept, selectDocuments } from '../src/documents.js';
import { demoDocuments } from './helpers.js';

const anyComponent = { multiple: true };

function folder(files: Record<string, number>, order = Object.keys(files)): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'flowtester-docs-'));
  for (const name of order) writeFileSync(path.join(dir, name), 'x'.repeat(files[name]));
  return dir;
}

test('willekeurige keuze is reproduceerbaar en onafhankelijk van de volgorde op schijf', async () => {
  const files = { 'a.pdf': 10, 'b.pdf': 10, 'c.pdf': 10, 'd.pdf': 10, 'e.pdf': 10, 'f.pdf': 10 };
  const one = folder(files);
  const two = folder(files, Object.keys(files).reverse());
  const pick = async (dir: string, seed: number, key = 'Bijlagen#1') => {
    const result = await selectDocuments(dir, { label: 'Bijlagen', count: 3 }, anyComponent, seed, key);
    if (!result.ok) throw new Error(result.reason);
    return result.files.map((f) => f.name);
  };

  const first = await pick(one, 42);
  expect(first).toHaveLength(3);
  expect(new Set(first).size).toBe(3);
  expect(await pick(one, 42)).toEqual(first);
  expect(await pick(two, 42)).toEqual(first);

  const others = await Promise.all([1, 2, 3, 4, 5].map((seed) => pick(one, seed)));
  expect(others.some((o) => JSON.stringify(o) !== JSON.stringify(first))).toBe(true);
});

test('respecteert toegestane typen, scenario-extensies, maximale grootte en aantal', async () => {
  const dir = folder({ 'klein.pdf': 100, 'groot.pdf': 5000, 'foto.png': 100, 'tekst.txt': 100 });
  const result = await selectDocuments(dir, { label: 'X', count: 2 }, { accept: '.pdf,image/*', multiple: true, maxBytes: 1000 }, 1, 'X#1');
  expect(result.ok && result.files.map((f) => f.name).sort()).toEqual(['foto.png', 'klein.pdf']);

  const onlyPng = await selectDocuments(dir, { label: 'X', extensions: ['png'] }, anyComponent, 1, 'X#1');
  expect(onlyPng.ok && onlyPng.files.map((f) => f.name)).toEqual(['foto.png']);

  const tooMany = await selectDocuments(dir, { label: 'X', count: 3 }, { accept: '.pdf', multiple: true, maxBytes: 1000 }, 1, 'X#1');
  expect(tooMany).toEqual({ ok: false, reason: expect.stringContaining('1 gevonden, 3 nodig') });

  expect(await selectDocuments(dir, { label: 'X', count: 2 }, { multiple: false }, 1, 'X#1'))
    .toEqual({ ok: false, reason: expect.stringContaining('accepteert één bestand') });
  expect(await selectDocuments(dir, { label: 'X', count: 3 }, { multiple: true, maxFiles: 2 }, 1, 'X#1'))
    .toEqual({ ok: false, reason: expect.stringContaining('maximum is 2') });
});

test('ongeldige bestanden alleen in een negatief scenario', async () => {
  const dir = folder({ 'ok.pdf': 10, 'notities.md': 10, 'groot.pdf': 5000 });
  const component = { accept: '.pdf', multiple: false, maxBytes: 1000 };

  const wrongType = await selectDocuments(dir, { label: 'X', invalid: 'type', expect: 'error' }, component, 1, 'X#1');
  expect(wrongType.ok && wrongType.files.map((f) => f.name)).toEqual(['notities.md']);
  const tooLarge = await selectDocuments(dir, { label: 'X', invalid: 'size', expect: 'error' }, component, 1, 'X#1');
  expect(tooLarge.ok && tooLarge.files.map((f) => f.name)).toEqual(['groot.pdf']);

  expect(await selectDocuments(dir, { label: 'X', files: ['notities.md'] }, component, 1, 'X#1'))
    .toEqual({ ok: false, reason: expect.stringContaining('alleen toegestaan in een negatief scenario') });
  const explicit = await selectDocuments(dir, { label: 'X', files: ['notities.md'], expect: 'error' }, component, 1, 'X#1');
  expect(explicit.ok && explicit.notes).toEqual([expect.stringContaining('negatief scenario')]);

  const noLimit = await selectDocuments(dir, { label: 'X', invalid: 'size', expect: 'error' }, { multiple: false }, 1, 'X#1');
  expect(noLimit).toEqual({ ok: false, reason: expect.stringContaining('geen maximale bestandsgrootte bekend') });
});

test('ontbrekende of lege map en ontbrekende scenario-bestanden geven een duidelijke reden', async () => {
  expect(await selectDocuments(undefined, undefined, anyComponent, 1, 'X#1'))
    .toEqual({ ok: false, reason: 'documentsDirectory is niet ingesteld in het scenario' });
  expect(await selectDocuments(path.join(tmpdir(), 'bestaat-niet-12345'), undefined, anyComponent, 1, 'X#1'))
    .toEqual({ ok: false, reason: expect.stringContaining('bestaat niet') });
  const empty = mkdtempSync(path.join(tmpdir(), 'flowtester-leeg-'));
  writeFileSync(path.join(empty, '.DS_Store'), '');
  mkdirSync(path.join(empty, 'submap'));
  expect(await selectDocuments(empty, undefined, anyComponent, 1, 'X#1'))
    .toEqual({ ok: false, reason: expect.stringContaining('geen bruikbare bestanden') });
  expect(await selectDocuments(demoDocuments, { label: 'X', files: ['bestaat-niet.pdf'] }, anyComponent, 1, 'X#1'))
    .toEqual({ ok: false, reason: expect.stringContaining('niet gevonden') });
});

test('padverwijzingen en symlinks geven geen toegang buiten de map', async () => {
  const outside = folder({ 'geheim.pdf': 10 });
  const dir = folder({ 'ok.pdf': 10 });
  symlinkSync(path.join(outside, 'geheim.pdf'), path.join(dir, 'link.pdf'));
  mkdirSync(path.join(dir, 'sub'));
  writeFileSync(path.join(dir, 'sub', 'dieper.pdf'), 'x');

  const listing = await listDocuments(dir);
  expect(listing.ok && listing.files.map((f) => f.name)).toEqual(['ok.pdf']);

  for (const name of ['../geheim.pdf', path.join(outside, 'geheim.pdf'), 'sub/dieper.pdf', '..']) {
    expect(await selectDocuments(dir, { label: 'X', files: [name] }, anyComponent, 1, 'X#1'))
      .toEqual({ ok: false, reason: expect.stringContaining('paden zijn niet toegestaan') });
  }
  expect(await selectDocuments(dir, { label: 'X', files: ['link.pdf'] }, anyComponent, 1, 'X#1'))
    .toEqual({ ok: false, reason: expect.stringContaining('niet gevonden') });
});

test('selectie verandert de testdocumenten niet', async () => {
  const before = Object.fromEntries(['aanvraagformulier.pdf', 'notities.md'].map((n) => {
    const p = path.join(demoDocuments, n);
    return [n, { mtime: statSync(p).mtimeMs, content: readFileSync(p).toString('base64') }];
  }));
  await selectDocuments(demoDocuments, { label: 'X', count: 3 }, anyComponent, 7, 'X#1');
  for (const [n, b] of Object.entries(before)) {
    const p = path.join(demoDocuments, n);
    expect({ mtime: statSync(p).mtimeMs, content: readFileSync(p).toString('base64') }).toEqual(b);
  }
});

test('accept-attribuut met extensies en MIME-typen', () => {
  expect(matchesAccept('a.PDF', '.pdf')).toBe(true);
  expect(matchesAccept('a.png', 'image/*')).toBe(true);
  expect(matchesAccept('a.png', 'application/pdf')).toBe(false);
  expect(matchesAccept('a.pdf', 'application/pdf, .docx')).toBe(true);
  expect(matchesAccept('a.exe', undefined)).toBe(true);
});
