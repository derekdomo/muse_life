import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import { SafeAreaTopScrim } from "@hatch/space-sdk/client";
import {
Area,
AreaChart,
Bar,
CartesianGrid,
ComposedChart,
Line,
LineChart,
ReferenceLine,
ResponsiveContainer,
Tooltip,
XAxis,
YAxis,
} from "recharts";
import { api, type ApiResponse } from "./api";

type Dashboard = NonNullable<ApiResponse<typeof api, "getDashboard">["data"]>;
type Month = Dashboard["months"][number];
type Account = Dashboard["accounts"][number];
type Range = "6m" | "12m" | "year" | "all";

const currency = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});

const currencyPrecise = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const compactCurrency = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  notation: "compact",
  maximumFractionDigits: 1,
});

const percent = new Intl.NumberFormat("zh-CN", {
  style: "percent",
  maximumFractionDigits: 1,
});

const number = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 1 });
const monthLabel = new Intl.DateTimeFormat("zh-CN", { month: "short", year: "2-digit" });
const timestampLabel = new Intl.DateTimeFormat("zh-CN", {
  month: "numeric",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});
const dateLabel = new Intl.DateTimeFormat("zh-CN", {
  year: "numeric",
  month: "numeric",
  day: "numeric",
});

function monthDate(key: string): Date {
  return new Date(`${key}T00:00:00`);
}

function signedCurrency(value: number | null): string {
  if (value == null) return "暂无可比快照";
  const sign = value > 0 ? "+" : "";
  return `${sign}${currency.format(value)}`;
}

function valueTone(value: number | null): "neutral" | "positive" | "negative" {
  if (value == null || value === 0) return "neutral";
  return value > 0 ? "positive" : "negative";
}

// F-UI-001: color never carries direction alone — every up/down value
// also gets a glyph so meaning survives for color-weak readers.
export function trendIndicator(value: number | null): string {
  if (value == null || value === 0) return "—";
  return value > 0 ? "▲" : "▼";
}

type RefreshStatus = "idle" | "running" | "error";

type WeeklyDeltaView = {
  comparable: boolean;
  direction: "增加" | "减少" | "持平" | null;
  percent: number | null;
};

export function statusPillText(hasData: boolean, status: RefreshStatus): string {
  if (status === "running") return "正在更新";
  if (status === "error") return hasData ? "显示上次数据" : "数据暂不可用";
  return hasData ? "数据已同步" : "等待首次同步";
}

export function emptyFooterText(status: RefreshStatus): string {
  return status === "error" ? "数据暂不可用，请重新更新。" : "尚未完成首次更新";
}

export function safeRefreshMessage(message: string | null, hasData: boolean): string | null {
  if (!message) return null;
  if (hasData) return message;
  if (message.includes("显示上次数据") || message.includes("首次")) return null;
  return message;
}

export function weeklyDeltaView(delta: number | null, netWorth: number): WeeklyDeltaView {
  if (delta == null) return { comparable: false, direction: null, percent: null };
  const prior = netWorth - delta;
  return {
    comparable: true,
    direction: delta > 0 ? "增加" : delta < 0 ? "减少" : "持平",
    percent: prior !== 0 ? delta / Math.abs(prior) : null,
  };
}

// F2.1-D1: the source summary counts only the rows that actually
// compose net worth — the same balance selection the server uses
// (type "account" / "investment"). Income, spend, transfer and
// contribution entries are never counted as accounts or balance
// coverage. Without per-source success timestamps the live flag only
// supports "同步读取" wording, never a "本周实时" claim; the read date
// itself is stated separately via asOf.
export function balanceSourceSummary(accounts: Array<{ type: string; live: boolean }>): string {
  const balanceAccounts = accounts.filter((account) => account.type === "account" || account.type === "investment");
  if (balanceAccounts.length === 0) return "未提供";
  const liveCount = balanceAccounts.filter((account) => account.live).length;
  const snapshotCount = balanceAccounts.length - liveCount;
  if (snapshotCount === 0) return `全部 ${liveCount} 个余额账户为同步读取值`;
  if (liveCount === 0) return `全部 ${snapshotCount} 个余额账户沿用月度快照值`;
  return `${liveCount} 个余额账户为同步读取值，${snapshotCount} 个余额账户沿用月度快照值`;
}

// F0.5/F0.7: the read-only refresh status band. Status and meaning
// never ride on color alone (the user is color-weak): every state
// carries a symbol AND a text label, on an Okabe-Ito-safe neutral
// presentation. The band states facts only: the last successful
// data date (the stored payload's asOf), when the current/latest
// attempt started (startedAt), when the state row was last
// written (updatedAt — a state-write instant, never called a
// heartbeat or a data date), and the next available action. A
// background task that finished without a legal ingest save is
// never labelled "数据已更新": while running, the band says the
// page still shows the last successful data.
export function refreshStatusSymbol(status: RefreshStatus): string {
  if (status === "running") return "↻";
  if (status === "error") return "▲";
  return "✓";
}

export function refreshStatusText(status: RefreshStatus, hasData: boolean): string {
  if (status === "running") return "正在更新";
  if (status === "error") return hasData ? "更新未成功，显示上次成功数据" : "更新未成功，暂无可用数据";
  return hasData ? "已同步" : "等待首次同步";
}

export function nextRefreshActionText(status: RefreshStatus, hasData: boolean): string {
  if (status === "running") return "等待本次更新完成（完成前不要重复启动）";
  if (status === "error") return hasData ? "可点「立即更新」重试，旧数据保留" : "可点「立即更新」重试";
  return hasData ? "可点「立即更新」手动同步" : "可点「立即更新」进行首次同步";
}

