/**
 * Content-relative asset resolution for the canvas — the mapping that makes a content entry's
 * `./images/hero.png` preview at the URL the built site serves (`/content/<type>/images/hero.png`)
 * instead of resolving against `canvas.html`.
 *
 * The rules mirror `rewriteEntryAssets` in extensions/parser/src/content-loader.ts; the cases below
 * are written against the CONTRACT (relative + inside the collection → mounted; everything else
 * untouched) so a divergence between the two shows up here.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { resetStudioState, resetWorkspaceWithTab } from "./harness";
import { closeAllTabs } from "../src/workspace/workspace";
import {
  contentMountFor,
  dirOf,
  mountedRefFor,
  previewAssetSrc,
  resolveRelativePath,
  rewriteContentAssets,
} from "../src/canvas/content-assets";
import type { JxMutableNode } from "@jxsuite/schema/types";

const POSTS = { posts: { format: "Markdown", source: "./content/posts/" } };
const MOUNT = { dir: "content/posts", urlPrefix: "/content/posts" };

beforeEach(() => {
  resetStudioState();
  closeAllTabs();
});

// ─── Path math ───────────────────────────────────────────────────────────────

describe("resolveRelativePath", () => {
  test("resolves ./ and bare segments against the directory", () => {
    expect(resolveRelativePath("content/posts", "./images/a.png")).toBe(
      "content/posts/images/a.png",
    );
    expect(resolveRelativePath("content/posts", "images/a.png")).toBe("content/posts/images/a.png");
  });

  test("walks .. and collapses redundant segments", () => {
    expect(resolveRelativePath("content/posts/nested", "../images/a.png")).toBe(
      "content/posts/images/a.png",
    );
    expect(resolveRelativePath("content/posts", "./././images//a.png")).toBe(
      "content/posts/images/a.png",
    );
  });

  test("a root-level directory still resolves", () => {
    expect(resolveRelativePath("", "a.png")).toBe("a.png");
    expect(resolveRelativePath(".", "a.png")).toBe("a.png");
  });

  test("climbing above the project root is refused — it can never name a mounted file", () => {
    expect(resolveRelativePath("content/posts", "../../../outside.png")).toBeNull();
    expect(resolveRelativePath("", "../outside.png")).toBeNull();
  });

  test("backslashes normalize to forward slashes", () => {
    expect(resolveRelativePath(String.raw`content\posts`, String.raw`.\images\a.png`)).toBe(
      "content/posts/images/a.png",
    );
  });
});

describe("dirOf", () => {
  test("returns the directory, or empty for a root-level file", () => {
    expect(dirOf("content/posts/hello.md")).toBe("content/posts");
    expect(dirOf("hello.md")).toBe("");
  });
});

// ─── Mount lookup ────────────────────────────────────────────────────────────

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

describe("rewriteContentAssets", () => {
  const doc = (): JxMutableNode =>
    ({
      children: [
        { attributes: { alt: "", src: "./images/hero.png" }, tagName: "img" },
        { children: ["untouched"], tagName: "p" },
        { attributes: { poster: "./images/thumb.png", src: "/movie.mp4" }, tagName: "video" },
      ],
      tagName: "div",
    }) as unknown as JxMutableNode;

  test("maps src and poster, in attributes and as top-level keys", () => {
    const source = doc();
    (source.children as JxMutableNode[]).push({
      src: "./images/top-level.png",
      tagName: "source",
    } as unknown as JxMutableNode);

    const out = rewriteContentAssets(source, "content/posts/hello.md", POSTS);
    const kids = out.children as Record<string, any>[];

    expect(kids[0]!.attributes.src).toBe("/content/posts/images/hero.png");
    expect(kids[2]!.attributes.poster).toBe("/content/posts/images/thumb.png");
    // A root-absolute src is already meaningful and stays put.
    expect(kids[2]!.attributes.src).toBe("/movie.mp4");
    expect(kids[3]!.src).toBe("/content/posts/images/top-level.png");
  });

  test("the SOURCE document is never mutated — it is what gets serialized back to disk", () => {
    const source = doc();
    const before = structuredClone(source);
    rewriteContentAssets(source, "content/posts/hello.md", POSTS);
    expect(source).toEqual(before);
  });

  test("untouched subtrees keep their identity (pure rebuild, not a deep clone)", () => {
    const source = doc();
    const [, untouched] = source.children as JxMutableNode[];
    const out = rewriteContentAssets(source, "content/posts/hello.md", POSTS);

    expect(out).not.toBe(source); // The path to a rewritten node is rebuilt…
    const [, stillShared] = out.children as JxMutableNode[];
    expect(stillShared).toBe(untouched); // …but siblings are shared.
  });

  test("a document with nothing to rewrite is returned as-is", () => {
    const clean = {
      children: [{ children: ["hi"], tagName: "p" }],
      tagName: "div",
    } as JxMutableNode;
    expect(rewriteContentAssets(clean, "content/posts/hello.md", POSTS)).toBe(clean);
  });

  test("a non-content document is returned as-is", () => {
    const source = doc();
    expect(rewriteContentAssets(source, "pages/index.json", POSTS)).toBe(source);
  });

  test("nested children are reached", () => {
    const nested = {
      children: [
        {
          children: [{ attributes: { src: "./images/deep.png" }, tagName: "img" }],
          tagName: "figure",
        },
      ],
      tagName: "div",
    } as unknown as JxMutableNode;

    const out = rewriteContentAssets(nested, "content/posts/hello.md", POSTS);
    const [figure] = out.children as any[];
    const [img] = figure.children;
    expect(img.attributes.src).toBe("/content/posts/images/deep.png");
  });

  test("a nested entry resolves against its OWN directory", () => {
    const nested = {
      children: [{ attributes: { src: "./images/a.png" }, tagName: "img" }],
      tagName: "div",
    } as unknown as JxMutableNode;

    const out = rewriteContentAssets(nested, "content/posts/2026/hello.md", POSTS);
    const [img] = out.children as any[];
    expect(img.attributes.src).toBe("/content/posts/2026/images/a.png");
  });
});

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
