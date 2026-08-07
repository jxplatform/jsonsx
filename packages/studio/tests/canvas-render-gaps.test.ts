/**
 * Canvas render gaps — the grid-mode dispatch paths and the source-mode collab binding
 * (createSourceCollabBinding + the collabCtx branch), which canvas-render.test.ts leaves uncovered.
 * Heavy collaborators (monaco, grid panel, iframe host, y-monaco, collab session) are mocked so the
 * dispatch runs deterministically.
 */
import { flush, resetStudioState, resetWorkspaceWithTab } from "./harness";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { initShellRefs } from "../src/store";
import { activeCanvasSurface } from "../src/canvas/canvas-surface";
import { activeTab, closeAllTabs } from "../src/workspace/workspace";
import { view } from "../src/view";
import { setFormats } from "../src/format/format-host";
import { initCanvasUtils } from "../src/canvas/canvas-utils";
import type { Tab } from "../src/tabs/tab";

/* The panels of the FOCUSED pane's stage. Panels belong to a pane's surface now, not to the
   app (`src/canvas/canvas-surface.ts`); the array identity is stable, so a module-level
   binding still sees what the render mutated. */
const surface = activeCanvasSurface();
const canvasPanels = surface.panels;

// ─── Controllable mock behavior ───────────────────────────────────────────────

interface FakeModel {
  _value: string;
  dispose: ReturnType<typeof mock>;
  getValue: () => string;
  setValue: (v: string) => void;
}
interface FakeEditor {
  _ignoreNextChange: boolean;
  _model: FakeModel | null;
  dispose: ReturnType<typeof mock>;
  getModel: () => FakeModel | null;
  getValue: () => string;
  hasTextFocus: () => boolean;
  onDidChangeModelContent: (cb: () => void) => void;
  setValue: (v: string) => void;
  updateOptions: ReturnType<typeof mock>;
}
const createdEditors: FakeEditor[] = [];

void mock.module("monaco-editor/esm/vs/editor/editor.api.js", () => ({
  MarkerSeverity: { Error: 8, Warning: 4 },
  Uri: { parse: (s: string) => ({ toString: () => s }) },
  editor: {
    create: (_el: HTMLElement, opts: { model?: FakeModel }) => {
      const ed: FakeEditor = {
        _ignoreNextChange: false,
        _model: opts?.model ?? null,
        // Mirrors Monaco: `dispose()` runs `_detachModel()`, so `getModel()` is null and
        // `getValue()` is `""` afterwards. See `tests/canvas-render.test.ts` for why that matters.
        dispose: mock(() => {
          ed._model = null;
        }),
        getModel: () => ed._model,
        getValue: () => ed._model?._value ?? "",
        hasTextFocus: () => false,
        onDidChangeModelContent: () => {},
        setValue: (v: string) => {
          if (ed._model) {
            ed._model._value = v;
          }
        },
        updateOptions: mock(() => {}),
      };
      createdEditors.push(ed);
      return ed;
    },
    createModel: (value: string) => {
      const m: FakeModel = {
        _value: value,
        dispose: mock(() => {}),
        getValue: () => m._value,
        setValue: (v: string) => {
          m._value = v;
        },
      };
      return m;
    },
    setModelMarkers: () => {},
  },
}));

void mock.module("../src/canvas/canvas-live-render.js", () => ({
  initCanvasLiveRender: () => {},
  resolveCanvasDocument: () => Promise.resolve(null),
}));

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
  getEditSnapshot: () => ({ editing: false, snapshot: null }),
  mountIframeCanvas: () => Promise.resolve(),
  postApplyFormat: () => {},
  postStyleUpdateToStylebookHosts: () => 0,
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
}));

void mock.module("../src/files/file-ops.js", () => ({
  parseSourceForPath: async () => ({ document: { tagName: "div" }, frontmatter: {} }),
  serializeDocument: async () => "{}",
  /* Two more the Library's context menu reads. canvas-render draws the Library now, so this
     partial mock has to cover what that path imports — see the iframe-host note above. */
  confirmFileDelete: () => Promise.resolve(false),
  renamePromptMessage: () => Promise.resolve(""),
  /* And one the TAB STRIP reads: its close offers to save first (§8.7's three-way dialog). */
  saveFile: () => Promise.resolve(true),
}));

