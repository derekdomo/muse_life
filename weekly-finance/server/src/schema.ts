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
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});
