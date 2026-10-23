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
// PM re-review 2026-10-22 21:52 (H3.1/H3.3) adds: (10) coverage
// honesty — the same fixture under coverageIncomplete false vs true
// must differ (partial: no 覆盖完整 wording, no 置信度较高, no definite
// training-adjustment insight or focus), legacy unknown completeness
// never claims complete/high either, (11) HealthKit and strength
// (训练记录) session counts stay separate and are never merged, with
// the per-window valid-day counts reconciled item by item, (12) the
// H3.3 multi-day support rule — an isolated 1-day spike (either
// direction, large enough to push the window mean past the practical
// threshold) generates no insight for any insight-capable metric on
// either comparison path, while 3 consecutive same-direction days and
// a whole shifted week still do. Pure Node, no deps.
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
  clientSrc.includes('<WeekReviewPanel snapshot={snapshot} focusFeedback={focusFeedback} focusReadFailed={focusReadFailed} />'));
check('source: panel renders after the load verdict block and the seven-day facts strip',
  clientSrc.indexOf('whoop-load') < clientSrc.indexOf('<WeekReviewPanel snapshot={snapshot} focusFeedback={focusFeedback} focusReadFailed={focusReadFailed} />')
  && clientSrc.indexOf('<SevenDayFacts snapshot={snapshot} />') < clientSrc.indexOf('<WeekReviewPanel snapshot={snapshot} focusFeedback={focusFeedback} focusReadFailed={focusReadFailed} />'));
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
  const r = weekReview(fixture1.daily, fixture1.sleeps, fixture1.workouts, DATA_DATE, { coverageIncomplete: false });
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
  check('missing: a mean metric with zero valid days shows a null value, never 0',
    weekReview(dailyRows({}, ALL_DATES), [], [], DATA_DATE).metrics.every((m) => m.kind === 'count' ? true : m.reviewValue === null));
  // Criterion changed by PM re-review 2026-10-22 21:52 (H3.1): the old
  // assertion "empty input -> count metric is a definite 0" is
  // replaced. An empty HealthKit list is a provable true 0 ONLY when
  // coverageIncomplete is explicitly false; with completeness unknown
  // (legacy 4-argument call) or incomplete, a stored 0 is unknown
  // (null) and the baseline is not sufficient.
  check('missing: empty input with unknown completeness -> count is unknown (null), baseline not sufficient',
    (() => { const w = metric(weekReview(dailyRows({}, ALL_DATES), [], [], DATA_DATE), 'workouts');
      return w.reviewValue === null && w.comparisonValue === null && w.baselineValue === null
        && w.baselineSufficient === false && w.coverageNote.includes('快照内 0 次，完整性未确认'); })());
  check('missing: empty input with explicitly complete coverage -> count is a true 0',
    (() => { const w = metric(weekReview(dailyRows({}, ALL_DATES), [], [], DATA_DATE, { coverageIncomplete: false }), 'workouts');
      return w.reviewValue === 0 && w.comparisonValue === 0 && w.baselineValue === 0 && w.baselineSufficient === true; })());
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
  const a = weekReview(fixture1.daily, fixture1.sleeps, fixture1.workouts, DATA_DATE, { coverageIncomplete: false });
  const b = weekReview(fixture1.daily, fixture1.sleeps, fixture1.workouts, DATA_DATE, { coverageIncomplete: false });
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
  const r = weekReview(dailyRows(), sleeps, [], DATA_DATE, { coverageIncomplete: false });
  check('confidence: 6 of 7 valid nights still generates the insight but at 置信度中等',
    r.insights.length === 1 && r.insights[0].metricKey === 'sleep'
    && r.insights[0].confidence === '中等' && r.insights[0].confidenceNote.includes('复盘窗有效 6/7 天'));
}

