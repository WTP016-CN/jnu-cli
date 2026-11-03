const FIELD_CANDIDATES = {
  courseName: ['KCM', 'scoCourseName', 'courseName', 'kcmc'],
  courseCode: ['KCH', 'scoCourseNumber', 'courseNo', 'courseCode', 'kch'],
  classSerial: ['KXH'],
  classId: ['JXBID'],
  courseType: ['KCLBDM_DISPLAY', 'scoCourseCategoryName', 'scoCourseTypeName', 'courseTypeName', 'kclb'],
  courseNature: ['KCXZDM_DISPLAY', 'scoCourseNatureName', 'scoCourseNature'],
  department: ['KKDWDM_DISPLAY'],
  credit: ['XF', 'scoCredit', 'credit', 'courseCredit', 'xf'],
  score: ['ZCJ', 'scoFinalScore', 'score', 'scoreValue', 'cj'],
  gradePoint: ['JDF', 'scoPoint', 'gradePoint', 'point', 'jd'],
  rank: ['teachClassRank', 'scoRank', 'rank', 'pm'],
  examNature: ['scoExamNatureName', 'scoExamNature', 'examNature', 'examType', 'ksxz'],
  assessmentMethod: ['scoAssessTypeName', 'scoAssessType', 'assessmentMethod', 'khfs'],
  scoreFlag: ['scoScoreFlag', 'scoScoreSign', 'scoreFlag', 'cjbz'],
  passed: ['SFJG']
};

export function firstValue(row, keys) {
  for (const key of keys) {
    const value = row?.[key];
    if (value !== undefined && value !== null && String(value).trim() !== '') {
      return String(value).trim();
    }
  }
  return null;
}

export function toNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function parseGradeRows(rows, { term } = {}) {
  if (!Array.isArray(rows)) return [];
  return rows
    .filter((row) => row && typeof row === 'object')
    .map((row) => ({
      term: firstValue(row, ['XNXQDM']) ?? term ?? null,
      courseName: firstValue(row, FIELD_CANDIDATES.courseName),
      courseCode: firstValue(row, FIELD_CANDIDATES.courseCode),
      classSerial: firstValue(row, FIELD_CANDIDATES.classSerial),
      classId: firstValue(row, FIELD_CANDIDATES.classId),
      courseType: firstValue(row, FIELD_CANDIDATES.courseType),
      courseNature: firstValue(row, FIELD_CANDIDATES.courseNature),
      department: firstValue(row, FIELD_CANDIDATES.department),
      credit: toNumber(firstValue(row, FIELD_CANDIDATES.credit)),
      score: firstValue(row, FIELD_CANDIDATES.score),
      gradePoint: toNumber(firstValue(row, FIELD_CANDIDATES.gradePoint)),
      rank: firstValue(row, FIELD_CANDIDATES.rank),
      examNature: firstValue(row, FIELD_CANDIDATES.examNature),
      assessmentMethod: firstValue(row, FIELD_CANDIDATES.assessmentMethod),
      scoreFlag: firstValue(row, FIELD_CANDIDATES.scoreFlag),
      passed: toBoolean(firstValue(row, FIELD_CANDIDATES.passed))
    }))
    .sort((a, b) => String(a.courseName ?? '').localeCompare(String(b.courseName ?? ''), 'zh-CN'));
}

function toBoolean(value) {
  if (value === null) return null;
  if (['1', 'true', '是', '及格'].includes(value.toLowerCase())) return true;
  if (['0', 'false', '否', '不及格'].includes(value.toLowerCase())) return false;
  return null;
}

/**
 * Credit-weighted GPA computed locally from the returned rows, as a cross-check
 * for the official figure. Rows without credit or grade point are skipped.
 */
export function computeWeightedGpa(entries) {
  let credits = 0;
  let weighted = 0;
  for (const entry of entries) {
    if (entry.credit === null || entry.gradePoint === null) continue;
    credits += entry.credit;
    weighted += entry.credit * entry.gradePoint;
  }
  return {
    courses: entries.length,
    gradedCredits: round(credits),
    weightedGpa: credits > 0 ? round(weighted / credits, 3) : null
  };
}

function round(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
