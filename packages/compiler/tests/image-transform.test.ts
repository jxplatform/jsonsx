import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const TMP = resolve(tmpdir(), `jx-img-transform-test-${Date.now()}`);

function setup() {
  rmSync(TMP, { force: true, recursive: true });
  mkdirSync(TMP, { recursive: true });
  mkdirSync(join(TMP, "public/images"), { recursive: true });
  mkdirSync(join(TMP, "out"), { recursive: true });
  // Create a fake image file so existsSync returns true
  writeFileSync(join(TMP, "public/images/hero.png"), "fake-png-data");
  return TMP;
}

function teardown() {
  rmSync(TMP, { force: true, recursive: true });
}

// Mock dependencies
const mockManifest = {
  contentHash: "abcd1234",
  original: { format: "png", height: 800, width: 1200 },
  variants: [
    {
      absolutePath: "/tmp/fake-640.avif",
      format: "avif",
      outputPath: "/_optimized/hero-640-abc.avif",
      width: 640,
    },
    {
      absolutePath: "/tmp/fake-1200.avif",
      format: "avif",
      outputPath: "/_optimized/hero-1200-abc.avif",
      width: 1200,
    },
    {
      absolutePath: "/tmp/fake-640.webp",
      format: "webp",
      outputPath: "/_optimized/hero-640-abc.webp",
      width: 640,
    },
    {
      absolutePath: "/tmp/fake-1200.webp",
      format: "webp",
      outputPath: "/_optimized/hero-1200-abc.webp",
      width: 1200,
    },
  ],
};

void mock.module("../src/site/image-optimizer.js", () => ({
  buildSrcset: mock((variants: any[], format: string) => {
    const filtered = variants.filter((v: any) => v.format === format);
    if (filtered.length === 0) {
      return "";
    }
    return filtered.map((v: any) => `${v.outputPath} ${v.width}w`).join(", ");
  }),
  configHash: mock(() => "cfg12345"),
  contentHash: mock(() => "abcd1234"),
  getImageMetadata: mock(async () => ({
    format: "png",
    height: 800,
    width: 1200,
  })),
  processImage: mock(async () => mockManifest),
}));

void mock.module("../src/site/image-cache.js", () => ({
  getCached: mock(() => null),
  getImageCacheDir: mock((root: string) => `${root}/.cache/images`),
  setCached: mock(() => {}),
}));

const { transformImageNodes } = await import("../src/site/image-transform.js");
const { processImage, buildSrcset, getImageMetadata }: any =
  await import("../src/site/image-optimizer.js");
const { getCached, setCached }: any = await import("../src/site/image-cache.js");

const defaultConfig = {
  formats: ["avif", "webp"],
  lazyLoad: true,
  optimize: true,
  quality: { avif: 60, webp: 75 },
  sizes: "(max-width: 768px) 100vw, 50vw",
  widths: [640, 1200],
};

/**
 * The `<img>` a transform produced, whether or not it ended up inside a `<picture>`. A multi-format
 * image is wrapped (the sources carry the candidate lists); everything else stays a bare `<img>`.
 */
