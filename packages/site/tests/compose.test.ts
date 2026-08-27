/**
 * Composing a page from a working tree.
 *
 * The `$elements` union is the case worth naming: `resolveLayout` merges neither side, so without
 * the union a page that declares its own custom element renders it as an inert unknown tag with no
 * error anywhere — the browser reports nothing at all. That regression is what this suite pins.
 */
import { describe, expect, test } from "bun:test";
import {
  ComposeError,
  composePage,
  composeRoute,
  readProjectConfig,
  routeTable,
  unionElements,
} from "../src/compose.ts";
import type { SiteIO } from "../src/compose.ts";
import type { JxDocument, ProjectConfig } from "@jxsuite/schema/types";

/** A working tree held in memory — the same shape a disk, a DO or a fetch would present. */
function treeIO(files: Record<string, string>, parse?: SiteIO["parse"]): SiteIO {
  return {
    paths: () => Object.keys(files),
    read: (path) => Promise.resolve(files[path] ?? null),
    ...(parse ? { parse } : {}),
  };
}

const PAGE = JSON.stringify({ tagName: "main", children: ["Hello"] });

describe("routeTable", () => {
  test("only pages/ files with a route are in the table", () => {
    const routes = routeTable([
      "pages/index.json",
      "pages/about.json",
      "components/card.json",
      "project.json",
    ]);
    expect(routes.map((r) => r.urlPattern).toSorted()).toEqual(["/", "/about"]);
  });

  test("a partial (underscore-prefixed) page is not routed", () => {
    expect(routeTable(["pages/_draft.json"])).toEqual([]);
  });

  test("the table is in match order: static, then dynamic, then catch-all", () => {
    const routes = routeTable([
      "pages/blog/[...rest].json",
      "pages/blog/[slug].json",
      "pages/blog/index.json",
    ]);
    expect(routes.map((r) => r.urlPattern)).toEqual(["/blog", "/blog/:slug", "/blog/*"]);
  });

  test("each entry remembers the file it came from", () => {
    expect(routeTable(["pages/blog/[slug].json"])[0]?.sourcePath).toBe("pages/blog/[slug].json");
  });
});

describe("readProjectConfig", () => {
  test("reads project.json", async () => {
    const config = await readProjectConfig(treeIO({ "project.json": '{"name":"Acme"}' }));
    expect(config.name).toBe("Acme");
  });

  test("a tree with no project.json composes against an empty config", async () => {
    expect(await readProjectConfig(treeIO({}))).toEqual({} as ProjectConfig);
  });

  test("a project.json that does not parse still leaves the pages renderable", async () => {
    // Refusing every page would hide the one error the author can act on behind a blank origin.
    expect(await readProjectConfig(treeIO({ "project.json": "{ oops" }))).toEqual(
      {} as ProjectConfig,
    );
  });
});

describe("unionElements", () => {
  test("keeps declaration order and drops repeats", () => {
    expect(unionElements(["a", "b"], ["b", "c"])).toEqual(["a", "b", "c"]);
  });

  test("a $ref entry is keyed by what it names", () => {
    expect(unionElements([{ $ref: "./x.json" }], [{ $ref: "./x.json" }])).toEqual([
      { $ref: "./x.json" },
    ]);
  });

  test("an entry that is neither is keyed by its own shape rather than collapsing", () => {
    expect(unionElements([{ tagName: "a" }], [{ tagName: "b" }])).toHaveLength(2);
  });

  test("nothing declared anywhere is undefined, not an empty array", () => {
    expect(unionElements(undefined, [])).toBeUndefined();
  });
});

describe("composeRoute", () => {
  test("a URL no route claims composes to null", async () => {
    const io = treeIO({ "pages/index.json": PAGE });
    const routes = routeTable(io.paths());
    expect(await composeRoute(io, routes, {} as ProjectConfig, "/nope")).toBeNull();
  });

  test("a dynamic route matches on demand and takes its parameters from the URL", async () => {
    // $paths is deliberately not expanded, so /blog/anything renders.
    const io = treeIO({ "pages/blog/[slug].json": PAGE });
    const routes = routeTable(io.paths());
    const page = await composeRoute(io, routes, {} as ProjectConfig, "/blog/anything");
    expect(page).not.toBeNull();
    expect((page?.doc.state as Record<string, unknown>) ?? {}).toBeDefined();
  });

  test("a trailing slash is not significant", async () => {
    const io = treeIO({ "pages/about.json": PAGE });
    const routes = routeTable(io.paths());
    expect(await composeRoute(io, routes, {} as ProjectConfig, "/about/")).not.toBeNull();
  });
});

