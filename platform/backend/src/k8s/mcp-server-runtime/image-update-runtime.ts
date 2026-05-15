export type ResolveAvailableImageDigestRuntimeParams = {
  mcpServerId: string;
  image: string;
  options?: {
    timeoutMs?: number;
  };
};

export interface ImageUpdateRuntime {
  prepareImageUpdateCheck(): Promise<void>;

  getRunningImageDigest(mcpServerId: string): Promise<string | null>;

  resolveAvailableImageDigest(
    params: ResolveAvailableImageDigestRuntimeParams,
  ): Promise<string | null>;
}
