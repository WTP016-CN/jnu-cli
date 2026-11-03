import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';

import { JWXT_STATUS_PATH, JWXT_USER_INFO_PATH } from '../lib/jwxt.js';
import { cliHome, statePath } from '../lib/paths.js';

const require = createRequire(import.meta.url);

export async function doctor({ offline = false } = {}) {
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  const checks = {
    node: { ok: nodeMajor >= 20, version: process.versions.node, required: '>=20' },
    playwright: checkPlaywright(),
    session: { ok: existsSync(statePath()), path: statePath() },
    home: cliHome()
  };
  if (!offline && process.env.JNU_BACKEND !== 'mock') {
    checks.network = await checkNetwork();
  }
  const ready = checks.node.ok && checks.playwright.ok && (checks.network?.ok ?? true);
  const next = [];
  if (!checks.playwright.ok) next.push('Reinstall jnu-cli so the playwright dependency is available.');
  if (checks.network && !checks.network.ok) next.push('Connect to the campus network or JNU VPN, then rerun `jnu-cli doctor`.');
  if (!checks.session.ok) next.push('Run `jnu-cli auth login`.');
  return { ready, checks, next };
}

function checkPlaywright() {
  try {
    const pkg = require('playwright/package.json');
    let bundledChromium = false;
    try {
      bundledChromium = existsSync(require('playwright').chromium.executablePath());
    } catch {
      bundledChromium = false;
    }
    return { ok: true, version: pkg.version, bundledChromium };
  } catch {
    return { ok: false };
  }
}

async function checkNetwork() {
  const started = Date.now();
  try {
    const response = await fetch(`https://jw.jnu.edu.cn${JWXT_USER_INFO_PATH}?type=&_t=${Date.now()}`, {
      headers: {
        Accept: 'application/json, text/plain, */*',
        Referer: 'https://jw.jnu.edu.cn/new/index.html',
        'X-Requested-With': 'XMLHttpRequest'
      },
      redirect: 'manual',
      signal: AbortSignal.timeout(8000)
    });
    const chain = [JWXT_STATUS_PATH, JWXT_USER_INFO_PATH];
    return {
      ok: response.status < 500,
      status: response.status,
      endpoint: JWXT_USER_INFO_PATH,
      verifiedEndpoints: chain,
      latencyMs: Date.now() - started
    };
  } catch (error) {
    return { ok: false, error: String(error?.cause?.code ?? error?.message ?? error) };
  }
}
