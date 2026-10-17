// W-UI-001 / W0.1 / W0.2 validation — per-set autosave state machine.
// Runs the REAL production functions extracted verbatim from
// client/src/App.tsx over synthetic data only. Pure Node, no deps.
// Contract under test:
//  - Editing weight/reps marks the set dirty; editing back to the
//    confirmed values returns to saved; blur/Enter/debounce wiring and
//    the completed toggle all route through the same save path.
//  - beginSetSave issues an increasing seq; only the latest seq may
//    apply success/failure, so slow out-of-order responses cannot flip
//    status. Success after a mid-save edit lands on dirty, not saved.
//  - Failure keeps the local draft and reports error only when the
//    failed payload is still the current draft.
//  - A completed set with empty reps is blocked from saving.
//  - Server refresh adoption (adoptServerDraft) applies only while
//    saved; dirty/saving/error drafts are never overwritten.
//  - Finish gate wiring: the finish button flushes all set handles
//    first; unsaved work triggers a visible confirm and beforeunload.
// Mutations are executed (seq guard removed, adopt guard removed,
// success forcing saved) and must flip outcomes.
// Owner three-viewport page evidence stays 运行待验 (PM acceptance).
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

const FN = [
  'setDraftFromSet', 'sameSetDraft', 'initSetSaveMachine', 'setSaveBlocked',
  'editSetDraft', 'beginSetSave', 'applySetSaveSuccess', 'applySetSaveFailure',
  'adoptServerDraft', 'setSaveStatusLabel', 'hasUnsavedSetStatus',
];
function buildMachine(src) {
  const code = FN.map((n) => extractFunction(src, n)).join('\n');
  return new Function(`${stripTypeScriptTypes(code)}\nreturn { ${FN.join(', ')} };`)();
}
const M = buildMachine(clientSrc);

// --- source wiring ---
check('source: inputs save on blur', (clientSrc.match(/onBlur=\{onBlurSave\}/g) ?? []).length === 2);
check('source: Enter blurs into the save path', clientSrc.includes('event.currentTarget.blur()'));
check('source: short debounce (800ms) autosaves', clientSrc.includes('}, 800);'));
check('source: autosave posts through existing updateSet', clientSrc.includes('await api.updateSet({'));
check('source: status rendered as text label', clientSrc.includes('setSaveStatusLabel(status)'));
check('source: error state offers a retry button', clientSrc.includes('className="set-retry"'));
check('source: finish button goes through the flush gate', clientSrc.includes('onClick={() => void handleFinish()}'));
check('source: finish flushes every registered set handle', clientSrc.includes('handles.map((handle) => handle.flush()'));
check('source: unsaved finish needs explicit confirm', clientSrc.includes('仍有未保存的修改，结束训练会丢失这些修改'));
check('source: page-leave warning while unsaved', clientSrc.includes('"beforeunload"'));

// --- machine behaviour ---
const SET = { id: 7, weight: 100, reps: 8, completed: false };
let m = M.initSetSaveMachine(SET);
check('init: saved with draft mirroring the server set',
  m.status === 'saved' && m.draft.weight === '100' && m.draft.reps === '8' && m.draft.completed === false);
check('init: null weight/reps become empty strings',
  M.initSetSaveMachine({ id: 8, weight: null, reps: null, completed: false }).draft.weight === '');

m = M.editSetDraft(m, { weight: '105', reps: '8', completed: false });
check('edit: changed weight is dirty (unsaved)', m.status === 'dirty');
m = M.editSetDraft(m, { weight: '100', reps: '8', completed: false });
check('edit: reverting to confirmed values returns to saved', m.status === 'saved');

// Save flow: edit -> begin -> success with unchanged draft.
m = M.editSetDraft(m, { weight: '105', reps: '8', completed: false });
let begun = M.beginSetSave(m);
check('begin: saving with seq 1 and inflight draft captured',
  begun.seq === 1 && begun.machine.status === 'saving' && begun.machine.inflightDraft.weight === '105');
m = M.applySetSaveSuccess(begun.machine, begun.seq);
check('success: unchanged draft lands saved, confirmed updated',
  m.status === 'saved' && m.confirmed.weight === '105');

