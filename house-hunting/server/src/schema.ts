import { integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const reports = sqliteTable("reports", {
  id: integer("id").primaryKey({ autoIncrement: true }),
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
});
