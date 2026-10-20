// F0.7 real-handler validation: refresh generation binding and
// settlement safety. Drives the REAL actions (refreshFinanceData /
// ingestFinanceData / getDashboard) against an isolated in-memory
// SQLite built from the app's own drizzle migrations, with fake
// ctx objects for the owner, a guest and an anonymous caller.
// Covers the fixed PM matrix: callbacks landing before the spawn
// returns (success and failure), cross-generation late spawns,
// old / duplicate / future asOf callbacks, late failures after a
// success settled, same-generation concurrent callbacks settling
// exactly once, the real success / failure / stale-retry paths,
// legacy (pre-generation) state rows, old-blob compatibility and
// owner/guest/anonymous identity. All fixtures are synthetic;
// nothing touches the real app.db.
//
// Run with Bun from the artifact root: bun validate-refresh-chain.ts
import { Database } from "bun:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

const APP_DIR = new URL(".", import.meta.url).pathname;
const appRequire = createRequire(join(APP_DIR, "package.json"));
const { drizzle } = appRequire("drizzle-orm/bun-sqlite");
const schema = await import(join(APP_DIR, "server/src/schema.ts"));
const { Actions, deriveRefreshDiagnosis } = await import(join(APP_DIR, "server/src/actions.ts"));

let passed = 0, failed = 0;
function check(name: string, cond: boolean) {
  if (cond) { passed++; } else { failed++; console.log("FAIL:", name); }
}

// ---------- db scaffolding ----------
function applyMigrationFile(sqlite: Database, file: string) {
  const sql = readFileSync(join(APP_DIR, "drizzle", file), "utf8");
  for (const stmt of sql.split("--> statement-breakpoint")) {
    const s = stmt.trim();
    if (s) sqlite.exec(s);
  }
}
function migrationFiles(): string[] {
  return readdirSync(join(APP_DIR, "drizzle")).filter((f) => f.endsWith(".sql")).sort();
}
function freshDb() {
  const sqlite = new Database(":memory:");
  for (const f of migrationFiles()) applyMigrationFile(sqlite, f);
  return { sqlite, db: drizzle(sqlite, { schema }) as any };
}
function stateRow(sqlite: Database): any {
  return sqlite.query("SELECT * FROM finance_state WHERE id = 1").get();
}
function payloadAsOf(sqlite: Database): string | null {
  const row = stateRow(sqlite);
  if (!row?.payload) return null;
  return JSON.parse(row.payload).asOf ?? null;
}

// ---------- ctx fakes ----------
function makeCtx(db: any, opts: { viewer?: any; spawnTask?: any }) {
  return {
    slug: "space-3",
    invocationId: "browser-harness",
    spaceDir: APP_DIR,
    viewer: opts.viewer,
    db: () => db,
    blobs: undefined,
    invalidateQueries: () => {},
    agent: { spawnTask: opts.spawnTask ?? (async () => ({ ok: true, taskId: "task-harness" })) },
    executePrivileged: async () => { throw new Error("not used"); },
  } as any;
}
const ownerCtx = (db: any, extra?: any) => makeCtx(db, { viewer: { isOwner: true }, ...extra });
const guestCtx = (db: any) => makeCtx(db, { viewer: { isOwner: false } });
const anonCtx = (db: any) => makeCtx(db, {});

// ---------- synthetic payloads ----------
let asOfTick = 0;
const freshAsOf = () => new Date(Date.now() + ++asOfTick * 3_600_000).toISOString();
function successPayload(generation: string | undefined, asOf: string) {
  return {
    success: true as const,
    ...(generation != null ? { generation } : {}),
    asOf,
    months: [
      { key: "2026-08-31", entries: [{ financeSource: "broker_1234", type: "investment", number: 100000 }] },
      {
        key: "2026-09-30",
        entries: [
          { financeSource: "broker_1234", type: "investment", number: 115000 },
          { financeSource: "broker_1234", type: "investment_contribution", number: 10000, periodStart: "2026-09-01", periodEnd: "2026-09-30" },
        ],
      },
    ],
    plaidAccounts: [],
    holdings: [],
    plaidTransactions: [],
    transactionCoverage: null,
  };
}

