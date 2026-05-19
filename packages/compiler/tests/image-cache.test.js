import { describe, test, expect } from "bun:test";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { cacheKey, loadCache, saveCache, getCached, setCached } from "../src/site/image-cache.js";

const TMP = join(import.meta.dir, "__test-image-cache__");

describe("image-cache", () => {
  test("cacheKey produces consistent hash for same content and config", () => {
    mkdirSync(TMP, { recursive: true });
    const imgPath = join(TMP, "test.png");
    writeFileSync(imgPath, Buffer.from("fake-image-data"));

    /** @type {any} */
    const config = { widths: [800], formats: ["webp"], quality: 80 };
    const key1 = cacheKey(imgPath, config);
    const key2 = cacheKey(imgPath, config);
    expect(key1).toBe(key2);
    expect(key1).toContain(":");
    rmSync(TMP, { recursive: true, force: true });
  });

  test("loadCache returns empty manifest when no cache exists", () => {
    const cache = loadCache("/nonexistent/path");
    expect(cache).toEqual({ version: 1, entries: {} });
  });

  test("loadCache returns empty manifest on corrupt JSON", () => {
    mkdirSync(join(TMP, ".jx-cache/images"), { recursive: true });
    writeFileSync(join(TMP, ".jx-cache/images/manifest.json"), "not json");
    const cache = loadCache(TMP);
    expect(cache).toEqual({ version: 1, entries: {} });
    rmSync(TMP, { recursive: true, force: true });
  });

  test("saveCache and loadCache round-trip", () => {
    mkdirSync(TMP, { recursive: true });
    /** @type {any} */
    const cache = {
      version: 1,
      entries: {
        "abc:def": {
          source: "img.png",
          manifest: { src: "img.webp", srcset: "", width: 800, height: 600 },
          timestamp: 123,
        },
      },
    };
    saveCache(TMP, cache);
    const loaded = loadCache(TMP);
    expect(loaded.entries["abc:def"].source).toBe("img.png");
    rmSync(TMP, { recursive: true, force: true });
  });

  test("getCached returns null for missing key", () => {
    /** @type {any} */
    const cache = { version: 1, entries: {} };
    expect(getCached(cache, "missing")).toBeNull();
  });

  test("getCached returns manifest for existing key", () => {
    /** @type {any} */
    const manifest = { src: "img.webp", srcset: "", width: 800, height: 600 };
    /** @type {any} */
    const cache = {
      version: 1,
      entries: { key1: { source: "img.png", manifest, timestamp: 123 } },
    };
    expect(getCached(cache, "key1")).toEqual(manifest);
  });

  test("setCached adds entry to cache", () => {
    /** @type {any} */
    const cache = { version: 1, entries: {} };
    /** @type {any} */
    const manifest = { src: "out.webp", srcset: "", width: 400, height: 300 };
    setCached(cache, "k1", "source.png", manifest);
    expect(cache.entries.k1.source).toBe("source.png");
    expect(cache.entries.k1.manifest).toEqual(manifest);
    expect(cache.entries.k1.timestamp).toBeGreaterThan(0);
  });
});
