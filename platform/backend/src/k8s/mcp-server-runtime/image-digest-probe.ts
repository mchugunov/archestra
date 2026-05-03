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
}

export interface ResolveAvailableImageDigestProbeOptions {
  image: string;
  imagePullSecrets?: ResolvedImagePullSecretName[];
  nodeSelector?: k8s.V1PodSpec["nodeSelector"] | null;
  tolerations?: k8s.V1Toleration[] | null;
  serviceAccountName?: string | null;
  timeoutMs?: number;
  pollIntervalMs?: number;
}

export interface K8sImageDigestProbeOptions {
  k8sApi: k8s.CoreV1Api;
  namespace: string;
  mcpServer: McpServer;
}

export interface ImageDigestProbePodSpecOptions {
  image: string;
  podName: string;
  namespace: string;
  mcpServer: McpServer;
  imagePullSecrets?: ResolvedImagePullSecretName[];
  nodeSelector?: k8s.V1PodSpec["nodeSelector"] | null;
  tolerations?: k8s.V1Toleration[] | null;
  serviceAccountName?: string | null;
  activeDeadlineSeconds?: number;
}

export class K8sImageDigestProbe implements ImageDigestProbe {
  private static readonly CONTAINER_NAME = "mcp-image-digest-probe";
  private static readonly DEFAULT_TIMEOUT_MS = TimeInMs.Second * 60;
  private static readonly DEFAULT_POLL_INTERVAL_MS = TimeInMs.Second;

  private readonly k8sApi: k8s.CoreV1Api;
  private readonly namespace: string;
  private readonly mcpServer: McpServer;

  constructor(options: K8sImageDigestProbeOptions) {
    this.k8sApi = options.k8sApi;
    this.namespace = options.namespace;
    this.mcpServer = options.mcpServer;
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
    const podName = this.constructPodName(options.image);

    await this.k8sApi.createNamespacedPod({
      namespace: this.namespace,
      body: K8sImageDigestProbe.generatePodSpec({
        image: options.image,
        podName,
        namespace: this.namespace,
        mcpServer: this.mcpServer,
        imagePullSecrets: options.imagePullSecrets,
        nodeSelector: options.nodeSelector,
        tolerations: options.tolerations,
        serviceAccountName: options.serviceAccountName,
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
      await this.deletePod(podName);
    }
  }

  /**
   * Generate a short-lived pod that asks Kubernetes to resolve an image digest.
   */
  static generatePodSpec(options: ImageDigestProbePodSpecOptions): k8s.V1Pod {
    const labels = sanitizeMetadataLabels({
      app: "mcp-image-digest-probe",
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
            imagePullPolicy: K8sImageDigestProbe.getImagePullPolicy(
              options.image,
            ),
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

  private static getImagePullPolicy(
    image: string,
  ): k8s.V1Container["imagePullPolicy"] | undefined {
    return isDigestPinnedImage(image) ? undefined : "Always";
  }

  private constructPodName(image: string): string {
    const sanitizedId =
      ensureStringIsRfc1123Compliant(this.mcpServer.id).slice(0, 48) ||
      "server";
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
      const digest = K8sImageDigestProbe.getPodImageDigest(pod);
      if (digest) {
        return digest;
      }

      const pullFailureMessage =
        K8sImageDigestProbe.getPodPullFailureMessage(pod);
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

  private static getPodImageDigest(pod: k8s.V1Pod): string | null {
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

  private static getPodPullFailureMessage(pod: k8s.V1Pod): string | null {
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

  private async deletePod(podName: string): Promise<void> {
    try {
      await this.k8sApi.deleteNamespacedPod({
        name: podName,
        namespace: this.namespace,
      });
    } catch (error) {
      if (isK8sNotFoundError(error)) {
        logger.debug(
          {
            mcpServerId: this.mcpServer.id,
            podName,
            namespace: this.namespace,
          },
          "MCP image digest probe pod was already deleted",
        );
        return;
      }

      logger.warn(
        {
          err: error,
          mcpServerId: this.mcpServer.id,
          podName,
          namespace: this.namespace,
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
