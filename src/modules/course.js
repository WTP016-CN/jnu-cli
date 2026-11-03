import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { invalidArgument, upstreamChanged } from '../lib/errors.js';
import { JWXT_ORIGIN } from '../lib/jwxt.js';
import {
  WEEKDAY_NAMES,
  isoWeekday,
  parseJnuTimetableRows,
  weekOffset
} from '../parsers/course-parser.js';
import { buildCourseIcs, normalizeSectionTimes } from '../parsers/ics.js';
import { describeTerm, normalizeTerm, termToSchoolYear } from './term.js';

const TIMETABLE_PATH = '/jwapp/sys/wdkb/modules/xskcb/xskcb.do';
const CURRENT_WEEK_PATH = '/jwapp/sys/wdkb/modules/jshkcb/dqzc.do';
const SEMESTER_CALENDAR_PATH = '/jwapp/sys/wdkb/modules/xskcb/cxxljc.do';
const COURSE_REFERER = `${JWXT_ORIGIN}/jwapp/sys/wdkb/*default/index.do?...#/xskcb`;

export function jnuTermCode(term) {
  const parsed = termToSchoolYear(term);
  if (!parsed) throw invalidArgument(`Cannot convert "${term}" to a JNU academic term.`);
  return `${parsed.schoolYear}-${parsed.semester}`;
}

/**
 * JNU has not exposed a current-term JSON endpoint in the captured surface.
 * Infer the academic year from the local date; the captured week endpoint then
 * validates that the semester is active.
 */
export function inferCurrentTerm(date = new Date()) {
  const month = date.getMonth() + 1;
  const startYear = month >= 8 ? date.getFullYear() : date.getFullYear() - 1;
  const semester = month >= 8 || month === 1 ? 1 : 2;
  return `${startYear}-${semester}`;
}

async function resolveCourseTerm(client, termOption) {
  const term = normalizeTerm(termOption);
  return term === 'current' ? inferCurrentTerm() : term;
}

