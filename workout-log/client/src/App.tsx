import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { SafeAreaTopScrim } from "@hatch/space-sdk/client";
import { api, type ApiResponse } from "./api";

type Dashboard = ApiResponse<typeof api, "getDashboard">;
type Workout = NonNullable<Dashboard["active_workout"]>;
type WorkoutSet = Workout["sets"][number];
type Routine = Workout["routine"];
type Unit = Workout["unit"];

const ROUTINE_META: Record<Routine, { label: string; day: string; count: string; warmup: string }> = {
  push: {
    label: "推",
    day: "周二",
    count: "5 个动作 · 16 组",
    warmup: "单车 5 分钟 · 弹力带绕肩 15 次 · 手臂绕环前后各 15 次 · 空杆卧推 2×12",
  },
  pull: {
    label: "拉",
    day: "周四",
    count: "6 个动作 · 20 组",
    warmup: "划船机 5 分钟 · 死悬垂 30 秒×2 · 弹力带直臂下拉 15 次 · 轻重量高位下拉 2×12",
  },
  legs: {
    label: "腿",
    day: "周日",
    count: "4 个动作 · 13 组",
    warmup: "单车 5 分钟 · 自重深蹲 15 次 · 前后腿摆动各 15 次 · 臀桥 15 次 · 空杆深蹲 2×10",
  },
};

type ExerciseGuide = {
  title: string;
  focus: string;
  setup: string;
  cues: string[];
  mistakes: string[];
  video: string;
  source: string;
};

const EXERCISE_GUIDES: Record<string, ExerciseGuide> = {
  "barbell-bench": {
    title: "杠铃卧推",
    focus: "胸大肌 · 肱三头肌 · 三角肌前束",
    setup: "眼睛在杠铃正下方，脚掌踩稳；肩胛骨向后、向下固定，手腕叠在前臂上。",
    cues: ["下放到中下胸，前臂保持接近垂直", "脚持续压地，臀部和上背贴住凳面", "动作全程让肩膀远离耳朵"],
    mistakes: ["肘部横向张到 90°", "杠铃在胸口反弹", "手腕向后折、肩胛失去固定"],
    video: "https://www.youtube.com/watch?v=CjHIKDQ4RQo",
    source: "PureGym 教练示范",
  },
  "overhead-press": {
    title: "站姿推举",
    focus: "三角肌 · 肱三头肌 · 上背稳定肌群",
    setup: "双脚与肩同宽，核心和臀部收紧；杠铃置于上胸，手腕在肘部正上方。",
    cues: ["杠铃贴近脸部直线上推", "杠铃过头后让头部回到双臂之间", "肋骨收住，不用后仰借力"],
    mistakes: ["腰椎过度反弓", "杠铃绕出很大的弧线", "用腿蹬起变成借力推举"],
    video: "https://www.youtube.com/watch?v=EK511FpyDEg",
    source: "站姿杠铃推举示范",
  },
  "incline-dumbbell-press": {
    title: "上斜哑铃卧推",
    focus: "上胸 · 三角肌前束 · 肱三头肌",
    setup: "凳背调至约 30–45°，脚踩稳；哑铃由大腿送到肩侧，肩胛向后下方固定。",
    cues: ["肘部略收，哑铃向上且微微内收", "下放到肩膀略下方并保持控制", "头、上背和臀部留在凳面"],
    mistakes: ["凳背太陡变成肩推", "底部肩膀向前卷", "两只哑铃在顶部撞击"],
    video: "https://www.youtube.com/watch?v=oZVCBM9f8Eo",
    source: "PureGym 教练示范",
  },
  dips: {
    title: "双杠臂屈伸",
    focus: "胸大肌 · 肱三头肌 · 三角肌前束",
    setup: "双手握住平行杠，肩膀主动下沉；躯干略前倾，核心收紧。",
    cues: ["控制下放到肩膀舒适的深度", "肘部向后走，不让肩膀耸起", "向下压杠并稳定推回顶部"],
    mistakes: ["追求过深导致肩前侧不适", "下放时肩膀耸向耳朵", "摆腿或反弹借力"],
    video: "https://www.youtube.com/watch?v=2HYAeF6o7Bc",
    source: "PureGym 教练示范",
  },
  "lateral-raise": {
    title: "哑铃侧平举",
    focus: "三角肌中束",
    setup: "站稳并轻微屈肘，哑铃位于身体两侧略靠前；核心保持稳定。",
    cues: ["由肘部带动向侧上方抬起", "抬到肩高附近即可", "慢速下放，肩膀始终远离耳朵"],
    mistakes: ["重量过大导致摆动", "耸肩让斜方肌代偿", "手臂抬得明显高于肩膀"],
    video: "https://www.youtube.com/watch?v=z-kOn7flIZg",
    source: "PureGym 教练示范",
  },
  "wide-lat-pulldown": {
    title: "高位下拉 · 宽握",
    focus: "背阔肌 · 大圆肌 · 肱二头肌",
    setup: "大腿垫压稳，握距略宽于肩；胸口抬起，躯干只需轻微后倾。",
    cues: ["先让肩膀下沉，再把肘部拉向身体两侧", "横杆落向上胸，不拉到颈后", "回程完全伸展但不丢掉控制"],
    mistakes: ["大幅后仰把动作变成划船", "用手臂猛拽或借惯性", "握得过宽导致动作幅度太短"],
    video: "https://www.youtube.com/shorts/UAlGHwshYBM",
    source: "高位下拉真人示范",
  },
  "close-lat-pulldown": {
    title: "高位下拉 · 窄握/反握",
    focus: "背阔肌下部 · 肱二头肌",
    setup: "反握时双手约肩宽，肘部位于手腕下方；胸口抬起、肩膀下沉。",
    cues: ["肘部贴近躯干向下拉", "横杆落向上胸", "顶部让背阔肌充分伸展"],
    mistakes: ["手腕折叠或握距过窄", "身体后仰过多", "只用肱二头肌屈肘"],
    video: "https://www.youtube.com/watch?v=UkgDc61gRcM",
    source: "反握高位下拉示范",
  },
  "close-seated-row": {
    title: "坐姿划船 · 窄距",
    focus: "背阔肌 · 菱形肌 · 肱二头肌",
    setup: "脚踩稳，脊柱保持中立；窄握把手置于身前，肩膀下沉。",
    cues: ["肘部贴近身体拉向髋部", "把手落在肚脐附近", "回程让肩胛自然前伸但不弓腰"],
    mistakes: ["身体前后大幅摇摆", "用下背甩起重量", "耸肩并只用手臂拉"],
    video: "https://www.youtube.com/watch?v=O9nVMz5osqY",
    source: "坐姿绳索划船示范",
  },
  "wide-seated-row": {
    title: "坐姿划船 · 宽距",
    focus: "上背 · 菱形肌 · 三角肌后束",
    setup: "宽握把手，胸口抬起、脊柱中立；手臂向前伸直但不塌腰。",
    cues: ["肘部向外拉，目标落点在下胸", "顶端夹紧肩胛骨", "用两秒左右控制回程"],
    mistakes: ["把宽距划船拉到肚脐", "肩膀耸起", "为了加重量缩短动作幅度"],
    video: "https://www.youtube.com/shorts/mJLT0tChvFM",
    source: "窄距与宽距划船对比示范",
  },
  "face-pull": {
    title: "面拉",
    focus: "三角肌后束 · 旋转袖 · 中下斜方肌",
    setup: "绳索调到眼睛附近，双手对握；站稳或坐稳，肋骨保持收紧。",
    cues: ["绳索拉向额头，手腕分开", "动作末端做外旋，让手位于耳朵两侧", "轻重量、短暂停顿、慢速回程"],
    mistakes: ["拉向胸口变成普通划船", "重量过大导致身体后仰", "肩膀耸起、肘部掉得太低"],
    video: "https://www.youtube.com/watch?v=4UhV4cCkugM",
    source: "坐姿绳索面拉示范",
  },
  "rope-curl": {
    title: "绳索弯举",
    focus: "肱二头肌 · 肱肌 · 肱桡肌",
    setup: "低位滑轮接绳索，身体站直；肘部固定在身体两侧，手掌相对。",
    cues: ["只让前臂移动", "顶部主动收紧，不让肩膀前移", "全程控制回程并保持张力"],
    mistakes: ["躯干前后摆动", "肘部向前漂移", "回程直接让配重砸下"],
    video: "https://www.youtube.com/watch?v=dLRVpRC4L3Y",
    source: "绳索锤式弯举示范",
  },
  "back-squat": {
    title: "深蹲",
    focus: "股四头肌 · 臀大肌 · 核心稳定肌群",
    setup: "杠铃稳定落在上背，脚掌三点压地；吸气后做 360° 核心支撑。",
    cues: ["膝盖沿脚尖方向打开", "髋和膝一起下沉", "保持足弓和背部稳定后从中足发力站起"],
    mistakes: ["膝盖向内塌", "脚跟或大脚趾离地", "为了追求深度而失去腰背中立"],
    video: "https://www.youtube.com/watch?v=nEQQle9-0NA",
    source: "深蹲动作解析",
  },
  "romanian-deadlift": {
    title: "罗马尼亚硬拉",
    focus: "腘绳肌 · 臀大肌 · 竖脊肌",
    setup: "双脚与髋同宽，膝盖微屈；杠铃贴近大腿，核心先收紧。",
    cues: ["髋部向后推，而不是向下蹲", "杠铃始终贴近腿部", "感到腘绳肌充分拉伸后用臀部向前驱动"],
    mistakes: ["膝盖越弯越多变成深蹲", "为了下得更低而弓背", "顶部过度后仰挤压腰椎"],
    video: "https://www.youtube.com/watch?v=aa57T45iFSE",
    source: "NASM 哑铃 RDL 示范",
  },
  "bulgarian-split-squat": {
    title: "保加利亚分腿蹲",
    focus: "股四头肌 · 臀大肌 · 单腿稳定",
    setup: "后脚脚背放在矮凳上，前脚向前找到稳定距离；先用自重试出站距。",
    cues: ["绝大部分重量留在前脚", "前膝沿脚尖方向移动", "后膝向地面下降，再由前脚推起"],
    mistakes: ["前脚离凳太近导致脚跟抬起", "前膝向内塌", "后腿用力过多或左右摇晃"],
    video: "https://www.youtube.com/watch?v=DeCnHqrN22U",
    source: "Buff Dudes 真人示范",
  },
  "lying-leg-curl": {
    title: "俯卧腿弯举",
    focus: "腘绳肌",
    setup: "膝关节对齐机器转轴，滚垫落在脚踝上方；髋部和腹部贴紧垫面。",
    cues: ["脚跟向臀部卷起", "顶部短暂停顿收紧腘绳肌", "用两秒左右控制下放"],
    mistakes: ["髋部离开垫面", "借助下背拱起重量", "回程过快、配重片撞击"],
    video: "https://www.youtube.com/shorts/tLyA9uXn5Wo",
    source: "俯卧腿弯举示范",
  },
};

