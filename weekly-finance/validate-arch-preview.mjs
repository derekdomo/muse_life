// ARCH-DEMO-001 validation: F-ARCH-001 synthetic spend preview
// （三场景 × 双日期）. Runs the REAL production pure function
// buildArchDemoPreview extracted from client/src/App.tsx (the
// ARCH-DEMO-MODEL block) plus wiring assertions against the real
// client + theme sources, in the same style as
// validate-color-vision.mjs. All expectations are the synthetic
// ledger's fixed values — no production data involved.
import { readFileSync } from "node:fs";

const app = readFileSync(new URL("./client/src/App.tsx", import.meta.url), "utf8");
const css = readFileSync(new URL("./client/src/theme.css", import.meta.url), "utf8");
let passed = 0, failed = 0;
function check(name, cond) {
  if (cond) { passed++; } else { failed++; console.log("FAIL:", name); }
}
function sameArray(a, b) {
  return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => v === b[i]);
}

// --- extract the real model block ---
const begin = app.indexOf("// ARCH-DEMO-MODEL-BEGIN");
const end = app.indexOf("// ARCH-DEMO-MODEL-END");
if (begin < 0 || end < 0 || end <= begin) throw new Error("ARCH-DEMO-MODEL markers not found");
const block = app.slice(begin, end);
const jsSrc = block
  .replaceAll("export ", "")
  .replaceAll(": ArchDemoTransaction[]", "")
  .replaceAll(": ArchDemoBaselineMonth[]", "")
  .replaceAll(": ArchDemoBaselineMonth", "")
  .replaceAll(": ArchDemoDayFact[]", "")
  .replaceAll(": ArchDemoLedgerRow[]", "")
  .replaceAll(": ArchDemoAnomaly", "")
  .replaceAll(": ArchDemoPreview", "")
  .replaceAll(": ArchDemoScenario", "")
  .replaceAll(": ArchDemoAsOf", "")
  .replaceAll(": number | null", "")
  .replaceAll(": string | null", "")
  .replaceAll(": number[]", "")
  .replaceAll(": string[]", "")
  .replaceAll(": number", "")
  .replaceAll(": string", "")
  .replaceAll(": boolean", "");
const { buildArchDemoPreview, ARCH_DEMO_LEDGER } = new Function(
  `"use strict";\n${jsSrc}; return { buildArchDemoPreview, ARCH_DEMO_LEDGER };`,
)();

check("extracted buildArchDemoPreview is a function", typeof buildArchDemoPreview === "function");
check("synthetic ledger has exactly the 3 specified rows",
  ARCH_DEMO_LEDGER.length === 3
  && ARCH_DEMO_LEDGER[0].id === "SYN-settled" && ARCH_DEMO_LEDGER[0].date === "2026-10-05"
  && ARCH_DEMO_LEDGER[0].status === "posted" && ARCH_DEMO_LEDGER[0].amount === 100
  && ARCH_DEMO_LEDGER[1].id === "SYN-p" && ARCH_DEMO_LEDGER[1].date === "2026-10-01"
  && ARCH_DEMO_LEDGER[1].status === "pending" && ARCH_DEMO_LEDGER[1].amount === 40
  && ARCH_DEMO_LEDGER[2].id === "SYN-p" && ARCH_DEMO_LEDGER[2].date === "2026-10-20"
  && ARCH_DEMO_LEDGER[2].status === "posted" && ARCH_DEMO_LEDGER[2].amount === 40);
check("synthetic ledger is frozen (array and rows)",
  Object.isFrozen(ARCH_DEMO_LEDGER) && ARCH_DEMO_LEDGER.every((row) => Object.isFrozen(row)));
check("model block touches no production channel",
  !block.includes("api.") && !block.includes("getDashboard") && !block.includes("archDailySpend") && !block.includes("archNetWorth"));

const ledgerSnapshot = JSON.stringify(ARCH_DEMO_LEDGER);
const SCENARIOS = ["complete", "history-unknown", "current-unknown"];
const AS_OF = ["2026-10-15", "2026-10-23"];
const EXPECTED = {
  "2026-10-15": { occurred: 100, pending: 40, cumulative: 100, days: 15 },
  "2026-10-23": { occurred: 140, pending: 0, cumulative: 140, days: 23 },
};

