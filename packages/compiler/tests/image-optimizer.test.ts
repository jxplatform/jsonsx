import { beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

import {
  contentHash,
  configHash,
  variantFilename,
  buildSrcset,
  getImageMetadata,
  processImage,
} from "../src/site/image-optimizer";
import { loadCache, saveCache, getCached, setCached } from "../src/site/image-cache";
import { transformImageNodes } from "../src/site/image-transform";

// Mock sharp module before any imports that use it
const mockToFile = mock(() => Promise.resolve());
const mockToFormat = mock(() => ({ toFile: mockToFile }));
const mockResize = mock(() => ({ toFormat: mockToFormat }));
const mockMetadata = mock(() => Promise.resolve({ format: "jpeg", height: 600, width: 800 }));
const mockSharpInstance = { metadata: mockMetadata, resize: mockResize };
const mockSharp = mock(() => mockSharpInstance);
void mock.module("sharp", () => ({ default: mockSharp }));

const TMP = resolve(tmpdir(), `jx-image-test-${Date.now()}`);

function setup() {
  rmSync(TMP, { force: true, recursive: true });
  mkdirSync(TMP, { recursive: true });
  mkdirSync(join(TMP, "public/images"), { recursive: true });
  return TMP;
}

function teardown() {
  rmSync(TMP, { force: true, recursive: true });
}

// ─── Pure utility tests (no Sharp needed) ────────────────────────────────────

describe("image-optimizer utilities", () => {
  test("variantFilename builds correct name", () => {
    expect(variantFilename("hero", 640, "a1b2c3d4", "webp")).toBe("hero-640-a1b2c3d4.webp");
    expect(variantFilename("photo", 1280, "deadbeef", "avif")).toBe("photo-1280-deadbeef.avif");
  });

  test("buildSrcset filters by format", () => {
    const variants = [
      {
        absolutePath: "",
        format: "webp",
        outputPath: "/images/_optimized/hero-320-abc.webp",
        width: 320,
      },
      {
        absolutePath: "",
        format: "webp",
        outputPath: "/images/_optimized/hero-640-abc.webp",
        width: 640,
      },
      {
        absolutePath: "",
        format: "avif",
        outputPath: "/images/_optimized/hero-320-abc.avif",
        width: 320,
      },
      {
        absolutePath: "",
        format: "avif",
        outputPath: "/images/_optimized/hero-640-abc.avif",
        width: 640,
      },
    ];

    const webpSrcset = buildSrcset(variants, "webp");
    expect(webpSrcset).toBe(
      "/images/_optimized/hero-320-abc.webp 320w, /images/_optimized/hero-640-abc.webp 640w",
    );

    const avifSrcset = buildSrcset(variants, "avif");
    expect(avifSrcset).toContain("avif");
    expect(avifSrcset).not.toContain("webp");
  });

  test("buildSrcset returns empty for no matches", () => {
    expect(buildSrcset([], "webp")).toBe("");
  });
});

describe("contentHash and configHash", () => {
  test("contentHash returns 8-char hex string", () => {
    const root = setup();
    const file = join(root, "test.bin");
    writeFileSync(file, "hello world");

    const hash = contentHash(file);
    expect(hash).toHaveLength(8);
    expect(hash).toMatch(/^[0-9a-f]{8}$/);

    teardown();
  });

  test("contentHash changes when file content changes", () => {
    const root = setup();
    const file = join(root, "test.bin");

    writeFileSync(file, "content A");
    const hashA = contentHash(file);

    writeFileSync(file, "content B");
    const hashB = contentHash(file);

    expect(hashA).not.toBe(hashB);
    teardown();
  });

  test("configHash returns 8-char hex string", () => {
    const hash = configHash({
      formats: ["webp"],
      lazyLoad: true,
      optimize: true,
      quality: { webp: 80 },
      sizes: "100vw",
      widths: [320, 640],
    });
    expect(hash).toHaveLength(8);
    expect(hash).toMatch(/^[0-9a-f]{8}$/);
  });

  test("configHash changes with different settings", () => {
    const base = { lazyLoad: true, optimize: true, sizes: "100vw" };
    const hashA = configHash({
      ...base,
      formats: ["webp"],
      quality: { webp: 80 },
      widths: [320],
    });
    const hashB = configHash({
      ...base,
      formats: ["webp"],
      quality: { webp: 80 },
      widths: [640],
    });
    expect(hashA).not.toBe(hashB);
  });
});

// ─── Cache tests ─────────────────────────────────────────────────────────────

describe("image-cache", () => {
  test("loadCache returns empty manifest when no cache exists", () => {
    const cache = loadCache("/nonexistent/path");
    expect(cache).toEqual({ entries: {}, version: 1 });
  });

  test("saveCache and loadCache round-trip", () => {
    const root = setup();
    const cache = {
      entries: {
        "abc:def": {
          manifest: {
            contentHash: "abc",
            original: { format: "jpeg", height: 100, width: 100 },
            variants: [],
          },
          source: "test.jpg",
          timestamp: 1000,
        },
      },
      version: 1,
    };

    saveCache(root, cache);
    const loaded = loadCache(root);
    expect(loaded.entries["abc:def"]!.source).toBe("test.jpg");
    teardown();
  });

  test("getCached returns null for missing key", () => {
    const cache = { entries: {}, version: 1 };
    expect(getCached(cache, "missing")).toBeNull();
  });

  test("getCached returns manifest regardless of output file existence", () => {
    const manifest = {
      contentHash: "abc",
      original: { format: "jpeg", height: 600, width: 800 },
      variants: [
        {
          absolutePath: "/nonexistent/dist/images/_optimized/hero-320-abc.avif",
          format: "avif",
          outputPath: "/images/_optimized/hero-320-abc.avif",
          width: 320,
        },
      ],
    };
    const cache = {
      entries: {
        "abc:def": { manifest, source: "hero.jpg", timestamp: 1000 },
      },
      version: 1,
    };
    const result = getCached(cache, "abc:def");
    expect(result).not.toBeNull();
    expect(result?.original!.width).toBe(800);
    expect(result?.variants).toHaveLength(1);
  });

  test("setCached stores entry", () => {
    const cache = { entries: {} as Record<string, any>, version: 1 };
    const manifest = {
      contentHash: "abc",
      original: { format: "jpeg", height: 600, width: 800 },
      variants: [],
    };
    setCached(cache, "key1", "test.jpg", manifest);
    expect(cache.entries["key1"]).toBeDefined();
    expect(cache.entries["key1"].source).toBe("test.jpg");
  });
});

// ─── Transform tests (no Sharp — tests skip conditions and tree walking) ─────

describe("image-transform", () => {
  const defaultConfig = {
    formats: ["webp", "avif"],
    lazyLoad: true,
    optimize: true,
    quality: { avif: 65, webp: 80 },
    sizes: "(max-width: 768px) 100vw, 50vw",
    widths: [320, 640],
  };

  test("skips when optimize is false", async () => {
    const doc = {
      children: [
        {
          attributes: /** @type {Record<string, any>} */ {
            src: "/images/hero.jpg",
          },
          tagName: "img",
        },
      ],
      tagName: "div",
    };
    const cache = { entries: {}, version: 1 };
    const result = await transformImageNodes(
      doc,
      { ...defaultConfig, optimize: false },
      "/tmp",
      cache,
    );
    expect(result.imageRefs.size).toBe(0);
    expect((doc.children[0]!.attributes as Record<string, unknown>)?.srcset).toBeUndefined();
  });

  test("skips template string src", async () => {
    const root = setup();
    const doc = {
      children: [{ attributes: { src: "${state.image}" }, tagName: "img" }],
      tagName: "div",
    };
    const cache = { entries: {}, version: 1 };
    const result = await transformImageNodes(doc, defaultConfig, root, cache);
    expect(result.imageRefs.size).toBe(0);
    teardown();
  });

  test("skips external URLs", async () => {
    const root = setup();
    const doc = {
      children: [
        { attributes: { src: "https://example.com/img.jpg" }, tagName: "img" },
        { attributes: { src: "data:image/png;base64,abc" }, tagName: "img" },
        { attributes: { src: "//cdn.example.com/img.jpg" }, tagName: "img" },
      ],
      tagName: "div",
    };
    const cache = { entries: {}, version: 1 };
    const result = await transformImageNodes(doc, defaultConfig, root, cache);
    expect(result.imageRefs.size).toBe(0);
    teardown();
  });

  test("skips SVG and GIF files", async () => {
    const root = setup();
    writeFileSync(join(root, "public/images/icon.svg"), "<svg></svg>");
    writeFileSync(join(root, "public/images/anim.gif"), "GIF89a");

    const doc = {
      children: [
        { attributes: { src: "/images/icon.svg" }, tagName: "img" },
        { attributes: { src: "/images/anim.gif" }, tagName: "img" },
      ],
      tagName: "div",
    };
    const cache = { entries: {}, version: 1 };
    const result = await transformImageNodes(doc, defaultConfig, root, cache);
    expect(result.imageRefs.size).toBe(0);
    teardown();
  });

  test("skips data-no-optimize images", async () => {
    const root = setup();
    writeFileSync(join(root, "public/images/hero.jpg"), "fake jpg data");

    const doc = {
      children: [
        {
          attributes: { "data-no-optimize": "", src: "/images/hero.jpg" },
          tagName: "img",
        },
      ],
      tagName: "div",
    };
    const cache = { entries: {}, version: 1 };
    const result = await transformImageNodes(doc, defaultConfig, root, cache);
    expect(result.imageRefs.size).toBe(0);
    teardown();
  });

  test("skips when source file does not exist", async () => {
    const root = setup();
    const doc = {
      children: [{ attributes: { src: "/images/nonexistent.jpg" }, tagName: "img" }],
      tagName: "div",
    };
    const cache = { entries: {}, version: 1 };
    const result = await transformImageNodes(doc, defaultConfig, root, cache);
    expect(result.imageRefs.size).toBe(0);
    teardown();
  });

  test("walks nested children", async () => {
    const root = setup();
    const doc = {
      children: [
        {
          children: [
            { tagName: "p", textContent: "text" },
            {
              attributes: { src: "https://external.com/photo.jpg" },
              tagName: "img",
            },
          ],
          tagName: "section",
        },
      ],
      tagName: "div",
    };
    const cache = { entries: {}, version: 1 };
    const result = await transformImageNodes(doc, defaultConfig, root, cache);
    expect(result.imageRefs.size).toBe(0);
    teardown();
  });

  test("transforms img tags inside innerHTML strings", async () => {
    const root = setup();
    writeFileSync(join(root, "public/images/photo.jpg"), "fake jpg data");

    const cacheOptDir = join(root, ".cache/images/_optimized");
    mkdirSync(cacheOptDir, { recursive: true });

    const manifest = {
      contentHash: "abc12345",
      original: { format: "jpeg", height: 800, width: 1200 },
      variants: [
        {
          absolutePath: join(cacheOptDir, "photo-320-abc.avif"),
          format: "avif",
          outputPath: "/images/_optimized/photo-320-abc.avif",
          width: 320,
        },
        {
          absolutePath: join(cacheOptDir, "photo-640-abc.avif"),
          format: "avif",
          outputPath: "/images/_optimized/photo-640-abc.avif",
          width: 640,
        },
      ],
    };

    for (const v of manifest.variants) {
      writeFileSync(v.absolutePath, "");
    }

    const cache = { entries: {} as Record<string, any>, version: 1 };
    setCached(
      cache,
      `${contentHash(join(root, "public/images/photo.jpg"))}:${configHash(defaultConfig)}`,
      "/images/photo.jpg",
      manifest,
    );

    const doc = {
      innerHTML: '<img class="hero" src="/images/photo.jpg" alt="Photo">',
      tagName: "my-component",
    };

    await transformImageNodes(doc, defaultConfig, root, cache);

    expect(doc.innerHTML).toContain("srcset=");
    expect(doc.innerHTML).toContain("photo-320-abc.avif 320w");
    expect(doc.innerHTML).toContain("photo-640-abc.avif 640w");
    expect(doc.innerHTML).toContain('width="1200" height="800"');
    expect(doc.innerHTML).toContain('sizes="');

    teardown();
  });

  test("innerHTML: skips img tags that already have srcset", async () => {
    const root = setup();
    writeFileSync(join(root, "public/images/photo.jpg"), "fake jpg data");

    const doc = {
      innerHTML: '<img src="/images/photo.jpg" srcset="already-set" alt="Photo">',
      tagName: "my-component",
    };
    const cache = { entries: {}, version: 1 };

    await transformImageNodes(doc, defaultConfig, root, cache);
    expect(doc.innerHTML).toBe('<img src="/images/photo.jpg" srcset="already-set" alt="Photo">');
    teardown();
  });

  test("innerHTML: skips data-no-optimize img tags", async () => {
    const root = setup();
    writeFileSync(join(root, "public/images/photo.jpg"), "fake jpg data");

    const doc = {
      innerHTML: '<img src="/images/photo.jpg" data-no-optimize alt="Photo">',
      tagName: "my-component",
    };
    const cache = { entries: {}, version: 1 };

    await transformImageNodes(doc, defaultConfig, root, cache);
    expect(doc.innerHTML).not.toContain("srcset=");
    teardown();
  });

  test("innerHTML: skips template strings and external URLs", async () => {
    const root = setup();
    const doc = {
      innerHTML:
        '<img src="${state.image}" alt="Dynamic"><img src="https://cdn.example.com/img.jpg" alt="External">',
      tagName: "my-component",
    };
    const cache = { entries: {}, version: 1 };

    await transformImageNodes(doc, defaultConfig, root, cache);
    expect(doc.innerHTML).not.toContain("srcset=");
    teardown();
  });

  test("innerHTML: preserves existing loading and decoding attributes", async () => {
    const root = setup();
    writeFileSync(join(root, "public/images/hero.jpg"), "fake jpg data");

    const cacheOptDir = join(root, ".cache/images/_optimized");
    mkdirSync(cacheOptDir, { recursive: true });

    const manifest = {
      contentHash: "abc12345",
      original: { format: "jpeg", height: 600, width: 800 },
      variants: [
        {
          absolutePath: join(cacheOptDir, "hero-320-abc.avif"),
          format: "avif",
          outputPath: "/images/_optimized/hero-320-abc.avif",
          width: 320,
        },
      ],
    };
    for (const v of manifest.variants) {
      writeFileSync(v.absolutePath, "");
    }

    const cache = { entries: {} as Record<string, any>, version: 1 };
    setCached(
      cache,
      `${contentHash(join(root, "public/images/hero.jpg"))}:${configHash(defaultConfig)}`,
      "/images/hero.jpg",
      manifest,
    );

    const doc = {
      innerHTML: '<img src="/images/hero.jpg" loading="eager" decoding="sync">',
      tagName: "my-component",
    };

    await transformImageNodes(doc, defaultConfig, root, cache);
    expect(doc.innerHTML).toContain('loading="eager"');
    expect(doc.innerHTML).not.toContain('loading="lazy"');
    expect(doc.innerHTML).not.toContain('decoding="async"');
    teardown();
  });

  test("innerHTML: handles multiple img tags in one string", async () => {
    const root = setup();
    writeFileSync(join(root, "public/images/a.jpg"), "fake a");
    writeFileSync(join(root, "public/images/b.jpg"), "fake b");

    const cacheOptDir = join(root, ".cache/images/_optimized");
    mkdirSync(cacheOptDir, { recursive: true });

    const makeManifest = (name: string) => {
      const m = {
        contentHash: "abc12345",
        original: { format: "jpeg", height: 480, width: 640 },
        variants: [
          {
            absolutePath: join(cacheOptDir, `${name}-320-abc.avif`),
            format: "avif",
            outputPath: `/images/_optimized/${name}-320-abc.avif`,
            width: 320,
          },
        ],
      };
      for (const v of m.variants) {
        writeFileSync(v.absolutePath, "");
      }
      return m;
    };

    const cache = { entries: {} as Record<string, any>, version: 1 };
    setCached(
      cache,
      `${contentHash(join(root, "public/images/a.jpg"))}:${configHash(defaultConfig)}`,
      "/images/a.jpg",
      makeManifest("a"),
    );
    setCached(
      cache,
      `${contentHash(join(root, "public/images/b.jpg"))}:${configHash(defaultConfig)}`,
      "/images/b.jpg",
      makeManifest("b"),
    );

    const doc = {
      innerHTML:
        '<div><img src="/images/a.jpg" alt="A"><p>text</p><img src="/images/b.jpg" alt="B"></div>',
      tagName: "my-component",
    };

    await transformImageNodes(doc, defaultConfig, root, cache);
    expect(doc.innerHTML).toContain("a-320-abc.avif");
    expect(doc.innerHTML).toContain("b-320-abc.avif");
    teardown();
  });
});

// ─── Sharp-dependent tests (getImageMetadata, processImage, getSharp error) ──
// Sharp is mocked because the native binary may not load in all CI environments.

describe("getImageMetadata", () => {
  beforeEach(() => {
    mockMetadata.mockClear();
  });

  test("returns width, height, and format via sharp", async () => {
    const root = setup();
    const imgPath = join(root, "test.png");
    writeFileSync(imgPath, "fake png data");

    const meta = await getImageMetadata(imgPath);
    expect(meta.width).toBe(800);
    expect(meta.height).toBe(600);
    expect(meta.format).toBe("jpeg");
    expect(mockSharp).toHaveBeenCalledWith(imgPath);

    teardown();
  });

  test("returns 0 for missing width/height and 'unknown' for missing format", async () => {
    mockMetadata.mockImplementationOnce(() =>
      Promise.resolve({
        format: undefined,
        height: undefined,
        width: undefined,
      } as unknown as {
        width: number;
        height: number;
        format: string;
      }),
    );
    const root = setup();
    const imgPath = join(root, "empty.png");
    writeFileSync(imgPath, "fake");

    const meta = await getImageMetadata(imgPath);
    expect(meta.width).toBe(0);
    expect(meta.height).toBe(0);
    expect(meta.format).toBe("unknown" as unknown as string);

    teardown();
  });
});

describe("processImage", () => {
  beforeEach(() => {
    mockSharp.mockClear();
    mockResize.mockClear();
    mockToFormat.mockClear();
    mockToFile.mockClear();
    mockMetadata.mockImplementation(() =>
      Promise.resolve({ format: "jpeg", height: 600, width: 800 }),
    );
  });

  test("generates variants for configured widths and formats", async () => {
    const root = setup();
    const cacheImgDir = join(root, ".cache/images");

    const imgPath = join(root, "hero.jpg");
    writeFileSync(imgPath, "fake jpeg data");

    const config: any = {
      formats: ["webp"],
      lazyLoad: true,
      optimize: true,
      quality: { webp: 80 },
      sizes: "100vw",
      widths: [320, 640],
    };

    const manifest = await processImage(imgPath, cacheImgDir, config);

    expect(manifest.original.width).toBe(800);
    expect(manifest.original.height).toBe(600);
    expect(manifest.original.format).toBe("jpeg");
    expect(manifest.contentHash).toHaveLength(8);
    // 320, 640, and 800 (original) each in webp = 3 variants
    expect(manifest.variants).toHaveLength(3);

    const widths = manifest.variants.map((v) => v.width);
    expect(widths).toContain(320);
    expect(widths).toContain(640);
    expect(widths).toContain(800); // Original width added

    for (const v of manifest.variants) {
      expect(v.format).toBe("webp");
      expect(v.outputPath).toContain("images/_optimized/hero-");
      expect(v.absolutePath).toContain(cacheImgDir);
    }

    teardown();
  });

  test("adds original width when no configured widths are smaller", async () => {
    const root = setup();
    const cacheImgDir = join(root, ".cache/images");

    // Image is only 50px wide
    mockMetadata.mockImplementationOnce(() =>
      Promise.resolve({ format: "png", height: 50, width: 50 }),
    );

    const imgPath = join(root, "small.png");
    writeFileSync(imgPath, "small png");

    const config: any = {
      formats: ["webp"],
      lazyLoad: true,
      optimize: true,
      quality: { webp: 80 },
      sizes: "100vw",
      widths: [800, 1200, 1920],
    };

    const manifest = await processImage(imgPath, cacheImgDir, config);
    const widths = manifest.variants.map((v) => v.width);
    // All configured widths > 50, so only original width is used
    expect(widths).toEqual([50]);

    teardown();
  });

  test("skips variant generation if output file already exists", async () => {
    const root = setup();
    const cacheImgDir = join(root, ".cache/images");
    const optimizedDir = join(cacheImgDir, "_optimized");
    mkdirSync(optimizedDir, { recursive: true });

    // Image is 320px wide so only one width variant
    mockMetadata.mockImplementationOnce(() =>
      Promise.resolve({ format: "png", height: 240, width: 320 }),
    );

    const imgPath = join(root, "cached.png");
    writeFileSync(imgPath, "cached png data");

    const hash8 = contentHash(imgPath);
    const filename = variantFilename("cached", 320, hash8, "webp");
    // Pre-create the output file so processImage skips generation
    writeFileSync(join(optimizedDir, filename), "existing");

    const config: any = {
      formats: ["webp"],
      lazyLoad: true,
      optimize: true,
      quality: { webp: 80 },
      sizes: "100vw",
      widths: [320],
    };

    // Clear mock call count before this specific test
    mockToFile.mockClear();

    const manifest = await processImage(imgPath, cacheImgDir, config);
    expect(manifest.variants).toHaveLength(1);
    // ToFile should NOT have been called since file already exists
    expect(mockToFile).not.toHaveBeenCalled();

    teardown();
  });

  test("uses multiple formats", async () => {
    const root = setup();
    const cacheImgDir = join(root, ".cache/images");

    // 80px wide so configured width matches original
    mockMetadata.mockImplementationOnce(() =>
      Promise.resolve({ format: "png", height: 60, width: 80 }),
    );

    const imgPath = join(root, "multi.png");
    writeFileSync(imgPath, "multi png");

    const config: any = {
      formats: ["webp", "avif"],
      lazyLoad: true,
      optimize: true,
      quality: { avif: 65, webp: 80 },
      sizes: "100vw",
      widths: [80],
    };

    const manifest = await processImage(imgPath, cacheImgDir, config);
    const formats = manifest.variants.map((v) => v.format);
    expect(formats).toContain("webp");
    expect(formats).toContain("avif");
    expect(manifest.variants).toHaveLength(2);

    teardown();
  });

  test("uses default quality 80 when format quality not specified", async () => {
    const root = setup();
    const cacheImgDir = join(root, ".cache/images");

    mockMetadata.mockImplementationOnce(() =>
      Promise.resolve({ format: "png", height: 100, width: 100 }),
    );

    const imgPath = join(root, "noqual.png");
    writeFileSync(imgPath, "no qual");

    const config: any = {
      formats: ["jpeg"],
      lazyLoad: true,
      optimize: true,
      quality: {}, // No jpeg quality specified
      sizes: "100vw",
      widths: [100],
    };

    mockToFormat.mockClear();
    const manifest = await processImage(imgPath, cacheImgDir, config);
    expect(manifest.variants).toHaveLength(1);
    expect(mockToFormat).toHaveBeenCalledWith("jpeg", { quality: 80 });

    teardown();
  });
});

// ─── Site-loader config tests ────────────────────────────────────────────────

describe("site-loader images config", () => {
  test("DEFAULTS include images config", async () => {
    const { loadProjectConfig } = await import("../src/site/site-loader.js");
    const root = setup();
    writeFileSync(join(root, "project.json"), JSON.stringify({ name: "Test" }));

    const { config } = loadProjectConfig(root);
    expect(config.images).toBeDefined();
    expect(config.images.optimize).toBe(true);
    expect(config.images.widths).toEqual([320, 640, 960, 1280, 1920]);
    expect(config.images.formats).toEqual(["webp", "avif"]);
    expect(config.images.quality).toEqual({
      avif: 65,
      jpeg: 80,
      png: 80,
      webp: 80,
    });
    expect(config.images.sizes).toBe("(max-width: 768px) 100vw, 50vw");
    expect(config.images.lazyLoad).toBe(true);

    teardown();
  });

  test("project.json images config merges with defaults", async () => {
    const { loadProjectConfig } = await import("../src/site/site-loader.js");
    const root = setup();
    writeFileSync(
      join(root, "project.json"),
      JSON.stringify({
        images: { optimize: false, widths: [400, 800] },
        name: "Test",
      }),
    );

    const { config } = loadProjectConfig(root);
    expect(config.images.optimize).toBe(false);
    expect(config.images.widths).toEqual([400, 800]);
    expect(config.images.formats).toEqual(["webp", "avif"]);

    teardown();
  });
});