// F0.5/F0.7: month-availability facts, derived from the REAL
// stored months and their integrity metadata — never inferred
// from the refresh asOf. "上一完整月" is the last full calendar
// month before the viewer's current month; "当月" is by
// definition still in progress; earlier months whose integrity
// was never established are named as 历史未核实.
export function monthAvailabilityFacts(months: Month[], now: Date): Array<{ label: string; text: string }> {
  if (months.length === 0) {
    return [{ label: "月份可用性", text: "尚无月度记录" }];
  }
  const pad = (value: number) => String(value).padStart(2, "0");
  const monthOf = (date: Date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}`;
  const currentMonth = monthOf(now);
  const previousMonth = monthOf(new Date(now.getFullYear(), now.getMonth() - 1, 1));
  const byMonth = new Map<string, Month>();
  for (const month of months) byMonth.set(month.key.slice(0, 7), month);
  const facts: Array<{ label: string; text: string }> = [];
  const prev = byMonth.get(previousMonth);
  if (!prev) {
    facts.push({ label: "上一完整月", text: `${previousMonth} 缺失：没有该月快照` });
  } else if (prev.integrity === "complete") {
    facts.push({ label: "上一完整月", text: `${previousMonth} 已齐备（完整性：完整）` });
  } else if (prev.integrity === "partial") {
    facts.push({ label: "上一完整月", text: `${previousMonth} 未核实：完整性为部分（${prev.integrityBasis ?? "依据未提供"}）` });
  } else {
    facts.push({ label: "上一完整月", text: `${previousMonth} 未核实：完整性未提供（${prev.integrityBasis ?? "依据未提供"}）` });
  }
  const current = byMonth.get(currentMonth);
  facts.push({
    label: "当月",
    text: current
      ? `${currentMonth} 仅进行中：快照截至 ${current.snapshotDate || current.key}，月份尚未结束`
      : `${currentMonth} 尚无快照（进行中月份未取得）`,
  });
  const unverifiedHistory = months.filter(
    (month) => month.key.slice(0, 7) < previousMonth && month.integrity !== "complete",
  );
  facts.push({
    label: "历史月份",
    text: unverifiedHistory.length > 0
      ? `${unverifiedHistory.length} 个历史月份未核实（完整性未提供或部分）：${unverifiedHistory.map((month) => month.key.slice(0, 7)).join("、")}`
      : "较早历史月份完整性均已核实",
  });
  return facts;
}

// F0.5: the four-row source ledger the status band expands into
// （本地月度记录 / 银行余额 / 交易 / 持仓）. Each row presents TWO
// separate groups: the last usable fact this source retains (its
// real date / actual range / saved-or-not state) and this
// attempt's result (only the stages actually proven; unknown
// stages are written 未知 — no fabricated percentages, no
// invented task completion). The save result is shared because
// all four sources land through the one legal ingest write;
// transaction coverage is only ever stated through the per-month
// spend provenance the months themselves carry.
// F0.5 rework (per-source dates): the snapshot asOf is ONLY the
// snapshot generation / last-success time (the band labels it
// as such) — it is never a per-source data date. The bank row's
// date is the balanceDate evidence the account rows themselves
// retain, ALWAYS stated with its date coverage （日期已知 x/y):
// a known date describes only the accounts that carry date
// evidence — it is never generalised to the whole balance.
// Only when every bank account row has date evidence and they
// all share one date may a single date stand with its full
// coverage; differing known dates are stated as a range AND
// named inconsistent; accounts without evidence (null, absent
// on a legacy blob, or nulled by a metadata conflict) are
// counted and named as 日期未知 — never filled from asOf or
// the snapshot month. A present but ILLEGAL value (bad format,
// month 13+, a non-existent day) is not evidence either: it is
// counted and named separately as 日期无效， and only the valid
// dates form the stated date or range. Coverage is text, never
// colour alone.
// Holdings carry no per-source date evidence at all, so their
// date is 未知 too. With no data at all, no row may claim a
// save: every result reads 未取得 / 尚无成功快照， whatever
// the refresh state.
export function sourceLedgerRows(
  data: Dashboard | null,
  refresh: { status: RefreshStatus },
): Array<{ source: string; dataDate: string; range: string; result: string }> {
  if (!data) {
    const noDataResult = refresh.status === "running"
      ? "本次更新进行中，尚未取得，尚无成功快照"
      : refresh.status === "error"
        ? "本次未成功，未取得，尚无成功快照"
        : "未取得（尚无成功快照）";
    return [
      { source: "本地月度记录", dataDate: "未知", range: "未取得", result: noDataResult },
      { source: "银行余额", dataDate: "未知", range: "未取得", result: noDataResult },
      { source: "交易", dataDate: "未知", range: "未取得", result: "未知（平台未提供逐源结果）" },
      { source: "持仓", dataDate: "未知", range: "未取得", result: noDataResult },
    ];
  }
  const attemptResult = refresh.status === "running"
    ? "本次更新进行中，尚未落盘保存"
    : refresh.status === "error"
      ? "本次未成功，未写入新数据，保留上次成功数据"
      : "已落盘保存（当前显示即已保存范围）";
  const first = data.months[0];
  const last = data.months.at(-1);
  const provenMonths = data.months.filter((month) => month.spendProven).map((month) => month.key.slice(0, 7));
  const balanceAccounts = data.accounts.filter((account) => account.type === "account" || account.type === "investment");
  // Bank balance date evidence, from the account rows only: the
  // balance entries are the type "account" rows. EVERY bank row
  // counts toward the coverage denominator — rows whose
  // balanceDate is null/absent (legacy blob, or a field nulled
  // because its metadata conflicted) stay in the count as
  // date-unknown; they are never filtered out, which is what
  // used to let one dated row speak for the whole source.
  // F0.5 date-coverage fix (PM 2026-10-19): a present balanceDate
  // is evidence ONLY under the strict date rule
  // (isValidBalanceDateText — the client mirror of the server's
  // normalizeBalanceDate). A non-empty value that fails the rule
  // (bad format, illegal month such as 2025-14, illegal day such
  // as 2026-02-30) is counted separately as 日期无效 — never as
  // known, never shown as the source date, and never silently
  // lumped in with the merely-unknown rows; missing and empty
  // values stay 日期未知. The stated date / span is built from
  // the valid dates only.
  const bankRows = data.accounts.filter((account) => account.type === "account");
  const bankDatedRows = bankRows.filter((account) => isValidBalanceDateText(account.balanceDate));
  const bankInvalidCount = bankRows.filter(
    (account) => account.balanceDate != null && account.balanceDate !== "" && !isValidBalanceDateText(account.balanceDate),
  ).length;
  const bankBalanceDates = [...new Set(
    bankDatedRows.map((account) => account.balanceDate as string),
  )].sort();
  const bankUnknownCount = bankRows.length - bankDatedRows.length - bankInvalidCount;
  const bankCoverage = `日期已知 ${bankDatedRows.length}/${bankRows.length}`;
  const bankGapNotes: string[] = [];
  if (bankUnknownCount > 0) bankGapNotes.push(`其余 ${bankUnknownCount} 个账户日期未知`);
  if (bankInvalidCount > 0) bankGapNotes.push(`${bankInvalidCount} 个账户日期无效`);
  const bankGapNote = bankGapNotes.join("；");
  const bankDataDate = bankRows.length === 0
    ? "未知"
    : bankDatedRows.length === 0
      ? `未知（${bankCoverage}；${bankGapNote}）`
      : bankBalanceDates.length === 1
        ? bankGapNote === ""
          ? `${bankBalanceDates[0]}（${bankCoverage}）`
          : `${bankBalanceDates[0]}（${bankCoverage}；${bankGapNote}）`
        : bankGapNote === ""
          ? `${bankBalanceDates[0]} 至 ${bankBalanceDates[bankBalanceDates.length - 1]}（各账户余额日期不一致；${bankCoverage}）`
          : `${bankBalanceDates[0]} 至 ${bankBalanceDates[bankBalanceDates.length - 1]}（各账户余额日期不一致；${bankCoverage}；${bankGapNote}）`;
  return [
    {
      source: "本地月度记录",
      dataDate: data.sourceMonth,
      range: first && last ? `${first.key} 至 ${last.key} · 共 ${data.months.length} 份月度快照` : "未取得",
      result: attemptResult,
    },
    {
      source: "银行余额",
      dataDate: bankDataDate,
      range: balanceSourceSummary(data.accounts),
      result: balanceAccounts.length > 0 ? attemptResult : "未提供",
    },
    {
      source: "交易",
      dataDate: "未知",
      range: provenMonths.length > 0
        ? `支出依据齐全的月份：${provenMonths.join("、")}（逐月依据见月度记录）`
        : "无月份具备完整交易覆盖依据",
      result: "未知（平台未提供逐源结果）",
    },
    {
      source: "持仓",
      dataDate: "未知",
      range: data.holdingsComplete
        ? `全部持仓 ${data.holdingsAll.length} 只${data.holdingsTotal != null ? ` · 分母 ${currency.format(data.holdingsTotal)}` : ""}`
        : "仅 Top 10 摘要（旧缓存，长尾未保存）",
      result: data.holdings.length > 0 || data.holdingsComplete ? attemptResult : "未提供",
    },
  ];
}

// F1.1 / F0.5: average monthly spend over the most recent 3 months
// whose spend basis is proven (spendProven) and which are not
// anomalous. F1.1 depends only on spend, so missing income or
// contribution provenance must not reject a month here. Months
// without proven spend are reported as a count, never filled with 0.
export function completeSpendBasis(months: Month[]): { averageMonthlySpend: number | null; usedMonths: number; missingMonths: number; usedMonthKeys: string[] } {
  // F0.6: a month whose flexible spend is null (待核对) never enters
  // the basis — it is reported through missingMonths, not 0-filled.
  const valid = months.filter((month) => month.spendProven === true && !month.flexibleSpendAnomaly && month.flexibleSpend != null);
  const used = valid.slice(-3);
  const averageMonthlySpend = used.length > 0
    ? used.reduce((sum, month) => sum + Math.max(0, month.fixedSpend + Math.max(0, month.flexibleSpend ?? 0)), 0) / used.length
    : null;
  // F1.1: the months actually used are part of the result — the
  // coverage display names them instead of citing an unnamed
  // "last 3 months" estimate.
  return {
    averageMonthlySpend,
    usedMonths: used.length,
    missingMonths: Math.max(0, 3 - used.length),
    usedMonthKeys: used.map((month) => (month.key ?? "").slice(0, 7)),
  };
}

// F1.1: emergency coverage = 可动用现金 ÷ 近 3 个有效完整月平均支出.
// The numerator is available cash ONLY: accounts the server
// classified "cash" (availableCash flag). HSA / bond / retirement
// (non-cash), credit-card and loan (credit/debt) balances never
// count, however positive they are — live.deposits (every positive
// account balance) is a net-worth fact and is NOT the numerator.
// `excludedSources` is the owner's on-page trial selection: it only
// changes this computation in this view — nothing is saved and no
// original balance is rewritten. The figure is null (no coverage
// shown) when cash is missing (no cash account, or the server
// withheld a stale balance), when the owner excluded every cash
// account in the trial, when fewer than 3 valid complete months
// exist, or when average spend is not positive. A cash total of
// exactly 0 with accounts still selected is a true 0 and yields a
// coverage of 0 months, distinct from missing.
// F1.1 rework: the verification state of a balance entry, as text.
// Only an explicit false is "未核实"; null/absent is the legacy
// state — not provided, never presented as verified.
export function verificationText(verified: boolean | null | undefined): string {
  if (verified === true) return "已核实";
  if (verified === false) return "未核实";
  return "核实状态未提供";
}

export function emergencyCoverage(
  accounts: Array<{ source: string; type: string; value: number; availableCash?: boolean; verified?: boolean | null; status?: string | null; metadataConflict?: boolean }>,
  serverAvailableCash: number | null,
  staleSources: string[],
  excludedSources: ReadonlySet<string>,
  spendBasis: { averageMonthlySpend: number | null; usedMonths: number; missingMonths: number },
): { months: number | null; cashAmount: number | null; selectedCount: number; reason: string | null } {
  const cashAccounts = accounts.filter((account) => account.type === "account" && account.availableCash === true);
  const selected = cashAccounts.filter((account) => !excludedSources.has(account.source));
  if (cashAccounts.length === 0) {
    return { months: null, cashAmount: null, selectedCount: 0, reason: "没有分类为现金的账户，可动用现金未提供" };
  }
  if (selected.length === 0) {
    return { months: null, cashAmount: null, selectedCount: 0, reason: "本页试算已排除全部现金账户，未输出覆盖" };
  }
  // F1.1 conflict rework (same verdict as the server summary):
  // a cash account whose preserved metadata conflicts
  // (metadataConflict) is NOT a legacy unknown — its metadata
  // exists but cannot be uniquely associated, so while it is in
  // scope no coverage is produced and the reason names the
  // conflict; excluding it in this page's trial restores a
  // normal trial figure from the remaining cash. A row with no
  // metadata at all keeps the legacy caliber below.
  const conflictSelected = selected.filter((account) => account.metadataConflict === true);
  if (conflictSelected.length > 0) {
    return { months: null, cashAmount: null, selectedCount: selected.length, reason: `现金账户元数据冲突待核对（${conflictSelected.map((account) => account.source).join("、")} 的重复元数据冲突，无法唯一关联），金额只作已记录事实，未计入可动用现金，未输出覆盖` };
  }
  // F1.1 rework: explicitly unverified cash never enters the
  // coverage numerator — verified === false, or the raw Firance
  // status reading unverified / carried_forward_unverified. Its
  // balance remains a recorded fact on the account row, but while
  // it is in scope no coverage is produced and the reason names
  // it; excluding it in this page's trial restores a normal trial
  // figure from the remaining verified/legacy cash. A null
  // verification state (legacy, not provided) keeps the legacy
  // caliber.
  const unverifiedSelected = selected.filter(
    (account) =>
      account.verified === false ||
      account.status === "unverified" ||
      account.status === "carried_forward_unverified",
  );
  if (unverifiedSelected.length > 0) {
    return { months: null, cashAmount: null, selectedCount: selected.length, reason: `现金账户未核实（${unverifiedSelected.map((account) => account.source).join("、")} 标记为未核实），金额只作已记录事实，未计入可动用现金，未输出覆盖` };
  }
  // With no trial exclusion the server summary governs (it withholds
  // stale cash); a trial selection re-sums the selected rows from
  // their original balances — still never a stale-withheld figure:
  // if any selected row is stale the trial cannot produce coverage.
  const selectedStale = selected.filter((account) => staleSources.includes(account.source));
  if (selectedStale.length > 0) {
    return { months: null, cashAmount: null, selectedCount: selected.length, reason: `现金余额陈旧（${selectedStale.map((account) => account.source).join("、")} 沿用旧余额日期），未输出覆盖` };
  }
  const cashAmount = excludedSources.size === 0
    ? serverAvailableCash
    : selected.reduce((sum, account) => sum + account.value, 0);
  if (cashAmount == null) {
    return { months: null, cashAmount: null, selectedCount: selected.length, reason: "可动用现金缺失，未输出覆盖" };
  }
  if (spendBasis.missingMonths > 0 || spendBasis.averageMonthlySpend == null) {
    return { months: null, cashAmount, selectedCount: selected.length, reason: `完整有效月不足：已有 ${spendBasis.usedMonths} 个，缺 ${spendBasis.missingMonths} 个` };
  }
  if (spendBasis.averageMonthlySpend <= 0) {
    return { months: null, cashAmount, selectedCount: selected.length, reason: "近 3 个完整有效月平均支出为 0，覆盖无法计算" };
  }
  return { months: Math.max(0, cashAmount) / spendBasis.averageMonthlySpend, cashAmount, selectedCount: selected.length, reason: null };
}

export function accountCashRoleLabel(role: string | null | undefined): string {
  if (role === "cash") return "现金 · 计入可动用现金";
  if (role === "credit") return "信用卡 · 不计入";
  if (role === "debt") return "债务 · 不计入";
  if (role === "non_cash") return "非现金 · 不计入";
  return "未分类 · 不计入";
}

export function integrityLabel(integrity: Month["integrity"]): string {
  if (integrity === "complete") return "完整";
  if (integrity === "partial") return "部分";
  return "完整性未提供";
}

function ChartTooltip({ active, payload, label }: { active?: boolean; payload?: Array<{ name?: string; value?: number; color?: string }>; label?: string }) {
  // F0.6: missing months stay in the series as null so lines break
  // at the gap; a null point must never render as $0 in the tooltip.
  const visible = (payload ?? []).filter((item) => item.value != null);
  if (!active || visible.length === 0) return null;
  return (
    <div className="chart-tooltip">
      <div className="chart-tooltip__label">{label}</div>
      {visible.map((item) => (
        <div className="chart-tooltip__row" key={item.name}>
          <span className="chart-tooltip__dot" style={{ background: item.color }} />
          <span>{item.name}</span>
          <strong>{currency.format(item.value ?? 0)}</strong>
        </div>
      ))}
    </div>
  );
}

function Metric({ label, value, note, tone = "neutral" }: { label: string; value: ReactNode; note?: string; tone?: string }) {
  return (
    <div className="metric">
      <div className="metric__label">{label}</div>
      <div className={`metric__value ${tone}`}>{value}</div>
      {note ? <div className="metric__note">{note}</div> : null}
    </div>
  );
}

function SectionTitle({ title, meta }: { title: string; meta?: string }) {
  return (
    <div className="section-title">
      <h2>{title}</h2>
      {meta ? <span>{meta}</span> : null}
    </div>
  );
}

function DistributionRow({ label, value, maximum, tone = "primary" }: { label: string; value: number; maximum: number; tone?: "primary" | "muted" | "danger" }) {
  const width = maximum > 0 ? Math.max(2, Math.min(100, (Math.abs(value) / maximum) * 100)) : 0;
  return (
    <div className="distribution-row">
      <div className="distribution-row__copy"><span>{label}</span><strong>{currency.format(value)}</strong></div>
      <div className={`distribution-row__track distribution-row__track--${tone}`} aria-hidden="true"><span style={{ width: `${width}%` }} /></div>
    </div>
  );
}

function DistributionPanel({ current, live }: { current: Month; live: Dashboard["live"] }) {
  const assetRows = [
    { label: "投资", value: live.investment, tone: "primary" as const },
    { label: "存款", value: live.deposits ?? 0, tone: "muted" as const },
    // F1.1: available cash is a subset of 存款 above — only the
    // accounts classified cash. Shown as its own row (when the
    // server could determine it) so the emergency numerator is
    // never confused with every positive balance.
    ...(live.availableCash != null
      ? [{ label: "可动用现金（仅现金账户）", value: live.availableCash, tone: "muted" as const }]
      : []),
    { label: "贷款", value: live.loans ?? 0, tone: "muted" as const },
  ];
  const spendRows = [
    { label: "固定支出", value: current.fixedSpend, tone: "primary" as const },
    ...(current.flexibleSpend != null
      ? [{ label: "灵活支出", value: current.flexibleSpend, tone: "muted" as const }]
      : []),
  ];
  const assetMax = Math.max(0, ...assetRows.map((item) => Math.abs(item.value)));
  const spendMax = Math.max(0, ...spendRows.map((item) => Math.abs(item.value)));

  return (
    <article className="chart-panel distribution-panel">
      <div className="chart-heading"><h3>资产 / 支出分布</h3><span>当前结构</span></div>
      <div className="distribution-group">
        <p>资产与负债</p>
        {assetRows.map((item) => <DistributionRow key={item.label} {...item} maximum={assetMax} />)}
      </div>
      <div className="distribution-group">
        <p>本月支出 · 截至 {current.snapshotDate || current.key}</p>
        {spendRows.map((item) => <DistributionRow key={item.label} {...item} maximum={spendMax} />)}
        {current.flexibleSpend == null ? (
          <p className="distribution-missing">灵活支出待核对：{current.anomalyReason ?? "依据不足，未估算"}</p>
        ) : null}
      </div>
    </article>
  );
}

// LIFE-DESIGN-001-B1A: one-line summary of the distribution
// panel for the overview tab's folded evidence layer (R3a: a
// fold's summary carries the key numbers, never just a title).
// Shares are of |投资| + |存款| + |贷款|; available cash is a
// subset of deposits and is labelled as such. Presentation-only
// derivation from the same live figures the panel renders.
export function distributionSummaryLine(live: Dashboard["live"]): string {
  const investment = Math.abs(live.investment);
  const deposits = Math.abs(live.deposits ?? 0);
  const loans = Math.abs(live.loans ?? 0);
  const total = investment + deposits + loans;
  if (total <= 0) return "暂无可计算的余额";
  const share = (value: number) => percent.format(value / total);
  const cashPart = live.availableCash != null ? ` · 存款中现金 ${share(Math.abs(live.availableCash))}` : "";
  return `投资 ${share(investment)} · 存款 ${share(deposits)}${cashPart} · 贷款 ${share(loans)}`;
}

function TrendCharts({ months }: { months: Month[] }) {
  const anomalyMonths = months.filter((month) => month.flexibleSpendAnomaly);
  // F0.6: months stay in the series even when spend is missing —
  // their spend/surplus points are null, so bars vanish and lines
  // break at the gap instead of connecting across it or plotting a
  // fabricated 0. Net-worth (total) is a balance fact and always
  // plots.
  const data = months.map((month) => ({
    ...month,
    label: monthLabel.format(monthDate(month.key)),
    monthlySurplus: month.totalSpend == null ? null : month.income - month.totalSpend,
  }));
  const surplusValues = data.flatMap((month) => [month.income, month.totalSpend ?? 0, month.monthlySurplus ?? 0]);
  const surplusDomain = [Math.min(0, ...surplusValues), Math.max(0, ...surplusValues)] as [number, number];

  return (
    <div className="chart-stack">
      <article className="chart-panel chart-panel--wide">
        <div className="chart-heading"><h3>净值长期分布</h3><span>纵轴：万美元</span></div>
        <div className="chart-frame">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={data} margin={{ top: 12, right: 6, left: -20, bottom: 0 }}>
              <defs>
                <linearGradient id="netWorthFill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="var(--accent)" stopOpacity={0.28} />
                  <stop offset="100%" stopColor="var(--accent)" stopOpacity={0.02} />
                </linearGradient>
              </defs>
              <CartesianGrid vertical={false} stroke="var(--grid)" />
              <XAxis dataKey="label" tickLine={false} axisLine={false} minTickGap={24} />
              <YAxis tickFormatter={(value: number) => (value / 10_000).toFixed(0)} tickLine={false} axisLine={false} width={50} />
              <Tooltip content={<ChartTooltip />} />
              <Area type="monotone" dataKey="total" name="净资产" stroke="var(--accent)" strokeWidth={2.5} fill="url(#netWorthFill)" dot={false} activeDot={{ r: 4 }} />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </article>

      <article className="chart-panel">
        <div className="chart-heading"><h3>每月结余</h3><span>收入 − 支出</span></div>
        <div className="chart-frame chart-frame--small">
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={data} margin={{ top: 10, right: 4, left: -22, bottom: 0 }}>
              <CartesianGrid vertical={false} stroke="var(--grid)" />
              <XAxis dataKey="label" tickLine={false} axisLine={false} minTickGap={22} />
              <YAxis domain={surplusDomain} tickFormatter={(value: number) => (value / 10_000).toFixed(1)} tickLine={false} axisLine={false} width={48} />
              <Tooltip content={<ChartTooltip />} />
              <ReferenceLine y={0} stroke="var(--border-strong)" />
              <Bar dataKey="income" name="月收入" fill="var(--chart-muted)" radius={[3, 3, 0, 0]} />
              <Bar dataKey="totalSpend" name="月支出" fill="var(--accent-soft-strong)" radius={[3, 3, 0, 0]} />
              <Line type="monotone" dataKey="monthlySurplus" name="月结余" stroke="var(--accent)" strokeWidth={2.5} dot={{ r: 2.5 }} />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      </article>

      {anomalyMonths.length > 0 ? (
        <div className="data-anomaly" role="note" aria-label="数据异常月份">
          <strong>数据异常</strong>
          <span>{anomalyMonths.map((month) => monthLabel.format(monthDate(month.key))).join("、")} 仍保留在月度记录中；支出在图表中为断点，不进入 FIRE 年支出。</span>
        </div>
      ) : null}
    </div>
  );
}

// F0.6: the monthly record doubles as the cashflow reconciliation
// entry — it states whether flexible spend was recorded, estimated
// or is still 待核对, and expands to the interval, the formula, the
// open issues and the preserved per-source classification /
// balance-date / verification metadata.
export function flexibleSpendSourceLabel(source: Month["flexibleSpendSource"]): string {
  if (source === "recorded") return "已记录";
  if (source === "estimated") return "估算";
  return "待核对";
}

// F1.6: the monthly investment return is a reconciled figure, not a
// raw balance difference. Its label is text (收益/亏损/持平/待核对),
// never color alone — color-weak readers get the word plus the
// ▲/▼ glyph and the signed amount.
export function investmentReturnLabel(month: Month): string {
  if (month.investmentReturn == null) return "待核对";
  if (month.investmentReturn > 0) return "收益";
  if (month.investmentReturn < 0) return "亏损";
  return "持平";
}

export function contributionSourceLabel(source: Month["contributionSource"]): string {
  if (source === "standard") return "标准字段 investment_contribution";
  if (source === "alias") return "旧 transfer 别名";
  if (source === "conflict") return "标准字段与旧别名冲突，待核对";
  return "未提供";
}

export function cashflowRoleLabel(role: string | null): string {
  if (role === "cash") return "现金";
  if (role === "credit") return "信用卡";
  if (role === "debt") return "债务";
  if (role === "non_cash") return "非现金";
  return "未分类";
}

// F0.6/F1.6 rework: the cash/credit endpoint rows of a month —
// the accounts that take part in the cashflow back-calculation
// and in the available-cash caliber. Shared by the monthly
// record's dual-end reconciliation block.
function cashCreditEntries(month: Month) {
  return (month.entryMeta ?? []).filter(
    (entry) => entry.type === "account" && (entry.cashflowRole === "cash" || entry.cashflowRole === "credit"),
  );
}

function nextDateText(key: string): string {
  const date = new Date(`${key}T00:00:00`);
  if (Number.isNaN(date.getTime())) return key;
  date.setDate(date.getDate() + 1);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

// F1.6 period proof (client mirror): a strict real-calendar-date
// check for period bounds shown on the card. An illegal day such
// as 09-00 or 09-31 is rejected outright — the same verdict the
// server gate applies — never compared as text.
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
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

// F0.5 date-coverage fix (PM 2026-10-19): the client mirror of
// the server's strict balance-date rule (normalizeBalanceDate).
// A balanceDate is date EVIDENCE only when it is a YYYY-MM with
// month 01..12 (that month's last day) or a real YYYY-MM-DD
// calendar date. Missing, empty, malformed, an illegal month
// (2025-13 / 2025-14) or an illegal day (2026-02-30) is NOT
// evidence — the same verdict the server gates apply, so the
// ledger's 日期已知 x/y can never be satisfied by a bad value,
// and a bad value shown in a detail row is marked 日期无效.
export function isValidBalanceDateText(value: string | null | undefined): boolean {
  if (value == null || value === "") return false;
  if (/^\d{4}-\d{2}$/.test(value)) {
    const month = Number(value.slice(5, 7));
    return month >= 1 && month <= 12;
  }
  return isRealDateText(value);
}

// F1.6 rework: the effective period of an entry — the generic
// period when present, the Firance-native period filling its
// absence (generic ?? native). One resolver shared by the
// coverage verdict, the card's flow rows and the monthly
// records, so every surface shows and judges the same period.
export function effectivePeriodOf(entry: {
  periodStart: string | null;
  periodEnd: string | null;
  nativePeriodStart?: string | null;
  nativePeriodEnd?: string | null;
}): { start: string | null; end: string | null } {
  return {
    start: entry.periodStart ?? entry.nativePeriodStart ?? null,
    end: entry.periodEnd ?? entry.nativePeriodEnd ?? null,
  };
}

export function effectivePeriodText(entry: {
  periodStart: string | null;
  periodEnd: string | null;
  nativePeriodStart?: string | null;
  nativePeriodEnd?: string | null;
}): string {
  const period = effectivePeriodOf(entry);
  return `${period.start ?? "—"} 至 ${period.end ?? "—"}`;
}

// F1.6 rework: the coverage verdict for one flow entry is judged
// against the interval that entry itself belongs to — (the
// previous snapshot date, its own snapshot date] — never against
// the whole card range. The period shown and judged is the
// EFFECTIVE period: the generic period when present, otherwise
// the Firance-native period. A period reaching outside its
// interval is labelled 跨出本区间 (its amount cannot be
// attributed to the interval), one falling short is 仅覆盖部分,
// one outside entirely is 不在本区间内， and a record without a
// period is 未提供期间. Text is the primary channel — the verdict
// is a sentence, not a color.
export function flowPeriodCoverageLabel(
  entry: { periodStart: string | null; periodEnd: string | null; nativePeriodStart?: string | null; nativePeriodEnd?: string | null },
  startKey: string | null,
  endKey: string | null,
): string {
  const { start, end } = effectivePeriodOf(entry);
  if (!start || !end) return "未提供期间";
  // F1.6 period proof: period material that is not a legal,
  // complete period (illegal calendar dates such as 09-00, or a
  // start after its end) is not proof — the same verdict the
  // server gate reaches, shown as text on the card.
  if (!isRealDateText(start) || !isRealDateText(end) || start > end) return "期间不完整或日期非法，不作证明";
  if (!startKey || !endKey) return "期间已提供，所属区间未定";
  if (end <= startKey || start > endKey) return "不在本区间内";
  const intervalStart = nextDateText(startKey);
  if (start <= startKey || end > endKey) return "跨出本区间，金额无法归属";
  if (start > intervalStart || end < endKey) return "仅覆盖部分";
  return "覆盖本区间";
}

function MonthlyRecords({ months }: { months: Month[] }) {
  const rows = months
    .map((month, index) => ({ month, previous: index > 0 ? months[index - 1] : undefined }))
    .reverse();
  return (
    <div className="month-records">
      {rows.map(({ month, previous }) => {
        const snapshotDate = month.snapshotDate || month.key;
        const balanceMeta = (month.entryMeta ?? []).filter(
          (entry) => entry.type === "account" || entry.type === "investment",
        );
        return (
          <details className="month-record" key={month.key}>
            <summary aria-label={`${monthLabel.format(monthDate(month.key))}月度记录详情`}>
              <span className="month-record__title">{monthLabel.format(monthDate(month.key))}</span>
              <span className="month-record__meta">截至 {snapshotDate} · {integrityLabel(month.integrity)}</span>
              {month.flexibleSpendAnomaly ? <span className="month-record__flag">数据异常</span> : null}
              <span className="month-record__total">{currency.format(month.total)}</span>
            </summary>
            <div className="month-record__detail">
              <p>所用快照：{snapshotDate}{month.supersededSnapshots > 0 ? `（同月另有 ${month.supersededSnapshots} 份较早快照已被替代）` : "（同月仅此一份快照）"}</p>
              <p>完整性：{integrityLabel(month.integrity)}{month.integrityBasis ? ` · ${month.integrityBasis}` : " · 无完整覆盖依据"}</p>
              <p>指标依据：支出 {month.spendProven ? "有依据" : "未提供"} · 收入 {month.incomeProven ? "有依据" : "未提供"} · 投入 {month.contributionProven ? "有依据" : "未提供"}</p>
              <p>
                灵活支出（{flexibleSpendSourceLabel(month.flexibleSpendSource)}）：
                {month.flexibleSpend == null ? "未提供" : currency.format(month.flexibleSpend)}
                {month.cashflowDifference != null ? ` · 反推差额 ${currency.format(month.cashflowDifference)}` : ""}
              </p>
              {month.cashflowNote ? <p>核对式：{month.cashflowNote}</p> : null}
              {month.flexibleSpendAnomaly ? (
                <p>待核对：{month.anomalyReason ?? "灵活支出未能核实"}（保留在月度记录中，支出图表为断点，不进入 FIRE 计算）</p>
              ) : null}
              {month.flexibleSpendSource !== "recorded" ? (
                <div className="month-record__meta-list">
                  <p>现金流反推双端核对（期初 {previous ? previous.key : "无上期快照"} → 期末 {month.key}）：</p>
                  {previous ? (
                    cashCreditEntries(previous).map((entry, entryIndex) => (
                      <p key={`cf-start-${entry.financeSource}-${entryIndex}`}>
                        期初 · {entry.financeSource} · {cashflowRoleLabel(entry.cashflowRole)} · 余额日期 {entry.balanceDate ?? `未提供（按快照 ${previous.key}）`} · {verificationText(entry.verified)}
                      </p>
                    ))
                  ) : <p>期初：缺少上期快照，无法核对期初端点</p>}
                  {cashCreditEntries(month).map((entry, entryIndex) => (
                    <p key={`cf-end-${entry.financeSource}-${entryIndex}`}>
                      期末 · {entry.financeSource} · {cashflowRoleLabel(entry.cashflowRole)} · 余额日期 {entry.balanceDate ?? `未提供（按快照 ${month.key}）`} · {verificationText(entry.verified)}
                    </p>
                  ))}
                </div>
              ) : null}
              <p>投入（{contributionSourceLabel(month.contributionSource)}）：{month.contributionSource === "missing" ? "未提供" : currency.format(month.contribution)}</p>
              <p>
                投资收益（{investmentReturnLabel(month)}）：
                {month.investmentReturn == null ? "待核对" : `${trendIndicator(month.investmentReturn)} ${signedCurrency(month.investmentReturn)}`}
                {month.investmentReturnReason ? ` · ${month.investmentReturnReason}` : ""}
              </p>
              <p>
                外部净投入：{month.investmentNetFlow == null
                  ? "未提供"
                  : `${currency.format(month.investmentNetFlow)}（现金投入 ${currency.format(month.contribution)} + 非银行直接投入 ${currency.format(month.investmentExternalAdjustment)}；提现为负）`}
              </p>
              <p>收入 {month.incomeProven ? currency.format(month.income) : "未提供"} · 支出 {month.totalSpend == null ? "未提供" : currency.format(month.totalSpend)} · 投入 {month.contributionProven ? currency.format(month.contribution) : "未提供"}</p>
              {balanceMeta.length > 0 ? (
                <div className="month-record__meta-list">
                  {balanceMeta.map((entry) => {
                    // F1.6 rework: the period shown is the EFFECTIVE
                    // period — generic first, the Firance-native
                    // period when the generic one is absent.
                    const period = effectivePeriodOf(entry);
                    return (
                      <p key={`${entry.type}-${entry.financeSource}`}>
                        {entry.financeSource} · {cashflowRoleLabel(entry.cashflowRole)} · 余额日期 {entry.balanceDate ?? "未知"}{entry.balanceDate != null && entry.balanceDate !== "" && !isValidBalanceDateText(entry.balanceDate) ? "（日期无效）" : ""}
                        {entry.status ? ` · 状态 ${entry.status}` : ""}
                        {entry.verified != null ? ` · ${entry.verified ? "已核实" : "未核实"}` : ""}
                        {period.start || period.end ? ` · 期间 ${effectivePeriodText(entry)}${entry.periodStart == null && entry.nativePeriodStart != null ? "（原生期间）" : ""}` : ""}
                      </p>
                    );
                  })}
                </div>
              ) : null}
            </div>
          </details>
        );
      })}
    </div>
  );
}

// F1.6: whole-period investment performance card. The figure is
// 期末全部投资账户余额 − 期初同范围余额 − 整个期间外部净投入
// (cash net transfers in plus non-bank direct investment such as
// RSU / employer contributions; withdrawals negative). It is a
// separate reconciliation from the net-worth balance-difference
// fact card above: that card stays a balance fact and is never
// re-labelled as market return, and holdings detail never
// substitutes for the full investment-account balances here.
function InvestmentPerformanceCard({ data }: { data: Dashboard }) {
  const perf = data.investmentPerformance;
  const reconciled = perf.returnAmount != null;
  const returnLabel = perf.returnAmount == null
    ? "待核对"
    : perf.returnAmount > 0 ? "收益" : perf.returnAmount < 0 ? "亏损" : "持平";
  // F1.6 rework: the expansion reuses the months' preserved
  // entryMeta — endpoint balance rows for the first/last month,
  // then ONE ROW PER REAL INTERVAL (each adjacent snapshot pair):
  // its recorded cash / non-bank amounts, the net flow that
  // interval can actually be reconciled with (— while unproven),
  // and its return or its 待核对 reason. Every flow record is
  // listed under its own interval with its effective period
  // (generic ?? native), its native verification state as text,
  // and a coverage verdict judged against ITS interval only. It
  // is read-only reconciliation display: nothing is written back
  // to the source history and no new source system is introduced.
  const startMonth = data.months.find((month) => month.key === perf.startKey) ?? data.months[0];
  const endMonth = data.months.find((month) => month.key === perf.endKey) ?? data.months.at(-1);
  const startIndex = startMonth ? data.months.indexOf(startMonth) : -1;
  const endIndex = endMonth ? data.months.indexOf(endMonth) : -1;
  const periodMonths = startIndex >= 0 && endIndex >= startIndex
    ? data.months.slice(startIndex, endIndex + 1)
    : data.months;
  const endpointRows = (month: Month | undefined, label: "期初" | "期末") =>
    (month?.entryMeta ?? [])
      .filter((entry) => entry.type === "investment")
      .map((entry, entryIndex) => (
        <p key={`${label}-${entry.financeSource}-${entryIndex}`}>
          {label} · {entry.financeSource} · 投资 · 余额日期 {entry.balanceDate ?? `未提供（按快照 ${month?.key ?? "—"}）`} · {verificationText(entry.verified)}
        </p>
      ));
  const intervalRows = periodMonths.slice(1).map((month, offset) => {
    const previousMonth = periodMonths[offset];
    return (
      <p key={`interval-${month.key}`}>
        区间 {month.key}：{previousMonth ? `${previousMonth.key} → ${month.key} · ` : ""}
        现金投入已记录 {month.contributionSource === "missing" ? "未提供" : currency.format(month.contribution)}
        {" · "}非银行直接投入已记录 {currency.format(month.investmentExternalAdjustment)}
        {" · "}本段可用于核对的净投入 {month.investmentNetFlow == null ? "—" : currency.format(month.investmentNetFlow)}
        {" · "}{month.investmentReturn == null
          ? `待核对：${month.investmentReturnReason ?? "该区间收益待核对"}`
          : `本段收益 ${investmentReturnLabel(month)} ${signedCurrency(month.investmentReturn)}`}
      </p>
    );
  });
  const flowRows = periodMonths.slice(1).flatMap((month, offset) => {
    const previousMonth = periodMonths[offset];
    return (month.entryMeta ?? [])
      .filter((entry) => entry.type === "investment_contribution" || entry.type === "transfer" || entry.type === "investment_external_adjustment")
      .map((entry, entryIndex) => {
        const hasNativePeriod = entry.nativePeriodStart != null || entry.nativePeriodEnd != null;
        return (
          <p key={`flow-${month.key}-${entry.financeSource}-${entryIndex}`}>
            投入 · {entry.financeSource} · {entry.type === "investment_external_adjustment" ? "非银行直接投入" : entry.type === "transfer" ? "旧 transfer 别名" : "现金投入"}
            {" · "}期间 {effectivePeriodText(entry)}
            {entry.periodStart == null && hasNativePeriod ? "（原生期间）" : ""}
            {entry.periodStart != null && hasNativePeriod ? ` · 原生期间 ${entry.nativePeriodStart ?? "—"} 至 ${entry.nativePeriodEnd ?? "—"}` : ""}
            {" · "}{verificationText(entry.verified)}
            {" · "}原生核实状态：{entry.nativeFlowVerified === true ? "已核实" : entry.nativeFlowVerified === false ? "未核实" : "未提供"}
            {" · "}{flowPeriodCoverageLabel(entry, previousMonth?.key ?? null, month.key)}
          </p>
        );
      });
  });
  return (
    <section className="fact-card" aria-label="投资收益核对（整个期间）">
      <div className="fact-card__heading">
        <h2>投资收益核对</h2>
        <span>{perf.startKey && perf.endKey ? `${perf.startKey} → ${perf.endKey} · ${reconciled ? "已核对" : "待核对"} · 共 ${perf.monthsCovered} 个区间` : "尚无期间"}</span>
      </div>
      {perf.returnAmount != null ? (
        <div className={`fact-card__value ${valueTone(perf.returnAmount)}`}>
          <strong>{trendIndicator(perf.returnAmount)} {signedCurrency(perf.returnAmount)}</strong>
          <span>{returnLabel}</span>
        </div>
      ) : (
        <div className="fact-card__value neutral">
          <strong className="fact-card__none">—</strong>
          <span>待核对</span>
        </div>
      )}
      <p className="fact-card__note">
        期初投资余额 {perf.startBalance == null ? "未提供" : currency.format(perf.startBalance)}
        {" · "}期末投资余额 {perf.endBalance == null ? "未提供" : currency.format(perf.endBalance)}
        {" · "}整个期间外部净投入 {perf.netFlow == null ? "未知（任一区间未核实时不给整个期间合计，各区间已记录金额见下方明细）" : currency.format(perf.netFlow)}
        （现金净转入 + 非银行直接投入如 RSU、雇主缴款；提现为负）
      </p>
      {perf.reason ? <p className="fact-card__note">待核对：{perf.reason}。任一区间未核实时不累计整个期间收益，也不跨缺口补 0；已成立区间的月度收益仍可在上方「月度记录」中查看。</p> : null}
      <details className="fact-card__details">
        <summary aria-label="投资收益期间核对明细">期间核对明细（双端余额与投入期间）</summary>
        <div className="month-record__meta-list">
          {endpointRows(startMonth, "期初")}
          {endpointRows(endMonth, "期末")}
          {intervalRows}
          {flowRows}
        </div>
      </details>
      <p className="fact-card__source">收益只按全部投资账户余额核对：持仓明细不替代账户余额；上方「本次余额差」是净资产（含存贷款）之差，不是投资收益。FIRE 达标进度同样以投资余额为本金，与本卡同一投资账户边界。</p>
    </section>
  );
}

// LIFE-DESIGN-001-B1A: the FIRE years estimate, shared by the
// full panel (detail tab) and the overview tab's one-line FIRE
// summary so the two never diverge. Same math as the panel has
// always used: gap covered by the recent contribution pace.
export function fireYearsEstimate(fire: Dashboard["fire"]): number | null {
  if (fire.gap <= 0) return 0;
  return fire.annualContribution > 0 ? Math.ceil(fire.gap / fire.annualContribution) : null;
}

// The overview tab's FIRE line (design draft: progress % + gap +
// estimated years, one line, anchor to the full panel).
export function fireSummaryLine(fire: Dashboard["fire"]): string {
  if (fire.completeMonthsUsed === 0) return "FIRE 进度：完整月份不足，暂不估算";
  const years = fireYearsEstimate(fire);
  const yearsText = years == null
    ? "当前投入节奏不足以估算达标时间"
    : years === 0
      ? "已达到目标"
      : `预计还需 ${years} 年`;
  return `FIRE 进度 ${percent.format(Math.max(0, fire.progress ?? 0))} · 缺口 ${currency.format(fire.gap)} · ${yearsText}`;
}

function FireProgress({ data }: { data: Dashboard }) {
  const rawProgress = Math.max(0, data.fire.progress ?? 0);
  const ringProgress = Math.min(rawProgress, 1);
  const circumference = 2 * Math.PI * 46;
  const offset = circumference * (1 - ringProgress);
  const years = fireYearsEstimate(data.fire);
  const history = data.months
    .map((month, index) => {
      const prior = data.months.slice(Math.max(0, index - 12), index)
        .filter((item) => item.integrity === "complete" && !item.flexibleSpendAnomaly);
      const monthlySpend = prior.length > 0 ? prior.reduce((sum, item) => sum + (item.totalSpend ?? 0), 0) / prior.length : 0;
      const target = monthlySpend > 0 ? monthlySpend * 12 * 25 : 0;
      return {
        label: monthLabel.format(monthDate(month.key)),
        // F1.6 rework: the trajectory uses the same principal as
        // the headline progress — the month's investment-account
        // balance (month.investment), never its net worth
        // (month.total), so deposits / HSA / liabilities cannot
        // move a trajectory point.
        progress: target > 0 && !month.flexibleSpendAnomaly ? (month.investment / target) * 100 : null,
      };
    })
    .filter((item) => item.progress != null);

  if (data.fire.completeMonthsUsed === 0) {
    return (
      <div className="fire-layout">
        <p className="fire-gap-note">
          暂无完整且有效的月份可用于计算 FIRE 目标：当月为部分数据，其余月份完整性未提供或存在数据异常。
          月度事实仍可在上方「月度记录」中查看；形成完整月份后，这里会按近 12 个完整有效月自动计算，不以不完整月份推算。
        </p>
        <div className="fire-history">
          <div className="chart-heading"><h3>FIRE% 历史轨迹</h3><span>观察斜率</span></div>
          <div className="fire-history__chart"><p className="empty-inline">等待更多完整月份后生成轨迹。</p></div>
        </div>
      </div>
    );
  }

  return (
    <div className="fire-layout">
      <div className="fire-overview">
        <div className="fire-ring" role="img" aria-label={`FIRE 进度 ${percent.format(rawProgress)}`}>
          <svg viewBox="0 0 112 112" aria-hidden="true">
            <circle className="fire-ring__track" cx="56" cy="56" r="46" />
            <circle className="fire-ring__value" cx="56" cy="56" r="46" strokeDasharray={circumference} strokeDashoffset={offset} />
          </svg>
          <div><strong>{percent.format(rawProgress)}</strong><span>已完成</span></div>
        </div>
        <div className="fire-copy">
          <span>目标资产</span>
          <strong>{currency.format(data.fire.target)}</strong>
          <p className="fire-gap">缺口 {currency.format(data.fire.gap)}</p>
          <p className="fire-years">{years == null ? "当前投入节奏不足以估算达标时间" : years === 0 ? "已达到目标" : `距目标还差 ${years} 年`}</p>
          {years != null && years > 0 ? <small>按近 {data.fire.completeMonthsUsed} 个完整有效月的投入节奏估算</small> : null}
        </div>
      </div>

      <div className="fire-history">
        <div className="chart-heading"><h3>FIRE% 历史轨迹</h3><span>观察斜率</span></div>
        <div className="fire-history__chart">
          {history.length > 1 ? (
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={history} margin={{ top: 8, right: 8, left: -28, bottom: 0 }}>
                <CartesianGrid vertical={false} stroke="var(--grid)" />
                <XAxis dataKey="label" tickLine={false} axisLine={false} minTickGap={24} />
                <YAxis tickFormatter={(value: number) => `${value.toFixed(0)}%`} tickLine={false} axisLine={false} width={48} />
                <Tooltip formatter={(value: number) => [`${value.toFixed(1)}%`, "FIRE 进度"]} />
                <Line type="monotone" dataKey="progress" stroke="var(--accent)" strokeWidth={2.5} dot={false} activeDot={{ r: 4 }} />
              </LineChart>
            </ResponsiveContainer>
          ) : <p className="empty-inline">等待更多完整月份后生成轨迹。</p>}
        </div>
      </div>

      <div className="fire-stats">
        <div><span>年投入</span><strong>{currency.format(data.fire.annualContribution)}</strong></div>
        <div><span>年支出</span><strong>{currency.format(data.fire.annualSpend)}</strong></div>
      </div>
      <p className="fire-rule">月支出每降 $1k，FI 目标减少约 $300k</p>
    </div>
  );
}

const sourceInstitutionRules: Array<[RegExp, string]> = [
  [/^fidelity/i, "Fidelity"],
  [/^robinhood/i, "Robinhood"],
  [/^wells[ _-]?fargo/i, "Wells Fargo"],
  [/^schwab/i, "Charles Schwab"],
  [/^chase/i, "Chase"],
  [/^titan/i, "Titan"],
  [/^wealthfront/i, "Wealthfront"],
  [/^citi/i, "Citi"],
  [/^usbank/i, "U.S. Bank"],
  [/^bonds/i, "Bonds"],
];

function institutionName(account: Account): string {
  if (account.institution) return account.institution;
  return sourceInstitutionRules.find(([pattern]) => pattern.test(account.source))?.[1] ?? "其他账户";
}

function accountTypeLabel(type: Account["type"]): string {
  if (type === "investment") return "投资";
  if (type === "account") return "存贷款";
  if (type === "income") return "收入";
  if (type === "fixed_spend") return "固定支出";
  if (type === "investment_contribution") return "投资投入";
  if (type === "flexible_spend") return "灵活支出实录";
  if (type === "cashflow_adjustment") return "现金流调整";
  if (type === "investment_external_adjustment") return "投资外部投入";
  return "历史转入";
}

// LIFE-DESIGN-001-B1A: the three former total-assets cards —
// the 本次余额差 fact card, the live-net-worth hero and the
// F-ARCH card — merge into ONE conclusion card on the overview
// tab (design draft space-3 plan, item 2). Every fact keeps
// exactly one rendering home (R4): the F-ARCH total is the
// headline when a stored figure exists (the live net worth
// otherwise); the vs-last-snapshot delta drops to one line; the
// F-ARCH labeling rule (PM 2026-10-24): every fact is labelled
// in place with its own caliber — the headline is the new
// architecture's 「混合余额日期的最近已知净值」 with its amounts /
// dates coverage counts and the Plaid pull time adjacent, while
// the delta line (weeklyDelta, whose percent denominator is the
// OLD live.netWorth) is labelled 旧同步口径 and must never read
// as the headline's own change; the old sync net worth stays
// traceable in the detail tab's arch account section. This is
// presentation binding only — no formula changed. The
// two F-ARCH freshness layers stay as their own lines together
// with the DATE-1 coverage line; the archived monthly snapshot
// figure is one small compare line at the bottom. Kept facts
// keep their wording — only the location pointers that named
// the old layout changed （下方 → 「明细」页签）.
function TotalAssetsConclusionCard({ data, refreshFailed }: { data: Dashboard; refreshFailed: boolean }) {
  const arch = data.archNetWorth;
  const delta = data.live.weeklyDelta;
  const view = weeklyDeltaView(delta, data.live.netWorth);
  const current = data.months.at(-1);
  const previous = data.months.at(-2);
  const monthDelta = current && previous ? current.total - previous.total : null;
  const asOfDate = new Date(data.asOf);
  const asOfText = Number.isNaN(asOfDate.getTime()) ? "未提供" : dateLabel.format(asOfDate);
  const pulled = arch ? new Date(arch.pulledAt) : null;
  const pulledText = !arch || !pulled
    ? ""
    : Number.isNaN(pulled.getTime())
      ? arch.pulledAt
      : `${dateLabel.format(pulled)} ${pulled.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}`;
  const plaidHasRows = arch?.rows.some((row) => row.coverage === "plaid") ?? false;
  const snapshotHasRows = arch?.rows.some((row) => row.coverage === "snapshot") ?? false;
  return (
    <section className="fact-card conclusion-card" aria-label={arch ? "总资产 · 新架构（F-ARCH-001）" : "总资产"}>
      <p className="eyebrow">{arch ? "总资产 · 新架构（F-ARCH-001）" : "总资产 · 同步读取净资产"}</p>
      {arch ? <p className="conclusion-card__caliber">主数字口径：混合余额日期的最近已知净值（新架构 F-ARCH-001）</p> : null}
      <div className="conclusion-card__value">
        <strong>{currency.format(arch ? arch.total : data.live.netWorth)}</strong>
      </div>
      {arch ? (
        <p className="fact-card__note">金额已计入 {arch.amountIncluded}/{arch.amountTotal} 个账户 · 有效余额日期 {arch.validDateCount}/{arch.dateTotal} 个账户 · Plaid 层拉取于 {pulledText}</p>
      ) : null}
      {arch?.partial ? (
        <p className="fact-card__note">有账户缺失，总额为部分合计，缺失项见「明细」页签的总资产账户明细。</p>
      ) : null}
      <div className={`delta ${valueTone(delta)}`}>
        {view.comparable ? (
          <>
            <strong>{trendIndicator(delta)} {signedCurrency(delta)}</strong>
            {view.percent != null ? <span>{`${view.percent > 0 ? "+" : ""}${percent.format(view.percent)}`}</span> : null}
            {view.direction ? <span>{view.direction}</span> : null}
            <span className="delta__label">{arch ? "旧同步口径 · 较上次成功快照" : "较上次成功快照"}</span>
          </>
        ) : (
          <span>暂无可比快照</span>
        )}
      </div>
      <p className="fact-card__note">
        {view.comparable
          ? arch
            ? "旧同步口径 · 较上次成功快照（日期未留存）：旧同步净资产与上次成功快照之差，分母同为旧同步净资产；不是上方新架构主数字的变化，两者不要互相推导。两次快照的间隔不固定，不代表固定时间间隔。"
            : "较上次成功快照（日期未留存）：与上次成功快照的净资产之差；两次快照的间隔不固定，不代表固定时间间隔。"
          : arch
            ? "旧同步口径：首次同步、或上次快照不可用时没有可比对象；下一次成功同步后生成对比。"
            : "首次同步、或上次快照不可用时没有可比对象；下一次成功同步后生成对比。"}
      </p>
      {refreshFailed ? <p className="fact-card__stale">本次未更新：本次更新未成功，以上仍为上次成功同步的数据，数据日期未推进。</p> : null}
      {arch ? (
        <>
          <p className="fact-card__note">Plaid 层拉取于 {pulledText}</p>
          <p className="fact-card__note">{archCoverageLine(arch)}</p>
          <p className="fact-card__note">
            ● Plaid 同步层：{archLayerLine(arch.plaidRange, plaidHasRows)}
          </p>
          <p className="fact-card__note">
            ● 快照层（Firance 月度快照沿用）：
            {arch.snapshotRange
              ? `${archLayerLine(arch.snapshotRange, snapshotHasRows)}，逐户日期见明细`
              : archLayerLine(arch.snapshotRange, snapshotHasRows)}
          </p>
        </>
      ) : null}
      {current ? (
        <div className="snapshot-compare">
          <span>月度快照 · {data.sourceMonth}（存档口径）</span>
          <strong>{currency.format(current.total)}</strong>
          <small className={valueTone(monthDelta)}>{monthDelta == null ? "暂无可比快照" : `${trendIndicator(monthDelta)} ${signedCurrency(monthDelta)} 环比`}</small>
        </div>
      ) : null}
      <p className="fact-card__source">数据日期 {asOfText} · 月度快照 {data.sourceMonth} · 余额来源：{balanceSourceSummary(data.accounts)}</p>
      {arch ? <p className="fact-card__source">旧同步口径净资产 {currency.format(data.live.netWorth)}（旧同步口径变化量的基准，逐项见「明细」页签）；旧月度快照保留在「明细」页签作对账存档。</p> : null}
    </section>
  );
}

// F1.1: the available-cash scope panel. Every balance account of
// the latest snapshot is listed with its classification (text, not
// color alone): only 现金 rows can enter the emergency numerator;
// HSA / bonds / retirement （非现金）, credit cards and loans are
// shown as 不计入 with their original balances untouched. The owner
// may uncheck cash accounts to trial a narrower scope — the trial
// is labelled 仅本页试算， lives only in this view's state, is
// never saved, and never rewrites an original balance.
function AvailableCashPanel({
  data,
  excludedSources,
  onToggle,
  trialCashAmount,
}: {
  data: Dashboard;
  excludedSources: ReadonlySet<string>;
  onToggle: (source: string) => void;
  trialCashAmount: number | null;
}) {
  const balanceAccounts = data.accounts.filter((account) => account.type === "account");
  const stale = data.live.availableCashStale ?? [];
  // The stale warning must agree with the coverage result: a stale
  // account the owner excluded in this page's trial no longer
  // blocks the trial figure, so it is reported as excluded instead
  // of claiming no coverage was produced.
  const activeStale = stale.filter((source) => !excludedSources.has(source));
  const excludedStale = stale.filter((source) => excludedSources.has(source));
  // Same agreement rule for unverified cash: while in scope it
  // blocks coverage and is named as blocking; once excluded in
  // this page's trial it is reported as excluded, and the default
  // caliber still never counts its amount.
  const unverifiedCash = balanceAccounts.filter(
    (account) =>
      account.availableCash === true &&
      (account.verified === false ||
        account.status === "unverified" ||
        account.status === "carried_forward_unverified"),
  );
  const activeUnverified = unverifiedCash.filter((account) => !excludedSources.has(account.source));
  const excludedUnverified = unverifiedCash.filter((account) => excludedSources.has(account.source));
  // Same agreement rule for metadata-conflicted cash: in scope
  // it blocks coverage and is named as 元数据冲突待核对 (text,
  // not color alone); excluded in this page's trial it is
  // reported as excluded, and the default caliber never counts
  // its amount either way.
  const conflictCash = balanceAccounts.filter(
    (account) => account.availableCash === true && account.metadataConflict === true,
  );
  const activeConflict = conflictCash.filter((account) => !excludedSources.has(account.source));
  const excludedConflict = conflictCash.filter((account) => excludedSources.has(account.source));
  const trialActive = excludedSources.size > 0;
  return (
    <section className="fact-card" aria-label="可动用现金账户范围">
      <div className="fact-card__heading">
        <h2>可动用现金账户范围</h2>
        <span>{trialActive ? "本页试算中（不保存）" : "默认范围：全部分类为现金的账户"}</span>
      </div>
      <p className="fact-card__note">
        服务端口径可动用现金 {data.live.availableCash == null ? "未提供" : currency.format(data.live.availableCash)}
        {trialActive ? ` · 本页试算 ${trialCashAmount == null ? "未输出" : currency.format(trialCashAmount)}` : ""}
        {" · "}勾选仅在本页试算，不保存、不改动任何原始余额；应急金覆盖的分子只用这里计入的现金。
      </p>
      {activeStale.length > 0 ? (
        <p className="fact-card__stale">现金余额陈旧：{activeStale.join("、")} 沿用旧余额日期，本次未输出覆盖，等待下次同步更新。</p>
      ) : null}
      {excludedStale.length > 0 ? (
        <p className="fact-card__note">陈旧现金账户 {excludedStale.join("、")} 已在本页试算中排除，未计入试算金额；默认口径仍待下次同步更新。</p>
      ) : null}
      {activeUnverified.length > 0 ? (
        <p className="fact-card__stale">现金账户未核实：{activeUnverified.map((account) => account.source).join("、")} 标记为未核实，金额只作已记录事实，未计入可动用现金，本次未输出覆盖。</p>
      ) : null}
      {excludedUnverified.length > 0 ? (
        <p className="fact-card__note">未核实现金账户 {excludedUnverified.map((account) => account.source).join("、")} 已在本页试算中排除，未计入试算金额；默认口径同样不计入其金额。</p>
      ) : null}
      {activeConflict.length > 0 ? (
        <p className="fact-card__stale">现金账户元数据冲突待核对：{activeConflict.map((account) => account.source).join("、")} 的重复元数据冲突，无法唯一关联，金额只作已记录事实，未计入可动用现金，本次未输出覆盖。</p>
      ) : null}
      {excludedConflict.length > 0 ? (
        <p className="fact-card__note">元数据冲突现金账户 {excludedConflict.map((account) => account.source).join("、")} 已在本页试算中排除，未计入试算金额；默认口径同样不计入其金额，待核对后恢复。</p>
      ) : null}
      <div className="cash-scope-list">
        {balanceAccounts.length === 0 ? <p className="empty-inline">最新快照没有余额账户。</p> : null}
        {balanceAccounts.map((account) => {
          const eligible = account.availableCash === true;
          const included = eligible && !excludedSources.has(account.source);
          return (
            <div className="cash-scope-row" key={`cash-scope-${account.source}`}>
              <div>
                <strong>{account.label}</strong>
                <span>
                  {accountCashRoleLabel(account.cashflowRole ?? null)}
                  {" · "}余额日期 {account.balanceDate ?? "未知"}{account.balanceDate != null && account.balanceDate !== "" && !isValidBalanceDateText(account.balanceDate) ? "（日期无效）" : ""}
                  {" · "}{verificationText(account.verified ?? null)}
                  {account.metadataConflict ? " · 元数据冲突待核对" : ""}
                  {account.status ? ` · 状态 ${account.status}` : ""}
                  {" · "}{account.live ? "同步读取" : "月度快照"}
                </span>
              </div>
              <b className="neutral">{currencyPrecise.format(account.value)}</b>
              {eligible ? (
                <label className="cash-scope-toggle">
                  <input
                    type="checkbox"
                    checked={included}
                    onChange={() => onToggle(account.source)}
                    aria-label={`本页试算纳入可动用现金：${account.label}`}
                  />
                  纳入
                </label>
              ) : (
                <span className="cash-scope-excluded">不计入</span>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

// F2.3: search over the full holdings set. Filtering only selects
// which rows are visible — a row's stored share and the fixed
// denominator (holdingsTotal) are never recomputed from the
// filtered subset, so searching cannot move the concentration
// figures.
export function filterHoldings<T extends { ticker: string; name: string }>(rows: T[], query: string): T[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return rows;
  return rows.filter((row) => row.ticker.toLowerCase().includes(needle) || row.name.toLowerCase().includes(needle));
}

// F2.3: the holdings section. The Top 10 stays a concise summary
// (shares and the Top-3 concentration divide by the fixed
// denominator — every valid non-cash holding, long tail
// included). Below it, a read-only explorer searches and expands
// the full normalized set the server persisted: cash is listed
// separately row by row, and positions the source could not
// classify （缺市值 / 负头寸 / 币种不明或非美元） are listed as
// 待核对 with their reason — never silently dropped, never
// defaulted to USD holdings. Holdings market values are a Plaid
// detail caliber and are never added to the investment account
// balances shown elsewhere. Nothing here trades, predicts or
// backtests. Legacy caches (holdingsComplete=false) stored only
// the Top 10: the long tail is stated as unrecoverable until the
// next refresh, and the stored full-set denominator is kept as
// recorded rather than recomputed from the Top 10.
function HoldingsSection({ data }: { data: Dashboard }) {
  const [expanded, setExpanded] = useState(false);
  // LIFE-DESIGN-001-B1A: the summary list defaults to the Top 5;
  // the full Top 10 is one tap away and the full-set explorer
  // below is unchanged.
  const [showAllTop, setShowAllTop] = useState(false);
  const topRows = showAllTop ? data.holdings : data.holdings.slice(0, 5);
  const [query, setQuery] = useState("");
  const complete = data.holdingsComplete;
  const all = data.holdingsAll;
  const rankByTicker = new Map(all.map((row, index) => [row.ticker, index + 1] as const));
  const visible = filterHoldings(all, query);
  const coveredInstitutions = [...new Set(all.flatMap((row) => row.institutions))];
  const asOfDate = new Date(data.asOf);
  const asOfText = Number.isNaN(asOfDate.getTime()) ? "未提供" : dateLabel.format(asOfDate);
  return (
    <section className="holdings-section section-block">
      <SectionTitle
        title="持仓 Top 10"
        meta={complete && data.holdingsTotal != null
          ? `前三集中度 ${percent.format(data.concentrationTop3)} · 分母 全部有效持仓 ${currency.format(data.holdingsTotal)}`
          : `前三集中度 ${percent.format(data.concentrationTop3)}（同步时按全部持仓计算）`}
      />
      {data.holdings.length ? (
        <div className="holding-list">
          {topRows.map((holding, index) => (
            <div className="holding-row" key={`${holding.ticker}-${index}`}>
              <div className="holding-rank">{String(index + 1).padStart(2, "0")}</div>
              <div className="holding-name"><strong>{holding.ticker}</strong>{holding.name ? <span>{holding.name}</span> : null}</div>
              <div className="holding-bar" aria-hidden="true"><span style={{ width: `${Math.min(holding.share * 100, 100)}%` }} /></div>
              <div className="holding-value"><strong>{currency.format(holding.value)}</strong><span>{percent.format(holding.share)}</span></div>
            </div>
          ))}
        </div>
      ) : <p className="empty-inline">本次同步没有返回可展示的持仓。</p>}

      {data.holdings.length > 5 ? (
        <button
          type="button"
          className="holdings-toggle holdings-toggle--top"
          aria-expanded={showAllTop}
          aria-label={showAllTop ? "收起至 Top 5" : `查看全部 Top 10（共 ${data.holdings.length} 只）`}
          onClick={() => setShowAllTop((value) => !value)}
        >
          {showAllTop ? "收起至 Top 5" : `查看全部 Top 10（共 ${data.holdings.length} 只）`}
        </button>
      ) : null}

      {data.holdingsCash.length > 0 ? (
        <div aria-label="现金（单列）">
          {data.holdingsCash.map((row) => (
            <div className="cash-position" key={`${row.ticker}-${row.currency ?? ""}`}>
              <div className="institution-icon" aria-hidden="true">$</div>
              <div>
                <strong>现金 · {row.ticker}</strong>
                <span>{row.name ? `${row.name} · ` : ""}单列，不计入持仓分母与集中度</span>
              </div>
              <b>{currency.format(row.value)}{row.currency ? ` ${row.currency}` : ""}</b>
            </div>
          ))}
          {data.cashPosition != null && data.holdingsCash.length > 1 ? (
            <p className="holdings-cash-total">其中美元现金合计 {currency.format(data.cashPosition)}（与存款分开解读）</p>
          ) : null}
        </div>
      ) : data.cashPosition != null ? (
        <div className="cash-position">
          <div className="institution-icon" aria-hidden="true">$</div>
          <div><strong>现金头寸</strong><span>CUR:USD · 与存款分开解读</span></div>
          <b>{currency.format(data.cashPosition)}</b>
        </div>
      ) : null}

      {complete ? (
        <div className="holdings-explorer">
          <button
            type="button"
            className="holdings-toggle"
            aria-expanded={expanded}
            aria-label={expanded ? "收起全部持仓" : `查看全部持仓（共 ${all.length} 只）`}
            onClick={() => setExpanded((value) => !value)}
          >
            {expanded ? "收起全部持仓" : `查看全部持仓（共 ${all.length} 只）`}
          </button>
          {expanded ? (
            <div className="holdings-explorer__panel">
              <label className="holdings-search">
                <span>搜索全部持仓</span>
                <input
                  type="search"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="代码或名称，如 VOO"
                  aria-label="搜索全部持仓（代码或名称）"
                />
              </label>
              <p className="holdings-coverage">
                数据日期 {asOfText}
                {" · "}覆盖机构 {coveredInstitutions.length > 0 ? `${coveredInstitutions.length} 家（${coveredInstitutions.join("、")}）` : "未提供"}
                {" · "}分母：全部有效持仓市值 {data.holdingsTotal != null ? currency.format(data.holdingsTotal) : "未提供"}（现金与待核对持仓不计入；搜索只筛选显示，不改变分母与占比）
                {" · "}持仓明细与投资账户余额是两个口径，不叠加
              </p>
              {data.holdingsTruncated ? (
                <p className="holdings-note">持仓只数超过保存上限，仅保留市值最大的 500 只；分母仍为全部有效持仓市值。</p>
              ) : null}
              {visible.length > 0 ? (
                <div className="holding-list">
                  {visible.map((row) => (
                    <div className="holding-row" key={row.ticker}>
                      <div className="holding-rank">{String(rankByTicker.get(row.ticker) ?? 0).padStart(2, "0")}</div>
                      <div className="holding-name">
                        <strong>{row.ticker}</strong>
                        {row.name ? <span>{row.name}</span> : null}
                        {row.institutions.length > 1
                          ? <span>{row.institutions.length} 家机构持有：{row.institutions.join("、")}（同代码已合并）</span>
                          : row.institutions.length === 1 ? <span>机构：{row.institutions[0]}</span> : null}
                      </div>
                      <div className="holding-bar" aria-hidden="true"><span style={{ width: `${Math.min(row.share * 100, 100)}%` }} /></div>
                      <div className="holding-value"><strong>{currency.format(row.value)}</strong><span>{percent.format(row.share)}</span></div>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="empty-inline">没有匹配「{query}」的持仓；分母与占比口径不变。</p>
              )}
              <p className="holdings-count">显示 {visible.length} / {all.length} 只 · 只读，不提供买卖建议</p>
              {data.holdingsUnclassified.length > 0 ? (
                <div className="holdings-unclassified">
                  <h3>待核对（未计入分母）</h3>
                  <div className="holding-list">
                    {data.holdingsUnclassified.map((row, index) => (
                      <div className="holding-row holding-row--plain" key={`${row.ticker}-${index}`}>
                        <div className="holding-name">
                          <strong>{row.ticker}</strong>
                          {row.name ? <span>{row.name}</span> : null}
                          <span>{row.reason}</span>
                        </div>
                        <div className="holding-value">
                          <strong>{row.value == null ? "市值未提供" : `${currencyPrecise.format(row.value)}${row.currency ? ` ${row.currency}` : ""}`}</strong>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : (
        <p className="holdings-legacy-note">
          全部持仓明细：当前缓存只保存了 Top 10 摘要，长尾持仓未保存、不可恢复；下一次成功刷新后可在此搜索并展开全部持仓。占比与前三集中度沿用同步时按全部有效持仓计算的分母，不以 Top 10 重算。
        </p>
      )}
    </section>
  );
}

type ArchNetWorthData = NonNullable<Dashboard["archNetWorth"]>;

// Same display rule as the server's displayLabel: underscores
// become spaces and each word is capitalized.
function archDisplayLabel(id: string): string {
  return id.replace(/_/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

// F-ARCH-001·DATE-1 (P1) card model: pure text derivations for
// the arch card, exported so the offline validator can exercise
// the exact strings the card renders. All date validity goes
// through the existing isRealDateText — no second rule.

// The one-line coverage statement: denominators are always the
// full row count; the numerators count included amounts and
// included rows carrying a valid calendar balance date.
export function archCoverageLine(arch: ArchNetWorthData): string {
  return `金额已计入 ${arch.amountIncluded}/${arch.amountTotal}；有效余额日期 ${arch.validDateCount}/${arch.dateTotal}`;
}

// A layer's range line. Ranges arrive pre-sanitized from the
// server (valid calendar dates only). A null range with rows in
// the layer means every balance date in it is invalid/unknown —
// stated as such, never as "no accounts".
export function archLayerLine(
  range: ArchNetWorthData["plaidRange"],
  layerHasRows: boolean,
): string {
  if (range) return `余额日期 ${range.oldest} 至 ${range.newest}`;
  return layerHasRows ? "无有效余额日期（日期无效或未知）" : "本层无账户";
}

// One detail row's date label. The stored value is always shown
// as-is: a valid date plainly, a non-null invalid date with its
// original text plus 日期无效， a null date as 日期未知.
// Missing rows are a separate category （缺失未计入） and never
// borrow a date label.
export function archRowDateLabel(row: ArchNetWorthData["rows"][number]): string {
  if (row.coverage === "missing") return "缺失未计入";
  const layer = row.coverage === "plaid" ? "Plaid 同步" : "快照";
  if (row.asOf === null) return `${layer} · 日期未知`;
  if (!isRealDateText(row.asOf)) return `${layer} · ${row.asOf} · 日期无效`;
  return `${layer} · ${row.asOf}`;
}

// LIFE-DESIGN-001-B1A: the F-ARCH per-account rows move from
// the old card's fold into the detail tab's ledger layer —
// this is the 「逐户日期见明细」 the conclusion card's snapshot
// layer line points at. Row rendering (name, DATE-1 date label,
// signed amount) is unchanged; freshness is stated per layer in
// text + symbol, never by color alone.
function ArchAccountsDetail({ arch, liveNetWorth, weeklyDelta }: { arch: ArchNetWorthData; liveNetWorth: number; weeklyDelta: number | null }) {
  return (
    <section className="section-block" aria-label="总资产账户明细（新架构）">
      <SectionTitle title="总资产账户明细" meta={`新架构（F-ARCH-001）· ${arch.rows.length} 个账户`} />
      <p className="fact-card__note">
        旧同步口径对照（明细追溯）：旧同步净资产 {currency.format(liveNetWorth)}
        {weeklyDelta != null
          ? ` · 旧同步口径 · 较上次成功快照（日期未留存）${trendIndicator(weeklyDelta)} ${signedCurrency(weeklyDelta)}`
          : " · 旧同步口径暂无可比快照"}
        ；本节逐户金额与总览主数字为新架构（F-ARCH-001）口径，与旧同步口径不要互相推导。
      </p>
      <div className="arch-rows arch-rows--detail">
        {arch.rows.map((row) => (
          <div className="arch-row" key={row.id}>
            <span className="arch-row__name">{archDisplayLabel(row.id)}</span>
            <span className="arch-row__tag">{archRowDateLabel(row)}</span>
            <b>{row.included && row.signed != null ? signedCurrency(row.signed) : "—"}</b>
          </div>
        ))}
      </div>
    </section>
  );
}

// LIFE-DESIGN-001-B1A: one-line summaries for the overview
// tab's folded evidence layer (R3a — every fold's summary
// carries its key numbers). All three derive from the same
// figures their full panels render; nothing is recomputed
// under a new caliber.

// Available-cash scope: the server-caliber amount, how many
// accounts are counted in, and — when coverage was blocked —
// a visible flag in the folded state (R6: anomaly states are
// never fully hidden inside a fold).
export function cashScopeSummaryLine(cashAmount: number | null, selectedCount: number, blockedReason: string | null): string {
  const amount = cashAmount == null ? "未提供" : currency.format(cashAmount);
  const blocked = blockedReason ? " · 覆盖未输出，展开查看原因" : "";
  return `可动用现金账户范围 — ${amount} · 计入 ${selectedCount} 个账户${blocked}`;
}

// Whole-period investment reconciliation: the reconciled
// return (or 待核对） the full card reports.
export function investmentSummaryLine(perf: Dashboard["investmentPerformance"]): string {
  if (perf.returnAmount == null) return "投资收益核对 — 全期间待核对";
  const label = perf.returnAmount > 0 ? "收益" : perf.returnAmount < 0 ? "亏损" : "持平";
  return `投资收益核对 — 全期间${label} ${trendIndicator(perf.returnAmount)} ${signedCurrency(perf.returnAmount)} · 已核对`;
}

// Holdings: the Top-3 concentration (already the section's
// headline meta) plus the full-set count.
export function holdingsSummaryLine(data: Dashboard): string {
  const count = data.holdingsAll.length > 0 ? ` · 全部持仓 ${data.holdingsAll.length} 只` : "";
  return `持仓 — 前三集中度 ${percent.format(data.concentrationTop3)}${count}`;
}

function DashboardView({ data, refreshFailed }: { data: Dashboard; refreshFailed: boolean }) {
  const [range, setRange] = useState<Range>("12m");
  // F1.1: the owner's available-cash trial selection. Page-local
  // state only — never persisted, never sent to the server.
  const [excludedCashSources, setExcludedCashSources] = useState<ReadonlySet<string>>(new Set());
  const toggleCashSource = (source: string) => {
    setExcludedCashSources((previous) => {
      const next = new Set(previous);
      if (next.has(source)) next.delete(source);
      else next.add(source);
      return next;
    });
  };
  // LIFE-DESIGN-001-B1A: two tabs — 总览 (conclusion + folded
  // evidence) and 明细 (the ledger layer). Tab state, fold
  // states and the cash trial are mount-time component state
  // only: every fresh page open starts on the overview tab with
  // every fold at its default (owner ruling 2026-10-24, design
  // option 2 — nothing is persisted anywhere).
  const [tab, setTab] = useState<"overview" | "detail">("overview");
  const pendingAnchor = useRef<string | null>(null);
  useEffect(() => {
    if (tab === "detail" && pendingAnchor.current) {
      const anchor = pendingAnchor.current;
      pendingAnchor.current = null;
      document.getElementById(anchor)?.scrollIntoView({ block: "start" });
    }
  }, [tab]);
  const goDetail = (anchor: string) => {
    pendingAnchor.current = anchor;
    setTab("detail");
  };
  const months = useMemo(() => {
    if (range === "6m") return data.months.slice(-6);
    if (range === "12m") return data.months.slice(-12);
    if (range === "year") {
      const year = data.months.at(-1)?.key.slice(0, 4);
      return data.months.filter((month) => month.key.startsWith(year ?? ""));
    }
    return data.months;
  }, [data.months, range]);
  const current = data.months.at(-1);
  if (!current) return null;

  const savingsRate = current.income > 0 && current.totalSpend != null ? (current.income - current.totalSpend) / current.income : null;
  // F0.5: when the latest month lacks income or spend provenance, the
  // rate is a recorded value only, not a complete-month savings rate.
  const savingsRateNote = current.incomeProven && current.spendProven
    ? "（收入 − 支出）÷ 收入"
    : "（收入 − 支出）÷ 收入；已记录值，收入/支出依据未齐，非完整月储蓄率";
  // F1.1: emergency coverage divides AVAILABLE CASH (only accounts
  // classified cash — never every positive balance) by the average
  // spend of the last 3 valid complete months only. With fewer
  // than 3 months, stale/missing cash, a non-positive spend basis
  // or an exclude-all trial, no coverage figure is produced — the
  // gap is stated, never 0-filled. A true cash 0 is a real 0.
  const spendBasis = completeSpendBasis(data.months);
  const coverage = emergencyCoverage(
    data.accounts,
    data.live.availableCash,
    data.live.availableCashStale ?? [],
    excludedCashSources,
    spendBasis,
  );
  const emergencyMonths = coverage.months;
  const emergencyNote = coverage.reason
    ?? `可动用现金 ${currency.format(coverage.cashAmount ?? 0)} ÷ 平均月支出 ${currency.format(spendBasis.averageMonthlySpend ?? 0)}（所用月份 ${spendBasis.usedMonthKeys.join("、")}）${excludedCashSources.size > 0 ? " · 本页试算" : ""}`;

  return (
    <>
      <div className="view-tabs" role="tablist" aria-label="财务视图切换">
        <button type="button" role="tab" aria-selected={tab === "overview"} className={tab === "overview" ? "active" : ""} onClick={() => setTab("overview")}>总览</button>
        <button type="button" role="tab" aria-selected={tab === "detail"} className={tab === "detail" ? "active" : ""} onClick={() => setTab("detail")}>明细</button>
      </div>
      {tab === "overview" ? (
        <OverviewTab
          data={data}
          refreshFailed={refreshFailed}
          current={current}
          savingsRate={savingsRate}
          savingsRateNote={savingsRateNote}
          emergencyMonths={emergencyMonths}
          emergencyNote={emergencyNote}
          coverage={coverage}
          excludedCashSources={excludedCashSources}
          onToggleCashSource={toggleCashSource}
          onGoDetail={goDetail}
        />
      ) : (
        <DetailTab data={data} months={months} range={range} onRangeChange={setRange} />
      )}
    </>
  );
}

// LIFE-DESIGN-001-B1A: the overview tab — conclusion layer
// plus the folded evidence layer, default ≈3 screens (R1/R2).
// Blocks, in the established home-page priority order:
// total-assets conclusion card → this month's 7 key metrics →
// data-anomaly strip (R6, never folded) → one-line FIRE
// summary with an anchor into the detail tab → four evidence
// folds whose summaries carry their key numbers (R3a).
function OverviewTab({
  data,
  refreshFailed,
  current,
  savingsRate,
  savingsRateNote,
  emergencyMonths,
  emergencyNote,
  coverage,
  excludedCashSources,
  onToggleCashSource,
  onGoDetail,
}: {
  data: Dashboard;
  refreshFailed: boolean;
  current: Month;
  savingsRate: number | null;
  savingsRateNote: string;
  emergencyMonths: number | null;
  emergencyNote: string;
  coverage: ReturnType<typeof emergencyCoverage>;
  excludedCashSources: ReadonlySet<string>;
  onToggleCashSource: (source: string) => void;
  onGoDetail: (anchor: string) => void;
}) {
  const anomalyMonths = data.months.filter((month) => month.flexibleSpendAnomaly);
  const foldHint = (
    <>
      <span className="fold-hint fold-hint--open">展开</span>
      <span className="fold-hint fold-hint--close">收起</span>
    </>
  );
  return (
    <>
      <TotalAssetsConclusionCard data={data} refreshFailed={refreshFailed} />

      <section className="metric-grid" aria-label="本月关键指标">
        <Metric label="月收入" value={<span title={currency.format(current.income)}>{compactCurrency.format(current.income)}</span>} />
        <Metric label="月支出" value={current.totalSpend == null ? "—" : <span title={currency.format(current.totalSpend)}>{compactCurrency.format(current.totalSpend)}</span>} note={current.totalSpend == null ? `固定 ${compactCurrency.format(current.fixedSpend)} · 灵活支出待核对` : `固定 ${compactCurrency.format(current.fixedSpend)}`} />
        <Metric label="储蓄率" value={savingsRate == null ? "—" : <>{trendIndicator(savingsRate)} {percent.format(savingsRate)}</>} tone={valueTone(savingsRate)} note={savingsRateNote} />
        <Metric label="应急金覆盖" value={emergencyMonths == null ? "—" : `${number.format(emergencyMonths)} 个月`} note={emergencyNote} />
        <Metric label="投资" value={<span title={currency.format(data.live.investment)}>{compactCurrency.format(data.live.investment)}</span>} note="已融合实时余额" />
        <Metric label="可动用现金" value={coverage.cashAmount == null ? "—" : <span title={currency.format(coverage.cashAmount)}>{compactCurrency.format(coverage.cashAmount)}</span>} note={coverage.cashAmount == null ? (coverage.reason ?? "现金未提供") : `仅现金类账户 ${coverage.selectedCount} 个 · 不含 HSA/债券/退休/信用卡/贷款${excludedCashSources.size > 0 ? " · 本页试算" : ""}`} />
        <Metric label="贷款" value={<span title={currency.format(data.live.loans ?? 0)}>{compactCurrency.format(data.live.loans ?? 0)}</span>} note="按未偿余额显示" />
      </section>

      {anomalyMonths.length > 0 ? (
        <div className="data-anomaly" role="note" aria-label="数据异常月份">
          <strong>数据异常</strong>
          <span>{anomalyMonths.map((month) => monthLabel.format(monthDate(month.key))).join("、")} 仍保留在月度记录中；支出在图表中为断点，不进入 FIRE 年支出。</span>
        </div>
      ) : null}

      <section className="fire-teaser" aria-label="FIRE 进度摘要">
        <p>{fireSummaryLine(data.fire)}</p>
        <button type="button" onClick={() => onGoDetail("fire-panel")}>查看完整 FIRE 面板</button>
      </section>

      <div className="evidence-layer">
        <details className="evidence-fold">
          <summary><span>{cashScopeSummaryLine(coverage.cashAmount, coverage.selectedCount, coverage.reason)}</span>{foldHint}</summary>
          <AvailableCashPanel
            data={data}
            excludedSources={excludedCashSources}
            onToggle={onToggleCashSource}
            trialCashAmount={coverage.cashAmount}
          />
        </details>

        <details className="evidence-fold">
          <summary><span>资产 / 支出分布 — {distributionSummaryLine(data.live)}</span>{foldHint}</summary>
          <DistributionPanel current={current} live={data.live} />
        </details>

        <details className="evidence-fold">
          <summary><span>{investmentSummaryLine(data.investmentPerformance)}</span>{foldHint}</summary>
          <InvestmentPerformanceCard data={data} />
        </details>

        <details className="evidence-fold">
          <summary><span>{holdingsSummaryLine(data)}</span>{foldHint}</summary>
          <HoldingsSection data={data} />
        </details>
      </div>
    </>
  );
}

// LIFE-DESIGN-001-B1A: the detail tab — the ledger layer
// (R3c/R10). Everything that used to stretch the single page
// lives here, one tap from the overview: trend charts, the
// full FIRE panel, the monthly records, the F-ARCH per-account
// rows and the snapshot account detail. Content and wording
// are the former single-page blocks, moved not rewritten.
function DetailTab({
  data,
  months,
  range,
  onRangeChange,
}: {
  data: Dashboard;
  months: Month[];
  range: Range;
  onRangeChange: (range: Range) => void;
}) {
  const grouped = new Map<string, Account[]>();
  for (const account of data.accounts) {
    const institution = institutionName(account);
    grouped.set(institution, [...(grouped.get(institution) ?? []), account]);
  }
  const accountGroups = [...grouped.entries()].sort((a, b) => {
    const aTotal = a[1].reduce((sum, item) => sum + Math.abs(item.value), 0);
    const bTotal = b[1].reduce((sum, item) => sum + Math.abs(item.value), 0);
    return bTotal - aTotal;
  });
  return (
    <>
      <section className="section-block">
        <div className="section-heading-row">
          <SectionTitle title="走势" meta={`${months.filter((month) => !month.flexibleSpendAnomaly).length} 个有效快照`} />
          <div className="range-control" aria-label="趋势时间范围">
            {(["6m", "12m", "year", "all"] as Range[]).map((item) => (
              <button key={item} type="button" className={range === item ? "active" : ""} onClick={() => onRangeChange(item)} aria-pressed={range === item}>
                {item === "6m" ? "6月" : item === "12m" ? "12月" : item === "year" ? "今年" : "全部"}
              </button>
            ))}
          </div>
        </div>
        <TrendCharts months={months} />
      </section>

      <section className="section-block">
        <SectionTitle title="月度记录" meta="每月一份快照 · 点按展开" />
        <MonthlyRecords months={data.months} />
      </section>

      <section className="fire-section section-block" id="fire-panel">
        <SectionTitle title="FIRE 进度" meta={data.fire.completeMonthsUsed > 0 ? `4% 规则 · 近 ${data.fire.completeMonthsUsed} 个完整有效月` : "4% 规则 · 完整月份不足"} />
        <FireProgress data={data} />
      </section>

      {data.archNetWorth ? <ArchAccountsDetail arch={data.archNetWorth} liveNetWorth={data.live.netWorth} weeklyDelta={data.live.weeklyDelta} /> : null}

      <section className="accounts-section section-block">
        <SectionTitle title="账户明细" meta={`快照 ${data.sourceMonth}`} />
        <div className="account-groups">
          {accountGroups.map(([institution, rows]) => (
            <div className="account-group" key={institution}>
              <div className="account-group__heading"><span className="institution-icon" aria-hidden="true">{institution.slice(0, 1).toUpperCase()}</span><h3>{institution}</h3></div>
              <div>
                {rows.map((account) => {
                  const isLoan = account.type === "account" && account.value < 0;
                  return (
                    <div className="account-row" key={`${account.type}-${account.source}`}>
                      <div>
                        <strong>{account.label}</strong>
                        <span>{accountTypeLabel(account.type)}{isLoan ? " · 负债" : ""} · {account.live ? "同步读取" : "月度快照"}{account.mask ? ` ···${account.mask}` : ""}{account.type === "account" ? ` · 分类：${cashflowRoleLabel(account.cashflowRole ?? null)}` : ""}</span>
                      </div>
                      <b className="neutral">{isLoan ? `−${currencyPrecise.format(Math.abs(account.value))}` : currencyPrecise.format(account.value)}</b>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </section>
    </>
  );
}

// F0.7 observability: text labels for the refresh-chain
// observation stream. Meaning rides on words and symbols, never
// on color alone (the user is color-weak): each event and each
// ignore-reason code has a plain Chinese reading, and the
// diagnosis carries a symbol next to its sentence.
export function observationEventText(event: string): string {
  switch (event) {
    case "refresh_started": return "刷新已启动（代次已领取）";
    case "spawn_attached": return "任务已启动并附着";
    case "spawn_failed": return "任务启动失败";
    case "spawn_tail_unattached": return "任务尾部未能附着（状态已归他人）";
    case "callback_received": return "收到回调";
    case "callback_applied_success": return "回调已落盘（成功）";
    case "callback_applied_failure": return "回调已落盘（失败收尾）";
    case "callback_ignored": return "回调被忽略（未落盘）";
    default: return event;
  }
}

export function observationOutcomeText(outcome: string): string {
  switch (outcome) {
    case "success_flag": return "回调报成功";
    case "failure_flag": return "回调报失败";
    case "claimed": return "领取成功";
    case "task_attached": return "已附着任务";
    case "spawn_returned_failure": return "spawn 返回失败";
    case "spawn_ok_tail": return "spawn 成功但尾部未命中";
    case "spawn_failed_tail": return "spawn 失败且尾部未命中";
    default: return outcome;
  }
}

export function observationDetailText(detail: string | null): string | null {
  if (detail == null) return null;
  if (detail.startsWith("saved_months:")) {
    return `保存 ${detail.slice("saved_months:".length)} 个月`;
  }
  switch (detail) {
    case "generation_gate": return "代次不符（旧代/外来回调）";
    case "stale_decision": return "数据不新于已存快照或属于上一代";
    case "claim_lost": return "领取仲裁未胜出";
    case "settle_superseded": return "落盘时已被新一代取代";
    case "spawn_error": return "spawn 出错";
    case "spawn_tail": return "尾部写入未命中";
    case "status_idle": return "当时状态：已完成";
    case "status_error": return "当时状态：失败";
    case "status_running": return "当时状态：进行中（新一代）";
    case "normalization_issue": return "快照数据校验未通过";
    case "no_dashboard": return "无可用月度数据";
    default: return detail;
  }
}

export function refreshDiagnosisSymbol(code: string): string {
  switch (code) {
    case "settled_success": return "✓";
    case "settled_success_unrecorded": return "✓";
    case "settled_failure": return "▲";
    case "spawn_failed": return "▲";
    case "callback_ignored": return "●";
    case "awaiting_callback": return "↻";
    default: return "○";
  }
}

// F0.7-OBS-001: per-row attempt attribution as a plain text tag —
// the row's relation to the current attempt rides on words, never
// on color alone. History rows name their own attempt ordinal;
// unattributable rows say so.
export function observationRelationText(relation: string, attempt: number | null): string {
  if (relation === "current") return attempt != null ? `当前尝试 #${attempt}` : "当前尝试";
  if (relation === "history") return attempt != null ? `历史尝试 #${attempt}` : "历史尝试";
  return "归属未知";
}

