/**
 * Tests for src/browse/browse-modal.ts — the fullscreen Manage Files overlay.
 *
 * Mocks ../src/files/files so selecting a file doesn't pull in the full tab-opening machinery;
 * asserts modal lifecycle (open once, Escape/close button, file selection closes and opens).
 */
import { flush, installMockPlatform, pointer, resetStudioState } from "./harness";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { initLayers } from "../src/ui/layers";
import { setFormats } from "../src/format/format-host";
import type { DirEntry } from "../src/types";

const openFileInTab = mock(async (_path: string) => {});
mock.module("../src/files/files.js", () => ({ openFileInTab }));

const { closeBrowseModal, openBrowseModal } = await import("../src/browse/browse-modal");
const { invalidateBrowseCache } = await import("../src/browse/browse");

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

const TREE: Record<string, DirEntry[]> = {
  pages: [{ name: "index.json", path: "pages/index.json", type: "file" }],
};

function modalLayer(): HTMLElement {
  return document.querySelector("#layer-modal") as HTMLElement;
}

function modal(): HTMLElement | null {
  return modalLayer().querySelector(".browse-modal");
}

async function openAndSettle() {
  openBrowseModal();
  // RAF defers the inner renderBrowse; give the async scan time to settle
  await flush(6);
}

beforeEach(() => {
  setFormats([]);
  invalidateBrowseCache();
  openFileInTab.mockClear();
  installMockPlatform(
    {
      listDirectory: async (dir: string) => TREE[dir] ?? [],
    },
    { "pages/index.json": '{"tagName":"div","children":[]}' },
  );
  resetStudioState({
    projectConfig: null,
    projectDirs: ["pages"],
    projectRoot: "",
  });
});

afterEach(() => {
  closeBrowseModal();
});

describe("openBrowseModal", () => {
  test("renders the modal with header and browse content", async () => {
    await openAndSettle();
    expect(modal()).not.toBeNull();
    expect(modal()?.querySelector(".browse-modal-title")?.textContent).toBe("Manage Files");
    expect(modalLayer().querySelector("sp-underlay")).not.toBeNull();
    const content = modal()?.querySelector(".browse-modal-content");
    expect(content?.querySelector(".browse-view")).not.toBeNull();
    expect(content?.textContent).toContain("index.json");
  });

  test("a second open while already open is a no-op", async () => {
    await openAndSettle();
    openBrowseModal();
    await flush();
    expect(modalLayer().querySelectorAll(".browse-modal")).toHaveLength(1);
  });

  test("can reopen after closing", async () => {
    await openAndSettle();
    closeBrowseModal();
    expect(modal()).toBeNull();
    await openAndSettle();
    expect(modal()).not.toBeNull();
  });
});

describe("closing", () => {
  test("Escape closes the modal and unregisters the handler", async () => {
    await openAndSettle();
    document.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Escape" }));
    expect(modal()).toBeNull();
    // A second Escape with no modal open is harmless
    document.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Escape" }));
    expect(modal()).toBeNull();
  });

  test("other keys do not close the modal", async () => {
    await openAndSettle();
    document.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "a" }));
    expect(modal()).not.toBeNull();
  });

  test("the close button closes the modal", async () => {
    await openAndSettle();
    const btn = modal()?.querySelector('sp-action-button[title="Close"]') as HTMLElement;
    pointer(btn, "click");
    await flush();
    expect(modal()).toBeNull();
  });

  test("underlay close event closes the modal", async () => {
    await openAndSettle();
    modalLayer().querySelector("sp-underlay")?.dispatchEvent(new Event("close"));
    expect(modal()).toBeNull();
  });

  test("closeBrowseModal without an open modal is a no-op", () => {
    expect(() => closeBrowseModal()).not.toThrow();
    expect(modal()).toBeNull();
  });
});

describe("file selection", () => {
  test("clicking a file closes the modal and opens it in a tab", async () => {
    await openAndSettle();
    const card = [...(modal()?.querySelectorAll(".element-card") ?? [])].find(
      (c) => c.querySelector(".element-card-label")?.textContent === "index.json",
    ) as HTMLElement;
    expect(card).toBeDefined();
    pointer(card, "click");
    await flush();
    expect(modal()).toBeNull();
    expect(openFileInTab).toHaveBeenCalledWith("pages/index.json");
  });
});
