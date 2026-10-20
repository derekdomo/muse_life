// W-TIMER-001 / W2.1 validation — optional rest timer after a set is
// completed. Runs the REAL production functions extracted verbatim from
// client/src/App.tsx over synthetic timestamps only. Pure Node, no deps.
// Contract under test:
//  - Remaining time is always derived from a deadline (endsAt) and the
//    current instant — never decremented — so returning from the
//    background shows the correct value.
//  - Default 90s; the per-workout choice is limited to 60/90/120s and
//    applies to the NEXT start, never moving a running deadline.
//  - +30s extends a running timer, re-anchors an already-finished one
//    from now, and is a no-op when no timer is running.
//  - Skip clears the deadline; muting only gates the beep; the timer
//    never calls a write action and never touches set completion.
//  - Refresh policy is explicit in the UI copy: the timer lives in
//    component state only, so a page refresh resets it.
// Mutations are executed (ceil removed, re-anchor removed, done label
// removed) and must flip outcomes.
// Owner three-viewport page evidence stays 运行待验 (PM acceptance).
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';

const clientSrc = readFileSync(new URL('./client/src/App.tsx', import.meta.url), 'utf8');
const themeCss = readFileSync(new URL('./client/src/theme.css', import.meta.url), 'utf8');

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

const FN = [
  'initRestTimer', 'startRestTimer', 'restRemainingSec', 'restTimerDone',
  'addRestTime', 'skipRestTimer', 'setRestDuration', 'toggleRestMuted', 'restTimerLabel',
  'toggleRestAuto', 'shouldAutoStartRest',
];
const CONSTS = [
  'export const REST_DURATIONS = [60, 90, 120];',
  'export const DEFAULT_REST_SEC = 90;',
];
function buildTimer(src) {
  for (const c of CONSTS) {
    if (!src.includes(c)) throw new Error(`constant not found: ${c}`);
  }
  const code = [...CONSTS.map((c) => c.replace(/^export /, '')), ...FN.map((n) => extractFunction(src, n))].join('\n');
  return new Function(`${stripTypeScriptTypes(code)}\nreturn { ${FN.join(', ')}, REST_DURATIONS, DEFAULT_REST_SEC };`)();
}
const T = buildTimer(clientSrc);

// --- source wiring ---
check('source: durations are exactly 60/90/120 with default 90',
  JSON.stringify(T.REST_DURATIONS) === '[60,90,120]' && T.DEFAULT_REST_SEC === 90);
check('source: completion toggle starts the timer only when fresh and unblocked',
  clientSrc.includes('if (next.completed && !setSaveBlocked(') && clientSrc.includes('onCompleted?.()'));
check('source: panel renders only while a deadline exists',
  clientSrc.includes('restTimer.endsAt != null ? (') && clientSrc.includes('<RestTimerPanel timer={restTimer}'));
check('source: panel lives in the current exercise block via timerSlot, with a below-stack fallback',
  clientSrc.includes('const currentKey = resolveCurrentExerciseKey(')
  && clientSrc.includes('timerSlot={currentKey != null && exercise.key === currentKey ? restTimerUi : undefined}')
  && clientSrc.includes('{timerSlot}')
  && clientSrc.includes('currentKey == null ? <div className="rest-timer-fallback">{restTimerUi}</div>'));
check('source: completing a set auto-starts only when autoEnabled',
  clientSrc.includes('shouldAutoStartRest(state) ? startRestTimer(state, Date.now()) : state'));
check('source: auto toggle is a 44px aria-pressed button that never calls a data action',
  clientSrc.includes('className="rest-auto-toggle"') && clientSrc.includes('aria-pressed={timer.autoEnabled}')
  && clientSrc.includes('本次自动休息计时') && themeCss.includes('.rest-auto-toggle {')
  && themeCss.includes('min-height: 44px')
  && !extractFunction(clientSrc, 'RestAutoToggle').includes('api.'));
check('source: tick only re-renders (300ms), remaining comes from the deadline',
  clientSrc.includes('window.setInterval(() => setRestNow(Date.now()), 300)'));
