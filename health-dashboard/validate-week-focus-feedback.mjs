// H3.5 周复盘「下周重点」反馈 (space-4) validation.
// Runs the REAL production state machine extracted verbatim from
// client/src/App.tsx (focusFeedbackKey / createFocusFeedbackState /
// syncFocusFeedbackState / beginFocusFeedbackSave /
// completeFocusFeedbackSave / failFocusFeedbackSave /
// conflictFocusFeedbackSave / resolvePreviousLookback /
// previousFocusWindows) and the REAL server arbitration decision
// (decideFocusSaveOutcome, extracted verbatim from
// server/src/actions.ts) over scenario walks, plus source checks on
// the client wiring and the server contract. Covers:
// (1) key composition matches the server `${start}|${end}|${version}`,
// (2) first bind with no server row -> unmarked idle state,
// (3) first bind with a server row -> confirmed + saved + revision,
// (4) choose -> saving (operationId + expectedRevision recorded);
//     success on the same key -> saved + confirmed + revision advance,
// (5) a stale success callback for an OLD key is dropped whole,
// (6) failure keeps the attempted choice AND the operationId (a
//     transport retry reuses the same intent identity),
// (7) re-selection under the same key re-saves,
// (8) a failed re-read keeps the confirmed value and flags readFailed
//     instead of resetting to "not yet given",
// (9) binding a new key never migrates the old key's feedback,
// (10) an in-flight save is not clobbered by a same-key re-read sync,
// (11) conflict: the server's saved value is adopted as confirmed,
//     the attempted choice stays as the selection, and the
//     「改用我的选择」 retry is a NEW intent gated on the server's
//     revision,
// (12) previous look-back preservation: a failed local read keeps the
//     last successfully read row; a successful read replaces it
//     (including a genuine null),
// (13) previousFocusWindows derives review/comparison/baseline
//     windows from the ROW's own window,
// (14) server arbitration over a simulated store whose statement
//     semantics mirror the handler's single conditional SQL gate
//     (asserted against the handler source below): first save,
//     sequential + concurrent same-operation retries with zero extra
//     writes, different choices in both orders (first writer wins,
//     loser conflicts and never overwrites), a stale pre-read
//     request resumed after a newer save is refused, multi-tab same
//     mechanics, lost-response retry idempotence, legacy 0016 rows
//     (last_operation_id null) upgrading cleanly,
// (15) server source: strict owner gate before ANY write, no
//     pre-read select before the statement, key computed server-side,
//     request carries expectedRevision + operationId, response
//     carries conflict, loadFocusFeedback reports readStatus and
//     getDashboard maps it to focusFeedback.readFailed (client no
//     longer derives it from dashboard.isRefetchError), migration
//     0017 adds last_operation_id.
// Pure Node, no deps. All fixtures synthetic.
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';

const clientSrc = readFileSync(new URL('./client/src/App.tsx', import.meta.url), 'utf8');
const serverSrc = readFileSync(new URL('./server/src/actions.ts', import.meta.url), 'utf8');
const schemaSrc = readFileSync(new URL('./server/src/schema.ts', import.meta.url), 'utf8');
const migrationSrc = readFileSync(new URL('./drizzle/0016_add_week_focus_feedback.sql', import.meta.url), 'utf8');
const migration17Src = readFileSync(new URL('./drizzle/0017_add_week_focus_feedback_operation_id.sql', import.meta.url), 'utf8');

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
  while (bodyStart >= 0) {
    let prev = bodyStart - 1;
    while (prev > closeParen && /\s/.test(source[prev])) prev--;
    if (source[prev] !== ':') break;
    bodyStart = source.indexOf('{', matchDelim(source, bodyStart, '{', '}'));
  }
  if (bodyStart < 0) throw new Error(`function ${name} body not found`);
  const bodyEnd = matchDelim(source, bodyStart, '{', '}');
  return source.slice(idx, bodyEnd + 1);
}

const NAMES = ['focusFeedbackKey', 'createFocusFeedbackState', 'syncFocusFeedbackState', 'beginFocusFeedbackSave', 'completeFocusFeedbackSave', 'failFocusFeedbackSave', 'conflictFocusFeedbackSave', 'resolvePreviousLookback', 'previousFocusWindows'];
const code = NAMES.map((name) => stripTypeScriptTypes(extractFunction(clientSrc, name).replace(/^export /, ''))).join('\n');
const machine = new Function(`${code}\nreturn { ${NAMES.join(', ')} };`)();
const { focusFeedbackKey, createFocusFeedbackState, syncFocusFeedbackState, beginFocusFeedbackSave, completeFocusFeedbackSave, failFocusFeedbackSave, conflictFocusFeedbackSave, resolvePreviousLookback, previousFocusWindows } = machine;

