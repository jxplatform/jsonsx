import { describe, expect, test } from "bun:test";
import { discoverPages, expandDynamicRoutes } from "../src/site/pages-discovery";
import { buildProjectFormatRegistry } from "../src/site/format-host";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const FIXTURES = join(import.meta.dir, "_fixtures_pages");

// Registry with the Markdown format registered — .md pages require explicit imports
const mdRegistry = await buildProjectFormatRegistry(FIXTURES, {
  imports: { Markdown: "@jxsuite/parser/Markdown.class.json" },
});

function setup() {
  rmSync(FIXTURES, { force: true, recursive: true });
  mkdirSync(FIXTURES, { recursive: true });
}

function cleanup() {
  rmSync(FIXTURES, { force: true, recursive: true });
}

// ─── discoverPages ──────────────────────────────────────────────────────────

describe("discoverPages", () => {
  test("discovers index.json as root route", async () => {
    setup();
    writeFileSync(join(FIXTURES, "index.json"), JSON.stringify({ tagName: "div" }));
    const routes = await discoverPages(FIXTURES);
    expect(routes.length).toBe(1);
    expect(routes[0]!.urlPattern).toBe("/");
    expect(routes[0]!.isDynamic).toBe(false);
    cleanup();
  });

  test("discovers nested page routes", async () => {
    setup();
    mkdirSync(join(FIXTURES, "about"), { recursive: true });
    writeFileSync(join(FIXTURES, "about", "index.json"), JSON.stringify({ tagName: "div" }));
    const routes = await discoverPages(FIXTURES);
    const aboutRoute = routes.find((r) => r.urlPattern === "/about");
    expect(aboutRoute).toBeDefined();
    cleanup();
  });

  test("discovers dynamic [param] routes", async () => {
    setup();
    mkdirSync(join(FIXTURES, "blog", "[slug]"), { recursive: true });
    writeFileSync(
      join(FIXTURES, "blog", "[slug]", "index.json"),
      JSON.stringify({ tagName: "div" }),
    );
    const routes = await discoverPages(FIXTURES);
    const blogRoute = routes.find((r) => r.urlPattern.includes(":slug")) as any;
    expect(blogRoute).toBeDefined();
    expect(blogRoute.isDynamic).toBe(true);
    expect(blogRoute.params).toContain("slug");
    cleanup();
  });

  test("discovers catch-all [...param] routes", async () => {
    setup();
    mkdirSync(join(FIXTURES, "docs", "[...path]"), { recursive: true });
    writeFileSync(
      join(FIXTURES, "docs", "[...path]", "index.json"),
      JSON.stringify({ tagName: "div" }),
    );
    const routes = await discoverPages(FIXTURES);
    const docsRoute = routes.find((r) => r.isCatchAll) as any;
    expect(docsRoute).toBeDefined();
    expect(docsRoute.urlPattern).toContain("*");
    expect(docsRoute.params).toContain("path");
    cleanup();
  });

  test("extracts $layout from JSON page", async () => {
    setup();
    writeFileSync(
      join(FIXTURES, "index.json"),
      JSON.stringify({ $layout: "blog", tagName: "div" }),
    );
    const routes = await discoverPages(FIXTURES);
    expect(routes[0]!.$layout).toBe("blog");
    cleanup();
  });

  test("extracts $layout from markdown frontmatter", async () => {
    setup();
    writeFileSync(join(FIXTURES, "post.md"), "---\n$layout: article\ntitle: Hello\n---\n# Hello");
    const routes = await discoverPages(FIXTURES, mdRegistry);
    const mdRoute = routes.find((r) => r.sourcePath.endsWith(".md")) as any;
    expect(mdRoute).toBeDefined();
    expect(mdRoute.$layout).toBe("article");
    cleanup();
  });

  test("$layout is null when not specified", async () => {
    setup();
    writeFileSync(join(FIXTURES, "index.json"), JSON.stringify({ tagName: "div" }));
    const routes = await discoverPages(FIXTURES);
    expect(routes[0]!.$layout).toBeNull();
    cleanup();
  });

  test("discovers .md files as pages", async () => {
    setup();
    writeFileSync(join(FIXTURES, "about.md"), "---\ntitle: About\n---\n# About");
    const routes = await discoverPages(FIXTURES, mdRegistry);
    const mdRoute = routes.find((r) => r.urlPattern === "/about") as any;
    expect(mdRoute).toBeDefined();
    expect(mdRoute.sourcePath).toContain(".md");
    cleanup();
  });
});

