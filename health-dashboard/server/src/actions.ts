import { defineAction, z, type ActionsModule, type Ctx } from "@hatch/space-sdk";
import { and, asc, desc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import * as schema from "./schema";

const statusSchema = z.enum(["正常", "偏低", "偏高", "数据缺失"]);

const trendPointSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  stepCount: z.number().nonnegative().nullable(),
  restingHrBpm: z.number().positive().nullable(),
  hrvMs: z.number().nonnegative().nullable(),
});

const dailySchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  steps: z.number().nonnegative().nullable(),
  activeKcal: z.number().nonnegative().nullable(),
  exerciseMinutes: z.number().nonnegative().nullable(),
  restingHr: z.number().positive().nullable(),
  hrvMs: z.number().nonnegative().nullable(),
  respiratoryRate: z.number().positive().nullable(),
  weightKg: z.number().positive().nullable(),
  swimMeters: z.number().nonnegative().nullable(),
  // The day's highest observed heart rate (hr_max_bpm). Optional so
  // snapshots saved before this field existed still parse; it feeds the
  // Banister TRIMP load score's HRmax (max over the stored window).
  hrMax: z.number().positive().nullable().optional(),
});

const workoutSchema = z.object({
  id: z.string().min(1),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  type: z.string().min(1),
  durationMinutes: z.number().nonnegative().nullable(),
  energyKcal: z.number().nonnegative().nullable(),
  distanceMeters: z.number().nonnegative().nullable(),
  averageHr: z.number().positive().nullable(),
});

const sleepHistorySchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  start: z.string().min(1),
  end: z.string().min(1),
  totalHours: z.number().nonnegative(),
  coreHours: z.number().nonnegative().nullable().optional(),
  deepHours: z.number().nonnegative().nullable().optional(),
  remHours: z.number().nonnegative().nullable().optional(),
  awakeMinutes: z.number().nonnegative().nullable().optional(),
  quality: z.number().min(0).max(100).nullable(),
  awakenings: z.number().int().nonnegative().nullable(),
  efficiency: z.number().min(0).max(100).nullable(),
});

const strengthSetSchema = z.object({
  setNumber: z.number().int().positive(),
  weight: z.number().nonnegative().nullable(),
  reps: z.number().int().nonnegative().nullable(),
  completed: z.boolean(),
});

const strengthExerciseSchema = z.object({
  key: z.string().min(1),
  name: z.string().min(1),
  sets: z.array(strengthSetSchema).max(20),
  completedSets: z.number().int().nonnegative(),
  volume: z.number().nonnegative(),
});

const strengthWorkoutSchema = z.object({
  id: z.string().min(1),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  startedAt: z.string().datetime(),
  completedAt: z.string().datetime().nullable(),
  status: z.enum(["active", "completed"]),
  // Five routine values (L1-ROUTINE-001): 训练记录 (space-6) added the two
  // home routines home_posture / home_snowboard to its plan. The value is
  // stored and read back verbatim — a home routine is never remapped onto
  // push/pull/legs and never dropped. An unknown future routine value
  // fails this schema outright, which rejects the whole incoming snapshot
  // and keeps the previously stored one (see the CAS persist path); a
  // partial write masquerading as complete is not possible.
  routine: z.enum(["push", "pull", "legs", "home_posture", "home_snowboard"]),
  unit: z.enum(["lb", "kg"]),
  durationMinutes: z.number().nonnegative().nullable(),
  completedSets: z.number().int().nonnegative(),
  totalSets: z.number().int().nonnegative(),
  totalVolume: z.number().nonnegative(),
  exercises: z.array(strengthExerciseSchema).max(30),
});

const strengthWeekSchema = z.object({
  weekStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  sessions: z.number().int().nonnegative(),
  volume: z.number().nonnegative(),
  // Coverage counts for week-over-week comparability (H-UNITS-001). Optional
  // so snapshots saved before these fields existed still parse; an absent
  // count means the week's coverage is unknown, never "fully measured".
  // measuredCompletedSets: completed sets with both weight and reps present.
  // unmeasuredCompletedSets: completed sets missing weight or reps —
  // bodyweight sets included, since their load is not comparable.
  measuredCompletedSets: z.number().int().nonnegative().optional(),
  unmeasuredCompletedSets: z.number().int().nonnegative().optional(),
  // coverageComplete (H-UNITS-001): true only when this week's sessions,
  // counts, and volume come from the source's server-computed whole-week
  // summary (week_summaries) — i.e. they describe the entire week, not a
  // sample. Absent/false means whole-week coverage is unconfirmed and the
  // week must not feed a week-over-week percentage.
  coverageComplete: z.boolean().optional(),
});

const strengthTrainingSchema = z.object({
  updatedAt: z.string().datetime().nullable(),
  displayUnit: z.enum(["lb", "kg"]),
  workouts: z.array(strengthWorkoutSchema).max(20),
  weeklyTrend: z.array(strengthWeekSchema).max(8),
  note: z.string().min(1),
});

const snapshotSchema = z.object({
  dataDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  updatedAt: z.string().datetime(),
  timezone: z.string().min(1),
  coverageIncomplete: z.boolean(),
  steps: z.object({
    value: z.number().nonnegative().nullable(),
    baseline: z.number().nonnegative().nullable(),
    usualMin: z.number().nonnegative().nullable(),
    usualMax: z.number().nonnegative().nullable(),
    distanceKm: z.number().nonnegative().nullable(),
    flights: z.number().nonnegative().nullable(),
    basalKcal: z.number().nonnegative().nullable(),
    status: statusSchema,
  }),
  restingHr: z.object({
    value: z.number().positive().nullable(),
    baseline: z.number().positive(),
    usualMin: z.number().positive(),
    usualMax: z.number().positive(),
    status: statusSchema,
  }),
  hrv: z.object({
    value: z.number().nonnegative().nullable(),
    baseline: z.number().positive(),
    usualMin: z.number().nonnegative(),
    usualMax: z.number().positive(),
    status: statusSchema,
  }),
  respiratoryRate: z.object({
    value: z.number().positive().nullable(),
    status: statusSchema,
  }),
  sleep: z.object({
    bedtime: z.string().regex(/^\d{2}:\d{2}$/),
    wakeTime: z.string().regex(/^\d{2}:\d{2}$/),
    inBedHours: z.number().nonnegative(),
    coreHours: z.number().nonnegative().nullable(),
    deepHours: z.number().nonnegative().nullable(),
    remHours: z.number().nonnegative().nullable(),
    awakeMinutes: z.number().nonnegative().nullable(),
    quality: z.number().min(0).max(100).nullable(),
    efficiency: z.number().min(0).max(100).nullable(),
    awakenings: z.number().int().nonnegative().nullable(),
    status: statusSchema,
  }),
  morningReference: z.object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    hrvMs: z.number().nonnegative().nullable(),
    avgHrBpm: z.number().positive().nullable(),
  }).nullable(),
  strengthTraining: strengthTrainingSchema,
  workouts: z.object({
    count7d: z.number().int().nonnegative(),
    baselinePerWeek: z.number().nonnegative(),
    note: z.string().min(1),
  }),
  trends: z.array(trendPointSchema).min(1).max(7),
  historyDaily: z.array(dailySchema).max(35),
  historyWorkouts: z.array(workoutSchema).max(100),
  historySleeps: z.array(sleepHistorySchema).max(14),
});

type Snapshot = z.infer<typeof snapshotSchema>;
type StrengthTraining = z.infer<typeof strengthTrainingSchema>;

// Owner-only gate (AUDIT-02 / L0.1): every browser-facing read, write, and
// initialization action must verify this before touching the database. A
// missing viewer (null/undefined) is treated as not authorized, never as
// owner — a guest following a share link always arrives WITH a viewer whose
// isOwner is false, so data is never exposed to a non-owner identity.
function isOwner(ctx: Ctx): boolean {
  return ctx.viewer?.isOwner === true;
}

// Trusted sync channel (timeliness fix, 2026-10-14): the artifact's own
// background pipeline does not travel through a browser. The daily schedule
// invokes refreshHealthData directly (kind=space_action), and spawned sync
// tasks deliver results by calling the save actions as their expectsAction
// return — neither invocation carries a browser viewer, so the strict
// isOwner gate above silently rejected every scheduled refresh and every
// task callback after L0.1 shipped: both snapshots froze at the last
// pre-gate sync while the schedule kept reporting success. The actions that
// exist solely as pipeline entry points (the scheduler-invoked refresh and
// the two save callbacks) therefore accept an invocation that carries NO
// viewer at all — a shape only daemon-internal channels (this artifact's
// own schedule, its own spawned tasks' returns) can produce — while any
// invocation that DOES carry a viewer must still be the owner. None of
// these actions returns health data to its caller, so reads stay locked:
// getDashboard, getRefreshStatus, saveMorningCheckin, initializeSnapshot,
// and the manual refreshStrengthTraining button keep the strict gate.
function isOwnerOrSyncChannel(ctx: Ctx): boolean {
  return ctx.viewer === undefined || ctx.viewer === null || ctx.viewer.isOwner === true;
}

const readinessComponentSchema = z.object({
  key: z.enum(["hrv", "restingHr", "lastSleep", "sleepBank", "trainingLoad", "respiratoryRate"]),
  label: z.string().min(1),
  weight: z.number().positive(),
  score: z.number().min(0).max(10).nullable(),
  zScore: z.number().min(-2.5).max(2.5).nullable(),
  contribution: z.number().nullable(),
  raw: z.string().min(1),
  baseline: z.string().min(1),
  detail: z.string().min(1),
  missingLabel: z.enum(["还没同步完", "当天没戴表"]).nullable(),
});

const radarDimensionSchema = z.object({
  key: z.enum(["sleep", "recovery", "movement", "cardio", "vitals"]),
  label: z.string().min(1),
  score: z.number().min(0).max(10),
});

const readinessSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  score: z.number().min(0).max(10).nullable(),
  objectiveScore: z.number().min(0).max(10).nullable(),
  status: z.enum(["恢复", "量力而行", "准备就绪", "全力以赴", "数据不足"]),
  summary: z.string().min(1),
  availableWeight: z.number().min(0).max(100),
  confidence: z.enum(["高", "中", "低"]),
  signalCount: z.number().int().nonnegative(),
  sleepDebtHours: z.number().nullable(),
  morningFeeling: z.number().int().min(1).max(10).nullable(),
  adjustments: z.array(z.string()),
  components: z.array(readinessComponentSchema).length(6),
  radar: z.array(radarDimensionSchema).length(5),
});

type Readiness = z.infer<typeof readinessSchema>;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function round(value: number, digits = 1): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

const LB_TO_KG = 0.45359237;
type WeightUnit = "lb" | "kg";

function convertVolumeToUnit(volume: number, fromUnit: WeightUnit, toUnit: WeightUnit): number {
  if (fromUnit === toUnit) return volume;
  if (fromUnit === "lb" && toUnit === "kg") return volume * LB_TO_KG;
  // kg -> lb
  return volume / LB_TO_KG;
}

function sumWorkoutVolumeInUnit(
  workouts: ReadonlyArray<{ totalVolume: number; unit: WeightUnit }>,
  targetUnit: WeightUnit,
): number {
  return workouts.reduce((sum, workout) => sum + convertVolumeToUnit(workout.totalVolume, workout.unit, targetUnit), 0);
}

function signed(value: number, digits = 1): string {
  return `${value > 0 ? "+" : ""}${value.toFixed(digits)}`;
}

function totalSleepHours(stages: { coreHours?: number | null; deepHours?: number | null; remHours?: number | null }, fallback: number): number {
  const stageTotal = (stages.coreHours ?? 0) + (stages.deepHours ?? 0) + (stages.remHours ?? 0);
  return stageTotal > 0 ? stageTotal : fallback;
}

function timeInBedHours(start: string, end: string): number | null {
  const parseMinutes = (value: string): number | null => {
    const match = value.match(/^(\d{2}):(\d{2})$/);
    if (!match) return null;
    const hours = Number(match[1]);
    const minutes = Number(match[2]);
    if (!Number.isInteger(hours) || !Number.isInteger(minutes) || hours > 23 || minutes > 59) return null;
    return hours * 60 + minutes;
  };
  const startMinutes = parseMinutes(start);
  const endMinutes = parseMinutes(end);
  if (startMinutes === null || endMinutes === null) return null;
  const elapsedMinutes = endMinutes > startMinutes ? endMinutes - startMinutes : endMinutes + 24 * 60 - startMinutes;
  return elapsedMinutes > 0 ? elapsedMinutes / 60 : null;
}

function normalizeSleepSnapshot(snapshot: Snapshot): Snapshot {
  const historySleeps = snapshot.historySleeps.map((row) => {
    const totalHours = totalSleepHours(row, row.totalHours);
    const inBed = timeInBedHours(row.start, row.end);
    const efficiency = inBed === null ? row.efficiency : clamp((totalHours / inBed) * 100, 0, 100);
    return { ...row, totalHours, efficiency };
  });

  // A sleep row belongs to the local calendar date on which it ended. Readiness is
  // for the current morning, while dataDate is the latest complete metrics day, so
  // dataDate must never be used as the sleep-session key.
  const readinessDate = snapshot.morningReference?.date ?? shiftDate(snapshot.dataDate, 1);
  const completedSleeps = historySleeps
    .filter((row) => row.date <= readinessDate && timeInBedHours(row.start, row.end) !== null)
    .sort((a, b) => a.date.localeCompare(b.date));
  const sameMorningSleep = completedSleeps.filter((row) => row.date === readinessDate).at(-1);
  const selectedSleep = sameMorningSleep ?? completedSleeps.at(-1);
  const mainFromHistory = selectedSleep
    ? {
        bedtime: selectedSleep.start,
        wakeTime: selectedSleep.end,
        inBedHours: selectedSleep.totalHours,
        coreHours: selectedSleep.coreHours ?? null,
        deepHours: selectedSleep.deepHours ?? null,
        remHours: selectedSleep.remHours ?? null,
        awakeMinutes: selectedSleep.awakeMinutes ?? null,
        quality: selectedSleep.quality,
        efficiency: selectedSleep.efficiency,
        awakenings: selectedSleep.awakenings,
        status: selectedSleep.totalHours < 5.5 ? "偏低" as const : selectedSleep.totalHours > 9 ? "偏高" as const : "正常" as const,
      }
    : snapshot.sleep;
  const mainTotal = totalSleepHours(mainFromHistory, mainFromHistory.inBedHours);
  const mainTimeInBed = timeInBedHours(mainFromHistory.bedtime, mainFromHistory.wakeTime);
  const mainEfficiency = mainTimeInBed === null ? mainFromHistory.efficiency : clamp((mainTotal / mainTimeInBed) * 100, 0, 100);

  return {
    ...snapshot,
    sleep: { ...mainFromHistory, inBedHours: mainTotal, efficiency: mainEfficiency },
    historySleeps,
  };
}

function mondayWeekStart(date: string): string {
  const parsed = new Date(`${date}T12:00:00Z`);
  const weekday = parsed.getUTCDay();
  parsed.setUTCDate(parsed.getUTCDate() + (weekday === 0 ? -6 : 1 - weekday));
  return parsed.toISOString().slice(0, 10);
}

