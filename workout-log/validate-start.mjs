// W-START-001 validation — startWorkout single-active arbitration.
// Covers the two PM reproductions that the previous yield loop still
// lost:
//  1. Takeover loses the delete race: request A has written its sets
//     and is stalled just before its ready flip, with started_at
//     already >30s old. Request B's bounded poll exhausts, decides
//     takeover, but A recovers and flips ready BEFORE B's conditional
//     DELETE runs — the DELETE matches 0 rows. The old code broke out
//     of the poll unconditionally and flipped B ready too: A and B
//     both succeeded, two ready actives.
//  2. Several waiters on the same stale leftover: B and C both read
//     the same expired initializing parent row; one deletes it, the
//     other polls, sees it vanish, and both walk away with a
//     different usable active.
// The fix under test (server/src/actions.ts): after a takeover
// attempt (0 rows or not) and after any mid-poll state change, a
// start NEVER flips itself ready directly — it re-enters full
// arbitration over ALL other actives (ready other -> yield to it;
// initializing others -> deterministic earliest-inserted candidate;
// non-candidates keep bounded waiting / stale takeover, looping
// until they are the unique candidate). The ready flip itself is a
// single conditional UPDATE whose WHERE atomically proves no other
// ready active and no earlier initializing active exists, and a
// post-flip re-check keeps the earliest ready workout on conflict.
// Visible / edited / completed records are never deleted by any of
// this; only a still-initializing own row may be reclaimed.
// Runs the REAL production pure decisions extracted verbatim from
// server/src/actions.ts (resolveStartConflict, resolveYieldDecision,
// canReclaimInitializingWorkout, mutationTargetDecision) driving an
// in-memory mirror of the handler's arbitration loop whose primitive
// operations reproduce the SQL statements' exact conditional
// semantics (conditional DELETE, guarded UPDATE). Interleavings are
// scripted through hooks at the same statement boundaries the PM
// reproductions use. Synthetic data only. Pure Node, no deps.
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';

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
const SERVER_FN = ['mutationTargetDecision', 'resolveStartConflict', 'canReclaimInitializingWorkout', 'resolveYieldDecision'];
function buildServer(src) {
  const code = SERVER_FN.map((n) => extractFunction(src, n)).join('\n');
  return new Function(`${stripTypeScriptTypes(code)}\nreturn { ${SERVER_FN.join(', ')} };`)();
}
const S = buildServer(serverSrc);

const ATTEMPTS = Number(/YIELD_WAIT_ATTEMPTS = (\d+)/.exec(serverSrc)?.[1] ?? NaN);
const INTERVAL = Number(/YIELD_WAIT_INTERVAL_MS = (\d+)/.exec(serverSrc)?.[1] ?? NaN);
check('source: bounded poll budget is 10 x 200ms', ATTEMPTS === 10 && INTERVAL === 200, `${ATTEMPTS}x${INTERVAL}`);

// --- source wiring for the reworked arbitration ---
const startBegin = serverSrc.indexOf('startWorkout: defineAction');
const startEnd = serverSrc.indexOf('updateSet: defineAction');
const startSlice = serverSrc.slice(startBegin, startEnd);
check('server: arbitration loop re-reads ALL other actives every iteration',
  startSlice.includes('let attemptsLeft = YIELD_WAIT_ATTEMPTS;')
  && startSlice.indexOf('const otherActiveRows = await db', startSlice.indexOf('let attemptsLeft')) > -1);
check('server: a ready other is yielded to before any wait/flip decision in the loop',
  startSlice.indexOf('const readyOther = otherActiveRows.find') > -1
  && startSlice.indexOf('const readyOther = otherActiveRows.find') < startSlice.indexOf('resolveYieldDecision('));
{
  const tIdx = startSlice.indexOf('decision === "takeover"');
  const seg = startSlice.slice(tIdx, tIdx + 2400);
  check('server: takeover NEVER falls through to the ready flip — it re-arbitrates (continue, fresh budget)',
    tIdx > -1 && seg.includes('attemptsLeft = YIELD_WAIT_ATTEMPTS;') && seg.includes('continue;')
    && seg.indexOf('continue;') < seg.indexOf('.set({ initializing: 0 })'));
  check('server: the arbitration loop has no unconditional break left (old repro-1 shape)',
    !startSlice.slice(startSlice.indexOf('let attemptsLeft')).includes('break;'));
}
check('server: the ready flip is atomic — its WHERE also proves no other ready active exists',
  startSlice.includes('NOT EXISTS (SELECT 1 FROM workouts WHERE workouts.completed_at IS NULL AND workouts.initializing = 0 AND workouts.id <>'));
