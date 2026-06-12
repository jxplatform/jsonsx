/**
 * Tests for src/editor/convert-to-component.ts — extract selection into a reusable component.
 *
 * Drives the real lit-rendered naming dialog (sp-dialog-wrapper in #layer-dialog) and asserts the
 * document mutation, $elements ref wiring, and the platform writeFile call.
 */
import { flush, installMockPlatform, resetStudioState, resetWorkspaceWithTab } from "./harness";
import type { MockPlatformState } from "./harness";
import { beforeEach, describe, expect, test } from "bun:test";
import { convertToComponent } from "../src/editor/convert-to-component";
import { componentRegistry } from "../src/files/components";
import { initLayers } from "../src/ui/layers";
import { activeTab } from "../src/workspace/workspace";
import type { Tab } from "../src/tabs/tab";

// ─── Environment ──────────────────────────────────────────────────────────────

globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
  setTimeout(() => cb(0), 0);
  return 0;
}) as typeof requestAnimationFrame;

// ExtractComponentDef must clone the selected node even though it is a @vue/reactivity proxy
// (structuredClone rejects proxies with DataCloneError; src uses jsonClone). No stubs here —
// These tests exercise the real clone path against reactive tab state.

let tab: Tab;
let platformState: MockPlatformState;

function freshDoc() {
  return {
    children: [
      {
        $id: "Hero-Block",
        children: [{ tagName: "h1", textContent: "Title" }],
        tagName: "section",
      },
      { tagName: "p", textContent: "after" },
    ],
    tagName: "div",
  };
}

beforeEach(() => {
  document.body.innerHTML = "";
  for (const id of ["layer-popover", "layer-modal", "layer-dialog"]) {
    const layer = document.createElement("div");
    layer.id = id;
    document.body.append(layer);
  }
  initLayers();
  resetStudioState();
  ({ state: platformState } = installMockPlatform());
  componentRegistry.length = 0;
  tab = resetWorkspaceWithTab(freshDoc());
});

function dialog() {
  return document.querySelector("#layer-dialog sp-dialog-wrapper");
}

function textfield() {
  return document.querySelector("#layer-dialog sp-textfield") as HTMLElement & { value?: string };
}

function setName(value: string) {
  const tf = textfield();
  tf.value = value;
  tf.dispatchEvent(new Event("input", { bubbles: true }));
}

function confirmDialog() {
  dialog()!.dispatchEvent(new Event("confirm"));
}

// ─── Early returns ────────────────────────────────────────────────────────────

describe("guards", () => {
  test("no selection → resolves without showing a dialog", async () => {
    tab.session.selection = null;
    await convertToComponent();
    expect(dialog()).toBeNull();
  });

  test("root selection → no dialog", async () => {
    tab.session.selection = [];
    await convertToComponent();
    expect(dialog()).toBeNull();
  });

  test("node without tagName → no dialog", async () => {
    (tab.doc.document.children as unknown[])[0] = { textContent: "bare" };
    tab.session.selection = ["children", 0];
    await convertToComponent();
    expect(dialog()).toBeNull();
  });
});

// ─── Default name derivation ──────────────────────────────────────────────────

describe("default name", () => {
  test("hyphenated $id becomes the default name", async () => {
    tab.session.selection = ["children", 0];
    const done = convertToComponent();
    await flush();
    expect(textfield().getAttribute("value")).toBe("hero-block");
    dialog()!.dispatchEvent(new Event("cancel"));
    await done;
  });

  test("plain tag gets a jx- prefix", async () => {
    tab.session.selection = ["children", 1];
    const done = convertToComponent();
    await flush();
    expect(textfield().getAttribute("value")).toBe("jx-p");
    dialog()!.dispatchEvent(new Event("close"));
    await done;
  });

  test("hyphenated tag is used directly", async () => {
    (tab.doc.document.children as unknown[])[1] = { tagName: "fancy-card" };
    tab.session.selection = ["children", 1];
    const done = convertToComponent();
    await flush();
    expect(textfield().getAttribute("value")).toBe("fancy-card");
    dialog()!.dispatchEvent(new Event("cancel"));
    await done;
  });
});

// ─── Conversion flow ──────────────────────────────────────────────────────────

