/**
 * Base-path.test.ts — a site deployed under a subpath, from the string math up to `dist/`.
 *
 * The defect (issue 235): every URL a build emitted was an absolute-path reference, so a site at
 * `example.pages.dev/m/probe/` resolved all of them against `example.pages.dev/` and the page
 * rendered blank — the runtime assets 404 before anything can draw.
 *
 * The end-to-end block below is the issue's own repro, asserted rather than described: one project
 * whose `url` carries a path, built, with every output the deployment actually reads checked for
 * URLs a host serving from that path can resolve. It is deliberately paired with a second build of
 * the SAME fixture at an origin root, because the failure that would matter most now is the
 * opposite one — a prefix appearing where no base was ever declared.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { rewriteHtmlBase } from "../src/site/base-path";
import { buildSite } from "../src/site/site-build";

// ─── The HTML pass ───────────────────────────────────────────────────────────

const BASE = "/m/probe";

describe("rewriteHtmlBase", () => {
  test("an empty base returns the identical string, not a copy", () => {
    // The deployment Jx documents is a site at its own origin root, so this is the common path:
    // No allocation, no regex, and no chance of a rewrite where none was asked for.
    const html = '<a href="/about">x</a>';
    expect(rewriteHtmlBase(html, "")).toBe(html);
  });

  test("re-roots the import map and its modulepreload hints", () => {
    // The two that motivated the report: the page renders blank when these 404, rather than
    // Merely looking wrong.
    const html =
      '<script type="importmap">{"imports":{"@vue/reactivity":"/assets/vue-reactivity.js"}}</script>' +
      '<link rel="modulepreload" href="/assets/vue-reactivity.js">';
    expect(rewriteHtmlBase(html, BASE)).toBe(
      '<script type="importmap">{"imports":{"@vue/reactivity":"/m/probe/assets/vue-reactivity.js"}}</script>' +
        '<link rel="modulepreload" href="/m/probe/assets/vue-reactivity.js">',
    );
  });

  test("re-roots an import map KEY, which addresses a module by URL", () => {
    const html =
      '<script type="importmap">{"imports":{"/assets/lit-html/":"/assets/lit-html/"}}</script>';
    expect(rewriteHtmlBase(html, BASE)).toContain(
      '{"imports":{"/m/probe/assets/lit-html/":"/m/probe/assets/lit-html/"}}',
    );
  });

  test("re-roots component scripts, images, srcset and the rest of the URL attributes", () => {
    const html =
      '<script type="module" src="/components/site-counter.js"></script>' +
      '<img src="/images/hero.jpg" srcset="/images/hero-400.jpg 400w, /images/hero-800.jpg 800w">' +
      '<form action="/search"><button formaction="/go"></button></form>' +
      '<video poster="/p.jpg"></video><object data="/o.pdf"></object>';
    const out = rewriteHtmlBase(html, BASE);
    expect(out).toContain('src="/m/probe/components/site-counter.js"');
    expect(out).toContain('src="/m/probe/images/hero.jpg"');
    expect(out).toContain(
      'srcset="/m/probe/images/hero-400.jpg 400w, /m/probe/images/hero-800.jpg 800w"',
    );
    expect(out).toContain('action="/m/probe/search"');
    expect(out).toContain('formaction="/m/probe/go"');
    expect(out).toContain('poster="/m/probe/p.jpg"');
    expect(out).toContain('data="/m/probe/o.pdf"');
  });

  test("leaves every reference that does not mean 'from the site root'", () => {
    /* Only an absolute-path reference moves when the site root moves (RFC 3986 §5). An absolute
       URL, a protocol-relative one, a fragment, a query and a relative path each resolve against
       something else, and rewriting any of them would break a page that was working. */
    const html =
      '<a href="https://ext.example/x">a</a><a href="//cdn.example/x">b</a>' +
      '<a href="#top">c</a><a href="?q=1">d</a><a href="./rel">e</a><a href="../up">f</a>' +
      '<img src="data:image/png;base64,AA">';
    expect(rewriteHtmlBase(html, BASE)).toBe(html);
  });

  test("is idempotent, so an emitter that already prefixed does not compound", () => {
    const html = '<a href="/m/probe/about">x</a><a href="/m/probe">home</a>';
    expect(rewriteHtmlBase(html, BASE)).toBe(html);
    expect(rewriteHtmlBase(rewriteHtmlBase('<a href="/about">x</a>', BASE), BASE)).toBe(
      '<a href="/m/probe/about">x</a>',
    );
  });

  test("re-roots url() in a <style> block and in a style attribute, escaped or not", () => {
    const html =
      "<style>.a{background:url(/images/bg.png)}</style>" +
      '<div style="background:url(&quot;/images/b.png&quot;)"></div>' +
      "<p style=\"background:url('/images/c.png')\"></p>";
    const out = rewriteHtmlBase(html, BASE);
    expect(out).toContain("url(/m/probe/images/bg.png)");
    expect(out).toContain("url(&quot;/m/probe/images/b.png&quot;)");
    expect(out).toContain("url('/m/probe/images/c.png')");
  });

  test("re-roots a URL-bearing meta content and leaves prose alone", () => {
    /* `content` is the one attribute here that usually holds prose, so it moves only when the same
       tag says the value is a URL. A description that happens to start with a slash must not. */
    const html =
      '<meta property="og:image" content="/hero.jpg">' +
      '<meta name="twitter:image" content="/card.png">' +
      '<meta name="description" content="/usr/bin is where it lives">';
    const out = rewriteHtmlBase(html, BASE);
    expect(out).toContain('<meta property="og:image" content="/m/probe/hero.jpg">');
    expect(out).toContain('<meta name="twitter:image" content="/m/probe/card.png">');
    expect(out).toContain('content="/usr/bin is where it lives"');
  });

  test("a > inside an attribute value does not end the tag early", () => {
    // Consuming quoted values whole is what keeps the attributes after one from becoming text this
    // Pass never looks at — which would silently skip the href below.
    const html = '<a title="a > b" href="/about">x</a>';
    expect(rewriteHtmlBase(html, BASE)).toBe('<a title="a > b" href="/m/probe/about">x</a>');
  });

  test("single-quoted and unquoted-adjacent attributes keep their quoting", () => {
    expect(rewriteHtmlBase("<a href='/about'>x</a>", BASE)).toBe("<a href='/m/probe/about'>x</a>");
  });
});

