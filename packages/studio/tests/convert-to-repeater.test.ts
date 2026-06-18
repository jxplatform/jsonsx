/**
 * Tests for src/editor/convert-to-repeater.ts — wrap the selected element in an Array repeater.
 *
 * Monaco (pulled in transitively via code-services) is mocked. The repeater config dialog is driven
 * through the real lit-rendered sp-dialog-wrapper in #layer-dialog.
 */
import { flush, installMockPlatform, resetStudioState, resetWorkspaceWithTab } from "./harness";
import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { Tab } from "../src/tabs/tab";

void mock.module("monaco-editor/esm/vs/editor/editor.api.js", () => ({
  MarkerSeverity: { Error: 8, Warning: 4 },
  Uri: { parse: (url: string) => ({ toString: () => url }) },
  editor: { setModelMarkers: mock(() => {}) },
  languages: { registerCompletionItemProvider: mock(() => {}) },
}));

const { convertToRepeater } = await import("../src/editor/convert-to-repeater");
const { initLayers } = await import("../src/ui/layers");
const { pluginSchemaCache } = await import("../src/services/code-services");

// ─── Environment ──────────────────────────────────────────────────────────────

globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
  setTimeout(() => cb(0), 0);
  return 0;
}) as typeof requestAnimationFrame;

let tab: Tab;

function makeDoc(state: Record<string, unknown> | undefined) {
  return {
    children: [{ tagName: "li", textContent: "Item" }],
    ...(state !== undefined && { state }),
    tagName: "ul",
  };
}

function setup(state: Record<string, unknown> | undefined) {
  document.body.innerHTML = "";
  for (const id of ["layer-popover", "layer-modal", "layer-dialog"]) {
    const layer = document.createElement("div");
    layer.id = id;
    document.body.append(layer);
  }
  initLayers();
  resetStudioState();
  installMockPlatform();
  pluginSchemaCache.clear();
  tab = resetWorkspaceWithTab(makeDoc(state) as never);
  tab.session.selection = ["children", 0];
}

beforeEach(() => {
  setup({ rows: { default: [], type: "array" } });
});

function dialog() {
  return document.querySelector("#layer-dialog sp-dialog-wrapper");
}

function pickers() {
  return [...document.querySelectorAll("#layer-dialog sp-picker")] as (HTMLElement & {
    value?: string;
  })[];
}

function setPicker(label: string, value: string) {
  const picker = pickers().find((p) => p.getAttribute("label") === label)!;
  picker.value = value;
  picker.dispatchEvent(new Event("change", { bubbles: true }));
}

function setNewName(value: string) {
  const tf = document.querySelector("#layer-dialog sp-textfield") as HTMLElement & {
    value?: string;
  };
  tf.value = value;
  tf.dispatchEvent(new Event("input", { bubbles: true }));
}

function confirmDialog() {
  dialog()!.dispatchEvent(new Event("confirm"));
}

function helpText() {
  return document.querySelector("#layer-dialog sp-help-text")?.textContent?.trim() ?? "";
}

function child0() {
  return (tab.doc.document.children as Record<string, unknown>[])[0];
}

// ─── Guards ───────────────────────────────────────────────────────────────────

describe("guards", () => {
  test("no selection → no dialog", async () => {
    tab.session.selection = null;
    await convertToRepeater();
    expect(dialog()).toBeNull();
  });

  test("missing node → no dialog", async () => {
    tab.session.selection = ["children", 9];
    await convertToRepeater();
    expect(dialog()).toBeNull();
  });
});

// ─── Existing array source ────────────────────────────────────────────────────

