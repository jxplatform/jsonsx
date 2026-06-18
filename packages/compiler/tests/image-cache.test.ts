import { describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  _testResetNpmCacheBase,
  cacheKey,
  getCached,
  getImageCacheDir,
  loadCache,
  saveCache,
  setCached,
} from "../src/site/image-cache";

const TMP = join(import.meta.dir, "__test-image-cache__");

// Reset memoised npm cache base before each test so path resolution is fresh
function setup() {
  _testResetNpmCacheBase();
  mkdirSync(TMP, { recursive: true });
}

function teardown() {
  rmSync(TMP, { force: true, recursive: true });
  rmSync(getImageCacheDir(TMP), { force: true, recursive: true });
  _testResetNpmCacheBase();
}

describe("image-cache", () => {
  test("cacheKey produces consistent hash for same content and config", () => {
    setup();
    const imgPath = join(TMP, "test.png");
    writeFileSync(imgPath, Buffer.from("fake-image-data"));

    const config: any = { formats: ["webp"], quality: 80, widths: [800] };
    const key1 = cacheKey(imgPath, config);
    const key2 = cacheKey(imgPath, config);
    expect(key1).toBe(key2);
    expect(key1).toContain(":");
    teardown();
  });

  test("loadCache returns empty manifest when no cache exists", () => {
    _testResetNpmCacheBase();
    const cache = loadCache("/nonexistent/path");
    expect(cache).toEqual({ entries: {}, version: 1 });
  });

  test("loadCache returns empty manifest on corrupt JSON", () => {
    setup();
    // Write corrupt JSON to wherever loadCache will look
    const cacheDir = getImageCacheDir(TMP);
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(join(cacheDir, "manifest.json"), "not json");

    const cache = loadCache(TMP);
    expect(cache).toEqual({ entries: {}, version: 1 });
    teardown();
  });

  test("saveCache and loadCache round-trip", () => {
    setup();
    const cache: any = {
      entries: {
        "abc:def": {
          manifest: { height: 600, src: "img.webp", srcset: "", width: 800 },
          source: "img.png",
          timestamp: 123,
        },
      },
      version: 1,
    };
    saveCache(TMP, cache);
    const loaded = loadCache(TMP);
    expect(loaded.entries["abc:def"]!.source).toBe("img.png");
    teardown();
  });

  test("getCached returns null for missing key", () => {
    const cache: any = { entries: {}, version: 1 };
    expect(getCached(cache, "missing")).toBeNull();
  });

  test("getCached returns manifest for existing key", () => {
    const manifest: any = {
      height: 600,
      src: "img.webp",
      srcset: "",
      width: 800,
    };
    const cache: any = {
      entries: { key1: { manifest, source: "img.png", timestamp: 123 } },
      version: 1,
    };
    expect(getCached(cache, "key1")).toEqual(manifest);
  });

  test("setCached adds entry to cache", () => {
    const cache: any = { entries: {}, version: 1 };
    const manifest: any = {
      height: 300,
      src: "out.webp",
      srcset: "",
      width: 400,
    };
    setCached(cache, "k1", "source.png", manifest);
    expect(cache.entries.k1.source).toBe("source.png");
    expect(cache.entries.k1.manifest).toEqual(manifest);
    expect(cache.entries.k1.timestamp).toBeGreaterThan(0);
  });
});
