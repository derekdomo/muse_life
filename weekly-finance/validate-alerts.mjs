// F2.2 validation: the overview tab's fact-alert section —
// four alert families （数据过期/缺失， 持仓集中度， 现金覆盖
// 变化， 负债变化） derived client-side from getDashboard
// fields only. Every line states a fact; no alert carries
// action wording. Each family judges its own facts
// independently: missing / incomparable / below-threshold
// facts produce NO alert (never 0-filled, never padded).
//
// Behaviour runs against the REAL production derivation
// (deriveFactAlerts) extracted verbatim from
// client/src/App.tsx, plus the production helpers and Intl
// formatters it composes (isRealDateText /
// isValidBalanceDateText / trendIndicator / signedCurrency).
// Wiring assertions run against the real client + theme
// sources. All fixtures are synthetic; no real amount is
// read, and app.db is never touched.
import { readFileSync } from "node:fs";

const appSrc = readFileSync(new URL("./client/src/App.tsx", import.meta.url), "utf8");
const css = readFileSync(new URL("./client/src/theme.css", import.meta.url), "utf8");
let passed = 0, failed = 0;
function check(name, cond) {
  if (cond) { passed++; } else { failed++; console.log("FAIL:", name); }
}

// --- extract the real formatters + helpers from App.tsx ---
function extractConst(src, name) {
  const start = src.indexOf(`const ${name} =`);
  if (start < 0) throw new Error(`const not found: ${name}`);
  const end = src.indexOf("});", start) + 3;
  return src.slice(start, end);
}
function extractFn(src, name) {
  let start = src.indexOf(`export function ${name}`);
  if (start < 0) start = src.indexOf(`\nfunction ${name}`);
  if (start < 0) throw new Error(`helper not found: ${name}`);
  const end = src.indexOf("\n}\n", start) + 3;
  return src.slice(start, end)
    .replace("export function", "function")
    .replaceAll(": FactAlertInput", "")
    .replaceAll(": FactAlert[]", "")
    .replaceAll(": Date | null", "")
    .replaceAll(": string | null | undefined", "")
    .replaceAll(": number | null", "")
    .replaceAll(": string | null", "")
    .replaceAll(": string[]", "")
    .replaceAll(": Date", "")
    .replaceAll(": boolean", "")
    .replaceAll(": string", "")
    .replaceAll(": number", "");
}
function bundleSrc(overrides = {}) {
  const parts = [
    extractConst(appSrc, "currency"),
    extractConst(appSrc, "percent"),
    extractConst(appSrc, "number"),
    extractFn(appSrc, "signedCurrency"),
    extractFn(appSrc, "trendIndicator"),
    extractFn(appSrc, "isRealDateText"),
    extractFn(appSrc, "isValidBalanceDateText"),
    extractFn(appSrc, "deriveFactAlerts"),
  ];
  let text = parts.join("\n");
  for (const [from, to] of Object.entries(overrides)) {
    if (!text.includes(from)) throw new Error(`mutation anchor not found: ${from}`);
    text = text.replace(from, to);
  }
  return text;
}
function loadDeriver(overrides) {
  return new Function(`${bundleSrc(overrides)}; return { deriveFactAlerts };`)();
}
const { deriveFactAlerts } = loadDeriver();

const BANNED = ["建议", "推荐", "应当", "买入", "卖出", "减仓", "加仓"];

// A fresh, unremarkable dashboard: snapshot 3 days old, bank
// balance dated inside the source month, previous month
// present, no holding above threshold, loans flat, previous
// coverage absent (the production construction).
function baseInput(overrides = {}) {
  return {
    asOf: "2026-10-30",
    today: "2026-11-02",
    sourceMonth: "2026-10-31",
    months: [
      { key: "2026-08-31", snapshotDate: "2026-08-31", loans: 500000 },
      { key: "2026-09-30", snapshotDate: "2026-09-30", loans: 500000 },
      { key: "2026-10-31", snapshotDate: "2026-10-31", loans: 500000 },
    ],
    bankAccounts: [{ source: "bank_main", balanceDate: "2026-10-15" }],
    holdingsAll: [{ ticker: "AAA", name: "Aaa Corp", share: 0.1 }],
    coverageMonths: 6,
    previousCoverageMonths: null,
    ...overrides,
  };
}
const kinds = (alerts) => alerts.map((alert) => alert.kind);

