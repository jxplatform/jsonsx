/**
 * Asset-collect tests — the in-browser callbacks normally run inside puppeteer's page.evaluate().
 * Here a fake Page executes them in-process against happy-dom globals, so the real DOM queries,
 * srcset/css-url parsing, stylesheet retention, and cross-origin refetch logic all run for real.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { Page } from "puppeteer-core";
import type { AssetCollectionResult, DiscoveredAsset } from "../src/asset-collect.ts";

GlobalRegistrator.register({ url: "https://example.com/" });

// The happy-dom HTMLVideoElement lacks the poster property; reflect the attribute as a resolved
// URL (empty string when absent), matching browser behavior.
const videoProto = Object.getPrototypeOf(document.createElement("video")) as HTMLVideoElement;
if (!("poster" in videoProto)) {
  Object.defineProperty(videoProto, "poster", {
    get(this: HTMLVideoElement) {
      const value = this.getAttribute("poster");
      if (!value) {
        return "";
      }
      try {
        return new URL(value, location.href).href;
      } catch {
        return value;
      }
    },
    configurable: true,
  });
}

const { collectAssets } = await import("../src/asset-collect.ts");

const fakePage = {
  evaluate: (fn: (...fnArgs: unknown[]) => unknown, ...args: unknown[]) =>
    Promise.resolve(fn(...args)),
} as unknown as Page;

function setDom(headHtml: string, bodyHtml: string): void {
  document.head.innerHTML = headHtml;
  document.body.innerHTML = bodyHtml;
}

function byUrl(result: AssetCollectionResult, url: string): DiscoveredAsset[] {
  return result.assets.filter((a) => a.url === url);
}

afterEach(() => {
  Reflect.deleteProperty(document, "styleSheets");
});

describe("collectAssets - DOM discovery", () => {
  it("discovers every asset source type with absolute deduplicated URLs", async () => {
    setDom(
      `<link rel="icon" href="/favicon.ico">
       <link rel="shortcut icon" href="/shortcut.ico">
       <link rel="apple-touch-icon" href="/apple.png">
       <link rel="icon" href="">
       <meta property="og:image" content="/og.png">
       <style>
         .bg { background-image: url("/bg.png"); }
         @font-face { font-family: X; src: url("/fonts/x.woff2") format("woff2"); }
       </style>`,
      `<img src="/img1.png">
       <img src="https://example.com/img1.png">
       <img src="/img2.png">
       <img srcset="/img2.png 1x, /img3.png 2x, javascript:void(0) 1x, blob:https://example.com/b 1x, http:// 1x,">
       <img src="data:image/png;base64,AAAA">
       <picture>
         <source srcset="/pic1.webp 1x">
         <source src="/pic2.webp">
         <img src="/picimg.png">
       </picture>
       <video poster="/poster.jpg"></video>
       <video></video>
       <div class="bg">styled</div>
       <div style="background-image: url('/inline-bg.png'), url(data:image/gif;base64,AA)">inline</div>
       <svg></svg><svg></svg>`,
    );

    const result = await collectAssets(fakePage);
    const urls = result.assets.map((a) => a.url);

    // Absolute URLs, one entry per unique asset
    expect(byUrl(result, "https://example.com/img1.png")).toEqual([
      { url: "https://example.com/img1.png", source: "img-src" },
    ]);
    expect(byUrl(result, "https://example.com/img2.png")).toEqual([
      { url: "https://example.com/img2.png", source: "img-src" },
    ]);
    expect(byUrl(result, "https://example.com/img3.png")).toEqual([
      { url: "https://example.com/img3.png", source: "img-srcset" },
    ]);
    expect(byUrl(result, "https://example.com/pic1.webp")).toEqual([
      { url: "https://example.com/pic1.webp", source: "source-srcset" },
    ]);
    expect(byUrl(result, "https://example.com/pic2.webp")).toEqual([
      { url: "https://example.com/pic2.webp", source: "picture-source" },
    ]);
    expect(byUrl(result, "https://example.com/poster.jpg")).toEqual([
      { url: "https://example.com/poster.jpg", source: "video-poster" },
    ]);
    expect(byUrl(result, "https://example.com/inline-bg.png")).toEqual([
      { url: "https://example.com/inline-bg.png", source: "css-url" },
    ]);
    expect(byUrl(result, "https://example.com/bg.png")).toEqual([
      { url: "https://example.com/bg.png", source: "css-background" },
    ]);
    expect(byUrl(result, "https://example.com/fonts/x.woff2")).toEqual([
      { url: "https://example.com/fonts/x.woff2", source: "font-face" },
    ]);
    expect(byUrl(result, "https://example.com/favicon.ico")).toEqual([
      { url: "https://example.com/favicon.ico", source: "favicon" },
    ]);
    expect(byUrl(result, "https://example.com/shortcut.ico")).toHaveLength(1);
    expect(byUrl(result, "https://example.com/apple.png")).toHaveLength(1);
    expect(byUrl(result, "https://example.com/og.png")).toEqual([
      { url: "https://example.com/og.png", source: "og-image" },
    ]);

    // Assets with data:, blob:, javascript:, or invalid URLs are all filtered out
    for (const url of urls) {
      expect(url).toStartWith("https://");
    }

    expect(result.inlineSvgCount).toBe(2);
  });

  it("retains inline stylesheets with full cssText and @font-face rules", async () => {
    setDom(
      `<style>
         .a { color: red; }
         @font-face { font-family: X; src: url("/fonts/x.woff2") format("woff2"); }
       </style>`,
      `<p>hi</p>`,
    );

    const result = await collectAssets(fakePage);
    expect(result.stylesheets).toHaveLength(1);
    const sheet = result.stylesheets[0]!;
    expect(sheet.href).toBeFalsy();
    expect(sheet.cssText).toContain(".a { color: red; }");
    expect(sheet.cssText).toContain("@font-face");
    expect(sheet.fontFaceRules).toHaveLength(1);
    expect(sheet.fontFaceRules[0]).toContain("/fonts/x.woff2");
  });

  /*
   * Issue #231: `srcset` was split on every comma, so a Wix/Cloudinary/imgix URL — which encodes
   * its image transform as `w_375,h_127,al_c,q_85` inside the path — became a dozen fragments,
   * every one of which failed to fetch. A failed download leaves the reference untouched, so the
   * emitted page went on serving those images from the host it had just cloned.
   */
  it("collects a transform-CDN srcset as whole URLs", async () => {
    const narrow =
      "https://static.wixstatic.com/media/X~mv2.png/v1/fill/w_375,h_127,al_c,q_85/logo.png";
    const wide =
      "https://static.wixstatic.com/media/X~mv2.png/v1/fill/w_750,h_254,al_c,q_85/logo.png";
    setDom("", `<img srcset="${narrow} 1x, ${wide} 2x">`);

    const result = await collectAssets(fakePage);

    expect(result.assets.map((a) => a.url)).toEqual([narrow, wide]);
  });

  it("returns empty results for a bare page", async () => {
    setDom("", "<p>nothing here</p>");
    const result = await collectAssets(fakePage);
    expect(result.assets).toEqual([]);
    expect(result.inlineSvgCount).toBe(0);
    expect(result.stylesheets).toEqual([]);
  });
});

