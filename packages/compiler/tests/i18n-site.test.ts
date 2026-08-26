/**
 * A multilingual site end to end: the switcher a reader clicks, the annotation a crawler reads, and
 * the language a number is formatted in — from one build of one project.
 *
 * Each half is unit-tested where it lives. This asserts the halves agree, which is the failure the
 * units cannot see: `<head>` advertising a translation set the page's own switcher does not offer
 * is a site that tells a crawler one thing and a reader another, and both look correct alone.
 *
 * The hreflang assertions are deliberately graph-shaped rather than per-page. Reciprocity — every
 * member of a set linking every member, itself included — is what validators check and what a human
 * reviewer never catches, because reading one page in isolation can never reveal it.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSite } from "../src/site/site-build.ts";

const SITE = "https://multi.example";
let root = "";

function write(path: string, contents: string) {
  const full = join(root, path);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, contents, "utf8");
}

function html(route: string): string {
  return readFileSync(join(root, "dist", route, "index.html"), "utf8");
}

/**
 * One page: a language switcher mapped straight from `$page.alternates`, and a number formatted
 * with no locale named — the two things a template can only get from the route.
 */
function page(title: string, translationKey?: string): string {
  return JSON.stringify({
    ...(translationKey === undefined ? {} : { $translationKey: translationKey }),
    children: [
      {
        children: {
          $prototype: "Array",
          items: { $ref: "#/state/$page/alternates" },
          map: {
            attributes: {
              "data-current": "${item.current}",
              href: "${item.url}",
              hreflang: "${item.code}",
            },
            dir: "${item.dir}",
            tagName: "a",
            textContent: "${item.label}",
          },
        },
        tagName: "nav",
      },
      { tagName: "p", textContent: "${state.priced}" },
    ],
    state: {
      price: 1234.5,
      priced: {
        $expression: {
          operator: "call",
          target: { $ref: "window#/Intl/formatNumber" },
          value: [{ $ref: "#/state/price" }],
        },
      },
    },
    tagName: "main",
    title,
  });
}

/**
 * The switcher links a page rendered, as `hreflang → {url, dir, current}`.
 *
 * `current` is read by PRESENCE, not by text: `item.current` is a boolean, and the emitter spells a
 * boolean as the attribute's presence — bare when true, absent when false (compiler spec §8). So
 * the marker this asserts is `<a data-current>` against `<a>`, never `data-current="false"`.
 */
function switcher(source: string): Record<string, { current: boolean; dir: string; url: string }> {
  const out: Record<string, { current: boolean; dir: string; url: string }> = {};
  for (const tag of source.match(/<a\b[^>]*>/g) ?? []) {
    const attr = (name: string) => new RegExp(`${name}="([^"]*)"`).exec(tag)?.[1] ?? "";
    if (attr("hreflang") !== "") {
      out[attr("hreflang")] = {
        current: /\bdata-current\b/.test(tag),
        dir: attr("dir"),
        url: attr("href"),
      };
    }
  }
  return out;
}

/** The text each switcher link rendered, as `hreflang → label`. */
function labels(source: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [, tag, text] of source.matchAll(/<a\b([^>]*)>([^<]*)</g)) {
    const lang = /hreflang="([^"]+)"/.exec(tag ?? "")?.[1];
    if (lang !== undefined) {
      out[lang] = text ?? "";
    }
  }
  return out;
}

/** Every `<link rel="alternate" hreflang>` in a page, as `hreflang → href`. */
function alternates(source: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const tag of source.match(/<link[^>]*rel="alternate"[^>]*>/g) ?? []) {
    const lang = /hreflang="([^"]+)"/.exec(tag)?.[1];
    const href = /href="([^"]+)"/.exec(tag)?.[1];
    if (lang !== undefined && href !== undefined) {
      out[lang] = href;
    }
  }
  return out;
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "jx-i18n-site-"));
  write(
    "project.json",
    JSON.stringify({
      build: { outDir: "./dist" },
      // `ar` is here so direction is exercised rather than asserted: nothing else in the build
      // Produces an RTL page, and `dir` is derived from the script rather than the language.
      i18n: { defaultLocale: "en", locales: ["en", "fr-CA", "ar"] },
      name: "Multi",
      url: SITE,
    }),
  );
  write("pages/index.json", page("Home"));
  write("pages/about.json", page("About"));
  write("pages/fr-ca/index.json", page("Accueil"));
  /*
   * A localized slug: nothing about `/fr-ca/a-propos` matches `/about`, so the document says what
   * page it is. Everything downstream — the switcher, `hreflang`, `x-default`, the sitemap — is
   * derived from that one key, which is the whole test of whether the shipped grouping was right.
   */
  write("pages/fr-ca/a-propos.json", page("À propos", "about"));
  // Arabic has a home page and no About: a partial set is the ordinary case, not the exception.
  write("pages/ar/index.json", page("الرئيسية"));

  /*
   * A collection whose French URLs are translated too: the directory differs (`carnet` vs `notes`)
   * and only a declared key naming the route's own parameter can pair the two.
   */
  const notes = JSON.stringify({
    $paths: { param: "slug", values: ["first", "second"] },
    children: [{ tagName: "h1", textContent: "${$page.params.slug}" }],
    tagName: "article",
    title: "Note",
  });
  write("pages/notes/[slug].json", notes);
  write(
    "pages/fr-ca/carnet/[slug].json",
    JSON.stringify({ ...(JSON.parse(notes) as object), $translationKey: "notes/${slug}" }),
  );

  await buildSite(root);
});

afterAll(() => rmSync(root, { force: true, recursive: true }));

