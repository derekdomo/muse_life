// F1.1 validation: emergency coverage counts AVAILABLE CASH only.
// - classification (explicit cashflow_role wins; name fallback):
//   HSA / bonds / treasury / retirement (IRA, 401k, 403b, Roth,
//   pension) are non-cash, credit cards are credit, mortgage /
//   loans are debt — none of them enters the emergency numerator
//   however positive the balance is. Only role "cash" counts.
// - the numerator is a classified subset, computed server-side
//   and re-derived on the read path for legacy payloads; the
//   broader deposits fact and every original balance stay
//   untouched (net worth is unchanged by classification).
// - stale cash (explicit balance_date older than the source
//   month) and missing cash (no cash account) yield null — no
//   coverage is fabricated; a true cash 0 stays a real 0.
// - the denominator is unchanged: the last 3 valid complete
//   months with proven spend, named in usedMonthKeys.
// - the owner's account selection is an on-page trial only:
//   excluding accounts re-sums the selected original balances in
//   the client; excluding every cash account yields no coverage.
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

// the one module-level constant the extracted server functions read
const excludedDecl = src.slice(src.indexOf("const excludedLiveSources"), src.indexOf("]);", src.indexOf("const excludedLiveSources")) + 3);

const SERVER_NAMES = [
  "displayLabel", "isRealDateKey", "entriesSignature", "normalizeRawMonths",
  "resolveContribution", "cashflowRoleForEntry", "snapshotCaliber",
  "isConsecutiveMonth", "monthEnd", "normalizeBalanceDate", "isUnverifiedStatus", "entryUnverified", "effectiveFlowPeriod", "nativeDateString", "nativeBool", "amountMatches", "transactionSpendForMonth",
  "aggregateMonths", "recomputeInvestmentReturns", "computeInvestmentPerformance",
  "average", "normalizedFireSpend", "validCompleteMonths", "computeFire",
  "normalizeFireMetrics", "sourceCanUseLive", "normalizedLiveValue",
  "findPlaidAccount", "mergeLatestEntries", "cleanSecurityName",
  "normalizeHoldings", "summarizeAvailableCash", "ensureAvailableCash",
  "buildDashboard",
];
const serverApi = new Function(
  `const exports = {};\n${excludedDecl}\n${extractFns(src, SERVER_NAMES, ts.ScriptKind.TS)}; return { ${SERVER_NAMES.join(", ")} };`,
)();
const { cashflowRoleForEntry, normalizeRawMonths, buildDashboard, ensureAvailableCash } = serverApi;

const CLIENT_NAMES = ["completeSpendBasis", "emergencyCoverage", "accountCashRoleLabel"];
const clientApi = new Function(
  `const exports = {};\n${extractFns(appSrc, CLIENT_NAMES, ts.ScriptKind.TSX)}; return { ${CLIENT_NAMES.join(", ")} };`,
)();
const { completeSpendBasis, emergencyCoverage, accountCashRoleLabel } = clientApi;

// --- fixtures (synthetic) ---
const E = (financeSource, type, number, extraFields = {}) => ({ financeSource, type, number, ...extraFields });
const AS_OF = "2026-10-18T12:00:00-07:00";
function build(rawMonths) {
  const normalized = normalizeRawMonths(rawMonths);
  if (!normalized.ok) throw new Error(`fixture failed to normalize: ${normalized.issue}`);
  return buildDashboard(AS_OF, normalized.months, [], [], [], null, null);
}
const latestEntries = (entries) => build([{ key: "2026-09-30", entries }]);

// --- classification: explicit role wins, name fallback otherwise ---
check("role: explicit cash wins over a retirement-looking name",
  cashflowRoleForEntry(E("ira_1234", "account", 5, { cashflowRole: "cash" })) === "cash");
check("role: explicit non_cash wins over a bank name",
  cashflowRoleForEntry(E("bank_1234", "account", 5, { cashflowRole: "non_cash" })) === "non_cash");
check("role: HSA is non_cash", cashflowRoleForEntry(E("fidelity_hsa_1234", "account", 5000)) === "non_cash");
check("role: bonds are non_cash", cashflowRoleForEntry(E("bonds", "account", 8000)) === "non_cash");
check("role: treasury is non_cash", cashflowRoleForEntry(E("treasury_direct", "account", 8000)) === "non_cash");
check("role: IRA account is non_cash (retirement never a deposit)",
  cashflowRoleForEntry(E("fidelity_ira_1234", "account", 20000)) === "non_cash");
