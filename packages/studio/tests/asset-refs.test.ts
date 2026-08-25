/**
 * Asset resolution for the canvas.
 *
 * The `"site"` block below is a CHARACTERISATION suite, carried over from `content-assets.test.ts`
 * unchanged in what it asserts: `"site"` is what desktop and `jx dev` have always done, so every
 * one of these answers must survive the rebuild byte for byte. It is expressed against
 * `resolveAssetRef` rather than against the document walk it used to run through, because the walk
 * is gone — a walk sees only LITERAL values, and the canvas now resolves every reference at render
 * time, bound ones included. The rules mirror `rewriteEntryAssets` in
 * extensions/parser/src/content-loader.ts, and the cases are written against the CONTRACT (relative
 * + inside the collection → mounted; everything else untouched) so a divergence shows up here.
 *
 * The `"repo"` block is the new space — a host that serves PROJECT PATHS because nothing answers a
 * site URL on its origin.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { resetStudioState, resetWorkspaceWithTab } from "./harness";
import { closeAllTabs } from "../src/workspace/workspace";
import {
  assetContextFor,
  contentMountFor,
  mountedRefFor,
  previewAssetSrc,
  resolveAssetRef,
} from "../src/canvas/asset-refs";
import { BUILD_LANES } from "@jxsuite/schema/asset-paths";
import type { AssetContext } from "../src/canvas/asset-refs";

const POSTS = { posts: { format: "Markdown", source: "./content/posts/" } };
const MOUNT = { dir: "content/posts", urlPrefix: "/content/posts" };

/** The context the canvas builds for an entry in POSTS, in whichever space. */
function ctxFor(documentDir: string, over: Partial<AssetContext> = {}): AssetContext {
  return { documentDir, lanes: BUILD_LANES, mounts: [MOUNT], space: "site", ...over };
}

beforeEach(() => {
  // `assetContextFor` reads the open project's content sections, so seed them.
  resetStudioState({ projectConfig: { content: POSTS, name: "Demo" } });
  closeAllTabs();
});

// ─── Mounts ─────────────────────────────────────────────────────────────────

describe("contentMountFor", () => {
  test("maps an entry to its content type's mount", () => {
    expect(contentMountFor("content/posts/hello.md", POSTS)).toEqual(MOUNT);
    // A nested entry belongs to the same collection.
    expect(contentMountFor("content/posts/2026/hello.md", POSTS)).toEqual(MOUNT);
  });

  test("tolerates a ./-prefixed document path and a source without a trailing slash", () => {
    expect(
      contentMountFor("./content/posts/hello.md", { posts: { source: "content/posts" } }),
    ).toEqual(MOUNT);
  });

  test("a document outside every collection has no mount", () => {
    expect(contentMountFor("pages/index.json", POSTS)).toBeNull();
    // The collection directory itself is not an entry in it.
    expect(contentMountFor("content/posts", POSTS)).toBeNull();
  });

  test("no document, or no content section, has no mount", () => {
    expect(contentMountFor(null, POSTS)).toBeNull();
    expect(contentMountFor("content/posts/hello.md", null)).toBeNull();
    expect(contentMountFor("content/posts/hello.md", {})).toBeNull();
  });

  test("a single-file source is not a collection directory", () => {
    expect(
      contentMountFor("content/posts.json/x.md", { posts: { source: "./content/posts.json" } }),
    ).toBeNull();
  });

  test("an out-of-project source never matches a project-relative entry path", () => {
    // Sites/jxsuite.com does exactly this (`content.docs.source = "../../docs"`); those entries are
    // Not reachable through the project-relative file tree, so there is nothing to map.
    expect(contentMountFor("docs/start/install.md", { docs: { source: "../../docs" } })).toBeNull();
  });

  test("a type name that is not URL-safe is skipped, matching the loader's warning path", () => {
    expect(
      contentMountFor("content/my posts/hello.md", {
        "my posts": { source: "./content/my posts" },
      }),
    ).toBeNull();
  });

  test("the most specific collection wins when two nest", () => {
    const nested = {
      all: { source: "./content" },
      posts: { source: "./content/posts" },
    };
    expect(contentMountFor("content/posts/hello.md", nested)?.urlPrefix).toBe("/content/posts");
    expect(contentMountFor("content/other/hello.md", nested)?.urlPrefix).toBe("/content/all");
  });
});

// ─── Ref mapping ─────────────────────────────────────────────────────────────

