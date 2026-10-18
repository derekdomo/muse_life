// F2.3 validation: from Top-10-only display to a fully queryable
// holdings set.
// - the Top 10 stays a concise summary, but the payload now
//   persists the bounded FULL normalized set: same ticker merged
//   across accounts (institutions kept on the row), the long tail
//   beyond rank 10 retained, cash listed separately per currency.
// - the concentration denominator is FIXED: shares and the Top-3
//   concentration divide by every valid non-cash holding — never
//   by the Top-10 subset, and the read path never recomputes them
//   from the stored summary rows. Client search only filters the
//   visible rows; it cannot move the denominator.
// - missing price / negative / zero / unknown-currency / non-USD
//   rows are preserved as 待核对 with a reason — never dropped,
//   never absolved, never defaulted to USD positive holdings.
// - legacy payloads (Top 10 only) keep their ingest-time
//   full-set shares and concentration untouched; their long tail
//   is unrecoverable and the UI says so instead of recomputing.
// - holdings detail never feeds account balances or the F1.6
//   reconciliation (covered by validate-investment-performance).
// Behaviour runs against the REAL production functions extracted
// from server/src/actions.ts and client/src/App.tsx via the
// TypeScript AST (transpiled per function); wiring assertions run
// against the real source text. All fixtures are synthetic.
import { readFileSync } from "node:fs";
import ts from "typescript";

const src = readFileSync(new URL("./server/src/actions.ts", import.meta.url), "utf8");
const appSrc = readFileSync(new URL("./client/src/App.tsx", import.meta.url), "utf8");
let passed = 0, failed = 0;
function check(name, cond) {
  if (cond) { passed++; } else { failed++; console.log("FAIL:", name); }
}
const approx = (a, b) => Math.abs(a - b) < 1e-9;

function extractFns(source, names, kind) {
  const sourceFile = ts.createSourceFile("f.ts", source, ts.ScriptTarget.ES2022, true, kind);
  const found = new Map();
  for (const node of sourceFile.statements) {
    if (ts.isFunctionDeclaration(node) && node.name && names.includes(node.name.text)) {
      found.set(node.name.text, ts.transpileModule(node.getText(sourceFile), {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.Preserve },
      }).outputText);
    }
  }
  for (const name of names) if (!found.has(name)) throw new Error(`function not found: ${name}`);
  return names.map((name) => found.get(name)).join("\n");
}

const SERVER_NAMES = ["cleanSecurityName", "normalizeHoldings", "ensureHoldingsConsistency"];
const serverApi = new Function(
  `const exports = {};\n${extractFns(src, SERVER_NAMES, ts.ScriptKind.TS)}; return { ${SERVER_NAMES.join(", ")} };`,
)();
const { normalizeHoldings, ensureHoldingsConsistency } = serverApi;

const clientApi = new Function(
  `const exports = {};\n${extractFns(appSrc, ["filterHoldings"], ts.ScriptKind.TSX)}; return { filterHoldings };`,
)();
const { filterHoldings } = clientApi;

// --- fixtures (synthetic) ---
const H = (ticker, name, value, extra = {}) => ({ ticker, name, value, currency: "USD", institution: null, ...extra });

// --- 1. long tail: 12 valid holdings, fixed full denominator ---
{
  const inputs = [];
  for (let i = 0; i < 12; i++) inputs.push(H(`TK${i + 1}`, `Fund ${i + 1}`, 1200 - i * 100));
  const r = normalizeHoldings(inputs);
  const fullTotal = inputs.reduce((sum, item) => sum + item.value, 0); // 7800
  check("tail: full set keeps all 12", r.allHoldings.length === 12);
  check("tail: summary still Top 10", r.holdings.length === 10);
  check("tail: denominator is the full sum", r.holdingsTotal === fullTotal);
  check("tail: rank-12 row retained with full-denominator share",
    r.allHoldings[11].ticker === "TK12" && approx(r.allHoldings[11].share, 100 / fullTotal));
  check("tail: summary share uses full denominator, not the Top-10 sum",
    approx(r.holdings[0].share, 1200 / fullTotal) && !approx(r.holdings[0].share, 1200 / 7500));
  check("tail: Top-3 concentration uses the fixed denominator",
    approx(r.concentrationTop3, (1200 + 1100 + 1000) / fullTotal));
  check("tail: no cash, no unclassified", r.cashPosition === null && r.cashHoldings.length === 0 && r.unclassifiedHoldings.length === 0);
  check("tail: not truncated", r.truncated === false);
}

// --- 2. same ticker merged across accounts/institutions ---
{
  const r = normalizeHoldings([
    H("AAPL", "Apple Inc", 300, { institution: "Fidelity" }),
    H("MSFT", "Microsoft", 500, { institution: "Fidelity" }),
    H("AAPL", "Apple Inc", 200, { institution: "Robinhood" }),
  ]);
  check("merge: duplicate ticker becomes one row", r.allHoldings.length === 2);
  const aapl = r.allHoldings.find((row) => row.ticker === "AAPL");
  check("merge: values summed", aapl.value === 500);
  check("merge: institutions union kept as a fact", aapl.institutions.join("|") === "Fidelity|Robinhood");
  check("merge: denominator and share after merge", r.holdingsTotal === 1000 && approx(aapl.share, 0.5));
}

