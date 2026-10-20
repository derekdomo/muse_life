// H4.6 肌群劳累与修复进度 (space-4) validation.
// Runs the REAL production aggregation (muscleStatus + MUSCLE_MAP_V1 +
// MUSCLE_GROUPS) extracted verbatim from client/src/App.tsx over
// synthetic fixtures only. Covers the five required categories:
// (1) primary/secondary counted separately, (2) only completed sets
// count, (3) the 7-day window boundary, (4) unknown exercise keys are
// reported as unmapped and never guessed, (5) empty snapshot yields the
// honest empty state (no zeros dressed up as data). The H4.6 refinement
// adds (6) the three factual display groups (recent / earlier-in-
// snapshot / not-seen) with last-date-descending order and fixed-order
// tie-breaks, and (7) per-muscle source records: stored workout ids
// preserved verbatim, primary/secondary overlap, out-of-window flagging,
// and load summed only over measured completed sets in the original
// unit. It also checks the MUSCLE-MAP v1 table's integrity against its
// fixed vocabulary and executes one source mutation (dropping the
// completed-set filter) to prove the assertions are sensitive to it.
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
function extractConst(source, name) {
  const idx = source.search(new RegExp(`const ${name}(?![A-Za-z0-9_])`));
  if (idx < 0) throw new Error(`const ${name} not found`);
  let depth = 0;
  for (let i = idx; i < source.length; i++) {
    const ch = source[i];
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
    else if (ch === ';' && depth === 0) return source.slice(idx, i + 1);
  }
  throw new Error(`const ${name} unterminated`);
}

function buildFns(src) {
  const code = [
    extractConst(src, 'MUSCLE_GROUPS'),
    extractConst(src, 'MUSCLE_MAP_V1'),
    extractFunction(src, 'muscleStatus'),
  ].join('\n');
  return new Function(`${stripTypeScriptTypes(code)}\nreturn { muscleStatus, MUSCLE_MAP_V1, MUSCLE_GROUPS };`)();
}
const { muscleStatus, MUSCLE_MAP_V1, MUSCLE_GROUPS } = buildFns(clientSrc);

// ------------------------------------------------------------ source checks
check('source: panel states it is unrelated to readiness and not a medical measurement',
  clientSrc.includes('与 readiness 恢复分数无关，不是医学恢复测量'));
check('source: per-muscle row carries the rule-undefined recovery note',
  clientSrc.includes('修复进度：参考间隔规则未定，无法判断恢复进度'));
check('source: panel is wired into the history view and the strength-only view',
  (clientSrc.match(/<MuscleStatusPanel /g) ?? []).length === 2);
check('source: incomplete-snapshot honesty note present',
  clientSrc.includes('只含快照内的训练记录，可能不完整'));
check('source: the three factual group labels are present',
  clientSrc.includes('近7天有记录') && clientSrc.includes('更早的快照内记录') && clientSrc.includes('本快照未见记录'));
check('source: unseen muscles are never worded as never-trained',
  !clientSrc.includes('从未练过'));
check('source: out-of-window sources carry the 本窗口外 badge',
  clientSrc.includes('本窗口外'));
check('source: workout ids render as plain text, never as links (no fabricated deep link for missing sessions)',
  !/<a[^>]*>\{source\.workoutId\}/.test(clientSrc) && clientSrc.includes('场次 {source.workoutId}'));
check('source: no recovery percentage is computed by muscleStatus',
  !/recovery|percent/i.test(extractFunction(clientSrc, 'muscleStatus')));

// ------------------------------------------------------------ map integrity
check('map: vocabulary is the fixed 19-group MUSCLE-MAP v1 enum',
  MUSCLE_GROUPS.length === 19 && new Set(MUSCLE_GROUPS).size === 19);
check('map: table covers exactly the 30 stable keys of MUSCLE-MAP v1',
  Object.keys(MUSCLE_MAP_V1).length === 30);
check('map: every primary/secondary group belongs to the fixed vocabulary',
  Object.values(MUSCLE_MAP_V1).every((entry) =>
    entry.primary.length >= 1 && entry.primary.length <= 2
    && [...entry.primary, ...entry.secondary].every((g) => MUSCLE_GROUPS.includes(g))));
