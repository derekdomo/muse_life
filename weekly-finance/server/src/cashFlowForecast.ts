/**
 * F3.3 未来现金流日历预测（借鉴 Monarch）— 本仓回灌版（2026-11-04）。
 *
 * 来源：space-3 生产侧 server/src/cashFlowForecast.ts（inspection 2f3f4bb7
 * 只读回读，逐字）。本仓适配（双端契约，线上零改动）：
 *  (D1) import 的 detectRecurringCharges 改为本仓
 *       detectRecurringChargesOnline（在线契约入口：Plaid 口径/字段 name/
 *       枚举 yearly → 本仓检测 → 在线形状输出），其余 helper 名称与生产侧
 *       一致（本仓 recurringCharges.ts 双端适配节提供）。
 *  其余逻辑、类型、导出、文案与生产侧逐字一致；预测起点 depositsBalance
 *  口径为调用方传入的 dashboard live.deposits（depository 余额≥0 合计），
 *     与 live.saving（净额）不同。
 *
 * 以下为生产侧原文（含其文件头注释）：
 */

// F3.3 未来现金流日历预测（借鉴 Monarch）：纯函数模块，全部导出，
// 供 validate-cash-flow-forecast.mjs 直接调用真实生产函数断言。
// 唯一的 import 是同目录的 F3.2 纯函数模块 recurringCharges.ts
// （其本身零 import、无副作用）——周期支出口径直接调用其
// detectRecurringCharges，不复制、不改其行为。
//
// forecastCashFlow 从已识别的周期收支与当前存款余额出发，生成
// 未来 horizonDays（缺省 90）天的逐日预计余额：每条周期项以
// nextExpectedDate（最近日期 + 中位间隔）为首次落点（落点早于
// today 时按间隔继续步进到 today 及以后），按 medianIntervalDays
// 等步长步进至 horizon 末日，落点金额取最近金额（收入为正、
// 支出为负）；逐日 delta 为当天落点金额之和，余额自
// depositsBalance 起累加（day1 = today，期初即今日余额）。
// 这是基于历史周期的推断，不是承诺：证据不足的商户不列出、
// 不编造；未来日期（晚于 today）的交易不纳入任何识别。
//
// 周期收入 detectRecurringIncome 与 F3.2 扣费识别对称：
//   入账 = Plaid 口径金额 < 0（钱进来），金额取其绝对值；
//   排除 pending、internalTransfer 本人互转、direction "out"、
//   未来日期；退款/冲正的识别信号只取现有字段能支撑的一条——
//   同一归一化商户在窗口内同时出现过合格扣费（金额 > 0 的
//   流出）时，其入账按退款/冲正处理并排除（向你收钱的商户
//   退钱回来不是收入；纯收入来源如工资发放方从不以扣费商户
//   身份出现）。不确定时宁可不列，与 F3.2 的保守口径一致。
//   周期窗口与证据门槛与扣费完全相同（CADENCE_RULES：
//   周 6–8 天 / 月 27–33 天 / 季 85–95 天 / 年 360–370 天；
//   周/月/季 ≥3 笔、年 ≥2 笔）。
//
// depositsBalance 口径由调用方（buildDashboard）传入：
// dashboard live.deposits —— 账户类（depository）条目中余额
// ≥ 0 者的合计，即当前存款余额事实字段；live.saving 是
// deposits − loans 的净额，不是存款余额，不用作预测起点。

import {
  addDaysToDateKey,
  classifyCadence,
  daysBetweenDateKeys,
  detectRecurringChargesOnline as detectRecurringCharges,
  isValidDateKey,
  medianNumber,
  normalizeMerchantName,
  roundMoney,
  systemTodayKey,
  type RecurringCadence,
  type RecurringTransactionInput,
} from "./recurringCharges";

export type { RecurringCadence, RecurringTransactionInput };

export type ForecastItemKind = "income" | "expense";

export type RecurringIncome = {
  merchant: string;
  normalizedMerchant: string;
  cadence: RecurringCadence;
  occurrences: number;
  latestAmount: number;
  latestDate: string;
  medianIntervalDays: number;
  nextExpectedDate: string;
};

export type ForecastDayItem = {
  merchant: string;
  amount: number;
  kind: ForecastItemKind;
};

export type ForecastDay = {
  date: string;
  delta: number;
  balance: number;
  items: ForecastDayItem[];
};

export type ForecastAssumption = {
  merchant: string;
  kind: ForecastItemKind;
  cadence: RecurringCadence;
  cadenceLabel: string;
  amount: number;
  occurrences: number;
  medianIntervalDays: number;
  nextExpectedDate: string;
  basisText: string;
};

