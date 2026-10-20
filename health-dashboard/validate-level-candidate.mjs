// CWEB-LEVEL-001 offline candidate — path A "game reference status index"
// (implementer deliverable; candidate v1, revised after PM 2026-10-20 06:26
// review of v0).
//
// WHAT THIS IS: a runnable, synthetic-only offline candidate that turns the
// existing health pipeline signals into a TRANSPARENT reference index, so
// the owner/PM can judge sensitivity before any parameter is decided. It is
// NOT a body-age model: nothing here outputs years, and the realm threshold
// table below is an UNCALIBRATED PROPOSAL used only to demonstrate boundary
// behaviour. Production code (server/src/actions.ts) is untouched; the live
// level remains the transitional XP level until the owner decides.
//
// Path B (a reproducible published body-age model) stays blocked on input
// incompatibility, evidenced in plans.md (PhenoAge, Levine et al. 2018,
// needs actual age + 9 clinical biomarkers; the pipeline carries only
// activity/sleep/HRV/RHR/strength). No years are invented here.
//
// PM v0 defects fixed in v1 (2026-10-20 06:26 bug item 4):
//   (a) v0 scale made the ladder partly unreachable: each z is clamped to
//       ±2.5, so v0's index = 50 + 10*meanZ could only reach 75, while the
//       step thresholds run to 98 — steps 28..39 could never be reached.
//       v1 uses index = clamp(50 + 20*meanZ, 0, 100) (PROPOSAL), whose
//       reachable interval is the full [0, 100]; reachability is computed
//       and asserted per age band below, not just claimed.
//   (b) v0 documented ">=14 valid days per signal" but had no such input
//       or check (a baseline built from validDays=0 still scored ok).
//       v1 baselines carry per-signal validDays; a signal whose baseline
//       has <14 valid days is unavailable, and <3 available signals is
//       unevaluable. Coverage is reported per signal in the result.
//   (c) v0's strength signal used a fixed 3/week reference while the doc
//       claimed a personal 28-day baseline. v1 aligns the implementation
//       to the documented口径: strength is scored against the person's own
//       baseline distribution of weekly session counts (mean/sd/validDays),
//       exactly like the other four signals.
//
// Index definition (candidate v1, all parameters labelled PROPOSAL):
//   per-signal direction-adjusted z against the person's own 28-day
//   baseline (baseline usable only with >=14 valid days for that signal):
//     RHR      z = (baselineMean - value) / baselineSd   (lower is better)
//     HRV      z = (value - baselineMean) / baselineSd   (higher is better)
//     sleep    z = (mainSleepHours - baselineMean) / baselineSd
//     steps    z = (value - baselineMean) / baselineSd
//     strength z = (sessionsLast7d - baselineMean) / baselineSd
//                  (baseline = own weekly-session-count distribution)
//   each z clamped to [-2.5, +2.5]; index = clamp(50 + 20 * meanZ, 0, 100)
//   with equal weights over the AVAILABLE signals (renormalised).
//   Fewer than 3 available signals, a partial day, or an all-empty input
//   yields status "unevaluable" (preview only, no index, no realm change) —
//   matching the fixed rule that missing/partial data never reads as worse.
//
// Realm ladder (owner-decided names): 10 realms x 4 sub-stages = 40 steps.
// Candidate threshold for step k (0-based): index >= 20 + 2k (20..98),
// age-graded by a PROPOSAL multiplier per age band (40s 1.00, 50s 0.92,
// 60s 0.84, 70+ 0.76) applied to the step requirement above the floor of 20:
//   required(k, band) = 20 + (2k) * bandMultiplier.
// All threshold numbers are proposals pending owner decision, NOT calibrated.

