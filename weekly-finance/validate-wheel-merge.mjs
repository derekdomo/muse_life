// F-DASH-P0-5 wheel 看板八板块并入 validation: drives the REAL
// production pure module (server/src/optionsTab.ts) over a
// fixture that mirrors the wheel artifact's own published
// 2026-11-12 close values (the brief's §二 reconciliation:
// same source data, same date, same metric — both sides must
// agree; the wheel artifact itself is never modified).
// Assertions cover: the eight sections' reachability in the
// options-tab view, the reconciliation identities (captured /
// float on the two expiring contracts, assigned-lot ACB and
// floats, basis premium total, caliber A +514, caliber B
// −12,728, concentration 60,000 + 71,986 = 131,986 = 8.7% of
// 1,514,136 with $246,548 headroom under the 25% cap), the
// concentration cap behaviour, the dual-caliber side-by-side
// rule (B is never just the premium figure), BS Greeks
// anchors, the uniform OTM caliber ((spot − strike) / spot),
// the GEX ladder (walls + own strikes, non-overlapping label
// slots), the management node and the earnings-window gate
// states. Three source mutations are really executed and
// must flip behaviour. Fixture amounts are the wheel board's
// published values used purely as reconciliation targets; no
// account identifiers or personal data appear anywhere.
// Run: bun weekly-finance/validate-wheel-merge.mjs
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = new URL(".", import.meta.url).pathname;
const mod = await import(join(ROOT, "server/src/optionsTab.ts"));
const {
  buildOptionsTabView,
  blackScholesGreeks,
  campaignKeyOf,
  CONCENTRATION_CAP_FRACTION,
  FACTOR_TICKERS,
  ROLL_LIMIT,
  MANAGEMENT_NODE_DTE,
} = mod;

let passed = 0, failed = 0;
function check(name, cond) {
  if (cond) { passed++; } else { failed++; console.log("FAIL:", name); }
}
const approx = (a, b, tol) => typeof a === "number" && Math.abs(a - b) <= tol;

