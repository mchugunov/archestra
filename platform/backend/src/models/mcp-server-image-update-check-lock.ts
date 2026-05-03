import { and, eq, sql } from "drizzle-orm";
import db, { schema } from "@/database";

type TryAcquireMcpServerImageUpdateCheckLockParams = {
  mcpServerId: string;
  checkRunId: string;
  lockedUntil: Date;
  now: Date;
};

class McpServerImageUpdateCheckLockModel {
  static async tryAcquire(
    params: TryAcquireMcpServerImageUpdateCheckLockParams,
  ): Promise<boolean> {
    const { checkRunId, lockedUntil, mcpServerId, now } = params;
    const { rows } = await db.execute<{ mcpServerId: string }>(sql`
      INSERT INTO mcp_server_image_update_check_lock (
        mcp_server_id,
        check_run_id,
        locked_until,
        updated_at
      )
      VALUES (${mcpServerId}, ${checkRunId}, ${lockedUntil}, ${now})
      ON CONFLICT (mcp_server_id) DO UPDATE
      SET
        check_run_id = EXCLUDED.check_run_id,
        locked_until = EXCLUDED.locked_until,
        updated_at = EXCLUDED.updated_at
      WHERE mcp_server_image_update_check_lock.locked_until <= ${now}
      RETURNING mcp_server_id AS "mcpServerId"
    `);

    return rows.length > 0;
  }

  static async release(params: {
    mcpServerId: string;
    checkRunId: string;
  }): Promise<void> {
    await db
      .delete(schema.mcpServerImageUpdateCheckLocksTable)
      .where(
        and(
          eq(
            schema.mcpServerImageUpdateCheckLocksTable.mcpServerId,
            params.mcpServerId,
          ),
          eq(
            schema.mcpServerImageUpdateCheckLocksTable.checkRunId,
            params.checkRunId,
          ),
        ),
      );
  }
}

export default McpServerImageUpdateCheckLockModel;
