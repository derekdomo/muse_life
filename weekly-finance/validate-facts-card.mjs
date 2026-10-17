// F0.2 (status honesty) + F2.1-D1 / F1.2 (first balance fact card)
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
function extractFn(src, name) {
  const start = src.indexOf(`export function ${name}`);
  if (start < 0) throw new Error(`helper not found: ${name}`);
  const end = src.indexOf("\n}\n", start) + 3;
  return src.slice(start, end)
    .replace("export function", "function")
    .replace("accounts: Array<{ live: boolean }>", "accounts")
    .replaceAll(": string | null", "")
    .replaceAll(": number | null", "")
    .replaceAll(": RefreshStatus", "")
    .replaceAll(": WeeklyDeltaView", "")
    .replaceAll(": boolean", "")
    .replaceAll(": string", "")
    .replaceAll(": number", "");
}
function loadHelper(name) {
  const text = extractFn(appSrc, name);
  return new Function(`${text}; return ${name};`)();
}
const statusPillText = loadHelper("statusPillText");
const emptyFooterText = loadHelper("emptyFooterText");
const safeRefreshMessage = loadHelper("safeRefreshMessage");
const weeklyDeltaView = loadHelper("weeklyDeltaView");
const balanceSourceSummary = loadHelper("balanceSourceSummary");

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
check("server: prior read through parseDashboardPayload (corrupt prior -> null delta)", serverSrc.includes("if (prior.ok) previousLiveNetWorth = prior.data.live.netWorth"));
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
check("card never claims a fixed week", !/一周|7 天|七天|每周/.test(cardSrc));
check("card makes no attribution claim", !/市场|投入|消费/.test(cardSrc));
check("hero delta label matches the card wording", appSrc.includes("较上次成功快照") && !appSrc.includes("较上次周更"));
check("no stale 等待第二次周更 copy remains", !appSrc.includes("等待第二次周更"));

// --- source summary: asOf/sourceMonth are distinct fields; missing -> 未提供 ---
check("source summary: empty accounts -> 未提供", balanceSourceSummary([]) === "未提供");
check("source summary: mixed live/fallback counts", balanceSourceSummary([{ live: true }, { live: true }, { live: false }]) === "2 个账户为本周实时余额，1 个账户沿用月度快照值");
check("source summary: all live", balanceSourceSummary([{ live: true }]) === "全部 1 个账户为本周实时余额");
check("source summary: all snapshot", balanceSourceSummary([{ live: false }, { live: false }]) === "全部 2 个账户沿用月度快照值");

console.log(`validate-facts-card: ${passed}/${passed + failed} passed`);
process.exit(failed ? 1 : 0);
