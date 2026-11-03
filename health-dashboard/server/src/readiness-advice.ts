// H2.1 今日训练建议 (today's training advice), derived presentation
// over the readiness result. This module is PURE: it has no imports,
// performs no I/O, and reads no clock — every input arrives as an
// argument, so repo-side validation (validate-readiness-advice.mjs)
// can load it verbatim and run it over synthetic fixtures.
//
// Scope: this module ONLY maps an already-computed readiness result
// to a training-advice tier and names the facts that triggered that
// tier. It never recomputes readiness, never changes any score,
// weight, threshold, or adjustment, and never produces a workout
// prescription — no weights, no sets, no reps, no exercise list.
// The advice headline is one non-medical, actionable sentence per
// tier. Nothing here writes to any training log (workout-log): the
// health dashboard and 训练记录 (space-6) stay independent apps,
// and this card only points at the other app honestly (H2.2).
//
// Mapping (the readiness status is the sole tier input — the score
// never re-tiers a day, so the advice can never disagree with the
// readiness grade the owner already sees):
// - 准备就绪 / 全力以赴 → 正常计划 (normal)
// - 量力而行 → 降强度 (reduced)
// - 恢复 → 恢复日 (recovery)
// - 数据不足 → 数据不足 (insufficient)
// - 状态期 (H4.4: readiness suppressed by an owner-declared status
//   period) → NO advice at all (null). A status day is not a low
//   score and must never be dressed up as a recovery recommendation.
//
// Every advice carries its trigger basis (`reasons`): the readiness
// status and score, the confidence and signal count, every readiness
// adjustment verbatim, the component items behind the tier (the
// lowest-scored components for 降强度 / 恢复日, the highest-scored
// for 正常计划), and every missing signal named individually —
// a missing component is named, never silently dropped and never
// counted as zero. Meaning rides on symbol + text + number together
// (the owner's color-vision rule): each tier has a symbol, a text
// label, and a numeric level (3 / 2 / 1 / 0).

export const READINESS_ADVICE_TIERS = ["normal", "reduced", "recovery", "insufficient"] as const;

export type ReadinessAdviceTier = (typeof READINESS_ADVICE_TIERS)[number];

export interface ReadinessAdviceTierMeta {
  label: string;
  symbol: string;
  level: number;
  headline: string;
}

// One meta per tier: symbol + label + level are always rendered
// together, and the headline is the tier's single actionable,
// non-medical sentence — deliberately free of any weight, set,
// rep, or exercise prescription.
export const READINESS_ADVICE_META: Record<ReadinessAdviceTier, ReadinessAdviceTierMeta> = {
  normal: { label: "正常计划", symbol: "✓", level: 3, headline: "按计划训练即可。" },
  reduced: { label: "降强度", symbol: "▼", level: 2, headline: "降低强度或缩短时长。" },
  recovery: { label: "恢复日", symbol: "○", level: 1, headline: "安排恢复日或休息。" },
  insufficient: { label: "数据不足", symbol: "—", level: 0, headline: "先补齐数据再定计划。" },
};

// The status → tier map. 状态期 is deliberately ABSENT: it is not a
// tier, and adviceTierForStatus returns null for it (and for any
// unknown status), which buildReadinessAdvice turns into no advice.
export const READINESS_STATUS_TO_ADVICE_TIER: Record<string, ReadinessAdviceTier> = {
  "准备就绪": "normal",
  "全力以赴": "normal",
  "量力而行": "reduced",
  "恢复": "recovery",
  "数据不足": "insufficient",
};

export interface ReadinessAdviceComponentInput {
  key: string;
  label: string;
  score: number | null;
  detail: string;
  missingLabel: string | null;
}

// The readiness statuses that can carry an advice tier, plus the
// H4.4 suppressed status (which never does). The output's status and
// confidence keep the readiness result's own enum types so callers
// can feed the advice straight into a typed response schema.
export type ReadinessAdviceStatus = "恢复" | "量力而行" | "准备就绪" | "全力以赴" | "数据不足";
export type ReadinessAdviceConfidence = "高" | "中" | "低";

