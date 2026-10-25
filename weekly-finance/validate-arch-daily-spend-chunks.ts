// F-ARCH-001 chunked daily-spend validation: drives the REAL
// ingestArchDailySpend handler (chunk + finalize legs) against an
// in-memory DB, same harness style as validate-arch-daily-spend.ts.
// Run: bun validate-arch-daily-spend-chunks.ts
import { Database } from "bun:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

const APP_DIR = new URL(".", import.meta.url).pathname;
const appRequire = createRequire(join(APP_DIR, "package.json"));
const { drizzle } = appRequire("drizzle-orm/bun-sqlite");
const schema = await import(join(APP_DIR, "server/src/schema.ts"));
const { Actions, summarizeSpendDailyServer, spendPayloadsEquivalent, pickCurrentDailySpendVersion } = await import(join(APP_DIR, "server/src/actions.ts"));

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
function dailyRowCount(sqlite: Database): number {
  return (sqlite.query("SELECT COUNT(*) AS n FROM arch_daily_spend").get() as any).n;
}
function stagedRowCount(sqlite: Database, batchId: string): number {
  return (sqlite.query("SELECT COUNT(*) AS n FROM arch_daily_spend_chunks WHERE batch_id = ?").get(batchId) as any).n;
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

const PULLED_AT = "2026-10-24T15:00:00.000Z";
const COVERAGE_START = "2026-10-20";
const THROUGH_DATE = "2026-10-24";
const BATCH = "batch-2026-10-24-a";

// Same synthetic fixture as validate-arch-daily-spend.ts: 5-day
// window with a duplicate, a transfer, a loan_mixed row, a refund
// offsetting an earlier day and a late-starting gating account.
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

// Calendar-month-style slices of the window: contiguous, disjoint.
const RANGES: Array<[string, string]> = [
  ["2026-10-20", "2026-10-21"],
  ["2026-10-22", "2026-10-23"],
  ["2026-10-24", "2026-10-24"],
];

function fullRecompute(txns: any[]) {
  return summarizeSpendDailyServer(txns, { fromDate: COVERAGE_START, toDate: THROUGH_DATE });
}

function chunkRequest(txns: any[], index: number, overrides: any = {}) {
  const [fromDate, toDate] = RANGES[index]!;
  const slice = txns.filter((t) => t.date >= fromDate && t.date <= toDate);
  const sliceRecompute = summarizeSpendDailyServer(slice, { fromDate, toDate });
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
      unappliedRefunds: recomputed.unappliedRefunds.length,
      unclassified: recomputed.unclassified.length,
      excludedTransfer: recomputed.excludedCounts.transfer,
      excludedLoanPrincipal: recomputed.excludedCounts.loanPrincipal,
    },
    totals: recomputed.totals,
    ...overrides,
  };
}

function fullRequest(txns: any[]) {
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
  };
}

async function sendAllChunks(db: any, txns: any[]) {
  const results: any[] = [];
  for (let i = 0; i < RANGES.length; i++) {
    results.push(await Actions.ingestArchDailySpend.handler(ownerCtx(db), chunkRequest(txns, i)));
  }
  return results;
}

// ① Bad chunk (tampered posted for one day) -> rejected, the whole
// batch's staged rows are voided, official table untouched.
{
  const { sqlite, db } = freshDb();
  const txns = fixtureTxns();
  const good = await Actions.ingestArchDailySpend.handler(ownerCtx(db), chunkRequest(txns, 1));
  check("bad-chunk setup: chunk 1 staged", good.ok === true && stagedRowCount(sqlite, BATCH) === 1);
  const badReq = chunkRequest(txns, 0);
  badReq.days = badReq.days.map((d: any, i: number) => i === 0 ? { ...d, posted: d.posted + 999 } : d);
  const res = await Actions.ingestArchDailySpend.handler(ownerCtx(db), badReq);
  check("bad-chunk: daily_mismatch rejection", res.ok === false && res.issue === "daily_mismatch" && res.totalMatches === false);
  check("bad-chunk: whole batch voided (staging empty)", stagedRowCount(sqlite, BATCH) === 0);
  check("bad-chunk: official table still zero rows", dailyRowCount(sqlite) === 0);
}

