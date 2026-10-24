// F-ARCH-001·DATE-1 validation: strict calendar-date semantics
// for the new-architecture net-worth entry, getter and card.
//
// Drives the REAL actions (ingestArchNetWorth / getDashboard)
// against an isolated in-memory SQLite built from the app's own
// drizzle migrations, with fake ctx objects for the owner, a
// guest and the sync channel; exercises the REAL exported pure
// function sanitizeArchNetWorthDates for the getter model; and
// extracts the REAL card-model functions (archCoverageLine /
// archLayerLine / archRowDateLabel / isRealDateText) from the
// client source. All fixtures are synthetic; nothing touches
// the real app.db and no amount from any real payload is read.
//
// Run with Bun from the artifact root: bun validate-arch-dates.ts
import { Database } from "bun:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

const APP_DIR = new URL(".", import.meta.url).pathname;
const appRequire = createRequire(join(APP_DIR, "package.json"));
const { drizzle } = appRequire("drizzle-orm/bun-sqlite");
const schema = await import(join(APP_DIR, "server/src/schema.ts"));
const { Actions, sanitizeArchNetWorthDates } = await import(join(APP_DIR, "server/src/actions.ts"));

let passed = 0, failed = 0;
function check(name: string, cond: boolean) {
  if (cond) { passed++; } else { failed++; console.log("FAIL:", name); }
}

