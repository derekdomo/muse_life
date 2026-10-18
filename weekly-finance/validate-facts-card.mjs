// F0.2 (status honesty) + F2.1-D1 (balance fact card source summary,
// balance rows only) + F1.1/F0.4 (complete-month spend basis)
// validation. Behaviour runs against the real pure helpers extracted
// from client/src/App.tsx (type annotations stripped mechanically);
// wiring assertions run against the real source text of App.tsx and
// server/src/actions.ts. Fixtures are synthetic values only.
import { readFileSync } from "node:fs";

const appSrc = readFileSync(new URL("./client/src/App.tsx", import.meta.url), "utf8");
const serverSrc = readFileSync(new URL("./server/src/actions.ts", import.meta.url), "utf8");
let passed = 0, failed = 0;
function check(name, cond) {
  if (cond) { passed++; } else { failed++; console.log("FAIL:", name); }
}

// --- extract the real exported helpers from App.tsx ---
function extractFn(src, name, specific = []) {
  const start = src.indexOf(`export function ${name}`);
  if (start < 0) throw new Error(`helper not found: ${name}`);
  const end = src.indexOf("\n}\n", start) + 3;
  let text = src.slice(start, end).replace("export function", "function");
  for (const [from, to] of specific) text = text.replace(from, to);
  return text
    .replaceAll(": string | null", "")
    .replaceAll(": number | null", "")
    .replaceAll(": RefreshStatus", "")
    .replaceAll(": WeeklyDeltaView", "")
    .replaceAll(": boolean", "")
    .replaceAll(": string", "")
    .replaceAll(": number", "");
}
function loadHelper(name, specific) {
  const text = extractFn(appSrc, name, specific);
  return new Function(`${text}; return ${name};`)();
}
const statusPillText = loadHelper("statusPillText");
const emptyFooterText = loadHelper("emptyFooterText");
const safeRefreshMessage = loadHelper("safeRefreshMessage");
const weeklyDeltaView = loadHelper("weeklyDeltaView");
const balanceSourceSummary = loadHelper("balanceSourceSummary", [
  ["accounts: Array<{ type: string; live: boolean }>", "accounts"],
]);
const completeSpendBasis = loadHelper("completeSpendBasis", [
  ["months: Month[]", "months"],
  [": { averageMonthlySpend: number | null; usedMonths: number; missingMonths: number; usedMonthKeys: string[] }", ""],
]);
const integrityLabel = loadHelper("integrityLabel", [
  ['integrity: Month["integrity"]', "integrity"],
]);

// --- F0.2: four states, status pill ---
check("state a (never synced): pill 等待首次同步", statusPillText(false, "idle") === "等待首次同步");
check("state b (data, ok): pill 数据已同步", statusPillText(true, "idle") === "数据已同步");
check("state c (data, error): pill 显示上次数据", statusPillText(true, "error") === "显示上次数据");
check("state d (no data, error): pill 数据暂不可用", statusPillText(false, "error") === "数据暂不可用");
check("running with data: pill 正在更新", statusPillText(true, "running") === "正在更新");
check("running without data: pill 正在更新", statusPillText(false, "running") === "正在更新");

// --- F0.2: four states, footer first line ---
check("state a footer: 尚未完成首次更新", emptyFooterText("idle") === "尚未完成首次更新");
const footerD = emptyFooterText("error");
check("state d footer: 数据暂不可用 wording", footerD.includes("数据暂不可用"));
check("state d footer: no 显示上次数据", !footerD.includes("显示上次数据"));
check("state d footer: no 首次", !footerD.includes("首次"));
check("running footer: still 尚未完成首次更新", emptyFooterText("running") === "尚未完成首次更新");

