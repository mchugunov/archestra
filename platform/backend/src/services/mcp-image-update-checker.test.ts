import { vi } from "vitest";
import type { ImageUpdateRuntime } from "@/k8s/mcp-server-runtime";
import McpServerImageUpdateStateModel from "@/models/mcp-server-image-update-state";
import { describe, expect, test } from "@/test";
import { processMcpServerImageUpdateCheck } from "./mcp-image-update-checker";

const CHECKED_AT = new Date("2026-01-01T00:10:00.000Z");

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

    await processMcpServerImageUpdateCheck({
      eligibleServer: { server, catalog },
      runtime,
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

    await processMcpServerImageUpdateCheck({
      eligibleServer: { server, catalog },
      runtime,
      checkedAt: CHECKED_AT,
    });

    const state = await McpServerImageUpdateStateModel.findByMcpServerId(
      server.id,
    );

    expect(runtime.getRunningImageDigest).toHaveBeenCalledWith(server.id);
    expect(runtime.resolveAvailableImageDigest).toHaveBeenCalledWith(
      server.id,
      image,
    );
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

    await processMcpServerImageUpdateCheck({
      eligibleServer: { server, catalog },
      runtime,
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

  test("persists update_available for changed digests until restart behavior is implemented", async ({
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

    await processMcpServerImageUpdateCheck({
      eligibleServer: { server, catalog },
      runtime,
      checkedAt: CHECKED_AT,
    });

    const state = await McpServerImageUpdateStateModel.findByMcpServerId(
      server.id,
    );

    expect(state?.status).toBe("update_available");
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

    await processMcpServerImageUpdateCheck({
      eligibleServer: { server, catalog },
      runtime,
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

    await processMcpServerImageUpdateCheck({
      eligibleServer: { server, catalog },
      runtime,
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

    await processMcpServerImageUpdateCheck({
      eligibleServer: { server, catalog },
      runtime,
      checkedAt: CHECKED_AT,
    });

    const state = await McpServerImageUpdateStateModel.findByMcpServerId(
      server.id,
    );

    expect(state).toBeNull();
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
      vi.fn<(mcpServerId: string, image: string) => Promise<string | null>>(),
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