// ---------- db wrapper that pauses the payload-writing update ----------
// Lets a test hold callback A after it has won the claim (its
// settle update carries the payload) while callback B / a new
// generation runs.
function wrapDbPauseOnPayloadWrite(db: any, gate: Promise<void>) {
  let armed = true;
  let intercepted = false;
  // Drizzle builders are fluent: set/where return builder objects
  // (sometimes new ones), so every builder the chain hands back is
  // re-wrapped with the same per-update tracker; only the promise
  // a .returning() call produces is passed through untouched.
  function wrapBuilder(builder: any, state: { sawPayload: boolean }): any {
    return new Proxy(builder, {
      get(bt, bp) {
        if (bp === "set") {
          return (values: any) => {
            if (values != null && typeof values === "object" && "payload" in values) state.sawPayload = true;
            const r = bt.set(values);
            return r != null && typeof r === "object" && typeof r.returning === "function" ? wrapBuilder(r, state) : r;
          };
        }
        if (bp === "returning") {
          return (...a: any[]) => {
            if (armed && state.sawPayload) {
              armed = false;
              intercepted = true;
              return gate.then(() => bt.returning(...a));
            }
            return bt.returning(...a);
          };
        }
        const bv = Reflect.get(bt, bp, bt);
        if (typeof bv === "function") {
          return (...a: any[]) => {
            const r = bv.apply(bt, a);
            return r != null && typeof r === "object" && typeof r.returning === "function" ? wrapBuilder(r, state) : r;
          };
        }
        return bv;
      },
    });
  }
  const wrapped = new Proxy(db, {
    get(t, p) {
      const v = Reflect.get(t, p, t);
      if (p === "update" && typeof v === "function") {
        return (tbl: any) => wrapBuilder(v.call(t, tbl), { sawPayload: false });
      }
      return typeof v === "function" ? v.bind(t) : v;
    },
  });
  return { db: wrapped, intercepted: () => intercepted };
}
async function waitFor(label: string, cond: () => boolean, ms = 5000) {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error(`timeout waiting for: ${label}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

// =====================================================================
// Group 1: generation gate on a live running refresh
// =====================================================================
{
  const { sqlite, db } = freshDb();
  const started = await Actions.refreshFinanceData.handler(ownerCtx(db), {});
  check("refresh starts", started.ok && started.status === "started");
  const st1 = stateRow(sqlite);
  const gen1: string = st1.generation;
  check("generation minted and stored at refresh start", typeof gen1 === "string" && gen1.length > 0);
  check("attempt start stamped separately from the state-write time", typeof st1.started_at === "number" && st1.started_at > 0);
  check("state running with the task id attached by the spawn tail", st1.status === "running" && st1.task_id === "task-harness");

  const before = { ...stateRow(sqlite) };
  const oldFail = await Actions.ingestFinanceData.handler(ownerCtx(db), { success: false, error: "old generation failure" });
  check("old failure without generation ignored on the new running generation", oldFail.ok === false && oldFail.savedMonths === 0);
  const afterFail = stateRow(sqlite);
  check("state row fully unchanged after the old failure", afterFail.status === "running" && afterFail.generation === gen1
    && afterFail.task_id === "task-harness" && afterFail.updated_at === before.updated_at && afterFail.claimed_generation == null);

  const oldFailGen = await Actions.ingestFinanceData.handler(ownerCtx(db), { success: false, error: "older generation failure", generation: "gen-OLD" });
  check("old failure with a foreign generation ignored", oldFailGen.savedMonths === 0 && stateRow(sqlite).status === "running");

  const oldSuccess = await Actions.ingestFinanceData.handler(ownerCtx(db), successPayload("gen-OLD", freshAsOf()));
  check("old success with a foreign generation ignored (savedMonths=0, nothing saved)", oldSuccess.ok && oldSuccess.savedMonths === 0 && payloadAsOf(sqlite) === null);
  const oldSuccessNoGen = await Actions.ingestFinanceData.handler(ownerCtx(db), successPayload(undefined, freshAsOf()));
  check("old success without a generation ignored", oldSuccessNoGen.savedMonths === 0 && payloadAsOf(sqlite) === null);
  check("running state survives old callbacks", stateRow(sqlite).status === "running" && stateRow(sqlite).generation === gen1);

  const curFail = await Actions.ingestFinanceData.handler(ownerCtx(db), { success: false, error: "current generation failed", generation: gen1 });
  check("current-generation failure settles only this generation to error", curFail.ok === false && stateRow(sqlite).status === "error");
  check("the failure saved no payload", payloadAsOf(sqlite) === null);

  // ---- group 2: concurrent duplicates settle exactly once ----
  const started2 = await Actions.refreshFinanceData.handler(ownerCtx(db), {});
  check("refresh restarts after error (real failure -> retry path)", started2.ok && started2.status === "started");
  const gen2: string = stateRow(sqlite).generation;
  check("the new generation differs", gen2 !== gen1);
  const asOf2 = freshAsOf();
  const payload2 = successPayload(gen2, asOf2);
  const [c1, c2] = await Promise.all([
    Actions.ingestFinanceData.handler(ownerCtx(db), payload2),
    Actions.ingestFinanceData.handler(ownerCtx(db), payload2),
  ]);
  const savedPair = [c1.savedMonths, c2.savedMonths].sort((a, b) => a - b);
  check("concurrent duplicates: exactly one saves (2 months), the other saves 0", savedPair[0] === 0 && savedPair[1] === 2);
  check("state idle with the winner's payload", stateRow(sqlite).status === "idle" && payloadAsOf(sqlite) === asOf2);
  check("claim marker cleared by the settle", stateRow(sqlite).claimed_generation == null);

  const serialDup = await Actions.ingestFinanceData.handler(ownerCtx(db), successPayload(gen2, asOf2));
  check("serial duplicate of the settled generation ignored", serialDup.savedMonths === 0 && payloadAsOf(sqlite) === asOf2);
  const lateFail = await Actions.ingestFinanceData.handler(ownerCtx(db), { success: false, error: "late failure", generation: gen2 });
  check("late failure after a success settled does NOT flip idle to error", lateFail.savedMonths === 0 && stateRow(sqlite).status === "idle");
  const olderSuccess = await Actions.ingestFinanceData.handler(ownerCtx(db), successPayload(gen2, "2026-10-01T12:00:00-07:00"));
  check("older asOf after settle ignored (the stored snapshot never regresses)", olderSuccess.savedMonths === 0 && payloadAsOf(sqlite) === asOf2);

  // getDashboard during a later running refresh still serves the
  // last successful payload, with the attempt start attached.
  await Actions.refreshFinanceData.handler(ownerCtx(db), {});
  const during = await Actions.getDashboard.handler(ownerCtx(db), {});
  check("during a refresh the dashboard still shows the last successful data + running state + attempt start",
    during.data?.asOf === asOf2 && during.refresh.status === "running" && typeof during.refresh.startedAt === "string");
  const genDuring: string = stateRow(sqlite).generation;
  await Actions.ingestFinanceData.handler(ownerCtx(db), { success: false, error: "harness cleanup", generation: genDuring });
}

// =====================================================================
// Group 3: claim loser re-reads and stops; winner saves once
// =====================================================================
{
  const { sqlite, db } = freshDb();
  await Actions.refreshFinanceData.handler(ownerCtx(db), {});
  const gen: string = stateRow(sqlite).generation;
  const asOf = freshAsOf();
  let releaseA!: () => void;
  const gateA = new Promise<void>((res) => { releaseA = res; });
  const wrapped = wrapDbPauseOnPayloadWrite(db, gateA);
  const pA = Actions.ingestFinanceData.handler(ownerCtx(wrapped.db), successPayload(gen, asOf));
  await waitFor("A claimed and reached its settle write", () => wrapped.intercepted());
  check("A holds the claim while saving", stateRow(sqlite).claimed_generation != null && stateRow(sqlite).status === "running");
  const resB = await Actions.ingestFinanceData.handler(ownerCtx(db), successPayload(gen, asOf));
  check("claim loser re-read does not save (savedMonths=0)", resB.savedMonths === 0);
  check("claim loser saved nothing and left the running state untouched", payloadAsOf(sqlite) === null && stateRow(sqlite).status === "running");
  releaseA();
  const resA = await pA;
  check("claim winner completes with savedMonths=2 and settles idle", resA.savedMonths === 2 && stateRow(sqlite).status === "idle" && payloadAsOf(sqlite) === asOf);
}

// =====================================================================
// Group 4: a new generation starts before the old winner settles
// =====================================================================
{
  const { sqlite, db } = freshDb();
  await Actions.refreshFinanceData.handler(ownerCtx(db), {});
  const genOld: string = stateRow(sqlite).generation;
  let releaseB!: () => void;
  const gateB = new Promise<void>((res) => { releaseB = res; });
  const wrapped = wrapDbPauseOnPayloadWrite(db, gateB);
  const pB = Actions.ingestFinanceData.handler(ownerCtx(wrapped.db), successPayload(genOld, freshAsOf()));
  await waitFor("old winner claimed", () => wrapped.intercepted());
  sqlite.exec(`UPDATE finance_state SET updated_at = ${Date.now() - 3 * 3_600_000} WHERE id = 1`);
  const startedNew = await Actions.refreshFinanceData.handler(ownerCtx(db), {});
  const genNew: string = stateRow(sqlite).generation;
  check("new generation starts over the stuck one", startedNew.status === "started" && genNew !== genOld && stateRow(sqlite).status === "running");
  releaseB();
  const resB = await pB;
  check("superseded winner cannot save (savedMonths=0)", resB.savedMonths === 0 && payloadAsOf(sqlite) === null);
  const stAfter = stateRow(sqlite);
  check("superseded winner cannot settle the new generation", stAfter.status === "running" && stAfter.generation === genNew && stAfter.task_id === "task-harness");
  const asOfNew = freshAsOf();
  const resNew = await Actions.ingestFinanceData.handler(ownerCtx(db), successPayload(genNew, asOfNew));
  check("the new generation saves once and settles idle", resNew.savedMonths === 2 && stateRow(sqlite).status === "idle" && payloadAsOf(sqlite) === asOfNew);
}

// =====================================================================
// Group 5: late spawn results cannot overwrite state (PM repro)
// =====================================================================
{
  const { sqlite, db } = freshDb();
  // A: the generation's success callback settles idle while
  // spawnTask is still in flight; the spawn then returns ok — its
  // tail must not resurrect "running".
  const spawnA = async () => {
    const gen: string = stateRow(sqlite).generation;
    const cb = await Actions.ingestFinanceData.handler(ownerCtx(db), successPayload(gen, freshAsOf()));
    if (cb.savedMonths !== 2) throw new Error("setup callback did not save");
    return { ok: true, taskId: "late-task-A" };
  };
  const resA = await Actions.refreshFinanceData.handler(ownerCtx(db, { spawnTask: spawnA }), {});
  const stA = stateRow(sqlite);
  check("callback before spawn returns (success): state stays idle, no task resurrection", stA.status === "idle" && stA.task_id == null);
  check("the refresh return is honest (started, completed wording)", resA.ok === true && resA.message === "更新已完成");

  // B: the generation's failure callback settles error while the
  // spawn is in flight; the spawn returns ok — state stays error.
  const spawnB = async () => {
    const gen: string = stateRow(sqlite).generation;
    await Actions.ingestFinanceData.handler(ownerCtx(db), { success: false, error: "boom", generation: gen });
    return { ok: true, taskId: "late-task-B" };
  };
  const resB = await Actions.refreshFinanceData.handler(ownerCtx(db, { spawnTask: spawnB }), {});
  const stB = stateRow(sqlite);
  check("callback before spawn returns (failure): state stays error, not resurrected to running", stB.status === "error" && stB.task_id == null);
  check("the refresh return reports the settled error honestly", resB.ok === false && resB.status === "error");

  // C: an old spawn still in flight when a stale-aged restart
  // mints a new generation; the old spawn's late ok AND failure
  // returns must not touch the new generation.
  for (const oldOutcome of ["success", "failure"] as const) {
    let releaseOld!: () => void;
    const gateOld = new Promise<void>((res) => { releaseOld = res; });
    const spawnOld = async () => {
      await gateOld;
      return oldOutcome === "success" ? { ok: true, taskId: "old-task" } : { ok: false };
    };
    const pOld = Actions.refreshFinanceData.handler(ownerCtx(db, { spawnTask: spawnOld }), {});
    await waitFor("old generation minted", () => stateRow(sqlite).status === "running");
    const genOldSpawn: string = stateRow(sqlite).generation;
    sqlite.exec(`UPDATE finance_state SET updated_at = ${Date.now() - 3 * 3_600_000} WHERE id = 1`);
    const startedNew = await Actions.refreshFinanceData.handler(ownerCtx(db), {});
    const genNewSpawn: string = stateRow(sqlite).generation;
    check(`new generation starts while the old spawn is in flight (${oldOutcome})`,
      startedNew.status === "started" && genNewSpawn !== genOldSpawn && stateRow(sqlite).task_id === "task-harness");
    releaseOld();
    const oldRes: any = await pOld;
    const stNew = stateRow(sqlite);
    check(`late old spawn ${oldOutcome}: the new generation is untouched`, stNew.status === "running" && stNew.generation === genNewSpawn && stNew.task_id === "task-harness");
    check(`late old spawn ${oldOutcome}: honest already_running return`, oldRes.ok === true && oldRes.status === "already_running");
    const genCur: string = stateRow(sqlite).generation;
    await Actions.ingestFinanceData.handler(ownerCtx(db), { success: false, error: "harness cleanup", generation: genCur });
  }
}

// =====================================================================
// Group 6: asOf regression through the real path (PM repro)
// =====================================================================
{
  const { sqlite, db } = freshDb();
  await Actions.refreshFinanceData.handler(ownerCtx(db), {});
  const gen1: string = stateRow(sqlite).generation;
  const future = await Actions.ingestFinanceData.handler(ownerCtx(db), successPayload(gen1, "2099-10-18T12:00:00-07:00"));
  check("a future asOf saves (not silently dropped)", future.savedMonths === 2 && payloadAsOf(sqlite) === "2099-10-18T12:00:00-07:00");
  await Actions.refreshFinanceData.handler(ownerCtx(db), {});
  const gen2: string = stateRow(sqlite).generation;
  const regressed = await Actions.ingestFinanceData.handler(ownerCtx(db), successPayload(gen2, "2026-10-17T12:00:00-07:00"));
  check("an older success callback never regresses the stored snapshot", regressed.savedMonths === 0 && payloadAsOf(sqlite) === "2099-10-18T12:00:00-07:00");
  check("the running generation is left untouched by the ignored callback", stateRow(sqlite).status === "running" && stateRow(sqlite).generation === gen2);
}

// =====================================================================
// Group 7: stale running is presented retryable and restarts
// =====================================================================
{
  const { sqlite, db } = freshDb();
  await Actions.refreshFinanceData.handler(ownerCtx(db), {});
  sqlite.exec(`UPDATE finance_state SET updated_at = ${Date.now() - 3 * 3_600_000} WHERE id = 1`);
  const view = await Actions.getDashboard.handler(ownerCtx(db), {});
  check("stale running presents as a retryable error, stored row unrewritten",
    view.refresh.status === "error" && (view.refresh.message ?? "").includes("可以重新更新") && stateRow(sqlite).status === "running");
  const restarted = await Actions.refreshFinanceData.handler(ownerCtx(db), {});
  check("refresh restarts over the stale generation", restarted.ok && restarted.status === "started" && stateRow(sqlite).status === "running");
}

// =====================================================================
// Group 8: legacy rows (pre-generation contract) still work
// =====================================================================
{
  const { sqlite, db } = freshDb();
  await Actions.refreshFinanceData.handler(ownerCtx(db), {});
  const gen: string = stateRow(sqlite).generation;
  const asOf1 = freshAsOf();
  await Actions.ingestFinanceData.handler(ownerCtx(db), successPayload(gen, asOf1));
  sqlite.exec("UPDATE finance_state SET status = 'running', generation = NULL, claimed_generation = NULL, task_id = 'legacy-task', updated_at = " + Date.now());
  const legacyFail = await Actions.ingestFinanceData.handler(ownerCtx(db), { success: false, error: "legacy failure" });
  check("legacy running row: an ungated failure still settles error", legacyFail.ok === false && stateRow(sqlite).status === "error");
  sqlite.exec("UPDATE finance_state SET status = 'running', generation = NULL, claimed_generation = NULL, updated_at = " + Date.now());
  const asOf2 = freshAsOf();
  const legacyOk = await Actions.ingestFinanceData.handler(ownerCtx(db), successPayload(undefined, asOf2));
  check("legacy running row: an ungated success still saves and settles idle", legacyOk.savedMonths === 2 && stateRow(sqlite).status === "idle" && payloadAsOf(sqlite) === asOf2);
  const legacyDup = await Actions.ingestFinanceData.handler(ownerCtx(db), successPayload(undefined, asOf1));
  check("legacy settled row: an older duplicate success is still ignored (no regression)", legacyDup.savedMonths === 0 && payloadAsOf(sqlite) === asOf2);
}

// =====================================================================
// Group 9: identity — finance stays strictly owner
// =====================================================================
{
  const { sqlite, db } = freshDb();
  const guestRefresh = await Actions.refreshFinanceData.handler(guestCtx(db), {});
  const anonRefresh = await Actions.refreshFinanceData.handler(anonCtx(db), {});
  check("guest/anonymous refresh forbidden with zero state writes",
    guestRefresh.status === "forbidden" && anonRefresh.status === "forbidden" && stateRow(sqlite) == null);
  const guestIngest = await Actions.ingestFinanceData.handler(guestCtx(db), successPayload("gen-X", freshAsOf()));
  const anonIngest = await Actions.ingestFinanceData.handler(anonCtx(db), { success: false, error: "x" });
  check("guest/anonymous ingest rejected with zero writes",
    guestIngest.ok === false && guestIngest.savedMonths === 0 && anonIngest.ok === false && stateRow(sqlite) == null);
  const guestView = await Actions.getDashboard.handler(guestCtx(db), {});
  const anonView = await Actions.getDashboard.handler(anonCtx(db), {});
  check("guest/anonymous dashboard reads are denied", guestView.access === "guest_denied" && anonView.access === "guest_denied" && guestView.data === null);
}

// =====================================================================
// Group 10: migration compatibility (0002 data -> 0003 columns)
// =====================================================================
{
  const sqlite = new Database(":memory:");
  const files = migrationFiles();
  for (const f of files.slice(0, 2)) applyMigrationFile(sqlite, f);
  sqlite.exec(`INSERT INTO finance_state (id, payload, previous_live_net_worth, status, task_id, message, updated_at)
    VALUES (1, NULL, NULL, 'idle', NULL, 'legacy', ${Date.now()})`);
  applyMigrationFile(sqlite, files[2]!);
  const db = drizzle(sqlite, { schema }) as any;
  const row = stateRow(sqlite);
  check("post-migration: legacy row gains null generation/claim/started_at, history intact",
    row.generation == null && row.claimed_generation == null && row.started_at == null && row.status === "idle");
  const view = await Actions.getDashboard.handler(ownerCtx(db), {});
  check("post-migration: dashboard reads with a null attempt start (honest 未提供）",
    view.access === "owner" && view.refresh.startedAt === null && view.refresh.status === "idle");
}

// =====================================================================
// Group 11: F0.7 rework — atomic start claim + claim-guarded tail
// =====================================================================
{
  // (a) Concurrent starts on an empty state table (insert path):
  // exactly one generation is admitted, the other caller gets
  // already_running, and spawnTask runs exactly once.
  const { sqlite, db } = freshDb();
  let spawnCalls = 0;
  let releaseSpawn!: () => void;
  const spawnGate = new Promise<void>((res) => { releaseSpawn = res; });
  const countingSpawn = async () => {
    spawnCalls += 1;
    await spawnGate;
    return { ok: true, taskId: "task-concurrent" };
  };
  const ctxC = ownerCtx(db, { spawnTask: countingSpawn });
  const p1 = Actions.refreshFinanceData.handler(ctxC, {});
  const p2 = Actions.refreshFinanceData.handler(ctxC, {});
  await new Promise((r) => setTimeout(r, 50));
  releaseSpawn();
  const [r1, r2] = await Promise.all([p1, p2]);
  const statuses = [r1.status, r2.status].sort();
  check("concurrent starts (no state row): exactly one started, the other already_running",
    statuses[0] === "already_running" && statuses[1] === "started");
  check("concurrent starts (no state row): spawnTask called exactly once", spawnCalls === 1);
  check("concurrent starts (no state row): the row holds the single winning generation, running, task attached",
    stateRow(sqlite).status === "running" && stateRow(sqlite).task_id === "task-concurrent"
    && typeof stateRow(sqlite).generation === "string");
  const genC: string = stateRow(sqlite).generation;
  await Actions.ingestFinanceData.handler(ownerCtx(db), { success: false, error: "harness cleanup", generation: genC });

  // (a2) Concurrent starts over an existing settled row (CAS
  // update path): same verdict — one winner, one already_running,
  // one spawn.
  const { sqlite: sqliteB, db: dbB } = freshDb();
  await Actions.refreshFinanceData.handler(ownerCtx(dbB), {});
  const genB0: string = stateRow(sqliteB).generation;
  await Actions.ingestFinanceData.handler(ownerCtx(dbB), successPayload(genB0, freshAsOf()));
  check("concurrent-start setup: first generation settled idle", stateRow(sqliteB).status === "idle");
  let spawnCallsB = 0;
  let releaseSpawnB!: () => void;
  const spawnGateB = new Promise<void>((res) => { releaseSpawnB = res; });
  const countingSpawnB = async () => {
    spawnCallsB += 1;
    await spawnGateB;
    return { ok: true, taskId: "task-concurrent-b" };
  };
  const ctxB = ownerCtx(dbB, { spawnTask: countingSpawnB });
  const q1 = Actions.refreshFinanceData.handler(ctxB, {});
  const q2 = Actions.refreshFinanceData.handler(ctxB, {});
  await new Promise((r) => setTimeout(r, 50));
  releaseSpawnB();
  const [s1, s2] = await Promise.all([q1, q2]);
  const statusesB = [s1.status, s2.status].sort();
  check("concurrent starts (settled row): exactly one started, the other already_running",
    statusesB[0] === "already_running" && statusesB[1] === "started");
  check("concurrent starts (settled row): spawnTask called exactly once", spawnCallsB === 1);
  check("concurrent starts (settled row): one new generation replaced the settled one",
    stateRow(sqliteB).status === "running" && stateRow(sqliteB).generation !== genB0
    && stateRow(sqliteB).task_id === "task-concurrent-b");
  const genB: string = stateRow(sqliteB).generation;
  await Actions.ingestFinanceData.handler(ownerCtx(dbB), { success: false, error: "harness cleanup", generation: genB });

  // (b) Spawn tail while the same generation's callback holds
  // the claim: BOTH tail outcomes (spawn ok:false and ok:true)
  // must leave the state untouched, and the claim holder's legal
  // save must still land and settle idle.
  for (const outcome of ["failure", "success"] as const) {
    const { sqlite: sqlite2, db: db2 } = freshDb();
    let releaseSettle!: () => void;
    const gate = new Promise<void>((res) => { releaseSettle = res; });
    const wrapped = wrapDbPauseOnPayloadWrite(db2, gate);
    let ingestPromise: Promise<any> | null = null;
    const spawnWithClaim = async () => {
      const gen: string = stateRow(sqlite2).generation;
      ingestPromise = Actions.ingestFinanceData.handler(ownerCtx(wrapped.db), successPayload(gen, freshAsOf()));
      await waitFor("ingest claimed and paused at its settle write", () => wrapped.intercepted());
      return outcome === "failure" ? { ok: false } : { ok: true, taskId: "tail-task" };
    };
    const refreshRes: any = await Actions.refreshFinanceData.handler(
      ownerCtx(wrapped.db, { spawnTask: spawnWithClaim }), {},
    );
    const stMid = stateRow(sqlite2);
    check(`spawn tail ${outcome} during an in-flight claim: state untouched (running, claim held, no task attached, no error)`,
      stMid.status === "running" && stMid.claimed_generation != null && stMid.task_id == null);
    check(`spawn tail ${outcome} during an in-flight claim: refresh answers from the current state (already_running)`,
      refreshRes.ok === true && refreshRes.status === "already_running");
    releaseSettle();
    const ingestRes = await ingestPromise!;
    const stEnd = stateRow(sqlite2);
    check(`spawn tail ${outcome} during an in-flight claim: the legal callback still saves (savedMonths=2), settles idle, payload stored`,
      ingestRes.savedMonths === 2 && stEnd.status === "idle" && payloadAsOf(sqlite2) != null && stEnd.claimed_generation == null);
  }
}

// =====================================================================
// Group 12: F0.7 read-only observability (refresh_observations)
// =====================================================================
function obsRows(sqlite: Database): any[] {
  return sqlite.query("SELECT * FROM refresh_observations ORDER BY id ASC").all();
}
function obsEvents(sqlite: Database): string[] {
  return obsRows(sqlite).map((r: any) => r.event);
}
{
  // (a) spawn success path records refresh_started + spawn_attached,
  // and the owner query reports awaiting_callback while running.
  const { sqlite, db } = freshDb();
  const started = await Actions.refreshFinanceData.handler(ownerCtx(db), {});
  check("obs: refresh starts", started.ok && started.status === "started");
  check("obs: spawn success path records refresh_started then spawn_attached",
    JSON.stringify(obsEvents(sqlite)) === JSON.stringify(["refresh_started", "spawn_attached"]));
  const genA: string = stateRow(sqlite).generation;
  const viewA = await Actions.getRefreshObservations.handler(ownerCtx(db), {});
  check("obs: owner reads the observation view while running",
    viewA.access === "owner" && viewA.observations.length === 2
    && viewA.state?.status === "running" && viewA.state?.hasTaskId === true && viewA.state?.hasGeneration === true);
  check("obs: running with no callback yet diagnoses awaiting_callback",
    viewA.diagnosis?.code === "awaiting_callback");
  check("obs: the first attempt is numbered #1 across state / diagnosis / rows",
    viewA.currentAttempt === 1 && viewA.state?.attempt === 1 && viewA.diagnosis?.attempt === 1
    && viewA.observations.every((row: any) => row.attempt === 1 && row.relation === "current"));
  check("obs: the view never leaks the full generation or task id values",
    !JSON.stringify(viewA).includes(genA) && !JSON.stringify(viewA).includes("task-harness"));

  // (b) wrong-generation callback: state untouched, and the stream
  // records callback_received + callback_ignored(generation_gate).
  const beforeB = { ...stateRow(sqlite) };
  const wrongGen = await Actions.ingestFinanceData.handler(ownerCtx(db), successPayload("gen-WRONG", freshAsOf()));
  check("obs: wrong-generation callback saves nothing", wrongGen.savedMonths === 0 && payloadAsOf(sqlite) === null);
  const afterB = stateRow(sqlite);
  check("obs: wrong-generation callback leaves state untouched",
    afterB.status === "running" && afterB.generation === genA && afterB.updated_at === beforeB.updated_at);
  const rowsB = obsRows(sqlite).slice(-2);
  check("obs: ignored callback is recorded (received + ignored/generation_gate)",
    rowsB[0]?.event === "callback_received" && rowsB[0]?.outcome === "success_flag"
    && rowsB[1]?.event === "callback_ignored" && rowsB[1]?.detail === "generation_gate");
  const viewB = await Actions.getRefreshObservations.handler(ownerCtx(db), {});
  // F0.7-OBS-001 (the PM bug): the ignored callback belongs to a
  // FOREIGN generation that never started here. It must NOT be
  // diagnosed as the current attempt's outcome — the current
  // attempt is still simply waiting for its own callback.
  check("obs: a foreign ignored callback does NOT diagnose the current attempt (still awaiting its own callback)",
    viewB.diagnosis?.code === "awaiting_callback" && viewB.diagnosis?.attempt === 1);
  check("obs: the foreign callback rows are attributed unknown (no attempt ordinal), the current rows stay current #1",
    viewB.observations.slice(0, 2).every((row: any) => row.relation === "unknown" && row.attempt === null)
    && viewB.observations.slice(2).every((row: any) => row.relation === "current" && row.attempt === 1));

  // (c) a legal success callback records applied_success with the
  // saved-month count, and the diagnosis settles to success.
  const asOfC = freshAsOf();
  const okC = await Actions.ingestFinanceData.handler(ownerCtx(db), successPayload(genA, asOfC));
  check("obs: legal success callback saves", okC.savedMonths === 2 && stateRow(sqlite).status === "idle");
  const rowsC = obsRows(sqlite).slice(-2);
  check("obs: applied success recorded with the saved-month count",
    rowsC[0]?.event === "callback_received"
    && rowsC[1]?.event === "callback_applied_success" && rowsC[1]?.detail === "saved_months:2");
  const viewC = await Actions.getRefreshObservations.handler(ownerCtx(db), {});
  check("obs: settled success diagnoses settled_success for attempt #1",
    viewC.diagnosis?.code === "settled_success" && viewC.diagnosis?.attempt === 1);

  // (d) a legal failure callback records applied_failure and the
  // diagnosis settles to failure.
  await Actions.refreshFinanceData.handler(ownerCtx(db), {});
  const genD: string = stateRow(sqlite).generation;
  const failD = await Actions.ingestFinanceData.handler(ownerCtx(db), { success: false, error: "boom", generation: genD });
  check("obs: legal failure callback settles error", failD.ok === false && stateRow(sqlite).status === "error");
  const rowsD = obsRows(sqlite).slice(-2);
  check("obs: applied failure recorded (received + applied_failure)",
    rowsD[0]?.event === "callback_received" && rowsD[0]?.outcome === "failure_flag"
    && rowsD[1]?.event === "callback_applied_failure");
  const viewD = await Actions.getRefreshObservations.handler(ownerCtx(db), {});
  check("obs: settled failure diagnoses settled_failure for attempt #2",
    viewD.diagnosis?.code === "settled_failure" && viewD.diagnosis?.attempt === 2 && viewD.currentAttempt === 2);

  // (e) spawn failure records spawn_failed and diagnoses spawn_failed.
  const { sqlite: sqliteE, db: dbE } = freshDb();
  const failSpawn = async () => ({ ok: false });
  const resE = await Actions.refreshFinanceData.handler(ownerCtx(dbE, { spawnTask: failSpawn }), {});
  check("obs: spawn failure still returns the honest error", resE.ok === false && resE.status === "error");
  check("obs: spawn failure path records refresh_started then spawn_failed",
    JSON.stringify(obsEvents(sqliteE)) === JSON.stringify(["refresh_started", "spawn_failed"]));
  const viewE = await Actions.getRefreshObservations.handler(ownerCtx(dbE), {});
  check("obs: spawn failure diagnoses spawn_failed", viewE.diagnosis?.code === "spawn_failed");

  // (f) identity: the observation query is strictly owner-only.
  const guestView = await Actions.getRefreshObservations.handler(guestCtx(db), {});
  const anonView = await Actions.getRefreshObservations.handler(anonCtx(db), {});
  check("obs: guest/anonymous get guest_denied with zero data",
    guestView.access === "guest_denied" && guestView.state === null && guestView.currentAttempt === null
    && guestView.observations.length === 0 && guestView.diagnosis === null
    && anonView.access === "guest_denied" && anonView.state === null && anonView.observations.length === 0);

  // (g) a fresh artifact has no observations: the honest empty
  // state (no_attempt), not fabricated history.
  const { db: dbG } = freshDb();
  const viewG = await Actions.getRefreshObservations.handler(ownerCtx(dbG), {});
  check("obs: no records yet -> empty stream + no_attempt diagnosis",
    viewG.access === "owner" && viewG.observations.length === 0 && viewG.diagnosis?.code === "no_attempt"
    && viewG.diagnosis?.attempt === null && viewG.currentAttempt === null);

  // (h) detail hygiene across every recorded row in every stream
  // above: only short codes / counts — no amounts, payload
  // fragments, account strings or raw error text.
  const detailPattern = /^(generation_gate|stale_decision|claim_lost|settle_superseded|spawn_error|spawn_tail|status_idle|status_error|status_running|normalization_issue|no_dashboard|saved_months:\d+)$/;
  const allRows = [...obsRows(sqlite), ...obsRows(sqliteE)];
  check("obs: every recorded detail is a short code or a saved-month count",
    allRows.every((r: any) => r.detail == null || detailPattern.test(r.detail)));
  const streamText = JSON.stringify(allRows);
  check("obs: no financial values / payload fragments / raw errors in the stream",
    !streamText.includes("100000") && !streamText.includes("115000") && !streamText.includes("broker_1234")
    && !streamText.includes("boom") && !streamText.includes("asOf") && !streamText.includes("payload"));
}

// =====================================================================
// Group 13: F0.7-OBS-001 — per-attempt diagnosis (synthetic matrix)
// The diagnosis must be a function of the CURRENT attempt's own
// event chain only. Old-generation or unattributed events are
// history, never evidence — in either arrival order.
// =====================================================================
{
  type ObsRow = { event: string; outcome: string; detail: string | null; generation: string | null };
  const row = (event: string, generation: string | null, detail: string | null = null): ObsRow =>
    ({ event, outcome: "success_flag", detail, generation });
  const ORDER = ["gen-1", "gen-2"];
  const diag = (status: "idle" | "running" | "error" | null, currentGeneration: string | null, observations: ObsRow[]) =>
    deriveRefreshDiagnosis({ status, currentGeneration, attemptOrder: ORDER, observations });

  // (a) Two generations, settle order: gen-1 settled success, gen-2
  // running and attached. Diagnosis: gen-2 awaiting, attempt 2.
  check("obs001: gen-2 running after gen-1 settled success -> awaiting_callback #2",
    diag("running", "gen-2", [
      row("spawn_attached", "gen-2"), row("refresh_started", "gen-2"),
      row("callback_applied_success", "gen-1"), row("callback_received", "gen-1"),
      row("spawn_attached", "gen-1"), row("refresh_started", "gen-1"),
    ]).code === "awaiting_callback"
    && diag("running", "gen-2", [
      row("spawn_attached", "gen-2"), row("refresh_started", "gen-2"),
      row("callback_applied_success", "gen-1"), row("refresh_started", "gen-1"),
    ]).attempt === 2);

  // (b) PM repro order: gen-2 running + attached, then gen-1's
  // late FAILURE callback arrives (received + ignored) — the
  // globally newest events. Diagnosis must stay gen-2 awaiting.
  const pmRepro = diag("running", "gen-2", [
    row("callback_ignored", "gen-1", "generation_gate"), row("callback_received", "gen-1"),
    row("spawn_attached", "gen-2"), row("refresh_started", "gen-2"),
    row("spawn_attached", "gen-1"), row("refresh_started", "gen-1"),
  ]);
  check("obs001: PM repro — old-gen ignored failure arriving last does NOT pollute the current diagnosis",
    pmRepro.code === "awaiting_callback" && pmRepro.attempt === 2);
  check("obs001: awaiting text is the honest unknown form (等待当前代回调，执行终态未知）, no task-executed claim",
    pmRepro.text.includes("等待当前代回调") && pmRepro.text.includes("终态未知") && !pmRepro.text.includes("执行过"));

  // (c) Old-gen SUCCESS arriving late (ignored) while the current
  // attempt already settled failure on its own chain: the current
  // diagnosis stays settled_failure.
  check("obs001: old-gen ignored success late vs current own failure -> settled_failure #2",
    diag("error", "gen-2", [
      row("callback_ignored", "gen-1", "generation_gate"), row("callback_received", "gen-1"),
      row("callback_applied_failure", "gen-2"), row("callback_received", "gen-2"),
      row("refresh_started", "gen-2"), row("refresh_started", "gen-1"),
    ]).code === "settled_failure");

  // (d) Old-gen ignored failure arriving after the current attempt
  // settled success: diagnosis stays settled_success.
  check("obs001: old-gen ignored failure late vs current own success -> settled_success #2",
    diag("idle", "gen-2", [
      row("callback_ignored", "gen-1", "generation_gate"), row("callback_received", "gen-1"),
      row("callback_applied_success", "gen-2"), row("callback_received", "gen-2"),
      row("refresh_started", "gen-2"), row("refresh_started", "gen-1"),
    ]).code === "settled_success");

  // (e) Callback BEFORE the spawn tail: the own chain's newest row
  // is the unattached tail, recorded after the applied result.
  // The applied result still decides, both ways.
  check("obs001: callback applied before spawn tail (success) -> settled_success despite the newer tail row",
    diag("idle", "gen-1", [
      row("spawn_tail_unattached", "gen-1", "status_idle"),
      row("callback_applied_success", "gen-1"), row("callback_received", "gen-1"),
      row("refresh_started", "gen-1"),
    ]).code === "settled_success");
  check("obs001: callback applied before spawn tail (failure) -> settled_failure despite the newer tail row",
    diag("error", "gen-1", [
      row("spawn_tail_unattached", "gen-1", "status_error"),
      row("callback_applied_failure", "gen-1"), row("callback_received", "gen-1"),
      row("refresh_started", "gen-1"),
    ]).code === "settled_failure");

  // (f) The current attempt's OWN ignored callback (e.g. claim
  // lost) still diagnoses callback_ignored — only foreign ignored
  // callbacks lost that power.
  check("obs001: current attempt's own ignored callback -> callback_ignored #2",
    diag("running", "gen-2", [
      row("callback_ignored", "gen-2", "claim_lost"), row("callback_received", "gen-2"),
      row("spawn_attached", "gen-2"), row("refresh_started", "gen-2"),
      row("refresh_started", "gen-1"),
    ]).code === "callback_ignored");

  // (g) Own spawn failure still diagnoses spawn_failed.
  check("obs001: current attempt's own spawn failure -> spawn_failed #1",
    diag("error", "gen-1", [
      row("spawn_failed", "gen-1", "spawn_error"), row("refresh_started", "gen-1"),
    ]).code === "spawn_failed");

  // (h) No telemetry at all -> no_attempt, no ordinal.
  const none = diag(null, null, []);
  check("obs001: no history telemetry -> no_attempt with no attempt ordinal",
    none.code === "no_attempt" && none.attempt === null);

  // (i) History exists but no current attempt is bound -> the
  // rows are stated as unattributed history, never as a current
  // verdict.
  check("obs001: history without a bound current attempt -> unattributed_history",
    diag("running", null, [row("callback_received", "gen-1"), row("refresh_started", "gen-1")]).code
      === "unattributed_history");

  // (j) The current attempt's own rows fell outside the returned
  // window (truncation): other generations' rows are not evidence;
  // the diagnosis falls back to the attempt's own state status.
  const flood = Array.from({ length: 20 }, () => row("callback_received", "gen-1"));
  check("obs001: truncated stream, current attempt running -> awaiting_callback (not gen-1 noise)",
    diag("running", "gen-2", flood).code === "awaiting_callback");
  check("obs001: truncated stream, current attempt errored -> settled_failure",
    diag("error", "gen-2", flood).code === "settled_failure");
}

// ---------- Group 13b: real handlers, two generations ----------
{
  const { sqlite, db } = freshDb();
  // Attempt #1 settles success.
  await Actions.refreshFinanceData.handler(ownerCtx(db), {});
  const gen1: string = stateRow(sqlite).generation;
  await Actions.ingestFinanceData.handler(ownerCtx(db), successPayload(gen1, freshAsOf()));
  // Attempt #2 starts and attaches.
  await Actions.refreshFinanceData.handler(ownerCtx(db), {});
  const gen2: string = stateRow(sqlite).generation;
  check("obs001: second attempt minted", gen2 !== gen1 && stateRow(sqlite).status === "running");
  // Gen-1's late failure callback arrives now (PM repro, live).
  const late = await Actions.ingestFinanceData.handler(ownerCtx(db), { success: false, error: "old gen late failure", generation: gen1 });
  check("obs001: late old-gen failure still ignored by ingest", late.savedMonths === 0 && stateRow(sqlite).status === "running");
  const view = await Actions.getRefreshObservations.handler(ownerCtx(db), {});
  check("obs001: diagnosis after the late old-gen failure is awaiting_callback for attempt #2",
    view.diagnosis?.code === "awaiting_callback" && view.diagnosis?.attempt === 2 && view.currentAttempt === 2);
  const lateRows = view.observations.slice(0, 2);
  check("obs001: the late old-gen rows are labeled history attempt #1",
    lateRows.every((r: any) => r.relation === "history" && r.attempt === 1));
  check("obs001: attempt #2 rows are labeled current, attempt #1 settled rows labeled history",
    view.observations.filter((r: any) => r.attempt === 2).every((r: any) => r.relation === "current")
    && view.observations.filter((r: any) => r.attempt === 1 && r.relation !== "history").length === 0);
  // Gen-2 settles success; another late gen-1 event afterwards
  // must not move the settled diagnosis either.
  await Actions.ingestFinanceData.handler(ownerCtx(db), successPayload(gen2, freshAsOf()));
  await Actions.ingestFinanceData.handler(ownerCtx(db), { success: false, error: "old gen even later failure", generation: gen1 });
  const view2 = await Actions.getRefreshObservations.handler(ownerCtx(db), {});
  check("obs001: after gen-2 settles, a later old-gen event leaves settled_success #2 untouched",
    view2.diagnosis?.code === "settled_success" && view2.diagnosis?.attempt === 2);
  check("obs001: the raw generation values never leak into the observation view",
    !JSON.stringify(view2).includes(gen1) && !JSON.stringify(view2).includes(gen2));
}

// ---------- Group 13c: real handlers, 20-row display truncation ----------
{
  const { sqlite, db } = freshDb();
  await Actions.refreshFinanceData.handler(ownerCtx(db), {});
  const gen: string = stateRow(sqlite).generation;
  // 12 foreign callbacks -> 24 rows (received + ignored), pushing
  // the current attempt's own 2 rows out of the 20-row window.
  for (let i = 0; i < 12; i++) {
    await Actions.ingestFinanceData.handler(ownerCtx(db), { success: false, error: `foreign ${i}`, generation: `gen-FOREIGN-${i}` });
  }
  const view = await Actions.getRefreshObservations.handler(ownerCtx(db), {});
  check("obs001: display stream is capped at 20 rows", view.observations.length === 20);
  check("obs001: every displayed row is the foreign noise (unknown attribution, no ordinal)",
    view.observations.every((r: any) => r.relation === "unknown" && r.attempt === null));
  check("obs001: diagnosis still reads the current attempt's own chain (awaiting #1), unpolluted by the flood",
    view.diagnosis?.code === "awaiting_callback" && view.diagnosis?.attempt === 1 && view.currentAttempt === 1);
  check("obs001: the flood never touched the running state",
    stateRow(sqlite).status === "running" && stateRow(sqlite).generation === gen);
  await Actions.ingestFinanceData.handler(ownerCtx(db), { success: false, error: "harness cleanup", generation: gen });
}

// ---------- Group 13d: recording-failure isolation ----------
{
  const { sqlite, db } = freshDb();
  // Every observation INSERT aborts; selects still work. The
  // refresh chain must proceed exactly as if observability were
  // healthy, and the diagnosis must degrade to the attempt's own
  // state status — never borrow another generation's events
  // (there are none recorded) and never fabricate rows.
  sqlite.exec(`CREATE TRIGGER obs_insert_fail BEFORE INSERT ON refresh_observations
    BEGIN SELECT RAISE(ABORT, 'obs write disabled'); END`);
  const started = await Actions.refreshFinanceData.handler(ownerCtx(db), {});
  check("obs001: refresh starts normally while observation writes fail",
    started.ok && started.status === "started" && stateRow(sqlite).status === "running");
  const viewRun = await Actions.getRefreshObservations.handler(ownerCtx(db), {});
  check("obs001: with recording down, a running attempt diagnoses awaiting_callback from its own state",
    viewRun.access === "owner" && viewRun.observations.length === 0 && viewRun.diagnosis?.code === "awaiting_callback");
  const gen: string = stateRow(sqlite).generation;
  const saved = await Actions.ingestFinanceData.handler(ownerCtx(db), successPayload(gen, freshAsOf()));
  check("obs001: ingest still saves and settles while observation writes fail",
    saved.savedMonths === 2 && stateRow(sqlite).status === "idle");
  const viewDone = await Actions.getRefreshObservations.handler(ownerCtx(db), {});
  check("obs001: with recording down, the settled attempt diagnoses settled_success from its own state",
    viewDone.observations.length === 0 && viewDone.diagnosis?.code === "settled_success");
  sqlite.exec("DROP TRIGGER obs_insert_fail");
  check("obs001: no observation rows were recorded during the outage", obsRows(sqlite).length === 0);
}

console.log(`validate-refresh-chain: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
