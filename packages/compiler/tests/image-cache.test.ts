import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
    expect(cache).toEqual({ entries: {}, touched: new Set(), version: 1 });
  });

  test("loadCache returns empty manifest on corrupt JSON", () => {
    setup();
    // Write corrupt JSON to wherever loadCache will look
    const cacheDir = getImageCacheDir(TMP);
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(join(cacheDir, "manifest.json"), "not json");

    const cache = loadCache(TMP);
    expect(cache).toEqual({ entries: {}, touched: new Set(), version: 1 });
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

  test("getCached and setCached mark keys as touched", () => {
    const cache: any = { entries: {}, touched: new Set(), version: 1 };
    getCached(cache, "missing");
    setCached(cache, "k1", "source.png", { variants: [] } as any);
    expect(cache.touched.has("missing")).toBe(true);
    expect(cache.touched.has("k1")).toBe(true);
  });

  // Build a cache entry whose manifest references the given variant files on disk
  function entryWith(files: string[]): any {
    return {
      manifest: {
        contentHash: "aabbccdd",
        variants: files.map((f) => ({
          absolutePath: f,
          format: "webp",
          outputPath: "/images/_optimized/x.webp",
          width: 320,
        })),
      },
      source: "img.png",
      timestamp: 123,
    };
  }

  test("saveCache with prune removes untouched entries and their variant files", () => {
    setup();
    const keptFile = join(TMP, "a-320-hash1.webp");
    const staleFile = join(TMP, "b-320-hash2.webp");
    writeFileSync(keptFile, "a");
    writeFileSync(staleFile, "b");
    const cache: any = {
      entries: { live: entryWith([keptFile]), stale: entryWith([staleFile]) },
      touched: new Set(["live"]),
      version: 1,
    };
    saveCache(TMP, cache, { prune: true });
    expect(existsSync(keptFile)).toBe(true);
    expect(existsSync(staleFile)).toBe(false);
    const loaded = loadCache(TMP);
    expect(loaded.entries.live).toBeDefined();
    expect(loaded.entries.stale).toBeUndefined();
    teardown();
  });

  test("prune keeps files shared with a surviving entry", () => {
    setup();
    const sharedFile = join(TMP, "img-320-samehash.webp");
    const oldOnlyFile = join(TMP, "img-640-samehash.webp");
    writeFileSync(sharedFile, "x");
    writeFileSync(oldOnlyFile, "y");
    const cache: any = {
      entries: {
        newConfig: entryWith([sharedFile]),
        oldConfig: entryWith([sharedFile, oldOnlyFile]),
      },
      touched: new Set(["newConfig"]),
      version: 1,
    };
    saveCache(TMP, cache, { prune: true });
    expect(existsSync(sharedFile)).toBe(true);
    expect(existsSync(oldOnlyFile)).toBe(false);
    teardown();
  });

  test("saveCache without prune keeps untouched entries and files", () => {
    setup();
    const staleFile = join(TMP, "b-320-hash2.webp");
    writeFileSync(staleFile, "b");
    const cache: any = {
      entries: { stale: entryWith([staleFile]) },
      touched: new Set(),
      version: 1,
    };
    saveCache(TMP, cache);
    expect(existsSync(staleFile)).toBe(true);
    expect(loadCache(TMP).entries.stale).toBeDefined();
    teardown();
  });

  test("prune without a touched set leaves everything intact", () => {
    setup();
    const staleFile = join(TMP, "b-320-hash2.webp");
    writeFileSync(staleFile, "b");
    const cache: any = {
      entries: { stale: entryWith([staleFile]) },
      version: 1,
    };
    saveCache(TMP, cache, { prune: true });
    expect(existsSync(staleFile)).toBe(true);
    expect(loadCache(TMP).entries.stale).toBeDefined();
    teardown();
  });

  test("serialized manifest.json contains no touched key", () => {
    setup();
    const cache: any = { entries: {}, touched: new Set(["k"]), version: 1 };
    saveCache(TMP, cache);
    const raw = readFileSync(join(getImageCacheDir(TMP), "manifest.json"), "utf8");
    expect(raw).not.toContain("touched");
    teardown();
  });

  test("loadCache initializes touched as an empty set on a parsed manifest", () => {
    setup();
    const cache: any = { entries: { k: entryWith([]) }, version: 1 };
    saveCache(TMP, cache);
    const loaded = loadCache(TMP);
    expect(loaded.touched).toEqual(new Set());
    teardown();
  });
});
