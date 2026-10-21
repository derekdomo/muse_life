// F0.7-OBS-001 (B-class presentation increment): the read-only
// 「检查进度」 check in RefreshStatusBand. Behaviour runs against
// the REAL production functions extracted from client/src/App.tsx
// (checkProgressFeedback + performProgressCheck, AST-transpiled);
// wiring assertions run against the real source text. Fixtures
// are synthetic values only — no real account data.
//
// The feedback is three separately-attributed layers: 读取结果
// (per-channel read lines), 刷新结果 (derived ONLY from the
// observations channel's current-generation diagnosis + raw
// state), 数据事实 (what the dashboard read carried + the
// read-only statement). The dashboard status is a PROJECTION —
// stored running past the wait window, or an unreadable saved
// payload, both read as "error" with no state write — so it must
// never earn a terminal verdict by itself.
import { readFileSync } from "node:fs";

const appSrc = readFileSync(new URL("./client/src/App.tsx", import.meta.url), "utf8");
let passed = 0, failed = 0;
function check(name, cond) {
  if (cond) { passed++; } else { failed++; console.log("FAIL:", name); }
}

// --- extract the real exported functions from App.tsx ---
const { default: ts } = await import("typescript");
function extractClientFns(names) {
  const clientFile = ts.createSourceFile("App.tsx", appSrc, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);
  const found = new Map();
  for (const node of clientFile.statements) {
    if (ts.isFunctionDeclaration(node) && node.name && names.includes(node.name.text)) {
      found.set(node.name.text, ts.transpileModule(node.getText(clientFile), {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.Preserve },
      }).outputText);
    }
  }
  for (const name of names) if (!found.has(name)) throw new Error(`client function not found: ${name}`);
  return names.map((name) => found.get(name)).join("\n");
}
const FN_NAMES = ["refreshStatusText", "refreshDiagnosisSymbol", "checkProgressFeedback", "performProgressCheck"];
const api = new Function(
  `const exports = {};\n${extractClientFns(FN_NAMES)}; return { ${FN_NAMES.join(", ")} };`,
)();
const { checkProgressFeedback, performProgressCheck } = api;

const fmt = (ms) => `T${ms}`;
const okRead = (over = {}) => ({
  ok: true, receivedAt: 5000, refreshStatus: "running", hasData: true, startedAt: null,
  message: null, asOf: null, diagnosisCode: null, diagnosisAttempt: null, ...over,
});
const failRead = () => ({
  ok: false, receivedAt: null, refreshStatus: null, hasData: false, startedAt: null,
  message: null, asOf: null, diagnosisCode: null, diagnosisAttempt: null,
});
const allText = (fb) => [fb.headline, fb.dashboardLine, fb.observationsLine, fb.refreshResultLine, fb.dataFactLine, fb.waitedText ?? "", fb.note].join("\n");
const START = "2026-10-20T10:00:00.000Z";
const START_MS = new Date(START).getTime();
const ASOF = "2026-10-19T08:30:00.000Z";
const ASOF_MS = new Date(ASOF).getTime();

// --- running, awaiting the current generation's callback ---
const running = checkProgressFeedback({
  dashboard: okRead({ refreshStatus: "running", hasData: true, startedAt: START, asOf: ASOF }),
  observations: okRead({ refreshStatus: "running", hasData: false, startedAt: START, diagnosisCode: "awaiting_callback", diagnosisAttempt: 2 }),
  nowMs: START_MS + 5 * 60000,
  formatTime: fmt,
});
check("running: refresh result waits for the current generation (no terminal claim); data fact shows the last snapshot",
  running.refreshResultLine.includes("正在等待当前代回调") && running.refreshResultLine.includes("终态尚不能确认")
  && !running.refreshResultLine.includes("超过等待窗口") && running.dataFactLine.includes("当前显示最后成功快照"));
check("running: both channels read (allRead)", running.anyRead === true && running.allRead === true);
check("running: per-channel line carries the local receipt time, session-scoped, never a server time",
  running.dashboardLine.includes("✓ 已读取") && running.dashboardLine.includes("最近读取状态：T5000")
  && running.dashboardLine.includes("仅本次会话") && running.dashboardLine.includes("非服务器更新时间"));