// F0.7-OBS-001 (B-class presentation increment): the read-only
// 「检查进度」 check. One channel's outcome of a single manual
// progress check: whether THIS session actually received a fresh
// response, when the local device received it (epoch ms — a
// client-side receipt instant, never a server update time), the
// refresh status that response carried, whether it carried
// successful data, and the attempt start it reported. The
// dashboard channel additionally carries its own message (the
// only client-visible signal that a saved payload is unreadable)
// and the stored payload's asOf; the observations channel
// additionally carries the CURRENT generation's diagnosis code,
// attempt ordinal, and diagnosis text, because the dashboard's
// status is only a projection (a stored "running" past the wait
// window, or an unreadable saved payload, both surface as "error"
// without any state write) and must never be read as a terminal
// verdict. The diagnosis text is the server's own current-
// generation wording: under code "awaiting_callback" it alone
// distinguishes "this generation's callback has arrived, its
// result event is not yet recorded" from "no callback of this
// generation has arrived" — the code by itself cannot.
export type ProgressReadOutcome = {
  ok: boolean;
  receivedAt: number | null;
  refreshStatus: RefreshStatus | null;
  hasData: boolean;
  startedAt: string | null;
  message: string | null;
  asOf: string | null;
  diagnosisCode: string | null;
  diagnosisAttempt: number | null;
  diagnosisText: string | null;
};

