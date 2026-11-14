// F-DASH-P0-4 总览页签升级 (overview upgrade): the server-side
// pure computation layer for the overview tab's new blocks —
// the dual net-worth hero, the fact action bar, the TWR / MWR
// return pair, the three-factor return split and the Plaid
// freshness line. ZERO imports, every declaration exported, no
// side effects — the repo validator (weekly-finance/
// validate-overview-upgrade.mjs) drives these exact functions
// over synthetic fixtures. getDashboard assembles the input
// from fields it already returns (see
// buildOverviewUpgradeViewFromDashboard in actions.ts) and
// ships the finished view as its additive `overviewUpgrade`
// field; the client renders it verbatim and never recomputes
// a figure.
//
// Calibers:
// - 可投资净值 is the vol_panel caliber: the sum of every
//   Plaid investment-type account balance (the dashboard's
//   live.investment fact — 含 401k/HSA，不含银行存款与自住房).
//   总净值 is the dashboard's live.netWorth fact (all asset
//   account balances minus liabilities — 含自住房估值与银行
//   存款). No new server caliber is introduced: both numbers
//   are the pre-existing getDashboard facts, and the
//   difference breakdown is deposits split into bank deposits
//   plus any separately recorded home-valuation balance,
//   minus liabilities.
// - TWR / MWR: the codebase carried no prior TWR/MWR
//   implementation, so this module establishes the canonical
//   one from the trading journal's own daily series
//   (daily[]: date / value / flow — the same rows the 交易
//   tab's equity curve renders). TWR chain-links the daily
//   flow-adjusted returns r = (V_d − flow_d) / V_{d−1} − 1,
//   which removes the effect of money moving in or out. MWR
//   is the XIRR of the investor cash flows implied by the
//   same series (opening value and later deposits as outflows,
//   withdrawals and the closing value as inflows, ACT/365),
//   so it reflects the timing of the actual money. Both are
//   computed here once, server-side; nothing else in the app
//   computes a second version.
// - Three-factor split: stock price change (closed stock
//   trades' realized pnl plus open stock positions'
//   unrealized pnl), option premium (closed option trades'
//   realized pnl, labelled 已实现权利金（未计税费）) and
//   dividends + interest (the journal's dividends_total).
//   The split is reconciled against the interval's total
//   return (closing value − opening value − net external
//   flow from the same daily series); a non-zero gap is
//   stated with its reason, never forced to balance.
// - Freshness: the Plaid price-date range, the dataset
//   generated_at instant and the vol_panel asof are each
//   shown from their own evidence only. Any missing field
//   marks the line 新鲜度未核实 — stale prices are never
//   presented as today's prices (Plaid prices lag 1–3 days
//   by design).

export const OVERVIEW_ACTION_LIMIT = 5;
export const EARNINGS_LOCK_WINDOW_DAYS_OVERVIEW = 14;
export const WASH_SALE_WINDOW_DAYS = 30;

export const INVESTABLE_NOTE = "含 401k/HSA，不含银行存款与自住房";
export const TOTAL_NET_WORTH_NOTE = "含自住房估值与银行存款";
export const TWR_NOTE = "TWR 剔除资金进出影响";
export const MWR_NOTE = "MWR 反映实际资金时间价值";
export const OPTION_PREMIUM_FACTOR_LABEL = "期权权利金";
export const OPTION_PREMIUM_FACTOR_NOTE = "已实现权利金（未计税费）";
export const FACTOR_DIFFERENCE_REASON = "含未实现浮盈亏等未单列项";
export const NO_COMPARABLE_TEXT = "暂无可比数据";
export const NO_COMPARABLE_RATE_TEXT = "暂无可比";
export const FRESHNESS_UNVERIFIED_TEXT = "新鲜度未核实";

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

export function daysBetweenDates(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.round((b - a) / 86400000);
}

