// H3.4 睡眠/恢复与训练表现的关联探索 validation.
// Runs the REAL production pure module (server/src/sleep-training-
// correlation.ts — no imports, all logic exported) over synthetic
// fixtures only; no real health data is ever used. Covers: (1) the
// hard 6-pair sample gate (below it: sufficient=false and NO groups,
// means, or differences, even when data exists; the 6th pair flips
// it), (2) pairing alignment — a workout pairs with the main sleep
// whose WAKE-UP date is the workout's own date (the night before),
// never the neighbouring nights, (3) missing previous-night sleep
// excluded and counted as unpaired — missing is missing, never 0
// hours, (4) missing duration / missing readiness archive excluded
// per metric only, never zero-filled, (5) grouping against the
// personal baseline (H4.3 caliber: mean of the most recent ≤14
// recorded nights, ≥8 required) with good − poor mean differences,
// (6) unit conversion with the existing 1 lb = 0.45359237 kg factor,
// and (7) the baseline gate: ≥6 pairs without a baseline still shows
// no groups. Three source mutations are executed for real (the
// sample gate tightened past the boundary, missing sleep treated as
// 0 hours, night dates shifted one day) and each must flip the
// corresponding assertion. Pure Node, no deps.
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';

const moduleSrc = readFileSync(new URL('./server/src/sleep-training-correlation.ts', import.meta.url), 'utf8');
const serverSrc = readFileSync(new URL('./server/src/actions.ts', import.meta.url), 'utf8');
const schemaSrc = readFileSync(new URL('./server/src/schema.ts', import.meta.url), 'utf8');
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
  return new Function(`${code}\nreturn { computeSleepTrainingCorrelation, convertSleepTrainingVolume, sleepTrainingDirection, sleepTrainingIsRealDate, SLEEP_TRAINING_MIN_PAIRS, SLEEP_TRAINING_BASELINE_MIN_NIGHTS, SLEEP_TRAINING_BASELINE_MAX_NIGHTS };`)();
}
const { computeSleepTrainingCorrelation, convertSleepTrainingVolume, sleepTrainingDirection, SLEEP_TRAINING_MIN_PAIRS, SLEEP_TRAINING_BASELINE_MIN_NIGHTS } = buildModule(moduleSrc);

const workout = (date, totalVolume, durationMinutes = 60, unit = 'lb') => ({ date, status: 'completed', durationMinutes, totalVolume, unit });
const night = (date, hours) => ({ date, hours });

// ------------------------------------------------------------ source checks
check('source: correlation module has no imports (pure module)', !/^import /m.test(moduleSrc));
check('source: server imports computeSleepTrainingCorrelation from the pure module',
  serverSrc.includes('computeSleepTrainingCorrelation') && serverSrc.includes('from "./sleep-training-correlation"'));
// 回灌适配（2026-11-02 21:30 PST）：仓库尚未回灌 H2.3（actions.ts 无 trendRanges
// 接线），主返回对象尾部为 `focusFeedback, sleepTraining }` 而非构件的
// `trendRanges, sleepTraining }`；断言按本仓主返回键序适配（沿 H2.1/H2.2 前例）。
check('source: getDashboard response carries the additive nullable sleepTraining field on all three return paths',
  serverSrc.includes('sleepTraining: sleepTrainingCorrelationSchema.nullable()')
  && (serverSrc.match(/sleepTraining: null/g) ?? []).length === 2
  && serverSrc.includes('const sleepTraining = await loadSleepTrainingCorrelation(ctx, snapshot);')
  && serverSrc.includes('focusFeedback, sleepTraining }'));
check('source: the loader reuses the existing calibers (main sleep, totalSleepHours, readiness archive)',
  serverSrc.includes('loadSleepTrainingCorrelation')
  && serverSrc.includes('selectMainSleep(rows)') && serverSrc.includes('readinessRows.map((row) => ({ date: row.date, score: row.score }))'));
check('source: no schema/migration surface for this feature (no new table)',
  !schemaSrc.includes('sleep_training') && !schemaSrc.includes('sleepTraining'));
