/**
 * Regression tests for the defects that stopped an imported project from building into a working
 * site. Each one passed the whole existing suite while the built output was visibly broken, so each
 * is pinned here by the property that was actually violated rather than by implementation detail.
 */

import { describe, test, expect } from "bun:test";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { emitMultiPageProject } from "../src/emit.ts";

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
