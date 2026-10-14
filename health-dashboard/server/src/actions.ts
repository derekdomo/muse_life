import { defineAction, z, type ActionsModule, type Ctx } from "@hatch/space-sdk";
import { eq } from "drizzle-orm";
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
  routine: z.enum(["push", "pull", "legs"]),
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
    baseline: z.number().positive(),
    usualMin: z.number().nonnegative(),
    usualMax: z.number().positive(),
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
type Daily = z.infer<typeof dailySchema>;
type Workout = z.infer<typeof workoutSchema>;
type SleepHistory = z.infer<typeof sleepHistorySchema>;
type StrengthTraining = z.infer<typeof strengthTrainingSchema>;

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
  const currentVolume = currentStrength.reduce((sum, workout) => sum + workout.totalVolume, 0);
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

const INITIAL_DAILY: Daily[] = [
  ["2026-09-05",2432,253.20,11,71,23.43,null,null], ["2026-09-06",4013,241.59,11,66,26.15,null,null],
  ["2026-09-07",1996,101.47,7,63,72.74,null,null], ["2026-09-08",4283,413.54,11,67,33.23,null,null],
  ["2026-09-09",4141,397.68,6,68,40.77,null,null], ["2026-09-10",1871,70.04,2,63,64.63,null,null],
  ["2026-09-11",2277,449.12,32,60,39.43,null,600], ["2026-09-12",2594,76.04,1,59,41.75,84.05,null],
  ["2026-09-13",4726,314.67,10,64,39.84,null,null], ["2026-09-14",4010,345.99,6,67,48.91,84.15,null],
  ["2026-09-15",4079,280.67,8,67,39.42,null,null], ["2026-09-16",4338,370.40,5,65,35.94,null,null],
  ["2026-09-17",1676,62.66,3,59,52.63,null,null], ["2026-09-18",4286,572.16,32,63,31.65,83.35,550],
  ["2026-09-19",3096,59.28,3,63,33.43,null,null], ["2026-09-20",1428,null,null,null,null,null,null],
  ["2026-09-21",5168,375.79,13,66.31,38.21,null,null], ["2026-09-22",4189,652.80,38,64,43.76,null,600],
  ["2026-09-23",4488,315.93,7,70,27.76,null,null], ["2026-09-24",3902,593.89,36,67,43.94,null,600],
  ["2026-09-25",3203,266.30,4,null,37.40,null,null], ["2026-09-26",4661,59.74,3,63,38.43,null,null],
  ["2026-09-27",6320,400.56,11,59.5,41.72,null,null], ["2026-09-28",7353,537.76,28,62.65,39.87,null,null],
  ["2026-09-29",5576,423.00,9,58.63,40.15,null,null], ["2026-09-30",7889,485.54,19,55,46.08,null,null],
  ["2026-10-01",1579,null,null,null,null,null,null],
].map(([date, steps, activeKcal, exerciseMinutes, restingHr, hrvMs, weightKg, swimMeters]) => ({
  date: String(date), steps: steps as number | null, activeKcal: activeKcal as number | null,
  exerciseMinutes: exerciseMinutes as number | null, restingHr: restingHr as number | null,
  hrvMs: hrvMs as number | null, respiratoryRate: null, weightKg: weightKg as number | null, swimMeters: swimMeters as number | null,
}));

const INITIAL_WORKOUTS: Workout[] = [
  { id:"healthkit_A0F40961-3E02-4318-BF26-8D7391DE2957", date:"2026-09-11", type:"swimming", durationMinutes:23.54, energyKcal:289.52, distanceMeters:600, averageHr:131.38 },
  { id:"healthkit_250B9454-329E-4878-8140-B2359B43DFDF", date:"2026-09-18", type:"swimming", durationMinutes:20.27, energyKcal:243.20, distanceMeters:550, averageHr:124.89 },
  { id:"healthkit_7F48DE21-2D09-4538-A987-0C09501472CB", date:"2026-09-22", type:"swimming", durationMinutes:23.65, energyKcal:274.89, distanceMeters:600, averageHr:120.66 },
  { id:"healthkit_917D3AB5-6B0E-4A0C-AF20-D0D081E61326", date:"2026-09-24", type:"swimming", durationMinutes:20.69, energyKcal:283.61, distanceMeters:600, averageHr:124.92 },
];

