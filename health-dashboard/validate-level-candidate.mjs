// CWEB-LEVEL-001 offline candidate — path A "game reference status index"
// (implementer deliverable for the 2026-10-20 18:00 offline package).
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
// Index definition (candidate v0, all parameters labelled PROPOSAL):
//   per-signal direction-adjusted z against the person's own 28-day
//   baseline (>=14 valid days required per signal):
//     RHR   z = (baselineMean - value) / baselineSd      (lower is better)
//     HRV   z = (value - baselineMean) / baselineSd      (higher is better)
//     sleep z = (mainSleepHours - baselineMean) / baselineSd
//     steps z = (value - baselineMean) / baselineSd
//     strength z = (sessionsLast7d - 3) / 1.5            (3/wk reference)
//   each z clamped to [-2.5, +2.5]; index = clamp(50 + 10 * weightedMeanZ,
//   0, 100) with equal weights over the AVAILABLE signals (renormalised).
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

function clamp(value, lo, hi) { return Math.min(hi, Math.max(lo, value)); }

function zScore(value, mean, sd, lowerIsBetter) {
  if (value === null || value === undefined || mean === null || sd === null || !(sd > 0)) return null;
  const raw = (value - mean) / sd;
  return clamp(lowerIsBetter ? -raw : raw, -2.5, 2.5);
}

// signals: { rhr, hrv, sleepHours, steps, strengthSessions7d } (null = missing)
// baseline: { rhr:{mean,sd}, hrv:{mean,sd}, sleepHours:{mean,sd}, steps:{mean,sd} }
// coverageComplete: false when the source day is partial.
function referenceIndex(signals, baseline, coverageComplete) {
  if (!coverageComplete) return { status: "unevaluable", reason: "partial", index: null, usedSignals: [] };
  const parts = [];
  const add = (name, z) => { if (z !== null) parts.push({ name, z }); };
  add("rhr", zScore(signals.rhr, baseline.rhr?.mean, baseline.rhr?.sd, true));
  add("hrv", zScore(signals.hrv, baseline.hrv?.mean, baseline.hrv?.sd, false));
  add("sleep", zScore(signals.sleepHours, baseline.sleepHours?.mean, baseline.sleepHours?.sd, false));
  add("steps", zScore(signals.steps, baseline.steps?.mean, baseline.steps?.sd, false));
  if (signals.strengthSessions7d !== null && signals.strengthSessions7d !== undefined) {
    parts.push({ name: "strength", z: clamp((signals.strengthSessions7d - 3) / 1.5, -2.5, 2.5) });
  }
  if (parts.length < 3) return { status: "unevaluable", reason: "too_few_signals", index: null, usedSignals: parts.map((p) => p.name) };
  const meanZ = parts.reduce((sum, p) => sum + p.z, 0) / parts.length;
  return { status: "ok", index: Math.round((50 + 10 * meanZ) * 10) / 10, usedSignals: parts.map((p) => p.name) };
}

// Highest step (0..39) whose requirement the index meets; -1 below step 0.
function realmStep(index, ageBand) {
  if (index === null) return null;
  const mult = AGE_BAND_MULTIPLIER[ageBand];
  let step = -1;
  for (let k = 0; k < 40; k++) {
    if (index >= 20 + 2 * k * mult) step = k; else break;
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
  rhr: { mean: 65, sd: 3 },
  hrv: { mean: 40, sd: 8 },
  sleepHours: { mean: 6.8, sd: 0.7 },
  steps: { mean: 4000, sd: 1500 },
};
const AT_BASELINE = { rhr: 65, hrv: 40, sleepHours: 6.8, steps: 4000, strengthSessions7d: 3 };
const BETTER = { rhr: 61, hrv: 50, sleepHours: 7.6, steps: 7000, strengthSessions7d: 4 };
const WORSE = { rhr: 70, hrv: 31, sleepHours: 5.6, steps: 1800, strengthSessions7d: 1 };
const ALL_NULL = { rhr: null, hrv: null, sleepHours: null, steps: null, strengthSessions7d: null };
const TWO_SIGNALS = { rhr: 61, hrv: 50, sleepHours: null, steps: null, strengthSessions7d: null };

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
  (() => { const r = referenceIndex({ rhr: 40, hrv: 120, sleepHours: 11, steps: 30000, strengthSessions7d: 7 }, BASELINE, true); return r.index <= 100 && r.index >= 0; })());

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
console.log(`\nsample: baseline index=${base.index} (${realmLabel(realmStep(base.index, "40s"))}), better index=${better.index} (${realmLabel(realmStep(better.index, "40s"))}), worse index=${worse.index} (${realmLabel(realmStep(worse.index, "40s"))})`);
console.log(`validate-level-candidate: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
