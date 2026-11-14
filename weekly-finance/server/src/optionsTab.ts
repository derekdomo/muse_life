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
  iv: number | null; // implied volatility, decimal (0.32 = 32%)
  rv: number | null; // 20-day realized volatility, decimal
}

export interface OptionsTabEarningsInput {
  date: string; // YYYY-MM-DD
  note: string | null;
}

export interface OptionsTabGexSymbolInput {
  netGex: number | null;
  flip: number | null;
  spot: number | null;
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
  modelPrice: number | null;
  modelNote: string;
  capturedPct: number | null; // fraction; short positions only
  unrealizedPnl: number | null;
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

export interface OptionsTabGexRowView {
  ticker: string;
  netGex: number | null;
  flip: number | null;
  spot: number | null;
  flipDistancePct: number | null; // (spot / flip − 1) × 100, signed
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
    const quote = input.quotes[option.ticker] ?? { spot: null, iv: null, rv: null };
    const spot = quote.spot;
    const iv = quote.iv;
    const strikeDistancePct =
      spot != null && Number.isFinite(spot) && spot > 0
        ? finiteOrNull(round2((option.strike / spot - 1) * 100))
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
      modelPrice,
      modelNote: OPTIONS_MODEL_NOTE,
      capturedPct,
      unrealizedPnl,
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
    const quote = input.quotes[ticker] ?? { spot: null, iv: null, rv: null };
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

/* ------------------------------ assembly ------------------------------- */

export function buildOptionsTabView(input: OptionsTabInput): OptionsTabView {
  const openPositions = buildOpenPositionRows(input);
  const { campaigns, lots } = buildCampaigns(input);
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
    lots,
    acbDisclaimer: OPTIONS_ACB_DISCLAIMER,
    timeline: buildTimeline(input, openPositions),
    earnings,
    gates: buildIvRvGates(input),
    gex: buildGexPanel(input),
  };
}
