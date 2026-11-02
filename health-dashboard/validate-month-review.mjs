// H4.5 月度回顾与长期基线漂移 (monthly review vs long-term
// baseline) validation. Runs the REAL production pure module
// (server/src/month-review.ts — no imports, all logic exported)
// over synthetic fixtures only; no real health data is ever used.
// Covers: (1) the review window is the previous COMPLETE calendar
// month, (2) the public baseline calibers — HRV / resting-HR /
// steps medians over the ≤28 days ending at the month's end gated
// at ≥14 valid days, sleep on the H4.3 caliber (mean of the most
// recent ≤14 nights, ≥8 gate), (3) month means over valid days
// only — status dates excluded via the caller's status set, the
// partial day and post-dataDate rows never counted, missing dates
// counted and listed, never zero-filled, (4) the H3 week-review
// practical thresholds (HRV ±10%, resting HR ±3 bpm, sleep
// ±30 min, steps ±20%) driving 偏高 / 偏低 / 与基线接近, with
// 无法判断 (null offset/direction) whenever a gate fails, and
// (5) the wiring: the additive getDashboard.monthReview field on
// all three return paths and a render-only client. Three source
// mutations are executed for real (median swapped for mean, status
// exclusion removed, HRV threshold zeroed) and each must flip the
// corresponding assertion. Pure Node, no deps.
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';

const reviewSrc = readFileSync(new URL('./server/src/month-review.ts', import.meta.url), 'utf8');
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
  return new Function(`${code}\nreturn { computeMonthReview, previousMonthWindow, monthReviewDirection, monthReviewMedian, monthReviewMean, MONTH_REVIEW_BASELINE_MIN_DAYS, MONTH_REVIEW_MIN_VALID_DAYS };`)();
}
const { computeMonthReview, previousMonthWindow, monthReviewDirection, monthReviewMedian, monthReviewMean } = buildModule(reviewSrc);

// ------------------------------------------------------------ source checks
check('source: month-review module has no imports (pure module)', !/^import /m.test(reviewSrc));
check('source: server imports computeMonthReview from the pure module',
  serverSrc.includes('import { computeMonthReview, type MonthReviewResult } from "./month-review";'));
check('source: getDashboard response carries the additive monthReview field',
  serverSrc.includes('monthReview: monthReviewSchema.nullable()'));
check('source: all three getDashboard return paths carry monthReview (forbidden / health-missing null, main computed)',
  (serverSrc.match(/monthReview: null/g) ?? []).length === 2
  && serverSrc.includes('const monthReview = buildMonthReview(snapshot, readinessDate, statusPeriods);')
  && serverSrc.includes('statusMode, monthReview, readinessHistory,'));
check('source: server feeds the module main sleeps only (CWEB-SLEEP-001 selection) and H4.4 status dates',
  serverSrc.includes('const main = selectMainSleep(rows);')
  && serverSrc.includes('statusDates: statusDatesInWindow(statusPeriods, shiftDate(readinessDate, -75), readinessDate)'));
check('source: readiness formula untouched (baseline selection caliber intact)',
  serverSrc.includes('const historyBeforeDate = excludeStatusDates(snapshot.historyDaily.filter((row) => row.date < snapshot.dataDate).slice(-14), statusPeriods);'));
check('source: client renders the month-review panel with the no-trend-verdict disclaimer and the public caliber',
  clientSrc.includes('月度回顾与长期基线漂移') && clientSrc.includes('不下「上升／变好」一类趋势结论') && clientSrc.includes('基线口径与覆盖说明'));
check('source: client never computes a month review itself',
  !clientSrc.includes('computeMonthReview') && clientSrc.includes('monthReview={dashboard.data.monthReview}'));

// ------------------------------------------------------------ fixtures
const ANCHOR = '2026-11-02'; // review month: October 2026 (31 days)
const DATA_DATE = '2026-11-01';
const day = (date, fields) => ({ date, steps: null, restingHr: null, hrvMs: null, ...fields });
const series = (start, days, fieldsFor) => {
  const out = [];
  let date = start;
  for (let i = 0; i < days; i++) {
    out.push(day(date, fieldsFor(date, i)));
    const next = new Date(`${date}T12:00:00Z`);
    next.setUTCDate(next.getUTCDate() + 1);
    date = next.toISOString().slice(0, 10);
  }
  return out;
};
const nights = (start, days, hours) => {
  const out = [];
  let date = start;
  for (let i = 0; i < days; i++) {
    out.push({ date, hours });
    const next = new Date(`${date}T12:00:00Z`);
    next.setUTCDate(next.getUTCDate() + 1);
    date = next.toISOString().slice(0, 10);
  }
  return out;
};
const baseInput = (overrides) => ({
  daily: [], nights: [], statusDates: [], anchorDate: ANCHOR, dataDate: DATA_DATE, partialDate: ANCHOR, ...overrides,
});
const metric = (result, key) => result.metrics.find((entry) => entry.key === key);