check('server: the ready flip is atomic — its WHERE also proves no earlier initializing active exists',
  startSlice.includes('AND workouts.initializing = 1 AND workouts.id <'));
{
  const flipIdx = startSlice.indexOf('.set({ initializing: 0 })');
  const recheckIdx = startSlice.indexOf('const readyConflicts = await db');
  check('server: post-flip re-check re-reads other ready actives and keeps the earliest',
    flipIdx > -1 && recheckIdx > flipIdx && startSlice.includes('conflictRow.id < workoutId'));
  check('server: post-flip conflict path deletes nothing (response-level yield only)',
    !/readyConflicts[\s\S]*?db\.delete/.test(startSlice.slice(recheckIdx, recheckIdx + 1600)));
}
check('server: a 0-row guarded flip re-arbitrates or fails retryably, never returns unusable success',
  startSlice.indexOf('if (flipped.length === 0)') > -1
  && startSlice.indexOf('if (flipped.length === 0)') < startSlice.indexOf('const readyConflicts'));

// --- in-memory world: statement-level mirror of the handler ---
// Rows mirror workouts (initializing flag, completed_at, started_at);
// sets are tracked as a count per workout id. The primitives copy the
// SQL conditions exactly:
//  - condDeleteInitializing: DELETE ... WHERE id=? AND initializing=1
//    AND completed_at IS NULL (takeover / reclaim / failure cleanup).
//  - guardedFlip: UPDATE ... SET initializing=0 WHERE id=? AND
//    initializing=1 AND NOT EXISTS(other ready active) AND NOT
//    EXISTS(earlier initializing active).
function makeWorld(Smod) {
  const rows = new Map();
  const sets = new Map();
  const deleteLog = [];
  let nextId = 1;
  const world = {
    now: 1_000_000,
    rows, sets, deleteLog,
    insertInitializing(startedAtMs, setCount = 17) {
      const id = nextId++;
      rows.set(id, { id, initializing: true, completed_at: null, startedAtMs });
      sets.set(id, setCount);
      return id;
    },
    insertReady(startedAtMs, setCount = 17) {
      const id = world.insertInitializing(startedAtMs, setCount);
      rows.get(id).initializing = false;
      return id;
    },
    condDeleteInitializing(id, by) {
      const row = rows.get(id);
      const removed = !!row && row.initializing && row.completed_at == null
        && Smod.canReclaimInitializingWorkout({ initializing: row.initializing, completedAt: row.completed_at });
      deleteLog.push({ id, removed, by });
      if (removed) rows.delete(id);
      return removed;
    },
    guardedFlip(id) {
      const row = rows.get(id);
      if (!row || !row.initializing || row.completed_at != null) return false;
      for (const other of rows.values()) {
        if (other.id === id || other.completed_at != null) continue;
        if (!other.initializing) return false; // another ready active exists
        if (other.id < id) return false; // an earlier initializing active exists
      }
      row.initializing = false;
      return true;
    },
    readOthers(selfId) {
      return [...rows.values()]
        .filter((r) => r.id !== selfId && r.completed_at == null)
        .sort((a, b) => a.id - b.id);
    },
    usableActiveIds() {
      return [...rows.values()].filter((r) => r.completed_at == null && !r.initializing).map((r) => r.id);
    },
    targetOf(id) {
      const r = rows.get(id);
      return Smod.mutationTargetDecision(r ? { completed_at: r.completed_at, initializing: r.initializing } : null);
    },
    // The handler's arbitration loop, statement for statement.
    // hooks: { onWait(selfId), beforeTakeoverDelete(targetId, selfId),
    //          beforeFlip(selfId) } — fired at the exact boundaries
    // where a concurrent request can interleave.
    runStart(selfId, hooks = {}) {
      let attemptsLeft = ATTEMPTS;
      const failRetry = () => {
        // handler catch: unified cleanup of own initializing row.
        if (world.condDeleteInitializing(selfId, 'cleanup')) sets.delete(selfId);
        return { error: 'retry' };
      };
      for (;;) {
        const others = world.readOthers(selfId);
        const readyOther = others.find((r) => !r.initializing) ?? null;
        if (readyOther) {
          const reclaimed = world.condDeleteInitializing(selfId, selfId);
          if (reclaimed) {
            sets.delete(selfId);
            return { returned: readyOther.id, via: 'yield-ready' };
          }
          return { returned: selfId, via: 'yield-defensive' };
        }
        const earliestOther = others[0] ?? null;
        const conflict = Smod.resolveStartConflict(earliestOther?.id ?? null, selfId);
        if (conflict.action === 'yield') {
          const keepId = conflict.keepId;
          const keeper = others.find((r) => r.id === keepId) ?? null;
          const decision = Smod.resolveYieldDecision(
            {
              present: keeper != null,
              initializing: keeper != null && keeper.initializing,
              startedAtMs: keeper ? keeper.startedAtMs : null,
            },
            attemptsLeft,
            world.now,
          );
          if (decision === 'wait') {
            attemptsLeft -= 1;
            world.now += INTERVAL;
            hooks.onWait?.(selfId);
            continue;
          }
          if (decision === 'takeover') {
            hooks.beforeTakeoverDelete?.(keepId, selfId);
            const removed = world.condDeleteInitializing(keepId, selfId);
            if (removed) sets.delete(keepId);
            attemptsLeft = ATTEMPTS; // re-arbitrate with a fresh budget
            continue;
          }
          if (decision === 'retry') return failRetry();
          continue; // stale snapshot: re-arbitrate on a fresh read
        }
        hooks.beforeFlip?.(selfId);
        const flipped = world.guardedFlip(selfId);
        if (!flipped) {
          if (attemptsLeft > 0) { attemptsLeft -= 1; world.now += INTERVAL; continue; }
          return failRetry();
        }
        const readyConflicts = world.readOthers(selfId).filter((r) => !r.initializing);
        if (readyConflicts.length > 0 && readyConflicts[0].id < selfId) {
          return { returned: readyConflicts[0].id, via: 'post-flip-yield' };
        }
        return { returned: selfId, via: 'created' };
      }
    },
  };
  return world;
}
function assertUsable(world, returned, label) {
  check(`${label}: the returned workout is readable/writable (ready, sets complete)`,
    world.targetOf(returned) === 'ok' && (world.sets.get(returned) ?? 0) === 17,
    `target=${world.targetOf(returned)} sets=${world.sets.get(returned)}`);
}

