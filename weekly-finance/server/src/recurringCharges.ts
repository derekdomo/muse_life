/**
 * F3.2 订阅与周期支出体检 — 纯函数模块（零 import，全部导出供验证）。
 *
 * detectRecurringCharges(transactions, { today }): 从交易记录识别周期性扣费。
 * 只做事实呈现，不提供代取消/代谈判/自动操作。
 *
 * 口径（与 space-3 线上构建一致，同规格实现）：
 * - 商户归一化：小写、去首尾空格、压缩连续空白；不剥离订单号等可变后缀
 *   （不确定时宁可不合并，不硬凑）。
 * - 周期判定：按组内相邻交易间隔的中位数落入窗口 —
 *   按周 6–8 天、按月 27–33 天、按季 85–95 天、按年 360–370 天；
 *   落此之外为"不规律"，不列为确定性周期扣费。
 * - 证据门槛：周/月/季至少 3 笔，年至少 2 笔；不足不列出、不编造。
 * - 年化成本 = 最近一笔金额 × (周 52 / 月 12 / 季 4 / 年 1)。
 * - 价格变化 = 最近一笔 vs 上一笔：金额差 + 百分比 + 方向（涨价/降价/持平）。
 * - 下次预计扣费日 = 最近日期 + 中位数间隔（按日取整）。
 * - 排除：未来日期交易、入账/退款（正向金额）、pending、本人内部互转。
 */

export type Cadence = "weekly" | "monthly" | "quarterly" | "annual";

export interface RecurringChargeInput {
  /** 交易日期，YYYY-MM-DD */
  date: string;
  /** 金额：扣费为负，入账/退款为正（按流出为负的记账方向） */
  amount: number;
  /** 商户或描述原文 */
  merchant: string;
  /** 可选：是否 pending */
  pending?: boolean | null;
  /** 可选：是否本人内部互转 */
  internalTransfer?: boolean | null;
}

export interface PriceChange {
  /** 金额差（最近 − 上一笔），正为涨价 */
  amountDelta: number;
  /** 百分比变化（相对上一笔金额绝对值），如 12.5 表示 +12.5% */
  pctDelta: number;
  /** 方向词 */
  direction: "up" | "down" | "flat";
}

export interface RecurringCharge {
  /** 归一化商户名 */
  merchant: string;
  /** 周期 */
  cadence: Cadence;
  /** 周期中文标签 */
  cadenceLabel: string;
  /** 年化成本（最近金额 × 因子） */
  annualizedCost: number;
  /** 最近一笔金额（绝对值） */
  lastAmount: number;
  /** 最近一笔日期 YYYY-MM-DD */
  lastDate: string;
  /** 价格变化（最近 vs 上一笔） */
  priceChange: PriceChange;
  /** 下次预计扣费日 YYYY-MM-DD */
  nextExpectedDate: string;
  /** 认定依据笔数 */
  occurrences: number;
  /** 中位数间隔（天） */
  medianIntervalDays: number;
}

export interface DetectOptions {
  /** 今天 YYYY-MM-DD，用于排除未来日期；缺省取系统今天 */
  today?: string;
}

/** 周期窗口（天）：[min, max] */
export const CADENCE_WINDOWS: Record<Cadence, [number, number]> = {
  weekly: [6, 8],
  monthly: [27, 33],
  quarterly: [85, 95],
  annual: [360, 370],
};

/** 年化因子 */
export const ANNUALIZE_FACTOR: Record<Cadence, number> = {
  weekly: 52,
  monthly: 12,
  quarterly: 4,
  annual: 1,
};

/** 证据门槛（最少笔数） */
export const MIN_OCCURRENCES: Record<Cadence, number> = {
  weekly: 3,
  monthly: 3,
  quarterly: 3,
  annual: 2,
};

export const CADENCE_LABELS: Record<Cadence, string> = {
  weekly: "按周",
  monthly: "按月",
  quarterly: "按季",
  annual: "按年",
};

/** 商户归一化：小写、去首尾空格、压缩连续空白。不剥离订单号后缀。 */
export function normalizeMerchant(raw: string): string {
  return raw.toLowerCase().trim().replace(/\s+/g, " ");
}