describe("mountedRefFor", () => {
  test("maps a relative ref inside the collection onto the mount", () => {
    expect(mountedRefFor("./images/hero.png", "content/posts", MOUNT)).toBe(
      "/content/posts/images/hero.png",
    );
    expect(mountedRefFor("images/hero.png", "content/posts", MOUNT)).toBe(
      "/content/posts/images/hero.png",
    );
  });

  test("preserves a query or hash suffix", () => {
    expect(mountedRefFor("./images/hero.png?v=2", "content/posts", MOUNT)).toBe(
      "/content/posts/images/hero.png?v=2",
    );
    expect(mountedRefFor("./doc.pdf#page=3", "content/posts", MOUNT)).toBe(
      "/content/posts/doc.pdf#page=3",
    );
  });

  test("percent-encodes segments so the URL survives an HTML attribute", () => {
    expect(mountedRefFor("./images/my photo.png", "content/posts", MOUNT)).toBe(
      "/content/posts/images/my%20photo.png",
    );
  });

  test("leaves alone anything that already has a meaning", () => {
    for (const value of [
      "",
      "/logo.png", // Project-root absolute — public/, not collection media.
      "#anchor",
      "https://cdn.example.com/a.png",
      "data:image/png;base64,AAAA",
      "${state.hero}", // A bound template, not a path.
      "./images/${name}.png",
    ]) {
      expect(mountedRefFor(value, "content/posts", MOUNT)).toBeNull();
    }
  });

  test("a ref that escapes the collection is not the mount's to publish", () => {
    expect(mountedRefFor("../../public/logo.png", "content/posts", MOUNT)).toBeNull();
    expect(mountedRefFor("../../../outside.png", "content/posts", MOUNT)).toBeNull();
  });

  test("undecodable input is left as authored rather than throwing", () => {
    expect(mountedRefFor("./%E0%A4%A.png", "content/posts", MOUNT)).toBeNull();
  });
});

// ─── Document rewrite ────────────────────────────────────────────────────────

// ─── Parent-realm previews ───────────────────────────────────────────────────

describe("previewAssetSrc", () => {
  test("maps a content-relative value against the active entry", () => {
    resetStudioState({ projectConfig: { content: POSTS, name: "Demo" } });
    resetWorkspaceWithTab(undefined, { documentPath: "content/posts/hello.md" });
    expect(previewAssetSrc("./images/hero.png")).toBe("/content/posts/images/hero.png");
  });

  test("passes through when the active document is not a content entry", () => {
    resetStudioState({ projectConfig: { content: POSTS, name: "Demo" } });
    resetWorkspaceWithTab(undefined, { documentPath: "pages/index.json" });
    expect(previewAssetSrc("./images/hero.png")).toBe("./images/hero.png");
  });

  test("passes through an already-absolute value and an empty one", () => {
    resetStudioState({ projectConfig: { content: POSTS, name: "Demo" } });
    resetWorkspaceWithTab(undefined, { documentPath: "content/posts/hello.md" });
    expect(previewAssetSrc("/logo.png")).toBe("/logo.png");
    expect(previewAssetSrc("https://cdn.example.com/a.png")).toBe("https://cdn.example.com/a.png");
    expect(previewAssetSrc("")).toBe("");
  });

  test("passes through with no tab open", () => {
    resetStudioState({ projectConfig: { content: POSTS, name: "Demo" } });
    expect(previewAssetSrc("./images/hero.png")).toBe("./images/hero.png");
  });
});

// ─── The resolver itself ─────────────────────────────────────────────────────

/**
 * `resolveAssetRef` is the whole of the resolution — the walk above and the runtime hook the canvas
 * installs both call this and nothing else. Testing it directly is what keeps the two honest: a
 * bound `{"$ref": …}` src never reaches the walk, so the walk's tests can only ever cover half of
 * what the canvas does.
 */
