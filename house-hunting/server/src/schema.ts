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
  status: text("status", { enum: ["active", "contingent", "pending", "unknown"] }).notNull(),
  schoolSummary: text("school_summary").notNull(),
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