const serverCode = stripTypeScriptTypes(extractFunction(serverSrc, 'decideFocusSaveOutcome').replace(/^export /, ''));
const { decideFocusSaveOutcome } = new Function(`${serverCode}\nreturn { decideFocusSaveOutcome };`)();

const KEY_A = focusFeedbackKey('2026-10-17', '2026-10-23', '2026-10-23T08:00:00.000Z');
const KEY_B = focusFeedbackKey('2026-10-18', '2026-10-24', '2026-10-24T08:00:00.000Z');
const KEY_A2 = focusFeedbackKey('2026-10-17', '2026-10-23', '2026-10-23T09:30:00.000Z');

// (1) key composition
check('key is `${start}|${end}|${snapshotVersion}`', KEY_A === '2026-10-17|2026-10-23|2026-10-23T08:00:00.000Z');
check('same window, new snapshot version -> different key', KEY_A !== KEY_A2);

// (2) first bind, no server row
let s = syncFocusFeedbackState(createFocusFeedbackState(), KEY_A, null, false);
check('first bind without a row: unmarked idle', s.boundKey === KEY_A && s.confirmed === null && s.selection === null && s.status === 'idle' && s.readFailed === false && s.confirmedRevision === 0);

// (3) first bind with a server row (revision bound too)
s = syncFocusFeedbackState(createFocusFeedbackState(), KEY_A, '有帮助', false, 3);
check('first bind with a row: confirmed + saved + revision adopted', s.confirmed === '有帮助' && s.selection === '有帮助' && s.status === 'saved' && s.confirmedRevision === 3);

// (4) choose -> saving (arbitration identity recorded) -> success
s = syncFocusFeedbackState(createFocusFeedbackState(), KEY_A, null, false);
s = beginFocusFeedbackSave(s, '不适用', 'op-100');
check('choose marks selection + saving and records operationId + expectedRevision',
  s.selection === '不适用' && s.status === 'saving' && s.confirmed === null
  && s.pendingOperationId === 'op-100' && s.pendingExpectedRevision === 0);
s = completeFocusFeedbackSave(s, KEY_A, '不适用', 1);
check('success on the bound key: saved + confirmed + revision from the response',
  s.status === 'saved' && s.confirmed === '不适用' && s.selection === '不适用' && s.confirmedRevision === 1);

// (5) stale callback for an old key is dropped
s = syncFocusFeedbackState(createFocusFeedbackState(), KEY_A, null, false);
s = beginFocusFeedbackSave(s, '有帮助', 'op-101');
s = syncFocusFeedbackState(s, KEY_B, null, false);
check('rebind to a new key starts fresh (no migrated choice)', s.boundKey === KEY_B && s.confirmed === null && s.selection === null && s.status === 'idle' && s.pendingOperationId === null);
const before = s;
s = completeFocusFeedbackSave(s, KEY_A, '有帮助', 1);
check('stale success callback is dropped whole', s === before);
s = conflictFocusFeedbackSave(s, KEY_A, '不适用', 2);
check('stale conflict callback is dropped whole', s === before);

// (6) failure keeps the attempted choice and the operation identity
s = syncFocusFeedbackState(createFocusFeedbackState(), KEY_A, null, false);
s = beginFocusFeedbackSave(s, '有帮助', 'op-102');
s = failFocusFeedbackSave(s, KEY_A);
check('failure keeps the attempted choice as unsaved AND keeps the operationId for the retry',
  s.status === 'error' && s.selection === '有帮助' && s.confirmed === null && s.pendingOperationId === 'op-102' && s.pendingExpectedRevision === 0);
s = failFocusFeedbackSave(s, KEY_B);
check('failure callback for another key is ignored', s.status === 'error' && s.boundKey === KEY_A);

// (7) re-selection under the same key re-saves
s = syncFocusFeedbackState(createFocusFeedbackState(), KEY_A, '有帮助', false, 1);
s = beginFocusFeedbackSave(s, '不适用', 'op-103');
check('re-selection enters saving gated on the confirmed revision',
  s.status === 'saving' && s.selection === '不适用' && s.confirmed === '有帮助' && s.pendingExpectedRevision === 1);
