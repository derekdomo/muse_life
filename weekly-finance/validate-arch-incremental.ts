// F-ARCH-001·INCR-1 incremental-mode validation: drives the
// REAL ingestArchDailySpend / ingestArchDailyIncome handlers
// (mode:"incremental") against an in-memory DB, same harness
// style as validate-arch-daily-spend-chunks.ts. All fixtures
// are synthetic; no real financial data is ever used here.
// Covers: happy-path merge + throughDate advance +
// readBackVerified, pending→posted flip inside the overlap
// window, stale_base rejection, per-day recompute rejection
// (daily_mismatch), merged-totals rejection
// (incremental_mismatch) — every rejection leaving the stored
// production version byte-identical (rollback semantics) —
// no_base on an empty store, guest forbidden, and coexistence
// with the legacy full leg after an incremental publish.
// Run: bun validate-arch-incremental.ts
import { Database } from "bun:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

const APP_DIR = new URL(".", import.meta.url).pathname;
const appRequire = createRequire(join(APP_DIR, "package.json"));
const { drizzle } = appRequire("drizzle-orm/bun-sqlite");
const schema = await import(join(APP_DIR, "server/src/schema.ts"));
const { Actions, summarizeSpendDailyServer, summarizeIncomeDailyServer } = await import(join(APP_DIR, "server/src/actions.ts"));

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

// ---------------- daily spend ----------------
const SPEND_START = "2026-10-20";
const SPEND_BASE_THROUGH = "2026-10-24";
const SPEND_NEW_THROUGH = "2026-10-26";
const SPEND_BASE_PULLED = "2026-10-24T15:00:00.000Z";
const SPEND_INCR_PULLED = "2026-10-26T15:00:00.000Z";