// --- F0.2: safe message gating ---
check("state d shows the safe corrupt message", safeRefreshMessage("已保存数据损坏，重新更新可恢复", false) === "已保存数据损坏，重新更新可恢复");
check("state d hides a 显示上次数据 claim", safeRefreshMessage("本次更新失败，显示上次数据", false) === null);
check("state d hides a 首次 claim", safeRefreshMessage("尚未完成首次更新", false) === null);
check("state c keeps the refresh message", safeRefreshMessage("本次更新失败，显示上次数据", true) === "本次更新失败，显示上次数据");
check("null message stays null", safeRefreshMessage(null, false) === null && safeRefreshMessage(null, true) === null);
// mutation sensitivity: without the hasData gate the misleading claim leaks
const leakyMessage = (m, hasData) => (m ? m : null);
check("mutation: ungated message leaks the false claim in state d", leakyMessage("本次更新失败，显示上次数据", false) !== null);

// --- F0.2 wiring (real App.tsx) ---
check("pill rendered via statusPillText", appSrc.includes("statusPillText(response?.data != null, status)"));
check("footer rendered via emptyFooterText", appSrc.includes("emptyFooterText(status)"));
check("corrupt empty state offers 重新更新", appSrc.includes('"重新更新"'));
check("first-sync empty state keeps 开始首次同步", appSrc.includes('"开始首次同步"'));
check("corrupt empty state explains 数据暂不可用", appSrc.includes("数据暂不可用：已保存的数据当前无法读取"));
check("no-data error branch precedes the first-sync branch", appSrc.indexOf('status === "error" ? (') > appSrc.indexOf("DashboardView data={response.data}") && appSrc.indexOf('status === "error" ? (') < appSrc.indexOf("开始首次同步"));
check("refresh button present in all states", appSrc.includes('aria-label="立即更新财务数据"'));
check("old unconditional 显示上次数据 pill is gone", !appSrc.includes('status === "error" ? "显示上次数据" : response?.data'));

// --- F2.1-D1 / F1.2: delta view behaviour ---
const pos = weeklyDeltaView(5000, 1005000);
check("positive delta: comparable + 增加", pos.comparable === true && pos.direction === "增加");
check("positive delta: percent vs prior snapshot", Math.abs(pos.percent - 5000 / 1000000) < 1e-12);
const neg = weeklyDeltaView(-2500, 997500);
check("negative delta: comparable + 减少", neg.comparable === true && neg.direction === "减少");
check("negative delta: percent vs prior snapshot", Math.abs(neg.percent - (-2500 / 1000000)) < 1e-12);
const zero = weeklyDeltaView(0, 1000000);
check("real zero delta: comparable + 持平 (not the null state)", zero.comparable === true && zero.direction === "持平");
check("real zero delta: percent is a real 0", zero.percent === 0);
const none = weeklyDeltaView(null, 1000000);
check("null delta: not comparable, no direction, no percent", none.comparable === false && none.direction === null && none.percent === null);
check("null delta never reads as 持平", none.direction !== "持平");
const zeroPrior = weeklyDeltaView(100, 100);
check("zero prior snapshot: percent null instead of Infinity", zeroPrior.comparable === true && zeroPrior.percent === null);
// mutation sensitivity: treating null as 0 would fake a 持平 reading
const nullAsZero = (d, nw) => weeklyDeltaView(d ?? 0, nw);
check("mutation: null-as-zero would fake 持平, real view does not", nullAsZero(null, 1000000).direction === "持平" && weeklyDeltaView(null, 1000000).direction === null);

// --- server wiring: one delta source, honest prior handling ---
check("server: weeklyDelta derived from previousLiveNetWorth", serverSrc.includes("weeklyDelta: previousLiveNetWorth == null ? null : liveNetWorth - previousLiveNetWorth"));
check("server: prior read through parseDashboardPayload (corrupt prior -> null delta)",
  serverSrc.includes("latestPayloadAsOf = prior.data.asOf") && serverSrc.includes("previousLiveNetWorth = prior.data.live.netWorth"));
check("server: two consecutive legal syncs chain the prior", (serverSrc.match(/previousLiveNetWorth/g) ?? []).length >= 4);