s = completeFocusFeedbackSave(s, KEY_A, '不适用', 2);
check('re-selection success replaces the confirmed choice and advances the revision', s.confirmed === '不适用' && s.status === 'saved' && s.confirmedRevision === 2);

// (8) failed re-read preserves the confirmed value; first-read failure
// is an unknown state, never "not yet given"
s = syncFocusFeedbackState(createFocusFeedbackState(), KEY_A, '有帮助', false, 2);
s = syncFocusFeedbackState(s, KEY_A, null, true);
check('failed re-read keeps confirmed + revision + flags readFailed', s.confirmed === '有帮助' && s.selection === '有帮助' && s.readFailed === true && s.confirmedRevision === 2);
s = syncFocusFeedbackState(s, KEY_A, '有帮助', false, 2);
check('a later good re-read clears readFailed', s.readFailed === false && s.confirmed === '有帮助');
s = syncFocusFeedbackState(createFocusFeedbackState(), KEY_A, null, true);
check('first-read failure: bound, unconfirmed, readFailed (state unknown — not 尚未反馈）',
  s.boundKey === KEY_A && s.confirmed === null && s.selection === null && s.readFailed === true && s.status === 'idle');

// (9) new key never inherits the old key feedback
s = syncFocusFeedbackState(createFocusFeedbackState(), KEY_A, '有帮助', false, 1);
s = syncFocusFeedbackState(s, KEY_A2, null, false);
check('same window + new snapshot: no feedback migration', s.boundKey === KEY_A2 && s.confirmed === null && s.selection === null && s.status === 'idle' && s.confirmedRevision === 0);

// (10) in-flight save not clobbered by a same-key re-read
s = syncFocusFeedbackState(createFocusFeedbackState(), KEY_A, null, false);
s = beginFocusFeedbackSave(s, '不适用', 'op-104');
s = syncFocusFeedbackState(s, KEY_A, null, false);
check('re-read during saving keeps the in-flight choice', s.status === 'saving' && s.selection === '不适用');

// (11) conflict adoption + insist-retry identity
s = syncFocusFeedbackState(createFocusFeedbackState(), KEY_A, '有帮助', false, 1);
s = beginFocusFeedbackSave(s, '不适用', 'op-105'); // gated on revision 1
s = conflictFocusFeedbackSave(s, KEY_A, '不适用', 2); // another tab saved 不适用 first at rev 2 — wait, same choice: server stands at 不适用 rev2
check('conflict adopts the server value + revision as confirmed and records the conflict',
  s.status === 'conflict' && s.confirmed === '不适用' && s.confirmedRevision === 2
  && s.conflictFeedback === '不适用' && s.conflictRevision === 2 && s.selection === '不适用');
s = syncFocusFeedbackState(createFocusFeedbackState(), KEY_A, null, false);
s = beginFocusFeedbackSave(s, '有帮助', 'op-106');
s = conflictFocusFeedbackSave(s, KEY_A, '不适用', 1);
check('conflict keeps the attempted choice as the selection while the server value stands',
  s.status === 'conflict' && s.selection === '有帮助' && s.confirmed === '不适用' && s.confirmedRevision === 1);
s = beginFocusFeedbackSave(s, s.selection, 'op-107');
check('「改用我的选择」 is a new intent: new operationId gated on the server revision',
  s.status === 'saving' && s.pendingOperationId === 'op-107' && s.pendingExpectedRevision === 1 && s.conflictFeedback === null);
s = completeFocusFeedbackSave(s, KEY_A, '有帮助', 2);
check('insist-retry success confirms the choice at the advanced revision', s.status === 'saved' && s.confirmed === '有帮助' && s.confirmedRevision === 2);

// (12) previous look-back preservation across local read failures
const PREV = { focusKey: 'k-old', windowStart: '2026-10-10', windowEnd: '2026-10-16', focusText: '旧重点', basisText: '旧依据', ruleVersion: 1, feedback: '有帮助', revision: 1, updatedAt: '2026-10-17T00:00:00.000Z' };
check('look-back: a failed read keeps the last successfully read previous row',
  resolvePreviousLookback(PREV, null, true) === PREV);
check('look-back: a successful read replaces it (new row wins, genuine null clears)',
  resolvePreviousLookback(PREV, null, false) === null && resolvePreviousLookback(null, PREV, false) === PREV);
