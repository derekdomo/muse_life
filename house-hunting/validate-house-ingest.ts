// HH0.2 / HH0.3 real-handler behaviour validation.
// Drives the REAL actions (refreshReport / ingestResearch / getReport /
// initializeReport) against an isolated in-memory SQLite built from the
// app's own drizzle migrations, with fake ctx objects for the owner,
// the scheduler, and the daemon-validated task-return channel. Covers
// the PM repro matrix: old success/failure landing on a new running
// generation, concurrent duplicate callbacks, claim-loser re-read,
// a new generation starting before the old winner publishes, out-of-
// order asOf, insufficient/duplicate candidates, mid-write candidate
// invisibility, and pre-migration data compatibility.
// All fixtures are synthetic; nothing touches the real app.db.
//
// Run with Bun (needs a checkout with dependencies installed):
//   HOUSE_APP_DIR=/path/to/app bun validate-house-ingest.ts
import { Database } from "bun:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

const APP_DIR = process.env.HOUSE_APP_DIR ?? new URL(".", import.meta.url).pathname;
// Resolve the app's own dependencies from the app checkout, not from
// this script's directory (the repo copy carries no node_modules).
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
  return sqlite.query("SELECT * FROM refresh_state WHERE id = 1").get();
}
function reportCount(sqlite: Database): number {
  return (sqlite.query("SELECT COUNT(*) AS c FROM reports").get() as any).c;
}
function listingsOf(sqlite: Database, reportId: number): any[] {
  return sqlite.query("SELECT * FROM listings WHERE report_id = ? ORDER BY rank").all(reportId);
}

// ---------- ctx fakes ----------
function makeCtx(db: any, opts: { viewer?: any; invocationId: string; spawnTask?: any }) {
  return {
    slug: "space-2",
    invocationId: opts.invocationId,
    spaceDir: APP_DIR,
    viewer: opts.viewer,
    db: () => db,
    blobs: undefined,
    invalidateQueries: () => {},
    agent: { spawnTask: opts.spawnTask ?? (async () => ({ ok: true, taskId: "task-harness" })) },
    executePrivileged: async () => { throw new Error("not used"); },
  } as any;
}
const ownerCtx = (db: any, extra?: any) => makeCtx(db, { viewer: { isOwner: true }, invocationId: "browser-harness", ...extra });
const taskCtx = (db: any) => makeCtx(db, { invocationId: "space-task-return-harness" });
const readerCtx = (db: any) => makeCtx(db, { invocationId: "browser-harness" });

// ---------- synthetic payloads ----------
let asOfTick = 0;
const freshAsOf = () => new Date(Date.now() + ++asOfTick * 3_600_000).toISOString();
function makeListing(n: number, overrides?: Record<string, any>) {
  return {
    rank: n, score: 90, address: `${100 + n} Synthetic Test St`, city: "Sunnyvale",
    url: `https://www.redfin.com/CA/Sunnyvale/${100 + n}-Synthetic-Test-St-94086/home/${900000 + n}`,
    price: 2_500_000, bedrooms: 4, bathrooms: 3, sqft: 2000, lotSqft: 6000, yearBuilt: 1970,
    daysOnMarket: 5, pricePerSqft: 1250, priceChange: null, hoaMonthly: 0, status: "active",
    schoolSummary: "synthetic schools", environmentSummary: "synthetic quiet street",
    conditionSummary: "synthetic condition", verdict: "synthetic verdict", caution: null,
    ...(overrides ?? {}),
  };
}
function successPayload(generation: string | undefined, asOf: string, listings?: any[]) {
  return {
    success: true as const,
    ...(generation != null ? { generation } : {}),
    asOf, mortgageRate: 7.0, rateLabel: "synthetic rate", rateSource: "synthetic source",
    rateUrl: "https://example.com/rates", summary: "synthetic summary for harness",
    listings: listings ?? [makeListing(1), makeListing(2), makeListing(3)],
  };
}

