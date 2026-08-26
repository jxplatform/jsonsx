/**
 * Route derivation — the rules three surfaces used to each keep their own copy of.
 *
 * The cases below are deliberately the ones where the copies could have drifted without anyone
 * noticing: an extension that is not an extension, a dot inside a segment, a catch-all that matches
 * its own parent, and the trailing-slash form a published page actually links to.
 */
import { describe, expect, test } from "bun:test";
import {
  compareRoutes,
  documentUrlPattern,
  dynamicRouteParams,
  fileToRoute,
  isRoutedPageFile,
  matchRoute,
  pageRelativePath,
  routeHref,
} from "../src/routes.ts";

describe("pageRelativePath", () => {
  test("strips the addressing prefix in either space", () => {
    expect(pageRelativePath("pages/blog/hello.json")).toBe("blog/hello.json");
    expect(pageRelativePath("./pages/blog/hello.json")).toBe("blog/hello.json");
    expect(pageRelativePath("/pages/blog/hello.json")).toBe("blog/hello.json");
    expect(pageRelativePath("blog/hello.json")).toBe("blog/hello.json");
  });

  test("normalises windows separators", () => {
    expect(pageRelativePath(String.raw`blog\hello.json`)).toBe("blog/hello.json");
  });
});

describe("fileToRoute", () => {
  test("static routes", () => {
    expect(fileToRoute("index.json").urlPattern).toBe("/");
    expect(fileToRoute("about.json").urlPattern).toBe("/about");
    expect(fileToRoute("about/index.json").urlPattern).toBe("/about");
    expect(fileToRoute("docs/guide/intro.json").urlPattern).toBe("/docs/guide/intro");
  });

  test("the route is a property of the name, not the parser", () => {
    expect(fileToRoute("about.md").urlPattern).toBe("/about");
    expect(fileToRoute("about.mdx").urlPattern).toBe("/about");
  });

  test("a dot inside a segment is not an extension", () => {
    expect(fileToRoute("v1.2/index.json").urlPattern).toBe("/v1.2");
    expect(fileToRoute("v1.2.json").urlPattern).toBe("/v1.2");
  });

  test("a leading dot is a name, not an extension", () => {
    expect(fileToRoute(".well-known").urlPattern).toBe("/.well-known");
  });

  test("a file with no extension keeps its whole name", () => {
    expect(fileToRoute("about").urlPattern).toBe("/about");
  });

  test("dynamic routes", () => {
    const route = fileToRoute("blog/[slug].json");
    expect(route.urlPattern).toBe("/blog/:slug");
    expect(route.params).toEqual(["slug"]);
    expect(route.isDynamic).toBe(true);
    expect(route.isCatchAll).toBe(false);
  });

  test("multiple parameters keep declaration order", () => {
    const route = fileToRoute("[lang]/blog/[slug].json");
    expect(route.urlPattern).toBe("/:lang/blog/:slug");
    expect(route.params).toEqual(["lang", "slug"]);
  });

  test("catch-all routes", () => {
    const route = fileToRoute("docs/[...rest].json");
    expect(route.urlPattern).toBe("/docs/*");
    expect(route.params).toEqual(["rest"]);
    expect(route.isDynamic).toBe(true);
    expect(route.isCatchAll).toBe(true);
  });

  test("accepts a project-relative document path", () => {
    expect(fileToRoute("pages/blog/[slug].json").urlPattern).toBe("/blog/:slug");
  });
});

describe("documentUrlPattern / dynamicRouteParams", () => {
  test("answer for the document the studio happens to have open", () => {
    expect(documentUrlPattern("pages/products/[sku].json")).toBe("/products/:sku");
    expect(dynamicRouteParams("pages/products/[sku].json")).toEqual(["sku"]);
  });

  test("no open document is not an error", () => {
    expect(documentUrlPattern(null)).toBe("/");
    expect(documentUrlPattern()).toBe("/");
    expect(documentUrlPattern("")).toBe("/");
    expect(dynamicRouteParams(null)).toEqual([]);
    expect(dynamicRouteParams("")).toEqual([]);
  });
});

