/**
 * Content-types.test.ts — the content pipeline through the extension model
 *
 * Exercises the compiler's generic section orchestration end-to-end with the real @jxsuite/parser
 * extension: loadProjectSections dispatches Content.projectData (Markdown/CSV/JSON sources,
 * relationship resolution), expandDynamicRoutes routes discriminated $paths through resolvePaths,
 * resolvePrototypes exposes `_project.content` to ContentCollection/ContentEntry, and buildSite
 * ties it all together. Format/section unit behavior itself is covered in the parser package.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { buildProjectExtensionRegistry } from "../src/site/format-host";
import { loadProjectSections } from "../src/site/project-sections";
import { discoverPages, expandDynamicRoutes } from "../src/site/pages-discovery";
import { injectContext } from "../src/site/context-injection";
import { resolvePrototypes } from "../src/site/prototype-resolver";
import { loadProjectConfig } from "../src/site/site-loader";
import { buildSite } from "../src/site/site-build";
import type { ExtensionRegistry } from "@jxsuite/schema/extension-registry";
import type { ContentLoaderEntry, JxElement, ProjectConfig } from "@jxsuite/schema/types";

const TMP = resolve(import.meta.dir, "__test-content__");

/** Load project config from the test fixture */
function getProjectConfig() {
  return loadProjectConfig(TMP).config;
}

/** @param {string} relPath @param {string|object} content */
function writeFile(relPath: string, content: string | object) {
  const abs = resolve(TMP, relPath);
  mkdirSync(resolve(abs, ".."), { recursive: true });
  writeFileSync(
    abs,
    typeof content === "string" ? content : JSON.stringify(content, null, 2),
    "utf8",
  );
}

let registry: ExtensionRegistry;
let sections: Record<string, unknown>;

function contentMap(): Map<string, ContentLoaderEntry[]> {
  return sections.content as Map<string, ContentLoaderEntry[]>;
}

// ── Test fixtures ─────────────────────────────────────────────────────────────

beforeAll(async () => {
  rmSync(TMP, { force: true, recursive: true });

  // Project.json — extension model: sections are extension-contributed top-level keys
  writeFile("project.json", {
    build: { outDir: "./dist" },
    content: {
      authors: {
        format: "json",
        schema: {
          properties: {
            bio: { type: "string" },
            name: { type: "string" },
          },
          required: ["name"],
          type: "object",
        },
        source: "./content/authors/",
      },
      blog: {
        format: "Markdown",
        schema: {
          properties: {
            author: { $ref: "#/content/authors" },
            draft: { default: false, type: "boolean" },
            pubDate: { format: "date", type: "string" },
            tags: { items: { type: "string" }, type: "array" },
            title: { type: "string" },
          },
          required: ["title", "pubDate"],
          type: "object",
        },
        source: "./content/blog/",
      },
      products: {
        schema: {
          properties: {
            category: { type: "string" },
            name: { type: "string" },
            price: { type: "number" },
            sku: { type: "string" },
          },
          required: ["sku", "name", "price"],
          type: "object",
        },
        source: "./content/products/catalog.csv",
      },
    },
    defaults: { lang: "en", layout: "./layouts/base.json" },
    extensions: ["@jxsuite/parser"],
    // Optimization is exercised in image-transform.test.ts against a mocked Sharp; here the
    // Point is which files the build copies, so keep the real encoder out of it.
    images: { optimize: false },
    name: "Content Test Site",
    url: "https://test.com",
  });

  // Layout
  writeFile("layouts/base.json", {
    children: [{ children: [{ tagName: "slot" }], tagName: "main" }],
    tagName: "div",
  });

  // Blog posts (Markdown)
  writeFile(
    "content/blog/hello-world.md",
    `---
title: Hello World
pubDate: "2024-01-15"
author: jane
tags:
  - intro
  - welcome
draft: false
---

# Hello World

This is my first blog post. Welcome!

![A diagram](./images/diagram.png)
`,
  );

  // Assets living beside the entries: one referenced by a post, one never referenced
  writeFile("content/blog/images/diagram.png", "png-bytes");
  writeFile("content/blog/images/unused.png", "png-bytes");

  writeFile(
    "content/blog/second-post.md",
    `---
title: Second Post
pubDate: "2024-02-20"
author: jane
tags:
  - update
draft: false
---

# Second Post

Another great article here.
`,
  );

  writeFile(
    "content/blog/draft-post.md",
    `---
title: Draft Post
pubDate: "2024-03-01"
draft: true
---

# Draft

This shouldn't show up in published lists.
`,
  );

  // Authors (JSON)
  writeFile("content/authors/jane.json", {
    bio: "A prolific writer",
    id: "jane",
    name: "Jane Doe",
  });

  // Products (CSV)
  writeFile(
    "content/products/catalog.csv",
    `sku,name,price,category
WIDGET-1,Blue Widget,9.99,widgets
GADGET-2,Red Gadget,19.99,gadgets
WIDGET-3,Green Widget,14.99,widgets`,
  );

  // ── Pages ─────────────────────────────────────────────────────────────

  // Static index page
  writeFile("pages/index.json", {
    children: [{ children: ["Home"], tagName: "h1" }],
    title: "Home",
  });

  // Blog listing page
  writeFile("pages/blog/index.json", {
    children: [{ children: ["Blog Posts"], tagName: "h1" }],
    state: {
      posts: {
        $prototype: "ContentCollection",
        $src: "@jxsuite/parser/ContentCollection.class.json",
        contentType: "blog",
        filter: { draft: false },
        sort: { field: "pubDate", order: "desc" },
      },
    },
    title: "Blog",
  });

  // Dynamic blog post page — extension-discriminated $paths
  writeFile("pages/blog/[slug].json", {
    $paths: {
      contentType: "blog",
      field: "id",
      param: "slug",
    },
    children: [{ children: "${state.post.$children ?? []}", tagName: "article" }],
    state: {
      post: {
        $prototype: "ContentEntry",
        $src: "@jxsuite/parser/ContentEntry.class.json",
        contentType: "blog",
        id: { $ref: "#/$params/slug" },
      },
    },
    title: "Blog Post",
  });

  // Page with explicit $paths values
  writeFile("pages/[lang]/index.json", {
    $paths: {
      param: "lang",
      values: ["en", "fr", "de"],
    },
    children: [{ children: ["Localized Page"], tagName: "h1" }],
    title: "Localized",
  });

  const config = getProjectConfig();
  registry = await buildProjectExtensionRegistry(TMP, config);
  sections = await loadProjectSections(TMP, config, registry);
});