/** YYYY-MM-DD → UTC 天数（用于间隔计算；非法返回 NaN） */
export function dateToDayNumber(dateStr: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
  if (!m) return NaN;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return NaN;
  return Math.floor(Date.UTC(y, mo - 1, d) / 86400000);
}

/** 天数 → YYYY-MM-DD */
export function dayNumberToDate(dayNum: number): string {
  const dt = new Date(dayNum * 86400000);
  const y = dt.getUTCFullYear();
  const mo = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const d = String(dt.getUTCDate()).padStart(2, "0");
  return `${y}-${mo}-${d}`;
}

/** 中位数 */
export function median(values: number[]): number {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** 按中位数间隔判定周期；落窗外返回 null */
export function cadenceForMedianInterval(medianDays: number): Cadence | null {
  for (const c of ["weekly", "monthly", "quarterly", "annual"] as Cadence[]) {
    const [lo, hi] = CADENCE_WINDOWS[c];
    if (medianDays >= lo && medianDays <= hi) return c;
  }
  return null;
}

/**
 * 识别周期性扣费。
 * 输入交易按（归一化商户）分组；每组按日期升序算相邻间隔中位数；
 * 满足周期窗口且达到证据门槛的认定为周期扣费。
 */
export function detectRecurringCharges(
  transactions: RecurringChargeInput[],
  options: DetectOptions = {}
): RecurringCharge[] {
  const todayStr =
    options.today ?? dayNumberToDate(Math.floor(Date.now() / 86400000));
  const todayNum = dateToDayNumber(todayStr);

  // 分组：只保留有效扣费（金额<0、非 pending、非内部互转、日期合法且不晚于今天）
  const groups = new Map<string, { dateNum: number; amount: number; date: string }[]>();
  for (const t of transactions) {
    if (t.pending) continue;
    if (t.internalTransfer) continue;
    if (!(t.amount < 0)) continue; // 只看流出；入账/退款/零不纳入
    const dayNum = dateToDayNumber(t.date);
    if (!Number.isFinite(dayNum)) continue;
    if (dayNum > todayNum) continue; // 未来日期不纳入
    const key = normalizeMerchant(t.merchant);
    if (!key) continue;
    const arr = groups.get(key);
    const row = { dateNum: dayNum, amount: Math.abs(t.amount), date: t.date };
    if (arr) arr.push(row);
    else groups.set(key, [row]);
  }

  const out: RecurringCharge[] = [];
  for (const [merchant, rows] of groups) {
    rows.sort((a, b) => a.dateNum - b.dateNum);
    if (rows.length < 2) continue;
    const intervals: number[] = [];
    for (let i = 1; i < rows.length; i++) {
      intervals.push(rows[i].dateNum - rows[i - 1].dateNum);
    }
    const med = median(intervals);
    if (!Number.isFinite(med)) continue;
    const cadence = cadenceForMedianInterval(med);
    if (!cadence) continue; // 不规律：不认定
    if (rows.length < MIN_OCCURRENCES[cadence]) continue; // 证据不足：不列出

    const last = rows[rows.length - 1];
    const prev = rows[rows.length - 2];
    const amountDelta = last.amount - prev.amount;
    const pctDelta =
      prev.amount === 0 ? 0 : (amountDelta / prev.amount) * 100;
    const direction: PriceChange["direction"] =
      amountDelta > 0 ? "up" : amountDelta < 0 ? "down" : "flat";

    out.push({
      merchant,
      cadence,
      cadenceLabel: CADENCE_LABELS[cadence],
      annualizedCost: round2(last.amount * ANNUALIZE_FACTOR[cadence]),
      lastAmount: round2(last.amount),
      lastDate: last.date,
      priceChange: {
        amountDelta: round2(amountDelta),
        pctDelta: round2(pctDelta),
        direction,
      },
      nextExpectedDate: dayNumberToDate(Math.round(last.dateNum + med)),
      occurrences: rows.length,
      medianIntervalDays: round2(med),
    });
  }

  // 按年化成本降序，便于面板呈现
  out.sort((a, b) => b.annualizedCost - a.annualizedCost);
  return out;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
