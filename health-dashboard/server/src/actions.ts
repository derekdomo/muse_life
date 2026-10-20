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
// sourceUpdatedAt differs from the stored row's and the value differs,
// the row is updated in place (xp, gold, source reference in one atomic
// UPDATE) and the ledger SUM total moves by the delta automatically.
// The same sourceUpdatedAt re-opened changes nothing; a row booked
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
// ---------------------------------------------------------------------------
const GAME_RULE_VERSION = 2;
const GAME_XP_PER_LEVEL = 100;
const GAME_QUEST_TARGET_STEPS = 8000;
const GAME_QUEST_REWARD_XP = 10;
const GAME_STRENGTH_SESSION_XP = 10;
const GAME_POINTS_PER_LEVEL = 3;
const GAME_ATTR_XP_PCT_PER_POINT = 2;
const GAME_ATTR_DOMAIN_CAP_PCT = 50;

const gameCategorySchema = z.enum(["steps", "sleep", "strength", "quest_steps", "daily_task"]);
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
  attributes: Record<GameAttribute, number>;
  attrPointsEarned: number;
  owned: string[];
  equipped: Record<GameSlot, string | null>;
}

function defaultGameProfile(): GameProfile {
  return {
    gold: 0,
    goldInitialized: false,
    attributes: { strength: 0, endurance: 0, spirit: 0, stamina: 0 },
    attrPointsEarned: 0,
    owned: [],
    equipped: { weapon: null, armor: null, accessory: null },
  };
}

