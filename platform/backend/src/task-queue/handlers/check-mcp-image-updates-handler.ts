import logger from "@/logging";
import { McpServerModel } from "@/models";

export async function handleCheckMcpImageUpdates(): Promise<void> {
  const eligibleServers =
    await McpServerModel.findLocalServersEligibleForImageUpdateCheck();

  logger.info(
    { eligibleServerCount: eligibleServers.length },
    "Loaded MCP servers eligible for image update checks",
  );
}
