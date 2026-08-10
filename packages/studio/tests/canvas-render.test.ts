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
  standUpPaneGrid,
  stubRect,
} from "./harness";
import { displayTagName } from "@jxsuite/schema/guards";
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { notifyModule } from "./notify-mock";
import { initShellRefs, setProjectState } from "../src/store";
import {
  activeCanvasSurface,
  registerCanvasSurface,
  surfaceForPane,
  tabOfPane,
  unregisterCanvasSurface,
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
import { commitTabBuffers, tabBufferUnsaved } from "../src/services/monaco-buffer";
import { toRaw } from "../src/reactivity";
import { shell } from "../src/shell";
import { setFormats } from "../src/format/format-host";
import { setEditZoom } from "../src/canvas/canvas-utils";
import { MARKDOWN_FORMAT } from "./format-fixture";
import { createCommandRegistry } from "../src/commands/registry";
import { makeContext } from "../src/commands/context";
import { setActiveRegistry } from "../src/commands/active-registry";
import { derivationCommands, noopDerivationDeps } from "../src/workspace/pane-derive";
import type { CanvasPanel } from "../src/types";
import type { PaneDerivation } from "../src/workspace/workspace";
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
    const el = document.createElement(displayTagName(child.tagName) || "span");
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
const renderStylebookMode = mock((_surface: unknown, _helpers: unknown) => {});
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
  /** Fires the adopting editor's change handlers, as a real model's `setValue` does. */
  _fire: () => void;
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
        /**
         * Mirrors Monaco, and mirrors the DOCK's double, which has always done this: a programmatic
         * `setValue` fires `onDidChangeModelContent` exactly as a keystroke does. That is the whole
         * reason `_ignoreNextChange` exists, and a double that stayed silent left the flag set
         * after every programmatic write — so each test had to clear it by hand before a keystroke
         * would be seen, and no test could have caught a write site that forgot to set it.
         */
        setValue: (v: string) => {
          ed._model?.setValue(v);
        },
      };
      // A model belongs to the editor that adopts it, and `model.setValue` reaches that editor's
      // Change handlers — which is how the source view's initial load fires one.
      if (ed._model) {
        ed._model._fire = () => fireModelChange(ed);
      }
      createdEditors.push(ed);
      return ed;
    },
    createModel: (value: string, lang: string, uri: unknown) => {
      const m: FakeModel = {
        _value: value,
        _fire: () => {},
        dispose: mock(() => {}),
        getValue: () => m._value,
        lang,
        setValue: (v: string) => {
          m._value = v;
          m._fire();
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
  /* The non-lazy way out of `liveHosts`: `panels/pane-grid.ts` calls it as a cell is
     disposed, so it is on the import graph of anything that mounts the shell. */
  releaseCanvasHosts: () => 0,
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

const { initCanvasRender, renderCanvas, renderOverlays, scheduleCanvasRender } =
  await import("../src/canvas/canvas-render");
const { mount: mountDocHeader, unmount: unmountDocHeader } =
  await import("../src/panels/frontmatter-panel");

// ─── Test context ─────────────────────────────────────────────────────────────

let canvasMode = "design";

/**
 * The render dispatch composes the effective mode from the PANE's tab itself (`canvasModeOfPane`),
 * and so do the canvas-utils helpers now that nothing is injected into them — `canvasMode` is only
 * this fixture's own record of what it last asked for. Keep both in sync here.
 */
function setMode(m: string) {
  canvasMode = m;
  const tab = activeTab.value;
  if (tab) {
    tab.session.ui.canvasMode = m;
  }
}

/**
 * The primary pane's own pan-zoom scale.
 *
 * Read off the tab rather than off a captured `setZoomDirect`: the fit writes through the SURFACE
 * it was handed now (`tabOfPane(surface.paneId)`), which is the whole of defect S3 — an injected
 * setter spelled `activeTab` made one pane's fit land on the other pane's transform.
 */
const paneZoom = () => activeTab.value?.session.ui.zoom ?? 1;

/** Put the primary pane's document back at life size. */
function setPaneZoom(value: number) {
  const tab = activeTab.value;
  if (tab) {
    tab.session.ui.zoom = value;
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
  /* Takes the tab. `renderCanvas` is per-PANE, so its git-diff fallback names the tab of the pane
     it is drawing rather than whichever one has focus. */
  setCanvasMode: mock((_tab: unknown, m: string) => {
    setMode(m);
  }),
  setGitDiffState: mock(() => {}),
};

function setupShell() {
  document.body.innerHTML = "";
  for (const el of document.head.querySelectorAll("style[data-jx-owner]")) {
    el.remove();
  }
  for (const id of ["activity-bar", "left-panel", "right-panel", "toolbar", "statusbar"]) {
    const el = document.createElement("div");
    el.id = id;
    document.body.append(el);
  }
  initShellRefs();
  standUpPaneGrid();
}

/** The primary pane's stage — what `#canvas-wrap` used to be, resolved through its surface. */
function stageEl(): HTMLElement {
  return surfaceForPane("primary").wrap;
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
  ctx.gitDiffState = null;
  styleUpdateImpl = () => 0;
  iframeImpl = async (_gen, doc, canvas) => {
    canvas.innerHTML = "";
    const root = document.createElement("div");
    for (const child of (doc.children as JxMutableNode[] | undefined) ?? []) {
      const el = document.createElement(displayTagName(child.tagName) || "span");
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
  surfaceForPane("primary").panzoomWrap = null;
  surfaceForPane("primary").monacoEditor = null;
  view.functionEditor = null;
  surfaceForPane("primary").centerObserver = null;
  surfaceForPane("primary").renderGeneration = 0;
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
    expect(renderWelcome).toHaveBeenCalledWith(stageEl());
  });

  test("clears the canvas when a project is loaded but no tab is open", () => {
    resetStudioState({ isSiteProject: true });
    stageEl().textContent = "leftover";
    renderCanvas();
    expect(renderWelcome).not.toHaveBeenCalled();
    expect(stageEl().textContent).toBe("");
  });

  // The dev server probes its root into projectState even when that root is only a workspace
  // (no project.json). That is not an open project — the welcome screen must stay put instead of
  // Being replaced by a blank canvas a moment after boot.
  test("keeps the welcome screen when the root is not a site project", () => {
    resetStudioState({ isSiteProject: false, projectRoot: ".", root: "/repo" });
    renderCanvas();
    expect(renderWelcome).toHaveBeenCalledWith(stageEl());
  });
});

// ─── Close-all / reopen lifecycle (toxic-state regression) ────────────────────

describe("tab close/reopen lifecycle", () => {
  /** Read Lit's private render-part marker without tripping noImplicitAny. */
  const litPart = () => (stageEl() as unknown as Record<string, unknown>)["_$litPart$"];

  test("reopening after closing all tabs re-renders without a dangling Lit part", async () => {
    // A project is open, so closing every tab leaves a bare canvas (not the welcome screen).
    resetStudioState({ isSiteProject: true });
    openSyncedTab();
    setMode("edit");
    renderCanvas();
    await flush();
    expect(stageEl().querySelector(".content-edit-column")).not.toBeNull();
    // CanvasWrap now owns a Lit render part
    expect(litPart()).toBeDefined();

    // Closing every tab must eject the part along with the DOM — not just the DOM. Leaving the part
    // Behind is what previously made the next litRender throw "ChildPart has no parentNode".
    closeAllTabs();
    renderCanvas();
    expect(stageEl().textContent).toBe("");
    expect(litPart()).toBeUndefined();
    expect(surface.prevCanvasMode).toBeNull();

    // Reopening must render cleanly rather than crashing the canvas into an unusable state.
    openSyncedTab();
    setMode("edit");
    expect(() => renderCanvas()).not.toThrow();
    await flush();
    expect(stageEl().querySelector(".content-edit-column")).not.toBeNull();
  });

  test("edit-mode column hugs a component definition (is-component) but fills for a page", async () => {
    // A page root (plain div) → the column fills the viewport (document-like editing surface).
    openSyncedTab({ children: [{ tagName: "p", textContent: "Hi" }], tagName: "div" });
    setMode("edit");
    renderCanvas();
    await flush();
    const pageColumn = stageEl().querySelector(".content-edit-column")!;
    expect(pageColumn.classList.contains("is-component")).toBe(false);

    // A component-definition root (custom-element tag) → the column hugs its content.
    openSyncedTab({ children: [{ tagName: "h2", textContent: "Hi" }], tagName: "eer-cta" });
    setMode("edit");
    renderCanvas();
    await flush();
    const compColumn = stageEl().querySelector(".content-edit-column")!;
    expect(compColumn.classList.contains("is-component")).toBe(true);
  });

  test("closing all tabs while in source mode disposes the monaco editor", async () => {
    openSyncedTab();
    setMode("source");
    renderCanvas();
    await flush();
    /* `mountSourceEditor` is a FLOATING async mount — `void mountSourceEditor(…)` around a dynamic
       import — so "the editor exists" is not established by a fixed number of turns. Two turns is
       normally plenty and once, on a loaded machine, was not: the test failed at the line below
       with `createdEditors` empty. That is worth waiting for rather than tolerating, because
       `scripts/check-lens-mutants.ts` reads a red test file as a killed mutant and would report
       nineteen false kills off one flake. */
    for (let turns = 0; createdEditors.length === 0 && turns < 20; turns++) {
      await flush();
    }
    const [editor] = createdEditors;
    const [model] = createdModels;
    expect(surfaceForPane("primary").monacoEditor).toBe(editor as never);

    closeAllTabs();
    renderCanvas();
    expect(editor!.dispose).toHaveBeenCalled();
    expect(model!.dispose).toHaveBeenCalled();
    expect(surfaceForPane("primary").monacoEditor).toBeNull();

    // Reopening source mode builds a fresh editor instead of writing into the dead, detached one.
    openSyncedTab();
    setMode("source");
    renderCanvas();
    await flush();
    expect(createdEditors.length).toBe(2);
    expect(surfaceForPane("primary").monacoEditor).toBe(createdEditors[1] as never);
  });

  test("clearing to the no-tab state disposes this module's observers, editors, scopes, and cleanups", () => {
    openSyncedTab();
    const stop = mock(() => {});
    const disconnect = mock(() => {});
    const fnDispose = mock(() => {});
    surfaceForPane("primary").centerObserver = { disconnect } as never;
    view.functionEditor = { dispose: fnDispose } as never;
    surface.prevCanvasMode = "design";
    canvasPanels.push({ renderScope: { stop } } as never);

    closeAllTabs();
    renderCanvas();

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
    expect(surfaceForPane("primary").centerObserver).toBeNull();
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
    expect(stageEl().querySelector(".source-wrap")).not.toBeNull();
    expect(stageEl().querySelector(".source-editor")).not.toBeNull();
    await flush();
    expect(surfaceForPane("primary").monacoEditor).toBe(createdEditors[0] as never);
    expect(createdModels[0]!._value).toBe(JSON.stringify(tab.doc.document, null, 2));
    expect(createdModels[0]!.lang).toBe("json");
    // The load set `_ignoreNextChange` and its own `setValue` CONSUMED it — that is the whole
    // Mechanism, and the flag being false afterwards is the proof it worked. The document's own
    // Text arriving in the buffer is not a keystroke: nothing armed, and the two agree.
    expect(createdEditors[0]!._ignoreNextChange).toBe(false);
    expect(surfaceForPane("primary").monacoEditor!._writes!.ahead()).toBe(false);
    expect(tabBufferUnsaved(tab)).toBe(false);
    // And the buffer names the tab it was mounted for, in the spelling the dock's editor uses.
    // Compared through `toRaw`: the pane hands the mount its own reactive wrapper of this tab, and
    // Identity across two proxies of one object is exactly what `buffersForTab` normalizes.
    expect(toRaw(surfaceForPane("primary").monacoEditor!._editingTab as object)).toBe(
      toRaw(tab as object),
    );
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

  /* There is no `.js` case any more, and there never was a reachable one. A document tab is a
     format tab or it is JSON — `files.ts`, `file-ops.ts` and the project-URL open all end at
     `noFormatError` for an extension no format class claims. The branch this test covered marked
     such a tab DIRTY for text the document cannot represent (`sourceContent` answered
     `doc.document?.toString?.()`, i.e. `"[object Object]"`, and ⌘S would have written that), so it
     was deleted rather than left with a flush running down it. */
  test("a path no format claims is still opened as JSON, not as a language of its own", async () => {
    closeAllTabs();
    const tab = openSyncedTab(undefined, { documentPath: "/project/handlers.js" });
    setMode("source");
    renderCanvas();
    await flush();
    expect(createdModels[0]!.lang).toBe("json");
    expect(createdModels[0]!._value).toBe(JSON.stringify(tab.doc.document, null, 2));
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
    expect(surfaceForPane("primary").monacoEditor).toBe(createdEditors[1] as never);
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

  /**
   * S3 — ⌘W one keystroke after the last one, on the source surface.
   *
   * The 600ms commit is the only thing that carries the buffer into the document, and until it
   * fires nothing is dirty. `closeTab` deletes the tab before any teardown reaches this editor, so
   * the flush had to move to the gate — and the gate can only find this buffer because the mount
   * now says whose it is.
   */
  test("typing is visible to the close path, and the close path can land it", async () => {
    setFormats([MARKDOWN_FORMAT]);
    closeAllTabs();
    const tab = openSyncedTab(undefined, { documentPath: "/project/post.md" });
    tab.doc.sourceFormat = "Markdown";
    setMode("source");
    await withFastTimers(async () => {
      renderCanvas();
      await flush();
      const [editor] = createdEditors;
      editor!._model!._value = "# Never saved";
      fireModelChange(editor!);

      // Nothing has fired. The document knows nothing, and `dirty` — all either gate used to read
      // — says there is nothing to lose.
      expect(tab.doc.dirty).toBe(false);
      expect(tabBufferUnsaved(tab)).toBe(true);

      await commitTabBuffers(tab);
      expect(parseSourceForPathMock).toHaveBeenCalledWith("/project/post.md", "# Never saved");
      expect(tab.doc.document.tagName).toBe("article");
      expect(tab.doc.dirty).toBe(true);
      expect(tabBufferUnsaved(tab)).toBe(false);
    });
  });

  /**
   * S3b — the parse is an await, and `tabIsLive` was asked only on the near side of it.
   *
   * S3 is what made this reachable: the commit now runs from `commitTabBuffers`, whose two callers
   * are both DESTROYERS — `requestClose`, and the preview slot's replacement in `openTab`, which is
   * synchronous and cannot wait for a format round trip. So the ordinary case is that the tab is
   * gone by the time the parse resolves. The guard's own comment says why the write must not happen
   * ("a parse written into it is a parse nothing will ever read"), and the guard was one `await`
   * short of meaning it.
   */
  test("a tab closed inside the parse is not written into", async () => {
    setFormats([MARKDOWN_FORMAT]);
    closeAllTabs();
    const tab = openSyncedTab(undefined, { documentPath: "/project/post.md" });
    tab.doc.sourceFormat = "Markdown";
    setMode("source");
    await withFastTimers(async () => {
      renderCanvas();
      await flush();
      const [editor] = createdEditors;
      editor!._model!._value = "# Never saved";
      fireModelChange(editor!);

      // The project switch lands mid-parse: `closeAllTabs` takes every tab, unprompted.
      parseSourceForPathMock.mockImplementationOnce(async () => {
        closeAllTabs();
        await Promise.resolve();
        return {
          document: { children: [], tagName: "article" },
          format: MARKDOWN_FORMAT,
          frontmatter: { title: "Parsed" },
        };
      });
      await commitTabBuffers(tab);

      expect(parseSourceForPathMock).toHaveBeenCalledWith("/project/post.md", "# Never saved");
      expect(tab.doc.document.tagName).toBe("div");
      expect(tab.doc.dirty).toBe(false);
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

    tab.doc.document.tagName = "section";
    renderCanvas();
    await flush();
    expect(createdEditors.length).toBe(1);
    expect(editor!.getValue()).toBe(JSON.stringify(tab.doc.document, null, 2));
    // The repaint's own `setValue` fired the change listener and the flag it set absorbed it, so
    // The repaint did not read as a keystroke: nothing armed, and the buffer is not ahead.
    expect(editor!._ignoreNextChange).toBe(false);
    expect(surfaceForPane("primary").monacoEditor!._writes!.ahead()).toBe(false);
    expect(tabBufferUnsaved(tab)).toBe(false);
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
    surfaceForPane("primary").monacoEditor = null; // …but the editor goes away before it lands
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
      surfaceForPane("primary").monacoEditor = null;
      fireModelChange(editor!);
      await runPending();
      expect(tab.doc.document.tagName).toBe("div");
    });
  });

  /**
   * The source view's teardown rate is three sites, and neither of the two things they tried was
   * the contract.
   *
   * `surfaceForPane("primary").monacoEditor` is declared eight lines above `view.functionEditor`
   * and has the same shape, but P8's teardown fix only reached the dock. Its 600ms timer closes
   * over the editor, a disposed Monaco answers `getValue()` with `""`, and for a FORMAT-backed
   * document the callback then ran `parseSourceForPath(path, "")` and assigned the result: the
   * page's body replaced with an empty parse, 600ms after the user left Code view, the tab left
   * dirty so the next ⌘S puts it on disk. (A `.json` tab threw inside `JSON.parse("")` and the
   * catch swallowed it — which is luck, and is why only one of the two shapes was ever going to be
   * noticed.)
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
      expect(surfaceForPane("primary").monacoEditor).toBeNull();
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
   * …AND THE FLUSH IS ALLOWED TO FAIL, at which point the teardown is a deletion.
   *
   * Unparseable source deliberately keeps the buffer rather than resyncing over a half-typed
   * heading. That is the right call while the surface is standing and the wrong one the instant it
   * is not: the two lines after the flush detach the model, and with them goes `buffersForTab`'s
   * knowledge that the buffer ever existed — so `tabBufferUnsaved` answers TRUE before the mode
   * transition and FALSE after it, about text that no longer exists anywhere at all.
   *
   * A disposer cannot keep the surface (its callers have already taken the container, the mode or
   * the model URI), so its only other answer is to say the text went. It cannot say it
   * synchronously either: the parse is a round trip through the format host, so the sentence
   * arrives with the promise.
   */
  test("leaving code view over source that will not parse says the text is gone", async () => {
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
      editor!._model!._value = "# Half a headi";
      fireModelChange(editor!);
      // The gates can still see the work while the buffer is standing.
      expect(tabBufferUnsaved(tab)).toBe(true);

      parseSourceForPathMock.mockImplementationOnce(() =>
        Promise.reject(new Error("unterminated heading")),
      );
      notified.mockClear();

      setMode("edit");
      renderCanvas();
      await flush();

      expect(surfaceForPane("primary").monacoEditor).toBeNull();
      expect(tab.doc.dirty).toBe(false);
      // The evidence went with the text: no gate can report this any more.
      expect(tabBufferUnsaved(tab)).toBe(false);
      expect(notified).toHaveBeenCalledWith(
        'The source you were typing was discarded — it was never parsed into "/project/post.md".',
      );
      expect(await runPending()).toBe(0);
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
   * === false` and a still-null `surfaceForPane("primary").monacoEditor`: it skips the source fast
   * path and falls through to mount again. `store.ts`'s `render()`/`renderOnly()` coalesce nothing,
   * so two renders in a turn is an ordinary thing to ask for. The duplicate is not merely a wasted
   * editor — the second `createModel` claims a URI the first already registered, which real Monaco
   * throws on, and the loser's editor stays attached to the stage with nobody holding it.
   */
  test("two renders inside the monaco load mount one editor, not two", async () => {
    openSyncedTab(undefined, { documentPath: "pages/index.json" });
    setMode("source");

    renderCanvas();
    renderCanvas(); // Same turn, still inside the awaited load
    await flush();

    expect(createdEditors).toHaveLength(1);
    expect(createdModels).toHaveLength(1);
    expect(surfaceForPane("primary").monacoEditor).toBe(createdEditors[0] as never);
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
    expect(surfaceForPane("primary").monacoEditor).toBeNull();
  });
});

// ─── Git diff mode ────────────────────────────────────────────────────────────

describe("git-diff mode", () => {
  test("falls back to design mode when no diff state is set", () => {
    const tab = openSyncedTab();
    setMode("git-diff");
    renderCanvas();
    /* Positionally, not `toHaveBeenCalledWith`: the first argument is a reactive Tab proxy and
       bun's matcher serializes its arguments, which on a document graph is a cyclic structure. The
       identity check is the stronger assertion anyway — it names WHICH tab. */
    const [target, mode] = ctx.setCanvasMode.mock.calls.at(-1) as [unknown, string];
    expect(mode).toBe("design");
    expect(toRaw(target as object)).toBe(toRaw(tab as unknown as object));
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

    const headers = [...stageEl().querySelectorAll(".canvas-panel-header")].map((h) =>
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

    const column = stageEl().querySelector(".content-edit-column") as HTMLElement;
    expect(column).not.toBeNull();
    expect(column.getAttribute("style")).toContain("max-width:320px");
    expect(stageEl().querySelector(".content-edit-canvas")).not.toBeNull();
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
    const column = stageEl().querySelector(".content-edit-column") as HTMLElement;
    expect(column.getAttribute("style")).toContain("max-width:600px");
  });

  test("re-applies the persisted edit zoom after a render", async () => {
    const tab = openSyncedTab();
    setMode("edit");
    renderCanvas();
    await flush();
    // The column now exists — give it a measurable width (happy-dom performs no layout), set the
    // Persisted zoom, and re-render: the edit branch must re-fit from the LIVE column width.
    const column = stageEl().querySelector(".content-edit-column") as HTMLElement;
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
    const gen = surfaceForPane("primary").renderGeneration;
    const mountSpy = mock(async () => {});
    iframeImpl = mountSpy as never;

    setEditZoom(1.5);
    await flush();

    // The zoom landed as bare style writes — no render generation bump, no iframe re-mount (which
    // Would rebuild the iframe DOM and destroy a live inline-edit session).
    expect(tab.session.ui.editZoom).toBe(1.5);
    expect(surfaceForPane("primary").renderGeneration).toBe(gen);
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
    surfaceForPane("primary").renderGeneration += 1; // A newer render started
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
    expect(surfaceForPane("primary").panzoomWrap).not.toBeNull();
    expect(canvasPanels.length).toBe(1);
    const panel = canvasPanels[0] as unknown as CanvasPanel;
    expect(panel.element?.classList.contains("full-width")).toBe(true);
    expect(stageEl().querySelector(".canvas-panel-header")).toBeNull();
    expect(surfaceForPane("primary").panzoomWrap?.style.transform).toContain("scale(1)");
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
    const headers = [...stageEl().querySelectorAll(".canvas-panel-header")].map((h) =>
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
    expect(gens[0]).toBe(surfaceForPane("primary").renderGeneration);
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
    // The second pass starts. Reading `surfaceForPane("primary").renderGeneration` inside that timer would stamp the
    // First pass's artboard with the SECOND pass's number — a duplicate render the iframe cannot
    // Recognise as superseded, because its stale-gen guard only drops a number it has already seen
    // Passed. Carrying the pass's own generation is what lets the frame drop it.
    renderCanvas();
    const firstGen = surfaceForPane("primary").renderGeneration;
    renderCanvas();
    const secondGen = surfaceForPane("primary").renderGeneration;
    await flush();

    expect(secondGen).toBeGreaterThan(firstGen);
    expect(gens.filter((g) => g === firstGen)).toHaveLength(2);
    expect(gens.filter((g) => g === secondGen)).toHaveLength(2);
  });

  test("mode transitions stop the outgoing panel scopes and the centering observer", () => {
    /* No `canvasDndCleanups` / `canvasEventCleanups` here, and this is the assertion that used to
       be their only producer. Nothing in `src/` ever pushed to either array — the DnD and panel
       handlers they were built for live inside the canvas iframe, whose overlay owns their
       lifetime — so both loops ran over an empty array on every render. `view.test.ts` asserts the
       two keys are gone from the record rather than merely unread. */
    openSyncedTab();
    const stop = mock(() => {});
    const disconnect = mock(() => {});
    const observer = { disconnect } as never;
    surfaceForPane("primary").centerObserver = observer;
    canvasPanels.push({ renderScope: { stop } } as never);

    renderCanvas();
    expect(stop).toHaveBeenCalled();
    // The OUTGOING observer is disconnected. The pass then installs this mode's own, so the field
    // Is repopulated rather than null — `resetCanvasView` is the path that leaves it empty.
    expect(disconnect).toHaveBeenCalled();
    expect(surfaceForPane("primary").centerObserver).not.toBe(observer);
  });
});

// ─── Fit on entering a panzoom mode ───────────────────────────────────────────
// Design used to open at 100%, so a 1280px artboard landed clipped mid-word in a ~700px pane.

describe("fit on entering Design", () => {
  /** Give the (layout-less) canvas wrap a measurable viewport. */
  function sizeViewport(width: number, height = 600) {
    Object.defineProperty(stageEl(), "clientWidth", { configurable: true, value: width });
    Object.defineProperty(stageEl(), "clientHeight", { configurable: true, value: height });
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
    expect(paneZoom()).toBeCloseTo(700 / 1312);
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
    setPaneZoom(1);
    renderCanvas();
    await flush();
    expect(paneZoom()).toBe(1);
  });

  test("stylebook entry fits too — its specimen sheet is the same artboard", async () => {
    sizeViewport(700);
    // The real renderStylebookMode builds the panzoom surface; the mock stands in for it.
    renderStylebookMode.mockImplementation(() => {
      const wrap = document.createElement("div");
      stageEl().append(wrap);
      surfaceForPane("primary").panzoomWrap = wrap as HTMLDivElement;
      canvasPanels.push({ _width: 800 } as never);
    });
    try {
      openSyncedTab();
      setMode("stylebook");
      renderCanvas();
      await flush();
      // The specimen sheet (800) + 32 padding of artboard in 700px of pane.
      expect(paneZoom()).toBeCloseTo(700 / 832);
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

    expect(stageEl().querySelector(".preview-stage")).not.toBeNull();
    expect(stageEl().querySelector(".panzoom-wrap")).toBeNull();
    expect(surfaceForPane("primary").panzoomWrap).toBeNull();
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
    expect(stageEl().querySelector(".panzoom-wrap")).not.toBeNull();

    // The effective mode flips while the BASE mode stays "design" — the preview toggle.
    tab.session.ui.preview = true;
    renderCanvas();
    await flush();
    expect(stageEl().querySelector(".preview-stage")).not.toBeNull();
    expect(stageEl().querySelector(".panzoom-wrap")).toBeNull();

    tab.session.ui.preview = false;
    renderCanvas();
    await flush();
    expect(stageEl().querySelector(".preview-stage")).toBeNull();
    expect(stageEl().querySelector(".panzoom-wrap")).not.toBeNull();
  });

  test("preview over a base of edit still gets the stage, not the edit column", async () => {
    const tab = openSyncedTab();
    setMode("edit");
    tab.session.ui.preview = true;
    renderCanvas();
    await flush();
    expect(stageEl().querySelector(".preview-stage")).not.toBeNull();
    expect(stageEl().querySelector(".content-edit-canvas")).toBeNull();
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
    // The SURFACE is the first argument now — a stylebook draws into one pane's stage — so the
    // Helper bag is the second.
    expect((renderStylebookMode.mock.calls[0]![0] as { paneId: string }).paneId).toBe("primary");
    const helpers = renderStylebookMode.mock.calls[0]![1] as Record<string, unknown>;
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

  test("two Stylebook panes BOTH rebuild on a filter change — neither evicts the other", () => {
    /* `shell.stylebook.filter` is an application-level render input, so a change to it renders
       every pane in one frame. The "have the filters changed" memory was ONE module slot: the
       first pane to render stored the new filter and rebuilt, and the second compared against a
       slot the first had already advanced, concluded nothing had changed, and returned through the
       cheap `postStyleUpdateToStylebookHosts` path — with a catalogue still listing the PREVIOUS
       filter's specimens. Which pane lost was decided by render order, and it stayed wrong until a
       mode change. The memory is a field of each pane's `CanvasSurface` now. */
    const left = openSyncedTab({ children: [], tagName: "div" });
    const right = openTab({
      document: { children: [], tagName: "div" },
      documentPath: "/project/sb-right.json",
      id: "stylebook-right",
    });
    left.session.ui.canvasMode = "stylebook";
    right.session.ui.canvasMode = "stylebook";
    workspace.panes[0]!.tabOrder = [left.id];
    workspace.panes[0]!.activeTabId = left.id;
    workspace.panes.push({
      activeTabId: right.id,
      derived: null,
      id: SECONDARY_PANE,
      tabOrder: [right.id],
    });
    const secondWrap = document.createElement("div");
    document.body.append(secondWrap);
    registerCanvasSurface(SECONDARY_PANE, secondWrap);
    // A live stylebook host in each pane, so the cheap path is available to both.
    styleUpdateImpl = () => 1;

    const rebuilt = () =>
      renderStylebookMode.mock.calls.map((call) => (call[0] as { paneId: string }).paneId);

    // Pass one: both panes build their catalogue for the empty filter.
    shell.stylebook.filter = "button";
    renderCanvas(PRIMARY_PANE);
    renderCanvas(SECONDARY_PANE);
    expect(rebuilt()).toEqual([PRIMARY_PANE, SECONDARY_PANE]);
    renderStylebookMode.mockClear();

    // Pass two: ONE filter change, both stages in the same frame.
    shell.stylebook.filter = "card";
    renderCanvas(PRIMARY_PANE);
    renderCanvas(SECONDARY_PANE);
    console.log(
      `[canvas-render] filter "button" → "card" with two Stylebook panes: rebuilt ` +
        `${JSON.stringify(rebuilt())}`,
    );
    expect(rebuilt()).toEqual([PRIMARY_PANE, SECONDARY_PANE]);

    // And with the SECOND pane rendering first, which is the ordering that used to lose.
    renderStylebookMode.mockClear();
    shell.stylebook.filter = "list";
    renderCanvas(SECONDARY_PANE);
    renderCanvas(PRIMARY_PANE);
    expect(rebuilt()).toEqual([SECONDARY_PANE, PRIMARY_PANE]);

    // Nothing changed: BOTH panes take the cheap path, which is the behaviour being protected.
    renderStylebookMode.mockClear();
    renderCanvas(PRIMARY_PANE);
    renderCanvas(SECONDARY_PANE);
    expect(rebuilt()).toEqual([]);

    surfaceForPane(SECONDARY_PANE).panels.length = 0;
    unregisterCanvasSurface(SECONDARY_PANE);
    secondWrap.remove();
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

  const slot = () => stageEl().querySelector(".doc-header-host");

  test("Edit puts it INSIDE the document column, above the artefact", async () => {
    openHeaderedTab();
    setMode("edit");
    renderCanvas();
    await flush();

    const column = stageEl().querySelector(".content-edit-column")!;
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
    expect(stageEl().style.flexDirection).toBe("column");
    expect(stageEl().style.alignItems).toBe("stretch");
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

    expect(stageEl().querySelectorAll(".doc-header-host").length).toBe(1);
    expect(stageEl().querySelectorAll(".canvas-panel").length).toBeGreaterThan(1);
  });

  test("a document with no header gets no slot, and the stage stays a row", async () => {
    openSyncedTab();
    setMode("design");
    renderCanvas();
    await flush();

    expect(slot()).toBeNull();
    expect(stageEl().style.flexDirection).toBe("");
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
    // `attachDocumentHeaderHost("primary", null)` on a card that was still visible: it was detached, not
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
      derived: null,
      id: SECONDARY_PANE,
      tabOrder: [right.id],
    });

    const secondWrap = document.createElement("div");
    document.body.append(secondWrap);
    registerCanvasSurface(SECONDARY_PANE, secondWrap);

    renderCanvas(PRIMARY_PANE);
    renderCanvas(SECONDARY_PANE);
    await flush();

    expect(stageEl().textContent).toContain("left");
    expect(stageEl().textContent).not.toContain("right");
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

    expect(stageEl().querySelector(".panzoom-wrap")).not.toBeNull();
    // The second pane shows nothing, so its pass reset its stage rather than borrowing pane one's.
    expect(secondWrap.textContent).toBe("");
    expect(surfaceForPane(SECONDARY_PANE).panels).toHaveLength(0);
  });

  /* The two handover tests that stood here are deleted with the handover.
     They proved that TAKING the shell's single stage repainted it, because both canvas effects key
     on `activeTab` and `⌘\` / `View: Unsplit` move a pane without changing the active tab. A cell
     per pane means nothing is taken; `panels/pane-grid.ts` schedules the new cell's first render as
     part of building it, which `tests/pane-grid.test.ts` proves. */

  test("a pane with no stage paints nothing instead of throwing", async () => {
    // The shell has ONE `#canvas-wrap` and it belongs to whichever pane is focused, so the other
    // Pane has no stage at all. Two schedulers reach that state: a frame queued for the pane that
    // Just lost the stage, and `escalateToFullRender` on a tab in the pane that is not on screen.
    // Both must be nothing-to-paint. Unguarded, this threw on Lit's private render part — which is
    // What `⌘\` did, because `splitRight` focuses the pane it creates.
    const tab = openSyncedTab();
    workspace.panes.push({
      activeTabId: tab.id,
      derived: null,
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

// ─── A DERIVED pane's stage (§18.4) ───────────────────────────────────────────

/**
 * The three render behaviours a lens has that no other pane does, each asserted at the DOM it
 * produces rather than at the state that produces it.
 *
 * The previous round shipped all three green and none of them testable: replacing the string
 * `"lens"` with `"MUTANT"` at `canvas-render.ts:677`, `:997` and `:1219` — which deletes every
 * lens-specific render behaviour in the package — left 275, 102 and 117 tests passing across
 * fourteen files. The one test that named the Document Header gate asserted
 * `hasDocumentHeader(page) === true` and `derivationOfPane(SECONDARY) === "lens"`, neither of which
 * touches the gate, and its own comment said so.
 *
 * Every test below fails under that mutation, which is how they were written: the mutation was
 * applied first and each assertion was checked red before it was checked green.
 */
describe("a derived pane's stage", () => {
  /** A second pane drawing `derivation`, with a stage of its own. */
  function standUpLens(derivation: PaneDerivation): HTMLElement {
    workspace.panes.push({
      activeTabId: null,
      derived: derivation,
      id: SECONDARY_PANE,
      tabOrder: [],
    });
    const wrap = document.createElement("div");
    document.body.append(wrap);
    registerCanvasSurface(SECONDARY_PANE, wrap);
    return wrap;
  }

  function lensRecord(over: Partial<Extract<PaneDerivation, { kind: "lens" }>> = {}) {
    return {
      diff: null,
      kind: "lens",
      media: null,
      mode: "design",
      preset: "breakpoint",
      reason: "",
      sourcePaneId: PRIMARY_PANE,
      status: "ready",
      zoom: 1,
      ...over,
    } as PaneDerivation;
  }

  afterEach(() => {
    surfaceForPane(SECONDARY_PANE).panels.length = 0;
    unregisterCanvasSurface(SECONDARY_PANE);
  });

  test("draws no Document Header card, while the pane that OWNS the tab draws one", async () => {
    /* `canvas-render.ts:677`. The card is an editing surface over the SAME frontmatter — Title,
       Route, SEO — and two of them side by side is two writers for one field. Under the mutation
       the lens grows a second card. */
    installMockPlatform();
    mountDocHeader();
    try {
      const tab = openSyncedTab();
      tab.doc.document.title = "Designing for slowness";
      setMode("design");
      const lensWrap = standUpLens(lensRecord());

      renderCanvas(PRIMARY_PANE);
      renderCanvas(SECONDARY_PANE);
      await flush();

      expect(stageEl().querySelector(".doc-header-host")).not.toBeNull();
      expect(lensWrap.querySelector(".doc-header-host")).toBeNull();
      lensWrap.remove();
    } finally {
      unmountDocHeader();
    }
  });

  test("a diff lens renders ITS OWN comparison, never the app-level slot", async () => {
    /* `canvas-render.ts:997`. `shell.git.diffState` is one slot for the whole app, so without the
       per-pane read both stages draw whatever the Git panel last opened — and under the mutation
       that is exactly what the lens does, because `paneDiff.kind === "MUTANT"` is never true. */
    openSyncedTab();
    setMode("git-diff");
    ctx.gitDiffState = {
      currentContent: JSON.stringify({ children: [{ tagName: "p", textContent: "SLOT" }] }),
      filePath: "/project/somebody-elses.json",
      originalContent: JSON.stringify({ children: [{ tagName: "p", textContent: "SLOT" }] }),
    };
    const lensWrap = standUpLens(
      lensRecord({
        diff: {
          currentContent: JSON.stringify({ children: [{ tagName: "p", textContent: "MINE-NEW" }] }),
          currentDoc: undefined,
          filePath: "/project/index.json",
          fileStatus: "M",
          originalContent: JSON.stringify({
            children: [{ tagName: "p", textContent: "MINE-OLD" }],
          }),
        } as never,
        mode: "git-diff",
        preset: "diff",
      }),
    );

    renderCanvas(SECONDARY_PANE);
    await flush();

    const panels = surfaceForPane(SECONDARY_PANE).panels as unknown as CanvasPanel[];
    expect(panels).toHaveLength(2);
    expect(panels[0]!.canvas?.textContent).toContain("MINE-OLD");
    expect(panels[1]!.canvas?.textContent).toContain("MINE-NEW");
    expect(lensWrap.textContent).not.toContain("SLOT");
    lensWrap.remove();
  });

  test("a diff lens with no comparison yet SAYS SO, and never writes the source tab's mode", async () => {
    /* The other half of the same branch. `setCanvasMode(tab, "design")` writes the tab the pane
       BESIDE this one owns, so a lens taking the fallback flipped the document the author was
       editing out of whatever mode they had it in.
       `loading`, not `unavailable`: an unavailable derivation is drawn by the stale-derivation
       branch above the mode dispatch (below), so the only state that reaches HERE is a comparison
       still in flight — which is the state the fallback would have fired in. */
    const tab = openSyncedTab();
    setMode("git-diff");
    ctx.gitDiffState = null;
    ctx.setCanvasMode.mockClear();
    const lensWrap = standUpLens(
      lensRecord({ mode: "git-diff", preset: "diff", reason: "", status: "loading" }),
    );

    renderCanvas(SECONDARY_PANE);
    await flush();

    expect(lensWrap.textContent).toContain("Loading this file's changes…");
    expect(ctx.setCanvasMode).not.toHaveBeenCalled();
    expect(tab.session.ui.canvasMode).toBe("git-diff");
    lensWrap.remove();
  });

  /* FINDING 5. `renderDerivationNotice` was reachable only from inside `if (!tab)`, and a pane that
     has already resolved a document HAS a tab — so `status: "unavailable"` and the sentence
     explaining it were written by `applyDerivation`, tracked as a render input by
     `panels/pane-context.ts`, and drawn nowhere. A layout companion whose page dropped its
     `$layout` went on showing the layout; a Code lens whose source pane switched to Code beside it
     went on mounting a second Monaco model on one URI. The previous round fixed the UNRESOLVED
     case, which is the one that has no tab. */
  test("a derivation that has a document and has gone stale draws the notice OVER it", async () => {
    openSyncedTab();
    setMode("design");
    const lensWrap = standUpLens(
      lensRecord({
        mode: "source",
        preset: "code",
        reason: "The pane this one follows is showing Code — one document has one editor.",
        status: "unavailable",
      }),
    );

    renderCanvas(SECONDARY_PANE);
    await flush();

    // The pane HAS a document — `tabOfPane` hops to the source pane and finds one — and the notice
    // Is drawn anyway, which is the whole of the finding.
    expect(tabOfPane(SECONDARY_PANE)).not.toBeNull();
    expect(lensWrap.textContent).toContain("one document has one editor");
    // …and no editor was mounted over it.
    expect(lensWrap.querySelector(".source-editor")).toBeNull();
    lensWrap.remove();
  });

  /* …AND SAYS WHAT THE AUTHOR NEEDS, which the sentence alone does not. A COMPANION that resolved
     once owns a real tab, so `panels/tab-strip.ts` draws a real chip with a real ✕ — and when the
     rule then dies the strip says `base.json` while the stage says "This page has no layout.":

       strip: tabs[base.json ◎ ×]   stage: NOTICE("This page has no layout.")

     Both true, about different things, and nothing on screen explains why the file named in the
     strip is not drawn or how to get it back. The previous round traded "shows a file it is no
     longer about" for "shows nothing while the strip says it does"; naming the held document and
     putting `pane.pin` beside it is what makes the two halves agree. A LENS passes no document —
     it owns none, `tabOfPane` hands back the SOURCE pane's, and Pin is refused for a projection —
     which is the discriminator this pair of tests is about. */
  test("a stale COMPANION names the document it is still holding, and offers the way back", async () => {
    const page = openSyncedTab();
    setMode("design");
    const registry = createCommandRegistry({ getContext: () => makeContext({}) });
    registry.registerAll(derivationCommands(noopDerivationDeps()));
    setActiveRegistry(registry);
    const wrap = document.createElement("div");
    document.body.append(wrap);
    workspace.panes.push({
      activeTabId: page.id,
      derived: {
        kind: "companion",
        preset: "layout",
        reason: "This page has no layout.",
        resolved: page.documentPath,
        sourcePaneId: PRIMARY_PANE,
        status: "unavailable",
      },
      id: SECONDARY_PANE,
      tabOrder: [page.id],
    });
    registerCanvasSurface(SECONDARY_PANE, wrap);
    try {
      renderCanvas(SECONDARY_PANE);
      await flush();

      expect(wrap.textContent).toContain("This page has no layout.");
      // The document the strip is drawing a chip for, named on the stage that will not draw it.
      expect(wrap.querySelector(".empty-state-detail")?.textContent).toContain(
        "is still open here",
      );
      // …and the one verb that ends the follow and leaves the tab standing (§18.4).
      expect(wrap.querySelector(".empty-state-action")?.textContent?.trim()).toBe(
        "Keep This Document",
      );
    } finally {
      setActiveRegistry(null);
      wrap.remove();
    }
  });

  test("a stale LENS names nothing — it owns no document, and Pin is refused for a projection", async () => {
    openSyncedTab();
    setMode("design");
    const lensWrap = standUpLens(
      lensRecord({
        mode: "source",
        preset: "code",
        reason: "The pane this one follows is showing Code — one document has one editor.",
        status: "unavailable",
      }),
    );

    renderCanvas(SECONDARY_PANE);
    await flush();

    expect(lensWrap.textContent).toContain("one document has one editor");
    expect(lensWrap.querySelector(".empty-state-detail")).toBeNull();
    expect(lensWrap.querySelector(".empty-state-action")).toBeNull();
    lensWrap.remove();
  });

  test("a derivation that is merely mid-resolve does NOT blank its stage", async () => {
    /* `reason` and not just `status`: a derivation is `unavailable` for one frame before the
       follow's rAF has run, and a stage that blanked on the status alone would flicker on every
       retarget. */
    openSyncedTab();
    setMode("design");
    const lensWrap = standUpLens(lensRecord({ media: null, reason: "", status: "unavailable" }));

    renderCanvas(SECONDARY_PANE);
    await flush();

    expect(lensWrap.querySelectorAll(".canvas-panel").length).toBeGreaterThan(0);
    lensWrap.remove();
  });

  test("a breakpoint lens draws ONE artboard — the one it names", async () => {
    /* `canvas-render.ts:1219`. Design mode draws every declared breakpoint side by side, so a lens
       that did not filter would be a second copy of the board it sits beside — which is precisely
       what the mutation makes it. */
    openSyncedTab({
      $media: { "--": "400px", tablet: "(min-width: 768px)", wide: "(min-width: 1200px)" },
      children: [{ tagName: "p", textContent: "Hi" }],
      tagName: "div",
    } as never);
    setMode("design");
    const lensWrap = standUpLens(lensRecord({ media: "tablet" }));

    renderCanvas(PRIMARY_PANE);
    renderCanvas(SECONDARY_PANE);
    await flush();

    // The pane that owns the tab draws the whole board: base + two breakpoints.
    expect(stageEl().querySelectorAll(".canvas-panel")).toHaveLength(3);
    // The lens draws exactly the artboard it names.
    const lensHeaders = [...lensWrap.querySelectorAll(".canvas-panel-header")].map((h) =>
      h.textContent?.trim(),
    );
    expect(lensHeaders).toHaveLength(1);
    expect(lensHeaders[0]).toContain("Tablet");
    lensWrap.remove();
  });

  /* …AND "BASE" IS AN ARTBOARD LIKE ANY OTHER. `media` is `null` for the base row, and the filter
     is keyed on the panel's NAME — which for base is the string `"base"`, not the absence of one.
     Read `lens.media ?? ""` instead of `lens.media ?? "base"` and the filter matches nothing, the
     `chosen.length > 0` fallback below it fires, and a Base lens quietly draws the WHOLE design
     board: three artboards in a pane the author asked for one. The fallback is right for a media
     the document has stopped declaring (the test below) and wrong here, and only the base row can
     tell the two apart. */
  test("a BASE breakpoint lens draws one artboard too — the fallback is not its answer", async () => {
    openSyncedTab({
      $media: { "--": "400px", tablet: "(min-width: 768px)", wide: "(min-width: 1200px)" },
      children: [{ tagName: "p", textContent: "Hi" }],
      tagName: "div",
    } as never);
    setMode("design");
    const lensWrap = standUpLens(lensRecord({ media: null }));

    renderCanvas(PRIMARY_PANE);
    renderCanvas(SECONDARY_PANE);
    await flush();

    expect(stageEl().querySelectorAll(".canvas-panel")).toHaveLength(3);
    const lensHeaders = [...lensWrap.querySelectorAll(".canvas-panel-header")].map((h) =>
      h.textContent?.trim(),
    );
    expect(lensHeaders).toHaveLength(1);
    expect(lensHeaders[0]).toContain("Base");
    lensWrap.remove();
  });

  test("a breakpoint the document has stopped declaring falls back to the whole board", async () => {
    openSyncedTab({
      $media: { "--": "400px", tablet: "(min-width: 768px)" },
      children: [{ tagName: "p", textContent: "Hi" }],
      tagName: "div",
    } as never);
    setMode("design");
    const lensWrap = standUpLens(
      lensRecord({ media: "deleted-breakpoint", status: "unavailable" }),
    );

    renderCanvas(SECONDARY_PANE);
    await flush();

    expect(lensWrap.querySelectorAll(".canvas-panel")).toHaveLength(2);
    lensWrap.remove();
  });

  test("an unresolvable COMPANION explains itself instead of drawing a blank stage", async () => {
    /* FINDING 7. `derived.reason` was written by `applyDerivation`, tracked as a render input by
       `pane-context.ts` and read by nothing at all: choosing a preset whose rule does not resolve
       gave a pane with a derivation, no tabs, no strip chip and a blank stage that `paneIsEmpty`
       will not collapse. */
    openSyncedTab();
    const wrap = document.createElement("div");
    document.body.append(wrap);
    workspace.panes.push({
      activeTabId: null,
      derived: {
        kind: "companion",
        preset: "component",
        reason: "Select an element inside a component to see its definition.",
        resolved: null,
        sourcePaneId: PRIMARY_PANE,
        status: "unavailable",
      },
      id: SECONDARY_PANE,
      tabOrder: [],
    });
    registerCanvasSurface(SECONDARY_PANE, wrap);

    renderCanvas(SECONDARY_PANE);
    await flush();

    expect(wrap.textContent).toContain(
      "Select an element inside a component to see its definition.",
    );
    // Not the welcome screen — this pane is not empty, it is waiting.
    expect(renderWelcome).not.toHaveBeenCalledWith(wrap);
    wrap.remove();
  });

  /* …AND WHEN THE DERIVATION HAS NO SENTENCE OF ITS OWN, the notice still has to say something.
     `derived.reason` is `""` for every non-`unavailable` answer, which is the state a fresh
     companion sits in for the frame between being published and its rule resolving: `loading`,
     no tab, no sentence. The `||` fallback is the only thing between that and an empty state with
     an empty message — a blank card in a pane the author just asked for, which reads as a broken
     stage rather than as one that is thinking. Both halves of the expression have a reader, so
     both need a test; the sentence half is the one above. */
  test("a derivation with no sentence yet still says what the pane is for", async () => {
    openSyncedTab();
    const wrap = document.createElement("div");
    document.body.append(wrap);
    workspace.panes.push({
      activeTabId: null,
      derived: {
        kind: "companion",
        preset: "layout",
        reason: "",
        resolved: null,
        sourcePaneId: PRIMARY_PANE,
        status: "loading",
      },
      id: SECONDARY_PANE,
      tabOrder: [],
    });
    registerCanvasSurface(SECONDARY_PANE, wrap);

    renderCanvas(SECONDARY_PANE);
    await flush();

    expect(wrap.textContent).toContain("Looking for something to show here…");
    expect(renderWelcome).not.toHaveBeenCalledWith(wrap);
    wrap.remove();
  });
});