function shiftDate(date: string, days: number): string {
  const parsed = new Date(`${date}T12:00:00Z`);
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

// Today's America/Los_Angeles calendar date as YYYY-MM-DD
// (H-ARCHIVE-SAFE-001): the only date an archive write may target —
// readiness is archived only for the day it is actually displayed on.
// Computed via Intl so the LA midnight boundary and DST transitions come
// from the platform tz database. `now` is injectable for tests;
// production callers use the default (the current instant).
function laTodayString(now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(now);
  const part = (type: string): string => parts.find((entry) => entry.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function stats(values: number[]): { mean: number; sd: number } | null {
  if (values.length < 8) return null;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  return { mean, sd: Math.max(Math.sqrt(variance), 0.01) };
}

function scoreFromZ(zScore: number): number {
  return round(clamp(5 + 2 * zScore, 0, 10));
}

function tierFor(score: number): Readiness["status"] {
  if (score < 2) return "恢复";
  if (score < 5) return "量力而行";
  if (score < 8) return "准备就绪";
  return "全力以赴";
}

function downgradeOneTier(score: number): number {
  if (score >= 8) return 7;
  if (score >= 5) return 4;
  if (score >= 2) return 1;
  return score;
}

function bedtimeMinutes(value: string): number | null {
  const [hoursText, minutesText] = value.split(":");
  const hours = Number(hoursText);
  const minutes = Number(minutesText);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null;
  const raw = hours * 60 + minutes;
  return raw < 12 * 60 ? raw + 24 * 60 : raw;
}

function calculateReadiness(snapshot: Snapshot, readinessDate: string, morningFeeling: number | null): Readiness {
  const historyBeforeDate = snapshot.historyDaily.filter((row) => row.date < snapshot.dataDate).slice(-14);
  const missingLabel: "还没同步完" | "当天没戴表" = snapshot.coverageIncomplete ? "还没同步完" : "当天没戴表";

  const restingHistory = historyBeforeDate.flatMap((row) => row.restingHr === null ? [] : [row.restingHr]);
  const restingStats = stats(restingHistory);
  const restingValue = snapshot.restingHr.value;
  const restingZRaw = restingValue !== null && restingStats ? (restingValue - restingStats.mean) / restingStats.sd : null;
  const restingZ = restingZRaw === null ? null : clamp(-restingZRaw, -2.5, 2.5);

  const hrvHistory = historyBeforeDate.flatMap((row) => row.hrvMs && row.hrvMs > 0 ? [Math.log(row.hrvMs)] : []);
  const hrvStats = stats(hrvHistory);
  const hrvValue = snapshot.hrv.value;
  const hrvZ = hrvValue !== null && hrvValue > 0 && hrvStats
    ? clamp((Math.log(hrvValue) - hrvStats.mean) / hrvStats.sd, -2.5, 2.5)
    : null;

  const sleepHistory = snapshot.historySleeps.filter((row) => row.date <= readinessDate).slice(-14);
  const sleepHours = sleepHistory.map((row) => totalSleepHours(row, row.totalHours));
  const sleepStats = stats(sleepHours);
  const sleepNeed = sleepStats?.mean ?? null;
  const recentSevenSleeps = sleepHistory.slice(-7);
  const sleepDebtHours = sleepNeed === null || recentSevenSleeps.length < 7
    ? null
    : Math.max(0, recentSevenSleeps.reduce((sum, row) => sum + (sleepNeed - totalSleepHours(row, row.totalHours)), 0));

  const currentBedtime = bedtimeMinutes(snapshot.sleep.bedtime);
  const bedtimeHistory = sleepHistory.flatMap((row) => {
    const parsed = bedtimeMinutes(row.start);
    return parsed === null ? [] : [parsed];
  });
  const bedtimeStats = stats(bedtimeHistory);
  const currentSleepHours = totalSleepHours(snapshot.sleep, snapshot.sleep.inBedHours);
  const durationZ = sleepStats ? clamp((currentSleepHours - sleepStats.mean) / sleepStats.sd, -2.5, 2.5) : null;
  const durationPart = durationZ === null ? null : clamp(50 + durationZ * 20, 0, 100);
  const regularityPart = currentBedtime === null || bedtimeStats === null
    ? null
    : clamp(100 - Math.abs(currentBedtime - bedtimeStats.mean) / 1.8, 0, 100);
  const interruptionPart = snapshot.sleep.awakenings !== null
    ? clamp(100 - snapshot.sleep.awakenings * 18, 0, 100)
    : snapshot.sleep.efficiency === null ? null : clamp(snapshot.sleep.efficiency, 0, 100);
  const sleepParts = [
    { value: durationPart, weight: 50 },
    { value: regularityPart, weight: 30 },
    { value: interruptionPart, weight: 20 },
  ].filter((part): part is { value: number; weight: number } => part.value !== null);
  const sleepComposite = sleepParts.length === 3
    ? sleepParts.reduce((sum, part) => sum + part.value * part.weight, 0) / 100
    : null;
  const lastSleepZ = sleepComposite === null ? null : clamp((sleepComposite - 50) / 20, -2.5, 2.5);
  const sleepBankZ = sleepDebtHours === null || sleepStats === null
    ? null
    : clamp(-sleepDebtHours / Math.max(sleepStats.sd * Math.sqrt(7), 0.5), -2.5, 0);

  const exerciseHistory = historyBeforeDate.flatMap((row) => row.exerciseMinutes === null ? [] : [row.exerciseMinutes]);
  const exerciseStats = stats(exerciseHistory);
  const recentExercise = snapshot.historyDaily
    .filter((row) => row.date >= shiftDate(snapshot.dataDate, -6) && row.date <= snapshot.dataDate)
    .flatMap((row) => row.exerciseMinutes === null ? [] : [row.exerciseMinutes]);
  const exerciseTotal = recentExercise.reduce((sum, value) => sum + value, 0);
  const trainingZ = exerciseStats && recentExercise.length >= 5
    ? clamp(-Math.max(0, (exerciseTotal - exerciseStats.mean * 7) / Math.max(exerciseStats.sd * Math.sqrt(7), 1)), -2.5, 0)
    : null;

  const respiratoryHistory = historyBeforeDate.flatMap((row) => row.respiratoryRate === null ? [] : [row.respiratoryRate]);
  const respiratoryStats = stats(respiratoryHistory);
  const respiratoryValue = snapshot.respiratoryRate.value;
  const respiratoryRawZ = respiratoryValue !== null && respiratoryStats
    ? (respiratoryValue - respiratoryStats.mean) / respiratoryStats.sd
    : null;
  const respiratoryZ = respiratoryRawZ === null ? null : clamp(-Math.max(0, respiratoryRawZ), -2.5, 0);

  const currentWeekStart = mondayWeekStart(snapshot.dataDate);
  const strengthThroughDataDate = snapshot.strengthTraining.workouts.filter((workout) => workout.date <= snapshot.dataDate);
  const currentStrength = strengthThroughDataDate.filter((workout) => workout.date >= currentWeekStart);
  const currentVolume = sumWorkoutVolumeInUnit(currentStrength, snapshot.strengthTraining.displayUnit);
  let trainingDetail = `截至 ${snapshot.dataDate.slice(5).replace("-", "/")}，近 7 天运动 ${exerciseTotal.toFixed(0)} 分钟`;
  if (currentVolume > 0) trainingDetail += `；本周力量 ${Math.round(currentVolume).toLocaleString("zh-CN")} ${snapshot.strengthTraining.displayUnit}`;
  trainingDetail += "（不计入次日训练）";

  const componentInputs: Array<Omit<Readiness["components"][number], "score" | "contribution"> & { zScore: number | null }> = [
    {
      key: "hrv", label: "HRV", weight: 32.5, zScore: hrvZ,
      raw: hrvValue === null ? "无记录" : `${hrvValue.toFixed(1)} ms`,
      baseline: hrvStats ? `14 日 ln 均值 ${Math.exp(hrvStats.mean).toFixed(1)} ms ± ${hrvStats.sd.toFixed(2)} ln(ms)` : `历史读数 ${hrvHistory.length}/8`,
      detail: hrvZ === null ? (hrvValue === null ? missingLabel : "历史读数不足，暂不纳入") : `ln(HRV) z ${signed(hrvZ)}`,
      missingLabel: hrvValue === null ? missingLabel : null,
    },
    {
      key: "restingHr", label: "静息心率", weight: 25, zScore: restingZ,
      raw: restingValue === null ? "无记录" : `${restingValue.toFixed(1)} bpm`,
      baseline: restingStats ? `14 日 ${restingStats.mean.toFixed(1)} ± ${restingStats.sd.toFixed(1)} bpm` : `历史读数 ${restingHistory.length}/8`,
      detail: restingZ === null ? (restingValue === null ? missingLabel : "历史读数不足，暂不纳入") : `方向校正后 z ${signed(restingZ)}`,
      missingLabel: restingValue === null ? missingLabel : null,
    },
    {
      key: "lastSleep", label: "昨晚睡眠", weight: 10, zScore: lastSleepZ,
      raw: `${currentSleepHours.toFixed(1)} 小时`,
      baseline: sleepNeed === null ? `历史读数 ${sleepHours.length}/8` : `个人需求 ${sleepNeed.toFixed(1)} 小时`,
      detail: sleepComposite === null ? "睡眠历史不足，暂不纳入" : `时长 ${Math.round(durationPart ?? 0)} / 规律 ${Math.round(regularityPart ?? 0)} / 中断 ${Math.round(interruptionPart ?? 0)}`,
      missingLabel: null,
    },
    {
      key: "sleepBank", label: "7 天睡眠银行", weight: 10, zScore: sleepBankZ,
      raw: sleepDebtHours === null ? "历史不足" : `${sleepDebtHours.toFixed(1)} 小时债务`,
      baseline: sleepNeed === null ? `历史读数 ${sleepHours.length}/8` : `每日需求 ${sleepNeed.toFixed(1)} 小时`,
      detail: sleepDebtHours === null ? "至少需要 8 晚历史及完整近 7 晚" : `近 7 晚按个人需求累计` ,
      missingLabel: null,
    },
    {
      key: "trainingLoad", label: "训练负荷", weight: 15, zScore: trainingZ,
      raw: `${exerciseTotal.toFixed(0)} 分钟 / 7 天`,
      baseline: exerciseStats ? `日均 ${exerciseStats.mean.toFixed(0)} ± ${exerciseStats.sd.toFixed(0)} 分钟` : `历史读数 ${exerciseHistory.length}/8`,
      detail: trainingZ === null ? "历史覆盖不足，暂不纳入" : trainingDetail,
      missingLabel: null,
    },
    {
      key: "respiratoryRate", label: "呼吸频率", weight: 5, zScore: respiratoryZ,
      raw: respiratoryValue === null ? "无记录" : `${respiratoryValue.toFixed(1)} 次/分`,
      baseline: respiratoryStats ? `14 日 ${respiratoryStats.mean.toFixed(1)} ± ${respiratoryStats.sd.toFixed(1)}` : `历史读数 ${respiratoryHistory.length}/8`,
      detail: respiratoryZ === null ? (respiratoryValue === null ? missingLabel : "历史读数不足，暂不纳入") : respiratoryRawZ && respiratoryRawZ > 0 ? `升高 z ${signed(respiratoryRawZ)}，单向扣分` : "未升高，不加分也不扣分",
      missingLabel: respiratoryValue === null ? missingLabel : null,
    },
  ];

  const available = componentInputs.filter((component): component is typeof component & { zScore: number } => component.zScore !== null);
  const availableWeight = available.reduce((sum, component) => sum + component.weight, 0);
  const weightedZ = availableWeight > 0
    ? available.reduce((sum, component) => sum + component.zScore * component.weight, 0) / availableWeight
    : null;
  const objectiveScore = available.length >= 2 && weightedZ !== null ? round(clamp(5 + 2 * weightedZ, 0, 10)) : null;
  const components: Readiness["components"] = componentInputs.map((component) => ({
    ...component,
    score: component.zScore === null ? null : scoreFromZ(component.zScore),
    contribution: component.zScore === null || availableWeight === 0 ? null : round(component.zScore * component.weight / availableWeight, 2),
  }));

  const signalCount = available.length;
  const confidence: Readiness["confidence"] = signalCount >= 5 ? "高" : signalCount === 4 ? "中" : "低";
  const adjustments: string[] = [];
  let score = objectiveScore;
  if (score !== null && hrvZ !== null && restingZ !== null && hrvZ < -0.5 && restingZ < -0.5) {
    score = downgradeOneTier(score);
    adjustments.push("HRV 被压制且静息心率升高：降一档");
  }
  if (score !== null && sleepDebtHours !== null && sleepDebtHours > 3) {
    score = downgradeOneTier(score);
    adjustments.push("7 天睡眠债超过 3 小时：降一档");
  }
  if (score !== null && morningFeeling !== null && morningFeeling < score) {
    score = round(morningFeeling);
    adjustments.push(`主观晨检 ${morningFeeling}/10：仅向保守方向修正`);
  }

  const radarValue = (keys: Readiness["components"][number]["key"][]): number => {
    const values = components.filter((component) => keys.includes(component.key) && component.score !== null).map((component) => component.score ?? 5);
    return values.length ? round(values.reduce((sum, value) => sum + value, 0) / values.length) : 5;
  };
  const radar: Readiness["radar"] = [
    { key: "sleep", label: "睡眠", score: radarValue(["lastSleep", "sleepBank"]) },
    { key: "recovery", label: "恢复", score: radarValue(["hrv", "restingHr"]) },
    { key: "movement", label: "运动", score: radarValue(["trainingLoad"]) },
    { key: "cardio", label: "心肺", score: radarValue(["restingHr", "trainingLoad"]) },
    { key: "vitals", label: "生命体征", score: radarValue(["restingHr", "respiratoryRate"]) },
  ];

  if (score === null) {
    return { date: readinessDate, score, objectiveScore, status: "数据不足", summary: "至少需要两项具备 8 个历史读数的信号。", availableWeight: round(availableWeight), confidence, signalCount, sleepDebtHours: sleepDebtHours === null ? null : round(sleepDebtHours), morningFeeling, adjustments, components, radar };
  }
  const status = tierFor(score);
  const weakest = [...available].sort((a, b) => a.zScore - b.zScore)[0];
  const summary = adjustments[0] ?? (weakest && weakest.zScore < -0.4 ? `${weakest.label}是今天主要的拉分项。` : "可用信号整体接近个人滚动基线。");
  return { date: readinessDate, score, objectiveScore, status, summary, availableWeight: round(availableWeight), confidence, signalCount, sleepDebtHours: sleepDebtHours === null ? null : round(sleepDebtHours), morningFeeling, adjustments, components, radar };
}


// Structural empty defaults only (AUDIT-03 / L0.4): no dates, no measurements,
// no real values. Used when an older stored record is missing a field; a fresh
// database has no snapshot at all and the dashboard shows its empty state
// until the first real HealthKit sync saves one.
const EMPTY_STRENGTH: z.infer<typeof strengthTrainingSchema> = {
  updatedAt: null,
  displayUnit: "lb",
  workouts: [],
  weeklyTrend: [],
  note: "在「训练记录」完成或更新训练后，同步即可查看训练量。",
};

function normalizeStoredSnapshot(value: unknown): Snapshot | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const rawDaily = Array.isArray(record.historyDaily) ? record.historyDaily : [];
  const rawSleeps = Array.isArray(record.historySleeps) ? record.historySleeps : [];
  const candidate = {
    ...record,
    respiratoryRate: record.respiratoryRate ?? { value: null, status: "数据缺失" },
    strengthTraining: record.strengthTraining ?? EMPTY_STRENGTH,
    historyDaily: rawDaily.map((row) => row && typeof row === "object" && !Array.isArray(row) ? { respiratoryRate: null, hrMax: null, ...row } : row),
    historyWorkouts: Array.isArray(record.historyWorkouts) ? record.historyWorkouts : [],
    historySleeps: rawSleeps.map((row) => row && typeof row === "object" && !Array.isArray(row) ? { awakenings: null, efficiency: null, ...row } : row),
  };
  const parsed = snapshotSchema.safeParse(candidate);
  return parsed.success ? normalizeSleepSnapshot(parsed.data) : null;
}

function normalizeStoredStrength(value: unknown): StrengthTraining | null {
  const parsed = strengthTrainingSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

// Honest placeholder merged into a valid health snapshot when the standalone
// strength snapshot is corrupt (H-SOURCE-001): it must never be filled with
// the health snapshot's embedded (stale) strength data, because that would
// present old training numbers as the current strength state.
const CORRUPT_STRENGTH_PLACEHOLDER: StrengthTraining = {
  updatedAt: null,
  displayUnit: "lb",
  workouts: [],
  weeklyTrend: [],
  note: "训练快照已损坏，重新同步后恢复。",
};

// Independent per-source loading (H-SOURCE-001): the health snapshot and
// the standalone strength snapshot are read and validated separately, and
// each outcome is one of ok / missing (no row) / corrupt (unparseable JSON
// or schema mismatch). A failure in one source is recorded on that source
// only — it can never make the other source disappear.
type SourceState = "ok" | "missing" | "corrupt";

interface HealthLoad {
  state: SourceState;
  snapshot: Snapshot | null;
}

interface StrengthLoad {
  state: SourceState;
  strength: StrengthTraining | null;
}

async function loadHealthSnapshot(ctx: Ctx): Promise<HealthLoad> {
  const db = ctx.db<typeof schema>();
  const rows = await db.select({ payload: schema.healthSnapshot.payload }).from(schema.healthSnapshot).where(eq(schema.healthSnapshot.id, 1)).limit(1);
  const row = rows[0];
  if (!row) return { state: "missing", snapshot: null };
  try {
    const snapshot = normalizeStoredSnapshot(JSON.parse(row.payload));
    return snapshot ? { state: "ok", snapshot } : { state: "corrupt", snapshot: null };
  } catch {
    return { state: "corrupt", snapshot: null };
  }
}

async function loadStrengthSnapshot(ctx: Ctx): Promise<StrengthLoad> {
  const db = ctx.db<typeof schema>();
  const rows = await db.select({ payload: schema.strengthTrainingSnapshot.payload }).from(schema.strengthTrainingSnapshot).where(eq(schema.strengthTrainingSnapshot.id, 1)).limit(1);
  const row = rows[0];
  if (!row) return { state: "missing", strength: null };
  try {
    const strength = normalizeStoredStrength(JSON.parse(row.payload));
    return strength ? { state: "ok", strength } : { state: "corrupt", strength: null };
  } catch {
    return { state: "corrupt", strength: null };
  }
}

// The strength data a reader should actually see: the standalone snapshot
// wins when it loads; a missing standalone row falls back to the health
// snapshot's embedded strengthTraining (legacy format compatibility); a
// corrupt standalone row yields null rather than resurrecting stale
// embedded data as if it were current.
function effectiveStrength(health: HealthLoad, strength: StrengthLoad): StrengthTraining | null {
  if (strength.state === "ok") return strength.strength;
  if (strength.state === "missing" && health.state === "ok" && health.snapshot) return health.snapshot.strengthTraining;
  return null;
}

type PersistOutcome = "applied" | "duplicate" | "conflict" | "ignored";

// Atomic conditional write (L1-RACE-001): the version comparison and the
// write are ONE SQLite statement — INSERT … ON CONFLICT(id) DO UPDATE …
// WHERE excluded.source_updated_at > the stored row's source_updated_at.
// The old two-step shape (SELECT the payload, compare updatedAt in JS, then
// unconditionally upsert) raced: two parallel callbacks could both read the
// same old value, and the one that landed last won even when its version was
// older (a 01:00 read overwriting a 02:00 snapshot). Inside a single
// statement the comparison happens at write time, so a late-finishing older
// version is rejected by the statement itself. Only a strictly newer
// version counts as a new write (applied), including the very first insert.
// RETURNING id reports whether the statement actually wrote: no row back
// means the write did not land, and the stored row is then re-read ONLY to
// classify the outcome — that read never decides whether to write. Same
// version with an identical payload is a duplicate callback (duplicate);
// same version with a different payload is a conflict and the first writer
// wins (conflict); a newer stored version means this one was superseded
// (ignored). Duplicate, conflict, and ignored outcomes write no saved
// sync-log entry and do not invalidate queries.
async function persistSnapshot(ctx: Ctx, snapshot: Snapshot): Promise<PersistOutcome> {
  const db = ctx.db<typeof schema>();
  const now = new Date();
  const normalized = normalizeSleepSnapshot(snapshot);
  const sourceUpdatedAt = new Date(normalized.updatedAt);
  const payload = JSON.stringify(normalized);
  const written = await db.insert(schema.healthSnapshot).values({ id: 1, payload, sourceUpdatedAt, createdAt: now, updatedAt: now })
    .onConflictDoUpdate({
      target: schema.healthSnapshot.id,
      set: { payload, sourceUpdatedAt, updatedAt: now },
      setWhere: sql`excluded.source_updated_at > ${schema.healthSnapshot.sourceUpdatedAt}`,
    })
    .returning({ id: schema.healthSnapshot.id });
  if (written.length === 0) {
    const existingRows = await db.select({ payload: schema.healthSnapshot.payload, sourceUpdatedAt: schema.healthSnapshot.sourceUpdatedAt }).from(schema.healthSnapshot).where(eq(schema.healthSnapshot.id, 1)).limit(1);
    const existing = existingRows[0];
    if (existing && existing.sourceUpdatedAt.getTime() === sourceUpdatedAt.getTime()) {
      return existing.payload === payload ? "duplicate" : "conflict";
    }
    return "ignored";
  }
  await recordSyncLog(ctx, { source: "health", status: "saved", itemCount: normalized.historyDaily.length, note: `健康快照已保存 · 数据日期 ${normalized.dataDate} · ${normalized.historyDaily.length} 天明细`, sourceUpdatedAt });
  ctx.invalidateQueries(["dashboard"]);
  return "applied";
}

async function persistStrengthSnapshot(ctx: Ctx, strength: StrengthTraining): Promise<PersistOutcome> {
  const db = ctx.db<typeof schema>();
  // Null-version contract (L1-RACE-001): a strength snapshot whose updatedAt
  // is null carries no source version, so it is treated as the OLDEST
  // possible version (epoch). Under the same atomic conditional write as the
  // health path it can then only land as the very first row — when no
  // strength snapshot exists yet; as soon as any snapshot with a real
  // source_updated_at is stored, a null version is ignored instead of
  // rolling the panel back (the old code skipped every guard for null and
  // stamped it with the write time, letting it overwrite valid snapshots).
  // The payload keeps updatedAt: null, so freshness display still treats
  // the version as missing. The null/epoch mapping also participates in
  // same-version classification: a repeated null-version callback whose
  // payload matches the stored epoch row is a duplicate, not a rewrite.
  const now = new Date();
  const sourceUpdatedAt = strength.updatedAt ? new Date(strength.updatedAt) : new Date(0);
  const payload = JSON.stringify(strength);
  const written = await db.insert(schema.strengthTrainingSnapshot).values({ id: 1, payload, sourceUpdatedAt, createdAt: now, updatedAt: now })
    .onConflictDoUpdate({
      target: schema.strengthTrainingSnapshot.id,
      set: { payload, sourceUpdatedAt, updatedAt: now },
      setWhere: sql`excluded.source_updated_at > ${schema.strengthTrainingSnapshot.sourceUpdatedAt}`,
    })
    .returning({ id: schema.strengthTrainingSnapshot.id });
  if (written.length === 0) {
    const existingRows = await db.select({ payload: schema.strengthTrainingSnapshot.payload, sourceUpdatedAt: schema.strengthTrainingSnapshot.sourceUpdatedAt }).from(schema.strengthTrainingSnapshot).where(eq(schema.strengthTrainingSnapshot.id, 1)).limit(1);
    const existing = existingRows[0];
    if (existing && existing.sourceUpdatedAt.getTime() === sourceUpdatedAt.getTime()) {
      return existing.payload === payload ? "duplicate" : "conflict";
    }
    return "ignored";
  }
  await recordSyncLog(ctx, { source: "strength", status: "saved", itemCount: strength.workouts.length, note: `力量快照已保存 · ${strength.workouts.length} 次训练`, sourceUpdatedAt: strength.updatedAt ? sourceUpdatedAt : null });
  ctx.invalidateQueries(["dashboard"]);
  return "applied";
}

const syncLogEntrySchema = z.object({
  id: z.number().int(),
  source: z.enum(["health", "strength", "system"]),
  status: z.enum(["saved", "failed", "diagnosed"]),
  itemCount: z.number().int().nonnegative(),
  note: z.string(),
  sourceUpdatedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
});

const sourceFreshnessSchema = z.object({
  source: z.enum(["health", "strength"]),
  label: z.string(),
  updatedAt: z.string().datetime().nullable(),
  dataDate: z.string().nullable(),
  ageMinutes: z.number().nullable(),
  freshness: z.enum(["fresh", "today", "stale", "missing"]),
  detail: z.string(),
});

const dataStatusSchema = z.object({
  generatedAt: z.string().datetime(),
  health: sourceFreshnessSchema,
  strength: sourceFreshnessSchema,
  overall: z.enum(["ok", "stale", "partial", "empty"]),
  overallLabel: z.string(),
  recentLogs: z.array(syncLogEntrySchema).max(8),
});

// One HealthKit workout type's sessions on a unified-timeline day
// (H-WORKOUTS-001 item 2): grouped from historyWorkouts by raw type string.
// durationMinutes is the sum of that group's known session durations, or
// null when every session in the group has an unknown duration — null must
// never be replaced with 0, which would pose as a known zero-length total.
const hkWorkoutGroupSchema = z.object({
  type: z.string(),
  sessions: z.number().int().min(1),
  durationMinutes: z.number().nonnegative().nullable(),
});

const unifiedDaySchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  steps: z.number().nonnegative().nullable(),
  sleepHours: z.number().nonnegative().nullable(),
  restingHr: z.number().positive().nullable(),
  hrvMs: z.number().nonnegative().nullable(),
  strengthSessions: z.number().int().nonnegative(),
  strengthVolume: z.number().nonnegative(),
  strengthRoutines: z.array(z.string()),
  // HealthKit workout sessions for the day (H-WORKOUTS-001 follow-up):
  // without these, the unified timeline showed steps/sleep/strength only
  // and a swim day read as "no workout", which is why swimming records
  // looked missing even though they were stored in historyWorkouts.
  workoutSessions: z.number().int().nonnegative(),
  workoutTypes: z.array(z.string()),
  swimMeters: z.number().nonnegative().nullable(),
  // Per-type HealthKit workout groups for the day (H-WORKOUTS-001 item 2),
  // sorted ascending by raw type string. Additive: always present in
  // buildUnifiedTimeline output, defaulting to [] for days without HK
  // sessions. These stay separate from the strength snapshot — an HK
  // session never counts toward strengthSessions/strengthVolume, even
  // when its type mentions strength.
  hkWorkouts: z.array(hkWorkoutGroupSchema),
  hasHealth: z.boolean(),
  hasStrength: z.boolean(),
});

// One day of the readiness near-7-day trend (H-LOAD-001 archive): the
// score is read ONLY from the readiness_history archive — the score that
// was computed and shown on that date. A null score means no archive row
// exists for the date (or that day's readiness was 数据不足): a gap,
// rendered "—", never filled with today's or any other day's score.
const readinessHistoryPointSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  score: z.number().min(0).max(10).nullable(),
});

const getDashboardResponse = z.object({
  forbidden: z.boolean(),
  snapshot: snapshotSchema.nullable(),
  readiness: readinessSchema.nullable(),
  // The 7 archive-backed trend points ending at the readiness date,
  // ascending. Empty when there is no usable health snapshot.
  readinessHistory: z.array(readinessHistoryPointSchema).max(7),
  strengthSyncTaskId: z.string().nullable(),
  dataStatus: dataStatusSchema.nullable(),
  unifiedTimeline: z.array(unifiedDaySchema).max(14),
  // Per-source load states (H-SOURCE-001): each source reports its own
  // outcome so one missing/corrupt source never hides the other. `strength`
  // is the standalone strength snapshot when it parses; when the standalone
  // row is absent but the health snapshot embeds strength data, that
  // embedded copy is returned; otherwise null.
  healthState: z.enum(["ok", "missing", "corrupt"]),
  strengthState: z.enum(["ok", "missing", "corrupt"]),
  strength: strengthTrainingSchema.nullable(),
});

const diagnosticsResponse = z.object({
  forbidden: z.boolean(),
  generatedAt: z.string().datetime(),
  verdict: z.string(),
  checks: z.array(z.object({
    key: z.string(),
    label: z.string(),
    ok: z.boolean(),
    detail: z.string(),
  })),
  dataStatus: dataStatusSchema.nullable(),
  unifiedTimeline: z.array(unifiedDaySchema).max(14),
});
const mutationResponse = z.object({ ok: z.boolean(), forbidden: z.boolean() });
// Save-callback responses (L1-RACE-001): ok/forbidden keep their existing
// meaning; outcome tells the callback whether its snapshot actually landed
// ("applied"), was a same-version repeat of the stored payload
// ("duplicate"), lost a same-version race to a different payload that
// landed first ("conflict"), was rejected by the atomic version guard
// because a newer snapshot is already stored ("ignored"), or was refused
// by the gate ("forbidden"). ok stays true for "duplicate", "conflict",
// and "ignored" — the callback itself succeeded; only the write was
// superseded or already present.
const saveSnapshotResponse = z.object({ ok: z.boolean(), forbidden: z.boolean(), outcome: z.enum(["applied", "duplicate", "conflict", "ignored", "forbidden"]) });
const refreshResponse = z.object({ forbidden: z.boolean(), accepted: z.boolean(), taskId: z.string().nullable(), strengthTaskId: z.string().nullable(), message: z.string() });
const refreshStatusResponse = z.object({ forbidden: z.boolean(), status: z.enum(["queued", "running", "completed", "failed", "not_found", "unknown"]), contractSatisfied: z.boolean() });

// ---------------------------------------------------------------------------
// LIFE-C1 人生游戏 (CWEB-MVP-001·S1 + S2): XP settlement over the health
// summary, plus the Diablo-style character system (attributes, gold,
// equipment, daily tasks). (Owner decision 2026-10-19: the Life version
// is pure character growth — no dungeon/expedition component.)
//
// The game layer reads ONLY the already-loaded health/strength snapshots
// (the same data getDashboard returns) and writes ONLY the game tables.
// It stores settlement metadata — category, LA local date, detail, XP,
// gold, rule version, source date + source updatedAt reference — never
// health raw values. (local_date, category, detail) is the ledger
// primary key — the settlement identity (source date + category); the
// source version (sourceUpdatedAt) and the rule version are separate
// axes, never part of that identity.
//
// Completeness gate (CWEB-SETTLE-001): while the health snapshot's
// coverage is incomplete, health-sourced categories (steps, quest_steps,
// sleep) are preview-only and never book — a partial snapshot that
// booked early would otherwise freeze at its partial values forever.
// Strength is judged by its own snapshot (a completed session is a
// discrete event) and still settles, through the revision path below.
//
// Revision settlement (CWEB-SETTLE-001): a booked row may be corrected
// by a newer snapshot of the SAME rule version — when the candidate's
// sourceUpdatedAt is strictly newer than the stored row's and the value
// differs, the row is updated in place (xp, gold, source reference in
// one atomic UPDATE) and the ledger SUM total moves by the delta
// automatically. A candidate from the same or an OLDER source version
// changes nothing (source versions are monotonic — see planLedgerAction);
// a row booked
// under a different rule version is never recomputed or re-awarded;
// rows are never deleted and unlocked content is never revoked (the
// level simply presents from the new total). When the recomputed value
// already equals the stored xp/gold, only the source reference is
// refreshed. Anything not yet settleable is returned as a preview —
// visible, but not booked. Missing source data yields no XP and an
// explicit gap entry.
//
// S2 (rule version 2): four attributes （力量/耐力/精神/体力） each grant
// +2% XP per point to their domain (strength/steps/sleep/quest_steps),
// attribute portion capped at +50% per domain; equipment effects stack
// on top. Bonuses apply only to settlements booked AFTER the allocation
// or equip — v1 rows keep rule_version 1 and are never recomputed. Gold:
// the first S2 read initializes the balance to the then-cumulative XP
// (one-time conversion); every XP settlement after that mints gold 1:1
// with the XP actually awarded (equipment gold% multiplies the mint).
// Daily tasks book flat XP+gold under category daily_task (detail = task
// id, at most once per task per day) the moment the health summary shows
// the target met.
//
// Profile atomicity (CWEB-PROFILE-SAFE-001): the profile is NEVER written
// back unconditionally. Every write is a compare-and-swap on the
// game_state.revision the writer read (the revision advances inside the
// write statement itself); when the CAS misses, the writer re-reads the
// latest persisted profile, re-applies ONLY its own change on top of it,
// and retries — so a settlement pass that read the profile before a
// concurrent purchase can no longer erase that purchase (or an attribute
// allocation / equip) when it saves. Mutations validate against the
// freshly read profile inside the retry loop: insufficient gold or an
// already-owned item is a typed rejection with ZERO writes, and the
// balance deduction + ownership land in the same single CAS write.
//
// Settlement atomicity (CWEB-SETTLE-001): the gold balance is derived,
// never incremented blind. game_state.gold_ledger_sum is the watermark —
// the ledger gold SUM the stored balance already accounts for — and it
// is persisted in the SAME CAS statement as the balance. A settlement
// books/revises ledger rows first, then sets balance = stored balance +
// (ledger gold SUM − watermark) and watermark = ledger gold SUM. If the
// profile save fails after rows were booked, the watermark stays behind,
// so the next open credits exactly the stranded delta — no leak, no
// double mint; if the save lands, the delta is zero on re-open. Source
// versions are MONOTONIC: a candidate whose sourceUpdatedAt is not
// strictly newer than the stored row's never touches the row (xp, gold
// and the source reference never roll back to an older source), and the
// row UPDATEs carry the same guard in their WHERE clause so the decision
// holds at write time, not just at read time.
// Limitation: for profiles written before the watermark existed, the
// first settlement adopts as its baseline the gold of rows booked at or
// before an IMMUTABLE adoption boundary (game_state.gold_adoption_boundary,
// backfilled by migration 0012 from the profile's last successful save
// at migration time and never written by any profile save afterwards),
// so rows a failed save stranded after that save are still recovered,
// while gold from before the boundary is indistinguishable from gold
// already spent and is adopted as accounted rather than re-minted.
// Ordinary profile writes (purchase / allocation / equip / unequip)
// advance updated_at but cannot move the boundary — an earlier shape of
// this adoption read updated_at directly, which let a purchase that
// landed between a failed settlement save and its retry absorb the
// stranded row into the baseline and lose the reward permanently.
// ---------------------------------------------------------------------------
const GAME_RULE_VERSION = 2;
const GAME_XP_PER_LEVEL = 100;
const GAME_QUEST_TARGET_STEPS = 8000;
const GAME_QUEST_REWARD_XP = 10;
const GAME_STRENGTH_SESSION_XP = 10;
const GAME_POINTS_PER_LEVEL = 3;
const GAME_ATTR_XP_PCT_PER_POINT = 2;
const GAME_ATTR_DOMAIN_CAP_PCT = 50;

