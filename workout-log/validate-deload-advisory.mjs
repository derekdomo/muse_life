// W3.5 validation — conservative adjustment / recovery advisory
// (stall detection + deload hint). Evaluates the REAL production
// module (server/src/deload-advisory.ts, whole file, types
// stripped) over synthetic data only, plus the real session
// selections from server/src/actions.ts, plus source-wiring checks
// for the two display points (completion receipt + weekly review
// progression_advice consumption):
//  - gate A: TWO consecutive declines across the three most recent
//    sessions, per metric (completion rate OR total volume walking
//    strictly down across both steps) — one decline, mixed-metric
//    declines, flat steps and fewer than three sessions never fire;
//  - gate B: at least one strain signal — sessionRpe >= 9, any
//    completed working set RIR <= 1 on the latest session, a
//    non-empty painFlags on the latest source workout, or a latest
//    readiness score < 2 (H-LOAD-001 red band);
//  - both gates are required: decline-only and signal-only cases
//    stay silent, with reasons that say which gate failed;
//  - metrics are real computations: completion rates, volumes with
//    cross-unit conversion, best set ignoring bodyweight (0);
//  - the advisory is display-only: requiresConfirmation is always
//    true and canRecordDeloadAdvisory records nothing without an
//    explicit user confirmation;
//  - mutation sensitivity: three deliberate mutations (two-decline
//    gate removed, signal gate removed, confirmation gate removed)
//    must each flip the corresponding case;
//  - wiring: actions.ts imports the module, getDashboard returns
//    deload_advisory + receipt_deload_advisory, and the client
//    renders dismissible suggestion cards at the receipt and the
//    weekly review without any plan-writing call inside them.
// Synthetic data only: no real training record appears in this file.
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';

const moduleSrc = readFileSync(new URL('./server/src/deload-advisory.ts', import.meta.url), 'utf8');
const serverSrc = readFileSync(new URL('./server/src/actions.ts', import.meta.url), 'utf8');
const clientSrc = readFileSync(new URL('./client/src/App.tsx', import.meta.url), 'utf8');

