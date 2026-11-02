// H4.3 睡眠债与今晚睡眠需求 (sleep debt + tonight's sleep need)
// validation. Runs the REAL production pure module
// (server/src/sleep-debt.ts — no imports, all logic exported) over
// synthetic fixtures only; no real health data is ever used. Covers:
// (1) the personal-baseline caliber (mean of the most recent ≤14
// recorded nights, gated at ≥8 — the same caliber readiness uses),
// (2) the signed 14-day cumulative debt Σ(baseline − actual),
// including a negative (surplus) result, (3) missing window dates
// handled as missing — counted and listed, never zero-filled, never
// backfilled from older dates, (4) tonight's repayment share (25%)
// and its +1.5 h cap, (5) the usual-wake median, the 07:00 default,
// and the bedtime wrap onto the prior evening, and (6) the wiring:
// the additive getDashboard.sleepDebt field on all three return
// paths and a render-only client. Two source mutations are executed
// for real (missing dates zero-filled into the debt; the repayment
// cap removed) and each must flip the corresponding assertion.
// Pure Node, no deps.
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';

const debtSrc = readFileSync(new URL('./server/src/sleep-debt.ts', import.meta.url), 'utf8');
const serverSrc = readFileSync(new URL('./server/src/actions.ts', import.meta.url), 'utf8');
const clientSrc = readFileSync(new URL('./client/src/App.tsx', import.meta.url), 'utf8');

