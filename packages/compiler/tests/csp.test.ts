import { describe, expect, test } from "bun:test";
import {
  buildCspHeaders,
  collectCspSources,
  emptyCspSources,
  hashOf,
  normalizeCspConfig,
  originOf,
} from "../src/site/csp.ts";

const collect = (html: string) => {
  const sources = emptyCspSources();
  collectCspSources(html, sources);
  return sources;
};

const policy = (html: string, config = {}) =>
  buildCspHeaders(collect(html), config)["Content-Security-Policy"] ?? "";

describe("originOf", () => {
  test("keeps only the origin of an absolute http(s) URL", () => {
    expect(originOf("https://cdn.example/a/b.js?v=1")).toBe("https://cdn.example");
    expect(originOf("http://cdn.example:8080/x")).toBe("http://cdn.example:8080");
  });

  test("relative, data: and malformed URLs contribute nothing", () => {
    for (const url of ["/assets/x.js", "./x.js", "data:image/png;base64,AA", ""]) {
      expect(originOf(url)).toBeNull();
    }
    // The absent case: an attribute the tag never carried.
    expect(originOf(({} as { src?: string }).src)).toBeNull();
  });
});

describe("hashOf", () => {
  // A hash covers the exact bytes between the tags — no trimming, no normalization.
  test("is the base64 SHA-256 of the exact source", () => {
    expect(hashOf("")).toBe("'sha256-47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU='");
    expect(hashOf(" x ")).not.toBe(hashOf("x"));
  });
});

describe("collectCspSources", () => {
  test("hashes an inline classic script", () => {
    const sources = collect("<script>alert(1)</script>");
    expect([...sources.scriptHashes]).toEqual([hashOf("alert(1)")]);
  });

  test("hashes an inline module and an import map", () => {
    const sources = collect(
      '<script type="module">import "x";</script><script type="importmap">{}</script>',
    );
    expect(sources.scriptHashes.size).toBe(2);
    expect(sources.scriptHashes.has(hashOf("{}"))).toBe(true);
  });

  /*
   * A `<script type="application/ld+json">` is a data block: the browser never executes it, CSP
   * never checks it, and a hash for it would authorize nothing. Confirmed in Chrome against an
   * enforced policy — the JSON-LD survived with no hash in the header.
   */
  test("ignores data blocks", () => {
    const sources = collect('<script type="application/ld+json">{"@type":"WebSite"}</script>');
    expect(sources.scriptHashes.size).toBe(0);
  });

  test("an external script contributes its origin, not a hash", () => {
    const sources = collect('<script src="https://plausible.io/js/x.js"></script>');
    expect([...sources.scriptOrigins]).toEqual(["https://plausible.io"]);
    expect(sources.scriptHashes.size).toBe(0);
  });

  test("a same-origin script contributes nothing — 'self' already covers it", () => {
    const sources = collect('<script type="module" src="/components/x.js"></script>');
    expect(sources.scriptOrigins.size).toBe(0);
    expect(sources.scriptHashes.size).toBe(0);
  });

  test("stylesheet, font, image and frame origins land in their own buckets", () => {
    const sources = collect(
      '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?x">' +
        '<link rel="preload" as="font" href="https://fonts.gstatic.com/f.woff2">' +
        '<img src="https://images.example/a.png">' +
        '<source srcset="https://images.example/a.avif 640w, https://cdn2.example/b.avif 1200w">' +
        '<iframe src="https://www.youtube.com/embed/x"></iframe>',
    );
    expect([...sources.styleOrigins]).toEqual(["https://fonts.googleapis.com"]);
    expect([...sources.fontOrigins]).toEqual(["https://fonts.gstatic.com"]);
    expect([...sources.imgOrigins].toSorted()).toEqual([
      "https://cdn2.example",
      "https://images.example",
    ]);
    expect([...sources.frameOrigins]).toEqual(["https://www.youtube.com"]);
  });

  test("single-quoted attributes are read too", () => {
    expect([...collect("<script src='https://a.example/x.js'></script>").scriptOrigins]).toEqual([
      "https://a.example",
    ]);
  });

  test("the same inline script on two pages yields one hash", () => {
    const sources = emptyCspSources();
    collectCspSources("<script>same()</script>", sources);
    collectCspSources("<script>same()</script>", sources);
    expect(sources.scriptHashes.size).toBe(1);
  });
});

