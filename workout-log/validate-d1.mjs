// W-UI-001-D1 validation — top completion count vs save aggregate,
// current-exercise selection, and the Enter focus chain.
// Runs the REAL pure functions extracted verbatim from
// client/src/App.tsx over synthetic snapshots only, plus source-level
// wiring assertions for the status bar / hidden card body / focus
// attributes, and theme.css presence checks. Pure Node, no deps.
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";

const clientSrc = readFileSync(new URL("./client/src/App.tsx", import.meta.url), "utf8");
const themeCss = readFileSync(new URL("./client/src/theme.css", import.meta.url), "utf8");

let passed = 0;
let failures = 0;
function check(name, ok) {
  if (ok) passed++;
  else { failures++; console.log("FAIL:", name); }
}
function matchDelim(s, start, open, close) {
  let depth = 0;
  for (let i = start; i < s.length; i++) {
    if (s[i] === open) depth++;
    else if (s[i] === close) { depth--; if (depth === 0) return i; }
  }
  throw new Error("unbalanced delimiters");
}
function extractFunction(source, name) {
  const idx = source.search(new RegExp(`function ${name}\\(`));
  if (idx < 0) throw new Error(`function ${name} not found`);
  const sigOpen = source.indexOf("(", idx);
  const sigClose = matchDelim(source, sigOpen, "(", ")");
  const bodyOpen = source.indexOf("{", sigClose);
  const bodyClose = matchDelim(source, bodyOpen, "{", "}");
  return source.slice(idx, bodyClose + 1);
}
function loadFunction(name, mutate) {
  let text = extractFunction(clientSrc, name);
  if (mutate) text = mutate(text);
  const js = stripTypeScriptTypes(text, { mode: "transform" });
  return new Function(`${js}; return ${name};`)();
}

const aggregateSaveStates = loadFunction("aggregateSaveStates");
const resolveCurrentExerciseKey = loadFunction("resolveCurrentExerciseKey");
const buildFocusOrder = loadFunction("buildFocusOrder");
const nextFocusTarget = loadFunction("nextFocusTarget");
const exerciseHeadInfo = loadFunction("exerciseHeadInfo");

const snap = (status, blocked = false, exerciseKey = "bench", id = 1) => ({ id, exerciseKey, status, blocked });
const clean = { pendingAdds: 0, finishing: false };

// --- aggregateSaveStates: fixed priority chain ---
let r = aggregateSaveStates([], clean);
check("aggregate: empty -> saved 全部已保存", r.kind === "saved" && r.label === "全部已保存" && r.firstAbnormal === null);
r = aggregateSaveStates([snap("error")], clean);
check("aggregate: one error", r.kind === "error" && r.label === "有 1 组保存失败" && r.errorCount === 1 && r.firstAbnormal?.id === 1);
r = aggregateSaveStates([snap("error", false, "bench", 1), snap("error", false, "row", 2), snap("saved", true, "row", 3)], clean);
check("aggregate: error outranks blocked, counts kept", r.kind === "error" && r.errorCount === 2 && r.blockedCount === 1 && r.firstAbnormal?.id === 1);
r = aggregateSaveStates([snap("saved", true, "bench", 7)], clean);
check("aggregate: blocked -> 需补次数 + firstAbnormal", r.kind === "blocked" && r.label === "有 1 组需补次数" && r.firstAbnormal?.id === 7);
r = aggregateSaveStates([snap("dirty")], clean);
check("aggregate: dirty -> 有未保存的修改", r.kind === "dirty" && r.label === "有未保存的修改" && r.firstAbnormal !== null);
r = aggregateSaveStates([snap("saving")], clean);
check("aggregate: saving -> 正在保存", r.kind === "saving" && r.label === "正在保存" && r.firstAbnormal === null);
r = aggregateSaveStates([snap("saved")], { pendingAdds: 0, finishing: true });
check("aggregate: finishing never reads 全部已保存", r.kind === "finishing" && r.label === "正在结束…");
r = aggregateSaveStates([snap("saved")], { pendingAdds: 1, finishing: false });
check("aggregate: pending add -> 正在添加一组", r.kind === "adding" && r.label === "正在添加一组");
r = aggregateSaveStates([snap("saved")], { pendingAdds: 1, finishing: true });
check("aggregate: finishing outranks adding (code order)", r.kind === "finishing");
r = aggregateSaveStates([snap("error")], { pendingAdds: 0, finishing: true });
check("aggregate: error outranks finishing", r.kind === "error");

