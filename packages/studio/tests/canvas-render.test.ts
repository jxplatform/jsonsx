/**
 * Canvas render orchestrator tests. Heavy collaborators (monaco, the live runtime renderer, DnD,
 * panel events, stylebook, editors, statusbar, overlays) are mocked via mock.module so the tests
 * can drive every renderCanvas dispatch path deterministically and assert the produced DOM.
 */
import {
  flush,
  installMockPlatform,
  resetStudioState,
  resetWorkspaceWithTab,
  stubRect,
} from "./harness";
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { notifyModule } from "./notify-mock";
import { canvasWrap, initShellRefs, setProjectState } from "../src/store";
import {
  activeCanvasSurface,
  registerCanvasSurface,
  surfaceForPane,
} from "../src/canvas/canvas-surface";
import {
  activateTab,
  activeTab,
  closeAllTabs,
  openTab,
  PRIMARY_PANE,
  SECONDARY_PANE,
  workspace,
} from "../src/workspace/workspace";
import { view } from "../src/view";
import { canvasPerf } from "../src/canvas/canvas-perf";
import { shell } from "../src/shell";
import { setFormats } from "../src/format/format-host";
import { initCanvasUtils, setEditZoom } from "../src/canvas/canvas-utils";
import { MARKDOWN_FORMAT } from "./format-fixture";
import type { CanvasPanel } from "../src/types";
import type { JxMutableNode } from "@jxsuite/schema/types";

/* The panels of the FOCUSED pane's stage. Panels belong to a pane's surface now, not to the
   app (`src/canvas/canvas-surface.ts`); the array identity is stable, so a module-level
   binding still sees what the render mutated. */
const surface = activeCanvasSurface();
const canvasPanels = surface.panels;

// ─── Controllable mock behavior ───────────────────────────────────────────────

// The iframe canvas is the only canvas now: renderCanvasIntoPanel calls mountIframeCanvas(gen, doc,
// Canvas, widthPx). The default stub stamps the doc's text into the canvas so DOM assertions still
// Work; a test can swap `iframeImpl` to drive staleness/rejection.
type IframeMount = (
  gen: number,
  doc: JxMutableNode,
  canvas: HTMLElement,
  widthPx?: number | null,
) => Promise<void>;
// The stylebook fast path posts style updates to live stylebook hosts; tests control the count.
let styleUpdateImpl: (style: Record<string, unknown>) => number = () => 0;
/**
 * Every synchronous preview-mode declaration the renderer made, in order. The renderer must tell
 * the host what kind of render is coming BEFORE it awaits the resolved document (see
 * adoptCanvasPreviewMode) — these records are how a test sees that call happened, and with what.
 */
const previewAdoptions: { canvas: HTMLElement; preview: boolean }[] = [];
let iframeImpl: IframeMount = async (_gen, doc, canvas) => {
  canvas.innerHTML = "";
  const root = document.createElement("div");
  for (const child of (doc.children as JxMutableNode[] | undefined) ?? []) {
    const el = document.createElement(child.tagName ?? "span");
    if (child.textContent) {
      el.textContent = child.textContent as string;
    }
    root.append(el);
  }
  canvas.append(root);
};

const renderWelcome = mock((host: HTMLElement) => {
  host.textContent = "welcome";
});
const renderFunctionEditor = mock(() => {});
const notified = mock((_message: string) => {});
const overlaysRender = mock(() => {});
const renderStylebookMode = mock((_helpers: unknown) => {});
const parseSourceForPathMock = mock(async (_path: string, _source: string) => ({
  document: { children: [{ tagName: "p", textContent: "parsed-md" }], tagName: "article" },
  format: MARKDOWN_FORMAT,
  frontmatter: { title: "Parsed" },
}));
const serializeDocumentMock = mock(async () => "# markdown source");

interface FakeModel {
  _value: string;
  lang: string;
  uri: unknown;
  dispose: ReturnType<typeof mock>;
  getValue: () => string;
  setValue: (v: string) => void;
}
interface FakeEditor {
  _changeHandlers: (() => void)[];
  _focused: boolean;
  _ignoreNextChange: boolean;
  _model: FakeModel | null;
  dispose: ReturnType<typeof mock>;
  getModel: () => FakeModel | null;
  getValue: () => string;
  hasTextFocus: () => boolean;
  onDidChangeModelContent: (cb: () => void) => void;
  setValue: (v: string) => void;
}
const createdModels: FakeModel[] = [];
const createdEditors: FakeEditor[] = [];

