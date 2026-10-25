// CAL-METRICS-001 chunked daily-INCOME validation: drives the
// REAL ingestArchDailyIncome handler (full + chunk + finalize
// legs) and the real summarizeIncomeDailyServer against an
// in-memory DB, same harness style as
// validate-arch-daily-spend-chunks.ts. The income caliber:
// income rows + refund rows are inflows; own-account transfers
// and loan flows (transfer / loan_principal / loan_mixed /
// unmatched_transfer) NEVER count — loan_mixed and
// unmatched_transfer are unclassified, named and dropped.
// Run: bun validate-arch-daily-income.ts
import { Database } from "bun:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

const APP_DIR = new URL(".", import.meta.url).pathname;
const appRequire = createRequire(join(APP_DIR, "package.json"));
const { drizzle } = appRequire("drizzle-orm/bun-sqlite");
const schema = await import(join(APP_DIR, "server/src/schema.ts"));
const { Actions, summarizeIncomeDailyServer, incomePayloadsEquivalent, pickCurrentDailyIncomeVersion } = await import(join(APP_DIR, "server/src/actions.ts"));

let passed = 0, failed = 0;
function check(name: string, cond: boolean) {
  if (cond) { passed++; } else { failed++; console.log("FAIL:", name); }
}

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
function incomeRowCount(sqlite: Database): number {
  return (sqlite.query("SELECT COUNT(*) AS n FROM arch_daily_income").get() as any).n;
}
function stagedRowCount(sqlite: Database, batchId: string): number {
  return (sqlite.query("SELECT COUNT(*) AS n FROM arch_daily_income_chunks WHERE batch_id = ?").get(batchId) as any).n;
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

const PULLED_AT = "2026-10-24T15:00:00.000Z";
const COVERAGE_START = "2026-10-20";
const THROUGH_DATE = "2026-10-24";
const BATCH = "income-batch-2026-10-24-a";

// Synthetic window: salary (duplicated), dividends from a
// late-starting account (drives fullCoverageStart 2026-10-22),
// a refund counted on its own date, an own-account transfer, a
// loan-principal flow, two unclassifiable loan/transfer rows,
// a pending income, and one conflicting duplicate pair.
function fixtureTxns(): any[] {
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
    { id: "cf1", date: "2026-10-22", amount: 100, status: "posted", kind: "income", category: "INCOME_WAGES", account: "acct_a" },
    { id: "cf1", date: "2026-10-22", amount: 150, status: "posted", kind: "income", category: "INCOME_WAGES", account: "acct_a" },
  ];
}

function fullRecompute(txns: any[]) {
  return summarizeIncomeDailyServer(txns, { fromDate: COVERAGE_START, toDate: THROUGH_DATE });
}

// --- summarizer behaviour (pure) ---
{
  const rec = fullRecompute(fixtureTxns());
  check("summarizer: only income + refunds count (3000 + 500 + 25)", rec.totals.total === 3525);
  check("summarizer: pending income kept separate", rec.totals.pending === 120);
  check("summarizer: transfer + loan principal excluded and counted",
    rec.excludedCounts.transfer === 1 && rec.excludedCounts.loanPrincipal === 1);
  check("summarizer: loan_mixed + unmatched_transfer are unclassified, never counted",
    rec.unclassified.length === 2 && rec.unclassified.every((u: any) => u.kind === "loan_mixed" || u.kind === "unmatched_transfer"));
  check("summarizer: conflicting duplicate pair named and dropped (its 100/150 never counted)",
    rec.conflicts.length === 1 && rec.conflicts[0]?.id === "cf1" && rec.totals.total === 3525);
  check("summarizer: identical duplicate deduped (salary counted once)", rec.days.find((d: any) => d.date === "2026-10-20")?.total === 3000);
  check("summarizer: refund lands on the refund's own date under the REFUND source",
    rec.days.find((d: any) => d.date === "2026-10-23")?.total === 25
    && rec.days.find((d: any) => d.date === "2026-10-23")?.sources[0]?.key === "REFUND");
  check("summarizer: source breakdown carries the income categories",
    rec.days.find((d: any) => d.date === "2026-10-20")?.sources[0]?.key === "INCOME_WAGES"
    && rec.days.find((d: any) => d.date === "2026-10-22")?.sources[0]?.key === "INCOME_DIVIDENDS");
  check("summarizer: fullCoverageStart derives from the counted rows' accounts (late acct_b)",
    rec.fullCoverageStart === "2026-10-22");
  check("summarizer: days before full coverage are partial, later days are not",
    rec.days.find((d: any) => d.date === "2026-10-20")?.partial === true
    && rec.days.find((d: any) => d.date === "2026-10-22")?.partial === false);
  check("summarizer: every window day is emitted (5 days, zero days kept)",
    rec.days.length === 5 && rec.days.find((d: any) => d.date === "2026-10-21")?.total === 0);
  const naiveAllIn = fixtureTxns().filter((t) => t.status === "posted" && t.amount > 0).reduce((s, t) => s + t.amount, 0);
  check("mutation: counting every positive row (incl. transfer 900 + unmatched 700 + duplicates) would overstate to 8375 — the real total excludes them",
    naiveAllIn === 8375 && naiveAllIn !== rec.totals.total);
}

