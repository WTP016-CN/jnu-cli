import assert from 'node:assert/strict';
import test from 'node:test';

import { parseJnuTimetableRows, parseJnuWeeks } from '../src/parsers/course-parser.js';

function row(overrides = {}) {
  return {
    KCM: '高等数学',
    KCH: 'MATH101',
    KXH: '01',
    JXBID: 'MATH101-01',
    SKXQ: '1',
    KSJC: '1',
    JSJC: '2',
    SKJS: '张老师,李老师',
    JASMC: '教学楼B201',
    SKZC: '111111111111111100',
    ISTK: '0',
    XKWZSM: '',
    KKDWDM_DISPLAY: '信息科学技术学院',
    XXXQDM_DISPLAY: '番禺校区',
    ...overrides
  };
}

test('parses JNU timetable fields, weeks, duplicates, and consecutive sections', () => {
  const entries = parseJnuTimetableRows([
    row(),
    row(),
    row({ KSJC: '3', JSJC: '3' }),
    row({ KSJC: '5', JSJC: '5' }),
    row({
      KCM: '大学英语',
      KCH: 'ENG101',
      KXH: '02',
      JXBID: 'ENG101-02',
      SKXQ: '3',
      KSJC: '3',
      JSJC: '4',
      SKJS: '王老师',
      JASMC: '教学楼A104',
      SKZC: '111111110000000000',
      XKWZSM: '需携带耳机',
      KKDWDM_DISPLAY: '外国语学院'
    })
  ], { term: '2026-1', week: 8 });

  assert.equal(entries.length, 3);
  assert.deepEqual(entries[0], {
    term: '2026-1',
    week: 8,
    weekday: 1,
    weekdayName: '周一',
    startSection: 1,
    endSection: 3,
    sections: '1-3',
    courseName: '高等数学',
    courseCode: 'MATH101',
    classCode: '01',
    classSectionId: 'MATH101-01',
    teacher: '张老师,李老师',
    location: '教学楼B201',
    campus: '番禺校区',
    department: '信息科学技术学院',
    weeks: Array.from({ length: 16 }, (_, index) => index + 1),
    notes: null,
    isAdjusted: false
  });
  assert.equal(entries[1].sections, '5');
  assert.equal(entries[2].courseName, '大学英语');
  assert.equal(entries[2].weeks.length, 8);
  assert.equal(entries[2].notes, '需携带耳机');
});

test('filters rows using SKZC and keeps non-contiguous sections separate', () => {
  const entries = parseJnuTimetableRows([
    row(),
    row({ KCM: '大学英语', KCH: 'ENG101', KXH: '02', JXBID: 'ENG101-02', SKXQ: '3', KSJC: '3', JSJC: '4', SKZC: '111111110000000000' })
  ], { term: '2026-1', week: 9 });

  assert.equal(entries.length, 1);
  assert.equal(entries[0].courseName, '高等数学');
});

test('supports one-character week flags returned by a server-filtered response', () => {
  const entries = parseJnuTimetableRows([
    row({ SKZC: '1' }),
    row({ KCM: '大学英语', KCH: 'ENG101', KXH: '02', JXBID: 'ENG101-02', SKXQ: '3', SKZC: '0' })
  ], { term: '2026-1', week: 9 });

  assert.equal(entries.length, 1);
  assert.deepEqual(entries[0].weeks, [9]);
});

test('parses common SKZC bit strings and week ranges', () => {
  assert.deepEqual(parseJnuWeeks('11110000'), [1, 2, 3, 4]);
  assert.deepEqual(parseJnuWeeks('1-4,6'), [1, 2, 3, 4, 6]);
  assert.deepEqual(parseJnuWeeks('1,3,5'), [1, 3, 5]);
});