// --- fresh state: nothing fires ---
check("fresh dashboard: zero alerts (stale families stay hidden when sources are fresh)",
  deriveFactAlerts(baseInput()).length === 0);

// --- 1a. snapshot staleness (> 7 days, weekly cadence) ---
const staleSnap = deriveFactAlerts(baseInput({ asOf: "2026-10-20" }));
check("stale snapshot: fires once, naming the data date and the exact age in days",
  staleSnap.length === 1 && staleSnap[0].kind === "stale" && staleSnap[0].label === "数据过期"
  && staleSnap[0].text.includes("2026-10-20") && staleSnap[0].text.includes("距今 13 天"));
check("stale snapshot: symbol rides with the text (never colour alone)", staleSnap[0].symbol === "▲");
check("stale snapshot boundary: exactly 7 days old does NOT fire",
  !kinds(deriveFactAlerts(baseInput({ asOf: "2026-10-26" }))).includes("stale"));
check("stale snapshot boundary: 8 days old fires",
  kinds(deriveFactAlerts(baseInput({ asOf: "2026-10-25" }))).includes("stale"));
check("stale snapshot: an ISO asOf is read by its date part",
  kinds(deriveFactAlerts(baseInput({ asOf: "2026-10-20T07:39:00-07:00" }))).includes("stale"));
check("stale snapshot: missing/invalid asOf is not evidence — no alert, no fabricated age",
  deriveFactAlerts(baseInput({ asOf: null })).length === 0
  && deriveFactAlerts(baseInput({ asOf: "not-a-date" })).length === 0);

// --- 1b. bank staleness (F1.1 month rule mirrored) ---
const staleBank = deriveFactAlerts(baseInput({
  bankAccounts: [
    { source: "bank_old", balanceDate: "2026-08-31" },
    { source: "bank_new", balanceDate: "2026-10-02" },
  ],
}));
const bankAlert = staleBank.find((alert) => alert.text.startsWith("银行余额"));
check("stale bank: fires naming the stale source, its balance date and its age",
  !!bankAlert && bankAlert.text.includes("bank_old") && bankAlert.text.includes("2026-08-31") && bankAlert.text.includes("距今 63 天"));
check("stale bank: the fresh source in the same list is NOT named",
  !!bankAlert && !bankAlert.text.includes("bank_new"));
check("stale bank: a YYYY-MM balance date is judged by its month end",
  deriveFactAlerts(baseInput({ bankAccounts: [{ source: "bank_m", balanceDate: "2026-08" }] }))
    .some((alert) => alert.text.includes("bank_m") && alert.text.includes("距今 63 天")));
check("stale bank: same-month and source-month dates do not fire",
  deriveFactAlerts(baseInput({ bankAccounts: [{ source: "b", balanceDate: "2026-10-01" }] })).length === 0);
check("stale bank: invalid or missing balance dates are not evidence (no alert, no age invented)",
  deriveFactAlerts(baseInput({ bankAccounts: [{ source: "b1", balanceDate: "2026-13-40" }, { source: "b2", balanceDate: null }] })).length === 0);

// --- 1c. previous full month missing ---
const missingMonth = deriveFactAlerts(baseInput({
  months: [
    { key: "2026-08-31", snapshotDate: "2026-08-31", loans: 500000 },
    { key: "2026-09-30", snapshotDate: "2026-09-30", loans: 500000 },
  ],
}));
check("missing month: fires naming the missing previous full month",
  missingMonth.some((alert) => alert.label === "数据缺失" && alert.text.includes("2026-10") && alert.text.includes("缺失")));
