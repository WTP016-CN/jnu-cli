import { readFileSync } from 'node:fs';

import { CookieJar, readSetCookies } from './cookies.js';
import { CliError, loginRequired, upstreamChanged } from './errors.js';
import { notCaptured } from './not-captured.js';
import { paceRequest } from './rate-limit.js';
import { loadState, saveState } from './state.js';

export const JWXT_ORIGIN = 'https://jw.jnu.edu.cn';
export const JWXT_BASE = `${JWXT_ORIGIN}/jwapp`;
export const JWXT_LOGIN_URL = `${JWXT_ORIGIN}/new/index.html`;
export const JWXT_STATUS_PATH = '/jsonp/getCurrentLocale.json';
export const JWXT_USER_INFO_PATH = '/jsonp/userDesktopInfo.json';
const DEFAULT_TIMEOUT_MS = 20000;

/**
 * Thin JSON client for jw.jnu.edu.cn that replays the SPA's XHR conventions
 * using cookies captured by `jnu-cli auth login`. No browser is launched here.
 */
export class JwxtClient {
  constructor({ state, fetchImpl, persist = true } = {}) {
    this.state = state ?? null;
    this.jar = new CookieJar(state?.cookies ?? []);
    this.fetchImpl = fetchImpl ?? globalThis.fetch;
    this.persistEnabled = persist;
    this.requests = 0;
  }

  hasSession() {
    return this.jar.cookies.some((cookie) => /jnu\.edu\.cn$/i.test(cookie.domain.replace(/^\./, '')));
  }

  async loginStatus() {
    const options = { skipAuthCheck: true, skipCaptureGuard: true };
    const userInfo = await this.send('GET', JWXT_USER_INFO_PATH, { ...options, query: { type: '' } });
    const userJson = await parseStatusResponse(userInfo.response, JWXT_USER_INFO_PATH);
    if (userJson?.hasLogin === true) return loginResult(userJson);

    const { response } = await this.send('GET', JWXT_STATUS_PATH, options);
    return loginResult(await parseStatusResponse(response, JWXT_STATUS_PATH));
  }

  async get(path, { query, menuId, referer, allowAnyCode, skipCaptureGuard } = {}) {
    const json = await this.request('GET', path, {
      query,
      menuId,
      referer,
      allowAnyCode,
      skipCaptureGuard
    });
    return unwrapData(json);
  }

  async post(path, body, { query, menuId, referer, allowAnyCode, skipCaptureGuard } = {}) {
    const json = await this.request('POST', path, {
      query,
      body,
      menuId,
      referer,
      allowAnyCode,
      skipCaptureGuard
    });
    return unwrapData(json);
  }

  async postForm(path, form, { query, menuId, referer, skipCaptureGuard } = {}) {
    const json = await this.request('POST', path, {
      query,
      form,
      menuId,
      referer,
      skipCaptureGuard
    });
    return unwrapData(json);
  }

  async send(method, path, options = {}) {
    const url = buildUrl(path, options.query);
    if (!options.skipCaptureGuard) requireCapturedEndpoints();
    if (!options.skipAuthCheck && !this.hasSession()) {
      throw loginRequired('No saved JNU session was found.');
    }

    const headers = {
      'Accept': 'application/json, text/plain, */*',
      'X-Requested-With': 'XMLHttpRequest',
      'Referer': options.referer ?? JWXT_LOGIN_URL,
      'Origin': JWXT_ORIGIN,
      'moduleid': 'null',
      'menuid': options.menuId ?? 'null',
      'lastaccesstime': String(Date.now()),
      'User-Agent': 'Mozilla/5.0 (jnu-cli; +https://github.com/) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36'
    };
    const cookie = this.jar.header(url);
    if (cookie) headers.Cookie = cookie;
    let body;
    if (options.form !== undefined) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded; charset=UTF-8';
      body = new URLSearchParams(
        Object.entries(options.form)
          .filter(([, value]) => value !== undefined && value !== null)
          .map(([key, value]) => [key, String(value)])
      ).toString();
    } else if (options.body !== undefined) {
      headers['Content-Type'] = 'application/json;charset=UTF-8';
      body = JSON.stringify(options.body);
    }

    let response;
    try {
      await paceRequest('jwxt', 250);
      this.requests += 1;
      response = await this.fetchImpl(url, {
        method,
        headers,
        body,
        redirect: 'manual',
        signal: AbortSignal.timeout(Number(process.env.JNU_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS)
      });
    } catch (cause) {
      throw new CliError('NETWORK_ERROR', `Request to ${url.pathname} failed: ${cause?.message ?? cause}`, {
        hint: 'Check network access to jw.jnu.edu.cn (campus network or JNU VPN may be required), then retry once.',
        cause
      });
    }

    this.jar.store(url, readSetCookies(response.headers));
    return { url, response };
  }

