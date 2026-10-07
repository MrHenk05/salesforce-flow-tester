import type { Locator } from 'playwright';
import type { Scenario } from './config.js';
import type { DocumentFile, Selection, UploadConstraints } from './documents.js';
import { scanScreen, uploadLabelOf, type ScannedUpload } from './scan.js';

export type UploadOutcome = 'geüpload' | 'fout' | 'onzeker' | 'geblokkeerd' | 'overgeslagen';

export interface UploadAttempt {
  outcome: UploadOutcome;
  message?: string;
  files: DocumentFile[];
  notes: string[];
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Hands the chosen files to the component and waits for observable proof of completion. Never
 * retries: when the result is unclear the upload is reported as uncertain to avoid duplicate records.
 */
export async function uploadFiles(
  scope: Locator,
  frameRoot: Locator,
  upload: ScannedUpload,
  scenario: Scenario,
  choose: (constraints: UploadConstraints) => Promise<Selection>,
): Promise<UploadAttempt> {
  const { actionMs, uploadMs } = scenario.timeouts;
  const visible = { maxBytes: upload.maxBytes, maxFiles: upload.maxFiles };
  let files: DocumentFile[];
  let notes: string[];
  const blocked = (message: string): UploadAttempt => ({ outcome: 'geblokkeerd', message, files: [], notes: [] });

  if (upload.via === 'input') {
    const input = scope.locator('input[type="file"]').nth(upload.inputIndex!);
    if ((await input.count()) !== 1 || (await uploadLabelOf(input)) !== upload.label) {
      return blocked('uploadcomponent is veranderd sinds het scannen; niet geüpload');
    }
    const selection = await choose({ accept: upload.accept, multiple: upload.multiple, ...visible });
    if (!selection.ok) return blocked(selection.reason);
    ({ files, notes } = selection);
    await input.setInputFiles(files.map((f) => f.path), { timeout: actionMs });
  } else {
    const button = scope.getByRole('button', { name: upload.buttonName!, exact: true });
    if ((await button.count()) !== 1) return blocked(`uploadknop "${upload.buttonName}" niet eenduidig`);
    const chooserPromise = scope.page().waitForEvent('filechooser', { timeout: actionMs });
    await button.click({ timeout: actionMs });
    const chooser = await chooserPromise.catch(() => undefined);
    if (!chooser) return blocked('knop opende geen bestandskiezer');
    // The accept attribute is only known once the component has created its file input.
    const accept = await chooser.element().evaluate((el) => (el as HTMLInputElement).accept || undefined);
    const selection = await choose({ accept, multiple: chooser.isMultiple(), ...visible });
    if (!selection.ok) {
      await chooser.setFiles([]);
      return blocked(selection.reason);
    }
    ({ files, notes } = selection);
    await chooser.setFiles(files.map((f) => f.path), { timeout: actionMs });
  }

  const done = (outcome: UploadOutcome, message?: string): UploadAttempt => ({ outcome, message, files, notes });
  const names = files.map((f) => f.name);
  const namePattern = new RegExp(names.map(escape).join('|'));
  const success = scenario.uploadDialog.successPatterns.map((p) => new RegExp(p, 'i'));
  const failure = new RegExp(scenario.uploadDialog.errorPatterns.join('|'), 'i');
  const withoutNames = (text: string) => text.replace(new RegExp(namePattern, 'g'), '');
  // Only a dialog that shows our own file names counts as "the" upload dialog of this component.
  const dialog = frameRoot.getByRole('dialog').or(frameRoot.getByRole('alertdialog')).filter({ hasText: namePattern }).visible();

  const deadline = Date.now() + uploadMs;
  while (Date.now() < deadline) {
    const dialogs = await dialog.count();
    if (dialogs > 1) return done('onzeker', 'meerdere uploadvensters tegelijk zichtbaar');
    if (dialogs === 1) {
      const text = (await dialog.innerText()).replace(/\s+/g, ' ').trim();
      if (failure.test(withoutNames(text))) {
        await confirmDialog(dialog, scenario).catch(() => undefined);
        return done('fout', text);
      }
      if (success.some((re) => re.test(text))) {
        const confirmed = await confirmDialog(dialog, scenario);
        return confirmed ? done('geüpload', text) : done('onzeker', `upload gemeld maar uploadvenster sluit niet: ${text}`);
      }
    } else {
      const current = (await scanScreen(scope)).uploads.find((u) => u.key === upload.key);
      const newErrors = current?.errors.filter((e) => !upload.errors.includes(e)) ?? [];
      if (newErrors.length) return done('fout', newErrors.join(' | '));
      if (current && names.every((n) => current.existingFiles.includes(n))) {
        return done('geüpload', 'bestandsnamen zichtbaar in het uploadcomponent');
      }
    }
    await scope.page().waitForTimeout(300);
  }
  return done('onzeker', `geen bevestiging binnen ${Math.round(uploadMs / 1000)} s; upload niet herhaald`);
}

async function confirmDialog(dialog: Locator, scenario: Scenario): Promise<boolean> {
  for (const name of scenario.uploadDialog.confirmButtons) {
    const button = dialog.getByRole('button', { name, exact: true });
    if ((await button.count()) !== 1) continue;
    await button.click({ timeout: scenario.timeouts.uploadMs });
    await dialog.waitFor({ state: 'hidden', timeout: scenario.timeouts.actionMs }).catch(() => undefined);
    return !(await dialog.count());
  }
  return true;
}
