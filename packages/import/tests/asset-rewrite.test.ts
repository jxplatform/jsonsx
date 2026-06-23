import { describe, test, expect } from "bun:test";
import { rewriteAssetUrls } from "../src/asset-rewrite.ts";
import type { JxElement } from "@jxsuite/schema/types";

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
    const map = new Map([["https://example.com/hero.jpg", "public/assets/images/hero.jpg"]]);

    const count = rewriteAssetUrls(tree, map);

    expect(count).toBe(1);
    expect((tree.children![0] as JxElement).attributes!.src).toBe("public/assets/images/hero.jpg");
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
      ["https://example.com/small.jpg", "public/assets/images/small.jpg"],
      ["https://example.com/large.jpg", "public/assets/images/large.jpg"],
    ]);

    const count = rewriteAssetUrls(tree, map);

    expect(count).toBe(2);
    expect((tree.children![0] as JxElement).attributes!.srcset).toBe(
      "public/assets/images/small.jpg 320w, public/assets/images/large.jpg 1024w",
    );
  });

  test("rewrites background-image url() in style", () => {
    const tree: JxElement = {
      tagName: "div",
      style: {
        backgroundImage: 'url("https://example.com/bg.png")',
      },
    };
    const map = new Map([["https://example.com/bg.png", "public/assets/images/bg.png"]]);

    const count = rewriteAssetUrls(tree, map);

    expect(count).toBe(1);
    expect(tree.style!.backgroundImage).toBe('url("public/assets/images/bg.png")');
  });

  test("rewrites URLs in $media nested style objects", () => {
    const tree: JxElement = {
      tagName: "div",
      style: {
        backgroundImage: 'url("https://example.com/bg-desktop.png")',
        "@--768": {
          backgroundImage: 'url("https://example.com/bg-mobile.png")',
        } as any,
      },
    };
    const map = new Map([
      ["https://example.com/bg-desktop.png", "public/assets/images/bg-desktop.png"],
      ["https://example.com/bg-mobile.png", "public/assets/images/bg-mobile.png"],
    ]);

    const count = rewriteAssetUrls(tree, map);

    expect(count).toBe(2);
    expect(tree.style!.backgroundImage).toBe('url("public/assets/images/bg-desktop.png")');
    expect((tree.style!["@--768"] as any).backgroundImage).toBe(
      'url("public/assets/images/bg-mobile.png")',
    );
  });

  test("does not rewrite anchor href", () => {
    const tree: JxElement = {
      tagName: "a",
      attributes: { href: "https://example.com/page" },
    };
    const map = new Map([["https://example.com/page", "public/assets/other/page"]]);

    const count = rewriteAssetUrls(tree, map);

    expect(count).toBe(0);
    expect(tree.attributes!.href).toBe("https://example.com/page");
  });

  test("rewrites video poster attribute", () => {
    const tree: JxElement = {
      tagName: "video",
      attributes: { poster: "https://example.com/thumb.jpg" },
    };
    const map = new Map([["https://example.com/thumb.jpg", "public/assets/images/thumb.jpg"]]);

    const count = rewriteAssetUrls(tree, map);

    expect(count).toBe(1);
    expect(tree.attributes!.poster).toBe("public/assets/images/thumb.jpg");
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
    const map = new Map([["https://example.com/deep.jpg", "public/assets/images/deep.jpg"]]);

    const count = rewriteAssetUrls(tree, map);

    expect(count).toBe(1);
  });

  test("returns 0 for empty tree", () => {
    const tree: JxElement = { tagName: "div" };
    const count = rewriteAssetUrls(tree, new Map());
    expect(count).toBe(0);
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
      ["https://example.com/a.jpg", "public/assets/images/a.jpg"],
      ["https://example.com/b.png", "public/assets/images/b.png"],
      ["https://example.com/c.webp", "public/assets/images/c.webp"],
    ]);

    const count = rewriteAssetUrls(tree, map);

    expect(count).toBe(3);
  });
});