afterAll(() => {
  rmSync(TMP, { force: true, recursive: true });
});

// ── Section loading through the extension registry ───────────────────────────

describe("loadProjectSections", () => {
  it("loads the content section keyed by its section key", () => {
    expect(Object.keys(sections)).toEqual(["content"]);
    expect(contentMap()).toBeInstanceOf(Map);
    expect([...contentMap().keys()].toSorted()).toEqual(["authors", "blog", "products"]);
  });

  it("loads Markdown content type entries", () => {
    const blog = contentMap().get("blog")!;
    expect(blog.length).toBe(3); // Hello-world, second-post, draft-post

    const hello = blog.find((e) => e.id === "hello-world")!;
    expect(hello.data.title).toBe("Hello World");
    expect(hello.data.pubDate).toBe("2024-01-15");
    expect(Array.isArray(hello.$children)).toBe(true);
    expect(hello.$children!.some((n) => (n as JxElement).tagName === "h1")).toBe(true);
    expect(hello.body).toContain("# Hello World");
  });

  it("loads JSON content type entries", () => {
    const authors = contentMap().get("authors")!;
    expect(authors.length).toBe(1);
    expect(authors[0]!.id).toBe("jane");
    expect(authors[0]!.data.name).toBe("Jane Doe");
  });

  it("loads CSV content type entries with type coercion", () => {
    const products = contentMap().get("products")!;
    expect(products.length).toBe(3);

    const widget = products.find((e) => e.id === "WIDGET-1")!;
    expect(widget.data.name).toBe("Blue Widget");
    expect(widget.data.price).toBe(9.99); // Coerced to number
    expect(typeof widget.data.price).toBe("number");
  });

  it("resolves cross-type relationship refs during projectData", () => {
    const blog = contentMap().get("blog")!;
    const hello = blog.find((e) => e.id === "hello-world")!;
    const author = hello.data.author as ContentLoaderEntry;
    expect(typeof author).toBe("object");
    expect(author.data.name).toBe("Jane Doe");
  });

  it("skips sections whose key is absent from the project config", async () => {
    const bare: ProjectConfig = { extensions: ["@jxsuite/parser"], name: "No Sections" };
    const bareRegistry = await buildProjectExtensionRegistry(TMP, bare);
    const bareSections = await loadProjectSections(TMP, bare, bareRegistry);
    expect(bareSections).toEqual({});
  });
});

// ── $paths expansion ──────────────────────────────────────────────────────────

