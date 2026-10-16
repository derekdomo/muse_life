import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { SafeAreaTopScrim } from "@hatch/space-sdk/client";
import {
Area,
AreaChart,
Bar,
BarChart,
CartesianGrid,
Line,
LineChart,
PolarAngleAxis,
PolarGrid,
Radar,
RadarChart,
ResponsiveContainer,
Tooltip,
XAxis,
YAxis,
} from "recharts";
import { api, type ApiResponse } from "./api";

type DashboardResponse = ApiResponse<typeof api, "getDashboard">;
type Snapshot = NonNullable<DashboardResponse["snapshot"]>;
type Readiness = NonNullable<DashboardResponse["readiness"]>;
type TrendPoint = Snapshot["trends"][number];
type Daily = Snapshot["historyDaily"][number];
type StrengthWorkout = Snapshot["strengthTraining"]["workouts"][number];
type DataStatus = NonNullable<DashboardResponse["dataStatus"]>;
type UnifiedDay = DashboardResponse["unifiedTimeline"][number];
type StrengthTraining = NonNullable<DashboardResponse["strength"]>;
type SourceState = DashboardResponse["healthState"];
type Tab = "today" | "trends" | "history";
type Status = "正常" | "偏低" | "偏高" | "数据缺失" | "基线不足";

const ROUTINE_LABELS: Record<StrengthWorkout["routine"], string> = { push: "推", pull: "拉", legs: "腿" };

function statusClass(status: Status): string {
  if (status === "正常") return "status-ok";
  if (status === "数据缺失" || status === "基线不足") return "status-missing";
  return "status-watch";
}

function dateLabel(date: string): string {
  const [, month = "", day = ""] = date.split("-");
  return `${Number(month)}/${Number(day)}`;
}

function fullDateLabel(date: string): string {
  const [year = "", month = "", day = ""] = date.split("-");
  return `${year}年${Number(month)}月${Number(day)}日`;
}

function updatedLabel(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(date);
}