function spendFixtureV1(): any[] {
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

// V2 = the worker's fresh full-window pull two days later:
// p1 flipped pending→posted; two new spend days; one new
// transfer; one new pending row.
function spendFixtureV2(): any[] {
  return [
    ...spendFixtureV1().map((t) => t.id === "p1" ? { ...t, status: "posted" } : t),
    { id: "s5", date: "2026-10-25", amount: -40, status: "posted", kind: "spend", category: "FOOD_AND_DRINK", account: "acct_a" },
    { id: "tr2", date: "2026-10-25", amount: -300, status: "posted", kind: "transfer", account: "acct_a" },
    { id: "s6", date: "2026-10-26", amount: -60, status: "posted", kind: "spend", category: "TRANSPORTATION", account: "acct_a" },
    { id: "p2", date: "2026-10-26", amount: -10, status: "pending", kind: "spend", category: "ENTERTAINMENT", account: "acct_a" },
  ];
}

function spendFullRequest(txns: any[], through: string, pulledAt: string) {
  const recomputed = summarizeSpendDailyServer(txns, { fromDate: SPEND_START, toDate: through });
  return {
    arch: "F-ARCH-001" as const, version: 1 as const,
    pulledAt, coverageStart: SPEND_START, throughDate: through,
    fullCoverageStart: recomputed.fullCoverageStart,
    transactions: txns, days: recomputed.days,
  };
}

// Worker-side delta assembly: (baseThroughDate-2, newThrough]
// segment, days recomputed over the segment with partial flags
// re-derived from the full-window fullCoverageStart — the same
// adjustment the server applies before comparing.
function spendIncrementalRequest(overrides: any = {}) {
  const v2 = spendFixtureV2();
  const deltaFrom = "2026-10-23"; // baseThroughDate (10-24) - 2 days, exclusive lower bound +1
  const deltaTxns = v2.filter((t) => t.date >= deltaFrom && t.date <= SPEND_NEW_THROUGH);
  const full = summarizeSpendDailyServer(v2, { fromDate: SPEND_START, toDate: SPEND_NEW_THROUGH });
  const slice = summarizeSpendDailyServer(deltaTxns, { fromDate: deltaFrom, toDate: SPEND_NEW_THROUGH });
  const days = slice.days.map((d: any) => ({ ...d, partial: full.fullCoverageStart !== null && d.date < full.fullCoverageStart }));
  return {
    arch: "F-ARCH-001" as const, version: 1 as const, mode: "incremental" as const,
    pulledAt: SPEND_INCR_PULLED,
    coverageStart: SPEND_START, throughDate: SPEND_NEW_THROUGH,
    fullCoverageStart: full.fullCoverageStart,
    baseThroughDate: SPEND_BASE_THROUGH,
    transactions: deltaTxns,
    days,
    expectedTotals: {
      posted: full.totals.posted,
      pending: full.totals.pending,
      transactions: v2.length,
      conflicts: full.conflicts.length,
      unappliedRefunds: full.unappliedRefunds.length,
      unclassified: full.unclassified.length,
      excludedTransfer: full.excludedCounts.transfer,
      excludedLoanPrincipal: full.excludedCounts.loanPrincipal,
    },
    ...overrides,
  };
}

function spendRowCount(sqlite: Database): number {
  return (sqlite.query("SELECT COUNT(*) AS n FROM arch_daily_spend").get() as any).n;
}
function spendStored(sqlite: Database): any {
  const row = sqlite.query("SELECT payload FROM arch_daily_spend ORDER BY pulled_at DESC, id DESC LIMIT 1").get() as any;
  return row ? JSON.parse(row.payload) : null;
}

async function seedSpendBase(db: any) {
  const res = await Actions.ingestArchDailySpend.handler(ownerCtx(db), spendFullRequest(spendFixtureV1(), SPEND_BASE_THROUGH, SPEND_BASE_PULLED));
  check("spend seed: base full ingest ok", res.ok === true && res.readBackVerified === true);
}

// Happy path + flip + advance + rollback paths.
{
  const { sqlite, db } = freshDb();
  await seedSpendBase(db);
  check("spend seed: 1 row, throughDate at base", spendRowCount(sqlite) === 1 && spendStored(sqlite).throughDate === SPEND_BASE_THROUGH);
  const basePayloadJson = JSON.stringify(spendStored(sqlite));

  const res = await Actions.ingestArchDailySpend.handler(ownerCtx(db), spendIncrementalRequest());
  check("spend incr: ok + readBackVerified", res.ok === true && res.readBackVerified === true && res.issue === null && res.totalMatches === true);
  check("spend incr: newThroughDate advanced, daysMerged = 4 segment days", res.newThroughDate === SPEND_NEW_THROUGH && res.daysMerged === 4);
  check("spend incr: response days = full merged window (7)", res.days === 7 && res.throughDate === SPEND_NEW_THROUGH);
  check("spend incr: exactly one new row appended", spendRowCount(sqlite) === 2);
  const stored = spendStored(sqlite);
  const full = summarizeSpendDailyServer(spendFixtureV2(), { fromDate: SPEND_START, toDate: SPEND_NEW_THROUGH });
  check("spend incr: stored throughDate advanced", stored.throughDate === SPEND_NEW_THROUGH);
  check("spend incr: stored totals equal the worker full-window recompute", approx(stored.totals.posted, full.totals.posted) && approx(stored.totals.pending, full.totals.pending));
  check("spend incr: stored counts carried from expectedTotals", stored.counts.transactions === spendFixtureV2().length && stored.counts.excludedTransfer === 2 && stored.counts.unclassified === 1);
  const d24 = stored.days.find((d: any) => d.date === "2026-10-24");
  check("spend incr: pending→posted flip landed (10-24 posted 40, pending 0)", approx(d24.posted, 40) && approx(d24.pending, 0) && d24.spendCount === 2 && d24.pendingCount === 0);
  const d20 = stored.days.find((d: any) => d.date === "2026-10-20");
  check("spend incr: untouched old day preserved verbatim (10-20 posted 60)", approx(d20.posted, 60));

  // stale_base: replaying the same base after the advance.
  const stale = await Actions.ingestArchDailySpend.handler(ownerCtx(db), spendIncrementalRequest({ pulledAt: "2026-10-26T16:00:00.000Z" }));
  check("spend stale_base: rejected", stale.ok === false && stale.issue === "stale_base" && stale.readBackVerified === false && stale.newThroughDate === null);
  check("spend stale_base: no new row, production still at new throughDate", spendRowCount(sqlite) === 2 && spendStored(sqlite).throughDate === SPEND_NEW_THROUGH);
  void basePayloadJson;

  // Coexistence: a later full ingest over the extended window
  // still publishes through the legacy leg.
  const v2 = spendFixtureV2();
  const fullRes = await Actions.ingestArchDailySpend.handler(ownerCtx(db), spendFullRequest(v2, SPEND_NEW_THROUGH, "2026-10-26T17:00:00.000Z"));
  check("spend coexist: full leg after incremental ok", fullRes.ok === true && spendRowCount(sqlite) === 3);
}

// daily_mismatch rollback: tampered segment day, nothing moves.
{
  const { sqlite, db } = freshDb();
  await seedSpendBase(db);
  const before = JSON.stringify(spendStored(sqlite));
  const req = spendIncrementalRequest();
  req.days = req.days.map((d: any, i: number) => i === 1 ? { ...d, posted: d.posted + 999 } : d);
  const res = await Actions.ingestArchDailySpend.handler(ownerCtx(db), req);
  check("spend daily_mismatch: rejected", res.ok === false && res.issue === "daily_mismatch");
  check("spend daily_mismatch: rollback — row count and production payload unchanged", spendRowCount(sqlite) === 1 && JSON.stringify(spendStored(sqlite)) === before);
}

// incremental_mismatch rollback: segment days honest, but the
// declared full-window totals drift from the merged recompute.
{
  const { sqlite, db } = freshDb();
  await seedSpendBase(db);
  const before = JSON.stringify(spendStored(sqlite));
  const req = spendIncrementalRequest();
  req.expectedTotals = { ...req.expectedTotals, posted: req.expectedTotals.posted + 999 };
  const res = await Actions.ingestArchDailySpend.handler(ownerCtx(db), req);
  check("spend incremental_mismatch: rejected", res.ok === false && res.issue === "incremental_mismatch");
  check("spend incremental_mismatch: rollback — nothing published", spendRowCount(sqlite) === 1 && JSON.stringify(spendStored(sqlite)) === before);
}

// no_base + guest.
{
  const { sqlite, db } = freshDb();
  const res = await Actions.ingestArchDailySpend.handler(ownerCtx(db), spendIncrementalRequest());
  check("spend no_base: incremental with no production version rejected", res.ok === false && res.issue === "no_base" && spendRowCount(sqlite) === 0);
  await seedSpendBase(db);
  const denied = await Actions.ingestArchDailySpend.handler(guestCtx(db), spendIncrementalRequest());
  check("spend guest: forbidden, nothing written", denied.ok === false && denied.issue === "forbidden" && spendRowCount(sqlite) === 1);
}

// ---------------- daily income ----------------
const INC_START = "2026-10-20";
const INC_BASE_THROUGH = "2026-10-24";
const INC_NEW_THROUGH = "2026-10-25";
const INC_BASE_PULLED = "2026-10-24T15:00:00.000Z";
const INC_INCR_PULLED = "2026-10-25T15:00:00.000Z";

function incomeFixtureV1(): any[] {
  return [
    { id: "i1", date: "2026-10-20", amount: 3000, status: "posted", kind: "income", category: "INCOME_WAGES", account: "acct_a" },
    { id: "i1", date: "2026-10-20", amount: 3000, status: "posted", kind: "income", category: "INCOME_WAGES", account: "acct_a" },
    { id: "i2", date: "2026-10-22", amount: 500, status: "posted", kind: "income", category: "INCOME_DIVIDENDS", account: "acct_b" },
    { id: "rf1", date: "2026-10-23", amount: 25, status: "posted", kind: "refund", account: "acct_a" },
    { id: "tr1", date: "2026-10-21", amount: 900, status: "posted", kind: "transfer", account: "acct_a" },
    { id: "lp1", date: "2026-10-21", amount: -400, status: "posted", kind: "loan_principal", account: "acct_a" },
    { id: "lm1", date: "2026-10-23", amount: -200, status: "posted", kind: "loan_mixed", account: "acct_a" },
    { id: "ut1", date: "2026-10-24", amount: 700, status: "posted", kind: "unmatched_transfer", account: "acct_a" },
    { id: "p1", date: "2026-10-24", amount: 120, status: "pending", kind: "income", category: "INCOME_WAGES", account: "acct_a" },
  ];
}
function incomeFixtureV2(): any[] {
  return [
    ...incomeFixtureV1().map((t) => t.id === "p1" ? { ...t, status: "posted" } : t),
    { id: "i3", date: "2026-10-25", amount: 800, status: "posted", kind: "income", category: "INCOME_WAGES", account: "acct_a" },
  ];
}
function incomeFullRequest(txns: any[], through: string, pulledAt: string) {
  const recomputed = summarizeIncomeDailyServer(txns, { fromDate: INC_START, toDate: through });
  return {
    arch: "F-ARCH-001" as const, version: 1 as const,
    pulledAt, coverageStart: INC_START, throughDate: through,
    fullCoverageStart: recomputed.fullCoverageStart,
    transactions: txns, days: recomputed.days,
  };
}
function incomeIncrementalRequest(overrides: any = {}) {
  const v2 = incomeFixtureV2();
  const deltaFrom = "2026-10-23";
  const deltaTxns = v2.filter((t) => t.date >= deltaFrom && t.date <= INC_NEW_THROUGH);
  const full = summarizeIncomeDailyServer(v2, { fromDate: INC_START, toDate: INC_NEW_THROUGH });
  const slice = summarizeIncomeDailyServer(deltaTxns, { fromDate: deltaFrom, toDate: INC_NEW_THROUGH });
  const days = slice.days.map((d: any) => ({ ...d, partial: full.fullCoverageStart !== null && d.date < full.fullCoverageStart }));
  return {
    arch: "F-ARCH-001" as const, version: 1 as const, mode: "incremental" as const,
    pulledAt: INC_INCR_PULLED,
    coverageStart: INC_START, throughDate: INC_NEW_THROUGH,
    fullCoverageStart: full.fullCoverageStart,
    baseThroughDate: INC_BASE_THROUGH,
    transactions: deltaTxns,
    days,
    expectedTotals: {
      total: full.totals.total,
      pending: full.totals.pending,
      transactions: v2.length,
      conflicts: full.conflicts.length,
      unclassified: full.unclassified.length,
      excludedTransfer: full.excludedCounts.transfer,
      excludedLoanPrincipal: full.excludedCounts.loanPrincipal,
    },
    ...overrides,
  };
}
function incomeRowCount(sqlite: Database): number {
  return (sqlite.query("SELECT COUNT(*) AS n FROM arch_daily_income").get() as any).n;
}
function incomeStored(sqlite: Database): any {
  const row = sqlite.query("SELECT payload FROM arch_daily_income ORDER BY pulled_at DESC, id DESC LIMIT 1").get() as any;
  return row ? JSON.parse(row.payload) : null;
}
async function seedIncomeBase(db: any) {
  const res = await Actions.ingestArchDailyIncome.handler(ownerCtx(db), incomeFullRequest(incomeFixtureV1(), INC_BASE_THROUGH, INC_BASE_PULLED));
  check("income seed: base full ingest ok", res.ok === true && res.readBackVerified === true);
}

{
  const { sqlite, db } = freshDb();
  await seedIncomeBase(db);
  const res = await Actions.ingestArchDailyIncome.handler(ownerCtx(db), incomeIncrementalRequest());
  check("income incr: ok + readBackVerified", res.ok === true && res.readBackVerified === true && res.issue === null);
  check("income incr: newThroughDate advanced, daysMerged = 3", res.newThroughDate === INC_NEW_THROUGH && res.daysMerged === 3 && res.days === 6);
  check("income incr: exactly one new row", incomeRowCount(sqlite) === 2);
  const stored = incomeStored(sqlite);
  check("income incr: stored totals 4445 total / 0 pending (flip + new day)", approx(stored.totals.total, 4445) && approx(stored.totals.pending, 0));
  check("income incr: stored counts from expectedTotals", stored.counts.transactions === incomeFixtureV2().length && stored.counts.unclassified === 2 && stored.counts.excludedTransfer === 1);
  const d24 = stored.days.find((d: any) => d.date === "2026-10-24");
  check("income incr: pending→posted flip landed (10-24 total 120, pending 0)", approx(d24.total, 120) && approx(d24.pending, 0));

  const stale = await Actions.ingestArchDailyIncome.handler(ownerCtx(db), incomeIncrementalRequest({ pulledAt: "2026-10-25T16:00:00.000Z" }));
  check("income stale_base: rejected, production kept", stale.ok === false && stale.issue === "stale_base" && incomeRowCount(sqlite) === 2 && incomeStored(sqlite).throughDate === INC_NEW_THROUGH);
}
{
  const { sqlite, db } = freshDb();
  await seedIncomeBase(db);
  const before = JSON.stringify(incomeStored(sqlite));
  const req = incomeIncrementalRequest();
  req.days = req.days.map((d: any, i: number) => i === 0 ? { ...d, total: d.total + 999 } : d);
  const res = await Actions.ingestArchDailyIncome.handler(ownerCtx(db), req);
  check("income daily_mismatch: rejected + rollback", res.ok === false && res.issue === "daily_mismatch" && incomeRowCount(sqlite) === 1 && JSON.stringify(incomeStored(sqlite)) === before);
  const req2 = incomeIncrementalRequest();
  req2.expectedTotals = { ...req2.expectedTotals, total: req2.expectedTotals.total + 999 };
  const res2 = await Actions.ingestArchDailyIncome.handler(ownerCtx(db), req2);
  check("income incremental_mismatch: rejected + rollback", res2.ok === false && res2.issue === "incremental_mismatch" && incomeRowCount(sqlite) === 1 && JSON.stringify(incomeStored(sqlite)) === before);
}
{
  const { sqlite, db } = freshDb();
  const res = await Actions.ingestArchDailyIncome.handler(ownerCtx(db), incomeIncrementalRequest());
  check("income no_base: rejected on empty store", res.ok === false && res.issue === "no_base" && incomeRowCount(sqlite) === 0);
  await seedIncomeBase(db);
  const denied = await Actions.ingestArchDailyIncome.handler(guestCtx(db), incomeIncrementalRequest());
  check("income guest: forbidden", denied.ok === false && denied.issue === "forbidden" && incomeRowCount(sqlite) === 1);
}

console.log(`validate-arch-incremental: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
