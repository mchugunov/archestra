import { describe, expect, test } from "@/test";
import McpServerImageUpdateCheckLockModel from "./mcp-server-image-update-check-lock";

describe("McpServerImageUpdateCheckLockModel", () => {
  test("prevents a second active lock for the same MCP server", async ({
    makeMcpServer,
  }) => {
    const server = await makeMcpServer();
    const now = new Date("2026-01-01T00:00:00.000Z");
    const lockedUntil = new Date("2026-01-01T00:10:00.000Z");

    const firstAcquired = await McpServerImageUpdateCheckLockModel.tryAcquire({
      mcpServerId: server.id,
      checkRunId: "first-run",
      lockedUntil,
      now,
    });
    const secondAcquired = await McpServerImageUpdateCheckLockModel.tryAcquire({
      mcpServerId: server.id,
      checkRunId: "second-run",
      lockedUntil,
      now: new Date("2026-01-01T00:01:00.000Z"),
    });

    expect(firstAcquired).toBe(true);
    expect(secondAcquired).toBe(false);
  });

  test("allows another lock after the existing lock is released", async ({
    makeMcpServer,
  }) => {
    const server = await makeMcpServer();
    const now = new Date("2026-01-01T00:00:00.000Z");
    const lockedUntil = new Date("2026-01-01T00:10:00.000Z");

    await McpServerImageUpdateCheckLockModel.tryAcquire({
      mcpServerId: server.id,
      checkRunId: "first-run",
      lockedUntil,
      now,
    });
    await McpServerImageUpdateCheckLockModel.release(server.id, "first-run");

    const secondAcquired = await McpServerImageUpdateCheckLockModel.tryAcquire({
      mcpServerId: server.id,
      checkRunId: "second-run",
      lockedUntil,
      now: new Date("2026-01-01T00:01:00.000Z"),
    });

    expect(secondAcquired).toBe(true);
  });

  test("allows replacing an expired lock", async ({ makeMcpServer }) => {
    const server = await makeMcpServer();

    await McpServerImageUpdateCheckLockModel.tryAcquire({
      mcpServerId: server.id,
      checkRunId: "first-run",
      lockedUntil: new Date("2026-01-01T00:10:00.000Z"),
      now: new Date("2026-01-01T00:00:00.000Z"),
    });

    const replacementAcquired =
      await McpServerImageUpdateCheckLockModel.tryAcquire({
        mcpServerId: server.id,
        checkRunId: "second-run",
        lockedUntil: new Date("2026-01-01T00:25:00.000Z"),
        now: new Date("2026-01-01T00:11:00.000Z"),
      });

    expect(replacementAcquired).toBe(true);
  });
});