// --- 3. multiple cash classes, listed separately ---
{
  const r = normalizeHoldings([
    H("CUR:USD", "U.S. Dollar", 1000),
    H("CUR:USD", "U.S. Dollar", 500),
    H("CUR:EUR", "Euro", 800, { currency: "EUR" }),
    H("VOO", "Vanguard S&P 500 ETF", 2000),
  ]);
  check("cash: rows listed separately per currency", r.cashHoldings.length === 2);
  const usd = r.cashHoldings.find((row) => row.ticker === "CUR:USD");
  const eur = r.cashHoldings.find((row) => row.ticker === "CUR:EUR");
  check("cash: same-currency cash merged", usd.value === 1500 && usd.currency === "USD");
  check("cash: EUR cash keeps its own currency label", eur.value === 800 && eur.currency === "EUR");
  check("cash: cashPosition is the USD total only", r.cashPosition === 1500);
  check("cash: cash never enters holdings or the denominator",
    r.allHoldings.length === 1 && r.holdingsTotal === 2000 && approx(r.concentrationTop3, 1));
}

// --- 4. unclassified: missing / negative / zero / currency ---
{
  const r = normalizeHoldings([
    H("VOO", "Vanguard S&P 500 ETF", 1000),
    H("NOPRICE", "No Price Co", null),
    H("SHORTX", "Short Co", -250),
    H("ZEROX", "Zero Co", 0),
    H("EURSTK", "Euro Stock", 900, { currency: "EUR" }),
    H("NOCUR", "No Currency Co", 700, { currency: null }),
  ]);
  check("unclassified: only the valid row enters the set", r.allHoldings.length === 1 && r.holdingsTotal === 1000);
  check("unclassified: all five problem rows preserved", r.unclassifiedHoldings.length === 5);
  const byTicker = new Map(r.unclassifiedHoldings.map((row) => [row.ticker, row]));
  check("unclassified: missing price kept as null with reason",
    byTicker.get("NOPRICE").value === null && byTicker.get("NOPRICE").reason.includes("缺少市值"));
  check("unclassified: negative position keeps its sign and reason",
    byTicker.get("SHORTX").value === -250 && byTicker.get("SHORTX").reason.includes("负头寸"));
  check("unclassified: zero value named", byTicker.get("ZEROX").reason.includes("市值为 0"));
  check("unclassified: non-USD currency named, not merged",
    byTicker.get("EURSTK").currency === "EUR" && byTicker.get("EURSTK").reason.includes("EUR"));
  check("unclassified: unknown currency not defaulted to USD",
    byTicker.get("NOCUR").currency === null && byTicker.get("NOCUR").reason.includes("币种不明"));
  check("unclassified: none of them leak into summary or full set",
    !r.holdings.some((row) => byTicker.has(row.ticker)) && !r.allHoldings.some((row) => byTicker.has(row.ticker)));
}

// --- 5. empty and cash-only inputs ---
{
  const empty = normalizeHoldings([]);
  check("empty: everything empty, no fabricated denominator",
    empty.holdings.length === 0 && empty.allHoldings.length === 0 && empty.cashPosition === null
    && empty.holdingsTotal === null && empty.concentrationTop3 === 0 && empty.truncated === false);
  const cashOnly = normalizeHoldings([H("CUR:USD", "U.S. Dollar", 300)]);
  check("cash-only: no denominator, cash still listed",
    cashOnly.holdingsTotal === null && cashOnly.allHoldings.length === 0 && cashOnly.cashPosition === 300);
}

// --- 6. bounded set: overflow keeps the denominator whole ---
{
  const inputs = [];
  for (let i = 0; i < 501; i++) inputs.push(H(`B${i}`, `Bound ${i}`, i + 1));
  const r = normalizeHoldings(inputs);
  const fullTotal = (501 * 502) / 2;
  check("bound: stored set capped at 500 with the flag set", r.allHoldings.length === 500 && r.truncated === true);
  check("bound: denominator still covers every valid holding", r.holdingsTotal === fullTotal);
  check("bound: largest holding kept, smallest dropped from storage only",
    r.allHoldings[0].value === 501 && !r.allHoldings.some((row) => row.value === 1));
}