// --- F2.1-D1 wiring: card and hero share the same view of the same field ---
check("fact card component exists", appSrc.includes("function BalanceDeltaCard"));
check("card reads live.weeklyDelta via weeklyDeltaView", appSrc.includes("weeklyDeltaView(delta, data.live.netWorth)"));
check("hero reads the same field via weeklyDeltaView", appSrc.includes("weeklyDeltaView(data.live.weeklyDelta, data.live.netWorth)"));
const cardStart = appSrc.indexOf("function BalanceDeltaCard");
const cardEnd = appSrc.indexOf("\n}\n", cardStart) + 3;
const cardSrc = appSrc.slice(cardStart, cardEnd);
check("card title is 本次余额差", cardSrc.includes("本次余额差"));
check("card subtitle: 较上次成功快照（日期未留存）", cardSrc.includes("较上次成功快照（日期未留存）"));
check("card null state: 暂无可比快照", cardSrc.includes("暂无可比快照"));
check("card stale marker: 本次未更新", cardSrc.includes("本次未更新"));
check("card source line shows asOf date", cardSrc.includes("数据日期 {asOfText}"));
check("card source line shows sourceMonth separately", cardSrc.includes("月度快照 {data.sourceMonth}"));
check("card source line uses balanceSourceSummary(data.accounts)", cardSrc.includes("balanceSourceSummary(data.accounts)"));
check("card never claims a fixed week", !/一周|7 天|七天|每周/.test(cardSrc));
check("card makes no attribution claim", !/市场|投入|消费/.test(cardSrc));
check("hero delta label matches the card wording", appSrc.includes("较上次成功快照") && !appSrc.includes("较上次周更"));
check("no stale 等待第二次周更 copy remains", !appSrc.includes("等待第二次周更"));

// --- F2.1-D1: source summary counts balance rows only ---
const bal = (type, live) => ({ type, live });
check("summary: empty accounts -> 未提供", balanceSourceSummary([]) === "未提供");
check("summary: income only, no balance rows -> 未提供", balanceSourceSummary([bal("income", true), bal("income", false)]) === "未提供");
check("summary: pure balance, all live", balanceSourceSummary([bal("investment", true), bal("account", true)]) === "全部 2 个余额账户为同步读取值");
check("summary: pure balance, all snapshot", balanceSourceSummary([bal("account", false), bal("account", false)]) === "全部 2 个余额账户沿用月度快照值");
check("summary: pure balance, mixed", balanceSourceSummary([bal("investment", true), bal("account", true), bal("account", false)]) === "2 个余额账户为同步读取值，1 个余额账户沿用月度快照值");
// the reported bug: one live balance row plus non-balance rows was
// summarised as "1 live account, 2 snapshot accounts"
const bugCase = [bal("investment", true), bal("income", false), bal("fixed_spend", false)];
check("summary: reported bug case counts only the balance row", balanceSourceSummary(bugCase) === "全部 1 个余额账户为同步读取值");
// inserting arbitrary non-balance entries never changes the summary
const nonBalance = [bal("income", true), bal("fixed_spend", false), bal("transfer", true), bal("investment_contribution", false)];
for (const [name, base] of [
  ["all live", [bal("investment", true)]],
  ["all snapshot", [bal("account", false)]],
  ["mixed", [bal("investment", true), bal("account", false)]],
  ["none", []],
]) {
  check(`summary: non-balance entries do not change the ${name} summary`,
    balanceSourceSummary([...base, ...nonBalance]) === balanceSourceSummary(base));
}
check("summary: never claims 本周实时 from the live flag", !balanceSourceSummary([bal("account", true)]).includes("本周"));
check("summary: account rows use 同步读取 wording", appSrc.includes('account.live ? "同步读取" : "月度快照"'));
check("summary: account rows no longer claim 本周实时", !appSrc.includes('account.live ? "本周实时"'));
// mutation sensitivity: the old all-rows counter miscounts the bug case
const oldSummary = (accounts) => {
  const liveCount = accounts.filter((a) => a.live).length;
  return `${liveCount}/${accounts.length}`;
};
check("mutation: unfiltered counting changes the bug-case result", oldSummary(bugCase) !== "1/1" && balanceSourceSummary(bugCase).startsWith("全部 1 个"));

