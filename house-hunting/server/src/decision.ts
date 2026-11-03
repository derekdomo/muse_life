// HH1 decision-support pure functions: transparent monthly-cost
// estimates (HH1.1), the fixed comparison columns (HH1.2), stable
// listing identity + cross-issue change detection + owner decisions
// (HH1.3), the viewing checklist (HH1.4), and source-date freshness
// (HH1.5).
//
// Pure functions only: this module has ZERO imports and every export
// is a deterministic function of its arguments (no I/O, no clock
// reads — callers pass `now` explicitly). The formulas and thresholds
// are documented in DATA-PLAN.md (HH1 section) and must stay in sync
// with this file. The client mirrors the monthly-cost formula for its
// editable-assumption inputs; it never recomputes rubric scores
// (HH0.5 stays server-only in rubric.ts).

// --- HH1.1 monthly cost estimate -------------------------------------

// Default annual assumptions, editable in the UI. The property-tax
// default is the commonly cited Santa Clara County effective rate
// (~1.18% of price per year); the insurance default is ~0.20% of
// price per year. Both are ESTIMATES, labelled as such in the UI —
// never presented as the listing's actual tax bill or premium.
export const COST_DEFAULTS = {
  taxRatePct: 1.18,
  insuranceRatePct: 0.2,
  downPaymentPct: 30,
} as const;

export interface MonthlyCostInput {
  price: number;
  downPaymentPct: number;
  annualRatePct: number;
  taxRatePct: number;
  insuranceRatePct: number;
  // Listing HOA dues per month; null means "no HOA on record /
  // unknown" — it is NEVER silently treated as 0 in the total.
  hoaMonthly: number | null;
}

export interface MonthlyCostBreakdown {
  principalInterest: number;
  propertyTaxMonthly: number;
  insuranceMonthly: number;
  hoaMonthly: number | null;
  hoaKnown: boolean;
  // Sum of the three always-known parts (P&I + tax + insurance).
  subtotalExcludingHoa: number;
  // Full monthly total, or null when the HOA part is unknown — an
  // honest "cannot total yet", never a total that hides a missing
  // component.
  totalMonthly: number | null;
}

// Standard 30-year fixed amortization for principal + interest — the
// same formula the page has always used for its P&I figure.
export function principalAndInterestMonthly(
  price: number,
  downPaymentPct: number,
  annualRatePct: number,
): number {
  const principal = price * (1 - downPaymentPct / 100);
  const monthlyRate = annualRatePct / 100 / 12;
  const months = 360;
  if (monthlyRate === 0) return principal / months;
  const factor = Math.pow(1 + monthlyRate, months);
  return (principal * monthlyRate * factor) / (factor - 1);
}

export function monthlyCostBreakdown(input: MonthlyCostInput): MonthlyCostBreakdown {
  const principalInterest = principalAndInterestMonthly(
    input.price,
    input.downPaymentPct,
    input.annualRatePct,
  );
  const propertyTaxMonthly = (input.price * (input.taxRatePct / 100)) / 12;
  const insuranceMonthly = (input.price * (input.insuranceRatePct / 100)) / 12;
  const hoaKnown = typeof input.hoaMonthly === "number" && Number.isFinite(input.hoaMonthly);
  const hoaMonthly = hoaKnown ? input.hoaMonthly : null;
  const subtotalExcludingHoa = principalInterest + propertyTaxMonthly + insuranceMonthly;
  return {
    principalInterest,
    propertyTaxMonthly,
    insuranceMonthly,
    hoaMonthly,
    hoaKnown,
    subtotalExcludingHoa,
    totalMonthly: hoaKnown ? subtotalExcludingHoa + (hoaMonthly as number) : null,
  };
}

// --- HH1.2 fixed comparison columns ----------------------------------

// The comparison column set is FIXED by spec (HH1.2): not
// user-customizable, always in this order. Missing values render as
// "—" in the UI; nothing is guessed.
export const COMPARE_COLUMNS = [
  { key: "price", label: "价格" },
  { key: "sqft", label: "居住面积" },
  { key: "lotSqft", label: "占地面积" },
  { key: "age", label: "房龄" },
  { key: "school", label: "学校" },
  { key: "environment", label: "道路/噪音" },
  { key: "status", label: "挂牌状态" },
  { key: "risk", label: "风险" },
  { key: "monthlyCost", label: "月成本" },
] as const;

export type CompareColumnKey = (typeof COMPARE_COLUMNS)[number]["key"];

export const COMPARE_MIN = 2;
export const COMPARE_MAX = 4;

// Age in whole years derived from yearBuilt; null when the build year
// is unknown (the UI shows "—", never a guessed age).
export function listingAgeYears(
  yearBuilt: number | null | undefined,
  currentYear: number,
): number | null {
  if (typeof yearBuilt !== "number" || !Number.isFinite(yearBuilt) || yearBuilt <= 0) return null;
  const age = currentYear - yearBuilt;
  return age >= 0 ? age : null;
}

// --- HH1.3 stable identity, change detection, owner decisions --------

