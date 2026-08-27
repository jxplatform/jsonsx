/**
 * $site / $page injection — the state a page binds against, wherever it is rendered.
 *
 * Ported here with the module: a live renderer produces this same state, and a test that only ran
 * in the compiler's workspace would not notice a host that lost a field.
 */
import { describe, expect, test } from "bun:test";
import { localeLabel } from "@jxsuite/schema/locale";
import { injectContext } from "../src/context.ts";
import type { SiteRoute } from "../src/context.ts";

describe("injectContext", () => {
  const baseProject = {
    name: "Test Site",
    url: "https://example.com",
  };

  const baseRoute: SiteRoute = {
    urlPattern: "/about",
  };

  test("injects $site context into state", () => {
    const doc: Record<string, any> = {};
    injectContext(doc, baseProject, baseRoute);
    expect(doc.state.$site.name).toBe("Test Site");
    expect(doc.state.$site.url).toBe("https://example.com");
  });

  test("injects $page context into state", () => {
    const doc: Record<string, any> = { title: "About Us" };
    injectContext(doc, baseProject, baseRoute);
    expect(doc.state.$page.url).toBe("/about");
    expect(doc.state.$page.title).toBe("About Us");
    expect(doc.state.$page.params).toEqual({});
  });

  test("uses project name as fallback page title", () => {
    const doc: Record<string, any> = {};
    injectContext(doc, baseProject, baseRoute);
    expect(doc.state.$page.title).toBe("Test Site");
  });

  test("uses _pageTitle as intermediate fallback", () => {
    const doc: Record<string, any> = { _pageTitle: "Layout Title" };
    injectContext(doc, baseProject, baseRoute);
    expect(doc.state.$page.title).toBe("Layout Title");
  });

  test("includes route path params", () => {
    const doc: Record<string, any> = {};
    const route = {
      _pathParams: { slug: "hello-world" },
      urlPattern: "/blog/:slug",
    };
    injectContext(doc, baseProject, route);
    expect(doc.state.$page.params).toEqual({ slug: "hello-world" });
  });

  test("merges project state into page state (page wins)", () => {
    const doc: Record<string, any> = { state: { count: 42 } };
    const project = { ...baseProject, state: { count: 0, theme: "dark" } };
    injectContext(doc, project, baseRoute);
    expect(doc.state.count).toBe(42);
    expect(doc.state.theme).toBe("dark");
  });

  test("does not overwrite $site/$page with project state", () => {
    const doc: Record<string, any> = {};
    const project = { ...baseProject, state: { $page: "bad", $site: "bad" } };
    injectContext(doc, project, baseRoute);
    expect(doc.state.$site).not.toBe("bad");
    expect(doc.state.$page).not.toBe("bad");
  });

  test("merges project $media into page $media", () => {
    const doc: Record<string, any> = {
      $media: { "--sm": "(min-width: 640px)" },
    };
    const project = {
      ...baseProject,
      $media: { "--lg": "(min-width: 1024px)" },
    };
    injectContext(doc, project, baseRoute);
    expect(doc.$media["--sm"]).toBe("(min-width: 640px)");
    expect(doc.$media["--lg"]).toBe("(min-width: 1024px)");
  });

  test("page $media overrides project $media on conflict", () => {
    const doc: Record<string, any> = {
      $media: { "--md": "(min-width: 800px)" },
    };
    const project = {
      ...baseProject,
      $media: { "--md": "(min-width: 768px)" },
    };
    injectContext(doc, project, baseRoute);
    expect(doc.$media["--md"]).toBe("(min-width: 800px)");
  });

  test("merges project imports into page imports", () => {
    const doc: Record<string, any> = {
      imports: { MyClass: "./local.class.json" },
    };
    const project = {
      ...baseProject,
      imports: { Parser: "@jxsuite/parser/Parser.class.json" },
    };
    injectContext(doc, project, baseRoute);
    expect(doc.imports.MyClass).toBe("./local.class.json");
    expect(doc.imports.Parser).toBe("@jxsuite/parser/Parser.class.json");
  });

  test("page imports win on collision", () => {
    const doc: any = { imports: { Parser: "./my-parser.class.json" } };
    const project = {
      ...baseProject,
      imports: { Parser: "@jxsuite/parser/Parser.class.json" },
    };
    injectContext(doc, project, baseRoute);
    expect(doc.imports.Parser).toBe("./my-parser.class.json");
  });

  test("merges project $elements into page $elements (union, dedup)", () => {
    const doc = {
      $elements: [{ $ref: "./comp-a.json" }],
    };
    const project = {
      ...baseProject,
      $elements: [{ $ref: "./comp-b.json" }],
    };
    injectContext(doc, project, baseRoute);
    expect(doc.$elements).toHaveLength(2);
  });

  test("deduplicates $elements by $ref", () => {
    const doc = {
      $elements: [{ $ref: "./comp-a.json" }],
    };
    const project = {
      ...baseProject,
      $elements: [{ $ref: "./comp-a.json" }],
    };
    injectContext(doc, project, baseRoute);
    expect(doc.$elements).toHaveLength(1);
  });

  test("creates state if not present on doc", () => {
    const doc: Record<string, any> = {};
    injectContext(doc, baseProject, baseRoute);
    expect(doc.state).toBeDefined();
    expect(doc.state.$site).toBeDefined();
    expect(doc.state.$page).toBeDefined();
  });

  test("spreads project state into $site", () => {
    const project = { ...baseProject, state: { analytics: "GA-123" } };
    const doc: Record<string, any> = {};
    injectContext(doc, project, baseRoute);
    expect(doc.state.$site.analytics).toBe("GA-123");
  });

  test("defaults $site.name to 'Jx Site' when project name missing", () => {
    const doc: Record<string, any> = {};
    injectContext(doc, {}, baseRoute);
    expect(doc.state.$site.name).toBe("Jx Site");
  });

  test("injects project $elements when page has none", () => {
    const doc: Record<string, any> = {};
    const project = {
      ...baseProject,
      $elements: [{ $ref: "./components/card.json" }],
    };
    injectContext(doc, project, baseRoute);
    expect(doc.$elements).toHaveLength(1);
    expect(doc.$elements[0].$ref).toBe("./components/card.json");
  });

  /*
   * A language switcher is the one part of a multilingual site the framework cannot write for the
   * author, and the data behind it is the same translation set `<head>` advertises. Without it the
   * only way to build one is a hardcoded list of URLs, which goes stale silently.
   */
  test("exposes the page's translation set to the template", () => {
    const doc: Record<string, any> = {};
    const i18n = {
      defaultLocale: "en",
      locales: ["en", "fr-CA", "ar"],
      routing: "prefix-always" as const,
    };
    injectContext(doc, baseProject, { urlPattern: "/fr-ca/about/" } as SiteRoute, null, i18n, [
      { locale: "ar", urlPattern: "/ar/about/" },
      { locale: "en", urlPattern: "/about/" },
      { locale: "fr-CA", urlPattern: "/fr-ca/about/" },
    ]);
    expect(doc.state.$page.alternates).toEqual([
      { code: "ar", current: false, dir: "rtl", label: localeLabel("ar"), url: "/ar/about/" },
      { code: "en", current: false, dir: "ltr", label: localeLabel("en"), url: "/about/" },
      {
        code: "fr-CA",
        current: true,
        dir: "ltr",
        label: localeLabel("fr-CA"),
        url: "/fr-ca/about/",
      },
    ]);
    // The autonym, not the name in the site's language: a menu reading "French" is unreadable to
    // Exactly the person looking for it.
    expect(doc.state.$page.alternates[1].label).toBe("English");
  });

  test("no translation set, no key — a monolingual page carries nothing extra", () => {
    const doc: Record<string, any> = {};
    injectContext(doc, baseProject, baseRoute);
    expect("alternates" in doc.state.$page).toBe(false);
  });

  /*
   * `$lang` overrides the locale the route implies (§13.4), but not which directory the page is
   * served from — so `current` follows the route. A switcher that marked the wrong entry would
   * offer the reader a link to the page they are already on.
   */
  test("current follows the route, not an overriding $lang", () => {
    const doc: Record<string, any> = { $lang: "de" };
    const i18n = {
      defaultLocale: "en",
      locales: ["en", "fr-CA"],
      routing: "prefix-except-default" as const,
    };
    injectContext(doc, baseProject, { urlPattern: "/about/" } as SiteRoute, null, i18n, [
      { locale: "en", urlPattern: "/about/" },
      { locale: "fr-CA", urlPattern: "/fr-ca/about/" },
    ]);
    expect(doc.state.$page.locale).toBe("de");
    expect(doc.state.$page.alternates.find((a: { current: boolean }) => a.current).code).toBe("en");
  });
});