// ─── expandDynamicRoutes ────────────────────────────────────────────────────

describe("expandDynamicRoutes", () => {
  test("passes static routes through unchanged", async () => {
    const routes = [
      {
        $layout: null,
        isCatchAll: false,
        isDynamic: false,
        params: [],
        relativePath: "",
        sourcePath: "/x",
        urlPattern: "/",
      },
    ];
    const result = await expandDynamicRoutes(routes, FIXTURES);
    expect(result).toEqual(routes);
  });

  test("expands dynamic route with legacy array $paths", async () => {
    setup();
    const pagePath = join(FIXTURES, "page.json");
    writeFileSync(
      pagePath,
      JSON.stringify({
        $paths: [{ slug: "hello" }, { slug: "world" }],
        tagName: "div",
      }),
    );
    const routes = [
      {
        $layout: null,
        isCatchAll: false,
        isDynamic: true,
        params: ["slug"],
        relativePath: "",
        sourcePath: pagePath,
        urlPattern: "/blog/:slug",
      },
    ];
    const result = await expandDynamicRoutes(routes, FIXTURES);
    expect(result.length).toBe(2);
    expect(result[0]!.urlPattern).toBe("/blog/hello");
    expect(result[1]!.urlPattern).toBe("/blog/world");
    expect(result[0]!.isDynamic).toBe(false);
    cleanup();
  });

  test("expands dynamic route with explicit values $paths", async () => {
    setup();
    const pagePath = join(FIXTURES, "lang.json");
    writeFileSync(
      pagePath,
      JSON.stringify({
        $paths: { param: "lang", values: ["en", "fr", "de"] },
        tagName: "div",
      }),
    );
    const routes = [
      {
        $layout: null,
        isCatchAll: false,
        isDynamic: true,
        params: ["lang"],
        relativePath: "",
        sourcePath: pagePath,
        urlPattern: "/:lang",
      },
    ];
    const result = await expandDynamicRoutes(routes, FIXTURES);
    expect(result.length).toBe(3);
    expect(result[0]!.urlPattern).toBe("/en");
    expect(result[1]!.urlPattern).toBe("/fr");
    expect(result[2]!.urlPattern).toBe("/de");
    cleanup();
  });

  test("expands dynamic route with content type $paths", async () => {
    setup();
    const pagePath = join(FIXTURES, "post.json");
    writeFileSync(
      pagePath,
      JSON.stringify({
        $paths: { contentType: "blog", field: "slug", param: "slug" },
        tagName: "div",
      }),
    );
    const contentTypes = new Map([
      [
        "blog",
        [
          { body: null, data: { slug: "hello-world", title: "Hello" }, id: "1" },
          { body: null, data: { slug: "second-post", title: "Second" }, id: "2" },
        ],
      ],
    ]);
    const routes = [
      {
        $layout: null,
        isCatchAll: false,
        isDynamic: true,
        params: ["slug"],
        relativePath: "",
        sourcePath: pagePath,
        urlPattern: "/blog/:slug",
      },
    ];
    const result = await expandDynamicRoutes(routes, FIXTURES, contentTypes);
    expect(result.length).toBe(2);
    expect(result[0]!.urlPattern).toBe("/blog/hello-world");
    expect(result[1]!.urlPattern).toBe("/blog/second-post");
    cleanup();
  });

  test("expands dynamic route with $ref to data file", async () => {
    setup();
    writeFileSync(
      join(FIXTURES, "products.json"),
      JSON.stringify([
        { name: "Widget", sku: "ABC123" },
        { name: "Gadget", sku: "DEF456" },
      ]),
    );
    const pagePath = join(FIXTURES, "product.json");
    writeFileSync(
      pagePath,
      JSON.stringify({
        $paths: { $ref: "./products.json", field: "sku", param: "id" },
        tagName: "div",
      }),
    );
    const routes = [
      {
        $layout: null,
        isCatchAll: false,
        isDynamic: true,
        params: ["id"],
        relativePath: "",
        sourcePath: pagePath,
        urlPattern: "/products/:id",
      },
    ];
    const result = await expandDynamicRoutes(routes, FIXTURES);
    expect(result.length).toBe(2);
    expect(result[0]!.urlPattern).toBe("/products/ABC123");
    expect(result[1]!.urlPattern).toBe("/products/DEF456");
    cleanup();
  });

  test("handles missing content type gracefully", async () => {
    setup();
    const pagePath = join(FIXTURES, "missing.json");
    writeFileSync(
      pagePath,
      JSON.stringify({
        $paths: { contentType: "nonexistent", param: "id" },
        tagName: "div",
      }),
    );
    const routes = [
      {
        $layout: null,
        isCatchAll: false,
        isDynamic: true,
        params: ["id"],
        relativePath: "",
        sourcePath: pagePath,
        urlPattern: "/x/:id",
      },
    ];
    const result = await expandDynamicRoutes(routes, FIXTURES);
    expect(result.length).toBe(0);
    cleanup();
  });

  test("handles missing $ref data file gracefully", async () => {
    setup();
    const pagePath = join(FIXTURES, "ref-missing.json");
    writeFileSync(
      pagePath,
      JSON.stringify({
        $paths: { $ref: "./no-such-file.json", param: "id" },
        tagName: "div",
      }),
    );
    const routes = [
      {
        $layout: null,
        isCatchAll: false,
        isDynamic: true,
        params: ["id"],
        relativePath: "",
        sourcePath: pagePath,
        urlPattern: "/x/:id",
      },
    ];
    const result = await expandDynamicRoutes(routes, FIXTURES);
    expect(result.length).toBe(0);
    cleanup();
  });

  test("handles non-array $ref data gracefully", async () => {
    setup();
    writeFileSync(join(FIXTURES, "obj-data.json"), JSON.stringify({ not: "an array" }));
    const pagePath = join(FIXTURES, "obj-ref.json");
    writeFileSync(
      pagePath,
      JSON.stringify({
        $paths: { $ref: "./obj-data.json", param: "id" },
        tagName: "div",
      }),
    );
    const routes = [
      {
        $layout: null,
        isCatchAll: false,
        isDynamic: true,
        params: ["id"],
        relativePath: "",
        sourcePath: pagePath,
        urlPattern: "/x/:id",
      },
    ];
    const result = await expandDynamicRoutes(routes, FIXTURES);
    expect(result.length).toBe(0);
    cleanup();
  });

  test("skips dynamic route without $paths", async () => {
    setup();
    const pagePath = join(FIXTURES, "no-paths.json");
    writeFileSync(pagePath, JSON.stringify({ tagName: "div" }));
    const routes = [
      {
        $layout: null,
        isCatchAll: false,
        isDynamic: true,
        params: ["id"],
        relativePath: "",
        sourcePath: pagePath,
        urlPattern: "/x/:id",
      },
    ];
    const result = await expandDynamicRoutes(routes, FIXTURES);
    expect(result.length).toBe(0);
    cleanup();
  });

  test("handles unrecognized $paths shape", async () => {
    setup();
    const pagePath = join(FIXTURES, "weird-paths.json");
    writeFileSync(
      pagePath,
      JSON.stringify({
        $paths: { something: "weird" },
        tagName: "div",
      }),
    );
    const routes = [
      {
        $layout: null,
        isCatchAll: false,
        isDynamic: true,
        params: ["id"],
        relativePath: "",
        sourcePath: pagePath,
        urlPattern: "/x/:id",
      },
    ];
    const result = await expandDynamicRoutes(routes, FIXTURES);
    expect(result.length).toBe(0);
    cleanup();
  });

  test("passes through dynamic route with unreadable file", async () => {
    const routes = [
      {
        $layout: null,
        isCatchAll: false,
        isDynamic: true,
        params: ["id"],
        relativePath: "",
        sourcePath: "/nonexistent/page.json",
        urlPattern: "/x/:id",
      },
    ];
    const result = await expandDynamicRoutes(routes, FIXTURES);
    expect(result.length).toBe(1);
    expect(result[0]!.urlPattern).toBe("/x/:id");
  });
});

process.on("exit", () => {
  try {
    cleanup();
  } catch {}
});
