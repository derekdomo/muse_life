// H-FRESH-001 · PHASE-1 (space-4) validation.
// Runs the REAL production sync stage machine extracted verbatim from
// client/src/App.tsx (beginSyncAttempt / applySyncDispatchResult /
// applySyncTaskEnd / applySyncReadback / syncAttemptSourceLabel) over
// synthetic timestamp fixtures. The rule under test: "confirmed-new"
// requires STRICT temporal evidence — the read-back stamp must parse
// and be strictly later than the source's taskEndStamp, AND the
// source's read-back updatedAt must parse and be strictly later than
// the attempt baseline. Anything weaker (older / equal / missing /
// unparseable stamps, a failed read, a same-version read-back) keeps
// the source "unconfirmed": the page keeps showing the last
// successful data, never a dressed-up new save.
// Covers: the happy path; old / missing / garbage read stamps;
// old / missing / garbage / equal updatedAt; same-stamp reads;
// failed reads; per-source independence (each source judged against
// its OWN baseline and task-end stamp, in different completion
// orders); dispatch refusal; task failure; poll timeout (unknown
// status -> unconfirmed, never failed, never confirmed); completed
// but contract-unsatisfied -> failed; a late response from an OLD
// attempt never confirming a new attempt; a read-back that arrives
// before the task ends never confirming (refresh race), with the
// confirming read being a LATER one. This validates the pure state
// machine only — it is not a React/query timing measurement.
// All timestamps are invented ISO strings.
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

const NAMES = ['beginSyncAttempt', 'applySyncDispatchResult', 'applySyncTaskEnd', 'applySyncReadback', 'syncAttemptSourceLabel', 'updatedLabel'];
const code = NAMES.map((name) => stripTypeScriptTypes(extractFunction(clientSrc, name).replace(/^export /, ''))).join('\n');
const machine = new Function(`${code}\nreturn { ${NAMES.join(', ')} };`)();
const { beginSyncAttempt, applySyncDispatchResult, applySyncTaskEnd, applySyncReadback, syncAttemptSourceLabel } = machine;

// ------------------------------------------------------------ fixtures
// Timeline (all invented): baseline versions at 08:00, attempt opens
// 09:00, health task ends 09:05 (taskEndStamp = the dashboard read
// stamp current then), strength task ends 09:09.
const BASE_H = '2031-05-01T08:00:00.000Z';
const BASE_S = '2031-05-01T08:00:00.000Z';
const END_H = '2031-05-01T09:05:00.000Z';
const END_S = '2031-05-01T09:09:00.000Z';
const READ_AFTER_H = '2031-05-01T09:06:00.000Z'; // after health end, before strength end
const READ_AFTER_BOTH = '2031-05-01T09:10:00.000Z';
const NEW_H = '2031-05-01T09:02:00.000Z'; // health's own new version (its read began during the task)
const NEW_S = '2031-05-01T09:07:00.000Z';

function openAttempt() {
  let s = beginSyncAttempt(null, 'attempt-1', { health: BASE_H, strength: BASE_S });
  s = applySyncDispatchResult(s, 'attempt-1', 'health', { accepted: true });
  s = applySyncDispatchResult(s, 'attempt-1', 'strength', { accepted: true });
  return s;
}
function healthUnconfirmed() {
  return applySyncTaskEnd(openAttempt(), 'attempt-1', 'health', { status: 'completed', contractSatisfied: true }, END_H);
}
const stage = (s, source) => s.sources[source].stage;

// ------------------------------------------------------------ happy path
{
  let s = healthUnconfirmed();
  check('task end alone never confirms: health lands in unconfirmed with its task-end stamp',
    stage(s, 'health') === 'unconfirmed' && s.sources.health.taskEndStamp === END_H);
  s = applySyncReadback(s, 'attempt-1', 'health', { ok: true, updatedAt: NEW_H, stamp: READ_AFTER_H });
  check('happy path: fresh read (stamp > taskEnd) + advanced updatedAt (> baseline) -> confirmed-new with the source own new timestamp',
    stage(s, 'health') === 'confirmed-new' && s.sources.health.confirmedUpdatedAt === NEW_H);
  check('label: confirmed-new carries the 已保存新版本 wording',
    syncAttemptSourceLabel(s.sources.health).startsWith('已保存新版本'));
}

