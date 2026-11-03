import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { launchProfile } from '../lib/browser.js';
import { CliError, invalidArgument } from '../lib/errors.js';

const DEFAULT_START_URL = 'https://jw.jnu.edu.cn';
const MAX_ENTRIES = 400;
const MAX_BODY_CHARS = 2_000_000;
const SECRET_QUERY_KEYS = new Set([
  'access_token',
  'assertion',
  'castgc',
  'code',
  'id_token',
  'refresh_token',
  'session',
  'sid',
  'tgc',
  'ticket',
  'token'
]);

/**
 * Open the JNU JWXT site in a persistent browser profile and record JSON
 * responses made through XHR/fetch. The resulting file is sensitive.
 */
export async function capture({ url, browser } = {}) {
  const startUrl = normalizeStartUrl(url ?? DEFAULT_START_URL);
  if (isMockMode()) {
    return {
      backend: 'mock',
      startUrl,
      file: null,
      count: 0,
      endpoints: [],
      written: false,
      warning: 'Mock mode: no browser was launched and no capture file was written.'
    };
  }

  const launched = await launchProfile({
    browser: browser ?? process.env.JNU_BROWSER,
    headless: false
  });
  const { context } = launched;
  const entries = [];
  const pending = new Set();
  let droppedCount = 0;
  let closed = false;

  const onResponse = (response) => {
    if (entries.length >= MAX_ENTRIES) {
      droppedCount += 1;
      return;
    }
    const task = recordResponse(response)
      .then((entry) => {
        if (!entry) return;
        if (entries.length >= MAX_ENTRIES) {
          droppedCount += 1;
          return;
        }
        entries.push(entry);
      })
      .catch(() => {})
      .finally(() => pending.delete(task));
    pending.add(task);
  };

  const closedPromise = new Promise((resolveClosed) => {
    context.once('close', () => {
      closed = true;
      resolveClosed();
    });
  });
  context.on('response', onResponse);

  process.stderr.write(
    `Capturing JSON XHR/fetch traffic from ${startUrl}. ` +
    'Navigate to the pages you need, then close the browser window to finish.\n'
  );
  try {
    const page = context.pages()[0] ?? await context.newPage();
    await page.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    await closedPromise;
    await settlePending(pending);
  } finally {
    context.off('response', onResponse);
    await context.close().catch(() => {});
  }

  entries.sort((left, right) => left.at.localeCompare(right.at));
  const capturedAt = new Date().toISOString();
  const file = capturePath();
  await mkdir(dirname(file), { recursive: true });
  await writeFile(
    file,
    `${JSON.stringify({
      version: 1,
      source: 'browser',
      capturedAt,
      startUrl: redactUrl(startUrl),
      entries,
      droppedCount
    }, null, 2)}\n`,
    { encoding: 'utf8', mode: 0o600 }
  );

  return {
    file,
    count: entries.length,
    droppedCount,
    endpoints: summarizeEndpoints(entries),
    browser: launched.browser.id,
    browserClosed: closed,
    written: true,
    warning: 'Capture files contain personal data. Redact before sharing; never commit them.'
  };
}

/**
 * Convert JSON XHR/fetch responses from a browser HAR into the same capture
 * shape produced by `dev capture`.
 */
export async function importHar({ file, out } = {}) {
  const inputFile = String(file ?? '').trim();
  if (!inputFile) {
    throw invalidArgument('Missing --file <path> for `jnu-cli dev import-har`.');
  }

  const resolvedInput = resolve(inputFile);
  let har;
  try {
    har = JSON.parse(await readFile(resolvedInput, 'utf8'));
  } catch (cause) {
    throw new CliError('INVALID_ARGUMENT', `Could not read HAR file ${resolvedInput}: ${cause.message}`, {
      hint: 'Pass a browser-exported HAR file. Exporting a HAR never requires your password to be shared with jnu-cli.',
      cause
    });
  }

  const rawEntries = har?.log?.entries;
  if (!Array.isArray(rawEntries)) {
    throw invalidArgument('The HAR file does not contain log.entries.');
  }

  const entries = rawEntries
    .map(entryFromHar)
    .filter(Boolean)
    .sort((left, right) => left.at.localeCompare(right.at));
  const outputFile = out ? resolve(String(out)) : capturePath();
  if (outputFile === resolvedInput) {
    throw invalidArgument('--out must not overwrite the input HAR file.');
  }

  const firstRequestUrl = rawEntries.find((entry) => entry?.request?.url)?.request.url ?? null;
  const capturedAt = new Date().toISOString();
  await mkdir(dirname(outputFile), { recursive: true });
  await writeFile(
    outputFile,
    `${JSON.stringify({
      version: 1,
      source: 'har',
      capturedAt,
      startUrl: firstRequestUrl ? redactUrl(firstRequestUrl) : null,
      entries,
      skippedCount: rawEntries.length - entries.length
    }, null, 2)}\n`,
    { encoding: 'utf8', mode: 0o600 }
  );

  return {
    file: outputFile,
    input: resolvedInput,
    count: entries.length,
    skippedCount: rawEntries.length - entries.length,
    endpoints: summarizeEndpoints(entries),
    written: true,
    ...(isMockMode() ? { backend: 'mock' } : {}),
    warning: 'Capture files contain personal data. Redact before sharing; never commit them.'
  };
}

