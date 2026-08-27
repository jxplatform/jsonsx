/**
 * Project Settings is not a canvas — the scope resolution, and the paste it used to permit.
 *
 * The defect this file pins was reproducible with every gate green. `tabs/tab.ts` and
 * `commands/live-context.ts` each held their OWN copy of the mode → editor-kind map, and neither
 * had learned about `settings` when Project Settings became a document (P6.2). Both fell through to
 * `?? "canvas"`, so with the `project.json` tab on screen in its settings editor the command
 * context reported `editor.kind === "canvas"` and `keyScopeStack` returned the CANVAS stack.
 * `edit.paste` — `keyScope: "canvas"`, `when: ctx.document.open` — was therefore both live to the
 * chord and enabled to the palette, and `pasteNode()` with nothing selected pastes into
 * `tab.doc.document`, which for that tab IS the project configuration. An element node went into
 * `project.json`, through the transaction log, and was saved.
 *
 * Two halves, both asserted here against the real chain (`createLiveContext` →
 * `createCommandRegistry` → `registerStudioCommands` → `initShortcuts`, with the real
 * `context-menu.ts` clipboard implementation behind `edit.paste`):
 *
 * - The SCOPE: `settings` resolves to the `config` editor kind, so the stack is `global`;
 * - The AVAILABILITY: a `keyScope` gates the keyboard only, so the canvas verbs also declare the
 *   canvas in their `when` — otherwise the palette, `__jxAutomation` and the assistant walk around
 *   the scope stack entirely.
 *
 * The control case (the same chord over an ordinary page) runs beside each, because a test that
 * only asserts a refusal passes just as well when the command was never registered.
 */
import {
  flush,
  installMockPlatform,
  registerPrimaryStage,
  resetStudioState,
  resetWorkspaceWithTab,
} from "./harness";
import { beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { notifyModule } from "./notify-mock";

import type { CommandRegistry } from "../src/commands/registry";
import type { Tab } from "../src/tabs/tab";
import { surfaceForPane } from "../src/canvas/surface-registry";

// ─── Module mocks (must precede the modules under test) ──────────────────────
// `context-menu.ts` is deliberately NOT mocked: its `pasteNode` is the implementation behind
// `edit.paste`, and the mutation it would perform is the whole subject of this file. Its two dialog
// Collaborators are, because neither has anything to do with the clipboard.

const openQuickSearch = mock(() => {});
void mock.module("../src/panels/quick-search.js", () => ({ openQuickSearch }));

const convertToRepeater = mock(async () => {});
const convertToComponent = mock(async () => {});
void mock.module("../src/editor/convert-to-repeater.js", () => ({ convertToRepeater }));
void mock.module("../src/editor/convert-to-component.js", () => ({ convertToComponent }));

const notified = mock((_message: string) => {});
void mock.module("../src/services/notify.js", () => notifyModule((call) => notified(call.message)));

const { initShortcuts, registerStudioCommands } = await import("../src/editor/shortcuts");
const { canvasViewForMode, editorKindForMode, keyScopeStack } =
  await import("../src/commands/context");
const { createCommandRegistry, CommandUnavailableError } = await import("../src/commands/registry");
const { createLiveContext } = await import("../src/commands/live-context");
const { SETTINGS_MODE } = await import("../src/settings/settings-document");
const { PROJECT_CONFIG_PATH } = await import("../src/tabs/tab");
const { initLayers, isModalOpen } = await import("../src/ui/layers");
const { activeTab, closeAllTabs, openTab } = await import("../src/workspace/workspace");
const { resetProjectShell, shell } = await import("../src/shell");
const store = await import("../src/store");

// ─── Clipboard ───────────────────────────────────────────────────────────────

const JX_MIME = "web application/jx+json";

/** The node on the clipboard — an ELEMENT, which is the thing `project.json` must never receive. */
const COPIED = { tagName: "p", textContent: "pasted" };

class FakeClipboardItem {
  types: string[];
  parts: Record<string, string>;
  constructor(parts: Record<string, string>) {
    this.parts = parts;
    this.types = Object.keys(parts);
  }
  getType(type: string) {
    return Promise.resolve({ text: () => Promise.resolve(this.parts[type]!) } as unknown as Blob);
  }
}

// ─── Environment ─────────────────────────────────────────────────────────────

globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
  setTimeout(() => cb(0), 0);
  return 0;
}) as typeof requestAnimationFrame;

