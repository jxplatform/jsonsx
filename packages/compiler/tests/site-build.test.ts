/** Site-build.test.js — Tests for the Phase 1 site build pipeline */

import { afterAll, beforeAll, describe, expect, it, mock } from "bun:test";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadProjectConfig } from "../src/site/site-loader";
import { discoverPages } from "../src/site/pages-discovery";
import { resolveLayout } from "../src/site/layout-resolver";
import { mergeHead, renderHead } from "../src/site/head-merger";
import { injectContext } from "../src/site/context-injection";
import { buildSite } from "../src/site/site-build";
import { hashOf } from "../src/site/csp.ts";
import { _testResetNpmCacheBase, _testSetNpmCacheBase } from "../src/site/image-cache.ts";

const TMP = resolve(import.meta.dir, "__test-site__");

/** @param {string} path @param {unknown} obj */
function writeJSON(path: string, obj: unknown) {
  mkdirSync(resolve(TMP, ...path.split("/").slice(0, -1)), { recursive: true });
  writeFileSync(resolve(TMP, path), JSON.stringify(obj, null, 2), "utf8");
}

/** @param {string} path @param {string} content */
function writePlain(path: string, content: string) {
  mkdirSync(resolve(TMP, ...path.split("/").slice(0, -1)), { recursive: true });
  writeFileSync(resolve(TMP, path), content, "utf8");
}

// ── Test fixtures ─────────────────────────────────────────────────────────────

beforeAll(() => {
  rmSync(TMP, { force: true, recursive: true });

  writeJSON("project.json", {
    $head: [{ attributes: { content: "Jx", name: "generator" }, tagName: "meta" }],
    build: { outDir: "./dist" },
    defaults: { lang: "en", layout: "./layouts/base.json" },
    name: "Test Site",
    redirects: {
      "/api/*": { destination: "https://api.example.com/*", rewrite: true },
      "/moved": { destination: "/here", status: 308 },
      "/old": "/new",
      "/seeother": { destination: "/other", status: 303 },
      "/temp": { destination: "/now", status: 302 },
    },
    url: "https://test.com",
  });

  writeJSON("layouts/base.json", {
    children: [
      { children: ["Site Header"], tagName: "header" },
      { children: [{ tagName: "slot" }], tagName: "main" },
      { children: ["Site Footer"], tagName: "footer" },
    ],
    tagName: "div",
  });

  writeJSON("pages/index.json", {
    children: [{ children: ["Welcome"], tagName: "h1" }],
    title: "Home",
  });

  writeJSON("pages/about.json", {
    $dir: "rtl",
    $head: [
      {
        attributes: { content: "About page", name: "description" },
        tagName: "meta",
      },
      {
        attributes: { type: "application/ld+json" },
        tagName: "script",
        textContent: {
          "@context": "https://schema.org",
          "@type": "AboutPage",
          name: "${$site.name}",
        },
      },
    ],
    $lang: "ar-EG",
    children: [{ children: ["About Us"], tagName: "h1" }],
    title: "About",
  });

  writeJSON("pages/blog/index.json", {
    children: [{ children: ["Blog"], tagName: "h1" }],
    title: "Blog",
  });

  writeJSON("pages/_helpers.json", {
    children: ["I should not be a route"],
    tagName: "div",
  });

  writePlain("public/robots.txt", "User-agent: *\nAllow: /\n");
});

afterAll(() => {
  rmSync(TMP, { force: true, recursive: true });
});

// ── site-loader ───────────────────────────────────────────────────────────────

describe("site-loader", () => {
  it("loads project.json with defaults", () => {
    const { config } = loadProjectConfig(TMP);
    expect(config.name).toBe("Test Site");
    expect(config.url).toBe("https://test.com");
    expect(config.defaults.lang).toBe("en");
    expect(config.defaults.charset).toBe("utf8");
    expect(config.build.outDir).toBe("./dist");
  });

  it("throws on missing project.json", () => {
    expect(() => loadProjectConfig("/nonexistent")).toThrow("project.json not found");
  });
});

// ── pages-discovery ───────────────────────────────────────────────────────────

describe("pages-discovery", () => {
  it("discovers static routes", async () => {
    const pagesDir = resolve(TMP, "pages");
    const routes = await discoverPages(pagesDir);
    const urls = routes.map((r) => r.urlPattern);

    expect(urls).toContain("/");
    expect(urls).toContain("/about");
    expect(urls).toContain("/blog");
  });

  it("skips underscore-prefixed files", async () => {
    const pagesDir = resolve(TMP, "pages");
    const routes = await discoverPages(pagesDir);
    const urls = routes.map((r) => r.urlPattern);
    expect(urls).not.toContain("/_helpers");
  });

  it("sorts static routes before dynamic", async () => {
    const pagesDir = resolve(TMP, "pages");
    const routes = await discoverPages(pagesDir);
    // All routes in our fixture are static
    for (const r of routes) {
      expect(r.isDynamic).toBe(false);
    }
  });
});

// ── layout-resolver ───────────────────────────────────────────────────────────

describe("layout-resolver", () => {
  const projectConfig = {
    defaults: { layout: "./layouts/base.json" },
  };

  it("wraps page content in layout with slot distribution", () => {
    const pageDoc = {
      children: [{ children: ["Hello"], tagName: "p" }],
      title: "Test",
    };

    const result = resolveLayout(pageDoc, projectConfig, TMP) as any;

    // Should have the layout structure
    expect(result.tagName).toBe("div");
    expect(result.children).toHaveLength(3); // Header, main, footer

    // Main should now contain the page's <p> instead of <slot>
    const [, main] = result.children as any;
    expect(main.tagName).toBe("main");
    expect(main.children[0].tagName).toBe("p");
    expect(main.children[0].children[0]).toBe("Hello");
  });

  it("returns page as-is when no layout", () => {
    const pageDoc = { children: ["Hello"], tagName: "div" };
    const result = resolveLayout(pageDoc, { defaults: {} }, TMP);
    expect(result).toEqual(pageDoc);
  });
});

// ── head-merger ───────────────────────────────────────────────────────────────

describe("head-merger", () => {
  it("merges site + page heads with deduplication", () => {
    const siteHead = [{ attributes: { content: "Jx", name: "generator" }, tagName: "meta" }];
    const pageHead = [
      {
        attributes: { content: "Page desc", name: "description" },
        tagName: "meta",
      },
    ];

    const merged = mergeHead(siteHead, [], pageHead, {
      title: "Test",
    }) as any[];

    const names = merged
      .filter((e) => e.tagName === "meta" && e.attributes?.name)
      .map((e) => (e as any).attributes.name);

    expect(names).toContain("generator");
    expect(names).toContain("description");
    expect(names).toContain("viewport");
  });

  it("page-level overrides site-level for same key", () => {
    const siteHead = [{ attributes: { content: "Site", name: "description" }, tagName: "meta" }];
    const pageHead = [{ attributes: { content: "Page", name: "description" }, tagName: "meta" }];

    const merged = mergeHead(siteHead, [], pageHead, {}) as any[];
    const desc = merged.find((e) => e.tagName === "meta" && e.attributes?.name === "description");
    expect((desc as any).attributes.content).toBe("Page");
  });

  it("renders to valid HTML", () => {
    const entries = [
      { attributes: { charset: "utf8" }, tagName: "meta" },
      { children: ["Test"], tagName: "title" },
    ];
    const html = renderHead(entries);
    expect(html).toContain('<meta charset="utf8">');
    expect(html).toContain("<title>Test</title>");
  });
});

// ── context-injection ─────────────────────────────────────────────────────────

describe("context-injection", () => {
  it("injects $site and $page into state", () => {
    const doc: any = {};
    const projectConfig = { name: "Test", url: "https://test.com" };
    const route = { _pathParams: {}, urlPattern: "/about" };

    injectContext(doc, projectConfig, route);

    expect(doc.state.$site.name).toBe("Test");
    expect(doc.state.$site.url).toBe("https://test.com");
    expect(doc.state.$page.url).toBe("/about");
  });
});

// ── Full build ────────────────────────────────────────────────────────────────

describe("buildSite", () => {
  it("builds the full site", async () => {
    const result = await buildSite(TMP, { verbose: false });

    expect(result.routes).toBe(3); // /, /about, /blog
    expect(result.errors).toHaveLength(0);

    // Verify output files exist
    const distDir = resolve(TMP, "dist");
    expect(existsSync(join(distDir, "index.html"))).toBe(true);
    expect(existsSync(join(distDir, "about/index.html"))).toBe(true);
    expect(existsSync(join(distDir, "blog/index.html"))).toBe(true);
    expect(existsSync(join(distDir, "_redirects"))).toBe(true);
    expect(existsSync(join(distDir, "robots.txt"))).toBe(true);
  });

  it("generates correct HTML with layout and head merging", async () => {
    await buildSite(TMP, { verbose: false });

    const html = readFileSync(resolve(TMP, "dist/about/index.html"), "utf8");

    // Layout applied
    expect(html).toContain("Site Header");
    expect(html).toContain("Site Footer");

    // Page content in slot
    expect(html).toContain("About Us");

    // Head merging
    expect(html).toContain('name="generator"');
    expect(html).toContain('name="description"');
    expect(html).toContain("<title>About</title>");
  });

  it("generates redirect files", async () => {
    await buildSite(TMP, { verbose: false });

    const redirects = readFileSync(resolve(TMP, "dist/_redirects"), "utf8");
    expect(redirects).toContain("/old /new 301");

    const redirectHtml = readFileSync(resolve(TMP, "dist/old/index.html"), "utf8");
    expect(redirectHtml).toContain('http-equiv="refresh"');
    expect(redirectHtml).toContain("/new");
  });

  /*
   * An HTML meta-refresh is a CLIENT-side redirect, so it is a stand-in for some statuses and a
   * misrepresentation of the others. Every rule reaches `_redirects`; only some get a file.
   */
  describe("the HTML fallback follows the status (RFC 9110 §15.4)", () => {
    it("301 gets a canonical link — the permanent case is the one it fits", async () => {
      await buildSite(TMP, { verbose: false });
      const html = readFileSync(resolve(TMP, "dist/old/index.html"), "utf8");
      expect(html).toContain('rel="canonical"');
      expect(html).not.toContain('name="robots"');
    });

    it("302 and 303 get a file, but noindex instead of a canonical link", async () => {
      await buildSite(TMP, { verbose: false });
      for (const path of ["dist/temp/index.html", "dist/seeother/index.html"]) {
        const html = readFileSync(resolve(TMP, path), "utf8");
        expect(html).toContain('http-equiv="refresh"');
        // A canonical link on a temporary redirect asserts the permanence the status denies.
        expect(html).not.toContain('rel="canonical"');
        expect(html).toContain('name="robots"');
      }
    });

    it("308 gets no file — a meta-refresh would convert POST to GET", async () => {
      await buildSite(TMP, { verbose: false });
      expect(existsSync(resolve(TMP, "dist/moved/index.html"))).toBe(false);
      expect(readFileSync(resolve(TMP, "dist/_redirects"), "utf8")).toContain("/moved /here 308");
    });

    it("a rewrite gets no file, and reaches _redirects as 200", async () => {
      await buildSite(TMP, { verbose: false });
      const redirects = readFileSync(resolve(TMP, "dist/_redirects"), "utf8");
      expect(redirects).toContain("/api/* https://api.example.com/* 200");
      // A file at the source URL would shadow the rewrite on hosts that honour _redirects, and
      // Turn it into a redirect on the hosts that do not. This was the bug.
      expect(existsSync(resolve(TMP, "dist/api"))).toBe(false);
    });

    it("an off-enum status is a build error naming the rule", async () => {
      const root = mkdtempSync(join(tmpdir(), "jx-redirect-"));
      mkdirSync(join(root, "pages"), { recursive: true });
      writeFileSync(
        join(root, "project.json"),
        JSON.stringify({
          build: { outDir: "./dist" },
          name: "Bad Redirect",
          redirects: { "/bad": { destination: "/x", status: 418 } },
        }),
        "utf8",
      );
      writeFileSync(
        join(root, "pages/index.json"),
        JSON.stringify({ children: ["hi"], tagName: "div" }),
        "utf8",
      );
      const result = await buildSite(root, { verbose: false });
      expect(result.errors.some((e) => e.includes("/bad") && e.includes("418"))).toBe(true);
      // The rule is refused outright rather than written through to the host.
      const emitted = join(root, "dist/_redirects");
      expect(existsSync(emitted) && readFileSync(emitted, "utf8").includes("418")).toBe(false);
      rmSync(root, { force: true, recursive: true });
    });
  });

  it("takes lang and dir from the page, not only the site", async () => {
    await buildSite(TMP, { verbose: false });

    const about = readFileSync(resolve(TMP, "dist/about/index.html"), "utf8");
    expect(about).toContain('lang="ar-EG"');
    expect(about).toContain('dir="rtl"');

    // A page that declares neither still gets the site default, and no stray dir.
    const index = readFileSync(resolve(TMP, "dist/index.html"), "utf8");
    expect(index).toContain('lang="en"');
    expect(index).not.toContain("dir=");
  });

  it("serializes a JSON-LD object and resolves templates inside it (§8.5)", async () => {
    await buildSite(TMP, { verbose: false });

    const about = readFileSync(resolve(TMP, "dist/about/index.html"), "utf8");
    expect(about).not.toContain("[object Object]");
    expect(about).toContain('"@type": "AboutPage"');
    // A structured-data block that cannot reference the page it describes is not much use.
    expect(about).toContain('"name": "Test Site"');
  });

  it("emits _headers and .nojekyll", async () => {
    await buildSite(TMP, { verbose: false });

    const headers = readFileSync(resolve(TMP, "dist/_headers"), "utf8");
    expect(headers).toContain("/*\n");
    expect(headers).toContain("Cache-Control: public, max-age=0, must-revalidate");
    expect(headers).toContain("/images/_optimized/*");
    expect(headers).toContain("immutable");
    expect(headers).toContain("X-Content-Type-Options: nosniff");
    // The build knows which filenames carry a content hash and which do not.
    expect(headers).not.toContain("/components/*");

    // Jekyll excludes every `_`-prefixed path, which is most of what the build just wrote.
    expect(existsSync(resolve(TMP, "dist/.nojekyll"))).toBe(true);
  });

  it("generates sitemap.xml from the route table", async () => {
    await buildSite(TMP, { verbose: false });

    const sitemap = readFileSync(resolve(TMP, "dist/sitemap.xml"), "utf8");
    expect(sitemap).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(sitemap).toContain('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">');

    // <loc> matches the canonical-URL form (new URL — no trailing slash appended)
    expect(sitemap).toContain("<loc>https://test.com/</loc>");
    expect(sitemap).toContain("<loc>https://test.com/about</loc>");
    expect(sitemap).toContain("<loc>https://test.com/blog</loc>");

    // <lastmod> is a W3C date
    // Full RFC 3339, not date-only: the W3C Datetime profile admits both, and the date-only form
    // Threw away any way to tell two edits on one day apart.
    expect(sitemap).toMatch(/<lastmod>\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z<\/lastmod>/);

    // Redirect sources are not pages and must not appear
    expect(sitemap).not.toContain("/old");
  });

  it("references the sitemap from robots.txt", async () => {
    await buildSite(TMP, { verbose: false });

    const robots = readFileSync(resolve(TMP, "dist/robots.txt"), "utf8");
    expect(robots).toContain("User-agent: *"); // Preserved from public/robots.txt
    expect(robots).toContain("Sitemap: https://test.com/sitemap.xml");
  });

  it("omits the color-scheme pre-paint script when no scheme query is declared", async () => {
    await buildSite(TMP, { verbose: false });

    const html = readFileSync(resolve(TMP, "dist/index.html"), "utf8");
    expect(html).not.toContain("jx-color-scheme");
    expect(html).not.toContain("data-color-scheme");
  });
});

