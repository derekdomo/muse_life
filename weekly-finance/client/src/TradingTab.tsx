// TRADING-MERGE-001: the 「交易」 tab — the merged 交易日志 panel,
// rendered from the trading dataset that getDashboard returns as
// its optional `trading` field (stored via saveTradingData /
// appendTradingJournal, fully separate from the finance payload).
// Section order follows the merge brief: 总览卡 → 统计条 →
// 重要日子 → Calendar → 累计已实现曲线 + 每日已实现柱状 →
// 总市值曲线 → 标的排名 → 已平仓 → 持仓 + 未平仓期权 → 流水 →
// 口径说明. Colour never carries meaning alone: every gain/loss
// also carries a +/− sign and a ▲▼ glyph (the user is
// colour-weak); colours come from this page's Okabe-Ito tokens.

import { useMemo, useState, type ReactNode } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  ReferenceArea,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

/* ---------------------------------- types ---------------------------------- */

interface StatBlock {
  trades: number;
  wins: number;
  losses: number;
  win_rate: number; // fraction 0..1 or percent; fmtWinRate normalizes
  realized: number;
  avg_win: number;
  avg_loss: number;
  profit_factor: number | null;
  best: number;
  worst: number;
}

interface Position {
  account: string;
  ticker: string;
  name: string;
  qty: number;
  price: number;
  value: number;
  cost: number | null;
  is_option: boolean;
}

interface OpenOption {
  account: string;
  ticker: string;
  exp: string; // YYYY-MM-DD
  strike: number;
  type: "put" | "call";
  contracts: number; // negative = short (sold)
  avg_premium: number;
  opened: string;
}

interface ClosedTrade {
  kind: "option" | "stock";
  account: string;
  ticker: string;
  label: string;
  contracts: number | null;
  shares?: number;
  opened: string | null; // null = cost unknown / no open record (e.g. RSU sells)
  closed: string; // YYYY-MM-DD
  pnl: number | null; // null = cost basis unknown
  how: string;
  basis_known: boolean;
}

interface JournalRow {
  date: string; // YYYY-MM-DD
  account: string;
  ticker: string;
  type: string;
  subtype: string;
  qty: number;
  price: number;
  amount: number;
  name: string;
  is_option: boolean;
  is_dca: boolean;
}

interface DailyRow {
  date: string; // YYYY-MM-DD
  value: number;
  pnl: number | null; // null on the first day
  flow: number;
}

interface RealizedDailyRow {
  date: string; // YYYY-MM-DD, every calendar day
  inflow: number;
  realized: number;
  realized_options: number;
  cum_realized: number;
}

type EventType = "earnings" | "macro" | "option_expiry";

interface CalEvent {
  date: string; // YYYY-MM-DD
  label: string;
  type: EventType;
}

interface TradingDataset {
  generated_at: string; // ISO timestamp
  accounts: Record<string, string>;
  current_total: number;
  positions: Position[];
  open_options: OpenOption[];
  closed_trades: ClosedTrade[];
  journal: JournalRow[];
  daily: DailyRow[];
  realized_daily: RealizedDailyRow[];
  events: CalEvent[];
  stats: {
    all: StatBlock | null;
    options: StatBlock | null;
    stocks: StatBlock | null;
  };
  by_ticker: Record<string, { pnl: number; trades: number; wins: number }>;
  dividends_total: number;
  max_drawdown_pct: number;
  data_start: string; // YYYY-MM-DD
}

// The stored document is pipeline-shaped JSON; normalize the
// top level defensively so a partial or older push renders its
// honest gaps instead of crashing the whole dashboard.
function normalizeTradingDataset(raw: Record<string, unknown>): TradingDataset {
  const num = (v: unknown): number =>
    typeof v === "number" && Number.isFinite(v) ? v : 0;
  const str = (v: unknown): string => (typeof v === "string" ? v : "");
  const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
  const stat = (v: unknown): StatBlock | null =>
    v && typeof v === "object" ? (v as StatBlock) : null;
  const statsRaw =
    raw["stats"] && typeof raw["stats"] === "object"
      ? (raw["stats"] as Record<string, unknown>)
      : {};
  const accountsRaw = raw["accounts"];
  const byTickerRaw = raw["by_ticker"];
  return {
    generated_at: str(raw["generated_at"]),
    accounts:
      accountsRaw && typeof accountsRaw === "object" && !Array.isArray(accountsRaw)
        ? (accountsRaw as Record<string, string>)
        : {},
    current_total: num(raw["current_total"]),
    positions: arr(raw["positions"]) as Position[],
    open_options: arr(raw["open_options"]) as OpenOption[],
    closed_trades: arr(raw["closed_trades"]) as ClosedTrade[],
    journal: arr(raw["journal"]) as JournalRow[],
    daily: arr(raw["daily"]) as DailyRow[],
    realized_daily: arr(raw["realized_daily"]) as RealizedDailyRow[],
    events: arr(raw["events"]) as CalEvent[],
    stats: {
      all: stat(statsRaw["all"]),
      options: stat(statsRaw["options"]),
      stocks: stat(statsRaw["stocks"]),
    },
    by_ticker:
      byTickerRaw && typeof byTickerRaw === "object" && !Array.isArray(byTickerRaw)
        ? (byTickerRaw as TradingDataset["by_ticker"])
        : {},
    dividends_total: num(raw["dividends_total"]),
    max_drawdown_pct: num(raw["max_drawdown_pct"]),
    data_start: str(raw["data_start"]),
  };
}

/* --------------------------------- formatting ------------------------------- */
// Gains/losses are ALWAYS rendered with a sign and an arrow
// symbol alongside colour — colour alone never carries meaning.

const usd = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const usd0 = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});

function fmtMoney(n: number): string {
  return usd.format(n);
}

function fmtMoney0(n: number): string {
  return usd0.format(n);
}

/** "+$1,234.56" / "-$56.00" / "$0.00" — sign always explicit for nonzero. */
function fmtSigned(n: number): string {
  if (n > 0) return `+${usd.format(n)}`;
  if (n < 0) return `-${usd.format(Math.abs(n))}`;
  return usd.format(0);
}

/** Compact signed for calendar cells: "+$1.2k" / "-$340". */
function fmtSignedCompact(n: number): string {
  const abs = Math.abs(n);
  const sign = n > 0 ? "+" : n < 0 ? "-" : "";
  if (abs >= 1000) return `${sign}$${(abs / 1000).toFixed(abs >= 10000 ? 0 : 1)}k`;
  return `${sign}$${Math.round(abs)}`;
}