// --- F1.1 / F0.4: spend-proven month basis (per-metric provenance) ---
// F1.1 consumes ONLY the spend basis: a month counts when spendProven is
// true and it is not anomalous — regardless of income/contribution
// provenance or the joint integrity label.
const cm = (integrity, anomaly, fixedSpend, flexibleSpend = 0, spendProven = integrity === "complete") => ({
  integrity, flexibleSpendAnomaly: anomaly, fixedSpend, flexibleSpend, spendProven,
});
const basis3 = completeSpendBasis([cm("complete", false, 3000), cm("complete", false, 3600), cm("complete", false, 4200)]);
check("F1.1: 3 spend-proven months average", basis3.usedMonths === 3 && basis3.missingMonths === 0 && basis3.averageMonthlySpend === 3600);
const basisMixed = completeSpendBasis([
  cm("complete", false, 3000), cm("complete", true, 9000), cm("unknown", false, 9000),
  cm("partial", false, 9000), cm("complete", false, 5000),
]);
check("F1.1: anomaly/unproven excluded from the denominator", basisMixed.usedMonths === 2 && basisMixed.missingMonths === 1);
check("F1.1: average uses valid months only", basisMixed.averageMonthlySpend === 4000);
const basisSpendOnly = completeSpendBasis([
  cm("unknown", false, 2000, 0, true), cm("unknown", false, 4000, 0, true), cm("unknown", false, 6000, 0, true),
]);
check("F1.1: spend-proven month counts even when income/contribution unproven (integrity unknown)",
  basisSpendOnly.usedMonths === 3 && basisSpendOnly.averageMonthlySpend === 4000);
const basisCompleteNoSpend = completeSpendBasis([cm("complete", false, 9000, 0, false)]);
check("F1.1: integrity complete without spendProven does not count",
  basisCompleteNoSpend.usedMonths === 0 && basisCompleteNoSpend.averageMonthlySpend === null);
const basisNone = completeSpendBasis([cm("unknown", false, 3000), cm("partial", false, 3000)]);
check("F1.1: no valid months -> average null, never 0-filled", basisNone.averageMonthlySpend === null && basisNone.usedMonths === 0 && basisNone.missingMonths === 3);
const basisMany = completeSpendBasis([1000, 2000, 3000, 4000, 5000].map((v) => cm("complete", false, v)));
check("F1.1: only the last 3 valid months are used", basisMany.averageMonthlySpend === 4000 && basisMany.usedMonths === 3);
const basisZero = completeSpendBasis([cm("complete", false, 0), cm("complete", false, 0), cm("complete", false, 0)]);
check("F1.1: real zero spend stays a real 0 (distinct from missing)", basisZero.averageMonthlySpend === 0 && basisZero.missingMonths === 0);
check("F1.1: emergency metric wired to completeSpendBasis", appSrc.includes("completeSpendBasis(data.months)") && appSrc.includes("完整有效月不足：已有"));
check("F1.1: negative flexible spend clamped in the basis", completeSpendBasis([cm("complete", false, 1000, -400)]).averageMonthlySpend === 1000);

// --- F0.4: integrity labels are text, not colour-only ---
check("label: complete -> 完整", integrityLabel("complete") === "完整");
check("label: partial -> 部分", integrityLabel("partial") === "部分");
check("label: unknown -> 完整性未提供", integrityLabel("unknown") === "完整性未提供");
check("monthly records section rendered", appSrc.includes("function MonthlyRecords") && appSrc.includes("<MonthlyRecords months={data.months} />"));
check("monthly row shows 截至 date + integrity label", appSrc.includes("截至 {snapshotDate} · {integrityLabel(month.integrity)}"));
check("monthly detail shows superseded count", appSrc.includes("month.supersededSnapshots"));
check("monthly detail shows integrity basis / anomaly reason", appSrc.includes("month.integrityBasis") && appSrc.includes("month.anomalyReason"));
check("FIRE gap state gated on completeMonthsUsed", appSrc.includes("data.fire.completeMonthsUsed === 0"));
check("FIRE trajectory (F1.6 rework): points use the month's investment balance, never net worth",
  appSrc.includes("(month.investment / target) * 100") && !appSrc.includes("(month.total / target)"));