describe("$paths expansion", () => {
  it("expands extension-discriminated $paths through resolvePaths", async () => {
    const pagesDir = resolve(TMP, "pages");
    const routes = await discoverPages(pagesDir, registry.formats);
    const expanded = await expandDynamicRoutes(routes, TMP, sections, registry, getProjectConfig());

    const blogRoutes = expanded.filter(
      (r) => r.urlPattern.startsWith("/blog/") && r.urlPattern !== "/blog",
    );
    // Should have one route per blog entry (3 posts)
    expect(blogRoutes.length).toBe(3);
    expect(blogRoutes.map((r) => r.urlPattern).toSorted()).toEqual([
      "/blog/draft-post",
      "/blog/hello-world",
      "/blog/second-post",
    ]);
  });

  it("expands explicit values $paths", async () => {
    const pagesDir = resolve(TMP, "pages");
    const routes = await discoverPages(pagesDir, registry.formats);
    const expanded = await expandDynamicRoutes(routes, TMP, sections, registry, getProjectConfig());

    const langRoutes = expanded.filter((r) => ["/en", "/fr", "/de"].includes(r.urlPattern));
    expect(langRoutes.length).toBe(3);
  });

  /*
   * `_meta` is the reserved carrier for facts about the source ENTRY, and it must never survive as
   * a route parameter: it is not one, and letting it through would put it in `$page.params` and in
   * any `:_meta` substitution a URL happened to contain.
   */
  it("lifts the entry timestamp onto the route and keeps it out of the parameters", async () => {
    const stamp = new Date("2024-03-04T05:06:07.000Z");
    utimesSync(resolve(TMP, "content/blog/hello-world.md"), stamp, stamp);
    const freshSections = await loadProjectSections(TMP, getProjectConfig(), registry);
    const pagesDir = resolve(TMP, "pages");
    const routes = await discoverPages(pagesDir, registry.formats);
    const expanded = await expandDynamicRoutes(
      routes,
      TMP,
      freshSections,
      registry,
      getProjectConfig(),
    );

    const hello = expanded.find((r) => r.urlPattern === "/blog/hello-world")!;
    expect(hello.sourceMtime).toBe("2024-03-04T05:06:07Z");
    expect(hello._pathParams).toEqual({ slug: "hello-world" });
  });

  // A route with no entry of its own correctly falls back to its own file's modification time.
  it("leaves sourceMtime unset for the $paths shapes that describe only parameters", async () => {
    const pagesDir = resolve(TMP, "pages");
    const routes = await discoverPages(pagesDir, registry.formats);
    const expanded = await expandDynamicRoutes(routes, TMP, sections, registry, getProjectConfig());

    const lang = expanded.find((r) => r.urlPattern === "/fr")!;
    expect(lang.sourceMtime).toBeUndefined();
  });

  it("preserves _pathParams on expanded routes", async () => {
    const pagesDir = resolve(TMP, "pages");
    const routes = await discoverPages(pagesDir, registry.formats);
    const expanded = await expandDynamicRoutes(routes, TMP, sections, registry, getProjectConfig());

    const hello = expanded.find((r) => r.urlPattern === "/blog/hello-world")!;
    expect(hello._pathParams).toEqual({ slug: "hello-world" });
  });

  it("warns and skips a discriminated $paths with no registered extension", async () => {
    writeFile("pages/things/[id].json", {
      $paths: { param: "id", table: "things" },
      children: [{ tagName: "article" }],
      title: "Thing",
    });
    const warnings: string[] = [];
    const origWarn = console.warn;
    console.warn = (msg: string) => warnings.push(msg);
    try {
      const routes = await discoverPages(resolve(TMP, "pages"), registry.formats);
      const expanded = await expandDynamicRoutes(
        routes,
        TMP,
        sections,
        registry,
        getProjectConfig(),
      );
      expect(expanded.some((r) => r.urlPattern.startsWith("/things/"))).toBe(false);
      expect(warnings.some((w) => w.includes("unrecognized $paths shape"))).toBe(true);
    } finally {
      console.warn = origWarn;
      rmSync(resolve(TMP, "pages/things"), { force: true, recursive: true });
    }
  });
});

// ── ContentCollection/ContentEntry $prototype resolution ──────────────────────