// Baseline: a lone start flips ready and returns itself with its sets.
{
  const world = makeWorld(S);
  const a = world.insertInitializing(world.now);
  const res = world.runStart(a);
  check('baseline: a lone start creates its own workout', res.returned === a && res.via === 'created');
  check('baseline: exactly one usable active', JSON.stringify(world.usableActiveIds()) === JSON.stringify([a]));
  assertUsable(world, res.returned, 'baseline');
}

// PM repro 1: takeover loses the delete race — A recovers and flips
// ready in the gap between B's takeover decision and B's DELETE.
// B must yield to the now-ready A, never flip itself ready too.
{
  const world = makeWorld(S);
  const a = world.insertInitializing(world.now - 35_000); // stalled pre-flip, >30s old
  const b = world.insertInitializing(world.now);
  let aFlipResult = null;
  const res = world.runStart(b, {
    beforeTakeoverDelete: (targetId) => {
      if (targetId === a) aFlipResult = world.guardedFlip(a); // A recovers first
    },
  });
  check('repro1: A really did flip ready in the takeover gap', aFlipResult === true);
  check('repro1: B\'s takeover DELETE matched 0 rows (A no longer initializing)',
    world.deleteLog.some((e) => e.id === a && e.by === b && e.removed === false));
  check('repro1: B yields to the recovered A instead of flipping itself ready', res.returned === a && res.via === 'yield-ready');
  check('repro1: B\'s own initializing row and sets were reclaimed', !world.rows.has(b) && !world.sets.has(b));
  check('repro1: exactly one usable active remains (A)', JSON.stringify(world.usableActiveIds()) === JSON.stringify([a]));
  assertUsable(world, res.returned, 'repro1');
}

