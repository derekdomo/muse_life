// F3.5 交易待复核队列：纯函数模块（零 import，全部导出，
// 供 validate-tx-review.mjs 直接调用真实生产函数断言）。
// 本模块自包含：不引用 recurringCharges.ts / cashFlowForecast.ts
// 的任何导出（H-SYNC-DIVERGE-001 漂移未裁决，口径独立实现）。
//
// flagReviewCandidates 把分类不确定或金额异常的交易集中为
// 待复核候选。三类 flag（同一行至多一个，按下列顺序优先）：
//   (a) UNCATEGORIZED —— category 缺失 / 为空，或已被服务端
//       回退为 "UNCATEGORIZED"（与 summarizeSpendDailyServer 的
//       既有回退口径一致：category 非非空字符串时按
//       UNCATEGORIZED 处理）。
//   (b) CATEGORY_UNCERTAIN —— category 存在但落在低可信名单
//       LOW_CONFIDENCE_CATEGORIES（泛类 / 兜底类）。
//   (c) AMOUNT_ANOMALY —— 同一归一化商户的历史（不含最近一笔）
//       笔数 ≥ AMOUNT_ANOMALY_MIN_HISTORY 时，最近一笔金额
//       （绝对值）超过 max(历史中位数 × 3, 历史 95% 分位数)。
//       reason 必带历史中位数与最近一笔两个数字。
//
// 商户归一化在本模块内独立实现：去首尾空格 + 小写 + 连续
// 空白压成一个空格（与 F3.2 的归一化规则同口径但不共用代码）。
// 无法归一出商户名的行（name / merchant 均缺失或为空）不参与
// 商户分组与异常判定，但仍可因 (a) / (b) 入队。
//
// applyCategoryRules 按已持久化规则覆盖展示分类：规则匹配 =
// 归一化商户名相等；同一商户多条规则命中时只取第一条，并
// 在 ruleNote 中标注命中条数。纯函数，不改输入。
//
// 分类结果只用于本看板展示；与 Firance 月度口径冲突时以
// Firance 为准（面板免责声明原文见客户端）。

export type TxReviewFlag = "UNCATEGORIZED" | "CATEGORY_UNCERTAIN" | "AMOUNT_ANOMALY";

export type TxReviewTransactionInput = {
  id: string;
  date: string;
  amount: number;
  name?: string | null;
  merchant?: string | null;
  category?: string | null;
};

export type TxReviewCandidate = {
  id: string;
  date: string;
  merchant: string | null;
  normalizedMerchant: string | null;
  amount: number;
  category: string | null;
  flag: TxReviewFlag;
  reason: string;
};

export type TxCategoryRuleInput = {
  normalizedMerchant: string;
  category: string;
};

export type TxRuleApplicableRow = {
  name?: string | null;
  merchant?: string | null;
  category?: string | null;
};

export type TxRuleAppliedRow<T extends TxRuleApplicableRow> = T & {
  displayCategory: string | null;
  ruleApplied: boolean;
  ruleNote: string | null;
};

// 低可信分类名单（写死，出处）：交易分类来自 Plaid
// personal_finance_category.primary（日花销流水线按 SPEC v4
// 以 primary 作为 category 提交）。其中 GENERAL_MERCHANDISE /
// GENERAL_SERVICES 是 Plaid PFC 的两个「通用」兜底大类，
// 本身不说明用途；OTHER / MISC / MISCELLANEOUS / UNKNOWN 是
// 分类管线里常见的兜底/未知标签。落在这些值的分类视为
// 「存在但不可信」，需人工确认。比较时去空格并转大写。
export const LOW_CONFIDENCE_CATEGORIES: readonly string[] = [
  "OTHER",
  "GENERAL_MERCHANDISE",
  "GENERAL_SERVICES",
  "MISC",
  "MISCELLANEOUS",
  "UNKNOWN",
];

// AMOUNT_ANOMALY 阈值常量（导出供验证脚本锚定变异点）。
export const AMOUNT_ANOMALY_MIN_HISTORY = 3;
export const AMOUNT_ANOMALY_MEDIAN_MULTIPLIER = 3;
export const AMOUNT_ANOMALY_PERCENTILE = 0.95;

export function normalizeTxMerchant(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase().replace(/\s+/g, " ");
  return normalized === "" ? null : normalized;
}

export function txMerchantOf(row: TxRuleApplicableRow): string | null {
  for (const candidate of [row.name, row.merchant]) {
    if (typeof candidate === "string" && candidate.trim() !== "") return candidate;
  }
  return null;
}

export function isLowConfidenceCategory(category: string | null | undefined): boolean {
  if (typeof category !== "string") return false;
  const key = category.trim().toUpperCase();
  return key !== "" && LOW_CONFIDENCE_CATEGORIES.includes(key);
}

export function medianOf(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid] ?? null;
  const lo = sorted[mid - 1];
  const hi = sorted[mid];
  return lo === undefined || hi === undefined ? null : (lo + hi) / 2;
}

// 最近秩（nearest-rank）分位数：升序后取第 ceil(p × n) 个（1 起）。
export function percentileOf(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil(p * sorted.length)));
  return sorted[rank - 1] ?? null;
}

// reason / 展示用金额格式：按分取整后去掉无意义的尾随零
// （100 -> "100"，10.5 -> "10.5"，10.25 -> "10.25"）。
export function formatReviewAmount(value: number): string {
  return String(Math.round(value * 100) / 100);
}

type AnomalyInfo = {
  historyCount: number;
  median: number;
  percentile95: number;
  threshold: number;
  latest: number;
};

