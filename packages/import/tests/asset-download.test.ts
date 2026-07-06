import { describe, test, expect } from "bun:test";
import { downloadAssets } from "../src/asset-download.ts";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { existsSync } from "node:fs";
import type { DiscoveredAsset } from "../src/asset-collect.ts";

describe("downloadAssets", () => {
  test("skips blocked tracking domains", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "jx-import-test-"));
    try {
      const assets: DiscoveredAsset[] = [
        { url: "https://www.google-analytics.com/analytics.js", source: "img-src" },
        { url: "https://www.googletagmanager.com/gtag/js", source: "img-src" },
        { url: "https://connect.facebook.net/en_US/fbevents.js", source: "img-src" },
      ];

      const result = await downloadAssets(assets, tmpDir);

      expect(result.skipped.length).toBe(3);
      expect(result.rewriteMap.size).toBe(0);
      expect(result.failed.length).toBe(0);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("dedupes by URL", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "jx-import-test-"));
    try {
      const assets: DiscoveredAsset[] = [
        { url: "https://www.google-analytics.com/analytics.js", source: "img-src" },
        { url: "https://www.google-analytics.com/analytics.js", source: "css-background" },
      ];

      const result = await downloadAssets(assets, tmpDir);

      // Should only process once even though same URL appears twice
      expect(result.skipped.length).toBe(1);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("creates subdirectory structure", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "jx-import-test-"));
    try {
      await downloadAssets([], tmpDir);

      expect(existsSync(join(tmpDir, "public", "assets", "images"))).toBe(true);
      expect(existsSync(join(tmpDir, "public", "assets", "fonts"))).toBe(true);
      expect(existsSync(join(tmpDir, "public", "assets", "icons"))).toBe(true);
      expect(existsSync(join(tmpDir, "public", "assets", "other"))).toBe(true);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("records failed downloads without throwing", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "jx-import-test-"));
    try {
      // Use localhost on an unlikely port to fail fast
      const assets: DiscoveredAsset[] = [
        { url: "http://127.0.0.1:1/image.jpg", source: "img-src" },
      ];

      const result = await downloadAssets(assets, tmpDir);

      expect(result.failed.length).toBe(1);
      expect(result.rewriteMap.size).toBe(0);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});
