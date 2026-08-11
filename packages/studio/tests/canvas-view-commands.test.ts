/**
 * The canvas pane's verbs — `canvas.setMode` / `setZoom` / `setEditZoom`, `selection.set`, and
 * `insert.data`.
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
import {
  activeTab,
  closeAllTabs,
  openTab,
  SECONDARY_PANE,
  splitRight,
  workspace,
} from "../src/workspace/workspace";
import type { CommandContext } from "../src/commands/context";
import type { Tab } from "../src/tabs/tab";
import type { CommandRegistry } from "../src/commands/registry";
import { surfaceForPane } from "../src/canvas/surface-registry";

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
/** What `insert.data` posted to the canvas bridge, and the caret path the host reports. */
const formatIntents: { command: string; token?: string }[] = [];
let caretPath: (string | number)[] | null = null;
void mock.module("../src/canvas/iframe-host.js", () => ({
  adoptCanvasPreviewMode: () => {},
  commitActiveEditSession: () => {},
  /* Three exports this file never calls, stubbed because a PARTIAL mock of a module the graph
     reaches is a load error rather than a missing stub at call time. canvas-render now draws the
     Library, whose creation flow is `files/files.ts`, which pulls `packages/ensure-deps` →
     `services/automation` → `services/idle` — and those two modules read `canvasIdleBlockers`,
     `canvasPointAt` and `revealCanvasPath` off the iframe host. */
  canvasIdleBlockers: () => [],
  canvasPointAt: () => Promise.resolve(null),
  revealCanvasPath: () => Promise.resolve(null),
  getEditBarAnchorRect: () => null,
  getEditSnapshot: () => ({
    editing: caretPath !== null,
    snapshot: caretPath && { path: caretPath },
  }),
  mountIframeCanvas: () => Promise.resolve(),
  postApplyFormat: (intent: { command: string; token?: string }) => {
    formatIntents.push(intent);
  },
  postStyleUpdateToStylebookHosts: () => {},
  requestCanvasEval: () => Promise.resolve(null),
  /* The non-lazy way out of `liveHosts`: `panels/pane-grid.ts` calls it as a cell is
     disposed, so it is on the import graph of anything that mounts the shell. */
  releaseCanvasHosts: () => 0,
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
  /* The Logic openers go through this: it sets the target AND reveals the tab. */
  openLogicTarget: () => {},
  renderFormulaWorkspace: () => {},
  /* The State panel's `formula.openWorkspace` reveals the dock tab instead of repainting. */
  revealLogicPanel: () => {},
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
  /* Two more the Library's context menu reads. canvas-render draws the Library now, so this
     partial mock has to cover what that path imports — see the iframe-host note above. */
  confirmFileDelete: () => Promise.resolve(false),
  renamePromptMessage: () => Promise.resolve(""),
  /* And one the TAB STRIP reads: its close offers to save first (§8.7's three-way dialog). */
  saveFile: () => Promise.resolve(true),
}));

