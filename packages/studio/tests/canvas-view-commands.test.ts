/**
 * The canvas view verbs — `canvas.setMode` / `setZoom` / `setEditZoom` — and `selection.set`.
 *
 * `canvas.setMode` is the record that retires `canvas.togglePreview`, the toggle six screenshots
 * went through: a toggle cannot say which state it ends in, so those six photographed whichever way
 * the default pointed. The tests that matter here are therefore the IDEMPOTENCE ones and the three
 * refusals — an unsupported mode, preview over a base mode it does not compose with, and a zoom
 * outside the range the controls silently clamp.
 */
import { resetWorkspaceWithTab } from "./harness";
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { createCommandRegistry } from "../src/commands/registry";
import { makeContext } from "../src/commands/context";
import { checkPlacements } from "../src/commands/levels";
import { activeTab, closeAllTabs, openTab } from "../src/workspace/workspace";
import { view } from "../src/view";
import type { CommandContext } from "../src/commands/context";
import type { CommandRegistry } from "../src/commands/registry";

// ─── Seams (all must precede the modules under test) ─────────────────────────

void mock.module("monaco-editor/esm/vs/editor/editor.api.js", () => ({
  MarkerSeverity: { Error: 8, Warning: 4 },
  Uri: { parse: (s: string) => ({ toString: () => s }) },
  editor: { create: () => ({}), createModel: () => ({}), setModelMarkers: () => {} },
}));
void mock.module("../src/canvas/canvas-live-render.js", () => ({
  initCanvasLiveRender: () => {},
  resolveCanvasDocument: () => Promise.resolve(null),
}));
void mock.module("../src/canvas/iframe-host.js", () => ({
  adoptCanvasPreviewMode: () => {},
  commitActiveEditSession: () => {},
  getEditBarAnchorRect: () => null,
  getEditSnapshot: () => ({ editing: false, snapshot: null }),
  mountIframeCanvas: () => Promise.resolve(),
  postApplyFormat: () => {},
  postStyleUpdateToStylebookHosts: () => {},
  requestCanvasEval: () => Promise.resolve(null),
  setToolbarRefresh: () => {},
}));
void mock.module("../src/panels/welcome-screen.js", () => ({
  initWelcome: () => {},
  renderWelcome: () => {},
}));
void mock.module("../src/panels/editors.js", () => ({
  registerFunctionCompletions: () => {},
  renderFunctionEditor: () => {},
}));
void mock.module("../src/panels/formula-workspace.js", () => ({
  closeFormulaWorkspace: () => {},
  formulaRoot: () => null,
  renderFormulaWorkspace: () => {},
}));
void mock.module("../src/panels/statusbar.js", () => ({
  forgetSavedTimes: () => {},
  mountStatusbar: () => {},
  noteDocumentSaved: () => {},
  renderStatusbar: () => {},
  unmountStatusbar: () => {},
}));
void mock.module("../src/panels/overlays.js", () => ({
  mount: () => {},
  render: () => {},
  unmount: () => {},
}));
void mock.module("../src/panels/stylebook-panel.js", () => ({
  renderStylebookMode: () => {},
  selectStylebookTag: () => {},
}));
void mock.module("../src/files/file-ops.js", () => ({
  parseSourceForPath: () => null,
  serializeDocument: () => "",
}));

const {
  CANVAS_MODES,
  canvasViewCommands,
  EDIT_ZOOM_MAX,
  EDIT_ZOOM_MIN,
  initCanvasUtils,
  PAN_ZOOM_MAX,
  PAN_ZOOM_MIN,
  getFit,
  hasDeclaredFit,
  registerCanvasViewCommands,
  resetFits,
} = await import("../src/canvas/canvas-utils");
const { registerSelectionSetCommand, selectionCommands } =
  await import("../src/canvas/canvas-render");

// ─── Context ──────────────────────────────────────────────────────────────────

let canvasMode = "design";
const setCanvasMode = mock((mode: string) => {
  canvasMode = mode;
  const tab = activeTab.value;
  if (tab) {
    tab.session.ui.canvasMode = mode;
  }
});
const deps = { getCanvasMode: () => canvasMode, setCanvasMode };

let ctx: CommandContext = makeContext();
let registry: CommandRegistry;

const DOC = {
  children: [{ children: [{ tagName: "span" }], tagName: "p", textContent: "Hi" }],
  tagName: "div",
};

function openWith(modes: string[]) {
  closeAllTabs();
  return openTab({
    capabilities: { modes },
    document: structuredClone(DOC),
    documentPath: "pages/index.json",
    id: "t1",
  });
}