// --------------------------------- (10) H3.1 coverage honesty (PM 2026-10-22)
{
  const complete = weekReview(fixture1.daily, fixture1.sleeps, fixture1.workouts, DATA_DATE, { coverageIncomplete: false });
  const partial = weekReview(fixture1.daily, fixture1.sleeps, fixture1.workouts, DATA_DATE, { coverageIncomplete: true });
  check('coverage: same fixture, coverageIncomplete false vs true produce different results',
    JSON.stringify(complete) !== JSON.stringify(partial));
  check('coverage: explicit complete coverage echoes coverageIncomplete=false and the confirmed note',
    complete.coverageIncomplete === false && complete.coverageStatusNote.includes('已确认'));
  const partialSleep = metric(partial, 'sleep');
  check('coverage: partial source never calls any metric 覆盖完整 even with all rows present',
    partial.metrics.every((m) => !m.coverageNote.includes('覆盖完整') || m.coverageNote.includes('不完整'))
    && partialSleep.coverageNote === '来源覆盖不完整' && partialSleep.reviewN === 7);
  check('coverage: partial source keeps the stored facts (sleep means and valid days unchanged)',
    partialSleep.reviewValue === 6.5 && partialSleep.comparisonValue === 7.5 && partialSleep.reviewN === 7);
  check('coverage: partial source generates no insight, no 较高, and no definite training action',
    partial.insights.length === 0 && partial.canJudge === false
    && !partial.focus.includes('上床时间提前') && partial.focus.includes('继续观察'));
  check('coverage: partial result carries the banner status note verbatim for the panel',
    partial.coverageIncomplete === true && partial.coverageStatusNote === '来源覆盖不完整：以下为已存事实，完整性未确认');
  check('coverage: partial source with zero stored HealthKit sessions reports unknown, not a definite 0',
    metric(partial, 'workouts').reviewValue === null && metric(partial, 'workouts').baselineSufficient === false);
}
{
  // Legacy payload: no source info passed at all (4-argument call).
  const legacy = weekReview(fixture1.daily, fixture1.sleeps, fixture1.workouts, DATA_DATE);
  check('coverage: legacy unknown completeness is echoed as null and never claims 覆盖完整',
    legacy.coverageIncomplete === null
    && legacy.metrics.every((m) => m.coverageNote !== '覆盖完整'));
  check('coverage: legacy unknown completeness caps insight confidence at 中等 and notes it unconfirmed',
    legacy.insights.length === 1 && legacy.insights[0].confidence === '中等'
    && legacy.insights[0].confidenceNote.includes('完整性未确认'));
  check('coverage: legacy unknown completeness still allows the insight itself (facts are stored)',
    legacy.canJudge === true && legacy.focus === legacy.insights[0].action);
}
check('source: panel passes snapshot coverageIncomplete and strength dates into weekReview',
  clientSrc.includes('coverageIncomplete: snapshot.coverageIncomplete')
  && clientSrc.includes('strengthDates: snapshot.strengthTraining.workouts.map((workout) => workout.date)'));
check('source: panel shows the incomplete-coverage banner verbatim at the top',
  clientSrc.includes('来源覆盖不完整：以下为已存事实，完整性未确认。'));
check('source: panel states the multi-day support rule in plain text',
  clientSrc.includes('至少 3 天单独达到同向实用差异') && clientSrc.includes('单个异常日即使把周均值推过阈值'));
check('source: panel presents all three windows valid-day counts per mean metric',
  clientSrc.includes('复盘窗有效 {metric.reviewN}/7 天 · 对比窗有效 {metric.comparisonN}/7 天 · 基线窗有效 {metric.baselineN}/28 天'));
check('source: panel labels the HealthKit count with its source and the strength line with 训练记录',
  clientSrc.includes('运动次数（HealthKit 来源）') && clientSrc.includes('力量训练（来源：训练记录）'));

