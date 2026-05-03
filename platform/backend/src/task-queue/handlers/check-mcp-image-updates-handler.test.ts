import { vi } from "vitest";
import type {
  ImageUpdateRuntime,
  ResolveAvailableImageDigestRuntimeParams,
} from "@/k8s/mcp-server-runtime";
import McpServerModel from "@/models/mcp-server";
import McpServerImageUpdateStateModel from "@/models/mcp-server-image-update-state";
import { McpImageUpdateCheckerService } from "@/services/mcp-image-update-checker";
import { describe, expect, test } from "@/test";
import type { TaskHandler } from "@/types";
import {
  handleCheckMcpImageUpdateFollowUp,
  handleCheckMcpImageUpdates,
} from "./check-mcp-image-updates-handler";

describe("handleCheckMcpImageUpdates", () => {
  test("is compatible with the task queue handler contract", async () => {
    const taskHandler: TaskHandler = handleCheckMcpImageUpdates;

    await expect(taskHandler({})).resolves.toBeUndefined();
  });

  test("follow-up handler is compatible with the task queue handler contract", async () => {
    const taskHandler: TaskHandler = handleCheckMcpImageUpdateFollowUp;

    await expect(
      taskHandler({ mcpServerId: "00000000-0000-0000-0000-000000000001" }),
    ).resolves.toBeUndefined();
  });

  test("loads eligible local MCP servers and does not crash when none exist", async () => {
    const runtime = createRuntime();
    const service = new McpImageUpdateCheckerService({ runtime });

    await expect(
      service.handleCheckMcpImageUpdates({}),
    ).resolves.toBeUndefined();

    expect(runtime.getRunningImageDigest).not.toHaveBeenCalled();
    expect(runtime.resolveAvailableImageDigest).not.toHaveBeenCalled();
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
      localInstallationStatus: "success",
    });
    const disabledServer = await makeMcpServer({
      catalogId: disabledCatalog.id,
      serverType: "local",
      imageUpdateCheckEnabled: false,
      localInstallationStatus: "success",
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
    expect(runtime.resolveAvailableImageDigest).toHaveBeenCalledWith({
      mcpServerId: eligibleServer.id,
      image: "registry.example.com/mcp/eligible:stable",
      options: { timeoutMs: 60_000 },
    });
    expect(eligibleState).toMatchObject({
      mcpServerId: eligibleServer.id,
      status: "up_to_date",
    });
    expect(eligibleState?.lastCheckedAt).toBeInstanceOf(Date);
    expect(disabledState).toBeNull();
  });

  test("ignores local MCP servers that require manual reinstall", async ({
    makeInternalMcpCatalog,
    makeMcpServer,
  }) => {
    const catalog = await makeInternalMcpCatalog({
      serverType: "local",
      localConfig: {
        dockerImage: "registry.example.com/mcp/manual-reinstall:stable",
      },
    });
    const server = await makeMcpServer({
      catalogId: catalog.id,
      serverType: "local",
      imageUpdateCheckEnabled: true,
      localInstallationStatus: "success",
    });
    await McpServerModel.update(server.id, { reinstallRequired: true });
    const runtime = createRuntime({
      runningDigest: "sha256:old",
      availableDigest: "sha256:new",
    });
    const service = new McpImageUpdateCheckerService({ runtime });

    await service.handleCheckMcpImageUpdates({});

    const state = await McpServerImageUpdateStateModel.findByMcpServerId(
      server.id,
    );

    expect(runtime.getRunningImageDigest).not.toHaveBeenCalled();
    expect(runtime.resolveAvailableImageDigest).not.toHaveBeenCalled();
    expect(state).toBeNull();
  });

  test("ignores local MCP servers that are not successfully installed", async ({
    makeInternalMcpCatalog,
    makeMcpServer,
  }) => {
    const statuses = ["idle", "pending", "discovering-tools", "error"] as const;
    const serverIds: string[] = [];

    for (const status of statuses) {
      const catalog = await makeInternalMcpCatalog({
        serverType: "local",
        localConfig: {
          dockerImage: `registry.example.com/mcp/${status}:stable`,
        },
      });
      const server = await makeMcpServer({
        catalogId: catalog.id,
        serverType: "local",
        imageUpdateCheckEnabled: true,
        localInstallationStatus: status,
      });
      serverIds.push(server.id);
    }

    const runtime = createRuntime({
      runningDigest: "sha256:old",
      availableDigest: "sha256:new",
    });
    const service = new McpImageUpdateCheckerService({ runtime });

    await service.handleCheckMcpImageUpdates({});

    const states = await Promise.all(
      serverIds.map((serverId) =>
        McpServerImageUpdateStateModel.findByMcpServerId(serverId),
      ),
    );

    expect(runtime.getRunningImageDigest).not.toHaveBeenCalled();
    expect(runtime.resolveAvailableImageDigest).not.toHaveBeenCalled();
    expect(states).toEqual([null, null, null, null]);
  });

  test("ignores local MCP servers without Docker image config", async ({
    makeInternalMcpCatalog,
    makeMcpServer,
  }) => {
    const catalog = await makeInternalMcpCatalog({
      serverType: "local",
      localConfig: {
        command: "node",
      },
    });
    const server = await makeMcpServer({
      catalogId: catalog.id,
      serverType: "local",
      imageUpdateCheckEnabled: true,
      localInstallationStatus: "success",
    });
    const runtime = createRuntime({
      runningDigest: "sha256:old",
      availableDigest: "sha256:new",
    });
    const service = new McpImageUpdateCheckerService({ runtime });

    await service.handleCheckMcpImageUpdates({});

    const state = await McpServerImageUpdateStateModel.findByMcpServerId(
      server.id,
    );

    expect(runtime.getRunningImageDigest).not.toHaveBeenCalled();
    expect(runtime.resolveAvailableImageDigest).not.toHaveBeenCalled();
    expect(state).toBeNull();
  });

  test("processes a targeted follow-up payload without triggering another restart", async ({
    makeInternalMcpCatalog,
    makeMcpServer,
  }) => {
    const targetCatalog = await makeInternalMcpCatalog({
      serverType: "local",
      localConfig: {
        dockerImage: "registry.example.com/mcp/target:stable",
      },
    });
    const otherCatalog = await makeInternalMcpCatalog({
      serverType: "local",
      localConfig: {
        dockerImage: "registry.example.com/mcp/other:stable",
      },
    });
    const targetServer = await makeMcpServer({
      catalogId: targetCatalog.id,
      serverType: "local",
      imageUpdateCheckEnabled: true,
      imageUpdateAutoRestartEnabled: true,
      localInstallationStatus: "success",
    });
    const otherServer = await makeMcpServer({
      catalogId: otherCatalog.id,
      serverType: "local",
      imageUpdateCheckEnabled: true,
      imageUpdateAutoRestartEnabled: true,
      localInstallationStatus: "success",
    });
    const runtime = createRuntime({
      runningDigest: "sha256:old",
      availableDigest: "sha256:new",
    });
    const service = new McpImageUpdateCheckerService({
      maxJitterMs: 0,
      runtime,
    });

    await service.handleCheckMcpImageUpdates({
      mcpServerId: targetServer.id,
      skipAutoRestart: true,
    });

    const targetState = await McpServerImageUpdateStateModel.findByMcpServerId(
      targetServer.id,
    );
    const otherState = await McpServerImageUpdateStateModel.findByMcpServerId(
      otherServer.id,
    );

    expect(runtime.getRunningImageDigest).toHaveBeenCalledTimes(1);
    expect(runtime.getRunningImageDigest).toHaveBeenCalledWith(targetServer.id);
    expect(targetState).toMatchObject({
      mcpServerId: targetServer.id,
      status: "update_available",
    });
    expect(otherState).toBeNull();
  });

  test("dedicated follow-up path targets one rollout and verifies running digest", async ({
    makeInternalMcpCatalog,
    makeMcpServer,
  }) => {
    const rolloutStartedAt = new Date("2026-01-01T00:10:00.000Z");
    const targetCatalog = await makeInternalMcpCatalog({
      serverType: "local",
      localConfig: {
        dockerImage: "registry.example.com/mcp/follow-up-target:stable",
      },
    });
    const otherCatalog = await makeInternalMcpCatalog({
      serverType: "local",
      localConfig: {
        dockerImage: "registry.example.com/mcp/follow-up-other:stable",
      },
    });
    const targetServer = await makeMcpServer({
      catalogId: targetCatalog.id,
      serverType: "local",
      imageUpdateCheckEnabled: true,
      imageUpdateAutoRestartEnabled: true,
      localInstallationStatus: "success",
    });
    const otherServer = await makeMcpServer({
      catalogId: otherCatalog.id,
      serverType: "local",
      imageUpdateCheckEnabled: true,
      imageUpdateAutoRestartEnabled: true,
      localInstallationStatus: "success",
    });
    await McpServerImageUpdateStateModel.upsertLatestState({
      mcpServerId: targetServer.id,
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
      runningDigest: "sha256:new",
      availableDigest: "sha256:new",
    });
    const service = new McpImageUpdateCheckerService({
      maxJitterMs: 0,
      runtime,
    });

    await service.handleCheckMcpImageUpdateFollowUp({
      attemptCount: 1,
      mcpServerId: targetServer.id,
      rolloutStartedAt: rolloutStartedAt.toISOString(),
      targetImageDigest: "sha256:new",
    });

    const targetState = await McpServerImageUpdateStateModel.findByMcpServerId(
      targetServer.id,
    );
    const otherState = await McpServerImageUpdateStateModel.findByMcpServerId(
      otherServer.id,
    );

    expect(runtime.getRunningImageDigest).toHaveBeenCalledTimes(1);
    expect(runtime.getRunningImageDigest).toHaveBeenCalledWith(targetServer.id);
    expect(runtime.resolveAvailableImageDigest).not.toHaveBeenCalled();
    expect(targetState).toMatchObject({
      mcpServerId: targetServer.id,
      runningImageDigest: "sha256:new",
      targetImageDigest: "sha256:new",
      status: "up_to_date",
    });
    expect(otherState).toBeNull();
  });

  test("dedicated follow-up path ignores invalid payloads", async ({
    makeInternalMcpCatalog,
    makeMcpServer,
  }) => {
    const catalog = await makeInternalMcpCatalog({
      serverType: "local",
      localConfig: {
        dockerImage: "registry.example.com/mcp/ignored-follow-up:stable",
      },
    });
    const server = await makeMcpServer({
      catalogId: catalog.id,
      serverType: "local",
      imageUpdateCheckEnabled: true,
      localInstallationStatus: "success",
    });
    const runtime = createRuntime();
    const service = new McpImageUpdateCheckerService({ runtime });

    await service.handleCheckMcpImageUpdateFollowUp({});
    await service.handleCheckMcpImageUpdateFollowUp({
      mcpServerId: "not-a-valid-id",
    });

    const state = await McpServerImageUpdateStateModel.findByMcpServerId(
      server.id,
    );

    expect(runtime.getRunningImageDigest).not.toHaveBeenCalled();
    expect(runtime.resolveAvailableImageDigest).not.toHaveBeenCalled();
    expect(state).toBeNull();
  });

  test("continues processing later servers when one image check fails", async ({
    makeInternalMcpCatalog,
    makeMcpServer,
  }) => {
    const failingCatalog = await makeInternalMcpCatalog({
      serverType: "local",
      localConfig: {
        dockerImage: "registry.example.com/mcp/failing:stable",
      },
    });
    const successfulCatalog = await makeInternalMcpCatalog({
      serverType: "local",
      localConfig: {
        dockerImage: "registry.example.com/mcp/successful:stable",
      },
    });
    const failingServer = await makeMcpServer({
      catalogId: failingCatalog.id,
      serverType: "local",
      imageUpdateCheckEnabled: true,
      localInstallationStatus: "success",
    });
    const successfulServer = await makeMcpServer({
      catalogId: successfulCatalog.id,
      serverType: "local",
      imageUpdateCheckEnabled: true,
      localInstallationStatus: "success",
    });
    const runtime = createRuntime();
    runtime.getRunningImageDigest.mockImplementation(async (mcpServerId) => {
      if (mcpServerId === failingServer.id) {
        throw new Error("registry unavailable");
      }

      return "sha256:same";
    });
    runtime.resolveAvailableImageDigest.mockResolvedValue("sha256:same");
    const service = new McpImageUpdateCheckerService({
      concurrencyLimit: 1,
      maxJitterMs: 0,
      runtime,
    });

    await service.handleCheckMcpImageUpdates({});

    const failingState = await McpServerImageUpdateStateModel.findByMcpServerId(
      failingServer.id,
    );
    const successfulState =
      await McpServerImageUpdateStateModel.findByMcpServerId(
        successfulServer.id,
      );

    expect(runtime.getRunningImageDigest).toHaveBeenCalledWith(
      failingServer.id,
    );
    expect(runtime.getRunningImageDigest).toHaveBeenCalledWith(
      successfulServer.id,
    );
    expect(failingState).toMatchObject({
      mcpServerId: failingServer.id,
      status: "check_failed",
      lastErrorCategory: "running_digest_error",
      lastErrorMessage: "registry unavailable",
      consecutiveFailureCount: 1,
    });
    expect(successfulState).toMatchObject({
      mcpServerId: successfulServer.id,
      status: "up_to_date",
    });
  });

  test("limits concurrent image checks", async ({
    makeInternalMcpCatalog,
    makeMcpServer,
  }) => {
    for (let index = 0; index < 4; index += 1) {
      const catalog = await makeInternalMcpCatalog({
        serverType: "local",
        localConfig: {
          dockerImage: `registry.example.com/mcp/server-${index}:stable`,
        },
      });
      await makeMcpServer({
        catalogId: catalog.id,
        serverType: "local",
        imageUpdateCheckEnabled: true,
        localInstallationStatus: "success",
      });
    }
    const runtime = createRuntime();
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
    runtime.resolveAvailableImageDigest.mockResolvedValue("sha256:same");
    const service = new McpImageUpdateCheckerService({
      concurrencyLimit: 2,
      maxJitterMs: 0,
      runtime,
    });

    const handlerPromise = service.handleCheckMcpImageUpdates({});

    await waitForCondition(() => startedServerIds.length === 2);
    expect(startedServerIds).toHaveLength(2);

    runningDigestRequests
      .get(startedServerIds[0] ?? "")
      ?.resolve("sha256:same");
    await waitForCondition(() => startedServerIds.length === 3);
    expect(startedServerIds).toHaveLength(3);

    for (const deferred of runningDigestRequests.values()) {
      deferred.resolve("sha256:same");
    }
    await waitForCondition(() => startedServerIds.length === 4);
    for (const deferred of runningDigestRequests.values()) {
      deferred.resolve("sha256:same");
    }

    await handlerPromise;

    expect(runtime.getRunningImageDigest).toHaveBeenCalledTimes(4);
  });

  test("schedules bounded per-server jitter before processing checks", async ({
    makeInternalMcpCatalog,
    makeMcpServer,
  }) => {
    const catalog = await makeInternalMcpCatalog({
      serverType: "local",
      localConfig: {
        dockerImage: "registry.example.com/mcp/jittered:stable",
      },
    });
    await makeMcpServer({
      catalogId: catalog.id,
      serverType: "local",
      imageUpdateCheckEnabled: true,
      localInstallationStatus: "success",
    });
    const runtime = createRuntime({
      runningDigest: "sha256:same",
      availableDigest: "sha256:same",
    });
    const service = new JitterTestMcpImageUpdateCheckerService({
      maxJitterMs: 37,
      runtime,
    });
    service.getJitterMsMock.mockReturnValue(23);

    await service.handleCheckMcpImageUpdates({});

    expect(service.getJitterMsMock).toHaveBeenCalledWith(37);
    expect(service.sleepMock).toHaveBeenCalledWith(23);
    expect(runtime.getRunningImageDigest).toHaveBeenCalledTimes(1);
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
      vi.fn<
        (
          params: ResolveAvailableImageDigestRuntimeParams,
        ) => Promise<string | null>
      >(),
  } satisfies ImageUpdateRuntime;

  runtime.getRunningImageDigest.mockResolvedValue(
    options.runningDigest ?? "sha256:running",
  );
  runtime.resolveAvailableImageDigest.mockResolvedValue(
    options.availableDigest ?? "sha256:available",
  );
  return runtime;
}

class JitterTestMcpImageUpdateCheckerService extends McpImageUpdateCheckerService {
  readonly getJitterMsMock = vi.fn<(maxJitterMs: number) => number>();
  readonly sleepMock = vi
    .fn<(ms: number) => Promise<void>>()
    .mockResolvedValue(undefined);

  protected override getJitterMs(maxJitterMs: number): number {
    return this.getJitterMsMock(maxJitterMs);
  }

  protected override sleep(ms: number): Promise<void> {
    return this.sleepMock(ms);
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
