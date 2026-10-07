import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { AllowedOrgError } from '../src/runner.js';
import { demoScenario, field, login, run } from './helpers.js';

test.beforeEach(async ({ page }) => login(page));

test('positief scenario: vult in, uploadt meerdere documenten en rondt af', async ({ page }, testInfo) => {
  const report = await run(page, demoScenario('demo-positief'), 'run', testInfo);

  expect(report.issues.filter((i) => i.severity !== 'waarschuwing')).toEqual([]);
  expect(report.status).toBe('geslaagd');
  expect(report.endState).toBe('afgerond');
  expect(report.checks.every((c) => c.passed)).toBe(true);
  expect(report.checks.map((c) => c.description)).toContain('Einduitkomst: tekst na afronden');
  await expect(page.getByText('Bedankt! Uw aanvraag is ontvangen onder nummer AANVR-0001.')).toBeVisible();

  const actions = report.actions.map((a) => `${a.step}|${a.target}|${a.action}|${a.source}`);
  expect(actions).toContain('1|Klanttype|gekozen|scenario');
  expect(actions).toContain('1|Bedrijfsnaam|ingevuld|automatisch');
  expect(actions).toContain('1|KvK-nummer|ingevuld|automatisch');
  expect(actions).toContain('1|Telefoon|ingevuld|automatisch');
  expect(actions).toContain('1|Telefoon (#2)|ingevuld|scenario');
  expect(actions).toContain('1|Ik ga akkoord met de voorwaarden|aangevinkt|automatisch');
  expect(actions).toContain('2|Provincie|gekozen|automatisch');
  expect(actions).toContain('2|Account|lookup geselecteerd|scenario');
  expect(actions).toContain('2|Product|gekozen|automatisch');
  expect(actions.some((a) => a.startsWith('1|Nieuwsbrief'))).toBe(false);

  const uploads = report.uploads.filter((u) => u.file);
  expect(uploads.filter((u) => u.label === 'Bijlagen')).toHaveLength(2);
  expect(uploads.every((u) => u.outcome === 'geüpload')).toBe(true);
  expect(uploads.find((u) => u.label === 'Identiteitsbewijs')?.file).toMatch(/\.(png|jpg)$/);
  expect(uploads.find((u) => u.label === 'Aanvullend document')?.file).toMatch(/\.pdf$/);
  for (const u of uploads) expect(u.sizeBytes).toBeGreaterThan(0);

  // Masked in the text report, but the review screen showed the real value.
  expect(JSON.stringify(report)).not.toContain('Jansen');
  expect(report.screens[3].text).toBeUndefined();

  await expect(page.getByLabel('Notities')).toHaveValue('');
  await expect(page.getByRole('searchbox', { name: 'Zoeken in Salesforce' })).toHaveValue('');
});

test('stopt vóór Finish als allowFinish uit staat', async ({ page }, testInfo) => {
  const scenario = demoScenario('demo-positief', {
    allowFinish: false,
    expectedOutcome: { type: 'screen', texts: ['Controleer uw aanvraag'] },
  });
  const report = await run(page, scenario, 'run', testInfo);

  expect(report.status).toBe('geslaagd');
  expect(report.endState).toBe('doelscherm bereikt');
  await expect(page.getByRole('button', { name: 'Voltooien' })).toBeVisible();
  expect(report.actions.some((a) => a.target === 'Voltooien')).toBe(false);
});

test('Finish wordt niet aangeklikt zonder allowFinish, ook als het scenario erom vraagt', async ({ page }, testInfo) => {
  const report = await run(page, demoScenario('demo-positief', { allowFinish: false }), 'run', testInfo);

  expect(report.endState).toBe('gestopt vóór Finish (allowFinish is false)');
  expect(report.status).toBe('geblokkeerd');
  expect(report.statusReason).toContain('allowFinish');
  await expect(page.getByRole('heading', { name: 'Controle' })).toBeVisible();
});