const {
  CANVAS_MODES,
  canvasViewCommands,
  EDIT_ZOOM_MAX,
  EDIT_ZOOM_MIN,
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
/* Takes the TAB the command resolved, and writes into that one. The double used to take only a
   mode and resolve `activeTab.value` itself, which is precisely the conflation the injected
   `setCanvasMode` no longer permits: a double that finds its own target cannot tell "the right
   document changed" from "some document changed". */
const setCanvasMode = mock((tab: Tab | null, mode: string) => {
  canvasMode = mode;
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
  surfaceForPane("primary").panzoomWrap = null;
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
      // The rendering context's three axes (§4.2 control ③). The Context popover wrote
      // `session.ui` through `updateUi` directly, so none of the three was a command — not in the
      // Palette, not scriptable, not bindable. Setters, not cycles: a chord carries no argument, so
      // The `⌘⌥↑`/`⌘⌥⇧S` cycles §5.3 declares need `next`/`prev` records of their own.
      "canvas.setBreakpoint",
      "canvas.setColorScheme",
      "canvas.setLayoutVisible",
      "selection.set",
      "selection.setPaths",
      "insert.data",
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
    expect(setCanvasMode).toHaveBeenCalledWith(activeTab.value, "edit");
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

  /*
   * The DOCUMENT is the only thing that can refuse a mode.
   *
   * This used to refuse a second one: the side pane was capped to Code, Diff, Config, Entry, Grid
   * and Library, so `canvas.setMode { mode: "design" }` threw a sentence telling you to unsplit
   * first. The cap existed because a second live Canvas host was unaffordable, and it is gone —
   * `panels/pane-grid.ts` draws a stage per pane and `canvas/surface-registry.ts` gives each its
   * own panels, mode, pan and render generation. A Canvas in the side pane is the object the
   * primary has always had.
   */
  test("a Canvas mode goes through in the side pane — the cap that refused it is lifted", () => {
    openWith(["edit", "design", "source"]);
    splitRight();
    expect(workspace.activePaneId).toBe(SECONDARY_PANE);
    void registry.run("canvas.setMode", { mode: "design" });
    expect(setCanvasMode).toHaveBeenCalledWith(activeTab.value, "design");
    void registry.run("canvas.setMode", { mode: "source" });
    expect(setCanvasMode).toHaveBeenCalledWith(activeTab.value, "source");
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

/*
 * `insert.data` — the manifest's `element.insertData`, which had no record and was reached by
 * clicking the block action bar's Insert-data button and then a row in the menu it opens. §13.5
 * refuses that shape outright ("the ITEM is the command"), so the record takes the token.
 */
describe("insert.data", () => {
  const BOUND_DOC = {
    children: [
      {
        $prototype: "Array",
        items: { $ref: "#/state/posts" },
        map: { children: [{ tagName: "h3", textContent: "Post title" }], tagName: "article" },
      },
    ],
    state: { posts: { $prototype: "ContentCollection", contentType: "posts" } },
    tagName: "div",
  };

  function openBound() {
    closeAllTabs();
    return openTab({
      capabilities: { modes: ["edit", "design"] },
      document: structuredClone(BOUND_DOC),
      documentPath: "pages/blog.json",
      id: "bound",
    });
  }

  beforeEach(() => {
    formatIntents.length = 0;
    caretPath = null;
    ctx = makeContext({ caret: { active: true }, document: { open: true } });
    openBound();
  });

  test("is hidden without a live caret — a token has nowhere to land", () => {
    ctx = makeContext({ document: { open: true } });
    expect(registry.isVisible("insert.data")).toBe(false);
    expect(registry.get("insert.data")?.requires).toBe("a live text caret in the canvas");
  });

  test("posts the insertData intent for a state token the document defines", () => {
    void registry.run("insert.data", { token: "state.posts" });
    expect(formatIntents).toEqual([{ command: "insertData", token: "state.posts" }]);
  });

  test("accepts a nested walk under a defined state entry", () => {
    void registry.run("insert.data", { token: "state.posts.length" });
    expect(formatIntents).toHaveLength(1);
  });

  test("refuses a state entry the document does not define, listing what it does", () => {
    expect(() => registry.run("insert.data", { token: "state.authors" })).toThrow(
      'command "insert.data" argument "token": "state.authors" names no state entry — this ' +
        "document defines: posts",
    );
    expect(formatIntents).toEqual([]);
  });

  test('a bare "state" names no entry either', () => {
    expect(() => registry.run("insert.data", { token: "state" })).toThrow("names no state entry");
  });

  test("accepts item/index when the caret sits inside a repeater template", () => {
    caretPath = ["children", 0, "map", "children", 0];
    void registry.run("insert.data", { token: "item.data.title" });
    void registry.run("insert.data", { token: "index" });
    expect(formatIntents.map((i) => i.token)).toEqual(["item.data.title", "index"]);
  });

  test("falls back to the element selection when no caret snapshot is reported", () => {
    activeTab.value!.session.selection = [["children", 0, "map", "children", 0]];
    void registry.run("insert.data", { token: "item" });
    expect(formatIntents).toHaveLength(1);
  });

  test("refuses a repeater-scope token outside a repeater template", () => {
    expect(() => registry.run("insert.data", { token: "item.data.title" })).toThrow(
      "is a repeater-scope token, and the caret is not inside a repeater template",
    );
  });

  test("refuses a token that binds to nothing the vocabulary has", () => {
    expect(() => registry.run("insert.data", { token: "window.location" })).toThrow(
      'is not an insertable token — a token reads "state.<name>", "item", "item.<field>" or ' +
        '"index"',
    );
  });

  test("refuses an empty token rather than inserting an empty placeholder", () => {
    expect(() => registry.run("insert.data", { token: "" })).toThrow("expected a non-empty string");
  });

  test("refuses when no document is open", () => {
    closeAllTabs();
    expect(() => registry.run("insert.data", { token: "state.posts" })).toThrow(
      "needs an open document",
    );
  });
});

describe("selection.set", () => {
  test("selects a node the document holds", () => {
    void registry.run("selection.set", { path: ["children", 0] });
    expect(activeTab.value?.session.selection).toEqual([["children", 0]]);
  });

  test("the empty path is the document root, not an absence", () => {
    void registry.run("selection.set", { path: [] });
    expect(activeTab.value?.session.selection).toEqual([[]]);
  });

  test("null clears the selection", () => {
    void registry.run("selection.set", { path: ["children", 0] });
    void registry.run("selection.set", { path: null });
    expect(activeTab.value?.session.selection).toEqual([]);
  });

  test("refuses a path that addresses nothing, naming the document", () => {
    expect(() => registry.run("selection.set", { path: ["children", 9] })).toThrow(
      'command "selection.set" argument "path": [children, 9] addresses no node in ' +
        "pages/index.json",
    );
    expect(activeTab.value?.session.selection).toEqual([]);
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

describe("selection.setPaths", () => {
  test("selects several nodes, last one primary and first one anchor", () => {
    void registry.run("selection.setPaths", {
      paths: [
        ["children", 0],
        ["children", 0, "children", 0],
      ],
    });
    expect(activeTab.value?.session.selection).toEqual([
      ["children", 0],
      ["children", 0, "children", 0],
    ]);
  });

  test("one path in is exactly what selection.set would have done", () => {
    void registry.run("selection.setPaths", { paths: [["children", 0]] });
    const many = activeTab.value?.session.selection;
    void registry.run("selection.set", { path: ["children", 0] });
    expect(many).toEqual(activeTab.value!.session.selection);
  });

  test("[] selects nothing — the same state selection.set { path: null } reaches", () => {
    void registry.run("selection.set", { path: ["children", 0] });
    void registry.run("selection.setPaths", { paths: [] });
    expect(activeTab.value?.session.selection).toEqual([]);
  });

  test("is idempotent: the same list twice lands on the same selection", () => {
    const args = {
      paths: [
        ["children", 0],
        ["children", 0, "children", 0],
      ],
    };
    void registry.run("selection.setPaths", args);
    const first = JSON.stringify(activeTab.value?.session.selection);
    void registry.run("selection.setPaths", args);
    expect(JSON.stringify(activeTab.value?.session.selection)).toBe(first);
  });

  test("a repeated path is deduplicated, keeping the first occurrence", () => {
    void registry.run("selection.setPaths", {
      paths: [
        ["children", 0],
        ["children", 0, "children", 0],
        ["children", 0],
      ],
    });
    expect(activeTab.value?.session.selection).toEqual([
      ["children", 0],
      ["children", 0, "children", 0],
    ]);
  });

  test("refuses a path that addresses nothing, naming it and the document", () => {
    expect(() =>
      registry.run("selection.setPaths", {
        paths: [
          ["children", 0],
          ["children", 9],
        ],
      }),
    ).toThrow(
      'command "selection.setPaths" argument "paths": [children, 9] addresses no node in ' +
        "pages/index.json",
    );
  });

  test("refuses a bare path passed where a LIST of paths belongs", () => {
    expect(() => registry.run("selection.setPaths", { paths: ["children", 0] })).toThrow(
      "entry 0 is not a document path",
    );
  });

  test("refuses anything that is not an array at all", () => {
    expect(() => registry.run("selection.setPaths", { paths: "children/0" })).toThrow(
      "expected an array of document paths",
    );
  });

  test("refuses when no tab is open", () => {
    closeAllTabs();
    ctx = makeContext({ document: { open: true } });
    expect(() => registry.run("selection.setPaths", { paths: [] })).toThrow(
      "needs an open document",
    );
  });

  test("is hidden with no document", () => {
    ctx = makeContext();
    expect(registry.isVisible("selection.setPaths")).toBe(false);
  });
});

describe("the harness tab shape is what these verbs expect", () => {
  test("resetWorkspaceWithTab yields a selectable root", () => {
    resetWorkspaceWithTab();
    void registry.run("selection.set", { path: [] });
    expect(activeTab.value?.session.selection).toEqual([[]]);
  });
});

describe("the pan-zoom family agrees with itself", () => {
  /*
   * Found by driving Studio against a real site: with a Library pane focused, `canvas.setZoom` and
   * `canvas.setFit` SUCCEEDED — writing a zoom onto a surface that was not showing — in the same
   * state where `canvas.zoomIn`, `canvas.zoomOut` and `canvas.zoomReset` refused with "requires an
   * open document". Five verbs over one surface, two rules, and the two that disagreed were the
   * ones that WRITE.
   *
   * The rule is the mode, not merely the document: `pane-context.ts` already draws the zoom pod for
   * exactly design / stylebook / git-diff, and these two records now ask the same question.
   */
  const PANZOOM = ["design", "stylebook", "git-diff"];
  const OFF_SURFACE = ["edit", "preview", "source", "grid"];

  beforeEach(() => {
    resetWorkspaceWithTab();
    registry = createCommandRegistry({ getContext: () => ctx });
    registry.registerAll(canvasViewCommands(deps));
    ctx = makeContext({ document: { open: true } });
  });

  test("both are available on every pan-zoom mode", () => {
    for (const mode of PANZOOM) {
      canvasMode = mode;
      expect([mode, registry.isEnabled("canvas.setZoom")]).toEqual([mode, true]);
      expect([mode, registry.isEnabled("canvas.setFit")]).toEqual([mode, true]);
    }
  });

  test("and refused on every mode that has no pan-zoom surface", () => {
    for (const mode of OFF_SURFACE) {
      canvasMode = mode;
      expect([mode, registry.isEnabled("canvas.setZoom")]).toEqual([mode, false]);
      expect([mode, registry.isEnabled("canvas.setFit")]).toEqual([mode, false]);
    }
  });

  test("the refusal sentence names the gate, rather than the one it used to have", () => {
    canvasMode = "edit";
    // `canvas.setFit` said "an open document" while refusing for the MODE — a sentence that sends
    // The reader to open a document they already have open.
    expect(registry.disabledReason("canvas.setFit")).toBe("a document on the pan-zoom surface");
    expect(registry.disabledReason("canvas.setZoom")).toBe("a document on the pan-zoom surface");
  });
});
