import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";

const TMP = resolve(tmpdir(), "jx-img-transform-test-" + Date.now());

function setup() {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
  mkdirSync(join(TMP, "public/images"), { recursive: true });
  mkdirSync(join(TMP, "out"), { recursive: true });
  // Create a fake image file so existsSync returns true
  writeFileSync(join(TMP, "public/images/hero.png"), "fake-png-data");
  return TMP;
}

function teardown() {
  rmSync(TMP, { recursive: true, force: true });
}

// Mock dependencies
const mockManifest = {
  original: { width: 1200, height: 800, format: "png" },
  variants: [
    {
      width: 640,
      format: "avif",
      outputPath: "/_optimized/hero-640-abc.avif",
      absolutePath: "/tmp/fake-640.avif",
    },
    {
      width: 1200,
      format: "avif",
      outputPath: "/_optimized/hero-1200-abc.avif",
      absolutePath: "/tmp/fake-1200.avif",
    },
    {
      width: 640,
      format: "webp",
      outputPath: "/_optimized/hero-640-abc.webp",
      absolutePath: "/tmp/fake-640.webp",
    },
    {
      width: 1200,
      format: "webp",
      outputPath: "/_optimized/hero-1200-abc.webp",
      absolutePath: "/tmp/fake-1200.webp",
    },
  ],
  contentHash: "abcd1234",
};

mock.module("../src/site/image-optimizer.js", () => ({
  processImage: mock(async () => mockManifest),
  buildSrcset: mock((/** @type {any[]} */ variants, /** @type {string} */ format) => {
    const filtered = variants.filter((/** @type {any} */ v) => v.format === format);
    if (filtered.length === 0) return "";
    return filtered.map((/** @type {any} */ v) => `${v.outputPath} ${v.width}w`).join(", ");
  }),
  contentHash: mock(() => "abcd1234"),
  configHash: mock(() => "cfg12345"),
}));

mock.module("../src/site/image-cache.js", () => ({
  getCached: mock(() => null),
  setCached: mock(() => {}),
}));

const { transformImageNodes } = await import("../src/site/image-transform.js");
/** @type {any} */
const { processImage, buildSrcset } = await import("../src/site/image-optimizer.js");
/** @type {any} */
const { getCached, setCached } = await import("../src/site/image-cache.js");

const defaultConfig = {
  optimize: true,
  widths: [640, 1200],
  formats: ["avif", "webp"],
  quality: { avif: 60, webp: 75 },
  sizes: "(max-width: 768px) 100vw, 50vw",
  lazyLoad: true,
};

