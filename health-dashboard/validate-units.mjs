// H-UNITS-001 validation: cross-workout volume aggregation must convert
// each workout's totalVolume from its OWN unit into the snapshot's
// displayUnit before summing (1 lb = 0.45359237 kg). Runs the REAL
// extracted functions from server/src/actions.ts (types stripped with
// node:module.stripTypeScriptTypes) over synthetic snapshots only.
// Covers: same-day mixed units, cross-day mixed units, all-lb, all-kg,
// zero-volume workouts, displayUnit switching, and the readiness
// current-week volume text. Mutation-sensitive: replacing the conversion
// call in buildUnifiedTimeline with the raw totalVolume, or the readiness
// helper with a raw reduce, breaks the assertions below.
// Pure Node, no deps. Exit code non-zero on any failure.
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';

const src = readFileSync(new URL('./server/src/actions.ts', import.meta.url), 'utf8');

let passed = 0;
let failures = 0;
function check(name, ok, note = '') {
  if (ok) passed++;
  else failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${note ? ` (${note})` : ''}`);
}
const near = (a, b, eps = 0.051) => Math.abs(a - b) <= eps;

// ---------------------------------------------------------------- source
check('single conversion constant 1 lb = 0.45359237 kg', src.includes('const LB_TO_KG = 0.45359237;'));
check('buildUnifiedTimeline converts per-workout before summing',
  src.includes('day.strengthVolume += convertVolumeToUnit(workout.totalVolume, workout.unit, snapshot.strengthTraining.displayUnit);'));
check('buildUnifiedTimeline no longer adds the raw totalVolume',
  !src.includes('day.strengthVolume += workout.totalVolume;'));
check('readiness currentVolume uses the shared unit-aware sum',
  src.includes('const currentVolume = sumWorkoutVolumeInUnit(currentStrength, snapshot.strengthTraining.displayUnit);'));
check('readiness no longer reduces raw totalVolume',
  !src.includes('currentStrength.reduce((sum, workout) => sum + workout.totalVolume, 0)'));
// Per-workout displays keep their own unit (must NOT be converted away):
check('single-workout displays keep their own unit (diagnostics line untouched)',
  src.includes('Math.round(latestStrength.totalVolume)} ${latestStrength.unit}'));

// ------------------------------------------------------- real-function run
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
  if (name === 'stats') {
    // stats has an object-literal return type before its body brace, which
    // breaks generic brace matching; slice to the next top-level function.
    const next = source.indexOf('\nfunction ', idx + 1);
    return source.slice(idx, next < 0 ? undefined : next);
  }
  const openParen = source.indexOf('(', idx);
  const closeParen = matchDelim(source, openParen, '(', ')');
  const bodyStart = source.indexOf('{', closeParen);
  const bodyEnd = matchDelim(source, bodyStart, '{', '}');
  return source.slice(idx, bodyEnd + 1);
}
const FN = ['clamp', 'round', 'signed', 'totalSleepHours', 'timeInBedHours', 'bedtimeMinutes',
  'shiftDate', 'mondayWeekStart', 'stats', 'scoreFromZ', 'tierFor', 'downgradeOneTier',
  'convertVolumeToUnit', 'sumWorkoutVolumeInUnit', 'buildUnifiedTimeline', 'calculateReadiness'];
const lbDecl = src.match(/const LB_TO_KG = [0-9.]+;/)?.[0] ?? '';
if (!lbDecl) throw new Error('LB_TO_KG declaration not found');
const code = `${lbDecl}\n${FN.map((n) => extractFunction(src, n)).join('\n')}`;
const stripped = stripTypeScriptTypes(code);
const impl = new Function(`${stripped}\nreturn { convertVolumeToUnit, sumWorkoutVolumeInUnit, buildUnifiedTimeline, calculateReadiness };`)();

// ------------------------------------------------------------- fixtures
function workout(id, date, unit, totalVolume) {
  return {
    id, date, startedAt: `${date}T15:00:00.000Z`, completedAt: `${date}T16:00:00.000Z`,
    status: 'completed', routine: 'push', unit, durationMinutes: 60,
    completedSets: 5, totalSets: 5, totalVolume, exercises: [],
  };
}
function snap({ displayUnit, workouts, dataDate = '2026-10-14' }) {
  return {
    dataDate, updatedAt: '2026-10-15T00:00:00.000Z', timezone: 'America/Los_Angeles', coverageIncomplete: false,
    steps: { value: 5000, baseline: 5000, usualMin: 4000, usualMax: 6000, distanceKm: 3, flights: 1, basalKcal: 1600, status: '正常' },
    restingHr: { value: 60, baseline: 60, usualMin: 55, usualMax: 65, status: '正常' },
    hrv: { value: 40, baseline: 40, usualMin: 30, usualMax: 50, status: '正常' },
    respiratoryRate: { value: 14, status: '正常' },
    sleep: { bedtime: '23:00', wakeTime: '07:00', inBedHours: 8, coreHours: 5, deepHours: 1, remHours: 2, awakeMinutes: 10, quality: 80, efficiency: 90, awakenings: 1, status: '正常' },
    morningReference: null,
    strengthTraining: { updatedAt: '2026-10-14T00:00:00.000Z', displayUnit, workouts, weeklyTrend: [], note: 'synthetic' },
    workouts: { count7d: 0, baselinePerWeek: 0, note: 'synthetic' },
    trends: [], historyWorkouts: [], historySleeps: [],
    // 14 days of exercise history before dataDate so calculateReadiness
    // has an exercise baseline and the training-load detail text (which
    // carries the converted weekly volume) is actually produced.
    historyDaily: ['2026-09-30', '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09', '2026-10-10', '2026-10-11', '2026-10-12', '2026-10-13']
      .map((date, i) => ({ date, steps: 5000, activeKcal: 300, exerciseMinutes: 25 + (i % 5), restingHr: 60, hrvMs: 40, respiratoryRate: 14, weightKg: 80, swimMeters: 0 })),
  };
}
const dayOf = (timeline, date) => timeline.find((d) => d.date === date);

// Converter basics
check('convert lb->kg exact factor', near(impl.convertVolumeToUnit(100, 'lb', 'kg'), 45.359237, 1e-9));
check('convert kg->lb is the inverse', near(impl.convertVolumeToUnit(100, 'kg', 'lb'), 220.462262, 1e-6));
check('convert same unit is identity', impl.convertVolumeToUnit(100, 'kg', 'kg') === 100 && impl.convertVolumeToUnit(100, 'lb', 'lb') === 100);

// PM counterexample: same day 100 lb + 100 kg
{
  const w = [workout('a', '2026-10-14', 'lb', 100), workout('b', '2026-10-14', 'kg', 100)];
  const tlKg = impl.buildUnifiedTimeline(snap({ displayUnit: 'kg', workouts: w }));
  check('same-day mixed, displayUnit=kg => 145.4 (not 200)', dayOf(tlKg, '2026-10-14').strengthVolume === 145.4, `got ${dayOf(tlKg, '2026-10-14').strengthVolume}`);
  check('same-day mixed, sessions still counted per workout', dayOf(tlKg, '2026-10-14').strengthSessions === 2);
  const tlLb = impl.buildUnifiedTimeline(snap({ displayUnit: 'lb', workouts: w }));
  check('same-day mixed, displayUnit=lb => 320.5', dayOf(tlLb, '2026-10-14').strengthVolume === 320.5, `got ${dayOf(tlLb, '2026-10-14').strengthVolume}`);
  // Switching the display unit must describe the SAME training, not progress:
  check('unit switch round-trips (kg value x 1/0.45359237 ~= lb value)',
    near(dayOf(tlKg, '2026-10-14').strengthVolume / 0.45359237, dayOf(tlLb, '2026-10-14').strengthVolume, 0.15));
  // Original per-workout records are not rewritten by aggregation:
  check('aggregation does not mutate the stored workouts',
    w[0].totalVolume === 100 && w[0].unit === 'lb' && w[1].totalVolume === 100 && w[1].unit === 'kg');
}

// Cross-day mixed: each day converts independently
{
  const w = [workout('a', '2026-10-13', 'lb', 100), workout('b', '2026-10-14', 'kg', 100)];
  const tl = impl.buildUnifiedTimeline(snap({ displayUnit: 'kg', workouts: w }));
  check('cross-day mixed: lb day shows 45.4 kg', dayOf(tl, '2026-10-13').strengthVolume === 45.4, `got ${dayOf(tl, '2026-10-13').strengthVolume}`);
  check('cross-day mixed: kg day shows 100 kg', dayOf(tl, '2026-10-14').strengthVolume === 100);
}

// All-lb and all-kg are unchanged apart from the target-unit conversion
{
  const wl = [workout('a', '2026-10-14', 'lb', 150), workout('b', '2026-10-14', 'lb', 50)];
  check('all-lb in lb => 200', dayOf(impl.buildUnifiedTimeline(snap({ displayUnit: 'lb', workouts: wl })), '2026-10-14').strengthVolume === 200);
  check('all-lb in kg => 90.7', dayOf(impl.buildUnifiedTimeline(snap({ displayUnit: 'kg', workouts: wl })), '2026-10-14').strengthVolume === 90.7);
  const wk = [workout('a', '2026-10-14', 'kg', 80), workout('b', '2026-10-14', 'kg', 20)];
  check('all-kg in kg => 100', dayOf(impl.buildUnifiedTimeline(snap({ displayUnit: 'kg', workouts: wk })), '2026-10-14').strengthVolume === 100);
}

// Zero / missing-weight workouts: totalVolume 0 (sets without both weight
// and reps contribute nothing upstream) adds 0 but still counts as a
// session; it must not suppress or distort the other workout's volume.
{
  const w = [workout('a', '2026-10-14', 'kg', 0), workout('b', '2026-10-14', 'lb', 100)];
  const day = dayOf(impl.buildUnifiedTimeline(snap({ displayUnit: 'kg', workouts: w })), '2026-10-14');
  check('zero-volume workout contributes 0, other workout still converted (45.4), sessions=2',
    day.strengthVolume === 45.4 && day.strengthSessions === 2, `got ${day.strengthVolume}/${day.strengthSessions}`);
  check('empty workout list => empty-strength days stay absent/zero',
    impl.buildUnifiedTimeline(snap({ displayUnit: 'kg', workouts: [] })).every((d) => d.strengthVolume === 0));
}

// Readiness current-week volume text uses the same converted sum.
// 2026-10-14 is a Wednesday; both workouts fall in its Monday week.
{
  const w = [workout('a', '2026-10-13', 'lb', 100), workout('b', '2026-10-14', 'kg', 100)];
  const rKg = impl.calculateReadiness(snap({ displayUnit: 'kg', workouts: w }), '2026-10-15', null);
  const detailKg = rKg.components.find((c) => c.key === 'trainingLoad').detail;
  check('readiness weekly volume in kg is the converted 145 (rounded for display), not 200',
    detailKg.includes('本周力量 145 kg'), detailKg);
  const rLb = impl.calculateReadiness(snap({ displayUnit: 'lb', workouts: w }), '2026-10-15', null);
  const detailLb = rLb.components.find((c) => c.key === 'trainingLoad').detail;
  check('readiness weekly volume in lb is the converted 320, not 200',
    detailLb.includes('本周力量 320 lb'), detailLb);
}

// Mutation sensitivity: raw (unconverted) summing reproduces the bug.
{
  const raw = [workout('a', '2026-10-14', 'lb', 100), workout('b', '2026-10-14', 'kg', 100)]
    .reduce((s, x) => s + x.totalVolume, 0);
  check('mutation baseline: raw sum is the buggy 200 that the assertions above reject', raw === 200);
  const mutatedSrc = src.replace(
    'day.strengthVolume += convertVolumeToUnit(workout.totalVolume, workout.unit, snapshot.strengthTraining.displayUnit);',
    'day.strengthVolume += workout.totalVolume;');
  check('mutation setup: removing the timeline conversion changes the source', mutatedSrc !== src);
}

console.log(`\n${passed} passed, ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
