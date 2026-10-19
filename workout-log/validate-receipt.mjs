// W4.3-D1 validation — completion receipt （训练完成回执）.
// Runs the REAL production pure functions extracted verbatim from
// client/src/App.tsx (groupSets, targetRange, progressionDecision,
// receiptReadPhase, receiptExerciseLines) and server/src/actions.ts
// (selectReceiptPrevious), over synthetic data only, plus source
// wiring checks for the parts that need the live action channel:
//  - full completion -> totals with zero incomplete, W1 increase
//    suggestion derived from the just-finished record itself;
//  - ending with uncompleted sets -> they are counted as uncompleted
//    (never zero-filled), the suggestion holds the weight and asks
//    to finish all sets first; a REAL recorded 0 reps still drives
//    the W1 reduce verdict while a MISSING reps record yields
//    数据不足 — true zero and missing stay distinct;
//  - bodyweight-only exercise (no weighed completed set) ->
//    数据不足， no invented weight suggestion;
//  - no earlier comparable record -> previous null (UI: 暂无可比记录）;
//  - same exercise NAME under a different key never matches, on both
//    the server selection and the client line builder;
//  - server selection picks the most recent earlier candidate per
//    key and reports a real 0 completed count as 0;
//  - read-back phase matrix: pending -> reading, transport error or
//    success-without-record -> unavailable (retryable), found ->
//    ready;
//  - wiring: the receipt read is by exact id under the existing
//    getDashboard gate, the retry re-reads only (no completeWorkout
//    anywhere in the receipt component), and the finish button stays
//    disabled while a finish is in flight (duplicate-complete guard,
//    backed server-side by completeWorkout's completed_at IS NULL
//    condition).
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';

const clientSrc = readFileSync(new URL('./client/src/App.tsx', import.meta.url), 'utf8');
const serverSrc = readFileSync(new URL('./server/src/actions.ts', import.meta.url), 'utf8');

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
  const between = source.slice(closeParen + 1, bodyStart).trimStart();
  if (between.startsWith(':')) {
    const typeEnd = matchDelim(source, bodyStart, '{', '}');
    const nextBrace = source.indexOf('{', typeEnd);
    if (nextBrace > -1 && source.slice(typeEnd + 1, nextBrace).trim() === '') bodyStart = nextBrace;
  }
  const bodyEnd = matchDelim(source, bodyStart, '{', '}');
  return source.slice(idx, bodyEnd + 1);
}
const CLIENT_FN = ['groupSets', 'targetRange', 'progressionDecision', 'receiptReadPhase', 'receiptExerciseLines'];
function buildClient(src) {
  const code = CLIENT_FN.map((n) => extractFunction(src, n)).join('\n');
  return new Function(`${stripTypeScriptTypes(code)}\nreturn { ${CLIENT_FN.join(', ')} };`)();
}
const C = buildClient(clientSrc);
const S = new Function(
  `${stripTypeScriptTypes(extractFunction(serverSrc, 'selectReceiptPrevious'))}\nreturn { selectReceiptPrevious };`,
)();

// --- synthetic data builders ---
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
    started_at: '2026-10-17T01:00:00.000Z',
    completed_at: '2026-10-17T02:00:00.000Z',
    sets,
  };
}
const setsOf = (workoutId, key, name, target, list) =>
  list.map((s, i) => mkSet(workoutId, key, name, i + 1, target, s[0], s[1], s[2]));

// --- S1: full completion, W1 increase from THIS record ---
{
  const workout = mkWorkout(101, 'push', 'lb', [
    ...setsOf(101, 'barbell-bench', '杠铃卧推', '6–8', [[100, 8, true], [100, 8, true], [100, 8, true], [100, 8, true]]),
    ...setsOf(101, 'dips', '双杠臂屈伸', '10–12', [[null, 11, true], [null, 10, true], [null, 10, true]]),
  ]);
  const previous = [
    { exercise_key: 'barbell-bench', source_completed_at: '2026-10-13T02:00:00.000Z', completed_sets: 3, total_sets: 4 },
  ];
  const lines = C.receiptExerciseLines(workout, previous);
  const bench = lines.find((l) => l.key === 'barbell-bench');
  check('S1 full: bench counts are 4/4 with 0 incomplete',
    bench.completedSets === 4 && bench.totalSets === 4 && bench.incompleteSets === 0);
  check('S1 full: all sets at the rep cap -> W1 increase suggestion from this record',
    bench.suggestion === '下次增至 105lb', bench.suggestion);
  check('S1 full: previous comparable is attached by key with its source date',
    bench.previous !== null && bench.previous.completedSets === 3 && bench.previous.totalSets === 4
    && bench.previous.sourceDate === '2026-10-13T02:00:00.000Z');
  const dips = lines.find((l) => l.key === 'dips');
  check('S1 full: bodyweight exercise (no weighed set) -> 数据不足， never an invented weight',
    dips.suggestion === '数据不足', dips.suggestion);
  check('S1 full: exercise missing from previous entries -> previous null （暂无可比记录）',
    dips.previous === null);
}

