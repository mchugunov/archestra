import { pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import mcpServerTable from "./mcp-server";

const mcpServerImageUpdateCheckLockTable = pgTable(
  "mcp_server_image_update_check_lock",
  {
    mcpServerId: uuid("mcp_server_id")
      .primaryKey()
      .references(() => mcpServerTable.id, { onDelete: "cascade" }),
    checkRunId: text("check_run_id").notNull(),
    lockedUntil: timestamp("locked_until", { mode: "date" }).notNull(),
    updatedAt: timestamp("updated_at", { mode: "date" })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
);

export default mcpServerImageUpdateCheckLockTable;