describe("image-transform", () => {
  beforeEach(() => {
    setup();
    // Reset mocks to default behavior
    getCached.mockReset();
    getCached.mockReturnValue(null);
    setCached.mockReset();
    processImage.mockReset();
    processImage.mockResolvedValue(mockManifest);
  });

  afterEach(() => {
    teardown();
  });

  describe("transformImageNodes", () => {
    test("returns empty imageRefs when config.optimize is false", async () => {
      /** @type {any} */
      const doc = { tagName: "img", attributes: { src: "/images/hero.png" } };
      const config = { ...defaultConfig, optimize: false };
      const cache = { version: 1, entries: {} };

      const result = await transformImageNodes(doc, config, TMP, join(TMP, "out"), cache);
      expect(result.imageRefs.size).toBe(0);
    });

    test("transforms an img node with srcset, sizes, dimensions, and lazy loading", async () => {
      /** @type {any} */
      const doc = {
        tagName: "img",
        attributes: { src: "/images/hero.png" },
      };
      const cache = { version: 1, entries: {} };

      const result = await transformImageNodes(doc, defaultConfig, TMP, join(TMP, "out"), cache);

      expect(doc.attributes.srcset).toContain("/_optimized/hero-640-abc.avif 640w");
      expect(doc.attributes.srcset).toContain("/_optimized/hero-1200-abc.avif 1200w");
      expect(doc.attributes.sizes).toBe("(max-width: 768px) 100vw, 50vw");
      expect(doc.attributes.width).toBe("1200");
      expect(doc.attributes.height).toBe("800");
      expect(doc.attributes.loading).toBe("lazy");
      expect(doc.attributes.decoding).toBe("async");
      expect(result.imageRefs.size).toBe(1);
    });

    test("does not override existing width/height attributes", async () => {
      /** @type {any} */
      const doc = {
        tagName: "img",
        attributes: { src: "/images/hero.png", width: "400", height: "300" },
      };
      const cache = { version: 1, entries: {} };

      await transformImageNodes(doc, defaultConfig, TMP, join(TMP, "out"), cache);

      expect(doc.attributes.width).toBe("400");
      expect(doc.attributes.height).toBe("300");
    });

    test("does not add lazy loading when loading is eager", async () => {
      /** @type {any} */
      const doc = {
        tagName: "img",
        attributes: { src: "/images/hero.png", loading: "eager" },
      };
      const cache = { version: 1, entries: {} };

      await transformImageNodes(doc, defaultConfig, TMP, join(TMP, "out"), cache);

      expect(doc.attributes.loading).toBe("eager");
      expect(doc.attributes.decoding).toBeUndefined();
    });

    test("does not add lazy loading when config.lazyLoad is false", async () => {
      /** @type {any} */
      const doc = {
        tagName: "img",
        attributes: { src: "/images/hero.png" },
      };
      const config = { ...defaultConfig, lazyLoad: false };
      const cache = { version: 1, entries: {} };

      await transformImageNodes(doc, config, TMP, join(TMP, "out"), cache);

      expect(doc.attributes.loading).toBeUndefined();
      expect(doc.attributes.decoding).toBeUndefined();
    });

    test("skips images with data-no-optimize", async () => {
      /** @type {any} */
      const doc = {
        tagName: "img",
        attributes: { src: "/images/hero.png", "data-no-optimize": "" },
      };
      const cache = { version: 1, entries: {} };

      await transformImageNodes(doc, defaultConfig, TMP, join(TMP, "out"), cache);

      expect(doc.attributes.srcset).toBeUndefined();
    });

    test("skips non-existent images", async () => {
      /** @type {any} */
      const doc = {
        tagName: "img",
        attributes: { src: "/images/nonexistent.png" },
      };
      const cache = { version: 1, entries: {} };

      await transformImageNodes(doc, defaultConfig, TMP, join(TMP, "out"), cache);

      expect(doc.attributes.srcset).toBeUndefined();
    });

    test("uses cached manifest when variants exist on disk", async () => {
      // Create fake variant files so existsSync returns true for cached variants
      const variantPath = join(TMP, "cached-variant.avif");
      writeFileSync(variantPath, "fake");

      const cachedManifest = {
        original: { width: 800, height: 600, format: "png" },
        variants: [
          {
            width: 640,
            format: "avif",
            outputPath: "/_optimized/x.avif",
            absolutePath: variantPath,
          },
        ],
        contentHash: "abcd1234",
      };

      getCached.mockReturnValue(cachedManifest);

      /** @type {any} */
      const doc = {
        tagName: "img",
        attributes: { src: "/images/hero.png" },
      };
      const cache = { version: 1, entries: {} };

      await transformImageNodes(doc, defaultConfig, TMP, join(TMP, "out"), cache);

      // processImage should not have been called since cache hit
      expect(processImage).not.toHaveBeenCalled();
      expect(doc.attributes.width).toBe("800");
      expect(doc.attributes.height).toBe("600");
    });

    test("calls processImage when cached variants are missing from disk", async () => {
      // Return a cached manifest with a non-existent absolutePath
      const cachedManifest = {
        original: { width: 800, height: 600, format: "png" },
        variants: [
          {
            width: 640,
            format: "avif",
            outputPath: "/_optimized/x.avif",
            absolutePath: "/nonexistent/path.avif",
          },
        ],
        contentHash: "abcd1234",
      };

      getCached.mockReturnValue(cachedManifest);

      /** @type {any} */
      const doc = {
        tagName: "img",
        attributes: { src: "/images/hero.png" },
      };
      const cache = { version: 1, entries: {} };

      await transformImageNodes(doc, defaultConfig, TMP, join(TMP, "out"), cache);

      // Since cached variant doesn't exist on disk, processImage should NOT be called
      // because the code only calls processImage when `!cached` (line 42)
      // When cached exists but files are missing, it falls through without re-processing
      // Actually re-reading: line 40 checks allExist - if not allExist it falls through
      // Line 42: if (!cached) logs; then lines 43-45 run unconditionally
      // So processImage IS called when cached exists but files are gone
      expect(processImage).toHaveBeenCalled();
      expect(setCached).toHaveBeenCalled();
    });

    test("reuses manifest from imageRefs for duplicate images", async () => {
      /** @type {any} */
      const doc = {
        tagName: "div",
        children: [
          { tagName: "img", attributes: { src: "/images/hero.png" } },
          { tagName: "img", attributes: { src: "/images/hero.png" } },
        ],
      };
      const cache = { version: 1, entries: {} };

      await transformImageNodes(doc, defaultConfig, TMP, join(TMP, "out"), cache);

      // processImage should only be called once for the same absolute path
      expect(processImage).toHaveBeenCalledTimes(1);
      // Both img nodes should be transformed
      expect(doc.children[0].attributes.srcset).toBeDefined();
      expect(doc.children[1].attributes.srcset).toBeDefined();
    });

    test("resolves relative (non-slash) src paths via projectRoot", async () => {
      // Create a file at TMP/images/photo.jpg (non-public-dir path)
      mkdirSync(join(TMP, "images"), { recursive: true });
      writeFileSync(join(TMP, "images/photo.jpg"), "fake-jpg-data");

      /** @type {any} */
      const doc = {
        tagName: "img",
        attributes: { src: "images/photo.jpg" },
      };
      const cache = { version: 1, entries: {} };

      await transformImageNodes(doc, defaultConfig, TMP, join(TMP, "out"), cache);

      // Should resolve to TMP/images/photo.jpg and transform it
      expect(doc.attributes.srcset).toBeDefined();
      expect(processImage).toHaveBeenCalled();
    });

    test("uses first format when avif is not in formats list", async () => {
      const config = { ...defaultConfig, formats: ["webp"] };
      /** @type {any} */
      const doc = {
        tagName: "img",
        attributes: { src: "/images/hero.png" },
      };
      const cache = { version: 1, entries: {} };

      await transformImageNodes(doc, config, TMP, join(TMP, "out"), cache);

      // Should use webp since avif is not available
      expect(doc.attributes.srcset).toContain("webp");
    });

    test("does not set srcset when buildSrcset returns empty string", async () => {
      // Make buildSrcset return empty
      buildSrcset.mockReturnValueOnce("");

      /** @type {any} */
      const doc = {
        tagName: "img",
        attributes: { src: "/images/hero.png" },
      };
      const cache = { version: 1, entries: {} };

      await transformImageNodes(doc, defaultConfig, TMP, join(TMP, "out"), cache);

      expect(doc.attributes.srcset).toBeUndefined();
    });

    test("preserves existing sizes attribute on img node", async () => {
      /** @type {any} */
      const doc = {
        tagName: "img",
        attributes: { src: "/images/hero.png", sizes: "100vw" },
      };
      const cache = { version: 1, entries: {} };

      await transformImageNodes(doc, defaultConfig, TMP, join(TMP, "out"), cache);

      expect(doc.attributes.sizes).toBe("100vw");
    });

    test("walks children recursively", async () => {
      /** @type {any} */
      const doc = {
        tagName: "div",
        children: [
          {
            tagName: "section",
            children: [{ tagName: "img", attributes: { src: "/images/hero.png" } }],
          },
        ],
      };
      const cache = { version: 1, entries: {} };

      await transformImageNodes(doc, defaultConfig, TMP, join(TMP, "out"), cache);

      expect(doc.children[0].children[0].attributes.srcset).toBeDefined();
    });

    test("transforms img tags embedded in innerHTML strings", async () => {
      /** @type {any} */
      const doc = {
        tagName: "div",
        innerHTML: '<img src="/images/hero.png">',
      };
      const cache = { version: 1, entries: {} };

      await transformImageNodes(doc, defaultConfig, TMP, join(TMP, "out"), cache);

      expect(doc.innerHTML).toContain("srcset=");
      expect(doc.innerHTML).toContain("sizes=");
      expect(doc.innerHTML).toContain('loading="lazy"');
      expect(doc.innerHTML).toContain('decoding="async"');
      expect(doc.innerHTML).toContain('width="1200"');
      expect(doc.innerHTML).toContain('height="800"');
    });

    test("handles img node with src on node directly (not in attributes)", async () => {
      /** @type {any} */
      const doc = {
        tagName: "img",
        src: "/images/hero.png",
        attributes: {},
      };
      const cache = { version: 1, entries: {} };

      await transformImageNodes(doc, defaultConfig, TMP, join(TMP, "out"), cache);

      expect(doc.attributes.srcset).toBeDefined();
    });
  });

  describe("shouldSkip (tested via transformImageNodes)", () => {
    test("skips SVG images", async () => {
      writeFileSync(join(TMP, "public/images/icon.svg"), "<svg></svg>");
      /** @type {any} */
      const doc = { tagName: "img", attributes: { src: "/images/icon.svg" } };
      const cache = { version: 1, entries: {} };

      await transformImageNodes(doc, defaultConfig, TMP, join(TMP, "out"), cache);
      expect(doc.attributes.srcset).toBeUndefined();
    });

    test("skips GIF images", async () => {
      writeFileSync(join(TMP, "public/images/anim.gif"), "GIF89a");
      /** @type {any} */
      const doc = { tagName: "img", attributes: { src: "/images/anim.gif" } };
      const cache = { version: 1, entries: {} };

      await transformImageNodes(doc, defaultConfig, TMP, join(TMP, "out"), cache);
      expect(doc.attributes.srcset).toBeUndefined();
    });

    test("skips external URLs", async () => {
      /** @type {any} */
      const doc = { tagName: "img", attributes: { src: "https://example.com/img.png" } };
      const cache = { version: 1, entries: {} };

      await transformImageNodes(doc, defaultConfig, TMP, join(TMP, "out"), cache);
      expect(doc.attributes.srcset).toBeUndefined();
    });

    test("skips template literal expressions", async () => {
      /** @type {any} */
      const doc = { tagName: "img", attributes: { src: "/images/${name}.png" } };
      const cache = { version: 1, entries: {} };

      await transformImageNodes(doc, defaultConfig, TMP, join(TMP, "out"), cache);
      expect(doc.attributes.srcset).toBeUndefined();
    });

    test("skips data: URIs", async () => {
      /** @type {any} */
      const doc = { tagName: "img", attributes: { src: "data:image/png;base64,abc" } };
      const cache = { version: 1, entries: {} };

      await transformImageNodes(doc, defaultConfig, TMP, join(TMP, "out"), cache);
      expect(doc.attributes.srcset).toBeUndefined();
    });
  });
});