export type ProgressReadRaw = {
  refreshStatus: RefreshStatus | null;
  hasData: boolean;
  startedAt: string | null;
  message?: string | null;
  asOf?: string | null;
  diagnosisCode?: string | null;
  diagnosisAttempt?: number | null;
  diagnosisText?: string | null;
};

export type CheckProgressFeedback = {
  anyRead: boolean;
  allRead: boolean;
  headline: string;
  dashboardLine: string;
  observationsLine: string;
  refreshResultLine: string;
  dataFactLine: string;
  waitedText: string | null;
  note: string;
};

// Runs ONE manual progress check: exactly the two read-only
// refetches (dashboard + observations), in parallel, each settled
// independently so one channel's failure never fails the other.
// The shared gate makes a double-click a no-op (returns null)
// instead of a second pair of reads; the gate is released when
// the check settles, so a later click checks again. There is no
// mutation path here at all — no refresh is started, no task is
// spawned, no new generation is created. A failed channel keeps
// receivedAt null: the "最近读取" time is only ever stamped by a
// response this session actually received.
export async function performProgressCheck(args: {
  gate: { inFlight: boolean };
  readDashboard: () => Promise<ProgressReadRaw>;
  readObservations: () => Promise<ProgressReadRaw>;
  now: () => number;
}): Promise<{ dashboard: ProgressReadOutcome; observations: ProgressReadOutcome } | null> {
  if (args.gate.inFlight) return null;
  args.gate.inFlight = true;
  const settle = async (read: () => Promise<ProgressReadRaw>): Promise<ProgressReadOutcome> => {
    try {
      const raw = await read();
      return {
        ok: true,
        receivedAt: args.now(),
        refreshStatus: raw.refreshStatus,
        hasData: raw.hasData,
        startedAt: raw.startedAt,
        message: raw.message ?? null,
        asOf: raw.asOf ?? null,
        diagnosisCode: raw.diagnosisCode ?? null,
        diagnosisAttempt: raw.diagnosisAttempt ?? null,
        diagnosisText: raw.diagnosisText ?? null,
      };
    } catch {
      return {
        ok: false,
        receivedAt: null,
        refreshStatus: null,
        hasData: false,
        startedAt: null,
        message: null,
        asOf: null,
        diagnosisCode: null,
        diagnosisAttempt: null,
        diagnosisText: null,
      };
    }
  };
  try {
    const dashboardRead = settle(args.readDashboard);
    const observationsRead = settle(args.readObservations);
    return { dashboard: await dashboardRead, observations: await observationsRead };
  } finally {
    args.gate.inFlight = false;
  }
}