// --- 3 scenarios × 2 dates: headline numbers are scenario-invariant ---
for (const scenario of SCENARIOS) {
  for (const asOf of AS_OF) {
    const m = buildArchDemoPreview(scenario, asOf);
    const exp = EXPECTED[asOf];
    check(`${scenario} @ ${asOf}: occurred ${exp.occurred}`, m.occurred === exp.occurred);
    check(`${scenario} @ ${asOf}: pending ${exp.pending}`, m.pending === exp.pending);
    check(`${scenario} @ ${asOf}: cumulative ${exp.cumulative}`, m.cumulative === exp.cumulative);
    check(`${scenario} @ ${asOf}: cumulative equals occurred`, m.cumulative === m.occurred);
    check(`${scenario} @ ${asOf}: daily facts truncated to ${exp.days} days`, m.dailyFacts.length === exp.days);
    check(`${scenario} @ ${asOf}: daily facts sum to cumulative`,
      m.dailyFacts.reduce((s, f) => s + f.amount, 0) === m.cumulative);
    check(`${scenario} @ ${asOf}: echoes scenario and as-of`, m.scenario === scenario && m.asOfDate === asOf);
  }
}

// --- daily facts shape (complete scenario) ---
{
  const m15 = buildArchDemoPreview("complete", "2026-10-15");
  check("10-15 facts: day 5 is 100", m15.dailyFacts[4].amount === 100 && m15.dailyFacts[4].date === "2026-10-05");
  check("10-15 facts: every other day is a covered real 0",
    m15.dailyFacts.every((f, i) => i === 4 || (f.amount === 0 && f.realZero === true && f.coverage === "covered")));
  check("10-15 facts: day 1 (pending day) is real 0, pending stays off the daily facts",
    m15.dailyFacts[0].amount === 0 && m15.dailyFacts[0].realZero === true);
  const m23 = buildArchDemoPreview("complete", "2026-10-23");
  check("10-23 facts: day 5 is 100, day 20 is 40",
    m23.dailyFacts[4].amount === 100 && m23.dailyFacts[19].amount === 40 && m23.dailyFacts[19].date === "2026-10-20");
  check("10-23 facts: remaining days are covered real 0",
    m23.dailyFacts.every((f, i) => i === 4 || i === 19 || (f.amount === 0 && f.realZero === true)));
}

// --- SYN-p lifecycle attribution at both dates ---
for (const scenario of SCENARIOS) {
  const m15 = buildArchDemoPreview(scenario, "2026-10-15");
  const p15 = m15.transactions.find((t) => t.id === "SYN-p");
  check(`${scenario} @ 10-15: SYN-p sits in pending`, p15.bucket === "pending" && p15.amount === 40);
  check(`${scenario} @ 10-15: SYN-p status note says not yet occurred`, p15.statusNote === "尚未转入已发生");
  const m23 = buildArchDemoPreview(scenario, "2026-10-23");
  const p23 = m23.transactions.find((t) => t.id === "SYN-p");
  check(`${scenario} @ 10-23: SYN-p has moved into occurred`, p23.bucket === "occurred" && p23.amount === 40);
  check(`${scenario} @ 10-23: SYN-p status note says moved into occurred`, p23.statusNote === "已转入已发生");
  for (const [label, p] of [["10-15", p15], ["10-23", p23]]) {
    check(`${scenario} @ ${label}: SYN-p lifecycle is the two specified rows`,
      p.lifecycle.length === 2
      && p.lifecycle[0].date === "2026-10-01" && p.lifecycle[0].status === "pending" && p.lifecycle[0].amount === 40
      && p.lifecycle[1].date === "2026-10-20" && p.lifecycle[1].status === "posted" && p.lifecycle[1].amount === 40);
    check(`${scenario} @ ${label}: SYN-p lifecycle note is the exact same-transaction wording`,
      p.lifecycleNote === "同一笔交易：10-01 待入账 → 10-20 转入已发生");
  }
  const settled15 = m15.transactions.find((t) => t.id === "SYN-settled");
  const settled23 = m23.transactions.find((t) => t.id === "SYN-settled");
  check(`${scenario}: SYN-settled is occurred 100 at both dates`,
    settled15.bucket === "occurred" && settled15.amount === 100 && settled23.bucket === "occurred" && settled23.amount === 100);
  check(`${scenario}: exactly the two synthetic transactions`, m23.transactions.length === 2);
}

