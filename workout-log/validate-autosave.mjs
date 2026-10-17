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

console.log(`\n${passed} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