  async request(method, path, options = {}) {
    const { url, response } = await this.send(method, path, options);
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location') ?? '';
      throw loginRequired('JWXT redirected to unified authentication.', { status: response.status, location: redactLocation(location) });
    }
    if (response.status === 401) {
      throw loginRequired('JWXT rejected the saved session (HTTP 401).');
    }
    if (response.status === 403) {
      throw new CliError('PERMISSION_DENIED', `JWXT returned HTTP 403 for ${url.pathname}.`, {
        hint: 'Confirm this account can open the same page in the JWXT web UI.'
      });
    }
    if (response.status === 429) {
      throw new CliError('RATE_LIMITED', 'JWXT rate-limited this client (HTTP 429).', {
        hint: 'Stop and wait several minutes before retrying. Do not loop.'
      });
    }

    const text = await response.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      if (/icas\.jnu\.edu\.cn|auth4\.jnu\.edu\.cn|统一身份认证/i.test(text)) {
        throw loginRequired('JWXT returned the unified-auth login page.');
      }
      throw upstreamChanged(`JWXT returned non-JSON content for ${url.pathname} (HTTP ${response.status}).`, {
        status: response.status,
        snippet: text.slice(0, 200)
      });
    }

    if (response.status >= 500) {
      throw new CliError('UPSTREAM_ERROR', `JWXT returned HTTP ${response.status} for ${url.pathname}.`, {
        hint: 'The school system may be busy or under maintenance. Retry later, once.',
        details: { status: response.status, upstreamCode: json?.code, upstreamMessage: json?.message }
      });
    }

    if (
      !options.allowAnyCode
      && json
      && typeof json === 'object'
      && 'code' in json
      && ![0, 200].includes(Number(json.code))
    ) {
      const message = String(json.message ?? json.msg ?? '');
      if (Number(json.code) === 401 || /未登录|登录超时|重新登录|token/i.test(message)) {
        throw loginRequired(`JWXT reported: ${message || `code ${json.code}`}`);
      }
      throw new CliError('UPSTREAM_ERROR', `JWXT returned code ${json.code} for ${url.pathname}: ${message || 'no message'}`, {
        hint: 'Verify the arguments (term format is YYYY-N, e.g. 2025-1 = 2025-2026 first semester). Retry at most once.',
        details: { upstreamCode: json.code, upstreamMessage: message }
      });
    }

    return json;
  }

  async persist() {
    if (!this.persistEnabled || !this.jar.dirty || !this.state) return;
    await saveState({ ...this.state, cookies: this.jar.toJSON() });
    this.jar.dirty = false;
  }
}

export const JNU_ENDPOINTS_CAPTURED = process.env.JNU_ENDPOINTS_CAPTURED === '1';

/**
 * Until authenticated JNU traffic is captured, real mode must not replay
 * guessed academic API paths against jw.jnu.edu.cn.
 */
export function requireCapturedEndpoints() {
  if (process.env.JNU_BACKEND === 'mock' || JNU_ENDPOINTS_CAPTURED) return;
  throw notCaptured('jw.jnu.edu.cn academic services');
}

export async function createClient() {
  if (process.env.JNU_BACKEND === 'mock') {
    return new JwxtClient({
      state: mockState(),
      fetchImpl: createMockFetch(),
      persist: false
    });
  }
  const state = await loadState();
  return new JwxtClient({ state });
}

export const STUDENT_ROLE_ID = '20200716150916600';
const JWXT_APPS = ['cjcx', 'wdkb'];

/**
 * JNU's academic endpoints return HTTP 403 until the browser role is set for
 * the app session. Replaying this captured call keeps HTTP queries equivalent
 * to opening the same app in the browser; it never changes account data.
 */
export async function ensureJwxtRole(client) {
  for (const app of JWXT_APPS) {
    await client.postForm(
      `/jwapp/sys/funauthapp/api/changeAppRole/${app}/${STUDENT_ROLE_ID}.do`,
      { selectedRoleId: STUDENT_ROLE_ID },
      { referer: `${JWXT_ORIGIN}/jwapp/sys/${app}/*default/index.do`, skipCaptureGuard: true, skipAuthCheck: true }
    );
  }
}

/**
 * Run `fn(client)` and persist refreshed cookies afterwards, even on failure.
 */
