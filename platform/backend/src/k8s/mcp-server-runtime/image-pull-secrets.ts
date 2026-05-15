import type { ImagePullSecretConfig } from "@shared";
import { secretManager } from "@/secrets-manager";
import type { InternalMcpCatalog } from "@/types";

export type ResolvedImagePullSecretName = { name: string };

export const collectImagePullSecretNames = (
  imagePullSecrets: ImagePullSecretConfig[] | undefined,
  generatedRegcredNames: string[],
): ResolvedImagePullSecretName[] => {
  const names: ResolvedImagePullSecretName[] = [];

  if (imagePullSecrets) {
    for (const entry of imagePullSecrets) {
      if (entry.source === "existing") {
        names.push({ name: entry.name });
      }
    }
  }

  for (const name of generatedRegcredNames) {
    names.push({ name });
  }

  return names;
};

// Create docker-registry secrets for imagePullSecrets with credentials
// and resolve all imagePullSecrets names for the pod spec.
// Regcred passwords are stored in the catalog's localConfigSecretId, not
// the per-user mcpServer.secretId, so fetch them separately.
export const resolveMcpImagePullSecretNames = async (
  catalogItem: InternalMcpCatalog | null | undefined,
  createDockerRegistrySecrets: (
    secretData: Record<string, string>,
    imagePullSecrets?: ImagePullSecretConfig[],
  ) => Promise<string[]>,
): Promise<ResolvedImagePullSecretName[]> => {
  const imagePullSecrets = catalogItem?.localConfig?.imagePullSecrets;
  const regcredSecretData = await getRegcredSecretData(catalogItem);
  const generatedRegcredNames = await createDockerRegistrySecrets(
    regcredSecretData,
    imagePullSecrets,
  );

  return collectImagePullSecretNames(imagePullSecrets, generatedRegcredNames);
};

async function getRegcredSecretData(
  catalogItem: InternalMcpCatalog | null | undefined,
): Promise<Record<string, string>> {
  const imagePullSecrets = catalogItem?.localConfig?.imagePullSecrets;
  if (!catalogItem?.localConfigSecretId || !imagePullSecrets?.length) {
    return {};
  }

  const catalogSecret = await secretManager().getSecret(
    catalogItem.localConfigSecretId,
  );
  const secretData: Record<string, string> = {};

  if (catalogSecret?.secret && typeof catalogSecret.secret === "object") {
    for (const [key, value] of Object.entries(catalogSecret.secret)) {
      if (key.startsWith("__regcred_password:")) {
        secretData[key] = String(value);
      }
    }
  }

  return secretData;
}