check("missing month: no months at all stays silent (nothing to judge against)",
  deriveFactAlerts(baseInput({ months: [] })).length === 0);

// --- 2. concentration (F2.3 caliber, threshold strictly above 25%) ---
const conc = deriveFactAlerts(baseInput({
  holdingsAll: [
    { ticker: "BBB", name: "Bbb Corp", share: 0.3 },
    { ticker: "AAA", name: "Aaa Corp", share: 0.4 },
    { ticker: "CCC", name: "Ccc Corp", share: 0.25 },
    { ticker: "DDD", name: "Ddd Corp", share: 0.05 },
  ],
}));
check("concentration: only holdings strictly above 25% fire (25% exactly does not)",
  conc.length === 2 && conc.every((alert) => alert.kind === "concentration"));
check("concentration: largest first, share stated as a fact with the F2.3 caliber named",
  conc[0].text.includes("AAA") && conc[0].text.includes("40%") && conc[0].text.includes("F2.3 口径")
  && conc[0].text.includes("同 ticker 已合并") && conc[1].text.includes("BBB") && conc[1].text.includes("30%"));
check("concentration: symbol + label ride with the number", conc[0].symbol === "●" && conc[0].label === "持仓集中度");

// --- 3. cash-coverage change (F1.1 caliber) ---
const covUp = deriveFactAlerts(baseInput({ coverageMonths: 6.5, previousCoverageMonths: 5 }));
check("coverage change: fires with both figures, direction word, glyph and signed diff",
  covUp.length === 1 && covUp[0].kind === "coverage" && covUp[0].symbol === "▲"
  && covUp[0].text.includes("由上次 5 个月变为当前 6.5 个月") && covUp[0].text.includes("增加 ▲ +1.5 个月"));
check("coverage change: the interval is stated honestly (previous date unretained, current data date named)",
  covUp[0].text.includes("上次快照日期未留存") && covUp[0].text.includes("本次数据日期 2026-10-30") && covUp[0].text.includes("F1.1 口径"));
const covDown = deriveFactAlerts(baseInput({ coverageMonths: 5, previousCoverageMonths: 6.5 }));
check("coverage decrease: ▼ with a signed negative diff",
  covDown.length === 1 && covDown[0].symbol === "▼" && covDown[0].text.includes("减少 ▼ -1.5 个月"));
check("coverage change: below 0.5 months does not fire; exactly 0.5 fires",
  deriveFactAlerts(baseInput({ coverageMonths: 5.4, previousCoverageMonths: 5 })).length === 0
  && deriveFactAlerts(baseInput({ coverageMonths: 5.5, previousCoverageMonths: 5 })).length === 1);
check("coverage change: previous figure absent (the production construction) stays silent — no invented delta",
  deriveFactAlerts(baseInput({ coverageMonths: 6.5, previousCoverageMonths: null })).length === 0);
check("coverage change: current figure missing stays silent too",
  deriveFactAlerts(baseInput({ coverageMonths: null, previousCoverageMonths: 5 })).length === 0);

// --- 4. liability change (adjacent recorded months) ---
const liabDown = deriveFactAlerts(baseInput({
  months: [
    { key: "2026-09-30", snapshotDate: "2026-09-30", loans: 500000 },
    { key: "2026-10-31", snapshotDate: "2026-10-31", loans: 400000 },
  ],
}));
check("liability change: fires with both balances, signed delta, percent and the dated interval",
  liabDown.length === 1 && liabDown[0].kind === "liabilities" && liabDown[0].symbol === "▼"
  && liabDown[0].text.includes("$500,000") && liabDown[0].text.includes("$400,000")
  && liabDown[0].text.includes("减少 ▼ -$100,000") && liabDown[0].text.includes("-20%")
  && liabDown[0].text.includes("2026-09-30 至 2026-10-31"));