check('map: tibialis-raise maps once to 胫骨前肌 (shared by two templates, one entry)',
  JSON.stringify(MUSCLE_MAP_V1['tibialis-raise']) === JSON.stringify({ primary: ['胫骨前肌'], secondary: [] }));

// ------------------------------------------------------------ synthetic data
const TODAY = '2026-10-19';
function workout(date, status, exercises) { return { date, status, exercises }; }
function exercise(key, completedCount, incompleteCount = 0) {
  const sets = [];
  for (let i = 0; i < completedCount; i++) sets.push({ completed: true });
  for (let i = 0; i < incompleteCount; i++) sets.push({ completed: false });
  return { key, sets };
}
const group = (status, muscle) => status.groups.find((g) => g.muscle === muscle);

// ------------------------------------------- (1) primary/secondary separate
{
  const s = muscleStatus([
    workout('2026-10-18', 'completed', [exercise('barbell-bench', 3, 1), exercise('overhead-press', 2)]),
  ], TODAY);
  const chest = group(s, '胸');
  const triceps = group(s, '肱三头肌');
  const frontDelt = group(s, '肩前束');
  check('primary/secondary: 胸 gets bench press as primary only (3 primary, 0 secondary)',
    chest.primarySets7d === 3 && chest.secondarySets7d === 0);
  check('primary/secondary: 肱三头肌 is secondary in both lifts (0 primary, 3+2=5 secondary)',
    triceps.primarySets7d === 0 && triceps.secondarySets7d === 5);
  check('primary/secondary: 肩前束 is primary in overhead press and secondary in bench (2 primary, 3 secondary)',
    frontDelt.primarySets7d === 2 && frontDelt.secondarySets7d === 3);
  check('primary/secondary: last date and days-since come from the completed workout (2026-10-18, 1 day)',
    chest.lastDate === '2026-10-18' && chest.daysSince === 1 && s.hasCompletedTraining === true);
}

// ------------------------------------------------- (2) only completed sets
{
  const s = muscleStatus([
    workout('2026-10-18', 'completed', [exercise('barbell-bench', 0, 4)]),
  ], TODAY);
  check('completed-only: an exercise with zero completed sets trains nothing and sets no last date',
    group(s, '胸').lastDate === null && group(s, '胸').primarySets7d === 0 && s.hasCompletedTraining === false);
  const active = muscleStatus([
    workout('2026-10-18', 'active', [exercise('barbell-bench', 5)]),
  ], TODAY);
  check('completed-only: an in-progress (active) workout is ignored entirely',
    active.hasCompletedTraining === false && group(active, '胸').primarySets7d === 0 && group(active, '胸').lastDate === null);
  const mixed = muscleStatus([
    workout('2026-10-18', 'completed', [exercise('barbell-bench', 2, 3)]),
  ], TODAY);
  check('completed-only: incomplete sets inside a completed workout are not counted (2, not 5)',
    group(mixed, '胸').primarySets7d === 2);
}

// ------------------------------------------------- (3) 7-day window boundary
{
  const s = muscleStatus([
    workout('2026-10-13', 'completed', [exercise('back-squat', 2)]), // today-6: inside
    workout('2026-10-12', 'completed', [exercise('calf-raise', 4)]), // today-7: outside
    workout('2026-10-20', 'completed', [exercise('dead-bug', 3)]), // future: ignored
  ], TODAY);
  check('window: window is [today-6, today] = 2026-10-13..2026-10-19',
    s.windowStart === '2026-10-13' && s.windowEnd === '2026-10-19');
  check('window: a workout exactly 6 days ago counts toward the 7-day sets （股四头肌 primary 2)',
    group(s, '股四头肌').primarySets7d === 2);
  check('window: a workout exactly 7 days ago is outside the window (0 sets) but still sets last date / days-since 7',
    group(s, '小腿').primarySets7d === 0 && group(s, '小腿').lastDate === '2026-10-12' && group(s, '小腿').daysSince === 7);
  check('window: a future-dated workout is ignored （核心 last date stays at back-squat 2026-10-13, no primary sets from the future dead-bug)',
    group(s, '核心').lastDate === '2026-10-13' && group(s, '核心').primarySets7d === 0 && group(s, '核心').secondarySets7d === 2);
  const todayW = muscleStatus([workout(TODAY, 'completed', [exercise('dead-bug', 1)])], TODAY);
  check('window: a workout today counts, with days-since 0',
    group(todayW, '核心').primarySets7d === 1 && group(todayW, '核心').daysSince === 0);
}

