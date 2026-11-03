import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import test from 'node:test';

import {
  JWXT_LOGIN_URL,
  JWXT_STATUS_PATH,
  JWXT_USER_INFO_PATH,
  JwxtClient,
  buildUrl
} from '../src/lib/jwxt.js';
import { saveState } from '../src/lib/state.js';
import { CAS_ENTRY_URL } from '../src/modules/auth.js';
import { doctor } from '../src/modules/doctor.js';
import { run } from '../src/main.js';

const HOME = mkdtempSync(join(tmpdir(), 'jnu-cli-auth-'));
const originalFetch = globalThis.fetch;
const SESSION_COOKIE = {
  name: 'MOD_AMP_AUTH',
  value: 'mock',
  domain: '.jnu.edu.cn',
  path: '/',
  expires: -1
};

test.after(() => {
  globalThis.fetch = originalFetch;
  rmSync(HOME, { recursive: true, force: true });
});

test('JNU auth entry uses the verified JWXT login URL', () => {
  assert.equal(CAS_ENTRY_URL, 'https://jw.jnu.edu.cn/new/index.html');
  assert.equal(JWXT_LOGIN_URL, CAS_ENTRY_URL);
  assert.equal(buildUrl(JWXT_USER_INFO_PATH, { type: '' }).href.startsWith('https://jw.jnu.edu.cn/jsonp/'), true);
});

test('auth status reads userDesktopInfo and persists refreshed cookies', async () => {
  const calls = [];
  const state = await withIsolatedHome(async () => {
    await saveState({ cookies: [SESSION_COOKIE] });
    const client = new JwxtClient({
      state: { cookies: [SESSION_COOKIE] },
      fetchImpl: async (url) => {
        calls.push(String(url));
        return new Response(JSON.stringify({
          userId: '23000001',
          userName: '张三',
          hasLogin: true
        }), {
          status: 200,
          headers: {
            'content-type': 'application/json',
            'set-cookie': 'amp.locale=zh; Path=/; Domain=.jnu.edu.cn; Secure'
          }
        });
      }
    });

    const result = await client.loginStatus();
    await client.persist();
    return result;
  });

  assert.deepEqual(state, {
    loggedIn: true,
    userId: '23000001',
    userName: '张三'
  });
  assert.match(calls[0], /\/jsonp\/userDesktopInfo\.json\?type=&_t=/);
});

test('auth status falls back to getCurrentLocale when user info redirects to ICAS', async () => {
  const calls = [];
  const client = new JwxtClient({
    state: { cookies: [SESSION_COOKIE] },
    fetchImpl: async (url) => {
      calls.push(String(url));
      if (String(url).includes('userDesktopInfo')) {
        return new Response(null, {
          status: 302,
          headers: { location: 'https://icas.jnu.edu.cn/cas/login?service=auth4' }
        });
      }
      return new Response(JSON.stringify({ hasLogin: false }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    }
  });

  const result = await client.loginStatus();
  assert.deepEqual(result, { loggedIn: false, userId: null, userName: null });
  assert.equal(calls.length, 2);
  assert.match(calls[1], /getCurrentLocale\.json/);
});

test('auth status reports a missing session without a network request', async () => {
  rmSync(join(HOME, 'session.json'), { force: true });
  const result = await withIsolatedHome(() => invoke(['auth', 'status']));
  assert.equal(result.code, 0);
  assert.equal(result.body.data.loggedIn, false);
  assert.equal(result.body.data.reason, 'session-missing');
});

test('real-mode auth endpoints bypass the capture guard, business endpoints do not', async () => {
  const result = await new JwxtClient({
    state: { cookies: [SESSION_COOKIE] },
    fetchImpl: async () => new Response(JSON.stringify({ hasLogin: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    })
  }).loginStatus();
  assert.equal(result.loggedIn, true);

  const business = await assertRejects(() => new JwxtClient({
    state: { cookies: [SESSION_COOKIE] },
    fetchImpl: async () => new Response('{}', { status: 200 })
  }).get('/guessed/course-endpoint'));
  assert.equal(business.code, 'UPSTREAM_NOT_CAPTURED');
});

test('doctor checks the verified JNU user info endpoint', async () => {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response('{"hasLogin":false}', {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
  };
  const result = await withIsolatedHome(() => doctor());
  assert.equal(result.checks.network.ok, true);
  assert.equal(result.checks.network.endpoint, JWXT_USER_INFO_PATH);
  assert.match(calls[0].url, /^https:\/\/jw\.jnu\.edu\.cn\/jsonp\/userDesktopInfo\.json/);
});

async function invoke(args, env = {}) {
  const previous = {};
  const merged = {
    JNU_BACKEND: undefined,
    JNU_MOCK_FILE: undefined,
    JNU_CLI_HOME: HOME,
    ...env
  };
  for (const [key, value] of Object.entries(merged)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  let output = '';
  const stdout = new Writable({
    write(chunk, _encoding, callback) {
      output += chunk.toString();
      callback();
    }
  });
  try {
    const code = await run(args, { stdout });
    return { code, body: JSON.parse(output) };
  } finally {
    process.exitCode = 0;
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function withIsolatedHome(fn) {
  const previous = process.env.JNU_CLI_HOME;
  process.env.JNU_CLI_HOME = HOME;
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.JNU_CLI_HOME;
    else process.env.JNU_CLI_HOME = previous;
  }
}

async function assertRejects(fn) {
  try {
    await fn();
  } catch (error) {
    return error;
  }
  assert.fail('Expected operation to reject.');
}