describe("resolveAssetRef", () => {
  test("no context resolves nothing at all", () => {
    expect(resolveAssetRef("./images/hero.png", null)).toBeNull();
  });

  test("an empty reference resolves to nothing", () => {
    expect(resolveAssetRef("", ctxFor("content/posts"))).toBeNull();
  });

  describe("site space — the origin already answers site URLs", () => {
    test("a content-relative ref takes its collection's mount", () => {
      expect(resolveAssetRef("./images/hero.png", ctxFor("content/posts"))).toBe(
        "/content/posts/images/hero.png",
      );
    });

    /* The origin serves these correctly already, so touching them would be the bug. */
    test("a site URL is left exactly as written", () => {
      expect(resolveAssetRef("/hero.jpg", ctxFor("content/posts"))).toBeNull();
      expect(resolveAssetRef("https://cdn.example.com/a.png", ctxFor("content/posts"))).toBeNull();
    });

    test("a nested entry resolves against its OWN directory", () => {
      expect(resolveAssetRef("./images/a.png", ctxFor("content/posts/2026"))).toBe(
        "/content/posts/2026/images/a.png",
      );
    });

    test("poster and src are the same question — the KEY is the runtime's business", () => {
      // This module never sees a key: it answers about a value, and the runtime decides which
      // Attributes and properties carry one. That split is why `srcset` and `url()` came for free.
      expect(resolveAssetRef("./images/thumb.png", ctxFor("content/posts"))).toBe(
        "/content/posts/images/thumb.png",
      );
    });

    test("outside any mount, nothing resolves", () => {
      expect(resolveAssetRef("./images/hero.png", ctxFor("pages", { mounts: [] }))).toBeNull();
    });
  });

  /**
   * Repo space — nothing on the canvas origin answers a site URL, so every reference resolves to
   * the project file it names and is rebased onto the host's file base.
   *
   * The mount detour disappears here: a content entry's `./images/hero.png` IS
   * `content/posts/images/hero.png`, a real path the host already serves. That is what keeps this
   * cheap — no `public/`→root mapping on the host, no asset-mount mapping, no new route.
   */
  describe("repo space — the host serves project paths", () => {
    const repo = (documentDir: string): AssetContext =>
      ctxFor(documentDir, {
        fileBaseUrl: "https://studio.example.com/p/o/r/main/raw/",
        space: "repo",
      });

    test("a site URL resolves to the file the BUILD would publish there", () => {
      expect(resolveAssetRef("/hero.jpg", repo("pages"))).toBe(
        "https://studio.example.com/p/o/r/main/raw/public/hero.jpg",
      );
    });

    test("a content-relative ref resolves against its own entry, with no mount in between", () => {
      expect(resolveAssetRef("./images/hero.png", repo("content/posts"))).toBe(
        "https://studio.example.com/p/o/r/main/raw/content/posts/images/hero.png",
      );
      expect(resolveAssetRef("../images/a.png", repo("content/posts/2026"))).toBe(
        "https://studio.example.com/p/o/r/main/raw/content/posts/images/a.png",
      );
    });

    test("a mounted site URL resolves back through the mount", () => {
      expect(resolveAssetRef("/content/posts/images/a.png", repo("pages"))).toBe(
        "https://studio.example.com/p/o/r/main/raw/content/posts/images/a.png",
      );
    });

    test("the query and hash survive, and the path is encoded", () => {
      expect(resolveAssetRef("./images/my photo.png?v=2", repo("content/posts"))).toBe(
        "https://studio.example.com/p/o/r/main/raw/content/posts/images/my%20photo.png?v=2",
      );
      expect(resolveAssetRef("./doc.pdf#page=3", repo("content/posts"))).toBe(
        "https://studio.example.com/p/o/r/main/raw/content/posts/doc.pdf#page=3",
      );
    });

    test("a value that names no project file is left as written", () => {
      for (const value of [
        "https://cdn.example.com/a.png",
        "data:image/png;base64,AA==",
        "#anchor",
        "${state.hero}",
        "../../../outside.png",
      ]) {
        expect(resolveAssetRef(value, repo("content/posts"))).toBeNull();
      }
    });

    /* A host that declares repo space and no base has said its site URLs are wrong without saying
       what is right. Inventing an answer there would be worse than leaving the ref alone. */
    test("with NO file base, every value is untouched", () => {
      const inert = ctxFor("content/posts", { space: "repo" });
      for (const value of ["/hero.jpg", "./images/hero.png", "/content/posts/images/a.png"]) {
        expect(resolveAssetRef(value, inert)).toBeNull();
      }
    });
  });
});

describe("assetContextFor", () => {
  test("site space needs a mount to have anything to do", () => {
    expect(assetContextFor("pages/index.json")).toBeNull();
    expect(assetContextFor("content/posts/hello.md")).toMatchObject({
      documentDir: "content/posts",
      mounts: [MOUNT],
      space: "site",
    });
  });

  test("repo space always has work, mount or not", () => {
    const ctx = assetContextFor("pages/index.json", {
      fileBaseUrl: "/raw/",
      space: "repo",
    });
    expect(ctx).toMatchObject({
      documentDir: "pages",
      fileBaseUrl: "/raw/",
      mounts: [],
      space: "repo",
    });
  });

  /* With no filesystem to probe, a lane list has to collapse to ONE candidate — and the candidate
     that makes the preview agree with the deployed site is the build's, not the dev server's. */
  test("resolves site URLs the way a BUILD would", () => {
    expect(assetContextFor("content/posts/hello.md")?.lanes).toBe(BUILD_LANES);
  });
});
