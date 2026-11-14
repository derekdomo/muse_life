// F-DASH-P0-3 「期权」页签 validation: drives the REAL production
// pure module (server/src/optionsTab.ts — zero imports, every
// export exercised below) over fully synthetic fixtures:
// Black-Scholes anchors + put-call parity, open-position model
// rows, campaign grouping, FIFO leg pairing, assigned-lot ACB
// (the brief's worked two-leg case: buyback closes the $3.86
// leg first, assignment takes the $4.87 leg -> effective cost
// $145.13), covered-call attachment, the IV−RV gate, the
// earnings lock, the 90-day timeline and the GEX freshness
// states. Wiring assertions cover the getDashboard additive
// field, the fifth tab and the CSS. Three source mutations are
// really executed and must flip behaviour. No real financial
// data: every ticker amount below is synthetic except the
// brief's own worked ACB example numbers.
// Run: bun weekly-finance/validate-options-tab.mjs
import { readFileSync, readdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = new URL(".", import.meta.url).pathname;
const mod = await import(join(ROOT, "server/src/optionsTab.ts"));
const {
  buildOptionsTabView,
  buildOpenPositionRows,
  buildCampaigns,
  buildIvRvGates,
  buildGexPanel,
  pairLegsFifo,
  blackScholesPrice,
  campaignKeyOf,
  resolveEarnings,
  OPTIONS_TAB_DISCLAIMER,
  OPTIONS_ACB_DISCLAIMER,
  OPTIONS_MARKET_NOTE,
  OPTIONS_MODEL_INPUT_MISSING_NOTE,
  ROLLS_OVERRIDE,
} = mod;

let passed = 0, failed = 0;
function check(name, cond) {
  if (cond) { passed++; } else { failed++; console.log("FAIL:", name); }
}
const approx = (a, b, tol) => typeof a === "number" && Math.abs(a - b) <= tol;

const AS_OF = "2026-11-14";
const baseInput = (extra = {}) => ({
  asOf: AS_OF,
  openOptions: [],
  legs: [],
  closes: [],
  quotes: {},
  earnings: {},
  gex: null,
  rollsOverride: {},
  structuredLegs: true,
  ...extra,
});

// ---------- Black-Scholes anchors ----------
const bsCall = blackScholesPrice(100, 100, 1, 0.2, "call");
const bsPut = blackScholesPrice(100, 100, 1, 0.2, "put");
check("BS anchor: ATM 1y call at r=4% σ=20% ≈ 9.93", approx(bsCall, 9.93, 0.05));
check("BS anchor: ATM 1y put ≈ 6.01", approx(bsPut, 6.01, 0.05));
check("BS parity: call − put ≈ S − K·e^(−rT) ≈ 3.92", approx(bsCall - bsPut, 3.92, 0.05));
check("BS expiry fallback: ITM put at expiry = intrinsic 10",
  blackScholesPrice(140, 150, 0, 0.3, "put") === 10);
check("BS missing-IV fallback: intrinsic, never a fabricated vol price",
  blackScholesPrice(140, 150, 0.5, null, "put") === 10);
check("BS unusable spot -> null", blackScholesPrice(null, 150, 0.5, 0.3, "put") === null);

// ---------- open position rows ----------
const openInput = baseInput({
  openOptions: [
    { ticker: "ACME", type: "put", exp: "2026-12-18", strike: 150, contracts: -2, avgPremium: 4.87, opened: "2026-10-27", account: "synthetic" },
    { ticker: "BETA", type: "call", exp: "2026-12-18", strike: 80, contracts: 1, avgPremium: 2.0, opened: "2026-11-01", account: "synthetic" },
    { ticker: "GAMMA", type: "put", exp: "2027-03-19", strike: 50, contracts: -1, avgPremium: 1.2, opened: "2026-11-10", account: "synthetic" },
  ],
  quotes: {
    ACME: { spot: 160, iv: 0.32, rv: 0.28 },
    BETA: { spot: 75, iv: 0.3, rv: 0.35 },
  },
});
const rows = buildOpenPositionRows(openInput);
const acme = rows.find((r) => r.ticker === "ACME");
const beta = rows.find((r) => r.ticker === "BETA");
const gamma = rows.find((r) => r.ticker === "GAMMA");
check("open row: short put classifies as CSP", acme?.kind === "CSP" && acme?.side === "short" && acme?.contracts === 2);
check("open row: days to expiry 2026-11-14 -> 2026-12-18 = 34", acme?.daysToExpiry === 34);
check("open row: strike distance (150/160 − 1) = −6.25%", acme?.strikeDistancePct === -6.25);
check("open row: model price is a real BS value in (1.5, 3)", typeof acme?.modelPrice === "number" && acme.modelPrice > 1.5 && acme.modelPrice < 3);
check("open row: captured = 1 − model/premium within (0.4, 0.7)",
  typeof acme?.capturedPct === "number" && acme.capturedPct > 0.4 && acme.capturedPct < 0.7
  && approx(acme.capturedPct, 1 - acme.modelPrice / 4.87, 0.0011));
check("open row: unrealized = (premium − model) × contracts × 100",
  approx(acme?.unrealizedPnl, (4.87 - acme.modelPrice) * 200, 0.011));
check("open row: market note states 市价不可用，模型估算", acme?.dataNote === OPTIONS_MARKET_NOTE && acme?.modelNote === "模型估算非市价");
check("open row: long call has no captured% (buyer caliber)", beta?.kind === "LONG_CALL" && beta?.capturedPct === null);
check("open row: long unrealized = (model − premium) × 100",
  approx(beta?.unrealizedPnl, (beta.modelPrice - 2.0) * 100, 0.011));
check("open row: missing quote -> model null + honest note, distance null",
  gamma?.modelPrice === null && gamma?.strikeDistancePct === null && gamma?.dataNote === OPTIONS_MODEL_INPUT_MISSING_NOTE);

// ---------- FIFO pairing + ACB (the brief's worked case) ----------
const spcxKey = campaignKeyOf("SPCX", "put", "2026-11-06", 150);
const spcxLegs = [
  { ticker: "SPCX", type: "put", exp: "2026-11-06", strike: 150, contracts: 1, premium: 3.86, opened: "2026-10-20" },
  { ticker: "SPCX", type: "put", exp: "2026-11-06", strike: 150, contracts: 1, premium: 4.87, opened: "2026-10-27" },
];
const spcxCloses = [
  { ticker: "SPCX", type: "put", exp: "2026-11-06", strike: 150, contracts: 1, kind: "buy_to_close", closed: "2026-11-02", price: 1.2 },
  { ticker: "SPCX", type: "put", exp: "2026-11-06", strike: 150, contracts: 1, kind: "assigned", closed: "2026-11-06", price: null },
];
const portions = pairLegsFifo(spcxLegs, spcxCloses);
check("FIFO: buyback consumes the earliest leg ($3.86) first",
  portions[0]?.premium === 3.86 && portions[0]?.outcome === "bought_back");
check("FIFO: buyback realized = (3.86 − 1.20) × 100 = 266", portions[0]?.realized === 266);
check("FIFO: assignment takes the remaining $4.87 leg",
  portions[1]?.premium === 4.87 && portions[1]?.outcome === "assigned" && portions[1]?.realized === null);

const spcxInput = baseInput({ legs: spcxLegs, closes: spcxCloses, rollsOverride: { [spcxKey]: 2 } });
const { campaigns: spcxCampaigns, lots: spcxLots } = buildCampaigns(spcxInput);
const spcxCampaign = spcxCampaigns.find((c) => c.key === spcxKey);
check("campaign: exactly one chain for the key", spcxCampaigns.length === 1 && !!spcxCampaign);
check("campaign: status 已指派 with 1 assigned / 1 closed / 0 open",
  spcxCampaign?.status === "assigned" && spcxCampaign?.statusText === "已指派"
  && spcxCampaign?.assignedContracts === 1 && spcxCampaign?.closedContracts === 1 && spcxCampaign?.openContracts === 0);
check("campaign: gross premium = (3.86 + 4.87) × 100 = 873", spcxCampaign?.grossPremiumReceived === 873);
check("campaign: realized premium counts the buyback only = 266 (assignment premium lives in ACB)",
  spcxCampaign?.realizedPremium === 266 && spcxCampaign?.realizedComplete === true);
check("campaign: rolls come from the manual override (2, 人工维护）",
  spcxCampaign?.rolls === 2 && spcxCampaign?.rollsSource === "人工维护");
check("campaign: rolls default to 0 without an override",
  buildCampaigns(baseInput({ legs: spcxLegs, closes: spcxCloses })).campaigns[0]?.rolls === 0);
check("ACB lot: 100 shares at effective cost 150 − 4.87 = 145.13 exactly",
  spcxLots.length === 1 && spcxLots[0]?.shares === 100 && spcxLots[0]?.premiumPerShare === 4.87 && spcxLots[0]?.effectiveCost === 145.13);
check("ACB lot: assigned date + campaign link recorded",
  spcxLots[0]?.assignedDate === "2026-11-06" && spcxLots[0]?.campaignKey === spcxKey && spcxCampaign?.lotIds.length === 1);

// ---------- campaign grouping + partial splits + unknown prices ----------
const twoKeys = buildCampaigns(baseInput({
  legs: [
    { ticker: "ACME", type: "put", exp: "2026-12-18", strike: 150, contracts: 3, premium: 2.0, opened: "2026-11-01" },
    { ticker: "ACME", type: "put", exp: "2026-12-18", strike: 140, contracts: 1, premium: 1.0, opened: "2026-11-01" },
  ],
  closes: [
    { ticker: "ACME", type: "put", exp: "2026-12-18", strike: 150, contracts: 1, kind: "buy_to_close", closed: "2026-11-10", price: 0.5 },
  ],
}));
check("grouping: different strikes stay separate chains", twoKeys.campaigns.length === 2);
const split = twoKeys.campaigns.find((c) => c.strike === 150);
check("partial split: 1 of 3 bought back -> still 进行中 with 2 open",
  split?.status === "open" && split?.openContracts === 2 && split?.closedContracts === 1 && split?.realizedPremium === 150);
const unknownPrice = buildCampaigns(baseInput({
  legs: [{ ticker: "ACME", type: "put", exp: "2026-12-18", strike: 150, contracts: 1, premium: 2.0, opened: "2026-11-01" }],
  closes: [{ ticker: "ACME", type: "put", exp: "2026-12-18", strike: 150, contracts: 1, kind: "buy_to_close", closed: "2026-11-10", price: null }],
}));
check("unknown buyback price -> realized marked incomplete, never fabricated",
  unknownPrice.campaigns[0]?.realizedComplete === false && unknownPrice.campaigns[0]?.realizedPremium === 0
  && unknownPrice.campaigns[0]?.status === "closed" && unknownPrice.campaigns[0]?.statusText === "已平仓");
const expiredChain = buildCampaigns(baseInput({
  legs: [{ ticker: "ACME", type: "put", exp: "2026-11-13", strike: 150, contracts: 2, premium: 1.5, opened: "2026-10-16" }],
  closes: [{ ticker: "ACME", type: "put", exp: "2026-11-13", strike: 150, contracts: 2, kind: "expired", closed: "2026-11-13", price: null }],
}));
check("expired chain: full premium realized, status 已平仓",
  expiredChain.campaigns[0]?.realizedPremium === 300 && expiredChain.campaigns[0]?.status === "closed");

// ---------- covered-call attachment ----------
const ccInput = baseInput({
  legs: [
    ...spcxLegs,
    { ticker: "SPCX", type: "call", exp: "2026-12-18", strike: 160, contracts: 1, premium: 1.5, opened: "2026-11-10" },
  ],
  closes: [
    ...spcxCloses,
    { ticker: "SPCX", type: "call", exp: "2026-12-18", strike: 160, contracts: 1, kind: "expired", closed: "2026-12-18", price: null },
  ],
});
const ccResult = buildCampaigns(ccInput);
check("CC attachment: call key folds into the put campaign (no standalone chain)",
  ccResult.campaigns.length === 1 && ccResult.campaigns[0]?.coveredCallKeys.length === 1);
check("CC attachment: lot CC premium total = 1.50 × 100 = 150",
  ccResult.lots[0]?.ccPremiumTotal === 150 && ccResult.lots[0]?.ccPremiumKnown === true);
const standaloneCc = buildCampaigns(baseInput({
  legs: [{ ticker: "BETA", type: "call", exp: "2026-12-18", strike: 80, contracts: 1, premium: 1.1, opened: "2026-11-05" }],
}));
check("standalone CC (no assigned lot) stays its own CC chain",
  standaloneCc.campaigns.length === 1 && standaloneCc.campaigns[0]?.kindLabel === "CC" && standaloneCc.lots.length === 0);

// ---------- IV−RV gate ----------
const gates = buildIvRvGates(openInput);
const gateOf = (t) => gates.find((g) => g.ticker === t);
check("gate: spread +4.0pp -> ● 门槛满足",
  gateOf("ACME")?.state === "met" && gateOf("ACME")?.spreadPp === 4 && gateOf("ACME")?.symbol === "●" && gateOf("ACME")?.text === "门槛满足");
check("gate: spread −5.0pp -> ○ blocked with the exact mandated text",
  gateOf("BETA")?.state === "blocked" && gateOf("BETA")?.spreadPp === -5 && gateOf("BETA")?.symbol === "○"
  && gateOf("BETA")?.text === "IV−RV 为负，门槛未满足，不开新仓");
check("gate: no IV/RV -> unknown, no verdict fabricated",
  gateOf("GAMMA")?.state === "unknown" && gateOf("GAMMA")?.spreadPp === null && gateOf("GAMMA")?.text === "IV / RV 未收录，门槛无法判定");

// ---------- earnings + lock ----------
check("earnings: brief fallback NVDA 2026-11-17, 3 days out, locked, Kress note",
  (() => { const e = resolveEarnings(baseInput(), "NVDA"); return e?.date === "2026-11-17" && e?.daysUntil === 3 && e?.locked === true && (e?.note ?? "").includes("Colette Kress"); })());
check("earnings: fallback never presents a past date as next",
  resolveEarnings(baseInput({ asOf: "2026-12-01" }), "NVDA") === null);
check("earnings: source entry wins; 17 days out is outside the 14-day lock",
  (() => { const e = resolveEarnings(baseInput({ earnings: { ACME: { date: "2026-12-01", note: null } } }), "ACME"); return e?.daysUntil === 17 && e?.locked === false; })());
check("earnings: 6 days out is locked",
  resolveEarnings(baseInput({ earnings: { ACME: { date: "2026-11-20", note: null } } }), "ACME")?.locked === true);
check("earnings: past source date resolves to 未收录 (null)",
  resolveEarnings(baseInput({ earnings: { ACME: { date: "2026-11-01", note: null } } }), "ACME") === null);
check("earnings: unrecorded ticker resolves to null", resolveEarnings(baseInput(), "ACME") === null);

// ---------- timeline ----------
const timelineView = buildOptionsTabView(baseInput({
  openOptions: [
    { ticker: "ACME", type: "put", exp: "2026-12-18", strike: 150, contracts: -1, avgPremium: 4.87, opened: "2026-10-27", account: "synthetic" },
    { ticker: "GAMMA", type: "put", exp: "2027-03-19", strike: 50, contracts: -1, avgPremium: 1.2, opened: "2026-11-10", account: "synthetic" },
    { ticker: "NVDA", type: "put", exp: "2026-12-18", strike: 150, contracts: -1, avgPremium: 5.0, opened: "2026-11-02", account: "synthetic" },
  ],
  quotes: { ACME: { spot: 160, iv: 0.32, rv: 0.28 } },
}));
check("timeline: NVDA earnings (11-17) sorts before the 12-18 expiries",
  timelineView.timeline[0]?.kind === "earnings" && timelineView.timeline[0]?.date === "2026-11-17" && timelineView.timeline[0]?.locked === true);
check("timeline: expiry beyond 90 days is excluded",
  !timelineView.timeline.some((i) => i.date === "2027-03-19") && timelineView.timeline.filter((i) => i.kind === "expiry").length === 2);
check("assembly: disclaimer + ACB disclaimer are the mandated verbatim strings",
  timelineView.disclaimer === "期权数据为模型估算与账本口径，仅供参考，不构成投资建议；税务口径以券商 1099-B 为准。"
  && timelineView.acbDisclaimer === "wheel 有效成本 ≠ 券商成本基础（券商口径含洗售递延等调整，以 1099-B 为准）"
  && OPTIONS_TAB_DISCLAIMER === timelineView.disclaimer && OPTIONS_ACB_DISCLAIMER === timelineView.acbDisclaimer);
check("assembly: ROLLS_OVERRIDE ships empty (counts default to 0, 人工维护）",
  Object.keys(ROLLS_OVERRIDE).length === 0);

// ---------- GEX freshness ----------
check("GEX: no payload -> unavailable, no fake rows",
  (() => { const g = buildGexPanel(baseInput()); return g.state === "unavailable" && g.bannerText === "GEX 数据暂不可用" && g.rows.length === 0; })());
check("GEX: _meta status=unavailable -> unavailable even with symbols present",
  buildGexPanel(baseInput({ gex: { hasMeta: true, status: "unavailable", sourceDate: "2026-11-14", symbols: { ACME: { netGex: 5, flip: 100, spot: 101, stale: false } } } })).state === "unavailable");
check("GEX: legacy schema without _meta -> 新鲜度未核实， rows still shown",
  (() => { const g = buildGexPanel(baseInput({ gex: { hasMeta: false, status: null, sourceDate: null, symbols: { ACME: { netGex: 5, flip: 100, spot: 101, stale: false } } } })); return g.state === "unverified" && g.bannerText === "新鲜度未核实" && g.rows.length === 1; })());
check("GEX: _meta stale -> banner names the source date",
  (() => { const g = buildGexPanel(baseInput({ gex: { hasMeta: true, status: "stale", sourceDate: "2026-11-10", symbols: {} } })); return g.state === "stale" && g.bannerText === "数据已过期（来源日期 2026-11-10），仅供参考"; })());
check("GEX: one stale symbol marks the whole panel stale",
  buildGexPanel(baseInput({ gex: { hasMeta: true, status: "ok", sourceDate: "2026-11-14", symbols: { ACME: { netGex: 5, flip: 100, spot: 101, stale: true } } } })).state === "stale");
check("GEX: fresh row math — flip distance (160/155 − 1) = +3.23%",
  (() => { const g = buildGexPanel(baseInput({ gex: { hasMeta: true, status: "ok", sourceDate: "2026-11-14", symbols: { ACME: { netGex: 1200000, flip: 155, spot: 160, stale: false } } } })); return g.state === "fresh" && g.rows[0]?.flipDistancePct === 3.23 && g.rows[0]?.dataState === "ok"; })());
check("GEX: zeroed OI state (net 0, no flip) is not shown as a normal value",
  (() => { const g = buildGexPanel(baseInput({ gex: { hasMeta: true, status: "ok", sourceDate: "2026-11-14", symbols: { ACME: { netGex: 0, flip: null, spot: 160, stale: false } } } })); return g.rows[0]?.dataState === "zeroed" && g.rows[0]?.dataText.includes("清零"); })());

// ---------- mutations (really executed, must flip) ----------
const moduleSource = readFileSync(join(ROOT, "server/src/optionsTab.ts"), "utf8");
async function mutatedModule(replacements) {
  let src = moduleSource;
  for (const [anchor, replacement] of replacements) {
    if (!src.includes(anchor)) throw new Error(`mutation anchor missing: ${anchor}`);
    src = src.replace(anchor, replacement);
  }
  if (src === moduleSource) throw new Error("mutation did not change the source");
  const dir = mkdtempSync(join(tmpdir(), "options-tab-mut-"));
  const file = join(dir, "optionsTab.ts");
  writeFileSync(file, src);
  try {
    return await import(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const m1 = await mutatedModule([["effectiveCost: round2(first.strike - portion.premium)", "effectiveCost: round2(first.strike + portion.premium)"]]);
check("mutation M1 (ACB strike − premium -> strike + premium) flips: lot cost 145.13 -> 154.87",
  m1.buildCampaigns(spcxInput).lots[0]?.effectiveCost === 154.87);
const m2 = await mutatedModule([["a.leg.opened < b.leg.opened", "a.leg.opened > b.leg.opened"]]);
check("mutation M2 (FIFO order reversed) flips: assignment takes the $3.86 leg, ACB 145.13 -> 146.14",
  m2.buildCampaigns(spcxInput).lots[0]?.effectiveCost === 146.14 && m2.buildCampaigns(spcxInput).lots[0]?.premiumPerShare === 3.86);
const m3 = await mutatedModule([["spreadPp < 0 ? \"blocked\" : \"met\"", "spreadPp > 0 ? \"blocked\" : \"met\""]]);
check("mutation M3 (gate comparison flipped) flips: ACME met -> blocked, BETA blocked -> met",
  m3.buildIvRvGates(openInput).find((g) => g.ticker === "ACME")?.state === "blocked"
  && m3.buildIvRvGates(openInput).find((g) => g.ticker === "BETA")?.state === "met");

// ---------- wiring ----------
const actionsSrc = readFileSync(join(ROOT, "server/src/actions.ts"), "utf8");
const appSrc = readFileSync(join(ROOT, "client/src/App.tsx"), "utf8");
const tabSrc = readFileSync(join(ROOT, "client/src/OptionsTab.tsx"), "utf8");
const css = readFileSync(join(ROOT, "client/src/theme.css"), "utf8");
check("module: zero imports (pure, validator-gradeable)",
  !moduleSource.split("\n").some((line) => line.startsWith("import ")));
check("wiring: getDashboard gains the additive optionsTab field (schema + guest null + adapter)",
  actionsSrc.includes("optionsTab: optionsTabSchema.nullable().optional()")
  && actionsSrc.includes("buildOptionsTabViewFromTrading")
  && actionsSrc.includes("optionsTab: null,"));
check("wiring: fifth tab 期权 sits after 交易 and renders OptionsTab",
  appSrc.indexOf(">交易</button>") >= 0 && appSrc.indexOf(">期权</button>") > appSrc.indexOf(">交易</button>")
  && appSrc.includes('activeTab === "options"') && appSrc.includes("OptionsTab"));
check("wiring: tab renders the server disclaimer + lock badge + six sections",
  tabSrc.includes("view.disclaimer")
  && tabSrc.includes("财报锁：不开新 CSP")
  && ["未平仓期权", "Campaign 策略链", "接货批与有效成本（ACB）", "到期与财报时间线（未来 90 天）", "IV − RV 门槛", "GEX 面板"].every((t) => tabSrc.includes(t)));
check("wiring: CSS keeps 44px rows + blocked-gate dimming",
  css.includes(".options-row { min-height: 44px; }") && css.includes(".options-gate--blocked"));
check("wiring: no new migration beyond 0010 (additive field only)",
  readdirSync(join(ROOT, "drizzle")).filter((f) => f.endsWith(".sql")).every((f) => f.slice(0, 4) <= "0010"));

// ---------- wording scan (no advice language; mandated/factual strings allowlisted) ----------
const ALLOWLIST = ["不构成投资建议", "卖出权利金", "卖出价"];
function wordingHits(src) {
  let cleaned = src;
  for (const allowed of ALLOWLIST) cleaned = cleaned.split(allowed).join("");
  const hits = [];
  for (const word of ["建议", "推荐", "应当", "买入", "卖出"]) {
    if (cleaned.includes(word)) hits.push(word);
  }
  return hits;
}
check("wording: optionsTab.ts carries no advice language", wordingHits(moduleSource).length === 0);
check("wording: OptionsTab.tsx carries no advice language", wordingHits(tabSrc).length === 0);
check("wording: no META example anywhere in the new sources",
  !moduleSource.includes("META") && !tabSrc.includes("META"));

console.log(`validate-options-tab: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