// ---------- db scaffolding (same shape as validate-refresh-chain) ----------
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
function storedArchPayload(sqlite: Database): any {
  const row = sqlite.query("SELECT payload FROM arch_net_worth ORDER BY id DESC LIMIT 1").get() as any;
  return row ? JSON.parse(row.payload) : null;
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

// ---------- synthetic ingest requests ----------
const PULLED_AT = "2026-10-24T15:00:00.000Z";
function archRequest(accounts: any[], total: number) {
  return { arch: "F-ARCH-001" as const, version: 1 as const, pulledAt: PULLED_AT, accounts, total };
}
const acct = (id: string, balance: number | null, kind: string, coverage: string, asOf: string | null) =>
  ({ id, balance, kind, coverage, asOf });

// =====================================================================
// Group 1: write gate — valid payloads are accepted
// =====================================================================
{
  // 1a: legal same-day payload
  const { sqlite, db } = freshDb();
  const res = await Actions.ingestArchNetWorth.handler(ownerCtx(db), archRequest([
    acct("bank_a", 1000, "asset", "plaid", "2026-10-20"),
    acct("card_a", 250, "liability", "plaid", "2026-10-20"),
  ], 750));
  check("same-day: accepted", res.ok === true && res.issue === null);
  check("same-day: exactly one row inserted", archRowCount(sqlite) === 1);
  const stored = storedArchPayload(sqlite);
  check("same-day: stored range is that day", stored.plaidRange?.oldest === "2026-10-20" && stored.plaidRange?.newest === "2026-10-20");
  check("same-day: coverage counts 2/2 and 2/2",
    stored.amountIncluded === 2 && stored.amountTotal === 2 && stored.validDateCount === 2 && stored.dateTotal === 2);
}
{
  // 1b: mixed valid dates incl. leap day 2024-02-29, plus a
  // missing row (asOf null, balance null) which stays legal.
  const { sqlite, db } = freshDb();
  const res = await Actions.ingestArchNetWorth.handler(ownerCtx(db), archRequest([
    acct("bank_a", 500, "asset", "plaid", "2024-02-29"),
    acct("broker_a", 700, "asset", "plaid", "2026-10-22"),
    acct("snap_a", 300, "asset", "snapshot", "2026-09-30"),
    acct("gone_a", null, "asset", "missing", null),
  ], 1500));
  check("mixed+leap: accepted (2024-02-29 is a real date)", res.ok === true && res.issue === null);
  check("mixed+leap: one row inserted, counts in response", archRowCount(sqlite) === 1 && res.rows === 4 && res.included === 3 && res.missing === 1);
  const stored = storedArchPayload(sqlite);
  check("mixed+leap: plaid range spans the valid dates only",
    stored.plaidRange?.oldest === "2024-02-29" && stored.plaidRange?.newest === "2026-10-22");
  check("mixed+leap: snapshot range is its own date",
    stored.snapshotRange?.oldest === "2026-09-30" && stored.snapshotRange?.newest === "2026-09-30");
  check("mixed+leap: coverage counts — amount 3/4, valid dates 3/4 (denominator never shrinks)",
    stored.amountIncluded === 3 && stored.amountTotal === 4 && stored.validDateCount === 3 && stored.dateTotal === 4);
  check("mixed+leap: total excludes the missing row", stored.total === 1500 && stored.partial === true);
}

// =====================================================================
// Group 2: write gate — invalid asOf rejected as invalid_as_of,
// zero inserts, one case at a time
// =====================================================================
const invalidDates: Array<[string, string]> = [
  ["nonexistent day 2026-02-30", "2026-02-30"],
  ["month 13 (2026-13-01)", "2026-13-01"],
  ["month 00 (2026-00-01)", "2026-00-01"],
  ["April 31 (2026-04-31)", "2026-04-31"],
  ["non-leap Feb 29 (2026-02-29)", "2026-02-29"],
  ["bad format (slashes)", "2026/10/20"],
  ["bad format (no padding)", "2026-1-5"],
  ["bad format (free text)", "unknown"],
];
for (const [label, bad] of invalidDates) {
  const { sqlite, db } = freshDb();
  const res = await Actions.ingestArchNetWorth.handler(ownerCtx(db), archRequest([
    acct("bank_a", 1000, "asset", "plaid", "2026-10-20"),
    acct("bank_b", 500, "asset", "snapshot", bad),
  ], 1500));
  check(`invalid asOf ${label}: rejected with invalid_as_of`, res.ok === false && res.issue === "invalid_as_of");
  check(`invalid asOf ${label}: zero rows inserted`, archRowCount(sqlite) === 0);
  check(`invalid asOf ${label}: failure response carries no amount fields`,
    !("total" in res) && res.totalMatches === false && res.readBackVerified === false);
}
{
  // a bad date hiding behind a missing row's sibling order and a
  // valid total must still stop the whole write (gate runs first)
  const { sqlite, db } = freshDb();
  const res = await Actions.ingestArchNetWorth.handler(syncCtx(db), archRequest([
    acct("gone_a", null, "asset", "missing", null),
    acct("bank_a", 100, "asset", "plaid", "2026-02-30"),
  ], 100));
  check("invalid asOf via sync channel: still invalid_as_of, zero inserts",
    res.ok === false && res.issue === "invalid_as_of" && archRowCount(sqlite) === 0);
}

// =====================================================================
// Group 3: pre-existing rejection matrix is intact
// =====================================================================
{
  const cases: Array<[string, any, string]> = [
    ["duplicate_id", archRequest([acct("a", 1, "asset", "plaid", "2026-10-20"), acct("a", 2, "asset", "plaid", "2026-10-20")], 3), "duplicate_id"],
    ["total_mismatch", archRequest([acct("a", 100, "asset", "plaid", "2026-10-20")], 999), "total_mismatch"],
    ["missing_balance", archRequest([acct("a", null, "asset", "plaid", "2026-10-20")], 0), "missing_balance"],
    ["missing_as_of (non-missing row, null date)", archRequest([acct("a", 100, "asset", "plaid", null)], 100), "missing_as_of"],
    ["unexpected_balance (missing row with balance)", archRequest([acct("a", 100, "asset", "missing", null)], 0), "unexpected_balance"],
    ["invalid_pulled_at", { ...archRequest([acct("a", 100, "asset", "plaid", "2026-10-20")], 100), pulledAt: "2026-10-24 15:00" }, "invalid_pulled_at"],
  ];
  for (const [label, req, issue] of cases) {
    const { sqlite, db } = freshDb();
    const res = await Actions.ingestArchNetWorth.handler(ownerCtx(db), req);
    check(`matrix ${label}: rejected, zero inserts`, res.ok === false && res.issue === issue && archRowCount(sqlite) === 0);
  }
  const { sqlite, db } = freshDb();
  const res = await Actions.ingestArchNetWorth.handler(guestCtx(db),
    archRequest([acct("a", 100, "asset", "plaid", "2026-10-20")], 100));
  check("matrix forbidden: identified non-owner rejected, zero inserts",
    res.ok === false && res.issue === "forbidden" && archRowCount(sqlite) === 0);
}

// =====================================================================
// Group 4: sanitizeArchNetWorthDates — read-path eligibility model
// (synthetic legacy payloads as stored BEFORE the gate existed:
// no coverage fields, ranges computed from bad dates)
// =====================================================================
function legacyArch(rows: any[], extra: any = {}) {
  return {
    arch: "F-ARCH-001", version: 1,
    pulledAt: PULLED_AT, storedAt: PULLED_AT,
    total: 0, partial: false, missing: [],
    plaidRange: null, snapshotRange: null,
    rows,
    ...extra,
  } as any;
}
const row = (id: string, included: boolean, signed: number | null, asOf: string | null, coverage: string) =>
  ({ id, included, signed, asOf, coverage });
{
  // legacy bad dates + a null date + a real 0 amount
  const input = legacyArch([
    row("plaid_bad", true, 100, "2026-02-30", "plaid"),
    row("plaid_zero", true, 0, "2026-10-20", "plaid"),
    row("plaid_ok", true, 50, "2026-10-22", "plaid"),
    row("snap_null", true, 200, null, "snapshot"),
    row("snap_bad", true, 300, "2026-13-01", "snapshot"),
    row("gone", false, null, null, "missing"),
  ], { plaidRange: { oldest: "2026-02-30", newest: "2026-10-22" }, snapshotRange: { oldest: "2026-13-01", newest: "2026-13-01" } });
  const out = sanitizeArchNetWorthDates(input);
  check("getter model: bad date excluded from plaid range (real-0 row's date still counts)",
    out.plaidRange?.oldest === "2026-10-20" && out.plaidRange?.newest === "2026-10-22");
  check("getter model: layer with no valid date -> range null", out.snapshotRange === null);
  check("getter model: denominators stay at rows total (6), never shrink",
    out.amountTotal === 6 && out.dateTotal === 6);
  check("getter model: amount included counts every included row incl. bad/null dates (5)",
    out.amountIncluded === 5);
  check("getter model: valid-date count counts only included rows with real dates (2)",
    out.validDateCount === 2);
  check("getter model: stored rows untouched — raw bad date, flags and amounts preserved",
    out.rows[0].asOf === "2026-02-30" && out.rows[0].included === true && out.rows[0].signed === 100);
  check("getter model: a real 0 amount survives (included, signed exactly 0)",
    out.rows[1].included === true && out.rows[1].signed === 0);
  check("getter model: input object not mutated",
    input.plaidRange?.oldest === "2026-02-30" && input.rows.length === 6);
}
{
  // amounts complete but dates incomplete — the two x/y counts differ
  const out = sanitizeArchNetWorthDates(legacyArch([
    row("a", true, 10, "2026-10-20", "plaid"),
    row("b", true, 20, "2026-04-31", "plaid"),
    row("c", true, 30, null, "snapshot"),
    row("d", true, 40, "2026-09-30", "snapshot"),
  ]));
  check("counts: amounts complete 4/4 while valid dates only 2/4",
    out.amountIncluded === 4 && out.amountTotal === 4 && out.validDateCount === 2 && out.dateTotal === 4);
  check("counts: multi-date plaid range uses the one valid date; snapshot range likewise",
    out.plaidRange?.oldest === "2026-10-20" && out.plaidRange?.newest === "2026-10-20"
    && out.snapshotRange?.oldest === "2026-09-30" && out.snapshotRange?.newest === "2026-09-30");
}
{
  // amounts missing — denominators still full
  const out = sanitizeArchNetWorthDates(legacyArch([
    row("a", true, 10, "2024-02-29", "plaid"),
    row("b", false, null, null, "missing"),
    row("c", false, null, null, "missing"),
  ]));
  check("counts: amount-missing state — included 1/3, valid dates 1/3, leap day valid",
    out.amountIncluded === 1 && out.amountTotal === 3 && out.validDateCount === 1 && out.dateTotal === 3);
  check("counts: plaid range is the leap day", out.plaidRange?.oldest === "2024-02-29" && out.plaidRange?.newest === "2024-02-29");
  // mutation sensitivity: a sanitizer that counts any non-null
  // string as a valid date must disagree with the real one
  const naive = legacyArch([
    row("x", true, 1, "2026-02-30", "plaid"),
  ]);
  const naiveCount = naive.rows.filter((r: any) => r.asOf !== null).length;
  check("mutation: naive non-null counting (1) differs from real valid-date count (0)",
    naiveCount === 1 && sanitizeArchNetWorthDates(naive).validDateCount === 0
    && sanitizeArchNetWorthDates(naive).plaidRange === null);
}

// =====================================================================
// Group 5: getDashboard overlay — a stored legacy row with bad
// dates is presented sanitized, and the DB row is NOT rewritten
// =====================================================================
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
  const legacyPayload = legacyArch([
    row("plaid_bad", true, 100, "2026-02-30", "plaid"),
    row("plaid_zero", true, 0, "2026-10-20", "plaid"),
    row("snap_bad", true, 300, "2026-13-01", "snapshot"),
    row("gone", false, null, null, "missing"),
  ], { total: 400, partial: true, missing: ["gone"], plaidRange: { oldest: "2026-02-30", newest: "2026-10-20" }, snapshotRange: { oldest: "2026-13-01", newest: "2026-13-01" } });
  const rawStored = JSON.stringify(legacyPayload);
  await db.insert(schema.archNetWorth).values({ payload: rawStored, pulledAt: new Date(PULLED_AT) });

  const view = await Actions.getDashboard.handler(ownerCtx(db), {});
  check("overlay: owner gets data with an arch figure", view.access === "owner" && view.data?.archNetWorth != null);
  const arch = view.data!.archNetWorth!;
  check("overlay: bad date removed from plaid range; real-0 row date is the range",
    arch.plaidRange?.oldest === "2026-10-20" && arch.plaidRange?.newest === "2026-10-20");
  check("overlay: snapshot layer has no valid date -> range null", arch.snapshotRange === null);
  check("overlay: coverage counts 3/4 amounts, 1/4 valid dates",
    arch.amountIncluded === 3 && arch.amountTotal === 4 && arch.validDateCount === 1 && arch.dateTotal === 4);
  check("overlay: total and real 0 preserved; bad-date row keeps its raw value",
    arch.total === 400 && arch.rows[1].signed === 0 && arch.rows[0].asOf === "2026-02-30");
  const after = sqlite.query("SELECT payload FROM arch_net_worth ORDER BY id DESC LIMIT 1").get() as any;
  check("overlay: the stored DB row is byte-identical after the read (no rewrite/backfill)",
    after.payload === rawStored);
  const guest = await Actions.getDashboard.handler(guestCtx(db), {});
  check("overlay: owner gate on reads unchanged (guest denied, no data)",
    guest.access === "guest_denied" && guest.data === null);
}

