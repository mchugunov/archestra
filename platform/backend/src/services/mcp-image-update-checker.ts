import { randomUUID } from "node:crypto";
import { TimeInMs } from "@shared";
import { z } from "zod";
import {
  type ImageUpdateRuntime,
  isDigestPinnedImage,
  McpServerRuntimeManager,
  normalizeImageDigest,
} from "@/k8s/mcp-server-runtime";
import logger from "@/logging";
import McpServerModel, {
  type LocalMcpServerImageUpdateCandidate,
} from "@/models/mcp-server";
import McpServerImageUpdateCheckLockModel from "@/models/mcp-server-image-update-check-lock";
import McpServerImageUpdateStateModel from "@/models/mcp-server-image-update-state";
import {
  getImageUpdateErrorLogFields,
  getImageUpdateFailure,
} from "@/services/mcp-image-update-error";
import { autoReinstallLocalMcpServerAfterImageUpdate } from "@/services/mcp-reinstall";
import { taskQueueService } from "@/task-queue";
import type {
  InternalMcpCatalog,
  McpServer,
  McpServerImageUpdateState,
  McpServerImageUpdateStatus,
} from "@/types";

export class McpImageUpdateCheckerService {
  private readonly availableDigestTimeoutMs: number;
  private readonly concurrencyLimit: number;
  private readonly maxJitterMs: number;
  private readonly runtime: ImageUpdateRuntime;

  constructor(params: McpImageUpdateCheckerServiceParams = {}) {
    this.availableDigestTimeoutMs =
      params.availableDigestTimeoutMs ?? DEFAULT_AVAILABLE_DIGEST_TIMEOUT_MS;
    this.concurrencyLimit = normalizeConcurrencyLimit(params.concurrencyLimit);
    this.maxJitterMs = normalizeMaxJitterMs(params.maxJitterMs);
    this.runtime = params.runtime ?? McpServerRuntimeManager;
  }

  async handleCheckMcpImageUpdates(
    payload: Record<string, unknown>,
  ): Promise<void> {
    const parsedPayload = parseCheckMcpImageUpdatesPayload(payload);
    if (!parsedPayload) {
      logger.warn(
        { payload },
        "Skipping MCP image update check task with invalid payload",
      );
      return;
    }

    await this.prepareImageUpdateCheck();

    const eligibleServers =
      await McpServerModel.findLocalServersEligibleForImageUpdateCheck(
        parsedPayload.mcpServerId,
      );

    logger.info(
      {
        eligibleServerCount: eligibleServers.length,
        concurrencyLimit: this.concurrencyLimit,
        maxJitterMs: this.maxJitterMs,
        mcpServerId: parsedPayload.mcpServerId,
        skipAutoRestart: parsedPayload.skipAutoRestart,
      },
      "Loaded MCP servers eligible for image update checks",
    );

    await runWithConcurrencyLimit({
      items: eligibleServers,
      concurrencyLimit: this.concurrencyLimit,
      processItem: (eligibleServer) =>
        this.processEligibleServer({
          eligibleServer,
          allowAutoRestart: !parsedPayload.skipAutoRestart,
          applyJitter: !parsedPayload.mcpServerId,
        }),
    });
  }

  async handleCheckMcpImageUpdateFollowUp(
    payload: Record<string, unknown>,
  ): Promise<void> {
    const followUpPayload = parseMcpImageUpdateFollowUpPayload(payload);
    if (!followUpPayload) {
      logger.warn(
        { payload },
        "Skipping MCP image update follow-up task with invalid payload",
      );
      return;
    }

    await this.processMcpServerImageUpdateFollowUp({
      ...followUpPayload,
      checkedAt: new Date(),
    });
  }

