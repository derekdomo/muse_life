import { defineAction, z, type ActionsModule, type Ctx } from "@hatch/space-sdk";
import { eq } from "drizzle-orm";
import * as schema from "./schema";

const financeTypeSchema = z.enum([
  "investment",
  "investment_contribution",
  "account",
  "fixed_spend",
  "transfer",
  "income",
  // F0.6 additive Firance types: recorded flexible spend, other net
  // cashflow adjustments, and non-bank direct investment (RSU /
  // employer) adjustments. Older payloads never carry them.
  "flexible_spend",
  "cashflow_adjustment",
  "investment_external_adjustment",
]);

const cashflowRoleSchema = z.enum(["cash", "credit", "debt", "non_cash"]);

const sourceEntrySchema = z.object({
  financeSource: z.string().min(1).max(160),
  type: financeTypeSchema,
  number: z.number(),
  // F0.6 additive extended fields, preserved verbatim from the
  // Firance record when present (parsed by key, never by line
  // position). Absence stays absence: history is never backfilled
  // with a verification mark it did not carry.
  cashflowRole: cashflowRoleSchema.nullable().optional(),
  balanceDate: z.string().max(10).nullable().optional(),
  status: z.string().max(80).nullable().optional(),
  periodStart: z.string().max(10).nullable().optional(),
  periodEnd: z.string().max(10).nullable().optional(),
  verified: z.boolean().nullable().optional(),
  extra: z
    .record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]))
    .optional(),
});

const rawMonthSchema = z.object({
  // F0.6: Firance snapshot filenames may be YYYY-MM-DD or YYYY-MM
  // (a month-end valuation). The server normalizes YYYY-MM to that
  // month's last day; a filename alone never proves transaction
  // coverage for the month.
  key: z.string().regex(/^\d{4}-\d{2}(-\d{2})?$/),
  entries: z.array(sourceEntrySchema).max(200),
});

const plaidAccountSchema = z.object({
  institution: z.string().min(1).max(120),
  name: z.string().min(1).max(160),
  type: z.string().min(1).max(40),
  subtype: z.string().max(80).nullable().optional(),
  mask: z.string().regex(/^\d{2,4}$/).nullable(),
  current: z.number().nullable(),
});

const holdingInputSchema = z.object({
  ticker: z.string().max(32).nullable(),
  name: z.string().min(1).max(180),
  // F2.3: value is nullable at ingest — a holding whose market
  // value the source cannot provide is submitted as null and lands
  // in the 待核对 list, never dropped silently and never invented.
  // Negative values pass through as-is (negative positions are
  // 待核对 too, never absolved into positive holdings).
  value: z.number().nullable(),
  // F2.3 additive: the holding's currency (Plaid iso_currency_code)
  // and holding institution, when the source provides them. A
  // missing currency is NOT defaulted to USD — the row is listed
  // as 币种不明 under 待核对 and stays out of the denominator.
  currency: z.string().max(12).nullable().optional(),
  institution: z.string().max(120).nullable().optional(),
});

const plaidTransactionSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  amount: z.number(),
  name: z.string().min(1).max(240),
  pending: z.boolean().default(false),
  internalTransfer: z.boolean().default(false),
  transferLike: z.boolean().default(false),
});

const transactionCoverageSchema = z.object({
  start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  complete: z.boolean(),
}).nullable();

// F0.6: per-entry classification / balance-date / verification
// metadata preserved on the month so the UI can show 分类、余额日期、
// 投入期间与核实状态 without a second source ledger.
const entryMetaSchema = z.object({
  financeSource: z.string(),
  type: financeTypeSchema,
  cashflowRole: cashflowRoleSchema.nullable().default(null),
  balanceDate: z.string().nullable().default(null),
  status: z.string().nullable().default(null),
  periodStart: z.string().nullable().default(null),
  periodEnd: z.string().nullable().default(null),
  verified: z.boolean().nullable().default(null),
});

const monthSchema = z.object({
  key: z.string(),
  total: z.number(),
  investment: z.number(),
  investmentContribution: z.number(),
  saving: z.number(),
  deposits: z.number().nullable().default(null),
  loans: z.number().nullable().default(null),
  fixedSpend: z.number(),
  transfer: z.number(),
  income: z.number(),
  contribution: z.number(),
  // F0.6: flexible spend is nullable. A recorded value (including a
  // true 0 or a negative net refund) is kept as recorded; an estimate
  // comes only from the cash/credit cashflow identity; anything else
  // is null with a reason — never clamped to 0. Legacy payloads hold
  // a plain number, which stays readable under the nullable type.
  flexibleSpend: z.number().nullable(),
  flexibleSpendAnomaly: z.boolean().default(false),
  totalSpend: z.number().nullable(),
  investmentReturn: z.number().nullable(),
  // F1.6 additive investment-performance fields. Defaults keep
  // pre-existing stored payloads readable: a legacy month has no
  // proven net flow and no recorded reason — it is re-derived on
  // read from its preserved entry metadata, never trusted as-is.
  investmentNetFlow: z.number().nullable().default(null),
  investmentReturnReason: z.string().nullable().default(null),
  // F0.6 additive cashflow reconciliation fields. Defaults keep
  // pre-existing stored payloads readable: legacy months read as
  // "estimated" (the old back-calculation) with no preserved entry
  // metadata — they are not re-labelled as recorded or verified.
  flexibleSpendSource: z.enum(["recorded", "estimated", "missing"]).default("estimated"),
  cashflowDifference: z.number().nullable().default(null),
  cashflowNote: z.string().nullable().default(null),
  contributionSource: z.enum(["standard", "alias", "conflict", "missing"]).default("missing"),
  investmentExternalAdjustment: z.number().default(0),
  cashCreditNet: z.number().default(0),
  entryMeta: z.array(entryMetaSchema).default([]),
  // F0.3/F0.4 additive monthly-fact fields. Defaults keep pre-existing
  // stored payloads readable: they honestly report integrity "unknown"
  // and are never backfilled as complete.
  snapshotDate: z.string().default(""),
  supersededSnapshots: z.number().int().nonnegative().default(0),
  integrity: z.enum(["partial", "complete", "unknown"]).default("unknown"),
  integrityBasis: z.string().nullable().default(null),
  anomalyReason: z.string().nullable().default(null),
  // F0.4/F0.5 additive per-metric provenance flags. Defaults keep
  // pre-existing stored payloads readable: missing flags read as
  // false (未提供), never backfilled as proven.
  spendProven: z.boolean().default(false),
  incomeProven: z.boolean().default(false),
  contributionProven: z.boolean().default(false),
});

// F1.6: whole-period investment performance, derived only from the
// monthly investment-account balances and their proven external net
// flows — never from holdings detail and never from the net-worth
// balance difference. The default keeps legacy stored payloads
// readable; the read path re-derives it from the months.
const investmentPerformanceSchema = z.object({
  startKey: z.string().nullable().default(null),
  endKey: z.string().nullable().default(null),
  startBalance: z.number().nullable().default(null),
  endBalance: z.number().nullable().default(null),
  netFlow: z.number().nullable().default(null),
  returnAmount: z.number().nullable().default(null),
  reason: z.string().nullable().default(null),
  monthsCovered: z.number().int().nonnegative().default(0),
});

const holdingSchema = z.object({
  ticker: z.string(),
  name: z.string(),
  value: z.number(),
  share: z.number(),
});

// F2.3: one row of the full normalized holdings set. `share` is the
// value's fraction of the FIXED denominator (holdingsTotal — every
// valid non-cash holding, long tail included); it is computed once
// at ingest and never recomputed from a truncated or
// search-filtered subset. `institutions` names the institutions
// holding this ticker after the cross-account merge, so a ticker
// held in several accounts is an explainable fact on the row.
const holdingDetailSchema = z.object({
  ticker: z.string(),
  name: z.string(),
  value: z.number(),
  share: z.number(),
  institutions: z.array(z.string()).default([]),
});

// F2.3: cash is always listed separately from holdings. Each cash
// row keeps its own ticker / currency; only CUR:USD sums into the
// legacy `cashPosition` total.
const cashHoldingSchema = z.object({
  ticker: z.string(),
  name: z.string(),
  value: z.number(),
  currency: z.string().nullable().default(null),
});

// F2.3: positions that cannot enter the USD denominator — missing
// market value, negative position, zero value, unknown or non-USD
// currency. They are listed as 待核对 with the reason, never
// silently dropped and never defaulted to USD positive holdings.
const unclassifiedHoldingSchema = z.object({
  ticker: z.string(),
  name: z.string(),
  value: z.number().nullable().default(null),
  currency: z.string().nullable().default(null),
  reason: z.string(),
});

const accountSchema = z.object({
  source: z.string(),
  label: z.string(),
  type: financeTypeSchema,
  value: z.number(),
  live: z.boolean(),
  institution: z.string().nullable(),
  mask: z.string().nullable(),
  // F1.1 additive per-account cash classification, carried from the
  // latest snapshot entry (explicit cashflow_role or the name-based
  // fallback) so the client can show which accounts are available
  // cash and let the owner trial a different selection on this page
  // only. Defaults keep pre-existing stored payloads readable:
  // legacy rows carry no classification and are re-derived on read.
  cashflowRole: cashflowRoleSchema.nullable().default(null),
  balanceDate: z.string().nullable().default(null),
  availableCash: z.boolean().default(false),
});

