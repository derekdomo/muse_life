import { defineAction, z, type ActionsModule, type Ctx } from "@hatch/space-sdk";
import { and, desc, eq, isNull } from "drizzle-orm";
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
  // F1.6 rework additive: the Firance-native investment keys
  // (investment_period_start / investment_period_end /
  // investment_flow_verified), promoted verbatim from the record's
  // extra at ingest. They coexist with the generic period /
  // verified fields above and never overwrite them; defaults keep
  // pre-existing stored payloads readable (native fields absent).
  nativePeriodStart: z.string().nullable().default(null),
  nativePeriodEnd: z.string().nullable().default(null),
  nativeFlowVerified: z.boolean().nullable().default(null),
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
  // F1.1 rework additive: the entry's explicit verification state,
  // carried from the latest snapshot's entryMeta so unverified cash
  // can be excluded from coverage without hiding the recorded
  // balance. Legacy rows carry null (核实状态未提供) and keep the
  // legacy degradation caliber — never backfilled as verified.
  verified: z.boolean().nullable().default(null),
  // F1.1 rework additive (native status): the entry's raw Firance
  // status string, carried with the row so the read path can treat
  // status values such as carried_forward_unverified as unverified
  // even when no boolean verified flag was stored. Null default
  // keeps legacy rows readable (status not provided).
  status: z.string().nullable().default(null),
  // F1.1 conflict additive: true when this row's metadata could
  // not be uniquely associated on the read path because duplicate
  // same-snapshot, same-name, same-type entryMeta rows conflict
  // on a field (see ensureAvailableCash). The conflicted field
  // itself stays null — no winner is picked — and the flag keeps
  // the conflict distinguishable from a legacy row that simply
  // never carried metadata: a conflicted cash account is withheld
  // from coverage and named as 元数据冲突待核对， while a truly
  // metadata-free legacy row keeps the legacy caliber. Default
  // false keeps pre-existing stored payloads readable.
  metadataConflict: z.boolean().default(false),
});

// F-ARCH-001: the stored new-architecture total-assets payload.
// Written only by ingestArchNetWorth (server-recomputed, read-back
// verified) and surfaced on the dashboard as an overlay read from
// the arch_net_worth table — the legacy finance payload itself
// never carries it, so buildDashboard always emits null and the
// .default(null) keeps pre-existing stored payloads readable.
const archNetWorthRangeSchema = z.object({
  oldest: z.string(),
  newest: z.string(),
});

const archNetWorthRowSchema = z.object({
  id: z.string(),
  included: z.boolean(),
  signed: z.number().nullable(),
  asOf: z.string().nullable(),
  coverage: z.enum(["plaid", "snapshot", "missing"]),
});

const archNetWorthSchema = z.object({
  arch: z.literal("F-ARCH-001"),
  version: z.literal(1),
  pulledAt: z.string(),
  storedAt: z.string(),
  total: z.number(),
  partial: z.boolean(),
  missing: z.array(z.string()),
  plaidRange: archNetWorthRangeSchema.nullable(),
  snapshotRange: archNetWorthRangeSchema.nullable(),
  rows: z.array(archNetWorthRowSchema),
  // F-ARCH-001·DATE-1 (P1) coverage counts. The denominator is
  // ALWAYS rows.length — it never shrinks when a date is bad or
  // an amount is missing. amountIncluded counts rows whose
  // balance is in the total; validDateCount counts the included
  // rows whose asOf is a real calendar date. Defaults keep
  // payloads stored before these fields existed parseable; the
  // read path (sanitizeArchNetWorthDates) recomputes them from
  // the rows on every read, so a stored 0 default is never
  // presented as a measured count.
  amountIncluded: z.number().int().nonnegative().default(0),
  amountTotal: z.number().int().nonnegative().default(0),
  validDateCount: z.number().int().nonnegative().default(0),
  dateTotal: z.number().int().nonnegative().default(0),
});

type ArchNetWorth = z.infer<typeof archNetWorthSchema>;

// F-ARCH-001·DATE-1 read-path date eligibility (pure). Stored
// rows are NEVER rewritten: a legacy row whose asOf is not a
// real calendar date (2026-02-30 and friends, persisted before
// the write gate existed) keeps its raw value, its included flag
// and its signed amount — the account denominator and the money
// facts do not move, and a real 0 stays a real 0. What changes
// is only presentation eligibility: a bad or missing date is
// not date evidence, so the plaid / snapshot ranges are
// recomputed from valid calendar dates alone (null when a layer
// has no valid date at all), and the coverage counts are
// re-derived from the rows. isRealDateKey is the one strict
// rule (real calendar day, leap years included).
export function sanitizeArchNetWorthDates(arch: ArchNetWorth): ArchNetWorth {
  const rangeFor = (coverage: "plaid" | "snapshot"): ArchNetWorth["plaidRange"] => {
    const dates = arch.rows.flatMap((row) =>
      row.included && row.coverage === coverage && row.asOf !== null && isRealDateKey(row.asOf)
        ? [row.asOf]
        : [],
    );
    if (dates.length === 0) return null;
    return {
      oldest: dates.reduce((a, b) => (a < b ? a : b)),
      newest: dates.reduce((a, b) => (a > b ? a : b)),
    };
  };
  return {
    ...arch,
    plaidRange: rangeFor("plaid"),
    snapshotRange: rangeFor("snapshot"),
    amountIncluded: arch.rows.filter((row) => row.included).length,
    amountTotal: arch.rows.length,
    validDateCount: arch.rows.filter(
      (row) => row.included && row.asOf !== null && isRealDateKey(row.asOf),
    ).length,
    dateTotal: arch.rows.length,
  };
}