let passed = 0;
let failures = 0;
function check(name, ok, note = '') {
  if (ok) passed++;
  else failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${note ? ` (${note})` : ''}`);
}
function matchDelim(s, start, open, close) {
  let depth = 0;
  for (let i = start; i < s.length; i++) {
    if (s[i] === open) depth++;
    else if (s[i] === close) { depth--; if (depth === 0) return i; }
  }
  throw new Error('unbalanced delimiters');
}
function extractFunction(source, name) {
  const idx = source.search(new RegExp(`function ${name}\\(`));
  if (idx < 0) throw new Error(`function ${name} not found`);
  const openParen = source.indexOf('(', idx);
  const closeParen = matchDelim(source, openParen, '(', ')');
  let bodyStart = source.indexOf('{', closeParen);
  const between = source.slice(closeParen + 1, bodyStart).trimStart();
  if (between.startsWith(':')) {
    const typeEnd = matchDelim(source, bodyStart, '{', '}');
    const nextBrace = source.indexOf('{', typeEnd);
    if (nextBrace > -1 && source.slice(typeEnd + 1, nextBrace).trim() === '') bodyStart = nextBrace;
  }
  const bodyEnd = matchDelim(source, bodyStart, '{', '}');
  return source.slice(idx, bodyEnd + 1);
}
function loadModule(source) {
  const code = stripTypeScriptTypes(source).replace(/^export /gm, '');
  return new Function(
    `${code}\nreturn { evaluateDeloadAdvisory, canRecordDeloadAdvisory, sessionMetrics, convertDeloadWeight, DELOAD_ADVISORY_VERSION, LB_TO_KG, HIGH_RPE_THRESHOLD, LOW_RIR_THRESHOLD, READINESS_LOW_THRESHOLD };`,
  )();
}
const M = loadModule(moduleSrc);

// --- synthetic builders ---
// A session of n planned sets at one weight/reps; `done` of them
// completed. extra carries painFlags / sessionRpe / completedAt.
const st = (weight, reps, rir = null, completed = true) => ({ weight, reps, rir, completed });
const sess = (planned, done, weight = 100, reps = 8, extra = {}) => ({
  unit: 'lb',
  plannedSets: planned,
  sets: Array.from({ length: planned }, (_, i) => st(weight, reps, extra.rir ?? null, i < done)),
  painFlags: extra.painFlags ?? [],
  sessionRpe: extra.sessionRpe ?? null,
  completedAt: extra.completedAt ?? null,
});
const judge = (mod, sessions, readinessScore = null, unit = 'lb') =>
  mod.evaluateDeloadAdvisory({ sessions, readinessScore, unit });

// Sessions (most recent first) whose completion rate walks
// 1 -> 0.75 -> 0.5 while volume (same weight/reps per set) also
// falls: the canonical two-decline shape.
const declining = (extra = {}) => [
  sess(4, 2, 100, 8, extra),
  sess(4, 3),
  sess(4, 4),
];

// --- behavioral suite (also run against mutants) ---
// Returns the number of failed assertions; case names are stable
// so a mutant's flips can be eyeballed against the real run.
function suite(mod) {
  let failed = 0;
  const t = (name, ok) => { if (!ok) { failed++; console.log(`  suite-fail: ${name}`); } };

  // both gates hold -> advisory, via each signal in turn
  const byRpe = judge(mod, declining({ sessionRpe: 9 }));
  t('fires: two declines + RPE 9', byRpe.suggested === true
    && byRpe.signals.some((s) => s.kind === 'high_rpe' && s.value === 9));
  t('fires: declines carry both metrics, oldest first',
    byRpe.declines.length === 2
    && byRpe.declines.find((d) => d.metric === 'completion_rate')?.values.join(',') === '1,0.75,0.5'
    && byRpe.declines.find((d) => d.metric === 'volume')?.values.join(',') === '3200,2400,1600');
  t('fires: suggestion is conservative text, version carried, confirmation required',
    typeof byRpe.suggestion === 'string' && byRpe.suggestion.includes('降重一档或减一组')
    && byRpe.advisoryVersion === mod.DELOAD_ADVISORY_VERSION
    && byRpe.requiresConfirmation === true);
  t('fires: reason names the decline numbers and the signal',
    byRpe.reason.includes('100%') && byRpe.reason.includes('50%') && byRpe.reason.includes('RPE 9'));
  const byRir = judge(mod, [
    { ...sess(4, 2), sets: [st(100, 8, 1), st(100, 8, 3), st(100, 8, null, false), st(100, 8, null, false)] },
    sess(4, 3),
    sess(4, 4),
  ]);
  t('fires: two declines + a completed set at RIR 1', byRir.suggested === true
    && byRir.signals.some((s) => s.kind === 'low_rir' && s.value === 1));
  const byPain = judge(mod, declining({ painFlags: ['shoulder'] }));
  t('fires: two declines + pain flags, suggestion leads with a recovery day',
    byPain.suggested === true && byPain.signals.some((s) => s.kind === 'pain')
    && byPain.suggestion.includes('恢复日'));
  const byReadiness = judge(mod, declining(), 1);
  t('fires: two declines + readiness 1 (< 2)', byReadiness.suggested === true
    && byReadiness.signals.some((s) => s.kind === 'low_readiness' && s.value === 1));

  // gate A failures: no advisory even with a strong signal
  t('gate A: a single decline (latest dip only) never fires',
    judge(mod, [sess(4, 2, 100, 8, { sessionRpe: 10 }), sess(4, 4), sess(4, 4)]).suggested === false);
  t('gate A: a single decline (first step only) never fires',
    judge(mod, [sess(4, 4, 100, 8, { sessionRpe: 10 }), sess(4, 2), sess(4, 4)]).suggested === false);
  t('gate A: flat middle step is not a decline',
    judge(mod, [sess(4, 3, 100, 8, { sessionRpe: 10 }), sess(4, 3), sess(4, 4)]).suggested === false);
  // Mixed metrics: step 1 drops ONLY the completion rate (volume
  // held at 3200 by heavier completed sets), step 2 drops ONLY the
  // volume (rate flat at 0.75) — neither metric walks down twice.
  const mixedSession = (sets, extra = {}) => ({
    unit: 'lb', plannedSets: 4, sets, painFlags: [], sessionRpe: null, completedAt: null, ...extra,
  });
  t('gate A: mixed metrics (rate down then volume down) never fire',
    judge(mod, [
      mixedSession([st(90, 8), st(90, 8), st(90, 8), st(90, 8, null, false)], { sessionRpe: 10 }),
      mixedSession([st(100, 10), st(100, 10), st(100, 12), st(100, 8, null, false)]),
      mixedSession([st(100, 8), st(100, 8), st(100, 8), st(100, 8)]),
    ]).suggested === false);
  t('gate A: improving performance never fires',
    judge(mod, declining().reverse(), null).suggested === false
    && judge(mod, [sess(4, 4, 100, 8, { sessionRpe: 10 }), sess(4, 3), sess(4, 2)]).suggested === false);
  t('gate A: two sessions are not enough, however bad',
    judge(mod, [sess(4, 1, 100, 8, { sessionRpe: 10, painFlags: ['knee'] }), sess(4, 4)], 0).suggested === false);
  t('gate A: no sessions at all',
    judge(mod, [], 0).suggested === false);

  // gate B failures: declines alone stay silent
  const declineOnly = judge(mod, declining());
  t('gate B: two declines with no signal never fire', declineOnly.suggested === false
    && declineOnly.declines.length === 2 && declineOnly.signals.length === 0);
  t('gate B: the silent reason names the missing signal',
    declineOnly.reason.includes('不自动建议 deload'));
  t('gate B: RPE 8 is below the high-RPE threshold',
    judge(mod, declining({ sessionRpe: 8 })).suggested === false);
  t('gate B: RIR 2 everywhere is above the low-RIR threshold',
    judge(mod, [
      { ...sess(4, 2), sets: [st(100, 8, 2), st(100, 8, 2), st(100, 8, null, false), st(100, 8, null, false)] },
      sess(4, 3),
      sess(4, 4),
    ]).suggested === false);
  t('gate B: an uncompleted set at RIR 0 is not a working set',
    judge(mod, [
      { ...sess(4, 2), sets: [st(100, 8, 3), st(100, 8, 3), st(100, 8, 0, false), st(100, 8, null, false)] },
      sess(4, 3),
      sess(4, 4),
    ]).suggested === false);
  t('gate B: readiness 2 is not below the low threshold',
    judge(mod, declining(), 2).suggested === false);
  t('gate B: a signal on an OLDER session does not count',
    judge(mod, [sess(4, 2), sess(4, 3, 100, 8, { sessionRpe: 10 }), sess(4, 4)]).suggested === false);

  // signal-only: no decline, no advisory (single bad day rule)
  t('single bad day: worst session + every signal still never fires',
    judge(mod, [sess(4, 1, 100, 8, { sessionRpe: 10, painFlags: ['knee'] }), sess(4, 4), sess(4, 4)], 0).suggested === false);

  // confirmation gate
  t('confirmation: an unconfirmed advisory records nothing',
    mod.canRecordDeloadAdvisory(byRpe, false) === false);
  t('confirmation: explicit confirmation records the acceptance',
    mod.canRecordDeloadAdvisory(byRpe, true) === true);
  t('confirmation: a non-advisory can never be recorded',
    mod.canRecordDeloadAdvisory(declineOnly, true) === false);
  t('confirmation: every outcome carries requiresConfirmation',
    [byRpe, declineOnly, judge(mod, [])].every((a) => a.requiresConfirmation === true));
  return failed;
}

// --- the real module passes the whole suite ---
{
  const failed = suite(M);
  check('behavioral suite: the real module passes every assertion', failed === 0, `${failed} failed`);
  check('advisory version is a positive integer', Number.isInteger(M.DELOAD_ADVISORY_VERSION) && M.DELOAD_ADVISORY_VERSION >= 1);
  check('thresholds are the brief\'s: RPE >= 9, RIR <= 1, readiness < 2',
    M.HIGH_RPE_THRESHOLD === 9 && M.LOW_RIR_THRESHOLD === 1 && M.READINESS_LOW_THRESHOLD === 2);
  check('module LB_TO_KG is the established constant', M.LB_TO_KG === 0.45359237);
  check('server LB_TO_KG matches the module constant',
    serverSrc.includes('export const LB_TO_KG = 0.45359237;'));
  check('convertDeloadWeight: null stays null, same unit identity, 100 lb -> 45.5 kg',
    M.convertDeloadWeight(null, 'lb', 'kg') === null
    && M.convertDeloadWeight(100, 'lb', 'lb') === 100
    && M.convertDeloadWeight(100, 'lb', 'kg') === 45.5);

  // metrics are real computations, incl. bodyweight + cross-unit
  const mixed = M.sessionMetrics({
    unit: 'lb', plannedSets: 4,
    sets: [st(100, 8), st(0, 12), st(null, 10), st(100, 8, null, false)],
  }, 'lb');
  check('metrics: completion rate counts completed sets only',
    mixed.completionRate === 0.75);
  check('metrics: volume sums completed sets with weight + reps (bodyweight adds 0)',
    mixed.volume === 800);
  check('metrics: best set ignores bodyweight 0 and unrecorded weights',
    mixed.bestSetVolume === 800);
  const kgSession = M.sessionMetrics({ unit: 'kg', plannedSets: 1, sets: [st(50, 10)] }, 'lb');
  check('metrics: a kg session judged for lb converts before multiplying (50 kg -> 110 lb)',
    kgSession.volume === 1100 && kgSession.bestSetVolume === 1100);
  const noVolume = M.sessionMetrics({ unit: 'lb', plannedSets: 2, sets: [st(null, 10), st(null, 10)] }, 'lb');
  check('metrics: no weighed completed set -> volume null, never a guessed 0',
    noVolume.volume === null && noVolume.bestSetVolume === null);

  // a volume-only decline (completion flat) fires on volume alone
  const volumeOnly = judge(M, [
    sess(4, 4, 80, 8, { sessionRpe: 9 }),
    sess(4, 4, 90, 8),
    sess(4, 4, 100, 8),
  ]);
  check('gate A: volume alone declining across both steps fires',
    volumeOnly.suggested === true && volumeOnly.declines.length === 1
    && volumeOnly.declines[0].metric === 'volume');
  // a fourth, older session is ignored entirely
  const fourSessions = judge(M, [...declining({ sessionRpe: 9 }), sess(4, 4, 200, 8)]);
  check('only the three most recent sessions are judged',
    fourSessions.suggested === true && fourSessions.sessionMetrics.length === 3);
}

// --- mutation sensitivity: each mutant must flip its case ---
{
  const mutants = [
    ['two-decline gate removed (one decline suffices)',
      'const declinedTwice = older > middle && middle > latest;',
      'const declinedTwice = middle > latest;'],
    ['signal gate removed (declines alone fire)',
      'const hasSignal = signals.length > 0;',
      'const hasSignal = true;'],
    ['user-confirmation gate removed (records unconfirmed)',
      'return advisory.suggested && advisory.requiresConfirmation && userConfirmed === true;',
      'return advisory.suggested && advisory.requiresConfirmation && true;'],
  ];
  for (const [name, from, to] of mutants) {
    if (!moduleSrc.includes(from)) {
      check(`mutant anchor present: ${name}`, false, 'anchor not found in module source');
      continue;
    }
    const mutant = loadModule(moduleSrc.replace(from, to));
    const failed = suite(mutant);
    check(`mutation sensitivity: ${name} breaks the suite`, failed > 0, `${failed} suite assertions failed`);
  }
}

// --- pure selections: three sessions per exercise ---
{
  const S = new Function(
    `${stripTypeScriptTypes(extractFunction(serverSrc, 'selectDeloadSessions'))}\nreturn { selectDeloadSessions };`,
  )();
  const w = (unit, completedAt, painFlags, sessionRpe, sets) => ({ unit, completedAt, painFlags, sessionRpe, sets });
  const cs = (key, n, target, weight, reps, rir, completed) =>
    ({ exerciseKey: key, setNumber: n, targetReps: target, weight, reps, rir, completed });
  const recent = [
    w('lb', '2026-10-30T00:00:00.000Z', ['shoulder'], 9, [cs('bench', 1, '6-8', 100, 8, 1, true)]),
    w('lb', '2026-10-27T00:00:00.000Z', [], null, [cs('bench', 1, '6-8', 100, 7, null, true)]),
    w('kg', '2026-10-24T00:00:00.000Z', [], null, [cs('bench', 1, '6-8', 45, 8, null, true), cs('row', 1, '8-10', 30, 9, null, true)]),
    w('lb', '2026-10-20T00:00:00.000Z', [], null, [cs('bench', 1, '6-8', 95, 8, null, true)]),
  ];
  const [benchSel, rowSel] = S.selectDeloadSessions(recent, ['bench', 'row']);
  check('selection: at most three sessions, most recent first, fourth ignored',
    benchSel.sessions.length === 3 && benchSel.sessions[0].unit === 'lb' && benchSel.sessions[2].unit === 'kg');
  check('selection: pain flags, session RPE, RIR and dates pass through untouched',
    benchSel.sessions[0].painFlags.join(',') === 'shoulder' && benchSel.sessions[0].sessionRpe === 9
    && benchSel.sessions[0].sets[0].rir === 1
    && benchSel.sessions[0].sourceCompletedAt === '2026-10-30T00:00:00.000Z');
  check('selection: an exercise in fewer sessions gets only those',
    rowSel.sessions.length === 1 && rowSel.sessions[0].plannedSets === 1);
}

// --- wiring: server fields + the two client display points ---
{
  check('wiring: the module imports nothing (pure, standalone)', !/^\s*import\s/m.test(moduleSrc));
  check('wiring: actions.ts imports the advisory module', serverSrc.includes('from "./deload-advisory"'));
  const dashBegin = serverSrc.indexOf('getDashboard: defineAction');
  const dashEnd = serverSrc.indexOf('startWorkout: defineAction');
  const dashSlice = serverSrc.slice(dashBegin, dashEnd);
  check('wiring: getDashboard returns deload_advisory from loadDeloadAdvisories',
    dashSlice.includes('deload_advisory: await loadDeloadAdvisories(ctx, args.readiness_score ?? null)'));
  check('wiring: getDashboard returns receipt_deload_advisory only for a located receipt',
    dashSlice.includes('receipt_deload_advisory: await loadReceiptDeloadAdvisories(ctx, located, args.readiness_score ?? null)'));
  check('wiring: readiness_score is an additive optional request field',
    dashSlice.includes('readiness_score: z.number().min(0).max(10).optional()'));
  check('wiring: dashboardResponse carries both advisory fields as additive optionals',
    serverSrc.includes('deload_advisory: z.array(deloadAdvisoryEntryResponse).optional()')
    && serverSrc.includes('receipt_deload_advisory: z.array(receiptDeloadAdvisoryEntryResponse).optional()'));
  const receiptLoaderBegin = serverSrc.indexOf('async function loadReceiptDeloadAdvisories');
  const receiptLoaderEnd = serverSrc.indexOf('export const Actions');
  check('wiring: the receipt loader groups earlier sets by workout id (not set id)',
    serverSrc.slice(receiptLoaderBegin, receiptLoaderEnd).includes('setsByWorkout.get(row.workoutId)')
    && serverSrc.slice(receiptLoaderBegin, receiptLoaderEnd).includes('setsByWorkout.set(row.workoutId, list)'));
  check('wiring: the W3.2 engine path is untouched by the advisory loaders',
    serverSrc.includes('progression_advice: await loadProgressionAdvice(ctx)')
    && serverSrc.includes('receipt_advice: await loadReceiptAdvice(ctx, located)'));

  const cardBegin = clientSrc.indexOf('function DeloadAdvisoryCards');
  const cardEnd = clientSrc.indexOf('function CompletionReceipt');
  const cardSlice = clientSrc.slice(cardBegin, cardEnd);
  check('wiring: the client renders advisory cards from the server fields only',
    cardBegin > -1 && cardSlice.includes('advisory.suggested'));
  check('wiring: the card names the facts (decline values + signal details)',
    cardSlice.includes('decline.values') && cardSlice.includes('signal.detail'));
  check('wiring: the card offers an explicit 忽略 (dismiss) entry',
    cardSlice.includes('忽略'));
  check('wiring: the card offers an explicit 确认采纳 entry gated on user action',
    cardSlice.includes('确认采纳') && cardSlice.includes('useState'));
  check('wiring: the card never writes a plan (no mutation call inside it)',
    !/api\.(updatePlan|startWorkout|completeWorkout|updateSet)/.test(cardSlice));
  check('wiring: the card states the display-only rule in public wording',
    cardSlice.includes('不会自动修改任何训练计划'));
  check('wiring: the receipt consumes receipt_deload_advisory',
    clientSrc.includes('query.data?.receipt_deload_advisory'));
  check('wiring: the weekly review consumes deload_advisory at the progression_advice point',
    clientSrc.includes('deloadAdvisory={dashboard.data.deload_advisory}')
    && clientSrc.includes('<DeloadAdvisoryCards advisories={deloadAdvisory}'));
  check('wiring: meaning never rides on colour alone (symbol + text on the card)',
    cardSlice.includes('▼') && cardSlice.includes('保守调整建议'));
}

console.log(`\n${passed} passed, ${failures} failed`);
if (failures > 0) process.exit(1);
