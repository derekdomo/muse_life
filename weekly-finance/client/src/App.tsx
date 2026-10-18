import { useMemo, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
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

// F1.1 / F0.4: average monthly spend over the most recent 3 valid
// complete months (integrity complete and not anomalous). Missing
// months are reported as a count, never filled with 0.
export function completeSpendBasis(months: Month[]): { averageMonthlySpend: number | null; usedMonths: number; missingMonths: number } {
  const valid = months.filter((month) => month.integrity === "complete" && !month.flexibleSpendAnomaly);
  const used = valid.slice(-3);
  const averageMonthlySpend = used.length > 0
    ? used.reduce((sum, month) => sum + Math.max(0, month.fixedSpend + Math.max(0, month.flexibleSpend)), 0) / used.length
    : null;
  return { averageMonthlySpend, usedMonths: used.length, missingMonths: Math.max(0, 3 - used.length) };
}

export function integrityLabel(integrity: Month["integrity"]): string {
  if (integrity === "complete") return "完整";
  if (integrity === "partial") return "部分";
  return "完整性未提供";
}

function ChartTooltip({ active, payload, label }: { active?: boolean; payload?: Array<{ name?: string; value?: number; color?: string }>; label?: string }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="chart-tooltip">
      <div className="chart-tooltip__label">{label}</div>
      {payload.map((item) => (
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
    { label: "贷款", value: live.loans ?? 0, tone: "muted" as const },
  ];
  const spendRows = [
    { label: "固定支出", value: current.fixedSpend, tone: "primary" as const },
    { label: "灵活支出", value: current.flexibleSpend, tone: "muted" as const },
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
      </div>
    </article>
  );
}

function TrendCharts({ months, current, live }: { months: Month[]; current: Month; live: Dashboard["live"] }) {
  const anomalyMonths = months.filter((month) => month.flexibleSpendAnomaly);
  const chartMonths = months.filter((month) => !month.flexibleSpendAnomaly);
  const data = chartMonths.map((month) => ({
    ...month,
    label: monthLabel.format(monthDate(month.key)),
    monthlySurplus: month.income - month.totalSpend,
  }));
  const surplusValues = data.flatMap((month) => [month.income, month.totalSpend, month.monthlySurplus]);
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

      <DistributionPanel current={current} live={live} />

      {anomalyMonths.length > 0 ? (
        <div className="data-anomaly" role="note" aria-label="数据异常月份">
          <strong>数据异常</strong>
          <span>{anomalyMonths.map((month) => monthLabel.format(monthDate(month.key))).join("、")} 仍保留在月度记录中，但不进入图表与 FIRE 年支出。</span>
        </div>
      ) : null}
    </div>
  );
}

function MonthlyRecords({ months }: { months: Month[] }) {
  const rows = [...months].reverse();
  return (
    <div className="month-records">
      {rows.map((month) => {
        const snapshotDate = month.snapshotDate || month.key;
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
              {month.flexibleSpendAnomaly ? (
                <p>数据异常：{month.anomalyReason ?? "灵活支出未能核实"}（保留在月度记录中，不进入图表与 FIRE 计算）</p>
              ) : null}
              <p>收入 {currency.format(month.income)} · 支出 {currency.format(month.totalSpend)} · 投入 {currency.format(month.contribution)}</p>
            </div>
          </details>
        );
      })}
    </div>
  );
}

function FireProgress({ data }: { data: Dashboard }) {
  const rawProgress = Math.max(0, data.fire.progress ?? 0);
  const ringProgress = Math.min(rawProgress, 1);
  const circumference = 2 * Math.PI * 46;
  const offset = circumference * (1 - ringProgress);
  const years = data.fire.gap <= 0
    ? 0
    : data.fire.annualContribution > 0
      ? Math.ceil(data.fire.gap / data.fire.annualContribution)
      : null;
  const history = data.months
    .map((month, index) => {
      const prior = data.months.slice(Math.max(0, index - 12), index)
        .filter((item) => item.integrity === "complete" && !item.flexibleSpendAnomaly);
      const monthlySpend = prior.length > 0 ? prior.reduce((sum, item) => sum + item.totalSpend, 0) / prior.length : 0;
      const target = monthlySpend > 0 ? monthlySpend * 12 * 25 : 0;
      return {
        label: monthLabel.format(monthDate(month.key)),
        progress: target > 0 && !month.flexibleSpendAnomaly ? (month.total / target) * 100 : null,
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
  return "历史转入";
}

function BalanceDeltaCard({ data, refreshFailed }: { data: Dashboard; refreshFailed: boolean }) {
  const delta = data.live.weeklyDelta;
  const view = weeklyDeltaView(delta, data.live.netWorth);
  const asOfDate = new Date(data.asOf);
  const asOfText = Number.isNaN(asOfDate.getTime()) ? "未提供" : dateLabel.format(asOfDate);
  return (
    <section className="fact-card" aria-label="本次余额差（较上次成功快照）">
      <div className="fact-card__heading">
        <h2>本次余额差</h2>
        <span>较上次成功快照（日期未留存）</span>
      </div>
      {view.comparable ? (
        <div className={`fact-card__value ${valueTone(delta)}`}>
          <strong>{trendIndicator(delta)} {signedCurrency(delta)}</strong>
          {view.percent != null ? <span>{`${view.percent > 0 ? "+" : ""}${percent.format(view.percent)}`}</span> : null}
          <span>{view.direction}</span>
        </div>
      ) : (
        <div className="fact-card__value neutral">
          <strong className="fact-card__none">暂无可比快照</strong>
        </div>
      )}
      <p className="fact-card__note">
        {view.comparable
          ? "与上次成功快照的净资产之差；两次快照的间隔不固定，不代表固定时间间隔。"
          : "首次同步、或上次快照不可用时没有可比对象；当前净资产见下方，下一次成功同步后生成对比。"}
      </p>
      {refreshFailed ? <p className="fact-card__stale">本次未更新：本次更新未成功，以上仍为上次成功同步的数据，数据日期未推进。</p> : null}
      <p className="fact-card__source">数据日期 {asOfText} · 月度快照 {data.sourceMonth} · 余额来源：{balanceSourceSummary(data.accounts)}</p>
    </section>
  );
}

function DashboardView({ data, refreshFailed }: { data: Dashboard; refreshFailed: boolean }) {
  const [range, setRange] = useState<Range>("12m");
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
  const previous = data.months.at(-2);
  if (!current) return null;

  const monthDelta = previous ? current.total - previous.total : null;
  const deltaView = weeklyDeltaView(data.live.weeklyDelta, data.live.netWorth);
  const savingsRate = current.income > 0 ? (current.income - current.totalSpend) / current.income : null;
  // F1.1: emergency coverage divides deposits by the average spend of
  // the last 3 valid complete months only. With fewer than 3, no
  // coverage figure is produced — the gap is stated, never 0-filled.
  const spendBasis = completeSpendBasis(data.months);
  const emergencyMonths = spendBasis.missingMonths === 0
    && spendBasis.averageMonthlySpend != null
    && spendBasis.averageMonthlySpend > 0
    ? (data.live.deposits ?? 0) / spendBasis.averageMonthlySpend
    : null;
  const emergencyNote = spendBasis.missingMonths > 0
    ? `完整有效月不足：已有 ${spendBasis.usedMonths} 个，缺 ${spendBasis.missingMonths} 个`
    : spendBasis.averageMonthlySpend === 0
      ? "近 3 个完整有效月平均支出为 0，覆盖无法计算"
      : "存款 ÷ 近 3 个完整有效月平均支出";

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
      <BalanceDeltaCard data={data} refreshFailed={refreshFailed} />

      <section className="hero" aria-labelledby="hero-title">
        <div className="hero__main">
          <p id="hero-title" className="eyebrow">同步读取净资产</p>
          <div className="hero__value">{currency.format(data.live.netWorth)}</div>
          <div className={`delta ${valueTone(data.live.weeklyDelta)}`}>
            {data.live.weeklyDelta == null ? (
              <span>暂无可比快照</span>
            ) : (
              <><span>{trendIndicator(data.live.weeklyDelta)} {signedCurrency(data.live.weeklyDelta)}</span><span>{deltaView.percent == null ? "" : `（${deltaView.percent > 0 ? "+" : ""}${percent.format(deltaView.percent)}）`}</span>{deltaView.direction ? <span>{deltaView.direction}</span> : null}<span className="delta__label">较上次成功快照</span></>
            )}
          </div>
        </div>
        <div className="snapshot-compare">
          <span>月度快照 · {data.sourceMonth}</span>
          <strong>{currency.format(current.total)}</strong>
          <small className={valueTone(monthDelta)}>{monthDelta == null ? "暂无可比快照" : `${trendIndicator(monthDelta)} ${signedCurrency(monthDelta)} 环比`}</small>
        </div>
      </section>

      <section className="metric-grid" aria-label="本月关键指标">
        <Metric label="月收入" value={<span title={currency.format(current.income)}>{compactCurrency.format(current.income)}</span>} />
        <Metric label="月支出" value={<span title={currency.format(current.totalSpend)}>{compactCurrency.format(current.totalSpend)}</span>} note={`固定 ${compactCurrency.format(current.fixedSpend)}`} />
        <Metric label="储蓄率" value={savingsRate == null ? "—" : <>{trendIndicator(savingsRate)} {percent.format(savingsRate)}</>} tone={valueTone(savingsRate)} note="（收入 − 支出）÷ 收入" />
        <Metric label="应急金覆盖" value={emergencyMonths == null ? "—" : `${number.format(emergencyMonths)} 个月`} note={emergencyNote} />
        <Metric label="投资" value={<span title={currency.format(data.live.investment)}>{compactCurrency.format(data.live.investment)}</span>} note="已融合实时余额" />
        <Metric label="存款" value={<span title={currency.format(data.live.deposits ?? 0)}>{compactCurrency.format(data.live.deposits ?? 0)}</span>} note="现金与银行账户" />
        <Metric label="贷款" value={<span title={currency.format(data.live.loans ?? 0)}>{compactCurrency.format(data.live.loans ?? 0)}</span>} note="按未偿余额显示" />
      </section>

      <section className="section-block">
        <div className="section-heading-row">
          <SectionTitle title="走势" meta={`${months.filter((month) => !month.flexibleSpendAnomaly).length} 个有效快照`} />
          <div className="range-control" aria-label="趋势时间范围">
            {(["6m", "12m", "year", "all"] as Range[]).map((item) => (
              <button key={item} type="button" className={range === item ? "active" : ""} onClick={() => setRange(item)} aria-pressed={range === item}>
                {item === "6m" ? "6月" : item === "12m" ? "12月" : item === "year" ? "今年" : "全部"}
              </button>
            ))}
          </div>
        </div>
        <TrendCharts months={months} current={current} live={data.live} />
      </section>

      <section className="section-block">
        <SectionTitle title="月度记录" meta="每月一份快照 · 点按展开" />
        <MonthlyRecords months={data.months} />
      </section>

      <section className="fire-section section-block">
        <SectionTitle title="FIRE 进度" meta={data.fire.completeMonthsUsed > 0 ? `4% 规则 · 近 ${data.fire.completeMonthsUsed} 个完整有效月` : "4% 规则 · 完整月份不足"} />
        <FireProgress data={data} />
      </section>

      <section className="holdings-section section-block">
        <SectionTitle title="持仓 Top 10" meta={`前三集中度 ${percent.format(data.concentrationTop3)}`} />
        {data.holdings.length ? (
          <div className="holding-list">
            {data.holdings.map((holding, index) => (
              <div className="holding-row" key={`${holding.ticker}-${index}`}>
                <div className="holding-rank">{String(index + 1).padStart(2, "0")}</div>
                <div className="holding-name"><strong>{holding.ticker}</strong>{holding.name ? <span>{holding.name}</span> : null}</div>
                <div className="holding-bar" aria-hidden="true"><span style={{ width: `${Math.min(holding.share * 100, 100)}%` }} /></div>
                <div className="holding-value"><strong>{currency.format(holding.value)}</strong><span>{percent.format(holding.share)}</span></div>
              </div>
            ))}
          </div>
        ) : <p className="empty-inline">本次同步没有返回可展示的持仓。</p>}
        {data.cashPosition != null ? (
          <div className="cash-position">
            <div className="institution-icon" aria-hidden="true">$</div>
            <div><strong>现金头寸</strong><span>CUR:USD · 与存款分开解读</span></div>
            <b>{currency.format(data.cashPosition)}</b>
          </div>
        ) : null}
      </section>

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
                        <span>{accountTypeLabel(account.type)}{isLoan ? " · 负债" : ""} · {account.live ? "同步读取" : "月度快照"}{account.mask ? ` ···${account.mask}` : ""}</span>
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

export function App() {
  const queryClient = useQueryClient();
  const dashboard = useQuery({
    queryKey: ["finance-dashboard"],
    queryFn: () => api.getDashboard({}),
    refetchInterval: (query) => query.state.data?.refresh.status === "running" ? 3000 : false,
  });
  const refresh = useMutation({
    mutationFn: () => api.refreshFinanceData({}),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["finance-dashboard"] }),
  });

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
