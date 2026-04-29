import { eq, inArray } from "drizzle-orm";
import db, { schema } from "@/database";
import type {
  McpServerImageUpdateState,
  McpServerImageUpdateStatus,
} from "@/types";

type UpsertMcpServerImageUpdateStateParams = {
  mcpServerId: string;
  lastCheckedAt?: Date | null;
  runningImageDigest?: string | null;
  availableImageDigest?: string | null;
  status?: McpServerImageUpdateStatus;
  lastRestartedAt?: Date | null;
};

class McpServerImageUpdateStateModel {
  static async findByMcpServerId(
    mcpServerId: string,
  ): Promise<McpServerImageUpdateState | null> {
    const [state] = await db
      .select()
      .from(schema.mcpServerImageUpdateStatesTable)
      .where(
        eq(schema.mcpServerImageUpdateStatesTable.mcpServerId, mcpServerId),
      )
      .limit(1);

    return state ?? null;
  }

  static async findByMcpServerIds(
    mcpServerIds: string[],
  ): Promise<Map<string, McpServerImageUpdateState>> {
    if (mcpServerIds.length === 0) {
      return new Map();
    }

    const states = await db
      .select()
      .from(schema.mcpServerImageUpdateStatesTable)
      .where(
        inArray(
          schema.mcpServerImageUpdateStatesTable.mcpServerId,
          mcpServerIds,
        ),
      );

    return new Map(states.map((state) => [state.mcpServerId, state]));
  }

  static async upsertLatestState(
    params: UpsertMcpServerImageUpdateStateParams,
  ): Promise<McpServerImageUpdateState> {
    const now = new Date();
    const insertValues = buildInsertValues(params);
    const updateValues = buildUpdateValues(params, now);

    const [state] = await db
      .insert(schema.mcpServerImageUpdateStatesTable)
      .values(insertValues)
      .onConflictDoUpdate({
        target: schema.mcpServerImageUpdateStatesTable.mcpServerId,
        set: updateValues,
      })
      .returning();

    return state;
  }
}

export default McpServerImageUpdateStateModel;

function buildInsertValues(params: UpsertMcpServerImageUpdateStateParams) {
  return {
    mcpServerId: params.mcpServerId,
    ...pickDefinedLeanFields(params),
  };
}

function buildUpdateValues(
  params: UpsertMcpServerImageUpdateStateParams,
  updatedAt: Date,
) {
  return {
    ...pickDefinedLeanFields(params),
    updatedAt,
  };
}

function pickDefinedLeanFields(params: UpsertMcpServerImageUpdateStateParams) {
  const fields: Partial<
    typeof schema.mcpServerImageUpdateStatesTable.$inferInsert
  > = {};

  if ("lastCheckedAt" in params) {
    fields.lastCheckedAt = params.lastCheckedAt;
  }
  if ("runningImageDigest" in params) {
    fields.runningImageDigest = params.runningImageDigest;
  }
  if ("availableImageDigest" in params) {
    fields.availableImageDigest = params.availableImageDigest;
  }
  if ("status" in params) {
    fields.status = params.status;
  }
  if ("lastRestartedAt" in params) {
    fields.lastRestartedAt = params.lastRestartedAt;
  }

  return fields;
}
