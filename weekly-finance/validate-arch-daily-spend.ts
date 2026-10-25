// F-ARCH-001 daily-spend validation: drives REAL handlers against in-memory DB.
// Run: bun validate-arch-daily-spend.ts
import { Database } from "bun:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

const APP_DIR = new URL(".", import.meta.url).pathname;
const appRequire = createRequire(join(APP_DIR, "package.json"));
const { drizzle } = appRequire("drizzle-orm/bun-sqlite");
const schema = await import(join(APP_DIR, "server/src/schema.ts"));
const { Actions, summarizeSpendDailyServer } = await import(join(APP_DIR, "server/src/actions.ts"));

let passed = 0, failed = 0;
function check(name: string, cond: boolean) {
  if (cond) { passed++; } else { failed++; console.log("FAIL:", name); }
}
function approx(a: number, b: number) { return Math.abs(a - b) < 0.01; }

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
function dailyRowCount(sqlite: Database): number {
  return (sqlite.query("SELECT COUNT(*) AS n FROM arch_daily_spend").get() as any).n;
}
function storedDailyPayload(sqlite: Database): any {
  const row = sqlite.query("SELECT payload FROM arch_daily_spend ORDER BY id DESC LIMIT 1").get() as any;
  return row ? JSON.parse(row.payload) : null;
}
function makeCtx(db: any, opts: { viewer?: any }) {
  return {
    slug: "space-3",
    invocationId: "browser-harness",
    spaceDir: APP_DIR,
    viewer: opts.viewer,
    db: () => db,
    blobs: undefined,
    invalidateQueries: () => {},
    agent: { spawnTask: async () => ({ ok: true, taskId: "task-harness" }) },
    executePrivileged: async () => { throw new Error("not used"); },
  } as any;
}
const ownerCtx = (db: any) => makeCtx(db, { viewer: { isOwner: true } });
const guestCtx = (db: any) => makeCtx(db, { viewer: { isOwner: false } });
const syncCtx = (db: any) => makeCtx(db, {});

const PULLED_AT = "2026-10-24T15:00:00.000Z";
const COVERAGE_START = "2026-10-20";
const THROUGH_DATE = "2026-10-24";

// Synthetic fixture: 5-day window, identical duplicate, transfer, loan_mixed, refund offsetting earlier day, late-starting gating account
function fixtureTxns(): any[] {
  return [
    { id: "s1", date: "2026-10-20", amount: -50, status: "posted", kind: "spend", category: "FOOD_AND_DRINK", account: "acct_a" },
    { id: "s1", date: "2026-10-20", amount: -50, status: "posted", kind: "spend", category: "FOOD_AND_DRINK", account: "acct_a" },
    { id: "s2", date: "2026-10-20", amount: -20, status: "posted", kind: "spend", category: "TRANSPORTATION", account: "acct_a" },
    { id: "s3", date: "2026-10-22", amount: -30, status: "posted", kind: "spend", category: "FOOD_AND_DRINK", account: "acct_b" },
    { id: "tr1", date: "2026-10-21", amount: -500, status: "posted", kind: "transfer", account: "acct_a" },
    { id: "lm1", date: "2026-10-23", amount: -200, status: "posted", kind: "loan_mixed", account: "acct_a" },
    { id: "r1", date: "2026-10-23", amount: 10, status: "posted", kind: "refund", refundOf: "s1", account: "acct_a" },
    { id: "p1", date: "2026-10-24", amount: -15, status: "pending", kind: "spend", category: "ENTERTAINMENT", account: "acct_a" },
    { id: "s4", date: "2026-10-24", amount: -25, status: "posted", kind: "spend", category: "FOOD_AND_DRINK", account: "acct_a" },
  ];
}

function buildRequest(txns: any[], overrides: any = {}) {
  const recomputed = summarizeSpendDailyServer(txns, { fromDate: COVERAGE_START, toDate: THROUGH_DATE });
  return {
    arch: "F-ARCH-001" as const,
    version: 1 as const,
    pulledAt: PULLED_AT,
    coverageStart: COVERAGE_START,
    throughDate: THROUGH_DATE,
    fullCoverageStart: recomputed.fullCoverageStart,
    transactions: txns,
    days: recomputed.days,
    ...overrides,
  };
}

function checkResponseShape(name: string, res: any) {
  const keys = Object.keys(res).sort();
  const expected = ["chunksExpected", "chunksReceived", "coverageStart", "days", "issue", "ok", "readBackVerified", "throughDate", "totalMatches"].sort();
  check(`${name}: response keys exactly counts/dates/booleans only`, JSON.stringify(keys) === JSON.stringify(expected));
  check(`${name}: response has no amount/total/posted/pending fields`, !("amount" in res) && !("total" in res) && !("posted" in res) && !("pending" in res) && !("totals" in res));
}

