import { and, eq, inArray, isNotNull, isNull, lte, or } from "drizzle-orm";
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
  lastSuccessfulCheckedAt?: Date | null;
  lastFailedAt?: Date | null;
  lastErrorCategory?: string | null;
  lastErrorMessage?: string | null;
  consecutiveFailureCount?: number;
};

type RecordMcpServerImageUpdateFailureParams = {
  mcpServerId: string;
  checkedAt: Date;
  errorCategory: string;
  errorMessage: string;
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
  ): Promise<McpServerImageUpdateState | null> {
    const now = new Date();
    const insertValues = buildInsertValues(params);
    const updateValues = buildUpdateValues(params, now);
    const shouldProtectAgainstStaleWrites =
      params.lastCheckedAt instanceof Date;

    const [state] = await db
      .insert(schema.mcpServerImageUpdateStatesTable)
      .values(insertValues)
      .onConflictDoUpdate({
        target: schema.mcpServerImageUpdateStatesTable.mcpServerId,
        set: updateValues,
        ...(shouldProtectAgainstStaleWrites
          ? {
              where: or(
                isNull(schema.mcpServerImageUpdateStatesTable.lastCheckedAt),
                lte(
                  schema.mcpServerImageUpdateStatesTable.lastCheckedAt,
                  params.lastCheckedAt as Date,
                ),
              ),
            }
          : {}),
      })
      .returning();

    return state ?? null;
  }

  static async hasRestartTriggeredForDigest(params: {
    mcpServerId: string;
    availableImageDigest: string;
  }): Promise<boolean> {
    const [state] = await db
      .select({
        mcpServerId: schema.mcpServerImageUpdateStatesTable.mcpServerId,
      })
      .from(schema.mcpServerImageUpdateStatesTable)
      .where(
        and(
          eq(
            schema.mcpServerImageUpdateStatesTable.mcpServerId,
            params.mcpServerId,
          ),
          eq(
            schema.mcpServerImageUpdateStatesTable.availableImageDigest,
            params.availableImageDigest,
          ),
          isNotNull(schema.mcpServerImageUpdateStatesTable.lastRestartedAt),
        ),
      )
      .limit(1);

    return !!state;
  }

  static async recordFailure(
    params: RecordMcpServerImageUpdateFailureParams,
  ): Promise<McpServerImageUpdateState | null> {
    const currentState = await McpServerImageUpdateStateModel.findByMcpServerId(
      params.mcpServerId,
    );

    return McpServerImageUpdateStateModel.upsertLatestState({
      mcpServerId: params.mcpServerId,
      lastCheckedAt: params.checkedAt,
      status: "check_failed",
      lastFailedAt: params.checkedAt,
      lastErrorCategory: params.errorCategory,
      lastErrorMessage: params.errorMessage,
      consecutiveFailureCount: (currentState?.consecutiveFailureCount ?? 0) + 1,
    });
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
  if ("lastSuccessfulCheckedAt" in params) {
    fields.lastSuccessfulCheckedAt = params.lastSuccessfulCheckedAt;
  }
  if ("lastFailedAt" in params) {
    fields.lastFailedAt = params.lastFailedAt;
  }
  if ("lastErrorCategory" in params) {
    fields.lastErrorCategory = params.lastErrorCategory;
  }
  if ("lastErrorMessage" in params) {
    fields.lastErrorMessage = params.lastErrorMessage;
  }
  if ("consecutiveFailureCount" in params) {
    fields.consecutiveFailureCount = params.consecutiveFailureCount;
  }

  return fields;
}
