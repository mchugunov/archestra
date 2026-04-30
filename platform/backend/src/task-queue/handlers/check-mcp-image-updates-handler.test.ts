import { vi } from "vitest";
import type {
  ImageUpdateRuntime,
  ResolveAvailableImageDigestRuntimeParams,
} from "@/k8s/mcp-server-runtime";
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
    expect(runtime.resolveAvailableImageDigest).toHaveBeenCalledWith({
      mcpServerId: eligibleServer.id,
      image: "registry.example.com/mcp/eligible:stable",
      options: { timeoutMs: 60_000 },
    });
    expect(runtime.rolloutRestartServer).not.toHaveBeenCalled();
    expect(eligibleState).toMatchObject({
      mcpServerId: eligibleServer.id,
      status: "up_to_date",
    });
    expect(eligibleState?.lastCheckedAt).toBeInstanceOf(Date);
    expect(disabledState).toBeNull();
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
    });
    const successfulServer = await makeMcpServer({
      catalogId: successfulCatalog.id,
      serverType: "local",
      imageUpdateCheckEnabled: true,
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
    expect(failingState).toBeNull();
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
    });
    const runtime = createRuntime({
      runningDigest: "sha256:same",
      availableDigest: "sha256:same",
    });
    const sleep = vi.fn<(_ms: number) => Promise<void>>();
    sleep.mockResolvedValue(undefined);
    const service = new McpImageUpdateCheckerService({
      jitterDelayProvider: () => 23,
      maxJitterMs: 37,
      runtime,
      sleep,
    });

    await service.handleCheckMcpImageUpdates({});

    expect(sleep).toHaveBeenCalledWith(23);
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