  async processMcpServerImageUpdateCheck(
    params: ProcessMcpServerImageUpdateCheckParams,
  ): Promise<void> {
    const {
      allowAutoRestart = true,
      checkedAt = new Date(),
      eligibleServer: { server, catalog },
    } = params;
    const checkRunId = randomUUID();
    const lockAcquiredAt = new Date();
    const lockAcquired = await McpServerImageUpdateCheckLockModel.tryAcquire({
      mcpServerId: server.id,
      checkRunId,
      now: lockAcquiredAt,
      lockedUntil: new Date(
        lockAcquiredAt.getTime() + IMAGE_UPDATE_CHECK_LOCK_TTL_MS,
      ),
    });

    if (!lockAcquired) {
      logger.info(
        createImageUpdateLogContext({ server, catalog }),
        "Skipping MCP server image update check because another check is already active",
      );
      return;
    }

    let image: string | null = null;
    let failureCategory = "check_failed";
    try {
      image = this.resolveConfiguredImage(catalog);
      if (!image) {
        await this.persistImageUpdateFailure({
          mcpServerId: server.id,
          checkedAt,
          errorCategory: "missing_configured_image",
          errorMessage: "No Docker image is configured for this MCP server.",
        });
        logger.warn(
          createImageUpdateLogContext({ server, catalog }),
          "Skipping MCP server image update check because no configured image was found",
        );
        return;
      }

      if (isDigestPinnedImage(image)) {
        const pinnedDigest = normalizeImageDigest(image);
        await this.persistImageUpdateState({
          mcpServerId: server.id,
          checkedAt,
          runningImageDigest: pinnedDigest,
          availableImageDigest: pinnedDigest,
          status: "up_to_date",
        });
        return;
      }

      failureCategory = "running_digest_error";
      const runningImageDigest = normalizeImageDigest(
        await this.runtime.getRunningImageDigest(server.id),
      );
      if (!runningImageDigest) {
        await this.persistImageUpdateFailure({
          mcpServerId: server.id,
          checkedAt,
          errorCategory: "running_digest_unavailable",
          errorMessage: "Running image digest could not be resolved.",
        });
        logger.warn(
          createImageUpdateLogContext({ server, catalog, image }),
          "Skipping MCP server image update state persistence because running image digest could not be resolved",
        );
        return;
      }

      failureCategory = "available_digest_error";
      const availableImageDigest = normalizeImageDigest(
        await this.runtime.resolveAvailableImageDigest({
          mcpServerId: server.id,
          image,
          options: {
            timeoutMs: this.availableDigestTimeoutMs,
          },
        }),
      );
      if (!availableImageDigest) {
        await this.persistImageUpdateFailure({
          mcpServerId: server.id,
          checkedAt,
          errorCategory: "available_digest_unavailable",
          errorMessage: "Available image digest could not be resolved.",
        });
        logger.warn(
          createImageUpdateLogContext({ server, catalog, image }),
          "Skipping MCP server image update state persistence because available image digest could not be resolved",
        );
        return;
      }

      if (runningImageDigest !== availableImageDigest) {
        if (allowAutoRestart && server.imageUpdateAutoRestartEnabled) {
          failureCategory = "reinstall_failed";
        }
        await this.persistChangedImageState({
          server,
          catalog,
          allowAutoRestart,
          checkedAt,
          runningImageDigest,
          availableImageDigest,
        });
        return;
      }

      await this.persistImageUpdateState({
        mcpServerId: server.id,
        checkedAt,
        runningImageDigest,
        availableImageDigest,
        status: "up_to_date",
      });
    } catch (error) {
      const failure = getImageUpdateFailure(error, failureCategory);
      await this.persistImageUpdateFailure({
        mcpServerId: server.id,
        checkedAt,
        errorCategory: failure.errorCategory,
        errorMessage: failure.errorMessage,
      });
      logger.warn(
        createImageUpdateLogContext({
          server,
          catalog,
          image: image ?? undefined,
          error,
        }),
        "Failed to check MCP server image update state",
      );
    } finally {
      await McpServerImageUpdateCheckLockModel.release(server.id, checkRunId);
    }
  }