describe("existing array defs", () => {
  test("confirm replaces the element in place with an Array repeater (no wrapper div)", async () => {
    const done = convertToRepeater();
    await flush();
    expect(dialog()).not.toBeNull();
    confirmDialog();
    await done;

    // The selected element becomes the array node directly — no throwaway <div> wrapper.
    const repeater = child0()!;
    expect(repeater.tagName).toBeUndefined();
    expect(repeater.$prototype).toBe("Array");
    expect(repeater.items).toEqual({ $ref: "#/state/rows" });
    expect((repeater.map as Record<string, unknown>).tagName).toBe("li");
    expect(repeater.filter).toBeUndefined();
    expect(repeater.sort).toBeUndefined();
    expect(tab.doc.dirty).toBe(true);
  });

  test("cancel makes no changes", async () => {
    const done = convertToRepeater();
    await flush();
    dialog()!.dispatchEvent(new Event("cancel"));
    await done;
    expect(child0()).toEqual({ tagName: "li", textContent: "Item" });
    expect(tab.doc.dirty).toBe(false);
  });

  test("defs with array defaults are offered as sources", async () => {
    setup({ extra: { default: [1, 2] }, rows: { default: [], type: "array" } });
    const done = convertToRepeater();
    await flush();
    setPicker("Items source", "extra");
    confirmDialog();
    await done;
    expect((child0() as Record<string, unknown>).items).toEqual({
      $ref: "#/state/extra",
    });
  });

  test("function defs enable filter and sort pickers", async () => {
    setup({
      byDate: { $prototype: "Function", arguments: "a, b", body: "return 0" },
      rows: { default: [], type: "array" },
    });
    const done = convertToRepeater();
    await flush();
    setPicker("Filter", "byDate");
    setPicker("Sort", "byDate");
    confirmDialog();
    await done;

    const repeater = child0() as Record<string, unknown>;
    expect(repeater.filter).toEqual({ $ref: "#/state/byDate" });
    expect(repeater.sort).toEqual({ $ref: "#/state/byDate" });
  });

  test("plugin defs whose schema returns an array become sources", async () => {
    setup({ feed: { $prototype: "Fetch", $src: "./feed.js" } });
    installMockPlatform({
      fetchPluginSchema: async () => ({ returns: { type: "array" } }),
    } as never);
    pluginSchemaCache.clear();
    const done = convertToRepeater();
    await flush();
    confirmDialog();
    await done;
    expect((child0() as Record<string, unknown>).items).toEqual({
      $ref: "#/state/feed",
    });
  });

  test("plugin defs without an array schema are skipped", async () => {
    setup({ thing: { $prototype: "Fetch", $src: "./thing.js" } });
    const done = convertToRepeater();
    await flush();
    // No array defs → dialog opens in create-new mode
    expect(document.querySelector("#layer-dialog sp-textfield")).not.toBeNull();
    dialog()!.dispatchEvent(new Event("close"));
    await done;
  });
});

// ─── Create-new definition ────────────────────────────────────────────────────

describe("create new definition", () => {
  beforeEach(() => {
    setup({ taken: { default: "x" } });
  });

  test("empty name shows an error and keeps the dialog open", async () => {
    const done = convertToRepeater();
    await flush();
    confirmDialog();
    await flush();
    expect(dialog()).not.toBeNull();
    expect(helpText()).toContain("Enter a name");
    dialog()!.dispatchEvent(new Event("cancel"));
    await done;
  });

  test("existing def name is rejected", async () => {
    const done = convertToRepeater();
    await flush();
    setNewName("taken");
    confirmDialog();
    await flush();
    expect(helpText()).toContain("already exists");
    dialog()!.dispatchEvent(new Event("cancel"));
    await done;
  });

  test("invalid identifier is rejected", async () => {
    const done = convertToRepeater();
    await flush();
    setNewName("1bad name");
    confirmDialog();
    await flush();
    expect(helpText()).toContain("Invalid identifier");
    dialog()!.dispatchEvent(new Event("cancel"));
    await done;
  });

  test("valid name creates the state def and binds the repeater to it", async () => {
    const done = convertToRepeater();
    await flush();
    setNewName("myList");
    confirmDialog();
    await done;

    const doc = tab.doc.document as Record<string, unknown>;
    expect((doc.state as Record<string, unknown>).myList).toEqual({
      default: [],
      type: "array",
    });
    expect((child0() as Record<string, unknown>).items).toEqual({
      $ref: "#/state/myList",
    });
  });

  test("switching the source picker to create-new reveals the name field", async () => {
    setup({ rows: { default: [], type: "array" } });
    const done = convertToRepeater();
    await flush();
    expect(document.querySelector("#layer-dialog sp-textfield")).toBeNull();
    setPicker("Items source", "__new__");
    await flush();
    expect(document.querySelector("#layer-dialog sp-textfield")).not.toBeNull();
    setNewName("fresh");
    confirmDialog();
    await done;
    expect((child0() as Record<string, unknown>).items).toEqual({
      $ref: "#/state/fresh",
    });
  });

  test("document without state gets one created", async () => {
    setup(undefined);
    const done = convertToRepeater();
    await flush();
    setNewName("brandNew");
    confirmDialog();
    await done;
    const doc = tab.doc.document as Record<string, unknown>;
    expect((doc.state as Record<string, unknown>).brandNew).toEqual({
      default: [],
      type: "array",
    });
  });
});