// Happy path
{
  const { sqlite, db } = freshDb();
  const txns = fixtureTxns();
  const req = buildRequest(txns);
  const res = await Actions.ingestArchDailySpend.handler(ownerCtx(db), req);
  checkResponseShape("happy", res);
  check("happy: ok + readBackVerified", res.ok === true && res.readBackVerified === true && res.issue === null && res.totalMatches === true);
  check("happy: full mode chunk counters stay 0", res.chunksReceived === 0 && res.chunksExpected === 0);
  check("happy: days count 5", res.days === 5 && res.coverageStart === COVERAGE_START && res.throughDate === THROUGH_DATE);
  check("happy: exactly 1 stored row", dailyRowCount(sqlite) === 1);
  const stored = storedDailyPayload(sqlite);
  check("happy: stored kind/coverage", stored.kind === "daily-spend" && stored.coverageStart === COVERAGE_START && stored.throughDate === THROUGH_DATE);
  check("happy: stored fullCoverageStart is late gating account start 2026-10-22", stored.fullCoverageStart === "2026-10-22");
  // Repo caliber expectations
  const byDate = new Map(stored.days.map((d: any) => [d.date, d]));
  const d20 = byDate.get("2026-10-20");
  check("happy: 10-20 posted 60 after refund offset (50+20-10)", approx(d20.posted, 60));
  check("happy: 10-20 categories FOOD 40 + TRANSPORT 20", d20.categories.length === 2 && approx(d20.categories.find((c: any) => c.key === "FOOD_AND_DRINK").amount, 40) && approx(d20.categories.find((c: any) => c.key === "TRANSPORTATION").amount, 20));
  check("happy: 10-20 spendCount 2 partial true", d20.spendCount === 2 && d20.partial === true);
  const d21 = byDate.get("2026-10-21");
  check("happy: 10-21 posted 0 (transfer excluded) partial true", approx(d21.posted, 0) && d21.partial === true && d21.spendCount === 0);
  const d22 = byDate.get("2026-10-22");
  check("happy: 10-22 posted 30 partial false", approx(d22.posted, 30) && d22.partial === false);
  const d23 = byDate.get("2026-10-23");
  check("happy: 10-23 posted 0 unclassified loan_mixed", approx(d23.posted, 0) && d23.unclassified.length === 1 && d23.unclassified[0] === "lm1");
  const d24 = byDate.get("2026-10-24");
  check("happy: 10-24 posted 25 pending 15", approx(d24.posted, 25) && approx(d24.pending, 15) && d24.spendCount === 1 && d24.pendingCount === 1);
  check("happy: totals posted 115 pending 15", approx(stored.totals.posted, 115) && approx(stored.totals.pending, 15));
  check("happy: counts", stored.counts.transactions === 9 && stored.counts.conflicts === 0 && stored.counts.unappliedRefunds === 0 && stored.counts.unclassified === 1 && stored.counts.excludedTransfer === 1 && stored.counts.excludedLoanPrincipal === 0);
}

// Tampered days -> daily_mismatch zero writes
{
  const { sqlite, db } = freshDb();
  const txns = fixtureTxns();
  const req = buildRequest(txns);
  const tamperedDays = req.days.map((d: any, i: number) => i === 0 ? { ...d, posted: d.posted + 999 } : d);
  const res = await Actions.ingestArchDailySpend.handler(ownerCtx(db), { ...req, days: tamperedDays });
  checkResponseShape("tampered", res);
  check("tampered: daily_mismatch", res.ok === false && res.issue === "daily_mismatch" && res.totalMatches === false);
  check("tampered: zero rows written", dailyRowCount(sqlite) === 0);
}

// Invalid calendar date -> invalid_date
{
  const { sqlite, db } = freshDb();
  const txns = fixtureTxns();
  txns.push({ id: "bad1", date: "2026-02-30", amount: -5, status: "posted", kind: "spend", category: "FOOD_AND_DRINK", account: "acct_a" });
  const req = buildRequest(fixtureTxns());
  const res = await Actions.ingestArchDailySpend.handler(ownerCtx(db), { ...req, transactions: txns });
  check("invalid_date: rejected for txn date 2026-02-30", res.ok === false && res.issue === "invalid_date");
  check("invalid_date: zero rows", dailyRowCount(sqlite) === 0);
  // also coverageStart invalid
  const { sqlite: s2, db: db2 } = freshDb();
  const req2 = buildRequest(fixtureTxns(), { coverageStart: "2026-13-01" });
  const res2 = await Actions.ingestArchDailySpend.handler(ownerCtx(db2), req2);
  check("invalid_date: coverageStart invalid", res2.ok === false && res2.issue === "invalid_date" && dailyRowCount(s2) === 0);
}

// Same pulledAt same content retry -> ok, still 1 row
{
  const { sqlite, db } = freshDb();
  const req = buildRequest(fixtureTxns());
  const res1 = await Actions.ingestArchDailySpend.handler(ownerCtx(db), req);
  const res2 = await Actions.ingestArchDailySpend.handler(ownerCtx(db), req);
  check("retry same content: both ok", res1.ok === true && res2.ok === true);
  check("retry same content: still exactly 1 stored row", dailyRowCount(sqlite) === 1);
}

