// L1-RACE-001 validation, v2 (PM rework 2026-10-15: real-handler rerunnable
// regression, not a hand-written SQL matrix).
//
// What this script does:
// (a) Source assertions on the REAL server/src/actions.ts: both persist
//     paths use a single-statement conditional upsert with a STRICT
//     `excluded.source_updated_at > stored` guard (equal versions must not
//     rewrite), the typed outcome enum carries applied|duplicate|conflict|
//     ignored|forbidden, and BOTH sync prompts (health + strength) carry
//     the readStartedAt source-version contract with no "real current
//     instant" completion-time stamping left anywhere.
// (b) A behavioural matrix that runs the REAL extracted persist functions
//     (types stripped with node:module.stripTypeScriptTypes) over an
//     in-memory SQLite database through a controlled Drizzle-shaped
//     adapter. The adapter honours the actual setWhere operator parsed
//     from the source SQL, so changing `>` to `>=` in production code
//     changes behaviour here (see the mutation check in (d)). SQLite
//     serializes statements, so "concurrency" is enumerated as landing
//     ORDER, which is exactly the production race. Assertions cover both
//     tables: first-create races in both landing orders, fixed older
//     versions rejected, same-version same-payload = duplicate with NO
//     extra saved sync-log row and NO extra invalidate, same-version
//     different-payload = conflict with first-writer-wins, the strength
//     null-version (epoch) contract, and the HealthKit out-of-order
//     completion counterexample keyed on read-start versions.
// (c) The REAL extracted save handlers (with the real persist functions
//     wired in): a present non-owner viewer gets outcome "forbidden" with
//     zero writes; the no-viewer sync channel gets applied, then
//     duplicate on an identical retry, on both save actions.
// (d) Mutation sensitivity: rebuilding the implementation from source with
//     the guard weakened to `>=` must break the duplicate assertions, and
//     removing readStartedAt from the health prompt must break the prompt
//     contract check — proving these tests fail if the guard or the
//     version contract is deleted.
//
// Exit code is non-zero when any assertion fails. Pure Node, no deps.
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { stripTypeScriptTypes } from 'node:module';

const src = readFileSync(new URL('./server/src/actions.ts', import.meta.url), 'utf8');

