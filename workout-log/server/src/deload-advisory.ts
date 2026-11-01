// W3.5: conservative adjustment / recovery advisory （保守调整/恢复建议） —
// stall detection with a deload hint, layered AFTER the W3.2
// progression engine. Pure and self-contained (no imports, no IO),
// in the same style as progression-engine.ts / action-trends.ts /
// week-frequency.ts, so validation scripts can evaluate this file
// verbatim and run the real functions over synthetic data.
//
// THE RULE (plans.md W3.5, verbatim intent): an advisory is raised
// ONLY when BOTH gates hold at once —
//   gate A: the exercise's performance declined in TWO CONSECUTIVE
//     steps across its three most recent sessions (most recent
//     session worse than the one before, which was worse than the
//     one before that). "Declined" is judged per metric: ONE metric
//     — completion rate OR total volume — must walk strictly down
//     across BOTH steps (the brief's 「完成率和总容量任一连续走低」:
//     either metric, continuously). A single bad session NEVER
//     raises an advisory on its own, and metrics are never mixed
//     across steps to fake a decline.
//   gate B: at least ONE strain signal on the most recent session
//     (or the latest readiness reading):
//       - high RPE: the most recent session's sessionRpe >= 9
//         (HIGH_RPE_THRESHOLD);
//       - low RIR: any completed working set of the most recent
//         session recorded RIR <= 1 (LOW_RIR_THRESHOLD);
//       - pain: the most recent session's source workout recorded
//         a non-empty painFlags list;
//       - low readiness: the latest readiness score is below
//         READINESS_LOW_THRESHOLD (2 — the H-LOAD-001 red-band
//         cut, score < 2). This artifact holds NO readiness data of
//         its own: the score is an input supplied by the caller
//         when one exists, and null (no reading) simply means this
//         signal cannot fire — it is never invented.
// Session metrics are REAL computations over the recorded sets,
// never guesses: completion rate = completed / planned sets of
// that session; total volume = weight × reps summed over completed
// sets with both recorded, weights converted into the output unit
// first (LB_TO_KG, 0.5 rounding — the same convention as the
// engine); best set = the highest weight × reps among completed
// sets with a real positive weight (a recorded 0 is bodyweight,
// never a comparable load — the W3.2 rule).
//
// The advisory is DISPLAY ONLY. It carries requiresConfirmation =
// true and this module writes nothing: no plan template, weight or
// schedule is ever changed by an advisory. canRecordDeloadAdvisory
// is the single confirmation gate — an advisory may only be
// recorded as accepted when the user explicitly confirms it.

export const DELOAD_ADVISORY_VERSION = 1;

// The same conversion constant the rest of the server uses
// (asserted equal to the engine's / trends' by validation).
export const LB_TO_KG = 0.45359237;

// Signal thresholds (public, stated on the page).
export const HIGH_RPE_THRESHOLD = 9;
export const LOW_RIR_THRESHOLD = 1;
// H-LOAD-001 red band: a readiness score strictly below 2 is low.
export const READINESS_LOW_THRESHOLD = 2;

export type DeloadUnit = "lb" | "kg";

export type DeloadSessionSet = {
  weight: number | null;
  reps: number | null;
  // W3.1: per-set RIR 0–5 as stored; null = not recorded.
  rir: number | null;
  completed: boolean;
};

export type DeloadSession = {
  // The unit the session's weights were recorded in; metrics are
  // converted into the output unit before judging.
  unit: DeloadUnit;
  // That workout's planned set count for the exercise (its recorded
  // set count), exactly as the other engines count it.
  plannedSets: number;
  sets: DeloadSessionSet[];
  // W3.1: the source workout's decoded pain-flag keys ([] / absent
  // = none recorded) and its session RPE (null = not recorded).
  painFlags?: string[] | null;
  sessionRpe?: number | null;
  // The source workout's completion time (ISO string), passed
  // through for display only; it never influences the judgement.
  completedAt?: string | null;
};

export type DeloadAdvisoryInput = {
  // Same exercise, most recent first. Gate A needs the three most
  // recent sessions; sessions beyond the third are ignored.
  sessions: DeloadSession[];
  // The latest readiness score when the caller has one; null (or
  // absent) = no reading, so the readiness signal cannot fire.
  readinessScore?: number | null;
  // Unit volumes / best sets are expressed in.
  unit: DeloadUnit;
};