const dashboardSchema = z.object({
  asOf: z.string(),
  // F-ARCH-001 overlay: null unless getDashboard finds a stored
  // new-architecture figure to overlay (see archNetWorthSchema).
  archNetWorth: archNetWorthSchema.nullable().default(null),
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
    // F1.1 rework additive: cash sources withheld from the numerator
    // because their entries are explicitly marked unverified
    // (verified === false). Named so the UI can state the gap next
    // to the coverage figure instead of a generic shortage.
    availableCashUnverified: z.array(z.string()).default([]),
    // F1.1 conflict additive: cash sources withheld from the
    // numerator because their preserved metadata conflicts
    // (duplicate same-name account entryMeta disagreeing on a
    // field) and so cannot be uniquely associated — named
    // separately from unverified cash so the UI can state
    // 元数据冲突待核对 instead of a verification gap.
    availableCashConflict: z.array(z.string()).default([]),
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

// F-ARCH-001 controlled write channel. The request carries raw
// per-account balances; the server independently recomputes the
// total under the same rules as finance-arch summarizeNetWorth
// and only stores when the recomputation matches. Neither the
// issue codes nor the response ever carry an amount or an
// account value — counts and booleans only.
const ingestArchNetWorthRequest = z.object({
  arch: z.literal("F-ARCH-001"),
  version: z.literal(1),
  pulledAt: z.string().min(1).max(64),
  accounts: z
    .array(
      z.object({
        id: z.string().min(1).max(200),
        balance: z.number().nullable(),
        kind: z.enum(["asset", "liability"]),
        coverage: z.enum(["plaid", "snapshot", "missing"]),
        // DATE-1: format alone is NOT validated here on purpose.
        // A shape-valid but nonexistent calendar day (2026-02-30)
        // and a malformed string must both reach the handler so
        // the rejection is the categorized invalid_as_of failure
        // (counts/booleans only) instead of an opaque schema
        // error; the handler applies isRealDateKey strictly.
        asOf: z.string().min(1).max(64).nullable(),
      }),
    )
    .min(1)
    .max(120),
  total: z.number(),
});

const ingestArchNetWorthResponse = z.object({
  ok: z.boolean(),
  issue: z.string().nullable(),
  rows: z.number().int().nonnegative(),
  included: z.number().int().nonnegative(),
  missing: z.number().int().nonnegative(),
  totalMatches: z.boolean(),
  readBackVerified: z.boolean(),
});

type IngestArchNetWorthResult = z.infer<typeof ingestArchNetWorthResponse>;

function archIngestFailure(issue: string): IngestArchNetWorthResult {
  return { ok: false, issue, rows: 0, included: 0, missing: 0, totalMatches: false, readBackVerified: false };
}

// F-ARCH-001·SAVE-1 version arbitration. The CURRENT version of
// the stored figure is the one with the greatest source pulledAt
// — never merely the most recently inserted row: a late-arriving
// older write must not roll the page back. Ties on pulledAt go
// to the greatest row id. A stored row whose payload fails to
// parse is skipped as a candidate; it never shadows a valid
// version and never breaks the read.
type ArchStoredRow = { id: number; payload: string; pulledAt: Date };

function parseArchStoredRow(row: ArchStoredRow): ArchNetWorth | null {
  try {
    const parsed = archNetWorthSchema.safeParse(JSON.parse(row.payload));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function archVersionKey(row: ArchStoredRow, parsed: ArchNetWorth): number {
  // The payload's own pulledAt is the source version; fall back
  // to the row's pulledAt column when it does not parse.
  const ms = Date.parse(parsed.pulledAt);
  return Number.isFinite(ms) ? ms : row.pulledAt.getTime();
}

export function pickCurrentArchVersion(
  rows: ArchStoredRow[],
): { row: ArchStoredRow; parsed: ArchNetWorth } | null {
  let best: { row: ArchStoredRow; parsed: ArchNetWorth; key: number } | null = null;
  for (const row of rows) {
    const parsed = parseArchStoredRow(row);
    if (!parsed) continue;
    const key = archVersionKey(row, parsed);
    if (!best || key > best.key || (key === best.key && row.id > best.row.id)) {
      best = { row, parsed, key };
    }
  }
  return best ? { row: best.row, parsed: best.parsed } : null;
}

// SAVE-1 deep payload equivalence: every field of the normalized
// payload except storedAt (a write instant, not version
// content). Ranges and coverage counts are re-derived through
// sanitizeArchNetWorthDates on both sides so a stored legacy
// payload and a freshly built one compare on content alone.
export function archPayloadsEquivalent(a: ArchNetWorth, b: ArchNetWorth): boolean {
  const na = sanitizeArchNetWorthDates(a);
  const nb = sanitizeArchNetWorthDates(b);
  if (
    na.arch !== nb.arch ||
    na.version !== nb.version ||
    na.pulledAt !== nb.pulledAt ||
    na.total !== nb.total ||
    na.partial !== nb.partial ||
    na.amountIncluded !== nb.amountIncluded ||
    na.amountTotal !== nb.amountTotal ||
    na.validDateCount !== nb.validDateCount ||
    na.dateTotal !== nb.dateTotal
  ) {
    return false;
  }
  if (na.missing.length !== nb.missing.length || na.missing.some((id, i) => id !== nb.missing[i])) return false;
  const rangeEq = (
    x: ArchNetWorth["plaidRange"],
    y: ArchNetWorth["plaidRange"],
  ): boolean =>
    (x === null && y === null) ||
    (x !== null && y !== null && x.oldest === y.oldest && x.newest === y.newest);
  if (!rangeEq(na.plaidRange, nb.plaidRange) || !rangeEq(na.snapshotRange, nb.snapshotRange)) return false;
  if (na.rows.length !== nb.rows.length) return false;
  return na.rows.every((row, i) => {
    const other = nb.rows[i];
    return (
      other !== undefined &&
      row.id === other.id &&
      row.included === other.included &&
      row.signed === other.signed &&
      row.asOf === other.asOf &&
      row.coverage === other.coverage
    );
  });
}

// F0.7 read-only refresh observability. The diagnosis is a PURE
// function of the current refresh state summary plus the recorded
// observation stream (newest first), so it can be unit-verified
// offline and the client only ever renders its output. It answers
// the one question the status band cannot: which stage of the
// refresh chain last moved — task never spawned, spawn failed,
// started but no callback arrived, a callback arrived and was
// ignored by the generation / stale rules, or the refresh settled
// (success / failure).
//
// F0.7-OBS-001: the diagnosis is derived PER ATTEMPT. Every
// observation belongs to the generation that produced it; the
// diagnosis reads ONLY the current attempt's own event chain
// (the generation stored on the state row). Events from older
// generations — or with no attributable generation at all — are
// history / unattributed: they are listed separately and are
// never evidence about the current attempt. (The pre-fix
// derivation read the globally newest event, so a late failure
// callback from an OLD generation, correctly ignored by the
// ingest gate, was misdiagnosed as the current attempt's
// outcome — "任务执行过、回调已到达但被忽略" — and could invite a
// blind re-refresh.)
export const refreshDiagnosisCodes = [
  "no_attempt",
  "awaiting_callback",
  "callback_ignored",
  "settled_success",
  "settled_success_unrecorded",
  "settled_failure",
  "spawn_failed",
  "unattributed_history",
] as const;

export type RefreshDiagnosisCode = (typeof refreshDiagnosisCodes)[number];

// Internal view of one recorded observation. `generation` is the
// raw internal binding used ONLY to attribute the row to its
// attempt inside the server; it never leaves the server — the
// wire format carries the owner-safe attempt ordinal instead.
export type RefreshObservationLike = {
  event: string;
  outcome: string;
  detail: string | null;
  generation: string | null;
};

export type RefreshAttemptRelation = "current" | "history" | "unknown";

// Owner-safe attempt attribution. Attempts are numbered by the
// order their refresh_started rows were recorded (1-based). A
// generation that never recorded a start (a foreign callback's
// echoed id, a legacy null) has no ordinal; a row whose
// generation is null — or unknown to the attempt list — is
// "unknown" attribution, never silently folded into an attempt.
export function refreshAttemptOrdinal(
  attemptOrder: string[],
  generation: string | null,
): number | null {
  if (generation == null) return null;
  const index = attemptOrder.indexOf(generation);
  return index >= 0 ? index + 1 : null;
}

export function refreshAttemptRelation(input: {
  rowGeneration: string | null;
  currentGeneration: string | null;
  attemptOrder: string[];
}): RefreshAttemptRelation {
  if (input.rowGeneration == null) return "unknown";
  if (input.currentGeneration != null && input.rowGeneration === input.currentGeneration) {
    return "current";
  }
  return refreshAttemptOrdinal(input.attemptOrder, input.rowGeneration) != null
    ? "history"
    : "unknown";
}

const refreshDiagnosisText: Record<RefreshDiagnosisCode, string> = {
  no_attempt: "尚无任何刷新尝试记录（下一次刷新开始记录）",
  awaiting_callback: "等待当前代回调，执行终态未知（当前尝试尚无本代回调到达；任务可能仍在执行，也可能回调尚未投递）",
  callback_ignored: "当前尝试的回调已到达，但被代次/陈旧规则忽略，未落盘保存（本代终态以当前状态为准）",
  settled_success: "当前尝试已成功落盘",
  // Default (no recorded callback_received for this generation):
  // the terminal result event is unrecorded and callback arrival
  // is unknown — the text must never claim the callback did not
  // arrive. When this generation's callback_received IS recorded,
  // deriveRefreshDiagnosis substitutes the arrived variant below.
  settled_success_unrecorded: "当前尝试已成功收尾（以业务状态为准）：回调/终态事件未记录，到达情况未知",
  settled_failure: "当前尝试已以失败收尾",
  spawn_failed: "当前尝试未能启动（spawn 失败）",
  unattributed_history: "有历史/无关事件记录，但无法归属到当前尝试（当前尝试终态未知）",
};

// F0.7-OBS-001 selective-loss variants: this generation's own
// callback_received is recorded but its terminal result event is
// not (the observation write for the result was lost — writes are
// isolated and swallowed by design). The texts state exactly what
// the recorded stream proves and nothing more.
const settledSuccessUnrecordedCallbackArrivedText =
  "当前尝试已成功收尾（以业务状态为准）：本代回调已到达，终态结果事件未记录（观测写入可能丢失）";
const awaitingCallbackReceivedText =
  "等待当前代终态：当前代回调已到达，终态未知（结果事件尚未记录）";

export function deriveRefreshDiagnosis(input: {
  status: "idle" | "running" | "error" | null | undefined;
  // The generation stored on the state row — the current (latest)
  // attempt. Internal only; never returned to the client.
  currentGeneration: string | null;
  // Distinct generations in recorded start order (oldest first);
  // used only to number the current attempt for display.
  attemptOrder: string[];
  observations: RefreshObservationLike[];
}): { code: RefreshDiagnosisCode; text: string; attempt: number | null } {
  const attempt = refreshAttemptOrdinal(input.attemptOrder, input.currentGeneration);
  const finish = (code: RefreshDiagnosisCode, text?: string) => ({
    code,
    text: text ?? refreshDiagnosisText[code],
    attempt,
  });
  const obs = input.observations;
  if (input.currentGeneration == null) {
    // No current attempt is bound (no refresh ever started under
    // the generation contract, or a pre-contract state row). No
    // recorded event can be attributed to a current attempt, so
    // nothing in the stream is evidence about one — and no
    // historical / unrelated event may be used to infer a current
    // terminal outcome either: any leftover rows are unattributed
    // history, whatever the bare state status says.
    if (obs.length === 0) return finish("no_attempt");
    return finish("unattributed_history");
  }
  const own = obs.filter((row) => row.generation === input.currentGeneration);
  if (own.length === 0) {
    // The current attempt has no recorded events of its own in
    // the stream (its rows fell outside the returned window, or
    // recording failed — writes are isolated and swallowed).
    // Other generations' events are NOT evidence about it; fall
    // back to the attempt's own state status only.
    if (input.status === "error") return finish("settled_failure");
    if (input.status === "idle") return finish("settled_success");
    return finish("awaiting_callback");
  }
  const has = (event: string) => own.some((row) => row.event === event);
  // The attempt's OWN applied result is its terminal fact; own
  // callbacks ignored afterwards (duplicates, stale retries) do
  // not un-settle it.
  if (has("callback_applied_success")) return finish("settled_success");
  if (has("callback_applied_failure")) return finish("settled_failure");
  if (has("spawn_failed")) return finish("spawn_failed");
  // The current attempt's own callback arrived and was ignored —
  // distinct from an ignored callback of any other generation,
  // which never reaches this branch.
  if (has("callback_ignored")) return finish("callback_ignored");
  // Started / attached / received / tail events only: this
  // generation has NO recorded terminal event. Spawn attachment
  // is NOT proof the task executed. But the absence of a terminal
  // event is not proof the callback never arrived either: the
  // result event's own observation write may have been lost
  // (recordObservation swallows write failures by design), while
  // the business state already settled. So when the business
  // state has settled, present the outcome from the state — never
  // contradict the generation's own recorded events.
  if (input.status === "error") return finish("settled_failure");
  if (input.status === "idle") {
    // Settled successfully per the business state, but the
    // terminal result event is unrecorded. If this generation's
    // callback_received is on record, say so plainly; otherwise
    // arrival is unknown — never claim the callback did not come.
    return has("callback_received")
      ? finish("settled_success_unrecorded", settledSuccessUnrecordedCallbackArrivedText)
      : finish("settled_success_unrecorded");
  }
  if (has("callback_received")) {
    // Still running, callback on record, result event not yet
    // recorded: waiting for the terminal outcome — the text must
    // not say no callback of this generation has arrived.
    return finish("awaiting_callback", awaitingCallbackReceivedText);
  }
  return finish("awaiting_callback");
}

const refreshObservationsResponse = z.object({
  access: z.enum(["owner", "guest_denied"]),
  state: z.object({
    status: z.enum(["idle", "running", "error"]),
    startedAt: z.string().nullable(),
    updatedAt: z.string().nullable(),
    hasTaskId: z.boolean(),
    hasGeneration: z.boolean(),
    // Owner-safe ordinal of the current attempt (1-based, in
    // recorded start order); null when it cannot be numbered.
    // The raw generation / task id values never leave the server.
    attempt: z.number().int().positive().nullable(),
  }).nullable(),
  currentAttempt: z.number().int().positive().nullable(),
  observations: z.array(z.object({
    event: z.string(),
    outcome: z.string(),
    detail: z.string().nullable(),
    createdAt: z.string(),
    // Per-row attempt attribution: the attempt ordinal this row
    // belongs to (null when unattributable) and its relation to
    // the current attempt — current / history / unknown.
    attempt: z.number().int().positive().nullable(),
    relation: z.enum(["current", "history", "unknown"]),
  })),
  diagnosis: z.object({
    code: z.enum([
      "no_attempt",
      "awaiting_callback",
      "callback_ignored",
      "settled_success",
      "settled_success_unrecorded",
      "settled_failure",
      "spawn_failed",
      "unattributed_history",
    ]),
    text: z.string(),
    attempt: z.number().int().positive().nullable(),
  }).nullable(),
});

// F0.7 observability write: appends one refresh-chain observation.
// `detail` accepts ONLY a short code from a fixed allowlist (or a
// `saved_months:N` count) — anything else is dropped to null, so
// no financial value, payload fragment, account string or raw
// error text can ever land in the table through this path. A
// failed insert is swallowed: observability must never break the
// refresh chain it observes.
const observationDetailCodes = new Set([
  "generation_gate",
  "stale_decision",
  "claim_lost",
  "settle_superseded",
  "spawn_error",
  "spawn_tail",
  "status_idle",
  "status_error",
  "status_running",
  "normalization_issue",
  "no_dashboard",
]);

async function recordObservation(
  ctx: Ctx,
  row: {
    generation: string | null;
    event: (typeof schema.refreshObservations.$inferInsert)["event"];
    outcome: string;
    detail?: string | null;
  },
): Promise<void> {
  try {
    const detail =
      row.detail != null && (observationDetailCodes.has(row.detail) || /^saved_months:\d+$/.test(row.detail))
        ? row.detail
        : null;
    await ctx.db<typeof schema>()
      .insert(schema.refreshObservations)
      .values({ generation: row.generation, event: row.event, outcome: row.outcome, detail });
  } catch {
    // Observability is read-only diagnostics; a write failure
    // never interrupts the refresh flow.
  }
}

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

// F-ARCH-001 write gate (same semantics as the health dashboard's
// sync channel): a call with NO viewer is an internal sync-channel
// call and passes; a call carrying a viewer passes only when that
// viewer is the owner. Any identified non-owner is rejected. This
// gate serves ONLY the ingestArchNetWorth write path — every
// human-facing read stays strictly owner-only via isOwner.
function isOwnerOrSyncChannel(ctx: Ctx): boolean {
  return ctx.viewer == null || ctx.viewer.isOwner === true;
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
  // The month must be a real calendar month BEFORE any Date is
  // constructed: Date.UTC rolls an out-of-range month into the
  // neighbouring year (2025-13 -> 2026-01-31), which would mint a
  // legal-looking date out of an illegal one. An illegal month
  // has no month end at all.
  if (!year || month < 1 || month > 12) return "";
  return new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
}

// F0.6/F1.6 rework shared helpers — the single implementation of
// the exact-date and native-verification rules every gate below
// (cashflow endpoints, investment reconciliation, available cash)
// consumes. A balance date is comparable to a snapshot date only
// in normalized form: a YYYY-MM date denotes that month's last
// day; a real calendar date stands as itself; anything else
// (e.g. 09-31) is invalid and normalizes to null, which never
// equals a snapshot date.
// Date-validation fix (F0.6/F1.6, PM 2026-10-19): the YYYY-MM
// branch must validate the month (01..12) BEFORE monthEnd builds
// a Date — Date arithmetic otherwise rolls an illegal month
// into a legal balance date (2025-13 -> 2026-01-31, 2025-14 ->
// 2026-02-28), and every consumer of this one function (cashflow
// endpoints, investment reconciliation, available cash) would
// treat the rolled date as fresh evidence. Months 00/13/14/99,
// malformed strings and illegal explicit dates all normalize to
// null here: no date eligibility, named as a date problem by the
// gates, never repaired, never backfilled, and never written
// back to stored history (read-path normalization only).
function normalizeBalanceDate(balanceDate: string | null | undefined): string | null {
  if (balanceDate == null) return null;
  if (/^\d{4}-\d{2}$/.test(balanceDate)) {
    const month = Number(balanceDate.slice(5, 7));
    if (month < 1 || month > 12) return null;
    return monthEnd(balanceDate) || null;
  }
  return isRealDateKey(balanceDate) ? balanceDate : null;
}

// The raw Firance status strings that mark a record unverified,
// consumed verbatim — never translated or re-derived.
function isUnverifiedStatus(status: string | null | undefined): boolean {
  return status === "unverified" || status === "carried_forward_unverified";
}

// One unverified verdict for any entry-shaped record (source
// entry, preserved entryMeta row, or merged account row): the
// generic boolean flag, the Firance-native flow verification, or
// the raw status string — any one of them marks the record.
function entryUnverified(entry: {
  verified?: boolean | null;
  status?: string | null;
  nativeFlowVerified?: boolean | null;
}): boolean {
  return (
    entry.verified === false ||
    entry.nativeFlowVerified === false ||
    isUnverifiedStatus(entry.status)
  );
}

// The effective flow period of an entry: the generic period when
// present, the Firance-native period filling its absence. Both
// bounds must resolve for a period to exist at all — and F1.6
// period proof additionally requires a LEGAL, COMPLETE period:
// both bounds real calendar dates (an illegal day such as 09-00
// or 09-31 is rejected outright, never compared as text) and
// start not after end. Period material that fails validation
// proves nothing and resolves to null here; the reconciliation
// gate distinguishes "no period material" from "invalid period
// material" when it names the reason.
function effectiveFlowPeriod(entry: {
  periodStart?: string | null;
  periodEnd?: string | null;
  nativePeriodStart?: string | null;
  nativePeriodEnd?: string | null;
}): { start: string; end: string } | null {
  const start = entry.periodStart ?? entry.nativePeriodStart ?? null;
  const end = entry.periodEnd ?? entry.nativePeriodEnd ?? null;
  if (start == null || end == null) return null;
  if (!isRealDateKey(start) || !isRealDateKey(end)) return null;
  if (start > end) return null;
  return { start, end };
}

// Verbatim readers for the Firance-native keys a record carries
// in its extra: a value is promoted only when it already has the
// right type — never coerced, never defaulted, never renamed.
function nativeDateString(
  extra: Record<string, string | number | boolean | null> | undefined,
  key: string,
): string | null {
  const value = extra?.[key];
  return typeof value === "string" ? value : null;
}

function nativeBool(
  extra: Record<string, string | number | boolean | null> | undefined,
  key: string,
): boolean | null {
  const value = extra?.[key];
  return typeof value === "boolean" ? value : null;
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
        // F0.6 rework: the back-calculation is bound at BOTH ends.
        // Eligibility requires, for the start （期初） and the end
        // （期末） snapshot alike:
        // - the same cash/credit sources with the SAME resolved
        //   role per source (a source whose role changed, e.g.
        //   cash -> credit, breaks the single caliber even when
        //   the source set itself is unchanged);
        // - each participating account's real balanceDate fresh
        //   for its own snapshot month (a carried-over date at
        //   either end disqualifies — the file month alone never
        //   proves the other end);
        // - no participating account explicitly marked unverified
        //   (verified === false) at either end.
        // Every failure names the endpoint, the account and the
        // gap; the balances themselves stay recorded as facts.
        const roleZh = (role: "cash" | "credit") => (role === "cash" ? "现金" : "信用卡");
        const cashCreditBySource = (entries: SourceEntry[]) => {
          const map = new Map<string, "cash" | "credit">();
          for (const entry of entries) {
            if (entry.type !== "account") continue;
            const role = cashflowRoleForEntry(entry);
            if (role === "cash" || role === "credit") map.set(entry.financeSource, role);
          }
          return map;
        };
        const startRoles = cashCreditBySource(previousSource.entries);
        const endRoles = cashCreditBySource(monthEntries);
        const startNames = [...startRoles.keys()].sort().join("\n");
        const endNames = [...endRoles.keys()].sort().join("\n");
        if (startNames !== endNames) {
          issues.push("现金/信用卡账户范围变化（新增、改名或消失），无法同口径反推");
        } else {
          const roleChanged = [...startRoles.entries()]
            .filter(([source, role]) => endRoles.get(source) !== role)
            .map(([source, role]) => `${source}（期初 ${roleZh(role)} → 期末 ${roleZh(endRoles.get(source) ?? role)}）`);
          if (roleChanged.length > 0) {
            issues.push(`现金/信用卡账户分类在期间内变化：${roleChanged.join("、")}，source+role 不一致，无法同口径反推`);
          }
        }
        const endpointIssues = (
          entries: SourceEntry[],
          roles: Map<string, "cash" | "credit">,
          snapshotKey: string,
          label: "期初" | "期末",
        ): string[] => {
          const found: string[] = [];
          for (const entry of entries) {
            if (entry.type !== "account" || !roles.has(entry.financeSource)) continue;
            // F0.6 rework: "unverified" is consumed from BOTH the
            // boolean flag and the raw Firance status string —
            // an entry whose status reads unverified /
            // carried_forward_unverified is unverified even when
            // no boolean was stored alongside it (entryUnverified
            // is the shared verdict).
            if (entryUnverified(entry)) {
              found.push(`${label}账户 ${entry.financeSource} 标记为未核实`);
            }
            // F0.6 rework: the balance date must EQUAL this
            // endpoint's own snapshot date exactly. A YYYY-MM
            // balance date normalizes to that month's last day
            // (equivalent to a month-end snapshot); a same-month
            // older day, a future day, or an invalid calendar
            // date (e.g. 09-31) all disqualify the endpoint, and
            // the reason names the endpoint, the account and the
            // recorded date.
            if (entry.balanceDate != null && normalizeBalanceDate(entry.balanceDate) !== snapshotKey) {
              found.push(`${label}账户 ${entry.financeSource} 沿用旧余额日期 ${entry.balanceDate}，${label === "期初" ? "上期" : "本月"}未更新`);
            }
          }
          return found;
        };
        issues.push(...endpointIssues(previousSource.entries, startRoles, previousSource.key, "期初"));
        issues.push(...endpointIssues(monthEntries, endRoles, month.key, "期末"));
      }
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
        // F1.6 rework: the Firance-native investment keys are
        // promoted VERBATIM from the record's extra into their own
        // fields. They coexist with the generic period / verified
        // fields above — neither side overwrites the other, so a
        // disagreement between them stays visible as a conflict
        // for the return gate instead of being merged away here.
        nativePeriodStart: nativeDateString(entry.extra, "investment_period_start"),
        nativePeriodEnd: nativeDateString(entry.extra, "investment_period_end"),
        nativeFlowVerified: nativeBool(entry.extra, "investment_flow_verified"),
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
//   investment balance is carried over from an older balance date —
//   checked at BOTH endpoints: the starting balance is bound by
//   its own snapshot's verification state and balance date, not
//   borrowed from the ending one;
// - the interval's flows are unknown (contribution missing, or the
//   standard/alias pair conflicts);
// - a flow record cannot prove a legal, complete period attributed
//   to this interval (see the per-channel / per-source proof below):
//   an illegal calendar date (e.g. 09-00), a start without an end, a
//   period lying entirely outside the interval, or no period
//   material at all each withhold the reconciled label — the
//   recorded facts stay, the return and the net flow are null.
// Negative returns and net withdrawals keep their signs; nothing is
// clamped. Months whose preserved metadata cannot establish the
// investment-account scope (pre-F0.6 stored payloads) degrade the
// same way instead of trusting the legacy un-gated figure.
// F1.6 rework (native fields + per-channel binding):
// - the effective period of a flow entry is its generic period,
//   falling back to the Firance-native period
//   (investment_period_start/end) when the generic one is absent;
//   when both are present and disagree, the interval degrades as
//   a period conflict, named on the entry;
// - the Firance-native flow verification
//   (investment_flow_verified) gates like the generic flag: false
//   is unverified, and a contradiction with the generic verified
//   flag is a conflict; a balance endpoint whose raw status reads
//   carried_forward_unverified is unverified as well;
// - balance dates bind EXACTLY (the F0.6 rule): a balance date
//   must equal its own snapshot's actual date, with a YYYY-MM
//   date normalized to that month's last day — a same-month older
//   day, a future day or an invalid date degrades either endpoint;
// - period coverage is judged PER CHANNEL and PER SOURCE: the
//   cash channel (investment_contribution / transfer) and the
//   non-bank direct channel (investment_external_adjustment) each
//   prove their own coverage of (previous snapshot date, this
//   snapshot date]; one channel's periods never substitute for
//   the other's, different sources' periods within a channel
//   never splice into one proof, a period reaching outside the
//   interval makes its amount unattributable (the whole record
//   is excluded, not clipped), a period lying entirely outside
//   the interval never mixes into this segment's net flow, and a
//   channel whose records carry no complete legal period at all
//   — partial (start without end), illegal dates, a verification
//   mark without any period, or a pure legacy archive record
//   with neither period nor mark — is never marked reconciled;
// - when the flow proof fails for a month, its investmentNetFlow
// is null too (not only the return): an unproven interval has no
// proven net flow to display or to sum into the period figure.
function recomputeInvestmentReturns(months: Dashboard["months"]): Dashboard["months"] {
  const flowTypes = new Set(["investment", "investment_contribution", "transfer", "investment_external_adjustment"]);
  type MetaEntry = Dashboard["months"][number]["entryMeta"][number];
  // The exact-date and unverified verdicts come from the shared
  // module-level helpers (normalizeBalanceDate / entryUnverified /
  // effectiveFlowPeriod), so the ingest path and the read path
  // apply one implementation; only the interval arithmetic is
  // local to this gate.
  const dayAfter = (key: string): string => {
    const date = new Date(`${key}T00:00:00Z`);
    date.setUTCDate(date.getUTCDate() + 1);
    return date.toISOString().slice(0, 10);
  };
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
    // F1.6 rework: BOTH balance endpoints are bound. The starting
    // balance (previous snapshot) must itself be verified and
    // fresh for its own month — an unverified or carried-over
    // starting balance invalidates the interval exactly like a
    // bad ending one, and the reason names the failing endpoint.
    // "Unverified" consumes the boolean flag AND the raw status
    // string (unverified / carried_forward_unverified) at either
    // endpoint; the ending check also consumes the Firance-native
    // flow verification, and a generic/native verification pair
    // that contradicts itself is a conflict, named as such.
    const previousMeta = previous.entryMeta ?? [];
    if (!reason) {
      const startUnverified = previousMeta.some(
        (entry) => entry.type === "investment" && entryUnverified(entry),
      );
      if (startUnverified) reason = "期初投资余额标记为未核实，收益待核对";
    }
    if (!reason) {
      const conflict = meta.find(
        (entry) =>
          flowTypes.has(entry.type) &&
          entry.verified != null &&
          entry.nativeFlowVerified != null &&
          entry.verified !== entry.nativeFlowVerified,
      );
      if (conflict) {
        reason = `投入记录 ${conflict.financeSource} 的通用核实标记与 Firance 原生核实标记（investment_flow_verified）矛盾，核实状态冲突，收益待核对`;
      }
    }
    if (!reason) {
      const unverified = meta.some(
        (entry) => flowTypes.has(entry.type) && entryUnverified(entry),
      );
      if (unverified) reason = "期末投资余额或投入标记为未核实，收益待核对";
    }
    if (!reason) {
      const startStale = previousMeta.some(
        (entry) =>
          entry.type === "investment" &&
          entry.balanceDate != null &&
          normalizeBalanceDate(entry.balanceDate) !== previous.key,
      );
      if (startStale) reason = "期初投资账户沿用旧余额日期，期初余额未更新，收益待核对";
    }
    if (!reason) {
      const stale = meta.some(
        (entry) =>
          entry.type === "investment" &&
          entry.balanceDate != null &&
          normalizeBalanceDate(entry.balanceDate) !== month.key,
      );
      if (stale) reason = "有投资账户沿用旧余额日期，本期余额未更新，收益待核对";
    }
    const flowMeta = meta.filter(
      (entry) =>
        entry.type === "investment_contribution" ||
        entry.type === "transfer" ||
        entry.type === "investment_external_adjustment",
    );
    if (!reason) {
      // Generic period vs Firance-native period: the generic one
      // governs when present, the native one fills its absence —
      // but when both are present and they disagree, neither can
      // be trusted for this entry and the interval degrades with
      // the conflict named.
      const periodConflict = flowMeta.find(
        (entry) =>
          (entry.periodStart != null && entry.nativePeriodStart != null && entry.periodStart !== entry.nativePeriodStart) ||
          (entry.periodEnd != null && entry.nativePeriodEnd != null && entry.periodEnd !== entry.nativePeriodEnd),
      );
      if (periodConflict) {
        reason = `投入记录 ${periodConflict.financeSource} 的通用期间与 Firance 原生期间（investment_period_start/end）不一致，期间冲突，收益待核对`;
      }
    }
    if (!reason && flowsKnown) {
      // F1.6 period proof, judged PER CHANNEL and PER SOURCE.
      // - Every flow record first proves a LEGAL, COMPLETE period
      //   attributed to this segment (effectiveFlowPeriod: both
      //   bounds present, both real calendar dates, start <= end).
      //   A record with only a start, an illegal date (e.g. 09-00),
      //   or no period material at all cannot prove attribution.
      // - Coverage is judged per (channel, financeSource): one
      //   source's own periods may join up to cover the interval,
      //   but DIFFERENT sources' periods never splice together —
      //   source A covering the first half and source B the second
      //   half leaves the channel unproven, because no single
      //   source's records are attributable to the whole interval.
      // - A period lying ENTIRELY outside the interval means the
      //   whole amount belongs to another segment: it is never
      //   mixed into this segment's net flow — the interval
      //   degrades with the exclusion named instead of silently
      //   absorbing the amount. A period crossing the boundary
      //   degrades the same way (whole record out, never clipped).
      // - A channel whose records carry no complete period at all
      //   cannot be marked reconciled: not a partial period, not a
      //   verification mark without any period, and not a pure
      //   legacy archive channel with neither period nor mark.
      //   The recorded amounts stay readable as facts on the
      //   month; only the reconciled return and net flow are
      //   withheld (null), and the period card shows 待核对.
      const intervalStart = dayAfter(previous.key);
      const intervalEnd = month.key;
      const channels: Array<{ label: string; entries: MetaEntry[] }> = [
        {
          label: "现金投入",
          entries: flowMeta.filter((entry) => entry.type === "investment_contribution" || entry.type === "transfer"),
        },
        {
          label: "非银行直接投入",
          entries: flowMeta.filter((entry) => entry.type === "investment_external_adjustment"),
        },
      ];
      for (const channel of channels) {
        if (reason) break;
        if (channel.entries.length === 0) continue;
        const bySource = new Map<string, MetaEntry[]>();
        for (const entry of channel.entries) {
          bySource.set(entry.financeSource, [...(bySource.get(entry.financeSource) ?? []), entry]);
        }
        for (const [sourceName, sourceEntries] of bySource) {
          if (reason) break;
          const periods = sourceEntries.flatMap((entry) => {
            const period = effectiveFlowPeriod(entry);
            return period ? [period] : [];
          });
          if (periods.length < sourceEntries.length) {
            const defective = sourceEntries.find((entry) => effectiveFlowPeriod(entry) == null);
            const hasMaterial = defective != null && (
              defective.periodStart != null || defective.periodEnd != null ||
              defective.nativePeriodStart != null || defective.nativePeriodEnd != null
            );
            reason = hasMaterial
              ? `${channel.label}记录 ${sourceName} 的期间不完整或日期非法（仅有起始日、缺少结束日，或 09-00 一类非法日期均不作证明），无法证明归属本段，收益待核对`
              : `本期${channel.label}记录未提供期间，无法证明覆盖 ${intervalStart} 至 ${intervalEnd} 整个区间，收益待核对`;
            break;
          }
          const outside = periods.find(
            (period) => period.end <= previous.key || period.start > intervalEnd,
          );
          if (outside) {
            reason = `${channel.label}记录 ${sourceName} 的期间 ${outside.start} 至 ${outside.end} 完全在本区间 ${intervalStart} 至 ${intervalEnd} 之外，整笔金额不计入本段净投入，收益待核对`;
            break;
          }
          const crossing = periods.find(
            (period) => period.start <= previous.key || period.end > intervalEnd,
          );
          if (crossing) {
            reason = `${channel.label}期间 ${crossing.start} 至 ${crossing.end} 跨出本区间 ${intervalStart} 至 ${intervalEnd}，金额无法归属，整笔不计，收益待核对`;
            break;
          }
          const sortedPeriods = [...periods].sort((a, b) => a.start.localeCompare(b.start));
          let coveredThrough: string | null = null;
          for (const period of sortedPeriods) {
            if (coveredThrough == null) {
              if (period.start > intervalStart) break;
              coveredThrough = period.end;
            } else {
              if (period.start > dayAfter(coveredThrough)) break;
              if (period.end > coveredThrough) coveredThrough = period.end;
            }
            if (coveredThrough >= intervalEnd) break;
          }
          if (coveredThrough == null || coveredThrough < intervalEnd) {
            const coveredText = sortedPeriods.map((period) => `${period.start} 至 ${period.end}`).join("、");
            reason = `${channel.label}来源 ${sourceName} 的投入期间仅覆盖 ${coveredText}，未覆盖本区间 ${intervalStart} 至 ${intervalEnd}（不同来源的期间不能拼接证明），收益待核对`;
          }
        }
      }
    }
    if (!reason && month.contributionSource === "conflict") {
      reason = "投入标准字段与旧 transfer 别名冲突，期间净投入待核对";
    }
    if (!reason && !flowsKnown) {
      reason = "缺少投资投入记录，期间外部净投入未知";
    }
    if (reason) {
      // F1.6 rework (e): a month whose flow proof failed has no
      // proven net flow either — investmentNetFlow is null, not
      // merely an unusable return next to a summed flow figure.
      return {
        ...month,
        investmentNetFlow: null,
        investmentReturn: null,
        investmentReturnReason: reason,
      };
    }
    if (netFlow == null) {
      return {
        ...month,
        investmentNetFlow: null,
        investmentReturn: null,
        investmentReturnReason: "期间外部净投入未知",
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
// F1.6 rework (e): an unproven interval also nulls the period net
// flow itself — the card shows 未知 for the whole period rather
// than presenting a partial sum as the period's net flow; the
// established intervals' monthly returns and recorded amounts
// stay readable per month. Start/end balances remain visible as
// facts either way.
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
      netFlow: null, returnAmount: null,
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
      // F1.1 rework: the entry's verification state travels with
      // the row (null = not provided, the legacy state). The value
      // above is never rewritten by it.
      verified: entry.type === "account" ? entry.verified ?? null : null,
      // F1.1 rework: the entry's raw Firance status travels with
      // the row too, so a carried_forward_unverified balance is
      // recognisable as unverified on every read path.
      status: entry.type === "account" ? entry.status ?? null : null,
      // Fresh ingest rows come from the single chosen snapshot's
      // own entries — no duplicate-metadata association happens
      // here, so there is never a conflict at ingest; conflicts
      // are a read-path (legacy archive) verdict only.
      metadataConflict: false,
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
// - a cash row whose explicit balanceDate is not EXACTLY the
//   source snapshot date is stale （沿用旧余额） -> amount null and
//   the source is named in staleSources, so no coverage is
//   fabricated from old cash. The comparison uses the REAL
//   balanceDate against the snapshot date — not a month-prefix
//   comparison and never the refresh asOf: a same-month but older
//   balance date is a real gap and is named as one, and a FUTURE
//   balance date is a gap too (the freshness cutoff is the source
//   contract itself: the balance must be dated by its snapshot).
//   A YYYY-MM balance date normalizes to that month's last day
//   before comparing, matching the F0.6 endpoint rule; an invalid
//   calendar date never equals the snapshot date. A row without
//   an explicit balance date is dated by its snapshot
//   (sourceMonth), exactly as the monthly records show;
// - F1.1 rework: a cash row explicitly marked unverified never
//   enters the numerator either — verified === false, or a raw
//   status of unverified / carried_forward_unverified (the
//   native strings are consumed as-is). Its balance stays a
//   recorded fact on the row, but the amount is null and the
//   source is named in unverifiedSources, so no coverage is
//   claimed on unverified cash. A null verification state
//   (legacy / not provided) keeps the legacy caliber — the row
//   still counts and is labelled 核实状态未提供 by the UI;
// - F1.1 conflict rework: a cash row whose metadata CONFLICTS
//   (metadataConflict — duplicate preserved entryMeta that
//   cannot be uniquely associated) is withheld the same way and
//   named in conflictSources. A conflict is NOT the legacy
//   state: the archive DID carry metadata, it just disagrees
//   with itself, so counting the balance on the legacy caliber
//   would fabricate coverage from unresolved evidence. A row
//   with no metadata at all (every field null, no conflict)
//   keeps the legacy caliber unchanged;
// - otherwise the amount is the plain sum of the cash rows'
//   original balances (a true 0 stays a real 0).
function summarizeAvailableCash(
  accounts: Dashboard["accounts"],
  sourceMonth: string,
): { amount: number | null; staleSources: string[]; unverifiedSources: string[]; conflictSources: string[]; accountCount: number } {
  const cashAccounts = accounts.filter((account) => {
    if (account.type !== "account") return false;
    const role = account.cashflowRole
      ?? cashflowRoleForEntry({ financeSource: account.source, type: "account", number: account.value });
    return role === "cash";
  });
  if (cashAccounts.length === 0) {
    return { amount: null, staleSources: [], unverifiedSources: [], conflictSources: [], accountCount: 0 };
  }
  const staleSources = cashAccounts
    .filter((account) => account.balanceDate != null && normalizeBalanceDate(account.balanceDate) !== sourceMonth)
    .map((account) => account.source);
  const unverifiedSources = cashAccounts
    .filter((account) => entryUnverified(account))
    .map((account) => account.source);
  const conflictSources = cashAccounts
    .filter((account) => account.metadataConflict === true)
    .map((account) => account.source);
  if (staleSources.length > 0 || unverifiedSources.length > 0 || conflictSources.length > 0) {
    return { amount: null, staleSources, unverifiedSources, conflictSources, accountCount: cashAccounts.length };
  }
  return {
    amount: cashAccounts.reduce((sum, account) => sum + account.value, 0),
    staleSources: [],
    unverifiedSources: [],
    conflictSources: [],
    accountCount: cashAccounts.length,
  };
}

// F1.1 read path: (re)derive the available-cash summary from the
// stored account rows and the dashboard's own sourceMonth, so
// legacy payloads (whose rows predate the classification fields)
// get the same classified numerator as a fresh ingest — derived
// from their preserved balances and names, never backfilled into
// storage and never taken from the broader `deposits` fact.
// F1.1 rework (legacy archives): account rows written by older
// writers may lack verified / status / balanceDate even though
// the latest month's preserved entryMeta still carries them.
// Those fields are filled here from preserved entryMeta — ONLY
// from explicit values the archive actually preserved; a value
// the archive never kept stays missing (null), never invented.
// That is what lets an old archive whose entryMeta preserved
// verified=false or status=carried_forward_unverified degrade
// available cash to null (named unverified) on read, without any
// refresh.
// F1.1 metadata association (PM 12:15): the fill is bound three
// ways, all conservative:
// - SAME SNAPSHOT: candidates come only from the entryMeta of
//   the month whose key IS dashboard.sourceMonth — the snapshot
//   the account rows were merged from. Another month's metadata
//   never fills a row.
// - SAME TYPE: candidates must be `account` entries (the
//   cash-class balance entries). An income or investment entry
//   that merely shares a financeSource name never lends its
//   metadata to a cash account — a same-named income entry's
//   verified=true must not paper over the cash entry's own
//   explicit verified=false (which is preserved, and the cash
//   stays out of the numerator).
// - UNIQUE ASSOCIATION: duplicate account-type meta rows that
//   agree on a value fill it; rows that conflict on a field
//   leave that field missing rather than picking a winner —
//   and the row is stamped metadataConflict, because a conflict
//   is evidence that exists but cannot be used, NOT the legacy
//   absence of evidence: summarizeAvailableCash withholds a
//   conflicted cash account from coverage and names it, while
//   a row whose metadata was never saved at all keeps the
//   legacy caliber.
// The fill is read-path only: the stored payload is never
// written back, so the blob stays byte-identical.
function ensureAvailableCash(dashboard: Dashboard): Dashboard {
  const snapshotMonth = dashboard.months.find((month) => month.key === dashboard.sourceMonth);
  const snapshotMeta = snapshotMonth?.entryMeta ?? [];
  const filledAccounts = dashboard.accounts.map((account) => {
    if (account.type !== "account") return account;
    const role = account.cashflowRole
      ?? cashflowRoleForEntry({ financeSource: account.source, type: "account", number: account.value });
    const candidates = snapshotMeta.filter(
      (entry) => entry.financeSource === account.source && entry.type === "account",
    );
    // F1.1 conflict rework: pick reports a CONFLICT distinctly
    // from a plain absence. Duplicate meta rows that disagree on
    // a field make that field unassociable — it stays null (no
    // winner is picked) — but the row is stamped
    // metadataConflict so the summary and the UI can tell
    // "metadata exists but conflicts" apart from "metadata was
    // never saved" (the legacy state, which keeps its caliber).
    // A field the row already carries is never re-associated, so
    // its duplicates cannot conflict it either.
    const pick = <T,>(
      read: (entry: (typeof candidates)[number]) => T | null | undefined,
    ): { value: T | null; conflict: boolean } => {
      let found: T | null = null;
      for (const entry of candidates) {
        const value = read(entry);
        if (value == null) continue;
        if (found == null) {
          found = value;
        } else if (found !== value) {
          // Conflicting duplicate meta: ambiguous association —
          // degrade conservatively, fill nothing for this field.
          return { value: null, conflict: true };
        }
      }
      return { value: found, conflict: false };
    };
    const fillField = <T,>(own: T | null | undefined, read: (entry: (typeof candidates)[number]) => T | null | undefined) => {
      if (own != null) return { value: own, conflict: false };
      return pick(read);
    };
    const verifiedFill = fillField(account.verified, (entry) => entry.verified);
    const statusFill = fillField(account.status, (entry) => entry.status);
    const balanceDateFill = fillField(account.balanceDate, (entry) => entry.balanceDate);
    return {
      ...account,
      cashflowRole: role,
      availableCash: role === "cash",
      verified: verifiedFill.value,
      status: statusFill.value,
      balanceDate: balanceDateFill.value,
      metadataConflict:
        account.metadataConflict === true ||
        verifiedFill.conflict ||
        statusFill.conflict ||
        balanceDateFill.conflict,
    };
  });
  const summary = summarizeAvailableCash(filledAccounts, dashboard.sourceMonth);
  return {
    ...dashboard,
    accounts: filledAccounts,
    live: {
      ...dashboard.live,
      availableCash: summary.amount,
      availableCashStale: summary.staleSources,
      availableCashUnverified: summary.unverifiedSources,
      availableCashConflict: summary.conflictSources,
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
      // F2.3 rework: a cash row carries TWO currency claims — the
      // currency declared by its ticker (CUR:USD) and the explicit
      // currency field. When both are present and they CONFLICT,
      // the row is preserved as 待核对 with the conflict named: it
      // never enters the USD cash total and is never silently
      // converted at an implied rate. When only one claim exists
      // it governs; when neither exists the currency is
      // unprovable and the row is 待核对 as well.
      const declaredCurrency = ticker.slice(4).trim().toUpperCase() || null;
      const name = cleanSecurityName(item.name, ticker);
      if (currency != null && declaredCurrency != null && currency !== declaredCurrency) {
        unclassified.push({
          ticker, name, value, currency,
          reason: `现金币种冲突：代码声明 ${declaredCurrency}，币种字段为 ${currency}，待核对，未计入现金合计`,
        });
        continue;
      }
      const cashCurrency = currency ?? declaredCurrency;
      if (value == null || !Number.isFinite(value)) {
        unclassified.push({ ticker, name, value: null, currency: cashCurrency, reason: "现金市值缺失，未计入" });
      } else if (value < 0) {
        unclassified.push({ ticker, name, value, currency: cashCurrency, reason: "现金头寸为负，未计入" });
      } else if (value === 0) {
        unclassified.push({ ticker, name, value, currency: cashCurrency, reason: "现金市值为 0，未计入现金合计" });
      } else if (cashCurrency == null) {
        unclassified.push({ ticker, name, value, currency: null, reason: "现金币种无法确认（代码未声明、币种字段未提供），待核对，未计入现金合计" });
      } else {
        const key = `${ticker}|${cashCurrency}`;
        const current = cashByKey.get(key);
        cashByKey.set(key, {
          ticker,
          name: current?.name || name,
          value: (current?.value ?? 0) + value,
          currency: cashCurrency,
        });
        if (cashCurrency === "USD") usdCash += value;
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

// F1.6 rework: FIRE progress is measured on the INVESTMENT
// principal — the investment-account balance over the same
// account boundary as the period-return reconciliation — never on
// net worth. Deposits, HSA / bond balances and liabilities move
// net worth (and the net-worth fact card keeps its own unchanged
// definition), but they are not invested principal and must not
// move FIRE progress. The second argument is that investment
// principal: the live investment balance on the ingest path, the
// stored dashboard's live.investment on the read path.
function computeFire(months: Dashboard["months"], investmentPrincipal: number): Dashboard["fire"] {
  const used = validCompleteMonths(months).slice(-12);
  const principal = Number.isFinite(investmentPrincipal) ? investmentPrincipal : 0;
  const annualContribution = average(used.map((month) => month.contribution)) * 12;
  const annualSpend = average(used.map(normalizedFireSpend)) * 12;
  const target = annualSpend > 0 ? annualSpend / 0.04 : 0;
  const progress = target > 0 ? principal / target : null;
  return {
    annualContribution,
    annualSpend,
    target,
    progress,
    gap: Math.max(0, target - principal),
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
    fire: computeFire(reconciled, dashboard.live.investment),
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
    archNetWorth: null,
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
      availableCashUnverified: availableCashSummary.unverifiedSources,
      availableCashConflict: availableCashSummary.conflictSources,
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
    fire: computeFire(months, liveInvestment),
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
// still never a Top-10-only recomputation). One more legacy
// repair (F2.3 rework): a stored cash row whose declared currency
// conflicts with its currency field is moved to the unclassified
// list with the conflict named, and the cash total is rebuilt
// from the cash rows that remain.
function ensureHoldingsConsistency(dashboard: Dashboard): Dashboard {
  let foldedCash = 0;
  const separate = <T extends { ticker: string; name: string; value: number }>(rows: T[]): T[] =>
    rows
      .filter((row) => {
        if (row.ticker.toUpperCase() !== "CUR:USD") return true;
        foldedCash += row.value;
        return false;
      })
      .map((row) => ({ ...row, name: cleanSecurityName(row.name, row.ticker) }));
  const holdings = separate(dashboard.holdings);
  const holdingsAll = separate(dashboard.holdingsAll);
  let cashPosition = (dashboard.cashPosition ?? 0) + foldedCash;
  let holdingsCash = dashboard.holdingsCash;
  let holdingsUnclassified = dashboard.holdingsUnclassified;
  // F2.3 rework (legacy read path): an archive written before the
  // ingest-time conflict check can still carry a stored cash row
  // whose ticker declares one currency (CUR:USD) while its
  // currency field says another (CAD). Such a row is moved to the
  // unclassified list here with the conflict named, and the USD
  // cash total is rebuilt from the cash rows that remain (null
  // when no USD cash row survives). Archives without a stored
  // cash list keep the CUR:USD folding behaviour above exactly;
  // the stored figures for real holdings are never recomputed.
  if (Array.isArray(dashboard.holdingsCash)) {
    const declaredOf = (ticker: string): string | null => {
      const upper = ticker.toUpperCase();
      return upper.startsWith("CUR:") ? upper.slice(4).trim().toUpperCase() || null : null;
    };
    const retained: Dashboard["holdingsCash"] = [];
    const conflicts: Dashboard["holdingsUnclassified"] = [];
    for (const row of dashboard.holdingsCash) {
      const declared = declaredOf(row.ticker);
      const field = row.currency?.trim().toUpperCase() || null;
      if (declared != null && field != null && declared !== field) {
        conflicts.push({
          ticker: row.ticker,
          name: row.name,
          value: row.value,
          currency: row.currency,
          reason: `现金币种冲突：代码声明 ${declared}，币种字段为 ${field}，待核对，未计入现金合计`,
        });
      } else {
        retained.push(row);
      }
    }
    if (conflicts.length > 0) {
      holdingsCash = retained;
      holdingsUnclassified = [...(dashboard.holdingsUnclassified ?? []), ...conflicts];
      const retainedUsd = retained
        .filter((row) => (row.currency?.trim().toUpperCase() || declaredOf(row.ticker)) === "USD")
        .reduce((sum, row) => sum + row.value, 0);
      cashPosition = retainedUsd + foldedCash;
    }
  }
  return {
    ...dashboard,
    holdings,
    holdingsAll,
    holdingsCash,
    holdingsUnclassified,
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

type FinanceStateRow = Awaited<ReturnType<typeof getState>>;

export const staleRefreshThresholdMs = 2 * 60 * 60 * 1000;

// F0.7 stale recovery: a refresh stuck in "running" for over 2
// hours is a dead refresh — getDashboard presents it as a
// retryable error and refreshFinanceData may start over it. The
// stored row itself is never rewritten by this mapping.
export function isStaleRunningState(
  status: "idle" | "running" | "error" | null | undefined,
  updatedAt: Date | null | undefined,
  now: Date,
): boolean {
  if (status !== "running" || !updatedAt) return false;
  return now.getTime() - updatedAt.getTime() > staleRefreshThresholdMs;
}

// F0.7: ingest decision for a refresh callback, under generation
// binding. A callback may only settle the refresh generation it
// belongs to:
//  - A success whose asOf is the same as or older than the stored
//    payload never saves, in ANY refresh state — saving it would
//    make the visible data regress or duplicate the current one.
//    (The handler passes the stored payload's asOf as
//    latestPayloadAsOf.)
//  - While a refresh is running, a success whose asOf predates the
//    moment this refresh started (the state row's updatedAt at
//    read time) provably belongs to a previous generation's task:
//    it is ignored and the running state is left untouched.
//  - A failure may only settle a still-running refresh; a late
//    failure arriving after the state settled (idle/error/no row)
//    is ignored — in particular it must never flip a settled
//    success (idle) into error.
// Semantics of "apply": for a running refresh, "apply" only means
// the callback is ELIGIBLE to enter the handler's atomic claim
// arbitration. The arbitration result — not this function —
// decides whether the callback actually saves or settles, so two
// concurrent callbacks of the same generation cannot both apply.
export function decideIngestCallback(input: {
  refreshStatus: "idle" | "running" | "error" | null | undefined;
  refreshUpdatedAt: Date | string | null | undefined;
  latestPayloadAsOf: string | null | undefined;
  incomingSuccess: boolean;
  incomingAsOf: string | null | undefined;
}): "apply" | "ignore" {
  const incomingMs = input.incomingAsOf != null ? Date.parse(input.incomingAsOf) : NaN;
  const latestMs = input.latestPayloadAsOf != null ? Date.parse(input.latestPayloadAsOf) : NaN;
  if (input.incomingSuccess) {
    // No regression or duplicate save, whatever the refresh state.
    if (!Number.isNaN(incomingMs) && !Number.isNaN(latestMs) && incomingMs <= latestMs) {
      return "ignore";
    }
    if (input.refreshStatus === "running") {
      // A result stamped before this refresh started is a previous
      // generation's task returning late — ignore it, state
      // untouched.
      const startedMs =
        input.refreshUpdatedAt instanceof Date
          ? input.refreshUpdatedAt.getTime()
          : input.refreshUpdatedAt != null
            ? Date.parse(input.refreshUpdatedAt)
            : NaN;
      if (!Number.isNaN(incomingMs) && !Number.isNaN(startedMs) && incomingMs < startedMs) {
        return "ignore";
      }
    }
    return "apply";
  }
  // Failure: eligible to settle only while a refresh is still
  // running (subject to winning the arbitration, per the note
  // above); a failure arriving after the state settled is a late
  // return and is ignored.
  if (input.refreshStatus === "running") return "apply";
  return "ignore";
}

// F0.7 generation gate. refreshFinanceData mints a generation id
// when a refresh starts and stores it on the state row; the
// retrieval task must echo it back verbatim in its
// ingestFinanceData callback, success and failure alike. Finance
// ingest has exactly one callback channel — the refresh task —
// and it is always generation-bound:
//  - While a refresh is running, a missing or mismatched
//    generation means the callback belongs to an older (or
//    foreign) task and is ignored without touching state — an old
//    generation's failure callback carries no asOf to compare, so
//    only the echoed generation keeps it from settling the new
//    generation's running state.
//  - Once a generation has settled (idle/error), it is spent: a
//    callback can settle its own still-running generation exactly
//    once, so a late or replayed return — same generation with a
//    newer asOf, or a foreign generation — never saves or settles
//    again.
// Legacy state rows (generation null, written before this
// contract) keep the previous decide-only behaviour, so old
// payloads and pre-contract state stay compatible.
export function decideGenerationGate(input: {
  refreshStatus: "idle" | "running" | "error" | null | undefined;
  storedGeneration: string | null | undefined;
  incomingGeneration: string | null | undefined;
}): "pass" | "ignore" {
  if (input.storedGeneration == null) return "pass";
  if (input.refreshStatus !== "running") return "ignore";
  if (input.incomingGeneration == null) return "ignore";
  return input.incomingGeneration === input.storedGeneration ? "pass" : "ignore";
}

function newGenerationId(): string {
  const rand = Math.random().toString(36).slice(2, 10);
  return `gen-${Date.now().toString(36)}-${rand}`;
}

function newClaimToken(): string {
  const rand = Math.random().toString(36).slice(2, 12);
  return `claim-${Date.now().toString(36)}-${rand}`;
}

async function writeState(
  ctx: Ctx,
  values: {
    payload?: string | null;
    previousLiveNetWorth?: number | null;
    status: "idle" | "running" | "error";
    taskId?: string | null;
    message?: string | null;
    generation?: string | null;
    claimedGeneration?: string | null;
    startedAt?: Date | null;
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
    generation: values.generation === undefined ? (existing?.generation ?? null) : values.generation,
    claimedGeneration: values.claimedGeneration === undefined
      ? (existing?.claimedGeneration ?? null)
      : values.claimedGeneration,
    startedAt: values.startedAt === undefined ? (existing?.startedAt ?? null) : values.startedAt,
    updatedAt: new Date(),
  };
  await ctx.db<typeof schema>()
    .insert(schema.financeState)
    .values(row)
    .onConflictDoUpdate({ target: schema.financeState.id, set: row });
}

// F0.7 spawn-tail CAS: refreshFinanceData's post-spawn writes may
// only attach to the generation they started, and only while that
// generation is still running and unsettled. The pre-fix tail
// wrote unconditionally, so a spawn that returned late — after
// its own generation's callback had already settled it, or after
// a stale-aged restart had minted a new generation — resurrected
// the settled state to "running" or overwrote the new generation.
// One conditional UPDATE matching (id, this generation, still
// "running"); zero matched rows means this spawn's outcome no
// longer owns the state row and nothing is written. The patch
// never touches payload / generation / claimedGeneration /
// startedAt, so an in-flight ingest claim of the same generation
// is undisturbed.
// F0.7 rework (claim guard): the match ALSO requires
// claimedGeneration IS NULL. Once an ingest callback of this
// generation has claimed the row (claim stamped, settle not yet
// written), the spawn tail — the success taskId attach AND the
// failure error settle alike — must not change the state at all:
// flipping it to "error" here would make the claim holder's
// settle (conditioned on the still-running status) match zero
// rows and silently discard a legal save. An unattached tail
// returns false and the caller answers from the current state.
async function casSpawnTailState(
  ctx: Ctx,
  generation: string,
  patch: { status: "idle" | "running" | "error"; taskId: string | null; message: string | null },
): Promise<boolean> {
  const db = ctx.db<typeof schema>();
  const rows = await db
    .update(schema.financeState)
    .set({ status: patch.status, taskId: patch.taskId, message: patch.message, updatedAt: new Date() })
    .where(
      and(
        eq(schema.financeState.id, 1),
        eq(schema.financeState.generation, generation),
        eq(schema.financeState.status, "running"),
        isNull(schema.financeState.claimedGeneration),
      ),
    )
    .returning({ id: schema.financeState.id });
  return rows.length === 1;
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
        // F0.5/F0.7: when the current (or latest) refresh attempt
        // started — a fact of its own, distinct from updatedAt
        // (the last state-write instant). Null on legacy rows
        // written before attempts were stamped.
        startedAt: z.string().nullable(),
      }),
    }),
    async handler(ctx) {
      if (!isOwner(ctx)) {
        return {
          access: "guest_denied" as const,
          data: null,
          refresh: { status: "idle" as const, message: "财务数据仅所有者可查看", updatedAt: null, startedAt: null },
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
      // F-ARCH-001 overlay: when a new-architecture figure has
      // been stored, surface it alongside (never inside) the
      // legacy payload. An empty table or an unparsable stored
      // row keeps archNetWorth null — the legacy view is
      // completely unchanged.
      if (data) {
        // SAVE-1: the overlay is the version with the greatest
        // source pulledAt (ties: greatest id), NOT the latest
        // inserted row — a late older write already in the table
        // must not roll the figure back. Unparsable rows are
        // skipped as candidates; a corrupt row never breaks the
        // dashboard and never shadows a valid version.
        const archRows = await ctx.db<typeof schema>()
          .select()
          .from(schema.archNetWorth);
        const currentArch = pickCurrentArchVersion(archRows);
        if (currentArch) {
          // DATE-1: the stored row itself is never rewritten;
          // sanitizeArchNetWorthDates only re-derives the
          // presentation (ranges from valid calendar dates
          // alone + coverage counts) on this in-memory copy.
          data = { ...data, archNetWorth: sanitizeArchNetWorthDates(currentArch.parsed) };
        }
      }
      const staleRunning = isStaleRunningState(state?.status, state?.updatedAt, new Date());
      return {
        access: "owner" as const,
        data,
        refresh: {
          status: payloadCorrupted ? "error" : staleRunning ? "error" : (state?.status ?? "idle"),
          message: payloadCorrupted
            ? "已保存数据损坏，重新更新可恢复"
            : staleRunning ? "上次更新未完成，可以重新更新" : (state?.message ?? null),
          updatedAt: state?.updatedAt?.toISOString() ?? null,
          startedAt: state?.startedAt?.toISOString() ?? null,
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
      // F0.7 rework: starting a refresh is an ATOMIC conditional
      // claim, not a read-check-then-overwrite. The pre-fix path
      // read the state, checked "running", then unconditionally
      // overwrote the row with a new generation — two concurrent
      // calls could both pass the check, each mint its own
      // generation, and the later write silently replaced the
      // earlier one, so the first task's legal callback was then
      // rejected as a foreign generation. Now the start write is
      // a single UPDATE conditioned on the exact snapshot this
      // call read (status + updatedAt + generation): it lands
      // only while the row is still that row. With no state row,
      // a conflict-free insert plays the same role. A caller
      // whose claim misses re-reads once per attempt: a fresh
      // (non-stale) running state means another start won —
      // answer already_running and NEVER spawn. Only the claim
      // winner may spawn. The stale-running restart semantics are
      // unchanged (isStaleRunningState decides, and a stale row
      // is claimable exactly like an idle/error one).
      const db = ctx.db<typeof schema>();
      let snapshot = await getState(ctx);
      if (snapshot?.status === "running" && !isStaleRunningState(snapshot.status, snapshot.updatedAt, new Date())) {
        return { ok: true, status: "already_running", message: "每周更新正在进行中" };
      }
      // F0.7 generation contract: mint this refresh's generation id
      // BEFORE spawning the task and store it on the state row, with
      // the attempt's start instant stamped separately from
      // updatedAt. The task is instructed to echo the generation
      // back verbatim in its ingestFinanceData callback;
      // ingestFinanceData ignores callbacks whose generation is
      // missing or belongs to another generation. Starting the new
      // generation also clears any claim marker a previous
      // generation's callback may have left, so a late winner of
      // the old generation can no longer settle or save into this
      // one.
      const generation = newGenerationId();
      let claimed = false;
      for (let attempt = 0; attempt < 3 && !claimed; attempt += 1) {
        if (!snapshot) {
          const inserted = await db
            .insert(schema.financeState)
            .values({
              id: 1,
              payload: null,
              previousLiveNetWorth: null,
              status: "running",
              taskId: null,
              message: "正在同步 Firance 与 Plaid",
              generation,
              claimedGeneration: null,
              startedAt: new Date(),
              updatedAt: new Date(),
            })
            .onConflictDoNothing()
            .returning({ id: schema.financeState.id });
          claimed = inserted.length === 1;
        } else {
          const rows = await db
            .update(schema.financeState)
            .set({
              status: "running",
              taskId: null,
              message: "正在同步 Firance 与 Plaid",
              generation,
              claimedGeneration: null,
              startedAt: new Date(),
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(schema.financeState.id, 1),
                eq(schema.financeState.status, snapshot.status),
                eq(schema.financeState.updatedAt, snapshot.updatedAt),
                snapshot.generation == null
                  ? isNull(schema.financeState.generation)
                  : eq(schema.financeState.generation, snapshot.generation),
              ),
            )
            .returning({ id: schema.financeState.id });
          claimed = rows.length === 1;
        }
        if (!claimed) {
          // Lost the start race: re-read once. A fresh running
          // state is the winner's — report it and do not spawn.
          // Anything else (a settle landed, the row only just
          // appeared) is retried against the new snapshot.
          snapshot = await getState(ctx);
          if (snapshot?.status === "running" && !isStaleRunningState(snapshot.status, snapshot.updatedAt, new Date())) {
            return { ok: true, status: "already_running", message: "每周更新正在进行中" };
          }
        }
      }
      if (!claimed) {
        return { ok: false, status: "error", message: "刷新任务未能启动" };
      }
      // F0.7 observability: only a won claim records a start —
      // already_running / lost-claim early returns leave no
      // refresh_started row, so the stream names real attempts.
      await recordObservation(ctx, { generation, event: "refresh_started", outcome: "claimed" });
      ctx.invalidateQueries();
      const task = await ctx.agent.spawnTask(
        `刷新“每周财务总览”的真实数据。只读，不得写 Mac 文件，不得操作任何金融账户。\n\n1. 先定位目标设备：用设备列表工具列出当前可访问的设备，按设备名找到用户的 Mac mini（设备名含 “Mac mini” 的那台），本次刷新只使用这个运行时解析出的设备 ID。若按设备名找不到 Mac mini，或有多台候选无法唯一确定，不要猜测、不要用任何预置或写死的 ID 兜底，立即以 success:false 回调 ingestFinanceData 并在 error 中明确说明未能按设备名定位 Mac mini。在定位到的 Mac mini 上，先在运行时解析当前登录用户的主目录（home directory），再据此构造 Firance 数据目录为 <home>/Library/Application Support/Firance/FinanceData/（即 ~/Library/Application Support/Firance/FinanceData/）；不得使用任何写死的用户名或绝对用户路径。若无法解析主目录，不要猜测路径，立即以 success:false 回调 ingestFinanceData 并在 error 中说明无法解析主目录。然后用文件列表工具列出该目录，再读取全部文件名符合 YYYY-MM-DD 或 YYYY-MM 的无扩展名文件，月份键必须原样返回文件名、不要自行补成某一天（服务端会把 YYYY-MM 归一为该月月末估值）。每条记录是一组 key/value 行，至少含 finance_source、type、number；现行 Firance 记录还可能带 cashflow_role、balance_date、status、period_start、period_end、verified 等扩展行，且每条记录的行数不固定，必须按 key 解析、不得假定恰好三行或固定顺序。只保留 type 为 investment、investment_contribution、account、fixed_spend、transfer、income、flexible_spend、cashflow_adjustment、investment_external_adjustment 且 number 为有限数字的记录；扩展行按原 key 映射返回：cashflow_role→cashflowRole（cash/credit/debt/non_cash）、balance_date→balanceDate、status→status、period_start→periodStart、period_end→periodEnd、verified→verified，其余未知扩展 key 原样放入该记录的 extra 对象（值按数字/布尔/字符串原样保留）。其中 investment_period_start、investment_period_end、investment_flow_verified 是 Firance 原生 key：必须以原 key 原样放入该记录的 extra，不得改名或映射为 period_start/period_end/verified，也不得与通用 periodStart/periodEnd/verified 合并或互相覆盖（两套字段并存时以各自原值返回）；status 的值必须原样返回，不得改写、翻译或归一化。原始文件只读，不得回写，不得为历史记录补造核实标记。若 Mac 不在线或文件读取失败，不要伪造；用 success:false 回调并说明失败。\n2. 在 Muse runtime 依次运行只读命令 plaid accounts、plaid liabilities、plaid investments-holdings。将账户整理为 institution/name/type/subtype/mask/current。将 mortgage current 余额作为 loan 账户返回；不要返回内部 account_id 或 credential_id。将 holdings 按 security_id 与 securities 关联后逐条返回，不要预先截断为 Top 10（服务端会保留全量规范化集合）：每条返回 ticker/name/value（取 institution_value）/currency/institution，其中 currency 为该持仓的 iso_currency_code（确实无法确定时返回 null，不得默认填 USD）、institution 为持仓所在机构名称；institution_value 缺失时 value 返回 null，负值原样返回，不得丢弃、不得取绝对值；不要返回任何内部 ID、原始 JSON 或凭证。\n3. 再用 Plaid transactions 拉取 checking/savings 账户最多最近 730 天的交易，分页取全。只返回 date、amount、name、pending，以及根据 Plaid 类别和交易对手判断的 internalTransfer（自己名下账户互转）与 transferLike（疑似转账）布尔值；Plaid 正数表示流出。返回 transactionCoverage={start,end,complete}，只有覆盖区间内分页完整无缺失时 complete=true；交易读取失败时保留其他数据并将 transactionCoverage 设为 null、plaidTransactions 设为空数组。\n4. 完成后调用 ingestFinanceData。成功参数必须是：{success:true,asOf:<带时区ISO>,months:[{key,entries:[{financeSource,type,number,可选 cashflowRole/balanceDate/status/periodStart/periodEnd/verified/extra}]}],plaidAccounts:[{institution,name,type,subtype,mask,current}],holdings:[{ticker,name,value,currency,institution}],plaidTransactions:[{date,amount,name,pending,internalTransfer,transferLike}],transactionCoverage:{start,end,complete}|null}。Firance、账户余额或持仓任一步无法可靠完成时调用 {success:false,error:<简洁中文>}；只有交易读取失败按上述方式回退，不使整次刷新失败。回传 ingestFinanceData 时必须原样带回本代标识：在回传参数中包含 generation 字段，值固定为 ${generation}（成功与失败两种回传都必须带；缺失或不一致的回传会被忽略，且不会改变刷新状态）。不要发送聊天消息。`,
        { expectsAction: "ingestFinanceData", dedupeKey: "weekly-firance-finance-refresh" },
      );
      if (!task.ok) {
        // F0.7 observability: the spawn itself returned failure.
        // The raw spawn error is never recorded — only the code.
        await recordObservation(ctx, { generation, event: "spawn_failed", outcome: "spawn_returned_failure", detail: "spawn_error" });
        // Spawn-tail CAS: settle to error only if this generation
        // is still the running one; a late spawn failure must not
        // error a generation that already settled or a newer
        // generation.
        const settled = await casSpawnTailState(ctx, generation, {
          status: "error",
          taskId: null,
          message: "本次更新失败，显示上次数据",
        });
        if (!settled) {
          await recordObservation(ctx, { generation, event: "spawn_tail_unattached", outcome: "spawn_failed_tail", detail: "spawn_tail" });
        }
        ctx.invalidateQueries();
        if (settled) {
          return { ok: false, status: "error", message: "刷新任务未能启动" };
        }
        const nowState = await getState(ctx);
        if (nowState?.status === "running") {
          return { ok: true, status: "already_running", message: "每周更新正在进行中" };
        }
        if (nowState?.status === "idle") {
          return { ok: true, status: "started", message: "更新已完成" };
        }
        return { ok: false, status: "error", message: nowState?.message ?? "刷新任务未能启动" };
      }
      // Spawn-tail CAS: record the task id only on this
      // generation's still-running row. If the callback already
      // settled this generation (or a new generation replaced it)
      // while spawnTask was in flight, the state row belongs to
      // that outcome now — leave it exactly as it is and answer
      // from the actual state.
      const attached = await casSpawnTailState(ctx, generation, {
        status: "running",
        taskId: task.taskId,
        message: "正在同步 Firance 与 Plaid",
      });
      if (attached) {
        await recordObservation(ctx, { generation, event: "spawn_attached", outcome: "task_attached" });
        return { ok: true, status: "started", message: "更新已开始" };
      }
      // F0.7 observability: the spawn succeeded but its tail CAS
      // missed — this generation no longer owns the state row
      // (its callback settled first, or a newer generation did).
      // The detail names only the status code now on the row,
      // never the task id.
      {
        const tailState = await getState(ctx);
        await recordObservation(ctx, {
          generation,
          event: "spawn_tail_unattached",
          outcome: "spawn_ok_tail",
          detail: tailState?.status === "idle"
            ? "status_idle"
            : tailState?.status === "error"
              ? "status_error"
              : tailState?.status === "running"
                ? "status_running"
                : null,
        });
      }
      const nowState = await getState(ctx);
      ctx.invalidateQueries();
      if (nowState?.status === "running") {
        return { ok: true, status: "already_running", message: "每周更新正在进行中" };
      }
      if (nowState?.status === "idle") {
        return { ok: true, status: "started", message: "更新已完成" };
      }
      return { ok: false, status: "error", message: nowState?.message ?? "本次更新失败，显示上次数据" };
    },
  }),

  ingestFinanceData: defineAction({
    request: z.discriminatedUnion("success", [
      z.object({
        success: z.literal(false),
        error: z.string().min(1).max(500),
        // F0.7 generation contract: the refresh generation this
        // callback belongs to, echoed verbatim from the task
        // prompt. Optional in the schema for legacy callers;
        // callbacks that omit or mismatch it are ignored by the
        // gate whenever a generation is stored.
        generation: z.string().min(1).max(128).optional(),
      }),
      z.object({
        success: z.literal(true),
        generation: z.string().min(1).max(128).optional(),
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
      // Finance stays strictly owner: the identity check is
      // unchanged and no viewer-less channel is admitted here.
      if (!isOwner(ctx)) return { ok: false, savedMonths: 0, issue: null };
      // Generation binding + idempotency (F0.7), in order:
      //  1. Generation gate: a callback arriving while a refresh
      //     runs must echo the stored generation; a missing or
      //     mismatched generation is an old generation's late
      //     return (its failure callbacks carry no asOf, so
      //     decideIngestCallback alone cannot tell them apart) —
      //     ignore, state untouched. A callback arriving after its
      //     generation has settled is likewise ignored: a
      //     generation settles exactly once.
      //  2. decideIngestCallback filters provably stale callbacks
      //     against the stored payload: a success no newer than
      //     it, a success stamped before this refresh started, any
      //     late failure after the state settled.
      //  3. Atomic claim arbitration: the callback stamps its own
      //     claim token into claimed_generation with a conditional
      //     UPDATE that matches only while the row is exactly what
      //     this call read (id, status, updatedAt, generation) AND
      //     still unclaimed. Exactly one callback per generation
      //     can hold the claim. A loser re-reads once: if the
      //     generation is already claimed, or the gate/decision no
      //     longer passes, it is ignored with savedMonths=0 — there
      //     is no "still applicable, proceed directly" path around
      //     the claim.
      //  4. The claim holder settles with a single CAS conditioned
      //     on its claim token and the claimed generation (plus
      //     the still-running status for a running generation):
      //     the payload write and the settle are the SAME write,
      //     so a callback whose generation was superseded mid-save
      //     matches zero rows and changes nothing — the payload is
      //     never half-replaced and the new generation's state is
      //     never settled by an old winner.
      const db = ctx.db<typeof schema>();
      const incomingGeneration = args.generation ?? null;
      // F0.7 observability: EVERY owner callback is recorded on
      // arrival, BEFORE any gate/decision — this is what makes a
      // delivered-but-ignored callback distinguishable from one
      // that never arrived. The row carries only the success flag
      // and whether a generation was echoed; never asOf, amounts,
      // payload fragments or error text.
      await recordObservation(ctx, {
        generation: incomingGeneration,
        event: "callback_received",
        outcome: args.success ? "success_flag" : "failure_flag",
      });
      const readIngestInputs = async () => {
        const state = await getState(ctx);
        let latestPayloadAsOf: string | null = null;
        let previousLiveNetWorth: number | null = null;
        if (state?.payload) {
          const prior = parseDashboardPayload(state.payload);
          if (prior.ok) {
            latestPayloadAsOf = prior.data.asOf;
            previousLiveNetWorth = prior.data.live.netWorth;
          }
        }
        return { state, latestPayloadAsOf, previousLiveNetWorth };
      };
      const gateFor = (state: FinanceStateRow) =>
        decideGenerationGate({
          refreshStatus: state?.status,
          storedGeneration: state?.generation ?? null,
          incomingGeneration,
        });
      const decideFor = (state: FinanceStateRow, latestPayloadAsOf: string | null) =>
        decideIngestCallback({
          refreshStatus: state?.status,
          refreshUpdatedAt: state?.updatedAt ?? null,
          latestPayloadAsOf,
          incomingSuccess: args.success,
          incomingAsOf: args.success ? args.asOf : null,
        });
      const ignoredResult = (): z.infer<typeof ingestResponse> =>
        ({ ok: args.success, savedMonths: 0, issue: null });
      // F0.7 observability: exactly one result event per callback
      // that passed arrival recording. `detail` names the branch
      // that produced the outcome — a short code only.
      const recordIgnored = async (detail: string) => {
        await recordObservation(ctx, {
          generation: incomingGeneration,
          event: "callback_ignored",
          outcome: args.success ? "success_flag" : "failure_flag",
          detail,
        });
      };

      const firstRead = await readIngestInputs();
      if (gateFor(firstRead.state) === "ignore") {
        await recordIgnored("generation_gate");
        return ignoredResult();
      }
      if (decideFor(firstRead.state, firstRead.latestPayloadAsOf) === "ignore") {
        await recordIgnored("stale_decision");
        return ignoredResult();
      }
      // The claim token this call would stamp if it wins
      // arbitration; null while unclaimed (no state row: the
      // pre-contract path, where no generation exists to
      // arbitrate).
      let claimToken: string | null = null;
      let claimSnapshot: FinanceStateRow;
      const tryClaim = async (snapshot: NonNullable<FinanceStateRow>): Promise<boolean> => {
        const token = newClaimToken();
        const claimRows = await db
          .update(schema.financeState)
          .set({ claimedGeneration: token, updatedAt: new Date() })
          .where(
            and(
              eq(schema.financeState.id, 1),
              eq(schema.financeState.status, snapshot.status),
              eq(schema.financeState.updatedAt, snapshot.updatedAt),
              snapshot.generation == null
                ? isNull(schema.financeState.generation)
                : eq(schema.financeState.generation, snapshot.generation),
              isNull(schema.financeState.claimedGeneration),
            ),
          )
          .returning({ id: schema.financeState.id });
        if (claimRows.length !== 1) return false;
        claimToken = token;
        claimSnapshot = snapshot;
        return true;
      };
      if (firstRead.state) {
        const won = await tryClaim(firstRead.state);
        if (!won) {
          // Lost the claim: the row changed under us — a
          // concurrent callback claimed this generation, or a new
          // generation started. Re-read once and re-check the gate
          // and decision; an already-claimed generation is a hard
          // stop, never a proceed-anyway.
          const secondRead = await readIngestInputs();
          if (gateFor(secondRead.state) === "ignore") {
            await recordIgnored("generation_gate");
            return ignoredResult();
          }
          if (decideFor(secondRead.state, secondRead.latestPayloadAsOf) === "ignore") {
            await recordIgnored("stale_decision");
            return ignoredResult();
          }
          if (!secondRead.state) {
            await recordIgnored("claim_lost");
            return ignoredResult();
          }
          if (secondRead.state.claimedGeneration != null) await recordIgnored("claim_lost");
          if (secondRead.state.claimedGeneration != null) return ignoredResult();
          const wonRetry = await tryClaim(secondRead.state);
          if (!wonRetry) {
            await recordIgnored("claim_lost");
            return ignoredResult();
          }
        }
      }
      // Claim-bound settle: the ONLY way a claimed callback may
      // change the refresh state or replace the payload. One
      // conditional UPDATE that must still see this call's claim
      // token and the claimed generation (and, for a running
      // generation, the unsettled running status).
      const settleClaimed = async (values: {
        payload?: string | null;
        previousLiveNetWorth?: number | null;
        status: "idle" | "error";
        message: string | null;
      }): Promise<boolean> => {
        if (claimToken == null || !claimSnapshot) {
          await writeState(ctx, { ...values });
          return true;
        }
        const rows = await db
          .update(schema.financeState)
          .set({
            ...(values.payload !== undefined ? { payload: values.payload } : {}),
            ...(values.previousLiveNetWorth !== undefined
              ? { previousLiveNetWorth: values.previousLiveNetWorth }
              : {}),
            status: values.status,
            taskId: null,
            message: values.message,
            claimedGeneration: null,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(schema.financeState.id, 1),
              eq(schema.financeState.claimedGeneration, claimToken),
              claimSnapshot.generation == null
                ? isNull(schema.financeState.generation)
                : eq(schema.financeState.generation, claimSnapshot.generation),
              ...(claimSnapshot.status === "running" ? [eq(schema.financeState.status, "running")] : []),
            ),
          )
          .returning({ id: schema.financeState.id });
        return rows.length === 1;
      };
      if (!args.success) {
        // Failure settle is claim-bound: if this call's claim was
        // superseded (a new generation started), settleClaimed
        // matches zero rows and the new generation's running state
        // is left exactly as it is.
        const settled = await settleClaimed({ status: "error", message: "本次更新失败，显示上次数据" });
        if (settled) {
          await recordObservation(ctx, {
            generation: incomingGeneration,
            event: "callback_applied_failure",
            outcome: "failure_flag",
          });
        } else {
          await recordIgnored("settle_superseded");
        }
        ctx.invalidateQueries();
        return { ok: false, savedMonths: 0, issue: null };
      }
      // F0.3 gate: invalid calendar dates and conflicting same-day
      // snapshots are input problems. The stored payload and its asOf
      // are left untouched; the issue names only the date and the
      // problem category, never the submitted values.
      const normalization = normalizeRawMonths(args.months);
      if (!normalization.ok) {
        const settled = await settleClaimed({
          status: "error",
          message: `本次更新未保存：${normalization.issue}。已保留上次成功数据，修正后可重新更新。`,
        });
        if (settled) {
          // The issue text itself is never recorded — only the
          // category code.
          await recordObservation(ctx, {
            generation: incomingGeneration,
            event: "callback_applied_failure",
            outcome: "success_flag",
            detail: "normalization_issue",
          });
        } else {
          await recordIgnored("settle_superseded");
        }
        ctx.invalidateQueries();
        return { ok: false, savedMonths: 0, issue: normalization.issue };
      }
      const dashboard = buildDashboard(
        args.asOf,
        normalization.months,
        args.plaidAccounts,
        args.holdings,
        args.plaidTransactions,
        args.transactionCoverage,
        firstRead.previousLiveNetWorth,
      );
      if (!dashboard) {
        const settled = await settleClaimed({ status: "error", message: "本次更新没有可用的月度数据，显示上次数据" });
        if (settled) {
          await recordObservation(ctx, {
            generation: incomingGeneration,
            event: "callback_applied_failure",
            outcome: "success_flag",
            detail: "no_dashboard",
          });
        } else {
          await recordIgnored("settle_superseded");
        }
        ctx.invalidateQueries();
        return { ok: false, savedMonths: 0, issue: null };
      }
      const published = await settleClaimed({
        payload: JSON.stringify(dashboard),
        previousLiveNetWorth: firstRead.previousLiveNetWorth,
        status: "idle",
        message: "更新完成",
      });
      ctx.invalidateQueries();
      if (!published) {
        // Superseded while saving: the settle matched zero rows,
        // so nothing was written — the stored payload keeps the
        // newer generation's data and this callback reports an
        // honest savedMonths=0.
        await recordIgnored("settle_superseded");
        return { ok: true, savedMonths: 0, issue: null };
      }
      await recordObservation(ctx, {
        generation: incomingGeneration,
        event: "callback_applied_success",
        outcome: "success_flag",
        detail: `saved_months:${dashboard.months.length}`,
      });
      return { ok: true, savedMonths: dashboard.months.length, issue: null };
    },
  }),

  // F0.7 read-only observability query. Strictly owner-only, like
  // every other finance read: a non-owner gets guest_denied and
  // zero data (no state summary, no observations, no diagnosis).
  // The state summary reports only the EXISTENCE of taskId /
  // generation — never their values. The diagnosis is derived by
  // the exported pure function from the state + observation
  // stream, so the UI renders facts, not guesses.
  //
  // F0.7-OBS-001: attribution is per attempt. Rows carry only an
  // owner-safe attempt ordinal + relation (current / history /
  // unknown) — the raw generation never leaves the server. The
  // diagnosis is computed from the CURRENT attempt's own event
  // chain, fetched separately from the 20-row display stream so
  // a flood of other generations' late events can never push the
  // current attempt's evidence out of the diagnosis.
  getRefreshObservations: defineAction({
    request: z.object({}),
    response: refreshObservationsResponse,
    async handler(ctx): Promise<z.infer<typeof refreshObservationsResponse>> {
      if (!isOwner(ctx)) {
        return {
          access: "guest_denied",
          state: null,
          currentAttempt: null,
          observations: [],
          diagnosis: null,
        };
      }
      const db = ctx.db<typeof schema>();
      const state = await getState(ctx);
      const currentGeneration = state?.generation ?? null;
      // Attempt order: generations in the order their start was
      // recorded. Only refresh_started rows define an attempt.
      const startRows = await db
        .select({ generation: schema.refreshObservations.generation })
        .from(schema.refreshObservations)
        .where(eq(schema.refreshObservations.event, "refresh_started"))
        .orderBy(schema.refreshObservations.id);
      const attemptOrder: string[] = [];
      for (const row of startRows) {
        if (row.generation != null && !attemptOrder.includes(row.generation)) {
          attemptOrder.push(row.generation);
        }
      }
      const obsFields = {
        id: schema.refreshObservations.id,
        generation: schema.refreshObservations.generation,
        event: schema.refreshObservations.event,
        outcome: schema.refreshObservations.outcome,
        detail: schema.refreshObservations.detail,
        createdAt: schema.refreshObservations.createdAt,
      };
      const displayRows = await db
        .select(obsFields)
        .from(schema.refreshObservations)
        .orderBy(desc(schema.refreshObservations.id))
        .limit(20);
      const ownRows = currentGeneration != null
        ? await db
            .select(obsFields)
            .from(schema.refreshObservations)
            .where(eq(schema.refreshObservations.generation, currentGeneration))
            .orderBy(desc(schema.refreshObservations.id))
            .limit(20)
        : [];
      const byId = new Map<number, (typeof displayRows)[number]>();
      for (const row of [...displayRows, ...ownRows]) byId.set(row.id, row);
      const mergedRows = [...byId.values()].sort((a, b) => b.id - a.id);
      const diagnosis = deriveRefreshDiagnosis({
        status: state?.status ?? null,
        currentGeneration,
        attemptOrder,
        observations: mergedRows.map((row) => ({
          event: row.event,
          outcome: row.outcome,
          detail: row.detail,
          generation: row.generation,
        })),
      });
      const currentAttempt = refreshAttemptOrdinal(attemptOrder, currentGeneration);
      const observations = displayRows.map((row) => ({
        event: row.event,
        outcome: row.outcome,
        detail: row.detail,
        createdAt: row.createdAt.toISOString(),
        attempt: refreshAttemptOrdinal(attemptOrder, row.generation),
        relation: refreshAttemptRelation({
          rowGeneration: row.generation,
          currentGeneration,
          attemptOrder,
        }),
      }));
      return {
        access: "owner",
        state: {
          status: state?.status ?? "idle",
          startedAt: state?.startedAt?.toISOString() ?? null,
          updatedAt: state?.updatedAt?.toISOString() ?? null,
          hasTaskId: state?.taskId != null,
          hasGeneration: state?.generation != null,
          attempt: currentAttempt,
        },
        currentAttempt,
        observations,
        diagnosis,
      };
    },
  }),

  // F-ARCH-001: the ONE controlled write entry for the new
  // architecture's total-assets figure, approved by the owner as
  // a scoped exception for this architecture only. The server
  // recomputes the total from the submitted rows under the same
  // rules as finance-arch summarizeNetWorth, rejects any mismatch
  // or malformed row set without writing, appends the verified
  // figure to arch_net_worth, and confirms it by reading the row
  // back. The response carries counts and booleans only — never
  // an amount.
  ingestArchNetWorth: defineAction({
    request: ingestArchNetWorthRequest,
    response: ingestArchNetWorthResponse,
    async handler(ctx, args): Promise<IngestArchNetWorthResult> {
      if (!isOwnerOrSyncChannel(ctx)) return archIngestFailure("forbidden");
      const pulledAtMs = Date.parse(args.pulledAt);
      if (!Number.isFinite(pulledAtMs) || !/(?:Z|[+-]\d{2}:?\d{2})\s*$/i.test(args.pulledAt)) {
        return archIngestFailure("invalid_pulled_at");
      }
      const seenIds = new Set<string>();
      for (const account of args.accounts) {
        if (seenIds.has(account.id)) return archIngestFailure("duplicate_id");
        seenIds.add(account.id);
        if (account.coverage === "missing") {
          if (account.balance !== null) return archIngestFailure("unexpected_balance");
        } else {
          if (account.balance === null) return archIngestFailure("missing_balance");
          if (account.asOf === null) return archIngestFailure("missing_as_of");
          // DATE-1 write gate: a non-missing row's asOf must be a
          // REAL calendar date (isRealDateKey — leap years
          // included), not merely YYYY-MM-DD-shaped. 2026-02-30,
          // 2026-13-01, 2026-04-31 and malformed strings are all
          // rejected here, before any insert; nothing backfills
          // the date from pulledAt / storedAt / today. Missing
          // rows above keep asOf=null untouched.
          if (!isRealDateKey(account.asOf)) return archIngestFailure("invalid_as_of");
        }
      }
      const rows: ArchNetWorth["rows"] = [];
      const missing: string[] = [];
      let total = 0;
      for (const account of args.accounts) {
        const balance = account.balance;
        const included = account.coverage !== "missing" && balance !== null;
        let signed: number | null = null;
        if (included && balance !== null) {
          signed = account.kind === "liability" ? -Math.abs(balance) : balance;
          total += signed;
        } else {
          missing.push(account.id);
        }
        rows.push({ id: account.id, included, signed, asOf: account.asOf, coverage: account.coverage });
      }
      if (Math.abs(total - args.total) > 0.01) {
        return {
          ok: false,
          issue: "total_mismatch",
          rows: rows.length,
          included: rows.length - missing.length,
          missing: missing.length,
          totalMatches: false,
          readBackVerified: false,
        };
      }
      // Ranges and coverage counts come from the same pure
      // derivation the read path applies (sanitizeArchNetWorthDates),
      // so a freshly written figure and a legacy figure are
      // presented under identical date-eligibility rules. Every
      // non-missing asOf here already passed isRealDateKey at the
      // gate above, so the stored ranges are the valid-date ones.
      const payload: ArchNetWorth = sanitizeArchNetWorthDates({
        arch: "F-ARCH-001",
        version: 1,
        pulledAt: args.pulledAt,
        storedAt: new Date().toISOString(),
        total,
        partial: missing.length > 0,
        missing,
        plaidRange: null,
        snapshotRange: null,
        rows,
        amountIncluded: 0,
        amountTotal: 0,
        validDateCount: 0,
        dateTotal: 0,
      });
      const db = ctx.db<typeof schema>();
      // SAVE-1 arbitration BEFORE any write, over the stored
      // candidates (unparsable rows are skipped, exactly as on
      // the read path):
      // - args.pulledAt earlier than the greatest stored
      //   pulledAt -> stale_version, zero writes: a late older
      //   version never becomes current.
      // - a stored row with the same pulledAt and equivalent
      //   normalized content -> logical idempotency: no append;
      //   that row becomes the read-back target and the call
      //   succeeds (a retry after a lost response is safe).
      // - same pulledAt but different content -> version_conflict,
      //   zero writes.
      const existingRows = await db.select().from(schema.archNetWorth);
      let maxStoredMs = Number.NEGATIVE_INFINITY;
      const sameVersion: { row: ArchStoredRow; parsed: ArchNetWorth }[] = [];
      for (const row of existingRows) {
        const parsed = parseArchStoredRow(row);
        if (!parsed) continue;
        const key = archVersionKey(row, parsed);
        if (key > maxStoredMs) maxStoredMs = key;
        if (key === pulledAtMs) sameVersion.push({ row, parsed });
      }
      if (pulledAtMs < maxStoredMs) return archIngestFailure("stale_version");
      let targetRowId: number | null = null;
      if (sameVersion.length > 0) {
        const hit = sameVersion.find((candidate) => archPayloadsEquivalent(candidate.parsed, payload));
        if (!hit) return archIngestFailure("version_conflict");
        targetRowId = hit.row.id;
      }
      if (targetRowId === null) {
        const inserted = await db
          .insert(schema.archNetWorth)
          .values({
            payload: JSON.stringify(payload),
            pulledAt: new Date(pulledAtMs),
          })
          .returning({ id: schema.archNetWorth.id });
        targetRowId = inserted[0]?.id ?? null;
      }
      // SAVE-1 exact read-back: re-read THIS write's own row by
      // id (the inserted row, or the idempotency-hit row) and
      // deep-compare the full normalized payload — every field
      // except storedAt. Matching pulledAt / row count / total
      // alone is NOT verification: a stand-in row whose account
      // ids, coverage or asOf differ fails here.
      let readBackVerified = false;
      if (targetRowId !== null) {
        const backRows = await db
          .select()
          .from(schema.archNetWorth)
          .where(eq(schema.archNetWorth.id, targetRowId))
          .limit(1);
        const backRow = backRows[0];
        if (backRow) {
          const parsedBack = parseArchStoredRow(backRow);
          readBackVerified = parsedBack !== null && archPayloadsEquivalent(parsedBack, payload);
        }
      }
      return {
        ok: readBackVerified,
        issue: readBackVerified ? null : "read_back_mismatch",
        rows: rows.length,
        included: rows.length - missing.length,
        missing: missing.length,
        totalMatches: true,
        readBackVerified,
      };
    },
  }),
} satisfies ActionsModule;
