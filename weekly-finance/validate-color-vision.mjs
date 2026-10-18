// F-UI-001 validation: color-vision redundant channels for the weekly
// finance overview. Direction must never ride on color alone — every
// up/down value also carries a glyph (▲/▼/—) and, where the value is a
// delta, a direction word; neutral amounts (monthly spend, loans) must
// not use the negative/red channel to carry meaning; the positive /
// negative palette is Okabe-Ito. Behaviour runs against the real
// trendIndicator extracted from client/src/App.tsx; wiring assertions
// run against the real client + theme sources. All fixtures synthetic.
import { readFileSync } from "node:fs";

const app = readFileSync(new URL("./client/src/App.tsx", import.meta.url), "utf8");
const css = readFileSync(new URL("./client/src/theme.css", import.meta.url), "utf8");
let passed = 0, failed = 0;
function check(name, cond) {
  if (cond) { passed++; } else { failed++; console.log("FAIL:", name); }
}

// --- extract the real trendIndicator ---
const start = app.indexOf("export function trendIndicator");
if (start < 0) throw new Error("trendIndicator not found");
const end = app.indexOf("\n}\n", start) + 3;
const fnSrc = app.slice(start, end)
  .replace("export function trendIndicator(value: number | null): string", "function trendIndicator(value)");
const trendIndicator = new Function(`${fnSrc}; return trendIndicator;`)();

check("positive value -> ▲", trendIndicator(1) === "▲" && trendIndicator(0.5) === "▲");
check("negative value -> ▼", trendIndicator(-1) === "▼" && trendIndicator(-0.5) === "▼");
check("zero -> — (flat, not up/down)", trendIndicator(0) === "—");
check("null -> — (no fabricated direction)", trendIndicator(null) === "—");
// mutation sensitivity: a sign-flipped implementation must fail above
const flipped = (v) => (v == null || v === 0 ? "—" : v > 0 ? "▼" : "▲");
check("mutation: flipped glyphs differ from the real function",
  flipped(1) !== trendIndicator(1) && flipped(-1) !== trendIndicator(-1));

// --- Okabe-Ito palette ---
check("theme: --positive is Okabe-Ito bluish green #009E73", css.includes("--positive: #009E73;"));
check("theme: --negative is Okabe-Ito vermillion #D55E00", css.includes("--negative: #D55E00;"));
check("theme: old red/green pair is gone",
  !css.includes("--positive: #147457;") && !css.includes("--negative: #c84c54;"));

// --- redundant channels at every color-carried delta ---
check("hero delta carries glyph + direction word",
  app.includes("{trendIndicator(data.live.weeklyDelta)} {signedCurrency(data.live.weeklyDelta)}")
  && app.includes("deltaView.direction ? <span>{deltaView.direction}</span> : null"));
check("snapshot compare delta carries glyph",
  app.includes("`${trendIndicator(monthDelta)} ${signedCurrency(monthDelta)} 环比`"));
check("balance fact card carries glyph (direction word already present)",
  app.includes("<strong>{trendIndicator(delta)} {signedCurrency(delta)}</strong>"));
check("savings rate carries glyph",
  app.includes("<>{trendIndicator(savingsRate)} {percent.format(savingsRate)}</>"));

// --- neutral amounts no longer borrow the negative channel ---
check("monthly spend metric has no negative tone",
  app.includes('<Metric label="月支出" value={current.totalSpend == null ? "—" : <span title={currency.format(current.totalSpend)}>{compactCurrency.format(current.totalSpend)}</span>} note='));
check("loans metric has no negative tone",
  app.includes('<Metric label="贷款" value={<span title={currency.format(data.live.loans ?? 0)}>{compactCurrency.format(data.live.loans ?? 0)}</span>} note='));
check("distribution loans row is muted, not danger",
  app.includes('{ label: "贷款", value: live.loans ?? 0, tone: "muted" as const }')
  && !app.includes('{ label: "贷款", value: live.loans ?? 0, tone: "danger" as const }'));
check("account loan row: neutral class, minus sign and 负债 text label",
  app.includes('isLoan ? " · 负债" : ""')
  && app.includes('<b className="neutral">{isLoan ? `−${currencyPrecise.format(Math.abs(account.value))}`')
  && !app.includes('className={isLoan ? "negative" : "neutral"}'));

console.log(`validate-color-vision: ${passed}/${passed + failed} passed`);
process.exit(failed ? 1 : 0);