// Clean machine cannot begin another save.
check('begin: clean machine returns null', M.beginSetSave(m) === null);

// Edit during an in-flight save: success must land on dirty.
m = M.editSetDraft(m, { weight: '110', reps: '8', completed: false });
begun = M.beginSetSave(m);
m = M.editSetDraft(begun.machine, { weight: '115', reps: '8', completed: false });
check('mid-save edit: status goes back to dirty', m.status === 'dirty');
m = M.applySetSaveSuccess({ ...m, seq: begun.seq, inflightSeq: begun.seq, inflightDraft: begun.machine.inflightDraft }, begun.seq);
check('success after mid-save edit: dirty, not saved', m.status === 'dirty' && m.confirmed.weight === '110');

// Out-of-order: save A (seq s1) then save B (seq s2); A's late results
// must not move status; B's success confirms B.
let base = M.initSetSaveMachine(SET);
base = M.editSetDraft(base, { weight: '105', reps: '8', completed: false });
const b1 = M.beginSetSave(base);
let cur = M.editSetDraft(b1.machine, { weight: '120', reps: '9', completed: false });
const b2 = M.beginSetSave(cur);
cur = b2.machine;
const afterStaleSuccess = M.applySetSaveSuccess(cur, b1.seq);
check('out-of-order: stale success ignored (still saving B)',
  afterStaleSuccess.status === 'saving' && afterStaleSuccess.confirmed.weight === '100');
const afterStaleFailure = M.applySetSaveFailure(cur, b1.seq);
check('out-of-order: stale failure ignored (still saving B)',
  afterStaleFailure.status === 'saving');
cur = M.applySetSaveSuccess(cur, b2.seq);
check('out-of-order: latest success saves B', cur.status === 'saved' && cur.confirmed.weight === '120' && cur.confirmed.reps === '9');

// Failure keeps the draft and reports error; retry can recover.
let f = M.initSetSaveMachine(SET);
f = M.editSetDraft(f, { weight: '90', reps: '6', completed: true });
const fb = M.beginSetSave(f);
f = M.applySetSaveFailure(fb.machine, fb.seq);
check('failure: error status, local draft retained',
  f.status === 'error' && f.draft.weight === '90' && f.draft.reps === '6');
const fb2 = M.beginSetSave(f);
f = M.applySetSaveSuccess(fb2.machine, fb2.seq);
check('retry after failure: saves and clears error', f.status === 'saved' && f.confirmed.weight === '90');

// Failure for a superseded draft does not brand the new draft as error.
let g = M.initSetSaveMachine(SET);
g = M.editSetDraft(g, { weight: '95', reps: '7', completed: false });
const gb = M.beginSetSave(g);
g = M.editSetDraft(gb.machine, { weight: '97', reps: '7', completed: false });
g = M.applySetSaveFailure(g, gb.seq);
check('failure of superseded draft: new draft stays dirty, not error', g.status === 'dirty');

// Completed set without reps is blocked from saving.
let blocked = M.initSetSaveMachine({ id: 9, weight: 50, reps: null, completed: false });
blocked = M.editSetDraft(blocked, { weight: '50', reps: '', completed: true });
check('blocked: completed with empty reps cannot begin a save',
  M.setSaveBlocked(blocked) === true && M.beginSetSave(blocked) === null);
blocked = M.editSetDraft(blocked, { weight: '50', reps: '10', completed: true });
check('blocked: filling reps unblocks the save', M.setSaveBlocked(blocked) === false && M.beginSetSave(blocked) !== null);

// Completed-set re-edit (the W-UI acceptance case): editing numbers on
// an already completed set is a normal dirty -> save cycle.
let done = M.initSetSaveMachine({ id: 10, weight: 60, reps: 10, completed: true });
done = M.editSetDraft(done, { weight: '65', reps: '10', completed: true });
const db = M.beginSetSave(done);
done = M.applySetSaveSuccess(db.machine, db.seq);
check('completed set re-edit: autosaves without toggling completion',
  done.status === 'saved' && done.confirmed.weight === '65' && done.confirmed.completed === true);

