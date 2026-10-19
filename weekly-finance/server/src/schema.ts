import { integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const financeState = sqliteTable("finance_state", {
  id: integer("id").primaryKey(),
  payload: text("payload"),
  previousLiveNetWorth: real("previous_live_net_worth"),
  status: text("status", { enum: ["idle", "running", "error"] })
    .notNull()
    .default("idle"),
  taskId: text("task_id"),
  message: text("message"),
  // F0.7 generation binding: refreshFinanceData mints this id when a
  // refresh starts; the retrieval task must echo it verbatim in its
  // ingestFinanceData callback (success and failure alike). Legacy
  // rows written before this contract carry null and keep the
  // pre-generation decision rules.
  generation: text("generation"),
  // F0.7 claim arbitration: the token of the one ingest callback
  // currently settling this generation. Stamped by a conditional
  // UPDATE, cleared by the claim-bound settle; a new generation
  // start clears it too.
  claimedGeneration: text("claimed_generation"),
  // F0.5/F0.7 status band: when the current (or latest) refresh
  // attempt started. Distinct from updatedAt, which is only the
  // last state-write instant.
  startedAt: integer("started_at", { mode: "timestamp_ms" }),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

// F0.7 read-only refresh observability (additive, 0004): one row
// per refresh-chain event — refresh starts, spawn attachment /
// failure, and every ingest callback's arrival plus its single
// result (applied or ignored, with a short-code reason). `detail`
// only ever carries short enum codes (or a saved-month count for
// an applied success); no financial values, payload fragments,
// account data or raw error text ever land in this table. Rows are
// diagnostics only: nothing in the refresh chain reads them back.
export const refreshObservations = sqliteTable("refresh_observations", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  generation: text("generation"),
  event: text("event", {
    enum: [
      "refresh_started",
      "spawn_attached",
      "spawn_failed",
      "spawn_tail_unattached",
      "callback_received",
      "callback_applied_success",
      "callback_applied_failure",
      "callback_ignored",
    ],
  }).notNull(),
  outcome: text("outcome").notNull(),
  detail: text("detail"),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});
