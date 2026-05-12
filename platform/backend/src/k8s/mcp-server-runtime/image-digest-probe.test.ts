import type * as k8s from "@kubernetes/client-node";
import { vi } from "vitest";
import logger from "@/logging";
import { beforeEach, describe, expect, test } from "@/test";
import type { McpServer } from "@/types";
import { K8sImageDigestProbe } from "./image-digest-probe";

vi.mock("@/logging", () => {
  const mockedLogger = {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn(),
  };
  mockedLogger.child.mockReturnValue(mockedLogger);

  return {
    default: mockedLogger,
  };
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe("K8sImageDigestProbe.resolveAvailableImageDigest", () => {
  test("generates a short-lived probe pod for a tag-based image", async () => {
    const { resolveAvailableImageDigest, k8sApi } = createProbe({
      mcpServer: createMcpServer({
        id: "server-123",
        name: "Probe Server",
      }),
    });

    await expect(
      resolveAvailableImageDigest({
        image: "ghcr.io/example/mcp-server:1.2.3",
        imagePullSecrets: [{ name: "registry-secret" }],
        nodeSelector: { "node-pool": "mcp" },
        tolerations: [
          {
            key: "workload",
            operator: "Equal",
            value: "mcp",
            effect: "NoSchedule",
          },
        ],
        serviceAccountName: "mcp-runner",
        runtimeClassName: "mcp-runtime",
        timeoutMs: 60_000,
      }),
    ).resolves.toBe("sha256:abc123");

    const pod = k8sApi.createNamespacedPod.mock.calls[0]?.[0].body;
    expect(pod.metadata).toMatchObject({
      namespace: "archestra-runtime",
      labels: {
        app: "mcp-image-digest-probe",
        "mcp-server-probe-id": "server-123",
        "mcp-server-name": "probe-server",
      },
    });
    expect(pod.metadata?.name).toMatch(
      /^mcp-image-probe-server-123-[a-f0-9]{12}-/,
    );
    expect(pod.metadata?.labels?.["mcp-server-id"]).toBeUndefined();
    expect(pod.spec).toMatchObject({
      restartPolicy: "Never",
      terminationGracePeriodSeconds: 0,
      enableServiceLinks: false,
      automountServiceAccountToken: false,
      activeDeadlineSeconds: 65,
      serviceAccountName: "mcp-runner",
      runtimeClassName: "mcp-runtime",
      imagePullSecrets: [{ name: "registry-secret" }],
      nodeSelector: { "node-pool": "mcp" },
      tolerations: [
        {
          key: "workload",
          operator: "Equal",
          value: "mcp",
          effect: "NoSchedule",
        },
      ],
    });
    expect(pod.spec?.containers).toEqual([
      expect.objectContaining({
        name: "mcp-image-digest-probe",
        image: "ghcr.io/example/mcp-server:1.2.3",
        command: ["/bin/true"],
        imagePullPolicy: "Always",
      }),
    ]);
  });

  test("omits optional pod fields and pull policy for digest-pinned images", async () => {
    const { resolveAvailableImageDigest, k8sApi } = createProbe();

    await expect(
      resolveAvailableImageDigest({
        image: "ghcr.io/example/mcp-server@sha256:abc123",
        imagePullSecrets: [],
        nodeSelector: {},
        tolerations: [],
        serviceAccountName: null,
        runtimeClassName: null,
        timeoutMs: -5_000,
        pollIntervalMs: 0,
      }),
    ).resolves.toBe("sha256:abc123");

    const pod = k8sApi.createNamespacedPod.mock.calls[0]?.[0].body;
    expect(pod.spec?.activeDeadlineSeconds).toBeUndefined();
    expect(pod.spec?.serviceAccountName).toBeUndefined();
    expect(pod.spec?.imagePullSecrets).toBeUndefined();
    expect(pod.spec?.nodeSelector).toBeUndefined();
    expect(pod.spec?.tolerations).toBeUndefined();
    expect(pod.spec?.runtimeClassName).toBeUndefined();
    expect(pod.spec?.containers[0].imagePullPolicy).toBeUndefined();
  });

  test("does not include workload-only pod fields", async () => {
    const { resolveAvailableImageDigest, k8sApi } = createProbe();

    await expect(
      resolveAvailableImageDigest({
        image: "ghcr.io/example/mcp-server:1.2.3",
      }),
    ).resolves.toBe("sha256:abc123");

    const pod = k8sApi.createNamespacedPod.mock.calls[0]?.[0].body;
    expect(pod.spec?.volumes).toBeUndefined();
    expect(pod.spec?.containers[0].env).toBeUndefined();
    expect(pod.spec?.containers[0].envFrom).toBeUndefined();
    expect(pod.spec?.containers[0].volumeMounts).toBeUndefined();
    expect(pod.spec?.containers[0].ports).toBeUndefined();
  });

  test("creates a probe pod, reads the resolved digest, and deletes the pod", async () => {
    const { resolveAvailableImageDigest, k8sApi } = createProbe();

    await expect(
      resolveAvailableImageDigest({
        image: "ghcr.io/example/server:latest",
        imagePullSecrets: [{ name: "registry-secret" }],
        nodeSelector: { "node-pool": "mcp" },
        tolerations: [{ key: "workload", operator: "Exists" }],
        serviceAccountName: "mcp-runner",
        runtimeClassName: "mcp-runtime",
      }),
    ).resolves.toBe("sha256:abc123");

    expect(k8sApi.createNamespacedPod).toHaveBeenCalledWith({
      namespace: "archestra-runtime",
      body: expect.objectContaining({
        metadata: expect.objectContaining({
          name: expect.stringMatching(/^mcp-image-probe-srv-123-[a-f0-9]{12}-/),
          namespace: "archestra-runtime",
        }),
        spec: expect.objectContaining({
          activeDeadlineSeconds: 65,
          imagePullSecrets: [{ name: "registry-secret" }],
          nodeSelector: { "node-pool": "mcp" },
          serviceAccountName: "mcp-runner",
          runtimeClassName: "mcp-runtime",
          tolerations: [{ key: "workload", operator: "Exists" }],
        }),
      }),
    });
    const podName =
      k8sApi.createNamespacedPod.mock.calls[0]?.[0].body.metadata?.name;
    expect(k8sApi.readNamespacedPod).toHaveBeenCalledWith({
      name: podName,
      namespace: "archestra-runtime",
    });
    expect(k8sApi.deleteNamespacedPod).toHaveBeenCalledWith({
      name: podName,
      namespace: "archestra-runtime",
    });
  });

  test("uses server fallback in probe pod name when server ID sanitizes to empty", async () => {
    const { resolveAvailableImageDigest, k8sApi } = createProbe({
      mcpServer: createMcpServer({ id: "!!!", name: "Probe Server" }),
    });

    await expect(
      resolveAvailableImageDigest({
        image: "ghcr.io/example/server:latest",
      }),
    ).resolves.toBe("sha256:abc123");

    expect(
      k8sApi.createNamespacedPod.mock.calls[0]?.[0].body.metadata?.name,
    ).toMatch(/^mcp-image-probe-server-[a-f0-9]{12}-/);
  });

  test("polls until the probe pod image ID is available", async () => {
    const { resolveAvailableImageDigest, k8sApi } = createProbe({
      readPods: [
        createProbePod({
          containerStatus: {
            name: "mcp-image-digest-probe",
          },
        }),
        createProbePod({
          imageID: "containerd://sha256:def456",
        }),
      ],
    });

    await expect(
      resolveAvailableImageDigest({
        image: "ghcr.io/example/server:latest",
        timeoutMs: 1_000,
        pollIntervalMs: 0,
      }),
    ).resolves.toBe("sha256:def456");

    expect(k8sApi.readNamespacedPod).toHaveBeenCalledTimes(2);
    expect(
      k8sApi.createNamespacedPod.mock.calls[0]?.[0].body.spec,
    ).toMatchObject({
      activeDeadlineSeconds: 6,
    });
  });

  test("times out when the probe pod never exposes an image ID", async () => {
    const { resolveAvailableImageDigest, k8sApi } = createProbe({
      readPods: [
        createProbePod({
          containerStatus: {
            name: "unrelated-container",
          },
        }),
      ],
    });

    await expect(
      resolveAvailableImageDigest({
        image: "ghcr.io/example/server:latest",
        timeoutMs: -1,
        pollIntervalMs: 0,
      }),
    ).rejects.toThrow(
      "Timed out resolving image digest for ghcr.io/example/server:latest after -1ms",
    );

    expect(k8sApi.deleteNamespacedPod).toHaveBeenCalled();
  });

  test("ignores non-terminal waiting reasons until timeout", async () => {
    const { resolveAvailableImageDigest } = createProbe({
      readPods: [
        createProbePod({
          containerStatus: {
            name: "mcp-image-digest-probe",
            state: {
              waiting: {
                reason: "ContainerCreating",
              },
            },
          },
        }),
      ],
    });

    await expect(
      resolveAvailableImageDigest({
        image: "ghcr.io/example/server:latest",
        timeoutMs: -1,
        pollIntervalMs: 0,
      }),
    ).rejects.toThrow(
      "Timed out resolving image digest for ghcr.io/example/server:latest after -1ms",
    );
  });

  test("fails fast when Kubernetes reports an image pull failure with details", async () => {
    const { resolveAvailableImageDigest, k8sApi } = createProbe({
      readPods: [
        createProbePod({
          containerStatus: {
            name: "mcp-image-digest-probe",
            state: {
              waiting: {
                reason: "ImagePullBackOff",
                message: "pull access denied",
              },
            },
          },
        }),
      ],
    });

    await expect(
      resolveAvailableImageDigest({
        image: "ghcr.io/example/private-server:latest",
        timeoutMs: 20,
        pollIntervalMs: 0,
      }),
    ).rejects.toThrow("ImagePullBackOff - pull access denied");

    expect(k8sApi.deleteNamespacedPod).toHaveBeenCalled();
  });

  test("fails fast when Kubernetes reports an image pull failure without details", async () => {
    const { resolveAvailableImageDigest } = createProbe({
      readPods: [
        createProbePod({
          containerStatus: {
            name: "mcp-image-digest-probe",
            state: {
              waiting: {
                reason: "ErrImagePull",
              },
            },
          },
        }),
      ],
    });

    await expect(
      resolveAvailableImageDigest({
        image: "ghcr.io/example/private-server:latest",
        timeoutMs: 20,
        pollIntervalMs: 0,
      }),
    ).rejects.toThrow(
      "Failed to resolve image digest for ghcr.io/example/private-server:latest: ErrImagePull",
    );
  });

  test("fails when the probe pod image ID does not contain a digest", async () => {
    const { resolveAvailableImageDigest, k8sApi } = createProbe({
      readPods: [
        createProbePod({
          imageID: "repo/name:latest",
        }),
      ],
    });

    await expect(
      resolveAvailableImageDigest({
        image: "ghcr.io/example/server:latest",
      }),
    ).rejects.toThrow(
      "Probe pod image ID did not contain a sha256 digest: repo/name:latest",
    );

    expect(k8sApi.deleteNamespacedPod).toHaveBeenCalled();
  });

  test("logs debug when cleanup finds the probe pod already deleted", async () => {
    const { resolveAvailableImageDigest } = createProbe({
      deleteError: { statusCode: 404, message: "Pod not found" },
    });

    await expect(
      resolveAvailableImageDigest({
        image: "ghcr.io/example/server:latest",
      }),
    ).resolves.toBe("sha256:abc123");

    expect(logger.debug).toHaveBeenCalledWith(
      expect.objectContaining({
        mcpServerId: "srv-123",
        namespace: "archestra-runtime",
      }),
      "MCP image digest probe pod was already deleted",
    );
    expect(logger.warn).not.toHaveBeenCalled();
  });

  test("logs cleanup failure without masking a resolved digest", async () => {
    const cleanupError = new Error("delete failed");
    const { resolveAvailableImageDigest } = createProbe({
      deleteError: cleanupError,
    });

    await expect(
      resolveAvailableImageDigest({
        image: "ghcr.io/example/server:latest",
      }),
    ).resolves.toBe("sha256:abc123");

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        err: cleanupError,
        mcpServerId: "srv-123",
        namespace: "archestra-runtime",
      }),
      "Failed to delete MCP image digest probe pod",
    );
  });

  test("propagates probe pod creation failures without attempting cleanup", async () => {
    const createError = new Error("create failed");
    const { resolveAvailableImageDigest, k8sApi } = createProbe({
      createError,
    });

    await expect(
      resolveAvailableImageDigest({
        image: "ghcr.io/example/server:latest",
      }),
    ).rejects.toThrow("create failed");

    expect(k8sApi.deleteNamespacedPod).not.toHaveBeenCalled();
  });
});

