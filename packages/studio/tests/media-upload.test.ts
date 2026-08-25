/**
 * Media-upload core: file classification, destination resolution, collision-free naming, and the
 * uploadAssets orchestration every upload surface funnels through.
 *
 * The pure helpers carry most of the coverage; uploadAssets is exercised against the harness's
 * in-memory platform, asserting the ordered `state.calls` log (the only place the destination path
 * and the payload identity are both observable).
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { installMockPlatform, resetStudioState, resetWorkspaceWithTab, testFile } from "./harness";
import {
  assetRef,
  extensionOf,
  isImage,
  isMediaFile,
  joinDir,
  mediaKind,
  setMediaChangedHandler,
  uniqueName,
  uploadAccept,
  uploadAssets,
  uploadDirFor,
} from "../src/files/media-upload";
import { closeAllTabs } from "../src/workspace/workspace";

beforeEach(() => {
  resetStudioState();
  closeAllTabs();
  setMediaChangedHandler(null);
});

afterEach(() => {
  setMediaChangedHandler(null);
});

// ─── Classification ──────────────────────────────────────────────────────────

describe("extensionOf", () => {
  test("lowercases, keeps the dot, and ignores dotfiles and extensionless names", () => {
    expect(extensionOf("hero.PNG")).toBe(".png");
    expect(extensionOf("a.tar.gz")).toBe(".gz");
    expect(extensionOf("README")).toBe("");
    // A leading dot is index 0, not > 0 — ".gitignore" is a name, not an extension.
    expect(extensionOf(".gitignore")).toBe("");
  });
});

describe("isImage / isMediaFile", () => {
  test("isImage accepts an extension with or without the dot, case-insensitively", () => {
    expect(isImage(".png")).toBe(true);
    expect(isImage("PNG")).toBe(true);
    expect(isImage(".avif")).toBe(true);
    expect(isImage(".mp4")).toBe(false);
  });

  test("isMediaFile spans images, playable media, documents, and fonts", () => {
    expect(isMediaFile("a.png")).toBe(true);
    expect(isMediaFile("a.mp4")).toBe(true);
    expect(isMediaFile("a.pdf")).toBe(true);
    expect(isMediaFile("a.woff2")).toBe(true);
    expect(isMediaFile("a.ts")).toBe(false);
  });
});

describe("mediaKind", () => {
  test("prefers the MIME type", () => {
    expect(mediaKind({ name: "no-extension", type: "image/webp" })).toBe("image");
    expect(mediaKind({ name: "no-extension", type: "video/mp4" })).toBe("video");
    expect(mediaKind({ name: "no-extension", type: "audio/ogg" })).toBe("audio");
  });

  test("falls back to the extension when the MIME type is missing", () => {
    // Some Linux file managers hand over a drop with an empty `type`.
    expect(mediaKind({ name: "a.PNG" })).toBe("image");
    expect(mediaKind({ name: "a.mov", type: "" })).toBe("video");
    expect(mediaKind({ name: "a.flac", type: "" })).toBe("audio");
  });

  test("anything unrecognized is a plain file", () => {
    expect(mediaKind({ name: "spec.pdf", type: "application/pdf" })).toBe("file");
    expect(mediaKind({ name: "font.woff2" })).toBe("file");
  });
});

// ─── Destination ─────────────────────────────────────────────────────────────

describe("uploadDirFor", () => {
  test("a content-collection document co-locates its media", () => {
    expect(uploadDirFor("content/blog/hello.md")).toBe("content/blog/images");
    expect(uploadDirFor("content/blog/nested/hello.md")).toBe("content/blog/images");
    expect(uploadDirFor(String.raw`content\blog\hello.md`)).toBe("content/blog/images");
  });

  test("everything else — including a bare content/ file and no document — goes to public", () => {
    expect(uploadDirFor("pages/index.json")).toBe("public");
    expect(uploadDirFor("content/orphan.md")).toBe("public");
    expect(uploadDirFor(null)).toBe("public");
  });
});

describe("assetRef", () => {
  test("public/ is served from the site root", () => {
    expect(assetRef("public/hero.jpg")).toBe("/hero.jpg");
    expect(assetRef("public/img/hero.jpg")).toBe("/img/hero.jpg");
  });

  test("a content asset is referenced relative to the entry that owns it", () => {
    expect(assetRef("content/blog/images/hero.jpg")).toBe("./images/hero.jpg");
  });

  test("anything else is project-root relative", () => {
    expect(assetRef("assets/hero.jpg")).toBe("./assets/hero.jpg");
    expect(assetRef("hero.jpg")).toBe("./hero.jpg");
  });
});

describe("uniqueName", () => {
  test("passes an unused name through", () => {
    expect(uniqueName("hero.jpg", new Set())).toBe("hero.jpg");
  });

  test("suffixes before the extension and skips taken suffixes", () => {
    expect(uniqueName("hero.jpg", new Set(["hero.jpg"]))).toBe("hero-1.jpg");
    expect(uniqueName("hero.jpg", new Set(["hero.jpg", "hero-1.jpg"]))).toBe("hero-2.jpg");
  });

  test("an extensionless name suffixes at the end", () => {
    expect(uniqueName("LICENSE", new Set(["LICENSE"]))).toBe("LICENSE-1");
  });
});

describe("joinDir", () => {
  test("the project root contributes no prefix", () => {
    expect(joinDir(".", "a.png")).toBe("a.png");
    expect(joinDir("", "a.png")).toBe("a.png");
  });

  test("trailing slashes and backslashes normalize", () => {
    expect(joinDir("public/", "a.png")).toBe("public/a.png");
    expect(joinDir(String.raw`public\img`, "a.png")).toBe("public/img/a.png");
  });
});

// ─── uploadAssets ────────────────────────────────────────────────────────────

describe("uploadAssets", () => {
  test("an empty batch never touches the platform", async () => {
    const { state } = installMockPlatform();
    expect(await uploadAssets([])).toEqual([]);
    expect(state.calls).toEqual([]);
  });

  test("uploads to public/ and reports the site-root ref", async () => {
    const { state } = installMockPlatform();
    const file = testFile("hero.png");

    const assets = await uploadAssets([file]);

    expect(assets).toEqual([
      { kind: "image", name: "hero.png", path: "public/hero.png", ref: "/hero.png" },
    ]);
    expect(state.calls).toContainEqual(["uploadFile", "public/hero.png", file]);
  });

  test("follows the active content document to its collection images directory", async () => {
    const { state } = installMockPlatform();
    resetWorkspaceWithTab(undefined, { documentPath: "content/blog/post.md" });

    const [asset] = await uploadAssets([testFile("hero.png")]);

    expect(asset?.path).toBe("content/blog/images/hero.png");
    expect(asset?.ref).toBe("./images/hero.png");
    expect(state.calls).toContainEqual([
      "uploadFile",
      "content/blog/images/hero.png",
      expect.anything(),
    ]);
  });

  test("an explicit dir overrides the active document", async () => {
    installMockPlatform();
    resetWorkspaceWithTab(undefined, { documentPath: "content/blog/post.md" });

    const [asset] = await uploadAssets([testFile("hero.png")], { dir: "styles" });

    expect(asset?.path).toBe("styles/hero.png");
  });

  test("never overwrites: colliding names get a suffix, within the batch too", async () => {
    installMockPlatform({}, { "public/hero.png": "existing" });

    const assets = await uploadAssets([testFile("hero.png"), testFile("hero.png")]);

    expect(assets.map((a) => a.path)).toEqual(["public/hero-1.png", "public/hero-2.png"]);
  });

  test("an unlistable destination is treated as empty rather than failing", async () => {
    const { state } = installMockPlatform({
      listDirectory: () => Promise.reject(new Error("ENOENT")),
    });

    const assets = await uploadAssets([testFile("hero.png")]);

    expect(assets.map((a) => a.path)).toEqual(["public/hero.png"]);
    expect(state.calls).toContainEqual(["uploadFile", "public/hero.png", expect.anything()]);
  });

  test("one failed upload does not abandon the rest of the batch", async () => {
    let seen = 0;
    installMockPlatform({
      uploadFile: (path: string) => {
        seen += 1;
        return seen === 1 ? Promise.reject(new Error("disk full")) : Promise.resolve({ path });
      },
    });

    const assets = await uploadAssets([testFile("a.png"), testFile("b.png")]);

    expect(assets.map((a) => a.name)).toEqual(["b.png"]);
  });

  test("the media-changed handler runs once per batch, with the destination", async () => {
    installMockPlatform();
    const changed = mock(() => {});
    setMediaChangedHandler(changed);

    await uploadAssets([testFile("a.png"), testFile("b.png")]);

    expect(changed).toHaveBeenCalledTimes(1);
    expect(changed).toHaveBeenCalledWith("public");
  });

  test("a wholly failed batch skips the media-changed handler", async () => {
    installMockPlatform({ uploadFile: () => Promise.reject(new Error("nope")) });
    const changed = mock(() => {});
    setMediaChangedHandler(changed);

    expect(await uploadAssets([testFile("a.png")])).toEqual([]);
    expect(changed).not.toHaveBeenCalled();
  });
});

/**
 * What the backend ANSWERS, and what it will accept.
 *
 * The upload response used to be `Promise<unknown>` and every caller used the path it had ASKED
 * for. A backend that stores the bytes anywhere else — de-duplicating by content hash, appending a
 * collision suffix, normalizing a name — therefore produced a document referencing a file that is
 * not there, with no error anywhere.
 */