describe("a language switcher", () => {
  it("renders one link per language the page exists in, itself included", () => {
    // No Arabic About exists, so the switcher must not offer one.
    expect(switcher(html("about"))).toEqual({
      en: { current: true, dir: "ltr", url: "/about" },
      "fr-CA": { current: false, dir: "ltr", url: "/fr-ca/a-propos" },
    });
  });

  it("marks the page the reader is on", () => {
    const links = switcher(html("fr-ca/a-propos"));
    expect(links["fr-CA"]?.current).toBe(true);
    expect(links.en?.current).toBe(false);
  });

  /*
   * The label is each language's own name for itself. A menu that says "French" is unreadable to
   * precisely the reader it exists for — and a map template interpolates scope values rather than
   * evaluating expressions, so an author who was not given this would be keeping the table by hand.
   */
  it("labels each language in that language", () => {
    const about = labels(html("about"));
    expect(about["en"]).toBe("English");
    // The exact CLDR wording is ICU's to choose ("français canadien"); the language is not.
    expect(about["fr-CA"]).toStartWith("français");
    expect(labels(html("ar"))["ar"]).toBe("العربية");
  });

  it("carries each language's own direction, so an RTL option renders as one", () => {
    const links = switcher(html("ar"));
    expect(links.ar?.dir).toBe("rtl");
    expect(links.en?.dir).toBe("ltr");
  });

  it("offers what the head advertises — the same set, minus x-default", () => {
    for (const route of ["", "about", "fr-ca", "fr-ca/a-propos", "ar"]) {
      const source = html(route);
      const advertised = Object.keys(alternates(source)).filter((l) => l !== "x-default");
      expect(Object.keys(switcher(source)).toSorted()).toEqual(advertised.toSorted());
    }
  });
});

describe("the hreflang graph", () => {
  const routes = ["", "about", "fr-ca", "fr-ca/a-propos", "ar"];

  it("is complete and symmetric: every member names every member, itself included", () => {
    const graph = new Map(
      routes.map((r) => [`${SITE}/${r}`.replace(/\/$/, "/"), alternates(html(r))]),
    );
    for (const [url, set] of graph) {
      const members = Object.entries(set).filter(([lang]) => lang !== "x-default");
      // A page with no translations is annotated with nothing at all (§13.5).
      if (members.length === 0) {
        continue;
      }
      expect(Object.values(set)).toContain(url);
      for (const [, href] of members) {
        expect(graph.get(href)).toEqual(set);
      }
    }
  });

  it("names exactly one x-default per set, pointing at the default locale", () => {
    expect(alternates(html("fr-ca/a-propos"))["x-default"]).toBe(`${SITE}/about`);
    expect(alternates(html("ar"))["x-default"]).toBe(`${SITE}/`);
    expect(html("about").match(/hreflang="x-default"/g)).toHaveLength(1);
  });

  it("every advertised URL was actually built", () => {
    for (const route of routes) {
      for (const href of Object.values(alternates(html(route)))) {
        const path = new URL(href).pathname.replaceAll(/^\/|\/$/g, "");
        expect(existsSync(join(root, "dist", path, "index.html"))).toBe(true);
      }
    }
  });
});

describe("a localized collection URL", () => {
  /*
   * The case a per-page key cannot reach: one `[slug]` template expands to one route per entry, so
   * a key that could not vary per entry would claim one identity for the whole collection. Two
   * translations of an entry share an id (§13.3), and the id is what the route parameter carries.
   */
  it("pairs each entry with its translation through a parameter in the key", () => {
    expect(alternates(html("notes/first"))["fr-CA"]).toBe(`${SITE}/fr-ca/carnet/first`);
    expect(alternates(html("fr-ca/carnet/first"))["en"]).toBe(`${SITE}/notes/first`);
  });

  it("keeps entries apart — one key per entry, not one for the collection", () => {
    expect(alternates(html("notes/second"))["fr-CA"]).toBe(`${SITE}/fr-ca/carnet/second`);
  });
});

describe("a localized slug", () => {
  /*
   * The limitation §13.5 used to state — "a localized slug is not recognized" — with one line of
   * document. If the shipped grouping was the right shape, this needs nothing else: no second
   * mechanism, no route table entry, no metadata file.
   */
  it("is joined to the page it translates, in both directions", () => {
    expect(alternates(html("about"))["fr-CA"]).toBe(`${SITE}/fr-ca/a-propos`);
    expect(alternates(html("fr-ca/a-propos"))["en"]).toBe(`${SITE}/about`);
  });

  it("reaches the sitemap with the rest of the set", () => {
    const sitemap = readFileSync(join(root, "dist/sitemap.xml"), "utf8");
    expect(sitemap).toContain(`<loc>${SITE}/fr-ca/a-propos</loc>`);
    expect(sitemap).toContain(`hreflang="fr-CA" href="${SITE}/fr-ca/a-propos"`);
  });
});

describe("the page's own language", () => {
  it("reaches <html lang>, and dir only where it is not the default", () => {
    expect(html("fr-ca/a-propos")).toContain('lang="fr-CA"');
    expect(html("ar")).toMatch(/<html[^>]*dir="rtl"[^>]*lang="ar"/);
    expect(html("about")).toContain('lang="en"');
    expect(html("about")).not.toContain('dir="ltr"><head');
  });

  /*
   * The reason A2 exists: a formula that names no locale used to render `1,234.5` on every page of
   * the site, including the French and Arabic ones. Nothing in the document says "English" — the
   * route already did, twice over, in `<html lang>` and in every `hreflang` on the page.
   */
  it("is the locale a formula formats in when it names none", () => {
    expect(html("about")).toContain(new Intl.NumberFormat("en").format(1234.5));
    expect(html("fr-ca/a-propos")).toContain(new Intl.NumberFormat("fr-CA").format(1234.5));
    expect(html("ar")).toContain(new Intl.NumberFormat("ar").format(1234.5));
  });
});