check("running: waited duration computed from a valid startedAt",
  running.waitedText != null && running.waitedText.includes("约 5 分钟"));
check("running: note separates reading success from refresh success and bank reconciliation",
  running.note.includes("不等于刷新成功") && running.note.includes("银行对账成功"));

// --- running with no successful data yet (first sync in flight) ---
const runningEmpty = checkProgressFeedback({
  dashboard: okRead({ refreshStatus: "running", hasData: false, startedAt: START }),
  observations: okRead({ refreshStatus: "running", hasData: false, startedAt: START, diagnosisCode: "awaiting_callback" }),
  nowMs: START_MS + 30000,
  formatTime: fmt,
});
check("running, empty: data fact says 尚无成功数据 (never claims a last-success snapshot)",
  runningEmpty.dataFactLine.includes("尚无成功数据") && !runningEmpty.dataFactLine.includes("当前显示最后成功快照"));
check("running, empty: sub-minute wait reads 不足 1 分钟",
  runningEmpty.waitedText != null && runningEmpty.waitedText.includes("不足 1 分钟"));

// --- settled success terminal ---
const settled = checkProgressFeedback({
  dashboard: okRead({ refreshStatus: "idle", hasData: true, asOf: ASOF }),
  observations: okRead({ refreshStatus: "idle", hasData: false, diagnosisCode: "settled_success", diagnosisAttempt: 3 }),
  nowMs: START_MS,
  formatTime: fmt,
});
check("success terminal: refresh result states the saved terminal; data fact names the last snapshot and its moment",
  settled.refreshResultLine.includes("已成功收尾") && settled.refreshResultLine.includes("已保存")
  && settled.dataFactLine.includes("最后成功快照") && settled.dataFactLine.includes(`快照时间 T${ASOF_MS}`));
check("success terminal: no waited text when not running", settled.waitedText === null);

// --- settled failure terminal ---
const failedTerminal = checkProgressFeedback({
  dashboard: okRead({ refreshStatus: "error", hasData: true, asOf: ASOF }),
  observations: okRead({ refreshStatus: "error", hasData: false, diagnosisCode: "settled_failure", diagnosisAttempt: 3 }),
  nowMs: START_MS,
  formatTime: fmt,
});
check("failure terminal: refresh result states the settled failure; old data kept as the data fact",
  failedTerminal.refreshResultLine.includes("已结算失败（终态）") && failedTerminal.dataFactLine.includes("当前显示最后成功快照"));

// --- all reads fail: nothing is confirmed, no receipt time stamped ---
const allFail = checkProgressFeedback({
  dashboard: failRead(), observations: failRead(), nowMs: START_MS, formatTime: fmt,
});
check("all reads fail: headline is the not-read-out wording",
  allFail.headline === "进度暂未读出，尚不能确认本次更新结果");
check("all reads fail: anyRead/allRead both false", allFail.anyRead === false && allFail.allRead === false);
check("all reads fail: both lines mark 未读出 and the receipt time NOT updated",
  allFail.dashboardLine.includes("▲ 未读出") && allFail.observationsLine.includes("▲ 未读出")
  && allFail.dashboardLine.includes("最近读取时间未更新") && !allFail.dashboardLine.includes("最近读取状态："));

// --- partial read: dashboard ok, observations failed ---
const partialObs = checkProgressFeedback({
  dashboard: okRead({ refreshStatus: "running", hasData: true, startedAt: START, asOf: ASOF }),
  observations: failRead(),
  nowMs: START_MS + 2 * 60000,
  formatTime: fmt,
});
check("partial (observations failed): channels reported separately, never merged into all-verified",
  partialObs.allRead === false && partialObs.anyRead === true
  && partialObs.dashboardLine.includes("✓ 已读取") && partialObs.observationsLine.includes("▲ 未读出")
  && partialObs.headline.includes("观测记录一路未读出"));
