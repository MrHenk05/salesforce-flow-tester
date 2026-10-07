import { expect, test } from '@playwright/test';
import { demoScenario, field, login, run } from './helpers.js';

test.beforeEach(async ({ page }) => login(page));

test('inspect inventariseert velden binnen de flowcontainer zonder iets te wijzigen', async ({ page }, testInfo) => {
  const report = await run(page, demoScenario('demo-positief'), 'inspect', testInfo);
  const screen = report.screens[0];

  expect(report.status).toBe('inventarisatie');
  expect(field(report, 'Klanttype')).toMatchObject({ kind: 'radio', required: true, options: ['Particulier', 'Zakelijk'], value: null });
  expect(field(report, 'Voornaam')).toMatchObject({ kind: 'text', required: true, constraints: { maxLength: 40 }, value: '' });
  expect(field(report, 'E-mail')).toMatchObject({ kind: 'email', required: true });
  expect(field(report, 'Telefoon', 1, 1)).toMatchObject({ kind: 'tel', required: false });
  expect(field(report, 'Telefoon', 1, 2)).toMatchObject({ kind: 'tel', key: 'Telefoon#2' });
  expect(field(report, 'Website')?.kind).toBe('url');
  expect(field(report, 'Geboortedatum')?.kind).toBe('date');
  expect(field(report, 'Gewenste afspraak')?.kind).toBe('datetime');
  expect(field(report, 'Aantal medewerkers')).toMatchObject({ kind: 'number', constraints: { min: '1', max: '500' } });
  expect(field(report, 'Nieuwsbrief')).toMatchObject({ kind: 'toggle', value: false });
  expect(field(report, 'Ik ga akkoord met de voorwaarden')).toMatchObject({ kind: 'checkbox', required: true });

  // Conditional fields are hidden, and fields outside the flow are never part of the inventory.
  const labels = screen.fields.map((f) => f.label);
  expect(labels).not.toContain('Bedrijfsnaam');
  expect(labels).not.toContain('Zoeken in Salesforce');
  expect(labels).not.toContain('Notities');

  expect(screen.inaccessible.join()).toContain('<acme-rating> "Tevredenheid"');
  const acme = screen.components.find((c) => c.namespace === 'acme');
  expect(acme?.tags).toContain('acme-rating');
  expect(report.issues.map((i) => i.message).join('\n')).toContain('niet verifieerbaar');

  await expect(page.getByRole('heading', { name: 'Aanvrager' })).toBeVisible();
  await expect(page.getByLabel('Voornaam')).toHaveValue('');
  await expect(page.getByRole('radio', { name: 'Zakelijk' })).not.toBeChecked();
});

test('inspect herkent uploadcomponenten en hun zichtbare beperkingen zonder te uploaden', async ({ page }, testInfo) => {
  const report = await run(page, demoScenario('demo-positief', { urlParameters: { step: '3' } }), 'inspect', testInfo);
  const uploads = report.screens[0].uploads;

  expect(uploads.find((u) => u.label === 'Identiteitsbewijs')).toMatchObject({
    via: 'input', accept: '.pdf,.png,.jpg', multiple: false, maxBytes: 100 * 1024, existingFiles: [],
  });
  expect(uploads.find((u) => u.label === 'Bijlagen')).toMatchObject({ via: 'input', multiple: true, maxFiles: 3, maxBytes: 100 * 1024 });
  expect(uploads.find((u) => u.label === 'Aanvullend document')).toMatchObject({ via: 'button', buttonName: 'Bestand kiezen', multiple: null });

  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(report.uploads).toEqual([]);
  expect(report.actions).toEqual([]);
});

test('inspect toont opties van picklists, checkboxgroepen en multiselects', async ({ page }, testInfo) => {
  const report = await run(page, demoScenario('demo-positief', { urlParameters: { step: '2' } }), 'inspect', testInfo);

  expect(field(report, 'Land')).toMatchObject({ kind: 'picklist', variant: 'select', options: ['--Geen--', 'Nederland', 'België'] });
  expect(field(report, 'Provincie')).toMatchObject({ kind: 'picklist', editable: false });
  expect(field(report, 'Interesses')).toMatchObject({ kind: 'checkboxGroup', required: true, options: ['Advies', 'Financiering', 'Training'] });
  expect(field(report, 'Talen')).toMatchObject({ kind: 'multiselect', options: ['Nederlands', 'Engels', 'Frans', 'Duits'] });
  expect(field(report, 'Product')).toMatchObject({ kind: 'picklist', variant: 'combobox', optionsNote: 'opties worden pas na openen geladen' });
  expect(field(report, 'Account')).toMatchObject({ kind: 'lookup', required: true });
  expect(field(report, 'Toelichting')).toMatchObject({ kind: 'textarea', component: 'c-notes-panel' });
  expect(report.screens[0].components.find((c) => c.namespace === 'c')?.tags).toEqual(['c-notes-panel']);
});
