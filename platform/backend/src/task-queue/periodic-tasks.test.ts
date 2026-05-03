import { describe, expect, test, vi } from "vitest";

vi.mock("@/config", () => ({
  default: {
    orchestrator: {
      imageUpdateCheckIntervalSeconds: 1234,
    },
  },
}));

import PERIODIC_TASK_DEFINITIONS from "./periodic-tasks";

describe("PERIODIC_TASK_DEFINITIONS", () => {
  test("includes MCP image update checks using the configured interval", () => {
    expect(PERIODIC_TASK_DEFINITIONS).toEqual(
      expect.arrayContaining([
        {
          taskType: "check_mcp_image_updates",
          intervalSeconds: 1234,
          payload: {},
        },
      ]),
    );
  });

  test("keeps MCP image update follow-up checks out of periodic scheduling", () => {
    expect(PERIODIC_TASK_DEFINITIONS).toContainEqual(
      expect.objectContaining({ taskType: "check_mcp_image_updates" }),
    );
    expect(PERIODIC_TASK_DEFINITIONS).not.toContainEqual(
      expect.objectContaining({
        taskType: "check_mcp_image_update_follow_up",
      }),
    );
  });
});
