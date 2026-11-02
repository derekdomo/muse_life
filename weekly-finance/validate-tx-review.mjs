// F3.5 交易待复核队列 validation: drives the REAL production
// pure module (server/src/txReviewQueue.ts — zero imports,
// every export exercised below) over fully synthetic fixtures,
// drives the REAL action handlers (saveCategoryRule /
// deleteCategoryRule / getDashboard / ingestArchDailySpend)
// over an in-memory database built from the app's own
// migrations, checks the source wiring (server field, client
// panel, CSS, migration), and runs three source mutations that
// are really executed and must flip behaviour. No real
// financial data: every merchant and amount below is synthetic.
// Run: bun validate-tx-review.mjs
import { readFileSync, readdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { Database } from "bun:sqlite";

const APP_DIR = new URL(".", import.meta.url).pathname;
const mod = await import(join(APP_DIR, "server/src/txReviewQueue.ts"));
const {
  flagReviewCandidates,
  applyCategoryRules,
  normalizeTxMerchant,
  isLowConfidenceCategory,
  medianOf,
  percentileOf,
  formatReviewAmount,
  LOW_CONFIDENCE_CATEGORIES,
  AMOUNT_ANOMALY_MIN_HISTORY,
  AMOUNT_ANOMALY_MEDIAN_MULTIPLIER,
} = mod;

let passed = 0, failed = 0;
function check(name, cond) {
  if (cond) { passed++; } else { failed++; console.log("FAIL:", name); }
}
const tx = (id, date, amount, extra = {}) => ({ id, date, amount, ...extra });
const only = (rows, id) => rows.find((row) => row.id === id);

// ---------- pure helpers ----------
check("normalize: trim + lowercase + collapse whitespace",
  normalizeTxMerchant("  Corner   CAFE ") === "corner cafe");
check("normalize: empty / blank / non-string -> null",
  normalizeTxMerchant("") === null && normalizeTxMerchant("   ") === null
  && normalizeTxMerchant(null) === null && normalizeTxMerchant(undefined) === null);
check("median: odd middle, even average, empty null",
  medianOf([10, 20, 30]) === 20 && medianOf([10, 20]) === 15 && medianOf([]) === null);
check("percentile: nearest-rank (95th of 4 -> max, 50th of 4 -> 2nd)",
  percentileOf([10, 20, 30, 40], 0.95) === 40 && percentileOf([10, 20, 30, 40], 0.5) === 20
  && percentileOf([], 0.95) === null);
check("format: cents-rounded, trailing zeros dropped",
  formatReviewAmount(100) === "100" && formatReviewAmount(10.5) === "10.5"
  && formatReviewAmount(10.25) === "10.25" && formatReviewAmount(10.004) === "10");
check("low-confidence list: PFC generic buckets + OTHER family, case-insensitive",
  LOW_CONFIDENCE_CATEGORIES.includes("OTHER") && LOW_CONFIDENCE_CATEGORIES.includes("GENERAL_MERCHANDISE")
  && LOW_CONFIDENCE_CATEGORIES.includes("GENERAL_SERVICES")
  && isLowConfidenceCategory("other") && isLowConfidenceCategory(" General_Services ")
  && !isLowConfidenceCategory("FOOD_AND_DRINK") && !isLowConfidenceCategory(null) && !isLowConfidenceCategory(""));
check("exported thresholds: history >= 3, median multiplier 3",
  AMOUNT_ANOMALY_MIN_HISTORY === 3 && AMOUNT_ANOMALY_MEDIAN_MULTIPLIER === 3);

// ---------- flag: UNCATEGORIZED ----------
{
  const rows = [
    tx("u1", "2026-10-01", -25, { name: "Shop A" }),
    tx("u2", "2026-10-02", -25, { name: "Shop B", category: "" }),
    tx("u3", "2026-10-03", -25, { name: "Shop C", category: "UNCATEGORIZED" }),
    tx("u4", "2026-10-04", -25, { name: "Shop D", category: "   " }),
    tx("ok", "2026-10-05", -25, { name: "Shop E", category: "FOOD_AND_DRINK" }),
  ];
  const out = flagReviewCandidates(rows);
  check("uncategorized: missing / empty / blank / fallback-literal all flagged",
    ["u1", "u2", "u3", "u4"].every((id) => only(out, id)?.flag === "UNCATEGORIZED"));
  check("uncategorized: a real category is not flagged", only(out, "ok") === undefined);
  check("uncategorized: candidate carries merchant + reason naming the fallback",
    only(out, "u1")?.merchant === "Shop A" && only(out, "u1")?.reason.includes("UNCATEGORIZED"));
  check("candidates sorted newest first",
    out.map((c) => c.id).join(",") === "u4,u3,u2,u1");
}

// ---------- flag: CATEGORY_UNCERTAIN ----------
{
  const rows = [
    tx("c1", "2026-10-01", -25, { name: "Shop A", category: "OTHER" }),
    tx("c2", "2026-10-02", -25, { name: "Shop B", category: "GENERAL_MERCHANDISE" }),
    tx("c3", "2026-10-03", -25, { name: "Shop C", category: "general_services" }),
  ];
  const out = flagReviewCandidates(rows);
  check("uncertain: OTHER / GENERAL_* flagged, reason names the recorded category",
    out.length === 3 && out.every((c) => c.flag === "CATEGORY_UNCERTAIN")
    && only(out, "c1")?.reason.includes("OTHER") && only(out, "c2")?.reason.includes("GENERAL_MERCHANDISE"));
}

// ---------- flag: AMOUNT_ANOMALY ----------
{
  const rows = [
    tx("h1", "2026-10-01", -10, { name: "Cafe", category: "FOOD_AND_DRINK" }),
    tx("h2", "2026-10-02", -12, { name: "Cafe", category: "FOOD_AND_DRINK" }),
    tx("h3", "2026-10-03", -11, { name: "Cafe", category: "FOOD_AND_DRINK" }),
    tx("h4", "2026-10-04", -100, { name: "Cafe", category: "FOOD_AND_DRINK" }),
  ];
  const out = flagReviewCandidates(rows);
  const hit = only(out, "h4");
  check("anomaly: only the latest row is flagged, history rows are not",
    out.length === 1 && hit?.flag === "AMOUNT_ANOMALY");
  check("anomaly: reason carries median + latest + threshold numbers",
    hit?.reason.includes("中位数 11") && hit?.reason.includes("最近一笔 100") && hit?.reason.includes("阈值 33"));
}
{
  const base = [
    tx("g1", "2026-10-01", -10, { name: "Store", category: "GENERAL_GOODS_X" }),
    tx("g2", "2026-10-02", -10, { name: "Store", category: "GENERAL_GOODS_X" }),
    tx("g3", "2026-10-03", -10, { name: "Store", category: "GENERAL_GOODS_X" }),
    tx("g4", "2026-10-04", -50, { name: "Store", category: "GENERAL_GOODS_X" }),
  ];
  const below = flagReviewCandidates([...base, tx("g5", "2026-10-05", -45, { name: "Store", category: "GENERAL_GOODS_X" })]);
  check("anomaly: 45 > 3x median (30) but below p95 threshold (50) -> not flagged",
    only(below, "g5") === undefined);
  const above = flagReviewCandidates([...base, tx("g5", "2026-10-05", -60, { name: "Store", category: "GENERAL_GOODS_X" })]);
  check("anomaly: 60 > threshold 50 -> flagged with threshold in reason",
    only(above, "g5")?.flag === "AMOUNT_ANOMALY" && only(above, "g5")?.reason.includes("阈值 50"));
}
{
  const rows = [
    tx("s1", "2026-10-01", -10, { name: "Tiny", category: "FOOD_AND_DRINK" }),
    tx("s2", "2026-10-02", -10, { name: "Tiny", category: "FOOD_AND_DRINK" }),
    tx("s3", "2026-10-03", -999, { name: "Tiny", category: "FOOD_AND_DRINK" }),
  ];
  check("anomaly: history < 3 -> never flagged", flagReviewCandidates(rows).length === 0);
}
{
  const rows = [
    tx("n1", "2026-10-01", -10, { name: "CAFE", category: "FOOD_AND_DRINK" }),
    tx("n2", "2026-10-02", -10, { name: " cafe ", category: "FOOD_AND_DRINK" }),
    tx("n3", "2026-10-03", -10, { name: "Cafe", category: "FOOD_AND_DRINK" }),
    tx("n4", "2026-10-04", -90, { name: "cAfE", category: "FOOD_AND_DRINK" }),
  ];
  const out = flagReviewCandidates(rows);
  check("anomaly: spelling variants of one merchant form one history",
    out.length === 1 && only(out, "n4")?.flag === "AMOUNT_ANOMALY"
    && only(out, "n4")?.normalizedMerchant === "cafe");
}
{
  const rows = [
    tx("m1", "2026-10-01", -10, { category: "FOOD_AND_DRINK" }),
    tx("m2", "2026-10-02", -10, { category: "FOOD_AND_DRINK" }),
    tx("m3", "2026-10-03", -10, { category: "FOOD_AND_DRINK" }),
    tx("m4", "2026-10-04", -900, {}),
  ];
  const out = flagReviewCandidates(rows);
  check("merchant-less: no anomaly grouping; missing category still queues with merchant null",
    out.length === 1 && only(out, "m4")?.flag === "UNCATEGORIZED" && only(out, "m4")?.merchant === null);
}
{
  const rows = [
    tx("d1", "2026-10-01", -10, { name: "Dup", category: "FOOD_AND_DRINK" }),
    tx("d1", "2026-10-01", -10, { name: "Dup", category: "FOOD_AND_DRINK" }),
    tx("d1", "2026-10-01", -10, { name: "Dup", category: "FOOD_AND_DRINK" }),
    tx("d2", "2026-10-02", -500, { name: "Dup", category: "FOOD_AND_DRINK" }),
  ];
  check("dedup: repeated id counts once -> history 0 -> no anomaly",
    flagReviewCandidates(rows).length === 0);
}
{
  const rows = [
    tx("p1", "2026-10-01", -10, { name: "Mix", category: "FOOD_AND_DRINK" }),
    tx("p2", "2026-10-02", -10, { name: "Mix", category: "FOOD_AND_DRINK" }),
    tx("p3", "2026-10-03", -10, { name: "Mix", category: "FOOD_AND_DRINK" }),
    tx("p4", "2026-10-04", -500, { name: "Mix", category: "OTHER" }),
  ];
  const out = flagReviewCandidates(rows);
  check("precedence: OTHER + anomalous amount -> CATEGORY_UNCERTAIN (one candidate per row)",
    out.length === 1 && only(out, "p4")?.flag === "CATEGORY_UNCERTAIN");
  check("purity: flagReviewCandidates does not mutate its input rows",
    !("flag" in rows[3]) && !("displayCategory" in rows[3]));
}

// ---------- applyCategoryRules ----------
{
  const rows = [
    { id: "r1", name: "Corner Cafe", category: "OTHER" },
    { id: "r2", name: "Book Store", category: "ENTERTAINMENT" },
    { id: "r3", name: "No Rule Diner", category: null },
  ];
  const out = applyCategoryRules(rows, [{ normalizedMerchant: "corner cafe", category: "FOOD_AND_DRINK" }]);
  check("rules: normalized merchant match overrides the display category",
    out[0]?.displayCategory === "FOOD_AND_DRINK" && out[0]?.ruleApplied === true
    && (out[0]?.ruleNote ?? "").includes("FOOD_AND_DRINK"));
  check("rules: unmatched rows keep their own category, null stays null",
    out[1]?.displayCategory === "ENTERTAINMENT" && out[1]?.ruleApplied === false && out[1]?.ruleNote === null
    && out[2]?.displayCategory === null && out[2]?.ruleApplied === false);
  check("rules: the input rows are not mutated",
    !("displayCategory" in rows[0]) && rows[0]?.category === "OTHER");
}
{
  const out = applyCategoryRules(
    [{ id: "x", merchant: "Cafe", category: "OTHER" }],
    [
      { normalizedMerchant: " CAFE ", category: "FOOD_AND_DRINK" },
      { normalizedMerchant: "cafe", category: "TRAVEL" },
      { normalizedMerchant: "cafe", category: "" },
    ],
  );
  check("rules: rule-side merchant is normalized too; first hit wins and the note counts hits",
    out[0]?.displayCategory === "FOOD_AND_DRINK" && (out[0]?.ruleNote ?? "").includes("共 2 条")
    && (out[0]?.ruleNote ?? "").includes("只取第一条"));
}
{
  const flagged = flagReviewCandidates([
    tx("q1", "2026-10-01", -30, { name: "Shop", category: "OTHER" }),
    tx("q2", "2026-10-02", -20, { name: "Mart" }),
  ]);
  const applied = applyCategoryRules(flagged, [{ normalizedMerchant: "shop", category: "GENERAL_MERCHANDISE" }]);
  const pending = applied.filter((c) => !c.ruleApplied);
  check("read path: ruled merchant auto-classifies out of the pending queue",
    pending.length === 1 && pending[0]?.id === "q2" && applied.length - pending.length === 1);
}

// ---------- mutations (really executed, must flip) ----------
const moduleSource = readFileSync(join(APP_DIR, "server/src/txReviewQueue.ts"), "utf8");
async function mutatedModule(replacements) {
  let src = moduleSource;
  for (const [anchor, replacement] of replacements) {
    if (!src.includes(anchor)) throw new Error(`mutation anchor missing: ${anchor}`);
    src = src.replace(anchor, replacement);
  }
  if (src === moduleSource) throw new Error("mutation did not change the source");
  const dir = mkdtempSync(join(tmpdir(), "txreview-mut-"));
  writeFileSync(join(dir, "txReviewQueue.ts"), src);
  try {
    return await import(join(dir, "txReviewQueue.ts"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
{
  const fixture = () => [
    tx("a1", "2026-10-01", -10, { name: "Cafe", category: "FOOD_AND_DRINK" }),
    tx("a2", "2026-10-02", -10, { name: "Cafe", category: "FOOD_AND_DRINK" }),
    tx("a3", "2026-10-03", -10, { name: "Cafe", category: "FOOD_AND_DRINK" }),
    tx("a4", "2026-10-04", -25, { name: "Cafe", category: "FOOD_AND_DRINK" }),
  ];
  check("mutation baseline: multiplier 3 -> latest 25 not flagged",
    flagReviewCandidates(fixture()).length === 0);
  const m1 = await mutatedModule([["AMOUNT_ANOMALY_MEDIAN_MULTIPLIER = 3", "AMOUNT_ANOMALY_MEDIAN_MULTIPLIER = 1"]]);
  check("mutation M1 (multiplier 3->1) flips: latest 25 becomes AMOUNT_ANOMALY",
    m1.flagReviewCandidates(fixture()).length === 1
    && m1.flagReviewCandidates(fixture())[0]?.flag === "AMOUNT_ANOMALY");
}
{
  const fixture = () => [
    tx("b1", "2026-10-01", -10, { name: "Cafe", category: "FOOD_AND_DRINK" }),
    tx("b2", "2026-10-02", -12, { name: "Cafe", category: "FOOD_AND_DRINK" }),
    tx("b3", "2026-10-03", -11, { name: "Cafe", category: "FOOD_AND_DRINK" }),
    tx("b4", "2026-10-04", -100, { name: "Cafe", category: "FOOD_AND_DRINK" }),
  ];
  check("mutation baseline: history floor 3 -> anomaly flagged",
    flagReviewCandidates(fixture()).length === 1);
  const m2 = await mutatedModule([["AMOUNT_ANOMALY_MIN_HISTORY = 3", "AMOUNT_ANOMALY_MIN_HISTORY = 5"]]);
  check("mutation M2 (history floor 3->5) flips: anomaly no longer flagged",
    m2.flagReviewCandidates(fixture()).length === 0);
}
{
  const fixture = () => [tx("o1", "2026-10-01", -25, { name: "Shop", category: "OTHER" })];
  check("mutation baseline: OTHER is CATEGORY_UNCERTAIN",
    flagReviewCandidates(fixture())[0]?.flag === "CATEGORY_UNCERTAIN");
  const m3 = await mutatedModule([['"OTHER",', '"OTHER_MUTATED",']]);
  check("mutation M3 (OTHER removed from low-confidence list) flips: row not flagged",
    m3.flagReviewCandidates(fixture()).length === 0);
}

// ---------- action handlers over an in-memory DB ----------
const appRequire = createRequire(join(APP_DIR, "package.json"));
const { drizzle } = appRequire("drizzle-orm/bun-sqlite");
const schema = await import(join(APP_DIR, "server/src/schema.ts"));
const { Actions, summarizeSpendDailyServer } = await import(join(APP_DIR, "server/src/actions.ts"));
function applyMigrationFile(sqlite, file) {
  const sql = readFileSync(join(APP_DIR, "drizzle", file), "utf8");
  for (const stmt of sql.split("--> statement-breakpoint")) {
    const s = stmt.trim();
    if (s) sqlite.exec(s);
  }
}
function freshDb() {
  const sqlite = new Database(":memory:");
  const files = readdirSync(join(APP_DIR, "drizzle")).filter((f) => f.endsWith(".sql")).sort();
  for (const f of files) applyMigrationFile(sqlite, f);
  return { sqlite, db: drizzle(sqlite, { schema }) };
}
function makeCtx(db, opts) {
  return {
    slug: "space-3",
    invocationId: "validator-harness",
    spaceDir: APP_DIR,
    viewer: opts.viewer,
    db: () => db,
    blobs: undefined,
    invalidateQueries: () => {},
    agent: { spawnTask: async () => ({ ok: true, taskId: "task-harness" }) },
    executePrivileged: async () => { throw new Error("not used"); },
  };
}
const ownerCtx = (db) => makeCtx(db, { viewer: { isOwner: true } });
const guestCtx = (db) => makeCtx(db, { viewer: { isOwner: false } });
const syncCtx = (db) => makeCtx(db, {});
const ruleCount = (sqlite) => sqlite.query("SELECT COUNT(*) AS n FROM tx_category_rules").get().n;
const feedCount = (sqlite) => sqlite.query("SELECT COUNT(*) AS n FROM tx_review_rows").get().n;

{
  const { sqlite, db } = freshDb();
  const guestSave = await Actions.saveCategoryRule.handler(guestCtx(db), { normalizedMerchant: "cafe", category: "FOOD_AND_DRINK" });
  check("actions: guest saveCategoryRule -> forbidden, zero writes",
    guestSave.ok === false && guestSave.issue === "forbidden" && ruleCount(sqlite) === 0);
  const syncSave = await Actions.saveCategoryRule.handler(syncCtx(db), { normalizedMerchant: "cafe", category: "FOOD_AND_DRINK" });
  check("actions: sync-channel (viewer-less) saveCategoryRule -> forbidden too (strict owner gate)",
    syncSave.ok === false && syncSave.issue === "forbidden" && ruleCount(sqlite) === 0);
  const saved = await Actions.saveCategoryRule.handler(ownerCtx(db), { normalizedMerchant: "  Corner Cafe ", category: "FOOD_AND_DRINK" });
  check("actions: owner save normalizes the merchant and returns the rule",
    saved.ok === true && saved.rule?.normalizedMerchant === "corner cafe" && saved.rule?.category === "FOOD_AND_DRINK" && ruleCount(sqlite) === 1);
  const upserted = await Actions.saveCategoryRule.handler(ownerCtx(db), { normalizedMerchant: "corner cafe", category: "TRAVEL" });
  check("actions: saving the same merchant again upserts (same id, one row, new category)",
    upserted.ok === true && upserted.rule?.id === saved.rule?.id && upserted.rule?.category === "TRAVEL" && ruleCount(sqlite) === 1);
  const noMerchant = await Actions.saveCategoryRule.handler(ownerCtx(db), { normalizedMerchant: "   ", category: "TRAVEL" });
  const noCategory = await Actions.saveCategoryRule.handler(ownerCtx(db), { normalizedMerchant: "cafe", category: "  " });
  check("actions: blank merchant / blank category rejected with typed issues, no writes",
    noMerchant.ok === false && noMerchant.issue === "missing_merchant"
    && noCategory.ok === false && noCategory.issue === "missing_category" && ruleCount(sqlite) === 1);
  const guestDelete = await Actions.deleteCategoryRule.handler(guestCtx(db), { id: saved.rule.id });
  check("actions: guest deleteCategoryRule -> forbidden, rule survives",
    guestDelete.ok === false && guestDelete.issue === "forbidden" && ruleCount(sqlite) === 1);
  const deleted = await Actions.deleteCategoryRule.handler(ownerCtx(db), { id: saved.rule.id });
  check("actions: owner delete removes the rule; a second delete reports deleted:false",
    deleted.ok === true && deleted.deleted === true && ruleCount(sqlite) === 0);
  const deletedAgain = await Actions.deleteCategoryRule.handler(ownerCtx(db), { id: saved.rule.id });
  check("actions: deleting a missing rule is a clean no-op",
    deletedAgain.ok === true && deletedAgain.deleted === false);
}
{
  const { sqlite, db } = freshDb();
  const guestDash = await Actions.getDashboard.handler(guestCtx(db), {});
  check("getDashboard: guest -> txReviewQueue null",
    guestDash.access === "guest_denied" && guestDash.txReviewQueue === null);
  const emptyDash = await Actions.getDashboard.handler(ownerCtx(db), {});
  check("getDashboard: owner without a snapshot -> data null and txReviewQueue null",
    emptyDash.access === "owner" && emptyDash.data === null && emptyDash.txReviewQueue === null);
  const feedTxns = [
    { id: "f1", date: "2026-10-20", amount: -50, status: "posted", kind: "spend", category: "FOOD_AND_DRINK", account: "acct_a", name: "Corner Cafe" },
    { id: "f2", date: "2026-10-21", amount: -20, status: "posted", kind: "spend", account: "acct_a" },
    { id: "f4", date: "2026-10-21", amount: -30, status: "posted", kind: "spend", category: "OTHER", account: "acct_a", name: "Shop" },
    { id: "f3", date: "2026-10-21", amount: -500, status: "posted", kind: "transfer", account: "acct_a" },
  ];
  const recomputed = summarizeSpendDailyServer(feedTxns, { fromDate: "2026-10-20", toDate: "2026-10-21" });
  const ingest = await Actions.ingestArchDailySpend.handler(ownerCtx(db), {
    arch: "F-ARCH-001", version: 1, pulledAt: "2026-10-22T00:00:00.000Z",
    coverageStart: "2026-10-20", throughDate: "2026-10-21",
    fullCoverageStart: recomputed.fullCoverageStart,
    transactions: feedTxns, days: recomputed.days,
  });
  check("feed: full-mode daily-spend publish succeeds and feeds only spend rows",
    ingest.ok === true && feedCount(sqlite) === 3);
  const feedRow = sqlite.query("SELECT merchant_name AS m, category AS c FROM tx_review_rows WHERE txn_id = 'f1'").get();
  check("feed: merchant name + category are stored when submitted; absent stays null",
    feedRow.m === "Corner Cafe" && feedRow.c === "FOOD_AND_DRINK"
    && sqlite.query("SELECT merchant_name AS m, category AS c FROM tx_review_rows WHERE txn_id = 'f2'").get().m === null);
  const minimalMonth = {
    key: "2026-10-31", total: 1000, investment: 600, investmentContribution: 0,
    saving: 400, fixedSpend: 100, transfer: 0, income: 500, contribution: 0,
    flexibleSpend: null, totalSpend: null, investmentReturn: null,
  };
  const minimalDashboard = {
    asOf: "2026-11-01T00:00:00.000Z", sourceMonth: "2026-10-31", months: [minimalMonth],
    live: { netWorth: 1000, investment: 600, saving: 400, weeklyDelta: null },
    holdings: [], accounts: [], concentrationTop3: 0,
    fire: { annualContribution: 0, annualSpend: 1200, target: 30000, progress: null, gap: 29400 },
  };
  await db.insert(schema.financeState).values({ id: 1, payload: JSON.stringify(minimalDashboard) });
  const dash = await Actions.getDashboard.handler(ownerCtx(db), {});
  const queue = dash.txReviewQueue;
  check("getDashboard: owner with snapshot -> queue lists the uncategorized + uncertain rows only",
    dash.data !== null && queue !== null && queue.pendingTotal === 2
    && queue.candidates.some((c) => c.id === "f2" && c.flag === "UNCATEGORIZED" && c.merchant === null)
    && queue.candidates.some((c) => c.id === "f4" && c.flag === "CATEGORY_UNCERTAIN" && c.merchant === "Shop")
    && queue.autoClassifiedCount === 0 && queue.rules.length === 0);
  const ruleSave = await Actions.saveCategoryRule.handler(ownerCtx(db), { normalizedMerchant: "Shop", category: "GENERAL_MERCHANDISE" });
  const dash2 = await Actions.getDashboard.handler(ownerCtx(db), {});
  check("getDashboard: after saving a rule, its merchant leaves the queue and is counted auto-classified",
    ruleSave.ok === true && dash2.txReviewQueue?.pendingTotal === 1
    && dash2.txReviewQueue?.autoClassifiedCount === 1
    && dash2.txReviewQueue?.rules.length === 1
    && dash2.txReviewQueue?.rules[0]?.category === "GENERAL_MERCHANDISE");
  await Actions.deleteCategoryRule.handler(ownerCtx(db), { id: ruleSave.rule.id });
  const dash3 = await Actions.getDashboard.handler(ownerCtx(db), {});
  check("getDashboard: deleting the rule returns the merchant to the pending queue",
    dash3.txReviewQueue?.pendingTotal === 2 && dash3.txReviewQueue?.autoClassifiedCount === 0);
}

// ---------- wiring ----------
const actionsSrc = readFileSync(join(APP_DIR, "server/src/actions.ts"), "utf8");
const moduleSrc = moduleSource;
check("wiring: the pure module has zero imports and never imports the drifted F3.2/F3.3 modules",
  !/^\s*import\s/m.test(moduleSrc) && !moduleSrc.includes('from "./recurringCharges"') && !moduleSrc.includes('from "./cashFlowForecast"'));
check("wiring: actions.ts imports the pure module and exposes txReviewQueue on getDashboard",
  actionsSrc.includes('from "./txReviewQueue"')
  && actionsSrc.includes("txReviewQueue: txReviewQueueSchema.nullable().optional()")
  && actionsSrc.includes("txReviewQueue: null,"));
check("wiring: the feed is written from all three publish legs (full / finalize replace, incremental upsert)",
  actionsSrc.includes('recordTxReviewRows(ctx, txns, "replace")')
  && actionsSrc.includes('recordTxReviewRows(ctx, allTxns, "replace")')
  && actionsSrc.includes('recordTxReviewRows(ctx, txns, "upsert")'));
check("wiring: rule actions are owner-gated before any write",
  actionsSrc.includes("saveCategoryRule: defineAction({") && actionsSrc.includes("deleteCategoryRule: defineAction({")
  && actionsSrc.includes('if (!isOwner(ctx)) return { ok: false, issue: "forbidden", rule: null }')
  && actionsSrc.includes('if (!isOwner(ctx)) return { ok: false, issue: "forbidden", deleted: false }'));
const schemaSrc = readFileSync(join(APP_DIR, "server/src/schema.ts"), "utf8");
const migration = readFileSync(join(APP_DIR, "drizzle/0010_add_tx_review_queue.sql"), "utf8");
check("wiring: schema + migration carry both F3.5 tables, merchant unique, pure CREATE TABLE",
  schemaSrc.includes('sqliteTable("tx_category_rules"') && schemaSrc.includes('sqliteTable("tx_review_rows"')
  && migration.includes("CREATE TABLE tx_category_rules") && migration.includes("CREATE TABLE tx_review_rows")
  && migration.includes("normalized_merchant TEXT NOT NULL UNIQUE") && !/ALTER|DROP/.test(migration));
const appSrc = readFileSync(join(APP_DIR, "client/src/App.tsx"), "utf8");
check("wiring: client panel renders exactly once (detail tab) with the mandatory disclaimer",
  (appSrc.match(/<TxReviewQueuePanel/g) ?? []).length === 1
  && appSrc.includes("function TxReviewQueuePanel")
  && appSrc.includes("分类仅用于本看板展示；与 Firance 月度口径不一致时以 Firance 为准"));
check("wiring: flag labels carry glyph + Chinese text for all three flags",
  appSrc.includes("○ 待分类") && appSrc.includes("◐ 存疑分类") && appSrc.includes("▲ 金额异常"));
check("wiring: panel wires both owner actions and keeps input on failure",
  appSrc.includes("api.saveCategoryRule(") && appSrc.includes("api.deleteCategoryRule(")
  && appSrc.includes("确认为当前分类") && appSrc.includes("改为此分类") && appSrc.includes("已保留输入，可重试"));
const css = readFileSync(join(APP_DIR, "client/src/theme.css"), "utf8");
check("wiring: panel styles exist; action buttons, input and delete meet the 44px floor",
  css.includes(".tx-review-panel")
  && /\.tx-review-actions button \{[^}]*min-height: 44px/.test(css)
  && /\.tx-review-input \{[^}]*min-height: 44px/.test(css)
  && /\.tx-review-delete \{[^}]*min-height: 44px/.test(css));
const dataPlan = readFileSync(join(APP_DIR, "DATA-PLAN.md"), "utf8");
check("docs: DATA-PLAN carries the F3.5 section", dataPlan.includes("## F3.5"));

console.log(`validate-tx-review: ${passed}/${passed + failed} passed`);
process.exit(failed ? 1 : 0);
