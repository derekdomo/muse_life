// HH0.4 / HH0.5 validation: listing status verification time, status
// tiers (actionable / degraded / excluded), and the ranking rubric.
// Behaviour runs against the REAL pure functions in
// server/src/rubric.ts (types stripped with node:module); wiring
// assertions run against the real client/server/migration source
// text. All fixtures are synthetic. Pure Node, no deps.
import { readFileSync, readdirSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";

const rubricSrc = readFileSync(new URL("./server/src/rubric.ts", import.meta.url), "utf8");
const actionsSrc = readFileSync(new URL("./server/src/actions.ts", import.meta.url), "utf8");
const schemaSrc = readFileSync(new URL("./server/src/schema.ts", import.meta.url), "utf8");
const clientSrc = readFileSync(new URL("./client/src/App.tsx", import.meta.url), "utf8");
const dataPlanSrc = readFileSync(new URL("./DATA-PLAN.md", import.meta.url), "utf8");
const migrationFile = readdirSync(new URL("./drizzle/", import.meta.url)).find((f) => f.startsWith("0004_"));
const migrationSql = migrationFile ? readFileSync(new URL(`./drizzle/${migrationFile}`, import.meta.url), "utf8") : "";

let passed = 0, failed = 0;
function check(name, cond) {
  if (cond) { passed++; } else { failed++; console.log("FAIL:", name); }
}

// --- load the real rubric module (zero-import pure functions) ---
function loadRubric(src) {
  const stripped = stripTypeScriptTypes(src).replace(/^export /gm, "");
  return new Function(
    `${stripped}; return { RUBRIC_WEIGHTS, SUBSCORE_KEYS, SUBSCORE_LABELS, computeRubricScore, statusTier, isExcludedStatus, statusLabel, formatStatusVerifiedAt, rankListings };`,
  )();
}
const rubric = loadRubric(rubricSrc);
const { RUBRIC_WEIGHTS, SUBSCORE_KEYS, computeRubricScore, statusTier, isExcludedStatus, statusLabel, formatStatusVerifiedAt, rankListings } = rubric;

check("rubric module has zero imports", !/^import\s/m.test(rubricSrc));
check("rubric module exports the full surface", ["computeRubricScore", "statusTier", "isExcludedStatus", "statusLabel", "formatStatusVerifiedAt", "rankListings"].every((n) => typeof rubric[n] === "function"));

// --- HH0.5 rubric computation ---
check("weights sum to 100", SUBSCORE_KEYS.reduce((sum, k) => sum + RUBRIC_WEIGHTS[k], 0) === 100);
check("weights match the published DATA-PLAN values",
  RUBRIC_WEIGHTS.hardCriteria === 20 && RUBRIC_WEIGHTS.environment === 20 && RUBRIC_WEIGHTS.school === 20
  && RUBRIC_WEIGHTS.ageCondition === 15 && RUBRIC_WEIGHTS.space === 10 && RUBRIC_WEIGHTS.priceComps === 15);
const full = computeRubricScore({ hardCriteria: 100, environment: 80, school: 60, ageCondition: 40, space: 20, priceComps: 0 });
check("full sub-scores: weighted total 56", full.total === 56);
check("full sub-scores: complete, 6 present", full.complete === true && full.presentCount === 6);
const missingOne = computeRubricScore({ hardCriteria: 90, environment: null, school: 90, ageCondition: 90, space: 90, priceComps: 90 });
check("one missing dimension renormalizes (90, not 72-as-zero)", missingOne.total === 90);
check("one missing dimension: incomplete, 5 present", missingOne.complete === false && missingOne.presentCount === 5);
const allMissing = computeRubricScore({ hardCriteria: null, environment: null, school: null, ageCondition: null, space: null, priceComps: null });
check("all missing: total null (honest degradation, no fabricated score)", allMissing.total === null && allMissing.presentCount === 0 && allMissing.complete === false);
const outOfRange = computeRubricScore({ hardCriteria: 150, environment: 50, school: 50, ageCondition: 50, space: 50, priceComps: 50 });
check("out-of-range sub-score treated as missing, never clamped or zeroed", outOfRange.total === 50 && outOfRange.presentCount === 5);
const nanCase = computeRubricScore({ hardCriteria: NaN, environment: 70, school: 70, ageCondition: 70, space: 70, priceComps: 70 });
check("NaN sub-score treated as missing", nanCase.total === 70 && nanCase.presentCount === 5);

// --- HH0.4 status tiers ---
check("active is actionable", statusTier("active") === "actionable");
check("contingent is degraded", statusTier("contingent") === "degraded");
check("pending is degraded", statusTier("pending") === "degraded");
check("unknown is degraded (never silently actionable)", statusTier("unknown") === "degraded");
check("sold is excluded", statusTier("sold") === "excluded" && isExcludedStatus("sold") === true);
check("off_market is excluded", statusTier("off_market") === "excluded" && isExcludedStatus("off_market") === true);
check("active is not excluded", isExcludedStatus("active") === false);
check("status labels carry distinct symbols + text (not color alone)",
  statusLabel("active").startsWith("●") && statusLabel("pending").startsWith("◐") && statusLabel("sold").startsWith("■") && statusLabel("active") !== statusLabel("pending"));

// --- HH0.4 verification-time presentation ---
check("missing verification time is honestly unknown", formatStatusVerifiedAt(null) === "核验时间未知");
check("undefined verification time is honestly unknown", formatStatusVerifiedAt(undefined) === "核验时间未知");
check("zero verification time is honestly unknown", formatStatusVerifiedAt(0) === "核验时间未知");
check("NaN verification time is honestly unknown", formatStatusVerifiedAt(NaN) === "核验时间未知");
check("known verification time renders Pacific MM-DD HH:mm",
  formatStatusVerifiedAt(Date.parse("2026-11-02T22:30:00Z")) === "状态核验于 11-02 14:30");

// --- ranking: totals sort, degraded last, excluded dropped, legacy fallback ---
const fixture = [
  { id: "A", status: "active", price: 2_500_000, total: 80, stored: 10 },
  { id: "B", status: "active", price: 2_400_000, total: 80, stored: 10 },
  { id: "C", status: "pending", price: 2_100_000, total: 99, stored: 10 },
  { id: "D", status: "sold", price: 2_100_000, total: 100, stored: 10 },
  { id: "E", status: "active", price: 2_600_000, total: null, stored: 70 },
  { id: "F", status: "off_market", price: 2_100_000, total: 100, stored: 10 },
];
const ranked = rankListings(fixture, (i) => i.total, (i) => i.stored);
check("sold/off_market dropped from the ranked list", ranked.length === 4 && !ranked.some((r) => r.item.id === "D" || r.item.id === "F"));
check("tie on total breaks by lower price first", ranked[0].item.id === "B" && ranked[0].rank === 1 && ranked[1].item.id === "A" && ranked[1].rank === 2);
check("legacy row (no sub-scores) falls back to stored score and is flagged", ranked[2].item.id === "E" && ranked[2].score === 70 && ranked[2].scoreIsFallback === true);
check("degraded ranks after every actionable despite higher total", ranked[3].item.id === "C" && ranked[3].rank === 4 && ranked[3].score === 99);
check("ranks are contiguous 1..n", ranked.map((r) => r.rank).join(",") === "1,2,3,4");

// --- wiring: migration is additive-only and covers every new column ---
check("0004 migration exists", migrationFile !== undefined);
for (const col of ["status_verified_at", "score_hard_criteria", "score_environment", "score_school", "score_age_condition", "score_space", "score_price_comps"]) {
  check(`migration adds listings.${col} as a nullable column`, migrationSql.includes(`ALTER TABLE listings ADD COLUMN ${col} INTEGER;`));
}
check("migration is additive-only (no DROP / DELETE / UPDATE)",
  !/DROP|DELETE FROM|UPDATE\s/i.test(migrationSql));

// --- wiring: schema, ingest, getReport ---
check("schema declares status_verified_at + six sub-score columns",
  schemaSrc.includes('statusVerifiedAt: integer("status_verified_at")')
  && ["score_hard_criteria", "score_environment", "score_school", "score_age_condition", "score_space", "score_price_comps"].every((c) => schemaSrc.includes(`"${c}"`)));
check("schema status enum extended with sold/off_market",
  schemaSrc.includes('"sold", "off_market"'));
check("ingest input accepts statusVerifiedAt and subScores",
  actionsSrc.includes("statusVerifiedAt: z.number().int().positive().nullable().optional()")
  && actionsSrc.includes("subScores: subScoresInputSchema.nullable().optional()"));
check("ingest computes totals with the rubric and re-ranks before insert",
  (() => { const sec = actionsSrc.slice(actionsSrc.indexOf("ingestResearch: defineAction")); const rub = sec.indexOf("computeRubricScore(item.subScores)"); const rank = sec.indexOf("rankListings("); const ins = sec.indexOf("db.insert(schema.listings)"); return rub > -1 && rank > rub && ins > rank; })());
check("ingest stores sub-scores + verification time, excluded rows retained with trailing ranks",
  actionsSrc.includes("scoreHardCriteria: entry.subScores?.hardCriteria ?? null")
  && actionsSrc.includes("statusVerifiedAt: entry.statusVerifiedAt ?? null")
  && actionsSrc.includes("rankedVisible.length + index + 1"));
check("getReport filters excluded statuses at the read layer",
  actionsSrc.includes("rows.filter((row) => !isExcludedStatus(row.status))"));
check("getReport splits actionable vs degraded and renders verification label server-side",
  actionsSrc.includes("degradedListings: visibleRows.filter((row) => statusTier(row.status) === \"degraded\").map(presentListing)")
  && actionsSrc.includes("statusVerifiedLabel: formatStatusVerifiedAt(row.statusVerifiedAt)"));
check("research prompt requires statusVerifiedAt + subScores with null-for-missing",
  actionsSrc.includes("statusVerifiedAt（你最后一次打开该房源页面确认其挂牌状态的时刻") && actionsSrc.includes("不得用 0 冒充"));
check("every action carries a v26 description (five actions since HH1 added setListingDecision)",
  (actionsSrc.match(/defineAction\(\{\s*\n\s*description: "/g) ?? []).length === 5);

// --- wiring: client renders tiers, verification text, sub-scores ---
check("client shows status label + verification text on every row",
  clientSrc.includes("{listing.statusLabel}") && clientSrc.includes("{listing.statusVerifiedLabel}"));
check("client has a separate degraded section marked non-actionable",
  clientSrc.includes("report.degradedListings") && clientSrc.includes("非可直接行动") && clientSrc.includes("降级展示 · 非可直接行动"));
check("client renders sub-score detail with honest missing state",
  clientSrc.includes("未评分") && clientSrc.includes("尚无分项评分") && clientSrc.includes("缺项未按 0 分计"));
check("client never recomputes a total (no rubric weights client-side)",
  !clientSrc.includes("hardCriteria: 20") && !clientSrc.includes("RUBRIC_WEIGHTS"));
check("DATA-PLAN publishes the rubric weights/formula and the getReport filter choice",
  dataPlanSrc.includes("硬条件 20%") && dataPlanSrc.includes("重新归一") && dataPlanSrc.includes("getReport 层过滤"));

// --- legacy-row compatibility ---
const legacy = computeRubricScore({ hardCriteria: null, environment: null, school: null, ageCondition: null, space: null, priceComps: null });
check("legacy row: null sub-scores -> null total, stored score path preserved", legacy.total === null);
check("legacy-shaped input (no new fields) still parses the old status set",
  ["active", "contingent", "pending", "unknown"].every((s) => typeof statusTier(s) === "string"));

// --- mutation sensitivity (real re-execution of mutated production source) ---
const noRenorm = loadRubric(rubricSrc.replace("weightedSum / presentWeight", "weightedSum / 100"));
check("mutation: dropping renormalization flips the missing-dimension total 90 -> 72",
  noRenorm.computeRubricScore({ hardCriteria: 90, environment: null, school: 90, ageCondition: 90, space: 90, priceComps: 90 }).total === 72);
const offMarketVisible = loadRubric(rubricSrc.replace('status === "sold" || status === "off_market"', 'status === "sold"'));
check("mutation: narrowing the excluded set flips off_market to degraded",
  offMarketVisible.statusTier("off_market") === "degraded" && offMarketVisible.isExcludedStatus("off_market") === false);
check("mutation: off_market then survives ranking (5 rows instead of 4)",
  offMarketVisible.rankListings(fixture, (i) => i.total, (i) => i.stored).length === 5);
const zeroIsKnown = loadRubric(rubricSrc.replace("verifiedAtMs <= 0", "verifiedAtMs < 0"));
check("mutation: weakening the unknown-time guard flips 0 from unknown to a rendered time",
  zeroIsKnown.formatStatusVerifiedAt(0) !== "核验时间未知");

console.log(`validate-house-status-rubric: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
