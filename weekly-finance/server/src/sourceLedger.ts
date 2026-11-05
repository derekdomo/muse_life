// F0.5 本体（服务端四源台账）：纯函数模块（零 import，全部导出，
// 供 validate-source-ledger.mjs 直接调用真实生产函数断言）。
// 本模块自包含：不引用 recurringCharges.ts / cashFlowForecast.ts
// / txReviewQueue.ts 的任何导出（H-SYNC-DIVERGE-001 漂移未裁决，
// 口径独立实现）。
//
// buildSourceLedger 从 getDashboard 已解析读回的存储快照（合法
// 保存读回的事实）＋刷新状态行的本次尝试状态，派生四源台账：
//   (1) Firance 本地月度记录 (2) Plaid 账户（银行余额）
//   (3) Plaid 交易 (4) Plaid 持仓。
// 每行把两组事实严格分列：
//   - 最后可用事实：成功证据（evidence/evidenceText)、数据日期
//     (dataDate)、实际覆盖（coverage)、最后成功时间
//     (lastSuccessAt)——只来自已保存快照自身携带的证据；
//   - 本次尝试结果（attempt/attemptText)——只来自刷新状态，
//     与最后可用事实互不覆盖：尝试失败时 attempt 如实写失败，
//     最后可用事实一字不改（失败保旧）；交易源的尝试结果平台
//     不提供逐源时间戳，恒为未知，不连累余额等其它源的事实
//     与尝试（交易失败不阻断余额刷新）。
//
// F0.5 逐源溯源修复（2026-11-05）：逐源「最后成功时间」只认
// 该源自身携带的成功时间证据（facts.sourceSuccessAt，逐源独
// 立）；总快照 asOf 只是总快照的生成/保存时间（snapshotAsOf)，
// 永不充当任何一源的成功时间——总 asOf 推进而来源事实不变时，
// 逐源时间一字不动。本地沿用事实（live=false）与 Plaid 同步
// 成功分开陈述：账户行原有的 verified / status 随事实保留进
// 台账，沿用未核实（verified=false 或 status 为 unverified /
// carried_forward_unverified）的银行行不得标 proven/已证明。
//
// 诚实规则（与既有 F0.5 呈现口径同一纪律，服务端为唯一计算点）:
//   - 空库 / 无快照：每行无成功证据，日期未知、范围未取得，
//     任何一行不得声称已保存；
//   - 缺失 / 无效日期永不填成成功或 0：余额日期只有通过严格
//     合法性校验（YYYY-MM 合法月份，或真实存在的 YYYY-MM-DD)
//     才算日期证据；存在但非法的日期单独计为「日期无效」;
//     快照 asOf 本身非法时最后成功时间为 null（未知），
//     不拿它给任何一源充当数据日期；
//   - 真实 0 是事实：余额为 0 的账户行照常计入覆盖分母与
//     成功证据，不因金额为 0 被当作缺失；
//   - 部分 / 过期如实分级：证据状态分 proven（已证明）/
//     partial（部分：日期覆盖不全、余额日期早于快照月份
//     = 沿用旧日期、或仅 Top 10 摘要）/ missing（无成功
//     证据）/ unknown（平台不提供该源证据，如交易逐源结果）;
//   - 依赖交易的推断明确降级：支出依据未证明的月份，其灵活
//     支出等依赖交易的推断在交易行 degraded 中逐项点名降级，
//     不得以完整覆盖结论呈现；
//   - 含义由符号（✓/◑/○/?)+ 文字标签 + 数字承载（色弱规则），
//     从不只靠颜色——本模块只产出文本与符号，无颜色语义。
//
// 本模块不读数据库、不写任何存储：输入是调用方（getDashboard)
// 已读回的快照事实，输出是台账视图。L0.1 例外维持原样：本
// 台账只经 getDashboard 的严格所有者门禁对外，访客恒为 null。

export type SourceLedgerKey =
  | "firance"
  | "plaid_accounts"
  | "plaid_transactions"
  | "plaid_holdings";

export type SourceLedgerEvidenceState = "proven" | "partial" | "missing" | "unknown";

export type SourceLedgerAttemptState =
  | "saved"
  | "running"
  | "failed_kept"
  | "not_obtained"
  | "not_provided"
  | "unknown";

export type SourceLedgerRefreshStatus = "idle" | "running" | "error";

