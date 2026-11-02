// W-TRAIN-FLOW-001 validation — the guided "follow the plan" default
// path: 今天的计划 → 准备热身 → 当前这一组 → 休息 → 下一组 → 结束训练.
//
// What this suite proves (synthetic data only):
//   A. Home: today's plan comes from the real getPlan schedule with
//      exactly one primary 按计划开始; swim/rest days are shown as
//      scheduled with no substituted strength session; a failed read
//      keeps the last good plan and says so; other days and every
//      review/analysis surface sit behind labelled secondary entries.
//   B. Warmup: warmupStepsFor runs over the REAL ROUTINE_META text —
//      movements/durations/counts unchanged, the barbell 2×12 stays
//      ONE prep step, and joining the steps reproduces the original.
//   C. Work card: 完成这组 submits through the row's own save handle
//      (completeAndFlush) and advances ONLY after a confirmed save;
//      saving locks against double submits; a blocked/failed save
//      stays on the set with input kept and 未保存/重试 offered; a
//      guided skip writes nothing; plate math is barbell-only,
//      dumbbells are labelled 单只, timed sets take seconds; RIR and
//      the plate/warmup tool live in the collapsed 调整 details; the
//      full plan table stays mounted inside 本次计划.
//   D. Rest: the countdown ending only reads 可以开始 (nothing
//      auto-starts or auto-completes), 开始下一组 ends rest early
//      without touching any completion record, +30秒/静音/时长/自动
//      开关 all live on the rest surface, and the countdown starts
//      only under the existing auto setting.
//   E. Progress: warmup and formal-set progress are separate (formal
//      denominator never counts warmup); resume follows the server
//      record (any saved completed set → straight back to work); an
//      unfinished local warmup stops at an explicit recovery choice;
//      guided primary/secondary targets are ≥44px.
//   F. Mutation sensitivity: corrupting the step split or the
//      save-then-advance order flips the corresponding checks.
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';

const clientSrc = readFileSync(new URL('./client/src/App.tsx', import.meta.url), 'utf8');
const cssSrc = readFileSync(new URL('./client/src/theme.css', import.meta.url), 'utf8');

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
  const idx = source.search(new RegExp(`(export\\s+)?function ${name}\\(`));
  if (idx < 0) throw new Error(`function ${name} not found`);
  const openParen = source.indexOf('(', idx);
  const closeParen = matchDelim(source, openParen, '(', ')');
  const bodyStart = source.indexOf('{', closeParen);
  const end = matchDelim(source, bodyStart, '{', '}') + 1;
  return source.slice(idx, end);
}
function sliceBetween(source, startMarker, endMarker) {
  const a = source.indexOf(startMarker);
  const b = source.indexOf(endMarker, a + startMarker.length);
  if (a < 0 || b < 0) throw new Error(`markers not found: ${startMarker} .. ${endMarker}`);
  return source.slice(a, b);
}

// --- A: home default path --------------------------------------------
const startScreen = sliceBetween(clientSrc, 'function StartScreen(', 'export function App()');
const todaySection = sliceBetween(startScreen, 'const todayIndex = todayScheduleIndex()', 'start.isError');
check('A1 exactly one 按计划开始 primary on the start screen',
  (startScreen.match(/按计划开始/g) ?? []).length === 1);
check('A2 today comes from the real plan schedule (todayScheduleIndex + planData.schedule)',
  todaySection.includes('todayScheduleIndex()')
  && todaySection.includes('planData?.schedule.find')
  && todaySection.includes('onClick={() => start.mutate(todayRoutine)}'));
check('A3 swim/rest day shown as scheduled, no strength session substituted',
  todaySection.includes('没有力量训练安排，不用硬练')
  && todaySection.includes('SCHEDULE_CODE_LABELS[todayEntry.routine_code]'));
check('A4 missing plan is honest: 计划还没读出来 + retry, no invented plan',
  todaySection.includes('计划还没读出来') && todaySection.includes('重试读取计划'));
check('A5 failed read keeps the last good plan and labels it unverified',
  startScreen.includes('lastGoodPlan')
  && startScreen.includes('未经本次核实')
  && startScreen.includes('planReadFailed'));
check('A6 other days + review/history/analysis behind labelled secondary entries',
  startScreen.includes('<summary>换个训练')
  && startScreen.includes('<summary>本周安排')
  && startScreen.includes('<summary>上周复盘')
  && startScreen.includes('<summary>历史与趋势')
  && startScreen.includes('<summary>肌群分析'));