describe("K8sImageDigestProbe.cleanupStaleProbePods", () => {
  test("deletes probe pods older than the default stale TTL", async () => {
    const { probe, k8sApi } = createCleanupProbe({
      pods: [
        createCleanupPod("stale-probe", "2000-01-01T00:00:00.000Z"),
        createCleanupPod("recent-probe", new Date().toISOString()),
      ],
    });

    await probe.cleanupStaleProbePods();

    expect(k8sApi.listNamespacedPod).toHaveBeenCalledWith({
      namespace: "archestra-runtime",
      labelSelector: "app=mcp-image-digest-probe",
    });
    expect(k8sApi.deleteNamespacedPod).toHaveBeenCalledTimes(1);
    expect(k8sApi.deleteNamespacedPod).toHaveBeenCalledWith({
      name: "stale-probe",
      namespace: "archestra-runtime",
    });
    expect(logger.debug).toHaveBeenCalledWith(
      expect.objectContaining({
        podName: "stale-probe",
        namespace: "archestra-runtime",
      }),
      "Deleted stale MCP image digest probe pod",
    );
  });

  test("keeps pods newer than the default stale TTL", async () => {
    const { probe, k8sApi } = createCleanupProbe({
      pods: [createCleanupPod("recent-probe", new Date().toISOString())],
    });

    await probe.cleanupStaleProbePods();

    expect(k8sApi.deleteNamespacedPod).not.toHaveBeenCalled();
  });

  test("skips pods without names or creation timestamps", async () => {
    const { probe, k8sApi } = createCleanupProbe({
      pods: [
        { metadata: { creationTimestamp: new Date("2026-01-01T00:00:00Z") } },
        { metadata: { name: "missing-created-at" } },
        {
          metadata: {
            name: "invalid-created-at",
            creationTimestamp: "not-a-date" as unknown as Date,
          },
        },
      ] as k8s.V1Pod[],
    });

    await probe.cleanupStaleProbePods();

    expect(k8sApi.deleteNamespacedPod).not.toHaveBeenCalled();
  });

  test("continues cleanup when a stale pod was already deleted", async () => {
    const deleteNamespacedPod = vi
      .fn()
      .mockRejectedValueOnce({ statusCode: 404 })
      .mockResolvedValueOnce({});
    const { probe, k8sApi } = createCleanupProbe({
      pods: [
        createCleanupPod("already-deleted-probe", "2000-01-01T00:00:00.000Z"),
        createCleanupPod("other-stale-probe", "2000-01-01T00:00:00.000Z"),
      ],
      deleteNamespacedPod,
    });

    await probe.cleanupStaleProbePods();

    expect(k8sApi.deleteNamespacedPod).toHaveBeenCalledTimes(2);
    expect(logger.debug).toHaveBeenCalledWith(
      expect.objectContaining({
        podName: "already-deleted-probe",
        namespace: "archestra-runtime",
      }),
      "MCP image digest probe pod was already deleted",
    );
    expect(logger.warn).not.toHaveBeenCalled();
  });

  test("logs list failures without throwing", async () => {
    const listError = new Error("list failed");
    const { probe, k8sApi } = createCleanupProbe({ listError });

    await expect(probe.cleanupStaleProbePods()).resolves.toBeUndefined();

    expect(k8sApi.deleteNamespacedPod).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        err: listError,
        namespace: "archestra-runtime",
        labelSelector: "app=mcp-image-digest-probe",
      }),
      "Failed to list stale MCP image digest probe pods",
    );
  });

  test("logs delete failures and continues with later stale pods", async () => {
    const deleteError = new Error("delete failed");
    const deleteNamespacedPod = vi
      .fn()
      .mockRejectedValueOnce(deleteError)
      .mockResolvedValueOnce({});
    const { probe, k8sApi } = createCleanupProbe({
      pods: [
        createCleanupPod("failing-delete-probe", "2000-01-01T00:00:00.000Z"),
        createCleanupPod("successful-delete-probe", "2000-01-01T00:00:00.000Z"),
      ],
      deleteNamespacedPod,
    });

    await probe.cleanupStaleProbePods();

    expect(k8sApi.deleteNamespacedPod).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        err: deleteError,
        podName: "failing-delete-probe",
        namespace: "archestra-runtime",
      }),
      "Failed to delete MCP image digest probe pod",
    );
  });
});

