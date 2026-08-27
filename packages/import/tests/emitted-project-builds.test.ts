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
