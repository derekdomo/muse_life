// W5.2: plate calculator + warmup set generator (pure functions).
// This module intentionally has NO imports so the repo-side validator
// (validate-plate-warmup.mjs) can load it verbatim with node's type
// stripping and assert every path against the production code.
//
// Plate math, one source of truth for both the calculator and the
// warmup generator: per-side load = (target − bar) / 2, filled
// greedily from the largest plate down. When the target cannot be
// loaded exactly, the result is the closest loadable weight AT OR
// BELOW the target (the greedy fill never overshoots) and `exact` is
// false — the UI must label it as the closest loadable weight, never
// present it as the target itself. All arithmetic runs on integer
// hundredths so 2.5 / 1.25 plates never hit float dust.

export type PlateUnit = "lb" | "kg";

// Plate libraries per unit, descending (the greedy fill relies on
// this order — largest first).
export const PLATE_LIBRARY: Record<PlateUnit, readonly number[]> = {
  lb: [45, 35, 25, 10, 5, 2.5],
  kg: [25, 20, 15, 10, 5, 2.5, 1.25],
};

// Default bar weights per unit.
export const DEFAULT_BAR_WEIGHT: Record<PlateUnit, number> = { lb: 45, kg: 20 };

// Selectable preset bar weights per unit (a custom value is also
// accepted by calcPlateCombo / generateWarmupSets).
export const BAR_WEIGHT_PRESETS: Record<PlateUnit, readonly number[]> = {
  lb: [45, 35],
  kg: [20, 15],
};

export type PlateCombo = {
  unit: PlateUnit;
  barWeight: number;
  targetWeight: number;
  // (target − bar) / 2 — what one side must carry; ≤ 0 when the
  // target is at or below the empty bar.
  perSideTarget: number;
  // Plates for ONE side, largest first (greedy fill order).
  platesPerSide: number[];
  // bar + 2 × sum(platesPerSide) — the weight actually loadable.
  achievedWeight: number;
  // True only when achievedWeight === targetWeight.
  exact: boolean;
};

const SCALE = 100; // hundredths — every library value is exact in it

function toScaled(value: number): number {
  return Math.round(value * SCALE);
}

function fromScaled(value: number): number {
  return value / SCALE;
}

// Greedy largest-first fill of one side. Returns the plate list and
// the achieved per-side total (scaled integers). Never overshoots:
// a plate is taken only while it fits the remaining per-side load.
function greedyFillPerSide(perSideScaled: number, library: readonly number[]): { plates: number[]; totalScaled: number } {
  const plates: number[] = [];
  let remaining = perSideScaled;
  let total = 0;
  for (const plate of library) {
    const plateScaled = toScaled(plate);
    while (plateScaled > 0 && remaining >= plateScaled) {
      plates.push(plate);
      remaining -= plateScaled;
      total += plateScaled;
    }
  }
  return { plates, totalScaled: total };
}

export function calcPlateCombo(targetWeight: number, barWeight: number, unit: PlateUnit): PlateCombo {
  const library = PLATE_LIBRARY[unit];
  const perSideScaled = Math.floor((toScaled(targetWeight) - toScaled(barWeight)) / 2);
  const { plates, totalScaled } = perSideScaled > 0
    ? greedyFillPerSide(perSideScaled, library)
    : { plates: [] as number[], totalScaled: 0 };
  const achievedScaled = toScaled(barWeight) + 2 * totalScaled;
  return {
    unit,
    barWeight,
    targetWeight,
    perSideTarget: fromScaled(Math.max(0, perSideScaled)),
    platesPerSide: plates,
    achievedWeight: fromScaled(achievedScaled),
    exact: achievedScaled === toScaled(targetWeight),
  };
}

// The total weight a warmup percentage rounds to: the raw percentage
// weight run through the same greedy plate fill, so a warmup set is
// always a weight the bar can actually be loaded to.
export function loadableWeight(rawWeight: number, barWeight: number, unit: PlateUnit): number {
  return calcPlateCombo(rawWeight, barWeight, unit).achievedWeight;
}

// --- Warmup set generation ---

export type WarmupStep = { percent: number; reps: number };

export type WarmupPreset = { key: string; label: string; steps: readonly WarmupStep[] };

// The three selectable percentage schemes (W5.2).
export const WARMUP_PRESETS: readonly WarmupPreset[] = [
  {
    key: "standard",
    label: "标准",
    steps: [
      { percent: 50, reps: 8 },
      { percent: 70, reps: 5 },
      { percent: 85, reps: 3 },
    ],
  },
  {
    key: "fewer",
    label: "少组",
    steps: [
      { percent: 60, reps: 5 },
      { percent: 80, reps: 3 },
    ],
  },
  {
    key: "light-many",
    label: "轻量多组",
    steps: [
      { percent: 40, reps: 8 },
      { percent: 55, reps: 5 },
      { percent: 70, reps: 3 },
      { percent: 85, reps: 2 },
    ],
  },
];

export type WarmupSetPlan = {
  percent: number;
  reps: number;
  // target × percent before plate rounding.
  rawWeight: number;
  // rawWeight rounded DOWN to a loadable weight (same plate fill as
  // calcPlateCombo); never above rawWeight, never below the bar.
  weight: number;
  // Plates for one side at `weight`.
  platesPerSide: number[];
};

// Generate the warmup sets for a target weight under one scheme.
// Every set's weight is rounded to a loadable weight with the plate
// calculator's own fill, so the displayed warmup weights are always
// weights the user can actually load.
export function generateWarmupSets(
  targetWeight: number,
  barWeight: number,
  unit: PlateUnit,
  steps: readonly WarmupStep[],
): WarmupSetPlan[] {
  return steps.map((step) => {
    const rawWeight = (targetWeight * step.percent) / 100;
    const combo = calcPlateCombo(rawWeight, barWeight, unit);
    return {
      percent: step.percent,
      reps: step.reps,
      rawWeight,
      weight: combo.achievedWeight,
      platesPerSide: combo.platesPerSide,
    };
  });
}

// Display formatting: integers stay plain ("45"), fractions keep
// only the decimals they need ("2.5", "1.25").
export function formatPlateWeight(value: number): string {
  if (Number.isInteger(value)) return String(value);
  return String(Math.round(value * 100) / 100);
}

// One side's plate list as text, e.g. "45 + 10"; an empty side (the
// bare bar) reads "空杆".
export function formatPlatesPerSide(platesPerSide: readonly number[]): string {
  if (platesPerSide.length === 0) return "空杆";
  return platesPerSide.map(formatPlateWeight).join(" + ");
}
