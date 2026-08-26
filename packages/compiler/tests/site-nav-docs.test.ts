/**
 * Site-nav-docs.test.ts — nested content ids and the nav-manifest sidebar pattern
 *
 * Exercises the jxsuite.com docs-site mechanism end-to-end with the real @jxsuite/parser extension:
 * a content source with subdirectories yields path-based entry ids that expand through a
 * `[...slug]` catch-all route into nested output paths, and a layout-state ContentEntry over a JSON
 * nav manifest feeds THREE levels of build-time mapped arrays (section → group → link) with an
 * aria-current and two `<details open>` states computed from $page.url.
 *
 * The disclosure assertions are the reason the third level is here rather than two. `open` is a
 * boolean attribute — presence alone opens it — so the two ways of getting this wrong are silent in
 * opposite directions: `open="false"` renders an OPEN section, and a section whose expression is
 * never evaluated renders a closed one on its own page. Both are asserted, on both pages.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildSite } from "../src/site/site-build";

const TMP = resolve(import.meta.dir, "__test-nav-docs__");

/** The current URL, trailing slash guaranteed. */
const URL_NOW = "(state.$page.url.endsWith('/') ? state.$page.url : state.$page.url + '/')";

/** A section opens on a path prefix; it owns a directory. */
const SECTION_OPEN = `\${${URL_NOW}.startsWith('/docs/' + item.path + '/')}`;

/** A group opens on exact page membership; it owns no path at all. */
const GROUP_OPEN = `\${item.pages.some((page) => '/docs/' + page.path + '/' === ${URL_NOW})}`;

const ARIA_CURRENT =
  "${(state.$page.url.endsWith('/') ? state.$page.url.slice(0, -1) : state.$page.url)" +
  " === '/docs/' + item.path ? 'page' : 'false'}";

/** @param {string} relPath @param {string | object} content */
function writeFile(relPath: string, content: string | object) {
  const abs = resolve(TMP, relPath);
  mkdirSync(resolve(abs, ".."), { recursive: true });
  writeFileSync(
    abs,
    typeof content === "string" ? content : JSON.stringify(content, null, 2),
    "utf8",
  );
}

/** One `<a class="nav-link">`, the leaf of both the section and the group maps. */
const navLink = {
  attributes: {
    "aria-current": ARIA_CURRENT,
    class: "nav-link",
    href: "/docs/${item.path}/",
  },
  tagName: "a",
  textContent: "${item.label}",
};

beforeAll(async () => {
  rmSync(TMP, { force: true, recursive: true });

  writeFile("project.json", {
    build: { outDir: "./dist", trailingSlash: "always" },
    content: {
      docs: { format: "Markdown", source: "./content/docs" },
      docsNav: { format: "json", source: "./content/nav.json" },
    },
    extensions: ["@jxsuite/parser"],
    name: "Nav Docs Site",
    url: "https://nav-docs.test",
  });

  writeFile("content/docs/guide.md", "---\ntitle: Guide\n---\n\nTop-level guide.\n");
  writeFile("content/docs/guide/studio/canvas.md", "---\ntitle: Canvas\n---\n\nCanvas page.\n");

  writeFile("content/nav.json", {
    id: "nav",
    sections: [
      {
        groups: [{ label: "Studio", pages: [{ label: "Canvas", path: "guide/studio/canvas" }] }],
        label: "Docs",
        pages: [{ label: "Overview", path: "guide" }],
        path: "guide",
      },
    ],
  });

  writeFile("layouts/docs.json", {
    children: [
      {
        children: [
          {
            $prototype: "Array",
            items: { $ref: "#/state/nav/data/sections" },
            map: {
              attributes: { class: "nav-section", open: SECTION_OPEN },
              children: [
                {
                  attributes: { class: "nav-section-label" },
                  tagName: "summary",
                  textContent: "${item.label}",
                },
                { $prototype: "Array", items: { $ref: "$map/item/pages" }, map: navLink },
                {
                  $prototype: "Array",
                  items: { $ref: "$map/item/groups" },
                  map: {
                    attributes: { class: "nav-group", open: GROUP_OPEN },
                    children: [
                      {
                        attributes: { class: "nav-group-label" },
                        tagName: "summary",
                        textContent: "${item.label}",
                      },
                      { $prototype: "Array", items: { $ref: "$map/item/pages" }, map: navLink },
                    ],
                    tagName: "details",
                  },
                },
              ],
              tagName: "details",
            },
          },
        ],
        tagName: "aside",
      },
      { children: [{ tagName: "slot" }], tagName: "main" },
    ],
    state: {
      nav: { $prototype: "ContentEntry", contentType: "docsNav", id: "nav" },
    },
    tagName: "div",
  });

  writeFile("pages/docs/[...slug].json", {
    $layout: "./layouts/docs.json",
    $paths: { contentType: "docs", field: "id", param: "slug" },
    children: [
      {
        children: "${state.page.$children ?? []}",
        tagName: "article",
      },
    ],
    state: {
      page: {
        $prototype: "ContentEntry",
        contentType: "docs",
        id: { $ref: "#/$params/slug" },
      },
    },
    title: "${state.page.data.title}",
  });

  await buildSite(TMP, { verbose: false });
});