check("partial (observations failed): waited still computed from the dashboard read's startedAt",
  partialObs.waitedText != null && partialObs.waitedText.includes("约 2 分钟"));

// --- partial read: dashboard failed, observations ok ---
const partialDash = checkProgressFeedback({
  dashboard: failRead(),
  observations: okRead({ refreshStatus: "running", hasData: false, startedAt: START, diagnosisCode: "awaiting_callback" }),
  nowMs: START_MS + 3 * 60000,
  formatTime: fmt,
});
check("partial (dashboard failed): headline refuses to confirm the update result",
  partialDash.headline.includes("看板状态暂未读出，尚不能确认本次更新结果")
  && partialDash.headline.includes("不合成全部已核实"));
check("partial (dashboard failed): the failed channel stamps no receipt time; the ok channel keeps its own",
  !partialDash.dashboardLine.includes("最近读取状态：") && partialDash.observationsLine.includes("最近读取状态：T5000"));

// --- empty library: read ok, idle, no snapshot, no attempt ever ---
const emptyDb = checkProgressFeedback({
  dashboard: okRead({ refreshStatus: "idle", hasData: false }),
  observations: okRead({ refreshStatus: "idle", hasData: false, diagnosisCode: "no_attempt" }),
  nowMs: START_MS,
  formatTime: fmt,
});
check("empty library: refresh result says no attempt recorded; data fact says 尚无成功数据",
  emptyDb.refreshResultLine.includes("尚无刷新尝试记录") && emptyDb.dataFactLine.includes("尚无成功数据")
  && !allText(emptyDb).includes("已完成（终态）"));

// --- startedAt missing / invalid / future: no waited duration claimed ---
const noStart = checkProgressFeedback({
  dashboard: okRead({ refreshStatus: "running", startedAt: null }),
  observations: okRead({ refreshStatus: "running", hasData: false, startedAt: null, diagnosisCode: "awaiting_callback" }),
  nowMs: START_MS + 10 * 60000,
  formatTime: fmt,
});
check("missing startedAt: waitedText is null (no duration fabricated)", noStart.waitedText === null);
const badStart = checkProgressFeedback({
  dashboard: okRead({ refreshStatus: "running", startedAt: "not-a-date" }),
  observations: okRead({ refreshStatus: "running", hasData: false, startedAt: "not-a-date", diagnosisCode: "awaiting_callback" }),
  nowMs: START_MS + 10 * 60000,
  formatTime: fmt,
});
check("invalid startedAt: waitedText is null", badStart.waitedText === null);
const futureStart = checkProgressFeedback({
  dashboard: okRead({ refreshStatus: "running", startedAt: START }),
  observations: okRead({ refreshStatus: "running", hasData: false, startedAt: START, diagnosisCode: "awaiting_callback" }),
  nowMs: START_MS - 60000,
  formatTime: fmt,
});
check("future startedAt: waitedText is null (no negative wait)", futureStart.waitedText === null);

// --- (a) projection error over a still-running generation ---
// The dashboard projects "error" (stored running past the wait
// window) while the observations channel reports the RAW state
// still running, awaiting the current generation's callback.
// The feedback must never call this a failed terminal, must say
// the window was exceeded with the terminal unconfirmed, and
// must keep the waited duration.
const projectedStale = checkProgressFeedback({
  dashboard: okRead({ refreshStatus: "error", hasData: true, startedAt: START, asOf: ASOF, message: "上次更新未完成，可以重新更新" }),
  observations: okRead({ refreshStatus: "running", hasData: false, startedAt: START, diagnosisCode: "awaiting_callback", diagnosisAttempt: 4 }),
  nowMs: START_MS + 125 * 60000,
  formatTime: fmt,
});
check("(a) projected error + raw running: NO 失败（终态） anywhere in the feedback",
  !allText(projectedStale).includes("失败（终态）"));
check("(a) projected error + raw running: refresh result says 超过等待窗口，执行终态尚不能确认",
  projectedStale.refreshResultLine.includes("超过等待窗口，执行终态尚不能确认"));