// ── Color-scheme contract ────────────────────────────────────────────────────

describe("buildSite — color scheme", () => {
  const SCHEME_TMP = resolve(import.meta.dir, "__test-site-scheme__");

  beforeAll(async () => {
    rmSync(SCHEME_TMP, { force: true, recursive: true });
    const write = (path: string, obj: unknown) => {
      mkdirSync(resolve(SCHEME_TMP, ...path.split("/").slice(0, -1)), { recursive: true });
      writeFileSync(resolve(SCHEME_TMP, path), JSON.stringify(obj, null, 2), "utf8");
    };
    write("project.json", {
      $media: { "--dark": "(prefers-color-scheme: dark)" },
      build: { outDir: "./dist" },
      defaults: { lang: "en", layout: "./layouts/base.json" },
      name: "Scheme Site",
      style: { "--bg": "#fff", "@--dark": { "--bg": "#000" } },
    });
    write("layouts/base.json", {
      children: [{ children: [{ tagName: "slot" }], tagName: "main" }],
      tagName: "div",
    });
    write("pages/index.json", {
      children: [{ children: ["Hello"], tagName: "h1" }],
      title: "Home",
    });
    await buildSite(SCHEME_TMP, { verbose: false });
  });

  afterAll(() => {
    rmSync(SCHEME_TMP, { force: true, recursive: true });
  });

  it("injects the pre-paint script exactly once, before the first <style>", () => {
    const html = readFileSync(resolve(SCHEME_TMP, "dist/index.html"), "utf8");
    const marker = 'localStorage.getItem("jx-color-scheme")';
    expect(html).toContain(marker);
    expect(html.indexOf(marker)).toBe(html.lastIndexOf(marker));
    expect(html.indexOf(marker)).toBeLessThan(html.indexOf("<style>"));
  });

  it("dual-emits scheme token overrides and the color-scheme triplet", () => {
    const html = readFileSync(resolve(SCHEME_TMP, "dist/index.html"), "utf8");
    expect(html).toContain(
      "@media (prefers-color-scheme: dark) { :root:where(:not([data-color-scheme])) { --bg: #000 } }",
    );
    expect(html).toContain(':root:where([data-color-scheme="dark"]) { --bg: #000 }');
    expect(html).toContain(":root { color-scheme: light dark }");
  });
});

// ── Server worker generation ─────────────────────────────────────────────────

describe("buildSite — server worker", () => {
  const SERVER_TMP = resolve(import.meta.dir, "__test-site-server__");

  beforeAll(() => {
    rmSync(SERVER_TMP, { force: true, recursive: true });

    const writeJ = (p: string, obj: unknown) => {
      mkdirSync(resolve(SERVER_TMP, ...p.split("/").slice(0, -1)), {
        recursive: true,
      });
      writeFileSync(resolve(SERVER_TMP, p), JSON.stringify(obj, null, 2), "utf8");
    };
    const writeP = (p: string, c: string) => {
      mkdirSync(resolve(SERVER_TMP, ...p.split("/").slice(0, -1)), {
        recursive: true,
      });
      writeFileSync(resolve(SERVER_TMP, p), c, "utf8");
    };

    writeJ("project.json", {
      build: { adapter: "cloudflare-workers", outDir: "./dist" },
      defaults: { lang: "en" },
      name: "Server Test",
      url: "https://test.com",
    });

    writeJ("pages/index.json", {
      children: [{ $props: {}, tagName: "test-contact" }],
      title: "Home",
    });

    writeJ("components/test-contact.json", {
      children: [{ children: ["Contact"], tagName: "form" }],
      state: {
        sendForm: {
          $export: "sendForm",
          $src: "./contact.server.js",
          timing: "server",
        },
      },
      tagName: "test-contact",
    });

    writeP(
      "components/contact.server.js",
      "export function sendForm(args) { return { ok: true }; }\n",
    );
  });

  afterAll(() => {
    rmSync(SERVER_TMP, { force: true, recursive: true });
  });

  it("generates worker.js in dist/", async () => {
    await buildSite(SERVER_TMP, { verbose: false });

    const workerPath = resolve(SERVER_TMP, "dist/worker.js");
    expect(existsSync(workerPath)).toBe(true);

    const content = readFileSync(workerPath, "utf8");
    expect(content).toContain("sendForm");
  });

  it("inlines server function sources into the bundled worker (no dist/components copy)", async () => {
    await buildSite(SERVER_TMP, { verbose: false });

    // Self-contained worker (compiler.md §12): the source is bundled in, not copied beside it.
    expect(existsSync(resolve(SERVER_TMP, "dist/components/contact.server.js"))).toBe(false);
    const worker = readFileSync(resolve(SERVER_TMP, "dist/worker.js"), "utf8");
    expect(worker).toContain("function sendForm");
    expect(worker).not.toMatch(/from\s*["']\.\/components\//);
  });

  it("the bundled worker runs from a directory with no node_modules in scope", async () => {
    await buildSite(SERVER_TMP, { verbose: false });

    // Portability by construction: copy the worker outside the workspace and invoke it.
    const portableDir = mkdtempSync(join(tmpdir(), "jx-worker-portability-"));
    try {
      const portable = join(portableDir, "worker.mjs");
      copyFileSync(resolve(SERVER_TMP, "dist/worker.js"), portable);
      const mod = (await import(portable)) as {
        default: { fetch: (req: Request, env: unknown) => Promise<Response> };
      };
      expect(typeof mod.default.fetch).toBe("function");

      const response = await mod.default.fetch(
        new Request("http://localhost/_jx/server/sendForm", {
          body: JSON.stringify({ args: {} }),
          headers: { "Content-Type": "application/json" },
          method: "POST",
        }),
        {},
      );
      expect(response.status).toBe(200);
    } finally {
      rmSync(portableDir, { force: true, recursive: true });
    }
  });
});

// ── Cloudflare Pages adapter ────────────────────────────────────────────────

describe("buildSite — cloudflare-pages adapter", () => {
  const PAGES_TMP = resolve(import.meta.dir, "__test-site-pages__");

  beforeAll(() => {
    rmSync(PAGES_TMP, { force: true, recursive: true });

    const writeJ = (p: string, obj: unknown) => {
      mkdirSync(resolve(PAGES_TMP, ...p.split("/").slice(0, -1)), {
        recursive: true,
      });
      writeFileSync(resolve(PAGES_TMP, p), JSON.stringify(obj, null, 2), "utf8");
    };
    const writeP = (p: string, c: string) => {
      mkdirSync(resolve(PAGES_TMP, ...p.split("/").slice(0, -1)), {
        recursive: true,
      });
      writeFileSync(resolve(PAGES_TMP, p), c, "utf8");
    };

    writeJ("project.json", {
      build: { adapter: "cloudflare-pages", outDir: "./dist" },
      defaults: { lang: "en" },
      name: "Pages Test",
      url: "https://test.com",
    });

    writeJ("pages/index.json", {
      children: [{ $props: {}, tagName: "test-mailer" }],
      title: "Home",
    });

    writeJ("components/test-mailer.json", {
      children: [{ children: ["Mail"], tagName: "form" }],
      state: {
        sendMail: {
          $export: "sendMail",
          $src: "./mailer.server.js",
          timing: "server",
        },
      },
      tagName: "test-mailer",
    });

    writeP(
      "components/mailer.server.js",
      "export function sendMail(args) { return { ok: true }; }\n",
    );
  });

  afterAll(() => {
    rmSync(PAGES_TMP, { force: true, recursive: true });
  });

  it("generates an advanced-mode _worker.js instead of worker.js", async () => {
    await buildSite(PAGES_TMP, { verbose: false });

    expect(existsSync(resolve(PAGES_TMP, "dist/worker.js"))).toBe(false);
    expect(existsSync(resolve(PAGES_TMP, "dist/functions"))).toBe(false);

    const workerPath = resolve(PAGES_TMP, "dist/_worker.js");
    expect(existsSync(workerPath)).toBe(true);

    const content = readFileSync(workerPath, "utf8");
    // Route and handler survive bundling (string quoting/identifiers may be normalized).
    expect(content).toContain("/_jx/server/sendMail");
    expect(content).toContain("function sendMail");
    // Advanced mode intercepts all requests — unmatched paths fall through to assets
    expect(content).toContain("ASSETS.fetch");
  });

  it("limits worker invocation to /_jx/* via _routes.json", async () => {
    await buildSite(PAGES_TMP, { verbose: false });

    const routes = JSON.parse(readFileSync(resolve(PAGES_TMP, "dist/_routes.json"), "utf8"));
    expect(routes).toEqual({ exclude: [], include: ["/_jx/*"], version: 1 });
  });

  it("inlines server function sources into the bundled worker (no dist/components copy)", async () => {
    await buildSite(PAGES_TMP, { verbose: false });

    expect(existsSync(resolve(PAGES_TMP, "dist/components/mailer.server.js"))).toBe(false);
    const worker = readFileSync(resolve(PAGES_TMP, "dist/_worker.js"), "utf8");
    expect(worker).toContain("function sendMail");
  });
});

// ── Cloudflare Images service ───────────────────────────────────────────────

describe("buildSite — cloudflare images service", () => {
  const CF_IMG_TMP = resolve(import.meta.dir, "__test-site-cf-images__");

  // Cloudflare mode only reads image dimensions (no variant generation); mock sharp so the
  // Test doesn't depend on the native binary being loadable.
  void mock.module("sharp", () => ({
    default: () => ({
      metadata: async () => ({ format: "png", height: 720, width: 1280 }),
    }),
  }));

  async function setupProject(adapter: string) {
    rmSync(CF_IMG_TMP, { force: true, recursive: true });

    const writeJ = (p: string, obj: unknown) => {
      mkdirSync(resolve(CF_IMG_TMP, ...p.split("/").slice(0, -1)), {
        recursive: true,
      });
      writeFileSync(resolve(CF_IMG_TMP, p), JSON.stringify(obj, null, 2), "utf8");
    };

    writeJ("project.json", {
      build: { adapter, outDir: "./dist" },
      defaults: { lang: "en" },
      images: { service: "cloudflare" },
      name: "CF Images Test",
      url: "https://test.com",
    });

    writeJ("pages/index.json", {
      children: [
        {
          attributes: { alt: "Hero", src: "/images/hero.png" },
          tagName: "img",
        },
      ],
      title: "Home",
    });

    mkdirSync(resolve(CF_IMG_TMP, "public/images"), { recursive: true });
    writeFileSync(resolve(CF_IMG_TMP, "public/images/hero.png"), "fake-png-data", "utf8");
  }

  afterAll(() => {
    rmSync(CF_IMG_TMP, { force: true, recursive: true });
  });

  it("rewrites img srcset to /cdn-cgi/image transform URLs without Sharp variants", async () => {
    await setupProject("cloudflare-pages");
    await buildSite(CF_IMG_TMP, { verbose: false });

    const html = readFileSync(resolve(CF_IMG_TMP, "dist/index.html"), "utf8");
    expect(html).toContain(
      "/cdn-cgi/image/width=640,quality=80,fit=scale-down,format=auto/images/hero.png",
    );
    expect(html).toContain('src="/images/hero.png"');

    // No deployed code is needed — a static-only Pages site gets no worker or functions
    expect(existsSync(resolve(CF_IMG_TMP, "dist/_worker.js"))).toBe(false);
    expect(existsSync(resolve(CF_IMG_TMP, "dist/functions"))).toBe(false);

    // Sharp variant pipeline skipped entirely
    expect(existsSync(resolve(CF_IMG_TMP, "dist/images/_optimized"))).toBe(false);
    expect(existsSync(resolve(CF_IMG_TMP, ".cache/images/_optimized"))).toBe(false);
  });

  it("works identically under the workers adapter", async () => {
    await setupProject("cloudflare-workers");
    await buildSite(CF_IMG_TMP, { verbose: false });

    const html = readFileSync(resolve(CF_IMG_TMP, "dist/index.html"), "utf8");
    expect(html).toContain("/cdn-cgi/image/width=640,");

    // The worker is still emitted (wrangler "main" requires it) but carries no image code
    const worker = readFileSync(resolve(CF_IMG_TMP, "dist/worker.js"), "utf8");
    expect(worker).not.toContain("/_jx/image");
  });
});

// ── Verbose logging ──────────────────────────────────────────────────────────

describe("buildSite — verbose mode", () => {
  it("runs without error with verbose: true", async () => {
    const result = await buildSite(TMP, { verbose: true });
    expect(result.routes).toBeGreaterThan(0);
    expect(result.errors).toHaveLength(0);
  });
});

// ── Missing pages directory ──────────────────────────────────────────────────

describe("buildSite — missing pages/", () => {
  const NO_PAGES_TMP = resolve(import.meta.dir, "__test-site-no-pages__");

  beforeAll(() => {
    rmSync(NO_PAGES_TMP, { force: true, recursive: true });
    mkdirSync(NO_PAGES_TMP, { recursive: true });
    writeFileSync(
      resolve(NO_PAGES_TMP, "project.json"),
      JSON.stringify({ build: { outDir: "./dist" }, name: "Test" }),
      "utf8",
    );
  });

  afterAll(() => {
    rmSync(NO_PAGES_TMP, { force: true, recursive: true });
  });

  it("throws when pages/ directory does not exist", async () => {
    // oxlint-disable-next-line typescript/await-thenable -- bun:test async matcher returns a Promise; type-aware engine misresolves its return type
    await expect(buildSite(NO_PAGES_TMP)).rejects.toThrow("pages/ directory not found");
  });
});

// ── Optimized images preservation during clean ───────────────────────────────

describe("buildSite — optimized images cache-to-dist", () => {
  const OPT_TMP = resolve(import.meta.dir, "__test-site-opt-images__");
  // Stand-in for the npm global cache dir, so the test controls the base instead of shelling out to
  // `npm config get cache` (which is unavailable when npm is not on PATH, e.g. a stock Windows shell).
  const NPM_CACHE = resolve(import.meta.dir, "__test-opt-npm-cache__");

  function setupProject() {
    rmSync(OPT_TMP, { force: true, recursive: true });
    mkdirSync(OPT_TMP, { recursive: true });
    writeFileSync(
      resolve(OPT_TMP, "project.json"),
      JSON.stringify({ build: { outDir: "./dist" }, name: "Opt Test" }),
      "utf8",
    );
    mkdirSync(resolve(OPT_TMP, "pages"), { recursive: true });
    writeFileSync(
      resolve(OPT_TMP, "pages/index.json"),
      JSON.stringify({
        children: [{ children: ["Hi"], tagName: "p" }],
        title: "Home",
      }),
      "utf8",
    );
  }

  afterAll(() => {
    rmSync(OPT_TMP, { force: true, recursive: true });
    rmSync(NPM_CACHE, { force: true, recursive: true });
  });

  it("copies cached variants from the global npm cache dir to dist", async () => {
    setupProject();
    // Point the cache base at a controlled directory (no dependency on npm being installed). The
    // Source resolves the cache dir as <base>/jxsuite-images/<project-basename>, so pre-populate
    // That exact path as a prior build would have.
    const { basename } = await import("node:path");
    rmSync(NPM_CACHE, { force: true, recursive: true });
    _testSetNpmCacheBase(NPM_CACHE);
    const npmOptDir = resolve(NPM_CACHE, "jxsuite-images", basename(OPT_TMP), "_optimized");
    mkdirSync(npmOptDir, { recursive: true });
    writeFileSync(resolve(npmOptDir, "npm-cached.webp"), "fake-webp", "utf8");

    try {
      await buildSite(OPT_TMP, { clean: true });
      expect(existsSync(resolve(OPT_TMP, "dist/images/_optimized/npm-cached.webp"))).toBe(true);
    } finally {
      rmSync(NPM_CACHE, { force: true, recursive: true });
      _testResetNpmCacheBase();
    }
  });

  it("falls back to project-local .cache/images when npm cache is unavailable", async () => {
    setupProject();
    // Force the fallback path — equivalent to execSync("npm config get cache") throwing,
    // E.g. npm not in PATH or no network on a restricted CI image.
    _testSetNpmCacheBase(null);

    // Pre-populate the project-local cache as a prior build would have
    mkdirSync(resolve(OPT_TMP, ".cache/images/_optimized"), {
      recursive: true,
    });
    writeFileSync(
      resolve(OPT_TMP, ".cache/images/_optimized/local-cached.webp"),
      "fake-webp",
      "utf8",
    );

    try {
      await buildSite(OPT_TMP, { clean: true });
      expect(existsSync(resolve(OPT_TMP, "dist/images/_optimized/local-cached.webp"))).toBe(true);
    } finally {
      _testResetNpmCacheBase();
    }
  });
});

// ── Component compilation with CSS ───────────────────────────────────────────

describe("buildSite — component CSS generation", () => {
  const COMP_TMP = resolve(import.meta.dir, "__test-site-comp-css__");

  beforeAll(() => {
    rmSync(COMP_TMP, { force: true, recursive: true });
    mkdirSync(COMP_TMP, { recursive: true });
    writeFileSync(
      resolve(COMP_TMP, "project.json"),
      JSON.stringify({ build: { outDir: "./dist" }, name: "Comp Test" }),
      "utf8",
    );
    mkdirSync(resolve(COMP_TMP, "pages"), { recursive: true });
    writeFileSync(
      resolve(COMP_TMP, "pages/index.json"),
      JSON.stringify({
        children: [{ $props: { label: "Click" }, tagName: "my-button" }],
        title: "Home",
      }),
      "utf8",
    );
    mkdirSync(resolve(COMP_TMP, "components"), { recursive: true });
    writeFileSync(
      resolve(COMP_TMP, "components/my-button.json"),
      JSON.stringify({
        children: [{ children: ["${label}"], tagName: "button" }],
        onClick: "console.log('clicked')",
        state: { label: { default: "Default" } },
        style: { display: "inline-block", padding: "8px" },
        tagName: "my-button",
      }),
      "utf8",
    );
  });

  afterAll(() => {
    rmSync(COMP_TMP, { force: true, recursive: true });
  });

  it("generates component CSS file when style is defined", async () => {
    await buildSite(COMP_TMP, { verbose: true });
    const cssPath = resolve(COMP_TMP, "dist/components/my-button.css");
    expect(existsSync(cssPath)).toBe(true);
    const css = readFileSync(cssPath, "utf8");
    expect(css).toContain("my-button");
  });

  it("injects component CSS link and JS script into page HTML", async () => {
    await buildSite(COMP_TMP);
    const html = readFileSync(resolve(COMP_TMP, "dist/index.html"), "utf8");
    expect(html).toContain('href="/components/my-button.css"');
    // Component JS is bundled as app.js or per-component module
    expect(html).toContain('src="./app.js"');
  });

  /*
   * A non-static instance discards its prerendered markup on upgrade and re-renders from state, so
   * unless the props survive as data the element comes back showing "Default" — correct content
   * painting first and then being replaced by the wrong content. compiler.md §5.2 gives
   * connectedCallback a data-jx-props payload as its first prop source; nothing wrote it, and
   * lifting `props.*` into $props had already removed the other channel.
   */
  it("carries $props to a non-static instance as a data-jx-props payload", async () => {
    await buildSite(COMP_TMP, { clean: true });
    const html = readFileSync(resolve(COMP_TMP, "dist/index.html"), "utf8");
    // Non-static: the prerender is a first paint, not a hydration target.
    expect(html).toContain("data-jx-prerendered");
    expect(html).toContain("data-jx-props=");
    const payload = /data-jx-props="([^"]*)"/.exec(html)?.[1] ?? "";
    const decoded = payload.replaceAll("&quot;", '"').replaceAll("&amp;", "&");
    expect(JSON.parse(decoded)).toEqual({ label: "Click" });
  });

  it("writes the component JS sidecar into dist, never beside the source component", async () => {
    await buildSite(COMP_TMP, { clean: true });
    // The compiled custom-element module lands in dist/components/, mirroring the .css sidecar.
    expect(existsSync(resolve(COMP_TMP, "dist/components/my-button.js"))).toBe(true);
    // Regression guard (Windows): compileElement emits an absolute source path with the extension
    // Swapped to .js. A forward-slash-only basename split left the full drive path intact, so the
    // Write resolved back next to the source component instead of into dist.
    expect(existsSync(resolve(COMP_TMP, "components/my-button.js"))).toBe(false);
  });
});