check('source: beep is gated by the mute flag', clientSrc.includes('if (!restTimer.muted) playRestBeep();'));
check('source: refresh policy is stated in the UI copy', clientSrc.includes('刷新页面后计时器会重置'));
check('source: duration choices expose aria-pressed', clientSrc.includes('aria-pressed={timer.durationSec === seconds}'));
check('source: mute toggle exposes aria-pressed', clientSrc.includes('aria-pressed={timer.muted}'));
const panelSrc = extractFunction(clientSrc, 'RestTimerPanel');
check('source: timer panel never calls a data action', !panelSrc.includes('api.'));
check('source: timer controls meet the 44px touch minimum',
  themeCss.includes('.rest-timer-controls button { min-height: 44px;'));

// --- behaviour over synthetic timestamps ---
const T0 = 1_700_000_000_000;
let s = T.initRestTimer();
check('init: defaults to 90s, idle, unmuted, not done, auto-start on',
  s.endsAt === null && s.durationSec === 90 && s.muted === false && s.done === false && s.autoEnabled === true);
check('init: a listed duration is accepted', T.initRestTimer(60).durationSec === 60 && T.initRestTimer(120).durationSec === 120);
check('init: an unlisted duration falls back to 90', T.initRestTimer(45).durationSec === 90);

check('remaining: null while idle', T.restRemainingSec(s, T0) === null);
check('done: false while idle', T.restTimerDone(s, T0) === false);
check('label: empty while idle', T.restTimerLabel(s, T0) === '');

s = T.startRestTimer(s, T0);
check('start: deadline is now + duration, done cleared',
  s.endsAt === T0 + 90_000 && s.done === false);
check('remaining: full 90 at the start instant', T.restRemainingSec(s, T0) === 90);
check('remaining: derived from the deadline (30.2s elapsed -> 60)',
  T.restRemainingSec(s, T0 + 30_200) === 60);
check('remaining: background jump stays accurate (89.5s elapsed -> 1, not done)',
  T.restRemainingSec(s, T0 + 89_500) === 1 && T.restTimerDone(s, T0 + 89_500) === false);
check('remaining: clamps to 0 at and after the deadline',
  T.restRemainingSec(s, T0 + 90_000) === 0 && T.restRemainingSec(s, T0 + 999_000) === 0);
check('done: true exactly at the deadline', T.restTimerDone(s, T0 + 90_000) === true);
check('label: mm:ss while running', T.restTimerLabel(s, T0) === '1:30' && T.restTimerLabel(s, T0 + 25_000) === '1:05' && T.restTimerLabel(s, T0 + 85_000) === '0:05');
check('label: 休息结束 once done', T.restTimerLabel(s, T0 + 90_000) === '休息结束');

// Quick consecutive completions restart a fresh full duration.
const restarted = T.startRestTimer(s, T0 + 10_000);
check('restart: completing another set re-arms the full duration from now',
  restarted.endsAt === T0 + 10_000 + 90_000 && restarted.done === false);

// +30s semantics.
check('add: no-op while idle', T.addRestTime(T.initRestTimer(), 30, T0).endsAt === null);
check('add: extends a running deadline by 30s', T.addRestTime(s, 30, T0 + 10_000).endsAt === T0 + 120_000);
const reanchored = T.addRestTime(s, 30, T0 + 200_000);
check('add: after finishing, re-anchors from now and clears done',
  reanchored.endsAt === T0 + 200_000 + 30_000 && reanchored.done === false);

// Skip / duration choice / mute.
const skipped = T.skipRestTimer(s);
check('skip: clears the deadline and done flag, keeps settings',
  skipped.endsAt === null && skipped.done === false && skipped.durationSec === 90);
check('duration: listed value applies to the next start only',
  T.setRestDuration(s, 60).durationSec === 60 && T.setRestDuration(s, 60).endsAt === s.endsAt);
check('duration: unlisted value is rejected unchanged', T.setRestDuration(s, 45) === s);
check('duration: next start uses the new duration',
  T.startRestTimer(T.setRestDuration(T.initRestTimer(), 120), T0).endsAt === T0 + 120_000);
