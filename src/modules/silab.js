import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { launchProfile } from '../lib/browser.js';
import { CliError } from '../lib/errors.js';

export const SILAB_URL = 'https://silab.jnu.edu.cn';

const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;
const SILAB_HOST = 'silab.jnu.edu.cn';

/**
 * Open SILab and save cookies after the user finishes login and closes the
 * browser. No credentials are read or submitted by jnu-cli.
 */
export async function login({ browser, timeoutMs = LOGIN_TIMEOUT_MS } = {}) {
  if (isMockMode()) {
    return {
      saved: true,
      browser: 'mock',
      cookieCount: 1,
      savedAt: new Date().toISOString(),
      statePath: silabStatePath(),
      backend: 'mock',
      note: 'Mock mode: no browser was launched and no session file was written.'
    };
  }

  const statePath = silabStatePath();
  const existing = await loadSilabState();
  const launched = await launchProfile({
    browser: browser ?? process.env.JNU_BROWSER ?? existing?.browser,
    headless: false
  });
  const { context } = launched;
  let closed = false;
  let cookies = [];

  context.once('close', () => {
    closed = true;
  });

  process.stderr.write(
    `Opened ${launched.browser.label}. Complete the JNU SILab login in the window, ` +
    `then close it to save the session (timeout ${Math.round(timeoutMs / 1000)}s).\n`
  );

  try {
    const page = context.pages()[0] ?? await context.newPage();
    await page.goto(SILAB_URL, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    const deadline = Date.now() + timeoutMs;
    while (!closed && Date.now() < deadline) {
      cookies = mergeCookies(cookies, await readSilabCookies(context));
      if (!closed) await sleep(1000);
    }
    if (!closed) {
      throw new CliError(
        'AUTH_LOGIN_TIMEOUT',
        `SILab login did not finish within ${Math.round(timeoutMs / 1000)} seconds.`,
        {
          hint: 'Run `jnu-cli silab login` again (use `--timeout <seconds>` for more time).'
        }
      );
    }
  } finally {
    await context.close().catch(() => {});
  }

  if (cookies.length === 0) {
    throw new CliError(
      'AUTH_LOGIN_INCOMPLETE',
      'The SILab browser was closed before any applicable cookies were set.',
      {
        hint: 'Run `jnu-cli silab login` again and finish the JNU unified-auth login in the browser.'
      }
    );
  }

  const savedAt = new Date().toISOString();
  await saveSilabState({
    version: 1,
    savedAt,
    browser: launched.browser.id,
    cookies,
    origins: []
  });

  return {
    saved: true,
    browser: launched.browser.id,
    cookieCount: cookies.length,
    savedAt,
    statePath,
    note: 'SILab authentication was not probed; `silab status` reports whether cookies were saved.'
  };
}

/**
 * Check only the locally saved SILab cookie state. This deliberately makes no
 * network request because the real SILab status endpoint is not yet captured.
 */
export async function status() {
  const statePath = silabStatePath();
  if (isMockMode()) {
    const state = await loadSilabState();
    const cookieCount = Array.isArray(state?.cookies) ? state.cookies.length : 0;
    return {
      status: cookieCount > 0 ? 'saved' : 'empty',
      hasCookies: cookieCount > 0,
      cookieCount,
      statePath,
      backend: 'mock',
      ...(state?.savedAt ? { savedAt: state.savedAt } : {}),
      ...(cookieCount > 0 ? {} : { hint: 'Run `jnu-cli silab login`.' })
    };
  }

  const state = await loadSilabState();
  const cookieCount = Array.isArray(state?.cookies) ? state.cookies.length : 0;
  if (cookieCount === 0) {
    return {
      status: 'empty',
      hasCookies: false,
      cookieCount: 0,
      statePath,
      hint: 'Run `jnu-cli silab login`.'
    };
  }
  return {
    status: 'saved',
    hasCookies: true,
    cookieCount,
    statePath,
    ...(state.savedAt ? { savedAt: state.savedAt } : {}),
    ...(state.browser ? { browser: state.browser } : {})
  };
}

export function silabStatePath() {
  return join(jnuCliHome(), 'silab-session.json');
}

async function loadSilabState() {
  try {
    const state = JSON.parse(await readFile(silabStatePath(), 'utf8'));
    return state && Array.isArray(state.cookies) ? state : null;
  } catch {
    return null;
  }
}

async function saveSilabState(state) {
  const file = silabStatePath();
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(state, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600
  });
  return file;
}

async function readSilabCookies(context) {
  try {
    return (await context.cookies()).filter(cookieAppliesToSilab);
  } catch {
    return [];
  }
}

function mergeCookies(previous, current) {
  const merged = new Map();
  for (const cookie of [...previous, ...current]) {
    merged.set(`${cookie.domain}\n${cookie.path ?? '/'}\n${cookie.name}`, cookie);
  }
  return [...merged.values()];
}

function cookieAppliesToSilab(cookie) {
  const domain = String(cookie?.domain ?? '').replace(/^\./, '').toLowerCase();
  if (!domain) return false;
  if (domain === SILAB_HOST) return true;
  return String(cookie.domain).startsWith('.') && SILAB_HOST.endsWith(`.${domain}`);
}

function jnuCliHome() {
  return process.env.JNU_CLI_HOME || join(homedir(), '.jnu-cli');
}

function isMockMode() {
  return process.env.JNU_BACKEND === 'mock';
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}