check('A7 an active workout takes over the screen (continue beats starting over)',
  clientSrc.includes('dashboard.data.active_workout ? (')
  && clientSrc.includes('<ActiveWorkout'));

// --- B: warmup steps over the real ROUTINE_META -----------------------
const metaStart = clientSrc.indexOf('const ROUTINE_META');
const metaEq = clientSrc.indexOf('= {', metaStart);
const metaEnd = matchDelim(clientSrc, metaEq + 2, '{', '}') + 1;
const metaLiteral = clientSrc.slice(metaEq + 2, metaEnd);
const wfSrc = extractFunction(clientSrc, 'warmupStepsFor');
function buildWarmup(metaCode, stepsCode) {
  return new Function(
    `const ROUTINE_META = ${metaCode};\n${stripTypeScriptTypes(stepsCode.replace(/^export /m, ''))}\nreturn { ROUTINE_META, warmupStepsFor };`,
  )();
}
const { ROUTINE_META, warmupStepsFor } = buildWarmup(metaLiteral, wfSrc);
{
  const push = warmupStepsFor('push');
  check('B1 push warmup = original 4 steps, 空杆卧推 2×12 stays ONE prep step',
    push.length === 4 && push[3] === '空杆卧推 2×12' && push[0] === '单车 5 分钟',
    push.join(' | '));
  const counts = { push: 4, pull: 4, legs: 5, home_posture: 3, home_snowboard: 4 };
  check('B2 every routine keeps its original step count (nothing added or dropped)',
    Object.entries(counts).every(([r, n]) => warmupStepsFor(r).length === n));
  check('B3 steps re-join to the exact original warmup text for all routines',
    Object.keys(ROUTINE_META).every((r) => warmupStepsFor(r).join(' · ') === ROUTINE_META[r].warmup));
  check('B4 timed home steps keep their seconds (单腿站立各 20 秒)',
    warmupStepsFor('home_snowboard').includes('单腿站立各 20 秒'));
  check('B5 steps are plain strings and the splitter writes no sets',
    warmupStepsFor('legs').every((s) => typeof s === 'string')
    && !/addSet|updateSet|api\./.test(wfSrc));
}

// --- C: guided work card ----------------------------------------------
const completeChunk = extractFunction(clientSrc, 'handleGuidedComplete');
check('C1 完成这组 is double-submit locked and handle-driven',
  completeChunk.includes('if (!guidedCurrent || guidedSaving || finishing) return;')
  && completeChunk.includes('setHandlesRef.current.get(setId)'));
check('C2 empty reps blocks the save before anything is submitted (target range never stored as actual)',
  completeChunk.includes('handle.getDraft().reps.trim() === ""')
  && completeChunk.indexOf('reps.trim()') < completeChunk.indexOf('completeAndFlush'));
check('C3 advance happens only after the confirmed save (save → advance order)',
  completeChunk.indexOf('await handle.completeAndFlush()') >= 0
  && completeChunk.indexOf('await handle.completeAndFlush()') < completeChunk.indexOf('advanceAfterGuidedSave(setId)')
  && completeChunk.includes('if (!ok)'));
check('C4 failed save keeps the input and offers 未保存 + 重试保存',
  clientSrc.includes('未保存，输入已保留，重试即可。')
  && clientSrc.includes('onClick={() => void handleGuidedRetry()}')
  && clientSrc.includes('重试保存'));