// ---------- the wheel-mirror fixture (2026-11-12 close) ----------
const AS_OF = "2026-11-12";
const qqqPutKey = campaignKeyOf("QQQ", "put", "2026-11-13", 600);
const wheelInput = {
  asOf: AS_OF,
  openOptions: [
    { ticker: "QQQ", type: "put", exp: "2026-11-13", strike: 600, contracts: -1, avgPremium: 3.51, opened: "2026-10-23", account: "synthetic" },
    { ticker: "NVDA", type: "call", exp: "2026-11-13", strike: 220, contracts: -1, avgPremium: 5.4, opened: "2026-10-26", account: "synthetic" },
  ],
  legs: [
    // SPCX $150P x2: buyback takes the $3.86 leg at 10.83,
    // assignment takes the $4.87 leg (wheel ledger, corrected).
    { ticker: "SPCX", type: "put", exp: "2026-11-06", strike: 150, contracts: 1, premium: 3.86, opened: "2026-10-09" },
    { ticker: "SPCX", type: "put", exp: "2026-11-06", strike: 150, contracts: 1, premium: 4.87, opened: "2026-10-16" },
    { ticker: "HOOD", type: "put", exp: "2026-10-16", strike: 115, contracts: 1, premium: 4.0, opened: "2026-09-25" },
    { ticker: "NVDA", type: "put", exp: "2026-10-16", strike: 215, contracts: 1, premium: 3.1, opened: "2026-09-28" },
    { ticker: "NVDA", type: "put", exp: "2026-11-13", strike: 200, contracts: 1, premium: 3.32, opened: "2026-10-23" },
    { ticker: "NVDA", type: "put", exp: "2026-11-13", strike: 200, contracts: 1, premium: 3.52, opened: "2026-10-23" },
    { ticker: "GOOGL", type: "put", exp: "2026-10-16", strike: 330, contracts: 1, premium: 4.95, opened: "2026-09-18" },
    { ticker: "GOOGL", type: "put", exp: "2026-10-23", strike: 330, contracts: 1, premium: 7.6, opened: "2026-10-02" },
    { ticker: "NVDA", type: "put", exp: "2026-10-23", strike: 210, contracts: 2, premium: 2.78, opened: "2026-09-25" },
    { ticker: "GOOGL", type: "put", exp: "2026-11-06", strike: 275, contracts: 1, premium: 1.7, opened: "2026-10-09" },
    { ticker: "QQQ", type: "put", exp: "2026-11-13", strike: 600, contracts: 1, premium: 3.51, opened: "2026-10-23" },
    { ticker: "NVDA", type: "call", exp: "2026-11-13", strike: 220, contracts: 1, premium: 5.4, opened: "2026-10-26" },
  ],
  closes: [
    { ticker: "SPCX", type: "put", exp: "2026-11-06", strike: 150, contracts: 1, kind: "buy_to_close", closed: "2026-10-19", price: 10.83 },
    { ticker: "SPCX", type: "put", exp: "2026-11-06", strike: 150, contracts: 1, kind: "assigned", closed: "2026-11-06", price: null },
    { ticker: "HOOD", type: "put", exp: "2026-10-16", strike: 115, contracts: 1, kind: "assigned", closed: "2026-10-16", price: null },
    { ticker: "NVDA", type: "put", exp: "2026-10-16", strike: 215, contracts: 1, kind: "assigned", closed: "2026-10-16", price: null },
    { ticker: "NVDA", type: "put", exp: "2026-11-13", strike: 200, contracts: 1, kind: "assigned", closed: "2026-11-12", price: null },
    { ticker: "NVDA", type: "put", exp: "2026-11-13", strike: 200, contracts: 1, kind: "assigned", closed: "2026-11-12", price: null },
    { ticker: "GOOGL", type: "put", exp: "2026-10-16", strike: 330, contracts: 1, kind: "expired", closed: "2026-10-16", price: null },
    { ticker: "GOOGL", type: "put", exp: "2026-10-23", strike: 330, contracts: 1, kind: "buy_to_close", closed: "2026-10-23", price: 7.7 },
    { ticker: "NVDA", type: "put", exp: "2026-10-23", strike: 210, contracts: 2, kind: "expired", closed: "2026-10-23", price: null },
    { ticker: "GOOGL", type: "put", exp: "2026-11-06", strike: 275, contracts: 1, kind: "expired", closed: "2026-11-06", price: null },
  ],
  quotes: {
    QQQ: { spot: 688.17, iv: 0.244, rv: 0.367, rv30: 0.309 },
    NVDA: { spot: 166.19, iv: 0.602, rv: 0.54, rv30: 0.468 },
    HOOD: { spot: 81.35, iv: null, rv: null, rv30: null },
    SPCX: { spot: 139.94, iv: null, rv: null, rv30: null },
  },
  earnings: {
    HOOD: { date: "2026-10-27", note: null },
    SPCX: { date: "2026-10-20", note: null },
  },
  gex: {
    hasMeta: true,
    status: "ok",
    sourceDate: "2026-11-12",
    symbols: {
      NVDA: { netGex: -193300000, flip: 173.05, spot: 166.19, callWall: 185, putWall: 160, stale: false },
      QQQ: { netGex: -1490300000, flip: 694.19, spot: 688.17, callWall: 700, putWall: 680, stale: false },
    },
  },
  rollsOverride: {},
  portfolioTotal: 1514136,
  structuredLegs: true,
};
const view = buildOptionsTabView(wheelInput);
const rowOf = (ticker, type) => view.openPositions.find((r) => r.ticker === ticker && r.kindLabel.includes(type));
const qqqPut = view.openPositions.find((r) => r.ticker === "QQQ");
const nvdaCc = view.openPositions.find((r) => r.ticker === "NVDA");

// ---------- (a) action bar: options items only, P0-4 caliber ----------
check("(a) action bar exists with the nearest-expiry fact first (same-day tie breaks by ticker, P0-4 caliber)",
  view.actions.length >= 3 && view.actions[0]?.kind === "expiry"
  && view.actions[0]?.text === "NVDA CC 备兑看涨 · 2026-11-13 到期，剩余 1 天"
  && view.actions[0]?.symbol === "●");