// --- S2: ended with uncompleted sets ---
{
  const workout = mkWorkout(102, 'legs', 'lb', [
    ...setsOf(102, 'back-squat', '深蹲', '6–8', [[140, 6, true], [140, 6, true], [140, 6, true], [140, null, false]]),
  ]);
  const [squat] = C.receiptExerciseLines(workout, []);
  check('S2 incomplete: counts are 3/4 with exactly 1 uncompleted',
    squat.completedSets === 3 && squat.totalSets === 4 && squat.incompleteSets === 1);
  check('S2 incomplete: the uncompleted set is NOT zero-filled into a reduce verdict — W1 holds the weight',
    squat.suggestion === '下次维持 140lb，先完成全部 4 组', squat.suggestion);
  check('S2 incomplete: empty previous list -> previous null', squat.previous === null);
}

// --- S2b/S2c: true zero vs missing stay distinct ---
{
  const zeroWorkout = mkWorkout(103, 'pull', 'lb', [
    ...setsOf(103, 'face-pull', '面拉', '12–15', [[20, 0, true], [20, 0, true], [20, 0, true]]),
  ]);
  const [zeroLine] = C.receiptExerciseLines(zeroWorkout, undefined);
  check('S2b true zero: recorded 0 reps is real data -> W1 reduce verdict applies',
    zeroLine.suggestion === '下次降至 15lb', zeroLine.suggestion);
  const missingWorkout = mkWorkout(104, 'pull', 'lb', [
    ...setsOf(104, 'face-pull', '面拉', '12–15', [[20, null, true], [20, 12, true], [20, 12, true]]),
  ]);
  const [missingLine] = C.receiptExerciseLines(missingWorkout, undefined);
  check('S2c missing: a completed set with reps missing -> 数据不足， not treated as 0',
    missingLine.suggestion === '数据不足', missingLine.suggestion);
  check('S2c missing: undefined previous argument -> previous null', missingLine.previous === null);
}

// --- S3: read-back phase matrix (incl. read failure -> retryable) ---
{
  check('S3 phase: read in flight -> reading （训练已结束，正在读取记录）',
    C.receiptReadPhase({ isPending: true, isError: false, receiptFound: false }) === 'reading');
  check('S3 phase: read in flight wins even over a stale found flag',
    C.receiptReadPhase({ isPending: true, isError: false, receiptFound: true }) === 'reading');
  check('S3 phase: transport error -> unavailable （记录暂未读出， retryable)',
    C.receiptReadPhase({ isPending: false, isError: true, receiptFound: false }) === 'unavailable');
  check('S3 phase: successful response without the record -> unavailable, never a substitute record',
    C.receiptReadPhase({ isPending: false, isError: false, receiptFound: false }) === 'unavailable');
  check('S3 phase: record found by id -> ready',
    C.receiptReadPhase({ isPending: false, isError: false, receiptFound: true }) === 'ready');
}

// --- S4: same name, different key never matches (client + server) ---
{
  const workout = mkWorkout(105, 'push', 'lb', [
    ...setsOf(105, 'dips', '双杠臂屈伸', '10–12', [[null, 10, true], [null, 10, true], [null, 10, true]]),
  ]);
  const previous = [
    { exercise_key: 'weighted-dips', source_completed_at: '2026-10-13T02:00:00.000Z', completed_sets: 3, total_sets: 3 },
  ];
  const [line] = C.receiptExerciseLines(workout, previous);
  check('S4 client: a previous entry under a different key does not match the same-named exercise',
    line.previous === null);
  const serverEntries = S.selectReceiptPrevious(
    [{ id: 9, completed_at: '2026-10-13T02:00:00.000Z', sets: [
      { exercise_key: 'weighted-dips', completed: true },
      { exercise_key: 'weighted-dips', completed: true },
    ] }],
    ['dips'],
  );
  check('S4 server: selectReceiptPrevious matches by key only -> no entry', serverEntries.length === 0);
}

