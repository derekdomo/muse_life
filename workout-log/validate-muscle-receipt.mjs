// W6.2 / H4.6 validation — exercise->muscle map (MUSCLE-MAP.md v1) and
// the completion receipt's muscle facts （本次训练肌群事实）.
// Runs the REAL production code extracted verbatim from
// client/src/App.tsx (MUSCLE_MAP, MUSCLE_MAP_VERSION, groupSets,
// muscleReceiptFacts) over synthetic data only, plus source wiring
// checks for the guide dialog and receipt UI:
//  - map integrity: exactly the 30 stable keys of MUSCLE-MAP.md v1,
//    primary/secondary identical to the document, incl. both calf
//    keys mapped (primary 小腿） and the empty-secondary entries;
//  - duplicate attribution: one exercise's completed sets count under
//    EACH of its muscle groups, primary and secondary alike, so the
//    per-group counts exceed the workout's completed-set total;
//  - only completed sets count; an exercise with zero completed sets
//    contributes nothing (not even an unmapped line);
//  - unknown/custom key -> listed once under unmapped （尚无映射）,
//    never guessed into a muscle group;
//  - bodyweight / timed sets (weight null) still count their sets;
//  - empty workout -> no facts at all.
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
function extractConstObject(source, name) {
  const idx = source.search(new RegExp(`const ${name}\\s*:`));
  if (idx < 0) throw new Error(`const ${name} not found`);
  const bodyStart = source.indexOf('{', idx);
  const bodyEnd = matchDelim(source, bodyStart, '{', '}');
  return source.slice(idx, bodyEnd + 1);
}
const versionMatch = clientSrc.match(/MUSCLE_MAP_VERSION = (\d+)/);
const code = [
  extractConstObject(clientSrc, 'MUSCLE_MAP'),
  extractFunction(clientSrc, 'groupSets'),
  extractFunction(clientSrc, 'muscleReceiptFacts'),
].join('\n');
const { MUSCLE_MAP, muscleReceiptFacts } = new Function(
  `${stripTypeScriptTypes(code)}\nreturn { MUSCLE_MAP, muscleReceiptFacts };`,
)();

// --- synthetic data builders (same shape as validate-receipt.mjs) ---
let setId = 0;
function mkSet(workoutId, key, name, n, target, weight, reps, completed) {
  setId += 1;
  return {
    id: setId, workout_id: workoutId, exercise_key: key, exercise_name: name,
    set_number: n, target_reps: target, weight, reps, completed,
  };
}
function mkWorkout(id, routine, unit, sets) {
  return {
    id, routine, unit,
    started_at: '2026-10-19T01:00:00.000Z',
    completed_at: '2026-10-19T02:00:00.000Z',
    sets,
  };
}
const setsOf = (workoutId, key, name, target, list) =>
  list.map((s, i) => mkSet(workoutId, key, name, i + 1, target, s[0], s[1], s[2]));
const fact = (facts, muscle) => facts.find((f) => f.muscle === muscle);
const sameList = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

// --- M0: map integrity vs MUSCLE-MAP.md v1 ---
{
  check('M0 version: MUSCLE_MAP_VERSION is 1', versionMatch !== null && versionMatch[1] === '1');
  const expected = {
    'barbell-bench': [['胸'], ['肱三头肌', '肩前束']],
    'overhead-press': [['肩前束', '肩中束'], ['肱三头肌', '核心']],
    'incline-dumbbell-press': [['胸'], ['肩前束', '肱三头肌']],
    dips: [['胸', '肱三头肌'], ['肩前束']],
    'lateral-raise': [['肩中束'], ['斜方肌']],
    'push-up-plus': [['前锯肌'], ['胸', '核心']],
    'wide-lat-pulldown': [['背阔肌'], ['肱二头肌', '肩后束']],
    'close-lat-pulldown': [['背阔肌'], ['肱二头肌']],
    'close-seated-row': [['背阔肌', '菱形肌'], ['肱二头肌', '斜方肌']],
    'wide-seated-row': [['菱形肌', '肩后束'], ['背阔肌', '斜方肌']],
    'face-pull': [['肩后束'], ['斜方肌', '菱形肌']],
    'reverse-pec-deck': [['肩后束'], ['斜方肌']],
    'rope-curl': [['肱二头肌'], []],
    'back-squat': [['股四头肌', '臀大肌'], ['核心', '腘绳肌']],
    'romanian-deadlift': [['腘绳肌', '臀大肌'], ['斜方肌', '核心']],
    'bulgarian-split-squat': [['股四头肌', '臀大肌'], ['小腿', '核心']],
    'lying-leg-curl': [['腘绳肌'], ['小腿']],
    'calf-raise': [['小腿'], []],
    'tibialis-raise': [['胫骨前肌'], []],
    'supine-chin-tuck': [['颈深屈肌'], []],
    'prone-ytw': [['斜方肌', '肩后束'], ['菱形肌', '胸椎伸展肌群']],
    'side-external-rotation': [['肩后束'], []],
    'thoracic-extension': [['胸椎伸展肌群'], []],
    'single-leg-balance': [['小腿', '臀大肌'], ['核心']],
    'home-bulgarian-split-squat': [['股四头肌', '臀大肌'], ['小腿', '核心']],
    'bench-step-up': [['股四头肌', '臀大肌'], ['小腿']],
    'home-calf-raise': [['小腿'], []],
    'wall-sit': [['股四头肌'], ['臀大肌']],
    'dead-bug': [['核心'], []],
    'side-plank': [['腹斜肌', '核心'], ['臀大肌']],
  };
  const keys = Object.keys(MUSCLE_MAP);
  check('M0 map: exactly 30 mapped keys', keys.length === 30, `${keys.length} keys`);
  check('M0 map: key set matches MUSCLE-MAP.md v1 exactly',
    sameList([...keys].sort(), Object.keys(expected).sort()));
  const mismatches = Object.entries(expected).filter(([key, [p, s]]) => {
    const entry = MUSCLE_MAP[key];
    return !entry || !sameList(entry.primary, p) || !sameList(entry.secondary, s);
  });
  check('M0 map: every primary/secondary list is identical to MUSCLE-MAP.md v1',
    mismatches.length === 0, mismatches.map(([k]) => k).join(','));
  check('M0 map: both calf keys are mapped (primary 小腿）, only their demo image is absent',
    sameList(MUSCLE_MAP['calf-raise'].primary, ['小腿']) && sameList(MUSCLE_MAP['home-calf-raise'].primary, ['小腿']));
}