// ─── The whole build ─────────────────────────────────────────────────────────

const TMP = resolve(import.meta.dir, "__test-base-path__");

function writeJSON(path: string, obj: unknown) {
  mkdirSync(resolve(TMP, ...path.split("/").slice(0, -1)), { recursive: true });
  writeFileSync(resolve(TMP, path), JSON.stringify(obj, null, 2), "utf8");
}

const read = (path: string) => readFileSync(resolve(TMP, path), "utf8");

/** Rewrite `project.json`'s `url` and rebuild, so one fixture answers both deployments. */
async function buildAt(url: string) {
  writeJSON("project.json", {
    build: { outDir: "./dist" },
    defaults: { layout: "./layouts/base.json" },
    // Off because sharp cannot load on every platform the suite runs on, and the base pass runs
    // Over the finished HTML either way — an optimized `srcset` reaches it as an attribute.
    images: { optimize: false },
    manifest: { enabled: true, icons: [{ sizes: "192x192", src: "/icon-192.png" }], scope: "/" },
    name: "Probe",
    redirects: { "/old": "/new" },
    serviceWorker: { precache: ["/"] },
    url,
  });
  return buildSite(TMP, { verbose: false });
}

beforeAll(() => {
  rmSync(TMP, { force: true, recursive: true });
  writeJSON("layouts/base.json", {
    children: [{ children: [{ tagName: "slot" }], tagName: "main" }],
    tagName: "div",
  });
  writeJSON("pages/index.json", {
    children: [
      { children: ["Home"], tagName: "h1" },
      { attributes: { href: "/about" }, children: ["About"], tagName: "a" },
      { attributes: { src: "/hero.jpg" }, tagName: "img" },
    ],
    title: "Home",
  });
  writeJSON("pages/about.json", { children: [{ children: ["About"], tagName: "h1" }] });
  mkdirSync(resolve(TMP, "public"), { recursive: true });
  writeFileSync(resolve(TMP, "public/hero.jpg"), "jpg", "utf8");
  writeFileSync(resolve(TMP, "public/icon-192.png"), "png", "utf8");
});