export type CashFlowForecast = {
  startDate: string;
  horizonDays: number;
  startBalance: number;
  days: ForecastDay[];
  lowPoint: { date: string; balance: number };
  assumptions: ForecastAssumption[];
};

export type ForecastCashFlowInput = {
  transactions: RecurringTransactionInput[];
  depositsBalance: number;
  today?: string;
  horizonDays?: number;
};

export function forecastCadenceLabel(cadence: RecurringCadence): string {
  if (cadence === "weekly") return "按周";
  if (cadence === "monthly") return "按月";
  if (cadence === "quarterly") return "按季";
  return "按年";
}

export function formatIntervalDays(medianIntervalDays: number): string {
  return Number.isInteger(medianIntervalDays) ? String(medianIntervalDays) : medianIntervalDays.toFixed(1);
}

export function forecastBasisText(occurrences: number, medianIntervalDays: number): string {
  return `基于 ${occurrences} 笔历史记录、中位间隔 ${formatIntervalDays(medianIntervalDays)} 天推断`;
}

// A valid outflow (charge-side) transaction under the F3.2
// validity rules except the sign: used only to mark merchants
// whose inflows are refunds/reversals rather than income.
export function isOutflowTransaction(txn: RecurringTransactionInput, todayKey: string): boolean {
  if (!txn || typeof txn.name !== "string" || txn.name.trim() === "") return false;
  if (typeof txn.date !== "string" || !isValidDateKey(txn.date)) return false;
  if (typeof txn.amount !== "number" || !Number.isFinite(txn.amount)) return false;
  if (txn.date > todayKey) return false;
  if (txn.amount <= 0) return false;
  if (txn.pending === true) return false;
  if (txn.internalTransfer === true) return false;
  if (txn.direction === "in") return false;
  return true;
}

export function isIncomeTransaction(txn: RecurringTransactionInput, todayKey: string): boolean {
  if (!txn || typeof txn.name !== "string" || txn.name.trim() === "") return false;
  if (typeof txn.date !== "string" || !isValidDateKey(txn.date)) return false;
  if (typeof txn.amount !== "number" || !Number.isFinite(txn.amount)) return false;
  if (txn.date > todayKey) return false;
  if (txn.amount >= 0) return false;
  if (txn.pending === true) return false;
  if (txn.internalTransfer === true) return false;
  if (txn.direction === "out") return false;
  return true;
}

export function detectRecurringIncome(
  transactions: RecurringTransactionInput[],
  options?: { today?: string },
): RecurringIncome[] {
  const todayKey = options?.today && isValidDateKey(options.today) ? options.today : systemTodayKey();
  const chargeMerchants = new Set<string>();
  for (const txn of transactions ?? []) {
    if (isOutflowTransaction(txn, todayKey)) chargeMerchants.add(normalizeMerchantName(txn.name));
  }
  const groups = new Map<string, RecurringTransactionInput[]>();
  for (const txn of transactions ?? []) {
    if (!isIncomeTransaction(txn, todayKey)) continue;
    const key = normalizeMerchantName(txn.name);
    if (key === "") continue;
    if (chargeMerchants.has(key)) continue;
    const rows = groups.get(key);
    if (rows) rows.push(txn);
    else groups.set(key, [txn]);
  }
  const results: RecurringIncome[] = [];
  for (const [normalizedMerchant, rows] of groups) {
    const sorted = [...rows].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.amount - b.amount));
    if (sorted.length < 2) continue;
    const intervals: number[] = [];
    for (let i = 1; i < sorted.length; i += 1) {
      const prev = sorted[i - 1];
      const curr = sorted[i];
      if (!prev || !curr) continue;
      intervals.push(daysBetweenDateKeys(prev.date, curr.date));
    }
    const medianInterval = medianNumber(intervals);
    if (medianInterval == null) continue;
    const rule = classifyCadence(medianInterval, sorted.length);
    if (!rule) continue;
    const latest = sorted[sorted.length - 1];
    if (!latest) continue;
    results.push({
      merchant: latest.name.trim(),
      normalizedMerchant,
      cadence: rule.cadence,
      occurrences: sorted.length,
      latestAmount: roundMoney(-latest.amount),
      latestDate: latest.date,
      medianIntervalDays: medianInterval,
      nextExpectedDate: addDaysToDateKey(latest.date, Math.round(medianInterval)),
    });
  }
  results.sort((a, b) => {
    if (b.latestAmount !== a.latestAmount) return b.latestAmount - a.latestAmount;
    return a.normalizedMerchant.localeCompare(b.normalizedMerchant);
  });
  return results;
}