// Grid panel: controllable mounted-state + render spy (the real panel needs tabulator).
let gridMounted = false;
const renderGridMode = mock((_host: HTMLElement, _tab: Tab) => {});
const detachGridPanel = mock(() => {});
void mock.module("../src/grid/grid-panel.js", () => ({
  detachGridPanel,
  gridPanelMounted: () => gridMounted,
  renderGridMode,
}));

// Collab session: a controllable collabSourceContext atop the real module surface.
interface FakeCollabCtx {
  awareness: unknown;
  enter: () => Promise<void>;
  leave: ReturnType<typeof mock>;
  localOrigin: unknown;
  readOnly: boolean;
  text: unknown;
}
let collabCtx: FakeCollabCtx | null = null;
const actualCollab = await import("../src/collab/collab-session");
void mock.module("../src/collab/collab-session.js", () => ({
  ...actualCollab,
  collabSourceContext: () => collabCtx,
}));

// Y-monaco: record constructed bindings.
const bindings: { destroyed: boolean; args: unknown[] }[] = [];
void mock.module("y-monaco", () => ({
  MonacoBinding: class {
    rec: { destroyed: boolean; args: unknown[] };
    constructor(...args: unknown[]) {
      this.rec = { args, destroyed: false };
      bindings.push(this.rec);
    }
    destroy() {
      this.rec.destroyed = true;
    }
  },
}));

const { initCanvasRender, renderCanvas } = await import("../src/canvas/canvas-render");

// ─── Test context ─────────────────────────────────────────────────────────────

let canvasMode = "design";

function setMode(m: string) {
  canvasMode = m;
  const tab = activeTab.value;
  if (tab) {
    tab.session.ui.canvasMode = m;
  }
}

function makeAwareness() {
  return {
    clientID: 9,
    getStates: () => new Map([[2, { user: { color: "#30a46c", login: "peer" } }]]),
    off: () => {},
    on: () => {},
  };
}

function makeCollabCtx(overrides: Partial<FakeCollabCtx> = {}): FakeCollabCtx {
  return {
    awareness: makeAwareness(),
    enter: () => Promise.resolve(),
    leave: mock(() => {}),
    localOrigin: {},
    readOnly: false,
    text: { toString: () => "" },
    ...overrides,
  };
}

function setupShell() {
  document.body.innerHTML = "";
  for (const id of ["canvas-wrap", "activity-bar", "left-panel", "right-panel", "toolbar"]) {
    const el = document.createElement("div");
    el.id = id;
    document.body.append(el);
  }
  initShellRefs();
}

beforeEach(() => {
  setupShell();
  resetStudioState();
  closeAllTabs();
  setFormats([]);
  canvasMode = "design";
  gridMounted = false;
  collabCtx = null;
  bindings.length = 0;
  createdEditors.length = 0;
  renderGridMode.mockClear();
  detachGridPanel.mockClear();
  canvasPanels.length = 0;
  surface.prevCanvasMode = null;
  view.panzoomWrap = null;
  view.monacoEditor = null;
  view.functionEditor = null;
  view.centerObserver = null;
  view.canvasDndCleanups = [];
  view.canvasEventCleanups = [];
  view.renderGeneration = 0;
  initCanvasUtils({
    getCanvasMode: () => canvasMode,
    getZoom: () => 1,
    setZoomDirect: () => {},
  });
  initCanvasRender({
    getCanvasMode: () => canvasMode,
    gitDiffState: null,
    openFileFromTree: () => {},
    setCanvasMode: setMode,
    setGitDiffState: () => {},
  } as never);
  const tab = resetWorkspaceWithTab();
  tab.session.ui.canvasMode = canvasMode;
});

afterEach(() => {
  closeAllTabs();
});

// ─── Grid mode ────────────────────────────────────────────────────────────────

