import { describe, test, expect } from "bun:test";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  cacheKey,
  loadCache,
  saveCache,
  getCached,
  setCached,
  getImageCacheDir,
  _testResetNpmCacheBase,
} from "../src/site/image-cache";

const TMP = join(import.meta.dir, "__test-image-cache__");

// Reset memoised npm cache base before each test so path resolution is fresh
function setup() {
  _testResetNpmCacheBase();
  mkdirSync(TMP, { recursive: true });
}

function teardown() {
  rmSync(TMP, { recursive: true, force: true });
  rmSync(getImageCacheDir(TMP), { recursive: true, force: true });
  _testResetNpmCacheBase();
}

describe("image-cache", () => {
  test("cacheKey produces consistent hash for same content and config", () => {
    setup();
    const imgPath = join(TMP, "test.png");
    writeFileSync(imgPath, Buffer.from("fake-image-data"));

    const config: any = { widths: [800], formats: ["webp"], quality: 80 };
    const key1 = cacheKey(imgPath, config);
    const key2 = cacheKey(imgPath, config);
    expect(key1).toBe(key2);
    expect(key1).toContain(":");
    teardown();
  });

  test("loadCache returns empty manifest when no cache exists", () => {
    _testResetNpmCacheBase();
    const cache = loadCache("/nonexistent/path");
    expect(cache).toEqual({ version: 1, entries: {} });
  });

  test("loadCache returns empty manifest on corrupt JSON", () => {
    setup();
    // Write corrupt JSON to wherever loadCache will look
    const cacheDir = getImageCacheDir(TMP);
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(join(cacheDir, "manifest.json"), "not json");

    const cache = loadCache(TMP);
    expect(cache).toEqual({ version: 1, entries: {} });
    teardown();
  });

  test("saveCache and loadCache round-trip", () => {
    setup();
    const cache: any = {
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
    teardown();
  });

  test("getCached returns null for missing key", () => {
    const cache: any = { version: 1, entries: {} };
    expect(getCached(cache, "missing")).toBeNull();
  });

  test("getCached returns manifest for existing key", () => {
    const manifest: any = { src: "img.webp", srcset: "", width: 800, height: 600 };
    const cache: any = {
      version: 1,
      entries: { key1: { source: "img.png", manifest, timestamp: 123 } },
    };
    expect(getCached(cache, "key1")).toEqual(manifest);
  });

  test("setCached adds entry to cache", () => {
    const cache: any = { version: 1, entries: {} };
    const manifest: any = { src: "out.webp", srcset: "", width: 400, height: 300 };
    setCached(cache, "k1", "source.png", manifest);
    expect(cache.entries.k1.source).toBe("source.png");
    expect(cache.entries.k1.manifest).toEqual(manifest);
    expect(cache.entries.k1.timestamp).toBeGreaterThan(0);
  });
});
