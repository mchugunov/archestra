import { mcpImageUpdateCheckerService } from "@/services/mcp-image-update-checker";
import type { TaskHandler } from "@/types";

export const handleCheckMcpImageUpdates: TaskHandler = (payload) =>
  mcpImageUpdateCheckerService.handleCheckMcpImageUpdates(payload);

export const handleCheckMcpImageUpdateFollowUp: TaskHandler = (payload) =>
  mcpImageUpdateCheckerService.handleCheckMcpImageUpdateFollowUp(payload);
