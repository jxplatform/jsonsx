/**
 * Canvas render orchestrator tests. Heavy collaborators (monaco, the live runtime renderer, DnD,
 * panel events, stylebook, editors, statusbar, overlays) are mocked via mock.module so the tests
 * can drive every renderCanvas dispatch path deterministically and assert the produced DOM.
 */
import { flush, resetStudioState, resetWorkspaceWithTab, stubRect } from "./harness";
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { canvasPanels, canvasWrap, initShellRefs, setProjectState } from "../src/store";
import { activeTab, closeAllTabs } from "../src/workspace/workspace";
import { view } from "../src/view";
import { setFormats } from "../src/format/format-host";
import { initCanvasUtils, setEditZoom } from "../src/canvas/canvas-utils";
import { MARKDOWN_FORMAT } from "./format-fixture";
import type { CanvasPanel } from "../src/types";
import type { JxMutableNode } from "@jxsuite/schema/types";

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
const statusMessage = mock((_msg: string, _duration?: number) => {});
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
        dispose: mock(() => {}),
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
  commitActiveEditSession: () => {},
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
  renderFormulaWorkspace,
}));

void mock.module("../src/panels/statusbar.js", () => ({
  mountStatusbar: () => {},
  renderStatusbar: () => {},
  setStatusbarRenderer: () => {},
  statusMessage,
  unmountStatusbar: () => {},
}));

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
}));

const { initCanvasRender, renderCanvas, renderOverlays, scheduleCanvasRender } =
  await import("../src/canvas/canvas-render");

// ─── Test context ─────────────────────────────────────────────────────────────

let canvasMode = "design";
let canvasModeFn = () => canvasMode;
let zoom = 1;

