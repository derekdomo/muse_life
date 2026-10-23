// H3.5 周复盘「下周重点」反馈 (space-4) validation.
// Runs the REAL production state machine extracted verbatim from
// client/src/App.tsx (focusFeedbackKey / createFocusFeedbackState /
// syncFocusFeedbackState / beginFocusFeedbackSave /
// completeFocusFeedbackSave / failFocusFeedbackSave) over scenario
// walks only, plus source checks on the client wiring and the server
// contract (owner gate, server-computed key, idempotent upsert,
// getDashboard.focusFeedback). Covers:
// (1) key composition matches the server `${start}|${end}|${version}`,
// (2) first bind with no server row -> unmarked idle state,
// (3) first bind with a server row -> confirmed + saved,
// (4) choose -> saving; success on the same key -> saved + confirmed,
// (5) a stale success callback for an OLD key is dropped whole and
//     never stamps its choice onto the new card,
// (6) failure keeps the attempted choice and marks error (retryable),
// (7) re-selection under the same key re-saves,
// (8) a failed re-read keeps the confirmed value and flags readFailed
//     instead of resetting to "not yet given",
// (9) binding a new key never migrates the old key's feedback, even
//     when the server row for the new key is absent,
// (10) an in-flight save is not clobbered by a same-key re-read sync,
// (11) server source: strict owner gate before any write, key computed
//     server-side from window + snapshot version, revision advances
//     inside the upsert statement, same key+feedback is idempotent,
//     getDashboard returns focusFeedback { current, previous } with
//     current keyed to dataDate / dataDate-6 / snapshot updatedAt and
//     both nulls for non-owners, migration 0016 creates the table.
// Pure Node, no deps.
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';

const clientSrc = readFileSync(new URL('./client/src/App.tsx', import.meta.url), 'utf8');
const serverSrc = readFileSync(new URL('./server/src/actions.ts', import.meta.url), 'utf8');
const schemaSrc = readFileSync(new URL('./server/src/schema.ts', import.meta.url), 'utf8');
const migrationSrc = readFileSync(new URL('./drizzle/0016_add_week_focus_feedback.sql', import.meta.url), 'utf8');

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

const NAMES = ['focusFeedbackKey', 'createFocusFeedbackState', 'syncFocusFeedbackState', 'beginFocusFeedbackSave', 'completeFocusFeedbackSave', 'failFocusFeedbackSave'];
const code = NAMES.map((name) => stripTypeScriptTypes(extractFunction(clientSrc, name).replace(/^export /, ''))).join('\n');
const machine = new Function(`${code}\nreturn { ${NAMES.join(', ')} };`)();
const { focusFeedbackKey, createFocusFeedbackState, syncFocusFeedbackState, beginFocusFeedbackSave, completeFocusFeedbackSave, failFocusFeedbackSave } = machine;

const KEY_A = focusFeedbackKey('2026-10-17', '2026-10-23', '2026-10-23T08:00:00.000Z');
const KEY_B = focusFeedbackKey('2026-10-18', '2026-10-24', '2026-10-24T08:00:00.000Z');
const KEY_A2 = focusFeedbackKey('2026-10-17', '2026-10-23', '2026-10-23T09:30:00.000Z');

// (1) key composition
check('key is `${start}|${end}|${snapshotVersion}`', KEY_A === '2026-10-17|2026-10-23|2026-10-23T08:00:00.000Z');
check('same window, new snapshot version -> different key', KEY_A !== KEY_A2);

// (2) first bind, no server row
let s = syncFocusFeedbackState(createFocusFeedbackState(), KEY_A, null, false);
check('first bind without a row: unmarked idle', s.boundKey === KEY_A && s.confirmed === null && s.selection === null && s.status === 'idle' && s.readFailed === false);

// (3) first bind with a server row
s = syncFocusFeedbackState(createFocusFeedbackState(), KEY_A, '有帮助', false);
check('first bind with a row: confirmed + saved', s.confirmed === '有帮助' && s.selection === '有帮助' && s.status === 'saved');

