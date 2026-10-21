// F0.7-OBS-001 (B-class presentation increment): the read-only
// 「检查进度」 check in RefreshStatusBand. Behaviour runs against
// the REAL production functions extracted from client/src/App.tsx
// (checkProgressFeedback + performProgressCheck, AST-transpiled);
// wiring assertions run against the real source text. Fixtures
// are synthetic values only — no real account data.
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
const FN_NAMES = ["refreshStatusText", "checkProgressFeedback", "performProgressCheck"];
const api = new Function(
  `const exports = {};\n${extractClientFns(FN_NAMES)}; return { ${FN_NAMES.join(", ")} };`,
)();
const { checkProgressFeedback, performProgressCheck } = api;

const fmt = (ms) => `T${ms}`;
const okRead = (over = {}) => ({
  ok: true, receivedAt: 5000, refreshStatus: "running", hasData: true, startedAt: null, ...over,
});
const failRead = () => ({ ok: false, receivedAt: null, refreshStatus: null, hasData: false, startedAt: null });
const START = "2026-10-20T10:00:00.000Z";
const START_MS = new Date(START).getTime();

// --- running unchanged: still no terminal state observed ---
const running = checkProgressFeedback({
  dashboard: okRead({ refreshStatus: "running", hasData: true, startedAt: START }),
  observations: okRead({ refreshStatus: "running", hasData: false, startedAt: START }),
  nowMs: START_MS + 5 * 60000,
  formatTime: fmt,
});
check("running: headline states read + no terminal state + last-success data shown",
  running.headline.includes("状态已读取，本次尝试仍未观测到终态") && running.headline.includes("当前显示上次成功数据"));
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
  observations: okRead({ refreshStatus: "running", hasData: false, startedAt: START }),
  nowMs: START_MS + 30000,
  formatTime: fmt,
});
check("running, empty: headline says 尚无成功数据 (never claims last-success data)",
  runningEmpty.headline.includes("尚无成功数据") && !runningEmpty.headline.includes("当前显示上次成功数据"));
check("running, empty: sub-minute wait reads 不足 1 分钟",
  runningEmpty.waitedText != null && runningEmpty.waitedText.includes("不足 1 分钟"));

// --- success terminal ---
const settled = checkProgressFeedback({
  dashboard: okRead({ refreshStatus: "idle", hasData: true }),
  observations: okRead({ refreshStatus: "idle", hasData: false }),
  nowMs: START_MS,
  formatTime: fmt,
});
check("success terminal: headline states the finished terminal state and the last snapshot",
  settled.headline.includes("已完成（终态）") && settled.headline.includes("最后成功快照"));
check("success terminal: no waited text when not running", settled.waitedText === null);

// --- failure terminal ---
const failedTerminal = checkProgressFeedback({
  dashboard: okRead({ refreshStatus: "error", hasData: true }),
  observations: okRead({ refreshStatus: "error", hasData: false }),
  nowMs: START_MS,
  formatTime: fmt,
});
check("failure terminal: headline states the failed terminal state, old data kept",
  failedTerminal.headline.includes("已失败（终态）") && failedTerminal.headline.includes("当前显示上次成功数据"));

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
  dashboard: okRead({ refreshStatus: "running", hasData: true, startedAt: START }),
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
  observations: okRead({ refreshStatus: "running", hasData: false, startedAt: START }),
  nowMs: START_MS + 3 * 60000,
  formatTime: fmt,
});
check("partial (dashboard failed): headline refuses to confirm the update result",
  partialDash.headline.includes("看板状态暂未读出，尚不能确认本次更新结果")
  && partialDash.headline.includes("不合成全部已核实"));
check("partial (dashboard failed): the failed channel stamps no receipt time; the ok channel keeps its own",
  !partialDash.dashboardLine.includes("最近读取状态：") && partialDash.observationsLine.includes("最近读取状态：T5000"));

// --- empty library: read ok, idle, no snapshot at all ---
const emptyDb = checkProgressFeedback({
  dashboard: okRead({ refreshStatus: "idle", hasData: false }),
  observations: okRead({ refreshStatus: "idle", hasData: false }),
  nowMs: START_MS,
  formatTime: fmt,
});
check("empty library: headline says no running update and 尚无成功数据",
  emptyDb.headline.includes("当前无进行中的更新") && emptyDb.headline.includes("尚无成功数据"));

// --- startedAt missing / invalid / future: no waited duration claimed ---
const noStart = checkProgressFeedback({
  dashboard: okRead({ refreshStatus: "running", startedAt: null }),
  observations: okRead({ refreshStatus: "running", hasData: false, startedAt: null }),
  nowMs: START_MS + 10 * 60000,
  formatTime: fmt,
});
check("missing startedAt: waitedText is null (no duration fabricated)", noStart.waitedText === null);
const badStart = checkProgressFeedback({
  dashboard: okRead({ refreshStatus: "running", startedAt: "not-a-date" }),
  observations: okRead({ refreshStatus: "running", hasData: false, startedAt: "not-a-date" }),
  nowMs: START_MS + 10 * 60000,
  formatTime: fmt,
});
check("invalid startedAt: waitedText is null", badStart.waitedText === null);
const futureStart = checkProgressFeedback({
  dashboard: okRead({ refreshStatus: "running", startedAt: START }),
  observations: okRead({ refreshStatus: "running", hasData: false, startedAt: START }),
  nowMs: START_MS - 60000,
  formatTime: fmt,
});
check("future startedAt: waitedText is null (no negative wait)", futureStart.waitedText === null);

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
  readObservations: async () => ({ refreshStatus: "idle", hasData: false, startedAt: null }),
  now: () => 4242,
});
check("channel failure: failed channel ok=false with receivedAt null; the other channel unaffected",
  mixed.dashboard.ok === false && mixed.dashboard.receivedAt === null
  && mixed.observations.ok === true && mixed.observations.receivedAt === 4242);

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
check("wiring: the band renders the per-channel feedback lines and the honesty note via checkProgressFeedback",
  appSrc.includes("checkFeedback.dashboardLine") && appSrc.includes("checkFeedback.observationsLine")
  && appSrc.includes("checkFeedback.note") && appSrc.includes("checkProgressFeedback({"));
check("wiring: the band's three source moments are untouched (asOf / startedAt / updatedAt keep their real fields)",
  appSrc.includes("最后成功快照时间") && appSrc.includes("formatInstant(refresh.startedAt, false)")
  && appSrc.includes("状态写入时刻：{formatInstant(refresh.updatedAt, false)}"));
check("wiring: feedback is symbol + text, never colour alone (✓/▲ markers in the produced lines)",
  running.dashboardLine.includes("✓") && allFail.dashboardLine.includes("▲"));

console.log(`validate-check-progress: ${passed}/${passed + failed} passed`);
process.exit(failed ? 1 : 0);