describe("$prototype resolution against _project sections", () => {
  it("resolves ContentCollection $prototype in state", async () => {
    const doc: Record<string, any> = {
      state: {
        posts: {
          $prototype: "ContentCollection",
          $src: "@jxsuite/parser/ContentCollection.class.json",
          contentType: "blog",
          filter: { draft: false },
          sort: { field: "pubDate", order: "desc" },
        },
      },
    };
    const projectConfig = { name: "Test" };
    const route = { _pathParams: {}, urlPattern: "/blog" };

    injectContext(doc as never, projectConfig, route as never, TMP);
    await resolvePrototypes(doc as never, route, TMP, {
      config: projectConfig,
      sections,
    });

    expect(Array.isArray(doc.state.posts)).toBe(true);
    expect(doc.state.posts.length).toBe(2); // Non-drafts
    expect(doc.state.posts[0].data.title).toBe("Second Post"); // Desc order
  });

  it("resolves ContentEntry $prototype with $params ref", async () => {
    const doc: Record<string, any> = {
      state: {
        post: {
          $prototype: "ContentEntry",
          $src: "@jxsuite/parser/ContentEntry.class.json",
          contentType: "blog",
          id: { $ref: "#/$params/slug" },
        },
      },
    };
    const projectConfig = { name: "Test" };
    const route = {
      _pathParams: { slug: "hello-world" },
      urlPattern: "/blog/hello-world",
    };

    injectContext(doc as never, projectConfig, route as never, TMP);
    await resolvePrototypes(doc as never, route, TMP, {
      config: projectConfig,
      sections,
    });

    expect(doc.state.post).not.toBeNull();
    expect(doc.state.post.id).toBe("hello-world");
    expect(doc.state.post.data.title).toBe("Hello World");
    expect(Array.isArray(doc.state.post.$children)).toBe(true);
  });

  it("returns null for missing ContentEntry", async () => {
    const doc: Record<string, any> = {
      state: {
        post: {
          $prototype: "ContentEntry",
          $src: "@jxsuite/parser/ContentEntry.class.json",
          contentType: "blog",
          id: "nonexistent",
        },
      },
    };
    const projectConfig = { name: "Test" };
    const route = { _pathParams: {}, urlPattern: "/blog/nope" };

    injectContext(doc as never, projectConfig, route as never, TMP);
    await resolvePrototypes(doc as never, route, TMP, {
      config: projectConfig,
      sections,
    });

    expect(doc.state.post).toBeNull();
  });

  it("returns empty array for missing content type", async () => {
    const doc: Record<string, any> = {
      state: {
        items: {
          $prototype: "ContentCollection",
          $src: "@jxsuite/parser/ContentCollection.class.json",
          contentType: "nonexistent",
        },
      },
    };
    const projectConfig = { name: "Test" };
    const route = { _pathParams: {}, urlPattern: "/" };

    injectContext(doc as never, projectConfig, route as never, TMP);
    await resolvePrototypes(doc as never, route, TMP, {
      config: projectConfig,
      sections,
    });

    expect(doc.state.items).toEqual([]);
  });
});

// ── Full build with content ───────────────────────────────────────────────────

describe("buildSite with content sections", () => {
  it("builds site with content-driven dynamic routes", async () => {
    const result = await buildSite(TMP, { verbose: false });

    expect(result.errors).toHaveLength(0);

    // Static: /, /blog
    // Dynamic blog: /blog/hello-world, /blog/second-post, /blog/draft-post
    // Dynamic lang: /en, /fr, /de
    expect(result.routes).toBe(8);

    // Verify output files
    const dist = resolve(TMP, "dist");
    expect(existsSync(join(dist, "index.html"))).toBe(true);
    expect(existsSync(join(dist, "blog/index.html"))).toBe(true);
    expect(existsSync(join(dist, "blog/hello-world/index.html"))).toBe(true);
    expect(existsSync(join(dist, "blog/second-post/index.html"))).toBe(true);
    expect(existsSync(join(dist, "blog/draft-post/index.html"))).toBe(true);
    expect(existsSync(join(dist, "en/index.html"))).toBe(true);
    expect(existsSync(join(dist, "fr/index.html"))).toBe(true);
    expect(existsSync(join(dist, "de/index.html"))).toBe(true);
  });

  it("publishes referenced content assets at their mounted URL, and nothing else", async () => {
    await buildSite(TMP, { verbose: false });
    const dist = resolve(TMP, "dist");

    // The post's entry-relative image is rewritten to the mount URL and copied there
    const html = readFileSync(join(dist, "blog/hello-world/index.html"), "utf8");
    expect(html).toContain('src="/content/blog/images/diagram.png"');
    expect(existsSync(join(dist, "content/blog/images/diagram.png"))).toBe(true);

    // Unreferenced siblings and the entry files themselves stay out of the build
    expect(existsSync(join(dist, "content/blog/images/unused.png"))).toBe(false);
    expect(existsSync(join(dist, "content/blog/hello-world.md"))).toBe(false);
  });

  it("fails loudly on the deleted contentTypes key with a migration hint", async () => {
    const TMP2 = resolve(import.meta.dir, "__test-content-legacy__");
    rmSync(TMP2, { force: true, recursive: true });
    mkdirSync(resolve(TMP2, "pages"), { recursive: true });
    writeFileSync(
      resolve(TMP2, "project.json"),
      JSON.stringify({ contentTypes: { posts: { source: "./content/posts/" } } }),
    );
    writeFileSync(resolve(TMP2, "pages/index.json"), JSON.stringify({ tagName: "div" }));

    try {
      expect(buildSite(TMP2, { verbose: false })).rejects.toThrow("migrate-project-extensions");
    } finally {
      rmSync(TMP2, { force: true, recursive: true });
    }
  });
});