  async processMcpServerImageUpdateFollowUp(
    params: ProcessMcpServerImageUpdateFollowUpParams,
  ): Promise<void> {
    const {
      attemptCount,
      checkedAt = new Date(),
      mcpServerId,
      rolloutStartedAt,
      targetImageDigest,
    } = params;
    const checkRunId = randomUUID();
    const lockAcquiredAt = new Date();
    const lockAcquired = await McpServerImageUpdateCheckLockModel.tryAcquire({
      mcpServerId,
      checkRunId,
      now: lockAcquiredAt,
      lockedUntil: new Date(
        lockAcquiredAt.getTime() + IMAGE_UPDATE_CHECK_LOCK_TTL_MS,
      ),
    });

    if (!lockAcquired) {
      logger.info(
        { mcpServerId, targetImageDigest, attemptCount },
        "Skipping MCP server image update rollout follow-up because another check is already active",
      );
      return;
    }

    let rolloutState: McpServerImageUpdateState | null = null;
    try {
      const state =
        await McpServerImageUpdateStateModel.findByMcpServerId(mcpServerId);
      rolloutState = state;
      if (
        !state ||
        !isExpectedRolloutState(state, { targetImageDigest, rolloutStartedAt })
      ) {
        logger.info(
          {
            mcpServerId,
            targetImageDigest,
            rolloutStartedAt,
            currentStatus: state?.status,
            currentTargetImageDigest: state?.targetImageDigest,
            currentRolloutStartedAt: state?.rolloutStartedAt,
          },
          "Skipping MCP server image update rollout follow-up because it was superseded",
        );
        return;
      }

      const runningImageDigest = normalizeImageDigest(
        await this.runtime.getRunningImageDigest(mcpServerId),
      );
      await this.persistRolloutVerificationResult({
        attemptCount,
        checkedAt,
        runningImageDigest,
        state,
        targetImageDigest,
      });
    } catch (error) {
      await this.handleRolloutVerificationError({
        attemptCount,
        checkedAt,
        error,
        mcpServerId,
        rolloutState,
        rolloutStartedAt,
        targetImageDigest,
      });
    } finally {
      await McpServerImageUpdateCheckLockModel.release(mcpServerId, checkRunId);
    }
  }

  // ===== Protected methods (test exposed) =====

  protected getJitterMs(maxJitterMs: number): number {
    if (maxJitterMs <= 0) {
      return 0;
    }

    return Math.floor(Math.random() * (maxJitterMs + 1));
  }

  protected sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  protected async scheduleImageUpdateFollowUpCheck(
    params: ScheduleImageUpdateFollowUpCheckParams,
  ): Promise<void> {
    await taskQueueService.enqueue({
      taskType: "check_mcp_image_update_follow_up",
      payload: {
        attemptCount: params.attemptCount,
        mcpServerId: params.mcpServerId,
        rolloutStartedAt: params.rolloutStartedAt.toISOString(),
        targetImageDigest: params.targetImageDigest,
      },
      maxAttempts: 1,
      scheduledFor: params.scheduledFor,
    });
  }

  // ===== Private methods =====

  private async prepareImageUpdateCheck(): Promise<void> {
    try {
      await this.runtime.prepareImageUpdateCheck();
    } catch (error) {
      logger.warn({ err: error }, "Failed to prepare MCP image update check");
    }
  }

  private async processEligibleServer(params: {
    eligibleServer: LocalMcpServerImageUpdateCandidate;
    allowAutoRestart: boolean;
    applyJitter: boolean;
  }): Promise<void> {
    const { allowAutoRestart, applyJitter, eligibleServer } = params;
    try {
      if (applyJitter && this.maxJitterMs > 0) {
        await this.sleep(this.getJitterMs(this.maxJitterMs));
      }

      await this.processMcpServerImageUpdateCheck({
        allowAutoRestart,
        eligibleServer,
      });
    } catch (error) {
      logger.warn(
        createImageUpdateLogContext({
          server: eligibleServer.server,
          catalog: eligibleServer.catalog,
          image: eligibleServer.catalog.localConfig?.dockerImage,
          error,
        }),
        "Unexpected failure while processing MCP server image update check",
      );
    }
  }

  private resolveConfiguredImage(
    catalog: Pick<InternalMcpCatalog, "localConfig">,
  ): string | null {
    const image = catalog.localConfig?.dockerImage?.trim();
    return image || null;
  }

