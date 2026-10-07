#!/usr/bin/env node
import path from 'node:path';
import { closeBrowser, ensureLoggedIn, launchBrowser } from './browser.js';
import { ConfigError, loadScenario, resolveStartUrl } from './config.js';
import { createReport, writeReport } from './report.js';
import { AllowedOrgError, assertRunAllowed, runFlow } from './runner.js';

const usage = `Gebruik:
  node dist/src/cli.js login   <scenario.json>   Inloggen en sessie bewaren in het testprofiel
  node dist/src/cli.js inspect <scenario.json>   Velden en uploadcomponenten inventariseren (wijzigt niets)
  node dist/src/cli.js run     <scenario.json>   Flow invullen, documenten uploaden en doorlopen

Opties:
  --headless   Zonder zichtbaar venster (alleen voor de lokale demo; niet voor Salesforce-login)`;

const log = (message: string) => console.log(`[${new Date().toLocaleTimeString('nl-NL')}] ${message}`);

async function main(argv: string[]): Promise<number> {
  const [command, file] = argv.filter((a) => !a.startsWith('--'));
  const headless = argv.includes('--headless');
  if (!command || !file || !['login', 'inspect', 'run'].includes(command)) {
    console.log(usage);
    return 2;
  }
  const scenario = await loadScenario(file);
  const target = resolveStartUrl(scenario);
  if (command === 'run') {
    assertRunAllowed(scenario);
    log(`LET OP: run is geen dry run. Knoppen en uploads kunnen gegevens opslaan in ${target.origin}.`);
    log(`Finish/Voltooien aanklikken: ${scenario.allowFinish ? 'ja' : 'nee'}`);
  }

  const context = await launchBrowser(scenario, { headless });
  const page = context.pages()[0] ?? (await context.newPage());

  if (command === 'login') {
    try {
      await page.goto(target.href, { timeout: scenario.timeouts.navigationMs });
      await ensureLoggedIn(page, scenario, target, log);
      log(`Ingelogd. De sessie staat in ${scenario.browser.profileDirectory}.`);
    } finally {
      await closeBrowser(context, scenario);
    }
    return 0;
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const slug = scenario.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
  const directory = path.join(scenario.reporting.directory, `${stamp}-${slug}-${command}`);
  const report = createReport(scenario, command as 'inspect' | 'run', `${target.origin}${target.pathname}`, directory);

  await context.tracing.start({ screenshots: true, snapshots: true, title: scenario.name });
  try {
    await runFlow(page, scenario, report, { mode: command as 'inspect' | 'run', log });
  } catch (error) {
    report.issues.push({ severity: 'fout', subject: 'uitvoering', message: (error as Error).message });
    report.status = 'mislukt';
    report.statusReason = (error as Error).message;
    await page.screenshot({ path: path.join(directory, 'screenshots', 'fout.png'), fullPage: true }).then(
      () => report.artifacts.screenshots.push('screenshots/fout.png'),
      () => undefined,
    );
  } finally {
    const trace = path.join(directory, 'trace.zip');
    await context.tracing.stop({ path: trace }).then(() => (report.artifacts.trace = trace), () => undefined);
    await closeBrowser(context, scenario).catch(() => undefined);
  }

  const files = await writeReport(report, scenario);
  log(`Resultaat: ${report.status.toUpperCase()}${report.statusReason ? ` — ${report.statusReason}` : ''}`);
  log(`Rapport: ${files.html}`);
  log('Screenshots en trace kunnen persoonsgegevens bevatten; de waarden in de tekstrapporten zijn gemaskeerd.');
  return report.status === 'geslaagd' || report.status === 'inventarisatie' ? 0 : 1;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error) => {
    if (error instanceof ConfigError || error instanceof AllowedOrgError) {
      console.error(error.message);
      process.exit(2);
    }
    console.error(error);
    process.exit(1);
  },
);