// Refresh adoption: only clean rows adopt server values.
const serverNew = { weight: '200', reps: '3', completed: true };
const cleanAdopt = M.adoptServerDraft(M.initSetSaveMachine(SET), serverNew);
check('adopt: saved row takes server values', cleanAdopt.draft.weight === '200' && cleanAdopt.confirmed.weight === '200');
let dirtyRow = M.editSetDraft(M.initSetSaveMachine(SET), { weight: '111', reps: '8', completed: false });
check('adopt: dirty row keeps local input', M.adoptServerDraft(dirtyRow, serverNew).draft.weight === '111');
let errorRow = M.applySetSaveFailure(M.beginSetSave(dirtyRow).machine, 1);
check('adopt: error row keeps local input', M.adoptServerDraft(errorRow, serverNew).draft.weight === '111');

// Labels and the unsaved aggregate used by the finish gate / unload.
check('labels: dirty/saving/saved/error are distinct texts',
  M.setSaveStatusLabel('dirty') === '未保存'
  && M.setSaveStatusLabel('saving') === '保存中…'
  && M.setSaveStatusLabel('saved') === '已保存'
  && M.setSaveStatusLabel('error') === '保存失败');
check('aggregate: any non-saved status counts as unsaved',
  M.hasUnsavedSetStatus(['saved', 'saved']) === false
  && M.hasUnsavedSetStatus(['saved', 'dirty']) === true
  && M.hasUnsavedSetStatus(['saving']) === true
  && M.hasUnsavedSetStatus(['error']) === true
  && M.hasUnsavedSetStatus([]) === false);

// --- mutation sensitivity (executed) ---
const seqGuardSrc = clientSrc.replace(
  extractFunction(clientSrc, 'applySetSaveSuccess'),
  extractFunction(clientSrc, 'applySetSaveSuccess').replace(
    'if (seq !== machine.seq || machine.inflightDraft == null) return machine;',
    'if (machine.inflightDraft == null) return machine;',
  ),
);
check('mutation setup: seq-guard variant differs', seqGuardSrc !== clientSrc);
const staleApplied = buildMachine(seqGuardSrc);
let sm = staleApplied.initSetSaveMachine(SET);
sm = staleApplied.editSetDraft(sm, { weight: '105', reps: '8', completed: false });
const sb1 = staleApplied.beginSetSave(sm);
sm = staleApplied.editSetDraft(sb1.machine, { weight: '120', reps: '9', completed: false });
const sb2 = staleApplied.beginSetSave(sm);
sm = staleApplied.applySetSaveSuccess(sb2.machine, sb1.seq);
check('mutation: dropping the seq guard lets a stale success mark the row saved while the newer save is still in flight',
  sm.status === 'saved');

const adoptGuardSrc = clientSrc.replace('if (machine.status !== "saved") return machine;', 'if (machine.status === "never") return machine;');
check('mutation setup: adopt-guard variant differs', adoptGuardSrc !== clientSrc);
const adoptMut = buildMachine(adoptGuardSrc);
let am = adoptMut.editSetDraft(adoptMut.initSetSaveMachine(SET), { weight: '111', reps: '8', completed: false });
check('mutation: dropping the adopt guard lets a refresh overwrite a dirty draft',
  adoptMut.adoptServerDraft(am, serverNew).draft.weight === '200');

const forceSavedSrc = clientSrc.replace(
  'status: sameSetDraft(machine.draft, confirmed) ? "saved" : "dirty",',
  'status: "saved",',
);
check('mutation setup: force-saved variant differs', forceSavedSrc !== clientSrc);
const forceMut = buildMachine(forceSavedSrc);
let fm = forceMut.initSetSaveMachine(SET);
fm = forceMut.editSetDraft(fm, { weight: '110', reps: '8', completed: false });
const fbeg = forceMut.beginSetSave(fm);
fm = forceMut.editSetDraft(fbeg.machine, { weight: '115', reps: '8', completed: false });
fm = forceMut.applySetSaveSuccess({ ...fm, seq: fbeg.seq, inflightSeq: fbeg.seq, inflightDraft: fbeg.machine.inflightDraft }, fbeg.seq);
check('mutation: forcing saved on success hides a mid-save edit', fm.status === 'saved');

