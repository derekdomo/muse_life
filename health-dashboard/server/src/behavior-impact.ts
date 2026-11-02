// H4.1 行为—恢复影响分析 (behavior → next-day recovery correlation),
// borrowed from Whoop / Bevel Journal. This module is PURE: it has no
// imports, performs no I/O, and reads no clock — every input arrives as
// an argument, so repo-side validation (validate-behavior-impact.mjs)
// can load it verbatim and run it over synthetic fixtures.
//
// Data caliber: the inputs are the SAME sources every other panel
// reads — morning_checkin behavior tags (saved per day by
// saveMorningCheckin), the health snapshot's historyDaily HRV, and the
// readiness_history archive scores. No second data copy and no second
// sync path exist for this analysis.
//
// Definitions (shown verbatim on the page):
// - A "tagged day" for a behaviour is a check-in date whose tag list
//   contains that behaviour. The baseline for a behaviour is every
//   OTHER check-in date — days where that behaviour was NOT tagged.
//   Days with no check-in at all belong to neither group, because
//   their behaviour is unknown; they are never counted as baseline.
// - The outcome of a day D is the NEXT calendar day's (D + 1) value:
//   next-day HRV from historyDaily.hrvMs and next-day readiness from
//   the readiness_history score. Alignment is strictly D → D+1; the
//   same day's values never enter the comparison.
// - A pair whose next-day value is missing (no historyDaily row for
//   D+1, a null HRV, no archive row for D+1, or a null archived score)
//   is EXCLUDED from that metric's means and counted in the result's
//   excluded counters, so the sample note stays honest. HRV and
//   readiness pairs are counted independently — a day can contribute
//   to one metric and be excluded from the other.
// - Difference = tagged-group next-day mean − baseline-group next-day
//   mean, reported separately for HRV (ms) and readiness (points).
//   A difference is null whenever either side has no usable pair —
//   never 0, never invented.
// - Sample gate: a behaviour with fewer than BEHAVIOR_MIN_SAMPLE (5)
//   tagged days is `sufficient: false` and its differences are forced
//   to null — the panel shows 样本不足 and renders no numbers. The
//   gate judges the tagged-day count, not the surviving pairs, so a
//   behaviour whose pairs were mostly excluded still reports how many
//   pairs survived via the pair counters.
// - Honesty: this is correlation only. The module emits means, counts
//   and differences — never a causal claim and never a medical
//   judgement. Direction symbols (▲ higher / ▼ lower / ● flat) pair
//   with the signed number and a text word on the panel, so meaning
//   never rides on color alone (the owner's color-vision rule).

export const BEHAVIOR_TAGS = ["饮酒", "咖啡因", "晚睡", "晚进食", "出差"] as const;

export type BehaviorTag = (typeof BEHAVIOR_TAGS)[number];

export const BEHAVIOR_MIN_SAMPLE = 5;

export interface BehaviorCheckinInput {
  date: string;
  tags: string[];
}

export interface BehaviorDailyInput {
  date: string;
  hrvMs: number | null;
}

export interface BehaviorReadinessInput {
  date: string;
  score: number | null;
}

export interface BehaviorImpactItem {
  tag: BehaviorTag;
  label: string;
  // Total check-in days carrying this tag (the gate's numerator).
  taggedDays: number;
  // Surviving next-day pairs on each side of each metric.
  hrvTaggedPairs: number;
  hrvBaselinePairs: number;
  readinessTaggedPairs: number;
  readinessBaselinePairs: number;
  // Tagged days excluded from each metric because the next-day value
  // was missing (taggedDays − pairs on the tagged side).
  hrvExcluded: number;
  readinessExcluded: number;
  // Next-day means; null when that side has no surviving pair.
  hrvTaggedMean: number | null;
  hrvBaselineMean: number | null;
  readinessTaggedMean: number | null;
  readinessBaselineMean: number | null;
  // Tagged mean − baseline mean; null when either mean is null OR
  // when the sample gate fails (样本不足 renders no difference).
  hrvDiff: number | null;
  readinessDiff: number | null;
  sufficient: boolean;
}

export function behaviorIsKnownTag(value: string): value is BehaviorTag {
  return (BEHAVIOR_TAGS as readonly string[]).includes(value);
}

// Parse the stored morning_checkin.behavior_tags value (a JSON array
// of tag strings, or null for rows saved before the column existed)
// into the known-tag subset. Unknown values, malformed JSON, and
// non-array payloads all degrade to an empty list — a corrupt tag
// cell must never invent a behaviour or break the dashboard read.
export function parseBehaviorTags(stored: string | null | undefined): BehaviorTag[] {
  if (stored === null || stored === undefined || stored === "") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(stored);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const present = new Set<string>();
  for (const entry of parsed) {
    if (typeof entry === "string") present.add(entry);
  }
  // Canonical BEHAVIOR_TAGS order, deduped — the same stable order
  // serializeBehaviorTags writes, so a stored value round-trips.
  return BEHAVIOR_TAGS.filter((tag) => present.has(tag));
}

