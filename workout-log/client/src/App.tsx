import { useEffect, useMemo, useState, type ChangeEvent } from "react";
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

function reviewRecommendation(review: ExerciseReview) {
  const increment = review.unit === "lb" ? 5 : 2.5;
  const prior = review.prior;
  if (!prior || prior.bestWeight == null || review.bestWeight == null) {
    return `${review.name}：前一周没有可比重量记录，暂不做重量建议`;
  }
  if (review.completed < review.planned) {
    return `${review.name}：本周少完成 ${review.planned - review.completed} 组，数据不完整；下周先保持 ${review.bestWeight}${review.unit} 并补齐`;
  }

  const currentAverage = averageReps(review);
  const priorAverage = averageReps(prior);
  const averageDrop = currentAverage != null && priorAverage != null
    ? Math.round((priorAverage - currentAverage) * 10) / 10
    : 0;
  const currentAllAtTop = review.planned > 0
    && review.completed === review.planned
    && review.repsLogged === review.completed
    && review.atTop === review.completed;
  const priorAllAtTop = prior.planned > 0
    && prior.completed === prior.planned
    && prior.repsLogged === prior.completed
    && prior.atTop === prior.completed;

  if (currentAllAtTop && priorAllAtTop) {
    const next = Math.round((review.bestWeight + increment) * 2) / 2;
    return `${review.name}：连续两周全部做到次数上限，下次增至 ${next}${review.unit}`;
  }
  if (review.belowMin > 0) {
    const reduced = Math.max(0, Math.round((review.bestWeight - increment) * 2) / 2);
    const declineReason = averageDrop > 0 ? `，平均次数较前一周下降 ${averageDrop}` : "";
    return `${review.name}：${review.belowMin} 组低于目标下限${declineReason}；下次降至 ${reduced}${review.unit}，先回到目标区间`;
  }
  if (averageDrop > 0) {
    return `${review.name}：平均次数较前一周下降 ${averageDrop}，但仍在目标区间；下次保持 ${review.bestWeight}${review.unit}`;
  }
  if (review.bestWeight === prior.bestWeight) {
    return `${review.name}：连续两周重量持平，但尚未连续两周全部到上限；下次保持 ${review.bestWeight}${review.unit}`;
  }
  if (review.bestWeight > prior.bestWeight) {
    return `${review.name}：本周已加重 ${Math.round((review.bestWeight - prior.bestWeight) * 10) / 10}${review.unit}；下次保持 ${review.bestWeight}${review.unit}，先稳定次数`;
  }
  return `${review.name}：本周最高重量较前一周下降 ${Math.round((prior.bestWeight - review.bestWeight) * 10) / 10}${review.unit}；下次保持 ${review.bestWeight}${review.unit}，完成目标后再加`;
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
  const recommendations = reviews.map(reviewRecommendation);
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
            ? "上周已完成推、拉、腿各一轮。负荷建议会对照前一完整周；只有连续两周全部做到次数上限才建议增重。"
            : `上周${routines.size > 0 ? `记录了 ${Array.from(routines).map((routine) => ROUTINE_META[routine].label).join("、")}` : "没有有效训练"}${missing.length > 0 ? `，缺少 ${missing.map((routine) => ROUTINE_META[routine].label).join("、")}` : "，但至少一次训练未完成全部组数"}；已记录动作仍按两周趋势判断负荷，但不据此新增动作。`}
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
            <strong>动作结构不变，按两周趋势调负荷</strong>
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

function SetRow({ set, unit, onSaved }: { set: WorkoutSet; unit: Unit; onSaved: () => void }) {
  const [weight, setWeight] = useState(set.weight == null ? "" : String(set.weight));
  const [reps, setReps] = useState(set.reps == null ? "" : String(set.reps));
  const [needsReps, setNeedsReps] = useState(false);

  useEffect(() => {
    setWeight(set.weight == null ? "" : String(set.weight));
    setReps(set.reps == null ? "" : String(set.reps));
  }, [set.id, set.weight, set.reps]);

  const save = useMutation({
    mutationFn: (completed: boolean) =>
      api.updateSet({
        id: set.id,
        weight: weight.trim() === "" ? null : Number(weight),
        reps: reps.trim() === "" ? null : Number(reps),
        completed,
      }),
    onSuccess: onSaved,
  });

  function persist(completed = set.completed) {
    if (completed && reps.trim() === "") {
      setNeedsReps(true);
      return;
    }
    setNeedsReps(false);
    save.mutate(completed);
  }

  function numericChange(event: ChangeEvent<HTMLInputElement>, setter: (value: string) => void) {
    setter(event.target.value);
  }

  return (
    <div className={`set-row ${set.completed ? "is-complete" : ""}`}>
      <span className="set-index" aria-label={`第 ${set.set_number} 组`}>{set.set_number}</span>
      <label className="field-wrap">
        <span className="sr-only">第 {set.set_number} 组重量（{unit}）</span>
        <input
          aria-label={`${set.exercise_name} 第 ${set.set_number} 组重量，单位 ${unit}`}
          inputMode="decimal"
          type="number"
          min="0"
          step="0.5"
          value={weight}
          onChange={(event) => numericChange(event, setWeight)}
          placeholder="—"
        />
        <small>{unit}</small>
      </label>
      <label className="field-wrap">
        <span className="sr-only">第 {set.set_number} 组次数</span>
        <input
          aria-label={`${set.exercise_name} 第 ${set.set_number} 组次数`}
          inputMode="numeric"
          type="number"
          min="0"
          step="1"
          value={reps}
          onChange={(event) => numericChange(event, setReps)}
          placeholder={set.target_reps}
        />
        <small>次</small>
      </label>
      <button
        className="set-check"
        type="button"
        aria-label={set.completed ? `${set.exercise_name} 第 ${set.set_number} 组取消完成` : `${set.exercise_name} 第 ${set.set_number} 组完成`}
        aria-pressed={set.completed}
        disabled={save.isPending}
        onClick={() => persist(!set.completed)}
      >
        {set.completed ? "✓" : ""}
      </button>
      {needsReps ? <span className="set-warning">先填次数</span> : null}
    </div>
  );
}