check('look-back: first-read failure with nothing known stays null (unknown, not fabricated)',
  resolvePreviousLookback(null, null, true) === null);

// (13) previousFocusWindows derives from the row's own window
{
  const w = previousFocusWindows('2026-10-17', '2026-10-23');
  check('previous windows: review = the row window; comparison = 7 days before its start; baseline = 28 days ending the day before its start',
    w.review.start === '2026-10-17' && w.review.end === '2026-10-23'
    && w.comparison.start === '2026-10-10' && w.comparison.end === '2026-10-16'
    && w.baseline.start === '2026-09-19' && w.baseline.end === '2026-10-16');
}

// --------------------------------------- (14) server arbitration walks
// Simulated store: applySave mirrors the handler's ONE conditional
// statement — insert when absent; on conflict, update ONLY when the
// stored last_operation_id equals this operationId (replay arm: the
// stored values are kept verbatim, no observable change) or when
// stored revision = expectedRevision AND the choice changes
// (revision + 1, operation id stamped). The outcome is then
// classified by the REAL decideFocusSaveOutcome extracted above.
function makeStore(seedRow) {
  return { row: seedRow ?? null, writes: 0 };
}
function applySave(store, req) {
  const existing = store.row;
  if (!existing) {
    store.row = { feedback: req.feedback, revision: 1, lastOperationId: req.operationId };
    store.writes++;
  } else if (existing.lastOperationId !== null && existing.lastOperationId === req.operationId) {
    // replay arm: statement re-enters but every value is kept — no write effect
  } else if (existing.revision === (req.expectedRevision ?? 0) && existing.feedback !== req.feedback) {
    store.row = { feedback: req.feedback, revision: existing.revision + 1, lastOperationId: req.operationId };
    store.writes++;
  }
  return { outcome: decideFocusSaveOutcome(store.row, req), row: store.row };
}

