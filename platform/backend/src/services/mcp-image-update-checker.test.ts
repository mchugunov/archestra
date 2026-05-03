import { vi } from "vitest";
import type {
  ImageUpdateRuntime,
  ResolveAvailableImageDigestRuntimeParams,
} from "@/k8s/mcp-server-runtime";
import McpServerImageUpdateStateModel from "@/models/mcp-server-image-update-state";
import { autoReinstallLocalMcpServerAfterImageUpdate } from "@/services/mcp-reinstall";
import { beforeEach, describe, expect, test } from "@/test";
import { McpImageUpdateCheckerService } from "./mcp-image-update-checker";

const CHECKED_AT = new Date("2026-01-01T00:10:00.000Z");

vi.mock("@/services/mcp-reinstall", () => ({
  autoReinstallLocalMcpServerAfterImageUpdate: vi.fn(),
}));

const autoReinstallAfterImageUpdateMock = vi.mocked(
  autoReinstallLocalMcpServerAfterImageUpdate,
);

beforeEach(() => {
  autoReinstallAfterImageUpdateMock.mockReset();
  autoReinstallAfterImageUpdateMock.mockResolvedValue(undefined);
});

describe("processMcpServerImageUpdateCheck", () => {
  test("persists up_to_date for digest-pinned images without probing runtime", async ({
    makeInternalMcpCatalog,
    makeMcpServer,
  }) => {
    const catalog = await makeInternalMcpCatalog({
      serverType: "local",
      localConfig: {
        dockerImage: "registry.example.com/mcp/server@sha256:pinned123",
      },
    });
    const server = await makeMcpServer({
      catalogId: catalog.id,
      serverType: "local",
      imageUpdateCheckEnabled: true,
    });
    const runtime = createRuntime();
    const service = new McpImageUpdateCheckerService({ runtime });

    await service.processMcpServerImageUpdateCheck({
      eligibleServer: { server, catalog },
      checkedAt: CHECKED_AT,
    });

    const state = await McpServerImageUpdateStateModel.findByMcpServerId(
      server.id,
    );

    expect(runtime.getRunningImageDigest).not.toHaveBeenCalled();
    expect(runtime.resolveAvailableImageDigest).not.toHaveBeenCalled();
    expect(state).toMatchObject({
      mcpServerId: server.id,
      lastCheckedAt: CHECKED_AT,
      runningImageDigest: "sha256:pinned123",
      availableImageDigest: "sha256:pinned123",
      status: "up_to_date",
    });
  });

  test("persists up_to_date when running and available digests match", async ({
    makeInternalMcpCatalog,
    makeMcpServer,
  }) => {
    const image = "registry.example.com/mcp/server:stable";
    const catalog = await makeInternalMcpCatalog({
      serverType: "local",
      localConfig: { dockerImage: image },
    });
    const server = await makeMcpServer({
      catalogId: catalog.id,
      serverType: "local",
      imageUpdateCheckEnabled: true,
    });
    const runtime = createRuntime({
      runningDigest:
        "docker-pullable://registry.example.com/mcp/server@sha256:same",
      availableDigest: "containerd://sha256:same",
    });

    const service = new McpImageUpdateCheckerService({ runtime });

    await service.processMcpServerImageUpdateCheck({
      eligibleServer: { server, catalog },
      checkedAt: CHECKED_AT,
    });

    const state = await McpServerImageUpdateStateModel.findByMcpServerId(
      server.id,
    );

    expect(runtime.getRunningImageDigest).toHaveBeenCalledWith(server.id);
    expect(runtime.resolveAvailableImageDigest).toHaveBeenCalledWith({
      mcpServerId: server.id,
      image,
      options: { timeoutMs: 60_000 },
    });
    expect(state).toMatchObject({
      mcpServerId: server.id,
      lastCheckedAt: CHECKED_AT,
      runningImageDigest: "sha256:same",
      availableImageDigest: "sha256:same",
      status: "up_to_date",
    });
  });

  test("persists update_available when digests differ and auto-restart is disabled", async ({
    makeInternalMcpCatalog,
    makeMcpServer,
  }) => {
    const catalog = await makeInternalMcpCatalog({
      serverType: "local",
      localConfig: { dockerImage: "registry.example.com/mcp/server:stable" },
    });
    const server = await makeMcpServer({
      catalogId: catalog.id,
      serverType: "local",
      imageUpdateCheckEnabled: true,
      imageUpdateAutoRestartEnabled: false,
    });
    const runtime = createRuntime({
      runningDigest: "sha256:old",
      availableDigest: "sha256:new",
    });

    const service = new McpImageUpdateCheckerService({ runtime });

    await service.processMcpServerImageUpdateCheck({
      eligibleServer: { server, catalog },
      checkedAt: CHECKED_AT,
    });

    const state = await McpServerImageUpdateStateModel.findByMcpServerId(
      server.id,
    );

    expect(state).toMatchObject({
      mcpServerId: server.id,
      lastCheckedAt: CHECKED_AT,
      runningImageDigest: "sha256:old",
      availableImageDigest: "sha256:new",
      status: "update_available",
    });
  });

  test("reinstalls and persists restart_triggered when digests differ and auto-restart is enabled", async ({
    makeInternalMcpCatalog,
    makeMcpServer,
  }) => {
    const catalog = await makeInternalMcpCatalog({
      serverType: "local",
      localConfig: { dockerImage: "registry.example.com/mcp/server:stable" },
    });
    const server = await makeMcpServer({
      catalogId: catalog.id,
      serverType: "local",
      imageUpdateCheckEnabled: true,
      imageUpdateAutoRestartEnabled: true,
    });
    const runtime = createRuntime({
      runningDigest: "sha256:old",
      availableDigest: "sha256:new",
    });
    const service = new TestMcpImageUpdateCheckerService({
      runtime,
    });
    const beforeCheck = Date.now();

    await service.processMcpServerImageUpdateCheck({
      eligibleServer: { server, catalog },
      checkedAt: CHECKED_AT,
    });

    const state = await McpServerImageUpdateStateModel.findByMcpServerId(
      server.id,
    );

    expect(autoReinstallAfterImageUpdateMock).toHaveBeenCalledWith({
      server,
      catalogItem: catalog,
      runningImageDigest: "sha256:old",
      availableImageDigest: "sha256:new",
    });
    expect(service.scheduleFollowUpCheckMock).toHaveBeenCalledWith({
      mcpServerId: server.id,
      scheduledFor: expect.any(Date),
    });
    const scheduledFor =
      service.scheduleFollowUpCheckMock.mock.calls[0]?.[0].scheduledFor;
    expect(scheduledFor?.getTime()).toBeGreaterThanOrEqual(
      beforeCheck + 10_000,
    );
    expect(state).toMatchObject({
      mcpServerId: server.id,
      lastCheckedAt: CHECKED_AT,
      runningImageDigest: "sha256:old",
      availableImageDigest: "sha256:new",
      status: "restart_triggered",
      lastRestartedAt: CHECKED_AT,
    });
  });

  test("does not persist restart_triggered when image update reinstall fails", async ({
    makeInternalMcpCatalog,
    makeMcpServer,
  }) => {
    const catalog = await makeInternalMcpCatalog({
      serverType: "local",
      localConfig: { dockerImage: "registry.example.com/mcp/server:stable" },
    });
    const server = await makeMcpServer({
      catalogId: catalog.id,
      serverType: "local",
      imageUpdateCheckEnabled: true,
      imageUpdateAutoRestartEnabled: true,
    });
    const runtime = createRuntime({
      runningDigest: "sha256:old",
      availableDigest: "sha256:new",
    });
    autoReinstallAfterImageUpdateMock.mockRejectedValueOnce(
      new Error("reinstall failed"),
    );

    const service = new TestMcpImageUpdateCheckerService({
      runtime,
    });

    await service.processMcpServerImageUpdateCheck({
      eligibleServer: { server, catalog },
      checkedAt: CHECKED_AT,
    });

    const state = await McpServerImageUpdateStateModel.findByMcpServerId(
      server.id,
    );

    expect(autoReinstallAfterImageUpdateMock).toHaveBeenCalledWith({
      server,
      catalogItem: catalog,
      runningImageDigest: "sha256:old",
      availableImageDigest: "sha256:new",
    });
    expect(service.scheduleFollowUpCheckMock).not.toHaveBeenCalled();
    expect(state).toBeNull();
  });

  test("persists update_available without restart when auto-restart is skipped by task payload", async ({
    makeInternalMcpCatalog,
    makeMcpServer,
  }) => {
    const catalog = await makeInternalMcpCatalog({
      serverType: "local",
      localConfig: { dockerImage: "registry.example.com/mcp/server:stable" },
    });
    const server = await makeMcpServer({
      catalogId: catalog.id,
      serverType: "local",
      imageUpdateCheckEnabled: true,
      imageUpdateAutoRestartEnabled: true,
    });
    const runtime = createRuntime({
      runningDigest: "sha256:old",
      availableDigest: "sha256:new",
    });
    const service = new TestMcpImageUpdateCheckerService({
      runtime,
    });

    await service.processMcpServerImageUpdateCheck({
      eligibleServer: { server, catalog },
      allowAutoRestart: false,
      checkedAt: CHECKED_AT,
    });

    const state = await McpServerImageUpdateStateModel.findByMcpServerId(
      server.id,
    );

    expect(service.scheduleFollowUpCheckMock).not.toHaveBeenCalled();
    expect(state).toMatchObject({
      mcpServerId: server.id,
      lastCheckedAt: CHECKED_AT,
      runningImageDigest: "sha256:old",
      availableImageDigest: "sha256:new",
      status: "update_available",
    });
  });

  test("skips persistence when configured image is missing", async ({
    makeInternalMcpCatalog,
    makeMcpServer,
  }) => {
    const catalog = await makeInternalMcpCatalog({
      serverType: "local",
      localConfig: { command: "node" },
    });
    const server = await makeMcpServer({
      catalogId: catalog.id,
      serverType: "local",
      imageUpdateCheckEnabled: true,
    });
    const runtime = createRuntime();
    const service = new McpImageUpdateCheckerService({ runtime });

    await service.processMcpServerImageUpdateCheck({
      eligibleServer: { server, catalog },
      checkedAt: CHECKED_AT,
    });

    const state = await McpServerImageUpdateStateModel.findByMcpServerId(
      server.id,
    );

    expect(runtime.getRunningImageDigest).not.toHaveBeenCalled();
    expect(runtime.resolveAvailableImageDigest).not.toHaveBeenCalled();
    expect(state).toBeNull();
  });

  test("logs and skips persistence when running digest inspection fails", async ({
    makeInternalMcpCatalog,
    makeMcpServer,
  }) => {
    const catalog = await makeInternalMcpCatalog({
      serverType: "local",
      localConfig: { dockerImage: "registry.example.com/mcp/server:stable" },
    });
    const server = await makeMcpServer({
      catalogId: catalog.id,
      serverType: "local",
      imageUpdateCheckEnabled: true,
    });
    const runtime = createRuntime({
      runningDigest: new Error("running digest failed"),
      availableDigest: "sha256:new",
    });

    const service = new McpImageUpdateCheckerService({ runtime });

    await service.processMcpServerImageUpdateCheck({
      eligibleServer: { server, catalog },
      checkedAt: CHECKED_AT,
    });

    const state = await McpServerImageUpdateStateModel.findByMcpServerId(
      server.id,
    );

    expect(state).toBeNull();
  });

  test("logs and skips persistence when probe digest resolution fails", async ({
    makeInternalMcpCatalog,
    makeMcpServer,
  }) => {
    const catalog = await makeInternalMcpCatalog({
      serverType: "local",
      localConfig: { dockerImage: "registry.example.com/mcp/server:stable" },
    });
    const server = await makeMcpServer({
      catalogId: catalog.id,
      serverType: "local",
      imageUpdateCheckEnabled: true,
    });
    const runtime = createRuntime({
      runningDigest: "sha256:old",
      availableDigest: new Error("probe digest failed"),
    });

    const service = new McpImageUpdateCheckerService({ runtime });

    await service.processMcpServerImageUpdateCheck({
      eligibleServer: { server, catalog },
      checkedAt: CHECKED_AT,
    });

    const state = await McpServerImageUpdateStateModel.findByMcpServerId(
      server.id,
    );

    expect(state).toBeNull();
  });

  test("passes custom available digest timeout to runtime", async ({
    makeInternalMcpCatalog,
    makeMcpServer,
  }) => {
    const image = "registry.example.com/mcp/server:stable";
    const catalog = await makeInternalMcpCatalog({
      serverType: "local",
      localConfig: { dockerImage: image },
    });
    const server = await makeMcpServer({
      catalogId: catalog.id,
      serverType: "local",
      imageUpdateCheckEnabled: true,
    });
    const runtime = createRuntime({
      runningDigest: "sha256:same",
      availableDigest: "sha256:same",
    });

    const service = new McpImageUpdateCheckerService({
      availableDigestTimeoutMs: 1_234,
      runtime,
    });

    await service.processMcpServerImageUpdateCheck({
      eligibleServer: { server, catalog },
      checkedAt: CHECKED_AT,
    });

    expect(runtime.resolveAvailableImageDigest).toHaveBeenCalledWith({
      mcpServerId: server.id,
      image,
      options: { timeoutMs: 1_234 },
    });
  });
});