// --- 7. read path: stored full-set figures are never recomputed ---
{
  // Legacy payload written by the old ingest: shares/concentration
  // were computed against a full denominator of 2000 (CCC 200 and
  // the tail are not in the stored Top 10).
  const legacy = {
    holdings: [
      { ticker: "AAA", name: "Aaa", value: 500, share: 0.25 },
      { ticker: "BBB", name: "Bbb", value: 300, share: 0.15 },
    ],
    holdingsAll: [],
    cashPosition: null,
    concentrationTop3: 0.5,
  };
  const out = ensureHoldingsConsistency(legacy);
  check("legacy: stored shares preserved exactly", out.holdings[0].share === 0.25 && out.holdings[1].share === 0.15);
  check("legacy: stored concentration preserved, not recomputed from Top 10",
    out.concentrationTop3 === 0.5 && out.concentrationTop3 !== 1);
  // Ancient payload with cash still inside the holdings list.
  const ancient = {
    holdings: [
      { ticker: "CUR:USD", name: "U.S. Dollar", value: 700, share: 0 },
      { ticker: "AAA", name: "Aaa", value: 500, share: 0.25 },
    ],
    holdingsAll: [],
    cashPosition: null,
    concentrationTop3: 0.5,
  };
  const repaired = ensureHoldingsConsistency(ancient);
  check("ancient: CUR:USD folded out of holdings into separate cash",
    repaired.holdings.length === 1 && repaired.holdings[0].ticker === "AAA" && repaired.cashPosition === 700);
  check("ancient: surviving share and concentration still untouched",
    repaired.holdings[0].share === 0.25 && repaired.concentrationTop3 === 0.5);
}

// --- 8. client search: filtering never moves the denominator ---
{
  const rows = [
    { ticker: "VOO", name: "Vanguard S&P 500 ETF", value: 500, share: 0.5 },
    { ticker: "QQQ", name: "Invesco QQQ Trust", value: 300, share: 0.3 },
    { ticker: "BND", name: "Vanguard Total Bond", value: 200, share: 0.2 },
  ];
  check("search: empty query returns everything", filterHoldings(rows, "  ").length === 3);
  check("search: matches ticker case-insensitively", filterHoldings(rows, "voo").map((r) => r.ticker).join() === "VOO");
  check("search: matches name", filterHoldings(rows, "bond").map((r) => r.ticker).join() === "BND");
  const filtered = filterHoldings(rows, "qqq");
  check("search: filtered rows keep their stored shares verbatim",
    filtered.length === 1 && filtered[0].share === 0.3);
  check("search: no match yields an empty list, not a recomputation", filterHoldings(rows, "zzz").length === 0);
}

// --- 9. wiring (real source text) ---
check("schema: full set persisted with legacy defaults",
  src.includes("holdingsAll: z.array(holdingDetailSchema).default([])")
  && src.includes("holdingsTotal: z.number().nullable().default(null)")
  && src.includes("holdingsComplete: z.boolean().default(false)"));
check("schema: cash and unclassified lists are separate fields",
  src.includes("holdingsCash: z.array(cashHoldingSchema).default([])")
  && src.includes("holdingsUnclassified: z.array(unclassifiedHoldingSchema).default([])"));
check("ingest: missing price and currency are representable",
  src.includes("value: z.number().nullable()") && src.includes("currency: z.string().max(12).nullable().optional()"));
check("build: fresh payloads mark the full set complete",
  src.includes("holdingsComplete: true") && src.includes("holdingsAll: normalized.allHoldings"));
check("read path: consistency fn replaced the Top-10 recomputation",
  src.includes("ensureHoldingsConsistency(parsed.data)") && !src.includes("ensureSeparatedCashPosition"));
check("read path: consistency fn never assigns concentration or shares",
  !extractFns(src, ["ensureHoldingsConsistency"], ts.ScriptKind.TS).includes("concentrationTop3:")
  && !extractFns(src, ["ensureHoldingsConsistency"], ts.ScriptKind.TS).includes("share:"));
check("refresh prompt: full holdings with currency, no pre-truncation",
  src.includes("iso_currency_code") && src.includes("不得默认填 USD") && src.includes("holdings:[{ticker,name,value,currency,institution}]"));
check("UI: explorer is read-only with search and fixed denominator copy",
  appSrc.includes("查看全部持仓") && appSrc.includes("filterHoldings(all, query)")
  && appSrc.includes("搜索全部持仓（代码或名称）") && appSrc.includes("搜索只筛选显示，不改变分母与占比"));
check("UI: coverage line shows date, institutions and denominator",
  appSrc.includes("覆盖机构") && appSrc.includes("分母：全部有效持仓市值") && appSrc.includes("数据日期"));
check("UI: unclassified and cash are labelled as outside the denominator",
  appSrc.includes("待核对（未计入分母）") && appSrc.includes("不计入持仓分母与集中度"));
check("UI: legacy cache states the long tail is unrecoverable, no Top-10 recomputation",
  appSrc.includes("不可恢复") && appSrc.includes("不以 Top 10 重算"));
check("UI: holdings detail never added to account balances",
  appSrc.includes("持仓明细与投资账户余额是两个口径，不叠加"));

console.log(`validate-holdings: ${passed}/${passed + failed} passed`);
process.exit(failed ? 1 : 0);