// --- baseline months: same shape as October, real month lengths ---
for (const scenario of SCENARIOS) {
  const m = buildArchDemoPreview(scenario, "2026-10-23");
  check(`${scenario}: baseline months are 2026-07/08/09`,
    sameArray(m.baselineMonths.map((b) => b.month), ["2026-07", "2026-08", "2026-09"]));
  check(`${scenario}: baseline day counts follow real month lengths 31/31/30`,
    sameArray(m.baselineMonths.map((b) => b.dailyFacts.length), [31, 31, 30]));
  check(`${scenario}: every baseline month has day5=100, day20=40, rest real 0 (when covered)`,
    m.baselineMonths.every((b) => b.dailyFacts.every((f) => {
      const want = f.day === 5 ? 100 : f.day === 20 ? 40 : 0;
      return f.amount === want && (b.coverage !== "covered" || f.realZero === (want === 0));
    })));
}

// --- anomaly card: complete scenario adopts all three months ---
for (const asOf of AS_OF) {
  const m = buildArchDemoPreview("complete", asOf);
  check(`complete @ ${asOf}: anomaly adopts 2026-07/08/09`,
    sameArray(m.anomaly.adoptedMonths, ["2026-07", "2026-08", "2026-09"]));
  check(`complete @ ${asOf}: adopted-months note is the exact full-coverage wording`,
    m.anomaly.adoptedMonthsNote === "2026-07／08／09（覆盖完整）");
  check(`complete @ ${asOf}: comparison type is mid-month progress`, m.anomaly.comparisonType === "月中进度");
  check(`complete @ ${asOf}: candidate verdict rendered (synthetic progress matches baseline -> within)`,
    m.anomaly.verdict === "within-candidate" && m.anomaly.reason === null);
  check(`complete @ ${asOf}: candidate deviations are 0 against the same-shape baseline`,
    m.anomaly.absoluteDeviation === 0 && m.anomaly.relativeDeviation === 0 && m.anomaly.baselineDailyMedian === 0);
  check(`complete @ ${asOf}: no stored-subtotal flag`, m.storedSubtotal === false && m.currentCoverage === "covered");
}

// --- anomaly card: history-unknown drops September, no conclusion ---
for (const asOf of AS_OF) {
  const m = buildArchDemoPreview("history-unknown", asOf);
  check(`history-unknown @ ${asOf}: verdict is insufficient-evidence`, m.anomaly.verdict === "insufficient");
  check(`history-unknown @ ${asOf}: reason names September coverage unknown`,
    m.anomaly.reason === "依据不足：9 月覆盖未知" && m.anomaly.verdictText.includes("9 月覆盖未知"));
  check(`history-unknown @ ${asOf}: adopted months are only 2026-07/08`,
    sameArray(m.anomaly.adoptedMonths, ["2026-07", "2026-08"]));
  check(`history-unknown @ ${asOf}: no normal/abnormal conclusion is shown`,
    m.anomaly.comparisonType === null && !m.anomaly.verdictText.includes("未超出") && !m.anomaly.verdictText.includes("超出候选口径（"));
  check(`history-unknown @ ${asOf}: only September coverage is unknown`,
    m.baselineMonths[0].coverage === "covered" && m.baselineMonths[1].coverage === "covered"
    && m.baselineMonths[2].coverage === "unknown" && m.currentCoverage === "covered");
  check(`history-unknown @ ${asOf}: amounts unchanged, no stored-subtotal flag`,
    m.occurred === EXPECTED[asOf].occurred && m.storedSubtotal === false);
}

// --- anomaly card + spend card: current-unknown keeps stored amounts ---
for (const asOf of AS_OF) {
  const m = buildArchDemoPreview("current-unknown", asOf);
  check(`current-unknown @ ${asOf}: stored-subtotal flag set, current coverage unknown`,
    m.storedSubtotal === true && m.currentCoverage === "unknown");
  check(`current-unknown @ ${asOf}: stored amounts kept (never zero-filled)`,
    m.occurred === EXPECTED[asOf].occurred && m.pending === EXPECTED[asOf].pending && m.cumulative === EXPECTED[asOf].cumulative);
  check(`current-unknown @ ${asOf}: anomaly verdict is insufficient-evidence`,
    m.anomaly.verdict === "insufficient" && m.anomaly.comparisonType === null
    && m.anomaly.reason != null && m.anomaly.reason.includes("当前覆盖未知"));
  check(`current-unknown @ ${asOf}: daily facts carry stored amounts marked coverage-unknown, never realZero`,
    m.dailyFacts.every((f) => f.coverage === "unknown" && f.realZero === false)
    && m.dailyFacts[4].amount === 100);
  check(`current-unknown @ ${asOf}: history baseline stays fully covered`,
    m.baselineMonths.every((b) => b.coverage === "covered")
    && sameArray(m.anomaly.adoptedMonths, ["2026-07", "2026-08", "2026-09"]));
}