function numberLabel(value: number | null, digits = 0): string {
  if (value === null) return "—";
  return value.toLocaleString("zh-CN", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

function volumeLabel(value: number): string {
  return Math.round(value).toLocaleString("zh-CN");
}

function durationLabel(value: number | null): string {
  if (value === null) return "进行中";
  if (value < 60) return `${Math.round(value)} 分钟`;
  return `${Math.floor(value / 60)} 小时 ${Math.round(value % 60)} 分`;
}

function actualSleepHours(sleep: Pick<Snapshot["sleep"], "coreHours" | "deepHours" | "remHours" | "inBedHours">): number {
  const stageTotal = (sleep.coreHours ?? 0) + (sleep.deepHours ?? 0) + (sleep.remHours ?? 0);
  return stageTotal > 0 ? stageTotal : sleep.inBedHours;
}

function Kpi({ label, value, unit, detail, status }: { label: string; value: string; unit?: string; detail: string; status: Status }) {
  return (
    <div className="kpi">
      <div className="kpi-topline"><span>{label}</span><span className={`status-chip ${statusClass(status)}`}>{status}</span></div>
      <div className="kpi-value">{value}{unit ? <span>{unit}</span> : null}</div>
      <p>{detail}</p>
    </div>
  );
}

function MetricBars({ title, unit, points, getValue, baseline, formatValue }: {
  title: string; unit: string; points: TrendPoint[]; getValue: (point: TrendPoint) => number | null; baseline: number | null; formatValue: (value: number) => string;
}) {
  const values = points.map(getValue).filter((value): value is number => value !== null);
  const max = Math.max(...values, ...(baseline === null ? [] : [baseline]), 1);
  return (
    <section className="trend-block" aria-label={`${title}近7天趋势`}>
      <div className="section-line"><h3>{title}</h3><span>{baseline === null ? "基线 数据不足" : `基线 ${formatValue(baseline)} ${unit}`}</span></div>
      <div className="bar-chart">
        {points.map((point) => {
          const value = getValue(point);
          const height = value === null ? 12 : Math.max(12, Math.round((value / max) * 92));
          return (
            <div className="bar-column" key={`${title}-${point.date}`}>
              <span className={`bar-value ${value === null ? "missing-text" : ""}`}>{value === null ? "缺失" : formatValue(value)}</span>
              <div className={`bar ${value === null ? "bar-missing" : ""}`} style={{ height: `${height}px` }} aria-label={`${dateLabel(point.date)} ${value === null ? "缺失" : `${formatValue(value)} ${unit}`}`} />
              <span className="bar-date">{dateLabel(point.date)}</span>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function SleepPanel({ sleep }: { sleep: Snapshot["sleep"] }) {
  const actualHours = actualSleepHours(sleep);
  const hasStages = sleep.coreHours !== null && sleep.deepHours !== null && sleep.remHours !== null;
  const timelineHours = actualHours + (sleep.awakeMinutes ?? 0) / 60;
  const pct = (value: number) => `${Math.max(0, (value / Math.max(timelineHours, 0.01)) * 100)}%`;
  return (
    <section className="sleep-panel" aria-labelledby="sleep-title">
      <div className="section-heading">
        <div><p className="section-kicker">昨晚睡眠</p><h2 id="sleep-title">{actualHours.toFixed(1)} 小时</h2></div>
        <span className={`status-chip ${statusClass(sleep.status)}`}>{sleep.status}</span>
      </div>
      <div className="sleep-clock"><div><span>入睡</span><strong>{sleep.bedtime}</strong></div><div className="sleep-line" aria-hidden="true" /><div><span>起床</span><strong>{sleep.wakeTime}</strong></div></div>
      {hasStages ? (
        <>
          <div className="sleep-stages" aria-label="睡眠分期">
            <span className="stage-core" style={{ width: pct(sleep.coreHours ?? 0) }} /><span className="stage-deep" style={{ width: pct(sleep.deepHours ?? 0) }} />
            <span className="stage-rem" style={{ width: pct(sleep.remHours ?? 0) }} /><span className="stage-awake" style={{ width: pct((sleep.awakeMinutes ?? 0) / 60) }} />
          </div>
          <div className="stage-legend">
            <span><i className="dot core" />浅睡 <b>{(sleep.coreHours ?? 0).toFixed(1)}h</b></span><span><i className="dot deep" />深睡 <b>{Math.round((sleep.deepHours ?? 0) * 60)}m</b></span><span><i className="dot rem" />REM <b>{(sleep.remHours ?? 0).toFixed(1)}h</b></span>
          </div>
        </>
      ) : <p className="empty-inline">本次同步暂未返回睡眠分期。</p>}
      <div className="sleep-stats"><div><span>质量</span><strong>{numberLabel(sleep.quality)}</strong></div><div><span>效率</span><strong>{sleep.efficiency === null ? "—" : `${sleep.efficiency.toFixed(1)}%`}</strong></div><div><span>醒来</span><strong>{sleep.awakenings === null ? "—" : `${sleep.awakenings} 次`}</strong></div></div>
    </section>
  );
}

// Polls background sync tasks by their real lifecycle status instead of
// guessing with a fixed timer: agent sync tasks routinely take longer than
// the old 60-second blind poll, which is why finished syncs looked lost.
// Stops when every task reaches a terminal state (or after 5 minutes) and
// reports when a task ended without saving its snapshot.
function useTaskPolling() {
  const queryClient = useQueryClient();
  const [taskIds, setTaskIds] = useState<string[]>([]);
  const [failureNote, setFailureNote] = useState<string | null>(null);
  const syncing = taskIds.length > 0;

  useEffect(() => {
    if (taskIds.length === 0) return;
    let cancelled = false;
    const startedAt = Date.now();
    const timer = window.setInterval(() => {
      void (async () => {
        const results = await Promise.all(taskIds.map(async (taskId) => {
          try {
            return await api.getRefreshStatus({ taskId });
          } catch {
            return null;
          }
        }));
        if (cancelled) return;
        void queryClient.invalidateQueries({ queryKey: ["dashboard"] });
        // Only completed/failed settle the poll. unknown/not_found mean the
        // status endpoint cannot see the task yet — treating them as done
        // would silently drop a sync that is still running.
        const settled = results.every((result) => result !== null && (result.status === "completed" || result.status === "failed"));
        if (settled) {
          const failed = results.some((result) => result === null || result.status === "failed" || (result.status === "completed" && !result.contractSatisfied));
          setFailureNote(failed ? "同步未完成，请再点一次同步" : null);
          setTaskIds([]);
        } else if (Date.now() - startedAt > 5 * 60_000) {
          setFailureNote("同步超时，请再点一次同步");
          setTaskIds([]);
        }
      })();
    }, 4_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [queryClient, taskIds]);

  const startPolling = (ids: Array<string | null>) => {
    const next = ids.filter((id): id is string => id !== null);
    if (next.length === 0) return;
    setFailureNote(null);
    setTaskIds(next);
  };

  return { syncing, failureNote, startPolling };
}

type StrengthWeek = Snapshot["strengthTraining"]["weeklyTrend"][number];

// A week is comparable only when its whole-week coverage is confirmed
// (coverageComplete from the source's server-computed week summary), its
// measured-set count is recorded, and it contains no completed set missing
// weight or reps — bodyweight sets included, their load is not comparable.
// A week carrying counts without coverageComplete (older snapshot) is
// conservatively not comparable: its counts may come from a truncated
// sample, and comparing a partial volume against a real total would
// fabricate a percentage (e.g. a fake −100%).
function weekIsComparable(week: StrengthWeek | undefined): week is StrengthWeek {
  return week !== undefined
    && week.coverageComplete === true
    && week.measuredCompletedSets !== undefined
    && week.unmeasuredCompletedSets === 0;
}

// Why a pair of weeks cannot be compared, or null when they can. A week
// known to contain unmeasured completed sets means the load itself is
// incomplete; anything else (counts missing, whole-week coverage not yet
// confirmed) is reported as unconfirmed coverage.
function weekComparisonReason(current: StrengthWeek | undefined, previous: StrengthWeek | undefined): string | null {
  if (current === undefined || previous === undefined) return null;
  if (weekIsComparable(current) && weekIsComparable(previous)) return null;
  if ((current.unmeasuredCompletedSets ?? 0) > 0 || (previous.unmeasuredCompletedSets ?? 0) > 0) {
    return "部分已完成组缺重量或次数（含自重组），负荷不完整，周对比不计算百分比。";
  }
  return "整周覆盖尚未确认，周对比不计算百分比。";
}

function weekComparisonLabel(current: StrengthWeek | undefined, previous: StrengthWeek | undefined): string {
  if (current === undefined || previous === undefined) return "—";
  if (!weekIsComparable(current) || !weekIsComparable(previous)) return "无法比较";
  // Both weeks fully measured but last week is a genuine zero baseline:
  // there is no meaningful percentage, and it is not "无法比较" either.
  if (previous.volume === 0) return "—";
  const delta = Math.round(((current.volume - previous.volume) / previous.volume) * 100);
  return `${delta > 0 ? "+" : ""}${delta}%`;
}

function StrengthPanel({ strength, onSync, syncing }: { strength: Snapshot["strengthTraining"]; onSync: () => void; syncing: boolean }) {
  const workouts = [...strength.workouts].sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());
  const latest = workouts[0];
  const currentWeek = strength.weeklyTrend[strength.weeklyTrend.length - 1];
  const previousWeek = strength.weeklyTrend[strength.weeklyTrend.length - 2];
  const comparison = weekComparisonLabel(currentWeek, previousWeek);
  const comparisonReason = weekComparisonReason(currentWeek, previousWeek);
  // Tag beside 本周负荷: a week known to miss sets is 不完整; a week whose
  // whole-week coverage is merely unconfirmed is 未确认.
  const currentUnmeasured = currentWeek?.unmeasuredCompletedSets ?? 0;
  const currentWeekTag = currentWeek === undefined || weekIsComparable(currentWeek)
    ? null
    : currentUnmeasured > 0 ? "不完整" : "未确认";

  return (
    <section className="strength-panel" aria-labelledby="strength-title">
      <div className="section-heading">
        <div><p className="section-kicker">训练记录</p><h2 id="strength-title">力量训练</h2></div>
        <span className="record-count">{currentWeek?.sessions ?? 0} 次 / 本周</span>
      </div>
      <div className="strength-sync-row">
        <span>{strength.updatedAt ? `训练数据更新于 ${updatedLabel(strength.updatedAt)}` : "训练数据尚未同步"}</span>
        <button className="sync-button" type="button" aria-label="同步训练记录" onClick={onSync} disabled={syncing}>{syncing ? "同步中…" : "同步训练"}</button>
      </div>
      {latest ? (
        <>
          <div className="strength-latest">
            <div className={`routine-badge routine-${latest.routine}`}><span>{dateLabel(latest.date)}</span><strong>{ROUTINE_LABELS[latest.routine]}</strong></div>
            <div className="strength-primary"><span>{latest.status === "active" ? "当前已完成训练量" : "总训练量"}</span><strong>{volumeLabel(latest.totalVolume)} <small>{latest.unit}</small></strong><p>{latest.completedSets}/{latest.totalSets} 组 · {durationLabel(latest.durationMinutes)}</p></div>
          </div>
          <div className="strength-week">
            <div><span>本周负荷</span><strong>{volumeLabel(currentWeek?.volume ?? 0)} {strength.displayUnit}{currentWeekTag ? <small className="incomplete-tag">{currentWeekTag}</small> : null}</strong></div>
            <div><span>对比上周</span><strong>{comparison}</strong></div>
          </div>
          <p className="strength-note">{comparisonReason ?? "仅计算已完成且同时填写重量与次数的组。"}</p>
        </>
      ) : <p className="empty-inline">{strength.note}</p>}
    </section>
  );
}

type WhoopBand = "green" | "yellow" | "red" | "blue" | "slate";

interface WhoopScore {
  pct: number | null;
  display: string;
  band: WhoopBand;
  bandLabel: string;
  detail: string;
}

function percentBand(pct: number): WhoopBand {
  return pct >= 67 ? "green" : pct >= 34 ? "yellow" : "red";
}

function recoveryScore(readiness: Readiness | null): WhoopScore {
  if (!readiness || readiness.score === null) {
    return { pct: null, display: "—", band: "slate", bandLabel: "数据不足", detail: "信号不足，暂不评分" };
  }
  const pct = Math.round(readiness.score * 10);
  return {
    pct,
    display: String(pct),
    band: percentBand(pct),
    bandLabel: pct >= 67 ? "恢复良好" : pct >= 34 ? "恢复一般" : "需要恢复",
    detail: readiness.status,
  };
}

// H-UI-001 (rework): a sleep session counts as recorded only when the
// snapshot does not flag it missing and it has a positive actual duration.
// The server radar defaults the sleep dimension to 5 when both sleep
// components are missing, so the radar value is only honest when at least
// one of lastSleep / sleepBank carries a real component score.
function hasSleepSession(snapshot: Snapshot): boolean {
  return snapshot.sleep.status !== "数据缺失" && actualSleepHours(snapshot.sleep) > 0;
}

function sleepScore(snapshot: Snapshot, readiness: Readiness | null): WhoopScore {
  const hours = actualSleepHours(snapshot.sleep);
  const detail = `${hours.toFixed(1)} 小时 · ${snapshot.sleep.bedtime}–${snapshot.sleep.wakeTime}`;
  if (!hasSleepSession(snapshot)) {
    return { pct: null, display: "—", band: "slate", bandLabel: "数据不足", detail: "昨晚睡眠未记录" };
  }
  const radarSleep = readiness?.radar.find((dimension) => dimension.key === "sleep");
  const sleepSignalAvailable = (readiness?.components ?? []).some(
    (component) => (component.key === "lastSleep" || component.key === "sleepBank") && component.score !== null,
  );
  if (radarSleep && !sleepSignalAvailable) {
    return { pct: null, display: "—", band: "slate", bandLabel: "数据不足", detail: `${detail} · 睡眠信号不足` };
  }
  if (radarSleep) {
    const pct = Math.round(radarSleep.score * 10);
    return {
      pct,
      display: String(pct),
      band: percentBand(pct),
      bandLabel: pct >= 67 ? "睡眠充足" : pct >= 34 ? "睡眠一般" : "睡眠不足",
      detail,
    };
  }
  // Fallback without readiness: duration against the personal mean of the
  // stored sleep history (the same need estimate the server uses). Fewer
  // than 8 nights means no honest score.
  const history = snapshot.historySleeps.map((row) => row.totalHours);
  if (history.length >= 8) {
    const need = history.reduce((sum, value) => sum + value, 0) / history.length;
    const pct = Math.max(0, Math.min(100, Math.round((hours / Math.max(need, 0.1)) * 100)));
    return {
      pct,
      display: String(pct),
      band: percentBand(pct),
      bandLabel: pct >= 67 ? "睡眠充足" : pct >= 34 ? "睡眠一般" : "睡眠不足",
      detail,
    };
  }
  return { pct: null, display: "—", band: "slate", bandLabel: "数据不足", detail };
}

function strainScore(snapshot: Snapshot): WhoopScore {
  // H-UI-001 (rework): only the row dated exactly dataDate may be used —
  // never splice another date's exercise/energy with dataDate's steps —
  // and every input must be present: a missing item degrades the score to
  // 数据不足 (named in the detail) instead of silently counting as 0.
  // Real zeros are data, not missing: all three present at 0 scores 0.0.
  const row = snapshot.historyDaily.find((daily) => daily.date === snapshot.dataDate);
  if (!row) {
    return { pct: null, display: "—", band: "slate", bandLabel: "数据不足", detail: `${snapshot.dataDate} 的活动记录缺失` };
  }
  const exercise = row.exerciseMinutes ?? null;
  const kcal = row.activeKcal ?? null;
  const steps = snapshot.steps.value;
  const present = `运动 ${exercise === null ? "—" : `${Math.round(exercise)} 分钟`} · 活动 ${kcal === null ? "—" : `${Math.round(kcal)} kcal`} · ${steps === null ? "—" : `${numberLabel(steps)} 步`}`;
  const missing = [
    exercise === null ? "运动时长缺失" : null,
    kcal === null ? "活动能量缺失" : null,
    steps === null ? "步数缺失" : null,
  ].filter(Boolean).join("、");
  if (missing) {
    return { pct: null, display: "—", band: "slate", bandLabel: "数据不足", detail: `${present} · ${missing}` };
  }
  // Whoop-style 0–21 day strain, built only from recorded quantities:
  // exercise minutes up to 8 points, active energy up to 7, steps up to 6.
  const value = Math.min(exercise, 120) / 120 * 8
    + Math.min(kcal, 600) / 600 * 7
    + Math.min(steps, 12000) / 12000 * 6;
  const band: WhoopBand = value < 7 ? "blue" : value < 14 ? "green" : value < 18 ? "yellow" : "red";
  return {
    pct: Math.round((value / 21) * 100),
    display: value.toFixed(1),
    band,
    bandLabel: value < 7 ? "负荷较轻" : value < 14 ? "负荷适中" : value < 18 ? "负荷偏高" : "负荷过高",
    detail: present,
  };
}

function mondayOf(date: string): string {
  const parsed = new Date(`${date}T12:00:00Z`);
  const weekday = parsed.getUTCDay();
  parsed.setUTCDate(parsed.getUTCDate() + (weekday === 0 ? -6 : 1 - weekday));
  return parsed.toISOString().slice(0, 10);
}

function shiftDateStr(date: string, days: number): string {
  const parsed = new Date(`${date}T12:00:00Z`);
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

interface WeekLoadWindow {
  sessions: number;
  strengthSessions: number;
  healthKitSessions: number;
  durationMinutes: number | null;
  strengthDurationMinutes: number | null;
  healthKitDurationMinutes: number | null;
  strengthVolume: number;
}

interface WeekLoad {
  band: WhoopBand;
  verdict: string;
  detail: string;
  sufficient: boolean;
  reasons: string[];
  current: WeekLoadWindow;
  previous: WeekLoadWindow;
  sessionsChangePct: number | null;
  durationChangePct: number | null;
  volumeChangePct: number | null;
}

const LB_TO_KG = 0.45359237;

function volumeInDisplayUnit(volume: number, unit: "lb" | "kg", displayUnit: "lb" | "kg"): number {
  if (unit === displayUnit) return volume;
  return unit === "lb" ? volume * LB_TO_KG : volume / LB_TO_KG;
}

// H-LOAD-001 (rework): this week's load next to the recovery signals, with
// a three-tier verdict. Both windows are explicit same-span date ranges —
// this week mondayOf(dataDate)..dataDate and the same span shifted 7 days
// back — and every fact comes from session-level records: HealthKit
// workout sessions plus completed strength workouts from 训练记录, with
// HK strength sessions on a date that already has a completed strength
// workout counted once (the strength record wins). Any coverage gap in
// either window — a missing or duplicated daily row, an unsynced or
// partially measured strength week, a session without a duration — means
// no percentage and no verdict, never a guessed one. Percentages are only
// computed per metric when both windows are complete and last week's
// value is above zero.
function weekLoad(snapshot: Snapshot, readiness: Readiness | null): WeekLoad {
  const weekStart = mondayOf(snapshot.dataDate);
  const prevStart = shiftDateStr(weekStart, -7);
  const elapsedDays = Math.round((Date.parse(`${snapshot.dataDate}T12:00:00Z`) - Date.parse(`${weekStart}T12:00:00Z`)) / 86_400_000) + 1;
  const currentDates = Array.from({ length: elapsedDays }, (_, index) => shiftDateStr(weekStart, index));
  const previousDates = Array.from({ length: elapsedDays }, (_, index) => shiftDateStr(prevStart, index));
  const strength = snapshot.strengthTraining;
  const reasons: string[] = [];
  const addReason = (reason: string) => { if (!reasons.includes(reason)) reasons.push(reason); };

  if (snapshot.coverageIncomplete) addReason("健康数据还没同步完");

  // Daily coverage: every enumerated date in both windows must appear in
  // historyDaily exactly once.
  const dailyCounts = new Map<string, number>();
  for (const row of snapshot.historyDaily) dailyCounts.set(row.date, (dailyCounts.get(row.date) ?? 0) + 1);
  const checkDaily = (dates: string[], label: string) => {
    const missing = dates.filter((date) => !dailyCounts.has(date));
    if (missing.length) addReason(`${label}每日记录缺 ${missing.join("、")}`);
    const duplicated = dates.filter((date) => (dailyCounts.get(date) ?? 0) > 1);
    if (duplicated.length) addReason(`${label}每日记录 ${duplicated.join("、")} 重复`);
  };
  checkDaily(currentDates, "本周");
  checkDaily(previousDates, "上周同期");

  // Strength completeness per window week: the weeklyTrend entry for the
  // week the window starts in must exist, carry confirmed whole-week
  // coverage and both set counts, contain no unmeasured completed set, and
  // agree with the workouts list on the whole week's completed sessions —
  // otherwise the (capped) list cannot prove the window is complete.
  if (strength.updatedAt === null) {
    addReason("力量训练尚未同步");
  } else {
    const checkStrengthWeek = (start: string, label: string) => {
      const week = strength.weeklyTrend.find((entry) => entry.weekStart === start);
      if (!week) { addReason(`${label}力量周汇总缺失`); return; }
      if (week.coverageComplete !== true) addReason(`${label}力量整周覆盖未确认`);
      if (week.measuredCompletedSets === undefined || week.unmeasuredCompletedSets === undefined) {
        addReason(`${label}力量已完成组计数缺失`);
      } else if (week.unmeasuredCompletedSets > 0) {
        addReason("部分已完成组缺重量或次数，负荷不完整");
      }
      const weekEnd = shiftDateStr(start, 6);
      const listed = strength.workouts.filter((workout) => workout.status === "completed" && workout.date >= start && workout.date <= weekEnd).length;
      if (listed !== week.sessions) addReason("力量训练列表与整周汇总不一致，无法证明同窗完整");
    };
    checkStrengthWeek(weekStart, "本周");
    checkStrengthWeek(prevStart, "上周");
  }

  const windowFacts = (dates: string[], label: string): WeekLoadWindow => {
    const inWindow = new Set(dates);
    const strengthDone = strength.workouts.filter((workout) => workout.status === "completed" && inWindow.has(workout.date));
    const strengthDates = new Set(strengthDone.map((workout) => workout.date));
    const hkKept = snapshot.historyWorkouts.filter((session) => inWindow.has(session.date)
      && !(session.type.toLowerCase().includes("strength") && strengthDates.has(session.date)));
    const strengthDuration = strengthDone.some((workout) => workout.durationMinutes === null)
      ? null
      : strengthDone.reduce((sum, workout) => sum + (workout.durationMinutes ?? 0), 0);
    if (strengthDuration === null) addReason(`${label}有力量场次时长缺失，时长不完整`);
    const hkDuration = hkKept.some((session) => session.durationMinutes === null)
      ? null
      : hkKept.reduce((sum, session) => sum + (session.durationMinutes ?? 0), 0);
    if (hkDuration === null) addReason(`${label}有训练时长缺失，时长不完整`);
    return {
      sessions: strengthDone.length + hkKept.length,
      strengthSessions: strengthDone.length,
      healthKitSessions: hkKept.length,
      durationMinutes: strengthDuration === null || hkDuration === null ? null : strengthDuration + hkDuration,
      strengthDurationMinutes: strengthDuration,
      healthKitDurationMinutes: hkDuration,
      strengthVolume: strengthDone.reduce((sum, workout) => sum + volumeInDisplayUnit(workout.totalVolume, workout.unit, strength.displayUnit), 0),
    };
  };
  const current = windowFacts(currentDates, "本周");
  const previous = windowFacts(previousDates, "上周同期");

  const sufficient = reasons.length === 0;
  const pctChange = (now: number, before: number): number | null => (sufficient && before > 0 ? ((now - before) / before) * 100 : null);
  const sessionsChangePct = pctChange(current.sessions, previous.sessions);
  const durationChangePct = current.durationMinutes !== null && previous.durationMinutes !== null
    ? pctChange(current.durationMinutes, previous.durationMinutes)
    : null;
  const volumeChangePct = pctChange(current.strengthVolume, previous.strengthVolume);
  const facts = { sufficient, reasons, current, previous, sessionsChangePct, durationChangePct, volumeChangePct };

  const recovery = recoveryScore(readiness);
  const hrvZ = readiness?.components.find((component) => component.key === "hrv")?.zScore ?? null;
  const restingZ = readiness?.components.find((component) => component.key === "restingHr")?.zScore ?? null;
  const debt = readiness?.sleepDebtHours ?? null;
  const pctText = (value: number) => `${value > 0 ? "+" : ""}${Math.round(value)}%`;
  const factsDetail = (withPct: boolean): string => {
    const durationNote = !withPct ? ""
      : durationChangePct !== null ? `（时长较上周同期 ${pctText(durationChangePct)}）`
      : previous.durationMinutes === 0 ? "（上周同期时长为 0，不算百分比）" : "";
    const volumeNote = !withPct ? ""
      : volumeChangePct !== null ? `（容量较上周同期 ${pctText(volumeChangePct)}）`
      : previous.strengthVolume === 0 ? "（上周同期容量为 0，不算百分比）" : "";
    return [
      `本周训练 ${current.sessions} 次 · ${current.durationMinutes === null ? "时长不完整" : `${Math.round(current.durationMinutes)} 分钟`}${durationNote}`,
      `上周同期 ${previous.sessions} 次 · ${previous.durationMinutes === null ? "时长不完整" : `${Math.round(previous.durationMinutes)} 分钟`}`,
      `力量 ${current.strengthSessions} 次 · 容量 ${volumeLabel(current.strengthVolume)} ${strength.displayUnit}${volumeNote}`,
      `恢复 ${recovery.display === "—" ? "—" : `${recovery.display}%`}${debt === null ? "" : ` · 睡眠债 ${debt.toFixed(1)}h`}`,
    ].join(" · ");
  };

  if (!sufficient) {
    const knownParts = [
      `本周已知训练 ${current.sessions} 次`,
      current.durationMinutes === null ? "本周时长不完整" : `本周时长 ${Math.round(current.durationMinutes)} 分钟`,
    ];
    if (strength.updatedAt !== null) knownParts.push(`力量 ${current.strengthSessions} 次 · 容量 ${volumeLabel(current.strengthVolume)} ${strength.displayUnit}`);
    knownParts.push(`数据不足：${reasons.join("；")}`);
    return { band: "slate", verdict: `数据不足：${reasons[0] ?? "覆盖不完整"}`, detail: knownParts.join(" · "), ...facts };
  }
  if (!readiness || readiness.score === null) {
    return { band: "slate", verdict: "恢复数据不足，先不下结论", detail: factsDetail(false), ...facts };
  }
  const detail = factsDetail(true);
  const recoveryWorsening = (hrvZ !== null && hrvZ < 0) || (restingZ !== null && restingZ < 0);
  if (readiness.score < 2
    || (hrvZ !== null && restingZ !== null && hrvZ <= -1 && restingZ <= -0.5)
    || (debt !== null && debt >= 5)
    || (durationChangePct !== null && durationChangePct >= 40 && recoveryWorsening)) {
    return { band: "red", verdict: "该歇了：恢复跟不上，今天休息或只做轻活动", detail, ...facts };
  }
  if ((durationChangePct !== null && durationChangePct >= 20)
    || (hrvZ !== null && hrvZ <= -0.5)
    || (debt !== null && debt >= 3)) {
    return { band: "yellow", verdict: "负荷偏高：今天降强度、早点睡", detail, ...facts };
  }
  if (readiness.confidence === "低") {
    return { band: "slate", verdict: "恢复置信度低，先不下结论", detail, ...facts };
  }
  return { band: "green", verdict: "状态稳定，可以按计划训练", detail, ...facts };
}

function ScoreRing({ label, score, suffix, bandKind }: { label: string; score: WhoopScore; suffix: string; bandKind: "recovery" | "strain" }) {
  const radius = 40;
  const circumference = 2 * Math.PI * radius;
  const filled = score.pct === null ? 0 : score.pct / 100;
  return (
    <div className={`whoop-score whoop-${score.band}`}>
      <div className="whoop-ring" role="img" aria-label={`${label} ${score.display}${suffix}，${score.bandLabel}。${score.detail}`}>
        <svg viewBox="0 0 96 96" aria-hidden="true">
          <circle className="whoop-ring-track" cx="48" cy="48" r={radius} />
          <circle className="whoop-ring-value" cx="48" cy="48" r={radius} strokeDasharray={circumference} strokeDashoffset={circumference * (1 - filled)} />
        </svg>
        <div className="whoop-ring-center"><strong>{score.display}</strong><span>{suffix}</span></div>
      </div>
      <span className="whoop-score-label">{label}</span>
      <span className="whoop-band-label">{score.bandLabel}</span>
      <div className={`whoop-band ${bandKind === "strain" ? "whoop-band-strain" : ""}`} aria-hidden="true">{score.pct === null ? null : <i style={{ left: `${score.pct}%` }} />}</div>
      <p>{score.detail}</p>
    </div>
  );
}

function WhoopHero({ snapshot, readiness }: { snapshot: Snapshot; readiness: Readiness | null }) {
  const recovery = recoveryScore(readiness);
  const sleep = sleepScore(snapshot, readiness);
  const strain = strainScore(snapshot);
  const load = weekLoad(snapshot, readiness);
  const sleepHours = actualSleepHours(snapshot.sleep);
  return (
    <section className="whoop-hero" aria-labelledby="whoop-title">
      <div className="whoop-head">
        <div>
          <p className="whoop-kicker">{dateLabel(readiness?.date ?? snapshot.dataDate)} · 今日状态</p>
          <h1 id="whoop-title">{readiness ? readiness.status : "数据不足"}</h1>
        </div>
        {readiness ? <span className="whoop-confidence">置信度{readiness.confidence} · {readiness.signalCount} 项信号</span> : null}
      </div>
      <p className="whoop-summary">{readiness?.summary ?? "至少需要两项具备历史基线的信号才能评分。"}</p>
      <div className="whoop-scores">
        <ScoreRing label="恢复" score={recovery} suffix="%" bandKind="recovery" />
        <ScoreRing label="睡眠" score={sleep} suffix="%" bandKind="recovery" />
        <ScoreRing label="负荷" score={strain} suffix="/ 21" bandKind="strain" />
      </div>
      <div className="whoop-drivers">
        <div><span>HRV</span><strong>{snapshot.hrv.value === null ? "—" : `${numberLabel(snapshot.hrv.value, 1)} ms`}</strong></div>
        <div><span>静息心率</span><strong>{snapshot.restingHr.value === null ? "—" : `${numberLabel(snapshot.restingHr.value, 1)} bpm`}</strong></div>
        <div><span>昨晚睡眠</span><strong>{hasSleepSession(snapshot) ? `${sleepHours.toFixed(1)} h` : "—"}</strong></div>
        <div><span>睡眠债</span><strong>{readiness?.sleepDebtHours === null || readiness?.sleepDebtHours === undefined ? "—" : `${readiness.sleepDebtHours.toFixed(1)} h`}</strong></div>
      </div>
      <div className={`whoop-load whoop-${load.band}`}>
        <div className="whoop-load-head"><span>本周负荷 vs 恢复</span><strong>{load.verdict}</strong></div>
        <p>{load.detail}</p>
        <p className="whoop-load-note">负荷分只取数据日期当天的运动时长、活动能量与步数，三项齐全时才换算（0–21），缺任一项显示数据不足；睡眠缺失时不评分。恢复与睡眠分沿用原有基线评分，只换了呈现方式。</p>
      </div>
    </section>
  );
}

function ReadinessPanel({ readiness, compact = false }: { readiness: Readiness; compact?: boolean }) {
  const queryClient = useQueryClient();
  const [feeling, setFeeling] = useState(readiness.morningFeeling ?? 5);
  useEffect(() => setFeeling(readiness.morningFeeling ?? 5), [readiness.morningFeeling]);
  const saveFeeling = useMutation({
    mutationFn: () => api.saveMorningCheckin({ date: readiness.date, feeling }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["dashboard"] }),
  });
  const scoreStyle = { "--readiness-score": (readiness.score ?? 0) * 10 } as CSSProperties;
  return (
    <section className="readiness-panel">
      {compact ? (
        <div className="readiness-compact-head">
          <p className="section-kicker">恢复详情</p>
          <span>{readiness.status} · {readiness.score ?? "—"}/10 · 置信度{readiness.confidence}</span>
        </div>
      ) : null}
      {compact ? null : (
      <div className="readiness-score-wrap">
        <div className={`readiness-ring readiness-${readiness.status}`} style={scoreStyle} role="img" aria-label={readiness.score === null ? "身体准备度数据不足" : `身体准备度 ${readiness.score} 分，满分 10 分`}>
          <div><strong>{readiness.score ?? "—"}</strong><span>/ 10</span></div>
        </div>
        <div className="readiness-copy">
          <div className="readiness-meta"><p className="section-kicker">身体准备度 · {dateLabel(readiness.date)}</p><span className={`confidence confidence-${readiness.confidence}`}>置信度{readiness.confidence} · {readiness.signalCount} 项</span></div>
          <h2 id="readiness-title">{readiness.status}</h2>
          <p>{readiness.summary}</p>
          {readiness.sleepDebtHours !== null ? <p className="sleep-debt">7 天睡眠债 <strong>{readiness.sleepDebtHours.toFixed(1)}h</strong></p> : null}
        </div>
      </div>
      )}

      <div className="readiness-radar" aria-label="睡眠、恢复、运动、心肺、生命体征五维雷达图">
        <ResponsiveContainer width="100%" height="100%">
          <RadarChart data={readiness.radar} outerRadius="68%">
            <PolarGrid stroke="var(--grid)" />
            <PolarAngleAxis dataKey="label" tick={{ fill: "var(--dim)", fontSize: 10 }} />
            <Radar dataKey="score" stroke="var(--accent)" fill="var(--accent)" fillOpacity={0.2} strokeWidth={2} />
          </RadarChart>
        </ResponsiveContainer>
      </div>

      <form className="morning-checkin" onSubmit={(event) => { event.preventDefault(); saveFeeling.mutate(); }}>
        <div><label htmlFor="morning-feeling">今天感觉</label><output htmlFor="morning-feeling">{feeling}/10</output></div>
        <input id="morning-feeling" aria-label="今天感觉 1 到 10" type="range" min="1" max="10" step="1" value={feeling} onChange={(event) => setFeeling(Number(event.target.value))} />
        <button type="submit" disabled={saveFeeling.isPending}>{saveFeeling.isPending ? "保存中…" : readiness.morningFeeling === null ? "保存晨检" : "更新晨检"}</button>
        <p>{saveFeeling.isSuccess ? "已保存；感觉好不会上调客观分，感觉差只会保守下调。" : "只向保守方向修正客观分。"}</p>
      </form>

      {readiness.adjustments.length ? <div className="readiness-adjustments" aria-label="保守修正规则">{readiness.adjustments.map((item) => <p key={item}>{item}</p>)}</div> : null}

      <details className="readiness-drivers">
        <summary>谁在拉分</summary>
        <div className="readiness-components" aria-label="身体准备度组成">
          {readiness.components.map((component) => (
            <div className="readiness-component" key={component.key}>
              <div><span>{component.label}</span><small>原权重 {component.weight}%</small></div>
              <strong>{component.score ?? "—"}</strong>
              <dl><div><dt>原始值</dt><dd>{component.raw}</dd></div><div><dt>滚动基线</dt><dd>{component.baseline}</dd></div><div><dt>贡献</dt><dd>{component.contribution === null ? "未纳入" : `${component.contribution > 0 ? "+" : ""}${component.contribution.toFixed(2)} z`}</dd></div></dl>
              <p>{component.missingLabel ? <span className="missing-pill">{component.missingLabel}</span> : null}{component.detail}</p>
            </div>
          ))}
        </div>
      </details>
      <details className="readiness-method">
        <summary>评分方法</summary>
        <p>总分 = 5 + 2.0 × 加权平均 z，钳制到 0–10。HRV 32.5%（先取 ln）、静息心率 25%、昨晚睡眠 10%、7 天睡眠银行 10%、训练负荷 15%、呼吸频率 5%；呼吸只在升高时扣分。每项至少有 8 个历史读数才纳入；缺项权重按可用信号重新归一化。睡眠按时长 50 / 就寝规律 30 / 中断 20 评分。</p>
        <p>HRV 被压制且静息心率升高，或睡眠债超过 3 小时，都会直接降一档。腕温不纳入。分数看趋势不看单日；静息心率是跨设备最准的指标。这只是健康参考，不做诊断，身体不适请及时看医生。</p>
      </details>
    </section>
  );
}

function ageLabel(minutes: number | null): string {
  if (minutes === null) return "尚未同步";
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)} 小时前`;
  return `${Math.floor(minutes / (24 * 60))} 天前`;
}

function freshnessLabel(freshness: DataStatus["health"]["freshness"]): string {
  if (freshness === "fresh") return "新鲜";
  if (freshness === "today") return "今天更新";
  if (freshness === "stale") return "已过期";
  return "还没有";
}

function DataStatusPanel({ dataStatus, unifiedTimeline, displayUnit }: { dataStatus: DataStatus | null; unifiedTimeline: UnifiedDay[]; displayUnit: string }) {
  const queryClient = useQueryClient();
  const [diag, setDiag] = useState<{ verdict: string; checks: Array<{ key: string; label: string; ok: boolean; detail: string }> } | null>(null);
  const diagnose = useMutation({
    mutationFn: () => api.getSyncDiagnostics({}),
    onSuccess: (result) => {
      setDiag({ verdict: result.verdict, checks: result.checks });
      void queryClient.invalidateQueries({ queryKey: ["dashboard"] });
    },
  });
  if (!dataStatus) return null;
  const rows = [dataStatus.health, dataStatus.strength];
  return (
    <section className="data-status-panel" aria-labelledby="data-status-title">
      <div className="section-heading">
        <div><p className="section-kicker">数据一体 · 状态</p><h2 id="data-status-title">数据状态</h2></div>
        <span className={`status-chip ${dataStatus.overall === "ok" ? "status-ok" : dataStatus.overall === "empty" ? "status-missing" : "status-watch"}`}>{dataStatus.overallLabel}</span>
      </div>
      <div className="data-status-rows">
        {rows.map((row) => (
          <div className="data-status-row" key={row.source}>
            <div><strong>{row.label}</strong><span>{row.detail}</span></div>
            <div className="data-status-meta"><span className={`status-chip ${row.freshness === "fresh" || row.freshness === "today" ? "status-ok" : row.freshness === "stale" ? "status-watch" : "status-missing"}`}>{freshnessLabel(row.freshness)}</span><small>{row.updatedAt ? `${updatedLabel(row.updatedAt)} · ${ageLabel(row.ageMinutes)}` : "尚未同步"}</small></div>
          </div>
        ))}
      </div>
      <div className="data-status-actions">
        <button className="sync-button" type="button" aria-label="检查数据状态" onClick={() => diagnose.mutate()} disabled={diagnose.isPending}>{diagnose.isPending ? "检查中…" : "一键体检"}</button>
        <span>失败不再静默：每次保存和失败都会记进下面的台账。</span>
      </div>
      {diag ? (
        <div className="diagnostics-box" role="status">
          <p><strong>{diag.verdict}</strong></p>
          <ul>{diag.checks.map((check) => <li key={check.key}><span aria-hidden="true">{check.ok ? "✓" : "!"}</span><div><strong>{check.label}</strong><small>{check.detail}</small></div></li>)}</ul>
        </div>
      ) : null}
      {dataStatus.recentLogs.length ? (
        <details className="sync-log-details">
          <summary>同步台账 · 最近 {dataStatus.recentLogs.length} 条</summary>
          <div className="sync-log-list">
            {dataStatus.recentLogs.map((log) => (
              <div className="sync-log-row" key={log.id}>
                <span className={`status-chip ${log.status === "saved" ? "status-ok" : log.status === "failed" ? "status-watch" : "status-missing"}`}>{log.status === "saved" ? "已保存" : log.status === "failed" ? "失败" : "体检"}</span>
                <div><strong>{log.source === "health" ? "Apple 健康" : log.source === "strength" ? "训练记录" : "系统"}</strong><small>{log.note}</small></div>
                <time>{updatedLabel(log.createdAt)}</time>
              </div>
            ))}
          </div>
        </details>
      ) : <p className="empty-inline">台账还是空的：下一次同步保存后，这里会留下第一条记录，之后每次成功或失败都能查到。</p>}
      {unifiedTimeline.length ? (
        <div className="unified-timeline" aria-label="统一时间线">
          <h3>统一时间线 · 最近 {Math.min(unifiedTimeline.length, 7)} 天</h3>
          <div className="unified-list">
            {unifiedTimeline.slice(0, 7).map((day) => (
              <div className="unified-row" key={day.date}>
                <span className="unified-date">{dateLabel(day.date)}</span>
                <div className="unified-main">
                  <strong>{day.steps === null ? "步数 —" : `${numberLabel(day.steps)} 步`}{day.sleepHours !== null ? ` · 睡 ${day.sleepHours.toFixed(1)}h` : ""}</strong>
                  <small>{day.hasStrength ? `力量 ${day.strengthSessions} 次 · ${volumeLabel(day.strengthVolume)} ${displayUnit} · ${day.strengthRoutines.map((r) => ROUTINE_LABELS[r as StrengthWorkout["routine"]] ?? r).join("、")}` : "当天没有力量训练"}{day.restingHr !== null ? ` · 静息 ${day.restingHr.toFixed(0)} bpm` : ""}{day.hrvMs !== null ? ` · HRV ${day.hrvMs.toFixed(0)} ms` : ""}</small>
                </div>
                <span className={`unified-badge ${day.hasHealth && day.hasStrength ? "both" : ""}`}>{day.hasHealth && day.hasStrength ? "两边都有" : day.hasStrength ? "只有力量" : "只有健康"}</span>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </section>
  );
}

function TodayView({ snapshot, readiness, onSyncStrength, strengthSyncing, dataStatus, unifiedTimeline }: { snapshot: Snapshot; readiness: Readiness | null; onSyncStrength: () => void; strengthSyncing: boolean; dataStatus: DataStatus | null; unifiedTimeline: UnifiedDay[] }) {
  const missing = [snapshot.restingHr.value === null ? "静息心率" : null, snapshot.hrv.value === null ? "HRV" : null].filter(Boolean).join("、");
  const stepsBaselineIncomplete = snapshot.steps.baseline === null || snapshot.steps.usualMin === null || snapshot.steps.usualMax === null || snapshot.steps.status === "数据缺失";
  const stepSummary = snapshot.steps.value === null ? "步数未记录" : stepsBaselineIncomplete ? "基线不足，无法比较" : snapshot.steps.status === "正常" ? "步数在常见范围" : `步数${snapshot.steps.status}`;
  const stepStatus: Status = snapshot.steps.value === null ? "数据缺失" : stepsBaselineIncomplete ? "基线不足" : snapshot.steps.status;
  const sleepHours = actualSleepHours(snapshot.sleep);
  return (
    <div className="today-view">
      <WhoopHero snapshot={snapshot} readiness={readiness} />
      {readiness ? <ReadinessPanel readiness={readiness} compact /> : null}
      <section className="verdict" aria-labelledby="verdict-title">
        <p>昨日概览</p>
        <h1 id="verdict-title"><span>{numberLabel(snapshot.steps.value)}</span> 步，{stepSummary}；睡眠 <em>{sleepHours.toFixed(1)} 小时</em>。</h1>
        {missing ? <div className="missing-note"><span aria-hidden="true" />{snapshot.dataDate} {missing}无记录 · {snapshot.coverageIncomplete ? "还没同步完" : "当天没戴表"}</div> : null}
      </section>
      <section className="kpi-board" aria-label="关键健康指标">
        <Kpi label="步数" value={numberLabel(snapshot.steps.value)} detail={snapshot.steps.baseline === null ? `基线数据不足 · ${snapshot.steps.distanceKm?.toFixed(2) ?? "—"} km` : `基线约 ${numberLabel(snapshot.steps.baseline)} · ${snapshot.steps.distanceKm?.toFixed(2) ?? "—"} km`} status={stepStatus} />
        <Kpi label="静息心率" value={numberLabel(snapshot.restingHr.value, 1)} unit="bpm" detail={`基线约 ${snapshot.restingHr.baseline} · 常见 ${snapshot.restingHr.usualMin}–${snapshot.restingHr.usualMax}`} status={snapshot.restingHr.status} />
        <Kpi label="HRV" value={numberLabel(snapshot.hrv.value, 1)} unit="ms" detail={`基线约 ${snapshot.hrv.baseline} · 常见 ${snapshot.hrv.usualMin}–${snapshot.hrv.usualMax}`} status={snapshot.hrv.status} />
        <Kpi label="睡眠" value={sleepHours.toFixed(1)} unit="h" detail={`质量 ${numberLabel(snapshot.sleep.quality)} · 效率 ${snapshot.sleep.efficiency?.toFixed(1) ?? "—"}%`} status={snapshot.sleep.status} />
      </section>
      <StrengthPanel strength={snapshot.strengthTraining} onSync={onSyncStrength} syncing={strengthSyncing} />
      <DataStatusPanel dataStatus={dataStatus} unifiedTimeline={unifiedTimeline} displayUnit={snapshot.strengthTraining.displayUnit} />
      {snapshot.morningReference ? (
        <section className="morning-strip" aria-label="今晨参考">
          <div><span>今晨参考 · {dateLabel(snapshot.morningReference.date)}</span><strong>HRV {numberLabel(snapshot.morningReference.hrvMs, 1)} ms</strong></div>
          <div><span>平均心率</span><strong>{numberLabel(snapshot.morningReference.avgHrBpm, 1)} bpm</strong></div>
          <p>今日数据仍在累计，不与完整日比较。</p>
        </section>
      ) : null}
      <SleepPanel sleep={snapshot.sleep} />
      <section className="workout-line" aria-label="运动记录"><div><span>近7天运动</span><strong>{snapshot.workouts.count7d} 次</strong></div><p>{snapshot.workouts.note}</p></section>
    </div>
  );
}

function ChartPanel({ eyebrow, title, children }: { eyebrow: string; title: string; children: ReactNode }) {
  return <section className="chart-panel"><div className="chart-title"><span>{eyebrow}</span><h2>{title}</h2></div><div className="chart-frame">{children}</div></section>;
}

const tooltipStyle = { background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 8, fontSize: 12 };

function TrendsView({ snapshot }: { snapshot: Snapshot }) {
  const history = useMemo(() => snapshot.historyDaily.slice(-30).map((row) => ({ ...row, label: dateLabel(row.date) })), [snapshot.historyDaily]);
  return (
    <div className="trends-view">
      <section className="trends" aria-labelledby="trends-title">
        <div className="section-heading"><div><p className="section-kicker">近7天</p><h2 id="trends-title">短期趋势</h2></div><span className="trend-range">{dateLabel(snapshot.trends[0]?.date ?? snapshot.dataDate)}–{dateLabel(snapshot.trends[snapshot.trends.length - 1]?.date ?? snapshot.dataDate)}</span></div>
        <MetricBars title="步数" unit="步" points={snapshot.trends} getValue={(point) => point.stepCount} baseline={snapshot.steps.baseline} formatValue={(value) => Math.round(value).toLocaleString("zh-CN")} />
        <MetricBars title="静息心率" unit="bpm" points={snapshot.trends} getValue={(point) => point.restingHrBpm} baseline={snapshot.restingHr.baseline} formatValue={(value) => value.toFixed(value % 1 === 0 ? 0 : 1)} />
        <MetricBars title="HRV" unit="ms" points={snapshot.trends} getValue={(point) => point.hrvMs} baseline={snapshot.hrv.baseline} formatValue={(value) => value.toFixed(value % 1 === 0 ? 0 : 1)} />
      </section>

      <section className="strength-trend-section" aria-labelledby="strength-trend-title">
        <div className="history-intro"><p className="section-kicker">训练记录</p><h2 id="strength-trend-title">每周力量负荷</h2><p>按周汇总已完成组的重量 × 次数。</p></div>
        {snapshot.strengthTraining.weeklyTrend.length ? (
          <ChartPanel eyebrow={`总训练量 · ${snapshot.strengthTraining.displayUnit}`} title="周训练趋势">
            <ResponsiveContainer width="100%" height="100%"><BarChart data={snapshot.strengthTraining.weeklyTrend.map((week) => ({ ...week, label: dateLabel(week.weekStart) }))} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}><CartesianGrid stroke="var(--grid)" vertical={false} /><XAxis dataKey="label" tickLine={false} axisLine={false} tick={{ fill: "var(--dim)", fontSize: 10 }} /><YAxis domain={[0, "auto"]} width={50} tickLine={false} axisLine={false} tick={{ fill: "var(--dim)", fontSize: 10 }} /><Tooltip contentStyle={tooltipStyle} /><Bar dataKey="volume" name="训练量" unit={` ${snapshot.strengthTraining.displayUnit}`} fill="var(--strength)" radius={[3,3,0,0]} /></BarChart></ResponsiveContainer>
          </ChartPanel>
        ) : <p className="empty-inline">完成训练记录并同步后，这里会按周显示训练量趋势。</p>}
      </section>

      {history.length ? (
        <section className="history-charts" aria-labelledby="history-charts-title">
          <div className="history-intro"><p className="section-kicker">近30天</p><h2 id="history-charts-title">每日明细</h2><p>缺失值保留为空白，不按 0 计算。</p></div>
          <div className="chart-grid">
            <ChartPanel eyebrow="步数 · 左轴（步）" title="日活动量">
              <ResponsiveContainer width="100%" height="100%"><AreaChart data={history} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}><CartesianGrid stroke="var(--grid)" vertical={false} /><XAxis dataKey="label" interval="preserveStartEnd" tickLine={false} axisLine={false} tick={{ fill: "var(--dim)", fontSize: 10 }} /><YAxis domain={[0, "auto"]} width={46} tickLine={false} axisLine={false} tick={{ fill: "var(--dim)", fontSize: 10 }} /><Tooltip contentStyle={tooltipStyle} /><Area type="monotone" dataKey="steps" name="步数" unit=" 步" stroke="var(--accent)" fill="var(--accent-fade)" strokeWidth={2.25} connectNulls={false} /></AreaChart></ResponsiveContainer>
            </ChartPanel>
            <ChartPanel eyebrow="左轴 kcal · 右轴 分钟" title="活动能量与运动时间">
              <ResponsiveContainer width="100%" height="100%"><LineChart data={history} margin={{ top: 8, right: 0, left: 0, bottom: 0 }}><CartesianGrid stroke="var(--grid)" vertical={false} /><XAxis dataKey="label" interval="preserveStartEnd" tickLine={false} axisLine={false} tick={{ fill: "var(--dim)", fontSize: 10 }} /><YAxis yAxisId="kcal" domain={[0, "auto"]} width={42} tickLine={false} axisLine={false} tick={{ fill: "var(--dim)", fontSize: 10 }} /><YAxis yAxisId="minutes" orientation="right" domain={[0, "auto"]} width={34} tickLine={false} axisLine={false} tick={{ fill: "var(--dim)", fontSize: 10 }} /><Tooltip contentStyle={tooltipStyle} /><Line yAxisId="kcal" type="monotone" dataKey="activeKcal" name="活动能量" unit=" kcal" stroke="var(--amber)" strokeWidth={2} dot={false} connectNulls={false} /><Line yAxisId="minutes" type="monotone" dataKey="exerciseMinutes" name="运动时间" unit=" 分钟" stroke="var(--accent)" strokeWidth={2} dot={false} connectNulls={false} /></LineChart></ResponsiveContainer>
            </ChartPanel>
            <ChartPanel eyebrow="左轴 bpm · 右轴 ms" title="静息心率与 HRV">
              <ResponsiveContainer width="100%" height="100%"><LineChart data={history} margin={{ top: 8, right: 0, left: 0, bottom: 0 }}><CartesianGrid stroke="var(--grid)" vertical={false} /><XAxis dataKey="label" interval="preserveStartEnd" tickLine={false} axisLine={false} tick={{ fill: "var(--dim)", fontSize: 10 }} /><YAxis yAxisId="hr" domain={["dataMin - 3", "dataMax + 3"]} width={34} tickLine={false} axisLine={false} tick={{ fill: "var(--dim)", fontSize: 10 }} /><YAxis yAxisId="hrv" orientation="right" domain={["dataMin - 5", "dataMax + 5"]} width={34} tickLine={false} axisLine={false} tick={{ fill: "var(--dim)", fontSize: 10 }} /><Tooltip contentStyle={tooltipStyle} /><Line yAxisId="hr" type="linear" dataKey="restingHr" name="静息心率" unit=" bpm" stroke="var(--amber)" strokeWidth={2} dot={false} connectNulls={false} /><Line yAxisId="hrv" type="linear" dataKey="hrvMs" name="HRV" unit=" ms" stroke="var(--accent)" strokeWidth={2} dot={false} connectNulls={false} /></LineChart></ResponsiveContainer>
            </ChartPanel>
            <ChartPanel eyebrow="游泳 · 米" title="每日游泳距离">
              <ResponsiveContainer width="100%" height="100%"><BarChart data={history} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}><CartesianGrid stroke="var(--grid)" vertical={false} /><XAxis dataKey="label" interval="preserveStartEnd" tickLine={false} axisLine={false} tick={{ fill: "var(--dim)", fontSize: 10 }} /><YAxis domain={[0, "auto"]} width={42} tickLine={false} axisLine={false} tick={{ fill: "var(--dim)", fontSize: 10 }} /><Tooltip contentStyle={tooltipStyle} /><Bar dataKey="swimMeters" name="游泳距离" unit=" 米" fill="var(--blue)" radius={[3,3,0,0]} /></BarChart></ResponsiveContainer>
            </ChartPanel>
            <ChartPanel eyebrow="体重 · kg" title="称重记录">
              <ResponsiveContainer width="100%" height="100%"><LineChart data={history} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}><CartesianGrid stroke="var(--grid)" vertical={false} /><XAxis dataKey="label" interval="preserveStartEnd" tickLine={false} axisLine={false} tick={{ fill: "var(--dim)", fontSize: 10 }} /><YAxis domain={["dataMin - 0.5", "dataMax + 0.5"]} width={42} tickLine={false} axisLine={false} tick={{ fill: "var(--dim)", fontSize: 10 }} /><Tooltip contentStyle={tooltipStyle} /><Line type="linear" dataKey="weightKg" name="体重" unit=" kg" stroke="var(--blue)" strokeWidth={2.25} dot={{ r: 3 }} connectNulls={false} /></LineChart></ResponsiveContainer>
            </ChartPanel>
          </div>
        </section>
      ) : <p className="empty-inline">完成一次同步后，这里会显示近30天每日趋势。</p>}
    </div>
  );
}

function HistoryView({ snapshot, unifiedTimeline }: { snapshot: Snapshot; unifiedTimeline?: UnifiedDay[] }) {
  const strengths = [...snapshot.strengthTraining.workouts].sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());
  const swims = snapshot.historyWorkouts.filter((workout) => workout.type.toLowerCase().includes("swim")).slice().reverse();
  const weights = snapshot.historyDaily.filter((row): row is Daily & { weightKg: number } => row.weightKg !== null).slice().reverse();
  const sleeps = snapshot.historySleeps.slice().reverse();
  return (
    <div className="history-view">
      {unifiedTimeline && unifiedTimeline.length ? (
        <section className="history-section" aria-labelledby="unified-history-title">
          <div className="section-heading"><div><p className="section-kicker">一体时间线</p><h2 id="unified-history-title">每天合在一起看</h2></div><span className="record-count">{unifiedTimeline.length} 天</span></div>
          <div className="unified-list">
            {unifiedTimeline.map((day) => (
              <div className="unified-row" key={day.date}>
                <span className="unified-date">{dateLabel(day.date)}</span>
                <div className="unified-main"><strong>{day.steps === null ? "步数 —" : `${numberLabel(day.steps)} 步`}{day.sleepHours !== null ? ` · 睡 ${day.sleepHours.toFixed(1)}h` : ""}</strong><small>{day.hasStrength ? `力量 ${day.strengthSessions} 次 · ${volumeLabel(day.strengthVolume)} ${snapshot.strengthTraining.displayUnit}` : "没有力量训练"}</small></div>
                <span className={`unified-badge ${day.hasHealth && day.hasStrength ? "both" : ""}`}>{day.hasHealth && day.hasStrength ? "两边都有" : day.hasStrength ? "只有力量" : "只有健康"}</span>
              </div>
            ))}
          </div>
        </section>
      ) : null}
      <section className="history-section" aria-labelledby="strength-history-title">
        <div className="section-heading"><div><p className="section-kicker">训练记录</p><h2 id="strength-history-title">力量训练历史</h2></div><span className="record-count">{strengths.length} 次</span></div>
        {strengths.length ? <div className="strength-history-list">{strengths.map((workout) => (
          <details className="strength-history-row" key={workout.id}>
            <summary>
              <span className={`routine-dot routine-${workout.routine}`}>{ROUTINE_LABELS[workout.routine]}</span>
              <span><strong>{dateLabel(workout.date)} · {workout.status === "active" ? "进行中" : durationLabel(workout.durationMinutes)}</strong><small>{workout.completedSets}/{workout.totalSets} 组</small></span>
              <span className="history-volume">{volumeLabel(workout.totalVolume)} {workout.unit}</span>
              <i aria-hidden="true">›</i>
            </summary>
            <div className="strength-exercise-list">
              {workout.exercises.map((exercise) => <div key={exercise.key}><span>{exercise.name}</span><strong>{volumeLabel(exercise.volume)} {workout.unit}</strong><small>{exercise.sets.filter((set) => set.completed).map((set) => `${set.weight ?? "自重"}×${set.reps ?? "—"}`).join(" / ") || "未完成"}</small></div>)}
            </div>
          </details>
        ))}</div> : <p className="empty-inline">{snapshot.strengthTraining.note}</p>}
      </section>

      <section className="history-section" aria-labelledby="swim-history-title">
        <div className="section-heading"><div><p className="section-kicker">HealthKit workout</p><h2 id="swim-history-title">游泳记录</h2></div><span className="record-count">{swims.length} 次</span></div>
        {swims.length ? <div className="record-list">{swims.map((workout) => <article className="record-row" key={workout.id}><div><strong>{dateLabel(workout.date)}</strong><span>{numberLabel(workout.distanceMeters)} 米</span></div><dl><div><dt>时长</dt><dd>{workout.durationMinutes === null ? "—" : `${workout.durationMinutes.toFixed(1)} 分`}</dd></div><div><dt>平均心率</dt><dd>{workout.averageHr === null ? "—" : `${workout.averageHr.toFixed(0)} bpm`}</dd></div><div><dt>消耗</dt><dd>{workout.energyKcal === null ? "—" : `${workout.energyKcal.toFixed(0)} kcal`}</dd></div></dl></article>)}</div> : <p className="empty-inline">近30天没有游泳 workout 记录。</p>}
      </section>

      <section className="history-section" aria-labelledby="weight-history-title">
        <div className="section-heading"><div><p className="section-kicker">近30天</p><h2 id="weight-history-title">体重记录</h2></div><span className="record-count">{weights.length} 次</span></div>
        {weights.length ? <div className="weight-list">{weights.map((row) => <div key={row.date}><span>{dateLabel(row.date)}</span><strong>{row.weightKg.toFixed(2)} kg</strong></div>)}</div> : <p className="empty-inline">近30天没有体重记录。</p>}
      </section>

      <section className="history-section" aria-labelledby="sleep-history-title">
        <div className="section-heading"><div><p className="section-kicker">最近记录</p><h2 id="sleep-history-title">睡眠历史</h2></div><span className="record-count">{sleeps.length} 晚</span></div>
        {sleeps.length ? <div className="sleep-list">{sleeps.map((sleep) => <article key={`${sleep.date}-${sleep.start}`}><div><strong>{dateLabel(sleep.date)}</strong><span>{sleep.start}–{sleep.end}</span></div><div><strong>{sleep.totalHours.toFixed(1)} 小时</strong><span>质量 {numberLabel(sleep.quality)}</span></div></article>)}</div> : <p className="empty-inline">暂无睡眠历史记录。</p>}
      </section>
    </div>
  );
}

function Dashboard({ snapshot, readiness, dataStatus, unifiedTimeline, autoSyncFailureNote }: { snapshot: Snapshot; readiness: Readiness | null; dataStatus: DataStatus | null; unifiedTimeline: UnifiedDay[]; autoSyncFailureNote: string | null }) {
  const [tab, setTab] = useState<Tab>("today");
  const [lastSyncMessage, setLastSyncMessage] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const polling = useTaskPolling();
  const refresh = useMutation({
    mutationFn: () => api.refreshHealthData({}),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: ["dashboard"] });
      setLastSyncMessage(result.message);
      if (result.accepted) polling.startPolling([result.taskId, result.strengthTaskId]);
    },
  });
  const strengthRefresh = useMutation({
    mutationFn: () => api.refreshStrengthTraining({}),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: ["dashboard"] });
      setLastSyncMessage(result.message);
      if (result.accepted) polling.startPolling([result.strengthTaskId]);
    },
  });

  const isSyncing = refresh.isPending || strengthRefresh.isPending || polling.syncing;
  // The open-triggered background strength sync is polled by the App shell,
  // not by this component; its failure note arrives as a prop so a failed
  // background sync is visible even when the dashboard already has data
  // (previously that note only rendered in the empty state, so a failed
  // auto-sync with existing data disappeared silently).
  const syncMessage = polling.failureNote ?? autoSyncFailureNote ?? (polling.syncing ? "同步进行中，完成后会自动更新" : lastSyncMessage);
  return (
    <>
      <header className="page-meta">
        <div><p>{fullDateLabel(snapshot.dataDate)} · 最近完整日</p><span>更新于 {updatedLabel(snapshot.updatedAt)} · Apple 健康</span></div>
        <button className="sync-button" type="button" aria-label="同步 Apple 健康和训练记录" onClick={() => refresh.mutate()} disabled={isSyncing}>{isSyncing ? "同步中…" : snapshot.coverageIncomplete ? "待补全 · 全部同步" : "全部同步"}</button>
      </header>
      <nav className="view-tabs" aria-label="健康看板视图">
        <button type="button" className={tab === "today" ? "selected" : ""} onClick={() => setTab("today")}>今日</button>
        <button type="button" className={tab === "trends" ? "selected" : ""} onClick={() => setTab("trends")}>趋势</button>
        <button type="button" className={tab === "history" ? "selected" : ""} onClick={() => setTab("history")}>历史</button>
      </nav>
      {tab === "today" ? <TodayView snapshot={snapshot} readiness={readiness} onSyncStrength={() => strengthRefresh.mutate()} strengthSyncing={isSyncing} dataStatus={dataStatus} unifiedTimeline={unifiedTimeline} /> : tab === "trends" ? <TrendsView snapshot={snapshot} /> : <HistoryView snapshot={snapshot} unifiedTimeline={unifiedTimeline} />}
      {syncMessage ? <p className="refresh-note" role="status">{syncMessage}</p> : null}
    </>
  );
}

// Shown when the health snapshot is missing or corrupt but a standalone
// strength snapshot exists (H-SOURCE-001): the training data is real and
// must stay visible instead of being swallowed by the health empty state.
function StrengthOnlyView({ strength, healthState, dataStatus, unifiedTimeline, onSyncHealth, healthSyncing, onSyncStrength, strengthSyncing }: {
  strength: StrengthTraining; healthState: SourceState; dataStatus: DataStatus | null; unifiedTimeline: UnifiedDay[];
  onSyncHealth: () => void; healthSyncing: boolean; onSyncStrength: () => void; strengthSyncing: boolean;
}) {
  const corrupt = healthState === "corrupt";
  return (
    <div className="strength-only-view">
      <section className="source-notice" aria-labelledby="strength-only-title">
        <p className="section-kicker">只有训练数据</p>
        <h1 id="strength-only-title">{corrupt ? "健康快照损坏" : "健康数据尚未同步"}</h1>
        <p>{corrupt
          ? "保存的健康快照已损坏，暂时读不出来；训练记录是独立保存的，不受影响，照常显示在下面。重新同步 Apple 健康后健康数据会恢复。"
          : "还没有同步过 Apple 健康，所以步数、心率与睡眠暂时看不到；训练记录是独立同步的，已有训练照常显示在下面。"}</p>
        <button className="sync-button" type="button" aria-label="同步 Apple 健康数据" onClick={onSyncHealth} disabled={healthSyncing}>{healthSyncing ? "同步中…" : "同步 Apple 健康"}</button>
      </section>
      <StrengthPanel strength={strength} onSync={onSyncStrength} syncing={strengthSyncing} />
      <DataStatusPanel dataStatus={dataStatus} unifiedTimeline={unifiedTimeline} displayUnit={strength.displayUnit} />
    </div>
  );
}

export function App() {
  const dashboard = useQuery({ queryKey: ["dashboard"], queryFn: () => api.getDashboard({}) });
  const queryClient = useQueryClient();
  const polling = useTaskPolling();
  // getDashboard kicks off a background strength sync on every open (the
  // stored snapshot is shown first); it returns the task id and we poll it
  // here so the fresh numbers land in this same session. This shell owns
  // that poll, so its failure note is passed into Dashboard below — with
  // existing data on screen the failure must still be visible, not dropped.
  const autoSyncStartedRef = useRef<string | null>(null);
  const autoSyncTaskId = dashboard.data?.strengthSyncTaskId ?? null;
  useEffect(() => {
    if (autoSyncTaskId && autoSyncStartedRef.current !== autoSyncTaskId) {
      autoSyncStartedRef.current = autoSyncTaskId;
      polling.startPolling([autoSyncTaskId]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoSyncTaskId]);
  const firstSync = useMutation({
    mutationFn: () => api.refreshHealthData({}),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: ["dashboard"] });
      if (result.accepted) polling.startPolling([result.taskId, result.strengthTaskId]);
    },
  });
  const strengthRefresh = useMutation({
    mutationFn: () => api.refreshStrengthTraining({}),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: ["dashboard"] });
      if (result.accepted) polling.startPolling([result.strengthTaskId]);
    },
  });

  const firstSyncing = firstSync.isPending || polling.syncing;
  const strengthSyncing = strengthRefresh.isPending || polling.syncing;
  return (
    <div className="app-shell"><SafeAreaTopScrim backgroundColor="var(--bg)" /><main>
      {dashboard.isPending ? <div className="loading" role="status"><span /><p>正在读取健康数据…</p></div> : dashboard.isError ? <div className="empty-state" role="alert"><h1>暂时无法读取数据</h1><p>请稍后重新打开看板。</p></div> : dashboard.data.forbidden ? <div className="empty-state"><h1>健康数据仅所有者可查看</h1><p>此看板包含所有者的个人健康记录，当前访问身份无权查看。</p></div> : dashboard.data.snapshot ? <Dashboard snapshot={dashboard.data.snapshot} readiness={dashboard.data.readiness} dataStatus={dashboard.data.dataStatus} unifiedTimeline={dashboard.data.unifiedTimeline} autoSyncFailureNote={polling.failureNote} /> : dashboard.data.strength ? (
        <>
          <StrengthOnlyView strength={dashboard.data.strength} healthState={dashboard.data.healthState} dataStatus={dashboard.data.dataStatus} unifiedTimeline={dashboard.data.unifiedTimeline} onSyncHealth={() => firstSync.mutate()} healthSyncing={firstSyncing} onSyncStrength={() => strengthRefresh.mutate()} strengthSyncing={strengthSyncing} />
          {polling.failureNote ? <p className="refresh-note" role="status">{polling.failureNote}</p> : firstSync.data ? <p className="refresh-note" role="status">{polling.syncing ? `${firstSync.data.message}，完成后会自动更新` : firstSync.data.message}</p> : null}
        </>
      ) : (
        <>
          <div className="empty-state">
            <h1>还没有健康数据</h1>
            <p>尚未同步过 Apple 健康。点击下方按钮，从 HealthKit 同步最近的完整日数据后，这里会显示步数、心率、HRV 与睡眠。</p>
            <button className="sync-button" type="button" aria-label="同步 Apple 健康数据" onClick={() => firstSync.mutate()} disabled={firstSyncing}>{firstSyncing ? "同步中…" : "同步 Apple 健康"}</button>
            {polling.failureNote ? <p role="status">{polling.failureNote}</p> : firstSync.data ? <p role="status">{polling.syncing ? `${firstSync.data.message}，完成后会自动更新` : firstSync.data.message}</p> : null}
          </div>
          {dashboard.data.dataStatus ? <DataStatusPanel dataStatus={dashboard.data.dataStatus} unifiedTimeline={dashboard.data.unifiedTimeline} displayUnit="lb" /> : null}
        </>
      )}
      <footer>仅供健康参考，不做医疗诊断；身体不适请及时看医生。</footer>
    </main></div>
  );
}