check("role: 401k account is non_cash", cashflowRoleForEntry(E("schwab_401k", "account", 20000)) === "non_cash");
check("role: Roth account is non_cash", cashflowRoleForEntry(E("roth_ira_5678", "account", 20000)) === "non_cash");
check("role: pension account is non_cash", cashflowRoleForEntry(E("calpers_pension", "account", 20000)) === "non_cash");
check("role: mortgage is debt", cashflowRoleForEntry(E("mortgage_9999", "account", -300000)) === "debt");
check("role: credit card is credit even with a positive balance",
  cashflowRoleForEntry(E("usbank_cc", "account", 25)) === "credit");
check("role: positive bank account is cash", cashflowRoleForEntry(E("bank_1234", "account", 1000)) === "cash");
check("role: negative bank balance falls back to debt", cashflowRoleForEntry(E("bank_1234", "account", -50)) === "debt");
check("role: investment entries are never cash-classified",
  cashflowRoleForEntry(E("broker_1234", "investment", 100000)) === null);

// --- end-to-end numerator: only cash counts, balances unrewritten ---
const mixed = latestEntries([
  E("bank_checking_1234", "account", 10000),
  E("fidelity_hsa_1234", "account", 5000),
  E("bonds", "account", 8000),
  E("fidelity_ira_1234", "account", 20000),
  E("usbank_cc", "account", -1500),
  E("mortgage_9999", "account", -300000),
  E("broker_1234", "investment", 100000),
]);
check("numerator: only the cash account counts (10000, not 43000 of positive balances)",
  mixed.live.availableCash === 10000 && mixed.live.availableCashAccountCount === 1
  && (mixed.live.availableCashStale ?? []).length === 0);
check("fact preserved: deposits still every positive account balance (net-worth composition unchanged)",
  mixed.live.deposits === 43000 && mixed.live.loans === 301500
  && mixed.live.netWorth === 100000 + 43000 - 301500);
const rowOf = (dash, source) => dash.accounts.find((a) => a.source === source);
check("balances unrewritten: excluded rows keep original values and carry their classification",
  rowOf(mixed, "fidelity_hsa_1234").value === 5000 && rowOf(mixed, "fidelity_hsa_1234").availableCash === false
  && rowOf(mixed, "fidelity_hsa_1234").cashflowRole === "non_cash"
  && rowOf(mixed, "bonds").value === 8000 && rowOf(mixed, "fidelity_ira_1234").value === 20000
  && rowOf(mixed, "usbank_cc").cashflowRole === "credit" && rowOf(mixed, "mortgage_9999").cashflowRole === "debt");
check("cash row flagged available with its role",
  rowOf(mixed, "bank_checking_1234").availableCash === true && rowOf(mixed, "bank_checking_1234").cashflowRole === "cash");

// --- true 0 vs missing vs stale ---
const trueZero = latestEntries([E("bank_1234", "account", 0), E("fidelity_hsa_1234", "account", 5000)]);
check("true 0: a cash account at exactly 0 gives amount 0, not null",
  trueZero.live.availableCash === 0 && trueZero.live.availableCashAccountCount === 1);
const missing = latestEntries([E("fidelity_hsa_1234", "account", 5000), E("bonds", "account", 8000)]);
check("missing: no cash account at all -> null (positive non-cash balances do not become cash)",
  missing.live.availableCash === null && missing.live.availableCashAccountCount === 0);
const stale = latestEntries([E("bank_1234", "account", 10000, { balanceDate: "2026-08-31" })]);
check("stale: balance_date older than the source month -> null + the source is named",
  stale.live.availableCash === null && (stale.live.availableCashStale ?? []).join() === "bank_1234"
  && stale.live.availableCashAccountCount === 1);
// F1.1 rework (PM criterion change): staleness is judged on the
// REAL balanceDate against the snapshot date — not a month-prefix
// comparison and never the refresh asOf. A same-month but older
// balance date is a real gap and is named as one.
const sameMonthOlder = latestEntries([E("bank_1234", "account", 10000, { balanceDate: "2026-09-15" })]);
check("stale (rework): same-month older balance_date (09-15 vs snapshot 09-30) is a named gap",
  sameMonthOlder.live.availableCash === null && (sameMonthOlder.live.availableCashStale ?? []).join() === "bank_1234");
