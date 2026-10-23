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
type ReadinessHistoryPoint = DashboardResponse["readinessHistory"][number];
type SourceState = DashboardResponse["healthState"];
type FocusFeedbackData = DashboardResponse["focusFeedback"];
type GameState = ApiResponse<typeof api, "getGameState">;
type GameCategory = GameState["settlements"][number]["category"];
type RewardsState = ApiResponse<typeof api, "getRewards">;
type RewardItem = RewardsState["rewards"][number];
type RewardReceipt = RewardsState["receipts"][number];
type Tab = "today" | "trends" | "history" | "game";
type Status = "正常" | "偏低" | "偏高" | "数据缺失" | "基线不足";

// Routine labels (L1-ROUTINE-001): all five source values, with the two
// home routines labelled exactly as 训练记录 (space-6) labels them —
// home_posture is 「在家 A · 体态」, home_snowboard is 「在家 B · 单板」.
// The raw value is never relabelled as one of the gym routines.
const ROUTINE_LABELS: Record<StrengthWorkout["routine"], string> = {
  push: "推",
  pull: "拉",
  legs: "腿",
  home_posture: "在家 A · 体态",
  home_snowboard: "在家 B · 单板",
};

// HealthKit workout_type values arrive as raw English codes ("swimming",
// "cycling", "elliptical"). The UI is Chinese: rendering the raw code made
// real records unrecognizable — a list full of "swimming" does not read as
// 游泳记录 to the user scanning for it. Unknown types keep their raw value
// rather than being relabeled by guesswork.
const WORKOUT_TYPE_LABELS: Record<string, string> = {
  swimming: "游泳",
  swim: "游泳",
  cycling: "骑行",
  biking: "骑行",
  elliptical: "椭圆机",
  running: "跑步",
  walking: "步行",
  hiking: "徒步",
  rowing: "划船",
  yoga: "瑜伽",
  core_training: "核心训练",
  traditional_strength_training: "力量训练",
  functional_strength_training: "力量训练",
  strength_training: "力量训练",
};

function workoutTypeLabel(type: string): string {
  return WORKOUT_TYPE_LABELS[type.toLowerCase()] ?? type;
}

function isSwimWorkout(type: string): boolean {
  const normalized = type.toLowerCase();
  return normalized.includes("swim") || normalized.includes("游泳");
}

// One-line workout summary for a unified-timeline day, e.g.
// "运动 1 次 · 游泳 600 米". Empty string when the day has no workouts.
function unifiedWorkoutText(day: UnifiedDay): string {
  if (!day.workoutSessions) return "";
  const types = day.workoutTypes.map(workoutTypeLabel).join("、");
  const swim = day.swimMeters !== null && day.swimMeters > 0 ? ` · 游泳 ${numberLabel(day.swimMeters)} 米` : "";
  return `运动 ${day.workoutSessions} 次${types ? ` · ${types}` : ""}${swim}`;
}

// Per-type HealthKit workout label for a unified-timeline day
// (H-WORKOUTS-001 item 2), e.g. "运动 3 次 · Running、Swimming · 已知时长 50 分".
// Types are the raw HealthKit strings; the duration segment appears only
// when at least one group's duration is known — a group whose sessions
// all lack durations contributes its count but no minutes, and a real
// 0-minute total still shows "已知时长 0 分". The durations are only the
// recorded subtotal (missing durations are not counted as 0), labeled
// 已知时长 rather than a blanket total. Empty string when the day has
// no HK workout groups (or the field is absent on an older payload).
function unifiedHkLabel(day: UnifiedDay): string {
  const groups = day.hkWorkouts ?? [];
  if (!groups.length) return "";
  const totalSessions = groups.reduce((sum, group) => sum + group.sessions, 0);
  const types = groups.map((group) => group.type).join("、");
  const knownDurations = groups.map((group) => group.durationMinutes).filter((value): value is number => value !== null);
  const totalMinutes = Math.round(knownDurations.reduce((a, b) => a + b, 0) * 10) / 10;
  const duration = knownDurations.length ? ` · 已知时长 ${totalMinutes.toLocaleString("zh-CN", { maximumFractionDigits: 1 })} 分` : "";
  return `运动 ${totalSessions} 次 · ${types}${duration}`;
}

function statusClass(status: Status): string {
  if (status === "正常") return "status-ok";
  if (status === "数据缺失" || status === "基线不足") return "status-missing";
  return "status-watch";
}

// Status is never carried by color alone (the owner is color-vision
// deficient): every status also gets a shape/symbol and its text label,
// and numeric deviations get a direction arrow. Symbols are chosen to
// differ in shape, not hue: ✓ normal, ↓ low, ↑ high, — missing.
function statusSymbol(status: Status): string {
  if (status === "正常") return "✓";
  if (status === "偏低") return "↓";
  if (status === "偏高") return "↑";
  return "—";
}

