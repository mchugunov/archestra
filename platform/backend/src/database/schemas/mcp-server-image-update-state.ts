import { pgEnum, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import mcpServerTable from "./mcp-server";

export const mcpServerImageUpdateStatusEnum = pgEnum(
  "mcp_server_image_update_status",
  ["unknown", "up_to_date", "update_available", "restart_triggered"],
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
    status: mcpServerImageUpdateStatusEnum("status")
      .notNull()
      .default("unknown"),
    lastRestartedAt: timestamp("last_restarted_at", { mode: "date" }),
    updatedAt: timestamp("updated_at", { mode: "date" })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
);

export default mcpServerImageUpdateStateTable;