/** The effective canvas mode, exactly as `studio.ts`'s `getCanvasMode` composes it. */
function canvasMode(): string {
  const ui = activeTab.value?.session.ui;
  const base = ui?.canvasMode ?? "design";
  return ui?.preview && (base === "edit" || base === "design") ? "preview" : base;
}

let registry: CommandRegistry;

beforeAll(() => {
  document.body.innerHTML = "";
  for (const id of [
    "activity-bar",
    "left-panel",
    "right-panel",
    "toolbar",
    "statusbar",
    "layer-popover",
    "layer-modal",
    "layer-dialog",
  ]) {
    const el = document.createElement("div");
    el.id = id;
    document.body.append(el);
  }
  store.initShellRefs();
  registerPrimaryStage();
  initLayers();
  installMockPlatform();
  resetStudioState({ isSiteProject: true, name: "demo", projectRoot: "/project" });

  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: {
      read: () => Promise.resolve([new FakeClipboardItem({ [JX_MIME]: JSON.stringify(COPIED) })]),
      write: () => Promise.resolve(),
      writeText: () => Promise.resolve(),
    },
  });

  const wrap = surfaceForPane("primary").wrap as unknown as Record<string, unknown>;
  wrap.setPointerCapture = () => {};
  wrap.releasePointerCapture = () => {};

  // `mac: false` pins `mod` to Ctrl, as `shortcuts.test.ts` does.
  registry = createCommandRegistry({
    getContext: createLiveContext({
      aiConfigured: () => false,
      canvasMode,
      isCaretActive: () => false,
      isModalOpen,
      platform: () => null,
    }),
    mac: false,
  });
  registerStudioCommands(
    registry,
    {
      buildSite: () => {},
      openInBrowser: () => {},
      openProject: async () => "opened" as const,
      saveDocument: () => {},
    },
    () => ({
      applyTransform: () => {},
      canvasMode: canvasMode(),
      panX: 0,
      panY: 0,
      setPan: () => {},
    }),
  );
  initShortcuts(registry, () => ({
    applyTransform: () => {},
    canvasMode: canvasMode(),
    panX: 0,
    panY: 0,
    setPan: () => {},
  }));
});

beforeEach(() => {
  notified.mockClear();
  resetProjectShell();
  shell.focusRegion = "pane";
  closeAllTabs();
});

/** The `project.json` tab exactly as `showSettingsDocument()` opens it: settings mode, first. */
function openSettingsTab(): Tab {
  return openTab({
    capabilities: { modes: [SETTINGS_MODE, "stylebook", "source"] },
    document: { name: "demo", version: "1.0.0" } as unknown as Record<string, unknown>,
    documentPath: PROJECT_CONFIG_PATH,
    id: PROJECT_CONFIG_PATH,
  }) as unknown as Tab;
}

function pressDoc(key: string, init: KeyboardEventInit = {}) {
  const e = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key, ...init });
  document.dispatchEvent(e);
  return e;
}

// ─── Select All, which used to be two ways of doing nothing ──────────────────

