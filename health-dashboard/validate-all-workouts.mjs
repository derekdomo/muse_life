// H-WORKOUTS-001 (1) validation — history page "全部运动记录" list.
// Runs the REAL production function allWorkoutsList extracted verbatim from
// health-dashboard/client/src/App.tsx over synthetic data only. Pure Node,
// no deps. Also executes two source mutations (ascending sort; swim-only
// filter) and asserts the mutated function changes the outcome — proving
// sensitivity. Viewport/page evidence stays 运行待验 (owner screenshots are
// PM's runtime acceptance, not claimed here).
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
  const bodyStart = source.indexOf('{', closeParen);
  const bodyEnd = matchDelim(source, bodyStart, '{', '}');
  return source.slice(idx, bodyEnd + 1);
}

// --- source-level wiring checks ---
check('source: 全部运动记录 section exists with its own title id',
  clientSrc.includes('id="all-workouts-title"') && clientSrc.includes('全部运动记录'));
// H-VALID-MAINT-001 (2026-10-24): the two checks below asserted a
// standalone swim section after the all-workouts section. Owner
// ruling LIFE-DESIGN-001-B1B removed that section; swimming is now
// carried by the filter inside the all-workouts section. Replaced
// by equivalent assertions on the NEW structure, not deleted.
check('source: swim records are carried by the in-section filter (standalone swim section removed)',
  !clientSrc.includes('id="swim-history-title"')
  && clientSrc.includes('workoutFilter === "swim" ? allWorkouts.filter((workout) => isSwimWorkout(workout.type)) : allWorkouts')
  && clientSrc.indexOf('workout-filter') > clientSrc.indexOf('all-workouts-title')
  && clientSrc.includes('aria-label="只看游泳记录"') && clientSrc.includes('setWorkoutFilter("swim")'));
check('source: swim reachability retained in HistoryView (filter empty state + fold summary swim count)',
  clientSrc.includes('workoutFilter === "swim" ? "近30天没有游泳 workout 记录。" : "近30天没有 HealthKit 运动记录。"')
  && clientSrc.includes('其中游泳 {swimWorkoutCount} 次'));
check('source: empty state for the all-workouts list',
  clientSrc.includes('近30天没有 HealthKit 运动记录。'));
check('source: HistoryView consumes allWorkoutsList(snapshot.historyWorkouts)',
  clientSrc.includes('allWorkoutsList(snapshot.historyWorkouts)'));
// H-SYNC-DIVERGE-001 (2026-10-18 回灌)：源码自 2026-10-16 起演进——
// 距离渲染现为 null→「—」/0→「0 米」显式三目链（两处 record-row 共用）。
check('source: distance null renders —, zero renders 0 米',
  clientSrc.includes('workout.distanceMeters === null ? "—" : workout.distanceMeters === 0 ? "0 米" : `${numberLabel(workout.distanceMeters)} 米`'));
// H-SYNC-DIVERGE-001 (2026-10-18 回灌)：HealthKit 原文英文代码已改走
// workoutTypeLabel 中文标签映射（a45ebce，线上已批准行为）；未知类型
// 保持原文（不猜标签）。断言新接线 + verbatim 回退，而非旧的原文直显。
check('source: type rendered via workoutTypeLabel (Chinese labels, verbatim fallback)',
  clientSrc.includes('{workoutTypeLabel(workout.type)}')
  && clientSrc.includes('WORKOUT_TYPE_LABELS[type.toLowerCase()] ?? type'));

function buildFn(src) {
  const code = extractFunction(src, 'allWorkoutsList');
  return new Function(`${stripTypeScriptTypes(code)}\nreturn { allWorkoutsList };`)().allWorkoutsList;
}
const allWorkoutsList = buildFn(clientSrc);

const W = (id, date, type, extra = {}) => ({
  id, date, type,
  durationMinutes: 30, energyKcal: 200, distanceMeters: 1000, averageHr: 120,
  ...extra,
});

// --- behaviour ---
const mixed = [
  W('w-run', '2026-10-10', 'Running'),
  W('w-swim', '2026-10-12', 'Swimming'),
  W('w-cycle', '2026-10-11', 'Cycling'),
  W('w-yoga', '2026-10-12', 'Yoga'),
];
const out = allWorkoutsList(mixed);
check('normal: all types present, count preserved', out.length === 4);
check('normal: sorted by date descending across types',
  out.map((w) => w.date).join(',') === '2026-10-12,2026-10-12,2026-10-11,2026-10-10');
check('normal: same-day tie broken by id ascending (stable)',
  out[0].id === 'w-swim' && out[1].id === 'w-yoga');
check('normal: non-swim types are not filtered out',
  out.some((w) => w.type === 'Running') && out.some((w) => w.type === 'Cycling') && out.some((w) => w.type === 'Yoga'));
check('empty: [] in -> [] out', allWorkoutsList([]).length === 0);

const onlyNonSwim = [W('a', '2026-10-09', 'Rowing'), W('b', '2026-10-08', 'Elliptical')];
check('only non-swim: every record listed', allWorkoutsList(onlyNonSwim).length === 2);

const sparse = [W('s1', '2026-10-07', 'Walking', { durationMinutes: null, energyKcal: null, distanceMeters: null, averageHr: null })];
const sparseOut = allWorkoutsList(sparse);
check('missing fields: record kept, nulls preserved (rendered as —, never filled)',
  sparseOut.length === 1 && sparseOut[0].distanceMeters === null && sparseOut[0].durationMinutes === null && sparseOut[0].averageHr === null && sparseOut[0].energyKcal === null);

const zeros = [W('z1', '2026-10-06', 'Walking', { distanceMeters: 0, durationMinutes: 0, energyKcal: 0 })];
const zerosOut = allWorkoutsList(zeros);
check('zero values: real 0 preserved as 0 (not treated as missing)',
  zerosOut[0].distanceMeters === 0 && zerosOut[0].durationMinutes === 0 && zerosOut[0].energyKcal === 0);

const before = mixed.map((w) => w.id).join(',');
allWorkoutsList(mixed);
check('input array is not mutated', mixed.map((w) => w.id).join(',') === before);

// --- mutation sensitivity (executed, not just described) ---
// 源码 allWorkoutsList 现为 [...historyWorkouts].sort + localeCompare（两轮
// 回灌后的形态）。变异逐字对准新模式。
const ascSrc = clientSrc.replaceAll('b.date.localeCompare(a.date)', 'a.date.localeCompare(b.date)');
check('mutation setup: ascending-sort variant differs from source', ascSrc !== clientSrc);
const ascOut = buildFn(ascSrc)(mixed);
check('mutation: ascending sort flips the produced order',
  ascOut.map((w) => w.date).join(',') === '2026-10-10,2026-10-11,2026-10-12,2026-10-12');

const swimOnlySrc = clientSrc.replace('return [...historyWorkouts].sort(',
  'return [...historyWorkouts].filter((w) => w.type.toLowerCase().includes("swim")).sort(');
check('mutation setup: swim-only variant differs from source', swimOnlySrc !== clientSrc);
const swimOnlyOut = buildFn(swimOnlySrc)(mixed);
check('mutation: swim-only filter drops non-swim records',
  swimOnlyOut.length === 1 && swimOnlyOut[0].type === 'Swimming');

console.log(`\n${passed} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
