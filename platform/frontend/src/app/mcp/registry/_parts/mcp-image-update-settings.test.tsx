import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  McpImageUpdateSettings,
  type McpImageUpdateSettingsInstall,
} from "./mcp-image-update-settings";

const { mutateMock } = vi.hoisted(() => ({
  mutateMock: vi.fn(),
}));

vi.mock("@/lib/mcp/mcp-server.query", () => ({
  useUpdateMcpServerImageUpdateSettings: () => ({
    isPending: false,
    mutate: mutateMock,
  }),
}));

type InstalledMcpServer = McpImageUpdateSettingsInstall;

describe("McpImageUpdateSettings", () => {
  beforeEach(() => {
    mutateMock.mockClear();
  });

  it("renders local image update controls and status", () => {
    render(
      <McpImageUpdateSettings
        variant="local"
        installs={[
          makeServer({
            imageUpdateAutoRestartEnabled: false,
            imageUpdateState: {
              mcpServerId: "server-1",
              lastCheckedAt: "2026-01-02T03:04:05.000Z",
              runningImageDigest: "sha256:running",
              availableImageDigest: "sha256:available",
              status: "update_available",
              lastRestartedAt: null,
              updatedAt: "2026-01-02T03:04:05.000Z",
            },
          }),
        ]}
      />,
    );

    expect(
      screen.getByRole("switch", { name: "Enable image update checks" }),
    ).toBeChecked();
    expect(
      screen.getByRole("switch", { name: "Enable auto-restart" }),
    ).not.toBeChecked();
    expect(screen.getByText("Update available")).toBeInTheDocument();
    expect(screen.getByText("sha256:running")).toBeInTheDocument();
    expect(screen.getByText("sha256:available")).toBeInTheDocument();
    expect(screen.getByText("Never")).toBeInTheDocument();
  });

  it("shows unavailable state for remote servers", () => {
    render(
      <McpImageUpdateSettings
        variant="remote"
        installs={[makeServer({ serverType: "remote" })]}
      />,
    );

    expect(
      screen.getByText(
        "Image update checks are available for local MCP server deployments only.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole("switch")).not.toBeInTheDocument();
  });

  it("sends a settings update when auto-restart is toggled", async () => {
    const user = userEvent.setup();
    render(
      <McpImageUpdateSettings
        variant="local"
        installs={[makeServer({ imageUpdateAutoRestartEnabled: false })]}
      />,
    );

    await user.click(
      screen.getByRole("switch", { name: "Enable auto-restart" }),
    );

    expect(mutateMock).toHaveBeenCalledWith({
      id: "server-1",
      name: "Local Server",
      imageUpdateAutoRestartEnabled: true,
    });
  });
});

function makeServer(
  overrides: Partial<InstalledMcpServer> = {},
): InstalledMcpServer {
  return {
    id: "server-1",
    name: "Local Server",
    serverType: "local",
    scope: "personal",
    imageUpdateCheckEnabled: true,
    imageUpdateAutoRestartEnabled: true,
    ownerEmail: "user@example.com",
    teamDetails: null,
    imageUpdateState: null,
    ...overrides,
  };
}