const gameCategorySchema = z.enum(["steps", "sleep", "strength", "quest_steps", "daily_task", "reward_redeem"]);
type GameCategory = z.infer<typeof gameCategorySchema>;
// The four settlement domains that attributes/equipment can boost.
type GameDomain = "steps" | "sleep" | "strength" | "quest_steps";

const gameAttributeSchema = z.enum(["strength", "endurance", "spirit", "stamina"]);
type GameAttribute = z.infer<typeof gameAttributeSchema>;
const GAME_ATTRIBUTES: GameAttribute[] = ["strength", "endurance", "spirit", "stamina"];
const GAME_ATTRIBUTE_LABELS: Record<GameAttribute, string> = { strength: "力量", endurance: "耐力", spirit: "精神", stamina: "体力" };
const GAME_ATTRIBUTE_DOMAIN: Record<GameAttribute, GameDomain> = { strength: "strength", endurance: "steps", spirit: "sleep", stamina: "quest_steps" };

type GameSlot = "weapon" | "armor" | "accessory";
const GAME_SLOT_LABELS: Record<GameSlot, string> = { weapon: "武器", armor: "护甲", accessory: "饰品" };

interface EquipmentDef {
  id: string;
  name: string;
  slot: GameSlot;
  domain: GameDomain | "gold";
  pct: number;
  price: number | null;
  obtain: "shop" | "task";
}
// Fixed v1 catalog: 8 items, no gacha, no random affixes, no real payment.
// dawn_charm is task-granted only (first completion of the sleep daily
// task); everything else is bought with gold.
const GAME_EQUIPMENT: EquipmentDef[] = [
  { id: "iron_sword", name: "铁剑", slot: "weapon", domain: "strength", pct: 10, price: 300, obtain: "shop" },
  { id: "swift_blade", name: "疾风短刃", slot: "weapon", domain: "steps", pct: 15, price: 600, obtain: "shop" },
  { id: "oak_staff", name: "橡木法杖", slot: "weapon", domain: "sleep", pct: 10, price: 300, obtain: "shop" },
  { id: "leather_armor", name: "皮甲", slot: "armor", domain: "gold", pct: 10, price: 250, obtain: "shop" },
  { id: "plate_armor", name: "精钢板甲", slot: "armor", domain: "strength", pct: 15, price: 650, obtain: "shop" },
  { id: "night_cloak", name: "夜行斗篷", slot: "armor", domain: "sleep", pct: 15, price: 650, obtain: "shop" },
  { id: "stride_charm", name: "疾行护符", slot: "accessory", domain: "steps", pct: 10, price: 280, obtain: "shop" },
  { id: "dawn_charm", name: "晨光护符", slot: "accessory", domain: "quest_steps", pct: 20, price: null, obtain: "task" },
];
const GAME_EQUIPMENT_BY_ID = new Map(GAME_EQUIPMENT.map((item) => [item.id, item]));

interface DailyTaskDef { id: string; label: string; targetLabel: string; target: number; rewardXp: number; rewardGold: number }
const GAME_DAILY_TASKS: DailyTaskDef[] = [
  { id: "steps_10000", label: "步行 10,000 步", targetLabel: "今日步数达 10,000", target: 10000, rewardXp: 15, rewardGold: 40 },
  { id: "strength_1", label: "完成 1 次力量训练", targetLabel: "今日完成力量训练 1 次", target: 1, rewardXp: 15, rewardGold: 40 },
  { id: "sleep_7h30", label: "主睡眠 ≥ 7.5 小时", targetLabel: "今晨主睡眠满 7.5 小时", target: 7.5, rewardXp: 15, rewardGold: 40 },
];

interface GameProfile {
  gold: number;
  goldInitialized: boolean;
  // Ledger gold SUM the stored balance already accounts for (the
  // reconciliation watermark); null until the first settlement under the
  // watermark scheme persists one.
  goldLedgerSum: number | null;
  attributes: Record<GameAttribute, number>;
  attrPointsEarned: number;
  owned: string[];
  equipped: Record<GameSlot, string | null>;
}

function defaultGameProfile(): GameProfile {
  return {
    gold: 0,
    goldInitialized: false,
    goldLedgerSum: null,
    attributes: { strength: 0, endurance: 0, spirit: 0, stamina: 0 },
    attrPointsEarned: 0,
    owned: [],
    equipped: { weapon: null, armor: null, accessory: null },
  };
}

function parseGameProfile(row: { gold: number; goldInitialized: number; goldLedgerSum?: number | null; attrsJson: string | null; attrPointsEarned: number; equipmentJson: string | null } | undefined): GameProfile {
  const profile = defaultGameProfile();
  if (!row) return profile;
  profile.gold = row.gold;
  profile.goldInitialized = row.goldInitialized === 1;
  profile.goldLedgerSum = typeof row.goldLedgerSum === "number" ? row.goldLedgerSum : null;
  profile.attrPointsEarned = row.attrPointsEarned;
  try {
    if (row.attrsJson) {
      const parsed = JSON.parse(row.attrsJson) as Partial<Record<GameAttribute, unknown>>;
      for (const attr of GAME_ATTRIBUTES) {
        const value = parsed[attr];
        if (typeof value === "number" && Number.isInteger(value) && value >= 0) profile.attributes[attr] = value;
      }
    }
  } catch { /* corrupt JSON keeps the zero defaults */ }
  try {
    if (row.equipmentJson) {
      const parsed = JSON.parse(row.equipmentJson) as { owned?: unknown; equipped?: Partial<Record<GameSlot, unknown>> };
      if (Array.isArray(parsed.owned)) {
        profile.owned = parsed.owned.filter((id): id is string => typeof id === "string" && GAME_EQUIPMENT_BY_ID.has(id));
      }
      for (const slot of ["weapon", "armor", "accessory"] as GameSlot[]) {
        const id = parsed.equipped?.[slot];
        const def = typeof id === "string" ? GAME_EQUIPMENT_BY_ID.get(id) : undefined;
        if (def && def.slot === slot && profile.owned.includes(def.id)) profile.equipped[slot] = def.id;
      }
    }
  } catch { /* corrupt JSON keeps empty equipment */ }
  return profile;
}

// One persisted game_state row, decomposed: the profile, the totals the
// settlement maintains alongside it, the write revision (CAS token),
// the row's last successful save instant, and the immutable gold
// baseline-adoption boundary (migration 0012; null when the row never
// needed one — read only by the one-time watermark baseline adoption in
// settleGame, never advanced by profile writes).
interface GameStateRow {
  exists: boolean;
  revision: number;
  updatedAt: Date | null;
  goldAdoptionBoundary: Date | null;
  totalXp: number;
  settledThroughDate: string | null;
  profile: GameProfile;
}

async function loadGameStateRow(ctx: Ctx): Promise<GameStateRow> {
  const db = ctx.db<typeof schema>();
  const rows = await db.select().from(schema.gameState).where(eq(schema.gameState.id, 1)).limit(1);
  const row = rows[0];
  if (!row) return { exists: false, revision: 0, updatedAt: null, goldAdoptionBoundary: null, totalXp: 0, settledThroughDate: null, profile: defaultGameProfile() };
  return {
    exists: true,
    revision: row.revision ?? 0,
    updatedAt: row.updatedAt,
    goldAdoptionBoundary: row.goldAdoptionBoundary ?? null,
    totalXp: row.totalXp,
    settledThroughDate: row.settledThroughDate,
    profile: parseGameProfile(row),
  };
}

// Compare-and-swap profile write (CWEB-PROFILE-SAFE-001): the row is
// updated ONLY when its stored revision still equals the revision the
// caller read (a legacy null revision counts as 0); the revision itself
// advances inside the same statement (COALESCE(revision, 0) + 1), so two
// writers that read the same revision cannot both land — the loser's
// UPDATE matches no row, RETURNING stays empty, and the caller re-reads
// and retries on top of the winner's state instead of overwriting it.
// When no row exists yet, the first write is an INSERT … ON CONFLICT DO
// NOTHING at revision 1 with the same contract (false = someone else
// created the row first; retry as an update). Returns whether THIS write
// landed. totalXp / settledThroughDate are written through unchanged
// from the caller's read — settlement owns them, mutations preserve
// them; the gold balance and the goldLedgerSum watermark always move
// together inside this one statement.
async function saveGameProfile(ctx: Ctx, profile: GameProfile, totalXp: number, settledThroughDate: string | null, expectedRevision: number | null): Promise<boolean> {
  const db = ctx.db<typeof schema>();
  const now = new Date();
  const fields = {
    totalXp,
    settledThroughDate,
    gold: profile.gold,
    goldInitialized: profile.goldInitialized ? 1 : 0,
    goldLedgerSum: profile.goldLedgerSum,
    attrsJson: JSON.stringify(profile.attributes),
    attrPointsEarned: profile.attrPointsEarned,
    equipmentJson: JSON.stringify({ owned: profile.owned, equipped: profile.equipped }),
    updatedAt: now,
  };
  if (expectedRevision === null) {
    const written = await db.insert(schema.gameState).values({ id: 1, ...fields, revision: 1, createdAt: now })
      .onConflictDoNothing()
      .returning({ id: schema.gameState.id });
    return written.length > 0;
  }
  const written = await db.update(schema.gameState)
    .set({ ...fields, revision: sql`COALESCE(${schema.gameState.revision}, 0) + 1` })
    .where(and(eq(schema.gameState.id, 1), sql`COALESCE(${schema.gameState.revision}, 0) = ${expectedRevision}`))
    .returning({ id: schema.gameState.id });
  return written.length > 0;
}

const PROFILE_CAS_ATTEMPTS = 5;

// Serialized profile mutation (CWEB-PROFILE-SAFE-001): read the latest
// persisted profile, let `apply` validate and mutate a draft of it, then
// CAS-write. A CAS miss re-reads and re-applies against the winner's
// state, so concurrent mutations compose exactly like serial ones
// (read×write and write×write orders agree). A typed rejection from
// `apply` (insufficient gold, already owned, nothing to unequip, …)
// returns immediately with ZERO writes performed. Exhausting the retry
// budget under pathological contention returns a busy rejection —
// nothing was written by the losing attempts, so the caller can retry
// the whole action safely.
type ProfileApplyResult = { ok: true } | { ok: false; message: string };

async function updateGameProfile(
  ctx: Ctx,
  apply: (profile: GameProfile) => ProfileApplyResult,
): Promise<{ ok: true; profile: GameProfile } | { ok: false; message: string }> {
  for (let attempt = 0; attempt < PROFILE_CAS_ATTEMPTS; attempt++) {
    const row = await loadGameStateRow(ctx);
    const draft = row.profile;
    const result = apply(draft);
    if (!result.ok) return result;
    if (await saveGameProfile(ctx, draft, row.totalXp, row.settledThroughDate, row.exists ? row.revision : null)) {
      return { ok: true, profile: draft };
    }
  }
  return { ok: false, message: "存档正忙，请稍后重试" };
}

// Pure profile mutations, shared verbatim by the actions (through
// updateGameProfile) and the validation script: each validates against
// the profile it is given and mutates it in place on success only. The
// balance deduction and the ownership change happen together in the
// draft, so the single CAS write that persists the draft is the whole
// purchase — there is no intermediate state to strand.
function applyAllocation(profile: GameProfile, attribute: GameAttribute, count: number): ProfileApplyResult {
  if (count > unspentPoints(profile)) return { ok: false, message: `未分配点数不足：当前剩余 ${unspentPoints(profile)} 点` };
  profile.attributes[attribute] += count;
  return { ok: true };
}

function applyPurchase(profile: GameProfile, def: EquipmentDef): ProfileApplyResult {
  if (profile.owned.includes(def.id)) return { ok: false, message: `已经拥有${def.name}` };
  if (def.price === null || profile.gold < def.price) return { ok: false, message: `金币不足：${def.name} 需要 ${def.price ?? 0} 金币，当前余额 ${profile.gold}` };
  profile.gold -= def.price;
  profile.owned.push(def.id);
  return { ok: true };
}

function applyEquip(profile: GameProfile, def: EquipmentDef): ProfileApplyResult {
  if (!profile.owned.includes(def.id)) return { ok: false, message: `尚未拥有${def.name}` };
  profile.equipped[def.slot] = def.id;
  return { ok: true };
}

function applyUnequip(profile: GameProfile, slot: GameSlot): ProfileApplyResult {
  if (!profile.equipped[slot]) return { ok: false, message: `${GAME_SLOT_LABELS[slot]}槽位本来就是空的` };
  profile.equipped[slot] = null;
  return { ok: true };
}

function allocatedPoints(profile: GameProfile): number {
  return GAME_ATTRIBUTES.reduce((sum, attr) => sum + profile.attributes[attr], 0);
}

function unspentPoints(profile: GameProfile): number {
  return Math.max(0, profile.attrPointsEarned - allocatedPoints(profile));
}

// Attribute portion of a domain's XP bonus: +2% per point in the mapped
// attribute, capped at +50% per domain (rule v2, shown on the page).
function attrBonusPct(profile: GameProfile, domain: GameDomain): number {
  const attr = GAME_ATTRIBUTES.find((candidate) => GAME_ATTRIBUTE_DOMAIN[candidate] === domain);
  if (!attr) return 0;
  return Math.min(GAME_ATTR_DOMAIN_CAP_PCT, GAME_ATTR_XP_PCT_PER_POINT * profile.attributes[attr]);
}

function equippedDefs(profile: GameProfile): EquipmentDef[] {
  return (["weapon", "armor", "accessory"] as GameSlot[])
    .map((slot) => profile.equipped[slot])
    .filter((id): id is string => id !== null)
    .map((id) => GAME_EQUIPMENT_BY_ID.get(id))
    .filter((def): def is EquipmentDef => def !== undefined);
}

function equipBonusPct(profile: GameProfile, domain: GameDomain | "gold"): number {
  return equippedDefs(profile).filter((def) => def.domain === domain).reduce((sum, def) => sum + def.pct, 0);
}

// Final XP for a domain settlement: base XP scaled by attribute +
// equipment percentages (equipment stacks on top of the capped attribute
// portion). The daily_task category is never scaled — its rewards are
// flat by design.
function boostedXp(baseXp: number, category: GameCategory, profile: GameProfile): number {
  if (category !== "steps" && category !== "sleep" && category !== "strength" && category !== "quest_steps") return baseXp;
  const pct = attrBonusPct(profile, category) + equipBonusPct(profile, category);
  return Math.floor(baseXp * (1 + pct / 100));
}

function equipmentEffectLabel(def: EquipmentDef): string {
  const domainLabel = def.domain === "gold" ? "金币" : def.domain === "strength" ? "力量训练经验" : def.domain === "steps" ? "步行经验" : def.domain === "sleep" ? "睡眠经验" : "主任务经验";
  return `${domainLabel} +${def.pct}%`;
}

const gameSettlementEntrySchema = z.object({
  localDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  category: gameCategorySchema,
  detail: z.string(),
  xp: z.number().int().nonnegative(),
  gold: z.number().int().nonnegative(),
  ruleVersion: z.number().int().positive(),
  sourceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  sourceUpdatedAt: z.string().nullable(),
  settledAt: z.string().datetime(),
});

const gamePreviewEntrySchema = z.object({
  localDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  category: gameCategorySchema,
  xp: z.number().int().nonnegative().nullable(),
  state: z.enum(["preview", "missing"]),
  note: z.string().min(1),
});
type GamePreviewEntry = z.infer<typeof gamePreviewEntrySchema>;

const gameQuestSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  targetSteps: z.number().int().positive(),
  steps: z.number().int().nonnegative().nullable(),
  rewardXp: z.number().int().positive(),
  state: z.enum(["in_progress", "achieved", "settled", "missing"]),
});

const gameAttributesSchema = z.object({
  strength: z.number().int().nonnegative(),
  endurance: z.number().int().nonnegative(),
  spirit: z.number().int().nonnegative(),
  stamina: z.number().int().nonnegative(),
});

const gameDomainBonusSchema = z.object({
  domain: z.enum(["steps", "sleep", "strength", "quest_steps"]),
  attrPct: z.number().int().nonnegative(),
  equipPct: z.number().int().nonnegative(),
});

const gameEquipmentItemSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  slot: z.enum(["weapon", "armor", "accessory"]),
  effectLabel: z.string().min(1),
  price: z.number().int().positive().nullable(),
  obtain: z.enum(["shop", "task"]),
  obtainNote: z.string().min(1),
  owned: z.boolean(),
  equipped: z.boolean(),
});

const gameDailyTaskSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  targetLabel: z.string().min(1),
  progress: z.number().nullable(),
  progressLabel: z.string().min(1),
  target: z.number().positive(),
  state: z.enum(["in_progress", "completed", "claimed", "missing"]),
  rewardXp: z.number().int().positive(),
  rewardGold: z.number().int().positive(),
});

const getGameStateResponse = z.object({
  forbidden: z.boolean(),
  ok: z.boolean(),
  healthState: z.enum(["ok", "missing", "corrupt"]),
  ruleVersion: z.number().int().positive(),
  totalXp: z.number().int().nonnegative(),
  level: z.number().int().positive(),
  xpIntoLevel: z.number().int().nonnegative(),
  xpPerLevel: z.number().int().positive(),
  xpToNextLevel: z.number().int().nonnegative(),
  settledThroughDate: z.string().nullable(),
  gold: z.number().int().nonnegative(),
  attributes: gameAttributesSchema,
  unspentPoints: z.number().int().nonnegative(),
  attrPointsEarned: z.number().int().nonnegative(),
  domainBonuses: z.array(gameDomainBonusSchema).length(4),
  goldBonusPct: z.number().int().nonnegative(),
  equipment: z.array(gameEquipmentItemSchema).max(12),
  dailyTasks: z.array(gameDailyTaskSchema).max(3),
  quest: gameQuestSchema,
  settlements: z.array(gameSettlementEntrySchema).max(90),
  previews: z.array(gamePreviewEntrySchema).max(60),
});

const gameMutationResponse = z.object({ ok: z.boolean(), forbidden: z.boolean(), message: z.string() });

interface GameCandidate {
  localDate: string;
  category: GameCategory;
  detail: string;
  xp: number;
  gold: number;
  sourceDate: string;
  sourceUpdatedAt: string | null;
}

// XP rules (base values unchanged from v1; rule_version 2 adds the
// attribute/equipment boost and gold minting on top — see boostedXp):
// steps — 1 XP per full 1000 steps, capped at 20 per day; sleep — main
// sleep of 7h or more earns 10 XP, shorter nights earn proportionally
// (floor); strength — 10 XP per completed session; the daily quest
// (8000 steps) earns a flat 10 XP once the day completes.
function stepsXpFor(steps: number): number {
  return Math.min(20, Math.floor(steps / 1000));
}

function sleepXpFor(hours: number): number {
  if (hours >= 7) return 10;
  return Math.floor((hours / 7) * 10);
}

type SleepHistoryRow = z.infer<typeof sleepHistorySchema>;

// Ordering key for a sleep start clock time within one wake-up date:
// evening starts (12:00–23:59) belong to the night that ends on the wake
// date, so they sort before after-midnight starts of that same night.
function sleepStartOrderKey(start: string): number {
  const match = start.match(/^(\d{2}):(\d{2})$/);
  if (!match) return Number.POSITIVE_INFINITY;
  const minutes = Number(match[1]) * 60 + Number(match[2]);
  return minutes >= 12 * 60 ? minutes : minutes + 24 * 60;
}

// Deterministic main-sleep selection (CWEB-SLEEP-001), the same caliber
// the dashboard uses: among one wake-up date's sleep rows, the main
// sleep is the row with the longest time in bed (computed from its
// start/end clock times); ties go to the earlier start. The result never
// depends on array order, so a nap can never pose as the main sleep.
// Returns null when no row's time in bed can be determined — the caller
// then shows an unconfirmed preview and books nothing for that date.
function selectMainSleep(rows: SleepHistoryRow[]): SleepHistoryRow | null {
  let best: SleepHistoryRow | null = null;
  let bestInBed = -1;
  let bestStartKey = Number.POSITIVE_INFINITY;
  for (const row of rows) {
    const inBed = timeInBedHours(row.start, row.end);
    if (inBed === null) continue;
    const startKey = sleepStartOrderKey(row.start);
    if (inBed > bestInBed || (inBed === bestInBed && startKey < bestStartKey)) {
      best = row;
      bestInBed = inBed;
      bestStartKey = startKey;
    }
  }
  return best;
}

// The stored fields of a ledger row that settlement decisions read.
interface LedgerRowLike {
  xp: number;
  gold: number;
  ruleVersion: number;
  sourceUpdatedAt: string | null;
}

type LedgerAction =
  | { kind: "insert" }
  | { kind: "skip" }
  | { kind: "refresh_source_ref" }
  | { kind: "revise"; goldDelta: number };

// Monotonic source-version ordering (CWEB-SETTLE-001): an unversioned
// source (null) is the OLDEST version — it never supersedes a versioned
// row; two versioned sources order by their parsed instants, and two
// strings that parse to the SAME instant are the SAME version (0) even
// when their formats differ — `2026-10-02T01:00:00.000Z` and
// `2026-10-02T01:00:00Z` are one version, so a same-version candidate
// never re-prices a booked row. Unparseable values fall back to
// lexicographic order, which agrees with chronological order for the
// canonical ISO strings the snapshots carry. Returns a negative number
// when a is older than b, 0 when equal, positive when a is newer.
function compareSourceVersions(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a === null) return -1;
  if (b === null) return 1;
  const timeA = Date.parse(a);
  const timeB = Date.parse(b);
  if (!Number.isNaN(timeA) && !Number.isNaN(timeB)) {
    if (timeA === timeB) return 0;
    return timeA < timeB ? -1 : 1;
  }
  return a < b ? -1 : 1;
}

// The write-time twin of compareSourceVersions for the ledger UPDATE
// guard (CWEB-SETTLE-001): a SQL boolean that is true exactly when the
// stored source version is strictly older than the candidate's under
// the SAME normalized ordering — both sides parsed to instants via
// unixepoch(..., 'subsec') whenever both parse (so an equal instant in
// a different string format is NOT "older" and the guard blocks, just
// as the JS comparison returns 0 and planLedgerAction skips), with the
// same lexicographic fallback when either side is unparseable. A plain
// string `<` here would disagree with the JS side precisely on
// same-instant format variants ("." sorts before "Z"), letting a
// write-time guard pass a candidate the read-time decision had already
// judged the same version.
function sourceVersionSqlBefore(stored: typeof schema.gameSettlements.sourceUpdatedAt, candidate: string) {
  return sql`(CASE WHEN unixepoch(${stored}, 'subsec') IS NOT NULL AND unixepoch(${candidate}, 'subsec') IS NOT NULL THEN unixepoch(${stored}, 'subsec') < unixepoch(${candidate}, 'subsec') ELSE ${stored} < ${candidate} END)`;
}

// Pure settlement decision for one candidate against its stored row
// (CWEB-SETTLE-001 revision rules):
// - no stored row -> insert;
// - stored row under a different rule version -> skip (never recomputed,
//   never re-awarded);
// - candidate source version is the same as OR OLDER than the stored
//   row's -> skip: source versions are monotonic, so an older source
//   never rolls a settled row back (xp, gold and the source reference
//   all stay at the newer settlement), and re-opening with the same
//   source version changes nothing, even if a recomputed value would
//   differ;
// - strictly newer source version but the value already matches ->
//   refresh only the source reference, xp/gold untouched;
// - strictly newer source version and a different value -> revise the
//   row in place; the XP total (the ledger SUM) moves by the xp delta
//   on its own, and the gold balance follows through the watermark
//   reconciliation in settleGame.
function planLedgerAction(existing: LedgerRowLike | undefined, candidate: GameCandidate): LedgerAction {
  if (!existing) return { kind: "insert" };
  if (existing.ruleVersion !== GAME_RULE_VERSION) return { kind: "skip" };
  if (compareSourceVersions(candidate.sourceUpdatedAt, existing.sourceUpdatedAt) <= 0) return { kind: "skip" };
  if (existing.xp === candidate.xp && existing.gold === candidate.gold) return { kind: "refresh_source_ref" };
  return { kind: "revise", goldDelta: candidate.gold - existing.gold };
}