describe("selection.selectAll", () => {
  /**
   * ⌘A was forwarded out of the canvas frame AND `preventDefault`ed on the way, with no record
   * bound to it — so it neither selected the paragraph's text nor selected anything structurally.
   * The frame half is fixed by resolving against the keymap (`canvas/iframe-keys.ts`); this is the
   * half that gives the chord something to do when no caret owns the keyboard.
   */
  function openDoc(): Tab {
    return openTab({
      document: {
        children: [
          { tagName: "h1", textContent: "Title" },
          { tagName: "p", textContent: "One" },
          { tagName: "p", textContent: "Two" },
        ],
        tagName: "div",
      } as unknown as Record<string, unknown>,
      documentPath: "pages/index.json",
      id: "pages/index.json",
    }) as unknown as Tab;
  }

  test("selects every sibling of the selection, in document order", () => {
    const tab = openDoc();
    tab.session.selection = [["children", 1]];
    void registry.run("selection.selectAll");
    expect(tab.session.selection).toEqual([
      ["children", 0],
      ["children", 1],
      ["children", 2],
    ]);
  });

  test("with nothing selected it takes the root's children — what a reader means by all of it", () => {
    const tab = openDoc();
    tab.session.selection = [];
    void registry.run("selection.selectAll");
    expect(tab.session.selection).toHaveLength(3);
  });

  test("from the root, whose siblings are none, it still selects the root's children", () => {
    const tab = openDoc();
    tab.session.selection = [[]];
    void registry.run("selection.selectAll");
    expect(tab.session.selection).toHaveLength(3);
  });

  test("a text-only block yields its ELEMENT children, never a raw string's path", () => {
    // A string child has no node, so a path to one is a path `getNodeAtPath` answers with a string
    // And every structural verb then mishandles.
    const tab = openTab({
      document: {
        children: [{ children: ["hello", { tagName: "em", textContent: "there" }], tagName: "p" }],
        tagName: "div",
      } as unknown as Record<string, unknown>,
      documentPath: "pages/text.json",
      id: "pages/text.json",
    }) as unknown as Tab;
    tab.session.selection = [["children", 0, "children", 1]];
    void registry.run("selection.selectAll");
    expect(tab.session.selection).toEqual([["children", 0, "children", 1]]);
  });

  test("it is canvas-scoped, so a caret keeps ⌘A for its own sentence", () => {
    expect(registry.get("selection.selectAll")?.keyScope).toBe("canvas");
    expect(registry.keymap.declaredFor("selection.selectAll")).toEqual(["mod+a"]);
  });
});

// ─── The map, in one place ───────────────────────────────────────────────────

describe("mode → editor kind", () => {
  test("the settings editor is a config editor, not a canvas", () => {
    expect(editorKindForMode(SETTINGS_MODE)).toBe("config");
    // Pinned to the module that DECLARES the mode string, so renaming it on one side fails here
    // Rather than silently restoring the `?? "canvas"` fall-through.
    expect(SETTINGS_MODE).toBe("settings");
  });

  test("every editor `project.json` opens under is a non-canvas kind", () => {
    for (const mode of [SETTINGS_MODE, "stylebook", "source"]) {
      expect(editorKindForMode(mode)).not.toBe("canvas");
    }
  });

  test.each([
    ["edit", "canvas", "edit"],
    ["design", "canvas", "design"],
    ["preview", "canvas", "preview"],
    ["source", "code", "design"],
    ["grid", "grid", "design"],
    ["stylebook", "config", "design"],
    ["git-diff", "diff", "design"],
    ["manage", "library", "design"],
    ["settings", "config", "design"],
  ])("%s → kind %s / view %s", (mode, kind, view) => {
    expect(editorKindForMode(mode)).toBe(kind as never);
    expect(canvasViewForMode(mode)).toBe(view as never);
  });

  test("a mode only a format declares still reads as a canvas view of the artboard", () => {
    expect(editorKindForMode("gallery")).toBe("canvas");
    expect(canvasViewForMode("gallery")).toBe("design");
  });
});

// ─── The scope stack ─────────────────────────────────────────────────────────