// Pure feedback wording for one manual progress check, in three
// separately-attributed layers — the two reads settle at
// different instants, so each layer states only what its own
// channel actually showed, never a merged instant conclusion:
//  1. 读取结果 — each channel on its own line with its own
//     result and its own local receipt time; a partial read is
//     never merged into an "all verified" claim.
//  2. 刷新结果 — derived ONLY from the observations channel's
//     current-generation diagnosis and the RAW stored state. The
//     dashboard's status is a projection (stored "running" past
//     the wait window, or an unreadable saved payload, both read
//     as "error" with no state write), so it can never by itself
//     earn a terminal verdict: a projected "error" over a still-
//     running generation is "超过等待窗口，执行终态尚不能确认",
//     never a failure terminal, and a legacy "idle" with no bound
//     generation is never a completed terminal either. When the
//     observations channel itself failed to read, the projection
//     alone still earns no terminal claim.
//  3. 数据事实 — what the dashboard read carried: the last
//     successful snapshot, no successful data yet, or saved data
//     unreadable — plus the standing fact that this check is
//     read-only and changed nothing.
// Reading successfully is never worded as the refresh having
// succeeded, let alone as a bank reconciliation. The waited
// duration shows while the current generation is still awaiting
// its callback (the observations channel's startedAt preferred),
// and is only computed from a present, parseable attempt start
// that is not in the future; a missing or invalid startedAt
// yields no waited claim at all.
export function checkProgressFeedback(input: {
  dashboard: ProgressReadOutcome;
  observations: ProgressReadOutcome;
  nowMs: number;
  formatTime: (ms: number) => string;
}): CheckProgressFeedback {
  const { dashboard, observations } = input;
  const readLine = (label: string, read: ProgressReadOutcome): string => {
    if (!read.ok || read.receivedAt == null) {
      return `${label}：▲ 未读出（读取失败，最近读取时间未更新，保留此前显示）`;
    }
    const statusText = read.refreshStatus == null
      ? "状态未提供"
      : refreshStatusText(read.refreshStatus, read.hasData);
    return `${label}：✓ 已读取 · 最近读取状态：${input.formatTime(read.receivedAt)}（仅本次会话；本机收到响应的时刻，非服务器更新时间）· 当时状态：${statusText}`;
  };
  // The dashboard read itself reports an unreadable saved
  // payload: projected "error", no data carried, and the
  // dashboard's own message naming the saved data as corrupted.
  const payloadUnreadable = dashboard.ok
    && dashboard.refreshStatus === "error"
    && !dashboard.hasData
    && dashboard.message != null
    && dashboard.message.includes("已保存数据损坏");
  let headline: string;
  if (!dashboard.ok && !observations.ok) {
    headline = "进度暂未读出，尚不能确认本次更新结果";
  } else if (!dashboard.ok) {
    headline = "看板状态暂未读出，尚不能确认本次更新结果（观测记录一路已读出，见下方分路结果，不合成全部已核实）";
  } else if (!observations.ok) {
    headline = "看板状态已读取；观测记录一路未读出（见下方分路结果）";
  } else {
    headline = "状态已读取（两路结果分列如下）";
  }
  // Layer 2 — the refresh outcome, from the observations
  // channel's current-generation diagnosis and raw state only.
  const attemptTag = observations.ok && observations.diagnosisAttempt != null
    ? `（当前尝试 #${observations.diagnosisAttempt}）`
    : "";
  let refreshResultLine: string;
  if (payloadUnreadable) {
    refreshResultLine = "刷新结果：▲ 已保存数据无法读取，不能据此判定本次尝试结果";
  } else if (observations.ok) {
    const code = observations.diagnosisCode;
    const symbol = refreshDiagnosisSymbol(code ?? "");
    switch (code) {
      case "settled_success":
        refreshResultLine = `刷新结果${attemptTag}：${symbol} 最近一次尝试已成功收尾，新数据已保存（依据观测记录的业务状态与当前代事件）`;
        break;
      case "settled_success_unrecorded":
        refreshResultLine = `刷新结果${attemptTag}：${symbol} 最近一次尝试已成功收尾（以业务状态为准），但终态事件未记录`;
        break;
      case "settled_failure":
        refreshResultLine = `刷新结果${attemptTag}：${symbol} 最近一次尝试已结算失败（终态）`;
        break;
      case "spawn_failed":
        refreshResultLine = `刷新结果${attemptTag}：${symbol} 最近一次尝试未能启动（任务启动失败）`;
        break;
      case "callback_ignored":
        refreshResultLine = `刷新结果${attemptTag}：${symbol} 当前尝试的回调已到达但被忽略（未落盘保存）`;
        break;
      case "awaiting_callback": {
        // The code alone cannot say whether THIS generation's
        // callback has arrived: the server's diagnosis text can
        // (its arrived variant states 当前代回调已到达; the
        // default variant states no callback of this generation
        // has arrived). The text is scoped to the current
        // generation by the server — a historical generation's
        // received-callback event never reaches this diagnosis,
        // and nothing here infers arrival from event rows. Arrival
        // is progress, not a terminal: never word it as saved
        // or finished.
        const callbackArrived = observations.diagnosisText != null
          && observations.diagnosisText.includes("当前代回调已到达");
        // Raw state still running while the dashboard projects
        // "error": the stored attempt has outlived the wait
        // window — its execution terminal is unconfirmed, and
        // the projection must never be worded as a failure.
        const projectedPastWindow = dashboard.ok
          && dashboard.refreshStatus === "error"
          && observations.refreshStatus === "running";
        if (callbackArrived) {
          refreshResultLine = projectedPastWindow
            ? `刷新结果${attemptTag}：${symbol} 本代回调已到达，正在等待处理结果：已超过等待窗口，终态尚不能确认（看板状态为投影，原始状态仍为进行中）`
            : `刷新结果${attemptTag}：${symbol} 本代回调已到达，正在等待处理结果，终态尚不能确认`;
        } else {
          refreshResultLine = projectedPastWindow
            ? `刷新结果${attemptTag}：${symbol} 当前尝试仍在等待回调：已超过等待窗口，执行终态尚不能确认（看板状态为投影，原始状态仍为进行中）`
            : `刷新结果${attemptTag}：${symbol} 正在等待当前代回调，终态尚不能确认`;
        }
        break;
      }
      case "unattributed_history":
        refreshResultLine = `刷新结果：${symbol} 当前无进行中的刷新，最近尝试结果未证实（现有记录无法归属到当前尝试）`;
        break;
      case "no_attempt":
        refreshResultLine = `刷新结果：${symbol} 尚无刷新尝试记录`;
        break;
      default:
        // Read succeeded but carried no diagnosis: fall back to
        // the raw state alone, with no terminal claim beyond it.
        if (observations.refreshStatus === "running") {
          refreshResultLine = "刷新结果：当前尝试仍在进行中，仍未观测到终态（未提供当前代诊断）";
        } else if (observations.refreshStatus === "error") {
          refreshResultLine = "刷新结果：原始状态为失败，但未提供当前代诊断，不能仅凭此确认终态";
        } else if (observations.refreshStatus === "idle") {
          refreshResultLine = "刷新结果：原始状态为空闲，但未提供当前代诊断，最近尝试结果未证实";
        } else {
          refreshResultLine = "刷新结果：观测记录未包含当前尝试状态，尚不能确认本次尝试结果";
        }
    }
  } else if (dashboard.ok) {
    // The observations channel failed to read: the dashboard
    // projection alone never earns a terminal conclusion.
    if (dashboard.refreshStatus === "error") {
      refreshResultLine = "刷新结果：观测记录未读出，仅凭看板状态不能据此判定已失败（终态尚不能确认）";
    } else if (dashboard.refreshStatus === "idle") {
      refreshResultLine = "刷新结果：观测记录未读出，最近尝试结果未证实";
    } else if (dashboard.refreshStatus === "running") {
      refreshResultLine = "刷新结果：观测记录未读出，本次尝试仍未观测到终态";
    } else {
      refreshResultLine = "刷新结果：观测记录未读出，尚不能确认本次尝试结果";
    }
  } else {
    refreshResultLine = "刷新结果：两路均未读出，尚不能确认本次尝试结果";
  }
  // Layer 3 — the data facts the dashboard read carried.
  let dataFactLine: string;
  if (!dashboard.ok) {
    dataFactLine = "数据事实：看板一路未读出，本次检查未能确认当前数据状态；本次检查只读，未改变任何数据";
  } else if (payloadUnreadable) {
    dataFactLine = "数据事实：已保存数据无法读取，当前无可展示的成功数据；本次检查只读，未改变任何数据";
  } else if (dashboard.hasData) {
    const asOfMs = dashboard.asOf ? new Date(dashboard.asOf).getTime() : Number.NaN;
    const asOfText = Number.isNaN(asOfMs) ? "快照时间未提供" : `快照时间 ${input.formatTime(asOfMs)}`;
    dataFactLine = `数据事实：当前显示最后成功快照（${asOfText}）；本次检查只读，未改变任何数据`;
  } else {
    dataFactLine = "数据事实：尚无成功数据；本次检查只读，未改变任何数据";
  }
  // The waited duration tracks the CURRENT generation still
  // awaiting its callback — it survives a projected dashboard
  // "error", and prefers the observations channel's startedAt.
  const stillAwaiting = observations.ok
    ? observations.diagnosisCode === "awaiting_callback"
      || (observations.diagnosisCode == null && observations.refreshStatus === "running")
    : dashboard.ok && dashboard.refreshStatus === "running";
  let waitedText: string | null = null;
  if (stillAwaiting) {
    const startedAt = observations.ok
      ? (observations.startedAt ?? dashboard.startedAt)
      : dashboard.startedAt;
    if (startedAt) {
      const startMs = new Date(startedAt).getTime();
      if (!Number.isNaN(startMs) && input.nowMs >= startMs) {
        const minutes = Math.floor((input.nowMs - startMs) / 60000);
        waitedText = minutes >= 1 ? `本次尝试已等待约 ${minutes} 分钟（按尝试开始时刻计）` : "本次尝试已等待不足 1 分钟（按尝试开始时刻计）";
      }
    }
  }
  return {
    anyRead: dashboard.ok || observations.ok,
    allRead: dashboard.ok && observations.ok,
    headline,
    dashboardLine: readLine("看板状态", dashboard),
    observationsLine: readLine("观测记录", observations),
    refreshResultLine,
    dataFactLine,
    waitedText,
    note: "读取成功只表示本机读到了当时的状态，不等于刷新成功，也不等于银行对账成功。",
  };
}