/**
 * The render dispatch reads the BASE mode from the active tab (tab.session.ui.canvasMode), while
 * ctx.getCanvasMode supplies the effective mode to helpers. Keep both in sync here.
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
  getCanvasMode: () => canvasModeFn(),
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
async function withFastTimers(fn: (runPending: () => Promise<void>) => Promise<void>) {
  const origSetTimeout = globalThis.setTimeout;
  const origClearTimeout = globalThis.clearTimeout;
  const pending: (() => unknown)[] = [];
  globalThis.setTimeout = ((cb: () => unknown, ms?: number, ...args: unknown[]) => {
    if (typeof ms === "number" && ms >= 200) {
      pending.push(cb);
      return { __fake: true } as unknown as ReturnType<typeof setTimeout>;
    }
    return origSetTimeout(cb as () => void, ms, ...(args as []));
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((handle: unknown) => {
    if (handle && typeof handle === "object" && (handle as { __fake?: boolean }).__fake) {
      return;
    }
    origClearTimeout(handle as ReturnType<typeof setTimeout>);
  }) as typeof clearTimeout;
  try {
    await fn(async () => {
      for (const cb of pending.splice(0)) {
        cb();
      }
      await flush();
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
    statusMessage,
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
  view.prevCanvasMode = null;
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
    expect(view.prevCanvasMode).toBeNull();

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

  test("clearing to the no-tab state disposes observers, editors, scopes, and cleanups", () => {
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
    view.prevCanvasMode = "design";
    canvasPanels.push({ renderScope: { stop } } as never);

    closeAllTabs();
    renderCanvas();

    expect(dndCleanup).toHaveBeenCalled();
    expect(eventCleanup).toHaveBeenCalled();
    expect(stop).toHaveBeenCalled();
    expect(disconnect).toHaveBeenCalled();
    expect(fnDispose).toHaveBeenCalled();
    expect(view.functionEditor).toBeNull();
    expect(view.centerObserver).toBeNull();
    expect(view.canvasDndCleanups).toEqual([]);
    expect(view.canvasEventCleanups).toEqual([]);
    expect(canvasPanels.length).toBe(0);
    expect(view.prevCanvasMode).toBeNull();
  });
});

// ─── Function editor ──────────────────────────────────────────────────────────

describe("function editor dispatch", () => {
  test("renders the function editor while editingFunction is set", () => {
    const tab = openSyncedTab();
    tab.session.ui.editingFunction = { path: ["children", 0], prop: "onclick" } as never;
    renderCanvas();
    expect(renderFunctionEditor).toHaveBeenCalled();
    expect(canvasPanels.length).toBe(0);
  });

  test("disposes a leftover function editor when switching away", () => {
    openSyncedTab();
    const dispose = mock(() => {});
    view.functionEditor = { dispose } as never;
    renderCanvas();
    expect(dispose).toHaveBeenCalled();
    expect(view.functionEditor).toBeNull();
  });
});

// ─── Formula workspace ────────────────────────────────────────────────────────

describe("formula workspace dispatch", () => {
  test("renders the formula workspace while editingFormula is set", () => {
    const tab = openSyncedTab();
    tab.session.ui.editingFormula = { defName: "total", type: "def" };
    renderFormulaWorkspace.mockClear();
    renderCanvas();
    expect(renderFormulaWorkspace).toHaveBeenCalled();
  });

  test("the function editor takes precedence when both targets are set", () => {
    const tab = openSyncedTab();
    tab.session.ui.editingFormula = { defName: "total", type: "def" };
    tab.session.ui.editingFunction = { defName: "greet", type: "def" } as never;
    renderFormulaWorkspace.mockClear();
    renderFunctionEditor.mockClear();
    renderCanvas();
    expect(renderFunctionEditor).toHaveBeenCalled();
    expect(renderFormulaWorkspace).not.toHaveBeenCalled();
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
    expect(statusMessage).toHaveBeenCalledWith("Iframe render OK", 1500);
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
    expect(statusMessage).toHaveBeenCalledWith("Iframe render OK", 1500);
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
    expect(statusMessage).not.toHaveBeenCalled();
    expect((canvasPanels[0] as unknown as CanvasPanel).ready).toBe(false);
  });

  test("a rejected iframe mount warns and leaves the panel un-ready", async () => {
    openSyncedTab();
    iframeImpl = async () => {
      throw new Error("iframe exploded");
    };
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      setMode("edit");
      renderCanvas();
      await flush();
      expect(warn.mock.calls.some((c) => String(c[0]).includes("mountIframeCanvas failed"))).toBe(
        true,
      );
      expect((canvasPanels[0] as unknown as CanvasPanel).ready).toBe(false);
    } finally {
      warn.mockRestore();
    }
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
    openSyncedTab();
    renderCanvas();
    await flush();
    expect(canvasWrap.querySelector(".panzoom-wrap")).not.toBeNull();

    // The effective mode flips while the BASE mode stays "design" — the preview toggle.
    canvasModeFn = () => "preview";
    renderCanvas();
    await flush();
    expect(canvasWrap.querySelector(".preview-stage")).not.toBeNull();
    expect(canvasWrap.querySelector(".panzoom-wrap")).toBeNull();

    canvasModeFn = () => canvasMode;
    renderCanvas();
    await flush();
    expect(canvasWrap.querySelector(".preview-stage")).toBeNull();
    expect(canvasWrap.querySelector(".panzoom-wrap")).not.toBeNull();
  });

  test("preview over a base of edit still gets the stage, not the edit column", async () => {
    openSyncedTab();
    setMode("edit");
    canvasModeFn = () => "preview";
    renderCanvas();
    await flush();
    expect(canvasWrap.querySelector(".preview-stage")).not.toBeNull();
    expect(canvasWrap.querySelector(".content-edit-canvas")).toBeNull();
    canvasModeFn = () => canvasMode;
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
    const tab = openSyncedTab();
    setMode("stylebook");
    const updates: Record<string, unknown>[] = [];
    styleUpdateImpl = (style) => {
      updates.push(style);
      return 1;
    };
    renderCanvas();
    tab.session.ui.stylebookFilter = "head";
    renderCanvas();
    expect(renderStylebookMode).toHaveBeenCalledTimes(2);
    expect(updates).toHaveLength(0);
  });

  test("customized-only toggle also forces a full re-render", () => {
    const tab = openSyncedTab();
    setMode("stylebook");
    renderCanvas();
    tab.session.ui.stylebookCustomizedOnly = true;
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
