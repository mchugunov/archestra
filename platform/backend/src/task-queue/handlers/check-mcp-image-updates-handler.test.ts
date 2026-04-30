import { vi } from "vitest";
import type { ImageUpdateRuntime } from "@/k8s/mcp-server-runtime";
import McpServerImageUpdateStateModel from "@/models/mcp-server-image-update-state";
import { McpImageUpdateCheckerService } from "@/services/mcp-image-update-checker";
import { describe, expect, test } from "@/test";
import type { TaskHandler } from "@/types";
import { handleCheckMcpImageUpdates } from "./check-mcp-image-updates-handler";

describe("handleCheckMcpImageUpdates", () => {
  test("is compatible with the task queue handler contract", async () => {
    const taskHandler: TaskHandler = handleCheckMcpImageUpdates;

    await expect(taskHandler({})).resolves.toBeUndefined();
  });

  test("loads eligible local MCP servers and does not crash when none exist", async () => {
    const runtime = createRuntime();
    const service = new McpImageUpdateCheckerService({ runtime });

    await expect(
      service.handleCheckMcpImageUpdates({}),
    ).resolves.toBeUndefined();

    expect(runtime.getRunningImageDigest).not.toHaveBeenCalled();
    expect(runtime.resolveAvailableImageDigest).not.toHaveBeenCalled();
    expect(runtime.rolloutRestartServer).not.toHaveBeenCalled();
  });

  test("processes eligible local MCP servers through the image update checker", async ({
    makeInternalMcpCatalog,
    makeMcpServer,
  }) => {
    const eligibleCatalog = await makeInternalMcpCatalog({
      serverType: "local",
      localConfig: {
        dockerImage: "registry.example.com/mcp/eligible:stable",
      },
    });
    const disabledCatalog = await makeInternalMcpCatalog({
      serverType: "local",
      localConfig: {
        dockerImage: "registry.example.com/mcp/disabled:stable",
      },
    });

    const eligibleServer = await makeMcpServer({
      catalogId: eligibleCatalog.id,
      serverType: "local",
      imageUpdateCheckEnabled: true,
    });
    const disabledServer = await makeMcpServer({
      catalogId: disabledCatalog.id,
      serverType: "local",
      imageUpdateCheckEnabled: false,
    });
    const runtime = createRuntime({
      runningDigest: "sha256:same",
      availableDigest: "sha256:same",
    });
    const service = new McpImageUpdateCheckerService({ runtime });

    await service.handleCheckMcpImageUpdates({});

    const eligibleState =
      await McpServerImageUpdateStateModel.findByMcpServerId(eligibleServer.id);
    const disabledState =
      await McpServerImageUpdateStateModel.findByMcpServerId(disabledServer.id);

    expect(runtime.getRunningImageDigest).toHaveBeenCalledTimes(1);
    expect(runtime.getRunningImageDigest).toHaveBeenCalledWith(
      eligibleServer.id,
    );
    expect(runtime.resolveAvailableImageDigest).toHaveBeenCalledWith(
      eligibleServer.id,
      "registry.example.com/mcp/eligible:stable",
    );
    expect(runtime.rolloutRestartServer).not.toHaveBeenCalled();
    expect(eligibleState).toMatchObject({
      mcpServerId: eligibleServer.id,
      status: "up_to_date",
    });
    expect(eligibleState?.lastCheckedAt).toBeInstanceOf(Date);
    expect(disabledState).toBeNull();
  });
});

function createRuntime(
  options: {
    runningDigest?: string | null;
    availableDigest?: string | null;
  } = {},
) {
  const runtime = {
    getRunningImageDigest:
      vi.fn<(mcpServerId: string) => Promise<string | null>>(),
    resolveAvailableImageDigest:
      vi.fn<(mcpServerId: string, image: string) => Promise<string | null>>(),
    rolloutRestartServer: vi.fn<(mcpServerId: string) => Promise<void>>(),
  } satisfies ImageUpdateRuntime;

  runtime.getRunningImageDigest.mockResolvedValue(
    options.runningDigest ?? "sha256:running",
  );
  runtime.resolveAvailableImageDigest.mockResolvedValue(
    options.availableDigest ?? "sha256:available",
  );
  runtime.rolloutRestartServer.mockResolvedValue(undefined);

  return runtime;
}
