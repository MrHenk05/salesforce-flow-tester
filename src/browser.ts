import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium, type BrowserContext, type Cookie, type Page } from 'playwright';
import { ConfigError, type Scenario } from './config.js';

export async function launchBrowser(scenario: Scenario, opts: { headless?: boolean } = {}): Promise<BrowserContext> {
  const profile = scenario.browser.profileDirectory;
  if (/[\\/]microsoft[\\/]edge[\\/]user data/i.test(profile) || /[\\/]google[\\/]chrome[\\/]user data/i.test(profile)) {
    throw new ConfigError(`browser.profileDirectory wijst naar een normaal browserprofiel (${profile}). Gebruik een aparte map.`);
  }
  await mkdir(profile, { recursive: true });
  await disablePasswordSaving(profile);
  const executablePath = scenario.browser.executablePath;
  const context = await chromium.launchPersistentContext(profile, {
    channel: executablePath ? undefined : scenario.browser.channel,
    executablePath,
    headless: opts.headless ?? false,
    viewport: null,
    args: opts.headless ? [] : ['--start-maximized'],
  });
  await restoreCookies(context, profile);
  return context;
}

// Salesforce uses browser-session cookies, which Chromium drops on close. Keep them in the
// test profile so the next run can reuse the login until Salesforce expires the session.
const cookieFile = (profile: string) => path.join(profile, 'flowtester-session.json');

async function restoreCookies(context: BrowserContext, profile: string) {
  let cookies: Cookie[];
  try {
    cookies = JSON.parse(await readFile(cookieFile(profile), 'utf8'));
  } catch {
    return;
  }
  const now = Date.now() / 1000;
  await context.addCookies(cookies.filter((c) => c.expires === -1 || c.expires > now));
}

export async function closeBrowser(context: BrowserContext, scenario: Scenario): Promise<void> {
  try {
    await writeFile(cookieFile(scenario.browser.profileDirectory), JSON.stringify(await context.cookies()), { mode: 0o600 });
  } finally {
    await context.close().catch(() => undefined);
  }
}

// The tester never stores passwords; also keep the browser's own password manager out of this profile.
async function disablePasswordSaving(profile: string) {
  const file = path.join(profile, 'Default', 'Preferences');
  let prefs: Record<string, any> = {};
  try {
    prefs = JSON.parse(await readFile(file, 'utf8'));
  } catch {
    // New profile.
  }
  if (prefs.credentials_enable_service === false && prefs.profile?.password_manager_enabled === false) return;
  prefs.credentials_enable_service = false;
  prefs.profile = { ...prefs.profile, password_manager_enabled: false };
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(prefs));
}

const loginHosts = /^(login|test)\.salesforce\.com$/i;
const loginPaths = /^\/(secur\/|_ui\/identity\/|login)/i;
const sessionEnded = /session (has )?(expired|ended)|sessie is verlopen|sessie (is )?beëindigd/i;

export async function isLoginPage(page: Page): Promise<boolean> {
  let url: URL;
  try {
    url = new URL(page.url());
  } catch {
    return false;
  }
  if (loginHosts.test(url.hostname) || loginPaths.test(url.pathname)) return true;
  if (await page.locator('form#login_form').visible().count()) return true;
  const dialog = page.getByRole('dialog').or(page.getByRole('alertdialog')).filter({ hasText: sessionEnded }).visible();
  return (await dialog.count()) > 0;
}

/**
 * Waits for the user to log in by hand (including MFA) when the page shows a login screen or an
 * expired-session dialog, then reopens the target URL. Credentials are never touched.
 */
export async function ensureLoggedIn(page: Page, scenario: Scenario, target: URL, log: (msg: string) => void): Promise<void> {
  if (!(await isLoginPage(page))) return;
  const ms = scenario.timeouts.loginMs;
  const duration = ms < 120_000 ? `${Math.round(ms / 1000)} seconden` : `${Math.round(ms / 60_000)} minuten`;
  log(`Niet ingelogd of sessie verlopen. Log handmatig in in het browservenster (inclusief MFA). Ik wacht maximaal ${duration}.`);
  const deadline = Date.now() + scenario.timeouts.loginMs;
  while (Date.now() < deadline) {
    await page.waitForTimeout(2000);
    if (await isLoginPage(page)) continue;
    const origin = safeOrigin(page.url());
    if (!origin || origin === 'null') continue;
    log('Login gedetecteerd; de sessie wordt in het aparte testprofiel bewaard.');
    await page.goto(target.href, { timeout: scenario.timeouts.navigationMs });
    if (!(await isLoginPage(page))) return;
  }
  throw new Error(`Geen login binnen ${duration}; uitvoering afgebroken.`);
}

function safeOrigin(url: string): string | undefined {
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}