afterAll(() => {
  rmSync(TMP, { force: true, recursive: true });
});

const guideHtml = () => readFileSync(resolve(TMP, "dist/docs/guide/index.html"), "utf8");
const canvasHtml = () =>
  readFileSync(resolve(TMP, "dist/docs/guide/studio/canvas/index.html"), "utf8");

describe("nested content ids through a catch-all route", () => {
  it("emits nested output paths for subdirectory entries", () => {
    expect(existsSync(resolve(TMP, "dist/docs/guide/index.html"))).toBe(true);
    expect(existsSync(resolve(TMP, "dist/docs/guide/studio/canvas/index.html"))).toBe(true);
  });

  it("renders the entry content on the nested page", () => {
    const html = canvasHtml();
    expect(html).toContain("Canvas page.");
    expect(html).toContain("<title>Canvas</title>");
  });
});

describe("nav-manifest sidebar via layout ContentEntry + nested mapped arrays", () => {
  it("expands section, group and link maps from the nav manifest", () => {
    const html = guideHtml();
    expect(html).toContain('class="nav-section"');
    expect(html).toContain('class="nav-group"');
    expect(html).toContain('href="/docs/guide/"');
    expect(html).toContain('href="/docs/guide/studio/canvas/"');
    expect(html).toContain(">Overview</a>");
    expect(html).toContain(">Canvas</a>");
    expect(html).toContain(">Docs</summary>");
    expect(html).toContain(">Studio</summary>");
  });

  it("marks only the current page with aria-current=page", () => {
    expect(guideHtml().match(/aria-current="page"/g)).toHaveLength(1);
    expect(guideHtml()).toContain('aria-current="page" class="nav-link" href="/docs/guide/"');
    expect(canvasHtml()).toContain(
      'aria-current="page" class="nav-link" href="/docs/guide/studio/canvas/"',
    );
    expect(canvasHtml()).toContain('aria-current="false" class="nav-link" href="/docs/guide/"');
  });
});

describe("build-time disclosure state", () => {
  it("never writes a boolean attribute as text", () => {
    // `open="false"` is an OPEN <details>, so this is the assertion that the whole feature rests on.
    for (const html of [guideHtml(), canvasHtml()]) {
      expect(html).not.toContain('open="false"');
      expect(html).not.toContain('open="true"');
    }
  });

  it("opens the section on its own index page and leaves the group closed", () => {
    const html = guideHtml();
    expect(html).toContain('<details class="nav-section" open>');
    expect(html).toContain('<details class="nav-group">');
  });

  it("opens both the section and the group on a page inside the group", () => {
    const html = canvasHtml();
    expect(html).toContain('<details class="nav-section" open>');
    expect(html).toContain('<details class="nav-group" open>');
  });
});