export type SourceLedgerMonthFact = {
  key: string;
  // "partial" | "complete" | "unknown"（或旧 payload 缺失 -> null)
  integrity: string | null;
  spendProven: boolean;
  incomeProven: boolean;
  contributionProven: boolean;
};

export type SourceLedgerAccountFact = {
  type: string;
  live: boolean;
  balanceDate: string | null;
  // 余额本身只用于「真实 0 仍是事实」的判定输入：0 与缺失
  // （null）严格区分。台账不呈现金额，此字段不进任何文案数字
  // 之外的计算。
  value: number | null;
  // F0.5 溯源修复：账户行原有的核实事实随行保留——verified
  // （null = 未提供，旧载荷的常态）与原始 status 字符串（如
  // carried_forward_unverified)。缺失即未提供，永不回填为
  // 已核实；任一银行行沿用未核实都会阻止银行源标 proven。
  verified?: boolean | null;
  status?: string | null;
};

export type SourceLedgerFacts = {
  // 总快照的生成/保存时刻（ISO)——只称总快照时间，永不充当
  // 任何一源的最后成功时间。非法/缺失时 snapshotAsOf 为
  // null，绝不回填。
  asOf: string | null;
  // F0.5 溯源修复：逐源成功时间证据——只有当载荷自身为某一
  // 源携带了独立的成功时刻时才在此给出；缺失的源其最后成功
  // 时间为 null（未知）。现行载荷不携带逐源时刻，故生产读回
  // 恒为空——不由总 asOf、刷新状态时间或余额日期补造。
  sourceSuccessAt?: Partial<Record<SourceLedgerKey, string | null>>;
  sourceMonth: string | null;
  months: SourceLedgerMonthFact[];
  accounts: SourceLedgerAccountFact[];
  holdingsSummaryCount: number;
  holdingsAllCount: number;
  holdingsTotal: number | null;
  holdingsComplete: boolean;
};

export type SourceLedgerRow = {
  key: SourceLedgerKey;
  label: string;
  evidence: SourceLedgerEvidenceState;
  evidenceSymbol: string;
  evidenceLabel: string;
  evidenceText: string;
  dataDate: string;
  coverage: string;
  lastSuccessAt: string | null;
  attempt: SourceLedgerAttemptState;
  attemptText: string;
  degraded: string[];
};

export type SourceLedger = {
  // 总快照时间（总快照自身的生成/保存时刻）——与逐源最后
  // 成功时间严格分列，命名不冒充任何一源的成功时间。
  snapshotAsOf: string | null;
  rows: SourceLedgerRow[];
};

export const SOURCE_LEDGER_ORDER: SourceLedgerKey[] = [
  "firance",
  "plaid_accounts",
  "plaid_transactions",
  "plaid_holdings",
];

export const SOURCE_LEDGER_LABELS: Record<SourceLedgerKey, string> = {
  firance: "本地月度记录",
  plaid_accounts: "银行余额",
  plaid_transactions: "交易",
  plaid_holdings: "持仓",
};

export const SOURCE_LEDGER_EVIDENCE_META: Record<
  SourceLedgerEvidenceState,
  { symbol: string; label: string }
> = {
  proven: { symbol: "✓", label: "已证明" },
  partial: { symbol: "◑", label: "部分" },
  missing: { symbol: "○", label: "无成功证据" },
  unknown: { symbol: "?", label: "未知" },
};

// 交易源的本次尝试结果：平台不提供逐源时间戳/逐源结果，恒为
// 未知——与客户端既有呈现口径逐字一致。
export const TRANSACTIONS_ATTEMPT_TEXT = "未知（平台未提供逐源结果）";