test('zelfde seed geeft dezelfde testdata en documentkeuze; andere seed niet', async ({ page }, testInfo) => {
  const values = async (seed: number) => {
    const scenario = demoScenario('demo-positief', {
      seed,
      expectedOutcome: undefined,
      reporting: { maskValues: false },
      screens: [{ match: { step: 1 }, action: 'stop' }],
    });
    const report = await run(page, scenario, 'run', testInfo);
    expect(report.status).toBe('geen_eindcontrole');
    return report.actions.map((a) => `${a.target}=${JSON.stringify(a.value)}`);
  };
  const first = await values(1);
  expect(await values(1)).toEqual(first);
  expect(await values(2)).not.toEqual(first);
});

test('negatief scenario: verwachte validatiefout telt als geslaagd', async ({ page }, testInfo) => {
  const report = await run(page, demoScenario('demo-negatief-validatie'), 'run', testInfo);

  expect(report.status).toBe('geslaagd');
  expect(report.endState).toBe('validatiefout na navigeren');
  expect(report.checks).toEqual([
    expect.objectContaining({ expected: 'KvK-nummer moet uit 8 cijfers bestaan.', passed: true }),
  ]);
});

test('onverwachte validatiefout na invullen maakt de test mislukt', async ({ page }, testInfo) => {
  const scenario = demoScenario('demo-negatief-validatie', {
    expectedOutcome: undefined,
    screens: [{ match: { step: 1 }, fields: [{ label: 'E-mail', value: 'geen-emailadres' }] }],
  });
  const report = await run(page, scenario, 'run', testInfo);

  expect(report.status).toBe('mislukt');
  expect(report.endState).toBe('validatiefout na invullen');
  expect(report.statusReason).toContain('Voer een geldig e-mailadres in.');
});

test('verwachte validatiefout die niet optreedt maakt de test mislukt', async ({ page }, testInfo) => {
  const scenario = demoScenario('demo-negatief-validatie', {
    screens: [{ match: { step: 1 }, fields: [{ label: 'Klanttype', value: 'Particulier' }], action: 'next' }, { match: { step: 2 }, fields: [{ label: 'Account', skip: true }], action: 'stop' }],
  });
  const report = await run(page, scenario, 'run', testInfo);

  expect(report.status).toBe('mislukt');
  expect(report.checks.at(-1)).toMatchObject({ description: 'Einduitkomst: validatiefout', passed: false });
});

test('negatieve upload: ongeldig bestandstype wordt alleen op verzoek geüpload en de fout wordt herkend', async ({ page }, testInfo) => {
  const report = await run(page, demoScenario('demo-negatief-upload'), 'run', testInfo);

  expect(report.status).toBe('geslaagd');
  expect(report.uploads.find((u) => u.label === 'Identiteitsbewijs')).toMatchObject({
    file: 'notities.md', outcome: 'fout', expected: 'error',
  });
  expect(report.checks).toEqual([expect.objectContaining({ passed: true, expected: 'bestandstype niet toegestaan' })]);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('[data-field=idbewijs] li')).toHaveCount(0);
});

test('ongeldig bestand zonder negatieve verwachting wordt niet geüpload', async ({ page }, testInfo) => {
  const scenario = demoScenario('demo-negatief-upload', {
    screens: [{ match: { text: 'Documenten' }, uploads: [{ label: 'Identiteitsbewijs', files: ['notities.md'] }], action: 'stop' }],
  });
  const report = await run(page, scenario, 'run', testInfo);

  expect(report.status).toBe('geblokkeerd');
  expect(report.uploads.find((u) => u.label === 'Identiteitsbewijs')).toMatchObject({ outcome: 'geblokkeerd' });
  expect(report.statusReason).toContain('alleen toegestaan in een negatief scenario');
});

test('lege documentenmap blokkeert de upload met een duidelijke reden', async ({ page }, testInfo) => {
  const empty = mkdtempSync(path.join(tmpdir(), 'flowtester-leeg-'));
  const report = await run(page, demoScenario('demo-positief', { documentsDirectory: empty }), 'run', testInfo);

  expect(report.status).toBe('geblokkeerd');
  expect(report.uploads.find((u) => u.label === 'Identiteitsbewijs')).toMatchObject({ outcome: 'geblokkeerd' });
  expect(report.statusReason).toContain('bevat geen bruikbare bestanden');
  await expect(page.getByRole('heading', { name: 'Documenten' })).toBeVisible();
});

