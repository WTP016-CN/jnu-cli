import { rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { launchProfile } from '../lib/browser.js';
import { CliError, LOGIN_HINT } from '../lib/errors.js';
import {
  JWXT_LOGIN_URL,
  JWXT_ORIGIN,
  JWXT_USER_INFO_PATH,
  createClient
} from '../lib/jwxt.js';
import { profilesDir, statePath } from '../lib/paths.js';
import { deleteState, loadState, saveState } from '../lib/state.js';

export const CAS_ENTRY_URL = JWXT_LOGIN_URL;
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;
const REFRESH_TIMEOUT_MS = 25 * 1000;

/**
 * Open a headed browser on the JWXT entry. The SPA redirects to JNU ICAS/auth4;
 * the user completes login themselves. We only wait until JWXT reports a
 * session and then export cookies. Passwords and captchas never pass through
 * jnu-cli.
 */
export async function login({ browser, timeoutMs = LOGIN_TIMEOUT_MS } = {}) {
  if (process.env.JNU_BACKEND === 'mock') {
    return { loggedIn: true, browser: 'mock', statePath: statePath(), backend: 'mock' };
  }
  const launched = await launchProfile({ browser, headless: false });
  const { context } = launched;
  process.stderr.write(`Opened ${launched.browser.label}. Finish JNU unified-auth login in the window (timeout ${Math.round(timeoutMs / 1000)}s).\n`);
  try {
    const page = context.pages()[0] ?? await context.newPage();
    await page.goto(CAS_ENTRY_URL, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    const outcome = await waitForSession(context, page, timeoutMs);
    if (outcome === 'closed') {
      throw new CliError('AUTH_LOGIN_INCOMPLETE', 'The browser was closed before JWXT reported a logged-in session.', {
        hint: 'Run `jnu-cli auth login` again and keep the window open until it closes by itself.'
      });
    }
    if (outcome === 'timeout') {
      throw new CliError('AUTH_LOGIN_TIMEOUT', `Login did not finish within ${Math.round(timeoutMs / 1000)} seconds.`, {
        hint: 'Run `jnu-cli auth login` again (use `--timeout <seconds>` for more time).'
      });
    }
    const saved = await exportSession(context, launched.browser.id);
    return {
      loggedIn: true,
      browser: launched.browser.id,
      statePath: saved.file,
      cookieCount: saved.count
    };
  } finally {
    await context.close().catch(() => {});
  }
}

/**
 * Re-enter JWXT through CAS in a headless browser using the persistent
 * profile. This succeeds only while the unified-auth (CAS) session in the
 * profile is still valid; it never fills credentials.
 */
export async function refresh({ browser } = {}) {
  if (process.env.JNU_BACKEND === 'mock') {
    return { loggedIn: true, refreshed: true, backend: 'mock' };
  }
  const launched = await launchProfile({ browser, headless: true });
  const { context } = launched;
  try {
    const page = context.pages()[0] ?? await context.newPage();
    await page.goto(CAS_ENTRY_URL, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    const outcome = await waitForSession(context, page, REFRESH_TIMEOUT_MS);
    if (outcome !== 'authenticated') {
      throw new CliError('LOGIN_REQUIRED', 'The saved unified-auth session has expired; interactive login is needed.', {
        hint: 'Run `jnu-cli auth login` and complete login in the opened browser.',
        details: { finalHost: safeHost(page.url()) }
      });
    }
    const saved = await exportSession(context, launched.browser.id);
    return {
      loggedIn: true,
      refreshed: true,
      browser: launched.browser.id,
      cookieCount: saved.count
    };
  } finally {
    await context.close().catch(() => {});
  }
}

export async function status() {
  const state = process.env.JNU_BACKEND === 'mock'
    ? { savedAt: null }
    : await loadState();
  if (!state) {
    return { loggedIn: false, reason: 'session-missing', statePath: statePath(), hint: LOGIN_HINT };
  }
  const client = await createClient();
  if (!client.hasSession()) {
    return { loggedIn: false, reason: 'session-missing', statePath: statePath(), hint: LOGIN_HINT };
  }
  try {
    const result = await client.loginStatus();
    return {
      loggedIn: result.loggedIn,
      reason: result.loggedIn ? 'jwxt-session-active' : 'jwxt-session-expired',
      ...(state.savedAt ? { savedAt: state.savedAt } : {}),
      ...(result.userId ? { userId: result.userId } : {}),
      ...(result.userName ? { userName: result.userName } : {}),
      ...(result.loggedIn ? {} : { hint: LOGIN_HINT })
    };
  } finally {
    await client.persist().catch(() => {});
  }
}

export async function logout() {
  const hadState = Boolean(await loadState());
  await deleteState();
  const silabState = join(dirname(statePath()), 'silab-session.json');
  await rm(silabState, { force: true }).catch(() => {});
  try {
    await rm(profilesDir(), { recursive: true, force: true });
  } catch (cause) {
    throw new CliError('AUTH_LOGOUT_FAILED', 'Could not remove the jnu-cli browser profiles.', {
      hint: 'Close any jnu-cli browser window and retry `jnu-cli auth logout`.',
      cause
    });
  }
  return { loggedOut: true, hadSession: hadState };
}

async function waitForSession(context, page, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let closed = false;
  context.once('close', () => { closed = true; });

  while (Date.now() < deadline) {
    if (closed || page.isClosed()) return 'closed';
    // Only probe once the browser is back on JWXT, so we never interfere with
    // the CAS page or its captcha.
    if (safeHost(page.url()) === new URL(JWXT_ORIGIN).host) {
      try {
        const response = await context.request.get(`${JWXT_ORIGIN}${JWXT_USER_INFO_PATH}?_t=${Date.now()}`, {
          headers: { 'X-Requested-With': 'XMLHttpRequest', Accept: 'application/json' },
          maxRedirects: 0,
          timeout: 10000
        });
        if (response.ok()) {
          const json = await response.json().catch(() => null);
          if (json?.hasLogin === true) return 'authenticated';
        }
      } catch {
        // keep waiting
      }
    }
    await sleep(1500);
  }
  return 'timeout';
}

async function exportSession(context, browserId) {
  const storage = await context.storageState();
  const cookies = storage.cookies.filter((cookie) => /(^|\.)jnu\.edu\.cn$/i.test(cookie.domain.replace(/^\./, '')));
  const file = await saveState({ browser: browserId, savedAt: new Date().toISOString(), cookies, origins: [] });
  return { file, count: cookies.length };
}

function safeHost(url) {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