// ------------------------------------------- (1) window derivation
{
  const oct = previousMonthWindow('2026-11-02');
  check('window: an anchor in November reviews October (31 days, labelled)',
    oct?.start === '2026-10-01' && oct?.end === '2026-10-31' && oct?.days === 31 && oct?.label === '2026 年 10 月');
  check('window: the 1st of a month still reviews the month just ended',
    previousMonthWindow('2026-11-01')?.start === '2026-10-01');
  check('window: year rollover and leap February resolve correctly',
    previousMonthWindow('2027-01-15')?.label === '2026 年 12 月'
    && previousMonthWindow('2024-03-05')?.days === 29
    && previousMonthWindow('2026-03-10')?.days === 28);
  check('window: an invalid anchor yields no review at all',
    computeMonthReview(baseInput({ anchorDate: '2026-13-40' })) === null && previousMonthWindow('nope') === null);
}

// --------------------------------- (2)+(4) full month: medians, offsets, words
{
  const daily = series('2026-09-28', 35, (date) => ({
    hrvMs: date >= '2026-10-18' ? 60 : date >= '2026-10-04' ? 40 : 50,
    restingHr: date >= '2026-10-01' && date <= '2026-10-03' ? 91 : 60,
    steps: 8000,
  }));
  const r = computeMonthReview(baseInput({ daily, nights: nights('2026-10-18', 14, 7) }));
  const hrv = metric(r, 'hrv');
  check('full: HRV baseline is the ≤28-day median 50 over 28 valid days; month mean 50 over 31 valid days',
    hrv.baseline === 50 && hrv.baselineDays === 28 && hrv.baselineSufficient === true
    && hrv.monthMean === 50 && hrv.validDays === 31 && hrv.missingDates.length === 0);
  check('full: a zero offset reads ● 与基线接近 with the number still shown, and the row is judgeable',
    hrv.offset === 0 && hrv.direction?.symbol === '●' && hrv.direction?.word === '与基线接近' && hrv.judgeable === true);
  const rhr = metric(r, 'restingHr');
  check('full: resting HR offset +3 bpm reaches the ±3 threshold exactly → ▲ 偏高',
    rhr.baseline === 60 && rhr.monthMean === 63 && rhr.offset === 3 && rhr.direction?.symbol === '▲' && rhr.direction?.word === '偏高');
  const steps = metric(r, 'steps');
  check('full: steps baseline is the median 8000 and the flat month reads ● 与基线接近',
    steps.baseline === 8000 && steps.monthMean === 8000 && steps.offset === 0 && steps.direction?.word === '与基线接近');
  const sleep = metric(r, 'sleep');
  check('full: sleep baseline is the H4.3 mean of the 14 recorded nights (7.0 h); 17 October nights are missing and listed',
    sleep.baseline === 7 && sleep.baselineDays === 14 && sleep.monthMean === 7 && sleep.validDays === 14
    && sleep.missingDates.length === 17 && sleep.missingDates[0] === '2026-10-01' && sleep.offset === 0);
  check('full: no trend verdict words anywhere in the result',
    !JSON.stringify(r).includes('上升') && !JSON.stringify(r).includes('变好') && !JSON.stringify(r).includes('变差'));
}

// --------------------------- (2) the median is robust: one extreme day
{
  const daily = series('2026-10-01', 31, (date) => ({ hrvMs: date === '2026-10-31' ? 200 : 50, restingHr: 60, steps: 8000 }));
  const r = computeMonthReview(baseInput({ daily }));
  const hrv = metric(r, 'hrv');
  check('median: one extreme day cannot move the baseline (50, not the 55.4 mean)',
    hrv.baseline === 50 && hrv.baselineDays === 28);
  check('median: month mean 54.8 vs baseline 50 stays inside the 10% threshold → ● 与基线接近',
    hrv.monthMean === 54.8 && hrv.offset === 4.8 && hrv.direction?.word === '与基线接近');
}

