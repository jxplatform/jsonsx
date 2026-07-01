import {
  flush,
  installMockPlatform,
  pointer,
  renderInto,
  resetStudioState,
  setValue,
  stubRect,
} from "./harness";
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import * as storeActual from "../src/store";
import type { DirEntry } from "../src/types";

// Make debounced style commits synchronous so @input handlers fire without real 400ms timers.
void mock.module("../src/store", () => ({
  ...storeActual,
  debouncedStyleCommit:
    <A extends unknown[]>(_prop: string, _ms: number, fn: (...args: A) => void) =>
    (...args: A) =>
      fn(...args),
}));

const { invalidateMediaCache, renderMediaPicker } = await import("../src/ui/media-picker");
const { getLayerSlot } = await import("../src/ui/layers");

// ─── Deterministic requestAnimationFrame ─────────────────────────────────────

const realRaf = globalThis.requestAnimationFrame;
let rafQueue: FrameRequestCallback[] = [];
globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
  rafQueue.push(cb);
  return rafQueue.length;
}) as typeof requestAnimationFrame;

function runRaf() {
  const queue = rafQueue;
  rafQueue = [];
  for (const cb of queue) {
    cb(0);
  }
}

afterAll(() => {
  globalThis.requestAnimationFrame = realRaf;
});

// ─── Platform with a directory tree (media-picker reads entry.type) ─────────

interface Entry {
  name: string;
  path: string;
  type: "file" | "directory";
}

const defaultTree: Record<string, Entry[]> = {
  public: [
    { name: "logo.png", path: "public/logo.png", type: "file" },
    { name: "clip.mp4", path: "public/clip.mp4", type: "file" },
    { name: "notes.txt", path: "public/notes.txt", type: "file" },
    { name: "README", path: "public/README", type: "file" },
    { name: ".hidden", path: "public/.hidden", type: "file" },
    { name: "img", path: "public/img", type: "directory" },
    { name: "missing", path: "public/missing", type: "directory" },
  ],
  "public/img": [{ name: "photo.JPG", path: "public/img/photo.JPG", type: "file" }],
};

function installTree(tree: Record<string, Entry[]>, canvasUrl?: string) {
  installMockPlatform({
    ...(canvasUrl != null && { canvasUrl }),
    listDirectory: async (dir: string) => {
      const entries = tree[dir];
      if (!entries) {
        throw new Error(`ENOENT: ${dir}`);
      }
      return entries as unknown as DirEntry[];
    },
  });
}

function popoverHost() {
  return getLayerSlot("popover", "media-picker");
}

function dismissViaEscape() {
  document.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Escape" }));
}

async function renderLoaded(value: string, onCommit: (v: string) => void = () => {}) {
  // First render kicks off the async cache load; re-render once loaded so the
  // Browse button (gated on mediaCache.length) appears.
  const container = await renderInto(renderMediaPicker("src", value, onCommit));
  await flush();
  return renderInto(renderMediaPicker("src", value, onCommit), container);
}

beforeEach(() => {
  resetStudioState();
  invalidateMediaCache();
  installTree(defaultTree);
});

afterEach(() => {
  dismissViaEscape();
  rafQueue = [];
});

// ─── Cache collection ────────────────────────────────────────────────────────