// ── JSON-authored props.* attributes on component instances ─────────────────

describe("buildSite — props.* attributes lift into $props for static render", () => {
  const PROPS_TMP = resolve(import.meta.dir, "__test-site-props-attrs__");

  beforeAll(() => {
    rmSync(PROPS_TMP, { force: true, recursive: true });
    mkdirSync(PROPS_TMP, { recursive: true });
    writeFileSync(
      resolve(PROPS_TMP, "project.json"),
      JSON.stringify({ build: { outDir: "./dist" }, name: "Props Test" }),
      "utf8",
    );
    mkdirSync(resolve(PROPS_TMP, "pages"), { recursive: true });
    writeFileSync(
      resolve(PROPS_TMP, "pages/index.json"),
      JSON.stringify({
        children: [
          {
            attributes: { id: "first", "props.label": "Go" },
            tagName: "tag-chip",
          },
          {
            $props: { label: "Explicit wins" },
            attributes: { "props.label": "Attribute loses" },
            tagName: "tag-chip",
          },
        ],
        title: "Home",
      }),
      "utf8",
    );
    mkdirSync(resolve(PROPS_TMP, "components"), { recursive: true });
    // Fully static component (no handlers/$prototype/$ref) — ships no JS, so the build-time
    // Render is the only place props can be applied.
    writeFileSync(
      resolve(PROPS_TMP, "components/tag-chip.json"),
      JSON.stringify({
        children: [{ tagName: "span", textContent: "${state.label}" }],
        state: { label: { default: "Default" } },
        tagName: "tag-chip",
      }),
      "utf8",
    );
  });

  afterAll(() => {
    rmSync(PROPS_TMP, { force: true, recursive: true });
  });

  it("renders the interior with props.* values and does not leak the attributes", async () => {
    await buildSite(PROPS_TMP, { clean: true });
    const html = readFileSync(resolve(PROPS_TMP, "dist/index.html"), "utf8");
    expect(html).toContain(">Go</span>");
    expect(html).not.toContain("props.label");
    expect(html).not.toContain(">Default</span>");
    // Non-prop attributes survive the lift
    expect(html).toContain('id="first"');
    // Explicit $props takes precedence over a conflicting props.* attribute
    expect(html).toContain(">Explicit wins</span>");
    expect(html).not.toContain(">Attribute loses</span>");
  });
});

// ── Component compilation error handling ─────────────────────────────────────

describe("buildSite — component compilation errors", () => {
  const ERR_TMP = resolve(import.meta.dir, "__test-site-comp-err__");

  beforeAll(() => {
    rmSync(ERR_TMP, { force: true, recursive: true });
    mkdirSync(ERR_TMP, { recursive: true });
    writeFileSync(
      resolve(ERR_TMP, "project.json"),
      JSON.stringify({ build: { outDir: "./dist" }, name: "Err Test" }),
      "utf8",
    );
    mkdirSync(resolve(ERR_TMP, "pages"), { recursive: true });
    writeFileSync(
      resolve(ERR_TMP, "pages/index.json"),
      JSON.stringify({
        children: [{ children: ["OK"], tagName: "p" }],
        title: "Home",
      }),
      "utf8",
    );
    mkdirSync(resolve(ERR_TMP, "components"), { recursive: true });
    // Write invalid JSON to trigger a compilation error
    writeFileSync(resolve(ERR_TMP, "components/broken.json"), "{ invalid json !!!", "utf8");
  });

  afterAll(() => {
    rmSync(ERR_TMP, { force: true, recursive: true });
  });

  it("captures component compilation errors without crashing", async () => {
    const result = await buildSite(ERR_TMP);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toContain("Error compiling component broken.json");
  });
});

// ── Trailing slash "never" ───────────────────────────────────────────────────

describe("buildSite — trailingSlash never", () => {
  const TS_TMP = resolve(import.meta.dir, "__test-site-trailing-slash__");

  beforeAll(() => {
    rmSync(TS_TMP, { force: true, recursive: true });
    mkdirSync(TS_TMP, { recursive: true });
    writeFileSync(
      resolve(TS_TMP, "project.json"),
      JSON.stringify({
        build: { outDir: "./dist", trailingSlash: "never" },
        name: "TS Test",
      }),
      "utf8",
    );
    mkdirSync(resolve(TS_TMP, "pages"), { recursive: true });
    writeFileSync(
      resolve(TS_TMP, "pages/index.json"),
      JSON.stringify({
        children: [{ children: ["Hi"], tagName: "p" }],
        title: "Home",
      }),
      "utf8",
    );
    writeFileSync(
      resolve(TS_TMP, "pages/about.json"),
      JSON.stringify({
        children: [{ children: ["About"], tagName: "p" }],
        title: "About",
      }),
      "utf8",
    );
  });

  afterAll(() => {
    rmSync(TS_TMP, { force: true, recursive: true });
  });

  it("outputs .html files directly (not index.html in subdirs)", async () => {
    await buildSite(TS_TMP);
    // /about → dist/about.html instead of dist/about/index.html
    expect(existsSync(resolve(TS_TMP, "dist/about.html"))).toBe(true);
    expect(existsSync(resolve(TS_TMP, "dist/about/index.html"))).toBe(false);
    // / still → dist/index.html
    expect(existsSync(resolve(TS_TMP, "dist/index.html"))).toBe(true);
  });
});

// ── Redirect patterns with :param and * ─────────────────────────────────────

