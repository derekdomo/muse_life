// W5.3 validation — body weight + circumference trends
// （围度与体重趋势）.
// Evaluates the REAL production module (server/src/body-trends.ts,
// whole file, types stripped) over synthetic data only:
//  - missing circumferences stay null on their point — never
//    zero-filled, never carried forward from a neighbouring date,
//    never interpolated; points exist ONLY for recorded dates
//    (no fabricated dates in between);
//  - cross-date alignment: each point carries the training
//    aggregates of the Monday-start week containing its date, and
//    a week with no aggregate stays null instead of borrowing a
//    neighbour week's figures;
//  - training figures never mix in manual data: changing every
//    measurement changes no week volume / best-set figure, and
//    changing the training input changes no body value;
//  - unit conversion follows the server convention (LB_TO_KG,
//    0.5 rounding, null stays null); a same-day duplicate row
//    resolves last-wins, mirroring the save's upsert;
//  - no conclusion surface: points / weeks / result carry only
//    dates, numbers and nulls — no verdict, label or advice key;
//  - mutation sensitivity: three deliberate mutations of the
//    module source (week-start day, null fill, training mixing)
//    plus a conversion mutation must each make the suite fail;
//  - wiring: schema + migration 0010 create body_measurements,
//    actions.ts imports the builder, returns body_measurements /
//    body_trends from getDashboard, gates saveBodyMeasurement on
//    the owner, and the client renders the section with the
//    public口径 and the empty state while computing no trend
//    itself.
// Synthetic data only: no real body record appears in this file —
// every weight / circumference below is invented for the test.
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';

const bodySrc = readFileSync(new URL('./server/src/body-trends.ts', import.meta.url), 'utf8');
const engineSrc = readFileSync(new URL('./server/src/progression-engine.ts', import.meta.url), 'utf8');
const trendsSrc = readFileSync(new URL('./server/src/action-trends.ts', import.meta.url), 'utf8');
const freqSrc = readFileSync(new URL('./server/src/week-frequency.ts', import.meta.url), 'utf8');
const serverSrc = readFileSync(new URL('./server/src/actions.ts', import.meta.url), 'utf8');
const schemaSrc = readFileSync(new URL('./server/src/schema.ts', import.meta.url), 'utf8');
const migrationSrc = readFileSync(new URL('./drizzle/0010_add_body_measurements.sql', import.meta.url), 'utf8');
const clientSrc = readFileSync(new URL('./client/src/App.tsx', import.meta.url), 'utf8');

