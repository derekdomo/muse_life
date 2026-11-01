// W3.2: THE single server-side progressive-overload engine.
//
// Before W3.2 the "next time" verdict was implemented twice —
// progressionDecision for the startWorkout prefill (server) and a
// line-for-line copy inside the client's WeeklyReview — and the
// completion receipt ran the client copy a third way. This module is
// now the ONLY implementation: the prefill, the completion receipt
// （训练结束总结） and the weekly review all consume advice computed
// here, on the server, and the client only formats what it receives.
//
// Pure and self-contained (no imports, no IO) so validation scripts
// can evaluate this file verbatim and run the real function over
// synthetic data. Every advice carries PROGRESSION_ENGINE_VERSION so
// a suggestion on screen can always be traced to the rule version
// that produced it.
//
// Base semantics are exactly the verified W1.2 rule, judged on the
// MOST RECENT session of the same exercise (weights converted into
// the output unit first, LB_TO_KG with 0.5 rounding):
//   - all planned sets completed and every completed set at the rep
//     cap -> increase (+5 lb / +2.5 kg, reps back to the range floor);
//   - not all planned sets completed -> hold;
//   - a completed set below the range floor -> reduce one step
//     (never below 0);
//   - no comparable record (no session / nothing completed / a
//     completed set with reps missing / no weighed completed set,
//     e.g. bodyweight) -> insufficient, never a suggestion, and a
//     bodyweight set is never treated as a 0 load. "Weighed" means a
//     real positive weight: a recorded 0 is how bodyweight work was
//     logged in the home routines, so a 0-weight set counts as
//     bodyweight — it never becomes the base and it defeats the
//     increase like any unweighed set.
// W3.2 additions, layered on top of — never replacing — that base:
//   - pain flags on the judged session are conservative: an increase
//     is held back to hold, and any verdict's reason names the pain;
//   - per-set RIR and the session RPE feed the reason and the
//     confidence only — they never change the base decision, and a
//     missing RIR changes nothing at all;
//   - the previous session (second input) feeds the confidence and
//     the reason (agreement strengthens, contradiction weakens).

export const PROGRESSION_ENGINE_VERSION = 1;

// W1.3: the same conversion constant the rest of the server uses.
export const LB_TO_KG = 0.45359237;

export type ProgressionUnit = "lb" | "kg";
export type ProgressionDecisionKind = "increase" | "hold" | "reduce" | "insufficient";
export type ProgressionConfidence = "high" | "medium" | "low";

export type ProgressionEngineSet = {
  weight: number | null;
  reps: number | null;
  // W3.1: per-set RIR 0–5 as stored; null = not recorded.
  rir: number | null;
  completed: boolean;
};

export type ProgressionEngineSession = {
  // The unit the session's weights were recorded in; the engine
  // converts them into the output unit before judging.
  unit: ProgressionUnit;
  // That workout's planned set count for the exercise (its recorded
  // set count), exactly as the W1 rule has always counted it.
  plannedSets: number;
  sets: ProgressionEngineSet[];
  // W3.1: the source workout's decoded pain-flag keys ([] / absent =
  // none recorded) and its session RPE (null = not recorded).
  painFlags?: string[] | null;
  sessionRpe?: number | null;
};

export type ProgressionEngineInput = {
  // Same exercise, most recent first. The engine judges the first
  // session; the second only informs confidence / reason. Sessions
  // beyond the second are ignored.
  sessions: ProgressionEngineSession[];
  targetMin: number;
  targetMax: number;
  // Unit the suggestion is expressed in.
  unit: ProgressionUnit;
};

export type ProgressionAdvice = {
  decision: ProgressionDecisionKind;
  suggestedWeight: number | null;
  suggestedReps: number | null;
  // Completed / planned sets of the judged session (0–1, two
  // decimals); null when there is no session to rate.
  completionRate: number | null;
  reason: string;
  confidence: ProgressionConfidence;
  engineVersion: number;
};

function roundHalf(value: number): number {
  return Math.round(value * 2) / 2;
}