function createRuntime(
  options: {
    runningDigest?: string | null | Error;
    availableDigest?: string | null | Error;
  } = {},
) {
  const runtime = {
    getRunningImageDigest:
      vi.fn<(mcpServerId: string) => Promise<string | null>>(),
    resolveAvailableImageDigest:
      vi.fn<
        (
          params: ResolveAvailableImageDigestRuntimeParams,
        ) => Promise<string | null>
      >(),
  } satisfies ImageUpdateRuntime;

  const runningDigest = options.runningDigest ?? "sha256:running";
  if (runningDigest instanceof Error) {
    runtime.getRunningImageDigest.mockRejectedValue(runningDigest);
  } else {
    runtime.getRunningImageDigest.mockResolvedValue(runningDigest);
  }

  const availableDigest = options.availableDigest ?? "sha256:available";
  if (availableDigest instanceof Error) {
    runtime.resolveAvailableImageDigest.mockRejectedValue(availableDigest);
  } else {
    runtime.resolveAvailableImageDigest.mockResolvedValue(availableDigest);
  }
  return runtime;
}

class TestMcpImageUpdateCheckerService extends McpImageUpdateCheckerService {
  readonly scheduleFollowUpCheckMock = vi
    .fn<
      (params: { mcpServerId: string; scheduledFor: Date }) => Promise<void>
    >()
    .mockResolvedValue(undefined);

  protected override async scheduleImageUpdateFollowUpCheck(
    mcpServerId: string,
    scheduledFor: Date,
  ): Promise<void> {
    await this.scheduleFollowUpCheckMock({ mcpServerId, scheduledFor });
  }
}
