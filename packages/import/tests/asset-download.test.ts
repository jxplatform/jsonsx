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

  test("skips malformed asset URLs", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "jx-import-test-"));
    try {
      const assets: DiscoveredAsset[] = [{ url: "not a url", source: "img-src" }];

      const result = await downloadAssets(assets, tmpDir);

      expect(result.skipped).toEqual(["not a url"]);
      expect(result.failed.length).toBe(0);
      expect(result.rewriteMap.size).toBe(0);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("downloads successful responses and builds the rewrite map", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "jx-import-test-"));
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response("hello")) as unknown as typeof fetch;
    try {
      const url = "https://example.com/images/pic.jpg";
      const result = await downloadAssets([{ url, source: "img-src" }], tmpDir);

      expect(result.rewriteMap.get(url)).toBe("/assets/images/pic.jpg");
      expect(result.totalBytes).toBe(5);
      expect(result.failed.length).toBe(0);
      expect(existsSync(join(tmpDir, "public", "assets", "images", "pic.jpg"))).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("classifies assets into subdirectories by source and extension", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "jx-import-test-"));
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response("data")) as unknown as typeof fetch;
    try {
      const assets: DiscoveredAsset[] = [
        { url: "https://fonts.example.com/custom.ttf", source: "font-face" },
        { url: "https://example.com/favicon.ico", source: "favicon" },
        { url: "https://cdn.example.com/inter.woff2", source: "css-url" },
        { url: "https://example.com/whitepaper.pdf", source: "img-src" },
      ];

      const result = await downloadAssets(assets, tmpDir);

      expect(result.rewriteMap.get("https://fonts.example.com/custom.ttf")).toBe(
        "/assets/fonts/custom.ttf",
      );
      expect(result.rewriteMap.get("https://example.com/favicon.ico")).toBe(
        "/assets/icons/favicon.ico",
      );
      expect(result.rewriteMap.get("https://cdn.example.com/inter.woff2")).toBe(
        "/assets/fonts/inter.woff2",
      );
      expect(result.rewriteMap.get("https://example.com/whitepaper.pdf")).toBe(
        "/assets/other/whitepaper.pdf",
      );
    } finally {
      globalThis.fetch = originalFetch;
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("sanitizes extensionless and overlong filenames", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "jx-import-test-"));
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response("data")) as unknown as typeof fetch;
    try {
      const longName = "a".repeat(116);
      const assets: DiscoveredAsset[] = [
        { url: "https://example.com/assets/logo", source: "img-src" },
        { url: `https://example.com/${longName}.png`, source: "img-src" },
      ];

      const result = await downloadAssets(assets, tmpDir);

      // No extension → ".bin" appended (and classified as "other")
      expect(result.rewriteMap.get("https://example.com/assets/logo")).toBe(
        "/assets/other/logo.bin",
      );
      // 120-char filename → capped to 96 chars + extension
      expect(result.rewriteMap.get(`https://example.com/${longName}.png`)).toBe(
        `/assets/images/${"a".repeat(96)}.png`,
      );
    } finally {
      globalThis.fetch = originalFetch;
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("dedupes colliding filenames within a subdirectory", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "jx-import-test-"));
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response("data")) as unknown as typeof fetch;
    try {
      const assets: DiscoveredAsset[] = [
        { url: "https://a.example.com/logo.png", source: "img-src" },
        { url: "https://b.example.com/logo.png", source: "img-src" },
      ];

      const result = await downloadAssets(assets, tmpDir);

      expect(result.rewriteMap.get("https://a.example.com/logo.png")).toBe(
        "/assets/images/logo.png",
      );
      expect(result.rewriteMap.get("https://b.example.com/logo.png")).toBe(
        "/assets/images/logo-1.png",
      );
      expect(existsSync(join(tmpDir, "public", "assets", "images", "logo-1.png"))).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("sends a Referer header when sourceUrl is provided", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "jx-import-test-"));
    const originalFetch = globalThis.fetch;
    const seenHeaders: Record<string, string>[] = [];
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      seenHeaders.push({ ...(init?.headers as Record<string, string>) });
      return new Response("data");
    }) as unknown as typeof fetch;
    try {
      const assets: DiscoveredAsset[] = [
        { url: "https://example.com/hero.jpg", source: "img-src" },
      ];

      await downloadAssets(assets, tmpDir, "https://example.com/page");

      expect(seenHeaders).toHaveLength(1);
      expect(seenHeaders[0]!["Referer"]).toBe("https://example.com/page");
      expect(seenHeaders[0]!["User-Agent"]).toContain("Mozilla/5.0");
    } finally {
      globalThis.fetch = originalFetch;
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  /*
   * Issue #229: the map used to hold `public/assets/…` — the path the bytes are WRITTEN to, not the
   * one the built site SERVES. `public/` is the compiler's static root, so its contents land at
   * `dist/<path>` with the segment stripped; and without the leading slash a reference emitted
   * inside a component resolved against `/components/`. Every image on every imported page 404'd.
   */
  test("maps to the path the built site serves, not the path on disk", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "jx-import-test-"));
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response("data")) as unknown as typeof fetch;
    try {
      const assets: DiscoveredAsset[] = [
        { url: "https://example.com/logo.png", source: "img-src" },
        { url: "https://example.com/inter.woff2", source: "font-face" },
        { url: "https://example.com/favicon.ico", source: "favicon" },
        { url: "https://example.com/paper.pdf", source: "img-src" },
      ];

      const result = await downloadAssets(assets, tmpDir);

      for (const served of result.rewriteMap.values()) {
        expect(served.startsWith("/assets/")).toBe(true);
        expect(served).not.toContain("public/");
      }
      // The bytes still land under public/ — only the reference drops the segment.
      expect(existsSync(join(tmpDir, "public", "assets", "images", "logo.png"))).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("records non-ok responses as failed", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "jx-import-test-"));
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response("nope", { status: 404 })) as unknown as typeof fetch;
    try {
      const url = "https://example.com/gone.jpg";
      const result = await downloadAssets([{ url, source: "img-src" }], tmpDir);

      expect(result.failed).toEqual([url]);
      expect(result.rewriteMap.size).toBe(0);
      expect(result.totalBytes).toBe(0);
      expect(existsSync(join(tmpDir, "public", "assets", "images", "gone.jpg"))).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});