// Build the settlement plan from the loaded snapshots: candidates are
// days inside the complete window (ready to book); previews are days the
// sources can already see but that are not complete yet, plus explicit
// gaps where a complete day has no source data (no XP, stated honestly).
// Candidate XP already carries the current attribute+equipment boost and
// the gold the settlement will mint (1:1 with awarded XP, scaled by the
// equipped gold bonus). A booked row keeps those frozen values unless
// the source snapshot itself is revised — only then does the revision
// path in settleGame recompute it from the new candidate.
function buildGamePlan(health: Snapshot | null, strength: StrengthTraining | null, todayLA: string, profile: GameProfile): { candidates: GameCandidate[]; previews: GamePreviewEntry[] } {
  const candidates: GameCandidate[] = [];
  const previews: GamePreviewEntry[] = [];
  const goldPct = equipBonusPct(profile, "gold");
  const domainCandidate = (localDate: string, category: GameDomain, baseXp: number, sourceDate: string, sourceUpdatedAt: string | null): GameCandidate => {
    const xp = boostedXp(baseXp, category, profile);
    return { localDate, category, detail: "", xp, gold: Math.floor(xp * (1 + goldPct / 100)), sourceDate, sourceUpdatedAt };
  };
  if (health) {
    const dataDate = health.dataDate;
    const readinessDate = health.morningReference?.date ?? shiftDate(dataDate, 1);
    // Completeness gate (CWEB-SETTLE-001): with coverage incomplete, the
    // completeness of any single day is unproven — a date on or before
    // dataDate may still be a partial read — so health-sourced
    // categories stay preview-only until a snapshot reports complete
    // coverage; source revisions after that correct booked rows through
    // the revision path instead of leaving partial values frozen.
    const incomplete = health.coverageIncomplete;
    const sleepDates = new Set(health.historySleeps.map((row) => row.date));
    for (const row of health.historyDaily) {
      if (row.date <= dataDate) {
        if (row.steps === null) {
          previews.push({ localDate: row.date, category: "steps", xp: null, state: "missing", note: "当日步数缺失，未发放经验" });
        } else if (incomplete) {
          previews.push({ localDate: row.date, category: "steps", xp: boostedXp(stepsXpFor(row.steps), "steps", profile), state: "preview", note: "数据尚未完整，暂为预览，完整后自动结算" });
          if (row.steps >= GAME_QUEST_TARGET_STEPS) {
            previews.push({ localDate: row.date, category: "quest_steps", xp: boostedXp(GAME_QUEST_REWARD_XP, "quest_steps", profile), state: "preview", note: "数据尚未完整，暂为预览；该日已达标，奖励将在数据完整后入账" });
          }
        } else {
          candidates.push(domainCandidate(row.date, "steps", stepsXpFor(row.steps), row.date, health.updatedAt));
          if (row.steps >= GAME_QUEST_TARGET_STEPS) {
            candidates.push(domainCandidate(row.date, "quest_steps", GAME_QUEST_REWARD_XP, row.date, health.updatedAt));
          }
        }
        // A completed day inside the recent week with no main-sleep row
        // is a stated gap, not a silent zero.
        if (row.date > shiftDate(dataDate, -7) && !sleepDates.has(row.date)) {
          previews.push({ localDate: row.date, category: "sleep", xp: null, state: "missing", note: "当日无主睡眠记录，未发放经验" });
        }
      } else if (row.date === todayLA && row.steps !== null) {
        previews.push({ localDate: row.date, category: "steps", xp: boostedXp(stepsXpFor(row.steps), "steps", profile), state: "preview", note: incomplete ? "数据尚未完整，暂为预览，完整后自动结算" : "今日数据尚未完整，暂为预览，完整后自动结算" });
        if (row.steps >= GAME_QUEST_TARGET_STEPS) {
          previews.push({ localDate: row.date, category: "quest_steps", xp: boostedXp(GAME_QUEST_REWARD_XP, "quest_steps", profile), state: "preview", note: incomplete ? "数据尚未完整，暂为预览；今日已达标，奖励将在数据完整后入账" : "今日已达标，奖励将在该日数据完整后入账" });
        }
      }
    }
    // Sleep settles per wake-up date from the deterministically chosen
    // main sleep only (CWEB-SLEEP-001): rows are grouped by date first,
    // so a nap sharing the date can never overwrite or impersonate the
    // main sleep, whatever order the source listed them in.
    const sleepsByDate = new Map<string, SleepHistoryRow[]>();
    for (const row of health.historySleeps) {
      // Main sleep belongs to its wake-up date; future or not-yet-due
      // rows never settle.
      if (row.date > readinessDate || row.date > todayLA) continue;
      const rows = sleepsByDate.get(row.date);
      if (rows) rows.push(row);
      else sleepsByDate.set(row.date, [row]);
    }
    for (const [date, rows] of sleepsByDate) {
      const main = selectMainSleep(rows);
      if (!main) {
        previews.push({ localDate: date, category: "sleep", xp: null, state: "preview", note: "当日主睡眠无法确认，暂为预览，未入账" });
        continue;
      }
      const baseXp = sleepXpFor(totalSleepHours(main, main.totalHours));
      if (incomplete) {
        previews.push({ localDate: date, category: "sleep", xp: boostedXp(baseXp, "sleep", profile), state: "preview", note: "数据尚未完整，暂为预览，同步完整后结算" });
      } else {
        candidates.push(domainCandidate(date, "sleep", baseXp, date, health.updatedAt));
      }
    }
  }
  if (strength) {
    const sessionsByDate = new Map<string, number>();
    for (const workout of strength.workouts) {
      if (workout.status !== "completed") continue;
      sessionsByDate.set(workout.date, (sessionsByDate.get(workout.date) ?? 0) + 1);
    }
    // Strength is judged by its own snapshot (CWEB-SETTLE-001): a
    // completed session is a discrete event, so it settles without
    // waiting for the health complete window; a later snapshot showing
    // more (or fewer) sessions that day corrects the booked row through
    // the same revision path.
    for (const [date, count] of sessionsByDate) {
      candidates.push(domainCandidate(date, "strength", GAME_STRENGTH_SESSION_XP * count, date, strength.updatedAt));
    }
  }
  previews.sort((a, b) => b.localDate.localeCompare(a.localDate) || a.category.localeCompare(b.category));
  return { candidates, previews: previews.slice(0, 60) };
}

// Book one daily_task ledger row atomically: a single INSERT … ON
// CONFLICT DO NOTHING against the (date, category, detail) primary key,
// so two concurrent settlements can never book the same task twice —
// exactly one insert lands and the other is a no-op (CWEB-SETTLE-001
// atomicity, same caliber as the domain path). Whether the task counts
// as claimed is always read back from the ledger afterwards, never from
// an in-memory claim set that a concurrent writer could have changed.
// A met daily target cannot un-happen and its reward is flat, so these
// rows never revise. Domain candidates go through settleLedgerRow below.
async function bookLedgerRow(ctx: Ctx, candidate: GameCandidate): Promise<void> {
  const db = ctx.db<typeof schema>();
  await db.insert(schema.gameSettlements).values({
    localDate: candidate.localDate,
    category: candidate.category,
    detail: candidate.detail,
    xp: candidate.xp,
    gold: candidate.gold,
    ruleVersion: GAME_RULE_VERSION,
    sourceDate: candidate.sourceDate,
    sourceUpdatedAt: candidate.sourceUpdatedAt,
    createdAt: new Date(),
  }).onConflictDoNothing();
}

// Settle one domain candidate against the ledger, applying the
// planLedgerAction decision (CWEB-SETTLE-001): insert when unbooked;
// on a same-rule-version, strictly-newer source revision, update the
// stored row in place — xp, gold and the source reference in a single
// UPDATE, so the row is never half-revised — or refresh only the source
// reference when the value already matches. The insert NEVER assumes
// success: ON CONFLICT DO NOTHING reports through RETURNING whether
// this write actually landed, and when a concurrent settlement booked
// the same key first (both read the key as missing), the losing
// candidate re-reads the winning row and re-plans against it — a newer
// source still refreshes/revises the winner through the guarded UPDATE
// below, an older or same-version one skips — instead of being silently
// dropped and leaving the ledger at the older source until some later
// open. The UPDATEs repeat the monotonic guard in their WHERE clause
// (stored source version is null or strictly older than the
// candidate's, under the current rule version, compared with the same
// normalized instant ordering as compareSourceVersions — see
// sourceVersionSqlBefore), so the decision planLedgerAction made at
// read time is re enforced at write time: a row settled from a newer
// source in between is never rolled back by this older candidate. Gold
// is NOT adjusted here — the balance follows the ledger gold SUM
// through the watermark reconciliation in settleGame, which is what
// makes a stranded booking recoverable.
async function settleLedgerRow(ctx: Ctx, candidate: GameCandidate): Promise<void> {
  const db = ctx.db<typeof schema>();
  const key = and(eq(schema.gameSettlements.localDate, candidate.localDate), eq(schema.gameSettlements.category, candidate.category), eq(schema.gameSettlements.detail, candidate.detail));
  const existingRows = await db.select().from(schema.gameSettlements).where(key).limit(1);
  let action = planLedgerAction(existingRows[0], candidate);
  if (action.kind === "skip") return;
  if (action.kind === "insert") {
    const written = await db.insert(schema.gameSettlements).values({
      localDate: candidate.localDate,
      category: candidate.category,
      detail: candidate.detail,
      xp: candidate.xp,
      gold: candidate.gold,
      ruleVersion: GAME_RULE_VERSION,
      sourceDate: candidate.sourceDate,
      sourceUpdatedAt: candidate.sourceUpdatedAt,
      createdAt: new Date(),
    }).onConflictDoNothing()
      .returning({ localDate: schema.gameSettlements.localDate });
    if (written.length > 0) return;
    // The insert landed nothing: a concurrent settlement won this key
    // between our read and our insert. Re-read the winning row and
    // decide again under the same monotonic rules; only a refresh or a
    // revise falls through to the guarded update below.
    const winnerRows = await db.select().from(schema.gameSettlements).where(key).limit(1);
    action = planLedgerAction(winnerRows[0], candidate);
    if (action.kind !== "refresh_source_ref" && action.kind !== "revise") return;
  }
  // Write-time monotonic guard: only a row still booked under the
  // current rule version from an older (or unversioned) source may be
  // refreshed/revised by this candidate. The candidate version is
  // non-null here: planLedgerAction only refreshes/revises for a
  // strictly newer candidate version, and null is the oldest version.
  const candidateVersion = candidate.sourceUpdatedAt;
  if (candidateVersion === null) return;
  const guard = and(key, eq(schema.gameSettlements.ruleVersion, GAME_RULE_VERSION),
    sql`(${schema.gameSettlements.sourceUpdatedAt} IS NULL OR ${sourceVersionSqlBefore(schema.gameSettlements.sourceUpdatedAt, candidateVersion)})`);
  if (action.kind === "refresh_source_ref") {
    await db.update(schema.gameSettlements)
      .set({ sourceDate: candidate.sourceDate, sourceUpdatedAt: candidate.sourceUpdatedAt })
      .where(guard);
    return;
  }
  await db.update(schema.gameSettlements)
    .set({ xp: candidate.xp, gold: candidate.gold, sourceDate: candidate.sourceDate, sourceUpdatedAt: candidate.sourceUpdatedAt })
    .where(guard);
}

// Today's three daily tasks, evaluated against the same health summary
// the base settlement uses: steps from today's historyDaily row (the
// stored pipeline usually carries completed days only, so progress is
// honestly "missing" until the day syncs), completed strength sessions
// dated today, and the main sleep attributed to this morning. A task
// whose target is met books immediately under category daily_task —
// unlike base categories it does not wait for the complete window,
// because a met target (10k steps, a finished session, a 7.5h night)
// cannot un-happen; the ledger PK still caps it at once per task per day.
function evaluateDailyTasks(health: Snapshot | null, strength: StrengthTraining | null, todayLA: string): { def: DailyTaskDef; progress: number | null; progressLabel: string }[] {
  const todaySteps = health?.historyDaily.find((row) => row.date === todayLA)?.steps ?? null;
  const todaySessions = strength ? strength.workouts.filter((workout) => workout.status === "completed" && workout.date === todayLA).length : 0;
  const strengthKnown = strength !== null;
  const todaySleep = health ? selectMainSleep(health.historySleeps.filter((row) => row.date === todayLA)) : null;
  const sleepHours = todaySleep ? totalSleepHours(todaySleep, todaySleep.totalHours) : null;
  return GAME_DAILY_TASKS.map((def) => {
    if (def.id === "steps_10000") {
      return { def, progress: todaySteps, progressLabel: todaySteps === null ? "今日步数尚未同步" : `今日已走 ${todaySteps.toLocaleString("zh-CN")} / 10,000 步` };
    }
    if (def.id === "strength_1") {
      return { def, progress: strengthKnown ? todaySessions : null, progressLabel: !strengthKnown ? "训练记录尚未同步" : `今日已完成 ${todaySessions} / 1 次` };
    }
    return { def, progress: sleepHours, progressLabel: sleepHours === null ? "今晨主睡眠尚未同步" : `今晨主睡眠 ${sleepHours.toFixed(1)} / 7.5 小时` };
  });
}

// Redeem-bound settlement (CWEB-REDEEM-SAFE-001, pre-settlement
// baseline remainder): settleGame's CAS retry above is the right
// behaviour for a plain read — a concurrent purchase is absorbed
// and gold is still credited exactly once — but a redemption must
// never let ITS OWN settlement endorse an external balance/version
// advancement that landed after the owner's confirmation. A
// guarded settle therefore carries the confirmed pin as the head
// of a provable advancement chain: the first read of every attempt
// must equal the chain head exactly (revision + balance +
// watermark), and the chain advances ONLY through this settle's
// own successful CAS save (to exactly the state that save
// committed). A CAS miss whose retry re-read shows any other state
// — an external purchase, allocation, equip, or settlement that
// landed before the first read, after the read but before the CAS,
// or in the CAS-failure re-read — aborts the settle with this
// typed error instead of retrying on top of the winner; the
// redemption handler arbitrates the abort against the durable
// receipt table and answers stale (or the winner's receipt), with
// zero redemption writes. Unguarded callers (getGameState,
// getRewards) pass no pin and keep the absorbing retry unchanged —
// the global settle is NOT turned into a gate.
const SETTLE_PIN_MOVED_MESSAGE = "settlement aborted: the profile moved off the pinned confirmation state";

function settlementPinMovedError(): Error {
  const error = new Error(SETTLE_PIN_MOVED_MESSAGE);
  error.name = "SettlementPinMovedError";
  return error;
}

function isSettlementPinMovedError(error: unknown): boolean {
  return error instanceof Error && error.name === "SettlementPinMovedError";
}

// Settle every candidate and today's daily tasks, then persist the
// profile. The ledger table is the source of truth for total XP
// (summed, never incremented by hand); game_state carries the gold
// balance and the S2 character state. Re-running with the same source
// versions changes nothing; a newer source version corrects
// already-booked rows in place (revision settlement — see
// planLedgerAction), so totals always reflect the latest source, never
// a frozen first read.
//
// Atomicity (CWEB-PROFILE-SAFE-001 + CWEB-SETTLE-001): the whole pass
// runs inside the profile CAS retry loop. Each attempt re-reads the
// persisted profile, rebuilds the plan from THAT profile (boosts follow
// the latest attributes/equipment), books/revises ledger rows, derives
// the gold balance from the ledger gold SUM against the persisted
// watermark (profile.goldLedgerSum — see the schema note), and
// CAS-writes balance + watermark + character state in one statement. A
// CAS miss means a concurrent mutation or settlement landed first; the
// attempt's ledger writes are idempotent (same keys, monotonic source
// versions), so retrying on top of the winner's profile converges to
// the serial result — a purchase is never erased and gold is credited
// exactly once. If every attempt misses, this throws and getGameState
// reports ok:false; nothing is lost, because any rows booked stay
// booked and the un-advanced watermark makes the next open credit
// their gold then. The same reconciliation is the failure boundary for
// a save that throws mid-pass: rows booked, watermark not advanced →
// the next open pays the stranded delta, never twice.
async function settleGame(ctx: Ctx, health: Snapshot | null, strength: StrengthTraining | null, todayLA: string, pinGuard?: { revision: number; gold: number; goldLedgerSum: number | null }): Promise<{ totalXp: number; settledThroughDate: string | null; ledger: z.infer<typeof gameSettlementEntrySchema>[]; dailyTasks: z.infer<typeof gameDailyTaskSchema>[]; profile: GameProfile; committedRevision: number; committedGold: number; committedGoldLedgerSum: number | null; committedLedgerGoldSum: number }> {
  const db = ctx.db<typeof schema>();
  // Guarded mode (redeem only): the provable advancement chain —
  // starts at the confirmed pin and advances only through THIS
  // settle's own committed save. Verified on the first read and on
  // every CAS retry's re-read; any other state aborts the settle.
  let chainHead: { revision: number; gold: number; goldLedgerSum: number | null } | null = pinGuard ?? null;
  for (let attempt = 0; attempt < PROFILE_CAS_ATTEMPTS; attempt++) {
    const row = await loadGameStateRow(ctx);
    if (chainHead !== null && (row.revision !== chainHead.revision || row.profile.gold !== chainHead.gold || row.profile.goldLedgerSum !== chainHead.goldLedgerSum)) {
      throw settlementPinMovedError();
    }
    const profile = row.profile;
    // Gold baseline for this attempt: the ledger gold SUM the balance
    // being carried already accounts for.
    // - Not yet initialized (S2 one-time conversion): the balance starts
    //   at the cumulative XP booked so far, and the baseline is the
    //   ledger gold SUM at this moment (pre-S2 rows carry gold 0; their
    //   value entered through the XP conversion, never through gold).
    // - Watermark present: it IS the baseline, by construction.
    // - Watermark missing (profile predates the watermark column):
    //   adopt as baseline the gold of rows booked at or before the
    //   immutable adoption boundary — the profile's last successful
    //   save as captured by the migration 0012 backfill in
    //   game_state.gold_adoption_boundary. Those rows' gold entered
    //   the balance through that save or an earlier one. Rows booked
    //   AFTER the boundary (a save failure stranded them: the ledger
    //   has their gold, the balance does not) stay outside the
    //   baseline, so the reconciliation below credits them now. The
    //   boundary is never written by profile saves, so a purchase,
    //   allocation or equip landing between the failed save and this
    //   retry cannot absorb the stranded rows into the baseline the
    //   way reading updated_at directly did (updated_at advances on
    //   every profile write). Gold older than the boundary cannot be
    //   told apart from gold already spent, so it is adopted as
    //   accounted rather than re-minted — see the section header's
    //   limitation note. The updatedAt fallback covers only a row the
    //   backfill could not stamp (defensive; unreachable for rows the
    //   migration saw).
    let baseline: number;
    if (!profile.goldInitialized) {
      const totals = await db.select({ xpTotal: sql`COALESCE(SUM(${schema.gameSettlements.xp}), 0)`, goldTotal: sql`COALESCE(SUM(${schema.gameSettlements.gold}), 0)` }).from(schema.gameSettlements);
      profile.gold = Number(totals[0]?.xpTotal ?? 0);
      profile.goldInitialized = true;
      baseline = Number(totals[0]?.goldTotal ?? 0);
    } else if (profile.goldLedgerSum !== null) {
      baseline = profile.goldLedgerSum;
    } else {
      const boundary = row.exists ? (row.goldAdoptionBoundary ?? row.updatedAt) : null;
      if (boundary === null) {
        baseline = 0;
      } else {
        const adopted = await db.select({ total: sql`COALESCE(SUM(${schema.gameSettlements.gold}), 0)` }).from(schema.gameSettlements)
          .where(lte(schema.gameSettlements.createdAt, boundary));
        baseline = Number(adopted[0]?.total ?? 0);
      }
    }
    const plan = buildGamePlan(health, strength, todayLA, profile);
    const unique = [...new Map(plan.candidates.map((candidate) => [`${candidate.localDate}|${candidate.category}|${candidate.detail}`, candidate])).values()];
    for (const candidate of unique) {
      await settleLedgerRow(ctx, candidate);
    }
    // Daily tasks: atomically book each met task for today (the ledger
    // PK caps it at once per task per day, across any number of
    // concurrent passes); claim state is read back from the ledger
    // below, never trusted from a pre-insert check.
    const evaluated = evaluateDailyTasks(health, strength, todayLA);
    for (const entry of evaluated) {
      if (entry.progress !== null && entry.progress >= entry.def.target) {
        await bookLedgerRow(ctx, { localDate: todayLA, category: "daily_task", detail: entry.def.id, xp: entry.def.rewardXp, gold: entry.def.rewardGold, sourceDate: todayLA, sourceUpdatedAt: health?.updatedAt ?? null });
      }
    }
    // Task-granted equipment: the first sleep-task completion ever
    // grants the dawn charm (owned forever after). Judged from the
    // ledger itself — any booked sleep task, any date — so the grant
    // survives a failed profile save and lands with the next one.
    if (!profile.owned.includes("dawn_charm")) {
      const charmRows = await db.select({ localDate: schema.gameSettlements.localDate }).from(schema.gameSettlements)
        .where(and(eq(schema.gameSettlements.category, "daily_task"), eq(schema.gameSettlements.detail, "sleep_7h30"))).limit(1);
      if (charmRows.length) profile.owned.push("dawn_charm");
    }
    // settledThroughDate is the latest SETTLED day: reward_redeem rows
    // (S3 gold flows booked on the redemption day) are not settlements
    // and must never pose as one, so the MAX runs over the other
    // categories only. XP/gold SUMs still cover every row — a
    // redemption's negative gold is exactly what the watermark
    // reconciliation below must account for.
    const totals = await db.select({ total: sql`COALESCE(SUM(${schema.gameSettlements.xp}), 0)`, goldTotal: sql`COALESCE(SUM(${schema.gameSettlements.gold}), 0)`, through: sql`MAX(CASE WHEN ${schema.gameSettlements.category} <> 'reward_redeem' THEN ${schema.gameSettlements.localDate} END)` }).from(schema.gameSettlements);
    const totalRow = totals[0];
    const totalXp = Number(totalRow?.total ?? 0);
    const ledgerGoldSum = Number(totalRow?.goldTotal ?? 0);
    const settledThroughDate = typeof totalRow?.through === "string" ? totalRow.through : null;
    // Reconcile the balance against the ledger and advance the
    // watermark to the sum just read; both persist in the CAS write
    // below, so a failed write leaves the watermark behind and the
    // delta is re-derived (and paid exactly once) next time. The
    // balance is floored at 0 so a downward source revision after gold
    // was spent can never drive it negative (the watermark still
    // advances — the floor absorbs the difference once, it is not a
    // debt carried forward).
    profile.gold = Math.max(0, profile.gold + (ledgerGoldSum - baseline));
    profile.goldLedgerSum = ledgerGoldSum;
    // Attribute points: 3 per level gained, backfilled once from the
    // current level (level derives from total XP, so this is exact,
    // never speculative) and never revoked.
    const level = Math.floor(totalXp / GAME_XP_PER_LEVEL) + 1;
    const earned = (level - 1) * GAME_POINTS_PER_LEVEL;
    if (earned > profile.attrPointsEarned) profile.attrPointsEarned = earned;
    const saved = await saveGameProfile(ctx, profile, totalXp, settledThroughDate, row.exists ? row.revision : null);
    if (!saved) continue;
    // This settle's own CAS save landed: in guarded mode it is the
    // one advancement entitled to extend the chain — to exactly
    // the state this save committed (read revision + 1, the draft's
    // reconciled balance and watermark), never to a later re-read.
    if (chainHead !== null) chainHead = { revision: row.revision + 1, gold: profile.gold, goldLedgerSum: profile.goldLedgerSum };
    // Read back today's claim state from the ledger (post-save, so the
    // response reflects what actually persisted).
    const claimedRows = await db.select({ detail: schema.gameSettlements.detail }).from(schema.gameSettlements)
      .where(and(eq(schema.gameSettlements.localDate, todayLA), eq(schema.gameSettlements.category, "daily_task")));
    const claimed = new Set(claimedRows.map((claimedRow) => claimedRow.detail));
    const dailyTasks: z.infer<typeof gameDailyTaskSchema>[] = evaluated.map((entry) => {
      const state: z.infer<typeof gameDailyTaskSchema>["state"] = claimed.has(entry.def.id)
        ? "claimed"
        : entry.progress === null ? "missing" : entry.progress >= entry.def.target ? "claimed" : "in_progress";
      return { id: entry.def.id, label: entry.def.label, targetLabel: entry.def.targetLabel, progress: entry.progress, progressLabel: entry.progressLabel, target: entry.def.target, state, rewardXp: entry.def.rewardXp, rewardGold: entry.def.rewardGold };
    });
    const ledgerRows = await db.select().from(schema.gameSettlements).orderBy(desc(schema.gameSettlements.localDate), asc(schema.gameSettlements.category), asc(schema.gameSettlements.detail)).limit(90);
    return {
      totalXp,
      settledThroughDate,
      dailyTasks,
      profile,
      // The state THIS settlement actually committed (CWEB-REDEEM-
      // SAFE-001 P0-1): the CAS save above landed exactly this draft
      // at exactly this revision — the update path matched the read
      // revision and advanced it by one inside the same statement,
      // and the insert path wrote revision 1 over a non-existent row
      // (read revision 0). A caller that needs a commit base (the
      // redemption handler) must use THESE values, never a post-
      // settle re-read: a re-read taken after the save can absorb an
      // external write that landed in between and mistake it for
      // this settlement's own result. committedLedgerGoldSum is the
      // ledger SUM this attempt reconciled against, so the caller
      // can verify the committed watermark against the settlement's
      // own books, not against a later state of the world.
      committedRevision: row.revision + 1,
      committedGold: profile.gold,
      committedGoldLedgerSum: profile.goldLedgerSum,
      committedLedgerGoldSum: ledgerGoldSum,
      ledger: ledgerRows.map((ledgerRow) => ({
        localDate: ledgerRow.localDate,
        category: ledgerRow.category,
        detail: ledgerRow.detail,
        xp: ledgerRow.xp,
        gold: ledgerRow.gold,
        ruleVersion: ledgerRow.ruleVersion,
        sourceDate: ledgerRow.sourceDate,
        sourceUpdatedAt: ledgerRow.sourceUpdatedAt,
        settledAt: ledgerRow.createdAt.toISOString(),
      })),
    };
  }
  throw new Error("game profile contention: settlement could not persist after repeated CAS retries");
}

