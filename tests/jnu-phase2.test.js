import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Writable } from 'node:stream';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { exitCodeFor, toErrorPayload } from '../src/lib/errors.js';
import { notCaptured } from '../src/lib/not-captured.js';
import { run } from '../src/main.js';
import { listExams, listExamWeeks } from '../src/modules/exam.js';

async function invoke(args, env = {}) {
  const previous = {};
  const merged = {
    JNU_BACKEND: 'mock',
    JNU_CLI_HOME: tempHome,
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

const tempHome = mkdtempSync(join(tmpdir(), 'jnu-cli-phase2-'));
const harFile = join(tempHome, 'jnu.har');
const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'jwxt.json');

test.after(() => {
  rmSync(tempHome, { recursive: true, force: true });
});

test('notCaptured returns the deterministic JNU capture guard error', () => {
  const error = notCaptured('course', 'Use an authenticated recording.');

  assert.equal(error.code, 'UPSTREAM_NOT_CAPTURED');
  assert.equal(exitCodeFor(error.code), 4);
  assert.match(error.message, /real JNU interface for "course" has not been captured/i);
  assert.match(error.hint, /jnu-cli dev capture/);
  assert.match(error.hint, /jnu-cli dev import-har --file <path>/);
  assert.match(error.hint, /Do not bypass JNU unified authentication or WebVPN/);
  assert.match(error.hint, /Use an authenticated recording/);
});

test('exam module fails closed before touching a real-mode client', async () => {
  let clientAccesses = 0;
  const client = new Proxy({}, {
    get() {
      clientAccesses += 1;
      return () => {
        throw new Error('exam real mode touched the client');
      };
    }
  });

  for (const operation of [
    () => listExamWeeks(client),
    () => listExams(client)
  ]) {
    await assert.rejects(operation, (error) => {
      const payload = toErrorPayload(error);
      assert.equal(payload.code, 'UPSTREAM_NOT_CAPTURED');
      assert.equal(exitCodeFor(payload.code), 4);
      assert.match(payload.hint, /jnu-cli dev capture/);
      assert.match(payload.hint, /jnu-cli dev import-har --file <path>/);
      return true;
    });
  }
  assert.equal(clientAccesses, 0);
});

test('exam commands retain structured fixture-backed output in mock mode', async () => {
  const weeks = await invoke(['exam', 'weeks', '--term', '2025-1'], { JNU_MOCK_FILE: FIXTURE });
  assert.equal(weeks.code, 0);
  assert.equal(weeks.body.ok, true);
  assert.equal(weeks.body.data.count, 1);
  assert.equal(weeks.body.data.examWeeks[0].examWeekId, 'EW18');
  assert.equal(weeks.body.data.examWeeks[0].examWeekName, '18-19周期末考');

  const exams = await invoke(['exam', 'list', '--term', '2025-1', '--type', '18-19周期末考'], { JNU_MOCK_FILE: FIXTURE });
  assert.equal(exams.code, 0);
  assert.equal(exams.body.ok, true);
  assert.equal(exams.body.data.count, 1);
  assert.equal(exams.body.data.exams[0].courseName, '数据结构与算法');
  assert.equal(exams.body.data.exams[0].location, '东校区公教楼D302');
});

test('uncaptured real-mode modules fail closed with UPSTREAM_NOT_CAPTURED', async () => {
  const realEnv = { JNU_BACKEND: undefined, JNU_MOCK_FILE: undefined };

  const library = await invoke(['library', 'search', '--query', '算法'], realEnv);
  assert.equal(library.code, 4);
  assert.equal(library.body.error.code, 'UPSTREAM_NOT_CAPTURED');

  const fee = await invoke(['fee', 'unpaid'], realEnv);
  assert.equal(fee.code, 4);
  assert.equal(fee.body.error.code, 'UPSTREAM_NOT_CAPTURED');

  const venues = await invoke(['gym', 'venues'], realEnv);
  assertCommandUnavailable(venues, 'gym venues');

  const services = await invoke(['usc', 'services'], realEnv);
  assertCommandUnavailable(services, 'usc services');

  const categories = await invoke(['lms', 'categories'], realEnv);
  assertCommandUnavailable(categories, 'lms categories');
});

function assertCommandUnavailable(result, command) {
  assert.equal(result.body.ok, false, `${command} must not report success`);
  if (result.body.error?.code === 'UNKNOWN_COMMAND') {
    assert.equal(result.code, 2);
    return;
  }
  assert.equal(result.body.error?.code, 'UPSTREAM_NOT_CAPTURED');
  assert.equal(result.code, 4);
}

test('dev capture is a structured no-op in mock mode and defaults to JNU JWXT', async () => {
  const result = await invoke(['dev', 'capture']);

  assert.equal(result.code, 0);
  assert.equal(result.body.ok, true);
  assert.equal(result.body.data.backend, 'mock');
  assert.equal(result.body.data.startUrl, 'https://jw.jnu.edu.cn/');
  assert.equal(result.body.data.written, false);
  assert.equal(result.body.data.count, 0);
});

test('dev import-har extracts only JSON XHR/fetch responses and redacts secrets', async () => {
  const har = {
    log: {
      version: '1.2',
      entries: [
        {
          startedDateTime: '2026-10-26T02:00:00.000Z',
          _resourceType: 'xhr',
          request: {
            method: 'GET',
            url: 'https://jw.jnu.edu.cn/api/courses?term=2026-1&ticket=secret&_t=123',
            headers: [{ name: 'menuid', value: 'course-menu' }]
          },
          response: {
            status: 200,
            headers: [{ name: 'Content-Type', value: 'application/json; charset=utf-8' }],
            content: {
              mimeType: 'application/json',
              text: '{"data":[{"name":"数据库"}]}'
            }
          }
        },
        {
          startedDateTime: '2026-10-26T02:00:01.000Z',
          _resourceType: 'fetch',
          request: {
            method: 'POST',
            url: 'https://jw.jnu.edu.cn/api/status',
            headers: []
          },
          response: {
            status: 200,
            headers: [],
            content: {
              mimeType: 'application/problem+json',
              encoding: 'base64',
              text: Buffer.from('{"status":"ok"}').toString('base64')
            }
          }
        },
        {
          startedDateTime: '2026-10-26T02:00:02.000Z',
          _resourceType: 'document',
          request: { method: 'GET', url: 'https://jw.jnu.edu.cn/', headers: [] },
          response: {
            status: 200,
            headers: [{ name: 'content-type', value: 'application/json' }],
            content: { text: '{"ignored":true}' }
          }
        },
        {
          startedDateTime: '2026-10-26T02:00:03.000Z',
          _resourceType: 'xhr',
          request: { method: 'GET', url: 'https://jw.jnu.edu.cn/api/html', headers: [] },
          response: {
            status: 200,
            headers: [{ name: 'content-type', value: 'text/html' }],
            content: { text: '<html></html>' }
          }
        }
      ]
    }
  };
  await writeFile(harFile, JSON.stringify(har), 'utf8');

  const result = await invoke(['dev', 'import-har', '--file', harFile]);

  assert.equal(result.code, 0);
  assert.equal(result.body.ok, true);
  assert.equal(result.body.data.input, harFile);
  assert.equal(result.body.data.count, 2);
  assert.equal(result.body.data.skippedCount, 2);
  assert.match(result.body.data.file, /captures[\\/]capture-\d{8}-\d{6}\.json$/);

  const capture = JSON.parse(readFileSync(result.body.data.file, 'utf8'));
  assert.equal(capture.version, 1);
  assert.equal(capture.source, 'har');
  assert.equal(capture.entries.length, 2);
  assert.equal(capture.entries[0].method, 'GET');
  assert.equal(capture.entries[0].menuid, 'course-menu');
  assert.equal(capture.entries[0].body.data[0].name, '数据库');
  assert.equal(capture.entries[0].bodyTruncated, false);
  assert.doesNotMatch(capture.entries[0].url, /secret/);
  assert.doesNotMatch(capture.entries[0].url, /_t=/);
  assert.match(capture.entries[0].url, /ticket=%3Credacted%3E/);
  assert.deepEqual(capture.entries[1].body, { status: 'ok' });
});

test('dev import-har honors --out and rejects overwriting the input HAR', async () => {
  const outputFile = join(tempHome, 'custom', 'capture.json');
  const custom = await invoke(['dev', 'import-har', '--file', harFile, '--out', outputFile]);

  assert.equal(custom.code, 0);
  assert.equal(custom.body.data.file, outputFile);
  assert.equal(JSON.parse(readFileSync(outputFile, 'utf8')).entries.length, 2);

  const overwrite = await invoke(['dev', 'import-har', '--file', harFile, '--out', harFile]);
  assert.equal(overwrite.code, 2);
  assert.equal(overwrite.body.error.code, 'INVALID_ARGUMENT');
});

test('dev import-har truncates oversized JSON bodies without emitting invalid mock data', async () => {
  const largeHarFile = join(tempHome, 'large.har');
  const largeText = JSON.stringify({ data: 'x'.repeat(2_000_001) });
  writeFileSync(largeHarFile, JSON.stringify({
    log: {
      entries: [{
        startedDateTime: '2026-10-26T03:00:00.000Z',
        _resourceType: 'fetch',
        request: {
          method: 'GET',
          url: 'https://jw.jnu.edu.cn/api/large',
          headers: []
        },
        response: {
          status: 200,
          headers: [{ name: 'content-type', value: 'application/json' }],
          content: { text: largeText }
        }
      }]
    }
  }), 'utf8');

  const result = await invoke(['dev', 'import-har', '--file', largeHarFile]);
  const capture = JSON.parse(readFileSync(result.body.data.file, 'utf8'));

  assert.equal(result.code, 0);
  assert.equal(capture.entries[0].bodyTruncated, true);
  assert.equal(capture.entries[0].body.truncated, true);
  assert.equal(capture.entries[0].body.preview, largeText.slice(0, 1000));
});

test('silab login/status use JNU naming and an isolated mock/real cookie state', async () => {
  const initial = await invoke(['silab', 'status']);
  assert.equal(initial.code, 0);
  assert.equal(initial.body.data.status, 'empty');
  assert.equal(initial.body.data.hasCookies, false);

  const login = await invoke(['silab', 'login']);
  assert.equal(login.code, 0);
  assert.equal(login.body.data.saved, true);
  assert.equal(login.body.data.backend, 'mock');
  assert.equal(login.body.data.statePath, join(tempHome, 'silab-session.json'));
  assert.equal(login.body.data.cookieCount, 1);

  await mkdir(tempHome, { recursive: true });
  await writeFile(
    join(tempHome, 'silab-session.json'),
    JSON.stringify({
      version: 1,
      savedAt: '2026-10-26T00:00:00.000Z',
      browser: 'mock',
      cookies: [{ name: 'JSESSIONID', value: 'redacted', domain: 'silab.jnu.edu.cn', path: '/' }]
    }),
    'utf8'
  );
  const mockSaved = await invoke(['silab', 'status']);
  assert.equal(mockSaved.code, 0);
  assert.equal(mockSaved.body.data.status, 'saved');
  assert.equal(mockSaved.body.data.hasCookies, true);
  assert.equal(mockSaved.body.data.cookieCount, 1);

  rmSync(join(tempHome, 'silab-session.json'), { force: true });
  const realEmpty = await invoke(['silab', 'status'], { JNU_BACKEND: undefined });
  assert.equal(realEmpty.code, 0);
  assert.equal(realEmpty.body.data.status, 'empty');
  assert.equal(realEmpty.body.data.statePath, join(tempHome, 'silab-session.json'));

  await writeFile(
    join(tempHome, 'silab-session.json'),
    JSON.stringify({
      version: 1,
      savedAt: '2026-10-26T00:00:00.000Z',
      browser: 'chrome',
      cookies: [{ name: 'JSESSIONID', value: 'redacted', domain: 'silab.jnu.edu.cn', path: '/' }]
    }),
    'utf8'
  );

  const realSaved = await invoke(['silab', 'status'], { JNU_BACKEND: undefined });
  assert.equal(realSaved.code, 0);
  assert.equal(realSaved.body.data.status, 'saved');
  assert.equal(realSaved.body.data.cookieCount, 1);
  assert.equal(realSaved.body.data.savedAt, '2026-10-26T00:00:00.000Z');
});