void mock.module("monaco-editor/esm/vs/editor/editor.api.js", () => ({
  MarkerSeverity: { Error: 8, Warning: 4 },
  Uri: { parse: (s: string) => ({ toString: () => s }) },
  editor: {
    create: (_el: HTMLElement, opts: { model?: FakeModel }) => {
      const ed: FakeEditor = {
        _changeHandlers: [],
        _focused: false,
        _ignoreNextChange: false,
        _model: opts?.model ?? null,
        /**
         * Mirrors Monaco, and this is the line that makes the source view's orphan debounce
         * visible: `dispose()` runs `_detachModel()`, so `getModel()` answers null and `getValue()`
         * answers `""` — not the buffer the editor was holding. A double that kept answering with
         * the text is a double in which a timer surviving the teardown writes the same text back
         * and looks harmless.
         */
        dispose: mock(() => {
          ed._model = null;
        }),
        getModel: () => ed._model,
        getValue: () => ed._model?._value ?? "",
        hasTextFocus: () => ed._focused,
        onDidChangeModelContent: (cb: () => void) => {
          ed._changeHandlers.push(cb);
        },
        setValue: (v: string) => {
          if (ed._model) {
            ed._model._value = v;
          }
        },
      };
      createdEditors.push(ed);
      return ed;
    },
    createModel: (value: string, lang: string, uri: unknown) => {
      const m: FakeModel = {
        _value: value,
        dispose: mock(() => {}),
        getValue: () => m._value,
        lang,
        setValue: (v: string) => {
          m._value = v;
        },
        uri,
      };
      createdModels.push(m);
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
  adoptCanvasPreviewMode: (canvas: HTMLElement, preview: boolean) =>
    previewAdoptions.push({ canvas, preview }),
  commitActiveEditSession: () => {},
  /* Three exports this file never calls, stubbed because a PARTIAL mock of a module the graph
     reaches is a load error rather than a missing stub at call time. canvas-render now draws the
     Library, whose creation flow is `files/files.ts`, which pulls `packages/ensure-deps` →
     `services/automation` → `services/idle` — and those two modules read `canvasIdleBlockers`,
     `canvasPointAt` and `revealCanvasPath` off the iframe host. */
  canvasIdleBlockers: () => [],
  canvasPointAt: () => Promise.resolve(null),
  revealCanvasPath: () => Promise.resolve(null),
  postStyleUpdateToStylebookHosts: (style: Record<string, unknown>) => styleUpdateImpl(style),
  getEditBarAnchorRect: () => null,
  getEditSnapshot: () => ({ editing: false, snapshot: null }),
  mountIframeCanvas: (
    gen: number,
    doc: JxMutableNode,
    canvas: HTMLElement,
    widthPx?: number | null,
  ) => iframeImpl(gen, doc, canvas, widthPx),
  postApplyFormat: () => {},
  // Live-preview seam (transitively imported via the panels) — no iframe in this suite.
  requestCanvasEval: () => Promise.resolve(null),
  setToolbarRefresh: () => {},
}));

void mock.module("../src/panels/welcome-screen.js", () => ({
  initWelcome: () => {},
  renderWelcome,
}));

void mock.module("../src/panels/editors.js", () => ({
  registerFunctionCompletions: () => {},
  renderFunctionEditor,
}));

const renderFormulaWorkspace = mock(() => {});
void mock.module("../src/panels/formula-workspace.js", () => ({
  closeFormulaWorkspace: () => {},
  formulaRoot: () => null,
  /* The Logic openers go through this: it sets the target AND reveals the tab. */
  openLogicTarget: () => {},
  renderFormulaWorkspace,
  /* The State panel's `formula.openWorkspace` reveals the dock tab instead of repainting. */
  revealLogicPanel: () => {},
}));

void mock.module("../src/services/notify.js", () => notifyModule((call) => notified(call.message)));

void mock.module("../src/panels/overlays.js", () => ({
  mount: () => {},
  render: overlaysRender,
  unmount: () => {},
}));

void mock.module("../src/panels/stylebook-panel.js", () => ({
  renderStylebookMode,
}));

void mock.module("../src/files/file-ops.js", () => ({
  parseSourceForPath: parseSourceForPathMock,
  serializeDocument: serializeDocumentMock,
  /* Two more the Library's context menu reads. canvas-render draws the Library now, so this
     partial mock has to cover what that path imports — see the iframe-host note above. */
  confirmFileDelete: () => Promise.resolve(false),
  renamePromptMessage: () => Promise.resolve(""),
  /* And one the TAB STRIP reads: its close offers to save first (§8.7's three-way dialog). */
  saveFile: () => Promise.resolve(true),
}));

const {
  handOverCanvasStage,
  initCanvasRender,
  renderCanvas,
  renderOverlays,
  scheduleCanvasRender,
} = await import("../src/canvas/canvas-render");
const { mount: mountDocHeader, unmount: unmountDocHeader } =
  await import("../src/panels/frontmatter-panel");

// ─── Test context ─────────────────────────────────────────────────────────────

let canvasMode = "design";
let canvasModeFn = () => canvasMode;
let zoom = 1;

/**
 * The render dispatch composes the effective mode from the PANE's tab itself (`canvasModeOfPane`);
 * `canvasModeFn` is only what the canvas-utils helpers are still injected with. Keep both in sync
 * here.
 */
function setMode(m: string) {
  canvasMode = m;
  const tab = activeTab.value;
  if (tab) {
    tab.session.ui.canvasMode = m;
  }
}

/** Open a tab and sync its base mode with the test's current canvasMode. */
function openSyncedTab(
  ...args: Parameters<typeof resetWorkspaceWithTab>
): ReturnType<typeof resetWorkspaceWithTab> {
  const tab = resetWorkspaceWithTab(...args);
  tab.session.ui.canvasMode = canvasMode;
  return tab;
}

const ctx = {
  gitDiffState: null as Record<string, unknown> | null,
  openFileFromTree: mock(() => {}),
  setCanvasMode: mock((m: string) => {
    setMode(m);
  }),
  setGitDiffState: mock(() => {}),
};

function setupShell() {
  document.body.innerHTML = "";
  for (const el of document.head.querySelectorAll("style[data-jx-owner]")) {
    el.remove();
  }
  for (const id of [
    "canvas-wrap",
    "activity-bar",
    "left-panel",
    "right-panel",
    "toolbar",
    "statusbar",
  ]) {
    const el = document.createElement("div");
    el.id = id;
    document.body.append(el);
  }
  initShellRefs();
}

/**
 * Run fn with long debounce/sweep timers (>=200ms) intercepted so they can be flushed
 * deterministically via the returned runPending callback.
 */
async function withFastTimers(fn: (runPending: () => Promise<number>) => Promise<void>) {
  const origSetTimeout = globalThis.setTimeout;
  const origClearTimeout = globalThis.clearTimeout;
  /* Keyed by handle, because `clearTimeout` has to actually clear.
     It used to no-op on a fake handle and leave the callback in the queue, so `runPending()` ran
     timers that had been cancelled — which made "does the teardown cancel the armed debounce?"
     an unaskable question in this file, and that is the question the source view's 600ms
     document-replacing timer needed asked. A fake clock that cannot cancel certifies a leak. */
  const pending = new Map<number, () => unknown>();
  let nextHandle = 0;
  globalThis.setTimeout = ((cb: () => unknown, ms?: number, ...args: unknown[]) => {
    if (typeof ms === "number" && ms >= 200) {
      nextHandle += 1;
      pending.set(nextHandle, cb);
      return { __fake: nextHandle } as unknown as ReturnType<typeof setTimeout>;
    }
    return origSetTimeout(cb as () => void, ms, ...(args as []));
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((handle: unknown) => {
    const fake = (handle as { __fake?: number } | null | undefined)?.__fake;
    if (typeof fake === "number") {
      pending.delete(fake);
      return;
    }
    origClearTimeout(handle as ReturnType<typeof setTimeout>);
  }) as typeof clearTimeout;
  try {
    await fn(async () => {
      const due = [...pending.values()];
      pending.clear();
      for (const cb of due) {
        cb();
      }
      await flush();
      /* The COUNT, so a test can distinguish "the timer ran and decided to do nothing" from "the
         timer was cancelled". Those are different fixes and only one of them is a teardown. */
      return due.length;
    });
  } finally {
    globalThis.setTimeout = origSetTimeout;
    globalThis.clearTimeout = origClearTimeout;
  }
}

function fireModelChange(editor: FakeEditor) {
  for (const cb of editor._changeHandlers) {
    cb();
  }
}

const rafTurn = () =>
  new Promise<void>((resolve) => {
    requestAnimationFrame(() =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
  });

beforeEach(() => {
  setupShell();
  resetStudioState();
  closeAllTabs();
  setFormats([]);
  setMode("design");
  canvasModeFn = () => canvasMode;
  zoom = 1;
  ctx.gitDiffState = null;
  styleUpdateImpl = () => 0;
  iframeImpl = async (_gen, doc, canvas) => {
    canvas.innerHTML = "";
    const root = document.createElement("div");
    for (const child of (doc.children as JxMutableNode[] | undefined) ?? []) {
      const el = document.createElement(child.tagName ?? "span");
      if (child.textContent) {
        el.textContent = child.textContent as string;
      }
      root.append(el);
    }
    canvas.append(root);
  };
  for (const m of [
    renderWelcome,
    renderFunctionEditor,
    notified,
    overlaysRender,
    renderStylebookMode,
    parseSourceForPathMock,
    serializeDocumentMock,
    ctx.setCanvasMode,
  ]) {
    m.mockClear();
  }
  createdModels.length = 0;
  createdEditors.length = 0;
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
    getCanvasMode: () => canvasModeFn(),
    getZoom: () => zoom,
    setZoomDirect: (z: number) => {
      zoom = z;
    },
  });
  initCanvasRender(ctx as never);
});

afterEach(() => {
  closeAllTabs();
});

// ─── No tab: welcome screen ───────────────────────────────────────────────────

describe("renderCanvas without a tab", () => {
  test("renders the welcome screen when no project is loaded", () => {
    setProjectState(null);
    renderCanvas();
    expect(renderWelcome).toHaveBeenCalledWith(canvasWrap);
  });

  test("clears the canvas when a project is loaded but no tab is open", () => {
    resetStudioState({ isSiteProject: true });
    canvasWrap.textContent = "leftover";
    renderCanvas();
    expect(renderWelcome).not.toHaveBeenCalled();
    expect(canvasWrap.textContent).toBe("");
  });

  // The dev server probes its root into projectState even when that root is only a workspace
  // (no project.json). That is not an open project — the welcome screen must stay put instead of
  // Being replaced by a blank canvas a moment after boot.
  test("keeps the welcome screen when the root is not a site project", () => {
    resetStudioState({ isSiteProject: false, projectRoot: ".", root: "/repo" });
    renderCanvas();
    expect(renderWelcome).toHaveBeenCalledWith(canvasWrap);
  });
});

// ─── Close-all / reopen lifecycle (toxic-state regression) ────────────────────

describe("tab close/reopen lifecycle", () => {
  /** Read Lit's private render-part marker without tripping noImplicitAny. */
  const litPart = () => (canvasWrap as unknown as Record<string, unknown>)["_$litPart$"];

  test("reopening after closing all tabs re-renders without a dangling Lit part", async () => {
    // A project is open, so closing every tab leaves a bare canvas (not the welcome screen).
    resetStudioState({ isSiteProject: true });
    openSyncedTab();
    setMode("edit");
    renderCanvas();
    await flush();
    expect(canvasWrap.querySelector(".content-edit-column")).not.toBeNull();
    // CanvasWrap now owns a Lit render part
    expect(litPart()).toBeDefined();

    // Closing every tab must eject the part along with the DOM — not just the DOM. Leaving the part
    // Behind is what previously made the next litRender throw "ChildPart has no parentNode".
    closeAllTabs();
    renderCanvas();
    expect(canvasWrap.textContent).toBe("");
    expect(litPart()).toBeUndefined();
    expect(surface.prevCanvasMode).toBeNull();

    // Reopening must render cleanly rather than crashing the canvas into an unusable state.
    openSyncedTab();
    setMode("edit");
    expect(() => renderCanvas()).not.toThrow();
    await flush();
    expect(canvasWrap.querySelector(".content-edit-column")).not.toBeNull();
  });

  test("edit-mode column hugs a component definition (is-component) but fills for a page", async () => {
    // A page root (plain div) → the column fills the viewport (document-like editing surface).
    openSyncedTab({ children: [{ tagName: "p", textContent: "Hi" }], tagName: "div" });
    setMode("edit");
    renderCanvas();
    await flush();
    const pageColumn = canvasWrap.querySelector(".content-edit-column")!;
    expect(pageColumn.classList.contains("is-component")).toBe(false);

    // A component-definition root (custom-element tag) → the column hugs its content.
    openSyncedTab({ children: [{ tagName: "h2", textContent: "Hi" }], tagName: "eer-cta" });
    setMode("edit");
    renderCanvas();
    await flush();
    const compColumn = canvasWrap.querySelector(".content-edit-column")!;
    expect(compColumn.classList.contains("is-component")).toBe(true);
  });

  test("closing all tabs while in source mode disposes the monaco editor", async () => {
    openSyncedTab();
    setMode("source");
    renderCanvas();
    await flush();
    const [editor] = createdEditors;
    const [model] = createdModels;
    expect(view.monacoEditor).toBe(editor as never);

    closeAllTabs();
    renderCanvas();
    expect(editor!.dispose).toHaveBeenCalled();
    expect(model!.dispose).toHaveBeenCalled();
    expect(view.monacoEditor).toBeNull();

    // Reopening source mode builds a fresh editor instead of writing into the dead, detached one.
    openSyncedTab();
    setMode("source");
    renderCanvas();
    await flush();
    expect(createdEditors.length).toBe(2);
    expect(view.monacoEditor).toBe(createdEditors[1] as never);
  });

  test("clearing to the no-tab state disposes this module's observers, editors, scopes, and cleanups", () => {
    openSyncedTab();
    const dndCleanup = mock(() => {});
    const eventCleanup = mock(() => {});
    const stop = mock(() => {});
    const disconnect = mock(() => {});
    const fnDispose = mock(() => {});
    view.canvasDndCleanups = [dndCleanup];
    view.canvasEventCleanups = [eventCleanup];
    view.centerObserver = { disconnect } as never;
    view.functionEditor = { dispose: fnDispose } as never;
    surface.prevCanvasMode = "design";
    canvasPanels.push({ renderScope: { stop } } as never);

    closeAllTabs();
    renderCanvas();

    expect(dndCleanup).toHaveBeenCalled();
    expect(eventCleanup).toHaveBeenCalled();
    expect(stop).toHaveBeenCalled();
    expect(disconnect).toHaveBeenCalled();
    // Everything above is a surface THIS module created. The dock's Monaco is not: the Logic tab
    // Creates it and `syncFunctionEditor` disposes it, from an `afterRender` the dock runs for
    // Every registered tab whether or not it is showing — losing the last tab included. Reaching
    // In from here was also wrong per PANE: `view.functionEditor` is app-wide while this runs for
    // One stage, so an empty pane disposed an editor another pane's tab was still showing.
    expect(fnDispose).not.toHaveBeenCalled();
    expect(view.functionEditor).not.toBeNull();
    view.functionEditor = null;
    expect(view.centerObserver).toBeNull();
    expect(view.canvasDndCleanups).toEqual([]);
    expect(view.canvasEventCleanups).toEqual([]);
    expect(canvasPanels.length).toBe(0);
    expect(surface.prevCanvasMode).toBeNull();
  });
});

// ─── The logic editors are not this file's business ───────────────────────────

describe("a logic target open in the dock", () => {
  /*
     `renderCanvasContent` used to RETURN on `editingFunction` / `editingFormula`, after calling a
     seam in the panel module. That was the takeover: the stage froze — it kept whatever DOM it was
     last painted with and stopped tracking the document — and the seams existed only to be called
     from here. P8 put both surfaces in the Bottom dock's Logic tab, over a page that is still on
     screen, so the canvas must go on rendering it. `panels/bottom-dock.ts` reveals the tab from its
     own effect and `panels/editors.ts` owns the Monaco instance from the panel's `afterRender`.
  */
  test("does not stop the stage rendering, and does not reach into either panel", () => {
    const tab = openSyncedTab();
    setMode("edit");
    renderCanvas();
    const painted = canvasPanels.length;
    expect(painted).toBeGreaterThan(0);

    tab.session.ui.editingFunction = { path: ["children", 0], prop: "onclick" } as never;
    renderCanvas();
    expect(canvasPanels.length).toBe(painted);
    expect(renderFunctionEditor).not.toHaveBeenCalled();

    tab.session.ui.editingFunction = null;
    tab.session.ui.editingFormula = { defName: "total", type: "def" };
    renderCanvas();
    expect(canvasPanels.length).toBe(painted);
    expect(renderFormulaWorkspace).not.toHaveBeenCalled();
  });

  test("leaves the dock's Monaco alone — disposing it is the panel's job, not a render's", () => {
    // The old dispose-on-switch-away branch ran on EVERY render that was not the function editor's.
    // With the editor living in the dock, that branch would have thrown away a live instance the
    // Author was typing into each time the canvas repainted underneath it.
    openSyncedTab();
    const dispose = mock(() => {});
    view.functionEditor = { dispose } as never;
    renderCanvas();
    expect(dispose).not.toHaveBeenCalled();
    expect(view.functionEditor).not.toBeNull();
    view.functionEditor = null;
  });
});

// ─── Source mode ──────────────────────────────────────────────────────────────

describe("source mode", () => {
  test("creates a monaco editor with the document JSON", async () => {
    const tab = openSyncedTab();
    setMode("source");
    renderCanvas();
    // The container renders synchronously; the editor itself mounts once Monaco has loaded.
    expect(canvasWrap.querySelector(".source-wrap")).not.toBeNull();
    expect(canvasWrap.querySelector(".source-editor")).not.toBeNull();
    await flush();
    expect(view.monacoEditor).toBe(createdEditors[0] as never);
    expect(createdModels[0]!._value).toBe(JSON.stringify(tab.doc.document, null, 2));
    expect(createdModels[0]!.lang).toBe("json");
    expect(createdEditors[0]!._ignoreNextChange).toBe(true);
  });

  test("debounced edits sync valid JSON back into the document", async () => {
    const tab = openSyncedTab();
    setMode("source");
    await withFastTimers(async (runPending) => {
      renderCanvas();
      await flush();
      const [editor] = createdEditors;
      editor!._ignoreNextChange = false;
      editor!._model!._value = JSON.stringify({ children: [], tagName: "main" });
      fireModelChange(editor!);
      await runPending();
      expect(tab.doc.document.tagName).toBe("main");
      expect(tab.doc.dirty).toBe(true);
    });
  });

  test("invalid JSON edits do not touch the document", async () => {
    const tab = openSyncedTab();
    setMode("source");
    await withFastTimers(async (runPending) => {
      renderCanvas();
      await flush();
      const [editor] = createdEditors;
      editor!._ignoreNextChange = false;
      editor!._model!._value = "{ not json";
      fireModelChange(editor!);
      await runPending();
      expect(tab.doc.document.tagName).toBe("div");
      expect(tab.doc.dirty).toBe(false);
    });
  });

  test("programmatic buffer updates are swallowed via _ignoreNextChange", async () => {
    const tab = openSyncedTab();
    setMode("source");
    await withFastTimers(async (runPending) => {
      renderCanvas();
      await flush();
      const [editor] = createdEditors;
      editor!._ignoreNextChange = true;
      editor!._model!._value = JSON.stringify({ tagName: "main" });
      fireModelChange(editor!);
      await runPending();
      expect(editor!._ignoreNextChange).toBe(false);
      expect(tab.doc.document.tagName).toBe("div");
      expect(tab.doc.dirty).toBe(false);
    });
  });

  test("javascript files use the document toString and only mark dirty", async () => {
    closeAllTabs();
    const tab = openSyncedTab(undefined, { documentPath: "/project/handlers.js" });
    setMode("source");
    await withFastTimers(async (runPending) => {
      renderCanvas();
      await flush();
      expect(createdModels[0]!.lang).toBe("javascript");
      expect(createdModels[0]!._value).toBe(String(tab.doc.document));
      const [editor] = createdEditors;
      editor!._ignoreNextChange = false;
      fireModelChange(editor!);
      await runPending();
      expect(tab.doc.dirty).toBe(true);
    });
  });

  /* A model carries the file identity Monaco validates against: its URI is what the JSON language
     service resolves a relative `$schema` against, and its language id picks the tokenizer. The
     buffer-swap fast path used to reuse one model across a source→source tab switch, so opening
     project.json after pages/index.json checked it as though it lived in pages/ — its
     "./project.schema.json" resolved to file:///pages/project.schema.json, which is registered
     nowhere, and the "No schema request service available" diagnostic came straight back. */
  test("a source→source tab switch rebuilds the model at the new file's uri", async () => {
    openSyncedTab(undefined, { documentPath: "pages/index.json" });
    setMode("source");
    renderCanvas();
    await flush();
    expect(createdModels).toHaveLength(1);
    expect(String(createdModels[0]!.uri)).toBe("file:///pages/index.json");
    const firstEditor = createdEditors[0]!;

    openSyncedTab(undefined, { documentPath: "project.json", id: "tab-project" });
    setMode("source");
    renderCanvas();
    await flush();

    expect(createdModels).toHaveLength(2);
    expect(String(createdModels[1]!.uri)).toBe("file:///project.json");
    expect(createdModels[0]!.dispose).toHaveBeenCalled();
    expect(firstEditor.dispose).toHaveBeenCalled();
    expect(view.monacoEditor).toBe(createdEditors[1] as never);
  });

  /* The generated entry documents get a reserved URI so they cannot collide with the ids the
     schemas are registered under — Monaco's JSON adapter calls resetSchema(model.uri) on disposal,
     which would wipe the inline registration and break every project.json for the session. */
  test("generated entry documents mount under the reserved uri", async () => {
    openSyncedTab(undefined, { documentPath: "project.schema.json" });
    setMode("source");
    renderCanvas();
    await flush();
    expect(String(createdModels[0]!.uri)).toBe("file:///.jx/generated/project.schema.json");
  });

  test("re-rendering the SAME source tab keeps its model", async () => {
    openSyncedTab(undefined, { documentPath: "pages/index.json" });
    setMode("source");
    renderCanvas();
    await flush();
    renderCanvas();
    await flush();
    expect(createdModels).toHaveLength(1);
    expect(createdModels[0]!.dispose).not.toHaveBeenCalled();
  });

  test("format documents serialize to source and parse edits back", async () => {
    setFormats([MARKDOWN_FORMAT]);
    closeAllTabs();
    const tab = openSyncedTab(undefined, { documentPath: "/project/post.md" });
    tab.doc.sourceFormat = "Markdown";
    setMode("source");
    await withFastTimers(async (runPending) => {
      renderCanvas();
      await flush();
      expect(createdModels[0]!.lang).toBe("markdown");
      expect(serializeDocumentMock).toHaveBeenCalled();
      expect(createdModels[0]!._value).toBe("# markdown source");

      const [editor] = createdEditors;
      editor!._ignoreNextChange = false;
      editor!._model!._value = "# Edited";
      fireModelChange(editor!);
      await runPending();
      expect(parseSourceForPathMock).toHaveBeenCalledWith("/project/post.md", "# Edited");
      expect(tab.doc.document.tagName).toBe("article");
      expect(tab.doc.content.frontmatter).toEqual({ title: "Parsed" });
      expect(tab.doc.dirty).toBe(true);
    });
  });

  test("unparseable format source leaves the document untouched", async () => {
    setFormats([MARKDOWN_FORMAT]);
    closeAllTabs();
    const tab = openSyncedTab(undefined, { documentPath: "/project/post.md" });
    tab.doc.sourceFormat = "Markdown";
    setMode("source");
    parseSourceForPathMock.mockImplementationOnce(async () => {
      throw new Error("bad source");
    });
    await withFastTimers(async (runPending) => {
      renderCanvas();
      await flush();
      const [editor] = createdEditors;
      editor!._ignoreNextChange = false;
      fireModelChange(editor!);
      await runPending();
      expect(tab.doc.document.tagName).toBe("div");
      expect(tab.doc.dirty).toBe(false);
    });
  });

  test("re-render in source mode updates the buffer without recreating the editor", async () => {
    const tab = openSyncedTab();
    setMode("source");
    renderCanvas();
    await flush();
    expect(createdEditors.length).toBe(1);
    const [editor] = createdEditors;
    editor!._ignoreNextChange = false;

    tab.doc.document.tagName = "section";
    renderCanvas();
    await flush();
    expect(createdEditors.length).toBe(1);
    expect(editor!.getValue()).toBe(JSON.stringify(tab.doc.document, null, 2));
    expect(editor!._ignoreNextChange).toBe(true);
  });

  test("re-render does not clobber the buffer while the editor has focus", async () => {
    const tab = openSyncedTab();
    setMode("source");
    renderCanvas();
    await flush();
    const [editor] = createdEditors;
    editor!._focused = true;
    editor!._model!._value = "user-typing";
    tab.doc.document.tagName = "section";
    renderCanvas();
    await flush();
    expect(editor!.getValue()).toBe("user-typing");
  });

  test("stale buffer updates are dropped when the editor was replaced mid-flight", async () => {
    const tab = openSyncedTab();
    setMode("source");
    renderCanvas();
    await flush();
    const [editor] = createdEditors;
    editor!._ignoreNextChange = false;
    editor!._model!._value = "stale-buffer";

    tab.doc.document.tagName = "section";
    renderCanvas(); // Fast path kicks off an async buffer refresh…
    view.monacoEditor = null; // …but the editor goes away before it lands
    await flush();
    expect(editor!.getValue()).toBe("stale-buffer");
  });

  test("change events fired after editor teardown are ignored", async () => {
    const tab = openSyncedTab();
    setMode("source");
    await withFastTimers(async (runPending) => {
      renderCanvas();
      await flush();
      const [editor] = createdEditors;
      editor!._ignoreNextChange = false;
      editor!._model!._value = JSON.stringify({ tagName: "main" });
      view.monacoEditor = null;
      fireModelChange(editor!);
      await runPending();
      expect(tab.doc.document.tagName).toBe("div");
    });
  });

  /**
   * The source view's teardown rate is three sites, and neither of the two things they tried was
   * the contract.
   *
   * `view.monacoEditor` is declared eight lines above `view.functionEditor` and has the same shape,
   * but P8's teardown fix only reached the dock. Its 600ms timer closes over the editor, a disposed
   * Monaco answers `getValue()` with `""`, and for a FORMAT-backed document the callback then ran
   * `parseSourceForPath(path, "")` and assigned the result: the page's body replaced with an empty
   * parse, 600ms after the user left Code view, the tab left dirty so the next ⌘S puts it on disk.
   * (A `.json` tab threw inside `JSON.parse("")` and the catch swallowed it — which is luck, and is
   * why only one of the two shapes was ever going to be noticed.)
   *
   * Cancelling instead stops the corruption by throwing the edit away, silently: nothing parses
   * `""`, and nothing parses `"# Edited"` either, so the tab is not dirty and the author has no
   * signal that their last sentence is gone. **The property is that the edit survives the
   * teardown** — the flush reads the buffer while the model is still attached and hands the LIVE
   * text to the parser — and the dead buffer is never read.
   */
  test("leaving code view flushes the source debounce instead of dropping the edit", async () => {
    setFormats([MARKDOWN_FORMAT]);
    closeAllTabs();
    const tab = openSyncedTab(undefined, { documentPath: "/project/post.md" });
    tab.doc.sourceFormat = "Markdown";
    setMode("source");
    await withFastTimers(async (runPending) => {
      renderCanvas();
      await flush();
      const [editor] = createdEditors;
      editor!._ignoreNextChange = false;
      editor!._model!._value = "# Edited";
      fireModelChange(editor!); // Arms the 600ms commit over this buffer
      parseSourceForPathMock.mockClear();

      // Leave Code view. The mode transition disposes the editor synchronously.
      setMode("edit");
      renderCanvas();
      await flush();
      expect(view.monacoEditor).toBeNull();
      expect(editor!.getValue()).toBe(""); // What a surviving timer would have parsed

      // The parse got the LIVE buffer, read before the model was detached — never `""`.
      expect(parseSourceForPathMock).toHaveBeenCalledWith("/project/post.md", "# Edited");
      expect(tab.doc.document.tagName).toBe("article");
      expect(tab.doc.content.frontmatter).toEqual({ title: "Parsed" });
      expect(tab.doc.dirty).toBe(true);

      /* Zero, not "one that bailed": the flush ran the timer and then dropped it, and `cancel`
         dropped the rest. The in-body liveness check is a second line of defence for a disposal
         that does not go through `disposeSourceEditor`. */
      expect(await runPending()).toBe(0);
      expect(parseSourceForPathMock).toHaveBeenCalledTimes(1);
    });
  });

  /**
   * The dock's cross-document commit, in its twin — where it survived only by coincidence.
   *
   * The 600ms callback resolved its tab through `activeTab.value`, exactly as the dock's did. It
   * has never been reported because the model-URI swap disposes this editor on a source→source tab
   * change, so in practice the timer was cancelled before it could name the wrong document. That is
   * a property of one caller's ordering, not a rule the callback states — and the dock, whose
   * target string carries no tab identity, is the proof that the same shape does bite.
   */
  test("the source commit names the tab its editor was mounted for", async () => {
    closeAllTabs();
    setMode("source");
    const a = openTab({
      document: { children: [], tagName: "div" },
      documentPath: "pages/a.json",
      id: "tab-a",
    });
    const b = openTab({
      document: { children: [], tagName: "div" },
      documentPath: "pages/b.json",
      id: "tab-b",
    });
    a.session.ui.canvasMode = "source";
    b.session.ui.canvasMode = "source";
    activateTab("tab-a");

    await withFastTimers(async (runPending) => {
      renderCanvas();
      await flush();
      const [editor] = createdEditors;
      editor!._ignoreNextChange = false;
      editor!._model!._value = JSON.stringify({ tagName: "main" });
      fireModelChange(editor!);

      // Focus B inside the 600ms window, with no render in between.
      activateTab("tab-b");
      expect(await runPending()).toBe(1);

      expect(a.doc.document.tagName).toBe("main");
      expect(a.doc.dirty).toBe(true);
      expect(b.doc.document.tagName).toBe("div");
      expect(b.doc.dirty).toBe(false);
    });
  });

  /**
   * The fourth mount path, and the one with no post-await re-check.
   *
   * `renderCanvasImpl` assigns `surface.prevCanvasMode = canvasMode` BEFORE it reaches the mount,
   * so a second synchronous `renderCanvas()` inside the cold `await loadMonaco()` sees `modeChanged
   * === false` and a still-null `view.monacoEditor`: it skips the source fast path and falls
   * through to mount again. `store.ts`'s `render()`/`renderOnly()` coalesce nothing, so two renders
   * in a turn is an ordinary thing to ask for. The duplicate is not merely a wasted editor — the
   * second `createModel` claims a URI the first already registered, which real Monaco throws on,
   * and the loser's editor stays attached to the stage with nobody holding it.
   */
  test("two renders inside the monaco load mount one editor, not two", async () => {
    openSyncedTab(undefined, { documentPath: "pages/index.json" });
    setMode("source");

    renderCanvas();
    renderCanvas(); // Same turn, still inside the awaited load
    await flush();

    expect(createdEditors).toHaveLength(1);
    expect(createdModels).toHaveLength(1);
    expect(view.monacoEditor).toBe(createdEditors[0] as never);
    expect(createdModels[0]!.dispose).not.toHaveBeenCalled();
  });

  /**
   * The other half of the same rate change: the repaint, not the teardown.
   *
   * `sourceContent` is a round trip through the format host, and the buffer it is about to fill is
   * the empty one the model was created with. A user who starts typing into that empty box before
   * the serialize returns had their first words replaced by the file they were already looking at.
   * Model identity says "this load is still for this buffer" and passes; only the buffer's own
   * contents say it has moved on.
   */
  test("the initial serialize does not overwrite what the user typed into the empty buffer", async () => {
    setFormats([MARKDOWN_FORMAT]);
    closeAllTabs();
    let resolveSource: ((value: string) => void) | undefined;
    serializeDocumentMock.mockImplementationOnce(
      async () =>
        new Promise<string>((resolve) => {
          resolveSource = resolve;
        }),
    );
    const tab = openSyncedTab(undefined, { documentPath: "/project/post.md" });
    tab.doc.sourceFormat = "Markdown";
    setMode("source");
    renderCanvas();
    await flush();
    const [editor] = createdEditors;
    expect(editor!.getValue()).toBe("");

    editor!._focused = true;
    editor!._model!._value = "# mine";

    resolveSource!("# markdown source");
    await flush();

    expect(editor!.getValue()).toBe("# mine");
    expect(editor!._model).toBe(createdModels[0]!); // Identity held the whole time
  });

  test("debounced sync bails when the tab was closed in the meantime", async () => {
    const tab = openSyncedTab();
    setMode("source");
    await withFastTimers(async (runPending) => {
      renderCanvas();
      await flush();
      const [editor] = createdEditors;
      editor!._ignoreNextChange = false;
      editor!._model!._value = JSON.stringify({ tagName: "main" });
      fireModelChange(editor!);
      closeAllTabs();
      await runPending();
      expect(tab.doc.document.tagName).toBe("div");
    });
  });

  test("serialization failure on a fresh render leaves the buffer empty", async () => {
    setFormats([MARKDOWN_FORMAT]);
    closeAllTabs();
    const tab = openSyncedTab(undefined, { documentPath: "/project/post.md" });
    tab.doc.sourceFormat = "Markdown";
    setMode("source");
    serializeDocumentMock.mockImplementationOnce(async () => {
      throw new Error("format service unreachable");
    });
    renderCanvas();
    await flush();
    expect(createdModels[0]!._value).toBe("");
  });

  test("serialization failure on a re-render keeps the current buffer", async () => {
    setFormats([MARKDOWN_FORMAT]);
    closeAllTabs();
    const tab = openSyncedTab(undefined, { documentPath: "/project/post.md" });
    tab.doc.sourceFormat = "Markdown";
    setMode("source");
    renderCanvas();
    await flush();
    expect(createdModels[0]!._value).toBe("# markdown source");

    serializeDocumentMock.mockImplementationOnce(async () => {
      throw new Error("format service unreachable");
    });
    renderCanvas();
    await flush();
    expect(createdModels[0]!._value).toBe("# markdown source");
  });

  test("switching modes disposes the monaco editor and its model", async () => {
    openSyncedTab();
    setMode("source");
    renderCanvas();
    await flush();
    const [editor] = createdEditors;
    const [model] = createdModels;

    setMode("design");
    renderCanvas();
    expect(editor!.dispose).toHaveBeenCalled();
    expect(model!.dispose).toHaveBeenCalled();
    expect(view.monacoEditor).toBeNull();
  });
});

// ─── Git diff mode ────────────────────────────────────────────────────────────

describe("git-diff mode", () => {
  test("falls back to design mode when no diff state is set", () => {
    openSyncedTab();
    setMode("git-diff");
    canvasModeFn = () => canvasMode;
    renderCanvas();
    expect(ctx.setCanvasMode).toHaveBeenCalledWith("design");
    expect(canvasPanels.length).toBe(1);
  });

  test("renders Original and Current panels side by side", async () => {
    openSyncedTab();
    setMode("git-diff");
    ctx.gitDiffState = {
      currentContent: JSON.stringify({
        children: [{ tagName: "p", textContent: "new text" }],
        tagName: "div",
      }),
      filePath: "/project/index.json",
      originalContent: JSON.stringify({
        children: [{ tagName: "p", textContent: "old text" }],
        tagName: "div",
      }),
    };
    renderCanvas();
    await flush();

    const headers = [...canvasWrap.querySelectorAll(".canvas-panel-header")].map((h) =>
      h.textContent?.trim(),
    );
    expect(headers).toEqual(["Original", "Current"]);
    expect(canvasPanels.length).toBe(2);
    const [orig, curr] = canvasPanels as unknown as CanvasPanel[];
    expect(orig!.canvas?.textContent).toContain("old text");
    expect(curr!.canvas?.textContent).toContain("new text");
    // Diff panels are never live-patchable
    expect(orig!.ready).toBe(false);
    expect(curr!.ready).toBe(false);
  });

  test("unparseable JSON falls back to a parse-failure document", async () => {
    openSyncedTab();
    setMode("git-diff");
    ctx.gitDiffState = {
      currentContent: "also not json",
      filePath: "/project/index.json",
      originalContent: "not json {",
    };
    renderCanvas();
    await flush();
    expect(canvasPanels[0]!.canvas?.textContent).toContain("Failed to parse");
  });

  test("format files parse diff content through the format host", async () => {
    setFormats([MARKDOWN_FORMAT]);
    openSyncedTab();
    setMode("git-diff");
    ctx.gitDiffState = {
      currentContent: "# new",
      filePath: "/project/post.md",
      originalContent: "# old",
    };
    renderCanvas();
    await flush();
    expect(parseSourceForPathMock).toHaveBeenCalledWith("/project/post.md", "# old");
    expect(parseSourceForPathMock).toHaveBeenCalledWith("/project/post.md", "# new");
    expect(canvasPanels[0]!.canvas?.textContent).toContain("parsed-md");
  });
});

// ─── Edit (content) mode ──────────────────────────────────────────────────────

describe("edit mode", () => {
  test("renders a centered column with the iframe-rendered content", async () => {
    openSyncedTab();
    setMode("edit");
    renderCanvas();
    await flush();

    const column = canvasWrap.querySelector(".content-edit-column") as HTMLElement;
    expect(column).not.toBeNull();
    expect(column.getAttribute("style")).toContain("max-width:320px");
    expect(canvasWrap.querySelector(".content-edit-canvas")).not.toBeNull();
    expect(canvasPanels.length).toBe(1);

    const panel = canvasPanels[0] as unknown as CanvasPanel;
    expect(panel.scrollContainer?.classList.contains("content-edit-canvas")).toBe(true);
    expect(panel.canvas?.querySelector("p")?.textContent).toBe("Hello");
    // The real tab document mounted, so the panel is patchable.
    expect(panel.ready).toBe(true);
    // "Iframe render OK" is deleted: a debug string shipped to end users and legible in a published
    // Docs screenshot. A render that worked is the canvas you are looking at.
    expect(notified).not.toHaveBeenCalled();
  });

  test("uses the document base width for the content column", async () => {
    openSyncedTab({
      $media: { "--": "600px" },
      children: [{ tagName: "p", textContent: "Hi" }],
      tagName: "div",
    } as never);
    setMode("edit");
    renderCanvas();
    await flush();
    const column = canvasWrap.querySelector(".content-edit-column") as HTMLElement;
    expect(column.getAttribute("style")).toContain("max-width:600px");
  });

  test("re-applies the persisted edit zoom after a render", async () => {
    const tab = openSyncedTab();
    setMode("edit");
    renderCanvas();
    await flush();
    // The column now exists — give it a measurable width (happy-dom performs no layout), set the
    // Persisted zoom, and re-render: the edit branch must re-fit from the LIVE column width.
    const column = canvasWrap.querySelector(".content-edit-column") as HTMLElement;
    stubRect(column, { width: 800 });
    tab.session.ui.editZoom = 2;
    renderCanvas();
    await flush();

    const panel = canvasPanels[0] as unknown as CanvasPanel;
    expect(panel.canvas?.style.width).toBe("400px");
    expect(panel.canvas?.style.transform).toBe("scale(2)");
    expect(panel._width).toBe(400);
  });

  test("a zoom-only change never re-renders the canvas (live edit-session invariant)", async () => {
    const tab = openSyncedTab();
    setMode("edit");
    renderCanvas();
    await flush();
    const gen = view.renderGeneration;
    const mountSpy = mock(async () => {});
    iframeImpl = mountSpy as never;

    setEditZoom(1.5);
    await flush();

    // The zoom landed as bare style writes — no render generation bump, no iframe re-mount (which
    // Would rebuild the iframe DOM and destroy a live inline-edit session).
    expect(tab.session.ui.editZoom).toBe(1.5);
    expect(view.renderGeneration).toBe(gen);
    expect(mountSpy).not.toHaveBeenCalled();
  });
});

// ─── Iframe render pipeline (success / staleness / rejection) ──────────────────

describe("iframe render pipeline", () => {
  test("a successful iframe mount marks the panel ready and reports status", async () => {
    const tab = openSyncedTab();
    setMode("edit");
    renderCanvas();
    await flush();

    expect(tab.session.canvas.status).toBe("ready");
    expect(tab.session.canvas.scope).toBeNull();
    expect(tab.session.canvas.error).toBeNull();
    expect(notified).not.toHaveBeenCalled();
    expect((canvasPanels[0] as unknown as CanvasPanel).ready).toBe(true);
  });

  test("a stale iframe mount bails without touching state", async () => {
    const tab = openSyncedTab();
    let resolveMount: () => void = () => {};
    iframeImpl = () =>
      new Promise((resolve) => {
        resolveMount = resolve;
      });
    setMode("edit");
    renderCanvas();
    view.renderGeneration += 1; // A newer render started
    resolveMount();
    await flush();
    expect(tab.session.canvas.status).toBe("idle");
    expect(notified).not.toHaveBeenCalled();
    expect((canvasPanels[0] as unknown as CanvasPanel).ready).toBe(false);
  });

  test("a rejected iframe mount REACHES A SURFACE and leaves the panel un-ready", async () => {
    openSyncedTab();
    iframeImpl = async () => {
      throw new Error("iframe exploded");
    };
    setMode("edit");
    renderCanvas();
    await flush();
    // It used to be a `console.warn` — the author saw a blank canvas and nothing else.
    expect(notified).toHaveBeenCalledWith("The canvas could not be mounted.");
    expect((canvasPanels[0] as unknown as CanvasPanel).ready).toBe(false);
  });
});

// ─── Design / preview mode ────────────────────────────────────────────────────

describe("design mode", () => {
  test("renders a single full-width panel without media", async () => {
    openSyncedTab();
    renderCanvas();
    await flush();
    expect(view.panzoomWrap).not.toBeNull();
    expect(canvasPanels.length).toBe(1);
    const panel = canvasPanels[0] as unknown as CanvasPanel;
    expect(panel.element?.classList.contains("full-width")).toBe(true);
    expect(canvasWrap.querySelector(".canvas-panel-header")).toBeNull();
    expect(view.panzoomWrap?.style.transform).toContain("scale(1)");
    expect(panel.canvas?.querySelector("p")?.textContent).toBe("Hello");
  });

  test("renders a labeled base panel when a custom base width is set", async () => {
    openSyncedTab({
      $media: { "--": "600px" },
      children: [{ tagName: "p", textContent: "Hello" }],
      tagName: "div",
    } as never);
    renderCanvas();
    await flush();
    const panel = canvasPanels[0] as unknown as CanvasPanel;
    expect(panel.mediaName).toBe("base");
    expect(panel.element?.querySelector(".canvas-panel-header")?.textContent?.trim()).toBe(
      "Base (600px)",
    );
    expect(panel.viewport?.style.width).toBe("600px");
  });

  test("renders one panel per breakpoint plus base", async () => {
    openSyncedTab({
      $media: { "--": "320px", md: "(min-width: 768px)" },
      children: [{ tagName: "p", textContent: "Hello" }],
      tagName: "div",
    } as never);
    renderCanvas();
    await flush();

    expect(canvasPanels.length).toBe(2);
    const headers = [...canvasWrap.querySelectorAll(".canvas-panel-header")].map((h) =>
      h.textContent?.trim(),
    );
    expect(headers).toEqual(["Base (320px)", "Md (768px)"]);
    // Base panel header is highlighted when activeMedia is null
    expect(
      canvasPanels[0]!.element?.querySelector(".canvas-panel-header")?.classList.contains("active"),
    ).toBe(true);
    // Both panels rendered content (second one via deferred setTimeout)
    for (const panel of canvasPanels as unknown as CanvasPanel[]) {
      expect(panel.canvas?.querySelector("p")?.textContent).toBe("Hello");
    }
    // The md(768) panel's viewport is sized to its breakpoint width (observable without a layout
    // Engine; the real @media now evaluates natively inside each panel's iframe viewport).
    expect((canvasPanels[1] as unknown as CanvasPanel).viewport?.style.width).toBe("768px");
  });

  test("every artboard of a pass mounts under that pass's generation", async () => {
    const gens: number[] = [];
    iframeImpl = async (gen) => {
      gens.push(gen);
    };
    openSyncedTab({
      $media: { "--": "320px", lg: "(min-width: 1024px)", md: "(min-width: 768px)" },
      children: [{ tagName: "p", textContent: "Hello" }],
      tagName: "div",
    } as never);

    renderCanvas();
    await flush();

    // Three artboards, one generation. The host resolves the document once per generation, so a
    // Pass that numbered its own artboards differently would resolve once per artboard.
    expect(gens).toHaveLength(3);
    expect(new Set(gens).size).toBe(1);
    expect(gens[0]).toBe(view.renderGeneration);
  });

  test("a superseded pass's deferred artboards keep their own (stale) generation", async () => {
    const gens: number[] = [];
    iframeImpl = async (gen) => {
      gens.push(gen);
    };
    openSyncedTab({
      $media: { "--": "320px", md: "(min-width: 768px)" },
      children: [{ tagName: "p", textContent: "Hello" }],
      tagName: "div",
    } as never);

    // Two passes back to back: the first pass's second artboard is still queued behind a timer when
    // The second pass starts. Reading `view.renderGeneration` inside that timer would stamp the
    // First pass's artboard with the SECOND pass's number — a duplicate render the iframe cannot
    // Recognise as superseded, because its stale-gen guard only drops a number it has already seen
    // Passed. Carrying the pass's own generation is what lets the frame drop it.
    renderCanvas();
    const firstGen = view.renderGeneration;
    renderCanvas();
    const secondGen = view.renderGeneration;
    await flush();

    expect(secondGen).toBeGreaterThan(firstGen);
    expect(gens.filter((g) => g === firstGen)).toHaveLength(2);
    expect(gens.filter((g) => g === secondGen)).toHaveLength(2);
  });

  test("mode transitions run cleanup callbacks and stop panel scopes", () => {
    openSyncedTab();
    const dndCleanup = mock(() => {});
    const eventCleanup = mock(() => {});
    const stop = mock(() => {});
    const disconnect = mock(() => {});
    view.canvasDndCleanups = [dndCleanup];
    view.canvasEventCleanups = [eventCleanup];
    view.centerObserver = { disconnect } as never;
    canvasPanels.push({ renderScope: { stop } } as never);

    renderCanvas();
    expect(dndCleanup).toHaveBeenCalled();
    expect(eventCleanup).toHaveBeenCalled();
    expect(stop).toHaveBeenCalled();
    expect(disconnect).toHaveBeenCalled();
    expect(view.canvasDndCleanups).toEqual([]);
    expect(view.canvasEventCleanups).toEqual([]);
  });
});

// ─── Fit on entering a panzoom mode ───────────────────────────────────────────
// Design used to open at 100%, so a 1280px artboard landed clipped mid-word in a ~700px pane.

describe("fit on entering Design", () => {
  /** Give the (layout-less) canvas wrap a measurable viewport. */
  function sizeViewport(width: number, height = 600) {
    Object.defineProperty(canvasWrap, "clientWidth", { configurable: true, value: width });
    Object.defineProperty(canvasWrap, "clientHeight", { configurable: true, value: height });
  }

  test("scales a wide artboard down to the pane on the mode transition", async () => {
    sizeViewport(700);
    openSyncedTab({
      $media: { "--": "1280px" },
      children: [{ tagName: "p", textContent: "Hello" }],
      tagName: "div",
    } as never);
    renderCanvas();
    await flush();
    // 1280 + 32 padding = 1312 of artboard in 700px of pane.
    expect(zoom).toBeCloseTo(700 / 1312);
  });

  test("a re-render in the same mode does not re-fit over the author's zoom", async () => {
    sizeViewport(700);
    openSyncedTab({
      $media: { "--": "1280px" },
      children: [{ tagName: "p", textContent: "Hello" }],
      tagName: "div",
    } as never);
    renderCanvas();
    await flush();
    zoom = 1;
    renderCanvas();
    await flush();
    expect(zoom).toBe(1);
  });

  test("stylebook entry fits too — its specimen sheet is the same artboard", async () => {
    sizeViewport(700);
    // The real renderStylebookMode builds the panzoom surface; the mock stands in for it.
    renderStylebookMode.mockImplementation(() => {
      const wrap = document.createElement("div");
      canvasWrap.append(wrap);
      view.panzoomWrap = wrap as HTMLDivElement;
      canvasPanels.push({ _width: 800 } as never);
    });
    try {
      openSyncedTab();
      setMode("stylebook");
      renderCanvas();
      await flush();
      // The specimen sheet (800) + 32 padding of artboard in 700px of pane.
      expect(zoom).toBeCloseTo(700 / 832);
    } finally {
      renderStylebookMode.mockImplementation(() => {});
    }
  });
});

// ─── Preview: a real, scrolling frame ─────────────────────────────────────────

describe("preview mode", () => {
  test("renders one full-bleed stage with no panzoom transform", async () => {
    openSyncedTab();
    setMode("preview");
    renderCanvas();
    await flush();

    expect(canvasWrap.querySelector(".preview-stage")).not.toBeNull();
    expect(canvasWrap.querySelector(".panzoom-wrap")).toBeNull();
    expect(view.panzoomWrap).toBeNull();
    expect(canvasPanels.length).toBe(1);
    const panel = canvasPanels[0] as unknown as CanvasPanel;
    expect(panel.element?.classList.contains("full-width")).toBe(true);
    expect(panel.canvas?.querySelector("p")?.textContent).toBe("Hello");
  });

  test("entering and leaving preview is a real mode transition", async () => {
    // The toggle is the real one: the render composes the pane's effective mode itself now
    // (`canvasModeOfPane`), so flipping `ui.preview` is the whole gesture.
    const tab = openSyncedTab();
    renderCanvas();
    await flush();
    expect(canvasWrap.querySelector(".panzoom-wrap")).not.toBeNull();

    // The effective mode flips while the BASE mode stays "design" — the preview toggle.
    tab.session.ui.preview = true;
    renderCanvas();
    await flush();
    expect(canvasWrap.querySelector(".preview-stage")).not.toBeNull();
    expect(canvasWrap.querySelector(".panzoom-wrap")).toBeNull();

    tab.session.ui.preview = false;
    renderCanvas();
    await flush();
    expect(canvasWrap.querySelector(".preview-stage")).toBeNull();
    expect(canvasWrap.querySelector(".panzoom-wrap")).not.toBeNull();
  });

  test("preview over a base of edit still gets the stage, not the edit column", async () => {
    const tab = openSyncedTab();
    setMode("edit");
    tab.session.ui.preview = true;
    renderCanvas();
    await flush();
    expect(canvasWrap.querySelector(".preview-stage")).not.toBeNull();
    expect(canvasWrap.querySelector(".content-edit-canvas")).toBeNull();
    tab.session.ui.preview = false;
  });
});

// ─── Stylebook mode ───────────────────────────────────────────────────────────

describe("stylebook mode", () => {
  test("first render delegates to renderStylebookMode with canvas helpers", () => {
    openSyncedTab();
    setMode("stylebook");
    renderCanvas();
    expect(renderStylebookMode).toHaveBeenCalledTimes(1);
    const helpers = renderStylebookMode.mock.calls[0]![0] as Record<string, unknown>;
    for (const key of [
      "applyTransform",
      "canvasPanelTemplate",
      "observeCenterUntilStable",
      "updateActivePanelHeaders",
    ]) {
      expect(typeof helpers[key]).toBe("function");
    }
  });

  test("re-render with unchanged filters posts a styleUpdate to live stylebook hosts", () => {
    openSyncedTab();
    setMode("stylebook");
    const updates: Record<string, unknown>[] = [];
    styleUpdateImpl = (style) => {
      updates.push(style);
      return 1; // A live stylebook host received it → no full rebuild.
    };
    renderCanvas();
    renderCanvas();
    expect(updates).toHaveLength(1);
    expect(renderStylebookMode).toHaveBeenCalledTimes(1);
  });

  test("falls through to a full stylebook render when no host is live yet", () => {
    openSyncedTab();
    setMode("stylebook");
    styleUpdateImpl = () => 0; // No stylebook iframe mounted → fast path can't apply.
    renderCanvas();
    renderCanvas();
    expect(renderStylebookMode).toHaveBeenCalledTimes(2);
  });

  test("filter changes force a full stylebook re-render", () => {
    openSyncedTab();
    setMode("stylebook");
    const updates: Record<string, unknown>[] = [];
    styleUpdateImpl = (style) => {
      updates.push(style);
      return 1;
    };
    renderCanvas();
    shell.stylebook.filter = "head";
    renderCanvas();
    expect(renderStylebookMode).toHaveBeenCalledTimes(2);
    expect(updates).toHaveLength(0);
  });

  test("customized-only toggle also forces a full re-render", () => {
    openSyncedTab();
    setMode("stylebook");
    renderCanvas();
    shell.stylebook.customizedOnly = true;
    renderCanvas();
    expect(renderStylebookMode).toHaveBeenCalledTimes(2);
  });
});

// ─── scheduleCanvasRender ─────────────────────────────────────────────────────

describe("scheduleCanvasRender", () => {
  test("dedupes concurrent schedule requests into one render", async () => {
    setProjectState(null);
    scheduleCanvasRender();
    scheduleCanvasRender();
    await rafTurn();
    await flush();
    expect(renderWelcome).toHaveBeenCalledTimes(1);
  });

  test("catches renderCanvas errors inside the frame callback", async () => {
    const tab = openSyncedTab();
    // Poison the tab UI so the dispatch's base-mode read throws inside the frame callback.
    (tab.session as unknown as { ui: unknown }).ui = null;
    const error = spyOn(console, "error").mockImplementation(() => {});
    try {
      scheduleCanvasRender();
      await rafTurn();
      await flush();
      expect(error.mock.calls.some((c) => String(c[0]).includes("renderCanvas error"))).toBe(true);
    } finally {
      error.mockRestore();
    }
  });
});

// ─── renderOverlays ───────────────────────────────────────────────────────────

describe("renderOverlays", () => {
  test("delegates to the overlays panel renderer", () => {
    renderOverlays();
    expect(overlaysRender).toHaveBeenCalled();
  });
});

// ─── The Document Header card's slot (§3.2 ⑧) ─────────────────────────────────

/**
 * `#frontmatter-panel` is deleted; the stage draws the card's host. What is asserted here is WHERE
 * — the two authoring views put it in different places for a reason, and every other surface must
 * put it nowhere at all.
 */
describe("the Document Header slot", () => {
  // The card really renders here — its SEO block reaches for the media listing, so the stage needs
  // A platform. Local to this block: the rest of the file asserts dispatch, not panel content.
  beforeEach(() => {
    installMockPlatform();
    mountDocHeader();
  });

  afterEach(() => {
    unmountDocHeader();
  });

  /** A tab whose document genuinely has a header (`hasDocumentHeader` is the only predicate). */
  function openHeaderedTab() {
    const tab = openSyncedTab();
    tab.doc.document.title = "Designing for slowness";
    return tab;
  }

  const slot = () => canvasWrap.querySelector(".doc-header-host");

  test("Edit puts it INSIDE the document column, above the artefact", async () => {
    openHeaderedTab();
    setMode("edit");
    renderCanvas();
    await flush();

    const column = canvasWrap.querySelector(".content-edit-column")!;
    expect(column.firstElementChild?.classList.contains("doc-header-host")).toBe(true);
    expect(slot()?.classList.contains("in-column")).toBe(true);
    // In the column means in the document's own scroller: it scrolls with the artefact.
    expect(slot()?.closest(".content-edit-canvas")).not.toBeNull();
  });

  test("Design pins it above the panzoom surface, and stacks the stage to make room", async () => {
    openHeaderedTab();
    setMode("design");
    renderCanvas();
    await flush();

    expect(slot()?.classList.contains("pinned")).toBe(true);
    // The artboards are drawn under a transform; the card must not be inside it.
    expect(slot()?.closest(".panzoom-wrap")).toBeNull();
    expect(canvasWrap.style.flexDirection).toBe("column");
    expect(canvasWrap.style.alignItems).toBe("stretch");
  });

  test("Design with breakpoints pins one slot, not one per artboard", async () => {
    const tab = openSyncedTab({
      $media: { "--": "400px", tablet: "(min-width: 768px)" },
      children: [{ tagName: "p", textContent: "Hi" }],
      tagName: "div",
      title: "Two artboards",
    } as never);
    expect(tab.doc.document.title).toBe("Two artboards");
    setMode("design");
    renderCanvas();
    await flush();

    expect(canvasWrap.querySelectorAll(".doc-header-host").length).toBe(1);
    expect(canvasWrap.querySelectorAll(".canvas-panel").length).toBeGreaterThan(1);
  });

  test("a document with no header gets no slot, and the stage stays a row", async () => {
    openSyncedTab();
    setMode("design");
    renderCanvas();
    await flush();

    expect(slot()).toBeNull();
    expect(canvasWrap.style.flexDirection).toBe("");
  });

  test("Preview, Source and Grid draw no header — they are not authoring views", async () => {
    openHeaderedTab();
    for (const mode of ["preview", "source", "grid"]) {
      setMode(mode);
      renderCanvas();
      await flush();
      expect(slot()).toBeNull();
    }
  });

  test("a logic editor in the dock leaves the card slotted, and BOUND", async () => {
    // `wantsDocHeader` used to carry `!editingFunction && !editingFormula`, from the days when the
    // Sub-editors covered the stage. In the dock they do not, so those clauses reached
    // `attachDocumentHeaderHost(null)` on a card that was still visible: it was detached, not
    // Removed, and went on showing frontmatter from before the edit with nothing to say so.
    const tab = openHeaderedTab();
    setMode("edit");
    renderCanvas();
    await flush();
    const before = slot();
    expect(before).not.toBeNull();

    tab.session.ui.editingFunction = { path: [], prop: "onclick" } as never;
    renderCanvas();
    await flush();
    expect(slot()).not.toBeNull();

    tab.session.ui.editingFunction = null;
    tab.session.ui.editingFormula = { defName: "total", type: "def" };
    renderCanvas();
    await flush();
    expect(slot()).not.toBeNull();
  });
});

// ─── Per-pane rendering (P8) ──────────────────────────────────────────────────

describe("renderCanvas is addressed by pane", () => {
  test("renders the NAMED pane's tab into the NAMED pane's stage", async () => {
    // Two documents, two panes, one call each — and neither pass may touch the other's host.
    const left = openSyncedTab({
      children: [{ tagName: "p", textContent: "left" }],
      tagName: "div",
    });
    const right = openTab({
      document: { children: [{ tagName: "p", textContent: "right" }], tagName: "div" },
      documentPath: "/project/right.json",
      id: "pane-render-right",
    });
    right.session.ui.canvasMode = "design";
    // `openTab` lands every tab in the focused pane; hand the second one to the second pane, which
    // Is what `splitRight` will do once the cap is lifted.
    workspace.panes[0]!.tabOrder = [left.id];
    workspace.panes[0]!.activeTabId = left.id;
    workspace.panes.push({
      activeTabId: right.id,
      id: SECONDARY_PANE,
      tabOrder: [right.id],
    });

    const secondWrap = document.createElement("div");
    document.body.append(secondWrap);
    registerCanvasSurface(SECONDARY_PANE, secondWrap);

    renderCanvas(PRIMARY_PANE);
    renderCanvas(SECONDARY_PANE);
    await flush();

    expect(canvasWrap.textContent).toContain("left");
    expect(canvasWrap.textContent).not.toContain("right");
    expect(secondWrap.textContent).toContain("right");
    expect(secondWrap.textContent).not.toContain("left");
    // Each stage kept its own panel list and its own mode memory.
    expect(surface.panels).toHaveLength(1);
    expect(surfaceForPane(SECONDARY_PANE).panels).toHaveLength(1);
    expect(left.id).not.toBe(right.id);

    surfaceForPane(SECONDARY_PANE).panels.length = 0;
    surfaceForPane(SECONDARY_PANE).prevCanvasMode = null;
  });

  test("a scheduled frame is deduped per pane, not across the shell", async () => {
    // A project IS open, so an empty pane clears its stage rather than drawing the Start pane.
    resetStudioState({ isSiteProject: true });
    openSyncedTab();
    const secondWrap = document.createElement("div");
    document.body.append(secondWrap);
    registerCanvasSurface(SECONDARY_PANE, secondWrap);

    // Two schedules for the SAME pane collapse into one frame…
    scheduleCanvasRender(PRIMARY_PANE);
    scheduleCanvasRender(PRIMARY_PANE);
    // …and the other pane's is not swallowed by them.
    scheduleCanvasRender(SECONDARY_PANE);
    await flush();

    expect(canvasWrap.querySelector(".panzoom-wrap")).not.toBeNull();
    // The second pane shows nothing, so its pass reset its stage rather than borrowing pane one's.
    expect(secondWrap.textContent).toBe("");
    expect(surfaceForPane(SECONDARY_PANE).panels).toHaveLength(0);
  });

  /*
   * Taking the stage REPAINTS it, and nothing else will.
   *
   * `moveCanvasStage` releases what the losing pane mounted, so the moment the stage changes hands
   * the DOM standing in it belongs to a pane that no longer owns it and no surface describes it.
   * Both canvas effects are keyed on `activeTab`, and the two handovers that matter — `⌘\` and
   * `View: Unsplit` — move a PANE, not a document: the same tab stays active, so neither effect
   * fires. Unsplit is where that showed. `#canvas-wrap` was left empty, clicking the tab did not
   * even count a full render, and only a reload brought the editor back.
   */
  test("taking the stage repaints it, with no change of active tab to trigger one", async () => {
    const tab = openSyncedTab();
    // The stage belongs to the side pane, which is showing the same tab — the state `⌘\` leaves
    // Behind, and the state Unsplit hands back to the primary.
    workspace.panes.push({ activeTabId: tab.id, id: SECONDARY_PANE, tabOrder: [tab.id] });
    workspace.activePaneId = SECONDARY_PANE;
    handOverCanvasStage(SECONDARY_PANE, canvasWrap);
    await flush();
    expect(canvasWrap.querySelector(".panzoom-wrap")).not.toBeNull();

    workspace.panes[0]!.tabOrder = [tab.id];
    workspace.panes[0]!.activeTabId = tab.id;
    workspace.activePaneId = PRIMARY_PANE;
    workspace.panes = workspace.panes.filter((pane) => pane.id === PRIMARY_PANE);
    const before = canvasPerf.fullRenders;

    handOverCanvasStage(PRIMARY_PANE, canvasWrap);
    await flush();

    // The stage is the primary's, it has been drawn again, and what is on it is the document.
    expect(canvasPerf.fullRenders).toBeGreaterThan(before);
    expect(surfaceForPane(PRIMARY_PANE).panels.length).toBeGreaterThan(0);
    expect(canvasWrap.querySelector(".panzoom-wrap")).not.toBeNull();
    expect(surfaceForPane(SECONDARY_PANE).panels).toHaveLength(0);

    surfaceForPane(SECONDARY_PANE).wrap = null as unknown as HTMLElement;
  });

  /*
   * A fast path may not answer for a stage it cannot see.
   *
   * Each one asks a MODULE whether it mounted — `view.monacoEditor`, `gridPanelMounted`, … — and
   * that answer outlives the DOM. Taking the stage releases the surface, so the next pass is a mode
   * transition, clears the wrap, and then the source fast path used to return on the strength of a
   * Monaco editor whose container had just been thrown away. That is the second half of the Unsplit
   * defect, and it survives the lifecycle fix on its own: an empty `#canvas-wrap`, a live editor
   * nobody can see, and a reload to get it back.
   */
  test("a stage handed back in code view is rebuilt, not fast-pathed onto a cleared one", async () => {
    openSyncedTab();
    setMode("source");
    workspace.panes.push({
      activeTabId: workspace.activeTabId,
      id: SECONDARY_PANE,
      tabOrder: [workspace.activeTabId!],
    });
    workspace.activePaneId = SECONDARY_PANE;
    handOverCanvasStage(SECONDARY_PANE, canvasWrap);
    await flush();
    expect(canvasWrap.querySelector(".source-editor")).not.toBeNull();
    expect(view.monacoEditor).not.toBeNull();

    // Unsplit: the tab and the stage go back to the primary, and the SAME tab stays active.
    workspace.panes[0]!.tabOrder = [workspace.activeTabId!];
    workspace.panes[0]!.activeTabId = workspace.panes[1]!.activeTabId;
    workspace.activePaneId = PRIMARY_PANE;
    workspace.panes = workspace.panes.filter((pane) => pane.id === PRIMARY_PANE);

    handOverCanvasStage(PRIMARY_PANE, canvasWrap);
    await flush();

    expect(canvasWrap.querySelector(".source-editor")).not.toBeNull();
    expect(view.monacoEditor).not.toBeNull();

    surfaceForPane(SECONDARY_PANE).wrap = null as unknown as HTMLElement;
  });

  test("a pane with no stage paints nothing instead of throwing", async () => {
    // The shell has ONE `#canvas-wrap` and it belongs to whichever pane is focused, so the other
    // Pane has no stage at all. Two schedulers reach that state: a frame queued for the pane that
    // Just lost the stage, and `escalateToFullRender` on a tab in the pane that is not on screen.
    // Both must be nothing-to-paint. Unguarded, this threw on Lit's private render part — which is
    // What `⌘\` did, because `splitRight` focuses the pane it creates.
    const tab = openSyncedTab();
    workspace.panes.push({
      activeTabId: tab.id,
      id: SECONDARY_PANE,
      tabOrder: [tab.id],
    });
    const stageless = surfaceForPane(SECONDARY_PANE);
    stageless.wrap = null as unknown as HTMLElement;

    expect(() => {
      renderCanvas(SECONDARY_PANE);
    }).not.toThrow();
    await flush();

    // And nothing was recorded against it — a stage-less pass must not leave panels behind for
    // `panelHostingCanvas` to answer with, nor a mode memory its next real pass would trust.
    expect(stageless.panels).toHaveLength(0);
    expect(stageless.prevCanvasMode).toBeNull();
  });
});
