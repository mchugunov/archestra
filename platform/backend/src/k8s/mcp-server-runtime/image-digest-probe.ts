import { createHash, randomUUID } from "node:crypto";
import type * as k8s from "@kubernetes/client-node";
import { TimeInMs } from "@shared";
import {
  ensureStringIsRfc1123Compliant,
  isK8sNotFoundError,
  sanitizeMetadataLabels,
} from "@/k8s/shared";
import logger from "@/logging";
import type { McpServer } from "@/types";
import { isDigestPinnedImage, normalizeImageDigest } from "./image-digest";
import type { ResolvedImagePullSecretName } from "./image-pull-secrets";

export interface ImageDigestProbe {
  resolveAvailableImageDigest(
    options: ResolveAvailableImageDigestProbeOptions,
  ): Promise<string>;

  cleanupStaleProbePods(): Promise<void>;
}

export interface ResolveAvailableImageDigestProbeOptions {
  mcpServer: McpServer;
  image: string;
  imagePullSecrets?: ResolvedImagePullSecretName[];
  nodeSelector?: k8s.V1PodSpec["nodeSelector"] | null;
  tolerations?: k8s.V1Toleration[] | null;
  serviceAccountName?: string | null;
  runtimeClassName?: string | null;
  timeoutMs?: number;
  pollIntervalMs?: number;
}

interface ImageDigestProbePodSpecOptions {
  image: string;
  podName: string;
  namespace: string;
  mcpServer: McpServer;
  imagePullSecrets?: ResolvedImagePullSecretName[];
  nodeSelector?: k8s.V1PodSpec["nodeSelector"] | null;
  tolerations?: k8s.V1Toleration[] | null;
  serviceAccountName?: string | null;
  runtimeClassName?: string | null;
  activeDeadlineSeconds?: number;
}

export class K8sImageDigestProbe implements ImageDigestProbe {
  private static readonly CONTAINER_NAME = "mcp-image-digest-probe";
  private static readonly PROBE_LABEL_SELECTOR =
    `app=${K8sImageDigestProbe.CONTAINER_NAME}`;
  private static readonly DEFAULT_TIMEOUT_MS = TimeInMs.Second * 60;
  private static readonly DEFAULT_POLL_INTERVAL_MS = TimeInMs.Second;
  private static readonly DEFAULT_STALE_PROBE_POD_TTL_MS = TimeInMs.Minute * 15;

  private readonly k8sApi: k8s.CoreV1Api;
  private readonly namespace: string;

  constructor(k8sApi: k8s.CoreV1Api, namespace: string) {
    this.k8sApi = k8sApi;
    this.namespace = namespace;
  }

  /**
   * Resolve the digest Kubernetes would currently pull for the target image.
   */
  async resolveAvailableImageDigest(
    options: ResolveAvailableImageDigestProbeOptions,
  ): Promise<string> {
    const timeoutMs =
      options.timeoutMs ?? K8sImageDigestProbe.DEFAULT_TIMEOUT_MS;
    const pollIntervalMs =
      options.pollIntervalMs ?? K8sImageDigestProbe.DEFAULT_POLL_INTERVAL_MS;
    const podName = this.constructPodName(options.image, options.mcpServer);

    await this.k8sApi.createNamespacedPod({
      namespace: this.namespace,
      body: this.generatePodSpec({
        image: options.image,
        podName,
        namespace: this.namespace,
        mcpServer: options.mcpServer,
        imagePullSecrets: options.imagePullSecrets,
        nodeSelector: options.nodeSelector,
        tolerations: options.tolerations,
        serviceAccountName: options.serviceAccountName,
        runtimeClassName: options.runtimeClassName,
        activeDeadlineSeconds: Math.ceil(timeoutMs / TimeInMs.Second) + 5,
      }),
    });

    try {
      return await this.waitForImageDigest({
        podName,
        image: options.image,
        timeoutMs,
        pollIntervalMs,
      });
    } finally {
      await this.deletePod({
        podName,
        mcpServerId: options.mcpServer.id,
      });
    }
  }

  async cleanupStaleProbePods(): Promise<void> {
    const nowMs = Date.now();
    const olderThanMs = K8sImageDigestProbe.DEFAULT_STALE_PROBE_POD_TTL_MS;
    let pods: k8s.V1PodList;

    try {
      pods = await this.k8sApi.listNamespacedPod({
        namespace: this.namespace,
        labelSelector: K8sImageDigestProbe.PROBE_LABEL_SELECTOR,
      });
    } catch (error) {
      logger.warn(
        {
          err: error,
          namespace: this.namespace,
          labelSelector: K8sImageDigestProbe.PROBE_LABEL_SELECTOR,
          olderThanMs,
        },
        "Failed to list stale MCP image digest probe pods",
      );
      return;
    }

    for (const pod of pods.items) {
      const podName = pod.metadata?.name;
      const creationTimestamp = pod.metadata?.creationTimestamp;
      if (!podName || !creationTimestamp) {
        continue;
      }

      const createdAtMs = new Date(creationTimestamp).getTime();
      if (!Number.isFinite(createdAtMs)) {
        continue;
      }

      const podAgeMs = nowMs - createdAtMs;
      if (podAgeMs < olderThanMs) {
        continue;
      }

      await this.deletePod({
        podName,
        podAgeMs,
        olderThanMs,
      });
    }
  }