function detectAmountAnomalies(rows: TxReviewTransactionInput[]): Map<string, AnomalyInfo> {
  const groups = new Map<string, TxReviewTransactionInput[]>();
  for (const row of rows) {
    const merchant = txMerchantOf(row);
    const normalized = merchant === null ? null : normalizeTxMerchant(merchant);
    if (normalized === null) continue;
    const list = groups.get(normalized);
    if (list) list.push(row);
    else groups.set(normalized, [row]);
  }
  const anomalies = new Map<string, AnomalyInfo>();
  for (const list of groups.values()) {
    if (list.length < AMOUNT_ANOMALY_MIN_HISTORY + 1) continue;
    const ordered = [...list].sort((a, b) =>
      a.date < b.date ? -1 : a.date > b.date ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
    );
    const latest = ordered[ordered.length - 1];
    if (!latest) continue;
    const historyAmounts = ordered.slice(0, -1).map((row) => Math.abs(row.amount));
    if (historyAmounts.length < AMOUNT_ANOMALY_MIN_HISTORY) continue;
    const median = medianOf(historyAmounts);
    const percentile95 = percentileOf(historyAmounts, AMOUNT_ANOMALY_PERCENTILE);
    if (median === null || percentile95 === null) continue;
    const threshold = Math.max(median * AMOUNT_ANOMALY_MEDIAN_MULTIPLIER, percentile95);
    const latestAbs = Math.abs(latest.amount);
    if (latestAbs > threshold) {
      anomalies.set(latest.id, {
        historyCount: historyAmounts.length,
        median,
        percentile95,
        threshold,
        latest: latestAbs,
      });
    }
  }
  return anomalies;
}

export function flagReviewCandidates(transactions: TxReviewTransactionInput[]): TxReviewCandidate[] {
  // 同一 id 只计一次（先到为准）：与日花销汇总的去重口径一致，
  // 避免重复行放大商户历史笔数。
  const seen = new Set<string>();
  const rows: TxReviewTransactionInput[] = [];
  for (const row of transactions) {
    if (!row || typeof row.id !== "string" || row.id === "") continue;
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    rows.push(row);
  }
  const anomalies = detectAmountAnomalies(rows);
  const candidates: TxReviewCandidate[] = [];
  for (const row of rows) {
    const merchant = txMerchantOf(row);
    const normalizedMerchant = merchant === null ? null : normalizeTxMerchant(merchant);
    const rawCategory = typeof row.category === "string" ? row.category : null;
    const categoryKey = rawCategory === null ? "" : rawCategory.trim().toUpperCase();
    let flag: TxReviewFlag | null = null;
    let reason = "";
    if (categoryKey === "" || categoryKey === "UNCATEGORIZED") {
      flag = "UNCATEGORIZED";
      reason = "无分类（分类缺失/为空，或已被服务端回退为 UNCATEGORIZED），需人工确认";
    } else if (isLowConfidenceCategory(rawCategory)) {
      flag = "CATEGORY_UNCERTAIN";
      reason = `分类「${rawCategory}」属于低可信泛类（兜底/通用类），需人工确认`;
    } else {
      const anomaly = anomalies.get(row.id);
      if (anomaly) {
        flag = "AMOUNT_ANOMALY";
        reason =
          `同商户历史 ${anomaly.historyCount} 笔，金额中位数 ${formatReviewAmount(anomaly.median)}，` +
          `最近一笔 ${formatReviewAmount(anomaly.latest)}，超过异常阈值 ${formatReviewAmount(anomaly.threshold)}` +
          `（中位数 ${AMOUNT_ANOMALY_MEDIAN_MULTIPLIER} 倍与 95% 分位数取大者）`;
      }
    }
    if (flag === null) continue;
    candidates.push({
      id: row.id,
      date: row.date,
      merchant,
      normalizedMerchant,
      amount: row.amount,
      category: rawCategory,
      flag,
      reason,
    });
  }
  // 队列按日期从新到旧；同日按 id 升序，结果确定性。
  candidates.sort((a, b) =>
    a.date > b.date ? -1 : a.date < b.date ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );
  return candidates;
}

export function applyCategoryRules<T extends TxRuleApplicableRow>(
  transactions: readonly T[],
  rules: readonly TxCategoryRuleInput[],
): Array<TxRuleAppliedRow<T>> {
  const rulesByMerchant = new Map<string, TxCategoryRuleInput[]>();
  for (const rule of rules) {
    if (!rule) continue;
    const normalized = normalizeTxMerchant(rule.normalizedMerchant);
    const category = typeof rule.category === "string" ? rule.category.trim() : "";
    if (normalized === null || category === "") continue;
    const entry = { normalizedMerchant: normalized, category };
    const list = rulesByMerchant.get(normalized);
    if (list) list.push(entry);
    else rulesByMerchant.set(normalized, [entry]);
  }
  return transactions.map((row) => {
    const merchant = txMerchantOf(row);
    const normalized = merchant === null ? null : normalizeTxMerchant(merchant);
    const hits = normalized === null ? undefined : rulesByMerchant.get(normalized);
    const first = hits?.[0];
    if (!first) {
      return {
        ...row,
        displayCategory: typeof row.category === "string" && row.category !== "" ? row.category : null,
        ruleApplied: false,
        ruleNote: null,
      };
    }
    return {
      ...row,
      displayCategory: first.category,
      ruleApplied: true,
      ruleNote:
        hits && hits.length > 1
          ? `已按规则自动归类为「${first.category}」（共 ${hits.length} 条规则命中，只取第一条）`
          : `已按规则自动归类为「${first.category}」`,
    };
  });
}