test('lookup kiest nooit zomaar een resultaat bij meerdere treffers', async ({ page }, testInfo) => {
  const scenario = demoScenario('demo-positief', {
    screens: [{ match: { text: 'Aanvraag' }, fields: [{ label: 'Account', lookup: { search: 'Acme', select: 'Acme' } }] }],
  });
  const report = await run(page, scenario, 'run', testInfo);

  expect(report.status).toBe('geblokkeerd');
  expect(report.statusReason).toContain('2 resultaten passen bij "Acme"');
  await expect(page.locator('.slds-pill')).toBeHidden();
});

test('verplichte lookup zonder scenario-waarde blijft onopgelost', async ({ page }, testInfo) => {
  const report = await run(page, demoScenario('demo-positief', { screens: [] }), 'run', testInfo);

  expect(report.status).toBe('geblokkeerd');
  expect(report.issues.find((i) => i.subject === 'Account')?.message).toContain('nooit zomaar een resultaat');
  await expect(page.getByRole('heading', { name: 'Aanvraag' })).toBeVisible();
});

test('bestaande waarden worden alleen overschreven als het scenario dat vraagt', async ({ page }, testInfo) => {
  const prefilled = { urlParameters: { voornaam: 'Bestaand' }, reporting: { maskValues: false } };
  const stopScreen = (fields: unknown[]) => [{ match: { step: 1 }, fields, action: 'stop' }];

  let report = await run(page, demoScenario('demo-positief', { ...prefilled, screens: stopScreen([]) }), 'run', testInfo);
  expect(report.actions.find((a) => a.target === 'Voornaam')).toMatchObject({ action: 'behouden', value: 'Bestaand' });

  report = await run(page, demoScenario('demo-positief', { ...prefilled, screens: stopScreen([{ label: 'Voornaam', value: 'Nieuw' }]) }), 'run', testInfo);
  expect(report.status).toBe('geblokkeerd');
  await expect(page.getByLabel('Voornaam')).toHaveValue('Bestaand');

  report = await run(page, demoScenario('demo-positief', {
    ...prefilled, screens: stopScreen([{ label: 'Voornaam', value: 'Nieuw', overwrite: true }]),
  }), 'run', testInfo);
  await expect(page.getByLabel('Voornaam')).toHaveValue('Nieuw');
});

test('scenario-veld dat niet op het scherm staat blokkeert', async ({ page }, testInfo) => {
  const scenario = demoScenario('demo-positief', { screens: [{ match: { step: 1 }, fields: [{ label: 'Bestaat niet', value: 'x' }] }] });
  const report = await run(page, scenario, 'run', testInfo);

  expect(report.status).toBe('geblokkeerd');
  expect(report.statusReason).toContain('"Bestaat niet"');
  await expect(page.getByRole('heading', { name: 'Aanvrager' })).toBeVisible();
});

test('flowfout wordt herkend', async ({ page }, testInfo) => {
  const scenario = demoScenario('demo-positief', { screens: [{ match: { step: 1 }, fields: [{ label: 'Voornaam', value: 'FOUT' }] }] });
  const report = await run(page, scenario, 'run', testInfo);

  expect(report.status).toBe('mislukt');
  expect(report.issues.find((i) => i.subject === 'flowfout')).toBeDefined();
});

test('run weigert een org die niet expliciet is toegestaan', async ({ page }, testInfo) => {
  const scenario = demoScenario('demo-positief', { allowedOrgUrls: ['https://voorbeeld.invalid'] });
  await expect(run(page, scenario, 'run', testInfo)).rejects.toThrow(AllowedOrgError);
  expect(page.url()).toBe('about:blank');

  await expect(run(page, demoScenario('demo-positief', { allowedOrgUrls: [] }), 'run', testInfo)).rejects.toThrow('allowedOrgUrls');
});

test('wacht op handmatige login als de sessie ontbreekt', async ({ page }, testInfo) => {
  await page.context().clearCookies();
  const scenario = demoScenario('demo-positief', { timeouts: { loginMs: 20_000 } });
  const result = run(page, scenario, 'inspect', testInfo);

  // Plays the user: log in by hand on the login page that the tester is waiting on.
  await page.getByLabel('Gebruikersnaam').fill('tester');
  await page.getByRole('button', { name: 'Inloggen' }).click();

  const report = await result;
  expect(report.status).toBe('inventarisatie');
  expect(field(report, 'Voornaam')).toBeDefined();
});