// PM repro 2: B and C both wait on the same stale leftover L. One
// deletes it; the other must re-arbitrate — both converge on ONE
// usable active, and both successful returns name the same workout.
{
  const world = makeWorld(S);
  const stale = world.insertInitializing(world.now - 60_000);
  const b = world.insertInitializing(world.now);
  const c = world.insertInitializing(world.now);
  let resB = null;
  const resC = world.runStart(c, {
    onWait: () => { if (!resB) resB = world.runStart(b); }, // B runs while C waits on L
  });
  check('repro2: the stale leftover was taken over exactly once',
    world.deleteLog.filter((e) => e.id === stale && e.removed).length === 1 && !world.rows.has(stale));
  check('repro2: B created its own workout', resB !== null && resB.returned === b && resB.via === 'created');
  check('repro2: C converged on B\'s workout after the leftover vanished', resC.returned === b && resC.via === 'yield-ready');
  check('repro2: exactly one usable active remains', JSON.stringify(world.usableActiveIds()) === JSON.stringify([b]));
  assertUsable(world, resC.returned, 'repro2');
}
// Repro 2, reverse completion order: C reaches the takeover first,
// then finds B (earlier insert, still initializing and fresh) ahead
// of it — C fails retryably and cleans up; B then proceeds alone.
// No interleaving of this shape may produce two usable actives.
{
  const world = makeWorld(S);
  const stale = world.insertInitializing(world.now - 60_000);
  const b = world.insertInitializing(world.now);
  const c = world.insertInitializing(world.now);
  let resC = null;
  const resB = world.runStart(b, {
    onWait: () => { if (!resC) resC = world.runStart(c); }, // C runs while B waits on L
  });
  check('repro2-rev: C took over the leftover but then yielded the race with a retryable failure',
    resC !== null && resC.error === 'retry' && !world.rows.has(c));
  check('repro2-rev: B proceeded alone once the field cleared', resB.returned === b && resB.via === 'created');
  check('repro2-rev: exactly one usable active remains', JSON.stringify(world.usableActiveIds()) === JSON.stringify([b]));
  assertUsable(world, resB.returned, 'repro2-rev');
  // C's retry now meets the ready B and returns it — failure was retryable.
  const c2 = world.insertInitializing(world.now);
  const resC2 = world.runStart(c2);
  check('repro2-rev: the failed start retries cleanly onto the surviving workout',
    resC2.returned === b && JSON.stringify(world.usableActiveIds()) === JSON.stringify([b]));
}

// Control — original request recovers: A flips ready during B's
// bounded wait; B yields and returns A.
{
  const world = makeWorld(S);
  const a = world.insertInitializing(world.now);
  const b = world.insertInitializing(world.now);
  let flipped = false;
  const res = world.runStart(b, {
    onWait: () => { if (!flipped) { flipped = world.guardedFlip(a); } },
  });
  check('control(recover): A flipped ready during B\'s wait', flipped === true);
  check('control(recover): B yields to A', res.returned === a && res.via === 'yield-ready');
  check('control(recover): exactly one usable active', JSON.stringify(world.usableActiveIds()) === JSON.stringify([a]));
  assertUsable(world, res.returned, 'control(recover)');
}

// Control — original request completes first: a ready A already
// exists when B arbitrates; B yields immediately, A untouched.
{
  const world = makeWorld(S);
  const a = world.insertReady(world.now - 5_000);
  const b = world.insertInitializing(world.now);
  const res = world.runStart(b);
  check('control(ready-first): B returns the already-ready A', res.returned === a && res.via === 'yield-ready');
  check('control(ready-first): A was never deleted or disturbed',
    world.rows.has(a) && world.sets.get(a) === 17 && !world.deleteLog.some((e) => e.id === a && e.removed));
  check('control(ready-first): exactly one usable active', JSON.stringify(world.usableActiveIds()) === JSON.stringify([a]));
}

