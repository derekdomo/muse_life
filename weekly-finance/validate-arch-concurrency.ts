// F-ARCH-001·SAVE-1 concurrency matrix validation (PM 2026-10-24
// P0): the ingest write path must arbitrate at the DATABASE
// commit point, not by the handler's read-check. Two concurrent
// calls carrying the same source version (same pulledAt) must
// produce exactly ONE logical write — same content: both calls
// succeed idempotently over one stored row; different content:
// exactly one winner and one typed version_conflict, in either
// arrival order. Concurrent cross-version writes must never let
// the current figure regress, a lost-response retry stays safe,
// a per-write failure writes nothing, and pre-existing duplicate
// history (rows the pre-fix race already stored) stays readable
// and untouched — the fix adds no unique constraint that would
// force deleting it.
//
// Drives the REAL actions against isolated in-memory SQLite
// databases built from the app's own drizzle migrations, issuing
// the competing calls with Promise.all so their awaits interleave
// exactly as two in-flight requests would. All fixtures are
// synthetic; nothing touches the real app.db.
//
// Run with Bun from the artifact root: bun validate-arch-concurrency.ts
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

// ---------- db scaffolding (same shape as validate-arch-save) ----------
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
function archRowCount(sqlite: Database): number {
  return (sqlite.query("SELECT COUNT(*) AS n FROM arch_net_worth").get() as any).n;
}
function seedDashboardState(sqlite: Database) {
  const legacyDashboard = {
    asOf: "2026-10-01", sourceMonth: "2026-09", months: [],
    live: { netWorth: 0, investment: 0, saving: 0, weeklyDelta: null },
    holdings: [], concentrationTop3: 0, accounts: [],
    fire: { annualContribution: 0, annualSpend: 0, target: 0, progress: null, gap: 0 },
  };
  sqlite.query("INSERT INTO finance_state (id, payload, status, updated_at) VALUES (1, ?, 'idle', ?)")
    .run(JSON.stringify(legacyDashboard), Date.now());
}

// ---------- ctx fakes ----------
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

// ---------- synthetic fixtures ----------
const T_OLD = "2026-10-24T15:00:00.000Z";
const T_NEW = "2026-10-25T15:00:00.000Z";
const acct = (id: string, balance: number | null, kind: string, coverage: string, asOf: string | null) =>
  ({ id, balance, kind, coverage, asOf });
function reqV1() {
  return {
    arch: "F-ARCH-001" as const, version: 1 as const, pulledAt: T_OLD, total: 750,
    accounts: [
      acct("bank_a", 1000, "asset", "plaid", "2026-10-20"),
      acct("card_a", 250, "liability", "plaid", "2026-10-20"),
    ],
  };
}
function reqV1Changed() {
  return {
    arch: "F-ARCH-001" as const, version: 1 as const, pulledAt: T_OLD, total: 850,
    accounts: [
      acct("bank_a", 1100, "asset", "plaid", "2026-10-20"),
      acct("card_a", 250, "liability", "plaid", "2026-10-20"),
    ],
  };
}
function reqV2() {
  return {
    arch: "F-ARCH-001" as const, version: 1 as const, pulledAt: T_NEW, total: 950,
    accounts: [
      acct("bank_a", 1200, "asset", "plaid", "2026-10-22"),
      acct("card_a", 250, "liability", "plaid", "2026-10-22"),
    ],
  };
}
const ingest = (db: any, req: any, ctx?: any) =>
  Actions.ingestArchNetWorth.handler(ctx ?? ownerCtx(db), req);
async function getterArch(db: any) {
  const view = await Actions.getDashboard.handler(ownerCtx(db), {});
  return view.data?.archNetWorth ?? null;
}

// =====================================================================
// Group K1: concurrent same version + same content — exactly one
// logical write, both calls succeed (idempotent race)
// =====================================================================
{
  const { sqlite, db } = freshDb();
  seedDashboardState(sqlite);
  const [a, b] = await Promise.all([ingest(db, reqV1()), ingest(db, reqV1())]);
  check("K1: both concurrent identical writes succeed", a.ok === true && b.ok === true);
  check("K1: both report read-back verified", a.readBackVerified === true && b.readBackVerified === true);
  check("K1: exactly ONE row stored (one logical write)", archRowCount(sqlite) === 1);
  const arch = await getterArch(db);
  check("K1: getter shows the version once written", arch?.pulledAt === T_OLD && arch?.total === 750);
  const [c, d, e] = await Promise.all([ingest(db, reqV1()), ingest(db, reqV1()), ingest(db, reqV1())]);
  check("K1: three-way identical race still one row, all succeed",
    c.ok === true && d.ok === true && e.ok === true && archRowCount(sqlite) === 1);
}

// =====================================================================
// Group K2: concurrent same version + DIFFERENT content — exactly
// one winner, one typed version_conflict, one row; repeated in
// both arrival orders and across several fresh databases so the
// verdict does not depend on which call happens to land first
// =====================================================================
for (const order of ["v1-first", "changed-first"] as const) {
  for (let round = 0; round < 3; round++) {
    const { sqlite, db } = freshDb();
    seedDashboardState(sqlite);
    const pair = order === "v1-first"
      ? await Promise.all([ingest(db, reqV1()), ingest(db, reqV1Changed())])
      : await Promise.all([ingest(db, reqV1Changed()), ingest(db, reqV1())]);
    const winners = pair.filter((r) => r.ok === true);
    const losers = pair.filter((r) => r.ok === false);
    check(`K2 (${order} #${round}): exactly one winner`, winners.length === 1);
    check(`K2 (${order} #${round}): exactly one typed version_conflict`,
      losers.length === 1 && losers[0]?.issue === "version_conflict" && losers[0]?.readBackVerified === false);
    check(`K2 (${order} #${round}): exactly one row stored`, archRowCount(sqlite) === 1);
    const winnerTotal = order === "v1-first"
      ? (pair[0]?.ok ? 750 : 850)
      : (pair[0]?.ok ? 850 : 750);
    const arch = await getterArch(db);
    check(`K2 (${order} #${round}): getter shows the WINNER's content`, arch?.total === winnerTotal && arch?.pulledAt === T_OLD);
  }
}