let passed = 0;
let failures = 0;
function check(name, ok, note = '') {
  if (ok) passed++;
  else failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${note ? ` (${note})` : ''}`);
}
function loadBody(source) {
  const code = stripTypeScriptTypes(source).replace(/^export /gm, '');
  return new Function(
    `${code}\nreturn { buildBodyTrends, convertBodyWeight, bodyTrendWeekStart, BODY_TRENDS_VERSION, LB_TO_KG };`,
  )();
}
function loadConst(source, name) {
  const code = stripTypeScriptTypes(source).replace(/^export /gm, '');
  return new Function(`${code}\nreturn { ${name} };`)()[name];
}
const B = loadBody(bodySrc);

// --- synthetic builders (all values invented) ---
// Recorded dates: Wed 2026-10-07, Wed 2026-10-14, Wed 2026-10-21
// — Mondays of their weeks: 10-05 / 10-12 / 10-19.
const m = (measuredAt, bodyWeight, unit, waist, chest, hips, arm, thigh) =>
  ({ measuredAt, bodyWeight, unit, waist, chest, hips, arm, thigh });
const tw = (weekStart, weekEnd, unit, volume, bestSetVolume) =>
  ({ weekStart, weekEnd, unit, volume, bestSetVolume });

function fixture(weightScale = 1, trainingScale = 1) {
  return {
    displayUnit: 'kg',
    // Deliberately out of order: the builder must sort by date.
    measurements: [
      m('2026-10-21', 79.5 * weightScale, 'kg', 83.5, 100.5, 96.5, 35.5, 56.5),
      m('2026-10-07', 80 * weightScale, 'kg', 84, null, 97, null, 57),
      m('2026-10-14', 176 * weightScale, 'lb', null, 101, null, 36, null),
    ],
    trainingWeeks: [
      tw('2026-10-05', '2026-10-11', 'kg', 5000 * trainingScale, 720 * trainingScale),
      tw('2026-10-12', '2026-10-18', 'kg', null, null), // a week with no recorded weighted set
      tw('2026-10-19', '2026-10-25', 'lb', 10000 * trainingScale, 2200 * trainingScale),
    ],
  };
}

// --- behavioral suite (also run against mutants) ---
function suite(mod) {
  let failed = 0;
  const t = (name, ok) => { if (!ok) { failed++; console.log(`  suite-fail: ${name}`); } };
  const result = mod.buildBodyTrends(fixture());
  const [p1, p2, p3] = result.points;

  // --- one point per recorded date, sorted, nothing fabricated ---
  t('points: exactly the 3 recorded dates, oldest first',
    result.points.length === 3
    && p1.date === '2026-10-07' && p2.date === '2026-10-14' && p3.date === '2026-10-21');
  t('points: no fabricated in-between dates (10-08 … 10-20 absent)',
    result.points.every((p) => ['2026-10-07', '2026-10-14', '2026-10-21'].includes(p.date)));

  // --- missing fields stay null; recorded values pass through ---
  t('nulls: 10-07 chest / arm were not recorded → null, waist / hips / thigh verbatim',
    p1.chest === null && p1.arm === null && p1.waist === 84 && p1.hips === 97 && p1.thigh === 57);
  t('nulls: 10-14 waist / hips / thigh null — NOT carried forward from 10-07 (waist 84)',
    p2.waist === null && p2.hips === null && p2.thigh === null && p2.chest === 101 && p2.arm === 36);
  t('nulls: 10-21 fully recorded → every circumference verbatim',
    p3.waist === 83.5 && p3.chest === 100.5 && p3.hips === 96.5 && p3.arm === 35.5 && p3.thigh === 56.5);

  // --- unit conversion (display kg) ---
  t('conversion: 10-14 body weight 176 lb → 80 kg (LB_TO_KG, 0.5 rounding)', p2.bodyWeight === 80);
  t('conversion: kg rows are identity (80 / 79.5)', p1.bodyWeight === 80 && p3.bodyWeight === 79.5);
  t('conversion: convertBodyWeight(100 lb → kg) = 45.5, null stays null, same unit identity',
    mod.convertBodyWeight(100, 'lb', 'kg') === 45.5
    && mod.convertBodyWeight(null, 'lb', 'kg') === null
    && mod.convertBodyWeight(62.3, 'kg', 'kg') === 62.3);

  // --- cross-date alignment with the containing Monday week ---
  t('alignment: 10-07 (Wed) → week of Mon 10-05 with volume 5000 / best 720',
    p1.weekStart === '2026-10-05' && p1.weekVolume === 5000 && p1.weekBestSetVolume === 720);
  t('alignment: 10-14 → week of Mon 10-12, whose aggregates are null and STAY null',
    p2.weekStart === '2026-10-12' && p2.weekVolume === null && p2.weekBestSetVolume === null);
  t('alignment: 10-21 → week of Mon 10-19, lb aggregates converted (10000 lb → 4536, 2200 lb → 998)',
    p3.weekStart === '2026-10-19' && p3.weekVolume === 4536 && p3.weekBestSetVolume === 998);
  t('alignment: bodyTrendWeekStart — Wed 10-07 → 10-05, Sun 10-11 → 10-05, Mon 10-12 → itself, Sun 2026-11-01 → 10-26',
    mod.bodyTrendWeekStart('2026-10-07') === '2026-10-05'
    && mod.bodyTrendWeekStart('2026-10-11') === '2026-10-05'
    && mod.bodyTrendWeekStart('2026-10-12') === '2026-10-12'
    && mod.bodyTrendWeekStart('2026-11-01') === '2026-10-26');
  t('alignment: a measurement whose week the caller never supplied gets null aggregates',
    mod.buildBodyTrends({ displayUnit: 'kg', measurements: [m('2026-11-04', 70, 'kg', 80, null, null, null, null)], trainingWeeks: [] })
      .points[0].weekVolume === null);

  // --- weeks output: converted, nulls preserved ---
  t('weeks: 3 weeks pass through converted; the empty week stays null',
    result.weeks.length === 3
    && result.weeks[0].volume === 5000 && result.weeks[0].bestSetVolume === 720
    && result.weeks[1].volume === null && result.weeks[1].bestSetVolume === null
    && result.weeks[2].volume === 4536 && result.weeks[2].bestSetVolume === 998);

  // --- training figures never mix in manual data (both ways) ---
  const heavier = mod.buildBodyTrends(fixture(3, 1));
  t('no mixing: tripling every body weight changes NO week volume / best-set figure',
    JSON.stringify(heavier.points.map((p) => [p.weekVolume, p.weekBestSetVolume]))
      === JSON.stringify(result.points.map((p) => [p.weekVolume, p.weekBestSetVolume]))
    && JSON.stringify(heavier.weeks) === JSON.stringify(result.weeks));
  const moreTraining = mod.buildBodyTrends(fixture(1, 4));
  t('no mixing: quadrupling the training input changes NO body value on any point',
    JSON.stringify(moreTraining.points.map((p) => [p.bodyWeight, p.waist, p.chest, p.hips, p.arm, p.thigh]))
      === JSON.stringify(result.points.map((p) => [p.bodyWeight, p.waist, p.chest, p.hips, p.arm, p.thigh])));

  // --- same-day duplicate: last row wins (the save's upsert rule) ---
  const dup = mod.buildBodyTrends({
    displayUnit: 'kg',
    measurements: [
      m('2026-10-07', 80, 'kg', 84, null, null, null, null),
      m('2026-10-07', 81, 'kg', 85, null, null, null, null),
    ],
    trainingWeeks: [],
  });
  t('upsert mirror: two rows for one date → one point, the LAST row wins',
    dup.points.length === 1 && dup.points[0].bodyWeight === 81 && dup.points[0].waist === 85);

  // --- no conclusion surface: exact key sets only ---
  const pointKeys = ['bodyWeight', 'waist', 'chest', 'hips', 'arm', 'thigh', 'date', 'weekStart', 'weekVolume', 'weekBestSetVolume'].sort();
  const weekKeys = ['weekStart', 'weekEnd', 'volume', 'bestSetVolume'].sort();
  const resultKeys = ['displayUnit', 'points', 'weeks', 'trendsVersion'].sort();
  t('no conclusion: point / week / result carry only date + number + null fields (no verdict / label / advice)',
    result.points.every((p) => JSON.stringify(Object.keys(p).sort()) === JSON.stringify(pointKeys))
    && result.weeks.every((w) => JSON.stringify(Object.keys(w).sort()) === JSON.stringify(weekKeys))
    && JSON.stringify(Object.keys(result).sort()) === JSON.stringify(resultKeys));

  // --- empty behaviour ---
  const empty = mod.buildBodyTrends({ displayUnit: 'lb', measurements: [], trainingWeeks: [] });
  t('empty: no measurements and no weeks → no points, no weeks, nothing invented',
    empty.points.length === 0 && empty.weeks.length === 0 && empty.displayUnit === 'lb');
  const weeksOnly = mod.buildBodyTrends({ displayUnit: 'kg', measurements: [], trainingWeeks: fixture().trainingWeeks });
  t('empty: training weeks without measurements still convert, points stay empty',
    weeksOnly.points.length === 0 && weeksOnly.weeks.length === 3 && weeksOnly.weeks[2].volume === 4536);

  return failed;
}

const realFailures = suite(B);
check('behavioral suite: all assertions pass on the real module', realFailures === 0, `${realFailures} failed`);
check('constants: body-trends LB_TO_KG equals the engine / trends / frequency LB_TO_KG (0.45359237)',
  B.LB_TO_KG === 0.45359237
  && loadConst(engineSrc, 'LB_TO_KG') === B.LB_TO_KG
  && loadConst(trendsSrc, 'LB_TO_KG') === B.LB_TO_KG
  && loadConst(freqSrc, 'LB_TO_KG') === B.LB_TO_KG);
check('version: BODY_TRENDS_VERSION is 1', B.BODY_TRENDS_VERSION === 1);
check('module purity: body-trends.ts has no import statement (pure, self-contained)',
  !/^import /m.test(bodySrc));
check('module exports: buildBodyTrends / convertBodyWeight / bodyTrendWeekStart all exported',
  bodySrc.includes('export function buildBodyTrends')
  && bodySrc.includes('export function convertBodyWeight')
  && bodySrc.includes('export function bodyTrendWeekStart'));

// --- mutation sensitivity: each mutant MUST break the suite ---
const mutants = [
  ['week start Monday → Sunday ((dow + 6) % 7 → dow % 7)', bodySrc.replace('((dow + 6) % 7)', '(dow % 7)')],
  ['missing waist zero-filled (row.waist → row.waist ?? 0)', bodySrc.replace('waist: row.waist,', 'waist: row.waist ?? 0,')],
  ['training volume mixed with manual data (+ row.bodyWeight)', bodySrc.replace('weekVolume: week ? week.volume : null,', 'weekVolume: week ? week.volume + row.bodyWeight : null,')],
  ['unit conversion dropped (weight * LB_TO_KG → weight)', bodySrc.replace('weight * LB_TO_KG', 'weight')],
];
for (const [name, mutated] of mutants) {
  if (mutated === bodySrc) {
    check(`mutation applies: ${name}`, false, 'replacement did not change the source');
    continue;
  }
  let failedCount = -1;
  try {
    failedCount = suite(loadBody(mutated));
  } catch {
    failedCount = -2; // a mutant that throws also proves sensitivity
  }
  check(`mutation sensitivity: ${name}`, failedCount !== 0, `suite failures: ${failedCount}`);
}

// --- wiring: schema + migration ---
check('wiring: schema.ts defines the bodyMeasurements table on body_measurements',
  schemaSrc.includes('export const bodyMeasurements') && schemaSrc.includes('"body_measurements"'));
check('wiring: schema keeps circumferences nullable and body_weight required with the lb/kg unit column',
  schemaSrc.includes('bodyWeight: real("body_weight").notNull()')
  && schemaSrc.includes('waist: real("waist")')
  && schemaSrc.includes('weightUnit: text("weight_unit", { enum: ["lb", "kg"] })'));
check('wiring: migration 0010 creates body_measurements with a unique measured_at index (one row per date)',
  migrationSrc.includes('CREATE TABLE body_measurements')
  && migrationSrc.includes('CREATE UNIQUE INDEX body_measurements_measured_at_idx ON body_measurements(measured_at)'));

// --- wiring: actions ---
check('wiring: actions.ts imports buildBodyTrends from ./body-trends',
  serverSrc.includes('buildBodyTrends') && serverSrc.includes('from "./body-trends"'));
check('wiring: getDashboard returns body fields via loadBodyMeasurements',
  serverSrc.includes('...(await loadBodyMeasurements(ctx, now))'));
check('wiring: dashboard response schema carries body_measurements + body_trends (additive, optional)',
  serverSrc.includes('body_measurements: z.array(bodyMeasurementEntryResponse).optional()')
  && serverSrc.includes('body_trends: bodyTrendsResponse.optional()'));
check('wiring: loader reads the last 90 days of stored rows and workout-only training aggregates',
  serverSrc.includes('schema.bodyMeasurements') && serverSrc.includes('89 * DAY_MS')
  && serverSrc.includes('buildBodyTrends({ measurements, trainingWeeks, displayUnit })'));
const saveStart = serverSrc.indexOf('saveBodyMeasurement: defineAction');
const saveBlock = saveStart >= 0 ? serverSrc.slice(saveStart, saveStart + 4600) : '';
check('wiring: saveBodyMeasurement exists and is strictly owner-gated (isOwner, not the sync channel)',
  saveStart >= 0 && saveBlock.includes('if (!isOwner(ctx))') && !saveBlock.includes('isOwnerOrSyncChannel'));
check('wiring: saveBodyMeasurement requires body_weight, keeps circumferences optional-nullable, rejects future dates',
  saveBlock.includes('body_weight: z.number().positive()')
  && saveBlock.includes('waist: z.number().positive().max(300).nullable().optional()')
  && saveBlock.includes('日期不能晚于今天'));
check('wiring: saveBodyMeasurement upserts on measured_at (same-day overwrite, other dates untouched)',
  saveBlock.includes('eq(schema.bodyMeasurements.measuredAt, measuredAt)')
  && saveBlock.includes('update(schema.bodyMeasurements)')
  && saveBlock.includes('insert(schema.bodyMeasurements)'));

// --- wiring: client ---
check('wiring: client renders the 「围度与体重趋势」 section from the dashboard fields',
  clientSrc.includes('围度与体重趋势') && clientSrc.includes('measurements={bodyMeasurements}')
  && clientSrc.includes('bodyMeasurements={dashboard.data.body_measurements}')
  && clientSrc.includes('bodyTrends={dashboard.data.body_trends}'));
check('wiring: client empty state is exactly 「尚未记录围度与体重」',
  clientSrc.includes('尚未记录围度与体重'));
check('wiring: client publicly states the口径 (manual records, trends only, no conclusion, gaps stay empty)',
  clientSrc.includes('仅作记录与趋势展示，不给出减重或健康结论') && clientSrc.includes('不补算、不推断'));
check('wiring: client form saves through saveBodyMeasurement with weight required and circumferences optional',
  clientSrc.includes('api.saveBodyMeasurement') && clientSrc.includes('体重（必填')
  && clientSrc.includes('留空 = 未记录'));
check('wiring: client tells series apart by symbol + line style + numbers, not colour alone',
  clientSrc.includes('CIRC_SERIES') && clientSrc.includes('styleLabel') && clientSrc.includes('数据明细（表格'));
check('wiring: client computes no body trend of its own (no module import, no builder call)',
  !clientSrc.includes('from "./body-trends"') && !clientSrc.includes('buildBodyTrends('));
check('wiring: no existing export removed — week-frequency / trends / heatmap builders intact',
  serverSrc.includes('buildWeekFrequency') && serverSrc.includes('buildActionTrends')
  && serverSrc.includes('buildMuscleHeatmap') && serverSrc.includes('evaluateProgression'));

console.log(`\n${passed} passed, ${failures} failed`);
process.exit(failures > 0 ? 1 : 0);
