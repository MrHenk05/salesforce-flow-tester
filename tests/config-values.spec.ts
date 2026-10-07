import path from 'node:path';
import { expect, test } from '@playwright/test';
import { ConfigError, parseScenario, resolveStartUrl } from '../src/config.js';
import type { ScannedField } from '../src/scan.js';
import { createRng, formatDate, generateValue } from '../src/values.js';

const base = { name: 'x', seed: 1, startUrl: '/flow/Test', allowedOrgUrls: ['https://voorbeeld.my.salesforce.com/'] };
const parse = (raw: object) => parseScenario(raw, { baseDir: '/scenarios', cwd: '/project' });

function textField(overrides: Partial<ScannedField>): ScannedField {
  return {
    key: 'x#1', label: 'Omschrijving', occurrence: 1, kind: 'text', editable: true, required: true, value: '',
    constraints: {}, errors: [], labelSource: 'label', locate: { by: 'role', name: 'x', index: 0, expected: 1 }, ...overrides,
  };
}

test('scenario: standaardwaarden, paden en start-URL', () => {
  const s = parse({ ...base, documentsDirectory: '../docs', urlParameters: { recordId: '001' } });
  expect(s.documentsDirectory).toBe(path.resolve('/docs'));
  expect(s.allowFinish).toBe(false);
  expect(s.navigation.next).toContain('Volgende');
  expect(s.browser.channel).toBe('msedge');
  expect(s.browser.profileDirectory).toBe(path.resolve('/project/.edge-profile'));
  expect(resolveStartUrl(s).href).toBe('https://voorbeeld.my.salesforce.com/flow/Test?recordId=001');
});

test('scenario: tikfouten en tegenstrijdige instellingen worden geweigerd', () => {
  expect(() => parse({ ...base, allowFinsh: true })).toThrow('onbekende sleutel "allowFinsh"');
  expect(() => parse({ ...base, expectedOutcome: { type: 'validationError' } })).toThrow('"expectedOutcome.errors"');
  expect(() => parse({ ...base, screens: [{ uploads: [{ label: 'X', invalid: 'type' }] }] })).toThrow('alleen met "expect": "error"');
  expect(() => parse({ ...base, screens: [{ fields: [{ label: 'A', lookup: { search: 'x' } }] }] })).toThrow('lookup vereist');
  expect(() => parse({ ...base, seed: 'abc' })).toThrow(ConfigError);
});

test('testdata: vaste seed geeft vaste waarden', () => {
  const field = textField({ label: 'Voornaam' });
  const a = generateValue(field, createRng(5, 'veld', 'Voornaam', 1));
  expect(generateValue(field, createRng(5, 'veld', 'Voornaam', 1))).toEqual(a);
  const values = new Set([1, 2, 3, 4, 5, 6].map((s) => JSON.stringify(generateValue(field, createRng(s, 'veld', 'Voornaam', 1)))));
  expect(values.size).toBeGreaterThan(1);
});

test('testdata: houdt rekening met type, label en zichtbare beperkingen', () => {
  const rng = createRng(1);
  expect(generateValue(textField({ kind: 'email' }), rng)).toEqual({ value: expect.stringMatching(/^[^@]+@example\.com$/) });
  expect(generateValue(textField({ label: 'KvK-nummer', constraints: { pattern: '[0-9]{8}' } }), rng)).toEqual({ value: expect.stringMatching(/^\d{8}$/) });
  expect(generateValue(textField({ constraints: { pattern: '\\d{4}' } }), rng)).toEqual({ value: expect.stringMatching(/^\d{4}$/) });
  expect(generateValue(textField({ constraints: { pattern: '[A-Z]{2}-\\d+' } }), rng)).toEqual({ unresolved: expect.stringContaining('invoerpatroon') });
  expect(generateValue(textField({ constraints: { maxLength: 5 } }), rng)).toEqual({ value: 'Test' });
  for (let i = 0; i < 20; i++) {
    const n = generateValue(textField({ kind: 'number', constraints: { min: '10', max: '12' } }), rng) as { value: string };
    expect(Number(n.value)).toBeGreaterThanOrEqual(10);
    expect(Number(n.value)).toBeLessThanOrEqual(12);
  }
  expect(generateValue(textField({ kind: 'date', variant: 'text' }), rng)).toEqual({ unresolved: expect.stringContaining('locale.dateFormat') });
  expect(generateValue(textField({ kind: 'date', variant: 'text' }), rng, { dateFormat: 'd-M-yyyy' })).toEqual({ value: expect.stringMatching(/^\d{1,2}-\d{1,2}-\d{4}$/) });
  expect(generateValue(textField({ kind: 'date', nativeType: 'date' }), rng)).toEqual({ value: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) });
  expect(generateValue(textField({ kind: 'password' }), rng)).toEqual({ unresolved: expect.any(String) });
  expect(formatDate('2026-03-05', 'dd-MM-yyyy')).toBe('05-03-2026');
  expect(formatDate('2026-03-05', 'M/d/yyyy')).toBe('3/5/2026');
});
