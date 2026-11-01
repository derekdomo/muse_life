// W2.2 validation — per-view scroll-position save/restore (client
// presentation only). Runs the REAL production storage functions
// extracted verbatim from client/src/App.tsx (SCROLL_KEY_PREFIX,
// START_VIEW_KEY, activeViewKey, scrollStorageKey, saveViewScroll,
// readViewScroll, clearViewScroll) against a fake sessionStorage,
// plus source wiring checks:
//  - save/read roundtrip per view key, keys fully isolated, so one
//    workout's position can never leak into another workout's view;
//  - a view key with no saved entry reads null -> the view starts
//    at the top (the new-workout case);
//  - clearViewScroll removes exactly one key (the finish/discard
//    path clears "start" + the finished workout's key, so returning
//    to the start screen after a workout starts at the top);
//  - malformed stored values read as null; negative saves clamp to
//    0; a throwing sessionStorage never throws out of the helpers;
//  - wiring: StartScreen restores under START_VIEW_KEY,
//    ActiveWorkout under activeViewKey(workout.id), runComplete and
//    the discard mutation clear both keys, and the guide dialog
//    captures window.scrollY on open and restores it on close.
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
function extractFunctionEnd(source, name) {
  const idx = source.search(new RegExp(`function ${name}\\(`));
  if (idx < 0) throw new Error(`function ${name} not found`);
  const openParen = source.indexOf('(', idx);
  const closeParen = matchDelim(source, openParen, '(', ')');
  const bodyStart = source.indexOf('{', closeParen);
  return matchDelim(source, bodyStart, '{', '}') + 1;
}
function sliceBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  if (start < 0 || end < 0) throw new Error(`markers not found: ${startMarker} .. ${endMarker}`);
  return source.slice(start, end);
}

// The scroll storage helpers are one contiguous chunk of App.tsx.
const chunkStart = clientSrc.indexOf('const SCROLL_KEY_PREFIX');
const chunkEnd = extractFunctionEnd(clientSrc, 'clearViewScroll');
if (chunkStart < 0) throw new Error('scroll chunk not found');
const code = clientSrc.slice(chunkStart, chunkEnd).replace(/^export /gm, '');

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
const {
  SCROLL_KEY_PREFIX, START_VIEW_KEY, activeViewKey,
  saveViewScroll, readViewScroll, clearViewScroll,
} = new Function('window',
  `${stripTypeScriptTypes(code)}\nreturn { SCROLL_KEY_PREFIX, START_VIEW_KEY, activeViewKey, saveViewScroll, readViewScroll, clearViewScroll };`,
)(fakeWindow);

// --- S1: per-key save/read roundtrip + isolation ------------------
{
  saveViewScroll(START_VIEW_KEY, 300);
  saveViewScroll(activeViewKey(1), 500);
  saveViewScroll(activeViewKey(2), 900);
  check('S1 roundtrip: start view reads back its own position', readViewScroll(START_VIEW_KEY) === 300);
  check('S1 isolation: workout 1 reads back its own position', readViewScroll(activeViewKey(1)) === 500);
  check('S1 isolation: workout 2 reads back its own position', readViewScroll(activeViewKey(2)) === 900);
  check('S1 storage keys carry the prefix and the view key',
    fakeWindow.sessionStorage.map.has(`${SCROLL_KEY_PREFIX}start`)
    && fakeWindow.sessionStorage.map.has(`${SCROLL_KEY_PREFIX}active-1`)
    && fakeWindow.sessionStorage.map.has(`${SCROLL_KEY_PREFIX}active-2`));
  saveViewScroll(START_VIEW_KEY, 120);
  check('S1 overwrite: re-saving a key replaces only that key',
    readViewScroll(START_VIEW_KEY) === 120 && readViewScroll(activeViewKey(1)) === 500);
}

// --- S2: no saved entry -> null -> view starts at the top ---------
{
  check('S2 new workout: an unseen workout id has no saved position (starts at top)',
    readViewScroll(activeViewKey(3)) === null);
  check('S2 fractional positions round to whole pixels',
    (saveViewScroll(activeViewKey(7), 432.6), readViewScroll(activeViewKey(7)) === 433));
}

// --- S3: finish/discard clearing ----------------------------------
{
  clearViewScroll(START_VIEW_KEY);
  clearViewScroll(activeViewKey(1));
  check('S3 clear: the cleared start key reads null (post-workout start screen begins at top)',
    readViewScroll(START_VIEW_KEY) === null);
  check('S3 clear: the cleared workout key reads null', readViewScroll(activeViewKey(1)) === null);
  check('S3 clear: clearing is per-key — workout 2 keeps its position',
    readViewScroll(activeViewKey(2)) === 900);
}