// Serialize a tag selection for storage: known tags only, deduped,
// in the canonical BEHAVIOR_TAGS order so stored values are stable.
export function serializeBehaviorTags(tags: readonly string[]): string {
  const known = BEHAVIOR_TAGS.filter((tag) => tags.includes(tag));
  return JSON.stringify(known);
}

export function behaviorIsRealDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const candidate = new Date(`${value}T12:00:00Z`);
  return !Number.isNaN(candidate.getTime()) && candidate.toISOString().slice(0, 10) === value;
}

export function behaviorShiftDate(date: string, days: number): string {
  const parsed = new Date(`${date}T12:00:00Z`);
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

export function behaviorNextDate(date: string): string {
  return behaviorShiftDate(date, 1);
}

export function behaviorDirection(diff: number | null): { symbol: string; word: string } {
  if (diff === null) return { symbol: "—", word: "无数据" };
  if (diff > 0) return { symbol: "▲", word: "较高" };
  if (diff < 0) return { symbol: "▼", word: "较低" };
  return { symbol: "●", word: "持平" };
}

function behaviorRound(value: number, digits = 1): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function meanOf(values: number[]): number | null {
  if (!values.length) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function computeBehaviorImpact(
  checkins: BehaviorCheckinInput[],
  daily: BehaviorDailyInput[],
  readiness: BehaviorReadinessInput[],
): BehaviorImpactItem[] {
  const hrvByDate = new Map<string, number | null>();
  for (const row of daily) {
    if (behaviorIsRealDate(row.date)) hrvByDate.set(row.date, row.hrvMs);
  }
  const readinessByDate = new Map<string, number | null>();
  for (const row of readiness) {
    if (behaviorIsRealDate(row.date)) readinessByDate.set(row.date, row.score);
  }
  // Only real check-in dates participate; a malformed date can never
  // align to a next day and is dropped from both groups.
  const validCheckins = checkins.filter((row) => behaviorIsRealDate(row.date));

  return BEHAVIOR_TAGS.map((tag) => {
    const taggedDates: string[] = [];
    const baselineDates: string[] = [];
    for (const row of validCheckins) {
      if (row.tags.includes(tag)) taggedDates.push(row.date);
      else baselineDates.push(row.date);
    }
    const collect = (
      dates: string[],
      lookup: Map<string, number | null>,
    ): number[] => {
      const values: number[] = [];
      for (const date of dates) {
        const nextValue = lookup.get(behaviorNextDate(date));
        if (nextValue !== undefined && nextValue !== null) values.push(nextValue);
      }
      return values;
    };
    const hrvTaggedValues = collect(taggedDates, hrvByDate);
    const hrvBaselineValues = collect(baselineDates, hrvByDate);
    const readinessTaggedValues = collect(taggedDates, readinessByDate);
    const readinessBaselineValues = collect(baselineDates, readinessByDate);

    const hrvTaggedMeanRaw = meanOf(hrvTaggedValues);
    const hrvBaselineMeanRaw = meanOf(hrvBaselineValues);
    const readinessTaggedMeanRaw = meanOf(readinessTaggedValues);
    const readinessBaselineMeanRaw = meanOf(readinessBaselineValues);

    const sufficient = taggedDates.length >= BEHAVIOR_MIN_SAMPLE;
    const hrvDiffRaw =
      sufficient && hrvTaggedMeanRaw !== null && hrvBaselineMeanRaw !== null
        ? hrvTaggedMeanRaw - hrvBaselineMeanRaw
        : null;
    const readinessDiffRaw =
      sufficient && readinessTaggedMeanRaw !== null && readinessBaselineMeanRaw !== null
        ? readinessTaggedMeanRaw - readinessBaselineMeanRaw
        : null;

    return {
      tag,
      label: tag,
      taggedDays: taggedDates.length,
      hrvTaggedPairs: hrvTaggedValues.length,
      hrvBaselinePairs: hrvBaselineValues.length,
      readinessTaggedPairs: readinessTaggedValues.length,
      readinessBaselinePairs: readinessBaselineValues.length,
      hrvExcluded: taggedDates.length - hrvTaggedValues.length,
      readinessExcluded: taggedDates.length - readinessTaggedValues.length,
      hrvTaggedMean: hrvTaggedMeanRaw === null ? null : behaviorRound(hrvTaggedMeanRaw),
      hrvBaselineMean: hrvBaselineMeanRaw === null ? null : behaviorRound(hrvBaselineMeanRaw),
      readinessTaggedMean: readinessTaggedMeanRaw === null ? null : behaviorRound(readinessTaggedMeanRaw),
      readinessBaselineMean: readinessBaselineMeanRaw === null ? null : behaviorRound(readinessBaselineMeanRaw),
      hrvDiff: hrvDiffRaw === null ? null : behaviorRound(hrvDiffRaw),
      readinessDiff: readinessDiffRaw === null ? null : behaviorRound(readinessDiffRaw),
      sufficient,
    };
  });
}