export type DeloadSessionMetrics = {
  completedAt: string | null;
  // Completed / planned sets (0–1, two decimals); null when the
  // session recorded no planned sets to rate against.
  completionRate: number | null;
  // Weight × reps over completed sets with both recorded, in the
  // output unit; null when no completed set has both (the volume
  // is then not comparable and can never ground a decline).
  volume: number | null;
  // Highest weight × reps among completed sets with a real
  // positive weight, in the output unit; null when none exists.
  bestSetVolume: number | null;
};

export type DeloadDecline = {
  metric: "completion_rate" | "volume";
  // The metric's values, oldest session first: [oldest, middle,
  // latest] — strictly decreasing by construction.
  values: [number, number, number];
};

export type DeloadSignalKind = "high_rpe" | "low_rir" | "pain" | "low_readiness";

export type DeloadSignal = {
  kind: DeloadSignalKind;
  // Human-readable fact, with the number in it (never colour or a
  // symbol alone): e.g. "最近一次整场 RPE 9/10（≥ 9）".
  detail: string;
  // The measured value behind the signal (RPE / minimum RIR /
  // readiness score); null for pain, whose detail names the flags.
  value: number | null;
};

export type DeloadAdvisory = {
  suggested: boolean;
  // One entry per metric that declined across both steps; empty
  // whenever gate A does not hold.
  declines: DeloadDecline[];
  // Every strain signal that fired on the latest session /
  // readiness reading; empty whenever gate B does not hold.
  signals: DeloadSignal[];
  // The three judged sessions' metrics, most recent first; fewer
  // when fewer sessions exist.
  sessionMetrics: DeloadSessionMetrics[];
  // The conservative suggestion ("降重一档或减一组…" / "安排恢复日…")
  // when suggested; null otherwise.
  suggestion: string | null;
  // Why the advisory was or was not raised, in the module's own
  // words — the card shows it verbatim.
  reason: string;
  // An advisory NEVER applies itself: it takes effect only after
  // the user explicitly confirms it (see canRecordDeloadAdvisory).
  requiresConfirmation: true;
  advisoryVersion: number;
};

function roundHalf(value: number): number {
  return Math.round(value * 2) / 2;
}

export function convertDeloadWeight(
  weight: number | null,
  from: DeloadUnit,
  to: DeloadUnit,
): number | null {
  if (weight == null || from === to) return weight;
  const converted = from === "lb" ? weight * LB_TO_KG : weight / LB_TO_KG;
  return roundHalf(converted);
}

export function sessionMetrics(session: DeloadSession, outputUnit: DeloadUnit): DeloadSessionMetrics {
  const completed = session.sets.filter((set) => set.completed);
  const completionRate = session.plannedSets > 0
    ? Math.round((completed.length / session.plannedSets) * 100) / 100
    : null;
  let volume: number | null = null;
  let bestSetVolume: number | null = null;
  for (const set of completed) {
    if (set.weight == null || set.reps == null) continue;
    const weight = convertDeloadWeight(set.weight, session.unit, outputUnit);
    if (weight == null) continue;
    const setVolume = weight * set.reps;
    volume = (volume ?? 0) + setVolume;
    // Best set only ever considers a real positive load: a recorded
    // 0 is bodyweight, never a comparable load (W3.2 rule).
    if (weight > 0 && (bestSetVolume == null || setVolume > bestSetVolume)) {
      bestSetVolume = setVolume;
    }
  }
  return { completedAt: session.completedAt ?? null, completionRate, volume, bestSetVolume };
}

// Gate A, one metric: strictly down across BOTH steps. The three
// values arrive most recent first ([latest, middle, oldest]).
function declinedTwice(latest: number, middle: number, older: number): boolean {
  const declinedTwice = older > middle && middle > latest;
  return declinedTwice;
}