// --- F0.5/F0.7: refresh status band + month availability + source ledger ---
// Behaviour runs against the REAL client helpers (AST-extracted,
// transpiled); wiring assertions run against the real source text.
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
const BAND_NAMES = ["refreshStatusSymbol", "refreshStatusText", "nextRefreshActionText", "monthAvailabilityFacts", "sourceLedgerRows", "balanceSourceSummary"];
const bandApi = new Function(
  `const exports = {};\nconst currency = { format: (v) => "$" + v };\nconst dateLabel = { format: (d) => d.toISOString().slice(0, 10) };\n${extractClientFns(BAND_NAMES)}; return { ${BAND_NAMES.join(", ")} };`,
)();
const { refreshStatusSymbol, refreshStatusText, nextRefreshActionText, monthAvailabilityFacts, sourceLedgerRows } = bandApi;
check("band: status carries a symbol AND text per state (never color alone)",
  refreshStatusSymbol("running") === "↻" && refreshStatusText("running", true) === "正在更新"
  && refreshStatusSymbol("error") === "▲" && refreshStatusText("error", true).includes("上次成功数据")
  && refreshStatusSymbol("idle") === "✓" && refreshStatusText("idle", true) === "已同步"
  && refreshStatusText("error", false).includes("暂无可用数据") && refreshStatusText("idle", false) === "等待首次同步");
check("band: next action is state-bound (running waits, error retries with old data kept)",
  nextRefreshActionText("running", true).includes("不要重复启动")
  && nextRefreshActionText("error", true).includes("重试") && nextRefreshActionText("error", true).includes("旧数据保留")
  && nextRefreshActionText("idle", true).includes("立即更新"));
const bandMonth = (key, integrity, extra = {}) => ({
  key, snapshotDate: key, integrity, integrityBasis: null, spendProven: false, ...extra,
});
const NOW = new Date(2026, 9, 18); // 2026-10-18 local
const factsUnverified = monthAvailabilityFacts([
  bandMonth("2026-08-31", "unknown"), bandMonth("2026-09-30", "unknown"),
], NOW);
check("band facts: previous complete month present but unverified reads 未核实 (not inferred complete from asOf)",
  factsUnverified[0].label === "上一完整月" && factsUnverified[0].text.includes("2026-09") && factsUnverified[0].text.includes("未核实"));
check("band facts: current month without a snapshot is stated as not yet obtained",
  factsUnverified[1].label === "当月" && factsUnverified[1].text.includes("尚无快照"));
check("band facts: unverified history months are named with their month keys",
  factsUnverified[2].label === "历史月份" && factsUnverified[2].text.includes("未核实") && factsUnverified[2].text.includes("2026-08"));
const factsMissing = monthAvailabilityFacts([bandMonth("2026-10-15", "partial")], NOW);
check("band facts: a missing previous complete month reads 缺失； the in-progress current month shows its as-of date",
  factsMissing[0].text.includes("缺失") && factsMissing[1].text.includes("仅进行中") && factsMissing[1].text.includes("2026-10-15"));
const factsComplete = monthAvailabilityFacts([
  bandMonth("2026-08-31", "complete"), bandMonth("2026-09-30", "complete"), bandMonth("2026-10-15", "partial"),
], NOW);
check("band facts: a proven previous month reads 已齐备 and verified history is stated as such",
  factsComplete[0].text.includes("已齐备") && factsComplete[2].text.includes("均已核实"));