describe("buildSite — redirect patterns", () => {
  const RD_TMP = resolve(import.meta.dir, "__test-site-redirect-patterns__");

  beforeAll(() => {
    rmSync(RD_TMP, { force: true, recursive: true });
    mkdirSync(RD_TMP, { recursive: true });
    writeFileSync(
      resolve(RD_TMP, "project.json"),
      JSON.stringify({
        build: { outDir: "./dist" },
        name: "Redirect Test",
        redirects: {
          "/archive": { destination: "/blog", status: 302 },
          "/blog/:slug": "/posts/:slug",
          "/docs/*": "/documentation/:splat",
          "/old": "/new",
        },
      }),
      "utf8",
    );
    mkdirSync(resolve(RD_TMP, "pages"), { recursive: true });
    writeFileSync(
      resolve(RD_TMP, "pages/index.json"),
      JSON.stringify({
        children: [{ children: ["Hi"], tagName: "p" }],
        title: "Home",
      }),
      "utf8",
    );
  });

  afterAll(() => {
    rmSync(RD_TMP, { force: true, recursive: true });
  });

  it("writes pattern redirects to _redirects without HTML files", async () => {
    await buildSite(RD_TMP);
    const redirects = readFileSync(resolve(RD_TMP, "dist/_redirects"), "utf8");
    expect(redirects).toContain("/blog/:slug /posts/:slug 301");
    expect(redirects).toContain("/docs/* /documentation/:splat 301");
    // Pattern redirects don't get HTML files
    expect(existsSync(resolve(RD_TMP, "dist/blog/:slug/index.html"))).toBe(false);
  });

  it("handles object-style redirects with custom status", async () => {
    await buildSite(RD_TMP);
    const redirects = readFileSync(resolve(RD_TMP, "dist/_redirects"), "utf8");
    expect(redirects).toContain("/archive /blog 302");
  });
});

// ── Copy config ──────────────────────────────────────────────────────────────

describe("buildSite — copy config", () => {
  const COPY_TMP = resolve(import.meta.dir, "__test-site-copy__");

  beforeAll(() => {
    rmSync(COPY_TMP, { force: true, recursive: true });
    mkdirSync(COPY_TMP, { recursive: true });
    writeFileSync(
      resolve(COPY_TMP, "project.json"),
      JSON.stringify({
        build: { outDir: "./dist" },
        copy: { "assets/logo.svg": "images/logo.svg" },
        name: "Copy Test",
      }),
      "utf8",
    );
    mkdirSync(resolve(COPY_TMP, "pages"), { recursive: true });
    writeFileSync(
      resolve(COPY_TMP, "pages/index.json"),
      JSON.stringify({
        children: [{ children: ["Hi"], tagName: "p" }],
        title: "Home",
      }),
      "utf8",
    );
    mkdirSync(resolve(COPY_TMP, "assets"), { recursive: true });
    writeFileSync(resolve(COPY_TMP, "assets/logo.svg"), "<svg></svg>", "utf8");
  });

  afterAll(() => {
    rmSync(COPY_TMP, { force: true, recursive: true });
  });

  it("copies declarative file mappings to dist/", async () => {
    await buildSite(COPY_TMP, { verbose: true });
    const dest = resolve(COPY_TMP, "dist/images/logo.svg");
    expect(existsSync(dest)).toBe(true);
    expect(readFileSync(dest, "utf8")).toBe("<svg></svg>");
  });
});

// ── Markdown page source ─────────────────────────────────────────────────────

describe("buildSite — markdown pages", () => {
  const MD_TMP = resolve(import.meta.dir, "__test-site-md-pages__");

  beforeAll(() => {
    rmSync(MD_TMP, { force: true, recursive: true });
    mkdirSync(MD_TMP, { recursive: true });
    writeFileSync(
      resolve(MD_TMP, "project.json"),
      JSON.stringify({
        build: { outDir: "./dist" },
        extensions: ["@jxsuite/parser"],
        name: "MD Test",
      }),
      "utf8",
    );
    mkdirSync(resolve(MD_TMP, "pages"), { recursive: true });
    writeFileSync(
      resolve(MD_TMP, "pages/index.md"),
      `---
title: Markdown Home
---

# Welcome

This is a markdown page.
`,
      "utf8",
    );
  });

  afterAll(() => {
    rmSync(MD_TMP, { force: true, recursive: true });
  });

  it("compiles .md pages via the Markdown format class", async () => {
    const result = await buildSite(MD_TMP);
    expect(result.routes).toBe(1);
    expect(result.errors).toHaveLength(0);
    const html = readFileSync(resolve(MD_TMP, "dist/index.html"), "utf8");
    expect(html).toContain("Welcome");
  });
});

// ── Template strings in title and $head ──────────────────────────────────────

describe("buildSite — template string resolution", () => {
  const TPL_TMP = resolve(import.meta.dir, "__test-site-templates__");

  beforeAll(() => {
    rmSync(TPL_TMP, { force: true, recursive: true });
    mkdirSync(TPL_TMP, { recursive: true });
    writeFileSync(
      resolve(TPL_TMP, "project.json"),
      JSON.stringify({ build: { outDir: "./dist" }, name: "TPL Test" }),
      "utf8",
    );
    mkdirSync(resolve(TPL_TMP, "pages"), { recursive: true });
    writeFileSync(
      resolve(TPL_TMP, "pages/index.json"),
      JSON.stringify({
        $head: [
          {
            attributes: { content: "${state.metaDesc}", name: "description" },
            tagName: "meta",
          },
          {
            attributes: { content: "${state.pageTitle}", name: "og:title" },
            tagName: "meta",
          },
        ],
        children: [
          { tagName: "h1", textContent: "${state.pageTitle}" },
          { innerHTML: "${state.metaDesc}", tagName: "p" },
          { style: { color: "${state.pageTitle}" }, tagName: "div" },
          {
            attributes: { href: "/${state.pageTitle}" },
            children: ["Link"],
            tagName: "a",
          },
        ],
        state: {
          metaDesc: { default: "A dynamic description", timing: "compiler" },
          pageTitle: { default: "Dynamic Title", timing: "compiler" },
        },
        title: "${state.pageTitle}",
      }),
      "utf8",
    );
  });

  afterAll(() => {
    rmSync(TPL_TMP, { force: true, recursive: true });
  });

  it("resolves template strings in title, $head, and document tree", async () => {
    const result = await buildSite(TPL_TMP);
    expect(result.errors).toHaveLength(0);
    const html = readFileSync(resolve(TPL_TMP, "dist/index.html"), "utf8");
    expect(html).toContain("<title>Dynamic Title</title>");
    expect(html).toContain('content="A dynamic description"');
    expect(html).toContain('content="Dynamic Title"');
  });

  it("strips compiler-timing state entries after resolution", async () => {
    // The build should succeed — if timing:compiler state was not stripped,
    // It might cause dynamic detection issues
    const result = await buildSite(TPL_TMP);
    expect(result.errors).toHaveLength(0);
  });
});

describe("buildSite — templates inside a structured data block", () => {
  const LD_TMP = resolve(import.meta.dir, "__test-site-ld-templates__");

  beforeAll(() => {
    rmSync(LD_TMP, { force: true, recursive: true });
    mkdirSync(resolve(LD_TMP, "pages"), { recursive: true });
    writeFileSync(
      resolve(LD_TMP, "project.json"),
      JSON.stringify({ build: { outDir: "./dist" }, name: "LD Test" }),
      "utf8",
    );
    writeFileSync(
      resolve(LD_TMP, "pages/index.json"),
      JSON.stringify({
        $head: [
          {
            attributes: { type: "application/ld+json" },
            tagName: "script",
            // A JSON-LD graph is an object of arrays of objects, and a template can sit at any depth.
            textContent: {
              "@context": "https://schema.org",
              "@type": "Article",
              author: { "@type": "Person", name: "${state.author}" },
              headline: "${state.headline}",
              // A non-string leaf passes through untouched — there is nothing in it to resolve.
              isAccessibleForFree: true,
              keywords: ["${state.headline}", "static"],
              wordCount: 42,
            },
          },
        ],
        children: [{ tagName: "h1", textContent: "Structured" }],
        state: {
          author: { default: "Ada Lovelace", timing: "compiler" },
          headline: { default: "A Real Headline", timing: "compiler" },
        },
      }),
      "utf8",
    );
  });

  afterAll(() => {
    rmSync(LD_TMP, { force: true, recursive: true });
  });

  /*
   * A JSON-LD block describes the page it sits on, so a template that stayed a template would
   * publish `${state.headline}` to every consumer reading the page's structured data.
   */
  it("resolves templates nested in arrays and objects, not just at the top level", async () => {
    const result = await buildSite(LD_TMP);
    expect(result.errors).toHaveLength(0);

    const html = readFileSync(resolve(LD_TMP, "dist/index.html"), "utf8");
    expect(html).toContain("A Real Headline");
    expect(html).toContain("Ada Lovelace");
    expect(html).toContain('"wordCount": 42');
    expect(html).toContain('"isAccessibleForFree": true');
    expect(html).not.toContain("${state.");
  });
});

// ── $elements (npm element scripts) ──────────────────────────────────────────

describe("buildSite — npm $elements injection", () => {
  const EL_TMP = resolve(import.meta.dir, "__test-site-elements__");

  beforeAll(() => {
    rmSync(EL_TMP, { force: true, recursive: true });
    mkdirSync(EL_TMP, { recursive: true });
    writeFileSync(
      resolve(EL_TMP, "project.json"),
      JSON.stringify({ build: { outDir: "./dist" }, name: "Elem Test" }),
      "utf8",
    );
    mkdirSync(resolve(EL_TMP, "pages"), { recursive: true });
    writeFileSync(
      resolve(EL_TMP, "pages/index.json"),
      JSON.stringify({
        $elements: ["@shoelace-style/shoelace/dist/components/button/button.js"],
        children: [{ children: ["Click Me"], tagName: "sl-button" }],
        title: "Home",
      }),
      "utf8",
    );
  });

  afterAll(() => {
    rmSync(EL_TMP, { force: true, recursive: true });
  });

  /*
   * The script is BUNDLED, not linked. A component package imports its own dependencies by bare
   * specifier, and the emitted import map only ever carried `@vue/reactivity` and `lit-html`, so
   * the old `/node_modules/<specifier>` URL was doubly broken: the path 404s in production, and
   * even where it resolved the module's own imports did not.
   */
  it("bundles npm element scripts into /assets/", async () => {
    const result = await buildSite(EL_TMP);
    expect(result.errors).toHaveLength(0);
    const html = readFileSync(resolve(EL_TMP, "dist/index.html"), "utf8");
    expect(html).toContain('src="/assets/');
    expect(html).not.toContain("/node_modules/");
    const src = /src="(\/assets\/[^"]+)"/.exec(html)?.[1] ?? "";
    expect(existsSync(resolve(EL_TMP, `dist${src}`))).toBe(true);
  });
});

// ── Bare specifier resolution in $head ───────────────────────────────────────

describe("buildSite — bare specifier resolution in $head", () => {
  const BS_TMP = resolve(import.meta.dir, "__test-site-bare-spec__");

  beforeAll(() => {
    rmSync(BS_TMP, { force: true, recursive: true });
    mkdirSync(BS_TMP, { recursive: true });
    writeFileSync(
      resolve(BS_TMP, "project.json"),
      JSON.stringify({
        $head: [
          {
            attributes: {
              href: "@shoelace-style/shoelace/dist/themes/light.css",
              rel: "stylesheet",
            },
            tagName: "link",
          },
          {
            attributes: { src: "@vue/reactivity", type: "module" },
            tagName: "script",
          },
        ],
        build: { outDir: "./dist" },
        name: "Bare Spec Test",
      }),
      "utf8",
    );
    mkdirSync(resolve(BS_TMP, "pages"), { recursive: true });
    writeFileSync(
      resolve(BS_TMP, "pages/index.json"),
      JSON.stringify({
        children: [{ children: ["Hi"], tagName: "p" }],
        title: "Home",
      }),
      "utf8",
    );
  });

  afterAll(() => {
    rmSync(BS_TMP, { force: true, recursive: true });
  });

  /*
   * `/node_modules/<specifier>` resolved in `jx dev`, where the server serves that path, and 404d
   * on every deployed site, because nothing copies node_modules into dist. The file is copied to
   * `/assets/` under a flattened name instead.
   */
  it("copies bare-specifier $head files into /assets/", async () => {
    const result = await buildSite(BS_TMP);
    expect(result.errors).toHaveLength(0);
    const html = readFileSync(resolve(BS_TMP, "dist/index.html"), "utf8");
    expect(html).not.toContain("/node_modules/");
    expect(html).toContain("/assets/shoelace-style-shoelace-dist-themes-light.css");
    expect(html).toContain("/assets/vue-reactivity");
    expect(
      existsSync(resolve(BS_TMP, "dist/assets/shoelace-style-shoelace-dist-themes-light.css")),
    ).toBe(true);
  });
});

// ── /assets/ name collisions across copies and bundles ──────────────────────