describe("conversion", () => {
  test("confirm replaces the node, adds the $ref, and writes the component file", async () => {
    tab.session.selection = ["children", 0];
    const done = convertToComponent();
    await flush();

    setName("hero-block");
    confirmDialog();
    await done;

    const doc = tab.doc.document as Record<string, unknown>;
    expect((doc.children as unknown[])[0]).toEqual({ tagName: "hero-block" });
    expect(doc.$elements).toEqual([{ $ref: "../components/hero-block.json" }]);

    const write = platformState.calls.find((c) => c[0] === "writeFile");
    expect(write).toBeDefined();
    expect(write![1]).toBe("components/hero-block.json");
    const written = JSON.parse(write![2] as string);
    expect(written.tagName).toBe("hero-block");
    expect(written.$id).toBeUndefined();
    expect(written.children).toEqual([{ tagName: "h1", textContent: "Title" }]);
    // Registry refresh was requested
    expect(platformState.calls.some((c) => c[0] === "discoverComponents")).toBe(true);
  });

  test("converting a second time does not duplicate the $ref", async () => {
    const doc = tab.doc.document as Record<string, unknown>;
    doc.$elements = [{ $ref: "../components/hero-block.json" }];
    tab.session.selection = ["children", 0];
    const done = convertToComponent();
    await flush();
    setName("hero-block");
    confirmDialog();
    await done;
    expect(doc.$elements).toEqual([{ $ref: "../components/hero-block.json" }]);
  });

  test("cancel leaves the document untouched", async () => {
    tab.session.selection = ["children", 0];
    const done = convertToComponent();
    await flush();
    dialog()!.dispatchEvent(new Event("cancel"));
    await done;

    const doc = tab.doc.document as Record<string, unknown>;
    expect(((doc.children as unknown[])[0] as Record<string, unknown>).tagName).toBe("section");
    expect(doc.$elements).toBeUndefined();
    expect(platformState.calls.some((c) => c[0] === "writeFile")).toBe(false);
  });

  test("a failing write is caught and still leaves the document converted", async () => {
    installMockPlatform({
      writeFile: async () => {
        throw new Error("disk full");
      },
    });
    tab.session.selection = ["children", 0];
    const done = convertToComponent();
    await flush();
    setName("hero-block");
    confirmDialog();
    await done; // Resolves despite the write error
    const doc = tab.doc.document as Record<string, unknown>;
    expect((doc.children as unknown[])[0]).toEqual({ tagName: "hero-block" });
  });
});

// ─── Name validation ──────────────────────────────────────────────────────────

describe("name validation", () => {
  async function startDialog() {
    tab.session.selection = ["children", 0];
    const done = convertToComponent();
    await flush();
    return { done };
  }

  function helpText() {
    return document.querySelector("#layer-dialog sp-help-text")?.textContent?.trim() ?? "";
  }

  test("missing hyphen shows an error and keeps the dialog open", async () => {
    const { done } = await startDialog();
    setName("plainname");
    confirmDialog();
    await flush();
    expect(dialog()).not.toBeNull();
    expect(helpText()).toContain("hyphen");
    dialog()!.dispatchEvent(new Event("cancel"));
    await done;
  });

  test("invalid characters show the naming-rule error", async () => {
    const { done } = await startDialog();
    setName("my--comp");
    confirmDialog();
    await flush();
    expect(dialog()).not.toBeNull();
    expect(helpText()).toContain("Lowercase");
    dialog()!.dispatchEvent(new Event("cancel"));
    await done;
  });

  test("existing component name is rejected", async () => {
    componentRegistry.push({ tagName: "taken-name" } as never);
    const { done } = await startDialog();
    setName("taken-name");
    confirmDialog();
    await flush();
    expect(dialog()).not.toBeNull();
    expect(helpText()).toContain("already exists");
    dialog()!.dispatchEvent(new Event("cancel"));
    await done;
  });

  test("live input feedback clears once the name becomes valid", async () => {
    const { done } = await startDialog();
    setName("bad");
    await flush();
    expect(helpText()).toContain("hyphen");
    setName("good-name");
    await flush();
    expect(helpText()).toBe("");
    confirmDialog();
    await done;
    const doc = tab.doc.document as Record<string, unknown>;
    expect((doc.children as unknown[])[0]).toEqual({ tagName: "good-name" });
  });

  test("Enter in the textfield confirms", async () => {
    const { done } = await startDialog();
    setName("enter-name");
    textfield().dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }));
    await done;
    const doc = tab.doc.document as Record<string, unknown>;
    expect((doc.children as unknown[])[0]).toEqual({ tagName: "enter-name" });
  });

  test("uppercase input is normalized to lowercase", async () => {
    const { done } = await startDialog();
    setName("  My-Widget ");
    confirmDialog();
    await done;
    const doc = tab.doc.document as Record<string, unknown>;
    expect((doc.children as unknown[])[0]).toEqual({ tagName: "my-widget" });
    expect(activeTab.value!.doc.dirty).toBe(true);
  });
});