// The strength source (训练记录, space-6) is local data in a sibling artifact:
// it changes the moment the user finishes a set there, so it must not ride
// along with the once-a-day HealthKit refresh or sit behind a fixed
// dedupeKey. A fixed "daily-…" dedupeKey made the daemon return the morning
// task's handle for later manual syncs ("active or recently terminal" tasks
// are single-flighted), silently swallowing them. Every explicit sync below
// therefore spawns a fresh task with allowParallel, and getDashboard
// re-syncs on every open (see maybeAutoSyncStrength).
const STRENGTH_SYNC_PROMPT = `Synchronize the user's strength-training summary from their existing web artifact named 训练记录 (slug space-6). Treat that artifact as the only source for strength sets; do not infer workouts from Apple Health. Use its published getDashboard action with recent_limit 20. Include the active workout, if any, plus every returned recent completed workout. For each workout preserve the source id as a string, routine, unit, start and completion instants, status, all sets grouped by exercise, and completed flags. Routine contract: routine has exactly five possible values — push, pull, legs, home_posture, home_snowboard — and you must preserve each workout's routine value verbatim from the source. Never rewrite home_posture or home_snowboard as push, pull, or legs, and never omit or filter out a workout because of its routine value; every returned workout belongs in the payload with its original routine. Compute completedSets and totalVolume from completed sets only; a set contributes weight × reps only when both are present. Compute durationMinutes from timestamps when completion exists; for an active workout use the current instant. Use America/Los_Angeles to derive the workout date and Monday-based week starts. Choose the most recent workout's unit as displayUnit (default lb when there are no workouts); convert mixed-unit volume exactly when aggregating weekly totals (1 lb = 0.45359237 kg) so every weeklyTrend volume is in displayUnit. Include up to the latest eight Monday-based weeks, ascending, with zero-volume intervening weeks retained. The getDashboard response also returns week_summaries: whole-week summaries that the source computes server-side over its full data for the current week and the previous week, each with week_start, sessions, measured_completed_sets, unmeasured_completed_sets, volume_lb, and volume_kg. For a weeklyTrend week whose weekStart matches a week_summaries entry's week_start, take sessions, measuredCompletedSets, and unmeasuredCompletedSets directly from that entry, compute volume by converting volume_lb and volume_kg into displayUnit and adding them (1 lb = 0.45359237 kg), and set coverageComplete: true. For weeks not covered by week_summaries, do not set coverageComplete, and never infer whole-week sessions or set counts from the truncated workouts list (capped at 20) — those counts may simply be omitted. If the getDashboard response has no week_summaries at all (an older source), set coverageComplete on no week and leave measuredCompletedSets and unmeasuredCompletedSets empty; never present sample counts as whole-week coverage. Version contract: BEFORE you call getDashboard on 训练记录, record the current instant as readStartedAt, and set the payload's updatedAt to that readStartedAt — the moment the source read began. Never set updatedAt to the instant the task finishes or to the callback instant. Why: the save versions snapshots by read-start time and applies them with an atomic compare-and-write that rejects any version older than the one already stored, so a read that started earlier can never overwrite a newer snapshot even when it finishes later; stamping the completion time instead would disguise an old read as new data and defeat that guard. If the source is read successfully and contains no workouts, return empty workouts and weeklyTrend and explain in note that completed or active sets from 训练记录 will appear after synchronization. A response with forbidden: true counts as a failed read, not as an empty source. If the source cannot be read, do not replace the last successful strength snapshot with an empty one. Do not create plausible workouts or sets. Call the expected save action exactly once only after a successful source read.`;

// Every-open strength sync (2026-10-15): the user rejected the five-minute
// staleness threshold — training data is local to the sibling artifact, so
// opening this dashboard must always pull it fresh, showing the stored
// snapshot first and repainting when the read lands. getDashboard therefore
// spawns (or reuses) a strength sync on every owner read, regardless of
// how recent the stored snapshot is. The only guard left is anti-spam: a
// spawn less than two minutes old is reused and its task id returned again,
// so React Query refetches during one open (poll ticks, invalidations)
// never fan out into duplicate tasks, while a genuinely new open after
// that window starts a genuinely new read.
let lastAutoStrengthSpawnAt = 0;
let lastAutoStrengthTaskId: string | null = null;

async function maybeAutoSyncStrength(ctx: Ctx): Promise<string | null> {
  const now = Date.now();
  if (lastAutoStrengthTaskId && now - lastAutoStrengthSpawnAt < 2 * 60_000) {
    return lastAutoStrengthTaskId;
  }
  try {
    const task = await ctx.agent.spawnTask(STRENGTH_SYNC_PROMPT, {
      expectsAction: "saveStrengthTrainingSnapshot",
      dedupeKey: `strength-autosync-${Math.floor(now / 120_000)}`,
    });
    if (!task.ok) return null;
    lastAutoStrengthSpawnAt = now;
    lastAutoStrengthTaskId = task.taskId;
    // Return the task id so the client can poll this auto-sync to completion
    // and repaint the strength panel in the same session.
    return task.taskId;
  } catch {
    // Auto-sync is best-effort; the manual 同步训练 button remains available.
    return null;
  }
}

type SyncLogEntry = z.infer<typeof syncLogEntrySchema>;
type DataStatus = z.infer<typeof dataStatusSchema>;
type UnifiedDay = z.infer<typeof unifiedDaySchema>;

async function recordSyncLog(ctx: Ctx, entry: { source: "health" | "strength" | "system"; status: "saved" | "failed" | "diagnosed"; itemCount: number; note: string; sourceUpdatedAt: Date | null }): Promise<void> {
  try {
    const db = ctx.db<typeof schema>();
    await db.insert(schema.syncLog).values({
      source: entry.source,
      status: entry.status,
      itemCount: entry.itemCount,
      note: entry.note.slice(0, 500),
      sourceUpdatedAt: entry.sourceUpdatedAt,
      createdAt: new Date(),
    });
  } catch {
    // Logging must never break a save.
  }
}

async function loadRecentLogs(ctx: Ctx): Promise<SyncLogEntry[]> {
  try {
    const db = ctx.db<typeof schema>();
    const rows = await db.select().from(schema.syncLog).orderBy(desc(schema.syncLog.id)).limit(8);
    return rows.map((row) => ({
      id: row.id,
      source: row.source,
      status: row.status,
      itemCount: row.itemCount,
      note: row.note,
      sourceUpdatedAt: row.sourceUpdatedAt ? row.sourceUpdatedAt.toISOString() : null,
      createdAt: row.createdAt.toISOString(),
    }));
  } catch {
    return [];
  }
}

type ReadinessHistoryPoint = z.infer<typeof readinessHistoryPointSchema>;

// Pure trend builder (H-LOAD-001 archive): the 7 consecutive dates ending
// at endDate, ascending, each carrying ONLY its own archived score. A date
// with no archive row — or an archived row whose score was null — stays a
// null gap. Nothing is ever copied from another day: a recomputation
// today does not equal the score that was actually shown on a past date,
// and past dates were never archived before this table existed.
function buildReadinessTrendPoints(rows: Array<{ date: string; score: number | null }>, endDate: string): ReadinessHistoryPoint[] {
  const byDate = new Map(rows.map((row) => [row.date, row.score]));
  return Array.from({ length: 7 }, (_, index) => {
    const date = shiftDate(endDate, index - 6);
    return { date, score: byDate.get(date) ?? null };
  });
}

// Read the trend window from the archive ONLY. A read failure degrades to
// seven gaps rather than breaking the dashboard response — the trend is a
// read-only display of what was archived, never a live recomputation.
async function loadReadinessTrendPoints(ctx: Ctx, endDate: string): Promise<ReadinessHistoryPoint[]> {
  try {
    const db = ctx.db<typeof schema>();
    const rows = await db.select({ date: schema.readinessHistory.date, score: schema.readinessHistory.score })
      .from(schema.readinessHistory)
      .where(and(gte(schema.readinessHistory.date, shiftDate(endDate, -6)), lte(schema.readinessHistory.date, endDate)))
      .orderBy(asc(schema.readinessHistory.date));
    return buildReadinessTrendPoints(rows, endDate);
  } catch {
    return buildReadinessTrendPoints([], endDate);
  }
}

// Archive one computed readiness under its date (H-LOAD-001, owner-
// approved 2026-10-18; H-ARCHIVE-SAFE-001 hardening). Two safety gates:
// (1) Date gate: only LA today may be archived. `todayLA` is the caller's
// America/Los_Angeles today (see laTodayString); when it is provided and
// readiness.date differs — a stale snapshot opened days later, a future
// or malformed date — the write is skipped silently: the dashboard
// response is returned unchanged, the trend honestly shows a gap, and no
// failure ledger entry is written (a skipped backfill is not a fault).
// (2) Same-day version arbitration over BOTH inputs the score was
// computed from — the health snapshot version AND the morning check-in
// input version. The check-in version is judged by its NUMERIC revision
// (`checkinRevision`: the morning_checkin.revision the caller read
// alongside the feeling, bound at read time, null when no check-in row
// existed). The legacy text `checkinVersion` (the row's updated_at) is
// still stored for compatibility but no longer arbitrates: two saves in
// the same millisecond share an updated_at while their feelings differ,
// so the text version stamped both inputs as "the same version" and a
// request that had read the OLDER feeling (but paused before its archive
// write) could overwrite the score archived from the NEWER feeling. The
// upsert is ONE atomic statement whose ON CONFLICT … WHERE applies the
// update only when the incoming health version is non-null AND (strictly
// newer than the stored one, OR equal to it while the incoming
// check-in revision is not older than the stored one). Equal check-in
// revisions are the same input replayed idempotently, so they may
// overwrite; an incoming null check-in revision never overwrites a
// stored non-null one (the row was computed without an input the stored
// score had); a stored null check-in revision (rows archived before
// revisions existed — including rows carrying only the legacy text
// checkin_version) counts as the oldest and may always be superseded at
// equal health version. A null incoming health version may only ever be
// the first insert for its date and never overwrites an existing row.
// Freshness is judged ONLY by these input versions, never by the write
// instant. Only dates actually computed from now on are archived — no
// backfill, no recomputation of past dates. A write failure must not
// block the dashboard's main response, so it is caught here and surfaced
// in the sync ledger instead; the ledger note deliberately carries no
// health values, only the fact and the date affected.
async function archiveReadiness(ctx: Ctx, readiness: Readiness, snapshotVersion: string | null, checkinVersion: string | null, checkinRevision: number | null, todayLA?: string): Promise<void> {
  if (todayLA !== undefined && readiness.date !== todayLA) return;
  try {
    const db = ctx.db<typeof schema>();
    const now = new Date();
    const components = JSON.stringify(readiness.components);
    await db.insert(schema.readinessHistory).values({
      date: readiness.date,
      score: readiness.score,
      components,
      confidence: readiness.confidence,
      snapshotVersion,
      checkinVersion,
      checkinRevision,
      createdAt: now,
      updatedAt: now,
    }).onConflictDoUpdate({
      target: schema.readinessHistory.date,
      set: { score: readiness.score, components, confidence: readiness.confidence, snapshotVersion, checkinVersion, checkinRevision, updatedAt: now },
      setWhere: sql`excluded.snapshot_version IS NOT NULL AND (${schema.readinessHistory.snapshotVersion} IS NULL OR excluded.snapshot_version > ${schema.readinessHistory.snapshotVersion} OR (excluded.snapshot_version = ${schema.readinessHistory.snapshotVersion} AND (${schema.readinessHistory.checkinRevision} IS NULL OR (excluded.checkin_revision IS NOT NULL AND excluded.checkin_revision >= ${schema.readinessHistory.checkinRevision}))))`,
    });
  } catch {
    await recordSyncLog(ctx, { source: "system", status: "failed", itemCount: 0, note: `readiness 评分存档写入失败 · 日期 ${readiness.date} · 趋势位可能缺当日分数`, sourceUpdatedAt: null });
  }
}

function freshnessFor(source: "health" | "strength", label: string, updatedAt: string | null, dataDate: string | null, detailBase: string): z.infer<typeof sourceFreshnessSchema> {
  if (!updatedAt) {
    return { source, label, updatedAt: null, dataDate, ageMinutes: null, freshness: "missing", detail: detailBase };
  }
  const ms = Date.parse(updatedAt);
  const ageMinutes = Number.isNaN(ms) ? null : Math.max(0, Math.floor((Date.now() - ms) / 60_000));
  const freshness: z.infer<typeof sourceFreshnessSchema>["freshness"] = ageMinutes === null ? "stale" : ageMinutes <= 120 ? "fresh" : ageMinutes <= 24 * 60 ? "today" : "stale";
  return { source, label, updatedAt, dataDate, ageMinutes, freshness, detail: detailBase };
}

// Per-source data status (H-SOURCE-001): the health side is computed from
// the health load alone and the strength side from the strength load alone
// (with the legacy embedded fallback only when the standalone row is
// missing). A corrupt source counts as missing for freshness, but its
// detail says the snapshot is damaged so the user can tell "never synced"
// apart from "synced but unreadable".
function buildDataStatus(health: HealthLoad, strength: StrengthLoad, logs: SyncLogEntry[]): DataStatus {
  const nowIso = new Date().toISOString();
  const healthFresh = health.state === "ok" && health.snapshot
    ? freshnessFor("health", "Apple 健康", health.snapshot.updatedAt, health.snapshot.dataDate, `数据日期 ${health.snapshot.dataDate}`)
    : health.state === "corrupt"
      ? freshnessFor("health", "Apple 健康", null, null, "健康快照损坏，等待重新同步")
      : freshnessFor("health", "Apple 健康", null, null, "尚未同步过健康数据");
  let strengthFresh: z.infer<typeof sourceFreshnessSchema>;
  if (strength.state === "corrupt") {
    strengthFresh = freshnessFor("strength", "训练记录", null, null, "训练快照损坏，等待重新同步");
  } else {
    const strengthData = effectiveStrength(health, strength);
    if (strengthData) {
      const latestStrengthDate = strengthData.workouts.length ? [...strengthData.workouts].sort((a, b) => b.date.localeCompare(a.date))[0]?.date ?? null : null;
      strengthFresh = freshnessFor("strength", "训练记录", strengthData.updatedAt, latestStrengthDate, strengthData.workouts.length ? `共 ${strengthData.workouts.length} 次训练，最近 ${latestStrengthDate ?? "—"}` : "训练记录里暂无训练");
    } else {
      strengthFresh = freshnessFor("strength", "训练记录", null, null, "尚未同步过训练记录");
    }
  }
  let overall: DataStatus["overall"] = "ok";
  let overallLabel = "两边数据都在新鲜期内";
  if (healthFresh.freshness === "missing" && strengthFresh.freshness === "missing") { overall = "empty"; overallLabel = "还没有数据"; }
  else if (healthFresh.freshness === "missing" || strengthFresh.freshness === "missing") { overall = "partial"; overallLabel = "有一边还没有数据"; }
  else if (healthFresh.freshness === "stale" || strengthFresh.freshness === "stale") { overall = "stale"; overallLabel = "有一边数据已过期，打开看板会自动补同步"; }
  else if (healthFresh.freshness === "today" || strengthFresh.freshness === "today") { overall = "ok"; overallLabel = "数据在今天更新过"; }
  return { generatedAt: nowIso, health: healthFresh, strength: strengthFresh, overall, overallLabel, recentLogs: logs };
}

// Unified timeline built from whichever sources are usable (H-SOURCE-001):
// health days come from the health snapshot, strength days from the
// effective strength data (standalone first, embedded fallback), and the
// two merge by date when both are present. Strength volume is converted
// into the strength data's displayUnit (H-UNITS-001).
function buildUnifiedTimeline(healthSnapshot: Snapshot | null, strengthData: StrengthTraining | null): UnifiedDay[] {
  if (!healthSnapshot && !strengthData) return [];
  const byDate = new Map<string, UnifiedDay>();
  const ensure = (date: string): UnifiedDay => {
    const existing = byDate.get(date);
    if (existing) return existing;
    const created: UnifiedDay = { date, steps: null, sleepHours: null, restingHr: null, hrvMs: null, strengthSessions: 0, strengthVolume: 0, strengthRoutines: [], workoutSessions: 0, workoutTypes: [], swimMeters: null, hkWorkouts: [], hasHealth: false, hasStrength: false };
    byDate.set(date, created);
    return created;
  };
  if (healthSnapshot) {
    for (const row of healthSnapshot.historyDaily) {
      const day = ensure(row.date);
      day.steps = row.steps;
      day.restingHr = row.restingHr;
      day.hrvMs = row.hrvMs;
      day.hasHealth = true;
    }
    for (const sleep of healthSnapshot.historySleeps) {
      const day = ensure(sleep.date);
      day.sleepHours = round(totalSleepHours(sleep, sleep.totalHours), 1);
      day.hasHealth = true;
    }
    for (const workout of healthSnapshot.historyWorkouts) {
      const day = ensure(workout.date);
      day.workoutSessions += 1;
      if (!day.workoutTypes.includes(workout.type)) day.workoutTypes.push(workout.type);
      if (workout.type.toLowerCase().includes("swim") && workout.distanceMeters !== null) {
        day.swimMeters = (day.swimMeters ?? 0) + workout.distanceMeters;
      }
      day.hasHealth = true;
    }
    // Per-type HealthKit groups (H-WORKOUTS-001 item 2): aggregate the
    // same historyWorkouts sessions by date, then by raw type string.
    // Sessions come only from these HealthKit session rows — never
    // reverse-derived from historyDaily aggregates (exerciseMinutes,
    // swimMeters, …) — and never merge into the strength counts above.
    // A date with only HK sessions still gets a day row via ensure() and
    // hasHealth = true. Groups are sorted ascending by type string so the
    // output order is deterministic.
    const hkByDate = new Map<string, Map<string, { sessions: number; durationSum: number; hasDuration: boolean }>>();
    for (const workout of healthSnapshot.historyWorkouts) {
      let byType = hkByDate.get(workout.date);
      if (!byType) { byType = new Map(); hkByDate.set(workout.date, byType); }
      let group = byType.get(workout.type);
      if (!group) { group = { sessions: 0, durationSum: 0, hasDuration: false }; byType.set(workout.type, group); }
      group.sessions += 1;
      if (workout.durationMinutes !== null) { group.durationSum += workout.durationMinutes; group.hasDuration = true; }
    }
    for (const [date, byType] of hkByDate) {
      const day = ensure(date);
      day.hkWorkouts = [...byType.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([type, group]) => ({ type, sessions: group.sessions, durationMinutes: group.hasDuration ? round(group.durationSum, 1) : null }));
      day.hasHealth = true;
    }
  }
  if (strengthData) {
    for (const workout of strengthData.workouts) {
      const day = ensure(workout.date);
      day.strengthSessions += 1;
      day.strengthVolume += convertVolumeToUnit(workout.totalVolume, workout.unit, strengthData.displayUnit);
      if (!day.strengthRoutines.includes(workout.routine)) day.strengthRoutines.push(workout.routine);
      day.hasStrength = true;
    }
  }
  return [...byDate.values()].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 14).map((day) => ({ ...day, strengthVolume: round(day.strengthVolume, 1) }));
}

// ---------------------------------------------------------------------------
// LIFE-C1 人生游戏 S3 (CWEB-MVP-001·S3): personal rewards on the SAME gold
// ledger as S2. The owner keeps a self-set reward list (name + gold
// price); redeeming a reward spends SAVED gold only — the profile
// balance exactly as settlement maintains it — and issues a personal
// receipt. No e-commerce, no ordering, no real account is ever touched;
// a receipt proves gold was redeemed, never that the real-world reward
// was enjoyed.
//
// Three-state redemption (PM three-state design): list → confirmation
// preview → receipt. The preview pins rewardId + rewardRevision + price
// + the current balance + expected_balance_version (the game_state
// profile revision, the same CAS token every profile write advances).
// redeemReward re-checks those pins against stored state BEFORE any
// write (stale price / stale balance version / insufficient funds are
// typed rejections with zero redemption writes), then settles (so gold
// stranded by a failed settlement save is reconciled into the balance
// first), then commits the redemption itself as ONE atomic batch
// (CWEB-REDEEM-SAFE-001): receipt insert guarded on the exact
// pre-commit profile state and the reward pin → profile CAS
// deduction (gold −price, watermark −price, revision +1) chained on
// that receipt row existing → reward_redeem ledger flow (xp 0,
// gold −price, detail = reward id; accumulated per day+reward)
// gated on the deduction having actually modified the profile
// (SQLite changes()). All three land together or none do: a failed
// statement, a lost CAS race, or an interruption leaves the fully
// old state, and a competitor's commit classifies the loser from
// the winner's stored state (insufficient / stale / the winner's
// receipt) with zero writes by the loser. There is no
// receipt-without-deduction window and no Math.max(0) flooring
// anywhere in the redemption path — the CAS guard gold ≥ price
// makes an overdraft unrepresentable. The stored receipt, read back
// after the batch, is the only success oracle: it exists only when
// the deduction, the watermark advance, and the ledger flow
// committed with it.
//
// Idempotency: requestId is the identity of one redemption intent. A
// replay with the same id and the same content returns the original
// receipt as already_resolved without charging again; the same id with
// different content is a typed request_conflict rejection. A client
// that loses the response can look the receipt up by requestId
// (getRedemptionReceipt) or retry redeemReward with the identical
// arguments — never with a fresh id for the same intent. A `busy`
// result means the outcome is UNKNOWN (the commit may or may not have
// landed); the client keeps the same requestId and resolves it through
// the lookup/retry path instead of starting a new intent.
//
// Next-reward goal (S3 余项): game_reward_goal holds the owner's one
// explicit "next reward" preference (rewardId only). It is a display
// preference — never an input to prices, balances, or settlement —
// and no default is ever invented when it is unset.
//
// Completion proof (CWEB-REDEEM-SAFE-001 follow-up): the atomic batch
// also records, inside the receipt row itself, the gold-ledger
// watermark that batch produced (completion_proof, migration 0015).
// A receipt carrying that value is AUTHORITATIVELY complete — the
// proof could only be written by the batch that also deducted and
// booked the flow. A receipt without it (anything issued before the
// proof existed, including a half-completed legacy write: receipt
// present, no deduction, no flow) is UNVERIFIED: lookup, list,
// replay, and the UI all present it as 未核实, never as a completed
// redemption. Nothing retroactively charges, deletes, or rewrites
// such a row; a same-key retry resolves to the typed `unverified`
// result with zero writes.
//
// Pin scope (same follow-up): the confirmation's balance version is
// verified across the WHOLE commit scope, not only at the pre-check.
// After the pre-validation, the handler re-reads the profile once
// more (the ledger-SUM read is a real pause point where a competing
// write can land) and again as the commit loop's first read: if an
// external write moved the balance version, the balance, or the
// watermark anywhere before the first commit attempt, the old
// confirmation is rejected as stale with zero redemption writes. The
// only advancement entitled to pass is THIS handler's own settlement,
// whose post-settle state becomes the loop's base — so a same-key
// retry after a busy result is never staled by the settlement its
// own first attempt performed.
//
// Reconciliation gate (same follow-up): when settlement is needed,
// its failure is NOT swallowed — a settle that throws, or a stored
// watermark that still differs from the ledger gold SUM afterwards,
// aborts the redemption with a typed busy result and zero redemption
// writes. The redemption path never spends from an unreconciled
// balance and never floors an overdraft away.
//
// Own-settle commit base (P0-1, next follow-up): settleGame returns
// the revision / balance / watermark its own CAS save actually
// committed (plus the ledger SUM that attempt reconciled against),
// and redeem's commitBase is built ONLY from that return value. The
// earlier shape — re-reading the profile after the settle and
// adopting whatever it showed as the base — let an external write
// landing between the settlement's save and the re-read (gold moved,
// revision advanced) be absorbed into the base, so the old
// confirmation charged straight over a balance version the owner
// never confirmed. Now such a write is seen by the commit loop's
// first-read movement check against the settlement's own commit and
// rejects the confirmation as stale with zero redemption writes;
// the post-settle re-read survives only as the reconciliation gate
// (a watermark/SUM mismatch is a busy, never a base).
//
// Pre-settlement baseline (final remainder of the same follow-up):
// the pin binding above covered the handler's own reads, but the
// settlement it then ran could still absorb an external advancement
// that landed BEFORE the settle — most sharply a purchase landing
// in front of the settle's first CAS save: the save missed, the
// settle's retry re-read the winner's profile, reconciled on top
// of it, and the old confirmation charged against a balance
// version the owner never confirmed. The redeem-path settle is
// therefore pin-bound end to end (see settleGame's pinGuard): the
// first read and every CAS retry verify the provable chain that
// starts at the confirmed pin and advances only through this
// settle's own committed save; any external advancement aborts
// the settle, and the handler answers stale (after the durable
// receipt arbitration) with zero redemption writes. Unguarded
// settlements on plain reads keep their absorbing retry.
//
// Rejection/success arbitration (P0-2, same follow-up): a terminal
// rejection of a request is durable-arbitrated against that
// request's success — every rejection path re-reads the receipt
// table as its last step (resolveCommittedReceipt) and classifies
// from a receipt found there instead of emitting the rejection. A
// same-requestId handler that fully commits while this handler is
// in flight therefore resolves the in-flight handler to the
// winner's verified receipt, never to a stale/insufficient verdict
// that would terminally clear a completed intent; a rejection is
// emitted only when no receipt exists at that final read.
//
// Read-only snapshot (S3 余项 follow-up): getRewardsSnapshot returns
// the STORED rewards state — balance, balance version, goal,
// rewards, receipts — with no settlement, no profile save, and no
// task spawn of any kind. Its `ok` is the stored state's own
// reconciliation fact (initialized profile whose watermark equals
// the current ledger gold SUM): a stored balance of 0 that is
// reconciled reads as a true zero, an unreconciled stored state
// reads ok:false with every stored row still present. The goal
// card's and the recovery flow's 只读重查 use it; getRewards and
// getGameState keep their settle-on-read behaviour and are never
// presented as read-only.
//
// STRICT owner gate on every read and write below — the L0.1
// sync-channel exception does NOT extend to rewards. Settlement
// formulas, the LEVEL transition, attributes, equipment and daily
// tasks are untouched; receipts are never deleted or re-priced by late
// source revisions or level changes.
// ---------------------------------------------------------------------------
const rewardItemSchema = z.object({
  id: z.number().int().positive(),
  name: z.string().min(1),
  price: z.number().int().positive(),
  revision: z.number().int().positive(),
});
type RewardItem = z.infer<typeof rewardItemSchema>;