check("(a) action bar carries the blocked-gate fact (QQQ IV−RV, RV20 caliber)",
  view.actions.some((i) => i.kind === "gate" && i.text === "QQQ IV−RV 为负（-12.3 个百分点），门槛未满足"));
check("(a) action bar carries the earnings-lock fact with the verbatim template",
  view.actions.some((i) => i.kind === "earnings" && i.text === "NVDA 财报日 2026-11-17，窗口内不开新 CSP"));
check("(a) action bar holds options kinds only (no review / wash items)",
  view.actions.every((i) => ["expiry", "gate", "earnings"].includes(i.kind)));

// ---------- reconciliation: the two expiring contracts ----------
check("recon: QQQ $600P model price rounds to 0.00 at 1 DTE (wheel: 模型价 $0.00)",
  qqqPut?.modelPrice === 0);
check("recon: QQQ $600P captured = 100% with the >=50% text marker set (wheel: 100% ✓ 已达标）",
  qqqPut?.capturedPct === 1 && qqqPut?.capturedTargetReached === true);
check("recon: QQQ $600P float = +$351 (wheel: 浮盈 +$351)",
  qqqPut?.unrealizedPnl === 351);
check("recon: NVDA $220C captured = 100%, float = +$540 (wheel values)",
  nvdaCc?.capturedPct === 1 && nvdaCc?.unrealizedPnl === 540 && nvdaCc?.capturedTargetReached === true);
check("recon: QQQ put assignment obligation = $60,000 (wheel KPI)",
  qqqPut?.assignmentObligation === 60000 && nvdaCc?.assignmentObligation === 0);
check("recon: OTM uniform caliber (688.17 − 600) / 688.17 = +12.81% (wheel +12.8% at 1dp)",
  qqqPut?.otmPct === 12.81 && qqqPut?.strikeDistancePct === -12.81);

// ---------- (d) Greeks ----------
const gCall = blackScholesGreeks(100, 100, 1, 0.2, "call");
const gPut = blackScholesGreeks(100, 100, 1, 0.2, "put");
check("(d) Greeks anchor: ATM 1y call delta = N(0.3) ≈ 0.6179", approx(gCall?.delta, 0.6179, 0.001));
check("(d) Greeks anchor: put delta = call delta − 1 ≈ −0.3821", approx(gPut?.delta, -0.3821, 0.001));
check("(d) Greeks anchor: call theta/day ≈ −0.01613, vega/pt ≈ 0.3814",
  approx(gCall?.thetaPerDay, -0.01613, 0.0005) && approx(gCall?.vegaPerPoint, 0.3814, 0.001));
check("(d) Greeks are null exactly where the model price falls back to intrinsic",
  blackScholesGreeks(100, 100, 0, 0.2, "put") === null && blackScholesGreeks(100, 100, 1, null, "put") === null);
const greekView = buildOptionsTabView({
  ...wheelInput,
  openOptions: [
    { ticker: "ACME", type: "put", exp: "2026-12-18", strike: 150, contracts: -2, avgPremium: 4.87, opened: "2026-11-01", account: "synthetic" },
  ],
  quotes: { ACME: { spot: 160, iv: 0.32, rv: 0.28, rv30: 0.3 } },
});
const acmeRow = greekView.openPositions[0];
check("(d) position Greeks are side-signed share/dollar totals (short put: delta equivalent > 0, theta > 0, vega < 0)",
  typeof acmeRow?.deltaShares === "number" && acmeRow.deltaShares > 0
  && typeof acmeRow?.thetaPerDay === "number" && acmeRow.thetaPerDay > 0
  && typeof acmeRow?.vegaPerPoint === "number" && acmeRow.vegaPerPoint < 0
  && approx(acmeRow?.deltaShares, (blackScholesGreeks(160, 150, 36 / 365, 0.32, "put")?.delta ?? 0) * -200, 0.011));
