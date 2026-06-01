import { describe, test, expect, mock, beforeEach } from "bun:test";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";

// Mock sharp module before any imports that use it
const mockToFile = mock(() => Promise.resolve());
const mockToFormat = mock(() => ({ toFile: mockToFile }));
const mockResize = mock(() => ({ toFormat: mockToFormat }));
const mockMetadata = mock(() => Promise.resolve({ width: 800, height: 600, format: "jpeg" }));
const mockSharpInstance = { metadata: mockMetadata, resize: mockResize };
const mockSharp = mock(() => mockSharpInstance);
mock.module("sharp", () => ({ default: mockSharp }));

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

const TMP = resolve(tmpdir(), "jx-image-test-" + Date.now());

function setup() {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
  mkdirSync(join(TMP, "public/images"), { recursive: true });
  return TMP;
}

function teardown() {
  rmSync(TMP, { recursive: true, force: true });
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
        width: 320,
        format: "webp",
        outputPath: "/images/_optimized/hero-320-abc.webp",
        absolutePath: "",
      },
      {
        width: 640,
        format: "webp",
        outputPath: "/images/_optimized/hero-640-abc.webp",
        absolutePath: "",
      },
      {
        width: 320,
        format: "avif",
        outputPath: "/images/_optimized/hero-320-abc.avif",
        absolutePath: "",
      },
      {
        width: 640,
        format: "avif",
        outputPath: "/images/_optimized/hero-640-abc.avif",
        absolutePath: "",
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
      optimize: true,
      widths: [320, 640],
      formats: ["webp"],
      quality: { webp: 80 },
      sizes: "100vw",
      lazyLoad: true,
    });
    expect(hash).toHaveLength(8);
    expect(hash).toMatch(/^[0-9a-f]{8}$/);
  });

  test("configHash changes with different settings", () => {
    const base = { optimize: true, sizes: "100vw", lazyLoad: true };
    const hashA = configHash({ ...base, widths: [320], formats: ["webp"], quality: { webp: 80 } });
    const hashB = configHash({ ...base, widths: [640], formats: ["webp"], quality: { webp: 80 } });
    expect(hashA).not.toBe(hashB);
  });
});

// ─── Cache tests ─────────────────────────────────────────────────────────────

describe("image-cache", () => {
  test("loadCache returns empty manifest when no cache exists", () => {
    const cache = loadCache("/nonexistent/path");
    expect(cache).toEqual({ version: 1, entries: {} });
  });

  test("saveCache and loadCache round-trip", () => {
    const root = setup();
    const cache = {
      version: 1,
      entries: {
        "abc:def": {
          source: "test.jpg",
          manifest: {
            original: { width: 100, height: 100, format: "jpeg" },
            variants: [],
            contentHash: "abc",
          },
          timestamp: 1000,
        },
      },
    };

    saveCache(root, cache);
    const loaded = loadCache(root);
    expect(loaded.entries["abc:def"].source).toBe("test.jpg");
    teardown();
  });

  test("getCached returns null for missing key", () => {
    const cache = { version: 1, entries: {} };
    expect(getCached(cache, "missing")).toBeNull();
  });

  test("getCached returns manifest regardless of output file existence", () => {
    const manifest = {
      original: { width: 800, height: 600, format: "jpeg" },
      variants: [
        {
          width: 320,
          format: "avif",
          outputPath: "/images/_optimized/hero-320-abc.avif",
          absolutePath: "/nonexistent/dist/images/_optimized/hero-320-abc.avif",
        },
      ],
      contentHash: "abc",
    };
    const cache = {
      version: 1,
      entries: {
        "abc:def": { source: "hero.jpg", manifest, timestamp: 1000 },
      },
    };
    const result = getCached(cache, "abc:def");
    expect(result).not.toBeNull();
    expect(result?.original!.width).toBe(800);
    expect(result?.variants).toHaveLength(1);
  });

  test("setCached stores entry", () => {
    const cache = { version: 1, entries: {} as Record<string, any> };
    const manifest = {
      original: { width: 800, height: 600, format: "jpeg" },
      variants: [],
      contentHash: "abc",
    };
    setCached(cache, "key1", "test.jpg", manifest);
    expect(cache.entries["key1"]).toBeDefined();
    expect(cache.entries["key1"].source).toBe("test.jpg");
  });
});