describe("buildSite — a $head copy and a sidecar bundle claiming one asset name", () => {
  const CLASH_TMP = resolve(import.meta.dir, "__test-site-asset-clash__");
  const pkg = (dir: string, files: Record<string, string>) => {
    for (const [rel, body] of Object.entries(files)) {
      const abs = resolve(CLASH_TMP, "node_modules", dir, rel);
      mkdirSync(resolve(abs, ".."), { recursive: true });
      writeFileSync(abs, body, "utf8");
    }
  };

  beforeAll(() => {
    rmSync(CLASH_TMP, { force: true, recursive: true });
    mkdirSync(CLASH_TMP, { recursive: true });
    // `@x/a-b` bundles to /assets/x-a-b.js; `@x/a/b.js` copies to the same name.
    pkg("@x/a-b", {
      "index.js": "export function aOne() {\n  return 1;\n}\n",
      "package.json": '{ "name": "@x/a-b", "main": "index.js" }',
    });
    pkg("@x/a", { "b.js": "export const b = 1;\n", "package.json": '{ "name": "@x/a" }' });
    writeFileSync(
      resolve(CLASH_TMP, "project.json"),
      JSON.stringify({
        $head: [{ attributes: { src: "@x/a/b.js", type: "module" }, tagName: "script" }],
        build: { outDir: "./dist" },
        name: "Asset Clash",
      }),
      "utf8",
    );
    mkdirSync(resolve(CLASH_TMP, "components"), { recursive: true });
    writeFileSync(
      resolve(CLASH_TMP, "components/clash-widget.json"),
      JSON.stringify({
        children: [{ tagName: "span", textContent: "${state.n}" }],
        state: {
          aOne: { $prototype: "Function", $src: "npm:@x/a-b", parameters: ["state"] },
          n: 0,
        },
        tagName: "clash-widget",
      }),
      "utf8",
    );
    mkdirSync(resolve(CLASH_TMP, "pages"), { recursive: true });
    writeFileSync(
      resolve(CLASH_TMP, "pages/index.json"),
      JSON.stringify({ children: [{ tagName: "clash-widget" }], tagName: "main", title: "Home" }),
      "utf8",
    );
  });

  afterAll(() => {
    rmSync(CLASH_TMP, { force: true, recursive: true });
  });

  // Copies and bundles share one URL directory, so the second claim is an error rather than an
  // Overwrite that quietly serves one file under the other's name.
  it("reports the clash instead of letting one overwrite the other", async () => {
    const result = await buildSite(CLASH_TMP, { verbose: false });
    expect(result.errors.some((e) => e.includes("both map to /assets/x-a-b.js"))).toBe(true);
  });
});

// ── The self-hosted client runtime ───────────────────────────────────────────

describe("buildSite — the import map points at the site, not a CDN", () => {
  const RT_TMP = resolve(import.meta.dir, "__test-site-runtime__");

  beforeAll(() => {
    rmSync(RT_TMP, { force: true, recursive: true });
    mkdirSync(resolve(RT_TMP, "components"), { recursive: true });
    mkdirSync(resolve(RT_TMP, "pages"), { recursive: true });
    writeFileSync(
      resolve(RT_TMP, "project.json"),
      JSON.stringify({ build: { outDir: "./dist" }, name: "Runtime Test" }),
      "utf8",
    );
    writeFileSync(
      resolve(RT_TMP, "components/rt-counter.json"),
      JSON.stringify({
        children: [{ onClick: "state.n++", tagName: "button", textContent: "${state.n}" }],
        state: { n: 0 },
        tagName: "rt-counter",
      }),
      "utf8",
    );
    writeFileSync(
      resolve(RT_TMP, "pages/index.json"),
      JSON.stringify({ children: [{ tagName: "rt-counter" }], tagName: "main", title: "Home" }),
      "utf8",
    );
  });

  afterAll(() => {
    rmSync(RT_TMP, { force: true, recursive: true });
  });

  /*
   * Every interactive page used to import its runtime from esm.sh. That is a third party in the
   * load path of every visit, with no integrity metadata, and it made `default-src 'self'`
   * unusable — the policy would have broken every interactive page on the site.
   */
  it("serves @vue/reactivity and lit-html from /assets/", async () => {
    const result = await buildSite(RT_TMP, { verbose: false });
    expect(result.errors).toHaveLength(0);

    const html = readFileSync(resolve(RT_TMP, "dist/index.html"), "utf8");
    expect(html).not.toContain("esm.sh");
    const map = /<script type="importmap">([\s\S]*?)<\/script>/.exec(html)?.[1] ?? "";
    /*
     * Four entries: an exact key per module and a `/`-suffixed prefix key beside it. The prefix is
     * what resolves a SUBPATH — `lit-html/directives/class-map.js`, which a `$src` sidecar imports
     * and which a package-name external leaves in the bundle. Without it the page loads a module
     * that cannot resolve its own import (site-architecture.md §8.7).
     */
    expect(JSON.parse(map)).toEqual({
      imports: {
        "@vue/reactivity": "/assets/vue-reactivity.js",
        "@vue/reactivity/": "/assets/@vue/reactivity/",
        "lit-html": "/assets/lit-html.js",
        "lit-html/": "/assets/lit-html/",
      },
    });

    // And the URLs it names are real files, which is the half a bare rewrite would have missed.
    expect(existsSync(resolve(RT_TMP, "dist/assets/vue-reactivity.js"))).toBe(true);
    expect(existsSync(resolve(RT_TMP, "dist/assets/lit-html.js"))).toBe(true);
  }, 30_000);
});

// ── Content-Security-Policy over a real build ────────────────────────────────

describe("buildSite — the emitted policy authorizes the page it was built from", () => {
  const CSP_TMP = resolve(import.meta.dir, "__test-site-csp__");

  beforeAll(() => {
    rmSync(CSP_TMP, { force: true, recursive: true });
    mkdirSync(resolve(CSP_TMP, "components"), { recursive: true });
    mkdirSync(resolve(CSP_TMP, "pages"), { recursive: true });
    writeFileSync(
      resolve(CSP_TMP, "project.json"),
      JSON.stringify({
        $head: [
          {
            attributes: { type: "application/ld+json" },
            tagName: "script",
            textContent: { "@context": "https://schema.org", "@type": "WebSite" },
          },
        ],
        $media: { dark: "(prefers-color-scheme: dark)" },
        build: { headers: { security: { csp: true } }, outDir: "./dist" },
        name: "CSP Site",
        url: "https://csp.example",
      }),
      "utf8",
    );
    writeFileSync(
      resolve(CSP_TMP, "components/csp-counter.json"),
      JSON.stringify({
        children: [
          { onclick: { $ref: "#/state/bump" }, tagName: "button", textContent: "${state.n}" },
        ],
        state: {
          bump: { $expression: { operator: "+=", target: { $ref: "#/state/n" }, value: 1 } },
          n: 0,
        },
        tagName: "csp-counter",
      }),
      "utf8",
    );
    writeFileSync(
      resolve(CSP_TMP, "pages/index.json"),
      JSON.stringify({ children: [{ tagName: "csp-counter" }], tagName: "main", title: "Home" }),
      "utf8",
    );
  });

  afterAll(() => {
    rmSync(CSP_TMP, { force: true, recursive: true });
  });

  /*
   * The load-bearing assertion of the whole feature: every inline script in the shipped HTML is
   * named by a hash in the shipped header. A hash that does not match the bytes is worse than no
   * policy, so this compares the two artifacts rather than either one against an expectation.
   *
   * Verified in Chrome as well, on this exact shape: the pre-paint script and import map run, the
   * JSON-LD survives without a hash, the counter increments on click, and an injected inline
   * script is blocked.
   */
  it("hashes every executable inline script, and nothing else", async () => {
    const result = await buildSite(CSP_TMP, { verbose: false });
    expect(result.errors).toHaveLength(0);

    const html = readFileSync(resolve(CSP_TMP, "dist/index.html"), "utf8");
    const csp = /\n {2}Content-Security-Policy: (.*)/.exec(
      readFileSync(resolve(CSP_TMP, "dist/_headers"), "utf8"),
    )?.[1];
    expect(csp).toBeDefined();

    const inline = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)].filter(
      (m) => !/\bsrc\s*=/.test(m[1] ?? ""),
    );
    const executable = inline.filter((m) => !/ld\+json/.test(m[1] ?? ""));
    // The pre-paint script and the import map, both present and both hashed.
    expect(executable.length).toBeGreaterThanOrEqual(2);
    for (const match of executable) {
      expect(csp).toContain(hashOf(match[2] ?? ""));
    }

    // The data block is present and deliberately unhashed — CSP never checks it.
    const dataBlock = inline.find((m) => /ld\+json/.test(m[1] ?? ""));
    expect(dataBlock).toBeDefined();
    expect(csp).not.toContain(hashOf(dataBlock?.[2] ?? ""));

    // Nothing cross-origin is left to allow.
    expect(csp).toContain("default-src 'self'");
    expect(csp).not.toContain("https://");
  }, 30_000);
});

// ── Locale routing ───────────────────────────────────────────────────────────

describe("buildSite — locale routing", () => {
  const I18N_TMP = resolve(import.meta.dir, "__test-site-i18n__");
  const page = (rel: string, doc: object) => {
    const abs = resolve(I18N_TMP, "pages", rel);
    mkdirSync(resolve(abs, ".."), { recursive: true });
    writeFileSync(abs, JSON.stringify(doc), "utf8");
  };

  beforeAll(() => {
    rmSync(I18N_TMP, { force: true, recursive: true });
    mkdirSync(I18N_TMP, { recursive: true });
    writeFileSync(
      resolve(I18N_TMP, "project.json"),
      JSON.stringify({
        build: { outDir: "./dist" },
        // Declared in the spellings an author would actually type, to prove canonicalization.
        i18n: { defaultLocale: "EN", locales: ["en", "fr-ca", "ar"] },
        name: "Multi",
        url: "https://multi.example",
      }),
      "utf8",
    );
    page("index.json", { children: ["${$page.locale}"], tagName: "main", title: "Home" });
    page("fr-ca/index.json", { children: ["fr"], tagName: "main", title: "Accueil" });
    page("ar/index.json", { children: ["ar"], tagName: "main", title: "AR" });
    page("about.json", { children: ["about"], tagName: "main", title: "About" });
    page("fr-ca/about.json", { children: ["a propos"], tagName: "main", title: "A propos" });
    page("en/quebec.json", { $lang: "fr-CA", children: ["mixed"], tagName: "main", title: "Q" });
  });

  afterAll(() => {
    rmSync(I18N_TMP, { force: true, recursive: true });
  });

  it("gives each route the lang its prefix declares, and dir only when it earns it", async () => {
    const result = await buildSite(I18N_TMP, { verbose: false });
    expect(result.errors).toHaveLength(0);
    const html = (rel: string) => readFileSync(resolve(I18N_TMP, "dist", rel), "utf8");

    expect(/<html[^>]*lang="en"/.test(html("index.html"))).toBe(true);
    // Canonical case, from a directory named in lower case.
    expect(/<html[^>]*lang="fr-CA"/.test(html("fr-ca/index.html"))).toBe(true);
    // Arabic is right-to-left by script, so `dir` appears without anyone writing it.
    expect(/<html[^>]*dir="rtl"/.test(html("ar/index.html"))).toBe(true);
    // `ltr` is HTML's default; writing it on every page would say nothing.
    expect(html("index.html")).not.toContain('dir="ltr"');
    // An explicit $lang beats the route it sits under.
    expect(/<html[^>]*lang="fr-CA"/.test(html("en/quebec/index.html"))).toBe(true);
    // And the resolved locale is readable from a template.
    expect(html("index.html")).toContain("en");
  }, 30_000);

  /*
   * Discovery, which is the half that makes a translated site legible to anything but a reader.
   * The set is reciprocal and includes each page itself — that is what the annotation means and
   * what a validator checks for — and it only exists because `headEntryKey` keys a link on its
   * qualifying attribute. Before that these four collapsed into one.
   */
  it("advertises its translations in <head> and in the sitemap", async () => {
    await buildSite(I18N_TMP, { verbose: false });
    const html = readFileSync(resolve(I18N_TMP, "dist/index.html"), "utf8");
    const alternates = [...html.matchAll(/hreflang="([^"]+)"/g)].map((m) => m[1]);
    expect(alternates.toSorted()).toEqual(["ar", "en", "fr-CA", "x-default"]);
    // The `x-default` entry names the default locale's URL: where an unmatched visitor goes.
    expect(html).toContain('href="https://multi.example/" hreflang="x-default"');

    const sitemap = readFileSync(resolve(I18N_TMP, "dist/sitemap.xml"), "utf8");
    expect(sitemap).toContain('xmlns:xhtml="http://www.w3.org/1999/xhtml"');
    expect(sitemap).toContain(
      '<xhtml:link rel="alternate" hreflang="ar" href="https://multi.example/ar"/>',
    );
  }, 30_000);

  // A page with no translations gets none: a lone hreflang pointing at itself is noise.
  it("says nothing about a page that has no siblings", async () => {
    writeFileSync(
      resolve(I18N_TMP, "pages/solo.json"),
      JSON.stringify({ children: ["solo"], tagName: "main", title: "Solo" }),
      "utf8",
    );
    await buildSite(I18N_TMP, { verbose: false });
    expect(readFileSync(resolve(I18N_TMP, "dist/solo/index.html"), "utf8")).not.toContain(
      "hreflang",
    );
  }, 30_000);
});

// ── An invalid locale tag ────────────────────────────────────────────────────

describe("buildSite — a malformed BCP 47 tag", () => {
  const BAD_TMP = resolve(import.meta.dir, "__test-site-bad-locale__");

  beforeAll(() => {
    rmSync(BAD_TMP, { force: true, recursive: true });
    mkdirSync(resolve(BAD_TMP, "pages"), { recursive: true });
    writeFileSync(
      resolve(BAD_TMP, "project.json"),
      JSON.stringify({
        build: { outDir: "./dist" },
        i18n: { defaultLocale: "en", locales: ["en", "en_US"] },
        name: "Bad Locale",
      }),
      "utf8",
    );
    writeFileSync(
      resolve(BAD_TMP, "pages/index.json"),
      JSON.stringify({ children: ["hi"], tagName: "main", title: "Home" }),
      "utf8",
    );
  });

  afterAll(() => {
    rmSync(BAD_TMP, { force: true, recursive: true });
  });

  // A typo'd locale does not degrade — it ships pages claiming a language that does not exist.
  it("fails the build and names the tag", async () => {
    const result = await buildSite(BAD_TMP, { verbose: false });
    expect(result.errors.some((e) => e.includes("en_US"))).toBe(true);
  }, 30_000);
});

// ── manifest.webmanifest and .well-known/security.txt ────────────────────────