// =====================================================================
// Group 6: card model — the real functions extracted from the
// client source render the coverage line and per-row date labels
// =====================================================================
{
  const app = readFileSync(new URL("./client/src/App.tsx", import.meta.url), "utf8");
  const extract = (name: string) => {
    const start = app.indexOf(`export function ${name}`);
    if (start < 0) throw new Error(`${name} not found in client source`);
    const end = app.indexOf("\n}\n", start) + 3;
    return app.slice(start, end);
  };
  const fns = [
    extract("isRealDateText")
      .replace("export function isRealDateText(value: string): boolean", "function isRealDateText(value)"),
    extract("archCoverageLine")
      .replace("export function archCoverageLine(arch: ArchNetWorthData): string", "function archCoverageLine(arch)"),
    extract("archLayerLine")
      .replace(/export function archLayerLine\([\s\S]*?\): string/, "function archLayerLine(range, layerHasRows)"),
    extract("archRowDateLabel")
      .replace('export function archRowDateLabel(row: ArchNetWorthData["rows"][number]): string', "function archRowDateLabel(row)"),
  ];
  const model = new Function(`${fns.join("\n")}; return { archCoverageLine, archLayerLine, archRowDateLabel, isRealDateText };`)() as any;

  check("card: coverage line format — 金额已计入 x/y；有效余额日期 x/y",
    model.archCoverageLine({ amountIncluded: 3, amountTotal: 4, validDateCount: 1, dateTotal: 4 })
      === "金额已计入 3/4；有效余额日期 1/4");
  check("card: coverage line — amounts complete but dates incomplete",
    model.archCoverageLine({ amountIncluded: 4, amountTotal: 4, validDateCount: 2, dateTotal: 4 })
      === "金额已计入 4/4；有效余额日期 2/4");
  check("card: coverage line — amount missing state",
    model.archCoverageLine({ amountIncluded: 1, amountTotal: 3, validDateCount: 1, dateTotal: 3 })
      === "金额已计入 1/3；有效余额日期 1/3");
  check("card: layer line with a range shows the dates",
    model.archLayerLine({ oldest: "2026-10-20", newest: "2026-10-22" }, true) === "余额日期 2026-10-20 至 2026-10-22");
  check("card: layer line null range WITH rows states no valid date (not 'no accounts')",
    model.archLayerLine(null, true).includes("无有效余额日期"));
  check("card: layer line null range with NO rows states the layer is empty",
    model.archLayerLine(null, false) === "本层无账户");
  check("card: valid date row label is plain",
    model.archRowDateLabel({ coverage: "plaid", asOf: "2026-10-20" }) === "Plaid 同步 · 2026-10-20");
  check("card: leap day row label is plain (valid)",
    model.archRowDateLabel({ coverage: "snapshot", asOf: "2024-02-29" }) === "快照 · 2024-02-29");
  check("card: invalid date keeps its original text and is marked 日期无效",
    model.archRowDateLabel({ coverage: "snapshot", asOf: "2026-02-30" }) === "快照 · 2026-02-30 · 日期无效");
  check("card: null date is 日期未知 — a different label from 日期无效",
    model.archRowDateLabel({ coverage: "plaid", asOf: null }) === "Plaid 同步 · 日期未知");
  check("card: missing row is its own category （缺失未计入）, no date label borrowed",
    model.archRowDateLabel({ coverage: "missing", asOf: null }) === "缺失未计入"
    && model.archRowDateLabel({ coverage: "missing", asOf: "2026-02-30" }) === "缺失未计入");
  check("card: client validity reuses isRealDateText semantics (2026-02-29 invalid, 2024-02-29 valid)",
    model.isRealDateText("2026-02-29") === false && model.isRealDateText("2024-02-29") === true);
}

