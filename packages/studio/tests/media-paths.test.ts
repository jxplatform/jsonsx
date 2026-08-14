/**
 * The three names one media file has, and the query keys that follow from them.
 *
 * The assertion this file exists for is `authoredRefTargets("public/hero.jpg")` containing
 * `"hero.jpg"`. Without it a usage query about a public image asks about a path no document ever
 * resolves to, gets zero, and a delete confirmation calls a seven-page image unused.
 */

import "./with-dom.js";
import { beforeEach, describe, expect, test } from "bun:test";
import { resetStudioState } from "./harness";
import {
  authoredRefTargets,
  baseName,
  dirName,
  mediaSiteUrl,
  normalizeProjectPath,
} from "../src/files/media-paths";

/** A project whose `blog` collection is sourced from a directory that is not its mount prefix. */
function withCollections(content: Record<string, { source: string }>): void {
  resetStudioState({ projectConfig: { content } });
}

beforeEach(() => {
  resetStudioState();
});

describe("normalizeProjectPath", () => {
  test("settles on one spelling", () => {
    expect(normalizeProjectPath("./public/hero.jpg")).toBe("public/hero.jpg");
    expect(normalizeProjectPath("/public/hero.jpg")).toBe("public/hero.jpg");
    expect(normalizeProjectPath(String.raw`public\images\hero.jpg`)).toBe("public/images/hero.jpg");
    expect(normalizeProjectPath("public/images/")).toBe("public/images");
    expect(normalizeProjectPath("")).toBe("");
  });
});

describe("baseName / dirName", () => {
  test("split a nested path", () => {
    expect(baseName("content/blog/images/hero.png")).toBe("hero.png");
    expect(dirName("content/blog/images/hero.png")).toBe("content/blog/images");
  });

  test("a root-level file has no directory but still has a name", () => {
    expect(baseName("favicon.ico")).toBe("favicon.ico");
    expect(dirName("favicon.ico")).toBe(".");
  });
});

describe("mediaSiteUrl", () => {
  test("public/ is served from the site root", () => {
    expect(mediaSiteUrl("public/hero.jpg")).toBe("/hero.jpg");
    expect(mediaSiteUrl("public/img/deep/hero.jpg")).toBe("/img/deep/hero.jpg");
  });

  test("anything else is served from its own path", () => {
    expect(mediaSiteUrl("assets/logo.svg")).toBe("/assets/logo.svg");
  });

  test("a content asset is served from its collection's mount", () => {
    withCollections({ blog: { source: "posts" } });
    expect(mediaSiteUrl("posts/images/hero.png")).toBe("/content/blog/images/hero.png");
  });

  test("the conventional content layout maps onto itself", () => {
    withCollections({ blog: { source: "content/blog" } });
    expect(mediaSiteUrl("content/blog/images/hero.png")).toBe("/content/blog/images/hero.png");
  });
});

describe("authoredRefTargets", () => {
  test("a public image is ALSO asked about under its served path", () => {
    // The whole point: `/hero.jpg` in a document resolves to `hero.jpg`, never `public/hero.jpg`.
    expect(authoredRefTargets("public/hero.jpg")).toEqual(["public/hero.jpg", "hero.jpg"]);
  });

  test("an ordinary file is asked about once", () => {
    expect(authoredRefTargets("assets/logo.svg")).toEqual(["assets/logo.svg"]);
  });

  test("a content asset whose source is its mount is not asked about twice", () => {
    withCollections({ blog: { source: "content/blog" } });
    expect(authoredRefTargets("content/blog/images/hero.png")).toEqual([
      "content/blog/images/hero.png",
    ]);
  });

  test("a remapped collection adds its mount path", () => {
    withCollections({ blog: { source: "posts" } });
    expect(authoredRefTargets("posts/images/hero.png")).toEqual([
      "posts/images/hero.png",
      "content/blog/images/hero.png",
    ]);
  });

  test("input spelling does not change the answer", () => {
    expect(authoredRefTargets("./public/hero.jpg")).toEqual(["public/hero.jpg", "hero.jpg"]);
  });

  test("there is no target for an empty path", () => {
    expect(authoredRefTargets("")).toEqual([]);
    expect(authoredRefTargets("./")).toEqual([]);
  });

  test("a project with no content section is not a crash", () => {
    resetStudioState({ projectConfig: {} });
    expect(authoredRefTargets("posts/images/hero.png")).toEqual(["posts/images/hero.png"]);
  });
});