function parseGameProfile(row: { gold: number; goldInitialized: number; attrsJson: string | null; attrPointsEarned: number; equipmentJson: string | null } | undefined): GameProfile {
  const profile = defaultGameProfile();
  if (!row) return profile;
  profile.gold = row.gold;
  profile.goldInitialized = row.goldInitialized === 1;
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

async function loadGameProfile(ctx: Ctx): Promise<GameProfile> {
  const db = ctx.db<typeof schema>();
  const rows = await db.select().from(schema.gameState).where(eq(schema.gameState.id, 1)).limit(1);
  return parseGameProfile(rows[0]);
}

async function saveGameProfile(ctx: Ctx, profile: GameProfile, totalXp: number, settledThroughDate: string | null): Promise<void> {
  const db = ctx.db<typeof schema>();
  const now = new Date();
  const values = {
    id: 1,
    totalXp,
    settledThroughDate,
    gold: profile.gold,
    goldInitialized: profile.goldInitialized ? 1 : 0,
    attrsJson: JSON.stringify(profile.attributes),
    attrPointsEarned: profile.attrPointsEarned,
    equipmentJson: JSON.stringify({ owned: profile.owned, equipped: profile.equipped }),
    createdAt: now,
    updatedAt: now,
  };
  await db.insert(schema.gameState).values(values)
    .onConflictDoUpdate({ target: schema.gameState.id, set: { totalXp: values.totalXp, settledThroughDate: values.settledThroughDate, gold: values.gold, goldInitialized: values.goldInitialized, attrsJson: values.attrsJson, attrPointsEarned: values.attrPointsEarned, equipmentJson: values.equipmentJson, updatedAt: now } });
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

// Pure settlement decision for one candidate against its stored row
// (CWEB-SETTLE-001 revision rules):
// - no stored row -> insert;
// - stored row under a different rule version -> skip (never recomputed,
//   never re-awarded);
// - same sourceUpdatedAt -> skip (re-opening with the same source
//   version changes nothing, even if a recomputed value would differ);
// - newer source version but the value already matches -> refresh only
//   the source reference, xp/gold untouched;
// - newer source version and a different value -> revise the row in
//   place; the gold balance follows by goldDelta and the XP total (the
//   ledger SUM) moves by the xp delta on its own.
function planLedgerAction(existing: LedgerRowLike | undefined, candidate: GameCandidate): LedgerAction {
  if (!existing) return { kind: "insert" };
  if (existing.ruleVersion !== GAME_RULE_VERSION) return { kind: "skip" };
  if (existing.sourceUpdatedAt === candidate.sourceUpdatedAt) return { kind: "skip" };
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

// Insert one ledger row if its (date, category, detail) is not booked
// yet; returns true when the row was actually inserted (so the caller
// credits gold exactly once). Used for daily_task rows only: a met daily
// target cannot un-happen and its reward is flat, so those rows never
// revise. Domain candidates go through settleLedgerRow below.
async function bookLedgerRow(ctx: Ctx, candidate: GameCandidate): Promise<boolean> {
  const db = ctx.db<typeof schema>();
  const existing = await db.select({ localDate: schema.gameSettlements.localDate })
    .from(schema.gameSettlements)
    .where(and(eq(schema.gameSettlements.localDate, candidate.localDate), eq(schema.gameSettlements.category, candidate.category), eq(schema.gameSettlements.detail, candidate.detail)))
    .limit(1);
  if (existing.length) return false;
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
  return true;
}

// Settle one domain candidate against the ledger, applying the
// planLedgerAction decision (CWEB-SETTLE-001): insert when unbooked;
// on a same-rule-version source revision, update the stored row in
// place — xp, gold and the source reference in a single UPDATE, so the
// row is never half-revised — or refresh only the source reference when
// the value already matches. Returns the gold delta to apply to the
// profile balance (the full mint on insert, the signed delta on revise,
// 0 otherwise), so gold always follows the XP actually awarded.
async function settleLedgerRow(ctx: Ctx, candidate: GameCandidate): Promise<number> {
  const db = ctx.db<typeof schema>();
  const key = and(eq(schema.gameSettlements.localDate, candidate.localDate), eq(schema.gameSettlements.category, candidate.category), eq(schema.gameSettlements.detail, candidate.detail));
  const existingRows = await db.select().from(schema.gameSettlements).where(key).limit(1);
  const action = planLedgerAction(existingRows[0], candidate);
  if (action.kind === "skip") return 0;
  if (action.kind === "insert") {
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
    return candidate.gold;
  }
  if (action.kind === "refresh_source_ref") {
    await db.update(schema.gameSettlements)
      .set({ sourceDate: candidate.sourceDate, sourceUpdatedAt: candidate.sourceUpdatedAt })
      .where(key);
    return 0;
  }
  await db.update(schema.gameSettlements)
    .set({ xp: candidate.xp, gold: candidate.gold, sourceDate: candidate.sourceDate, sourceUpdatedAt: candidate.sourceUpdatedAt })
    .where(key);
  return action.goldDelta;
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

// Settle every candidate and today's daily tasks against the profile,
// then read back totals and persist the profile. The ledger table is
// the source of truth for total XP (summed, never incremented by hand);
// game_state carries the gold balance and the S2 character state.
// Re-running with the same source versions changes nothing; a newer
// source version corrects already-booked rows in place (revision
// settlement — see planLedgerAction), so totals always reflect the
// latest source, never a frozen first read.
async function settleGame(ctx: Ctx, candidates: GameCandidate[], profile: GameProfile, health: Snapshot | null, strength: StrengthTraining | null, todayLA: string): Promise<{ totalXp: number; settledThroughDate: string | null; ledger: z.infer<typeof gameSettlementEntrySchema>[]; dailyTasks: z.infer<typeof gameDailyTaskSchema>[] }> {
  const db = ctx.db<typeof schema>();
  // One-time gold initialization (S2): the balance starts at the
  // cumulative XP booked before S2 existed. This must run BEFORE any new
  // settlement mints gold in this call, and exactly once ever
  // (goldInitialized persists in game_state).
  if (!profile.goldInitialized) {
    const totals = await db.select({ total: sql`COALESCE(SUM(${schema.gameSettlements.xp}), 0)` }).from(schema.gameSettlements);
    profile.gold = Number(totals[0]?.total ?? 0);
    profile.goldInitialized = true;
  }
  const unique = [...new Map(candidates.map((candidate) => [`${candidate.localDate}|${candidate.category}|${candidate.detail}`, candidate])).values()];
  for (const candidate of unique) {
    // Gold follows the awarded XP by the signed delta; the balance is
    // floored at 0 so a downward source revision after gold was spent
    // can never drive it negative.
    profile.gold = Math.max(0, profile.gold + await settleLedgerRow(ctx, candidate));
  }
  // Daily tasks: book each met-and-unclaimed task once for today.
  const evaluated = evaluateDailyTasks(health, strength, todayLA);
  const claimedRows = await db.select({ detail: schema.gameSettlements.detail }).from(schema.gameSettlements)
    .where(and(eq(schema.gameSettlements.localDate, todayLA), eq(schema.gameSettlements.category, "daily_task")));
  const claimed = new Set(claimedRows.map((row) => row.detail));
  const dailyTasks: z.infer<typeof gameDailyTaskSchema>[] = [];
  for (const entry of evaluated) {
    let state: z.infer<typeof gameDailyTaskSchema>["state"];
    if (claimed.has(entry.def.id)) {
      state = "claimed";
    } else if (entry.progress === null) {
      state = "missing";
    } else if (entry.progress >= entry.def.target) {
      const booked = await bookLedgerRow(ctx, { localDate: todayLA, category: "daily_task", detail: entry.def.id, xp: entry.def.rewardXp, gold: entry.def.rewardGold, sourceDate: todayLA, sourceUpdatedAt: health?.updatedAt ?? null });
      if (booked) {
        profile.gold += entry.def.rewardGold;
        claimed.add(entry.def.id);
        // Task-granted equipment: the first sleep-task completion ever
        // grants the dawn charm (owned forever after).
        if (entry.def.id === "sleep_7h30" && !profile.owned.includes("dawn_charm")) {
          profile.owned.push("dawn_charm");
        }
      }
      state = "claimed";
    } else {
      state = "in_progress";
    }
    dailyTasks.push({ id: entry.def.id, label: entry.def.label, targetLabel: entry.def.targetLabel, progress: entry.progress, progressLabel: entry.progressLabel, target: entry.def.target, state, rewardXp: entry.def.rewardXp, rewardGold: entry.def.rewardGold });
  }
  const totals = await db.select({ total: sql`COALESCE(SUM(${schema.gameSettlements.xp}), 0)`, through: sql`MAX(${schema.gameSettlements.localDate})` }).from(schema.gameSettlements);
  const totalRow = totals[0];
  const totalXp = Number(totalRow?.total ?? 0);
  const settledThroughDate = typeof totalRow?.through === "string" ? totalRow.through : null;
  // Attribute points: 3 per level gained, backfilled once from the
  // current level (level derives from total XP, so this is exact, never
  // speculative) and never revoked.
  const level = Math.floor(totalXp / GAME_XP_PER_LEVEL) + 1;
  const earned = (level - 1) * GAME_POINTS_PER_LEVEL;
  if (earned > profile.attrPointsEarned) profile.attrPointsEarned = earned;
  await saveGameProfile(ctx, profile, totalXp, settledThroughDate);
  const ledgerRows = await db.select().from(schema.gameSettlements).orderBy(desc(schema.gameSettlements.localDate), asc(schema.gameSettlements.category), asc(schema.gameSettlements.detail)).limit(90);
  return {
    totalXp,
    settledThroughDate,
    dailyTasks,
    ledger: ledgerRows.map((row) => ({
      localDate: row.localDate,
      category: row.category,
      detail: row.detail,
      xp: row.xp,
      gold: row.gold,
      ruleVersion: row.ruleVersion,
      sourceDate: row.sourceDate,
      sourceUpdatedAt: row.sourceUpdatedAt,
      settledAt: row.createdAt.toISOString(),
    })),
  };
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
        const profile = await loadGameProfile(ctx);
        const plan = buildGamePlan(health, strength, todayLA, profile);
        const settled = await settleGame(ctx, plan.candidates, profile, health, strength, todayLA);
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
        const db = ctx.db<typeof schema>();
        const stateRows = await db.select().from(schema.gameState).where(eq(schema.gameState.id, 1)).limit(1);
        const stored = stateRows[0];
        const profile = parseGameProfile(stored);
        if (args.count > unspentPoints(profile)) return { ok: false, forbidden: false, message: `未分配点数不足：当前剩余 ${unspentPoints(profile)} 点` };
        profile.attributes[args.attribute] += args.count;
        await saveGameProfile(ctx, profile, stored?.totalXp ?? 0, stored?.settledThroughDate ?? null);
        ctx.invalidateQueries(["game"]);
        return { ok: true, forbidden: false, message: `已分配 ${args.count} 点到${GAME_ATTRIBUTE_LABELS[args.attribute]}，剩余 ${unspentPoints(profile)} 点` };
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
        const db = ctx.db<typeof schema>();
        const stateRows = await db.select().from(schema.gameState).where(eq(schema.gameState.id, 1)).limit(1);
        const stored = stateRows[0];
        const profile = parseGameProfile(stored);
        if (profile.owned.includes(def.id)) return { ok: false, forbidden: false, message: `已经拥有${def.name}` };
        if (profile.gold < def.price) return { ok: false, forbidden: false, message: `金币不足：${def.name} 需要 ${def.price} 金币，当前余额 ${profile.gold}` };
        profile.gold -= def.price;
        profile.owned.push(def.id);
        await saveGameProfile(ctx, profile, stored?.totalXp ?? 0, stored?.settledThroughDate ?? null);
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
        const db = ctx.db<typeof schema>();
        const stateRows = await db.select().from(schema.gameState).where(eq(schema.gameState.id, 1)).limit(1);
        const stored = stateRows[0];
        const profile = parseGameProfile(stored);
        if (!profile.owned.includes(def.id)) return { ok: false, forbidden: false, message: `尚未拥有${def.name}` };
        profile.equipped[def.slot] = def.id;
        await saveGameProfile(ctx, profile, stored?.totalXp ?? 0, stored?.settledThroughDate ?? null);
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
        const db = ctx.db<typeof schema>();
        const stateRows = await db.select().from(schema.gameState).where(eq(schema.gameState.id, 1)).limit(1);
        const stored = stateRows[0];
        const profile = parseGameProfile(stored);
        if (!profile.equipped[args.slot]) return { ok: false, forbidden: false, message: `${GAME_SLOT_LABELS[args.slot]}槽位本来就是空的` };
        profile.equipped[args.slot] = null;
        await saveGameProfile(ctx, profile, stored?.totalXp ?? 0, stored?.settledThroughDate ?? null);
        ctx.invalidateQueries(["game"]);
        return { ok: true, forbidden: false, message: `已卸下${GAME_SLOT_LABELS[args.slot]}` };
      } catch {
        return { ok: false, forbidden: false, message: "卸下失败，请稍后再试" };
      }
    },
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