describe("media cache collection", () => {
  test("recurses directories, filters by media extension, strips public/ prefix", async () => {
    const container = await renderLoaded("");
    const button = container.querySelector("sp-action-button");
    expect(button).not.toBeNull();

    pointer(button!, "click");
    const items = [...popoverHost().querySelectorAll("sp-menu-item")];
    const values = items.map((item) => item.getAttribute("value"));
    expect(values).toEqual(["/logo.png", "/clip.mp4", "/img/photo.JPG"]);
  });

  test("image entries get a thumbnail icon, non-images do not", async () => {
    const container = await renderLoaded("");
    pointer(container.querySelector("sp-action-button")!, "click");
    const items = [...popoverHost().querySelectorAll("sp-menu-item")];
    // No cross-origin loopback registered => the icon src falls back to the relative path.
    expect(items[0]?.querySelector("img")?.getAttribute("src")).toBe("/logo.png");
    expect(items[1]?.querySelector("img")).toBeNull();
  });

  test("popover icon src is loopback-absolute when a cross-origin canvasUrl is registered", async () => {
    invalidateMediaCache();
    installTree(defaultTree, "http://127.0.0.1:54321/__studio__/canvas.html");
    const container = await renderLoaded("");
    pointer(container.querySelector("sp-action-button")!, "click");
    const items = [...popoverHost().querySelectorAll("sp-menu-item")];
    expect(items[0]?.querySelector("img")?.getAttribute("src")).toBe(
      "http://127.0.0.1:54321/logo.png",
    );
  });

  test("invalidateMediaCache forces reload; unreadable root yields empty cache and no browse button", async () => {
    await renderLoaded("");
    invalidateMediaCache();
    installTree({});
    const container = await renderLoaded("");
    expect(container.querySelector("sp-action-button")).toBeNull();
  });
});

// ─── Field rendering & commit ────────────────────────────────────────────────

describe("renderMediaPicker field", () => {
  test("shows a thumbnail for image values only", async () => {
    const withImage = await renderLoaded("/logo.png");
    // No cross-origin loopback registered => the thumb src falls back to the relative path.
    expect(withImage.querySelector(".media-picker-thumb")?.getAttribute("src")).toBe("/logo.png");

    const withVideo = await renderLoaded("/clip.mp4");
    expect(withVideo.querySelector(".media-picker-thumb")).toBeNull();

    const empty = await renderLoaded("");
    expect(empty.querySelector(".media-picker-thumb")).toBeNull();
  });

  test("thumb src is loopback-absolute when a cross-origin canvasUrl is registered", async () => {
    invalidateMediaCache();
    installTree(defaultTree, "http://127.0.0.1:54321/__studio__/canvas.html");
    const withImage = await renderLoaded("/logo.png");
    expect(withImage.querySelector(".media-picker-thumb")?.getAttribute("src")).toBe(
      "http://127.0.0.1:54321/logo.png",
    );
  });

  test("typing into the textfield commits the value", async () => {
    const seen: string[] = [];
    const container = await renderLoaded("/logo.png", (v) => seen.push(v));
    const field = container.querySelector("sp-textfield") as HTMLInputElement;
    setValue(field, "/other.png");
    expect(seen).toEqual(["/other.png"]);
  });

  test("focusing the textfield re-triggers the (already loaded) cache load", async () => {
    const container = await renderLoaded("");
    const field = container.querySelector("sp-textfield") as HTMLElement;
    field.dispatchEvent(new Event("focus", { bubbles: true }));
    await flush();
    // Cache still intact — popover still lists media.
    pointer(container.querySelector("sp-action-button")!, "click");
    expect(popoverHost().querySelectorAll("sp-menu-item").length).toBe(3);
  });
});

// ─── Popover behavior ────────────────────────────────────────────────────────