const fresh = latestEntries([E("bank_1234", "account", 10000, { balanceDate: "2026-09-30" })]);
check("fresh: a balance_date equal to the snapshot date is not stale (real dates compared)",
  fresh.live.availableCash === 10000 && (fresh.live.availableCashStale ?? []).length === 0);
const monthOnlyKey = build([{ key: "2026-09", entries: [E("bank_1234", "account", 7000, { balanceDate: "2026-09-30" })] }]);
check("units/dates: YYYY-MM snapshot normalizes to month-end; a balance date at month-end stays fresh",
  monthOnlyKey.sourceMonth === "2026-09-30" && monthOnlyKey.live.availableCash === 7000);
const monthOnlyOlder = build([{ key: "2026-09", entries: [E("bank_1234", "account", 7000, { balanceDate: "2026-09-01" })] }]);
check("units/dates (rework): YYYY-MM snapshot + same-month older balance date is stale, not fresh",
  monthOnlyOlder.live.availableCash === null && (monthOnlyOlder.live.availableCashStale ?? []).join() === "bank_1234");
// F1.1 rework (exact-date binding): staleness is exact equality
// with the snapshot date — a FUTURE balance date is a gap too, an
// invalid calendar date never equals the snapshot date, and a
// YYYY-MM balance date is equivalent to that month's last day.
const futureDated = latestEntries([E("bank_1234", "account", 10000, { balanceDate: "2026-10-05" })]);
check("stale (exact): a future balance_date (10-05 vs snapshot 09-30) is a named gap",
  futureDated.live.availableCash === null && (futureDated.live.availableCashStale ?? []).join() === "bank_1234");
const invalidDated = latestEntries([E("bank_1234", "account", 10000, { balanceDate: "2026-09-31" })]);
check("stale (exact): an invalid balance_date (09-31) never equals the snapshot date",
  invalidDated.live.availableCash === null && (invalidDated.live.availableCashStale ?? []).join() === "bank_1234");
const monthDated = latestEntries([E("bank_1234", "account", 10000, { balanceDate: "2026-09" })]);
check("fresh (exact): a YYYY-MM balance_date equals the month-end snapshot date",
  monthDated.live.availableCash === 10000 && (monthDated.live.availableCashStale ?? []).length === 0);

// --- F1.1 rework: explicitly unverified cash never enters coverage ---
const unverifiedCashDash = latestEntries([
  E("bank_1234", "account", 10000, { verified: false }),
  E("fidelity_hsa_1234", "account", 5000),
]);
check("unverified: verified=false cash -> amount null, source named in availableCashUnverified (not stale)",
  unverifiedCashDash.live.availableCash === null
  && (unverifiedCashDash.live.availableCashUnverified ?? []).join() === "bank_1234"
  && (unverifiedCashDash.live.availableCashStale ?? []).length === 0
  && unverifiedCashDash.live.availableCashAccountCount === 1);
check("unverified: the balance stays a recorded fact — row value, deposits and net worth unrewritten",
  rowOf(unverifiedCashDash, "bank_1234").value === 10000
  && rowOf(unverifiedCashDash, "bank_1234").verified === false
  && unverifiedCashDash.live.deposits === 15000
  && unverifiedCashDash.live.netWorth === 15000);
const verifiedCashDash = latestEntries([E("bank_1234", "account", 10000, { verified: true })]);
check("verified: verified=true cash counts normally and the state is carried on the row",
  verifiedCashDash.live.availableCash === 10000
  && rowOf(verifiedCashDash, "bank_1234").verified === true
  && (verifiedCashDash.live.availableCashUnverified ?? []).length === 0);
const legacyCashDash = latestEntries([E("bank_1234", "account", 10000)]);
check("legacy: no verification state provided -> row carries null, legacy caliber still counts the cash",
  legacyCashDash.live.availableCash === 10000 && rowOf(legacyCashDash, "bank_1234").verified === null);
