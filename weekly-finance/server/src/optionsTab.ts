// F-DASH-P0-3 「期权」页签 (fifth tab): the server-side pure
// computation layer. ZERO imports, every declaration exported,
// no side effects — the repo validator (weekly-finance/
// validate-options-tab.mjs) drives these exact functions over
// synthetic fixtures. getDashboard assembles the input from the
// stored trading dataset (see buildOptionsTabViewFromTrading in
// actions.ts) and ships the finished view as its additive
// `optionsTab` field; the client renders it verbatim and never
// recomputes a figure.
//
// Calibers (all stated on the page itself):
// - Model prices are Black-Scholes estimates from spot + IV
//   (risk-free rate BS_RISK_FREE_RATE, no dividends). Contract
//   market prices are never available to this artifact, so every
//   row is labelled model-only; no bid/ask/OI is ever invented.
// - captured% = 1 − modelPrice / sell premium (model caliber).
// - Campaign chains are keyed by ticker + type + expiry +
//   strike (the push contract carries no campaign_id; the
//   derivation rule is recorded in DATA-PLAN.md F-DASH-P0-3).
// - Buy-to-close consumes the EARLIEST opened legs first
//   (FIFO); assignment takes the legs that remain.
// - An assigned lot's wheel effective cost = strike − the
//   assigned leg's sell premium. That is a ledger caliber, NOT
//   the broker's cost basis (see OPTIONS_ACB_DISCLAIMER).

export const OPTIONS_TAB_DISCLAIMER =
  "期权数据为模型估算与账本口径，仅供参考，不构成投资建议；税务口径以券商 1099-B 为准。";

export const OPTIONS_ACB_DISCLAIMER =
  "wheel 有效成本 ≠ 券商成本基础（券商口径含洗售递延等调整，以 1099-B 为准）";

export const OPTIONS_MARKET_NOTE = "市价不可用，模型估算";
export const OPTIONS_MODEL_NOTE = "模型估算非市价";
export const OPTIONS_MODEL_INPUT_MISSING_NOTE = "现价 / IV 未收录，模型价不可用";

// Black-Scholes model parameters: a flat 4% risk-free rate and
// no dividend yield — an approximation, labelled as such.
export const BS_RISK_FREE_RATE = 0.04;

// A ticker whose next earnings fall within this many days
// (today included) carries the earnings-lock badge.
export const EARNINGS_LOCK_WINDOW_DAYS = 14;

// The timeline lists expiries and earnings inside this horizon.
export const TIMELINE_HORIZON_DAYS = 90;

// Manual roll counts, keyed by campaign key (see
// campaignKeyOf). Maintained by hand in this file; a key with
// no entry has 0 rolls and the page labels the count 人工维护.
export const ROLLS_OVERRIDE: Readonly<Record<string, number>> = {};

// Earnings facts supplied directly by the feature brief when
// the events source carries no entry for the ticker. An entry
// whose date has passed is never presented as the next
// earnings — the ticker then reads 未收录 like any other.
export const KNOWN_EARNINGS_FALLBACK: Readonly<
  Record<string, { date: string; note: string }>
> = {
  NVDA: {
    date: "2026-11-17",
    note: "盘后 · 临时 CEO Colette Kress 首次主持电话会",
  },
};

/* --------------------- F-DASH-P0-5 wheel merge ------------------------- */
// The eight wheel-dashboard sections merged into this tab.
// Calibers added here (recorded in DATA-PLAN.md F-DASH-P0-5):
// - OTM % is uniform across the new sections:
//   (spot − strike) / spot × 100, signed. The pre-existing
//   strikeDistancePct field keeps its F-DASH-P0-3 caliber and
//   is not redefined.
// - captured % reaching this fraction earns the text marker
//   「✓ 已达 50% 线」 (symbol + text, never colour alone).
export const CAPTURED_TARGET_FRACTION = 0.5;
// Strategy v2 roll discipline: one position may roll at most
// this many times (the wheel board's 「Roll N / 2 次」).
export const ROLL_LIMIT = 2;
// Strategy v2 management node: a short position is reviewed
// once its remaining life is at or under this many days
// (the 21-DTE management point).
export const MANAGEMENT_NODE_DTE = 21;
// Factor concentration cap: the factor tickers below are one
// high-beta growth factor; their combined exposure (open put
// assignment obligation + assigned holdings market value)
// must stay at or under this fraction of the portfolio.
export const CONCENTRATION_CAP_FRACTION = 0.25;
export const FACTOR_TICKERS: readonly string[] = ["NVDA", "HOOD", "SPCX", "QQQ"];
// The options-tab action bar mirrors the F-DASH-P0-4 overview
// bar's first three item kinds (nearest expiry, IV−RV gate,
// earnings lock) with the same verbatim templates, capped the
// same way; overview-only kinds (review queue, wash-sale
// window) never appear here.
export const OPTIONS_ACTION_LIMIT = 5;

/* ------------------------------- inputs -------------------------------- */

export type OptionsTabOptionType = "put" | "call";

export interface OptionsTabOpenOptionInput {
  ticker: string;
  type: OptionsTabOptionType;
  exp: string; // YYYY-MM-DD
  strike: number;
  contracts: number; // signed: negative = short (sold)
  avgPremium: number; // per-share gross trade price
  opened: string; // YYYY-MM-DD
  account: string;
}

// One sell-to-open lot. A contract sold in two fills at two
// prices is two legs; FIFO pairing depends on that split.
export interface OptionsTabLegInput {
  ticker: string;
  type: OptionsTabOptionType;
  exp: string;
  strike: number;
  contracts: number; // positive count sold in this lot
  premium: number; // per-share sell premium (gross)
  opened: string; // YYYY-MM-DD — FIFO order key
}

export type OptionsTabCloseKind =
  | "buy_to_close"
  | "assigned"
  | "expired"
  | "exercised"
  | "sell_to_close"
  | "other";

export interface OptionsTabCloseInput {
  ticker: string;
  type: OptionsTabOptionType;
  exp: string;
  strike: number;
  contracts: number; // positive count this event closes
  kind: OptionsTabCloseKind;
  closed: string; // YYYY-MM-DD
  price: number | null; // per-share close price (buyback), null when unrecorded
}

export interface OptionsTabQuoteInput {
  spot: number | null;
  iv: number | null; // implied volatility, decimal (0.32 = 32%) — IV30 caliber
  rv: number | null; // 20-day realized volatility, decimal
  rv30: number | null; // 30-day realized volatility, decimal (F-DASH-P0-5)
}

export interface OptionsTabEarningsInput {
  date: string; // YYYY-MM-DD
  note: string | null;
}

export interface OptionsTabGexSymbolInput {
  netGex: number | null;
  flip: number | null;
  spot: number | null;
  callWall: number | null; // F-DASH-P0-5: largest call-OI strike
  putWall: number | null; // F-DASH-P0-5: largest put-OI strike
  stale: boolean;
}

// The gex_result health header, normalized by the adapter:
// hasMeta=false marks the legacy schema without _meta.
export interface OptionsTabGexInput {
  hasMeta: boolean;
  status: string | null; // e.g. "ok" / "stale" / "unavailable"
  sourceDate: string | null;
  symbols: Record<string, OptionsTabGexSymbolInput>;
}

export interface OptionsTabInput {
  asOf: string; // YYYY-MM-DD — the trading dataset's generated date
  openOptions: OptionsTabOpenOptionInput[];
  legs: OptionsTabLegInput[];
  closes: OptionsTabCloseInput[];
  quotes: Record<string, OptionsTabQuoteInput>;
  earnings: Record<string, OptionsTabEarningsInput>;
  gex: OptionsTabGexInput | null;
  rollsOverride: Record<string, number>;
  // F-DASH-P0-5: the trading dataset's own total market value
  // (current_total) — the concentration section's denominator.
  // Null when the push carries none; the section then states
  // the gap instead of inventing a denominator.
  portfolioTotal: number | null;
  // True when the push carried structured leg/close history;
  // false means campaigns are built from open lots only and
  // historical assignment lots are not recorded yet.
  structuredLegs: boolean;
}

/* ------------------------------ date utils ----------------------------- */

export function isRealDateText(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

// Whole days from `from` to `to` (to − from); NaN-safe: an
// invalid input yields 0 rather than a fabricated span — callers
// gate on isRealDateText before presenting the number.
export function daysBetweenDates(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.round((b - a) / 86400000);
}

export function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

export function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

export function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}

export function finiteOrNull(value: number): number | null {
  return Number.isFinite(value) ? value : null;
}

