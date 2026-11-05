// F0.5 本体（服务端四源台账） validation: drives the REAL
// production pure module (server/src/sourceLedger.ts — zero
// imports, every export exercised below) over fully synthetic
// fixtures, drives the REAL getDashboard handler over an
// in-memory database built from the app's own migrations
// (legal save -> read-back, failure-keeps-old, guest denied),
// checks the source wiring (server field, client render-only,
// CSS), and runs five source mutations that are really
// executed and must flip behaviour. No real financial data:
// every source name, date and amount below is synthetic.
// Run: bun validate-source-ledger.mjs
import { readFileSync, readdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { Database } from "bun:sqlite";

const APP_DIR = new URL(".", import.meta.url).pathname;
const mod = await import(join(APP_DIR, "server/src/sourceLedger.ts"));
const {
  buildSourceLedger,
  bankDateCoverage,
  balanceCoverageText,
  transactionDegradations,
  sourceAttemptFor,
  isRealDateText,
  isLegalBalanceDateText,
  datePartOfInstant,
  lastSuccessInstant,
  sourceSuccessInstant,
  accountUnverified,
  formatLedgerAmount,
  SOURCE_LEDGER_ORDER,
  TRANSACTIONS_ATTEMPT_TEXT,
} = mod;

let passed = 0, failed = 0;
function check(name, cond) {
  if (cond) { passed++; } else { failed++; console.log("FAIL:", name); }
}
const rowOf = (ledger, key) => ledger.rows.find((row) => row.key === key);
const factFields = (row) => JSON.stringify({
  evidence: row.evidence, evidenceText: row.evidenceText, dataDate: row.dataDate,
  coverage: row.coverage, lastSuccessAt: row.lastSuccessAt, degraded: row.degraded,
});
const month = (key, extra = {}) => ({
  key, integrity: "complete", spendProven: true, incomeProven: true, contributionProven: true, ...extra,
});
const acct = (extra = {}) => ({ type: "account", live: true, balanceDate: "2099-09-30", value: 100, ...extra });

// ---------- strict date rules ----------
check("date rule: real dates pass (leap day, year boundary)",
  isRealDateText("2024-02-29") === true && isRealDateText("2099-12-31") === true && isRealDateText("2099-01-01") === true);
check("date rule: illegal month/day and bad formats fail",
  isRealDateText("2023-02-29") === false && isRealDateText("2099-13-01") === false
  && isRealDateText("2099-02-30") === false && isRealDateText("2099-9-3") === false && isRealDateText("nonsense") === false);
check("balance-date rule: legal YYYY-MM and real dates are evidence",
  isLegalBalanceDateText("2099-09") === true && isLegalBalanceDateText("2099-09-30") === true);
check("balance-date rule: illegal months, illegal days, empty and missing are NOT evidence",
  isLegalBalanceDateText("2099-13") === false && isLegalBalanceDateText("2099-14") === false
  && isLegalBalanceDateText("2099-00") === false && isLegalBalanceDateText("2099-02-30") === false
  && isLegalBalanceDateText("") === false && isLegalBalanceDateText(null) === false && isLegalBalanceDateText(undefined) === false);
check("instant rule: a valid ISO instant yields its date part; an invalid asOf yields null success time",
  datePartOfInstant("2099-10-18T12:00:00-07:00") === "2099-10-18"
  && lastSuccessInstant("2099-10-18T12:00:00-07:00") === "2099-10-18T12:00:00-07:00"
  && lastSuccessInstant("2099-13-40T00:00:00Z") === null && lastSuccessInstant("not-a-date") === null
  && lastSuccessInstant(null) === null && lastSuccessInstant("") === null);
check("amount format: en-US currency, null-safe",
  formatLedgerAmount(1000) === "$1,000.00" && formatLedgerAmount(null) === null && formatLedgerAmount(Number.NaN) === null);

// ---------- empty store: nothing may claim success ----------
{
  const empty = buildSourceLedger(null, "idle");
  check("empty: four rows in the fixed F0.5 order",
    empty.rows.map((row) => row.key).join(",") === SOURCE_LEDGER_ORDER.join(",")
    && empty.rows.map((row) => row.label).join(",") === "本地月度记录,银行余额,交易,持仓");
  check("empty: no success evidence, dates unknown, coverage not obtained, last success null",
    empty.snapshotAsOf === null
    && empty.rows.every((row) => row.evidence === "missing" && row.dataDate === "未知"
      && row.coverage === "未取得" && row.lastSuccessAt === null));
  check("empty + idle: NO row claims a save",
    empty.rows.every((row) => row.attempt !== "saved" && !row.attemptText.includes("已落盘保存")));
  check("empty + running/error: attempts state not-obtained, still no save claim",
    buildSourceLedger(null, "running").rows.every((row) => row.attemptText.includes("尚无成功快照") || row.attemptText === TRANSACTIONS_ATTEMPT_TEXT)
    && buildSourceLedger(null, "error").rows.every((row) => row.attemptText.includes("未取得") || row.attemptText === TRANSACTIONS_ATTEMPT_TEXT));
  check("empty: the transactions attempt stays platform-unknown even with no data",
    rowOf(empty, "plaid_transactions").attempt === "unknown"
    && rowOf(empty, "plaid_transactions").attemptText === "未知（平台未提供逐源结果）");
}

// ---------- full synthetic facts ----------
const fullFacts = {
  asOf: "2099-10-18T12:00:00-07:00",
  sourceMonth: "2099-09-30",
  months: [
    month("2099-08-31"),
    month("2099-09-30", { integrity: "unknown", spendProven: false, incomeProven: false, contributionProven: false }),
  ],
  accounts: [
    acct({ balanceDate: "2099-09-30", value: 0 }),                    // true zero balance
    acct({ live: false, balanceDate: "2099-08-31", value: 500 }),     // stale date (earlier month)
    { type: "investment", live: true, balanceDate: null, value: 1000 }, // not a bank row
    { type: "income", live: false, balanceDate: null, value: 700 },     // never balance coverage
  ],
  holdingsSummaryCount: 3,
  holdingsAllCount: 3,
  holdingsTotal: 1000,
  holdingsComplete: true,
};
{
  const ledger = buildSourceLedger(fullFacts, "idle");
  const firance = rowOf(ledger, "firance");
  check("firance: proven from the read-back snapshots, data date is the source month (never the asOf date)",
    firance.evidence === "proven" && firance.dataDate === "2099-09-30" && !firance.dataDate.includes("2099-10-18")
    && firance.coverage === "2099-08-31 至 2099-09-30 · 共 2 份月度快照"
    && firance.evidenceText.includes("共 2 份月度记录") && firance.lastSuccessAt === null
    && ledger.snapshotAsOf === fullFacts.asOf);
  const bank = rowOf(ledger, "plaid_accounts");
  check("bank: differing valid dates state the span with full date coverage 2/2",
    bank.dataDate === "2099-08-31 至 2099-09-30（各账户余额日期不一致；日期已知 2/2）");
  check("bank: a stale (earlier-month) balance date downgrades evidence to partial and is named",
    bank.evidence === "partial" && bank.evidenceSymbol === "◑" && bank.evidenceText.includes("沿用旧日期"));
  check("bank: a true 0 balance is a fact — counted in the denominator and named as real zero",
    bank.evidenceText.includes("真实 0") && bankDateCoverage(fullFacts.accounts, "2099-09-30").total === 2);
  check("bank: coverage counts balance rows only (account + investment; the income row is excluded)",
    bank.coverage === "2 个余额账户为同步读取值，1 个余额账户沿用月度快照值"
    && balanceCoverageText(fullFacts.accounts) === bank.coverage);
  const tx = rowOf(ledger, "plaid_transactions");
  check("transactions: partial evidence (1/2 months proven), data date unknown, attempt platform-unknown",
    tx.evidence === "partial" && tx.dataDate === "未知" && tx.attempt === "unknown"
    && tx.attemptText === TRANSACTIONS_ATTEMPT_TEXT && tx.coverage.includes("2099-08"));
  check("transactions: the unproven month's transaction-dependent inferences are explicitly degraded by name",
    tx.degraded.length === 1 && tx.degraded[0].includes("2099-09") && tx.degraded[0].includes("降级")
    && tx.lastSuccessAt === null);
  const holdings = rowOf(ledger, "plaid_holdings");
  check("holdings: complete set is proven with the fixed denominator stated; date stays unknown",
    holdings.evidence === "proven" && holdings.dataDate === "未知"
    && holdings.coverage === "全部持仓 3 只 · 分母 $1,000.00" && holdings.evidenceText.includes("共 3 只"));
  check("idle: the three landing sources state the legal save; facts carry symbols + text (never colour alone)",
    [firance, bank, holdings].every((row) => row.attempt === "saved" && row.attemptText.includes("已落盘保存"))
    && ledger.rows.every((row) => row.evidenceSymbol.length > 0 && row.evidenceLabel.length > 0));
}

// ---------- failure keeps old facts; transactions never block balances ----------
{
  const idle = buildSourceLedger(fullFacts, "idle");
  const error = buildSourceLedger(fullFacts, "error");
  const running = buildSourceLedger(fullFacts, "running");
  check("failure-keeps-old: a failed attempt changes ONLY the attempt fields — every fact field is byte-identical",
    idle.rows.every((row, i) => factFields(row) === factFields(error.rows[i]))
    && idle.rows.every((row, i) => factFields(row) === factFields(running.rows[i])));
  check("failure-keeps-old: the failed attempt reads 未写入新数据，保留上次成功数据 on the landing sources",
    ["firance", "plaid_accounts", "plaid_holdings"].every((key) =>
      rowOf(error, key).attempt === "failed_kept" && rowOf(error, key).attemptText.includes("保留上次成功数据")));
  check("running: attempts read 尚未落盘 — never a saved/updated claim",
    ["firance", "plaid_accounts", "plaid_holdings"].every((key) =>
      rowOf(running, key).attemptText.includes("尚未落盘") && !rowOf(running, key).attemptText.includes("已落盘保存（当前")));
  check("transactions never block balances: with zero proven months the bank row keeps its facts and saved attempt",
    (() => {
      const noTx = buildSourceLedger({
        ...fullFacts,
        months: [month("2099-09-30", { spendProven: false, integrity: "unknown", incomeProven: false, contributionProven: false })],
      }, "idle");
      const bankRow = rowOf(noTx, "plaid_accounts");
      const txRow = rowOf(noTx, "plaid_transactions");
      return txRow.evidence === "missing" && txRow.lastSuccessAt === null
        && bankRow.dataDate === rowOf(idle, "plaid_accounts").dataDate
        && bankRow.attempt === "saved";
    })());
}

// ---------- missing / invalid dates are never filled ----------
{
  const badDates = buildSourceLedger({
    ...fullFacts,
    accounts: [
      acct({ balanceDate: "2099-14-01", value: 10 }),  // present but illegal month
      acct({ balanceDate: null, value: 20 }),          // missing
      acct({ balanceDate: "", value: 30 }),            // empty
    ],
  }, "idle");
  const bank = rowOf(badDates, "plaid_accounts");
  check("invalid dates: an illegal balance date counts as 日期无效， never as known, never worn as the source date",
    bank.dataDate === "未知（日期已知 0/3；其余 2 个账户日期未知；1 个账户日期无效）"
    && !bank.dataDate.includes("2099-14-01") && bank.evidence === "partial");
  const badAsOf = buildSourceLedger({ ...fullFacts, asOf: "2099-13-40T00:00:00Z" }, "idle");
  check("invalid asOf: last success time is null on the ledger and every row (never filled with success)",
    badAsOf.snapshotAsOf === null && badAsOf.rows.every((row) => row.lastSuccessAt === null)
    && rowOf(badAsOf, "firance").dataDate === "2099-09-30");
  const badMonth = buildSourceLedger({ ...fullFacts, sourceMonth: "2099-13-01" }, "idle");
  check("invalid source month: the firance data date reads 未知 instead of the illegal value",
    rowOf(badMonth, "firance").dataDate === "未知");
  const sameDay = bankDateCoverage([acct({}), acct({ value: 0 })], "2099-09-30");
  check("bank coverage: all rows sharing one valid date -> the date stands with 日期已知 2/2 and no gap note, true 0 included",
    sameDay.dataDate === "2099-09-30（日期已知 2/2）" && sameDay.known === 2 && sameDay.stale === 0);
  const noBank = buildSourceLedger({ ...fullFacts, accounts: [{ type: "income", live: false, balanceDate: null, value: 5 }] }, "idle");
  check("no bank rows: evidence missing, date unknown, coverage 未提供， attempt 未提供 (never a fabricated 0)",
    rowOf(noBank, "plaid_accounts").evidence === "missing"
    && rowOf(noBank, "plaid_accounts").dataDate === "未知"
    && rowOf(noBank, "plaid_accounts").coverage === "未提供"
    && rowOf(noBank, "plaid_accounts").attempt === "not_provided");
}

// ---------- F0.5 溯源修复（2026-11-05）：逐源最后成功时间只认该源自身证据 ----------
{
  // 简报缺陷夹具：Plaid 空输入时本地沿用的 synthetic_bank 行
  // （live=false、余额真 0、verified=false、status 沿用未核实），
  // 加一行同日同步读取值作对照。
  const defectFacts = {
    asOf: "2099-11-05T12:00:00Z",
    sourceMonth: "2099-09-30",
    months: [month("2099-09-30")],
    accounts: [
      { type: "account", live: false, balanceDate: "2099-09-30", value: 0, verified: false, status: "carried_forward_unverified" },
      acct({ balanceDate: "2099-09-30", value: 100 }),
    ],
    holdingsSummaryCount: 0,
    holdingsAllCount: 0,
    holdingsTotal: null,
    holdingsComplete: false,
  };
  const defect = buildSourceLedger(defectFacts, "idle");
  check("provenance defect: a carried-forward unverified bank row blocks proven and is named separately",
    rowOf(defect, "plaid_accounts").evidence === "partial"
    && rowOf(defect, "plaid_accounts").evidenceText.includes("沿用未核实")
    && rowOf(defect, "plaid_accounts").evidenceText.includes("不计为该源同步成功已证明")
    && rowOf(defect, "plaid_accounts").evidenceText.includes("沿用本地月度快照值"));
  check("provenance: with no per-source success-time evidence every row's last success is null while the total snapshot time is the asOf",
    defect.snapshotAsOf === defectFacts.asOf
    && defect.rows.every((row) => row.lastSuccessAt === null));
  check("provenance invariance: advancing the total asOf by one day leaves every row's fact fields byte-identical",
    (() => {
      const next = buildSourceLedger({ ...defectFacts, asOf: "2099-11-06T12:00:00Z" }, "idle");
      return next.snapshotAsOf === "2099-11-06T12:00:00Z"
        && defect.rows.every((row, i) => factFields(row) === factFields(next.rows[i]));
    })());
  check("per-source evidence advances only its own source (bank gets its own instant; the other rows stay null)",
    (() => {
      const withEvidence = buildSourceLedger({
        ...defectFacts,
        sourceSuccessAt: { plaid_accounts: "2099-10-17T10:00:00Z" },
      }, "idle");
      return rowOf(withEvidence, "plaid_accounts").lastSuccessAt === "2099-10-17T10:00:00Z"
        && rowOf(withEvidence, "firance").lastSuccessAt === null
        && rowOf(withEvidence, "plaid_transactions").lastSuccessAt === null
        && rowOf(withEvidence, "plaid_holdings").lastSuccessAt === null
        && withEvidence.snapshotAsOf === defectFacts.asOf;
    })());
  check("per-source evidence: an illegal per-source instant and a missing sourceSuccessAt both read null (unknown, never fabricated)",
    sourceSuccessInstant({ ...defectFacts, sourceSuccessAt: { plaid_accounts: "2099-13-40T00:00:00Z" } }, "plaid_accounts") === null
    && sourceSuccessInstant(defectFacts, "firance") === null
    && sourceSuccessInstant({ ...defectFacts, sourceSuccessAt: { firance: "2099-10-17T10:00:00Z" } }, "firance") === "2099-10-17T10:00:00Z");
  check("accountUnverified: explicit false / unverified statuses count; true / missing do not",
    accountUnverified({ type: "account", live: false, balanceDate: "2099-09-30", value: 0, verified: false, status: null }) === true
    && accountUnverified({ type: "account", live: false, balanceDate: "2099-09-30", value: 0, verified: null, status: "carried_forward_unverified" }) === true
    && accountUnverified({ type: "account", live: false, balanceDate: "2099-09-30", value: 0, verified: null, status: "unverified" }) === true
    && accountUnverified({ type: "account", live: true, balanceDate: "2099-09-30", value: 100, verified: true, status: null }) === false
    && accountUnverified({ type: "account", live: true, balanceDate: "2099-09-30", value: 100 }) === false);
  check("provenance control: the same carried row WITH verification does not block proven (only unverified carry does)",
    rowOf(buildSourceLedger({
      ...defectFacts,
      accounts: [
        { type: "account", live: false, balanceDate: "2099-09-30", value: 0, verified: true, status: null },
        acct({ balanceDate: "2099-09-30", value: 100 }),
      ],
    }, "idle"), "plaid_accounts").evidence === "proven");
}

// ---------- partial / legacy shapes ----------
{
  const legacyHoldings = buildSourceLedger({ ...fullFacts, holdingsComplete: false, holdingsAllCount: 0, holdingsTotal: null, holdingsSummaryCount: 10 }, "idle");
  check("holdings: a legacy Top-10-only cache is partial and states the long tail was never saved",
    rowOf(legacyHoldings, "plaid_holdings").evidence === "partial"
    && rowOf(legacyHoldings, "plaid_holdings").coverage === "仅 Top 10 摘要（旧缓存，长尾未保存）");
  const noMonths = buildSourceLedger({ ...fullFacts, months: [] }, "idle");
  check("data present but zero months: firance/transactions have no evidence and nothing is 0-filled",
    rowOf(noMonths, "firance").evidence === "missing" && rowOf(noMonths, "firance").coverage === "未取得"
    && rowOf(noMonths, "plaid_transactions").evidence === "missing"
    && rowOf(noMonths, "plaid_transactions").degraded.length === 0);
  const degraded = transactionDegradations([
    month("2099-07-31", { spendProven: false, integrity: "unknown", incomeProven: false, contributionProven: false }),
    month("2099-08-31", { integrity: "unknown" }),
    month("2099-09-30"),
  ]);
  check("degradations: unproven-spend months and proven-but-unverified months are named in separate, non-overlapping lines",
    degraded.length === 2 && degraded[0].includes("2099-07") && !degraded[0].includes("2099-08")
    && degraded[1].includes("2099-08") && !degraded[1].includes("2099-07") && !degraded[1].includes("2099-09"));
  check("attempt helper: has-data vs no-data wording split is exact",
    sourceAttemptFor("error", true).attemptText === "本次未成功，未写入新数据，保留上次成功数据"
    && sourceAttemptFor("error", false).attemptText === "本次未成功，未取得，尚无成功快照"
    && sourceAttemptFor("idle", true).attempt === "saved" && sourceAttemptFor("idle", false).attempt === "not_obtained");
}

// ---------- mutations (really executed, must flip) ----------
const moduleSource = readFileSync(join(APP_DIR, "server/src/sourceLedger.ts"), "utf8");
async function mutatedModule(replacements) {
  let src = moduleSource;
  for (const [anchor, replacement] of replacements) {
    if (!src.includes(anchor)) throw new Error(`mutation anchor missing: ${anchor}`);
    src = src.replace(anchor, replacement);
  }
  if (src === moduleSource) throw new Error("mutation did not change the source");
  const dir = mkdtempSync(join(tmpdir(), "srcledger-mut-"));
  writeFileSync(join(dir, "sourceLedger.ts"), src);
  try {
    return await import(join(dir, "sourceLedger.ts"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
{
  // M1: the legal-month bound 12 -> 99 makes 2099-14 "legal".
  const fixture = () => ({ ...fullFacts, accounts: [acct({ balanceDate: "2099-14", value: 10 })] });
  check("mutation baseline: 2099-14 is invalid evidence (0/1, 日期无效）",
    rowOf(buildSourceLedger(fixture(), "idle"), "plaid_accounts").dataDate.includes("日期已知 0/1")
    && rowOf(buildSourceLedger(fixture(), "idle"), "plaid_accounts").dataDate.includes("日期无效"));
  const m1 = await mutatedModule([["return month >= 1 && month <= 12;", "return month >= 1 && month <= 99;"]]);
  check("mutation M1 (month bound 12->99) flips: 2099-14 becomes the stated known date 1/1",
    m1.buildSourceLedger(fixture(), "idle").rows.find((row) => row.key === "plaid_accounts").dataDate === "2099-14（日期已知 1/1）");
}
{
  // M2: firance evidence forced proven even with zero months.
  const fixture = () => ({ ...fullFacts, months: [] });
  check("mutation baseline: zero months -> firance evidence missing",
    rowOf(buildSourceLedger(fixture(), "idle"), "firance").evidence === "missing");
  const m2 = await mutatedModule([['firanceHas ? "proven" : "missing"', '"proven"']]);
  check("mutation M2 (firance evidence unconditional) flips: zero months reads proven",
    m2.buildSourceLedger(fixture(), "idle").rows.find((row) => row.key === "firance").evidence === "proven");
}
{
  // M3: the unproven-spend predicate inverted.
  const fixture = () => [month("2099-08-31"), month("2099-09-30", { spendProven: false, integrity: "unknown", incomeProven: false, contributionProven: false })];
  check("mutation baseline: degradations name the unproven month 2099-09 only",
    transactionDegradations(fixture()).length === 1 && transactionDegradations(fixture())[0].includes("2099-09"));
  const m3 = await mutatedModule([[".filter((month) => !month.spendProven)", ".filter((month) => month.spendProven)"]]);
  check("mutation M3 (unproven predicate inverted) flips: degradations name the proven month instead",
    m3.transactionDegradations(fixture()).some((line) => line.includes("2099-08")));
}
{
  // M4: the unverified-carry gate removed from the bank proven rule.
  const fixture = () => ({
    asOf: "2099-11-05T12:00:00Z",
    sourceMonth: "2099-09-30",
    months: [month("2099-09-30")],
    accounts: [
      { type: "account", live: false, balanceDate: "2099-09-30", value: 0, verified: false, status: "carried_forward_unverified" },
      acct({ balanceDate: "2099-09-30", value: 100 }),
    ],
    holdingsSummaryCount: 0, holdingsAllCount: 0, holdingsTotal: null, holdingsComplete: false,
  });
  check("mutation baseline: the carried-forward unverified bank row keeps the bank at partial",
    rowOf(buildSourceLedger(fixture(), "idle"), "plaid_accounts").evidence === "partial");
  const m4 = await mutatedModule([["bank.total > 0 && bank.known === bank.total && bank.stale === 0 && unverifiedBankCount === 0", "bank.total > 0 && bank.known === bank.total && bank.stale === 0"]]);
  check("mutation M4 (unverified-carry gate removed) flips: the same defect fixture reads proven",
    m4.buildSourceLedger(fixture(), "idle").rows.find((row) => row.key === "plaid_accounts").evidence === "proven");
}
{
  // M5: per-source success time falls back to the total asOf.
  const fixture = () => ({
    asOf: "2099-11-05T12:00:00Z",
    sourceMonth: "2099-09-30",
    months: [month("2099-09-30")],
    accounts: [acct({ balanceDate: "2099-09-30", value: 100 })],
    holdingsSummaryCount: 0, holdingsAllCount: 0, holdingsTotal: null, holdingsComplete: false,
  });
  check("mutation baseline: with no per-source evidence every row's last success is null",
    buildSourceLedger(fixture(), "idle").rows.every((row) => row.lastSuccessAt === null));
  const m5 = await mutatedModule([["return lastSuccessInstant(facts.sourceSuccessAt?.[key] ?? null);", "return lastSuccessInstant(facts.sourceSuccessAt?.[key] ?? facts.asOf);"]]);
  check("mutation M5 (per-source time falls back to total asOf) flips: rows with facts inherit the total snapshot time",
    (() => {
      const mutated = m5.buildSourceLedger(fixture(), "idle");
      return ["firance", "plaid_accounts", "plaid_transactions"].every(
        (key) => mutated.rows.find((row) => row.key === key).lastSuccessAt === fixture().asOf)
        && mutated.rows.find((row) => row.key === "plaid_holdings").lastSuccessAt === null;
    })());
}

// ---------- action handlers over an in-memory DB ----------
const appRequire = createRequire(join(APP_DIR, "package.json"));
const { drizzle } = appRequire("drizzle-orm/bun-sqlite");
const { eq } = appRequire("drizzle-orm");
const schema = await import(join(APP_DIR, "server/src/schema.ts"));
const { Actions } = await import(join(APP_DIR, "server/src/actions.ts"));
function applyMigrationFile(sqlite, file) {
  const sql = readFileSync(join(APP_DIR, "drizzle", file), "utf8");
  for (const stmt of sql.split("--> statement-breakpoint")) {
    const s = stmt.trim();
    if (s) sqlite.exec(s);
  }
}
function freshDb() {
  const sqlite = new Database(":memory:");
  const files = readdirSync(join(APP_DIR, "drizzle")).filter((f) => f.endsWith(".sql")).sort();
  for (const f of files) applyMigrationFile(sqlite, f);
  return { sqlite, db: drizzle(sqlite, { schema }) };
}
function makeCtx(db, opts) {
  return {
    slug: "space-3",
    invocationId: "validator-harness",
    spaceDir: APP_DIR,
    viewer: opts.viewer,
    db: () => db,
    blobs: undefined,
    invalidateQueries: () => {},
    agent: { spawnTask: async () => ({ ok: true, taskId: "task-harness" }) },
    executePrivileged: async () => { throw new Error("not used"); },
  };
}
const ownerCtx = (db) => makeCtx(db, { viewer: { isOwner: true } });
const guestCtx = (db) => makeCtx(db, { viewer: { isOwner: false } });
const syncCtx = (db) => makeCtx(db, {});

const minimalMonth = (key, extra = {}) => ({
  key, total: 1000, investment: 600, investmentContribution: 0,
  saving: 400, fixedSpend: 100, transfer: 0, income: 500, contribution: 0,
  flexibleSpend: null, totalSpend: null, investmentReturn: null, ...extra,
});
const syntheticPayload = {
  asOf: "2099-10-18T12:00:00-07:00",
  sourceMonth: "2099-09-30",
  months: [
    minimalMonth("2099-08-31", { integrity: "complete", spendProven: true, incomeProven: true, contributionProven: true }),
    minimalMonth("2099-09-30", { integrity: "unknown", spendProven: false }),
  ],
  live: { netWorth: 1000, investment: 600, saving: 400, weeklyDelta: null },
  holdings: [{ ticker: "SYN", name: "Synthetic Holding", value: 100, share: 1 }],
  accounts: [
    { source: "synthetic_bank", label: "Synthetic Bank", type: "account", value: 0, live: true, institution: null, mask: null, balanceDate: "2099-09-30" },
  ],
  concentrationTop3: 0,
  fire: { annualContribution: 0, annualSpend: 1200, target: 30000, progress: null, gap: 29400 },
};
{
  const { db } = freshDb();
  const guestDash = await Actions.getDashboard.handler(guestCtx(db), {});
  check("getDashboard: guest -> sourceLedger null (L0.1 exception NOT widened)",
    guestDash.access === "guest_denied" && guestDash.sourceLedger === null);
  const syncDash = await Actions.getDashboard.handler(syncCtx(db), {});
  check("getDashboard: viewer-less sync channel -> sourceLedger null too (strict owner read)",
    syncDash.access === "guest_denied" && syncDash.sourceLedger === null);
  const emptyDash = await Actions.getDashboard.handler(ownerCtx(db), {});
  check("getDashboard: owner with an empty store -> the empty ledger (no evidence, no success time, no save claim)",
    emptyDash.data === null && emptyDash.sourceLedger !== null
    && emptyDash.sourceLedger.snapshotAsOf === null
    && emptyDash.sourceLedger.rows.length === 4
    && emptyDash.sourceLedger.rows.every((row) => row.evidence === "missing" && row.lastSuccessAt === null)
    && emptyDash.sourceLedger.rows.every((row) => row.attempt !== "saved"));
}
{
  const { db } = freshDb();
  // Legal save -> read-back: seed the stored snapshot exactly as
  // a settled ingest leaves it, then read through getDashboard.
  await db.insert(schema.financeState).values({ id: 1, payload: JSON.stringify(syntheticPayload), status: "idle" });
  const dash = await Actions.getDashboard.handler(ownerCtx(db), {});
  const ledger = dash.sourceLedger;
  check("read-back: the legally saved snapshot yields the full server ledger",
    dash.data !== null && ledger !== null && ledger.snapshotAsOf === syntheticPayload.asOf
    && ledger.rows.length === 4);
  check("read-back: firance proven on the source month; bank proven with the true-0 account counted",
    rowOf(ledger, "firance").evidence === "proven" && rowOf(ledger, "firance").dataDate === "2099-09-30"
    && rowOf(ledger, "plaid_accounts").evidence === "proven"
    && rowOf(ledger, "plaid_accounts").dataDate === "2099-09-30（日期已知 1/1）"
    && rowOf(ledger, "plaid_accounts").evidenceText.includes("真实 0"));
  check("read-back: transactions partial with the unproven month degraded; holdings partial (Top-10-only payload)",
    rowOf(ledger, "plaid_transactions").evidence === "partial"
    && rowOf(ledger, "plaid_transactions").degraded.some((line) => line.includes("2099-09"))
    && rowOf(ledger, "plaid_holdings").evidence === "partial");
  // Failure-keeps-old at the action level: the same stored
  // snapshot under a failed attempt state — facts unchanged.
  await db.update(schema.financeState).set({ status: "error" }).where(eq(schema.financeState.id, 1));
  const dashErr = await Actions.getDashboard.handler(ownerCtx(db), {});
  check("read-back: a failed attempt state keeps every ledger fact and flips only the attempt wording",
    dashErr.sourceLedger.rows.every((row, i) => factFields(row) === factFields(ledger.rows[i]))
    && rowOf(dashErr.sourceLedger, "firance").attempt === "failed_kept"
    && rowOf(dashErr.sourceLedger, "firance").attemptText.includes("保留上次成功数据")
    && dashErr.refresh.status === "error");
}
{
  // Read-back of the same provenance defect through the real handler:
  // the stored snapshot carries the carried-forward unverified
  // synthetic_bank row (live=false, true 0) plus one synced row.
  const { db } = freshDb();
  const defectPayload = {
    ...syntheticPayload,
    months: [minimalMonth("2099-09-30", { integrity: "complete", spendProven: true, incomeProven: true, contributionProven: true })],
    accounts: [
      { source: "synthetic_bank", label: "Synthetic Bank", type: "account", value: 0, live: false, institution: null, mask: null, balanceDate: "2099-09-30", verified: false, status: "carried_forward_unverified" },
      { source: "synthetic_bank", label: "Synthetic Bank", type: "account", value: 100, live: true, institution: null, mask: null, balanceDate: "2099-09-30" },
    ],
  };
  await db.insert(schema.financeState).values({ id: 1, payload: JSON.stringify(defectPayload), status: "idle" });
  const dash = await Actions.getDashboard.handler(ownerCtx(db), {});
  const ledger = dash.sourceLedger;
  check("read-back defect: the carried-forward unverified bank row is partial and named, never proven",
    ledger !== null && rowOf(ledger, "plaid_accounts").evidence === "partial"
    && rowOf(ledger, "plaid_accounts").evidenceText.includes("沿用未核实")
    && rowOf(ledger, "plaid_accounts").evidenceText.includes("不计为该源同步成功已证明"));
  check("read-back defect: no row inherits the total snapshot time as its last success; the total time stands alone",
    ledger !== null && ledger.snapshotAsOf === defectPayload.asOf
    && ledger.rows.every((row) => row.lastSuccessAt === null));
}

// ---------- wiring ----------
const actionsSrc = readFileSync(join(APP_DIR, "server/src/actions.ts"), "utf8");
const appSrc = readFileSync(join(APP_DIR, "client/src/App.tsx"), "utf8");
const cssSrc = readFileSync(join(APP_DIR, "client/src/theme.css"), "utf8");
check("wiring: the pure module has zero imports and never imports the drifted F3.2/F3.3 modules",
  !/^\s*import\s/m.test(moduleSource) && !moduleSource.includes('from "./recurringCharges"') && !moduleSource.includes('from "./cashFlowForecast"'));
check("wiring: actions.ts imports the pure module and exposes sourceLedger on getDashboard (owner field + guest null)",
  actionsSrc.includes('from "./sourceLedger"') && actionsSrc.includes("buildSourceLedger(")
  && actionsSrc.includes("sourceLedger: sourceLedgerSchema.nullable().optional()")
  && actionsSrc.includes("sourceLedger: null,") && actionsSrc.includes("sourceLedger,"));
check("wiring: getDashboard description names the sourceLedger field",
  actionsSrc.includes("sourceLedger: Firance snapshots / Plaid accounts / Plaid transactions / Plaid holdings"));
check("wiring: the client renders the server ledger and keeps the delivered client helper untouched as fallback",
  appSrc.includes("serverLedger={response.sourceLedger ?? null}")
  && appSrc.includes("row.evidenceSymbol") && appSrc.includes("row.degraded")
  && appSrc.includes("export function sourceLedgerRows("));
check("wiring: the client computes no ledger of its own for the server path (render-only mapping of server fields)",
  appSrc.includes("dataDate: row.dataDate") && appSrc.includes("range: row.coverage") && appSrc.includes("result: row.attemptText"));
check("wiring: degraded/evidence sub-lines have a style rule; the band summary keeps its accessible name",
  cssSrc.includes(".refresh-band__ledger-sub") && appSrc.includes("来源台账（本地月度记录、银行余额、交易、持仓）"));

console.log(`validate-source-ledger: ${passed}/${passed + failed} passed`);
process.exit(failed ? 1 : 0);
