// F-ARCH-001·SAVE-1 validation: version arbitration, logical
// idempotency / conflict, and exact (deep) read-back for the
// arch net-worth write path and the getDashboard overlay.
//
// Drives the REAL actions (ingestArchNetWorth / getDashboard)
// and the REAL exported pure helpers (pickCurrentArchVersion /
// archPayloadsEquivalent) against isolated in-memory SQLite
// databases built from the app's own drizzle migrations, with
// fake ctx objects for the owner, a guest and the approved
// anonymous sync channel. All fixtures are synthetic; nothing
// touches the real app.db and no real financial value is read
// or printed.
//
// Run with Bun from the artifact root: bun validate-arch-save.ts
import { Database } from "bun:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

const APP_DIR = new URL(".", import.meta.url).pathname;
const appRequire = createRequire(join(APP_DIR, "package.json"));
const { drizzle } = appRequire("drizzle-orm/bun-sqlite");
const schema = await import(join(APP_DIR, "server/src/schema.ts"));
const { Actions, pickCurrentArchVersion, archPayloadsEquivalent } = await import(
  join(APP_DIR, "server/src/actions.ts")
);

let passed = 0, failed = 0;
function check(name: string, cond: boolean) {
  if (cond) { passed++; } else { failed++; console.log("FAIL:", name); }
}