check('source: every defineAction carries a v26 description',
  (serverSrc.match(/defineAction\(\{/g) ?? []).length === (serverSrc.match(/description: "/g) ?? []).length,
  `${(serverSrc.match(/defineAction\(\{/g) ?? []).length} actions`);
check('source: client renders the panel, the observational disclaimer, and the sample-gate wording',
  clientSrc.includes('睡眠与训练表现的关联') && clientSrc.includes('仅为观察性相关、不能证明睡眠/恢复导致训练表现变化')
  && clientSrc.includes('样本不足（当前') && clientSrc.includes('SleepTrainingPanel'));
check('source: client never computes the correlation itself',
  !clientSrc.includes('computeSleepTrainingCorrelation'));
check('source: the hard gate is 6 pairs and the baseline gate is 8 nights',
  SLEEP_TRAINING_MIN_PAIRS === 6 && SLEEP_TRAINING_BASELINE_MIN_NIGHTS === 8);

// ------------------------------------------------- main fixture (≥6, grouped)
// Nights 10-01..10-10: five 8h nights then five 6h nights → baseline
// 7.0h over 10 nights. Good group = workouts after 8h nights, poor
// group = workouts after 6h nights.
const mainNights = [
  ...['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05'].map((date) => night(date, 8)),
  ...['2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09', '2026-10-10'].map((date) => night(date, 6)),
];
const mainWorkouts = [
  workout('2026-10-01', 10000, 60),
  workout('2026-10-02', 12000, 70),
  workout('2026-10-03', 11000, null), // duration unknown
  workout('2026-10-06', 6000, 40),
  workout('2026-10-07', 5000, 50),
  workout('2026-10-08', 7000, 45),
  workout('2026-10-09', 4000, 55),
  workout('2026-10-15', 9000, 60), // no night on 10-15 → unpaired
  { date: '2026-10-04', status: 'active', durationMinutes: 30, totalVolume: 99999, unit: 'lb' }, // active → ignored
];
const mainReadiness = [
  { date: '2026-10-01', score: 8 }, { date: '2026-10-02', score: 9 },
  // 2026-10-03 absent from the archive
  { date: '2026-10-06', score: 5 }, { date: '2026-10-07', score: 6 },
  { date: '2026-10-08', score: null }, { date: '2026-10-09', score: 4 },
];
{
  const result = computeSleepTrainingCorrelation(mainWorkouts, mainNights, mainReadiness, 'lb');
  check('main: pairing counts are exact (active workouts never enter)',
    result.totalWorkouts === 8 && result.pairedCount === 7 && result.unpairedCount === 1);
  check('main: baseline is the H4.3 mean over the recorded nights',
    result.baselineNights === 10 && result.baselineHours === 7);
  check('main: 7 pairs pass the gate and groups split at the baseline',
    result.sufficient === true && result.goodGroup.pairs === 3 && result.poorGroup.pairs === 4);
  check('main: group volume means and the good − poor difference',
    result.goodGroup.volumeMean === 11000 && result.poorGroup.volumeMean === 5500 && result.volumeDiff === 5500);
  check('main: missing duration excluded from the duration means only, never 0',
    result.durationMissingPairs === 1 && result.goodGroup.durationPairs === 2 && result.goodGroup.durationMeanMinutes === 65
    && result.poorGroup.durationMeanMinutes === 47.5 && result.durationDiff === 17.5);
  check('main: missing readiness (absent row AND null score) excluded per metric, never 0',
    result.readinessMissingPairs === 2 && result.goodGroup.readinessPairs === 2 && result.goodGroup.readinessMean === 8.5
    && result.poorGroup.readinessPairs === 3 && result.poorGroup.readinessMean === 5 && result.readinessDiff === 3.5);
  check('main: pairs carry their group, sleep, and converted volume',
    result.pairs.length === 7 && result.pairs[0].date === '2026-10-01' && result.pairs[0].group === 'good'
    && result.pairs[0].sleepHours === 8 && result.pairs[3].group === 'poor' && result.pairs[3].date === '2026-10-06');
  check('main: group sleep means read back the grouping nights',
    result.goodGroup.sleepMeanHours === 8 && result.poorGroup.sleepMeanHours === 6);
}

// ------------------------------------------------- (1) the 6-pair hard gate
{
  const gateNights = ['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08']
    .map((date, index) => night(date, [8, 8, 8, 6, 6, 6, 7, 7][index]));
  const fiveWorkouts = ['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05'].map((date) => workout(date, 1000, 30));
  const five = computeSleepTrainingCorrelation(fiveWorkouts, gateNights, [], 'lb');
  check('gate: 5 valid pairs is 样本不足 — no groups, no differences, even though data exists',
    five.pairedCount === 5 && five.sufficient === false && five.goodGroup === null && five.poorGroup === null
    && five.volumeDiff === null && five.durationDiff === null && five.readinessDiff === null);
  const six = computeSleepTrainingCorrelation([...fiveWorkouts, workout('2026-10-06', 1000, 30)], gateNights, [], 'lb');
  check('gate: the 6th valid pair flips the exploration on with groups',
    six.pairedCount === 6 && six.sufficient === true && six.goodGroup.pairs === 3 && six.poorGroup.pairs === 3 && six.volumeDiff === 0);
}

// ------------------------------------------------- (2) pairing alignment
{
  // Only ONE night (wake date 10-02) can pair; the workouts on 10-01
  // and 10-03 sit next to it and must stay unpaired. Seven filler
  // nights give the baseline its 8 nights.
  const alignNights = [night('2026-10-02', 8), ...['2026-10-10', '2026-10-11', '2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16'].map((date) => night(date, 7))];
  const alignWorkouts = [workout('2026-10-01', 1000, 30), workout('2026-10-02', 2000, 30), workout('2026-10-03', 3000, 30)];
  const aligned = computeSleepTrainingCorrelation(alignWorkouts, alignNights, [], 'lb');
  check('alignment: a workout pairs with the night whose wake-up date is its own date',
    aligned.pairedCount === 1 && aligned.unpairedCount === 2 && aligned.pairs[0].date === '2026-10-02'
    && aligned.pairs[0].sleepHours === 8 && aligned.pairs[0].volume === 2000);
}

// --------------------------------------- (3) missing sleep is missing, not 0
{
  const zeroNights = ['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08'].map((date) => night(date, 8));
  const zeroWorkouts = [
    ...['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06'].map((date) => workout(date, 9000, 60)),
    workout('2026-10-20', 100, 10), workout('2026-10-21', 100, 10), workout('2026-10-22', 100, 10), // no nights at all
  ];
  const result = computeSleepTrainingCorrelation(zeroWorkouts, zeroNights, [], 'lb');
  check('missing: workouts without a previous-night sleep are excluded and counted, never paired at 0 hours',
    result.pairedCount === 6 && result.unpairedCount === 3 && result.goodGroup.pairs === 6 && result.poorGroup.pairs === 0);
  check('missing: an empty group leaves the difference null, never 0 or invented',
    result.goodGroup.volumeMean === 9000 && result.poorGroup.volumeMean === null && result.volumeDiff === null && result.sufficient === true);
}

// ------------------------------------------------- (7) baseline gate
{
  const sevenNights = ['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07'].map((date) => night(date, 7));
  const sixWorkouts = ['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06'].map((date) => workout(date, 1000, 30));
  const result = computeSleepTrainingCorrelation(sixWorkouts, sevenNights, [], 'lb');
  check('baseline: 6 pairs pass the sample gate but no baseline (< 8 nights) means no grouping',
    result.pairedCount === 6 && result.sufficient === true && result.baselineNights === 7 && result.baselineHours === null
    && result.goodGroup === null && result.volumeDiff === null && result.pairs[0].group === null);
}

// --------------------------------------------- (6) units + robustness
{
  check('units: conversion uses the existing 1 lb = 0.45359237 kg factor both ways',
    Math.abs(convertSleepTrainingVolume(100, 'kg', 'lb') - 220.4622) < 0.001
    && Math.abs(convertSleepTrainingVolume(10000, 'lb', 'kg') - 4535.9237) < 0.001
    && convertSleepTrainingVolume(500, 'lb', 'lb') === 500);
  const kgResult = computeSleepTrainingCorrelation([workout('2026-10-01', 10000, 60, 'lb')], [night('2026-10-01', 8)], [], 'kg');
  check('units: a pair volume is reported in the display unit',
    kgResult.pairs.length === 1 && kgResult.pairs[0].volume === 4535.9 && kgResult.displayUnit === 'kg');
  const messy = computeSleepTrainingCorrelation(
    [workout('2026-10-01', 1000, 30), { date: '2026-13-01', status: 'completed', durationMinutes: 30, totalVolume: 5000, unit: 'lb' }],
    [night('2026-10-01', 5), night('2026-10-01', 9), { date: '2026-10-02', hours: Number.NaN }],
    [],
    'lb',
  );
  check('robustness: duplicate nights keep the longest (main sleep), unusable rows never enter',
    messy.totalWorkouts === 1 && messy.pairedCount === 1 && messy.pairs[0].sleepHours === 9 && messy.baselineNights === 1);
  check('direction: symbols pair with words (▲ higher / ▼ lower / ● flat / — no data)',
    sleepTrainingDirection(2).symbol === '▲' && sleepTrainingDirection(-2).symbol === '▼'
    && sleepTrainingDirection(0).symbol === '●' && sleepTrainingDirection(null).symbol === '—');
}

// ------------------------------------------------------- mutation sensitivity
{
  // Mutation 1: tighten the hard gate past its boundary (> instead
  // of >=) — the 6-pair case must flip to insufficient.
  const gateMutant = buildModule(moduleSrc.replace('pairedCount >= SLEEP_TRAINING_MIN_PAIRS', 'pairedCount > SLEEP_TRAINING_MIN_PAIRS'));
  const gateNights = ['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08']
    .map((date, index) => night(date, [8, 8, 8, 6, 6, 6, 7, 7][index]));
  const sixWorkouts = ['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06'].map((date) => workout(date, 1000, 30));
  const realSix = computeSleepTrainingCorrelation(sixWorkouts, gateNights, [], 'lb');
  const mutantSix = gateMutant.computeSleepTrainingCorrelation(sixWorkouts, gateNights, [], 'lb');
  check('mutation: tightening the 6-pair gate flips the boundary assertion',
    realSix.sufficient === true && realSix.volumeDiff === 0 && mutantSix.sufficient === false && mutantSix.volumeDiff === null);

  // Mutation 2: treat a missing previous-night sleep as 0 hours —
  // the unpaired workouts must leak into the poor group and invent a
  // difference the real module refuses to show.
  const zeroMutant = buildModule(moduleSrc
    .replace('const sleepHours = nightByDate.get(workout.date);', 'const sleepHours = nightByDate.get(workout.date) ?? 0;')
    .replace('if (sleepHours === undefined) {', 'if (sleepHours === -1) {'));
  const zeroNights = ['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08'].map((date) => night(date, 8));
  const zeroWorkouts = [
    ...['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06'].map((date) => workout(date, 9000, 60)),
    workout('2026-10-20', 100, 10), workout('2026-10-21', 100, 10), workout('2026-10-22', 100, 10),
  ];
  const realZero = computeSleepTrainingCorrelation(zeroWorkouts, zeroNights, [], 'lb');
  const mutantZero = zeroMutant.computeSleepTrainingCorrelation(zeroWorkouts, zeroNights, [], 'lb');
  check('mutation: treating missing sleep as 0 hours flips the missing-is-missing assertion',
    realZero.pairedCount === 6 && realZero.unpairedCount === 3 && realZero.volumeDiff === null
    && mutantZero.pairedCount === 9 && mutantZero.unpairedCount === 0 && mutantZero.volumeDiff === 8900);

  // Mutation 3: shift every night one day earlier when keying the
  // map — the pairing must land on the wrong date.
  const shiftMutant = buildModule(moduleSrc.replace(
    'if (previous === undefined || night.hours > previous) nightByDate.set(night.date, night.hours);',
    'if (previous === undefined || night.hours > previous) nightByDate.set(new Date(Date.parse(`${night.date}T12:00:00Z`) - 86400000).toISOString().slice(0, 10), night.hours);',
  ));
  const alignNights = [night('2026-10-02', 8), ...['2026-10-10', '2026-10-11', '2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16'].map((date) => night(date, 7))];
  const alignWorkouts = [workout('2026-10-01', 1000, 30), workout('2026-10-02', 2000, 30), workout('2026-10-03', 3000, 30)];
  const realAligned = computeSleepTrainingCorrelation(alignWorkouts, alignNights, [], 'lb');
  const mutantAligned = shiftMutant.computeSleepTrainingCorrelation(alignWorkouts, alignNights, [], 'lb');
  check('mutation: shifting the night keys by one day flips the alignment assertion',
    realAligned.pairs[0].date === '2026-10-02' && mutantAligned.pairs[0].date === '2026-10-01');
}

console.log(`\n${passed} passed, ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