const liabUp = deriveFactAlerts(baseInput({
  months: [
    { key: "2026-09-30", snapshotDate: "2026-09-30", loans: 400000 },
    { key: "2026-10-31", snapshotDate: "2026-10-31", loans: 500000 },
  ],
}));
check("liability increase: ▲ with +$100,000 and +25%",
  liabUp.length === 1 && liabUp[0].symbol === "▲" && liabUp[0].text.includes("增加 ▲ +$100,000") && liabUp[0].text.includes("+25%"));
check("liability change: ordinary amortisation (1% relative) does not fire",
  deriveFactAlerts(baseInput({
    months: [
      { key: "2026-09-30", snapshotDate: "2026-09-30", loans: 500000 },
      { key: "2026-10-31", snapshotDate: "2026-10-31", loans: 495000 },
    ],
  })).length === 0);
check("liability change: a 5% move under $1,000 does not fire (absolute gate)",
  deriveFactAlerts(baseInput({
    months: [
      { key: "2026-09-30", snapshotDate: "2026-09-30", loans: 10000 },
      { key: "2026-10-31", snapshotDate: "2026-10-31", loans: 9500 },
    ],
  })).length === 0);
check("liability change: a null balance month is skipped, never read as 0",
  deriveFactAlerts(baseInput({
    months: [
      { key: "2026-09-30", snapshotDate: "2026-09-30", loans: null },
      { key: "2026-10-31", snapshotDate: "2026-10-31", loans: 400000 },
    ],
  })).length === 0);
check("liability change: a zero earlier balance cannot ground a percent — no alert",
  deriveFactAlerts(baseInput({
    months: [
      { key: "2026-09-30", snapshotDate: "2026-09-30", loans: 0 },
      { key: "2026-10-31", snapshotDate: "2026-10-31", loans: 50000 },
    ],
  })).length === 0);

// --- independence: families never borrow each other's facts ---
check("independence: concentration alone fires alone (all other facts fresh/absent)",
  kinds(deriveFactAlerts(baseInput({ holdingsAll: [{ ticker: "AAA", name: "Aaa", share: 0.5 }] }))).join() === "concentration");
check("independence: every family incomparable at once yields an empty section",
  deriveFactAlerts(baseInput({ asOf: null, sourceMonth: "", months: [], bankAccounts: [], holdingsAll: [], coverageMonths: null })).length === 0);

// --- wording: a maximally-firing fixture produces only fact lines ---
const rich = deriveFactAlerts(baseInput({
  asOf: "2026-10-01",
  bankAccounts: [{ source: "bank_old", balanceDate: "2026-07-31" }],
  months: [
    { key: "2026-08-31", snapshotDate: "2026-08-31", loans: 500000 },
    { key: "2026-09-30", snapshotDate: "2026-09-30", loans: 400000 },
  ],
  holdingsAll: [{ ticker: "AAA", name: "Aaa Corp", share: 0.62 }],
  coverageMonths: 4,
  previousCoverageMonths: 6.5,
}));
check("rich fixture: all four families fire (stale ×2 sources + missing month + concentration + coverage + liabilities)",
  rich.length === 6 && kinds(rich).filter((k) => k === "stale").length === 3);
check("wording: no alert text or label carries any action wording",
  rich.every((alert) => !BANNED.some((word) => alert.text.includes(word) || alert.label.includes(word))));
check("wording: every alert carries a symbol, a label and a non-empty fact text",
  rich.every((alert) => alert.symbol.length > 0 && alert.label.length > 0 && alert.text.length > 0));

// --- mutation sensitivity: real flips of production logic ---
const mutantConc = loadDeriver({ "holding.share > 0.25": "holding.share > 0.9" });
check("mutation M1: raising the concentration threshold to 0.9 silences the 40% fixture (assertion would fail)",
  mutantConc.deriveFactAlerts(baseInput({ holdingsAll: [{ ticker: "AAA", name: "Aaa", share: 0.4 }] })).length === 0);