// --- W-UI-001 rework (PM 2026-10-16 23:50): single-writer queue,
// business-result check, in-flight revert, finish-gate consumption ---
// These run the REAL drainSetSaves / createSaveQueue / finishGateDecision
// extracted from App.tsx against a controllable deferred transport that
// mimics updateSet's unconditional full-payload write, reproducing the
// PM counterexamples: (1) multiple waiters forking after a shared
// in-flight save so a late write overwrites the newest value; (2) a
// resolved { ok: false, forbidden: true } being marked saved, and an
// in-flight revert to the confirmed value being reported clean so a
// refetch can overwrite it; (3) flush() returning false for a blocked
// legacy set (completed, reps null, status saved) being ignored by the
// finish path.
function extractAsyncFunction(source, name) {
  const idx = source.search(new RegExp(`async function ${name}\\(`));
  if (idx < 0) throw new Error(`async function ${name} not found`);
  const openParen = source.indexOf('(', idx);
  const closeParen = matchDelim(source, openParen, '(', ')');
  const bodyStart = source.indexOf('{', closeParen);
  const bodyEnd = matchDelim(source, bodyStart, '{', '}');
  return source.slice(idx, bodyEnd + 1);
}
const QFN = [...FN, 'finishGateDecision'];
function buildQueue(src) {
  const parts = FN.map((n) => extractFunction(src, n));
  parts.push(extractAsyncFunction(src, 'drainSetSaves'));
  parts.push(extractFunction(src, 'createSaveQueue'));
  parts.push(extractFunction(src, 'finishGateDecision'));
  return new Function(`${stripTypeScriptTypes(parts.join('\n'))}\nreturn { ${[...QFN, 'drainSetSaves', 'createSaveQueue'].join(', ')} };`)();
}
const Q = buildQueue(clientSrc);
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function makeRow(QM, initialSet, sendImpl) {
  let machine = QM.initSetSaveMachine(initialSet);
  let sealed = false;
  const calls = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const env = {
    getMachine: () => machine,
    setMachine: (next) => { machine = next; },
    send: async (draft) => {
      inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
      calls.push({ ...draft });
      try { return await sendImpl(draft, calls.length); }
      finally { inFlight--; }
    },
    isSealed: () => sealed,
    onSaved: () => {},
  };
  return {
    env,
    queue: QM.createSaveQueue(env),
    edit: (draft) => { machine = QM.editSetDraft(machine, draft); },
    get machine() { return machine; },
    calls,
    get maxInFlight() { return maxInFlight; },
    seal: () => { sealed = true; },
  };
}
function deferred() {
  let resolve;
  const promise = new Promise((res) => { resolve = res; });
  return { promise, resolve };
}

check('source: finish consumes flush results via finishGateDecision', clientSrc.includes('const decision = finishGateDecision(snapshots);') && clientSrc.includes('flushOk: stable && (results[index] ?? false)'));
check('source: confirm-discard seals and settles every handle before completing', clientSrc.includes('handle.sealAndSettle()') && clientSrc.includes('confirmFinishAnyway'));
check('source: drain checks the business ok flag', clientSrc.includes('result.ok !== true'));