// ---------- db wrapper that pauses the first insert into a table ----------
// Lets a test hold callback A after it has won the claim (or after its
// candidate report row exists) while callback B / a new generation runs.
function wrapDbPauseOnInsert(db: any, table: any, gate: Promise<void>) {
  let armed = true;
  const proxify = (b: any): any =>
    new Proxy(b, {
      get(t, p) {
        if (p === "values") return (...a: any[]) => proxify(t.values(...a));
        if (p === "returning") return (...a: any[]) => gate.then(() => t.returning(...a));
        if (p === "then") return (onF: any, onR: any) => gate.then(() => t).then(onF, onR);
        const v = Reflect.get(t, p, t);
        return typeof v === "function" ? v.bind(t) : v;
      },
    });
  return new Proxy(db, {
    get(t, p) {
      const v = Reflect.get(t, p, t);
      if (p === "insert" && typeof v === "function") {
        return (tbl: any) => {
          const builder = v.call(t, tbl);
          if (armed && tbl === table) { armed = false; return proxify(builder); }
          return builder;
        };
      }
      return typeof v === "function" ? v.bind(t) : v;
    },
  });
}
async function waitFor(label: string, cond: () => boolean, ms = 5000) {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error(`timeout waiting for: ${label}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

// =====================================================================
// Scenario group 1: generation gate on a live running refresh
// =====================================================================
{
  const { sqlite, db } = freshDb();
  const init = await Actions.initializeReport.handler(ownerCtx(db), {});
  check("init creates the snapshot report", init.ok && init.created);
  const rep0 = await Actions.getReport.handler(readerCtx(db), {});
  check("seeded report visible with its date", rep0.report?.asOf === "2026-09-19T12:00:00-07:00" && rep0.report.listings.length === 14);

  let promptSeen = "";
  const spawn = async (p: string) => { promptSeen = p; return { ok: true, taskId: "task-1" }; };
  const started = await Actions.refreshReport.handler(ownerCtx(db, { spawnTask: spawn }), {});
  check("refresh starts", started.ok && started.status === "started");
  const st1 = stateRow(sqlite);
  const gen1: string = st1.generation;
  check("generation minted and stored at refresh start", typeof gen1 === "string" && gen1.length > 0);
  check("spawn prompt carries the generation verbatim", promptSeen.includes(gen1));
  check("state running with task id", st1.status === "running" && st1.task_id === "task-1");

  const during = await Actions.getReport.handler(readerCtx(db), {});
  check("getReport during refresh still shows the previous published issue", during.report?.id === rep0.report?.id && during.refresh.status === "running");

  const before = { ...stateRow(sqlite) };
  const oldFail = await Actions.ingestResearch.handler(taskCtx(db), { success: false, error: "old generation failure" });
  check("old failure without generation ignored on new running", oldFail.ok === false && oldFail.saved === 0);
  const afterFail = stateRow(sqlite);
  check("state row fully unchanged after old failure", afterFail.status === "running" && afterFail.generation === gen1 && afterFail.task_id === "task-1" && afterFail.updated_at === before.updated_at && afterFail.claimed_generation == null);

  const oldFailGen = await Actions.ingestResearch.handler(taskCtx(db), { success: false, error: "older generation failure", generation: "gen-OLD" });
  check("old failure with foreign generation ignored", oldFailGen.saved === 0 && stateRow(sqlite).status === "running");

  const oldSuccess = await Actions.ingestResearch.handler(taskCtx(db), successPayload("gen-OLD", freshAsOf()));
  check("old success with foreign generation ignored (saved=0)", oldSuccess.ok && oldSuccess.saved === 0);
  const oldSuccessNoGen = await Actions.ingestResearch.handler(taskCtx(db), successPayload(undefined, freshAsOf()));
  check("old success without generation ignored (saved=0)", oldSuccessNoGen.saved === 0);
  check("no report inserted by old callbacks", reportCount(sqlite) === 1);
  check("running state survives old callbacks", stateRow(sqlite).status === "running" && stateRow(sqlite).generation === gen1);

  const curFail = await Actions.ingestResearch.handler(taskCtx(db), { success: false, error: "current generation failed", generation: gen1 });
  check("current-generation failure settles only this generation to error", curFail.ok === false && stateRow(sqlite).status === "error");
  check("failure inserted nothing", reportCount(sqlite) === 1);

  // ---- group 2: concurrent duplicate callbacks of one generation ----
  const started2 = await Actions.refreshReport.handler(ownerCtx(db), {});
  check("refresh restarts after error", started2.ok && started2.status === "started");
  const gen2: string = stateRow(sqlite).generation;
  check("new generation differs", gen2 !== gen1);
  const asOf2 = freshAsOf();
  const payload2 = successPayload(gen2, asOf2);
  const [c1, c2] = await Promise.all([
    Actions.ingestResearch.handler(taskCtx(db), payload2),
    Actions.ingestResearch.handler(taskCtx(db), payload2),
  ]);
  const savedPair = [c1.saved, c2.saved].sort();
  check("concurrent duplicates: exactly one saved=3, other saved=0", savedPair[0] === 0 && savedPair[1] === 3);
  check("concurrent duplicates: exactly one new report", reportCount(sqlite) === 2);
  const st2 = stateRow(sqlite);
  const rep2 = await Actions.getReport.handler(readerCtx(db), {});
  check("published report is the new issue, state idle", rep2.report?.asOf === asOf2 && rep2.report.listings.length === 3 && st2.status === "idle");
  check("publish pointer names the visible report", st2.published_report_id === rep2.report?.id);

  // ---- group 3: A claims and pauses; B (loser) re-reads ----
  await Actions.refreshReport.handler(ownerCtx(db), {});
  const gen3: string = stateRow(sqlite).generation;
  const asOf3 = freshAsOf();
  let releaseA!: () => void;
  const gateA = new Promise<void>((res) => { releaseA = res; });
  const wrappedA = wrapDbPauseOnInsert(db, schema.reports, gateA);
  const pA = Actions.ingestResearch.handler(taskCtx(wrappedA), successPayload(gen3, asOf3));
  await waitFor("A claims generation 3", () => stateRow(sqlite).claimed_generation != null);
  const resB = await Actions.ingestResearch.handler(taskCtx(db), successPayload(gen3, asOf3));
  check("claim loser re-read does not insert (saved=0)", resB.saved === 0);
  check("claim loser inserted no report", reportCount(sqlite) === 2);
  check("claim loser left the running state untouched", stateRow(sqlite).status === "running");
  releaseA();
  const resA = await pA;
  check("claim winner completes with saved=3", resA.saved === 3);
  check("exactly one report from the claimed generation", reportCount(sqlite) === 3);
  check("state idle after winner publishes", stateRow(sqlite).status === "idle");

  // ---- group 4: new generation starts before A publishes ----
  await Actions.refreshReport.handler(ownerCtx(db), {});
  const gen4: string = stateRow(sqlite).generation;
  const asOf4 = freshAsOf();
  let releaseB!: () => void;
  const gateB = new Promise<void>((res) => { releaseB = res; });
  const wrappedB = wrapDbPauseOnInsert(db, schema.listings, gateB);
  const pB = Actions.ingestResearch.handler(taskCtx(wrappedB), successPayload(gen4, asOf4));
  await waitFor("candidate report row written", () => reportCount(sqlite) === 4);
  const midRep = await Actions.getReport.handler(readerCtx(db), {});
  check("candidate mid-write (listings pending): getReport still returns previous issue", midRep.report?.asOf === asOf3);
  // Age the stuck refresh past the 2h stale threshold, then start gen5.
  sqlite.exec(`UPDATE refresh_state SET updated_at = ${Date.now() - 3 * 3_600_000} WHERE id = 1`);
  const started5 = await Actions.refreshReport.handler(ownerCtx(db), {});
  const gen5: string = stateRow(sqlite).generation;
  check("new generation starts over the stuck one", started5.status === "started" && gen5 !== gen4 && stateRow(sqlite).status === "running");
  releaseB();
  const resBold = await pB;
  check("superseded winner cannot publish (saved=0)", resBold.saved === 0);
  const stAfterOld = stateRow(sqlite);
  check("superseded winner cannot settle the new generation", stAfterOld.status === "running" && stAfterOld.generation === gen5);
  const repAfterOld = await Actions.getReport.handler(readerCtx(db), {});
  check("visible report still the previous issue after superseded save", repAfterOld.report?.asOf === asOf3);
  const cand = sqlite.query("SELECT * FROM reports WHERE as_of = ?").get(asOf4) as any;
  check("superseded candidate stays invisible (published=0, pointer elsewhere)", cand != null && cand.published === 0 && stAfterOld.published_report_id !== cand.id);
  const asOf5 = freshAsOf();
  const res5 = await Actions.ingestResearch.handler(taskCtx(db), successPayload(gen5, asOf5));
  const rep5 = await Actions.getReport.handler(readerCtx(db), {});
  check("new generation publishes once and settles idle", res5.saved === 3 && rep5.report?.asOf === asOf5 && stateRow(sqlite).status === "idle");

  // ---- group 5: insufficient / duplicate candidates never publish ----
  await Actions.refreshReport.handler(ownerCtx(db), {});
  const gen6: string = stateRow(sqlite).generation;
  const fewPayload = successPayload(gen6, freshAsOf(), [
    makeListing(1), makeListing(2), makeListing(3, { url: "https://example.com/not-a-listing" }),
  ]);
  const fewRes = await Actions.ingestResearch.handler(taskCtx(db), fewPayload);
  check("fewer than 3 valid listings: not saved, state error", fewRes.ok === false && fewRes.saved === 0 && stateRow(sqlite).status === "error");
  check("insufficient candidate inserted nothing and old issue stays visible", reportCount(sqlite) === 5 && (await Actions.getReport.handler(readerCtx(db), {})).report?.asOf === asOf5);

  await Actions.refreshReport.handler(ownerCtx(db), {});
  const gen7: string = stateRow(sqlite).generation;
  const dupUrl = successPayload(gen7, freshAsOf(), [
    makeListing(1), makeListing(2, { url: makeListing(1).url }), makeListing(3),
  ]);
  const dupUrlRes = await Actions.ingestResearch.handler(taskCtx(db), dupUrl);
  check("duplicate URL candidate rejected, old issue stays", dupUrlRes.saved === 0 && stateRow(sqlite).status === "error" && reportCount(sqlite) === 5);

  await Actions.refreshReport.handler(ownerCtx(db), {});
  const gen8: string = stateRow(sqlite).generation;
  const dupAddr = successPayload(gen8, freshAsOf(), [
    makeListing(1), makeListing(2, { address: "  101 SYNTHETIC TEST ST " }), makeListing(3),
  ]);
  const dupAddrRes = await Actions.ingestResearch.handler(taskCtx(db), dupAddr);
  check("duplicate normalized-address candidate rejected, old issue stays", dupAddrRes.saved === 0 && stateRow(sqlite).status === "error" && reportCount(sqlite) === 5);

  // ---- group 6: permission contract unchanged ----
  const denied = await Actions.ingestResearch.handler(makeCtx(db, { invocationId: "artifact-action-tool-harness" }), successPayload(gen8, freshAsOf()));
  check("viewer-less non-platform ingest denied with zero writes", denied.ok === false && denied.saved === 0 && reportCount(sqlite) === 5);
  await Actions.refreshReport.handler(ownerCtx(db), {});
  const ownerView = await Actions.getReport.handler(ownerCtx(db), {});
  const publicView = await Actions.getReport.handler(makeCtx(db, { viewer: { isOwner: false }, invocationId: "browser-harness" }), {});
  check("taskId owner-only while public read still works", ownerView.refresh.taskId === "task-harness" && publicView.refresh.taskId === null && publicView.report?.asOf === asOf5);
  const genLast: string = stateRow(sqlite).generation;
  await Actions.ingestResearch.handler(taskCtx(db), { success: false, error: "harness cleanup", generation: genLast });
}

// =====================================================================
// Scenario group 7: out-of-order asOf + settled-state duplicates
// =====================================================================
{
  const { sqlite, db } = freshDb();
  await Actions.initializeReport.handler(ownerCtx(db), {});
  await Actions.refreshReport.handler(ownerCtx(db), {});
  const st = stateRow(sqlite);
  const gen: string = st.generation;
  const beforeStartAsOf = new Date(st.updated_at - 1000).toISOString();
  const early = await Actions.ingestResearch.handler(taskCtx(db), successPayload(gen, beforeStartAsOf));
  check("success stamped before this generation started is ignored", early.saved === 0 && stateRow(sqlite).status === "running" && reportCount(sqlite) === 1);

  const asOf = freshAsOf();
  const okRes = await Actions.ingestResearch.handler(taskCtx(db), successPayload(gen, asOf));
  check("current generation publishes and settles idle", okRes.saved === 3 && stateRow(sqlite).status === "idle");
  const serialDup = await Actions.ingestResearch.handler(taskCtx(db), successPayload(gen, asOf));
  check("serial same-asOf duplicate after settle saved=0", serialDup.saved === 0 && reportCount(sqlite) === 2);
  const lateFail = await Actions.ingestResearch.handler(taskCtx(db), { success: false, error: "late failure", generation: gen });
  check("late failure after settle ignored, state stays idle", lateFail.saved === 0 && stateRow(sqlite).status === "idle");
  const older = await Actions.ingestResearch.handler(taskCtx(db), successPayload(gen, "2026-09-19T12:00:00-07:00"));
  check("older asOf after settle ignored (no regression)", older.saved === 0 && reportCount(sqlite) === 2);
}

// =====================================================================
// Scenario group 8: legacy rows (pre-generation contract) still work
// =====================================================================
{
  const { sqlite, db } = freshDb();
  await Actions.initializeReport.handler(ownerCtx(db), {});
  sqlite.exec("UPDATE refresh_state SET status = 'running', generation = NULL, claimed_generation = NULL, task_id = 'legacy-task', updated_at = " + Date.now());
  const legacyFail = await Actions.ingestResearch.handler(taskCtx(db), { success: false, error: "legacy failure" });
  check("legacy running row: ungated failure still settles error", legacyFail.ok === false && stateRow(sqlite).status === "error");
  sqlite.exec("UPDATE refresh_state SET status = 'running', generation = NULL, claimed_generation = NULL, updated_at = " + Date.now());
  const legacyOk = await Actions.ingestResearch.handler(taskCtx(db), successPayload(undefined, freshAsOf()));
  const repLegacy = await Actions.getReport.handler(readerCtx(db), {});
  check("legacy running row: ungated success still publishes", legacyOk.saved === 3 && stateRow(sqlite).status === "idle" && repLegacy.report != null && repLegacy.report.listings.length === 3);
}

// =====================================================================
// Scenario group 9: migration compatibility (0002 data -> 0003)
// =====================================================================
{
  const sqlite = new Database(":memory:");
  const files = migrationFiles();
  for (const f of files.slice(0, 2)) applyMigrationFile(sqlite, f);
  sqlite.exec(`INSERT INTO reports (as_of, mortgage_rate, rate_label, rate_source, rate_url, summary, created_at)
    VALUES ('2026-10-11T12:00:00-07:00', 7.05, 'legacy label', 'legacy source', 'https://example.com/old', 'legacy summary', ${Date.now()})`);
  const legacyReportId = (sqlite.query("SELECT MAX(id) AS id FROM reports").get() as any).id;
  sqlite.exec(`INSERT INTO listings (report_id, rank, score, address, city, url, price, bedrooms, bathrooms, sqft, status, school_summary, environment_summary, condition_summary, verdict)
    VALUES (${legacyReportId}, 1, 80, '1 Legacy Way', 'Sunnyvale', 'https://www.redfin.com/CA/Sunnyvale/1-Legacy-Way/home/1', 2400000, 4, 3, 1900, 'active', 's', 'e', 'c', 'v')`);
  sqlite.exec(`INSERT INTO refresh_state (id, status, task_id, message, updated_at) VALUES (1, 'idle', NULL, 'legacy', ${Date.now()})`);
  applyMigrationFile(sqlite, files[2]!);
  const db = drizzle(sqlite, { schema }) as any;
  const rep = await Actions.getReport.handler(readerCtx(db), {});
  check("post-migration: previous latest issue is the published visible one", rep.report?.id === legacyReportId && rep.report.asOf === "2026-10-11T12:00:00-07:00" && rep.report.listings.length === 1);
  const st = stateRow(sqlite);
  const flag = sqlite.query("SELECT published FROM reports WHERE id = ?").get(legacyReportId) as any;
  check("migration backfilled pointer + published flag, history intact", st.published_report_id === legacyReportId && flag.published === 1 && reportCount(sqlite) === 1);
}

console.log(`validate-house-ingest: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