// --- candidate caliber note is resident in every scenario/date ---
for (const scenario of SCENARIOS) {
  for (const asOf of AS_OF) {
    const m = buildArchDemoPreview(scenario, asOf);
    check(`${scenario} @ ${asOf}: caliber note is the exact resident line`,
      m.anomaly.caliberNote === "候选口径（未定案）：相对偏差 >30% 且绝对偏差 > 日中位数×7；不作生产告警");
  }
}

// --- the model never mutates the ledger and returns fresh objects ---
{
  const first = buildArchDemoPreview("complete", "2026-10-23");
  first.dailyFacts[0].amount = 9999;
  first.baselineMonths[0].dailyFacts[0].amount = 9999;
  const second = buildArchDemoPreview("complete", "2026-10-23");
  check("mutating a returned model does not leak into the next call",
    second.dailyFacts[0].amount === 0 && second.baselineMonths[0].dailyFacts[0].amount === 0);
  check("ledger constant is byte-identical after the whole 3x2 matrix",
    JSON.stringify(ARCH_DEMO_LEDGER) === ledgerSnapshot);
}

// --- wiring: fold placement, badge, controls, net-worth note ---
check("detail tab mounts the demo section", app.includes("<ArchDemoPreviewSection foldHint={foldHint} />"));
check("demo fold is a fold-system member with its own stable data marker",
  app.includes('<details className="evidence-fold" data-arch-demo="spend-preview">')
  && (app.match(/data-arch-demo="spend-preview"/g) ?? []).length === 1);
check("demo detection is decoupled from the Calendar component (anchored on the model + the fold marker)",
  (() => {
    const start = app.indexOf("function ArchDemoPreviewSection");
    const slice = app.slice(start, app.indexOf("\n}\n", start) + 3);
    return start > -1 && slice.includes("buildArchDemoPreview(scenario, asOfDate)") && !slice.includes("SpendCalendar") && !slice.includes("archDailySpend");
  })());
check("fold title is exact", app.includes("合成预览 · 花销演示（F-ARCH-001）"));
check("synthetic badge text is present", app.includes("合成数据 · 非生产"));
check("component renders only the pure model", app.includes("const model = buildArchDemoPreview(scenario, asOfDate);"));
check("scenario switch keeps three labelled options",
  app.includes('label: "记录齐全"') && app.includes('label: "历史覆盖未知"') && app.includes('label: "当前覆盖未知"'));
check("as-of switch keeps both dates",
  app.includes('label: "截至 2026-10-15"') && app.includes('label: "截至 2026-10-23"'));
check("scenario switch resets expanded rows", app.includes("setExpandedTxn(null);"));
check("spend card rows keep their fixed labels",
  app.includes("已发生 spend") && app.includes("待入账交易（未计入已发生）") && app.includes("逐日累计（截至所选日）"));
check("stored-subtotal label is wired to the model flag",
  app.includes("model.storedSubtotal ? <span className=\"arch-demo-subtotal\">已存小计</span> : null"));
check("demo is never dressed up as a full-history balance rebuild",
  app.includes("不构成全账户历史余额重建"));
check("net-worth isolation note is the exact line",
  app.includes("净资产卡不受本演示控件影响，仍显示自身最新已知值与两层日期。"));
check("four tabs unchanged (overview / fire / detail / trading)",
  (app.match(/role="tab"/g) ?? []).length === 4
  && app.includes(">总览</button>") && app.includes(">FIRE</button>") && app.includes(">明细</button>") && app.includes(">交易</button>"));
check("default tab is still overview", app.includes('useState<"overview" | "fire" | "detail" | "trading">("overview")'));
check("demo controls meet the 44px touch target",
  css.includes(".arch-demo-switch button") && css.includes(".arch-demo-txn__toggle") && css.includes("min-height: 44px"));
check("demo controls have a visible focus outline",
  css.includes(".arch-demo-switch button:focus-visible, .arch-demo-txn__toggle:focus-visible"));

console.log(`validate-arch-preview: ${passed}/${passed + failed} passed`);
process.exit(failed ? 1 : 0);