let passed = 0;
let failures = 0;
function check(name, ok, note = '') {
  if (ok) passed++;
  else failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${note ? ` (${note})` : ''}`);
}

function buildModule(src) {
  const code = stripTypeScriptTypes(src.replace(/^export /gm, ''));
  return new Function(`${code}\nreturn { computeSleepDebt, suggestedBedtime, sleepDebtStatusFor, formatClockMinutes, SLEEP_DEBT_WINDOW_DAYS, SLEEP_DEBT_REPAY_SHARE, SLEEP_DEBT_REPAY_CAP_HOURS, SLEEP_DEBT_BASELINE_MIN_NIGHTS };`)();
}
const { computeSleepDebt, suggestedBedtime, sleepDebtStatusFor, formatClockMinutes } = buildModule(debtSrc);

// ------------------------------------------------------------ source checks
check('source: sleep-debt module has no imports (pure module)', !/^import /m.test(debtSrc));
check('source: server imports computeSleepDebt from the pure module',
  serverSrc.includes('import { computeSleepDebt, type SleepDebtResult } from "./sleep-debt";'));
check('source: getDashboard response carries the additive sleepDebt field',
  serverSrc.includes('sleepDebt: sleepDebtSchema.nullable()'));
check('source: all three getDashboard return paths carry sleepDebt (forbidden / health-missing null, main computed)',
  (serverSrc.match(/sleepDebt: null/g) ?? []).length === 2
  && serverSrc.includes('const sleepDebt = buildSleepDebt(snapshot, readinessDate);')
  // H4.4: the main return gained the additive statusMode field between
  // sleepDebt and readiness — the pin tracks the live key order.
  && serverSrc.includes('behaviorImpact, sleepDebt, statusMode, readiness,'));
check('source: server builds the input from main sleeps only (CWEB-SLEEP-001 selection)',
  serverSrc.includes('const main = selectMainSleep(rows);') && serverSrc.includes('hours: totalSleepHours(main, main.totalHours)'));
check('source: readiness formula untouched (7-day sleep bank caliber intact)',
  serverSrc.includes('recentSevenSleeps.length < 7') && serverSrc.includes('label: "7 天睡眠银行"'));
check('source: client renders the sleep-debt panel with the formula and the non-medical disclaimer',
  clientSrc.includes('睡眠债与今晚睡眠需求') && clientSrc.includes('累计睡眠债 = Σ（基线 − 当晚实际睡眠）') && clientSrc.includes('不是医疗建议'));
check('source: client never computes sleep debt itself',
  !clientSrc.includes('computeSleepDebt') && clientSrc.includes('sleepDebt={dashboard.data.sleepDebt}'));

// ------------------------------------------------------------ fixtures
const AS_OF = '2026-10-28'; // window 2026-10-15 .. 2026-10-28
const n = (date, hours, wakeMinutes = 420) => ({ date, hours, wakeMinutes });
const series = (start, days, hours, wakeMinutes = 420) => {
  const out = [];
  let date = start;
  for (let i = 0; i < days; i++) {
    out.push(n(date, hours, wakeMinutes));
    const next = new Date(`${date}T12:00:00Z`);
    next.setUTCDate(next.getUTCDate() + 1);
    date = next.toISOString().slice(0, 10);
  }
  return out;
};

// ------------------------------------------- (1)+(2) baseline & flat debt
{
  const r = computeSleepDebt(series('2026-10-15', 14, 7.5), AS_OF);
  check('uniform: 14 recorded nights give a 7.5 h baseline over 14 nights',
    r.baselineHours === 7.5 && r.baselineNights === 14 && r.recordedNights === 14 && r.missingNights === 0 && r.missingDates.length === 0);
  check('uniform: debt is exactly 0 and reads ● 基本持平 with symbol + word',
    r.debtHours === 0 && r.status?.symbol === '●' && r.status?.word === '基本持平' && r.sufficient === true);
  check('uniform: no repayment is added and the suggestion equals the baseline',
    r.extraTonightHours === 0 && r.suggestedSleepHours === 7.5);
  check('uniform: wake 07:00 minus 7.5 h suggests a 23:30 bedtime',
    r.usualWakeTime === '07:00' && r.usualWakeFromDefault === false && r.suggestedBedtime === '23:30');
  const withFuture = computeSleepDebt([...series('2026-10-15', 14, 7.5), n('2026-10-29', 1)], AS_OF);
  check('future dates never enter: a night after asOf changes nothing',
    withFuture.baselineHours === 7.5 && withFuture.debtHours === 0 && withFuture.baselineNights === 14);
}

// --------------------------- (3) missing dates: counted, listed, not filled
{
  // 7 older nights at 8 h (outside the window) + the window's last 7
  // nights at 6 h; the window's first 7 dates have NO session.
  const r = computeSleepDebt([...series('2026-10-02', 7, 8), ...series('2026-10-22', 7, 6)], AS_OF);
  check('missing: baseline is the mean of the most recent 14 recorded nights (7.0 h)',
    r.baselineHours === 7 && r.baselineNights === 14);
  check('missing: the window reports 7 recorded and 7 missing nights, listed by date',
    r.recordedNights === 7 && r.missingNights === 7
    && r.missingDates[0] === '2026-10-15' && r.missingDates[6] === '2026-10-21');
  check('missing: debt sums ONLY the recorded nights (7 × (7 − 6) = 7.0 h) — no zero-fill, no backfill',
    r.debtHours === 7 && r.status?.symbol === '▲' && r.status?.word === '有睡眠债');
  check('missing: a partial window still computes (sufficient) and shows its real night count',
    r.sufficient === true && r.windowDays === 14 && r.windowStart === '2026-10-15' && r.windowEnd === AS_OF);
}

// ------------------------------------------------- (4) repayment cap hit
{
  // 8 older nights at 8 h + 10 window nights at 4 h: baseline uses
  // the most recent 14 nights = 10 × 4 + 4 × 8 → 72/14 ≈ 5.14 h.
  const r = computeSleepDebt([...series('2026-10-01', 8, 8), ...series('2026-10-19', 10, 4)], AS_OF);
  check('cap: baseline 5.1 h over the most recent 14 nights, debt 11.4 h',
    r.baselineHours === 5.1 && r.debtHours === 11.4 && r.recordedNights === 10 && r.missingNights === 4);
  check('cap: repayment is capped at +1.5 h (25% of 11.4 would be 2.9)',
    r.extraTonightHours === 1.5 && r.suggestedSleepHours === 6.6);
  check('cap: bedtime wraps onto the clock (07:00 − 6.64 h ≈ 00:21)',
    r.suggestedBedtime === '00:21');
}

// ------------------------------------------- (4) repayment share, uncapped
{
  // 10 older nights at 8 h + 10 window nights at 6.5 h: baseline =
  // (4 × 8 + 10 × 6.5) / 14 ≈ 6.93 h; debt ≈ 4.29 h; 25% ≈ 1.07 h.
  const r = computeSleepDebt([...series('2026-10-05', 10, 8), ...series('2026-10-15', 10, 6.5)], AS_OF);
  check('share: baseline 6.9 h and debt 4.3 h from the mixed history',
    r.baselineHours === 6.9 && r.debtHours === 4.3);
  check('share: tonight repays 25% of the outstanding debt (1.1 h), suggestion 8.0 h',
    r.extraTonightHours === 1.1 && r.suggestedSleepHours === 8);
  check('share: 07:00 wake minus 8.0 h suggests 23:00',
    r.suggestedBedtime === '23:00');
}

// ------------------------------------------------- (2) surplus stays negative
{
  // 8 older nights at 6 h + 10 window nights at 8 h: baseline =
  // (4 × 6 + 10 × 8) / 14 ≈ 7.43 h; debt = 10 × (7.43 − 8) ≈ −5.7 h.
  const r = computeSleepDebt([...series('2026-10-05', 8, 6), ...series('2026-10-19', 10, 8)], AS_OF);
  check('surplus: debt is negative (−5.7 h) and reads ▼ 睡眠盈余 — never clamped to 0',
    r.debtHours === -5.7 && r.status?.symbol === '▼' && r.status?.word === '睡眠盈余');
  check('surplus: no repayment is subtracted — tonight equals the baseline',
    r.extraTonightHours === 0 && r.suggestedSleepHours === 7.4);
}

// --------------------------------------- baseline gate / empty window / dedupe
{
  const few = computeSleepDebt(series('2026-10-24', 5, 7), AS_OF);
  check('gate: fewer than 8 recorded nights yield no baseline and no numbers',
    few.baselineNights === 5 && few.baselineHours === null && few.debtHours === null
    && few.status === null && few.suggestedSleepHours === null && few.suggestedBedtime === null && few.sufficient === false);
  check('gate: the partial window still reports its real counts (5 recorded, 9 missing)',
    few.recordedNights === 5 && few.missingNights === 9);
  const dup = computeSleepDebt([...series('2026-10-20', 9, 8), n('2026-10-28', 5)], AS_OF);
  check('dedupe: a duplicate date keeps the longest night (baseline stays 8.0, debt 0)',
    dup.baselineHours === 8 && dup.debtHours === 0 && dup.baselineNights === 9);
  const bad = computeSleepDebt([], '2026-13-40');
  check('invalid asOf: the empty result carries no numbers and no wake time',
    bad.sufficient === false && bad.baselineHours === null && bad.usualWakeTime === null);
}

// ------------------------------------------- (5) wake median, default, bedtime
{
  const wakes = [360, 390, 420, 420, 450, 480, 510, 540];
  const nights = wakes.map((wake, i) => n(`2026-10-${21 + i}`, 7, wake));
  const r = computeSleepDebt(nights, AS_OF);
  check('wake: the usual wake time is the median of the baseline nights (07:15)',
    r.usualWakeTime === '07:15' && r.usualWakeFromDefault === false && r.suggestedBedtime === '00:15');
  const noWake = computeSleepDebt(series('2026-10-19', 10, 7, null), AS_OF);
  check('wake: no recorded wake time falls back to the flagged 07:00 default',
    noWake.usualWakeTime === '07:00' && noWake.usualWakeFromDefault === true && noWake.suggestedBedtime === '00:00');
  check('bedtime: suggestedBedtime wraps onto the clock both ways',
    suggestedBedtime(390, 8) === '22:30' && suggestedBedtime(540, 7) === '02:00' && formatClockMinutes(-105) === '22:15');
  check('status: tolerance edges — ±0.5 h is 基本持平, beyond is debt/surplus, null has no status',
    sleepDebtStatusFor(0.5)?.word === '基本持平' && sleepDebtStatusFor(0.6)?.word === '有睡眠债'
    && sleepDebtStatusFor(-0.6)?.word === '睡眠盈余' && sleepDebtStatusFor(null) === null);
}

// ------------------------------------------------------- mutation sensitivity
{
  const missingFixture = [...series('2026-10-02', 7, 8), ...series('2026-10-22', 7, 6)];
  const zeroFillMutant = buildModule(debtSrc.replace(
    'if (!night) continue;',
    'if (!night) { debtRaw += baselineRaw; continue; }',
  ));
  check('mutation: zero-filling missing dates into the debt flips the missing-dates assertion (7.0 → 56.0)',
    computeSleepDebt(missingFixture, AS_OF).debtHours === 7
    && zeroFillMutant.computeSleepDebt(missingFixture, AS_OF).debtHours === 56);
  const capFixture = [...series('2026-10-01', 8, 8), ...series('2026-10-19', 10, 4)];
  const capMutant = buildModule(debtSrc.replace(
    'Math.min(SLEEP_DEBT_REPAY_CAP_HOURS, Math.max(0, debtRaw) * SLEEP_DEBT_REPAY_SHARE)',
    'Math.max(0, debtRaw) * SLEEP_DEBT_REPAY_SHARE',
  ));
  check('mutation: removing the repayment cap flips the cap assertion (extra 1.5 → 2.9)',
    computeSleepDebt(capFixture, AS_OF).extraTonightHours === 1.5
    && capMutant.computeSleepDebt(capFixture, AS_OF).extraTonightHours === 2.9);
}

console.log(`\n${passed} passed, ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
