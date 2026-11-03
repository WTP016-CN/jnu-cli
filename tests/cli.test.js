import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { Writable } from 'node:stream';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { CookieJar } from '../src/lib/cookies.js';
import { JwxtClient } from '../src/lib/jwxt.js';
import { run } from '../src/main.js';
import { listGrades } from '../src/modules/grade.js';
import { normalizeTerm } from '../src/modules/term.js';
import { parseTimetableRows, weekOffset } from '../src/parsers/course-parser.js';
import { parseExamRows } from '../src/parsers/exam-parser.js';
import { computeWeightedGpa, parseGradeRows } from '../src/parsers/grade-parser.js';
import { enforceActionCooldown } from '../src/lib/rate-limit.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'jwxt.json');

async function invoke(args, env = {}) {
  const previous = {};
  const merged = { JNU_BACKEND: 'mock', JNU_MOCK_FILE: FIXTURE, ...env };
  for (const [key, value] of Object.entries(merged)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  let output = '';
  const stdout = new Writable({
    write(chunk, _enc, cb) {
      output += chunk.toString();
      cb();
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

test('merges consecutive sections and keeps non-contiguous sections separate', () => {
  const entries = parseTimetableRows([
    { section: '1', monday: '算法;;张;;B201' },
    { section: '2', monday: '算法;;张;;B201' },
    { section: '5', monday: '算法;;张;;B201' }
  ], { term: '2025-1', week: 8 });
  assert.equal(entries.length, 2);
  assert.equal(entries[0].sections, '1-2');
  assert.equal(entries[1].sections, '5');
});

test('parses JNU grade rows and skips missing grade points when computing GPA', () => {
  const rows = parseGradeRows([
    { KCM: 'A', KCH: 'A101', XF: '4', ZCJ: '92', JDF: '4.2', SFJG: '是' },
    { KCM: 'B', KCH: 'B101', XF: '5', ZCJ: '88', JDF: '3.8', SFJG: '是' },
    { KCM: 'P/F', KCH: 'P101', XF: '1', ZCJ: '合格', JDF: null, SFJG: '是' }
  ]);
  assert.equal(rows[0].courseName, 'A');
  assert.equal(rows[0].passed, true);
  assert.equal(rows[2].gradePoint, null);
  const summary = computeWeightedGpa(rows);
  assert.equal(summary.gradedCredits, 9);
  assert.equal(summary.weightedGpa, 3.978);
});

test('replays the captured JNU grade form and current-term endpoint', async () => {
  const requests = [];
  const client = new JwxtClient({
    state: {
      cookies: [{ name: 'JSESSIONID', value: 'mock', domain: 'jw.jnu.edu.cn', path: '/', expires: -1 }]
    },
    persist: false,
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      const body = url.pathname.endsWith('cxdqxnxqhsygxnxq.do')
        ? { code: '0', datas: { rows: [{ XNXQDM: '2025-2026-3' }, { XNXQDM: '2026-2027-1' }] } }
        : { code: '0', datas: { xscjcx: { rows: [{ KCM: '课程', KCH: 'C1', XF: '2', ZCJ: '90', JDF: '4.0', XNXQDM: '2026-2027-1' }] } } };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    }
  });

  const result = await listGrades(client);
  assert.equal(result.term, '2026-1');
  assert.equal(requests.length, 2);
  assert.match(requests[0].url.pathname, /cxdqxnxqhsygxnxq\.do$/);
  assert.equal(requests[0].init.body, '');
  assert.match(requests[1].url.pathname, /xscjcx\.do$/);
  assert.equal(requests[1].init.headers['Content-Type'], 'application/x-www-form-urlencoded; charset=UTF-8');

  const form = new URLSearchParams(requests[1].init.body);
  assert.equal(form.get('*order'), '-XNXQDM,-KCH,-KXH');
  assert.deepEqual(JSON.parse(form.get('querySetting'))[0], {
    name: 'XNXQDM',
    value: '2026-2027-1',
    linkOpt: 'and',
    builder: 'm_value_equal'
  });
});

test('parses exam grid cells and skips emptyFlag slots', () => {
  const exams = parseExamRows([
    {
      dataNumber: '1',
      timetable: {
        1: [{ emptyFlag: true }],
        3: [{ emptyFlag: false, examSubjectName: '操作系统', examDate: '2026-01-08', durationTime: '14:30-16:30', duration: '120', classroomNumber: 'B101' }]
      }
    }
  ], { term: '2025-1' });
  assert.equal(exams.length, 1);
  assert.equal(exams[0].courseName, '操作系统');
  assert.equal(exams[0].weekday, 3);
  assert.equal(exams[0].durationMinutes, 120);
});

test('normalizes both short and long term formats', () => {
  assert.equal(normalizeTerm('2025-1'), '2025-1');
  assert.equal(normalizeTerm('2025-2026-2'), '2025-2');
  assert.equal(normalizeTerm(undefined), 'current');
  assert.throws(() => normalizeTerm('2025-2027-1'), { code: 'INVALID_ARGUMENT' });
});

test('computes whole-week offset across week boundaries', () => {
  assert.equal(weekOffset(new Date(2026, 9, 23), new Date(2026, 9, 25)), 0); // Fri -> Sun same ISO week
  assert.equal(weekOffset(new Date(2026, 9, 23), new Date(2026, 9, 26)), 1); // Fri -> next Mon
});

test('cookie jar matches subdomains, paths, and Set-Cookie updates', () => {
  const jar = new CookieJar([
    { name: 'sid', value: 'v1', domain: '.jnu.edu.cn', path: '/jwxt' }
  ]);
  assert.equal(jar.header('https://jw.jnu.edu.cn/jwxt/api/course'), 'sid=v1');
  assert.equal(jar.header('https://jw.jnu.edu.cn/other'), '');
  jar.store('https://jw.jnu.edu.cn/jwxt/api/course', ['sid=v2; Path=/jwxt; HttpOnly']);
  assert.equal(jar.header('https://jw.jnu.edu.cn/jwxt/api/course'), 'sid=v2');
  assert.equal(jar.dirty, true);
});

test('CLI contract: JNU term, course, grade, and exam queries succeed against mock JWXT', async () => {
  const term = await invoke(['term', 'current']);
  assert.equal(term.code, 0);
  assert.equal(term.body.data.term, '2026-2027-1');
  assert.equal(term.body.data.label, '2026-2027 学年第一学期');
  assert.equal(term.body.data.currentWeek, 8);
  assert.equal(term.body.data.totalWeeks, 18);

  const courses = await invoke(['course', 'list', '--term', '2026-1', '--week', '8', '--raw']);
  assert.equal(courses.code, 0);
  assert.equal(courses.body.ok, true);
  assert.equal(courses.body.data.term, '2026-1');
  assert.equal(courses.body.data.week, 8);
  assert.equal(courses.body.data.currentWeek, 8);
  assert.equal(courses.body.data.count, 2);
  assert.equal(courses.body.data.courses[0].courseName, '高等数学');
  assert.equal(courses.body.data.courses[0].courseCode, 'MATH101');
  assert.equal(courses.body.data.courses[0].teacher, '张老师,李老师');
  assert.equal(courses.body.data.courses[0].location, '教学楼B201');
  assert.equal(courses.body.data.courses[0].startSection, 1);
  assert.equal(courses.body.data.courses[0].endSection, 2);
  assert.equal(courses.body.data.courses[0].campus, '番禺校区');
  assert.equal(courses.body.data.raw[0].KCM, '高等数学');

  const monday = await invoke(['course', 'list', '--term', '2026-1', '--week', '8', '--weekday', '1']);
  assert.equal(monday.code, 0);
  assert.equal(monday.body.data.count, 1);
  assert.equal(monday.body.data.weekdayName, '周一');

  const today = await invoke(['course', 'today', '--date', '2026-10-26']);
  assert.equal(today.code, 0);
  assert.equal(today.body.data.date, '2026-10-26');
  assert.equal(today.body.data.weekday, 1);
  assert.equal(today.body.data.count, 1);
  assert.equal(today.body.data.courses[0].courseName, '高等数学');

  const grades = await invoke(['grade', 'list']);
  assert.equal(grades.code, 0);
  assert.equal(grades.body.data.term, '2026-1');
  assert.equal(grades.body.data.count, 3);
  assert.equal(grades.body.data.summary.computed.weightedGpa, 3.978);
  assert.equal(grades.body.data.summary.official, null);
  assert.equal(Object.hasOwn(grades.body.data.grades[0], 'PSCJ'), false);

  const rawGrades = await invoke(['grade', 'list', '--term', '2026-2027-1', '--raw']);
  assert.equal(rawGrades.code, 0);
  assert.equal(rawGrades.body.data.raw[0].PSCJ, '90');
  assert.equal(Object.hasOwn(rawGrades.body.data.grades[0], 'QMCJ'), false);

  const exams = await invoke(['exam', 'list', '--type', '18-19周期末考']);
  assert.equal(exams.code, 0);
  assert.equal(exams.body.data.count, 1);
  assert.equal(exams.body.data.exams[0].location, '东校区公教楼D302');
});

test('CLI contract: returns structured LOGIN_REQUIRED when session is missing', async () => {
  const res = await invoke(['course', 'list'], { JNU_MOCK_LOGGED_OUT: '1' });
  assert.equal(res.code, 3);
  assert.equal(res.body.ok, false);
  assert.equal(res.body.error.code, 'LOGIN_REQUIRED');
  assert.match(res.body.error.hint, /auth refresh/);
});

test('CLI contract: auth login/status use the verified JNU authentication endpoints', async () => {
  const login = await invoke(['auth', 'login']);
  assert.equal(login.code, 0);
  assert.equal(login.body.data.loggedIn, true);
  assert.equal(login.body.data.backend, 'mock');

  const status = await invoke(['auth', 'status']);
  assert.equal(status.code, 0);
  assert.equal(status.body.data.loggedIn, true);
  assert.equal(status.body.data.reason, 'jwxt-session-active');
  assert.equal(status.body.data.userId, '23000001');
  assert.equal(status.body.data.userName, '张三');
});

test('CLI contract: returns UNKNOWN_COMMAND and INVALID_ARGUMENT with exit code 2', async () => {
  const unknown = await invoke(['nope']);
  assert.equal(unknown.code, 2);
  assert.equal(unknown.body.error.code, 'UNKNOWN_COMMAND');

  const badArg = await invoke(['course', 'list', '--week', 'zero']);
  assert.equal(badArg.code, 2);
  assert.equal(badArg.body.error.code, 'INVALID_ARGUMENT');
});

test('CLI contract: classroom, cet, notice, completion, program, catalog, profile, and export-ics', async () => {
  const rooms = await invoke(['classroom', 'empty', '--campus', '东校园', '--building', '公教楼', '--date', '2026-10-26', '--sections', '1-2']);
  assert.equal(rooms.code, 0);
  assert.equal(rooms.body.data.count, 1);
  assert.equal(rooms.body.data.classrooms[0].classroom, 'B201');

  const cet6 = await invoke(['cet', 'list', '--level', '6']);
  assert.equal(cet6.code, 0);
  assert.equal(cet6.body.data.count, 1);
  assert.equal(cet6.body.data.scores[0].totalScore, 560);

  const notices = await invoke(['notice', 'list', '--search', '交流']);
  assert.equal(notices.code, 0);
  assert.equal(notices.body.data.count, 1);
  assert.equal(notices.body.data.notices[0].sourceLabel, '教务部');

  const comp = await invoke(['completion', 'summary']);
  assert.equal(comp.code, 0);
  assert.equal(comp.body.data.overview.completionRate, 75.0);
  assert.equal(comp.body.data.categories[0].categoryName, '公必');

  const compCourses = await invoke(['completion', 'courses', '--search', '形势']);
  assert.equal(compCourses.code, 0);
  assert.equal(compCourses.body.data.count, 1);

  const prog = await invoke(['program', 'view']);
  assert.equal(prog.code, 0);
  assert.equal(prog.body.data.student.professionName, '计算机科学与技术');
  assert.equal(prog.body.data.courseGroups.publicRequired.count, 1);

  const cat = await invoke(['catalog', 'search', '--name', '数据结构']);
  assert.equal(cat.code, 0);
  assert.equal(cat.body.data.count, 1);
  assert.equal(cat.body.data.courses[0].courseCode, 'DCS201');

  const prof = await invoke(['profile', 'view']);
  assert.equal(prof.code, 0);
  assert.equal(prof.body.data.profile.name, '张三');
  assert.equal(prof.body.data.academicWarnings[0].count, 0);

  const ics = await invoke(['course', 'export-ics', '--term', '2026-1', '--week', '8']);
  assert.equal(ics.code, 0);
  assert.equal(ics.body.data.eventCount, 2);
  assert.match(ics.body.data.ics, /BEGIN:VCALENDAR/);
  assert.match(ics.body.data.ics, /SUMMARY:高等数学/);
  assert.match(ics.body.data.ics, /DTSTART;TZID=Asia\/Shanghai:20261026T080000/);
});

test('CLI contract: library search & holdings and fee unpaid', async () => {
  const libSearch = await invoke(['library', 'search', '--query', '算法导论', '--campus', '番禺校区']);
  assert.equal(libSearch.code, 0);
  assert.equal(libSearch.body.data.count, 1);
  assert.equal(libSearch.body.data.books[0].docNumber, '001011438');
  assert.equal(libSearch.body.data.books[0].callNumber, 'TP301.6/126.2');
  assert.equal(libSearch.body.data.books[0].availableItems, 4);

  const libHoldings = await invoke(['library', 'holdings', '--doc', '001011438', '--available']);
  assert.equal(libHoldings.code, 0);
  assert.equal(libHoldings.body.data.count, 1);
  assert.equal(libHoldings.body.data.items[0].barcode, 'A1801623');
  assert.equal(libHoldings.body.data.items[0].status, '在架上');

  const unpaid = await invoke(['fee', 'unpaid']);
  assert.equal(unpaid.code, 0);
  assert.equal(unpaid.body.data.count, 1);
  assert.equal(unpaid.body.data.items[0].feeName, '2026学年住宿费');
});

test('anti-high-frequency rate limiter rejects a repeated action inside its cooldown', async () => {
  const tempHome = mkdtempSync(join(tmpdir(), 'jnu-cli-rl-'));
  const prevHome = process.env.JNU_CLI_HOME;
  const prevForce = process.env.JNU_FORCE_RATE_LIMIT;
  process.env.JNU_CLI_HOME = tempHome;
  process.env.JNU_FORCE_RATE_LIMIT = '1';
  try {
    await enforceActionCooldown('test.action', 5000);
    await assert.rejects(() => enforceActionCooldown('test.action', 5000), { code: 'RATE_LIMITED' });
  } finally {
    if (prevHome === undefined) delete process.env.JNU_CLI_HOME;
    else process.env.JNU_CLI_HOME = prevHome;
    if (prevForce === undefined) delete process.env.JNU_FORCE_RATE_LIMIT;
    else process.env.JNU_FORCE_RATE_LIMIT = prevForce;
  }
});

