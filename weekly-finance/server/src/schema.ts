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
// F-ARCH-001 (0005): append-only store for the new-architecture
// total-assets figure, written solely through the controlled
// ingestArchNetWorth action. Each row carries the full stored
// payload (JSON) plus the Plaid-layer pull instant; rows are never
// updated or deleted — the current figure is the row with the
// greatest source pulledAt (ties: greatest id), selected on read.
// SAVE-1 concurrency arbitration deliberately lives in the write
// STATEMENT (a conditional INSERT ... SELECT evaluated by the
// database at commit time), not in a unique index on pulled_at:
// a unique constraint would fail to build over — or force the
// deletion of — same-version duplicate rows the pre-fix race may
// already have stored, and history must be preserved verbatim.
export const archNetWorth = sqliteTable("arch_net_worth", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  payload: text("payload").notNull(),
  pulledAt: integer("pulled_at", { mode: "timestamp_ms" }).notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

// F-ARCH-001 (0006): append-only store for the new-architecture
// daily-spend figure, written solely through the controlled
// ingestArchDailySpend action. Each row carries the full stored
// payload (JSON) plus the Plaid-layer pull instant; rows are never
// updated or deleted — the current figure is the row with the
// greatest source pulledAt (ties: greatest id), selected on read.
// SAVE-1 concurrency arbitration deliberately lives in the write
// STATEMENT (a conditional INSERT ... SELECT evaluated by the
// database at commit time), not in a unique index on pulled_at:
// a unique constraint would fail to build over — or force the
// deletion of — same-version duplicate rows the pre-fix race may
// already have stored, and history must be preserved verbatim.
export const archDailySpend = sqliteTable("arch_daily_spend", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  payload: text("payload").notNull(),
  pulledAt: integer("pulled_at", { mode: "timestamp_ms" }).notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

// F-ARCH-001 chunked daily-spend ingest (0007): staging rows for
// the chunked write protocol of ingestArchDailySpend. A batch's
// chunks land here one at a time (each independently recomputed
// and read-back verified server-side); nothing here is ever read
// by getDashboard — the batch becomes visible only when finalize
// publishes it into arch_daily_spend through the same SAVE-1 path
// as a full ingest, after which the batch's staging rows are
// deleted. A rejected chunk (recompute mismatch or same-index
// conflict) voids the whole batch: its staging rows are deleted
// and arch_daily_spend is never touched.
export const archDailySpendChunks = sqliteTable("arch_daily_spend_chunks", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  batchId: text("batch_id").notNull(),
  chunkIndex: integer("chunk_index").notNull(),
  chunkCount: integer("chunk_count").notNull(),
  pulledAt: integer("pulled_at", { mode: "timestamp_ms" }).notNull(),
  fromDate: text("from_date").notNull(),
  toDate: text("to_date").notNull(),
  payload: text("payload").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

// CAL-METRICS-001 (0008): append-only store for the daily
// INCOME figure （入账： external inflows — income rows +
// refunds, transfers and loan flows excluded), written solely
// through the controlled ingestArchDailyIncome action under
// the same chunk/finalize protocol as daily spend. Same
// selection rule on read: greatest pulledAt, ties greatest id.
export const archDailyIncome = sqliteTable("arch_daily_income", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  payload: text("payload").notNull(),
  pulledAt: integer("pulled_at", { mode: "timestamp_ms" }).notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

// CAL-METRICS-001 (0008): staging rows for the chunked income
// ingest, mirroring arch_daily_spend_chunks exactly — staged
// chunks are invisible to every read path; only finalize
// publishes into arch_daily_income.
export const archDailyIncomeChunks = sqliteTable("arch_daily_income_chunks", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  batchId: text("batch_id").notNull(),
  chunkIndex: integer("chunk_index").notNull(),
  chunkCount: integer("chunk_count").notNull(),
  pulledAt: integer("pulled_at", { mode: "timestamp_ms" }).notNull(),
  fromDate: text("from_date").notNull(),
  toDate: text("to_date").notNull(),
  payload: text("payload").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

// CAL-METRICS-001 (0008): append-only store for the DAILY
// investment gain/loss figure （投资收益·损失 = day's
// investment value change − day's net investment flow),
// written solely through ingestArchDailyInvest under the same
// SAVE-1 arbitration as arch_net_worth. Daily granularity
// exists only from 2026-10-24 (the arch daily era); earlier
// months stay monthly in the Firance archive and are never
// split into days.
export const archDailyInvest = sqliteTable("arch_daily_invest", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  payload: text("payload").notNull(),
  pulledAt: integer("pulled_at", { mode: "timestamp_ms" }).notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

// TRADING-MERGE-001 (0009): the merged 「交易日志」 dataset lives
// in its own single-row store, fully independent of finance_state
// and the arch_* tables. The dataset is one JSON document,
// replaced wholesale by saveTradingData and extended only at its
// journal tail by appendTradingJournal; getDashboard surfaces it
// as the optional `trading` field and getTradingSummary reads
// counts from it. Exactly one row (id = 1) ever exists.
export const tradingState = sqliteTable("trading_state", {
  id: integer("id").primaryKey(),
  payload: text("payload").notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

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