const dashboardSchema = z.object({
  asOf: z.string(),
  sourceMonth: z.string(),
  months: z.array(monthSchema),
  live: z.object({
    netWorth: z.number(),
    investment: z.number(),
    saving: z.number(),
    deposits: z.number().nullable().default(null),
    loans: z.number().nullable().default(null),
    weeklyDelta: z.number().nullable(),
    // F1.1 additive available-cash summary. `deposits` above stays
    // the net-worth balance fact (every positive account balance);
    // availableCash is the emergency-fund numerator and counts
    // ONLY accounts classified cash — HSA / bond / retirement
    // (non-cash), credit-card and loan (credit/debt) balances are
    // excluded no matter their sign. It is null when no cash
    // account exists or a cash balance is stale (carried over from
    // an older balance date): missing/stale cash never becomes a
    // fabricated coverage figure. Defaults keep legacy payloads
    // readable; the read path re-derives the summary from the
    // account rows (ensureAvailableCash), never from a stored 0.
    availableCash: z.number().nullable().default(null),
    availableCashStale: z.array(z.string()).default([]),
    availableCashAccountCount: z.number().int().nonnegative().default(0),
  }),
  holdings: z.array(holdingSchema),
  // F2.3 additive full-holdings fields. Defaults keep pre-existing
  // stored payloads readable: a legacy payload carries only the
  // Top 10 summary (holdingsComplete=false, holdingsAll empty,
  // holdingsTotal null) — its long tail was never stored and is
  // NOT recoverable, and its stored shares / concentration keep
  // the ingest-time full-set denominator untouched. The full set
  // appears with the next successful refresh (holdingsComplete=
  // true). holdingsTotal, when present, is the fixed denominator:
  // the sum of every valid non-cash holding, long tail included,
  // cash and 待核对 rows excluded.
  holdingsAll: z.array(holdingDetailSchema).default([]),
  holdingsCash: z.array(cashHoldingSchema).default([]),
  holdingsUnclassified: z.array(unclassifiedHoldingSchema).default([]),
  holdingsTotal: z.number().nullable().default(null),
  holdingsComplete: z.boolean().default(false),
  holdingsTruncated: z.boolean().default(false),
  investmentPerformance: investmentPerformanceSchema.default({
    startKey: null,
    endKey: null,
    startBalance: null,
    endBalance: null,
    netFlow: null,
    returnAmount: null,
    reason: null,
    monthsCovered: 0,
  }),
  cashPosition: z.number().nullable().default(null),
  concentrationTop3: z.number(),
  accounts: z.array(accountSchema),
  fire: z.object({
    annualContribution: z.number(),
    annualSpend: z.number(),
    target: z.number(),
    progress: z.number().nullable(),
    gap: z.number(),
    completeMonthsUsed: z.number().int().nonnegative().default(0),
  }),
});

type Dashboard = z.infer<typeof dashboardSchema>;

export type DashboardPayloadParseResult = { ok: true; data: Dashboard } | { ok: false };

export function parseDashboardPayload(payload: string): DashboardPayloadParseResult {
  let raw: unknown;
  try {
    raw = JSON.parse(payload);
  } catch {
    return { ok: false };
  }
  const parsed = dashboardSchema.safeParse(raw);
  return parsed.success ? { ok: true, data: parsed.data } : { ok: false };
}
type SourceEntry = z.infer<typeof sourceEntrySchema>;
type RawMonth = z.infer<typeof rawMonthSchema>;
type SnapshotCaliber = "month_end" | "month_start" | "mid_month";
type NormalizedMonth = RawMonth & {
  supersededSnapshots: number;
  snapshotCaliber: SnapshotCaliber;
};
type MonthNormalization =
  | { ok: true; months: NormalizedMonth[] }
  | { ok: false; issue: string };
type PlaidAccount = z.infer<typeof plaidAccountSchema>;
type HoldingInput = z.infer<typeof holdingInputSchema>;
type PlaidTransaction = z.infer<typeof plaidTransactionSchema>;
type TransactionCoverage = z.infer<typeof transactionCoverageSchema>;

const refreshResponse = z.object({
  ok: z.boolean(),
  status: z.enum(["started", "already_running", "error", "forbidden"]),
  message: z.string(),
});

const ingestResponse = z.object({
  ok: z.boolean(),
  savedMonths: z.number(),
  issue: z.string().nullable().default(null),
});

const excludedLiveSources = new Set([
  "titan",
  "titan_ira",
  "wealthfront_saving",
  "citi",
  "usbank_cc",
  "bonds",
]);

function isOwner(ctx: Ctx): boolean {
  return ctx.viewer?.isOwner === true;
}