// ------------------------------------------------------- (4) unknown keys
{
  const s = muscleStatus([
    workout('2026-10-19', 'completed', [exercise('mystery-move', 3), exercise('rope-curl', 2)]),
  ], TODAY);
  check('unmapped: unknown key is listed under 尚无映射， never guessed into a muscle',
    JSON.stringify(s.unmappedKeys) === JSON.stringify(['mystery-move']));
  check('unmapped: coverage counts mapped 1 of 2 seen keys',
    s.mappedKeyCount === 1 && s.seenKeyCount === 2);
  check('unmapped: only the mapped exercise contributes sets （肱二头肌 primary 2, grand total 2)',
    group(s, '肱二头肌').primarySets7d === 2
    && s.groups.reduce((sum, g) => sum + g.primarySets7d + g.secondarySets7d, 0) === 2);
  check('unmapped: the workout still counts as completed training',
    s.hasCompletedTraining === true);
}

// ------------------------------------------------------- (5) empty snapshot
for (const [label, input] of [['null', null], ['undefined', undefined], ['empty array', []]]) {
  const s = muscleStatus(input, TODAY);
  check(`empty (${label}): no completed training, all 19 groups present with null last date`,
    s.hasCompletedTraining === false && s.groups.length === 19
    && s.groups.every((g) => g.lastDate === null && g.daysSince === null));
  check(`empty (${label}): no unmapped keys and zero seen keys (no fabricated zeros-as-data)`,
    s.unmappedKeys.length === 0 && s.seenKeyCount === 0 && s.mappedKeyCount === 0);
}

// --------------------------------------- (6) display groups and ordering
function richWorkout(id, date, unit, exercises, status = 'completed') { return { id, date, status, unit, exercises }; }
function richExercise(key, sets) { return { key, sets }; }
function sset(weight, reps, completed = true) { return { weight, reps, completed }; }
{
  const s = muscleStatus([
    richWorkout('w-recent', '2026-10-18', 'lb', [richExercise('barbell-bench', [sset(60, 8), sset(60, 8), sset(60, 6)])]),
    richWorkout('w-tie', '2026-10-15', 'lb', [richExercise('face-pull', [sset(20, 15)]), richExercise('rope-curl', [sset(25, 10)])]),
    richWorkout('w-old-core', '2026-10-08', 'kg', [richExercise('dead-bug', [sset(null, 12)])]),
    richWorkout('w-old-calf', '2026-10-02', 'lb', [richExercise('calf-raise', [sset(40, 12)])]),
  ], TODAY);
  const names = (arr) => arr.map((g) => g.muscle);
  check('sections: the three groups partition all 19 muscles exactly once',
    s.sections.recent.length + s.sections.older.length + s.sections.unseen.length === 19
    && new Set([...names(s.sections.recent), ...names(s.sections.older), ...names(s.sections.unseen)]).size === 19);
  check('sections: membership follows the window （胸 10-18 recent; 核心 10-08 and 小腿 10-02 older; 颈深屈肌 unseen)',
    names(s.sections.recent).includes('胸') && names(s.sections.older).includes('核心')
    && names(s.sections.older).includes('小腿') && names(s.sections.unseen).includes('颈深屈肌'));
  check('sections: recent group ordered by last date descending （胸 10-18 ahead of the 10-15 pair)',
    names(s.sections.recent).indexOf('胸') < names(s.sections.recent).indexOf('肩后束'));
  check('sections: same-day ties fall back to the fixed muscle order （肩后束 ahead of 肱二头肌, both last trained 2026-10-15)',
    names(s.sections.recent).indexOf('肩后束') < names(s.sections.recent).indexOf('肱二头肌'));
  check('sections: older group ordered by last date descending （核心 10-08 ahead of 小腿 10-02)',
    names(s.sections.older).indexOf('核心') < names(s.sections.older).indexOf('小腿'));
  check('sections: unseen groups carry no last date and no sources',
    s.sections.unseen.every((g) => g.lastDate === null && g.sources.length === 0));
  check('sections: groups in sections are the same rows as the flat groups (no divergent copy)',
    s.sections.recent.every((g) => s.groups.includes(g)) && s.sections.older.every((g) => s.groups.includes(g)));
}

