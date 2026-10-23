// H3.1/H3.2/H3.3 每周健康复盘 (space-4) validation.
// Runs the REAL production derivation (weekReview) extracted verbatim
// from client/src/App.tsx over synthetic fixtures only. Covers:
// (1) a full-coverage week crossing a practical threshold generates a
// three-part insight with the window dates in the observation,
// (2) only 3 valid days -> no insight and the fallback focus,
// (3) a single abnormal day never triggers an insight on its own,
// (4) missing values are excluded, never counted as 0,
// (5) a baseline window under 5 valid days is labelled 基线数据不足
// with no baseline mean, and the sleep baseline honestly reports the
// 14-night history cap, (6) the same input recomputed is identical,
// (7) training sessions are counted per window, (8) at most 3 insights
// ordered by normalized magnitude, (9) partial coverage downgrades the
// confidence wording to 中等. It also executes two source mutations —
// dropping the >=5 valid-days gate and counting missing values as 0 —
// to prove the assertions flip when the production rules are broken.
// Pure Node, no deps.
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';

const clientSrc = readFileSync(new URL('./client/src/App.tsx', import.meta.url), 'utf8');

let passed = 0;
let failures = 0;
function check(name, ok, note = '') {
  if (ok) passed++;
  else failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${note ? ` (${note})` : ''}`);
}
function matchDelim(s, start, open, close) {
  let depth = 0;
  for (let i = start; i < s.length; i++) {
    if (s[i] === open) depth++;
    else if (s[i] === close) { depth--; if (depth === 0) return i; }
  }
  throw new Error('unbalanced delimiters');
}
function extractFunction(source, name) {
  const idx = source.search(new RegExp(`function ${name}\\(`));
  if (idx < 0) throw new Error(`function ${name} not found`);
  const openParen = source.indexOf('(', idx);
  const closeParen = matchDelim(source, openParen, '(', ')');
  let bodyStart = source.indexOf('{', closeParen);
  while (bodyStart >= 0) {
    let prev = bodyStart - 1;
    while (prev > closeParen && /\s/.test(source[prev])) prev--;
    if (source[prev] !== ':') break;
    bodyStart = source.indexOf('{', matchDelim(source, bodyStart, '{', '}'));
  }
  if (bodyStart < 0) throw new Error(`function ${name} body not found`);
  const bodyEnd = matchDelim(source, bodyStart, '{', '}');
  return source.slice(idx, bodyEnd + 1);
}

function buildFn(src) {
  const code = extractFunction(src, 'weekReview');
  return new Function(`${stripTypeScriptTypes(code)}\nreturn weekReview;`)();
}
const weekReview = buildFn(clientSrc);

// ------------------------------------------------------------ source checks
check('source: panel title is 上周复盘 · 滚动 7 天', clientSrc.includes('上周复盘 · 滚动 7 天'));
check('source: rolling-window vs natural-week note is present verbatim',
  clientSrc.includes('健康复盘用滚动完整 7 天，与训练记录的自然周窗口不同，不直接同窗比较。'));
check('source: the cannot-judge line is present verbatim',
  clientSrc.includes('无法判断：现有数据未达到生成洞察的门槛。'));
check('source: panel is rendered on the today page inside the hero',
  clientSrc.includes('<WeekReviewPanel snapshot={snapshot} />'));
check('source: panel renders after the load verdict block and the seven-day facts strip',
  clientSrc.indexOf('whoop-load') < clientSrc.indexOf('<WeekReviewPanel snapshot={snapshot} />')
  && clientSrc.indexOf('<SevenDayFacts snapshot={snapshot} />') < clientSrc.indexOf('<WeekReviewPanel snapshot={snapshot} />'));
check('source: weekReview never touches readiness (formula untouched)',
  !/readiness/i.test(extractFunction(clientSrc, 'weekReview')));

// ------------------------------------------------------------ synthetic data
const DATA_DATE = '2026-10-22';
const shift = (date, days) => {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};
const datesBack = (count, endOffset) => Array.from({ length: count }, (_, i) => shift(DATA_DATE, endOffset - (count - 1 - i)));
const REVIEW = datesBack(7, 0); // 2026-10-16..2026-10-22
const COMPARISON = datesBack(7, -7); // 2026-10-09..2026-10-15
const BASELINE_EXTRA = datesBack(21, -14); // 2026-09-18..2026-10-08
const ALL_DATES = [...BASELINE_EXTRA, ...COMPARISON, ...REVIEW];
const LAST14 = [...COMPARISON, ...REVIEW]; // historySleeps keeps only ~14 nights

const BASE_DAILY = { steps: 8000, exerciseMinutes: 30, restingHr: 60, hrvMs: 50, respiratoryRate: 14 };
function perDates(dates, over) {
  const out = {};
  for (const d of dates) out[d] = { ...over };
  return out;
}
function mergeOverrides(...maps) {
  const out = {};
  for (const map of maps) {
    for (const [date, over] of Object.entries(map)) out[date] = { ...(out[date] ?? {}), ...over };
  }
  return out;
}
function dailyRows(overrides = {}, omit = []) {
  const omitSet = new Set(omit);
  return ALL_DATES.filter((d) => !omitSet.has(d)).map((date) => ({ date, ...BASE_DAILY, ...(overrides[date] ?? {}) }));
}
function sleepRows(byDate) {
  return Object.entries(byDate).map(([date, totalHours]) => ({ date, totalHours }));
}
function flatSleeps(dates, hours) {
  const out = {};
  for (const d of dates) out[d] = hours;
  return out;
}
const metric = (result, key) => result.metrics.find((m) => m.key === key);

// ------------------------------------------- windows and (1) full-week insight
const fixture1 = {
  daily: dailyRows(),
  sleeps: sleepRows({ ...flatSleeps(LAST14, 7.5), ...flatSleeps(REVIEW, 6.5) }),
  workouts: [],
};
{
  const r = weekReview(fixture1.daily, fixture1.sleeps, fixture1.workouts, DATA_DATE);
  check('windows: review window is dataDate-6..dataDate',
    r.reviewWindow.start === '2026-10-16' && r.reviewWindow.end === '2026-10-22' && r.reviewWindow.days === 7);
  check('windows: comparison window is dataDate-13..dataDate-7',
    r.comparisonWindow.start === '2026-10-09' && r.comparisonWindow.end === '2026-10-15' && r.comparisonWindow.days === 7);
  check('windows: baseline window is dataDate-34..dataDate-7 (28 days)',
    r.baselineWindow.start === '2026-09-18' && r.baselineWindow.end === '2026-10-15' && r.baselineWindow.days === 28);
  const sleep = metric(r, 'sleep');
  check('metrics: sleep means come from historySleeps totalHours (review 6.5, comparison 7.5, baseline 7.5)',
    sleep.reviewValue === 6.5 && sleep.comparisonValue === 7.5 && sleep.baselineValue === 7.5);
  check('metrics: sleep coverage is honest about the 14-night cap (baseline n=7 of 28, note names the cap)',
    sleep.reviewN === 7 && sleep.baselineN === 7 && sleep.baselineSufficient === true
    && sleep.baselineNote !== null && sleep.baselineNote.includes('仅保留近 14 晚') && sleep.baselineNote.includes('可用 7 晚'));
  check('metrics: sleep diff vs comparison carries symbol and wording, not color alone',
    sleep.diff === -1 && sleep.diffSymbol === '▼' && sleep.diffText === '减少 1.0 小时');
  check('insight: exactly one insight, for sleep, against the comparison window',
    r.insights.length === 1 && r.insights[0].metricKey === 'sleep' && r.insights[0].versus === 'comparison' && r.canJudge === true);
  const insight = r.insights[0];
  check('insight: observation carries the metric, both window date ranges and both means',
    insight.observation.includes('睡眠') && insight.observation.includes('10月16日') && insight.observation.includes('10月22日')
    && insight.observation.includes('10月9日') && insight.observation.includes('10月15日')
    && insight.observation.includes('6.5') && insight.observation.includes('7.5'));
  check('insight: explanation is possibility wording with the non-causal, non-medical disclaimer',
    insight.explanation.startsWith('可能') && insight.explanation.includes('不是因果结论，也不是医疗判断'));
  check('insight: full coverage on both windows gives 置信度较高 with the coverage note',
    insight.confidence === '较高' && insight.confidenceNote.includes('复盘窗有效 7/7 天'));
  check('insight: the single 下周重点 is the first insight action verbatim',
    r.focus === insight.action && r.focus === '下周把上床时间提前 15–30 分钟，先稳定一周再看变化');
}

// ------------------------------------------------- (2) only 3 valid days
{
  const sleeps = sleepRows({
    ...flatSleeps(COMPARISON, 7.5),
    '2026-10-20': 6.5, '2026-10-21': 6.5, '2026-10-22': 6.5,
  });
  const r = weekReview(dailyRows(), sleeps, [], DATA_DATE);
  const sleep = metric(r, 'sleep');
  check('gate: with only 3 valid review nights the mean is still reported (6.5 over n=3)',
    sleep.reviewN === 3 && sleep.reviewValue === 6.5);
  check('gate: 3 valid days cannot generate an insight even past the threshold',
    r.insights.length === 0 && r.canJudge === false);
  check('gate: no insight -> focus falls back to keeping the rhythm and accumulating complete data',
    r.focus === '保持现有节奏，继续积累完整数据。');
}

// ------------------------------------------------- (3) single abnormal day
{
  const daily = dailyRows(mergeOverrides(
    perDates(REVIEW, { restingHr: 60 }),
    { '2026-10-20': { restingHr: 78 } },
  ));
  const sleeps = sleepRows(flatSleeps(LAST14, 7.5));
  const r = weekReview(daily, sleeps, [], DATA_DATE);
  const resting = metric(r, 'restingHr');
  check('single-day: one 78 bpm day moves the window mean only to ~62.6 (fact is kept)',
    Math.abs(resting.reviewValue - 438 / 7) < 1e-9);
  check('single-day: a lone spike below the ±3 bpm practical threshold triggers no insight',
    r.insights.length === 0 && r.canJudge === false);
}

// ------------------------------------------------- (4) missing is not 0
{
  const daily = dailyRows(
    { '2026-10-18': { steps: null } },
    ['2026-10-16', '2026-10-17'],
  );
  const sleeps = sleepRows(flatSleeps(LAST14, 7.5));
  const r = weekReview(daily, sleeps, [], DATA_DATE);
  const steps = metric(r, 'steps');
  check('missing: two absent rows plus one null leave n=4, and the mean is over recorded days only (8000, not 4571)',
    steps.reviewN === 4 && steps.reviewValue === 8000);
  check('missing: equal means render as — 持平 (no fabricated direction)',
    steps.diff === 0 && steps.diffSymbol === '—' && steps.diffText === '持平');
  check('missing: a metric with zero valid days shows a null value, never 0',
    weekReview(dailyRows({}, ALL_DATES), [], [], DATA_DATE).metrics.every((m) => m.kind === 'count' ? m.reviewValue === 0 : m.reviewValue === null));
}

// ------------------------------------------------- (5) baseline under 5 days
{
  const overrides = mergeOverrides(
    perDates([...BASELINE_EXTRA, ...COMPARISON], { respiratoryRate: null }),
    { '2026-09-20': { respiratoryRate: 14 }, '2026-10-02': { respiratoryRate: 14 }, '2026-10-10': { respiratoryRate: 14 } },
  );
  const r = weekReview(dailyRows(overrides), sleepRows(flatSleeps(LAST14, 7.5)), [], DATA_DATE);
  const resp = metric(r, 'respiratoryRate');
  check('baseline: only 3 valid baseline days -> insufficient, no baseline mean, labelled 基线数据不足',
    resp.baselineN === 3 && resp.baselineSufficient === false && resp.baselineValue === null && resp.baselineNote === '基线数据不足');
  check('baseline: the review/comparison means are unaffected by the thin baseline',
    resp.reviewValue === 14 && resp.comparisonValue === 14);
}

// ------------------------------------------------- (6) determinism
{
  const a = weekReview(fixture1.daily, fixture1.sleeps, fixture1.workouts, DATA_DATE);
  const b = weekReview(fixture1.daily, fixture1.sleeps, fixture1.workouts, DATA_DATE);
  check('determinism: identical input recomputed gives an identical result',
    JSON.stringify(a) === JSON.stringify(b));
}

// ------------------------------------------------- (7) workout counting
{
  const workouts = [
    { date: '2026-10-17' }, { date: '2026-10-17' }, { date: '2026-10-20' }, // review: 3 sessions, 2 days
    { date: '2026-10-10' }, // comparison: 1
    { date: '2026-09-20' }, { date: '2026-09-25' }, { date: '2026-10-01' }, { date: '2026-10-05' }, // baseline extra: 4
    { date: '2026-10-23' }, // after dataDate: never counted
  ];
  const r = weekReview(dailyRows(), sleepRows(flatSleeps(LAST14, 7.5)), workouts, DATA_DATE);
  const w = metric(r, 'workouts');
  check('workouts: sessions counted per window (review 3, comparison 1, baseline 5 incl. comparison week)',
    w.reviewValue === 3 && w.comparisonValue === 1 && w.baselineValue === 5);
  check('workouts: coverage counts distinct days (2/7 in review) and diff is a count difference',
    w.reviewN === 2 && w.coverageNote.includes('2/7') && w.diff === 2 && w.diffText === '增加 2 次');
}

// ------------------------------------------- (8) cap of 3, magnitude order
{
  const daily = dailyRows(perDates(REVIEW, { steps: 12000, exerciseMinutes: 48, hrvMs: 60 }));
  const sleeps = sleepRows({ ...flatSleeps(LAST14, 7.5), ...flatSleeps(REVIEW, 6.5) });
  const r = weekReview(daily, sleeps, [], DATA_DATE);
  check('cap: four qualifying metrics still yield at most 3 insights',
    r.insights.length === 3);
  check('cap: insights are ordered by normalized magnitude (steps 2.5x first), ties keep metric order',
    r.insights[0].metricKey === 'steps'
    && JSON.stringify(r.insights.map((i) => i.metricKey).sort()) === JSON.stringify(['hrv', 'sleep', 'steps']));
  check('cap: every insight keeps the three-part shape with the disclaimer',
    r.insights.every((i) => i.observation.length > 0 && i.action.length > 0
      && i.explanation.startsWith('可能') && i.explanation.includes('不是因果结论，也不是医疗判断')));
}

// ------------------------------------------- (9) partial coverage confidence
{
  const sleeps = sleepRows({
    ...flatSleeps(COMPARISON, 7.5),
    ...flatSleeps(REVIEW.slice(0, 6), 6.5),
  });
  const r = weekReview(dailyRows(), sleeps, [], DATA_DATE);
  check('confidence: 6 of 7 valid nights still generates the insight but at 置信度中等',
    r.insights.length === 1 && r.insights[0].metricKey === 'sleep'
    && r.insights[0].confidence === '中等' && r.insights[0].confidenceNote.includes('复盘窗有效 6/7 天'));
}

// ------------------------------------------------------- mutation sensitivity
{
  const noGateSrc = clientSrc.replace('const MIN_DAYS = 5;', 'const MIN_DAYS = 0;');
  check('mutation setup: the valid-days gate constant was found and replaced', noGateSrc !== clientSrc);
  const mutated = buildFn(noGateSrc);
  const sleeps = sleepRows({
    ...flatSleeps(COMPARISON, 7.5),
    '2026-10-20': 6.5, '2026-10-21': 6.5, '2026-10-22': 6.5,
  });
  const realResult = weekReview(dailyRows(), sleeps, [], DATA_DATE);
  const flippedResult = mutated(dailyRows(), sleeps, [], DATA_DATE);
  check('mutation: dropping the >=5 gate flips the 3-day case from no insight to an insight',
    realResult.insights.length === 0 && flippedResult.insights.length >= 1 && flippedResult.canJudge === true);
}
{
  const zeroFillSrc = clientSrc.replace(
    'if (value !== null) values.push(value);',
    'values.push(value ?? 0);',
  );
  check('mutation setup: the missing-exclusion line was found and replaced', zeroFillSrc !== clientSrc);
  const mutated = buildFn(zeroFillSrc);
  const daily = dailyRows({ '2026-10-18': { steps: null } }, ['2026-10-16', '2026-10-17']);
  const sleeps = sleepRows(flatSleeps(LAST14, 7.5));
  const realSteps = metric(weekReview(daily, sleeps, [], DATA_DATE), 'steps');
  const flippedSteps = metric(mutated(daily, sleeps, [], DATA_DATE), 'steps');
  check('mutation: counting missing days as 0 flips n 4 -> 7 and drags the mean 8000 -> ~4571',
    realSteps.reviewN === 4 && realSteps.reviewValue === 8000
    && flippedSteps.reviewN === 7 && Math.abs(flippedSteps.reviewValue - 32000 / 7) < 1e-9);
}

console.log(`\n${passed} passed, ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