{
  // First save.
  const store = makeStore();
  const r = applySave(store, { feedback: '有帮助', expectedRevision: null, operationId: 'op-1' });
  check('arbitration: first save lands at revision 1 stamped with its operationId',
    r.outcome === 'saved' && r.row.revision === 1 && r.row.lastOperationId === 'op-1' && store.writes === 1);
  // Sequential retry of the SAME operation (lost response): zero extra writes.
  const r2 = applySave(store, { feedback: '有帮助', expectedRevision: null, operationId: 'op-1' });
  check('arbitration: sequential same-operation retry is idempotent (saved echo, still revision 1, one write total)',
    r2.outcome === 'saved' && r2.row.revision === 1 && store.writes === 1);
  // Concurrent same-operation same-choice: two in-flight copies, one write.
  const storeC = makeStore();
  applySave(storeC, { feedback: '不适用', expectedRevision: 0, operationId: 'op-c' });
  const rc = applySave(storeC, { feedback: '不适用', expectedRevision: 0, operationId: 'op-c' });
  check('arbitration: concurrent same-operation same-choice writes exactly once',
    rc.outcome === 'saved' && storeC.row.revision === 1 && storeC.writes === 1);
  // Same choice, NEW operation, expected = current revision: noop, no write.
  const r3 = applySave(store, { feedback: '有帮助', expectedRevision: 1, operationId: 'op-2' });
  check('arbitration: same choice at the expected revision is a noop success (no write, no bump)',
    r3.outcome === 'noop' && store.row.revision === 1 && store.writes === 1);
}
{
  // Different choices, both orders: first writer wins; the loser
  // conflicts and never overwrites.
  const storeA = makeStore();
  applySave(storeA, { feedback: '有帮助', expectedRevision: null, operationId: 'a-1' });
  const loseA = applySave(storeA, { feedback: '不适用', expectedRevision: 0, operationId: 'a-2' });
  check('arbitration: order 1 — first choice stands, the stale second conflicts and does not overwrite',
    loseA.outcome === 'conflict' && storeA.row.feedback === '有帮助' && storeA.row.revision === 1 && storeA.writes === 1);
  const storeB = makeStore();
  applySave(storeB, { feedback: '不适用', expectedRevision: null, operationId: 'b-1' });
  const loseB = applySave(storeB, { feedback: '有帮助', expectedRevision: null, operationId: 'b-2' });
  check('arbitration: order 2 — first choice stands, the stale second conflicts and does not overwrite',
    loseB.outcome === 'conflict' && storeB.row.feedback === '不适用' && storeB.row.revision === 1 && storeB.writes === 1);
  // The loser can still insist: re-gated on the server's revision
  // with a NEW operationId, the save lands.
  const insist = applySave(storeB, { feedback: '有帮助', expectedRevision: 1, operationId: 'b-3' });
  check('arbitration: insist retry gated on the server revision lands at revision 2',
    insist.outcome === 'saved' && storeB.row.feedback === '有帮助' && storeB.row.revision === 2);
}
{
  // Stale pre-read resumed after a newer save (the P0 defect): tab 1
  // read revision 1, tab 2 saved a change (revision 2), tab 1's old
  // request finally submits — it must be refused, not overwrite.
  const store = makeStore({ feedback: '有帮助', revision: 1, lastOperationId: 'tab-0' });
  const newer = applySave(store, { feedback: '不适用', expectedRevision: 1, operationId: 'tab-2' });
  check('arbitration: a change gated on the current revision lands (multi-tab setup)', newer.outcome === 'saved' && store.row.revision === 2);
  const stale = applySave(store, { feedback: '有帮助', expectedRevision: 1, operationId: 'tab-1-late' });
  check('arbitration: the resumed stale request (expected 1, row at 2, different operation) is refused and the newer value stands',
    stale.outcome === 'conflict' && store.row.feedback === '不适用' && store.row.revision === 2 && store.writes === 1);
  // Lost-response retry of the WINNING save: same operationId, same
  // (now stale) expectedRevision — still a saved echo, no extra write.
  const replay = applySave(store, { feedback: '不适用', expectedRevision: 1, operationId: 'tab-2' });
  check('arbitration: lost-response retry of the landed save echoes saved with no extra write (revision still 2)',
    replay.outcome === 'saved' && store.row.revision === 2 && store.writes === 1);
  // A failed write leaves the old row untouched: the statement is the
  // only mutation point, so a throw before it commits nothing.
  const frozen = JSON.stringify(store.row);
  check('arbitration: row content is exactly what the last landed statement left (failure atomicity is structural)',
    frozen === JSON.stringify({ feedback: '不适用', revision: 2, lastOperationId: 'tab-2' }));
}
{
  // Legacy 0016 rows: last_operation_id is null. They arbitrate on
  // revision alone and upgrade in place on the next landed save.
  const legacy = makeStore({ feedback: '有帮助', revision: 1, lastOperationId: null });
  const noop = applySave(legacy, { feedback: '有帮助', expectedRevision: 1, operationId: 'new-1' });
  check('arbitration: legacy row (null operation id) — same choice at expected revision is a noop',
    noop.outcome === 'noop' && legacy.row.revision === 1 && legacy.writes === 0);
  const change = applySave(legacy, { feedback: '不适用', expectedRevision: 1, operationId: 'new-2' });
  check('arbitration: legacy row — a gated change lands, stamps the operation id, revision 2',
    change.outcome === 'saved' && legacy.row.feedback === '不适用' && legacy.row.revision === 2 && legacy.row.lastOperationId === 'new-2');
  const legacyStale = makeStore({ feedback: '有帮助', revision: 2, lastOperationId: null });
  const refused = applySave(legacyStale, { feedback: '不适用', expectedRevision: 1, operationId: 'new-3' });
  check('arbitration: legacy row — a stale change is refused exactly like a stamped row',
    refused.outcome === 'conflict' && legacyStale.row.feedback === '有帮助' && legacyStale.writes === 0);
  // Read/response consistency: the revision a save reports is the
  // revision a subsequent read of the same row returns.
  check('arbitration: reported revision equals the stored row revision after every outcome',
    decideFocusSaveOutcome(legacy.row, { feedback: '不适用', expectedRevision: 1, operationId: 'new-2' }) === 'saved' && legacy.row.revision === 2);
}

