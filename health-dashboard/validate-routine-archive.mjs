// L1-ROUTINE-001 + H-LOAD-001 (readiness archive) validation.
//
// Two contracts delivered together on space-4 (健康看板):
// (1) The strength pipeline carries FIVE routine values — push, pull,
//     legs, home_posture, home_snowboard. The health dashboard's
//     strengthWorkoutSchema must accept all five, store and read them
//     back verbatim (never remapped onto the gym three, never dropped),
//     and every consumer (unified timeline counts/volume, H-LOAD
//     weekLoad session counts + same-day HK-strength ambiguity) must
//     count the home routines exactly like the gym ones. An unknown
//     future routine must fail schema validation so the incoming
//     snapshot is rejected whole and the stored snapshot survives.
// (2) Readiness scores are archived per date (readiness_history) at the
//     moment getDashboard computes them; the near-7-day trend reads ONLY
//     the archive, gaps stay gaps, same-day recomputation overwrites the
//     same row, and an archive write failure never breaks the dashboard
//     response (it lands in the sync ledger with no health values).
//     H-ARCHIVE-SAFE-001 adds two gates, both covered below: only LA
//     today may be archived (a stale/future date writes nothing and is
//     not a ledger failure), and same-day writes are arbitrated by an
//     atomic version guard (a late older snapshot_version never rolls
//     the stored score back; the same version may overwrite; a null
//     version may only be the first insert).
//     The check-in race fix (same ID) widens that arbitration to BOTH
//     inputs: getDashboard binds the morning_checkin.updated_at it read
//     alongside the feeling (the check-in version) and the archive
//     upsert accepts a write only when the health version is strictly
//     newer, or equal with a check-in version not older than the stored
//     one — so a request that read an older check-in and paused before
//     its archive write can no longer overwrite a score archived from a
//     newer check-in under the same health version. Legacy rows whose
//     checkin_version is null count as the oldest.
//     The revision follow-up (same ID) replaces the text version as the
//     arbitration key: morning_checkin.revision is a persistent integer
//     incremented atomically inside the save upsert itself (first insert
//     1, conflict update COALESCE(revision, 0) + 1 — never a client
//     clock, never read-then-write), getDashboard binds it alongside the
//     feeling, and readiness_history.checkin_revision carries it into
//     the archive arbitration, whose structure is unchanged (strictly
//     newer health wins; equal health requires an incoming revision not
//     older than the stored one; incoming null never displaces stored
//     non-null; stored null — including legacy rows carrying only the
//     text checkin_version — is the oldest). Section (j) replays the PM
//     counterexample end to end under a frozen same-millisecond clock:
//     save feeling=9 (rev 1), reader A binds it and pauses before its
//     archive write, save feeling=2 (rev 2) in the SAME millisecond,
//     reader B computes and archives, A resumes — the archive must keep
//     B's score. The text checkin_version is still stored but the
//     arbitration must not judge freshness from it.
//
// Method (same as validate-persist-race.mjs): the REAL production code
// is extracted verbatim from the artifact source and executed — the real
// zod schemas (evaluated with the artifact's own zod), the real persist
// / load / timeline / weekLoad / archive functions, and the real
// getDashboard handler — over an in-memory SQLite database through a
// Drizzle-shaped adapter, with synthetic fixtures only.
//
// Source root: the live artifact workspace (the source of truth). Set
// HD_ROOT to run against another copy (e.g. this repo's mirror after a
// backfill sync). Pure Node; zod is loaded from the artifact's own
// node_modules because the schemas under test are zod schemas.
//
// Exit code is non-zero when any assertion fails.
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { stripTypeScriptTypes } from 'node:module';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const DEFAULT_ROOT = join(HERE, '..', '..', '..', 'ts-spaces', 'space-4');
const ROOT = process.env.HD_ROOT ?? (existsSync(join(DEFAULT_ROOT, 'server', 'src', 'actions.ts')) ? DEFAULT_ROOT : HERE);
const actionsSrc = readFileSync(join(ROOT, 'server', 'src', 'actions.ts'), 'utf8');
const clientSrc = readFileSync(join(ROOT, 'client', 'src', 'App.tsx'), 'utf8');
const schemaSrc = readFileSync(join(ROOT, 'server', 'src', 'schema.ts'), 'utf8');