// F1.1 rework (native status): a raw status of
// carried_forward_unverified / unverified marks the cash
// unverified even with no boolean flag stored.
const statusUnverifiedDash = latestEntries([E("bank_1234", "account", 10000, { status: "carried_forward_unverified" })]);
check("unverified (status): carried_forward_unverified cash -> amount null, named unverified (not stale)",
  statusUnverifiedDash.live.availableCash === null
  && (statusUnverifiedDash.live.availableCashUnverified ?? []).join() === "bank_1234"
  && (statusUnverifiedDash.live.availableCashStale ?? []).length === 0
  && rowOf(statusUnverifiedDash, "bank_1234").status === "carried_forward_unverified");
const statusUnverified2 = latestEntries([E("bank_1234", "account", 10000, { status: "unverified" })]);
check("unverified (status): status unverified cash -> amount null, named unverified",
  statusUnverified2.live.availableCash === null
  && (statusUnverified2.live.availableCashUnverified ?? []).join() === "bank_1234");

// --- legacy read path: re-derived from preserved rows, never stored 0 ---
const legacy = {
  asOf: AS_OF,
  sourceMonth: "2026-09-30",
  months: [],
  live: { netWorth: 0, investment: 0, saving: 0, deposits: 999999, loans: 0, weeklyDelta: null, availableCash: null, availableCashStale: [], availableCashAccountCount: 0 },
  holdings: [],
  investmentPerformance: { startKey: null, endKey: null, startBalance: null, endBalance: null, netFlow: null, returnAmount: null, reason: null, monthsCovered: 0 },
  cashPosition: null,
  concentrationTop3: 0,
  accounts: [
    { source: "bank_1234", label: "Bank 1234", type: "account", value: 4000, live: false, institution: null, mask: null },
    { source: "fidelity_hsa_1234", label: "Fidelity Hsa 1234", type: "account", value: 9000, live: false, institution: null, mask: null },
  ],
  fire: { annualContribution: 0, annualSpend: 0, target: 0, progress: null, gap: 0, completeMonthsUsed: 0 },
};
const rederived = ensureAvailableCash(legacy);
check("legacy: read path re-derives the classified numerator from names + balances (4000, never the stored deposits 999999)",
  rederived.live.availableCash === 4000 && rederived.live.availableCashAccountCount === 1
  && rederived.accounts.find((a) => a.source === "fidelity_hsa_1234").availableCash === false
  && rederived.accounts.find((a) => a.source === "fidelity_hsa_1234").value === 9000);

// --- F1.1 rework: legacy rows filled from the latest month's entryMeta ---
// An old writer stored account rows WITHOUT verified / status /
// balanceDate, but the latest month's entryMeta preserved them.
// The read path fills only those explicit preserved values, so
// the archive degrades WITHOUT a refresh; values the archive
// never kept stay missing.
const metaMonth = (meta) => ({
  key: "2026-09-30", entryMeta: meta,
});
const bareRow = { source: "bank_1234", label: "Bank 1234", type: "account", value: 4000, live: false, institution: null, mask: null };
const legacyBase = (months, accounts) => ({
  asOf: AS_OF,
  sourceMonth: "2026-09-30",
  months,
  live: { netWorth: 0, investment: 0, saving: 0, deposits: 0, loans: 0, weeklyDelta: null, availableCash: 12345, availableCashStale: [], availableCashAccountCount: 0 },
  holdings: [],
  investmentPerformance: { startKey: null, endKey: null, startBalance: null, endBalance: null, netFlow: null, returnAmount: null, reason: null, monthsCovered: 0 },
  cashPosition: null,
  concentrationTop3: 0,
  accounts,
  fire: { annualContribution: 0, annualSpend: 0, target: 0, progress: null, gap: 0, completeMonthsUsed: 0 },
});
const fillVerified = ensureAvailableCash(legacyBase(
  [metaMonth([{ financeSource: "bank_1234", type: "account", cashflowRole: "cash", balanceDate: null, status: null, periodStart: null, periodEnd: null, verified: false }])],
  [{ ...bareRow }],
));
check("legacy fill: entryMeta verified=false fills the bare row -> cash null, named unverified, row shows the filled flag",
  fillVerified.live.availableCash === null
  && (fillVerified.live.availableCashUnverified ?? []).join() === "bank_1234"
  && fillVerified.accounts[0].verified === false);
