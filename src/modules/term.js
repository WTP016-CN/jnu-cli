import { invalidArgument, upstreamChanged } from '../lib/errors.js';
import { JWXT_ORIGIN } from '../lib/jwxt.js';

const TERM_RE = /^(\d{4})-([1-3])$/;
const LONG_TERM_RE = /^(\d{4})-(\d{4})-([1-3])$/;
const CURRENT_TERM_PATH = '/jwapp/sys/cjcx/modules/cjcx/cxdqxnxqhsygxnxq.do';
const CURRENT_WEEK_PATH = '/jwapp/sys/wdkb/modules/jshkcb/dqzc.do';
const SEMESTER_CALENDAR_PATH = '/jwapp/sys/wdkb/modules/xskcb/cxxljc.do';
const TERM_REFERER = `${JWXT_ORIGIN}/jwapp/sys/cjcx/*default/index.do?...#/cjcx`;
const WEEK_REFERER = `${JWXT_ORIGIN}/jwapp/sys/wdkb/*default/index.do?...#/xskcb`;

/**
 * Normalize a user term into JWXT's "YYYY-N" form (start year + semester).
 * Accepts "current", "2025-1" and "2025-2026-1".
 */
export function normalizeTerm(value) {
  if (value === undefined || value === null || value === '' || value === 'current') {
    return 'current';
  }
  const text = String(value).trim();
  const short = text.match(TERM_RE);
  if (short) return `${short[1]}-${short[2]}`;
  const long = text.match(LONG_TERM_RE);
  if (long && Number(long[2]) === Number(long[1]) + 1) return `${long[1]}-${long[3]}`;
  throw invalidArgument(`Invalid term "${value}". Use YYYY-N (e.g. 2025-1 for 2025-2026 first semester) or "current".`);
}

export function termToSchoolYear(term) {
  const match = String(term).match(TERM_RE);
  if (match) {
    const start = Number(match[1]);
    return { schoolYear: `${start}-${start + 1}`, semester: match[2] };
  }
  const long = String(term).match(LONG_TERM_RE);
  if (long && Number(long[2]) === Number(long[1]) + 1) {
    return { schoolYear: `${long[1]}-${long[2]}`, semester: long[3] };
  }
  return null;
}

export function describeTerm(term) {
  const parsed = termToSchoolYear(term);
  if (!parsed) return null;
  const names = { 1: '第一学期', 2: '第二学期', 3: '第三学期' };
  return `${parsed.schoolYear} 学年${names[parsed.semester] ?? `第${parsed.semester}学期`}`;
}

export async function fetchCurrentTerm(client) {
  const data = await client.postForm(CURRENT_TERM_PATH, {}, {
    referer: TERM_REFERER,
    skipCaptureGuard: true
  });
  const rows = extractRows(data, 'cxdqxnxqhsygxnxq');
  const term = rows?.at(-1)?.XNXQDM;
  if (!term || !LONG_TERM_RE.test(String(term))) {
    throw upstreamChanged('cxdqxnxqhsygxnxq did not return a current XNXQDM.', {
      keys: Object.keys(data ?? {})
    });
  }
  return String(term);
}

export async function resolveTerm(client, value) {
  const term = normalizeTerm(value);
  return term === 'current' ? fetchCurrentTerm(client) : term;
}

export async function fetchCurrentWeek(client, term) {
  const parsed = termToSchoolYear(term);
  if (!parsed) return null;
  const data = await client.postForm(CURRENT_WEEK_PATH, {
    XN: parsed.schoolYear,
    XQ: parsed.semester,
    RQ: formatToday()
  }, {
    referer: WEEK_REFERER,
    skipCaptureGuard: true
  });
  const week = Number(extractRows(data, 'dqzc')?.[0]?.ZC);
  return Number.isInteger(week) && week > 0 ? week : null;
}

export async function getTermInfo(client, { term: termOption } = {}) {
  const term = await resolveTerm(client, termOption);
  const currentWeek = await fetchCurrentWeek(client, term);
  const parsed = termToSchoolYear(term);
  const calendar = parsed
    ? await client.postForm(SEMESTER_CALENDAR_PATH, {
      XN: parsed.schoolYear,
      XQ: parsed.semester
    }, {
      referer: WEEK_REFERER,
      skipCaptureGuard: true
    }).catch(() => null)
    : null;
  const totalWeeks = Number(extractRows(calendar, 'cxxljc')?.[0]?.ZZC);
  return {
    term,
    label: describeTerm(term),
    currentWeek,
    ...(Number.isInteger(totalWeeks) && totalWeeks > 0 ? { totalWeeks } : {})
  };
}

function extractRows(payload, moduleKey) {
  const scope = payload?.datas ?? payload?.data ?? payload;
  const module = moduleKey ? scope?.[moduleKey] : null;
  if (Array.isArray(module?.rows)) return module.rows;
  if (Array.isArray(module)) return module;
  if (Array.isArray(scope?.rows)) return scope.rows;
  for (const value of Object.values(scope ?? {})) {
    if (Array.isArray(value?.rows)) return value.rows;
  }
  return null;
}

function formatToday() {
  const date = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