const REALMS = ["凡人", "炼气", "筑基", "金丹", "元婴", "化神", "炼虚", "合体", "大乘", "渡劫飞升"];
const SUB_STAGES = ["初期", "中期", "后期", "圆满"];
const AGE_BAND_MULTIPLIER = { "40s": 1.0, "50s": 0.92, "60s": 0.84, "70+": 0.76 }; // PROPOSAL
const MIN_BASELINE_VALID_DAYS = 14; // documented >=14 valid days per signal
const Z_CLAMP = 2.5;
const INDEX_SCALE = 20; // v1 PROPOSAL (v0 used 10, which capped index at 75)

function clamp(value, lo, hi) { return Math.min(hi, Math.max(lo, value)); }

function zScore(value, mean, sd, lowerIsBetter) {
  if (value === null || value === undefined || mean === null || mean === undefined || sd === null || sd === undefined || !(sd > 0)) return null;
  const raw = (value - mean) / sd;
  return clamp(lowerIsBetter ? -raw : raw, -Z_CLAMP, Z_CLAMP);
}

// A baseline entry is usable only when it carries >= MIN_BASELINE_VALID_DAYS
// valid days; anything else (including a missing validDays field, i.e. a
// legacy/undocumented baseline) makes that signal unavailable — never
// silently trusted.
function baselineUsable(entry) {
  return !!entry && typeof entry.validDays === "number" && entry.validDays >= MIN_BASELINE_VALID_DAYS && entry.mean !== null && entry.mean !== undefined && entry.sd > 0;
}

// signals: { rhr, hrv, sleepHours, steps, strengthSessions7d } (null = missing)
// baseline: per-signal { mean, sd, validDays } for rhr/hrv/sleepHours/steps/strength
// coverageComplete: false when the source day is partial.
function referenceIndex(signals, baseline, coverageComplete) {
  if (!coverageComplete) return { status: "unevaluable", reason: "partial", index: null, usedSignals: [], coverage: {} };
  const parts = [];
  const coverage = {};
  const add = (name, value, entry, lowerIsBetter) => {
    const usable = baselineUsable(entry);
    coverage[name] = { validDays: entry?.validDays ?? null, baselineUsable: usable, valuePresent: value !== null && value !== undefined };
    if (!usable) return;
    const z = zScore(value, entry.mean, entry.sd, lowerIsBetter);
    if (z !== null) parts.push({ name, z });
  };
  add("rhr", signals.rhr, baseline.rhr, true);
  add("hrv", signals.hrv, baseline.hrv, false);
  add("sleep", signals.sleepHours, baseline.sleepHours, false);
  add("steps", signals.steps, baseline.steps, false);
  add("strength", signals.strengthSessions7d, baseline.strength, false);
  if (parts.length < 3) return { status: "unevaluable", reason: "too_few_signals", index: null, usedSignals: parts.map((p) => p.name), coverage };
  const meanZ = parts.reduce((sum, p) => sum + p.z, 0) / parts.length;
  return { status: "ok", index: Math.round((50 + INDEX_SCALE * meanZ) * 10) / 10, usedSignals: parts.map((p) => p.name), coverage };
}

// Theoretical reachable index interval under the clamp math: meanZ ranges
// over [-Z_CLAMP, +Z_CLAMP], so the interval is computed, not asserted.
function reachableIndexRange() {
  return [clamp(50 - INDEX_SCALE * Z_CLAMP, 0, 100), clamp(50 + INDEX_SCALE * Z_CLAMP, 0, 100)];
}

function requiredForStep(k, ageBand) {
  // Fixed-point discipline (PM 2026-10-20 09:29 float-boundary bug): the raw
  // product 20 + 2k*0.92 yields e.g. 29.200000000000003 for k=5 in the 50s
  // band, while referenceIndex rounds its output to one decimal (29.2) — an
  // index that theoretically meets the threshold then compared BELOW it and
  // lost a step. Normalise the requirement to 4 decimal places so the
  // threshold and the index live at a consistent, stable precision; the
  // comparison in realmStep additionally tolerates 1e-9 of representation
  // noise. No proposal parameter (multiplier/floor/scale) is changed.
  return Math.round((20 + 2 * k * AGE_BAND_MULTIPLIER[ageBand]) * 10000) / 10000;
}