function ExerciseBlock({ workout, exercise, previous, onChanged, onOpenGuide }: {
  workout: Workout;
  exercise: ReturnType<typeof groupSets>[number];
  previous?: WorkoutSet;
  onChanged: () => void;
  onOpenGuide: (guide: ExerciseGuide) => void;
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

  return (
    <section className="exercise-block" aria-labelledby={`exercise-${exercise.key}`}>
      <div className="exercise-heading">
        <div>
          <div className="exercise-title-line">
            <h2 id={`exercise-${exercise.key}`}>{exercise.name}</h2>
            {guide ? (
              <button
                className="guide-trigger"
                type="button"
                aria-label={`查看${exercise.name}动作要领`}
                onClick={() => onOpenGuide(guide)}
              >要领</button>
            ) : null}
          </div>
          <p>
            {exercise.sets.length} 组 · 每组 {exercise.target} 次
            {previous && exercise.sets.some((set) => set.weight != null || set.reps != null) ? (
              <span className="prefill-note"> · 已按上次表现预填</span>
            ) : null}
          </p>
        </div>
        {previous && previous.weight != null ? (
          <span className="previous-mark">上次 {previous.weight}{workout.unit} × {previous.reps ?? "—"}</span>
        ) : null}
      </div>
      <div className="set-columns" aria-hidden="true">
        <span>组</span><span>重量</span><span>次数</span><span>完成</span>
      </div>
      <div className="set-list">
        {exercise.sets.map((set) => (
          <SetRow key={set.id} set={set} unit={workout.unit} onSaved={onChanged} />
        ))}
      </div>
      <button className="add-set" type="button" onClick={() => addSet.mutate()} disabled={addSet.isPending}>
        {addSet.isPending ? "添加中…" : "+ 加一组"}
      </button>
    </section>
  );
}

function ActiveWorkout({ workout, recent }: { workout: Workout; recent: Workout[] }) {
  const queryClient = useQueryClient();
  const [, setClock] = useState(0);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [selectedGuide, setSelectedGuide] = useState<ExerciseGuide | null>(null);

  useEffect(() => {
    const timer = window.setInterval(() => setClock((value) => value + 1), 30000);
    return () => window.clearInterval(timer);
  }, []);

  const refresh = () => queryClient.invalidateQueries({ queryKey: ["dashboard"] });
  const complete = useMutation({
    mutationFn: () => api.completeWorkout({ workout_id: workout.id }),
    onSuccess: refresh,
  });
  const discard = useMutation({
    mutationFn: () => api.discardWorkout({ workout_id: workout.id }),
    onSuccess: refresh,
  });

  const previousByExercise = useMemo(() => {
    const result = new Map<string, WorkoutSet>();
    for (const oldWorkout of recent) {
      if (oldWorkout.unit !== workout.unit) continue;
      for (const set of [...oldWorkout.sets].reverse()) {
        if (set.completed && !result.has(set.exercise_key)) result.set(set.exercise_key, set);
      }
    }
    return result;
  }, [recent]);

  const done = completedCount(workout);
  const total = workout.sets.length;
  const meta = ROUTINE_META[workout.routine];

  return (
    <main className="active-shell">
      <header className="active-header">
        <div>
          <p className="live-label"><span />训练中</p>
          <h1>{meta.label}日</h1>
        </div>
        <div className="timer" aria-label={`训练时长 ${formatDuration(workout.started_at)}`}>
          <strong>{formatDuration(workout.started_at)}</strong>
          <span>{done}/{total} 组</span>
        </div>
      </header>

      <div className="progress-track" aria-label={`已完成 ${done} 组，共 ${total} 组`}>
        <span style={{ width: `${total ? (done / total) * 100 : 0}%` }} />
      </div>

      <details className="warmup-strip">
        <summary>先热身 <span>展开</span></summary>
        <p>{meta.warmup}</p>
      </details>

      <div className="exercise-stack">
        {groupSets(workout.sets).map((exercise) => (
          <ExerciseBlock
            key={exercise.key}
            workout={workout}
            exercise={exercise}
            previous={previousByExercise.get(exercise.key)}
            onChanged={refresh}
            onOpenGuide={setSelectedGuide}
          />
        ))}
      </div>

      <section className="finish-zone">
        <div>
          <p>{done === total ? "全部完成" : `还剩 ${total - done} 组`}</p>
          <span>完成后会进入历史记录</span>
        </div>
        <button type="button" className="finish-button" onClick={() => complete.mutate()} disabled={complete.isPending}>
          {complete.isPending ? "保存中…" : "结束训练"}
        </button>
      </section>

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