function formatDate(value: string) {
  return new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric", weekday: "short" }).format(new Date(value));
}

function formatDuration(start: string, end?: string | null) {
  const ms = (end ? new Date(end).getTime() : Date.now()) - new Date(start).getTime();
  const minutes = Math.max(0, Math.round(ms / 60000));
  if (minutes < 60) return `${minutes} 分钟`;
  return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`;
}

function completedCount(workout: Workout) {
  return workout.sets.filter((set) => set.completed).length;
}

function trainingVolume(workout: Workout) {
  return workout.sets.reduce((sum, set) => {
    if (!set.completed || set.weight == null || set.reps == null) return sum;
    return sum + set.weight * set.reps;
  }, 0);
}

function groupSets(sets: WorkoutSet[]) {
  const groups: { key: string; name: string; target: string; sets: WorkoutSet[] }[] = [];
  for (const set of sets) {
    const existing = groups.find((group) => group.key === set.exercise_key);
    if (existing) existing.sets.push(set);
    else groups.push({ key: set.exercise_key, name: set.exercise_name, target: set.target_reps, sets: [set] });
  }
  return groups;
}

function previousCompleteWeek(now = new Date()) {
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const weekday = end.getDay();
  end.setDate(end.getDate() - (weekday === 0 ? 6 : weekday - 1));
  const start = new Date(end);
  start.setDate(start.getDate() - 7);
  return { start, end };
}

function workoutsInRange(workouts: Workout[], start: Date, end: Date) {
  return workouts.filter((workout) => {
    const completed = workout.completed_at ? new Date(workout.completed_at) : null;
    return completed != null && completed >= start && completed < end;
  });
}

function targetRange(target: string) {
  const values = target.match(/\d+/g)?.map(Number).filter(Number.isFinite) ?? [];
  const first = values[0] ?? 0;
  return { min: first, max: values[1] ?? first };
}

// W1.1–W1.4: the single progressive-overload rule — a line-for-line copy
// of progressionDecision in server/src/actions.ts (same name, signature
// and logic), so the start-of-workout prefill and this weekly review can
// never disagree about the "next time" suggestion again. Pure: no IO.
export function progressionDecision(input: {
  plannedSets: number;
  sets: { weight: number | null; reps: number | null; completed: boolean }[];
  targetMin: number;
  targetMax: number;
  unit: "lb" | "kg";
}): { action: "increase" | "hold" | "reduce" | "none"; suggestedWeight: number | null; suggestedReps: number | null } {
  const none: { action: "none"; suggestedWeight: null; suggestedReps: null } = {
    action: "none",
    suggestedWeight: null,
    suggestedReps: null,
  };
  if (input.sets.length === 0 || input.plannedSets <= 0) return none;
  const completed = input.sets.filter((set) => set.completed);
  if (completed.length === 0) return none;
  const weightedWeights = completed
    .map((set) => set.weight)
    .filter((weight): weight is number => weight != null);
  // W1.4: bodyweight / unmeasured sets (weight null) never stand in as a
  // comparable load of 0 — with no weighed completed set there is no
  // weight suggestion at all.
  if (weightedWeights.length === 0) return none;
  const base = Math.max(...weightedWeights);
  const increment = input.unit === "lb" ? 5 : 2.5;
  if (completed.length < input.plannedSets) {
    // Not all planned sets were done: hold the weight; per-set reps are
    // carried over by the caller (suggestedReps null = carry over).
    return { action: "hold", suggestedWeight: base, suggestedReps: null };
  }
  if (completed.some((set) => set.reps == null)) return none;
  if (completed.every((set) => set.weight != null && set.reps != null && set.reps >= input.targetMax)) {
    return {
      action: "increase",
      suggestedWeight: Math.round((base + increment) * 2) / 2,
      suggestedReps: input.targetMin,
    };
  }
  if (completed.some((set) => set.reps != null && set.reps < input.targetMin)) {
    return {
      action: "reduce",
      suggestedWeight: Math.max(0, Math.round((base - increment) * 2) / 2),
      suggestedReps: null,
    };
  }
  return { action: "hold", suggestedWeight: base, suggestedReps: null };
}

// W1.3: same conversion constant and rounding as the server.
export const LB_TO_KG = 0.45359237;

export function convertWeightValue(weight: number, from: Unit, to: Unit): number {
  if (from === to) return weight;
  const converted = from === "lb" ? weight * LB_TO_KG : weight / LB_TO_KG;
  return Math.round(converted * 2) / 2;
}

function compactDate(value: Date) {
  return new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric" }).format(value);
}

type ExercisePerformance = {
  key: string;
  name: string;
  unit: Unit;
  target: string;
  planned: number;
  completed: number;
  atTop: number;
  belowMin: number;
  bestWeight: number | null;
  totalReps: number;
  repsLogged: number;
};

type ExerciseReview = ExercisePerformance & {
  prior: ExercisePerformance | null;
};

function exercisePerformances(workouts: Workout[]): ExercisePerformance[] {
  const performances: ExercisePerformance[] = [];
  for (const workout of workouts) {
    for (const exercise of groupSets(workout.sets)) {
      const completedSets = exercise.sets.filter((set) => set.completed);
      const repsLogged = completedSets.filter((set) => set.reps != null);
      const { min, max } = targetRange(exercise.target);
      const existing = performances.find((item) => item.key === exercise.key && item.unit === workout.unit);
      const bestWeight = completedSets.reduce<number | null>((best, set) => {
        if (set.weight == null) return best;
        return best == null ? set.weight : Math.max(best, set.weight);
      }, null);
      if (existing) {
        existing.planned += exercise.sets.length;
        existing.completed += completedSets.length;
        existing.atTop += completedSets.filter((set) => set.reps != null && set.reps >= max).length;
        existing.belowMin += completedSets.filter((set) => set.reps != null && set.reps < min).length;
        existing.totalReps += repsLogged.reduce((sum, set) => sum + (set.reps ?? 0), 0);
        existing.repsLogged += repsLogged.length;
        if (bestWeight != null) existing.bestWeight = existing.bestWeight == null ? bestWeight : Math.max(existing.bestWeight, bestWeight);
        continue;
      }
      performances.push({
        key: exercise.key,
        name: exercise.name,
        unit: workout.unit,
        target: exercise.target,
        planned: exercise.sets.length,
        completed: completedSets.length,
        atTop: completedSets.filter((set) => set.reps != null && set.reps >= max).length,
        belowMin: completedSets.filter((set) => set.reps != null && set.reps < min).length,
        bestWeight,
        totalReps: repsLogged.reduce((sum, set) => sum + (set.reps ?? 0), 0),
        repsLogged: repsLogged.length,
      });
    }
  }
  return performances;
}

function exerciseReviews(week: Workout[], priorWeek: Workout[]): ExerciseReview[] {
  const current = exercisePerformances(week);
  const prior = exercisePerformances(priorWeek);
  return current.map((performance) => ({
    ...performance,
    prior: prior.find((item) => item.key === performance.key && item.unit === performance.unit) ?? null,
  }));
}

function averageReps(performance: ExercisePerformance) {
  if (performance.repsLogged === 0) return null;
  return Math.round((performance.totalReps / performance.repsLogged) * 10) / 10;
}

function weightTrend(review: ExerciseReview) {
  const currentAverage = averageReps(review);
  const repText = currentAverage == null ? "次数未完整记录" : `平均 ${currentAverage} 次`;
  if (review.bestWeight == null) return `未记录重量 · ${repText}`;
  if (!review.prior || review.prior.bestWeight == null) return `最高 ${review.bestWeight}${review.unit} · 前一周无同单位重量记录 · ${repText}`;
  const delta = Math.round((review.bestWeight - review.prior.bestWeight) * 10) / 10;
  const weightText = delta === 0
    ? `最高 ${review.bestWeight}${review.unit} · 连续两周持平`
    : `最高 ${review.bestWeight}${review.unit} · 较前一周${delta > 0 ? "+" : ""}${delta}${review.unit}`;
  const priorAverage = averageReps(review.prior);
  if (currentAverage == null || priorAverage == null) return `${weightText} · ${repText}`;
  const repDelta = Math.round((currentAverage - priorAverage) * 10) / 10;
  return `${weightText} · 平均次数${repDelta === 0 ? "持平" : `较前一周${repDelta > 0 ? "+" : ""}${repDelta}`}`;
}

function reviewRecommendation(review: ExerciseReview, workouts: Workout[]) {
  // W1: the "next time" suggestion is decided by this exercise's most
  // recent comparable workout in recent_workouts (same key; either unit —
  // weights are converted into the review unit first), fed through the
  // same progressionDecision the server prefill uses. The week-over-week
  // evidence above stays display-only and no longer derives a second,
  // conflicting verdict.
  let comparable: { workout: Workout; exercise: ReturnType<typeof groupSets>[number] } | null = null;
  for (const workout of workouts) {
    const exercise = groupSets(workout.sets).find((group) => group.key === review.key);
    if (exercise) {
      comparable = { workout, exercise };
      break;
    }
  }
  if (!comparable) return `${review.name}：上次没有可比重量记录，暂不做重量建议`;
  const { min, max } = targetRange(comparable.exercise.target);
  const unitConverted = comparable.workout.unit !== review.unit;
  const sets = comparable.exercise.sets.map((set) => ({
    weight: set.weight == null
      ? null
      : unitConverted
        ? convertWeightValue(set.weight, comparable.workout.unit, review.unit)
        : set.weight,
    reps: set.reps,
    completed: set.completed,
  }));
  const planned = comparable.exercise.sets.length;
  const decision = progressionDecision({
    plannedSets: planned,
    sets,
    targetMin: min,
    targetMax: max,
    unit: review.unit,
  });
  if (decision.action === "increase") {
    return `${review.name}：上次全部 ${planned} 组完成且都达到次数上限 ${max}，下次增至 ${decision.suggestedWeight}${review.unit}`;
  }
  if (decision.action === "reduce") {
    return `${review.name}：上次有组低于目标下限 ${min}，下次降至 ${decision.suggestedWeight}${review.unit}，先回到目标区间`;
  }
  if (decision.action === "hold") {
    const completedCount = sets.filter((set) => set.completed).length;
    if (completedCount < planned) {
      return `${review.name}：上次少完成 ${planned - completedCount} 组，下次保持 ${decision.suggestedWeight}${review.unit}`;
    }
    return `${review.name}：上次未全部达到次数上限，下次保持 ${decision.suggestedWeight}${review.unit}`;
  }
  return `${review.name}：上次没有可比重量记录，暂不做重量建议`;
}

function WeeklyReview({ workouts }: { workouts: Workout[] }) {
  const { start, end } = previousCompleteWeek();
  const priorStart = new Date(start);
  priorStart.setDate(priorStart.getDate() - 7);
  const week = workoutsInRange(workouts, start, end);
  const priorWeek = workoutsInRange(workouts, priorStart, start);
  const sets = week.reduce((sum, workout) => sum + completedCount(workout), 0);
  const routines = new Set(week.map((workout) => workout.routine));
  const completeRound = (Object.keys(ROUTINE_META) as Routine[]).every((routine) =>
    week.some((workout) => workout.routine === routine && workout.sets.length > 0 && workout.sets.every((set) => set.completed)),
  );
  const missing = (Object.keys(ROUTINE_META) as Routine[]).filter((routine) => !routines.has(routine));
  const reviews = exerciseReviews(week, priorWeek);
  const recommendations = reviews.map((review) => reviewRecommendation(review, workouts));
  const endInclusive = new Date(end);
  endInclusive.setDate(endInclusive.getDate() - 1);

  return (
    <section className="weekly-review" aria-labelledby="weekly-review-title">
      <div className="review-header">
        <div>
          <p>上个完整周 · {compactDate(start)}–{compactDate(endInclusive)}</p>
          <h2 id="weekly-review-title">
            {week.length === 0 ? "暂无训练可复盘" : completeRound ? "按实际表现微调" : "先完成完整一轮"}
          </h2>
        </div>
        <span>{week.length} 次 · {sets} 组</span>
      </div>
      <p className="review-body">
        {week.length === 0
          ? "上周一到周日没有完成记录。沿用当前安排，完成推、拉、腿各一练后再判断动作调整。"
          : completeRound
            ? "上周已完成推、拉、腿各一轮。负荷建议只看最近一次可比训练：全部组完成且都达到次数上限才增重，有组低于下限则建议降重，未完成则保持，无可比记录不给建议。"
            : `上周${routines.size > 0 ? `记录了 ${Array.from(routines).map((routine) => ROUTINE_META[routine].label).join("、")}` : "没有有效训练"}${missing.length > 0 ? `，缺少 ${missing.map((routine) => ROUTINE_META[routine].label).join("、")}` : "，但至少一次训练未完成全部组数"}；已记录动作仍按最近一次可比训练判断负荷：全部组完成且都达到次数上限才增重，有组低于下限则建议降重，未完成则保持，无可比记录不给建议。`}
      </p>

      {reviews.length > 0 ? (
        <details className="review-evidence">
          <summary>查看各动作表现依据 <span>{reviews.length} 个动作</span></summary>
          <div>
            {reviews.map((review) => (
              <p key={`${review.key}-${review.unit}`}>
                <strong>{review.name}</strong>
                <span>
                  本周 {review.completed}/{review.planned} 组 · {review.atTop} 组到上限
                  {review.prior ? `；前周 ${review.prior.atTop}/${review.prior.completed} 组到上限` : "；前周无记录"}
                </span>
                <small>{weightTrend(review)}</small>
              </p>
            ))}
          </div>
        </details>
      ) : null}

      <div className="review-change">
        <span>下周调整</span>
        {week.length === 0 ? (
          <>
            <strong>暂不新增动作</strong>
            <p>先补齐一轮推、拉、腿；空缺数据不当作训练短板，也不据此改动作。</p>
          </>
        ) : (
          <>
            <strong>动作结构不变，按最近一次可比训练调负荷</strong>
            <ul>{recommendations.map((recommendation) => <li key={recommendation}>{recommendation}</li>)}</ul>
            <p>
              {completeRound
                ? "增重幅度与训练预填一致：lb +5、kg +2.5。只有连续几周仍出现明确短板，才考虑替换或新增动作。"
                : "未练到的训练日不当作短板；先补齐完整一轮，再考虑替换或新增动作。"}
            </p>
          </>
        )}
      </div>
    </section>
  );
}

function ExerciseGuideDialog({ guide, onClose }: { guide: ExerciseGuide; onClose: () => void }) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [onClose]);

  return (
    <div className="guide-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <section className="guide-dialog" role="dialog" aria-modal="true" aria-labelledby="guide-title">
        <div className="guide-topbar">
          <div>
            <p>动作要领</p>
            <h2 id="guide-title">{guide.title}</h2>
          </div>
          <button type="button" aria-label="关闭动作要领" onClick={onClose}>×</button>
        </div>
        <p className="guide-focus">{guide.focus}</p>
        <div className="guide-section">
          <h3>起始位置</h3>
          <p>{guide.setup}</p>
        </div>
        <div className="guide-grid">
          <div>
            <h3>记住这三点</h3>
            <ol>{guide.cues.map((cue) => <li key={cue}>{cue}</li>)}</ol>
          </div>
          <div>
            <h3>常见错误</h3>
            <ul>{guide.mistakes.map((mistake) => <li key={mistake}>{mistake}</li>)}</ul>
          </div>
        </div>
        <a className="video-link" href={guide.video} target="_blank" rel="noreferrer">
          <span aria-hidden="true">▶</span>
          <span><strong>看真人教学视频</strong><small>{guide.source} · 在 YouTube 打开</small></span>
          <i aria-hidden="true">↗</i>
        </a>
        <p className="guide-safety">动作疼痛时立即停止；视频用于学习动作，不替代现场教练或医疗建议。</p>
      </section>
    </div>
  );
}

// --- W-UI-001 / W0.1 / W0.2: per-set autosave state machine (pure) ---
// A set's draft is autosaved on blur / Enter / short debounce instead of
// only when the completed toggle is flipped. Status is explicit text
// (dirty / saving / saved / error), never colour alone. Saves carry a
// per-set increasing sequence number: only the latest issued save may
// move the status, so a slow earlier response arriving after a newer
// save cannot flip the row back to saved/error. A server refresh only
// adopts new values while the row is clean (saved); dirty / saving /
// error drafts are never overwritten by a refetch.
export type SetDraft = { weight: string; reps: string; completed: boolean };
export type SetSaveStatus = "saved" | "dirty" | "saving" | "error";
export type SetSaveMachine = {
  confirmed: SetDraft;
  draft: SetDraft;
  status: SetSaveStatus;
  seq: number;
  inflightSeq: number | null;
  inflightDraft: SetDraft | null;
};

export function setDraftFromSet(set: WorkoutSet): SetDraft {
  return {
    weight: set.weight == null ? "" : String(set.weight),
    reps: set.reps == null ? "" : String(set.reps),
    completed: set.completed,
  };
}

export function sameSetDraft(a: SetDraft, b: SetDraft): boolean {
  return a.weight === b.weight && a.reps === b.reps && a.completed === b.completed;
}

export function initSetSaveMachine(set: WorkoutSet): SetSaveMachine {
  const draft = setDraftFromSet(set);
  return { confirmed: draft, draft, status: "saved", seq: 0, inflightSeq: null, inflightDraft: null };
}

export function setSaveBlocked(machine: SetSaveMachine): boolean {
  return machine.draft.completed && machine.draft.reps.trim() === "";
}

export function editSetDraft(machine: SetSaveMachine, draft: SetDraft): SetSaveMachine {
  let status: SetSaveStatus;
  if (machine.inflightDraft) {
    // A write is in flight: only the exact in-flight payload reads as
    // saving. Anything else is dirty — including reverting to the old
    // confirmed values, which must never read as saved while the write
    // is still undecided.
    status = sameSetDraft(draft, machine.inflightDraft) ? "saving" : "dirty";
  } else if (sameSetDraft(draft, machine.confirmed)) {
    status = "saved";
  } else {
    status = "dirty";
  }
  return { ...machine, draft, status };
}

export type BeginSetSaveResult = { machine: SetSaveMachine; seq: number };

export function beginSetSave(machine: SetSaveMachine): BeginSetSaveResult | null {
  if (sameSetDraft(machine.draft, machine.confirmed)) return null;
  if (setSaveBlocked(machine)) return null;
  const seq = machine.seq + 1;
  return {
    machine: { ...machine, status: "saving", seq, inflightSeq: seq, inflightDraft: machine.draft },
    seq,
  };
}

export function applySetSaveSuccess(machine: SetSaveMachine, seq: number): SetSaveMachine {
  if (seq !== machine.seq || machine.inflightDraft == null) return machine;
  const confirmed = machine.inflightDraft;
  return {
    ...machine,
    confirmed,
    status: sameSetDraft(machine.draft, confirmed) ? "saved" : "dirty",
    inflightSeq: null,
    inflightDraft: null,
  };
}

export function applySetSaveFailure(machine: SetSaveMachine, seq: number): SetSaveMachine {
  if (seq !== machine.seq || machine.inflightDraft == null) return machine;
  const failedDraft = machine.inflightDraft;
  return {
    ...machine,
    status: sameSetDraft(machine.draft, failedDraft) ? "error" : "dirty",
    inflightSeq: null,
    inflightDraft: null,
  };
}

export function adoptServerDraft(machine: SetSaveMachine, serverDraft: SetDraft): SetSaveMachine {
  if (machine.status !== "saved") return machine;
  return { ...machine, confirmed: serverDraft, draft: serverDraft };
}

export function setSaveStatusLabel(status: SetSaveStatus): string {
  if (status === "dirty") return "未保存";
  if (status === "saving") return "保存中…";
  if (status === "error") return "保存失败";
  return "已保存";
}

export function hasUnsavedSetStatus(statuses: SetSaveStatus[]): boolean {
  return statuses.some((status) => status !== "saved");
}

export type SetSaveHandle = {
  id: number;
  // W-UI-001-D1: owning exercise, for the top save aggregate's
  // first-abnormal jump and per-exercise head status.
  exerciseKey: string;
  getStatus: () => SetSaveStatus;
  flush: () => Promise<boolean>;
  isBlocked: () => boolean;
  isCompleted: () => boolean;
  seal: () => void;
  // W-FINISH-001: seal the queue (no new writes) AND wait for the
  // in-flight drain to fully settle — its success/failure applied to
  // the machine — before resolving. Resolves true only when the row
  // ends up clean (saved, unblocked, nothing in flight).
  sealAndSettle: () => Promise<boolean>;
  // Undo a seal (e.g. a finish attempt failed): the row becomes
  // editable and saveable again with its draft untouched.
  unseal: () => void;
};

// --- W-UI-001 rework: single-writer save queue per set ---
// drainSetSaves is the only loop that issues writes for a set. Each
// successful save re-reads the latest machine; if the draft moved on
// while the write was in flight, the loop saves the newest draft (the
// intermediate values are coalesced — only the latest full payload is
// sent) until the row is clean, blocked, or a save fails. The business
// result is checked, not just transport success: a resolved response
// with ok !== true (e.g. { ok: false, forbidden: true }) takes the
// same failure path as a thrown error — input kept, status error /
// dirty, retryable, never marked saved. Once sealed, the drain issues
// no new writes.
export type SetSaveEnv = {
  getMachine: () => SetSaveMachine;
  setMachine: (machine: SetSaveMachine) => void;
  send: (draft: SetDraft) => Promise<{ ok: boolean }>;
  isSealed: () => boolean;
  onSaved: () => void;
};

export async function drainSetSaves(env: SetSaveEnv): Promise<boolean> {
  for (;;) {
    if (env.isSealed()) return false;
    const begun = beginSetSave(env.getMachine());
    if (!begun) {
      const machine = env.getMachine();
      return machine.status === "saved" && !setSaveBlocked(machine) && machine.inflightDraft == null;
    }
    env.setMachine(begun.machine);
    const payload = begun.machine.inflightDraft;
    if (!payload) return false;
    let result: { ok: boolean };
    try {
      result = await env.send(payload);
    } catch {
      env.setMachine(applySetSaveFailure(env.getMachine(), begun.seq));
      return false;
    }
    if (!result || result.ok !== true) {
      env.setMachine(applySetSaveFailure(env.getMachine(), begun.seq));
      return false;
    }
    env.setMachine(applySetSaveSuccess(env.getMachine(), begun.seq));
    env.onSaved();
  }
}

// createSaveQueue funnels every save request for one set through a
// single shared drain: concurrent requestSave / flush callers join the
// same in-flight promise instead of each issuing their own write after
// waiting, so at most one write per set is ever in flight.
export type SetSaveQueue = {
  requestSave: () => Promise<boolean>;
  flush: () => Promise<boolean>;
  // W-FINISH-001: join the in-flight drain (if any) and resolve with
  // the machine's settled state. Never starts a new write: with no
  // drain running it reports purely from the current machine state.
  settle: () => Promise<boolean>;
};

export function createSaveQueue(env: SetSaveEnv): SetSaveQueue {
  let running: Promise<boolean> | null = null;
  const start = (): Promise<boolean> => {
    if (env.isSealed()) return Promise.resolve(false);
    if (running) return running;
    const run = drainSetSaves(env);
    running = run;
    const clear = () => {
      if (running === run) running = null;
    };
    void run.then(clear, clear);
    return run;
  };
  const settledClean = (): boolean => {
    const machine = env.getMachine();
    return machine.status === "saved" && !setSaveBlocked(machine) && machine.inflightDraft == null;
  };
  const settle = async (): Promise<boolean> => {
    if (running) {
      // Wait for the drain to finish applying its outcome to the
      // machine, then judge cleanliness from that settled state — the
      // drain itself may report false simply because the queue was
      // sealed mid-flight even though the write landed.
      await running;
    }
    return settledClean();
  };
  return { requestSave: start, flush: start, settle };
}

// --- W-FINISH-001: finish flush over a consistent handle set ---
// Collect the registered set handles, flush them, then re-read the
// registry: if the set changed while flushing (e.g. an add-set request
// landed mid-flush and registered a brand-new row), flush the new set
// again. Only a round whose handle set is identical before and after
// its flush is a stable batch whose results may feed the finish gate;
// an unstable batch must be treated as unsaved, never completed on.
export type FlushAllHandlesResult = {
  handles: SetSaveHandle[];
  results: boolean[];
  stable: boolean;
};

export async function flushAllHandles(
  getHandles: () => SetSaveHandle[],
  maxRounds = 3,
): Promise<FlushAllHandlesResult> {
  let lastHandles: SetSaveHandle[] = [];
  let lastResults: boolean[] = [];
  for (let round = 0; round < maxRounds; round += 1) {
    const handles = getHandles();
    const results = await Promise.all(handles.map((handle) => handle.flush().catch(() => false)));
    lastHandles = handles;
    lastResults = results;
    const afterIds = getHandles().map((handle) => handle.id);
    const stable = handles.length === afterIds.length
      && handles.every((handle, index) => handle.id === afterIds[index]);
    if (stable) return { handles, results, stable: true };
  }
  return { handles: lastHandles, results: lastResults, stable: false };
}

// --- W-FINISH-001 (stable seal boundary): the confirmed-finish twin
// of flushAllHandles. Seal-and-settle the current registry, then
// re-read it: a handle registered mid-round (e.g. an add-set landing
// while earlier queues settled) must itself be sealed and settled
// before complete is sent, so repeat until one full round ends with
// the registry identical to the round's start. Only then is the batch
// stable; exhausting the rounds reports stable: false and the caller
// must abort the finish (unseal everything) rather than complete over
// unchecked sets.
export type SealAllAndSettleStableResult = {
  handles: SetSaveHandle[];
  results: boolean[];
  stable: boolean;
};

export async function sealAllAndSettleStable(
  getHandles: () => SetSaveHandle[],
  maxRounds = 5,
): Promise<SealAllAndSettleStableResult> {
  let lastHandles: SetSaveHandle[] = [];
  let lastResults: boolean[] = [];
  for (let round = 0; round < maxRounds; round += 1) {
    const handles = getHandles();
    const results = await Promise.all(handles.map((handle) => handle.sealAndSettle().catch(() => false)));
    lastHandles = handles;
    lastResults = results;
    const afterIds = getHandles().map((handle) => handle.id);
    const stable = handles.length === afterIds.length
      && handles.every((handle, index) => handle.id === afterIds[index]);
    if (stable) return { handles, results, stable: true };
  }
  return { handles: lastHandles, results: lastResults, stable: false };
}

// --- W-FINISH-001 (in-flight addSet joins the finish boundary) ---
// "+ 加一组" clicks register their mutateAsync promise — a chain
// that only settles after the add landed AND the dashboard
// invalidation/refetch completed — into a registry shared at the
// ActiveWorkout level. Before any finish path may flush or seal, it
// joins the registry until it is empty AND stable: await the current
// batch, re-read (a settle may have surfaced a further registration),
// and when a read comes back empty, yield one macrotask and confirm
// it is STILL empty — an add issued in the same tick as the finish
// press registers during that yield and is then awaited like any
// other. A rejected add is a finish failure, never a silent success:
// { ok: false }. Exhausting the rounds with a registry that never
// empties reports { ok: false, stable: false } so the caller aborts
// the finish instead of completing over an unchecked new set.
export type SettlePendingAddsResult = { ok: boolean; stable: boolean };

export async function settlePendingAdds(
  getPending: () => Promise<unknown>[],
  maxRounds = 10,
): Promise<SettlePendingAddsResult> {
  for (let round = 0; round < maxRounds; round += 1) {
    const pending = getPending();
    if (pending.length > 0) {
      try {
        await Promise.all(pending);
      } catch {
        return { ok: false, stable: true };
      }
      continue;
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (getPending().length === 0) return { ok: true, stable: true };
  }
  return getPending().length === 0
    ? { ok: true, stable: true }
    : { ok: false, stable: false };
}

// --- W-UI-001 rework: finish gate ---
// Finish proceeds only when every set flushed clean, is saved, is not
// blocked (completed without reps), and is completed. Otherwise the
// reason is picked by priority: unsaved > blocked > incomplete.
export type FinishGateSnapshot = {
  flushOk: boolean;
  status: SetSaveStatus;
  blocked: boolean;
  completed: boolean;
};
export type FinishGateReason = "unsaved" | "blocked" | "incomplete";
export type FinishGateDecision = { proceed: boolean; reason: FinishGateReason | null };

export function finishGateDecision(snapshots: FinishGateSnapshot[]): FinishGateDecision {
  const allClean = snapshots.every(
    (snapshot) => snapshot.flushOk && snapshot.status === "saved" && !snapshot.blocked && snapshot.completed,
  );
  if (allClean) return { proceed: true, reason: null };
  if (snapshots.some((snapshot) => !snapshot.flushOk || snapshot.status !== "saved")) {
    return { proceed: false, reason: "unsaved" };
  }
  if (snapshots.some((snapshot) => snapshot.blocked)) {
    return { proceed: false, reason: "blocked" };
  }
  return { proceed: false, reason: "incomplete" };
}

// --- W-UI-001-D1: top save aggregate (pure) ---
// The aggregate is a pure projection of the registered save handles:
// it never becomes a save source of truth. Priority is fixed — a save
// failure outranks a blocked (completed-but-missing-reps) set, which
// outranks a dirty draft, then saving; a pending add or a finish in
// progress must never read as "全部已保存".
export type SetSaveSnapshot = {
  id: number;
  exerciseKey: string;
  status: SetSaveStatus;
  blocked: boolean;
};
export type SaveAggregateKind = "error" | "blocked" | "dirty" | "saving" | "adding" | "finishing" | "saved";
export type SaveAggregate = {
  kind: SaveAggregateKind;
  label: string;
  errorCount: number;
  blockedCount: number;
  firstAbnormal: { exerciseKey: string; setId: number; blocked: boolean } | null;
};

export function aggregateSaveStates(
  snapshots: SetSaveSnapshot[],
  flags: { pendingAdds: number; finishing: boolean },
): SaveAggregate {
  const errors = snapshots.filter((snapshot) => snapshot.status === "error");
  const blockedList = snapshots.filter((snapshot) => snapshot.blocked);
  const counts = { errorCount: errors.length, blockedCount: blockedList.length };
  const abnormalOf = (snapshot: SetSaveSnapshot) => ({
    exerciseKey: snapshot.exerciseKey,
    setId: snapshot.id,
    blocked: snapshot.blocked,
  });
  if (errors.length > 0) {
    return { kind: "error", label: `有 ${errors.length} 组保存失败`, ...counts, firstAbnormal: abnormalOf(errors[0]) };
  }
  if (blockedList.length > 0) {
    return { kind: "blocked", label: `有 ${blockedList.length} 组需补次数`, ...counts, firstAbnormal: abnormalOf(blockedList[0]) };
  }
  const dirty = snapshots.filter((snapshot) => snapshot.status === "dirty");
  if (dirty.length > 0) {
    return { kind: "dirty", label: "有未保存的修改", ...counts, firstAbnormal: abnormalOf(dirty[0]) };
  }
  if (snapshots.some((snapshot) => snapshot.status === "saving")) {
    return { kind: "saving", label: "正在保存", ...counts, firstAbnormal: null };
  }
  if (flags.finishing) {
    return { kind: "finishing", label: "正在结束…", ...counts, firstAbnormal: null };
  }
  if (flags.pendingAdds > 0) {
    return { kind: "adding", label: "正在添加一组", ...counts, firstAbnormal: null };
  }
  return { kind: "saved", label: "全部已保存", ...counts, firstAbnormal: null };
}

// --- W-UI-001-D1: current exercise selection (pure) ---
// A manual header selection wins while that exercise still exists and
// is never stolen by save callbacks or timer ticks; otherwise the
// first exercise with an incomplete set; when everything is complete
// the last exercise stays current so the page never collapses to none.
export type ExerciseProgressSummary = { key: string; hasIncomplete: boolean };

export function resolveCurrentExerciseKey(
  groups: ExerciseProgressSummary[],
  selectedKey: string | null,
): string | null {
  if (groups.length === 0) return null;
  if (selectedKey != null && groups.some((group) => group.key === selectedKey)) return selectedKey;
  const firstIncomplete = groups.find((group) => group.hasIncomplete);
  return (firstIncomplete ?? groups[groups.length - 1]).key;
}

export type ExerciseHeadInfo = {
  doneCount: number;
  statusText: string | null;
  statusKind: SaveAggregateKind | null;
};

export function exerciseHeadInfo(doneCount: number, snapshots: SetSaveSnapshot[]): ExerciseHeadInfo {
  const errors = snapshots.filter((snapshot) => snapshot.status === "error");
  if (errors.length > 0) {
    return { doneCount, statusText: `有 ${errors.length} 组保存失败`, statusKind: "error" };
  }
  const blockedList = snapshots.filter((snapshot) => snapshot.blocked);
  if (blockedList.length > 0) {
    return {
      doneCount,
      statusText: blockedList.length > 1 ? `${blockedList.length} 组需补次数` : "需补次数",
      statusKind: "blocked",
    };
  }
  if (snapshots.some((snapshot) => snapshot.status === "dirty")) {
    return { doneCount, statusText: "有未保存修改", statusKind: "dirty" };
  }
  if (snapshots.some((snapshot) => snapshot.status === "saving")) {
    return { doneCount, statusText: "保存中…", statusKind: "saving" };
  }
  return { doneCount, statusText: null, statusKind: null };
}

// --- W-UI-001-D1: keyboard next-field order (pure) ---
// Enter moves weight -> this set's reps -> next set's weight, across
// exercises in group order; the last field falls back to the finish
// button. Enter never toggles completion.
export type FocusFieldRef = { exerciseKey: string; setId: number; field: "weight" | "reps" };
export type FocusTarget = { kind: "field"; target: FocusFieldRef } | { kind: "finish" };

export function buildFocusOrder(groups: { key: string; sets: { id: number }[] }[]): FocusFieldRef[] {
  const order: FocusFieldRef[] = [];
  for (const group of groups) {
    for (const set of group.sets) {
      order.push({ exerciseKey: group.key, setId: set.id, field: "weight" });
      order.push({ exerciseKey: group.key, setId: set.id, field: "reps" });
    }
  }
  return order;
}

export function nextFocusTarget(order: FocusFieldRef[], current: FocusFieldRef): FocusTarget | null {
  const index = order.findIndex(
    (entry) => entry.exerciseKey === current.exerciseKey && entry.setId === current.setId && entry.field === current.field,
  );
  if (index < 0) return null;
  if (index === order.length - 1) return { kind: "finish" };
  return { kind: "field", target: order[index + 1] };
}

export type RestTimerState = {
  endsAt: number | null;
  durationSec: number;
  muted: boolean;
  done: boolean;
  // W-TIMER-001: per-workout opt-out for auto-starting the rest timer on
  // a completed set. In-memory only — never persisted anywhere.
  autoEnabled: boolean;
};

export const REST_DURATIONS = [60, 90, 120];
export const DEFAULT_REST_SEC = 90;

export function initRestTimer(durationSec: number = DEFAULT_REST_SEC): RestTimerState {
  return {
    endsAt: null,
    durationSec: REST_DURATIONS.includes(durationSec) ? durationSec : DEFAULT_REST_SEC,
    muted: false,
    done: false,
    autoEnabled: true,
  };
}

// Flips only the auto-start switch: an in-progress countdown keeps its
// endsAt, and turning auto back on does not start a timer by itself —
// the next completed set does.
export function toggleRestAuto(state: RestTimerState): RestTimerState {
  return { ...state, autoEnabled: !state.autoEnabled };
}

export function shouldAutoStartRest(state: RestTimerState): boolean {
  return state.autoEnabled;
}

export function startRestTimer(state: RestTimerState, nowMs: number): RestTimerState {
  return { ...state, endsAt: nowMs + state.durationSec * 1000, done: false };
}

export function restRemainingSec(state: RestTimerState, nowMs: number): number | null {
  if (state.endsAt == null) return null;
  return Math.max(0, Math.ceil((state.endsAt - nowMs) / 1000));
}

export function restTimerDone(state: RestTimerState, nowMs: number): boolean {
  return state.endsAt != null && nowMs >= state.endsAt;
}

export function addRestTime(state: RestTimerState, seconds: number, nowMs: number): RestTimerState {
  if (state.endsAt == null) return state;
  if (nowMs >= state.endsAt) return { ...state, endsAt: nowMs + seconds * 1000, done: false };
  return { ...state, endsAt: state.endsAt + seconds * 1000 };
}

export function skipRestTimer(state: RestTimerState): RestTimerState {
  return { ...state, endsAt: null, done: false };
}

export function setRestDuration(state: RestTimerState, seconds: number): RestTimerState {
  if (!REST_DURATIONS.includes(seconds)) return state;
  return { ...state, durationSec: seconds };
}

export function toggleRestMuted(state: RestTimerState): RestTimerState {
  return { ...state, muted: !state.muted };
}

export function restTimerLabel(state: RestTimerState, nowMs: number): string {
  if (state.endsAt == null) return "";
  if (restTimerDone(state, nowMs)) return "休息结束";
  const remaining = restRemainingSec(state, nowMs) ?? 0;
  const minutes = Math.floor(remaining / 60);
  const seconds = remaining % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function playRestBeep() {
  try {
    const AudioCtor = window.AudioContext
      ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtor) return;
    const context = new AudioCtor();
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = "sine";
    oscillator.frequency.value = 880;
    gain.gain.setValueAtTime(0.0001, context.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.22, context.currentTime + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.45);
    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.start();
    oscillator.stop(context.currentTime + 0.5);
    oscillator.onended = () => {
      void context.close();
    };
  } catch {
    // Audio is a nicety only; the on-screen 休息结束 state still shows.
  }
}

function SetRow({ set, unit, locked, onSaved, onRegister, onCompleted, onEnterNext }: {
  set: WorkoutSet;
  unit: Unit;
  // W-UI-001-D1: after Enter's blur-save, the owner moves focus along
  // buildFocusOrder; Enter itself never toggles completion.
  onEnterNext?: (field: "weight" | "reps") => void;
  // W-FINISH-001: while a finish flow owns the workout, entry is
  // locked — inputs, the completion toggle and retry are disabled so
  // no new edit can start behind the seal.
  locked: boolean;
  onSaved: () => void;
  onRegister: (id: number, handle: SetSaveHandle | null) => void;
  onCompleted?: () => void;
}) {
  const [machine, setMachineState] = useState<SetSaveMachine>(() => initSetSaveMachine(set));
  const machineRef = useRef(machine);
  const timerRef = useRef<number | null>(null);
  const sealedRef = useRef(false);
  const onSavedRef = useRef(onSaved);
  onSavedRef.current = onSaved;

  const setMachine = (next: SetSaveMachine) => {
    machineRef.current = next;
    setMachineState(next);
  };

  // All saves for this set go through one queue: at most one updateSet
  // in flight, concurrent callers share the same drain promise.
  const [saveQueue] = useState<SetSaveQueue>(() => createSaveQueue({
    getMachine: () => machineRef.current,
    setMachine: (next) => {
      machineRef.current = next;
      setMachineState(next);
    },
    send: async (payload: SetDraft) => await api.updateSet({
      id: set.id,
      weight: payload.weight.trim() === "" ? null : Number(payload.weight),
      reps: payload.reps.trim() === "" ? null : Number(payload.reps),
      completed: payload.completed,
    }),
    isSealed: () => sealedRef.current,
    onSaved: () => onSavedRef.current(),
  }));

  useEffect(() => {
    setMachine(adoptServerDraft(machineRef.current, setDraftFromSet(set)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [set.id, set.weight, set.reps, set.completed]);

  useEffect(() => () => {
    if (timerRef.current != null) window.clearTimeout(timerRef.current);
    onRegister(set.id, null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [set.id]);

  function requestSave(): Promise<boolean> {
    return saveQueue.requestSave();
  }

  async function flushSave(): Promise<boolean> {
    if (timerRef.current != null) window.clearTimeout(timerRef.current);
    const ok = await saveQueue.flush();
    const current = machineRef.current;
    return ok && current.status === "saved" && !setSaveBlocked(current) && current.inflightDraft == null;
  }

  useEffect(() => {
    onRegister(set.id, {
      id: set.id,
      exerciseKey: set.exercise_key,
      getStatus: () => machineRef.current.status,
      flush: flushSave,
      isBlocked: () => setSaveBlocked(machineRef.current),
      isCompleted: () => machineRef.current.draft.completed,
      seal: () => {
        sealedRef.current = true;
        if (timerRef.current != null) window.clearTimeout(timerRef.current);
      },
      sealAndSettle: async () => {
        sealedRef.current = true;
        if (timerRef.current != null) window.clearTimeout(timerRef.current);
        return saveQueue.settle();
      },
      unseal: () => {
        sealedRef.current = false;
      },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [set.id, machine]);

  function scheduleDebounce() {
    if (timerRef.current != null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => { void requestSave(); }, 800);
  }

  function editDraft(draft: SetDraft, immediate: boolean) {
    setMachine(editSetDraft(machineRef.current, draft));
    if (timerRef.current != null) window.clearTimeout(timerRef.current);
    if (immediate) void requestSave();
    else scheduleDebounce();
  }

  function numericChange(event: ChangeEvent<HTMLInputElement>, field: "weight" | "reps") {
    const draft = { ...machineRef.current.draft, [field]: event.target.value };
    editDraft(draft, false);
  }

  function onBlurSave() {
    if (timerRef.current != null) window.clearTimeout(timerRef.current);
    void requestSave();
  }

  function onEnterSave(event: ReactKeyboardEvent<HTMLInputElement>, field: "weight" | "reps") {
    if (event.key === "Enter") {
      event.preventDefault();
      // Blur first: the normal blur-save path runs, then the owner
      // moves focus along the D1 focus order.
      event.currentTarget.blur();
      onEnterNext?.(field);
    }
  }

  function toggleCompleted() {
    const next = { ...machineRef.current.draft, completed: !machineRef.current.draft.completed };
    editDraft(next, true);
    // Only a fresh completion that is not blocked by 先填次数 starts the
    // rest timer; un-completing a set never does.
    if (next.completed && !setSaveBlocked({ ...machineRef.current, draft: next })) onCompleted?.();
  }

  const { draft, status } = machine;
  const blocked = setSaveBlocked(machine);

  return (
    <div className={`set-row ${draft.completed ? "is-complete" : ""}`}>
      <span className="set-index" aria-label={`第 ${set.set_number} 组`}>{set.set_number}</span>
      <label className="field-wrap">
        <span className="sr-only">第 {set.set_number} 组重量（{unit}）</span>
        <input
          aria-label={`${set.exercise_name} 第 ${set.set_number} 组重量，单位 ${unit}`}
          data-focus-set={set.id}
          data-focus-field="weight"
          inputMode="decimal"
          type="number"
          min="0"
          step="0.5"
          value={draft.weight}
          disabled={locked}
          onChange={(event) => numericChange(event, "weight")}
          onBlur={onBlurSave}
          onKeyDown={(event) => onEnterSave(event, "weight")}
          placeholder="—"
        />
        <small>{unit}</small>
      </label>
      <label className="field-wrap">
        <span className="sr-only">第 {set.set_number} 组次数</span>
        <input
          aria-label={`${set.exercise_name} 第 ${set.set_number} 组次数`}
          data-focus-set={set.id}
          data-focus-field="reps"
          inputMode="numeric"
          type="number"
          min="0"
          step="1"
          value={draft.reps}
          disabled={locked}
          onChange={(event) => numericChange(event, "reps")}
          onBlur={onBlurSave}
          onKeyDown={(event) => onEnterSave(event, "reps")}
          placeholder={set.target_reps}
        />
        <small>次</small>
      </label>
      <button
        className="set-check"
        type="button"
        aria-label={draft.completed ? `${set.exercise_name} 第 ${set.set_number} 组取消完成` : `${set.exercise_name} 第 ${set.set_number} 组完成`}
        aria-pressed={draft.completed}
        disabled={locked}
        onClick={toggleCompleted}
      >
        {draft.completed ? "✓" : ""}
      </button>
      <div className="set-status" data-status={status} role="status">
        <span>{blocked ? "先填次数" : setSaveStatusLabel(status)}</span>
        {status === "error" ? (
          <button type="button" className="set-retry" disabled={locked} onClick={() => void requestSave()}>重试</button>
        ) : null}
      </div>
    </div>
  );
}

// W1.3: the "上次" mark for an exercise — the latest completed set's
// weight/reps, with the weight already converted into the active
// workout's unit when the source workout used the other unit.
export type PreviousMark = { weight: number | null; reps: number | null; converted: boolean };

function ExerciseBlock({ workout, exercise, previous, timerSlot, entryLocked, expanded, headInfo, onSelect, onEnterNextSet, onChanged, onSetCompleted, onOpenGuide, onRegisterSet, onRegisterPendingAdd }: {
  workout: Workout;
  exercise: ReturnType<typeof groupSets>[number];
  previous?: PreviousMark;
  // W-UI-001-D1: single-expand card. The body is only hidden with the
  // `hidden` attribute — SetRows stay mounted and their save handles
  // stay registered, so an in-flight draft survives a card switch.
  expanded: boolean;
  headInfo: ExerciseHeadInfo;
  onSelect: () => void;
  onEnterNextSet: (setId: number, field: "weight" | "reps") => void;
  // W-TIMER-001: the rest-timer UI (auto toggle + panel) injected by
  // ActiveWorkout into the current exercise's block only. Purely an
  // extra child node — SetRow mounting/registration is untouched.
  timerSlot?: ReactNode;
  // W-FINISH-001: entry lock while a finish flow owns the workout —
  // set rows render disabled and no new set can be added.
  entryLocked: boolean;
  onChanged: () => void;
  onSetCompleted: () => void;
  onOpenGuide: (guide: ExerciseGuide) => void;
  onRegisterSet: (id: number, handle: SetSaveHandle | null) => void;
  // W-FINISH-001: an in-flight add registers its promise (which only
  // settles after the dashboard invalidation/refetch completes) into
  // ActiveWorkout's shared pending-add registry, so a finish flow
  // joins it before flushing or sealing anything.
  onRegisterPendingAdd: (promise: Promise<unknown>) => void;
}) {
  const queryClient = useQueryClient();
  const addSet = useMutation({
    mutationFn: () => api.addSet({ workout_id: workout.id, exercise_key: exercise.key }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["dashboard"] });
      onChanged();
    },
  });
  const guide = EXERCISE_GUIDES[exercise.key];

  // The promise is registered synchronously in the click, before any
  // later finish press can run, and unregistered by the registry
  // owner when it settles.
  function handleAddSet() {
    let promise: Promise<unknown>;
    try {
      promise = addSet.mutateAsync();
    } catch (error) {
      promise = Promise.reject(error);
    }
    onRegisterPendingAdd(promise);
    void promise.catch(() => {});
  }

  return (
    <section className="exercise-block" aria-labelledby={`exercise-${exercise.key}`}>
      <div className="exercise-heading">
        <div className="exercise-side">
          <button
            className="exercise-select"
            type="button"
            aria-expanded={expanded}
            aria-label={`${exercise.name}，${headInfo.doneCount}/${exercise.sets.length} 组完成${headInfo.statusText ? `，${headInfo.statusText}` : ""}`}
            onClick={onSelect}
          >
            <span className="exercise-title-line">
              <h2 id={`exercise-${exercise.key}`}>{exercise.name}</h2>
              <span className="exercise-chevron" aria-hidden="true">{expanded ? "收起 ▴" : "展开 ▾"}</span>
            </span>
            <span className="exercise-meta-line">
              {headInfo.doneCount}/{exercise.sets.length} 组完成 · 每组 {exercise.target} 次
              {previous && exercise.sets.some((set) => set.weight != null || set.reps != null) ? (
                <span className="prefill-note"> · {workout.prefill_unit_converted ? "已按上次表现预填（含单位换算）" : "已按上次表现预填"}</span>
              ) : null}
            </span>
            {headInfo.statusText ? (
              <span className="exercise-head-status" data-kind={headInfo.statusKind ?? undefined}>{headInfo.statusText}</span>
            ) : null}
          </button>
          {guide ? (
            <button
              className="guide-trigger"
              type="button"
              aria-label={`查看${exercise.name}动作要领`}
              onClick={() => onOpenGuide(guide)}
            >要领</button>
          ) : null}
        </div>
        {previous && previous.weight != null ? (
          <span className="previous-mark">上次 {previous.weight}{workout.unit} × {previous.reps ?? "—"}{previous.converted ? "（已换算）" : ""}</span>
        ) : null}
      </div>
      <div className="exercise-body" hidden={!expanded}>
        <div className="set-columns" aria-hidden="true">
          <span>组</span><span>重量</span><span>次数</span><span>完成</span>
        </div>
        <div className="set-list">
          {exercise.sets.map((set) => (
            <SetRow key={set.id} set={set} unit={workout.unit} locked={entryLocked} onSaved={onChanged} onRegister={onRegisterSet} onCompleted={onSetCompleted} onEnterNext={(field) => onEnterNextSet(set.id, field)} />
          ))}
        </div>
        <button className="add-set" type="button" onClick={handleAddSet} disabled={addSet.isPending || entryLocked}>
          {addSet.isPending ? "添加中…" : "+ 加一组"}
        </button>
        {timerSlot}
      </div>
    </section>
  );
}

function RestTimerPanel({ timer, nowMs, onChange }: {
  timer: RestTimerState;
  nowMs: number;
  onChange: (updater: (state: RestTimerState) => RestTimerState) => void;
}) {
  const done = restTimerDone(timer, nowMs);
  return (
    <section className={`rest-timer${done ? " is-done" : ""}`} aria-label="休息计时器">
      <div className="rest-timer-head">
        <span className="rest-timer-caption">{done ? "休息结束" : "组间休息"}</span>
        <strong className="rest-timer-time" role="timer">{restTimerLabel(timer, nowMs)}</strong>
      </div>
      <div className="rest-timer-controls">
        <div className="rest-timer-durations" role="group" aria-label="休息时长（下一次启动生效）">
          {REST_DURATIONS.map((seconds) => (
            <button
              key={seconds}
              type="button"
              aria-pressed={timer.durationSec === seconds}
              onClick={() => onChange((state) => setRestDuration(state, seconds))}
            >
              {seconds} 秒
            </button>
          ))}
        </div>
        <button type="button" onClick={() => onChange((state) => addRestTime(state, 30, Date.now()))}>+30秒</button>
        <button
          type="button"
          aria-pressed={timer.muted}
          onClick={() => onChange((state) => toggleRestMuted(state))}
        >
          {timer.muted ? "已静音" : "静音"}
        </button>
        <button type="button" onClick={() => onChange((state) => skipRestTimer(state))}>跳过</button>
      </div>
      <p className="rest-timer-note">本次自动休息计时：{timer.autoEnabled ? "开" : "关"} · 刷新页面后计时器会重置</p>
    </section>
  );
}

// W-TIMER-001: the always-visible per-workout auto-timer switch. Local
// UI state only — no server write, no localStorage, no set is touched.
function RestAutoToggle({ timer, onChange }: {
  timer: RestTimerState;
  onChange: (updater: (state: RestTimerState) => RestTimerState) => void;
}) {
  return (
    <button
      type="button"
      className="rest-auto-toggle"
      aria-pressed={timer.autoEnabled}
      onClick={() => onChange((state) => toggleRestAuto(state))}
    >
      本次自动休息计时：{timer.autoEnabled ? "开" : "关"}
    </button>
  );
}

function ActiveWorkout({ workout, recent }: { workout: Workout; recent: Workout[] }) {
  const queryClient = useQueryClient();
  const [, setClock] = useState(0);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [finishBlock, setFinishBlock] = useState<FinishGateReason | null>(null);
  const [finishFailed, setFinishFailed] = useState(false);
  const [finishing, setFinishing] = useState(false);
  const [unsavedPresent, setUnsavedPresent] = useState(false);
  // W-UI-001-D1: manual current-exercise selection (null = automatic),
  // a mirror of the registered save handles for the top aggregate and
  // per-exercise head status (mirror only — the handles stay the save
  // source of truth), the in-flight add count, and the finish button
  // ref for the Enter focus chain's last step.
  const [selectedExerciseKey, setSelectedExerciseKey] = useState<string | null>(null);
  const [handleMirror, setHandleMirror] = useState<{ snapshots: SetSaveSnapshot[]; completed: Record<number, boolean> }>({
    snapshots: [],
    completed: {},
  });
  const [pendingAddCount, setPendingAddCount] = useState(0);
  const finishButtonRef = useRef<HTMLButtonElement | null>(null);
  // W-UI-001-D1: the element focused when a finish attempt started, so
  // cancelling the finish confirmation restores the original focus
  // and current exercise.
  const preFinishFocusRef = useRef<Element | null>(null);
  const [selectedGuide, setSelectedGuide] = useState<ExerciseGuide | null>(null);
  // Rest timer lives only in this component's memory: no server writes, no
  // localStorage, so a page refresh resets it (workout data itself is still
  // covered by the per-set autosave).
  const [restTimer, setRestTimer] = useState<RestTimerState>(() => initRestTimer());
  const [restNow, setRestNow] = useState(() => Date.now());

  const handleSetCompleted = useCallback(() => {
    // W-TIMER-001: with auto off, completing a set neither starts nor
    // restarts the timer (an already-running countdown is untouched);
    // with auto on this behaves exactly as before.
    setRestTimer((state) => (shouldAutoStartRest(state) ? startRestTimer(state, Date.now()) : state));
  }, []);

  const updateRestTimer = useCallback((updater: (state: RestTimerState) => RestTimerState) => {
    setRestTimer(updater);
  }, []);

  // The interval only triggers re-renders; the remaining time is always
  // derived from endsAt and Date.now(), so backgrounding stays accurate.
  useEffect(() => {
    if (restTimer.endsAt == null) return undefined;
    setRestNow(Date.now());
    const tick = window.setInterval(() => setRestNow(Date.now()), 300);
    return () => window.clearInterval(tick);
  }, [restTimer.endsAt]);

  // Beep exactly once when the countdown reaches zero (unless muted), and
  // mark done so the 休息结束 state stays until skip or the next set.
  useEffect(() => {
    if (restTimer.endsAt == null || restTimer.done) return;
    if (!restTimerDone(restTimer, restNow)) return;
    if (!restTimer.muted) playRestBeep();
    setRestTimer((state) => (state.done ? state : { ...state, done: true }));
  }, [restTimer, restNow]);

  const setHandlesRef = useRef(new Map<number, SetSaveHandle>());

  // W-FINISH-001: shared pending-add registry. Every "+ 加一组"
  // click registers its mutateAsync promise here (the promise only
  // settles after the add landed and the dashboard refetch
  // completed, which is also what mounts the new SetRow and
  // registers its save handle); the entry is removed on settle.
  // Both finish paths join this registry via settlePendingAdds
  // before flushing or sealing anything.
  const pendingAddsRef = useRef(new Set<Promise<unknown>>());
  const registerPendingAdd = useCallback((promise: Promise<unknown>) => {
    pendingAddsRef.current.add(promise);
    setPendingAddCount((count) => count + 1);
    const unregister = () => {
      pendingAddsRef.current.delete(promise);
      setPendingAddCount((count) => Math.max(0, count - 1));
    };
    void promise.then(unregister, unregister);
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => setClock((value) => value + 1), 30000);
    return () => window.clearInterval(timer);
  }, []);

  // W0.2: warn on page leave while any set is dirty / saving / error.
  useEffect(() => {
    if (!unsavedPresent) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [unsavedPresent]);

  const registerSet = (id: number, handle: SetSaveHandle | null) => {
    if (handle) setHandlesRef.current.set(id, handle);
    else setHandlesRef.current.delete(id);
    const handles = [...setHandlesRef.current.values()];
    const statuses = handles.map((entry) => entry.getStatus());
    setUnsavedPresent(hasUnsavedSetStatus(statuses));
    // W-UI-001-D1: refresh the display mirror (aggregate + draft-aware
    // completion) from the same handles; registration re-runs whenever
    // a row's save machine changes, so the mirror tracks every save.
    setHandleMirror({
      snapshots: handles.map((entry) => ({
        id: entry.id,
        exerciseKey: entry.exerciseKey,
        status: entry.getStatus(),
        blocked: entry.isBlocked(),
      })),
      completed: Object.fromEntries(handles.map((entry) => [entry.id, entry.isCompleted()])),
    });
  };

  const refresh = () => queryClient.invalidateQueries({ queryKey: ["dashboard"] });
  const complete = useMutation({
    mutationFn: () => api.completeWorkout({ workout_id: workout.id }),
    onSuccess: refresh,
  });

  // W-FINISH-001: a finish attempt only counts when the complete
  // request resolves with ok === true — a business refusal
  // ({ ok: false }) is a failure just like a thrown error. On failure
  // every set is unsealed so all drafts stay editable and saveable,
  // and the failure is surfaced in words.
  async function runComplete(): Promise<boolean> {
    let result: { ok: boolean } | null = null;
    try {
      result = await complete.mutateAsync();
    } catch {
      result = null;
    }
    if (result && result.ok === true) return true;
    for (const handle of setHandlesRef.current.values()) handle.unseal();
    setFinishFailed(true);
    return false;
  }

  // W-UI-001 finish gate + W-FINISH-001: flush every set over a
  // consistent handle set (flushAllHandles re-reads the registry and
  // re-flushes if the set changed mid-flush; an unstable batch counts
  // as unsaved), then let finishGateDecision consume the full result
  // of that same stable batch. Entry is locked from the moment the
  // finish flow starts (`finishing`) and stays locked until it ends.
  // Only a fully clean batch finishes directly — and then only after
  // sealing that exact batch, so no queued write can land after the
  // workout completes; anything else shows the confirmation for its
  // reason, because finishing would lose edits or skip sets.
  async function handleFinish() {
    // W-UI-001-D1: remember where focus was, so cancelling the finish
    // confirmation can restore it (and the current exercise, which the
    // finish flow never changes).
    preFinishFocusRef.current = document.activeElement;
    setFinishFailed(false);
    setFinishing(true);
    try {
      // W-FINISH-001: join in-flight adds first, while the finishing
      // entry lock is held. A failed add aborts the finish outright
      // (failure shown, entry unlocked by the finally below, no
      // complete attempted); a landed add has already refreshed the
      // dashboard, so its new SetRow is registered in the handle
      // registry and the flush/gate below judges the FINAL set
      // collection.
      const adds = await settlePendingAdds(() => [...pendingAddsRef.current]);
      if (!adds.ok) {
        setFinishFailed(true);
        return;
      }
      const { handles, results, stable } = await flushAllHandles(() => [...setHandlesRef.current.values()]);
      const snapshots = handles.map((handle, index) => ({
        flushOk: stable && (results[index] ?? false),
        status: handle.getStatus(),
        blocked: handle.isBlocked(),
        completed: handle.isCompleted(),
      }));
      setUnsavedPresent(hasUnsavedSetStatus(handles.map((handle) => handle.getStatus())));
      const decision = finishGateDecision(snapshots);
      if (decision.proceed) {
        // Seal the batch first: the save queues issue no new writes
        // from here on. `finishing` is NOT reset before runComplete
        // returns; on failure runComplete unseals everything and the
        // drafts stay editable, and only then does the finally below
        // unlock entry.
        for (const handle of handles) handle.seal();
        await runComplete();
        return;
      }
      setFinishBlock(decision.reason);
    } finally {
      setFinishing(false);
    }
  }

  // W-UI-001-D1: cancelling the finish confirmation restores the
  // focus the user had when the finish attempt started.
  function cancelFinish() {
    setFinishBlock(null);
    const target = preFinishFocusRef.current;
    if (target instanceof HTMLElement && target.isConnected) {
      requestAnimationFrame(() => target.focus());
    }
  }

  // Confirmed finish despite pending edits: seal AND settle every
  // set's save queue first — no queued write may still be in flight
  // when the complete request is sent, so nothing can land after the
  // workout is finished. The seal runs through
  // sealAllAndSettleStable: the registry is re-read after each round
  // and any handle registered mid-round is sealed and settled too,
  // so complete is never sent over an unchecked new set. If the
  // registry never stabilises, the finish aborts — everything is
  // unsealed, the failure is surfaced, and no complete is attempted.
  // If the complete then fails (thrown or ok !== true), runComplete
  // unseals everything and the workout stays editable with all drafts
  // intact. Entry stays locked (`finishing`) until the flow ends.
  async function confirmFinishAnyway() {
    setFinishBlock(null);
    setFinishFailed(false);
    setFinishing(true);
    try {
      // W-FINISH-001: same pending-add join as handleFinish, before
      // any seal — a failed add aborts with the failure shown and no
      // complete attempted; a landed add's new SetRow is sealed and
      // settled by the rounds below like every other set.
      const adds = await settlePendingAdds(() => [...pendingAddsRef.current]);
      if (!adds.ok) {
        setFinishFailed(true);
        return;
      }
      const { stable } = await sealAllAndSettleStable(() => [...setHandlesRef.current.values()]);
      if (!stable) {
        for (const handle of setHandlesRef.current.values()) handle.unseal();
        setFinishFailed(true);
        return;
      }
      await runComplete();
    } finally {
      setFinishing(false);
    }
  }
  const discard = useMutation({
    mutationFn: () => api.discardWorkout({ workout_id: workout.id }),
    onSuccess: refresh,
  });

  const previousByExercise = useMemo(() => {
    // W1.3: cross-unit workouts are comparable too — take the latest
    // completed set per exercise from the most recent completed workout
    // that has one, converting its weight into this workout's unit.
    const result = new Map<string, PreviousMark>();
    for (const oldWorkout of recent) {
      const unitConverted = oldWorkout.unit !== workout.unit;
      for (const set of [...oldWorkout.sets].reverse()) {
        if (set.completed && !result.has(set.exercise_key)) {
          result.set(set.exercise_key, {
            weight: set.weight == null
              ? null
              : unitConverted
                ? convertWeightValue(set.weight, oldWorkout.unit, workout.unit)
                : set.weight,
            reps: set.reps,
            converted: unitConverted && set.weight != null,
          });
        }
      }
    }
    return result;
  }, [recent, workout.unit]);

  const done = completedCount(workout);
  const total = workout.sets.length;
  const meta = ROUTINE_META[workout.routine];
  const exerciseGroups = groupSets(workout.sets);
  // W-UI-001-D1: draft-aware completion (a set toggled complete in its
  // row counts before the dashboard refetch lands), the resolved
  // current exercise (manual selection first, then first incomplete,
  // then the last exercise), and the top save aggregate. The rest
  // timer anchors to that same current exercise.
  const isSetCompleted = (set: WorkoutSet) => handleMirror.completed[set.id] ?? set.completed;
  const doneCount = exerciseGroups.length > 0 && Object.keys(handleMirror.completed).length > 0
    ? workout.sets.filter(isSetCompleted).length
    : done;
  const currentKey = resolveCurrentExerciseKey(
    exerciseGroups.map((group) => ({
      key: group.key,
      hasIncomplete: group.sets.some((set) => !isSetCompleted(set)),
    })),
    selectedExerciseKey,
  );
  const aggregate = aggregateSaveStates(handleMirror.snapshots, {
    pendingAdds: pendingAddCount,
    finishing,
  });
  const currentExercise = exerciseGroups.find((group) => group.key === currentKey) ?? null;

  const focusSetInput = (setId: number, field: "weight" | "reps") => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        document
          .querySelector<HTMLInputElement>(`input[data-focus-set="${setId}"][data-focus-field="${field}"]`)
          ?.focus();
      });
    });
  };

  const handleEnterNext = (exerciseKey: string, setId: number, field: "weight" | "reps") => {
    const target = nextFocusTarget(buildFocusOrder(exerciseGroups), { exerciseKey, setId, field });
    if (!target) return;
    if (target.kind === "finish") {
      finishButtonRef.current?.focus();
      return;
    }
    setSelectedExerciseKey(target.target.exerciseKey);
    focusSetInput(target.target.setId, target.target.field);
  };

  const handleViewAbnormal = () => {
    const abnormal = aggregate.firstAbnormal;
    if (!abnormal) return;
    setSelectedExerciseKey(abnormal.exerciseKey);
    focusSetInput(abnormal.setId, abnormal.blocked ? "reps" : "weight");
  };
  const restTimerUi = (
    <>
      <RestAutoToggle timer={restTimer} onChange={updateRestTimer} />
      {restTimer.endsAt != null ? (
        <RestTimerPanel timer={restTimer} nowMs={restNow} onChange={updateRestTimer} />
      ) : null}
    </>
  );

  return (
    <main className="active-shell">
      <header className="active-header">
        <div>
          <p className="live-label"><span />训练中</p>
          <h1>{meta.label}日</h1>
        </div>
        <div className="timer" aria-label={`训练时长 ${formatDuration(workout.started_at)}`}>
          <strong>{formatDuration(workout.started_at)}</strong>
          <span>{doneCount}/{total} 组</span>
        </div>
      </header>

      <div className="workout-status-bar">
        <span className="completion-count">已完成 {doneCount} / {total} 组</span>
        <span className="save-aggregate" data-kind={aggregate.kind} role="status">
          {aggregate.label}
          {aggregate.kind === "error" || aggregate.kind === "blocked" ? (
            <button type="button" className="save-aggregate-view" onClick={handleViewAbnormal}>查看</button>
          ) : null}
        </span>
      </div>

      <div className="progress-track" aria-label={`已完成 ${doneCount} 组，共 ${total} 组`}>
        <span style={{ width: `${total ? (doneCount / total) * 100 : 0}%` }} />
      </div>

      <details className="warmup-strip">
        <summary>先热身 <span>展开</span></summary>
        <p>{meta.warmup}</p>
      </details>

      <div className="exercise-stack">
        {exerciseGroups.map((exercise) => (
          <ExerciseBlock
            key={exercise.key}
            workout={workout}
            exercise={exercise}
            previous={previousByExercise.get(exercise.key)}
            timerSlot={currentExercise != null && exercise.key === currentExercise.key ? restTimerUi : undefined}
            entryLocked={finishing}
            expanded={exercise.key === currentKey}
            headInfo={exerciseHeadInfo(
              exercise.sets.filter(isSetCompleted).length,
              handleMirror.snapshots.filter((snapshot) => snapshot.exerciseKey === exercise.key),
            )}
            onSelect={() => setSelectedExerciseKey(exercise.key)}
            onEnterNextSet={(setId, field) => handleEnterNext(exercise.key, setId, field)}
            onChanged={refresh}
            onSetCompleted={handleSetCompleted}
            onOpenGuide={setSelectedGuide}
            onRegisterSet={registerSet}
            onRegisterPendingAdd={registerPendingAdd}
          />
        ))}
      </div>

      {currentExercise == null ? <div className="rest-timer-fallback">{restTimerUi}</div> : null}

      <section className="finish-zone">
        <div>
          <p>{doneCount === total ? "全部完成" : `还剩 ${total - doneCount} 组`}</p>
          <span>{unsavedPresent ? "有未保存的修改，结束前会先保存" : "完成后会进入历史记录"}</span>
        </div>
        <button ref={finishButtonRef} type="button" className="finish-button" onClick={() => void handleFinish()} disabled={complete.isPending || finishing}>
          {complete.isPending || finishing ? "正在结束…" : "结束训练"}
        </button>
      </section>

      {finishBlock ? (
        <div className="inline-confirm finish-confirm" role="group" aria-label="确认结束训练">
          <span>
            {finishBlock === "unsaved"
              ? "仍有未保存的修改，结束训练会丢失这些修改"
              : finishBlock === "blocked"
                ? "有已完成但缺次数的组，请先补次数，或确认直接结束"
                : "还有未完成的组，确认结束训练吗？"}
          </span>
          <button type="button" onClick={cancelFinish}>返回继续编辑</button>
          <button type="button" className="danger" onClick={() => void confirmFinishAnyway()} disabled={complete.isPending || finishing}>仍要结束</button>
        </div>
      ) : null}

      {finishFailed ? (
        <p className="error-banner" role="alert">结束失败，修改已保留，可以继续编辑保存后重试结束</p>
      ) : null}

      <div className="discard-zone">
        {!confirmDiscard ? (
          <button type="button" onClick={() => setConfirmDiscard(true)}>放弃这次训练</button>
        ) : (
          <div className="inline-confirm" role="group" aria-label="确认放弃训练">
            <span>这次记录会被删除</span>
            <button type="button" onClick={() => setConfirmDiscard(false)}>返回</button>
            <button type="button" className="danger" onClick={() => discard.mutate()} disabled={discard.isPending}>确认删除</button>
          </div>
        )}
      </div>
      {selectedGuide ? <ExerciseGuideDialog guide={selectedGuide} onClose={() => setSelectedGuide(null)} /> : null}
    </main>
  );
}

function History({ workouts }: { workouts: Workout[] }) {
  if (workouts.length === 0) {
    return (
      <section className="history-section">
        <div className="section-heading"><h2>最近训练</h2></div>
        <p className="empty-history">第一次训练完成后，重量和次数会留在这里。</p>
      </section>
    );
  }
  return (
    <section className="history-section">
      <div className="section-heading"><h2>最近训练</h2><span>{workouts.length} 次</span></div>
      <div className="history-list">
        {workouts.map((workout) => (
          <details className="history-row" key={workout.id}>
            <summary>
              <span className="history-date">{formatDate(workout.completed_at ?? workout.started_at)}</span>
              <strong>{ROUTINE_META[workout.routine].label}</strong>
              <span>{completedCount(workout)} 组</span>
              <span>{formatDuration(workout.started_at, workout.completed_at)}</span>
              <i aria-hidden="true">›</i>
            </summary>
            <div className="history-detail">
              <p>总训练量 <strong>{Math.round(trainingVolume(workout)).toLocaleString("zh-CN")} {workout.unit}</strong></p>
              {groupSets(workout.sets).map((exercise) => (
                <div key={exercise.key}>
                  <span>{exercise.name}</span>
                  <span>{exercise.sets.filter((set) => set.completed).map((set) => `${set.weight ?? "自重"}×${set.reps ?? "—"}`).join(" / ") || "未完成"}</span>
                </div>
              ))}
            </div>
          </details>
        ))}
      </div>
    </section>
  );
}

function StartScreen({ recent }: { recent: Workout[] }) {
  const queryClient = useQueryClient();
  const [unit, setUnit] = useState<Unit>("lb");
  const start = useMutation({
    mutationFn: (routine: Routine) => api.startWorkout({ routine, unit }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["dashboard"] }),
  });

  return (
    <main className="home-shell">
      <section className="start-hero">
        <div className="hero-copy">
          <p className="date-line">{new Intl.DateTimeFormat("zh-CN", { month: "long", day: "numeric", weekday: "long" }).format(new Date())}</p>
          <h1>今天练什么？</h1>
          <p>选一天，动作和组数已经排好。</p>
        </div>
        <div className="unit-switch" aria-label="重量单位">
          <button type="button" aria-pressed={unit === "lb"} onClick={() => setUnit("lb")}>lb</button>
          <button type="button" aria-pressed={unit === "kg"} onClick={() => setUnit("kg")}>kg</button>
        </div>
      </section>

      <WeeklyReview workouts={recent} />

      <section className="routine-selector" aria-label="选择训练日">
        {(Object.keys(ROUTINE_META) as Routine[]).map((routine, index) => {
          const meta = ROUTINE_META[routine];
          return (
            <button key={routine} type="button" className={`routine-option routine-${routine}`} onClick={() => start.mutate(routine)} disabled={start.isPending}>
              <span className="routine-number">0{index + 1}</span>
              <span className="routine-name">{meta.label}</span>
              <span className="routine-detail"><b>{meta.day}</b>{meta.count}</span>
              <span className="routine-arrow" aria-hidden="true">→</span>
            </button>
          );
        })}
      </section>

      {start.isError ? <p className="error-banner">没能开始训练，请再试一次。</p> : null}
      <History workouts={recent} />
    </main>
  );
}

export function App() {
  const dashboard = useQuery({
    queryKey: ["dashboard"],
    queryFn: () => api.getDashboard({ recent_limit: 20 }),
  });

  if (dashboard.isPending) {
    return <main className="loading-shell"><div className="loading-bar" /><p>正在打开训练表…</p></main>;
  }
  if (dashboard.isError || !dashboard.data) {
    return (
      <main className="loading-shell">
        <h1>暂时打不开记录</h1>
        <p>检查网络后再试一次。</p>
        <button type="button" onClick={() => dashboard.refetch()}>重新加载</button>
      </main>
    );
  }

  if (dashboard.data.forbidden) {
    return (
      <main className="loading-shell">
        <h1>无权访问此训练记录</h1>
        <p>此页面仅对所有者开放。</p>
      </main>
    );
  }

  return (
    <div className="app-root">
      <SafeAreaTopScrim backgroundColor="var(--bg)" />
      {dashboard.data.active_workout ? (
        <ActiveWorkout workout={dashboard.data.active_workout} recent={dashboard.data.recent_workouts} />
      ) : (
        <StartScreen recent={dashboard.data.recent_workouts} />
      )}
    </div>
  );
}