export function evaluateDeloadAdvisory(input: DeloadAdvisoryInput): DeloadAdvisory {
  const advisoryVersion = DELOAD_ADVISORY_VERSION;
  const judged = input.sessions.slice(0, 3);
  const metrics = judged.map((session) => sessionMetrics(session, input.unit));
  const base = {
    declines: [] as DeloadDecline[],
    signals: [] as DeloadSignal[],
    sessionMetrics: metrics,
    suggestion: null as string | null,
    requiresConfirmation: true as const,
    advisoryVersion,
  };

  // --- gate B signals (computed regardless, so the card and the
  // validator can see exactly which signals fired) ---
  const signals: DeloadSignal[] = [];
  const latest = judged[0];
  if (latest) {
    const sessionRpe = latest.sessionRpe ?? null;
    if (sessionRpe != null && sessionRpe >= HIGH_RPE_THRESHOLD) {
      signals.push({
        kind: "high_rpe",
        detail: `最近一次整场 RPE ${sessionRpe}/10（≥ ${HIGH_RPE_THRESHOLD}）`,
        value: sessionRpe,
      });
    }
    const completedRirs = latest.sets
      .filter((set) => set.completed)
      .map((set) => set.rir)
      .filter((rir): rir is number => rir != null);
    if (completedRirs.length > 0) {
      const minRir = Math.min(...completedRirs);
      if (minRir <= LOW_RIR_THRESHOLD) {
        signals.push({
          kind: "low_rir",
          detail: `最近一次有工作组 RIR ${minRir}（≤ ${LOW_RIR_THRESHOLD}）`,
          value: minRir,
        });
      }
    }
    const painFlags = latest.painFlags ?? [];
    if (painFlags.length > 0) {
      signals.push({
        kind: "pain",
        detail: `最近一次记录了疼痛标记（${painFlags.join("、")}）`,
        value: null,
      });
    }
  }
  const readinessScore = input.readinessScore ?? null;
  if (readinessScore != null && readinessScore < READINESS_LOW_THRESHOLD) {
    signals.push({
      kind: "low_readiness",
      detail: `最新 readiness 分数 ${readinessScore}（< ${READINESS_LOW_THRESHOLD}，低档）`,
      value: readinessScore,
    });
  }
  const hasSignal = signals.length > 0;

  // --- gate A: two consecutive declines over the three most
  // recent sessions, per metric ---
  if (judged.length < 3) {
    return {
      ...base,
      suggested: false,
      signals,
      reason: `同动作只有 ${judged.length} 次可比记录，不足三次，无法判断连续两次下降`,
    };
  }
  const declines: DeloadDecline[] = [];
  const [latestMetrics, middleMetrics, olderMetrics] = metrics as [
    DeloadSessionMetrics,
    DeloadSessionMetrics,
    DeloadSessionMetrics,
  ];
  if (
    latestMetrics.completionRate != null
    && middleMetrics.completionRate != null
    && olderMetrics.completionRate != null
    && declinedTwice(latestMetrics.completionRate, middleMetrics.completionRate, olderMetrics.completionRate)
  ) {
    declines.push({
      metric: "completion_rate",
      values: [olderMetrics.completionRate, middleMetrics.completionRate, latestMetrics.completionRate],
    });
  }
  if (
    latestMetrics.volume != null
    && middleMetrics.volume != null
    && olderMetrics.volume != null
    && declinedTwice(latestMetrics.volume, middleMetrics.volume, olderMetrics.volume)
  ) {
    declines.push({
      metric: "volume",
      values: [olderMetrics.volume, middleMetrics.volume, latestMetrics.volume],
    });
  }
  const hasDecline = declines.length > 0;
  if (!hasDecline) {
    return {
      ...base,
      suggested: false,
      signals,
      reason: "最近三次记录里，完成率与总容量都没有连续两次走低，不触发保守调整建议",
    };
  }
  if (!hasSignal) {
    return {
      ...base,
      suggested: false,
      declines,
      reason: "表现连续两次走低，但没有高 RPE、低 RIR、疼痛标记或低 readiness 信号，单凭表现回落不自动建议 deload，先观察",
    };
  }

  const hasPain = signals.some((signal) => signal.kind === "pain");
  const suggestion = hasPain
    ? "建议先安排恢复日，疼痛缓解前不要加重；恢复训练时把这个动作降重一档或减一组，疼痛持续就停练并咨询专业人士"
    : "建议下次把这个动作降重一档或减一组（两者选一），或安排一个恢复日；恢复到完成率回升后再按原计划继续";
  const declineText = declines
    .map((decline) => (decline.metric === "completion_rate"
      ? `完成率 ${decline.values.map((value) => `${Math.round(value * 100)}%`).join(" → ")}`
      : `总容量 ${decline.values.join(" → ")}`))
    .join("；");
  return {
    ...base,
    suggested: true,
    declines,
    signals,
    suggestion,
    reason: `连续两次表现下降（${declineText}），且出现信号：${signals.map((signal) => signal.detail).join("；")}`,
  };
}

// The user-confirmation gate: an advisory may be recorded as
// accepted ONLY when it was actually raised, it carries the
// confirmation requirement, and the user explicitly confirmed.
// Anything else — no confirmation, a stale advisory, a dismissed
// card — records nothing and changes nothing.
export function canRecordDeloadAdvisory(
  advisory: DeloadAdvisory,
  userConfirmed: boolean,
): boolean {
  return advisory.suggested && advisory.requiresConfirmation && userConfirmed === true;
}