check("(a) projected error + raw running: waited duration survives the projection (observations startedAt)",
  projectedStale.waitedText != null && projectedStale.waitedText.includes("约 125 分钟"));

// --- (b) corrupted saved payload projected as error ---
// Dashboard: projected "error", no data, message naming the
// saved data corrupted. Raw state still running. The refresh
// result must be the unreadable-data verdict, not a terminal.
const corruptPayload = checkProgressFeedback({
  dashboard: okRead({ refreshStatus: "error", hasData: false, startedAt: START, message: "已保存数据损坏，重新更新可恢复" }),
  observations: okRead({ refreshStatus: "running", hasData: false, startedAt: START, diagnosisCode: "awaiting_callback" }),
  nowMs: START_MS + 10 * 60000,
  formatTime: fmt,
});
check("(b) corrupted payload: refresh result says 已保存数据无法读取，不能据此判定本次尝试结果",
  corruptPayload.refreshResultLine.includes("已保存数据无法读取，不能据此判定本次尝试结果")
  && !allText(corruptPayload).includes("失败（终态）"));
check("(b) corrupted payload: data fact says the saved data is unreadable",
  corruptPayload.dataFactLine.includes("已保存数据无法读取"));

// --- (c) legacy idle with no bound generation ---
// An old snapshot plus idle reads must never be worded as a
// completed terminal when no attempt is bound to the state.
const legacyUnattributed = checkProgressFeedback({
  dashboard: okRead({ refreshStatus: "idle", hasData: true, asOf: ASOF }),
  observations: okRead({ refreshStatus: "idle", hasData: false, diagnosisCode: "unattributed_history" }),
  nowMs: START_MS,
  formatTime: fmt,
});
check("(c) legacy idle + unattributed_history: NO 已完成（终态） anywhere in the feedback",
  !allText(legacyUnattributed).includes("已完成（终态）"));
check("(c) legacy idle + unattributed_history: refresh result says 当前无进行中的刷新，最近尝试结果未证实",
  legacyUnattributed.refreshResultLine.includes("当前无进行中的刷新，最近尝试结果未证实"));
const legacyNoAttempt = checkProgressFeedback({
  dashboard: okRead({ refreshStatus: "idle", hasData: true, asOf: ASOF }),
  observations: okRead({ refreshStatus: "idle", hasData: false, diagnosisCode: "no_attempt" }),
  nowMs: START_MS,
  formatTime: fmt,
});
check("(c) legacy idle + no_attempt: NO 已完成（终态）; refresh result says 尚无刷新尝试记录",
  !allText(legacyNoAttempt).includes("已完成（终态）")
  && legacyNoAttempt.refreshResultLine.includes("尚无刷新尝试记录"));

// --- remaining diagnosis wordings (rule 2 completeness) ---
const unrecorded = checkProgressFeedback({
  dashboard: okRead({ refreshStatus: "idle", hasData: true, asOf: ASOF }),
  observations: okRead({ refreshStatus: "idle", hasData: false, diagnosisCode: "settled_success_unrecorded", diagnosisAttempt: 5 }),
  nowMs: START_MS,
  formatTime: fmt,
});
check("settled_success_unrecorded: refresh result says settled per business state, terminal event unrecorded",
  unrecorded.refreshResultLine.includes("已成功收尾") && unrecorded.refreshResultLine.includes("终态事件未记录"));
const spawnFailed = checkProgressFeedback({
  dashboard: okRead({ refreshStatus: "error", hasData: true, asOf: ASOF }),
  observations: okRead({ refreshStatus: "error", hasData: false, diagnosisCode: "spawn_failed", diagnosisAttempt: 5 }),
  nowMs: START_MS,
  formatTime: fmt,
});
check("spawn_failed: refresh result says the attempt could not start",
  spawnFailed.refreshResultLine.includes("未能启动"));
const callbackIgnored = checkProgressFeedback({
  dashboard: okRead({ refreshStatus: "running", hasData: true, startedAt: START, asOf: ASOF }),
  observations: okRead({ refreshStatus: "running", hasData: false, startedAt: START, diagnosisCode: "callback_ignored", diagnosisAttempt: 5 }),
  nowMs: START_MS + 60000,
  formatTime: fmt,
});
check("callback_ignored: refresh result says the callback arrived but was ignored",
  callbackIgnored.refreshResultLine.includes("回调已到达但被忽略"));

