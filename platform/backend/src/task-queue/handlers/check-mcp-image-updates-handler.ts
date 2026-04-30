import type { ImageUpdateRuntime } from "@/k8s/mcp-server-runtime";
import logger from "@/logging";
import McpServerModel from "@/models/mcp-server";
import { processMcpServerImageUpdateCheck } from "@/services/mcp-image-update-checker";

export async function handleCheckMcpImageUpdates(
  _payload: Record<string, unknown> = {},
  options: {
    runtime?: ImageUpdateRuntime;
    checkedAt?: Date;
  } = {},
): Promise<void> {
  const eligibleServers =
    await McpServerModel.findLocalServersEligibleForImageUpdateCheck();

  logger.info(
    { eligibleServerCount: eligibleServers.length },
    "Loaded MCP servers eligible for image update checks",
  );

  for (const eligibleServer of eligibleServers) {
    await processMcpServerImageUpdateCheck({
      eligibleServer,
      runtime: options.runtime,
      checkedAt: options.checkedAt,
    });
  }
}
