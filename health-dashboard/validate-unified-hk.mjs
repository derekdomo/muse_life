// H-WORKOUTS-001 (2) validation — unified timeline merges HealthKit
// workout sessions by local date, alongside steps/sleep/HR/strength.
// Runs the REAL production functions extracted verbatim from
// server/src/actions.ts (buildUnifiedTimeline) and client/src/App.tsx
// (unifiedHkLabel) over synthetic data only. Pure Node, no deps.
// Contract under test:
//  - hkWorkouts groups historyWorkouts by date, then by verbatim type
//    (type ascending for determinism); sessions = record count;
//    durationMinutes = sum of known durations (1 decimal), null when
//    every session of that type that day is unknown — never filled 0.
//  - Sessions come only from historyWorkouts, never from daily summaries,
//    and never count as strength: strengthSessions/strengthVolume and
//    hasStrength are untouched even by strength-typed HK sessions.
//  - A date with only HK workouts still gets a timeline row (hasHealth).
//  - unifiedHkLabel: "" for none; otherwise 运动 N 次 · 类型… plus a
//    已知时长 X 分 segment only when at least one group duration is
//    known (a real known total of 0 still renders 已知时长 0 分).
//    PM 2026-10-16 17:50 rework: the summed duration is only the known
//    subtotal, so it must never render as an unconditional 共 X 分
//    total; both timeline render sites carry the visible note
//    仅汇总有记录的时长，缺失不按0.
// Mutations are executed (null-duration guard removed, type sort
// reversed, client session-sum broken) and must flip outcomes.
// Viewport/page evidence and the health-cli same-window count stay
// 运行待验 (owner-side PM acceptance, not claimed here).
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';

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
  const bodyStart = source.indexOf('{', closeParen);
  const bodyEnd = matchDelim(source, bodyStart, '{', '}');
  return source.slice(idx, bodyEnd + 1);
}

// --- source-level wiring ---
// 2026-10-19 回灌（a45ebce，H-SYNC-DIVERGE-001）：组 schema 已具名为
// hkWorkoutGroupSchema（字段不变），unifiedDaySchema 仍携带 hkWorkouts。
check('source: unifiedDaySchema carries hkWorkouts groups',
  serverSrc.includes('hkWorkouts: z.array(hkWorkoutGroupSchema)')
  && serverSrc.includes('const hkWorkoutGroupSchema = z.object({')
  && serverSrc.includes('durationMinutes: z.number().nonnegative().nullable()'));
// 同上：新建日行仍默认 hkWorkouts: []（行字段现含 workoutSessions/
// workoutTypes/swimMeters，模式随之对齐）。
check('source: timeline defaults hkWorkouts to [] on new rows',
  serverSrc.includes('strengthRoutines: [], workoutSessions: 0, workoutTypes: [], swimMeters: null, hkWorkouts: []'));
// 同上：聚合仍只读 historyWorkouts（?? [] 冗余守卫随 if (healthSnapshot)
// 外层守卫移除，行为等价）。
check('source: aggregation reads historyWorkouts only',
  serverSrc.includes('if (healthSnapshot) {')
  && serverSrc.includes('for (const workout of healthSnapshot.historyWorkouts)'));
check('source: client label consumed at both timeline render sites',
  (clientSrc.match(/unifiedHkLabel\(day\)/g) ?? []).length === 4,
  `occurrences=${(clientSrc.match(/unifiedHkLabel\(day\)/g) ?? []).length}`);
// PM 返工交付（2026-10-16 19:18，changes.md:306-307）+ 2026-10-19 回灌：
// 两处时间线现为 artifact 侧原文形态
// <p className="unified-note">仅汇总有记录的时长，缺失不按0</p>（仓库侧
// 旧的「运动时长说明：…」+ .empty-inline 变体已被回灌替换）。
check('source: known-duration note visible at both timeline render sites',
  (clientSrc.match(/<p className="unified-note">仅汇总有记录的时长，缺失不按0<\/p>/g) ?? []).length === 2,
  `occurrences=${(clientSrc.match(/<p className="unified-note">仅汇总有记录的时长，缺失不按0<\/p>/g) ?? []).length}`);
// 「已知小计≠总数」禁令只归 unifiedHkLabel 的时长段（PM 2026-10-16
// 17:50 返工判据）。swimWeekSummary 的 `共 X 米` 仅在其全已知分支出现
// （H-SWIM-VIS-001，plans.md:197 / changes.md:1459），是合法的全量总和——
// 故断言收窄到 unifiedHkLabel 本函数体，不再对全文件禁 `· 共 ${`。
const unifiedHkLabelSrc = extractFunction(clientSrc, 'unifiedHkLabel');
check('source: label never renders an unconditional 共 X 分 total',
  !unifiedHkLabelSrc.includes('共 ${') && unifiedHkLabelSrc.includes('已知时长 ${')); 

