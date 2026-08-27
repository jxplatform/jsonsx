/**
 * The Media viewer — the pane that SHOWS a file the studio has no document model for.
 *
 * Every fixture opens the file the way Studio opens it (`openFileInTab`), because the routing IS
 * half of what is under test: before this existed, clicking an image produced _"No format class
 * imported for public/hero.png — add one to project.json imports"_, which is not advice about a
 * PNG. A test that built the tab by hand could not have caught that, and could not catch its
 * return.
 */
import { flush, installMockPlatform, resetStudioState, surfaceOf } from "./harness";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { closeAllTabs, workspace } from "../src/workspace/workspace";
import { openFileInTab } from "../src/files/files";
import { editorKindForMode } from "../src/commands/context";
import { invalidateMediaMeta } from "../src/files/media-meta";
import { invalidateUsages } from "../src/services/references";
import {
  MEDIA_MODE,
  detachMediaPane,
  mediaPaneMounted,
  renderMediaMode,
} from "../src/media/media-pane";
import { isViewableMedia, mediaTabModes, openMediaTab } from "../src/media/media-open";
import type { Tab } from "../src/tabs/tab";
import type { StudioPlatform } from "../src/types";

const FILES = {
  "public/hero.png": "\u0089PNG\r\n\u001A\n binary-ish",
  "public/promo.mp4": "not really an mp4",
  "public/jingle.mp3": "not really an mp3",
  "public/theme.woff2": "not really a font",
  "public/spec.pdf": "%PDF-1.4",
  "public/icon.svg": '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
  "public/archive.zip": "PK",
  "pages/index.json": JSON.stringify({ tagName: "div" }),
};

function seed(overrides: Partial<StudioPlatform> = {}): void {
  resetStudioState({
    isSiteProject: true,
    name: "Demo",
    projectConfig: { name: "Demo" },
    projectRoot: "/demo",
  });
  installMockPlatform(overrides as Partial<StudioPlatform>, { ...FILES });
}

/** Open a file and draw its pane, returning the rendered root. */
async function open(path: string): Promise<{ tab: Tab; el: HTMLElement }> {
  await openFileInTab(path);
  const tab = workspace.tabs.get(path)!;
  const host = document.createElement("div");
  document.body.append(host);
  renderMediaMode(surfaceOf(host), tab);
  await flush(2);
  return { el: host, tab };
}

beforeEach(() => {
  seed();
});

afterEach(() => {
  detachMediaPane("primary");
  closeAllTabs();
  invalidateMediaMeta();
  invalidateUsages();
  document.body.replaceChildren();
});

describe("which files reach the viewer", () => {
  test("every kind Studio calls media, and nothing else", () => {
    for (const path of Object.keys(FILES)) {
      expect(isViewableMedia(path)).toBe(
        path !== "pages/index.json" && path !== "public/archive.zip",
      );
    }
  });

  test("SVG keeps a source alternate, because it is the one media format that is also text", () => {
    expect(mediaTabModes("public/icon.svg")).toEqual([MEDIA_MODE, "source"]);
    expect(mediaTabModes("public/hero.png")).toEqual([MEDIA_MODE]);
  });

  test("the mode resolves to its own editor kind, not to the canvas", () => {
    /* A mode missing from `commands/context.ts`'s map does not fail — it silently answers "canvas",
       which is how ⌘V once pasted an element node into project.json. */
    expect(editorKindForMode(MEDIA_MODE)).toBe("media");
  });
});

describe("opening one", () => {
  test("a click in the file tree opens a viewer tab, not an error", async () => {
    await openFileInTab("public/hero.png");
    const tab = workspace.tabs.get("public/hero.png");
    expect(tab).toBeTruthy();
    expect(tab!.capabilities.modes).toEqual([MEDIA_MODE]);
  });

  test("a second open reveals the same tab rather than building another", async () => {
    await openFileInTab("public/hero.png");
    const first = workspace.tabs.get("public/hero.png");
    openMediaTab("public/hero.png");
    expect(workspace.tabs.get("public/hero.png")).toBe(first!);
    expect([...workspace.tabs.keys()].filter((k) => k === "public/hero.png")).toHaveLength(1);
  });

  test("a document is still a document", async () => {
    await openFileInTab("pages/index.json");
    expect(workspace.tabs.get("pages/index.json")!.capabilities.modes).not.toContain(MEDIA_MODE);
  });
});

