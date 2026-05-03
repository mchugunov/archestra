import { and, eq, lte } from "drizzle-orm";
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
    const rows = await db
      .insert(schema.mcpServerImageUpdateCheckLocksTable)
      .values({
        mcpServerId,
        checkRunId,
        lockedUntil,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: schema.mcpServerImageUpdateCheckLocksTable.mcpServerId,
        set: {
          checkRunId,
          lockedUntil,
          updatedAt: now,
        },
        setWhere: lte(
          schema.mcpServerImageUpdateCheckLocksTable.lockedUntil,
          now,
        ),
      })
      .returning({
        mcpServerId: schema.mcpServerImageUpdateCheckLocksTable.mcpServerId,
      });

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