// --- M1: duplicate attribution across muscle groups ---
{
  const workout = mkWorkout(201, 'push', 'lb', [
    ...setsOf(201, 'overhead-press', '站姿推举', '6–8', [[60, 8, true], [60, 7, true], [60, 7, true]]),
  ]);
  const facts = muscleReceiptFacts(workout);
  check('M1 duplicate: 3 completed sets count under BOTH primary groups （肩前束 and 肩中束）',
    fact(facts.primary, '肩前束')?.sets === 3 && fact(facts.primary, '肩中束')?.sets === 3);
  check('M1 duplicate: the same 3 sets also count under BOTH secondary groups （肱三头肌 and 核心）',
    fact(facts.secondary, '肱三头肌')?.sets === 3 && fact(facts.secondary, '核心')?.sets === 3);
  const primarySum = facts.primary.reduce((sum, f) => sum + f.sets, 0);
  check('M1 duplicate: per-group counts sum past the workout total (6 > 3) — never a whole-body total',
    primarySum === 6);
  check('M1 duplicate: the exercise name is attached to each group it fed',
    fact(facts.primary, '肩前束')?.exercises.join(',') === '站姿推举'
    && fact(facts.secondary, '核心')?.exercises.join(',') === '站姿推举');
  check('M1 duplicate: nothing unmapped', facts.unmapped.length === 0);
}

// --- M2: only completed sets count ---
{
  const workout = mkWorkout(202, 'push', 'lb', [
    ...setsOf(202, 'barbell-bench', '杠铃卧推', '6–8', [[100, 8, true], [100, 8, true], [100, null, false], [100, null, false]]),
    ...setsOf(202, 'dips', '双杠臂屈伸', '10–12', [[null, null, false], [null, null, false], [null, null, false]]),
  ]);
  const facts = muscleReceiptFacts(workout);
  check('M2 completed-only: bench contributes exactly its 2 completed sets to 胸',
    fact(facts.primary, '胸')?.sets === 2 && fact(facts.primary, '胸')?.exercises.join(',') === '杠铃卧推');
  check('M2 completed-only: zero-completed dips adds nothing to 胸/肱三头肌 and is not listed anywhere',
    fact(facts.primary, '肱三头肌') === undefined
    && fact(facts.secondary, '肱三头肌')?.sets === 2
    && !facts.unmapped.includes('双杠臂屈伸'));
}

// --- M3: unknown key -> 尚无映射， never guessed ---
{
  const workout = mkWorkout(203, 'pull', 'lb', [
    ...setsOf(203, 'my-custom-row', '自创划船', '8–10', [[50, 10, true], [50, 9, true]]),
    ...setsOf(203, 'rope-curl', '绳索弯举', '10–12', [[30, 12, true], [30, 11, true], [30, 11, true]]),
  ]);
  const facts = muscleReceiptFacts(workout);
  check('M3 unknown: the custom exercise is listed once under unmapped by name',
    facts.unmapped.length === 1 && facts.unmapped[0] === '自创划船');
  check('M3 unknown: its sets leak into NO muscle group (no name-similarity guessing)',
    fact(facts.primary, '背阔肌') === undefined && fact(facts.secondary, '背阔肌') === undefined);
  check('M3 unknown: the known exercise still aggregates normally （肱二头肌 3 组）',
    fact(facts.primary, '肱二头肌')?.sets === 3);
  check('M3 unknown: rope-curl has no secondary mapping -> secondary list stays empty',
    facts.secondary.length === 0);
}