// ② Finalize with a missing chunk -> batch_incomplete, staging
// kept; after supplying the missing chunk, finalize succeeds.
{
  const { sqlite, db } = freshDb();
  const txns = fixtureTxns();
  const r0 = await Actions.ingestArchDailySpend.handler(ownerCtx(db), chunkRequest(txns, 0));
  const r2 = await Actions.ingestArchDailySpend.handler(ownerCtx(db), chunkRequest(txns, 2));
  check("missing-chunk setup: chunks 0 and 2 staged", r0.ok === true && r2.ok === true && stagedRowCount(sqlite, BATCH) === 2);
  check("missing-chunk: staged batch invisible to getDashboard reads", dailyRowCount(sqlite) === 0);
  const early = await Actions.ingestArchDailySpend.handler(ownerCtx(db), finalizeRequest(txns));
  check("missing-chunk: finalize rejected batch_incomplete", early.ok === false && early.issue === "batch_incomplete");
  check("missing-chunk: progress reported 2/3", early.chunksReceived === 2 && early.chunksExpected === 3);
  check("missing-chunk: official zero rows, staging kept", dailyRowCount(sqlite) === 0 && stagedRowCount(sqlite, BATCH) === 2);
  const r1 = await Actions.ingestArchDailySpend.handler(ownerCtx(db), chunkRequest(txns, 1));
  check("missing-chunk: supplied chunk accepted", r1.ok === true && r1.chunksReceived === 3 && r1.chunksExpected === 3);
  const fin = await Actions.ingestArchDailySpend.handler(ownerCtx(db), finalizeRequest(txns));
  check("missing-chunk: finalize after completion ok", fin.ok === true && fin.readBackVerified === true && fin.totalMatches === true && fin.days === 5);
  check("missing-chunk: exactly 1 official row, staging drained", dailyRowCount(sqlite) === 1 && stagedRowCount(sqlite, BATCH) === 0);
  // ⑦ pickCurrentDailySpendVersion selects the chunked-published version
  const rows = (sqlite.query("SELECT id, payload, pulled_at FROM arch_daily_spend").all() as any[])
    .map((r) => ({ id: r.id, payload: r.payload, pulledAt: new Date(r.pulled_at) }));
  const current = pickCurrentDailySpendVersion(rows);
  check("pickCurrent: chunked version selected", current !== null && current.parsed.coverageStart === COVERAGE_START && current.parsed.throughDate === THROUGH_DATE && current.parsed.days.length === 5);
}

// ③ Same chunk resent verbatim -> idempotent success, no new
// staged row; same index with different content -> chunk_conflict
// and the whole batch is voided.
{
  const { sqlite, db } = freshDb();
  const txns = fixtureTxns();
  const first = await Actions.ingestArchDailySpend.handler(ownerCtx(db), chunkRequest(txns, 0));
  check("resend setup: chunk 0 staged", first.ok === true && stagedRowCount(sqlite, BATCH) === 1);
  const again = await Actions.ingestArchDailySpend.handler(ownerCtx(db), chunkRequest(txns, 0));
  check("resend identical: idempotent ok", again.ok === true && again.chunksReceived === 1 && again.chunksExpected === 3);
  check("resend identical: staged row count unchanged", stagedRowCount(sqlite, BATCH) === 1);
  // Different content at the same index: change s2's amount and
  // recompute the slice so the chunk is internally consistent.
  const txns2 = fixtureTxns().map((t: any) => t.id === "s2" ? { ...t, amount: -21 } : t);
  const conflict = await Actions.ingestArchDailySpend.handler(ownerCtx(db), chunkRequest(txns2, 0));
  check("resend different: chunk_conflict", conflict.ok === false && conflict.issue === "chunk_conflict");
  check("resend different: whole batch voided, official untouched", stagedRowCount(sqlite, BATCH) === 0 && dailyRowCount(sqlite) === 0);
}