// --------------------------- (4) thresholds: steps % and sleep minutes
{
  const stepsDaily = (high) => series('2026-09-28', 35, (date) => ({
    steps: date >= '2026-10-04' && date <= '2026-10-18' ? 8000 : high, restingHr: 60, hrvMs: 50,
  }));
  const pct = computeMonthReview(baseInput({ daily: stepsDaily(14000) }));
  check('threshold: steps month mean 11097 vs median baseline 8000 (+3097 ≥ ±20%) → ▲ 偏高',
    metric(pct, 'steps').baseline === 8000 && metric(pct, 'steps').monthMean === 11097
    && metric(pct, 'steps').offset === 3097 && metric(pct, 'steps').direction?.word === '偏高');
  const inside = computeMonthReview(baseInput({ daily: stepsDaily(9500) }));
  check('threshold: steps offset +774 stays inside the ±20% threshold → ● 与基线接近, offset still printed',
    metric(inside, 'steps').offset === 774 && metric(inside, 'steps').direction?.word === '与基线接近');
  const sleepR = computeMonthReview(baseInput({
    nights: [...nights('2026-09-24', 7, 6), ...nights('2026-10-25', 7, 8)],
  }));
  const sleep = metric(sleepR, 'sleep');
  check('threshold: sleep month mean 8.0 h vs baseline 7.0 h (+60 分钟) → ▲ 偏高; the other 24 October nights are missing',
    sleep.baseline === 7 && sleep.baselineDays === 14 && sleep.monthMean === 8 && sleep.validDays === 7
    && sleep.offset === 1 && sleep.direction?.word === '偏高' && sleep.missingDates.length === 24);
  check('direction unit edges: exact thresholds count as 偏高/偏低, just inside stays 与基线接近',
    monthReviewDirection('hrv', 5, 50).word === '偏高' && monthReviewDirection('hrv', 4.9, 50).word === '与基线接近'
    && monthReviewDirection('restingHr', -3, 60).word === '偏低' && monthReviewDirection('restingHr', 2.9, 60).word === '与基线接近'
    && monthReviewDirection('sleep', 0.5, 7).word === '偏高' && monthReviewDirection('sleep', -0.49, 7).word === '与基线接近'
    && monthReviewDirection('steps', -2000, 10000).word === '偏低');
  check('helpers: median handles odd/even/empty; mean of empty is null',
    monthReviewMedian([3, 1, 2]) === 2 && monthReviewMedian([1, 2, 3, 4]) === 2.5
    && monthReviewMedian([]) === null && monthReviewMean([]) === null);
}

// --------------------------- (4) gates: baseline and month sufficiency
{
  const daily = series('2026-09-28', 35, (date) => ({
    hrvMs: date >= '2026-10-19' && date <= '2026-10-31' ? 50 : null, restingHr: 60, steps: 8000,
  }));
  const r = computeMonthReview(baseInput({ daily }));
  const hrv = metric(r, 'hrv');
  check('gate: 13 baseline valid days → baseline null, offset/direction null, judgeable false （无法判断）',
    hrv.baselineDays === 13 && hrv.baseline === null && hrv.baselineSufficient === false
    && hrv.offset === null && hrv.direction === null && hrv.judgeable === false);
  check('gate: the month side still reports its facts (mean over the 13 valid days, 18 missing listed)',
    hrv.monthMean === 50 && hrv.validDays === 13 && hrv.missingDates.length === 18);
  const fewNights = computeMonthReview(baseInput({ nights: nights('2026-10-25', 7, 7) }));
  check('gate: only 7 recorded nights → sleep baseline insufficient （需 ≥ 8 晚）, nothing judged',
    metric(fewNights, 'sleep').baselineDays === 7 && metric(fewNights, 'sleep').baseline === null
    && metric(fewNights, 'sleep').judgeable === false && metric(fewNights, 'sleep').offset === null);
  const monthGate = computeMonthReview(baseInput({
    nights: [...nights('2026-09-16', 15, 7), ...nights('2026-10-27', 5, 7)],
  }));
  const gatedSleep = metric(monthGate, 'sleep');
  check('gate: a sufficient baseline with only 5 valid month nights still judges nothing',
    gatedSleep.baselineSufficient === true && gatedSleep.baseline === 7 && gatedSleep.validDays === 5
    && gatedSleep.monthMean === 7 && gatedSleep.judgeable === false && gatedSleep.offset === null && gatedSleep.direction === null);
  const empty = computeMonthReview(baseInput({}));
  check('gate: no data at all → month means null (never 0), every date missing, nothing judgeable',
    empty.metrics.every((entry) => entry.monthMean === null && entry.validDays === 0 && entry.judgeable === false)
    && metric(empty, 'steps').missingDates.length === 31);
}