// --- M4: bodyweight / timed sets still count their sets ---
{
  const workout = mkWorkout(204, 'home_snowboard', 'lb', [
    ...setsOf(204, 'wall-sit', '靠墙静蹲', '45–90 秒', [[null, null, true], [null, null, true]]),
    ...setsOf(204, 'dead-bug', '死虫', '8–10', [[null, 10, true], [null, 9, true], [null, 9, true]]),
  ]);
  const facts = muscleReceiptFacts(workout);
  check('M4 bodyweight: timed wall-sit (no weight, no reps) counts 2 sets under 股四头肌',
    fact(facts.primary, '股四头肌')?.sets === 2);
  check('M4 bodyweight: wall-sit secondary 臀大肌 counts the same 2 sets',
    fact(facts.secondary, '臀大肌')?.sets === 2);
  check('M4 bodyweight: dead-bug counts 3 sets under 核心 with no weight anywhere',
    fact(facts.primary, '核心')?.sets === 3);
}

// --- M5: empty workout -> no facts ---
{
  const facts = muscleReceiptFacts(mkWorkout(205, 'push', 'lb', []));
  check('M5 empty: no sets -> primary, secondary and unmapped are all empty',
    facts.primary.length === 0 && facts.secondary.length === 0 && facts.unmapped.length === 0);
  const noneDone = muscleReceiptFacts(mkWorkout(206, 'push', 'lb', [
    ...setsOf(206, 'barbell-bench', '杠铃卧推', '6–8', [[100, null, false]]),
  ]));
  check('M5 empty: a workout with only uncompleted sets is equally fact-free',
    noneDone.primary.length === 0 && noneDone.secondary.length === 0 && noneDone.unmapped.length === 0);
}

// --- wiring checks ---
{
  const guideBegin = clientSrc.indexOf('function ExerciseGuideDialog(');
  const guideEnd = clientSrc.indexOf('// --- W-UI-001', guideBegin);
  const guideSlice = clientSrc.slice(guideBegin, guideEnd > guideBegin ? guideEnd : undefined);
  check('wiring(guide): dialog has a 练到哪里 muscle section fed by MUSCLE_MAP[exerciseKey]',
    guideSlice.includes('练到哪里') && guideSlice.includes('MUSCLE_MAP[exerciseKey]'));
  check('wiring(guide): primary/secondary lines carry symbol + label （● 主要：/ ○ 次要：), not colour alone',
    guideSlice.includes('●') && guideSlice.includes('主要：') && guideSlice.includes('○') && guideSlice.includes('次要：'));
  check('wiring(guide): an empty secondary renders — and an unknown key renders 尚无映射',
    guideSlice.includes('"—"') && guideSlice.includes('尚无映射'));
  check('wiring(guide): the dialog is opened with the exercise key from the workout block',
    clientSrc.includes('onOpenGuide(guide, exercise.key)')
    && clientSrc.includes('exerciseKey={selectedGuide.key}'));

  const receiptBegin = clientSrc.indexOf('function CompletionReceipt(');
  const receiptEnd = clientSrc.indexOf('function ExerciseGuideDialog(', receiptBegin);
  const receiptSlice = clientSrc.slice(receiptBegin, receiptEnd);
  check('wiring(receipt): the receipt renders 本次训练肌群事实 from muscleReceiptFacts(workout)',
    receiptSlice.includes('本次训练肌群事实') && receiptSlice.includes('muscleReceiptFacts(workout)'));
  check('wiring(receipt): primary and secondary groups are labelled with symbols （● 主要 · / ○ 次要 ·)',
    receiptSlice.includes('●') && receiptSlice.includes('主要 ·') && receiptSlice.includes('○') && receiptSlice.includes('次要 ·'));
  check('wiring(receipt): unmapped exercises render on a 尚无映射 line',
    receiptSlice.includes('尚无映射：'));
  check('wiring(receipt): the duplicate-attribution caveat is printed at the section foot',
    receiptSlice.includes('重复归属') && receiptSlice.includes('不可相加为总容量'));
  check('wiring(receipt): the muscle section reports sets and exercise names only — no volume figure',
    !/receipt-muscle[\s\S]{0,400}(kg|lb)/.test(receiptSlice.slice(receiptSlice.indexOf('receipt-muscles'))));
}

console.log(`\n${passed} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