  private async persistChangedImageState(params: {
    server: McpServer;
    catalog: InternalMcpCatalog;
    allowAutoRestart: boolean;
    checkedAt: Date;
    runningImageDigest: string;
    availableImageDigest: string;
  }): Promise<void> {
    const currentServer = await McpServerModel.findById(params.server.id);
    if (!currentServer) {
      logger.warn(
        createImageUpdateLogContext({
          server: params.server,
          catalog: params.catalog,
        }),
        "Skipping MCP server automatic image reinstall because the server no longer exists",
      );
      return;
    }

    const currentImageUpdateState =
      await McpServerImageUpdateStateModel.findByMcpServerId(params.server.id);
    if (
      isRolloutForDigest(currentImageUpdateState, params.availableImageDigest)
    ) {
      if (
        isStaleImageUpdateRollout(currentImageUpdateState, params.checkedAt)
      ) {
        await this.recordStaleActiveRolloutFailure({
          state: currentImageUpdateState,
          checkedAt: params.checkedAt,
          runningImageDigest: params.runningImageDigest,
          targetImageDigest: params.availableImageDigest,
          server: currentServer,
          catalog: params.catalog,
        });
        return;
      }

      logger.info(
        createImageUpdateLogContext({
          server: currentServer,
          catalog: params.catalog,
        }),
        "Skipping MCP server image update state change because an automatic reinstall is already in progress",
      );
      return;
    }

    if (
      !params.allowAutoRestart ||
      !currentServer.imageUpdateAutoRestartEnabled
    ) {
      await this.persistImageUpdateState({
        mcpServerId: params.server.id,
        checkedAt: params.checkedAt,
        runningImageDigest: params.runningImageDigest,
        availableImageDigest: params.availableImageDigest,
        status: "update_available",
      });
      return;
    }

    if (currentServer.reinstallRequired) {
      logger.info(
        createImageUpdateLogContext({
          server: currentServer,
          catalog: params.catalog,
        }),
        "Skipping MCP server automatic image reinstall because manual reinstall is required",
      );
      return;
    }

    const activeRollout =
      await McpServerImageUpdateStateModel.hasActiveRolloutForDigest({
        mcpServerId: params.server.id,
        targetImageDigest: params.availableImageDigest,
        checkedAt: params.checkedAt,
        staleAfterMs: IMAGE_UPDATE_ROLLOUT_STALE_AFTER_MS,
      });
    if (activeRollout) {
      logger.info(
        createImageUpdateLogContext({
          server: currentServer,
          catalog: params.catalog,
        }),
        "Skipping MCP server automatic image reinstall because it is already in progress for this digest",
      );
      return;
    }

    const restartAlreadyTriggered =
      await McpServerImageUpdateStateModel.hasRestartTriggeredForDigest(
        params.server.id,
        params.availableImageDigest,
      );
    if (restartAlreadyTriggered) {
      logger.info(
        createImageUpdateLogContext({
          server: currentServer,
          catalog: params.catalog,
        }),
        "Skipping MCP server automatic image reinstall because it was already triggered for this digest",
      );
      return;
    }

    const statePersisted = await this.persistImageUpdateState({
      mcpServerId: params.server.id,
      checkedAt: params.checkedAt,
      runningImageDigest: params.runningImageDigest,
      availableImageDigest: params.availableImageDigest,
      targetImageDigest: params.availableImageDigest,
      status: "reinstalling",
      rolloutStartedAt: params.checkedAt,
      rolloutLastCheckedAt: params.checkedAt,
      rolloutAttemptCount: 0,
    });
    if (!statePersisted) {
      return;
    }

    await autoReinstallLocalMcpServerAfterImageUpdate({
      server: currentServer,
      catalogItem: params.catalog,
      runningImageDigest: params.runningImageDigest,
      availableImageDigest: params.availableImageDigest,
    });
    await this.persistImageUpdateState({
      mcpServerId: params.server.id,
      checkedAt: params.checkedAt,
      runningImageDigest: params.runningImageDigest,
      availableImageDigest: params.availableImageDigest,
      targetImageDigest: params.availableImageDigest,
      status: "reinstalling",
      lastRestartedAt: params.checkedAt,
      rolloutStartedAt: params.checkedAt,
      rolloutLastCheckedAt: params.checkedAt,
      rolloutAttemptCount: 0,
      lastSuccessfulCheckedAt: null,
    });
    await this.scheduleDelayedFollowUpCheck({
      attemptCount: 1,
      mcpServerId: params.server.id,
      rolloutStartedAt: params.checkedAt,
      targetImageDigest: params.availableImageDigest,
    });
  }

