"use client";

import type { archestraApiTypes } from "@shared";
import { format } from "date-fns";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { TruncatedTooltip } from "@/components/ui/truncated-tooltip";
import { useUpdateMcpServerImageUpdateSettings } from "@/lib/mcp/mcp-server.query";

type InstalledMcpServer =
  archestraApiTypes.GetMcpServersResponses["200"][number];
export type McpImageUpdateSettingsInstall = Pick<
  InstalledMcpServer,
  | "id"
  | "name"
  | "serverType"
  | "imageUpdateCheckEnabled"
  | "imageUpdateAutoRestartEnabled"
  | "imageUpdateState"
> & { presetLabel?: string | null };
type ImageUpdateStatus = NonNullable<
  NonNullable<InstalledMcpServer["imageUpdateState"]>["status"]
>;

interface McpImageUpdateSettingsProps {
  installs: McpImageUpdateSettingsInstall[];
  variant: "remote" | "local" | "builtin";
}

export function McpImageUpdateSettings({
  installs,
  variant,
}: McpImageUpdateSettingsProps) {
  const updateMutation = useUpdateMcpServerImageUpdateSettings();
  const localInstalls = installs.filter(
    (install) => install.serverType === "local",
  );

  return (
    <div className="space-y-4 rounded-lg border p-4">
      {variant !== "local" && (
        <UnavailableState message="Image update checks are available for local MCP server deployments only." />
      )}

      {variant === "local" && localInstalls.length === 0 && (
        <UnavailableState message="Install this local server to enable image update checks." />
      )}

      {variant === "local" &&
        localInstalls.map((server, index) => (
          <div
            key={server.id}
            className={index === 0 ? "space-y-4" : "space-y-4 border-t pt-4"}
          >
            <div className="flex items-center justify-between gap-4">
              <Label>Image status</Label>
              <ImageUpdateStatusBadge
                status={server.imageUpdateState?.status}
              />
            </div>

            <div className="grid gap-3 md:grid-cols-2">
              <ImageUpdateSwitch
                id={`image-update-check-${server.id}`}
                label="Enable image update checks"
                description="Periodically compare the running image digest with the registry digest."
                checked={server.imageUpdateCheckEnabled}
                disabled={updateMutation.isPending}
                onCheckedChange={(checked) =>
                  updateMutation.mutate({
                    id: server.id,
                    name: server.name,
                    imageUpdateCheckEnabled: checked,
                  })
                }
              />
              <ImageUpdateSwitch
                id={`image-update-auto-reinstall-${server.id}`}
                label="Enable auto-reinstall"
                description="Reinstall and resync tools automatically when a newer digest is detected."
                checked={server.imageUpdateAutoRestartEnabled}
                disabled={updateMutation.isPending}
                onCheckedChange={(checked) =>
                  updateMutation.mutate({
                    id: server.id,
                    name: server.name,
                    imageUpdateAutoRestartEnabled: checked,
                  })
                }
              />
            </div>

            <dl className="grid gap-x-4 gap-y-3 text-sm md:grid-cols-2">
              <ImageUpdateStateItem
                label="Last checked"
                value={formatTimestamp(server.imageUpdateState?.lastCheckedAt)}
              />
              <ImageUpdateStateItem
                label="Last successful"
                value={formatTimestamp(
                  server.imageUpdateState?.lastSuccessfulCheckedAt,
                  "Never",
                )}
              />
              <ImageUpdateStateItem
                label="Last reinstalled"
                value={formatTimestamp(
                  server.imageUpdateState?.lastRestartedAt,
                  "Never",
                )}
              />
              <ImageUpdateStateItem
                label="Running digest"
                value={
                  <DigestValue
                    value={server.imageUpdateState?.runningImageDigest}
                  />
                }
              />
              <ImageUpdateStateItem
                label="Available digest"
                value={
                  <DigestValue
                    value={server.imageUpdateState?.availableImageDigest}
                  />
                }
              />
              {isFailureStatus(server.imageUpdateState?.status) && (
                <>
                  <ImageUpdateStateItem
                    label="Last failed"
                    value={formatTimestamp(
                      server.imageUpdateState.lastFailedAt,
                      "Never",
                    )}
                  />
                  <ImageUpdateStateItem
                    label="Consecutive failures"
                    value={server.imageUpdateState.consecutiveFailureCount}
                  />
                  <ImageUpdateStateItem
                    label="Last error"
                    value={
                      <FailureMessage
                        category={server.imageUpdateState.lastErrorCategory}
                        message={server.imageUpdateState.lastErrorMessage}
                      />
                    }
                  />
                </>
              )}
            </dl>
          </div>
        ))}
    </div>
  );
}

