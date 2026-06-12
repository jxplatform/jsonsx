/**
 * Gap tests for src/browse/browse.ts — covers the rename dialog's input.select() path (line 620),
 * which requires the sp-textfield shadow root to contain an <input> when the focus rAF fires, plus
 * a few never-invoked event handlers (search submit prevention, rename dialog close).
 */
import { flush, installMockPlatform, pointer, resetStudioState } from "./harness";
import type { MockPlatformState } from "./harness";
import { beforeEach, describe, expect, test } from "bun:test";
import { initLayers } from "../src/ui/layers";
import { setFormats } from "../src/format/format-host";
import { invalidateBrowseCache, renderBrowse } from "../src/browse/browse";
import type { DirEntry } from "../src/types";

// ─── Environment setup ───────────────────────────────────────────────────────

for (const id of ["layer-popover", "layer-modal", "layer-dialog"]) {
  if (!document.querySelector(`#${id}`)) {
    const el = document.createElement("div");
    el.id = id;
    document.body.append(el);
  }
}
initLayers();

// Deterministic rAF: run callbacks on the next macrotask so flush() picks them up.
globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
  setTimeout(() => cb(0), 0);
  return 0;
}) as typeof requestAnimationFrame;

// ─── Fixtures ────────────────────────────────────────────────────────────────

const TREE: Record<string, DirEntry[]> = {
  public: [{ name: "logo.png", path: "public/logo.png", type: "file" } as DirEntry],
};

let state: MockPlatformState;
let ctx: { openFile: (path: string) => void };

function dialogLayer(): HTMLElement {
  return document.querySelector("#layer-dialog") as HTMLElement;
}

async function mount(): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.append(container);
  await renderBrowse(container, ctx);
  await flush();
  return container;
}

async function openRenameDialogWithoutFlush(container: HTMLElement) {
  const card = container.querySelector(".element-card") as HTMLElement;
  expect(card).not.toBeNull();
  pointer(card, "contextmenu");
  await flush();
  const items = [...dialogLayer().querySelectorAll("sp-menu-item")] as HTMLElement[];
  const rename = items.find((i) => (i.textContent ?? "").startsWith("Rename"));
  expect(rename).toBeDefined();
  // No flush here: callers patch the freshly rendered dialog before the focus rAF fires.
  pointer(rename as HTMLElement, "click");
}

beforeEach(() => {
  setFormats([]);
  invalidateBrowseCache();
  ({ state } = installMockPlatform(
    {
      listDirectory: async (dir: string) => TREE[dir] ?? [],
    },
    { "public/logo.png": "PNGDATA" },
  ));
  resetStudioState({ projectConfig: {}, projectDirs: ["public"], projectRoot: "" });
  dialogLayer().replaceChildren();
  for (const el of document.body.querySelectorAll(":scope > div:not([id])")) {
    el.remove();
  }
  ctx = { openFile: () => {} };
});

// ─── Rename dialog focus/select ──────────────────────────────────────────────

describe("rename dialog focus", () => {
  test("selects the shadow-root input contents when the focus rAF fires", async () => {
    const container = await mount();
    await openRenameDialogWithoutFlush(container);

    // ShowDialog renders synchronously, so the textfield exists before the rAF callback runs.
    const tf = dialogLayer().querySelector("sp-textfield") as HTMLElement;
    expect(tf).not.toBeNull();
    const shadow = tf.shadowRoot ?? tf.attachShadow({ mode: "open" });
    const input = document.createElement("input");
    let selected = 0;
    input.select = () => {
      selected += 1;
    };
    shadow.append(input);

    await flush();
    expect(selected).toBe(1);

    dialogLayer().querySelector("sp-dialog-wrapper")?.dispatchEvent(new Event("cancel"));
    await flush();
    expect(dialogLayer().querySelector("sp-dialog-wrapper")).toBeNull();
  });

  test("focus rAF tolerates a textfield without an input in its shadow root", async () => {
    const container = await mount();
    await openRenameDialogWithoutFlush(container);
    // Let the rAF fire against the bare sp-textfield (no input found → select skipped).
    await flush();
    expect(dialogLayer().querySelector("sp-dialog-wrapper")).not.toBeNull();

    dialogLayer().querySelector("sp-dialog-wrapper")?.dispatchEvent(new Event("close"));
    await flush();
    expect(dialogLayer().querySelector("sp-dialog-wrapper")).toBeNull();
    expect(state.calls.filter((c) => c[0] === "renameFile")).toHaveLength(0);
  });
});

// ─── Misc handler gaps ───────────────────────────────────────────────────────

describe("handler gaps", () => {
  test("search submit events are prevented", async () => {
    const container = await mount();
    const search = container.querySelector("sp-search") as HTMLElement;
    expect(search).not.toBeNull();
    const e = new Event("submit", { bubbles: false, cancelable: true });
    search.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(true);
  });
});