// Highest step (0..39) whose requirement the index meets; -1 below step 0.
function realmStep(index, ageBand) {
  if (index === null) return null;
  let step = -1;
  for (let k = 0; k < 40; k++) {
    if (index >= requiredForStep(k, ageBand) - 1e-9) step = k; else break;
  }
  return step;
}

function realmLabel(step) {
  if (step === null) return "当前未能评估";
  if (step < 0) return `${REALMS[0]}·未入阶`;
  return `${REALMS[Math.floor(step / 4)]}·${SUB_STAGES[step % 4]}`;
}

// ---------------------------------------------------------------- fixtures
const BASELINE = {
  rhr: { mean: 65, sd: 3, validDays: 28 },
  hrv: { mean: 40, sd: 8, validDays: 28 },
  sleepHours: { mean: 6.8, sd: 0.7, validDays: 28 },
  steps: { mean: 4000, sd: 1500, validDays: 28 },
  strength: { mean: 3, sd: 1, validDays: 28 },
};
const AT_BASELINE = { rhr: 65, hrv: 40, sleepHours: 6.8, steps: 4000, strengthSessions7d: 3 };
const BETTER = { rhr: 61, hrv: 50, sleepHours: 7.6, steps: 7000, strengthSessions7d: 4 };
const WORSE = { rhr: 70, hrv: 31, sleepHours: 5.6, steps: 1800, strengthSessions7d: 1 };
const ALL_NULL = { rhr: null, hrv: null, sleepHours: null, steps: null, strengthSessions7d: null };
const TWO_SIGNALS = { rhr: 61, hrv: 50, sleepHours: null, steps: null, strengthSessions7d: null };
const ALL_EXTREME_GOOD = { rhr: 40, hrv: 120, sleepHours: 11, steps: 30000, strengthSessions7d: 7 };
const ALL_EXTREME_BAD = { rhr: 90, hrv: 5, sleepHours: 2, steps: 0, strengthSessions7d: 0 };

let passed = 0, failed = 0;
function check(name, condition, detail = "") {
  if (condition) { passed++; console.log(`PASS ${name}`); }
  else { failed++; console.log(`FAIL ${name} ${detail}`); }
}

const base = referenceIndex(AT_BASELINE, BASELINE, true);
check("at-baseline evaluates to index 50", base.status === "ok" && base.index === 50, JSON.stringify(base));
const better = referenceIndex(BETTER, BASELINE, true);
check("better-than-baseline day scores above 50", better.status === "ok" && better.index > 60, JSON.stringify(better));
const worse = referenceIndex(WORSE, BASELINE, true);
check("worse-than-baseline day scores below 40 (strict float: index can fall)", worse.status === "ok" && worse.index < 40, JSON.stringify(worse));
check("ordering better > baseline > worse", better.index > base.index && base.index > worse.index);
check("all-empty input is unevaluable, never scored as worse", referenceIndex(ALL_NULL, BASELINE, true).status === "unevaluable");
check("partial coverage is preview-only (unevaluable)", referenceIndex(BETTER, BASELINE, false).status === "unevaluable");
check("fewer than 3 signals is unevaluable", referenceIndex(TWO_SIGNALS, BASELINE, true).status === "unevaluable");
check("repeat evaluation is idempotent", referenceIndex(BETTER, BASELINE, true).index === better.index);
check("missing signal renormalises instead of counting as 0",
  referenceIndex({ ...BETTER, steps: null }, BASELINE, true).status === "ok");
check("extreme values clamp (index stays within 0..100)",
  (() => { const r = referenceIndex(ALL_EXTREME_GOOD, BASELINE, true); return r.index <= 100 && r.index >= 0; })());