// --- observations channel failed: projection alone earns no terminal ---
const obsFailError = checkProgressFeedback({
  dashboard: okRead({ refreshStatus: "error", hasData: true, asOf: ASOF }),
  observations: failRead(),
  nowMs: START_MS,
  formatTime: fmt,
});
check("observations failed + projected error: refresh result refuses the failure verdict",
  obsFailError.refreshResultLine.includes("不能据此判定已失败") && !allText(obsFailError).includes("失败（终态）"));
const obsFailIdle = checkProgressFeedback({
  dashboard: okRead({ refreshStatus: "idle", hasData: true, asOf: ASOF }),
  observations: failRead(),
  nowMs: START_MS,
  formatTime: fmt,
});
check("observations failed + projected idle: refresh result says the last attempt is unverified, never completed",
  obsFailIdle.refreshResultLine.includes("最近尝试结果未证实") && !allText(obsFailIdle).includes("已完成（终态）"));
const obsFailRunning = checkProgressFeedback({
  dashboard: okRead({ refreshStatus: "running", hasData: true, startedAt: START, asOf: ASOF }),
  observations: failRead(),
  nowMs: START_MS,
  formatTime: fmt,
});
check("observations failed + projected running: refresh result says no terminal observed yet",
  obsFailRunning.refreshResultLine.includes("仍未观测到终态"));

// --- data fact layer: read-only statement rides every variant ---
check("data fact layer: every variant states the check was read-only and changed no data",
  [running, settled, allFail, partialDash, corruptPayload].every((fb) => fb.dataFactLine.includes("本次检查只读，未改变任何数据")));
check("data fact layer: a failed dashboard read confirms no data state (no snapshot claimed)",
  partialDash.dataFactLine.includes("未能确认当前数据状态") && !partialDash.dataFactLine.includes("最后成功快照"));

// --- performProgressCheck: one click = exactly two read-only refetches ---
let dashCalls = 0, obsCalls = 0;
const rawOk = { refreshStatus: "running", hasData: true, startedAt: START };
const gate = { inFlight: false };
let releaseDash;
const first = performProgressCheck({
  gate,
  readDashboard: () => { dashCalls++; return new Promise((resolve) => { releaseDash = () => resolve(rawOk); }); },
  readObservations: async () => { obsCalls++; return { refreshStatus: "running", hasData: false, startedAt: START }; },
  now: () => 777,
});
// double-click while the first check is still in flight
const second = await performProgressCheck({
  gate,
  readDashboard: async () => { dashCalls++; return rawOk; },
  readObservations: async () => { obsCalls++; return rawOk; },
  now: () => 888,
});
check("double-click: the second click is gated out (returns null)", second === null);
check("double-click: still exactly one read per channel", dashCalls === 1 && obsCalls === 1);
releaseDash();
const firstResult = await first;
check("one click: both channels settled ok with the local receipt time stamped at settle",
  firstResult != null && firstResult.dashboard.ok === true && firstResult.observations.ok === true
  && firstResult.dashboard.receivedAt === 777 && firstResult.observations.receivedAt === 777);
check("gate released after settle: a later click reads again",
  gate.inFlight === false);
const third = await performProgressCheck({
  gate,
  readDashboard: async () => { dashCalls++; return rawOk; },
  readObservations: async () => { obsCalls++; return rawOk; },
  now: () => 999,
});
check("later click: reads run again (one more per channel)", third != null && dashCalls === 2 && obsCalls === 2);

// --- performProgressCheck: a failing channel never stamps a receipt time ---
const mixed = await performProgressCheck({
  gate: { inFlight: false },
  readDashboard: async () => { throw new Error("boom"); },
  readObservations: async () => ({ refreshStatus: "idle", hasData: false, startedAt: null, diagnosisCode: "settled_success", diagnosisAttempt: 7 }),
  now: () => 4242,
});
check("channel failure: failed channel ok=false with receivedAt null; the other channel unaffected",
  mixed.dashboard.ok === false && mixed.dashboard.receivedAt === null
  && mixed.observations.ok === true && mixed.observations.receivedAt === 4242);