// ─── Transform tests (no Sharp — tests skip conditions and tree walking) ─────

describe("image-transform", () => {
  const defaultConfig = {
    optimize: true,
    widths: [320, 640],
    formats: ["webp", "avif"],
    quality: { webp: 80, avif: 65 },
    sizes: "(max-width: 768px) 100vw, 50vw",
    lazyLoad: true,
  };

  test("skips when optimize is false", async () => {
    const doc = {
      tagName: "div",
      children: [
        {
          tagName: "img",
          attributes: /** @type {Record<string, any>} */ ({ src: "/images/hero.jpg" }),
        },
      ],
    };
    const cache = { version: 1, entries: {} };
    const result = await transformImageNodes(
      doc,
      { ...defaultConfig, optimize: false },
      "/tmp",
      "/tmp/dist",
      cache,
    );
    expect(result.imageRefs.size).toBe(0);
    expect((doc.children[0].attributes as Record<string, unknown>)?.srcset).toBeUndefined();
  });

  test("skips template string src", async () => {
    const root = setup();
    const doc = {
      tagName: "div",
      children: [{ tagName: "img", attributes: { src: "${state.image}" } }],
    };
    const cache = { version: 1, entries: {} };
    const result = await transformImageNodes(doc, defaultConfig, root, join(root, "dist"), cache);
    expect(result.imageRefs.size).toBe(0);
    teardown();
  });

  test("skips external URLs", async () => {
    const root = setup();
    const doc = {
      tagName: "div",
      children: [
        { tagName: "img", attributes: { src: "https://example.com/img.jpg" } },
        { tagName: "img", attributes: { src: "data:image/png;base64,abc" } },
        { tagName: "img", attributes: { src: "//cdn.example.com/img.jpg" } },
      ],
    };
    const cache = { version: 1, entries: {} };
    const result = await transformImageNodes(doc, defaultConfig, root, join(root, "dist"), cache);
    expect(result.imageRefs.size).toBe(0);
    teardown();
  });

  test("skips SVG and GIF files", async () => {
    const root = setup();
    writeFileSync(join(root, "public/images/icon.svg"), "<svg></svg>");
    writeFileSync(join(root, "public/images/anim.gif"), "GIF89a");

    const doc = {
      tagName: "div",
      children: [
        { tagName: "img", attributes: { src: "/images/icon.svg" } },
        { tagName: "img", attributes: { src: "/images/anim.gif" } },
      ],
    };
    const cache = { version: 1, entries: {} };
    const result = await transformImageNodes(doc, defaultConfig, root, join(root, "dist"), cache);
    expect(result.imageRefs.size).toBe(0);
    teardown();
  });

  test("skips data-no-optimize images", async () => {
    const root = setup();
    writeFileSync(join(root, "public/images/hero.jpg"), "fake jpg data");

    const doc = {
      tagName: "div",
      children: [
        { tagName: "img", attributes: { src: "/images/hero.jpg", "data-no-optimize": "" } },
      ],
    };
    const cache = { version: 1, entries: {} };
    const result = await transformImageNodes(doc, defaultConfig, root, join(root, "dist"), cache);
    expect(result.imageRefs.size).toBe(0);
    teardown();
  });

  test("skips when source file does not exist", async () => {
    const root = setup();
    const doc = {
      tagName: "div",
      children: [{ tagName: "img", attributes: { src: "/images/nonexistent.jpg" } }],
    };
    const cache = { version: 1, entries: {} };
    const result = await transformImageNodes(doc, defaultConfig, root, join(root, "dist"), cache);
    expect(result.imageRefs.size).toBe(0);
    teardown();
  });

  test("walks nested children", async () => {
    const root = setup();
    const doc = {
      tagName: "div",
      children: [
        {
          tagName: "section",
          children: [
            { tagName: "p", textContent: "text" },
            { tagName: "img", attributes: { src: "https://external.com/photo.jpg" } },
          ],
        },
      ],
    };
    const cache = { version: 1, entries: {} };
    const result = await transformImageNodes(doc, defaultConfig, root, join(root, "dist"), cache);
    expect(result.imageRefs.size).toBe(0);
    teardown();
  });

  test("transforms img tags inside innerHTML strings", async () => {
    const root = setup();
    writeFileSync(join(root, "public/images/photo.jpg"), "fake jpg data");

    const distOptDir = join(root, "dist/images/_optimized");
    mkdirSync(distOptDir, { recursive: true });

    const manifest = {
      original: { width: 1200, height: 800, format: "jpeg" },
      variants: [
        {
          width: 320,
          format: "avif",
          outputPath: "/images/_optimized/photo-320-abc.avif",
          absolutePath: join(distOptDir, "photo-320-abc.avif"),
        },
        {
          width: 640,
          format: "avif",
          outputPath: "/images/_optimized/photo-640-abc.avif",
          absolutePath: join(distOptDir, "photo-640-abc.avif"),
        },
      ],
      contentHash: "abc12345",
    };

    for (const v of manifest.variants) writeFileSync(v.absolutePath, "");

    const cache = { version: 1, entries: {} as Record<string, any> };
    setCached(
      cache,
      `${contentHash(join(root, "public/images/photo.jpg"))}:${configHash(defaultConfig)}`,
      "/images/photo.jpg",
      manifest,
    );

    const doc = {
      tagName: "my-component",
      innerHTML: '<img class="hero" src="/images/photo.jpg" alt="Photo">',
    };

    await transformImageNodes(doc, defaultConfig, root, join(root, "dist"), cache);

    expect(doc.innerHTML).toContain("srcset=");
    expect(doc.innerHTML).toContain("photo-320-abc.avif 320w");
    expect(doc.innerHTML).toContain("photo-640-abc.avif 640w");
    expect(doc.innerHTML).toContain('width="1200"');
    expect(doc.innerHTML).toContain('height="800"');
    expect(doc.innerHTML).toContain('sizes="');

    teardown();
  });

  test("innerHTML: skips img tags that already have srcset", async () => {
    const root = setup();
    writeFileSync(join(root, "public/images/photo.jpg"), "fake jpg data");

    const doc = {
      tagName: "my-component",
      innerHTML: '<img src="/images/photo.jpg" srcset="already-set" alt="Photo">',
    };
    const cache = { version: 1, entries: {} };

    await transformImageNodes(doc, defaultConfig, root, join(root, "dist"), cache);
    expect(doc.innerHTML).toBe('<img src="/images/photo.jpg" srcset="already-set" alt="Photo">');
    teardown();
  });

  test("innerHTML: skips data-no-optimize img tags", async () => {
    const root = setup();
    writeFileSync(join(root, "public/images/photo.jpg"), "fake jpg data");

    const doc = {
      tagName: "my-component",
      innerHTML: '<img src="/images/photo.jpg" data-no-optimize alt="Photo">',
    };
    const cache = { version: 1, entries: {} };

    await transformImageNodes(doc, defaultConfig, root, join(root, "dist"), cache);
    expect(doc.innerHTML).not.toContain("srcset=");
    teardown();
  });

  test("innerHTML: skips template strings and external URLs", async () => {
    const root = setup();
    const doc = {
      tagName: "my-component",
      innerHTML:
        '<img src="${state.image}" alt="Dynamic"><img src="https://cdn.example.com/img.jpg" alt="External">',
    };
    const cache = { version: 1, entries: {} };

    await transformImageNodes(doc, defaultConfig, root, join(root, "dist"), cache);
    expect(doc.innerHTML).not.toContain("srcset=");
    teardown();
  });

  test("innerHTML: preserves existing loading and decoding attributes", async () => {
    const root = setup();
    writeFileSync(join(root, "public/images/hero.jpg"), "fake jpg data");

    const distOptDir = join(root, "dist/images/_optimized");
    mkdirSync(distOptDir, { recursive: true });

    const manifest = {
      original: { width: 800, height: 600, format: "jpeg" },
      variants: [
        {
          width: 320,
          format: "avif",
          outputPath: "/images/_optimized/hero-320-abc.avif",
          absolutePath: join(distOptDir, "hero-320-abc.avif"),
        },
      ],
      contentHash: "abc12345",
    };
    for (const v of manifest.variants) writeFileSync(v.absolutePath, "");

    const cache = { version: 1, entries: {} as Record<string, any> };
    setCached(
      cache,
      `${contentHash(join(root, "public/images/hero.jpg"))}:${configHash(defaultConfig)}`,
      "/images/hero.jpg",
      manifest,
    );

    const doc = {
      tagName: "my-component",
      innerHTML: '<img src="/images/hero.jpg" loading="eager" decoding="sync">',
    };

    await transformImageNodes(doc, defaultConfig, root, join(root, "dist"), cache);
    expect(doc.innerHTML).toContain('loading="eager"');
    expect(doc.innerHTML).not.toContain('loading="lazy"');
    expect(doc.innerHTML).not.toContain('decoding="async"');
    teardown();
  });

  test("innerHTML: handles multiple img tags in one string", async () => {
    const root = setup();
    writeFileSync(join(root, "public/images/a.jpg"), "fake a");
    writeFileSync(join(root, "public/images/b.jpg"), "fake b");

    const distOptDir = join(root, "dist/images/_optimized");
    mkdirSync(distOptDir, { recursive: true });

    const makeManifest = (name: string) => {
      const m = {
        original: { width: 640, height: 480, format: "jpeg" },
        variants: [
          {
            width: 320,
            format: "avif",
            outputPath: `/images/_optimized/${name}-320-abc.avif`,
            absolutePath: join(distOptDir, `${name}-320-abc.avif`),
          },
        ],
        contentHash: "abc12345",
      };
      for (const v of m.variants) writeFileSync(v.absolutePath, "");
      return m;
    };

    const cache = { version: 1, entries: {} as Record<string, any> };
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
      tagName: "my-component",
      innerHTML:
        '<div><img src="/images/a.jpg" alt="A"><p>text</p><img src="/images/b.jpg" alt="B"></div>',
    };

    await transformImageNodes(doc, defaultConfig, root, join(root, "dist"), cache);
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
      Promise.resolve({ width: undefined, height: undefined, format: undefined } as unknown as {
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
      Promise.resolve({ width: 800, height: 600, format: "jpeg" }),
    );
  });

  test("generates variants for configured widths and formats", async () => {
    const root = setup();
    const outDir = join(root, "dist");
    mkdirSync(outDir, { recursive: true });

    const imgPath = join(root, "hero.jpg");
    writeFileSync(imgPath, "fake jpeg data");

    const config: any = {
      optimize: true,
      widths: [320, 640],
      formats: ["webp"],
      quality: { webp: 80 },
      sizes: "100vw",
      lazyLoad: true,
    };

    const manifest = await processImage(imgPath, outDir, config);

    expect(manifest.original.width).toBe(800);
    expect(manifest.original.height).toBe(600);
    expect(manifest.original.format).toBe("jpeg");
    expect(manifest.contentHash).toHaveLength(8);
    // 320, 640, and 800 (original) each in webp = 3 variants
    expect(manifest.variants).toHaveLength(3);

    const widths = manifest.variants.map((v) => v.width);
    expect(widths).toContain(320);
    expect(widths).toContain(640);
    expect(widths).toContain(800); // original width added

    for (const v of manifest.variants) {
      expect(v.format).toBe("webp");
      expect(v.outputPath).toContain("images/_optimized/hero-");
      expect(v.absolutePath).toContain(outDir);
    }

    teardown();
  });

  test("adds original width when no configured widths are smaller", async () => {
    const root = setup();
    const outDir = join(root, "dist");
    mkdirSync(outDir, { recursive: true });

    // Image is only 50px wide
    mockMetadata.mockImplementationOnce(() =>
      Promise.resolve({ width: 50, height: 50, format: "png" }),
    );

    const imgPath = join(root, "small.png");
    writeFileSync(imgPath, "small png");

    const config: any = {
      optimize: true,
      widths: [800, 1200, 1920],
      formats: ["webp"],
      quality: { webp: 80 },
      sizes: "100vw",
      lazyLoad: true,
    };

    const manifest = await processImage(imgPath, outDir, config);
    const widths = manifest.variants.map((v) => v.width);
    // All configured widths > 50, so only original width is used
    expect(widths).toEqual([50]);

    teardown();
  });

  test("skips variant generation if output file already exists", async () => {
    const root = setup();
    const outDir = join(root, "dist");
    const optimizedDir = join(outDir, "images/_optimized");
    mkdirSync(optimizedDir, { recursive: true });

    // Image is 320px wide so only one width variant
    mockMetadata.mockImplementationOnce(() =>
      Promise.resolve({ width: 320, height: 240, format: "png" }),
    );

    const imgPath = join(root, "cached.png");
    writeFileSync(imgPath, "cached png data");

    const hash8 = contentHash(imgPath);
    const filename = variantFilename("cached", 320, hash8, "webp");
    // Pre-create the output file so processImage skips generation
    writeFileSync(join(optimizedDir, filename), "existing");

    const config: any = {
      optimize: true,
      widths: [320],
      formats: ["webp"],
      quality: { webp: 80 },
      sizes: "100vw",
      lazyLoad: true,
    };

    // Clear mock call count before this specific test
    mockToFile.mockClear();

    const manifest = await processImage(imgPath, outDir, config);
    expect(manifest.variants).toHaveLength(1);
    // toFile should NOT have been called since file already exists
    expect(mockToFile).not.toHaveBeenCalled();

    teardown();
  });

  test("uses multiple formats", async () => {
    const root = setup();
    const outDir = join(root, "dist");
    mkdirSync(outDir, { recursive: true });

    // 80px wide so configured width matches original
    mockMetadata.mockImplementationOnce(() =>
      Promise.resolve({ width: 80, height: 60, format: "png" }),
    );

    const imgPath = join(root, "multi.png");
    writeFileSync(imgPath, "multi png");

    const config: any = {
      optimize: true,
      widths: [80],
      formats: ["webp", "avif"],
      quality: { webp: 80, avif: 65 },
      sizes: "100vw",
      lazyLoad: true,
    };

    const manifest = await processImage(imgPath, outDir, config);
    const formats = manifest.variants.map((v) => v.format);
    expect(formats).toContain("webp");
    expect(formats).toContain("avif");
    expect(manifest.variants).toHaveLength(2);

    teardown();
  });

  test("uses default quality 80 when format quality not specified", async () => {
    const root = setup();
    const outDir = join(root, "dist");
    mkdirSync(outDir, { recursive: true });

    mockMetadata.mockImplementationOnce(() =>
      Promise.resolve({ width: 100, height: 100, format: "png" }),
    );

    const imgPath = join(root, "noqual.png");
    writeFileSync(imgPath, "no qual");

    const config: any = {
      optimize: true,
      widths: [100],
      formats: ["jpeg"],
      quality: {}, // no jpeg quality specified
      sizes: "100vw",
      lazyLoad: true,
    };

    mockToFormat.mockClear();
    const manifest = await processImage(imgPath, outDir, config);
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
    expect(config.images.quality).toEqual({ webp: 80, avif: 65, jpeg: 80, png: 80 });
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
        name: "Test",
        images: { widths: [400, 800], optimize: false },
      }),
    );

    const { config } = loadProjectConfig(root);
    expect(config.images.optimize).toBe(false);
    expect(config.images.widths).toEqual([400, 800]);
    expect(config.images.formats).toEqual(["webp", "avif"]);

    teardown();
  });
});