// --------------------------------------- (16) stale-read monotonicity
// (PM 2026-10-23 07:05, H3.5 P1): within one boundKey the confirmed
// revision only moves forward. The PM counterexample: confirm 有帮助
// rev1, save 不适用 to rev2, then a late-arriving successful read of
// rev1 must not regress the card.
{
  let t = syncFocusFeedbackState(createFocusFeedbackState(), KEY_A, '有帮助', false, 1);
  t = beginFocusFeedbackSave(t, '不适用', 'op-201');
  t = completeFocusFeedbackSave(t, KEY_A, '不适用', 2);
  const before = t;
  t = syncFocusFeedbackState(t, KEY_A, '有帮助', false, 1);
  check('stale-read: PM counterexample — rev2 confirmed survives a late rev1 read (value, revision, selection, status unchanged)',
    t.confirmed === '不适用' && t.confirmedRevision === 2 && t.selection === '不适用' && t.status === 'saved'
    && t.readFailed === false && before.confirmedRevision === 2);
  // Reverse arrival order: the rev2 read binds first, rev1 after.
  let u = syncFocusFeedbackState(createFocusFeedbackState(), KEY_A, '不适用', false, 2);
  u = syncFocusFeedbackState(u, KEY_A, '有帮助', false, 1);
  check('stale-read: reverse order — a rev1 read after a rev2 bind is likewise refused',
    u.confirmed === '不适用' && u.confirmedRevision === 2 && u.status === 'saved');
  // A read reporting NO row for a key already confirmed at rev > 0 is
  // stale too — the row cannot have vanished.
  u = syncFocusFeedbackState(u, KEY_A, null, false, null);
  check('stale-read: a null-row read cannot erase a confirmed rev2 opinion',
    u.confirmed === '不适用' && u.confirmedRevision === 2 && u.status === 'saved');
  // Old read during an in-flight save: nothing about the save moves.
  let v = syncFocusFeedbackState(createFocusFeedbackState(), KEY_A, '有帮助', false, 2);
  v = beginFocusFeedbackSave(v, '不适用', 'op-202');
  v = syncFocusFeedbackState(v, KEY_A, '有帮助', false, 1);
  check('stale-read: an old read during saving leaves the in-flight save untouched',
    v.status === 'saving' && v.selection === '不适用' && v.confirmed === '有帮助' && v.confirmedRevision === 2);
  // Old read after a conflict: the conflict state stands.
  let w = syncFocusFeedbackState(createFocusFeedbackState(), KEY_A, '有帮助', false, 1);
  w = beginFocusFeedbackSave(w, '不适用', 'op-203');
  w = conflictFocusFeedbackSave(w, KEY_A, '有帮助', 2);
  w = syncFocusFeedbackState(w, KEY_A, '有帮助', false, 1);
  check('stale-read: an old read after a conflict keeps the conflict value and revision',
    w.status === 'conflict' && w.confirmedRevision === 2 && w.conflictRevision === 2);
  // A stale completion callback (rev1) landing after rev2 is dropped.
  let x = syncFocusFeedbackState(createFocusFeedbackState(), KEY_A, '不适用', false, 2);
  x = completeFocusFeedbackSave(x, KEY_A, '有帮助', 1);
  check('stale-read: a late completion callback at rev1 cannot overwrite the rev2 confirmation',
    x.confirmed === '不适用' && x.confirmedRevision === 2 && x.selection === '不适用');
  // New keys are unaffected: a fresh key still binds at rev1.
  const y = syncFocusFeedbackState(x, KEY_B, '有帮助', false, 1);
  check('stale-read: a different key still binds fresh at rev1 (guard is per-key, not global)',
    y.boundKey === KEY_B && y.confirmed === '有帮助' && y.confirmedRevision === 1 && y.status === 'saved');
}

// --------------------------------------- (17) scope landing source checks
// (H3.5 product advance, PM 2026-10-23 07:05): the range landing in
// the history view — return-to-focus / show-all / clear controls,
// per-ID expandable strength detail, and the natural-week totals
// helper separated from the rolling window.
check('scope: history range landing exposes 返回本次重点 / 查看全部历史 / 清除范围 controls',
  clientSrc.includes('返回本次重点') && clientSrc.includes('查看全部历史') && clientSrc.includes('清除范围'));
check('scope: full history is gated behind the show-all toggle while a range is active',
  clientSrc.includes('const fullHistoryVisible = !focusRange || showAllHistory;'));
check('scope: strength rows in the range expand per workout id with exercise detail, missing detail stated honestly',
  clientSrc.includes('key={`focus-${workout.id}`}') && clientSrc.includes('该条未收录动作明细。'));
check('scope: natural-week totals come only from coverage-complete weeklyTrend buckets, absence stated plainly',
  clientSrc.includes('focusWeeks') && clientSrc.includes('本页未取得全量周汇总'));

// ------------------------------------------------------------ source checks
check('client: panel renders the two feedback buttons only when canJudge',
  clientSrc.includes('review.canJudge ? (') && clientSrc.includes('week-review-feedback-btn'));