export function convertEngineWeight(
  weight: number | null,
  from: ProgressionUnit,
  to: ProgressionUnit,
): number | null {
  if (weight == null || from === to) return weight;
  const converted = from === "lb" ? weight * LB_TO_KG : weight / LB_TO_KG;
  return roundHalf(converted);
}

type SessionSummary = {
  completedCount: number;
  base: number | null;
  allTop: boolean;
  anyBelowMin: boolean;
  anyCompletedRepsMissing: boolean;
  weighedCompletedCount: number;
  // RIRs of completed sets that recorded one, in set order.
  rirs: number[];
  completedWithRir: number;
};

function summarizeSession(
  session: ProgressionEngineSession,
  outputUnit: ProgressionUnit,
  targetMin: number,
  targetMax: number,
): SessionSummary {
  const completed = session.sets.filter((set) => set.completed);
  const convertedWeights = completed.map((set) => convertEngineWeight(set.weight, session.unit, outputUnit));
  // A completed set is a comparable load only with a real positive
  // weight: null is unrecorded, and a recorded 0 is how bodyweight
  // work was logged (the home routines) — neither ever stands in as
  // a 0 load, so a 0-weight set defeats the increase exactly like an
  // unweighed one and can never become the base.
  const isWeighed = (weight: number | null): weight is number => weight != null && weight > 0;
  const weighed = convertedWeights.filter(isWeighed);
  const rirs = completed
    .map((set) => set.rir)
    .filter((rir): rir is number => rir != null);
  return {
    completedCount: completed.length,
    base: weighed.length > 0 ? Math.max(...weighed) : null,
    // W1.2 verbatim: the increase needs EVERY completed set weighed
    // and at the cap; a single unweighed or short set defeats it.
    allTop: completed.every((set, index) => isWeighed(convertedWeights[index] ?? null) && set.reps != null && set.reps >= targetMax),
    anyBelowMin: completed.some((set) => set.reps != null && set.reps < targetMin),
    anyCompletedRepsMissing: completed.some((set) => set.reps == null),
    weighedCompletedCount: weighed.length,
    rirs,
    completedWithRir: rirs.length,
  };
}