describe("injectContext import rebasing", () => {
  const route: SiteRoute = { sourcePath: "/site/pages/blog/hello.json", urlPattern: "/blog/hello" };

  test("a relative project import is handed to the rebaser", () => {
    const doc: Record<string, any> = {};
    injectContext(doc, { imports: { helpers: "./lib/helpers.ts" } } as any, route, (src, r) => {
      expect(src).toBe("./lib/helpers.ts");
      expect(r.sourcePath).toBe("/site/pages/blog/hello.json");
      return "./../../lib/helpers.ts";
    });
    expect(doc.imports.helpers).toBe("./../../lib/helpers.ts");
  });

  test("bare and npm specifiers pass through unrebased", () => {
    const doc: Record<string, any> = {};
    const rebase = () => "SHOULD NOT HAPPEN";
    injectContext(doc, { imports: { lit: "lit", pkg: "npm:thing" } } as any, route, rebase);
    expect(doc.imports).toEqual({ lit: "lit", pkg: "npm:thing" });
  });

  test("without a rebaser the authored path is used as written", () => {
    /* A live renderer serves the project at a root where `./lib/helpers.ts` already means what it
       says, so there is nothing to rebase and nothing to inject. */
    const doc: Record<string, any> = {};
    injectContext(doc, { imports: { helpers: "./lib/helpers.ts" } } as any, route);
    expect(doc.imports.helpers).toBe("./lib/helpers.ts");
  });

  test("a page import wins over the project's", () => {
    const doc: Record<string, any> = { imports: { helpers: "./own.ts" } };
    injectContext(doc, { imports: { helpers: "./lib/helpers.ts" } } as any, route, () => "rebased");
    expect(doc.imports.helpers).toBe("./own.ts");
  });
});