// --------------------------- (11) H3.1 source separation + n reconciliation
{
  // Only strength records exist; the HealthKit workout list is empty.
  const strengthDates = ['2026-10-17', '2026-10-20', '2026-10-20', '2026-10-10', '2026-09-25', '2026-10-23'];
  const r = weekReview(dailyRows(), sleepRows(flatSleeps(LAST14, 7.5)), [], DATA_DATE, { coverageIncomplete: false, strengthDates });
  const w = metric(r, 'workouts');
  check('sources: with only strength records and complete coverage, the HealthKit count stays a true 0',
    w.reviewValue === 0 && w.comparisonValue === 0 && w.baselineValue === 0);
  check('sources: strength sessions are counted per window from their own dates (review 3, comparison 1, baseline 2 incl. comparison week; post-dataDate excluded)',
    r.strengthCounts !== null && r.strengthCounts.review === 3 && r.strengthCounts.comparison === 1 && r.strengthCounts.baseline === 2);
  check('sources: the two counts are never merged into one total anywhere in the result',
    r.metrics.length === 7 && r.metrics.every((m) => m.reviewValue !== 3 || m.key !== 'workouts')
    && w.reviewValue === 0 && r.strengthCounts.review === 3);
  check('sources: no strength dates passed -> strengthCounts is null (unknown), never a fabricated 0 object',
    weekReview(dailyRows(), sleepRows(flatSleeps(LAST14, 7.5)), [], DATA_DATE).strengthCounts === null);
}
{
  // Per-window valid-day counts reconciled item by item: respiratory
  // rate present on all 7 review days, exactly 5 comparison days, and
  // 0 baseline-only days (baseline window = baseline-extra + comparison,
  // so its n equals the comparison contribution alone).
  const omitBaseline = BASELINE_EXTRA;
  const daily = dailyRows(
    mergeOverrides(perDates(omitBaseline, { respiratoryRate: null })),
    [],
  );
  // Remove respiratory values from 2 comparison days via nulls.
  const daily2 = daily.map((row) => (row.date === '2026-10-09' || row.date === '2026-10-10' ? { ...row, respiratoryRate: null } : row));
  const r = weekReview(daily2, sleepRows(flatSleeps(LAST14, 7.5)), [], DATA_DATE, { coverageIncomplete: false });
  const resp = metric(r, 'respiratoryRate');
  check('windows-n: review 7 / comparison 5 / baseline 5 valid days are each reported exactly',
    resp.reviewN === 7 && resp.comparisonN === 5 && resp.baselineN === 5);
  const r0 = weekReview(dailyRows(perDates(ALL_DATES, { respiratoryRate: null })), sleepRows(flatSleeps(LAST14, 7.5)), [], DATA_DATE, { coverageIncomplete: false });
  const resp0 = metric(r0, 'respiratoryRate');
  check('windows-n: a metric absent everywhere reports 0/0/0 and 基线数据不足 with a null mean',
    resp0.reviewN === 0 && resp0.comparisonN === 0 && resp0.baselineN === 0
    && resp0.baselineSufficient === false && resp0.baselineValue === null && resp0.baselineNote === '基线数据不足');
}

