/**
 * Site-build-component-loading.test.ts — how a page finds the component modules it needs.
 *
 * Two defects lived here, both of which produced a silently broken element rather than an error:
 *
 * - The emitted module was named after the component's _source basename_, while the loader `<script>`
 *   and the CSS sidecar both use its `tagName` — so a component whose file name differed from its
 *   tag shipped a `<script>` pointing at a file that was never written (issue #111).
 * - Used-component detection searched only the static page HTML, so a component referenced solely
 *   from inside an island's client template got no loader at all (issue #110).
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildSite } from "../src/site/site-build";

/** @param {string} root @param {string} path @param {unknown} obj */
function writeJSON(root: string, path: string, obj: unknown) {
  const full = resolve(root, path);
  mkdirSync(resolve(full, ".."), { recursive: true });
  writeFileSync(full, JSON.stringify(obj, null, 2), "utf8");
}

// ── Emitted filename follows the tagName, not the source basename (issue #111) ──

describe("buildSite — component modules are named after their tagName", () => {
  const TMP = resolve(import.meta.dir, "__test-comp-tagname__");

  beforeAll(async () => {
    rmSync(TMP, { force: true, recursive: true });
    writeJSON(TMP, "project.json", { build: { outDir: "./dist" }, name: "Tag Test" });
    writeJSON(TMP, "pages/index.json", {
      children: [{ tagName: "ls-stats" }],
      title: "Home",
    });
    // Source basename (`stats-header`) deliberately differs from the tagName (`ls-stats`). The
    // Handler keeps it off the fully-static path, so the page really does need its module.
    writeJSON(TMP, "components/stats-header.json", {
      children: [{ onclick: { $ref: "#/state/bump" }, tagName: "p", textContent: "${state.n}" }],
      state: { bump: { $prototype: "Function", body: "state.n++;" }, n: { default: 0 } },
      style: { display: "block" },
      tagName: "ls-stats",
    });
    await buildSite(TMP, { verbose: false });
  });

  afterAll(() => {
    rmSync(TMP, { force: true, recursive: true });
  });

  it("writes the module under the tagName", () => {
    expect(existsSync(resolve(TMP, "dist/components/ls-stats.js"))).toBe(true);
  });

  it("does not write it under the source basename", () => {
    expect(existsSync(resolve(TMP, "dist/components/stats-header.js"))).toBe(false);
  });

  it("emits a loader script whose target actually exists", () => {
    const html = readFileSync(resolve(TMP, "dist/index.html"), "utf8");
    const match = html.match(/<script type="module" src="\/components\/([^"]+)"><\/script>/);
    expect(match).not.toBeNull();
    // The whole point: the injected src resolved to a file on disk.
    expect(existsSync(resolve(TMP, "dist/components", match![1] as string))).toBe(true);
  });

  it("keeps the JS and CSS sidecars on the same name", () => {
    const html = readFileSync(resolve(TMP, "dist/index.html"), "utf8");
    expect(html).toContain('href="/components/ls-stats.css"');
    expect(existsSync(resolve(TMP, "dist/components/ls-stats.css"))).toBe(true);
  });
});

// ── $elements imports follow the same renaming (issue #111, second half) ──────

describe("buildSite — $elements imports resolve to the renamed dependency", () => {
  const TMP = resolve(import.meta.dir, "__test-comp-elements__");

  beforeAll(async () => {
    rmSync(TMP, { force: true, recursive: true });
    writeJSON(TMP, "project.json", { build: { outDir: "./dist" }, name: "Elements Test" });
    writeJSON(TMP, "pages/index.json", { children: [{ tagName: "ls-parent" }], title: "Home" });
    writeJSON(TMP, "components/parent-doc.json", {
      $elements: [{ $ref: "./child-doc.json" }],
      children: [{ tagName: "ls-child" }],
      tagName: "ls-parent",
    });
    writeJSON(TMP, "components/child-doc.json", {
      children: [{ tagName: "em", textContent: "child" }],
      tagName: "ls-child",
    });
    await buildSite(TMP, { verbose: false });
  });

  afterAll(() => {
    rmSync(TMP, { force: true, recursive: true });
  });

  it("imports the dependency by its tag-based filename", () => {
    const parent = readFileSync(resolve(TMP, "dist/components/ls-parent.js"), "utf8");
    // Renaming the output without renaming the specifier would simply move the 404.
    expect(parent).toContain("import './ls-child.js';");
    expect(parent).not.toContain("child-doc.js");
  });

  it("writes the file that import names", () => {
    expect(existsSync(resolve(TMP, "dist/components/ls-child.js"))).toBe(true);
  });
});