check('mute: toggles both ways without touching the deadline',
  T.toggleRestMuted(s).muted === true && T.toggleRestMuted(T.toggleRestMuted(s)).muted === false
  && T.toggleRestMuted(s).endsAt === s.endsAt);

// Auto-start toggle (W-TIMER-001 gap closure): session-local only.
check('auto: shouldAutoStartRest mirrors autoEnabled',
  T.shouldAutoStartRest(T.initRestTimer()) === true
  && T.shouldAutoStartRest(T.toggleRestAuto(T.initRestTimer())) === false);
const runningToggled = T.toggleRestAuto(s);
check('auto: toggling mid-run flips only the flag, never the running deadline or settings',
  runningToggled.autoEnabled === false && runningToggled.endsAt === s.endsAt
  && runningToggled.durationSec === s.durationSec && runningToggled.muted === s.muted
  && runningToggled.done === s.done);
check('auto: toggling back on does not start a timer by itself',
  T.toggleRestAuto(T.toggleRestAuto(T.initRestTimer())).endsAt === null);
check('auto: start/skip/duration/mute all preserve the flag',
  T.startRestTimer(T.toggleRestAuto(T.initRestTimer()), T0).autoEnabled === false
  && T.skipRestTimer(T.toggleRestAuto(s)).autoEnabled === false
  && T.setRestDuration(T.toggleRestAuto(s), 60).autoEnabled === false);

// --- mutation sensitivity (executed) ---
const noCeilSrc = clientSrc.replace(
  'return Math.max(0, Math.ceil((state.endsAt - nowMs) / 1000));',
  'return Math.max(0, Math.floor((state.endsAt - nowMs) / 1000));',
);
check('mutation setup: floor variant differs', noCeilSrc !== clientSrc);
const floorTimer = buildTimer(noCeilSrc);
const floorState = floorTimer.startRestTimer(floorTimer.initRestTimer(), T0);
check('mutation: dropping ceil under-reports the remaining seconds',
  floorTimer.restRemainingSec(floorState, T0 + 30_200) === 59);

const noReanchorSrc = clientSrc.replace(
  'if (nowMs >= state.endsAt) return { ...state, endsAt: nowMs + seconds * 1000, done: false };',
  '',
);
check('mutation setup: re-anchor variant differs', noReanchorSrc !== clientSrc);
const noReanchorTimer = buildTimer(noReanchorSrc);
const nrState = noReanchorTimer.startRestTimer(noReanchorTimer.initRestTimer(), T0);
check('mutation: without re-anchoring, +30s after finishing lands in the past',
  noReanchorTimer.addRestTime(nrState, 30, T0 + 200_000).endsAt === T0 + 120_000);

const noDoneLabelSrc = clientSrc.replace('if (restTimerDone(state, nowMs)) return "休息结束";', '');
check('mutation setup: done-label variant differs', noDoneLabelSrc !== clientSrc);
const noDoneTimer = buildTimer(noDoneLabelSrc);
const ndState = noDoneTimer.startRestTimer(noDoneTimer.initRestTimer(), T0);
check('mutation: without the done branch the finished label collapses to 0:00',
  noDoneTimer.restTimerLabel(ndState, T0 + 90_000) === '0:00');

const toggleCancelsSrc = clientSrc.replace(
  'return { ...state, autoEnabled: !state.autoEnabled };',
  'return { ...state, autoEnabled: !state.autoEnabled, endsAt: null };',
);
check('mutation setup: toggle-cancels variant differs', toggleCancelsSrc !== clientSrc);
const toggleCancelsTimer = buildTimer(toggleCancelsSrc);
const tcState = toggleCancelsTimer.startRestTimer(toggleCancelsTimer.initRestTimer(), T0);
check('mutation: a toggle that clears the deadline kills the running countdown',
  toggleCancelsTimer.toggleRestAuto(tcState).endsAt === null && tcState.endsAt === T0 + 90_000);

console.log(`\n${passed} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
