export interface ImageUpdateRuntime {
  getRunningImageDigest(mcpServerId: string): Promise<string | null>;
  resolveAvailableImageDigest(
    mcpServerId: string,
    image: string,
  ): Promise<string | null>;
}
