// H4.6 肌群劳累与修复进度 (space-4) validation.
// Runs the REAL production aggregation (muscleStatus + MUSCLE_MAP_V1 +
// MUSCLE_GROUPS) extracted verbatim from client/src/App.tsx over
// synthetic fixtures only. Covers the five required categories:
// (1) primary/secondary counted separately, (2) only completed sets
// count, (3) the 7-day window boundary, (4) unknown exercise keys are
// reported as unmapped and never guessed, (5) empty snapshot yields the
// honest empty state (no zeros dressed up as data). It also checks the
// MUSCLE-MAP v1 table's integrity against its fixed vocabulary and
// executes one source mutation (dropping the completed-set filter) to
// prove the assertions are sensitive to it. Pure Node, no deps.
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
