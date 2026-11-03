import { readFile } from 'node:fs/promises';

import { CookieJar } from '../lib/cookies.js';
import { CliError } from '../lib/errors.js';
import { notCaptured } from '../lib/not-captured.js';
import { paceRequest } from '../lib/rate-limit.js';
import { loadState } from '../lib/state.js';

const FEE_BASE_URL = (process.env.JNU_PAY_BASE_URL || 'https://fee.jnu.edu.cn/client/api').replace(/\/+$/, '');
const FEE_LOGIN_HINT = 'The real fee.jnu.edu.cn payment hall interface has not been captured yet.';

export async function listUnpaidFees({ raw = false } = {}) {
  if (process.env.JNU_BACKEND === 'mock') {
    if (process.env.JNU_MOCK_LOGGED_OUT === '1') {
      throw new CliError('LOGIN_REQUIRED', 'Mock pay session is logged out.', { hint: FEE_LOGIN_HINT });
    }
    const file = process.env.JNU_MOCK_FILE;
    const table = file ? JSON.parse(await readFile(file, 'utf8')) : {};
    const payload = table['PAY GET /client/necessary/list'];
    if (!payload) {
      throw new CliError('UPSTREAM_ERROR', 'No mock pay fixture for PAY GET /client/necessary/list');
    }
    const list = Array.isArray(payload.data) ? payload.data : [];
    return {
      count: list.length,
      items: list,
      ...(raw ? { raw: payload } : {})
    };
  }

  if (process.env.JNU_ENDPOINTS_CAPTURED !== '1') {
    throw notCaptured('fee.jnu.edu.cn payment hall');
  }
  const session = await loadState();
  if (!session?.cookies?.length) {
    throw new CliError('LOGIN_REQUIRED', 'JNU payment hall session is missing.', { hint: FEE_LOGIN_HINT });
  }

  await paceRequest('pay', 400);
  const jar = new CookieJar(session.cookies);
  const url = `${FEE_BASE_URL}/client/necessary/list`;
  const cookieHeader = jar.header(url);
  const res = await fetch(url, {
    headers: {
      Accept: 'application/json, text/plain, */*',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) jnu-cli/0.3',
      ...(cookieHeader ? { Cookie: cookieHeader } : {})
    },
    redirect: 'manual',
    signal: AbortSignal.timeout(15000)
  });

  if (res.status === 401 || res.status === 403 || (res.status >= 300 && res.status < 400)) {
    throw new CliError('LOGIN_REQUIRED', 'JNU payment hall (fee.jnu.edu.cn) session expired.', {
      hint: FEE_LOGIN_HINT
    });
  }

  const payload = await res.json().catch(() => null);
  if (!payload || payload.code === 401 || payload.state === 401) {
    throw new CliError('LOGIN_REQUIRED', payload?.message || 'JNU payment hall login required.', {
      hint: FEE_LOGIN_HINT
    });
  }

  const items = Array.isArray(payload?.data) ? payload.data : (Array.isArray(payload?.result) ? payload.result : []);
  return {
    count: items.length,
    items,
    ...(raw ? { raw: payload } : {})
  };
}
