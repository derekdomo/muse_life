// 时间复利 — weekly time-flow ledger vs self-stated priorities.
//
// All numbers come from the server (union coverage, per-category raw sums,
// overlap, uncovered-so-far, not-yet-arrived). The client only formats.
// Meaning is never carried by color alone: every category has a symbol and
// a distinct line style next to its name, and every figure has a text label.

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { SafeAreaTopScrim } from "@hatch/space-sdk/client";
import {
CartesianGrid,
Line,
LineChart,
ResponsiveContainer,
Tooltip,
XAxis,
YAxis,
} from "recharts";
import { api, type ApiResponse } from "./api";

type Dashboard = ApiResponse<typeof api, "getDashboard">;
type Entry = NonNullable<Dashboard["detail"]>["entries"][number];
type WeekSummary = Dashboard["weeks"][number];

// Must mirror CATEGORIES in server/src/actions.ts (order + names).
const CATEGORY_NAMES = [
  "工作",
  "家庭陪伴",
  "学习",
  "创造",
  "健康运动",
  "休息睡眠",
  "社交",
  "其他",
] as const;

// Okabe-Ito palette + a unique symbol + a unique line style per category.
const CATEGORY_META: Record<
  string,
  { color: string; dash?: string; dashLabel: string; symbol: string }
> = {
  工作: { color: "#0072B2", dashLabel: "实线", symbol: "●" },
  家庭陪伴: { color: "#E69F00", dash: "7 4", dashLabel: "长虚线", symbol: "▲" },
  学习: { color: "#009E73", dash: "2 3", dashLabel: "点线", symbol: "■" },
  创造: { color: "#CC79A7", dash: "12 4 3 4", dashLabel: "长短虚线", symbol: "◆" },
  健康运动: { color: "#D55E00", dash: "5 4", dashLabel: "短虚线", symbol: "✚" },
  休息睡眠: { color: "#56B4E9", dash: "14 5", dashLabel: "长划线", symbol: "▼" },
  社交: { color: "#B79F00", dash: "3 3 9 3", dashLabel: "点划线", symbol: "★" },
  其他: { color: "#8A8578", dash: "1 2", dashLabel: "密点线", symbol: "○" },
};

const TOTAL_COLOR = "#3E6D8E";

// ------------------------------------------------------------- LA formatting