check("(d) the wheel-day rows price to ~0 Greeks at 1 DTE deep OTM (wheel: Delta 0 股当量 · Theta +$0)",
  Math.abs(qqqPut?.deltaShares ?? 99) <= 0.5 && Math.abs(qqqPut?.thetaPerDay ?? 99) <= 0.5);
check("(d) portfolio Greeks total the priced rows only, float = 351 + 540 = +891 (wheel)",
  view.portfolioGreeks.available === true && view.portfolioGreeks.pricedContracts === 2
  && view.portfolioGreeks.openContracts === 2 && view.portfolioGreeks.unrealizedPnl === 891);

// ---------- (e) assigned holdings ----------
const lotOf = (ticker, strike) => view.lots.find((l) => l.ticker === ticker && l.strike === strike);
check("(e) five assigned lots (HOOD 1, NVDA 3, SPCX 1 — wheel 接货持仓）",
  view.lots.length === 5 && view.lots.reduce((s, l) => s + l.shares, 0) === 500);
check("(e) ACB identity per lot: HOOD 111.00 / NVDA 211.90 / 196.68 / 196.48 / SPCX 145.13",
  lotOf("HOOD", 115)?.effectiveCost === 111 && lotOf("NVDA", 215)?.effectiveCost === 211.9
  && view.lots.filter((l) => l.ticker === "NVDA" && l.strike === 200).map((l) => l.effectiveCost).sort().join(",") === "196.48,196.68"
  && lotOf("SPCX", 150)?.effectiveCost === 145.13);
check("(e) assigned floats reconcile: HOOD −2,965 / NVDA −4,571 −3,049 −3,029 / SPCX −519",
  lotOf("HOOD", 115)?.unrealizedPnl === -2965 && lotOf("NVDA", 215)?.unrealizedPnl === -4571
  && lotOf("SPCX", 150)?.unrealizedPnl === -519
  && view.lots.filter((l) => l.ticker === "NVDA" && l.strike === 200).reduce((s, l) => s + (l.unrealizedPnl ?? 0), 0) === -6078);
check("(e) CC anchor equals effective cost on every lot",
  view.lots.every((l) => l.ccAnchor === l.effectiveCost));
check("(e) the open $220C covers the earliest NVDA lot (2026-10-16, wheel attributes it to that batch)",
  lotOf("NVDA", 215)?.coveredCalls.length === 1 && lotOf("NVDA", 215)?.coveredCalls[0]?.strike === 220
  && lotOf("NVDA", 215)?.coveredCalls[0]?.shares === 100
  && view.lots.filter((l) => l.ticker === "NVDA" && l.strike === 200).every((l) => l.coveredCalls.length === 0));

// ---------- (f) concentration (factor caliber) ----------
const conc = view.concentration;
check("(f) factor tickers are the wheel set NVDA/HOOD/SPCX/QQQ",
  FACTOR_TICKERS.join("/") === "NVDA/HOOD/SPCX/QQQ" && conc.factorTickers.join("/") === "NVDA/HOOD/SPCX/QQQ");
check("(f) obligation identity: factor put obligation = $60,000 (QQQ only)",
  conc.putObligation === 60000 && conc.putObligationLines.length === 1 && conc.putObligationLines[0]?.ticker === "QQQ");
check("(f) assigned market value = 8,135 + 49,857 + 13,994 = $71,986 (wheel)",
  conc.assignedMarketValue === 71986);
check("(f) exposure identity: 60,000 + 71,986 = 131,986 = 8.7% of 1,514,136 (wheel)",
  conc.exposure === 131986 && conc.exposurePct === 8.7 && conc.portfolioTotal === 1514136);
check("(f) cap identity: 25% cap = $378,534, headroom = $246,548, not over (wheel)",
  conc.capFraction === CONCENTRATION_CAP_FRACTION && conc.capAmount === 378534
  && conc.headroom === 246548 && conc.overLimit === false);