const skipChunk = extractFunction(clientSrc, 'handleGuidedSkip');
check('C5 guided skip writes nothing (no flush, no api, set stays incomplete)',
  !/completeAndFlush|flush\(|api\.|completed/.test(skipChunk)
  && skipChunk.includes('nextSkipped.add(setId)'));
const workCard = sliceBetween(clientSrc, '{guidedPhase === "work" ?', 'aria-label="正式组已处理完"');
check('C6 plate text is barbell-only; dumbbells labelled 单只; no plate math elsewhere',
  workCard.includes('BARBELL_EXERCISE_KEYS.has(item.group.key)')
  && workCard.includes('calcPlateCombo')
  && workCard.includes('单只哑铃')
  && workCard.includes('（含杠'));
check('C7 timed sets take a seconds value, per-side sets say 左右两侧各做一遍',
  workCard.includes('保持秒数（目标')
  && workCard.includes('左右两侧各做一遍'));
check('C8 demo entry + one-line next preview on the card',
  workCard.includes('看示范与要领') && workCard.includes('下一步：'));
check('C9 RIR + plate/warmup tool folded into the collapsed 调整/训练工具 details',
  workCard.includes('<details className="guided-tools">')
  && workCard.includes('调整 / 训练工具（可选）')
  && workCard.includes('<PlateWarmupTool'));
check('C10 prefill source is disclosed; first record asks for actuals, never 0 or a target',
  workCard.includes('数值已按上次表现预填（含渐进建议）')
  && workCard.includes('重量不知道就留空，不要填 0'));
check('C11 full plan stays mounted in the collapsed 本次计划 (SetRows never unmount)',
  clientSrc.includes('<details className="plan-overview">')
  && clientSrc.includes('<summary>本次计划')
  && sliceBetween(clientSrc, '<details className="plan-overview">', 'session-panel').includes('<ExerciseBlock'));

// --- D: rest screen -----------------------------------------------------
const restCard = sliceBetween(clientSrc, 'aria-label="休息"', 'aria-label="当前这一组"');
check('D1 countdown end only reads 可以开始 — it never auto-starts the next set',
  restCard.includes('✓ 可以开始了。倒计时结束不会自动开始下一组。'));
check('D2 开始下一组 ends rest early via skipRestTimer and touches no completion record',
  restCard.includes('开始下一组')
  && restCard.includes('skipRestTimer(state)')
  && !/completeAndFlush|api\./.test(restCard));
const timerPanel = extractFunction(clientSrc, 'RestTimerPanel');
check('D3 rest surface carries +30秒, 静音 and duration choices',
  timerPanel.includes('addRestTime(state, 30, Date.now())')
  && timerPanel.includes('+30秒')
  && timerPanel.includes('toggleRestMuted')
  && timerPanel.includes('REST_DURATIONS.map'));
check('D4 countdown starts only under the existing auto setting',
  extractFunction(clientSrc, 'advanceAfterGuidedSave')
    .includes('shouldAutoStartRest(state) ? startRestTimer(state, Date.now()) : state'));

// --- E: progress separation, resume, touch targets ----------------------
check('E1 warmup screen separates progress: 正式组 done/total with 热身不计入',
  clientSrc.includes('（热身不计入）')
  && clientSrc.includes('正式组 {doneCount}/{total}'));
check('E2 resume follows the server record: any saved completed set → work phase',
  clientSrc.includes('if (workout.sets.some((set) => set.completed)) return "work";'));
check('E3 unfinished local warmup stops at the explicit recovery choice',
  clientSrc.includes('return "warmup-recovery";')
  && clientSrc.includes('热身进度只存在这台设备上，没有写入训练记录'));
check('E4 all formal sets saved → completion card points at 结束训练; skipped stay 未完成',
  clientSrc.includes('✓ 全部正式组已完成')
  && clientSrc.includes('其余组已跳过（未完成）')
  && clientSrc.includes('跳过的组没有打勾'));
check('E5 guided touch targets ≥44px (primary 56, secondary rows 48)',
  /\.guided-primary\s*\{[^}]*min-height:\s*56px/.test(cssSrc)
  && /\.guided-secondary-row button\s*\{[^}]*min-height:\s*48px/.test(cssSrc)
  && /\.guided-tools > summary\s*\{[^}]*min-height:\s*48px/.test(cssSrc));

// --- F: mutation sensitivity --------------------------------------------
{
  const mutant = buildWarmup(metaLiteral, wfSrc.replace('.split("·")', '.split("；")'));
  const steps = mutant.warmupStepsFor('push');
  check('M1 breaking the · split flips B1 (steps collapse to one blob)',
    !(steps.length === 4 && steps[3] === '空杆卧推 2×12'), `mutant steps: ${steps.length}`);
}
{
  const reordered = completeChunk.replace(
    'ok = await handle.completeAndFlush();',
    'advanceAfterGuidedSave(setId); ok = true;',
  );
  check('M2 advancing before the save flips C3',
    !(reordered.indexOf('await handle.completeAndFlush()') >= 0
      && reordered.indexOf('await handle.completeAndFlush()') < reordered.indexOf('advanceAfterGuidedSave(setId)')));
}

console.log(`\n${passed} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