  private async recordStaleActiveRolloutFailure(params: {
    state: McpServerImageUpdateState;
    checkedAt: Date;
    runningImageDigest: string | null;
    targetImageDigest: string;
    server: McpServer;
    catalog: InternalMcpCatalog;
  }): Promise<void> {
    await McpServerImageUpdateStateModel.recordRolloutFailed({
      mcpServerId: params.state.mcpServerId,
      checkedAt: params.checkedAt,
      runningImageDigest: params.runningImageDigest,
      targetImageDigest: params.targetImageDigest,
      rolloutStartedAt: params.state.rolloutStartedAt ?? params.checkedAt,
      rolloutAttemptCount: params.state.rolloutAttemptCount ?? 0,
      errorCategory: "rollout_stale",
      errorMessage:
        "Image update rollout follow-up did not complete before the recovery window.",
    });
    logger.warn(
      {
        ...createImageUpdateLogContext({
          server: params.server,
          catalog: params.catalog,
        }),
        rolloutStartedAt: params.state.rolloutStartedAt,
        rolloutLastCheckedAt: params.state.rolloutLastCheckedAt,
        rolloutAttemptCount: params.state.rolloutAttemptCount,
        targetImageDigest: params.targetImageDigest,
      },
      "Marked stale MCP server image update rollout as failed",
    );
  }

  private async scheduleDelayedFollowUpCheck(
    params: Omit<ScheduleImageUpdateFollowUpCheckParams, "scheduledFor">,
  ): Promise<void> {
    const scheduledFor = new Date(
      Date.now() + getRolloutFollowUpDelayMs(params.attemptCount),
    );

    try {
      await this.scheduleImageUpdateFollowUpCheck({
        ...params,
        scheduledFor,
      });
    } catch (error) {
      logger.warn(
        {
          err: error,
          attemptCount: params.attemptCount,
          mcpServerId: params.mcpServerId,
          scheduledFor,
          targetImageDigest: params.targetImageDigest,
        },
        "Failed to schedule MCP server image update follow-up check",
      );
    }
  }

  private async persistRolloutVerificationResult(params: {
    attemptCount: number;
    checkedAt: Date;
    runningImageDigest: string | null;
    state: NonNullable<McpServerImageUpdateState>;
    targetImageDigest: string;
  }): Promise<void> {
    if (params.runningImageDigest === params.targetImageDigest) {
      await this.persistImageUpdateState({
        mcpServerId: params.state.mcpServerId,
        checkedAt: params.checkedAt,
        runningImageDigest: params.runningImageDigest,
        availableImageDigest: params.targetImageDigest,
        targetImageDigest: params.targetImageDigest,
        status: "up_to_date",
        lastRestartedAt: params.state.lastRestartedAt,
        rolloutStartedAt: params.state.rolloutStartedAt,
        rolloutLastCheckedAt: params.checkedAt,
        rolloutAttemptCount: params.attemptCount,
      });
      logger.info(
        {
          attemptCount: params.attemptCount,
          mcpServerId: params.state.mcpServerId,
          targetImageDigest: params.targetImageDigest,
        },
        "MCP server image update rollout reached target digest",
      );
      return;
    }

    if (params.attemptCount >= MAX_IMAGE_UPDATE_ROLLOUT_FOLLOW_UP_ATTEMPTS) {
      await McpServerImageUpdateStateModel.recordRolloutFailed({
        mcpServerId: params.state.mcpServerId,
        checkedAt: params.checkedAt,
        runningImageDigest: params.runningImageDigest,
        targetImageDigest: params.targetImageDigest,
        rolloutStartedAt: params.state.rolloutStartedAt ?? params.checkedAt,
        rolloutAttemptCount: params.attemptCount,
        errorCategory: "rollout_timeout",
        errorMessage: "Image update rollout did not reach the target digest.",
      });
      logger.warn(
        {
          attemptCount: params.attemptCount,
          mcpServerId: params.state.mcpServerId,
          runningImageDigest: params.runningImageDigest,
          targetImageDigest: params.targetImageDigest,
        },
        "MCP server image update rollout failed to reach target digest",
      );
      return;
    }

    await this.persistImageUpdateState({
      mcpServerId: params.state.mcpServerId,
      checkedAt: params.checkedAt,
      runningImageDigest: params.runningImageDigest,
      availableImageDigest: params.targetImageDigest,
      targetImageDigest: params.targetImageDigest,
      status: "reinstalling",
      lastRestartedAt: params.state.lastRestartedAt,
      rolloutStartedAt: params.state.rolloutStartedAt,
      rolloutLastCheckedAt: params.checkedAt,
      rolloutAttemptCount: params.attemptCount,
      lastSuccessfulCheckedAt: params.state.lastSuccessfulCheckedAt,
    });
    logger.info(
      {
        attemptCount: params.attemptCount,
        mcpServerId: params.state.mcpServerId,
        runningImageDigest: params.runningImageDigest,
        targetImageDigest: params.targetImageDigest,
      },
      "MCP server image update rollout is still pending",
    );
    await this.scheduleDelayedFollowUpCheck({
      attemptCount: params.attemptCount + 1,
      mcpServerId: params.state.mcpServerId,
      rolloutStartedAt: params.state.rolloutStartedAt ?? params.checkedAt,
      targetImageDigest: params.targetImageDigest,
    });
  }