describe("isRoutedPageFile", () => {
  test("an underscore opts a file out", () => {
    expect(isRoutedPageFile("blog/_card.json")).toBe(false);
    expect(isRoutedPageFile("blog/card.json")).toBe(true);
  });

  test("an underscore opts a whole directory out", () => {
    expect(isRoutedPageFile("_partials/card.json")).toBe(false);
    expect(isRoutedPageFile("blog/_partials/card.json")).toBe(false);
  });

  test("an empty path is not a route", () => {
    expect(isRoutedPageFile("")).toBe(false);
  });
});

describe("compareRoutes", () => {
  test("static beats dynamic beats catch-all", () => {
    const routes = [
      fileToRoute("docs/[...rest].json"),
      fileToRoute("[slug].json"),
      fileToRoute("about.json"),
    ].toSorted(compareRoutes);
    expect(routes.map((route) => route.urlPattern)).toEqual(["/about", "/:slug", "/docs/*"]);
  });

  test("peers sort by pattern, so the table is stable across directory walks", () => {
    const routes = [fileToRoute("beta.json"), fileToRoute("alpha.json")].toSorted(compareRoutes);
    expect(routes.map((route) => route.urlPattern)).toEqual(["/alpha", "/beta"]);
  });
});

describe("matchRoute", () => {
  const table = [
    fileToRoute("index.json"),
    fileToRoute("about.json"),
    fileToRoute("blog/[slug].json"),
    fileToRoute("docs/[...rest].json"),
  ].toSorted(compareRoutes);

  test("the root", () => {
    expect(matchRoute(table, "/")?.route.urlPattern).toBe("/");
  });

  test("a static route wins over a dynamic one that could also claim it", () => {
    const table2 = [fileToRoute("[slug].json"), fileToRoute("about.json")].toSorted(compareRoutes);
    expect(matchRoute(table2, "/about")?.route.urlPattern).toBe("/about");
  });

  test("a dynamic route yields its parameter", () => {
    const match = matchRoute(table, "/blog/hello-world");
    expect(match?.route.urlPattern).toBe("/blog/:slug");
    expect(match?.params).toEqual({ slug: "hello-world" });
  });

  test("a parameter is decoded", () => {
    expect(matchRoute(table, "/blog/caf%C3%A9")?.params).toEqual({ slug: "café" });
  });

  test("a trailing slash is not significant", () => {
    expect(matchRoute(table, "/about/")?.route.urlPattern).toBe("/about");
    expect(matchRoute(table, "/blog/hello/")?.params).toEqual({ slug: "hello" });
  });

  test("a catch-all consumes the rest, including nothing", () => {
    expect(matchRoute(table, "/docs/a/b/c")?.params).toEqual({ "*": "a/b/c" });
    expect(matchRoute(table, "/docs")?.params).toEqual({ "*": "" });
  });

  test("a dynamic segment does not match across a slash", () => {
    expect(matchRoute(table, "/blog/a/b")).toBeNull();
  });

  test("a miss is null", () => {
    expect(matchRoute(table, "/nope")).toBeNull();
    expect(matchRoute(table, "/about/deeper")).toBeNull();
  });
});

describe("routeHref", () => {
  test("the root is the root under either policy", () => {
    expect(routeHref("/")).toBe("/");
    expect(routeHref("/", {}, "never")).toBe("/");
    expect(routeHref("")).toBe("/");
  });

  test("trailingSlash decides the written form", () => {
    expect(routeHref("/about")).toBe("/about/");
    expect(routeHref("/about", {}, "never")).toBe("/about");
    expect(routeHref("/about/", {}, "never")).toBe("/about");
  });

  test("parameters are substituted and encoded", () => {
    expect(routeHref("/blog/:slug", { slug: "hello world" })).toBe("/blog/hello%20world/");
  });

  test("an unfilled parameter is left as the pattern rather than guessed at", () => {
    expect(routeHref("/blog/:slug")).toBe("/blog/:slug/");
  });

  test("a catch-all keeps its slashes but encodes its segments", () => {
    expect(routeHref("/docs/*", { "*": "a/b c" }, "never")).toBe("/docs/a/b%20c");
    expect(routeHref("/docs/*", { "*": "" })).toBe("/docs/");
    expect(routeHref("/docs/*")).toBe("/docs/*/");
  });
});