check("band facts: no months at all is an honest single fact",
  monthAvailabilityFacts([], NOW).length === 1 && monthAvailabilityFacts([], NOW)[0].text.includes("尚无月度记录"));
const ledgerData = {
  asOf: "2026-10-17T12:00:00-07:00",
  sourceMonth: "2026-09-30",
  months: [bandMonth("2026-08-31", "unknown"), bandMonth("2026-09-30", "unknown", { spendProven: true })],
  accounts: [
    { type: "account", live: true }, { type: "income", live: false },
  ],
  holdings: [{ ticker: "VOO" }],
  holdingsAll: [],
  holdingsTotal: null,
  holdingsComplete: false,
};
const ledgerRunning = sourceLedgerRows(ledgerData, { status: "running" });
check("ledger: four rows in the F0.5 order （本地月度记录 / 银行余额 / 交易 / 持仓）",
  ledgerRunning.map((row) => row.source).join(",") === "本地月度记录,银行余额,交易,持仓");
check("ledger: monthly row states the snapshot date and the obtained range",
  ledgerRunning[0].dataDate === "2026-09-30" && ledgerRunning[0].range.includes("2026-08-31 至 2026-09-30") && ledgerRunning[0].range.includes("共 2 份"));
check("ledger: while running, results say 尚未落盘 — never 数据已更新",
  ledgerRunning.every((row) => row.result.includes("尚未落盘") || row.result.includes("未知"))
  && !ledgerRunning.some((row) => row.result.includes("已更新")));
check("ledger: balance range counts balance rows only (the income row is not coverage)",
  ledgerRunning[1].range.includes("全部 1 个余额账户为同步读取值"));
check("ledger: transactions carry no platform timestamp — data date and result are 未知， range cites per-month spend provenance",
  ledgerRunning[2].dataDate === "未知" && ledgerRunning[2].result.includes("未知") && ledgerRunning[2].range.includes("2026-09"));
check("ledger: a legacy holdings cache states Top-10-only honestly",
  ledgerRunning[3].range.includes("仅 Top 10 摘要"));
const ledgerError = sourceLedgerRows(ledgerData, { status: "error" });
check("ledger: a failed attempt writes nothing and keeps the old data (result text)",
  ledgerError[0].result.includes("未写入新数据") && ledgerError[0].result.includes("保留上次成功数据"));
const ledgerIdle = sourceLedgerRows(ledgerData, { status: "idle" });
check("ledger: an idle (saved) state states the saved range as the displayed range",
  ledgerIdle[0].result.includes("已落盘保存"));
const ledgerEmpty = sourceLedgerRows(null, { status: "idle" });
check("ledger: no data -> every source date is 未知 and range 未取得 (nothing fabricated)",
  ledgerEmpty.every((row) => row.dataDate === "未知" && row.range === "未取得"));
check("band wiring: rendered only after the access check, fed the sanitized message",
  appSrc.includes("!guestDenied && response") && appSrc.includes("<RefreshStatusBand") && appSrc.includes("message={visibleMessage}"));
check("band wiring: the running copy is explicit （正在更新，当前显示上次成功数据）",
  appSrc.includes("正在更新，当前显示上次成功数据"));
check("band wiring: updatedAt is labelled 状态写入时刻， never a heartbeat or data date",
  appSrc.includes("状态写入时刻") && !appSrc.includes("心跳"));
check("band wiring: last-success date and attempt start are separate fields",
  appSrc.includes("最后成功数据日期") && appSrc.includes("本次尝试开始") && appSrc.includes("最近一次尝试开始")
  && appSrc.includes("formatInstant(refresh.startedAt, false)"));
check("band wiring: server stamps and returns the attempt start (startedAt), distinct from updatedAt",
  serverSrc.includes("startedAt: new Date()") && serverSrc.includes("startedAt: state?.startedAt?.toISOString() ?? null"));

console.log(`validate-facts-card: ${passed}/${passed + failed} passed`);
process.exit(failed ? 1 : 0);