// =====================================================================
// Group K3: concurrent cross-version — the newer version always
// ends current; the older write either lands first (then is
// superseded) or is refused stale_version; it never ends current
// =====================================================================
for (const order of ["old-first", "new-first"] as const) {
  const { sqlite, db } = freshDb();
  seedDashboardState(sqlite);
  const [first, second] = order === "old-first"
    ? await Promise.all([ingest(db, reqV1()), ingest(db, reqV2())])
    : await Promise.all([ingest(db, reqV2()), ingest(db, reqV1())]);
  const oldRes = order === "old-first" ? first : second;
  const newRes = order === "old-first" ? second : first;
  check(`K3 (${order}): newer version's write succeeds`, newRes?.ok === true);
  check(`K3 (${order}): older write landed-first or stale — never a silent second current`,
    oldRes?.ok === true || oldRes?.issue === "stale_version");
  const arch = await getterArch(db);
  check(`K3 (${order}): current figure is the newer version (no regression)`,
    arch?.pulledAt === T_NEW && arch?.total === 950);
}

// =====================================================================
// Group K4: lost-response retry after a concurrent write — the
// retry succeeds idempotently and appends nothing
// =====================================================================
{
  const { sqlite, db } = freshDb();
  seedDashboardState(sqlite);
  await Promise.all([ingest(db, reqV1()), ingest(db, reqV1())]);
  const retry = await ingest(db, reqV1());
  check("K4: lost-response retry succeeds without appending",
    retry.ok === true && retry.readBackVerified === true && archRowCount(sqlite) === 1);
  const conflictRetry = await ingest(db, reqV1Changed());
  check("K4: a changed retry after the race is a typed conflict, zero writes",
    conflictRetry.ok === false && conflictRetry.issue === "version_conflict" && archRowCount(sqlite) === 1);
}

// =====================================================================
// Group K5: per-write failure under concurrency — a malformed /
// mismatched call racing a valid one fails typed and writes
// nothing; the valid write is unaffected
// =====================================================================
{
  const { sqlite, db } = freshDb();
  seedDashboardState(sqlite);
  const bad = { ...reqV1(), total: 999 };
  const [good, badRes] = await Promise.all([ingest(db, reqV1()), ingest(db, bad)]);
  check("K5: valid concurrent write succeeds", good.ok === true);
  check("K5: mismatched concurrent write fails as total_mismatch",
    badRes.ok === false && badRes.issue === "total_mismatch");
  check("K5: only the valid row exists", archRowCount(sqlite) === 1);
}

// =====================================================================
// Group K6: permissions under concurrency — a guest racing the
// owner is forbidden and writes nothing; the owner write lands
// =====================================================================
{
  const { sqlite, db } = freshDb();
  seedDashboardState(sqlite);
  const [guest, owner] = await Promise.all([
    ingest(db, reqV1(), guestCtx(db)),
    ingest(db, reqV1(), ownerCtx(db)),
  ]);
  check("K6: guest forbidden under concurrency, zero guest writes",
    guest.ok === false && guest.issue === "forbidden");
  check("K6: owner write succeeds, exactly one row", owner.ok === true && archRowCount(sqlite) === 1);
}

// =====================================================================
// Group K7: upgrade / rollback compatibility — the fix is a
// statement-level arbitration, NOT a unique constraint: duplicate
// same-version history written by the pre-fix race can still
// exist, stays readable (greatest id wins the tie), is never
// deleted, and a same-version call against it reuses / conflicts
// sequentially without appending
// =====================================================================
{
  const { sqlite, db } = freshDb();
  seedDashboardState(sqlite);
  const indexRows = sqlite.query(
    "SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'arch_net_worth'",
  ).all() as any[];
  check("K7: no unique index on arch_net_worth (history-preserving design)",
    indexRows.every((row) => !/unique/i.test(row.sql ?? "")));
  const r1 = await ingest(db, reqV1());
  check("K7: setup write ok", r1.ok === true);
  // Simulate the pre-fix race's damage: a second row at the SAME
  // pulled_at, written directly (as the old handler allowed).
  const payloadRow = sqlite.query("SELECT payload FROM arch_net_worth ORDER BY id LIMIT 1").get() as any;
  sqlite.query("INSERT INTO arch_net_worth (payload, pulled_at, created_at) VALUES (?, ?, ?)")
    .run(payloadRow.payload, Date.parse(T_OLD), Date.now());
  check("K7: duplicate same-version history can exist (no constraint blocks it)", archRowCount(sqlite) === 2);
  const arch = await getterArch(db);
  check("K7: getter still resolves the duplicated version", arch?.pulledAt === T_OLD && arch?.total === 750);
  const retry = await ingest(db, reqV1());
  check("K7: same-version call against duplicate history reuses without appending or deleting",
    retry.ok === true && archRowCount(sqlite) === 2);
  const conflict = await ingest(db, reqV1Changed());
  check("K7: different content against duplicate history conflicts, history untouched",
    conflict.ok === false && conflict.issue === "version_conflict" && archRowCount(sqlite) === 2);
  const newer = await ingest(db, reqV2());
  check("K7: a newer version still lands over duplicate history",
    newer.ok === true && archRowCount(sqlite) === 3);
}

console.log(`validate-arch-concurrency: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