const rewardReceiptSchema = z.object({
  id: z.number().int().positive(),
  requestId: z.string().min(1),
  rewardId: z.number().int().positive(),
  rewardName: z.string().min(1),
  price: z.number().int().positive(),
  rewardRevision: z.number().int().positive(),
  balanceVersion: z.number().int().nonnegative(),
  goldSpent: z.number().int().positive(),
  balanceAfter: z.number().int().nonnegative(),
  localDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  redeemedAt: z.string().datetime(),
  // Authoritative completion, per request: "verified" only when the
  // receipt carries the completion proof its atomic commit batch
  // recorded; every other stored receipt is "unverified" and must be
  // presented as 未核实, never as a completed redemption.
  verification: z.enum(["verified", "unverified"]),
});
type RewardReceipt = z.infer<typeof rewardReceiptSchema>;

const getRewardsResponse = z.object({
  forbidden: z.boolean(),
  ok: z.boolean(),
  balance: z.number().int().nonnegative(),
  balanceVersion: z.number().int().nonnegative(),
  healthState: z.enum(["ok", "missing", "corrupt"]),
  healthDataDate: z.string().nullable(),
  coverageIncomplete: z.boolean(),
  goalRewardId: z.number().int().positive().nullable(),
  rewards: z.array(rewardItemSchema).max(100),
  receipts: z.array(rewardReceiptSchema).max(50),
});

// The truly read-only stored-state read (getRewardsSnapshot): the
// getRewards field set plus the two facts that define it — it only
// ever read stored rows (readOnly), and whether the stored balance
// is reconciled against the ledger as stored (reconciled: the
// profile is initialized and its watermark equals the current
// ledger gold SUM). `ok` mirrors `reconciled`.
const getRewardsSnapshotResponse = getRewardsResponse.extend({
  readOnly: z.literal(true),
  reconciled: z.boolean(),
});

const setRewardGoalResponse = z.object({
  ok: z.boolean(),
  forbidden: z.boolean(),
  message: z.string(),
  goalRewardId: z.number().int().positive().nullable(),
});

const saveRewardResponse = z.object({
  ok: z.boolean(),
  forbidden: z.boolean(),
  message: z.string(),
  reward: rewardItemSchema.nullable(),
});

const redeemRewardRequest = z.object({
  requestId: z.string().min(8).max(80),
  rewardId: z.number().int().positive(),
  rewardRevision: z.number().int().positive(),
  price: z.number().int().min(1).max(1000000),
  expectedBalanceVersion: z.number().int().nonnegative(),
});
type RedeemRewardArgs = z.infer<typeof redeemRewardRequest>;

const redeemRewardResponse = z.object({
  forbidden: z.boolean(),
  status: z.enum(["redeemed", "already_resolved", "unverified", "insufficient_funds", "stale", "request_conflict", "reward_not_found", "busy", "forbidden"]),
  message: z.string().min(1),
  receipt: rewardReceiptSchema.nullable(),
  balance: z.number().int().nonnegative().nullable(),
  balanceVersion: z.number().int().nonnegative().nullable(),
});

const getRedemptionReceiptResponse = z.object({
  forbidden: z.boolean(),
  found: z.boolean(),
  receipt: rewardReceiptSchema.nullable(),
});

function rewardItemFromRow(row: { id: number; name: string; price: number; revision: number }): RewardItem {
  return { id: row.id, name: row.name, price: row.price, revision: row.revision };
}

function rewardReceiptFromRow(row: { id: number; requestId: string; rewardId: number; rewardName: string; rewardPrice: number; rewardRevision: number; balanceVersion: number; goldSpent: number; balanceAfter: number; localDate: string; createdAt: Date; completionProof: number | null }): RewardReceipt {
  return {
    id: row.id,
    requestId: row.requestId,
    rewardId: row.rewardId,
    rewardName: row.rewardName,
    price: row.rewardPrice,
    rewardRevision: row.rewardRevision,
    balanceVersion: row.balanceVersion,
    goldSpent: row.goldSpent,
    balanceAfter: row.balanceAfter,
    localDate: row.localDate,
    redeemedAt: row.createdAt.toISOString(),
    // The completion proof is the ONLY authoritative completion
    // signal: present exactly when the receipt's own atomic batch
    // committed the deduction and the ledger flow with it. A null
    // proof is never upgraded by inference from the current balance
    // or from per-day ledger aggregates — the receipt stays
    // unverified, visibly, on every surface.
    verification: row.completionProof !== null ? "verified" : "unverified",
  };
}

async function loadRedemptionByRequestId(ctx: Ctx, requestId: string): Promise<RewardReceipt | null> {
  const db = ctx.db<typeof schema>();
  const rows = await db.select().from(schema.gameRewardRedemptions).where(eq(schema.gameRewardRedemptions.requestId, requestId)).limit(1);
  const row = rows[0];
  return row ? rewardReceiptFromRow(row) : null;
}

// The owner's single next-reward preference (id = 1 row), or null when
// none was ever chosen. Read independently of settlement: a balance
// that cannot be verified right now never clears or hides the goal.
async function loadRewardGoalId(ctx: Ctx): Promise<number | null> {
  const db = ctx.db<typeof schema>();
  const rows = await db.select({ rewardId: schema.gameRewardGoal.rewardId }).from(schema.gameRewardGoal).where(eq(schema.gameRewardGoal.id, 1)).limit(1);
  return rows[0]?.rewardId ?? null;
}

// Whether a stored receipt is the resolution of THIS redemption intent:
// same reward, same reward revision, same price, same pinned balance
// version. Any difference under the same requestId is a different
// intent reusing the key — a typed conflict, never a second charge.
function sameRedemptionContent(receipt: RewardReceipt, args: RedeemRewardArgs): boolean {
  return receipt.rewardId === args.rewardId
    && receipt.rewardRevision === args.rewardRevision
    && receipt.price === args.price
    && receipt.balanceVersion === args.expectedBalanceVersion;
}

async function handleGetRewards(ctx: Ctx): Promise<z.infer<typeof getRewardsResponse>> {
  if (!isOwner(ctx)) return { forbidden: true, ok: false, balance: 0, balanceVersion: 0, healthState: "missing", healthDataDate: null, coverageIncomplete: false, goalRewardId: null, rewards: [], receipts: [] };
  const db = ctx.db<typeof schema>();
  const healthLoad = await loadHealthSnapshot(ctx);
  const strengthLoad = await loadStrengthSnapshot(ctx);
  const health = healthLoad.state === "ok" ? healthLoad.snapshot : null;
  const strength = effectiveStrength(healthLoad, strengthLoad);
  // Settle on read, exactly like getGameState, so the balance shown is
  // the saved, reconciled balance. Failure-isolated: when settlement
  // cannot persist, the list and the historical receipts still return
  // from stored state with ok:false — a missing or corrupt health
  // source never hides them, and the saved balance stays spendable.
  // ok:false is the balance-three-state "unverifiable" signal: the
  // stored numbers ride along for reference, but the client must not
  // present them as a verified balance or offer a redemption against
  // them until a later read returns ok:true.
  let ok = true;
  try {
    await settleGame(ctx, health, strength, laTodayString());
  } catch {
    ok = false;
  }
  const row = await loadGameStateRow(ctx);
  const rewardRows = await db.select().from(schema.gameRewards).orderBy(asc(schema.gameRewards.id)).limit(100);
  const receiptRows = await db.select().from(schema.gameRewardRedemptions).orderBy(desc(schema.gameRewardRedemptions.id)).limit(50);
  const goalRewardId = await loadRewardGoalId(ctx);
  return {
    forbidden: false,
    ok,
    balance: row.profile.gold,
    balanceVersion: row.revision,
    healthState: healthLoad.state,
    healthDataDate: health?.dataDate ?? null,
    coverageIncomplete: health?.coverageIncomplete ?? false,
    goalRewardId,
    rewards: rewardRows.map(rewardItemFromRow),
    receipts: receiptRows.map(rewardReceiptFromRow),
  };
}

// A stored receipt under this requestId whose completion cannot be
// proven (no completion proof): the intent is classified — never as
// a success — with zero writes. Shared by the replay check and the
// commit loop's raced-receipt check so every path classifies a
// legacy receipt identically.
function unverifiedReceiptResult(receipt: RewardReceipt, row: GameStateRow): z.infer<typeof redeemRewardResponse> {
  return {
    forbidden: false,
    status: "unverified",
    message: "查到了这张历史回执，但它未核实：没有逐笔完成证明，无法证明这笔兑换已完成扣账。本次未重复扣账，也未改动原回执；如需兑换，请重新发起一笔新的兑换。",
    receipt,
    balance: row.profile.gold,
    balanceVersion: row.revision,
  };
}

// A settle/reconciliation failure inside the redemption path: the
// outcome is "not executed", stated as a typed busy — zero
// redemption writes happened, the requestId and the client's draft
// stay valid for a later retry.
function redemptionBusyResult(message: string): z.infer<typeof redeemRewardResponse> {
  return { forbidden: false, status: "busy", message, receipt: null, balance: null, balanceVersion: null };
}

// Durable arbitration between a terminal rejection and an in-flight
// success (CWEB-REDEEM-SAFE-001 P0-2): a rejection of THIS request is
// only terminal when the durable receipt table holds no receipt for
// its requestId at decision time. A same-requestId commit can land
// after this handler's replay read — a concurrent submit that fully
// committed while this handler was paused at a pre-validation read,
// the ledger SUM read, or its own settlement — and a rejection
// computed from the moved profile (version advanced, gold spent)
// would then falsely declare a completed redemption "not charged"
// and terminally clear the client's pending intent. So EVERY
// terminal rejection path re-reads the receipt as its last step:
// a receipt found there classifies the intent (verified same
// content → already_resolved with the original receipt; proof-less
// → unverified; different content → request_conflict) and the
// rejection is never emitted. Returns null only when no receipt
// exists at this final read, in which case the caller's rejection
// stands on the current stored state.
async function resolveCommittedReceipt(ctx: Ctx, args: RedeemRewardArgs): Promise<z.infer<typeof redeemRewardResponse> | null> {
  const receipt = await loadRedemptionByRequestId(ctx, args.requestId);
  if (!receipt) return null;
  const row = await loadGameStateRow(ctx);
  if (!sameRedemptionContent(receipt, args)) {
    return { forbidden: false, status: "request_conflict", message: "同一个请求编号已用于另一笔兑换，本次提交已拒绝，未扣账", receipt: null, balance: row.profile.gold, balanceVersion: row.revision };
  }
  if (receipt.verification !== "verified") {
    return unverifiedReceiptResult(receipt, row);
  }
  return { forbidden: false, status: "already_resolved", message: "这笔兑换已经完成，返回原回执，未重复扣账", receipt, balance: row.profile.gold, balanceVersion: row.revision };
}

// Truly read-only stored rewards state (S3 余项 follow-up): reads
// the profile row, the ledger SUM, the reward list, the receipts,
// and the goal — and writes NOTHING: no settlement, no profile save,
// no task spawn, no cache invalidation side effects. `ok` (and
// `reconciled`) is the stored state's own reconciliation fact, so a
// stored 0 that is reconciled reads as a true, verified zero while
// an unreconciled stored state reads ok:false with the goal, the
// list, and every receipt still present.
async function handleGetRewardsSnapshot(ctx: Ctx): Promise<z.infer<typeof getRewardsSnapshotResponse>> {
  if (!isOwner(ctx)) return { forbidden: true, ok: false, readOnly: true, reconciled: false, balance: 0, balanceVersion: 0, healthState: "missing", healthDataDate: null, coverageIncomplete: false, goalRewardId: null, rewards: [], receipts: [] };
  const db = ctx.db<typeof schema>();
  const healthLoad = await loadHealthSnapshot(ctx);
  const health = healthLoad.state === "ok" ? healthLoad.snapshot : null;
  const row = await loadGameStateRow(ctx);
  const totals = await db.select({ goldTotal: sql`COALESCE(SUM(${schema.gameSettlements.gold}), 0)` }).from(schema.gameSettlements);
  const ledgerGoldSum = Number(totals[0]?.goldTotal ?? 0);
  const reconciled = row.profile.goldInitialized
    && row.profile.goldLedgerSum !== null
    && row.profile.goldLedgerSum === ledgerGoldSum;
  const rewardRows = await db.select().from(schema.gameRewards).orderBy(asc(schema.gameRewards.id)).limit(100);
  const receiptRows = await db.select().from(schema.gameRewardRedemptions).orderBy(desc(schema.gameRewardRedemptions.id)).limit(50);
  const goalRewardId = await loadRewardGoalId(ctx);
  return {
    forbidden: false,
    ok: reconciled,
    readOnly: true,
    reconciled,
    balance: row.profile.gold,
    balanceVersion: row.revision,
    healthState: healthLoad.state,
    healthDataDate: health?.dataDate ?? null,
    coverageIncomplete: health?.coverageIncomplete ?? false,
    goalRewardId,
    rewards: rewardRows.map(rewardItemFromRow),
    receipts: receiptRows.map(rewardReceiptFromRow),
  };
}

async function handleSetRewardGoal(ctx: Ctx, args: { rewardId: number }): Promise<z.infer<typeof setRewardGoalResponse>> {
  if (!isOwner(ctx)) return { ok: false, forbidden: true, message: "仅所有者可设置下一奖励", goalRewardId: null };
  const db = ctx.db<typeof schema>();
  const rewardRows = await db.select({ id: schema.gameRewards.id }).from(schema.gameRewards).where(eq(schema.gameRewards.id, args.rewardId)).limit(1);
  if (!rewardRows[0]) {
    // Typed failure: the previously saved goal (if any) is returned
    // unchanged so the client keeps showing it — a failed save never
    // clears the current target.
    return { ok: false, forbidden: false, message: "这条奖励已不存在，下一奖励未保存", goalRewardId: await loadRewardGoalId(ctx) };
  }
  const now = new Date();
  await db.insert(schema.gameRewardGoal).values({ id: 1, rewardId: args.rewardId, createdAt: now, updatedAt: now })
    .onConflictDoUpdate({ target: schema.gameRewardGoal.id, set: { rewardId: args.rewardId, updatedAt: now } });
  ctx.invalidateQueries(["rewards"]);
  return { ok: true, forbidden: false, message: "已设为下一奖励", goalRewardId: args.rewardId };
}

async function handleSaveReward(ctx: Ctx, args: { id: number | null; name: string; price: number }): Promise<z.infer<typeof saveRewardResponse>> {
  if (!isOwner(ctx)) return { ok: false, forbidden: true, message: "仅所有者可管理奖励清单", reward: null };
  const name = args.name.trim();
  if (!name) return { ok: false, forbidden: false, message: "奖励名称不能为空", reward: null };
  const db = ctx.db<typeof schema>();
  const now = new Date();
  if (args.id === null) {
    const inserted = await db.insert(schema.gameRewards).values({ name, price: args.price, revision: 1, createdAt: now, updatedAt: now }).returning();
    const reward = inserted[0];
    if (!reward) return { ok: false, forbidden: false, message: "添加失败，请稍后再试", reward: null };
    ctx.invalidateQueries(["rewards"]);
    return { ok: true, forbidden: false, message: `已添加奖励「${name}」`, reward: rewardItemFromRow(reward) };
  }
  // Every save bumps the revision inside the same statement, so a
  // preview pinned to the old revision/price goes stale the moment the
  // owner edits the reward — an in-flight redemption can never charge
  // a price the owner no longer sees.
  const updated = await db.update(schema.gameRewards)
    .set({ name, price: args.price, revision: sql`${schema.gameRewards.revision} + 1`, updatedAt: now })
    .where(eq(schema.gameRewards.id, args.id))
    .returning();
  const reward = updated[0];
  if (!reward) return { ok: false, forbidden: false, message: "没有找到这条奖励，未保存", reward: null };
  ctx.invalidateQueries(["rewards"]);
  return { ok: true, forbidden: false, message: `已保存「${name}」（第 ${reward.revision} 版）`, reward: rewardItemFromRow(reward) };
}