const LA = "America/Los_Angeles";
const laDateDtf = new Intl.DateTimeFormat("zh-CN", {
  timeZone: LA,
  month: "numeric",
  day: "numeric",
});
const laWeekdayDtf = new Intl.DateTimeFormat("zh-CN", {
  timeZone: LA,
  weekday: "short",
});
const laTimeDtf = new Intl.DateTimeFormat("zh-CN", {
  timeZone: LA,
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});
const laPartsDtf = new Intl.DateTimeFormat("en-US", {
  timeZone: LA,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

function fmtDate(ms: number): string {
  return laDateDtf.format(new Date(ms)); // e.g. 10月21日
}

function fmtDateTime(ms: number): string {
  return `${fmtDate(ms)} ${laTimeDtf.format(new Date(ms))}`;
}

function fmtHours(minutes: number): string {
  if (minutes <= 0) return "0 小时";
  if (minutes < 60) return `${Math.round(minutes)} 分钟`;
  const h = Math.round((minutes / 60) * 10) / 10;
  return `${h} 小时`;
}

function fmtPct(part: number, whole: number): string {
  if (whole <= 0) return "—";
  return `${Math.round((part / whole) * 100)}%`;
}

// "YYYY-MM-DD" (server week label) → "10月19日"
function labelToShort(label: string): string {
  const [, m, d] = label.split("-");
  return `${Number(m)}月${Number(d)}日`;
}

// ------------------------------------------------- LA wall-clock <-> epoch

interface LaWall {
  y: number;
  m: number;
  d: number;
  hh: number;
  mm: number;
}

function laWallParts(ms: number): LaWall {
  const p: Record<string, string> = {};
  for (const part of laPartsDtf.formatToParts(new Date(ms))) p[part.type] = part.value;
  return {
    y: Number(p.year),
    m: Number(p.month),
    d: Number(p.day),
    hh: Number(p.hh ?? p.hour),
    mm: Number(p.minute),
  };
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

// Epoch ms → value for <input type="datetime-local"> in LA wall time.
function toLocalInput(ms: number): string {
  const w = laWallParts(ms);
  return `${w.y}-${pad(w.m)}-${pad(w.d)}T${pad(w.hh)}:${pad(w.mm)}`;
}

// datetime-local value (LA wall time) → epoch ms.
function fromLocalInput(value: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!match) return null;
  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  const hh = Number(match[4]);
  const mm = Number(match[5]);
  const target = Date.UTC(y, m - 1, d, hh, mm);
  let guess = target;
  for (let i = 0; i < 3; i++) {
    const w = laWallParts(guess);
    const wallAsUtc = Date.UTC(w.y, w.m - 1, w.d, w.hh, w.mm);
    guess += target - wallAsUtc;
  }
  return guess;
}

function newRequestId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `req-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
}

const ERROR_TEXT: Record<string, string> = {
  forbidden: "只有所有者可以修改记录。",
  conflict:
    "这笔提交与先前已保存的内容不一致，已保留你的草稿、没有重复记录。请核对后重新提交。",
  deleted: "这条记录已被删除，无法再修改。你的草稿已保留，可以关掉后重新记一笔。",
  future_interval: "未来的时间还不能记为已发生。草稿已保留，把结束时间改到现在以前再提交。",
  invalid_range: "时间范围不对：结束时间要晚于开始时间，单条记录最长 31 天。草稿已保留。",
  not_found: "这条记录已经不存在了。",
};

// ------------------------------------------------------------------- draft

interface Draft {
  requestId: string;
  entryId: number | null; // null = new record
  category: string;
  startLocal: string;
  endLocal: string;
  note: string;
}

function freshDraft(nowMs: number): Draft {
  const end = nowMs;
  const start = nowMs - 3_600_000;
  return {
    requestId: newRequestId(),
    entryId: null,
    category: "工作",
    startLocal: toLocalInput(start),
    endLocal: toLocalInput(end),
    note: "",
  };
}

// New-record draft anchored in the week being viewed, so 补记 keeps the
// selected week's date: current week → the last hour ending now; a past
// week → Monday 09:00–10:00 LA of that week. Never a zero-length interval,
// never an auto-filled whole day.
function draftForWeek(
  summary: WeekSummary,
  isCurrent: boolean,
  nowMs: number,
): Draft {
  if (isCurrent) return freshDraft(nowMs);
  const start = summary.weekStartMs + 9 * 3_600_000;
  return {
    requestId: newRequestId(),
    entryId: null,
    category: "工作",
    startLocal: toLocalInput(start),
    endLocal: toLocalInput(start + 3_600_000),
    note: "",
  };
}

// ------------------------------------------------------- coverage states

type CoverageState = "zero" | "partial" | "full";

// The three review states. "full" = every elapsed minute of the viewed week
// is covered by the union of records (≤1s of float slack). Server numbers
// decide; the client only classifies and words them.
function coverageStateOf(
  hasRecords: boolean,
  uncoveredElapsedMinutes: number | null,
): CoverageState {
  if (!hasRecords) return "zero";
  if (uncoveredElapsedMinutes != null && uncoveredElapsedMinutes <= 1 / 60) {
    return "full";
  }
  return "partial";
}

// ------------------------------------------------------- accumulation chart

function AccumulationChart({ weeks }: { weeks: WeekSummary[] }) {
  const presentCategories = useMemo(() => {
    const set = new Set<string>();
    for (const w of weeks) for (const c of w.byCategory) set.add(c.category);
    return CATEGORY_NAMES.filter((c) => set.has(c));
  }, [weeks]);

  const data = useMemo(
    () =>
      weeks.map((w) => {
        const row: Record<string, number | string> = {
          name: w.startLabel.slice(5), // MM-DD
          已记录覆盖: Math.round((w.coverageMinutes / 60) * 10) / 10,
        };
        for (const c of w.byCategory) {
          row[c.category] = Math.round((c.minutes / 60) * 10) / 10;
        }
        return row;
      }),
    [weeks],
  );

  const anyRecords = weeks.some((w) => w.hasRecords);

  return (
    <div>
      {!anyRecords ? (
        <p className="text-sm text-[var(--dim)]">
          还没有积累曲线：记下第一笔时间后，这里会按周画出已记录覆盖的走势。
        </p>
      ) : (
        <>
          <div aria-label="每周积累曲线图：纵轴为小时，横轴为各周周一日期">
            <ResponsiveContainer width="100%" height={240}>
              <LineChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: -14 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                <XAxis
                  dataKey="name"
                  tick={{ fontSize: 11, fill: "var(--dim)" }}
                  tickLine={false}
                  axisLine={{ stroke: "var(--border)" }}
                />
                <YAxis
                  domain={[0, "auto"]}
                  tick={{ fontSize: 11, fill: "var(--dim)" }}
                  tickLine={false}
                  axisLine={false}
                  tickFormatter={(v: number) => `${v}h`}
                />
                <Tooltip
                  formatter={(value: unknown, name: unknown) => [
                    `${value} 小时`,
                    String(name),
                  ]}
                  labelFormatter={(label: unknown) => `周一 ${String(label)} 起的一周`}
                  contentStyle={{
                    background: "var(--surface)",
                    border: "1px solid var(--border)",
                    borderRadius: 8,
                    fontSize: 12,
                  }}
                />
                <Line
                  type="monotone"
                  dataKey="已记录覆盖"
                  stroke={TOTAL_COLOR}
                  strokeWidth={2.5}
                  dot={{ r: 2.5 }}
                  connectNulls={false}
                />
                {presentCategories.map((c) => (
                  <Line
                    key={c}
                    type="monotone"
                    dataKey={c}
                    stroke={CATEGORY_META[c]?.color}
                    strokeDasharray={CATEGORY_META[c]?.dash}
                    strokeWidth={1.8}
                    dot={false}
                    connectNulls={false}
                  />
                ))}
              </LineChart>
            </ResponsiveContainer>
          </div>
          {/* Legend: line style + symbol + name — never color alone. */}
          <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1.5">
            <li className="flex items-center gap-1.5 text-xs text-[var(--text)]">
              <svg width="26" height="6" aria-hidden="true">
                <line x1="0" y1="3" x2="26" y2="3" stroke={TOTAL_COLOR} strokeWidth="2.5" />
              </svg>
              <span>已记录覆盖（实线 · 时间轴并集）</span>
            </li>
            {presentCategories.map((c) => (
              <li key={c} className="flex items-center gap-1.5 text-xs text-[var(--text)]">
                <svg width="26" height="6" aria-hidden="true">
                  <line
                    x1="0"
                    y1="3"
                    x2="26"
                    y2="3"
                    stroke={CATEGORY_META[c]?.color}
                    strokeWidth="1.8"
                    strokeDasharray={CATEGORY_META[c]?.dash}
                  />
                </svg>
                <span>
                  {CATEGORY_META[c]?.symbol} {c}（{CATEGORY_META[c]?.dashLabel}）
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
      <ul className="mt-4 divide-y divide-[var(--border)] border-t border-[var(--border)]">
        {[...weeks].reverse().map((w) => (
          <li
            key={w.weekStartMs}
            className="flex items-baseline justify-between gap-3 py-1.5 text-sm"
          >
            <span className="text-[var(--dim)]">
              {labelToShort(w.startLabel)} – {labelToShort(w.endLabel)}
            </span>
            {w.hasRecords ? (
              <span className="tabular-nums">已记录覆盖 {fmtHours(w.coverageMinutes)}</span>
            ) : (
              <span className="text-[var(--dim)]">无记录</span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

// --------------------------------------------------------------------- app

export function App() {
  const queryClient = useQueryClient();
  const [detailWeekMs, setDetailWeekMs] = useState<number | undefined>(undefined);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null);
  const [priorityDraft, setPriorityDraft] = useState<string[] | null>(null);
  // Category filter: narrows ONLY the interval list below — the week's
  // summary, cutoff and timezone stay exactly as computed.
  const [categoryFilter, setCategoryFilter] = useState<string | null>(null);

  const dashboard = useQuery({
    queryKey: ["dashboard", detailWeekMs ?? "current"],
    queryFn: () =>
      api.getDashboard(detailWeekMs ? { weekStartMs: detailWeekMs } : {}),
  });

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ["dashboard"] });

  const addMutation = useMutation({
    mutationFn: api.addEntry,
    onSuccess: () => invalidate(),
  });
  const updateMutation = useMutation({
    mutationFn: api.updateEntry,
    onSuccess: () => invalidate(),
  });
  const deleteMutation = useMutation({
    mutationFn: api.deleteEntry,
    onSuccess: () => invalidate(),
  });
  const prioritiesMutation = useMutation({
    mutationFn: api.setPriorities,
    onSuccess: () => invalidate(),
  });

  const data = dashboard.data;
  const detail = data?.detail ?? null;
  const summary = detail?.summary ?? null;
  const isCurrentWeek =
    summary != null && data != null && summary.weekStartMs === data.currentWeekStartMs;
  const weekIndex = data?.weeks.findIndex((w) => w.weekStartMs === summary?.weekStartMs) ?? -1;
  const canGoPrev = weekIndex > 0;
  const canGoNext = data != null && summary != null && !isCurrentWeek;

  async function submitDraft() {
    if (!draft) return;
    const startMs = fromLocalInput(draft.startLocal);
    const endMs = fromLocalInput(draft.endLocal);
    if (startMs == null || endMs == null) {
      setFormError("时间填写不完整，请检查开始和结束时间。草稿已保留。");
      return;
    }
    setFormError(null);
    const payload = {
      category: draft.category as (typeof CATEGORY_NAMES)[number],
      startMs,
      endMs,
      note: draft.note.trim(),
    };
    const res =
      draft.entryId == null
        ? await addMutation.mutateAsync({ requestId: draft.requestId, ...payload })
        : await updateMutation.mutateAsync({
            requestId: draft.requestId,
            entryId: draft.entryId,
            ...payload,
          });
    if (res.ok) {
      setDraft(null);
      setNotice(draft.entryId == null ? "已记下这一笔。" : "修改已保存。");
    } else {
      // Draft (and its text) stays exactly as typed; only a conflict swaps in
      // a fresh requestId so the corrected resubmission can go through.
      setFormError(ERROR_TEXT[res.error ?? ""] ?? "保存失败，草稿已保留，请再试一次。");
      if (res.error === "conflict") {
        setDraft({ ...draft, requestId: newRequestId() });
      }
    }
  }

  async function confirmDelete(entry: Entry) {
    const res = await deleteMutation.mutateAsync({
      requestId: newRequestId(),
      entryId: entry.id,
    });
    setConfirmDeleteId(null);
    if (res.ok) {
      setNotice("已删除这一笔。");
      if (draft?.entryId === entry.id) setDraft(null);
    } else {
      setNotice(ERROR_TEXT[res.error ?? ""] ?? "删除失败，请再试一次。");
    }
  }

  function scrollToId(id: string) {
    document.getElementById(id)?.scrollIntoView({ block: "start" });
  }

  // 「补记一段」: open the existing entry form anchored in the viewed week.
  // If a draft is already open, never clobber it — just scroll to it.
  function openBackfill() {
    if (draft) {
      scrollToId("entry-form");
      return;
    }
    const s = data?.detail?.summary;
    if (!s) return;
    setFormError(null);
    setNotice(null);
    setConfirmDeleteId(null);
    setDraft(
      draftForWeek(s, s.weekStartMs === data.currentWeekStartMs, Date.now()),
    );
    window.setTimeout(() => scrollToId("entry-form"), 60);
  }

  async function savePriorities() {
    if (!priorityDraft) return;
    const res = await prioritiesMutation.mutateAsync({
      priorities: priorityDraft as (typeof CATEGORY_NAMES)[number][],
    });
    if (res.ok) {
      setPriorityDraft(null);
      setNotice("本周重点已保存。");
    } else {
      setNotice(ERROR_TEXT[res.error ?? ""] ?? "保存失败，请再试一次。");
    }
  }

  if (dashboard.isPending) {
    return (
      <div className="min-h-screen bg-[var(--bg)]">
        <SafeAreaTopScrim backgroundColor="var(--bg)" />
        <main className="mx-auto max-w-2xl px-4 py-16 text-center text-sm text-[var(--dim)]">
          正在打开时间账本…
        </main>
      </div>
    );
  }

  if (dashboard.error || !data) {
    return (
      <div className="min-h-screen bg-[var(--bg)]">
        <SafeAreaTopScrim backgroundColor="var(--bg)" />
        <main className="mx-auto max-w-2xl px-4 py-16 text-center">
          <p className="text-sm text-[var(--text)]">账本暂时打不开。</p>
          <button
            type="button"
            onClick={() => dashboard.refetch()}
            className="mt-4 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-4 py-2 text-sm"
          >
            重试
          </button>
        </main>
      </div>
    );
  }

  if (data.forbidden || !detail || !summary) {
    return (
      <div className="min-h-screen bg-[var(--bg)]">
        <SafeAreaTopScrim backgroundColor="var(--bg)" />
        <main className="mx-auto max-w-2xl px-4 py-16 text-center">
          <p className="font-[family-name:var(--font-ledger)] text-lg text-[var(--text)]">
            这本时间账本只对所有者开放
          </p>
          <p className="mt-2 text-sm text-[var(--dim)]">
            当前身份无权查看或记录，这里不会显示任何数据。
          </p>
        </main>
      </div>
    );
  }

  const nowMs = data.nowMs;
  const categories = summary.byCategory;
  const hasRecords = summary.hasRecords;
  const covState = coverageStateOf(hasRecords, detail.uncoveredElapsedMinutes);
  const shownEntries = categoryFilter
    ? detail.entries.filter((e) => e.category === categoryFilter)
    : detail.entries;
  const maxCatMinutes = Math.max(1, ...categories.map((c) => c.minutes));
  const editingPriorities = priorityDraft !== null;
  const shownPriorities = editingPriorities ? priorityDraft : data.priorities;

  return (
    <div className="min-h-screen bg-[var(--bg)] text-[var(--text)]">
      <SafeAreaTopScrim backgroundColor="var(--bg)" />
      <main className="mx-auto max-w-2xl px-4 pb-16">
        {/* ---- Week heading: fixed facts about this page's window ---- */}
        <header className="pt-6">
          <p className="text-xs tracking-wide text-[var(--dim)]">
            洛杉矶时间（America/Los_Angeles）· 周一到周日 · 全部为手动记录
          </p>
          <h1 className="mt-1.5 font-[family-name:var(--font-ledger)] text-3xl leading-tight">
            {labelToShort(summary.startLabel)} – {labelToShort(summary.endLabel)}
            {isCurrentWeek ? " · 本周" : ""}
          </h1>
          <p className="mt-1.5 text-sm text-[var(--dim)]">
            {isCurrentWeek ? (
              <>
                截至 {fmtDate(nowMs)}（{laWeekdayDtf.format(new Date(nowMs))}）
                {laTimeDtf.format(new Date(nowMs))} · 本周共有 {summary.totalHours} 小时
                {summary.totalHours !== 168
                  ? "（夏令时切换周，实际不是 168 小时）"
                  : "（普通周参照）"}
              </>
            ) : (
              <>这一周已经结束 · 当周共有 {summary.totalHours} 小时</>
            )}
          </p>
          <nav aria-label="切换周" className="mt-3 flex items-center gap-2">
            <button
              type="button"
              disabled={!canGoPrev}
              onClick={() => {
                const prev = data.weeks[weekIndex - 1];
                if (prev) {
                  setCategoryFilter(null);
                  setDetailWeekMs(prev.weekStartMs);
                }
              }}
              className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-1.5 text-sm disabled:opacity-40"
            >
              ← 上一周
            </button>
            <button
              type="button"
              disabled={isCurrentWeek}
              onClick={() => {
                setCategoryFilter(null);
                setDetailWeekMs(undefined);
              }}
              className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-1.5 text-sm disabled:opacity-40"
            >
              回到本周
            </button>
            <button
              type="button"
              disabled={!canGoNext}
              onClick={() => {
                const next = data.weeks[weekIndex + 1];
                if (next) {
                  setCategoryFilter(null);
                  setDetailWeekMs(
                    next.weekStartMs === data.currentWeekStartMs
                      ? undefined
                      : next.weekStartMs,
                  );
                }
              }}
              className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-1.5 text-sm disabled:opacity-40"
            >
              下一周 →
            </button>
          </nav>
          {notice ? (
            <p role="status" className="mt-3 text-sm text-[var(--accent-soft)]">
              {notice}
            </p>
          ) : null}
        </header>

        {/* ---- Hero: coverage state (zero / partial / full) ---- */}
        <section aria-label="本周覆盖状态" className="mt-8">
          <p className="text-sm text-[var(--dim)]">已记录覆盖（时间轴并集）</p>
          {covState === "zero" ? (
            <>
              <p className="mt-1 font-[family-name:var(--font-ledger)] text-3xl leading-snug">
                ○ {isCurrentWeek ? "本周还没有时间记录" : "这一周没有时间记录"}
              </p>
              <p className="mt-2 text-sm leading-relaxed text-[var(--dim)]">
                没有记录只表示还没记进这本时间账本，不等于没有训练、没有陪伴或什么都没做——训练和陪伴不会因为没记在这里就不存在。从补记第一段开始即可。
              </p>
            </>
          ) : (
            <>
              <p className="mt-1 font-[family-name:var(--font-ledger)] text-5xl tabular-nums">
                {fmtHours(summary.coverageMinutes)}
              </p>
              <p className="mt-1.5 text-sm text-[var(--dim)]">
                {covState === "full" ? (
                  <>
                    ● 已完整覆盖 · 已记录 {fmtHours(summary.coverageMinutes)}（
                    {isCurrentWeek
                      ? `截至 ${fmtDateTime(nowMs)}，已过去的时间全部有记录`
                      : "整周全部有记录"}
                    ）
                  </>
                ) : (
                  <>
                    ◐ 部分覆盖 · 已记录 {fmtHours(summary.coverageMinutes)}（
                    {isCurrentWeek ? `截至 ${fmtDateTime(nowMs)}` : "整周已结束"}）· 共{" "}
                    {detail.entries.length} 笔记录 · 只统计记下来的时间，不外推到整周
                  </>
                )}
              </p>
            </>
          )}
          {/* Next steps: only check/backfill or open the records — no
              inference from a missing category, no plan changes. */}
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <span className="text-sm text-[var(--dim)]">下一步：</span>
            {covState !== "full" ? (
              <button
                type="button"
                onClick={openBackfill}
                className="rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-medium text-[var(--bg)]"
              >
                补记一段
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => scrollToId("uncovered-block")}
              className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm"
            >
              检查未覆盖时段
            </button>
            {covState === "full" ? (
              <button
                type="button"
                onClick={() => scrollToId("week-entries")}
                className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm"
              >
                查看本周记录
              </button>
            ) : null}
            {covState === "full" ? (
              <button
                type="button"
                onClick={openBackfill}
                className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm"
              >
                补记一段
              </button>
            ) : null}
          </div>
        </section>

        {/* ---- Block 1: recorded time by category ---- */}
        <section aria-label="已记录时间" className="mt-10">
          <h2 className="font-[family-name:var(--font-ledger)] text-xl">已记录时间</h2>
          {hasRecords ? (
            <>
              <p className="mt-2 text-xs text-[var(--dim)]">
                点某个分类，下面的记录列表只显示该分类；本周的覆盖、占比与起止不变。
              </p>
              <ul className="mt-3 space-y-3">
                {categories.map((c) => (
                  <li key={c.category}>
                    <div className="flex items-baseline justify-between gap-3 text-sm">
                      <button
                        type="button"
                        aria-pressed={categoryFilter === c.category}
                        aria-label={`只看「${c.category}」的记录`}
                        onClick={() => {
                          if (categoryFilter === c.category) {
                            setCategoryFilter(null);
                          } else {
                            setCategoryFilter(c.category);
                            window.setTimeout(() => scrollToId("week-entries"), 60);
                          }
                        }}
                        className="rounded-md text-left underline-offset-4 hover:underline"
                      >
                        <span aria-hidden="true">{CATEGORY_META[c.category]?.symbol} </span>
                        {c.category}
                        {categoryFilter === c.category ? (
                          <span className="text-[var(--accent-soft)]"> · 过滤中 ✓</span>
                        ) : null}
                      </button>
                      <span className="tabular-nums">
                        {fmtHours(c.minutes)}
                        <span className="text-[var(--dim)]">
                          {" "}
                          · 占已记录时间 {fmtPct(c.minutes, summary.categorySumMinutes)}
                        </span>
                      </span>
                    </div>
                    <div
                      className="mt-1 h-2 rounded-full bg-[var(--surface-alt)]"
                      role="img"
                      aria-label={`${c.category} 已记录 ${fmtHours(c.minutes)}`}
                    >
                      <div
                        className="h-2 rounded-full"
                        style={{
                          width: `${(c.minutes / maxCatMinutes) * 100}%`,
                          background: CATEGORY_META[c.category]?.color,
                        }}
                      />
                    </div>
                  </li>
                ))}
              </ul>
              <p className="mt-3 text-xs leading-relaxed text-[var(--dim)]">
                「占已记录时间」的分母是全部已记录的分类时长之和，不是整周。
                {summary.overlapMinutes > 0 ? (
                  <>
                    {" "}
                    本周有 {fmtHours(summary.overlapMinutes)}
                    的重叠：同一段时间被记进了不止一个分类，分类时长各算各的、不可相加；上方覆盖时长按时间轴并集计算，没有重复计。
                  </>
                ) : (
                  <> 本周各分类没有时间重叠。</>
                )}
              </p>
            </>
          ) : (
            <p className="mt-3 text-sm text-[var(--dim)]">
              分类占比：暂无可计算记录。记下第一笔后，这里会按「占已记录时间」显示各分类占比。
            </p>
          )}

          {/* Entry form */}
          {draft ? (
            <form
              id="entry-form"
              className="mt-5 scroll-mt-4 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-4"
              onSubmit={(e) => {
                e.preventDefault();
                void submitDraft();
              }}
            >
              <p className="font-[family-name:var(--font-ledger)] text-base">
                {draft.entryId == null ? "记一笔时间" : "修改这笔记录"}
              </p>
              <div className="mt-3 grid gap-3">
                <label className="grid gap-1 text-sm">
                  <span className="text-[var(--dim)]">分类</span>
                  <select
                    aria-label="分类"
                    value={draft.category}
                    onChange={(e) => setDraft({ ...draft, category: e.target.value })}
                    className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2"
                  >
                    {CATEGORY_NAMES.map((c) => (
                      <option key={c} value={c}>
                        {CATEGORY_META[c]?.symbol} {c}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <label className="grid gap-1 text-sm">
                    <span className="text-[var(--dim)]">开始（洛杉矶时间）</span>
                    <input
                      aria-label="开始时间"
                      type="datetime-local"
                      value={draft.startLocal}
                      onChange={(e) => setDraft({ ...draft, startLocal: e.target.value })}
                      className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2"
                    />
                  </label>
                  <label className="grid gap-1 text-sm">
                    <span className="text-[var(--dim)]">结束（洛杉矶时间）</span>
                    <input
                      aria-label="结束时间"
                      type="datetime-local"
                      value={draft.endLocal}
                      onChange={(e) => setDraft({ ...draft, endLocal: e.target.value })}
                      className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2"
                    />
                  </label>
                </div>
                <label className="grid gap-1 text-sm">
                  <span className="text-[var(--dim)]">备注（可空）</span>
                  <input
                    aria-label="备注"
                    type="text"
                    value={draft.note}
                    maxLength={500}
                    onChange={(e) => setDraft({ ...draft, note: e.target.value })}
                    className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2"
                  />
                </label>
              </div>
              {formError ? (
                <p role="alert" className="mt-3 text-sm text-[var(--danger)]">
                  {formError}
                </p>
              ) : null}
              <div className="mt-4 flex gap-2">
                <button
                  type="submit"
                  disabled={addMutation.isPending || updateMutation.isPending}
                  className="rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-medium text-[var(--bg)] disabled:opacity-50"
                >
                  保存记录
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setDraft(null);
                    setFormError(null);
                  }}
                  className="rounded-lg border border-[var(--border)] px-4 py-2 text-sm"
                >
                  取消
                </button>
              </div>
            </form>
          ) : (
            <button
              type="button"
              onClick={openBackfill}
              className="mt-5 rounded-lg bg-[var(--accent)] px-4 py-2.5 text-sm font-medium text-[var(--bg)]"
            >
              {hasRecords ? "＋ 记一笔时间" : "补记一段"}
            </button>
          )}

          {/* This week's records (the interval list the category filter
              narrows — week, cutoff and timezone are untouched) */}
          {detail.entries.length > 0 ? (
            <div id="week-entries" className="scroll-mt-4">
              <div className="mt-5 flex items-baseline justify-between gap-3">
                <p className="text-sm font-medium">
                  本周记录（{detail.entries.length} 笔）
                </p>
                {categoryFilter ? (
                  <span className="text-xs text-[var(--accent-soft)]">
                    过滤中：只显示「{categoryFilter}」
                  </span>
                ) : null}
              </div>
              {categoryFilter ? (
                <div
                  role="status"
                  className="mt-2 flex flex-wrap items-center justify-between gap-2 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm"
                >
                  <span>
                    过滤中：只显示「{categoryFilter}」的记录（{shownEntries.length}{" "}
                    笔）· 仍是 {labelToShort(summary.startLabel)} –{" "}
                    {labelToShort(summary.endLabel)} 这一周 · 洛杉矶时间
                  </span>
                  <button
                    type="button"
                    onClick={() => setCategoryFilter(null)}
                    className="shrink-0 rounded-md border border-[var(--border)] px-2.5 py-1"
                  >
                    回到全部
                  </button>
                </div>
              ) : null}
              <ul className="mt-3 divide-y divide-[var(--border)] border-y border-[var(--border)]">
              {shownEntries.map((e) => (
                <li key={e.id} className="py-3">
                  <div className="flex items-baseline justify-between gap-3">
                    <p className="text-sm font-medium">
                      <span aria-hidden="true">{CATEGORY_META[e.category]?.symbol} </span>
                      {e.category}
                      <span className="tabular-nums text-[var(--dim)]">
                        {" "}
                        · {fmtHours((e.endMs - e.startMs) / 60_000)}
                      </span>
                    </p>
                    <div className="flex shrink-0 gap-2 text-sm">
                      <button
                        type="button"
                        aria-label={`修改记录 ${e.category} ${fmtDateTime(e.startMs)}`}
                        onClick={() => {
                          setFormError(null);
                          setNotice(null);
                          setConfirmDeleteId(null);
                          setDraft({
                            requestId: newRequestId(),
                            entryId: e.id,
                            category: e.category,
                            startLocal: toLocalInput(e.startMs),
                            endLocal: toLocalInput(e.endMs),
                            note: e.note,
                          });
                        }}
                        className="rounded-md border border-[var(--border)] px-2.5 py-1"
                      >
                        修改
                      </button>
                      <button
                        type="button"
                        aria-label={`删除记录 ${e.category} ${fmtDateTime(e.startMs)}`}
                        onClick={() => setConfirmDeleteId(e.id)}
                        className="rounded-md border border-[var(--border)] px-2.5 py-1"
                      >
                        删除
                      </button>
                    </div>
                  </div>
                  <p className="mt-0.5 text-sm tabular-nums text-[var(--dim)]">
                    {fmtDateTime(e.startMs)} – {fmtDateTime(e.endMs)}
                    {e.note ? ` · ${e.note}` : ""}
                  </p>
                  {confirmDeleteId === e.id ? (
                    <div className="mt-2 flex items-center gap-2 text-sm">
                      <span>确定删除这一笔？</span>
                      <button
                        type="button"
                        disabled={deleteMutation.isPending}
                        onClick={() => void confirmDelete(e)}
                        className="rounded-md bg-[var(--danger)] px-2.5 py-1 font-medium text-white disabled:opacity-50"
                      >
                        确认删除
                      </button>
                      <button
                        type="button"
                        onClick={() => setConfirmDeleteId(null)}
                        className="rounded-md border border-[var(--border)] px-2.5 py-1"
                      >
                        不删了
                      </button>
                    </div>
                  ) : null}
                </li>
              ))}
              </ul>
            </div>
          ) : null}
        </section>

        {/* ---- Block 2: time not covered by records ---- */}
        <section id="uncovered-block" aria-label="记录未覆盖时间" className="mt-12 scroll-mt-4">
          <h2 className="font-[family-name:var(--font-ledger)] text-xl">记录未覆盖时间</h2>
          <div className="mt-3 grid gap-3">
            <div className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-4">
              <p className="text-sm text-[var(--dim)]">
                {isCurrentWeek ? "截至当前 · 已过去但没有记录覆盖" : "这一周没有记录覆盖的部分"}
              </p>
              <p className="mt-1 font-[family-name:var(--font-ledger)] text-3xl tabular-nums">
                {detail.uncoveredElapsedMinutes == null
                  ? "—（本周尚未开始）"
                  : fmtHours(detail.uncoveredElapsedMinutes)}
              </p>
            </div>
            {isCurrentWeek ? (
              <div className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-4">
                <p className="text-sm text-[var(--dim)]">本周尚未到来（还没发生，不算未记录）</p>
                <p className="mt-1 font-[family-name:var(--font-ledger)] text-3xl tabular-nums">
                  {fmtHours(detail.notYetMinutes)}
                </p>
              </div>
            ) : null}
          </div>
          <p className="mt-3 text-xs leading-relaxed text-[var(--dim)]">
            「未覆盖」只表示这段时间没有留下记录，不代表空闲、休息或浪费——没记下来的时间就是没记下来，仅此而已。
          </p>
        </section>

        {/* ---- Stated priorities vs recorded time (facts only) ---- */}
        <section aria-label="自述重点与实际记录对照" className="mt-12">
          <div className="flex items-baseline justify-between gap-3">
            <h2 className="font-[family-name:var(--font-ledger)] text-xl">我本周想重视什么</h2>
            {editingPriorities ? (
              <div className="flex gap-2 text-sm">
                <button
                  type="button"
                  disabled={prioritiesMutation.isPending}
                  onClick={() => void savePriorities()}
                  className="rounded-md bg-[var(--accent)] px-3 py-1 font-medium text-[var(--bg)] disabled:opacity-50"
                >
                  保存重点
                </button>
                <button
                  type="button"
                  onClick={() => setPriorityDraft(null)}
                  className="rounded-md border border-[var(--border)] px-3 py-1"
                >
                  取消
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setPriorityDraft([...data.priorities])}
                className="rounded-md border border-[var(--border)] px-3 py-1 text-sm"
              >
                {data.priorities.length > 0 ? "修改重点" : "选我的重点"}
              </button>
            )}
          </div>

          {editingPriorities ? (
            <fieldset className="mt-3">
              <legend className="text-sm text-[var(--dim)]">
                勾选现阶段想优先投入时间的分类（这是你的自述重点，只用来和实际记录对照，不打分、不排名）
              </legend>
              <div className="mt-2 flex flex-wrap gap-2">
                {CATEGORY_NAMES.map((c) => {
                  const checked = priorityDraft.includes(c);
                  return (
                    <label
                      key={c}
                      className={`flex cursor-pointer items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm ${
                        checked
                          ? "border-[var(--accent)] bg-[var(--surface-alt)] font-medium"
                          : "border-[var(--border)]"
                      }`}
                    >
                      <input
                        type="checkbox"
                        aria-label={`重点分类 ${c}`}
                        checked={checked}
                        onChange={(e) =>
                          setPriorityDraft(
                            e.target.checked
                              ? [...priorityDraft, c]
                              : priorityDraft.filter((x) => x !== c),
                          )
                        }
                        className="h-4 w-4 accent-[var(--accent)]"
                      />
                      <span aria-hidden="true">{CATEGORY_META[c]?.symbol}</span> {c}
                      {checked ? " ✓" : ""}
                    </label>
                  );
                })}
              </div>
            </fieldset>
          ) : data.priorities.length === 0 ? (
            <p className="mt-3 text-sm text-[var(--dim)]">
              还没有选自述重点。选了之后，这里会把「我想重视什么」和本周实际记录并排放在一起看。
            </p>
          ) : (
            <ul className="mt-3 space-y-2.5">
              {detail.priorityMinutes.map((p) => (
                <li
                  key={p.category}
                  className="flex items-baseline justify-between gap-3 text-sm"
                >
                  <span>
                    <span aria-hidden="true">{CATEGORY_META[p.category]?.symbol} </span>
                    {p.category}
                    <span className="text-[var(--dim)]">（自述重点）</span>
                  </span>
                  <span className="tabular-nums">
                    {p.minutes > 0 ? `本周已记录 ${fmtHours(p.minutes)}` : "本周尚无记录"}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {!editingPriorities && shownPriorities.length > 0 ? (
            <p className="mt-3 text-xs leading-relaxed text-[var(--dim)]">
              这里只做事实对照：重点是你说的，时长是记下来的，两边并排看，不换算成分数，也不下结论；某个重点本周没记到，只说明没记到，不代表需要补练或补记。
            </p>
          ) : null}
        </section>

        {/* ---- Accumulation curve ---- */}
        <section aria-label="每周积累曲线" className="mt-12">
          <h2 className="font-[family-name:var(--font-ledger)] text-xl">每周积累</h2>
          <p className="mt-1.5 text-sm text-[var(--dim)]">
            累计已记录覆盖{" "}
            <span className="tabular-nums text-[var(--text)]">
              {fmtHours(data.cumulativeCoverageMinutes)}
            </span>{" "}
            · 有记录的周数{" "}
            <span className="tabular-nums text-[var(--text)]">{data.weeksWithRecords} 周</span>
            。每周记下一点，曲线就是这样一周一周长起来的。
          </p>
          <div className="mt-4">
            <AccumulationChart weeks={data.weeks} />
          </div>
          <p className="mt-4 text-xs leading-relaxed text-[var(--dim)]">
            曲线只统计手动记录并按时间轴并集去重后的覆盖时长；没有记录的那一周标为「无记录」，不猜测、不补零外推。
          </p>
        </section>
      </main>
    </div>
  );
}