  private generatePodSpec(options: ImageDigestProbePodSpecOptions): k8s.V1Pod {
    const labels = sanitizeMetadataLabels({
      app: K8sImageDigestProbe.CONTAINER_NAME,
      "mcp-server-probe-id": options.mcpServer.id,
      "mcp-server-name": options.mcpServer.name,
    });

    return {
      apiVersion: "v1",
      kind: "Pod",
      metadata: {
        name: options.podName,
        namespace: options.namespace,
        labels,
      },
      spec: {
        restartPolicy: "Never",
        terminationGracePeriodSeconds: 0,
        enableServiceLinks: false,
        automountServiceAccountToken: false,
        ...(options.activeDeadlineSeconds
          ? { activeDeadlineSeconds: options.activeDeadlineSeconds }
          : {}),
        ...(options.serviceAccountName
          ? { serviceAccountName: options.serviceAccountName }
          : {}),
        ...(options.runtimeClassName
          ? { runtimeClassName: options.runtimeClassName }
          : {}),
        ...(options.nodeSelector && Object.keys(options.nodeSelector).length > 0
          ? { nodeSelector: options.nodeSelector }
          : {}),
        ...(options.tolerations?.length
          ? { tolerations: options.tolerations }
          : {}),
        ...(options.imagePullSecrets?.length
          ? { imagePullSecrets: options.imagePullSecrets }
          : {}),
        containers: [
          {
            name: K8sImageDigestProbe.CONTAINER_NAME,
            image: options.image,
            command: ["/bin/true"],
            imagePullPolicy: this.getImagePullPolicy(options.image),
            resources: {
              requests: {
                cpu: "10m",
                memory: "16Mi",
              },
            },
          },
        ],
      },
    };
  }

  private getImagePullPolicy(
    image: string,
  ): k8s.V1Container["imagePullPolicy"] | undefined {
    return isDigestPinnedImage(image) ? undefined : "Always";
  }

  private constructPodName(image: string, mcpServer: McpServer) {
    const sanitizedId =
      ensureStringIsRfc1123Compliant(mcpServer.id).slice(0, 48) || "server";
    const imageHash = createHash("sha256")
      .update(image)
      .digest("hex")
      .slice(0, 12);
    const suffix = randomUUID().replace(/-/g, "").slice(0, 12);

    return `mcp-image-probe-${sanitizedId}-${imageHash}-${suffix}`;
  }

  private async waitForImageDigest(options: {
    podName: string;
    image: string;
    timeoutMs: number;
    pollIntervalMs: number;
  }): Promise<string> {
    const deadline = Date.now() + options.timeoutMs;

    do {
      const pod = await this.k8sApi.readNamespacedPod({
        name: options.podName,
        namespace: this.namespace,
      });
      const digest = this.getPodImageDigest(pod);
      if (digest) {
        return digest;
      }

      const pullFailureMessage = this.getPodPullFailureMessage(pod);
      if (pullFailureMessage) {
        throw new Error(
          `Failed to resolve image digest for ${options.image}: ${pullFailureMessage}`,
        );
      }

      await sleep(options.pollIntervalMs);
    } while (Date.now() <= deadline);

    throw new Error(
      `Timed out resolving image digest for ${options.image} after ${options.timeoutMs}ms`,
    );
  }

  private getPodImageDigest(pod: k8s.V1Pod): string | null {
    const containerStatus = pod.status?.containerStatuses?.find(
      (status) => status.name === K8sImageDigestProbe.CONTAINER_NAME,
    );
    if (!containerStatus?.imageID) {
      return null;
    }

    const digest = normalizeImageDigest(containerStatus.imageID);
    if (!digest) {
      throw new Error(
        `Probe pod image ID did not contain a sha256 digest: ${containerStatus.imageID}`,
      );
    }

    return digest;
  }

  private getPodPullFailureMessage(pod: k8s.V1Pod): string | null {
    const containerStatus = pod.status?.containerStatuses?.find(
      (status) => status.name === K8sImageDigestProbe.CONTAINER_NAME,
    );
    const waiting = containerStatus?.state?.waiting;
    if (!waiting?.reason) {
      return null;
    }

    if (!IMAGE_DIGEST_PROBE_PULL_FAILURE_REASONS.has(waiting.reason)) {
      return null;
    }

    return waiting.message
      ? `${waiting.reason} - ${waiting.message}`
      : waiting.reason;
  }

  private async deletePod(options: {
    podName: string;
    mcpServerId?: string;
    podAgeMs?: number;
    olderThanMs?: number;
  }): Promise<void> {
    const logContext = {
      ...(options.mcpServerId ? { mcpServerId: options.mcpServerId } : {}),
      podName: options.podName,
      namespace: this.namespace,
      ...(options.podAgeMs !== undefined ? { podAgeMs: options.podAgeMs } : {}),
      ...(options.olderThanMs !== undefined
        ? { olderThanMs: options.olderThanMs }
        : {}),
    };

    try {
      await this.k8sApi.deleteNamespacedPod({
        name: options.podName,
        namespace: this.namespace,
      });
      if (options.podAgeMs !== undefined) {
        logger.debug(logContext, "Deleted stale MCP image digest probe pod");
      }
    } catch (error) {
      if (isK8sNotFoundError(error)) {
        logger.debug(
          logContext,
          "MCP image digest probe pod was already deleted",
        );
        return;
      }

      logger.warn(
        {
          err: error,
          ...logContext,
        },
        "Failed to delete MCP image digest probe pod",
      );
    }
  }
}

const IMAGE_DIGEST_PROBE_PULL_FAILURE_REASONS = new Set([
  "ErrImagePull",
  "ImagePullBackOff",
  "ErrImageNeverPull",
  "InvalidImageName",
]);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
