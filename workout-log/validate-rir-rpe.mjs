// W3.1 validation — per-set RIR + session finish self-report.
// Runs the REAL production pure functions extracted verbatim from
// client/src/App.tsx (setDraftFromSet, sameSetDraft, isValidRirDraft,
// painFlagLabel, painReminderText) and server/src/actions.ts
// (validateRir, validateSessionFinish, encodePainFlags,
// decodePainFlags, normalizeSessionNotes) over synthetic data only,
// plus source-wiring checks for the parts that need the live action
// channel / database:
//  - RIR 0–5 saves and reads back through the draft machine; an
//    omitted / null RIR is "not recorded"; out-of-range and
//    non-integer values are rejected with an error, never clamped;
//  - the RIR draft accepts only "" or one digit 0–5, so an
//    unsavable value can never enter the autosave chain;
//  - session RPE 1–10, pain flags restricted to the shared
//    vocabulary, notes capped at 500 chars — all validated, and
//    skipping everything maps every column to NULL;
//  - pain flags round-trip through the stored JSON form; unknown
//    or corrupt stored values decode to no flags;
//  - any pain flag yields exactly the one conservative reminder
//    copy (lower the intensity, watch the form) — no diagnosis
//    wording anywhere in it;
//  - RIR's influence is bounded (W3.2): it feeds only the single
//    server engine's reason/confidence, never its decision, and
//    the client holds no progression rule at all;
//  - wiring: migration 0009 adds exactly the four columns, the
//    schema declares them, updateSet / completeWorkout validate
//    and persist them, and loadWorkout passes them back out.
import { readFileSync, readdirSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';

const clientSrc = readFileSync(new URL('./client/src/App.tsx', import.meta.url), 'utf8');
const serverSrc = readFileSync(new URL('./server/src/actions.ts', import.meta.url), 'utf8');
const schemaSrc = readFileSync(new URL('./server/src/schema.ts', import.meta.url), 'utf8');

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
function extractConstArray(source, name) {
  const idx = source.indexOf(`const ${name}`);
  if (idx < 0) throw new Error(`const ${name} not found`);
  // Skip past the "=" so a type annotation's [] is not mistaken for
  // the array literal itself.
  const eq = source.indexOf('=', idx);
  const open = source.indexOf('[', eq);
  const close = matchDelim(source, open, '[', ']');
  return source.slice(open, close + 1);
}

const CLIENT_FN = ['setDraftFromSet', 'sameSetDraft', 'isValidRirDraft', 'painFlagLabel', 'painReminderText'];
const clientCode = CLIENT_FN.map((n) => extractFunction(clientSrc, n)).join('\n')
  + `\nconst PAIN_FLAG_OPTIONS = ${extractConstArray(clientSrc, 'PAIN_FLAG_OPTIONS')};`;
const C = new Function(`${stripTypeScriptTypes(clientCode)}\nreturn { ${CLIENT_FN.join(', ')}, PAIN_FLAG_OPTIONS };`)();

const SERVER_FN = ['validateRir', 'validateSessionFinish', 'encodePainFlags', 'decodePainFlags', 'normalizeSessionNotes'];
const serverCode = SERVER_FN.map((n) => extractFunction(serverSrc, n)).join('\n')
  + `\nconst PAIN_FLAG_KEYS = ${extractConstArray(serverSrc, 'PAIN_FLAG_KEYS')};`;
const S = new Function(`${stripTypeScriptTypes(serverCode)}\nreturn { ${SERVER_FN.join(', ')}, PAIN_FLAG_KEYS };`)();

// --- RIR: validation verdicts (server) ---
check('RIR null is valid (not recorded)', S.validateRir(null) === null);
check('RIR undefined is valid (field omitted)', S.validateRir(undefined) === null);
for (const v of [0, 1, 3, 5]) check(`RIR ${v} is valid`, S.validateRir(v) === null);
for (const v of [6, -1, 100]) check(`RIR ${v} is rejected, not clamped`, typeof S.validateRir(v) === 'string');
for (const v of [2.5, 0.5, NaN]) check(`RIR ${v} (non-integer) is rejected`, typeof S.validateRir(v) === 'string');

// --- RIR: draft machine round-trip (client) ---
const baseSet = { weight: 60, reps: 8, completed: true };
check('set with rir null drafts as "" (not recorded)', C.setDraftFromSet({ ...baseSet, rir: null }).rir === '');
check('set with rir 0 drafts as "0" (a real recorded zero)', C.setDraftFromSet({ ...baseSet, rir: 0 }).rir === '0');
check('set with rir 4 drafts as "4"', C.setDraftFromSet({ ...baseSet, rir: 4 }).rir === '4');
const draftA = C.setDraftFromSet({ ...baseSet, rir: 2 });
check('identical drafts compare equal', C.sameSetDraft(draftA, { ...draftA }) === true);
check('a RIR-only edit is a real difference (autosaves)', C.sameSetDraft(draftA, { ...draftA, rir: '3' }) === false);
check('clearing RIR is a real difference (autosaves)', C.sameSetDraft(draftA, { ...draftA, rir: '' }) === false);
// Draft -> wire payload mapping, exactly as SetRow's send builds it.
const wireRir = (draft) => (draft.rir.trim() === '' ? null : Number(draft.rir));
check('draft "" sends null (not recorded)', wireRir({ rir: '' }) === null && S.validateRir(wireRir({ rir: '' })) === null);
check('draft "5" sends 5 and validates', wireRir({ rir: '5' }) === 5 && S.validateRir(5) === null);

// --- RIR: the input gate (client) ---
for (const v of ['', '0', '1', '5']) check(`RIR draft "${v}" is accepted by the input`, C.isValidRirDraft(v) === true);
for (const v of ['6', '9', '-1', '2.5', '10', 'a', ' ']) check(`RIR draft "${v}" never enters the draft`, C.isValidRirDraft(v) === false);

// --- Session finish: validation verdicts (server) ---
check('skipping everything (no fields) is valid', S.validateSessionFinish({}) === null);
check('skipping everything (explicit nulls) is valid', S.validateSessionFinish({ session_rpe: null, pain_flags: null, session_notes: null }) === null);
for (const v of [1, 5, 10]) check(`session RPE ${v} is valid`, S.validateSessionFinish({ session_rpe: v }) === null);
for (const v of [0, 11, 7.5]) check(`session RPE ${v} is rejected`, typeof S.validateSessionFinish({ session_rpe: v }) === 'string');
check('known pain flags are valid', S.validateSessionFinish({ pain_flags: ['knee', 'form'] }) === null);
check('empty pain flag list is valid', S.validateSessionFinish({ pain_flags: [] }) === null);
check('unknown pain flag is rejected', typeof S.validateSessionFinish({ pain_flags: ['bogus'] }) === 'string');
check('notes of exactly 500 chars are valid', S.validateSessionFinish({ session_notes: '状'.repeat(500) }) === null);
check('notes of 501 chars are rejected', typeof S.validateSessionFinish({ session_notes: '状'.repeat(501) }) === 'string');

// --- Session finish: skip-all maps to NULL columns ---
check('no pain flags encode to NULL', S.encodePainFlags(null) === null && S.encodePainFlags(undefined) === null && S.encodePainFlags([]) === null);
check('blank notes normalize to NULL', S.normalizeSessionNotes(null) === null && S.normalizeSessionNotes('') === null && S.normalizeSessionNotes('   ') === null);
check('real notes are stored trimmed', S.normalizeSessionNotes('  状态不错  ') === '状态不错');

// --- Pain flags: stored-form round-trip ---
const stored = S.encodePainFlags(['knee', 'knee', 'form']);
check('pain flags encode deduplicated JSON', stored === '["knee","form"]', stored ?? 'null');
check('pain flags decode back to the same keys', JSON.stringify(S.decodePainFlags(stored)) === '["knee","form"]');
check('NULL decodes to no flags', Array.isArray(S.decodePainFlags(null)) && S.decodePainFlags(null).length === 0);
check('corrupt stored value decodes to no flags', S.decodePainFlags('not json').length === 0);
check('unknown stored keys are dropped on read', JSON.stringify(S.decodePainFlags('["knee","bogus",3]')) === '["knee"]');

// --- Pain reminder: one conservative copy, no diagnosis ---
check('no flags -> no reminder', C.painReminderText([]) === null);
const reminder = C.painReminderText(['knee']);
check('any flag -> the reminder appears', typeof reminder === 'string' && reminder.length > 0);
check('reminder advises lowering intensity', reminder != null && reminder.includes('降低强度'));
check('reminder advises watching form', reminder != null && reminder.includes('注意动作'));
for (const word of ['诊断', '确诊', '患有', '损伤是', '治疗方案']) {
  check(`reminder contains no diagnosis wording (${word})`, reminder != null && !reminder.includes(word));
}

// --- Flag vocabulary parity between client and server ---
const clientKeys = C.PAIN_FLAG_OPTIONS.map((o) => o.key).sort();
const serverKeys = [...S.PAIN_FLAG_KEYS].sort();
check('client pain-flag keys match the server vocabulary', JSON.stringify(clientKeys) === JSON.stringify(serverKeys), clientKeys.join(','));
check('every client flag has a Chinese label', C.PAIN_FLAG_OPTIONS.every((o) => typeof o.label === 'string' && o.label.length > 0));
check('painFlagLabel resolves a known key', C.painFlagLabel('knee') === '膝部疼痛');
check('painFlagLabel falls back to the raw key', C.painFlagLabel('mystery') === 'mystery');

// --- RIR's role after W3.2: reason + confidence only, one engine ---
// W3.1's rule was "NULL RIR participates in no calculation". W3.2
// supersedes the shape, not the spirit: RIR is now an input of the
// single server progression engine, where it may colour the reason
// and the confidence but NEVER the decision or the suggested weight,
// and a missing RIR changes nothing. The week volume summary still
// never reads it, and the client holds no progression rule at all.
check('client defines no progression rule of its own (W3.2 single server engine)',
  !clientSrc.includes('function progressionDecision'));
check('server progressionDecision delegates to the engine',
  extractFunction(serverSrc, 'progressionDecision').includes('evaluateProgression({'));
{
  const engineSrc = readFileSync(new URL('./server/src/progression-engine.ts', import.meta.url), 'utf8');
  const ENG = new Function(
    `${stripTypeScriptTypes(engineSrc).replace(/^export /gm, '')}\nreturn { evaluateProgression };`,
  )();
  const st = (weight, reps, rir = null, completed = true) => ({ weight, reps, rir, completed });
  const scenarios = [
    [st(100, 8), st(100, 8), st(100, 8), st(100, 8)],
    [st(100, 7), st(100, 7), st(100, 7), st(100, 7)],
    [st(100, 8), st(100, 5)],
  ];
  scenarios.forEach((sets, i) => {
    const base = ENG.evaluateProgression({
      sessions: [{ unit: 'lb', plannedSets: sets.length, sets }], targetMin: 6, targetMax: 8, unit: 'lb',
    });
    const withRir = ENG.evaluateProgression({
      sessions: [{ unit: 'lb', plannedSets: sets.length, sets: sets.map((s) => ({ ...s, rir: 0 })) }],
      targetMin: 6, targetMax: 8, unit: 'lb',
    });
    check(`engine scenario ${i + 1}: recorded RIR never changes the decision or suggested weight`,
      withRir.decision === base.decision && withRir.suggestedWeight === base.suggestedWeight);
  });
}
const weekSummary = extractFunction(serverSrc, 'summarizeWeekSummaries');
check('week volume summary never reads rir', !/rir/i.test(weekSummary));

// --- Wiring: migration + schema ---
const migrationFiles = readdirSync(new URL('./drizzle/', import.meta.url)).filter((f) => f.startsWith('0009') && f.endsWith('.sql'));
check('migration 0009 exists', migrationFiles.length === 1, migrationFiles.join(','));
const migrationSql = migrationFiles.length === 1
  ? readFileSync(new URL(`./drizzle/${migrationFiles[0]}`, import.meta.url), 'utf8')
  : '';
check('migration adds workout_sets.rir', /ALTER TABLE `workout_sets` ADD COLUMN `rir` integer/.test(migrationSql));
check('migration adds workouts.session_rpe', /ALTER TABLE `workouts` ADD COLUMN `session_rpe` integer/.test(migrationSql));
check('migration adds workouts.pain_flags', /ALTER TABLE `workouts` ADD COLUMN `pain_flags` text/.test(migrationSql));
check('migration adds workouts.session_notes', /ALTER TABLE `workouts` ADD COLUMN `session_notes` text/.test(migrationSql));
check('migration drops nothing', !/DROP|DELETE FROM/i.test(migrationSql));
check('schema declares rir on workout_sets', schemaSrc.includes('rir: integer("rir")'));
check('schema declares session_rpe', schemaSrc.includes('sessionRpe: integer("session_rpe")'));
check('schema declares pain_flags', schemaSrc.includes('painFlags: text("pain_flags")'));
check('schema declares session_notes', schemaSrc.includes('sessionNotes: text("session_notes")'));

// --- Wiring: server actions ---
check('setResponse carries rir', serverSrc.includes('rir: z.number().nullable()'));
check('workoutResponse carries the session fields',
  serverSrc.includes('session_rpe: z.number().nullable()')
  && serverSrc.includes('pain_flags: z.array(z.string())')
  && serverSrc.includes('session_notes: z.string().nullable()'));
check('loadWorkout passes rir through', serverSrc.includes('rir: row.rir'));
check('loadWorkout passes session fields through',
  serverSrc.includes('session_rpe: workout.sessionRpe')
  && serverSrc.includes('pain_flags: decodePainFlags(workout.painFlags)')
  && serverSrc.includes('session_notes: workout.sessionNotes'));
check('updateSet accepts an optional rir', serverSrc.includes('rir: z.number().nullable().optional()'));
check('updateSet validates rir before writing', serverSrc.includes('validateRir(args.rir)'));
check('updateSet writes rir only when the field was sent', serverSrc.includes('args.rir === undefined ? sql`rir = rir` : sql`rir = ${args.rir}`'));
check('addSet returns rir for the new set', serverSrc.includes('rir: row.rir'));
check('completeWorkout accepts the optional session fields',
  serverSrc.includes('session_rpe: z.number().nullable().optional()')
  && serverSrc.includes('pain_flags: z.array(z.string()).nullable().optional()')
  && serverSrc.includes('session_notes: z.string().nullable().optional()'));
check('completeWorkout validates the session fields', serverSrc.includes('validateSessionFinish(args)'));
check('completeWorkout stores encoded flags + normalized notes',
  serverSrc.includes('encodePainFlags(args.pain_flags)') && serverSrc.includes('normalizeSessionNotes(args.session_notes)'));
check('completeWorkout leaves skipped fields untouched',
  serverSrc.includes('if (args.session_rpe !== undefined)') && serverSrc.includes('if (args.pain_flags !== undefined)') && serverSrc.includes('if (args.session_notes !== undefined)'));

// --- Wiring: client ---
check('SetRow sends rir through the same updateSet payload', clientSrc.includes('rir: payload.rir.trim() === "" ? null : Number(payload.rir)'));
check('SetRow renders a labelled RIR input', clientSrc.includes('组 RIR 剩余次数，可选，0 到 5'));
check('SetRow adopts server rir on refresh', clientSrc.includes('[set.id, set.weight, set.reps, set.rir, set.completed]'));
check('finish panel is explicitly skippable', clientSrc.includes('全部可跳过'));
check('finish panel has an explicit skip button that finishes directly', clientSrc.includes('跳过，直接结束训练'));
check('the skip clears the session values before finishing',
  clientSrc.includes('sessionRef.current = { rpe: null, painFlags: [], notes: "" }'));
check('finish sends the session fields with the completion',
  clientSrc.includes('session_rpe: session.rpe')
  && clientSrc.includes('pain_flags: session.painFlags.length > 0 ? session.painFlags : null')
  && clientSrc.includes('session_notes: session.notes.trim() === "" ? null : session.notes'));
check('pain reminder is rendered from painReminderText', clientSrc.includes('painReminderText(painFlags)'));
check('history passes the session fields through', clientSrc.includes('workout.session_rpe') && clientSrc.includes('painFlagLabel(flag)'));
check('receipt passes the session fields through', clientSrc.includes('本次训练感受'));

console.log(`\n${passed} passed, ${failures} failed`);
if (failures > 0) process.exit(1);