const overView = buildOptionsTabView({ ...wheelInput, portfolioTotal: 200000 });
check("(f) cap behaviour: same exposure over a $200k portfolio reads 66.0% and over-limit with negative headroom",
  overView.concentration.exposurePct === 66 && overView.concentration.overLimit === true
  && overView.concentration.headroom === 50000 - 131986);
const noTotalView = buildOptionsTabView({ ...wheelInput, portfolioTotal: null });
check("(f) missing portfolio total nulls the share, never fabricates a denominator",
  noTotalView.concentration.exposurePct === null && noTotalView.concentration.capAmount === null
  && noTotalView.concentration.exposure === 131986);

// ---------- (g) dual ledger ----------
const ledger = view.dualLedger;
check("(g) caliber A realized = 495 − 697 − 10 + 556 + 170 = +$514 (wheel 口径 A)",
  ledger.caliberA.realizedOptionsPnl === 514 && ledger.caliberA.realizedComplete === true);
check("(g) caliber A lines carry each wheel ledger row's amount",
  ledger.caliberA.realizedLines.length === 5
  && ledger.caliberA.realizedLines.some((l) => l.ticker === "SPCX" && l.amount === -697 && l.outcomeText === "买回平仓")
  && ledger.caliberA.realizedLines.some((l) => l.ticker === "NVDA" && l.amount === 556 && l.outcomeText === "到期作废"));
check("(g) basis premium total = 400 + 310 + 332 + 352 + 487 = $1,881 (wheel), kept out of realized",
  ledger.caliberA.basisPremiumTotal === 1881 && ledger.caliberA.basisLines.length === 5);
check("(g) caliber B identity: 514 − 14,133 + 891 = −$12,728 (wheel 口径 B), side by side with A",
  ledger.caliberB.assignedUnrealized === -14133 && ledger.caliberB.openUnrealizedPut === 351
  && ledger.caliberB.openUnrealizedCall === 540 && ledger.caliberB.openUnrealized === 891
  && ledger.caliberB.total === -12728 && ledger.caliberB.realizedOptionsPnl === ledger.caliberA.realizedOptionsPnl);
check("(g) the two calibers are both present and materially different (premium-only view overstates)",
  ledger.caliberA.realizedOptionsPnl > 0 && (ledger.caliberB.total ?? 0) < 0);
const blindView = buildOptionsTabView({
  ...wheelInput,
  quotes: { ...wheelInput.quotes, HOOD: { spot: null, iv: null, rv: null, rv30: null } },
});
check("(g) a lot without a spot nulls caliber B's total but caliber A still stands (no 0-fill)",
  blindView.dualLedger.caliberB.assignedUnrealized === null && blindView.dualLedger.caliberB.total === null
  && blindView.dualLedger.caliberA.realizedOptionsPnl === 514);

// ---------- (c) vol / edge panel ----------
const volOf = (t) => view.volPanel.find((r) => r.ticker === t);
check("(c) NVDA spread = IV30 60.2 − RV30 46.8 = +13.4pt, positive edge (wheel)",
  volOf("NVDA")?.spreadPp === 13.4 && volOf("NVDA")?.state === "positive" && volOf("NVDA")?.rv20 === 0.54);
check("(c) QQQ spread = 24.4 − 30.9 = −6.5pt, negative edge (wheel)",
  volOf("QQQ")?.spreadPp === -6.5 && volOf("QQQ")?.state === "negative" && volOf("QQQ")?.edgeText.includes("负 edge"));
check("(c) a ticker without IV/RV30 reads unknown, no verdict fabricated",
  volOf("HOOD")?.state === "unknown" && volOf("HOOD")?.spreadPp === null);

// ---------- (h) management nodes + earnings windows ----------
const mgmtOf = (t) => view.management.rows.find((r) => r.ticker === t);
check("(h) management rows cover both open shorts with roll counts against the limit",
  view.management.rows.length === 2 && ROLL_LIMIT === 2 && MANAGEMENT_NODE_DTE === 21
  && mgmtOf("QQQ")?.rollLimit === 2 && mgmtOf("QQQ")?.rolls === 0);
