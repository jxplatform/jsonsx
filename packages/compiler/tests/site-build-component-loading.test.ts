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
    // The sheet is inlined rather than linked, but it is still written under the matching name for
    // Anything that references it directly.
    expect(existsSync(resolve(TMP, "dist/components/ls-stats.css"))).toBe(true);
    expect(html).toContain('<script type="module" src="/components/ls-stats.js">');
    expect(html).toContain("ls-stats {");
    expect(html).not.toContain('rel="stylesheet"');
  });

  it("preloads the runtime and component modules the import map only names", () => {
    const html = readFileSync(resolve(TMP, "dist/index.html"), "utf8");
    const head = html.slice(0, html.indexOf("</head>"));
    /*
     * An import map says where `@vue/reactivity` lives; it does not fetch it. Without these the
     * runtime is discovered only after a component module is fetched AND parsed — three round trips
     * deep on the critical path.
     */
    expect(head).toContain('<link rel="modulepreload" href="/assets/vue-reactivity.js">');
    expect(head).toContain('<link rel="modulepreload" href="/assets/lit-html.js">');
    expect(head).toContain('<link rel="modulepreload" href="/components/ls-stats.js">');
    // A directory prefix key (`lit-html/`) is not a file any build writes, so it is never preloaded.
    expect(head).not.toContain('href="/assets/lit-html/"');
    // Every hint names a module the page actually loads.
    const hints = [...head.matchAll(/rel="modulepreload" href="([^"]+)"/g)];
    const hrefs = hints.map((match) => match[1] as string);
    expect(hrefs).toHaveLength(3);
    for (const href of hrefs) {
      const onDisk = resolve(TMP, "dist", href.slice(1));
      expect(existsSync(onDisk)).toBe(true);
    }
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

  it("inlines the component stylesheet too", () => {
    const html = readFileSync(resolve(TMP, "dist/index.html"), "utf8");
    expect(html).toContain("ls-row {");
    expect(html).toContain("display: block");
    // Inlined, not linked — one render-blocking request per component was the whole critical path.
    expect(html).not.toContain('rel="stylesheet"');
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

// ── A repeater whose build-time list is empty keeps its client binding ────────

describe("buildSite — a build-time-empty repeater is not collapsed", () => {
  const TMP = resolve(import.meta.dir, "__test-empty-repeater__");

  /**
   * `expandMappedArrayStatic` returns `[]` for a list that resolves to empty at build time, and
   * `[]` is truthy — so the repeater used to be replaced with nothing at all, discarding the
   * definition the client needed. The list then rendered nothing forever, however much state
   * changed.
   *
   * @param {string} dir
   * @param {unknown} children
   */
  async function build(dir: string, children: unknown) {
    const root = resolve(TMP, dir);
    rmSync(root, { force: true, recursive: true });
    writeJSON(root, "project.json", { build: { outDir: "./dist" }, name: "Empty Repeater" });
    writeJSON(root, "pages/index.json", {
      children,
      state: { rows: { default: [] } },
      title: "Home",
    });
    writeJSON(root, "components/ls-row.json", {
      children: [{ tagName: "span", textContent: "row" }],
      tagName: "ls-row",
    });
    await buildSite(root, { verbose: false });
    return {
      html: readFileSync(resolve(root, "dist/index.html"), "utf8"),
      island: existsSync(resolve(root, "dist/app.js"))
        ? readFileSync(resolve(root, "dist/app.js"), "utf8")
        : "",
    };
  }

  afterAll(() => {
    rmSync(TMP, { force: true, recursive: true });
  });

  it("keeps the whole-children form bound to the client", async () => {
    const { html, island } = await build("whole", {
      $prototype: "Array",
      items: { $ref: "#/state/rows" },
      map: { tagName: "ls-row" },
    });

    expect(html).toContain(':render="_list0"');
    expect(island).toContain("<ls-row");
  });

  it("keeps the sibling form bound, and its siblings intact", async () => {
    const { html, island } = await build("sibling", [
      { tagName: "h1", textContent: "Rows" },
      { $prototype: "Array", items: { $ref: "#/state/rows" }, map: { tagName: "ls-row" } },
      { tagName: "p", textContent: "end" },
    ]);

    expect(html).toContain(':render="_children0"');
    expect(island).toContain("<ls-row");
  });

  it("injects the component loader for the client-rendered rows", async () => {
    const { html } = await build("loader", {
      $prototype: "Array",
      items: { $ref: "#/state/rows" },
      map: { tagName: "ls-row" },
    });

    expect(html).toContain('src="/components/ls-row.js"');
  });
});

// ── A non-empty build-time list still prerenders with zero JS ────────────────

describe("buildSite — a resolvable non-empty repeater still prerenders", () => {
  const TMP = resolve(import.meta.dir, "__test-static-repeater__");

  beforeAll(async () => {
    rmSync(TMP, { force: true, recursive: true });
    writeJSON(TMP, "project.json", { build: { outDir: "./dist" }, name: "Static Repeater" });
    writeJSON(TMP, "pages/index.json", {
      children: {
        $prototype: "Array",
        items: { $ref: "#/state/rows" },
        map: { tagName: "ls-row" },
      },
      state: { rows: { default: [{ n: 1 }, { n: 2 }] } },
      title: "Home",
    });
    writeJSON(TMP, "components/ls-row.json", {
      children: [{ tagName: "span", textContent: "row" }],
      tagName: "ls-row",
    });
    await buildSite(TMP, { verbose: false });
  });

  afterAll(() => {
    rmSync(TMP, { force: true, recursive: true });
  });

  it("expands the items into static markup", () => {
    const html = readFileSync(resolve(TMP, "dist/index.html"), "utf8");
    expect(html.match(/<ls-row/g)).toHaveLength(2);
    expect(html).not.toContain(":render=");
  });

  it("does not client-render the rows", () => {
    // The guard must not turn a statically resolvable list into a client-rendered one. (A page with
    // Any `state` still emits an inert bootstrapper; what matters is that it carries no list.)
    const island = existsSync(resolve(TMP, "dist/app.js"))
      ? readFileSync(resolve(TMP, "dist/app.js"), "utf8")
      : "";
    expect(island).not.toContain("<ls-row");
    expect(island).not.toContain("_list0");
    expect(island).not.toContain("_children0");
  });
});