const mutantStale = loadDeriver({ "ageDays > 7": "ageDays > 700" });
check("mutation M2: raising the staleness line to 700 days silences the 13-day fixture (assertion would fail)",
  mutantStale.deriveFactAlerts(baseInput({ asOf: "2026-10-20" })).length === 0);
const mutantLiab = loadDeriver({ "Math.abs(delta) / prevLoans >= 0.05": "Math.abs(delta) / prevLoans >= 0.9" });
check("mutation M3: raising the liability relative gate to 0.9 silences the −20% fixture (assertion would fail)",
  mutantLiab.deriveFactAlerts(baseInput({
    months: [
      { key: "2026-09-30", snapshotDate: "2026-09-30", loans: 500000 },
      { key: "2026-10-31", snapshotDate: "2026-10-31", loans: 400000 },
    ],
  })).length === 0);
const mutantCov = loadDeriver({ "Math.abs(diff) >= 0.5": "Math.abs(diff) >= 5" });
check("mutation M4: raising the coverage gate to 5 months silences the +1.5 fixture (assertion would fail)",
  mutantCov.deriveFactAlerts(baseInput({ coverageMonths: 6.5, previousCoverageMonths: 5 })).length === 0);

// --- wiring (real sources) ---
check("wiring: deriveFactAlerts is exported from App.tsx", appSrc.includes("export function deriveFactAlerts"));
const sectionStart = appSrc.indexOf("function FactAlertsSection");
const sectionSrc = appSrc.slice(sectionStart, appSrc.indexOf("\n}\n", sectionStart) + 3);
check("wiring: the section consumes only getDashboard fields (asOf / sourceMonth / months / bank rows / holdingsAll)",
  sectionSrc.includes("data.asOf") && sectionSrc.includes("data.sourceMonth") && sectionSrc.includes("data.months")
  && sectionSrc.includes('account.type === "account"') && sectionSrc.includes("data.holdingsAll"));
check("wiring: previous coverage is null by construction (payload carries no such fact)",
  sectionSrc.includes("previousCoverageMonths: null"));
check("wiring: an empty alert set renders nothing (fresh state needs no box)",
  sectionSrc.includes("if (alerts.length === 0) return null"));
const overviewStart = appSrc.indexOf("function OverviewTab");
const overviewSrc = appSrc.slice(overviewStart, appSrc.indexOf("\nfunction ", overviewStart + 10));
check("wiring: the section sits under the F2.1 strip and above the conclusion card, exactly once",
  overviewSrc.indexOf("<TopSummaryCards") > -1
  && overviewSrc.indexOf("<TopSummaryCards") < overviewSrc.indexOf("<FactAlertsSection")
  && overviewSrc.indexOf("<FactAlertsSection") < overviewSrc.indexOf("<TotalAssetsConclusionCard")
  && (appSrc.split("<FactAlertsSection").length - 1) === 1);
const f22Start = appSrc.indexOf("// F2.2: fact alerts");
const f22Src = appSrc.slice(f22Start, sectionStart + sectionSrc.length);
check("wording: the whole F2.2 code slice carries no action wording",
  !BANNED.some((word) => f22Src.includes(word)));
check("wiring: drift red line — F2.2 code never references the two frozen modules' fields",
  !f22Src.includes("recurringCharges") && !f22Src.includes("cashFlowForecast"));
check("wiring: theme carries the section styles with 44px heading and row heights (touch rhythm)",
  css.includes(".fact-alerts")
  && css.slice(css.indexOf(".fact-alerts__heading"), css.indexOf(".fact-alerts__heading") + 200).includes("min-height: 44px")
  && css.slice(css.indexOf(".fact-alert {"), css.indexOf(".fact-alert {") + 300).includes("min-height: 44px"));

console.log(`validate-alerts: ${passed}/${passed + failed} passed`);
process.exit(failed ? 1 : 0);