const imgOf = (node: any) => (node.tagName === "picture" ? node.children.at(-1) : node);
/** The `<source>` elements of a generated `<picture>`. */
const sourcesOf = (node: any) => (node.children ?? []).filter((c: any) => c.tagName === "source");

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
      const doc: any = {
        attributes: { src: "/images/hero.png" },
        tagName: "img",
      };
      const config = { ...defaultConfig, optimize: false };
      const cache = { entries: {}, version: 1 };

      const result = await transformImageNodes(doc, config, TMP, cache);
      expect(result.imageRefs.size).toBe(0);
    });

    /*
     * Two formats, so the node becomes a `<picture>`. A bare `<img srcset>` cannot say which
     * candidate is AVIF, so a browser that cannot decode AVIF would pick one anyway; `<source
     * type>` is the only markup that lets it decline.
     */
    test("wraps a multi-format image in a picture, one source per format", async () => {
      const doc: any = {
        attributes: { src: "/images/hero.png" },
        tagName: "img",
      };
      const cache = { entries: {}, version: 1 };

      const result = await transformImageNodes(doc, defaultConfig, TMP, cache);

      expect(doc.tagName).toBe("picture");
      const sources = sourcesOf(doc);
      expect(sources.map((s: any) => s.attributes.type)).toEqual(["image/avif", "image/webp"]);
      expect(sources[0].attributes.srcset).toContain("/_optimized/hero-640-abc.avif 640w");
      expect(sources[0].attributes.srcset).toContain("/_optimized/hero-1200-abc.avif 1200w");
      expect(sources[1].attributes.srcset).toContain("/_optimized/hero-640-abc.webp 640w");
      expect(sources[0].attributes.sizes).toBe("(max-width: 768px) 100vw, 50vw");

      // The <img> is the fallback: the original src, no candidate list to mis-select from.
      const img = imgOf(doc);
      expect(img.attributes.src).toBe("/images/hero.png");
      expect(img.attributes.srcset).toBeUndefined();
      expect(img.attributes.sizes).toBeUndefined();
      expect(img.attributes.width).toBe("1200");
      expect(img.attributes.height).toBe("800");
      expect(img.attributes.loading).toBe("lazy");
      expect(img.attributes.decoding).toBe("async");
      expect(result.imageRefs.size).toBe(1);
    });

    test("a single configured format stays a bare img with a srcset", async () => {
      const doc: any = { attributes: { src: "/images/hero.png" }, tagName: "img" };

      await transformImageNodes(doc, { ...defaultConfig, formats: ["webp"] }, TMP, {
        entries: {},
        version: 1,
      });

      expect(doc.tagName).toBe("img");
      expect(doc.attributes.srcset).toContain("/_optimized/hero-640-abc.webp 640w");
      expect(doc.attributes.sizes).toBe("(max-width: 768px) 100vw, 50vw");
    });

    test("images.picture false keeps the bare img even with two formats", async () => {
      const doc: any = { attributes: { src: "/images/hero.png" }, tagName: "img" };

      await transformImageNodes(doc, { ...defaultConfig, picture: false }, TMP, {
        entries: {},
        version: 1,
      });

      expect(doc.tagName).toBe("img");
      expect(doc.attributes.srcset).toContain(".avif");
    });

    test("does not override existing width/height attributes", async () => {
      const doc: any = {
        attributes: { height: "300", src: "/images/hero.png", width: "400" },
        tagName: "img",
      };
      const cache = { entries: {}, version: 1 };

      await transformImageNodes(doc, defaultConfig, TMP, cache);

      expect(imgOf(doc).attributes.width).toBe("400");
      expect(imgOf(doc).attributes.height).toBe("300");
    });

    test("does not add lazy loading when loading is eager", async () => {
      const doc: any = {
        attributes: { loading: "eager", src: "/images/hero.png" },
        tagName: "img",
      };
      const cache = { entries: {}, version: 1 };

      await transformImageNodes(doc, defaultConfig, TMP, cache);

      expect(imgOf(doc).attributes.loading).toBe("eager");
      expect(imgOf(doc).attributes.decoding).toBeUndefined();
    });

    /*
     * `fetchpriority="high"` marks the LCP image. Lazy-loading it would defeat the only lever an
     * author has over that metric, so the two never appear together.
     */
    test("does not add lazy loading when the author marked the image high priority", async () => {
      const doc: any = {
        attributes: { fetchpriority: "high", src: "/images/hero.png" },
        tagName: "img",
      };

      await transformImageNodes(doc, defaultConfig, TMP, { entries: {}, version: 1 });

      const img = imgOf(doc);
      expect(img.attributes.fetchpriority).toBe("high");
      expect(img.attributes.loading).toBeUndefined();
      expect(img.attributes.decoding).toBeUndefined();
    });

    /*
     * The loading pass is not the optimizer. Turning variant generation off says nothing about
     * when the browser should fetch the image, and it used to be the static emitter — which knew
     * nothing about either setting — that decided.
     */
    test("still applies lazy loading when optimize is off", async () => {
      const doc: any = { attributes: { src: "/images/hero.png" }, tagName: "img" };

      await transformImageNodes(doc, { ...defaultConfig, optimize: false }, TMP, {
        entries: {},
        version: 1,
      });

      expect(doc.attributes.loading).toBe("lazy");
      expect(doc.attributes.decoding).toBe("async");
      expect(doc.attributes.srcset).toBeUndefined();
    });

    test("does not add lazy loading when config.lazyLoad is false", async () => {
      const doc: any = {
        attributes: { src: "/images/hero.png" },
        tagName: "img",
      };
      const config = { ...defaultConfig, lazyLoad: false };
      const cache = { entries: {}, version: 1 };

      await transformImageNodes(doc, config, TMP, cache);

      expect(doc.attributes.loading).toBeUndefined();
      expect(doc.attributes.decoding).toBeUndefined();
    });

    test("skips images with data-no-optimize", async () => {
      const doc: any = {
        attributes: { "data-no-optimize": "", src: "/images/hero.png" },
        tagName: "img",
      };
      const cache = { entries: {}, version: 1 };

      await transformImageNodes(doc, defaultConfig, TMP, cache);

      expect(doc.attributes.srcset).toBeUndefined();
    });

    test("skips non-existent images", async () => {
      const doc: any = {
        attributes: { src: "/images/nonexistent.png" },
        tagName: "img",
      };
      const cache = { entries: {}, version: 1 };

      await transformImageNodes(doc, defaultConfig, TMP, cache);

      expect(doc.attributes.srcset).toBeUndefined();
    });

    test("uses cached manifest when variants exist on disk", async () => {
      // Create fake variant files so existsSync returns true for cached variants
      const variantPath = join(TMP, "cached-variant.avif");
      writeFileSync(variantPath, "fake");

      const cachedManifest = {
        contentHash: "abcd1234",
        original: { format: "png", height: 600, width: 800 },
        variants: [
          {
            absolutePath: variantPath,
            format: "avif",
            outputPath: "/_optimized/x.avif",
            width: 640,
          },
        ],
      };

      getCached.mockReturnValue(cachedManifest);

      const doc: any = {
        attributes: { src: "/images/hero.png" },
        tagName: "img",
      };
      const cache = { entries: {}, version: 1 };

      await transformImageNodes(doc, defaultConfig, TMP, cache);

      // ProcessImage should not have been called since cache hit
      expect(processImage).not.toHaveBeenCalled();
      expect(doc.attributes.width).toBe("800");
      expect(doc.attributes.height).toBe("600");
    });

    test("calls processImage when cached variants are missing from disk", async () => {
      // Return a cached manifest with a non-existent absolutePath
      const cachedManifest = {
        contentHash: "abcd1234",
        original: { format: "png", height: 600, width: 800 },
        variants: [
          {
            absolutePath: "/nonexistent/path.avif",
            format: "avif",
            outputPath: "/_optimized/x.avif",
            width: 640,
          },
        ],
      };

      getCached.mockReturnValue(cachedManifest);

      const doc: any = {
        attributes: { src: "/images/hero.png" },
        tagName: "img",
      };
      const cache = { entries: {}, version: 1 };

      await transformImageNodes(doc, defaultConfig, TMP, cache);

      // Since cached variant doesn't exist on disk, processImage should NOT be called
      // Because the code only calls processImage when `!cached` (line 42)
      // When cached exists but files are missing, it falls through without re-processing
      // Actually re-reading: line 40 checks allExist - if not allExist it falls through
      // Line 42: if (!cached) logs; then lines 43-45 run unconditionally
      // So processImage IS called when cached exists but files are gone
      expect(processImage).toHaveBeenCalled();
      expect(setCached).toHaveBeenCalled();
    });

    test("reuses manifest from imageRefs for duplicate images", async () => {
      const doc: any = {
        children: [
          { attributes: { src: "/images/hero.png" }, tagName: "img" },
          { attributes: { src: "/images/hero.png" }, tagName: "img" },
        ],
        tagName: "div",
      };
      const cache = { entries: {}, version: 1 };

      await transformImageNodes(doc, defaultConfig, TMP, cache);

      // ProcessImage should only be called once for the same absolute path
      expect(processImage).toHaveBeenCalledTimes(1);
      // Both img nodes should be transformed
      expect(sourcesOf(doc.children[0])).toHaveLength(2);
      expect(sourcesOf(doc.children[1])).toHaveLength(2);
    });

    test("resolves relative (non-slash) src paths via projectRoot", async () => {
      // Create a file at TMP/images/photo.jpg (non-public-dir path)
      mkdirSync(join(TMP, "images"), { recursive: true });
      writeFileSync(join(TMP, "images/photo.jpg"), "fake-jpg-data");

      const doc: any = {
        attributes: { src: "images/photo.jpg" },
        tagName: "img",
      };
      const cache = { entries: {}, version: 1 };

      await transformImageNodes(doc, defaultConfig, TMP, cache);

      // Should resolve to TMP/images/photo.jpg and transform it
      expect(sourcesOf(doc)).toHaveLength(2);
      expect(processImage).toHaveBeenCalled();
    });

    test("uses first format when avif is not in formats list", async () => {
      const config = { ...defaultConfig, formats: ["webp"] };
      const doc: any = {
        attributes: { src: "/images/hero.png" },
        tagName: "img",
      };
      const cache = { entries: {}, version: 1 };

      await transformImageNodes(doc, config, TMP, cache);

      // Should use webp since avif is not available
      expect(doc.attributes.srcset).toContain("webp");
    });

    test("does not set srcset when buildSrcset returns empty string", async () => {
      // Make buildSrcset return empty for the one configured format
      buildSrcset.mockReturnValueOnce("");

      const doc: any = {
        attributes: { src: "/images/hero.png" },
        tagName: "img",
      };
      const cache = { entries: {}, version: 1 };

      await transformImageNodes(doc, { ...defaultConfig, formats: ["webp"] }, TMP, cache);

      expect(doc.attributes.srcset).toBeUndefined();
      // Dimensions survive: they prevent layout shift whether or not variants exist.
      expect(doc.attributes.width).toBe("1200");
    });

    test("preserves existing sizes attribute on img node", async () => {
      const doc: any = {
        attributes: { sizes: "100vw", src: "/images/hero.png" },
        tagName: "img",
      };
      const cache = { entries: {}, version: 1 };

      await transformImageNodes(doc, defaultConfig, TMP, cache);

      // The author's sizes moves onto the sources, which are what the browser now selects from.
      expect(sourcesOf(doc).map((s: any) => s.attributes.sizes)).toEqual(["100vw", "100vw"]);
      expect(imgOf(doc).attributes.sizes).toBeUndefined();
    });

    test("walks children recursively", async () => {
      const doc: any = {
        children: [
          {
            children: [{ attributes: { src: "/images/hero.png" }, tagName: "img" }],
            tagName: "section",
          },
        ],
        tagName: "div",
      };
      const cache = { entries: {}, version: 1 };

      await transformImageNodes(doc, defaultConfig, TMP, cache);

      expect(doc.children[0].children[0].tagName).toBe("picture");
      expect(sourcesOf(doc.children[0].children[0])).toHaveLength(2);
    });

    test("transforms img tags embedded in innerHTML strings", async () => {
      const doc: any = {
        innerHTML: '<img src="/images/hero.png">',
        tagName: "div",
      };
      const cache = { entries: {}, version: 1 };

      await transformImageNodes(doc, defaultConfig, TMP, cache);

      expect(doc.innerHTML).toContain("<picture>");
      expect(doc.innerHTML).toContain('<source type="image/avif"');
      expect(doc.innerHTML).toContain('<source type="image/webp"');
      expect(doc.innerHTML).toContain('loading="lazy"');
      expect(doc.innerHTML).toContain('decoding="async"');
      expect(doc.innerHTML).toContain('width="1200" height="800"');
      // The <img> fallback carries no candidate list, exactly as in the node path.
      expect(/<img[^>]*srcset=/.test(doc.innerHTML)).toBe(false);
    });

    test("handles img node with src on node directly (not in attributes)", async () => {
      const doc: any = {
        attributes: {},
        src: "/images/hero.png",
        tagName: "img",
      };
      const cache = { entries: {}, version: 1 };

      await transformImageNodes(doc, defaultConfig, TMP, cache);

      expect(sourcesOf(doc)).toHaveLength(2);
      expect(imgOf(doc).attributes.src).toBe("/images/hero.png");
      expect(doc.src).toBeUndefined();
    });

    /*
     * The static emitter renders a fixed set of node-level DOM properties and `src` is not among
     * them, so an image written this way used to reach the page with a `srcset` and no `src` — the
     * fallback the candidate list exists to have. Normalizing it is the pipeline's job because the
     * pipeline is what rewrites this image's markup.
     */
    test("normalizes a node-level src into attributes even with optimize off", async () => {
      const doc: any = { attributes: {}, src: "/images/hero.png", tagName: "img" };

      await transformImageNodes(doc, { ...defaultConfig, optimize: false }, TMP, {
        entries: {},
        version: 1,
      });

      expect(doc.attributes.src).toBe("/images/hero.png");
      expect(doc.src).toBeUndefined();
    });
  });

  describe("shouldSkip (tested via transformImageNodes)", () => {
    test("skips SVG images", async () => {
      writeFileSync(join(TMP, "public/images/icon.svg"), "<svg></svg>");
      const doc: any = {
        attributes: { src: "/images/icon.svg" },
        tagName: "img",
      };
      const cache = { entries: {}, version: 1 };

      await transformImageNodes(doc, defaultConfig, TMP, cache);
      expect(doc.attributes.srcset).toBeUndefined();
    });

    test("skips GIF images", async () => {
      writeFileSync(join(TMP, "public/images/anim.gif"), "GIF89a");
      const doc: any = {
        attributes: { src: "/images/anim.gif" },
        tagName: "img",
      };
      const cache = { entries: {}, version: 1 };

      await transformImageNodes(doc, defaultConfig, TMP, cache);
      expect(doc.attributes.srcset).toBeUndefined();
    });

    test("skips external URLs", async () => {
      const doc: any = {
        attributes: { src: "https://example.com/img.png" },
        tagName: "img",
      };
      const cache = { entries: {}, version: 1 };

      await transformImageNodes(doc, defaultConfig, TMP, cache);
      expect(doc.attributes.srcset).toBeUndefined();
    });

    test("skips template literal expressions", async () => {
      const doc: any = {
        attributes: { src: "/images/${name}.png" },
        tagName: "img",
      };
      const cache = { entries: {}, version: 1 };

      await transformImageNodes(doc, defaultConfig, TMP, cache);
      expect(doc.attributes.srcset).toBeUndefined();
    });

    test("skips data: URIs", async () => {
      const doc: any = {
        attributes: { src: "data:image/png;base64,abc" },
        tagName: "img",
      };
      const cache = { entries: {}, version: 1 };

      await transformImageNodes(doc, defaultConfig, TMP, cache);
      expect(doc.attributes.srcset).toBeUndefined();
    });

    test("skips img node with empty src — does not call processImage", async () => {
      // Regression: empty ![]() in markdown produces src="" which previously resolved
      // To the project root directory, causing EISDIR when processImage tried to read it.
      const doc: any = { attributes: { src: "" }, tagName: "img" };
      const cache = { entries: {}, version: 1 };

      // oxlint-disable-next-line typescript/await-thenable -- bun:test async matcher returns a Promise; type-aware engine misresolves its return type
      await expect(transformImageNodes(doc, defaultConfig, TMP, cache)).resolves.toBeDefined();
      expect(processImage).not.toHaveBeenCalled();
      expect(doc.attributes.srcset).toBeUndefined();
    });

    test("skips innerHTML <img> with empty src — does not call processImage", async () => {
      // Same regression via the innerHTML path: a pre-rendered component containing
      // An <img src=""> must not attempt to read the project root as an image.
      const doc: any = {
        innerHTML: '<img src="" alt="placeholder">',
        tagName: "div",
      };
      const cache = { entries: {}, version: 1 };

      // oxlint-disable-next-line typescript/await-thenable -- bun:test async matcher returns a Promise; type-aware engine misresolves its return type
      await expect(transformImageNodes(doc, defaultConfig, TMP, cache)).resolves.toBeDefined();
      expect(processImage).not.toHaveBeenCalled();
      expect(doc.innerHTML).not.toContain("srcset=");
    });
  });

  describe("cloudflare mode", () => {
    const cfConfig = { ...defaultConfig, service: "cloudflare" as const };

    beforeEach(() => {
      getImageMetadata.mockReset();
      getImageMetadata.mockResolvedValue({
        format: "png",
        height: 800,
        width: 1200,
      });
    });

    test("builds srcset of /cdn-cgi/image transform URLs without calling processImage", async () => {
      const doc: any = {
        attributes: { src: "/images/hero.png" },
        tagName: "img",
      };

      await transformImageNodes(doc, cfConfig, TMP, null, new Map());

      expect(doc.attributes.srcset).toBe(
        "/cdn-cgi/image/width=640,quality=75,fit=scale-down,format=auto/images/hero.png?v=abcd1234 640w, " +
          "/cdn-cgi/image/width=1200,quality=75,fit=scale-down,format=auto/images/hero.png?v=abcd1234 1200w",
      );
      expect(doc.attributes.src).toBe("/images/hero.png");
      expect(doc.attributes.sizes).toBe("(max-width: 768px) 100vw, 50vw");
      expect(doc.attributes.width).toBe("1200");
      expect(doc.attributes.height).toBe("800");
      expect(doc.attributes.loading).toBe("lazy");
      expect(doc.attributes.decoding).toBe("async");
      expect(processImage).not.toHaveBeenCalled();
    });

    test("excludes widths larger than the original image", async () => {
      getImageMetadata.mockResolvedValue({
        format: "png",
        height: 600,
        width: 800,
      });

      const doc: any = {
        attributes: { src: "/images/hero.png" },
        tagName: "img",
      };

      await transformImageNodes(doc, cfConfig, TMP, null, new Map());

      expect(doc.attributes.srcset).toBe(
        "/cdn-cgi/image/width=640,quality=75,fit=scale-down,format=auto/images/hero.png?v=abcd1234 640w",
      );
    });

    test("sets no srcset when the image is narrower than every configured width", async () => {
      getImageMetadata.mockResolvedValue({
        format: "png",
        height: 240,
        width: 320,
      });

      const doc: any = {
        attributes: { src: "/images/hero.png" },
        tagName: "img",
      };

      await transformImageNodes(doc, cfConfig, TMP, null, new Map());

      expect(doc.attributes.srcset).toBeUndefined();
      // Dimensions are still known and injected even when no srcset variant applies
      expect(doc.attributes.width).toBe("320");
      expect(doc.attributes.height).toBe("240");
      expect(doc.attributes.loading).toBe("lazy");
    });

    test("memoizes metadata across duplicate references", async () => {
      const doc: any = {
        children: [
          { attributes: { src: "/images/hero.png" }, tagName: "img" },
          { attributes: { src: "/images/hero.png" }, tagName: "img" },
        ],
        tagName: "div",
      };

      await transformImageNodes(doc, cfConfig, TMP, null, new Map());

      expect(getImageMetadata).toHaveBeenCalledTimes(1);
      expect(doc.children[0].attributes.srcset).toContain("/cdn-cgi/image/width=");
      expect(doc.children[1].attributes.srcset).toContain("/cdn-cgi/image/width=");
    });

    test("still emits an unclamped srcset when Sharp metadata is unavailable", async () => {
      getImageMetadata.mockRejectedValue(new Error("Could not load the sharp module"));

      const doc: any = {
        tagName: "img",
        attributes: { src: "/images/hero.png" },
      };

      await transformImageNodes(doc, cfConfig, TMP, null, new Map());

      // All configured widths emitted (fit=scale-down guards against upscaling)
      expect(doc.attributes.srcset).toBe(
        "/cdn-cgi/image/width=640,quality=75,fit=scale-down,format=auto/images/hero.png?v=abcd1234 640w, " +
          "/cdn-cgi/image/width=1200,quality=75,fit=scale-down,format=auto/images/hero.png?v=abcd1234 1200w",
      );
      // Dimensions unknown — width/height attributes skipped, page still compiles
      expect(doc.attributes.width).toBeUndefined();
      expect(doc.attributes.height).toBeUndefined();
      expect(doc.attributes.loading).toBe("lazy");
    });

    test("shares the metadata cache across calls when provided", async () => {
      const metaCache = new Map();
      const docA: any = {
        attributes: { src: "/images/hero.png" },
        tagName: "img",
      };
      const docB: any = {
        attributes: { src: "/images/hero.png" },
        tagName: "img",
      };

      await transformImageNodes(docA, cfConfig, TMP, null, metaCache);
      await transformImageNodes(docB, cfConfig, TMP, null, metaCache);

      expect(getImageMetadata).toHaveBeenCalledTimes(1);
    });

    test("rewrites innerHTML img tags to transform URLs", async () => {
      const doc: any = {
        innerHTML: '<img src="/images/hero.png" alt="Hero">',
        tagName: "div",
      };

      await transformImageNodes(doc, cfConfig, TMP, null, new Map());

      expect(doc.innerHTML).toContain(
        'srcset="/cdn-cgi/image/width=640,quality=75,fit=scale-down,format=auto/images/hero.png?v=abcd1234',
      );
      expect(doc.innerHTML).toContain('src="/images/hero.png"');
      expect(doc.innerHTML).toContain('width="1200" height="800"');
      expect(doc.innerHTML).toContain('loading="lazy"');
      expect(processImage).not.toHaveBeenCalled();
    });

    test("skips innerHTML img tags that already have srcset", async () => {
      const html = '<img src="/images/hero.png" srcset="/x.avif 640w">';
      const doc: any = { innerHTML: html, tagName: "div" };

      await transformImageNodes(doc, cfConfig, TMP, null, new Map());

      // The author's candidate list is untouched — but when to fetch is still this pass's call.
      expect(doc.innerHTML).toContain('srcset="/x.avif 640w"');
      expect(doc.innerHTML).not.toContain("cdn-cgi");
      expect(doc.innerHTML).toContain('loading="lazy"');
      expect(getImageMetadata).not.toHaveBeenCalled();
    });

    test("optimizes allowlisted remote sources with an unclamped srcset", async () => {
      const config = { ...cfConfig, remoteDomains: ["drive.usercontent.google.com"] };
      const remoteSrc =
        "https://drive.usercontent.google.com/download?id=abc123&export=download/photo.jpg";
      const doc: any = { attributes: { src: remoteSrc }, tagName: "img" };

      await transformImageNodes(doc, config, TMP, null, new Map());

      // Remote sources go in as the full URL after the options segment, with no cache-busting
      // Hash (original bytes aren't available at build time)
      expect(doc.attributes.srcset).toBe(
        `/cdn-cgi/image/width=640,quality=75,fit=scale-down,format=auto/${remoteSrc} 640w, ` +
          `/cdn-cgi/image/width=1200,quality=75,fit=scale-down,format=auto/${remoteSrc} 1200w`,
      );
      expect(doc.attributes.src).toBe(remoteSrc);
      expect(doc.attributes.sizes).toBe("(max-width: 768px) 100vw, 50vw");
      // Original dimensions are unknown for remote sources — no width/height injection
      expect(doc.attributes.width).toBeUndefined();
      expect(doc.attributes.height).toBeUndefined();
      expect(doc.attributes.loading).toBe("lazy");
      expect(getImageMetadata).not.toHaveBeenCalled();
      expect(processImage).not.toHaveBeenCalled();
    });

    test("leaves remote sources from non-allowlisted hosts untouched", async () => {
      const config = { ...cfConfig, remoteDomains: ["drive.usercontent.google.com"] };
      const doc: any = {
        attributes: { src: "https://evil.example.com/img.jpg" },
        tagName: "img",
      };

      await transformImageNodes(doc, config, TMP, null, new Map());
      expect(doc.attributes.srcset).toBeUndefined();
    });

    test("ignores remoteDomains outside the cloudflare service", async () => {
      const config = {
        ...defaultConfig,
        remoteDomains: ["drive.usercontent.google.com"],
      };
      const doc: any = {
        attributes: { src: "https://drive.usercontent.google.com/download?id=x/p.jpg" },
        tagName: "img",
      };
      const cache = { entries: {}, version: 1 };

      await transformImageNodes(doc, config, TMP, cache);
      expect(doc.attributes.srcset).toBeUndefined();
    });

    test("skips remote svg/gif and template sources", async () => {
      const config = { ...cfConfig, remoteDomains: ["drive.usercontent.google.com"] };
      const docs: any[] = [
        {
          attributes: { src: "https://drive.usercontent.google.com/icon.svg" },
          tagName: "img",
        },
        {
          attributes: { src: "https://drive.usercontent.google.com/${id}.jpg" },
          tagName: "img",
        },
      ];
      for (const doc of docs) {
        await transformImageNodes(doc, config, TMP, null, new Map());
        expect(doc.attributes.srcset).toBeUndefined();
      }
    });

    test("rewrites entity-escaped remote img tags in innerHTML", async () => {
      const config = { ...cfConfig, remoteDomains: ["drive.usercontent.google.com"] };
      const doc: any = {
        innerHTML:
          '<img src="https://drive.usercontent.google.com/download?id=abc&amp;export=download/p.jpg" alt="P">',
        tagName: "div",
      };

      await transformImageNodes(doc, config, TMP, null, new Map());

      // The entity-decoded URL is appended after the transform options segment
      expect(doc.innerHTML).toContain('srcset="/cdn-cgi/image/width=640,quality=75,');
      expect(doc.innerHTML).toContain(
        "format=auto/https://drive.usercontent.google.com/download?id=abc&export=download/p.jpg 640w",
      );
      expect(doc.innerHTML).toContain('loading="lazy"');
    });

    test("honors existing skip rules", async () => {
      writeFileSync(join(TMP, "public/images/icon.svg"), "<svg></svg>");
      const docs: any[] = [
        { attributes: { src: "https://example.com/img.png" }, tagName: "img" },
        { attributes: { src: "/images/icon.svg" }, tagName: "img" },
        { attributes: { src: "/images/${name}.png" }, tagName: "img" },
        {
          attributes: { "data-no-optimize": "", src: "/images/hero.png" },
          tagName: "img",
        },
        { attributes: { src: "/images/nonexistent.png" }, tagName: "img" },
      ];

      for (const doc of docs) {
        await transformImageNodes(doc, cfConfig, TMP, null, new Map());
        expect(doc.attributes.srcset).toBeUndefined();
      }
      expect(getImageMetadata).not.toHaveBeenCalled();
    });
  });
  describe("asset mounts", () => {
    test("resolves a mounted src outside the project root", async () => {
      const external = join(TMP, "external/images");
      mkdirSync(external, { recursive: true });
      writeFileSync(join(external, "diagram.png"), "fake-png-data");
      const mounts = [{ dir: join(TMP, "external"), urlPrefix: "/content/docs" }];
      const doc: any = {
        attributes: { src: "/content/docs/images/diagram.png" },
        tagName: "img",
      };

      await transformImageNodes(
        doc,
        defaultConfig,
        TMP,
        { entries: {}, version: 1 },
        undefined,
        mounts,
      );

      expect(sourcesOf(doc)[0].attributes.srcset).toContain("/_optimized/hero-640-abc.avif 640w");
      expect(imgOf(doc).attributes.src).toBe("/content/docs/images/diagram.png");
    });

    test("a mounted URL with no file behind it is left alone", async () => {
      const mounts = [{ dir: join(TMP, "external"), urlPrefix: "/content/docs" }];
      const doc: any = { attributes: { src: "/content/docs/gone.png" }, tagName: "img" };

      await transformImageNodes(
        doc,
        defaultConfig,
        TMP,
        { entries: {}, version: 1 },
        undefined,
        mounts,
      );

      expect(doc.attributes.srcset).toBeUndefined();
    });

    test("without mounts the same src falls back to public/ and is skipped", async () => {
      const doc: any = {
        attributes: { src: "/content/docs/images/diagram.png" },
        tagName: "img",
      };

      await transformImageNodes(doc, defaultConfig, TMP, { entries: {}, version: 1 });

      expect(doc.attributes.srcset).toBeUndefined();
    });
  });
});
