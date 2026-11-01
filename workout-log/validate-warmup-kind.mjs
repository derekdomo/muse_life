// W-WARMUP-KIND-001 validation — warmup identity stays non-persistent
// (design / source review + wiring evidence; no new visible feature).
//
// Resolved design (no schema migration, no kept recordable warmup):
//   (1) No warmup write path remains in the client. The P0 fix
//       (W-WARMUP-WRITE-001) deleted the unsafe prepend path
//       (handleAddWarmup -> onAddWarmupSets -> handleAddWarmupSets);
//       nothing repopulates it.
//   (2) The guided flow's warmup (W-TRAIN-FLOW-001) is local-only prep
//       steps: never workout sets, never in formal set counts, progress
//       lives in sessionStorage on this device only, and a reload shows
//       an explicit recovery choice instead of inventing persistence.
//   (3) No set-type column was added to workout_sets (deliberate — an
//       irreversible schema expansion for records that are no longer
//       written); old untyped records stay "unknown" and NO consumer
//       guesses a warmup type from weight values.
//
// Runs the REAL production functions extracted verbatim from
// client/src/App.tsx (warmupStepsFor, read/writeWarmupProgress) against
// a fake sessionStorage, plus source-wiring checks and mutation
// sensitivity runs.
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';

const clientSrc = readFileSync(new URL('./client/src/App.tsx', import.meta.url), 'utf8');
const serverSrc = ['actions.ts', 'schema.ts', 'progression-engine.ts', 'action-trends.ts',
  'week-frequency.ts', 'muscle-heatmap.ts', 'deload-advisory.ts']
  .map((f) => readFileSync(new URL(`./server/src/${f}`, import.meta.url), 'utf8'));
const schemaSrc = serverSrc[1];

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
function extractFunctionEnd(source, name) {
  const idx = source.search(new RegExp(`(export\\s+)?function ${name}\\(`));
  if (idx < 0) throw new Error(`function ${name} not found`);
  const openParen = source.indexOf('(', idx);
  const closeParen = matchDelim(source, openParen, '(', ')');
  const bodyStart = source.indexOf('{', closeParen);
  return matchDelim(source, bodyStart, '{', '}') + 1;
}
const lines = clientSrc.split('\n');