function createProbe(
  options: {
    mcpServer?: McpServer;
    readPods?: k8s.V1Pod[];
    createError?: unknown;
    deleteError?: unknown;
  } = {},
) {
  const readPods = options.readPods ?? [
    createProbePod({
      imageID: "docker-pullable://ghcr.io/example/server@sha256:abc123",
    }),
  ];
  const createNamespacedPod = options.createError
    ? vi.fn().mockRejectedValue(options.createError)
    : vi.fn().mockResolvedValue({});
  const readNamespacedPod = vi
    .fn()
    .mockImplementation(async () => readPods.shift() ?? readPods[0]);
  const deleteNamespacedPod = options.deleteError
    ? vi.fn().mockRejectedValue(options.deleteError)
    : vi.fn().mockResolvedValue({});
  const mcpServer =
    options.mcpServer ??
    createMcpServer({
      id: "srv-123",
      name: "Probe Server",
    });

  const k8sApi = {
    createNamespacedPod,
    readNamespacedPod,
    deleteNamespacedPod,
  };
  const probe = new K8sImageDigestProbe(
    k8sApi as unknown as k8s.CoreV1Api,
    "archestra-runtime",
  );
  const resolveAvailableImageDigest = (
    resolveOptions: ResolveDigestOptions,
  ) => {
    const { mcpServer: overrideMcpServer, ...rest } = resolveOptions;
    return probe.resolveAvailableImageDigest({
      mcpServer: overrideMcpServer ?? mcpServer,
      ...rest,
    });
  };

  return {
    probe,
    resolveAvailableImageDigest,
    k8sApi,
    mcpServer,
  };
}