const fillStatus = ensureAvailableCash(legacyBase(
  [metaMonth([{ financeSource: "bank_1234", type: "account", cashflowRole: "cash", balanceDate: null, status: "carried_forward_unverified", periodStart: null, periodEnd: null, verified: null }])],
  [{ ...bareRow }],
));
check("legacy fill: entryMeta status=carried_forward_unverified fills the bare row -> cash null, named unverified",
  fillStatus.live.availableCash === null
  && (fillStatus.live.availableCashUnverified ?? []).join() === "bank_1234"
  && fillStatus.accounts[0].status === "carried_forward_unverified");
const fillStale = ensureAvailableCash(legacyBase(
  [metaMonth([{ financeSource: "bank_1234", type: "account", cashflowRole: "cash", balanceDate: "2026-09-15", status: null, periodStart: null, periodEnd: null, verified: null }])],
  [{ ...bareRow }],
));
check("legacy fill: entryMeta balanceDate fills the bare row -> same-month older date is stale on read",
  fillStale.live.availableCash === null
  && (fillStale.live.availableCashStale ?? []).join() === "bank_1234"
  && fillStale.accounts[0].balanceDate === "2026-09-15");
const fillMissing = ensureAvailableCash(legacyBase(
  [metaMonth([{ financeSource: "bank_1234", type: "account", cashflowRole: "cash", balanceDate: null, status: null, periodStart: null, periodEnd: null, verified: null }])],
  [{ ...bareRow }],
));
check("legacy fill: values the archive never kept stay missing (cash still counts, fields stay null)",
  fillMissing.live.availableCash === 4000
  && fillMissing.accounts[0].verified === null && fillMissing.accounts[0].status === null
  && fillMissing.accounts[0].balanceDate === null);
const fillNoOverwrite = ensureAvailableCash(legacyBase(
  [metaMonth([{ financeSource: "bank_1234", type: "account", cashflowRole: "cash", balanceDate: "2026-08-31", status: null, periodStart: null, periodEnd: null, verified: false }])],
  [{ ...bareRow, verified: true, balanceDate: "2026-09-30" }],
));
check("legacy fill: a row's own explicit values are never overwritten by entryMeta",
  fillNoOverwrite.live.availableCash === 4000
  && fillNoOverwrite.accounts[0].verified === true && fillNoOverwrite.accounts[0].balanceDate === "2026-09-30");

// --- F1.1 metadata association: same snapshot, same type, unique ---
// The PM counterexample: the latest snapshot's entryMeta carries
// an INCOME entry named bank_1234 with verified=true AND the cash
// ACCOUNT entry bank_1234 with verified=false. The income entry's
// mark must never fill the cash row: the account entry's own
// explicit verified=false governs, the cash stays out of the
// numerator, named unverified.
const crossTypeMeta = ensureAvailableCash(legacyBase(
  [metaMonth([
    { financeSource: "bank_1234", type: "income", cashflowRole: null, balanceDate: null, status: null, periodStart: null, periodEnd: null, verified: true },
    { financeSource: "bank_1234", type: "account", cashflowRole: "cash", balanceDate: null, status: null, periodStart: null, periodEnd: null, verified: false },
  ])],
  [{ ...bareRow }],
));
check("association: same-named income verified=true never fills the cash account; its own verified=false is preserved",
  crossTypeMeta.accounts[0].verified === false
  && crossTypeMeta.live.availableCash === null
  && (crossTypeMeta.live.availableCashUnverified ?? []).join() === "bank_1234");
const crossTypeOnly = ensureAvailableCash(legacyBase(
  [metaMonth([
    { financeSource: "bank_1234", type: "income", cashflowRole: null, balanceDate: null, status: null, periodStart: null, periodEnd: null, verified: false },
    { financeSource: "bank_1234", type: "investment", cashflowRole: null, balanceDate: null, status: "carried_forward_unverified", periodStart: null, periodEnd: null, verified: null },
  ])],
  [{ ...bareRow }],
));
check("association: with ONLY income/investment meta for the name, nothing fills (no cross-type lending at all)",
  crossTypeOnly.accounts[0].verified === null && crossTypeOnly.accounts[0].status === null
  && crossTypeOnly.live.availableCash === 4000);