// ── A component used only inside an island's template (issue #110) ────────────

describe("buildSite — components referenced only from an island template", () => {
  const TMP = resolve(import.meta.dir, "__test-comp-island__");

  beforeAll(async () => {
    rmSync(TMP, { force: true, recursive: true });
    writeJSON(TMP, "project.json", { build: { outDir: "./dist" }, name: "Island Test" });
    // The page is an island: the repeater's `items` come from a client-timing fetch, so the build
    // Cannot prerender any row and the `<ls-row>` markup is produced by app.js at runtime instead.
    // That is the shape the issue was reported against — a dashboard mapping fetched records onto a
    // Component.
    writeJSON(TMP, "pages/index.json", {
      children: {
        $prototype: "Array",
        items: { $ref: "#/state/leads" },
        map: { tagName: "ls-row" },
      },
      state: { leads: { $prototype: "Request", url: "/api/leads" } },
      title: "Home",
    });
    // Fully static component: no handlers, no $prototype, no $ref. Its module is still required,
    // Because an island-created instance was never prerendered into the HTML.
    writeJSON(TMP, "components/ls-row.json", {
      children: [{ tagName: "span", textContent: "row" }],
      style: { display: "block" },
      tagName: "ls-row",
    });
    await buildSite(TMP, { verbose: false });
  });

  afterAll(() => {
    rmSync(TMP, { force: true, recursive: true });
  });

  it("emits the island module that references the tag", () => {
    const html = readFileSync(resolve(TMP, "dist/index.html"), "utf8");
    expect(html).toContain('src="./app.js"');
    const island = readFileSync(resolve(TMP, "dist/app.js"), "utf8");
    expect(island).toContain("<ls-row");
  });

  it("does not find the tag in the static HTML", () => {
    const html = readFileSync(resolve(TMP, "dist/index.html"), "utf8");
    // Guards the premise of the test: the loader below cannot come from an HTML match.
    const withoutScripts = html.replaceAll(/<script[\s\S]*?<\/script>/g, "");
    expect(withoutScripts).not.toContain("<ls-row");
  });

  it("injects the loader script anyway, so the element can upgrade", () => {
    const html = readFileSync(resolve(TMP, "dist/index.html"), "utf8");
    expect(html).toContain('<script type="module" src="/components/ls-row.js"></script>');
    expect(existsSync(resolve(TMP, "dist/components/ls-row.js"))).toBe(true);
  });

  it("injects the component stylesheet too", () => {
    const html = readFileSync(resolve(TMP, "dist/index.html"), "utf8");
    expect(html).toContain('href="/components/ls-row.css"');
  });
});

// ── An unused component still gets no loader ─────────────────────────────────

describe("buildSite — unreferenced components stay out of the page", () => {
  const TMP = resolve(import.meta.dir, "__test-comp-unused__");

  beforeAll(async () => {
    rmSync(TMP, { force: true, recursive: true });
    writeJSON(TMP, "project.json", { build: { outDir: "./dist" }, name: "Unused Test" });
    writeJSON(TMP, "pages/index.json", {
      children: [{ tagName: "p", textContent: "nothing here" }],
      title: "Home",
    });
    writeJSON(TMP, "components/ls-unused.json", {
      children: [{ tagName: "span", textContent: "x" }],
      tagName: "ls-unused",
    });
    await buildSite(TMP, { verbose: false });
  });

  afterAll(() => {
    rmSync(TMP, { force: true, recursive: true });
  });

  it("widening the search to island source must not inject every component", () => {
    const html = readFileSync(resolve(TMP, "dist/index.html"), "utf8");
    expect(html).not.toContain("/components/ls-unused.js");
    expect(html).not.toContain("/components/ls-unused.css");
  });
});