// F0.7 observability panel: an expandable, read-only view of the
// refresh chain's recorded events, rendered inside the status
// band. It distinguishes the three failures the band alone cannot
// tell apart — task never ran, callback never arrived, callback
// arrived but was ignored. With no recorded rows it says so
// plainly; it never fabricates history.
//
// F0.7-OBS-001: the diagnosis line is the CURRENT attempt's
// conclusion (with its attempt ordinal), and the event list is
// split into the current attempt's own events vs history /
// unrelated events, each row carrying a text relation tag —
// older generations' events are never presented as evidence
// about the current attempt.
function RefreshObservationsPanel({
  observations,
}: {
  observations: UseQueryResult<ApiResponse<typeof api, "getRefreshObservations">>;
}) {
  const result = observations.data;
  const formatInstant = (value: string): string => {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "未提供" : timestampLabel.format(date);
  };
  return (
    <details className="refresh-band__ledger">
      <summary aria-label="刷新观测（刷新链各阶段的只读记录）">刷新观测</summary>
      {observations.isPending ? (
        <p className="refresh-band__note">正在读取观测记录…</p>
      ) : observations.isError || !result || result.access !== "owner" ? (
        <p className="refresh-band__note">观测记录暂时无法读取。</p>
      ) : result.observations.length === 0 ? (
        <p className="refresh-band__note">暂无观测记录（下一次刷新开始记录）</p>
      ) : (
        <>
          {result.diagnosis ? (
            <p className="refresh-band__note">
              <span aria-hidden="true">{refreshDiagnosisSymbol(result.diagnosis.code)}</span>
              {" "}当前尝试诊断{result.diagnosis.attempt != null ? `（尝试 #${result.diagnosis.attempt}）` : "（尝试序号未知）"}：{result.diagnosis.text}
            </p>
          ) : null}
          {result.state ? (
            <p className="refresh-band__note">
              当前状态：{result.state.status === "running" ? "进行中" : result.state.status === "error" ? "失败" : "空闲"}
              {" · "}当前尝试：{result.state.attempt != null ? `#${result.state.attempt}` : "未知"}
              {" · "}任务标识：{result.state.hasTaskId ? "有" : "无"}
              {" · "}代次标识：{result.state.hasGeneration ? "有" : "无"}
            </p>
          ) : null}
          {(() => {
            const currentRows = result.observations.filter((row) => row.relation === "current");
            const otherRows = result.observations.filter((row) => row.relation !== "current");
            const renderRow = (row: (typeof result.observations)[number], index: number) => {
              const detailText = observationDetailText(row.detail);
              return (
                <p key={`${row.createdAt}-${index}`}>
                  <strong>{formatInstant(row.createdAt)}</strong>
                  {" · "}【{observationRelationText(row.relation, row.attempt)}】
                  {" · "}{observationEventText(row.event)}
                  {" · "}{observationOutcomeText(row.outcome)}
                  {detailText ? ` · ${detailText}` : ""}
                </p>
              );
            };
            return (
              <>
                <p className="refresh-band__note"><strong>当前尝试事件</strong></p>
                {currentRows.length > 0 ? (
                  <div className="refresh-band__ledger-rows">
                    {currentRows.map(renderRow)}
                  </div>
                ) : (
                  <p className="refresh-band__note">当前尝试尚无自身事件记录（下方历史事件不作为当前尝试的证据）</p>
                )}
                {otherRows.length > 0 ? (
                  <>
                    <p className="refresh-band__note"><strong>历史 / 无关事件（不属于当前尝试）</strong></p>
                    <div className="refresh-band__ledger-rows">
                      {otherRows.map(renderRow)}
                    </div>
                  </>
                ) : null}
              </>
            );
          })()}
        </>
      )}
    </details>
  );
}

