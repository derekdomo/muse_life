import { integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const reports = sqliteTable("reports", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  // HH0.3 atomic visibility: a freshly ingested report starts as an
  // invisible candidate (published = 0); it becomes visible only when the
  // publish CAS flips the refresh_state pointer to it (which also sets
  // this flag). getReport resolves the visible report through the
  // pointer, falling back to the newest published report.
  published: integer("published").notNull().default(0),
  asOf: text("as_of").notNull(),
  mortgageRate: real("mortgage_rate").notNull(),
  rateLabel: text("rate_label").notNull(),
  rateSource: text("rate_source").notNull(),
  rateUrl: text("rate_url").notNull(),
  summary: text("summary").notNull(),
  // HH1.5: the date the mortgage-rate source was published/observed
  // (ISO date or datetime, as supplied by the research agent).
  // Nullable: legacy rows honestly show "日期未知" and are never
  // backfilled with an invented date.
  rateAsOf: text("rate_as_of"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
});

export const listings = sqliteTable("listings", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  reportId: integer("report_id").notNull().references(() => reports.id, { onDelete: "cascade" }),
  rank: integer("rank").notNull(),
  score: integer("score").notNull(),
  address: text("address").notNull(),
  city: text("city", { enum: ["Santa Clara", "Sunnyvale", "Cupertino"] }).notNull(),
  url: text("url").notNull(),
  price: integer("price").notNull(),
  bedrooms: integer("bedrooms").notNull(),
  bathrooms: real("bathrooms").notNull(),
  sqft: integer("sqft").notNull(),
  lotSqft: integer("lot_sqft"),
  yearBuilt: integer("year_built"),
  daysOnMarket: integer("days_on_market"),
  pricePerSqft: integer("price_per_sqft"),
  priceChange: integer("price_change"),
  hoaMonthly: integer("hoa_monthly"),
  // HH0.4: status vocabulary extended with sold / off_market. SQLite
  // text does not enforce the enum; the drizzle-level enum documents
  // the accepted values and legacy rows keep working unchanged.
  status: text("status", { enum: ["active", "contingent", "pending", "unknown", "sold", "off_market"] }).notNull(),
  // HH0.4: when the listing's status was last verified by the research
  // agent (epoch milliseconds). Nullable: legacy rows and unverifiable
  // statuses stay null and the UI says "核验时间未知" instead of
  // inventing a time.
  statusVerifiedAt: integer("status_verified_at"),
  // HH0.5 rubric sub-scores (0–100, nullable; null = not assessed,
  // never 0). The stored `score` is the rubric total computed from
  // these by server/src/rubric.ts; it stays the agent-supplied score
  // only for legacy rows that carry no sub-scores at all.
  scoreHardCriteria: integer("score_hard_criteria"),
  scoreEnvironment: integer("score_environment"),
  scoreSchool: integer("score_school"),
  scoreAgeCondition: integer("score_age_condition"),
  scoreSpace: integer("score_space"),
  scorePriceComps: integer("score_price_comps"),
  schoolSummary: text("school_summary").notNull(),
  // HH1.5: provenance of the school ratings quoted in schoolSummary —
  // source name and its date, both nullable. Legacy rows and listings
  // whose ratings could not be sourced stay null and the UI says
  // "来源未知 / 日期未知" instead of inventing provenance.
  schoolSource: text("school_source"),
  schoolAsOf: text("school_as_of"),
  // HH1.3: this listing's price / listing status in the PREVIOUS
  // published report, recorded by ingest only when the value actually
  // changed versus that issue (matched by the stable address+city
  // key). Null means "no change recorded" (including first
  // appearance); the UI shows explicit 价格变化 / 状态变化 markers
  // only when these are non-null.
  prevPrice: integer("prev_price"),
  prevStatus: text("prev_status"),
  environmentSummary: text("environment_summary").notNull(),
  conditionSummary: text("condition_summary").notNull(),
  verdict: text("verdict").notNull(),
  caution: text("caution"),
});

export const refreshState = sqliteTable("refresh_state", {
  id: integer("id").primaryKey(),
  status: text("status", { enum: ["idle", "running", "error"] }).notNull(),
  taskId: text("task_id"),
  message: text("message"),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
  // HH0.2 generation binding: refreshReport mints this id when a refresh
  // starts and the research task must echo it back in its ingestResearch
  // callback (success and failure alike). Null on rows written before the
  // generation contract existed; such legacy rows fall back to the
  // pre-generation decision rules.
  generation: text("generation"),
  // HH0.2 arbitration claim marker: the ingest callback that wins the
  // conditional claim UPDATE stamps its own claim token here, where a
  // concurrent loser's re-read can see it. Null means unclaimed; the
  // settle/publish CAS must match the winner's token, and starting a new
  // generation clears it.
  claimedGeneration: text("claimed_generation"),
  // HH0.3 publish pointer: id of the currently visible (published)
  // report. Switched exactly once per generation by the same CAS that
  // settles the refresh state, so a half-written candidate report is
  // never visible.
  publishedReportId: integer("published_report_id"),
});

// HH1.3 owner decisions, keyed by the listing's stable identity
// (normalized address + city — see listingStableKey in
// server/src/decision.ts), NOT by report-scoped listing id: a weekly
// re-issue creates brand-new listing rows, and the owner's
// favorite / excluded / viewed state must carry over by stable key.
// Pure additive table; decision is null when the owner cleared the
// state (the row may remain as a tombstone or be deleted — reads
// treat both the same).
export const listingUserStates = sqliteTable("listing_user_states", {
  stableKey: text("stable_key").primaryKey(),
  decision: text("decision", { enum: ["favorite", "excluded", "viewed"] }),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
});