describe("keyboard scope over the settings document", () => {
  test("the settings document resolves to the global stack, not the canvas one", () => {
    openSettingsTab();
    const ctx = registry.context();
    expect(ctx.editor.kind).toBe("config");
    expect(keyScopeStack(ctx)).toEqual(["global"]);
  });

  test("the same tab in its raw-JSON editor is the code stack", () => {
    const tab = openSettingsTab();
    tab.session.ui.canvasMode = "source";
    expect(keyScopeStack(registry.context())).toEqual(["code", "global"]);
  });

  test("an ordinary page is still the canvas stack", () => {
    resetWorkspaceWithTab();
    expect(registry.context().editor.kind).toBe("canvas");
    expect(keyScopeStack(registry.context())).toEqual(["canvas", "global"]);
  });
});

// ─── The reproduction ────────────────────────────────────────────────────────

describe("⌘V over Project Settings", () => {
  test("does not insert an element node into project.json", async () => {
    const tab = openSettingsTab();
    const before = JSON.stringify(tab.doc.document);
    // The reviewer's step 3: a section button in the inner nav has focus. It is not a text control,
    // So `caret.active` is false and the caret stack does not save us either.
    const navButton = document.createElement("button");
    document.body.append(navButton);
    navButton.focus();

    const event = pressDoc("v", { ctrlKey: true });
    await flush();

    expect(JSON.stringify(tab.doc.document)).toBe(before);
    expect(tab.doc.dirty).toBe(false);
    expect(tab.history.snapshots).toHaveLength(1);
    // Nothing claimed the chord, so the browser's own paste is not swallowed either.
    expect(event.defaultPrevented).toBe(false);
    expect(notified).not.toHaveBeenCalled();
    navButton.remove();
  });

  test("still pastes into an ordinary page (the control)", async () => {
    const tab = resetWorkspaceWithTab({
      children: [{ tagName: "p", textContent: "one" }],
      tagName: "div",
    }) as unknown as Tab;

    const event = pressDoc("v", { ctrlKey: true });
    await flush();

    expect(event.defaultPrevented).toBe(true);
    expect(tab.doc.document.children).toEqual([
      { tagName: "p", textContent: "one" },
      COPIED,
    ] as never);
    expect(notified).toHaveBeenCalledWith("Pasted");
  });
});

// ─── Availability, which is not the same question ────────────────────────────

describe("canvas verbs over a non-canvas editor", () => {
  /** Every verb `shortcuts.ts` files under `keyScope: "canvas"`. */
  const CANVAS_VERBS = [
    "edit.copy",
    "edit.cut",
    "edit.paste",
    "selection.insertSibling",
    "selection.selectPrevious",
    "selection.selectNext",
    "selection.selectFirstChild",
    "canvas.zoomReset",
    "canvas.zoomIn",
    "canvas.zoomOut",
  ];

  test("none of them is visible to the palette over the settings document", () => {
    const tab = openSettingsTab();
    // A selection is set, so nothing here passes merely for want of one: the editor kind is the
    // Fact being asserted.
    tab.session.selection = [["children", 0]];
    for (const id of CANVAS_VERBS) {
      expect(`${id}: ${registry.isVisible(id)}`).toBe(`${id}: false`);
    }
  });

  test("the palette cannot run edit.paste over the settings document", async () => {
    const tab = openSettingsTab();
    const before = JSON.stringify(tab.doc.document);
    let thrown: unknown;
    try {
      await registry.run("edit.paste");
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(CommandUnavailableError);
    await flush();
    expect(JSON.stringify(tab.doc.document)).toBe(before);
  });

  test("all of them are available again over a page canvas", () => {
    const tab = resetWorkspaceWithTab({
      children: [{ tagName: "p", textContent: "one" }],
      tagName: "div",
    }) as unknown as Tab;
    tab.session.selection = [["children", 0]];
    for (const id of CANVAS_VERBS) {
      expect(`${id}: ${registry.isVisible(id)}`).toBe(`${id}: true`);
    }
  });
});
