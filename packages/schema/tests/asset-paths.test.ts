import { describe, expect, test } from "bun:test";
import {
  ASSET_KEYS,
  assetUrlFor,
  BUILD_LANES,
  collectAssetUrls,
  DEV_SERVER_LANES,
  dirOfPath,
  encodeProjectPath,
  formatSrcset,
  isNonRelativeRef,
  isNpmSpecifier,
  joinProjectPath,
  normalizeAssetPrefix,
  normalizeProjectPath,
  npmAssetPath,
  NPM_SPECIFIER_PREFIX,
  parseSrcset,
  projectPathForRef,
  projectPathsForSiteUrl,
  PUBLIC_DIR,
  resolveAssetUrl,
  SIDECAR_ASSET_DIR,
  sidecarAssetPath,
  siteUrlForPath,
  splitRefSuffix,
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

describe("npmAssetPath", () => {
  test("keeps the extension, because the file is copied rather than bundled", () => {
    expect(npmAssetPath("@shoelace-style/shoelace/dist/themes/light.css")).toBe(
      "/assets/shoelace-style-shoelace-dist-themes-light.css",
    );
    expect(npmAssetPath("normalize.css/normalize.css")).toBe("/assets/normalize.css-normalize.css");
  });

  test("an extensionless specifier stays extensionless", () => {
    expect(npmAssetPath("@vue/reactivity")).toBe("/assets/vue-reactivity");
  });

  test("deterministic, and always under the asset dir", () => {
    for (const spec of ["@a/b/c.woff2", "pkg/x.js", "@scope/pkg"]) {
      expect(npmAssetPath(spec)).toBe(npmAssetPath(spec));
      expect(npmAssetPath(spec).startsWith(SIDECAR_ASSET_DIR)).toBe(true);
      expect(npmAssetPath(spec)).not.toContain("/../");
    }
  });

  test("sanitizes unexpected characters into hyphens", () => {
    expect(npmAssetPath("weird pkg!/a b.css")).toBe("/assets/weird-pkg-a-b.css");
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

// ─── Project paths ↔ site URLs ───────────────────────────────────────────────

/** A content collection published at its own mount, the shape Studio builds from project.json. */
const POSTS: AssetMount[] = [{ dir: "content/posts", urlPrefix: "/content/posts" }];

describe("splitRefSuffix", () => {
  test("keeps the query and hash off the path", () => {
    expect(splitRefSuffix("./hero.png?v=2")).toEqual({ path: "./hero.png", suffix: "?v=2" });
    expect(splitRefSuffix("./doc.pdf#page=3")).toEqual({ path: "./doc.pdf", suffix: "#page=3" });
    expect(splitRefSuffix("a.png?a=1#b")).toEqual({ path: "a.png", suffix: "?a=1#b" });
  });

  test("a hash before a question mark still splits at the hash", () => {
    expect(splitRefSuffix("a.png#x?y")).toEqual({ path: "a.png", suffix: "#x?y" });
  });

  test("no suffix at all", () => {
    expect(splitRefSuffix("a.png")).toEqual({ path: "a.png", suffix: "" });
    expect(splitRefSuffix("")).toEqual({ path: "", suffix: "" });
  });
});

describe("isNonRelativeRef", () => {
  test("names everything that is not a document-relative file", () => {
    for (const value of [
      "",
      "/hero.png",
      "#anchor",
      "${state.hero}",
      "https://cdn.example.com/a.png",
      "data:image/png;base64,AA==",
      "views://studio/a.png",
    ]) {
      expect(isNonRelativeRef(value)).toBe(true);
    }
  });

  test("a document-relative file is relative, with or without the ./", () => {
    expect(isNonRelativeRef("./images/a.png")).toBe(false);
    expect(isNonRelativeRef("images/a.png")).toBe(false);
    expect(isNonRelativeRef("../a.png")).toBe(false);
  });
});

describe("normalizeProjectPath / dirOfPath", () => {
  test("one spelling out of every spelling", () => {
    expect(normalizeProjectPath(String.raw`.\content\posts\a.md`)).toBe("content/posts/a.md");
    expect(normalizeProjectPath("/content/posts/")).toBe("content/posts");
    expect(normalizeProjectPath("")).toBe("");
  });

  test("the directory of a path, and the root's empty one", () => {
    expect(dirOfPath("content/posts/hello.md")).toBe("content/posts");
    expect(dirOfPath("hello.md")).toBe("");
    expect(dirOfPath("./content/posts/hello.md")).toBe("content/posts");
  });
});

describe("joinProjectPath", () => {
  test("resolves against the directory, collapsing . and //", () => {
    expect(joinProjectPath("content/posts", "./images/a.png")).toBe("content/posts/images/a.png");
    expect(joinProjectPath("content/posts", "images/a.png")).toBe("content/posts/images/a.png");
    expect(joinProjectPath("content/posts", "./././images//a.png")).toBe(
      "content/posts/images/a.png",
    );
  });

  test("climbs, and refuses to climb out of the project", () => {
    expect(joinProjectPath("content/posts/2026", "../images/a.png")).toBe(
      "content/posts/images/a.png",
    );
    expect(joinProjectPath("content/posts", "../../../outside.png")).toBeNull();
    expect(joinProjectPath("", "../outside.png")).toBeNull();
  });

  test("the project root as a directory", () => {
    expect(joinProjectPath("", "a.png")).toBe("a.png");
    expect(joinProjectPath(".", "a.png")).toBe("a.png");
  });
});

/**
 * The divergence, stated as a fact the suite owns.
 *
 * The compiler resolves `/x` to `public/x` and nowhere else; the editing servers try the project
 * root FIRST and `public/` only after. So a file at `<root>/hero.jpg` loads at `/hero.jpg` in a
 * preview and 404s on the deployed site — a preview that lies, in the one direction that matters.
 * Converging them is a deliberate, breaking change; until it lands, this test is what stops anyone
 * assuming the two are the same list.
 */
describe("the resolution lanes", () => {
  test("BUILD_LANES and DEV_SERVER_LANES are NOT the same", () => {
    expect(DEV_SERVER_LANES).not.toEqual(BUILD_LANES);
    expect(BUILD_LANES).toEqual(["mounts", "public"]);
    expect(DEV_SERVER_LANES).toEqual(["mounts", "root", "public"]);
  });

  test("and the difference is exactly the root lane", () => {
    expect(DEV_SERVER_LANES.filter((lane) => !BUILD_LANES.includes(lane))).toEqual(["root"]);
  });
});

describe("siteUrlForPath", () => {
  test("public/ publishes at the site root in a build", () => {
    expect(siteUrlForPath("public/hero.jpg", [], BUILD_LANES)).toBe("/hero.jpg");
    expect(siteUrlForPath("public/img/hero.jpg", [], BUILD_LANES)).toBe("/img/hero.jpg");
  });

  test("a build publishes nothing else from the project root", () => {
    expect(siteUrlForPath("hero.jpg", [], BUILD_LANES)).toBeNull();
    expect(siteUrlForPath("content/posts/images/a.png", [], BUILD_LANES)).toBeNull();
  });

  test("a mount wins over both, in either lane order", () => {
    expect(siteUrlForPath("content/posts/images/a.png", POSTS, BUILD_LANES)).toBe(
      "/content/posts/images/a.png",
    );
    expect(siteUrlForPath("content/posts/images/a.png", POSTS, DEV_SERVER_LANES)).toBe(
      "/content/posts/images/a.png",
    );
  });

  test("the dev server answers every project path, because its root lane does", () => {
    expect(siteUrlForPath("hero.jpg", [], DEV_SERVER_LANES)).toBe("/hero.jpg");
    // The root lane is tried FIRST there, so this is the URL the server actually resolves.
    expect(siteUrlForPath("public/hero.jpg", [], DEV_SERVER_LANES)).toBe("/public/hero.jpg");
  });

  test("segments are percent-encoded so the URL survives an attribute", () => {
    expect(siteUrlForPath("public/my photo.png", [], BUILD_LANES)).toBe("/my%20photo.png");
  });

  test("nothing publishes nothing", () => {
    expect(siteUrlForPath("", [], DEV_SERVER_LANES)).toBeNull();
    expect(siteUrlForPath("public", [], BUILD_LANES)).toBe("/");
  });
});

describe("projectPathsForSiteUrl", () => {
  test("the build has one answer; the dev server has two, in the order it tries them", () => {
    expect(projectPathsForSiteUrl("/hero.jpg", [], BUILD_LANES)).toEqual(["public/hero.jpg"]);
    expect(projectPathsForSiteUrl("/hero.jpg", [], DEV_SERVER_LANES)).toEqual([
      "hero.jpg",
      "public/hero.jpg",
    ]);
  });

  test("a mounted URL resolves to the real repo path under it", () => {
    expect(projectPathsForSiteUrl("/content/posts/images/a.png", POSTS, BUILD_LANES)[0]).toBe(
      "content/posts/images/a.png",
    );
  });

  /* A mount whose directory sits OUTSIDE the project root — `content.docs.source = "../../docs"` —
     names files no project-relative path can reach, so it contributes no candidate at all. */
  test("a mount outside the project contributes nothing", () => {
    const outside: AssetMount[] = [{ dir: "/srv/docs", urlPrefix: "/content/docs" }];
    expect(projectPathsForSiteUrl("/content/docs/a.png", outside, BUILD_LANES)).toEqual([
      "public/content/docs/a.png",
    ]);
  });

  test("a Windows-absolute mount is outside the project too", () => {
    const winMount: AssetMount[] = [{ dir: String.raw`C:\srv\docs`, urlPrefix: "/content/docs" }];
    expect(projectPathsForSiteUrl("/content/docs/a.png", winMount, BUILD_LANES)).toEqual([
      "public/content/docs/a.png",
    ]);
  });

  test("query and hash are not part of the path", () => {
    expect(projectPathsForSiteUrl("/hero.jpg?v=2#x", [], BUILD_LANES)).toEqual(["public/hero.jpg"]);
  });

  test("refuses anything that is not a rooted, traversal-free URL", () => {
    for (const url of [
      "hero.jpg",
      "https://cdn.example.com/a.png",
      "/",
      "/../etc/passwd",
      "/a/./b.png",
      "/%2e%2e/secret.png",
      "/%E0%A4%A.png",
    ]) {
      expect(projectPathsForSiteUrl(url, POSTS, DEV_SERVER_LANES)).toEqual([]);
    }
  });

  test("percent-encoded segments decode to the real filename", () => {
    expect(projectPathsForSiteUrl("/my%20photo.png", [], BUILD_LANES)).toEqual([
      "public/my photo.png",
    ]);
  });

  test("duplicate candidates collapse", () => {
    // A mount rooted at the project root makes the mount lane and the root lane agree.
    const rootMount: AssetMount[] = [{ dir: "assets", urlPrefix: "/assets" }];
    expect(projectPathsForSiteUrl("/assets/a.png", rootMount, DEV_SERVER_LANES)).toEqual([
      "assets/a.png",
      "public/assets/a.png",
    ]);
  });
});

/**
 * The round trip, as a property.
 *
 * Whenever a project path publishes at all, the URL it publishes at must name it back — FIRST, not
 * merely somewhere in the candidate list, because a caller with no filesystem takes the first.
 */
describe("siteUrlForPath ∘ projectPathsForSiteUrl", () => {
  const PATHS = [
    "public/hero.jpg",
    "public/img/deep/hero.jpg",
    "public/my photo.png",
    "content/posts/images/a.png",
    "content/posts/2026/images/a.png",
    "hero.jpg",
    "assets/site.css",
  ];

  for (const lanes of [BUILD_LANES, DEV_SERVER_LANES]) {
    const label = lanes === BUILD_LANES ? "BUILD_LANES" : "DEV_SERVER_LANES";
    test(`round-trips every publishable path under ${label}`, () => {
      for (const path of PATHS) {
        const url = siteUrlForPath(path, POSTS, lanes);
        if (url === null) {
          continue;
        }
        expect([path, url, projectPathsForSiteUrl(url, POSTS, lanes)[0]]).toEqual([
          path,
          url,
          path,
        ]);
      }
    });
  }
});

describe("projectPathForRef", () => {
  test("a content-relative ref resolves against its own document, with no mount detour", () => {
    expect(projectPathForRef("./images/hero.png", "content/posts", POSTS, BUILD_LANES)).toBe(
      "content/posts/images/hero.png",
    );
    // The mount is not even needed: the join already names the file.
    expect(projectPathForRef("./images/hero.png", "content/posts", [], BUILD_LANES)).toBe(
      "content/posts/images/hero.png",
    );
  });

  test("a root-relative ref is a SITE URL and takes the host's first lane", () => {
    expect(projectPathForRef("/hero.jpg", "content/posts", [], BUILD_LANES)).toBe(
      "public/hero.jpg",
    );
    expect(projectPathForRef("/hero.jpg", "content/posts", [], DEV_SERVER_LANES)).toBe("hero.jpg");
  });

  test("a mounted root-relative ref resolves through the mount", () => {
    expect(projectPathForRef("/content/posts/images/a.png", "pages", POSTS, BUILD_LANES)).toBe(
      "content/posts/images/a.png",
    );
  });

  test("names no project file, so it is left exactly as written", () => {
    for (const value of [
      "",
      "#anchor",
      "${state.hero}",
      "https://cdn.example.com/a.png",
      "data:image/png;base64,AA==",
      "?v=2",
    ]) {
      expect(projectPathForRef(value, "content/posts", POSTS, BUILD_LANES)).toBeNull();
    }
  });

  test("a ref that climbs out of the project names nothing", () => {
    expect(
      projectPathForRef("../../../outside.png", "content/posts", POSTS, BUILD_LANES),
    ).toBeNull();
  });

  test("a malformed escape names nothing rather than throwing", () => {
    expect(projectPathForRef("./%E0%A4%A.png", "content/posts", POSTS, BUILD_LANES)).toBeNull();
  });

  test("a relative ref that resolves to the root itself names nothing", () => {
    expect(projectPathForRef("./", "content", POSTS, BUILD_LANES)).toBeNull();
  });
});

describe("srcset", () => {
  test("parses candidates and their descriptors", () => {
    expect(parseSrcset("a.png 1x, b.png 2x")).toEqual([
      { descriptor: "1x", url: "a.png" },
      { descriptor: "2x", url: "b.png" },
    ]);
    expect(parseSrcset("a.png 320w,  b.png 640w ")).toEqual([
      { descriptor: "320w", url: "a.png" },
      { descriptor: "640w", url: "b.png" },
    ]);
  });

  test("a candidate with no descriptor", () => {
    expect(parseSrcset("a.png")).toEqual([{ descriptor: "", url: "a.png" }]);
    expect(parseSrcset("a.png, b.png 2x")).toEqual([
      { descriptor: "", url: "a.png" },
      { descriptor: "2x", url: "b.png" },
    ]);
  });

  /* Splitting on "," would cut this URL in half and quietly produce two broken candidates. */
  test("a URL containing commas stays one URL", () => {
    expect(parseSrcset("data:image/svg+xml;base64,AAA=,BBB 1x")).toEqual([
      { descriptor: "1x", url: "data:image/svg+xml;base64,AAA=,BBB" },
    ]);
  });

  test("empty and whitespace-only values yield nothing", () => {
    expect(parseSrcset("")).toEqual([]);
    expect(parseSrcset("   ")).toEqual([]);
    expect(parseSrcset(" , , ")).toEqual([]);
  });

  test("formats back to a canonical attribute value", () => {
    expect(
      formatSrcset([
        { descriptor: "1x", url: "a.png" },
        { descriptor: "", url: "b.png" },
      ]),
    ).toBe("a.png 1x, b.png");
    expect(formatSrcset(parseSrcset("a.png   1x,b.png 2x"))).toBe("a.png 1x, b.png 2x");
  });
});

describe("encodeProjectPath", () => {
  test("encodes each segment and leaves the separators alone", () => {
    expect(encodeProjectPath("content/my posts/a b.png")).toBe("content/my%20posts/a%20b.png");
    expect(encodeProjectPath("a.png")).toBe("a.png");
  });

  test("a `#` or `?` in a filename cannot become a fragment or a query", () => {
    expect(encodeProjectPath("public/a#b?c.png")).toBe("public/a%23b%3Fc.png");
  });
});

describe("the shared constants", () => {
  test("PUBLIC_DIR and ASSET_KEYS mirror the content loader", () => {
    expect(PUBLIC_DIR).toBe("public");
    expect(ASSET_KEYS).toEqual(["src", "poster"]);
  });
});