// (4) choose -> saving -> success on the same key
s = syncFocusFeedbackState(createFocusFeedbackState(), KEY_A, null, false);
s = beginFocusFeedbackSave(s, '不适用');
check('choose marks selection + saving', s.selection === '不适用' && s.status === 'saving' && s.confirmed === null);
s = completeFocusFeedbackSave(s, KEY_A, '不适用');
check('success on the bound key: saved + confirmed', s.status === 'saved' && s.confirmed === '不适用' && s.selection === '不适用');

// (5) stale callback for an old key is dropped
s = syncFocusFeedbackState(createFocusFeedbackState(), KEY_A, null, false);
s = beginFocusFeedbackSave(s, '有帮助'); // save for KEY_A in flight
s = syncFocusFeedbackState(s, KEY_B, null, false); // new window/snapshot arrives before the callback
check('rebind to a new key starts fresh (no migrated choice)', s.boundKey === KEY_B && s.confirmed === null && s.selection === null && s.status === 'idle');
const before = s;
s = completeFocusFeedbackSave(s, KEY_A, '有帮助');
check('stale success callback is dropped whole', s === before);

// (6) failure keeps the choice, marks error
s = syncFocusFeedbackState(createFocusFeedbackState(), KEY_A, null, false);
s = beginFocusFeedbackSave(s, '有帮助');
s = failFocusFeedbackSave(s, KEY_A);
check('failure keeps the attempted choice as unsaved', s.status === 'error' && s.selection === '有帮助' && s.confirmed === null);
s = failFocusFeedbackSave(s, KEY_B);
check('failure callback for another key is ignored', s.status === 'error' && s.boundKey === KEY_A);

// (7) re-selection under the same key re-saves
s = syncFocusFeedbackState(createFocusFeedbackState(), KEY_A, '有帮助', false);
s = beginFocusFeedbackSave(s, '不适用');
check('re-selection enters saving with the new choice', s.status === 'saving' && s.selection === '不适用' && s.confirmed === '有帮助');
s = completeFocusFeedbackSave(s, KEY_A, '不适用');
check('re-selection success replaces the confirmed choice', s.confirmed === '不适用' && s.status === 'saved');

// (8) failed re-read preserves the confirmed value
s = syncFocusFeedbackState(createFocusFeedbackState(), KEY_A, '有帮助', false);
s = syncFocusFeedbackState(s, KEY_A, null, true);
check('failed re-read keeps confirmed + flags readFailed', s.confirmed === '有帮助' && s.selection === '有帮助' && s.readFailed === true);
s = syncFocusFeedbackState(s, KEY_A, '有帮助', false);
check('a later good re-read clears readFailed', s.readFailed === false && s.confirmed === '有帮助');

// (9) new key never inherits the old key feedback
s = syncFocusFeedbackState(createFocusFeedbackState(), KEY_A, '有帮助', false);
s = syncFocusFeedbackState(s, KEY_A2, null, false);
check('same window + new snapshot: no feedback migration', s.boundKey === KEY_A2 && s.confirmed === null && s.selection === null && s.status === 'idle');

// (10) in-flight save not clobbered by a same-key re-read
s = syncFocusFeedbackState(createFocusFeedbackState(), KEY_A, null, false);
s = beginFocusFeedbackSave(s, '不适用');
s = syncFocusFeedbackState(s, KEY_A, null, false);
check('re-read during saving keeps the in-flight choice', s.status === 'saving' && s.selection === '不适用');

// ------------------------------------------------------------ source checks
check('client: panel renders the two feedback buttons only when canJudge',
  clientSrc.includes('review.canJudge ? (') && clientSrc.includes('week-review-feedback-btn'));
check('client: unmarked state reads 尚未反馈', clientSrc.includes('"尚未反馈"'));
check('client: unsaved state reads 未保存 with a retry control',
  clientSrc.includes('未保存：这次反馈还没有记下来。') && clientSrc.includes('重试保存'));