function UnavailableState({ message }: { message: string }) {
  return <p className="text-sm text-muted-foreground">{message}</p>;
}

function isFailureStatus(status?: ImageUpdateStatus) {
  return status === "check_failed" || status === "rollout_failed";
}

function ImageUpdateSwitch({
  id,
  label,
  description,
  checked,
  disabled,
  onCheckedChange,
}: {
  id: string;
  label: string;
  description: string;
  checked: boolean;
  disabled: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <div className="flex items-start justify-between gap-4 rounded-md border bg-background p-3">
      <div className="space-y-1">
        <Label htmlFor={id}>{label}</Label>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      <Switch
        id={id}
        checked={checked}
        disabled={disabled}
        onCheckedChange={onCheckedChange}
      />
    </div>
  );
}

function ImageUpdateStatusBadge({ status }: { status?: ImageUpdateStatus }) {
  const config = STATUS_CONFIG[status ?? "unknown"];

  return (
    <Badge variant={config.variant} className={config.className}>
      {config.label}
    </Badge>
  );
}

function ImageUpdateStateItem({
  label,
  value,
}: {
  label: string;
  value: React.ReactNode;
}) {
  return (
    <div className="min-w-0">
      <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
      <dd className="mt-1 min-w-0 text-foreground">{value}</dd>
    </div>
  );
}

function DigestValue({ value }: { value?: string | null }) {
  if (!value) {
    return <span className="text-muted-foreground">Unavailable</span>;
  }

  return (
    <TruncatedTooltip content={value}>
      <span className="block truncate font-mono text-xs">
        {shortenDigest(value)}
      </span>
    </TruncatedTooltip>
  );
}

function FailureMessage({
  category,
  message,
}: {
  category?: string | null;
  message?: string | null;
}) {
  const displayMessage = message || "Image update check failed.";

  return (
    <TruncatedTooltip content={displayMessage}>
      <span className="block truncate text-xs">
        {category ? `${category}: ${displayMessage}` : displayMessage}
      </span>
    </TruncatedTooltip>
  );
}

function formatTimestamp(value?: string | null, fallback = "Not checked yet") {
  if (!value) {
    return <span className="text-muted-foreground">{fallback}</span>;
  }

  return format(new Date(value), "PPp");
}

function shortenDigest(value: string) {
  const digestPrefix = "sha256:";
  const digestStart = value.indexOf(digestPrefix);
  if (digestStart === -1) {
    return value;
  }

  const hash = value.slice(digestStart + digestPrefix.length);
  return `${digestPrefix}${hash.slice(0, 12)}`;
}

const STATUS_CONFIG = {
  unknown: {
    label: "Unknown",
    variant: "outline",
    className: undefined,
  },
  up_to_date: {
    label: "Up to date",
    variant: "secondary",
    className: undefined,
  },
  update_available: {
    label: "Update available",
    variant: "default",
    className: "bg-amber-600 text-white",
  },
  reinstalling: {
    label: "Reinstalling",
    variant: "default",
    className: "bg-blue-600 text-white",
  },
  restart_triggered: {
    label: "Pending",
    variant: "default",
    className: "bg-blue-600 text-white",
  },
  rollout_failed: {
    label: "Rollout failed",
    variant: "default",
    className: "bg-destructive text-destructive-foreground",
  },
  check_failed: {
    label: "Check failed",
    variant: "default",
    className: "bg-destructive text-destructive-foreground",
  },
} as const satisfies Record<
  ImageUpdateStatus,
  {
    label: string;
    variant: "default" | "secondary" | "outline";
    className?: string;
  }
>;
