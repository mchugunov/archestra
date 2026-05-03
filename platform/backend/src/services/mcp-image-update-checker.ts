import { TimeInMs } from "@shared";
import { z } from "zod";
import {
  type ImageUpdateRuntime,
  isDigestPinnedImage,
  McpServerRuntimeManager,
  normalizeImageDigest,
} from "@/k8s/mcp-server-runtime";
import logger from "@/logging";
import McpServerModel from "@/models/mcp-server";
import McpServerImageUpdateStateModel from "@/models/mcp-server-image-update-state";
import { autoReinstallLocalMcpServerAfterImageUpdate } from "@/services/mcp-reinstall";
import { taskQueueService } from "@/task-queue";
import type { McpServer, McpServerImageUpdateStatus } from "@/types";

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
    const mcpServerId = parseMcpImageUpdateFollowUpPayload(payload);
    if (!mcpServerId) {
      logger.warn(
        { payload },
        "Skipping MCP image update follow-up task with invalid payload",
      );
      return;
    }

    await this.handleCheckMcpImageUpdates({
      mcpServerId,
      skipAutoRestart: true,
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

    const image = this.resolveConfiguredImage(catalog);
    if (!image) {
      logger.warn(
        createImageUpdateLogContext({ server, catalog }),
        "Skipping MCP server image update check because no configured image was found",
      );
      return;
    }

    try {
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

      const runningImageDigest = normalizeImageDigest(
        await this.runtime.getRunningImageDigest(server.id),
      );
      if (!runningImageDigest) {
        logger.warn(
          createImageUpdateLogContext({ server, catalog, image }),
          "Skipping MCP server image update state persistence because running image digest could not be resolved",
        );
        return;
      }

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
        logger.warn(
          createImageUpdateLogContext({ server, catalog, image }),
          "Skipping MCP server image update state persistence because available image digest could not be resolved",
        );
        return;
      }

      if (runningImageDigest !== availableImageDigest) {
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
      logger.warn(
        createImageUpdateLogContext({ server, catalog, image, error }),
        "Failed to check MCP server image update state",
      );
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
    mcpServerId: string,
    scheduledFor: Date,
  ): Promise<void> {
    await taskQueueService.enqueue({
      taskType: "check_mcp_image_update_follow_up",
      payload: {
        mcpServerId: mcpServerId,
      },
      maxAttempts: 1,
      scheduledFor: scheduledFor,
    });
  }

  // ===== Private methods =====

  private async processEligibleServer(params: {
    eligibleServer: EligibleMcpImageUpdateServer;
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
    catalog: Pick<EligibleMcpImageUpdateCatalog, "localConfig">,
  ): string | null {
    const image = catalog.localConfig?.dockerImage?.trim();
    return image || null;
  }

  private async persistChangedImageState(params: {
    server: McpServer;
    catalog: EligibleMcpImageUpdateCatalog;
    allowAutoRestart: boolean;
    checkedAt: Date;
    runningImageDigest: string;
    availableImageDigest: string;
  }): Promise<void> {
    if (
      !params.allowAutoRestart ||
      !params.server.imageUpdateAutoRestartEnabled
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

    await autoReinstallLocalMcpServerAfterImageUpdate({
      server: params.server,
      catalogItem: params.catalog,
      runningImageDigest: params.runningImageDigest,
      availableImageDigest: params.availableImageDigest,
    });
    await this.persistImageUpdateState({
      mcpServerId: params.server.id,
      checkedAt: params.checkedAt,
      runningImageDigest: params.runningImageDigest,
      availableImageDigest: params.availableImageDigest,
      status: "restart_triggered",
      lastRestartedAt: params.checkedAt,
    });
    await this.scheduleDelayedFollowUpCheck(params.server.id);
  }

  private async scheduleDelayedFollowUpCheck(
    mcpServerId: string,
  ): Promise<void> {
    const scheduledFor = new Date(
      Date.now() + IMAGE_UPDATE_FOLLOW_UP_CHECK_DELAY_MS,
    );

    try {
      await this.scheduleImageUpdateFollowUpCheck(mcpServerId, scheduledFor);
    } catch (error) {
      logger.warn(
        { err: error, mcpServerId, scheduledFor },
        "Failed to schedule MCP server image update follow-up check",
      );
    }
  }

  private async persistImageUpdateState(params: {
    mcpServerId: string;
    checkedAt: Date;
    runningImageDigest: string | null;
    availableImageDigest: string | null;
    status: McpServerImageUpdateStatus;
    lastRestartedAt?: Date | null;
  }): Promise<void> {
    const state = {
      mcpServerId: params.mcpServerId,
      lastCheckedAt: params.checkedAt,
      runningImageDigest: params.runningImageDigest,
      availableImageDigest: params.availableImageDigest,
      status: params.status,
    };

    await McpServerImageUpdateStateModel.upsertLatestState(
      params.lastRestartedAt === undefined
        ? state
        : {
            ...state,
            lastRestartedAt: params.lastRestartedAt,
          },
    );
  }
}

const DEFAULT_AVAILABLE_DIGEST_TIMEOUT_MS = TimeInMs.Second * 60;
const DEFAULT_IMAGE_UPDATE_CHECK_CONCURRENCY_LIMIT = 3;
const DEFAULT_IMAGE_UPDATE_CHECK_MAX_JITTER_MS = 2_000;
const IMAGE_UPDATE_FOLLOW_UP_CHECK_DELAY_MS = TimeInMs.Second * 10;
const MAX_IMAGE_UPDATE_CHECK_CONCURRENCY_LIMIT = 5;

export const mcpImageUpdateCheckerService = new McpImageUpdateCheckerService();

// ===== Internal helpers =====

type EligibleMcpImageUpdateServer = Awaited<
  ReturnType<typeof McpServerModel.findLocalServersEligibleForImageUpdateCheck>
>[number];
type EligibleMcpImageUpdateCatalog = EligibleMcpImageUpdateServer["catalog"];

type ProcessMcpServerImageUpdateCheckParams = {
  eligibleServer: EligibleMcpImageUpdateServer;
  allowAutoRestart?: boolean;
  checkedAt?: Date;
};

type CheckMcpImageUpdatesPayload = {
  mcpServerId?: string;
  skipAutoRestart: boolean;
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
): string | null {
  const result = z
    .object({
      mcpServerId: z.uuid(),
    })
    .safeParse(payload);
  return result.success ? result.data.mcpServerId : null;
}

function createImageUpdateLogContext(params: {
  server: McpServer;
  catalog: Pick<EligibleMcpImageUpdateCatalog, "id" | "name">;
  image?: string;
  error?: unknown;
}) {
  return {
    ...(params.error === undefined ? {} : { err: params.error }),
    mcpServerId: params.server.id,
    catalogId: params.catalog.id,
    catalogName: params.catalog.name,
    ...(params.image ? { image: params.image } : {}),
    ...(params.error === undefined ? {} : getErrorLogFields(params.error)),
  };
}

function getErrorLogFields(error: unknown): {
  errorClass: string;
  errorMessage: string;
} {
  if (error instanceof Error) {
    return {
      errorClass: error.name || error.constructor.name,
      errorMessage: error.message,
    };
  }

  return {
    errorClass: typeof error,
    errorMessage: String(error),
  };
}