describe("composePage", () => {
  const route = { sourcePath: "pages/index.json" } as never;

  async function compose(
    files: Record<string, string>,
    config: ProjectConfig = {} as ProjectConfig,
  ) {
    const io = treeIO(files);
    return composePage(io, routeTable(io.paths())[0]!, config, {});
  }

  test("a page with no layout composes to itself", async () => {
    const page = await compose({ "pages/index.json": PAGE });
    expect(page.doc.tagName).toBe("main");
  });

  test("a page-declared $element survives layout resolution", async () => {
    /* The regression: `resolveLayout` merges neither side, so the composed document would carry
       only the LAYOUT's $elements, and <site-card> would render as an inert unknown tag — with no
       error anywhere, because the browser reports nothing at all for one. */
    const page = await compose({
      "layouts/base.json": JSON.stringify({
        $elements: [{ $ref: "./components/nav.json" }],
        children: [{ tagName: "slot" }],
        tagName: "body",
      }),
      "pages/index.json": JSON.stringify({
        $elements: [{ $ref: "./components/card.json" }],
        $layout: "./layouts/base.json",
        children: ["Hi"],
        tagName: "main",
      }),
    });
    expect(page.doc.$elements).toEqual([
      { $ref: "./components/nav.json" },
      { $ref: "./components/card.json" },
    ]);
  });

  test("$head is merged into the shell's head and REMOVED from the document", async () => {
    // Left on the document, the runtime would inject every entry a second time on mount.
    const page = await compose({
      "pages/index.json": JSON.stringify({
        $head: [{ attributes: { content: "x", name: "description" }, tagName: "meta" }],
        tagName: "main",
      }),
    });
    expect(page.doc.$head).toBeUndefined();
    expect(page.doc._pageHead).toBeUndefined();
    expect(page.doc._pageTitle).toBeUndefined();
    expect(page.head.some((e) => e.attributes?.name === "description")).toBe(true);
  });

  test("the site's, the layout's and the page's $head all reach the merged head", async () => {
    const page = await compose(
      {
        "layouts/base.json": JSON.stringify({
          $head: [{ attributes: { href: "/l.css", rel: "stylesheet" }, tagName: "link" }],
          children: [{ tagName: "slot" }],
          tagName: "body",
        }),
        "pages/index.json": JSON.stringify({
          $head: [{ attributes: { content: "p", name: "description" }, tagName: "meta" }],
          $layout: "./layouts/base.json",
          tagName: "main",
        }),
      },
      {
        $head: [{ attributes: { href: "/favicon.svg", rel: "icon" }, tagName: "link" }],
      } as ProjectConfig,
    );
    const rels = page.head.map((e) => e.attributes?.rel ?? e.attributes?.name);
    expect(rels).toContain("icon");
    expect(rels).toContain("stylesheet");
    expect(rels).toContain("description");
  });

  test("language comes from the document, and direction follows it", async () => {
    const page = await compose({
      "pages/index.json": JSON.stringify({ $lang: "ar", tagName: "main" }),
    });
    expect(page.lang).toBe("ar");
    expect(page.dir).toBe("rtl");
  });

  test("with nothing declared anywhere, the language defaults to en/ltr", async () => {
    const page = await compose({ "pages/index.json": PAGE });
    expect(page.lang).toBe("en");
    expect(page.dir).toBe("ltr");
  });

  test("project defaults.lang is used when the document declares none", async () => {
    const page = await compose({ "pages/index.json": PAGE }, {
      defaults: { lang: "he" },
    } as ProjectConfig);
    expect(page.lang).toBe("he");
    expect(page.dir).toBe("rtl");
  });

  test("the page's title reaches the merged head", async () => {
    const page = await compose({
      "pages/index.json": JSON.stringify({ tagName: "main", title: "Hello" }),
    });
    expect(page.head.some((e) => e.tagName === "title")).toBe(true);
  });

  test("a missing layout names the reference it could not find", async () => {
    const promise = compose({
      "pages/index.json": JSON.stringify({ $layout: "./layouts/gone.json", tagName: "main" }),
    });
    await expect(promise).rejects.toThrow(ComposeError);
    await expect(promise).rejects.toThrow("Layout not found: ./layouts/gone.json");
  });

  test("a page file the tree does not have names the file", async () => {
    const io = treeIO({});
    await expect(
      composePage(io, { ...(route as object), urlPattern: "/" } as never, {} as ProjectConfig, {}),
    ).rejects.toThrow("pages/index.json could not be read as a page");
  });

  test("without a parser, a non-JSON page is a named error rather than a blank page", async () => {
    const io = treeIO({ "pages/index.md": "# Hi" });
    const mdRoute = routeTable(io.paths())[0]!;
    await expect(composePage(io, mdRoute, {} as ProjectConfig, {})).rejects.toThrow(
      "other formats need their extension's parser",
    );
  });

  test("with a parser injected, a non-JSON page renders", async () => {
    const io = treeIO({ "pages/index.md": "# Hi" }, (_path, text) => ({
      children: [text.replace("# ", "")],
      tagName: "h1",
    }));
    const page = await composePage(io, routeTable(io.paths())[0]!, {} as ProjectConfig, {});
    expect(page.doc.tagName).toBe("h1");
    expect(page.doc.children).toEqual(["Hi"]);
  });

  test("a parser that declines still produces the named error, not a blank page", async () => {
    const io = treeIO({ "pages/index.md": "# Hi" }, () => null);
    const mdRoute = routeTable(io.paths())[0]!;
    await expect(composePage(io, mdRoute, {} as ProjectConfig, {})).rejects.toThrow(
      "could not be read as a page",
    );
  });

  test("a layout may be parsed through an injected parser too", async () => {
    const io = treeIO(
      {
        "layouts/base.md": "wrapper",
        "pages/index.json": JSON.stringify({ $layout: "./layouts/base.md", tagName: "main" }),
      },
      () => ({ children: [{ tagName: "slot" }], tagName: "body" }) as JxDocument,
    );
    const page = await composePage(io, routeTable(io.paths())[0]!, {} as ProjectConfig, {});
    expect(page.doc.tagName).toBe("body");
  });

  test("a layout that lifted the page's $head still reaches the merged head", async () => {
    /* `resolveLayout` moves the page's own $head onto `_pageHead`, so the composer has to look
       there as well as at the page document — otherwise wrapping a page in a layout silently drops
       every meta tag the page declared for itself. */
    const page = await compose({
      "layouts/base.json": JSON.stringify({
        children: [{ tagName: "slot" }],
        tagName: "body",
      }),
      "pages/index.json": JSON.stringify({
        $head: [{ attributes: { content: "lifted", name: "description" }, tagName: "meta" }],
        $layout: "./layouts/base.json",
        tagName: "main",
        title: "Lifted",
      }),
    });
    expect(page.head.some((e) => e.attributes?.content === "lifted")).toBe(true);
    expect(page.head.some((e) => e.tagName === "title" && e.children?.[0] === "Lifted")).toBe(true);
  });

  test("with no title anywhere, the site's name is the title", async () => {
    const page = await compose({ "pages/index.json": PAGE }, { name: "Acme" } as ProjectConfig);
    expect(page.head.some((e) => e.tagName === "title")).toBe(true);
  });

  test("a localized route takes its language from the route, not from a default", async () => {
    const io = treeIO({ "pages/fr/index.json": PAGE });
    const config = {
      defaults: { lang: "en" },
      i18n: { defaultLocale: "en", locales: ["en", "fr"] },
    } as unknown as ProjectConfig;
    const page = await composePage(io, routeTable(io.paths())[0]!, config, {});
    expect(page.lang).toBe("fr");
  });

  test("$site and $page context is injected before anything renders", async () => {
    const page = await compose({ "pages/index.json": PAGE }, { name: "Acme" } as ProjectConfig);
    const state = page.doc.state as Record<string, unknown> | undefined;
    expect(state).toBeDefined();
    expect(JSON.stringify(state)).toContain("Acme");
  });
});