function displayLabel(source: string): string {
  return source
    .replace(/_/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

type ContributionResolution = {
  value: number;
  source: "standard" | "alias" | "conflict" | "missing";
};

// F0.6: the standard field wins by EXISTENCE, not by truthiness. An
// explicit investment_contribution of 0 is a real, recorded 0 and
// must never fall back to a legacy transfer alias. When both fields
// exist with matching totals the standard value is used once (never
// summed); when they disagree the resolution degrades to "conflict":
// the standard value still governs every calculation, but the month
// is marked 待核对 and can no longer earn contribution provenance.
function resolveContribution(entries: SourceEntry[]): ContributionResolution {
  const standard = entries.filter((entry) => entry.type === "investment_contribution");
  const alias = entries.filter((entry) => entry.type === "transfer");
  const sum = (list: SourceEntry[]) => list.reduce((total, entry) => total + entry.number, 0);
  if (standard.length > 0) {
    const value = sum(standard);
    if (alias.length > 0 && Math.abs(sum(alias) - value) > 0.005) {
      return { value, source: "conflict" };
    }
    return { value, source: "standard" };
  }
  if (alias.length > 0) return { value: sum(alias), source: "alias" };
  return { value: 0, source: "missing" };
}

// F0.6: cashflow classification of a balance entry. An explicit
// cashflow_role from Firance always wins. The name-based fallback
// exists only for legacy records: HSA and bond valuations are
// non-cash, mortgage/loan balances are debt, credit-card balances
// are credit, and any other account balance is cash when positive
// and debt when negative. Only cash + credit balances may enter the
// flexible-spend back-calculation; loan principal and non-cash
// valuation changes never do.
// F1.1: the same classification decides what may count as
// available cash (可动用现金) for emergency coverage. Retirement
// balances (IRA / 401k / 403b / pension / Roth) are non-cash for
// this purpose — like HSA and bonds, a positive balance alone
// never makes an asset a deposit. Only role "cash" accounts are
// available cash; credit, debt and non-cash balances never enter
// the emergency-fund numerator.
function cashflowRoleForEntry(entry: SourceEntry): "cash" | "credit" | "debt" | "non_cash" | null {
  if (entry.cashflowRole) return entry.cashflowRole;
  if (entry.type !== "account") return null;
  const name = entry.financeSource.toLowerCase();
  if (/hsa/.test(name)) return "non_cash";
  if (/bond|treasury/.test(name)) return "non_cash";
  if (/(^|[^a-z])(ira|401k|403b|457b?|roth)([^a-z]|$)|retirement|pension/.test(name)) return "non_cash";
  if (/mortgage|loan/.test(name)) return "debt";
  if (/credit|card|_cc\b|cc_/.test(name)) return "credit";
  return entry.number < 0 ? "debt" : "cash";
}

// F0.6: snapshot date caliber. A month-end valuation (including a
// YYYY-MM filename, normalized to the last day) is "month_end"; a
// snapshot dated the 1st is "month_start" — it values the month at
// its opening, so mixing it with a month-end snapshot would compare
// different boundaries; anything else is "mid_month". Only two
// consecutive month_end snapshots share a caliber stable enough
// for the cashflow back-calculation.
function snapshotCaliber(key: string): SnapshotCaliber {
  if (key === monthEnd(key)) return "month_end";
  if (key.slice(8, 10) === "01") return "month_start";
  return "mid_month";
}

function isConsecutiveMonth(previousKey: string, currentKey: string): boolean {
  const [py = 0, pm = 0] = previousKey.slice(0, 7).split("-").map(Number);
  const [cy = 0, cm = 0] = currentKey.slice(0, 7).split("-").map(Number);
  if (!py || !pm || !cy || !cm) return false;
  return cy * 12 + cm - (py * 12 + pm) === 1;
}

// F0.3: strict real-calendar-date check. A key like 2026-02-30 must be
// rejected outright, never rolled into March by Date arithmetic.
function isRealDateKey(key: string): boolean {
  const match = key.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(0, 0, 0, 0);
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function entriesSignature(entries: SourceEntry[]): string {
  return entries
    .map((entry) => JSON.stringify([
      entry.financeSource,
      entry.type,
      entry.number,
      // F0.6: extended fields are part of a snapshot's identity —
      // two same-day snapshots differing only in classification,
      // balance date or verification metadata are a conflict, not
      // a duplicate to dedupe silently.
      entry.cashflowRole ?? null,
      entry.balanceDate ?? null,
      entry.status ?? null,
      entry.periodStart ?? null,
      entry.periodEnd ?? null,
      entry.verified ?? null,
      entry.extra ?? null,
    ]))
    .sort()
    .join("\n");
}

// F0.3: the single normalized monthly selection every consumer shares
// (charts, latestRaw fallback, FIRE, summaries). One snapshot per
// calendar month: the latest valid date in that month. Identical
// same-day duplicates dedupe; conflicting same-day snapshots and
// non-existent calendar dates are input problems, never silently
// resolved. Issue text names only the date and the problem category.
function normalizeRawMonths(rawMonths: RawMonth[]): MonthNormalization {
  // F0.6: a YYYY-MM key is a month-end valuation and normalizes to
  // that month's last day. A YYYY-MM-DD key must be a real calendar
  // date. The effective date — never the raw filename — drives all
  // later grouping and caliber decisions.
  const effective: RawMonth[] = [];
  for (const month of rawMonths) {
    if (/^\d{4}-\d{2}$/.test(month.key)) {
      const monthNumber = Number(month.key.slice(5, 7));
      if (monthNumber < 1 || monthNumber > 12) {
        return { ok: false, issue: `快照日期 ${month.key} 不是真实日历日期` };
      }
      effective.push({ ...month, key: monthEnd(month.key) });
    } else if (isRealDateKey(month.key)) {
      effective.push(month);
    } else {
      return { ok: false, issue: `快照日期 ${month.key} 不是真实日历日期` };
    }
  }
  const byDate = new Map<string, RawMonth>();
  for (const month of effective) {
    const existing = byDate.get(month.key);
    if (!existing) {
      byDate.set(month.key, month);
    } else if (entriesSignature(existing.entries) !== entriesSignature(month.entries)) {
      return { ok: false, issue: `${month.key} 同日存在内容不一致的多份快照` };
    }
  }
  const byMonth = new Map<string, NormalizedMonth[]>();
  for (const month of byDate.values()) {
    const monthKey = month.key.slice(0, 7);
    byMonth.set(monthKey, [
      ...(byMonth.get(monthKey) ?? []),
      { ...month, supersededSnapshots: 0, snapshotCaliber: snapshotCaliber(month.key) },
    ]);
  }
  const normalized: NormalizedMonth[] = [];
  for (const group of byMonth.values()) {
    const sortedGroup = [...group].sort((a, b) => a.key.localeCompare(b.key));
    const chosen = sortedGroup.at(-1);
    if (!chosen) continue;
    normalized.push({ ...chosen, supersededSnapshots: sortedGroup.length - 1 });
  }
  return { ok: true, months: normalized.sort((a, b) => a.key.localeCompare(b.key)) };
}

function monthEnd(monthKey: string): string {
  const [year = 0, month = 0] = monthKey.slice(0, 7).split("-").map(Number);
  if (!year || !month) return "";
  return new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
}

function amountMatches(amount: number, candidate: number): boolean {
  return Math.abs(Math.abs(amount) - Math.abs(candidate)) <= Math.max(2, Math.abs(candidate) * 0.01);
}

function transactionSpendForMonth(
  month: NormalizedMonth,
  transactions: PlaidTransaction[],
): number {
  const monthPrefix = month.key.slice(0, 7);
  const fixedAmounts = month.entries.filter((entry) => entry.type === "fixed_spend").map((entry) => entry.number);
  const contributionAmounts = month.entries
    .filter((entry) => entry.type === "investment_contribution" || entry.type === "transfer")
    .map((entry) => entry.number);
  return transactions
    .filter((transaction) => transaction.date.startsWith(monthPrefix) && !transaction.pending && transaction.amount > 0)
    .filter((transaction) => {
      if (transaction.internalTransfer) return false;
      if (!transaction.transferLike) return true;
      if (fixedAmounts.some((amount) => amountMatches(transaction.amount, amount))) return true;
      if (contributionAmounts.some((amount) => amountMatches(transaction.amount, amount))) return false;
      return transaction.amount < 5_000;
    })
    .reduce((sum, transaction) => sum + transaction.amount, 0);
}

function aggregateMonths(
  normalizedMonths: NormalizedMonth[],
  transactions: PlaidTransaction[],
  coverage: TransactionCoverage,
  asOf: string,
): Dashboard["months"] {
  const sorted = [...normalizedMonths].sort((a, b) => a.key.localeCompare(b.key));

  const base = sorted.map((month) => {
    const result = {
      key: month.key,
      total: 0,
      investment: 0,
      investmentContribution: 0,
      saving: 0,
      deposits: 0,
      loans: 0,
      fixedSpend: 0,
      transfer: 0,
      income: 0,
    };
    for (const entry of month.entries) {
      if (entry.type === "investment") {
        result.investment += entry.number;
        result.total += entry.number;
      } else if (entry.type === "investment_contribution") {
        result.investmentContribution += entry.number;
      } else if (entry.type === "account") {
        result.saving += entry.number;
        if (entry.number < 0) result.loans += Math.abs(entry.number);
        else result.deposits += entry.number;
        result.total += entry.number;
      } else if (entry.type === "fixed_spend") {
        result.fixedSpend += entry.number;
      } else if (entry.type === "transfer") {
        result.transfer += entry.number;
      } else if (entry.type === "income") {
        result.income += entry.number;
      }
    }
    return result;
  });

  // F0.6 flows: per-month cashflow inputs that are not balances.
  // recordedFlexible keeps the presence flag separate from the sum
  // so a recorded 0 (or a negative net refund) is never confused
  // with "no record". cashCreditNet sums ONLY account balances
  // classified cash/credit — debt (loan principal) and non-cash
  // (HSA / bond) valuation changes stay out of the spend identity.
  const flows = sorted.map((month) => {
    const flow = {
      hasRecordedFlexible: false,
      recordedFlexible: 0,
      cashflowAdjustment: 0,
      investmentExternalAdjustment: 0,
      cashCreditNet: 0,
      hasIncome: false,
      hasFixed: false,
      hasInvalidAmount: false,
    };
    for (const entry of month.entries) {
      if (!Number.isFinite(entry.number)) flow.hasInvalidAmount = true;
      if (entry.type === "flexible_spend") {
        flow.hasRecordedFlexible = true;
        flow.recordedFlexible += entry.number;
      } else if (entry.type === "cashflow_adjustment") {
        flow.cashflowAdjustment += entry.number;
      } else if (entry.type === "investment_external_adjustment") {
        flow.investmentExternalAdjustment += entry.number;
      } else if (entry.type === "income") {
        flow.hasIncome = true;
      } else if (entry.type === "fixed_spend") {
        flow.hasFixed = true;
      } else if (entry.type === "account") {
        const role = cashflowRoleForEntry(entry);
        if (role === "cash" || role === "credit") flow.cashCreditNet += entry.number;
      }
    }
    return flow;
  });

  const aggregated = base.map((month, index) => {
    const previous = index > 0 ? base[index - 1] : undefined;
    const previousFlow = index > 0 ? flows[index - 1] : undefined;
    const flow = flows[index] ?? {
      hasRecordedFlexible: false,
      recordedFlexible: 0,
      cashflowAdjustment: 0,
      investmentExternalAdjustment: 0,
      cashCreditNet: 0,
      hasIncome: false,
      hasFixed: false,
      hasInvalidAmount: false,
    };
    const source = sorted[index];
    const monthEntries = source?.entries ?? [];
    const resolved = resolveContribution(monthEntries);
    const monthContribution = resolved.value;
    const monthStart = `${month.key.slice(0, 7)}-01`;
    const end = monthEnd(month.key);
    const fullTransactionCoverage = Boolean(
      coverage?.complete &&
      end &&
      monthStart >= coverage.start &&
      end <= coverage.end,
    );
    // F1.6: the month's investment return is NOT computed inline
    // here. It is derived afterwards by recomputeInvestmentReturns
    // from the finished rows (balances, resolved contribution,
    // external adjustments and preserved entry metadata), so the
    // ingest path and the stored-payload read path share one gated
    // formula.
    // F0.6 flexible-spend decision, in strict priority order:
    // 1. A recorded flexible_spend entry wins as-is — a true 0 and
    //    a negative net refund are real values, never clamped.
    // 2. Full-coverage Plaid transactions give the month's actual
    //    spend; a negative remainder is inconsistent, so the month
    //    becomes null with the difference preserved.
    // 3. Otherwise the Firance cashflow identity may estimate it —
    //    income + other net cashflow − investment cash transfer −
    //    fixed spend − Δ(cash + credit balances) — but ONLY when
    //    the two snapshots are consecutive, both month-end caliber,
    //    classify the same cash/credit sources, carry fresh balance
    //    dates, and income / fixed / contribution are all present.
    //    Loan principal and non-cash (HSA /
    //    bond) changes are excluded by the classification itself.
    // 4. Anything else is null with a named reason and, for a
    //    negative back-calculation, the preserved difference. A
    //    balance date never proves transaction completeness.
    let flexibleSpend: number | null = null;
    let flexibleSpendSource: "recorded" | "estimated" | "missing" = "missing";
    let cashflowDifference: number | null = null;
    let cashflowNote: string | null = null;
    let missingReason: string | null = null;
    if (flow.hasInvalidAmount) {
      missingReason = "本月存在无效金额，灵活支出待核对";
    } else if (flow.hasRecordedFlexible) {
      flexibleSpend = flow.recordedFlexible;
      flexibleSpendSource = "recorded";
      cashflowNote = "来自 Firance 灵活支出实录（flexible_spend）";
    } else if (fullTransactionCoverage) {
      const fallbackMonth: NormalizedMonth = {
        key: month.key,
        entries: [],
        supersededSnapshots: 0,
        snapshotCaliber: "mid_month",
      };
      const transactionSpend = transactionSpendForMonth(source ?? fallbackMonth, transactions);
      const raw = transactionSpend - month.fixedSpend;
      if (raw < 0) {
        cashflowDifference = raw;
        missingReason = "交易实录扣除固定支出后为负数，差额已保留，灵活支出待核对";
      } else {
        flexibleSpend = raw;
        flexibleSpendSource = "recorded";
        cashflowNote = "来自 Plaid 交易实录（本月全覆盖）扣除固定支出";
      }
    } else {
      const issues: string[] = [];
      const previousSource = index > 0 ? sorted[index - 1] : undefined;
      if (!previous || !previousSource || !previousFlow) {
        issues.push("缺少上月快照，无法按现金流反推");
      } else if (!isConsecutiveMonth(previousSource.key, month.key)) {
        issues.push("与上月快照不连续（缺月），无法按现金流反推");
      }
      if (
        source?.snapshotCaliber !== "month_end" ||
        (previousSource && previousSource.snapshotCaliber !== "month_end")
      ) {
        issues.push("快照日期口径不一致：反推需要相邻两月均为月末估值（首日/月中估值不与月末混算）");
      }
      if (!flow.hasIncome) issues.push("缺少收入记录");
      if (!flow.hasFixed) issues.push("缺少固定支出记录");
      if (resolved.source === "missing") issues.push("缺少投资投入记录（标准字段与旧 transfer 均无）");
      if (previousSource && previousFlow) {
        const cashCreditSources = (entries: SourceEntry[]) =>
          entries
            .filter((entry) => entry.type === "account")
            .filter((entry) => {
              const role = cashflowRoleForEntry(entry);
              return role === "cash" || role === "credit";
            })
            .map((entry) => entry.financeSource)
            .sort()
            .join("\n");
        if (cashCreditSources(monthEntries) !== cashCreditSources(previousSource.entries)) {
          issues.push("现金/信用卡账户范围变化（新增、改名或消失），无法同口径反推");
        }
      }
      const staleBalance = monthEntries.some((entry) => {
        if (entry.type !== "account" || !entry.balanceDate) return false;
        const role = cashflowRoleForEntry(entry);
        if (role !== "cash" && role !== "credit") return false;
        return entry.balanceDate.slice(0, 7) < month.key.slice(0, 7);
      });
      if (staleBalance) issues.push("有现金/信用卡账户沿用旧余额日期，本月未更新");
      if (issues.length > 0) {
        missingReason = issues.join("；");
      } else if (previousFlow) {
        const cashCreditDelta = flow.cashCreditNet - previousFlow.cashCreditNet;
        const raw =
          month.income +
          flow.cashflowAdjustment -
          monthContribution -
          month.fixedSpend -
          cashCreditDelta;
        if (raw < 0) {
          cashflowDifference = raw;
          missingReason = "现金流反推为负数，差额已保留，灵活支出待核对";
        } else {
          flexibleSpend = raw;
          flexibleSpendSource = "estimated";
          cashflowNote =
            `现金流反推：收入 ${month.income} + 其他净现金流 ${flow.cashflowAdjustment}` +
            ` − 投资投入 ${monthContribution} − 固定支出 ${month.fixedSpend}` +
            ` − 现金/信用卡净余额变化 ${cashCreditDelta} = ${raw}`;
        }
      }
    }
    // F0.6: a contribution conflict degrades the month's provenance
    // (see contributionProven below) and is surfaced on the note,
    // but the standard value above already governed the result.
    if (resolved.source === "conflict" && flexibleSpend != null) {
      cashflowNote = `${cashflowNote ?? ""}；投入提示：标准字段与旧 transfer 金额冲突，已按标准字段计，待核对`;
    }
    const flexibleSpendAnomaly = flexibleSpend == null;
    // F0.4 integrity: the asOf month is always partial. A finished month
    // earns three separate provenance flags, each additive and never
    // inferred from absence:
    // - spendProven: the chosen snapshot date is the month's last day
    //   AND transaction coverage fully covers the month. (F0.6: a
    //   recorded or estimated flexible spend does NOT relax this —
    //   实录不自动代表完整月.)
    // - incomeProven: spendProven holds AND the snapshot carries at
    //   least one income entry. Income exists only in the Firance
    //   snapshot; no income entry means 未提供, never a proven 0.
    // - contributionProven: spendProven holds AND the contribution
    //   resolves from the standard field or the legacy alias without
    //   conflict (F0.6: a conflicting pair is not proven).
    // A month is complete only when all three hold at once (which
    // subsumes the old month-end + full-coverage + non-empty test:
    // the entry conditions imply non-empty entries). Anything missing
    // stays unknown; it is never backfilled as complete.
    const monthKey = month.key.slice(0, 7);
    const asOfMonth = asOf.slice(0, 7);
    const monthEndSnapshot = Boolean(end && month.key === end);
    const spendProven = monthKey < asOfMonth && monthEndSnapshot && fullTransactionCoverage;
    const incomeProven = spendProven && monthEntries.some((entry) => entry.type === "income");
    const contributionProven = spendProven && (resolved.source === "standard" || resolved.source === "alias");
    let integrity: "partial" | "complete" | "unknown";
    let integrityBasis: string | null = null;
    if (monthKey >= asOfMonth) {
      integrity = "partial";
      integrityBasis = `当月尚未结束，快照截至 ${month.key}`;
    } else if (spendProven && incomeProven && contributionProven) {
      integrity = "complete";
      integrityBasis = "支出：月末快照＋交易全覆盖；收入：含收入条目；投入：含投入条目";
    } else {
      integrity = "unknown";
      const missing: string[] = [];
      if (!spendProven) missing.push("支出依据");
      if (!incomeProven) missing.push("收入依据");
      if (!contributionProven) missing.push("投入依据");
      integrityBasis = `缺少${missing.join("、")}`;
    }
    return {
      ...month,
      contribution: monthContribution,
      flexibleSpend,
      flexibleSpendAnomaly,
      flexibleSpendSource,
      cashflowDifference,
      cashflowNote,
      contributionSource: resolved.source,
      investmentExternalAdjustment: flow.investmentExternalAdjustment,
      cashCreditNet: flow.cashCreditNet,
      entryMeta: monthEntries.map((entry) => ({
        financeSource: entry.financeSource,
        type: entry.type,
        cashflowRole: cashflowRoleForEntry(entry),
        balanceDate: entry.balanceDate ?? null,
        status: entry.status ?? null,
        periodStart: entry.periodStart ?? null,
        periodEnd: entry.periodEnd ?? null,
        verified: entry.verified ?? null,
      })),
      totalSpend: flexibleSpend == null ? null : month.fixedSpend + flexibleSpend,
      investmentReturn: null,
      investmentNetFlow: null,
      investmentReturnReason: null,
      snapshotDate: month.key,
      supersededSnapshots: source?.supersededSnapshots ?? 0,
      integrity,
      integrityBasis,
      spendProven,
      incomeProven,
      contributionProven,
      anomalyReason: flexibleSpendAnomaly ? missingReason : null,
    };
  });
  return recomputeInvestmentReturns(aggregated);
}

// F1.6: investment return, independently reconciled. For each month
// after the first, the return is
//   ending investment balance − starting investment balance
//   − the whole interval's external net flow,
// where the net flow is the resolved cash contribution (standard
// field or legacy alias) PLUS non-bank direct investment
// (investment_external_adjustment: RSU vesting, employer direct
// contributions; withdrawals are negative). Buys/sells inside the
// portfolio, broker-to-broker transfers and retained dividends are
// not entries of either type, so they are never double-counted as
// flows. Balances come only from the snapshots' `investment`
// entries — holdings detail never substitutes for, or adds to, the
// full investment-account balance, and the net-worth difference is
// never treated as market return.
// A month's return stays null — with a named reason — whenever the
// interval cannot be verified:
// - the first snapshot is the period's starting point, not a return;
// - the previous snapshot is not the immediately preceding month
//   (a cross-month gap spans the whole interval; the difference is
//   not a single-month return and its missing month's flows are
//   unknown);
// - the investment-account scope changed between the two snapshots
//   (an account added, renamed or removed);
// - a balance or flow entry is explicitly marked unverified, or an
//   investment balance is carried over from an older balance date;
// - the interval's flows are unknown (contribution missing, or the
//   standard/alias pair conflicts).
// Negative returns and net withdrawals keep their signs; nothing is
// clamped. Months whose preserved metadata cannot establish the
// investment-account scope (pre-F0.6 stored payloads) degrade the
// same way instead of trusting the legacy un-gated figure.
function recomputeInvestmentReturns(months: Dashboard["months"]): Dashboard["months"] {
  const flowTypes = new Set(["investment", "investment_contribution", "transfer", "investment_external_adjustment"]);
  return months.map((month, index) => {
    // Defensive reads: a stored row missing the F0.6/F1.6 fields
    // (undefined entryMeta / contributionSource) means its flows
    // are unknown, never a proven 0.
    const meta = month.entryMeta ?? [];
    const flowsKnown = month.contributionSource === "standard" || month.contributionSource === "alias";
    const netFlow = flowsKnown
      ? month.contribution + (month.investmentExternalAdjustment ?? 0)
      : null;
    if (index === 0) {
      return {
        ...month,
        investmentNetFlow: netFlow,
        investmentReturn: null,
        investmentReturnReason: "首期快照是期间起点，只作期初余额，不产生收益",
      };
    }
    const previous = months[index - 1];
    if (!previous) {
      return { ...month, investmentNetFlow: netFlow, investmentReturn: null, investmentReturnReason: "缺少上期快照" };
    }
    let reason: string | null = null;
    if (!isConsecutiveMonth(previous.key, month.key)) {
      reason = `与上期快照（${previous.key}）相隔不止一个月，差额覆盖整个区间，不作为单月收益，缺失月份的投入未知`;
    }
    const scopeOf = (row: Dashboard["months"][number]) =>
      (row.entryMeta ?? [])
        .filter((entry) => entry.type === "investment")
        .map((entry) => entry.financeSource)
        .sort()
        .join("\n");
    const scopeUnknown = (row: Dashboard["months"][number]) =>
      row.investment !== 0 && !(row.entryMeta ?? []).some((entry) => entry.type === "investment");
    if (!reason && (scopeUnknown(month) || scopeUnknown(previous))) {
      reason = "缺少投资账户范围记录（历史存档未保留账户明细），等待下次同步核对";
    }
    if (!reason && scopeOf(month) !== scopeOf(previous)) {
      reason = "投资账户范围与上期不一致（账户新增、改名或消失），收益待核对";
    }
    if (!reason) {
      const unverified = meta.some(
        (entry) => flowTypes.has(entry.type) && entry.verified === false,
      );
      if (unverified) reason = "本期投资余额或投入标记为未核实，收益待核对";
    }
    if (!reason) {
      const stale = meta.some(
        (entry) =>
          entry.type === "investment" &&
          entry.balanceDate != null &&
          entry.balanceDate.slice(0, 7) < month.key.slice(0, 7),
      );
      if (stale) reason = "有投资账户沿用旧余额日期，本期余额未更新，收益待核对";
    }
    if (!reason && month.contributionSource === "conflict") {
      reason = "投入标准字段与旧 transfer 别名冲突，期间净投入待核对";
    }
    if (!reason && !flowsKnown) {
      reason = "缺少投资投入记录，期间外部净投入未知";
    }
    if (reason || netFlow == null) {
      return {
        ...month,
        investmentNetFlow: netFlow,
        investmentReturn: null,
        investmentReturnReason: reason ?? "期间外部净投入未知",
      };
    }
    return {
      ...month,
      investmentNetFlow: netFlow,
      investmentReturn: month.investment - previous.investment - netFlow,
      investmentReturnReason: null,
    };
  });
}

// F1.6: the whole-period figure over every stored month. It is
// reported only when EVERY interval in the period reconciles — a
// single blocked interval (gap, scope change, unverified, stale,
// unknown flows) nulls the period return with that interval's
// reason, and accumulation never bridges a gap with a fabricated 0.
// Start/end balances and the summed known net flow remain visible
// as facts either way.
function computeInvestmentPerformance(months: Dashboard["months"]): Dashboard["investmentPerformance"] {
  const first = months[0];
  const last = months.at(-1);
  if (!first || !last) {
    return {
      startKey: null, endKey: null, startBalance: null, endBalance: null,
      netFlow: null, returnAmount: null, reason: "尚无投资快照", monthsCovered: 0,
    };
  }
  if (months.length < 2) {
    return {
      startKey: first.key, endKey: first.key,
      startBalance: first.investment, endBalance: first.investment,
      netFlow: null, returnAmount: null,
      reason: "只有一个期间起点，尚无可核对的投资收益期间", monthsCovered: 0,
    };
  }
  const rest = months.slice(1);
  const netFlow = rest.every((month) => month.investmentNetFlow != null)
    ? rest.reduce((sum, month) => sum + (month.investmentNetFlow ?? 0), 0)
    : null;
  const blocked = rest.find((month) => month.investmentReturn == null);
  if (blocked || netFlow == null) {
    return {
      startKey: first.key, endKey: last.key,
      startBalance: first.investment, endBalance: last.investment,
      netFlow, returnAmount: null,
      reason: blocked
        ? `${blocked.key.slice(0, 7)}：${blocked.investmentReturnReason ?? "该区间收益待核对"}`
        : "期间外部净投入未知",
      monthsCovered: months.length - 1,
    };
  }
  return {
    startKey: first.key, endKey: last.key,
    startBalance: first.investment, endBalance: last.investment,
    netFlow,
    returnAmount: last.investment - first.investment - netFlow,
    reason: null,
    monthsCovered: months.length - 1,
  };
}

function sourceCanUseLive(source: string): boolean {
  const lower = source.toLowerCase();
  if (excludedLiveSources.has(lower) || lower.startsWith("fidelity_")) return false;
  return /_\d{4}$/.test(lower);
}

function normalizedLiveValue(account: PlaidAccount): number | null {
  if (account.current == null || !Number.isFinite(account.current)) return null;
  const type = account.type.toLowerCase();
  if (type === "credit" || type === "loan") return -Math.abs(account.current);
  return account.current;
}

function findPlaidAccount(source: string, plaidAccounts: PlaidAccount[]): PlaidAccount | undefined {
  if (!sourceCanUseLive(source)) return undefined;
  const mask = source.slice(-4);
  const candidates = plaidAccounts.filter((account) => account.mask === mask && account.current != null);
  if (candidates.length <= 1) return candidates[0];
  const normalizedSource = source.toLowerCase().replace(/[^a-z0-9]/g, "");
  return candidates.find((account) => {
    const institution = account.institution.toLowerCase().replace(/[^a-z0-9]/g, "");
    const name = account.name.toLowerCase().replace(/[^a-z0-9]/g, "");
    return normalizedSource.includes(institution) || normalizedSource.includes(name);
  }) ?? candidates[0];
}

function mergeLatestEntries(entries: SourceEntry[], plaidAccounts: PlaidAccount[]): Dashboard["accounts"] {
  return entries.map((entry) => {
    const match = findPlaidAccount(entry.financeSource, plaidAccounts);
    const liveValue = match ? normalizedLiveValue(match) : null;
    // F1.1: classification and balance date travel with the merged
    // row. The value itself is never rewritten by classification —
    // excluded accounts keep their original balance in net worth
    // and in the account list; they simply are not available cash.
    const role = entry.type === "account" ? cashflowRoleForEntry(entry) : null;
    return {
      source: entry.financeSource,
      label: displayLabel(entry.financeSource),
      type: entry.type,
      value: liveValue ?? entry.number,
      live: liveValue != null,
      institution: match?.institution ?? null,
      mask: match?.mask ?? null,
      cashflowRole: role,
      balanceDate: entry.balanceDate ?? null,
      availableCash: role === "cash",
    };
  });
}

// F1.1: the available-cash summary over the merged account rows of
// the latest snapshot, sharing F0.5's per-source balance dates (no
// second source ledger). Rules:
// - only rows classified "cash" count; non-cash (HSA / bonds /
//   retirement), credit and debt rows are excluded whatever their
//   balance — a positive balance alone never qualifies;
// - no cash row at all -> amount null （缺失）, never 0;
// - a cash row whose explicit balanceDate predates the source
//   month is stale （沿用旧余额） -> amount null and the source is
//   named in staleSources, so no coverage is fabricated from old
//   cash. A row without an explicit balance date is dated by its
//   snapshot (sourceMonth), exactly as the monthly records show;
// - otherwise the amount is the plain sum of the cash rows'
//   original balances (a true 0 stays a real 0).
function summarizeAvailableCash(
  accounts: Dashboard["accounts"],
  sourceMonth: string,
): { amount: number | null; staleSources: string[]; accountCount: number } {
  const cashAccounts = accounts.filter((account) => {
    if (account.type !== "account") return false;
    const role = account.cashflowRole
      ?? cashflowRoleForEntry({ financeSource: account.source, type: "account", number: account.value });
    return role === "cash";
  });
  if (cashAccounts.length === 0) {
    return { amount: null, staleSources: [], accountCount: 0 };
  }
  const sourceMonthKey = sourceMonth.slice(0, 7);
  const staleSources = cashAccounts
    .filter((account) => account.balanceDate != null && account.balanceDate.slice(0, 7) < sourceMonthKey)
    .map((account) => account.source);
  if (staleSources.length > 0) {
    return { amount: null, staleSources, accountCount: cashAccounts.length };
  }
  return {
    amount: cashAccounts.reduce((sum, account) => sum + account.value, 0),
    staleSources: [],
    accountCount: cashAccounts.length,
  };
}

// F1.1 read path: (re)derive the available-cash summary from the
// stored account rows and the dashboard's own sourceMonth, so
// legacy payloads (whose rows predate the classification fields)
// get the same classified numerator as a fresh ingest — derived
// from their preserved balances and names, never backfilled into
// storage and never taken from the broader `deposits` fact.
function ensureAvailableCash(dashboard: Dashboard): Dashboard {
  const summary = summarizeAvailableCash(dashboard.accounts, dashboard.sourceMonth);
  return {
    ...dashboard,
    accounts: dashboard.accounts.map((account) => {
      if (account.type !== "account") return account;
      const role = account.cashflowRole
        ?? cashflowRoleForEntry({ financeSource: account.source, type: "account", number: account.value });
      return { ...account, cashflowRole: role, availableCash: role === "cash" };
    }),
    live: {
      ...dashboard.live,
      availableCash: summary.amount,
      availableCashStale: summary.staleSources,
      availableCashAccountCount: summary.accountCount,
    },
  };
}

function cleanSecurityName(name: string, ticker: string): string {
  const compact = name.trim().replace(/\s+/g, " ");
  const repeated = compact.match(/^(.+?)(?:\s*[·|/—-]\s*|\s+)(\1)$/i);
  if (repeated?.[1]) return repeated[1].trim();
  const words = compact.split(" ");
  if (words.length > 1 && words.length % 2 === 0) {
    const midpoint = words.length / 2;
    const firstHalf = words.slice(0, midpoint).join(" ");
    const secondHalf = words.slice(midpoint).join(" ");
    if (firstHalf.localeCompare(secondHalf, undefined, { sensitivity: "accent" }) === 0) return firstHalf;
  }
  return compact.toUpperCase() === ticker ? "" : compact;
}

// F2.3: holdings normalization keeps the FULL set, not just a
// Top 10. Every input row is classified exactly once:
// - cash rows (CUR:* tickers) are listed separately, each with
//   its own currency; only CUR:USD sums into `cashPosition`.
//   Cash never enters the holdings denominator.
// - valid holdings are positive, carry a known USD currency and
//   merge by ticker across accounts (the institutions holding
//   the ticker are kept on the merged row as a factual note).
// - everything else — missing market value, negative or zero
//   position, unknown currency, non-USD currency — is preserved
//   as a 待核对 row with the reason. It is never dropped, never
//   absolved, and never defaulted to a USD positive holding.
// The denominator (`holdingsTotal`) is the sum of ALL valid
// holdings, long tail included, computed once here; shares and
// the Top-3 concentration always divide by it — never by a
// truncated or search-filtered subset. The stored full set is
// bounded (MAX_ALL_HOLDINGS merged tickers, largest kept); if the
// bound ever bites, `truncated` is set and the denominator still
// covers every valid holding. This function is intentionally
// self-contained (plus cleanSecurityName) so validation suites
// can extract it on its own.
function normalizeHoldings(inputs: HoldingInput[]): {
  holdings: Dashboard["holdings"];
  allHoldings: Dashboard["holdingsAll"];
  cashHoldings: Dashboard["holdingsCash"];
  unclassifiedHoldings: Dashboard["holdingsUnclassified"];
  cashPosition: number | null;
  concentrationTop3: number;
  holdingsTotal: number | null;
  truncated: boolean;
} {
  const MAX_ALL_HOLDINGS = 500;
  const byTicker = new Map<string, { name: string; value: number; institutions: string[] }>();
  const cashByKey = new Map<string, { ticker: string; name: string; value: number; currency: string | null }>();
  const unclassified: Dashboard["holdingsUnclassified"] = [];
  let usdCash = 0;
  const currencyOf = (item: HoldingInput): string | null => {
    const raw = item.currency?.trim().toUpperCase();
    return raw ? raw : null;
  };
  for (const item of inputs) {
    const ticker = (item.ticker?.trim() || item.name.trim()).toUpperCase();
    if (!ticker) continue;
    const value = item.value;
    const currency = currencyOf(item);
    if (ticker.startsWith("CUR:")) {
      const cashCurrency = currency ?? (ticker.slice(4) || null);
      if (value == null || !Number.isFinite(value)) {
        unclassified.push({ ticker, name: cleanSecurityName(item.name, ticker), value: null, currency: cashCurrency, reason: "现金市值缺失，未计入" });
      } else if (value < 0) {
        unclassified.push({ ticker, name: cleanSecurityName(item.name, ticker), value, currency: cashCurrency, reason: "现金头寸为负，未计入" });
      } else if (value > 0) {
        const key = `${ticker}|${cashCurrency ?? ""}`;
        const current = cashByKey.get(key);
        cashByKey.set(key, {
          ticker,
          name: current?.name || cleanSecurityName(item.name, ticker),
          value: (current?.value ?? 0) + value,
          currency: cashCurrency,
        });
        if (ticker === "CUR:USD") usdCash += value;
      }
      continue;
    }
    if (value == null || !Number.isFinite(value)) {
      unclassified.push({ ticker, name: cleanSecurityName(item.name, ticker), value: null, currency, reason: "缺少市值，未计入分母" });
      continue;
    }
    if (value < 0) {
      unclassified.push({ ticker, name: cleanSecurityName(item.name, ticker), value, currency, reason: "负头寸，未计入分母" });
      continue;
    }
    if (value === 0) {
      unclassified.push({ ticker, name: cleanSecurityName(item.name, ticker), value, currency, reason: "市值为 0，未计入分母" });
      continue;
    }
    if (currency == null) {
      unclassified.push({ ticker, name: cleanSecurityName(item.name, ticker), value, currency: null, reason: "币种不明，未默认美元，未计入分母" });
      continue;
    }
    if (currency !== "USD") {
      unclassified.push({ ticker, name: cleanSecurityName(item.name, ticker), value, currency, reason: `币种 ${currency}，未并入美元分母` });
      continue;
    }
    const current = byTicker.get(ticker);
    const institutions = current?.institutions ?? [];
    const institution = item.institution?.trim();
    if (institution && !institutions.includes(institution)) institutions.push(institution);
    byTicker.set(ticker, {
      name: current?.name || cleanSecurityName(item.name, ticker),
      value: (current?.value ?? 0) + value,
      institutions,
    });
  }
  const sorted = [...byTicker.entries()]
    .map(([ticker, item]) => ({ ticker, ...item }))
    .sort((a, b) => b.value - a.value);
  const total = sorted.reduce((sum, item) => sum + item.value, 0);
  const truncated = sorted.length > MAX_ALL_HOLDINGS;
  const retained = truncated ? sorted.slice(0, MAX_ALL_HOLDINGS) : sorted;
  const shareOf = (value: number) => (total > 0 ? value / total : 0);
  const allHoldings = retained.map((item) => ({ ...item, share: shareOf(item.value) }));
  const holdings = sorted.slice(0, 10).map((item) => ({
    ticker: item.ticker,
    name: item.name,
    value: item.value,
    share: shareOf(item.value),
  }));
  const concentrationTop3 = total > 0
    ? sorted.slice(0, 3).reduce((sum, item) => sum + item.value, 0) / total
    : 0;
  const cashHoldings = [...cashByKey.values()].sort((a, b) => b.value - a.value);
  return {
    holdings,
    allHoldings,
    cashHoldings,
    unclassifiedHoldings: unclassified,
    cashPosition: usdCash > 0 ? usdCash : null,
    concentrationTop3,
    holdingsTotal: sorted.length > 0 ? total : null,
    truncated,
  };
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

// F0.4 consumption boundary: only complete, non-anomalous months are
// "完整且有效月" and may enter FIRE denominators. Partial, unknown and
// anomalous months are excluded — never replaced with 0.
// F0.4 provenance guard: the "complete" stamp alone is not enough —
// all three provenance flags must be true as well. A legacy stored
// payload may carry a "complete" stamp written by an older version
// while the flags are missing / false (the schema defaults them to
// false); such a month has no proven basis and must not inflate the
// FIRE denominator. (aggregateMonths only stamps complete when all
// three flags hold, so the write path is unchanged.)
function validCompleteMonths(months: Dashboard["months"]): Dashboard["months"] {
  return months.filter(
    (month) =>
      month.integrity === "complete" &&
      month.spendProven === true &&
      month.incomeProven === true &&
      month.contributionProven === true &&
      !month.flexibleSpendAnomaly,
  );
}

// F0.4 read-path integrity normalization for stored payloads: a month
// stamped "complete" by an older writer but missing any of the three
// provenance flags is downgraded to "unknown" on read, with a basis
// naming exactly which bases are missing and stating it is treated
// as integrity-not-provided. The month's numeric facts (balances,
// income, spend, contribution) and dates are preserved untouched —
// only the integrity stamp and its basis change. Months already
// partial / unknown, and complete months with all three flags true,
// pass through unchanged.
function normalizeStoredIntegrity(
  month: Dashboard["months"][number],
): Dashboard["months"][number] {
  if (month.integrity !== "complete") return month;
  const missing: string[] = [];
  if (month.spendProven !== true) missing.push("支出依据");
  if (month.incomeProven !== true) missing.push("收入依据");
  if (month.contributionProven !== true) missing.push("投入依据");
  if (missing.length === 0) return month;
  return {
    ...month,
    integrity: "unknown",
    integrityBasis: `旧存档完整标记缺少${missing.join("、")}，按完整性未提供处理`,
  };
}

function normalizedFireSpend(month: Dashboard["months"][number]): number {
  // F0.6: flexibleSpend may be null (missing). FIRE only consumes
  // valid complete months, which always carry a value; the ?? 0
  // here is a type guard for legacy rows, never a data fill.
  return Math.max(0, month.fixedSpend + Math.max(0, month.flexibleSpend ?? 0));
}

function computeFire(months: Dashboard["months"], netWorth: number): Dashboard["fire"] {
  const used = validCompleteMonths(months).slice(-12);
  const annualContribution = average(used.map((month) => month.contribution)) * 12;
  const annualSpend = average(used.map(normalizedFireSpend)) * 12;
  const target = annualSpend > 0 ? annualSpend / 0.04 : 0;
  const progress = target > 0 ? netWorth / target : null;
  return {
    annualContribution,
    annualSpend,
    target,
    progress,
    gap: Math.max(0, target - netWorth),
    completeMonthsUsed: used.length,
  };
}

function normalizeFireMetrics(dashboard: Dashboard): Dashboard {
  const months = dashboard.months.map((storedMonth) => {
    // F0.4: downgrade unproven legacy "complete" stamps first, so the
    // FIRE recompute below and every downstream consumer see the same
    // integrity verdict (see normalizeStoredIntegrity).
    const month = normalizeStoredIntegrity(storedMonth);
    // F0.6 read-path normalization for stored payloads:
    // - a null flexible spend stays null and anomalous (missing is
    //   never re-filled with 0 on read);
    // - a RECORDED negative flexible spend is a real net refund and
    //   is preserved exactly;
    // - only legacy estimated negatives keep the old clamp-to-0
    //   behaviour, flagged anomalous as before.
    if (month.flexibleSpend == null) {
      return { ...month, flexibleSpend: null, flexibleSpendAnomaly: true, totalSpend: null };
    }
    if (month.flexibleSpendSource === "recorded") {
      return {
        ...month,
        totalSpend: month.fixedSpend + month.flexibleSpend,
      };
    }
    const hadNegativeFlexibleSpend = month.flexibleSpend < 0;
    const flexibleSpend = Math.max(0, month.flexibleSpend);
    return {
      ...month,
      flexibleSpend,
      flexibleSpendAnomaly: month.flexibleSpendAnomaly || hadNegativeFlexibleSpend,
      totalSpend: month.fixedSpend + flexibleSpend,
    };
  });
  // F1.6 read path: stored months are re-derived through the same
  // gated reconciliation as ingest — a legacy figure computed as
  // "balance difference − cash contribution only" is never trusted,
  // because it can mistake RSU / employer direct investment for
  // market return and never checked scope, gaps or verification.
  const reconciled = recomputeInvestmentReturns(months);
  return {
    ...dashboard,
    months: reconciled,
    investmentPerformance: computeInvestmentPerformance(reconciled),
    fire: computeFire(reconciled, dashboard.live.netWorth),
  };
}

function buildDashboard(
  asOf: string,
  normalizedMonths: NormalizedMonth[],
  plaidAccounts: PlaidAccount[],
  holdingInputs: HoldingInput[],
  plaidTransactions: PlaidTransaction[],
  transactionCoverage: TransactionCoverage,
  previousLiveNetWorth: number | null,
): Dashboard | null {
  const months = aggregateMonths(normalizedMonths, plaidTransactions, transactionCoverage, asOf);
  // Same normalized selection as the charts: the latest month's chosen
  // snapshot is the one and only latestRaw for balance fallback.
  const latestRaw = normalizedMonths.at(-1);
  if (!latestRaw || months.length === 0) return null;
  const accounts = mergeLatestEntries(latestRaw.entries, plaidAccounts);
  const liveInvestment = accounts
    .filter((account) => account.type === "investment")
    .reduce((sum, account) => sum + account.value, 0);
  const cashAccounts = accounts.filter((account) => account.type === "account");
  const liveDeposits = cashAccounts
    .filter((account) => account.value >= 0)
    .reduce((sum, account) => sum + account.value, 0);
  const liveLoans = cashAccounts
    .filter((account) => account.value < 0)
    .reduce((sum, account) => sum + Math.abs(account.value), 0);
  const liveSaving = liveDeposits - liveLoans;
  const liveNetWorth = liveInvestment + liveDeposits - liveLoans;
  const normalized = normalizeHoldings(holdingInputs);
  // F1.1: net worth above still uses every balance as recorded;
  // the emergency numerator is the classified cash subset only.
  const availableCashSummary = summarizeAvailableCash(accounts, latestRaw.key);

  return {
    asOf,
    sourceMonth: latestRaw.key,
    months,
    live: {
      netWorth: liveNetWorth,
      investment: liveInvestment,
      saving: liveSaving,
      deposits: liveDeposits,
      loans: liveLoans,
      weeklyDelta: previousLiveNetWorth == null ? null : liveNetWorth - previousLiveNetWorth,
      availableCash: availableCashSummary.amount,
      availableCashStale: availableCashSummary.staleSources,
      availableCashAccountCount: availableCashSummary.accountCount,
    },
    holdings: normalized.holdings,
    // F2.3: the payload persists the bounded FULL normalized set
    // alongside the Top 10 summary, with the fixed denominator —
    // display truncation and search never recompute either.
    holdingsAll: normalized.allHoldings,
    holdingsCash: normalized.cashHoldings,
    holdingsUnclassified: normalized.unclassifiedHoldings,
    holdingsTotal: normalized.holdingsTotal,
    holdingsComplete: true,
    holdingsTruncated: normalized.truncated,
    investmentPerformance: computeInvestmentPerformance(months),
    cashPosition: normalized.cashPosition,
    concentrationTop3: normalized.concentrationTop3,
    accounts: accounts.sort((a, b) => {
      if (a.type !== b.type) return a.type.localeCompare(b.type);
      return Math.abs(b.value) - Math.abs(a.value);
    }),
    fire: computeFire(months, liveNetWorth),
  };
}

// F2.3 read path: shares and the Top-3 concentration stored in a
// payload were computed at ingest against the FIXED denominator
// (every valid non-cash holding, long tail included). They are
// preserved exactly here — recomputing them from the stored
// Top 10 rows would silently shrink the denominator to the
// summary subset, which is precisely what F2.3 forbids. The only
// repair left is for ancient payloads that still carry a CUR:USD
// row inside the holdings lists: the row is folded into the
// separately listed cash (its value was never part of the stored
// shares' denominator for payloads written by normalizeHoldings,
// and for older ones the stored figures remain the best record —
// still never a Top-10-only recomputation).
function ensureHoldingsConsistency(dashboard: Dashboard): Dashboard {
  let cashPosition = dashboard.cashPosition ?? 0;
  const separate = <T extends { ticker: string; name: string; value: number }>(rows: T[]): T[] =>
    rows
      .filter((row) => {
        if (row.ticker.toUpperCase() !== "CUR:USD") return true;
        cashPosition += row.value;
        return false;
      })
      .map((row) => ({ ...row, name: cleanSecurityName(row.name, row.ticker) }));
  return {
    ...dashboard,
    holdings: separate(dashboard.holdings),
    holdingsAll: separate(dashboard.holdingsAll),
    cashPosition: cashPosition > 0 ? cashPosition : null,
  };
}

function ensureSplitBalances(dashboard: Dashboard): Dashboard {
  if (dashboard.live.deposits != null && dashboard.live.loans != null) return dashboard;
  const cashAccounts = dashboard.accounts.filter((account) => account.type === "account");
  const deposits = cashAccounts
    .filter((account) => account.value >= 0)
    .reduce((sum, account) => sum + account.value, 0);
  const loans = cashAccounts
    .filter((account) => account.value < 0)
    .reduce((sum, account) => sum + Math.abs(account.value), 0);
  return {
    ...dashboard,
    live: {
      ...dashboard.live,
      deposits,
      loans,
    },
  };
}

async function getState(ctx: Ctx) {
  const db = ctx.db<typeof schema>();
  const rows = await db.select().from(schema.financeState).where(eq(schema.financeState.id, 1)).limit(1);
  return rows[0];
}

const staleRefreshThresholdMs = 2 * 60 * 60 * 1000;

function isStaleRunningState(state: Awaited<ReturnType<typeof getState>>): boolean {
  return Boolean(
    state?.status === "running" &&
    Date.now() - state.updatedAt.getTime() > staleRefreshThresholdMs,
  );
}

async function writeState(
  ctx: Ctx,
  values: {
    payload?: string | null;
    previousLiveNetWorth?: number | null;
    status: "idle" | "running" | "error";
    taskId?: string | null;
    message?: string | null;
  },
) {
  const existing = await getState(ctx);
  const row = {
    id: 1,
    payload: values.payload === undefined ? (existing?.payload ?? null) : values.payload,
    previousLiveNetWorth: values.previousLiveNetWorth === undefined
      ? (existing?.previousLiveNetWorth ?? null)
      : values.previousLiveNetWorth,
    status: values.status,
    taskId: values.taskId ?? null,
    message: values.message ?? null,
    updatedAt: new Date(),
  };
  await ctx.db<typeof schema>()
    .insert(schema.financeState)
    .values(row)
    .onConflictDoUpdate({ target: schema.financeState.id, set: row });
}

export const Actions = {
  getDashboard: defineAction({
    request: z.object({}),
    response: z.object({
      access: z.enum(["owner", "guest_denied"]),
      data: dashboardSchema.nullable(),
      refresh: z.object({
        status: z.enum(["idle", "running", "error"]),
        message: z.string().nullable(),
        updatedAt: z.string().nullable(),
      }),
    }),
    async handler(ctx) {
      if (!isOwner(ctx)) {
        return {
          access: "guest_denied" as const,
          data: null,
          refresh: { status: "idle" as const, message: "财务数据仅所有者可查看", updatedAt: null },
        };
      }
      const state = await getState(ctx);
      let data: Dashboard | null = null;
      let payloadCorrupted = false;
      if (state?.payload) {
        const parsed = parseDashboardPayload(state.payload);
        if (parsed.ok) {
          data = ensureAvailableCash(normalizeFireMetrics(ensureSplitBalances(ensureHoldingsConsistency(parsed.data))));
        } else {
          payloadCorrupted = true;
        }
      }
      const staleRunning = isStaleRunningState(state);
      return {
        access: "owner" as const,
        data,
        refresh: {
          status: payloadCorrupted ? "error" : staleRunning ? "error" : (state?.status ?? "idle"),
          message: payloadCorrupted
            ? "已保存数据损坏，重新更新可恢复"
            : staleRunning ? "上次更新未完成，可以重新更新" : (state?.message ?? null),
          updatedAt: state?.updatedAt?.toISOString() ?? null,
        },
      };
    },
  }),

  refreshFinanceData: defineAction({
    request: z.object({}),
    response: refreshResponse,
    async handler(ctx): Promise<z.infer<typeof refreshResponse>> {
      if (!isOwner(ctx)) {
        return { ok: false, status: "forbidden", message: "财务数据仅所有者可更新" };
      }
      const state = await getState(ctx);
      if (state?.status === "running" && !isStaleRunningState(state)) {
        return { ok: true, status: "already_running", message: "每周更新正在进行中" };
      }
      await writeState(ctx, { status: "running", message: "正在同步 Firance 与 Plaid" });
      ctx.invalidateQueries();
      const task = await ctx.agent.spawnTask(
        `刷新“每周财务总览”的真实数据。只读，不得写 Mac 文件，不得操作任何金融账户。\n\n1. 先定位目标设备：用设备列表工具列出当前可访问的设备，按设备名找到用户的 Mac mini（设备名含 “Mac mini” 的那台），本次刷新只使用这个运行时解析出的设备 ID。若按设备名找不到 Mac mini，或有多台候选无法唯一确定，不要猜测、不要用任何预置或写死的 ID 兜底，立即以 success:false 回调 ingestFinanceData 并在 error 中明确说明未能按设备名定位 Mac mini。在定位到的 Mac mini 上，先在运行时解析当前登录用户的主目录（home directory），再据此构造 Firance 数据目录为 <home>/Library/Application Support/Firance/FinanceData/（即 ~/Library/Application Support/Firance/FinanceData/）；不得使用任何写死的用户名或绝对用户路径。若无法解析主目录，不要猜测路径，立即以 success:false 回调 ingestFinanceData 并在 error 中说明无法解析主目录。然后用文件列表工具列出该目录，再读取全部文件名符合 YYYY-MM-DD 或 YYYY-MM 的无扩展名文件，月份键必须原样返回文件名、不要自行补成某一天（服务端会把 YYYY-MM 归一为该月月末估值）。每条记录是一组 key/value 行，至少含 finance_source、type、number；现行 Firance 记录还可能带 cashflow_role、balance_date、status、period_start、period_end、verified 等扩展行，且每条记录的行数不固定，必须按 key 解析、不得假定恰好三行或固定顺序。只保留 type 为 investment、investment_contribution、account、fixed_spend、transfer、income、flexible_spend、cashflow_adjustment、investment_external_adjustment 且 number 为有限数字的记录；扩展行按原 key 映射返回：cashflow_role→cashflowRole（cash/credit/debt/non_cash）、balance_date→balanceDate、status→status、period_start→periodStart、period_end→periodEnd、verified→verified，其余未知扩展 key 原样放入该记录的 extra 对象（值按数字/布尔/字符串原样保留）。原始文件只读，不得回写，不得为历史记录补造核实标记。若 Mac 不在线或文件读取失败，不要伪造；用 success:false 回调并说明失败。\n2. 在 Muse runtime 依次运行只读命令 plaid accounts、plaid liabilities、plaid investments-holdings。将账户整理为 institution/name/type/subtype/mask/current。将 mortgage current 余额作为 loan 账户返回；不要返回内部 account_id 或 credential_id。将 holdings 按 security_id 与 securities 关联后逐条返回，不要预先截断为 Top 10（服务端会保留全量规范化集合）：每条返回 ticker/name/value（取 institution_value）/currency/institution，其中 currency 为该持仓的 iso_currency_code（确实无法确定时返回 null，不得默认填 USD）、institution 为持仓所在机构名称；institution_value 缺失时 value 返回 null，负值原样返回，不得丢弃、不得取绝对值；不要返回任何内部 ID、原始 JSON 或凭证。\n3. 再用 Plaid transactions 拉取 checking/savings 账户最多最近 730 天的交易，分页取全。只返回 date、amount、name、pending，以及根据 Plaid 类别和交易对手判断的 internalTransfer（自己名下账户互转）与 transferLike（疑似转账）布尔值；Plaid 正数表示流出。返回 transactionCoverage={start,end,complete}，只有覆盖区间内分页完整无缺失时 complete=true；交易读取失败时保留其他数据并将 transactionCoverage 设为 null、plaidTransactions 设为空数组。\n4. 完成后调用 ingestFinanceData。成功参数必须是：{success:true,asOf:<带时区ISO>,months:[{key,entries:[{financeSource,type,number,可选 cashflowRole/balanceDate/status/periodStart/periodEnd/verified/extra}]}],plaidAccounts:[{institution,name,type,subtype,mask,current}],holdings:[{ticker,name,value,currency,institution}],plaidTransactions:[{date,amount,name,pending,internalTransfer,transferLike}],transactionCoverage:{start,end,complete}|null}。Firance、账户余额或持仓任一步无法可靠完成时调用 {success:false,error:<简洁中文>}；只有交易读取失败按上述方式回退，不使整次刷新失败。不要发送聊天消息。`,
        { expectsAction: "ingestFinanceData", dedupeKey: "weekly-firance-finance-refresh" },
      );
      if (!task.ok) {
        await writeState(ctx, { status: "error", message: "本次更新失败，显示上次数据" });
        ctx.invalidateQueries();
        return { ok: false, status: "error", message: "刷新任务未能启动" };
      }
      await writeState(ctx, { status: "running", taskId: task.taskId, message: "正在同步 Firance 与 Plaid" });
      return { ok: true, status: "started", message: "更新已开始" };
    },
  }),

  ingestFinanceData: defineAction({
    request: z.discriminatedUnion("success", [
      z.object({ success: z.literal(false), error: z.string().min(1).max(500) }),
      z.object({
        success: z.literal(true),
        asOf: z.string().min(10).max(80),
        months: z.array(rawMonthSchema).min(1).max(240),
        plaidAccounts: z.array(plaidAccountSchema).max(100),
        holdings: z.array(holdingInputSchema).max(1000),
        plaidTransactions: z.array(plaidTransactionSchema).max(20_000).default([]),
        transactionCoverage: transactionCoverageSchema.default(null),
      }),
    ]),
    response: ingestResponse,
    async handler(ctx, args): Promise<z.infer<typeof ingestResponse>> {
      if (!isOwner(ctx)) return { ok: false, savedMonths: 0, issue: null };
      if (!args.success) {
        await writeState(ctx, { status: "error", message: "本次更新失败，显示上次数据" });
        ctx.invalidateQueries();
        return { ok: false, savedMonths: 0, issue: null };
      }
      // F0.3 gate: invalid calendar dates and conflicting same-day
      // snapshots are input problems. The stored payload and its asOf
      // are left untouched; the issue names only the date and the
      // problem category, never the submitted values.
      const normalization = normalizeRawMonths(args.months);
      if (!normalization.ok) {
        await writeState(ctx, {
          status: "error",
          message: `本次更新未保存：${normalization.issue}。已保留上次成功数据，修正后可重新更新。`,
        });
        ctx.invalidateQueries();
        return { ok: false, savedMonths: 0, issue: normalization.issue };
      }
      const state = await getState(ctx);
      let previousLiveNetWorth: number | null = null;
      if (state?.payload) {
        const prior = parseDashboardPayload(state.payload);
        if (prior.ok) previousLiveNetWorth = prior.data.live.netWorth;
      }
      const dashboard = buildDashboard(
        args.asOf,
        normalization.months,
        args.plaidAccounts,
        args.holdings,
        args.plaidTransactions,
        args.transactionCoverage,
        previousLiveNetWorth,
      );
      if (!dashboard) {
        await writeState(ctx, { status: "error", message: "本次更新没有可用的月度数据，显示上次数据" });
        ctx.invalidateQueries();
        return { ok: false, savedMonths: 0, issue: null };
      }
      await writeState(ctx, {
        payload: JSON.stringify(dashboard),
        previousLiveNetWorth,
        status: "idle",
        message: "更新完成",
      });
      ctx.invalidateQueries();
      return { ok: true, savedMonths: dashboard.months.length, issue: null };
    },
  }),
} satisfies ActionsModule;