// F0.5/F0.7: the read-only refresh status band, shown right after
// the access check. It never writes anything: retrying stays on
// the existing 「立即更新」 button, and a retry never clears the
// old cards — the dashboard below keeps rendering the last
// successful payload until a legal ingest save replaces it.
function RefreshStatusBand({
  data,
  refresh,
  message,
  observations,
  checking,
  checkFeedback,
  onCheckProgress,
}: {
  data: Dashboard | null;
  refresh: { status: RefreshStatus; updatedAt: string | null; startedAt: string | null };
  message: string | null;
  observations: UseQueryResult<ApiResponse<typeof api, "getRefreshObservations">>;
  checking: boolean;
  checkFeedback: CheckProgressFeedback | null;
  onCheckProgress: () => void;
}) {
  const hasData = data != null;
  const formatInstant = (value: string | null, dateOnly: boolean): string => {
    if (!value) return "未提供";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "未提供";
    return dateOnly ? dateLabel.format(date) : timestampLabel.format(date);
  };
  const facts = data ? monthAvailabilityFacts(data.months, new Date()) : [];
  const ledger = sourceLedgerRows(data, refresh);
  return (
    <section className="refresh-band" aria-label="刷新状态与数据可用性">
      <div className="refresh-band__row">
        <span className="refresh-band__status">
          <span aria-hidden="true">{refreshStatusSymbol(refresh.status)}</span>
          {refreshStatusText(refresh.status, hasData)}
        </span>
        <span>最后成功快照时间：{hasData ? formatInstant(data.asOf, true) : "尚无成功数据"}</span>
        <span>{refresh.status === "running" ? "本次尝试开始" : "最近一次尝试开始"}：{formatInstant(refresh.startedAt, false)}</span>
        <span>状态写入时刻：{formatInstant(refresh.updatedAt, false)}</span>
        <span>下一可用操作：{nextRefreshActionText(refresh.status, hasData)}</span>
      </div>
      {refresh.status === "running" ? (
        <p className="refresh-band__note">{hasData ? "正在更新，当前显示上次成功数据；合法落盘保存后才会替换。" : "正在更新，尚无成功数据可显示。"}</p>
      ) : null}
      {message ? <p className="refresh-band__note">{message}</p> : null}
      <div className="refresh-band__check">
        <button
          type="button"
          className="refresh-band__check-button"
          onClick={onCheckProgress}
          disabled={checking}
          aria-label="检查进度（只读：只重新读取当前状态，不启动更新）"
        >
          {checking ? "正在检查…" : "检查进度"}
        </button>
        <span>只读检查：只重新读取状态，不启动更新、不生成新代次</span>
      </div>
      {checking ? <p className="refresh-band__note">正在检查…</p> : null}
      {checkFeedback ? (
        <div className="refresh-band__check-feedback">
          <p><strong>{checkFeedback.headline}</strong></p>
          <p>{checkFeedback.dashboardLine}</p>
          <p>{checkFeedback.observationsLine}</p>
          <p>{checkFeedback.refreshResultLine}</p>
          {checkFeedback.waitedText ? <p>{checkFeedback.waitedText}</p> : null}
          <p>{checkFeedback.dataFactLine}</p>
          <p>{checkFeedback.note}</p>
        </div>
      ) : null}
      {facts.length > 0 ? (
        <div className="refresh-band__facts">
          {facts.map((fact) => (
            <p key={fact.label}><strong>{fact.label}：</strong>{fact.text}</p>
          ))}
        </div>
      ) : null}
      <details className="refresh-band__ledger">
        <summary aria-label="来源台账（本地月度记录、银行余额、交易、持仓）">来源台账</summary>
        <div className="refresh-band__ledger-rows">
          {ledger.map((row) => (
            <p key={row.source}>
              <strong>{row.source}</strong>
              {" · "}上次可用事实 — 数据日期：{row.dataDate}
              {" · "}实际范围：{row.range}
              {" · "}本次尝试：{row.result}
            </p>
          ))}
        </div>
      </details>
      <RefreshObservationsPanel observations={observations} />
    </section>
  );
}

