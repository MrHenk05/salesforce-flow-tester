import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { Page, TestInfo } from '@playwright/test';
import { parseScenario, type Scenario } from '../src/config.js';
import { createReport, type RunReport } from '../src/report.js';
import { runFlow } from '../src/runner.js';

export const root = path.resolve(import.meta.dirname, '..');
export const demoDocuments = path.join(root, 'demo', 'documents');
export const baseURL = 'http://localhost:4173';

export function demoScenario(name: string, overrides: Record<string, unknown> = {}): Scenario {
  const file = path.join(root, 'demo', 'scenarios', `${name}.json`);
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  return parseScenario({ ...raw, ...overrides }, { baseDir: path.dirname(file), cwd: root, file });
}

export async function login(page: Page) {
  await page.context().addCookies([{ name: 'demo_session', value: '1', url: baseURL }]);
}

export async function run(page: Page, scenario: Scenario, mode: 'inspect' | 'run', testInfo: TestInfo): Promise<RunReport> {
  const report = createReport(scenario, mode, scenario.startUrl, testInfo.outputPath('report'));
  await runFlow(page, scenario, report, { mode });
  return report;
}

export const field = (report: RunReport, label: string, step = 1, occurrence = 1) =>
  report.screens.find((s) => s.step === step)?.fields.find((f) => f.label === label && f.occurrence === occurrence);
