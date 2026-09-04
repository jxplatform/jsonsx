import { describe, test, expect } from "bun:test";
import { rewriteAssetUrls } from "../src/asset-rewrite.ts";
import type { JxElement, JxStyle } from "@jxsuite/schema/types";

describe("rewriteAssetUrls", () => {
  test("rewrites img src attribute", () => {
    const tree: JxElement = {
      tagName: "div",
      children: [
        {
          tagName: "img",
          attributes: { src: "https://example.com/hero.jpg", alt: "Hero" },
        },
      ],
    };
    const map = new Map([["https://example.com/hero.jpg", "/assets/images/hero.jpg"]]);

    const count = rewriteAssetUrls(tree, map);

    expect(count).toBe(1);
    expect((tree.children as JxElement[])[0]!.attributes!.src).toBe("/assets/images/hero.jpg");
  });

  test("rewrites srcset attribute", () => {
    const tree: JxElement = {
      tagName: "div",
      children: [
        {
          tagName: "img",
          attributes: {
            srcset: "https://example.com/small.jpg 320w, https://example.com/large.jpg 1024w",
          },
        },
      ],
    };
    const map = new Map([
      ["https://example.com/small.jpg", "/assets/images/small.jpg"],
      ["https://example.com/large.jpg", "/assets/images/large.jpg"],
    ]);

    const count = rewriteAssetUrls(tree, map);

    expect(count).toBe(2);
    expect((tree.children as JxElement[])[0]!.attributes!.srcset).toBe(
      "/assets/images/small.jpg 320w, /assets/images/large.jpg 1024w",
    );
  });

  test("collapses a srcset whose candidates all became one file", () => {
    /* After family selection every rung of a responsive ladder resolves to the ONE file that was
       written, so the attribute is the same path repeated with different width descriptors - a
       list that lies to the browser about what it can choose. */
    const tree: JxElement = {
      tagName: "div",
      children: [
        {
          tagName: "img",
          attributes: {
            src: "https://example.com/photo-300x200.jpg",
            srcset:
              "https://example.com/photo-300x200.jpg 300w, https://example.com/photo-768x512.jpg 768w",
            sizes: "(max-width: 400px) 100vw, 400px",
          },
        },
      ],
    };
    const map = new Map([
      ["https://example.com/photo-300x200.jpg", "/assets/images/photo.jpg"],
      ["https://example.com/photo-768x512.jpg", "/assets/images/photo.jpg"],
    ]);

    rewriteAssetUrls(tree, map);
    const attrs = (tree.children as JxElement[])[0]!.attributes!;

    expect(attrs["srcset"]).toBeUndefined();
    // `sizes` describes a layout that no longer exists, and the compiler honours it over its own
    // Container measurement, so leaving it would misdescribe the imported page.
    expect(attrs["sizes"]).toBeUndefined();
    expect(attrs["src"]).toBe("/assets/images/photo.jpg");
  });

  test("leaves a partly-remote srcset alone rather than narrowing it", () => {
    const tree: JxElement = {
      tagName: "div",
      children: [
        {
          tagName: "img",
          attributes: {
            srcset:
              "https://example.com/photo-300x200.jpg 300w, https://cdn.other.test/photo.jpg 768w",
          },
        },
      ],
    };
    const map = new Map([["https://example.com/photo-300x200.jpg", "/assets/images/photo.jpg"]]);

    rewriteAssetUrls(tree, map);
    const attrs = (tree.children as JxElement[])[0]!.attributes!;

    // One candidate never downloaded, so the set is only partly local and must not be collapsed.
    expect(attrs["srcset"]).toContain("https://cdn.other.test/photo.jpg");
  });

  test("rewrites background-image url() in style", () => {
    const tree: JxElement = {
      tagName: "div",
      style: {
        backgroundImage: 'url("https://example.com/bg.png")',
      },
    };
    const map = new Map([["https://example.com/bg.png", "/assets/images/bg.png"]]);

    const count = rewriteAssetUrls(tree, map);

    expect(count).toBe(1);
    expect(tree.style!.backgroundImage).toBe('url("/assets/images/bg.png")');
  });

  test("rewrites URLs in $media nested style objects", () => {
    const tree: JxElement = {
      tagName: "div",
      style: {
        backgroundImage: 'url("https://example.com/bg-desktop.png")',
        "@--768": {
          backgroundImage: 'url("https://example.com/bg-mobile.png")',
        },
      },
    };
    const map = new Map([
      ["https://example.com/bg-desktop.png", "/assets/images/bg-desktop.png"],
      ["https://example.com/bg-mobile.png", "/assets/images/bg-mobile.png"],
    ]);

    const count = rewriteAssetUrls(tree, map);

    expect(count).toBe(2);
    expect(tree.style!.backgroundImage).toBe('url("/assets/images/bg-desktop.png")');
    expect((tree.style!["@--768"] as JxStyle).backgroundImage).toBe(
      'url("/assets/images/bg-mobile.png")',
    );
  });

  test("does not rewrite anchor href", () => {
    const tree: JxElement = {
      tagName: "a",
      attributes: { href: "https://example.com/page" },
    };
    const map = new Map([["https://example.com/page", "/assets/other/page"]]);

    const count = rewriteAssetUrls(tree, map);

    expect(count).toBe(0);
    expect(tree.attributes!.href).toBe("https://example.com/page");
  });

  test("rewrites video poster attribute", () => {
    const tree: JxElement = {
      tagName: "video",
      attributes: { poster: "https://example.com/thumb.jpg" },
    };
    const map = new Map([["https://example.com/thumb.jpg", "/assets/images/thumb.jpg"]]);

    const count = rewriteAssetUrls(tree, map);

    expect(count).toBe(1);
    expect(tree.attributes!.poster).toBe("/assets/images/thumb.jpg");
  });

  test("skips URLs not in the rewrite map", () => {
    const tree: JxElement = {
      tagName: "img",
      attributes: { src: "https://other.com/unknown.jpg" },
    };
    const map = new Map<string, string>();

    const count = rewriteAssetUrls(tree, map);

    expect(count).toBe(0);
    expect(tree.attributes!.src).toBe("https://other.com/unknown.jpg");
  });

  test("handles deeply nested trees", () => {
    const tree: JxElement = {
      tagName: "div",
      children: [
        {
          tagName: "section",
          children: [
            {
              tagName: "article",
              children: [
                {
                  tagName: "img",
                  attributes: { src: "https://example.com/deep.jpg" },
                },
              ],
            },
          ],
        },
      ],
    };
    const map = new Map([["https://example.com/deep.jpg", "/assets/images/deep.jpg"]]);

    const count = rewriteAssetUrls(tree, map);

    expect(count).toBe(1);
  });

  test("returns 0 for empty tree", () => {
    const tree: JxElement = { tagName: "div" };
    const count = rewriteAssetUrls(tree, new Map());
    expect(count).toBe(0);
  });

  test("resolves relative URLs against sourceUrl before lookup", () => {
    const tree: JxElement = {
      tagName: "div",
      children: [
        {
          tagName: "img",
          attributes: { src: "/_next/static/media/hero.jpg", alt: "Hero" },
        },
        {
          tagName: "img",
          attributes: { src: "/images/logo.svg" },
        },
        {
          tagName: "div",
          style: { backgroundImage: 'url("/_next/static/media/bg.png")' },
        },
      ],
    };
    const map = new Map([
      ["https://tailwindcss.com/_next/static/media/hero.jpg", "/assets/images/hero.jpg"],
      ["https://tailwindcss.com/images/logo.svg", "/assets/images/logo.svg"],
      ["https://tailwindcss.com/_next/static/media/bg.png", "/assets/images/bg.png"],
    ]);

    const count = rewriteAssetUrls(tree, map, "https://tailwindcss.com/");

    expect(count).toBe(3);
    expect((tree.children as JxElement[])[0]!.attributes!.src).toBe("/assets/images/hero.jpg");
    expect((tree.children as JxElement[])[1]!.attributes!.src).toBe("/assets/images/logo.svg");
    expect((tree.children as JxElement[])[2]!.style!.backgroundImage).toBe(
      'url("/assets/images/bg.png")',
    );
  });

  test("resolves protocol-relative URLs against sourceUrl", () => {
    const tree: JxElement = {
      tagName: "img",
      attributes: { src: "//cdn.example.com/image.jpg" },
    };
    const map = new Map([["https://cdn.example.com/image.jpg", "/assets/images/image.jpg"]]);

    const count = rewriteAssetUrls(tree, map, "https://example.com/");

    expect(count).toBe(1);
    expect(tree.attributes!.src).toBe("/assets/images/image.jpg");
  });

  test("still matches absolute URLs without sourceUrl", () => {
    const tree: JxElement = {
      tagName: "img",
      attributes: { src: "https://example.com/hero.jpg" },
    };
    const map = new Map([["https://example.com/hero.jpg", "/assets/images/hero.jpg"]]);

    const count = rewriteAssetUrls(tree, map);

    expect(count).toBe(1);
  });

  test("matches map keys that differ by a trailing slash", () => {
    const tree: JxElement = {
      tagName: "img",
      attributes: { src: "https://example.com/x" },
    };
    const map = new Map([["https://example.com/x/", "/assets/images/x"]]);

    const count = rewriteAssetUrls(tree, map);

    expect(count).toBe(1);
    expect(tree.attributes!.src).toBe("/assets/images/x");
  });

  test("leaves relative URLs whose resolution misses the map", () => {
    const tree: JxElement = {
      tagName: "img",
      attributes: { src: "/missing.jpg" },
    };
    const map = new Map([["https://example.com/hero.jpg", "/assets/images/hero.jpg"]]);

    const count = rewriteAssetUrls(tree, map, "https://example.com/");

    expect(count).toBe(0);
    expect(tree.attributes!.src).toBe("/missing.jpg");
  });

  test("skips resolution when sourceUrl is not a valid base", () => {
    const tree: JxElement = {
      tagName: "img",
      attributes: { src: "/x.jpg" },
    };
    const map = new Map([["https://example.com/hero.jpg", "/assets/images/hero.jpg"]]);

    const count = rewriteAssetUrls(tree, map, "::::not-a-base");

    expect(count).toBe(0);
    expect(tree.attributes!.src).toBe("/x.jpg");
  });

  test("leaves css url() references not in the map unchanged", () => {
    const tree: JxElement = {
      tagName: "div",
      style: { backgroundImage: 'url("https://unknown.example/bg.png")' },
    };
    const map = new Map([["https://example.com/hero.jpg", "/assets/images/hero.jpg"]]);

    const count = rewriteAssetUrls(tree, map);

    expect(count).toBe(0);
    expect(tree.style!.backgroundImage).toBe('url("https://unknown.example/bg.png")');
  });

  test("rewrites href on non-anchor elements", () => {
    const tree: JxElement = {
      tagName: "link",
      attributes: { href: "https://example.com/favicon.ico", rel: "icon" },
    };
    const map = new Map([["https://example.com/favicon.ico", "/assets/icons/favicon.ico"]]);

    const count = rewriteAssetUrls(tree, map);

    expect(count).toBe(1);
    expect(tree.attributes!.href).toBe("/assets/icons/favicon.ico");
  });

  test("rewrites multiple assets in one pass", () => {
    const tree: JxElement = {
      tagName: "div",
      children: [
        {
          tagName: "img",
          attributes: { src: "https://example.com/a.jpg" },
        },
        {
          tagName: "img",
          attributes: { src: "https://example.com/b.png" },
        },
        {
          tagName: "div",
          style: { backgroundImage: 'url("https://example.com/c.webp")' },
        },
      ],
    };
    const map = new Map([
      ["https://example.com/a.jpg", "/assets/images/a.jpg"],
      ["https://example.com/b.png", "/assets/images/b.png"],
      ["https://example.com/c.webp", "/assets/images/c.webp"],
    ]);

    const count = rewriteAssetUrls(tree, map);

    expect(count).toBe(3);
  });
});
