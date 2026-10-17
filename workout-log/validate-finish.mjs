// W-FINISH-001 / W0.3 / W0.4 validation — finish-boundary consistency,
// server mutation target ownership, and the single-active guarantee.
// 2026-10-17 rework adds: W-START-001 invisible-initialization
// contract (initializing rows are invisible/unwritable; two
// concurrent starts converge on one usable active; initialization
// failure cleans up for retry) and the W-FINISH-001 pending-add
// boundary (settlePendingAdds joins in-flight "+ 加一组" promises
// before either finish path flushes or seals; a failed add aborts
// the finish; a landed add's new set joins the final gate).
// 2026-10-17 second rework adds: W-START-001 yield-by-state — the
// WHOLE initialization (history read included) runs under one
// failure cleanup, and a yielding start decides via the pure
// resolveYieldDecision (other ready -> yield; still initializing ->
// bounded poll; vanished -> proceed; stale leftover -> takeover;
// fresh -> retryable error, never an unusable success) — and the
// W-FINISH-001 registration barrier: both finish paths re-fetch the
// dashboard after settling adds and wait via the pure
// waitForExpectedSetRegistration until the handle registry covers
// every set id of that final data version before flushing/sealing.
// Runs the REAL production functions extracted verbatim from
// client/src/App.tsx and server/src/actions.ts over synthetic data
// only, with a deferred transport so write/complete ordering is
// observed, not assumed. Pure Node, no deps.
// Contract under test (PM W-FINISH-001 reproductions):
//  1. Confirm-finish while an updateSet is still in flight: the
//     sealAndSettle path waits for that write to persist BEFORE any
//     complete request is issued (persist order update -> complete).
//  2. Complete throws or resolves { ok: false } after sealing: the
//     sets are unsealed, drafts survive, and a later edit saves again.
//  3. A new set registers while the finish flush is in flight:
//     flushAllHandles re-reads the registry, flushes the new set too,
//     and only a stable batch feeds the gate; a registry that keeps
//     changing reports stable: false (treated as unsaved).
// Server: mutationTargetDecision matrix and the resolveStartConflict
// yield rule behind the single-active guarantee, plus source wiring
// for the affected-row verdicts in every mutation handler.
// Mutations are executed (ok-check removed, settle not awaiting the
// drain, flushAllHandles skipping its stability re-check) and must
// flip outcomes.
// Owner end-to-end finish flow on a real device stays 运行待验 (PM).
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
  // An object-literal return type annotation (`): { ... } {`) puts a
  // brace pair between the parameter list and the real body; skip it.
  const between = source.slice(closeParen + 1, bodyStart).trimStart();
  if (between.startsWith(':')) {
    const typeEnd = matchDelim(source, bodyStart, '{', '}');
    const nextBrace = source.indexOf('{', typeEnd);
    if (nextBrace > -1 && source.slice(typeEnd + 1, nextBrace).trim() === '') bodyStart = nextBrace;
  }
  const bodyEnd = matchDelim(source, bodyStart, '{', '}');
  return source.slice(idx, bodyEnd + 1);
}

const CLIENT_FN = [
  'setDraftFromSet', 'sameSetDraft', 'initSetSaveMachine', 'setSaveBlocked',
  'editSetDraft', 'beginSetSave', 'applySetSaveSuccess', 'applySetSaveFailure',
  'adoptServerDraft', 'createSaveQueue', 'finishGateDecision',
];
const CLIENT_ASYNC_FN = ['drainSetSaves', 'flushAllHandles', 'sealAllAndSettleStable', 'settlePendingAdds', 'waitForExpectedSetRegistration'];
function extractAsyncFunction(source, name) {
  const idx = source.search(new RegExp(`async function ${name}\\(`));
  if (idx < 0) throw new Error(`async function ${name} not found`);
  const openParen = source.indexOf('(', idx);
  const closeParen = matchDelim(source, openParen, '(', ')');
  const bodyStart = source.indexOf('{', closeParen);
  const bodyEnd = matchDelim(source, bodyStart, '{', '}');
  return source.slice(idx, bodyEnd + 1);
}
function buildClient(src) {
  const parts = CLIENT_FN.map((n) => extractFunction(src, n));
  for (const n of CLIENT_ASYNC_FN) parts.push(extractAsyncFunction(src, n));
  const names = [...CLIENT_FN, ...CLIENT_ASYNC_FN];
  return new Function(`${stripTypeScriptTypes(parts.join('\n'))}\nreturn { ${names.join(', ')} };`)();
}
const SERVER_FN = ['mutationTargetDecision', 'resolveStartConflict', 'canReclaimInitializingWorkout', 'resolveYieldDecision'];
function buildServer(src) {
  const code = SERVER_FN.map((n) => extractFunction(src, n)).join('\n');
  return new Function(`${stripTypeScriptTypes(code)}\nreturn { ${SERVER_FN.join(', ')} };`)();
}
const C = buildClient(clientSrc);
const S = buildServer(serverSrc);