// --------------------------------- (12) H3.3 isolated spike never trends
{
  const flat = sleepRows(flatSleeps(LAST14, 7.5));
  const spikeCases = [
    // [metricKey, review-day override, dates carrying the override]
    ['restingHr', { restingHr: 88 }, ['2026-10-22']], // the PM fixture: mean 64 >= +3 threshold
    ['restingHr', { restingHr: 32 }, ['2026-10-22']],
    ['hrv', { hrvMs: 90 }, ['2026-10-22']],
    ['hrv', { hrvMs: 10 }, ['2026-10-22']],
    ['respiratoryRate', { respiratoryRate: 22 }, ['2026-10-22']],
    ['respiratoryRate', { respiratoryRate: 6 }, ['2026-10-22']],
    ['steps', { steps: 20000 }, ['2026-10-22']],
    ['exerciseMinutes', { exerciseMinutes: 120 }, ['2026-10-22']],
  ];
  for (const [key, over, dates] of spikeCases) {
    const daily = dailyRows(perDates(dates, over));
    const r = weekReview(daily, flat, [], DATA_DATE, { coverageIncomplete: false });
    const m = metric(r, key);
    const crossed = m.diff !== null && Math.abs(m.diff) >= (key === 'hrv' ? 5 : key === 'steps' ? 1600 : key === 'exerciseMinutes' ? 9 : key === 'restingHr' ? 3 : 1);
    check(`spike: isolated 1-day ${key} spike crosses the mean threshold (setup sanity)`,
      crossed === true, `diff=${m.diff}`);
    check(`spike: isolated 1-day ${key} spike generates no insight for that metric`,
      !r.insights.some((i) => i.metricKey === key));
  }
  // Sleep spikes ride on historySleeps, not historyDaily.
  for (const hours of [11.5, 3.5]) {
    const sleeps = sleepRows({ ...flatSleeps(LAST14, 7.5), '2026-10-22': hours });
    const r = weekReview(dailyRows(), sleeps, [], DATA_DATE, { coverageIncomplete: false });
    const m = metric(r, 'sleep');
    check(`spike: isolated 1-night sleep spike to ${hours}h crosses the mean threshold but generates no insight`,
      Math.abs(m.diff) >= 0.5 && !r.insights.some((i) => i.metricKey === 'sleep'), `diff=${m.diff}`);
  }
  // A single day can mathematically move a 7-day mean by at most 1/7,
  // so a negative steps spike (-100% day = 0) and a negative exercise
  // spike can never reach their +/-% mean thresholds alone; assert the
  // extreme case still yields no insight.
  for (const [key, over] of [['steps', { steps: 0 }], ['exerciseMinutes', { exerciseMinutes: 0 }]]) {
    const r = weekReview(dailyRows({ '2026-10-22': over }), flat, [], DATA_DATE, { coverageIncomplete: false });
    check(`spike: extreme 1-day negative ${key} value generates no insight`,
      !r.insights.some((i) => i.metricKey === key));
  }
  // The spike day itself is kept as a stored fact in the metric row.
  const pmFixture = weekReview(
    dailyRows(mergeOverrides(perDates(REVIEW, { restingHr: 60 }), { '2026-10-22': { restingHr: 88 } })),
    sleepRows(flatSleeps(LAST14, 7.5)), [], DATA_DATE, { coverageIncomplete: false });
  check('spike: the PM fixture (35d resting HR 60, last review day 88) keeps the raised mean as fact but yields no insight and no 不加量 action',
    Math.abs(metric(pmFixture, 'restingHr').reviewValue - 448 / 7) < 1e-9
    && pmFixture.insights.length === 0 && !pmFixture.focus.includes('先不加量'));
}
{
  // Three consecutive same-direction days DO support a trend.
  const daily = dailyRows(perDates(['2026-10-20', '2026-10-21', '2026-10-22'], { restingHr: 70 }));
  const r = weekReview(daily, sleepRows(flatSleeps(LAST14, 7.5)), [], DATA_DATE, { coverageIncomplete: false });
  check('support: 3 consecutive days at +10 bpm each generate the resting-HR insight (mean +30/7 past ±3, 3 support days)',
    r.insights.length === 1 && r.insights[0].metricKey === 'restingHr' && r.insights[0].versus === 'comparison'
    && r.insights[0].confidence === '较高' && r.insights[0].confidenceNote.includes('3 天单独达到同向实用差异'));
  // Two supporting days are not enough.
  const daily2 = dailyRows(perDates(['2026-10-21', '2026-10-22'], { restingHr: 75 }));
  const r2 = weekReview(daily2, sleepRows(flatSleeps(LAST14, 7.5)), [], DATA_DATE, { coverageIncomplete: false });
  check('support: only 2 days past the threshold (mean +30/7) generate no insight',
    Math.abs(metric(r2, 'restingHr').diff - 30 / 7) < 1e-9 && !r2.insights.some((i) => i.metricKey === 'restingHr'));
  // A whole shifted week still trends (also fixture1's sleep case).
  const daily3 = dailyRows(perDates(REVIEW, { restingHr: 65 }));
  const r3 = weekReview(daily3, sleepRows(flatSleeps(LAST14, 7.5)), [], DATA_DATE, { coverageIncomplete: false });
  check('support: a whole review week shifted +5 bpm generates the insight with 7 support days',
    r3.insights.some((i) => i.metricKey === 'restingHr') && r3.insights[0].confidenceNote.includes('7 天单独达到同向实用差异'));
  // Baseline path: comparison window has no sleep rows, so only the
  // 28-day baseline comparison can fire — and the same support rule
  // applies there (3 short nights at -1.5h each).
  const sleeps = sleepRows({
    ...flatSleeps(BASELINE_EXTRA, 7.5),
    ...flatSleeps(REVIEW.slice(0, 4), 7.5),
    '2026-10-20': 6.0, '2026-10-21': 6.0, '2026-10-22': 6.0,
  });
  const rb = weekReview(dailyRows(), sleeps, [], DATA_DATE, { coverageIncomplete: false });
  check('support: baseline-path insight fires with 3 supporting nights when the comparison window is empty',
    rb.insights.length === 1 && rb.insights[0].metricKey === 'sleep' && rb.insights[0].versus === 'baseline');
  const sleepsSpike = sleepRows({
    ...flatSleeps(BASELINE_EXTRA, 7.5),
    ...flatSleeps(REVIEW, 7.5),
    '2026-10-22': 3.0,
  });
  const rs = weekReview(dailyRows(), sleepsSpike, [], DATA_DATE, { coverageIncomplete: false });
  check('support: baseline-path isolated 1-night spike past the mean threshold generates no insight either',
    Math.abs(metric(rs, 'sleep').reviewValue - (7.5 * 6 + 3.0) / 7) < 1e-9 && rs.insights.length === 0);
}