describe("normalizeCspConfig", () => {
  test("off unless asked for", () => {
    expect(normalizeCspConfig({})).toBeNull();
    expect(normalizeCspConfig({ csp: false })).toBeNull();
  });

  test("the three spellings collapse to one shape", () => {
    expect(normalizeCspConfig({ csp: true })).toEqual({});
    expect(normalizeCspConfig({ csp: "report-only" })).toEqual({ mode: "report-only" });
    expect(normalizeCspConfig({ csp: { reportUri: "/r" } })).toEqual({ reportUri: "/r" });
  });
});

describe("buildCspHeaders", () => {
  test("a page with no inline scripts gets a policy of pure keywords", () => {
    expect(policy("<p>hi</p>")).toBe(
      "base-uri 'self'; default-src 'self'; font-src 'self'; form-action 'self'; " +
        "frame-ancestors 'self'; frame-src 'self'; img-src 'self' data:; object-src 'none'; " +
        "script-src 'self'; style-src 'self' 'unsafe-inline'",
    );
  });

  test("inline script hashes land in script-src", () => {
    expect(policy("<script>alert(1)</script>")).toContain(
      `script-src 'self' ${hashOf("alert(1)")}`,
    );
  });

  /*
   * `style-src` keeps `'unsafe-inline'` and no hashes, deliberately. The two cancel — a browser
   * ignores the keyword once a hash is present — so adding a partial set of style hashes would
   * turn a working page into a blank one.
   */
  test("style-src carries unsafe-inline and never a hash", () => {
    const value = policy("<style>p{color:red}</style>");
    expect(value).toContain("style-src 'self' 'unsafe-inline'");
    expect(/style-src[^;]*sha256/.test(value)).toBe(false);
  });

  test("frame-ancestors matches the X-Frame-Options emitted beside it", () => {
    expect(policy("<p>hi</p>")).toContain("frame-ancestors 'self'");
  });

  test("report-only changes the header name, not the policy", () => {
    const headers = buildCspHeaders(emptyCspSources(), { mode: "report-only" });
    expect(Object.keys(headers)).toEqual(["Content-Security-Policy-Report-Only"]);
  });

  // `report-to` names a group that only `Reporting-Endpoints` can define, so the two ship together
  // — and `report-uri`, deprecated in CSP3, is still the only one some browsers implement.
  test("reporting emits report-to, report-uri and the endpoint definition", () => {
    const headers = buildCspHeaders(emptyCspSources(), { reportUri: "https://r.example/csp" });
    expect(headers["Content-Security-Policy"]).toContain("report-to csp-endpoint");
    expect(headers["Content-Security-Policy"]).toContain("report-uri https://r.example/csp");
    expect(headers["Reporting-Endpoints"]).toBe('csp-endpoint="https://r.example/csp"');
  });

  test("a directive override replaces, and false removes", () => {
    const value =
      buildCspHeaders(emptyCspSources(), {
        directives: { "connect-src": "'self' https://api.example", "frame-src": false },
      })["Content-Security-Policy"] ?? "";
    expect(value).toContain("connect-src 'self' https://api.example");
    expect(value).not.toContain("frame-src");
  });

  test("collected origins reach their directives", () => {
    const value = policy(
      '<script src="https://plausible.io/x.js"></script>' +
        '<link rel="stylesheet" href="https://fonts.googleapis.com/c">',
    );
    expect(value).toContain("script-src 'self' https://plausible.io");
    expect(value).toContain("style-src 'self' 'unsafe-inline' https://fonts.googleapis.com");
  });
});
