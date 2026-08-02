/**
 * Tests for src/commands/live-context.ts and `keyScopeStack` in src/commands/context.ts.
 *
 * The live context is the one place the registry's predicates meet real state, so these assert the
 * projection itself — shell → `focus`/`git`, activeTab → `document`/`selection`/`collab`,
 * `projectState` → `project`, and the PAL's optional methods → `capability.*` — and then the pure
 * scope-stack function the keyboard derives from it.
 */
import { installMockPlatform, resetStudioState, resetWorkspaceWithTab } from "./harness";
import { beforeEach, describe, expect, test } from "bun:test";

import { keyScopeStack, makeContext } from "../src/commands/context";
import { createLiveContext, isTextEntryFocused } from "../src/commands/live-context";
import { shell, resetProjectShell } from "../src/shell";
import { activeTab, closeAllTabs } from "../src/workspace/workspace";
import { componentRegistry } from "../src/files/components";
import { setProjectState } from "../src/store";
import { transactDoc, mutateRemoveNode } from "../src/tabs/transact";
import type { GitStatusResult, StudioPlatform } from "../src/types";
import type { LiveContextSources } from "../src/commands/live-context";

let canvasMode = "design";
let caretActive = false;
let modalOpen = false;
let aiConfigured = false;

function sources(overrides: Partial<LiveContextSources> = {}): LiveContextSources {
  return {
    aiConfigured: () => aiConfigured,
    canvasMode: () => canvasMode,
    isCaretActive: () => caretActive,
    isModalOpen: () => modalOpen,
    platform: () => null,
    ...overrides,
  };
}

const context = () => createLiveContext(sources())();

beforeEach(() => {
  canvasMode = "design";
  caretActive = false;
  modalOpen = false;
  aiConfigured = false;
  document.body.innerHTML = "";
  componentRegistry.length = 0;
  resetProjectShell();
  shell.focusRegion = "pane";
  installMockPlatform();
  resetStudioState({ isSiteProject: true, name: "demo", projectRoot: "/project" });
  resetWorkspaceWithTab({
    children: [{ tagName: "p", textContent: "one" }, { tagName: "jx-card" }],
    tagName: "div",
  });
});

// ─── Project and git ──────────────────────────────────────────────────────────

describe("project and git", () => {
  test("a loaded site project reports open + isSite", () => {
    const ctx = context();
    expect(ctx.project.open).toBe(true);
    expect(ctx.project.isSite).toBe(true);
  });

  test("no project state means nothing is open", () => {
    // ResetStudioState installs a bare record; clearing it entirely is the cold-start case.
    setProjectState(null);
    const ctx = context();
    expect(ctx.project.open).toBe(false);
    expect(ctx.project.isSite).toBe(false);
  });

  test("git counts come from the shell record, not from the focused tab", () => {
    shell.git.status = {
      ahead: 2,
      behind: 3,
      branch: "main",
      files: [{ path: "a.md", status: "M" }],
      isRepo: true,
      remotes: [],
    } satisfies GitStatusResult;
    const ctx = context();
    expect(ctx.project.isRepo).toBe(true);
    expect(ctx.git).toEqual({ ahead: 2, behind: 3, dirtyCount: 1 });
  });

  test("a project git has not answered for yet is not a repo", () => {
    const ctx = context();
    expect(ctx.project.isRepo).toBe(false);
    expect(ctx.git).toEqual({ ahead: 0, behind: 0, dirtyCount: 0 });
  });
});

// ─── Document, editor, selection ──────────────────────────────────────────────

describe("document and editor", () => {
  test("an open tab reports its dirty flag, mode and history", () => {
    const tab = activeTab.value!;
    tab.doc.dirty = true;
    tab.doc.mode = "content";
    expect(context().document).toEqual({
      canRedo: false,
      canUndo: false,
      dirty: true,
      mode: "content",
      open: true,
    });

    transactDoc(tab, (t) => mutateRemoveNode(t, ["children", 0]));
    expect(context().document.canUndo).toBe(true);
  });

  test("no tab is a closed document in no editor", () => {
    closeAllTabs();
    const ctx = context();
    expect(ctx.document.open).toBe(false);
    expect(ctx.editor.kind).toBe("none");
    expect(ctx.pane.count).toBe(0);
  });

  test.each([
    ["design", "canvas", "design"],
    ["edit", "canvas", "edit"],
    ["preview", "canvas", "preview"],
    ["grid", "grid", "design"],
    ["source", "code", "design"],
    ["git-diff", "diff", "design"],
    ["manage", "library", "design"],
    ["stylebook", "config", "design"],
  ])("canvasMode %s → editor.kind %s / canvas.view %s", (mode, kind, canvasView) => {
    canvasMode = mode;
    const ctx = context();
    expect(ctx.editor.kind).toBe(kind as never);
    expect(ctx.canvas.view).toBe(canvasView as never);
  });

  test("an unrecognised canvas mode still reports a canvas", () => {
    canvasMode = "something-new";
    expect(context().editor.kind).toBe("canvas");
  });
});

