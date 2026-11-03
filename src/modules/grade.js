import { upstreamChanged } from '../lib/errors.js';
import { JWXT_ORIGIN } from '../lib/jwxt.js';
import { computeWeightedGpa, parseGradeRows } from '../parsers/grade-parser.js';
import { describeTerm, normalizeTerm, termToSchoolYear } from './term.js';

const REFERER = `${JWXT_ORIGIN}/jwapp/sys/cjcx/*default/index.do#/cjcx`;
const BASE = '/jwapp/sys/cjcx/modules/cjcx';
const CURRENT_TERM_PATH = `${BASE}/cxdqxnxqhsygxnxq.do`;
const SCORE_PATH = `${BASE}/xscjcx.do`;

/**
 * Resolve the JNU XNXQDM value, using the score page's last "current/next"
 * term entry when the caller did not specify a term.
 */
async function resolveGradeQuery(client, termOption) {
  const requestedTerm = normalizeTerm(termOption);
  const upstreamTerm = requestedTerm === 'current'
    ? await fetchCurrentTermForGrades(client)
    : toUpstreamTerm(requestedTerm);
  const displayTerm = toDisplayTerm(upstreamTerm);
  return { term: displayTerm, upstreamTerm };
}

export async function listGrades(client, { term: termOption, raw } = {}) {
  const { term, upstreamTerm } = await resolveGradeQuery(client, termOption);
  const payload = await client.request('POST', SCORE_PATH, {
    form: {
      querySetting: JSON.stringify(buildQuerySetting(upstreamTerm)),
      '*order': '-XNXQDM,-KCH,-KXH'
    },
    referer: REFERER,
    skipCaptureGuard: true
  });
  const rows = extractRows(payload);
  if (!rows) {
    throw upstreamChanged('xscjcx did not return datas.xscjcx.rows.', {
      keys: Object.keys(payload?.datas ?? payload ?? {})
    });
  }
  const grades = parseGradeRows(rows, { term });
  return {
    term,
    termLabel: describeTerm(term),
    count: grades.length,
    grades,
    summary: {
      computed: computeWeightedGpa(grades),
      official: null
    },
    ...(raw ? { raw: rows } : {})
  };
}

async function fetchCurrentTermForGrades(client) {
  const payload = await client.request('POST', CURRENT_TERM_PATH, {
    form: {},
    referer: REFERER,
    skipCaptureGuard: true
  });
  const rows = extractRows(payload);
  const term = rows?.at(-1)?.XNXQDM;
  if (!term) {
    throw upstreamChanged('cxdqxnxqhsygxnxq did not return a current XNXQDM.', {
      keys: Object.keys(payload?.datas ?? payload ?? {})
    });
  }
  return String(term);
}

function buildQuerySetting(upstreamTerm) {
  return [
    {
      name: 'XNXQDM',
      value: upstreamTerm,
      linkOpt: 'and',
      builder: 'm_value_equal'
    },
    {
      name: 'SFYX',
      caption: '是否有效',
      linkOpt: 'AND',
      builderList: 'cbl_m_List',
      builder: 'm_value_equal',
      value: '1',
      value_display: '是'
    },
    {
      name: 'SHOWMAXCJ',
      caption: '显示最高成绩',
      linkOpt: 'AND',
      builderList: 'cbl_m_List',
      builder: 'm_value_equal',
      value: '0',
      value_display: '否'
    }
  ];
}

function extractRows(payload) {
  const candidates = [
    payload?.cxdqxnxqhsygxnxq?.rows,
    payload?.xscjcx?.rows,
    payload?.datas?.xscjcx?.rows,
    payload?.datas?.cxdqxnxqhsygxnxq?.rows,
    payload?.datas?.rows,
    payload?.rows
  ];
  return candidates.find(Array.isArray) ?? null;
}

function toUpstreamTerm(term) {
  const parsed = termToSchoolYear(term);
  return parsed ? `${parsed.schoolYear}-${parsed.semester}` : null;
}

function toDisplayTerm(term) {
  const match = String(term).match(/^(\d{4})-\d{4}-([1-3])$/);
  return match ? `${match[1]}-${match[2]}` : String(term);
}

export async function creditSummary(client) {
  const rows = await client.get(`${BASE}/stuCreditSitlist`, { referer: REFERER });
  const pie = await client.get(`${BASE}/getPicPie`, { referer: REFERER });
  const rawPie = Array.isArray(pie) ? pie : (Array.isArray(pie?.selectPie) ? pie.selectPie : []);
  const distribution = rawPie.map((item) => ({
    range: item?.ITEM ?? item?.name ?? null,
    count: Number(item?.COU ?? item?.value ?? 0)
  }));
  return {
    credits: Array.isArray(rows) ? rows : [],
    distribution
  };
}
