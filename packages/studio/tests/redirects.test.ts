/**
 * The redirect model: config round-trip, pattern matching, the three validations, and the two
 * import readers. Pure — no DOM, no platform, no project.
 */
import { describe, expect, test } from "bun:test";
import {
  configFromRules,
  isExternal,
  isPattern,
  matchesPattern,
  normalizePath,
  parseRedirectImport,
  parseRedirectsCsv,
  parseRedirectsFile,
  routePattern,
  rulesFromConfig,
  validateRedirects,
} from "../src/grid/redirects";
import type { RedirectRule } from "../src/grid/redirects";

const rule = (source: string, destination: string, status = 301): RedirectRule => ({
  destination,
  source,
  status,
});

describe("project.json round-trip", () => {
  test("both spellings flatten, and only a non-301 expands again", () => {
    const rules = rulesFromConfig({
      "/api/*": { destination: "https://api.example.com/*", status: 200 },
      "/legacy": { destination: "/archive" },
      "/old": "/new",
    });
    expect(rules).toEqual([
      rule("/api/*", "https://api.example.com/*", 200),
      rule("/legacy", "/archive"),
      rule("/old", "/new"),
    ]);
    expect(configFromRules(rules)).toEqual({
      "/api/*": { destination: "https://api.example.com/*", status: 200 },
      "/legacy": "/archive",
      "/old": "/new",
    });
  });

  test("no redirects block is an empty rule set, not a crash", () => {
    const missing: Parameters<typeof rulesFromConfig>[0] = undefined;
    expect(rulesFromConfig(missing)).toEqual([]);
    expect(configFromRules([])).toEqual({});
  });
});

describe("paths and patterns", () => {
  test("normalizePath drops one trailing slash but never the root", () => {
    expect(normalizePath("/about/")).toBe("/about");
    expect(normalizePath("  /about  ")).toBe("/about");
    expect(normalizePath("/")).toBe("/");
  });

  test("isPattern and isExternal", () => {
    expect(isPattern("/blog/:slug")).toBeTrue();
    expect(isPattern("/docs/*")).toBeTrue();
    expect(isPattern("/about")).toBeFalse();
    expect(isExternal("https://example.com")).toBeTrue();
    expect(isExternal("mailto:a@b.c")).toBeTrue();
    expect(isExternal("//cdn.example.com/x")).toBeTrue();
    expect(isExternal("/about")).toBeFalse();
  });

  test("matchesPattern: literals, one-segment params, and a tail wildcard", () => {
    expect(matchesPattern("/about", "/about/")).toBeTrue();
    expect(matchesPattern("/about", "/contact")).toBeFalse();
    expect(matchesPattern("/blog/:slug", "/blog/hello")).toBeTrue();
    expect(matchesPattern("/blog/:slug", "/blog/hello/again")).toBeFalse();
    expect(matchesPattern("/blog/:slug", "/blog")).toBeFalse();
    expect(matchesPattern("/blog/:slug", "/blog/")).toBeFalse();
    expect(matchesPattern("/legacy/*", "/legacy/a/b")).toBeTrue();
    expect(matchesPattern("/legacy/*", "/legacy")).toBeTrue();
    expect(matchesPattern("/legacy/*", "/other")).toBeFalse();
    expect(matchesPattern("/", "/")).toBeTrue();
    expect(matchesPattern("/a/b", "/a")).toBeFalse();
    // A doubled slash leaves an empty segment, and a :param must match SOMETHING.
    expect(matchesPattern("/:a/x", "//x")).toBeFalse();
  });

  test("routePattern translates the router's brackets into a redirect's colons", () => {
    expect(routePattern("/blog/[slug]")).toBe("/blog/:slug");
    expect(routePattern("/about")).toBe("/about");
  });
});