// --- real server function ---
function buildTimeline(src) {
  const FN = ['clamp', 'round', 'totalSleepHours', 'timeInBedHours', 'convertVolumeToUnit', 'buildUnifiedTimeline'];
  const lbDecl = src.match(/const LB_TO_KG = [0-9.]+;/)?.[0] ?? '';
  if (!lbDecl) throw new Error('LB_TO_KG declaration not found');
  const code = `${lbDecl}\n${FN.map((n) => extractFunction(src, n)).join('\n')}`;
  return new Function(`${stripTypeScriptTypes(code)}\nreturn { buildUnifiedTimeline };`)().buildUnifiedTimeline;
}
function buildLabel(src) {
  const code = extractFunction(src, 'unifiedHkLabel');
  return new Function(`${stripTypeScriptTypes(code)}\nreturn { unifiedHkLabel };`)().unifiedHkLabel;
}
const buildUnifiedTimeline = buildTimeline(serverSrc);
const unifiedHkLabel = buildLabel(clientSrc);

const HK = (id, date, type, durationMinutes) => ({
  id, date, type, durationMinutes, energyKcal: null, distanceMeters: null, averageHr: null,
});
function healthSnap(historyWorkouts, extra = {}) {
  return { historyDaily: [], historySleeps: [], historyWorkouts, ...extra };
}

// PM synthetic example: Swimming×2 (30 + null) + Running×1 (20) on one day.
const mixed = healthSnap([
  HK('s1', '2026-10-12', 'Swimming', 30),
  HK('s2', '2026-10-12', 'Swimming', null),
  HK('r1', '2026-10-12', 'Running', 20),
]);
const tl = buildUnifiedTimeline(mixed, null);
check('merge: HK-only date gets a timeline row', tl.length === 1 && tl[0].date === '2026-10-12');
check('merge: row marked hasHealth, not hasStrength',
  tl[0].hasHealth === true && tl[0].hasStrength === false);
check('merge: groups aggregated by type, ascending',
  JSON.stringify(tl[0].hkWorkouts) === JSON.stringify([
    { type: 'Running', sessions: 1, durationMinutes: 20 },
    { type: 'Swimming', sessions: 2, durationMinutes: 30 },
  ]), JSON.stringify(tl[0].hkWorkouts));
check('merge: HK sessions never counted as strength',
  tl[0].strengthSessions === 0 && tl[0].strengthVolume === 0);

// Strength-typed HK session stays in hkWorkouts, out of strength counts.
const withHkStrength = healthSnap([HK('st1', '2026-10-11', 'Traditional Strength Training', 45)]);
const tlSt = buildUnifiedTimeline(withHkStrength, null);
check('no mixing: strength-typed HK session listed under hkWorkouts',
  tlSt[0].hkWorkouts.length === 1 && tlSt[0].hkWorkouts[0].type === 'Traditional Strength Training');
check('no mixing: strength counters still zero, hasStrength false',
  tlSt[0].strengthSessions === 0 && tlSt[0].hasStrength === false);

// All-null durations stay null (never 0); partial sums round to 1 decimal.
const nullDur = healthSnap([HK('y1', '2026-10-10', 'Yoga', null), HK('y2', '2026-10-10', 'Yoga', null)]);
check('missing duration: group durationMinutes stays null',
  buildUnifiedTimeline(nullDur, null)[0].hkWorkouts[0].durationMinutes === null);
const rounding = healthSnap([HK('a', '2026-10-09', 'Running', 10.04), HK('b', '2026-10-09', 'Running', 10.04)]);
check('duration sum rounds to 1 decimal (20.08 -> 20.1)',
  buildUnifiedTimeline(rounding, null)[0].hkWorkouts[0].durationMinutes === 20.1);

// No HK workouts -> empty groups; health/strength behaviour unchanged.
const dailyOnly = healthSnap([], {
  historyDaily: [{ date: '2026-10-08', steps: 4000, activeKcal: 200, exerciseMinutes: 10, restingHr: 60, hrvMs: 40, respiratoryRate: 14, weightKg: null, swimMeters: 0 }],
});
const tlDaily = buildUnifiedTimeline(dailyOnly, null);
check('no HK workouts: day still present with hkWorkouts []',
  tlDaily.length === 1 && Array.isArray(tlDaily[0].hkWorkouts) && tlDaily[0].hkWorkouts.length === 0);
check('neither source: timeline empty', buildUnifiedTimeline(null, null).length === 0);

// --- real client label ---
check('label: mixed day (same-type partial missing) totals sessions, duration marked known-only',
  unifiedHkLabel(tl[0]) === '运动 3 次 · Running、Swimming · 已知时长 50 分', unifiedHkLabel(tl[0]));