// --- full leg ---
function fullRequest(txns: any[], overrides: any = {}) {
  const recomputed = fullRecompute(txns);
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
{
  const { sqlite, db } = freshDb();
  const denied = await Actions.ingestArchDailyIncome.handler(guestCtx(db), fullRequest(fixtureTxns()));
  check("full: guest is forbidden and writes nothing", denied.ok === false && denied.issue === "forbidden" && incomeRowCount(sqlite) === 0);
  const res = await Actions.ingestArchDailyIncome.handler(ownerCtx(db), fullRequest(fixtureTxns()));
  check("full: owner ingest ok + read-back verified", res.ok === true && res.readBackVerified === true && res.days === 5);
  check("full: exactly one stored row", incomeRowCount(sqlite) === 1);
  const rows = (sqlite.query("SELECT id, payload, pulled_at FROM arch_daily_income").all() as any[])
    .map((r) => ({ id: r.id, payload: r.payload, pulledAt: new Date(r.pulled_at) }));
  const current = pickCurrentDailyIncomeVersion(rows);
  const expected = fullRecompute(fixtureTxns());
  check("full: stored payload equals the server recompute (published values are never the client's)",
    current !== null && incomePayloadsEquivalent(current.parsed, {
      arch: "F-ARCH-001", version: 1, kind: "daily-income",
      pulledAt: PULLED_AT, storedAt: current.parsed.storedAt,
      coverageStart: COVERAGE_START, throughDate: THROUGH_DATE,
      fullCoverageStart: expected.fullCoverageStart,
      days: expected.days, totals: expected.totals,
      counts: {
        transactions: fixtureTxns().length, conflicts: 1, unclassified: 2, excludedTransfer: 1, excludedLoanPrincipal: 1,
      },
    }));
  const again = await Actions.ingestArchDailyIncome.handler(ownerCtx(db), fullRequest(fixtureTxns()));
  check("full: same-version identical resend is idempotent (still 1 row)", again.ok === true && incomeRowCount(sqlite) === 1);
  const tamperedDays = fullRecompute(fixtureTxns()).days.map((d: any, i: number) => i === 0 ? { ...d, total: d.total + 1 } : d);
  const tampered = await Actions.ingestArchDailyIncome.handler(ownerCtx(db), fullRequest(fixtureTxns(), { days: tamperedDays }));
  check("full: same version, tampered days -> daily_mismatch at the recompute gate (never a silent overwrite)",
    tampered.ok === false && tampered.issue === "daily_mismatch" && incomeRowCount(sqlite) === 1);
  const altTxns = [...fixtureTxns(), { id: "x1", date: "2026-10-21", amount: 50, status: "posted", kind: "income", category: "INCOME_WAGES", account: "acct_a" }];
  const conflict = await Actions.ingestArchDailyIncome.handler(ownerCtx(db), fullRequest(altTxns));
  check("full: same version, self-consistent but different payload -> version_conflict",
    conflict.ok === false && conflict.issue === "version_conflict" && incomeRowCount(sqlite) === 1);
}
{
  const { sqlite, db } = freshDb();
  const bad = fullRequest(fixtureTxns());
  bad.days = bad.days.map((d: any, i: number) => i === 2 ? { ...d, total: 9999 } : d);
  const res = await Actions.ingestArchDailyIncome.handler(ownerCtx(db), bad);
  check("full: submitted days that disagree with the recompute -> daily_mismatch, zero rows",
    res.ok === false && res.issue === "daily_mismatch" && incomeRowCount(sqlite) === 0);
}

// --- chunk + finalize legs ---
const RANGES: Array<[string, string]> = [
  ["2026-10-20", "2026-10-21"],
  ["2026-10-22", "2026-10-23"],
  ["2026-10-24", "2026-10-24"],
];
function chunkRequest(txns: any[], index: number, overrides: any = {}) {
  const [fromDate, toDate] = RANGES[index]!;
  const slice = txns.filter((t) => t.date >= fromDate && t.date <= toDate);
  const sliceRecompute = summarizeIncomeDailyServer(slice, { fromDate, toDate });
  return {
    arch: "F-ARCH-001" as const,
    version: 1 as const,
    mode: "chunk" as const,
    batchId: BATCH,
    chunkIndex: index,
    chunkCount: RANGES.length,
    pulledAt: PULLED_AT,
    coverageStart: COVERAGE_START,
    throughDate: THROUGH_DATE,
    fullCoverageStart: fullRecompute(txns).fullCoverageStart,
    fromDate,
    toDate,
    transactions: slice,
    days: sliceRecompute.days,
    ...overrides,
  };
}
function finalizeRequest(txns: any[], overrides: any = {}) {
  const recomputed = fullRecompute(txns);
  return {
    arch: "F-ARCH-001" as const,
    version: 1 as const,
    mode: "finalize" as const,
    batchId: BATCH,
    chunkCount: RANGES.length,
    pulledAt: PULLED_AT,
    coverageStart: COVERAGE_START,
    throughDate: THROUGH_DATE,
    fullCoverageStart: recomputed.fullCoverageStart,
    counts: {
      transactions: txns.length,
      conflicts: recomputed.conflicts.length,
      unclassified: recomputed.unclassified.length,
      excludedTransfer: recomputed.excludedCounts.transfer,
      excludedLoanPrincipal: recomputed.excludedCounts.loanPrincipal,
    },
    totals: recomputed.totals,
    ...overrides,
  };
}
{
  const { sqlite, db } = freshDb();
  const txns = fixtureTxns();
  const good = await Actions.ingestArchDailyIncome.handler(ownerCtx(db), chunkRequest(txns, 1));
  check("chunk setup: chunk 1 staged", good.ok === true && stagedRowCount(sqlite, BATCH) === 1);
  const badReq = chunkRequest(txns, 0);
  badReq.days = badReq.days.map((d: any, i: number) => i === 0 ? { ...d, total: d.total + 999 } : d);
  const res = await Actions.ingestArchDailyIncome.handler(ownerCtx(db), badReq);
  check("chunk: tampered slice -> daily_mismatch", res.ok === false && res.issue === "daily_mismatch");
  check("chunk: poisoned batch voided whole, official table untouched", stagedRowCount(sqlite, BATCH) === 0 && incomeRowCount(sqlite) === 0);
}
{
  const { sqlite, db } = freshDb();
  const txns = fixtureTxns();
  await Actions.ingestArchDailyIncome.handler(ownerCtx(db), chunkRequest(txns, 0));
  await Actions.ingestArchDailyIncome.handler(ownerCtx(db), chunkRequest(txns, 2));
  const early = await Actions.ingestArchDailyIncome.handler(ownerCtx(db), finalizeRequest(txns));
  check("finalize: missing chunk -> batch_incomplete, staging kept",
    early.ok === false && early.issue === "batch_incomplete" && stagedRowCount(sqlite, BATCH) === 2 && incomeRowCount(sqlite) === 0);
  const r1 = await Actions.ingestArchDailyIncome.handler(ownerCtx(db), chunkRequest(txns, 1));
  check("finalize setup: supplied chunk completes the batch (3/3)", r1.ok === true && r1.chunksReceived === 3);
  const fin = await Actions.ingestArchDailyIncome.handler(ownerCtx(db), finalizeRequest(txns));
  check("finalize: publishes after completion, read-back verified", fin.ok === true && fin.readBackVerified === true && fin.days === 5);
  check("finalize: exactly 1 official row, staging drained", incomeRowCount(sqlite) === 1 && stagedRowCount(sqlite, BATCH) === 0);
  const rows = (sqlite.query("SELECT id, payload, pulled_at FROM arch_daily_income").all() as any[])
    .map((r) => ({ id: r.id, payload: r.payload, pulledAt: new Date(r.pulled_at) }));
  const current = pickCurrentDailyIncomeVersion(rows);
  check("finalize: published payload's totals match the independent recompute",
    current !== null && current.parsed.totals.total === 3525 && current.parsed.totals.pending === 120);
}
{
  const { sqlite, db } = freshDb();
  const txns = fixtureTxns();
  for (let i = 0; i < RANGES.length; i++) await Actions.ingestArchDailyIncome.handler(ownerCtx(db), chunkRequest(txns, i));
  const wrongTotals = await Actions.ingestArchDailyIncome.handler(ownerCtx(db), finalizeRequest(txns, { totals: { total: 1, pending: 0 } }));
  check("finalize: declared totals that drift from the recompute -> finalize_mismatch, batch voided, nothing published",
    wrongTotals.ok === false && wrongTotals.issue === "finalize_mismatch" && stagedRowCount(sqlite, BATCH) === 0 && incomeRowCount(sqlite) === 0);
}

console.log(`validate-arch-daily-income: ${passed}/${passed + failed} passed`);
process.exit(failed ? 1 : 0);