// --- A: no warmup write path remains ---------------------------------
check('A1 P0 path gone: no function handleAddWarmupSets definition',
  !/function\s+handleAddWarmupSets\s*\(/.test(clientSrc));
check('A2 P0 path gone: onAddWarmupSets survives only in a removal comment',
  lines.filter((l) => /\bonAddWarmupSets\b/.test(l)).every((l) => l.trimStart().startsWith('//')));
check('A3 warmupSetIds has no setter (never repopulated)',
  !/\bsetWarmupSetIds\b/.test(clientSrc));
check('A4 warmupSetIds declared as a single-element destructure (no setter)',
  /const \[warmupSetIds\] = useState<ReadonlySet<number>>\(\(\) => new Set<number>\(\)\)/.test(clientSrc));
check('A5 no .add()/.delete() on warmupSetIds anywhere',
  !/warmupSetIds\.(add|delete)\s*\(/.test(clientSrc));

const toolStart = clientSrc.indexOf('function PlateWarmupTool(');
const toolEnd = clientSrc.indexOf('function ExerciseBlock(');
const toolChunk = clientSrc.slice(toolStart, toolEnd);
check('A6 PlateWarmupTool is read-only: no addSet/updateSet/mutate/api write in it',
  !/addSet\s*\(/.test(toolChunk) && !/updateSet\s*\(/.test(toolChunk)
  && !/mutateAsync/.test(toolChunk) && !/api\./.test(toolChunk));

check('A7 guided flow is honest: warmup progress is device-local, never written as sets',
  clientSrc.includes('热身进度只存在这台设备上，没有写入训练记录'));
check('A8 formal counts exclude warmup, with explicit recovery choices',
  clientSrc.includes('热身不计入')
  && clientSrc.includes('已热身，进入正式训练')
  && clientSrc.includes('重新热身'));

// --- B: warmupStepsFor is prep-only text, never sets ------------------
const wfStart = clientSrc.indexOf('export function warmupStepsFor(');
const wfSrc = clientSrc.slice(wfStart, extractFunctionEnd(clientSrc, 'warmupStepsFor'));
const wfFn = new Function('ROUTINE_META',
  `${stripTypeScriptTypes(wfSrc.replace(/^export /m, ''))}\nreturn warmupStepsFor;`)({
  push: { warmup: '弹力带肩外旋 2×15 · 空杆卧推 2×12 ·  · 动态拉伸 5 分钟' },
});
{
  const steps = wfFn('push');
  check('B1 warmupStepsFor splits routine text on · and drops empties',
    Array.isArray(steps) && steps.length === 3
    && steps[0] === '弹力带肩外旋 2×15' && steps[2] === '动态拉伸 5 分钟');
  check('B2 steps are plain text, never set identities',
    steps.every((s) => typeof s === 'string'));
}
check('B3 warmupStepsFor never touches set identity or counts',
  !/set\.id/.test(wfSrc) && !/addSet/.test(wfSrc) && !/updateSet/.test(wfSrc)
  && !/completedCount/.test(wfSrc));

// --- C: warmup progress is session-only storage -----------------------
const progStart = clientSrc.indexOf('const WARMUP_STORAGE_PREFIX');
const progEnd = extractFunctionEnd(clientSrc, 'writeWarmupProgress');
const progChunk = clientSrc.slice(progStart, progEnd);
function makeStorage() {
  const map = new Map();
  return {
    map,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
  };
}
const fakeWindow = { sessionStorage: makeStorage() };
const { WARMUP_STORAGE_PREFIX, readWarmupProgress, writeWarmupProgress } =
  new Function('window',
    `${stripTypeScriptTypes(progChunk.replace(/^export /gm, ''))}\nreturn { WARMUP_STORAGE_PREFIX, readWarmupProgress, writeWarmupProgress };`,
  )(fakeWindow);
{
  writeWarmupProgress(11, { index: 2, statuses: ['done', 'skipped'], finished: false, selfDone: false });
  const back = readWarmupProgress(11);
  check('C1 warmup progress roundtrips per workout',
    back !== null && back.index === 2 && back.finished === false
    && back.statuses.length === 2 && back.statuses[0] === 'done');
  check('C2 keys are per-workout isolated',
    readWarmupProgress(12) === null
    && fakeWindow.sessionStorage.map.has(`${WARMUP_STORAGE_PREFIX}11`)
    && !fakeWindow.sessionStorage.map.has(`${WARMUP_STORAGE_PREFIX}12`));
  check('C3 unseen workout reads null (fresh warmup starts at step 0)',
    readWarmupProgress(99) === null);
  fakeWindow.sessionStorage.setItem(`${WARMUP_STORAGE_PREFIX}13`, '{"index":1,"statuses":["done","bogus",42],"finished":"yes"}');
  const dirty = readWarmupProgress(13);
  check('C4 hostile payload: invalid statuses filtered, non-boolean finished rejected',
    dirty !== null && dirty.index === 1 && dirty.statuses.length === 1
    && dirty.statuses[0] === 'done' && dirty.finished === false && dirty.selfDone === false);
  fakeWindow.sessionStorage.setItem(`${WARMUP_STORAGE_PREFIX}14`, 'not-json{{{');
  check('C5 malformed JSON reads null, never throws', readWarmupProgress(14) === null);
  const good = fakeWindow.sessionStorage;
  fakeWindow.sessionStorage = {
    getItem() { throw new Error('denied'); },
    setItem() { throw new Error('denied'); },
    removeItem() { throw new Error('denied'); },
  };
  let threw = false;
  try {
    writeWarmupProgress(15, { index: 0, statuses: [], finished: false, selfDone: false });
    readWarmupProgress(15);
  } catch { threw = true; }
  fakeWindow.sessionStorage = good;
  check('C6 denied storage never throws out of the helpers', !threw);
}
check('C7 progress chunk uses sessionStorage only, never localStorage or a server action',
  /window\.sessionStorage/.test(progChunk)
  && !/localStorage/.test(progChunk)
  && !/api\./.test(progChunk) && !/updateSet/.test(progChunk));

// --- D: no schema type column, no value-guessing consumers ------------
const tableStart = schemaSrc.indexOf('export const workoutSets');
const tableEnd = schemaSrc.indexOf('});', tableStart) + 3;
const tableChunk = schemaSrc.slice(tableStart, tableEnd);
check('D1 workout_sets has no set-type/warmup column (deliberate: no migration)',
  !/warmup/i.test(tableChunk) && !/set_?type/i.test(tableChunk));
check('D2 no server module guesses warmup from values (zero warmup refs server-side)',
  serverSrc.every((s) => !/warmup/i.test(s)));

// --- E: mutation sensitivity (real flips) -----------------------------
{
  const m1 = `${clientSrc}\nfunction handleAddWarmupSets() { return []; }\n`;
  check('M1 re-adding the write path flips A1',
    /function\s+handleAddWarmupSets\s*\(/.test(m1) === true);
}
{
  const m2 = progChunk.replace(/sessionStorage/g, 'localStorage');
  check('M2 persisting progress in localStorage flips C7',
    (/window\.sessionStorage/.test(m2) && !/localStorage/.test(m2)) === false);
}
{
  const fake = { sessionStorage: makeStorage() };
  const { readWarmupProgress: mRead, writeWarmupProgress: mWrite } =
    new Function('window',
      `${stripTypeScriptTypes(progChunk.replace(/^export /gm, '').replace('Math.max(0,', 'Math.max(5,'))}\nreturn { readWarmupProgress, writeWarmupProgress };`,
    )(fake);
  mWrite(21, { index: 0, statuses: [], finished: false, selfDone: false });
  const got = mRead(21);
  check('M3 corrupting the index clamp flips the roundtrip (0 -> 5)',
    !(got !== null && got.index === 0), `read back index ${got && got.index}`);
}

console.log(`\n${passed} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
