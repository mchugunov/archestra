"use client";

import type { archestraApiTypes } from "@shared";
import { format } from "date-fns";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
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
  | "scope"
  | "ownerEmail"
  | "teamDetails"
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
    <Card className="gap-4 py-4">
      <CardHeader className="gap-1 px-5">
        <CardTitle className="text-base">Image updates</CardTitle>
        <CardDescription>
          Track container image freshness for local MCP server deployments.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 px-5">
        {variant !== "local" && (
          <UnavailableState message="Image update checks are available for local MCP server deployments only." />
        )}

        {variant === "local" && localInstalls.length === 0 && (
          <UnavailableState message="Install this local server to enable image update checks." />
        )}

        {variant === "local" &&
          localInstalls.map((server) => (
            <div
              key={server.id}
              className="space-y-4 rounded-lg border bg-muted/20 p-4"
            >
              <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                <div className="min-w-0">
                  <TruncatedTooltip content={server.name}>
                    <div className="truncate text-sm font-medium">
                      {server.name}
                    </div>
                  </TruncatedTooltip>
                  <div className="mt-1 text-xs text-muted-foreground">
                    {formatScope(server)}
                  </div>
                </div>
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
                  id={`image-update-auto-restart-${server.id}`}
                  label="Enable auto-restart"
                  description="Restart the deployment automatically when a newer digest is detected."
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
                  value={formatTimestamp(
                    server.imageUpdateState?.lastCheckedAt,
                  )}
                />
                <ImageUpdateStateItem
                  label="Last restarted"
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
              </dl>
            </div>
          ))}
      </CardContent>
    </Card>
  );
}

function UnavailableState({ message }: { message: string }) {
  return <p className="text-sm text-muted-foreground">{message}</p>;
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

function formatTimestamp(value?: string | null, fallback = "Not checked yet") {
  if (!value) {
    return <span className="text-muted-foreground">{fallback}</span>;
  }

  return format(new Date(value), "PPp");
}

function formatScope(server: McpImageUpdateSettingsInstall) {
  if (server.teamDetails) {
    return `Team: ${server.teamDetails.name}`;
  }
  if (server.ownerEmail) {
    return `Personal: ${server.ownerEmail}`;
  }
  if (server.scope === "org") {
    return "Organization";
  }
  return "Installation";
}

function shortenDigest(value: string) {
  if (value.length <= 32) {
    return value;
  }
  return `${value.slice(0, 29)}...`;
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
  restart_triggered: {
    label: "Restart triggered",
    variant: "default",
    className: "bg-blue-600 text-white",
  },
} as const satisfies Record<
  ImageUpdateStatus,
  {
    label: string;
    variant: "default" | "secondary" | "outline";
    className?: string;
  }
>;
