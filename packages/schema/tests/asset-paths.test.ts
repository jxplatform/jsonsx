import { describe, expect, test } from "bun:test";
import {
  assetUrlFor,
  collectAssetUrls,
  isNpmSpecifier,
  normalizeAssetPrefix,
  NPM_SPECIFIER_PREFIX,
  resolveAssetUrl,
  SIDECAR_ASSET_DIR,
  sidecarAssetPath,
} from "../src/asset-paths.ts";
import type { AssetMount } from "../src/asset-paths.ts";

describe("isNpmSpecifier", () => {
  test("true for npm: specifiers", () => {
    expect(isNpmSpecifier("npm:@jxsuite/search/client")).toBe(true);
    expect(isNpmSpecifier(`${NPM_SPECIFIER_PREFIX}minisearch`)).toBe(true);
  });

  test("false for relative specifiers", () => {
    expect(isNpmSpecifier("./counter.js")).toBe(false);
    expect(isNpmSpecifier("../lib/util.ts")).toBe(false);
  });
});

describe("sidecarAssetPath", () => {
  test("scoped npm package with subpath", () => {
    expect(sidecarAssetPath("npm:@jxsuite/search/client")).toBe("/assets/jxsuite-search-client.js");
  });

  test("unscoped npm package", () => {
    expect(sidecarAssetPath("npm:minisearch")).toBe("/assets/minisearch.js");
  });

  test("relative project file drops extension and ./ prefix", () => {
    expect(sidecarAssetPath("./lib/search-helpers.ts")).toBe("/assets/lib-search-helpers.js");
    expect(sidecarAssetPath("./counter.js")).toBe("/assets/counter.js");
  });

  test("deterministic: same specifier, same path", () => {
    expect(sidecarAssetPath("npm:@myorg/validators")).toBe(
      sidecarAssetPath("npm:@myorg/validators"),
    );
  });

  test("output always lands under the asset dir with a .js extension", () => {
    for (const spec of ["npm:@a/b/c", "./x/y/z.ts", "npm:left-pad", "./a.mjs"]) {
      const out = sidecarAssetPath(spec);
      expect(out.startsWith(SIDECAR_ASSET_DIR)).toBe(true);
      expect(out.endsWith(".js")).toBe(true);
      expect(out).not.toContain("/../");
    }
  });

  test("sanitizes unexpected characters into hyphens", () => {
    expect(sidecarAssetPath("npm:weird pkg!name")).toBe("/assets/weird-pkg-name.js");
  });
});

describe("asset mounts", () => {
  const docs: AssetMount = { dir: "/repo/docs", urlPrefix: "/content/docs" };
  const blog: AssetMount = { dir: "/repo/docs/blog", urlPrefix: "/content/blog" };
  const mounts = [docs, blog];

  describe("normalizeAssetPrefix", () => {
    test("adds a leading slash and drops a trailing one", () => {
      expect(normalizeAssetPrefix("content/docs/")).toBe("/content/docs");
      expect(normalizeAssetPrefix("/content/docs")).toBe("/content/docs");
    });
  });

  describe("assetUrlFor", () => {
    test("maps a contained file to its mounted URL", () => {
      expect(assetUrlFor(mounts, "/repo/docs/images/hero.png")).toBe(
        "/content/docs/images/hero.png",
      );
    });

    test("the most specific mount wins", () => {
      expect(assetUrlFor(mounts, "/repo/docs/blog/a.png")).toBe("/content/blog/a.png");
    });

    test("percent-encodes path segments", () => {
      expect(assetUrlFor([docs], "/repo/docs/images/my shot.png")).toBe(
        "/content/docs/images/my%20shot.png",
      );
    });

    test("normalizes windows separators", () => {
      expect(
        assetUrlFor(
          [{ dir: String.raw`C:\repo\docs`, urlPrefix: "/content/docs" }],
          String.raw`C:\repo\docs\a.png`,
        ),
      ).toBe("/content/docs/a.png");
    });

    test("null for files outside every mount, and for the mount dir itself", () => {
      expect(assetUrlFor(mounts, "/repo/elsewhere/hero.png")).toBeNull();
      expect(assetUrlFor(mounts, "/repo/docs")).toBeNull();
      expect(assetUrlFor([], "/repo/docs/a.png")).toBeNull();
    });
  });

  describe("resolveAssetUrl", () => {
    test("maps a mounted URL back to its file", () => {
      expect(resolveAssetUrl(mounts, "/content/docs/images/hero.png")).toBe(
        "/repo/docs/images/hero.png",
      );
    });

    test("round-trips an encoded segment", () => {
      const url = assetUrlFor([docs], "/repo/docs/my shot.png")!;
      expect(resolveAssetUrl([docs], url)).toBe("/repo/docs/my shot.png");
    });

    test("drops query and hash", () => {
      expect(resolveAssetUrl([docs], "/content/docs/a.png?v=2#frag")).toBe("/repo/docs/a.png");
    });

    test("refuses traversal, double-encoded traversal, and empty segments", () => {
      expect(resolveAssetUrl([docs], "/content/docs/../../etc/passwd")).toBeNull();
      expect(resolveAssetUrl([docs], "/content/docs/%252e%252e/secret")).toBeNull();
      expect(resolveAssetUrl([docs], "/content/docs//a.png")).toBeNull();
      expect(resolveAssetUrl([docs], "/content/docs/%E0%A4%A")).toBeNull();
    });

    test("null for unmounted or relative URLs", () => {
      expect(resolveAssetUrl(mounts, "/public/hero.png")).toBeNull();
      expect(resolveAssetUrl(mounts, "content/docs/a.png")).toBeNull();
      expect(resolveAssetUrl(mounts, "/content/docs")).toBeNull();
    });
  });

  describe("collectAssetUrls", () => {
    test("finds refs in attributes, srcsets, and css url()", () => {
      const html = `<img src="/content/docs/images/a.png" srcset="/content/docs/images/b.png 2x">
        <style>.x{background:url(/content/blog/c.png)}</style>`;
      expect(collectAssetUrls(html, mounts).toSorted()).toEqual([
        "/content/blog/c.png",
        "/content/docs/images/a.png",
        "/content/docs/images/b.png",
      ]);
    });

    test("deduplicates and strips query/hash", () => {
      const html = `<img src="/content/docs/a.png?v=1"><img src="/content/docs/a.png">`;
      expect(collectAssetUrls(html, mounts)).toEqual(["/content/docs/a.png"]);
    });

    test("ignores unmounted paths", () => {
      expect(collectAssetUrls(`<img src="/images/a.png">`, mounts)).toEqual([]);
    });

    test("ignores a directory mention, which names no file", () => {
      const prose = `<p>Screenshots are published under /content/docs/images/ at build time.</p>`;
      expect(collectAssetUrls(prose, mounts)).toEqual([]);
    });
  });
});
