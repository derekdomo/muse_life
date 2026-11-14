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
  /**
   * 在线契约别名（F3.3 安全回灌，2026-11-04，加法）：
   * space-3 生产侧输入字段为 `name`（Plaid 口径），与本仓 `merchant` 同义。
   * detectRecurringCharges 分组前取 `name ?? merchant` 归一，
   * 仅传 merchant 的既有调用行为逐字不变。
   */
  name?: string;
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
  // F3.3 日历守卫（2026-11-05）：不存在的日历日（2099-02-29/02-30、
  // 2099-04-31 等）不得滚入下月——往返比对，不存在即 NaN。本函数是
  // 识别路径的日期入口（detectRecurringCharges 只以有限性过滤），
  // 仅修 isValidDateKey 盖不住该路径；本函数文档原已承诺“非法返回
  // NaN”，此处是兑现该承诺。合法日期行为一字不变。
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return NaN;
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
    const key = normalizeMerchant(t.name ?? t.merchant);
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

/* ============================================================================
 * 双端契约适配（F3.3 安全回灌，2026-11-04）
 * ----------------------------------------------------------------------------
 * 契约分歧（已实测确认）：
 *   在线契约（space-3 生产）：输入字段 `name`；金额为 Plaid 口径（流出为正、
 *     入账为负）；周期枚举 weekly|monthly|quarterly|yearly。
 *   本仓契约（F3.2）：输入字段 `merchant`（本轮起加 `name` 别名）；
 *     金额为流出为负；周期枚举 weekly|monthly|quarterly|annual。
 * 适配原则：以下全部为加法，既有导出与 detectRecurringCharges 行为逐字不变
 * （validate-recurring-charges.mjs 26/26 仍全过）。cashFlowForecast.ts 的
 * 本仓回灌版经由本节的在线契约入口消费本仓检测逻辑。
 * ========================================================================== */

/** 在线周期枚举（space-3 生产侧） */
export type RecurringCadence = "weekly" | "monthly" | "quarterly" | "yearly";

/** 在线交易输入形状（space-3 生产侧：Plaid 口径） */
export type RecurringTransactionInput = {
  /** 交易日期，YYYY-MM-DD */
  date: string;
  /** 金额：Plaid 口径——流出为正，入账/退款为负 */
  amount: number;
  /** 商户或描述原文 */
  name: string;
  /** 可选：是否 pending */
  pending?: boolean | null;
  /** 可选：是否本人内部互转 */
  internalTransfer?: boolean | null;
  /** 可选：转账类标记 */
  transferLike?: boolean | null;
  /** 可选：方向标记（"in" | "out"，由上游标注） */
  direction?: string | null;
};

/** 在线形状的周期扣费（供 cashFlowForecast.ts 消费；完整线上形状，13 字段与 space-3 生产侧 RecurringCharge 逐字段一致——2026-11-14 F-DASH-P0-1 对齐补齐 previousAmount/annualizedCost/priceDelta/pricePercent/priceDirection 五字段） */
export type OnlineRecurringCharge = {
  /** 最新一笔 name.trim()（生产侧 merchant 语义） */
  merchant: string;
  /** 归一化商户名（分组键） */
  normalizedMerchant: string;
  /** 周期（在线枚举） */
  cadence: RecurringCadence;
  /** 认定依据笔数 */
  occurrences: number;
  /** 最近一笔金额（绝对值） */
  latestAmount: number;
  /** 上一笔金额（绝对值；由 lastAmount − priceChange.amountDelta 反推，金额 ≤2 位小数时与线上逐笔取整一致） */
  previousAmount: number;
  /** 最近一笔日期 YYYY-MM-DD */
  latestDate: string;
  /** 中位数间隔（天） */
  medianIntervalDays: number;
  /** 年化成本（最近金额 × 因子，与本仓值相同） */
  annualizedCost: number;
  /** 价格变化金额（最近 − 上一笔，与 priceChange.amountDelta 相同） */
  priceDelta: number;
  /** 价格变化比例（分数口径，与线上一致：priceDelta / previousAmount；上一笔为 0 时 null） */
  pricePercent: number | null;
  /** 价格方向（与 priceChange.direction 相同） */
  priceDirection: "up" | "down" | "flat";
  /** 下次预计扣费日 YYYY-MM-DD */
  nextExpectedDate: string;
};