  private async handleRolloutVerificationError(params: {
    attemptCount: number;
    checkedAt: Date;
    error: unknown;
    mcpServerId: string;
    rolloutState: McpServerImageUpdateState | null;
    rolloutStartedAt: Date;
    targetImageDigest: string;
  }): Promise<void> {
    const failure = getImageUpdateFailure(
      params.error,
      "rollout_verification_error",
    );
    if (params.attemptCount >= MAX_IMAGE_UPDATE_ROLLOUT_FOLLOW_UP_ATTEMPTS) {
      await McpServerImageUpdateStateModel.recordRolloutFailed({
        mcpServerId: params.mcpServerId,
        checkedAt: params.checkedAt,
        runningImageDigest: null,
        targetImageDigest: params.targetImageDigest,
        rolloutStartedAt: params.rolloutStartedAt,
        rolloutAttemptCount: params.attemptCount,
        errorCategory: failure.errorCategory,
        errorMessage: failure.errorMessage,
      });
      logger.warn(
        {
          ...getImageUpdateErrorLogFields(params.error),
          attemptCount: params.attemptCount,
          mcpServerId: params.mcpServerId,
          targetImageDigest: params.targetImageDigest,
        },
        "MCP server image update rollout verification failed",
      );
      return;
    }

    logger.warn(
      {
        ...getImageUpdateErrorLogFields(params.error),
        attemptCount: params.attemptCount,
        mcpServerId: params.mcpServerId,
        targetImageDigest: params.targetImageDigest,
      },
      "MCP server image update rollout verification failed; scheduling retry",
    );
    await this.persistImageUpdateState({
      mcpServerId: params.mcpServerId,
      checkedAt: params.checkedAt,
      runningImageDigest: null,
      availableImageDigest: params.targetImageDigest,
      targetImageDigest: params.targetImageDigest,
      status: "reinstalling",
      rolloutStartedAt: params.rolloutStartedAt,
      rolloutLastCheckedAt: params.checkedAt,
      rolloutAttemptCount: params.attemptCount,
      lastSuccessfulCheckedAt:
        params.rolloutState?.lastSuccessfulCheckedAt ?? null,
    });
    await this.scheduleDelayedFollowUpCheck({
      attemptCount: params.attemptCount + 1,
      mcpServerId: params.mcpServerId,
      rolloutStartedAt: params.rolloutStartedAt,
      targetImageDigest: params.targetImageDigest,
    });
  }

  private async persistImageUpdateState(params: {
    mcpServerId: string;
    checkedAt: Date;
    runningImageDigest: string | null;
    availableImageDigest: string | null;
    targetImageDigest?: string | null;
    status: McpServerImageUpdateStatus;
    lastRestartedAt?: Date | null;
    rolloutStartedAt?: Date | null;
    rolloutLastCheckedAt?: Date | null;
    rolloutAttemptCount?: number;
    lastSuccessfulCheckedAt?: Date | null;
  }): Promise<boolean> {
    const state = {
      mcpServerId: params.mcpServerId,
      lastCheckedAt: params.checkedAt,
      runningImageDigest: params.runningImageDigest,
      availableImageDigest: params.availableImageDigest,
      targetImageDigest: params.targetImageDigest,
      status: params.status,
      lastSuccessfulCheckedAt:
        params.lastSuccessfulCheckedAt === undefined
          ? params.checkedAt
          : params.lastSuccessfulCheckedAt,
      lastFailedAt: null,
      lastErrorCategory: null,
      lastErrorMessage: null,
      consecutiveFailureCount: 0,
      rolloutStartedAt: params.rolloutStartedAt,
      rolloutLastCheckedAt: params.rolloutLastCheckedAt,
      rolloutAttemptCount: params.rolloutAttemptCount,
    };

    const persistedState =
      await McpServerImageUpdateStateModel.upsertLatestState(
        params.lastRestartedAt === undefined
          ? state
          : {
              ...state,
              lastRestartedAt: params.lastRestartedAt,
            },
      );

    if (!persistedState) {
      logger.info(
        {
          mcpServerId: params.mcpServerId,
          checkedAt: params.checkedAt,
          status: params.status,
        },
        "Skipping stale MCP server image update state write",
      );
      return false;
    }

    return true;
  }