const INITIAL_SLEEPS: SleepHistory[] = [
  { date:"2026-09-25", start:"00:52", end:"06:51", totalHours:5.99, quality:55, awakenings:null, efficiency:null },
  { date:"2026-09-26", start:"00:57", end:"08:07", totalHours:7.16, quality:92, awakenings:null, efficiency:null },
  { date:"2026-09-27", start:"01:02", end:"06:35", totalHours:5.54, quality:49, awakenings:null, efficiency:null },
  { date:"2026-09-28", start:"21:22", end:"04:58", totalHours:7.59, quality:96, awakenings:null, efficiency:null },
  { date:"2026-09-29", start:"22:28", end:"04:49", totalHours:6.30, quality:58, awakenings:null, efficiency:null },
  { date:"2026-09-30", start:"22:11", end:"04:39", totalHours:6.47, quality:63, awakenings:null, efficiency:null },
  { date:"2026-10-02", start:"01:02", end:"07:40", totalHours:6.63, quality:67, awakenings:null, efficiency:null },
];

const EMPTY_STRENGTH: z.infer<typeof strengthTrainingSchema> = {
  updatedAt: null,
  displayUnit: "lb",
  workouts: [],
  weeklyTrend: [],
  note: "在「训练记录」完成或更新训练后，同步即可查看训练量。",
};

const INITIAL_SNAPSHOT: Snapshot = {
  dataDate: "2026-10-01", updatedAt: "2026-10-02T19:12:00.000Z", timezone: "America/Los_Angeles", coverageIncomplete: true,
  steps: { value: 1579, baseline: 4000, usualMin: 2000, usualMax: 5900, distanceKm: 1.06, flights: 4, basalKcal: 1755, status: "偏低" },
  restingHr: { value: null, baseline: 65, usualMin: 62, usualMax: 72, status: "数据缺失" },
  hrv: { value: null, baseline: 40, usualMin: 25, usualMax: 52, status: "数据缺失" },
  respiratoryRate: { value: null, status: "数据缺失" },
  sleep: { bedtime: "01:02", wakeTime: "07:40", inBedHours: 6.63, coreHours: 3.49, deepHours: 0.93, remHours: 2.21, awakeMinutes: 0.5, quality: 67, efficiency: 99.9, awakenings: 1, status: "正常" },
  morningReference: { date: "2026-10-02", hrvMs: 61.4, avgHrBpm: 61.8 },
  strengthTraining: EMPTY_STRENGTH,
  workouts: { count7d: 0, baselinePerWeek: 2, note: "近 7 天未记录 Apple Watch workout；力量训练详见下方独立训练记录" },
  trends: [
    { date: "2026-09-25", stepCount: 3203, restingHrBpm: null, hrvMs: 37.4 },
    { date: "2026-09-26", stepCount: 4661, restingHrBpm: 63, hrvMs: 38.4 },
    { date: "2026-09-27", stepCount: 6320, restingHrBpm: 59.5, hrvMs: 41.7 },
    { date: "2026-09-28", stepCount: 7353, restingHrBpm: 62.7, hrvMs: 39.9 },
    { date: "2026-09-29", stepCount: 5576, restingHrBpm: 58.6, hrvMs: 40.1 },
    { date: "2026-09-30", stepCount: 7889, restingHrBpm: 55, hrvMs: 46.1 },
    { date: "2026-10-01", stepCount: 1579, restingHrBpm: null, hrvMs: null },
  ],
  historyDaily: INITIAL_DAILY, historyWorkouts: INITIAL_WORKOUTS, historySleeps: INITIAL_SLEEPS,
};

