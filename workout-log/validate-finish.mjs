// W-FINISH-001 / W0.3 / W0.4 validation — finish-boundary consistency,
// server mutation target ownership, and the single-active guarantee.
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
const CLIENT_ASYNC_FN = ['drainSetSaves', 'flushAllHandles', 'sealAllAndSettleStable'];
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
const SERVER_FN = ['mutationTargetDecision', 'resolveStartConflict', 'canReclaimYieldedWorkout'];
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
  clientSrc.includes('onClick={() => setFinishBlock(null)}>返回继续编辑'));
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
check('server: startWorkout reclaim DELETE carries the W-START-001 conditions',
  serverSrc.indexOf('DELETE FROM workouts', serverSrc.indexOf('startWorkout: defineAction')) > -1
  && serverSrc.indexOf('NOT EXISTS (', serverSrc.indexOf('startWorkout: defineAction')) > -1);
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

// W-START-001: reclaim decision matrix (pure mirror of the DELETE).
check('W-START: untouched active insert may be reclaimed',
  S.canReclaimYieldedWorkout({ completedAt: null, setCount: 16, initialSetCount: 16, editedSetCount: 0 }) === true);
check('W-START: a completed insert is never reclaimed',
  S.canReclaimYieldedWorkout({ completedAt: '2026-10-17T00:00:00.000Z', setCount: 16, initialSetCount: 16, editedSetCount: 0 }) === false);
check('W-START: a user-edited insert is never reclaimed',
  S.canReclaimYieldedWorkout({ completedAt: null, setCount: 16, initialSetCount: 16, editedSetCount: 1 }) === false);
check('W-START: an insert with added sets is never reclaimed',
  S.canReclaimYieldedWorkout({ completedAt: null, setCount: 17, initialSetCount: 16, editedSetCount: 0 }) === false);

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

console.log(`\n${passed} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