  private async persistImageUpdateFailure(params: {
    mcpServerId: string;
    checkedAt: Date;
    errorCategory: string;
    errorMessage: string;
  }): Promise<boolean> {
    const persistedState =
      await McpServerImageUpdateStateModel.recordFailure(params);

    if (!persistedState) {
      logger.info(
        {
          mcpServerId: params.mcpServerId,
          checkedAt: params.checkedAt,
          errorCategory: params.errorCategory,
        },
        "Skipping stale MCP server image update failure state write",
      );
      return false;
    }

    return true;
  }
}

const DEFAULT_AVAILABLE_DIGEST_TIMEOUT_MS = TimeInMs.Second * 60;
const DEFAULT_IMAGE_UPDATE_CHECK_CONCURRENCY_LIMIT = 3;
const DEFAULT_IMAGE_UPDATE_CHECK_MAX_JITTER_MS = 2_000;
const IMAGE_UPDATE_CHECK_LOCK_TTL_MS = TimeInMs.Minute * 10;
const IMAGE_UPDATE_ROLLOUT_FOLLOW_UP_INITIAL_DELAY_MS = TimeInMs.Second * 10;
const IMAGE_UPDATE_ROLLOUT_FOLLOW_UP_MAX_DELAY_MS = TimeInMs.Minute;
const MAX_IMAGE_UPDATE_CHECK_CONCURRENCY_LIMIT = 5;
const MAX_IMAGE_UPDATE_ROLLOUT_FOLLOW_UP_ATTEMPTS = 6;
const IMAGE_UPDATE_ROLLOUT_STALE_AFTER_MS =
  IMAGE_UPDATE_CHECK_LOCK_TTL_MS + getMaxRolloutFollowUpDelayMs();

export const mcpImageUpdateCheckerService = new McpImageUpdateCheckerService();

// ===== Internal helpers =====

type ProcessMcpServerImageUpdateCheckParams = {
  eligibleServer: LocalMcpServerImageUpdateCandidate;
  allowAutoRestart?: boolean;
  checkedAt?: Date;
};

type ProcessMcpServerImageUpdateFollowUpParams = {
  mcpServerId: string;
  targetImageDigest: string;
  rolloutStartedAt: Date;
  attemptCount: number;
  checkedAt?: Date;
};

type ScheduleImageUpdateFollowUpCheckParams = {
  mcpServerId: string;
  targetImageDigest: string;
  rolloutStartedAt: Date;
  attemptCount: number;
  scheduledFor: Date;
};

type CheckMcpImageUpdatesPayload = {
  mcpServerId?: string;
  skipAutoRestart: boolean;
};

type McpImageUpdateFollowUpPayload = {
  mcpServerId: string;
  targetImageDigest: string;
  rolloutStartedAt: Date;
  attemptCount: number;
};

type McpImageUpdateCheckerServiceParams = {
  runtime?: ImageUpdateRuntime;
  availableDigestTimeoutMs?: number;
  concurrencyLimit?: number;
  maxJitterMs?: number;
};

async function runWithConcurrencyLimit<T>(params: {
  items: T[];
  concurrencyLimit: number;
  processItem: (item: T) => Promise<void>;
}): Promise<void> {
  const { items, concurrencyLimit, processItem } = params;
  let nextIndex = 0;
  const workerCount = Math.min(concurrencyLimit, items.length);
  const workers = Array.from({ length: workerCount }, async () => {
    while (true) {
      const itemIndex = nextIndex;
      if (itemIndex >= items.length) {
        return;
      }

      nextIndex = itemIndex + 1;
      await processItem(items[itemIndex] as T);
    }
  });

  await Promise.all(workers);
}