// 真实日历日校验（与客户端 isRealDateText / 服务端
// isRealDateKey 同一规则：格式 + 月 01..12 + 日真实存在，
// 含闰年判定；用 UTC 构造避免时区漂移）。
export function isRealDateText(value: string): boolean {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(0, 0, 0, 0);
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

// 严格余额日期证据规则（与服务端 normalizeBalanceDate / 客户
// 端 isValidBalanceDateText 同一口径）：YYYY-MM 且月份 01..12，
// 或真实存在的 YYYY-MM-DD。缺失、空串、格式错误、非法月份
// （2025-13/2025-14）、非法日期（2026-02-30）都不是证据。
export function isLegalBalanceDateText(value: string | null | undefined): boolean {
  if (value == null || value === "") return false;
  if (/^\d{4}-\d{2}$/.test(value)) {
    const month = Number(value.slice(5, 7));
    return month >= 1 && month <= 12;
  }
  return isRealDateText(value);
}

// 从 ISO 时刻取其日期部分；日期部分不是真实日历日（或输入
// 缺失/过短）时返回 null——非法 asOf 绝不充当成功时间。
export function datePartOfInstant(value: string | null | undefined): string | null {
  if (value == null || value.length < 10) return null;
  const part = value.slice(0, 10);
  return isRealDateText(part) ? part : null;
}

// 合法保存读回的总快照时间：asOf 日期部分合法才返回 asOf
// 原文，否则 null（未知）——不修复、不回填。
export function lastSuccessInstant(asOf: string | null | undefined): string | null {
  return datePartOfInstant(asOf) != null ? (asOf as string) : null;
}

// 逐源成功时间：只取该源自身携带的成功时刻证据，经同一合
// 法性校验；缺失/非法 -> null（未知）。总快照 asOf、刷新状
// 态时间与余额日期永不作逐源成功时间的来源。
export function sourceSuccessInstant(
  facts: SourceLedgerFacts,
  key: SourceLedgerKey,
): string | null {
  return lastSuccessInstant(facts.sourceSuccessAt?.[key] ?? null);
}

// 沿用未核实判定（与 actions.ts entryUnverified /
// isUnverifiedStatus 同一口径，本模块自包含实现）：显式
// verified=false，或原始 status 为 unverified /
// carried_forward_unverified。verified/status 未提供
// （null/缺失，旧载荷）不算未核实——未知不造标记。
export function accountUnverified(account: SourceLedgerAccountFact): boolean {
  return (
    account.verified === false ||
    account.status === "unverified" ||
    account.status === "carried_forward_unverified"
  );
}

// 金额文案（仅用于持仓分母）：en-US 千分位 + 两位小数上限，
// 与页面既有 currency 格式同形。null/非有限数 -> null。
export function formatLedgerAmount(value: number | null | undefined): string | null {
  if (value == null || !Number.isFinite(value)) return null;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(value);
}

// 余额来源构成（与客户端 balanceSourceSummary 同一口径）：
// 只计 type "account" / "investment" 的余额行；收入/支出等
// 条目永不计入账户数或余额覆盖。
export function balanceCoverageText(accounts: SourceLedgerAccountFact[]): string {
  const balanceAccounts = accounts.filter(
    (account) => account.type === "account" || account.type === "investment",
  );
  if (balanceAccounts.length === 0) return "未提供";
  const liveCount = balanceAccounts.filter((account) => account.live).length;
  const snapshotCount = balanceAccounts.length - liveCount;
  if (snapshotCount === 0) return `全部 ${liveCount} 个余额账户为同步读取值`;
  if (liveCount === 0) return `全部 ${snapshotCount} 个余额账户沿用月度快照值`;
  return `${liveCount} 个余额账户为同步读取值，${snapshotCount} 个余额账户沿用月度快照值`;
}

export type BankDateCoverage = {
  total: number;
  known: number;
  unknown: number;
  invalid: number;
  stale: number;
  dates: string[];
  dataDate: string;
};

// 银行行日期覆盖：分母恒为全部 type "account" 行（真实 0 余额
// 行照常计入）；日期已知只认严格合法日期；存在但非法的日期
// 单独计「日期无效」；缺失/空计「日期未知」；合法日期的月份
// 早于快照月份的计「沿用旧日期」（stale)。陈述日期/区间只由
// 合法日期构成，永不从快照 asOf 或快照月份回填。
export function bankDateCoverage(
  accounts: SourceLedgerAccountFact[],
  sourceMonth: string | null,
): BankDateCoverage {
  const bankRows = accounts.filter((account) => account.type === "account");
  const datedRows = bankRows.filter((account) => isLegalBalanceDateText(account.balanceDate));
  const invalid = bankRows.filter(
    (account) =>
      account.balanceDate != null &&
      account.balanceDate !== "" &&
      !isLegalBalanceDateText(account.balanceDate),
  ).length;
  const unknown = bankRows.length - datedRows.length - invalid;
  const dates = [...new Set(datedRows.map((account) => account.balanceDate as string))].sort();
  const sourceMonthPart =
    sourceMonth != null && isLegalBalanceDateText(sourceMonth) ? sourceMonth.slice(0, 7) : null;
  const stale =
    sourceMonthPart == null
      ? 0
      : datedRows.filter(
          (account) => (account.balanceDate as string).slice(0, 7) < sourceMonthPart,
        ).length;
  const coverage = `日期已知 ${datedRows.length}/${bankRows.length}`;
  const gapNotes: string[] = [];
  if (unknown > 0) gapNotes.push(`其余 ${unknown} 个账户日期未知`);
  if (invalid > 0) gapNotes.push(`${invalid} 个账户日期无效`);
  const gapNote = gapNotes.join("；");
  let dataDate: string;
  if (bankRows.length === 0 || datedRows.length === 0) {
    dataDate =
      bankRows.length === 0 ? "未知" : `未知（${coverage}；${gapNote}）`;
  } else if (dates.length === 1) {
    const only = dates[0] as string;
    dataDate = gapNote === "" ? `${only}（${coverage}）` : `${only}（${coverage}；${gapNote}）`;
  } else {
    const span = `${dates[0]} 至 ${dates[dates.length - 1]}（各账户余额日期不一致；${coverage}`;
    dataDate = gapNote === "" ? `${span}）` : `${span}；${gapNote}）`;
  }
  return {
    total: bankRows.length,
    known: datedRows.length,
    unknown,
    invalid,
    stale,
    dates,
    dataDate,
  };
}

// 本次尝试结果（落盘三源共用；与客户端既有口径逐字一致）。
// 与最后可用事实严格分列：此函数只读刷新状态与「是否有已
// 保存数据」，永不读、永不改任何一源的事实字段。
export function sourceAttemptFor(
  refreshStatus: SourceLedgerRefreshStatus,
  hasData: boolean,
): { attempt: SourceLedgerAttemptState; attemptText: string } {
  if (!hasData) {
    if (refreshStatus === "running")
      return { attempt: "not_obtained", attemptText: "本次更新进行中，尚未取得，尚无成功快照" };
    if (refreshStatus === "error")
      return { attempt: "not_obtained", attemptText: "本次未成功，未取得，尚无成功快照" };
    return { attempt: "not_obtained", attemptText: "未取得（尚无成功快照）" };
  }
  if (refreshStatus === "running")
    return { attempt: "running", attemptText: "本次更新进行中，尚未落盘保存" };
  if (refreshStatus === "error")
    return {
      attempt: "failed_kept",
      attemptText: "本次未成功，未写入新数据，保留上次成功数据",
    };
  return { attempt: "saved", attemptText: "已落盘保存（当前显示即已保存范围）" };
}

// 依赖交易的推断降级清单（交易行 degraded)：
//   - 支出依据未证明的月份：灵活支出回算等依赖交易的推断
//     按降级口径，点名月份；
//   - 支出已证明但完整性未核实（收入/投入依据未齐）的月份：
//     完整性结论降级，点名月份。
// 两类互不重叠（未证明支出者只进第一类）。无降级时为空数组。
export function transactionDegradations(months: SourceLedgerMonthFact[]): string[] {
  const unproven = months
    .filter((month) => !month.spendProven)
    .map((month) => month.key.slice(0, 7));
  const unverified = months
    .filter((month) => month.spendProven && month.integrity !== "complete")
    .map((month) => month.key.slice(0, 7));
  const degraded: string[] = [];
  if (unproven.length > 0) {
    degraded.push(
      `支出依据未证明的月份（${unproven.join("、")}）：灵活支出等依赖交易的推断为降级口径，不作完整交易覆盖结论`,
    );
  }
  if (unverified.length > 0) {
    degraded.push(
      `完整性未核实的月份（${unverified.join("、")}）：收入/投入依据未齐，依赖交易的完整性推断降级为未核实`,
    );
  }
  return degraded;
}

function evidenceMeta(state: SourceLedgerEvidenceState): { symbol: string; label: string } {
  return SOURCE_LEDGER_EVIDENCE_META[state];
}

// 四源台账本体。facts 为 null = 空库/尚无成功快照：四行全部
// 无成功证据（日期未知、范围未取得、最后成功时间 null)，
// 本次尝试只陈述未取得，任何一行不得声称已保存。
export function buildSourceLedger(
  facts: SourceLedgerFacts | null,
  refreshStatus: SourceLedgerRefreshStatus,
): SourceLedger {
  const hasData = facts != null;
  const snapshotAsOf = hasData ? lastSuccessInstant(facts.asOf) : null;
  const attemptShared = sourceAttemptFor(refreshStatus, hasData);

  if (!facts) {
    const rows: SourceLedgerRow[] = SOURCE_LEDGER_ORDER.map((key) => {
      const isTransactions = key === "plaid_transactions";
      return {
        key,
        label: SOURCE_LEDGER_LABELS[key],
        evidence: "missing" as SourceLedgerEvidenceState,
        evidenceSymbol: evidenceMeta("missing").symbol,
        evidenceLabel: evidenceMeta("missing").label,
        evidenceText: "成功证据：尚无成功保存的快照",
        dataDate: "未知",
        coverage: "未取得",
        lastSuccessAt: null,
        attempt: isTransactions ? "unknown" : attemptShared.attempt,
        attemptText: isTransactions ? TRANSACTIONS_ATTEMPT_TEXT : attemptShared.attemptText,
        degraded: [],
      };
    });
    return { snapshotAsOf: null, rows };
  }

  const months = [...facts.months].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const first = months[0];
  const last = months[months.length - 1];

  // ---- (1) Firance 本地月度记录 ----
  const firanceHas = months.length > 0;
  const firanceEvidence: SourceLedgerEvidenceState = firanceHas ? "proven" : "missing";
  const firanceDataDate =
    firanceHas && isLegalBalanceDateText(facts.sourceMonth)
      ? (facts.sourceMonth as string)
      : "未知";
  const firanceRow: SourceLedgerRow = {
    key: "firance",
    label: SOURCE_LEDGER_LABELS.firance,
    evidence: firanceEvidence,
    evidenceSymbol: evidenceMeta(firanceEvidence).symbol,
    evidenceLabel: evidenceMeta(firanceEvidence).label,
    evidenceText: firanceHas
      ? `成功证据：存储快照经服务端合法保存读回，共 ${months.length} 份月度记录`
      : "成功证据：尚无成功保存的月度快照",
    dataDate: firanceDataDate,
    coverage:
      first && last
        ? `${first.key} 至 ${last.key} · 共 ${months.length} 份月度快照`
        : "未取得",
    lastSuccessAt: firanceHas ? sourceSuccessInstant(facts, "firance") : null,
    attempt: attemptShared.attempt,
    attemptText: attemptShared.attemptText,
    degraded: [],
  };

  // ---- (2) Plaid 账户（银行余额）----
  const bank = bankDateCoverage(facts.accounts, facts.sourceMonth);
  const balanceAccounts = facts.accounts.filter(
    (account) => account.type === "account" || account.type === "investment",
  );
  const zeroBalanceCount = facts.accounts.filter(
    (account) => account.type === "account" && account.value === 0,
  ).length;
  // F0.5 溯源修复：银行行的已保存事实按来源分开陈述——Plaid
  // 同步读取值（live) 与本地月度快照沿用值分列；沿用未核实
  // 的行单独点名，且只要有一行沿用未核实，银行源不得标
  // proven（本地沿用事实存在 ≠ 该源 Plaid 同步成功已证明）。
  const bankRowsAll = facts.accounts.filter((account) => account.type === "account");
  const carriedBankCount = bankRowsAll.filter((account) => !account.live).length;
  const unverifiedBankCount = bankRowsAll.filter((account) => accountUnverified(account)).length;
  const bankProven =
    bank.total > 0 && bank.known === bank.total && bank.stale === 0 && unverifiedBankCount === 0;
  const bankEvidence: SourceLedgerEvidenceState =
    bank.total === 0 ? "missing" : bankProven ? "proven" : "partial";
  const bankEvidenceParts: string[] = [];
  if (bank.total > 0) {
    bankEvidenceParts.push(`已保存 ${bank.total} 个银行账户余额行`);
    if (zeroBalanceCount > 0) {
      bankEvidenceParts.push(`其中 ${zeroBalanceCount} 个账户余额为真实 0（计入覆盖）`);
    }
    if (carriedBankCount > 0) {
      bankEvidenceParts.push(
        `${carriedBankCount} 个账户沿用本地月度快照值（非 Plaid 同步读取，本地已保存事实与同步成功分开陈述）`,
      );
    }
    if (unverifiedBankCount > 0) {
      bankEvidenceParts.push(
        `${unverifiedBankCount} 个账户沿用未核实（verified=false 或状态为沿用未核实标记），不计为该源同步成功已证明`,
      );
    }
    if (bank.stale > 0) {
      bankEvidenceParts.push(`${bank.stale} 个账户余额日期早于快照月份（沿用旧日期）`);
    }
  }
  const bankRow: SourceLedgerRow = {
    key: "plaid_accounts",
    label: SOURCE_LEDGER_LABELS.plaid_accounts,
    evidence: bankEvidence,
    evidenceSymbol: evidenceMeta(bankEvidence).symbol,
    evidenceLabel: evidenceMeta(bankEvidence).label,
    evidenceText:
      bank.total > 0
        ? `成功证据：${bankEvidenceParts.join("；")}`
        : "成功证据：未保存银行账户余额行",
    dataDate: bank.dataDate,
    coverage: balanceCoverageText(facts.accounts),
    lastSuccessAt: bank.total > 0 ? sourceSuccessInstant(facts, "plaid_accounts") : null,
    attempt:
      balanceAccounts.length > 0 ? attemptShared.attempt : "not_provided",
    attemptText:
      balanceAccounts.length > 0 ? attemptShared.attemptText : "未提供",
    degraded: [],
  };

  // ---- (3) Plaid 交易 ----
  const provenMonths = months.filter((month) => month.spendProven);
  const provenKeys = provenMonths.map((month) => month.key.slice(0, 7));
  const txEvidence: SourceLedgerEvidenceState =
    months.length > 0 && provenMonths.length === months.length
      ? "proven"
      : provenMonths.length > 0
        ? "partial"
        : "missing";
  const txRow: SourceLedgerRow = {
    key: "plaid_transactions",
    label: SOURCE_LEDGER_LABELS.plaid_transactions,
    evidence: txEvidence,
    evidenceSymbol: evidenceMeta(txEvidence).symbol,
    evidenceLabel: evidenceMeta(txEvidence).label,
    evidenceText:
      provenMonths.length > 0
        ? `成功证据：${provenMonths.length}/${months.length} 个月份支出依据齐全（月末快照＋交易全覆盖）`
        : "成功证据：无月份具备完整交易覆盖依据",
    dataDate: "未知",
    coverage:
      provenKeys.length > 0
        ? `支出依据齐全的月份：${provenKeys.join("、")}（逐月依据见月度记录）`
        : "无月份具备完整交易覆盖依据",
    lastSuccessAt: provenMonths.length > 0 ? sourceSuccessInstant(facts, "plaid_transactions") : null,
    attempt: "unknown",
    attemptText: TRANSACTIONS_ATTEMPT_TEXT,
    degraded: transactionDegradations(months),
  };

  // ---- (4) Plaid 持仓 ----
  const holdingsHas = facts.holdingsSummaryCount > 0 || facts.holdingsComplete;
  const holdingsEvidence: SourceLedgerEvidenceState = facts.holdingsComplete
    ? "proven"
    : facts.holdingsSummaryCount > 0
      ? "partial"
      : "missing";
  const holdingsTotalText = formatLedgerAmount(facts.holdingsTotal);
  const holdingsRow: SourceLedgerRow = {
    key: "plaid_holdings",
    label: SOURCE_LEDGER_LABELS.plaid_holdings,
    evidence: holdingsEvidence,
    evidenceSymbol: evidenceMeta(holdingsEvidence).symbol,
    evidenceLabel: evidenceMeta(holdingsEvidence).label,
    evidenceText: facts.holdingsComplete
      ? `成功证据：完整持仓集已保存，共 ${facts.holdingsAllCount} 只合并持仓`
      : facts.holdingsSummaryCount > 0
        ? `成功证据：仅保存 Top 10 摘要（${facts.holdingsSummaryCount} 只），完整持仓集未保存`
        : "成功证据：未保存持仓",
    dataDate: "未知",
    coverage: facts.holdingsComplete
      ? `全部持仓 ${facts.holdingsAllCount} 只${holdingsTotalText != null ? ` · 分母 ${holdingsTotalText}` : ""}`
      : "仅 Top 10 摘要（旧缓存，长尾未保存）",
    lastSuccessAt: holdingsHas ? sourceSuccessInstant(facts, "plaid_holdings") : null,
    attempt: holdingsHas ? attemptShared.attempt : "not_provided",
    attemptText: holdingsHas ? attemptShared.attemptText : "未提供",
    degraded: [],
  };

  return {
    snapshotAsOf,
    rows: [firanceRow, bankRow, txRow, holdingsRow],
  };
}