let passed = 0;
let failures = 0;
function check(name, ok, note = '') {
  if (ok) passed++;
  else failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${note ? ` (${note})` : ''}`);
}

// ------------------------------------------------------------- extraction
function matchDelim(s, start, open, close) {
  let depth = 0;
  for (let i = start; i < s.length; i++) {
    if (s[i] === open) depth++;
    else if (s[i] === close) { depth--; if (depth === 0) return i; }
  }
  throw new Error('unbalanced delimiters');
}
function extractFunction(source, name) {
  const idx = source.search(new RegExp(`(async )?function ${name}\\(`));
  if (idx < 0) throw new Error(`function ${name} not found`);
  const openParen = source.indexOf('(', idx);
  const closeParen = matchDelim(source, openParen, '(', ')');
  // The body brace is not always the first `{` after the signature: an
  // object return-type annotation (`): { mean: number } | null {`) puts a
  // balanced type object first. Skip a candidate whose preceding text is
  // just the annotation colon, or whose closing brace is followed by a
  // union continuation.
  let pos = closeParen;
  for (;;) {
    const candidate = source.indexOf('{', pos);
    if (candidate < 0) throw new Error(`function ${name}: no body found`);
    const end = matchDelim(source, candidate, '{', '}');
    const between = source.slice(closeParen + 1, candidate).trim();
    const after = source.slice(end + 1).trimStart();
    if (between !== ':' && !after.startsWith('|')) return source.slice(idx, end + 1);
    pos = end + 1;
  }
}
function extractConstObject(source, name) {
  const idx = source.indexOf(`const ${name}`);
  if (idx < 0) throw new Error(`const ${name} not found`);
  const bodyStart = source.indexOf('{', idx);
  const bodyEnd = matchDelim(source, bodyStart, '{', '}');
  return source.slice(idx, bodyEnd + 1) + ';';
}
function extractHandler(source, actionName) {
  const start = source.indexOf(`${actionName}: defineAction({`);
  if (start < 0) throw new Error(`action ${actionName} not found`);
  const hIdx = source.indexOf('async handler', start);
  const openParen = source.indexOf('(', hIdx);
  const closeParen = matchDelim(source, openParen, '(', ')');
  const bodyStart = source.indexOf('{', closeParen);
  const bodyEnd = matchDelim(source, bodyStart, '{', '}');
  return `const ${actionName}Handler = async function (ctx, args) ${source.slice(bodyStart, bodyEnd + 1)};`;
}

// ------------------------------------------------------- (a) source level
const FIVE = ['push', 'pull', 'legs', 'home_posture', 'home_snowboard'];
const enumMatch = actionsSrc.match(/routine: z\.enum\(\[([^\]]+)\]\)/);
const enumValues = enumMatch ? [...enumMatch[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]) : [];
check('source: strength routine enum is exactly the five values', JSON.stringify(enumValues) === JSON.stringify(FIVE), enumValues.join(','));
check('source: STRENGTH_SYNC_PROMPT names all five routine values',
  FIVE.every((v) => actionsSrc.slice(actionsSrc.indexOf('const STRENGTH_SYNC_PROMPT')).includes(v)));
check('source: STRENGTH_SYNC_PROMPT requires verbatim preservation, no rewrite, no filtering',
  actionsSrc.includes("preserve each workout's routine value verbatim")
  && actionsSrc.includes('Never rewrite home_posture or home_snowboard as push, pull, or legs')
  && actionsSrc.includes('never omit or filter out a workout because of its routine'));
check('source: client ROUTINE_LABELS maps the home routines to the 训练记录 wording',
  clientSrc.includes('home_posture: "在家 A · 体态"') && clientSrc.includes('home_snowboard: "在家 B · 单板"'));
check('source: schema.ts declares the readiness_history table keyed by date',
  schemaSrc.includes('readinessHistory') && schemaSrc.includes('"readiness_history"') && /date: text\("date"\)\.primaryKey\(\)/.test(schemaSrc));
const migrationFiles = readdirSync(join(ROOT, 'drizzle')).filter((f) => f.endsWith('.sql'));
const archiveMigration = migrationFiles.map((f) => readFileSync(join(ROOT, 'drizzle', f), 'utf8')).find((sql) => sql.includes('readiness_history'));
check('source: an additive migration creates readiness_history', Boolean(archiveMigration) && archiveMigration.includes('CREATE TABLE'));
check('source: getDashboard response carries readinessHistory and the handler archives + reads the archive',
  actionsSrc.includes('readinessHistory: z.array(readinessHistoryPointSchema).max(7)')
  && actionsSrc.includes('await archiveReadiness(ctx, readiness, health.updatedAt, checkinVersion, checkinRevision, laTodayString())')
  && actionsSrc.includes('await loadReadinessTrendPoints(ctx, readinessDate)'));
check('source: getDashboard binds the check-in version at the same read as the feeling',
  actionsSrc.includes('updatedAt: schema.morningCheckin.updatedAt')
  && actionsSrc.includes('checkinRows[0].updatedAt.toISOString()'));
check('source: getDashboard binds the numeric check-in revision at that same read',
  actionsSrc.includes('revision: schema.morningCheckin.revision')
  && actionsSrc.includes('const checkinRevision = checkinRows[0]?.revision ?? null'));
check('source: schema.ts declares the nullable checkin_version column and an additive migration adds it',
  schemaSrc.includes('checkinVersion: text("checkin_version")')
  && migrationFiles.some((f) => readFileSync(join(ROOT, 'drizzle', f), 'utf8').includes('ADD COLUMN `checkin_version`')));
check('source: schema.ts declares morning_checkin.revision and readiness_history.checkin_revision as integers',
  schemaSrc.includes('revision: integer("revision")') && schemaSrc.includes('checkinRevision: integer("checkin_revision")'));
check('source: an additive migration adds both revision columns (no table rebuild, no data rewrite)',
  migrationFiles.some((f) => { const sql = readFileSync(join(ROOT, 'drizzle', f), 'utf8'); return sql.includes('ALTER TABLE `morning_checkin` ADD COLUMN `revision`') && sql.includes('ALTER TABLE `readiness_history` ADD COLUMN `checkin_revision`'); }));
{
  const saveBody = extractHandler(actionsSrc, 'saveMorningCheckin');
  check('source: saveMorningCheckin advances the revision inside the same atomic upsert (insert 1, conflict COALESCE+1 via SQL expression)',
    saveBody.includes('revision: 1') && saveBody.includes('.onConflictDoUpdate(')
    && saveBody.includes('revision: sql`COALESCE(${schema.morningCheckin.revision}, 0) + 1`'));
  check('source: saveMorningCheckin checks ownership before any write (a rejected save cannot advance the revision)',
    saveBody.indexOf('isOwner(ctx)') >= 0 && saveBody.indexOf('isOwner(ctx)') < saveBody.indexOf('db.insert'));
}
{
  const body = extractFunction(actionsSrc, 'archiveReadiness');
  check('source: archive upserts on the date key (same-day recompute overwrites, never duplicates)',
    body.includes('.onConflictDoUpdate(') && body.includes('target: schema.readinessHistory.date'));
  check('source: archive upsert is version-guarded atomically over BOTH input versions (strictly newer health, or equal health with check-in revision not older)',
    body.includes('setWhere:') && body.includes('excluded.snapshot_version IS NOT NULL')
    && body.includes('excluded.snapshot_version >') && body.includes('excluded.snapshot_version =')
    && body.includes('excluded.checkin_revision IS NOT NULL') && body.includes('excluded.checkin_revision >=')
    && body.includes('checkinRevision'));
  check('source: archive arbitration no longer judges freshness from the TEXT check-in version',
    !body.includes('excluded.checkin_version >=') && !body.includes('excluded.checkin_version >'));
  check('source: archive persists the check-in revision (and the legacy text version) alongside the health version',
    body.includes('checkinVersion,') && body.includes('checkinRevision,'));
  check('source: archive skips the write when readiness.date is not the caller-provided LA today',
    body.includes('readiness.date !== todayLA'));
  check('source: laTodayString computes the LA calendar date via Intl',
    extractFunction(actionsSrc, 'laTodayString').includes('America/Los_Angeles'));
  const noteMatch = body.match(/note: `([^`]*)`/);
  check('source: archive failure is ledger-visible and its note carries no health values',
    body.includes('recordSyncLog') && body.includes('status: "failed"')
    && noteMatch !== null && !noteMatch[1].includes('${readiness.score}') && !noteMatch[1].includes('components'));
  check('source: trend points are built only from archived rows (gaps stay null)',
    extractFunction(actionsSrc, 'buildReadinessTrendPoints').includes('byDate.get(date) ?? null'));
}

// ------------------------------------------- (b) real zod schema behaviour
const zmod = createRequire(join(ROOT, 'package.json'))('zod');
const z = zmod.z ?? zmod;
function buildSchemas(source) {
  const start = source.indexOf('const statusSchema');
  const end = source.indexOf('\ntype Snapshot');
  if (start < 0 || end < 0) throw new Error('schema block not found');
  const block = source.slice(start, end);
  const extra = extractFunction(source, 'normalizeStoredStrength');
  const factory = new Function('z', `${stripTypeScriptTypes(block)}\n${stripTypeScriptTypes(extra)}\nreturn { strengthTrainingSchema, snapshotSchema, normalizeStoredStrength };`);
  return factory(z);
}
const schemas = buildSchemas(actionsSrc);

const mkSet = () => ({ setNumber: 1, weight: 100, reps: 5, completed: true });
const mkExercise = () => ({ key: 'ex1', name: '合成动作', sets: [mkSet()], completedSets: 1, volume: 500 });
const mkWorkout = (routine, date = '2026-10-12', volume = 500, unit = 'lb') => ({
  id: `w-${routine}-${date}`, date, startedAt: `${date}T15:00:00.000Z`, completedAt: `${date}T16:00:00.000Z`,
  status: 'completed', routine, unit, durationMinutes: 60, completedSets: 1, totalSets: 1,
  totalVolume: volume, exercises: [mkExercise()],
});
const mkStrength = (workouts) => ({
  updatedAt: '2026-10-15T01:00:00.000Z', displayUnit: 'lb', workouts,
  weeklyTrend: [{ weekStart: '2026-10-12', sessions: workouts.length, volume: workouts.reduce((s, w) => s + w.totalVolume, 0) }],
  note: 'synthetic',
});
const roundTrip = (payload) => schemas.normalizeStoredStrength(JSON.parse(JSON.stringify(payload)));

for (const routine of FIVE) {
  const payload = mkStrength([mkWorkout(routine)]);
  const parsed = schemas.strengthTrainingSchema.safeParse(payload);
  const back = roundTrip(payload);
  check(`schema: routine ${routine} alone parses and round-trips verbatim`,
    parsed.success && back !== null && back.workouts[0].routine === routine);
}
{
  const payload = mkStrength(FIVE.map((r) => mkWorkout(r)));
  const back = roundTrip(payload);
  check('schema: mixed five-routine snapshot round-trips with every routine preserved in order',
    back !== null && JSON.stringify(back.workouts.map((w) => w.routine)) === JSON.stringify(FIVE));
}
{
  const payload = mkStrength([mkWorkout('home_posture'), mkWorkout('home_snowboard', '2026-10-13')]);
  check('schema: home-routines-only snapshot parses (no gym routine required)',
    schemas.strengthTrainingSchema.safeParse(payload).success && roundTrip(payload)?.workouts.length === 2);
}
check('schema: empty snapshot (no workouts) still parses', schemas.strengthTrainingSchema.safeParse(mkStrength([])).success);
check('schema: legacy snapshot with only push/pull/legs still parses',
  schemas.strengthTrainingSchema.safeParse(mkStrength([mkWorkout('push'), mkWorkout('pull'), mkWorkout('legs')])).success);
{
  const bad = mkStrength([mkWorkout('push'), mkWorkout('cardio')]);
  check('schema: unknown future routine fails validation and the stored-read normalizer rejects the payload whole',
    !schemas.strengthTrainingSchema.safeParse(bad).success && schemas.normalizeStoredStrength(JSON.parse(JSON.stringify(bad))) === null);
}

// ------------------------------ fake Drizzle-shaped adapter over sqlite
function colRef(table, col) { return { __colsql: `"${table}"."${col}"`, __colname: col }; }
const schemaStub = {
  healthSnapshot: { __table: 'health_snapshot', __cols: { id: 'id', payload: 'payload', sourceUpdatedAt: 'source_updated_at', createdAt: 'created_at', updatedAt: 'updated_at' }, id: colRef('health_snapshot', 'id'), payload: colRef('health_snapshot', 'payload'), sourceUpdatedAt: colRef('health_snapshot', 'source_updated_at') },
  strengthTrainingSnapshot: { __table: 'strength_training_snapshot', __cols: { id: 'id', payload: 'payload', sourceUpdatedAt: 'source_updated_at', createdAt: 'created_at', updatedAt: 'updated_at' }, id: colRef('strength_training_snapshot', 'id'), payload: colRef('strength_training_snapshot', 'payload'), sourceUpdatedAt: colRef('strength_training_snapshot', 'source_updated_at') },
  morningCheckin: { __table: 'morning_checkin', __cols: { date: 'date', feeling: 'feeling', revision: 'revision', createdAt: 'created_at', updatedAt: 'updated_at' }, date: colRef('morning_checkin', 'date'), feeling: colRef('morning_checkin', 'feeling'), revision: colRef('morning_checkin', 'revision'), updatedAt: colRef('morning_checkin', 'updated_at') },
  readinessHistory: { __table: 'readiness_history', __cols: { date: 'date', score: 'score', components: 'components', confidence: 'confidence', snapshotVersion: 'snapshot_version', checkinVersion: 'checkin_version', checkinRevision: 'checkin_revision', createdAt: 'created_at', updatedAt: 'updated_at' }, date: colRef('readiness_history', 'date'), score: colRef('readiness_history', 'score'), snapshotVersion: colRef('readiness_history', 'snapshot_version'), checkinVersion: colRef('readiness_history', 'checkin_version'), checkinRevision: colRef('readiness_history', 'checkin_revision') },
  syncLog: { __table: 'sync_log', __cols: { id: 'id', source: 'source', status: 'status', itemCount: 'item_count', note: 'note', sourceUpdatedAt: 'source_updated_at', createdAt: 'created_at' }, id: colRef('sync_log', 'id') },
};
function sqlTag(strings, ...values) {
  let text = '';
  const params = [];
  strings.forEach((s, i) => {
    text += s;
    if (i < values.length) {
      const v = values[i];
      if (v && v.__colsql) text += v.__colsql;
      else { text += '?'; params.push(v); }
    }
  });
  return { __sql: true, text, params };
}
const eqStub = (col, val) => ({ __op: '=', col, val });
const gteStub = (col, val) => ({ __op: '>=', col, val });
const lteStub = (col, val) => ({ __op: '<=', col, val });
const andStub = (...parts) => ({ __and: true, parts });
const ascStub = (col) => ({ __ord: 'ASC', col });
const descStub = (col) => ({ __ord: 'DESC', col });
const toDbVal = (v) => (v instanceof Date ? v.getTime() : v);

function whereSql(cond, params) {
  if (!cond) return '';
  if (cond.__and) return cond.parts.map((p) => whereSql(p, params)).join(' AND ');
  params.push(toDbVal(cond.val));
  return `${cond.col.__colsql} ${cond.__op} ?`;
}

class InsertBuilder {
  constructor(sqlite, table, failTables) { this.sqlite = sqlite; this.table = table; this.failTables = failTables; this.vals = null; this.conflict = null; this.wantReturning = false; this.executed = null; }
  values(v) { this.vals = v; return this; }
  onConflictDoUpdate(cfg) { this.conflict = cfg; return this; }
  returning() { this.wantReturning = true; return Promise.resolve(this.execute()); }
  then(onF, onR) { try { return Promise.resolve(this.execute()).then(onF, onR); } catch (e) { return Promise.reject(e).then(onF, onR); } }
  execute() {
    if (this.executed) return this.executed;
    if (this.failTables.has(this.table.__table)) throw new Error(`injected failure on ${this.table.__table}`);
    const cols = this.table.__cols;
    const keys = Object.keys(this.vals);
    const params = keys.map((k) => toDbVal(this.vals[k]));
    let text = `INSERT INTO "${this.table.__table}" (${keys.map((k) => `"${cols[k]}"`).join(',')}) VALUES (${keys.map(() => '?').join(',')})`;
    if (this.conflict) {
      const setKeys = Object.keys(this.conflict.set);
      // A set value may be a sql`` fragment (the morning_checkin revision
      // increment): inline its text and splice its params in key order,
      // exactly as Drizzle renders an expression assignment.
      text += ` ON CONFLICT("${this.conflict.target.__colname}") DO UPDATE SET ${setKeys.map((k) => {
        const v = this.conflict.set[k];
        return v && v.__sql ? `"${cols[k]}" = (${v.text})` : `"${cols[k]}" = ?`;
      }).join(',')}`;
      for (const k of setKeys) {
        const v = this.conflict.set[k];
        if (v && v.__sql) params.push(...(v.params ?? []));
        else params.push(toDbVal(v));
      }
      if (this.conflict.setWhere) { text += ` WHERE ${this.conflict.setWhere.text}`; params.push(...(this.conflict.setWhere.params ?? [])); }
    }
    if (this.wantReturning) text += ' RETURNING "id"';
    const stmt = this.sqlite.prepare(text);
    this.executed = this.wantReturning ? stmt.all(...params) : (stmt.run(...params), []);
    return this.executed;
  }
}
class SelectBuilder {
  constructor(sqlite, fields) { this.sqlite = sqlite; this.fields = fields; this.table = null; this.cond = null; this.ord = null; this.lim = null; }
  from(t) { this.table = t; return this; }
  where(c) { this.cond = c; return this; }
  orderBy(o) { this.ord = o; return this; }
  limit(n) { this.lim = n; return this; }
  then(onF, onR) {
    try {
      const cols = this.table.__cols;
      const params = [];
      const fieldKeys = this.fields ? Object.keys(this.fields) : null;
      const selectList = fieldKeys ? fieldKeys.map((k) => `"${cols[k]}" AS "${k}"`).join(',') : '*';
      let text = `SELECT ${selectList} FROM "${this.table.__table}"`;
      if (this.cond) text += ` WHERE ${whereSql(this.cond, params)}`;
      if (this.ord) text += ` ORDER BY ${this.ord.col.__colsql} ${this.ord.__ord}`;
      if (this.lim !== null) text += ` LIMIT ${this.lim}`;
      const raw = this.sqlite.prepare(text).all(...params);
      const rows = raw.map((r) => {
        const out = {};
        if (fieldKeys) {
          for (const k of fieldKeys) out[k] = cols[k].endsWith('_at') && r[k] != null ? new Date(r[k]) : r[k];
        } else {
          for (const [k, c] of Object.entries(cols)) out[k] = c.endsWith('_at') && r[c] != null ? new Date(r[c]) : r[c];
        }
        return out;
      });
      return Promise.resolve(rows).then(onF, onR);
    } catch (e) { return Promise.reject(e).then(onF, onR); }
  }
}
function freshSqlite() {
  const db = new DatabaseSync(':memory:');
  for (const t of ['health_snapshot', 'strength_training_snapshot']) {
    db.exec(`CREATE TABLE "${t}" (id INTEGER PRIMARY KEY, payload TEXT NOT NULL, source_updated_at INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`);
  }
  db.exec('CREATE TABLE "morning_checkin" (date TEXT PRIMARY KEY, feeling INTEGER NOT NULL, revision INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)');
  db.exec('CREATE TABLE "readiness_history" (date TEXT PRIMARY KEY, score REAL, components TEXT NOT NULL, confidence TEXT NOT NULL, snapshot_version TEXT, checkin_version TEXT, checkin_revision INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)');
  db.exec('CREATE TABLE "sync_log" (id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT NOT NULL, status TEXT NOT NULL, item_count INTEGER NOT NULL, note TEXT NOT NULL, source_updated_at INTEGER, created_at INTEGER NOT NULL)');
  return db;
}
function makeCtx(sqlite, viewer, failTables = new Set()) {
  const state = { invalidate: 0 };
  const fakeDb = { insert: (t) => new InsertBuilder(sqlite, t, failTables), select: (f) => new SelectBuilder(sqlite, f) };
  const ctx = {
    db: () => fakeDb,
    viewer,
    invalidateQueries: () => { state.invalidate++; },
    agent: { spawnTask: async () => ({ ok: false }) },
  };
  return { ctx, state };
}

// ------------------------------------------------- real server functions
const SERVER_FNS = [
  'clamp', 'round', 'signed', 'totalSleepHours', 'timeInBedHours', 'shiftDate', 'mondayWeekStart',
  'stats', 'scoreFromZ', 'tierFor', 'downgradeOneTier', 'bedtimeMinutes',
  'convertVolumeToUnit', 'sumWorkoutVolumeInUnit', 'normalizeSleepSnapshot', 'calculateReadiness',
  'normalizeStoredSnapshot', 'normalizeStoredStrength', 'isOwner',
  'loadHealthSnapshot', 'loadStrengthSnapshot', 'effectiveStrength',
  'persistStrengthSnapshot', 'recordSyncLog', 'loadRecentLogs',
  'freshnessFor', 'buildDataStatus', 'buildUnifiedTimeline',
  'buildReadinessTrendPoints', 'loadReadinessTrendPoints', 'archiveReadiness', 'maybeAutoSyncStrength', 'laTodayString',
];
function buildServerImpl(source) {
  let code = SERVER_FNS.map((n) => extractFunction(source, n)).join('\n');
  code += '\n' + extractConstObject(source, 'EMPTY_STRENGTH');
  code += '\n' + extractConstObject(source, 'CORRUPT_STRENGTH_PLACEHOLDER');
  code += '\n' + extractHandler(source, 'getDashboard');
  code += '\n' + extractHandler(source, 'saveMorningCheckin');
  const prelude = 'const LB_TO_KG = 0.45359237;\nconst STRENGTH_SYNC_PROMPT = "stub";\nlet lastAutoStrengthSpawnAt = 0;\nlet lastAutoStrengthTaskId = null;\n';
  const factory = new Function('schema', 'sql', 'eq', 'desc', 'asc', 'and', 'gte', 'lte', 'snapshotSchema', 'strengthTrainingSchema',
    prelude + stripTypeScriptTypes(code)
    + '\nreturn { persistStrengthSnapshot, loadStrengthSnapshot, loadHealthSnapshot, calculateReadiness, buildUnifiedTimeline, buildReadinessTrendPoints, loadReadinessTrendPoints, archiveReadiness, getDashboardHandler, saveMorningCheckinHandler, laTodayString };');
  return factory(schemaStub, sqlTag, eqStub, descStub, ascStub, andStub, gteStub, lteStub, schemas.snapshotSchema, schemas.strengthTrainingSchema);
}
const impl = buildServerImpl(actionsSrc);

// --------------------------- (c) persist → load round trip via real paths
{
  const db = freshSqlite();
  const { ctx } = makeCtx(db, null); // no-viewer sync channel, as the real callback arrives
  const mixed = mkStrength(FIVE.map((r, i) => mkWorkout(r, `2026-10-${12 + i}`)));
  const outcome = await impl.persistStrengthSnapshot(ctx, mixed);
  const loaded = await impl.loadStrengthSnapshot(ctx);
  check('persist: mixed five-routine snapshot is applied via the real persist path', outcome === 'applied');
  check('persist: load returns every routine verbatim, none remapped or dropped',
    loaded.state === 'ok' && JSON.stringify(loaded.strength.workouts.map((w) => w.routine)) === JSON.stringify(FIVE));
  // The save action's request schema is strengthTrainingSchema itself: an
  // unknown routine is rejected by validation BEFORE the handler runs, so
  // persist is never invoked and the stored snapshot stays untouched.
  const bad = mkStrength([mkWorkout('push'), mkWorkout('cardio')]);
  const rejected = !schemas.strengthTrainingSchema.safeParse(bad).success;
  const after = await impl.loadStrengthSnapshot(ctx);
  check('persist: unknown-routine snapshot is rejected at the schema gate; the stored snapshot is kept whole',
    rejected && after.state === 'ok' && after.strength.workouts.length === 5);
  const homeOnly = { ...mkStrength([mkWorkout('home_posture'), mkWorkout('home_snowboard', '2026-10-13')]), updatedAt: '2026-10-15T02:00:00.000Z' };
  const outcome2 = await impl.persistStrengthSnapshot(ctx, homeOnly);
  const loaded2 = await impl.loadStrengthSnapshot(ctx);
  check('persist: home-routines-only snapshot saves and reads back as-is',
    outcome2 === 'applied' && loaded2.strength.workouts.map((w) => w.routine).join(',') === 'home_posture,home_snowboard');
}

// --------------------------------- (d) aggregation: unified timeline counts
{
  const strength = {
    updatedAt: '2026-10-15T01:00:00.000Z', displayUnit: 'kg',
    workouts: [
      mkWorkout('push', '2026-10-12', 100, 'lb'),
      mkWorkout('home_posture', '2026-10-12', 100, 'kg'),
      mkWorkout('home_snowboard', '2026-10-12', 50, 'lb'),
      mkWorkout('pull', '2026-10-13', 200, 'lb'),
    ],
    weeklyTrend: [], note: 'synthetic',
  };
  const days = impl.buildUnifiedTimeline(null, strength);
  const d12 = days.find((d) => d.date === '2026-10-12');
  const d13 = days.find((d) => d.date === '2026-10-13');
  check('timeline: a day with push + both home routines counts all 3 sessions',
    d12 !== undefined && d12.strengthSessions === 3 && d12.hasStrength);
  check('timeline: strengthRoutines carries the home values verbatim',
    d12 !== undefined && ['push', 'home_posture', 'home_snowboard'].every((r) => d12.strengthRoutines.includes(r)));
  check('timeline: mixed-unit volume converts into the display unit (100 lb + 100 kg + 50 lb = 168.0 kg)',
    d12 !== undefined && d12.strengthVolume === 168.0, d12 ? `got ${d12.strengthVolume}` : 'day missing');
  check('timeline: next day counts the pull session alone (200 lb = 90.7 kg)',
    d13 !== undefined && d13.strengthSessions === 1 && d13.strengthVolume === 90.7);
}

// --------------------------------------- (e) aggregation: H-LOAD weekLoad
function buildWeekLoad(source) {
  const names = ['mondayOf', 'shiftDateStr', 'percentBand', 'recoveryScore', 'volumeLabel', 'volumeInDisplayUnit', 'dateLabel', 'weekLoad'];
  const lbLine = source.match(/const LB_TO_KG = [^;]+;/)[0];
  const code = names.map((n) => extractFunction(source, n)).join('\n');
  return new Function(`${lbLine}\n${stripTypeScriptTypes(code)}\nreturn weekLoad;`)();
}
const weekLoad = buildWeekLoad(clientSrc);
function weekLoadSnapshot(hkWorkouts) {
  const dailyDates = [];
  for (let d = 28; d <= 30; d++) dailyDates.push(`2026-09-${d}`);
  for (let d = 1; d <= 14; d++) dailyDates.push(`2026-10-${String(d).padStart(2, '0')}`);
  const cw = (routine, date) => ({ ...mkWorkout(routine, date), exercises: [] });
  return {
    dataDate: '2026-10-14', coverageIncomplete: false, historySleeps: [], historyWorkouts: hkWorkouts,
    historyDaily: dailyDates.map((date) => ({ date, exerciseMinutes: 30 })),
    strengthTraining: {
      updatedAt: '2026-10-14T16:00:00.000Z', displayUnit: 'lb',
      workouts: [cw('push', '2026-10-12'), cw('home_posture', '2026-10-13'), cw('home_snowboard', '2026-10-14'), cw('pull', '2026-10-05'), cw('home_posture', '2026-10-06')],
      weeklyTrend: [
        { weekStart: '2026-10-05', sessions: 2, volume: 1000, coverageComplete: true, measuredCompletedSets: 10, unmeasuredCompletedSets: 0 },
        { weekStart: '2026-10-12', sessions: 3, volume: 1500, coverageComplete: true, measuredCompletedSets: 10, unmeasuredCompletedSets: 0 },
      ],
    },
  };
}
{
  const load = weekLoad(weekLoadSnapshot([]), null);
  check('weekLoad: home routines count as strength sessions in both windows (3 this week, 2 last)',
    load.current.strengthSessions === 3 && load.previous.strengthSessions === 2,
    `got ${load.current.strengthSessions}/${load.previous.strengthSessions}`);
  check('weekLoad: full coverage with home routines stays sufficient and compares (+50% sessions)',
    load.sufficient === true && load.sessionsChangePct === 50, load.reasons.join(';'));
  const hkStrength = [{ id: 'hk1', date: '2026-10-13', type: 'traditional_strength_training', durationMinutes: 45, energyKcal: 200, distanceMeters: null, averageHr: 110 }];
  const ambiguous = weekLoad(weekLoadSnapshot(hkStrength), null);
  check('weekLoad: same-day HK strength session + home-routine workout keeps the ambiguity downgrade (no merge, no verdict)',
    ambiguous.sufficient === false && ambiguous.reasons.some((r) => r.includes('归属未确认')));
  check('weekLoad: the ambiguous HK session is still counted, not silently dropped',
    ambiguous.current.healthKitSessions === 1 && ambiguous.current.sessions === 4);
}

// --------------------------- (f) readiness archive: functions + getDashboard
const mkReadiness = (date, score) => ({
  date, score, objectiveScore: score, status: '准备就绪', summary: 'synthetic', availableWeight: 57.5,
  confidence: '中', signalCount: 4, sleepDebtHours: 1.2, morningFeeling: null, adjustments: [],
  components: [
    { key: 'hrv', label: 'HRV', weight: 32.5, score: 6, zScore: 0.5, contribution: 0.3, raw: '40 ms', baseline: 'x', detail: 'x', missingLabel: null },
    { key: 'restingHr', label: '静息心率', weight: 25, score: 6, zScore: 0.4, contribution: 0.2, raw: '60 bpm', baseline: 'x', detail: 'x', missingLabel: null },
  ],
  radar: [],
});
const archiveRows = (db) => db.prepare('SELECT date, score, confidence, snapshot_version, checkin_version, checkin_revision, components FROM readiness_history ORDER BY date').all();
const checkinRow = (db, date) => db.prepare('SELECT date, feeling, revision, created_at, updated_at FROM morning_checkin WHERE date = ?').get(date);
{
  const db = freshSqlite();
  const { ctx } = makeCtx(db, { isOwner: true });
  await impl.archiveReadiness(ctx, mkReadiness('2026-10-18', 7.5), '2026-10-18T15:00:00.000Z', null, null, '2026-10-18');
  let rows = archiveRows(db);
  check('archive: first computation lands exactly one row with score, confidence, snapshot version, components',
    rows.length === 1 && rows[0].score === 7.5 && rows[0].confidence === '中'
    && rows[0].snapshot_version === '2026-10-18T15:00:00.000Z' && JSON.parse(rows[0].components).length === 2);
  await impl.archiveReadiness(ctx, mkReadiness('2026-10-18', 8.0), '2026-10-18T16:00:00.000Z', null, null, '2026-10-18');
  rows = archiveRows(db);
  check('archive: same-day recomputation still leaves one row, holding the latest score',
    rows.length === 1 && rows[0].score === 8.0 && rows[0].snapshot_version === '2026-10-18T16:00:00.000Z');
  await impl.archiveReadiness(ctx, mkReadiness('2026-10-19', 6.0), '2026-10-19T15:00:00.000Z', null, null, '2026-10-19');
  rows = archiveRows(db);
  check('archive: the next day adds a second row', rows.length === 2 && rows[1].date === '2026-10-19' && rows[1].score === 6.0);
  const trend = await impl.loadReadinessTrendPoints(ctx, '2026-10-19');
  check('archive: trend returns the 7 dates ending at the readiness date, ascending',
    trend.length === 7 && trend[0].date === '2026-10-13' && trend[6].date === '2026-10-19');
  check('archive: trend shows each archived date\'s own score',
    trend[5].score === 8.0 && trend[6].score === 6.0);
  check('archive: unarchived dates stay gaps — never filled with today\'s or any other day\'s score',
    trend.slice(0, 5).every((p) => p.score === null));
  await impl.archiveReadiness(ctx, mkReadiness('2026-10-20', null), '2026-10-20T15:00:00.000Z', null, null, '2026-10-20');
  const trend2 = await impl.loadReadinessTrendPoints(ctx, '2026-10-20');
  check('archive: a day archived with a null score （数据不足） still renders as a gap, not a number',
    trend2[6].date === '2026-10-20' && trend2[6].score === null && trend2[5].score === 6.0);
}
{
  const db = freshSqlite();
  const { ctx } = makeCtx(db, { isOwner: true }, new Set(['readiness_history']));
  let threw = false;
  try { await impl.archiveReadiness(ctx, mkReadiness('2026-10-18', 7.5), 'v1', null, null, '2026-10-18'); } catch { threw = true; }
  const failed = db.prepare("SELECT note FROM sync_log WHERE status = 'failed'").all();
  check('archive: a write failure is swallowed by archiveReadiness (the dashboard response is not blocked)', !threw);
  check('archive: the failure is visible in the sync ledger, with no health values in the note',
    failed.length === 1 && !failed[0].note.includes('7.5') && failed[0].note.includes('存档'));
  const trend = await impl.loadReadinessTrendPoints(ctx, '2026-10-18');
  check('archive: trend after a failed write shows gaps only (nothing invented)',
    trend.length === 7 && trend.every((p) => p.score === null));
}

// --------------------- (h) H-ARCHIVE-SAFE-001: date + version gates
{
  check('laTodayString: 06:30Z is still yesterday in LA (PDT, UTC-7)',
    impl.laTodayString(new Date('2026-10-19T06:30:00.000Z')) === '2026-10-18');
  check('laTodayString: 07:30Z is today in LA (PDT)',
    impl.laTodayString(new Date('2026-10-19T07:30:00.000Z')) === '2026-10-19');
  check('laTodayString: winter boundary uses PST (UTC-8)',
    impl.laTodayString(new Date('2026-01-15T07:30:00.000Z')) === '2026-01-14'
    && impl.laTodayString(new Date('2026-01-15T08:30:00.000Z')) === '2026-01-15');
  check('laTodayString: DST spring-forward day resolves to the LA date',
    impl.laTodayString(new Date('2026-03-08T10:30:00.000Z')) === '2026-03-08');
}
{
  const db = freshSqlite();
  const { ctx } = makeCtx(db, { isOwner: true });
  const D = '2026-10-18';
  await impl.archiveReadiness(ctx, mkReadiness(D, 8.0), '2026-10-18T18:00:00.000Z', null, null, D);
  await impl.archiveReadiness(ctx, mkReadiness(D, 3.0), '2026-10-18T16:00:00.000Z', null, null, D);
  let rows = archiveRows(db);
  check('archive-safe: a late-arriving OLDER version does not roll back the stored score',
    rows.length === 1 && rows[0].score === 8.0 && rows[0].snapshot_version === '2026-10-18T18:00:00.000Z');
  await impl.archiveReadiness(ctx, mkReadiness(D, 6.5), '2026-10-18T18:00:00.000Z', null, null, D);
  rows = archiveRows(db);
  check('archive-safe: the SAME health version with no check-in on either side may overwrite (same-input recompute)',
    rows.length === 1 && rows[0].score === 6.5 && rows[0].snapshot_version === '2026-10-18T18:00:00.000Z');
  await impl.archiveReadiness(ctx, mkReadiness(D, 9.9), null, null, null, D);
  rows = archiveRows(db);
  check('archive-safe: a null version never overwrites an existing row',
    rows.length === 1 && rows[0].score === 6.5 && rows[0].snapshot_version === '2026-10-18T18:00:00.000Z');
  const D2 = '2026-10-19';
  await impl.archiveReadiness(ctx, mkReadiness(D2, 5.0), null, null, null, D2);
  rows = archiveRows(db);
  check('archive-safe: a null version may still be the FIRST insert for a date (next day adds normally)',
    rows.length === 2 && rows[1].date === D2 && rows[1].score === 5.0 && rows[1].snapshot_version === null);
  await impl.archiveReadiness(ctx, mkReadiness(D2, 7.0), null, null, null, D2);
  rows = archiveRows(db);
  check('archive-safe: a second null-version write does not overwrite the null-version row',
    rows.length === 2 && rows[1].score === 5.0);
  await impl.archiveReadiness(ctx, mkReadiness(D2, 7.5), '2026-10-19T15:00:00.000Z', null, null, D2);
  rows = archiveRows(db);
  check('archive-safe: a versioned write supersedes a null-version row',
    rows.length === 2 && rows[1].score === 7.5 && rows[1].snapshot_version === '2026-10-19T15:00:00.000Z');
}
{
  const db = freshSqlite();
  const { ctx } = makeCtx(db, { isOwner: true });
  await impl.archiveReadiness(ctx, mkReadiness('2000-01-01', 5.0), 'v1', null, null, '2026-10-19');
  await impl.archiveReadiness(ctx, mkReadiness('2026-10-20', 5.0), 'v1', null, null, '2026-10-19');
  await impl.archiveReadiness(ctx, mkReadiness('2026-10-19', 5.0), 'v1', null, null, 'not-a-date');
  check('archive-safe: old / future / malformed-today dates write ZERO rows', archiveRows(db).length === 0);
  check('archive-safe: date-gate skips are silent — no failure ledger entry masquerades as a fault',
    db.prepare("SELECT COUNT(*) AS n FROM sync_log WHERE status = 'failed'").get().n === 0);
  await impl.archiveReadiness(ctx, mkReadiness('2026-10-19', 5.0), 'v1', null, null, '2026-10-19');
  check('archive-safe: the matching LA-today date archives normally', archiveRows(db).length === 1);
}

// ------------- (i) H-ARCHIVE-SAFE-001 check-in race: revision matrix
// The PM scenario: under ONE health snapshot version, request A reads
// check-in revision r1 and pauses before its archive write; request B
// reads revision r2 (newer), computes, and archives; A then lands its
// stale write. The trend must keep B's score. The CVn constants are the
// legacy TEXT versions (the row's updated_at at each save) — still
// passed and still stored, but arbitration must ignore them; the Rn
// constants are the numeric revisions that now decide. Scores are
// synthetic stand-ins for "computed from that check-in" — what is under
// test is purely which write the atomic arbitration accepts.
{
  const HV = '2026-10-19T14:00:00.000Z';       // the one health version both requests share
  const HV_OLD = '2026-10-19T12:00:00.000Z';   // a strictly older health version
  const HV_NEW = '2026-10-19T16:00:00.000Z';   // a strictly newer health version
  const CV1 = '2026-10-19T13:05:00.000Z';      // check-in text version as first saved
  const CV2 = '2026-10-19T13:20:00.000Z';      // check-in text version after the user edits it
  const CV3 = '2026-10-19T13:40:00.000Z';      // an even newer check-in text version
  const R1 = 1;                                // revision of the first save
  const R2 = 2;                                // revision after the edit
  const R3 = 3;                                // an even newer revision
  const D = '2026-10-19';
  {
    const db = freshSqlite();
    const { ctx } = makeCtx(db, { isOwner: true });
    // B (newer check-in revision) lands first.
    await impl.archiveReadiness(ctx, mkReadiness(D, 8.0), HV, CV2, R2, D);
    // A (older check-in revision, same health version) arrives late.
    await impl.archiveReadiness(ctx, mkReadiness(D, 3.0), HV, CV1, R1, D);
    const rows = archiveRows(db);
    check('checkin-race: PM order — the late OLD-revision write is rejected; the row keeps the new revision score and revision',
      rows.length === 1 && rows[0].score === 8.0 && rows[0].checkin_revision === R2 && rows[0].snapshot_version === HV,
      `score=${rows[0]?.score}, rev=${rows[0]?.checkin_revision}`);
    check('checkin-race: the legacy text check-in version is still stored alongside (compatibility only)',
      rows[0].checkin_version === CV2);
    // Idempotent replay of the winning input: same health + same
    // check-in revision recomputes the same result and may overwrite.
    await impl.archiveReadiness(ctx, mkReadiness(D, 8.0), HV, CV2, R2, D);
    const rows2 = archiveRows(db);
    check('checkin-race: identical input replayed (same health + same check-in revision) does not regress the row',
      rows2.length === 1 && rows2[0].score === 8.0 && rows2[0].checkin_revision === R2);
    // A write computed with NO check-in must not displace a score that
    // was computed WITH one, at equal health version.
    await impl.archiveReadiness(ctx, mkReadiness(D, 9.9), HV, null, null, D);
    const rows3 = archiveRows(db);
    check('checkin-race: incoming null check-in revision never overwrites a stored non-null one at equal health version',
      rows3.length === 1 && rows3[0].score === 8.0 && rows3[0].checkin_revision === R2);
    // A strictly newer HEALTH version wins outright, whatever the
    // check-in revisions say.
    await impl.archiveReadiness(ctx, mkReadiness(D, 7.0), HV_NEW, null, null, D);
    const rows4 = archiveRows(db);
    check('checkin-race: a strictly newer health version is accepted even with a null check-in revision',
      rows4.length === 1 && rows4[0].score === 7.0 && rows4[0].snapshot_version === HV_NEW && rows4[0].checkin_revision === null);
  }
  {
    const db = freshSqlite();
    const { ctx } = makeCtx(db, { isOwner: true });
    // Reverse order: the older check-in revision lands first, the newer second.
    await impl.archiveReadiness(ctx, mkReadiness(D, 3.0), HV, CV1, R1, D);
    await impl.archiveReadiness(ctx, mkReadiness(D, 8.0), HV, CV2, R2, D);
    const rows = archiveRows(db);
    check('checkin-race: reverse order — same health version + NEWER check-in revision updates the row',
      rows.length === 1 && rows[0].score === 8.0 && rows[0].checkin_revision === R2);
    // An older HEALTH version is blocked even when it carries the
    // newest check-in revision of all.
    await impl.archiveReadiness(ctx, mkReadiness(D, 1.0), HV_OLD, CV3, R3, D);
    const rows2 = archiveRows(db);
    check('checkin-race: an older health version is rejected even with a newer check-in revision',
      rows2.length === 1 && rows2[0].score === 8.0 && rows2[0].snapshot_version === HV);
  }
  {
    const db = freshSqlite();
    const { ctx } = makeCtx(db, { isOwner: true });
    // Null check-in revision on both sides: first insert lands, and at
    // equal health version a later no-check-in recompute may still
    // overwrite (stored null = oldest), while a real revision then
    // takes over and locks out further null-revision writes.
    await impl.archiveReadiness(ctx, mkReadiness(D, 5.0), HV, null, null, D);
    await impl.archiveReadiness(ctx, mkReadiness(D, 5.5), HV, null, null, D);
    let rows = archiveRows(db);
    check('checkin-race: null check-in first insert lands; equal health + stored-null revision may be overwritten by another null',
      rows.length === 1 && rows[0].score === 5.5 && rows[0].checkin_revision === null);
    await impl.archiveReadiness(ctx, mkReadiness(D, 6.5), HV, CV1, R1, D);
    rows = archiveRows(db);
    check('checkin-race: a real check-in revision supersedes the null-revision row at equal health version',
      rows.length === 1 && rows[0].score === 6.5 && rows[0].checkin_revision === R1);
  }
  {
    // Legacy row: archived before revisions existed — checkin_revision
    // is null while a TEXT checkin_version from the old arbitration era
    // is present. The numeric column alone decides: null counts as the
    // OLDEST revision, so a same-health-version write carrying any real
    // revision covers it, and the row is upgraded in place (never
    // deleted, never recomputed by the migration).
    const db = freshSqlite();
    const { ctx } = makeCtx(db, { isOwner: true });
    db.prepare('INSERT INTO readiness_history (date, score, components, confidence, snapshot_version, checkin_version, checkin_revision, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)')
      .run(D, 4.0, '[]', '中', HV, CV1, Date.now(), Date.now());
    await impl.archiveReadiness(ctx, mkReadiness(D, 6.0), HV, CV1, R1, D);
    const rows = archiveRows(db);
    check('checkin-race: a legacy row (text version only, checkin_revision null) is covered by a same-health-version write with a revision',
      rows.length === 1 && rows[0].score === 6.0 && rows[0].checkin_revision === R1 && rows[0].snapshot_version === HV);
    // …but a legacy row still resists an older HEALTH version.
    await impl.archiveReadiness(ctx, mkReadiness(D, 2.0), HV_OLD, CV3, R3, D);
    const rows2 = archiveRows(db);
    check('checkin-race: the upgraded row still rejects an older health version',
      rows2.length === 1 && rows2[0].score === 6.0);
  }
  {
    // Null HEALTH version with a check-in revision: first insert only,
    // exactly like the pre-existing null-health rule.
    const db = freshSqlite();
    const { ctx } = makeCtx(db, { isOwner: true });
    await impl.archiveReadiness(ctx, mkReadiness(D, 5.0), null, CV1, R1, D);
    await impl.archiveReadiness(ctx, mkReadiness(D, 9.0), null, CV2, R2, D);
    const rows = archiveRows(db);
    check('checkin-race: a null health version may only be the first insert, even with a newer check-in revision',
      rows.length === 1 && rows[0].score === 5.0 && rows[0].checkin_revision === R1);
  }
}

// getDashboard end-to-end: compute → archive → trend, through the real
// handler, over a stored synthetic health snapshot (setup row written
// directly; everything under test — read, compute, archive, trend — is
// the real production code).
function healthSnapshotPayload(dataDate, updatedAt, morningDate) {
  const daily = [];
  for (let i = 15; i >= 1; i--) {
    const d = new Date(`${dataDate}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() - i);
    const date = d.toISOString().slice(0, 10);
    daily.push({ date, steps: 8000, activeKcal: 400, exerciseMinutes: 30, restingHr: 60 + (i % 3), hrvMs: 40 + (i % 4), respiratoryRate: 14, weightKg: 80, swimMeters: null, hrMax: 150 });
  }
  daily.push({ date: dataDate, steps: 8200, activeKcal: 420, exerciseMinutes: 35, restingHr: 61, hrvMs: 41, respiratoryRate: 14, weightKg: 80, swimMeters: null, hrMax: 152 });
  return {
    dataDate, updatedAt, timezone: 'America/Los_Angeles', coverageIncomplete: false,
    steps: { value: 8200, baseline: 8000, usualMin: 7000, usualMax: 9000, distanceKm: 6, flights: 3, basalKcal: 1700, status: '正常' },
    restingHr: { value: 61, baseline: 60, usualMin: 57, usualMax: 63, status: '正常' },
    hrv: { value: 41, baseline: 40, usualMin: 32, usualMax: 48, status: '正常' },
    respiratoryRate: { value: 14, status: '正常' },
    sleep: { bedtime: '23:00', wakeTime: '07:00', inBedHours: 7.5, coreHours: 5, deepHours: 1, remHours: 1.5, awakeMinutes: 12, quality: 82, efficiency: 92, awakenings: 1, status: '正常' },
    morningReference: { date: morningDate, hrvMs: 42, avgHrBpm: 58 },
    strengthTraining: { updatedAt: null, displayUnit: 'lb', workouts: [], weeklyTrend: [], note: 'synthetic' },
    workouts: { count7d: 2, baselinePerWeek: 2, note: 'synthetic' },
    trends: [{ date: dataDate, stepCount: 8200, restingHrBpm: 61, hrvMs: 41 }],
    historyDaily: daily,
    historyWorkouts: [],
    historySleeps: [{ date: morningDate, start: '23:00', end: '07:00', totalHours: 7.5, coreHours: 5, deepHours: 1, remHours: 1.5, awakeMinutes: 12, quality: 82, awakenings: 1, efficiency: 92 }],
  };
}
function storeHealth(db, payload) {
  db.prepare('INSERT OR REPLACE INTO health_snapshot (id, payload, source_updated_at, created_at, updated_at) VALUES (1, ?, ?, ?, ?)')
    .run(JSON.stringify(payload), Date.parse(payload.updatedAt), Date.now(), Date.now());
}
// The dashboard fixtures anchor on the REAL LA today: since
// H-ARCHIVE-SAFE-001, getDashboard archives only when the readiness date
// is LA today, so a fixture pinned to a fixed past date would exercise
// the skip path instead of the archive path.
const LA_TODAY = (() => {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const part = (t) => parts.find((p) => p.type === t)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
})();
const dayShift = (date, days) => { const d = new Date(`${date}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); };
{
  const db = freshSqlite();
  const { ctx } = makeCtx(db, { isOwner: true });
  storeHealth(db, healthSnapshotPayload(dayShift(LA_TODAY, -1), '2026-01-01T15:00:00.000Z', LA_TODAY));
  const res1 = await impl.getDashboardHandler(ctx, {});
  check('dashboard: first owner open computes readiness and returns it',
    res1.forbidden === false && res1.readiness !== null && typeof res1.readiness.score === 'number');
  let rows = archiveRows(db);
  check('dashboard: the computed score is archived under the readiness date (LA today) with the snapshot version',
    rows.length === 1 && rows[0].date === LA_TODAY && rows[0].score === res1.readiness.score
    && rows[0].snapshot_version === '2026-01-01T15:00:00.000Z');
  check('dashboard: with NO check-in for the date, the archive row binds a null check-in revision (and null text version)',
    rows[0].checkin_revision === null && rows[0].checkin_version === null);
  check('dashboard: the returned trend ends at the readiness date with the archived score; earlier days are gaps',
    res1.readinessHistory.length === 7 && res1.readinessHistory[6].date === LA_TODAY
    && res1.readinessHistory[6].score === res1.readiness.score && res1.readinessHistory.slice(0, 6).every((p) => p.score === null));
  const res2 = await impl.getDashboardHandler(ctx, {});
  rows = archiveRows(db);
  check('dashboard: a second open the same day still leaves exactly one archive row',
    res2.forbidden === false && rows.length === 1);
}
{
  // Check-in version binding (H-ARCHIVE-SAFE-001 race fix + revision
  // follow-up): the handler reads the morning check-in row for the
  // readiness date and the archive row must carry THAT row's revision as
  // its checkin_revision — the version of the input the score was
  // actually computed from — with the updated_at text version still
  // recorded alongside for compatibility.
  const db = freshSqlite();
  const { ctx } = makeCtx(db, { isOwner: true });
  storeHealth(db, healthSnapshotPayload(dayShift(LA_TODAY, -1), '2026-01-01T15:00:00.000Z', LA_TODAY));
  const checkinMs = Date.parse('2026-01-02T15:30:00.000Z');
  db.prepare('INSERT INTO morning_checkin (date, feeling, revision, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run(LA_TODAY, 4, 7, checkinMs, checkinMs);
  const res = await impl.getDashboardHandler(ctx, {});
  const rows = archiveRows(db);
  check('dashboard: the readiness uses the stored check-in feeling',
    res.forbidden === false && res.readiness !== null && res.readiness.morningFeeling === 4);
  check('dashboard: the archive row binds the check-in REVISION read with the feeling',
    rows.length === 1 && rows[0].checkin_revision === 7,
    `rev=${rows[0]?.checkin_revision}`);
  check('dashboard: the archive row still records the text check-in version (updated_at, as an ISO instant)',
    rows.length === 1 && rows[0].checkin_version === '2026-01-02T15:30:00.000Z',
    `cv=${rows[0]?.checkin_version}`);
}
{
  // Stale snapshot opened today (H-ARCHIVE-SAFE-001): the readiness is
  // still computed and returned, but its date is not LA today, so
  // nothing is archived — past dates are never backfilled by opening an
  // old snapshot, and the skip writes no failure ledger entry.
  const db = freshSqlite();
  const { ctx } = makeCtx(db, { isOwner: true });
  storeHealth(db, healthSnapshotPayload(dayShift(LA_TODAY, -4), '2026-01-01T15:00:00.000Z', dayShift(LA_TODAY, -3)));
  const res = await impl.getDashboardHandler(ctx, {});
  check('dashboard: a stale snapshot still computes and returns its readiness (main response unaffected)',
    res.forbidden === false && res.readiness !== null && res.readiness.date === dayShift(LA_TODAY, -3)
    && typeof res.readiness.score === 'number');
  check('dashboard: opening a stale snapshot archives NOTHING and writes no failure entry',
    archiveRows(db).length === 0
    && db.prepare("SELECT COUNT(*) AS n FROM sync_log WHERE status = 'failed'").get().n === 0);
  check('dashboard: with nothing archived, the stale trend is all gaps (its score is not dressed up as history)',
    res.readinessHistory.length === 7 && res.readinessHistory.every((p) => p.score === null));
}
{
  const db = freshSqlite();
  const { ctx } = makeCtx(db, { isOwner: true }, new Set(['readiness_history']));
  storeHealth(db, healthSnapshotPayload(dayShift(LA_TODAY, -1), '2026-01-01T15:00:00.000Z', LA_TODAY));
  const res = await impl.getDashboardHandler(ctx, {});
  check('dashboard: with the archive table failing, the main response still returns snapshot + readiness intact',
    res.forbidden === false && res.snapshot !== null && res.readiness !== null && typeof res.readiness.score === 'number');
  check('dashboard: with the archive failing, the trend degrades to gaps and the failure is ledger-visible',
    res.readinessHistory.every((p) => p.score === null)
    && db.prepare("SELECT COUNT(*) AS n FROM sync_log WHERE status = 'failed'").get().n >= 1);
}
{
  const db = freshSqlite();
  const { ctx } = makeCtx(db, { isOwner: false });
  storeHealth(db, healthSnapshotPayload(dayShift(LA_TODAY, -1), '2026-01-01T15:00:00.000Z', LA_TODAY));
  const res = await impl.getDashboardHandler(ctx, {});
  check('dashboard: non-owner stays forbidden with zero data and writes no archive row',
    res.forbidden === true && res.readiness === null && res.readinessHistory.length === 0 && archiveRows(db).length === 0);
}

// ------- (j) revision follow-up: same-millisecond PM counterexample
// End to end through the REAL saveMorningCheckin handler, the REAL
// calculateReadiness and the REAL getDashboard handler, with the clock
// frozen so both saves land in the SAME millisecond: their updated_at
// (the old text input version) is byte-identical, so under the pre-fix
// arbitration the two inputs were indistinguishable. The persistent
// revision must still order them: reader A binds feeling=9 / revision 1
// and pauses before its archive write; feeling=2 / revision 2 is saved
// in the same millisecond; reader B (the real getDashboard) computes
// from feeling=2 and archives; A resumes its late write — the archive
// must keep B's score, and the check-in row must still hold feeling=2.
const RealDate = Date;
class FrozenDate extends RealDate {
  constructor(...args) { super(...(args.length > 0 ? args : [FrozenDate.fixedMs])); }
  static now() { return FrozenDate.fixedMs; }
  static parse(s) { return RealDate.parse(s); }
  static UTC(...a) { return RealDate.UTC(...a); }
}
FrozenDate.fixedMs = 0;
function freezeClock(ms) { FrozenDate.fixedMs = ms; globalThis.Date = FrozenDate; }
function unfreezeClock() { globalThis.Date = RealDate; }
{
  const HV_ISO = '2026-01-01T15:00:00.000Z';
  const FIXED_MS = RealDate.parse(`${LA_TODAY}T15:00:00.000Z`); // 15:00Z is the same LA calendar day, morning PT
  {
    const db = freshSqlite();
    const { ctx } = makeCtx(db, { isOwner: true });
    storeHealth(db, healthSnapshotPayload(dayShift(LA_TODAY, -1), HV_ISO, LA_TODAY));
    freezeClock(FIXED_MS);
    try {
      const save1 = await impl.saveMorningCheckinHandler(ctx, { date: LA_TODAY, feeling: 9 });
      const row1 = checkinRow(db, LA_TODAY);
      check('same-ms: first save lands with revision 1 under the frozen clock',
        save1.ok === true && row1 !== undefined && row1.feeling === 9 && row1.revision === 1 && row1.updated_at === FIXED_MS,
        `rev=${row1?.revision}, updated_at=${row1?.updated_at}`);
      // Reader A binds the input (feeling + revision + text version) at
      // its read instant — the same bindings getDashboard makes — and
      // computes its score with the real formula, then PAUSES.
      const healthLoad = await impl.loadHealthSnapshot(ctx);
      const snapshot = healthLoad.snapshot;
      const aBound = { feeling: row1.feeling, revision: row1.revision, textVersion: new RealDate(row1.updated_at).toISOString() };
      const scoreA = impl.calculateReadiness(snapshot, LA_TODAY, aBound.feeling);
      // The second save lands in the SAME millisecond.
      const save2 = await impl.saveMorningCheckinHandler(ctx, { date: LA_TODAY, feeling: 2 });
      const row2 = checkinRow(db, LA_TODAY);
      check('same-ms: the same-millisecond second save still advances the revision (text version cannot order them)',
        save2.ok === true && row2.feeling === 2 && row2.revision === 2 && row2.revision > aBound.revision
        && row2.updated_at === FIXED_MS && new RealDate(row2.updated_at).toISOString() === aBound.textVersion,
        `rev=${row2?.revision}, updated_at=${row2?.updated_at}`);
      // Reader B: the real dashboard computes from feeling=2 and archives.
      const resB = await impl.getDashboardHandler(ctx, {});
      const expectedB = impl.calculateReadiness(snapshot, LA_TODAY, 2);
      check('same-ms: precondition — the two feelings really do produce different scores (the race is observable)',
        scoreA.score !== expectedB.score, `A=${scoreA.score}, B=${expectedB.score}`);
      check('same-ms: reader B computed from the NEW feeling and archived it under revision 2',
        resB.forbidden === false && resB.readiness !== null && resB.readiness.morningFeeling === 2
        && resB.readiness.score === expectedB.score);
      let rows = archiveRows(db);
      check('same-ms: B\'s archive row carries checkin_revision 2',
        rows.length === 1 && rows[0].score === expectedB.score && rows[0].checkin_revision === 2,
        `score=${rows[0]?.score}, rev=${rows[0]?.checkin_revision}`);
      // A resumes and lands its late archive write, bound to revision 1.
      await impl.archiveReadiness(ctx, scoreA, HV_ISO, aBound.textVersion, aBound.revision, LA_TODAY);
      rows = archiveRows(db);
      check('same-ms: A\'s late write is rejected — the archive still holds B\'s score (computed from feeling=2)',
        rows.length === 1 && rows[0].score === expectedB.score && rows[0].checkin_revision === 2,
        `score=${rows[0]?.score}, rev=${rows[0]?.checkin_revision}`);
      const finalRow = checkinRow(db, LA_TODAY);
      check('same-ms: the check-in row itself still holds the latest saved input (feeling=2, revision 2)',
        finalRow.feeling === 2 && finalRow.revision === 2);
      check('same-ms: the dashboard trend agrees with the current check-in (today\'s point is B\'s score)',
        resB.readinessHistory.length === 7 && resB.readinessHistory[6].date === LA_TODAY
        && resB.readinessHistory[6].score === expectedB.score);
    } finally { unfreezeClock(); }
  }
  {
    // Reverse landing order under the same frozen millisecond: A
    // archives FIRST (revision 1), then the newer save lands and B's
    // dashboard write (revision 2) must still take the row over.
    const db = freshSqlite();
    const { ctx } = makeCtx(db, { isOwner: true });
    storeHealth(db, healthSnapshotPayload(dayShift(LA_TODAY, -1), HV_ISO, LA_TODAY));
    freezeClock(FIXED_MS);
    try {
      await impl.saveMorningCheckinHandler(ctx, { date: LA_TODAY, feeling: 9 });
      const row1 = checkinRow(db, LA_TODAY);
      const healthLoad = await impl.loadHealthSnapshot(ctx);
      const snapshot = healthLoad.snapshot;
      const scoreA = impl.calculateReadiness(snapshot, LA_TODAY, row1.feeling);
      await impl.archiveReadiness(ctx, scoreA, HV_ISO, new RealDate(row1.updated_at).toISOString(), row1.revision, LA_TODAY);
      let rows = archiveRows(db);
      check('same-ms reverse: A\'s on-time write lands first (score from feeling=9, revision 1)',
        rows.length === 1 && rows[0].score === scoreA.score && rows[0].checkin_revision === 1);
      await impl.saveMorningCheckinHandler(ctx, { date: LA_TODAY, feeling: 2 });
      const resB = await impl.getDashboardHandler(ctx, {});
      const expectedB = impl.calculateReadiness(snapshot, LA_TODAY, 2);
      rows = archiveRows(db);
      check('same-ms reverse: the newer same-millisecond save still wins the archive (latest saved input is kept)',
        resB.readiness !== null && resB.readiness.score === expectedB.score
        && rows.length === 1 && rows[0].score === expectedB.score && rows[0].checkin_revision === 2,
        `score=${rows[0]?.score}, rev=${rows[0]?.checkin_revision}`);
    } finally { unfreezeClock(); }
  }
}
{
  // Different-millisecond saves (the original, pre-existing scenario):
  // the plain revision sequence behaves exactly as the version order
  // always did — no regression.
  const db = freshSqlite();
  const { ctx } = makeCtx(db, { isOwner: true });
  await impl.saveMorningCheckinHandler(ctx, { date: '2026-10-19', feeling: 5 });
  await impl.saveMorningCheckinHandler(ctx, { date: '2026-10-19', feeling: 6 });
  const row = checkinRow(db, '2026-10-19');
  check('revision: ordinary sequential saves increment 1 then 2 and keep the latest feeling',
    row !== undefined && row.revision === 2 && row.feeling === 6, `rev=${row?.revision}`);
}
{
  // Revision mechanics of the real save handler: identical content is
  // still a new successful save (revision advances); concurrent saves
  // converge on a strictly increasing sequence with no gaps lost; a
  // rejected (non-owner) save and a failed save advance nothing; a
  // legacy row without a revision starts from COALESCE(NULL, 0) + 1.
  const db = freshSqlite();
  const { ctx } = makeCtx(db, { isOwner: true });
  await impl.saveMorningCheckinHandler(ctx, { date: '2026-10-19', feeling: 5 });
  await impl.saveMorningCheckinHandler(ctx, { date: '2026-10-19', feeling: 5 });
  let row = checkinRow(db, '2026-10-19');
  check('revision: saving the SAME content again still advances the revision (every successful save is a new input version)',
    row.revision === 2 && row.feeling === 5, `rev=${row?.revision}`);
  await Promise.all([
    impl.saveMorningCheckinHandler(ctx, { date: '2026-10-19', feeling: 7 }),
    impl.saveMorningCheckinHandler(ctx, { date: '2026-10-19', feeling: 8 }),
  ]);
  row = checkinRow(db, '2026-10-19');
  check('revision: two concurrent saves converge — revision advances by exactly 2, feeling is one of the two saved values',
    row.revision === 4 && (row.feeling === 7 || row.feeling === 8), `rev=${row?.revision}, feeling=${row?.feeling}`);
  const { ctx: strangerCtx } = makeCtx(db, { isOwner: false });
  const rejected = await impl.saveMorningCheckinHandler(strangerCtx, { date: '2026-10-19', feeling: 1 });
  row = checkinRow(db, '2026-10-19');
  check('revision: a rejected (non-owner) save does not advance the revision or touch the feeling',
    rejected.ok === false && rejected.forbidden === true && row.revision === 4 && (row.feeling === 7 || row.feeling === 8));
  const { ctx: failCtx } = makeCtx(db, { isOwner: true }, new Set(['morning_checkin']));
  let threw = false;
  try { await impl.saveMorningCheckinHandler(failCtx, { date: '2026-10-19', feeling: 1 }); } catch { threw = true; }
  row = checkinRow(db, '2026-10-19');
  check('revision: a FAILED save does not advance the revision (the upsert is atomic)',
    threw && row.revision === 4 && (row.feeling === 7 || row.feeling === 8));
  const db2 = freshSqlite();
  const { ctx: ctx2 } = makeCtx(db2, { isOwner: true });
  db2.prepare('INSERT INTO morning_checkin (date, feeling, revision, created_at, updated_at) VALUES (?, ?, NULL, ?, ?)')
    .run('2026-10-19', 6, 1000, 1000);
  await impl.saveMorningCheckinHandler(ctx2, { date: '2026-10-19', feeling: 3 });
  const legacy = checkinRow(db2, '2026-10-19');
  check('revision: a legacy row (revision NULL) is treated as oldest — its first post-migration save becomes revision 1',
    legacy.revision === 1 && legacy.feeling === 3, `rev=${legacy?.revision}`);
  await impl.saveMorningCheckinHandler(ctx2, { date: '2026-10-19', feeling: 4 });
  check('revision: the upgraded legacy row then increments normally',
    checkinRow(db2, '2026-10-19').revision === 2);
}

// ------------------------------------------------------- (g) mutations
{
  const mutated = actionsSrc.replace('z.enum(["push", "pull", "legs", "home_posture", "home_snowboard"])', 'z.enum(["push", "pull", "legs"])');
  const mutatedSchemas = buildSchemas(mutated);
  check('mutation: shrinking the enum back to three values makes the mixed snapshot fail (schema tests are sensitive)',
    mutated !== actionsSrc && !mutatedSchemas.strengthTrainingSchema.safeParse(mkStrength(FIVE.map((r) => mkWorkout(r)))).success);
}
{
  const mutated = actionsSrc.replace('byDate.get(date) ?? null', 'byDate.get(date) ?? byDate.get(endDate) ?? null');
  const fn = extractFunction(mutated, 'buildReadinessTrendPoints');
  const shift = extractFunction(mutated, 'shiftDate');
  const builder = new Function(`${stripTypeScriptTypes(shift)}\n${stripTypeScriptTypes(fn)}\nreturn buildReadinessTrendPoints;`)();
  const points = builder([{ date: '2026-10-19', score: 6.0 }], '2026-10-19');
  check('mutation: filling gaps with the latest score is detectable (mutated builder fills; production builder does not)',
    points[0].score === 6.0 && impl.buildReadinessTrendPoints([{ date: '2026-10-19', score: 6.0 }], '2026-10-19')[0].score === null);
}
{
  // Remove the date-key upsert from archiveReadiness: the mutated archive
  // calls a conflict clause the adapter (like an insert-only write path)
  // cannot apply as an overwrite, so the first-write assertions above
  // would fail against it — proving the upsert is load-bearing.
  const start = actionsSrc.indexOf('async function archiveReadiness(');
  const head = actionsSrc.slice(0, start);
  const tail = actionsSrc.slice(start).replace('.onConflictDoUpdate({', '.onConflictDoNothing({');
  const mutated = head + tail;
  const mutImpl = buildServerImpl(mutated);
  const db = freshSqlite();
  const { ctx } = makeCtx(db, { isOwner: true });
  await mutImpl.archiveReadiness(ctx, mkReadiness('2026-10-18', 7.5), 'v1', null, null, '2026-10-18');
  await mutImpl.archiveReadiness(ctx, mkReadiness('2026-10-18', 8.0), 'v2', null, null, '2026-10-18');
  const rows = archiveRows(db);
  check('mutation: without the date-key upsert the archive cannot hold the latest same-day score (upsert is load-bearing)',
    mutated !== actionsSrc && !(rows.length === 1 && rows[0].score === 8.0),
    `mutant rows: ${rows.length}, score: ${rows[0]?.score ?? 'none'}`);
}
{
  // Remove the version guard (setWhere) from archiveReadiness: the
  // mutated archive lets a late older version roll the stored score
  // back — proving the production setWhere is load-bearing.
  const start = actionsSrc.indexOf('setWhere: sql`excluded.snapshot_version');
  const mutated = start < 0 ? actionsSrc : actionsSrc.slice(0, start) + actionsSrc.slice(start).replace(/setWhere: sql`[^`]*`,\n/, '');
  const mutImpl = buildServerImpl(mutated);
  const db = freshSqlite();
  const { ctx } = makeCtx(db, { isOwner: true });
  await mutImpl.archiveReadiness(ctx, mkReadiness('2026-10-18', 8.0), '2026-10-18T18:00:00.000Z', null, null, '2026-10-18');
  await mutImpl.archiveReadiness(ctx, mkReadiness('2026-10-18', 3.0), '2026-10-18T16:00:00.000Z', null, null, '2026-10-18');
  const rows = archiveRows(db);
  check('mutation: without the setWhere version guard a late OLDER version rolls the score back (guard is load-bearing)',
    mutated !== actionsSrc && rows.length === 1 && rows[0].score === 3.0,
    `mutant score: ${rows[0]?.score ?? 'none'}`);
}
{
  // Remove the date gate: the mutated archive backfills a past date —
  // proving the production todayLA gate is load-bearing.
  const mutated = actionsSrc.replace('if (todayLA !== undefined && readiness.date !== todayLA) return;', '');
  const mutImpl = buildServerImpl(mutated);
  const db = freshSqlite();
  const { ctx } = makeCtx(db, { isOwner: true });
  await mutImpl.archiveReadiness(ctx, mkReadiness('2000-01-01', 5.0), 'v1', null, null, '2026-10-19');
  check('mutation: without the date gate a past date gets backfilled (gate is load-bearing)',
    mutated !== actionsSrc && archiveRows(db).length === 1);
}
{
  // Revert the arbitration to the PRE-FIX health-only rule (>= on the
  // health version alone): the PM race reappears — the late old-revision
  // write overwrites the new-revision score — proving the production
  // check-in revision term in setWhere is load-bearing.
  const swStart = actionsSrc.indexOf('setWhere: sql`excluded.snapshot_version');
  const swEnd = swStart < 0 ? -1 : actionsSrc.indexOf('`,', swStart);
  const oldGuard = 'setWhere: sql`excluded.snapshot_version IS NOT NULL AND (${schema.readinessHistory.snapshotVersion} IS NULL OR excluded.snapshot_version >= ${schema.readinessHistory.snapshotVersion})`';
  const mutated = swStart < 0 || swEnd < 0 ? actionsSrc : actionsSrc.slice(0, swStart) + oldGuard + actionsSrc.slice(swEnd + 1);
  const mutImpl = buildServerImpl(mutated);
  const db = freshSqlite();
  const { ctx } = makeCtx(db, { isOwner: true });
  const HV = '2026-10-19T14:00:00.000Z';
  await mutImpl.archiveReadiness(ctx, mkReadiness('2026-10-19', 8.0), HV, '2026-10-19T13:20:00.000Z', 2, '2026-10-19');
  await mutImpl.archiveReadiness(ctx, mkReadiness('2026-10-19', 3.0), HV, '2026-10-19T13:05:00.000Z', 1, '2026-10-19');
  const rows = archiveRows(db);
  check('mutation: with health-only >= arbitration the PM race returns — the late old-revision write wins (revision term is load-bearing)',
    mutated !== actionsSrc && rows.length === 1 && rows[0].score === 3.0,
    `mutant score: ${rows[0]?.score ?? 'none'}`);
}
{
  // Revert the arbitration to judging freshness by the TEXT check-in
  // version (the same-millisecond bug): both writes below carry the
  // IDENTICAL text version — as two saves in one millisecond do — so
  // the mutant cannot tell the stale input from the current one and
  // the late old-revision write wins. Production arbitration, keyed on
  // the numeric revision, rejects it (section (j) proves the positive
  // side end to end).
  const swStart = actionsSrc.indexOf('setWhere: sql`excluded.snapshot_version');
  const swEnd = swStart < 0 ? -1 : actionsSrc.indexOf('`,', swStart);
  const textGuard = 'setWhere: sql`excluded.snapshot_version IS NOT NULL AND (${schema.readinessHistory.snapshotVersion} IS NULL OR excluded.snapshot_version > ${schema.readinessHistory.snapshotVersion} OR (excluded.snapshot_version = ${schema.readinessHistory.snapshotVersion} AND (${schema.readinessHistory.checkinVersion} IS NULL OR (excluded.checkin_version IS NOT NULL AND excluded.checkin_version >= ${schema.readinessHistory.checkinVersion}))))`';
  const mutated = swStart < 0 || swEnd < 0 ? actionsSrc : actionsSrc.slice(0, swStart) + textGuard + actionsSrc.slice(swEnd + 1);
  const mutImpl = buildServerImpl(mutated);
  const db = freshSqlite();
  const { ctx } = makeCtx(db, { isOwner: true });
  const HV = '2026-10-19T14:00:00.000Z';
  const SAME_MS = '2026-10-19T13:05:00.000Z'; // both saves share this updated_at
  await mutImpl.archiveReadiness(ctx, mkReadiness('2026-10-19', 8.0), HV, SAME_MS, 2, '2026-10-19');
  await mutImpl.archiveReadiness(ctx, mkReadiness('2026-10-19', 3.0), HV, SAME_MS, 1, '2026-10-19');
  const rows = archiveRows(db);
  check('mutation: with TEXT-version arbitration the same-millisecond bug returns — the late stale write wins (numeric revision is load-bearing)',
    mutated !== actionsSrc && rows.length === 1 && rows[0].score === 3.0,
    `mutant score: ${rows[0]?.score ?? 'none'}`);
}

console.log(`\n${passed} passed, ${failures} failed (source root: ${ROOT})`);
process.exit(failures ? 1 : 0);
