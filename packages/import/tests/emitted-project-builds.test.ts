/**
 * Regression tests for the defects that stopped an imported project from building into a working
 * site. Each one passed the whole existing suite while the built output was visibly broken, so each
 * is pinned here by the property that was actually violated rather than by implementation detail.
 */

import { describe, test, expect } from "bun:test";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { existsSync } from "node:fs";
import { emitMultiPageProject } from "../src/emit.ts";
import { downloadAssets } from "../src/asset-download.ts";
import type { DiscoveredAsset } from "../src/asset-collect.ts";

/** The keys `project.schema.json` accepts at the top level of a project document. */
const PROJECT_KEYS = new Set([
  "$defs",
  "$elements",
  "$head",
  "$media",
  "$schema",
  "build",
  "copy",
  "defaults",
  "extensions",
  "i18n",
  "images",
  "imports",
  "manifest",
  "name",
  "redirects",
  "securityTxt",
  "serviceWorker",
  "state",
  "style",
  "url",
]);

describe("an emitted project is one the compiler accepts", () => {
  test("project.json carries no key the schema rejects", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jx-import-projectkeys-"));
    try {
      await emitMultiPageProject({
        outDir: dir,
        title: "Key Test",
        sourceUrl: "https://example.com",
        pages: new Map([["pages/index.json", { tagName: "div" as const }]]),
        breakpoints: { "--768": "(min-width: 768px)" },
        styleTokens: { "--brand": "#3b82f6" },
      });

      const project = await Bun.file(join(dir, "project.json")).json();
      const rejected = Object.keys(project).filter((k) => !PROJECT_KEYS.has(k));

      expect(rejected).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("extracted tokens land under `style`, the key the compiler reads", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jx-import-tokens-"));
    try {
      await emitMultiPageProject({
        outDir: dir,
        title: "Token Test",
        sourceUrl: "https://example.com",
        pages: new Map([["pages/index.json", { tagName: "div" as const }]]),
        styleTokens: { "--brand": "#3b82f6" },
      });

      const project = await Bun.file(join(dir, "project.json")).json();

      // Under `$style` the compiler emits no `:root` rule at all, so every var(--brand) in the
      // Imported CSS resolves to nothing while the build still reports success.
      expect(project.style).toEqual({ "--brand": "#3b82f6" });
      expect(project.$style).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
describe("an asset reference names the path the built site serves", () => {
  test("a downloaded asset is mapped site-absolute, with no `public/` segment", async () => {
    // `public/` is the compiler's static ROOT: its contents land at dist/<path>. A reference that
    // Keeps the segment names a file that does not exist, and one without a leading slash resolves
    // Against the current route — so the same document 404s differently on every page.
    const dir = await mkdtemp(join(tmpdir(), "jx-import-assetpath-"));
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response("data")) as unknown as typeof fetch;
    try {
      const assets: DiscoveredAsset[] = [
        { url: "https://example.com/logo.png", source: "img-src" },
      ];

      const { rewriteMap } = await downloadAssets(assets, dir);
      const mapped = rewriteMap.get("https://example.com/logo.png");

      expect(mapped).toBe("/assets/images/logo.png");
      expect(mapped).not.toContain("public/");
      // The file itself still lands under public/, which is what the compiler copies from.
      expect(existsSync(join(dir, "public", "assets", "images", "logo.png"))).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
      await rm(dir, { recursive: true, force: true });
    }
  });
});
describe("a downloaded font is the one the page asks for", () => {
  test("a root-relative @font-face url is rewritten, not just the absolute form", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jx-import-fontform-"));
    try {
      await emitMultiPageProject({
        outDir: dir,
        title: "Font Form Test",
        sourceUrl: "https://example.com",
        pages: new Map([["pages/index.json", { tagName: "div" as const }]]),
        // The form a stylesheet AUTHOR writes. The rewrite map is keyed by the absolute URL the
        // Downloader resolved, so matching on that alone rewrote nothing and every downloaded font
        // Stayed unreferenced.
        fontFaceRules: ['@font-face { src: url("/fonts/lato.woff2"); }'],
        fontRewriteMap: new Map([
          ["https://example.com/fonts/lato.woff2", "/assets/fonts/lato.woff2"],
        ]),
      });

      const css = await Bun.file(join(dir, "public", "assets", "fonts.css")).text();

      expect(css).toContain('url("/assets/fonts/lato.woff2")');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("rewriting is a single pass, so a local path is never rewritten again", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jx-import-fontonce-"));
    try {
      await emitMultiPageProject({
        outDir: dir,
        title: "Font Once Test",
        sourceUrl: "https://example.com",
        pages: new Map([["pages/index.json", { tagName: "div" as const }]]),
        fontFaceRules: ['@font-face { src: url("https://cdn.example.com/a.woff2"); }'],
        fontRewriteMap: new Map([["https://cdn.example.com/a.woff2", "/assets/fonts/a.woff2"]]),
      });

      const css = await Bun.file(join(dir, "public", "assets", "fonts.css")).text();

      // Replacing form by form re-scans text already rewritten: the pathname "/a.woff2" then
      // Matches inside the "/assets/fonts/a.woff2" this loop just produced.
      expect(css).toContain('url("/assets/fonts/a.woff2")');
      expect(css).not.toContain("/assets/fonts/assets/");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