/** 本仓枚举 → 在线枚举（单点转换：annual↔yearly；其余恒等） */
export function toOnlineCadence(c: Cadence): RecurringCadence {
  return c === "annual" ? "yearly" : c;
}

/** 在线枚举 → 本仓枚举（toOnlineCadence 的逆） */
export function toWarehouseCadence(c: RecurringCadence): Cadence {
  return c === "yearly" ? "annual" : c;
}

/** 在线名 normalizeMerchantName → 本仓 normalizeMerchant（同规格） */
export function normalizeMerchantName(name: string): string {
  return normalizeMerchant(name ?? "");
}

/** YYYY-MM-DD 合法性（严格真实日历校验：格式 + 月 01..12 + 日真实存在，含闰年判定；与工件侧及 Firance 本地 monthlyRecords.isValidDateKey 同一规则） */
export function isValidDateKey(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year = 0, month = 0, day = 0] = value.split("-").map(Number);
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const dt = new Date(Date.UTC(year, month - 1, day));
  return dt.getUTCFullYear() === year && dt.getUTCMonth() === month - 1 && dt.getUTCDate() === day;
}

/** 两日期键相差天数（to - from） */
export function daysBetweenDateKeys(fromKey: string, toKey: string): number {
  return dateToDayNumber(toKey) - dateToDayNumber(fromKey);
}

/** 日期键加减天数 */
export function addDaysToDateKey(dateKey: string, days: number): string {
  return dayNumberToDate(dateToDayNumber(dateKey) + Math.round(days));
}

/** 中位数；空数组/非法返回 null（在线 medianNumber 语义） */
export function medianNumber(values: number[]): number | null {
  if (!values || values.length === 0) return null;
  const m = median(values);
  return Number.isFinite(m) ? m : null;
}

