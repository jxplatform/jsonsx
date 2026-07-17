/**
 * Site-nav-docs.test.ts — nested content ids and the nav-manifest sidebar pattern
 *
 * Exercises the jxsuite.com docs-site mechanism end-to-end with the real @jxsuite/parser extension:
 * a content source with subdirectories yields path-based entry ids that expand through a
 * `[...slug]` catch-all route into nested output paths, and a layout-state ContentEntry over a JSON
 * nav manifest feeds nested build-time mapped arrays (section → links) with an aria-current
 * computed from $page.url.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildSite } from "../src/site/site-build";

const TMP = resolve(import.meta.dir, "__test-nav-docs__");

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
  writeFile("content/docs/studio/canvas.md", "---\ntitle: Canvas\n---\n\nCanvas page.\n");

  writeFile("content/nav.json", {
    id: "nav",
    sections: [
      {
        children: [
          { label: "Guide", path: "guide" },
          { label: "Canvas", path: "studio/canvas" },
        ],
        label: "Docs",
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
              attributes: { class: "nav-section" },
              children: [
                {
                  $prototype: "Array",
                  items: { $ref: "$map/item/children" },
                  map: {
                    attributes: {
                      "aria-current":
                        "${(state.$page.url.endsWith('/') ? state.$page.url.slice(0, -1) : state.$page.url) === '/docs/' + item.path ? 'page' : 'false'}",
                      class: "nav-link",
                      href: "/docs/${item.path}/",
                    },
                    tagName: "a",
                    textContent: "${item.label}",
                  },
                },
              ],
              tagName: "div",
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

describe("nested content ids through a catch-all route", () => {
  it("emits nested output paths for subdirectory entries", () => {
    expect(existsSync(resolve(TMP, "dist/docs/guide/index.html"))).toBe(true);
    expect(existsSync(resolve(TMP, "dist/docs/studio/canvas/index.html"))).toBe(true);
  });

  it("renders the entry content on the nested page", () => {
    const html = readFileSync(resolve(TMP, "dist/docs/studio/canvas/index.html"), "utf8");
    expect(html).toContain("Canvas page.");
    expect(html).toContain("<title>Canvas</title>");
  });
});

describe("nav-manifest sidebar via layout ContentEntry + nested mapped arrays", () => {
  it("expands section and link maps from the nav manifest", () => {
    const html = readFileSync(resolve(TMP, "dist/docs/guide/index.html"), "utf8");
    expect(html).toContain('class="nav-section"');
    expect(html).toContain('href="/docs/guide/"');
    expect(html).toContain('href="/docs/studio/canvas/"');
    expect(html).toContain(">Guide</a>");
    expect(html).toContain(">Canvas</a>");
  });

  it("marks only the current page with aria-current=page", () => {
    const guide = readFileSync(resolve(TMP, "dist/docs/guide/index.html"), "utf8");
    const canvas = readFileSync(resolve(TMP, "dist/docs/studio/canvas/index.html"), "utf8");
    expect(guide.match(/aria-current="page"/g)).toHaveLength(1);
    expect(guide).toContain('aria-current="page" class="nav-link" href="/docs/guide/"');
    expect(canvas).toContain('aria-current="page" class="nav-link" href="/docs/studio/canvas/"');
    expect(canvas).toContain('aria-current="false" class="nav-link" href="/docs/guide/"');
  });
});