// Control — original request abandons: A fails mid-initialization
// and its own cleanup removes it while B waits; B re-arbitrates over
// the now-empty field (plus a later insert D) and flips ready as the
// earliest candidate; D then yields to B.
{
  const world = makeWorld(S);
  const a = world.insertInitializing(world.now);
  const b = world.insertInitializing(world.now);
  let d = null;
  const res = world.runStart(b, {
    onWait: () => {
      if (world.rows.has(a)) { world.condDeleteInitializing(a, 'cleanup'); world.sets.delete(a); }
      if (d == null) d = world.insertInitializing(world.now);
    },
  });
  check('control(abandon): B proceeded after A vanished (re-arbitration, not blind proceed)',
    res.returned === b && res.via === 'created');
  check('control(abandon): A left nothing behind', !world.rows.has(a) && !world.sets.has(a));
  const resD = world.runStart(d);
  check('control(abandon): the later insert D yields to B', resD.returned === b);
  check('control(abandon): exactly one usable active', JSON.stringify(world.usableActiveIds()) === JSON.stringify([b]));
  assertUsable(world, res.returned, 'control(abandon)');
}

// DELETE matching 0 rows because the target vanished (a third party
// took it over first): B re-arbitrates and ends up yielding to that
// party once it flips ready — still one usable active.
{
  const world = makeWorld(S);
  const stale = world.insertInitializing(world.now - 60_000);
  const w = world.insertInitializing(world.now);
  const b = world.insertInitializing(world.now);
  let wFlipped = false;
  const res = world.runStart(b, {
    beforeTakeoverDelete: (targetId) => {
      // W's own takeover lands first; B's DELETE then matches 0 rows.
      if (targetId === stale && world.rows.has(stale)) { world.condDeleteInitializing(stale, w); world.sets.delete(stale); }
    },
    onWait: () => { if (!wFlipped) wFlipped = world.guardedFlip(w); },
  });
  check('delete-0-rows: B\'s takeover DELETE on the vanished leftover matched 0 rows',
    world.deleteLog.some((e) => e.id === stale && e.by === b && e.removed === false));
  check('delete-0-rows: B re-arbitrated and yielded to W once W was ready', res.returned === w && res.via === 'yield-ready');
  check('delete-0-rows: exactly one usable active', JSON.stringify(world.usableActiveIds()) === JSON.stringify([w]));
  assertUsable(world, res.returned, 'delete-0-rows');
}

// Expired takeover succeeds: a lone stale leftover is removed with
// its sets and the new start becomes the single usable active.
{
  const world = makeWorld(S);
  const stale = world.insertInitializing(world.now - 45_000);
  const b = world.insertInitializing(world.now);
  const res = world.runStart(b);
  check('takeover: the stale leftover and its sets were removed',
    !world.rows.has(stale) && !world.sets.has(stale));
  check('takeover: B became the single usable active', res.returned === b && JSON.stringify(world.usableActiveIds()) === JSON.stringify([b]));
  assertUsable(world, res.returned, 'takeover');
}

// Fresh initializing other: B waits the full budget, A is still
// fresh, so B fails retryably and cleans up its own row; A flips
// ready afterwards and B's retry returns A. At no point are there
// two usable actives, and B never returns an unusable workout.
{
  const world = makeWorld(S);
  const a = world.insertInitializing(world.now);
  const b = world.insertInitializing(world.now);
  const res = world.runStart(b);
  check('fresh-wait: B fails with a retryable error rather than an unusable success', res.error === 'retry');
  check('fresh-wait: B\'s failed start cleaned up its own initializing row', !world.rows.has(b) && !world.sets.has(b));
  check('fresh-wait: A is untouched and still the sole (initializing) row',
    world.rows.has(a) && world.usableActiveIds().length === 0);
  check('fresh-wait: A can still flip ready afterwards', world.guardedFlip(a) === true);
  const b2 = world.insertInitializing(world.now);
  const res2 = world.runStart(b2);
  check('fresh-wait: B\'s retry returns the now-ready A', res2.returned === a && JSON.stringify(world.usableActiveIds()) === JSON.stringify([a]));
  assertUsable(world, res2.returned, 'fresh-wait');
}

