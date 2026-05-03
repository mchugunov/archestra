import { vi } from "vitest";
import type {
  ImageUpdateRuntime,
  ResolveAvailableImageDigestRuntimeParams,
} from "@/k8s/mcp-server-runtime";
import McpServerModel from "@/models/mcp-server";
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
      lastSuccessfulCheckedAt: CHECKED_AT,
      lastFailedAt: null,
      lastErrorCategory: null,
      lastErrorMessage: null,
      consecutiveFailureCount: 0,
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
      lastSuccessfulCheckedAt: CHECKED_AT,
      consecutiveFailureCount: 0,
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

  test("reinstalls and persists reinstalling rollout state when digests differ and auto-restart is enabled", async ({
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
      server: expect.objectContaining({
        id: server.id,
        reinstallRequired: false,
      }),
      catalogItem: catalog,
      runningImageDigest: "sha256:old",
      availableImageDigest: "sha256:new",
    });
    expect(service.scheduleFollowUpCheckMock).toHaveBeenCalledWith({
      attemptCount: 1,
      mcpServerId: server.id,
      rolloutStartedAt: CHECKED_AT,
      scheduledFor: expect.any(Date),
      targetImageDigest: "sha256:new",
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
      targetImageDigest: "sha256:new",
      status: "reinstalling",
      lastRestartedAt: CHECKED_AT,
      rolloutStartedAt: CHECKED_AT,
      rolloutLastCheckedAt: CHECKED_AT,
      rolloutAttemptCount: 0,
    });
  });

  test("skips an overlapping check for the same MCP server while a check is active", async ({
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
    const runningDigest = createDeferredValue<string | null>();
    const runtime = createRuntime({ availableDigest: "sha256:same" });
    runtime.getRunningImageDigest.mockReturnValue(runningDigest.promise);
    const service = new McpImageUpdateCheckerService({ runtime });

    const firstCheck = service.processMcpServerImageUpdateCheck({
      eligibleServer: { server, catalog },
      checkedAt: CHECKED_AT,
    });
    await waitForCondition(
      () => runtime.getRunningImageDigest.mock.calls.length === 1,
    );

    await service.processMcpServerImageUpdateCheck({
      eligibleServer: { server, catalog },
      checkedAt: new Date("2026-01-01T00:11:00.000Z"),
    });

    expect(runtime.getRunningImageDigest).toHaveBeenCalledTimes(1);

    runningDigest.resolve("sha256:same");
    await firstCheck;

    const state = await McpServerImageUpdateStateModel.findByMcpServerId(
      server.id,
    );
    expect(state).toMatchObject({
      mcpServerId: server.id,
      status: "up_to_date",
      runningImageDigest: "sha256:same",
      availableImageDigest: "sha256:same",
    });
  });

  test("allows checks for different MCP servers to run concurrently", async ({
    makeInternalMcpCatalog,
    makeMcpServer,
  }) => {
    const firstCatalog = await makeInternalMcpCatalog({
      serverType: "local",
      localConfig: { dockerImage: "registry.example.com/mcp/first:stable" },
    });
    const secondCatalog = await makeInternalMcpCatalog({
      serverType: "local",
      localConfig: { dockerImage: "registry.example.com/mcp/second:stable" },
    });
    const firstServer = await makeMcpServer({
      catalogId: firstCatalog.id,
      serverType: "local",
      imageUpdateCheckEnabled: true,
    });
    const secondServer = await makeMcpServer({
      catalogId: secondCatalog.id,
      serverType: "local",
      imageUpdateCheckEnabled: true,
    });
    const runtime = createRuntime({ availableDigest: "sha256:same" });
    const startedServerIds: string[] = [];
    const runningDigestRequests = new Map<
      string,
      DeferredValue<string | null>
    >();
    runtime.getRunningImageDigest.mockImplementation((mcpServerId) => {
      startedServerIds.push(mcpServerId);
      const deferred = createDeferredValue<string | null>();
      runningDigestRequests.set(mcpServerId, deferred);
      return deferred.promise;
    });
    const service = new McpImageUpdateCheckerService({ runtime });

    const firstCheck = service.processMcpServerImageUpdateCheck({
      eligibleServer: { server: firstServer, catalog: firstCatalog },
      checkedAt: CHECKED_AT,
    });
    const secondCheck = service.processMcpServerImageUpdateCheck({
      eligibleServer: { server: secondServer, catalog: secondCatalog },
      checkedAt: CHECKED_AT,
    });

    await waitForCondition(() => startedServerIds.length === 2);
    expect(startedServerIds).toEqual(
      expect.arrayContaining([firstServer.id, secondServer.id]),
    );

    for (const deferred of runningDigestRequests.values()) {
      deferred.resolve("sha256:same");
    }
    await Promise.all([firstCheck, secondCheck]);

    expect(runtime.getRunningImageDigest).toHaveBeenCalledTimes(2);
  });

  test("does not trigger duplicate auto-reinstall for a digest with restart in progress", async ({
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
    await McpServerImageUpdateStateModel.upsertLatestState({
      mcpServerId: server.id,
      lastCheckedAt: new Date("2026-01-01T00:05:00.000Z"),
      runningImageDigest: "sha256:old",
      availableImageDigest: "sha256:new",
      status: "reinstalling",
      lastRestartedAt: new Date("2026-01-01T00:05:00.000Z"),
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
      checkedAt: CHECKED_AT,
    });

    expect(autoReinstallAfterImageUpdateMock).not.toHaveBeenCalled();
    expect(service.scheduleFollowUpCheckMock).not.toHaveBeenCalled();
  });

  test("does not trigger duplicate auto-reinstall while rollout is in progress for the same digest", async ({
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
    await McpServerImageUpdateStateModel.upsertLatestState({
      mcpServerId: server.id,
      lastCheckedAt: new Date("2026-01-01T00:05:00.000Z"),
      runningImageDigest: "sha256:old",
      availableImageDigest: "sha256:new",
      targetImageDigest: "sha256:new",
      status: "reinstalling",
      lastRestartedAt: new Date("2026-01-01T00:05:00.000Z"),
      rolloutStartedAt: new Date("2026-01-01T00:05:00.000Z"),
      rolloutLastCheckedAt: new Date("2026-01-01T00:05:00.000Z"),
      rolloutAttemptCount: 1,
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
      checkedAt: CHECKED_AT,
    });

    const state = await McpServerImageUpdateStateModel.findByMcpServerId(
      server.id,
    );

    expect(autoReinstallAfterImageUpdateMock).not.toHaveBeenCalled();
    expect(service.scheduleFollowUpCheckMock).not.toHaveBeenCalled();
    expect(state).toMatchObject({
      mcpServerId: server.id,
      status: "reinstalling",
      targetImageDigest: "sha256:new",
      rolloutAttemptCount: 1,
    });
  });

  test("marks stale active rollout failed so a later check can retry", async ({
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
    const staleRolloutAt = new Date("2025-12-31T23:50:00.000Z");
    await McpServerImageUpdateStateModel.upsertLatestState({
      mcpServerId: server.id,
      lastCheckedAt: staleRolloutAt,
      runningImageDigest: "sha256:old",
      availableImageDigest: "sha256:new",
      targetImageDigest: "sha256:new",
      status: "reinstalling",
      lastRestartedAt: staleRolloutAt,
      rolloutStartedAt: staleRolloutAt,
      rolloutLastCheckedAt: staleRolloutAt,
      rolloutAttemptCount: 1,
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
      checkedAt: CHECKED_AT,
    });

    let state = await McpServerImageUpdateStateModel.findByMcpServerId(
      server.id,
    );

    expect(autoReinstallAfterImageUpdateMock).not.toHaveBeenCalled();
    expect(service.scheduleFollowUpCheckMock).not.toHaveBeenCalled();
    expect(state).toMatchObject({
      mcpServerId: server.id,
      lastCheckedAt: CHECKED_AT,
      runningImageDigest: "sha256:old",
      availableImageDigest: "sha256:new",
      targetImageDigest: "sha256:new",
      status: "rollout_failed",
      lastFailedAt: CHECKED_AT,
      lastErrorCategory: "rollout_stale",
      rolloutStartedAt: staleRolloutAt,
      rolloutLastCheckedAt: CHECKED_AT,
      rolloutAttemptCount: 1,
    });

    autoReinstallAfterImageUpdateMock.mockClear();
    const retryService = new TestMcpImageUpdateCheckerService({
      runtime: createRuntime({
        runningDigest: "sha256:old",
        availableDigest: "sha256:new",
      }),
    });

    await retryService.processMcpServerImageUpdateCheck({
      eligibleServer: { server, catalog },
      checkedAt: new Date("2026-01-01T00:11:00.000Z"),
    });

    state = await McpServerImageUpdateStateModel.findByMcpServerId(server.id);
    expect(autoReinstallAfterImageUpdateMock).toHaveBeenCalledTimes(1);
    expect(state).toMatchObject({
      mcpServerId: server.id,
      status: "reinstalling",
      targetImageDigest: "sha256:new",
    });
  });

  test("keeps rollout state and schedules retry when follow-up still sees old digest", async ({
    makeMcpServer,
  }) => {
    const server = await makeMcpServer();
    const rolloutStartedAt = new Date("2026-01-01T00:10:00.000Z");
    const followUpCheckedAt = new Date("2026-01-01T00:10:10.000Z");
    await McpServerImageUpdateStateModel.upsertLatestState({
      mcpServerId: server.id,
      lastCheckedAt: rolloutStartedAt,
      runningImageDigest: "sha256:old",
      availableImageDigest: "sha256:new",
      targetImageDigest: "sha256:new",
      status: "reinstalling",
      lastRestartedAt: rolloutStartedAt,
      rolloutStartedAt,
      rolloutLastCheckedAt: rolloutStartedAt,
      rolloutAttemptCount: 0,
    });
    const runtime = createRuntime({
      runningDigest: "sha256:old",
      availableDigest: "sha256:new",
    });
    const service = new TestMcpImageUpdateCheckerService({ runtime });

    await service.processMcpServerImageUpdateFollowUp({
      attemptCount: 1,
      checkedAt: followUpCheckedAt,
      mcpServerId: server.id,
      rolloutStartedAt,
      targetImageDigest: "sha256:new",
    });

    const state = await McpServerImageUpdateStateModel.findByMcpServerId(
      server.id,
    );

    expect(runtime.getRunningImageDigest).toHaveBeenCalledWith(server.id);
    expect(runtime.resolveAvailableImageDigest).not.toHaveBeenCalled();
    expect(service.scheduleFollowUpCheckMock).toHaveBeenCalledWith({
      attemptCount: 2,
      mcpServerId: server.id,
      rolloutStartedAt,
      scheduledFor: expect.any(Date),
      targetImageDigest: "sha256:new",
    });
    expect(state).toMatchObject({
      mcpServerId: server.id,
      lastCheckedAt: followUpCheckedAt,
      runningImageDigest: "sha256:old",
      availableImageDigest: "sha256:new",
      targetImageDigest: "sha256:new",
      status: "reinstalling",
      rolloutStartedAt,
      rolloutLastCheckedAt: followUpCheckedAt,
      rolloutAttemptCount: 1,
    });
  });

  test("marks up_to_date when follow-up reaches target digest", async ({
    makeMcpServer,
  }) => {
    const server = await makeMcpServer();
    const rolloutStartedAt = new Date("2026-01-01T00:10:00.000Z");
    const followUpCheckedAt = new Date("2026-01-01T00:10:30.000Z");
    await McpServerImageUpdateStateModel.upsertLatestState({
      mcpServerId: server.id,
      lastCheckedAt: rolloutStartedAt,
      runningImageDigest: "sha256:old",
      availableImageDigest: "sha256:new",
      targetImageDigest: "sha256:new",
      status: "reinstalling",
      lastRestartedAt: rolloutStartedAt,
      rolloutStartedAt,
      rolloutLastCheckedAt: rolloutStartedAt,
      rolloutAttemptCount: 1,
    });
    const runtime = createRuntime({
      runningDigest: "sha256:new",
      availableDigest: "sha256:new",
    });
    const service = new TestMcpImageUpdateCheckerService({ runtime });

    await service.processMcpServerImageUpdateFollowUp({
      attemptCount: 2,
      checkedAt: followUpCheckedAt,
      mcpServerId: server.id,
      rolloutStartedAt,
      targetImageDigest: "sha256:new",
    });

    const state = await McpServerImageUpdateStateModel.findByMcpServerId(
      server.id,
    );

    expect(service.scheduleFollowUpCheckMock).not.toHaveBeenCalled();
    expect(state).toMatchObject({
      mcpServerId: server.id,
      lastCheckedAt: followUpCheckedAt,
      runningImageDigest: "sha256:new",
      availableImageDigest: "sha256:new",
      targetImageDigest: "sha256:new",
      status: "up_to_date",
      lastSuccessfulCheckedAt: followUpCheckedAt,
      rolloutStartedAt,
      rolloutLastCheckedAt: followUpCheckedAt,
      rolloutAttemptCount: 2,
    });
  });

  test("marks rollout_failed when follow-up exhausts attempts", async ({
    makeMcpServer,
  }) => {
    const server = await makeMcpServer();
    const rolloutStartedAt = new Date("2026-01-01T00:10:00.000Z");
    const followUpCheckedAt = new Date("2026-01-01T00:14:10.000Z");
    await McpServerImageUpdateStateModel.upsertLatestState({
      mcpServerId: server.id,
      lastCheckedAt: rolloutStartedAt,
      runningImageDigest: "sha256:old",
      availableImageDigest: "sha256:new",
      targetImageDigest: "sha256:new",
      status: "reinstalling",
      lastRestartedAt: rolloutStartedAt,
      rolloutStartedAt,
      rolloutLastCheckedAt: rolloutStartedAt,
      rolloutAttemptCount: 5,
    });
    const runtime = createRuntime({
      runningDigest: "sha256:old",
      availableDigest: "sha256:new",
    });
    const service = new TestMcpImageUpdateCheckerService({ runtime });

    await service.processMcpServerImageUpdateFollowUp({
      attemptCount: 6,
      checkedAt: followUpCheckedAt,
      mcpServerId: server.id,
      rolloutStartedAt,
      targetImageDigest: "sha256:new",
    });

    const state = await McpServerImageUpdateStateModel.findByMcpServerId(
      server.id,
    );

    expect(service.scheduleFollowUpCheckMock).not.toHaveBeenCalled();
    expect(state).toMatchObject({
      mcpServerId: server.id,
      lastCheckedAt: followUpCheckedAt,
      runningImageDigest: "sha256:old",
      availableImageDigest: "sha256:new",
      targetImageDigest: "sha256:new",
      status: "rollout_failed",
      lastFailedAt: followUpCheckedAt,
      lastErrorCategory: "rollout_timeout",
      rolloutStartedAt,
      rolloutLastCheckedAt: followUpCheckedAt,
      rolloutAttemptCount: 6,
    });
  });

  test("skips follow-up when a newer rollout state superseded it", async ({
    makeMcpServer,
  }) => {
    const server = await makeMcpServer();
    const oldRolloutStartedAt = new Date("2026-01-01T00:10:00.000Z");
    const newRolloutStartedAt = new Date("2026-01-01T00:12:00.000Z");
    await McpServerImageUpdateStateModel.upsertLatestState({
      mcpServerId: server.id,
      lastCheckedAt: newRolloutStartedAt,
      runningImageDigest: "sha256:old",
      availableImageDigest: "sha256:newer",
      targetImageDigest: "sha256:newer",
      status: "reinstalling",
      lastRestartedAt: newRolloutStartedAt,
      rolloutStartedAt: newRolloutStartedAt,
      rolloutLastCheckedAt: newRolloutStartedAt,
      rolloutAttemptCount: 0,
    });
    const runtime = createRuntime({
      runningDigest: "sha256:new",
      availableDigest: "sha256:new",
    });
    const service = new TestMcpImageUpdateCheckerService({ runtime });

    await service.processMcpServerImageUpdateFollowUp({
      attemptCount: 1,
      checkedAt: new Date("2026-01-01T00:12:10.000Z"),
      mcpServerId: server.id,
      rolloutStartedAt: oldRolloutStartedAt,
      targetImageDigest: "sha256:new",
    });

    const state = await McpServerImageUpdateStateModel.findByMcpServerId(
      server.id,
    );

    expect(runtime.getRunningImageDigest).not.toHaveBeenCalled();
    expect(service.scheduleFollowUpCheckMock).not.toHaveBeenCalled();
    expect(state).toMatchObject({
      mcpServerId: server.id,
      targetImageDigest: "sha256:newer",
      status: "reinstalling",
      rolloutStartedAt: newRolloutStartedAt,
    });
  });

  test("does not let an older follow-up result regress newer up_to_date state", async ({
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
    const newerCheckedAt = new Date("2026-01-01T00:20:00.000Z");
    await McpServerImageUpdateStateModel.upsertLatestState({
      mcpServerId: server.id,
      lastCheckedAt: newerCheckedAt,
      runningImageDigest: "sha256:new",
      availableImageDigest: "sha256:new",
      status: "up_to_date",
    });
    const runtime = createRuntime({
      runningDigest: "sha256:old",
      availableDigest: "sha256:new",
    });
    const service = new McpImageUpdateCheckerService({ runtime });

    await service.processMcpServerImageUpdateCheck({
      eligibleServer: { server, catalog },
      allowAutoRestart: false,
      checkedAt: CHECKED_AT,
    });

    const state = await McpServerImageUpdateStateModel.findByMcpServerId(
      server.id,
    );
    expect(state).toMatchObject({
      mcpServerId: server.id,
      lastCheckedAt: newerCheckedAt,
      runningImageDigest: "sha256:new",
      availableImageDigest: "sha256:new",
      status: "up_to_date",
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
      server: expect.objectContaining({
        id: server.id,
        reinstallRequired: false,
      }),
      catalogItem: catalog,
      runningImageDigest: "sha256:old",
      availableImageDigest: "sha256:new",
    });
    expect(service.scheduleFollowUpCheckMock).not.toHaveBeenCalled();
    expect(state).toMatchObject({
      mcpServerId: server.id,
      lastCheckedAt: CHECKED_AT,
      status: "check_failed",
      lastFailedAt: CHECKED_AT,
      lastErrorCategory: "reinstall_failed",
      lastErrorMessage: "reinstall failed",
      consecutiveFailureCount: 1,
      lastRestartedAt: null,
    });

    autoReinstallAfterImageUpdateMock.mockClear();
    const retryRuntime = createRuntime({
      runningDigest: "sha256:old",
      availableDigest: "sha256:new",
    });
    const retryService = new TestMcpImageUpdateCheckerService({
      runtime: retryRuntime,
    });

    await retryService.processMcpServerImageUpdateCheck({
      eligibleServer: { server, catalog },
      checkedAt: new Date("2026-01-01T00:11:00.000Z"),
    });

    expect(autoReinstallAfterImageUpdateMock).toHaveBeenCalledTimes(1);
  });

  test("skips auto-reinstall when manual reinstall becomes required before reinstall is attempted", async ({
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
    runtime.resolveAvailableImageDigest.mockImplementation(async () => {
      await McpServerModel.update(server.id, { reinstallRequired: true });
      return "sha256:new";
    });
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

    expect(autoReinstallAfterImageUpdateMock).not.toHaveBeenCalled();
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

  test("persists failed state when configured image is missing", async ({
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
    expect(state).toMatchObject({
      mcpServerId: server.id,
      lastCheckedAt: CHECKED_AT,
      status: "check_failed",
      lastFailedAt: CHECKED_AT,
      lastErrorCategory: "missing_configured_image",
      lastErrorMessage: "No Docker image is configured for this MCP server.",
      consecutiveFailureCount: 1,
    });
  });

  test("persists failed state when running digest inspection fails", async ({
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

    expect(state).toMatchObject({
      mcpServerId: server.id,
      lastCheckedAt: CHECKED_AT,
      status: "check_failed",
      lastFailedAt: CHECKED_AT,
      lastErrorCategory: "running_digest_error",
      lastErrorMessage: "running digest failed",
      consecutiveFailureCount: 1,
    });
  });

  test("persists failed state when probe digest resolution fails", async ({
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

    expect(state).toMatchObject({
      mcpServerId: server.id,
      lastCheckedAt: CHECKED_AT,
      status: "check_failed",
      lastFailedAt: CHECKED_AT,
      lastErrorCategory: "available_digest_error",
      lastErrorMessage: "probe digest failed",
      consecutiveFailureCount: 1,
    });
  });

  test("persists failed state when probe scheduling constraints cannot be resolved", async ({
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
      availableDigest: new Error(
        "Failed to resolve scheduling constraints for MCP server deployment mcp-server",
      ),
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
      status: "check_failed",
      lastFailedAt: CHECKED_AT,
      lastErrorCategory: "available_digest_error",
      lastErrorMessage:
        "Failed to resolve scheduling constraints for MCP server deployment mcp-server",
      consecutiveFailureCount: 1,
    });
  });

  test("persists timeout failure state with a safe display message", async ({
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
    const timeoutError = new Error(
      "pull timeout with token=super-secret-value",
    );
    timeoutError.name = "TimeoutError";
    const runtime = createRuntime({
      runningDigest: "sha256:old",
      availableDigest: timeoutError,
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
      status: "check_failed",
      lastErrorCategory: "timeout",
      lastErrorMessage: "Image update check timed out.",
      consecutiveFailureCount: 1,
    });
    expect(state?.lastErrorMessage).not.toContain("super-secret-value");
  });

  test("does not keep showing previous up_to_date state after a failed check", async ({
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
    const previousSuccessAt = new Date("2026-01-01T00:05:00.000Z");
    await McpServerImageUpdateStateModel.upsertLatestState({
      mcpServerId: server.id,
      lastCheckedAt: previousSuccessAt,
      lastSuccessfulCheckedAt: previousSuccessAt,
      runningImageDigest: "sha256:old",
      availableImageDigest: "sha256:old",
      status: "up_to_date",
    });
    const runtime = createRuntime({
      runningDigest: new Error("cluster unavailable"),
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
      lastSuccessfulCheckedAt: previousSuccessAt,
      runningImageDigest: "sha256:old",
      availableImageDigest: "sha256:old",
      status: "check_failed",
      lastErrorCategory: "running_digest_error",
      lastErrorMessage: "cluster unavailable",
      consecutiveFailureCount: 1,
    });
  });

  test("successful check clears visible failure state", async ({
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
    await McpServerImageUpdateStateModel.recordFailure({
      mcpServerId: server.id,
      checkedAt: new Date("2026-01-01T00:05:00.000Z"),
      errorCategory: "available_digest_error",
      errorMessage: "Available image digest could not be resolved.",
    });
    const runtime = createRuntime({
      runningDigest: "sha256:same",
      availableDigest: "sha256:same",
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
      lastSuccessfulCheckedAt: CHECKED_AT,
      status: "up_to_date",
      lastFailedAt: null,
      lastErrorCategory: null,
      lastErrorMessage: null,
      consecutiveFailureCount: 0,
    });
  });

  test("sanitizes persisted error messages", async ({
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
      availableDigest: new Error(
        "pull failed https://user:password@registry.example.com?token=registry-secret Authorization: Bearer abc123",
      ),
    });
    const service = new McpImageUpdateCheckerService({ runtime });

    await service.processMcpServerImageUpdateCheck({
      eligibleServer: { server, catalog },
      checkedAt: CHECKED_AT,
    });

    const state = await McpServerImageUpdateStateModel.findByMcpServerId(
      server.id,
    );

    expect(state?.lastErrorMessage).toContain("[redacted]");
    expect(state?.lastErrorMessage).not.toContain("password");
    expect(state?.lastErrorMessage).not.toContain("registry-secret");
    expect(state?.lastErrorMessage).not.toContain("abc123");
    expect(state?.lastErrorMessage).not.toContain("user:password");
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
      (params: {
        attemptCount: number;
        mcpServerId: string;
        rolloutStartedAt: Date;
        scheduledFor: Date;
        targetImageDigest: string;
      }) => Promise<void>
    >()
    .mockResolvedValue(undefined);

  protected override async scheduleImageUpdateFollowUpCheck(params: {
    attemptCount: number;
    mcpServerId: string;
    rolloutStartedAt: Date;
    scheduledFor: Date;
    targetImageDigest: string;
  }): Promise<void> {
    await this.scheduleFollowUpCheckMock(params);
  }
}

type DeferredValue<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
};

function createDeferredValue<T>(): DeferredValue<T> {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });

  return { promise, resolve };
}

async function waitForCondition(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error("Timed out waiting for condition");
    }

    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
