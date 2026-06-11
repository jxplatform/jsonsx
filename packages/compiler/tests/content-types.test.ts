/** Content-types.test.js — Tests for Phase 2 content type system */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  findEntry,
  getContentTypeElements,
  loadContentConfig,
  loadContentTypes,
  queryContentType,
  resolveContentTypeRefs,
} from "../src/site/content-loader";
import { discoverPages, expandDynamicRoutes } from "../src/site/pages-discovery";
import { injectContext } from "../src/site/context-injection";
import { resolvePrototypes } from "../src/site/prototype-resolver";
import { loadProjectConfig } from "../src/site/site-loader";
import { buildSite } from "../src/site/site-build";
import type { ContentLoaderEntry } from "@jxsuite/parser/types";
import type { JxElement } from "@jxsuite/schema/types";

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

// ── Test fixtures ─────────────────────────────────────────────────────────────

beforeAll(() => {
  rmSync(TMP, { force: true, recursive: true });

  // Project.json (includes contentTypes definition)
  writeFile("project.json", {
    build: { outDir: "./dist" },
    contentTypes: {
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
            author: { $ref: "#/contentTypes/authors" },
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
    imports: {
      ContentCollection: "@jxsuite/parser/ContentCollection.class.json",
      ContentEntry: "@jxsuite/parser/ContentEntry.class.json",
      Csv: "@jxsuite/parser/Csv.class.json",
      Markdown: "@jxsuite/parser/Markdown.class.json",
    },
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
`,
  );

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
        contentType: "blog",
        filter: { draft: false },
        sort: { field: "pubDate", order: "desc" },
      },
    },
    title: "Blog",
  });

  // Dynamic blog post page — content type-based $paths
  writeFile("pages/blog/[slug].json", {
    $paths: {
      contentType: "blog",
      field: "id",
      param: "slug",
    },
    children: [{ children: ["Post content here"], tagName: "article" }],
    state: {
      post: {
        $prototype: "ContentEntry",
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
});

afterAll(() => {
  rmSync(TMP, { force: true, recursive: true });
});

// ── content-loader ────────────────────────────────────────────────────────────

describe("content-loader", () => {
  describe("loadContentConfig", () => {
    it("loads content.config.json", () => {
      const result = loadContentConfig(TMP, getProjectConfig()) as any;
      expect(result).not.toBeNull();
      expect(result.config.contentTypes).toBeDefined();
      expect(result.config.contentTypes.blog).toBeDefined();
      expect(result.config.contentTypes.authors).toBeDefined();
      expect(result.config.contentTypes.products).toBeDefined();
    });

    it("returns empty contentTypes when no project config", () => {
      const result = loadContentConfig(`/tmp/nope-${Date.now()}`) as any;
      expect(result).not.toBeNull();
      expect(result.config.contentTypes).toEqual({});
    });
  });

  describe("loadContentTypes", () => {
    it("loads Markdown content type entries", async () => {
      const contentTypes = await loadContentTypes(TMP, getProjectConfig());
      const blog = contentTypes.get("blog") as ContentLoaderEntry[];
      expect(blog).toBeDefined();
      expect(blog.length).toBe(3); // Hello-world, second-post, draft-post

      const hello = blog.find((e) => e.id === "hello-world") as any;
      expect(hello).toBeDefined();
      expect(hello.data.title).toBe("Hello World");
      expect(hello.data.pubDate).toBe("2024-01-15");
      expect(Array.isArray(hello.$children)).toBe(true);
      expect(hello.$children.some((n: JxElement) => n.tagName === "h1")).toBe(true);
      expect(hello.body).toContain("# Hello World");
    });

    it("loads JSON content type entries", async () => {
      const contentTypes = await loadContentTypes(TMP, getProjectConfig());
      const authors = contentTypes.get("authors") as ContentLoaderEntry[];
      expect(authors).toBeDefined();
      expect(authors.length).toBe(1);
      expect(authors[0].id).toBe("jane");
      expect(authors[0].data.name).toBe("Jane Doe");
    });

    it("loads CSV content type entries with type coercion", async () => {
      const contentTypes = await loadContentTypes(TMP, getProjectConfig());
      const products = contentTypes.get("products") as ContentLoaderEntry[];
      expect(products).toBeDefined();
      expect(products.length).toBe(3);

      const widget = products.find((e) => e.id === "WIDGET-1") as any;
      expect(widget).toBeDefined();
      expect(widget.data.name).toBe("Blue Widget");
      expect(widget.data.price).toBe(9.99); // Coerced to number
      expect(typeof widget.data.price).toBe("number");
    });
  });

  describe("queryContentType", () => {
    it("filters entries", async () => {
      const contentTypes = await loadContentTypes(TMP, getProjectConfig());
      const blog = contentTypes.get("blog") as ContentLoaderEntry[];
      const published = queryContentType(blog, { filter: { draft: false } });
      expect(published.length).toBe(2);
      expect(published.every((e) => e.data.draft === false)).toBe(true);
    });

    it("sorts entries", async () => {
      const contentTypes = await loadContentTypes(TMP, getProjectConfig());
      const blog = contentTypes.get("blog") as ContentLoaderEntry[];
      const sorted = queryContentType(blog, {
        sort: { field: "pubDate", order: "desc" },
      }) as ContentLoaderEntry[];
      expect((sorted[0].data.pubDate as any) >= (sorted[1].data.pubDate as any)).toBe(true);
    });

    it("limits entries", async () => {
      const contentTypes = await loadContentTypes(TMP, getProjectConfig());
      const blog = contentTypes.get("blog") as ContentLoaderEntry[];
      const limited = queryContentType(blog, { limit: 1 });
      expect(limited.length).toBe(1);
    });

    it("combines filter + sort + limit", async () => {
      const contentTypes = await loadContentTypes(TMP, getProjectConfig());
      const blog = contentTypes.get("blog") as ContentLoaderEntry[];
      const result = queryContentType(blog, {
        filter: { draft: false },
        limit: 1,
        sort: { field: "pubDate", order: "desc" },
      });
      expect(result.length).toBe(1);
      expect(result[0].data.title).toBe("Second Post"); // Most recent non-draft
    });
  });

  describe("findEntry", () => {
    it("finds entry by ID", async () => {
      const contentTypes = await loadContentTypes(TMP, getProjectConfig());
      const blog = contentTypes.get("blog") as ContentLoaderEntry[];
      const entry = findEntry(blog, "hello-world") as any;
      expect(entry).not.toBeNull();
      expect((entry as any).data.title).toBe("Hello World");
    });

    it("returns null for missing ID", async () => {
      const contentTypes = await loadContentTypes(TMP, getProjectConfig());
      const blog = contentTypes.get("blog") as ContentLoaderEntry[];
      expect(findEntry(blog, "nonexistent")).toBeNull();
    });
  });

  describe("resolveContentTypeRefs", () => {
    it("resolves cross-content-type $ref (author → authors)", async () => {
      const contentTypes = await loadContentTypes(TMP, getProjectConfig());
      const contentConfig = loadContentConfig(TMP, getProjectConfig()) as any;
      resolveContentTypeRefs(contentTypes, contentConfig.config);

      const blog = contentTypes.get("blog") as ContentLoaderEntry[];
      const hello = blog.find((e) => e.id === "hello-world") as any;
      // Author "jane" should be resolved to the full author entry
      expect(hello.data.author).toBeDefined();
      expect(typeof hello.data.author).toBe("object");
      expect(hello.data.author.data.name).toBe("Jane Doe");
    });
  });
});

// ── $paths expansion ──────────────────────────────────────────────────────────

describe("$paths expansion", () => {
  it("expands content type-based $paths", async () => {
    const contentTypes = await loadContentTypes(TMP, getProjectConfig());
    const pagesDir = resolve(TMP, "pages");
    const routes = await discoverPages(pagesDir);
    const expanded = await expandDynamicRoutes(routes, TMP, contentTypes);

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
    const contentTypes = await loadContentTypes(TMP, getProjectConfig());
    const pagesDir = resolve(TMP, "pages");
    const routes = await discoverPages(pagesDir);
    const expanded = await expandDynamicRoutes(routes, TMP, contentTypes);

    const langRoutes = expanded.filter((r) => ["/en", "/fr", "/de"].includes(r.urlPattern));
    expect(langRoutes.length).toBe(3);
  });

  it("preserves _pathParams on expanded routes", async () => {
    const contentTypes = await loadContentTypes(TMP, getProjectConfig());
    const pagesDir = resolve(TMP, "pages");
    const routes = await discoverPages(pagesDir);
    const expanded = await expandDynamicRoutes(routes, TMP, contentTypes);

    const hello = expanded.find((r) => r.urlPattern === "/blog/hello-world") as any;
    expect(hello._pathParams).toEqual({ slug: "hello-world" });
  });
});

// ── ContentCollection/ContentEntry $prototype resolution ──────────────────────

describe("$prototype resolution in context-injection", () => {
  it("resolves ContentCollection $prototype in state", async () => {
    const contentTypes = await loadContentTypes(TMP, getProjectConfig());
    const doc: any = {
      imports: {
        ContentCollection: "@jxsuite/parser/ContentCollection.class.json",
      },
      state: {
        posts: {
          $prototype: "ContentCollection",
          contentType: "blog",
          filter: { draft: false },
          sort: { field: "pubDate", order: "desc" },
        },
      },
    };
    const projectConfig = { name: "Test" };
    const route = { _pathParams: {}, urlPattern: "/blog" };

    injectContext(doc, projectConfig, route, contentTypes);
    await resolvePrototypes(doc, route, TMP, {
      config: projectConfig,
      contentTypes,
    });

    expect(Array.isArray(doc.state.posts)).toBe(true);
    expect(doc.state.posts.length).toBe(2); // Non-drafts
    expect(doc.state.posts[0].data.title).toBe("Second Post"); // Desc order
  });

  it("resolves ContentEntry $prototype with $params ref", async () => {
    const contentTypes = await loadContentTypes(TMP, getProjectConfig());
    const doc: any = {
      imports: {
        ContentEntry: "@jxsuite/parser/ContentEntry.class.json",
      },
      state: {
        post: {
          $prototype: "ContentEntry",
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

    injectContext(doc, projectConfig, route, contentTypes);
    await resolvePrototypes(doc, route, TMP, {
      config: projectConfig,
      contentTypes,
    });

    expect(doc.state.post).not.toBeNull();
    expect(doc.state.post.id).toBe("hello-world");
    expect(doc.state.post.data.title).toBe("Hello World");
    expect(Array.isArray(doc.state.post.$children)).toBe(true);
  });

  it("returns null for missing ContentEntry", async () => {
    const contentTypes = await loadContentTypes(TMP, getProjectConfig());
    const doc = {
      imports: {
        ContentEntry: "@jxsuite/parser/ContentEntry.class.json",
      },
      state: {
        post: {
          $prototype: "ContentEntry",
          contentType: "blog",
          id: "nonexistent",
        },
      },
    };
    const projectConfig = { name: "Test" };
    const route = { _pathParams: {}, urlPattern: "/blog/nope" };

    injectContext(doc, projectConfig, route, contentTypes);
    await resolvePrototypes(doc, route, TMP, {
      config: projectConfig,
      contentTypes,
    });

    expect(doc.state.post).toBeNull();
  });

  it("returns empty array for missing content type", async () => {
    const contentTypes = await loadContentTypes(TMP, getProjectConfig());
    const doc: any = {
      imports: {
        ContentCollection: "@jxsuite/parser/ContentCollection.class.json",
      },
      state: {
        items: {
          $prototype: "ContentCollection",
          contentType: "nonexistent",
        },
      },
    };
    const projectConfig = { name: "Test" };
    const route = { _pathParams: {}, urlPattern: "/" };

    injectContext(doc, projectConfig, route, contentTypes);
    await resolvePrototypes(doc, route, TMP, {
      config: projectConfig,
      contentTypes,
    });

    expect(doc.state.items).toEqual([]);
  });
});

// ── Full build with content ───────────────────────────────────────────────────

describe("buildSite with content types", () => {
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
});

// ── content-loader edge cases ────────────────────────────────────────────────

describe("content-loader edge cases", () => {
  it("parses CSV with quoted newlines and escaped quotes", async () => {
    const TMP2 = resolve(import.meta.dir, "__test-content-csv__");
    rmSync(TMP2, { force: true, recursive: true });
    mkdirSync(resolve(TMP2, "content/items"), { recursive: true });

    writeFileSync(
      resolve(TMP2, "project.json"),
      JSON.stringify({
        contentTypes: {
          items: {
            format: "Csv",
            schema: {
              properties: {
                desc: { type: "string" },
                name: { type: "string" },
              },
              required: ["name"],
            },
            source: "./content/items/data.csv",
          },
        },
        imports: { Csv: "@jxsuite/parser/Csv.class.json" },
      }),
    );
    // CSV with: multiline field (newline inside quotes) AND doubled-quote escape
    writeFileSync(
      resolve(TMP2, "content/items/data.csv"),
      'name,desc\n"Line1\nLine2",Simple\n"Has ""quotes""",Plain',
    );

    try {
      const contentTypes = await loadContentTypes(
        TMP2,
        JSON.parse(readFileSync(resolve(TMP2, "project.json"), "utf8")),
      );
      const items = contentTypes.get("items") as ContentLoaderEntry[];
      expect(items.length).toBe(2);
      // First item: multiline field preserved correctly
      expect(items[0].data.name).toBe("Line1\nLine2");
      // Second item: escaped quotes resolved to literal quotes
      expect(items[1].data.name).toBe('Has "quotes"');
    } finally {
      rmSync(TMP2, { force: true, recursive: true });
    }
  });

  it("loads JSON array entries without id fields", async () => {
    const TMP2 = resolve(import.meta.dir, "__test-content-json-arr__");
    rmSync(TMP2, { force: true, recursive: true });
    mkdirSync(resolve(TMP2, "content/items"), { recursive: true });

    writeFileSync(
      resolve(TMP2, "project.json"),
      JSON.stringify({
        contentTypes: {
          items: {
            schema: { properties: { name: { type: "string" } } },
            source: "./content/items/list.json",
          },
        },
      }),
    );
    writeFileSync(
      resolve(TMP2, "content/items/list.json"),
      JSON.stringify([{ name: "Alpha" }, { name: "Beta" }]),
    );

    try {
      const contentTypes = await loadContentTypes(
        TMP2,
        JSON.parse(readFileSync(resolve(TMP2, "project.json"), "utf8")),
      );
      const items = contentTypes.get("items") as ContentLoaderEntry[];
      expect(items.length).toBe(2);
      expect(items[0].id).toContain("list-0");
      expect(items[1].id).toContain("list-1");
    } finally {
      rmSync(TMP2, { force: true, recursive: true });
    }
  });

  it("getContentTypeElements returns $elements from content type def", () => {
    const TMP2 = resolve(import.meta.dir, "__test-content-elements__");
    rmSync(TMP2, { force: true, recursive: true });
    mkdirSync(TMP2, { recursive: true });

    const projectConfig = {
      contentTypes: {
        blog: {
          $elements: ["my-component", { $ref: "./card.json" }],
          source: "./content/blog/",
        },
      },
    };

    const result = getContentTypeElements(TMP2, "blog", projectConfig);
    expect(result).toEqual(["my-component", { $ref: "./card.json" }]);

    const missing = getContentTypeElements(TMP2, "nonexistent", projectConfig);
    expect(missing).toBeUndefined();

    rmSync(TMP2, { force: true, recursive: true });
  });

  it("validates entries: warns on missing required field", async () => {
    const TMP2 = resolve(import.meta.dir, "__test-content-validate__");
    rmSync(TMP2, { force: true, recursive: true });
    mkdirSync(resolve(TMP2, "content/items"), { recursive: true });

    writeFileSync(
      resolve(TMP2, "project.json"),
      JSON.stringify({
        contentTypes: {
          items: {
            format: "json",
            schema: {
              properties: {
                active: { type: "boolean" },
                count: { type: "number" },
                name: { type: "string" },
                tags: { type: "array" },
              },
              required: ["name"],
            },
            source: "./content/items/",
          },
        },
      }),
    );
    // Entry missing required "name" field, and has wrong types for all checked branches
    writeFileSync(
      resolve(TMP2, "content/items/bad.json"),
      JSON.stringify({
        active: "yes",
        count: "not-a-number",
        id: "bad",
        name: 123,
        tags: "not-array",
      }),
    );

    try {
      const contentTypes = await loadContentTypes(
        TMP2,
        JSON.parse(readFileSync(resolve(TMP2, "project.json"), "utf8")),
      );
      const items = contentTypes.get("items") as ContentLoaderEntry[];
      expect(items.length).toBe(1);
      expect(items[0].id).toBe("bad");
    } finally {
      rmSync(TMP2, { force: true, recursive: true });
    }
  });

  it("sorts entries in ascending order (comparison branches)", async () => {
    const contentTypes = await loadContentTypes(TMP, getProjectConfig());
    const blog = contentTypes.get("blog") as ContentLoaderEntry[];
    const sorted = queryContentType(blog, {
      sort: { field: "pubDate", order: "asc" },
    }) as ContentLoaderEntry[];
    expect((sorted[0].data.pubDate as any) <= (sorted[1].data.pubDate as any)).toBe(true);
  });

  it("loadCollection with $elements passes allowedNames", async () => {
    const TMP2 = resolve(import.meta.dir, "__test-content-directives__");
    rmSync(TMP2, { force: true, recursive: true });
    mkdirSync(resolve(TMP2, "content/docs"), { recursive: true });

    writeFileSync(
      resolve(TMP2, "project.json"),
      JSON.stringify({
        contentTypes: {
          docs: {
            $elements: ["my-widget", { $ref: "./card.json" }],
            format: "Markdown",
            schema: { properties: { title: { type: "string" } } },
            source: "./content/docs/",
          },
        },
        imports: { Markdown: "@jxsuite/parser/Markdown.class.json" },
      }),
    );
    writeFileSync(resolve(TMP2, "content/docs/intro.md"), "---\ntitle: Intro\n---\n\nHello docs\n");

    try {
      const contentTypes = await loadContentTypes(
        TMP2,
        JSON.parse(readFileSync(resolve(TMP2, "project.json"), "utf8")),
      );
      const docs = contentTypes.get("docs") as ContentLoaderEntry[];
      expect(docs.length).toBe(1);
      expect(docs[0].data.title).toBe("Intro");
    } finally {
      rmSync(TMP2, { force: true, recursive: true });
    }
  });

  it("validates missing required fields with console.warn", async () => {
    const TMP3 = resolve(import.meta.dir, "__test-content-validation__");
    rmSync(TMP3, { force: true, recursive: true });
    mkdirSync(resolve(TMP3, "content/items"), { recursive: true });

    writeFileSync(
      resolve(TMP3, "project.json"),
      JSON.stringify({
        contentTypes: {
          items: {
            format: "json",
            schema: {
              properties: {
                name: { type: "string" },
                price: { type: "number" },
              },
              required: ["name", "price"],
            },
            source: "./content/items/",
          },
        },
      }),
    );
    writeFileSync(
      resolve(TMP3, "content/items/incomplete.json"),
      JSON.stringify({ id: "incomplete", price: 10 }),
    );

    const warnings: string[] = [];
    const origWarn = console.warn;
    console.warn = (msg: string) => warnings.push(msg);
    try {
      const contentTypes = await loadContentTypes(
        TMP3,
        JSON.parse(readFileSync(resolve(TMP3, "project.json"), "utf8")),
      );
      expect(contentTypes.get("items")).toHaveLength(1);
      expect(warnings.some((w) => w.includes("missing required field"))).toBe(true);
    } finally {
      console.warn = origWarn;
      rmSync(TMP3, { force: true, recursive: true });
    }
  });

  it("sorts entries in descending order", async () => {
    const entries: any[] = [
      { body: null, data: { score: 10 }, id: "a" },
      { body: null, data: { score: 30 }, id: "b" },
      { body: null, data: { score: 20 }, id: "c" },
    ];
    const ascSorted = queryContentType(entries, {
      sort: { field: "score", order: "asc" },
    });
    expect(ascSorted[0].data.score).toBe(10);
    expect(ascSorted[2].data.score).toBe(30);
    const descSorted = queryContentType(entries, {
      sort: { field: "score", order: "desc" },
    });
    expect(descSorted[0].data.score).toBe(30);
    expect(descSorted[2].data.score).toBe(10);
  });
});

// ── Array-based filter and multi-field sort ─────────────────────────────────

describe("queryContentType — array filter with operators", () => {
  const entries: any[] = [
    {
      body: null,
      data: { draft: false, score: 10, tags: ["web"], title: "Alpha Guide" },
      id: "a",
    },
    {
      body: null,
      data: { draft: true, score: 25, tags: [], title: "Beta Post" },
      id: "b",
    },
    {
      body: null,
      data: {
        draft: false,
        score: 15,
        tags: ["api", "web"],
        title: "Gamma Tutorial",
      },
      id: "c",
    },
    {
      body: null,
      data: { draft: false, score: 5, tags: null, title: "" },
      id: "d",
    },
  ];

  it("== operator matches exact values", () => {
    const result = queryContentType(entries, {
      filter: [{ field: "draft", op: "==", value: true }],
    });
    expect(result.length).toBe(1);
    expect(result[0].id).toBe("b");
  });

  it("!= operator excludes values", () => {
    const result = queryContentType(entries, {
      filter: [{ field: "draft", op: "!=", value: true }],
    });
    expect(result.length).toBe(3);
    expect(result.every((e) => e.data.draft === false)).toBe(true);
  });

  it("contains operator matches substring", () => {
    const result = queryContentType(entries, {
      filter: [{ field: "title", op: "contains", value: "Guide" }],
    });
    expect(result.length).toBe(1);
    expect(result[0].id).toBe("a");
  });

  it("not contains operator excludes substring", () => {
    const result = queryContentType(entries, {
      filter: [{ field: "title", op: "not contains", value: "Post" }],
    });
    expect(result.length).toBe(3);
    expect(result.every((e) => !(e.data.title as string).includes("Post"))).toBe(true);
  });

  it("> operator for numeric comparison", () => {
    const result = queryContentType(entries, {
      filter: [{ field: "score", op: ">", value: 10 }],
    });
    expect(result.length).toBe(2);
    expect(result.map((e) => e.id).toSorted()).toEqual(["b", "c"]);
  });

  it("< operator for numeric comparison", () => {
    const result = queryContentType(entries, {
      filter: [{ field: "score", op: "<", value: 15 }],
    });
    expect(result.length).toBe(2);
    expect(result.map((e) => e.id).toSorted()).toEqual(["a", "d"]);
  });

  it(">= operator", () => {
    const result = queryContentType(entries, {
      filter: [{ field: "score", op: ">=", value: 15 }],
    });
    expect(result.length).toBe(2);
    expect(result.map((e) => e.id).toSorted()).toEqual(["b", "c"]);
  });

  it("<= operator", () => {
    const result = queryContentType(entries, {
      filter: [{ field: "score", op: "<=", value: 10 }],
    });
    expect(result.length).toBe(2);
    expect(result.map((e) => e.id).toSorted()).toEqual(["a", "d"]);
  });

  it("empty operator detects null/empty string/empty array", () => {
    const result = queryContentType(entries, {
      filter: [{ field: "tags", op: "empty" }],
    });
    expect(result.length).toBe(2);
    expect(result.map((e) => e.id).toSorted()).toEqual(["b", "d"]);
  });

  it("not empty operator detects non-null/non-empty", () => {
    const result = queryContentType(entries, {
      filter: [{ field: "tags", op: "not empty" }],
    });
    expect(result.length).toBe(2);
    expect(result.map((e) => e.id).toSorted()).toEqual(["a", "c"]);
  });

  it("empty operator on string field", () => {
    const result = queryContentType(entries, {
      filter: [{ field: "title", op: "empty" }],
    });
    expect(result.length).toBe(1);
    expect(result[0].id).toBe("d");
  });

  it("multiple rules are ANDed together", () => {
    const result = queryContentType(entries, {
      filter: [
        { field: "draft", op: "==", value: false },
        { field: "score", op: ">", value: 5 },
      ],
    });
    expect(result.length).toBe(2);
    expect(result.map((e) => e.id).toSorted()).toEqual(["a", "c"]);
  });

  it("field 'id' matches entry.id", () => {
    const result = queryContentType(entries, {
      filter: [{ field: "id", op: "==", value: "c" }],
    });
    expect(result.length).toBe(1);
    expect(result[0].data.title).toBe("Gamma Tutorial");
  });

  it("legacy plain-object filter still works", () => {
    const result = queryContentType(entries, {
      filter: { draft: false, score: 10 },
    });
    expect(result.length).toBe(1);
    expect(result[0].id).toBe("a");
  });
});

describe("queryContentType — multi-field sort", () => {
  const entries: any[] = [
    { body: null, data: { category: "B", title: "Zebra" }, id: "1" },
    { body: null, data: { category: "A", title: "Mango" }, id: "2" },
    { body: null, data: { category: "B", title: "Apple" }, id: "3" },
    { body: null, data: { category: "A", title: "Cherry" }, id: "4" },
  ];

  it("sorts by multiple fields (array format)", () => {
    const result = queryContentType(entries, {
      sort: [
        { field: "category", order: "asc" },
        { field: "title", order: "asc" },
      ],
    });
    expect(result.map((e) => e.id)).toEqual(["4", "2", "3", "1"]);
  });

  it("multi-field sort with mixed orders", () => {
    const result = queryContentType(entries, {
      sort: [
        { field: "category", order: "asc" },
        { field: "title", order: "desc" },
      ],
    });
    expect(result.map((e) => e.id)).toEqual(["2", "4", "1", "3"]);
  });

  it("legacy single-object sort still works", () => {
    const result = queryContentType(entries, {
      sort: { field: "title", order: "asc" },
    });
    expect(result[0].data.title).toBe("Apple");
    expect(result[3].data.title).toBe("Zebra");
  });

  it("sorts by id field", () => {
    const result = queryContentType(entries, {
      sort: [{ field: "id", order: "desc" }],
    });
    expect(result.map((e) => e.id)).toEqual(["4", "3", "2", "1"]);
  });

  it("combined array filter + array sort + limit", () => {
    const result = queryContentType(entries, {
      filter: [{ field: "category", op: "==", value: "B" }],
      limit: 1,
      sort: [{ field: "title", order: "asc" }],
    });
    expect(result.length).toBe(1);
    expect(result[0].data.title).toBe("Apple");
  });
});
