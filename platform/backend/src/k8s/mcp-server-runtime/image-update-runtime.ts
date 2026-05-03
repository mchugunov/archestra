export type ResolveAvailableImageDigestRuntimeParams = {
  mcpServerId: string;
  image: string;
  options?: {
    timeoutMs?: number;
  };
};

export interface ImageUpdateRuntime {
  getRunningImageDigest(mcpServerId: string): Promise<string | null>;

  resolveAvailableImageDigest(
    params: ResolveAvailableImageDigestRuntimeParams,
  ): Promise<string | null>;
}
