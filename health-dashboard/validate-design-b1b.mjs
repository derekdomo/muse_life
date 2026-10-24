// LIFE-DESIGN-001-B1B validation: the space-4 three-page
// restructure (owner ruling 2026-10-24, design draft
// DESIGN-DRAFT-2026-10-24.md, options 3A 移历史页 / folds).
//
// Structure assertions only, run against the REAL client
// source (client/src/App.tsx) — no function, formula, data
// pipeline or presentation behaviour is re-implemented here.
// This is the script whose absence H-VALID-MAINT-001 records:
// the B1B builder claimed it existed, it did not, and the
// B1B-specific assertions had never actually run. Covers:
// (1) today page default units + fold default states,
// (2) the full week review reachable on the history page
//     with only a conclusion/teaser entry left on today,
// (3) the data-status ledger living in a dedicated history
//     zone while a one-line status anchor stays always
//     visible on today (R6: freshness never folded away),
// (4) swimming carried by the all-workouts filter after the
//     standalone swim section was removed,
// (5) the character (game) page panels as default-closed
//     folds whose summaries carry the numbers.
// Mutation checks at the end prove the placement/filter
// predicates flip when the wiring is broken. Synthetic
// strings only; no real health data is read.
import { readFileSync } from 'node:fs';

const clientSrc = readFileSync(new URL('./client/src/App.tsx', import.meta.url), 'utf8');