// ④ Finalize whose declared totals disagree with the server
// recompute -> rejected, batch voided, official table zero rows.
{
  const { sqlite, db } = freshDb();
  const txns = fixtureTxns();
  const sent = await sendAllChunks(db, txns);
  check("finalize-mismatch setup: all chunks staged", sent.every((r) => r.ok === true) && stagedRowCount(sqlite, BATCH) === 3);
  const badFin = finalizeRequest(txns, { totals: { posted: 9999, pending: 15 } });
  const res = await Actions.ingestArchDailySpend.handler(ownerCtx(db), badFin);
  check("finalize-mismatch: rejected finalize_mismatch", res.ok === false && res.issue === "finalize_mismatch" && res.totalMatches === false);
  check("finalize-mismatch: official zero rows, batch voided", dailyRowCount(sqlite) === 0 && stagedRowCount(sqlite, BATCH) === 0);
  // Declared transaction count drift is caught the same way.
  const { sqlite: s2, db: db2 } = freshDb();
  await sendAllChunks(db2, txns);
  const badCount = finalizeRequest(txns, { counts: { transactions: txns.length + 1 } });
  const res2 = await Actions.ingestArchDailySpend.handler(ownerCtx(db2), badCount);
  check("finalize-mismatch: wrong declared count rejected", res2.ok === false && res2.issue === "finalize_mismatch" && dailyRowCount(s2) === 0 && stagedRowCount(s2, BATCH) === 0);
}

// ⑤ The payload published through the chunk path is deep-equal
// (spendPayloadsEquivalent) to the payload the same fixture
// publishes through the full path.
{
  const a = freshDb();
  const fullRes = await Actions.ingestArchDailySpend.handler(ownerCtx(a.db), fullRequest(fixtureTxns()));
  check("equivalence setup: full ingest ok", fullRes.ok === true);
  const b = freshDb();
  const txns = fixtureTxns();
  await sendAllChunks(b.db, txns);
  const finRes = await Actions.ingestArchDailySpend.handler(ownerCtx(b.db), finalizeRequest(txns));
  check("equivalence setup: chunked finalize ok", finRes.ok === true);
  const fullPayload = storedDailyPayload(a.sqlite);
  const chunkPayload = storedDailyPayload(b.sqlite);
  check("equivalence: chunked payload spendPayloadsEquivalent to full payload",
    fullPayload !== null && chunkPayload !== null && spendPayloadsEquivalent(chunkPayload, fullPayload));
}

// ⑥ Unauthenticated viewer (guest) is forbidden on both legs.
{
  const { sqlite, db } = freshDb();
  const txns = fixtureTxns();
  const chunkRes = await Actions.ingestArchDailySpend.handler(guestCtx(db), chunkRequest(txns, 0));
  check("forbidden: guest chunk rejected", chunkRes.ok === false && chunkRes.issue === "forbidden" && stagedRowCount(sqlite, BATCH) === 0);
  const finRes = await Actions.ingestArchDailySpend.handler(guestCtx(db), finalizeRequest(txns));
  check("forbidden: guest finalize rejected", finRes.ok === false && finRes.issue === "forbidden" && dailyRowCount(sqlite) === 0);
}

// Chunk for a version older than the published one -> stale_version.
{
  const { sqlite, db } = freshDb();
  const txns = fixtureTxns();
  const fullRes = await Actions.ingestArchDailySpend.handler(ownerCtx(db), { ...fullRequest(txns), pulledAt: "2026-10-24T16:00:00.000Z" });
  check("stale-chunk setup: newer full version published", fullRes.ok === true);
  const res = await Actions.ingestArchDailySpend.handler(ownerCtx(db), chunkRequest(txns, 0));
  check("stale-chunk: older batch chunk rejected stale_version", res.ok === false && res.issue === "stale_version" && stagedRowCount(sqlite, BATCH) === 0);
}

// Chunk whose slice does not tile the declared window at finalize
// (ranges leave a gap) -> batch_incomplete, staging kept.
{
  const { sqlite, db } = freshDb();
  const txns = fixtureTxns();
  // Stage chunks 0 and 1 only, but declare chunkCount 2 with a
  // window the two slices do not cover end-to-end (chunk 1 ends
  // 10-23 while throughDate is 10-24): tiling fails.
  for (let i = 0; i < 2; i++) {
    const req = chunkRequest(txns, i, { chunkCount: 2 });
    const r = await Actions.ingestArchDailySpend.handler(ownerCtx(db), req);
    check(`tiling setup: chunk ${i} staged`, r.ok === true);
  }
  const fin = finalizeRequest(txns, { chunkCount: 2 });
  const res = await Actions.ingestArchDailySpend.handler(ownerCtx(db), fin);
  check("tiling: gap before throughDate rejected batch_incomplete", res.ok === false && res.issue === "batch_incomplete");
  check("tiling: staging kept for repair", stagedRowCount(sqlite, BATCH) === 2 && dailyRowCount(sqlite) === 0);
}

console.log(`validate-arch-daily-spend-chunks: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