await (async () => {
  // (1) Fork counterexample: A=20 in flight; two more requestSave calls
  // and an edit to 30 arrive while A is pending; then a further edit to
  // 40 during the second write. Writes must stay strictly serial, the
  // waiters must share the one drain, and the last persisted value must
  // be the last input (40) — no late 30 may land after it.
  {
    const gates = [deferred(), deferred(), deferred()];
    let persisted = '100';
    const row = makeRow(Q, SET, async (draft, n) => { await gates[n - 1].promise; persisted = draft.weight; return { ok: true }; });
    row.edit({ weight: '20', reps: '8', completed: false });
    const p1 = row.queue.requestSave();
    row.edit({ weight: '30', reps: '8', completed: false });
    const p2 = row.queue.requestSave();
    const p3 = row.queue.flush();
    check('queue: concurrent callers share one drain (single write in flight)', row.calls.length === 1 && row.maxInFlight === 1);
    gates[0].resolve(); await tick();
    check('queue: after first save the drain sends the latest draft (30), not a forked duplicate', row.calls.length === 2 && row.calls[1].weight === '30');
    row.edit({ weight: '40', reps: '8', completed: false });
    gates[1].resolve(); await tick();
    check('queue: mid-drain edit is picked up by the same drain (40 next)', row.calls.length === 3 && row.calls[2].weight === '40');
    gates[2].resolve();
    const results = await Promise.all([p1, p2, p3]);
    check('queue: all waiters resolve true and final persisted value equals last input', results.every(Boolean) && persisted === '40' && row.machine.status === 'saved' && row.machine.confirmed.weight === '40', `persisted=${persisted}`);
    check('queue: writes were strictly serial throughout', row.maxInFlight === 1);
  }

  // (2a) Business rejection: resolved { ok:false, forbidden:true } must
  // fail like a thrown error — input kept, never saved, retry recovers.
  {
    let allow = false;
    let persisted = '100';
    const row = makeRow(Q, SET, async (draft) => { if (!allow) return { ok: false, forbidden: true }; persisted = draft.weight; return { ok: true }; });
    row.edit({ weight: '20', reps: '8', completed: false });
    const ok = await row.queue.requestSave();
    check('queue: resolved {ok:false} returns false, status error, draft kept, nothing persisted',
      ok === false && row.machine.status === 'error' && row.machine.draft.weight === '20' && row.machine.confirmed.weight === '100' && persisted === '100');
    allow = true;
    const retried = await row.queue.requestSave();
    check('queue: retry after rejection saves and clears error', retried === true && row.machine.status === 'saved' && persisted === '20');
  }

  // (2b) Thrown transport error takes the same failure path.
  {
    const row = makeRow(Q, SET, async () => { throw new Error('network'); });
    row.edit({ weight: '20', reps: '8', completed: false });
    const ok = await row.queue.requestSave();
    check('queue: thrown error returns false and keeps the draft as error', ok === false && row.machine.status === 'error' && row.machine.draft.weight === '20');
  }

  // (2c) In-flight revert: 10 -> save 20 in flight -> user reverts to
  // 10. The row must not read saved while the write is undecided, a
  // refetch must not adopt over it, and after the 20 lands the drain
  // must issue a compensation save so 10 is the final persisted value.
  {
    const gate = deferred();
    let persisted = '100';
    const row = makeRow(Q, { id: 7, weight: 100, reps: 8, completed: false }, async (draft, n) => { if (n === 1) await gate.promise; persisted = draft.weight; return { ok: true }; });
    row.edit({ weight: '20', reps: '8', completed: false });
    const p = row.queue.requestSave();
    row.edit({ weight: '100', reps: '8', completed: false });
    check('queue: in-flight revert to confirmed is dirty, not saved', row.machine.status === 'dirty');
    const adopted = Q.adoptServerDraft(row.machine, { weight: '999', reps: '1', completed: true });
    check('queue: refetch cannot adopt over an in-flight revert', adopted.draft.weight === '100');
    gate.resolve();
    const ok = await p;
    check('queue: compensation save persists the reverted value last', ok === true && persisted === '100' && row.calls.length === 2 && row.calls[1].weight === '100' && row.machine.status === 'saved', `persisted=${persisted} calls=${row.calls.length}`);
  }

  // (3) Blocked legacy set: completed with reps null starts saved and
  // blocked. flush must return false with zero writes, and the finish
  // decision must not proceed.
  {
    const row = makeRow(Q, { id: 9, weight: 50, reps: null, completed: true }, async () => ({ ok: true }));
    check('queue: legacy blocked set starts saved-but-blocked', row.machine.status === 'saved' && Q.setSaveBlocked(row.machine) === true);
    const flushed = await row.queue.flush();
    check('queue: flush of a blocked set returns false and writes nothing', flushed === false && row.calls.length === 0);
    const decision = Q.finishGateDecision([{ flushOk: flushed, status: row.machine.status, blocked: true, completed: true }]);
    check('finish: blocked snapshot cannot proceed silently', decision.proceed === false);
  }

  // Finish decision matrix.
  {
    const good = { flushOk: true, status: 'saved', blocked: false, completed: true };
    check('finish: all-clean batch proceeds', Q.finishGateDecision([good, good]).proceed === true);
    check('finish: flush failure is unsaved', Q.finishGateDecision([{ ...good, flushOk: false }]).reason === 'unsaved');
    check('finish: error status is unsaved', Q.finishGateDecision([{ ...good, status: 'error' }]).reason === 'unsaved');
    check('finish: blocked-only batch reports blocked', Q.finishGateDecision([{ ...good, blocked: true }]).reason === 'blocked');
    check('finish: incomplete-only batch reports incomplete', Q.finishGateDecision([{ ...good, completed: false }]).reason === 'incomplete');
    check('finish: unsaved outranks incomplete', Q.finishGateDecision([{ ...good, completed: false }, { ...good, flushOk: false }]).reason === 'unsaved');
  }

  // Seal: after sealing, no new writes are issued and queued edits stop.
  {
    const gate = deferred();
    const row = makeRow(Q, SET, async (draft, n) => { if (n === 1) await gate.promise; return { ok: true }; });
    row.edit({ weight: '20', reps: '8', completed: false });
    const p = row.queue.requestSave();
    row.edit({ weight: '30', reps: '8', completed: false });
    row.seal();
    gate.resolve();
    await p;
    const after = await row.queue.requestSave();
    check('queue: sealed queue issues no further writes', row.calls.length === 1 && after === false, `calls=${row.calls.length}`);
  }

  // Mutations: removing the ok check lets a rejection pass as saved;
  // restoring the old editSetDraft (confirmed-first) revives the
  // in-flight-revert false-clean; dropping the blocked term lets a
  // blocked batch proceed.
  const noOkSrc = clientSrc.replace('if (!result || result.ok !== true) {', 'if (!result) {');
  check('mutation setup: ok-check variant differs', noOkSrc !== clientSrc);
  const QNoOk = buildQueue(noOkSrc);
  {
    const row = makeRow(QNoOk, SET, async () => ({ ok: false, forbidden: true }));
    row.edit({ weight: '20', reps: '8', completed: false });
    const ok = await row.queue.requestSave();
    check('mutation: without the ok check a business rejection is marked saved', ok === true && row.machine.status === 'saved');
  }
  const oldEditSrc = clientSrc.replace(
    extractFunction(clientSrc, 'editSetDraft'),
    extractFunction(clientSrc, 'editSetDraft')
      .replace('  if (machine.inflightDraft) {', '  if (false) {'),
  );
  check('mutation setup: inflight-first edit variant differs', oldEditSrc !== clientSrc);
  const QOldEdit = buildQueue(oldEditSrc);
  {
    const gate = deferred();
    const row = makeRow(QOldEdit, SET, async () => { await gate.promise; return { ok: true }; });
    row.edit({ weight: '20', reps: '8', completed: false });
    void row.queue.requestSave();
    row.edit({ weight: '100', reps: '8', completed: false });
    check('mutation: confirmed-first edit logic revives the false-clean in-flight revert', row.machine.status === 'saved');
    gate.resolve(); await tick();
  }
  const noBlockedSrc = clientSrc
    .replace('&& !snapshot.blocked && snapshot.completed', '&& snapshot.completed')
    .replace('if (snapshots.some((snapshot) => snapshot.blocked)) {', 'if (snapshots.some(() => false)) {');
  check('mutation setup: blocked-term variant differs', noBlockedSrc !== clientSrc);
  const QNoBlocked = buildQueue(noBlockedSrc);
  check('mutation: without the blocked term a blocked batch proceeds',
    QNoBlocked.finishGateDecision([{ flushOk: true, status: 'saved', blocked: true, completed: true }]).proceed === true);
})();

console.log(`\n${passed} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
