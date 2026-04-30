import {
  type ImageUpdateRuntime,
  isDigestPinnedImage,
  McpServerRuntimeManager,
  normalizeImageDigest,
} from "@/k8s/mcp-server-runtime";
import logger from "@/logging";
import McpServerImageUpdateStateModel from "@/models/mcp-server-image-update-state";
import type {
  InternalMcpCatalog,
  McpServer,
  McpServerImageUpdateStatus,
} from "@/types";

export type EligibleMcpImageUpdateServer = {
  server: McpServer;
  catalog: Pick<InternalMcpCatalog, "id" | "localConfig">;
};

export async function processMcpServerImageUpdateCheck(params: {
  eligibleServer: EligibleMcpImageUpdateServer;
  runtime?: ImageUpdateRuntime;
  checkedAt?: Date;
}): Promise<void> {
  const {
    checkedAt = new Date(),
    eligibleServer: { server, catalog },
    runtime = McpServerRuntimeManager,
  } = params;

  const image = resolveConfiguredImage(catalog);
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
      await persistImageUpdateState({
        mcpServerId: server.id,
        checkedAt,
        runningImageDigest: pinnedDigest,
        availableImageDigest: pinnedDigest,
        status: "up_to_date",
      });
      return;
    }

    const runningImageDigest = normalizeImageDigest(
      await runtime.getRunningImageDigest(server.id),
    );
    if (!runningImageDigest) {
      logger.warn(
        { mcpServerId: server.id, catalogId: catalog.id },
        "Skipping MCP server image update state persistence because running image digest could not be resolved",
      );
      return;
    }

    const availableImageDigest = normalizeImageDigest(
      await runtime.resolveAvailableImageDigest(server.id, image),
    );
    if (!availableImageDigest) {
      logger.warn(
        { mcpServerId: server.id, catalogId: catalog.id },
        "Skipping MCP server image update state persistence because available image digest could not be resolved",
      );
      return;
    }

    const status: McpServerImageUpdateStatus =
      runningImageDigest === availableImageDigest
        ? "up_to_date"
        : "update_available";

    if (status === "update_available" && server.imageUpdateAutoRestartEnabled) {
      logger.info(
        { mcpServerId: server.id },
        "MCP server image update is available; restart will be handled by the restart step",
      );
    }

    await persistImageUpdateState({
      mcpServerId: server.id,
      checkedAt,
      runningImageDigest,
      availableImageDigest,
      status,
    });
  } catch (error) {
    logger.warn(
      { err: error, mcpServerId: server.id, catalogId: catalog.id },
      "Failed to check MCP server image update state",
    );
  }
}

function resolveConfiguredImage(
  catalog: EligibleMcpImageUpdateServer["catalog"],
): string | null {
  const image = catalog.localConfig?.dockerImage?.trim();
  return image || null;
}

async function persistImageUpdateState(params: {
  mcpServerId: string;
  checkedAt: Date;
  runningImageDigest: string | null;
  availableImageDigest: string | null;
  status: McpServerImageUpdateStatus;
}): Promise<void> {
  await McpServerImageUpdateStateModel.upsertLatestState({
    mcpServerId: params.mcpServerId,
    lastCheckedAt: params.checkedAt,
    runningImageDigest: params.runningImageDigest,
    availableImageDigest: params.availableImageDigest,
    status: params.status,
  });
}