const dupAgree = ensureAvailableCash(legacyBase(
  [metaMonth([
    { financeSource: "bank_1234", type: "account", cashflowRole: "cash", balanceDate: null, status: null, periodStart: null, periodEnd: null, verified: false },
    { financeSource: "bank_1234", type: "account", cashflowRole: "cash", balanceDate: null, status: null, periodStart: null, periodEnd: null, verified: false },
  ])],
  [{ ...bareRow }],
));
check("association: duplicate account meta that AGREES fills the field (verified=false -> cash null, named)",
  dupAgree.accounts[0].verified === false && dupAgree.live.availableCash === null
  && (dupAgree.live.availableCashUnverified ?? []).join() === "bank_1234");
const dupConflict = ensureAvailableCash(legacyBase(
  [metaMonth([
    { financeSource: "bank_1234", type: "account", cashflowRole: "cash", balanceDate: "2026-09-30", status: null, periodStart: null, periodEnd: null, verified: true },
    { financeSource: "bank_1234", type: "account", cashflowRole: "cash", balanceDate: "2026-08-31", status: null, periodStart: null, periodEnd: null, verified: false },
  ])],
  [{ ...bareRow }],
));
check("association: CONFLICTING duplicate account meta fills nothing (ambiguous -> conservative, fields stay missing)",
  dupConflict.accounts[0].verified === null && dupConflict.accounts[0].balanceDate === null
  && dupConflict.live.availableCash === 4000);
const otherSnapshot = ensureAvailableCash(legacyBase(
  [
    { key: "2026-08-31", entryMeta: [{ financeSource: "bank_1234", type: "account", cashflowRole: "cash", balanceDate: null, status: null, periodStart: null, periodEnd: null, verified: false }] },
    metaMonth([]),
  ],
  [{ ...bareRow }],
));
check("association: meta from a DIFFERENT snapshot month never fills (same-snapshot binding)",
  otherSnapshot.accounts[0].verified === null && otherSnapshot.live.availableCash === 4000);
const blobInput = legacyBase(
  [metaMonth([{ financeSource: "bank_1234", type: "account", cashflowRole: "cash", balanceDate: null, status: null, periodStart: null, periodEnd: null, verified: false }])],
  [{ ...bareRow }],
);
const blobBefore = JSON.stringify(blobInput);
ensureAvailableCash(blobInput);
check("association: the read-path fill never writes back — the stored blob object is byte-identical",
  JSON.stringify(blobInput) === blobBefore && blobInput.accounts[0].verified === undefined);

// --- denominator: unchanged 3-valid-complete-month rule, months named ---
const cm = (key, spend, extra = {}) => ({
  key, spendProven: true, flexibleSpendAnomaly: false, flexibleSpend: spend, fixedSpend: 0, ...extra,
});
const basis = completeSpendBasis([
  cm("2026-05-31", 9000), cm("2026-06-30", 1000), cm("2026-07-31", 2000), cm("2026-08-31", 3000),
]);
check("denominator: last 3 of 4 valid months only, average 2000, months named",
  basis.averageMonthlySpend === 2000 && basis.usedMonths === 3 && basis.missingMonths === 0
  && basis.usedMonthKeys.join() === "2026-06,2026-07,2026-08");
const basisGaps = completeSpendBasis([
  cm("2026-06-30", 1000),
  cm("2026-07-31", null, { flexibleSpend: null }),
  cm("2026-08-31", 3000, { flexibleSpendAnomaly: true }),
]);
check("denominator: null-spend and anomalous months stay out (1 used, 2 missing), never 0-filled",
  basisGaps.usedMonths === 1 && basisGaps.missingMonths === 2 && basisGaps.averageMonthlySpend === 1000);

// --- client coverage: default, trial selection, exclude-all ---
const ACCT = (source, value, availableCash) => ({ source, type: "account", value, availableCash });
const accounts = [ACCT("cash_a", 10000, true), ACCT("cash_b", 2000, true), ACCT("hsa_x", 5000, false), ACCT("cc_x", -1500, false)];
const goodBasis = { averageMonthlySpend: 2000, usedMonths: 3, missingMonths: 0 };
const covDefault = emergencyCoverage(accounts, 12000, [], new Set(), goodBasis);
check("coverage: default uses the server classified amount (12000 / 2000 = 6 months)",
  covDefault.months === 6 && covDefault.cashAmount === 12000 && covDefault.selectedCount === 2 && covDefault.reason === null);