// A listing's stable identity across weekly issues: normalized
// address + city. The weekly ingest matches the previous published
// issue by this key so owner decisions survive re-issues and price /
// status changes can be marked against the previous issue.
export function listingStableKey(address: string, city: string): string {
  const norm = (value: string) => value.trim().toLowerCase().replace(/\s+/g, " ");
  return `${norm(address)}|${norm(city)}`;
}

// The three owner decisions. They are mutually exclusive by design
// (one stored state per listing): a listing is at most one of
// favorite / excluded / viewed; clearing returns it to null. The UI
// presents exactly this three-way choice.
export const LISTING_DECISIONS = ["favorite", "excluded", "viewed"] as const;
export type ListingDecision = (typeof LISTING_DECISIONS)[number];

export interface ListingChangeDiff {
  priceChanged: boolean;
  previousPrice: number | null;
  statusChanged: boolean;
  previousStatus: string | null;
}

// Compare this issue's listing against the same listing (same stable
// key) in the previous published issue. No previous match → no
// changes (a first appearance is not a "change"). A changed field
// carries its previous value so the UI can show "上期 X → 本期 Y";
// unchanged fields carry null.
export function diffListingChanges(
  previous: { price: number; status: string } | null | undefined,
  next: { price: number; status: string },
): ListingChangeDiff {
  if (!previous) {
    return { priceChanged: false, previousPrice: null, statusChanged: false, previousStatus: null };
  }
  const priceChanged = previous.price !== next.price;
  const statusChanged = previous.status !== next.status;
  return {
    priceChanged,
    previousPrice: priceChanged ? previous.price : null,
    statusChanged,
    previousStatus: statusChanged ? previous.status : null,
  };
}

// --- HH1.4 viewing checklist ------------------------------------------

export type ChecklistItemState = "from-report" | "unverified";

export interface ChecklistItem {
  key: "noise" | "road" | "light" | "renovation" | "roofHvacElectrical" | "lotHoa";
  label: string;
  state: ChecklistItemState;
  detail: string;
}

const UNVERIFIED_DETAIL = "未核实 · 看房时亲自确认";

// The fixed viewing checklist (HH1.4). Default posture: verify in
// person. An item is "from-report" only when the report actually
// carries data for it (cited verbatim, source named); anything the
// report does not cover stays explicitly unverified — never written
// as fact. Sunlight （采光） and roof/HVAC/electrical have no report
// field at all, so they are always unverified.
export function buildViewingChecklist(input: {
  environmentSummary: string;
  conditionSummary: string;
  lotSqft: number | null;
  hoaMonthly: number | null;
}): ChecklistItem[] {
  const env = input.environmentSummary?.trim() ?? "";
  const cond = input.conditionSummary?.trim() ?? "";
  const envItem = (key: "noise" | "road", label: string): ChecklistItem =>
    env
      ? { key, label, state: "from-report", detail: `报告·居住环境：${env}` }
      : { key, label, state: "unverified", detail: UNVERIFIED_DETAIL };
  const lotParts: string[] = [];
  if (typeof input.lotSqft === "number" && Number.isFinite(input.lotSqft)) {
    lotParts.push(`占地 ${input.lotSqft.toLocaleString("en-US")} ft²`);
  }
  if (typeof input.hoaMonthly === "number" && Number.isFinite(input.hoaMonthly)) {
    lotParts.push(`HOA $${input.hoaMonthly}/月`);
  }
  return [
    envItem("noise", "噪音"),
    envItem("road", "道路"),
    { key: "light", label: "采光", state: "unverified", detail: UNVERIFIED_DETAIL },
    cond
      ? { key: "renovation", label: "装修质量", state: "from-report" as const, detail: `报告·房屋状态：${cond}` }
      : { key: "renovation", label: "装修质量", state: "unverified" as const, detail: UNVERIFIED_DETAIL },
    { key: "roofHvacElectrical", label: "屋顶 / HVAC / 电气", state: "unverified", detail: UNVERIFIED_DETAIL },
    lotParts.length > 0
      ? { key: "lotHoa", label: "地块与 HOA", state: "from-report" as const, detail: `报告数据：${lotParts.join(" · ")}` }
      : { key: "lotHoa", label: "地块与 HOA", state: "unverified" as const, detail: UNVERIFIED_DETAIL },
  ];
}

// --- HH1.5 source-date freshness --------------------------------------

// A sourced value (school ratings, the mortgage rate) is stale once
// its source date is MORE than 7 days old (strict >: exactly 7 days
// is still fresh). A missing or unparseable date is "unknown" —
// labelled 来源未知/日期未知， never silently treated as fresh.
export const STALE_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000;

export type SourceFreshness = "fresh" | "stale" | "unknown";

export function sourceFreshness(
  dateValue: string | number | null | undefined,
  nowMs: number,
): SourceFreshness {
  const t =
    typeof dateValue === "number"
      ? dateValue
      : typeof dateValue === "string"
        ? Date.parse(dateValue)
        : NaN;
  if (!Number.isFinite(t) || t <= 0) return "unknown";
  return nowMs - t > STALE_THRESHOLD_MS ? "stale" : "fresh";
}