async function recordResponse(response) {
  const request = response.request();
  const resourceType = request.resourceType();
  if (!['xhr', 'fetch'].includes(resourceType)) return null;

  const contentType = response.headers()['content-type'] ?? '';
  if (!isJsonContentType(contentType)) return null;

  let text;
  try {
    text = await response.text();
  } catch {
    return null;
  }
  const parsed = parseJsonText(text);
  if (!parsed.ok) return null;

  return {
    at: new Date().toISOString(),
    method: request.method().toUpperCase(),
    url: redactUrl(response.url()),
    status: response.status(),
    resourceType,
    contentType,
    menuid: request.headers().menuid ?? null,
    body: parsed.value,
    bodyTruncated: parsed.truncated
  };
}

function entryFromHar(entry) {
  const request = entry?.request;
  const response = entry?.response;
  if (!request?.url || !response) return null;

  const resourceType = String(entry._resourceType ?? entry.resourceType ?? '').toLowerCase();
  if (resourceType && !['xhr', 'fetch'].includes(resourceType)) return null;

  const contentType =
    headerValue(response.headers, 'content-type') ??
    response.content?.mimeType ??
    '';
  if (!isJsonContentType(contentType)) return null;

  let text = response.content?.text;
  if (typeof text !== 'string') return null;
  if (String(response.content?.encoding ?? '').toLowerCase() === 'base64') {
    text = Buffer.from(text, 'base64').toString('utf8');
  }

  const parsed = parseJsonText(text);
  if (!parsed.ok) return null;

  const startedAt = Date.parse(entry.startedDateTime);
  return {
    at: Number.isNaN(startedAt) ? new Date().toISOString() : new Date(startedAt).toISOString(),
    method: String(request.method ?? 'GET').toUpperCase(),
    url: redactUrl(request.url),
    status: Number(response.status ?? 0),
    resourceType: resourceType || 'xhr',
    contentType,
    menuid: headerValue(request.headers, 'menuid'),
    body: parsed.value,
    bodyTruncated: parsed.truncated
  };
}

function parseJsonText(text) {
  if (typeof text !== 'string' || text.length === 0) return { ok: false, truncated: false };
  if (text.length > MAX_BODY_CHARS) {
    return {
      ok: true,
      truncated: true,
      value: {
        truncated: true,
        preview: text.slice(0, 1000)
      }
    };
  }
  try {
    return { ok: true, truncated: false, value: JSON.parse(text) };
  } catch {
    return { ok: false, truncated: false };
  }
}

function isJsonContentType(value) {
  const mime = String(value ?? '').split(';')[0].trim().toLowerCase();
  return mime === 'application/json' || mime.endsWith('+json') || mime.includes('/json');
}

function normalizeStartUrl(value) {
  try {
    const parsed = new URL(String(value));
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('unsupported protocol');
    return parsed.toString();
  } catch {
    throw invalidArgument('--url must be a valid HTTP(S) URL.');
  }
}

function headerValue(headers, name) {
  if (!Array.isArray(headers)) return null;
  const match = headers.find((header) => String(header?.name ?? '').toLowerCase() === name);
  return match?.value === undefined ? null : String(match.value);
}

function summarizeEndpoints(entries) {
  return [
    ...new Set(entries.map((entry) => {
      const url = new URL(entry.url);
      return `${entry.method} ${url.pathname}${url.search}`;
    }))
  ];
}

function redactUrl(value) {
  try {
    const url = new URL(value);
    url.searchParams.delete('_t');
    for (const key of [...url.searchParams.keys()]) {
      if (SECRET_QUERY_KEYS.has(key.toLowerCase())) {
        url.searchParams.set(key, '<redacted>');
      }
    }
    return url.toString();
  } catch {
    return String(value);
  }
}

function capturePath(date = new Date()) {
  return join(
    jnuCliHome(),
    'captures',
    `capture-${timestamp(date)}.json`
  );
}

function timestamp(date) {
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate())
  ].join('') + '-' + [
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds())
  ].join('');
}

function pad(value) {
  return String(value).padStart(2, '0');
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

async function settlePending(pending) {
  const started = Date.now();
  while (pending.size > 0) {
    await Promise.allSettled([...pending]);
    if (Date.now() - started > 5000) break;
  }
  await sleep(0);
}