/** 金额取整到分 */
export function roundMoney(value: number): number {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

/** 系统今天（YYYY-MM-DD） */
export function systemTodayKey(): string {
  return dayNumberToDate(Math.floor(Date.now() / 86400000));
}

/** 周期判定规则（在线 CadenceRule 形状；cadence 取在线枚举） */
export type CadenceRule = {
  cadence: RecurringCadence;
  minIntervalDays: number;
  maxIntervalDays: number;
  minOccurrences: number;
  annualizedFactor: number;
};

/**
 * 按中位数间隔与笔数判定周期（在线 classifyCadence 语义）。
 * 口径依据：F3.3 派工规格——同周期窗口（周 6–8/月 27–33/季 85–95/
 * 年 360–370 天）与同证据门槛（周/月/季 ≥3 笔、年 ≥2 笔）；
 * 落窗外或笔数不足返回 null。cadence 取在线枚举（annual→yearly 单点转换）。
 */
export function classifyCadence(
  medianIntervalDays: number,
  occurrences: number
): CadenceRule | null {
  if (typeof medianIntervalDays !== "number" || !Number.isFinite(medianIntervalDays))
    return null;
  const c = cadenceForMedianInterval(medianIntervalDays);
  if (!c) return null;
  if (typeof occurrences !== "number" || occurrences < MIN_OCCURRENCES[c])
    return null;
  const [lo, hi] = CADENCE_WINDOWS[c];
  return {
    cadence: toOnlineCadence(c),
    minIntervalDays: lo,
    maxIntervalDays: hi,
    minOccurrences: MIN_OCCURRENCES[c],
    annualizedFactor: ANNUALIZE_FACTOR[c],
  };
}

/**
 * 在线契约入口：接受在线形状交易（Plaid 口径），返回在线形状检测结果。
 * 适配：金额翻转（Plaid 流出为正 → 本仓流出为负）、name 归一为 merchant；
 * 内部窗口/门槛/因子逐字复用本仓 detectRecurringCharges；输出 cadence 经
 * toOnlineCadence 单点转换（annual→yearly），merchant 取最新一笔 name.trim()
 * （与生产侧输出语义一致），其余字段逐项映射。输出为完整线上形状（13 字段，
 * 与生产侧 RecurringCharge 逐字段一致；2026-11-14 F-DASH-P0-1 对齐补齐）：
 * previousAmount 由 lastAmount − amountDelta 反推（金额 ≤2 位小数时与线上
 * 逐笔取整一致）；pricePercent 为分数口径、上一笔为 0 时 null（线上语义，
 * 本仓 pctDelta 在该情形为 0，不采用）；输出顺序为年化成本降序、年化相等时
 * 按归一化商户名升序（与生产侧一致）。已知边界差异（与生产侧逐字实现相比）：
 * 同日同商户多笔时，生产侧按（日期，金额）排序取最大额为最新一笔，本仓按
 * 日期稳定排序取输入序最后一位——生产金额极少同日多笔，差异仅存于人造输入。
 */
export function detectRecurringChargesOnline(
  transactions: RecurringTransactionInput[] | null | undefined,
  options: DetectOptions = {}
): OnlineRecurringCharge[] {
  const adapted: RecurringChargeInput[] = (transactions ?? []).map((t) => ({
    date: t?.date,
    amount: typeof t?.amount === "number" ? -t.amount : t.amount,
    merchant: typeof t?.name === "string" ? t.name : "",
    pending: t?.pending ?? null,
    internalTransfer: t?.internalTransfer ?? null,
  }));
  const rows = detectRecurringCharges(adapted, options);

  // 恢复在线 merchant（最新一笔 name.trim()）：按归一化键取该组日期最大的一笔。
  const latestNameByKey = new Map<string, { dateNum: number; name: string }>();
  for (const a of adapted) {
    const key = normalizeMerchant(a.merchant ?? "");
    if (!key) continue;
    const dn = dateToDayNumber(a.date);
    if (!Number.isFinite(dn)) continue;
    const cur = latestNameByKey.get(key);
    if (!cur || dn >= cur.dateNum)
      latestNameByKey.set(key, { dateNum: dn, name: a.merchant ?? "" });
  }

  // 线上输出顺序：年化成本降序，年化相等时按归一化商户名升序（与生产侧一致）。
  return rows
    .map((r) => {
      // previousAmount 由本仓输出反推：lastAmount 与 amountDelta 均为分取整，
      // 金额 ≤2 位小数时与线上逐笔取整逐字一致；超 2 位小数的人造输入可能差 1 分。
      const previousAmount = round2(r.lastAmount - r.priceChange.amountDelta);
      return {
        merchant: (latestNameByKey.get(r.merchant)?.name ?? r.merchant).trim(),
        normalizedMerchant: r.merchant,
        cadence: toOnlineCadence(r.cadence),
        occurrences: r.occurrences,
        latestAmount: r.lastAmount,
        previousAmount,
        latestDate: r.lastDate,
        medianIntervalDays: r.medianIntervalDays,
        annualizedCost: r.annualizedCost,
        priceDelta: r.priceChange.amountDelta,
        // 线上语义：分数口径（非百分点）；上一笔为 0 时 null（本仓 pctDelta 在该情形为 0，不采用）。
        pricePercent: previousAmount === 0 ? null : r.priceChange.amountDelta / previousAmount,
        priceDirection: r.priceChange.direction,
        nextExpectedDate: r.nextExpectedDate,
      };
    })
    .sort((a, b) => {
      if (b.annualizedCost !== a.annualizedCost) return b.annualizedCost - a.annualizedCost;
      return a.normalizedMerchant.localeCompare(b.normalizedMerchant);
    });
}