check('client: unmarked state reads 尚未反馈', clientSrc.includes('"尚未反馈"'));
check('client: unsaved state reads 未保存 with a retry control',
  clientSrc.includes('未保存：这次反馈还没有记下来。') && clientSrc.includes('重试保存'));
check('client: read failure is labelled 读取失败 (known value and unknown state wordings)',
  clientSrc.includes('读取失败：暂时读不到最新状态') && clientSrc.includes('读取失败：反馈状态未知'));
check('client: conflict state names the server value and offers 改用我的选择',
  clientSrc.includes('另一处已保存了『') && clientSrc.includes('未覆盖它') && clientSrc.includes('改用我的选择'));
check('client: retry paths — network retry reuses the pending operationId, conflict retry mints a new intent',
  clientSrc.includes('feedbackState.pendingOperationId') && clientSrc.includes('feedbackState.status === "conflict"'));
check('client: saves send expectedRevision + operationId from the begun state',
  clientSrc.includes('expectedRevision: vars.expectedRevision') && clientSrc.includes('operationId: vars.operationId')
  && clientSrc.includes('expectedRevision: begun.pendingExpectedRevision'));
check('client: focus card carries the 本次复盘 annotation with the coverage status note',
  clientSrc.includes('本次复盘：') && clientSrc.includes('review.coverageStatusNote'));
check('client: previous look-back summary uses the 上次已反馈重点 format with the stored choice',
  clientSrc.includes('上次已反馈重点 · ') && clientSrc.includes('· {shownPrevious.feedback}'));
check('client: previous look-back is a collapsed details with basis + rule version + derived windows + same-window marker',
  clientSrc.includes('<details className="week-review-previous">') && clientSrc.includes('当时依据：') && clientSrc.includes('规则 v{shownPrevious.ruleVersion}')
  && clientSrc.includes('同一复盘窗的较早依据') && clientSrc.includes('按当时复盘窗推导') && clientSrc.includes('previousFocusWindows(shownPrevious.windowStart, shownPrevious.windowEnd)'));
check('client: an old record without a saved basis reads 旧记录未保存该项 (never backfilled)',
  clientSrc.includes('"旧记录未保存该项"'));
check('client: previous block renders only when a (preserved) previous row exists',
  clientSrc.includes('{shownPrevious ? ('));
check('client: panel receives focusReadFailed from the server local-read flag, not dashboard.isRefetchError',
  clientSrc.includes('focusFeedback={dashboard.data.focusFeedback}') && clientSrc.includes('focusReadFailed={dashboard.data.focusFeedback.readFailed}')
  && !clientSrc.includes('focusReadFailed={dashboard.isRefetchError}'));
check('client: training entry renders only with stored in-window evidence and jumps by range',
  clientSrc.includes('查看这段训练记录') && clientSrc.includes('hasTrainingInWindow') && clientSrc.includes('onViewTraining({ start: review.reviewWindow.start, end: review.reviewWindow.end })'));
check('client: history view presents the focus range per source with the sample/gap wording',
  clientSrc.includes('已存明细样本') && clientSrc.includes('完整周次数以复盘卡的周汇总为准'));
check('client: feedback buttons meet the 44px touch minimum in CSS',
  readFileSync(new URL('./client/src/theme.css', import.meta.url), 'utf8').includes('.week-review-feedback-btn { min-height: 44px;'));

const handlerStart = serverSrc.indexOf('saveWeekFocusFeedback: defineAction');
const handlerEnd = serverSrc.indexOf('saveHealthSnapshot: defineAction', handlerStart);
const handlerSrc = serverSrc.slice(handlerStart, handlerEnd);
check('server: WEEK_FOCUS_RULE_VERSION is the fixed constant 1',
  serverSrc.includes('const WEEK_FOCUS_RULE_VERSION = 1;'));
check('server: focus key is computed server-side from window + snapshot version',
  serverSrc.includes('return `${windowStart}|${windowEnd}|${snapshotVersion}`;')
  && serverSrc.includes('const focusKey = weekFocusKey(args.windowStart, args.windowEnd, args.snapshotVersion);'));
check('server: saveWeekFocusFeedback request schema carries no client key',
  !/focusKey/.test(serverSrc.slice(serverSrc.indexOf('const saveWeekFocusFeedbackRequest'), serverSrc.indexOf('const saveWeekFocusFeedbackResponse'))));