check('client: read failure is labelled 读取失败', clientSrc.includes('读取失败：暂时读不到最新状态'));
check('client: focus card carries the 本次复盘 annotation with the coverage status note',
  clientSrc.includes('本次复盘：') && clientSrc.includes('review.coverageStatusNote'));
check('client: previous look-back is a collapsed details with basis + rule version',
  clientSrc.includes('<details className="week-review-previous">') && clientSrc.includes('当时依据：') && clientSrc.includes('规则 v{focusFeedback.previous.ruleVersion}'));
check('client: previous block renders only when a previous row exists',
  clientSrc.includes('{focusFeedback.previous ? ('));
check('client: panel receives focusFeedback + focusReadFailed from the dashboard response',
  clientSrc.includes('focusFeedback={dashboard.data.focusFeedback}') && clientSrc.includes('focusReadFailed={dashboard.isRefetchError}'));
check('client: feedback buttons meet the 44px touch minimum in CSS',
  readFileSync(new URL('./client/src/theme.css', import.meta.url), 'utf8').includes('.week-review-feedback-btn { min-height: 44px;'));

check('server: WEEK_FOCUS_RULE_VERSION is the fixed constant 1',
  serverSrc.includes('const WEEK_FOCUS_RULE_VERSION = 1;'));
check('server: focus key is computed server-side from window + snapshot version',
  serverSrc.includes('return `${windowStart}|${windowEnd}|${snapshotVersion}`;')
  && serverSrc.includes('const focusKey = weekFocusKey(args.windowStart, args.windowEnd, args.snapshotVersion);'));
check('server: saveWeekFocusFeedback request schema carries no client key',
  !/focusKey/.test(serverSrc.slice(serverSrc.indexOf('const saveWeekFocusFeedbackRequest'), serverSrc.indexOf('const saveWeekFocusFeedbackResponse'))));
check('server: save action is behind the strict owner gate before any write',
  serverSrc.indexOf('saveWeekFocusFeedback: defineAction') < serverSrc.indexOf('const focusKey = weekFocusKey')
  && serverSrc.includes('if (!isOwner(ctx)) return { ok: false, forbidden: true, focusKey: null'));
check('server: same key + same feedback short-circuits idempotently',
  serverSrc.includes('if (existing && existing.feedback === args.feedback)'));
check('server: revision advances inside the upsert statement',
  serverSrc.includes('revision: sql`${schema.weekFocusFeedback.revision} + 1`'));
check('server: window dates are validated as real dates with start <= end',
  serverSrc.includes('if (!isRealDateString(args.windowStart) || !isRealDateString(args.windowEnd) || args.windowStart > args.windowEnd)'));
check('server: getDashboard current key uses dataDate, dataDate-6 and the snapshot updatedAt',
  serverSrc.includes('loadFocusFeedback(ctx, health.dataDate, health.updatedAt)')
  && serverSrc.includes('weekFocusKey(shiftDate(dataDate, -6), dataDate, snapshotVersion)'));
check('server: previous is the most recent other row (window_end desc, updated_at desc)',
  serverSrc.includes('.orderBy(desc(schema.weekFocusFeedback.windowEnd), desc(schema.weekFocusFeedback.updatedAt))'));
check('server: non-owner dashboard returns both focusFeedback nulls',
  serverSrc.includes('focusFeedback: { current: null, previous: null }'));
check('schema: week_focus_feedback table is declared with the feedback enum',
  schemaSrc.includes('weekFocusFeedback = sqliteTable("week_focus_feedback"')
  && schemaSrc.includes('feedback: text("feedback", { enum: ["有帮助", "不适用"] }).notNull()'));
check('migration 0016 creates week_focus_feedback with focus_key as primary key',
  migrationSrc.includes('CREATE TABLE `week_focus_feedback`') && migrationSrc.includes('`focus_key` text PRIMARY KEY NOT NULL'));

console.log(`\n${passed} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
