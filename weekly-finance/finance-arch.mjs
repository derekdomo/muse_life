// F-ARCH-001 synthetic calculation contract (see F-ARCH-001-SPEC.md).
// Pure functions over SYNTHETIC fixtures only — no real accounts, no
// production data, no writes. Defines: mixed-freshness net worth,
// single-stream spend (posted/pending split, two definitional
// exclusions, traceable refund offsets), FIRE complete-month gating,
// and the anomaly v0 candidate rule.

// ---------- Net worth: mixed-freshness latest-known total ----------
// accounts: [{ id, balance (signed; liabilities negative or flagged),
//   kind: "asset"|"liability", coverage: "plaid"|"snapshot"|"missing",
//   asOf: "YYYY-MM-DD"|null, readAt: iso|null }]
// Missing/unknown balances are NEVER counted as 0: they are listed in
// `missing` and excluded from the total, which is then flagged partial.
export function summarizeNetWorth(accounts) {
  const rows = [];
  const missing = [];
  let total = 0;
  for (const a of accounts) {
    if (a.coverage === "missing" || a.balance === null || a.balance === undefined) {
      missing.push(a.id);
      rows.push({ id: a.id, included: false, signed: null, asOf: a.asOf ?? null, readAt: a.readAt ?? null, coverage: a.coverage });
      continue;
    }
    const signed = a.kind === "liability" ? -Math.abs(a.balance) : a.balance;
    total += signed;
    rows.push({ id: a.id, included: true, signed, asOf: a.asOf ?? null, readAt: a.readAt ?? null, coverage: a.coverage });
  }
  const layerRange = (coverage) => {
    const dates = rows.filter((r) => r.included && r.coverage === coverage && r.asOf).map((r) => r.asOf).sort();
    return dates.length ? { oldest: dates[0], newest: dates[dates.length - 1] } : null;
  };
  return {
    label: "混合日期的最新已知净资产",
    total,
    partial: missing.length > 0,
    missing,
    plaidRange: layerRange("plaid"),
    snapshotRange: layerRange("snapshot"),
    rows,
  };
}

// ---------- Single spend stream ----------
// txns: [{ id, date "YYYY-MM-DD", amount (signed, outflow negative),
//   status: "posted"|"pending",
//   kind: "spend"|"transfer"|"loan_principal"|"refund"|"loan_mixed"|"unmatched_transfer",
//   refundOf?: txnId (for kind "refund") }]
// Only two definitional exclusions: own-account transfers and loan
// principal. Refunds offset in the ORIGINAL transaction's month via a
// traceable pair, never by deleting the original spend. Unclassifiable
// rows stay visible in `unclassified` and make the month incomplete.
export function summarizeSpendMonth(txns, month) {
  const seen = new Set();
  let postedSpend = 0;
  let pendingSpend = 0;
  const unclassified = [];
  const offsets = [];
  const inMonth = (d) => d.startsWith(month);
  const byId = new Map(txns.map((t) => [t.id, t]));
  for (const t of txns) {
    if (seen.has(t.id)) continue; // stable-ID dedupe
    seen.add(t.id);
    if (t.kind === "refund") {
      const orig = byId.get(t.refundOf);
      if (orig && inMonth(orig.date)) {
        // Refund offsets the original month's stream (amount positive).
        if (t.status === "posted") { postedSpend -= Math.abs(t.amount); offsets.push({ refundId: t.id, of: t.refundOf, amount: Math.abs(t.amount), month }); }
      }
      continue;
    }
    if (!inMonth(t.date)) continue;
    if (t.kind === "transfer" || t.kind === "loan_principal") continue; // the two exclusions
    if (t.kind === "loan_mixed" || t.kind === "unmatched_transfer") { unclassified.push(t.id); continue; }
    if (t.kind === "spend") {
      if (t.status === "pending") pendingSpend += Math.abs(t.amount);
      else postedSpend += Math.abs(t.amount);
    }
  }
  return {
    month,
    postedSpend,
    pendingSpend,
    unclassified,
    offsets,
    complete: unclassified.length === 0,
  };
}

// Month completeness for FIRE: a month counts only with full
// single-stream coverage (no unclassified rows, coverage flag true).
export function fireEligibleMonths(monthSummaries, coverageByMonth, throughMonth) {
  const eligible = [];
  const missing = [];
  for (const m of monthSummaries) {
    if (m.month >= throughMonth) continue; // only ENDED natural months
    if (coverageByMonth[m.month] === true && m.complete) eligible.push(m.month);
    else missing.push(m.month);
  }
  const last12 = eligible.slice(-12);
  return { eligible: last12, complete12: last12.length === 12, missing };
}

