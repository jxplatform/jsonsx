/**
 * Site-build-import-map.test.ts — the emitted import map may only name files the build wrote.
 *
 * Issue #227: a project with interactivity but NO components emitted `{"@vue/reactivity":
 * "/assets/vue-reactivity.js", "lit-html": "/assets/lit-html.js"}` and never wrote `dist/assets/`
 * at all. The page 404'd on both modules, rendered completely blank, and the build reported `Done:
 * 1 routes → 6 files` with zero errors — the worst of the three possible outcomes, because it
 * passes every structural check and ships a dead page.
 *
 * The cause was bookkeeping rather than bundling: the set that gates `writeClientRuntime` was
 * filled inside `injectComponentScripts`, which returns early unless the page renders at least one
 * component instance. Whether a page NEEDS the runtime and whether it renders a component are
 * unrelated questions, so the tests below assert the invariant directly — every path any page's map
 * names exists on disk — rather than the mechanism that currently satisfies it.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildSite } from "../src/site/site-build";
import { importMapAssetsInHtml } from "../src/site/client-runtime";

function writeJSON(root: string, path: string, obj: unknown) {
  const full = resolve(root, path);
  mkdirSync(resolve(full, ".."), { recursive: true });
  writeFileSync(full, JSON.stringify(obj, null, 2), "utf8");
}

/** Every asset path the page's import map names, and whether each one landed in `dist/`. */
function importMapTargets(root: string, page = "dist/index.html") {
  const html = readFileSync(resolve(root, page), "utf8");
  return importMapAssetsInHtml(html).map((assetPath) => ({
    assetPath,
    written: existsSync(resolve(root, "dist", assetPath.replace(/^\//, ""))),
  }));
}

describe("buildSite — a component-less interactive project (issue #227)", () => {
  const TMP = resolve(import.meta.dir, "__test-importmap-nocomp__");

  beforeAll(async () => {
    rmSync(TMP, { force: true, recursive: true });
    writeJSON(TMP, "project.json", {
      build: { outDir: "./dist", trailingSlash: "always" },
      defaults: { lang: "en", layout: "./layouts/base.json" },
      name: "probe",
      url: "https://example.com",
    });
    // The interactivity lives under a hyphenated LAYOUT, and there is no `components/` directory
    // At all — the exact shape that reported success and shipped a blank page.
    writeJSON(TMP, "layouts/base.json", {
      $id: "ProbeBase",
      children: [{ tagName: "slot" }],
      tagName: "probe-base",
    });
    writeJSON(TMP, "pages/index.json", {
      $id: "ProbePage",
      children: [
        {
          children: [{ tagName: "option", textContent: "Alpha", value: "a" }],
          onchange: { $ref: "#/state/onSel" },
          tagName: "select",
          value: "${state.sel}",
        },
        { tagName: "p", textContent: "${state.sel}" },
      ],
      state: {
        onSel: {
          $prototype: "Function",
          body: "state.sel = event.target.value;",
          parameters: ["state", "event"],
        },
        sel: { default: "a", type: "string" },
      },
      title: "probe",
    });
    await buildSite(TMP, { verbose: false });
  });

  afterAll(() => {
    rmSync(TMP, { force: true, recursive: true });
  });

  it("emits an import map at all — the page really does need the runtime", () => {
    expect(importMapTargets(TMP).map((t) => t.assetPath)).toEqual([
      "/assets/vue-reactivity.js",
      "/assets/lit-html.js",
    ]);
  });

  it("writes every file that map names", () => {
    // Named per path so a failure says WHICH module 404s, not merely that one does.
    expect(importMapTargets(TMP)).toEqual([
      { assetPath: "/assets/vue-reactivity.js", written: true },
      { assetPath: "/assets/lit-html.js", written: true },
    ]);
  });

  it("writes bundles with real content, not empty placeholders", () => {
    for (const { assetPath } of importMapTargets(TMP)) {
      const bytes = readFileSync(resolve(TMP, "dist", assetPath.replace(/^\//, ""))).length;
      expect(bytes).toBeGreaterThan(0);
    }
  });
});

describe("buildSite — a fully static project", () => {
  const TMP = resolve(import.meta.dir, "__test-importmap-static__");

  beforeAll(async () => {
    rmSync(TMP, { force: true, recursive: true });
    writeJSON(TMP, "project.json", { build: { outDir: "./dist" }, name: "Static" });
    writeJSON(TMP, "pages/index.json", {
      children: [{ tagName: "h1", textContent: "Hello" }],
      title: "Home",
    });
    await buildSite(TMP, { verbose: false });
  });

  afterAll(() => {
    rmSync(TMP, { force: true, recursive: true });
  });

  /*
   * The other half of the invariant, and the reason the fix scans rather than always bundles:
   * a page with nothing dynamic on it ships no map, so it must pull no runtime into `dist/`.
   */
  it("ships no import map and no runtime bundles", () => {
    expect(importMapTargets(TMP)).toEqual([]);
    expect(existsSync(resolve(TMP, "dist/assets"))).toBe(false);
  });
});