describe("media picker popover", () => {
  async function openPopover(onCommit: (v: string) => void = () => {}) {
    const container = await renderLoaded("", onCommit);
    const button = container.querySelector("sp-action-button") as HTMLElement;
    pointer(button, "click");
    return { button, container };
  }

  test("selecting a menu item commits the value and dismisses", async () => {
    const seen: string[] = [];
    await openPopover((v) => seen.push(v));
    const menu = popoverHost().querySelector("sp-menu") as HTMLElement & { value: string };
    menu.value = "/img/photo.JPG";
    menu.dispatchEvent(new Event("change", { bubbles: true }));
    expect(seen).toEqual(["/img/photo.JPG"]);
    expect(popoverHost().querySelector("sp-popover")).toBeNull();
  });

  test("filter input narrows the list; no matches renders a disabled row", async () => {
    await openPopover();
    const filter = popoverHost().querySelector(".media-picker-filter") as HTMLInputElement;
    filter.value = "PHOTO";
    filter.dispatchEvent(new Event("input", { bubbles: true }));
    let items = [...popoverHost().querySelectorAll("sp-menu-item")];
    expect(items.map((item) => item.getAttribute("value"))).toEqual(["/img/photo.JPG"]);

    const filter2 = popoverHost().querySelector(".media-picker-filter") as HTMLInputElement;
    filter2.value = "zzz";
    filter2.dispatchEvent(new Event("input", { bubbles: true }));
    items = [...popoverHost().querySelectorAll("sp-menu-item")];
    expect(items).toHaveLength(1);
    expect(items[0]?.hasAttribute("disabled")).toBe(true);
    expect(items[0]?.textContent).toContain("No matches");
  });

  test("clicking the filter input does not bubble out (stopPropagation)", async () => {
    await openPopover();
    const filter = popoverHost().querySelector(".media-picker-filter") as HTMLElement;
    let leaked = false;
    const spy = () => {
      leaked = true;
    };
    document.addEventListener("click", spy);
    pointer(filter, "click");
    document.removeEventListener("click", spy);
    expect(leaked).toBe(false);
  });

  test("Escape dismisses; other keys do not", async () => {
    await openPopover();
    document.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "a" }));
    expect(popoverHost().querySelector("sp-popover")).not.toBeNull();
    dismissViaEscape();
    expect(popoverHost().querySelector("sp-popover")).toBeNull();
  });

  test("outside mousedown dismisses after the listener is armed; inside clicks keep it open", async () => {
    await openPopover();
    runRaf(); // Arms the outside-click listener
    const menu = popoverHost().querySelector("sp-menu") as HTMLElement;
    pointer(menu, "mousedown");
    expect(popoverHost().querySelector("sp-popover")).not.toBeNull();
    pointer(document.body, "mousedown");
    expect(popoverHost().querySelector("sp-popover")).toBeNull();
  });

  test("initial position clamps to the viewport and flips above tall anchors", async () => {
    const container = await renderLoaded("");
    const button = container.querySelector("sp-action-button") as HTMLElement;
    const width = window.innerWidth;
    const height = window.innerHeight;
    stubRect(button, { height: 20, left: width - 10, top: height - 10, width: 20 });
    pointer(button, "click");
    const popover = popoverHost().querySelector("sp-popover") as HTMLElement;
    const style = popover.getAttribute("style") || "";
    const estimatedHeight = Math.min(3 * 36 + 48, 360);
    expect(style).toContain(`left:${Math.max(8, width - 280 - 8)}px`);
    expect(style).toContain(`top:${Math.max(8, height - 10 - estimatedHeight - 4)}px`);
  });

  test("post-render adjustment pulls an overflowing popover back into the viewport", async () => {
    await openPopover();
    const popover = popoverHost().querySelector("sp-popover") as HTMLElement;
    stubRect(popover, { height: 300, left: 5000, top: 5000, width: 300 });
    runRaf();
    expect(popover.style.left).toBe(`${window.innerWidth - 300 - 4}px`);
    expect(popover.style.top).toBe(`${window.innerHeight - 300 - 4}px`);
  });

  test("post-render adjustment clamps negative positions to 4px and focuses the filter", async () => {
    await openPopover();
    const popover = popoverHost().querySelector("sp-popover") as HTMLElement;
    stubRect(popover, { height: 100, left: -50, top: -50, width: 100 });
    runRaf();
    expect(popover.style.left).toBe("4px");
    expect(popover.style.top).toBe("4px");
    expect(document.activeElement?.classList.contains("media-picker-filter")).toBe(true);
  });

  test("more than 50 entries are truncated with an overflow row", async () => {
    invalidateMediaCache();
    const many: Entry[] = [];
    for (let i = 0; i < 60; i++) {
      many.push({ name: `pic-${i}.png`, path: `public/pic-${i}.png`, type: "file" });
    }
    installTree({ public: many });
    await openPopover();
    const items = [...popoverHost().querySelectorAll("sp-menu-item")];
    expect(items).toHaveLength(51);
    expect(items.at(-1)?.textContent).toContain("10 more");
  });
});