beforeEach(() => {
  canvasMode = "design";
  setCanvasMode.mockClear();
  resetFits();
  view.panzoomWrap = null;
  initCanvasUtils({ getCanvasMode: () => canvasMode, getZoom: () => 1, setZoomDirect: () => {} });
  ctx = makeContext({ document: { open: true } });
  registry = createCommandRegistry({ getContext: () => ctx });
  registerCanvasViewCommands(registry, deps);
  registerSelectionSetCommand(registry);
  openWith(["edit", "design", "preview", "source"]);
});

describe("the records themselves", () => {
  test("satisfy the level × placement matrix", () => {
    expect(checkPlacements([...canvasViewCommands(deps), ...selectionCommands()])).toEqual([]);
  });

  test("are all idempotent setters", () => {
    const ids = registry.list().map((c) => c.id);
    expect(ids).toEqual([
      "canvas.setMode",
      "canvas.setZoom",
      "canvas.setFit",
      "canvas.setEditZoom",
      "selection.set",
    ]);
    expect(ids.some((id) => /\.toggle[A-Z]/.test(id))).toBe(false);
  });

  test("canvas.setMode's enum is the observable mode set, preview included", () => {
    const schema = registry.get("canvas.setMode")?.args as {
      properties: { mode: { enum: string[] } };
    };
    expect(schema.properties.mode.enum).toEqual([...CANVAS_MODES]);
    expect(schema.properties.mode.enum).toContain("preview");
  });
});

describe("canvas.setMode", () => {
  test("sets the base mode and leaves preview off", () => {
    void registry.run("canvas.setMode", { mode: "edit" });
    expect(setCanvasMode).toHaveBeenCalledWith("edit");
    expect(activeTab.value?.session.ui.preview).toBe(false);
  });

  test('"preview" turns the flag on without changing the base mode', () => {
    void registry.run("canvas.setMode", { mode: "preview" });
    expect(activeTab.value?.session.ui.preview).toBe(true);
    // The tab opened in its first declared mode ("edit"); preview composes with it and leaves it.
    expect(activeTab.value?.session.ui.canvasMode).toBe("edit");
    expect(setCanvasMode).not.toHaveBeenCalled();
  });

  test("running preview twice ends in preview — the toggle it replaces did not", () => {
    void registry.run("canvas.setMode", { mode: "preview" });
    void registry.run("canvas.setMode", { mode: "preview" });
    expect(activeTab.value?.session.ui.preview).toBe(true);
  });

  test("arriving anywhere else turns preview back off", () => {
    void registry.run("canvas.setMode", { mode: "preview" });
    void registry.run("canvas.setMode", { mode: "design" });
    expect(activeTab.value?.session.ui.preview).toBe(false);
  });

  test("refuses a mode the open document does not declare", () => {
    openWith(["grid", "source"]);
    expect(() => registry.run("canvas.setMode", { mode: "design" })).toThrow(
      'command "canvas.setMode" argument "mode": "design" is not a mode this document ' +
        "supports — it declares: grid, source",
    );
  });

  test("refuses preview over a base mode it does not compose with", () => {
    activeTab.value!.session.ui.canvasMode = "source";
    expect(() => registry.run("canvas.setMode", { mode: "preview" })).toThrow(
      'composes with the edit and design base modes; this pane is in "source"',
    );
  });

  test("refuses an undeclared mode string", () => {
    expect(() => registry.run("canvas.setMode", { mode: "zen" })).toThrow('"zen" is not declared');
  });

  test("refuses when no tab is open", () => {
    closeAllTabs();
    expect(() => registry.run("canvas.setMode", { mode: "edit" })).toThrow(
      "needs an open document; no tab is active",
    );
  });
});

describe("canvas.setZoom", () => {
  test("writes the pan-zoom on the active tab", () => {
    void registry.run("canvas.setZoom", { zoom: 0.6 });
    expect(activeTab.value?.session.ui.zoom).toBe(0.6);
  });

  test("REJECTS out of range rather than clamping to the maximum", () => {
    expect(() => registry.run("canvas.setZoom", { zoom: PAN_ZOOM_MAX + 1 })).toThrow(
      "outside the supported range",
    );
    expect(() => registry.run("canvas.setZoom", { zoom: PAN_ZOOM_MIN / 2 })).toThrow(
      "outside the supported range",
    );
  });

  test("refuses when no tab is open", () => {
    closeAllTabs();
    expect(() => registry.run("canvas.setZoom", { zoom: 1 })).toThrow("needs an open document");
  });
});

