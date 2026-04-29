import { beforeEach, describe, expect, test, vi } from "vitest";

const mockFindLocalServersEligibleForImageUpdateCheck = vi.hoisted(() =>
  vi.fn().mockResolvedValue([]),
);

vi.mock("@/models", () => ({
  McpServerModel: {
    findLocalServersEligibleForImageUpdateCheck:
      mockFindLocalServersEligibleForImageUpdateCheck,
  },
}));

vi.mock("@/logging", () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import logger from "@/logging";
import { handleCheckMcpImageUpdates } from "./check-mcp-image-updates-handler";

describe("handleCheckMcpImageUpdates", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("loads eligible local MCP servers and does not crash when none exist", async () => {
    mockFindLocalServersEligibleForImageUpdateCheck.mockResolvedValue([]);

    await expect(handleCheckMcpImageUpdates()).resolves.toBeUndefined();

    expect(
      mockFindLocalServersEligibleForImageUpdateCheck,
    ).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledWith(
      { eligibleServerCount: 0 },
      "Loaded MCP servers eligible for image update checks",
    );
  });

  test("logs the eligible server count", async () => {
    mockFindLocalServersEligibleForImageUpdateCheck.mockResolvedValue([
      { server: { id: "server-1" }, catalog: { id: "catalog-1" } },
      { server: { id: "server-2" }, catalog: { id: "catalog-2" } },
    ]);

    await handleCheckMcpImageUpdates();

    expect(logger.info).toHaveBeenCalledWith(
      { eligibleServerCount: 2 },
      "Loaded MCP servers eligible for image update checks",
    );
  });
});
