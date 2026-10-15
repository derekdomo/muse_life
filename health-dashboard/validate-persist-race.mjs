// L1-RACE-001 validation for the atomic conditional snapshot write.
// Pure Node (node:sqlite), no dependencies. Two parts:
//
// (a) Source assertions against the REAL server/src/actions.ts: both persist
//     paths must be a single-statement conditional upsert carrying a
//     `excluded.source_updated_at >= <table>.source_updated_at` guard and a
//     RETURNING-based applied/ignored signal — with no leftover
//     select-compare-then-unconditional-upsert two-step shape — plus the
//     outcome response field and the readStartedAt version contract in
//     STRENGTH_SYNC_PROMPT.
//
// (b) A deterministic interleaving matrix on an in-memory SQLite database
//     using the exact statement shape production generates (Drizzle renders
//     the same INSERT … ON CONFLICT … DO UPDATE SET … WHERE
//     excluded.source_updated_at >= "table"."source_updated_at" RETURNING).
//     "Concurrent" callbacks are interleaved deterministically: the race in
//     production was never about statement-level parallelism (SQLite
//     serializes statements) but about the ORDER statements land in, which
//     is exactly what this matrix enumerates.
//
// Exit code is non-zero when any assertion fails.
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

let passed = 0;
let failures = 0;
function check(name, ok, note = '') {
  if (ok) passed++;
  else failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${note ? ` (${note})` : ''}`);
}

// ---------------------------------------------------------------- (a) source
const src = readFileSync(new URL('./server/src/actions.ts', import.meta.url), 'utf8');

function functionBody(name) {
  const start = src.indexOf(`async function ${name}(`);
  if (start < 0) return null;
  const next = src.indexOf('\nasync function ', start + 1);
  const nextConst = src.indexOf('\nconst ', start + 1);
  const ends = [next, nextConst].filter((i) => i > start);
  return src.slice(start, ends.length ? Math.min(...ends) : undefined);
}

const GUARD = /excluded\.source_updated_at >=/;
for (const fn of ['persistSnapshot', 'persistStrengthSnapshot']) {
  const body = functionBody(fn);
  check(`${fn}: function found`, body !== null);
  if (!body) continue;
  check(`${fn}: uses onConflictDoUpdate`, body.includes('.onConflictDoUpdate('));
  check(`${fn}: conflict update is conditional (setWhere with >= guard on excluded.source_updated_at)`,
    body.includes('setWhere:') && GUARD.test(body));
  check(`${fn}: applied/ignored decided via RETURNING`, body.includes('.returning('));
  check(`${fn}: returns whether the write landed`, /Promise<boolean>/.test(src.slice(src.indexOf(`async function ${fn}(`), src.indexOf(`async function ${fn}(`) + 120)));
  check(`${fn}: no pre-read SELECT of the stored payload (no two-step compare)`, !body.includes('.select(') && !body.includes('existingPayload'));
  check(`${fn}: no JS-side Date.parse version comparison`, !body.includes('Date.parse('));
}
// The whole file must not retain an unconditional snapshot upsert anywhere:
// the only onConflictDoUpdate calls allowed are the two guarded persist
// writes plus the unrelated morningCheckin feeling upsert.
const upsertCount = (src.match(/\.onConflictDoUpdate\(/g) ?? []).length;
const guardedCount = (src.match(/setWhere: sql`excluded\.source_updated_at >=/g) ?? []).length;
check('both snapshot upserts are guarded and no extra upsert appeared', guardedCount === 2 && upsertCount === 3,
  `onConflictDoUpdate total=${upsertCount} (2 snapshots + morningCheckin), guarded=${guardedCount}`);
const morning = src.slice(src.indexOf('saveMorningCheckin'));
check('morningCheckin upsert keeps its original unguarded shape', morning.includes('onConflictDoUpdate({ target: schema.morningCheckin.date'));

check('strength null version maps to epoch (oldest), not write time',
  /strength\.updatedAt \? new Date\(strength\.updatedAt\) : new Date\(0\)/.test(src));
check('health path keeps required updatedAt version', /const sourceUpdatedAt = new Date\(normalized\.updatedAt\);/.test(src));

check('save responses expose outcome enum applied|ignored|forbidden',
  src.includes('outcome: z.enum(["applied", "ignored", "forbidden"])'));
check('saveHealthSnapshot returns outcome from persist result',
  /const applied = await persistSnapshot\(ctx, nextSnapshot\);/.test(src) && src.includes('outcome: applied ? "applied" : "ignored"'));
check('saveStrengthTrainingSnapshot returns outcome from persist result',
  /const applied = await persistStrengthSnapshot\(ctx, args\);/.test(src));
check('forbidden save response carries outcome "forbidden"',
  (src.match(/outcome: "forbidden"/g) ?? []).length === 2);

const promptStart = src.indexOf('const STRENGTH_SYNC_PROMPT');
const promptEnd = src.indexOf('`;', promptStart);
const prompt = promptStart >= 0 ? src.slice(promptStart, promptEnd) : '';
check('STRENGTH_SYNC_PROMPT found', prompt.length > 0);
check('prompt requires recording readStartedAt BEFORE the getDashboard read',
  /BEFORE you call getDashboard/.test(prompt) && prompt.includes('readStartedAt'));
check('prompt sets payload updatedAt to readStartedAt', prompt.includes("set the payload's updatedAt to that readStartedAt"));
check('prompt forbids completion/callback instant as updatedAt',
  prompt.includes('Never set updatedAt to the instant the task finishes or to the callback instant'));
check('prompt explains the atomic-rejection rationale', prompt.includes('atomic compare-and-write'));
check('prompt no longer stamps updatedAt with the real current instant',
  !prompt.includes('Set updatedAt to the real current instant'));

// ------------------------------------------------------- (b) statement matrix
// Same shape Drizzle emits for the production persist functions (quoted
// identifiers, parameter-bound SET values, table-qualified stored column in
// the guard, RETURNING id).
const UPSERT = {
  health_snapshot: `insert into "health_snapshot" ("id", "payload", "source_updated_at", "created_at", "updated_at") values (?, ?, ?, ?, ?)
    on conflict ("id") do update set "payload" = ?, "source_updated_at" = ?, "updated_at" = ?
    where excluded.source_updated_at >= "health_snapshot"."source_updated_at" returning "id"`,
  strength_training_snapshot: `insert into "strength_training_snapshot" ("id", "payload", "source_updated_at", "created_at", "updated_at") values (?, ?, ?, ?, ?)
    on conflict ("id") do update set "payload" = ?, "source_updated_at" = ?, "updated_at" = ?
    where excluded.source_updated_at >= "strength_training_snapshot"."source_updated_at" returning "id"`,
};

function freshDb() {
  const db = new DatabaseSync(':memory:');
  for (const table of Object.keys(UPSERT)) {
    db.exec(`CREATE TABLE "${table}" (id INTEGER PRIMARY KEY, payload TEXT NOT NULL, source_updated_at INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`);
  }
  return db;
}

// Mirrors the production persist contract: returns true when the statement
// actually wrote (RETURNING produced a row), false when it was ignored.
function persist(db, table, payload, sourceUpdatedAtMs) {
  const now = Date.now();
  const rows = db.prepare(UPSERT[table]).all(1, payload, sourceUpdatedAtMs, now, now, payload, sourceUpdatedAtMs, now);
  return rows.length > 0;
}
function storedRow(db, table) {
  return db.prepare(`SELECT payload, source_updated_at FROM "${table}" WHERE id = 1`).get();
}
function rowCount(db, table) {
  return db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get().n;
}

const T_0030 = Date.parse('2026-10-15T00:30:00.000Z');
const T_0100 = Date.parse('2026-10-15T01:00:00.000Z');
const T_0200 = Date.parse('2026-10-15T02:00:00.000Z');
const EPOCH = 0; // strength null version

for (const table of Object.keys(UPSERT)) {
  // First-create race: two callbacks both saw an empty table; the older
  // version lands first, the newer second.
  {
    const db = freshDb();
    const a = persist(db, table, 'v-0100', T_0100);
    const b = persist(db, table, 'v-0200', T_0200);
    const row = storedRow(db, table);
    check(`${table}: first-create race (01:00 then 02:00) leaves exactly one row, the newer version`,
      a === true && b === true && rowCount(db, table) === 1 && row.payload === 'v-0200' && row.source_updated_at === T_0200);
  }
  // First-create race, reverse landing order: newer lands first, the older
  // late write must be ignored (this is the original L1-RACE-001 defect).
  {
    const db = freshDb();
    const a = persist(db, table, 'v-0200', T_0200);
    const b = persist(db, table, 'v-0100', T_0100);
    const row = storedRow(db, table);
    check(`${table}: first-create race (02:00 lands first) — late 01:00 is ignored, final stays 02:00`,
      a === true && b === false && rowCount(db, table) === 1 && row.payload === 'v-0200' && row.source_updated_at === T_0200);
  }
  // Established row: 02:00 stored, then 01:00 arrives late.
  {
    const db = freshDb();
    persist(db, table, 'v-0200', T_0200);
    const late = persist(db, table, 'v-0100', T_0100);
    const row = storedRow(db, table);
    check(`${table}: 02:00 stored, late 01:00 ignored and stored version unchanged`,
      late === false && row.payload === 'v-0200' && row.source_updated_at === T_0200);
  }
  // Equal timestamp: idempotent rewrite counts as applied.
  {
    const db = freshDb();
    persist(db, table, 'v-0200', T_0200);
    const again = persist(db, table, 'v-0200-retry', T_0200);
    const row = storedRow(db, table);
    check(`${table}: equal timestamp is an idempotent applied rewrite`,
      again === true && row.payload === 'v-0200-retry' && row.source_updated_at === T_0200);
  }
  // Strictly older version rejected.
  {
    const db = freshDb();
    persist(db, table, 'v-0100', T_0100);
    const older = persist(db, table, 'v-0030', T_0030);
    const row = storedRow(db, table);
    check(`${table}: strictly older version (00:30 < 01:00) rejected`,
      older === false && row.payload === 'v-0100' && row.source_updated_at === T_0100);
  }
}

// Strength null-version contract (epoch = oldest).
{
  const db = freshDb();
  const table = 'strength_training_snapshot';
  persist(db, table, 'valid-0200', T_0200);
  const nul = persist(db, table, 'null-version', EPOCH);
  const row = storedRow(db, table);
  check('strength: null version (epoch) cannot overwrite a valid snapshot',
    nul === false && row.payload === 'valid-0200' && row.source_updated_at === T_0200);
}
{
  const db = freshDb();
  const table = 'strength_training_snapshot';
  const nul = persist(db, table, JSON.stringify({ updatedAt: null }), EPOCH);
  const row = storedRow(db, table);
  check('strength: null version may land as the first-ever row',
    nul === true && rowCount(db, table) === 1 && row.source_updated_at === EPOCH && JSON.parse(row.payload).updatedAt === null);
  const valid = persist(db, table, 'valid-0100', T_0100);
  const after = storedRow(db, table);
  check('strength: a later valid snapshot supersedes the null first row',
    valid === true && after.payload === 'valid-0100' && after.source_updated_at === T_0100);
}

console.log(`\n${passed} passed, ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