// --- S4: hostile storage contents / unavailable storage -----------
{
  fakeWindow.sessionStorage.setItem(`${SCROLL_KEY_PREFIX}active-9`, 'not-a-number');
  check('S4 malformed stored value reads as null, never NaN', readViewScroll(activeViewKey(9)) === null);
  fakeWindow.sessionStorage.setItem(`${SCROLL_KEY_PREFIX}active-9`, '-42');
  check('S4 negative stored value reads as null', readViewScroll(activeViewKey(9)) === null);
  saveViewScroll(activeViewKey(9), -5);
  check('S4 negative save clamps to 0', readViewScroll(activeViewKey(9)) === 0);

  const good = fakeWindow.sessionStorage;
  fakeWindow.sessionStorage = {
    getItem() { throw new Error('denied'); },
    setItem() { throw new Error('denied'); },
    removeItem() { throw new Error('denied'); },
  };
  let threw = false;
  try {
    saveViewScroll(START_VIEW_KEY, 10);
    clearViewScroll(START_VIEW_KEY);
  } catch { threw = true; }
  check('S4 throwing sessionStorage: save/clear never throw', !threw);
  check('S4 throwing sessionStorage: read of an unsaved key degrades to null', readViewScroll(START_VIEW_KEY) === null);
  fakeWindow.sessionStorage = good;
}

// --- S5: in-memory fallback (storage denied or lost) --------------
{
  // Swap in a FRESH, empty storage: every mirrored value is gone,
  // but positions saved this session must still restore from the
  // in-memory map — the in-session view-switch flows never depend
  // on storage being available.
  fakeWindow.sessionStorage = makeStorage();
  check('S5 memory fallback: a saved position survives losing sessionStorage',
    readViewScroll(activeViewKey(2)) === 900);
  clearViewScroll(activeViewKey(2));
  check('S5 memory fallback: clearing removes the in-memory copy too',
    readViewScroll(activeViewKey(2)) === null);
}

// --- W: source wiring ---------------------------------------------
{
  const startScreen = sliceBetween(clientSrc, 'function StartScreen(', 'export function App()');
  check('W wiring: StartScreen restores under the start view key',
    startScreen.includes('useViewScrollRestore(START_VIEW_KEY)'));
  const active = sliceBetween(clientSrc, 'function ActiveWorkout(', 'function StartScreen(');
  check('W wiring: ActiveWorkout restores under its per-workout view key',
    active.includes('useViewScrollRestore(activeViewKey(workout.id))'));

  const runComplete = sliceBetween(clientSrc, 'async function runComplete(', 'async function awaitFinalSetRegistration(');
  const clearStartAt = runComplete.indexOf('clearViewScroll(START_VIEW_KEY)');
  const clearActiveAt = runComplete.indexOf('clearViewScroll(activeViewKey(workout.id))');
  const completedAt = runComplete.indexOf('onCompleted(workout.id)');
  check('W wiring: a successful finish clears the start position', clearStartAt >= 0);
  check('W wiring: a successful finish clears the finished workout position', clearActiveAt >= 0);
  check('W wiring: both clears happen before the completion hand-off',
    clearStartAt >= 0 && clearActiveAt >= 0 && clearStartAt < completedAt && clearActiveAt < completedAt);

  const discard = sliceBetween(clientSrc, 'const discard = useMutation({', 'const previousByExercise');
  check('W wiring: discarding a workout clears both saved positions too',
    discard.includes('clearViewScroll(START_VIEW_KEY)') && discard.includes('clearViewScroll(activeViewKey(workout.id))'));

  const dialog = sliceBetween(clientSrc, 'function ExerciseGuideDialog(', 'export function setDraftFromSet(');
  check('W wiring: the guide dialog captures the scroll position when it opens',
    dialog.includes('const scrollYAtOpen = window.scrollY'));
  check('W wiring: the guide dialog restores that position when it closes',
    dialog.includes('window.scrollTo(0, scrollYAtOpen)'));

  const hookBody = sliceBetween(clientSrc, 'export function useViewScrollRestore(', '\n}\n');
  check('W wiring: the hook saves on scroll and on pagehide and restores the saved value',
    hookBody.includes('saveViewScroll(viewKey, window.scrollY)')
    && hookBody.includes('readViewScroll(viewKey)')
    && hookBody.includes('"pagehide"'));
}

console.log(`\n${passed} passed, ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