const covTrial = emergencyCoverage(accounts, 12000, [], new Set(["cash_b"]), goodBasis);
check("coverage: trial exclusion re-sums selected original balances (10000 / 2000 = 5)",
  covTrial.months === 5 && covTrial.cashAmount === 10000 && covTrial.selectedCount === 1);
const covExcludeAll = emergencyCoverage(accounts, 12000, [], new Set(["cash_a", "cash_b"]), goodBasis);
check("coverage: excluding every cash account yields no figure (not 0 months)",
  covExcludeAll.months === null && covExcludeAll.cashAmount === null && (covExcludeAll.reason ?? "").includes("排除全部"));
const covZero = emergencyCoverage([ACCT("cash_a", 0, true)], 0, [], new Set(), goodBasis);
check("coverage: a true cash 0 is a real 0 months, distinct from missing",
  covZero.months === 0 && covZero.cashAmount === 0 && covZero.reason === null);
const covMissing = emergencyCoverage([ACCT("hsa_x", 5000, false)], null, [], new Set(), goodBasis);
check("coverage: no cash account -> null with a missing reason",
  covMissing.months === null && (covMissing.reason ?? "").includes("没有分类为现金"));
const covStale = emergencyCoverage(accounts, null, ["cash_a"], new Set(), goodBasis);
check("coverage: stale cash -> null with the stale source named",
  covStale.months === null && (covStale.reason ?? "").includes("陈旧") && (covStale.reason ?? "").includes("cash_a"));
const covStaleExcluded = emergencyCoverage(accounts, null, ["cash_a"], new Set(["cash_a"]), goodBasis);
check("coverage: trialling away the stale account re-sums the fresh remainder (2000 / 2000 = 1)",
  covStaleExcluded.months === 1 && covStaleExcluded.cashAmount === 2000);
// --- client: unverified cash blocks coverage until trialled away ---
const ACCTV = (source, value, verified) => ({ source, type: "account", value, availableCash: true, verified });
const unverifiedAccounts = [ACCTV("cash_a", 10000, false), ACCTV("cash_b", 2000, true), ACCT("hsa_x", 5000, false)];
const covUnverified = emergencyCoverage(unverifiedAccounts, null, [], new Set(), goodBasis);
check("coverage: unverified cash in scope -> null, reason names it as 未核实 (not a generic shortage)",
  covUnverified.months === null && covUnverified.cashAmount === null
  && (covUnverified.reason ?? "").includes("未核实") && (covUnverified.reason ?? "").includes("cash_a"));
const covUnverifiedExcluded = emergencyCoverage(unverifiedAccounts, null, [], new Set(["cash_a"]), goodBasis);
check("coverage: excluding the unverified account in the page trial restores a normal figure (2000 / 2000 = 1)",
  covUnverifiedExcluded.months === 1 && covUnverifiedExcluded.cashAmount === 2000);
const covAllExcluded = emergencyCoverage(unverifiedAccounts, null, [], new Set(["cash_a", "cash_b"]), goodBasis);
check("coverage: excluding every cash account (incl. unverified) yields no figure",
  covAllExcluded.months === null && (covAllExcluded.reason ?? "").includes("排除全部"));
const legacyAccounts = [
  { source: "cash_old", type: "account", value: 4000, availableCash: true, verified: null },
  ACCTV("cash_new", 2000, true),
];
const covLegacy = emergencyCoverage(legacyAccounts, 6000, [], new Set(), goodBasis);
check("coverage: legacy unknown verification state keeps the legacy caliber (6000 / 2000 = 3)",
  covLegacy.months === 3 && covLegacy.cashAmount === 6000);
const covShortBasis = emergencyCoverage(accounts, 12000, [], new Set(), { averageMonthlySpend: 2000, usedMonths: 2, missingMonths: 1 });
check("coverage: fewer than 3 valid months -> no figure, cash amount still reported as a fact",
  covShortBasis.months === null && covShortBasis.cashAmount === 12000 && (covShortBasis.reason ?? "").includes("完整有效月不足"));
