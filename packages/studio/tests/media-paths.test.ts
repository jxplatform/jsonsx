/**
 * The three names one media file has, and the URL a surface holding the FILE must build.
 *
 * The assertion this file exists for is that `mediaSiteUrl("public/hero.jpg")` is `/hero.jpg`.
 * Prefixing a file path with a slash gives `/public/hero.jpg`, a URL the site does not publish, and
 * a content-collection image needs its mount rather than its directory.
 *
 * This file also used to assert `authoredRefTargets`, which enumerated every path an authored
 * reference could resolve to so a usage query could ask about all of them. The engine resolves
 * those lanes itself now (`site-architecture.md` §9.3), so both the helper and its tests are gone —
 * `refactor-find-refs.test.ts` and `refactor-parity.test.ts` are where that behaviour is asserted,
 * against a real project rather than against string math.
 */

import "./with-dom.js";
import { beforeEach, describe, expect, test } from "bun:test";
import { installMockPlatform, resetStudioState } from "./harness";
import {
  baseName,
  dirName,
  mediaSiteUrl,
  normalizeProjectPath,
  previewFileSrc,
} from "../src/files/media-paths";

const { happyDOM } = globalThis as unknown as { happyDOM: { setURL: (u: string) => void } };

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

/**
 * The seam panel chrome loads a FILE by.
 *
 * The library grid used to build its `<img src>` by prefixing the path with a slash, so a
 * `public/hero.jpg` asked for `/public/hero.jpg` — a URL the site does not publish — and a
 * content-collection image skipped its mount entirely. Both thumbnails were simply broken; nothing
 * reported it, because a broken `<img>` in a grid of tiles looks like a slow one.
 */
describe("previewFileSrc", () => {
  test("a public/ file loads at the URL the site publishes it at", () => {
    expect(previewFileSrc("public/hero.jpg")).toBe("/hero.jpg");
  });

  test("a content-collection file loads through its mount", () => {
    withCollections({ blog: { source: "posts" } });
    expect(previewFileSrc("posts/images/hero.png")).toBe("/content/blog/images/hero.png");
  });

  test("anything else loads from its own path", () => {
    expect(previewFileSrc("assets/logo.svg")).toBe("/assets/logo.svg");
  });

  test("an empty path is returned as given, not as a lone slash", () => {
    expect(previewFileSrc("")).toBe("");
  });

  /* In repo space nothing answers a site URL, so the site URL is the wrong question entirely — the
     host serves the FILE, at its own path, under the declared base. A library thumbnail on a
     multi-tenant editor origin is exactly this case, and asking for `/hero.jpg` there gets the
     application shell at HTTP 200. */
  test("in repo space it addresses the file itself, under the host's base", () => {
    // `documentBase` resolves a root-relative base against the CANVAS origin, so the host needs
    // One — a relative base would throw rather than resolve, which fails the whole canvas mount.
    happyDOM.setURL("https://studio.example.com/");
    installMockPlatform({
      assetSpace: "repo",
      canvasUrl: "https://studio.example.com/canvas.html",
      documentBaseUrl: "https://studio.example.com/p/o/r/main/raw/",
    } as never);
    expect(previewFileSrc("public/hero.jpg")).toBe(
      "https://studio.example.com/p/o/r/main/raw/public/hero.jpg",
    );
    // The file path, not the site URL: `public/` is NOT stripped, because nothing serves it there.
    expect(previewFileSrc("content/posts/images/my photo.png")).toBe(
      "https://studio.example.com/p/o/r/main/raw/content/posts/images/my%20photo.png",
    );
  });
});