// Landing dates for one recurring item inside [fromDate, toDate]:
// start at nextExpectedDate, first stepping forward by the
// interval until the date reaches fromDate, then keep stepping
// while inside the window. The step is at least 1 day so a
// degenerate interval can never loop forever.
export function recurringLandingDates(
  nextExpectedDate: string,
  medianIntervalDays: number,
  fromDate: string,
  toDate: string,
): string[] {
  const step = Math.max(1, Math.round(medianIntervalDays));
  let cursor = nextExpectedDate;
  let guard = 0;
  while (cursor < fromDate && guard < 10000) {
    cursor = addDaysToDateKey(cursor, step);
    guard += 1;
  }
  const dates: string[] = [];
  guard = 0;
  while (cursor <= toDate && guard < 10000) {
    dates.push(cursor);
    cursor = addDaysToDateKey(cursor, step);
    guard += 1;
  }
  return dates;
}

export function forecastCashFlow(input: ForecastCashFlowInput): CashFlowForecast {
  const todayKey = input.today && isValidDateKey(input.today) ? input.today : systemTodayKey();
  const horizonRaw = typeof input.horizonDays === "number" && Number.isFinite(input.horizonDays)
    ? Math.round(input.horizonDays)
    : 90;
  const horizonDays = Math.min(366, Math.max(1, horizonRaw));
  const startBalance = roundMoney(
    typeof input.depositsBalance === "number" && Number.isFinite(input.depositsBalance) ? input.depositsBalance : 0,
  );
  const endDate = addDaysToDateKey(todayKey, horizonDays - 1);
  const transactions = input.transactions ?? [];
  const charges = detectRecurringCharges(transactions, { today: todayKey });
  const incomes = detectRecurringIncome(transactions, { today: todayKey });

  const itemsByDate = new Map<string, ForecastDayItem[]>();
  const assumptions: ForecastAssumption[] = [];
  const place = (merchant: string, amount: number, kind: ForecastItemKind, nextExpectedDate: string, medianIntervalDays: number) => {
    for (const date of recurringLandingDates(nextExpectedDate, medianIntervalDays, todayKey, endDate)) {
      const item: ForecastDayItem = { merchant, amount, kind };
      const rows = itemsByDate.get(date);
      if (rows) rows.push(item);
      else itemsByDate.set(date, [item]);
    }
  };
  for (const charge of charges) {
    const amount = roundMoney(-charge.latestAmount);
    place(charge.merchant, amount, "expense", charge.nextExpectedDate, charge.medianIntervalDays);
    assumptions.push({
      merchant: charge.merchant,
      kind: "expense",
      cadence: charge.cadence,
      cadenceLabel: forecastCadenceLabel(charge.cadence),
      amount,
      occurrences: charge.occurrences,
      medianIntervalDays: charge.medianIntervalDays,
      nextExpectedDate: charge.nextExpectedDate,
      basisText: forecastBasisText(charge.occurrences, charge.medianIntervalDays),
    });
  }
  for (const income of incomes) {
    const amount = roundMoney(income.latestAmount);
    place(income.merchant, amount, "income", income.nextExpectedDate, income.medianIntervalDays);
    assumptions.push({
      merchant: income.merchant,
      kind: "income",
      cadence: income.cadence,
      cadenceLabel: forecastCadenceLabel(income.cadence),
      amount,
      occurrences: income.occurrences,
      medianIntervalDays: income.medianIntervalDays,
      nextExpectedDate: income.nextExpectedDate,
      basisText: forecastBasisText(income.occurrences, income.medianIntervalDays),
    });
  }
  assumptions.sort((a, b) => {
    const byMagnitude = Math.abs(b.amount) - Math.abs(a.amount);
    if (byMagnitude !== 0) return byMagnitude;
    if (a.kind !== b.kind) return a.kind === "expense" ? -1 : 1;
    return a.merchant.localeCompare(b.merchant);
  });

  const days: ForecastDay[] = [];
  let balance = startBalance;
  let lowPoint: { date: string; balance: number } = { date: todayKey, balance: startBalance };
  for (let offset = 0; offset < horizonDays; offset += 1) {
    const date = addDaysToDateKey(todayKey, offset);
    const items = itemsByDate.get(date) ?? [];
    const delta = roundMoney(items.reduce((sum, item) => sum + item.amount, 0));
    balance = roundMoney(balance + delta);
    days.push({ date, delta, balance, items });
    if (balance < lowPoint.balance) lowPoint = { date, balance };
  }
  return { startDate: todayKey, horizonDays, startBalance, days, lowPoint, assumptions };
}