describe("the backend's answer", () => {
  test("a renaming store is honoured end to end", async () => {
    installMockPlatform({
      // A content-addressed store: the name asked for is not the name written.
      uploadFile: () =>
        Promise.resolve({ path: joinDir("public", "sha256-deadbeef.png"), size: 12 }),
    });

    const [asset] = await uploadAssets([testFile("hero.png")]);

    expect(asset?.path).toBe("public/sha256-deadbeef.png");
    // And the reference written into the document names the file that exists.
    expect(asset?.ref).toBe("/sha256-deadbeef.png");
  });

  test("a backend that reports nothing keeps the requested path", async () => {
    installMockPlatform({ uploadFile: (path: string) => Promise.resolve({ path }) });
    const [asset] = await uploadAssets([testFile("hero.png")]);
    expect(asset?.path).toBe("public/hero.png");
  });
});

describe("assetCapabilities", () => {
  /* A DECLARED limit only. Studio must not invent one — a limit it made up is a file the user
     cannot upload for no reason anyone can name. */
  test("with no declared limit, size is never checked", async () => {
    const { state } = installMockPlatform();
    const big = testFile("huge.png");
    Object.defineProperty(big, "size", { value: 999_999_999 });
    const assets = await uploadAssets([big]);
    expect(assets).toHaveLength(1);
    expect(state.calls).toContainEqual(["uploadFile", "public/huge.png", big]);
  });

  test("an oversized file is refused before the round trip, naming the limit", async () => {
    const { state } = installMockPlatform({
      assetCapabilities: { maxUploadBytes: 1024 },
    } as never);
    const big = testFile("huge.png");
    Object.defineProperty(big, "size", { value: 4096 });

    expect(await uploadAssets([big])).toEqual([]);
    // Never sent: the point of a declared limit is that the client does not spend the request.
    expect(state.calls.filter(([call]) => call === "uploadFile")).toEqual([]);
  });

  test("the rest of the batch still lands", async () => {
    installMockPlatform({ assetCapabilities: { maxUploadBytes: 1024 } } as never);
    const big = testFile("huge.png");
    Object.defineProperty(big, "size", { value: 4096 });

    const assets = await uploadAssets([big, testFile("small.png")]);

    expect(assets.map((a) => a.name)).toEqual(["small.png"]);
  });

  test("a declared accept narrows the picker; absent, Studio's own default stands", () => {
    installMockPlatform();
    expect(uploadAccept()).toContain("image/*");
    installMockPlatform({ assetCapabilities: { accept: "image/png" } } as never);
    expect(uploadAccept()).toBe("image/png");
  });
});