// --- resolveCurrentExerciseKey ---
const groups = [
  { key: "bench", hasIncomplete: false },
  { key: "row", hasIncomplete: true },
  { key: "curl", hasIncomplete: true },
];
check("resolve: empty -> null", resolveCurrentExerciseKey([], null) === null);
check("resolve: manual selection wins", resolveCurrentExerciseKey(groups, "curl") === "curl");
check("resolve: stale manual falls back to first incomplete", resolveCurrentExerciseKey(groups, "gone") === "row");
check("resolve: default first incomplete", resolveCurrentExerciseKey(groups, null) === "row");
check("resolve: all complete -> last exercise", resolveCurrentExerciseKey(groups.map((g) => ({ ...g, hasIncomplete: false })), null) === "curl");

// --- buildFocusOrder / nextFocusTarget ---
const focusGroups = [
  { key: "bench", sets: [{ id: 1 }, { id: 2 }] },
  { key: "row", sets: [{ id: 3 }] },
];
const order = buildFocusOrder(focusGroups);
check("focus: order is weight->reps per set, group order", order.length === 6
  && order[0].field === "weight" && order[1].field === "reps" && order[1].setId === 1
  && order[2].setId === 2 && order[4].exerciseKey === "row");
let t = nextFocusTarget(order, order[0]);
check("focus: weight -> same set reps", t?.kind === "field" && t.target.setId === 1 && t.target.field === "reps");
t = nextFocusTarget(order, order[1]);
check("focus: reps -> next set weight", t?.kind === "field" && t.target.setId === 2 && t.target.field === "weight");
t = nextFocusTarget(order, order[3]);
check("focus: crosses into next exercise", t?.kind === "field" && t.target.exerciseKey === "row" && t.target.setId === 3 && t.target.field === "weight");
t = nextFocusTarget(order, order[order.length - 1]);
check("focus: last field -> finish", t?.kind === "finish");
t = nextFocusTarget(order, { exerciseKey: "nope", setId: 99, field: "weight" });
check("focus: unknown field -> null", t === null);

// --- exerciseHeadInfo ---
let h = exerciseHeadInfo(3, [snap("error")]);
check("head: error text + doneCount passthrough", h.doneCount === 3 && h.statusText === "有 1 组保存失败" && h.statusKind === "error");
h = exerciseHeadInfo(1, [snap("saved", true)]);
check("head: single blocked -> 需补次数", h.statusText === "需补次数" && h.statusKind === "blocked");
h = exerciseHeadInfo(0, [snap("saved", true, "bench", 1), snap("saved", true, "bench", 2)]);
check("head: two blocked -> 有 2 组需补次数", h.statusText === "有 2 组需补次数");
h = exerciseHeadInfo(2, [snap("dirty")]);
check("head: dirty -> 有未保存修改", h.statusText === "有未保存修改" && h.statusKind === "dirty");
h = exerciseHeadInfo(2, [snap("saving")]);
check("head: saving -> 保存中…", h.statusText === "保存中…" && h.statusKind === "saving");
h = exerciseHeadInfo(2, [snap("saved")]);
check("head: clean -> no status text", h.statusText === null && h.statusKind === null);

// --- wiring (real source) ---
check("wiring: status bar with separate completion count", clientSrc.includes('className="workout-status-bar"') && clientSrc.includes("已完成 {doneCount} / {total} 组"));
check("wiring: 查看 button only rendered for error/blocked kinds", clientSrc.includes('aggregate.kind === "error" || aggregate.kind === "blocked"'));
check("wiring: card body hidden, rows stay mounted", clientSrc.includes('className="exercise-body" hidden={!expanded}'));
check("wiring: focus attributes + finish ref", clientSrc.includes("data-focus-set={set.id}") && clientSrc.includes("finishButtonRef"));
check("wiring: timer anchors to resolved current exercise", clientSrc.includes("resolveCurrentExerciseKey(") && clientSrc.includes("exercise.key === currentExercise.key"));
check("css: D1 selectors present", themeCss.includes(".workout-status-bar") && themeCss.includes(".save-aggregate") && themeCss.includes(".exercise-body[hidden]") && themeCss.includes(".exercise-head-status"));

// --- mutation sensitivity: break the error filter, error case must flip ---
const mutatedAggregate = loadFunction("aggregateSaveStates", (text) => text.replace('snapshot.status === "error"', 'snapshot.status === "error-gone"'));
r = mutatedAggregate([snap("error")], clean);
check("mutation: removing the error branch flips the error case", r.kind !== "error");

console.log(`validate-d1: ${passed}/${passed + failures} passed`);
process.exit(failures ? 1 : 0);