describe("canvas.setFit", () => {
  test("declares each named fit on the active document", () => {
    for (const fit of ["width", "page", "none"] as const) {
      void registry.run("canvas.setFit", { fit });
      expect(getFit()).toBe(fit);
    }
    expect(hasDeclaredFit()).toBe(true);
  });

  test('a number is a fit — "the author chose 84%" is the fit 0.84', () => {
    void registry.run("canvas.setFit", { fit: 0.84 });
    expect(getFit()).toBe(0.84);
  });

  test("REJECTS a word that is not a fit and a scale outside the range", () => {
    // The runner maps `open.fit` straight onto this record, so a typo in a manifest has to fail the
    // Shot rather than silently leave the document at whatever the last one framed it as.
    expect(() => registry.run("canvas.setFit", { fit: "fill" })).toThrow('argument "fit"');
    expect(() => registry.run("canvas.setFit", { fit: PAN_ZOOM_MAX + 1 })).toThrow(
      'argument "fit"',
    );
    expect(() => registry.run("canvas.setFit", { fit: null })).toThrow('argument "fit"');
    expect(hasDeclaredFit()).toBe(false);
  });

  test("refuses when no tab is open", () => {
    closeAllTabs();
    expect(() => registry.run("canvas.setFit", { fit: "page" })).toThrow("needs an open document");
  });
});

describe("canvas.setEditZoom", () => {
  test("writes the content zoom when the pane is in edit mode", () => {
    canvasMode = "edit";
    void registry.run("canvas.setEditZoom", { zoom: 1.5 });
    expect(activeTab.value?.session.ui.editZoom).toBe(1.5);
  });

  test("is disabled outside edit mode, with a reason", () => {
    canvasMode = "design";
    expect(registry.isEnabled("canvas.setEditZoom")).toBe(false);
    expect(registry.disabledReason("canvas.setEditZoom")).toBe("a document in edit mode");
  });

  test("rejects a zoom outside the edit range", () => {
    canvasMode = "edit";
    expect(() => registry.run("canvas.setEditZoom", { zoom: EDIT_ZOOM_MAX + 1 })).toThrow(
      "outside the supported range",
    );
    expect(() => registry.run("canvas.setEditZoom", { zoom: EDIT_ZOOM_MIN - 0.01 })).toThrow(
      "outside the supported range",
    );
  });

  test("refuses when no tab is open", () => {
    canvasMode = "edit";
    closeAllTabs();
    expect(() => registry.run("canvas.setEditZoom", { zoom: 1 })).toThrow("needs an open document");
  });
});

describe("selection.set", () => {
  test("selects a node the document holds", () => {
    void registry.run("selection.set", { path: ["children", 0] });
    expect(activeTab.value?.session.selection).toEqual(["children", 0]);
  });

  test("the empty path is the document root, not an absence", () => {
    void registry.run("selection.set", { path: [] });
    expect(activeTab.value?.session.selection).toEqual([]);
  });

  test("null clears the selection", () => {
    void registry.run("selection.set", { path: ["children", 0] });
    void registry.run("selection.set", { path: null });
    expect(activeTab.value?.session.selection).toBeNull();
  });

  test("refuses a path that addresses nothing, naming the document", () => {
    expect(() => registry.run("selection.set", { path: ["children", 9] })).toThrow(
      'command "selection.set" argument "path": [children, 9] addresses no node in ' +
        "pages/index.json",
    );
    expect(activeTab.value?.session.selection).toBeNull();
  });

  test("refuses a path that is not an array", () => {
    expect(() => registry.run("selection.set", { path: "children/0" })).toThrow(
      "expected an array of path segments",
    );
  });

  test("refuses when no tab is open", () => {
    closeAllTabs();
    ctx = makeContext({ document: { open: true } });
    expect(() => registry.run("selection.set", { path: [] })).toThrow("needs an open document");
  });

  test("is hidden with no document", () => {
    ctx = makeContext();
    expect(registry.isVisible("selection.set")).toBe(false);
  });

  test("a tab whose documentPath is null still names itself in the refusal", () => {
    closeAllTabs();
    openTab({ document: structuredClone(DOC), documentPath: null, id: "virtual" });
    expect(() => registry.run("selection.set", { path: ["nope"] })).toThrow("the open document");
  });
});

describe("the harness tab shape is what these verbs expect", () => {
  test("resetWorkspaceWithTab yields a selectable root", () => {
    resetWorkspaceWithTab();
    void registry.run("selection.set", { path: [] });
    expect(activeTab.value?.session.selection).toEqual([]);
  });
});
