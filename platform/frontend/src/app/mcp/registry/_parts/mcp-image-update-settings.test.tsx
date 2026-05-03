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
              runningImageDigest:
                "sha256:f89c25ff172c74ebf9e583008301812d63115dfdc550e3b377337b148c6512cb",
              availableImageDigest:
                "sha256:a0c8fadf9a6431fa6ca145a6b0831c37cd20cb6cdd5ead014c044215d8ce1807",
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
      screen.getByRole("switch", { name: "Enable auto-reinstall" }),
    ).not.toBeChecked();
    expect(screen.getByText("Update available")).toBeInTheDocument();
    expect(screen.getByText("Last reinstalled")).toBeInTheDocument();
    expect(screen.getByText("sha256:f89c25ff172c")).toBeInTheDocument();
    expect(screen.getByText("sha256:a0c8fadf9a64")).toBeInTheDocument();
    expect(screen.getByText("Never")).toBeInTheDocument();
  });

  it("renders restart_triggered as pending", () => {
    render(
      <McpImageUpdateSettings
        variant="local"
        installs={[
          makeServer({
            imageUpdateState: {
              mcpServerId: "server-1",
              lastCheckedAt: null,
              runningImageDigest: null,
              availableImageDigest: null,
              status: "restart_triggered",
              lastRestartedAt: null,
              updatedAt: "2026-01-02T03:04:05.000Z",
            },
          }),
        ]}
      />,
    );

    expect(screen.getByText("Pending")).toBeInTheDocument();
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

  it("sends a settings update when auto-reinstall is toggled", async () => {
    const user = userEvent.setup();
    render(
      <McpImageUpdateSettings
        variant="local"
        installs={[makeServer({ imageUpdateAutoRestartEnabled: false })]}
      />,
    );

    await user.click(
      screen.getByRole("switch", { name: "Enable auto-reinstall" }),
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
    imageUpdateCheckEnabled: true,
    imageUpdateAutoRestartEnabled: true,
    imageUpdateState: null,
    ...overrides,
  };
}