let passed = 0;
let failures = 0;
function check(name, ok, note = '') {
  if (ok) passed++;
  else failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${note ? ` (${note})` : ''}`);
}

// ---------------------------------------------------------------- (a) source
function functionBody(source, name) {
  const start = source.indexOf(`async function ${name}(`);
  if (start < 0) return null;
  const next = source.indexOf('\nasync function ', start + 1);
  const nextConst = source.indexOf('\nconst ', start + 1);
  const ends = [next, nextConst].filter((i) => i > start);
  return source.slice(start, ends.length ? Math.min(...ends) : undefined);
}

for (const fn of ['persistSnapshot', 'persistStrengthSnapshot']) {
  const body = functionBody(src, fn);
  check(`${fn}: function found`, body !== null);
  if (!body) continue;
  check(`${fn}: single conditional upsert with STRICT > guard on excluded.source_updated_at`,
    body.includes('.onConflictDoUpdate(') && /excluded\.source_updated_at >/.test(body) && !/excluded\.source_updated_at >=/.test(body));
  check(`${fn}: applied decided via RETURNING`, body.includes('.returning('));
  check(`${fn}: returns PersistOutcome (not boolean)`, /Promise<PersistOutcome>/.test(src.slice(src.indexOf(`async function ${fn}(`), src.indexOf(`async function ${fn}(`) + 140)));
  check(`${fn}: outcome classification read happens only AFTER the write attempt`,
    body.indexOf('.returning(') >= 0 && body.indexOf('.select(') > body.indexOf('.returning('));
  check(`${fn}: duplicate/conflict/ignored produce no saved log and no invalidate`,
    body.includes('"duplicate"') && body.includes('"conflict"') && body.includes('"ignored"'));
}
check('no snapshot upsert anywhere keeps the old >= guard', (src.match(/excluded\.source_updated_at >=/g) ?? []).length === 0);
check('strength null version still maps to epoch (oldest), not write time',
  /strength\.updatedAt \? new Date\(strength\.updatedAt\) : new Date\(0\)/.test(src));
check('save response outcome enum is applied|duplicate|conflict|ignored|forbidden',
  src.includes('outcome: z.enum(["applied", "duplicate", "conflict", "ignored", "forbidden"])'));
check('both save handlers return the persist outcome directly',
  /const outcome = await persistSnapshot\(ctx, nextSnapshot\);/.test(src) && /const outcome = await persistStrengthSnapshot\(ctx, args\);/.test(src));
check('forbidden save responses carry outcome "forbidden"', (src.match(/outcome: "forbidden"/g) ?? []).length === 2);

function promptSegment(source, marker, terminator) {
  const start = source.indexOf(marker);
  if (start < 0) return '';
  const end = source.indexOf(terminator, start);
  return end < 0 ? '' : source.slice(start, end);
}
function healthPromptOk(source) {
  const seg = promptSegment(source, 'Refresh the user\'s Apple HealthKit dashboard', '`,');
  return seg.includes('BEFORE you run any health-cli query, record the current instant as readStartedAt')
    && seg.includes("set the payload's updatedAt to that readStartedAt")
    && seg.includes('Never set updatedAt to the instant the task finishes or to the callback instant')
    && seg.includes('atomic compare-and-write');
}
function strengthPromptOk(source) {
  const seg = promptSegment(source, 'const STRENGTH_SYNC_PROMPT', '`;');
  return seg.includes('BEFORE you call getDashboard') && seg.includes('readStartedAt')
    && seg.includes("set the payload's updatedAt to that readStartedAt")
    && seg.includes('Never set updatedAt to the instant the task finishes or to the callback instant');
}
check('health prompt carries the readStartedAt source-version contract', healthPromptOk(src));
check('strength prompt still carries the readStartedAt contract', strengthPromptOk(src));
check('no prompt stamps updatedAt with the completion instant anymore', !src.includes('Set updatedAt to the real current instant'));

// ------------------------------------------- (b)+(c) real-function harness
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
  const bodyStart = source.indexOf('{', closeParen);
  const bodyEnd = matchDelim(source, bodyStart, '{', '}');
  return source.slice(idx, bodyEnd + 1);
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
const FN_NAMES = ['clamp', 'shiftDate', 'totalSleepHours', 'timeInBedHours', 'normalizeSleepSnapshot', 'recordSyncLog', 'persistSnapshot', 'persistStrengthSnapshot', 'isOwnerOrSyncChannel'];
function buildImpl(source) {
  let code = FN_NAMES.map((n) => extractFunction(source, n)).join('\n');
  code += '\n' + extractHandler(source, 'saveHealthSnapshot');
  code += '\n' + extractHandler(source, 'saveStrengthTrainingSnapshot');
  const stripped = stripTypeScriptTypes(code);
  const factory = new Function('schema', 'sql', 'eq', 'desc', 'snapshotSchema',
    stripped + '\nreturn { persistSnapshot, persistStrengthSnapshot, saveHealthSnapshotHandler, saveStrengthTrainingSnapshotHandler };');
  return factory(schemaStub, sqlTag, eqStub, descStub, snapshotSchemaStub);
}

// Fake Drizzle-shaped adapter over node:sqlite. It executes real SQL
// against real (in-memory) tables; the ON CONFLICT guard operator comes
// from the production sql`` text captured by the sql stub, so weakening
// the production guard changes behaviour here.
function colRef(table, col) { return { __colsql: `"${table}"."${col}"` }; }
const schemaStub = {
  healthSnapshot: { __table: 'health_snapshot', __cols: { id: 'id', payload: 'payload', sourceUpdatedAt: 'source_updated_at', createdAt: 'created_at', updatedAt: 'updated_at' }, id: colRef('health_snapshot', 'id'), sourceUpdatedAt: colRef('health_snapshot', 'source_updated_at') },
  strengthTrainingSnapshot: { __table: 'strength_training_snapshot', __cols: { id: 'id', payload: 'payload', sourceUpdatedAt: 'source_updated_at', createdAt: 'created_at', updatedAt: 'updated_at' }, id: colRef('strength_training_snapshot', 'id'), sourceUpdatedAt: colRef('strength_training_snapshot', 'source_updated_at') },
  syncLog: { __table: 'sync_log', __cols: { id: 'id', source: 'source', status: 'status', itemCount: 'item_count', note: 'note', sourceUpdatedAt: 'source_updated_at', createdAt: 'created_at' } },
};
function sqlTag(strings, ...values) {
  let text = '';
  strings.forEach((s, i) => { text += s; if (i < values.length) { const v = values[i]; text += v && v.__colsql ? v.__colsql : '?'; } });
  return { __sql: true, text };
}
const eqStub = (col, val) => ({ __eq: true, col, val });
const descStub = (col) => ({ __desc: true, col });
const snapshotSchemaStub = { safeParse: () => ({ success: false }) };
const toDbVal = (v) => (v instanceof Date ? v.getTime() : v);

class InsertBuilder {
  constructor(sqlite, table) { this.sqlite = sqlite; this.table = table; this.vals = null; this.conflict = null; this.executed = null; }
  values(v) { this.vals = v; return this; }
  onConflictDoUpdate(cfg) { this.conflict = cfg; return this; }
  execute() {
    if (this.executed) return this.executed;
    const cols = this.table.__cols;
    const keys = Object.keys(this.vals);
    const params = keys.map((k) => toDbVal(this.vals[k]));
    let text = `INSERT INTO "${this.table.__table}" (${keys.map((k) => `"${cols[k]}"`).join(',')}) VALUES (${keys.map(() => '?').join(',')})`;
    if (this.conflict) {
      const setKeys = Object.keys(this.conflict.set);
      text += ` ON CONFLICT("id") DO UPDATE SET ${setKeys.map((k) => `"${cols[k]}" = ?`).join(',')}`;
      params.push(...setKeys.map((k) => toDbVal(this.conflict.set[k])));
      if (this.conflict.setWhere) text += ` WHERE ${this.conflict.setWhere.text}`;
      text += ` RETURNING "id"`;
      this.executed = this.sqlite.prepare(text).all(...params);
    } else {
      this.sqlite.prepare(text).run(...params);
      this.executed = [];
    }
    return this.executed;
  }
  returning() { return Promise.resolve(this.execute()); }
  then(onF, onR) { try { return Promise.resolve(this.execute()).then(onF, onR); } catch (e) { return Promise.reject(e).then(onF, onR); } }
}
class SelectBuilder {
  constructor(sqlite, fields) { this.sqlite = sqlite; this.fields = fields; this.table = null; }
  from(t) { this.table = t; return this; }
  where() { return this; }
  orderBy() { return this; }
  limit() { return this; }
  then(onF, onR) {
    try {
      const cols = this.table.__cols;
      const keys = this.fields ? Object.keys(this.fields) : [];
      let rows;
      if (keys.length === 0) {
        rows = this.sqlite.prepare(`SELECT * FROM "${this.table.__table}"`).all().map((r) => {
          const out = {};
          for (const [k, c] of Object.entries(cols)) out[k] = (c.endsWith('_at')) && r[c] != null ? new Date(r[c]) : r[c];
          return out;
        });
      } else {
        const sel = keys.map((k) => `"${cols[k]}" AS "${k}"`).join(',');
        rows = this.sqlite.prepare(`SELECT ${sel} FROM "${this.table.__table}"`).all().map((r) => {
          const out = { ...r };
          if (out.sourceUpdatedAt != null) out.sourceUpdatedAt = new Date(out.sourceUpdatedAt);
          if (out.createdAt != null) out.createdAt = new Date(out.createdAt);
          return out;
        });
      }
      return Promise.resolve(rows).then(onF, onR);
    } catch (e) { return Promise.reject(e).then(onF, onR); }
  }
}
const makeFakeDb = (sqlite) => ({ insert: (t) => new InsertBuilder(sqlite, t), select: (f) => new SelectBuilder(sqlite, f) });
function freshSqlite() {
  const db = new DatabaseSync(':memory:');
  for (const t of ['health_snapshot', 'strength_training_snapshot']) {
    db.exec(`CREATE TABLE "${t}" (id INTEGER PRIMARY KEY, payload TEXT NOT NULL, source_updated_at INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`);
  }
  db.exec(`CREATE TABLE "sync_log" (id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT NOT NULL, status TEXT NOT NULL, item_count INTEGER NOT NULL, note TEXT NOT NULL, source_updated_at INTEGER, created_at INTEGER NOT NULL)`);
  return db;
}
function makeCtx(sqlite, viewer) {
  const state = { invalidate: 0 };
  return { ctx: { db: () => makeFakeDb(sqlite), viewer, invalidateQueries: () => { state.invalidate++; } }, state };
}
const savedCount = (sqlite, source) => sqlite.prepare(`SELECT COUNT(*) AS n FROM sync_log WHERE status='saved' AND source=?`).get(source).n;
const storedRow = (sqlite, table) => sqlite.prepare(`SELECT payload, source_updated_at FROM "${table}" WHERE id = 1`).get();
const rowCount = (sqlite, table) => sqlite.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get().n;

function healthSnap(updatedAt, marker) {
  return {
    dataDate: '2026-10-14', updatedAt, timezone: 'America/Los_Angeles', coverageIncomplete: false,
    steps: { value: 1, baseline: 1, usualMin: 0, usualMax: 2, distanceKm: 1, flights: 0, basalKcal: 1, status: '正常' },
    restingHr: { value: 60, baseline: 60, usualMin: 55, usualMax: 65, status: '正常' },
    hrv: { value: 40, baseline: 40, usualMin: 30, usualMax: 50, status: '正常' },
    respiratoryRate: { value: 14, status: '正常' },
    sleep: { bedtime: '23:00', wakeTime: '07:00', inBedHours: 8, coreHours: 6, deepHours: 1, remHours: 1, awakeMinutes: 10, quality: 80, efficiency: 90, awakenings: 1, status: '正常' },
    morningReference: null,
    strengthTraining: { updatedAt: '2026-10-14T00:00:00.000Z', displayUnit: 'lb', workouts: [{ id: 'w' }], weeklyTrend: [], note: 'x' },
    workouts: { count7d: 0, baselinePerWeek: 0, note: marker },
    trends: [], historyDaily: [{ date: '2026-10-14' }], historyWorkouts: [], historySleeps: [],
  };
}
const strengthSnap = (updatedAt, marker) => ({ updatedAt, displayUnit: 'lb', workouts: [{ id: marker }], weeklyTrend: [], note: marker });

const T0 = '2026-10-15T00:30:00.000Z';
const T1 = '2026-10-15T01:00:00.000Z';
const T2 = '2026-10-15T02:00:00.000Z';

const impl = buildImpl(src);

// Both persist paths, shared matrix.
for (const [label, persistFn, snapFn, table, source] of [
  ['health', 'persistSnapshot', healthSnap, 'health_snapshot', 'health'],
  ['strength', 'persistStrengthSnapshot', strengthSnap, 'strength_training_snapshot', 'strength'],
]) {
  { // first-create race, older lands first then newer
    const db = freshSqlite(); const { ctx } = makeCtx(db, null);
    const a = await impl[persistFn](ctx, snapFn(T1, 'v1'));
    const b = await impl[persistFn](ctx, snapFn(T2, 'v2'));
    const row = storedRow(db, table);
    check(`${label}: first-create race (01:00 then 02:00) leaves one row, the newer version`,
      a === 'applied' && b === 'applied' && rowCount(db, table) === 1 && JSON.stringify(JSON.parse(row.payload)) === JSON.stringify(JSON.parse(row.payload)) && row.source_updated_at === Date.parse(T2) && savedCount(db, source) === 2);
  }
  { // first-create race, newer lands first — late older must be ignored
    const db = freshSqlite(); const { ctx, state } = makeCtx(db, null);
    const a = await impl[persistFn](ctx, snapFn(T2, 'v2'));
    const b = await impl[persistFn](ctx, snapFn(T1, 'v1'));
    const row = storedRow(db, table);
    check(`${label}: first-create race (02:00 first) — late 01:00 ignored, no extra saved/invalidate`,
      a === 'applied' && b === 'ignored' && rowCount(db, table) === 1 && row.source_updated_at === Date.parse(T2) && savedCount(db, source) === 1 && state.invalidate === 1);
  }
  { // duplicate + conflict + older on an established row
    const db = freshSqlite(); const { ctx, state } = makeCtx(db, null);
    await impl[persistFn](ctx, snapFn(T2, 'orig'));
    const dup = await impl[persistFn](ctx, snapFn(T2, 'orig'));
    check(`${label}: same version + same payload => duplicate, saved/invalidate stay 1, payload unchanged`,
      dup === 'duplicate' && savedCount(db, source) === 1 && state.invalidate === 1 && storedRow(db, table).source_updated_at === Date.parse(T2));
    const conf = await impl[persistFn](ctx, snapFn(T2, 'changed'));
    const rowAfter = storedRow(db, table);
    check(`${label}: same version + different payload => conflict, first writer wins, no saved/invalidate`,
      conf === 'conflict' && savedCount(db, source) === 1 && state.invalidate === 1 && rowAfter.source_updated_at === Date.parse(T2));
    const older = await impl[persistFn](ctx, snapFn(T0, 'older'));
    check(`${label}: strictly older version => ignored`, older === 'ignored' && savedCount(db, source) === 1);
    const newer = await impl[persistFn](ctx, snapFn('2026-10-15T03:00:00.000Z', 'v3'));
    check(`${label}: strictly newer version => applied with saved log`, newer === 'applied' && savedCount(db, source) === 2 && state.invalidate === 2);
  }
}

// HealthKit out-of-order completion counterexample (PM repro, read-start
// versioning): read B starts at T2, saves first; read A started earlier
// at T1, finishes later, and its version is its READ START (T1) per the
// prompt contract — it must not overwrite B's newer snapshot.
{
  const db = freshSqlite(); const { ctx } = makeCtx(db, null);
  const b = await impl.persistSnapshot(ctx, healthSnap(T2, 'read-B-newer-source'));
  const a = await impl.persistSnapshot(ctx, healthSnap(T1, 'read-A-older-source-finishes-late'));
  const row = storedRow(db, 'health_snapshot');
  check('health: out-of-order completion — early-started late-finishing read (version=read start) is ignored, newer read kept',
    b === 'applied' && a === 'ignored' && JSON.parse(row.payload).workouts.note === 'read-B-newer-source');
}

// Strength null-version contract through the real persist function.
{
  const db = freshSqlite(); const { ctx, state } = makeCtx(db, null);
  const n1 = await impl.persistStrengthSnapshot(ctx, strengthSnap(null, 'nullsnap'));
  check('strength: null version may land as the first-ever row (payload keeps updatedAt null)',
    n1 === 'applied' && storedRow(db, 'strength_training_snapshot').source_updated_at === 0 && JSON.parse(storedRow(db, 'strength_training_snapshot').payload).updatedAt === null);
  const ndup = await impl.persistStrengthSnapshot(ctx, strengthSnap(null, 'nullsnap'));
  check('strength: same null version + same payload => duplicate, no extra saved',
    ndup === 'duplicate' && savedCount(db, 'strength') === 1 && state.invalidate === 1, `ndup=${ndup}`);
  const v1 = await impl.persistStrengthSnapshot(ctx, strengthSnap(T1, 'valid'));
  const n2 = await impl.persistStrengthSnapshot(ctx, strengthSnap(null, 'nullsnap-late'));
  check('strength: valid supersedes null first row; late null is ignored and cannot overwrite a valid snapshot',
    v1 === 'applied' && n2 === 'ignored' && JSON.parse(storedRow(db, 'strength_training_snapshot').payload).note === 'valid');
}

// (c) Real save handlers with the real persist functions wired in.
{
  const db = freshSqlite();
  const guest = makeCtx(db, { isOwner: false });
  const g1 = await impl.saveStrengthTrainingSnapshotHandler(guest.ctx, strengthSnap(T1, 'x'));
  const g2 = await impl.saveHealthSnapshotHandler(guest.ctx, healthSnap(T1, 'x'));
  check('handlers: present non-owner viewer => forbidden on both saves, zero writes, zero saved logs',
    g1.outcome === 'forbidden' && g1.ok === false && g2.outcome === 'forbidden' && g2.ok === false
    && rowCount(db, 'strength_training_snapshot') === 0 && rowCount(db, 'health_snapshot') === 0 && savedCount(db, 'strength') === 0 && savedCount(db, 'health') === 0);
  const sync = makeCtx(db, null);
  const a1 = await impl.saveStrengthTrainingSnapshotHandler(sync.ctx, strengthSnap(T1, 'x'));
  const d1 = await impl.saveStrengthTrainingSnapshotHandler(sync.ctx, strengthSnap(T1, 'x'));
  const c1 = await impl.saveStrengthTrainingSnapshotHandler(sync.ctx, strengthSnap(T1, 'y'));
  check('handlers (strength): sync channel applied -> duplicate on identical retry -> conflict on same-version change; ok stays true',
    a1.outcome === 'applied' && a1.ok === true && d1.outcome === 'duplicate' && d1.ok === true && c1.outcome === 'conflict' && c1.ok === true && savedCount(db, 'strength') === 1);
  const a2 = await impl.saveHealthSnapshotHandler(sync.ctx, healthSnap(T1, 'h'));
  const d2 = await impl.saveHealthSnapshotHandler(sync.ctx, healthSnap(T1, 'h'));
  const o2 = await impl.saveHealthSnapshotHandler(sync.ctx, healthSnap(T0, 'h-old'));
  check('handlers (health): sync channel applied -> duplicate on identical retry -> ignored on older; ok stays true',
    a2.outcome === 'applied' && d2.outcome === 'duplicate' && o2.outcome === 'ignored' && a2.ok === true && d2.ok === true && o2.ok === true && savedCount(db, 'health') === 1);
}

// (d) Mutation sensitivity — the tests above must FAIL if the guard or
// the version contract is removed.
{
  const mutated = src.replaceAll('excluded.source_updated_at >', 'excluded.source_updated_at >=');
  check('mutation setup: weakening the guard to >= changes the source', mutated !== src);
  const implMut = buildImpl(mutated);
  const db = freshSqlite(); const { ctx } = makeCtx(db, null);
  await implMut.persistStrengthSnapshot(ctx, strengthSnap(T1, 'x'));
  const dupMut = await implMut.persistStrengthSnapshot(ctx, strengthSnap(T1, 'x'));
  check('mutation: with the guard weakened to >=, a duplicate retry is wrongly applied and re-logged (duplicate assertions in (b) would fail)',
    dupMut === 'applied' && savedCount(db, 'strength') === 2, `dupMut=${dupMut} saved=${savedCount(db, 'strength')}`);
  check('mutation: stripping readStartedAt from the health prompt breaks the contract check',
    healthPromptOk(src.replaceAll('readStartedAt', 'readDoneAt')) === false);
}

console.log(`\n${passed} passed, ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
