// HH0.5 ranking rubric + HH0.4 status presentation helpers.
//
// Pure functions only: this module has ZERO imports and every export is
// a deterministic function of its arguments (no I/O, no clock reads —
// callers pass `now` explicitly). The client never recomputes scores;
// it renders the totals and sub-scores the server stored via these
// functions. The public weights and formula are documented in
// DATA-PLAN.md (HH0.5 section) and must stay in sync with this file.

export type ListingStatus =
  | "active"
  | "contingent"
  | "pending"
  | "unknown"
  | "sold"
  | "off_market";

export type StatusTier = "actionable" | "degraded" | "excluded";

export interface SubScores {
  hardCriteria: number | null;
  environment: number | null;
  school: number | null;
  ageCondition: number | null;
  space: number | null;
  priceComps: number | null;
}

// Public rubric weights (percent; they sum to 100). A listing's total
// is the weighted mean of its PRESENT sub-scores, renormalized over
// the weights of the present dimensions only — a missing dimension is
// never treated as 0. When every dimension is missing the total is
// null (no honest score exists) and callers must say so.
export const RUBRIC_WEIGHTS: Readonly<Record<keyof SubScores, number>> = {
  hardCriteria: 20,
  environment: 20,
  school: 20,
  ageCondition: 15,
  space: 10,
  priceComps: 15,
};

export const SUBSCORE_KEYS: readonly (keyof SubScores)[] = [
  "hardCriteria",
  "environment",
  "school",
  "ageCondition",
  "space",
  "priceComps",
];

export const SUBSCORE_LABELS: Readonly<Record<keyof SubScores, string>> = {
  hardCriteria: "硬条件",
  environment: "环境",
  school: "学校/私校",
  ageCondition: "房龄/状态",
  space: "空间",
  priceComps: "价格/可比成交",
};

function isValidSubScore(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100;
}

// Weighted-renormalized total. Returns null when no sub-score is
// present; `complete` is true only when all six dimensions are present.
export function computeRubricScore(sub: SubScores): {
  total: number | null;
  presentCount: number;
  complete: boolean;
} {
  let weightedSum = 0;
  let presentWeight = 0;
  let presentCount = 0;
  for (const key of SUBSCORE_KEYS) {
    const value = sub[key];
    if (isValidSubScore(value)) {
      weightedSum += value * RUBRIC_WEIGHTS[key];
      presentWeight += RUBRIC_WEIGHTS[key];
      presentCount += 1;
    }
  }
  if (presentCount === 0 || presentWeight === 0) {
    return { total: null, presentCount: 0, complete: false };
  }
  return {
    total: Math.round(weightedSum / presentWeight),
    presentCount,
    complete: presentCount === SUBSCORE_KEYS.length,
  };
}

// HH0.4 status tiers. Only "active" is directly actionable.
// contingent/pending (and "unknown", whose state was never positively
// confirmed) are degraded: visible, but in their own section and never
// mixed into the actionable ranking. sold/off_market are excluded from
// the recommendation surface entirely (rows stay in the database).
export function statusTier(status: ListingStatus): StatusTier {
  if (status === "active") return "actionable";
  if (status === "sold" || status === "off_market") return "excluded";
  return "degraded";
}

export function isExcludedStatus(status: ListingStatus): boolean {
  return statusTier(status) === "excluded";
}

// Display label for a status. Meaning rides on the symbol + text, never
// on color alone (color-weakness rule): ● actionable, ◐ degraded,
// ■ excluded.
export function statusLabel(status: ListingStatus): string {
  switch (status) {
    case "active":
      return "● 在售";
    case "contingent":
      return "◐ 已有条件成交";
    case "pending":
      return "◐ 待成交";
    case "sold":
      return "■ 已售出";
    case "off_market":
      return "■ 已下架";
    default:
      return "◐ 状态未确认";
  }
}

// "状态核验于 MM-DD HH:mm" in the report's Pacific timezone, or the
// honest "核验时间未知" when the verification time is missing/invalid.
// Never fabricates a time.
export function formatStatusVerifiedAt(verifiedAtMs: number | null | undefined): string {
  if (typeof verifiedAtMs !== "number" || !Number.isFinite(verifiedAtMs) || verifiedAtMs <= 0) {
    return "核验时间未知";
  }
  const formatted = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(verifiedAtMs));
  // en-US with these options yields "MM/DD, HH:mm"; normalize to MM-DD HH:mm.
  const match = formatted.match(/^(\d{2})\/(\d{2}), (\d{2}:\d{2})$/);
  if (!match) return "核验时间未知";
  return `状态核验于 ${match[1]}-${match[2]} ${match[3]}`;
}

// Ranking order for one report: excluded listings are dropped; the
// rest sort by total score descending. Listings whose total is null
// (no sub-scores at all — legacy rows) keep their stored score as the
// sort key, flagged via scoreIsFallback so the UI can stay honest.
// Ties break by ascending price (better value first), then by the
// incoming order (stable). Returns new rank assignments 1..n in
// display order; degraded listings rank after every actionable one so
// the two tiers never interleave.
export function rankListings<T extends { status: ListingStatus; price: number }>(
  items: readonly T[],
  totalOf: (item: T) => number | null,
  storedScoreOf: (item: T) => number,
): { item: T; rank: number; score: number; scoreIsFallback: boolean }[] {
  const visible = items.filter((item) => !isExcludedStatus(item.status));
  const decorated = visible.map((item, index) => {
    const total = totalOf(item);
    return {
      item,
      index,
      tier: statusTier(item.status),
      score: total ?? storedScoreOf(item),
      scoreIsFallback: total === null,
    };
  });
  decorated.sort((a, b) => {
    if (a.tier !== b.tier) return a.tier === "actionable" ? -1 : 1;
    if (b.score !== a.score) return b.score - a.score;
    if (a.item.price !== b.item.price) return a.item.price - b.item.price;
    return a.index - b.index;
  });
  return decorated.map((entry, i) => ({
    item: entry.item,
    rank: i + 1,
    score: entry.score,
    scoreIsFallback: entry.scoreIsFallback,
  }));
}