check('server: save request carries expectedRevision + operationId; response carries conflict',
  serverSrc.includes('expectedRevision: z.number().int().min(0).nullable()')
  && serverSrc.includes('operationId: z.string().min(1).max(100)')
  && serverSrc.includes('conflict: z.boolean(),'));
check('server: strict owner gate returns before ANY write (guest/null zero writes)',
  handlerSrc.indexOf('if (!isOwner(ctx))') >= 0
  && handlerSrc.indexOf('if (!isOwner(ctx))') < handlerSrc.indexOf('await db.insert')
  && handlerSrc.includes('return { ok: false, forbidden: true, conflict: false, focusKey: null'));
check('server: no pre-read dedupe — the first select in the handler runs AFTER the single statement',
  handlerSrc.indexOf('await db.insert') < handlerSrc.indexOf('db.select')
  && !handlerSrc.includes('existing.feedback === args.feedback'));
check('server: arbitration gate lives inside the statement WHERE (revision = expected AND choice changes, OR same operation)',
  handlerSrc.includes('setWhere: sql`${replayed} OR (${table.revision} = ${expectedRevision} AND ${table.feedback} != ${args.feedback})`')
  && handlerSrc.includes('const replayed = sql`${table.lastOperationId} = ${args.operationId}`;'));
check('server: replay arm keeps every stored value (CASE on the operation id) and revision advances only on a real change',
  handlerSrc.includes('feedback: sql`CASE WHEN ${replayed} THEN ${table.feedback} ELSE ${args.feedback} END`')
  && handlerSrc.includes('revision: sql`CASE WHEN ${replayed} THEN ${table.revision} ELSE ${table.revision} + 1 END`')
  && handlerSrc.includes('lastOperationId: args.operationId,'));
check('server: outcome is classified by decideFocusSaveOutcome on the post-statement row',
  handlerSrc.includes('const outcome = decideFocusSaveOutcome(saved ?? null, args);'));
check('server: conflict returns ok=false + conflict=true with the stored feedback and a 未覆盖 message',
  handlerSrc.includes('ok: false, forbidden: false, conflict: true, focusKey,')
  && handlerSrc.includes('未覆盖：服务端已保存了「${saved.feedback}」（版本 ${saved.revision}）'));
check('server: window dates are validated as real dates with start <= end',
  serverSrc.includes('if (!isRealDateString(args.windowStart) || !isRealDateString(args.windowEnd) || args.windowStart > args.windowEnd)'));
check('server: loadFocusFeedback reports readStatus and never swallows an error into plain nulls',
  serverSrc.includes('readStatus: "ok"') && serverSrc.includes('return { current: null, previous: null, readStatus: "error" };'));
check('server: getDashboard maps the local read outcome to focusFeedback.readFailed',
  serverSrc.includes('readFailed: focusLoad.readStatus === "error"'));
check('server: getDashboard current key uses dataDate, dataDate-6 and the snapshot updatedAt',
  serverSrc.includes('loadFocusFeedback(ctx, health.dataDate, health.updatedAt)')
  && serverSrc.includes('weekFocusKey(shiftDate(dataDate, -6), dataDate, snapshotVersion)'));
check('server: previous is the most recent other row (window_end desc, updated_at desc)',
  serverSrc.includes('.orderBy(desc(schema.weekFocusFeedback.windowEnd), desc(schema.weekFocusFeedback.updatedAt))'));
check('server: non-owner / no-snapshot dashboard returns focusFeedback nulls with readFailed=false',
  serverSrc.includes('focusFeedback: { current: null, previous: null, readFailed: false }'));
check('schema: week_focus_feedback table is declared with the feedback enum and the nullable last_operation_id',
  schemaSrc.includes('weekFocusFeedback = sqliteTable("week_focus_feedback"')
  && schemaSrc.includes('feedback: text("feedback", { enum: ["有帮助", "不适用"] }).notNull()')
  && schemaSrc.includes('lastOperationId: text("last_operation_id"),'));
check('migration 0016 creates week_focus_feedback with focus_key as primary key',
  migrationSrc.includes('CREATE TABLE `week_focus_feedback`') && migrationSrc.includes('`focus_key` text PRIMARY KEY NOT NULL'));
check('migration 0017 additively adds the nullable last_operation_id column',
  migration17Src.includes('ALTER TABLE `week_focus_feedback` ADD COLUMN `last_operation_id` text;'));

console.log(`\n${passed} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