check("channel fields pass through settle (diagnosis code/attempt carried; absent fields default to null)",
  mixed.observations.diagnosisCode === "settled_success" && mixed.observations.diagnosisAttempt === 7
  && mixed.dashboard.message === null && mixed.dashboard.asOf === null && mixed.dashboard.diagnosisCode === null);

// --- wiring (real App.tsx source) ---
check("wiring: the 检查进度 button lives in the refresh band, read-only labelled",
  appSrc.includes('aria-label="检查进度（只读：只重新读取当前状态，不启动更新）"')
  && appSrc.includes('className="refresh-band__check-button"')
  && appSrc.includes("只读检查：只重新读取状态，不启动更新、不生成新代次"));
check("wiring: in-flight state shows 正在检查 and disables only the check button",
  appSrc.includes('{checking ? "正在检查…" : "检查进度"}') && appSrc.includes("disabled={checking}"));
check("wiring: the observations query is hoisted once (single getRefreshObservations call site)",
  (appSrc.match(/api\.getRefreshObservations/g) ?? []).length === 1
  && appSrc.includes('queryKey: ["finance-refresh-observations"]'));
check("wiring: the observations query stays owner-gated",
  appSrc.includes('enabled: dashboard.data?.access === "owner"'));
check("wiring: existing 3s auto-poll while running is unchanged on both queries",
  (appSrc.match(/=== "running" \? 3000 : false/g) ?? []).length === 2);
const handlerStart = appSrc.indexOf("const handleCheckProgress");
const handlerEnd = appSrc.indexOf("const checkFeedback", handlerStart);
const handlerSrc = appSrc.slice(handlerStart, handlerEnd);
check("wiring: the check handler refetches exactly the two read-only queries",
  handlerSrc.includes("dashboard.refetch()") && handlerSrc.includes("observations.refetch()")
  && handlerSrc.includes("performProgressCheck"));
check("wiring: the check handler performs ZERO refresh mutation (no refreshFinanceData, no mutate, no spawn)",
  !handlerSrc.includes("refreshFinanceData") && !handlerSrc.includes(".mutate") && !handlerSrc.includes("spawn"));
check("wiring: non-owner reads are treated as failed reads (no data surfaced from a denied response)",
  handlerSrc.includes('result.data.access !== "owner"'));
check("wiring: the check handler consumes the existing fields (dashboard message/asOf, observations diagnosis)",
  handlerSrc.includes("message: result.data.refresh.message") && handlerSrc.includes("asOf: result.data.data?.asOf ?? null")
  && handlerSrc.includes("diagnosisCode: result.data.diagnosis?.code ?? null")
  && handlerSrc.includes("diagnosisAttempt: result.data.diagnosis?.attempt ?? null"));
check("wiring: the band renders all three feedback layers and the honesty note via checkProgressFeedback",
  appSrc.includes("checkFeedback.dashboardLine") && appSrc.includes("checkFeedback.observationsLine")
  && appSrc.includes("checkFeedback.refreshResultLine") && appSrc.includes("checkFeedback.dataFactLine")
  && appSrc.includes("checkFeedback.note") && appSrc.includes("checkProgressFeedback({"));
check("wiring: the band's three source moments are untouched (asOf / startedAt / updatedAt keep their real fields)",
  appSrc.includes("最后成功快照时间") && appSrc.includes("formatInstant(refresh.startedAt, false)")
  && appSrc.includes("状态写入时刻：{formatInstant(refresh.updatedAt, false)}"));
check("wiring: feedback is symbol + text, never colour alone (✓/▲ markers in the produced lines)",
  running.dashboardLine.includes("✓") && allFail.dashboardLine.includes("▲"));

console.log(`validate-check-progress: ${passed}/${passed + failed} passed`);
process.exit(failed ? 1 : 0);