export function addDaysToDateText(date: string, days: number): string {
  const base = Date.parse(`${date}T00:00:00Z`);
  if (Number.isNaN(base)) return date;
  return new Date(base + days * 86400000).toISOString().slice(0, 10);
}

export function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

export function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}

export function finiteOrNull(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/* ---------------------------- dual net worth --------------------------- */

export interface DualNetWorthInput {
  investable: number | null; // live.investment (vol_panel caliber)
  deposits: number | null; // live.deposits (all positive account balances)
  loans: number | null; // live.loans (liability total, positive number)
  totalNetWorth: number | null; // live.netWorth
  // The part of `deposits` recorded as a home-valuation
  // balance (an account-type row identified as the home), or
  // null when no such row is separately recorded — the amount
  // then stays inside bank deposits and is never invented.
  homeValue: number | null;
}

export interface DualNetWorthView {
  investable: number | null;
  investableAvailable: boolean;
  investableNote: string;
  total: number | null;
  totalAvailable: boolean;
  totalNote: string;
  difference: number | null;
  bankDeposits: number | null;
  homeValue: number | null;
  loans: number | null;
}

export function buildDualNetWorth(input: DualNetWorthInput): DualNetWorthView {
  const investable = finiteOrNull(input.investable);
  const deposits = finiteOrNull(input.deposits);
  const loans = finiteOrNull(input.loans);
  const total = finiteOrNull(input.totalNetWorth);
  const homeValue = finiteOrNull(input.homeValue);
  const investableAvailable = investable != null;
  const totalAvailable = total != null && deposits != null && loans != null;
  const difference =
    investableAvailable && totalAvailable ? round2(total - investable) : null;
  // Bank deposits are what remains of the deposits fact after
  // the separately recorded home valuation — by construction
  // bankDeposits + (homeValue ?? 0) − loans === difference
  // whenever the live facts are consistent.
  const bankDeposits =
    totalAvailable && deposits != null
      ? round2(deposits - (homeValue ?? 0))
      : null;
  return {
    investable: investableAvailable ? investable : null,
    investableAvailable,
    investableNote: INVESTABLE_NOTE,
    total: totalAvailable ? total : null,
    totalAvailable,
    totalNote: TOTAL_NET_WORTH_NOTE,
    difference,
    bankDeposits,
    homeValue: totalAvailable ? homeValue : null,
    loans: totalAvailable ? loans : null,
  };
}

/* ------------------------------ action bar ----------------------------- */

export interface OverviewActionOpenPosition {
  ticker: string;
  kindLabel: string;
  exp: string;
  daysToExpiry: number;
}

export interface OverviewActionGate {
  ticker: string;
  state: "met" | "blocked" | "unknown";
  spreadPp: number | null;
}

export interface OverviewActionEarnings {
  ticker: string;
  date: string;
  daysUntil: number;
  locked: boolean;
}

export interface OverviewActionClosedTrade {
  kind: string;
  ticker: string;
  closed: string; // YYYY-MM-DD
  pnl: number | null;
}

export interface OverviewActionsInput {
  asOf: string; // YYYY-MM-DD — the trading dataset's generated date
  openPositions: OverviewActionOpenPosition[];
  gates: OverviewActionGate[];
  earnings: OverviewActionEarnings[];
  reviewPendingTotal: number | null; // F3.5 queue count, null when unavailable
  closedTrades: OverviewActionClosedTrade[];
}

export type OverviewActionKind = "expiry" | "gate" | "earnings" | "review" | "wash";

export interface OverviewActionItem {
  kind: OverviewActionKind;
  rank: number;
  symbol: string;
  text: string;
}

// Fact statements only, each carrying its date or count, in
// the brief's urgency order: nearest expiry → IV−RV gate →
// earnings lock → pending review → wash-sale window. The bar
// is capped at OVERVIEW_ACTION_LIMIT items; an empty result
// hides the whole block (the client renders nothing).
export function buildOverviewActions(input: OverviewActionsInput): OverviewActionItem[] {
  const items: OverviewActionItem[] = [];

  const upcoming = input.openPositions
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

  for (const gate of input.gates.filter((row) => row.state === "blocked")) {
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

  const locks = input.earnings
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

  if (input.reviewPendingTotal != null && input.reviewPendingTotal > 0) {
    items.push({
      kind: "review",
      rank: 3,
      symbol: "◐",
      text: `待复核交易 ${input.reviewPendingTotal} 笔`,
    });
  }

  if (isRealDateText(input.asOf)) {
    const latestLossByTicker = new Map<string, string>();
    for (const trade of input.closedTrades) {
      if (trade.pnl == null || !(trade.pnl < 0)) continue;
      if (!isRealDateText(trade.closed)) continue;
      const age = daysBetweenDates(trade.closed, input.asOf);
      if (age < 0 || age > WASH_SALE_WINDOW_DAYS) continue;
      const previous = latestLossByTicker.get(trade.ticker);
      if (!previous || trade.closed > previous) {
        latestLossByTicker.set(trade.ticker, trade.closed);
      }
    }
    const wash = [...latestLossByTicker.entries()]
      .map(([ticker, closed]) => ({
        ticker,
        closed,
        until: addDaysToDateText(closed, WASH_SALE_WINDOW_DAYS),
      }))
      .sort((a, b) => (a.until === b.until ? (a.ticker < b.ticker ? -1 : 1) : a.until < b.until ? -1 : 1));
    for (const row of wash) {
      items.push({
        kind: "wash",
        rank: 4,
        symbol: "▼",
        text: `${row.ticker} 于 ${row.closed} 亏损卖出，30 天内 IRA 不买同名（窗口至 ${row.until}）`,
      });
    }
  }

  items.sort((a, b) => a.rank - b.rank);
  return items.slice(0, OVERVIEW_ACTION_LIMIT);
}

/* ------------------------------ TWR / MWR ------------------------------ */

export interface OverviewDailyPoint {
  date: string; // YYYY-MM-DD
  value: number; // end-of-day total value
  flow: number; // external net flow that day (in positive)
}

export interface ReturnMetricsView {
  twr: number | null; // fraction over the interval
  mwr: number | null; // per-year rate (XIRR), fraction
  startDate: string | null;
  endDate: string | null;
  days: number;
  twrNote: string;
  mwrNote: string;
}

// Sorted, de-duplicated (last row wins per date), valid points
// only — the shared basis for both return calibers and the
// factor reconciliation total.
export function normalizeDailyPoints(
  points: readonly OverviewDailyPoint[],
): OverviewDailyPoint[] {
  const byDate = new Map<string, OverviewDailyPoint>();
  for (const point of points) {
    if (!isRealDateText(point.date)) continue;
    if (!Number.isFinite(point.value) || !Number.isFinite(point.flow)) continue;
    byDate.set(point.date, { date: point.date, value: point.value, flow: point.flow });
  }
  return [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

// Chain-linked time-weighted return over the daily series.
// Each day's return removes that day's external flow:
// r_d = (V_d − flow_d) / V_{d−1} − 1. Any non-positive base
// makes the chain meaningless, so the whole caliber reads
// null （暂无可比） rather than a partial product.
export function computeTimeWeightedReturn(
  points: readonly OverviewDailyPoint[],
): number | null {
  const rows = normalizeDailyPoints(points);
  if (rows.length < 2) return null;
  let product = 1;
  for (let i = 1; i < rows.length; i++) {
    const previous = rows[i - 1];
    const current = rows[i];
    if (!previous || !current) return null;
    if (!(previous.value > 0)) return null;
    const grown = current.value - current.flow;
    if (grown < 0) return null;
    product *= grown / previous.value;
  }
  const rate = product - 1;
  return Number.isFinite(rate) ? round4(rate) : null;
}

// Money-weighted return: the XIRR of the series' investor
// cash flows — opening value out, each day's external flow
// signed against the investor (a deposit is money out, a
// withdrawal money in), closing value in — discounted
// ACT/365 and solved by bisection on (−1, 10]. No sign change
// in the NPV over that bracket means no comparable rate.
export function computeMoneyWeightedReturn(
  points: readonly OverviewDailyPoint[],
): number | null {
  const rows = normalizeDailyPoints(points);
  if (rows.length < 2) return null;
  const first = rows[0];
  const last = rows[rows.length - 1];
  if (!first || !last) return null;
  if (!(first.value > 0) || last.value < 0) return null;
  const spanDays = daysBetweenDates(first.date, last.date);
  if (spanDays <= 0) return null;
  if (last.value === 0) return -1;
  const flows: Array<{ days: number; amount: number }> = [
    { days: 0, amount: -first.value },
  ];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row || row.flow === 0) continue;
    flows.push({ days: daysBetweenDates(first.date, row.date), amount: -row.flow });
  }
  flows.push({ days: spanDays, amount: last.value });
  const npv = (rate: number): number => {
    let sum = 0;
    for (const flow of flows) {
      sum += flow.amount / Math.pow(1 + rate, flow.days / 365);
    }
    return sum;
  };
  let lo = -0.9999;
  let hi = 10;
  let flo = npv(lo);
  const fhi = npv(hi);
  if (!Number.isFinite(flo) || !Number.isFinite(fhi) || flo === 0 || fhi === 0) {
    return flo === 0 ? round4(lo) : fhi === 0 ? round4(hi) : null;
  }
  if ((flo > 0 && fhi > 0) || (flo < 0 && fhi < 0)) return null;
  for (let iteration = 0; iteration < 200; iteration++) {
    const mid = (lo + hi) / 2;
    const fmid = npv(mid);
    if (!Number.isFinite(fmid)) return null;
    if (Math.abs(fmid) < 1e-9 || hi - lo < 1e-10) return round4(mid);
    if ((flo > 0 && fmid > 0) || (flo < 0 && fmid < 0)) {
      lo = mid;
      flo = fmid;
    } else {
      hi = mid;
    }
  }
  return round4((lo + hi) / 2);
}

export function buildReturnMetrics(
  points: readonly OverviewDailyPoint[],
): ReturnMetricsView {
  const rows = normalizeDailyPoints(points);
  const first = rows[0];
  const last = rows[rows.length - 1];
  return {
    twr: computeTimeWeightedReturn(rows),
    mwr: computeMoneyWeightedReturn(rows),
    startDate: first?.date ?? null,
    endDate: last?.date ?? null,
    days: first && last ? daysBetweenDates(first.date, last.date) : 0,
    twrNote: TWR_NOTE,
    mwrNote: MWR_NOTE,
  };
}

/* --------------------------- three-factor split ------------------------ */

export interface ReturnFactorsInput {
  stockPriceChange: number | null;
  optionPremium: number | null;
  dividendsInterest: number | null;
}

export interface ReturnFactorRow {
  key: "stock" | "premium" | "dividends";
  label: string;
  note: string | null;
  amount: number | null;
  share: number | null; // fraction of the interval total return
}

export interface ReturnFactorsView {
  totalReturn: number | null;
  factors: ReturnFactorRow[];
  knownSum: number | null;
  difference: number | null;
  differenceReason: string | null;
}

export function buildReturnFactors(
  points: readonly OverviewDailyPoint[],
  input: ReturnFactorsInput,
): ReturnFactorsView {
  const rows = normalizeDailyPoints(points);
  const first = rows[0];
  const last = rows[rows.length - 1];
  const netFlow = rows.slice(1).reduce((sum, row) => sum + row.flow, 0);
  const totalReturn =
    rows.length >= 2 && first && last
      ? round2(last.value - first.value - netFlow)
      : null;
  const amounts: Array<{
    key: ReturnFactorRow["key"];
    label: string;
    note: string | null;
    amount: number | null;
  }> = [
    { key: "stock", label: "股价涨跌", note: null, amount: finiteOrNull(input.stockPriceChange) },
    {
      key: "premium",
      label: OPTION_PREMIUM_FACTOR_LABEL,
      note: OPTION_PREMIUM_FACTOR_NOTE,
      amount: finiteOrNull(input.optionPremium),
    },
    {
      key: "dividends",
      label: "分红+利息",
      note: null,
      amount: finiteOrNull(input.dividendsInterest),
    },
  ];
  const allKnown = amounts.every((row) => row.amount != null);
  const knownSum = allKnown
    ? round2(amounts.reduce((sum, row) => sum + (row.amount ?? 0), 0))
    : null;
  const difference =
    totalReturn != null && knownSum != null ? round2(totalReturn - knownSum) : null;
  return {
    totalReturn,
    factors: amounts.map((row) => ({
      ...row,
      share:
        row.amount != null && totalReturn != null && totalReturn !== 0
          ? round4(row.amount / totalReturn)
          : null,
    })),
    knownSum,
    difference,
    differenceReason:
      difference != null && Math.abs(difference) > 0.01 ? FACTOR_DIFFERENCE_REASON : null,
  };
}

/* ------------------------------- freshness ----------------------------- */

export interface FreshnessInput {
  priceDateMin: string | null;
  priceDateMax: string | null;
  generatedAt: string | null; // tz-aware ISO instant
  volPanelAsOf: string | null;
}

export interface FreshnessView {
  priceDateMin: string | null;
  priceDateMax: string | null;
  generatedAt: string | null;
  volPanelAsOf: string | null;
  verified: boolean;
  unverifiedText: string;
}

export function buildFreshness(input: FreshnessInput): FreshnessView {
  const priceDateMin = isRealDateText(input.priceDateMin) ? input.priceDateMin : null;
  const priceDateMax = isRealDateText(input.priceDateMax) ? input.priceDateMax : null;
  const generatedAt =
    typeof input.generatedAt === "string" && input.generatedAt !== "" && !Number.isNaN(Date.parse(input.generatedAt))
      ? input.generatedAt
      : null;
  // A vol_panel asof may arrive as a plain date or as a full
  // ISO instant; only its calendar-date head is ever shown,
  // and only when that head is a real calendar date.
  const volPanelHead =
    typeof input.volPanelAsOf === "string" ? input.volPanelAsOf.slice(0, 10) : "";
  const volPanelAsOf = isRealDateText(volPanelHead) ? volPanelHead : null;
  return {
    priceDateMin,
    priceDateMax,
    generatedAt,
    volPanelAsOf,
    verified: priceDateMin != null && priceDateMax != null && generatedAt != null && volPanelAsOf != null,
    unverifiedText: FRESHNESS_UNVERIFIED_TEXT,
  };
}

/* ------------------------------- assembly ------------------------------ */

export interface OverviewUpgradeInput {
  dualNetWorth: DualNetWorthInput;
  actions: OverviewActionsInput;
  dailyPoints: OverviewDailyPoint[];
  factors: ReturnFactorsInput;
  freshness: FreshnessInput;
}

export interface OverviewUpgradeView {
  dualNetWorth: DualNetWorthView;
  actions: OverviewActionItem[];
  returns: ReturnMetricsView;
  factors: ReturnFactorsView;
  freshness: FreshnessView;
}

export function buildOverviewUpgrade(input: OverviewUpgradeInput): OverviewUpgradeView {
  return {
    dualNetWorth: buildDualNetWorth(input.dualNetWorth),
    actions: buildOverviewActions(input.actions),
    returns: buildReturnMetrics(input.dailyPoints),
    factors: buildReturnFactors(input.dailyPoints, input.factors),
    freshness: buildFreshness(input.freshness),
  };
}
