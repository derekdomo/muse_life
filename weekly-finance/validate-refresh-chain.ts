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
const { Actions } = await import(join(APP_DIR, "server/src/actions.ts"));

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

console.log(`validate-refresh-chain: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