// Same rule for the Whoop bands: the band word is always paired with a
// distinct shape (✓ / ● / ▲ / ○ / —) and the marker's position on the
// segmented track, so red-vs-green is never the only signal.
function bandSymbol(band: WhoopBand): string {
  if (band === "green") return "✓";
  if (band === "yellow") return "●";
  if (band === "red") return "▲";
  if (band === "blue") return "○";
  return "—";
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
      <div className="kpi-topline"><span>{label}</span><span className={`status-chip ${statusClass(status)}`}><span aria-hidden="true">{statusSymbol(status)}</span> {status}</span></div>
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
        <span className={`status-chip ${statusClass(sleep.status)}`}><span aria-hidden="true">{statusSymbol(sleep.status)}</span> {sleep.status}</span>
      </div>
      <div className="sleep-clock"><div><span>入睡</span><strong>{sleep.bedtime}</strong></div><div className="sleep-line" aria-hidden="true" /><div><span>起床</span><strong>{sleep.wakeTime}</strong></div></div>
      {hasStages ? (
        <>
          <div className="sleep-stages" aria-label="睡眠分期">
            <span className="stage-core" style={{ width: pct(sleep.coreHours ?? 0) }} /><span className="stage-deep" style={{ width: pct(sleep.deepHours ?? 0) }} />
            <span className="stage-rem" style={{ width: pct(sleep.remHours ?? 0) }} /><span className="stage-awake" style={{ width: pct((sleep.awakeMinutes ?? 0) / 60) }} />
          </div>
          <div className="stage-legend">
            <span><i className="dot core" />浅睡 <b>{(sleep.coreHours ?? 0).toFixed(1)}h</b></span><span><i className="dot deep" />深睡 <b>{Math.round((sleep.deepHours ?? 0) * 60)}m</b></span><span><i className="dot rem" />REM <b>{(sleep.remHours ?? 0).toFixed(1)}h</b></span><span><i className="dot awake" />清醒 <b>{Math.round(sleep.awakeMinutes ?? 0)}m</b></span>
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

// ---------------------------------------------------------------------------
// H4.6 肌群视图：动作→肌群映射与聚合（MUSCLE-MAP v1）
//
// The mapping below is the shared W6.2/H4.6 table whose single source of
// truth is workout-log/MUSCLE-MAP.md (map_version 1, maintained with
// 训练记录 space-6). This is a verbatim copy of that version — space-4
// consumes the same table and must not grow a divergent hand-made one;
// when the source table bumps its version, this copy is updated to match.
// Keys are the stable exercise_key values the strength snapshot already
// carries. An unknown key is NEVER mapped by name similarity: it is
// reported separately as 尚无映射.
//
// Recovery progress (H4.6 定案): the reference interval T has no decided
// rule source yet, so this section shows NO percentage and NO recovery
// conclusion — only the last trained date and the rule-undefined note.
// It is a distribution of training facts, unrelated to the readiness
// score, and not a medical recovery measurement.

export const MUSCLE_GROUPS = [
  "胸", "肩前束", "肩中束", "肩后束", "背阔肌", "斜方肌", "菱形肌",
  "肱二头肌", "肱三头肌", "前锯肌", "核心", "腹斜肌", "股四头肌",
  "腘绳肌", "臀大肌", "小腿", "胫骨前肌", "颈深屈肌", "胸椎伸展肌群",
] as const;

export type MuscleGroup = (typeof MUSCLE_GROUPS)[number];

export interface MuscleMapEntry {
  primary: MuscleGroup[];
  secondary: MuscleGroup[];
}

export const MUSCLE_MAP_V1: Record<string, MuscleMapEntry> = {
  "barbell-bench": { primary: ["胸"], secondary: ["肱三头肌", "肩前束"] },
  "overhead-press": { primary: ["肩前束", "肩中束"], secondary: ["肱三头肌", "核心"] },
  "incline-dumbbell-press": { primary: ["胸"], secondary: ["肩前束", "肱三头肌"] },
  "dips": { primary: ["胸", "肱三头肌"], secondary: ["肩前束"] },
  "lateral-raise": { primary: ["肩中束"], secondary: ["斜方肌"] },
  "push-up-plus": { primary: ["前锯肌"], secondary: ["胸", "核心"] },
  "wide-lat-pulldown": { primary: ["背阔肌"], secondary: ["肱二头肌", "肩后束"] },
  "close-lat-pulldown": { primary: ["背阔肌"], secondary: ["肱二头肌"] },
  "close-seated-row": { primary: ["背阔肌", "菱形肌"], secondary: ["肱二头肌", "斜方肌"] },
  "wide-seated-row": { primary: ["菱形肌", "肩后束"], secondary: ["背阔肌", "斜方肌"] },
  "face-pull": { primary: ["肩后束"], secondary: ["斜方肌", "菱形肌"] },
  "reverse-pec-deck": { primary: ["肩后束"], secondary: ["斜方肌"] },
  "rope-curl": { primary: ["肱二头肌"], secondary: [] },
  "back-squat": { primary: ["股四头肌", "臀大肌"], secondary: ["核心", "腘绳肌"] },
  "romanian-deadlift": { primary: ["腘绳肌", "臀大肌"], secondary: ["斜方肌", "核心"] },
  "bulgarian-split-squat": { primary: ["股四头肌", "臀大肌"], secondary: ["小腿", "核心"] },
  "lying-leg-curl": { primary: ["腘绳肌"], secondary: ["小腿"] },
  "calf-raise": { primary: ["小腿"], secondary: [] },
  "tibialis-raise": { primary: ["胫骨前肌"], secondary: [] },
  "supine-chin-tuck": { primary: ["颈深屈肌"], secondary: [] },
  "prone-ytw": { primary: ["斜方肌", "肩后束"], secondary: ["菱形肌", "胸椎伸展肌群"] },
  "side-external-rotation": { primary: ["肩后束"], secondary: [] },
  "thoracic-extension": { primary: ["胸椎伸展肌群"], secondary: [] },
  "single-leg-balance": { primary: ["小腿", "臀大肌"], secondary: ["核心"] },
  "home-bulgarian-split-squat": { primary: ["股四头肌", "臀大肌"], secondary: ["小腿", "核心"] },
  "bench-step-up": { primary: ["股四头肌", "臀大肌"], secondary: ["小腿"] },
  "home-calf-raise": { primary: ["小腿"], secondary: [] },
  "wall-sit": { primary: ["股四头肌"], secondary: ["臀大肌"] },
  "dead-bug": { primary: ["核心"], secondary: [] },
  "side-plank": { primary: ["腹斜肌", "核心"], secondary: ["臀大肌"] },
};

export interface MuscleSource {
  // The stored workout id, rendered verbatim as text — never turned
  // into a link: a snapshot may be truncated, and a wrong deep link is
  // worse than no link.
  workoutId: string;
  date: string;
  exerciseKey: string;
  // The exercise's display name as stored in the snapshot itself
  // (exercise.name), passed through verbatim — never guessed from the
  // key. Null when the snapshot carries no name for this exercise, in
  // which case the row falls back to showing the key alone.
  exerciseName: string | null;
  // Whether this muscle is a primary or secondary target of the
  // exercise under MUSCLE-MAP v1.
  role: "primary" | "secondary";
  completedSets: number;
  // External load summed over this exercise's completed sets that carry
  // both weight and reps, in the workout's own unit (the dashboard-wide
  // missing-set rule). Completed sets missing weight or reps add no load
  // and are counted in unmeasuredSets instead. Loads are never totalled
  // across muscles: one exercise legitimately appears under several.
  load: number;
  unit: "lb" | "kg";
  unmeasuredSets: number;
  // False when the workout predates the 7-day window: the source is
  // still shown with its real date but contributes nothing to the
  // 7-day set counts.
  inWindow: boolean;
}

export interface MuscleGroupStatus {
  muscle: MuscleGroup;
  // Latest date (<= today) of a completed workout in which an exercise
  // mapping to this muscle had at least one completed set; null when the
  // snapshot holds no such training — never backfilled with a fake date.
  lastDate: string | null;
  // Whole calendar days from lastDate to today; null exactly when
  // lastDate is null.
  daysSince: number | null;
  // Completed sets in the 7-day window [today-6, today], counted from
  // the per-set completed flags only, primary and secondary kept apart.
  primarySets7d: number;
  secondarySets7d: number;
  // Every snapshot source behind this muscle's facts (completed
  // workouts only, at least one completed set), newest first. Includes
  // out-of-window records, flagged as such on each entry.
  sources: MuscleSource[];
}

export interface MuscleStatus {
  // True when at least one completed workout contributed at least one
  // completed set (mapped or not). False drives the honest empty state
  // instead of a table of zeros.
  hasCompletedTraining: boolean;
  groups: MuscleGroupStatus[];
  // Distinct exercise keys with completed sets in completed workouts
  // that MUSCLE-MAP v1 does not cover, sorted; never guessed into a
  // muscle.
  unmappedKeys: string[];
  mappedKeyCount: number;
  seenKeyCount: number;
  windowStart: string;
  windowEnd: string;
  // The same groups partitioned for display: trained inside the 7-day
  // window, trained earlier in the snapshot, and not seen in this
  // snapshot. The first two are ordered by last trained date descending
  // (most recent first), same-day ties broken by the fixed MUSCLE_GROUPS
  // order; unseen groups keep the fixed order. "Not seen" is a statement
  // about this snapshot only — never a claim about all history.
  sections: {
    recent: MuscleGroupStatus[];
    older: MuscleGroupStatus[];
    unseen: MuscleGroupStatus[];
  };
}

// Pure aggregation over the strength snapshot's workouts (H4.6). Only
// workouts with status "completed" count, and only sets whose completed
// flag is set — an exercise with zero completed sets trained nothing and
// sets no last date. Workouts dated after today are ignored entirely (a
// future-dated record cannot be "days since"). Self-contained (own date
// math, own map) so validate-muscle-status.mjs can extract it by name
// and run it standalone over synthetic fixtures.
export function muscleStatus(
  workouts: Array<Pick<StrengthWorkout, "id" | "date" | "status" | "unit" | "exercises">> | null | undefined,
  today: string,
): MuscleStatus {
  const shift = (date: string, days: number): string => {
    const shifted = new Date(`${date}T12:00:00Z`);
    shifted.setUTCDate(shifted.getUTCDate() + days);
    return shifted.toISOString().slice(0, 10);
  };
  const dayDiff = (from: string, to: string): number =>
    Math.round((new Date(`${to}T12:00:00Z`).getTime() - new Date(`${from}T12:00:00Z`).getTime()) / 86400000);
  const windowStart = shift(today, -6);
  const stats = new Map<MuscleGroup, { lastDate: string | null; primarySets7d: number; secondarySets7d: number; sources: MuscleSource[] }>();
  for (const muscle of MUSCLE_GROUPS) stats.set(muscle, { lastDate: null, primarySets7d: 0, secondarySets7d: 0, sources: [] });
  const seenKeys = new Set<string>();
  const unmapped = new Set<string>();
  let hasCompletedTraining = false;
  for (const workout of workouts ?? []) {
    if (workout.status !== "completed") continue;
    if (workout.date > today) continue;
    const inWindow = workout.date >= windowStart;
    for (const exercise of workout.exercises) {
      const completedList = exercise.sets.filter((set) => set.completed);
      const completedSets = completedList.length;
      if (completedSets === 0) continue;
      hasCompletedTraining = true;
      seenKeys.add(exercise.key);
      const entry = MUSCLE_MAP_V1[exercise.key];
      if (!entry) {
        unmapped.add(exercise.key);
        continue;
      }
      // External load for this source, in the workout's own unit: only
      // completed sets carrying both weight and reps add load; a
      // completed set missing either is tallied as unmeasured instead.
      let load = 0;
      let unmeasuredSets = 0;
      for (const set of completedList) {
        if (set.weight !== null && set.weight !== undefined && set.reps !== null && set.reps !== undefined) {
          load += set.weight * set.reps;
        } else {
          unmeasuredSets += 1;
        }
      }
      const base = {
        workoutId: workout.id,
        date: workout.date,
        exerciseKey: exercise.key,
        exerciseName: exercise.name ?? null,
        completedSets,
        load,
        unit: workout.unit,
        unmeasuredSets,
        inWindow,
      };
      for (const muscle of entry.primary) {
        const stat = stats.get(muscle);
        if (!stat) continue;
        if (stat.lastDate === null || workout.date > stat.lastDate) stat.lastDate = workout.date;
        if (inWindow) stat.primarySets7d += completedSets;
        stat.sources.push({ ...base, role: "primary" });
      }
      for (const muscle of entry.secondary) {
        const stat = stats.get(muscle);
        if (!stat) continue;
        if (stat.lastDate === null || workout.date > stat.lastDate) stat.lastDate = workout.date;
        if (inWindow) stat.secondarySets7d += completedSets;
        stat.sources.push({ ...base, role: "secondary" });
      }
    }
  }
  const groups: MuscleGroupStatus[] = MUSCLE_GROUPS.map((muscle) => {
    const stat = stats.get(muscle) ?? { lastDate: null, primarySets7d: 0, secondarySets7d: 0, sources: [] };
    // Newest source first; the sort is stable, so same-day sources keep
    // their snapshot order.
    const sources = [...stat.sources].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
    return {
      muscle,
      lastDate: stat.lastDate,
      daysSince: stat.lastDate === null ? null : dayDiff(stat.lastDate, today),
      primarySets7d: stat.primarySets7d,
      secondarySets7d: stat.secondarySets7d,
      sources,
    };
  });
  // Display partition: last trained date descending inside the two
  // trained groups (most recent first — a record of what happened, not
  // a ranking of what to train next), fixed-order tie-break.
  const fixedOrder = new Map<MuscleGroup, number>();
  MUSCLE_GROUPS.forEach((muscle, index) => fixedOrder.set(muscle, index));
  const byRecency = (a: MuscleGroupStatus, b: MuscleGroupStatus): number => {
    if (a.lastDate !== b.lastDate) return (a.lastDate ?? "") < (b.lastDate ?? "") ? 1 : -1;
    return (fixedOrder.get(a.muscle) ?? 0) - (fixedOrder.get(b.muscle) ?? 0);
  };
  const sections = {
    recent: groups.filter((group) => group.lastDate !== null && group.lastDate >= windowStart).sort(byRecency),
    older: groups.filter((group) => group.lastDate !== null && group.lastDate < windowStart).sort(byRecency),
    unseen: groups.filter((group) => group.lastDate === null),
  };
  const unmappedKeys = [...unmapped].sort();
  return {
    hasCompletedTraining,
    groups,
    unmappedKeys,
    mappedKeyCount: seenKeys.size - unmappedKeys.length,
    seenKeyCount: seenKeys.size,
    windowStart,
    windowEnd: today,
    sections,
  };
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

// H4.6 肌群区：per-muscle training facts from the strength snapshot,
// presented as three factual groups under the existing 7-day window:
// trained inside the window, trained earlier in the snapshot, and not
// seen in this snapshot. Group identity rides on the heading text, its
// symbol and its position in the list — never on color alone (the
// owner is color-vision deficient). Inside the two trained groups rows
// are ordered by last trained date descending (most recent first): a
// record of what happened, not a suggestion of what to train next —
// the longest-ago muscles are deliberately NOT surfaced as a priority
// list. "Not seen" describes this snapshot only and is never worded as
// never-trained. No recovery percentage or conclusion is rendered
// anywhere: the reference-interval rule is undecided (see
// muscleStatus). Tapping a muscle row expands its source workouts in
// place; expanding or collapsing never remounts the list, so the
// scroll position and the group the row sits in stay put.
const MUSCLE_SECTION_HEADS: Record<"recent" | "older" | "unseen", { symbol: string; label: string }> = {
  recent: { symbol: "●", label: "近7天有记录" },
  older: { symbol: "◆", label: "更早的快照内记录" },
  unseen: { symbol: "○", label: "本快照未见记录" },
};

function MuscleRow({ group, expanded, onToggle }: { group: MuscleGroupStatus; expanded: boolean; onToggle: () => void }) {
  return (
    <div className="muscle-row">
      <button type="button" className="muscle-row-head" aria-expanded={expanded} aria-label={`${group.muscle}的来源明细`} onClick={onToggle}>
        <span className="muscle-main">
          <strong>{group.muscle}</strong>
          {group.lastDate !== null ? (
            <span>最近训练 {dateLabel(group.lastDate)} · {group.daysSince === 0 ? "今天" : group.daysSince === 1 ? "昨天" : `${group.daysSince} 天前`}</span>
          ) : <span>本快照内未见已完成记录</span>}
        </span>
        <span className="muscle-facts">
          {group.lastDate !== null ? (
            <span>近7天 主要 {group.primarySets7d} 组 · 次要 {group.secondarySets7d} 组</span>
          ) : <span>近7天 —</span>}
          <small>修复进度：参考间隔规则未定，无法判断恢复进度</small>
        </span>
        <span className="muscle-chevron" aria-hidden="true">{expanded ? "▾" : "▸"}</span>
      </button>
      {expanded ? (
        <div className="muscle-sources">
          {group.sources.length > 0 ? group.sources.map((source, index) => (
            <div className="muscle-source" key={`${source.workoutId}-${source.exerciseKey}-${index}`}>
              <div className="muscle-source-top">
                <span className="muscle-source-name">{source.exerciseName ?? source.exerciseKey}</span>
                {source.exerciseName !== null ? <small className="muscle-source-key">{source.exerciseKey}</small> : null}
                <span>{fullDateLabel(source.date)}</span>
                {source.inWindow ? null : <span className="muscle-source-badge">本窗口外</span>}
              </div>
              <p className="muscle-source-detail">
                场次 {source.workoutId} · 本肌群为{source.role === "primary" ? "主要" : "次要"} · 完成 {source.completedSets} 组 · 外加负荷 {volumeLabel(source.load)} {source.unit}
                {source.unmeasuredSets > 0 ? `（其中 ${source.unmeasuredSets} 组缺重量或次数，未计入负荷）` : ""}
              </p>
            </div>
          )) : <p className="muscle-source-empty">本快照内没有该肌群的来源记录。</p>}
        </div>
      ) : null}
    </div>
  );
}

function MuscleStatusPanel({ strength }: { strength: StrengthTraining }) {
  const status = muscleStatus(strength.workouts, laTodayDateString());
  const [expandedMuscle, setExpandedMuscle] = useState<MuscleGroup | null>(null);
  const [unseenOpen, setUnseenOpen] = useState(false);
  const toggleMuscle = (muscle: MuscleGroup) => {
    setExpandedMuscle((current) => (current === muscle ? null : muscle));
  };
  const sectionBlock = (key: "recent" | "older") => {
    const groups = status.sections[key];
    if (groups.length === 0) return null;
    const head = MUSCLE_SECTION_HEADS[key];
    return (
      <div className="muscle-group-block">
        <h3 className="muscle-group-head"><span aria-hidden="true">{head.symbol}</span><span>{head.label}</span><span className="muscle-group-count">{groups.length} 个肌群</span></h3>
        <div className="muscle-list muscle-list-grouped">
          {groups.map((group) => (
            <MuscleRow key={group.muscle} group={group} expanded={expandedMuscle === group.muscle} onToggle={() => toggleMuscle(group.muscle)} />
          ))}
        </div>
      </div>
    );
  };
  return (
    <section className="history-section muscle-section" aria-labelledby="muscle-status-title">
      <div className="section-heading">
        <div><p className="section-kicker">训练记录 · 映射 v1</p><h2 id="muscle-status-title">肌群</h2></div>
        <span className="record-count">近7天 {dateLabel(status.windowStart)}–{dateLabel(status.windowEnd)}</span>
      </div>
      <p className="muscle-note">本区只汇总训练事实：练过哪个肌群、最近一次何时、近 7 天完成了多少组（主要与次要分开计，只计已完成组）。与 readiness 恢复分数无关，不是医学恢复测量。</p>
      <p className="muscle-note">数据来自最近同步的力量快照{strength.updatedAt ? `（更新于 ${updatedLabel(strength.updatedAt)}）` : ""}，只含快照内的训练记录，可能不完整。</p>
      <p className="muscle-note">点任意肌群行，可在原行展开它的来源场次：场次 ID、日期、动作、主要/次要归属与完成组数。近 7 天之外的来源标为「本窗口外」，不计入近 7 天组数。</p>
      {status.hasCompletedTraining ? (
        <>
          {sectionBlock("recent")}
          {sectionBlock("older")}
          {status.sections.unseen.length > 0 ? (
            <div className="muscle-group-block">
              <button type="button" className="muscle-group-toggle" aria-expanded={unseenOpen} aria-label="展开或收起本快照未见记录的肌群" onClick={() => setUnseenOpen((open) => !open)}>
                <span aria-hidden="true">{MUSCLE_SECTION_HEADS.unseen.symbol}</span>
                <span>{MUSCLE_SECTION_HEADS.unseen.label}</span>
                <span className="muscle-group-count">{status.sections.unseen.length} 个肌群</span>
                <span className="muscle-chevron" aria-hidden="true">{unseenOpen ? "▾" : "▸"}</span>
              </button>
              {unseenOpen ? (
                <div className="muscle-list muscle-list-grouped">
                  {status.sections.unseen.map((group) => (
                    <MuscleRow key={group.muscle} group={group} expanded={expandedMuscle === group.muscle} onToggle={() => toggleMuscle(group.muscle)} />
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}
          {status.seenKeyCount > 0 ? (
            <p className="muscle-note">
              动作映射覆盖 {status.mappedKeyCount}/{status.seenKeyCount}（映射表 v1）。
              {status.unmappedKeys.length > 0 ? <> 其中尚无映射的动作 {status.unmappedKeys.length} 个：{status.unmappedKeys.join("、")}——未猜测归属，不计入任何肌群。</> : null}
            </p>
          ) : null}
        </>
      ) : strength.workouts.length === 0 ? (
        <p className="empty-inline">尚无力量训练记录。完成训练并同步后，这里会按肌群显示最近训练日期与近 7 天完成组数。</p>
      ) : (
        <p className="empty-inline">快照中尚无已完成的训练（进行中的训练与没有完成组的动作不计入）。完成一次训练并同步后，这里会显示各肌群的训练分布。</p>
      )}
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
    // No visible caption: the status word is already the hero headline,
    // and repeating it under the ring is the kind of duplicate text the
    // owner flagged as clutter. The band label carries the glance value.
    detail: "",
  };
}

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
  if (radarSleep) {
    // The server fills the radar sleep dimension with a neutral default
    // when both sleep components are missing; only trust it when at
    // least one real sleep signal contributed.
    const hasSleepSignal = readiness?.components.some(
      (component) => (component.key === "lastSleep" || component.key === "sleepBank") && component.score !== null,
    ) ?? false;
    if (!hasSleepSignal) {
      return { pct: null, display: "—", band: "slate", bandLabel: "数据不足", detail: `${detail} · 睡眠信号不足` };
    }
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

interface StrainFacts {
  hasRow: boolean;
  exerciseMinutes: number | null;
  activeKcal: number | null;
  steps: number | null;
  detail: string;
}

function strainFacts(snapshot: Snapshot): StrainFacts {
  // No strain score is shown — the third hero slot presents the data
  // date's own recorded activity facts instead of an empty ring. Only
  // that day's record counts: never splice in another day's activity,
  // and never treat a missing quantity as zero.
  const row = snapshot.historyDaily.find((daily) => daily.date === snapshot.dataDate);
  if (!row) {
    return { hasRow: false, exerciseMinutes: null, activeKcal: null, steps: null, detail: `${dateLabel(snapshot.dataDate)} 的活动记录缺失` };
  }
  const detail = [
    row.activeKcal === null ? "活动能量未记录" : `活动 ${Math.round(row.activeKcal)} kcal`,
    row.steps === null ? "步数未记录" : `${numberLabel(row.steps)} 步`,
  ].join(" · ");
  return { hasRow: true, exerciseMinutes: row.exerciseMinutes, activeKcal: row.activeKcal, steps: row.steps, detail };
}

interface StrainScore extends WhoopScore {
  computable: boolean;
  trimp: number | null;
  scoredSessions: number;
  totalSessions: number;
  hrMaxBpm: number | null;
  missingReason: string | null;
}

// Daily load score (definition adopted by the user 2026-10-17, "按学术
// 来"): Banister TRIMP (1991) — the published academic formula underneath
// this product class. WHOOP's Strain formula and Garmin/Firstbeat's EPOC
// model are both proprietary and unpublished, so neither can be copied;
// TRIMP can, exactly. Per session:
//   ΔHR   = (session average HR − resting HR) / (HRmax − resting HR)
//   TRIMP = duration (min) × ΔHR × 0.64 · e^(1.92 · ΔHR)   (men's constants)
// The day's sessions sum to the daily TRIMP. The 0–21 display is a
// saturating map, 21 × (1 − e^(−TRIMP/150)), banded by WHOOP's published
// ranges (Light 0–9 / Moderate 10–13 / High 14–17 / All Out 18–21) — the
// map and bands are presentation only; the score is TRIMP, never WHOOP's
// formula, and the raw TRIMP value stays visible in the ring detail.
// HRmax is the highest daily hr_max_bpm observed in the stored window;
// resting HR is the data date's own daily value (falling back to the
// snapshot's main value, which is that same day's). A session missing
// duration or average HR cannot be scored: it is counted in the detail,
// never silently dropped and never treated as zero load. When resting HR
// or HRmax is unavailable the score is not computed at all. Only workout
// sessions count — non-workout daily activity is not in this definition,
// and the detail says so on workout-free days. Self-contained so it can
// be extracted and run standalone, like sevenDayFacts below.
function strainScore(snapshot: Snapshot): StrainScore {
  const date = snapshot.dataDate;
  const sessions = snapshot.historyWorkouts.filter((workout) => workout.date === date);
  const dailyRow = snapshot.historyDaily.find((row) => row.date === date);
  const resting = dailyRow?.restingHr ?? snapshot.restingHr.value;
  const hrMaxValues = snapshot.historyDaily.flatMap((row) => (row.hrMax !== null && row.hrMax !== undefined ? [row.hrMax] : []));
  const hrMax = hrMaxValues.length ? Math.max(...hrMaxValues) : null;
  const notComputable = (bandLabel: string, detail: string, missingReason: string): StrainScore => ({
    computable: false, trimp: null, scoredSessions: 0, totalSessions: sessions.length, hrMaxBpm: hrMax,
    pct: null, display: "—", band: "slate", bandLabel, detail, missingReason,
  });
  if (resting === null) {
    return notComputable("数据不足", `${dateLabel(date)} 静息心率缺失，TRIMP 无法计算`, "静息心率缺失");
  }
  if (hrMax === null || hrMax <= resting) {
    return notComputable("待同步", "最高心率未同步，下次同步后自动计算", "最高心率未同步");
  }
  let trimp = 0;
  let scored = 0;
  for (const session of sessions) {
    if (session.durationMinutes === null || session.averageHr === null) continue;
    const delta = Math.min(1, Math.max(0, (session.averageHr - resting) / (hrMax - resting)));
    trimp += session.durationMinutes * delta * 0.64 * Math.exp(1.92 * delta);
    scored += 1;
  }
  if (sessions.length > 0 && scored === 0) {
    return notComputable("数据不足", `${dateLabel(date)} 的运动缺平均心率或时长，TRIMP 无法计算`, "运动缺心率或时长");
  }
  const value = Math.round(21 * (1 - Math.exp(-trimp / 150)) * 10) / 10;
  const band: WhoopBand = value < 10 ? "blue" : value < 14 ? "green" : value < 18 ? "yellow" : "red";
  const bandLabel = value < 10 ? "轻负荷" : value < 14 ? "中等负荷" : value < 18 ? "高负荷" : "全力以赴";
  // Caption stays to the number itself; the HRmax provenance lives in
  // the collapsed 负荷口径 note (hrMaxBpm below), not under the ring.
  const parts = [`TRIMP ${Math.round(trimp)} · ${scored} 次运动`];
  if (sessions.length > scored) parts.push(`另 ${sessions.length - scored} 次缺心率/时长未计入`);
  if (sessions.length === 0) {
    const exercise = dailyRow?.exerciseMinutes;
    parts.push(exercise !== null && exercise !== undefined && exercise > 0
      ? `当日运动 ${Math.round(exercise)} 分钟无单次心率记录，未计入`
      : "当日无运动记录");
  }
  return {
    computable: true, trimp, scoredSessions: scored, totalSessions: sessions.length, hrMaxBpm: hrMax,
    pct: Math.round((value / 21) * 100), display: value.toFixed(1), band, bandLabel,
    detail: parts.join(" · "), missingReason: null,
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

interface WeekDayFact {
  date: string;
  exerciseMinutes: number | null;
  steps: number | null;
  sleepHours: number | null;
  sessions: number;
}

interface WeekLoad {
  band: WhoopBand;
  verdict: string;
  detail: string;
  sufficient: boolean;
  reasons: string[];
  previousDetail: string;
  current: WeekLoadWindow;
  previous: WeekLoadWindow;
  sessionsChangePct: number | null;
  durationChangePct: number | null;
  volumeChangePct: number | null;
  dayFacts: WeekDayFact[];
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
// workout sessions plus completed strength workouts from 训练记录. HK
// records carry only id/date/type/duration — no start/end instants and no
// cross-source link id — so a same-day HK strength session and a completed
// strength workout cannot be proven to be the same session: instead of
// merging them, the overlap downgrades the whole comparison to data
// insufficient (no percentage, no verdict), while both sides' known facts
// stay visible. Any coverage gap in either window — a missing or
// duplicated daily row, an unsynced or partially measured strength week, a
// session without a duration — means no percentage and no verdict, never
// a guessed one. Percentages are only computed per metric when both
// windows are complete and last week's value is above zero. The
// snapshot-level coverageIncomplete flag has no locatable detail (no
// query, no date), so when it is set and no concrete window gap was
// found it still downgrades the comparison conservatively — an
// unlocated gap must never be asserted to sit outside the windows.
function weekLoad(snapshot: Snapshot, readiness: Readiness | null): WeekLoad {
  const weekStart = mondayOf(snapshot.dataDate);
  const prevStart = shiftDateStr(weekStart, -7);
  const elapsedDays = Math.round((Date.parse(`${snapshot.dataDate}T12:00:00Z`) - Date.parse(`${weekStart}T12:00:00Z`)) / 86_400_000) + 1;
  const currentDates = Array.from({ length: elapsedDays }, (_, index) => shiftDateStr(weekStart, index));
  const previousDates = Array.from({ length: elapsedDays }, (_, index) => shiftDateStr(prevStart, index));
  const strength = snapshot.strengthTraining;
  const reasons: string[] = [];
  const addReason = (reason: string) => { if (!reasons.includes(reason)) reasons.push(reason); };

  // The snapshot-level coverageIncomplete flag carries no locatable
  // detail: it does not say which query or which day is incomplete.
  // Concrete gaps inside the two comparison windows are named below —
  // which dates lack a daily row, which window metric is null, which
  // strength week lacks whole-week coverage. The flag itself is applied
  // after every window check (see the coverage downgrade next to the
  // sufficiency gate): with no verifiable way to place the gap outside
  // the windows, it downgrades the comparison instead of being waved
  // through as irrelevant.

  // Daily coverage: every enumerated date in both windows must appear in
  // historyDaily exactly once.
  const dailyCounts = new Map<string, number>();
  for (const row of snapshot.historyDaily) dailyCounts.set(row.date, (dailyCounts.get(row.date) ?? 0) + 1);
  const checkDaily = (dates: string[], label: string) => {
    const missing = dates.filter((date) => !dailyCounts.has(date));
    if (missing.length) addReason(`${label}每日记录缺 ${missing.join("、")}`);
    const duplicated = dates.filter((date) => (dailyCounts.get(date) ?? 0) > 1);
    if (duplicated.length) addReason(`${label}每日记录 ${duplicated.join("、")} 重复`);
    // A present row whose exercise minutes were never recorded is a
    // concrete gap in a metric this panel shows per day — name the
    // dates instead of a blanket "not synced yet".
    const noExercise = dates.filter((date) => {
      const row = snapshot.historyDaily.find((daily) => daily.date === date);
      return row !== undefined && row.exerciseMinutes === null;
    });
    if (noExercise.length) addReason(`${label}${noExercise.map((date) => dateLabel(date)).join("、")} 运动分钟未记录`);
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
    // No cross-source dedup: every HK session is kept and counted. An HK
    // record has no start/end instant or link id, so when a date carries
    // both a completed strength workout and an HK strength session the
    // pair is ambiguous — flag it and let the sufficiency gate downgrade
    // instead of silently dropping one side.
    const hkAll = snapshot.historyWorkouts.filter((session) => inWindow.has(session.date));
    const strengthDates = new Set(strengthDone.map((workout) => workout.date));
    const hkStrengthDates = new Set(hkAll.filter((session) => session.type.toLowerCase().includes("strength")).map((session) => session.date));
    for (const date of strengthDates) {
      if (hkStrengthDates.has(date)) {
        addReason(`${dateLabel(date)} 两处力量记录归属未确认`);
      }
    }
    const strengthDuration = strengthDone.some((workout) => workout.durationMinutes === null)
      ? null
      : strengthDone.reduce((sum, workout) => sum + (workout.durationMinutes ?? 0), 0);
    if (strengthDuration === null) addReason(`${label}有力量场次时长缺失，时长不完整`);
    const hkDuration = hkAll.some((session) => session.durationMinutes === null)
      ? null
      : hkAll.reduce((sum, session) => sum + (session.durationMinutes ?? 0), 0);
    if (hkDuration === null) addReason(`${label}有训练时长缺失，时长不完整`);
    return {
      sessions: strengthDone.length + hkAll.length,
      strengthSessions: strengthDone.length,
      healthKitSessions: hkAll.length,
      durationMinutes: strengthDuration === null || hkDuration === null ? null : strengthDuration + hkDuration,
      strengthDurationMinutes: strengthDuration,
      healthKitDurationMinutes: hkDuration,
      strengthVolume: strengthDone.reduce((sum, workout) => sum + volumeInDisplayUnit(workout.totalVolume, workout.unit, strength.displayUnit), 0),
    };
  };
  const current = windowFacts(currentDates, "本周");
  const previous = windowFacts(previousDates, "上周同期");

  // Coverage downgrade (H-LOAD-001 / H-SYNC-DIVERGE-001): every concrete
  // check above passed, yet the source still reports incomplete coverage
  // somewhere unlocatable. The comparison is downgraded — no percentage,
  // no verdict — with the reason stated plainly, instead of claiming the
  // gap lies outside the windows when nothing can prove that.
  if (snapshot.coverageIncomplete && reasons.length === 0) {
    addReason("来源覆盖不完整且无法定位缺口日期，无法确认本周对比");
  }

  const sufficient = reasons.length === 0;
  const pctChange = (now: number, before: number): number | null => (sufficient && before > 0 ? ((now - before) / before) * 100 : null);
  const sessionsChangePct = pctChange(current.sessions, previous.sessions);
  const durationChangePct = current.durationMinutes !== null && previous.durationMinutes !== null
    ? pctChange(current.durationMinutes, previous.durationMinutes)
    : null;
  const volumeChangePct = pctChange(current.strengthVolume, previous.strengthVolume);
  // Per-day facts for the 7 completed days ending at dataDate, taken
  // from records the snapshot already carries (daily rows, sleep
  // sessions, workout sessions from both sources). The server keeps
  // only today's readiness score, so a day-by-day recovery strip would
  // be six holes out of seven; these facts are what those days actually
  // contain. A missing row or metric stays null — never 0, never a copy
  // of another day.
  const dayFacts: WeekDayFact[] = Array.from({ length: 7 }, (_, index) => {
    const date = shiftDateStr(snapshot.dataDate, index - 6);
    const daily = snapshot.historyDaily.find((row) => row.date === date);
    const sleepRow = snapshot.historySleeps.filter((row) => row.date === date).at(-1);
    const sessions = snapshot.historyWorkouts.filter((session) => session.date === date).length
      + strength.workouts.filter((workout) => workout.status === "completed" && workout.date === date).length;
    return {
      date,
      exerciseMinutes: daily?.exerciseMinutes ?? null,
      steps: daily?.steps ?? null,
      sleepHours: sleepRow ? sleepRow.totalHours : null,
      sessions,
    };
  });
  // Previous-week absolutes (H-LOAD-001 / H-SYNC-DIVERGE-001): the
  // first-screen detail line stays compact (this week + percentages),
  // while last week's same-span values — sessions, duration, strength
  // volume from the session windows, plus exercise minutes and steps
  // summed from the daily rows — are carried here for the expandable
  // detail area, labelled with their exact window. A metric whose daily
  // rows are missing or null in that window is "未记录", never summed
  // over the days that happen to exist.
  const dailySums = (dates: string[]): { exerciseMinutes: number | null; steps: number | null } => {
    let exerciseMinutes: number | null = 0;
    let steps: number | null = 0;
    for (const date of dates) {
      const row = snapshot.historyDaily.find((daily) => daily.date === date);
      if (!row || row.exerciseMinutes === null) exerciseMinutes = null;
      else if (exerciseMinutes !== null) exerciseMinutes += row.exerciseMinutes;
      if (!row || row.steps === null) steps = null;
      else if (steps !== null) steps += row.steps;
    }
    return { exerciseMinutes, steps };
  };
  const previousDaily = dailySums(previousDates);
  const previousDetail = `上周同期（${dateLabel(prevStart)}–${dateLabel(shiftDateStr(snapshot.dataDate, -7))}）：训练 ${previous.sessions} 次 · 时长 ${previous.durationMinutes === null ? "不完整" : `${Math.round(previous.durationMinutes)} 分钟`} · 力量 ${previous.strengthSessions} 次 · 容量 ${volumeLabel(previous.strengthVolume)} ${strength.displayUnit} · 运动 ${previousDaily.exerciseMinutes === null ? "未记录" : `${Math.round(previousDaily.exerciseMinutes)} 分钟`} · 步数 ${previousDaily.steps === null ? "未记录" : `${volumeLabel(previousDaily.steps)} 步`}`;
  const facts = { sufficient, reasons, previousDetail, current, previous, sessionsChangePct, durationChangePct, volumeChangePct, dayFacts };

  const hrvZ = readiness?.components.find((component) => component.key === "hrv")?.zScore ?? null;
  const restingZ = readiness?.components.find((component) => component.key === "restingHr")?.zScore ?? null;
  const debt = readiness?.sleepDebtHours ?? null;
  const pctText = (value: number) => `${value > 0 ? "+" : ""}${Math.round(value)}%`;
  // One compact line: this week's numbers, then the week-over-week
  // deltas. The previous week's absolutes live in previousDetail (the
  // expandable area under this line) and the recovery figure already
  // headlines the hero, so neither is restated here. A metric whose
  // previous window is a genuine zero gets "无基数" instead of an
  // invented percentage.
  const factsDetail = (withPct: boolean): string => {
    const main = `本周 ${current.sessions} 次 · ${current.durationMinutes === null ? "时长不完整" : `${Math.round(current.durationMinutes)} 分钟`} · 力量 ${current.strengthSessions} 次 · 容量 ${volumeLabel(current.strengthVolume)} ${strength.displayUnit}`;
    if (!withPct) return main;
    const changes: string[] = [];
    if (sessionsChangePct !== null) changes.push(`次数 ${pctText(sessionsChangePct)}`);
    else if (previous.sessions === 0) changes.push("次数无基数");
    if (durationChangePct !== null) changes.push(`时长 ${pctText(durationChangePct)}`);
    else if (previous.durationMinutes === 0) changes.push("时长无基数");
    if (volumeChangePct !== null) changes.push(`容量 ${pctText(volumeChangePct)}`);
    else if (previous.strengthVolume === 0) changes.push("容量无基数");
    return changes.length ? `${main} · 较上周 ${changes.join(" · ")}` : main;
  };

  if (!sufficient) {
    const knownParts = [
      `本周已知 ${current.sessions} 次`,
      current.durationMinutes === null ? "时长不完整" : `${Math.round(current.durationMinutes)} 分钟`,
    ];
    if (strength.updatedAt !== null) knownParts.push(`力量 ${current.strengthSessions} 次 · 容量 ${volumeLabel(current.strengthVolume)} ${strength.displayUnit}`);
    // The blocking reasons are stated once, here in the detail line;
    // the header verdict stays a short label instead of repeating the
    // first reason a second time.
    knownParts.push(`未比较：${reasons.join("；")}`);
    return { band: "slate", verdict: "数据不足，暂不比较", detail: knownParts.join(" · "), ...facts };
  }
  if (!readiness || readiness.score === null) {
    return { band: "slate", verdict: "恢复数据不足，先不下结论", detail: factsDetail(true), ...facts };
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

type SevenDayMetricKey = "exerciseMinutes" | "steps" | "hrvMs" | "restingHr";

interface SevenDayMetricDef {
  key: SevenDayMetricKey;
  label: string;
  unit: string;
  digits: number;
}

interface SevenDayCell {
  date: string;
  value: number | null;
  conflict: boolean;
}

interface SevenDayFactsResult {
  metric: SevenDayMetricDef;
  metrics: SevenDayMetricDef[];
  days: SevenDayCell[];
  covered: number;
  boundaryOk: boolean;
  boundaryNote: string | null;
  coverageIncomplete: boolean;
}

// Today's America/Los_Angeles calendar date as YYYY-MM-DD, computed via
// Intl so DST transitions and the LA midnight boundary are handled by
// the platform tz database. `now` is injectable so the computation stays
// testable around midnight and across DST; production callers use the
// default (the current instant).
function laTodayDateString(now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(now);
  const part = (type: string): string => parts.find((entry) => entry.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

// H-LOAD-001-D1: the seven-day facts strip. Pure derivation over the
// already-legal historyDaily rows only — no new data path, no scoring.
// The window is the 7 consecutive America/Los_Angeles calendar dates
// ending at dataDate (historyDaily dates are already LA calendar dates,
// so plain calendar arithmetic on the date strings is DST-safe). A day
// with no row, or a row whose metric is null, is a gap — never filled
// with 0 or interpolated; a real 0 is a value and counts as covered.
// Duplicate rows for one date: identical metric values dedupe to that
// value; any disagreement (including value vs null) marks the day
// conflict/unavailable — never summed, never max-picked. covered counts
// only days carrying a usable value. The boundary is unsatisfied when
// dataDate is not a real calendar date (no window can be anchored),
// when dataDate itself has no daily row (that day is not complete), or
// when dataDate has not strictly ended yet — a row for LA today is
// partial data for a day still in progress, and a future dataDate is a
// boundary anomaly; having a row never by itself proves the day ended.
// todayLa is the caller's LA today (see laTodayDateString); this
// function never reads the system clock, so it stays testable. The raw
// per-day values are still presented in every unsatisfied case, with
// the boundary note as the warning. Sleep is NOT offered: the legacy
// historySleeps totalHours basis is unproven. Self-contained so
// repo-side validate-seven-day-facts.mjs can extract it by name and
// run it standalone over synthetic fixtures.
function sevenDayFacts(
  historyDaily: Array<Pick<Daily, "date" | "steps" | "exerciseMinutes" | "hrvMs" | "restingHr">>,
  dataDate: string,
  coverageIncomplete: boolean,
  metricKey: SevenDayMetricKey,
  todayLa: string,
): SevenDayFactsResult {
  const defs: Record<SevenDayMetricKey, Omit<SevenDayMetricDef, "key">> = {
    exerciseMinutes: { label: "运动分钟", unit: "分钟", digits: 0 },
    steps: { label: "步数", unit: "步", digits: 0 },
    hrvMs: { label: "HRV", unit: "ms", digits: 1 },
    restingHr: { label: "静息心率", unit: "bpm", digits: 1 },
  };
  const metric: SevenDayMetricDef = { key: metricKey, ...defs[metricKey] };
  const metrics: SevenDayMetricDef[] = (Object.keys(defs) as SevenDayMetricKey[]).map((key) => ({ key, ...defs[key] }));
  const isRealDate = (value: string): boolean => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const candidate = new Date(`${value}T12:00:00Z`);
    return !Number.isNaN(candidate.getTime()) && candidate.toISOString().slice(0, 10) === value;
  };
  const validDate = isRealDate(dataDate);
  if (!validDate) {
    return {
      metric, metrics, days: [], covered: 0, boundaryOk: false,
      boundaryNote: `数据日期「${dataDate}」不合法，近 7 天窗口无法确定。`,
      coverageIncomplete,
    };
  }
  const shift = (date: string, days: number): string => {
    const shifted = new Date(`${date}T12:00:00Z`);
    shifted.setUTCDate(shifted.getUTCDate() + days);
    return shifted.toISOString().slice(0, 10);
  };
  const dates = Array.from({ length: 7 }, (_, index) => shift(dataDate, index - 6));
  const valuesByDate = new Map<string, Array<number | null>>();
  for (const row of historyDaily) {
    const list = valuesByDate.get(row.date) ?? [];
    list.push(row[metricKey]);
    valuesByDate.set(row.date, list);
  }
  const days: SevenDayCell[] = dates.map((date) => {
    const distinct = [...new Set(valuesByDate.get(date) ?? [])];
    if (distinct.length > 1) return { date, value: null, conflict: true };
    return { date, value: distinct[0] ?? null, conflict: false };
  });
  const covered = days.filter((day) => !day.conflict && day.value !== null).length;
  const hasEndRow = valuesByDate.has(dataDate);
  // Complete-day boundary: the end day must exist AND have strictly
  // ended, i.e. dataDate is before LA today. dataDate === todayLa means
  // the day is still in progress (partial); dataDate after todayLa is a
  // future-date anomaly. An unusable todayLa can never prove the day
  // ended, so it also fails the boundary.
  const boundaryOk = hasEndRow && isRealDate(todayLa) && dataDate < todayLa;
  let boundaryNote: string | null = null;
  if (!boundaryOk) {
    if (!hasEndRow) boundaryNote = "当天尚无每日记录，不作完整趋势。";
    else if (!isRealDate(todayLa)) boundaryNote = "无法确认数据日期是否已结束，以下逐日值不作为完整趋势。";
    else if (dataDate === todayLa) boundaryNote = "数据日期为今天，当天尚未结束，以下逐日值为当日未完整数据，不作为完整趋势。";
    else boundaryNote = "数据日期在未来，日期边界异常，以下逐日值不作为完整趋势。";
  }
  return {
    metric, metrics, days, covered, boundaryOk, boundaryNote,
    coverageIncomplete,
  };
}

// H3.1/H3.2/H3.3 weekly health review (first slice): a pure client-side
// derivation over the already-stored snapshot history — no server,
// schema, sync, readiness-formula, or permission change, and nothing is
// persisted. Windows are anchored on snapshot.dataDate, the most recent
// complete day (history dates are already America/Los_Angeles calendar
// dates; the current partial day never enters because dataDate is by
// definition complete): review = dataDate-6..dataDate (rolling complete
// 7 days), comparison = dataDate-13..dataDate-7, baseline =
// dataDate-34..dataDate-7 (28 days). Missing values are EXCLUDED from
// every mean — never counted as 0 — and a window with no usable value
// yields a null mean, never a fabricated one; duplicate rows for one
// date whose values disagree mark that date unusable for that metric
// (same rule as sevenDayFacts). An insight is generated only when BOTH
// windows carry >= 5 valid days AND the mean difference reaches the
// metric's pre-defined practical threshold (sleep ±30 min, HRV ±10%,
// resting HR ±3 bpm, respiratory rate ±1 /min, steps ±20%, exercise
// minutes ±30%), so a single abnormal day can never trigger one on its
// own. At most 3 insights, ordered by normalized difference magnitude.
// Self-contained (own date math, own formatting) so repo-side
// validate-week-review.mjs can extract it by name and run the real
// production function over synthetic fixtures.
//
// H3.3 multi-day support rule (fixed, explainable): the two gates above
// are NOT sufficient. A trend insight for a given comparison (versus
// the comparison window OR versus the baseline window — the same rule
// applies to both paths) additionally requires at least 3 days inside
// the review window that EACH deviate from the other window's mean by
// at least the metric's practical threshold in the SAME direction as
// the mean difference (percentage thresholds are converted against the
// other window's mean). One isolated spike day — however large — can
// lift the 7-day mean past the threshold but can never supply 3
// supporting days, so it produces no trend insight and no action. The
// spike itself is NOT removed: window means are still computed over
// every stored value exactly as recorded.
//
// H3.1 source / coverage honesty: callers may pass the snapshot's
// global coverageIncomplete flag plus the strength-training dates (a
// separate source from HealthKit, never merged into the HealthKit
// session count). Only an explicit coverageIncomplete === false may be
// described as 覆盖完整 or earn 置信度较高. true (source coverage
// incomplete, with no per-metric completeness proof) suppresses every
// trend insight and every definite training adjustment — stored facts
// (means, valid-day counts) are still presented, and the focus degrades
// to cannot-judge / keep observing. undefined (legacy payload,
// completeness unknown) likewise never claims completeness, caps
// insight confidence at 中等, and marks the completeness as unconfirmed.
// A HealthKit session count of 0 is a provable true zero ONLY when
// coverageIncomplete === false; under true/undefined it is reported as
// unknown (null) with the note 快照内 0 次，完整性未确认.
//
// H3.1 baseline-count completeness (PM re-review 2026-10-23 00:57):
// coverageIncomplete === false only proves the QUERIED range was
// complete — the refresh contract queries workouts over the latest
// 30 completed days while the baseline window reaches back 35, so a
// complete 30-day query still cannot prove a 28-day baseline total.
// The count logic therefore also checks the stored range: if the
// earliest stored daily/workout date is later than a window's start,
// that window was not fully covered by the source query and its
// count is presented as 已存 (stored) with 完整性未确认 — never as a
// total, never as a provable zero, and never baseline-sufficient.
// The stored list hitting the 100-entry schema cap is likewise
// treated as possibly truncated: totals are unprovable then too.
// H3.3 (same re-review): the multi-day support rule guards the
// REVIEW side; the comparison/baseline side gets a leave-one-out
// single-day influence check — if removing the single most
// deviating day from EITHER side drops the difference below the
// practical threshold, one isolated abnormal day is driving the
// apparent trend and no insight is generated. Sustained multi-day
// or whole-window differences survive the check on both sides.

export interface WeekReviewWindowInfo {
  start: string;
  end: string;
  days: number;
}

export interface WeekReviewMetricRow {
  key: string;
  label: string;
  unit: string;
  digits: number;
  kind: "mean" | "count";
  // Window means for kind "mean", session counts for kind "count".
  // A null mean means the window held no usable value — never a 0.
  // For kind "count" a null value means UNKNOWN, not zero: the
  // HealthKit list held no session in that window but source coverage
  // was not confirmed complete (H3.1), so a true 0 cannot be proven.
  reviewValue: number | null;
  reviewN: number;
  comparisonValue: number | null;
  comparisonN: number;
  // Null unless the baseline window carries at least 5 valid days;
  // baselineNote then reads 基线数据不足 instead of a mean.
  baselineValue: number | null;
  baselineN: number;
  baselineSufficient: boolean;
  baselineNote: string | null;
  coverageNote: string;
  // Difference of the review window against the comparison window.
  diff: number | null;
  diffSymbol: "▲" | "▼" | "—";
  diffText: string;
}

export interface WeekReviewInsight {
  metricKey: string;
  label: string;
  versus: "comparison" | "baseline";
  observation: string;
  explanation: string;
  action: string;
  confidence: "较高" | "中等";
  confidenceNote: string;
  // |diff| / practical threshold for the chosen comparison; the sort
  // key for the at-most-3 selection. Not a score and never rendered.
  magnitude: number;
}

export interface WeekReviewResult {
  valid: boolean;
  note: string | null;
  dataDate: string;
  reviewWindow: WeekReviewWindowInfo;
  comparisonWindow: WeekReviewWindowInfo;
  baselineWindow: WeekReviewWindowInfo;
  metrics: WeekReviewMetricRow[];
  insights: WeekReviewInsight[];
  canJudge: boolean;
  focus: string;
  // H3.1: the source/coverage state the caller supplied, echoed back
  // for presentation. null = completeness unknown (legacy payload or
  // no source info passed); only an explicit false means the source
  // coverage was confirmed complete.
  coverageIncomplete: boolean | null;
  coverageStatusNote: string;
  // H3.1: strength-training sessions (source: 训练记录) counted per
  // window from the dates the caller passed, kept strictly separate
  // from the HealthKit session count — never merged into one total.
  // null when the caller passed no strength dates at all.
  strengthCounts: { review: number; comparison: number; baseline: number } | null;
}

interface WeekReviewMetricDef {
  key: string;
  label: string;
  unit: string;
  digits: number;
  thresholdKind: "abs" | "pct";
  threshold: number;
  pick: (date: string) => number | null;
}

export function weekReview(
  historyDaily: Array<Pick<Daily, "date" | "steps" | "exerciseMinutes" | "hrvMs" | "restingHr" | "respiratoryRate">>,
  historySleeps: Array<Pick<Snapshot["historySleeps"][number], "date" | "totalHours">>,
  historyWorkouts: Array<Pick<Snapshot["historyWorkouts"][number], "date">>,
  dataDate: string,
  // H3.1: optional source info. Existing four-argument calls keep
  // working; an absent coverageIncomplete means completeness UNKNOWN
  // (legacy payload), which is never treated as complete.
  options?: { coverageIncomplete?: boolean; strengthDates?: string[] },
): WeekReviewResult {
  const MIN_DAYS = 5;
  // H3.3: minimum number of review-window days that must EACH reach
  // the practical threshold in the trend's direction (see the header
  // comment) before a trend insight may be generated at all.
  const MIN_SUPPORT_DAYS = 3;
  const fallbackFocus = "保持现有节奏，继续积累完整数据。";
  const coverageIncomplete: boolean | null = options?.coverageIncomplete ?? null;
  const coverageComplete = coverageIncomplete === false;
  const coverageStatusNote = coverageIncomplete === true
    ? "来源覆盖不完整：以下为已存事实，完整性未确认"
    : coverageIncomplete === null
      ? "来源完整性未确认：以下为已存事实，完整性未经确认"
      : "来源覆盖完整（已确认）";
  const shift = (date: string, days: number): string => {
    const shifted = new Date(`${date}T12:00:00Z`);
    shifted.setUTCDate(shifted.getUTCDate() + days);
    return shifted.toISOString().slice(0, 10);
  };
  const isRealDate = (value: string): boolean => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const candidate = new Date(`${value}T12:00:00Z`);
    return !Number.isNaN(candidate.getTime()) && candidate.toISOString().slice(0, 10) === value;
  };
  const fmt = (value: number, digits: number): string =>
    value.toLocaleString("zh-CN", { minimumFractionDigits: digits, maximumFractionDigits: digits });
  const md = (date: string): string => `${Number(date.slice(5, 7))}月${Number(date.slice(8, 10))}日`;
  const anchorWindow: WeekReviewWindowInfo = { start: dataDate, end: dataDate, days: 0 };
  if (!isRealDate(dataDate)) {
    return {
      valid: false,
      note: `数据日期「${dataDate}」不合法，无法确定复盘窗口。`,
      dataDate,
      reviewWindow: anchorWindow,
      comparisonWindow: anchorWindow,
      baselineWindow: anchorWindow,
      metrics: [],
      insights: [],
      canJudge: false,
      focus: fallbackFocus,
      coverageIncomplete,
      coverageStatusNote,
      strengthCounts: null,
    };
  }
  const datesBack = (count: number, endOffset: number): string[] =>
    Array.from({ length: count }, (_, index) => shift(dataDate, endOffset - (count - 1 - index)));
  const reviewDates = datesBack(7, 0);
  const comparisonDates = datesBack(7, -7);
  const baselineDates = datesBack(28, -7);

  type DailyField = "steps" | "exerciseMinutes" | "hrvMs" | "restingHr" | "respiratoryRate";
  const dailyFields: DailyField[] = ["steps", "exerciseMinutes", "hrvMs", "restingHr", "respiratoryRate"];
  const dailyByDate = new Map<string, Record<DailyField, number | null>>();
  const dailyConflicts = new Set<string>();
  for (const row of historyDaily) {
    const existing = dailyByDate.get(row.date);
    if (existing === undefined) {
      const record = {} as Record<DailyField, number | null>;
      for (const field of dailyFields) record[field] = row[field] ?? null;
      dailyByDate.set(row.date, record);
      continue;
    }
    for (const field of dailyFields) {
      if (existing[field] !== (row[field] ?? null)) dailyConflicts.add(`${row.date}|${field}`);
    }
  }
  const dailyValue = (date: string, field: DailyField): number | null => {
    if (dailyConflicts.has(`${date}|${field}`)) return null;
    return dailyByDate.get(date)?.[field] ?? null;
  };
  const sleepByDate = new Map<string, number>();
  const sleepConflicts = new Set<string>();
  for (const row of historySleeps) {
    const value = typeof row.totalHours === "number" && Number.isFinite(row.totalHours) ? row.totalHours : null;
    if (value === null) continue;
    const existing = sleepByDate.get(row.date);
    if (existing === undefined) sleepByDate.set(row.date, value);
    else if (existing !== value) sleepConflicts.add(row.date);
  }
  const sleepValue = (date: string): number | null =>
    sleepConflicts.has(date) ? null : sleepByDate.get(date) ?? null;

  // The only place window values are gathered: a day contributes its
  // value only when one is actually recorded. A missing day adds
  // nothing — it is never pushed as 0.
  const collect = (dates: string[], pick: (date: string) => number | null): number[] => {
    const values: number[] = [];
    for (const date of dates) {
      const value = pick(date);
      if (value !== null) values.push(value);
    }
    return values;
  };
  // Same gathering as collect but keeps each value's date, so the
  // H3.3 multi-day support rule can count individual review-window
  // days instead of only looking at the window mean.
  const collectDated = (dates: string[], pick: (date: string) => number | null): Array<{ date: string; value: number }> => {
    const entries: Array<{ date: string; value: number }> = [];
    for (const date of dates) {
      const value = pick(date);
      if (value !== null) entries.push({ date, value });
    }
    return entries;
  };
  const meanOf = (values: number[]): number | null =>
    values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;

  const defs: WeekReviewMetricDef[] = [
    { key: "sleep", label: "睡眠", unit: "小时", digits: 1, thresholdKind: "abs", threshold: 0.5, pick: sleepValue },
    { key: "hrv", label: "HRV", unit: "ms", digits: 1, thresholdKind: "pct", threshold: 0.1, pick: (date) => dailyValue(date, "hrvMs") },
    { key: "restingHr", label: "静息心率", unit: "bpm", digits: 1, thresholdKind: "abs", threshold: 3, pick: (date) => dailyValue(date, "restingHr") },
    { key: "respiratoryRate", label: "呼吸频率", unit: "次/分", digits: 1, thresholdKind: "abs", threshold: 1, pick: (date) => dailyValue(date, "respiratoryRate") },
    { key: "steps", label: "步数", unit: "步", digits: 0, thresholdKind: "pct", threshold: 0.2, pick: (date) => dailyValue(date, "steps") },
    { key: "exerciseMinutes", label: "运动分钟", unit: "分钟", digits: 0, thresholdKind: "pct", threshold: 0.3, pick: (date) => dailyValue(date, "exerciseMinutes") },
  ];
  // Possible explanations only: every entry is a possibility, and the
  // fixed disclaimer appended at build time states it is neither a
  // causal conclusion nor a medical judgment.
  const explanations: Record<string, { up: string; down: string }> = {
    sleep: { up: "可能与这段时间作息更规律、白天活动量或训练安排的变化有关", down: "可能与这段时间就寝时间推迟、白天活动或训练安排的变化有关" },
    hrv: { up: "可能与近期恢复更充分、训练与休息安排更均衡有关", down: "可能与近期训练负荷、睡眠或生活节奏的变化有关" },
    restingHr: { up: "可能与近期训练负荷偏高、睡眠不足或身体状态波动有关", down: "可能与近期有氧状态改善或恢复更充分有关" },
    respiratoryRate: { up: "可能与近期身体状态、睡眠环境或测量时点的变化有关", down: "可能与近期身体状态趋于平稳或睡眠环境变化有关" },
    steps: { up: "可能与这段时间出行或日常活动安排增多有关", down: "可能与这段时间出行减少或久坐安排增多有关" },
    exerciseMinutes: { up: "可能与这段时间训练或活动安排加密有关", down: "可能与这段时间训练安排减少或休息日增多有关" },
  };
  const actions: Record<string, { up: string; down: string }> = {
    sleep: { up: "保持现在的作息节奏，下周继续按同一时间上床睡觉", down: "下周把上床时间提前 15–30 分钟，先稳定一周再看变化" },
    hrv: { up: "保持当前训练与休息节奏，下周维持现有强度即可", down: "下周安排 1–2 天低强度活动（散步或轻松游泳），避免连续高强度训练" },
    restingHr: { up: "下周训练先不加量，保证睡眠与补水，继续观察一周", down: "保持现有训练与作息节奏，下周维持当前安排" },
    respiratoryRate: { up: "下周先降低训练强度并保证睡眠；若持续升高或伴随不适，请咨询医生", down: "保持现有节奏，下周继续记录观察" },
    steps: { up: "保持当前活动量，下周不要再突然加量，给身体留出恢复空间", down: "下周每天多安排一次 10 分钟步行，把日均步数慢慢补回来" },
    exerciseMinutes: { up: "下周运动量先维持不加，留出至少 1 天完整恢复日", down: "下周先恢复每周 2–3 次短时运动，不急于把量补满" },
  };
  const copyFor = (table: Record<string, { up: string; down: string }>, key: string, direction: "up" | "down", fallback: string): string =>
    table[key]?.[direction] ?? fallback;

  const diffOf = (reviewValue: number | null, comparisonValue: number | null, digits: number, unit: string): { diff: number | null; diffSymbol: "▲" | "▼" | "—"; diffText: string } => {
    if (reviewValue === null || comparisonValue === null) return { diff: null, diffSymbol: "—", diffText: "无法比较" };
    const diff = reviewValue - comparisonValue;
    if (diff === 0) return { diff, diffSymbol: "—", diffText: "持平" };
    return {
      diff,
      diffSymbol: diff > 0 ? "▲" : "▼",
      diffText: `${diff > 0 ? "增加" : "减少"} ${fmt(Math.abs(diff), digits)} ${unit}`,
    };
  };

  const metrics: WeekReviewMetricRow[] = [];
  const stats = new Map<string, { reviewMean: number; reviewN: number; reviewDated: Array<{ date: string; value: number }>; comparisonMean: number | null; comparisonN: number; comparisonDated: Array<{ date: string; value: number }>; baselineMean: number | null; baselineN: number; baselineDated: Array<{ date: string; value: number }> }>();
  for (const def of defs) {
    const reviewValues = collect(reviewDates, def.pick);
    const reviewDated = collectDated(reviewDates, def.pick);
    const comparisonValues = collect(comparisonDates, def.pick);
    const comparisonDated = collectDated(comparisonDates, def.pick);
    const baselineValues = collect(baselineDates, def.pick);
    const baselineDated = collectDated(baselineDates, def.pick);
    const reviewMean = meanOf(reviewValues);
    const comparisonMean = meanOf(comparisonValues);
    const baselineSufficient = baselineValues.length >= MIN_DAYS;
    const baselineMean = baselineSufficient ? meanOf(baselineValues) : null;
    // H3.1: a full set of stored rows is NOT proof of complete source
    // coverage. Only an explicit coverageIncomplete === false may be
    // called 覆盖完整; true always reads 来源覆盖不完整 (even with all
    // 7 rows present) and unknown completeness is named as such.
    const coverageNote = reviewValues.length === 0
      ? "无记录"
      : coverageIncomplete === true
        ? "来源覆盖不完整"
        : coverageIncomplete === null
          ? reviewValues.length === reviewDates.length
            ? "完整性未确认"
            : `缺 ${reviewDates.length - reviewValues.length} 天记录 · 完整性未确认`
          : reviewValues.length === reviewDates.length
            ? "覆盖完整"
            : `缺 ${reviewDates.length - reviewValues.length} 天记录`;
    const baselineNote = !baselineSufficient
      ? "基线数据不足"
      : def.key === "sleep" && baselineValues.length < baselineDates.length
        ? `睡眠历史仅保留近 14 晚，基线可用 ${baselineValues.length} 晚`
        : null;
    const d = diffOf(reviewMean, comparisonMean, def.digits, def.unit);
    metrics.push({
      key: def.key, label: def.label, unit: def.unit, digits: def.digits, kind: "mean",
      reviewValue: reviewMean, reviewN: reviewValues.length,
      comparisonValue: comparisonMean, comparisonN: comparisonValues.length,
      baselineValue: baselineMean, baselineN: baselineValues.length,
      baselineSufficient, baselineNote, coverageNote,
      diff: d.diff, diffSymbol: d.diffSymbol, diffText: d.diffText,
    });
    if (reviewMean !== null) {
      stats.set(def.key, {
        reviewMean, reviewN: reviewValues.length, reviewDated,
        comparisonMean, comparisonN: comparisonValues.length, comparisonDated,
        baselineMean, baselineN: baselineValues.length, baselineDated,
      });
    }
  }

  // Training sessions are counted per window from historyWorkouts
  // (HealthKit) — a count, not a mean, so it never feeds an insight.
  // H3.1: this count is labelled with its source and never stands for
  // ALL training — strength training lives in a separate source (see
  // strengthCounts below) and the two are never merged into one total.
  const countSessions = (dates: string[]): { sessions: number; days: number } => {
    const inWindow = new Set(dates);
    let sessions = 0;
    const days = new Set<string>();
    for (const workout of historyWorkouts) {
      if (!inWindow.has(workout.date)) continue;
      sessions += 1;
      days.add(workout.date);
    }
    return { sessions, days: days.size };
  };
  const reviewWorkouts = countSessions(reviewDates);
  const comparisonWorkouts = countSessions(comparisonDates);
  const baselineWorkouts = countSessions(baselineDates);
  // H3.1 count trust rule: an empty HealthKit list is a provable true
  // 0 ONLY when coverageIncomplete is explicitly false. When coverage
  // is incomplete (true) or unknown (undefined), a stored 0 is
  // reported as unknown (null) — never as a definite 0 — and the
  // baseline is not marked sufficient on the strength of it.
  // H3.1 (PM 2026-10-23): completeness of the QUERIED range is not
  // completeness of the WINDOW. The source query span is evidenced by
  // the stored data itself: the earliest stored daily/workout date.
  // A window whose start predates that earliest date was only partly
  // queried, so its count is a stored count （已存）, not a total —
  // a stored 0 there is unknown, a stored N is labelled 已存 with
  // 完整性未确认， and the baseline is not sufficient. A list at the
  // 100-entry schema cap may be truncated and proves no total either.
  // With no stored rows at all there is no range evidence either way
  // and the coverageComplete rule above decides alone.
  const storedRangeStart = (() => {
    let earliest: string | null = null;
    for (const row of historyDaily) if (earliest === null || row.date < earliest) earliest = row.date;
    for (const workout of historyWorkouts) if (earliest === null || workout.date < earliest) earliest = workout.date;
    return earliest;
  })();
  const listAtCap = historyWorkouts.length >= 100;
  const windowRangeCovered = (dates: string[]): boolean =>
    !listAtCap && (storedRangeStart === null || (dates.length > 0 && storedRangeStart <= (dates[0] ?? "")));
  const reviewRangeCovered = windowRangeCovered(reviewDates);
  const comparisonRangeCovered = windowRangeCovered(comparisonDates);
  const baselineRangeCovered = windowRangeCovered(baselineDates);
  const trustedCount = (sessions: number, rangeCovered: boolean): number | null =>
    sessions === 0 && !(coverageComplete && rangeCovered) ? null : sessions;
  const reviewWorkoutValue = trustedCount(reviewWorkouts.sessions, reviewRangeCovered);
  const comparisonWorkoutValue = trustedCount(comparisonWorkouts.sessions, comparisonRangeCovered);
  const baselineWorkoutValue = trustedCount(baselineWorkouts.sessions, baselineRangeCovered);
  const workoutDiff = diffOf(reviewWorkoutValue, comparisonWorkoutValue, 0, "次");
  metrics.push({
    key: "workouts", label: "运动次数（HealthKit 来源）", unit: "次", digits: 0, kind: "count",
    reviewValue: reviewWorkoutValue, reviewN: reviewWorkouts.days,
    comparisonValue: comparisonWorkoutValue, comparisonN: comparisonWorkouts.days,
    baselineValue: baselineWorkoutValue, baselineN: baselineWorkouts.days,
    baselineSufficient: baselineWorkoutValue !== null && baselineRangeCovered,
    baselineNote: !baselineRangeCovered
      ? `基线窗内已存 ${baselineWorkouts.sessions} 次，完整性未确认（来源查询范围未覆盖基线窗全程${listAtCap ? "，且列表已达 100 条上限" : ""}）`
      : baselineWorkoutValue === null
        ? "快照内 0 次，完整性未确认"
        : `基线窗 28 天共 ${baselineWorkouts.sessions} 次`,
    coverageNote: reviewWorkoutValue === null
      ? "快照内 0 次，完整性未确认"
      : `复盘窗 ${reviewWorkouts.days}/7 天有训练记录（HealthKit）`,
    diff: workoutDiff.diff, diffSymbol: workoutDiff.diffSymbol, diffText: workoutDiff.diffText,
  });

  // H3.1: strength-training sessions per window, counted from the
  // caller-supplied dates (snapshot.strengthTraining.workouts). Each
  // supplied date is one stored session. Presented separately from
  // the HealthKit count above; the two sources are never summed and
  // no combined total is inferred.
  const strengthDates = options?.strengthDates;
  const strengthCounts: WeekReviewResult["strengthCounts"] = strengthDates === undefined
    ? null
    : {
        review: strengthDates.filter((date) => reviewDates.includes(date)).length,
        comparison: strengthDates.filter((date) => comparisonDates.includes(date)).length,
        baseline: strengthDates.filter((date) => baselineDates.includes(date)).length,
      };

  const candidates: WeekReviewInsight[] = [];
  const reviewStart = reviewDates[0] ?? dataDate;
  const reviewEnd = reviewDates[reviewDates.length - 1] ?? dataDate;
  // H3.1: with source coverage incomplete (coverageIncomplete ===
  // true) and no per-metric completeness proof, NO definite training
  // adjustment may be derived — the candidate loop is skipped whole,
  // the stored per-metric facts above are still presented, and the
  // focus below degrades to cannot-judge / keep observing.
  for (const def of coverageIncomplete === true ? [] : defs) {
    const stat = stats.get(def.key);
    if (stat === undefined) continue;
    const reviewMean = stat.reviewMean;
    const versusWindows = [
      { versus: "comparison" as const, label: "前 7 天", mean: stat.comparisonMean, n: stat.comparisonN, days: comparisonDates.length, start: comparisonDates[0] ?? dataDate, end: comparisonDates[comparisonDates.length - 1] ?? dataDate, dated: stat.comparisonDated },
      { versus: "baseline" as const, label: "28 天基线", mean: stat.baselineMean, n: stat.baselineN, days: baselineDates.length, start: baselineDates[0] ?? dataDate, end: baselineDates[baselineDates.length - 1] ?? dataDate, dated: stat.baselineDated },
    ];
    let best: WeekReviewInsight | null = null;
    for (const other of versusWindows) {
      const otherMean = other.mean;
      if (otherMean === null) continue;
      if (stat.reviewN < MIN_DAYS || other.n < MIN_DAYS) continue;
      const diff = reviewMean - otherMean;
      const thresholdAbs = def.thresholdKind === "abs" ? def.threshold : def.threshold * otherMean;
      if (thresholdAbs <= 0) continue;
      if (Math.abs(diff) < thresholdAbs) continue;
      // H3.3 multi-day support: at least MIN_SUPPORT_DAYS (3) days in
      // the review window must EACH deviate from this window's mean by
      // >= the practical threshold in the same direction as the mean
      // difference. An isolated 1-day spike (either direction) that
      // drags the mean past the threshold fails here and yields no
      // trend insight and no action; 3+ same-direction days, or a
      // whole week shifted, still pass. Applies identically to the
      // comparison-window and baseline-window paths.
      const directionSign = diff > 0 ? 1 : -1;
      const supportDays = stat.reviewDated.filter((entry) => {
        const deviation = entry.value - otherMean;
        return deviation * directionSign > 0 && Math.abs(deviation) >= thresholdAbs;
      }).length;
      if (supportDays < MIN_SUPPORT_DAYS) continue;
      // H3.3 leave-one-out influence check, applied to BOTH windows:
      // removing the single most influential day from either side
      // must leave a difference that still reaches the practical
      // threshold — percentage thresholds recomputed against the
      // post-removal other-window mean — and keeps its direction.
      // (Checking every single-day removal is equivalent: the mean
      // moves monotonically with the removed value, so the removal
      // that hurts the difference most is the binding one.) An
      // isolated abnormal day on the comparison or baseline side —
      // invisible to the review-side support rule above — fails
      // here, so it generates no insight and no action. The stored
      // values themselves are untouched: every mean and count above
      // still includes the day exactly as recorded. Three-plus
      // consecutive same-direction days and a whole shifted week
      // survive, because no single removal collapses them.
      const reviewValuesOnly = stat.reviewDated.map((entry) => entry.value);
      const otherValuesOnly = other.dated.map((entry) => entry.value);
      const looHolds = (rMean: number, oMean: number): boolean => {
        const looDiff = rMean - oMean;
        if (looDiff === 0 || (looDiff > 0) !== (directionSign > 0)) return false;
        const looThreshold = def.thresholdKind === "abs" ? def.threshold : def.threshold * oMean;
        return looThreshold > 0 && Math.abs(looDiff) >= looThreshold;
      };
      let looSurvives = true;
      for (let i = 0; i < reviewValuesOnly.length && looSurvives; i++) {
        const restMean = meanOf(reviewValuesOnly.filter((_, j) => j !== i));
        if (restMean === null || !looHolds(restMean, otherMean)) looSurvives = false;
      }
      for (let i = 0; i < otherValuesOnly.length && looSurvives; i++) {
        const restMean = meanOf(otherValuesOnly.filter((_, j) => j !== i));
        if (restMean === null || !looHolds(reviewMean, restMean)) looSurvives = false;
      }
      if (!looSurvives) continue;
      const magnitude = Math.abs(diff) / thresholdAbs;
      const direction: "up" | "down" = diff > 0 ? "up" : "down";
      const pctText = otherMean > 0 ? `（约 ${diff > 0 ? "+" : "−"}${fmt(Math.abs(diff / otherMean) * 100, 0)}%）` : "";
      const observation = `${def.label}：复盘窗（${md(reviewStart)}–${md(reviewEnd)}）均值 ${fmt(reviewMean, def.digits)} ${def.unit}，${other.label}（${md(other.start)}–${md(other.end)}）均值 ${fmt(otherMean, def.digits)} ${def.unit}，${direction === "up" ? "增加" : "减少"} ${fmt(Math.abs(diff), def.digits)} ${def.unit}${pctText}。`;
      // H3.1: 置信度较高 requires BOTH windows fully covered AND an
      // explicitly confirmed-complete source (coverageIncomplete ===
      // false). Unknown completeness caps confidence at 中等 and the
      // note says the completeness is unconfirmed.
      const confidence: "较高" | "中等" = coverageComplete && stat.reviewN === reviewDates.length && other.n === other.days ? "较高" : "中等";
      const insight: WeekReviewInsight = {
        metricKey: def.key,
        label: def.label,
        versus: other.versus,
        observation,
        explanation: `${copyFor(explanations, def.key, direction, "可能与近期生活与训练安排的变化有关")}；这只是可能性，不是因果结论，也不是医疗判断。`,
        action: copyFor(actions, def.key, direction, "保持现有节奏，下周继续观察。"),
        confidence,
        confidenceNote: `复盘窗有效 ${stat.reviewN}/${reviewDates.length} 天 · 对照窗有效 ${other.n}/${other.days} 天 · 复盘窗 ${supportDays} 天单独达到同向实用差异（趋势洞察要求至少 ${MIN_SUPPORT_DAYS} 天，单日异常不触发） · 已做两侧留一单日影响检查${coverageComplete ? "" : " · 完整性未确认"}`,
        magnitude,
      };
      if (best === null || insight.magnitude > best.magnitude) best = insight;
    }
    if (best !== null) candidates.push(best);
  }
  candidates.sort((a, b) => b.magnitude - a.magnitude);
  const insights = candidates.slice(0, 3);
  return {
    valid: true,
    note: null,
    dataDate,
    reviewWindow: { start: reviewStart, end: reviewEnd, days: reviewDates.length },
    comparisonWindow: { start: comparisonDates[0] ?? dataDate, end: comparisonDates[comparisonDates.length - 1] ?? dataDate, days: comparisonDates.length },
    baselineWindow: { start: baselineDates[0] ?? dataDate, end: baselineDates[baselineDates.length - 1] ?? dataDate, days: baselineDates.length },
    metrics,
    insights,
    canJudge: insights.length > 0,
    // H3.1: under incomplete source coverage the focus must not land
    // on a definite training action — it degrades to cannot-judge /
    // keep observing while the stored facts above remain visible.
    focus: coverageIncomplete === true
      ? "来源覆盖不完整，无法据此判断下周训练安排：先保持现有节奏，继续观察，等数据补全后再判断。"
      : insights[0]?.action ?? fallbackFocus,
    coverageIncomplete,
    coverageStatusNote,
    strengthCounts,
  };
}

type HeroActionKind = "sync-health" | "sync-strength" | "view-status";

interface HeroSourceStatus {
  dataDateLine: string;
  healthLine: string;
  strengthLine: string;
  coverageLine: string | null;
  action: { kind: HeroActionKind; label: string };
}

// Pure derivation of the hero's source-status strip: which day the numbers
// describe, how fresh each source is, and the single next action worth
// offering. The data date (snapshot.dataDate, the most recent complete day)
// and the readiness reference date are different clocks and are never
// merged into one date. Freshness wording matches freshnessLabel and the
// update-time format matches updatedLabel; both are inlined so this
// function stays self-contained and can be extracted from this file by
// name and run standalone (repo-side validate-hero-status.mjs does that).
// Nothing is guessed: a null dataStatus means both sources are unknown
// and the action falls back to retrying the health sync.
function heroSourceStatus(snapshot: Snapshot, readiness: Readiness | null, dataStatus: DataStatus | null): HeroSourceStatus {
  const dataDate = snapshot.dataDate;
  const dataDateLine = readiness === null
    ? `数据日期 ${dataDate}（最近完整日）`
    : readiness.date === dataDate
      ? `数据日期 ${dataDate}（最近完整日）· 恢复参考同日`
      : `数据日期 ${dataDate}（最近完整日）· 恢复参考日期 ${readiness.date}`;
  const freshnessText = (freshness: DataStatus["health"]["freshness"]): string =>
    freshness === "fresh" ? "新鲜" : freshness === "today" ? "今天更新" : freshness === "stale" ? "已过期" : "还没有";
  const updatedText = (value: string): string => {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    return new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(date);
  };
  const sourceLine = (source: DataStatus["health"] | DataStatus["strength"] | undefined): string => {
    if (source === undefined) return "来源状态未知";
    // A missing source shows the server-provided detail verbatim: it
    // distinguishes "never synced" from "snapshot damaged, resync" —
    // collapsing both to one "not synced" wording would hide damage.
    if (source.freshness === "missing") return source.detail ? source.detail : "尚未同步";
    return `${freshnessText(source.freshness)} · ${source.updatedAt ? `更新于 ${updatedText(source.updatedAt)}` : "尚未同步"}`;
  };
  const healthLine = sourceLine(dataStatus?.health);
  const strengthLine = sourceLine(dataStatus?.strength);
  // A fresh update timestamp does not mean the health data is complete:
  // the hero flags the gap with a short chip ("覆盖不完整") so it is not
  // misread as whole; the per-date gaps are named in the panels below.
  // The flag is also set when only this morning's partial day is still
  // arriving, so the chip never claims a sync is in progress.
  const coverageLine = snapshot.coverageIncomplete
    ? "覆盖不完整"
    : null;
  const healthStale = dataStatus === null || dataStatus.health.freshness === "missing" || dataStatus.health.freshness === "stale";
  const strengthStale = dataStatus !== null && (dataStatus.strength.freshness === "missing" || dataStatus.strength.freshness === "stale");
  const action: HeroSourceStatus["action"] = readiness === null || healthStale
    ? { kind: "sync-health", label: "重新同步健康数据" }
    : strengthStale
      ? { kind: "sync-strength", label: "同步训练记录" }
      : { kind: "view-status", label: "查看数据状态" };
  return { dataDateLine, healthLine, strengthLine, coverageLine, action };
}

function ScoreRing({ label, score, suffix, bandKind }: { label: string; score: WhoopScore; suffix: string; bandKind: "recovery" | "strain" }) {
  const radius = 40;
  const circumference = 2 * Math.PI * radius;
  const filled = score.pct === null ? 0 : score.pct / 100;
  return (
    <div className={`whoop-score whoop-${score.band}`}>
      <div className="whoop-ring" role="img" aria-label={`${label} ${score.display}${suffix}，${score.bandLabel}${score.detail ? `。${score.detail}` : ""}`}>
        <svg viewBox="0 0 96 96" aria-hidden="true">
          <circle className="whoop-ring-track" cx="48" cy="48" r={radius} />
          <circle className="whoop-ring-value" cx="48" cy="48" r={radius} strokeDasharray={circumference} strokeDashoffset={circumference * (1 - filled)} />
        </svg>
        <div className="whoop-ring-center"><strong>{score.display}</strong><span>{suffix}</span></div>
      </div>
      <span className="whoop-score-label">{label}</span>
      <span className="whoop-band-label"><span className="band-symbol" aria-hidden="true">{bandSymbol(score.band)}</span> {score.bandLabel}</span>
      <div className={`whoop-band ${bandKind === "strain" ? "whoop-band-strain" : ""}`} aria-hidden="true">{score.pct === null ? null : <i style={{ left: `${score.pct}%` }} />}</div>
      <div className="whoop-band-zones" aria-hidden="true">{bandKind === "strain" ? <><span>轻</span><span>中</span><span>高</span><span>全力</span></> : <><span>低</span><span>中</span><span>高</span></>}</div>
      {score.detail ? <p>{score.detail}</p> : null}
    </div>
  );
}

// One-word freshness for the hero's single source line; the full
// per-source wording (with update times) lives in the 数据状态 panel.
function freshnessShort(freshness: DataStatus["health"]["freshness"] | undefined): string {
  if (freshness === undefined) return "未知";
  if (freshness === "fresh") return "新鲜";
  if (freshness === "today") return "今天更新";
  if (freshness === "stale") return "已过期";
  return "未同步";
}

function WhoopHero({ snapshot, readiness, readinessHistory, dataStatus, focusFeedback, focusReadFailed, onSyncHealth, onSyncStrength, syncing }: {
  snapshot: Snapshot; readiness: Readiness | null; readinessHistory: ReadinessHistoryPoint[]; dataStatus: DataStatus | null;
  focusFeedback: FocusFeedbackData; focusReadFailed: boolean;
  onSyncHealth: () => void; onSyncStrength: () => void; syncing: boolean;
}) {
  const recovery = recoveryScore(readiness);
  const sleep = sleepScore(snapshot, readiness);
  const facts = strainFacts(snapshot);
  const strain = strainScore(snapshot);
  const load = weekLoad(snapshot, readiness);
  const sleepHours = actualSleepHours(snapshot.sleep);
  const source = heroSourceStatus(snapshot, readiness, dataStatus);
  const handleSourceAction = () => {
    if (source.action.kind === "sync-health") onSyncHealth();
    else if (source.action.kind === "sync-strength") onSyncStrength();
    else document.getElementById("data-status-panel")?.scrollIntoView({ behavior: "smooth", block: "start" });
  };
  return (
    <section className="whoop-hero" aria-labelledby="whoop-title">
      <div className="whoop-source-bar">
        <p className="whoop-source-line">
          <strong>{dateLabel(snapshot.dataDate)}</strong>
          <span>健康 {freshnessShort(dataStatus?.health.freshness)}</span>
          <span>训练 {freshnessShort(dataStatus?.strength.freshness)}</span>
          {source.coverageLine ? <span className="whoop-source-coverage">{source.coverageLine}</span> : null}
        </p>
        <button className="whoop-source-action" type="button" aria-label={source.action.label} onClick={handleSourceAction} disabled={syncing}>{syncing ? "同步中…" : source.action.label}</button>
      </div>
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
        {strain.computable ? (
          <ScoreRing label="负荷" score={strain} suffix="/ 21" bandKind="strain" />
        ) : (
          <div className="whoop-score whoop-slate">
            <div className="whoop-fact-tile" role="img" aria-label={`负荷，${dateLabel(snapshot.dataDate)} 活动事实：运动 ${facts.exerciseMinutes === null ? "未记录" : `${Math.round(facts.exerciseMinutes)} 分钟`}，${facts.detail}`}>
              <strong>{facts.exerciseMinutes === null ? "—" : Math.round(facts.exerciseMinutes)}</strong>
              <span>{facts.exerciseMinutes === null ? "运动时长未记录" : "分钟 · 运动"}</span>
              <small>{facts.detail}</small>
            </div>
            <span className="whoop-score-label">负荷</span>
            <span className="whoop-band-label"><span className="band-symbol" aria-hidden="true">{bandSymbol(strain.band)}</span> {strain.bandLabel}</span>
            <p>{strain.detail}</p>
          </div>
        )}
      </div>
      <details className="whoop-strain-note">
        <summary>负荷口径 · Banister TRIMP</summary>
        <p>
          单次负荷 = 时长（分）× ΔHR × 0.64·e^(1.92·ΔHR)，ΔHR =（平均心率 − 静息心率）÷（最高心率 − 静息心率），当日各次运动求和；0–21 分为饱和映射 21×(1 − e^(−TRIMP/150))，分档参照 Whoop 公布标准（轻 0–9 · 中 10–13 · 高 14–17 · 全力 18–21）。Whoop 与 Garmin 的原始公式均未公开，此分不冒充任何一家的官方分数；原始 TRIMP 值见负荷环下。{strain.hrMaxBpm !== null ? `本次最高心率取近 30 天实测最大值 ${Math.round(strain.hrMaxBpm)} bpm。` : ""}来源：
          <a href="https://www.whoop.com/us/en/thelocker/how-does-whoop-strain-work-101/" target="_blank" rel="noreferrer">Whoop Strain 说明</a>
          {" · "}
          <a href="https://pmc.ncbi.nlm.nih.gov/articles/PMC6162408/" target="_blank" rel="noreferrer">TRIMP 方法综述</a>
        </p>
      </details>
      <div className="whoop-drivers">
        <div><span>HRV</span><strong>{snapshot.hrv.value === null ? "—" : `${numberLabel(snapshot.hrv.value, 1)} ms`}</strong></div>
        <div><span>静息心率</span><strong>{snapshot.restingHr.value === null ? "—" : `${numberLabel(snapshot.restingHr.value, 1)} bpm`}</strong></div>
        <div><span>昨晚睡眠</span><strong>{hasSleepSession(snapshot) ? `${sleepHours.toFixed(1)} h` : "—"}</strong></div>
        <div><span>睡眠债</span><strong>{readiness?.sleepDebtHours === null || readiness?.sleepDebtHours === undefined ? "—" : `${readiness.sleepDebtHours.toFixed(1)} h`}</strong></div>
      </div>
      <div className={`whoop-load whoop-${load.band}`}>
        <div className="whoop-load-head"><span>本周负荷 vs 恢复</span><strong><span className="band-symbol" aria-hidden="true">{bandSymbol(load.band)}</span> {load.verdict}</strong></div>
        <p>{load.detail}</p>
        <details>
          <summary className="whoop-load-note">上周同期数据</summary>
          <p>{load.previousDetail}</p>
        </details>
        {readinessHistory.length ? (
          <>
            <div className="whoop-readiness-trend" aria-label="readiness 近 7 天趋势">
              <span className="whoop-trend-label">readiness 近 7 天</span>
              {readinessHistory.map((point) => (
                <span className="whoop-trend-point" key={point.date}>{dateLabel(point.date)} {point.score === null ? "—" : point.score.toFixed(1)}</span>
              ))}
            </div>
            <p className="whoop-load-note">readiness 近 7 天：有存档的日期显示当日分数；无存档的日期历史未提供，显示缺口，不复制今日值。存档自上线日起逐日积累，旧日期不回补。</p>
          </>
        ) : null}
      </div>
      <SevenDayFacts snapshot={snapshot} />
      <WeekReviewPanel snapshot={snapshot} focusFeedback={focusFeedback} focusReadFailed={focusReadFailed} />
    </section>
  );
}

// H-LOAD-001-D1: raw per-day facts for the 7 LA calendar days ending at
// dataDate, rendered next to the load verdict. Switching the metric only
// swaps the values and unit; tapping a day expands just that day's raw
// value, unit, source, and update time. Daily rows carry no per-day
// source or timestamp fields, so the detail says so instead of inventing
// them (the snapshot-level source and update time are labelled as such).
function SevenDayFacts({ snapshot }: { snapshot: Snapshot }) {
  const [metricKey, setMetricKey] = useState<SevenDayMetricKey>("exerciseMinutes");
  const [openDate, setOpenDate] = useState<string | null>(null);
  const facts = sevenDayFacts(snapshot.historyDaily, snapshot.dataDate, snapshot.coverageIncomplete, metricKey, laTodayDateString());
  const openCell = openDate === null ? undefined : facts.days.find((day) => day.date === openDate);
  const cellText = (day: SevenDayCell): string => day.conflict ? "冲突/不可用" : day.value === null ? "无记录" : `${numberLabel(day.value, facts.metric.digits)} ${facts.metric.unit}`;
  return (
    <div className="seven-facts" aria-label="近 7 天事实">
      <div className="seven-facts-head">
        <span>近 7 天</span>
        <span className="seven-facts-coverage">覆盖 {facts.covered}/7 天</span>
      </div>
      <div className="seven-facts-switch" role="group" aria-label="切换近 7 天事实指标">
        {facts.metrics.map((metric) => (
          <button
            key={metric.key}
            type="button"
            className={metric.key === metricKey ? "selected" : ""}
            aria-pressed={metric.key === metricKey}
            aria-label={`查看${metric.label}`}
            onClick={() => setMetricKey(metric.key)}
          >{metric.label}</button>
        ))}
      </div>
      {facts.boundaryNote ? <p className="seven-facts-warn">{facts.boundaryNote}</p> : null}
      {facts.coverageIncomplete ? <p className="seven-facts-warn">来源覆盖不完整，缺口如实标注。</p> : null}
      {facts.days.length ? (
        <div className="seven-facts-grid">
          {facts.days.map((day) => (
            <button
              key={day.date}
              type="button"
              className={`seven-facts-day${day.conflict ? " conflict" : ""}${!day.conflict && day.value === null ? " gap" : ""}`}
              aria-expanded={openDate === day.date}
              aria-label={`${fullDateLabel(day.date)} ${facts.metric.label} ${cellText(day)}`}
              onClick={() => setOpenDate(openDate === day.date ? null : day.date)}
            >
              <span>{dateLabel(day.date)}</span>
              <strong>{day.conflict ? "冲突" : day.value === null ? "缺口" : numberLabel(day.value, facts.metric.digits)}</strong>
              <small>{day.conflict ? "不可用" : day.value === null ? "无记录" : facts.metric.unit}</small>
            </button>
          ))}
        </div>
      ) : null}
      {openCell ? (
        <dl className="seven-facts-detail">
          <div><dt>日期</dt><dd>{fullDateLabel(openCell.date)}</dd></div>
          <div><dt>{facts.metric.label}原值</dt><dd>{openCell.conflict ? "冲突/不可用（同日记录不一致，未合并）" : cellText(openCell)}</dd></div>
          <div><dt>来源 · 更新</dt><dd>Apple 健康 · 快照更新于 {updatedLabel(snapshot.updatedAt)}</dd></div>
        </dl>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// H3.5: pure save-state machine for the week-review focus feedback card.
// No React, no I/O — the panel feeds it server reads and save outcomes
// and renders whatever state comes back; repo validators extract these
// functions by name and run them standalone.
//
// boundKey is the focus identity the card is bound to: review-window
// start + end + health snapshot version — the same string the server
// computes its focus_key from. confirmed is the last server-confirmed
// feedback for that key (or a save this machine has seen succeed);
// selection is what the card currently shows as chosen; status is the
// save lifecycle. The two guards that matter:
//  - a save callback only lands when the key it was started for still
//    equals boundKey: a late success for a previous window/snapshot can
//    never stamp its choice onto the new focus;
//  - a failed re-read (readFailed) never overwrites a known confirmed
//    value with "not yet given" — the unknown stays visibly unknown.

export type FocusFeedbackChoice = "有帮助" | "不适用";
export type FocusFeedbackSaveStatus = "idle" | "saving" | "saved" | "error";

export interface FocusFeedbackState {
  boundKey: string | null;
  confirmed: FocusFeedbackChoice | null;
  selection: FocusFeedbackChoice | null;
  status: FocusFeedbackSaveStatus;
  readFailed: boolean;
}

export function focusFeedbackKey(windowStart: string, windowEnd: string, snapshotVersion: string): string {
  return `${windowStart}|${windowEnd}|${snapshotVersion}`;
}

export function createFocusFeedbackState(): FocusFeedbackState {
  return { boundKey: null, confirmed: null, selection: null, status: "idle", readFailed: false };
}

// Bind the card to a (possibly new) focus identity and merge the latest
// server read. A different key starts a fresh card state from the
// server row for THAT key — feedback never migrates across windows or
// snapshot versions, even when the focus wording is identical. On the
// same key, a failed re-read keeps the previously confirmed value and
// flags readFailed; a successful re-read updates confirmed but never
// clobbers an in-flight save or an unsaved choice awaiting retry.
export function syncFocusFeedbackState(
  state: FocusFeedbackState,
  boundKey: string,
  serverConfirmed: FocusFeedbackChoice | null,
  readFailed: boolean,
): FocusFeedbackState {
  if (state.boundKey !== boundKey) {
    return { boundKey, confirmed: serverConfirmed, selection: serverConfirmed, status: serverConfirmed ? "saved" : "idle", readFailed };
  }
  if (readFailed) return { ...state, readFailed: true };
  if (state.status === "saving" || state.status === "error") {
    return { ...state, confirmed: serverConfirmed, readFailed: false };
  }
  return { boundKey, confirmed: serverConfirmed, selection: serverConfirmed, status: serverConfirmed ? "saved" : "idle", readFailed: false };
}

// The owner tapped a feedback choice: show it immediately and mark the
// save in flight. Choosing the other option is the same transition
// (re-selection re-saves under the same key).
export function beginFocusFeedbackSave(state: FocusFeedbackState, choice: FocusFeedbackChoice): FocusFeedbackState {
  return { ...state, selection: choice, status: "saving" };
}

// A save resolved. It lands only when the key it was started for is
// still the card's bound key; a stale callback for a previous
// window/snapshot is dropped whole.
export function completeFocusFeedbackSave(state: FocusFeedbackState, boundKey: string, choice: FocusFeedbackChoice): FocusFeedbackState {
  if (state.boundKey !== boundKey) return state;
  return { boundKey, confirmed: choice, selection: choice, status: "saved", readFailed: false };
}

// A save failed: keep the attempted choice on screen and mark it
// unsaved, so the card can offer a retry of the same key + choice.
export function failFocusFeedbackSave(state: FocusFeedbackState, boundKey: string): FocusFeedbackState {
  if (state.boundKey !== boundKey) return state;
  return { ...state, status: "error" };
}

// H3.1/H3.2/H3.3: the weekly review panel on the 今日 page, rendered
// inside the hero after the load verdict block and the seven-day facts
// strip. Every number comes from the weekReview derivation above;
// nothing is scored or graded. H3.5 adds the persisted focus feedback
// loop at the end of the panel: the owner can mark the single derived
// focus 有帮助 / 不适用 (owner-only server action, keyed by window +
// snapshot version), and the previous window's focus rolls back in a
// collapsed look-back below. Feedback is an applicability opinion only
// — it changes no plan, score, XP/gold, or training record.
// Direction is always carried by the ▲/▼/— symbol plus 增加/减少/持平
// wording, never by color alone.
function WeekReviewPanel({ snapshot, focusFeedback, focusReadFailed }: { snapshot: Snapshot; focusFeedback: FocusFeedbackData; focusReadFailed: boolean }) {
  const queryClient = useQueryClient();
  const review = useMemo(
    () => weekReview(snapshot.historyDaily, snapshot.historySleeps, snapshot.historyWorkouts, snapshot.dataDate, {
      coverageIncomplete: snapshot.coverageIncomplete,
      strengthDates: snapshot.strengthTraining.workouts.map((workout) => workout.date),
    }),
    [snapshot],
  );
  // The card's focus identity: this review window of this snapshot
  // version — the same identity the server keys stored feedback by.
  const cardKey = focusFeedbackKey(review.reviewWindow.start, review.reviewWindow.end, snapshot.updatedAt);
  const serverConfirmed: FocusFeedbackChoice | null =
    focusFeedback.current && focusFeedback.current.focusKey === cardKey ? focusFeedback.current.feedback : null;
  const [feedbackState, setFeedbackState] = useState<FocusFeedbackState>(() => createFocusFeedbackState());
  useEffect(() => {
    setFeedbackState((prev) => syncFocusFeedbackState(prev, cardKey, serverConfirmed, focusReadFailed));
  }, [cardKey, serverConfirmed, focusReadFailed]);
  // The save-time basis snapshot: already-derived facts only (coverage
  // status, first insight label + confidence) as a text summary — the
  // same wording family the panel itself shows.
  const firstInsight = review.insights[0];
  const basisText = [
    review.coverageStatusNote,
    firstInsight ? `首条洞察：${firstInsight.label}（置信度${firstInsight.confidence}）` : "无可用洞察",
  ].join(" · ");
  const saveFeedback = useMutation({
    mutationFn: (vars: { key: string; choice: FocusFeedbackChoice }) => api.saveWeekFocusFeedback({
      windowStart: review.reviewWindow.start,
      windowEnd: review.reviewWindow.end,
      focusText: review.focus,
      basisText,
      snapshotVersion: snapshot.updatedAt,
      feedback: vars.choice,
    }),
    onSuccess: (result, vars) => {
      if (result.ok) {
        setFeedbackState((prev) => completeFocusFeedbackSave(prev, vars.key, vars.choice));
        void queryClient.invalidateQueries({ queryKey: ["dashboard"] });
      } else {
        setFeedbackState((prev) => failFocusFeedbackSave(prev, vars.key));
      }
    },
    onError: (_error, vars) => setFeedbackState((prev) => failFocusFeedbackSave(prev, vars.key)),
  });
  const chooseFeedback = (choice: FocusFeedbackChoice) => {
    setFeedbackState((prev) => beginFocusFeedbackSave(prev, choice));
    saveFeedback.mutate({ key: cardKey, choice });
  };
  const retryFeedback = () => {
    if (feedbackState.selection) chooseFeedback(feedbackState.selection);
  };
  const feedbackStatusText = feedbackState.status === "saving"
    ? "保存中…"
    : feedbackState.status === "error"
      ? "未保存：这次反馈还没有记下来。"
      : feedbackState.readFailed
        ? feedbackState.confirmed
          ? `读取失败：暂时读不到最新状态，上次保存的反馈是「${feedbackState.confirmed}」。`
          : "读取失败：暂时无法确认反馈状态。"
        : feedbackState.selection
          ? `已反馈：${feedbackState.selection}`
          : "尚未反馈";
  const valueText = (metric: WeekReviewMetricRow, value: number | null): string => {
    if (value === null) return metric.kind === "count" ? "未知" : "—／无记录";
    return metric.kind === "count" ? `${value} 次` : `${numberLabel(value, metric.digits)} ${metric.unit}`;
  };
  return (
    <section className="week-review" aria-labelledby="week-review-title">
      <h2 id="week-review-title" className="week-review-title">上周复盘 · 滚动 7 天</h2>
      {!review.valid ? <p className="week-review-warn">{review.note}</p> : null}
      {review.valid && review.coverageIncomplete === true ? (
        <p className="week-review-warn">来源覆盖不完整：以下为已存事实，完整性未确认。</p>
      ) : null}
      {review.valid && review.coverageIncomplete === null ? (
        <p className="week-review-note">来源完整性未确认：以下为已存事实，完整性未经确认。</p>
      ) : null}
      {review.valid ? (
        <>
          <ul className="week-review-windows">
            <li><span>复盘窗</span>{fullDateLabel(review.reviewWindow.start)} – {fullDateLabel(review.reviewWindow.end)}（最近完整 7 天）</li>
            <li><span>对比窗</span>{fullDateLabel(review.comparisonWindow.start)} – {fullDateLabel(review.comparisonWindow.end)}（此前 7 天）</li>
            <li><span>基线窗</span>{fullDateLabel(review.baselineWindow.start)} – {fullDateLabel(review.baselineWindow.end)}（28 天）</li>
          </ul>
          <p className="week-review-note">健康复盘用滚动完整 7 天，与训练记录的自然周窗口不同，不直接同窗比较。</p>
          <p className="week-review-note">趋势洞察的生成规则：复盘窗与对照窗有效天数均 ≥5 天、均值差达到该指标的实用阈值，且复盘窗至少 3 天单独达到同向实用差异才生成；单个异常日即使把周均值推过阈值，也不会触发周趋势或下周动作。对照窗与基线窗一侧的单个异常日同样不会触发：生成前已做两侧留一单日影响检查，去掉任一侧影响最大的一天后，差异若跌破实用阈值或方向翻转，则不生成该洞察。原始单日值照常计入均值，不删除、不改动。运动次数按来源查询范围呈现：来源只查询最近 30 个完整日，基线窗回溯 35 天；查询范围未覆盖全程的窗口只呈现已存次数并注明完整性未确认，不作 28 天总量，存 0 次也不当作确切的 0。</p>
          <div className="week-review-rows">
            {review.metrics.map((metric) => (
              <div className="week-review-row" key={metric.key}>
                <div className="week-review-row-head">
                  <span>{metric.label}</span>
                  <strong>{valueText(metric, metric.reviewValue)}</strong>
                </div>
                <div className="week-review-cells">
                  <div><span>{metric.kind === "count" ? "对比窗次数" : "对比窗均值"}</span><strong>{valueText(metric, metric.comparisonValue)}</strong></div>
                  <div><span>{metric.kind === "count" ? "基线窗次数（28 天）" : "基线均值（28 天）"}</span><strong>{metric.baselineValue !== null ? valueText(metric, metric.baselineValue) : metric.baselineNote ?? "基线数据不足"}</strong></div>
                  <div><span>差值（较对比窗）</span><strong><span aria-hidden="true">{metric.diffSymbol}</span> {metric.diffText}</strong></div>
                </div>
                <p className="week-review-coverage">
                  {metric.kind === "count"
                    ? metric.coverageNote
                    : <>复盘窗有效 {metric.reviewN}/7 天 · 对比窗有效 {metric.comparisonN}/7 天 · 基线窗有效 {metric.baselineN}/28 天 · {metric.coverageNote}</>}
                  {metric.baselineNote ? <> · {metric.baselineNote}</> : null}
                </p>
              </div>
            ))}
          </div>
          {review.strengthCounts ? (
            <p className="week-review-note">
              力量训练（来源：训练记录）：复盘窗 {review.strengthCounts.review} 次 · 对比窗 {review.strengthCounts.comparison} 次 · 基线窗（28 天）{review.strengthCounts.baseline} 次。以上为快照内已存记录，与上面的运动次数（HealthKit 来源）分列呈现，不合并为一个总数，也不据此推算全部训练量。
            </p>
          ) : null}
          {review.insights.length ? (
            <div className="week-review-insights">
              <h3>复盘洞察</h3>
              {review.insights.map((insight) => (
                <article className="week-review-insight" key={insight.metricKey}>
                  <div className="week-review-insight-head">
                    <strong>{insight.label}</strong>
                    <span className="week-review-confidence">置信度{insight.confidence}</span>
                  </div>
                  <p><b>观察：</b>{insight.observation}</p>
                  <p><b>可能解释：</b>{insight.explanation}</p>
                  <p><b>下周动作：</b>{insight.action}</p>
                  <p className="week-review-confidence-note">{insight.confidenceNote}</p>
                </article>
              ))}
            </div>
          ) : (
            <p className="week-review-nodata">无法判断：现有数据未达到生成洞察的门槛。</p>
          )}
          <div className="week-review-focus-block">
            <p className="week-review-focus"><span>下周重点</span>{review.focus}</p>
            <p className="week-review-focus-meta">本次复盘：{fullDateLabel(review.reviewWindow.start)}–{fullDateLabel(review.reviewWindow.end)}／{review.coverageStatusNote}</p>
            {review.canJudge ? (
              <div className="week-review-feedback">
                <div className="week-review-feedback-actions" role="group" aria-label="下周重点反馈">
                  {(["有帮助", "不适用"] as const).map((choice) => {
                    const selected = feedbackState.selection === choice;
                    return (
                      <button
                        key={choice}
                        type="button"
                        className={`week-review-feedback-btn${selected ? " selected" : ""}`}
                        aria-pressed={selected}
                        aria-label={`反馈这条重点：${choice}`}
                        disabled={feedbackState.status === "saving"}
                        onClick={() => chooseFeedback(choice)}
                      >
                        {selected ? "✓ " : ""}{choice}
                      </button>
                    );
                  })}
                </div>
                <p className="week-review-feedback-status" role="status">{feedbackStatusText}</p>
                {feedbackState.status === "error" ? (
                  <button type="button" className="week-review-retry-btn" aria-label="重试保存反馈" onClick={retryFeedback}>重试保存</button>
                ) : null}
                <p className="week-review-note">反馈只记录这条重点对你是否适用，不会改变任何计划、评分或记录，也不代表效果证明。</p>
              </div>
            ) : null}
          </div>
          {focusFeedback.previous ? (
            <details className="week-review-previous">
              <summary>上次重点 · {dateLabel(focusFeedback.previous.windowStart)}–{dateLabel(focusFeedback.previous.windowEnd)} · 已反馈：{focusFeedback.previous.feedback}</summary>
              <p className="week-review-previous-focus">{focusFeedback.previous.focusText}</p>
              <p className="week-review-previous-basis">当时依据：{focusFeedback.previous.basisText}</p>
              <p className="week-review-previous-rule">规则 v{focusFeedback.previous.ruleVersion}</p>
            </details>
          ) : null}
        </>
      ) : null}
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
        {saveFeeling.isSuccess ? <p>已保存</p> : null}
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

function freshnessSymbol(freshness: DataStatus["health"]["freshness"]): string {
  if (freshness === "fresh" || freshness === "today") return "✓";
  if (freshness === "stale") return "▲";
  return "—";
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
    <section className="data-status-panel" id="data-status-panel" aria-labelledby="data-status-title">
      <div className="section-heading">
        <div><p className="section-kicker">数据一体 · 状态</p><h2 id="data-status-title">数据状态</h2></div>
        <span className={`status-chip ${dataStatus.overall === "ok" ? "status-ok" : dataStatus.overall === "empty" ? "status-missing" : "status-watch"}`}>{dataStatus.overallLabel}</span>
      </div>
      <div className="data-status-rows">
        {rows.map((row) => (
          <div className="data-status-row" key={row.source}>
            <div><strong>{row.label}</strong><span>{row.detail}</span></div>
            <div className="data-status-meta"><span className={`status-chip ${row.freshness === "fresh" || row.freshness === "today" ? "status-ok" : row.freshness === "stale" ? "status-watch" : "status-missing"}`}><span aria-hidden="true">{freshnessSymbol(row.freshness)}</span> {freshnessLabel(row.freshness)}</span><small>{row.updatedAt ? `${updatedLabel(row.updatedAt)} · ${ageLabel(row.ageMinutes)}` : "尚未同步"}</small></div>
          </div>
        ))}
      </div>
      <div className="data-status-actions">
        <button className="sync-button" type="button" aria-label="检查数据状态" onClick={() => diagnose.mutate()} disabled={diagnose.isPending}>{diagnose.isPending ? "检查中…" : "一键体检"}</button>
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
      ) : <p className="empty-inline">暂无同步记录。</p>}
      {unifiedTimeline.length ? (
        <div className="unified-timeline" aria-label="统一时间线">
          <h3>统一时间线 · 最近 {Math.min(unifiedTimeline.length, 7)} 天</h3>
          <p className="unified-note">仅汇总有记录的时长，缺失不按0</p>
          <div className="unified-list">
            {unifiedTimeline.slice(0, 7).map((day) => (
              <div className="unified-row" key={day.date}>
                <span className="unified-date">{dateLabel(day.date)}</span>
                <div className="unified-main">
                  <strong>{day.steps === null ? "步数 —" : `${numberLabel(day.steps)} 步`}{day.sleepHours !== null ? ` · 睡 ${day.sleepHours.toFixed(1)}h` : ""}</strong>
                  <small>{day.hasStrength ? `力量 ${day.strengthSessions} 次 · ${volumeLabel(day.strengthVolume)} ${displayUnit} · ${day.strengthRoutines.map((r) => ROUTINE_LABELS[r as StrengthWorkout["routine"]] ?? r).join("、")}` : "当天没有力量训练"}{unifiedWorkoutText(day) ? ` · ${unifiedWorkoutText(day)}` : ""}{unifiedHkLabel(day) ? ` · ${unifiedHkLabel(day)}` : ""}{day.restingHr !== null ? ` · 静息 ${day.restingHr.toFixed(0)} bpm` : ""}{day.hrvMs !== null ? ` · HRV ${day.hrvMs.toFixed(0)} ms` : ""}</small>
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

function TodayView({ snapshot, readiness, readinessHistory, onSyncHealth, onSyncStrength, strengthSyncing, syncing, dataStatus, unifiedTimeline, focusFeedback, focusReadFailed }: { snapshot: Snapshot; readiness: Readiness | null; readinessHistory: ReadinessHistoryPoint[]; onSyncHealth: () => void; onSyncStrength: () => void; strengthSyncing: boolean; syncing: boolean; dataStatus: DataStatus | null; unifiedTimeline: UnifiedDay[]; focusFeedback: FocusFeedbackData; focusReadFailed: boolean }) {
  const missing = [snapshot.restingHr.value === null ? "静息心率" : null, snapshot.hrv.value === null ? "HRV" : null].filter(Boolean).join("、");
  const stepsBaselineIncomplete = snapshot.steps.baseline === null || snapshot.steps.usualMin === null || snapshot.steps.usualMax === null || snapshot.steps.status === "数据缺失";
  const stepSummary = snapshot.steps.value === null ? "步数未记录" : stepsBaselineIncomplete ? "基线不足，无法比较" : snapshot.steps.status === "正常" ? "步数在常见范围" : `步数${snapshot.steps.status}`;
  const stepStatus: Status = snapshot.steps.value === null ? "数据缺失" : stepsBaselineIncomplete ? "基线不足" : snapshot.steps.status;
  const sleepHours = actualSleepHours(snapshot.sleep);
  return (
    <div className="today-view">
      <WhoopHero snapshot={snapshot} readiness={readiness} readinessHistory={readinessHistory} dataStatus={dataStatus} focusFeedback={focusFeedback} focusReadFailed={focusReadFailed} onSyncHealth={onSyncHealth} onSyncStrength={onSyncStrength} syncing={syncing} />
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
        </section>
      ) : null}
      <SleepPanel sleep={snapshot.sleep} />
      <section className="workout-line" aria-label="运动记录"><div><span>近7天运动</span><strong>{snapshot.workouts.count7d} 次</strong></div><p>{snapshot.workouts.note}</p></section>
      <RecentWorkouts snapshot={snapshot} />
    </div>
  );
}

// Recent HealthKit workouts on the 今日 tab. Until now this tab carried
// only a "近7天运动 N 次" count line — the actual sessions (swimming
// included) lived solely in the 历史 tab, buried below the unified
// timeline, the strength history, and the full workouts list, so real
// stored records read as missing. The latest five sessions are listed
// here with Chinese type labels; the full 30 days stay in 历史.
function RecentWorkouts({ snapshot }: { snapshot: Snapshot }) {
  const recent = [...snapshot.historyWorkouts]
    .sort((a, b) => (a.date !== b.date ? b.date.localeCompare(a.date) : a.id.localeCompare(b.id)))
    .slice(0, 5);
  const swimCount = snapshot.historyWorkouts.filter((workout) => isSwimWorkout(workout.type)).length;
  return (
    <section className="history-section recent-workouts-section" aria-labelledby="recent-workouts-title">
      <div className="section-heading">
        <div><p className="section-kicker">HealthKit workout</p><h2 id="recent-workouts-title">最近运动记录</h2></div>
        <span className="record-count">近30天游泳 {swimCount} 次</span>
      </div>
      {recent.length ? (
        <div className="record-list">
          {recent.map((workout) => (
            <article className="record-row" key={workout.id}>
              <div>
                <strong>{dateLabel(workout.date)} · {workoutTypeLabel(workout.type)}</strong>
                <span>{workout.distanceMeters === null ? "—" : workout.distanceMeters === 0 ? "0 米" : `${numberLabel(workout.distanceMeters)} 米`}</span>
              </div>
              <dl>
                <div><dt>时长</dt><dd>{workout.durationMinutes === null ? "—" : `${workout.durationMinutes.toFixed(1)} 分`}</dd></div>
                <div><dt>平均心率</dt><dd>{workout.averageHr === null ? "—" : `${workout.averageHr.toFixed(0)} bpm`}</dd></div>
                <div><dt>消耗</dt><dd>{workout.energyKcal === null ? "—" : `${workout.energyKcal.toFixed(0)} kcal`}</dd></div>
              </dl>
            </article>
          ))}
        </div>
      ) : <p className="empty-inline">近30天没有 HealthKit 运动记录。</p>}
    </section>
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
              <ResponsiveContainer width="100%" height="100%"><LineChart data={history} margin={{ top: 8, right: 0, left: 0, bottom: 0 }}><CartesianGrid stroke="var(--grid)" vertical={false} /><XAxis dataKey="label" interval="preserveStartEnd" tickLine={false} axisLine={false} tick={{ fill: "var(--dim)", fontSize: 10 }} /><YAxis yAxisId="kcal" domain={[0, "auto"]} width={42} tickLine={false} axisLine={false} tick={{ fill: "var(--dim)", fontSize: 10 }} /><YAxis yAxisId="minutes" orientation="right" domain={[0, "auto"]} width={34} tickLine={false} axisLine={false} tick={{ fill: "var(--dim)", fontSize: 10 }} /><Tooltip contentStyle={tooltipStyle} /><Line yAxisId="kcal" type="monotone" dataKey="activeKcal" name="活动能量（实线）" unit=" kcal" stroke="var(--amber)" strokeWidth={2} dot={false} connectNulls={false} /><Line yAxisId="minutes" type="monotone" dataKey="exerciseMinutes" name="运动时间（虚线）" unit=" 分钟" stroke="var(--accent)" strokeWidth={2} strokeDasharray="7 4" dot={{ r: 2.5 }} connectNulls={false} /></LineChart></ResponsiveContainer>
            </ChartPanel>
            <ChartPanel eyebrow="左轴 bpm · 右轴 ms" title="静息心率与 HRV">
              <ResponsiveContainer width="100%" height="100%"><LineChart data={history} margin={{ top: 8, right: 0, left: 0, bottom: 0 }}><CartesianGrid stroke="var(--grid)" vertical={false} /><XAxis dataKey="label" interval="preserveStartEnd" tickLine={false} axisLine={false} tick={{ fill: "var(--dim)", fontSize: 10 }} /><YAxis yAxisId="hr" domain={["dataMin - 3", "dataMax + 3"]} width={34} tickLine={false} axisLine={false} tick={{ fill: "var(--dim)", fontSize: 10 }} /><YAxis yAxisId="hrv" orientation="right" domain={["dataMin - 5", "dataMax + 5"]} width={34} tickLine={false} axisLine={false} tick={{ fill: "var(--dim)", fontSize: 10 }} /><Tooltip contentStyle={tooltipStyle} /><Line yAxisId="hr" type="linear" dataKey="restingHr" name="静息心率（实线）" unit=" bpm" stroke="var(--amber)" strokeWidth={2} dot={false} connectNulls={false} /><Line yAxisId="hrv" type="linear" dataKey="hrvMs" name="HRV（虚线）" unit=" ms" stroke="var(--accent)" strokeWidth={2} strokeDasharray="7 4" dot={{ r: 2.5 }} connectNulls={false} /></LineChart></ResponsiveContainer>
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

type HistoryWorkout = Snapshot["historyWorkouts"][number];

function allWorkoutsList(historyWorkouts: HistoryWorkout[]): HistoryWorkout[] {
  return [...historyWorkouts].sort((a, b) => {
    if (a.date !== b.date) return b.date.localeCompare(a.date);
    return a.id.localeCompare(b.id);
  });
}

function HistoryView({ snapshot, unifiedTimeline }: { snapshot: Snapshot; unifiedTimeline?: UnifiedDay[] }) {
  const strengths = [...snapshot.strengthTraining.workouts].sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());
  const allWorkouts = allWorkoutsList(snapshot.historyWorkouts);
  const swims = snapshot.historyWorkouts.filter((workout) => isSwimWorkout(workout.type)).slice().reverse();
  const weights = snapshot.historyDaily.filter((row): row is Daily & { weightKg: number } => row.weightKg !== null).slice().reverse();
  const sleeps = snapshot.historySleeps.slice().reverse();
  return (
    <div className="history-view">
      {unifiedTimeline && unifiedTimeline.length ? (
        <section className="history-section" aria-labelledby="unified-history-title">
          <div className="section-heading"><div><p className="section-kicker">一体时间线</p><h2 id="unified-history-title">每天合在一起看</h2></div><span className="record-count">{unifiedTimeline.length} 天</span></div>
          <p className="unified-note">仅汇总有记录的时长，缺失不按0</p>
          <div className="unified-list">
            {unifiedTimeline.map((day) => (
              <div className="unified-row" key={day.date}>
                <span className="unified-date">{dateLabel(day.date)}</span>
                <div className="unified-main"><strong>{day.steps === null ? "步数 —" : `${numberLabel(day.steps)} 步`}{day.sleepHours !== null ? ` · 睡 ${day.sleepHours.toFixed(1)}h` : ""}</strong><small>{day.hasStrength ? `力量 ${day.strengthSessions} 次 · ${volumeLabel(day.strengthVolume)} ${snapshot.strengthTraining.displayUnit}` : "没有力量训练"}{unifiedWorkoutText(day) ? ` · ${unifiedWorkoutText(day)}` : ""}{unifiedHkLabel(day) ? ` · ${unifiedHkLabel(day)}` : ""}</small></div>
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

      <MuscleStatusPanel strength={snapshot.strengthTraining} />

      <section className="history-section" aria-labelledby="swim-history-title">
        <div className="section-heading"><div><p className="section-kicker">HealthKit workout</p><h2 id="swim-history-title">游泳记录</h2></div><span className="record-count">{swims.length} 次</span></div>
        {swims.length ? <div className="record-list">{swims.map((workout) => <article className="record-row" key={workout.id}><div><strong>{dateLabel(workout.date)} · 游泳</strong><span>{numberLabel(workout.distanceMeters)} 米</span></div><dl><div><dt>时长</dt><dd>{workout.durationMinutes === null ? "—" : `${workout.durationMinutes.toFixed(1)} 分`}</dd></div><div><dt>平均心率</dt><dd>{workout.averageHr === null ? "—" : `${workout.averageHr.toFixed(0)} bpm`}</dd></div><div><dt>消耗</dt><dd>{workout.energyKcal === null ? "—" : `${workout.energyKcal.toFixed(0)} kcal`}</dd></div></dl></article>)}</div> : <p className="empty-inline">近30天没有游泳 workout 记录。</p>}
      </section>

      <section className="history-section all-workouts-section" aria-labelledby="all-workouts-title">
        <div className="section-heading"><div><p className="section-kicker">HealthKit workout</p><h2 id="all-workouts-title">全部运动记录</h2></div><span className="record-count">{allWorkouts.length} 次</span></div>
        {allWorkouts.length ? <div className="record-list">{allWorkouts.map((workout) => <article className="record-row" key={workout.id}><div><strong>{dateLabel(workout.date)} · {workoutTypeLabel(workout.type)}</strong><span>{workout.distanceMeters === null ? "—" : workout.distanceMeters === 0 ? "0 米" : `${numberLabel(workout.distanceMeters)} 米`}</span></div><dl><div><dt>时长</dt><dd>{workout.durationMinutes === null ? "—" : `${workout.durationMinutes.toFixed(1)} 分`}</dd></div><div><dt>平均心率</dt><dd>{workout.averageHr === null ? "—" : `${workout.averageHr.toFixed(0)} bpm`}</dd></div><div><dt>消耗</dt><dd>{workout.energyKcal === null ? "—" : `${workout.energyKcal.toFixed(0)} kcal`}</dd></div></dl></article>)}</div> : <p className="empty-inline">近30天没有 HealthKit 运动记录。</p>}
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

// LIFE-C1 人生游戏 (CWEB-MVP-001·S1 + S2) 角色 view: Diablo-style
// character sheet — level/XP/gold header, attribute list with加点
// controls, equipment slots + shop, daily tasks, main quest, ledger.
// It reads ONLY the getGameState action — its own query, fully separate
// from getDashboard — so a game-layer failure renders as a note inside
// this view and can never take the health views down with it. Mutations
// (allocate/buy/equip/unequip) are owner-only server actions; this view
// just calls them and invalidates the game query. Status is always text
// + symbol, never color alone (owner is color-vision deficient);
// category symbols differ in shape: ▲ steps, ◑ sleep, ■ strength,
// ★ quest, ✦ daily task, ✧ reward redemption.
const GAME_CATEGORY_META: Record<GameCategory, { label: string; symbol: string }> = {
  steps: { label: "步行", symbol: "▲" },
  sleep: { label: "主睡眠", symbol: "◑" },
  strength: { label: "力量训练", symbol: "■" },
  quest_steps: { label: "主任务 · 步行达标", symbol: "★" },
  daily_task: { label: "每日任务", symbol: "✦" },
  reward_redeem: { label: "奖励兑换", symbol: "✧" },
};

const GAME_TASK_LABELS: Record<string, string> = {
  steps_10000: "每日任务 · 步行 10,000 步",
  strength_1: "每日任务 · 力量训练 1 次",
  sleep_7h30: "每日任务 · 主睡眠 ≥ 7.5 小时",
};

type GameAttributeKey = "strength" | "endurance" | "spirit" | "stamina";
const GAME_ATTRIBUTE_META: { key: GameAttributeKey; label: string; symbol: string; domain: GameState["domainBonuses"][number]["domain"]; domainLabel: string }[] = [
  { key: "strength", label: "力量", symbol: "◆", domain: "strength", domainLabel: "力量训练经验" },
  { key: "endurance", label: "耐力", symbol: "▲", domain: "steps", domainLabel: "步行经验" },
  { key: "spirit", label: "精神", symbol: "◑", domain: "sleep", domainLabel: "睡眠经验" },
  { key: "stamina", label: "体力", symbol: "●", domain: "quest_steps", domainLabel: "主任务经验" },
];

const GAME_SLOT_META: { slot: "weapon" | "armor" | "accessory"; label: string; symbol: string }[] = [
  { slot: "weapon", label: "武器", symbol: "▸" },
  { slot: "armor", label: "护甲", symbol: "▣" },
  { slot: "accessory", label: "饰品", symbol: "◎" },
];

// LIFE-C1 人生游戏 S3 (CWEB-MVP-001·S3) 奖励 section: the owner's own
// reward list on the same gold ledger, in three states — list →
// confirmation preview → receipt. It runs its own ["rewards"] query
// (getRewards settles and returns the saved balance + the balance
// version a preview pins), separate from the ["game"] query, so a
// rewards failure renders as a note inside this section only. Status
// is always text + symbol + numbers, never color alone: ✓ 余额足够 /
// 还差 N 金币. Balance three-state text is fixed: verified + short →
// 还差 N; verified + enough → 可兑换 (preview pins the current
// version); unverified (getRewards ok:false) → 余额暂不可核实, with
// the list, the goal, and old receipts kept and redemption writes
// paused — never a 0 or a green "enough" standing in for an unknown
// balance. A redemption whose outcome is unknown (typed busy, a lost
// response, a transport failure) lands in an explicit 兑换结果未确认
// state that keeps the SAME requestId and the fixed request content
// and resolves only by certifying a final success (read-only receipt
// lookup, then an idempotent retry with the identical arguments) —
// never through a fresh request that could charge twice, and a
// not-found lookup says 未确认, never "没有入账". The pending draft
// is persisted on submit, so reopening the page offers a recovery
// entry for the same identity instead of minting a new key. Failed
// saves/redemptions keep the list and the drafts.
//
// Single-pending-intent rule: while one redemption is unconfirmed,
// NO entry point may mint a new intent — openPreview first routes
// back into the pending intent's unconfirmed flow along its original
// requestId (it never generates a new key and never overwrites the
// one recovery slot), and the submit hook refuses to store a
// different draft over a pending one. List edits and goal selection
// stay available throughout; only a new redemption waits until the
// pending intent reaches a terminal classification.
//
// Cross-tab hardening (P0-2): a localStorage read is not a lock, so
// the redeem mutationFn RE-CHECKS the slot at send time — a
// different pending requestId already stored (another tab submitted
// after this tab's preview opened) means the request is never sent;
// the mutation fails locally and routes into the STORED intent's
// unconfirmed flow. And clearing is compare-by-requestId: a
// callback empties the slot only when the stored identity is the
// intent that callback resolves, so a late callback or another
// tab's callback can never wipe the current key. On the server
// side, every terminal rejection is durable-arbitrated against the
// receipt table, so a typed rejection reaching this client is a
// true terminal state for its requestId.
//
// Receipt verification is a text label, never color alone: a receipt
// carrying its per-request completion proof reads ✓ 已完成; a
// historical receipt without one reads ▲ 未核实 on the list, on the
// receipt card, and in lookup results — it is never presented as a
// completed redemption, and it is never silently charged, deleted,
// or rewritten.
//
// 只读重查 (the goal card's and this panel's) calls
// getRewardsSnapshot — a genuinely read-only stored-state read (no
// settlement, no save, no task spawn) — and paints its result into
// the ["rewards"] cache. getRewards itself settles on read and is
// never described as read-only.
interface RedeemDraft {
  requestId: string;
  rewardId: number;
  rewardRevision: number;
  name: string;
  price: number;
  balance: number;
  expectedBalanceVersion: number;
}

function newRewardRequestId(): string {
  const cryptoObj = globalThis.crypto;
  if (cryptoObj && typeof cryptoObj.randomUUID === "function") return cryptoObj.randomUUID();
  return `req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 14)}`;
}

// The one unconfirmed redemption intent, persisted across page
// reopens under its original requestId. Written when a redemption is
// submitted, cleared only when the intent reaches a terminal
// classification (real receipt, or a typed rejection) — a reopen
// reads it back as a recovery entry and never generates a new key
// for the same intent.
const PENDING_REDEMPTION_KEY = "space4.pending-redemption.v1";

// Cross-component signal inside this page: the character screen's
// pending strip asks the rewards panel to open the stored pending
// intent's unconfirmed flow (same requestId — the panel re-reads the
// slot itself; the event carries no draft, so no new key can ever
// be minted by this path).
const OPEN_PENDING_REDEMPTION_EVENT = "space4:open-pending-redemption";

// Same-page counterpart of the cross-tab "storage" event: the
// storage event fires only in OTHER tabs, so a write or clear from
// THIS page would otherwise leave same-page subscribers (the
// character screen's pending strip) showing a stale slot until the
// next mount. storePendingRedemption dispatches this event after
// every write/clear attempt, and subscribers re-read the slot
// itself — the event carries no draft, so it can never mint or
// alter an intent, only prompt a re-read.
const PENDING_REDEMPTION_CHANGED_EVENT = "space4:pending-redemption-changed";

function loadPendingRedemption(): RedeemDraft | null {
  try {
    const raw = globalThis.localStorage?.getItem(PENDING_REDEMPTION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<RedeemDraft>;
    if (typeof parsed.requestId === "string" && parsed.requestId.length >= 8
      && typeof parsed.rewardId === "number" && typeof parsed.rewardRevision === "number"
      && typeof parsed.name === "string" && parsed.name.length > 0
      && typeof parsed.price === "number" && typeof parsed.balance === "number"
      && typeof parsed.expectedBalanceVersion === "number") {
      return parsed as RedeemDraft;
    }
  } catch { /* storage unavailable — the in-page unconfirmed state still works */ }
  return null;
}

function storePendingRedemption(draft: RedeemDraft | null) {
  try {
    if (draft) globalThis.localStorage?.setItem(PENDING_REDEMPTION_KEY, JSON.stringify(draft));
    else globalThis.localStorage?.removeItem(PENDING_REDEMPTION_KEY);
  } catch { /* storage unavailable — ignore */ }
  // Notify THIS page's subscribers (the storage event covers other
  // tabs only). Dispatched even when storage is unavailable, so
  // subscribers re-sync to whatever the slot actually holds.
  try { globalThis.dispatchEvent(new Event(PENDING_REDEMPTION_CHANGED_EVENT)); } catch { /* no event target — ignore */ }
}

function scrollToRewardsPanel() {
  document.getElementById("game-rewards-panel")?.scrollIntoView({ behavior: "smooth", block: "start" });
}

// 真只读重查: fetch the stored rewards state through the read-only
// snapshot action (the server settles nothing, saves nothing, and
// spawns nothing for it) and paint it into the ["rewards"] cache.
// The snapshot's own `ok` is the stored reconciliation fact, so the
// three balance states stay distinct after a recheck: reconciled →
// verified (a stored 0 is a true zero), unreconciled → 余额暂不可核实
// with the stored goal, list, and receipts all still shown, and a
// failed read keeps whatever the panel already shows.
async function recheckStoredRewards(queryClient: ReturnType<typeof useQueryClient>): Promise<void> {
  try {
    const snap = await api.getRewardsSnapshot({});
    if (snap.forbidden) return;
    queryClient.setQueryData<RewardsState>(["rewards"], {
      forbidden: snap.forbidden,
      ok: snap.ok,
      balance: snap.balance,
      balanceVersion: snap.balanceVersion,
      healthState: snap.healthState,
      healthDataDate: snap.healthDataDate,
      coverageIncomplete: snap.coverageIncomplete,
      goalRewardId: snap.goalRewardId,
      rewards: snap.rewards,
      receipts: snap.receipts,
    });
  } catch { /* a failed recheck leaves the last known state on screen */ }
}

// 下一奖励目标 on the character first screen (S3 余项): the owner's
// one explicitly chosen next reward, read from the same ["rewards"]
// query the rewards panel uses — the goal's CURRENT name and price
// (a rename/reprice shows the new version; old receipts keep their
// snapshots), the verified saved balance, and the gap. Balance
// three-state text matches the rewards panel exactly: 还差 N /
// 可兑换 / 余额暂不可核实. Today's unsettled XP preview never counts
// toward the balance shown here. With no preference saved, the strip
// invites a choice instead of inventing a default reward.
//
// Pending intent first (S3 恢复首屏): while a redemption is still
// unconfirmed, an independent strip ABOVE the goal names that
// intent — the ORIGINALLY submitted name and fixed price from the
// persisted draft, never the reward's current (possibly renamed or
// repriced) row — and its 继续确认 CTA scrolls to the rewards panel
// and asks it to open the SAME requestId's unconfirmed flow. No new
// preview is generated here and no new intent is minted; the goal
// below stays fully readable and changeable, and a fresh intent can
// only be started explicitly after the pending one reaches an
// authoritative terminal classification. With no pending intent,
// the goal renders the stored-balance three-state as before.
function NextRewardGoal() {
  const queryClient = useQueryClient();
  const rewards = useQuery({ queryKey: ["rewards"], queryFn: () => api.getRewards({}) });
  const data = rewards.data;
  const goalReward = data && data.goalRewardId !== null ? data.rewards.find((reward) => reward.id === data.goalRewardId) ?? null : null;
  const [pendingIntent, setPendingIntent] = useState<RedeemDraft | null>(null);
  useEffect(() => {
    const sync = () => setPendingIntent(loadPendingRedemption());
    sync();
    // Cross-tab: another tab storing or clearing the slot repaints
    // this strip (the storage event fires in every OTHER tab).
    window.addEventListener("storage", sync);
    // Same page: this page's own store/clear (a submit in the
    // rewards panel below, a terminal classification clearing the
    // slot) dispatches the changed event from storePendingRedemption,
    // so the strip appears and disappears in step with the slot
    // without waiting for a remount.
    window.addEventListener(PENDING_REDEMPTION_CHANGED_EVENT, sync);
    return () => {
      window.removeEventListener("storage", sync);
      window.removeEventListener(PENDING_REDEMPTION_CHANGED_EVENT, sync);
    };
  }, []);
  const continuePending = () => {
    scrollToRewardsPanel();
    window.dispatchEvent(new Event(OPEN_PENDING_REDEMPTION_EVENT));
  };
  return (
    <>
      {pendingIntent ? (
        <div className="game-goal-pending" role="alert">
          <strong><span aria-hidden="true">▲</span> 先确认这笔兑换</strong>
          <p className="game-note">{pendingIntent.name} · {numberLabel(pendingIntent.price)} 金币 · ▲ 结果未确认：它可能已经入账，也可能没有。确认出权威结果之前，不要发起新的兑换。</p>
          <button type="button" className="game-btn" aria-label="继续确认未确认的兑换" onClick={continuePending}>继续确认</button>
        </div>
      ) : null}
    <div className="game-goal" role="group" aria-label="下一奖励目标">
      <div className="section-line">
        <strong><span aria-hidden="true">◎</span> 下一奖励</strong>
        <button type="button" className="game-btn game-btn-ghost" aria-label="查看奖励清单" onClick={scrollToRewardsPanel}>查看奖励</button>
      </div>
      {rewards.isPending ? (
        <p className="game-note">正在读取下一奖励目标…</p>
      ) : rewards.isError || !data || data.forbidden ? (
        <p className="game-note">下一奖励目标暂时读不出来，稍后重试即可。</p>
      ) : goalReward ? (
        <>
          <p className="game-goal-main">{goalReward.name} · 当前价格 {numberLabel(goalReward.price)} 金币</p>
          {!data.ok ? (
            <p className="game-note">余额暂不可核实：目标与清单都保留着，核实后会显示还差多少。<button type="button" className="game-btn game-btn-ghost" aria-label="只读重查金币余额" disabled={rewards.isFetching} onClick={() => void recheckStoredRewards(queryClient)}>只读重查</button></p>
          ) : data.balance >= goalReward.price ? (
            <p className="game-note"><span aria-hidden="true">✓</span> 可兑换 · 已保存金币 {numberLabel(data.balance)} 金币，去奖励清单按当前版本预览确认。</p>
          ) : (
            <p className="game-note">已保存金币 {numberLabel(data.balance)} 金币 · 还差 {numberLabel(goalReward.price - data.balance)} 金币</p>
          )}
        </>
      ) : (
        <p className="game-note">选一项你想先实现的奖励：在下方奖励清单里点「设为下一奖励」。</p>
      )}
    </div>
    </>
  );
}

// Thrown by the redeem mutationFn when the send-time identity
// re-check finds a DIFFERENT pending intent already occupying the
// recovery slot (typically submitted from another tab after this
// tab's preview was opened): the new request must NOT be sent at
// all — the other intent keeps its identity and this tab routes
// into ITS unconfirmed flow instead.
class PendingBlockedError extends Error {
  existing: RedeemDraft;
  constructor(existing: RedeemDraft) {
    super("pending-blocked");
    this.existing = existing;
  }
}

function RewardsPanel() {
  const queryClient = useQueryClient();
  const rewards = useQuery({ queryKey: ["rewards"], queryFn: () => api.getRewards({}) });
  const [note, setNote] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [newPrice, setNewPrice] = useState("");
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editName, setEditName] = useState("");
  const [editPrice, setEditPrice] = useState("");
  const [stage, setStage] = useState<{ kind: "list" } | { kind: "preview"; draft: RedeemDraft } | { kind: "unconfirmed"; draft: RedeemDraft; lookupNote: string | null }>({ kind: "list" });
  const [lastReceipt, setLastReceipt] = useState<RewardReceipt | null>(null);
  const [receiptNote, setReceiptNote] = useState<string | null>(null);
  // A redemption intent recovered after a page reopen (same
  // requestId, same fixed content) — offered as a recovery entry,
  // never silently re-keyed.
  const [pendingRecovery, setPendingRecovery] = useState<RedeemDraft | null>(null);
  useEffect(() => { setPendingRecovery(loadPendingRedemption()); }, []);

  // The character screen's pending strip asks this panel to open
  // the stored intent's unconfirmed flow: re-read the slot at that
  // moment and route into ITS draft — the original requestId, the
  // original fixed content — never a fresh preview or a new key.
  useEffect(() => {
    const openPending = () => {
      const pending = loadPendingRedemption();
      if (!pending) return;
      setPendingRecovery(pending);
      setStage({ kind: "unconfirmed", draft: pending, lookupNote: null });
    };
    window.addEventListener(OPEN_PENDING_REDEMPTION_EVENT, openPending);
    return () => window.removeEventListener(OPEN_PENDING_REDEMPTION_EVENT, openPending);
  }, []);

  // Compare-by-requestId clearing (P0-2): the slot is emptied ONLY
  // when the stored identity is the very intent this callback is
  // resolving. A late callback, or another tab's callback resolving
  // a different intent, must never wipe the current key — the
  // stored pending belongs to whichever intent submitted it until
  // THAT intent reaches a terminal classification.
  const clearPending = (requestId: string) => {
    const existing = loadPendingRedemption();
    if (existing && existing.requestId === requestId) storePendingRedemption(null);
    setPendingRecovery((prev) => (prev && prev.requestId === requestId ? null : prev));
  };

  const invalidateRewards = () => {
    void queryClient.invalidateQueries({ queryKey: ["rewards"] });
    void queryClient.invalidateQueries({ queryKey: ["game"] });
  };

  const saveReward = useMutation({
    mutationFn: (args: { id: number | null; name: string; price: number }) => api.saveReward(args),
    onSuccess: (result, args) => {
      setNote(result.message);
      if (result.ok) {
        if (args.id === null) { setNewName(""); setNewPrice(""); }
        else setEditingId(null);
        invalidateRewards();
      }
    },
    onError: () => setNote("保存失败，请稍后再试；已填写的内容还在。"),
  });

  const setGoal = useMutation({
    mutationFn: (rewardId: number) => api.setRewardGoal({ rewardId }),
    onSuccess: (result) => {
      if (result.ok) {
        setNote("已设为下一奖励：角色页会显示它与当前余额的差额。");
        invalidateRewards();
      } else {
        // Preference save failed: the previously saved goal stays
        // exactly as it was (the query data is untouched) and the
        // failure is stated, never silent.
        setNote(`${result.message}；原来的下一奖励目标保持不变。`);
      }
    },
    onError: () => setNote("下一奖励保存失败；原来的目标保持不变，稍后再试。"),
  });

  const redeem = useMutation({
    mutationFn: async (draft: RedeemDraft) => {
      // Send-time identity re-check (P0-2): a single localStorage
      // read at preview time is NOT a cross-tab lock — another tab
      // may have submitted and stored its own intent after this
      // tab's preview opened. Re-read the slot NOW, immediately
      // before sending: a DIFFERENT pending requestId means this
      // request must not be sent at all (the stored intent keeps
      // the slot and the recovery identity); the mutation fails
      // locally with PendingBlockedError and onError routes into
      // the stored intent's unconfirmed flow. The same requestId
      // (a retry of the stored intent itself) always passes.
      const existing = loadPendingRedemption();
      if (existing && existing.requestId !== draft.requestId) throw new PendingBlockedError(existing);
      return api.redeemReward({ requestId: draft.requestId, rewardId: draft.rewardId, rewardRevision: draft.rewardRevision, price: draft.price, expectedBalanceVersion: draft.expectedBalanceVersion });
    },
    onMutate: (draft) => {
      // The recovery slot holds ONE identity: never overwrite a
      // different pending intent with a new draft — the pending one
      // would become unrecoverable and could be charged twice.
      const existing = loadPendingRedemption();
      if (!existing || existing.requestId === draft.requestId) storePendingRedemption(draft);
    },
    onSuccess: (result, draft) => {
      if ((result.status === "redeemed" || result.status === "already_resolved") && result.receipt) {
        clearPending(draft.requestId);
        setLastReceipt(result.receipt);
        setReceiptNote(result.status === "already_resolved" ? "这笔兑换此前已经入账，下面是原回执，未重复扣账。" : null);
        setNote(null);
        setStage({ kind: "list" });
        invalidateRewards();
        return;
      }
      if (result.status === "unverified" && result.receipt) {
        // A historical receipt exists under this requestId but has
        // no per-request completion proof: it is NOT a success and
        // must not be shown as one. The intent is terminally
        // classified (the server charged nothing and changed
        // nothing), so the pending identity clears and the receipt
        // is displayed with its 未核实 label.
        clearPending(draft.requestId);
        setLastReceipt(result.receipt);
        setReceiptNote("这张历史回执未核实：没有逐笔完成证明，不能确认这笔兑换已经扣账。本次没有重复扣账，也没有改动原回执。");
        setNote(null);
        setStage({ kind: "list" });
        invalidateRewards();
        return;
      }
      if (result.status === "busy") {
        // Typed busy = outcome UNKNOWN (the atomic commit may or may
        // not have landed before the contention). Keep the exact
        // same requestId and fixed content in the unconfirmed state
        // and resolve only by certifying a final success — busy is
        // never a plain rejection and never drops back to the list.
        setPendingRecovery(draft);
        setStage({ kind: "unconfirmed", draft, lookupNote: result.message });
        return;
      }
      // Typed rejection (stale / insufficient / conflict / not
      // found): the server arbitrated this rejection against the
      // durable receipt table as its last step, so the intent is
      // terminally classified — clear the pending identity (only
      // if the slot still holds THIS intent), return to the list
      // with the reason; the list and the form drafts are untouched
      // and the balance refreshes for a fresh preview.
      clearPending(draft.requestId);
      setNote(result.message);
      setStage({ kind: "list" });
      invalidateRewards();
    },
    onError: (error, draft) => {
      if (error instanceof PendingBlockedError) {
        // Nothing was sent: another intent (another tab, or an
        // earlier flow) owns the recovery slot. Route into THAT
        // intent's unconfirmed flow on its original requestId —
        // this tab's unsent draft is simply dropped, and the slot
        // is left exactly as the other intent stored it.
        setPendingRecovery(error.existing);
        setStage({ kind: "unconfirmed", draft: error.existing, lookupNote: `另一笔兑换（${error.existing.name} · ${numberLabel(error.existing.price)} 金币）还没有确认，本次没有发出新的兑换请求。先确认它，再发起新的兑换。` });
        return;
      }
      // The response was lost — the redemption may or may not have
      // landed. Keep the exact same requestId (already persisted by
      // onMutate) and resolve from it — unless the slot meanwhile
      // came to hold a different intent, which then owns the
      // recovery flow.
      const existing = loadPendingRedemption();
      if (existing && existing.requestId !== draft.requestId) {
        setPendingRecovery(existing);
        setStage({ kind: "unconfirmed", draft: existing, lookupNote: null });
        return;
      }
      setPendingRecovery(draft);
      setStage({ kind: "unconfirmed", draft, lookupNote: null });
    },
  });

  const lookup = useMutation({
    mutationFn: (requestId: string) => api.getRedemptionReceipt({ requestId }),
    onSuccess: (result, requestId) => {
      if (result.receipt) {
        clearPending(requestId);
        setLastReceipt(result.receipt);
        setReceiptNote(result.receipt.verification === "verified"
          ? "已确认：这笔兑换已经入账，下面是原回执，未重复扣账。"
          : "查到了这张回执，但它未核实：没有逐笔完成证明，不能确认这笔兑换已经扣账。");
        setNote(null);
        setStage({ kind: "list" });
        invalidateRewards();
      } else {
        // Not found proves nothing about whether the gold moved —
        // the outcome stays 未确认 and the same request remains the
        // only retry identity.
        setStage((prev) => prev.kind === "unconfirmed" ? { ...prev, lookupNote: "还没有查到这笔兑换的回执，结果仍未确认。可以稍后再查，或用同一请求重试兑换——若它其实已入账，重试只会返回原回执，不会重复扣账。" } : prev);
      }
    },
    onError: () => {
      setStage((prev) => prev.kind === "unconfirmed" ? { ...prev, lookupNote: "查询也失败了，请稍后再查。在确认结果之前，不要重新发起新的兑换。" } : prev);
    },
  });

  const data = rewards.data;
  const balance = data?.balance ?? 0;
  // Balance three-state gate: only a verified read (ok:true) may
  // present a balance as spendable. ok:false keeps the list and
  // receipts readable but pauses every redemption write.
  const balanceVerified = !!data && data.ok;

  const openPreview = async (reward: RewardItem) => {
    // Single-pending-intent rule: while an earlier redemption is
    // still unconfirmed, this entry point must NOT mint a new
    // intent — a fresh requestId here would, on submit, overwrite
    // the one recovery slot and orphan the pending intent (which
    // could then land late and be charged again). Route back into
    // the pending intent's unconfirmed flow along its ORIGINAL
    // requestId instead; list editing and goal selection remain
    // available, and a new redemption opens only after the pending
    // intent reaches a terminal classification.
    const pending = loadPendingRedemption() ?? pendingRecovery;
    if (pending) {
      setPendingRecovery(pending);
      setNote("有一笔兑换结果还没有确认，先处理完它再发起新的兑换。");
      setStage({ kind: "unconfirmed", draft: pending, lookupNote: null });
      return;
    }
    // Pin the preview to a FRESH read: the reward's current revision
    // and price, the current saved balance, and the current balance
    // version — exactly what redeemReward re-checks server-side.
    let fresh: RewardsState | undefined;
    try {
      fresh = await queryClient.fetchQuery({ queryKey: ["rewards"], queryFn: () => api.getRewards({}) });
    } catch {
      fresh = undefined;
    }
    const source = fresh ?? data;
    if (!source || !source.ok) {
      setNote("余额暂不可核实，暂时不能发起兑换；奖励清单与历史回执仍可查看，可以稍后只读重查。");
      return;
    }
    const current = source.rewards.find((item) => item.id === reward.id) ?? reward;
    const freshBalance = source.balance;
    if (current.price > freshBalance) {
      setNote(`金币不足：兑换「${current.name}」需要 ${numberLabel(current.price)} 金币，已保存余额 ${numberLabel(freshBalance)}，还差 ${numberLabel(current.price - freshBalance)} 金币。`);
      return;
    }
    setLastReceipt(null);
    setReceiptNote(null);
    setNote(null);
    setStage({
      kind: "preview",
      draft: {
        requestId: newRewardRequestId(),
        rewardId: current.id,
        rewardRevision: current.revision,
        name: current.name,
        price: current.price,
        balance: freshBalance,
        expectedBalanceVersion: source.balanceVersion,
      },
    });
  };

  // Receipt-card 选择下一项 (S3): close the receipt card AND move
  // to the reward list's goal selection — scroll the list into
  // view and focus the first available 「设为下一奖励」 control (the
  // list itself when no other reward can be picked). The saved goal
  // is NOT touched here: it stays the current target until another
  // setGoal actually succeeds.
  const chooseNextGoal = () => {
    setLastReceipt(null);
    setReceiptNote(null);
    requestAnimationFrame(() => {
      const list = document.getElementById("game-rewards-list");
      list?.scrollIntoView({ behavior: "smooth", block: "start" });
      const pick = document.querySelector<HTMLButtonElement>("#game-rewards-panel button[data-goal-pick='true']:not([disabled])");
      if (pick) pick.focus({ preventScroll: true });
      else list?.focus({ preventScroll: true });
    });
  };

  const submitNew = () => {
    const price = Number(newPrice);
    if (!newName.trim()) { setNote("先给奖励起个名字。"); return; }
    if (!Number.isInteger(price) || price < 1) { setNote("价格需要是正整数金币。"); return; }
    saveReward.mutate({ id: null, name: newName.trim(), price });
  };

  const submitEdit = (reward: RewardItem) => {
    const price = Number(editPrice);
    if (!editName.trim()) { setNote("奖励名称不能为空。"); return; }
    if (!Number.isInteger(price) || price < 1) { setNote("价格需要是正整数金币。"); return; }
    saveReward.mutate({ id: reward.id, name: editName.trim(), price });
  };

  return (
    <section className="game-panel" id="game-rewards-panel" aria-labelledby="game-rewards-title">
      <div className="section-line"><h3 id="game-rewards-title">奖励</h3><span>{balanceVerified ? `已保存金币 ${numberLabel(balance)} · 自设清单` : "金币余额暂不可核实 · 自设清单"}</span></div>
      {rewards.isPending ? (
        <p className="game-note" role="status">正在读取奖励清单…</p>
      ) : rewards.isError || !data || data.forbidden ? (
        <p className="game-note">奖励清单暂时读不出来，稍后重试即可；已发出的回执不会受影响。</p>
      ) : (
        <>
          {!balanceVerified ? (
            <p className="game-note">金币余额暂不可核实：奖励清单、下一奖励目标与历史回执仍可查看，但暂时不能发起新的兑换。
              <button type="button" className="game-btn game-btn-ghost" aria-label="只读重查金币余额" disabled={rewards.isFetching} onClick={() => void recheckStoredRewards(queryClient)}>只读重查</button>
            </p>
          ) : null}
          {data.healthState !== "ok" ? (
            <p className="game-note">健康数据{data.healthState === "corrupt" ? "快照损坏" : "尚未同步"}{data.healthDataDate ? `（来源日期 ${fullDateLabel(data.healthDataDate)}）` : ""}：奖励清单与历史回执照常可看{balanceVerified ? "，已入账的真实金币仍可兑换" : ""}。</p>
          ) : data.coverageIncomplete ? (
            <p className="game-note">今日健康数据尚未完整{data.healthDataDate ? `（来源日期 ${fullDateLabel(data.healthDataDate)}）` : ""}：清单与回执照常可看；当天未结算的预览经验不是可消费金币，余额只含已入账金币。</p>
          ) : null}
          <p className="game-note">余额只计算已结算入账的金币；当天未结算的预览经验不在可兑换余额内。兑换只记个人回执，不代购、不下单，不动任何真实账户。</p>
          {note ? <p className="game-action-note" role="status">{note}</p> : null}

          {lastReceipt ? (
            <div className="reward-receipt" role="status">
              <div className="section-line">
                <strong>{lastReceipt.verification === "verified"
                  ? <><span aria-hidden="true">✓</span> 已兑换 · 回执 #{lastReceipt.id}</>
                  : <><span aria-hidden="true">▲</span> 未核实 · 历史回执 #{lastReceipt.id}</>}</strong>
                <button type="button" className="game-btn game-btn-ghost" aria-label="关闭回执" onClick={() => { setLastReceipt(null); setReceiptNote(null); }}>关闭</button>
              </div>
              <p className="reward-receipt-main">{lastReceipt.rewardName} · 扣除 {numberLabel(lastReceipt.goldSpent)} 金币 · 剩余已保存余额 {numberLabel(lastReceipt.balanceAfter)} 金币</p>
              <p className="game-note">兑换时间 {updatedLabel(lastReceipt.redeemedAt)} · {fullDateLabel(lastReceipt.localDate)}</p>
              {receiptNote ? <p className="game-note">{receiptNote}</p> : null}
              {lastReceipt.verification === "verified" ? (
                <p className="game-note">这张回执只证明金币已兑换，不证明现实奖励已经享用。</p>
              ) : (
                <p className="game-note">这张回执未核实：没有逐笔完成证明，不能确认上面的扣账已经完成；它保留原样，不会被补扣、删除或改写。</p>
              )}
              {data.goalRewardId === lastReceipt.rewardId ? (
                <div className="reward-actions">
                  <button type="button" className="game-btn" aria-label="保留这条奖励为下一目标" onClick={() => { setLastReceipt(null); setReceiptNote(null); }}>保留该目标</button>
                  <button type="button" className="game-btn game-btn-ghost" aria-label="去选择下一项奖励作为目标" onClick={chooseNextGoal}>选择下一项</button>
                </div>
              ) : null}
            </div>
          ) : null}

          {stage.kind === "preview" ? (
            <div className="reward-preview" role="group" aria-label="兑换确认预览">
              <strong>确认兑换</strong>
              <dl>
                <div><dt>奖励</dt><dd>{stage.draft.name}</dd></div>
                <div><dt>价格</dt><dd>{numberLabel(stage.draft.price)} 金币</dd></div>
                <div><dt>当前已保存余额</dt><dd>{numberLabel(stage.draft.balance)} 金币</dd></div>
                <div><dt>兑换后剩余</dt><dd>{numberLabel(stage.draft.balance - stage.draft.price)} 金币</dd></div>
              </dl>
              <p className="game-note">兑换只记个人回执，不代购、不下单，不动任何真实账户。确认后按上面固定的价格与余额版本扣账；期间价格或余额有变化会拒绝并请你重新确认，不会按新价格直接扣。</p>
              <div className="reward-actions">
                <button type="button" className="game-btn" aria-label={`确认兑换 ${stage.draft.name}，${stage.draft.price} 金币`} disabled={redeem.isPending} onClick={() => redeem.mutate(stage.draft)}>{redeem.isPending ? "兑换中…" : "确认兑换"}</button>
                <button type="button" className="game-btn game-btn-ghost" aria-label="返回奖励清单" disabled={redeem.isPending} onClick={() => setStage({ kind: "list" })}>返回清单</button>
              </div>
            </div>
          ) : stage.kind === "unconfirmed" ? (
            <div className="reward-preview" role="alert">
              <strong><span aria-hidden="true">▲</span> 兑换结果未确认</strong>
              <p className="game-note">刚才的兑换请求没有收到回复——它可能已经入账，也可能没有。在确认之前不要重新发起新的兑换。下面用同一个请求编号查回执；查不到时可以用同一请求重试，结果只会是原回执，不会重复扣账。</p>
              <p className="reward-receipt-main">{stage.draft.name} · {numberLabel(stage.draft.price)} 金币</p>
              {stage.lookupNote ? <p className="game-note" role="status">{stage.lookupNote}</p> : null}
              <div className="reward-actions">
                <button type="button" className="game-btn" aria-label="用同一请求编号查询兑换回执" disabled={lookup.isPending} onClick={() => lookup.mutate(stage.draft.requestId)}>{lookup.isPending ? "查询中…" : "查询回执"}</button>
                <button type="button" className="game-btn game-btn-ghost" aria-label="用同一请求重试兑换" disabled={redeem.isPending} onClick={() => redeem.mutate(stage.draft)}>用同一请求重试兑换</button>
                <button type="button" className="game-btn game-btn-ghost" aria-label="稍后再确认兑换结果" onClick={() => setStage({ kind: "list" })}>稍后再确认</button>
              </div>
            </div>
          ) : (
            <>
              {pendingRecovery && !data.receipts.some((receipt) => receipt.requestId === pendingRecovery.requestId) ? (
                <div className="reward-preview" role="alert">
                  <strong><span aria-hidden="true">▲</span> 兑换结果未确认</strong>
                  <p className="game-note">有一笔此前的兑换（{pendingRecovery.name} · {numberLabel(pendingRecovery.price)} 金币）结果还没有确认。继续确认会沿用原来的请求编号查回执或重试，不会生成新的请求。</p>
                  <div className="reward-actions">
                    <button type="button" className="game-btn" aria-label="继续确认未确认的兑换结果" onClick={() => setStage({ kind: "unconfirmed", draft: pendingRecovery, lookupNote: null })}>继续确认</button>
                  </div>
                </div>
              ) : null}
              <div className="game-shop" id="game-rewards-list" tabIndex={-1}>
                {data.rewards.length ? data.rewards.map((reward) => {
                  const shortfall = reward.price - balance;
                  const affordable = shortfall <= 0;
                  const editing = editingId === reward.id;
                  return (
                    <div className="game-item" key={reward.id}>
                      {editing ? (
                        <div className="reward-edit">
                          <label>奖励名称<input aria-label={`编辑奖励名称（当前 ${reward.name}）`} type="text" maxLength={60} value={editName} onChange={(event) => setEditName(event.target.value)} /></label>
                          <label>所需金币<input aria-label={`编辑奖励所需金币（当前 ${reward.price}）`} type="number" min={1} step={1} inputMode="numeric" value={editPrice} onChange={(event) => setEditPrice(event.target.value)} /></label>
                          <div className="reward-actions">
                            <button type="button" className="game-btn" aria-label={`保存奖励 ${reward.name} 的修改`} disabled={saveReward.isPending} onClick={() => submitEdit(reward)}>保存</button>
                            <button type="button" className="game-btn game-btn-ghost" aria-label="取消编辑奖励" disabled={saveReward.isPending} onClick={() => setEditingId(null)}>取消</button>
                          </div>
                        </div>
                      ) : (
                        <>
                          <div className="game-item-main">
                            <strong>{reward.name}</strong>
                            {reward.id === data.goalRewardId ? <span className="status-chip status-ok"><span aria-hidden="true">◎</span> 下一奖励</span> : null}
                            <small>价格 {numberLabel(reward.price)} 金币 · {balanceVerified ? `已保存余额 ${numberLabel(balance)} 金币` : "余额暂不可核实"}</small>
                            <small>{!balanceVerified ? "余额暂不可核实，暂时不能兑换" : affordable ? `✓ 可兑换 · 兑换后剩 ${numberLabel(balance - reward.price)} 金币` : `还差 ${numberLabel(shortfall)} 金币`}</small>
                          </div>
                          <div className="reward-actions">
                            {balanceVerified && affordable ? (
                              <button type="button" className="game-btn" aria-label={`兑换 ${reward.name}，${reward.price} 金币`} disabled={redeem.isPending} onClick={() => void openPreview(reward)}>兑换</button>
                            ) : balanceVerified ? (
                              <span className="game-item-locked">还差 {numberLabel(shortfall)} 金币</span>
                            ) : null}
                            {reward.id !== data.goalRewardId ? (
                              <button type="button" className="game-btn game-btn-ghost" data-goal-pick="true" aria-label={`把 ${reward.name} 设为下一奖励`} disabled={setGoal.isPending} onClick={() => setGoal.mutate(reward.id)}>设为下一奖励</button>
                            ) : null}
                            <button type="button" className="game-btn game-btn-ghost" aria-label={`编辑奖励 ${reward.name}`} onClick={() => { setEditingId(reward.id); setEditName(reward.name); setEditPrice(String(reward.price)); }}>编辑</button>
                          </div>
                        </>
                      )}
                    </div>
                  );
                }) : (
                  <p className="game-note">还没有自设奖励。用下面的表单添加第一条：名称 + 所需金币。</p>
                )}
              </div>
              <form className="reward-form" onSubmit={(event) => { event.preventDefault(); submitNew(); }}>
                <label>新奖励名称<input aria-label="新奖励名称" type="text" maxLength={60} placeholder="例如：一顿大餐" value={newName} onChange={(event) => setNewName(event.target.value)} /></label>
                <label>所需金币<input aria-label="新奖励所需金币" type="number" min={1} step={1} inputMode="numeric" placeholder="例如：500" value={newPrice} onChange={(event) => setNewPrice(event.target.value)} /></label>
                <button type="submit" className="game-btn" aria-label="添加奖励" disabled={saveReward.isPending}>添加奖励</button>
              </form>
            </>
          )}

          {data.receipts.length ? (
            <>
              <div className="section-line reward-history-head"><h4>兑换回执</h4><span>按时间倒序 · 改价不改旧回执</span></div>
              <div className="game-ledger">
                {data.receipts.map((receipt) => (
                  <div className="game-ledger-row" key={receipt.id}>
                    <span className="unified-date">{dateLabel(receipt.localDate)}</span>
                    <div className="unified-main">
                      <strong><span aria-hidden="true">✧</span> {receipt.rewardName}</strong>
                      <small>回执 #{receipt.id} · {fullDateLabel(receipt.localDate)} · {updatedLabel(receipt.redeemedAt)} · 当时价格 {numberLabel(receipt.price)} 金币 · {receipt.verification === "verified" ? "✓ 已完成" : "▲ 未核实（无逐笔完成证明）"}</small>
                    </div>
                    <span className="game-xp">−{numberLabel(receipt.goldSpent)} 金币 · 余 {numberLabel(receipt.balanceAfter)}</span>
                  </div>
                ))}
              </div>
              <p className="game-note">标「✓ 已完成」的回执只证明金币已兑换，不证明现实奖励已经享用；标「▲ 未核实」的历史回执没有逐笔完成证明，不能确认扣账已经完成。来源迟到修订或改价不会删除回执，也不会按今天的价格改动旧回执金额。</p>
            </>
          ) : (
            <p className="game-note">还没有兑换回执。兑换成功后，回执会留在这里，之后改价也不会改动它。</p>
          )}
        </>
      )}
    </section>
  );
}

function GameView() {
  const queryClient = useQueryClient();
  const game = useQuery({ queryKey: ["game"], queryFn: () => api.getGameState({}) });
  const [actionNote, setActionNote] = useState<string | null>(null);
  const onMutationDone = (result: { ok: boolean; message: string }) => {
    setActionNote(result.message);
    if (result.ok) {
      void queryClient.invalidateQueries({ queryKey: ["game"] });
      // A purchase/allocation moves the same profile the rewards
      // preview pins (balance + balance version): refresh the rewards
      // section too, so its pins never go stale silently.
      void queryClient.invalidateQueries({ queryKey: ["rewards"] });
    }
  };
  const allocate = useMutation({ mutationFn: (args: { attribute: GameAttributeKey; count: number }) => api.allocateAttribute(args), onSuccess: onMutationDone });
  const buy = useMutation({ mutationFn: (itemId: string) => api.buyEquipment({ itemId }), onSuccess: onMutationDone });
  const equip = useMutation({ mutationFn: (itemId: string) => api.equipItem({ itemId }), onSuccess: onMutationDone });
  const unequip = useMutation({ mutationFn: (slot: "weapon" | "armor" | "accessory") => api.unequipItem({ slot }), onSuccess: onMutationDone });
  const mutating = allocate.isPending || buy.isPending || equip.isPending || unequip.isPending;
  if (game.isPending) {
    return <div className="loading" role="status"><span /><p>正在读取角色数据…</p></div>;
  }
  if (game.isError || !game.data || game.data.forbidden || !game.data.ok) {
    return (
      <section className="game-panel" aria-labelledby="game-error-title">
        <p className="section-kicker">人生游戏</p>
        <h2 id="game-error-title">游戏结算暂时不可用</h2>
        <p className="game-note">角色与经验数据暂时读不出来；健康看板的其他视图不受影响，稍后切回来再试即可。</p>
      </section>
    );
  }
  const data = game.data;
  const quest = data.quest;
  const levelPct = Math.min(100, (data.xpIntoLevel / data.xpPerLevel) * 100);
  const questPct = quest.steps === null ? 0 : Math.min(100, Math.round((quest.steps / quest.targetSteps) * 100));
  const questChip = quest.state === "settled"
    ? { symbol: "★", text: "已达标 · 奖励已入账", cls: "status-ok" }
    : quest.state === "achieved"
      ? { symbol: "✓", text: "已达标 · 奖励待入账", cls: "status-ok" }
      : quest.state === "in_progress"
        ? { symbol: "●", text: `进行中 · 还差 ${numberLabel(quest.targetSteps - (quest.steps ?? 0))} 步`, cls: "status-watch" }
        : { symbol: "—", text: "今日步数尚未同步", cls: "status-missing" };
  const bonusFor = (domain: GameState["domainBonuses"][number]["domain"]) => data.domainBonuses.find((bonus) => bonus.domain === domain);
  return (
    <div className="game-view">
      <section className="game-panel" aria-labelledby="game-character-title">
        <div className="section-line"><p className="section-kicker">人生游戏 · 角色</p><span>经验规则 v{data.ruleVersion}</span></div>
        <div className="game-level-row">
          <strong className="game-level">Lv {data.level}</strong>
          <span className="game-total">总经验 {numberLabel(data.totalXp)} XP</span>
          <span className="game-gold"><span aria-hidden="true">◉</span> 金币 {numberLabel(data.gold)}</span>
        </div>
        <div className="game-progress" role="progressbar" aria-label={`距 Lv ${data.level + 1} 进度`} aria-valuemin={0} aria-valuemax={data.xpPerLevel} aria-valuenow={data.xpIntoLevel}>
          <i style={{ width: `${levelPct}%` }} />
        </div>
        <p className="game-progress-text">本级 {data.xpIntoLevel} / {data.xpPerLevel} XP · 距 Lv {data.level + 1} 还差 {data.xpToNextLevel} XP{data.settledThroughDate ? ` · 已结算至 ${fullDateLabel(data.settledThroughDate)}` : " · 尚无结算记录"}</p>
        {data.unspentPoints > 0 ? <p className="game-points-note"><span aria-hidden="true">✚</span> 有 {data.unspentPoints} 点未分配属性点，去下方属性区加点。</p> : null}
        <NextRewardGoal />
        <p className="game-rules">经验规则 v{data.ruleVersion}：步数每 1000 步 1 XP（单日封顶 20）；主睡眠满 7 小时 10 XP，不足按比例向下取整；力量训练每完成一场 10 XP；主任务达标另 +10 XP。等级每 100 XP 一级，每升一级得 3 点属性点。属性每点使对应领域结算经验 +2%（属性部分单领域封顶 +50%），装备效果叠加在属性之上；加成只对分配 / 装备之后的新结算生效，旧账本不重算（v1 账本保持原样）。金币：余额最初按累计 XP 一次性 1:1 折算，此后每次经验结算按实得 XP 1:1 增发（装备金币加成会放大增发）。每日任务奖励固定 XP 与金币，不吃领域加成，每任务每日限领一次。打开页面时按洛杉矶本地日结算，只结算数据完整的日期；缺失数据如实显示、不发经验；同一天同一类别只结算一次。</p>
        <p className="game-rules">数据完整后才结算；来源修订会自动按差额修正账本。</p>
        {data.healthState !== "ok" ? <p className="game-note">健康数据{data.healthState === "corrupt" ? "快照损坏" : "尚未同步"}：步行与睡眠经验暂时无法结算，已入账的经验与金币不受影响。</p> : null}
        {actionNote ? <p className="game-action-note" role="status">{actionNote}</p> : null}
      </section>

      <section className="game-panel" aria-labelledby="game-attrs-title">
        <div className="section-line"><h3 id="game-attrs-title">属性</h3><span>未分配 {data.unspentPoints} 点 · 每级 +3 点</span></div>
        <div className="game-attrs">
          {GAME_ATTRIBUTE_META.map((meta) => {
            const value = data.attributes[meta.key];
            const bonus = bonusFor(meta.domain);
            const totalPct = (bonus?.attrPct ?? 0) + (bonus?.equipPct ?? 0);
            return (
              <div className="game-attr-row" key={meta.key}>
                <div className="game-attr-main">
                  <strong><span aria-hidden="true">{meta.symbol}</span> {meta.label}</strong>
                  <small>对应{meta.domainLabel} · 属性 +{bonus?.attrPct ?? 0}%{bonus && bonus.equipPct > 0 ? ` · 装备 +${bonus.equipPct}%` : ""} · 合计 +{totalPct}%</small>
                </div>
                <span className="game-attr-value">{value}</span>
                <button type="button" className="game-btn" aria-label={`给${meta.label}加 1 点`} disabled={data.unspentPoints <= 0 || mutating} onClick={() => allocate.mutate({ attribute: meta.key, count: 1 })}>+1</button>
              </div>
            );
          })}
        </div>
        <p className="game-note">每点 +2% 对应领域经验，属性部分单领域封顶 +50%（25 点）；分配后不可撤销（v1 无洗点），只影响之后的新结算。</p>
      </section>

      <section className="game-panel" aria-labelledby="game-equip-title">
        <div className="section-line"><h3 id="game-equip-title">装备与商店</h3><span>金币 {numberLabel(data.gold)}{data.goldBonusPct > 0 ? ` · 金币加成 +${data.goldBonusPct}%` : ""}</span></div>
        <div className="game-slots">
          {GAME_SLOT_META.map((slotMeta) => {
            const equippedItem = data.equipment.find((item) => item.slot === slotMeta.slot && item.equipped);
            return (
              <div className="game-slot" key={slotMeta.slot}>
                <span className="game-slot-label"><span aria-hidden="true">{slotMeta.symbol}</span> {slotMeta.label}</span>
                {equippedItem ? (
                  <>
                    <strong>{equippedItem.name}</strong>
                    <small>{equippedItem.effectLabel}</small>
                    <button type="button" className="game-btn game-btn-ghost" aria-label={`卸下${slotMeta.label} ${equippedItem.name}`} disabled={mutating} onClick={() => unequip.mutate(slotMeta.slot)}>卸下</button>
                  </>
                ) : (
                  <small className="game-slot-empty">空 · 未装备</small>
                )}
              </div>
            );
          })}
        </div>
        <div className="game-shop">
          {data.equipment.map((item) => {
            const slotLabel = GAME_SLOT_META.find((slotMeta) => slotMeta.slot === item.slot)?.label ?? item.slot;
            return (
              <div className="game-item" key={item.id}>
                <div className="game-item-main">
                  <strong>{item.name}</strong>
                  <small>{slotLabel} · {item.effectLabel}</small>
                  <small>{item.obtain === "task" ? item.obtainNote : item.price !== null ? `价格 ${numberLabel(item.price)} 金币` : item.obtainNote}</small>
                </div>
                {item.equipped ? (
                  <span className="status-chip status-ok"><span aria-hidden="true">✓</span> 已装备</span>
                ) : item.owned ? (
                  <button type="button" className="game-btn" aria-label={`装备 ${item.name}`} disabled={mutating} onClick={() => equip.mutate(item.id)}>装备</button>
                ) : item.obtain === "task" ? (
                  <span className="game-item-locked">任务获得</span>
                ) : (
                  <button type="button" className="game-btn" aria-label={`购买 ${item.name}，${item.price ?? 0} 金币`} disabled={mutating || item.price === null || data.gold < item.price} onClick={() => buy.mutate(item.id)}>购买</button>
                )}
              </div>
            );
          })}
        </div>
        <p className="game-note">每槽位只能装备一件，换装直接替换；装备效果与属性加成叠加，只对之后的新结算生效。无抽卡、无随机词缀、无真实付费。</p>
      </section>

      <RewardsPanel />

      <section className="game-panel" aria-labelledby="game-daily-title">
        <div className="section-line"><h3 id="game-daily-title">每日额外任务</h3><span>每日 3 个 · 达标自动入账</span></div>
        <div className="game-tasks">
          {data.dailyTasks.map((task) => {
            const chip = task.state === "claimed"
              ? { symbol: "✓", text: "已完成 · 奖励已入账", cls: "status-ok" }
              : task.state === "completed"
                ? { symbol: "✓", text: "已达标", cls: "status-ok" }
                : task.state === "in_progress"
                  ? { symbol: "●", text: "进行中", cls: "status-watch" }
                  : { symbol: "—", text: "数据未同步", cls: "status-missing" };
            const pct = task.progress === null ? 0 : Math.min(100, Math.round((task.progress / task.target) * 100));
            return (
              <div className="game-task" key={task.id}>
                <div className="section-line">
                  <strong>{task.label}</strong>
                  <span className={`status-chip ${chip.cls}`}><span aria-hidden="true">{chip.symbol}</span> {chip.text}</span>
                </div>
                <div className="game-progress" role="progressbar" aria-label={`${task.label}进度`} aria-valuemin={0} aria-valuemax={task.target} aria-valuenow={task.progress ?? 0}>
                  <i style={{ width: `${pct}%` }} />
                </div>
                <p className="game-progress-text">{task.progressLabel} · 奖励 +{task.rewardXp} XP · +{task.rewardGold} 金币</p>
              </div>
            );
          })}
        </div>
      </section>

      <section className="game-panel" aria-labelledby="game-quest-title">
        <div className="section-line">
          <h3 id="game-quest-title">今日主任务 · 步行 {numberLabel(quest.targetSteps)} 步</h3>
          <span className={`status-chip ${questChip.cls}`}><span aria-hidden="true">{questChip.symbol}</span> {questChip.text}</span>
        </div>
        <div className="game-progress" role="progressbar" aria-label="今日步行进度" aria-valuemin={0} aria-valuemax={quest.targetSteps} aria-valuenow={quest.steps ?? 0}>
          <i style={{ width: `${questPct}%` }} />
        </div>
        <p className="game-progress-text">
          {quest.steps === null
            ? "今日步数会随健康数据每日同步进来；达标奖励在该日数据完整后自动入账，昨天的结果可以在下方账本里查。"
            : `今日已走 ${numberLabel(quest.steps)} / ${numberLabel(quest.targetSteps)} 步（${questPct}%）`}
          {" "}· 达标奖励 +{quest.rewardXp} XP
        </p>
      </section>

      <section className="game-panel game-camp" aria-labelledby="game-camp-title">
        <p className="section-kicker">营地</p>
        <h3 id="game-camp-title">营地建设中</h3>
        <p className="game-note">营地是后续切片的内容。当前先积累经验与金币——账本里的每一笔都不会丢失。</p>
      </section>

      {data.previews.length ? (
        <section className="game-panel" aria-labelledby="game-preview-title">
          <div className="section-line"><h3 id="game-preview-title">待结算与缺失</h3><span>预览不入账</span></div>
          <div className="game-ledger">
            {data.previews.map((preview) => {
              const meta = GAME_CATEGORY_META[preview.category];
              return (
                <div className="game-ledger-row" key={`preview-${preview.localDate}-${preview.category}`}>
                  <span className="unified-date">{dateLabel(preview.localDate)}</span>
                  <div className="unified-main">
                    <strong><span aria-hidden="true">{meta.symbol}</span> {meta.label}</strong>
                    <small>{preview.note}</small>
                  </div>
                  <span className="game-xp game-xp-muted">{preview.state === "missing" ? "— 未发放" : `预览 +${preview.xp ?? 0} XP`}</span>
                </div>
              );
            })}
          </div>
        </section>
      ) : null}

      <section className="game-panel" aria-labelledby="game-ledger-title">
        <div className="section-line"><h3 id="game-ledger-title">经验账本</h3><span>逐日逐类 · 规则 v{data.ruleVersion}</span></div>
        {data.settlements.length ? (
          <div className="game-ledger">
            {data.settlements.map((entry) => {
              const meta = GAME_CATEGORY_META[entry.category];
              const label = entry.category === "daily_task" ? (GAME_TASK_LABELS[entry.detail] ?? meta.label) : meta.label;
              return (
                <div className="game-ledger-row" key={`${entry.localDate}-${entry.category}-${entry.detail}`}>
                  <span className="unified-date">{dateLabel(entry.localDate)}</span>
                  <div className="unified-main">
                    <strong><span aria-hidden="true">{meta.symbol}</span> {label}</strong>
                    <small>{fullDateLabel(entry.localDate)} · {entry.category === "reward_redeem" ? "兑换流水 · 已入账" : `已结算 · 规则 v${entry.ruleVersion}`}</small>
                  </div>
                  <span className="game-xp">{entry.category === "reward_redeem" ? `−${numberLabel(-entry.gold)} 金币` : `+${entry.xp} XP${entry.gold > 0 ? ` · +${numberLabel(entry.gold)} 金币` : entry.gold < 0 ? ` · −${numberLabel(-entry.gold)} 金币` : ""}`}</span>
                </div>
              );
            })}
          </div>
        ) : (
          <p className="game-note">暂无结算记录。步行、主睡眠或力量训练的数据完整入账后，打开这一页就会自动结算到这里。</p>
        )}
      </section>
    </div>
  );
}

function Dashboard({ snapshot, readiness, readinessHistory, dataStatus, unifiedTimeline, autoSyncFailureNote, focusFeedback, focusReadFailed }: { snapshot: Snapshot; readiness: Readiness | null; readinessHistory: ReadinessHistoryPoint[]; dataStatus: DataStatus | null; unifiedTimeline: UnifiedDay[]; autoSyncFailureNote: string | null; focusFeedback: FocusFeedbackData; focusReadFailed: boolean }) {
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
        <button type="button" className={tab === "today" ? "selected" : ""} aria-current={tab === "today" ? "page" : undefined} onClick={() => setTab("today")}>今日</button>
        <button type="button" className={tab === "trends" ? "selected" : ""} aria-current={tab === "trends" ? "page" : undefined} onClick={() => setTab("trends")}>趋势</button>
        <button type="button" className={tab === "history" ? "selected" : ""} aria-current={tab === "history" ? "page" : undefined} onClick={() => setTab("history")}>历史</button>
        <button type="button" className={tab === "game" ? "selected" : ""} aria-current={tab === "game" ? "page" : undefined} onClick={() => setTab("game")}>角色</button>
      </nav>
      {tab === "today" ? <TodayView snapshot={snapshot} readiness={readiness} readinessHistory={readinessHistory} onSyncHealth={() => refresh.mutate()} onSyncStrength={() => strengthRefresh.mutate()} strengthSyncing={isSyncing} syncing={isSyncing} dataStatus={dataStatus} unifiedTimeline={unifiedTimeline} focusFeedback={focusFeedback} focusReadFailed={focusReadFailed} /> : tab === "trends" ? <TrendsView snapshot={snapshot} /> : tab === "game" ? <GameView /> : <HistoryView snapshot={snapshot} unifiedTimeline={unifiedTimeline} />}
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
  // The game lives behind the same 角色 tab as in the main dashboard nav —
  // never embedded at the bottom of this view — so the owner reaches it
  // with one tap in every data state.
  const [view, setView] = useState<"health" | "game">("health");
  return (
    <div className="strength-only-view">
      <nav className="view-tabs view-tabs-2" aria-label="健康看板视图">
        <button type="button" className={view === "health" ? "selected" : ""} aria-current={view === "health" ? "page" : undefined} onClick={() => setView("health")}>总览</button>
        <button type="button" className={view === "game" ? "selected" : ""} aria-current={view === "game" ? "page" : undefined} onClick={() => setView("game")}>角色</button>
      </nav>
      {view === "game" ? <GameView /> : (
        <>
          <section className="source-notice" aria-labelledby="strength-only-title">
            <p className="section-kicker">只有训练数据</p>
            <h1 id="strength-only-title">{corrupt ? "健康快照损坏" : "健康数据尚未同步"}</h1>
            <p>{corrupt
              ? "保存的健康快照已损坏，暂时读不出来；训练记录是独立保存的，不受影响，照常显示在下面。重新同步 Apple 健康后健康数据会恢复。"
              : "还没有同步过 Apple 健康，所以步数、心率与睡眠暂时看不到；训练记录是独立同步的，已有训练照常显示在下面。"}</p>
            <button className="sync-button" type="button" aria-label="同步 Apple 健康数据" onClick={onSyncHealth} disabled={healthSyncing}>{healthSyncing ? "同步中…" : "同步 Apple 健康"}</button>
          </section>
          <StrengthPanel strength={strength} onSync={onSyncStrength} syncing={strengthSyncing} />
          <MuscleStatusPanel strength={strength} />
          <DataStatusPanel dataStatus={dataStatus} unifiedTimeline={unifiedTimeline} displayUnit={strength.displayUnit} />
        </>
      )}
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
  // Empty-state shell tab: even before the first health sync, the 角色
  // tab stays visible and reachable next to the 总览 empty state, the
  // same independent tab the main dashboard nav carries.
  const [emptyView, setEmptyView] = useState<"health" | "game">("health");
  return (
    <div className="app-shell"><SafeAreaTopScrim backgroundColor="var(--bg)" /><main>
      {dashboard.isPending ? <div className="loading" role="status"><span /><p>正在读取健康数据…</p></div> : dashboard.isError ? <div className="empty-state" role="alert"><h1>暂时无法读取数据</h1><p>请稍后重新打开看板。</p></div> : dashboard.data.forbidden ? <div className="empty-state"><h1>健康数据仅所有者可查看</h1><p>此看板包含所有者的个人健康记录，当前访问身份无权查看。</p></div> : dashboard.data.snapshot ? <Dashboard snapshot={dashboard.data.snapshot} readiness={dashboard.data.readiness} readinessHistory={dashboard.data.readinessHistory} dataStatus={dashboard.data.dataStatus} unifiedTimeline={dashboard.data.unifiedTimeline} autoSyncFailureNote={polling.failureNote} focusFeedback={dashboard.data.focusFeedback} focusReadFailed={dashboard.isRefetchError} /> : dashboard.data.strength ? (
        <>
          <StrengthOnlyView strength={dashboard.data.strength} healthState={dashboard.data.healthState} dataStatus={dashboard.data.dataStatus} unifiedTimeline={dashboard.data.unifiedTimeline} onSyncHealth={() => firstSync.mutate()} healthSyncing={firstSyncing} onSyncStrength={() => strengthRefresh.mutate()} strengthSyncing={strengthSyncing} />
          {polling.failureNote ? <p className="refresh-note" role="status">{polling.failureNote}</p> : firstSync.data ? <p className="refresh-note" role="status">{polling.syncing ? `${firstSync.data.message}，完成后会自动更新` : firstSync.data.message}</p> : null}
        </>
      ) : (
        <>
          <nav className="view-tabs view-tabs-2" aria-label="健康看板视图">
            <button type="button" className={emptyView === "health" ? "selected" : ""} aria-current={emptyView === "health" ? "page" : undefined} onClick={() => setEmptyView("health")}>总览</button>
            <button type="button" className={emptyView === "game" ? "selected" : ""} aria-current={emptyView === "game" ? "page" : undefined} onClick={() => setEmptyView("game")}>角色</button>
          </nav>
          {emptyView === "game" ? <GameView /> : (
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
        </>
      )}
      <footer>仅供健康参考，不做医疗诊断；身体不适请及时看医生。</footer>
    </main></div>
  );
}