// ---------- db scaffolding (same shape as validate-arch-dates) ----------
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
async function insertArchRow(db: any, payload: unknown, pulledAtIso: string) {
  await db.insert(schema.archNetWorth).values({
    payload: typeof payload === "string" ? payload : JSON.stringify(payload),
    pulledAt: new Date(pulledAtIso),
  });
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
const syncCtx = (db: any) => makeCtx(db, {});

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
// A stored-payload builder mirroring the stored row shape, for
// directly constructed stand-in / legacy rows.
function storedPayload(over: any = {}) {
  return {
    arch: "F-ARCH-001", version: 1,
    pulledAt: T_OLD, storedAt: T_OLD,
    total: 750, partial: false, missing: [],
    plaidRange: { oldest: "2026-10-20", newest: "2026-10-20" }, snapshotRange: null,
    rows: [
      { id: "bank_a", included: true, signed: 1000, asOf: "2026-10-20", coverage: "plaid" },
      { id: "card_a", included: true, signed: -250, asOf: "2026-10-20", coverage: "plaid" },
    ],
    amountIncluded: 2, amountTotal: 2, validDateCount: 2, dateTotal: 2,
    ...over,
  };
}
// Reference: the exact payload a real successful V1 ingest stores.
async function referenceV1Payload(): Promise<any> {
  const { sqlite, db } = freshDb();
  const res = await ingest(db, reqV1());
  if (!res.ok) throw new Error("reference ingest failed");
  const row = sqlite.query("SELECT payload FROM arch_net_worth ORDER BY id DESC LIMIT 1").get() as any;
  return JSON.parse(row.payload);
}

// =====================================================================
// Group A: forward order — two versions, getter shows the newer
// =====================================================================
{
  const { sqlite, db } = freshDb();
  seedDashboardState(sqlite);
  const r1 = await ingest(db, reqV1());
  check("A: first version accepted and read-back verified", r1.ok === true && r1.readBackVerified === true);
  const r2 = await ingest(db, reqV2());
  check("A: second (newer) version accepted", r2.ok === true && r2.readBackVerified === true);
  check("A: append-only history keeps both rows", archRowCount(sqlite) === 2);
  const arch = await getterArch(db);
  check("A: getter shows the newer version", arch?.pulledAt === T_NEW && arch?.total === 950);
}

// =====================================================================
// Group B: reverse order — the late older version is refused
// (stale_version, zero writes) and the getter stays on the newer
// =====================================================================
{
  const { sqlite, db } = freshDb();
  seedDashboardState(sqlite);
  const r1 = await ingest(db, reqV2());
  check("B: newer version written first is accepted", r1.ok === true);
  const stale = await ingest(db, reqV1());
  check("B: late older version rejected as stale_version", stale.ok === false && stale.issue === "stale_version");
  check("B: stale rejection writes zero rows", archRowCount(sqlite) === 1);
  check("B: stale failure uses the counts/booleans-only shape (no total field)",
    stale.rows === 0 && stale.totalMatches === false && stale.readBackVerified === false && !("total" in stale));
  const arch = await getterArch(db);
  check("B: getter still shows the newer version (no rollback)", arch?.pulledAt === T_NEW && arch?.total === 950);
}

// =====================================================================
// Group C: idempotency — same pulledAt + equivalent content is a
// no-append success, including the lost-response retry
// =====================================================================
{
  const { sqlite, db } = freshDb();
  seedDashboardState(sqlite);
  const r1 = await ingest(db, reqV1());
  check("C: initial write ok", r1.ok === true && archRowCount(sqlite) === 1);
  const retry = await ingest(db, reqV1());
  check("C: identical retry succeeds without appending",
    retry.ok === true && retry.readBackVerified === true && archRowCount(sqlite) === 1);
  const retry2 = await ingest(db, reqV1(), syncCtx(db));
  check("C: lost-response retry via the sync channel is still idempotent",
    retry2.ok === true && archRowCount(sqlite) === 1);
  const arch = await getterArch(db);
  check("C: getter unchanged after retries", arch?.pulledAt === T_OLD && arch?.total === 750);
}

// =====================================================================
// Group D: same pulledAt, different content -> version_conflict,
// zero writes — including a same-total stand-in whose only
// difference is an account id
// =====================================================================
{
  const { sqlite, db } = freshDb();
  const r1 = await ingest(db, reqV1());
  check("D: initial write ok", r1.ok === true);
  const changedAmount = { ...reqV1(), total: 850, accounts: [acct("bank_a", 1100, "asset", "plaid", "2026-10-20"), acct("card_a", 250, "liability", "plaid", "2026-10-20")] };
  const conflict = await ingest(db, changedAmount);
  check("D: same pulledAt, different amounts -> version_conflict, zero writes",
    conflict.ok === false && conflict.issue === "version_conflict" && archRowCount(sqlite) === 1);
  const changedId = { ...reqV1(), accounts: [acct("bank_b", 1000, "asset", "plaid", "2026-10-20"), acct("card_a", 250, "liability", "plaid", "2026-10-20")] };
  const conflict2 = await ingest(db, changedId);
  check("D: same pulledAt + same total, different account id -> version_conflict, zero writes",
    conflict2.ok === false && conflict2.issue === "version_conflict" && archRowCount(sqlite) === 1);
  check("D: conflict failure uses the counts/booleans-only shape",
    conflict.rows === 0 && conflict.readBackVerified === false && !("total" in conflict));
}

// =====================================================================
// Group E: stand-in read-back — a stored row with the same
// pulledAt / row count / total but different account id, coverage
// or asOf must NOT verify. Exercised through the pure comparator
// and through the real ingest path (the stand-in pre-exists, so
// the write must surface as version_conflict, never ok).
// =====================================================================
{
  const reference = await referenceV1Payload();
  const standIn = (mutate: (p: any) => void) => {
    const p = JSON.parse(JSON.stringify(reference));
    mutate(p);
    return p;
  };
  check("E: identical content except storedAt IS equivalent (storedAt excluded)",
    archPayloadsEquivalent(reference, standIn((p) => { p.storedAt = "2026-12-31T00:00:00.000Z"; })) === true);
  check("E: different account id is NOT equivalent",
    archPayloadsEquivalent(reference, standIn((p) => { p.rows[0].id = "bank_z"; })) === false);
  check("E: different coverage is NOT equivalent",
    archPayloadsEquivalent(reference, standIn((p) => { p.rows[0].coverage = "snapshot"; })) === false);
  check("E: different asOf is NOT equivalent",
    archPayloadsEquivalent(reference, standIn((p) => { p.rows[0].asOf = "2026-10-21"; })) === false);
  check("E: different signed amount is NOT equivalent",
    archPayloadsEquivalent(reference, standIn((p) => { p.rows[0].signed = 1001; p.total = 751; })) === false);
  check("E: different missing list is NOT equivalent",
    archPayloadsEquivalent(reference, standIn((p) => { p.missing = ["ghost"]; })) === false);

  for (const [label, mutate] of [
    ["account id", (p: any) => { p.rows[0].id = "bank_z"; }],
    ["coverage", (p: any) => { p.rows[0].coverage = "snapshot"; }],
    ["asOf", (p: any) => { p.rows[1].asOf = "2026-10-19"; }],
  ] as Array<[string, (p: any) => void]>) {
    const { sqlite, db } = freshDb();
    await insertArchRow(db, standIn(mutate), T_OLD);
    const res = await ingest(db, reqV1());
    check(`E: pre-existing stand-in (${label}) — ingest refuses (version_conflict), no append, not verified`,
      res.ok === false && res.issue === "version_conflict" && res.readBackVerified === false && archRowCount(sqlite) === 1);
  }
  {
    // an exactly-equivalent pre-existing row (e.g. an earlier
    // attempt whose response was lost) verifies by its own id
    const { sqlite, db } = freshDb();
    await insertArchRow(db, reference, T_OLD);
    const res = await ingest(db, reqV1());
    check("E: exactly-equivalent pre-existing row verifies idempotently by id",
      res.ok === true && res.readBackVerified === true && archRowCount(sqlite) === 1);
  }
}

// =====================================================================
// Group F: version selection — pulledAt decides, corrupt rows
// are skipped, ties go to the greatest id
// =====================================================================
{
  const older = { id: 9, payload: JSON.stringify(storedPayload()), pulledAt: new Date(T_OLD) };
  const newer = { id: 3, payload: JSON.stringify(storedPayload({ pulledAt: T_NEW, total: 950 })), pulledAt: new Date(T_NEW) };
  check("F: selection picks greatest pulledAt even when it was inserted first (smaller id)",
    pickCurrentArchVersion([newer, older])?.row.id === 3);
  check("F: selection is insertion-order independent",
    pickCurrentArchVersion([older, newer])?.row.id === 3);
  const corrupt = { id: 99, payload: "{not json", pulledAt: new Date("2026-12-01T00:00:00.000Z") };
  check("F: an unparsable row never shadows a valid older version",
    pickCurrentArchVersion([corrupt, older])?.row.id === 9);
  check("F: all-corrupt candidates yield no current version",
    pickCurrentArchVersion([corrupt]) === null);
  const tieA = { id: 5, payload: JSON.stringify(storedPayload({ total: 750 })), pulledAt: new Date(T_OLD) };
  const tieB = { id: 7, payload: JSON.stringify(storedPayload({ total: 999 })), pulledAt: new Date(T_OLD) };
  check("F: same pulledAt tie goes to the greatest id",
    pickCurrentArchVersion([tieA, tieB])?.row.id === 7);
}
{
  // getter-level: a corrupt row with a NEWER pulled_at column
  // sitting on top of a valid version changes nothing
  const { sqlite, db } = freshDb();
  seedDashboardState(sqlite);
  const r1 = await ingest(db, reqV1());
  check("F: setup write ok", r1.ok === true);
  await insertArchRow(db, "{corrupt payload", T_NEW);
  const arch = await getterArch(db);
  check("F: getter skips the corrupt newer row and still shows the valid version",
    arch?.pulledAt === T_OLD && arch?.total === 750);
}

// =====================================================================
// Group G: concurrent dual-order writes — whatever the insertion
// order, the current version ends up the greater pulledAt
// =====================================================================
{
  const { sqlite, db } = freshDb();
  seedDashboardState(sqlite);
  const [resOld, resNew] = await Promise.all([ingest(db, reqV1()), ingest(db, reqV2())]);
  check("G: the newer version's write succeeds under concurrency", resNew.ok === true);
  check("G: the older write either landed first or was refused stale (never silently current)",
    resOld.ok === true || resOld.issue === "stale_version");
  const arch = await getterArch(db);
  check("G: final current version is the greater pulledAt regardless of insertion order",
    arch?.pulledAt === T_NEW && arch?.total === 950);
  check("G: at least the winning row is stored", archRowCount(sqlite) >= 1);
}

// =====================================================================
// Group H: pre-existing rejection matrix — spot checks unchanged
// =====================================================================
{
  const cases: Array<[string, any, string]> = [
    ["invalid_as_of (2026-02-30)", { ...reqV1(), accounts: [acct("a", 100, "asset", "plaid", "2026-02-30")] , total: 100 }, "invalid_as_of"],
    ["duplicate_id", { ...reqV1(), accounts: [acct("a", 1, "asset", "plaid", "2026-10-20"), acct("a", 2, "asset", "plaid", "2026-10-20")], total: 3 }, "duplicate_id"],
    ["total_mismatch", { ...reqV1(), total: 999 }, "total_mismatch"],
    ["missing_balance", { ...reqV1(), accounts: [acct("a", null, "asset", "plaid", "2026-10-20")], total: 0 }, "missing_balance"],
    ["invalid_pulled_at", { ...reqV1(), pulledAt: "2026-10-24 15:00" }, "invalid_pulled_at"],
  ];
  for (const [label, req, issue] of cases) {
    const { sqlite, db } = freshDb();
    const res = await ingest(db, req);
    check(`H: matrix ${label} still rejected with zero inserts`,
      res.ok === false && res.issue === issue && archRowCount(sqlite) === 0);
  }
}

// =====================================================================
// Group I: identity gates unchanged — owner / guest / approved
// anonymous sync channel
// =====================================================================
{
  const { sqlite, db } = freshDb();
  const guest = await ingest(db, reqV1(), guestCtx(db));
  check("I: identified non-owner is forbidden, zero writes",
    guest.ok === false && guest.issue === "forbidden" && archRowCount(sqlite) === 0);
  const sync = await ingest(db, reqV1(), syncCtx(db));
  check("I: approved anonymous sync channel may write", sync.ok === true && archRowCount(sqlite) === 1);
  const guestView = await Actions.getDashboard.handler(guestCtx(db), {});
  check("I: guest read still denied", guestView.access === "guest_denied" && guestView.data === null);
}

// =====================================================================
// Group J: legacy 0005 payload (no DATE-1 coverage fields) still
// parses, is selected as current, and the getter re-derives the
// counts — getter and card model stay consistent
// =====================================================================
{
  const { sqlite, db } = freshDb();
  seedDashboardState(sqlite);
  const legacy = storedPayload();
  delete legacy.amountIncluded; delete legacy.amountTotal;
  delete legacy.validDateCount; delete legacy.dateTotal;
  await insertArchRow(db, legacy, T_OLD);
  const arch = await getterArch(db);
  check("J: legacy payload surfaces through the getter", arch !== null && arch.total === 750 && arch.pulledAt === T_OLD);
  check("J: getter re-derives coverage counts for the legacy payload (2/2, 2/2)",
    arch?.amountIncluded === 2 && arch?.amountTotal === 2 && arch?.validDateCount === 2 && arch?.dateTotal === 2);
  check("J: legacy payload rows reach the card unchanged (ids, signed, asOf, coverage)",
    arch?.rows[0]?.id === "bank_a" && arch?.rows[0]?.signed === 1000
    && arch?.rows[0]?.asOf === "2026-10-20" && arch?.rows[0]?.coverage === "plaid"
    && arch?.rows[1]?.signed === -250);
  const reference = await referenceV1Payload();
  const picked = pickCurrentArchVersion(
    sqlite.query("SELECT id, payload, pulled_at AS pulledAt FROM arch_net_worth").all() as any,
  );
  check("J: legacy payload is content-equivalent to a fresh write of the same version",
    picked !== null && archPayloadsEquivalent(picked.parsed as any, reference) === true);
  const retry = await ingest(db, reqV1());
  check("J: retry against the legacy row is idempotent (no duplicate append)",
    retry.ok === true && archRowCount(sqlite) === 1);
}

console.log(`validate-arch-save: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