// ------------------------------------------------------- (7) source records
{
  const s = muscleStatus([
    richWorkout('w-bench-1', '2026-10-18', 'lb', [richExercise('barbell-bench', [sset(100, 5), sset(100, 5), sset(null, 8)])]),
    richWorkout('w-old-calf', '2026-10-05', 'kg', [richExercise('calf-raise', [sset(40, 10), sset(40, 10)])]),
    richWorkout('w-mystery', '2026-10-18', 'lb', [richExercise('mystery-move', [sset(10, 10)])]),
    richWorkout('w-active', '2026-10-18', 'lb', [richExercise('rope-curl', [sset(20, 10)])], 'active'),
  ], TODAY);
  const chest = group(s, '胸');
  const triceps = group(s, '肱三头肌');
  const calf = group(s, '小腿');
  check('sources: bench press appears once under 胸 as primary with its stored workout id, key and date',
    chest.sources.length === 1 && chest.sources[0].workoutId === 'w-bench-1'
    && chest.sources[0].role === 'primary' && chest.sources[0].exerciseKey === 'barbell-bench'
    && chest.sources[0].date === '2026-10-18');
  check('sources: the same session appears under 肱三头肌 as secondary with the same workout id (primary/secondary overlap)',
    triceps.sources.length === 1 && triceps.sources[0].workoutId === 'w-bench-1' && triceps.sources[0].role === 'secondary');
  check('sources: load sums only measured completed sets in the original unit (100x5 + 100x5 = 1000 lb; the weightless set counts as unmeasured, 3 completed sets total)',
    chest.sources[0].load === 1000 && chest.sources[0].unit === 'lb'
    && chest.sources[0].unmeasuredSets === 1 && chest.sources[0].completedSets === 3);
  check('sources: an out-of-window source keeps its real date, is flagged out of window, and contributes 0 to the 7-day counts',
    calf.sources.length === 1 && calf.sources[0].date === '2026-10-05' && calf.sources[0].inWindow === false
    && calf.primarySets7d === 0 && calf.sources[0].load === 800 && calf.sources[0].unit === 'kg');
  check('sources: in-window sources are flagged in window',
    chest.sources[0].inWindow === true);
  check('sources: unknown keys and non-completed workouts produce no sources anywhere',
    s.groups.every((g) => g.sources.every((src) => src.exerciseKey !== 'mystery-move' && src.workoutId !== 'w-active')));
  check('sources: sources are newest-first within a muscle',
    muscleStatus([
      richWorkout('w-a', '2026-10-10', 'lb', [richExercise('calf-raise', [sset(30, 10)])]),
      richWorkout('w-b', '2026-10-17', 'lb', [richExercise('calf-raise', [sset(30, 10)])]),
    ], TODAY).groups.find((g) => g.muscle === '小腿').sources.map((src) => src.workoutId).join(',') === 'w-b,w-a');
}

// ------------------------------------------------------- mutation sensitivity
{
  const mutated = buildFns(clientSrc.replace(
    'exercise.sets.filter((set) => set.completed)',
    'exercise.sets.filter(() => true)',
  ));
  const real = muscleStatus([workout('2026-10-18', 'completed', [exercise('barbell-bench', 2, 3)])], TODAY);
  const flipped = mutated.muscleStatus([workout('2026-10-18', 'completed', [exercise('barbell-bench', 2, 3)])], TODAY);
  check('mutation: dropping the completed filter inflates 胸 primary sets 2 -> 5',
    group(real, '胸').primarySets7d === 2 && group(flipped, '胸').primarySets7d === 5);
}

console.log(`\n${passed} passed, ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