// The structural minimum of a readiness result this module reads.
// `suppressed` is the caller's H4.4 flag (the readiness date falls
// inside an owner-declared status period); the suppressed status
// string "状态期" is honoured as well, so either signal alone is
// enough to withhold advice.
export interface ReadinessAdviceInput {
  status: ReadinessAdviceStatus | "状态期";
  score: number | null;
  confidence: ReadinessAdviceConfidence;
  signalCount: number;
  adjustments: string[];
  components: ReadinessAdviceComponentInput[];
  suppressed?: boolean;
}

export interface ReadinessAdvice {
  tier: ReadinessAdviceTier;
  label: string;
  symbol: string;
  level: number;
  headline: string;
  status: ReadinessAdviceStatus;
  score: number | null;
  confidence: ReadinessAdviceConfidence;
  signalCount: number;
  reasons: string[];
  missingSignals: string[];
}

export function adviceTierForStatus(status: string): ReadinessAdviceTier | null {
  return READINESS_STATUS_TO_ADVICE_TIER[status] ?? null;
}

// Every component whose score is missing, named individually with
// its reason (the readiness missing label when one exists — 还没同步完
// / 当天没戴表 — otherwise the component's own detail). A component
// with a score is never listed here.
export function missingSignalsFor(components: readonly ReadinessAdviceComponentInput[]): string[] {
  return components
    .filter((component) => component.score === null)
    .map((component) => `${component.label}：${component.missingLabel ?? component.detail}`);
}

function formatScore(score: number): string {
  return Number.isInteger(score) ? String(score) : score.toFixed(1);
}

// Derive today's training advice from one readiness result, or null
// when no advice may be given: no readiness at all, or a status
// period (H4.4) suppressing the day. The derivation is a pure map —
// the input object is never mutated.
export function buildReadinessAdvice(input: ReadinessAdviceInput | null | undefined): ReadinessAdvice | null {
  if (!input) return null;
  if (input.suppressed || input.status === "状态期") return null;
  const tier = adviceTierForStatus(input.status);
  if (tier === null) return null;
  const meta = READINESS_ADVICE_META[tier];
  const missingSignals = missingSignalsFor(input.components);

  const reasons: string[] = [];
  reasons.push(`准备度状态「${input.status}」对应建议档「${meta.label}」（第 ${meta.level} 档）`);
  if (input.score !== null) {
    reasons.push(`准备度分数 ${formatScore(input.score)}/10`);
  } else {
    reasons.push("准备度分数暂无（数据不足，未产生分数）");
  }
  reasons.push(`置信度${input.confidence} · 可用信号 ${input.signalCount} 项`);
  for (const adjustment of input.adjustments) {
    reasons.push(`保守修正：${adjustment}`);
  }

  const scored = input.components.filter((component) => component.score !== null);
  if (tier === "insufficient") {
    reasons.push(`可用信号 ${input.signalCount} 项，未达到产生准备度分数所需的至少两项具备历史读数的信号`);
    for (const missing of missingSignals) {
      reasons.push(`缺失信号：${missing}`);
    }
  } else if (tier === "normal") {
    const strongest = [...scored].sort((a, b) => (b.score ?? 0) - (a.score ?? 0)).slice(0, 2);
    for (const component of strongest) {
      reasons.push(`支撑组件：${component.label} ${formatScore(component.score ?? 0)}/10 · ${component.detail}`);
    }
    for (const missing of missingSignals) {
      reasons.push(`缺失信号：${missing}`);
    }
  } else {
    const weakest = [...scored].sort((a, b) => (a.score ?? 0) - (b.score ?? 0)).slice(0, 2);
    for (const component of weakest) {
      reasons.push(`主要拉分组件：${component.label} ${formatScore(component.score ?? 0)}/10 · ${component.detail}`);
    }
    for (const missing of missingSignals) {
      reasons.push(`缺失信号：${missing}`);
    }
  }

  return {
    tier,
    label: meta.label,
    symbol: meta.symbol,
    level: meta.level,
    headline: meta.headline,
    status: input.status,
    score: input.score,
    confidence: input.confidence,
    signalCount: input.signalCount,
    reasons,
    missingSignals,
  };
}