afterAll(() => {
  rmSync(TMP, { force: true, recursive: true });
});

describe("a site whose url carries a path", () => {
  test("every output a host reads names a URL under that path", async () => {
    const result = await buildAt("https://example.pages.dev/m/probe/");
    expect(result.errors).toEqual([]);

    /* The page. `/about` and `/hero.jpg` are AUTHOR-written, and they break exactly the way the
       runtime assets do — the issue's fix has to reach every absolute URL the build emits, not
       only the two that motivated the report. */
    const html = read("dist/index.html");
    expect(html).toContain('href="/m/probe/about"');
    expect(html).toContain('src="/m/probe/hero.jpg"');
    expect(html).not.toMatch(/(?:href|src)="\/(?!m\/probe)/);

    // The canonical link keeps the base: §5.2 resolution against `/about` would have dropped it.
    expect(html).toContain('href="https://example.pages.dev/m/probe/"');

    // `<loc>` is built like the canonical URL, so the two always agree.
    expect(read("dist/sitemap.xml")).toContain(
      "<loc>https://example.pages.dev/m/probe/about</loc>",
    );
    expect(read("dist/robots.txt")).toContain(
      "Sitemap: https://example.pages.dev/m/probe/sitemap.xml",
    );

    /* A `_headers` pattern is matched against the REQUEST path, and a request arrives under the
       base — so a rule left at the bare path matches nothing, silently. */
    const headers = read("dist/_headers");
    expect(headers).toContain("/m/probe/*");
    expect(headers).not.toMatch(/^\/\*$/m);

    // Both halves of a redirect are site URLs: the source is matched against the request path and
    // The destination is where the visitor is sent.
    expect(read("dist/_redirects")).toContain("/m/probe/old /m/probe/new 301");

    // The worker runs in the browser; every URL in it is a request path.
    const sw = read("dist/sw.js");
    expect(sw).toContain('const PRECACHE = ["/m/probe/"]');
    expect(sw).toContain('const CACHE_FIRST = "/m/probe/images/_optimized/"');
    /* A scope a worker's own URL is not inside fails to register outright — the one failure in this
       list that is loud. The default scope `/` re-roots to `/m/probe/`, keeping its trailing slash,
       which is the form a scope takes. */
    expect(html).toContain(
      "navigator.serviceWorker.register('/m/probe/sw.js',{scope:\"/m/probe/\"}",
    );

    const manifest = JSON.parse(read("dist/manifest.webmanifest")) as Record<string, unknown>;
    expect(manifest.start_url).toBe("/m/probe/");
    expect(manifest.scope).toBe("/m/probe/");
    expect(manifest.icons).toEqual([{ sizes: "192x192", src: "/m/probe/icon-192.png" }]);
  }, 120_000);

  test("the same fixture at an origin root emits no prefix anywhere", async () => {
    /* The regression that would matter most now is the opposite one. A site at its own origin root
       is what Jx documents, and a stray prefix there breaks every working deployment. */
    const result = await buildAt("https://example.com");
    expect(result.errors).toEqual([]);

    const html = read("dist/index.html");
    expect(html).toContain('href="/about"');
    expect(html).toContain('src="/hero.jpg"');
    expect(html).not.toContain("/m/probe");
    expect(read("dist/_redirects")).toContain("/old /new 301");
    expect(read("dist/_headers")).toMatch(/^\/\*$/m);
    expect(read("dist/sw.js")).toContain('const PRECACHE = ["/"]');
    expect(read("dist/sitemap.xml")).toContain("<loc>https://example.com/about</loc>");
  }, 120_000);
});