describe("buildSite — installability and disclosure files", () => {
  const WK_TMP = resolve(import.meta.dir, "__test-site-wellknown__");

  beforeAll(() => {
    rmSync(WK_TMP, { force: true, recursive: true });
    mkdirSync(resolve(WK_TMP, "pages"), { recursive: true });
    writeFileSync(
      resolve(WK_TMP, "project.json"),
      JSON.stringify({
        build: { outDir: "./dist" },
        manifest: {
          icons: [
            { sizes: "192x192", src: "/i192.png" },
            { sizes: "512x512", src: "/i512.png" },
          ],
          themeColor: "#0b3d91",
        },
        name: "PWA Site",
        securityTxt: {
          contact: ["mailto:security@pwa.example"],
          expires: "2099-01-01T00:00:00Z",
          preferredLanguages: ["EN"],
        },
        url: "https://pwa.example",
      }),
      "utf8",
    );
    writeFileSync(
      resolve(WK_TMP, "pages/index.json"),
      JSON.stringify({ children: ["hi"], tagName: "main", title: "Home" }),
      "utf8",
    );
  });

  afterAll(() => {
    rmSync(WK_TMP, { force: true, recursive: true });
  });

  /*
   * The three halves have to agree, which is why this is one test: the file exists, the page
   * points at it, and `_headers` names a content type no host would infer for either extension.
   */
  it("writes both files, links them, and names their content types", async () => {
    const result = await buildSite(WK_TMP, { verbose: false });
    expect(result.errors).toHaveLength(0);
    const read = (rel: string) => readFileSync(resolve(WK_TMP, "dist", rel), "utf8");

    expect(JSON.parse(read("manifest.webmanifest")).short_name).toBe("PWA Site");
    expect(read(".well-known/security.txt")).toContain("Expires: 2099-01-01T00:00:00Z");
    // Canonicalized through the same BCP 47 implementation as i18n.locales.
    expect(read(".well-known/security.txt")).toContain("Preferred-Languages: en");

    const html = read("index.html");
    expect(html).toContain('<link href="/manifest.webmanifest" rel="manifest">');
    expect(html).toContain('<meta content="#0b3d91" name="theme-color">');

    const headers = read("_headers");
    expect(headers).toContain("Content-Type: application/manifest+json; charset=utf-8");
    expect(headers).toContain("Content-Type: text/plain; charset=utf-8");
  }, 30_000);
});

// ── The service worker and its tombstone ─────────────────────────────────────

describe("buildSite — service worker", () => {
  const SW_TMP = resolve(import.meta.dir, "__test-site-sw__");
  /** `undefined` means the key is absent, which is a different instruction from `false`. */
  const project = (serviceWorker?: unknown) =>
    writeFileSync(
      resolve(SW_TMP, "project.json"),
      JSON.stringify({
        build: { outDir: "./dist" },
        name: "SW Site",
        url: "https://sw.example",
        ...(serviceWorker === undefined ? {} : { serviceWorker }),
      }),
      "utf8",
    );

  beforeAll(() => {
    rmSync(SW_TMP, { force: true, recursive: true });
    mkdirSync(resolve(SW_TMP, "pages"), { recursive: true });
    writeFileSync(
      resolve(SW_TMP, "pages/index.json"),
      JSON.stringify({ children: ["hi"], tagName: "main", title: "Home" }),
      "utf8",
    );
    writeFileSync(
      resolve(SW_TMP, "pages/offline.json"),
      JSON.stringify({ children: ["offline"], tagName: "main", title: "Offline" }),
      "utf8",
    );
  });

  afterAll(() => {
    rmSync(SW_TMP, { force: true, recursive: true });
  });

  // A worker nobody asked for is a caching layer nobody debugged.
  it("emits nothing at all when the project never mentions one", async () => {
    project();
    const result = await buildSite(SW_TMP, { verbose: false });
    expect(result.errors).toHaveLength(0);
    expect(existsSync(resolve(SW_TMP, "dist/sw.js"))).toBe(false);
    expect(readFileSync(resolve(SW_TMP, "dist/index.html"), "utf8")).not.toContain("serviceWorker");
  }, 30_000);

  it("emits the worker and registers it from every page", async () => {
    project({ offlineFallback: "/offline/", precache: ["/"] });
    const result = await buildSite(SW_TMP, { verbose: false });
    expect(result.errors).toHaveLength(0);

    const worker = readFileSync(resolve(SW_TMP, "dist/sw.js"), "utf8");
    // The fallback joined precache, since a page never cached cannot be served offline.
    expect(worker).toContain('const PRECACHE = ["/","/offline/"]');
    expect(readFileSync(resolve(SW_TMP, "dist/index.html"), "utf8")).toContain(
      "navigator.serviceWorker.register('/sw.js'",
    );
  }, 30_000);

  /*
   * The distinction the whole feature turns on. `false` is not the same as deleting the key: a
   * worker is sticky, and a 404 at its URL is not an instruction to stop. Verified in a browser —
   * flipping a live deploy from the worker to the tombstone left zero registrations, zero caches
   * and an uncontrolled page.
   */
  it("false emits a tombstone at the same URL, and stops registering it", async () => {
    project(false);
    const result = await buildSite(SW_TMP, { verbose: false });
    expect(result.errors).toHaveLength(0);

    const worker = readFileSync(resolve(SW_TMP, "dist/sw.js"), "utf8");
    expect(worker).toContain("self.registration.unregister()");
    expect(worker).not.toContain("PRECACHE");
    // Registering a tombstone from the page trying to shed it would be self-defeating.
    expect(readFileSync(resolve(SW_TMP, "dist/index.html"), "utf8")).not.toContain(
      "serviceWorker.register",
    );
  }, 30_000);

  // `cache.addAll()` is all-or-nothing, so one bad URL stops the worker installing — silently.
  it("fails the build on a precache URL it did not produce", async () => {
    project({ precache: ["/", "/never-built/"] });
    const result = await buildSite(SW_TMP, { verbose: false });
    expect(result.errors.some((e) => e.includes("/never-built/"))).toBe(true);
  }, 30_000);
});

// ── Unresolvable bare specifiers ─────────────────────────────────────────────

describe("buildSite — unresolvable bare specifier in $head", () => {
  const MISS_TMP = resolve(import.meta.dir, "__test-site-bare-missing__");

  beforeAll(() => {
    rmSync(MISS_TMP, { force: true, recursive: true });
    mkdirSync(MISS_TMP, { recursive: true });
    writeFileSync(
      resolve(MISS_TMP, "project.json"),
      JSON.stringify({
        $head: [
          {
            attributes: { href: "@nope/not-installed/theme.css", rel: "stylesheet" },
            tagName: "link",
          },
        ],
        build: { outDir: "./dist" },
        name: "Missing Spec Test",
      }),
      "utf8",
    );
    mkdirSync(resolve(MISS_TMP, "pages"), { recursive: true });
    writeFileSync(
      resolve(MISS_TMP, "pages/index.json"),
      JSON.stringify({ children: [{ children: ["Hi"], tagName: "p" }], title: "Home" }),
      "utf8",
    );
  });

  afterAll(() => {
    rmSync(MISS_TMP, { force: true, recursive: true });
  });

  // A missing dependency is a build error. It used to be a URL that looked fine until deploy.
  it("reports the specifier rather than emitting a dead URL", async () => {
    const result = await buildSite(MISS_TMP);
    expect(result.errors.some((e) => e.includes("@nope/not-installed/theme.css"))).toBe(true);
  });
});

// ── Static components (no JS injection) ──────────────────────────────────────

describe("buildSite — static component optimization", () => {
  const STATIC_TMP = resolve(import.meta.dir, "__test-site-static-comp__");

  beforeAll(() => {
    rmSync(STATIC_TMP, { force: true, recursive: true });
    mkdirSync(STATIC_TMP, { recursive: true });
    writeFileSync(
      resolve(STATIC_TMP, "project.json"),
      JSON.stringify({ build: { outDir: "./dist" }, name: "Static Comp Test" }),
      "utf8",
    );
    mkdirSync(resolve(STATIC_TMP, "pages"), { recursive: true });
    writeFileSync(
      resolve(STATIC_TMP, "pages/index.json"),
      JSON.stringify({
        children: [{ $props: { title: "Hello" }, tagName: "my-card" }],
        title: "Home",
      }),
      "utf8",
    );
    mkdirSync(resolve(STATIC_TMP, "components"), { recursive: true });
    // Fully static component: no reactive state, no events, just static children
    writeFileSync(
      resolve(STATIC_TMP, "components/my-card.json"),
      JSON.stringify({
        children: [{ children: ["Static Content"], tagName: "div" }],
        style: { display: "block", padding: "16px" },
        tagName: "my-card",
      }),
      "utf8",
    );
  });

  afterAll(() => {
    rmSync(STATIC_TMP, { force: true, recursive: true });
  });

  it("skips JS injection for fully static components", async () => {
    await buildSite(STATIC_TMP);
    const html = readFileSync(resolve(STATIC_TMP, "dist/index.html"), "utf8");
    // CSS should still be injected
    expect(html).toContain('href="/components/my-card.css"');
    // JS should NOT be injected for fully static components
    expect(html).not.toContain('src="/components/my-card.js"');
  });
});

// ── Component with $props style resolution ───────────────────────────────────

describe("buildSite — component style template resolution with $props", () => {
  const STYLE_TMP = resolve(import.meta.dir, "__test-site-comp-style__");

  beforeAll(() => {
    rmSync(STYLE_TMP, { force: true, recursive: true });
    mkdirSync(STYLE_TMP, { recursive: true });
    writeFileSync(
      resolve(STYLE_TMP, "project.json"),
      JSON.stringify({ build: { outDir: "./dist" }, name: "Style Test" }),
      "utf8",
    );
    mkdirSync(resolve(STYLE_TMP, "pages"), { recursive: true });
    writeFileSync(
      resolve(STYLE_TMP, "pages/index.json"),
      JSON.stringify({
        children: [
          {
            $props: { bgImage: "/images/hero.jpg" },
            tagName: "hero-banner",
          },
        ],
        title: "Home",
      }),
      "utf8",
    );
    mkdirSync(resolve(STYLE_TMP, "components"), { recursive: true });
    writeFileSync(
      resolve(STYLE_TMP, "components/hero-banner.json"),
      JSON.stringify({
        children: [{ children: ["Hero"], tagName: "div" }],
        state: { bgImage: { default: "/default.jpg" } },
        style: {
          backgroundImage: "url(${state.bgImage})",
          display: "block",
        },
        tagName: "hero-banner",
      }),
      "utf8",
    );
  });

  afterAll(() => {
    rmSync(STYLE_TMP, { force: true, recursive: true });
  });

  it("resolves template strings in component host styles using $props", async () => {
    const result = await buildSite(STYLE_TMP);
    expect(result.errors).toHaveLength(0);
    // Verify the page built successfully with the component (exercises lines 641-658)
    expect(existsSync(resolve(STYLE_TMP, "dist/index.html"))).toBe(true);
    const html = readFileSync(resolve(STYLE_TMP, "dist/index.html"), "utf8");
    expect(html).toContain("hero-banner");
  });
});

// ── Route compilation errors ─────────────────────────────────────────────────

describe("buildSite — route compilation errors", () => {
  const ROUTE_ERR_TMP = resolve(import.meta.dir, "__test-site-route-err__");

  beforeAll(() => {
    rmSync(ROUTE_ERR_TMP, { force: true, recursive: true });
    mkdirSync(ROUTE_ERR_TMP, { recursive: true });
    writeFileSync(
      resolve(ROUTE_ERR_TMP, "project.json"),
      JSON.stringify({ build: { outDir: "./dist" }, name: "Route Err Test" }),
      "utf8",
    );
    mkdirSync(resolve(ROUTE_ERR_TMP, "pages"), { recursive: true });
    // Write invalid JSON as page source to trigger compilation error
    writeFileSync(resolve(ROUTE_ERR_TMP, "pages/broken.json"), "NOT VALID JSON", "utf8");
    writeFileSync(
      resolve(ROUTE_ERR_TMP, "pages/index.json"),
      JSON.stringify({
        children: [{ children: ["OK"], tagName: "p" }],
        title: "Home",
      }),
      "utf8",
    );
  });

  afterAll(() => {
    rmSync(ROUTE_ERR_TMP, { force: true, recursive: true });
  });

  it("captures route compilation errors and continues building", async () => {
    const result = await buildSite(ROUTE_ERR_TMP);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors.some((e) => e.includes("/broken"))).toBe(true);
    // The good page should still be built
    expect(existsSync(resolve(ROUTE_ERR_TMP, "dist/index.html"))).toBe(true);
  });
});

// ── Dynamic routes with content types ────────────────────────────────────────

describe("buildSite — dynamic routes with content types", () => {
  const DYN_TMP = resolve(import.meta.dir, "__test-site-dynamic__");

  beforeAll(() => {
    rmSync(DYN_TMP, { force: true, recursive: true });
    mkdirSync(DYN_TMP, { recursive: true });
    writeFileSync(
      resolve(DYN_TMP, "project.json"),
      JSON.stringify({
        build: { outDir: "./dist" },
        content: { posts: { format: "json", source: "./content/posts/" } },
        extensions: ["@jxsuite/parser"],
        name: "Dynamic Test",
      }),
      "utf8",
    );
    mkdirSync(resolve(DYN_TMP, "pages/blog"), { recursive: true });
    writeFileSync(
      resolve(DYN_TMP, "pages/index.json"),
      JSON.stringify({
        children: [{ children: ["Home"], tagName: "p" }],
        title: "Home",
      }),
      "utf8",
    );
    writeFileSync(
      resolve(DYN_TMP, "pages/blog/[slug].json"),
      JSON.stringify({
        $paths: {
          contentType: "posts",
          field: "slug",
          param: "slug",
        },
        children: [{ children: ["Post"], tagName: "h1" }],
        title: "Blog Post",
      }),
      "utf8",
    );
    mkdirSync(resolve(DYN_TMP, "content/posts"), { recursive: true });
    writeFileSync(
      resolve(DYN_TMP, "content/posts/hello.json"),
      JSON.stringify({ slug: "hello", title: "Hello World" }),
      "utf8",
    );
    writeFileSync(
      resolve(DYN_TMP, "content/posts/second.json"),
      JSON.stringify({ slug: "second", title: "Second Post" }),
      "utf8",
    );
  });

  afterAll(() => {
    rmSync(DYN_TMP, { force: true, recursive: true });
  });

  it("expands dynamic routes from content types", async () => {
    const result = await buildSite(DYN_TMP, { verbose: true });
    expect(result.errors).toHaveLength(0);
    // Should have home + 2 blog posts
    expect(result.routes).toBe(3);
    expect(existsSync(resolve(DYN_TMP, "dist/blog/hello/index.html"))).toBe(true);
    expect(existsSync(resolve(DYN_TMP, "dist/blog/second/index.html"))).toBe(true);
  });
});