function createCleanupProbe(
  options: {
    pods?: k8s.V1Pod[];
    listError?: unknown;
    deleteNamespacedPod?: ReturnType<typeof vi.fn>;
  } = {},
) {
  const listNamespacedPod = options.listError
    ? vi.fn().mockRejectedValue(options.listError)
    : vi.fn().mockResolvedValue({ items: options.pods ?? [] });
  const deleteNamespacedPod =
    options.deleteNamespacedPod ?? vi.fn().mockResolvedValue({});
  const k8sApi = {
    listNamespacedPod,
    deleteNamespacedPod,
  };

  return {
    probe: new K8sImageDigestProbe(
      k8sApi as unknown as k8s.CoreV1Api,
      "archestra-runtime",
    ),
    k8sApi,
  };
}

function createCleanupPod(name: string, createdAt: string): k8s.V1Pod {
  return {
    metadata: {
      name,
      creationTimestamp: new Date(createdAt),
    },
  } as k8s.V1Pod;
}

type ResolveDigestOptions = Omit<
  Parameters<K8sImageDigestProbe["resolveAvailableImageDigest"]>[0],
  "mcpServer"
> & {
  mcpServer?: McpServer;
};

function createProbePod(options: {
  imageID?: string;
  containerStatus?: Partial<k8s.V1ContainerStatus>;
}): k8s.V1Pod {
  return {
    status: {
      phase: "Pending",
      containerStatuses: [
        (options.containerStatus ?? {
          name: "mcp-image-digest-probe",
          imageID: options.imageID,
        }) as k8s.V1ContainerStatus,
      ],
    },
  } as k8s.V1Pod;
}

function createMcpServer(options: { id: string; name: string }): McpServer {
  return {
    id: options.id,
    name: options.name,
    catalogId: null,
    secretId: null,
    ownerId: null,
    reinstallRequired: false,
    localInstallationStatus: "idle",
    localInstallationError: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as unknown as McpServer;
}