/* ---------------------------- Black-Scholes ---------------------------- */

// Standard normal CDF (Abramowitz–Stegun 7.1.26 erf form via
// the 26.2.17 polynomial; |error| < 1e-7).
export function normCdf(x: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const poly =
    t *
    (0.31938153 +
      t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  const density = Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
  const p = 1 - density * poly;
  return x >= 0 ? p : 1 - p;
}

// Black-Scholes price per share. Falls back to intrinsic value
// at/past expiry or when IV is not positive (the σ→0 limit).
// Returns null when spot/strike are not usable numbers.
export function blackScholesPrice(
  spot: number | null,
  strike: number,
  yearsToExpiry: number,
  iv: number | null,
  type: OptionsTabOptionType,
): number | null {
  if (spot == null || !Number.isFinite(spot) || spot <= 0) return null;
  if (!Number.isFinite(strike) || strike <= 0) return null;
  const intrinsic =
    type === "call" ? Math.max(spot - strike, 0) : Math.max(strike - spot, 0);
  if (!(yearsToExpiry > 0) || iv == null || !Number.isFinite(iv) || iv <= 0) {
    return round2(intrinsic);
  }
  const sqrtT = Math.sqrt(yearsToExpiry);
  const d1 =
    (Math.log(spot / strike) +
      (BS_RISK_FREE_RATE + 0.5 * iv * iv) * yearsToExpiry) /
    (iv * sqrtT);
  const d2 = d1 - iv * sqrtT;
  const discountedStrike = strike * Math.exp(-BS_RISK_FREE_RATE * yearsToExpiry);
  const price =
    type === "call"
      ? spot * normCdf(d1) - discountedStrike * normCdf(d2)
      : discountedStrike * normCdf(-d2) - spot * normCdf(-d1);
  return finiteOrNull(round2(price));
}

export function normPdf(x: number): number {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}

export interface OptionsTabGreeks {
  delta: number; // per share
  thetaPerDay: number; // per share, per calendar day
  vegaPerPoint: number; // per share, per +1 percentage point of IV
}

// Black-Scholes Greeks under the same model caliber as
// blackScholesPrice (flat 4% rate, no dividends). Null under
// exactly the conditions where the model price falls back to
// intrinsic value — Greeks of a pure intrinsic value are not
// meaningful and are never fabricated.
export function blackScholesGreeks(
  spot: number | null,
  strike: number,
  yearsToExpiry: number,
  iv: number | null,
  type: OptionsTabOptionType,
): OptionsTabGreeks | null {
  if (spot == null || !Number.isFinite(spot) || spot <= 0) return null;
  if (!Number.isFinite(strike) || strike <= 0) return null;
  if (!(yearsToExpiry > 0) || iv == null || !Number.isFinite(iv) || iv <= 0) {
    return null;
  }
  const sqrtT = Math.sqrt(yearsToExpiry);
  const d1 =
    (Math.log(spot / strike) +
      (BS_RISK_FREE_RATE + 0.5 * iv * iv) * yearsToExpiry) /
    (iv * sqrtT);
  const d2 = d1 - iv * sqrtT;
  const pdf = normPdf(d1);
  const discount = Math.exp(-BS_RISK_FREE_RATE * yearsToExpiry);
  const delta = type === "call" ? normCdf(d1) : normCdf(d1) - 1;
  const thetaYear =
    type === "call"
      ? -(spot * pdf * iv) / (2 * sqrtT) -
        BS_RISK_FREE_RATE * strike * discount * normCdf(d2)
      : -(spot * pdf * iv) / (2 * sqrtT) +
        BS_RISK_FREE_RATE * strike * discount * normCdf(-d2);
  const deltaRounded = finiteOrNull(round4(delta));
  const thetaRounded = finiteOrNull(round4(thetaYear / 365));
  const vegaRounded = finiteOrNull(round4((spot * pdf * sqrtT) / 100));
  if (deltaRounded == null || thetaRounded == null || vegaRounded == null) {
    return null;
  }
  return { delta: deltaRounded, thetaPerDay: thetaRounded, vegaPerPoint: vegaRounded };
}

/* ------------------------------ campaigns ------------------------------ */

export function campaignKeyOf(
  ticker: string,
  type: OptionsTabOptionType,
  exp: string,
  strike: number,
): string {
  return `${ticker}|${type}|${exp}|${strike}`;
}

export type OptionsTabPortionOutcome =
  | "open"
  | "bought_back"
  | "expired"
  | "assigned"
  | "exercised"
  | "closed_other";

export interface OptionsTabPortion {
  premium: number; // the leg's per-share sell premium
  opened: string;
  contracts: number;
  outcome: OptionsTabPortionOutcome;
  closeKind: OptionsTabCloseKind | null;
  closedDate: string | null;
  closePrice: number | null;
  // Realized premium for this portion in dollars. Null for
  // still-open portions and for assigned portions (their
  // premium lives inside the lot's effective cost, never
  // double-counted here); null with outcome bought_back /
  // closed_other means the close price was not recorded.
  realized: number | null;
}

// FIFO pairing for ONE contract key: closes consume the
// earliest-opened remaining leg quantity first. Legs and
// closes are consumed in date order (stable for ties).
export function pairLegsFifo(
  legs: readonly OptionsTabLegInput[],
  closes: readonly OptionsTabCloseInput[],
): OptionsTabPortion[] {
  const sortedLegs = legs
    .map((leg, index) => ({ leg, index }))
    .sort((a, b) =>
      a.leg.opened === b.leg.opened
        ? a.index - b.index
        : a.leg.opened < b.leg.opened
          ? -1
          : 1,
    );
  const sortedCloses = closes
    .map((close, index) => ({ close, index }))
    .sort((a, b) =>
      a.close.closed === b.close.closed
        ? a.index - b.index
        : a.close.closed < b.close.closed
          ? -1
          : 1,
    );
  const remaining = sortedLegs.map(({ leg }) => ({
    premium: leg.premium,
    opened: leg.opened,
    left: leg.contracts,
  }));
  const portions: OptionsTabPortion[] = [];
  const push = (
    head: { premium: number; opened: string },
    contracts: number,
    outcome: OptionsTabPortionOutcome,
    close: OptionsTabCloseInput | null,
  ) => {
    let realized: number | null = null;
    if (close) {
      if (close.kind === "expired" || close.kind === "exercised") {
        realized = round2(head.premium * contracts * 100);
      } else if (close.kind === "assigned") {
        realized = null; // premium is inside the lot's ACB
      } else if (close.price != null && Number.isFinite(close.price)) {
        realized = round2((head.premium - close.price) * contracts * 100);
      }
    }
    portions.push({
      premium: head.premium,
      opened: head.opened,
      contracts,
      outcome,
      closeKind: close?.kind ?? null,
      closedDate: close?.closed ?? null,
      closePrice: close?.price ?? null,
      realized,
    });
  };
  for (const { close } of sortedCloses) {
    let toClose = close.contracts;
    while (toClose > 0) {
      const head = remaining.find((entry) => entry.left > 0);
      if (!head) break;
      const take = Math.min(head.left, toClose);
      head.left -= take;
      toClose -= take;
      const outcome: OptionsTabPortionOutcome =
        close.kind === "buy_to_close" || close.kind === "sell_to_close"
          ? "bought_back"
          : close.kind === "assigned"
            ? "assigned"
            : close.kind === "expired"
              ? "expired"
              : close.kind === "exercised"
                ? "exercised"
                : "closed_other";
      push(head, take, outcome, close);
    }
  }
  for (const entry of remaining) {
    if (entry.left > 0) push(entry, entry.left, "open", null);
  }
  return portions;
}

/* ------------------------------ view types ----------------------------- */

export interface OptionsTabOpenPositionView {
  key: string;
  ticker: string;
  kind: "CSP" | "CC" | "LONG_PUT" | "LONG_CALL";
  kindLabel: string;
  side: "short" | "long";
  exp: string;
  strike: number;
  contracts: number; // absolute count
  premium: number; // per-share gross trade price
  opened: string;
  account: string;
  daysToExpiry: number;
  spot: number | null;
  iv: number | null;
  strikeDistancePct: number | null; // (strike / spot − 1) × 100, signed
  // F-DASH-P0-5: the wheel board's uniform OTM caliber,
  // (spot − strike) / spot × 100, signed (a short put above
  // zero is out of the money). Kept beside — never replacing —
  // the F-DASH-P0-3 field above.
  otmPct: number | null;
  modelPrice: number | null;
  modelNote: string;
  capturedPct: number | null; // fraction; short positions only
  capturedTargetReached: boolean; // capturedPct >= 50% (text marker)
  unrealizedPnl: number | null;
  // F-DASH-P0-5 Greeks, position totals under the BS model
  // caliber (signed by side: a short put's delta equivalent
  // is positive). Null when the model inputs are missing.
  deltaShares: number | null; // delta × signed contracts × 100
  thetaPerDay: number | null; // $ per day, signed by side
  vegaPerPoint: number | null; // $ per +1pt IV, signed by side
  assignmentObligation: number; // short puts: strike × contracts × 100
  dataNote: string;
  earningsDate: string | null;
  earningsLocked: boolean;
}

export interface OptionsTabLotView {
  id: string;
  campaignKey: string;
  ticker: string;
  strike: number;
  exp: string;
  shares: number;
  premiumPerShare: number;
  effectiveCost: number; // strike − premiumPerShare (wheel ledger caliber)
  assignedDate: string;
  ccPremiumTotal: number; // covered-call premium collected against this lot
  ccPremiumKnown: boolean;
  calledAway: boolean;
  statusText: string;
  // F-DASH-P0-5 assigned-holdings fields, filled by
  // enrichAssignedLots (buildCampaigns itself has no quotes):
  // the ticker's close-caliber spot, the lot's market value
  // and its float against the wheel effective cost.
  spot: number | null;
  marketValue: number | null; // spot × shares
  unrealizedPnl: number | null; // (spot − effectiveCost) × shares
  unrealizedPct: number | null; // unrealizedPnl / (effectiveCost × shares) × 100
  ccAnchor: number; // covered-call strike anchor = effectiveCost
  coveredCalls: { strike: number; exp: string; contracts: number; shares: number }[];
}

export interface OptionsTabCampaignView {
  key: string;
  ticker: string;
  type: OptionsTabOptionType;
  kindLabel: string; // CSP / CC
  exp: string;
  strike: number;
  rolls: number;
  rollsSource: string; // 人工维护
  openedContracts: number;
  openContracts: number;
  assignedContracts: number;
  closedContracts: number;
  grossPremiumReceived: number;
  realizedPremium: number; // sum over portions whose realized is known
  realizedComplete: boolean;
  status: "open" | "assigned" | "closed";
  statusText: string;
  lotIds: string[];
  coveredCallKeys: string[];
}

export interface OptionsTabTimelineItemView {
  date: string;
  kind: "expiry" | "earnings";
  ticker: string;
  text: string;
  note: string | null;
  locked: boolean;
}

export interface OptionsTabEarningsView {
  ticker: string;
  date: string;
  note: string | null;
  daysUntil: number;
  locked: boolean;
}

export interface OptionsTabGateView {
  ticker: string;
  iv: number | null;
  rv: number | null;
  spreadPp: number | null; // (IV − RV) in percentage points
  state: "met" | "blocked" | "unknown";
  symbol: string;
  text: string;
  earningsDate: string | null;
  earningsLocked: boolean;
}

export interface OptionsTabGexLadderMarker {
  value: number;
  pct: number; // 0–100 position along the ladder scale
  side: "above" | "below";
  tier: 0 | 1; // 1 = pushed to the far row to avoid label overlap
  kind: "spot" | "flip" | "callWall" | "putWall" | "strike";
  label: string;
  sub: string;
}

export interface OptionsTabGexLadderView {
  min: number;
  max: number;
  markers: OptionsTabGexLadderMarker[];
}

export interface OptionsTabGexRowView {
  ticker: string;
  netGex: number | null;
  flip: number | null;
  spot: number | null;
  flipDistancePct: number | null; // (spot / flip − 1) × 100, signed
  // F-DASH-P0-5: gamma regime as text (never colour alone),
  // the two walls, and the price ladder marking spot, flip,
  // both walls and every open option strike of the ticker.
  regimeText: string | null;
  callWall: number | null;
  putWall: number | null;
  ladder: OptionsTabGexLadderView | null;
  stale: boolean;
  dataState: "ok" | "zeroed";
  dataText: string;
}

export interface OptionsTabGexView {
  state: "fresh" | "stale" | "unavailable" | "unverified";
  bannerText: string;
  sourceDate: string | null;
  rows: OptionsTabGexRowView[];
}

export interface OptionsTabView {
  asOf: string;
  disclaimer: string;
  structuredLegs: boolean;
  openPositions: OptionsTabOpenPositionView[];
  campaigns: OptionsTabCampaignView[];
  lots: OptionsTabLotView[];
  acbDisclaimer: string;
  timeline: OptionsTabTimelineItemView[];
  earnings: OptionsTabEarningsView[];
  gates: OptionsTabGateView[];
  gex: OptionsTabGexView;
  // F-DASH-P0-5 wheel-merge sections (all additive):
  actions: OptionsTabActionItemView[];
  volPanel: OptionsTabVolRowView[];
  portfolioGreeks: OptionsTabPortfolioGreeksView;
  concentration: OptionsTabConcentrationView;
  dualLedger: OptionsTabDualLedgerView;
  management: OptionsTabManagementView;
}

/* ------------------------------ earnings ------------------------------- */

// The ticker's next earnings: the events-source entry wins; the
// brief-supplied fallback applies only when the source has no
// entry. A date before asOf is never "next" — it resolves to
// null and the ticker reads 未收录.
export function resolveEarnings(
  input: OptionsTabInput,
  ticker: string,
): OptionsTabEarningsView | null {
  const fromSource = input.earnings[ticker];
  const candidate =
    fromSource && isRealDateText(fromSource.date)
      ? { date: fromSource.date, note: fromSource.note }
      : (KNOWN_EARNINGS_FALLBACK[ticker] ?? null);
  if (!candidate || !isRealDateText(candidate.date)) return null;
  if (!isRealDateText(input.asOf)) return null;
  const daysUntil = daysBetweenDates(input.asOf, candidate.date);
  if (daysUntil < 0) return null;
  return {
    ticker,
    date: candidate.date,
    note: candidate.note,
    daysUntil,
    locked: daysUntil <= EARNINGS_LOCK_WINDOW_DAYS,
  };
}

/* --------------------------- open positions ---------------------------- */

export function buildOpenPositionRows(
  input: OptionsTabInput,
): OptionsTabOpenPositionView[] {
  const rows: OptionsTabOpenPositionView[] = [];
  for (const option of input.openOptions) {
    const key = campaignKeyOf(option.ticker, option.type, option.exp, option.strike);
    const short = option.contracts < 0;
    const contracts = Math.abs(option.contracts);
    const kind: OptionsTabOpenPositionView["kind"] = short
      ? option.type === "put"
        ? "CSP"
        : "CC"
      : option.type === "put"
        ? "LONG_PUT"
        : "LONG_CALL";
    const kindLabel =
      kind === "CSP"
        ? "CSP 现金担保看跌"
        : kind === "CC"
          ? "CC 备兑看涨"
          : kind === "LONG_PUT"
            ? "多头看跌 Put"
            : "多头看涨 Call";
    const daysToExpiry = isRealDateText(input.asOf) && isRealDateText(option.exp)
      ? daysBetweenDates(input.asOf, option.exp)
      : 0;
    const quote = input.quotes[option.ticker] ?? { spot: null, iv: null, rv: null, rv30: null };
    const spot = quote.spot;
    const iv = quote.iv;
    const strikeDistancePct =
      spot != null && Number.isFinite(spot) && spot > 0
        ? finiteOrNull(round2((option.strike / spot - 1) * 100))
        : null;
    const otmPct =
      spot != null && Number.isFinite(spot) && spot > 0
        ? finiteOrNull(round2(((spot - option.strike) / spot) * 100))
        : null;
    const modelPrice = blackScholesPrice(
      spot,
      option.strike,
      daysToExpiry / 365,
      iv,
      option.type,
    );
    const modelReady = spot != null && iv != null && modelPrice != null;
    const capturedPct =
      short && modelPrice != null && option.avgPremium > 0
        ? finiteOrNull(round4(1 - modelPrice / option.avgPremium))
        : null;
    const unrealizedPnl =
      modelPrice != null
        ? finiteOrNull(
            round2(
              (short
                ? option.avgPremium - modelPrice
                : modelPrice - option.avgPremium) *
                contracts *
                100,
            ),
          )
        : null;
    const greeks = blackScholesGreeks(
      spot,
      option.strike,
      daysToExpiry / 365,
      iv,
      option.type,
    );
    const signedContracts = short ? -contracts : contracts;
    const deltaShares = greeks
      ? finiteOrNull(round2(greeks.delta * signedContracts * 100))
      : null;
    const thetaPerDay = greeks
      ? finiteOrNull(round2(greeks.thetaPerDay * signedContracts * 100))
      : null;
    const vegaPerPoint = greeks
      ? finiteOrNull(round2(greeks.vegaPerPoint * signedContracts * 100))
      : null;
    const earnings = resolveEarnings(input, option.ticker);
    rows.push({
      key,
      ticker: option.ticker,
      kind,
      kindLabel,
      side: short ? "short" : "long",
      exp: option.exp,
      strike: option.strike,
      contracts,
      premium: option.avgPremium,
      opened: option.opened,
      account: option.account,
      daysToExpiry,
      spot,
      iv,
      strikeDistancePct,
      otmPct,
      modelPrice,
      modelNote: OPTIONS_MODEL_NOTE,
      capturedPct,
      capturedTargetReached: capturedPct != null && capturedPct >= CAPTURED_TARGET_FRACTION,
      unrealizedPnl,
      deltaShares,
      thetaPerDay,
      vegaPerPoint,
      assignmentObligation:
        short && option.type === "put" ? round2(option.strike * contracts * 100) : 0,
      dataNote: modelReady ? OPTIONS_MARKET_NOTE : OPTIONS_MODEL_INPUT_MISSING_NOTE,
      earningsDate: earnings?.date ?? null,
      earningsLocked: earnings?.locked ?? false,
    });
  }
  rows.sort((a, b) =>
    a.exp === b.exp
      ? a.ticker === b.ticker
        ? a.strike - b.strike
        : a.ticker < b.ticker
          ? -1
          : 1
      : a.exp < b.exp
        ? -1
        : 1,
  );
  return rows;
}

/* ----------------------------- campaigns ------------------------------- */

export function buildCampaigns(input: OptionsTabInput): {
  campaigns: OptionsTabCampaignView[];
  lots: OptionsTabLotView[];
} {
  const legsByKey = new Map<string, OptionsTabLegInput[]>();
  for (const leg of input.legs) {
    const key = campaignKeyOf(leg.ticker, leg.type, leg.exp, leg.strike);
    legsByKey.set(key, [...(legsByKey.get(key) ?? []), leg]);
  }
  const closesByKey = new Map<string, OptionsTabCloseInput[]>();
  for (const close of input.closes) {
    const key = campaignKeyOf(close.ticker, close.type, close.exp, close.strike);
    closesByKey.set(key, [...(closesByKey.get(key) ?? []), close]);
  }
  const keys = new Set<string>([...legsByKey.keys(), ...closesByKey.keys()]);

  const lots: OptionsTabLotView[] = [];
  const portionsByKey = new Map<string, OptionsTabPortion[]>();
  for (const key of keys) {
    portionsByKey.set(
      key,
      pairLegsFifo(legsByKey.get(key) ?? [], closesByKey.get(key) ?? []),
    );
  }

  // Assigned put portions become lots first; covered-call keys
  // then attach to the earliest lot of the same ticker that was
  // assigned on or before the call leg opened.
  for (const key of keys) {
    const legs = legsByKey.get(key) ?? [];
    const first = legs[0];
    if (!first || first.type !== "put") continue;
    for (const portion of portionsByKey.get(key) ?? []) {
      if (portion.outcome !== "assigned") continue;
      lots.push({
        id: `${key}#${portion.closedDate ?? ""}#${portion.premium}`,
        campaignKey: key,
        ticker: first.ticker,
        strike: first.strike,
        exp: first.exp,
        shares: portion.contracts * 100,
        premiumPerShare: portion.premium,
        effectiveCost: round2(first.strike - portion.premium),
        assignedDate: portion.closedDate ?? "",
        ccPremiumTotal: 0,
        ccPremiumKnown: true,
        calledAway: false,
        statusText: "持有中",
        spot: null,
        marketValue: null,
        unrealizedPnl: null,
        unrealizedPct: null,
        ccAnchor: round2(first.strike - portion.premium),
        coveredCalls: [],
      });
    }
  }
  lots.sort((a, b) =>
    a.assignedDate === b.assignedDate
      ? a.ticker < b.ticker
        ? -1
        : 1
      : a.assignedDate < b.assignedDate
        ? -1
        : 1,
  );

  const attachedCallKeys = new Set<string>();
  const coveredCallKeysByCampaign = new Map<string, string[]>();
  for (const key of keys) {
    const legs = legsByKey.get(key) ?? [];
    const first = legs[0];
    if (!first || first.type !== "call") continue;
    const earliestOpen = legs.reduce(
      (min, leg) => (leg.opened < min ? leg.opened : min),
      legs[0]?.opened ?? "",
    );
    const lot = lots.find(
      (candidate) =>
        candidate.ticker === first.ticker &&
        candidate.assignedDate !== "" &&
        candidate.assignedDate <= earliestOpen,
    );
    if (!lot) continue;
    attachedCallKeys.add(key);
    coveredCallKeysByCampaign.set(lot.campaignKey, [
      ...(coveredCallKeysByCampaign.get(lot.campaignKey) ?? []),
      key,
    ]);
    // CC premium collected against the lot: closed portions at
    // their realized premium, exercised portions in full, still
    // open legs at the gross premium already received. A
    // buyback portion without a recorded close price makes the
    // total partial (ccPremiumKnown=false).
    for (const portion of portionsByKey.get(key) ?? []) {
      if (portion.outcome === "open") {
        lot.ccPremiumTotal = round2(
          lot.ccPremiumTotal + portion.premium * portion.contracts * 100,
        );
      } else if (portion.realized != null) {
        lot.ccPremiumTotal = round2(lot.ccPremiumTotal + portion.realized);
      } else if (portion.outcome === "bought_back" || portion.outcome === "closed_other") {
        lot.ccPremiumKnown = false;
      }
      if (portion.outcome === "exercised") lot.calledAway = true;
    }
  }
  for (const lot of lots) {
    lot.statusText = lot.calledAway ? "已离场（备兑行权）" : "持有中";
  }

  const campaigns: OptionsTabCampaignView[] = [];
  for (const key of keys) {
    const legs = legsByKey.get(key) ?? [];
    const first = legs[0];
    if (!first) continue;
    if (first.type === "call" && attachedCallKeys.has(key)) continue;
    const portions = portionsByKey.get(key) ?? [];
    let openContracts = 0;
    let assignedContracts = 0;
    let closedContracts = 0;
    let realizedPremium = 0;
    let realizedComplete = true;
    for (const portion of portions) {
      if (portion.outcome === "open") openContracts += portion.contracts;
      else if (portion.outcome === "assigned") assignedContracts += portion.contracts;
      else {
        closedContracts += portion.contracts;
        if (portion.realized != null) realizedPremium += portion.realized;
        else realizedComplete = false;
      }
    }
    const openedContracts = legs.reduce((sum, leg) => sum + leg.contracts, 0);
    const grossPremiumReceived = round2(
      legs.reduce((sum, leg) => sum + leg.premium * leg.contracts * 100, 0),
    );
    const status: OptionsTabCampaignView["status"] =
      openContracts > 0 ? "open" : assignedContracts > 0 ? "assigned" : "closed";
    const rollsRaw = input.rollsOverride[key];
    campaigns.push({
      key,
      ticker: first.ticker,
      type: first.type,
      kindLabel: first.type === "put" ? "CSP" : "CC",
      exp: first.exp,
      strike: first.strike,
      rolls:
        typeof rollsRaw === "number" && Number.isFinite(rollsRaw) && rollsRaw > 0
          ? Math.floor(rollsRaw)
          : 0,
      rollsSource: "人工维护",
      openedContracts,
      openContracts,
      assignedContracts,
      closedContracts,
      grossPremiumReceived,
      realizedPremium: round2(realizedPremium),
      realizedComplete,
      status,
      statusText: status === "open" ? "进行中" : status === "assigned" ? "已指派" : "已平仓",
      lotIds: lots.filter((lot) => lot.campaignKey === key).map((lot) => lot.id),
      coveredCallKeys: coveredCallKeysByCampaign.get(key) ?? [],
    });
  }
  const statusRank = (status: OptionsTabCampaignView["status"]): number =>
    status === "open" ? 0 : status === "assigned" ? 1 : 2;
  campaigns.sort((a, b) =>
    statusRank(a.status) !== statusRank(b.status)
      ? statusRank(a.status) - statusRank(b.status)
      : a.exp === b.exp
        ? a.ticker < b.ticker
          ? -1
          : 1
        : a.exp < b.exp
          ? -1
          : 1,
  );
  return { campaigns, lots };
}

/* ------------------------------ timeline ------------------------------- */

export function buildTimeline(
  input: OptionsTabInput,
  openPositions: readonly OptionsTabOpenPositionView[],
): OptionsTabTimelineItemView[] {
  const items: OptionsTabTimelineItemView[] = [];
  if (!isRealDateText(input.asOf)) return items;
  const seenExpiry = new Set<string>();
  for (const row of openPositions) {
    if (seenExpiry.has(row.key)) continue;
    seenExpiry.add(row.key);
    if (row.daysToExpiry < 0 || row.daysToExpiry > TIMELINE_HORIZON_DAYS) continue;
    items.push({
      date: row.exp,
      kind: "expiry",
      ticker: row.ticker,
      text: `${row.ticker} ${row.kindLabel} · 行权价 ${row.strike} · ${row.contracts} 张到期`,
      note: null,
      locked: false,
    });
  }
  const tickers = new Set<string>([
    ...openPositions.map((row) => row.ticker),
    ...Object.keys(input.quotes),
  ]);
  for (const ticker of tickers) {
    const earnings = resolveEarnings(input, ticker);
    if (!earnings || earnings.daysUntil > TIMELINE_HORIZON_DAYS) continue;
    items.push({
      date: earnings.date,
      kind: "earnings",
      ticker,
      text: `${ticker} 财报`,
      note: earnings.note,
      locked: earnings.locked,
    });
  }
  items.sort((a, b) =>
    a.date === b.date
      ? a.kind === b.kind
        ? a.ticker < b.ticker
          ? -1
          : 1
        : a.kind === "expiry"
          ? -1
          : 1
      : a.date < b.date
        ? -1
        : 1,
  );
  return items;
}

/* ------------------------------ IV−RV gate ----------------------------- */

export function buildIvRvGates(input: OptionsTabInput): OptionsTabGateView[] {
  const tickers = new Set<string>([
    ...input.openOptions.map((option) => option.ticker),
    ...Object.keys(input.quotes),
  ]);
  const gates: OptionsTabGateView[] = [];
  for (const ticker of [...tickers].sort()) {
    const quote = input.quotes[ticker] ?? { spot: null, iv: null, rv: null, rv30: null };
    const iv = quote.iv;
    const rv = quote.rv;
    const spreadPp =
      iv != null && rv != null && Number.isFinite(iv) && Number.isFinite(rv)
        ? finiteOrNull(round1((iv - rv) * 100))
        : null;
    const state: OptionsTabGateView["state"] =
      spreadPp == null ? "unknown" : spreadPp < 0 ? "blocked" : "met";
    const earnings = resolveEarnings(input, ticker);
    gates.push({
      ticker,
      iv,
      rv,
      spreadPp,
      state,
      symbol: state === "met" ? "●" : state === "blocked" ? "○" : "—",
      text:
        state === "met"
          ? "门槛满足"
          : state === "blocked"
            ? "IV−RV 为负，门槛未满足，不开新仓"
            : "IV / RV 未收录，门槛无法判定",
      earningsDate: earnings?.date ?? null,
      earningsLocked: earnings?.locked ?? false,
    });
  }
  return gates;
}

/* --------------------------------- GEX --------------------------------- */

function ladderPriceLabel(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

// The wheel board's price ladder: spot, flip, call wall, put
// wall and the holder's own open strikes on one scale. Labels
// sit in two rows (above / below the track), each with a near
// and a far tier; a marker takes the first slot whose previous
// marker is at least 14% of the scale away, so labels never
// overlap. Null when fewer than two distinct price points
// exist — a one-point ladder would fabricate a scale.
export function buildGexLadder(
  symbol: OptionsTabGexSymbolInput,
  openOptions: readonly OptionsTabOpenOptionInput[],
  ticker: string,
): OptionsTabGexLadderView | null {
  const raw: { value: number; kind: OptionsTabGexLadderMarker["kind"]; sub: string }[] = [];
  if (symbol.spot != null && Number.isFinite(symbol.spot) && symbol.spot > 0) {
    raw.push({ value: symbol.spot, kind: "spot", sub: "现价" });
  }
  if (symbol.flip != null && Number.isFinite(symbol.flip) && symbol.flip > 0) {
    raw.push({ value: symbol.flip, kind: "flip", sub: "Flip" });
  }
  if (symbol.callWall != null && Number.isFinite(symbol.callWall) && symbol.callWall > 0) {
    raw.push({ value: symbol.callWall, kind: "callWall", sub: "Call Wall" });
  }
  if (symbol.putWall != null && Number.isFinite(symbol.putWall) && symbol.putWall > 0) {
    raw.push({ value: symbol.putWall, kind: "putWall", sub: "Put Wall" });
  }
  for (const option of openOptions) {
    if (option.ticker !== ticker) continue;
    if (!Number.isFinite(option.strike) || option.strike <= 0) continue;
    raw.push({
      value: option.strike,
      kind: "strike",
      sub: `你的 ${option.type === "put" ? "Put" : "Call"} · ${option.exp.slice(5)} ×${Math.abs(option.contracts)}`,
    });
  }
  const distinct = new Set(raw.map((marker) => marker.value));
  if (distinct.size < 2) return null;
  const values = raw.map((marker) => marker.value);
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const pad = (hi - lo) * 0.08;
  const min = lo - pad;
  const max = hi + pad;
  const span = max - min;
  if (!(span > 0)) return null;
  const sorted = raw
    .map((marker) => ({
      ...marker,
      pct: Math.min(97, Math.max(3, ((marker.value - min) / span) * 100)),
    }))
    .sort((a, b) => a.pct - b.pct);
  const lastAt = new Map<string, number>();
  const markers: OptionsTabGexLadderMarker[] = sorted.map((marker) => {
    const slots: { side: "above" | "below"; tier: 0 | 1 }[] = [
      { side: "above", tier: 0 },
      { side: "below", tier: 0 },
      { side: "above", tier: 1 },
      { side: "below", tier: 1 },
    ];
    let chosen = slots[3] as { side: "above" | "below"; tier: 0 | 1 };
    let bestDistance = -1;
    for (const slot of slots) {
      const key = `${slot.side}:${slot.tier}`;
      const previous = lastAt.get(key);
      const distance = previous == null ? Number.POSITIVE_INFINITY : Math.abs(marker.pct - previous);
      if (distance >= 14) {
        chosen = slot;
        break;
      }
      if (distance > bestDistance) {
        bestDistance = distance;
        chosen = slot;
      }
    }
    lastAt.set(`${chosen.side}:${chosen.tier}`, marker.pct);
    return {
      value: marker.value,
      pct: round1(marker.pct),
      side: chosen.side,
      tier: chosen.tier,
      kind: marker.kind,
      label: `$${ladderPriceLabel(marker.value)}`,
      sub: marker.sub,
    };
  });
  return { min: round2(min), max: round2(max), markers };
}

export function buildGexPanel(input: OptionsTabInput): OptionsTabGexView {
  const gex = input.gex;
  if (!gex) {
    return {
      state: "unavailable",
      bannerText: "GEX 数据暂不可用",
      sourceDate: null,
      rows: [],
    };
  }
  const rows: OptionsTabGexRowView[] = Object.entries(gex.symbols)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([ticker, symbol]) => {
      const zeroed = symbol.netGex === 0 && symbol.flip == null;
      return {
        ticker,
        netGex: symbol.netGex,
        flip: symbol.flip,
        spot: symbol.spot,
        flipDistancePct:
          symbol.spot != null &&
          symbol.flip != null &&
          Number.isFinite(symbol.spot) &&
          Number.isFinite(symbol.flip) &&
          symbol.flip > 0
            ? finiteOrNull(round2((symbol.spot / symbol.flip - 1) * 100))
            : null,
        regimeText:
          symbol.netGex == null || !Number.isFinite(symbol.netGex)
            ? null
            : symbol.netGex < 0
              ? "− 负 gamma"
              : symbol.netGex > 0
                ? "+ 正 gamma"
                : "净 GEX 为 0",
        callWall: symbol.callWall ?? null,
        putWall: symbol.putWall ?? null,
        ladder: zeroed ? null : buildGexLadder(symbol, input.openOptions, ticker),
        stale: symbol.stale,
        dataState: zeroed ? ("zeroed" as const) : ("ok" as const),
        dataText: zeroed ? "无数据（OI 可能处于清零时段）" : "已收录",
      };
    });
  if (gex.hasMeta && gex.status === "unavailable") {
    return { state: "unavailable", bannerText: "GEX 数据暂不可用", sourceDate: gex.sourceDate, rows: [] };
  }
  if (!gex.hasMeta) {
    return { state: "unverified", bannerText: "新鲜度未核实", sourceDate: gex.sourceDate, rows };
  }
  const stale = gex.status === "stale" || rows.some((row) => row.stale);
  if (stale) {
    return {
      state: "stale",
      bannerText: `数据已过期（来源日期 ${gex.sourceDate ?? "未知"}），仅供参考`,
      sourceDate: gex.sourceDate,
      rows,
    };
  }
  return {
    state: "fresh",
    bannerText: gex.sourceDate ? `来源日期 ${gex.sourceDate}` : "已收录",
    sourceDate: gex.sourceDate,
    rows,
  };
}

/* --------------------- F-DASH-P0-5 merged sections --------------------- */

export interface OptionsTabActionItemView {
  kind: "expiry" | "gate" | "earnings";
  rank: number;
  symbol: string;
  text: string;
}

export interface OptionsTabVolRowView {
  ticker: string;
  spot: number | null;
  iv30: number | null;
  rv20: number | null;
  rv30: number | null;
  spreadPp: number | null; // (IV30 − RV30) in percentage points
  state: "positive" | "negative" | "unknown";
  edgeText: string; // symbol + text badge, never colour alone
  verdict: string; // one-sentence factual read of the spread
  earningsDate: string | null;
  earningsLocked: boolean;
}

export interface OptionsTabPortfolioGreeksView {
  available: boolean; // at least one open row carries model Greeks
  pricedContracts: number; // contracts covered by the totals
  openContracts: number; // all open contracts
  deltaShares: number | null;
  thetaPerDay: number | null;
  vegaPerPoint: number | null;
  unrealizedPnl: number | null; // model caliber, rows with a model price
}

export interface OptionsTabConcentrationView {
  factorTickers: string[];
  putObligation: number; // factor tickers' open short-put obligation
  putObligationLines: { ticker: string; amount: number }[];
  nonFactorPutObligation: number; // stated, never silently merged in
  assignedMarketValue: number | null; // null while any factor lot lacks a spot
  assignedMissingSpotTickers: string[];
  exposure: number | null; // putObligation + assignedMarketValue
  portfolioTotal: number | null;
  exposurePct: number | null; // percent of portfolioTotal, 1 decimal
  capFraction: number; // 0.25
  capAmount: number | null;
  headroom: number | null; // capAmount − exposure; negative when over
  overLimit: boolean;
}

export interface OptionsTabDualLedgerView {
  caliberA: {
    realizedOptionsPnl: number; // Σ realized over closed portions (assignments excluded)
    realizedComplete: boolean;
    realizedLines: {
      ticker: string;
      exp: string;
      strike: number;
      type: OptionsTabOptionType;
      outcomeText: string;
      amount: number | null; // null when a close price was not recorded
      complete: boolean;
    }[];
    basisPremiumTotal: number; // Σ premium that moved into assigned lots' cost
    basisLines: {
      ticker: string;
      strike: number;
      effectiveCost: number;
      amount: number;
    }[];
  };
  caliberB: {
    realizedOptionsPnl: number; // the same caliber-A figure, restated
    assignedUnrealized: number | null; // null while any lot lacks a spot
    openUnrealizedPut: number | null; // null while any open put row lacks a model price
    openUnrealizedCall: number | null;
    openUnrealized: number | null;
    total: number | null; // null unless every component is known
  };
}

export interface OptionsTabManagementRowView {
  key: string;
  ticker: string;
  kindLabel: string;
  exp: string;
  strike: number;
  contracts: number;
  daysToExpiry: number;
  rolls: number;
  rollLimit: number;
  rollsSource: string;
  nodePassed: boolean; // daysToExpiry <= MANAGEMENT_NODE_DTE
  nodeText: string;
  capturedPct: number | null;
  capturedTargetReached: boolean;
  otmPct: number | null;
  unrealizedPnl: number | null;
}

export interface OptionsTabEarningsWindowRowView {
  ticker: string;
  date: string | null;
  daysUntil: number | null;
  state: "inside" | "outside" | "unrecorded";
  stateText: string;
  gateSpreadPp: number | null; // IV30 − RV30 for the same ticker
  gateText: string;
}

export interface OptionsTabManagementView {
  rows: OptionsTabManagementRowView[];
  earningsWindow: OptionsTabEarningsWindowRowView[];
}

/* --------------------------- action bar (a) ---------------------------- */

// The options tab's own action bar: the F-DASH-P0-4 overview
// bar's options-related items only, with the same verbatim
// templates and ordering (nearest expiry → blocked IV−RV
// gates → earnings locks). Fact statements with dates and
// counts; the overview-only kinds never appear here.
export function buildOptionsTabActions(
  openPositions: readonly OptionsTabOpenPositionView[],
  gates: readonly OptionsTabGateView[],
  earnings: readonly OptionsTabEarningsView[],
): OptionsTabActionItemView[] {
  const items: OptionsTabActionItemView[] = [];
  const upcoming = openPositions
    .filter((row) => Number.isFinite(row.daysToExpiry) && row.daysToExpiry >= 0)
    .sort((a, b) =>
      a.daysToExpiry !== b.daysToExpiry
        ? a.daysToExpiry - b.daysToExpiry
        : a.exp === b.exp
          ? a.ticker < b.ticker
            ? -1
            : 1
          : a.exp < b.exp
            ? -1
            : 1,
    );
  const nearest = upcoming[0];
  if (nearest) {
    items.push({
      kind: "expiry",
      rank: 0,
      symbol: "●",
      text: `${nearest.ticker} ${nearest.kindLabel} · ${nearest.exp} 到期，剩余 ${nearest.daysToExpiry} 天`,
    });
  }
  for (const gate of gates.filter((row) => row.state === "blocked")) {
    items.push({
      kind: "gate",
      rank: 1,
      symbol: "○",
      text:
        gate.spreadPp != null
          ? `${gate.ticker} IV−RV 为负（${gate.spreadPp} 个百分点），门槛未满足`
          : `${gate.ticker} IV−RV 为负，门槛未满足`,
    });
  }
  const locks = earnings
    .filter((row) => row.locked)
    .sort((a, b) => (a.date === b.date ? (a.ticker < b.ticker ? -1 : 1) : a.date < b.date ? -1 : 1));
  for (const lock of locks) {
    items.push({
      kind: "earnings",
      rank: 2,
      symbol: "◆",
      text: `${lock.ticker} 财报日 ${lock.date}，窗口内不开新 CSP`,
    });
  }
  return items.slice(0, OPTIONS_ACTION_LIMIT);
}

/* --------------------------- vol / edge (c) ---------------------------- */

function fmtVolPct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function fmtSignedPp(value: number): string {
  return `${value >= 0 ? "+" : "−"}${Math.abs(value).toFixed(1)}`;
}

// Per-ticker IV30 vs RV30 (RV20 shown alongside): the wheel
// board's edge panel. The spread and its one-sentence read
// follow the same sign discipline as the tab's gate lights —
// a negative IV−RV spread states the gate fact, a positive
// one states the premium-compensation fact; neither is an
// instruction.
export function buildVolPanel(input: OptionsTabInput): OptionsTabVolRowView[] {
  const tickers = new Set<string>([
    ...input.openOptions.map((option) => option.ticker),
    ...Object.keys(input.quotes),
  ]);
  const rows: OptionsTabVolRowView[] = [];
  for (const ticker of [...tickers].sort()) {
    const quote = input.quotes[ticker] ?? { spot: null, iv: null, rv: null, rv30: null };
    const iv30 = quote.iv;
    const rv30 = quote.rv30;
    const spreadPp =
      iv30 != null && rv30 != null && Number.isFinite(iv30) && Number.isFinite(rv30)
        ? finiteOrNull(round1((iv30 - rv30) * 100))
        : null;
    const state: OptionsTabVolRowView["state"] =
      spreadPp == null ? "unknown" : spreadPp < 0 ? "negative" : "positive";
    const earnings = resolveEarnings(input, ticker);
    rows.push({
      ticker,
      spot: quote.spot,
      iv30,
      rv20: quote.rv,
      rv30,
      spreadPp,
      state,
      edgeText:
        state === "positive"
          ? "✓ + 正 edge · 权利金补偿充足"
          : state === "negative"
            ? "− 负 edge · 权利金补偿不足"
            : "IV30 / RV30 未收录，无法判定",
      verdict:
        state === "positive" && iv30 != null && rv30 != null && spreadPp != null
          ? `IV30 ${fmtVolPct(iv30)} 高于 RV30 ${fmtVolPct(rv30)}，价差 ${fmtSignedPp(spreadPp)}pt 为正。`
          : state === "negative" && iv30 != null && rv30 != null && spreadPp != null
            ? `IV30 ${fmtVolPct(iv30)} 低于 RV30 ${fmtVolPct(rv30)}，价差 ${fmtSignedPp(spreadPp)}pt 为负。`
            : "IV30 或 RV30 未收录，暂无判读。",
      earningsDate: earnings?.date ?? null,
      earningsLocked: earnings?.locked ?? false,
    });
  }
  return rows;
}

/* ------------------------- portfolio Greeks (d) ------------------------ */

export function buildPortfolioGreeks(
  openPositions: readonly OptionsTabOpenPositionView[],
): OptionsTabPortfolioGreeksView {
  let pricedContracts = 0;
  let deltaShares = 0;
  let thetaPerDay = 0;
  let vegaPerPoint = 0;
  let unrealized = 0;
  let unrealizedSeen = false;
  for (const row of openPositions) {
    if (row.deltaShares != null && row.thetaPerDay != null && row.vegaPerPoint != null) {
      pricedContracts += row.contracts;
      deltaShares += row.deltaShares;
      thetaPerDay += row.thetaPerDay;
      vegaPerPoint += row.vegaPerPoint;
    }
    if (row.unrealizedPnl != null) {
      unrealized += row.unrealizedPnl;
      unrealizedSeen = true;
    }
  }
  const available = pricedContracts > 0;
  return {
    available,
    pricedContracts,
    openContracts: openPositions.reduce((sum, row) => sum + row.contracts, 0),
    deltaShares: available ? round2(deltaShares) : null,
    thetaPerDay: available ? round2(thetaPerDay) : null,
    vegaPerPoint: available ? round2(vegaPerPoint) : null,
    unrealizedPnl: unrealizedSeen ? round2(unrealized) : null,
  };
}

/* ----------------------- assigned enrichment (e) ----------------------- */

// Fills each lot's spot-dependent fields from the quotes and
// allocates the ticker's open covered calls across its lots,
// earliest assignment first (a call covers the earliest lot
// that still has uncovered shares). Lots keep their
// buildCampaigns order (assignedDate ascending).
export function enrichAssignedLots(
  lots: readonly OptionsTabLotView[],
  openPositions: readonly OptionsTabOpenPositionView[],
  quotes: OptionsTabInput["quotes"],
): OptionsTabLotView[] {
  const ccCapacity = new Map<string, number>();
  for (const row of openPositions) {
    if (row.kind === "CC") ccCapacity.set(row.key, row.contracts * 100);
  }
  return lots.map((lot) => {
    const spot = quotes[lot.ticker]?.spot ?? null;
    const usableSpot = spot != null && Number.isFinite(spot) && spot > 0 ? spot : null;
    const marketValue = usableSpot != null ? round2(usableSpot * lot.shares) : null;
    const unrealizedPnl =
      usableSpot != null ? round2((usableSpot - lot.effectiveCost) * lot.shares) : null;
    const costBasisTotal = lot.effectiveCost * lot.shares;
    const unrealizedPct =
      unrealizedPnl != null && costBasisTotal > 0
        ? finiteOrNull(round2((unrealizedPnl / costBasisTotal) * 100))
        : null;
    const coveredCalls: OptionsTabLotView["coveredCalls"] = [];
    let uncovered = lot.shares;
    for (const row of openPositions) {
      if (uncovered <= 0) break;
      if (row.kind !== "CC" || row.ticker !== lot.ticker) continue;
      const capacity = ccCapacity.get(row.key) ?? 0;
      if (capacity <= 0) continue;
      const shares = Math.min(capacity, uncovered);
      ccCapacity.set(row.key, capacity - shares);
      uncovered -= shares;
      coveredCalls.push({
        strike: row.strike,
        exp: row.exp,
        contracts: row.contracts,
        shares,
      });
    }
    return {
      ...lot,
      spot: usableSpot,
      marketValue,
      unrealizedPnl,
      unrealizedPct,
      coveredCalls,
    };
  });
}

/* --------------------------- concentration (f) ------------------------- */

export function buildConcentration(
  input: OptionsTabInput,
  openPositions: readonly OptionsTabOpenPositionView[],
  lots: readonly OptionsTabLotView[],
): OptionsTabConcentrationView {
  const factorSet = new Set<string>(FACTOR_TICKERS);
  const obligationByTicker = new Map<string, number>();
  let nonFactorPutObligation = 0;
  for (const row of openPositions) {
    if (row.assignmentObligation <= 0) continue;
    if (factorSet.has(row.ticker)) {
      obligationByTicker.set(
        row.ticker,
        (obligationByTicker.get(row.ticker) ?? 0) + row.assignmentObligation,
      );
    } else {
      nonFactorPutObligation += row.assignmentObligation;
    }
  }
  const putObligation = round2(
    [...obligationByTicker.values()].reduce((sum, amount) => sum + amount, 0),
  );
  const putObligationLines = [...obligationByTicker.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([ticker, amount]) => ({ ticker, amount: round2(amount) }));
  let assignedSum = 0;
  const missing = new Set<string>();
  for (const lot of lots) {
    if (!factorSet.has(lot.ticker)) continue;
    if (lot.marketValue == null) missing.add(lot.ticker);
    else assignedSum += lot.marketValue;
  }
  const assignedMarketValue = missing.size > 0 ? null : round2(assignedSum);
  const portfolioTotal =
    input.portfolioTotal != null &&
    Number.isFinite(input.portfolioTotal) &&
    input.portfolioTotal > 0
      ? input.portfolioTotal
      : null;
  const exposure =
    assignedMarketValue != null ? round2(putObligation + assignedMarketValue) : null;
  const exposurePct =
    exposure != null && portfolioTotal != null
      ? finiteOrNull(round1((exposure / portfolioTotal) * 100))
      : null;
  const capAmount =
    portfolioTotal != null ? round2(portfolioTotal * CONCENTRATION_CAP_FRACTION) : null;
  const headroom =
    exposure != null && capAmount != null ? round2(capAmount - exposure) : null;
  return {
    factorTickers: [...FACTOR_TICKERS],
    putObligation,
    putObligationLines,
    nonFactorPutObligation: round2(nonFactorPutObligation),
    assignedMarketValue,
    assignedMissingSpotTickers: [...missing].sort(),
    exposure,
    portfolioTotal,
    exposurePct,
    capFraction: CONCENTRATION_CAP_FRACTION,
    capAmount,
    headroom,
    overLimit: exposurePct != null && exposurePct > CONCENTRATION_CAP_FRACTION * 100,
  };
}

/* ---------------------------- dual ledger (g) -------------------------- */

// Two calibers, always side by side. Caliber A is the premium
// scoreboard: realized option P&L over closed portions
// (assigned portions are excluded — their premium lives in
// the lots' effective cost and is listed separately as the
// amount moved into cost basis). Caliber B is the total-
// equity view: A + assigned lots' float + open positions'
// model float. A component that cannot be computed (a lot
// without a spot, an open row without a model price) nulls
// caliber B's total instead of being silently read as 0.
export function buildDualLedger(
  input: OptionsTabInput,
  lots: readonly OptionsTabLotView[],
  openPositions: readonly OptionsTabOpenPositionView[],
): OptionsTabDualLedgerView {
  const legsByKey = new Map<string, OptionsTabLegInput[]>();
  for (const leg of input.legs) {
    const key = campaignKeyOf(leg.ticker, leg.type, leg.exp, leg.strike);
    legsByKey.set(key, [...(legsByKey.get(key) ?? []), leg]);
  }
  const closesByKey = new Map<string, OptionsTabCloseInput[]>();
  for (const close of input.closes) {
    const key = campaignKeyOf(close.ticker, close.type, close.exp, close.strike);
    closesByKey.set(key, [...(closesByKey.get(key) ?? []), close]);
  }
  const keys = new Set<string>([...legsByKey.keys(), ...closesByKey.keys()]);
  let realizedTotal = 0;
  let realizedComplete = true;
  const realizedLines: OptionsTabDualLedgerView["caliberA"]["realizedLines"] = [];
  for (const key of keys) {
    const legs = legsByKey.get(key) ?? [];
    const first = legs[0];
    if (!first) continue;
    const portions = pairLegsFifo(legs, closesByKey.get(key) ?? []);
    let closedContracts = 0;
    let realized = 0;
    let complete = true;
    let anyKnown = false;
    const outcomes = new Set<OptionsTabPortionOutcome>();
    for (const portion of portions) {
      if (portion.outcome === "open" || portion.outcome === "assigned") continue;
      closedContracts += portion.contracts;
      outcomes.add(portion.outcome);
      if (portion.realized != null) {
        realized += portion.realized;
        anyKnown = true;
      } else {
        complete = false;
      }
    }
    if (closedContracts === 0) continue;
    realizedTotal += realized;
    if (!complete) realizedComplete = false;
    const outcomeText = outcomes.has("expired")
      ? "到期作废"
      : outcomes.has("exercised")
        ? "备兑行权"
        : outcomes.has("bought_back")
          ? "买回平仓"
          : "已平仓";
    realizedLines.push({
      ticker: first.ticker,
      exp: first.exp,
      strike: first.strike,
      type: first.type,
      outcomeText: outcomes.size > 1 ? "已平仓" : outcomeText,
      amount: anyKnown ? round2(realized) : null,
      complete,
    });
  }
  realizedLines.sort((a, b) =>
    a.ticker === b.ticker
      ? a.exp < b.exp
        ? -1
        : 1
      : a.ticker < b.ticker
        ? -1
        : 1,
  );
  const basisLines = lots.map((lot) => ({
    ticker: lot.ticker,
    strike: lot.strike,
    effectiveCost: lot.effectiveCost,
    amount: round2(lot.premiumPerShare * lot.shares),
  }));
  const basisPremiumTotal = round2(
    basisLines.reduce((sum, line) => sum + line.amount, 0),
  );

  let assignedUnrealized: number | null = 0;
  for (const lot of lots) {
    if (lot.unrealizedPnl == null) {
      assignedUnrealized = null;
      break;
    }
    assignedUnrealized += lot.unrealizedPnl;
  }
  if (assignedUnrealized != null) assignedUnrealized = round2(assignedUnrealized);
  const openFloat = (kinds: readonly string[]): number | null => {
    let total: number | null = 0;
    for (const row of openPositions) {
      if (!kinds.includes(row.kind)) continue;
      if (row.unrealizedPnl == null) return null;
      total = (total ?? 0) + row.unrealizedPnl;
    }
    return total != null ? round2(total) : null;
  };
  const openUnrealizedPut = openFloat(["CSP", "LONG_PUT"]);
  const openUnrealizedCall = openFloat(["CC", "LONG_CALL"]);
  const openUnrealized =
    openUnrealizedPut != null && openUnrealizedCall != null
      ? round2(openUnrealizedPut + openUnrealizedCall)
      : null;
  const realizedOptionsPnl = round2(realizedTotal);
  const total =
    assignedUnrealized != null && openUnrealized != null
      ? round2(realizedOptionsPnl + assignedUnrealized + openUnrealized)
      : null;
  return {
    caliberA: {
      realizedOptionsPnl,
      realizedComplete,
      realizedLines,
      basisPremiumTotal,
      basisLines,
    },
    caliberB: {
      realizedOptionsPnl,
      assignedUnrealized,
      openUnrealizedPut,
      openUnrealizedCall,
      openUnrealized,
      total,
    },
  };
}

/* --------------------- management + earnings (h) ----------------------- */

export function buildManagement(
  input: OptionsTabInput,
  openPositions: readonly OptionsTabOpenPositionView[],
  campaigns: readonly OptionsTabCampaignView[],
  volPanel: readonly OptionsTabVolRowView[],
): OptionsTabManagementView {
  const campaignByKey = new Map(campaigns.map((campaign) => [campaign.key, campaign]));
  const rows: OptionsTabManagementRowView[] = openPositions
    .filter((row) => row.side === "short")
    .map((row) => {
      const campaign = campaignByKey.get(row.key);
      const nodePassed = row.daysToExpiry <= MANAGEMENT_NODE_DTE;
      return {
        key: `${row.key}-${row.account}`,
        ticker: row.ticker,
        kindLabel: row.kindLabel,
        exp: row.exp,
        strike: row.strike,
        contracts: row.contracts,
        daysToExpiry: row.daysToExpiry,
        rolls: campaign?.rolls ?? 0,
        rollLimit: ROLL_LIMIT,
        rollsSource: campaign?.rollsSource ?? "人工维护",
        nodePassed,
        nodeText:
          row.daysToExpiry < 0
            ? "已到期"
            : nodePassed
              ? "✓ 已过 21 天管理节点"
              : `未到 21 天管理节点（剩 ${row.daysToExpiry} 天，至 21 天时复核）`,
        capturedPct: row.capturedPct,
        capturedTargetReached: row.capturedTargetReached,
        otmPct: row.otmPct,
        unrealizedPnl: row.unrealizedPnl,
      };
    })
    .sort((a, b) =>
      a.daysToExpiry !== b.daysToExpiry
        ? a.daysToExpiry - b.daysToExpiry
        : a.ticker < b.ticker
          ? -1
          : 1,
    );
  const volByTicker = new Map(volPanel.map((row) => [row.ticker, row]));
  const tickers = new Set<string>([
    ...input.openOptions.map((option) => option.ticker),
    ...Object.keys(input.quotes),
    ...Object.keys(input.earnings),
    ...Object.keys(KNOWN_EARNINGS_FALLBACK),
  ]);
  const earningsWindow: OptionsTabEarningsWindowRowView[] = [...tickers]
    .sort()
    .map((ticker) => {
      const earnings = resolveEarnings(input, ticker);
      const spreadPp = volByTicker.get(ticker)?.spreadPp ?? null;
      return {
        ticker,
        date: earnings?.date ?? null,
        daysUntil: earnings?.daysUntil ?? null,
        state: !earnings
          ? ("unrecorded" as const)
          : earnings.locked
            ? ("inside" as const)
            : ("outside" as const),
        stateText: !earnings
          ? "下一财报未收录"
          : earnings.locked
            ? "⚠ 窗口内（财报在 14 天窗口内）"
            : "窗口外（财报在 14 天窗口之外）",
        gateSpreadPp: spreadPp,
        gateText:
          spreadPp == null
            ? "IV30 / RV30 未收录，门槛无法判定"
            : spreadPp < 0
              ? `IV−RV30 价差 ${fmtSignedPp(spreadPp)}pt 为负，门槛触发，不开新仓`
              : `IV−RV30 价差 ${fmtSignedPp(spreadPp)}pt 为正，门槛未触发`,
      };
    });
  return { rows, earningsWindow };
}

/* ------------------------------ assembly ------------------------------- */

export function buildOptionsTabView(input: OptionsTabInput): OptionsTabView {
  const openPositions = buildOpenPositionRows(input);
  const { campaigns, lots } = buildCampaigns(input);
  const enrichedLots = enrichAssignedLots(lots, openPositions, input.quotes);
  const gates = buildIvRvGates(input);
  const volPanel = buildVolPanel(input);
  const tickers = new Set<string>([
    ...input.openOptions.map((option) => option.ticker),
    ...Object.keys(input.quotes),
    ...Object.keys(input.earnings),
    ...Object.keys(KNOWN_EARNINGS_FALLBACK),
  ]);
  const earnings: OptionsTabEarningsView[] = [];
  for (const ticker of [...tickers].sort()) {
    const resolved = resolveEarnings(input, ticker);
    if (resolved) earnings.push(resolved);
  }
  return {
    asOf: input.asOf,
    disclaimer: OPTIONS_TAB_DISCLAIMER,
    structuredLegs: input.structuredLegs,
    openPositions,
    campaigns,
    lots: enrichedLots,
    acbDisclaimer: OPTIONS_ACB_DISCLAIMER,
    timeline: buildTimeline(input, openPositions),
    earnings,
    gates,
    gex: buildGexPanel(input),
    actions: buildOptionsTabActions(openPositions, gates, earnings),
    volPanel,
    portfolioGreeks: buildPortfolioGreeks(openPositions),
    concentration: buildConcentration(input, openPositions, enrichedLots),
    dualLedger: buildDualLedger(input, enrichedLots, openPositions),
    management: buildManagement(input, openPositions, campaigns, volPanel),
  };
}