// --- v1: baseline coverage gate (>=14 valid days actually enforced) ---
const NO_BASELINE_DAYS = Object.fromEntries(Object.entries(BASELINE).map(([k, v]) => [k, { ...v, validDays: 0 }]));
check("baseline with validDays=0 is NOT ok (v0 defect: it scored ok)",
  referenceIndex(AT_BASELINE, NO_BASELINE_DAYS, true).status === "unevaluable",
  JSON.stringify(referenceIndex(AT_BASELINE, NO_BASELINE_DAYS, true)));
const THIN_BASELINE = { ...BASELINE, steps: { ...BASELINE.steps, validDays: 13 }, hrv: { ...BASELINE.hrv, validDays: 5 } };
const thin = referenceIndex(BETTER, THIN_BASELINE, true);
check("signals with <14 valid baseline days are excluded, rest still evaluate",
  thin.status === "ok" && !thin.usedSignals.includes("steps") && !thin.usedSignals.includes("hrv") && thin.usedSignals.length === 3,
  JSON.stringify(thin));
check("coverage is reported per signal with validDays and usability",
  thin.coverage.steps.validDays === 13 && thin.coverage.steps.baselineUsable === false && thin.coverage.rhr.baselineUsable === true);
const LEGACY_BASELINE = Object.fromEntries(Object.entries(BASELINE).map(([k, v]) => [k, { mean: v.mean, sd: v.sd }]));
check("baseline entries missing validDays are untrusted (unevaluable when <3 usable)",
  referenceIndex(AT_BASELINE, LEGACY_BASELINE, true).status === "unevaluable");

// --- v1: strength uses the personal baseline, not a fixed 3/week reference ---
const STRONG_BASELINE = { ...BASELINE, strength: { mean: 5, sd: 1, validDays: 28 } };
check("strength z follows the personal baseline (3/wk is below a 5/wk baseline)",
  referenceIndex(AT_BASELINE, STRONG_BASELINE, true).index < base.index,
  JSON.stringify(referenceIndex(AT_BASELINE, STRONG_BASELINE, true)));

// --- v1: reachable interval and ladder reachability, computed per band ---
const [reachLo, reachHi] = reachableIndexRange();
check("reachable index interval is the full [0,100] under v1 scale", reachLo === 0 && reachHi === 100, `[${reachLo},${reachHi}]`);
const extremeGood = referenceIndex(ALL_EXTREME_GOOD, BASELINE, true);
const extremeBad = referenceIndex(ALL_EXTREME_BAD, BASELINE, true);
check("all-extreme-good day actually reaches index 100", extremeGood.status === "ok" && extremeGood.index === 100, JSON.stringify(extremeGood));
check("all-extreme-bad day actually reaches index 0", extremeBad.status === "ok" && extremeBad.index === 0, JSON.stringify(extremeBad));
for (const band of Object.keys(AGE_BAND_MULTIPLIER)) {
  check(`top step 39 is reachable in band ${band} (required ${requiredForStep(39, band)} <= ${reachHi})`,
    realmStep(reachHi, band) === 39 && requiredForStep(39, band) <= reachHi);
  check(`every step 0..39 is individually reachable in band ${band}`,
    Array.from({ length: 40 }, (_, k) => k).every((k) => requiredForStep(k, band) <= reachHi && requiredForStep(k, band) >= reachLo - 20));
}

// Realm ladder structure (proposal thresholds): monotone, gapless, and the
// age grading lowers the same step's requirement in older bands.
check("realm ladder has 40 steps across 10 realms x 4 sub-stages", REALMS.length * SUB_STAGES.length === 40);
check("realm step is monotone in index", realmStep(30, "40s") < realmStep(60, "40s") && realmStep(60, "40s") < realmStep(95, "40s"));
check("index below the first threshold maps to no step (not a fake floor)", realmStep(10, "40s") === -1);
check("age grading: same index reaches an equal-or-higher step in an older band",
  realmStep(55, "60s") >= realmStep(55, "40s"));