// ----------------- (13) PM 2026-10-23 00:57: baseline range + other-side spikes
{
  // H3.1 repro: the source query spans only the latest 30 completed
  // days (daily rows 2026-09-23..10-22), coverageIncomplete === false
  // for that queried range, one stored session inside the baseline
  // window (10-12). A second real session on 09-20 sits OUTSIDE the
  // queried range and is therefore absent from the list. The 30-day
  // completeness must not be read as a 28-day baseline total.
  const daily30 = dailyRows().filter((row) => row.date >= '2026-09-23'); // exactly the 30 queried days
  const r = weekReview(daily30, sleepRows(flatSleeps(LAST14, 7.5)), [{ date: '2026-10-12' }], DATA_DATE, { coverageIncomplete: false });
  const w = metric(r, 'workouts');
  check('range: 30-day query keeps the stored baseline count as a fact (1) but not as a total',
    w.baselineValue === 1 && w.baselineSufficient === false
    && w.baselineNote !== null && w.baselineNote.includes('已存 1 次') && w.baselineNote.includes('完整性未确认')
    && !w.baselineNote.includes('共 1 次'));
  check('range: windows inside the queried range keep provable counts (review 0 is a true 0, comparison 1)',
    w.reviewValue === 0 && w.comparisonValue === 1);
  // Empty list under the same 30-day query: baseline 0 is NOT provable.
  const r0 = weekReview(daily30, sleepRows(flatSleeps(LAST14, 7.5)), [], DATA_DATE, { coverageIncomplete: false });
  const w0 = metric(r0, 'workouts');
  check('range: empty list under a 30-day query -> baseline count unknown, not a claimed 共0次',
    w0.baselineValue === null && w0.baselineSufficient === false
    && w0.baselineNote !== null && w0.baselineNote.includes('已存 0 次'));
  // 35-day complete control: the same two sessions ARE the total.
  const r35 = weekReview(dailyRows(), sleepRows(flatSleeps(LAST14, 7.5)),
    [{ date: '2026-10-12' }, { date: '2026-09-20' }], DATA_DATE, { coverageIncomplete: false });
  const w35 = metric(r35, 'workouts');
  check('range: 35-day complete input -> baseline total 2 stands with the 共 wording',
    w35.baselineValue === 2 && w35.baselineSufficient === true
    && w35.baselineNote === '基线窗 28 天共 2 次');
  // 100-entry cap: a list at the schema cap may be truncated.
  const capped = Array.from({ length: 100 }, () => ({ date: '2026-10-20' }));
  const rc = weekReview(dailyRows(), sleepRows(flatSleeps(LAST14, 7.5)), capped, DATA_DATE, { coverageIncomplete: false });
  const wc = metric(rc, 'workouts');
  check('range: a list at the 100-entry cap proves no baseline total (stored 0 -> unknown)',
    wc.baselineValue === null && wc.baselineSufficient === false
    && wc.baselineNote !== null && wc.baselineNote.includes('100 条上限'));
}
{
  // H3.3 repro: an isolated abnormal day on the COMPARISON or
  // BASELINE side drags that window's mean until every normal review
  // day counts as support. Leave-one-out must block all of these.
  const flat = sleepRows(flatSleeps(LAST14, 7.5));
  const cmp88 = weekReview(dailyRows({ '2026-10-14': { restingHr: 88 } }), flat, [], DATA_DATE, { coverageIncomplete: false });
  check('other-side spike: comparison-day RHR 88 (mean 64 vs 60) generates no resting-HR insight',
    Math.abs(metric(cmp88, 'restingHr').comparisonValue - 64) < 1e-9
    && !cmp88.insights.some((i) => i.metricKey === 'restingHr'));
  const cmp32 = weekReview(dailyRows({ '2026-10-14': { restingHr: 32 } }), flat, [], DATA_DATE, { coverageIncomplete: false });
  check('other-side spike: comparison-day RHR 32 generates no resting-HR insight and no 不加量 action',
    !cmp32.insights.some((i) => i.metricKey === 'restingHr') && !cmp32.focus.includes('先不加量'));
  const base172 = weekReview(dailyRows({ '2026-10-02': { restingHr: 172 } }), flat, [], DATA_DATE, { coverageIncomplete: false });
  check('other-side spike: baseline-day RHR 172 generates no resting-HR insight',
    !base172.insights.some((i) => i.metricKey === 'restingHr'));
  const cmpSleep = weekReview(dailyRows(),
    sleepRows({ ...flatSleeps(LAST14, 7.5), '2026-10-14': 3.5 }), [], DATA_DATE, { coverageIncomplete: false });
  check('other-side spike: one short comparison night (3.5h) generates no sleep insight',
    !cmpSleep.insights.some((i) => i.metricKey === 'sleep'));
  // Sustained differences survive leave-one-out on both sides.
  const sustained = weekReview(dailyRows(perDates(REVIEW, { restingHr: 65 })), flat, [], DATA_DATE, { coverageIncomplete: false });
  check('other-side spike: a whole shifted review week still trends after the LOO check',
    sustained.insights.some((i) => i.metricKey === 'restingHr'));
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
