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
  targetImageDigest?: string | null;
  status?: McpServerImageUpdateStatus;
  lastRestartedAt?: Date | null;
  rolloutStartedAt?: Date | null;
  rolloutLastCheckedAt?: Date | null;
  rolloutAttemptCount?: number;
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

  static async hasRestartTriggeredForDigest(
    mcpServerId: string,
    availableImageDigest: string,
  ): Promise<boolean> {
    const [state] = await db
      .select({
        mcpServerId: schema.mcpServerImageUpdateStatesTable.mcpServerId,
      })
      .from(schema.mcpServerImageUpdateStatesTable)
      .where(
        and(
          eq(schema.mcpServerImageUpdateStatesTable.mcpServerId, mcpServerId),
          eq(
            schema.mcpServerImageUpdateStatesTable.availableImageDigest,
            availableImageDigest,
          ),
          eq(schema.mcpServerImageUpdateStatesTable.status, "reinstalling"),
          isNotNull(schema.mcpServerImageUpdateStatesTable.lastRestartedAt),
        ),
      )
      .limit(1);

    return !!state;
  }

  static async hasActiveRolloutForDigest(params: {
    mcpServerId: string;
    targetImageDigest: string;
    checkedAt?: Date;
    staleAfterMs?: number;
  }): Promise<boolean> {
    const [state] = await db
      .select({
        mcpServerId: schema.mcpServerImageUpdateStatesTable.mcpServerId,
        lastCheckedAt: schema.mcpServerImageUpdateStatesTable.lastCheckedAt,
        rolloutStartedAt:
          schema.mcpServerImageUpdateStatesTable.rolloutStartedAt,
        rolloutLastCheckedAt:
          schema.mcpServerImageUpdateStatesTable.rolloutLastCheckedAt,
      })
      .from(schema.mcpServerImageUpdateStatesTable)
      .where(
        and(
          eq(
            schema.mcpServerImageUpdateStatesTable.mcpServerId,
            params.mcpServerId,
          ),
          eq(
            schema.mcpServerImageUpdateStatesTable.targetImageDigest,
            params.targetImageDigest,
          ),
          eq(schema.mcpServerImageUpdateStatesTable.status, "reinstalling"),
        ),
      )
      .limit(1);

    if (
      state &&
      params.checkedAt instanceof Date &&
      typeof params.staleAfterMs === "number"
    ) {
      const lastRolloutActivityAt =
        state.rolloutLastCheckedAt ??
        state.rolloutStartedAt ??
        state.lastCheckedAt;
      return (
        !!lastRolloutActivityAt &&
        params.checkedAt.getTime() - lastRolloutActivityAt.getTime() <=
          params.staleAfterMs
      );
    }

    return !!state;
  }

  static async recordRolloutFailed(params: {
    mcpServerId: string;
    checkedAt: Date;
    runningImageDigest: string | null;
    targetImageDigest: string;
    rolloutStartedAt: Date;
    rolloutAttemptCount: number;
    errorCategory: string;
    errorMessage: string;
  }): Promise<McpServerImageUpdateState | null> {
    return McpServerImageUpdateStateModel.upsertLatestState({
      mcpServerId: params.mcpServerId,
      lastCheckedAt: params.checkedAt,
      runningImageDigest: params.runningImageDigest,
      availableImageDigest: params.targetImageDigest,
      targetImageDigest: params.targetImageDigest,
      status: "rollout_failed",
      rolloutStartedAt: params.rolloutStartedAt,
      rolloutLastCheckedAt: params.checkedAt,
      rolloutAttemptCount: params.rolloutAttemptCount,
      lastFailedAt: params.checkedAt,
      lastErrorCategory: params.errorCategory,
      lastErrorMessage: params.errorMessage,
    });
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
    ...pickDefinedFields(params),
  };
}

function buildUpdateValues(
  params: UpsertMcpServerImageUpdateStateParams,
  updatedAt: Date,
) {
  return {
    ...pickDefinedFields(params),
    updatedAt,
  };
}

function pickDefinedFields(params: UpsertMcpServerImageUpdateStateParams) {
  const fields: Partial<
    typeof schema.mcpServerImageUpdateStatesTable.$inferInsert
  > = {};

  if (params.lastCheckedAt !== undefined) {
    fields.lastCheckedAt = params.lastCheckedAt;
  }
  if (params.runningImageDigest !== undefined) {
    fields.runningImageDigest = params.runningImageDigest;
  }
  if (params.availableImageDigest !== undefined) {
    fields.availableImageDigest = params.availableImageDigest;
  }
  if (params.targetImageDigest !== undefined) {
    fields.targetImageDigest = params.targetImageDigest;
  }
  if (params.status !== undefined) {
    fields.status = params.status;
  }
  if (params.lastRestartedAt !== undefined) {
    fields.lastRestartedAt = params.lastRestartedAt;
  }
  if (params.rolloutStartedAt !== undefined) {
    fields.rolloutStartedAt = params.rolloutStartedAt;
  }
  if (params.rolloutLastCheckedAt !== undefined) {
    fields.rolloutLastCheckedAt = params.rolloutLastCheckedAt;
  }
  if (params.rolloutAttemptCount !== undefined) {
    fields.rolloutAttemptCount = params.rolloutAttemptCount;
  }
  if (params.lastSuccessfulCheckedAt !== undefined) {
    fields.lastSuccessfulCheckedAt = params.lastSuccessfulCheckedAt;
  }
  if (params.lastFailedAt !== undefined) {
    fields.lastFailedAt = params.lastFailedAt;
  }
  if (params.lastErrorCategory !== undefined) {
    fields.lastErrorCategory = params.lastErrorCategory;
  }
  if (params.lastErrorMessage !== undefined) {
    fields.lastErrorMessage = params.lastErrorMessage;
  }
  if (params.consecutiveFailureCount !== undefined) {
    fields.consecutiveFailureCount = params.consecutiveFailureCount;
  }

  return fields;
}