check("unevaluable maps to no realm change (label asks for evaluation)",
  realmLabel(realmStep(null, "40s")) === "当前未能评估");
check("labels use the owner-decided realm names", realmLabel(0).startsWith("凡人") && realmLabel(39).startsWith("渡劫飞升"));

// --- v1.1: float-boundary matrix (PM 2026-10-20 09:29) ---
// For every band and every step k: the normalised requirement itself must
// map to exactly k, and a value a hair below must not. Where the requirement
// is representable at the index's one-decimal precision, the check goes
// through the REAL referenceIndex output (PM recipe: five baselines
// mean=10/sd=2/validDays=28, z=(q-50)/20, rhr=10-2z, other four=10+2z),
// not just a direct realmStep call.
const UNIFORM_BASELINE = {
  rhr: { mean: 10, sd: 2, validDays: 28 },
  hrv: { mean: 10, sd: 2, validDays: 28 },
  sleepHours: { mean: 10, sd: 2, validDays: 28 },
  steps: { mean: 10, sd: 2, validDays: 28 },
  strength: { mean: 10, sd: 2, validDays: 28 },
};
const signalsForIndex = (q) => {
  const z = (q - 50) / 20;
  return { rhr: 10 - 2 * z, hrv: 10 + 2 * z, sleepHours: 10 + 2 * z, steps: 10 + 2 * z, strengthSessions7d: 10 + 2 * z };
};
for (const band of Object.keys(AGE_BAND_MULTIPLIER)) {
  let directOk = true, viaIndexOk = true, belowOk = true, representable = 0;
  for (let k = 0; k < 40; k++) {
    const q = requiredForStep(k, band);
    if (realmStep(q, band) !== k) directOk = false;
    if (realmStep(q - 0.01, band) !== k - 1 && !(k === 0 && realmStep(q - 0.01, band) === -1)) belowOk = false;
    if (Math.abs(q * 10 - Math.round(q * 10)) < 1e-9) {
      representable++;
      const out = referenceIndex(signalsForIndex(q), UNIFORM_BASELINE, true);
      if (!(out.status === "ok" && out.index === q && realmStep(out.index, band) === k)) viaIndexOk = false;
    }
  }
  check(`float boundary: band ${band} all 40 requirements map to their exact step`, directOk);
  check(`float boundary: band ${band} just-below each requirement stays one step lower`, belowOk);
  check(`float boundary: band ${band} ${representable} one-decimal-representable thresholds pass via real referenceIndex output`, viaIndexOk && representable > 0);
}
check("float boundary: PM counterexample 50s k=5/10/20 now reach steps 5/10/20 via referenceIndex",
  [5, 10, 20].every((k) => {
    const q = requiredForStep(k, "50s");
    const out = referenceIndex(signalsForIndex(q), UNIFORM_BASELINE, true);
    return out.index === q && realmStep(out.index, "50s") === k;
  }),
  [5, 10, 20].map((k) => `${k}:${requiredForStep(k, "50s")}`).join(","));
check("float boundary: index 0 and 100 and null behave (0 -> below step 0 in 40s is -1 or step0 by band, 100 -> 39, null -> null)",
  realmStep(100, "40s") === 39 && realmStep(null, "40s") === null && realmStep(0, "70+") === -1);

console.log(`\nsample: baseline index=${base.index} (${realmLabel(realmStep(base.index, "40s"))}), better index=${better.index} (${realmLabel(realmStep(better.index, "40s"))}), worse index=${worse.index} (${realmLabel(realmStep(worse.index, "40s"))})`);
console.log("per-band sensitivity (step at index 50 / step at reachable max 100):");
for (const band of Object.keys(AGE_BAND_MULTIPLIER)) {
  console.log(`  ${band}: step@50=${realmStep(50, band)} (${realmLabel(realmStep(50, band))}), step@100=${realmStep(100, band)}, required(39)=${requiredForStep(39, band)}`);
}
console.log(`validate-level-candidate: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