// --- S5: server selection — most recent earlier per key, real zero ---
{
  const candidates = [
    { id: 30, completed_at: '2026-10-15T02:00:00.000Z', sets: [
      { exercise_key: 'barbell-bench', completed: true },
      { exercise_key: 'barbell-bench', completed: true },
      { exercise_key: 'barbell-bench', completed: true },
      { exercise_key: 'barbell-bench', completed: true },
    ] },
    { id: 20, completed_at: '2026-10-13T02:00:00.000Z', sets: [
      { exercise_key: 'barbell-bench', completed: true },
      { exercise_key: 'barbell-bench', completed: false },
      { exercise_key: 'back-squat', completed: false },
      { exercise_key: 'back-squat', completed: false },
      { exercise_key: 'back-squat', completed: false },
    ] },
  ];
  const entries = S.selectReceiptPrevious(candidates, ['barbell-bench', 'back-squat', 'face-pull']);
  const bench = entries.find((e) => e.exercise_key === 'barbell-bench');
  const squat = entries.find((e) => e.exercise_key === 'back-squat');
  check('S5 server: bench takes the MOST RECENT earlier candidate (4/4 on 10-15, not 1/2 on 10-13)',
    bench !== undefined && bench.completed_sets === 4 && bench.total_sets === 4
    && bench.source_completed_at === '2026-10-15T02:00:00.000Z');
  check('S5 server: squat falls back to the older candidate and reports a real 0/3',
    squat !== undefined && squat.completed_sets === 0 && squat.total_sets === 3);
  check('S5 server: an exercise absent from every candidate gets no entry （暂无可比记录）',
    entries.find((e) => e.exercise_key === 'face-pull') === undefined);
  check('S5 server: entry order follows the receipt workout\'s exercise order',
    entries.map((e) => e.exercise_key).join(',') === 'barbell-bench,back-squat');
}

// --- wiring checks ---
{
  const dashBegin = serverSrc.indexOf('getDashboard: defineAction');
  const dashEnd = serverSrc.indexOf('startWorkout: defineAction');
  const dashSlice = serverSrc.slice(dashBegin, dashEnd);
  check('wiring(server): getDashboard accepts the additive optional receipt_workout_id',
    dashSlice.includes('receipt_workout_id: z.number().int().positive().optional()'));
  check('wiring(server): the receipt is located strictly by id via loadWorkout',
    dashSlice.includes('loadWorkout(ctx, args.receipt_workout_id)'));
  check('wiring(server): an uncompleted/unknown id answers receipt: null (no substitution)',
    dashSlice.includes('receiptFields = { receipt: null, receipt_previous: [] }'));
  check('wiring(server): the owner/sync gate still runs before any receipt read',
    dashSlice.indexOf('isOwnerOrSyncChannel(ctx)') > -1
    && dashSlice.indexOf('isOwnerOrSyncChannel(ctx)') < dashSlice.indexOf('receipt_workout_id != null'));
  check('wiring(server): the forbidden early return carries no receipt fields (zero data)',
    dashSlice.includes('return { forbidden: true, active_workout: null, recent_workouts: [], week_summaries: [] };'));
  check('wiring(server): dashboardResponse receipt fields are additive optionals',
    serverSrc.includes('receipt: workoutResponse.nullable().optional()')
    && serverSrc.includes('receipt_previous: z.array(receiptPreviousEntryResponse).optional()'));
  check('wiring(server): previous candidates are same-routine only',
    serverSrc.includes('eq(schema.workouts.routine, receipt.routine)'));

  const receiptBegin = clientSrc.indexOf('function CompletionReceipt(');
  const receiptEnd = clientSrc.indexOf('function ExerciseGuideDialog(');
  const receiptSlice = clientSrc.slice(receiptBegin, receiptEnd);
  check('wiring(client): the receipt reads back via getDashboard with the exact workout id',
    receiptSlice.includes('receipt_workout_id: workoutId'));
  check('wiring(client): intermediate + retryable states carry the contracted wording',
    receiptSlice.includes('训练已结束，正在读取记录') && receiptSlice.includes('记录暂未读出'));
  check('wiring(client): retry re-reads ONLY — no completeWorkout anywhere in the receipt component',
    receiptSlice.includes('query.refetch()') && !receiptSlice.includes('completeWorkout'));
  check('wiring(client): receipt shows 暂无可比记录 and 数据不足 states',
    receiptSlice.includes('暂无可比记录') && clientSrc.includes('"数据不足"'));
  check('wiring(client): finish button is disabled while finishing (duplicate-complete guard)',
    clientSrc.includes('disabled={complete.isPending || finishing}'));
  const completeBegin = serverSrc.indexOf('completeWorkout: defineAction');
  const completeEnd = serverSrc.indexOf('discardWorkout: defineAction');
  const completeSlice = serverSrc.slice(completeBegin, completeEnd);
  check('wiring(server): a duplicate completeWorkout is refused by the completed_at IS NULL condition',
    completeSlice.includes('isNull(schema.workouts.completedAt)'));
  check('wiring(client): App keys the receipt by the id completeWorkout finished',
    clientSrc.includes('onCompleted={(workoutId) => setReceiptId(workoutId)}'));
}

console.log(`\n${passed} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