// ---------- Anomaly v0 (candidate thresholds, NOT adopted) ----------
// Baseline: median of last 3 comparable complete months. Current month
// compares the same elapsed-days window. Fires only when relative
// deviation > 30% AND absolute deviation > medianDaily*7. Fewer than 3
// comparable months, zero baseline, or missing coverage -> no verdict.
export function anomalyV0({ baselineMonths, currentToDate, currentElapsedDays, coverageOk }) {
  // Mid-month progress and month-end totals are different comparisons
  // and are never conflated: elapsedDays >= 30 is a month-end total,
  // anything shorter is a progress reading against the same elapsed
  // window of the baseline months.
  const comparisonKind = currentElapsedDays >= 30 ? "month-end" : "mid-month-progress";
  if (!coverageOk) return { verdict: "insufficient", reason: "coverage 缺失", comparisonKind };
  if (!Array.isArray(baselineMonths) || baselineMonths.length < 3) return { verdict: "insufficient", reason: "可比完整月少于 3 个", comparisonKind };
  const sorted = [...baselineMonths].map((m) => m.spend).sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  if (median === 0) return { verdict: "insufficient", reason: "基准为 0", comparisonKind };
  const dailyMedian = median / 30;
  // Same-elapsed-days baseline slice: scale each baseline month to the
  // elapsed window proportionally (synthetic simplification, stated).
  const baselineWindow = median * (currentElapsedDays / 30);
  const absDev = Math.abs(currentToDate - baselineWindow);
  const relDev = baselineWindow === 0 ? 0 : absDev / baselineWindow;
  const fires = relDev > 0.30 && absDev > dailyMedian * 7;
  return {
    verdict: fires ? "anomaly" : "normal",
    comparisonKind,
    median,
    baselineWindow,
    absDev,
    relDev,
    thresholds: { rel: 0.30, absFloor: dailyMedian * 7 },
  };
}

// ---------- Synthetic preview: the first-slice card model ----------
// Composes the three contracts above into exactly the card model the
// 2026-10-25 calculation/presentation slice will render, over purely
// synthetic input. This is a preview contract, not production data:
// no account is read and nothing is written anywhere.
// input: { accounts, txns, currentMonth, asOfDate, monthSummaries,
//   coverageByMonth, baselineMonths, currentElapsedDays }
export function buildArchPreview(input) {
  const netWorth = summarizeNetWorth(input.accounts);
  const spend = summarizeSpendMonth(input.txns, input.currentMonth);
  const fire = fireEligibleMonths(input.monthSummaries, input.coverageByMonth, input.currentMonth);
  const anomaly = anomalyV0({
    baselineMonths: input.baselineMonths,
    currentToDate: spend.postedSpend,
    currentElapsedDays: input.currentElapsedDays,
    coverageOk: spend.complete && input.coverageByMonth[input.currentMonth] !== false,
  });
  return {
    // Main card: mixed-date latest-known total, two freshness layers
    // and the missing list stay separate — never one "live" number.
    netWorthCard: {
      label: netWorth.label,
      total: netWorth.total,
      partial: netWorth.partial,
      missing: netWorth.missing,
      plaidRange: netWorth.plaidRange,
      snapshotRange: netWorth.snapshotRange,
      rows: netWorth.rows,
    },
    // Daily spend replaces any fixed/flexible pair with three lines:
    // posted so far / pending not yet counted / coverage gaps.
    spendCard: {
      title: `本月花销（截至 ${input.asOfDate}）`,
      lines: [
        { key: "posted", label: "已发生 spend", amount: spend.postedSpend },
        { key: "pending", label: "待入账交易（未计入已发生）", amount: spend.pendingSpend },
        { key: "gap", label: "覆盖缺口", amount: null, unclassified: spend.unclassified, complete: spend.complete },
      ],
      offsets: spend.offsets,
    },
    fireCard: {
      eligibleMonths: fire.eligible,
      complete12: fire.complete12,
      missingMonths: fire.missing,
      note: fire.complete12 ? "近 12 个完整月同口径" : "完整月不足 12 个，缺月如实列出、不补数",
    },
    anomalyCard: anomaly,
  };
}