// Same pulledAt different content -> version_conflict
{
  const { sqlite, db } = freshDb();
  const req = buildRequest(fixtureTxns());
  const res1 = await Actions.ingestArchDailySpend.handler(ownerCtx(db), req);
  check("conflict setup: first ok", res1.ok === true);
  // Different content but internally consistent: change a txn amount and recompute days accordingly
  const txns2 = fixtureTxns().map((t: any) => t.id === "s4" ? { ...t, amount: -26 } : t);
  const req2 = buildRequest(txns2); // same pulledAt, different days/totals
  const res2 = await Actions.ingestArchDailySpend.handler(ownerCtx(db), req2);
  checkResponseShape("version_conflict", res2);
  check("version_conflict: rejected", res2.ok === false && res2.issue === "version_conflict");
  check("version_conflict: still 1 row", dailyRowCount(sqlite) === 1);
}

// Older pulledAt after newer -> stale_version
{
  const { sqlite, db } = freshDb();
  const reqNew = buildRequest(fixtureTxns(), { pulledAt: "2026-10-24T16:00:00.000Z" });
  const res1 = await Actions.ingestArchDailySpend.handler(ownerCtx(db), reqNew);
  check("stale setup: newer ok", res1.ok === true);
  const reqOld = buildRequest(fixtureTxns(), { pulledAt: "2026-10-24T14:00:00.000Z" });
  const res2 = await Actions.ingestArchDailySpend.handler(ownerCtx(db), reqOld);
  check("stale_version: older rejected", res2.ok === false && res2.issue === "stale_version");
  check("stale_version: still 1 row", dailyRowCount(sqlite) === 1);
}

// Guest -> forbidden
{
  const { sqlite, db } = freshDb();
  const req = buildRequest(fixtureTxns());
  const res = await Actions.ingestArchDailySpend.handler(guestCtx(db), req);
  checkResponseShape("forbidden", res);
  check("forbidden: guest rejected", res.ok === false && res.issue === "forbidden");
  check("forbidden: zero rows", dailyRowCount(sqlite) === 0);
  // sync channel passes
  const { sqlite: s2, db: db2 } = freshDb();
  const res2 = await Actions.ingestArchDailySpend.handler(syncCtx(db2), req);
  check("forbidden: sync channel (no viewer) passes", res2.ok === true && dailyRowCount(s2) === 1);
}

// getDashboard attaches archDailySpend and 2-point archNetWorthSeries
{
  const { sqlite, db } = freshDb();
  const legacyDashboard = {
    asOf: "2026-10-01", sourceMonth: "2026-09", months: [],
    live: { netWorth: 0, investment: 0, saving: 0, weeklyDelta: null },
    holdings: [], concentrationTop3: 0, accounts: [],
    fire: { annualContribution: 0, annualSpend: 0, target: 0, progress: null, gap: 0 },
  };
  sqlite.query("INSERT INTO finance_state (id, payload, status, updated_at) VALUES (1, ?, 'idle', ?)")
    .run(JSON.stringify(legacyDashboard), Date.now());
  // Seed daily spend
  const req = buildRequest(fixtureTxns());
  const dailyRes = await Actions.ingestArchDailySpend.handler(ownerCtx(db), req);
  check("dashboard setup: daily ingest ok", dailyRes.ok === true);
  // Seed two arch net worth versions on different dates via ingestArchNetWorth
  const acct = (id: string, balance: number | null, kind: string, coverage: string, asOf: string | null) => ({ id, balance, kind, coverage, asOf });
  const nw1 = await Actions.ingestArchNetWorth.handler(ownerCtx(db), {
    arch: "F-ARCH-001" as const, version: 1 as const, pulledAt: "2026-10-23T15:00:00.000Z",
    accounts: [acct("bank_a", 1000, "asset", "plaid", "2026-10-23")], total: 1000,
  });
  check("dashboard setup: nw1 ok", nw1.ok === true);
  const nw2 = await Actions.ingestArchNetWorth.handler(ownerCtx(db), {
    arch: "F-ARCH-001" as const, version: 1 as const, pulledAt: "2026-10-24T15:00:00.000Z",
    accounts: [acct("bank_a", 1100, "asset", "plaid", "2026-10-24")], total: 1100,
  });
  check("dashboard setup: nw2 ok", nw2.ok === true);
  const view = await Actions.getDashboard.handler(ownerCtx(db), {});
  check("dashboard: owner access with data", view.access === "owner" && view.data != null);
  check("dashboard: archDailySpend attached", view.data?.archDailySpend != null && view.data.archDailySpend.coverageStart === COVERAGE_START && view.data.archDailySpend.days.length === 5);
  check("dashboard: archNetWorthSeries 2 points", view.data?.archNetWorthSeries.length === 2);
  check("dashboard: series sorted ascending with correct dates/totals",
    view.data?.archNetWorthSeries[0]?.date === "2026-10-23" && view.data?.archNetWorthSeries[0]?.total === 1000 &&
    view.data?.archNetWorthSeries[1]?.date === "2026-10-24" && view.data?.archNetWorthSeries[1]?.total === 1100);
  const guest = await Actions.getDashboard.handler(guestCtx(db), {});
  check("dashboard: guest denied", guest.access === "guest_denied" && guest.data === null);
}

console.log(`validate-arch-daily-spend: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