export function evaluateProgression(input: ProgressionEngineInput): ProgressionAdvice {
  const engineVersion = PROGRESSION_ENGINE_VERSION;
  const unit = input.unit;
  const insufficient = (reason: string, completionRate: number | null): ProgressionAdvice => ({
    decision: "insufficient",
    suggestedWeight: null,
    suggestedReps: null,
    completionRate,
    reason,
    confidence: "low",
    engineVersion,
  });

  const latest = input.sessions[0];
  if (!latest) return insufficient("暂无同动作的历史记录，数据不足", null);
  const summary = summarizeSession(latest, unit, input.targetMin, input.targetMax);
  const completionRate = latest.plannedSets > 0
    ? Math.round((summary.completedCount / latest.plannedSets) * 100) / 100
    : null;
  if (latest.sets.length === 0 || latest.plannedSets <= 0) {
    return insufficient("上次记录没有可比的组，数据不足", completionRate);
  }
  if (summary.completedCount === 0) {
    return insufficient("上次没有完成的组，数据不足", completionRate);
  }
  if (summary.weighedCompletedCount === 0 || summary.base == null) {
    // Bodyweight / unmeasured: never a 0-load suggestion.
    return insufficient("上次完成的组没有重量记录（自重或未记录），数据不足", completionRate);
  }
  const base = summary.base;
  const increment = unit === "lb" ? 5 : 2.5;
  const pain = (latest.painFlags?.length ?? 0) > 0;

  // --- base decision (W1.2 order, unchanged) ---
  let baseDecision: "increase" | "hold" | "reduce";
  let coreReason: string;
  if (summary.completedCount < latest.plannedSets) {
    baseDecision = "hold";
    coreReason = `上次完成 ${summary.completedCount}/${latest.plannedSets} 组，未完成全部计划组`;
  } else if (summary.anyCompletedRepsMissing) {
    return insufficient("上次有已完成组未记录次数，数据不足", completionRate);
  } else if (summary.allTop) {
    baseDecision = "increase";
    coreReason = `上次全部 ${latest.plannedSets} 组完成且每组达到次数上限 ${input.targetMax}`;
  } else if (summary.anyBelowMin) {
    baseDecision = "reduce";
    coreReason = `上次有已完成组低于次数下限 ${input.targetMin}，先降一档回到目标区间`;
  } else {
    baseDecision = "hold";
    coreReason = `上次全部组完成但未都达到次数上限 ${input.targetMax}`;
  }

  // --- pain is conservative: it can hold back an increase, never
  // create one, and it is always named in the reason ---
  let decision: "increase" | "hold" | "reduce" = baseDecision;
  const painHeldIncrease = pain && baseDecision === "increase";
  if (painHeldIncrease) decision = "hold";

  let suggestedWeight: number;
  let suggestedReps: number | null = null;
  if (decision === "increase") {
    suggestedWeight = roundHalf(base + increment);
    suggestedReps = input.targetMin;
  } else if (decision === "reduce") {
    suggestedWeight = Math.max(0, roundHalf(base - increment));
  } else {
    suggestedWeight = base;
  }

  const reasonParts: string[] = [coreReason];
  if (painHeldIncrease) {
    reasonParts.push("记录了疼痛标记，保守处理：本次不加重，先观察疼痛");
  } else if (pain && decision === "reduce") {
    reasonParts.push("同时记录了疼痛标记，降重后留意疼痛是否缓解");
  } else if (pain) {
    reasonParts.push("记录了疼痛标记，本次不加重");
  }

  // --- confidence + reason from the previous session and RIR ---
  // Base confidence is medium; agreement with the previous session
  // or fully-recorded RIR headroom raises it, contradiction or a
  // max-effort / high-RPE signal caps it. RIR never moves the
  // decision itself.
  let confidence: ProgressionConfidence = "medium";
  let boost = false;
  let cap: ProgressionConfidence | null = null;

  const previous = input.sessions[1];
  if (previous) {
    const prev = summarizeSession(previous, unit, input.targetMin, input.targetMax);
    const prevComparable = prev.completedCount > 0 && prev.base != null && !prev.anyCompletedRepsMissing;
    if (prevComparable) {
      if (baseDecision === "increase" && prev.allTop && prev.completedCount >= previous.plannedSets) {
        boost = true;
        reasonParts.push("连续两次达到次数上限");
      } else if (baseDecision === "reduce" && prev.anyBelowMin) {
        boost = true;
        reasonParts.push("上一次也有组低于次数下限");
      } else if (baseDecision === "increase" && prev.anyBelowMin) {
        cap = "low";
        reasonParts.push("上一次曾有组低于次数下限，留意动作稳定性");
      } else if (baseDecision === "reduce" && prev.allTop) {
        cap = "low";
        reasonParts.push("上一次曾全部达到次数上限，本次回落可能只是状态波动");
      }
    }
  }

  if (summary.completedWithRir > 0 && summary.completedWithRir === summary.completedCount) {
    const minRir = Math.min(...summary.rirs);
    const maxRir = Math.max(...summary.rirs);
    if (minRir >= 2) {
      reasonParts.push("各组 RIR ≥ 2，仍有余力");
      if (baseDecision === "increase") boost = true;
    } else if (maxRir === 0) {
      reasonParts.push("各组 RIR 均为 0，已做到力竭");
      if (baseDecision === "increase") cap = "medium";
    }
  } else if (summary.completedWithRir > 0) {
    reasonParts.push(`已完成组 RIR：${summary.rirs.join("、")}`);
  }

  const sessionRpe = latest.sessionRpe ?? null;
  if (sessionRpe != null && sessionRpe >= 9 && baseDecision === "increase") {
    reasonParts.push(`上次整场强度 RPE ${sessionRpe}/10 偏高`);
    if (cap == null) cap = "medium";
  }

  if (boost && !pain) confidence = "high";
  if (cap === "low") confidence = "low";
  else if (cap === "medium" && confidence === "high") confidence = "medium";

  return {
    decision,
    suggestedWeight,
    suggestedReps,
    completionRate,
    reason: reasonParts.join("；"),
    confidence,
    engineVersion,
  };
}