function normalizeStoredSnapshot(value: unknown): Snapshot | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const rawDaily = Array.isArray(record.historyDaily) ? record.historyDaily : INITIAL_DAILY;
  const rawSleeps = Array.isArray(record.historySleeps) ? record.historySleeps : INITIAL_SLEEPS;
  const candidate = {
    ...record,
    respiratoryRate: record.respiratoryRate ?? { value: null, status: "数据缺失" },
    strengthTraining: record.strengthTraining ?? EMPTY_STRENGTH,
    historyDaily: rawDaily.map((row) => row && typeof row === "object" && !Array.isArray(row) ? { respiratoryRate: null, ...row } : row),
    historyWorkouts: record.historyWorkouts ?? INITIAL_WORKOUTS,
    historySleeps: rawSleeps.map((row) => row && typeof row === "object" && !Array.isArray(row) ? { awakenings: null, efficiency: null, ...row } : row),
  };
  const parsed = snapshotSchema.safeParse(candidate);
  return parsed.success ? normalizeSleepSnapshot(parsed.data) : null;
}

function normalizeStoredStrength(value: unknown): StrengthTraining | null {
  const parsed = strengthTrainingSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

async function persistSnapshot(ctx: Ctx, snapshot: Snapshot): Promise<void> {
  const db = ctx.db<typeof schema>();
  const now = new Date();
  const normalized = normalizeSleepSnapshot(snapshot);
  await db.insert(schema.healthSnapshot).values({ id: 1, payload: JSON.stringify(normalized), sourceUpdatedAt: new Date(normalized.updatedAt), createdAt: now, updatedAt: now })
    .onConflictDoUpdate({ target: schema.healthSnapshot.id, set: { payload: JSON.stringify(normalized), sourceUpdatedAt: new Date(normalized.updatedAt), updatedAt: now } });
  ctx.invalidateQueries(["dashboard"]);
}

async function persistStrengthSnapshot(ctx: Ctx, strength: StrengthTraining): Promise<void> {
  const db = ctx.db<typeof schema>();
  const now = new Date();
  const sourceUpdatedAt = strength.updatedAt ? new Date(strength.updatedAt) : now;
  await db.insert(schema.strengthTrainingSnapshot).values({ id: 1, payload: JSON.stringify(strength), sourceUpdatedAt, createdAt: now, updatedAt: now })
    .onConflictDoUpdate({ target: schema.strengthTrainingSnapshot.id, set: { payload: JSON.stringify(strength), sourceUpdatedAt, updatedAt: now } });
  ctx.invalidateQueries(["dashboard"]);
}

const getDashboardResponse = z.object({ snapshot: snapshotSchema.nullable(), readiness: readinessSchema.nullable() });
const mutationResponse = z.object({ ok: z.literal(true) });

export const Actions = {
  getDashboard: defineAction({
    request: z.object({}), response: getDashboardResponse,
    async handler(ctx): Promise<z.infer<typeof getDashboardResponse>> {
      const db = ctx.db<typeof schema>();
      const healthRows = await db.select({ payload: schema.healthSnapshot.payload }).from(schema.healthSnapshot).where(eq(schema.healthSnapshot.id, 1)).limit(1);
      const first = healthRows[0];
      if (!first) return { snapshot: null, readiness: null };
      try {
        const health = normalizeStoredSnapshot(JSON.parse(first.payload));
        if (!health) return { snapshot: null, readiness: null };
        const readinessDate = health.morningReference?.date ?? shiftDate(health.dataDate, 1);
        const checkinRows = await db.select({ feeling: schema.morningCheckin.feeling }).from(schema.morningCheckin).where(eq(schema.morningCheckin.date, readinessDate)).limit(1);
        const morningFeeling = checkinRows[0]?.feeling ?? null;
        const strengthRows = await db.select({ payload: schema.strengthTrainingSnapshot.payload }).from(schema.strengthTrainingSnapshot).where(eq(schema.strengthTrainingSnapshot.id, 1)).limit(1);
        const strengthPayload = strengthRows[0]?.payload;
        if (!strengthPayload) return { snapshot: health, readiness: calculateReadiness(health, readinessDate, morningFeeling) };
        try {
          const strength = normalizeStoredStrength(JSON.parse(strengthPayload));
          const snapshot = strength ? { ...health, strengthTraining: strength } : health;
          return { snapshot, readiness: calculateReadiness(snapshot, readinessDate, morningFeeling) };
        } catch {
          return { snapshot: health, readiness: calculateReadiness(health, readinessDate, morningFeeling) };
        }
      } catch {
        return { snapshot: null, readiness: null };
      }
    },
  }),

  initializeSnapshot: defineAction({
    request: z.object({}), response: mutationResponse,
    async handler(ctx): Promise<z.infer<typeof mutationResponse>> {
      const db = ctx.db<typeof schema>();
      const existing = await db.select({ id: schema.healthSnapshot.id }).from(schema.healthSnapshot).where(eq(schema.healthSnapshot.id, 1)).limit(1);
      if (!existing[0]) await persistSnapshot(ctx, INITIAL_SNAPSHOT);
      return { ok: true };
    },
  }),

  saveMorningCheckin: defineAction({
    request: z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), feeling: z.number().int().min(1).max(10) }),
    response: mutationResponse,
    async handler(ctx, args): Promise<z.infer<typeof mutationResponse>> {
      const db = ctx.db<typeof schema>();
      const now = new Date();
      await db.insert(schema.morningCheckin).values({ date: args.date, feeling: args.feeling, createdAt: now, updatedAt: now })
        .onConflictDoUpdate({ target: schema.morningCheckin.date, set: { feeling: args.feeling, updatedAt: now } });
      ctx.invalidateQueries(["dashboard"]);
      return { ok: true };
    },
  }),

  saveHealthSnapshot: defineAction({
    request: snapshotSchema, response: mutationResponse,
    async handler(ctx, args): Promise<z.infer<typeof mutationResponse>> {
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
      await persistSnapshot(ctx, nextSnapshot);
      return { ok: true };
    },
  }),

  saveStrengthTrainingSnapshot: defineAction({
    request: strengthTrainingSchema, response: mutationResponse,
    async handler(ctx, args): Promise<z.infer<typeof mutationResponse>> {
      await persistStrengthSnapshot(ctx, args);
      return { ok: true };
    },
  }),

  refreshHealthData: defineAction({
    request: z.object({}),
    response: z.object({ accepted: z.boolean(), taskId: z.string().nullable(), message: z.string() }),
    async handler(ctx) {
      const healthTask = await ctx.agent.spawnTask(
        `Refresh the user's Apple HealthKit dashboard with real data. Use America/Los_Angeles as the health calendar timezone and determine the latest complete calendar day (normally yesterday). Every health-cli command must include --provider healthkit. Query daily metrics for the 30 completed days ending on the latest complete day with fields body_mass_average,step_count,active_energy_burned_kcal,resting_hr_average_bpm,heart_rate_variability_ms,respiratory_rate_average,hr_average_bpm,apple_exercise_time_sum,distance_swimming_sum,distance_walking_running_meters,flights_climbed_sum,basal_energy_burned_kcal. Query the current partial day separately for the morning reference. Query workout sessions over the same 30-day window with fields id,start_datetime,end_datetime,timezone,workout_type,distance_meters,hr_average_bpm,energy_burned_kcal,active_duration_sec. Query sleep sessions covering the latest 15 calendar days and retain the latest 14 sessions. For every sleep session, preserve coreHours, deepHours, remHours, and awakeMinutes. Calculate actual sleep duration strictly as core + deep + REM; awake time is never part of actual sleep. Set every historySleeps.totalHours and the main sleep.inBedHours display value to that actual-sleep sum. Calculate sleep efficiency as actual sleep duration divided by time in bed, where time in bed is end_datetime minus start_datetime; do not use a sleep-stage duration as the denominator. Build trends from the final seven completed daily rows. Build the main daily snapshot from the latest completed metrics day. Define the readiness date from the current partial day's local date. For the main sleep and every one of its fields (bedtime, wakeTime, inBedHours, coreHours, deepHours, remHours, awakeMinutes, efficiency, quality, awakenings), select the completed sleep session whose end_datetime local date equals that readiness date; only if that morning's session has not ended or has not synced may you fall back to the most recent earlier completed sleep session. Set each historySleeps.date to the local calendar date of end_datetime. Preserve absent fields as null and set coverageIncomplete=true if any relevant query reports coverage.complete=false. Keep the step baseline at 4000/day (usual 2000–5900). For display-only resting-HR and HRV baseline/range fields, derive mean and mean ± standard deviation from the prior 14 completed days when available; the server independently computes readiness from raw history. Status must be one of 正常, 偏低, 偏高, 数据缺失; missing is based on absent fields, not inferred as an anomaly. Include respiratoryRate on the main day and respiratoryRate on every historyDaily row, preserving absent values as null. Convert walking distance to km, workout duration seconds to minutes, and sleep stages to hours; display bedtime/wake as HH:mm. historyDaily must map the source fields to steps, activeKcal, exerciseMinutes, restingHr, hrvMs, respiratoryRate, weightKg, swimMeters. For historySleeps preserve awakenings and efficiency when present, otherwise null. historyWorkouts and historySleeps must contain only source-backed values, sorted ascending by date. Set updatedAt to the real current instant in ISO 8601, cap historyDaily at 35, historyWorkouts at 100, and historySleeps at 14. The workout note must refer only to Apple Watch workout sessions. Set strengthTraining to its empty default with updatedAt null; the save action preserves the separately synchronized training-record data. Call the expected save action exactly once with the completed HealthKit snapshot.`,
        { expectsAction: "saveHealthSnapshot", dedupeKey: "daily-healthkit-refresh" },
      );
      const strengthTask = await ctx.agent.spawnTask(
        `Synchronize the user's strength-training summary from their existing web artifact named 训练记录 (slug space-6). Treat that artifact as the only source for strength sets; do not infer workouts from Apple Health. Use its published getDashboard action with recent_limit 20. Include the active workout, if any, plus every returned recent completed workout. For each workout preserve the source id as a string, routine, unit, start and completion instants, status, all sets grouped by exercise, and completed flags. Compute completedSets and totalVolume from completed sets only; a set contributes weight × reps only when both are present. Compute durationMinutes from timestamps when completion exists; for an active workout use the current instant. Use America/Los_Angeles to derive the workout date and Monday-based week starts. Choose the most recent workout's unit as displayUnit (default lb when there are no workouts); convert mixed-unit volume exactly when aggregating weekly totals (1 lb = 0.45359237 kg) so every weeklyTrend volume is in displayUnit. Include up to the latest eight Monday-based weeks, ascending, with zero-volume intervening weeks retained. Set updatedAt to the real current instant. If the source is read successfully and contains no workouts, return empty workouts and weeklyTrend and explain in note that completed or active sets from 训练记录 will appear after synchronization. If the source cannot be read, do not replace the last successful strength snapshot with an empty one. Do not create plausible workouts or sets. Call the expected save action exactly once only after a successful source read.`,
        { expectsAction: "saveStrengthTrainingSnapshot", dedupeKey: "daily-strength-training-refresh" },
      );
      if (!healthTask.ok && !strengthTask.ok) return { accepted: false, taskId: null, message: "刷新任务暂时无法启动" };
      const taskId = healthTask.ok ? healthTask.taskId : strengthTask.ok ? strengthTask.taskId : null;
      const message = healthTask.ok && strengthTask.ok ? "已开始同步 Apple 健康和训练记录" : healthTask.ok ? "已开始同步 Apple 健康；训练记录稍后再试" : "已开始同步训练记录；Apple 健康稍后再试";
      return { accepted: true, taskId, message };
    },
  }),
} satisfies ActionsModule;
