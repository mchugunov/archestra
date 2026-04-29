import { describe, expect, test } from "@/test";
import { isDigestPinnedImage, normalizeImageDigest } from "./image-digest";

describe("normalizeImageDigest", () => {
  test.each([
    {
      input: "docker-pullable://repo/name@sha256:abc123",
      expected: "sha256:abc123",
    },
    {
      input: "repo/name@sha256:def456",
      expected: "sha256:def456",
    },
    {
      input: "containerd://sha256:789abc",
      expected: "sha256:789abc",
    },
    {
      input: "docker://sha256:012def",
      expected: "sha256:012def",
    },
    {
      input: "sha256:abc123",
      expected: "sha256:abc123",
    },
    {
      input: "  docker-pullable://repo/name@sha256:abc123  ",
      expected: "sha256:abc123",
    },
    {
      input: "docker-pullable://repo/name@SHA256:ABC123",
      expected: "sha256:ABC123",
    },
  ])("normalizes $input", ({ input, expected }) => {
    expect(normalizeImageDigest(input)).toBe(expected);
  });

  test.each([
    undefined,
    null,
    "",
    "   ",
    "repo/name:latest",
    "not-a-digest",
  ])("returns null for %s", (input) => {
    expect(normalizeImageDigest(input)).toBeNull();
  });
});

describe("isDigestPinnedImage", () => {
  test("detects configured images pinned by sha256 digest", () => {
    expect(isDigestPinnedImage("repo/name@sha256:abc123")).toBe(true);
  });

  test.each([
    undefined,
    null,
    "",
    "repo/name:latest",
    "sha256:abc123",
  ])("returns false for non-pinned configured image %s", (image) => {
    expect(isDigestPinnedImage(image)).toBe(false);
  });
});