// ------------------------------------------------------------ weak stamps stay unconfirmed
{
  const cases = [
    ['read stamp OLDER than taskEnd (different string, advanced updatedAt)', { ok: true, updatedAt: NEW_H, stamp: '2031-05-01T09:04:00.000Z' }],
    ['read stamp EQUAL to taskEnd (same-stamp read)', { ok: true, updatedAt: NEW_H, stamp: END_H }],
    ['read stamp missing (null)', { ok: true, updatedAt: NEW_H, stamp: null }],
    ['read stamp unparseable garbage', { ok: true, updatedAt: NEW_H, stamp: 'not-a-timestamp' }],
    ['updatedAt missing (null) with a fresh read stamp', { ok: true, updatedAt: null, stamp: READ_AFTER_H }],
    ['updatedAt unparseable garbage with a fresh read stamp', { ok: true, updatedAt: 'garbage', stamp: READ_AFTER_H }],
    ['updatedAt EQUAL to baseline (same version) with a fresh read stamp', { ok: true, updatedAt: BASE_H, stamp: READ_AFTER_H }],
    ['updatedAt OLDER than baseline with a fresh read stamp', { ok: true, updatedAt: '2031-05-01T07:00:00.000Z', stamp: READ_AFTER_H }],
    ['failed read (ok=false) with otherwise perfect stamps', { ok: false, updatedAt: NEW_H, stamp: READ_AFTER_H }],
  ];
  for (const [name, readback] of cases) {
    const s = applySyncReadback(healthUnconfirmed(), 'attempt-1', 'health', readback);
    check(`unconfirmed: ${name}`, stage(s, 'health') === 'unconfirmed' && s.sources.health.confirmedUpdatedAt === null);
  }
  check('label: unconfirmed says 任务已结束，保存结果待确认 (never a new save)',
    syncAttemptSourceLabel(healthUnconfirmed().sources.health) === '任务已结束，保存结果待确认');
  // No task-end stamp at all -> ordering can never be proven.
  const noStamp = applySyncTaskEnd(openAttempt(), 'attempt-1', 'health', { status: 'completed', contractSatisfied: true }, null);
  const after = applySyncReadback(noStamp, 'attempt-1', 'health', { ok: true, updatedAt: NEW_H, stamp: READ_AFTER_H });
  check('unconfirmed: a missing taskEndStamp can never be strictly exceeded',
    stage(after, 'health') === 'unconfirmed');
  // Baseline edge cases: no baseline (first-ever data) confirms on a
  // parseable updatedAt + fresh stamp; an unparseable baseline blocks.
  let first = beginSyncAttempt(null, 'attempt-first', { health: null, strength: null });
  first = applySyncDispatchResult(first, 'attempt-first', 'health', { accepted: true });
  first = applySyncTaskEnd(first, 'attempt-first', 'health', { status: 'completed', contractSatisfied: true }, END_H);
  first = applySyncReadback(first, 'attempt-first', 'health', { ok: true, updatedAt: NEW_H, stamp: READ_AFTER_H });
  check('baseline null (no previous version): parseable updatedAt + fresh stamp confirms',
    stage(first, 'health') === 'confirmed-new');
  let badBase = beginSyncAttempt(null, 'attempt-badbase', { health: 'junk-baseline', strength: null });
  badBase = applySyncDispatchResult(badBase, 'attempt-badbase', 'health', { accepted: true });
  badBase = applySyncTaskEnd(badBase, 'attempt-badbase', 'health', { status: 'completed', contractSatisfied: true }, END_H);
  badBase = applySyncReadback(badBase, 'attempt-badbase', 'health', { ok: true, updatedAt: NEW_H, stamp: READ_AFTER_H });
  check('baseline unparseable: strict exceedance is unprovable -> unconfirmed',
    stage(badBase, 'health') === 'unconfirmed');
}

// ------------------------------------------------------------ per-source independence
{
  // Strength ends LATER than health. A read stamped between the two
  // task ends can confirm health but must not confirm strength.
  let s = openAttempt();
  s = applySyncTaskEnd(s, 'attempt-1', 'health', { status: 'completed', contractSatisfied: true }, END_H);
  s = applySyncTaskEnd(s, 'attempt-1', 'strength', { status: 'completed', contractSatisfied: true }, END_S);
  const mid = applySyncReadback(s, 'attempt-1', 'strength', { ok: true, updatedAt: NEW_S, stamp: READ_AFTER_H });
  check('independence: a read stamped after health end but BEFORE strength end does not confirm strength',
    stage(mid, 'strength') === 'unconfirmed');
  const both = applySyncReadback(mid, 'attempt-1', 'health', { ok: true, updatedAt: NEW_H, stamp: READ_AFTER_H });
  check('independence: the same read DOES confirm health (its own task ended earlier)',
    stage(both, 'health') === 'confirmed-new' && stage(both, 'strength') === 'unconfirmed');
  const done = applySyncReadback(both, 'attempt-1', 'strength', { ok: true, updatedAt: NEW_S, stamp: READ_AFTER_BOTH });
  check('independence: strength confirms only on a read after ITS task end, against ITS baseline',
    stage(done, 'strength') === 'confirmed-new' && done.sources.strength.confirmedUpdatedAt === NEW_S);
  // Reverse completion order: strength first, health still waiting —
  // health is untouched by strength's whole lifecycle.
  let r = openAttempt();
  r = applySyncTaskEnd(r, 'attempt-1', 'strength', { status: 'completed', contractSatisfied: true }, END_S);
  r = applySyncReadback(r, 'attempt-1', 'strength', { ok: true, updatedAt: NEW_S, stamp: READ_AFTER_BOTH });
  check('independence (reverse order): strength confirmed while health is still waiting',
    stage(r, 'strength') === 'confirmed-new' && stage(r, 'health') === 'waiting');
}