const covZeroSpend = emergencyCoverage(accounts, 12000, [], new Set(), { averageMonthlySpend: 0, usedMonths: 3, missingMonths: 0 });
check("coverage: non-positive average spend -> no figure (never infinite)",
  covZeroSpend.months === null && (covZeroSpend.reason ?? "").includes("平均支出为 0"));
check("labels: classification is text, not color alone",
  accountCashRoleLabel("cash").includes("计入") && accountCashRoleLabel("non_cash").includes("不计入")
  && accountCashRoleLabel("credit").includes("不计入") && accountCashRoleLabel(null).includes("不计入"));

// --- wiring ---
check("server: buildDashboard derives the numerator via summarizeAvailableCash",
  src.includes("availableCash: availableCashSummary.amount") && src.includes("summarizeAvailableCash(accounts, latestRaw.key)"));
check("server: read path re-derives via ensureAvailableCash in getDashboard",
  src.includes("ensureAvailableCash(normalizeFireMetrics("));
check("server: retirement patterns classified non-cash",
  src.includes("retirement|pension") && src.includes('if (/hsa/.test(name)) return "non_cash"'));
check("server: account rows carry classification + balance date (additive, legacy defaults)",
  src.includes("cashflowRole: cashflowRoleSchema.nullable().default(null)") && src.includes("availableCash: z.boolean().default(false)"));
check("client: emergency numerator is live.availableCash, never live.deposits",
  appSrc.includes("data.live.availableCash") && !appSrc.includes("live.deposits ?? 0) / spendBasis")
  && appSrc.includes("emergencyCoverage("));
check("client: scope panel states the trial is page-only and balances are untouched",
  appSrc.includes("仅本页试算") && appSrc.includes("不保存、不改动任何原始余额") && appSrc.includes("本页试算纳入可动用现金"));
check("client: coverage note names the months used and the cash amount",
  appSrc.includes("spendBasis.usedMonthKeys.join") && appSrc.includes("coverage.cashAmount"));
check("client: deposits metric replaced by the available-cash metric",
  appSrc.includes('<Metric label="可动用现金"') && appSrc.includes('label: "可动用现金（仅现金账户）"'));
check("client: stale banner agrees with the trial result (excluded stale accounts are not claimed to block coverage)",
  appSrc.includes("activeStale") && appSrc.includes("已在本页试算中排除，未计入试算金额"));
check("server: verification state is carried from entries to account rows (additive, legacy null)",
  src.includes('verified: entry.type === "account" ? entry.verified ?? null : null')
  && src.includes("verified: z.boolean().nullable().default(null)"));
check("server: raw status is carried from entries to account rows and consumed as unverified",
  src.includes('status: entry.type === "account" ? entry.status ?? null : null')
  && src.includes('status === "carried_forward_unverified"')
  && src.includes("status: z.string().nullable().default(null)"));
check("server: legacy read path fills bare rows from the SAME snapshot's entryMeta, same type (account) only",
  src.includes("month.key === dashboard.sourceMonth") && src.includes("entry.financeSource === account.source && entry.type === \"account\""));
check("server: unverified cash is named in the live summary and withheld like stale cash",
  src.includes("availableCashUnverified: summary.unverifiedSources")
  && src.includes("availableCashUnverified: availableCashSummary.unverifiedSources")
  && extractFns(src, ["summarizeAvailableCash"], ts.ScriptKind.TS).includes("entryUnverified(account)"));
check("server: staleness compares the balanceDate EXACTLY to the snapshot date via normalizeBalanceDate (future dates are gaps too; no month-prefix compare)",
  extractFns(src, ["summarizeAvailableCash"], ts.ScriptKind.TS).includes("normalizeBalanceDate(account.balanceDate) !== sourceMonth")
  && !extractFns(src, ["summarizeAvailableCash"], ts.ScriptKind.TS).includes("account.balanceDate < sourceMonth")
  && !extractFns(src, ["summarizeAvailableCash"], ts.ScriptKind.TS).includes("slice(0, 7)"));
check("client: panel shows verification as text per row and names unverified cash both ways",
  appSrc.includes("verificationText(account.verified ?? null)") && appSrc.includes("现金账户未核实")
  && appSrc.includes("未核实现金账户") && appSrc.includes("核实状态未提供"));

console.log(`validate-available-cash: ${passed}/${passed + failed} passed`);
process.exit(failed ? 1 : 0);