describe("what it draws", () => {
  test("an image, at its own size, with the file's name", async () => {
    const { el } = await open("public/hero.png");
    expect(el.querySelector("img.media-image")).toBeTruthy();
    expect(el.querySelector(".media-name")?.textContent?.trim()).toBe("hero.png");
  });

  test("a video gets controls, not an img tag", async () => {
    const { el } = await open("public/promo.mp4");
    expect(el.querySelector("video.media-video")?.hasAttribute("controls")).toBe(true);
    expect(el.querySelector("img.media-image")).toBeNull();
  });

  test("audio gets controls and no picture", async () => {
    const { el } = await open("public/jingle.mp3");
    expect(el.querySelector("audio.media-audio")?.hasAttribute("controls")).toBe(true);
    expect(el.querySelector("img.media-image")).toBeNull();
  });

  test("a font is shown by being used", async () => {
    const { el } = await open("public/theme.woff2");
    const lines = el.querySelectorAll(".media-specimen-line");
    expect(lines.length).toBeGreaterThan(1);
    expect(lines[0]!.textContent).toContain("quick brown fox");
  });

  test("a PDF is embedded", async () => {
    const { el } = await open("public/spec.pdf");
    expect(el.querySelector("embed.media-embed")?.getAttribute("type")).toBe("application/pdf");
  });

  test("the reference a document would write, which is not the path", async () => {
    /* `public/hero.png` is written `/hero.png` — a string that shares not one path segment with the
       file. Getting it wrong is the commonest way an image goes missing from a page, and the
       importer got it wrong for every asset it downloaded. */
    const { el } = await open("public/hero.png");
    expect(el.querySelector(".media-ref-value")?.textContent?.trim()).toBe("/hero.png");
  });

  test("the kind, always; the numbers only when they are known", async () => {
    const { el } = await open("public/hero.png");
    const facts = el.querySelector(".media-facts")?.textContent ?? "";
    expect(facts).toContain("image");
    // No `0 × 0` and no `0 B`: a real file can almost be either, so they must not double as
    // "we did not find out".
    expect(facts).not.toContain("0 × 0");
    expect(facts).not.toContain("0 B");
  });
});

describe("mounting", () => {
  test("reports itself mounted, and stops when detached", async () => {
    const { tab } = await open("public/hero.png");
    expect(mediaPaneMounted("primary", tab)).toBe(true);
    detachMediaPane("primary");
    expect(mediaPaneMounted("primary", tab)).toBe(false);
  });

  test("re-rendering the same tab into the same pane leaves the mount alone", async () => {
    /* The fast path in `canvas-render.ts` relies on this: the viewer owns its own effect, so a
       repaint that reached the canvas pipeline would tear it down and rebuild it. */
    const { el, tab } = await open("public/hero.png");
    const img = el.querySelector("img.media-image");
    renderMediaMode(surfaceOf(el), tab);
    await flush(2);
    expect(el.querySelector("img.media-image")).toBe(img!);
  });

  test("detaching a pane that has nothing mounted is a no-op", () => {
    expect(() => {
      detachMediaPane("nowhere");
    }).not.toThrow();
  });
});

// ─── The facts beside the asset ──────────────────────────────────────────────

