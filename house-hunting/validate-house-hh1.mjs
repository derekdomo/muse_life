// HH1 validation: decision-support capabilities — transparent monthly
// cost estimates (HH1.1), the fixed 2–4 home comparison (HH1.2),
// owner decisions keyed by stable identity with previous-issue
// price/status change markers (HH1.3), the viewing checklist's
// report-vs-unverified posture (HH1.4), and school/rate source-date
// freshness with the 7-day stale boundary (HH1.5).
// Behaviour runs against the REAL pure functions in
// server/src/decision.ts (types stripped with node:module); wiring
// assertions run against the real client/server/schema/migration
// source text. All fixtures are synthetic. Pure Node, no deps.
import { readFileSync, readdirSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";

const decisionSrc = readFileSync(new URL("./server/src/decision.ts", import.meta.url), "utf8");
const actionsSrc = readFileSync(new URL("./server/src/actions.ts", import.meta.url), "utf8");
const schemaSrc = readFileSync(new URL("./server/src/schema.ts", import.meta.url), "utf8");
const clientSrc = readFileSync(new URL("./client/src/App.tsx", import.meta.url), "utf8");
const dataPlanSrc = readFileSync(new URL("./DATA-PLAN.md", import.meta.url), "utf8");
const migrationFile = readdirSync(new URL("./drizzle/", import.meta.url)).find((f) => f.startsWith("0005_"));
const migrationSql = migrationFile ? readFileSync(new URL(`./drizzle/${migrationFile}`, import.meta.url), "utf8") : "";

let passed = 0, failed = 0;
function check(name, cond) {
  if (cond) { passed++; } else { failed++; console.log("FAIL:", name); }
}
const near = (a, b) => Math.abs(a - b) < 0.01;

// --- load the real decision module (zero-import pure functions) ---
function loadDecision(src) {
  const stripped = stripTypeScriptTypes(src).replace(/^export /gm, "");
  return new Function(
    `${stripped}; return { COST_DEFAULTS, COMPARE_COLUMNS, COMPARE_MIN, COMPARE_MAX, STALE_THRESHOLD_MS, LISTING_DECISIONS, principalAndInterestMonthly, monthlyCostBreakdown, listingAgeYears, listingStableKey, diffListingChanges, buildViewingChecklist, sourceFreshness };`,
  )();
}
const dec = loadDecision(decisionSrc);
const {
  COST_DEFAULTS, COMPARE_COLUMNS, COMPARE_MIN, COMPARE_MAX, STALE_THRESHOLD_MS, LISTING_DECISIONS,
  principalAndInterestMonthly, monthlyCostBreakdown, listingAgeYears, listingStableKey,
  diffListingChanges, buildViewingChecklist, sourceFreshness,
} = dec;

check("decision module has zero imports", !/^import\s/m.test(decisionSrc));
check("decision module exports the full surface",
  ["principalAndInterestMonthly", "monthlyCostBreakdown", "listingAgeYears", "listingStableKey", "diffListingChanges", "buildViewingChecklist", "sourceFreshness"]
    .every((n) => typeof dec[n] === "function"));

// --- HH1.1 monthly cost breakdown ---
check("defaults: tax 1.18%, insurance 0.20%, down 30%",
  COST_DEFAULTS.taxRatePct === 1.18 && COST_DEFAULTS.insuranceRatePct === 0.2 && COST_DEFAULTS.downPaymentPct === 30);
// Independent P&I expectation: $2.4M, 30% down, 7.13% / 30y.
const principal = 2_400_000 * 0.7;
const mr = 7.13 / 100 / 12;
const expectedPI = (principal * mr * Math.pow(1 + mr, 360)) / (Math.pow(1 + mr, 360) - 1);
check("P&I matches the independent amortization computation", near(principalAndInterestMonthly(2_400_000, 30, 7.13), expectedPI));
check("P&I at 0% rate is principal / 360", near(principalAndInterestMonthly(1_800_000, 0, 0), 5000));
const full = monthlyCostBreakdown({ price: 2_400_000, downPaymentPct: 30, annualRatePct: 7.13, taxRatePct: 1.18, insuranceRatePct: 0.2, hoaMonthly: 125 });
check("tax part: price x 1.18% / 12 = 2360", near(full.propertyTaxMonthly, 2360));
check("insurance part: price x 0.20% / 12 = 400", near(full.insuranceMonthly, 400));
check("subtotal is P&I + tax + insurance", near(full.subtotalExcludingHoa, expectedPI + 2360 + 400));
check("total sums all four parts when HOA is known", near(full.totalMonthly, expectedPI + 2360 + 400 + 125) && full.hoaKnown === true);
const noHoa = monthlyCostBreakdown({ price: 2_400_000, downPaymentPct: 30, annualRatePct: 7.13, taxRatePct: 1.18, insuranceRatePct: 0.2, hoaMonthly: null });
check("unknown HOA: total is null, never totalled as 0", noHoa.totalMonthly === null && noHoa.hoaKnown === false && noHoa.hoaMonthly === null);
check("unknown HOA: subtotal still sums the three known parts", near(noHoa.subtotalExcludingHoa, expectedPI + 2360 + 400));
const zeroHoa = monthlyCostBreakdown({ price: 2_400_000, downPaymentPct: 30, annualRatePct: 7.13, taxRatePct: 1.18, insuranceRatePct: 0.2, hoaMonthly: 0 });
check("recorded HOA of 0 is known and totals normally", zeroHoa.hoaKnown === true && near(zeroHoa.totalMonthly, zeroHoa.subtotalExcludingHoa));
const custom = monthlyCostBreakdown({ price: 2_000_000, downPaymentPct: 20, annualRatePct: 6, taxRatePct: 1.5, insuranceRatePct: 0.35, hoaMonthly: null });
check("edited assumptions flow through (tax 2500, insurance ~583.33)",
  near(custom.propertyTaxMonthly, 2500) && near(custom.insuranceMonthly, 2_000_000 * 0.0035 / 12));

// --- HH1.2 fixed comparison columns ---
check("comparison bounds are 2..4", COMPARE_MIN === 2 && COMPARE_MAX === 4);
check("comparison columns are the fixed nine, in order",
  COMPARE_COLUMNS.map((c) => c.key).join(",") === "price,sqft,lotSqft,age,school,environment,status,risk,monthlyCost"
  && COMPARE_COLUMNS.map((c) => c.label).join(",") === "价格,居住面积,占地面积,房龄,学校,道路/噪音,挂牌状态,风险,月成本");
check("age derived from yearBuilt", listingAgeYears(1964, 2026) === 62 && listingAgeYears(2026, 2026) === 0);
check("age unknown stays null (rendered as —, never guessed)",
  listingAgeYears(null, 2026) === null && listingAgeYears(undefined, 2026) === null && listingAgeYears(2030, 2026) === null);

// --- HH1.3 stable identity + change detection + decisions ---
check("stable key normalizes case and whitespace",
  listingStableKey("  880  Lansdown Ct ", "SUNNYVALE") === "880 lansdown ct|sunnyvale"
  && listingStableKey("880 Lansdown Ct", "Sunnyvale") === listingStableKey("880  lansdown ct", "sunnyvale"));
check("stable key distinguishes different homes",
  listingStableKey("880 Lansdown Ct", "Sunnyvale") !== listingStableKey("881 Lansdown Ct", "Sunnyvale")
  && listingStableKey("880 Lansdown Ct", "Sunnyvale") !== listingStableKey("880 Lansdown Ct", "Cupertino"));
check("decisions are exactly favorite / excluded / viewed",
  LISTING_DECISIONS.join(",") === "favorite,excluded,viewed");
const firstSeen = diffListingChanges(null, { price: 2_500_000, status: "active" });
check("first appearance is not a change", firstSeen.priceChanged === false && firstSeen.statusChanged === false && firstSeen.previousPrice === null && firstSeen.previousStatus === null);
const priceMove = diffListingChanges({ price: 2_600_000, status: "active" }, { price: 2_500_000, status: "active" });
check("price change detected with previous price carried",
  priceMove.priceChanged === true && priceMove.previousPrice === 2_600_000 && priceMove.statusChanged === false && priceMove.previousStatus === null);
const statusMove = diffListingChanges({ price: 2_500_000, status: "active" }, { price: 2_500_000, status: "pending" });
check("status change detected with previous status carried",
  statusMove.statusChanged === true && statusMove.previousStatus === "active" && statusMove.priceChanged === false);
const noMove = diffListingChanges({ price: 2_500_000, status: "active" }, { price: 2_500_000, status: "active" });
check("unchanged listing carries no markers", noMove.priceChanged === false && noMove.statusChanged === false && noMove.previousPrice === null && noMove.previousStatus === null);

// --- HH1.4 viewing checklist posture ---
const UNVERIFIED = "未核实 · 看房时亲自确认";
const fullChecklist = buildViewingChecklist({ environmentSummary: "安静内街，噪音 9.7/10", conditionSummary: "厨卫更新", lotSqft: 6000, hoaMonthly: 125 });
check("checklist has the fixed six items in order",
  fullChecklist.map((i) => i.key).join(",") === "noise,road,light,renovation,roofHvacElectrical,lotHoa"
  && fullChecklist.map((i) => i.label).join(",") === "噪音,道路,采光,装修质量,屋顶 / HVAC / 电气,地块与 HOA");
check("noise/road cite the report environment summary",
  fullChecklist[0].state === "from-report" && fullChecklist[0].detail.includes("安静内街")
  && fullChecklist[1].state === "from-report");
check("renovation cites the report condition summary",
  fullChecklist[3].state === "from-report" && fullChecklist[3].detail.includes("厨卫更新"));
check("lot/HOA cites report lot size and HOA",
  fullChecklist[5].state === "from-report" && fullChecklist[5].detail.includes("6,000") && fullChecklist[5].detail.includes("$125"));
check("sunlight and roof/HVAC/electrical are always unverified",
  fullChecklist[2].state === "unverified" && fullChecklist[2].detail === UNVERIFIED
  && fullChecklist[4].state === "unverified" && fullChecklist[4].detail === UNVERIFIED);
const emptyChecklist = buildViewingChecklist({ environmentSummary: "", conditionSummary: "  ", lotSqft: null, hoaMonthly: null });
check("no report data: every item unverified, none stated as fact",
  emptyChecklist.every((i) => i.state === "unverified" && i.detail === UNVERIFIED));

// --- HH1.5 source freshness + 7-day stale boundary ---
const NOW = Date.parse("2026-11-03T12:00:00Z");
check("stale threshold is exactly 7 days", STALE_THRESHOLD_MS === 7 * 24 * 60 * 60 * 1000);
check("a source dated today is fresh", sourceFreshness(new Date(NOW).toISOString(), NOW) === "fresh");
check("exactly 7 days old is still fresh (strict >)", sourceFreshness(new Date(NOW - STALE_THRESHOLD_MS).toISOString(), NOW) === "fresh");
check("7 days + 1ms is stale", sourceFreshness(new Date(NOW - STALE_THRESHOLD_MS - 1).toISOString(), NOW) === "stale");
check("30 days old is stale", sourceFreshness(new Date(NOW - 30 * 24 * 3600 * 1000).toISOString(), NOW) === "stale");
check("missing date is unknown, never fresh", sourceFreshness(null, NOW) === "unknown" && sourceFreshness(undefined, NOW) === "unknown");
check("unparseable date is unknown", sourceFreshness("not-a-date", NOW) === "unknown" && sourceFreshness(0, NOW) === "unknown");
check("epoch-ms input accepted", sourceFreshness(NOW - 1000, NOW) === "fresh" && sourceFreshness(NOW - STALE_THRESHOLD_MS - 5, NOW) === "stale");

// --- wiring: schema + migration (additive only) ---
check("schema adds rate_as_of + school provenance + prev markers",
  schemaSrc.includes('rateAsOf: text("rate_as_of")')
  && schemaSrc.includes('schoolSource: text("school_source")')
  && schemaSrc.includes('schoolAsOf: text("school_as_of")')
  && schemaSrc.includes('prevPrice: integer("prev_price")')
  && schemaSrc.includes('prevStatus: text("prev_status")'));
check("schema adds the listing_user_states table keyed by stable key",
  schemaSrc.includes('sqliteTable("listing_user_states"')
  && schemaSrc.includes('stableKey: text("stable_key").primaryKey()')
  && schemaSrc.includes('"favorite", "excluded", "viewed"'));
check("0005 migration exists", migrationFile !== undefined);
check("migration is additive-only (no DROP / DELETE / UPDATE)",
  !/DROP|DELETE FROM|UPDATE\s/i.test(migrationSql));
check("migration adds every HH1 column and the new table",
  migrationSql.includes("ALTER TABLE reports ADD COLUMN rate_as_of TEXT;")
  && migrationSql.includes("ALTER TABLE listings ADD COLUMN school_source TEXT;")
  && migrationSql.includes("ALTER TABLE listings ADD COLUMN school_as_of TEXT;")
  && migrationSql.includes("ALTER TABLE listings ADD COLUMN prev_price INTEGER;")
  && migrationSql.includes("ALTER TABLE listings ADD COLUMN prev_status TEXT;")
  && migrationSql.includes("CREATE TABLE listing_user_states"));

// --- wiring: actions ---
check("setListingDecision is owner-gated before any write",
  (() => { const sec = actionsSrc.slice(actionsSrc.indexOf("setListingDecision: defineAction"), actionsSrc.indexOf("initializeReport: defineAction")); const gate = sec.indexOf("if (!isOwner(ctx))"); const write = sec.indexOf("schema.listingUserStates"); return gate > -1 && write > gate && sec.includes('status: "forbidden"'); })());
check("setListingDecision upserts by stable key",
  actionsSrc.includes("eq(schema.listingUserStates.stableKey, args.stableKey)"));
check("getReport withholds decisions from non-owner readers",
  actionsSrc.includes("if (owner)") && actionsSrc.includes("decisionByKey.get(stableKey) ?? null") && actionsSrc.includes("viewerIsOwner: owner"));
check("getReport computes freshness server-side for rate and schools",
  actionsSrc.includes("rateFreshness: sourceFreshness(report.rateAsOf, nowMs)")
  && actionsSrc.includes("schoolFreshness: sourceFreshness(row.schoolAsOf, nowMs)"));
check("getReport builds the viewing checklist server-side",
  actionsSrc.includes("checklist: buildViewingChecklist({"));
check("ingest accepts rate/school provenance optionally (legacy callbacks unaffected)",
  actionsSrc.includes("rateAsOf: z.string().min(4).max(40).nullable().optional()")
  && actionsSrc.includes("schoolSource: z.string().min(1).max(200).nullable().optional()")
  && actionsSrc.includes("schoolAsOf: z.string().min(4).max(40).nullable().optional()"));
check("ingest diffs against the previous published issue and stores prev markers",
  (() => { const sec = actionsSrc.slice(actionsSrc.indexOf("ingestResearch: defineAction")); return sec.includes("previousByKey") && sec.includes("diffListingChanges(") && sec.includes("prevPrice: change.previousPrice") && sec.includes("prevStatus: change.previousStatus"); })());
check("refresh prompt requires school/rate provenance with null-for-unknown",
  actionsSrc.includes("schoolSource（来源名称") && actionsSrc.includes("rateAsOf（所采用按揭利率来源的发布日期") && actionsSrc.includes("不得编造来源或日期"));
check("every action carries a description (now five actions)",
  (actionsSrc.match(/defineAction\(\{\s*\n\s*description: "/g) ?? []).length === 5);

// --- wiring: client ---
check("client labels the estimate and the maintenance exclusion prominently",
  clientSrc.includes("月成本估算（分项）") && clientSrc.includes("估算值 · 不含维修/装修") && clientSrc.includes("不含维修/装修"));
check("client separates default vs edited assumptions",
  clientSrc.includes("（默认）") && clientSrc.includes("（已修改）") && clientSrc.includes("1.18%/年") && clientSrc.includes("0.20%/年"));
check("client never totals an unknown HOA as 0",
  clientSrc.includes("无 / 未知 · 未计入合计") && clientSrc.includes("没有按 0 计入"));
check("client offers the 2-4 comparison with the fixed column set",
  clientSrc.includes("加入对比") && clientSrc.includes("可选 2–4 套") && clientSrc.includes("对比列固定")
  && ["价格", "居住面积", "占地面积", "房龄", "学校", "道路/噪音", "挂牌状态", "风险", "月成本"].every((l) => clientSrc.includes(`label: "${l}"`)));
check("client shows missing comparison values as —", clientSrc.includes('return listing.lotSqft ? ') && clientSrc.includes('"—"'));
check("client renders decision controls as an honest three-way choice",
  clientSrc.includes("三选一") && clientSrc.includes("setListingDecision") && clientSrc.includes("显示已排除"));
check("client renders price/status change markers with previous values",
  clientSrc.includes("价格变化：上期") && clientSrc.includes("状态变化：上期"));
check("client renders checklist unverified posture verbatim from the server",
  clientSrc.includes("未核实") && clientSrc.includes("不要当作已确认的事实"));
check("client shows school + rate source and date with honest unknowns",
  clientSrc.includes("学校评分来源：") && clientSrc.includes("来源未知") && clientSrc.includes("日期未知") && clientSrc.includes("来源日期："));
check("client marks stale sources with symbol + text",
  clientSrc.includes("⚠ stale · 已超过 7 天"));
check("client no longer calls an undated value 本周 (real report date shown instead)",
  !clientSrc.includes("本周先看这几套") && !clientSrc.includes("进入本周短名单") && clientSrc.includes("报告日期："));
check("DATA-PLAN documents all five HH1 items with defaults and thresholds",
  dataPlanSrc.includes("HH1.1") && dataPlanSrc.includes("HH1.2") && dataPlanSrc.includes("HH1.3") && dataPlanSrc.includes("HH1.4") && dataPlanSrc.includes("HH1.5")
  && dataPlanSrc.includes("1.18%") && dataPlanSrc.includes("0.20%") && dataPlanSrc.includes("7 天阈值") && dataPlanSrc.includes("listing_user_states"));

// --- mutation sensitivity (real re-execution of mutated production source) ---
const taxMutant = loadDecision(decisionSrc.replace("(input.price * (input.taxRatePct / 100)) / 12", "(input.price * (input.taxRatePct / 100))"));
check("mutation: dropping the /12 on the tax part flips the monthly tax 2360 -> 28320",
  near(taxMutant.monthlyCostBreakdown({ price: 2_400_000, downPaymentPct: 30, annualRatePct: 7.13, taxRatePct: 1.18, insuranceRatePct: 0.2, hoaMonthly: 125 }).propertyTaxMonthly, 28320));
const staleMutant = loadDecision(decisionSrc.replace("nowMs - t > STALE_THRESHOLD_MS", "nowMs - t >= STALE_THRESHOLD_MS"));
check("mutation: weakening the stale boundary to >= flips exactly-7-days from fresh to stale",
  staleMutant.sourceFreshness(new Date(NOW - STALE_THRESHOLD_MS).toISOString(), NOW) === "stale");
const hoaMutant = loadDecision(decisionSrc.replace(
  "totalMonthly: hoaKnown ? subtotalExcludingHoa + (hoaMonthly as number) : null",
  "totalMonthly: subtotalExcludingHoa + (hoaMonthly ?? 0)",
));
check("mutation: totalling an unknown HOA as 0 flips the total from null to a number",
  typeof hoaMutant.monthlyCostBreakdown({ price: 2_400_000, downPaymentPct: 30, annualRatePct: 7.13, taxRatePct: 1.18, insuranceRatePct: 0.2, hoaMonthly: null }).totalMonthly === "number");

console.log(`validate-house-hh1: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
