import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { expect, test } from '@playwright/test';
import { demoDocuments, root } from './helpers.js';

const exec = promisify(execFile);

function scenarioFile(dir: string, overrides: Record<string, unknown>) {
  const raw = JSON.parse(readFileSync(path.join(root, 'demo', 'scenarios', 'demo-positief.json'), 'utf8'));
  const file = path.join(dir, 'scenario.json');
  writeFileSync(file, JSON.stringify({
    ...raw,
    documentsDirectory: demoDocuments,
    browser: { profileDirectory: path.join(dir, 'profiel'), executablePath: process.env.FLOW_TESTER_CHROMIUM },
    reporting: { directory: path.join(dir, 'rapporten') },
    ...overrides,
  }));
  return file;
}

async function cli(...args: string[]) {
  return exec(process.execPath, [path.join(root, 'dist', 'src', 'cli.js'), ...args], { cwd: root }).then(
    (r) => ({ code: 0, ...r }),
    (e) => ({ code: e.code as number, stdout: e.stdout as string, stderr: e.stderr as string }),
  );
}

test('run via de CLI hergebruikt de bewaarde sessie en schrijft HTML, JSON, screenshots en een trace', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'flowtester-cli-'));
  mkdirSync(path.join(dir, 'profiel'));
  // Stands in for an earlier manual login: the session cookie that closeBrowser() keeps in the profile.
  writeFileSync(path.join(dir, 'profiel', 'flowtester-session.json'), JSON.stringify([
    { name: 'demo_session', value: '1', domain: 'localhost', path: '/', expires: -1, httpOnly: false, secure: false, sameSite: 'Lax' },
  ]));

  const result = await cli('run', scenarioFile(dir, {}), '--headless');
  const [runDir] = readdirSync(path.join(dir, 'rapporten')).filter((d) => d.endsWith('-run'));
  const reportDir = path.join(dir, 'rapporten', runDir);
  const report = JSON.parse(readFileSync(path.join(reportDir, 'report.json'), 'utf8'));

  expect(result.stdout).toContain('LET OP: run is geen dry run');
  expect(report.status, result.stdout).toBe('geslaagd');
  expect(result.code).toBe(0);
  expect(existsSync(path.join(reportDir, 'report.html'))).toBe(true);
  expect(existsSync(path.join(reportDir, 'trace.zip'))).toBe(true);
  expect(existsSync(path.join(reportDir, 'screenshots', 'stap-01.png'))).toBe(true);
  expect(readFileSync(path.join(reportDir, 'report.html'), 'utf8')).toContain('screenshots en de Playwright-trace');
  expect(JSON.stringify(report)).not.toContain('Jansen');
});

test('zonder geldige sessie wacht de CLI op login en stopt na de time-out', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'flowtester-cli-'));
  const result = await cli('inspect', scenarioFile(dir, { timeouts: { loginMs: 3000 } }), '--headless');

  expect(result.code).toBe(1);
  expect(result.stdout).toContain('Log handmatig in in het browservenster');
  expect(result.stdout).toContain('Geen login binnen');
  expect(existsSync(path.join(dir, 'profiel', 'flowtester-session.json'))).toBe(true);
});

test('run zonder toegestane org stopt voordat de browser start', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'flowtester-cli-'));
  const result = await cli('run', scenarioFile(dir, { allowedOrgUrls: [] }), '--headless');
  expect(result.code).toBe(2);
  expect(result.stderr).toContain('Run geweigerd');
  expect(existsSync(path.join(dir, 'profiel'))).toBe(false);
});