/**
 * Compact realized for calendar cells: "▲$1.2k" / "▼$646".
 * The ▲/▼ arrow carries the direction, so the redundant +/− sign is
 * dropped — at phone widths a 7-glyph "▲ +$1.2k" overflows the cell
 * and gets clipped. Full signed precision stays in the aria-label,
 * the tap-through day detail and the month totals.
 */
function fmtArrowCompact(n: number): string {
  const abs = Math.abs(n);
  const body =
    abs >= 1000 ? `$${(abs / 1000).toFixed(abs >= 10000 ? 0 : 1)}k` : `$${Math.round(abs)}`;
  return `${arrow(n)}${body}`;
}

/** ▲ for gains, ▼ for losses, — for flat. */
function arrow(n: number): string {
  if (n > 0) return "▲";
  if (n < 0) return "▼";
  return "—";
}

function pnlClass(n: number): string {
  if (n > 0) return "text-[var(--up)]";
  if (n < 0) return "text-[var(--down)]";
  return "text-[var(--dim)]";
}

/** win_rate may arrive as a fraction (0.82) or a percent (82). */
function fmtWinRate(w: number): string {
  const pct = w <= 1 ? w * 100 : w;
  return `${pct.toFixed(1)}%`;
}

function fmtPct(x: number): string {
  return `${x.toFixed(1)}%`;
}

/** "2026-10-24" -> local Date (no timezone shifting). Null/invalid -> Invalid Date. */
function parseDate(s: string | null | undefined): Date {
  if (!s || typeof s !== "string") return new Date(NaN);
  const [y = 1970, m = 1, d = 1] = s.split("-").map(Number);
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d))
    return new Date(NaN);
  return new Date(y, m - 1, d);
}

function fmtDate(s: string | null | undefined): string {
  const d = parseDate(s);
  if (Number.isNaN(d.getTime())) return "—";
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

function fmtDateFull(s: string | null | undefined): string {
  const d = parseDate(s);
  if (Number.isNaN(d.getTime())) return "—";
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
}

function fmtQty(n: number): string {
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 4,
  }).format(n);
}

/** Whole days from `from` date string to `to` date string. */
function daysBetween(
  from: string | null | undefined,
  to: string | null | undefined,
): number {
  const a = parseDate(from).getTime();
  const b = parseDate(to).getTime();
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.round((b - a) / 86400000);
}

/* ---------------------------------- shared --------------------------------- */

const EVENT_LABELS: Record<EventType, string> = {
  earnings: "财报",
  macro: "宏观",
  option_expiry: "期权到期",
};

const HOW_LABELS: Record<string, string> = {
  expired: "到期作废",
  buy_to_close: "买回平仓",
  sell_to_close: "卖出平仓",
  assigned: "被指派",
  exercised: "行权",
  sell: "卖出",
  short_sell: "做空卖出",
};

function Section({
  title,
  right,
  children,
}: {
  title: string;
  right?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="mt-6">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2 px-1">
        <h2 className="text-base font-semibold text-[var(--text)]">{title}</h2>
        {right}
      </div>
      <div className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-3 sm:p-4">
        {children}
      </div>
    </section>
  );
}

