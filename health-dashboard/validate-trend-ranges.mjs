// H2.3 趋势 7/30 天切换与三类日期标记 validation.
// Runs the REAL production pure module (server/src/trend-ranges.ts —
// no imports, all logic exported) over synthetic fixtures only; no
// real health data is ever used. Covers: (1) 7/30-day window bounds
// ending at dataDate with per-metric series (missing stays null,
// never 0), (2) insufficient history labelled 「仅 X 天数据」 with
// observed days counted from the first stored date — pre-history
// dates are neither zero-padded nor counted as missing segments,
// (3) missing segments: consecutive all-metric-missing dates merge,
// a status date breaks a segment and is itself never "missing",
// (4) training days flagged per source (strength / HealthKit),
// (5) baseline caliber (28-day median gated at ≥14 valid days;
// sleep ≤14-night mean gated at ≥8) and the practical-difference
// thresholds (HRV ±10%, resting HR ±3 bpm, sleep ±30 min, steps
// ±20%) — at-threshold marks, below-threshold does not, status
// dates are never deviation-marked, an insufficient baseline marks
// nothing, (6) readiness points read from the archive alone (a null
// score and a missing row are both gaps), and (7) partial-day /
// after-dataDate rows and conflicting duplicate rows excluded.
// Three source mutations are executed for real (resting-HR
// threshold raised, history note suppressed, status break removed
// from the missing scan) and each must flip its assertion. Pure
// Node, no deps.
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';

const trendSrc = readFileSync(new URL('./server/src/trend-ranges.ts', import.meta.url), 'utf8');
const serverSrc = readFileSync(new URL('./server/src/actions.ts', import.meta.url), 'utf8');
const clientSrc = readFileSync(new URL('./client/src/App.tsx', import.meta.url), 'utf8');