describe("what it can say about the file", () => {
  test("the size and modified date, when the directory listing carried them", async () => {
    seed({
      listDirectory: async () => [
        {
          modified: "2026-08-26T10:00:00.000Z",
          name: "hero.png",
          path: "public/hero.png",
          size: 2048,
          type: "file" as const,
        },
      ],
    } as Partial<StudioPlatform>);
    const { el } = await open("public/hero.png");
    await flush(4);
    const facts = el.querySelector(".media-facts")?.textContent ?? "";
    expect(facts).toContain("image");
    expect(facts).toContain("2 KB");
    expect(facts).toContain("modified 2026-08-26");
  });

  test("a listing that says neither yields neither — not a zero", async () => {
    /* `0 × 0` and `0 B` are things a real file can almost be, so they must not double as "we did
       not find out". The harness's listing carries no size, which is exactly that case. */
    const { el } = await open("public/hero.png");
    await flush(4);
    expect(el.querySelector(".media-facts")?.textContent?.trim()).toBe("image");
  });

  test("pixel dimensions arrive from the image that is already on screen", async () => {
    /* There is no stat that returns them and no decoder in the shell, so the only honest source is
       an `<img>` that has loaded — which this pane is showing at full size anyway. */
    const { el } = await open("public/hero.png");
    const img = el.querySelector("img.media-image") as HTMLImageElement;
    Object.defineProperty(img, "naturalWidth", { configurable: true, value: 1200 });
    Object.defineProperty(img, "naturalHeight", { configurable: true, value: 630 });
    img.dispatchEvent(new Event("load"));
    await flush(2);

    expect(el.querySelector(".media-facts")?.textContent).toContain("1200 × 630");
  });

  test("a second load of the same image does not repaint again", async () => {
    const { el } = await open("public/hero.png");
    const img = el.querySelector("img.media-image") as HTMLImageElement;
    Object.defineProperty(img, "naturalWidth", { configurable: true, value: 800 });
    Object.defineProperty(img, "naturalHeight", { configurable: true, value: 600 });
    img.dispatchEvent(new Event("load"));
    await flush(2);
    // Same numbers: nothing was learned, so nothing is redrawn and the node survives.
    const before = el.querySelector("img.media-image");
    img.dispatchEvent(new Event("load"));
    await flush(2);
    expect(el.querySelector("img.media-image")).toBe(before!);
  });

  test("a file it cannot show says so, and says the file is still fine", async () => {
    /* Opened directly rather than through the tree: `.zip` is not one of the extensions Studio
       calls media, so the tree does not route it here. The branch is still real — the mode is
       reachable through `openMediaTab`, and MEDIA_EXTENSIONS is a list that grows. */
    openMediaTab("public/archive.zip");
    const tab = workspace.tabs.get("public/archive.zip")!;
    const host = document.createElement("div");
    document.body.append(host);
    renderMediaMode(surfaceOf(host), tab);
    await flush(2);
    const el = host;
    const box = el.querySelector(".media-unviewable");
    expect(box).toBeTruthy();
    expect(box!.textContent).toContain(".zip");
    expect(el.querySelector(".media-note")?.textContent).toContain("builds normally");
  });

  test("the reference can be copied", async () => {
    const written: string[] = [];
    Object.defineProperty(globalThis.navigator, "clipboard", {
      configurable: true,
      value: { writeText: (text: string) => written.push(text) },
    });
    const { el } = await open("public/hero.png");
    (el.querySelector(".media-ref sp-action-button") as HTMLElement).dispatchEvent(
      new Event("click", { bubbles: true }),
    );
    expect(written).toEqual(["/hero.png"]);
  });
});

// ─── Used by ─────────────────────────────────────────────────────────────────

describe("which documents use it", () => {
  /** A platform that answers the reference query for the authored form of `public/hero.png`. */
  function withReferences(files: { path: string; count: number }[]): void {
    /* The query runs once per AUTHORED FORM of the file — `public/hero.png` and `/hero.png`, which
       resolves to `hero.png` — and the union sums per file. So the fixture answers ONE lane, the
       way a real index would: a page writes the ref one way, not both. */
    seed({
      findReferences: async (target: { path?: string }) => ({
        errors: [],
        files:
          target.path === "public/hero.png"
            ? files.map((f) => ({ count: f.count, path: f.path, refs: [] }))
            : [],
        filesReferencing: target.path === "public/hero.png" ? files.length : 0,
        path: target.path ?? null,
        refsTotal: target.path === "public/hero.png" ? files.reduce((n, f) => n + f.count, 0) : 0,
        tagName: null,
      }),
    } as Partial<StudioPlatform>);
  }

  test("lists them, with a count each", async () => {
    /* `site-architecture.md` §9.4 listed this query as having no reader but the delete
       confirmation: you could only learn what an image was used for by trying to remove it. */
    withReferences([{ count: 2, path: "pages/index.json" }]);
    const { el } = await open("public/hero.png");
    await flush(6);

    const links = [...el.querySelectorAll(".media-usage-link")].map((n) => n.textContent?.trim());
    expect(links).toContain("pages/index.json");
    expect(el.querySelector(".media-usage-count")?.textContent?.trim()).toBe("2");
  });

  test("a row opens the document that references it", async () => {
    withReferences([{ count: 1, path: "pages/index.json" }]);
    const { el } = await open("public/hero.png");
    await flush(6);

    (el.querySelector(".media-usage-link") as HTMLElement).dispatchEvent(
      new Event("click", { bubbles: true }),
    );
    await flush(4);
    expect(workspace.tabs.has("pages/index.json")).toBe(true);
  });

  test("nothing uses it is a sentence, not an empty list", async () => {
    withReferences([]);
    const { el } = await open("public/hero.png");
    await flush(6);
    expect(el.querySelector(".media-usage-headline")?.textContent?.trim()).toBeTruthy();
    expect(el.querySelector(".media-usage-list")).toBeNull();
  });

  test("a host with no reference index shows no count rather than a zero", async () => {
    // A confident zero is the one answer this must never invent.
    const { el } = await open("public/hero.png");
    await flush(6);
    expect(el.querySelector(".media-usage")).toBeNull();
  });
});
