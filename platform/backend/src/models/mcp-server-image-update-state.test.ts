import { describe, expect, test } from "@/test";
import McpServerImageUpdateStateModel from "./mcp-server-image-update-state";

describe("McpServerImageUpdateStateModel", () => {
  describe("findByMcpServerId", () => {
    test("returns null when no state row exists", async ({ makeMcpServer }) => {
      const server = await makeMcpServer();

      const result = await McpServerImageUpdateStateModel.findByMcpServerId(
        server.id,
      );

      expect(result).toBeNull();
    });
  });

  describe("findByMcpServerIds", () => {
    test("returns states keyed by MCP server ID", async ({ makeMcpServer }) => {
      const serverWithState = await makeMcpServer();
      const otherServerWithState = await makeMcpServer();
      const serverWithoutState = await makeMcpServer();

      await McpServerImageUpdateStateModel.upsertLatestState({
        mcpServerId: serverWithState.id,
        status: "up_to_date",
      });
      await McpServerImageUpdateStateModel.upsertLatestState({
        mcpServerId: otherServerWithState.id,
        status: "update_available",
      });

      const result = await McpServerImageUpdateStateModel.findByMcpServerIds([
        serverWithState.id,
        otherServerWithState.id,
        serverWithoutState.id,
      ]);

      expect(result.size).toBe(2);
      expect(result.get(serverWithState.id)?.status).toBe("up_to_date");
      expect(result.get(otherServerWithState.id)?.status).toBe(
        "update_available",
      );
      expect(result.has(serverWithoutState.id)).toBe(false);
    });

    test("returns an empty map for empty input", async () => {
      const result = await McpServerImageUpdateStateModel.findByMcpServerIds(
        [],
      );

      expect(result.size).toBe(0);
    });
  });

  describe("upsertLatestState", () => {
    test("creates a new state row with lean image fields", async ({
      makeMcpServer,
    }) => {
      const server = await makeMcpServer();
      const lastCheckedAt = new Date("2026-01-01T00:00:00.000Z");

      const result = await McpServerImageUpdateStateModel.upsertLatestState({
        mcpServerId: server.id,
        lastCheckedAt,
        runningImageDigest: "sha256:running",
        availableImageDigest: "sha256:available",
        status: "update_available",
        lastRestartedAt: null,
      });

      expect(result).toMatchObject({
        mcpServerId: server.id,
        lastCheckedAt,
        runningImageDigest: "sha256:running",
        availableImageDigest: "sha256:available",
        status: "update_available",
        lastRestartedAt: null,
        consecutiveFailureCount: 0,
      });
    });

    test("updates an existing state row without creating a second row", async ({
      makeMcpServer,
    }) => {
      const server = await makeMcpServer();
      const firstCheckedAt = new Date("2026-01-01T00:00:00.000Z");
      const secondCheckedAt = new Date("2026-01-01T00:10:00.000Z");
      const lastRestartedAt = new Date("2026-01-01T00:11:00.000Z");

      await McpServerImageUpdateStateModel.upsertLatestState({
        mcpServerId: server.id,
        lastCheckedAt: firstCheckedAt,
        runningImageDigest: "sha256:old",
        availableImageDigest: "sha256:new",
        status: "update_available",
      });
      await McpServerImageUpdateStateModel.upsertLatestState({
        mcpServerId: server.id,
        lastCheckedAt: secondCheckedAt,
        runningImageDigest: "sha256:new",
        availableImageDigest: "sha256:new",
        status: "reinstalling",
        lastRestartedAt,
      });

      const result = await McpServerImageUpdateStateModel.findByMcpServerIds([
        server.id,
      ]);

      expect(result.size).toBe(1);
      expect(result.get(server.id)).toMatchObject({
        mcpServerId: server.id,
        lastCheckedAt: secondCheckedAt,
        runningImageDigest: "sha256:new",
        availableImageDigest: "sha256:new",
        status: "reinstalling",
        lastRestartedAt,
        consecutiveFailureCount: 0,
      });
    });

    test("persists rollout verification metadata", async ({
      makeMcpServer,
    }) => {
      const server = await makeMcpServer();
      const checkedAt = new Date("2026-01-01T00:10:00.000Z");

      const result = await McpServerImageUpdateStateModel.upsertLatestState({
        mcpServerId: server.id,
        lastCheckedAt: checkedAt,
        runningImageDigest: "sha256:old",
        availableImageDigest: "sha256:new",
        targetImageDigest: "sha256:new",
        status: "reinstalling",
        lastRestartedAt: checkedAt,
        rolloutStartedAt: checkedAt,
        rolloutLastCheckedAt: checkedAt,
        rolloutAttemptCount: 1,
      });

      expect(result).toMatchObject({
        mcpServerId: server.id,
        lastCheckedAt: checkedAt,
        runningImageDigest: "sha256:old",
        availableImageDigest: "sha256:new",
        targetImageDigest: "sha256:new",
        status: "reinstalling",
        lastRestartedAt: checkedAt,
        rolloutStartedAt: checkedAt,
        rolloutLastCheckedAt: checkedAt,
        rolloutAttemptCount: 1,
      });
    });

    test("does not let an older check overwrite newer state", async ({
      makeMcpServer,
    }) => {
      const server = await makeMcpServer();
      const newerCheckedAt = new Date("2026-01-01T00:10:00.000Z");
      const olderCheckedAt = new Date("2026-01-01T00:05:00.000Z");

      await McpServerImageUpdateStateModel.upsertLatestState({
        mcpServerId: server.id,
        lastCheckedAt: newerCheckedAt,
        runningImageDigest: "sha256:new",
        availableImageDigest: "sha256:new",
        status: "up_to_date",
      });
      const staleResult =
        await McpServerImageUpdateStateModel.upsertLatestState({
          mcpServerId: server.id,
          lastCheckedAt: olderCheckedAt,
          runningImageDigest: "sha256:old",
          availableImageDigest: "sha256:available",
          status: "update_available",
        });

      const result = await McpServerImageUpdateStateModel.findByMcpServerId(
        server.id,
      );

      expect(staleResult).toBeNull();
      expect(result).toMatchObject({
        mcpServerId: server.id,
        lastCheckedAt: newerCheckedAt,
        runningImageDigest: "sha256:new",
        availableImageDigest: "sha256:new",
        status: "up_to_date",
      });
    });

    test("allows a newer check to overwrite older state", async ({
      makeMcpServer,
    }) => {
      const server = await makeMcpServer();
      const olderCheckedAt = new Date("2026-01-01T00:05:00.000Z");
      const newerCheckedAt = new Date("2026-01-01T00:10:00.000Z");

      await McpServerImageUpdateStateModel.upsertLatestState({
        mcpServerId: server.id,
        lastCheckedAt: olderCheckedAt,
        runningImageDigest: "sha256:old",
        availableImageDigest: "sha256:available",
        status: "update_available",
      });
      const updateResult =
        await McpServerImageUpdateStateModel.upsertLatestState({
          mcpServerId: server.id,
          lastCheckedAt: newerCheckedAt,
          runningImageDigest: "sha256:new",
          availableImageDigest: "sha256:new",
          status: "up_to_date",
        });

      expect(updateResult).toMatchObject({
        mcpServerId: server.id,
        lastCheckedAt: newerCheckedAt,
        runningImageDigest: "sha256:new",
        availableImageDigest: "sha256:new",
        status: "up_to_date",
      });
    });
  });

  describe("hasRestartTriggeredForDigest", () => {
    test("returns true only when the digest has already been restarted", async ({
      makeMcpServer,
    }) => {
      const restartedServer = await makeMcpServer();
      const notRestartedServer = await makeMcpServer();
      const failedServer = await makeMcpServer();

      await McpServerImageUpdateStateModel.upsertLatestState({
        mcpServerId: restartedServer.id,
        lastCheckedAt: new Date("2026-01-01T00:10:00.000Z"),
        runningImageDigest: "sha256:old",
        availableImageDigest: "sha256:new",
        status: "reinstalling",
        lastRestartedAt: new Date("2026-01-01T00:10:00.000Z"),
      });
      await McpServerImageUpdateStateModel.upsertLatestState({
        mcpServerId: notRestartedServer.id,
        lastCheckedAt: new Date("2026-01-01T00:10:00.000Z"),
        runningImageDigest: "sha256:old",
        availableImageDigest: "sha256:new",
        status: "update_available",
      });
      await McpServerImageUpdateStateModel.upsertLatestState({
        mcpServerId: failedServer.id,
        lastCheckedAt: new Date("2026-01-01T00:10:00.000Z"),
        runningImageDigest: "sha256:old",
        availableImageDigest: "sha256:new",
        status: "check_failed",
        lastRestartedAt: new Date("2026-01-01T00:10:00.000Z"),
      });

      await expect(
        McpServerImageUpdateStateModel.hasRestartTriggeredForDigest(
          restartedServer.id,
          "sha256:new",
        ),
      ).resolves.toBe(true);
      await expect(
        McpServerImageUpdateStateModel.hasRestartTriggeredForDigest(
          restartedServer.id,
          "sha256:other",
        ),
      ).resolves.toBe(false);
      await expect(
        McpServerImageUpdateStateModel.hasRestartTriggeredForDigest(
          notRestartedServer.id,
          "sha256:new",
        ),
      ).resolves.toBe(false);
      await expect(
        McpServerImageUpdateStateModel.hasRestartTriggeredForDigest(
          failedServer.id,
          "sha256:new",
        ),
      ).resolves.toBe(false);
    });
  });

  describe("hasActiveRolloutForDigest", () => {
    test("returns true only for active rollout state matching the target digest", async ({
      makeMcpServer,
    }) => {
      const activeServer = await makeMcpServer();
      const inactiveServer = await makeMcpServer();
      const checkedAt = new Date("2026-01-01T00:10:00.000Z");

      await McpServerImageUpdateStateModel.upsertLatestState({
        mcpServerId: activeServer.id,
        lastCheckedAt: checkedAt,
        runningImageDigest: "sha256:old",
        availableImageDigest: "sha256:new",
        targetImageDigest: "sha256:new",
        status: "reinstalling",
        rolloutStartedAt: checkedAt,
      });
      await McpServerImageUpdateStateModel.upsertLatestState({
        mcpServerId: inactiveServer.id,
        lastCheckedAt: checkedAt,
        runningImageDigest: "sha256:old",
        availableImageDigest: "sha256:new",
        targetImageDigest: "sha256:new",
        status: "rollout_failed",
        rolloutStartedAt: checkedAt,
      });

      await expect(
        McpServerImageUpdateStateModel.hasActiveRolloutForDigest({
          mcpServerId: activeServer.id,
          targetImageDigest: "sha256:new",
        }),
      ).resolves.toBe(true);
      await expect(
        McpServerImageUpdateStateModel.hasActiveRolloutForDigest({
          mcpServerId: activeServer.id,
          targetImageDigest: "sha256:other",
        }),
      ).resolves.toBe(false);
      await expect(
        McpServerImageUpdateStateModel.hasActiveRolloutForDigest({
          mcpServerId: inactiveServer.id,
          targetImageDigest: "sha256:new",
        }),
      ).resolves.toBe(false);
    });

    test("returns false for stale active rollout when recovery window is provided", async ({
      makeMcpServer,
    }) => {
      const freshServer = await makeMcpServer();
      const staleServer = await makeMcpServer();
      const checkedAt = new Date("2026-01-01T00:10:00.000Z");
      const freshRolloutAt = new Date("2026-01-01T00:07:00.000Z");
      const staleRolloutAt = new Date("2026-01-01T00:00:00.000Z");

      await McpServerImageUpdateStateModel.upsertLatestState({
        mcpServerId: freshServer.id,
        lastCheckedAt: freshRolloutAt,
        runningImageDigest: "sha256:old",
        availableImageDigest: "sha256:new",
        targetImageDigest: "sha256:new",
        status: "reinstalling",
        rolloutStartedAt: freshRolloutAt,
        rolloutLastCheckedAt: freshRolloutAt,
      });
      await McpServerImageUpdateStateModel.upsertLatestState({
        mcpServerId: staleServer.id,
        lastCheckedAt: staleRolloutAt,
        runningImageDigest: "sha256:old",
        availableImageDigest: "sha256:new",
        targetImageDigest: "sha256:new",
        status: "reinstalling",
        rolloutStartedAt: staleRolloutAt,
        rolloutLastCheckedAt: staleRolloutAt,
      });

      await expect(
        McpServerImageUpdateStateModel.hasActiveRolloutForDigest({
          mcpServerId: freshServer.id,
          targetImageDigest: "sha256:new",
          checkedAt,
          staleAfterMs: 5 * 60_000,
        }),
      ).resolves.toBe(true);
      await expect(
        McpServerImageUpdateStateModel.hasActiveRolloutForDigest({
          mcpServerId: staleServer.id,
          targetImageDigest: "sha256:new",
          checkedAt,
          staleAfterMs: 5 * 60_000,
        }),
      ).resolves.toBe(false);
    });
  });

  describe("recordRolloutFailed", () => {
    test("records visible rollout failure metadata", async ({
      makeMcpServer,
    }) => {
      const server = await makeMcpServer();
      const rolloutStartedAt = new Date("2026-01-01T00:10:00.000Z");
      const checkedAt = new Date("2026-01-01T00:14:00.000Z");

      const result = await McpServerImageUpdateStateModel.recordRolloutFailed({
        mcpServerId: server.id,
        checkedAt,
        runningImageDigest: "sha256:old",
        targetImageDigest: "sha256:new",
        rolloutStartedAt,
        rolloutAttemptCount: 6,
        errorCategory: "rollout_timeout",
        errorMessage: "Image update rollout did not reach the target digest.",
      });

      expect(result).toMatchObject({
        mcpServerId: server.id,
        lastCheckedAt: checkedAt,
        runningImageDigest: "sha256:old",
        availableImageDigest: "sha256:new",
        targetImageDigest: "sha256:new",
        status: "rollout_failed",
        rolloutStartedAt,
        rolloutLastCheckedAt: checkedAt,
        rolloutAttemptCount: 6,
        lastFailedAt: checkedAt,
        lastErrorCategory: "rollout_timeout",
      });
    });
  });

  describe("recordFailure", () => {
    test("creates failed state with safe failure metadata", async ({
      makeMcpServer,
    }) => {
      const server = await makeMcpServer();
      const checkedAt = new Date("2026-01-01T00:10:00.000Z");

      const result = await McpServerImageUpdateStateModel.recordFailure({
        mcpServerId: server.id,
        checkedAt,
        errorCategory: "available_digest_error",
        errorMessage: "Available image digest could not be resolved.",
      });

      expect(result).toMatchObject({
        mcpServerId: server.id,
        lastCheckedAt: checkedAt,
        status: "check_failed",
        lastFailedAt: checkedAt,
        lastErrorCategory: "available_digest_error",
        lastErrorMessage: "Available image digest could not be resolved.",
        consecutiveFailureCount: 1,
      });
    });

    test("increments consecutive failure count", async ({ makeMcpServer }) => {
      const server = await makeMcpServer();

      await McpServerImageUpdateStateModel.recordFailure({
        mcpServerId: server.id,
        checkedAt: new Date("2026-01-01T00:10:00.000Z"),
        errorCategory: "running_digest_error",
        errorMessage: "Running image digest could not be resolved.",
      });
      const result = await McpServerImageUpdateStateModel.recordFailure({
        mcpServerId: server.id,
        checkedAt: new Date("2026-01-01T00:11:00.000Z"),
        errorCategory: "available_digest_error",
        errorMessage: "Available image digest could not be resolved.",
      });

      expect(result).toMatchObject({
        status: "check_failed",
        lastErrorCategory: "available_digest_error",
        consecutiveFailureCount: 2,
      });
    });

    test("does not let older failure overwrite newer successful state", async ({
      makeMcpServer,
    }) => {
      const server = await makeMcpServer();
      const newerCheckedAt = new Date("2026-01-01T00:20:00.000Z");

      await McpServerImageUpdateStateModel.upsertLatestState({
        mcpServerId: server.id,
        lastCheckedAt: newerCheckedAt,
        runningImageDigest: "sha256:new",
        availableImageDigest: "sha256:new",
        status: "up_to_date",
      });
      const staleResult = await McpServerImageUpdateStateModel.recordFailure({
        mcpServerId: server.id,
        checkedAt: new Date("2026-01-01T00:10:00.000Z"),
        errorCategory: "available_digest_error",
        errorMessage: "Available image digest could not be resolved.",
      });

      const result = await McpServerImageUpdateStateModel.findByMcpServerId(
        server.id,
      );

      expect(staleResult).toBeNull();
      expect(result).toMatchObject({
        mcpServerId: server.id,
        lastCheckedAt: newerCheckedAt,
        status: "up_to_date",
        consecutiveFailureCount: 0,
      });
    });
  });
});
