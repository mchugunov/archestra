import {
  type ImageUpdateRuntime,
  isDigestPinnedImage,
  McpServerRuntimeManager,
  normalizeImageDigest,
} from "@/k8s/mcp-server-runtime";
import logger from "@/logging";
import McpServerModel from "@/models/mcp-server";
import McpServerImageUpdateStateModel from "@/models/mcp-server-image-update-state";
import type {
  InternalMcpCatalog,
  McpServer,
  McpServerImageUpdateStatus,
} from "@/types";

type EligibleMcpImageUpdateServer = {
  server: McpServer;
  catalog: Pick<InternalMcpCatalog, "id" | "localConfig">;
};

type ProcessMcpServerImageUpdateCheckParams = {
  eligibleServer: EligibleMcpImageUpdateServer;
  checkedAt?: Date;
};

export class McpImageUpdateCheckerService {
  private readonly runtime: ImageUpdateRuntime;

  constructor(params: { runtime?: ImageUpdateRuntime } = {}) {
    this.runtime = params.runtime ?? McpServerRuntimeManager;
  }

  async handleCheckMcpImageUpdates(
    _payload: Record<string, unknown>,
  ): Promise<void> {
    const eligibleServers =
      await McpServerModel.findLocalServersEligibleForImageUpdateCheck();

    logger.info(
      { eligibleServerCount: eligibleServers.length },
      "Loaded MCP servers eligible for image update checks",
    );

    for (const eligibleServer of eligibleServers) {
      await this.processMcpServerImageUpdateCheck({ eligibleServer });
    }
  }

  async processMcpServerImageUpdateCheck(
    params: ProcessMcpServerImageUpdateCheckParams,
  ): Promise<void> {
    const {
      checkedAt = new Date(),
      eligibleServer: { server, catalog },
    } = params;

    const image = this.resolveConfiguredImage(catalog);
    if (!image) {
      logger.warn(
        { mcpServerId: server.id, catalogId: catalog.id },
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
          { mcpServerId: server.id, catalogId: catalog.id },
          "Skipping MCP server image update state persistence because running image digest could not be resolved",
        );
        return;
      }

      const availableImageDigest = normalizeImageDigest(
        await this.runtime.resolveAvailableImageDigest(server.id, image),
      );
      if (!availableImageDigest) {
        logger.warn(
          { mcpServerId: server.id, catalogId: catalog.id },
          "Skipping MCP server image update state persistence because available image digest could not be resolved",
        );
        return;
      }

      if (runningImageDigest !== availableImageDigest) {
        await this.persistChangedImageState({
          server,
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
        { err: error, mcpServerId: server.id, catalogId: catalog.id },
        "Failed to check MCP server image update state",
      );
    }
  }

  // ===== Private methods =====

  private resolveConfiguredImage(
    catalog: EligibleMcpImageUpdateServer["catalog"],
  ): string | null {
    const image = catalog.localConfig?.dockerImage?.trim();
    return image || null;
  }

  private async persistChangedImageState(params: {
    server: McpServer;
    checkedAt: Date;
    runningImageDigest: string;
    availableImageDigest: string;
  }): Promise<void> {
    if (!params.server.imageUpdateAutoRestartEnabled) {
      await this.persistImageUpdateState({
        mcpServerId: params.server.id,
        checkedAt: params.checkedAt,
        runningImageDigest: params.runningImageDigest,
        availableImageDigest: params.availableImageDigest,
        status: "update_available",
      });
      return;
    }

    await this.runtime.rolloutRestartServer(params.server.id);
    await this.persistImageUpdateState({
      mcpServerId: params.server.id,
      checkedAt: params.checkedAt,
      runningImageDigest: params.runningImageDigest,
      availableImageDigest: params.availableImageDigest,
      status: "restart_triggered",
      lastRestartedAt: params.checkedAt,
    });
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

export const mcpImageUpdateCheckerService = new McpImageUpdateCheckerService();