async function handleRedeemReward(ctx: Ctx, args: RedeemRewardArgs): Promise<z.infer<typeof redeemRewardResponse>> {
  if (!isOwner(ctx)) return { forbidden: true, status: "forbidden", message: "仅所有者可兑换奖励", receipt: null, balance: null, balanceVersion: null };
  const db = ctx.db<typeof schema>();
  const todayLA = laTodayString();
  try {
    // (1) Replay first: a stored receipt under this requestId already
    // decided this intent — return it (same content, authoritatively
    // complete) or reject the key reuse (different content). A stored
    // receipt WITHOUT a completion proof decided nothing provable:
    // it classifies as unverified, never as a completed redemption.
    // Zero writes on every branch.
    const existing = await loadRedemptionByRequestId(ctx, args.requestId);
    if (existing) {
      const row = await loadGameStateRow(ctx);
      if (!sameRedemptionContent(existing, args)) {
        return { forbidden: false, status: "request_conflict", message: "同一个请求编号已用于另一笔兑换，本次提交已拒绝，未扣账", receipt: null, balance: row.profile.gold, balanceVersion: row.revision };
      }
      if (existing.verification !== "verified") {
        return unverifiedReceiptResult(existing, row);
      }
      return { forbidden: false, status: "already_resolved", message: "这笔兑换已经完成，返回原回执，未重复扣账", receipt: existing, balance: row.profile.gold, balanceVersion: row.revision };
    }
    // (2) Pre-validation against stored state, before any write of
    // this request: the reward pin (revision + price) and the balance
    // pin (expected version) must still match what the preview showed,
    // and the SAVED balance must cover the price. Every rejection here
    // writes nothing at all.
    const rewardRows = await db.select().from(schema.gameRewards).where(eq(schema.gameRewards.id, args.rewardId)).limit(1);
    const reward = rewardRows[0];
    const stored = await loadGameStateRow(ctx);
    // Every rejection below passes the durable arbitration first
    // (P0-2): the profile just read may have been moved by a
    // same-requestId commit that landed after the replay read — in
    // that case the intent is already resolved, not rejected.
    if (!reward) {
      const resolved = await resolveCommittedReceipt(ctx, args);
      if (resolved) return resolved;
      return { forbidden: false, status: "reward_not_found", message: "这条奖励已不存在，未扣账", receipt: null, balance: stored.profile.gold, balanceVersion: stored.revision };
    }
    if (reward.revision !== args.rewardRevision || reward.price !== args.price) {
      const resolved = await resolveCommittedReceipt(ctx, args);
      if (resolved) return resolved;
      return { forbidden: false, status: "stale", message: "奖励的名称或价格已经变化，未扣账；请重新预览确认", receipt: null, balance: stored.profile.gold, balanceVersion: stored.revision };
    }
    if (stored.revision !== args.expectedBalanceVersion) {
      const resolved = await resolveCommittedReceipt(ctx, args);
      if (resolved) return resolved;
      return { forbidden: false, status: "stale", message: "金币余额已经变化，未扣账；请重新预览确认", receipt: null, balance: stored.profile.gold, balanceVersion: stored.revision };
    }
    if (stored.profile.goldInitialized && stored.profile.gold < args.price) {
      const resolved = await resolveCommittedReceipt(ctx, args);
      if (resolved) return resolved;
      return { forbidden: false, status: "insufficient_funds", message: `金币不足：兑换需要 ${args.price} 金币，已保存余额 ${stored.profile.gold}，还差 ${args.price - stored.profile.gold} 金币，未扣账`, receipt: null, balance: stored.profile.gold, balanceVersion: stored.revision };
    }
    // The confirmed pin, captured from the state step (2) just
    // validated. The commit loop's first read is verified against the
    // commit base derived from this pin (below), so the confirmation
    // is checked across the whole commit scope — not only at this
    // pre-read.
    const pin = { revision: stored.revision, gold: stored.profile.gold, goldLedgerSum: stored.profile.goldLedgerSum };
    // (3) Settle, so any gold a failed settlement save stranded in the
    // ledger is reconciled into the balance before the redemption
    // validates funds. Skipped when the stored watermark already
    // equals the ledger gold SUM: settlement then could not move the
    // balance — it would only re-write the profile, advancing the
    // revision and staling this very confirmation (a same-requestId
    // retry after a busy result must survive its own first attempt's
    // pin).
    const storedLedgerTotals = await db.select({ goldTotal: sql`COALESCE(SUM(${schema.gameSettlements.gold}), 0)` }).from(schema.gameSettlements);
    const storedLedgerGoldSum = Number(storedLedgerTotals[0]?.goldTotal ?? 0);
    // Pin revalidation at the pause point: the ledger SUM read above
    // is a real suspension point — a competing write (a purchase, a
    // settlement save, another redemption) can land between the step
    // (2) pin check and the first commit attempt. Re-read the profile
    // NOW: if the balance version, the balance, or the watermark
    // moved since the pin, the confirmation no longer describes the
    // stored state — reject it as stale with zero redemption writes,
    // before any settlement or commit of ours can absorb the change.
    const pinCheck = await loadGameStateRow(ctx);
    if (pinCheck.revision !== pin.revision || pinCheck.profile.gold !== pin.gold || pinCheck.profile.goldLedgerSum !== pin.goldLedgerSum) {
      // The mover may be this very intent's own concurrent commit
      // (P0-2): arbitrate against the durable receipt before
      // declaring the confirmation stale.
      const resolved = await resolveCommittedReceipt(ctx, args);
      if (resolved) return resolved;
      return { forbidden: false, status: "stale", message: "金币余额已经变化，未扣账；请重新预览确认", receipt: null, balance: pinCheck.profile.gold, balanceVersion: pinCheck.revision };
    }
    // The state the commit loop's first attempt must start from: the
    // pin itself, or — when this handler's own settlement runs — the
    // post-settle state that settlement legitimately produced. Only
    // THIS handler's settlement is entitled to advance the base; any
    // other movement before the first attempt is caught by the loop's
    // first-read comparison against this base.
    let commitBase = pin;
    const settleNeeded = !pinCheck.profile.goldInitialized
      || pinCheck.profile.goldLedgerSum === null
      || pinCheck.profile.goldLedgerSum !== storedLedgerGoldSum;
    if (settleNeeded) {
      const healthLoad = await loadHealthSnapshot(ctx);
      const strengthLoad = await loadStrengthSnapshot(ctx);
      const health = healthLoad.state === "ok" ? healthLoad.snapshot : null;
      const strength = effectiveStrength(healthLoad, strengthLoad);
      let settled: Awaited<ReturnType<typeof settleGame>>;
      try {
        // Redeem-bound settle: the confirmed pin heads the settle's
        // provable advancement chain, so an external balance/version
        // advancement landing anywhere before or during this settle
        // (before its first read, after the read but before its CAS,
        // or in a CAS-failure re-read) aborts the settle instead of
        // being absorbed by its CAS retry and endorsed as if the
        // owner had confirmed it.
        settled = await settleGame(ctx, health, strength, todayLA, pin);
      } catch (error) {
        if (isSettlementPinMovedError(error)) {
          // The confirmation was overtaken by an external write the
          // settle refused to endorse. The mover may still be this
          // very intent's own concurrent commit (P0-2): arbitrate
          // against the durable receipt first; only a key with no
          // receipt anywhere is rejected as stale. Zero redemption
          // writes on this path either way.
          const resolved = await resolveCommittedReceipt(ctx, args);
          if (resolved) return resolved;
          const current = await loadGameStateRow(ctx);
          return { forbidden: false, status: "stale", message: "金币余额已经变化，未扣账；请重新预览确认", receipt: null, balance: current.profile.gold, balanceVersion: current.revision };
        }
        // Reconciliation gate: a failed settlement means the stored
        // balance cannot be certified against the ledger. The
        // redemption must NOT proceed on the pre-settle numbers (it
        // would spend gold the ledger says is already gone, and a
        // later settlement would floor the overdraft away). Zero
        // redemption writes; the intent stays retryable as-is.
        return redemptionBusyResult("金币结算没有完成，余额尚未对账，本次兑换未执行、未扣账；请稍后用同一请求重试。");
      }
      // The settlement's own books must reconcile: the watermark it
      // committed is the ledger SUM it reconciled against in the
      // same attempt. (Both values come from the settlement's
      // return — its own committed result — never from a later
      // re-read of the profile.)
      if (!settled.profile.goldInitialized || settled.committedGoldLedgerSum === null || settled.committedGoldLedgerSum !== settled.committedLedgerGoldSum) {
        return redemptionBusyResult("金币余额与账本仍不一致，本次兑换未执行、未扣账；请稍后用同一请求重试确认。");
      }
      // Post-settle reconciliation proof: the stored watermark must
      // now equal the ledger gold SUM exactly. Any residual mismatch
      // (a save that reported success without reconciling, or a
      // ledger flow that landed after the settlement's own SUM
      // read) aborts the redemption the same way — typed busy, zero
      // writes. This re-read is a GATE ONLY: it never feeds the
      // commit base below.
      const afterSettle = await loadGameStateRow(ctx);
      const settledTotals = await db.select({ goldTotal: sql`COALESCE(SUM(${schema.gameSettlements.gold}), 0)` }).from(schema.gameSettlements);
      const settledLedgerGoldSum = Number(settledTotals[0]?.goldTotal ?? 0);
      if (!afterSettle.profile.goldInitialized || afterSettle.profile.goldLedgerSum === null || afterSettle.profile.goldLedgerSum !== settledLedgerGoldSum) {
        return redemptionBusyResult("金币余额与账本仍不一致，本次兑换未执行、未扣账；请稍后用同一请求重试确认。");
      }
      // P0-1: the commit base is EXACTLY what this handler's own
      // settlement committed — the revision, balance, and watermark
      // its CAS save landed — taken from the settlement's return
      // value. It is never the post-settle re-read above: an
      // external write landing after the settlement's save (gold
      // moved, revision advanced) would otherwise be absorbed into
      // the base and the old confirmation would charge straight
      // over it. With the base fixed at the settlement's own
      // commit, the commit loop's first-read movement check sees
      // that external write for what it is and rejects the old
      // confirmation as stale with zero redemption writes.
      commitBase = { revision: settled.committedRevision, gold: settled.committedGold, goldLedgerSum: settled.committedGoldLedgerSum };
    }
    // (4) The redemption itself, as ONE atomic batch
    // (CWEB-REDEEM-SAFE-001). Each attempt re-reads the freshest
    // stored state, re-classifies from it (a receipt that landed
    // meanwhile resolves or conflicts this intent; a moved reward pin
    // is stale; a balance the winner already spent down is
    // insufficient), and then submits a single db.batch whose three
    // statements stand or fall together, chained so each can only
    // land on top of the previous one IN THIS BATCH:
    //   a. receipt insert — INSERT … SELECT from game_state guarded
    //      on the exact PRE-commit state just read (revision, gold,
    //      watermark, gold ≥ price) and on the reward pin still
    //      holding (an EXISTS over the reward row at the pinned
    //      revision + price, evaluated inside the batch — a
    //      rename/reprice landing after the final pre-read still
    //      rejects the old confirmation). A competing commit always
    //      MOVES that state, so it can never satisfy this guard for
    //      the loser — no timestamp or clock value is trusted as a
    //      discriminator anywhere in the chain;
    //   b. profile CAS deduction — gold −price, watermark −price,
    //      revision +1, under the same pre-state guards AND an
    //      EXISTS on this batch's own receipt row (a), so the
    //      deduction can only follow its own receipt insert, never
    //      a foreign one, and can never overdraw or floor at 0;
    //   c. reward_redeem ledger flow — INSERT … SELECT from the
    //      redemptions table for this requestId, additionally gated
    //      on SQLite changes() > 0, i.e. statement (b) having
    //      actually modified the profile on this connection in
    //      this batch — a same-key winner's receipt alone can never
    //      book a second flow — accumulating −price into the one
    //      (date, category, detail) row on conflict.
    // A failed batch (any statement erroring, a locked or stale
    // snapshot under contention) commits NOTHING — the attempt
    // loops, re-reads, and classifies from the winner's state; the
    // fully old state survives and the intent stays resolvable by
    // the same requestId. A batch whose guards all miss also writes
    // nothing. And if the balance itself moved under the attempt
    // (the winner spent or credited gold), the old confirmation is
    // rejected as stale rather than silently re-based. The loop's
    // movement check starts from the commit base (the pin, advanced
    // only by this handler's own settlement), so the FIRST attempt
    // is verified exactly like every later one: an external write
    // that moved the balance version, the balance, or the watermark
    // anywhere before the first attempt — including in the pause at
    // the ledger SUM read — rejects the old confirmation instead of
    // letting the loop silently re-base onto the moved state.
    let lastAttemptRead: { revision: number; gold: number; goldLedgerSum: number | null } = { revision: commitBase.revision, gold: commitBase.gold, goldLedgerSum: commitBase.goldLedgerSum };
    for (let attempt = 0; attempt < PROFILE_CAS_ATTEMPTS; attempt++) {
      const row = await loadGameStateRow(ctx);
      // A same-intent commit may have landed while this attempt was
      // being prepared (concurrent submit, or a retry racing the
      // original): classify from the stored receipt before writing
      // anything.
      const raced = await loadRedemptionByRequestId(ctx, args.requestId);
      if (raced) {
        if (!sameRedemptionContent(raced, args)) {
          return { forbidden: false, status: "request_conflict", message: "同一个请求编号已用于另一笔兑换，本次提交已拒绝，未扣账", receipt: null, balance: row.profile.gold, balanceVersion: row.revision };
        }
        if (raced.verification !== "verified") {
          return unverifiedReceiptResult(raced, row);
        }
        return { forbidden: false, status: "already_resolved", message: "这笔兑换已经完成，返回原回执，未重复扣账", receipt: raced, balance: row.profile.gold, balanceVersion: row.revision };
      }
      if (row.revision !== lastAttemptRead.revision
        || row.profile.gold !== lastAttemptRead.gold
        || row.profile.goldLedgerSum !== lastAttemptRead.goldLedgerSum) {
        // The balance version, balance, or watermark moved after
        // the commit base this handler is entitled to (a competing
        // commit spent gold, a settlement credited new gold, or any
        // other external write): the pinned confirmation no longer
        // describes the balance — reject it instead of re-basing
        // the charge. But the mover may be THIS intent's own
        // concurrent commit landing between the raced-receipt read
        // above and this read (P0-2): the durable arbitration gets
        // the last word before any terminal rejection.
        const resolved = await resolveCommittedReceipt(ctx, args);
        if (resolved) return resolved;
        return { forbidden: false, status: "stale", message: "金币余额已经变化，未扣账；请重新预览确认", receipt: null, balance: row.profile.gold, balanceVersion: row.revision };
      }
      const freshRewardRows = await db.select().from(schema.gameRewards).where(eq(schema.gameRewards.id, args.rewardId)).limit(1);
      const freshReward = freshRewardRows[0];
      if (!freshReward) {
        const resolved = await resolveCommittedReceipt(ctx, args);
        if (resolved) return resolved;
        return { forbidden: false, status: "reward_not_found", message: "这条奖励已不存在，未扣账", receipt: null, balance: row.profile.gold, balanceVersion: row.revision };
      }
      if (freshReward.revision !== args.rewardRevision || freshReward.price !== args.price) {
        const resolved = await resolveCommittedReceipt(ctx, args);
        if (resolved) return resolved;
        return { forbidden: false, status: "stale", message: "奖励的名称或价格已经变化，未扣账；请重新预览确认", receipt: null, balance: row.profile.gold, balanceVersion: row.revision };
      }
      const profile = row.profile;
      if (!profile.goldInitialized || profile.goldLedgerSum === null) {
        return { forbidden: false, status: "busy", message: "金币账本尚未就绪，未扣账；请稍后再试", receipt: null, balance: profile.gold, balanceVersion: row.revision };
      }
      if (profile.gold < args.price) {
        const resolved = await resolveCommittedReceipt(ctx, args);
        if (resolved) return resolved;
        return { forbidden: false, status: "insufficient_funds", message: `金币不足：兑换需要 ${args.price} 金币，已保存余额 ${profile.gold}，还差 ${args.price - profile.gold} 金币，未扣账`, receipt: null, balance: profile.gold, balanceVersion: row.revision };
      }
      const readRevision = row.revision;
      const readGold = profile.gold;
      const readWatermark = profile.goldLedgerSum;
      const balanceAfter = readGold - args.price;
      const watermarkAfter = readWatermark - args.price;
      const now = new Date();
      const nowMs = now.getTime();
      // The receipt insert also records the completion proof: the
      // watermark this very batch produces (watermarkAfter). The
      // value is written only here, inside the atomic batch, so a
      // stored proof proves per-request that the deduction and the
      // ledger flow committed with this receipt.
      const receiptInsert = db.insert(schema.gameRewardRedemptions).select(sql`
        SELECT NULL, ${args.requestId}, ${freshReward.id}, ${freshReward.name}, ${args.price}, ${args.rewardRevision}, ${args.expectedBalanceVersion}, ${args.price}, ${balanceAfter}, ${todayLA}, ${nowMs}, ${watermarkAfter}
        FROM ${schema.gameState}
        WHERE ${schema.gameState.id} = 1 AND COALESCE(${schema.gameState.revision}, 0) = ${readRevision} AND ${schema.gameState.gold} = ${readGold} AND ${schema.gameState.gold} >= ${args.price} AND ${schema.gameState.goldLedgerSum} = ${readWatermark}
          AND EXISTS (SELECT 1 FROM ${schema.gameRewards} WHERE ${schema.gameRewards.id} = ${freshReward.id} AND ${schema.gameRewards.revision} = ${args.rewardRevision} AND ${schema.gameRewards.price} = ${args.price})
      `);
      const casDeduction = db.update(schema.gameState)
        .set({
          gold: sql`${schema.gameState.gold} - ${args.price}`,
          goldLedgerSum: sql`${schema.gameState.goldLedgerSum} - ${args.price}`,
          revision: sql`COALESCE(${schema.gameState.revision}, 0) + 1`,
          updatedAt: now,
        })
        .where(and(
          eq(schema.gameState.id, 1),
          sql`COALESCE(${schema.gameState.revision}, 0) = ${readRevision}`,
          sql`${schema.gameState.gold} = ${readGold}`,
          sql`${schema.gameState.gold} >= ${args.price}`,
          sql`${schema.gameState.goldLedgerSum} = ${readWatermark}`,
          sql`EXISTS (SELECT 1 FROM ${schema.gameRewardRedemptions} WHERE ${schema.gameRewardRedemptions.requestId} = ${args.requestId})`,
        ));
      const ledgerInsert = db.insert(schema.gameSettlements).select(sql`
        SELECT ${todayLA}, 'reward_redeem', ${String(freshReward.id)}, 0, ${-args.price}, ${GAME_RULE_VERSION}, ${todayLA}, NULL, ${nowMs}
        FROM ${schema.gameRewardRedemptions}
        WHERE ${schema.gameRewardRedemptions.requestId} = ${args.requestId} AND (SELECT changes()) > 0
      `).onConflictDoUpdate({
        target: [schema.gameSettlements.localDate, schema.gameSettlements.category, schema.gameSettlements.detail],
        set: { gold: sql`${schema.gameSettlements.gold} - ${args.price}` },
      });
      lastAttemptRead = { revision: readRevision, gold: readGold, goldLedgerSum: readWatermark };
      let casRowsAffected = 0;
      try {
        const batchResults = await db.batch([receiptInsert, casDeduction, ledgerInsert]);
        casRowsAffected = Number((batchResults[1] as { rowsAffected?: number } | undefined)?.rowsAffected ?? 0);
      } catch {
        // The batch committed nothing (a statement failed, or the
        // snapshot went stale under a competing commit). Loop: the
        // next read classifies from the winner's stored state — a
        // landed same-key receipt resolves there, a moved balance
        // or pin rejects there — instead of failing the whole call.
        continue;
      }
      // The stored receipt is the only success oracle: it exists
      // after the batch only when the deduction, the watermark
      // advance, and the ledger flow committed with it (this batch),
      // or when a same-intent commit landed concurrently (classified
      // by content like any replay). The CAS statement's own
      // rowsAffected says whether THIS batch performed the deduction.
      const receipt = await loadRedemptionByRequestId(ctx, args.requestId);
      if (receipt) {
        if (!sameRedemptionContent(receipt, args)) {
          const current = await loadGameStateRow(ctx);
          return { forbidden: false, status: "request_conflict", message: "同一个请求编号已用于另一笔兑换，本次提交已拒绝，未扣账", receipt: null, balance: current.profile.gold, balanceVersion: current.revision };
        }
        if (receipt.verification !== "verified") {
          // A same-content receipt without a completion proof is a
          // legacy row, not this batch's product (this batch always
          // writes the proof) — never certify it as resolved.
          const current = await loadGameStateRow(ctx);
          return unverifiedReceiptResult(receipt, current);
        }
        const fresh = await loadGameStateRow(ctx);
        const ours = casRowsAffected === 1
          && fresh.profile.gold === receipt.balanceAfter
          && fresh.profile.goldLedgerSum === watermarkAfter;
        ctx.invalidateQueries(["rewards"]);
        ctx.invalidateQueries(["game"]);
        return {
          forbidden: false,
          status: ours ? "redeemed" : "already_resolved",
          message: ours ? `已兑换「${freshReward.name}」，扣除 ${args.price} 金币` : "这笔兑换已经完成，返回原回执，未重复扣账",
          receipt, balance: fresh.profile.gold, balanceVersion: fresh.revision,
        };
      }
      // No receipt after the batch: every guard missed, so this
      // attempt wrote nothing at all. Loop — the next read
      // classifies from the winner's state (or retries on top of
      // it when the intent is still fulfillable).
    }
    return { forbidden: false, status: "busy", message: "存档正忙，兑换结果未确认；请用同一请求查询回执或重试，不要换新请求重复兑换", receipt: null, balance: null, balanceVersion: null };
  } catch {
    return { forbidden: false, status: "busy", message: "兑换处理失败；若请求已经提交，请用同一请求查询回执确认结果，不要换新请求重复兑换", receipt: null, balance: null, balanceVersion: null };
  }
}

async function handleGetRedemptionReceipt(ctx: Ctx, args: { requestId: string }): Promise<z.infer<typeof getRedemptionReceiptResponse>> {
  if (!isOwner(ctx)) return { forbidden: true, found: false, receipt: null };
  const receipt = await loadRedemptionByRequestId(ctx, args.requestId);
  return { forbidden: false, found: receipt !== null, receipt };
}