check("(h) QQQ put at 1 DTE has passed the 21-day management node (wheel: 已过 21 天管理节点）",
  mgmtOf("QQQ")?.nodePassed === true && mgmtOf("QQQ")?.nodeText === "✓ 已过 21 天管理节点"
  && mgmtOf("QQQ")?.daysToExpiry === 1 && mgmtOf("QQQ")?.capturedTargetReached === true);
const farView = buildOptionsTabView({
  ...wheelInput,
  openOptions: [{ ticker: "QQQ", type: "put", exp: "2026-12-18", strike: 600, contracts: -1, avgPremium: 3.51, opened: "2026-11-12", account: "synthetic" }],
});
check("(h) a 36-DTE put has not reached the node and says so with its day count",
  farView.management.rows[0]?.nodePassed === false && farView.management.rows[0]?.nodeText.includes("未到 21 天管理节点"));
const winOf = (t) => view.management.earningsWindow.find((r) => r.ticker === t);
check("(h) NVDA earnings 2026-11-17 is 5 days out and 窗口内 with the gate untriggered (+13.4pt)",
  winOf("NVDA")?.state === "inside" && winOf("NVDA")?.daysUntil === 5
  && winOf("NVDA")?.stateText.includes("窗口内") && winOf("NVDA")?.gateText.includes("门槛未触发"));
check("(h) QQQ has no earnings on record and its IV−RV30 gate reads triggered (−6.5pt)",
  winOf("QQQ")?.state === "unrecorded" && winOf("QQQ")?.gateText.includes("门槛触发"));
check("(h) a past earnings date (HOOD 2026-10-27) is never presented as the next one — 未收录 caliber",
  winOf("HOOD")?.state === "unrecorded" && winOf("HOOD")?.date === null);

// ---------- (b) GEX panel + ladder ----------
const gexOf = (t) => view.gex.rows.find((r) => r.ticker === t);
check("(b) NVDA net GEX / flip / walls reconcile with the wheel card",
  gexOf("NVDA")?.netGex === -193300000 && gexOf("NVDA")?.flip === 173.05
  && gexOf("NVDA")?.callWall === 185 && gexOf("NVDA")?.putWall === 160
  && gexOf("NVDA")?.regimeText === "− 负 gamma" && gexOf("NVDA")?.flipDistancePct === -3.96);
check("(b) QQQ ladder marks spot, flip, both walls and the holder's $600 strike",
  (() => {
    const markers = gexOf("QQQ")?.ladder?.markers ?? [];
    const values = markers.map((m) => m.value);
    return [688.17, 694.19, 700, 680, 600].every((v) => values.includes(v))
      && markers.find((m) => m.value === 600)?.kind === "strike"
      && markers.find((m) => m.value === 688.17)?.sub === "现价";
  })());
check("(b) ladder label slots never overlap: same side+tier neighbours stay >= 14% apart",
  (() => {
    for (const row of view.gex.rows) {
      const groups = new Map();
      for (const m of row.ladder?.markers ?? []) {
        const key = `${m.side}:${m.tier}`;
        const list = [...(groups.get(key) ?? []), m.pct].sort((x, y) => x - y);
        groups.set(key, list);
      }
      for (const list of groups.values()) {
        for (let i = 1; i < list.length; i++) {
          if (list[i] - list[i - 1] < 14) return false;
        }
      }
    }
    return true;
  })());
check("(b) a zeroed-OI symbol keeps its ladder hidden (no normal-value display)",
  buildOptionsTabView({
    ...wheelInput,
    gex: { hasMeta: true, status: "ok", sourceDate: AS_OF, symbols: { ACME: { netGex: 0, flip: null, spot: 100, callWall: null, putWall: null, stale: false } } },
  }).gex.rows[0]?.ladder === null);