// =====================================================================
// Group 7: wiring — the gates are connected in the real sources
// =====================================================================
{
  const server = readFileSync(new URL("./server/src/actions.ts", import.meta.url), "utf8");
  const app = readFileSync(new URL("./client/src/App.tsx", import.meta.url), "utf8");
  const ingestBlock = server.slice(server.indexOf("ingestArchNetWorth: defineAction"), server.indexOf("} satisfies ActionsModule"));
  check("wiring: ingest handler applies isRealDateKey and returns invalid_as_of",
    ingestBlock.includes("isRealDateKey(account.asOf)") && ingestBlock.includes('archIngestFailure("invalid_as_of")'));
  check("wiring: ingest stores through sanitizeArchNetWorthDates",
    ingestBlock.includes("sanitizeArchNetWorthDates({"));
  // SAVE-1: the overlay now selects the current version via
  // pickCurrentArchVersion (greatest pulledAt, corrupt rows
  // skipped) and sanitizes THAT parsed payload — same sanitize
  // wiring, new selection step.
  check("wiring: getDashboard overlay sanitizes the parsed stored payload",
    server.includes("archNetWorth: sanitizeArchNetWorthDates(currentArch.parsed)")
    && server.includes("pickCurrentArchVersion(archRows)"));
  check("wiring: request schema no longer regex-gates asOf (handler owns the verdict)",
    !server.slice(server.indexOf("const ingestArchNetWorthRequest"), server.indexOf("const ingestArchNetWorthResponse")).includes(".regex("));
  check("wiring: card renders the coverage line and per-row date labels",
    app.includes("{archCoverageLine(arch)}") && app.includes("{archRowDateLabel(row)}"));
  check("wiring: card row labels reuse isRealDateText (no divergent client rule)",
    app.slice(app.indexOf("export function archRowDateLabel"), app.indexOf("export function archRowDateLabel") + 600).includes("isRealDateText(row.asOf)"));
  check("wiring: schema carries the coverage fields with defaults (legacy payloads parse)",
    server.includes("amountIncluded: z.number().int().nonnegative().default(0)")
    && server.includes("validDateCount: z.number().int().nonnegative().default(0)"));
}

console.log(`validate-arch-dates: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