// ------------------------------------------------------------ failure / refusal / timeout
{
  let refused = openAttempt();
  refused = beginSyncAttempt(null, 'attempt-2', { health: BASE_H, strength: BASE_S });
  refused = applySyncDispatchResult(refused, 'attempt-2', 'health', { accepted: false });
  check('dispatch refusal fails the source immediately', stage(refused, 'health') === 'failed');
  const threw = applySyncDispatchResult(beginSyncAttempt(null, 'attempt-3', { health: BASE_H, strength: BASE_S }), 'attempt-3', 'strength', { threw: true });
  check('a thrown dispatch fails the source immediately', stage(threw, 'strength') === 'failed');
  const failedTask = applySyncTaskEnd(openAttempt(), 'attempt-1', 'health', { status: 'failed', contractSatisfied: false }, END_H);
  check('a failed task fails the source (no unconfirmed detour)', stage(failedTask, 'health') === 'failed');
  const badContract = applySyncTaskEnd(openAttempt(), 'attempt-1', 'health', { status: 'completed', contractSatisfied: false }, END_H);
  check('a completed task whose save contract was not satisfied fails the source', stage(badContract, 'health') === 'failed');
  const afterFail = applySyncReadback(failedTask, 'attempt-1', 'health', { ok: true, updatedAt: NEW_H, stamp: READ_AFTER_H });
  check('a read-back never revives a failed source', afterFail === failedTask);
  // Poll timeout: the settle reports status "unknown" — the source
  // becomes unconfirmed (task ended, save unproven), and only a
  // strictly-later fresh read may confirm it afterwards.
  let timeout = applySyncTaskEnd(openAttempt(), 'attempt-1', 'health', { status: 'unknown', contractSatisfied: false }, END_H);
  check('poll timeout (unknown status) -> unconfirmed, not failed, not confirmed',
    stage(timeout, 'health') === 'unconfirmed');
  timeout = applySyncReadback(timeout, 'attempt-1', 'health', { ok: true, updatedAt: NEW_H, stamp: READ_AFTER_H });
  check('after a timeout, a genuinely fresh read-back still confirms',
    stage(timeout, 'health') === 'confirmed-new');
}

// ------------------------------------------------------------ attempt identity / refresh race
{
  // A new attempt supersedes: events carrying the OLD attemptId are
  // ignored whole, so a late response from attempt-1 can never
  // confirm attempt-2.
  let s = healthUnconfirmed();
  s = beginSyncAttempt(s, 'attempt-2', { health: NEW_H, strength: BASE_S }, ['health', 'strength']);
  s = applySyncDispatchResult(s, 'attempt-2', 'health', { accepted: true });
  s = applySyncTaskEnd(s, 'attempt-2', 'health', { status: 'completed', contractSatisfied: true }, READ_AFTER_BOTH);
  const lateOld = applySyncReadback(s, 'attempt-1', 'health', { ok: true, updatedAt: '2031-05-01T09:30:00.000Z', stamp: '2031-05-01T09:31:00.000Z' });
  check('old attempt: a late read-back under the OLD attemptId leaves the new attempt untouched',
    lateOld === s && stage(s, 'health') === 'unconfirmed');
  const own = applySyncReadback(s, 'attempt-2', 'health', { ok: true, updatedAt: '2031-05-01T09:30:00.000Z', stamp: '2031-05-01T09:31:00.000Z' });
  check('new attempt: its own fresh read-back (against its own newer baseline) confirms',
    stage(own, 'health') === 'confirmed-new');
  // Refresh race: a read-back offered while the source is still
  // waiting (task not ended) is ignored; the SAME read offered after
  // the task end still cannot confirm (its stamp predates the end);
  // only a later read confirms.
  let race = openAttempt();
  race = applySyncReadback(race, 'attempt-1', 'health', { ok: true, updatedAt: NEW_H, stamp: READ_AFTER_H });
  check('race: a read-back before the task end is ignored (source still waiting)',
    stage(race, 'health') === 'waiting');
  race = applySyncTaskEnd(race, 'attempt-1', 'health', { status: 'completed', contractSatisfied: true }, '2031-05-01T09:08:00.000Z');
  race = applySyncReadback(race, 'attempt-1', 'health', { ok: true, updatedAt: NEW_H, stamp: READ_AFTER_H });
  check('race: the pre-end read (stamp 09:06 < taskEnd 09:08) still cannot confirm after the end',
    stage(race, 'health') === 'unconfirmed');
  race = applySyncReadback(race, 'attempt-1', 'health', { ok: true, updatedAt: NEW_H, stamp: READ_AFTER_BOTH });
  check('race: a later read (stamp after the task end) confirms',
    stage(race, 'health') === 'confirmed-new');
  // Sources an attempt does not cover keep their prior presentation.
  const partial = beginSyncAttempt(healthUnconfirmed(), 'attempt-9', { health: NEW_H, strength: BASE_S }, ['strength']);
  check('partial attempt: an uncovered source keeps its prior stage',
    stage(partial, 'health') === 'unconfirmed' && stage(partial, 'strength') === 'requested');
}

console.log(`\n${passed} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