let passed = 0;
let failures = 0;
function check(name, ok, note = '') {
  if (ok) passed++;
  else failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${note ? ` (${note})` : ''}`);
}
function count(haystack, needle) {
  return haystack.split(needle).length - 1;
}
function sliceBetween(src, startMarker, endMarker) {
  const start = src.indexOf(startMarker);
  if (start < 0) throw new Error(`slice start not found: ${startMarker}`);
  const end = src.indexOf(endMarker, start + startMarker.length);
  if (end < 0) throw new Error(`slice end not found: ${endMarker}`);
  return src.slice(start, end);
}

const heroSrc = sliceBetween(clientSrc, 'function WhoopHero(', 'function SevenDayFacts(');
const todaySrc = sliceBetween(clientSrc, 'function TodayView(', 'function RecentWorkouts(');
const trendsSrc = sliceBetween(clientSrc, 'function TrendsView(', 'function allWorkoutsList(');
const historySrc = sliceBetween(clientSrc, 'function HistoryView(', 'const GAME_CATEGORY_META');
const gameSrc = sliceBetween(clientSrc, 'function GameView()', 'function Dashboard(');
const readinessSrc = sliceBetween(clientSrc, 'function ReadinessPanel(', 'function DataStatusPanel(');

// ---------- predicates reused by the mutation checks ----------
function weekReviewInHistory(src) {
  const hist = sliceBetween(src, 'function HistoryView(', 'const GAME_CATEGORY_META');
  const today = sliceBetween(src, 'function TodayView(', 'function RecentWorkouts(');
  const panel = hist.indexOf('<WeekReviewPanel');
  return panel > -1
    && today.indexOf('<WeekReviewPanel') === -1
    && panel < hist.indexOf('<DataStatusPanel')
    && panel < hist.indexOf('history-section history-fold');
}
function swimFilterWired(src) {
  const hist = sliceBetween(src, 'function HistoryView(', 'const GAME_CATEGORY_META');
  return hist.includes('const [workoutFilter, setWorkoutFilter] = useState<"all" | "swim">("all")')
    && hist.includes('workoutFilter === "swim" ? allWorkouts.filter((workout) => isSwimWorkout(workout.type)) : allWorkouts')
    && hist.includes('aria-label="只看游泳记录"')
    && hist.includes('onClick={() => setWorkoutFilter("swim")}')
    && !src.includes('id="swim-history-title"');
}
function foldsDefaultClosed(slice, openPattern) {
  return !openPattern.test(slice);
}

// ---------- (1) today: default units + fold defaults ----------
check('today: hero is the first unit', todaySrc.indexOf('<WhoopHero') > -1
  && todaySrc.indexOf('<WhoopHero') < todaySrc.indexOf('<SevenDayFacts'));
check('today: hero keeps the three score rings + one-line conclusion',
  heroSrc.includes('whoop-scores') && heroSrc.includes('todayConclusion(') && heroSrc.includes('whoop-summary'));
check('today: seven-day facts strip rendered exactly once',
  count(todaySrc, '<SevenDayFacts') === 1);
check('today: sleep-regularity panel stays on today, beside the facts strip',
  todaySrc.includes('<SleepRegularityPanel snapshot={snapshot} />'));
check('today: readiness detail is a fold, closed by default (state starts false)',
  todaySrc.includes('const [readinessOpen, setReadinessOpen] = useState(false)')
  && todaySrc.includes('<ReadinessPanel readiness={readiness} compact open={readinessOpen}'));
check('today: readiness fold summary carries numbers (status / score / confidence / sleep debt)',
  readinessSrc.includes('恢复详情 · {foldSummaryText}')
  && readinessSrc.includes('置信度') && readinessSrc.includes('睡眠债'));
check('today: recent workouts live inside a default-closed fold',
  todaySrc.includes('<details className="workout-recent-fold">')
  && foldsDefaultClosed(todaySrc, /workout-recent-fold[^>]*\sopen[\s=>]/));
check('today: 30-day swim count line stays always visible, above the recent-workouts fold',
  todaySrc.indexOf('近30天游泳 {swimCount30d} 次') > -1
  && todaySrc.indexOf('近30天游泳 {swimCount30d} 次') < todaySrc.indexOf('<details className="workout-recent-fold">'));

// ---------- (2) week review: full panel on history, entry on today ----------
check('week review: full panel rendered exactly once in the whole client',
  count(clientSrc, '<WeekReviewPanel') === 1);
check('week review: panel sits in HistoryView, before data status and the history folds',
  weekReviewInHistory(clientSrc));
check('week review: panel anchor id present exactly once',
  count(clientSrc, 'id="week-review-panel"') === 1);
check('week review: today keeps only the entry — hero button + dashboard jump to the history panel',
  heroSrc.includes('查看周复盘依据/反馈')
  && clientSrc.includes('onGoToWeekReview={() => goToHistoryPanel("week-review-panel")}'));
check('week review: today renders neither the full panel nor the data-status panel',
  !todaySrc.includes('<WeekReviewPanel') && !todaySrc.includes('<DataStatusPanel'));

// ---------- (3) data status: dedicated history zone + always-visible today anchor ----------
check('data status: dedicated panel rendered inside HistoryView, right after the week review',
  historySrc.indexOf('<DataStatusPanel') > historySrc.indexOf('<WeekReviewPanel'));
check('data status: panel anchor id present exactly once',
  count(clientSrc, 'id="data-status-panel"') === 1);
check('data status: today keeps a one-line always-visible anchor (R6, not folded)',
  todaySrc.includes('<section className="data-status-anchor" aria-label="数据状态总览">')
  && todaySrc.includes('dataStatus ? dataStatus.overallLabel : "暂无数据状态"')
  && todaySrc.includes('aria-label="查看数据状态"')
  && clientSrc.includes('onGoToDataStatus={() => goToHistoryPanel("data-status-panel")}'));

// ---------- history folds: six sections, default closed, summaries carry counts ----------
check('history: exactly six folded sections',
  count(historySrc, '<details className="history-section history-fold') === 6);
check('history: no folded section renders open by default',
  foldsDefaultClosed(historySrc, /history-section history-fold[^>]*\sopen[\s=>]/));
for (const label of ['展开一体时间线，共', '展开力量训练历史，共', '展开肌群状态，共', '展开全部运动记录，共', '展开体重记录，共', '展开睡眠历史，共']) {
  check(`history: fold summary carries its count (${label}…)`, historySrc.includes(label));
}
check('trends: daily-detail charts live in a default-closed fold',
  trendsSrc.includes('<details className="history-charts trends-daily-fold">')
  && trendsSrc.includes('展开每日明细，近30天，共')
  && foldsDefaultClosed(trendsSrc, /trends-daily-fold[^>]*\sopen[\s=>]/));

// ---------- (4) swimming: carried by the all-workouts filter ----------
check('swim: filter wiring replaces the standalone swim section', swimFilterWired(clientSrc));
check('swim: filter offers 全部 / 只看游泳 as pressed-state buttons',
  historySrc.includes('aria-label="显示全部运动记录"') && historySrc.includes('aria-pressed={workoutFilter === "swim"}'));
check('swim: all-workouts fold summary counts swims (其中游泳 N 次)',
  historySrc.includes('{allWorkouts.length} 次 · 其中游泳 {swimWorkoutCount} 次'));
check('swim: swim empty state retained under the filter',
  historySrc.includes('workoutFilter === "swim" ? "近30天没有游泳 workout 记录。" : "近30天没有 HealthKit 运动记录。"'));
check('swim: daily swim-distance chart stays reachable on the trends page',
  trendsSrc.includes('title="每日游泳距离"'));

// ---------- (5) character page: panels as default-closed folds with numeric summaries ----------
check('game: four folded panels (attributes / equipment+shop / rewards / ledger)',
  count(gameSrc, '<details className="game-panel game-fold">') === 3
  && count(gameSrc, '<details className="game-fold game-rewards-fold">') === 1);
check('game: no folded panel renders open by default',
  foldsDefaultClosed(gameSrc, /game-fold[^>]*\sopen[\s=>]/));
for (const label of ['展开属性，未分配', '展开装备与商店，金币余额', '展开奖励，金币余额', '展开经验账本，共']) {
  check(`game: fold summary carries its number (${label}…)`, gameSrc.includes(label));
}

// ---------- mutations: the predicates must flip when wiring breaks ----------
const noPanelSrc = clientSrc.replace('<WeekReviewPanel snapshot={snapshot} focusFeedback={focusFeedback} focusReadFailed={focusReadFailed ?? false} onViewTraining={onViewTraining} />', '');
check('mutation setup: removing the history week-review panel differs from source', noPanelSrc !== clientSrc);
check('mutation: without the history panel, weekReviewInHistory flips to false',
  noPanelSrc !== clientSrc && !weekReviewInHistory(noPanelSrc));
const noFilterSrc = clientSrc.replace('workoutFilter === "swim" ? allWorkouts.filter((workout) => isSwimWorkout(workout.type)) : allWorkouts', 'allWorkouts');
check('mutation setup: unwiring the swim filter differs from source', noFilterSrc !== clientSrc);
check('mutation: without the filter derivation, swimFilterWired flips to false',
  noFilterSrc !== clientSrc && !swimFilterWired(noFilterSrc));

console.log(`\nvalidate-design-b1b: ${passed} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
