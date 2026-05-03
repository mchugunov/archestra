import {
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import mcpServerTable from "./mcp-server";

export const mcpServerImageUpdateStatusEnum = pgEnum(
  "mcp_server_image_update_status",
  [
    "unknown",
    "up_to_date",
    "update_available",
    "reinstalling",
    "restart_triggered",
    "rollout_failed",
    "check_failed",
  ],
);

const mcpServerImageUpdateStateTable = pgTable(
  "mcp_server_image_update_state",
  {
    mcpServerId: uuid("mcp_server_id")
      .primaryKey()
      .references(() => mcpServerTable.id, { onDelete: "cascade" }),
    lastCheckedAt: timestamp("last_checked_at", { mode: "date" }),
    runningImageDigest: text("running_image_digest"),
    availableImageDigest: text("available_image_digest"),
    targetImageDigest: text("target_image_digest"),
    status: mcpServerImageUpdateStatusEnum("status")
      .notNull()
      .default("unknown"),
    lastRestartedAt: timestamp("last_restarted_at", { mode: "date" }),
    rolloutStartedAt: timestamp("rollout_started_at", { mode: "date" }),
    rolloutLastCheckedAt: timestamp("rollout_last_checked_at", {
      mode: "date",
    }),
    rolloutAttemptCount: integer("rollout_attempt_count").notNull().default(0),
    lastSuccessfulCheckedAt: timestamp("last_successful_checked_at", {
      mode: "date",
    }),
    lastFailedAt: timestamp("last_failed_at", { mode: "date" }),
    lastErrorCategory: text("last_error_category"),
    lastErrorMessage: text("last_error_message"),
    consecutiveFailureCount: integer("consecutive_failure_count")
      .notNull()
      .default(0),
    updatedAt: timestamp("updated_at", { mode: "date" })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
);

export default mcpServerImageUpdateStateTable;