function extractModuleRows(payload, moduleKey) {
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

export async function fetchCurrentSemesterPosition(client, term, date = new Date()) {
  const parsed = termToSchoolYear(term);
  if (!parsed) throw invalidArgument(`Invalid term "${term}".`);
  const response = await client.postForm(CURRENT_WEEK_PATH, {
    XN: parsed.schoolYear,
    XQ: parsed.semester,
    RQ: formatDate(date)
  }, {
    referer: COURSE_REFERER,
    skipCaptureGuard: true
  });
  const rows = extractModuleRows(response);
  if (!Array.isArray(rows)) {
    throw upstreamChanged('dqzc.do did not return a rows array.', {
      keys: Object.keys(response?.datas ?? response?.data ?? response ?? {})
    });
  }
  const row = rows[0];
  const week = Number(row?.ZC);
  const weekday = Number(row?.XQJ);
  return {
    week: Number.isInteger(week) && week > 0 ? week : null,
    weekday: Number.isInteger(weekday) && weekday >= 1 && weekday <= 7 ? weekday : null
  };
}

export async function fetchSemesterCalendar(client, term) {
  const parsed = termToSchoolYear(term);
  if (!parsed) throw invalidArgument(`Invalid term "${term}".`);
  const response = await client.postForm(SEMESTER_CALENDAR_PATH, {
    XN: parsed.schoolYear,
    XQ: parsed.semester
  }, {
    referer: COURSE_REFERER,
    skipCaptureGuard: true
  });
  const rows = extractModuleRows(response);
  if (!Array.isArray(rows)) {
    throw upstreamChanged('cxxljc.do did not return a rows array.', {
      keys: Object.keys(response?.datas ?? response?.data ?? response ?? {})
    });
  }
  const row = rows[0] ?? {};
  const totalWeeks = Number(row.ZZC);
  const startDate = normalizeDate(row.XQKSRQ);
  return {
    totalWeeks: Number.isInteger(totalWeeks) && totalWeeks > 0 ? totalWeeks : null,
    startDate
  };
}

export async function fetchWeekTimetable(client, { term, week, raw = false } = {}) {
  const form = { XNXQDM: jnuTermCode(term) };
  if (week !== undefined && week !== null) form.SKZC = String(week);
  const response = await client.postForm(TIMETABLE_PATH, form, {
    referer: COURSE_REFERER,
    skipCaptureGuard: true
  });
  const rows = extractModuleRows(response, 'xskcb');
  if (!Array.isArray(rows)) {
    throw upstreamChanged('xskcb.do did not return datas.xskcb.rows.', {
      keys: Object.keys(response?.datas ?? response?.data ?? response ?? {})
    });
  }
  return {
    entries: parseJnuTimetableRows(rows, { term, week }),
    ...(raw ? { raw: rows } : {})
  };
}

export async function listCourses(client, { term: termOption, week: weekOption, weekday, raw } = {}) {
  const term = await resolveCourseTerm(client, termOption);
  const position = await fetchCurrentSemesterPosition(client, term);
  const currentWeek = position.week;
  const week = weekOption ?? currentWeek;
  if (!week) {
    throw invalidArgument(`JNU JWXT did not report a current teaching week for ${term}; pass --week <n>.`);
  }
  const { entries, raw: rawRows } = await fetchWeekTimetable(client, { term, week, raw });
  const filtered = weekday ? entries.filter((entry) => entry.weekday === weekday) : entries;
  return {
    term,
    termLabel: describeTerm(term),
    week,
    currentWeek,
    ...(weekday ? { weekday, weekdayName: WEEKDAY_NAMES[weekday - 1] } : {}),
    count: filtered.length,
    courses: filtered,
    ...(raw ? { raw: rawRows } : {})
  };
}

/**
 * Courses on a given local date (default today), mapped to the teaching week
 * reported by JNU's current-week endpoint.
 */
export async function coursesOnDate(client, { date, raw } = {}) {
  const today = new Date();
  const target = date ?? today;
  const term = await resolveCourseTerm(client, 'current');
  const position = await fetchCurrentSemesterPosition(client, term);
  const currentWeek = position.week;
  if (!currentWeek) {
    throw invalidArgument(`JNU JWXT did not report a current teaching week for ${term}; use \`course list --week <n>\` instead.`);
  }
  const week = currentWeek + weekOffset(today, target);
  const weekday = date === undefined
    ? position.weekday ?? isoWeekday(target)
    : isoWeekday(target);
  if (week < 1) {
    return emptyDay({
      term,
      week,
      currentWeek,
      target,
      weekday,
      note: 'Date is before the first teaching week of the current term.'
    });
  }
  const { entries, raw: rawRows } = await fetchWeekTimetable(client, { term, week, raw });
  const courses = entries.filter((entry) => entry.weekday === weekday);
  return {
    term,
    termLabel: describeTerm(term),
    date: formatDate(target),
    week,
    currentWeek,
    weekday,
    weekdayName: WEEKDAY_NAMES[weekday - 1],
    count: courses.length,
    courses,
    ...(raw ? { raw: rawRows } : {})
  };
}

function emptyDay({ term, week, currentWeek, target, weekday, note }) {
  return {
    term,
    termLabel: describeTerm(term),
    date: formatDate(target),
    week,
    currentWeek,
    weekday,
    weekdayName: WEEKDAY_NAMES[weekday - 1],
    count: 0,
    courses: [],
    note
  };
}

export function formatDate(date) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function normalizeDate(value) {
  const match = String(value ?? '').match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (!match) return null;
  return `${match[1]}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')}`;
}

function addDays(dateString, offset) {
  const [year, month, day] = dateString.split('-').map(Number);
  return formatDate(new Date(year, month - 1, day + offset));
}

export async function exportCoursesIcs(client, { term: termOption, week, fromWeek, toWeek, out } = {}) {
  const term = await resolveCourseTerm(client, termOption);
  const position = await fetchCurrentSemesterPosition(client, term);
  const currentWeek = position.week;
  const start = week ?? fromWeek ?? currentWeek ?? 1;
  const end = week ?? toWeek ?? start;
  if (start > end || end - start > 25) {
    throw invalidArgument('Invalid week range for `course export-ics` (ensure --from-week <= --to-week and span <= 25 weeks).');
  }

  const [{ entries }, calendar] = await Promise.all([
    fetchWeekTimetable(client, { term }),
    fetchSemesterCalendar(client, term)
  ]);
  if (!calendar.startDate) {
    throw upstreamChanged('cxxljc.do did not return XQKSRQ in a recognized date format.', calendar);
  }

  const allEntries = [];
  for (let targetWeek = start; targetWeek <= end; targetWeek += 1) {
    for (const entry of entries) {
      if (Array.isArray(entry.weeks) && entry.weeks.length && !entry.weeks.includes(targetWeek)) continue;
      allEntries.push({
        ...entry,
        week: targetWeek,
        date: addDays(calendar.startDate, (targetWeek - 1) * 7 + (entry.weekday - 1))
      });
    }
  }

  const { ics, eventCount } = buildCourseIcs(allEntries, {
    sectionTimes: normalizeSectionTimes(),
    calendarName: `JNU ${term} 课表`
  });

  const outFile = out ? resolve(out) : null;
  if (outFile) {
    await mkdir(dirname(outFile), { recursive: true });
    await writeFile(outFile, ics, 'utf8');
  }

  return {
    term,
    termLabel: describeTerm(term),
    fromWeek: start,
    toWeek: end,
    eventCount,
    ...(outFile ? { file: outFile } : { ics })
  };
}