export const Actions = {
  getDashboard: defineAction({
    request: z.object({}), response: getDashboardResponse,
    async handler(ctx): Promise<z.infer<typeof getDashboardResponse>> {
      if (!isOwner(ctx)) return { forbidden: true, snapshot: null, readiness: null, readinessHistory: [], strengthSyncTaskId: null, dataStatus: null, unifiedTimeline: [], healthState: "missing", strengthState: "missing", strength: null };
      // Independent per-source loads (H-SOURCE-001): each snapshot is read
      // and validated on its own, so a missing or corrupt health snapshot
      // can no longer swallow a valid strength snapshot (or vice versa),
      // and no parse failure can drop the whole response into a catch-all.
      const healthLoad = await loadHealthSnapshot(ctx);
      const strengthLoad = await loadStrengthSnapshot(ctx);
      const strength = effectiveStrength(healthLoad, strengthLoad);
      // Strength data is local to a sibling artifact and changes as soon
      // as the user logs a set there; every owner open kicks off (or
      // reuses) a background re-sync — on every path, including when the
      // health snapshot is missing or corrupt — and hands its task id to
      // the client, which polls it to completion and repaints.
      const strengthSyncTaskId = await maybeAutoSyncStrength(ctx);
      const logs = await loadRecentLogs(ctx);
      const dataStatus = buildDataStatus(healthLoad, strengthLoad, logs);
      const unifiedTimeline = buildUnifiedTimeline(healthLoad.snapshot, strength);
      if (healthLoad.state !== "ok" || !healthLoad.snapshot) {
        // Never fabricate a health snapshot: snapshot and readiness stay
        // null, while the strength side is returned exactly as it loaded.
        return { forbidden: false, snapshot: null, readiness: null, readinessHistory: [], strengthSyncTaskId, dataStatus, unifiedTimeline, healthState: healthLoad.state, strengthState: strengthLoad.state, strength };
      }
      const health = healthLoad.snapshot;
      // Merge for the combined views: a valid standalone strength snapshot
      // overrides the embedded copy; a corrupt standalone row is replaced
      // with an honest empty placeholder instead of the stale embedded data.
      let snapshot = health;
      if (strengthLoad.state === "ok" && strengthLoad.strength) {
        snapshot = { ...health, strengthTraining: strengthLoad.strength };
      } else if (strengthLoad.state === "corrupt") {
        snapshot = { ...health, strengthTraining: CORRUPT_STRENGTH_PLACEHOLDER };
      }
      // Morning check-in is read only when the health snapshot is usable.
      const readinessDate = health.morningReference?.date ?? shiftDate(health.dataDate, 1);
      const db = ctx.db<typeof schema>();
      const checkinRows = await db.select({ feeling: schema.morningCheckin.feeling, updatedAt: schema.morningCheckin.updatedAt, revision: schema.morningCheckin.revision }).from(schema.morningCheckin).where(eq(schema.morningCheckin.date, readinessDate)).limit(1);
      const morningFeeling = checkinRows[0]?.feeling ?? null;
      // Bind the check-in INPUT VERSION at the same read instant as the
      // feeling (H-ARCHIVE-SAFE-001 race fix): the row's updated_at as
      // read here travels with the computed score into the archive
      // arbitration, so a request that read an older check-in can never
      // overwrite a score archived from a newer one — even under the
      // same health snapshot version. Null when no check-in row exists.
      const checkinVersion = checkinRows[0] ? checkinRows[0].updatedAt.toISOString() : null;
      // The NUMERIC revision bound at that same read (H-ARCHIVE-SAFE-001
      // follow-up) is what the archive arbitration now judges freshness
      // by: updated_at cannot order two saves that landed in the same
      // millisecond, the revision can. Null when no check-in row exists,
      // and also null for a legacy row saved before revisions existed —
      // both count as the oldest input in the arbitration.
      const checkinRevision = checkinRows[0]?.revision ?? null;
      const readiness = calculateReadiness(snapshot, readinessDate, morningFeeling);
      // Archive the score exactly as computed now (H-LOAD-001): this is
      // the only place readiness is ever computed, so archiving here
      // covers both manual opens and the daily refresh's reads. The
      // archive write is failure-isolated (see archiveReadiness) — the
      // response below is returned regardless — and the trend is then
      // read back from the archive alone, so today's point is the
      // archived value and every unarchived date stays a gap. The LA
      // today gate (H-ARCHIVE-SAFE-001) means opening the dashboard on a
      // stale snapshot archives nothing: only the readiness actually
      // displayed for LA today is recorded.
      await archiveReadiness(ctx, readiness, health.updatedAt, checkinVersion, checkinRevision, laTodayString());
      const readinessHistory = await loadReadinessTrendPoints(ctx, readinessDate);
      return { forbidden: false, snapshot, readiness, readinessHistory, strengthSyncTaskId, dataStatus, unifiedTimeline, healthState: healthLoad.state, strengthState: strengthLoad.state, strength };
    },
  }),

  // LIFE-C1 人生游戏 (CWEB-MVP-001·S1 + S2): settles XP/gold from the
  // health summary on open and returns the full character state
  // (attributes, gold, equipment, daily tasks). STRICT owner
  // gate — the game reads health-derived data, so it never rides the
  // L0.1 sync-channel exception. Fully failure-isolated: any error in
  // the game layer is caught here and returned as ok:false, so it can
  // never break getDashboard or the health views.
  getGameState: defineAction({
    request: z.object({}), response: getGameStateResponse,
    async handler(ctx): Promise<z.infer<typeof getGameStateResponse>> {
      const todayLA = laTodayString();
      const emptyQuest: z.infer<typeof gameQuestSchema> = { date: todayLA, targetSteps: GAME_QUEST_TARGET_STEPS, steps: null, rewardXp: GAME_QUEST_REWARD_XP, state: "missing" };
      const emptyProfile = defaultGameProfile();
      const empty = {
        ruleVersion: GAME_RULE_VERSION, totalXp: 0, level: 1, xpIntoLevel: 0, xpPerLevel: GAME_XP_PER_LEVEL, xpToNextLevel: GAME_XP_PER_LEVEL, settledThroughDate: null,
        gold: 0, attributes: emptyProfile.attributes, unspentPoints: 0, attrPointsEarned: 0,
        domainBonuses: (["steps", "sleep", "strength", "quest_steps"] as GameDomain[]).map((domain) => ({ domain, attrPct: 0, equipPct: 0 })),
        goldBonusPct: 0,
        equipment: GAME_EQUIPMENT.map((def) => ({ id: def.id, name: def.name, slot: def.slot, effectLabel: equipmentEffectLabel(def), price: def.price, obtain: def.obtain, obtainNote: def.obtain === "task" ? "完成每日任务「主睡眠 ≥ 7.5 小时」获得" : "金币购买", owned: false, equipped: false })),
        dailyTasks: GAME_DAILY_TASKS.map((def) => ({ id: def.id, label: def.label, targetLabel: def.targetLabel, progress: null, progressLabel: "数据尚未同步", target: def.target, state: "missing" as const, rewardXp: def.rewardXp, rewardGold: def.rewardGold })),
        quest: emptyQuest, settlements: [], previews: [],
      };
      if (!isOwner(ctx)) return { forbidden: true, ok: false, healthState: "missing", ...empty };
      try {
        const healthLoad = await loadHealthSnapshot(ctx);
        const strengthLoad = await loadStrengthSnapshot(ctx);
        const strength = effectiveStrength(healthLoad, strengthLoad);
        const health = healthLoad.state === "ok" ? healthLoad.snapshot : null;
        // Settlement owns the profile read/write cycle (CAS + watermark
        // reconciliation, see settleGame); the response below is built
        // from the profile exactly as persisted by the winning attempt,
        // and the preview plan is computed from that same profile, so
        // what the page shows is always re-readable state.
        const settled = await settleGame(ctx, health, strength, todayLA);
        const profile = settled.profile;
        const plan = buildGamePlan(health, strength, todayLA, profile);
        const db = ctx.db<typeof schema>();
        // A preview whose (date, category) is already booked — possible
        // when a later snapshot's complete window moved backwards — is
        // dropped instead of double-showing as both settled and pending.
        let previews = plan.previews;
        if (previews.length) {
          const previewDates = [...new Set(previews.map((preview) => preview.localDate))];
          const booked = await db.select({ localDate: schema.gameSettlements.localDate, category: schema.gameSettlements.category })
            .from(schema.gameSettlements).where(inArray(schema.gameSettlements.localDate, previewDates));
          const bookedKeys = new Set(booked.map((row) => `${row.localDate}|${row.category}`));
          previews = previews.filter((preview) => !bookedKeys.has(`${preview.localDate}|${preview.category}`));
        }
        const todaySteps = health?.historyDaily.find((row) => row.date === todayLA)?.steps ?? null;
        const todayBooked = await db.select({ category: schema.gameSettlements.category }).from(schema.gameSettlements).where(eq(schema.gameSettlements.localDate, todayLA));
        const questState: z.infer<typeof gameQuestSchema>["state"] = todayBooked.some((row) => row.category === "quest_steps")
          ? "settled"
          : todaySteps === null ? "missing" : todaySteps >= GAME_QUEST_TARGET_STEPS ? "achieved" : "in_progress";
        const level = Math.floor(settled.totalXp / GAME_XP_PER_LEVEL) + 1;
        const xpIntoLevel = settled.totalXp % GAME_XP_PER_LEVEL;
        return {
          forbidden: false,
          ok: true,
          healthState: healthLoad.state,
          ruleVersion: GAME_RULE_VERSION,
          totalXp: settled.totalXp,
          level,
          xpIntoLevel,
          xpPerLevel: GAME_XP_PER_LEVEL,
          xpToNextLevel: GAME_XP_PER_LEVEL - xpIntoLevel,
          settledThroughDate: settled.settledThroughDate,
          gold: profile.gold,
          attributes: profile.attributes,
          unspentPoints: unspentPoints(profile),
          attrPointsEarned: profile.attrPointsEarned,
          domainBonuses: (["steps", "sleep", "strength", "quest_steps"] as GameDomain[]).map((domain) => ({ domain, attrPct: attrBonusPct(profile, domain), equipPct: equipBonusPct(profile, domain) })),
          goldBonusPct: equipBonusPct(profile, "gold"),
          equipment: GAME_EQUIPMENT.map((def) => ({
            id: def.id, name: def.name, slot: def.slot, effectLabel: equipmentEffectLabel(def), price: def.price, obtain: def.obtain,
            obtainNote: def.obtain === "task" ? "完成每日任务「主睡眠 ≥ 7.5 小时」获得" : "金币购买",
            owned: profile.owned.includes(def.id),
            equipped: profile.equipped[def.slot] === def.id,
          })),
          dailyTasks: settled.dailyTasks,
          quest: { date: todayLA, targetSteps: GAME_QUEST_TARGET_STEPS, steps: todaySteps, rewardXp: GAME_QUEST_REWARD_XP, state: questState },
          settlements: settled.ledger,
          previews,
        };
      } catch {
        return { forbidden: false, ok: false, healthState: "missing", ...empty };
      }
    },
  }),

  // LIFE-C1 S2: allocate attribute points. STRICT owner gate. Points come
  // only from levels already earned (attrPointsEarned is backfilled from
  // total XP during settlement); allocation is permanent in v1 (no
  // respec) and affects only settlements booked afterwards.
  allocateAttribute: defineAction({
    request: z.object({ attribute: gameAttributeSchema, count: z.number().int().min(1).max(50) }),
    response: gameMutationResponse,
    async handler(ctx, args): Promise<z.infer<typeof gameMutationResponse>> {
      if (!isOwner(ctx)) return { ok: false, forbidden: true, message: "仅所有者可分配属性点" };
      try {
        const result = await updateGameProfile(ctx, (profile) => applyAllocation(profile, args.attribute, args.count));
        if (!result.ok) return { ok: false, forbidden: false, message: result.message };
        ctx.invalidateQueries(["game"]);
        return { ok: true, forbidden: false, message: `已分配 ${args.count} 点到${GAME_ATTRIBUTE_LABELS[args.attribute]}，剩余 ${unspentPoints(result.profile)} 点` };
      } catch {
        return { ok: false, forbidden: false, message: "分配失败，请稍后再试" };
      }
    },
  }),

  // LIFE-C1 S2: buy a catalog item with gold. STRICT owner gate. No real
  // payment anywhere — gold is minted only by XP settlements and daily
  // tasks.
  buyEquipment: defineAction({
    request: z.object({ itemId: z.string().min(1) }),
    response: gameMutationResponse,
    async handler(ctx, args): Promise<z.infer<typeof gameMutationResponse>> {
      if (!isOwner(ctx)) return { ok: false, forbidden: true, message: "仅所有者可购买装备" };
      try {
        const def = GAME_EQUIPMENT_BY_ID.get(args.itemId);
        if (!def) return { ok: false, forbidden: false, message: "没有这件装备" };
        if (def.obtain === "task" || def.price === null) return { ok: false, forbidden: false, message: `${def.name} 不能购买：${def.obtain === "task" ? "完成每日任务「主睡眠 ≥ 7.5 小时」即可获得" : "只能通过其他方式获得"}` };
        // Balance check, deduction and ownership all happen inside one
        // CAS-retried draft (applyPurchase), so the charge and the item
        // land in the same single write — or, on insufficient gold /
        // already owned, in no write at all.
        const result = await updateGameProfile(ctx, (profile) => applyPurchase(profile, def));
        if (!result.ok) return { ok: false, forbidden: false, message: result.message };
        ctx.invalidateQueries(["game"]);
        return { ok: true, forbidden: false, message: `已购买${def.name}，花费 ${def.price} 金币` };
      } catch {
        return { ok: false, forbidden: false, message: "购买失败，请稍后再试" };
      }
    },
  }),

  // LIFE-C1 S2: equip an owned item into its slot (one item per slot;
  // equipping replaces whatever the slot held). STRICT owner gate.
  equipItem: defineAction({
    request: z.object({ itemId: z.string().min(1) }),
    response: gameMutationResponse,
    async handler(ctx, args): Promise<z.infer<typeof gameMutationResponse>> {
      if (!isOwner(ctx)) return { ok: false, forbidden: true, message: "仅所有者可装备" };
      try {
        const def = GAME_EQUIPMENT_BY_ID.get(args.itemId);
        if (!def) return { ok: false, forbidden: false, message: "没有这件装备" };
        const result = await updateGameProfile(ctx, (profile) => applyEquip(profile, def));
        if (!result.ok) return { ok: false, forbidden: false, message: result.message };
        ctx.invalidateQueries(["game"]);
        return { ok: true, forbidden: false, message: `已装备${def.name}（${GAME_SLOT_LABELS[def.slot]}）` };
      } catch {
        return { ok: false, forbidden: false, message: "装备失败，请稍后再试" };
      }
    },
  }),

  // LIFE-C1 S2: unequip a slot. STRICT owner gate.
  unequipItem: defineAction({
    request: z.object({ slot: z.enum(["weapon", "armor", "accessory"]) }),
    response: gameMutationResponse,
    async handler(ctx, args): Promise<z.infer<typeof gameMutationResponse>> {
      if (!isOwner(ctx)) return { ok: false, forbidden: true, message: "仅所有者可卸下装备" };
      try {
        const result = await updateGameProfile(ctx, (profile) => applyUnequip(profile, args.slot));
        if (!result.ok) return { ok: false, forbidden: false, message: result.message };
        ctx.invalidateQueries(["game"]);
        return { ok: true, forbidden: false, message: `已卸下${GAME_SLOT_LABELS[args.slot]}` };
      } catch {
        return { ok: false, forbidden: false, message: "卸下失败，请稍后再试" };
      }
    },
  }),

  // LIFE-C1 S3: the self-set reward list + saved balance + receipts.
  // STRICT owner gate (see the S3 section above). Settles on read like
  // getGameState; on settlement failure the list and receipts still
  // return from stored state with ok:false.
  getRewards: defineAction({
    request: z.object({}), response: getRewardsResponse, handler: handleGetRewards,
  }),

  // LIFE-C1 S3: the truly read-only stored rewards state — no
  // settlement, no save, no task spawn. Used by the goal card's and
  // the recovery flow's 只读重查. STRICT owner gate.
  getRewardsSnapshot: defineAction({
    request: z.object({}), response: getRewardsSnapshotResponse, handler: handleGetRewardsSnapshot,
  }),

  // LIFE-C1 S3: create or edit one reward (name + positive gold price).
  // Every save bumps the reward's revision. STRICT owner gate.
  saveReward: defineAction({
    request: z.object({ id: z.number().int().positive().nullable(), name: z.string().min(1).max(60), price: z.number().int().min(1).max(1000000) }),
    response: saveRewardResponse, handler: handleSaveReward,
  }),

  // LIFE-C1 S3 余项: set the owner's single next-reward goal
  // (rewardId only — a display preference, never an economic input).
  // STRICT owner gate.
  setRewardGoal: defineAction({
    request: z.object({ rewardId: z.number().int().positive() }),
    response: setRewardGoalResponse, handler: handleSetRewardGoal,
  }),

  // LIFE-C1 S3: redeem one reward against the pinned preview
  // (requestId + rewardRevision + price + expectedBalanceVersion).
  // Atomic compare → deduct → receipt under the profile CAS; typed
  // stale / insufficient / conflict rejections write nothing. STRICT
  // owner gate.
  redeemReward: defineAction({
    request: redeemRewardRequest, response: redeemRewardResponse, handler: handleRedeemReward,
  }),

  // LIFE-C1 S3: read-only receipt lookup by requestId — the
  // confirmation path after a lost response. STRICT owner gate.
  getRedemptionReceipt: defineAction({
    request: z.object({ requestId: z.string().min(1).max(80) }),
    response: getRedemptionReceiptResponse, handler: handleGetRedemptionReceipt,
  }),

  initializeSnapshot: defineAction({
    request: z.object({}), response: mutationResponse,
    async handler(ctx): Promise<z.infer<typeof mutationResponse>> {
      if (!isOwner(ctx)) return { ok: false, forbidden: true };
      // AUDIT-03 / L0.4: initialization never writes seed data. A database
      // without a snapshot is the honest empty state; the first real
      // HealthKit sync creates the snapshot through saveHealthSnapshot.
      return { ok: true, forbidden: false };
    },
  }),

  saveMorningCheckin: defineAction({
    request: z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), feeling: z.number().int().min(1).max(10) }),
    response: mutationResponse,
    async handler(ctx, args): Promise<z.infer<typeof mutationResponse>> {
      if (!isOwner(ctx)) return { ok: false, forbidden: true };
      const db = ctx.db<typeof schema>();
      const now = new Date();
      // The revision advances inside the SAME atomic upsert statement
      // (H-ARCHIVE-SAFE-001 follow-up): first insert writes 1; a conflict
      // update sets revision = COALESCE(existing revision, 0) + 1 via a
      // SQL expression evaluated against the stored row — never a
      // read-then-write in application code and never a client clock, so
      // two successful saves in the same millisecond still receive
      // distinct, ordered revisions. A rejected (non-owner) save returns
      // above before any statement runs, so it cannot advance the
      // revision; a failed statement likewise leaves the row untouched.
      await db.insert(schema.morningCheckin).values({ date: args.date, feeling: args.feeling, revision: 1, createdAt: now, updatedAt: now })
        .onConflictDoUpdate({ target: schema.morningCheckin.date, set: { feeling: args.feeling, revision: sql`COALESCE(${schema.morningCheckin.revision}, 0) + 1`, updatedAt: now } });
      ctx.invalidateQueries(["dashboard"]);
      return { ok: true, forbidden: false };
    },
  }),

  saveHealthSnapshot: defineAction({
    request: snapshotSchema, response: saveSnapshotResponse,
    async handler(ctx, args): Promise<z.infer<typeof saveSnapshotResponse>> {
      // expectsAction callback for this artifact's own sync tasks (see
      // isOwnerOrSyncChannel): the task return channel carries no viewer.
      if (!isOwnerOrSyncChannel(ctx)) return { ok: false, forbidden: true, outcome: "forbidden" };
      let nextSnapshot = args;
      if (args.strengthTraining.updatedAt === null && args.strengthTraining.workouts.length === 0) {
        const db = ctx.db<typeof schema>();
        const rows = await db.select({ payload: schema.healthSnapshot.payload }).from(schema.healthSnapshot).where(eq(schema.healthSnapshot.id, 1)).limit(1);
        const first = rows[0];
        if (first) {
          try {
            const stored = normalizeStoredSnapshot(JSON.parse(first.payload));
            if (stored) nextSnapshot = { ...args, strengthTraining: stored.strengthTraining };
          } catch {
            // A malformed prior snapshot should not block a valid HealthKit refresh.
          }
        }
      }
      const outcome = await persistSnapshot(ctx, nextSnapshot);
      return { ok: true, forbidden: false, outcome };
    },
  }),

  saveStrengthTrainingSnapshot: defineAction({
    request: strengthTrainingSchema, response: saveSnapshotResponse,
    async handler(ctx, args): Promise<z.infer<typeof saveSnapshotResponse>> {
      // expectsAction callback for this artifact's own sync tasks (see
      // isOwnerOrSyncChannel): the task return channel carries no viewer.
      if (!isOwnerOrSyncChannel(ctx)) return { ok: false, forbidden: true, outcome: "forbidden" };
      const outcome = await persistStrengthSnapshot(ctx, args);
      return { ok: true, forbidden: false, outcome };
    },
  }),

  refreshStrengthTraining: defineAction({
    request: z.object({}),
    response: refreshResponse,
    async handler(ctx): Promise<z.infer<typeof refreshResponse>> {
      if (!isOwner(ctx)) return { forbidden: true, accepted: false, taskId: null, strengthTaskId: null, message: "训练数据仅所有者可同步" };
      // No dedupeKey and allowParallel: an explicit tap must always start a
      // fresh read of 训练记录, never be folded into an earlier task.
      const task = await ctx.agent.spawnTask(STRENGTH_SYNC_PROMPT, { expectsAction: "saveStrengthTrainingSnapshot", allowParallel: true });
      if (!task.ok) return { forbidden: false, accepted: false, taskId: null, strengthTaskId: null, message: "训练同步任务暂时无法启动" };
      return { forbidden: false, accepted: true, taskId: task.taskId, strengthTaskId: task.taskId, message: "已开始同步训练记录" };
    },
  }),

  getRefreshStatus: defineAction({
    request: z.object({ taskId: z.string().min(1) }),
    response: refreshStatusResponse,
    async handler(ctx, args): Promise<z.infer<typeof refreshStatusResponse>> {
      if (!isOwner(ctx)) return { forbidden: true, status: "unknown", contractSatisfied: false };
      try {
        const result = await ctx.agent.status(args.taskId);
        if (result.status === "failed" || (result.status === "completed" && result.returnContractStatus !== "satisfied")) {
          await recordSyncLog(ctx, { source: "system", status: "failed", itemCount: 0, note: `同步任务未完成 · 状态 ${result.status} · 契约 ${result.returnContractStatus ?? "unknown"} · ${args.taskId.slice(0, 8)}`, sourceUpdatedAt: null });
        }
        return { forbidden: false, status: result.status, contractSatisfied: result.returnContractStatus === "satisfied" };
      } catch {
        return { forbidden: false, status: "unknown", contractSatisfied: false };
      }
    },
  }),

  logSyncEvent: defineAction({
    request: z.object({ source: z.enum(["health", "strength", "system"]), status: z.enum(["failed", "diagnosed"]), note: z.string().min(1).max(500) }),
    response: mutationResponse,
    async handler(ctx, args): Promise<z.infer<typeof mutationResponse>> {
      if (!isOwner(ctx)) return { ok: false, forbidden: true };
      await recordSyncLog(ctx, { source: args.source, status: args.status, itemCount: 0, note: args.note, sourceUpdatedAt: null });
      ctx.invalidateQueries(["dashboard"]);
      return { ok: true, forbidden: false };
    },
  }),

  getSyncDiagnostics: defineAction({
    request: z.object({}),
    response: diagnosticsResponse,
    async handler(ctx): Promise<z.infer<typeof diagnosticsResponse>> {
      const generatedAt = new Date().toISOString();
      if (!isOwner(ctx)) {
        return { forbidden: true, generatedAt, verdict: "仅所有者可查看数据状态", checks: [], dataStatus: null, unifiedTimeline: [] };
      }
      // Independent per-source loads (H-SOURCE-001): health checks reflect
      // only the health snapshot and strength checks only the strength
      // snapshot, so a missing or corrupt health snapshot no longer skips
      // the strength checks, the failure scan, or the timeline overlap.
      const healthLoad = await loadHealthSnapshot(ctx);
      const strengthLoad = await loadStrengthSnapshot(ctx);
      const strength = effectiveStrength(healthLoad, strengthLoad);
      const logs = await loadRecentLogs(ctx);
      const dataStatus = buildDataStatus(healthLoad, strengthLoad, logs);
      const timeline = buildUnifiedTimeline(healthLoad.snapshot, strength);
      const checks: z.infer<typeof diagnosticsResponse>["checks"] = [];
      if (healthLoad.state === "ok" && healthLoad.snapshot) {
        const healthAge = dataStatus.health.ageMinutes;
        checks.push({ key: "health-fresh", label: "健康数据新鲜度", ok: dataStatus.health.freshness === "fresh" || dataStatus.health.freshness === "today", detail: healthAge === null ? "没有更新时间" : `上次保存 ${healthAge} 分钟前 · 数据日期 ${healthLoad.snapshot.dataDate}` });
      } else if (healthLoad.state === "corrupt") {
        checks.push({ key: "health-present", label: "健康快照", ok: false, detail: "健康快照损坏，等待重新同步" });
      } else {
        checks.push({ key: "health-present", label: "健康快照", ok: false, detail: "还没有健康快照，先点一次全部同步" });
      }
      if (strengthLoad.state === "corrupt") {
        checks.push({ key: "strength-present", label: "力量快照", ok: false, detail: "训练快照损坏，等待重新同步" });
      } else if (strength) {
        const strengthAge = dataStatus.strength.ageMinutes;
        checks.push({ key: "strength-fresh", label: "训练数据新鲜度", ok: dataStatus.strength.freshness === "fresh" || dataStatus.strength.freshness === "today", detail: strengthAge === null ? "还没有成功同步过训练记录" : `上次保存 ${strengthAge} 分钟前 · 共 ${strength.workouts.length} 次训练` });
        const latestStrength = strength.workouts.length ? [...strength.workouts].sort((a, b) => b.date.localeCompare(a.date))[0] : undefined;
        checks.push({ key: "strength-latest", label: "最近一次力量训练", ok: Boolean(latestStrength), detail: latestStrength ? `${latestStrength.date} · ${latestStrength.routine} · ${Math.round(latestStrength.totalVolume)} ${latestStrength.unit}` : "训练记录里暂无训练，或还没同步进来" });
      } else {
        checks.push({ key: "strength-present", label: "力量快照", ok: false, detail: "还没有力量快照" });
      }
      const failedLogs = logs.filter((l) => l.status === "failed");
      checks.push({ key: "recent-failures", label: "近期同步失败", ok: failedLogs.length === 0, detail: failedLogs.length ? `最近有 ${failedLogs.length} 条失败记录：${failedLogs[0]?.note ?? ""}` : "最近 8 条台账里没有失败记录" });
      const unifiedDays = timeline.filter((d) => d.hasHealth && d.hasStrength).length;
      checks.push({ key: "unified-overlap", label: "一体时间线重合天数", ok: timeline.length > 0, detail: timeline.length ? `近 ${timeline.length} 天里 ${unifiedDays} 天同时有健康与力量记录，其余天只有一边有记录是正常的` : "统一时间线还没有任何一天的记录" });
      const failedCount = checks.filter((c) => !c.ok).length;
      const healthUsable = healthLoad.state === "ok";
      const strengthUsable = strength !== null;
      const anyCorrupt = healthLoad.state === "corrupt" || strengthLoad.state === "corrupt";
      let verdict: string;
      if (!healthUsable && !strengthUsable && !anyCorrupt) {
        verdict = "还没有数据：先同步一次，台账会从第一次保存开始记录。";
      } else if (anyCorrupt) {
        const corruptLabels = [healthLoad.state === "corrupt" ? "健康快照" : null, strengthLoad.state === "corrupt" ? "训练快照" : null].filter(Boolean).join("与");
        verdict = `${corruptLabels}已损坏，等待重新同步；另一边的数据不受影响，照常可用。看下面每一项的说明，损坏的一边重新同步后会恢复。`;
      } else if (!healthUsable || !strengthUsable) {
        verdict = `只有一边有数据：${healthUsable ? "健康" : "训练记录"}这边有数据，${healthUsable ? "训练记录" : "健康"}这边还没有。看下面每一项的说明，缺失的一边点对应的同步即可。`;
      } else if (failedCount === 0) {
        verdict = "一体层正常：两边都有数据，近期没有静默失败。";
      } else {
        verdict = `发现 ${failedCount} 项需要留意：看下面每一项的说明，过期就点对应的同步，失败会留痕在台账里。`;
      }
      await recordSyncLog(ctx, { source: "system", status: "diagnosed", itemCount: checks.length, note: `一键体检 · ${verdict}`, sourceUpdatedAt: null });
      return { forbidden: false, generatedAt, verdict, checks, dataStatus, unifiedTimeline: timeline };
    },
  }),

  refreshHealthData: defineAction({
    request: z.object({}),
    response: refreshResponse,
    async handler(ctx): Promise<z.infer<typeof refreshResponse>> {
      // Entry point for both the owner's 全部同步 button and the artifact's
      // own daily schedule, which invokes this action with no browser
      // viewer (see isOwnerOrSyncChannel). A present non-owner viewer is
      // still rejected.
      if (!isOwnerOrSyncChannel(ctx)) return { forbidden: true, accepted: false, taskId: null, strengthTaskId: null, message: "健康数据仅所有者可同步" };
      const healthTask = await ctx.agent.spawnTask(
        `Refresh the user's Apple HealthKit dashboard with real data. Use America/Los_Angeles as the health calendar timezone and determine the latest complete calendar day (normally yesterday). Every health-cli command must include --provider healthkit. Query daily metrics for the 30 completed days ending on the latest complete day with fields body_mass_average,step_count,active_energy_burned_kcal,resting_hr_average_bpm,heart_rate_variability_ms,respiratory_rate_average,hr_average_bpm,hr_max_bpm,apple_exercise_time_sum,distance_swimming_sum,distance_walking_running_meters,flights_climbed_sum,basal_energy_burned_kcal. Query the current partial day separately for the morning reference. Query workout sessions over the same 30-day window with fields id,start_datetime,end_datetime,timezone,workout_type,distance_meters,hr_average_bpm,energy_burned_kcal,active_duration_sec. Query sleep sessions covering the latest 15 calendar days and retain the latest 14 sessions. For every sleep session, preserve coreHours, deepHours, remHours, and awakeMinutes. Calculate actual sleep duration strictly as core + deep + REM; awake time is never part of actual sleep. Set every historySleeps.totalHours and the main sleep.inBedHours display value to that actual-sleep sum. Calculate sleep efficiency as actual sleep duration divided by time in bed, where time in bed is end_datetime minus start_datetime; do not use a sleep-stage duration as the denominator. Build trends from the final seven completed daily rows. Build the main daily snapshot from the latest completed metrics day. Define the readiness date from the current partial day's local date. For the main sleep and every one of its fields (bedtime, wakeTime, inBedHours, coreHours, deepHours, remHours, awakeMinutes, efficiency, quality, awakenings), select the completed sleep session whose end_datetime local date equals that readiness date; only if that morning's session has not ended or has not synced may you fall back to the most recent earlier completed sleep session. Set each historySleeps.date to the local calendar date of end_datetime. Preserve absent fields as null and set coverageIncomplete=true if any relevant query reports coverage.complete=false. For display-only step baseline/range fields, use exactly this rule: consider only complete days with step data; when there are at least 14 such completed days, compute the mean and standard deviation of step_count over the prior 14 completed days and set baseline = mean (when all 14 days are zero, baseline = 0 — that is a valid baseline, not missing data), usualMin = max(0, mean − standard deviation) (clamped at 0), and usualMax = mean + standard deviation (when all 14 days are zero, usualMax = 0); when fewer than 14 completed days are available or step data is absent, set baseline, usualMin, and usualMax all to null — never substitute any fixed or typical value. For display-only resting-HR and HRV baseline/range fields, derive mean and mean ± standard deviation from the prior 14 completed days when available; the server independently computes readiness from raw history. Status must be one of 正常, 偏低, 偏高, 数据缺失; missing is based on absent fields, not inferred as an anomaly. Include respiratoryRate on the main day and respiratoryRate on every historyDaily row, preserving absent values as null. Convert walking distance to km, workout duration seconds to minutes, and sleep stages to hours; display bedtime/wake as HH:mm. historyDaily must map the source fields to steps, activeKcal, exerciseMinutes, restingHr, hrvMs, respiratoryRate, weightKg, swimMeters, hrMax. hrMax is the day's hr_max_bpm (the highest heart rate observed that day); preserve it as null when the field is absent — never substitute an average or an estimate, because the load score takes the maximum hrMax over the stored window as HRmax. For historySleeps preserve awakenings and efficiency when present, otherwise null. historyWorkouts and historySleeps must contain only source-backed values, sorted ascending by date. Version contract: BEFORE you run any health-cli query, record the current instant as readStartedAt, and set the payload's updatedAt to that readStartedAt in ISO 8601 — the moment the source read began. Never set updatedAt to the instant the task finishes or to the callback instant. Why: the save versions snapshots by read-start time and applies them with an atomic compare-and-write that rejects any version older than the one already stored, so a read that started earlier can never overwrite a newer snapshot even when it finishes later; stamping the completion time instead would disguise an old read as new data and defeat that guard. Cap historyDaily at 35, historyWorkouts at 100, and historySleeps at 14. The workout note must refer only to Apple Watch workout sessions. Set strengthTraining to its empty default with updatedAt null; the save action preserves the separately synchronized training-record data. Call the expected save action exactly once with the completed HealthKit snapshot.`,
        { expectsAction: "saveHealthSnapshot", allowParallel: true },
      );
      const strengthTask = await ctx.agent.spawnTask(STRENGTH_SYNC_PROMPT, { expectsAction: "saveStrengthTrainingSnapshot", allowParallel: true });
      if (!healthTask.ok && !strengthTask.ok) return { forbidden: false, accepted: false, taskId: null, strengthTaskId: null, message: "刷新任务暂时无法启动" };
      const taskId = healthTask.ok ? healthTask.taskId : strengthTask.ok ? strengthTask.taskId : null;
      const strengthTaskId = strengthTask.ok ? strengthTask.taskId : null;
      const message = healthTask.ok && strengthTask.ok ? "已开始同步 Apple 健康和训练记录" : healthTask.ok ? "已开始同步 Apple 健康；训练记录稍后再试" : "已开始同步训练记录；Apple 健康稍后再试";
      return { forbidden: false, accepted: true, taskId, strengthTaskId, message };
    },
  }),
} satisfies ActionsModule;