function normalizeConcurrencyLimit(input: number | undefined): number {
  if (typeof input !== "number" || !Number.isInteger(input)) {
    return DEFAULT_IMAGE_UPDATE_CHECK_CONCURRENCY_LIMIT;
  }

  return Math.min(Math.max(input, 1), MAX_IMAGE_UPDATE_CHECK_CONCURRENCY_LIMIT);
}

function normalizeMaxJitterMs(input: number | undefined): number {
  if (typeof input !== "number" || !Number.isFinite(input)) {
    return DEFAULT_IMAGE_UPDATE_CHECK_MAX_JITTER_MS;
  }

  return Math.max(Math.floor(input), 0);
}

function parseCheckMcpImageUpdatesPayload(
  payload: Record<string, unknown>,
): CheckMcpImageUpdatesPayload | null {
  if (
    "mcpServerId" in payload &&
    payload.mcpServerId !== undefined &&
    typeof payload.mcpServerId !== "string"
  ) {
    return null;
  }

  return {
    mcpServerId:
      typeof payload.mcpServerId === "string" ? payload.mcpServerId : undefined,
    skipAutoRestart: payload.skipAutoRestart === true,
  };
}

function parseMcpImageUpdateFollowUpPayload(
  payload: Record<string, unknown>,
): McpImageUpdateFollowUpPayload | null {
  const result = z
    .object({
      attemptCount: z
        .number()
        .int()
        .min(1)
        .max(MAX_IMAGE_UPDATE_ROLLOUT_FOLLOW_UP_ATTEMPTS),
      mcpServerId: z.uuid(),
      rolloutStartedAt: z.coerce.date(),
      targetImageDigest: z.string().min(1),
    })
    .safeParse(payload);
  return result.success ? result.data : null;
}

function isExpectedRolloutState(
  state: McpServerImageUpdateState,
  params: {
    targetImageDigest: string;
    rolloutStartedAt: Date;
  },
): boolean {
  return (
    state.status === "reinstalling" &&
    state.targetImageDigest === params.targetImageDigest &&
    state.rolloutStartedAt?.getTime() === params.rolloutStartedAt.getTime()
  );
}

function isRolloutForDigest(
  state: McpServerImageUpdateState | null,
  targetImageDigest: string,
): state is McpServerImageUpdateState {
  return (
    state?.status === "reinstalling" &&
    state.targetImageDigest === targetImageDigest
  );
}

function isStaleImageUpdateRollout(
  state: McpServerImageUpdateState,
  checkedAt: Date,
): boolean {
  const lastRolloutActivityAt =
    state.rolloutLastCheckedAt ?? state.rolloutStartedAt ?? state.lastCheckedAt;
  if (!lastRolloutActivityAt) {
    return true;
  }

  return (
    checkedAt.getTime() - lastRolloutActivityAt.getTime() >
    IMAGE_UPDATE_ROLLOUT_STALE_AFTER_MS
  );
}

function getRolloutFollowUpDelayMs(attemptCount: number): number {
  const exponent = Math.max(attemptCount - 1, 0);
  return Math.min(
    IMAGE_UPDATE_ROLLOUT_FOLLOW_UP_INITIAL_DELAY_MS * 2 ** exponent,
    IMAGE_UPDATE_ROLLOUT_FOLLOW_UP_MAX_DELAY_MS,
  );
}

function getMaxRolloutFollowUpDelayMs(): number {
  let totalDelayMs = 0;
  for (
    let attemptCount = 1;
    attemptCount <= MAX_IMAGE_UPDATE_ROLLOUT_FOLLOW_UP_ATTEMPTS;
    attemptCount += 1
  ) {
    totalDelayMs += getRolloutFollowUpDelayMs(attemptCount);
  }

  return totalDelayMs;
}

function createImageUpdateLogContext(params: {
  server: McpServer;
  catalog: Pick<InternalMcpCatalog, "id" | "name">;
  image?: string;
  error?: unknown;
}) {
  const errorFields =
    params.error === undefined
      ? {}
      : getImageUpdateErrorLogFields(params.error);

  return {
    mcpServerId: params.server.id,
    catalogId: params.catalog.id,
    catalogName: params.catalog.name,
    ...(params.image ? { image: params.image } : {}),
    ...errorFields,
  };
}