// --- source wiring ---
check('source: handle exposes sealAndSettle + unseal + id',
  clientSrc.includes('sealAndSettle: () => Promise<boolean>') && clientSrc.includes('unseal: () => void') && clientSrc.includes('id: number'));
check('source: confirm path settles before completing',
  clientSrc.indexOf('handle.sealAndSettle()') > -1
  && clientSrc.indexOf('handle.sealAndSettle()') < clientSrc.lastIndexOf('await runComplete()'));
check('source: runComplete checks the business ok result',
  clientSrc.includes('result.ok === true'));
check('source: runComplete unseals every set on failure',
  /async function runComplete[\s\S]*?handle\.unseal\(\)/.test(clientSrc));
check('source: finish failure is surfaced in words',
  clientSrc.includes('结束失败，修改已保留，可以继续编辑保存后重试结束'));
check('source: cancel confirmation does not seal',
  clientSrc.includes('onClick={cancelFinish}>返回继续编辑')
  && /function cancelFinish\(\) \{[^}]*setFinishBlock\(null\)[^}]*\}/.test(clientSrc)
  && !/function cancelFinish\(\) \{[^}]*\.seal\(/.test(clientSrc));
check('source: handleFinish consumes flushAllHandles stability',
  clientSrc.includes('flushOk: stable && (results[index] ?? false)'));
check('server: updateSet is a single UPDATE with the active guard inside (W-ACTIVE-001)',
  serverSrc.indexOf('UPDATE workout_sets', serverSrc.indexOf('updateSet: defineAction')) > -1
  && serverSrc.indexOf('AND EXISTS (', serverSrc.indexOf('updateSet: defineAction')) > -1
  && serverSrc.indexOf('workouts.completed_at IS NULL', serverSrc.indexOf('updateSet: defineAction')) > -1
  && serverSrc.indexOf('mutationTargetDecision', serverSrc.indexOf('updateSet: defineAction')) === -1);
check('server: updateSet verdict uses affected rows',
  serverSrc.includes('if (updatedRows.length === 0) return { ok: false, forbidden: false };'));
check('server: addSet inserts via INSERT..SELECT with the active guard inside (W-ACTIVE-001)',
  serverSrc.indexOf('INSERT INTO workout_sets', serverSrc.indexOf('addSet: defineAction')) > -1
  && serverSrc.indexOf('completed_at IS NULL', serverSrc.indexOf('addSet: defineAction')) > -1
  && serverSrc.indexOf('mutationTargetDecision', serverSrc.indexOf('addSet: defineAction')) === -1);
check('server: completeWorkout verdict uses affected rows',
  /completeWorkout: defineAction[\s\S]*?updated\.length === 0/.test(serverSrc));
check('server: discardWorkout conditionally deletes the workout row BEFORE its sets (W-ACTIVE-001)',
  serverSrc.indexOf('DELETE FROM workouts', serverSrc.indexOf('discardWorkout: defineAction')) > -1
  && serverSrc.indexOf('DELETE FROM workouts', serverSrc.indexOf('discardWorkout: defineAction'))
     < serverSrc.indexOf('db.delete(schema.workoutSets)', serverSrc.indexOf('discardWorkout: defineAction'))
  && serverSrc.indexOf('mutationTargetDecision', serverSrc.indexOf('discardWorkout: defineAction')) === -1);
check('server: startWorkout inserts invisibly (initializing = 1) under the W-START-001 contract',
  serverSrc.indexOf('initializing: 1', serverSrc.indexOf('startWorkout: defineAction')) > -1);
check('server: startWorkout flips ready with a single conditional UPDATE (initializing 1 -> 0)',
  serverSrc.indexOf('.set({ initializing: 0 })', serverSrc.indexOf('startWorkout: defineAction')) > -1
  && serverSrc.indexOf('eq(schema.workouts.initializing, 1)', serverSrc.indexOf('startWorkout: defineAction')) > -1);