check('label: partial missing never renders as unconditional total',
  !unifiedHkLabel(tl[0]).includes('共 '), unifiedHkLabel(tl[0]));
// Same-type partial missing through the real producer: Swimming 30 + null.
const sameTypePartial = buildUnifiedTimeline(healthSnap([
  HK('p1', '2026-10-07', 'Swimming', 30),
  HK('p2', '2026-10-07', 'Swimming', null),
]), null);
check('label: same-type partial missing -> 已知时长 subtotal via producer',
  unifiedHkLabel(sameTypePartial[0]) === '运动 2 次 · Swimming · 已知时长 30 分', unifiedHkLabel(sameTypePartial[0]));
// Cross-type partial missing through the real producer: Yoga null + Running 12.5.
const crossTypePartial = buildUnifiedTimeline(healthSnap([
  HK('q1', '2026-10-06', 'Yoga', null),
  HK('q2', '2026-10-06', 'Running', 12.5),
]), null);
check('label: cross-type partial missing -> 已知时长 subtotal via producer',
  unifiedHkLabel(crossTypePartial[0]) === '运动 2 次 · Running、Yoga · 已知时长 12.5 分', unifiedHkLabel(crossTypePartial[0]));
// All durations known through the real producer.
const allKnown = buildUnifiedTimeline(healthSnap([
  HK('k1', '2026-10-05', 'Running', 20),
  HK('k2', '2026-10-05', 'Swimming', 30),
]), null);
check('label: all durations known -> 已知时长 full sum via producer',
  unifiedHkLabel(allKnown[0]) === '运动 2 次 · Running、Swimming · 已知时长 50 分', unifiedHkLabel(allKnown[0]));
check('label: all durations unknown -> count and types only, no duration segment',
  unifiedHkLabel({ hkWorkouts: [{ type: 'Yoga', sessions: 2, durationMinutes: null }] }) === '运动 2 次 · Yoga');
check('label: real known zero duration renders 已知时长 0 分',
  unifiedHkLabel({ hkWorkouts: [{ type: 'Walking', sessions: 1, durationMinutes: 0 }] }) === '运动 1 次 · Walking · 已知时长 0 分');
check('label: empty groups -> empty string', unifiedHkLabel({ hkWorkouts: [] }) === '');
check('label: missing field (older payload) -> empty string', unifiedHkLabel({}) === '');
check('label: partial knowledge sums only known groups',
  unifiedHkLabel({ hkWorkouts: [{ type: 'Yoga', sessions: 1, durationMinutes: null }, { type: 'Running', sessions: 1, durationMinutes: 12.5 }] }) === '运动 2 次 · Running、Yoga · 已知时长 12.5 分'
  || unifiedHkLabel({ hkWorkouts: [{ type: 'Yoga', sessions: 1, durationMinutes: null }, { type: 'Running', sessions: 1, durationMinutes: 12.5 }] }) === '运动 2 次 · Yoga、Running · 已知时长 12.5 分');

// --- mutation sensitivity (executed) ---
const nullGuardSrc = serverSrc.replace('durationMinutes: group.hasDuration ? round(group.durationSum, 1) : null', 'durationMinutes: round(group.durationSum, 1)');
check('mutation setup: null-guard variant differs', nullGuardSrc !== serverSrc);
check('mutation: dropping the null guard turns unknown duration into fake 0',
  buildTimeline(nullGuardSrc)(nullDur, null)[0].hkWorkouts[0].durationMinutes === 0);

// 类型组排序现为 .sort(([a], [b]) => a.localeCompare(b))（回灌形态）。
// 变异反转比较器方向。
const sortSrc = serverSrc.replace('.sort(([a], [b]) => a.localeCompare(b))', '.sort(([a], [b]) => b.localeCompare(a))');
check('mutation setup: sort variant differs', sortSrc !== serverSrc);
check('mutation: reversed type sort flips group order',
  buildTimeline(sortSrc)(mixed, null)[0].hkWorkouts[0].type === 'Swimming');

const sumSrc = clientSrc.replace('sum + group.sessions', 'sum + 1');
check('mutation setup: label session-sum variant differs', sumSrc !== clientSrc);
check('mutation: broken session sum changes the label total',
  buildLabel(sumSrc)(tl[0]) !== unifiedHkLabel(tl[0]));

const wordingSrc = clientSrc.replace('已知时长 ${', '共 ${');
check('mutation setup: wording variant differs', wordingSrc !== clientSrc);
check('mutation: reverting to unconditional 共 wording flips the partial-missing label',
  buildLabel(wordingSrc)(tl[0]) === '运动 3 次 · Running、Swimming · 共 50 分');

console.log(`\n${passed} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