export function App() {
  const queryClient = useQueryClient();
  const dashboard = useQuery({
    queryKey: ["finance-dashboard"],
    queryFn: () => api.getDashboard({}),
    refetchInterval: (query) => query.state.data?.refresh.status === "running" ? 3000 : false,
  });
  const refresh = useMutation({
    mutationFn: () => api.refreshFinanceData({}),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["finance-dashboard"] });
      queryClient.invalidateQueries({ queryKey: ["finance-refresh-observations"] });
    },
  });
  // The observations query lives here (not in the panel) so the
  // manual 「检查进度」 check refetches the exact same two read-only
  // queries the page already polls. Owner-only: it stays disabled
  // until the dashboard read has confirmed owner access, and the
  // server independently rejects non-owners with zero data.
  const observations = useQuery({
    queryKey: ["finance-refresh-observations"],
    queryFn: () => api.getRefreshObservations({}),
    enabled: dashboard.data?.access === "owner",
    refetchInterval: (query) => query.state.data?.state?.status === "running" ? 3000 : false,
  });
  // 「检查进度」 session state: the gate blocks a double-click from
  // starting a second pair of reads (only this check's own button
  // is disabled meanwhile — nothing else is locked), and the last
  // check's per-channel outcomes stay visible until the next check.
  const checkGateRef = useRef({ inFlight: false });
  const [checking, setChecking] = useState(false);
  const [checkReads, setCheckReads] = useState<{ dashboard: ProgressReadOutcome; observations: ProgressReadOutcome } | null>(null);
  const handleCheckProgress = () => {
    if (checkGateRef.current.inFlight) return;
    setChecking(true);
    void performProgressCheck({
      gate: checkGateRef.current,
      readDashboard: async () => {
        const result = await dashboard.refetch();
        if (result.isError || !result.data || result.data.access !== "owner") {
          throw new Error("dashboard progress read failed");
        }
        return {
          refreshStatus: result.data.refresh.status,
          hasData: result.data.data != null,
          startedAt: result.data.refresh.startedAt,
          message: result.data.refresh.message,
          asOf: result.data.data?.asOf ?? null,
        };
      },
      readObservations: async () => {
        const result = await observations.refetch();
        if (result.isError || !result.data || result.data.access !== "owner") {
          throw new Error("observations progress read failed");
        }
        return {
          refreshStatus: result.data.state?.status ?? null,
          hasData: false,
          startedAt: result.data.state?.startedAt ?? null,
          diagnosisCode: result.data.diagnosis?.code ?? null,
          diagnosisAttempt: result.data.diagnosis?.attempt ?? null,
          diagnosisText: result.data.diagnosis?.text ?? null,
        };
      },
      now: () => Date.now(),
    }).then((reads) => {
      if (reads) setCheckReads(reads);
    }).finally(() => {
      setChecking(false);
    });
  };
  const checkFeedback = checkReads
    ? checkProgressFeedback({
        dashboard: checkReads.dashboard,
        observations: checkReads.observations,
        nowMs: Date.now(),
        formatTime: (ms) => timestampLabel.format(new Date(ms)),
      })
    : null;

  const response = dashboard.data;
  const status: RefreshStatus = response?.refresh.status ?? "idle";
  const isRefreshing = status === "running" || refresh.isPending;
  const guestDenied = response?.access === "guest_denied";
  const visibleMessage = safeRefreshMessage(response?.refresh.message ?? null, response?.data != null);

  return (
    <div className="app-shell">
      <SafeAreaTopScrim backgroundColor="var(--bg)" />
      <main>
        {!guestDenied ? (
          <div className="utility-row">
            <div className={`source-status source-status--${status}`}>
              <span className="status-dot" />
              {statusPillText(response?.data != null, status)}
            </div>
            <button type="button" className="refresh-button" onClick={() => refresh.mutate()} disabled={isRefreshing} aria-label="立即更新财务数据">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 7v5h-5M4 17v-5h5M18.5 9A7 7 0 0 0 6.4 6.4L4 9m16 6-2.4 2.6A7 7 0 0 1 5.5 15" /></svg>
              {isRefreshing ? "更新中" : "立即更新"}
            </button>
          </div>
        ) : null}

        {!guestDenied && response ? (
          <RefreshStatusBand
            data={response.data}
            refresh={response.refresh}
            message={visibleMessage}
            observations={observations}
            checking={checking}
            checkFeedback={checkFeedback}
            onCheckProgress={handleCheckProgress}
          />
        ) : null}

        {dashboard.isPending ? (
          <div className="state-screen"><div className="loader" /><p>正在读取财务快照…</p></div>
        ) : dashboard.isError ? (
          <div className="state-screen"><h1>暂时无法读取数据</h1><p>请稍后再试，已输入的内容不会丢失。</p><button type="button" onClick={() => dashboard.refetch()}>重试</button></div>
        ) : guestDenied ? (
          <div className="state-screen private-state"><div className="private-state__mark" aria-hidden="true">$</div><h1>财务数据仅所有者可查看</h1><p>此看板包含私人账户与持仓信息，已停止向共享访客展示。</p></div>
        ) : response?.data ? (
          <DashboardView data={response.data} refreshFailed={status === "error"} />
        ) : status === "error" ? (
          <div className="empty-state">
            <div className="empty-state__rule" />
            <p>数据暂不可用：已保存的数据当前无法读取，这里没有可展示的旧值。请重新更新，从数据源重新读取后即可恢复显示。</p>
            <button type="button" onClick={() => refresh.mutate()} disabled={isRefreshing}>{isRefreshing ? "正在更新…" : "重新更新"}</button>
            {visibleMessage ? <small>{visibleMessage}</small> : null}
          </div>
        ) : (
          <div className="empty-state">
            <div className="empty-state__rule" />
            <p>首次同步会读取 Firance 月度快照，并把可匹配的账户余额更新到本周。</p>
            <button type="button" onClick={() => refresh.mutate()} disabled={isRefreshing}>{isRefreshing ? "正在同步…" : "开始首次同步"}</button>
            {response?.refresh.message ? <small>{response.refresh.message}</small> : null}
          </div>
        )}

        {!guestDenied ? (
          <footer>
            <p>{response?.data ? `更新时间 ${timestampLabel.format(new Date(response.data.asOf))}` : emptyFooterText(status)}</p>
            {status === "error" ? <p className="footer-error">{visibleMessage ?? (response?.data ? "本次更新失败，显示上次数据。" : "数据暂不可用，请重新更新。")}</p> : null}
            <p>月度来自 Firance 快照；投资与银行余额每周经 Plaid 刷新，非 Plaid 账户沿用快照值；银行同步可能延迟；内容仅供参考，不构成投资建议。</p>
          </footer>
        ) : null}
      </main>
    </div>
  );
}