export async function withClient(fn) {
  const client = await createClient();
  try {
    if (process.env.JNU_BACKEND !== 'mock') await ensureJwxtRole(client);
    return await fn(client);
  } finally {
    await client.persist().catch(() => {});
  }
}

export function buildUrl(path, query = {}) {
  const originRelative = path === '/jsonp'
    || path.startsWith('/jsonp/')
    || path === '/jwapp'
    || path.startsWith('/jwapp/');
  const prefix = originRelative ? JWXT_ORIGIN : JWXT_BASE;
  const url = new URL(`${prefix}${path.startsWith('/') ? path : `/${path}`}`);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  }
  url.searchParams.set('_t', String(Date.now()));
  return url;
}

function redactLocation(location) {
  return location.replace(/([?&](?:ticket|token|code)=)[^&]+/gi, '$1<redacted>');
}

function unwrapData(json) {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return json;
  if (Object.hasOwn(json, 'datas')) return json.datas;
  if (Object.hasOwn(json, 'data')) return json.data;
  return json;
}

function loginResult(json) {
  return {
    loggedIn: json?.hasLogin === true,
    userId: json?.userId ?? null,
    userName: json?.userName ?? null
  };
}

async function parseLoginResponse(response, path) {
  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get('location') ?? '';
    throw loginRequired('JWXT redirected to unified authentication.', {
      status: response.status,
      location: redactLocation(location)
    });
  }
  if (response.status === 401) {
    throw loginRequired('JWXT rejected the saved session (HTTP 401).');
  }
  if (response.status < 200 || response.status >= 300) {
    throw new CliError('UPSTREAM_ERROR', `JWXT returned HTTP ${response.status} for ${path}.`, {
      hint: 'The school system may be busy or under maintenance. Retry later, once.',
      details: { status: response.status }
    });
  }
  const text = await response.text().catch(() => '');
  try {
    return JSON.parse(text);
  } catch {
    if (/icas\.jnu\.edu\.cn|auth4\.jnu\.edu\.cn|统一身份认证/i.test(text)) {
      throw loginRequired('JWXT returned the unified-auth login page.');
    }
    throw upstreamChanged(`JWXT returned non-JSON content for ${path} (HTTP ${response.status}).`, {
      status: response.status,
      snippet: text.slice(0, 200)
    });
  }
}

async function parseStatusResponse(response, path) {
  try {
    return await parseLoginResponse(response, path);
  } catch (error) {
    if (error?.code !== 'LOGIN_REQUIRED') throw error;
    return null;
  }
}

// ---------------------------------------------------------------------------
// Mock backend (JNU_BACKEND=mock). Fixture file maps "METHOD /path" or
// "METHOD /path?key=value" (without _t) to either a JSON body or
// { "$status": 302, "$headers": {...}, "$body": ... }.
// ---------------------------------------------------------------------------

function mockState() {
  if (process.env.JNU_MOCK_LOGGED_OUT === '1') {
    return { cookies: [] };
  }
  return {
    browser: 'mock',
    cookies: [{ name: 'JSESSIONID', value: 'mock', domain: 'jw.jnu.edu.cn', path: '/', expires: -1 }]
  };
}

function createMockFetch() {
  const file = process.env.JNU_MOCK_FILE;
  const routes = file ? JSON.parse(readFileSync(file, 'utf8')) : {};
  return async (url, init = {}) => {
    const target = new URL(url);
    target.searchParams.delete('_t');
    const paths = new Set([target.pathname]);
    if (target.pathname.startsWith('/jwapp/')) {
      paths.add(target.pathname.slice('/jwapp'.length));
    }
    if (target.pathname.startsWith('/jwxt/')) {
      paths.add(target.pathname.slice('/jwxt'.length));
    }
    const method = (init.method ?? 'GET').toUpperCase();
    const search = target.searchParams.toString();
    const candidates = [...paths].flatMap((path) => [
      ...(search ? [`${method} ${path}?${search}`] : []),
      `${method} ${path}`
    ]);
    const key = candidates.find((candidate) => Object.hasOwn(routes, candidate));
    if (!key) {
      return new Response(JSON.stringify({ code: 404, message: `mock route missing: ${candidates[0]}` }), {
        status: 404,
        headers: { 'content-type': 'application/json' }
      });
    }
    const route = routes[key];
    if (route && typeof route === 'object' && '$status' in route) {
      const body = route.$body === undefined ? '' : (typeof route.$body === 'string' ? route.$body : JSON.stringify(route.$body));
      return new Response(route.$status >= 300 && route.$status < 400 ? null : body, {
        status: route.$status,
        headers: route.$headers ?? {}
      });
    }
    return new Response(JSON.stringify(route), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
  };
}
