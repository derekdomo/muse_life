// W4.2: read-only readiness tip carried from 健康看板 (space-4) into
// 训练记录's start page. This module is pure (zero imports) so the
// repo's verification scripts can extract and run it directly.
//
// It mirrors space-4's H2.1 readiness-advice contract for VALIDATION
// only — it never recomputes readiness itself. The tip is a verbatim
// pass-through of space-4's getDashboard.readinessAdvice plus the
// read-start version stamp; a missing or contract-violating payload
// honestly falls back to 数据不足 with null score/signal counts —
// never 0-filled, never invented.
//
// Read-only red line (W4.2): the tip may inform, never decide. It can
// never change a plan, a weight, a set, a completion state, an auto
// prefill, or a progression verdict. canReadinessTipModifyPlan is the
// executable form of that line — it unconditionally returns false.

export const READINESS_TIP_TIERS = ["normal", "reduced", "recovery", "insufficient"] as const;

export type ReadinessTipTier = (typeof READINESS_TIP_TIERS)[number];

export interface ReadinessTipTierMeta {
  label: string;
  symbol: string;
  level: number;
  headline: string;
}

// Tier meta is pinned to space-4's H2.1 contract (readiness-advice.ts):
// symbol + label + numeric level always render together (the owner's
// color-vision rule); the headline is a single actionable,
// non-medical sentence, deliberately free of any weight/set/rep or
// exercise prescription.
export const READINESS_TIP_META: Record<ReadinessTipTier, ReadinessTipTierMeta> = {
  normal: { label: "正常计划", symbol: "✓", level: 3, headline: "按计划训练即可。" },
  reduced: { label: "降强度", symbol: "▼", level: 2, headline: "降低强度或缩短时长。" },
  recovery: { label: "恢复日", symbol: "○", level: 1, headline: "安排恢复日或休息。" },
  insufficient: { label: "数据不足", symbol: "—", level: 0, headline: "先补齐数据再定计划。" },
};

// The structural minimum of space-4's readinessAdvice this module
// accepts. readStartedAt is NOT part of the source payload — it is
// stamped by the sync task at the moment its space-4 read began (the
// L1-RACE-001 version contract) and carried alongside the tip.
export interface ReadinessTipAdviceInput {
  tier: string;
  label: string;
  symbol: string;
  level: number;
  headline: string;
  status: string;
  score: number | null;
  confidence: string;
  signalCount: number | null;
  reasons: string[];
  missingSignals: string[];
}

export interface ReadinessTip {
  tier: ReadinessTipTier;
  label: string;
  symbol: string;
  level: number;
  headline: string;
  status: string;
  score: number | null;
  confidence: string;
  signalCount: number | null;
  reasons: string[];
  missingSignals: string[];
  readStartedAt: string;
}

// The tip is read-only: it can never change a plan. This function is
// the executable form of the W4.2 red line — it unconditionally
// returns false, and the validator pins it with a mutation run.
export function canReadinessTipModifyPlan(): false {
  return false;
}

function isValidTier(tier: string): tier is ReadinessTipTier {
  return (READINESS_TIP_TIERS as readonly string[]).includes(tier);
}

// Validate that an incoming space-4 readinessAdvice payload honours
// the H2.1 contract before it is trusted: tier in the closed set,
// label/symbol/level/headline exactly the pinned meta for that tier,
// reasons and missingSignals arrays. Returns null when valid, else a
// short machine-readable reason. A null/undefined payload is "missing"
// (not "invalid") — the caller maps both to the 数据不足 fallback,
// but the distinction is kept for honest logging.
export function validateReadinessAdvice(
  advice: ReadinessTipAdviceInput | null | undefined,
): "missing" | null | string {
  if (advice === null || advice === undefined) return "missing";
  if (typeof advice !== "object") return "not-an-object";
  if (!isValidTier(advice.tier)) return "unknown-tier";
  const meta = READINESS_TIP_META[advice.tier];
  if (advice.label !== meta.label) return "label-mismatch";
  if (advice.symbol !== meta.symbol) return "symbol-mismatch";
  if (advice.level !== meta.level) return "level-mismatch";
  if (advice.headline !== meta.headline) return "headline-mismatch";
  if (typeof advice.status !== "string" || advice.status.length === 0) return "bad-status";
  if (advice.score !== null && typeof advice.score !== "number") return "bad-score";
  if (typeof advice.confidence !== "string" || advice.confidence.length === 0) return "bad-confidence";
  if (advice.signalCount !== null && typeof advice.signalCount !== "number") return "bad-signal-count";
  if (!Array.isArray(advice.reasons)) return "bad-reasons";
  if (!Array.isArray(advice.missingSignals)) return "bad-missing-signals";
  return null;
}

function insufficientTip(readStartedAt: string, reasons: string[]): ReadinessTip {
  const meta = READINESS_TIP_META.insufficient;
  return {
    tier: "insufficient",
    label: meta.label,
    symbol: meta.symbol,
    level: meta.level,
    headline: meta.headline,
    status: "数据不足",
    // Honest fallback: score and signal counts stay null — never
    // 0-filled, never invented. The panel renders — / 暂无.
    score: null,
    confidence: "低",
    signalCount: null,
    reasons,
    missingSignals: [],
    readStartedAt,
  };
}

// Build the start-page tip from space-4's getDashboard.readinessAdvice
// (or null when the sync task could not read it). Valid payloads pass
// through verbatim — tier, status word, score, confidence, signal
// count, reasons, missing signals. Missing or contract-violating
// payloads fall back to the 数据不足 tip above; the fallback never
// fabricates a tier, a score, or a signal count.
export function buildReadinessTip(
  advice: ReadinessTipAdviceInput | null | undefined,
  readStartedAt: string,
): ReadinessTip {
  const verdict = validateReadinessAdvice(advice);
  if (verdict === "missing") {
    return insufficientTip(readStartedAt, ["健康看板暂无训练建议（未同步或读取失败），先补齐数据再定计划。"]);
  }
  if (verdict !== null) {
    return insufficientTip(readStartedAt, [
      `健康看板返回的建议未通过口径校验（${verdict}），未采用。`,
    ]);
  }
  const valid = advice as ReadinessTipAdviceInput;
  const meta = READINESS_TIP_META[valid.tier];
  return {
    tier: valid.tier,
    label: meta.label,
    symbol: meta.symbol,
    level: meta.level,
    headline: meta.headline,
    status: valid.status,
    score: valid.score,
    confidence: valid.confidence,
    signalCount: valid.signalCount,
    reasons: [...valid.reasons],
    missingSignals: [...valid.missingSignals],
    readStartedAt,
  };
}

export type ReadinessTipSaveDecision = "apply" | "duplicate" | "ignore";

// Version contract for the tip cache (mirrors L1-RACE-001): the save
// is versioned by the read-start instant, not the write instant. A
// tip whose read started later always wins; the same instant is a
// duplicate (the DB layer then distinguishes identical payload from
// conflicting payload); an older instant is ignored so a slow task
// can never roll the panel back to stale advice.
export function decideReadinessTipSave(
  existingReadStartedAt: string | null,
  incomingReadStartedAt: string,
): ReadinessTipSaveDecision {
  if (existingReadStartedAt === null) return "apply";
  const existingMs = Date.parse(existingReadStartedAt);
  const incomingMs = Date.parse(incomingReadStartedAt);
  if (Number.isNaN(incomingMs)) return "ignore";
  if (Number.isNaN(existingMs)) return "apply";
  if (incomingMs > existingMs) return "apply";
  if (incomingMs === existingMs) return "duplicate";
  return "ignore";
}