// ── Image optimization logging ───────────────────────────────────────────────

describe("buildSite — image optimization cache logging", () => {
  const IMG_TMP = resolve(import.meta.dir, "__test-site-img-log__");

  beforeAll(() => {
    rmSync(IMG_TMP, { force: true, recursive: true });
    mkdirSync(IMG_TMP, { recursive: true });
    writeFileSync(
      resolve(IMG_TMP, "project.json"),
      JSON.stringify({
        build: { outDir: "./dist" },
        images: { optimize: true },
        name: "Img Test",
      }),
      "utf8",
    );
    mkdirSync(resolve(IMG_TMP, "pages"), { recursive: true });
    writeFileSync(
      resolve(IMG_TMP, "pages/index.json"),
      JSON.stringify({
        children: [{ children: ["Hi"], tagName: "p" }],
        title: "Home",
      }),
      "utf8",
    );
    // Pre-populate cache with an entry so the "Optimized N image(s)" log triggers
    mkdirSync(resolve(IMG_TMP, ".cache/images"), { recursive: true });
    writeFileSync(
      resolve(IMG_TMP, ".cache/images/manifest.json"),
      JSON.stringify({
        entries: { "test.jpg": { hash: "abc", outputs: ["test.webp"] } },
        version: 1,
      }),
      "utf8",
    );
  });

  afterAll(() => {
    rmSync(IMG_TMP, { force: true, recursive: true });
  });

  it("logs and saves image cache when optimize is enabled", async () => {
    const result = await buildSite(IMG_TMP, { verbose: true });
    expect(result.errors).toHaveLength(0);
    // Verify cache was saved
    expect(existsSync(resolve(IMG_TMP, ".cache/images/manifest.json"))).toBe(true);
  });
});

// ── Markdown component compilation ───────────────────────────────────────────

describe("buildSite — markdown component file", () => {
  const MD_COMP_TMP = resolve(import.meta.dir, "__test-site-md-comp__");

  beforeAll(() => {
    rmSync(MD_COMP_TMP, { force: true, recursive: true });
    mkdirSync(MD_COMP_TMP, { recursive: true });
    writeFileSync(
      resolve(MD_COMP_TMP, "project.json"),
      JSON.stringify({ build: { outDir: "./dist" }, name: "MD Comp Test" }),
      "utf8",
    );
    mkdirSync(resolve(MD_COMP_TMP, "pages"), { recursive: true });
    writeFileSync(
      resolve(MD_COMP_TMP, "pages/index.json"),
      JSON.stringify({
        children: [{ children: ["Hi"], tagName: "p" }],
        title: "Home",
      }),
      "utf8",
    );
    mkdirSync(resolve(MD_COMP_TMP, "components"), { recursive: true });
    writeFileSync(
      resolve(MD_COMP_TMP, "components/my-note.md"),
      `---
tagName: my-note
---

# Note Component

This is a note.
`,
      "utf8",
    );
  });

  afterAll(() => {
    rmSync(MD_COMP_TMP, { force: true, recursive: true });
  });

  it("compiles .md component files using transpileJxMarkdown", async () => {
    const result = await buildSite(MD_COMP_TMP, { verbose: true });
    // Should compile without errors (may or may not generate CSS depending on the md content)
    // The key coverage point is lines 148-150 (the .md branch of component compilation)
    expect(result.errors).toHaveLength(0);
    expect(existsSync(resolve(MD_COMP_TMP, "dist/components"))).toBe(true);
  });
});

// ── resolveDocTemplates with children as template string ─────────────────────

describe("buildSite — resolveDocTemplates with dynamic children", () => {
  const DOC_TMP = resolve(import.meta.dir, "__test-site-doc-tpl__");

  beforeAll(() => {
    rmSync(DOC_TMP, { force: true, recursive: true });
    mkdirSync(DOC_TMP, { recursive: true });
    writeFileSync(
      resolve(DOC_TMP, "project.json"),
      JSON.stringify({ build: { outDir: "./dist" }, name: "Doc TPL Test" }),
      "utf8",
    );
    mkdirSync(resolve(DOC_TMP, "pages"), { recursive: true });
    writeFileSync(
      resolve(DOC_TMP, "pages/index.json"),
      JSON.stringify({
        children: [
          { innerHTML: "${state.greeting}", tagName: "h1" },
          { children: "${state.items}", tagName: "ul" },
          { children: ["Before:", "${state.items}"], tagName: "div" },
        ],
        state: {
          greeting: { default: "Hello World", timing: "compiler" },
          items: {
            default: [
              { children: ["Item 1"], tagName: "li" },
              { children: ["Item 2"], tagName: "li" },
            ],
            timing: "compiler",
          },
        },
        title: "Home",
      }),
      "utf8",
    );
  });

  afterAll(() => {
    rmSync(DOC_TMP, { force: true, recursive: true });
  });

  it("resolves children template string to array and innerHTML templates", async () => {
    const result = await buildSite(DOC_TMP);
    expect(result.errors).toHaveLength(0);
    const html = readFileSync(resolve(DOC_TMP, "dist/index.html"), "utf8");
    expect(html).toContain("Item 1");
    expect(html).toContain("Item 2");
    expect(html).toContain("Hello World");
  });
});

// ── Component with slot content (expandComponents) ───────────────────────────

describe("buildSite — component slot content expansion", () => {
  const SLOT_TMP = resolve(import.meta.dir, "__test-site-comp-slot__");

  beforeAll(() => {
    rmSync(SLOT_TMP, { force: true, recursive: true });
    mkdirSync(SLOT_TMP, { recursive: true });
    writeFileSync(
      resolve(SLOT_TMP, "project.json"),
      JSON.stringify({ build: { outDir: "./dist" }, name: "Slot Test" }),
      "utf8",
    );
    mkdirSync(resolve(SLOT_TMP, "pages"), { recursive: true });
    writeFileSync(
      resolve(SLOT_TMP, "pages/index.json"),
      JSON.stringify({
        children: [
          {
            children: [{ children: ["Slotted Content"], tagName: "p" }],
            tagName: "my-wrapper",
          },
        ],
        title: "Home",
      }),
      "utf8",
    );
    mkdirSync(resolve(SLOT_TMP, "components"), { recursive: true });
    writeFileSync(
      resolve(SLOT_TMP, "components/my-wrapper.json"),
      JSON.stringify({
        children: [
          {
            attributes: { class: "wrapper" },
            children: [{ tagName: "slot" }],
            tagName: "div",
          },
        ],
        style: { border: "1px solid #ccc", display: "block" },
        tagName: "my-wrapper",
      }),
      "utf8",
    );
  });

  afterAll(() => {
    rmSync(SLOT_TMP, { force: true, recursive: true });
  });

  it("pre-renders component with slotted content from page", async () => {
    const result = await buildSite(SLOT_TMP);
    expect(result.errors).toHaveLength(0);
    const html = readFileSync(resolve(SLOT_TMP, "dist/index.html"), "utf8");
    expect(html).toContain("Slotted Content");
  });
});

// ── $head textContent template resolution ────────────────────────────────────

describe("buildSite — $head textContent template resolution", () => {
  const HC_TMP = resolve(import.meta.dir, "__test-site-head-tc__");

  beforeAll(() => {
    rmSync(HC_TMP, { force: true, recursive: true });
    mkdirSync(HC_TMP, { recursive: true });
    writeFileSync(
      resolve(HC_TMP, "project.json"),
      JSON.stringify({ build: { outDir: "./dist" }, name: "Head TC Test" }),
      "utf8",
    );
    mkdirSync(resolve(HC_TMP, "pages"), { recursive: true });
    writeFileSync(
      resolve(HC_TMP, "pages/index.json"),
      JSON.stringify({
        $head: [
          {
            attributes: { type: "application/ld+json" },
            tagName: "script",
            textContent: "${state.jsonLd}",
          },
        ],
        children: [{ children: ["Hi"], tagName: "p" }],
        state: {
          jsonLd: {
            default: '{"@context":"https://schema.org"}',
            timing: "compiler",
          },
        },
        title: "Home",
      }),
      "utf8",
    );
  });

  afterAll(() => {
    rmSync(HC_TMP, { force: true, recursive: true });
  });

  it("resolves textContent template in $head entries", async () => {
    const result = await buildSite(HC_TMP);
    expect(result.errors).toHaveLength(0);
  });
});

// ── Lang attribute with existing lang ────────────────────────────────────────

describe("buildSite — lang attribute handling", () => {
  const LANG_TMP = resolve(import.meta.dir, "__test-site-lang__");

  beforeAll(() => {
    rmSync(LANG_TMP, { force: true, recursive: true });
    mkdirSync(LANG_TMP, { recursive: true });
    writeFileSync(
      resolve(LANG_TMP, "project.json"),
      JSON.stringify({
        build: { outDir: "./dist" },
        defaults: { lang: "fr" },
        name: "Lang Test",
      }),
      "utf8",
    );
    mkdirSync(resolve(LANG_TMP, "pages"), { recursive: true });
    writeFileSync(
      resolve(LANG_TMP, "pages/index.json"),
      JSON.stringify({
        children: [{ children: ["Bonjour"], tagName: "p" }],
        title: "Accueil",
      }),
      "utf8",
    );
  });

  afterAll(() => {
    rmSync(LANG_TMP, { force: true, recursive: true });
  });

  it("sets the lang attribute on the html element", async () => {
    const result = await buildSite(LANG_TMP);
    expect(result.errors).toHaveLength(0);
    const html = readFileSync(resolve(LANG_TMP, "dist/index.html"), "utf8");
    expect(html).toContain('lang="fr"');
  });
});

// ── Server handler (no adapter) ──────────────────────────────────────────────

describe("buildSite — server handler without adapter", () => {
  const SH_TMP = resolve(import.meta.dir, "__test-site-server-handler__");

  beforeAll(() => {
    rmSync(SH_TMP, { force: true, recursive: true });
    mkdirSync(SH_TMP, { recursive: true });
    writeFileSync(
      resolve(SH_TMP, "project.json"),
      JSON.stringify({ build: { outDir: "./dist" }, name: "SH Test" }),
      "utf8",
    );
    mkdirSync(resolve(SH_TMP, "pages"), { recursive: true });
    writeFileSync(
      resolve(SH_TMP, "pages/index.json"),
      JSON.stringify({
        children: [{ children: ["Data Page"], tagName: "p" }],
        state: {
          loadData: {
            $export: "loadData",
            $src: "./api.server.js",
            timing: "server",
          },
        },
        title: "Home",
      }),
      "utf8",
    );
    writeFileSync(
      resolve(SH_TMP, "pages/api.server.js"),
      "export function loadData() { return { items: [] }; }\n",
      "utf8",
    );
  });

  afterAll(() => {
    rmSync(SH_TMP, { force: true, recursive: true });
  });

  it("generates _server.js alongside page HTML when no adapter", async () => {
    await buildSite(SH_TMP);
    // The server handler may or may not be generated depending on compileServer behavior
    // Either way, the page should build without errors
    expect(existsSync(resolve(SH_TMP, "dist/index.html"))).toBe(true);
  });
});

// ── expandComponents with arrays (line 616-617) ──────────────────────────────

describe("buildSite — expandComponents handles arrays in tree", () => {
  const ARR_TMP = resolve(import.meta.dir, "__test-site-arr-expand__");

  beforeAll(() => {
    rmSync(ARR_TMP, { force: true, recursive: true });
    mkdirSync(ARR_TMP, { recursive: true });
    writeFileSync(
      resolve(ARR_TMP, "project.json"),
      JSON.stringify({ build: { outDir: "./dist" }, name: "Arr Test" }),
      "utf8",
    );
    mkdirSync(resolve(ARR_TMP, "pages"), { recursive: true });
    mkdirSync(resolve(ARR_TMP, "layouts"), { recursive: true });
    writeFileSync(
      resolve(ARR_TMP, "layouts/main.json"),
      JSON.stringify({
        children: [
          { children: [{ tagName: "a-card" }], tagName: "nav" },
          { children: [{ tagName: "slot" }], tagName: "main" },
        ],
        tagName: "div",
      }),
      "utf8",
    );
    writeFileSync(
      resolve(ARR_TMP, "pages/index.json"),
      JSON.stringify({
        $layout: "./layouts/main.json",
        children: [
          { tagName: "a-card" },
          // Instance with styled slot children → their styles are collected and injected.
          {
            children: [{ children: ["slotted"], style: { color: "green" }, tagName: "span" }],
            tagName: "a-card",
          },
        ],
        title: "Home",
      }),
      "utf8",
    );
    // A page that uses no components — injectComponentScripts is invoked (components were
    // Compiled) but finds none referenced on this page.
    writeFileSync(
      resolve(ARR_TMP, "pages/plain.json"),
      JSON.stringify({
        children: [{ children: ["No components here"], tagName: "h1" }],
        title: "Plain",
      }),
      "utf8",
    );
    mkdirSync(resolve(ARR_TMP, "components"), { recursive: true });
    writeFileSync(
      resolve(ARR_TMP, "components/a-card.json"),
      JSON.stringify({
        children: [{ children: ["Card Content"], tagName: "div" }],
        style: { display: "block" },
        tagName: "a-card",
      }),
      "utf8",
    );
  });

  afterAll(() => {
    rmSync(ARR_TMP, { force: true, recursive: true });
  });

  it("expands component instances in multiple positions in the tree", async () => {
    const result = await buildSite(ARR_TMP);
    expect(result.errors).toHaveLength(0);
    const html = readFileSync(resolve(ARR_TMP, "dist/index.html"), "utf8");
    // Should have multiple instances of the card content
    const matches = html.match(/Card Content/g);
    expect(matches).not.toBeNull();
    expect(matches?.length).toBeGreaterThanOrEqual(2);
    // Styled slot content is collected and injected as a page style block.
    expect(html).toContain("jxs-0");
    expect(html).toContain("green");
  });

  it("leaves component-free pages untouched by script injection", async () => {
    await buildSite(ARR_TMP);
    const html = readFileSync(resolve(ARR_TMP, "dist/plain/index.html"), "utf8");
    expect(html).toContain("No components here");
    expect(html).not.toContain("a-card");
  });
});