// Atomic flip guard, exercised directly: a later insert cannot flip
// while an earlier initializing active exists, and nobody can flip
// while a ready active exists.
{
  const world = makeWorld(S);
  const b = world.insertInitializing(world.now);
  const c = world.insertInitializing(world.now);
  check('guard: the later insert\'s flip is refused while an earlier initializing active exists',
    world.guardedFlip(c) === false && world.rows.get(c).initializing === true);
  check('guard: the earliest candidate flips', world.guardedFlip(b) === true);
  check('guard: no second flip while a ready active exists', world.guardedFlip(c) === false);
  const res = world.runStart(c);
  check('guard: the refused start then yields to the ready workout', res.returned === b && JSON.stringify(world.usableActiveIds()) === JSON.stringify([b]));
}

// Post-flip / defensive state: two ready rows somehow already exist
// (unreachable under the guarded flip). A new start yields to the
// earliest ready one and NOTHING visible is deleted to "fix" it.
{
  const world = makeWorld(S);
  const a = world.insertReady(world.now - 9_000);
  const b = world.insertReady(world.now - 4_000);
  const c = world.insertInitializing(world.now);
  const res = world.runStart(c);
  check('defensive: the new start returns the earliest ready workout', res.returned === a);
  check('defensive: no visible record was deleted by arbitration',
    world.rows.has(a) && world.rows.has(b) && !world.deleteLog.some((e) => e.removed && (e.id === a || e.id === b)));
  check('defensive: the new start added no third usable active', world.usableActiveIds().length === 2 && !world.rows.has(c));
}

// Completed-record protection: a completed earlier workout is not
// an arbitration target at all — a new start creates its own and the
// history row (and its sets) survive untouched.
{
  const world = makeWorld(S);
  const done = world.insertReady(world.now - 90_000);
  world.rows.get(done).completed_at = '2026-10-17T00:00:00.000Z';
  const b = world.insertInitializing(world.now);
  const res = world.runStart(b);
  check('history: a completed workout does not block or get deleted by a new start',
    res.returned === b && world.rows.has(done) && world.sets.get(done) === 17);
  check('history: the completed row stays a non-target', world.targetOf(done) === 'not-active');
  check('history: exactly one usable active (the new one)', JSON.stringify(world.usableActiveIds()) === JSON.stringify([b]));
}

// --- mutations must flip outcomes ---
{
  const mutated = serverSrc.replace('existingActiveId < insertedId', 'existingActiveId > insertedId');
  const SM = buildServer(mutated);
  const world = makeWorld(SM);
  const stale = world.insertInitializing(world.now - 60_000);
  const b = world.insertInitializing(world.now);
  const c = world.insertInitializing(world.now);
  let resB = null;
  const resC = world.runStart(c, { onWait: () => { if (!resB) resB = world.runStart(b); } });
  check('mutation: inverting the earliest-wins rule breaks repro-2 convergence (detected)',
    !(resB && resC.returned === resB.returned && world.usableActiveIds().length === 1),
    `B->${resB?.returned} C->${resC.returned} usable=${world.usableActiveIds().join(',')}`);
}
{
  const mutated = serverSrc.replace('if (attemptsLeft > 0) return "wait";', 'if (attemptsLeft < 0) return "wait";');
  const SM = buildServer(mutated);
  const world = makeWorld(SM);
  const a = world.insertInitializing(world.now);
  const b = world.insertInitializing(world.now);
  // Same schedule as control(recover): A flips ready during what
  // should be B's bounded wait. Without the wait, B never observes
  // the flip — it fails immediately while A is still initializing.
  let flipped = false;
  const res = world.runStart(b, {
    onWait: () => { if (!flipped) flipped = world.guardedFlip(a); },
  });
  check('mutation: dropping the bounded yield wait loses the recovery window (detected)',
    res.returned !== a && flipped === false,
    `res=${JSON.stringify(res)} flipped=${flipped}`);
}

console.log(`\n${passed} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