describe("validation", () => {
  test("a clean set reports nothing", () => {
    expect(validateRedirects([rule("/old", "/new")], ["/new"])).toEqual([]);
  });

  test("chain: the whole path is printed and the fix names the final destination", () => {
    const found = validateRedirects([rule("/a", "/b"), rule("/b", "/c")], []);
    const chain = found.filter((p) => p.rule === "chain");
    expect(chain).toHaveLength(1);
    expect(chain[0]!.message).toBe("Redirect chain: /a → /b → /c");
    expect(chain[0]!.source).toBe("/a");
    expect(chain[0]!.detail).toContain("Point /a straight at /c");
  });

  test("chain: a trailing slash is not a different page", () => {
    const found = validateRedirects([rule("/a", "/b/"), rule("/b", "/c")], []);
    expect(found.map((p) => p.rule)).toEqual(["chain"]);
  });

  test("chain: through a pattern source, which is the one nobody spots by reading", () => {
    const found = validateRedirects([rule("/a", "/docs/v1/x"), rule("/docs/*", "/guide")], []);
    expect(found.find((p) => p.rule === "chain")!.message).toBe(
      "Redirect chain: /a → /docs/v1/x → /guide",
    );
  });

  test("loop: reported once for the cycle, as an error-worthy finding", () => {
    const found = validateRedirects([rule("/a", "/b"), rule("/b", "/c"), rule("/c", "/a")], []);
    expect(found).toHaveLength(1);
    expect(found[0]!.rule).toBe("loop");
    expect(found[0]!.message).toBe("Redirect loop: /a → /b → /c → /a");
  });

  test("loop: a rule pointing at itself is a loop, not a chain", () => {
    const found = validateRedirects([rule("/a", "/a")], []);
    expect(found.map((p) => p.rule)).toEqual(["loop"]);
  });

  test("an external or pattern destination ends the walk instead of guessing", () => {
    expect(validateRedirects([rule("/a", "https://example.com/b"), rule("/b", "/c")], [])).toEqual(
      [],
    );
    expect(validateRedirects([rule("/docs/*", "/guide/*"), rule("/guide", "/x")], [])).toEqual([]);
  });

  test("shadow: a literal rule covered by a real page, static or dynamic", () => {
    const literal = validateRedirects([rule("/about", "/contact")], ["/about", "/x"]);
    expect(literal).toHaveLength(1);
    expect(literal[0]!.rule).toBe("shadow");
    expect(literal[0]!.message).toBe("Redirect shadowed by a page: /about");
    expect(literal[0]!.detail).toContain("page at /about");

    const dynamic = validateRedirects([rule("/blog/hello", "/posts/hello")], ["/blog/[slug]"]);
    expect(dynamic.map((p) => p.rule)).toEqual(["shadow"]);
  });

  test("shadow: a pattern rule that covers real pages says how many", () => {
    const found = validateRedirects([rule("/docs/*", "/guide")], ["/docs/a", "/docs/b", "/other"]);
    expect(found[0]!.detail).toContain("page at /docs/a (and 1 more)");
  });

  test("shadow: an empty route list produces no findings — the caller owns that honesty", () => {
    expect(validateRedirects([rule("/about", "/contact")], [])).toEqual([]);
  });
});

describe("_redirects import", () => {
  test("reads sources, destinations, statuses, comments and blank lines", () => {
    const result = parseRedirectsFile(
      ["# a comment", "", "/old  /new", "/moved /there 302", "/forced /f 301!"].join("\n"),
    );
    expect(result.format).toBe("_redirects");
    expect(result.rules).toEqual([
      rule("/old", "/new"),
      rule("/moved", "/there", 302),
      rule("/forced", "/f"),
    ]);
    expect(result.errors).toEqual([]);
  });

  test("a short line and a nonsense status are named by line number, never dropped", () => {
    const result = parseRedirectsFile("/only-one\n/a /b banana\n");
    expect(result.rules).toEqual([]);
    expect(result.errors).toEqual([
      'Line 1: "/only-one" — expected "source destination [status]".',
      'Line 2: "banana" is not an HTTP status.',
    ]);
  });
});

describe("CSV import", () => {
  test("a recognized header maps columns by name in any order", () => {
    const result = parseRedirectsCsv("Status,To,From\n302,/new,/old\n");
    expect(result.format).toBe("csv");
    expect(result.rules).toEqual([rule("/old", "/new", 302)]);
  });

  test("without a header the first record is data, positionally", () => {
    const result = parseRedirectsCsv("/old,/new\n/a,/b,308\n");
    expect(result.rules).toEqual([rule("/old", "/new"), rule("/a", "/b", 308)]);
  });

  test("a half-filled row is reported by row number; a blank row is skipped", () => {
    const result = parseRedirectsCsv("source,destination\n/old,\n,\n/a,/b\n");
    expect(result.rules).toEqual([rule("/a", "/b")]);
    expect(result.errors).toEqual(["Row 2: both a source and a destination are required."]);
  });

  test("a bad status in a headed file is reported by row number", () => {
    const result = parseRedirectsCsv("source,destination,code\n/a,/b,nope\n");
    expect(result.rules).toEqual([]);
    expect(result.errors).toEqual(['Row 2: "nope" is not an HTTP status.']);
  });
});

describe("format sniff", () => {
  test("a comma on the first content line means CSV; otherwise _redirects", () => {
    expect(parseRedirectImport("# hi\nsource,destination\n/a,/b\n").format).toBe("csv");
    expect(parseRedirectImport("\n/a /b 301\n").format).toBe("_redirects");
    expect(parseRedirectImport("").format).toBe("_redirects");
  });
});