// --------------------------- (3) status exclusion, partial day, dataDate
{
  const daily = series('2026-09-28', 35, (date) => ({
    hrvMs: date >= '2026-10-10' && date <= '2026-10-14' ? 100 : 50, restingHr: 60, steps: 8000,
  }));
  const statusDates = ['2026-10-10', '2026-10-11', '2026-10-12', '2026-10-13', '2026-10-14'];
  const r = computeMonthReview(baseInput({ daily, statusDates }));
  const hrv = metric(r, 'hrv');
  check('status: status days leave the month mean (50 over 26 valid days) and are listed as excluded, not missing',
    hrv.monthMean === 50 && hrv.validDays === 26 && hrv.missingDates.length === 0
    && r.statusExcludedDates.length === 5 && r.statusExcludedDates[0] === '2026-10-10');
  check('status: status days leave the baseline too (23 valid days, median still 50)',
    hrv.baselineDays === 23 && hrv.baseline === 50 && hrv.offset === 0);
  const partial = computeMonthReview(baseInput({
    daily: series('2026-10-01', 31, (date) => ({ hrvMs: date === '2026-10-31' ? 999 : 50, restingHr: 60, steps: 8000 })),
    dataDate: '2026-10-30',
  }));
  const partialHrv = metric(partial, 'hrv');
  check('partial: a row after dataDate never counts — Oct 31 is missing, month mean stays 50 over 30 days',
    partialHrv.monthMean === 50 && partialHrv.validDays === 30
    && partialHrv.missingDates.includes('2026-10-31') && partialHrv.baseline === 50);
  const declared = computeMonthReview(baseInput({
    daily: series('2026-10-01', 31, (date) => ({ hrvMs: date === '2026-10-31' ? 999 : 50, restingHr: 60, steps: 8000 })),
    dataDate: '2026-10-31',
    partialDate: '2026-10-31',
  }));
  check('partial: the caller-declared partial date is excluded the same way',
    metric(declared, 'hrv').monthMean === 50 && metric(declared, 'hrv').validDays === 30);
  const nov = computeMonthReview(baseInput({
    nights: [...nights('2026-10-18', 14, 7), { date: '2026-11-01', hours: 3 }],
  }));
  check('baseline anchor: a night after the review month never enters the sleep baseline',
    metric(nov, 'sleep').baseline === 7 && metric(nov, 'sleep').baselineDays === 14);
}

// ------------------------------------------------------- mutation sensitivity
{
  // (a) median → mean in the daily baseline.
  const daily = series('2026-10-01', 31, (date) => ({ hrvMs: date === '2026-10-31' ? 200 : 50, restingHr: 60, steps: 8000 }));
  const meanMutant = buildModule(reviewSrc.replace(
    'const baselineRaw = values.length >= MONTH_REVIEW_BASELINE_MIN_DAYS ? monthReviewMedian(values) : null;',
    'const baselineRaw = values.length >= MONTH_REVIEW_BASELINE_MIN_DAYS ? monthReviewMean(values) : null;',
  ));
  check('mutation: swapping the baseline median for a mean flips the robust-baseline assertion (50 → 55.4)',
    metric(computeMonthReview(baseInput({ daily })), 'hrv').baseline === 50
    && metric(meanMutant.computeMonthReview(baseInput({ daily })), 'hrv').baseline === 55.4);
  // (b) status exclusion removed.
  const statusDaily = series('2026-09-28', 35, (date) => ({
    hrvMs: date >= '2026-10-10' && date <= '2026-10-14' ? 100 : 50, restingHr: 60, steps: 8000,
  }));
  const statusDates = ['2026-10-10', '2026-10-11', '2026-10-12', '2026-10-13', '2026-10-14'];
  const statusMutant = buildModule(reviewSrc.replace('statusSet.has(date)', 'false'));
  check('mutation: removing the status exclusion flips the month-mean assertion (50 → 58.1)',
    metric(computeMonthReview(baseInput({ daily: statusDaily, statusDates })), 'hrv').monthMean === 50
    && metric(statusMutant.computeMonthReview(baseInput({ daily: statusDaily, statusDates })), 'hrv').monthMean === 58.1);
  // (c) HRV practical threshold zeroed: a +2 ms offset inside ±10%
  // must stop reading 与基线接近.
  const nearDaily = series('2026-10-01', 31, (date) => ({ hrvMs: date === '2026-10-15' ? 112 : 50, restingHr: 60, steps: 8000 }));
  const thresholdMutant = buildModule(reviewSrc.replace(
    'MONTH_REVIEW_HRV_THRESHOLD_PCT = 0.10',
    'MONTH_REVIEW_HRV_THRESHOLD_PCT = 0',
  ));
  check('mutation: zeroing the HRV threshold flips the inside-threshold assertion （与基线接近 → 偏高）',
    metric(computeMonthReview(baseInput({ daily: nearDaily })), 'hrv').direction?.word === '与基线接近'
    && metric(thresholdMutant.computeMonthReview(baseInput({ daily: nearDaily })), 'hrv').direction?.word === '偏高');
}

console.log(`\n${passed} passed, ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