describe("selection", () => {
  test("nothing selected is a count of zero", () => {
    const ctx = context();
    expect(ctx.selection.count).toBe(0);
    expect(ctx.selection.isRoot).toBe(false);
    expect(ctx.selection.kind).toBe("");
  });

  test("a nested selection reports its tag and is not the root", () => {
    activeTab.value!.session.selection = ["children", 0];
    const ctx = context();
    expect(ctx.selection.count).toBe(1);
    expect(ctx.selection.kind).toBe("p");
    expect(ctx.selection.isRoot).toBe(false);
  });

  test("the document element is a selection of one, and IS the root", () => {
    activeTab.value!.session.selection = [];
    const ctx = context();
    expect(ctx.selection.count).toBe(1);
    expect(ctx.selection.isRoot).toBe(true);
    expect(ctx.selection.kind).toBe("div");
  });

  test("a registered component tag reads as an instance", () => {
    componentRegistry.push({ path: "/project/card.jx.json", tagName: "jx-card" } as never);
    activeTab.value!.session.selection = ["children", 1];
    expect(context().selection.isComponentInstance).toBe(true);
    activeTab.value!.session.selection = ["children", 0];
    expect(context().selection.isComponentInstance).toBe(false);
  });

  test("layout chrome is flagged separately from the document selection", () => {
    expect(context().selection.isLayoutNode).toBe(false);
    shell.layoutSelection = { path: [], source: "layout" } as never;
    expect(context().selection.isLayoutNode).toBe(true);
  });
});

// ─── Caret, focus, modal ──────────────────────────────────────────────────────

describe("caret, focus and modal", () => {
  test("the canvas caret flag comes straight from the bridge", () => {
    expect(context().caret.active).toBe(false);
    caretActive = true;
    expect(context().caret.active).toBe(true);
  });

  test.each(["input", "textarea", "select", "sp-textfield", "sp-search", "sp-number-field"])(
    "a focused %s owns the keyboard exactly as a canvas caret does",
    (tag) => {
      const el = document.createElement(tag);
      el.setAttribute("tabindex", "0");
      document.body.append(el);
      el.focus();
      expect(isTextEntryFocused()).toBe(true);
      expect(context().caret.active).toBe(true);
    },
  );

  test("a focused button does not", () => {
    const el = document.createElement("button");
    document.body.append(el);
    el.focus();
    expect(isTextEntryFocused()).toBe(false);
    expect(context().caret.active).toBe(false);
  });

  test("focus region and modal state are read live", () => {
    shell.focusRegion = "navigator";
    modalOpen = true;
    const ctx = context();
    expect(ctx.focus.region).toBe("navigator");
    expect(ctx.modal.open).toBe(true);
  });
});

// ─── Collaboration, AI, capabilities ──────────────────────────────────────────

describe("collab, ai and capabilities", () => {
  test("a tab with no session is detached and writable", () => {
    expect(context().collab).toEqual({
      attached: false,
      readOnly: false,
      sourceCanonical: false,
    });
  });

  test("ai.streaming defaults to false when no probe is supplied", () => {
    aiConfigured = true;
    const ctx = createLiveContext(sources())();
    expect(ctx.ai).toEqual({ configured: true, streaming: false });
  });

  test("ai.streaming is read from the probe when there is one", () => {
    const ctx = createLiveContext(sources({ aiStreaming: () => true }))();
    expect(ctx.ai.streaming).toBe(true);
  });

  test("with no platform every capability is off", () => {
    expect(context().capability).toEqual({
      dataRows: false,
      findReferences: false,
      gitClone: false,
      importSite: false,
      openProjectInNewWindow: false,
      windowControls: false,
    });
  });

  test("capabilities are presence-of-method on the PAL", () => {
    const { platform } = installMockPlatform({
      dataRows: (async () => ({})) as never,
      gitClone: (async () => ({ ok: true, root: "/x" })) as never,
      newWindow: (async () => {}) as never,
    });
    const ctx = createLiveContext(sources({ platform: () => platform as StudioPlatform }))();
    expect(ctx.capability).toEqual({
      dataRows: true,
      // The harness's mock ships codeService, which is what backs Find References.
      findReferences: true,
      gitClone: true,
      importSite: false,
      openProjectInNewWindow: false,
      windowControls: true,
    });
  });
});

// ─── The scope stack ──────────────────────────────────────────────────────────

describe("keyScopeStack", () => {
  test("an open modal owns the keyboard outright", () => {
    expect(keyScopeStack(makeContext({ modal: { open: true } }))).toEqual(["palette"]);
    // Even against a caret, which is otherwise the narrowest scope.
    expect(keyScopeStack(makeContext({ caret: { active: true }, modal: { open: true } }))).toEqual([
      "palette",
    ]);
  });

  test("a caret shadows the canvas but not the app", () => {
    expect(keyScopeStack(makeContext({ caret: { active: true } }))).toEqual(["caret", "global"]);
  });

  test.each(["rail", "navigator", "inspector", "dock", "status"] as const)(
    "focus in the %s region drops the pane's engine scope",
    (region) => {
      expect(keyScopeStack(makeContext({ focus: { region } }))).toEqual(["dock", "global"]);
    },
  );

  test.each([
    ["grid", "design", ["grid", "global"]],
    ["code", "design", ["code", "global"]],
    ["canvas", "design", ["canvas", "global"]],
    ["canvas", "edit", ["canvas", "global"]],
    // Preview posts no hits, so no element-level chord has anything visible to aim at.
    ["canvas", "preview", ["global"]],
    ["diff", "design", ["global"]],
    ["library", "design", ["global"]],
    ["none", "design", ["global"]],
  ])("editor %s / view %s → %p", (kind, view, expected) => {
    const ctx = makeContext({
      canvas: { view: view as never },
      editor: { kind: kind as never },
    });
    expect(keyScopeStack(ctx)).toEqual(expected as never);
  });

  test("the live context feeds the stack directly", () => {
    canvasMode = "grid";
    expect(keyScopeStack(context())).toEqual(["grid", "global"]);
    canvasMode = "design";
    caretActive = true;
    expect(keyScopeStack(context())).toEqual(["caret", "global"]);
  });
});