describe("collectAssets - cross-origin stylesheet refetch", () => {
  it("refetches inaccessible sheets in-browser and extracts font URLs", async () => {
    // /already.png is discovered as img-src first, so the duplicate font URL is not re-added
    setDom("<style>.x { color: blue; }</style>", `<img src="/already.png">`);

    const realSheets = [...document.styleSheets];
    const crossOrigin = (href: string) => ({
      href,
      get cssRules(): CSSRuleList {
        throw new Error("SecurityError: cross-origin");
      },
    });
    Object.defineProperty(document, "styleSheets", {
      get: () => [
        ...realSheets,
        crossOrigin("https://fonts.example.com/ok.css"),
        crossOrigin("https://fonts.example.com/notok.css"),
        crossOrigin("https://fonts.example.com/fail.css"),
      ],
      configurable: true,
    });

    const fetchedHrefs: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: unknown) => {
      const href = String(input);
      fetchedHrefs.push(href);
      if (href.includes("fail")) {
        throw new Error("network down");
      }
      if (href.includes("notok")) {
        return new Response("nope", { status: 404 });
      }
      return new Response(
        [
          `@font-face { font-family: "Roboto"; src: url(https://fonts.gstatic.com/roboto.woff2) format("woff2"); }`,
          `@font-face { font-family: "Rel"; src: url('/rel/font.woff2'); }`,
          `@font-face { font-family: "Dup"; src: url("https://example.com/already.png"); }`,
          `@font-face { font-family: "Data"; src: url(data:font/woff2;base64,AAA); }`,
        ].join("\n"),
      );
    }) as unknown as typeof fetch;

    try {
      const result = await collectAssets(fakePage);

      expect(fetchedHrefs).toEqual([
        "https://fonts.example.com/ok.css",
        "https://fonts.example.com/notok.css",
        "https://fonts.example.com/fail.css",
      ]);

      // The accessible inline sheet plus the three cross-origin entries
      expect(result.stylesheets).toHaveLength(4);
      const ok = result.stylesheets.find((s) => s.href === "https://fonts.example.com/ok.css")!;
      expect(ok.cssText).toContain("Roboto");
      expect(ok.fontFaceRules).toHaveLength(4);

      // Failed fetches leave the sheet unresolved
      const notok = result.stylesheets.find(
        (s) => s.href === "https://fonts.example.com/notok.css",
      )!;
      const failed = result.stylesheets.find(
        (s) => s.href === "https://fonts.example.com/fail.css",
      )!;
      expect(notok.cssText).toBeNull();
      expect(failed.cssText).toBeNull();

      // Absolute and sheet-relative font URLs are discovered; data: URIs skipped
      expect(byUrl(result, "https://fonts.gstatic.com/roboto.woff2")).toEqual([
        { url: "https://fonts.gstatic.com/roboto.woff2", source: "font-face" },
      ]);
      expect(byUrl(result, "https://fonts.example.com/rel/font.woff2")).toEqual([
        { url: "https://fonts.example.com/rel/font.woff2", source: "font-face" },
      ]);
      // Already-discovered asset is not duplicated as a font
      expect(byUrl(result, "https://example.com/already.png")).toEqual([
        { url: "https://example.com/already.png", source: "img-src" },
      ]);
      expect(result.assets.some((a) => a.url.startsWith("data:"))).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("skips the refetch pass when every sheet is accessible", async () => {
    setDom("<style>.y { color: green; }</style>", "<p>hi</p>");

    const originalFetch = globalThis.fetch;
    let fetchCalled = false;
    globalThis.fetch = (async () => {
      fetchCalled = true;
      return new Response("");
    }) as unknown as typeof fetch;

    try {
      const result = await collectAssets(fakePage);
      expect(result.stylesheets).toHaveLength(1);
      expect(result.stylesheets[0]!.cssText).toContain(".y");
      expect(fetchCalled).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
