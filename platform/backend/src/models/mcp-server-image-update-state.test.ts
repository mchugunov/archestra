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
        status: "restart_triggered",
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
        status: "restart_triggered",
        lastRestartedAt,
      });
    });
  });
});
