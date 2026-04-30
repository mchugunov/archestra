export type ResolveAvailableImageDigestRuntimeOptions = {
  timeoutMs?: number;
};

export type ResolveAvailableImageDigestRuntimeParams = {
  mcpServerId: string;
  image: string;
  options?: ResolveAvailableImageDigestRuntimeOptions;
};

export interface ImageUpdateRuntime {
  getRunningImageDigest(mcpServerId: string): Promise<string | null>;

  resolveAvailableImageDigest(
    params: ResolveAvailableImageDigestRuntimeParams,
  ): Promise<string | null>;

  rolloutRestartServer(mcpServerId: string): Promise<void>;
}