let passed = 0;
let failures = 0;
function check(name, ok, note = '') {
  if (ok) passed++;
  else failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${note ? ` (${note})` : ''}`);
}

function buildModule(src) {
  const code = stripTypeScriptTypes(src.replace(/^export /gm, ''));
  return new Function(`${code}\nreturn { computeTrendRanges, trendDeviationDirection, trendThresholdFor, trendMedian, trendMean, TREND_BASELINE_MIN_DAYS, TREND_RESTING_HR_THRESHOLD_BPM };`)();
}
const { computeTrendRanges, trendDeviationDirection, trendMedian } = buildModule(trendSrc);

// ------------------------------------------------------------ source checks
check('source: trend-ranges module has no imports (pure module)', !/^import /m.test(trendSrc));
check('source: server imports computeTrendRanges from the pure module',
  serverSrc.includes('import { computeTrendRanges, type TrendRangesResult } from "./trend-ranges";'));
check('source: getDashboard response carries the additive trendRanges field',
  serverSrc.includes('trendRanges: trendRangesSchema.nullable()') && serverSrc.includes('buildTrendRanges(ctx, snapshot, readinessDate, statusPeriods)'));
check('source: non-owner and health-missing paths return trendRanges null (no data leaks)',
  (serverSrc.match(/trendRanges: null/g) ?? []).length === 2);
check('source: client renders the 7/30 switch, the legend caliber, and the marks list',
  clientSrc.includes('趋势窗口切换，7 天或 30 天') && clientSrc.includes('标记图例与判定口径')
  && clientSrc.includes('TrendMarksSummary') && clientSrc.includes('activeWindow.historyNote'));
check('source: client never computes trend windows itself',
  !clientSrc.includes('computeTrendRanges') && !clientSrc.includes('trendDeviationDirection'));

// ------------------------------------------------------------ fixtures
const DATA_DATE = '2026-10-28';
const shift = (date, days) => {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};
const dateRange = (start, days) => Array.from({ length: days }, (_, i) => shift(start, i));
// 30 full days 2026-09-29..2026-10-28 at flat values, with overrides.
function flatDaily(overrides = {}) {
  return dateRange('2026-09-29', 30).map((date) => ({
    date, steps: 8000, restingHr: 60, hrvMs: 50, ...(overrides[date] ?? {}),
  }));
}
function flatNights(overrides = {}) {
  return dateRange('2026-09-29', 30).map((date) => ({ date, hours: 7, ...(overrides[date] ?? {}) }));
}
const baseInput = (extra = {}) => ({
  daily: flatDaily(),
  nights: flatNights(),
  readiness: [],
  strengthTrainingDates: [],
  hkWorkoutDates: [],
  statusDates: [],
  anchorDate: '2026-10-29',
  dataDate: DATA_DATE,
  partialDate: '2026-10-29',
  ...extra,
});
const win = (result, days) => result.windows.find((w) => w.days === days);
const metric = (w, key) => w.metrics.find((m) => m.key === key);
const point = (w, key, date) => metric(w, key).points.find((p) => p.date === date);

// ------------------------------------------------- (1) windows and series
{
  const r = computeTrendRanges(baseInput());
  const w7 = win(r, 7);
  const w30 = win(r, 30);
  check('windows: 7-day window is 10-22..10-28 and 30-day window is 09-29..10-28, both ending at dataDate',
    w7.windowStart === '2026-10-22' && w7.windowEnd === DATA_DATE
    && w30.windowStart === '2026-09-29' && w30.windowEnd === DATA_DATE);
  check('windows: full history is fully observed with no history note',
    w7.observedDays === 7 && w7.historyNote === null && w30.observedDays === 30 && w30.historyNote === null);
  check('series: every metric carries one point per window day, ascending',
    w30.metrics.every((m) => m.points.length === 30) && w7.metrics.every((m) => m.points.length === 7)
    && w30.metrics[0].points[0].date === '2026-09-29' && w30.metrics[0].points[29].date === DATA_DATE);
  check('series: flat values land on their dates',
    point(w30, 'steps', '2026-10-10').value === 8000 && point(w7, 'hrv', '2026-10-28').value === 50
    && point(w7, 'sleep', '2026-10-22').value === 7);
  const withNull = computeTrendRanges(baseInput({ daily: flatDaily({ '2026-10-25': { hrvMs: null } }) }));
  check('series: a null field stays a null point (never 0) while sibling metrics keep their values',
    point(win(withNull, 7), 'hrv', '2026-10-25').value === null
    && point(win(withNull, 7), 'steps', '2026-10-25').value === 8000);
}

// ------------------------------------------------- (2) insufficient history
{
  const short = baseInput({
    daily: dateRange('2026-10-20', 9).map((date) => ({ date, steps: 8000, restingHr: 60, hrvMs: 50 })),
    nights: dateRange('2026-10-20', 9).map((date) => ({ date, hours: 7 })),
  });
  const r = computeTrendRanges(short);
  const w30 = win(r, 30);
  const w7 = win(r, 7);
  check('history: a 9-day history labels the 30-day window 「仅 9 天数据」 and leaves the 7-day window unlabelled',
    w30.observedDays === 9 && w30.historyNote === '仅 9 天数据' && w7.observedDays === 7 && w7.historyNote === null);
  check('history: pre-history points are null gaps, and pre-history dates form no missing segment',
    w30.metrics[0].points[0].date === '2026-09-29' && w30.metrics[0].points[0].value === null
    && w30.missingSegments.length === 0 && w30.missingDates.length === 0);
  check('history: daily baselines are insufficient at 9 valid days (< 14) while the sleep baseline (≥ 8 nights) stands',
    metric(w30, 'hrv').baseline === null && metric(w30, 'hrv').baselineSufficient === false
    && metric(w30, 'sleep').baseline === 7 && metric(w30, 'sleep').baselineSufficient === true
    && w30.deviations.length === 0);
}

// ------------------------------------------------- (3) missing segments
{
  const gapDaily = dateRange('2026-10-01', 28).map((date) => ({
    date,
    steps: ['2026-10-10', '2026-10-11', '2026-10-12'].includes(date) ? null : 5000,
    restingHr: null, hrvMs: null,
  }));
  const gapNights = dateRange('2026-10-01', 28)
    .filter((date) => !['2026-10-10', '2026-10-11', '2026-10-12'].includes(date))
    .map((date) => ({ date, hours: 7 }));
  const noStatus = computeTrendRanges(baseInput({ daily: gapDaily, nights: gapNights }));
  check('missing: three consecutive all-missing dates merge into one 3-day segment',
    win(noStatus, 30).missingSegments.length === 1
    && win(noStatus, 30).missingSegments[0].startDate === '2026-10-10'
    && win(noStatus, 30).missingSegments[0].endDate === '2026-10-12'
    && win(noStatus, 30).missingSegments[0].days === 3);
  const withStatus = computeTrendRanges(baseInput({ daily: gapDaily, nights: gapNights, statusDates: ['2026-10-11'] }));
  check('missing: a status date is never missing and breaks the segment in two',
    win(withStatus, 30).missingSegments.length === 2
    && win(withStatus, 30).missingSegments.every((s) => s.days === 1)
    && !win(withStatus, 30).missingDates.includes('2026-10-11'));
  const partialDay = computeTrendRanges(baseInput({
    daily: flatDaily({ '2026-10-15': { steps: null, restingHr: null, hrvMs: null } }),
  }));
  check('missing: a date with one valid metric (sleep) is not a missing date',
    !win(partialDay, 30).missingDates.includes('2026-10-15'));
}

// ------------------------------------------------- (4) training days
{
  const r = computeTrendRanges(baseInput({
    strengthTrainingDates: ['2026-10-27'],
    hkWorkoutDates: ['2026-10-27', '2026-10-26'],
  }));
  const days = win(r, 7).trainingDays;
  check('training: strength and HealthKit dates are flagged per source and stack on the same day',
    days.length === 2
    && days.find((d) => d.date === '2026-10-26')?.hkWorkout === true
    && days.find((d) => d.date === '2026-10-26')?.strength === false
    && days.find((d) => d.date === '2026-10-27')?.strength === true
    && days.find((d) => d.date === '2026-10-27')?.hkWorkout === true);
  check('training: a window with no workouts has no training days',
    win(computeTrendRanges(baseInput()), 7).trainingDays.length === 0);
}

// ------------------------------------------------- (5) baselines and deviations
{
  const r = computeTrendRanges(baseInput({
    daily: flatDaily({
      '2026-10-27': { hrvMs: 56 },        // +6 vs median 50 ≥ +10% → mark
      '2026-10-26': { hrvMs: 54 },        // +4 < +10% → no mark
      '2026-10-25': { restingHr: 63 },    // +3 = threshold → mark
      '2026-10-24': { restingHr: 62.9 },  // +2.9 < 3 → no mark
      '2026-10-23': { steps: 10000 },     // +25% ≥ +20% → mark
      '2026-10-22': { steps: 9500 },      // +18.75% < +20% → no mark
    }),
    nights: flatNights({ '2026-10-21': { hours: 6.4 } }), // ≈ −0.56 h vs mean ≈ 6.96 → mark ▼
  }));
  const w7 = win(r, 7);
  check('baseline: HRV/resting-HR/steps baselines are the 28-day medians, sleep the ≤14-night mean',
    metric(w7, 'hrv').baseline === 50 && metric(w7, 'hrv').baselineDays === 28
    && metric(w7, 'restingHr').baseline === 60 && metric(w7, 'steps').baseline === 8000
    && metric(w7, 'sleep').baseline === 6.96 && metric(w7, 'sleep').baselineDays === 14);
  const dev = (key, date) => w7.deviations.find((d) => d.metric === key && d.date === date);
  check('deviation: HRV at +12% marks ▲ 偏高 with value/baseline/offset; +8% stays unmarked',
    dev('hrv', '2026-10-27')?.symbol === '▲' && dev('hrv', '2026-10-27')?.word === '偏高'
    && dev('hrv', '2026-10-27')?.value === 56 && dev('hrv', '2026-10-27')?.offset === 6
    && dev('hrv', '2026-10-26') === undefined);
  check('deviation: resting HR at exactly +3 bpm marks; +2.9 does not',
    dev('restingHr', '2026-10-25') !== undefined && dev('restingHr', '2026-10-24') === undefined);
  check('deviation: steps at +25% marks; +18.75% does not',
    dev('steps', '2026-10-23') !== undefined && dev('steps', '2026-10-22') === undefined);
  const w30 = win(r, 30);
  check('deviation: sleep 6.4 h against a ≈6.96 h baseline marks ▼ 偏低 in the 30-day window',
    w30.deviations.some((d) => d.metric === 'sleep' && d.date === '2026-10-21' && d.symbol === '▼' && d.word === '偏低'));
  const statusDay = computeTrendRanges(baseInput({
    daily: flatDaily({ '2026-10-27': { hrvMs: 90 } }),
    statusDates: ['2026-10-27'],
  }));
  check('deviation: a status date is never deviation-marked, however extreme its value',
    !win(statusDay, 7).deviations.some((d) => d.date === '2026-10-27'));
  check('deviation direction: zero offset and sub-threshold offsets return null',
    trendDeviationDirection('restingHr', 60, 60) === null
    && trendDeviationDirection('hrv', 54, 50) === null
    && trendDeviationDirection('sleep', 6.5, 7)?.word === '偏低');
  check('median: an even-count median averages the two middle values',
    trendMedian([40, 60, 40, 60]) === 50 && trendMedian([10, 30, 20]) === 20);
}

// ------------------------------------------------- (6) readiness archive points
{
  const r = computeTrendRanges(baseInput({
    readiness: [{ date: '2026-10-28', score: 7.5 }, { date: '2026-10-27', score: null }],
  }));
  const pts = win(r, 7).readiness;
  check('readiness: archived score lands on its date; a null score and an unarchived date are both gaps',
    pts.find((p) => p.date === '2026-10-28')?.value === 7.5
    && pts.find((p) => p.date === '2026-10-27')?.value === null
    && pts.find((p) => p.date === '2026-10-26')?.value === null
    && pts.length === 7);
}

// ------------------------------------------------- (7) exclusions
{
  const r = computeTrendRanges(baseInput({
    daily: [
      ...flatDaily(),
      { date: '2026-10-29', steps: 99999, restingHr: 30, hrvMs: 200 }, // partial day / after dataDate
      { date: '2026-10-15', steps: 1, restingHr: 60, hrvMs: 50 },      // conflicts with the flat 8000 row
    ],
  }));
  const w30 = win(r, 30);
  check('exclusions: rows after dataDate never enter a window or a baseline',
    w30.windowEnd === DATA_DATE && point(w30, 'steps', '2026-10-28').value === 8000
    && metric(w30, 'steps').baseline === 8000);
  check('exclusions: a conflicting duplicate makes the disagreed field missing, never an arbitrary pick',
    point(w30, 'steps', '2026-10-15').value === null && point(w30, 'restingHr', '2026-10-15').value === 60);
  check('exclusions: an invalid dataDate yields no result at all',
    computeTrendRanges(baseInput({ dataDate: '2026-02-30' })) === null);
}

// ------------------------------------------------------- mutation sensitivity
{
  const fixture = baseInput({ daily: flatDaily({ '2026-10-25': { restingHr: 63 } }) });
  const thresholdMutant = buildModule(trendSrc.replace('TREND_RESTING_HR_THRESHOLD_BPM = 3', 'TREND_RESTING_HR_THRESHOLD_BPM = 30'));
  check('mutation: raising the resting-HR threshold to 30 flips the +3 bpm mark',
    win(computeTrendRanges(fixture), 7).deviations.some((d) => d.metric === 'restingHr')
    && !win(thresholdMutant.computeTrendRanges(fixture), 7).deviations.some((d) => d.metric === 'restingHr'));
  const short = baseInput({
    daily: dateRange('2026-10-20', 9).map((date) => ({ date, steps: 8000, restingHr: 60, hrvMs: 50 })),
    nights: [],
  });
  const noteMutant = buildModule(trendSrc.replace('observedDays < days ? `仅 ${observedDays} 天数据` : null', 'null'));
  check('mutation: suppressing the history note flips the 「仅 X 天数据」 assertion',
    win(computeTrendRanges(short), 30).historyNote === '仅 9 天数据'
    && win(noteMutant.computeTrendRanges(short), 30).historyNote === null);
  const gapDaily = dateRange('2026-10-01', 28).map((date) => ({
    date,
    steps: ['2026-10-10', '2026-10-11', '2026-10-12'].includes(date) ? null : 5000,
    restingHr: null, hrvMs: null,
  }));
  const gapNights = dateRange('2026-10-01', 28)
    .filter((date) => !['2026-10-10', '2026-10-11', '2026-10-12'].includes(date))
    .map((date) => ({ date, hours: 7 }));
  const breakMutant = buildModule(trendSrc.replace('      if (statusSet.has(date)) continue;\n      const hasAny', '      const hasAny'));
  check('mutation: removing the status break merges the split segments back into one',
    win(computeTrendRanges(baseInput({ daily: gapDaily, nights: gapNights, statusDates: ['2026-10-11'] })), 30).missingSegments.length === 2
    && win(breakMutant.computeTrendRanges(baseInput({ daily: gapDaily, nights: gapNights, statusDates: ['2026-10-11'] })), 30).missingSegments.length === 1);
}

console.log(`\n${passed} passed, ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
