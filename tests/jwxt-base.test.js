import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  JWXT_BASE,
  JwxtClient,
  buildUrl,
  createClient
} from '../src/lib/jwxt.js';

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'jwxt.json');
const SESSION_COOKIE = {
  name: 'MOD_AMP_AUTH',
  value: 'mock',
  domain: '.jnu.edu.cn',
  path: '/',
  expires: -1
};

function createTestClient(fetchImpl) {
  return new JwxtClient({
    state: { cookies: [SESSION_COOKIE] },
    fetchImpl,
    persist: false
  });
}

test('JNU JWXT paths default to /jwapp while JSONP stays origin-relative', () => {
  assert.equal(JWXT_BASE, 'https://jw.jnu.edu.cn/jwapp');
  assert.equal(
    buildUrl('/base-info/acadyearterm/showNewAcadlist').pathname,
    '/jwapp/base-info/acadyearterm/showNewAcadlist'
  );
  assert.equal(
    buildUrl('/jwapp/sys/wdkb/modules/xskcb/xskcb.do').pathname,
    '/jwapp/sys/wdkb/modules/xskcb/xskcb.do'
  );
  assert.equal(
    buildUrl('/jsonp/getCurrentLocale.json').pathname,
    '/jsonp/getCurrentLocale.json'
  );
});

test('JWXT convenience methods accept code "0" and unwrap datas', async () => {
  const requests = [];
  const client = createTestClient(async (url, init) => {
    requests.push({ url, init });
    return new Response(JSON.stringify({
      code: '0',
      datas: {
        rows: [{ id: 'captured' }]
      }
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
  });

  const data = await client.get('/base-info/example', { skipCaptureGuard: true });
  assert.deepEqual(data, { rows: [{ id: 'captured' }] });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url.pathname, '/jwapp/base-info/example');
});

test('postForm sends URL-encoded data and unwraps datas', async () => {
  let captured;
  const client = createTestClient(async (url, init) => {
    captured = { url, init };
    return new Response(JSON.stringify({
      code: '0',
      datas: { saved: true }
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
  });

  const data = await client.postForm('/sys/example/save.do', {
    term: '2026-1',
    empty: '',
    omitted: null
  }, {
    skipCaptureGuard: true
  });

  assert.deepEqual(data, { saved: true });
  assert.equal(captured.url.pathname, '/jwapp/sys/example/save.do');
  assert.equal(
    captured.init.headers['Content-Type'],
    'application/x-www-form-urlencoded; charset=UTF-8'
  );
  assert.equal(captured.init.body, 'term=2026-1&empty=');
});

test('mock fixture serves JNU /jwapp envelopes through the base client', async () => {
  await withEnv({
    JNU_BACKEND: 'mock',
    JNU_MOCK_FILE: FIXTURE,
    JNU_ENDPOINTS_CAPTURED: undefined
  }, async () => {
    const client = await createClient();
    const read = await client.get('/base-info/jnu-cli-check');
    assert.deepEqual(read, {
      source: 'jnu',
      rows: []
    });

    const written = await client.postForm('/base-info/jnu-cli-check', {
      probe: 'ok'
    });
    assert.deepEqual(written, { accepted: true });
  });
});

async function withEnv(values, fn) {
  const previous = new Map();
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}