check('server: startWorkout yield deletes only its own still-initializing row',
  serverSrc.indexOf('eq(schema.workouts.initializing, 1),', serverSrc.indexOf('startWorkout: defineAction')) > -1
  && serverSrc.indexOf('isNull(schema.workouts.completedAt),', serverSrc.indexOf('startWorkout: defineAction')) > -1);
{
  const startSlice = serverSrc.slice(serverSrc.indexOf('startWorkout: defineAction'));
  check('server: startWorkout history read runs INSIDE the unified cleanup try (W-START-001)',
    startSlice.indexOf('try {') > -1
    && startSlice.indexOf('try {') < startSlice.indexOf('loadPreviousCompletedSets(ctx')
    && startSlice.indexOf('loadPreviousCompletedSets(ctx') < startSlice.indexOf('catch (error)'));
  check('server: startWorkout unified catch cleans up its own initializing row and rethrows as-is',
    /catch \(error\) \{[\s\S]*?cleanupOwnInitializing\(\)[\s\S]*?throw error/.test(startSlice));
  check('server: cleanup deletes only a still-initializing, never-completed own row (visible/completed never deleted)',
    /const cleanupOwnInitializing[\s\S]*?eq\(schema\.workouts\.initializing, 1\),\s*isNull\(schema\.workouts\.completedAt\)/.test(startSlice));
  check('server: startWorkout yield is driven by resolveYieldDecision over a bounded poll (W-START-001)',
    startSlice.includes('resolveYieldDecision(') && startSlice.includes('waitMs(YIELD_WAIT_INTERVAL_MS)'));
  check('server: a fresh still-initializing conflict fails retryably, never as an unusable success',
    startSlice.includes('另一场训练正在初始化，请稍后重试'));
  check('server: takeover deletes the stale row only under the same initializing guard',
    /decision === "takeover"[\s\S]*?eq\(schema\.workouts\.id, keepId\),\s*eq\(schema\.workouts\.initializing, 1\),\s*isNull\(schema\.workouts\.completedAt\)/.test(startSlice));
}
check('source: registration barrier helper is exported (W-FINISH-001)',
  clientSrc.includes('export async function waitForExpectedSetRegistration('));
check('source: the barrier re-fetches the latest dashboard via fetchQuery',
  clientSrc.includes('queryClient.fetchQuery'));
{
  const hf = clientSrc.indexOf('async function handleFinish()');
  const cf = clientSrc.indexOf('async function confirmFinishAnyway()');
  const hfBarrier = clientSrc.indexOf('await awaitFinalSetRegistration()', hf);
  const cfBarrier = clientSrc.indexOf('await awaitFinalSetRegistration()', cf);
  check('source: both finish paths run the registration barrier after settling adds, before flush/seal',
    hfBarrier > clientSrc.indexOf('await settlePendingAdds(', hf)
    && hfBarrier < clientSrc.indexOf('await flushAllHandles(', hf)
    && cfBarrier > clientSrc.indexOf('await settlePendingAdds(', cf)
    && cfBarrier < clientSrc.indexOf('await sealAllAndSettleStable(', cf));
  check('source: barrier failure aborts both finish paths with the failure shown, no complete',
    (clientSrc.match(/if \(!registered\) \{\s*setFinishFailed\(true\);\s*return;/g) ?? []).length === 2);
}
check('server: getDashboard active selection excludes initializing workouts',
  serverSrc.indexOf('eq(schema.workouts.initializing, 0)', serverSrc.indexOf('getDashboard: defineAction')) > -1);
check('server: updateSet guard excludes initializing workouts (zero writes while initializing)',
  serverSrc.indexOf('workouts.initializing = 0', serverSrc.indexOf('updateSet: defineAction')) > -1);
check('server: addSet insert guard excludes initializing workouts',
  serverSrc.indexOf('completed_at IS NULL AND initializing = 0', serverSrc.indexOf('addSet: defineAction')) > -1);
check('server: completeWorkout excludes initializing workouts',
  serverSrc.indexOf('eq(schema.workouts.initializing, 0)', serverSrc.indexOf('completeWorkout: defineAction')) > -1);
check('server: discardWorkout delete excludes initializing workouts',
  serverSrc.indexOf('completed_at IS NULL AND initializing = 0', serverSrc.indexOf('discardWorkout: defineAction')) > -1);
check('source: add-set click registers the mutateAsync promise into the shared registry',
  clientSrc.includes('onRegisterPendingAdd(promise)') && clientSrc.includes('addSet.mutateAsync()')
  && clientSrc.includes('pendingAddsRef') && clientSrc.includes('onRegisterPendingAdd={registerPendingAdd}'));
check('source: handleFinish joins pending adds before flushing',
  clientSrc.indexOf('await settlePendingAdds(', clientSrc.indexOf('async function handleFinish()')) > -1
  && clientSrc.indexOf('await settlePendingAdds(', clientSrc.indexOf('async function handleFinish()'))
     < clientSrc.indexOf('await flushAllHandles(', clientSrc.indexOf('async function handleFinish()')));
check('source: confirmFinishAnyway joins pending adds before sealing',
  clientSrc.indexOf('await settlePendingAdds(', clientSrc.indexOf('async function confirmFinishAnyway()')) > -1
  && clientSrc.indexOf('await settlePendingAdds(', clientSrc.indexOf('async function confirmFinishAnyway()'))
     < clientSrc.indexOf('await sealAllAndSettleStable(', clientSrc.indexOf('async function confirmFinishAnyway()')));
check('source: a failed pending add aborts both finish paths with the failure shown, no complete',
  (clientSrc.match(/if \(!adds\.ok\) \{\s*setFinishFailed\(true\);\s*return;/g) ?? []).length === 2);
check('source: direct finish seals the batch before completing (W-FINISH-001)',
  /handle\.seal\(\)/.test(clientSrc) && clientSrc.includes('sealAllAndSettleStable'));
check('source: inputs lock while finishing (W-FINISH-001)',
  clientSrc.includes('entryLocked') && clientSrc.includes('正在结束'));
check('server: startWorkout re-checks actives and yields via resolveStartConflict',
  serverSrc.includes('resolveStartConflict(earliestOtherActiveId, workoutId)'));

// --- harness: one set row with a deferred transport ---
function makeRow(C, initial, sendImpl) {
  let machine = C.initSetSaveMachine(initial);
  let sealed = false;
  const env = {
    getMachine: () => machine,
    setMachine: (next) => { machine = next; },
    send: sendImpl,
    isSealed: () => sealed,
    onSaved: () => {},
  };
  const queue = C.createSaveQueue(env);
  const handle = {
    id: initial.id,
    getStatus: () => machine.status,
    flush: () => queue.flush(),
    isBlocked: () => C.setSaveBlocked(machine),
    isCompleted: () => machine.draft.completed,
    seal: () => { sealed = true; },
    sealAndSettle: async () => { sealed = true; return queue.settle(); },
    unseal: () => { sealed = false; },
  };
  return {
    handle, queue,
    edit: (draft) => { machine = C.editSetDraft(machine, draft); },
    getMachine: () => machine,
    isSealed: () => sealed,
  };
}
function deferred() {
  let resolve; let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
const SET = { id: 7, weight: 100, reps: 8, completed: true };

// Repro 1: in-flight write at confirm time persists before complete.
{
  const order = [];
  const gate = deferred();
  const row = makeRow(C, SET, async (draft) => {
    await gate.promise;
    order.push(`update:${draft.weight}`);
    return { ok: true };
  });
  row.edit({ weight: '120', reps: '8', completed: true });
  const savePromise = row.queue.requestSave(); // write now in flight
  const settlePromise = row.handle.sealAndSettle(); // confirm pressed
  gate.resolve();
  const settledClean = await settlePromise;
  await savePromise;
  order.push('complete'); // complete is only issued after settle resolves
  check('repro1: in-flight write persists before complete is issued',
    order.join('>') === 'update:120>complete', order.join('>'));
  check('repro1: sealAndSettle reports clean once the write landed', settledClean === true);
  check('repro1: machine is saved after settle', row.getMachine().status === 'saved');
}

// Repro 2: complete fails after sealing -> unseal -> edit saves again.
{
  const persisted = [];
  const row = makeRow(C, SET, async (draft) => { persisted.push(draft.weight); return { ok: true }; });
  row.edit({ weight: '110', reps: '8', completed: true });
  await row.queue.requestSave(); // the edit's autosave, as in the real flow
  await row.handle.sealAndSettle();
  // runComplete failure path: unseal everything (mirrors App wiring).
  row.handle.unseal();
  check('repro2: unseal restores saveability after a failed complete', row.isSealed() === false);
  row.edit({ weight: '130', reps: '8', completed: true });
  const ok = await row.queue.requestSave();
  check('repro2: edit after failed complete saves successfully', ok === true && persisted.join(',') === '110,130', persisted.join(','));
  check('repro2: draft preserved and saved, not lost', row.getMachine().draft.weight === '130' && row.getMachine().status === 'saved');
}

// Repro 2b: a sealed queue refuses new writes (the pre-fix bug shape:
// without unseal the row would stay wedged exactly like this).
{
  const row = makeRow(C, SET, async () => ({ ok: true }));
  row.edit({ weight: '115', reps: '8', completed: true });
  row.handle.seal();
  const ok = await row.queue.requestSave();
  check('repro2b: while sealed the queue issues no write', ok === false && row.getMachine().status === 'dirty');
}

// Repro 3: a set registering mid-flush is flushed too; batch is stable
// only once a full round leaves the registry unchanged.
{
  const flushed = [];
  const mkHandle = (id) => ({
    id,
    getStatus: () => 'saved',
    flush: async () => { flushed.push(id); return true; },
    isBlocked: () => false,
    isCompleted: () => true,
    seal: () => {}, sealAndSettle: async () => true, unseal: () => {},
  });
  const h1 = mkHandle(1); const h2 = mkHandle(2);
  let registry = [h1];
  let calls = 0;
  const getHandles = () => { calls++; if (calls >= 2 && !registry.includes(h2)) registry = [h1, h2]; return [...registry]; };
  const { handles, results, stable } = await C.flushAllHandles(getHandles);
  check('repro3: mid-flush registration is flushed in a later round', flushed.join(',') === '1,1,2', flushed.join(','));
  check('repro3: final batch is stable and covers both sets', stable === true && handles.length === 2 && results.every(Boolean));
  const decision = C.finishGateDecision(handles.map((h, i) => ({
    flushOk: stable && results[i], status: h.getStatus(), blocked: h.isBlocked(), completed: h.isCompleted(),
  })));
  check('repro3: gate proceeds only on the stable full batch', decision.proceed === true);
}
{
  const mkHandle = (id) => ({
    id, getStatus: () => 'saved', flush: async () => true,
    isBlocked: () => false, isCompleted: () => true,
    seal: () => {}, sealAndSettle: async () => true, unseal: () => {},
  });
  let n = 0;
  const getHandles = () => { n++; return [mkHandle(n)]; }; // changes every read
  const { stable } = await C.flushAllHandles(getHandles, 3);
  check('repro3b: a registry that never stabilises reports stable:false', stable === false);
}

// W-FINISH-001 remaining window: a set registering DURING the
// confirm-finish seal loop must itself be sealed+settled before the
// batch counts as stable; a registry that never stabilises aborts.
{
  const sealedOrder = [];
  const mkHandle = (id) => ({
    id, getStatus: () => 'saved', flush: async () => true,
    isBlocked: () => false, isCompleted: () => true,
    seal: () => {}, sealAndSettle: async () => { sealedOrder.push(id); return true; }, unseal: () => {},
  });
  const h1 = mkHandle(1); const h2 = mkHandle(2);
  let registry = [h1];
  let calls = 0;
  const getHandles = () => { calls++; if (calls >= 2 && !registry.includes(h2)) registry = [h1, h2]; return [...registry]; };
  const res = await C.sealAllAndSettleStable(getHandles);
  check('W-FINISH: mid-seal registration is sealed in a later round', sealedOrder.join(',') === '1,1,2', sealedOrder.join(','));
  check('W-FINISH: seal batch stable only after covering the new set', res.stable === true && res.handles.length === 2);
  let n = 0;
  const unstable = await C.sealAllAndSettleStable(() => [mkHandle(++n)], 3);
  check('W-FINISH: never-stable registry reports stable:false (caller aborts)', unstable.stable === false);
}

// W-FINISH-001 pending-add boundary: settlePendingAdds joins the
// shared registry before any flush/seal. A landed add's new set must
// reach the finish gate as an ordinary (incomplete) set — never a
// silent complete over a set nobody checked.
{
  const res = await C.settlePendingAdds(() => []);
  check('W-FINISH(adds): empty registry settles ok and stable', res.ok === true && res.stable === true);
}
{
  // An add is in flight when finish is pressed; it lands
  // successfully (dashboard refreshed, new SetRow registered). The
  // composed flow — settle adds, then flush + gate over the handle
  // registry — must judge the NEW set: incomplete, so the finish
  // stops at the confirmation instead of completing silently.
  const addGate = deferred();
  let addLanded = false;
  const pendingAdd = (async () => { await addGate.promise; addLanded = true; })();
  const registry = new Set([pendingAdd]);
  const getPending = () => [...registry];
  void pendingAdd.then(() => registry.delete(pendingAdd));
  const settlePromise = C.settlePendingAdds(getPending);
  addGate.resolve();
  const res = await settlePromise;
  check('W-FINISH(adds): an in-flight add is awaited before the finish proceeds',
    res.ok === true && addLanded === true);
  const existing = {
    id: 1, getStatus: () => 'saved', flush: async () => true,
    isBlocked: () => false, isCompleted: () => true,
    seal: () => {}, sealAndSettle: async () => true, unseal: () => {},
  };
  const landed = {
    id: 2, getStatus: () => 'saved', flush: async () => true,
    isBlocked: () => false, isCompleted: () => false,
    seal: () => {}, sealAndSettle: async () => true, unseal: () => {},
  };
  const handles = [existing, landed]; // the landed add's SetRow registered after the refetch
  const { results, stable } = await C.flushAllHandles(() => [...handles]);
  const decision = C.finishGateDecision(handles.map((h, i) => ({
    flushOk: stable && results[i], status: h.getStatus(), blocked: h.isBlocked(), completed: h.isCompleted(),
  })));
  check('W-FINISH(adds): the landed add joins the gate as an incomplete set (confirmation, not silent complete)',
    decision.proceed === false && decision.reason === 'incomplete');
}
{
  // The add was issued in the same tick as the finish press and
  // registers during settlePendingAdds' empty-read yield: it must
  // still be awaited, not skipped by the first empty read.
  const registry = new Set();
  let awaited = false;
  const lateAdd = (async () => { await new Promise((r) => setTimeout(r, 5)); awaited = true; })();
  setTimeout(() => {
    registry.add(lateAdd);
    void lateAdd.then(() => registry.delete(lateAdd));
  }, 0);
  const res = await C.settlePendingAdds(() => [...registry]);
  check('W-FINISH(adds): an add registering during the empty-read yield is still joined',
    res.ok === true && awaited === true);
}
{
  // A failed add aborts the finish: failure state, no complete.
  let completeCalled = false;
  const failingAdd = Promise.reject(new Error('add failed'));
  const res = await C.settlePendingAdds(() => [failingAdd]);
  if (res.ok) completeCalled = true; // the finish paths only proceed on ok
  check('W-FINISH(adds): a failed add aborts the finish and complete is never called',
    res.ok === false && completeCalled === false);
}
{
  // A registry that keeps gaining adds never stabilises.
  const res = await C.settlePendingAdds(() => [Promise.resolve()], 3);
  check('W-FINISH(adds): a never-empty registry reports stable:false (caller aborts)',
    res.ok === false && res.stable === false);
}

// W-START-001 yield-by-state matrix: resolveYieldDecision driven in
// the same bounded-poll loop startWorkout runs — each poll re-reads
// the other row's state and feeds it to the REAL pure function.
function driveYield(observations, attempts = 3) {
  let index = 0;
  let attemptsLeft = attempts;
  const seen = [];
  for (;;) {
    const obs = observations[Math.min(index, observations.length - 1)];
    const decision = S.resolveYieldDecision(obs.other, attemptsLeft, obs.nowMs);
    seen.push(decision);
    if (decision !== 'wait') return { decision, seen };
    attemptsLeft -= 1;
    index += 1;
  }
}
const INIT_AT_1000 = { present: true, initializing: true, startedAtMs: 1000 };
{
  const { decision, seen } = driveYield([{ other: { present: true, initializing: false, startedAtMs: 1000 }, nowMs: 2000 }]);
  check('W-START(yield): other already ready -> yield to it immediately',
    decision === 'yield-ready' && seen.join(',') === 'yield-ready');
}
{
  const { decision, seen } = driveYield([
    { other: INIT_AT_1000, nowMs: 1100 },
    { other: INIT_AT_1000, nowMs: 1300 },
    { other: { present: true, initializing: false, startedAtMs: 1000 }, nowMs: 1500 },
  ], 5);
  check('W-START(yield): other flips ready mid-wait -> wait, wait, then yield',
    decision === 'yield-ready' && seen.join(',') === 'wait,wait,yield-ready', seen.join(','));
}
{
  const { decision, seen } = driveYield([
    { other: INIT_AT_1000, nowMs: 1100 },
    { other: { present: false, initializing: false, startedAtMs: null }, nowMs: 1300 },
  ], 5);
  check('W-START(yield): other row vanishes mid-wait (its init failed and self-cleaned) -> proceed with own ready flip',
    decision === 'proceed-self' && seen.join(',') === 'wait,proceed-self', seen.join(','));
}
{
  const stale = { present: true, initializing: true, startedAtMs: 1000 };
  const { decision, seen } = driveYield([
    { other: stale, nowMs: 32000 },
    { other: stale, nowMs: 32200 },
    { other: stale, nowMs: 32400 },
  ], 2);
  check('W-START(yield): still initializing past the budget and >=30s old -> takeover',
    decision === 'takeover' && seen.join(',') === 'wait,wait,takeover', seen.join(','));
}
{
  const fresh = { present: true, initializing: true, startedAtMs: 1000 };
  const { decision, seen } = driveYield([
    { other: fresh, nowMs: 4000 },
    { other: fresh, nowMs: 4200 },
    { other: fresh, nowMs: 4400 },
  ], 2);
  check('W-START(yield): still initializing past the budget but fresh -> retryable error, never an unusable return',
    decision === 'retry' && seen.join(',') === 'wait,wait,retry', seen.join(','));
}
check('W-START(yield): no other row at all -> proceed-self',
  S.resolveYieldDecision({ present: false, initializing: false, startedAtMs: null }, 0, 5000) === 'proceed-self');
check('W-START(yield): exactly 30s old counts as stale (boundary)',
  S.resolveYieldDecision({ present: true, initializing: true, startedAtMs: 1000 }, 0, 31000) === 'takeover'
  && S.resolveYieldDecision({ present: true, initializing: true, startedAtMs: 1000 }, 0, 30999) === 'retry');

// W-FINISH-001 registration barrier: waitForExpectedSetRegistration
// polls the registry until the FINAL data version's set ids are all
// registered; the finish paths proceed only on { ok: true }.
{
  const res = await C.waitForExpectedSetRegistration(() => [1, 2, 3], [1, 2, 3], 5, 1);
  check('W-FINISH(barrier): every expected set already registered -> passes at once',
    res.ok === true && res.missing.length === 0);
}
{
  // The PM window: the dashboard data already includes the new set,
  // but its SetRow registers only a few polls later.
  let reads = 0;
  const res = await C.waitForExpectedSetRegistration(() => {
    reads += 1;
    return reads >= 4 ? [1, 2] : [1];
  }, [1, 2], 10, 1);
  check('W-FINISH(barrier): registration lagging several polls behind the data still passes',
    res.ok === true && reads >= 4, `reads=${reads}`);
}
{
  let completeCalled = false;
  const res = await C.waitForExpectedSetRegistration(() => [1], [1, 2, 3], 3, 1);
  if (res.ok) completeCalled = true; // both finish paths gate complete on the barrier
  check('W-FINISH(barrier): a set that never registers reports its id missing and the finish aborts (no complete)',
    res.ok === false && JSON.stringify(res.missing) === JSON.stringify([2, 3]) && completeCalled === false);
}
{
  const res = await C.waitForExpectedSetRegistration(() => [1, 2], [], 3, 1);
  check('W-FINISH(barrier): an empty expectation passes trivially',
    res.ok === true && res.missing.length === 0);
}

// W-START-001: reclaim decision matrix (pure mirror of the
// conditional DELETE). Under the invisible-initialization contract
// reclaim needs no edit heuristics: still-initializing + active is
// provably untouched, because no mutation may target it at all.
check('W-START: a still-initializing active insert may be reclaimed',
  S.canReclaimInitializingWorkout({ initializing: true, completedAt: null }) === true);
check('W-START: a ready (visible) workout is never reclaimed',
  S.canReclaimInitializingWorkout({ initializing: false, completedAt: null }) === false);
check('W-START: a completed workout is never reclaimed',
  S.canReclaimInitializingWorkout({ initializing: true, completedAt: '2026-10-17T00:00:00.000Z' }) === false);

// W-START-001 simulation: an in-memory world whose start/finish
// steps run the REAL extracted pure decisions (resolveStartConflict,
// canReclaimInitializingWorkout, mutationTargetDecision) in the same
// order startWorkout runs them against the database.
function makeStartWorld() {
  const rows = new Map();
  let nextId = 1;
  const insertInitializing = () => {
    const id = nextId++;
    rows.set(id, { id, completed_at: null, initializing: true });
    return id;
  };
  // The post-insert phase of startWorkout: re-check all other
  // actives (ready AND initializing), yield or flip ready.
  const finishStart = (id) => {
    const row = rows.get(id);
    const others = [...rows.values()]
      .filter((w) => w.id !== id && w.completed_at == null)
      .map((w) => w.id)
      .sort((a, b) => a - b);
    const conflict = S.resolveStartConflict(others[0] ?? null, id);
    if (conflict.action === 'yield') {
      if (S.canReclaimInitializingWorkout({ initializing: row.initializing, completedAt: row.completed_at })) {
        rows.delete(id);
        return conflict.keepId;
      }
      return id;
    }
    row.initializing = false;
    return id;
  };
  const failInitialization = (id) => { rows.delete(id); }; // startWorkout's catch cleanup
  const visibleActiveIds = () => [...rows.values()]
    .filter((w) => w.completed_at == null && !w.initializing)
    .map((w) => w.id);
  const targetOf = (id) => {
    const w = rows.get(id);
    return S.mutationTargetDecision(w ? { completed_at: w.completed_at, initializing: w.initializing } : null);
  };
  return { rows, insertInitializing, finishStart, failInitialization, visibleActiveIds, targetOf };
}

// Double start, out of order: B finishes initializing first, A
// second. Both must return the same (earlier) workout; at no read
// moment is more than one usable active visible; while either is
// initializing the dashboard sees nothing.
{
  const world = makeStartWorld();
  const a = world.insertInitializing();
  const b = world.insertInitializing();
  check('W-START: getDashboard sees no active while starts are initializing',
    world.visibleActiveIds().length === 0);
  check('W-START: an initializing workout is not a mutation target (edited-but-invisible is impossible)',
    world.targetOf(a) === 'initializing' && world.targetOf(b) === 'initializing');
  const returnedByB = world.finishStart(b); // B re-checks first: A is earlier, B yields
  check('W-START: the later start yields to the earlier one and returns it',
    returnedByB === a && !world.rows.has(b));
  check('W-START: still no usable active until the survivor flips ready',
    world.visibleActiveIds().length === 0);
  const returnedByA = world.finishStart(a);
  check('W-START: two concurrent starts return the same effective target',
    returnedByA === a && returnedByB === returnedByA);
  check('W-START: exactly one usable active after both starts settle',
    JSON.stringify(world.visibleActiveIds()) === JSON.stringify([a]));
  check('W-START: the surviving ready workout accepts writes (serial flow unregressed)',
    world.targetOf(a) === 'ok');
  world.rows.get(a).completed_at = '2026-10-17T01:00:00.000Z';
  check('W-START: after completion the target is history, never writable again',
    world.targetOf(a) === 'not-active' && world.visibleActiveIds().length === 0);
}

// Initialization failure: the failed start removes its own
// initializing row, and a retry starts cleanly.
{
  const world = makeStartWorld();
  const failed = world.insertInitializing();
  world.failInitialization(failed);
  check('W-START: a failed initialization leaves no row behind',
    !world.rows.has(failed) && world.visibleActiveIds().length === 0);
  const retry = world.insertInitializing();
  const returned = world.finishStart(retry);
  check('W-START: start retries cleanly after an initialization failure',
    returned === retry && JSON.stringify(world.visibleActiveIds()) === JSON.stringify([retry]));
}

// A ready active already present is returned as-is by a later
// start; nothing is deleted.
{
  const world = makeStartWorld();
  const first = world.insertInitializing();
  world.finishStart(first); // now ready
  check('W-START: a visible/edited/completed record is never deleted by a yield',
    S.canReclaimInitializingWorkout({ initializing: false, completedAt: null }) === false
    && world.rows.has(first) && world.targetOf(first) === 'ok');
}

// settle() with nothing running judges from the machine alone.
{
  const row = makeRow(C, SET, async () => ({ ok: true }));
  check('settle: clean machine with no drain resolves true', await row.queue.settle() === true);
  row.edit({ weight: '99', reps: '8', completed: true });
  check('settle: dirty machine with no drain resolves false', await row.queue.settle() === false);
}

// --- server pure functions ---
check('W0.3: missing workout is not-found', S.mutationTargetDecision(null) === 'not-found');
check('W0.3: completed workout is not-active', S.mutationTargetDecision({ completed_at: '2026-10-17T00:00:00.000Z' }) === 'not-active');
check('W0.3: active workout is ok', S.mutationTargetDecision({ completed_at: null }) === 'ok');
check('W-START: an initializing workout is its own non-target verdict',
  S.mutationTargetDecision({ completed_at: null, initializing: true }) === 'initializing');
check('W-START: initializing wins over the completed check (never writable either way)',
  S.mutationTargetDecision({ completed_at: '2026-10-17T00:00:00.000Z', initializing: true }) === 'initializing');
check('W0.4: earlier active wins and the insert yields',
  JSON.stringify(S.resolveStartConflict(3, 9)) === JSON.stringify({ action: 'yield', keepId: 3 }));
check('W0.4: no other active keeps the insert',
  JSON.stringify(S.resolveStartConflict(null, 9)) === JSON.stringify({ action: 'created', keepId: 9 }));
check('W0.4: a later active does not displace the insert',
  JSON.stringify(S.resolveStartConflict(12, 9)) === JSON.stringify({ action: 'created', keepId: 9 }));

// --- mutations must flip outcomes ---
{
  const mutated = clientSrc.replace('if (!result || result.ok !== true)', 'if (!result)');
  const CM = buildClient(mutated);
  const row = makeRow(CM, SET, async () => ({ ok: false, forbidden: true }));
  row.edit({ weight: '120', reps: '8', completed: true });
  const ok = await row.queue.requestSave();
  check('mutation: dropping the ok check marks a business refusal saved (detected)', ok === true && row.getMachine().status === 'saved');
}
{
  const mutated = clientSrc.replace('await running;', 'void running;');
  const CM = buildClient(mutated);
  const gate = deferred();
  const row = makeRow(CM, SET, async () => { await gate.promise; return { ok: true }; });
  row.edit({ weight: '120', reps: '8', completed: true });
  void row.queue.requestSave();
  const settled = row.queue.settle();
  gate.resolve();
  check('mutation: settle without awaiting the drain judges too early (detected)', await settled === false);
}
{
  const mutated = clientSrc.replace('return { ok: false, stable: true };', 'return { ok: true, stable: true };');
  const CM = buildClient(mutated);
  const res = await CM.settlePendingAdds(() => [Promise.reject(new Error('add failed'))]);
  check('mutation: treating a failed add as settled lets the finish proceed (detected)', res.ok === true);
}
{
  const mutated = clientSrc.replace('if (stable) return { handles, results, stable: true };', 'return { handles, results, stable: true };');
  const CM = buildClient(mutated);
  const mkHandle = (id) => ({
    id, getStatus: () => 'saved', flush: async () => true,
    isBlocked: () => false, isCompleted: () => true,
    seal: () => {}, sealAndSettle: async () => true, unseal: () => {},
  });
  let n = 0;
  const { stable } = await CM.flushAllHandles(() => [mkHandle(++n)], 3);
  check('mutation: skipping the stability re-check reports an unstable batch stable (detected)', stable === true);
}

{
  const mutated = clientSrc.replace('round < maxRounds && missing.length > 0', 'round < 0 && missing.length > 0');
  const CM = buildClient(mutated);
  let reads = 0;
  const res = await CM.waitForExpectedSetRegistration(() => { reads += 1; return reads >= 4 ? [1, 2] : [1]; }, [1, 2], 10, 1);
  check('mutation: a registration barrier that never polls misses late registration (detected)', res.ok === false);
}
{
  const mutated = serverSrc.replace('if (attemptsLeft > 0) return "wait";', 'if (attemptsLeft < 0) return "wait";');
  const SM = buildServer(mutated);
  const decision = SM.resolveYieldDecision({ present: true, initializing: true, startedAtMs: 1000 }, 3, 2000);
  check('mutation: dropping the bounded yield wait decides over a still-initializing workout immediately (detected)',
    decision !== 'wait');
}

console.log(`\n${passed} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
