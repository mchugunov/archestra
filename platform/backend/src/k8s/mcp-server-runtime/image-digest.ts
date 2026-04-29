export const MCP_SERVER_CONTAINER_NAME = "mcp-server";

export function normalizeImageDigest(
  imageId: string | null | undefined,
): string | null {
  const trimmed = imageId?.trim();
  if (!trimmed) {
    return null;
  }

  const match = trimmed.match(/(?:^|@|:\/\/)(sha256:[a-z0-9._-]+)/i);
  if (!match) {
    return null;
  }

  const [algorithm, digest] = match[1].split(":", 2);
  return `${algorithm.toLowerCase()}:${digest}`;
}

export function isDigestPinnedImage(image: string | null | undefined): boolean {
  return image?.includes("@sha256:") ?? false;
}