function SegControl<T extends string>({
  value,
  onChange,
  options,
  ariaLabel,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string }[];
  ariaLabel: string;
}) {
  return (
    <div
      role="group"
      aria-label={ariaLabel}
      className="inline-flex rounded-full border border-[var(--border)] bg-[var(--surface-alt)] p-0.5"
    >
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          aria-pressed={value === o.value}
          className={
            value === o.value
              ? "rounded-full bg-[var(--accent)] px-3 py-1 text-xs font-semibold text-white"
              : "rounded-full px-3 py-1 text-xs text-[var(--dim)]"
          }
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function SignedValue({
  n,
  className = "",
  compact = false,
}: {
  n: number;
  className?: string;
  compact?: boolean;
}) {
  return (
    <span className={`font-num ${pnlClass(n)} ${className}`}>
      {arrow(n)} {compact ? fmtSignedCompact(n) : fmtSigned(n)}
    </span>
  );
}

function accountName(data: TradingDataset, key: string): string {
  return data.accounts[key] ?? key;
}

/* --------------------------- overview card + stats -------------------------- */

type Scope = "all" | "options" | "stocks";

function StatCell({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="rounded-lg bg-[var(--surface-alt)] px-3 py-2.5">
      <p className="text-[11px] text-[var(--dim)]">{label}</p>
      <p className="font-num mt-1 text-base font-semibold text-[var(--text)]">
        {children}
      </p>
    </div>
  );
}

function TradingOverview({ data }: { data: TradingDataset }) {
  const [scope, setScope] = useState<Scope>("all");
  const s = data.stats[scope];
  const generated = new Date(data.generated_at);
  const generatedText = Number.isNaN(generated.getTime())
    ? data.generated_at
    : generated.toLocaleString("zh-CN", {
        year: "numeric",
        month: "numeric",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });

  return (
    <>
      <section aria-label="交易总览">
        <div className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="text-xs text-[var(--dim)]">自营账户总市值</p>
              <p className="font-num mt-1 text-4xl font-bold text-[var(--text)]">
                {fmtMoney(data.current_total)}
              </p>
              <p className="mt-1.5 text-xs text-[var(--dim)]">
                数据截至 {generatedText} · 起始 {fmtDateFull(data.data_start)}
              </p>
            </div>
            <SegControl<Scope>
              value={scope}
              onChange={setScope}
              ariaLabel="已实现盈亏统计口径"
              options={[
                { value: "all", label: "全部" },
                { value: "options", label: "期权" },
                { value: "stocks", label: "股票" },
              ]}
            />
          </div>

          {s ? (
            <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
              <StatCell label="已实现盈亏">
                <SignedValue n={s.realized} />
              </StatCell>
              <StatCell label="胜率">
                <span className="text-[var(--text)]">{fmtWinRate(s.win_rate)}</span>
                <span className="ml-1.5 text-xs font-normal text-[var(--dim)]">
                  {s.wins} 胜 / {s.losses} 负
                </span>
              </StatCell>
              <StatCell label="最大回撤">
                <span className="text-[var(--down)]">
                  ▼ -{fmtPct(data.max_drawdown_pct)}
                </span>
              </StatCell>
              <StatCell label="累计股息">
                <SignedValue n={data.dividends_total} />
              </StatCell>
            </div>
          ) : (
            <p className="mt-4 text-sm text-[var(--dim)]">该口径暂无已平仓交易统计。</p>
          )}
        </div>
      </section>

      {s ? (
        <section aria-label="交易统计条" className="mt-3">
          <div className="grid grid-cols-2 gap-2 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-3 sm:grid-cols-5 sm:p-4">
            <StatCell label="平均盈利">
              <SignedValue n={s.avg_win} />
            </StatCell>
            <StatCell label="平均亏损">
              <SignedValue n={s.avg_loss} />
            </StatCell>
            <StatCell label="盈亏比">
              <span className="text-[var(--text)]">
                {s.profit_factor != null ? s.profit_factor.toFixed(2) : "—"}
              </span>
            </StatCell>
            <StatCell label="最佳单笔">
              <SignedValue n={s.best} />
            </StatCell>
            <StatCell label="最差单笔">
              <SignedValue n={s.worst} />
            </StatCell>
          </div>
        </section>
      ) : null}
    </>
  );
}

/* ------------------------------ upcoming events ----------------------------- */

function UpcomingEvents({ data }: { data: TradingDataset }) {
  const today = (data.generated_at ?? "").slice(0, 10);
  const upcoming = data.events
    .filter((e) => e.date >= today)
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(0, 5);
  if (upcoming.length === 0) return null;
  return (
    <section aria-label="即将到来的重要日子" className="mt-4">
      <div className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-3 sm:p-4">
        <p className="text-xs font-semibold text-[var(--event)]">
          ◆ 接下来值得注意的日子
        </p>
        <ul className="mt-2 space-y-1.5">
          {upcoming.map((e, i) => (
            <li key={`${e.date}-${i}`} className="flex items-baseline gap-2 text-sm">
              <span className="font-num shrink-0 text-[var(--dim)]">
                {fmtDate(e.date)}
              </span>
              <span className="shrink-0 rounded bg-[var(--surface-alt)] px-1.5 py-0.5 text-[11px] text-[var(--event)]">
                {EVENT_LABELS[e.type]}
              </span>
              <span className="text-[var(--text)]">{e.label}</span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

/* --------------------------------- calendar -------------------------------- */

function PnlCalendar({ data }: { data: TradingDataset }) {
  const realizedDaily: RealizedDailyRow[] = useMemo(
    () => [...(data.realized_daily ?? [])].sort((a, b) => a.date.localeCompare(b.date)),
    [data.realized_daily],
  );
  const byDate = useMemo(
    () => new Map(realizedDaily.map((d) => [d.date, d])),
    [realizedDaily],
  );
  const eventsByDate = useMemo(() => {
    const m = new Map<string, CalEvent[]>();
    for (const e of data.events) {
      const arr = m.get(e.date) ?? [];
      arr.push(e);
      m.set(e.date, arr);
    }
    return m;
  }, [data.events]);

  const latest = realizedDaily[realizedDaily.length - 1];
  const latestMonthRaw = (latest?.date ?? data.generated_at ?? "").slice(0, 7);
  const latestMonth = /^\d{4}-\d{2}$/.test(latestMonthRaw)
    ? latestMonthRaw
    : new Date().toISOString().slice(0, 7);
  const [month, setMonth] = useState<string | null>(null);
  const ym = month ?? latestMonth;
  const [yy = 1970, mm = 1] = ym.split("-").map(Number);
  const [selected, setSelected] = useState<string | null>(null);

  const daysInMonth = new Date(yy, mm, 0).getDate();
  const startOffset = new Date(yy, mm - 1, 1).getDay();
  const cells: (string | null)[] = [];
  for (let i = 0; i < startOffset; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++)
    cells.push(`${ym}-${String(d).padStart(2, "0")}`);
  while (cells.length % 7 !== 0) cells.push(null);

  const monthRows = realizedDaily.filter((d) => d.date.startsWith(ym));
  const monthInflow = monthRows.reduce((sum, d) => sum + (d.inflow ?? 0), 0);
  const monthRealized = monthRows.reduce((sum, d) => sum + (d.realized ?? 0), 0);
  const maxAbsRealized = monthRows.reduce(
    (m, d) => Math.max(m, Math.abs(d.realized ?? 0)),
    0,
  );

  const shiftMonth = (delta: number) => {
    const nd = new Date(yy, mm - 1 + delta, 1);
    setMonth(
      `${nd.getFullYear()}-${String(nd.getMonth() + 1).padStart(2, "0")}`,
    );
  };

  const selRow = selected ? byDate.get(selected) : undefined;
  const selEvents = selected ? (eventsByDate.get(selected) ?? []) : [];

  if (realizedDaily.length === 0) {
    return (
      <Section title="每日进账与已实现日历">
        <p className="text-sm text-[var(--dim)]">
          暂无逐日进账与已实现数据（realized_daily），等待下一次数据同步后显示。日历将覆盖每一个自然日，显示当日进账与当日已实现盈亏。
        </p>
      </Section>
    );
  }

  return (
    <Section title="每日进账与已实现日历">
      <div className="mb-2 flex items-center justify-between">
        <button
          type="button"
          onClick={() => shiftMonth(-1)}
          aria-label="上一个月"
          className="rounded-md border border-[var(--border)] px-3 py-1.5 text-sm text-[var(--text)]"
        >
          ← 上月
        </button>
        <p className="font-num text-sm font-semibold text-[var(--text)]">
          {yy} 年 {mm} 月
        </p>
        <button
          type="button"
          onClick={() => shiftMonth(1)}
          aria-label="下一个月"
          className="rounded-md border border-[var(--border)] px-3 py-1.5 text-sm text-[var(--text)]"
        >
          下月 →
        </button>
      </div>

      <div className="grid grid-cols-7 gap-[3px] text-center text-[11px] text-[var(--dim)]">
        {["日", "一", "二", "三", "四", "五", "六"].map((w) => (
          <div key={w} className="py-1">
            周{w}
          </div>
        ))}
      </div>
      <div className="grid grid-cols-7 gap-[3px]">
        {cells.map((date, i) => {
          if (date === null)
            return <div key={`pad-${i}`} className="min-h-[88px]" aria-hidden="true" />;
          const row = byDate.get(date);
          const evs = eventsByDate.get(date) ?? [];
          const dayNum = Number(date.slice(8));
          const isSel = selected === date;
          const inflow = row?.inflow ?? 0;
          const realized = row?.realized ?? 0;
          const hasInflow = !!row && inflow > 0;
          const hasRealized = !!row && realized !== 0;
          // Background tint intensity is auxiliary only — meaning is carried by +/− and ▲▼ text.
          const intensity =
            hasRealized && maxAbsRealized > 0
              ? 0.06 + 0.16 * Math.min(1, Math.abs(realized) / maxAbsRealized)
              : 0;
          const tintStyle =
            hasRealized && intensity > 0
              ? {
                  backgroundColor:
                    realized > 0
                      ? `rgba(0, 158, 115, ${intensity.toFixed(3)})`
                      : `rgba(213, 94, 0, ${intensity.toFixed(3)})`,
                }
              : undefined;
          const ariaParts = [fmtDateFull(date)];
          if (row) {
            if (hasInflow) ariaParts.push(`进账 ${fmtSigned(inflow)}`);
            if (hasRealized)
              ariaParts.push(`已实现 ${arrow(realized)} ${fmtSigned(realized)}`);
            if (!hasInflow && !hasRealized) ariaParts.push("进账 0，已实现 0");
          } else {
            ariaParts.push("无逐日数据");
          }
          if (evs.length) ariaParts.push(`有 ${evs.length} 个重要事件`);
          return (
            <button
              key={date}
              type="button"
              onClick={() => setSelected(date)}
              aria-pressed={isSel}
              aria-label={ariaParts.join("，")}
              style={tintStyle}
              className={`relative flex min-h-[88px] flex-col items-stretch rounded-md border px-[3px] py-1 text-left ${
                isSel
                  ? "border-[var(--accent)] bg-[var(--surface-alt)]"
                  : "border-[var(--border)] bg-[var(--surface-alt)]/40"
              }`}
            >
              <span className="flex items-start justify-between">
                <span className="text-[11px] text-[var(--dim)]">{dayNum}</span>
                {evs.length > 0 && (
                  <span className="text-[10px] leading-none text-[var(--event)]">
                    ◆
                  </span>
                )}
              </span>
              <span className="mt-auto flex flex-col gap-0.5">
                {hasInflow && (
                  <span className="flex flex-col">
                    <span className="text-[8px] leading-tight text-[var(--dim)]">进账</span>
                    <span className="font-num text-[9px] leading-tight tracking-tight whitespace-nowrap text-[var(--text)]">
                      {fmtSignedCompact(inflow)}
                    </span>
                  </span>
                )}
                {hasRealized && (
                  <span
                    className={`font-num text-[9px] leading-tight font-semibold tracking-tight whitespace-nowrap ${pnlClass(realized)}`}
                  >
                    {fmtArrowCompact(realized)}
                  </span>
                )}
                {row && !hasInflow && !hasRealized && (
                  <span className="font-num text-[10px] text-[var(--dim)]">—</span>
                )}
              </span>
            </button>
          );
        })}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg bg-[var(--surface-alt)] px-3 py-2 text-sm">
        <span className="text-[var(--dim)]">
          本月进账合计{" "}
          <span className="font-num font-semibold text-[var(--text)]">
            {fmtSigned(monthInflow)}
          </span>
        </span>
        <span className="text-[var(--dim)]">
          本月已实现合计 <SignedValue n={monthRealized} />
        </span>
        <span className="text-xs text-[var(--dim)]">
          （{yy} 年 {mm} 月 · {monthRows.length} 天）
        </span>
      </div>

      <p className="mt-2 text-[11px] text-[var(--dim)]">
        ◆ = 当天有重要日子（财报 / 宏观 / 期权到期），点日期查看。
      </p>
      <p className="mt-1 text-[11px] leading-relaxed text-[var(--dim)]">
        进账 = 当日卖出成交回款（期权权利金收入、平仓回款、股票卖出）+ 股息/利息入账，不含转入存款；已实现 = 当日平仓落定的盈亏，成本未知的卖出不计入；无平仓的日子已实现记 0。
      </p>

      {selected && (
        <div className="mt-3 rounded-lg bg-[var(--surface-alt)] px-3 py-2.5 text-sm">
          <p className="font-semibold text-[var(--text)]">{fmtDateFull(selected)}</p>
          {selRow ? (
            <div className="mt-1 space-y-1 text-[var(--dim)]">
              <p>
                进账{" "}
                <span className="font-num text-[var(--text)]">
                  {selRow.inflow > 0 ? fmtSigned(selRow.inflow) : fmtMoney(0)}
                </span>
                <span className="mx-1.5">·</span>
                已实现{" "}
                {selRow.realized !== 0 ? (
                  <SignedValue n={selRow.realized} />
                ) : (
                  <span className="font-num text-[var(--text)]">$0.00</span>
                )}
              </p>
              <p className="font-num text-xs">
                其中期权已实现 {fmtSigned(selRow.realized_options ?? 0)}
                <span className="mx-1.5">·</span>
                累计已实现 {fmtSigned(selRow.cum_realized ?? 0)}
              </p>
            </div>
          ) : (
            <p className="mt-1 text-[var(--dim)]">当天不在 realized_daily 覆盖范围内。</p>
          )}
          {selEvents.length > 0 && (
            <ul className="mt-2 space-y-1">
              {selEvents.map((e, i) => (
                <li key={`${e.label}-${i}`} className="flex items-baseline gap-2">
                  <span className="shrink-0 rounded bg-[var(--surface)] px-1.5 py-0.5 text-[11px] text-[var(--event)]">
                    ◆ {EVENT_LABELS[e.type]}
                  </span>
                  <span className="text-[var(--text)]">{e.label}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Section>
  );
}

/* ------------------------- realized daily time series ------------------------ */

function RealizedTip(props: {
  active?: boolean;
  payload?: ReadonlyArray<{ payload: RealizedDailyRow }>;
}) {
  if (!props.active || !props.payload?.length) return null;
  const row = props.payload[0]?.payload;
  if (!row) return null;
  return (
    <div className="rounded-md border border-[var(--border)] bg-[var(--surface-alt)] px-3 py-2 text-xs shadow-lg">
      <p className="font-semibold text-[var(--text)]">{fmtDateFull(row.date)}</p>
      <p className="font-num mt-1 text-[var(--dim)]">
        累计已实现 <span className="text-[var(--text)]">{fmtSigned(row.cum_realized)}</span>
      </p>
      <p className="mt-0.5">
        当日已实现{" "}
        {row.realized !== 0 ? <SignedValue n={row.realized} /> : <span className="font-num">$0.00</span>}
      </p>
      <p className="font-num mt-0.5 text-[var(--dim)]">
        当日进账 {row.inflow > 0 ? fmtSigned(row.inflow) : fmtMoney(0)}
      </p>
    </div>
  );
}

function DailyRealizedTip(props: {
  active?: boolean;
  payload?: ReadonlyArray<{ payload: RealizedDailyRow }>;
}) {
  if (!props.active || !props.payload?.length) return null;
  const row = props.payload[0]?.payload;
  if (!row) return null;
  return (
    <div className="rounded-md border border-[var(--border)] bg-[var(--surface-alt)] px-3 py-2 text-xs shadow-lg">
      <p className="font-semibold text-[var(--text)]">{fmtDateFull(row.date)}</p>
      <p className="mt-1">
        当日已实现{" "}
        {row.realized !== 0 ? <SignedValue n={row.realized} /> : <span className="font-num">$0.00</span>}
      </p>
      <p className="font-num mt-0.5 text-[var(--dim)]">
        累计 {fmtSigned(row.cum_realized)} · 进账 {row.inflow > 0 ? fmtSigned(row.inflow) : fmtMoney(0)}
      </p>
    </div>
  );
}

function CumRealizedCurve({ data }: { data: TradingDataset }) {
  const rows = useMemo(
    () => [...(data.realized_daily ?? [])].sort((a, b) => a.date.localeCompare(b.date)),
    [data.realized_daily],
  );
  if (rows.length < 2) {
    return (
      <Section title="累计已实现盈亏曲线">
        <p className="text-sm text-[var(--dim)]">逐日已实现数据不足，暂无法绘制累计曲线。等待 realized_daily 同步后显示。</p>
      </Section>
    );
  }
  const latestCum = rows[rows.length - 1]?.cum_realized ?? 0;
  return (
    <Section
      title="累计已实现盈亏曲线"
      right={
        <span className="text-xs text-[var(--dim)]">
          最新累计 <SignedValue n={latestCum} compact />
        </span>
      }
    >
      <div aria-label="累计已实现盈亏随时间变化的折线图，每天一个点，无平仓日曲线走平">
        <ResponsiveContainer width="100%" height={220}>
          <LineChart data={rows} margin={{ top: 10, right: 6, left: 0, bottom: 0 }}>
            <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" vertical={false} />
            <XAxis
              dataKey="date"
              type="category"
              tickFormatter={(s: string) => s.slice(5)}
              tick={{ fill: "var(--dim)", fontSize: 11 }}
              minTickGap={48}
              axisLine={{ stroke: "var(--border)" }}
              tickLine={false}
            />
            <YAxis
              domain={["auto", "auto"]}
              tickFormatter={(v: number) => `$${Math.round(v / 1000)}k`}
              tick={{ fill: "var(--dim)", fontSize: 11 }}
              width={54}
              axisLine={false}
              tickLine={false}
            />
            <Tooltip content={<RealizedTip />} cursor={{ stroke: "var(--dim)", strokeDasharray: "4 4" }} />
            <ReferenceLine y={0} stroke="var(--border)" />
            <Line
              type="linear"
              dataKey="cum_realized"
              stroke="var(--accent)"
              strokeWidth={2}
              dot={false}
              activeDot={{ r: 3.5 }}
              isAnimationActive={false}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
      <p className="mt-1 text-[11px] leading-relaxed text-[var(--dim)]">
        逐日粒度：每天一个点（共 {rows.length} 天），不做周/月聚合、不平滑。数据来自 realized_daily.cum_realized；无平仓的日子已实现记 0，累计值不变、曲线走平。
      </p>
    </Section>
  );
}

function DailyRealizedChart({ data }: { data: TradingDataset }) {
  const rows = useMemo(
    () => [...(data.realized_daily ?? [])].sort((a, b) => a.date.localeCompare(b.date)),
    [data.realized_daily],
  );
  if (rows.length === 0) {
    return (
      <Section title="每日已实现盈亏">
        <p className="text-sm text-[var(--dim)]">暂无逐日已实现数据。</p>
      </Section>
    );
  }
  return (
    <Section title="每日已实现盈亏">
      <div aria-label="每日已实现盈亏柱状图，每天一根柱，来自 realized_daily 的 realized 逐日值">
        <ResponsiveContainer width="100%" height={180}>
          <BarChart data={rows} margin={{ top: 10, right: 6, left: 0, bottom: 0 }}>
            <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" vertical={false} />
            <XAxis
              dataKey="date"
              type="category"
              tickFormatter={(s: string) => s.slice(5)}
              tick={{ fill: "var(--dim)", fontSize: 11 }}
              minTickGap={48}
              axisLine={{ stroke: "var(--border)" }}
              tickLine={false}
            />
            <YAxis
              tickFormatter={(v: number) => `$${Math.round(v / 1000)}k`}
              tick={{ fill: "var(--dim)", fontSize: 11 }}
              width={54}
              axisLine={false}
              tickLine={false}
            />
            <Tooltip content={<DailyRealizedTip />} cursor={{ fill: "var(--surface-alt)", opacity: 0.5 }} />
            <ReferenceLine y={0} stroke="var(--border)" />
            <Bar dataKey="realized" isAnimationActive={false}>
              {rows.map((r) => (
                <Cell
                  key={r.date}
                  fill={r.realized > 0 ? "var(--up)" : r.realized < 0 ? "var(--down)" : "var(--border)"}
                />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
      <p className="mt-1 text-[11px] leading-relaxed text-[var(--dim)]">
        逐日值来自 realized_daily.realized，每天一根柱，不做聚合；无平仓的日子为 0。正负以 +/− 号与 ▲▼ 符号（见日历与提示框）为准，颜色仅作辅助。
      </p>
    </Section>
  );
}

/* ------------------------------- equity curve ------------------------------- */

function maxDrawdownInterval(daily: DailyRow[]): {
  pct: number;
  from: string;
  to: string;
} | null {
  let peak = -Infinity;
  let peakDate = "";
  let best: { pct: number; from: string; to: string } | null = null;
  for (const d of daily) {
    if (d.value > peak) {
      peak = d.value;
      peakDate = d.date;
    } else if (peak > 0) {
      const dd = (peak - d.value) / peak;
      if (!best || dd > best.pct) best = { pct: dd, from: peakDate, to: d.date };
    }
  }
  return best && best.pct > 0 && best.from !== best.to ? best : null;
}

function CurveTip(props: {
  active?: boolean;
  payload?: ReadonlyArray<{ payload: DailyRow }>;
}) {
  if (!props.active || !props.payload?.length) return null;
  const row = props.payload[0]?.payload;
  if (!row) return null;
  return (
    <div className="rounded-md border border-[var(--border)] bg-[var(--surface-alt)] px-3 py-2 text-xs shadow-lg">
      <p className="font-semibold text-[var(--text)]">{fmtDateFull(row.date)}</p>
      <p className="font-num mt-1 text-[var(--dim)]">
        市值 <span className="text-[var(--text)]">{fmtMoney(row.value)}</span>
      </p>
      {row.pnl != null && (
        <p className="mt-0.5">
          当日 <SignedValue n={row.pnl} />
        </p>
      )}
    </div>
  );
}

function EquityCurve({ data }: { data: TradingDataset }) {
  const dd = useMemo(() => maxDrawdownInterval(data.daily), [data.daily]);
  if (data.daily.length < 2) {
    return (
      <Section title="总市值曲线">
        <p className="text-sm text-[var(--dim)]">市值快照不足，暂无法绘制曲线。</p>
      </Section>
    );
  }
  const chartData = data.daily.map((d) => ({
    date: d.date,
    value: d.value,
    pnl: d.pnl,
    flow: d.flow,
  }));
  return (
    <Section
      title="总市值曲线"
      right={
        dd ? (
          <span className="text-xs text-[var(--down)]">
            ▼ 最大回撤区间 {fmtDate(dd.from)} → {fmtDate(dd.to)}（-
            {(dd.pct * 100).toFixed(1)}%）
          </span>
        ) : undefined
      }
    >
      <div aria-label="账户总市值随时间变化的折线图，虚线框标出最大回撤区间">
        <ResponsiveContainer width="100%" height={220}>
          <LineChart data={chartData} margin={{ top: 10, right: 6, left: 0, bottom: 0 }}>
            <CartesianGrid
              stroke="var(--border)"
              strokeDasharray="3 3"
              vertical={false}
            />
            <XAxis
              dataKey="date"
              type="category"
              tickFormatter={(s: string) => s.slice(5)}
              tick={{ fill: "var(--dim)", fontSize: 11 }}
              minTickGap={48}
              axisLine={{ stroke: "var(--border)" }}
              tickLine={false}
            />
            <YAxis
              domain={["auto", "auto"]}
              tickFormatter={(v: number) => `$${Math.round(v / 1000)}k`}
              tick={{ fill: "var(--dim)", fontSize: 11 }}
              width={54}
              axisLine={false}
              tickLine={false}
            />
            <Tooltip
              content={<CurveTip />}
              cursor={{ stroke: "var(--dim)", strokeDasharray: "4 4" }}
            />
            {dd && (
              <ReferenceArea
                x1={dd.from}
                x2={dd.to}
                fill="var(--down)"
                fillOpacity={0.12}
                stroke="var(--down)"
                strokeOpacity={0.55}
                strokeDasharray="4 3"
                label={{
                  value: `最大回撤 -${(dd.pct * 100).toFixed(1)}%`,
                  fill: "var(--down)",
                  fontSize: 11,
                  position: "insideTopRight",
                }}
              />
            )}
            <Line
              type="monotone"
              dataKey="value"
              stroke="var(--accent)"
              strokeWidth={2}
              dot={false}
              activeDot={{ r: 3.5 }}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
      <p className="mt-1 text-[11px] text-[var(--dim)]">
        市值快照口径（daily）；虚线框为期间最大回撤区间（高点 → 低点）。
      </p>
    </Section>
  );
}

/* ------------------------------- ticker rank ------------------------------- */

function TickerRank({ data }: { data: TradingDataset }) {
  const [range, setRange] = useState<"all" | "month">("all");
  const monthPrefix = (data.generated_at ?? "").slice(0, 7);

  const rows = useMemo(() => {
    if (range === "all") {
      return Object.entries(data.by_ticker).map(([ticker, v]) => ({
        ticker,
        pnl: v.pnl,
        trades: v.trades,
        wins: v.wins,
      }));
    }
    const agg = new Map<string, { pnl: number; trades: number; wins: number }>();
    for (const t of data.closed_trades) {
      if (!t.closed.startsWith(monthPrefix) || t.pnl == null) continue;
      const cur = agg.get(t.ticker) ?? { pnl: 0, trades: 0, wins: 0 };
      cur.pnl += t.pnl;
      cur.trades += 1;
      if (t.pnl > 0) cur.wins += 1;
      agg.set(t.ticker, cur);
    }
    return [...agg.entries()].map(([ticker, v]) => ({ ticker, ...v }));
  }, [range, data, monthPrefix]);

  const sorted = [...rows].sort((a, b) => b.pnl - a.pnl);

  return (
    <Section
      title="标的已实现排名"
      right={
        <SegControl<"all" | "month">
          value={range}
          onChange={setRange}
          ariaLabel="排名时间范围"
          options={[
            { value: "all", label: "全部" },
            { value: "month", label: "本月" },
          ]}
        />
      }
    >
      {sorted.length === 0 ? (
        <p className="text-sm text-[var(--dim)]">
          {range === "month" ? "本月暂无已平仓交易。" : "暂无已平仓交易。"}
        </p>
      ) : (
        <ol className="divide-y divide-[var(--border)]">
          {sorted.map((r, i) => (
            <li key={r.ticker} className="flex items-center gap-3 py-2">
              <span className="font-num w-6 shrink-0 text-sm text-[var(--dim)]">
                {i + 1}
              </span>
              <span className="min-w-0 flex-1">
                <span className="font-num font-semibold text-[var(--text)]">
                  {r.ticker}
                </span>
                <span className="block text-[11px] text-[var(--dim)]">
                  {r.trades} 笔 · 胜率{" "}
                  {r.trades > 0 ? fmtWinRate(r.wins / r.trades) : "—"}
                </span>
              </span>
              <SignedValue n={r.pnl} />
            </li>
          ))}
        </ol>
      )}
    </Section>
  );
}

/* ------------------------------- closed trades ------------------------------ */

const CLOSED_PREVIEW = 50;

function ClosedTrades({ data }: { data: TradingDataset }) {
  const [expanded, setExpanded] = useState(false);
  const sorted = useMemo(
    () => [...data.closed_trades].sort((a, b) => (b.closed ?? "").localeCompare(a.closed ?? "")),
    [data.closed_trades],
  );
  const shown = expanded ? sorted : sorted.slice(0, CLOSED_PREVIEW);

  return (
    <Section
      title="已平仓交易"
      right={
        <span className="text-xs text-[var(--dim)]">共 {sorted.length} 笔</span>
      }
    >
      {sorted.length === 0 ? (
        <p className="text-sm text-[var(--dim)]">暂无已平仓交易记录。</p>
      ) : (
        <>
          <ul className="divide-y divide-[var(--border)]">
            {shown.map((t: ClosedTrade, i: number) => (
              <li key={`${t.closed}-${t.label}-${i}`} className="py-2.5">
                <div className="flex items-baseline gap-2">
                  <span className="font-num shrink-0 font-semibold text-[var(--text)]">
                    {t.ticker}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-sm text-[var(--text)]">
                    {t.label}
                  </span>
                  {t.pnl != null ? (
                    <SignedValue n={t.pnl} className="shrink-0" />
                  ) : (
                    <span className="shrink-0 text-xs text-[var(--dim)]">
                      成本未知
                    </span>
                  )}
                </div>
                <p className="mt-1 text-[11px] text-[var(--dim)]">
                  <span className="rounded bg-[var(--surface-alt)] px-1.5 py-0.5">
                    {t.kind === "option" ? "期权" : "股票"}
                  </span>{" "}
                  {HOW_LABELS[t.how] ?? t.how}
                  <span className="mx-1.5">·</span>
                  {fmtDate(t.opened)} → {fmtDate(t.closed)}
                  <span className="mx-1.5">·</span>
                  {accountName(data, t.account)}
                </p>
              </li>
            ))}
          </ul>
          {sorted.length > CLOSED_PREVIEW && (
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              aria-expanded={expanded}
              className="mt-3 w-full rounded-md border border-[var(--border)] py-2 text-sm text-[var(--text)]"
            >
              {expanded
                ? "收起"
                : `展开全部 ${sorted.length} 笔（当前 ${CLOSED_PREVIEW} 笔）`}
            </button>
          )}
        </>
      )}
    </Section>
  );
}

/* --------------------------------- positions -------------------------------- */

function Positions({ data }: { data: TradingDataset }) {
  const positions = [...data.positions].sort((a, b) => b.value - a.value);
  return (
    <Section
      title="当前持仓"
      right={
        <span className="text-xs text-[var(--dim)]">共 {positions.length} 项</span>
      }
    >
      {positions.length === 0 ? (
        <p className="text-sm text-[var(--dim)]">当前无持仓。</p>
      ) : (
        <ul className="divide-y divide-[var(--border)]">
          {positions.map((p, i) => (
            <li key={`${p.account}-${p.ticker}-${i}`} className="py-2.5">
              <div className="flex items-baseline gap-2">
                <span className="font-num shrink-0 font-semibold text-[var(--text)]">
                  {p.ticker}
                </span>
                <span className="min-w-0 flex-1 truncate text-sm text-[var(--dim)]">
                  {p.name}
                </span>
                {p.is_option && (
                  <span className="shrink-0 rounded bg-[var(--surface-alt)] px-1.5 py-0.5 text-[11px] text-[var(--accent)]">
                    期权
                  </span>
                )}
                <span className="font-num shrink-0 font-semibold text-[var(--text)]">
                  {fmtMoney(p.value)}
                </span>
              </div>
              <p className="font-num mt-1 text-[11px] text-[var(--dim)]">
                {fmtQty(p.qty)} @ {fmtMoney(p.price)}
                {p.cost != null && (
                  <>
                    <span className="mx-1.5">·</span>成本 {fmtMoney(p.cost)}
                  </>
                )}
                <span className="mx-1.5">·</span>
                {accountName(data, p.account)}
              </p>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

function OpenOptions({ data }: { data: TradingDataset }) {
  const genDate = (data.generated_at ?? "").slice(0, 10);
  const options = [...data.open_options].sort((a, b) =>
    a.exp.localeCompare(b.exp),
  );
  if (options.length === 0) return null;
  return (
    <Section
      title="未平仓期权"
      right={
        <span className="text-xs text-[var(--dim)]">共 {options.length} 个合约</span>
      }
    >
      <ul className="divide-y divide-[var(--border)]">
        {options.map((o, i) => {
          const days = daysBetween(genDate, o.exp);
          const short = o.contracts < 0;
          return (
            <li key={`${o.account}-${o.ticker}-${o.exp}-${o.strike}-${i}`} className="py-2.5">
              <div className="flex items-baseline gap-2">
                <span className="font-num shrink-0 font-semibold text-[var(--text)]">
                  {o.ticker}
                </span>
                <span className="shrink-0 rounded bg-[var(--surface-alt)] px-1.5 py-0.5 text-[11px] text-[var(--text)]">
                  {o.type === "put" ? "看跌 Put" : "看涨 Call"} {fmtMoney0(o.strike)}
                </span>
                <span className="min-w-0 flex-1" />
                <span className="font-num shrink-0 text-sm text-[var(--text)]">
                  {short ? "卖出" : "买入"} {Math.abs(o.contracts)} 张
                </span>
              </div>
              <p className="font-num mt-1 text-[11px] text-[var(--dim)]">
                到期 {fmtDate(o.exp)}
                {days >= 0 ? `（剩 ${days} 天）` : "（已到期）"}
                <span className="mx-1.5">·</span>均价权利金 {fmtMoney(o.avg_premium)}
                <span className="mx-1.5">·</span>开仓 {fmtDate(o.opened)}
                <span className="mx-1.5">·</span>
                {accountName(data, o.account)}
              </p>
            </li>
          );
        })}
      </ul>
    </Section>
  );
}

/* ---------------------------------- journal --------------------------------- */

const JOURNAL_TYPES = [
  { value: "all", label: "全部类型" },
  { value: "buy", label: "买入" },
  { value: "sell", label: "卖出" },
  { value: "option", label: "期权" },
  { value: "dividend", label: "股息" },
  { value: "dca", label: "定投" },
] as const;

type JournalFilter = (typeof JOURNAL_TYPES)[number]["value"];

function isDcaRow(row: JournalRow): boolean {
  return row.is_dca || (row.subtype ?? "").toLowerCase().includes("dca");
}

function isDcaMonthlySummary(row: JournalRow): boolean {
  return (row.subtype ?? "").toLowerCase() === "dca_monthly";
}

function matchJournalType(row: JournalRow, f: JournalFilter): boolean {
  switch (f) {
    case "all":
      return true;
    case "buy":
      return row.type === "buy";
    case "sell":
      return row.type === "sell";
    case "option":
      return row.is_option;
    case "dividend":
      return (
        (row.subtype ?? "").toLowerCase().includes("dividend") ||
        (row.type ?? "").toLowerCase().includes("dividend")
      );
    case "dca":
      return isDcaRow(row);
  }
}

function journalLabel(row: JournalRow): string {
  if ((row.subtype ?? "").toLowerCase().includes("dividend")) return "股息";
  switch (row.type) {
    case "buy":
      return "买入";
    case "sell":
      return "卖出";
    case "cash":
      return "现金";
    case "fee":
      return "费用";
    case "transfer":
      return "转账";
    default:
      return row.subtype || row.type;
  }
}

const JOURNAL_PREVIEW = 100;

function Journal({ data }: { data: TradingDataset }) {
  const [account, setAccount] = useState<string>("all");
  const [type, setType] = useState<JournalFilter>("all");
  const [expanded, setExpanded] = useState(false);

  const filtered = useMemo(
    () =>
      data.journal.filter(
        (r) =>
          (account === "all" || r.account === account) &&
          matchJournalType(r, type),
      ),
    [data.journal, account, type],
  );
  const shown = expanded ? filtered : filtered.slice(0, JOURNAL_PREVIEW);

  const selectClass =
    "rounded-md border border-[var(--border)] bg-[var(--surface-alt)] px-2 py-1.5 text-sm text-[var(--text)]";

  return (
    <Section title="交易流水">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-1.5 text-xs text-[var(--dim)]">
          账户
          <select
            aria-label="按账户筛选流水"
            value={account}
            onChange={(e) => {
              setAccount(e.target.value);
              setExpanded(false);
            }}
            className={selectClass}
          >
            <option value="all">全部账户</option>
            {Object.entries(data.accounts).map(([key, name]) => (
              <option key={key} value={key}>
                {name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1.5 text-xs text-[var(--dim)]">
          类型
          <select
            aria-label="按类型筛选流水"
            value={type}
            onChange={(e) => {
              setType(e.target.value as JournalFilter);
              setExpanded(false);
            }}
            className={selectClass}
          >
            {JOURNAL_TYPES.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
        </label>
        <span className="text-xs text-[var(--dim)]">
          共 {filtered.length} 条{expanded ? "" : `，显示前 ${shown.length} 条`}
        </span>
      </div>

      {filtered.length === 0 ? (
        <p className="text-sm text-[var(--dim)]">没有符合筛选条件的流水。</p>
      ) : (
        <>
          <ul className="divide-y divide-[var(--border)]">
            {shown.map((r, i) => {
              const dcaSummary = isDcaMonthlySummary(r);
              return (
                <li key={`${r.date}-${r.ticker}-${i}`} className="py-2">
                  <div className="flex items-baseline gap-2">
                    <span className="font-num shrink-0 text-xs text-[var(--dim)]">
                      {(r.date ?? "").slice(5)}
                    </span>
                    <span className="font-num shrink-0 font-semibold text-[var(--text)]">
                      {r.ticker || "—"}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-xs text-[var(--dim)]">
                      {r.name}
                    </span>
                    <span className="font-num shrink-0 text-sm text-[var(--text)]">
                      {fmtSigned(r.amount)}
                    </span>
                  </div>
                  <p className="mt-1 pl-12 text-[11px] text-[var(--dim)]">
                    <span className="rounded bg-[var(--surface-alt)] px-1.5 py-0.5 text-[var(--text)]">
                      {journalLabel(r)}
                    </span>
                    {r.is_option && (
                      <span className="ml-1 rounded bg-[var(--surface-alt)] px-1.5 py-0.5 text-[var(--accent)]">
                        期权
                      </span>
                    )}
                    {dcaSummary ? (
                      <span className="ml-1 rounded bg-[var(--surface-alt)] px-1.5 py-0.5 text-[var(--event)]">
                        定投月汇总 ×{Number.isFinite(r.qty) && r.qty > 0 ? fmtQty(r.qty) : "—"}
                      </span>
                    ) : isDcaRow(r) ? (
                      <span className="ml-1 rounded bg-[var(--surface-alt)] px-1.5 py-0.5 text-[var(--event)]">
                        定投
                      </span>
                    ) : null}
                    <span className="font-num ml-2">
                      {fmtQty(r.qty)} @ {fmtMoney(r.price)}
                    </span>
                    <span className="mx-1.5">·</span>
                    {accountName(data, r.account)}
                  </p>
                </li>
              );
            })}
          </ul>
          {filtered.length > JOURNAL_PREVIEW && (
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              aria-expanded={expanded}
              className="mt-3 w-full rounded-md border border-[var(--border)] py-2 text-sm text-[var(--text)]"
            >
              {expanded
                ? "收起，只看最近 100 条"
                : `展开全部 ${filtered.length} 条`}
            </button>
          )}
        </>
      )}
    </Section>
  );
}

/* ----------------------------------- tab ----------------------------------- */

export function TradingTab({
  trading,
}: {
  trading: Record<string, unknown> | null;
}) {
  if (!trading) {
    return (
      <div className="py-16 text-center">
        <p className="text-lg font-semibold text-[var(--text)]">
          等待交易数据首次同步
        </p>
        <p className="mx-auto mt-2 max-w-sm text-sm leading-relaxed text-[var(--dim)]">
          交易数据同步完成后，这里会显示自营账户总市值、每日进账与已实现日历、累计已实现曲线与交易统计。
        </p>
      </div>
    );
  }
  const data = normalizeTradingDataset(trading);
  return (
    <>
      <TradingOverview data={data} />
      <UpcomingEvents data={data} />
      <PnlCalendar data={data} />
      <CumRealizedCurve data={data} />
      <DailyRealizedChart data={data} />
      <EquityCurve data={data} />
      <TickerRank data={data} />
      <ClosedTrades data={data} />
      <Positions data={data} />
      <OpenOptions data={data} />
      <Journal data={data} />
      <footer className="mt-8 space-y-1.5 px-1 pb-4 text-[11px] leading-relaxed text-[var(--dim)]">
        <p>
          交易页签为自营券商账户口径（Robinhood/Schwab/BrokerageLink），不含 401k 与 HSA，与总览的全账户口径不同；每日盈亏为已实现口径。
        </p>
        <p>
          日历与已实现曲线为逐日落账口径（realized_daily）：进账 = 当日卖出成交回款 + 股息/利息入账，不含转入存款；已实现 = 当日平仓落定的盈亏，无平仓日记 0。总市值曲线为市值快照口径（daily），两者口径不同。
        </p>
        <p>
          成本未知的卖出（多为 RSU 归属股卖出）在已平仓列表中标为「成本未知」，不计入盈亏与胜率统计。
        </p>
        <p>
          涨跌以 +/− 号与 ▲▼ 符号为准，颜色仅作辅助；期权到期日由未平仓合约自动标注。
        </p>
      </footer>
    </>
  );
}