// ---------- mutations (really executed, must flip) ----------
const moduleSource = readFileSync(join(ROOT, "server/src/optionsTab.ts"), "utf8");
async function mutatedModule(replacements) {
  let src = moduleSource;
  for (const [anchor, replacement] of replacements) {
    if (!src.includes(anchor)) throw new Error(`mutation anchor missing: ${anchor}`);
    src = src.replace(anchor, replacement);
  }
  if (src === moduleSource) throw new Error("mutation did not change the source");
  const dir = mkdtempSync(join(tmpdir(), "wheel-merge-mut-"));
  const file = join(dir, "optionsTab.ts");
  writeFileSync(file, src);
  try {
    return await import(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const m1 = await mutatedModule([["export const CONCENTRATION_CAP_FRACTION = 0.25;", "export const CONCENTRATION_CAP_FRACTION = 0.9;"]]);
check("mutation M1 (cap 25% -> 90%) flips: the $200k-portfolio fixture is no longer over-limit and the cap amount moves",
  m1.buildOptionsTabView({ ...wheelInput, portfolioTotal: 200000 }).concentration.overLimit === false
  && m1.buildOptionsTabView(wheelInput).concentration.capAmount === 1362722.4);
const m2 = await mutatedModule([["round2(realizedOptionsPnl + assignedUnrealized + openUnrealized)", "round2(realizedOptionsPnl - assignedUnrealized + openUnrealized)"]]);
check("mutation M2 (caliber B subtracts the assigned float) flips: total −12,728 -> +15,538",
  m2.buildOptionsTabView(wheelInput).dualLedger.caliberB.total === 15538);
const m3 = await mutatedModule([["((spot - option.strike) / spot) * 100", "((option.strike - spot) / spot) * 100"]]);
check("mutation M3 (OTM numerator flipped) flips: QQQ otmPct +12.81 -> −12.81",
  m3.buildOptionsTabView(wheelInput).openPositions.find((r) => r.ticker === "QQQ")?.otmPct === -12.81);

// ---------- wiring ----------
const actionsSrc = readFileSync(join(ROOT, "server/src/actions.ts"), "utf8");
const tabSrc = readFileSync(join(ROOT, "client/src/OptionsTab.tsx"), "utf8");
const css = readFileSync(join(ROOT, "client/src/theme.css"), "utf8");
check("wiring: getDashboard schema carries every merged section field",
  ["actions: z.array(", "volPanel: z.array(", "portfolioGreeks: z.object(", "concentration: z.object(", "dualLedger: z.object(", "management: z.object("].every((s) => actionsSrc.includes(s)));
check("wiring: adapter reads rv30, the GEX walls and current_total additively",
  actionsSrc.includes('quote["rv30"]') && actionsSrc.includes('symbol["callWall"]')
  && actionsSrc.includes('symbol["putWall"]') && actionsSrc.includes('trading["current_total"]'));
check("wiring: all eight wheel sections are reachable in the tab source",
  ["接下来怎么做", "组合 Greeks 合计", "波动率与 Edge（IV30 / RV30）", "价位标尺", "Covered Call 行权价锚", "集中度 · 因子口径", "双口径记账", "管理节点与财报窗口"].every((t) => tabSrc.includes(t)));
check("wiring: ladder CSS ships both rows and both tiers",
  css.includes(".gex-ladder") && css.includes(".gex-marker--tier1") && css.includes(".gex-marker--below"));
check("wiring: module stays zero-import (validator-gradeable pure functions)",
  !moduleSource.split("\n").some((line) => line.startsWith("import ")));

// ---------- wording scan (no advice language; mandated/factual strings allowlisted) ----------
const ALLOWLIST = ["不构成投资建议", "卖出权利金", "卖出价"];
function wordingHits(src) {
  let cleaned = src;
  for (const allowed of ALLOWLIST) cleaned = cleaned.split(allowed).join("");
  return ["建议", "推荐", "应当", "买入", "卖出"].filter((w) => cleaned.includes(w));
}
check("wording: optionsTab.ts carries no advice language", wordingHits(moduleSource).length === 0);
check("wording: OptionsTab.tsx carries no advice language", wordingHits(tabSrc).length === 0);
check("wording: no META example anywhere in the merged sources",
  !moduleSource.includes("META") && !tabSrc.includes("META"));

console.log(`validate-wheel-merge: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