describe("grid mode", () => {
  test("renders the grid panel and styles the wrap on first entry", async () => {
    setMode("grid");
    renderCanvas();
    await flush(); // The source editor mounts behind the lazy Monaco import.
    expect(renderGridMode).toHaveBeenCalledTimes(1);
    const [host, tab] = renderGridMode.mock.calls[0]! as unknown as [HTMLElement, Tab];
    expect(host.id).toBe("canvas-wrap");
    expect(tab).toBe(activeTab.value!);
    expect(host.style.display).toBe("block");
    expect(host.style.padding).toBe("0px");
  });

  test("a same-tab re-render while the panel is mounted takes the fast path", async () => {
    setMode("grid");
    renderCanvas();
    await flush(); // The source editor mounts behind the lazy Monaco import.
    expect(renderGridMode).toHaveBeenCalledTimes(1);
    // The panel now owns its own reactivity — a content re-render must not rebuild it.
    gridMounted = true;
    renderCanvas();
    await flush(); // The source editor mounts behind the lazy Monaco import.
    expect(renderGridMode).toHaveBeenCalledTimes(1);
  });
});

// ─── Source mode with a live collab session ───────────────────────────────────

describe("source-mode collab binding", () => {
  test("binds the buffer to the shared Y.Text and applies read-only for observers", async () => {
    collabCtx = makeCollabCtx({ readOnly: true });
    setMode("source");
    renderCanvas();
    await flush(); // The source editor mounts behind the lazy Monaco import.
    await flush();

    // The binding was constructed against the ctx text/awareness and the editor's model.
    expect(bindings).toHaveLength(1);
    const [text, model, editors, awareness] = bindings[0]!.args as [
      unknown,
      FakeModel,
      Set<FakeEditor>,
      unknown,
    ];
    expect(text).toBe(collabCtx.text);
    expect(model).toBe(createdEditors[0]!.getModel()!);
    expect([...editors][0]).toBe(createdEditors[0]);
    expect(awareness).toBe(collabCtx.awareness);
    // Remote-cursor styles attached for the roster.
    expect(document.head.querySelector("style[data-jx-collab-cursors]")).not.toBeNull();
    // Read-only identity → the editor buffer locks.
    expect(createdEditors[0]!.updateOptions).toHaveBeenCalledWith({ readOnly: true });
  });

  test("switching away tears the binding down: destroy + leave + style detach", async () => {
    collabCtx = makeCollabCtx();
    setMode("source");
    renderCanvas();
    await flush(); // The source editor mounts behind the lazy Monaco import.
    await flush();
    expect(bindings).toHaveLength(1);
    expect(createdEditors[0]!.updateOptions).not.toHaveBeenCalled();

    const ctx = collabCtx;
    setMode("design");
    renderCanvas();
    await flush(); // The source editor mounts behind the lazy Monaco import.
    expect(bindings[0]!.destroyed).toBe(true);
    expect(ctx.leave).toHaveBeenCalledTimes(1);
    expect(document.head.querySelector("style[data-jx-collab-cursors]")).toBeNull();
  });

  test("an editor torn down before enter() resolves never binds", async () => {
    let release!: () => void;
    collabCtx = makeCollabCtx({
      enter: () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    });
    setMode("source");
    renderCanvas();
    await flush(); // The source editor mounts behind the lazy Monaco import.
    view.monacoEditor = null; // The editor goes away while the session enters.
    release();
    await flush();
    expect(bindings).toHaveLength(0);
  });

  test("an editor replaced while y-monaco loads unbinds immediately", async () => {
    let release!: () => void;
    collabCtx = makeCollabCtx();
    collabCtx.enter = () =>
      new Promise<void>((resolve) => {
        release = resolve;
      });
    setMode("source");
    renderCanvas();
    await flush(); // The source editor mounts behind the lazy Monaco import.
    const ctx = collabCtx;
    release();
    // Let the enter() continuation reach the dynamic y-monaco import, then yank the editor.
    await Promise.resolve();
    view.monacoEditor = null;
    await flush();
    // The binding was built but immediately destroyed (cleanup ran, session left).
    expect(bindings).toHaveLength(1);
    expect(bindings[0]!.destroyed).toBe(true);
    expect(ctx.leave).toHaveBeenCalledTimes(1);
  });

  test("an enter() failure degrades to a local buffer without throwing", async () => {
    collabCtx = makeCollabCtx({ enter: () => Promise.reject(new Error("room unavailable")) });
    setMode("source");
    expect(() => renderCanvas()).not.toThrow();
    await flush();
    expect(bindings).toHaveLength(0);
    expect(view.monacoEditor).toBe(createdEditors[0] as never);
  });
});