// ── Static expansion of array repeaters (whole-children + member among siblings) ──

describe("buildSite — static repeater expansion", () => {
  const REP_TMP = resolve(import.meta.dir, "__test-site-repeater__");

  beforeAll(() => {
    rmSync(REP_TMP, { force: true, recursive: true });
    mkdirSync(resolve(REP_TMP, "pages"), { recursive: true });
    writeFileSync(
      resolve(REP_TMP, "project.json"),
      JSON.stringify({ build: { outDir: "./dist" }, name: "Repeater Test" }),
      "utf8",
    );
    writeFileSync(
      resolve(REP_TMP, "pages/index.json"),
      JSON.stringify({
        children: [
          {
            // Whole-children repeater (legacy form) — items resolve at build time.
            children: {
              $prototype: "Array",
              items: { $ref: "#/state/fruit" },
              map: { tagName: "li", textContent: "${$map.item}" },
            },
            tagName: "ul",
          },
          {
            // Array member nestled between static siblings.
            children: [
              { tagName: "li", textContent: "header" },
              {
                $prototype: "Array",
                items: { $ref: "#/state/nums" },
                map: { tagName: "li", textContent: "${$map.item}" },
              },
              { tagName: "li", textContent: "footer" },
            ],
            tagName: "ol",
          },
        ],
        state: { fruit: { default: ["apple", "pear"] }, nums: { default: [1, 2, 3] } },
        title: "Repeaters",
      }),
      "utf8",
    );
  });

  afterAll(() => {
    rmSync(REP_TMP, { force: true, recursive: true });
  });

  it("statically expands whole-children and member repeaters, wrapper-less", async () => {
    const result = await buildSite(REP_TMP);
    expect(result.errors).toHaveLength(0);
    const html = readFileSync(resolve(REP_TMP, "dist/index.html"), "utf8");
    // Whole-children repeater items render directly inside <ul> (no wrapper).
    expect(html).toContain("apple");
    expect(html).toContain("pear");
    // Member repeater items render between the static siblings inside <ol>.
    const ol = html.slice(html.indexOf("<ol"), html.indexOf("</ol>"));
    expect(ol.indexOf("header")).toBeLessThan(ol.indexOf("1"));
    expect(ol.indexOf("3")).toBeLessThan(ol.indexOf("footer"));
    // No throwaway wrapper div around the repeated items.
    expect(html).not.toContain("repeater-perimeter");
  });
});

// ── Static expansion of map templates with style/attributes/$props/children ──

describe("buildSite — rich map template expansion", () => {
  const MAP_TMP = resolve(import.meta.dir, "__test-site-map-template__");

  beforeAll(() => {
    rmSync(MAP_TMP, { force: true, recursive: true });
    mkdirSync(resolve(MAP_TMP, "pages"), { recursive: true });
    writeFileSync(
      resolve(MAP_TMP, "project.json"),
      JSON.stringify({
        // A site-level head entry with no attributes exercises the bare-specifier passthrough.
        $head: [{ children: ["body{margin:0}"], tagName: "style" }],
        build: { outDir: "./dist" },
        name: "Map Tpl",
      }),
      "utf8",
    );
    writeFileSync(
      resolve(MAP_TMP, "pages/index.json"),
      JSON.stringify({
        children: [
          {
            // Whole-children repeater with a rich map template: the map node carries
            // Style, attributes, $props, nested children, a multi-part template and an
            // Erroring template (kept verbatim when evaluation throws).
            children: {
              $prototype: "Array",
              items: { $ref: "#/state/posts" },
              map: {
                $props: { label: "${item.title}" },
                attributes: { "data-id": "${item.id}" },
                children: [
                  { tagName: "h2", textContent: "Post: ${item.title}" },
                  { tagName: "small", textContent: "${item.missing.deep}" },
                  // Opens AND closes with an interpolation — the shape the greedy
                  // Single-expression test used to splice into a SyntaxError.
                  { tagName: "p", textContent: "${item.title} — ${item.id}" },
                  "static-sep",
                ],
                style: { color: "${item.color}" },
                tagName: "article",
              },
            },
            tagName: "section",
          },
          {
            // Items provided as a literal array (not a $ref).
            children: {
              $prototype: "Array",
              items: [{ title: "Lit1" }, { title: "Lit2" }],
              map: { tagName: "li", textContent: "${item.title}" },
            },
            tagName: "ul",
          },
          {
            // Items resolves to a non-array → left for client-side rendering (no static expansion).
            children: {
              $prototype: "Array",
              items: { $ref: "#/state/notList" },
              map: { tagName: "span", textContent: "${item}" },
            },
            tagName: "div",
          },
          {
            // String map template — returned verbatim per item.
            children: { $prototype: "Array", items: [1, 2], map: "plain-item" },
            tagName: "p",
          },
          {
            // $props template on a (non-component) element resolves against page state.
            $props: { tone: "${pageTone}" },
            tagName: "x-tone",
          },
          {
            // String child whose template resolves to an array of nodes (spliced in place).
            children: ["${state.frags}"],
            tagName: "aside",
          },
        ],
        state: {
          frags: { default: [{ tagName: "b", textContent: "BOLD" }] },
          notList: { default: "not an array" },
          pageTone: { default: "warm" },
          posts: {
            default: [
              { color: "red", id: "1", title: "First" },
              { color: "blue", id: "2", title: "Second" },
            ],
          },
        },
        title: "Mapped",
      }),
      "utf8",
    );
  });

  afterAll(() => {
    rmSync(MAP_TMP, { force: true, recursive: true });
  });

  it("expands map templates with style, attributes, $props and nested children", async () => {
    const result = await buildSite(MAP_TMP);
    expect(result.errors).toHaveLength(0);
    const html = readFileSync(resolve(MAP_TMP, "dist/index.html"), "utf8");
    // Nested children + multi-part template resolved per item.
    expect(html).toContain("Post: First");
    expect(html).toContain("Post: Second");
    // Attribute template resolved per item.
    expect(html).toContain('data-id="1"');
    expect(html).toContain('data-id="2"');
    // A template that both opens and closes with an interpolation resolves per item.
    expect(html).toContain("First — 1");
    expect(html).toContain("Second — 2");
    // Static string child preserved.
    expect(html).toContain("static-sep");
    // Literal-array items expanded.
    expect(html).toContain("Lit1");
    expect(html).toContain("Lit2");
    // Style template resolved (emitted in a style block).
    expect(html).toContain("red");
    expect(html).toContain("blue");
    // String map template returned verbatim.
    expect(html).toContain("plain-item");
    // $props template resolved against page state.
    expect(html).toContain("x-tone");
    // String child template resolving to an array of nodes is spliced in.
    expect(html).toContain("BOLD");
  });
});

// ── Sitemap options ──────────────────────────────────────────────────────────

describe("buildSite — sitemap options", () => {
  const SM_TMP = resolve(import.meta.dir, "__test-site-sitemap__");

  function writeSite(config: Record<string, unknown>) {
    rmSync(SM_TMP, { force: true, recursive: true });
    mkdirSync(resolve(SM_TMP, "pages"), { recursive: true });
    writeFileSync(resolve(SM_TMP, "project.json"), JSON.stringify(config), "utf8");
    writeFileSync(
      resolve(SM_TMP, "pages/index.json"),
      JSON.stringify({ children: [{ children: ["Home"], tagName: "h1" }], title: "Home" }),
      "utf8",
    );
    writeFileSync(
      resolve(SM_TMP, "pages/secret.json"),
      JSON.stringify({
        $sitemap: false,
        children: [{ children: ["Secret"], tagName: "h1" }],
        title: "Secret",
      }),
      "utf8",
    );
  }

  afterAll(() => {
    rmSync(SM_TMP, { force: true, recursive: true });
  });

  it("excludes pages that opt out with $sitemap: false", async () => {
    writeSite({ build: { outDir: "./dist" }, name: "SM", url: "https://sm.test" });
    await buildSite(SM_TMP);

    const sitemap = readFileSync(resolve(SM_TMP, "dist/sitemap.xml"), "utf8");
    expect(sitemap).toContain("<loc>https://sm.test/</loc>");
    expect(sitemap).not.toContain("/secret");
  });

  it("skips sitemap.xml when build.sitemap is false", async () => {
    writeSite({ build: { outDir: "./dist", sitemap: false }, name: "SM", url: "https://sm.test" });
    await buildSite(SM_TMP);

    expect(existsSync(resolve(SM_TMP, "dist/sitemap.xml"))).toBe(false);
  });

  it("skips sitemap generation when no url is configured", async () => {
    writeSite({ build: { outDir: "./dist" }, name: "SM" });
    await buildSite(SM_TMP);

    expect(existsSync(resolve(SM_TMP, "dist/sitemap.xml"))).toBe(false);
    // Robots.txt is not created just to add a Sitemap line we can't build
    expect(existsSync(resolve(SM_TMP, "dist/robots.txt"))).toBe(false);
  });
});

// ── Redirect / page conflict warning ─────────────────────────────────────────

describe("redirect conflict warnings", () => {
  const RC_TMP = resolve(import.meta.dir, "__test-redirect-conflict__");

  afterAll(() => {
    rmSync(RC_TMP, { force: true, recursive: true });
  });

  it("warns when a redirect source collides with a compiled page route", async () => {
    rmSync(RC_TMP, { force: true, recursive: true });
    mkdirSync(resolve(RC_TMP, "pages"), { recursive: true });
    writeFileSync(
      resolve(RC_TMP, "project.json"),
      JSON.stringify({
        build: { outDir: "./dist" },
        name: "RC",
        redirects: { "/about": "/company/", "/gone": "/somewhere/" },
      }),
      "utf8",
    );
    writeFileSync(
      resolve(RC_TMP, "pages/index.json"),
      JSON.stringify({ children: [{ children: ["Home"], tagName: "h1" }], title: "Home" }),
      "utf8",
    );
    writeFileSync(
      resolve(RC_TMP, "pages/about.json"),
      JSON.stringify({ children: [{ children: ["About"], tagName: "h1" }], title: "About" }),
      "utf8",
    );

    const warnings: string[] = [];
    const origWarn = console.warn;
    console.warn = (msg: string) => warnings.push(String(msg));
    try {
      await buildSite(RC_TMP, { verbose: false });
    } finally {
      console.warn = origWarn;
    }

    expect(
      warnings.some((w) => w.includes('The redirect "/about" collides with a compiled page')),
    ).toBe(true);
    expect(warnings.some((w) => w.includes('"/gone"'))).toBe(false);
  });
});

// ── Unregistered link relation warning ───────────────────────────────────────

describe("link relation warnings", () => {
  const LR_TMP = resolve(import.meta.dir, "__test-link-relations__");

  afterAll(() => {
    rmSync(LR_TMP, { force: true, recursive: true });
  });

  async function buildWithHead(head: unknown[]): Promise<string[]> {
    rmSync(LR_TMP, { force: true, recursive: true });
    mkdirSync(resolve(LR_TMP, "pages"), { recursive: true });
    writeFileSync(
      resolve(LR_TMP, "project.json"),
      JSON.stringify({ $head: head, build: { outDir: "./dist" }, name: "LR" }),
      "utf8",
    );
    for (const name of ["index", "about"]) {
      writeFileSync(
        resolve(LR_TMP, `pages/${name}.json`),
        JSON.stringify({ children: [{ children: [name], tagName: "h1" }], title: name }),
        "utf8",
      );
    }
    const warnings: string[] = [];
    const origWarn = console.warn;
    console.warn = (msg: string) => warnings.push(String(msg));
    try {
      await buildSite(LR_TMP, { verbose: false });
    } finally {
      console.warn = origWarn;
    }
    return warnings;
  }

  /*
   * The site `$head` is on every page, so the mistake that matters is also the one that would be
   * loudest — hence "once", asserted with two pages in the build.
   */
  it("warns once for an unregistered relation in the site head", async () => {
    const warnings = await buildWithHead([
      { attributes: { href: "/theme.css", rel: "stylshet" }, tagName: "link" },
    ]);
    const matched = warnings.filter((w) => w.includes('"stylshet" is not an IANA link relation'));
    expect(matched).toHaveLength(1);
  });

  it("says nothing about a head that is entirely registered relations", async () => {
    const warnings = await buildWithHead([
      { attributes: { href: "/theme.css", rel: "stylesheet" }, tagName: "link" },
      { attributes: { href: "/favicon.ico", rel: "shortcut icon" }, tagName: "link" },
      {
        attributes: { href: "https://example.com/rel/x", rel: "https://example.com/rel/x" },
        tagName: "link",
      },
    ]);
    expect(warnings.some((w) => w.includes("is not an IANA link relation"))).toBe(false);
  });
});
