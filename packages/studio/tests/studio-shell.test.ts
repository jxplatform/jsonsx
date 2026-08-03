/**
 * Studio shell (C7): import-time bootstrap and private callbacks of src/studio.ts.
 *
 * Studio.ts is a side-effect module: it wires panel modules together and never exports anything.
 * Heavy leaf modules (monaco, canvas renderer/patcher, toolbar, shortcuts, welcome screen, block
 * action bar, statusbar) are mocked so their init/mount calls capture the private studio callbacks
 * (navigateToComponent, navigateBack, openRecentProject, closeFunctionEditor, ...), which the tests
 * then drive directly.
 */
import { flush, installMockPlatform, resetStudioState } from "./harness";
import { nothing } from "lit-html";
import { beforeEach, describe, expect, mock, test } from "bun:test";
import {
  activateTab,
  activeTab,
  closeAllTabs,
  openTab,
  workspace,
} from "../src/workspace/workspace";
import { captureTabUi, createTab } from "../src/tabs/tab";
import { view } from "../src/view";
import { shell } from "../src/shell";
import { resetZoom } from "../src/canvas/canvas-utils";
import type { Tab } from "../src/tabs/tab";

// ─── Global stubs (must exist before studio.ts is imported) ──────────────────

(globalThis as any).requestIdleCallback = (cb: (d: unknown) => void) =>
  setTimeout(() => cb({ didTimeout: false, timeRemaining: () => 50 }), 0);
(globalThis as any).cancelIdleCallback = (id: number) => clearTimeout(id);

const noop = () => {
  /* Stub */
};
class StubEventSource {
  url: string;
  onmessage: unknown = null;
  onerror: unknown = null;
  addEventListener = noop;
  removeEventListener = noop;
  close = noop;
  constructor(url: string) {
    this.url = url;
  }
}
(globalThis as any).EventSource = StubEventSource;

const fetchMock = mock(async () => new Response("{}", { status: 404 }));
globalThis.fetch = fetchMock as unknown as typeof fetch;

// ─── Shell DOM scaffold (initShellRefs queries these at import time) ──────────

document.body.innerHTML = `
  <div id="app">
    <div id="toolbar"></div>
    <div id="tab-strip"></div>
    <div id="activity-bar"></div>
    <div id="left-panel"></div>
    <div id="resize-left" class="resize-handle"></div>
    <div id="canvas-wrap"></div>
    <div id="resize-right" class="resize-handle"></div>
    <div id="right-panel"></div>
    <div id="statusbar"></div>
  </div>
  <div id="layer-popover"></div>
  <div id="layer-modal"></div>
  <div id="layer-dialog"></div>
`;

// ─── Captured wiring contexts ─────────────────────────────────────────────────

let toolbarCtx: any = null;
let paneCtx: any = null;
let welcomeCtx: any = null;
let blockBarCtx: any = null;
let canvasRenderCtx: any = null;
let canvasPatcherCtx: any = null;
let shortcutsGet: (() => any) | null = null;
let shortcutHooks: Record<string, unknown> | null = null;

const statusMessages: string[] = [];
const scheduleCanvasRenderMock = mock(() => {});
const renderCanvasMock = mock(() => {});
let consumePatchedReturn = false;
const consumePatchedMock = mock((_doc: object) => consumePatchedReturn);
let newProjectResult: { root: string } | null = null;
let addRepoResult: { root: string } | null = null;
let pickerEnabled = false;
let pickerResult: { root: string } | null = null;

void mock.module("../src/services/monaco-setup.js", () => ({}));

void mock.module("monaco-editor/esm/vs/editor/editor.api.js", () => ({
  KeyCode: {},
  KeyMod: {},
  MarkerSeverity: { Error: 8, Warning: 4 },
  Uri: { parse: (u: string) => ({ toString: () => u }) },
  editor: { setModelMarkers: mock(() => {}) },
  languages: {
    CompletionItemKind: { Function: 1, Property: 9, Variable: 4 },
    registerCompletionItemProvider: mock(() => ({ dispose: noop })),
  },
}));

const renderStatusbarMock = mock(() => {});
let statusbarRenderer: (() => void) | null = null;

void mock.module("../src/panels/statusbar.ts", () => ({
  mountStatusbar: mock(() => {}),
  renderStatusbar: renderStatusbarMock,
  setStatusbarRenderer: (fn: () => void) => {
    statusbarRenderer = fn;
  },
  statusMessage: (msg: string) => {
    statusMessages.push(msg);
  },
  unmountStatusbar: mock(() => {}),
}));

/** What the toolbar's `openInBrowserTarget` resolves to for the `view.openInBrowser` hook. */
let browserTarget: { url: string } | { reason: string } = { url: "https://example.test/page" };

void mock.module("../src/panels/toolbar.ts", () => ({
  mount: (_el: HTMLElement, ctx: unknown) => {
    toolbarCtx = ctx;
  },
  openInBrowserTarget: () => browserTarget,
  render: mock(() => {}),
  unmount: mock(() => {}),
}));

void mock.module("../src/panels/pane-context.ts", () => ({
  mount: (_el: HTMLElement, ctx: unknown) => {
    paneCtx = ctx;
  },
  render: mock(() => {}),
  unmount: mock(() => {}),
}));

void mock.module("../src/panels/welcome-screen.ts", () => ({
  initWelcome: (ctx: unknown) => {
    welcomeCtx = ctx;
  },
  renderWelcome: mock(() => {}),
}));

void mock.module("../src/editor/shortcuts.ts", () => ({
  // The registry is the first argument now; the pointer/pan thunk is the second.
  initShortcuts: (_registry: unknown, get: () => unknown) => {
    shortcutsGet = get as () => any;
  },
  registerStudioCommands: (_registry: unknown, hooks: unknown) => {
    shortcutHooks = hooks as Record<string, unknown>;
  },
}));

void mock.module("../src/panels/block-action-bar.ts", () => ({
  // The Outline's row actions render through `commandIcon`, and the Navigator now reaches
  // Layers through the panel registry, so the mock has to carry it.
  // The Outline's row actions render through these, and the Navigator now reaches Layers
  // Through the panel registry, so the mock has to carry them.
  commandIcon: mock(() => nothing),
  commandTooltip: mock(() => ""),
  runCommand: mock(() => {}),
  selectionCommandRegistry: mock(() => ({ forPlacement: () => [] })),
  showCommandOverflow: mock(() => {}),
  withCommandTarget: mock((_path: unknown, fn: () => void) => fn()),
  dismissBlockActionBar: mock(() => {}),
  dismissLinkPopover: mock(() => {}),
  initBlockActionBar: (ctx: unknown) => {
    blockBarCtx = ctx;
  },
  isEditChromeTarget: mock(() => false),
  registerSelectionCommands: mock(() => {}),
  renderBlockActionBar: mock(() => {}),
}));

void mock.module("../src/canvas/canvas-render.ts", () => ({
  initCanvasRender: (ctx: unknown) => {
    canvasRenderCtx = ctx;
  },
  registerSelectionSetCommand: mock(() => {}),
  renderCanvas: renderCanvasMock,
  renderOverlays: mock(() => {}),
  scheduleCanvasRender: scheduleCanvasRenderMock,
}));

void mock.module("../src/canvas/canvas-patcher.ts", () => ({
  applyPatchBatch: mock(() => {}),
  classifyOps: mock(() => ({ patchable: false, reason: "mock" })),
  consumePatchedDocument: consumePatchedMock,
  escalateToFullRender: mock(() => {}),
  initCanvasPatcher: (ctx: unknown) => {
    canvasPatcherCtx = ctx;
  },
}));

void mock.module("../src/new-project/new-project-modal.ts", () => ({
  closeNewProjectModal: mock(() => {}),
  openNewProjectModal: mock(async () => newProjectResult),
  registerNewProjectCommands: mock(() => {}),
}));

void mock.module("../src/new-project/add-repo-modal.ts", () => ({
  closeAddRepoModal: mock(() => {}),
  openAddRepoModal: mock(async () => addRepoResult),
  openProjectPickerModal: mock(async () => pickerResult),
  platformSupportsAddRepo: mock(() => true),
  platformUsesRepoPicker: mock(() => pickerEnabled),
}));

// Capture the left-panel mount ctx (setGitDiffState / renderCanvas / cloneRepository arrows).
let leftPanelCtx: any = null;
void mock.module("../src/panels/left-panel.ts", () => ({
  mount: (ctx: unknown) => {
    leftPanelCtx = ctx;
  },
  render: mock(() => {}),
  unmount: mock(() => {}),
}));

// Wrap iframe-host: capture the stylebook hit handler and make the edit snapshot controllable
// (the pointerdown commit guard needs an "editing" session without a real iframe host).
// NB: mock.module rebinds the live namespace too, so snapshot the actual exports FIRST.
const iframeHostSnapshot = { ...(await import("../src/canvas/iframe-host")) };
let stylebookHit: ((tag: string | null, media: string | null) => void) | null = null;
let editingOverride = false;
const commitEditMock = mock(() => {});
void mock.module("../src/canvas/iframe-host.ts", () => ({
  ...iframeHostSnapshot,
  commitActiveEditSession: commitEditMock,
  getEditSnapshot: () =>
    editingOverride ? { editing: true, snapshot: null } : iframeHostSnapshot.getEditSnapshot(),
  setStylebookHitHandler: (fn: (tag: string | null, media: string | null) => void) => {
    stylebookHit = fn;
    iframeHostSnapshot.setStylebookHitHandler(fn);
  },
}));

// Wrap collab-session: capture the source parser studio injects at init.
const collabSnapshot = { ...(await import("../src/collab/collab-session")) };
type CollabParserFn = (
  tab: Tab,
  text: string,
) => Promise<{ document: Record<string, unknown>; frontmatter?: Record<string, unknown> }>;
let collabParser: CollabParserFn | null = null;
void mock.module("../src/collab/collab-session.ts", () => ({
  ...collabSnapshot,
  configureCollabParser: (fn: CollabParserFn | null) => {
    collabParser = fn;
    collabSnapshot.configureCollabParser(fn as never);
  },
}));

// ─── Platform (must be registered before import so devserver PAL is skipped) ──

const CARD_DOC = JSON.stringify({ children: [], tagName: "my-card" });
const { platform, state } = installMockPlatform(
  {},
  {
    "components/card.json": CARD_DOC,
    "components/empty.json": "",
    "pages/a.json": JSON.stringify({ children: [], tagName: "main" }),
    "project.json": JSON.stringify({ name: "Recent Project" }),
  },
);

await import("../src/studio");
await flush();

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Poll until cond() is true (bounded), flushing microtasks between checks. */
async function waitFor(cond: () => boolean, tries = 40): Promise<void> {
  for (let i = 0; i < tries && !cond(); i++) {
    await flush(1);
  }
}

function openShellTab(doc?: Record<string, unknown>, opts: Record<string, unknown> = {}): Tab {
  closeAllTabs();
  return openTab({
    document: doc ?? { children: [{ tagName: "p", textContent: "Hi" }], tagName: "div" },
    documentPath: "pages/current.json",
    id: "shell-tab",
    ...opts,
  });
}

beforeEach(() => {
  closeAllTabs();
  resetStudioState();
  statusMessages.length = 0;
  scheduleCanvasRenderMock.mockClear();
  consumePatchedMock.mockClear();
  consumePatchedReturn = false;
  view.functionEditor = null;
  view.panX = 0;
  view.panY = 0;
  view.needsCenter = true;
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("bootstrap", () => {
  test("captures wiring contexts for every mocked panel module", () => {
    expect(toolbarCtx).not.toBeNull();
    expect(paneCtx).not.toBeNull();
    expect(welcomeCtx).not.toBeNull();
    expect(blockBarCtx).not.toBeNull();
    expect(canvasRenderCtx).not.toBeNull();
    expect(canvasPatcherCtx).not.toBeNull();
    expect(shortcutsGet).not.toBeNull();
  });

  test("renders tag-name datalist and populates css-props via requestIdleCallback", () => {
    const tagList = document.querySelector("#tag-names");
    expect(tagList).not.toBeNull();
    expect(tagList!.querySelectorAll("option").length).toBeGreaterThan(0);
    const cssList = document.querySelector("#css-props");
    expect(cssList).not.toBeNull();
    expect(cssList!.querySelectorAll("option").length).toBeGreaterThan(0);
  });

  test("probed the platform for a root project at import time", () => {
    expect(state.calls.some((c) => c[0] === "probeRootProject")).toBe(true);
  });
});

describe("canvas mode", () => {
  test("getCanvasMode defaults to design when no tab is open", () => {
    expect(toolbarCtx.getCanvasMode()).toBe("design");
  });

  test("setCanvasMode writes through to the active tab session", () => {
    const tab = openShellTab();
    toolbarCtx.setCanvasMode("code");
    expect(tab.session.ui.canvasMode).toBe("code");
    expect(toolbarCtx.getCanvasMode()).toBe("code");
  });

  test("setCanvasMode is a no-op without a tab", () => {
    expect(() => toolbarCtx.setCanvasMode("code")).not.toThrow();
  });

  test("leaving git-diff mode clears gitDiffState", () => {
    openShellTab();
    toolbarCtx.setCanvasMode("git-diff");
    canvasRenderCtx.setGitDiffState({ path: "a.json" });
    expect(canvasRenderCtx.gitDiffState).toEqual({ path: "a.json" });
    toolbarCtx.setCanvasMode("design");
    expect(canvasRenderCtx.gitDiffState).toBeNull();
  });

  test("entering git-diff mode preserves gitDiffState", () => {
    openShellTab();
    canvasRenderCtx.setGitDiffState({ path: "b.json" });
    toolbarCtx.setCanvasMode("git-diff");
    expect(canvasRenderCtx.gitDiffState).toEqual({ path: "b.json" });
    canvasRenderCtx.setGitDiffState(null);
  });
});

describe("canvas-wrap background click", () => {
  const canvasWrap = () => document.querySelector("#canvas-wrap") as HTMLElement;

  test("clears the selection when the wrap itself is clicked", () => {
    const tab = openShellTab();
    tab.session.selection = ["children", 0];
    canvasWrap().dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(tab.session.selection).toBeNull();
  });

  test("ignores clicks on child elements", () => {
    const tab = openShellTab();
    tab.session.selection = ["children", 0];
    const child = document.createElement("div");
    canvasWrap().append(child);
    child.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(tab.session.selection).toEqual(["children", 0]);
    child.remove();
  });

  test("no-op when nothing is selected", () => {
    const tab = openShellTab();
    tab.session.selection = null;
    expect(() => {
      canvasWrap().dispatchEvent(new MouseEvent("click", { bubbles: true }));
    }).not.toThrow();
    expect(tab.session.selection).toBeNull();
  });
});

describe("navigateToComponent", () => {
  test("opens the component in its own tab and leaves the parent tab intact", async () => {
    const parent = openShellTab();
    parent.session.selection = ["children", 0];
    await blockBarCtx.navigateToComponent("components/card.json");

    // The parent is still open, still on its own document, still holding its selection.
    expect(parent.documentPath).toBe("pages/current.json");
    expect(parent.session.selection).toEqual(["children", 0]);
    expect(parent.session.documentStack).toHaveLength(0);

    // The component is a real, separately-keyed tab.
    expect(workspace.tabOrder).toEqual(["shell-tab", "components/card.json"]);
    const child = workspace.tabs.get("components/card.json")!;
    expect(workspace.activeTabId).toBe("components/card.json");
    expect(child.documentPath).toBe("components/card.json");
    expect((child.doc.document as any).tagName).toBe("my-card");
    expect(shell.leftTab).toBe("layers");
  });

  test("records the document it was drilled in from", async () => {
    openShellTab();
    await blockBarCtx.navigateToComponent("components/card.json");
    const child = workspace.tabs.get("components/card.json")!;
    expect(child.session.openedFrom).toEqual({
      documentPath: "pages/current.json",
      tabId: "shell-tab",
    });
  });

  test("drilling into an already-open component activates it without re-parenting it", async () => {
    openShellTab();
    await blockBarCtx.navigateToComponent("components/card.json");
    const child = workspace.tabs.get("components/card.json")!;
    activateTab("shell-tab");
    await blockBarCtx.navigateToComponent("components/card.json");
    expect(workspace.activeTabId).toBe("components/card.json");
    expect(workspace.tabs.get("components/card.json")).toBe(child);
    expect(workspace.tabOrder.filter((id) => id === "components/card.json")).toHaveLength(1);
  });

  test("returns silently when the file is empty", async () => {
    const tab = openShellTab();
    await blockBarCtx.navigateToComponent("components/empty.json");
    expect(tab.documentPath).toBe("pages/current.json");
    expect(workspace.tabs.has("components/empty.json")).toBe(false);
  });

  test("reports read errors via the statusbar", async () => {
    openShellTab();
    await blockBarCtx.navigateToComponent("components/missing.json");
    expect(statusMessages.at(-1)).toStartWith("Error:");
  });

  test("still opens the component when no tab was open to drill from", async () => {
    closeAllTabs();
    await blockBarCtx.navigateToComponent("components/card.json");
    const child = workspace.tabs.get("components/card.json")!;
    expect(child).toBeDefined();
    expect(child.session.openedFrom).toBeNull();
  });
});

/** Dispatch a Save/Discard/Cancel choice on the currently-open drill-out dialog. */
function answerDrillPrompt(event: "confirm" | "secondary" | "cancel"): void {
  const dlg = document.querySelector("#layer-dialog sp-dialog-wrapper") as HTMLElement;
  dlg.dispatchEvent(new Event(event));
}

describe("navigateBack", () => {
  function frameFor(tagName: string, ui: Record<string, unknown> = {}) {
    return {
      dirty: false,
      document: { children: [], tagName },
      documentPath: "pages/parent.json",
      mode: null,
      selection: null,
      sourceFormat: null,
      ui: { ...captureTabUi(createTab({ document: {}, id: "frame" }).session.ui), ...ui },
    };
  }

  test("no-op when the document stack is empty", async () => {
    openShellTab();
    await paneCtx.navigateBack();
    expect(statusMessages).toHaveLength(0);
  });

  test("clean child leaves without a prompt and restores the parent frame", async () => {
    const tab = openShellTab();
    tab.session.documentStack = [frameFor("section")] as any;
    tab.documentPath = "components/card-clean.json";
    tab.doc.dirty = false;
    const writes = () => state.calls.filter((c) => c[0] === "writeFile").length;
    const before = writes();
    await paneCtx.navigateBack();
    expect(document.querySelector("#layer-dialog sp-dialog-wrapper")).toBeNull();
    expect(writes()).toBe(before);
    expect((tab.doc.document as any).tagName).toBe("section");
    expect(tab.session.documentStack).toHaveLength(0);
    expect(statusMessages.at(-1)).toBe("Returned to parent document");
  });

  test("Save on a dirty child writes it, then restores the parent frame", async () => {
    const tab = openShellTab();
    tab.session.documentStack = [frameFor("section")] as any;
    tab.documentPath = "components/card-save.json";
    tab.doc.dirty = true;
    const nav = paneCtx.navigateBack();
    await flush();
    answerDrillPrompt("confirm");
    await nav;
    expect(state.files.get("components/card-save.json")).toContain('"tagName"');
    expect((tab.doc.document as any).tagName).toBe("section");
    expect(tab.documentPath).toBe("pages/parent.json");
    expect(tab.session.documentStack).toHaveLength(0);
    expect(statusMessages.at(-1)).toBe("Returned to parent document");
  });

  test("Discard leaves the child unwritten and restores the parent frame", async () => {
    const tab = openShellTab();
    tab.session.documentStack = [frameFor("section")] as any;
    tab.documentPath = "components/card-discard.json";
    tab.doc.dirty = true;
    const writes = () => state.calls.filter((c) => c[0] === "writeFile").length;
    const before = writes();
    const nav = paneCtx.navigateBack();
    await flush();
    answerDrillPrompt("secondary");
    await nav;
    expect(writes()).toBe(before);
    expect((tab.doc.document as any).tagName).toBe("section");
    expect(statusMessages.at(-1)).toBe("Returned to parent document");
  });

  test("Cancel aborts navigation and keeps the child open", async () => {
    const tab = openShellTab();
    tab.session.documentStack = [frameFor("section")] as any;
    tab.documentPath = "components/card-cancel.json";
    tab.doc.dirty = true;
    const writes = () => state.calls.filter((c) => c[0] === "writeFile").length;
    const before = writes();
    const nav = paneCtx.navigateBack();
    await flush();
    answerDrillPrompt("cancel");
    await nav;
    expect(writes()).toBe(before);
    expect(tab.documentPath).toBe("components/card-cancel.json");
    expect(tab.session.documentStack).toHaveLength(1);
  });

  test("a failing save is reported and navigation is cancelled", async () => {
    const tab = openShellTab();
    tab.session.documentStack = [frameFor("article")] as any;
    tab.documentPath = "components/card-fail.json";
    tab.doc.dirty = true;
    const originalWrite = platform.writeFile;
    platform.writeFile = async () => {
      throw new Error("disk full");
    };
    try {
      const nav = paneCtx.navigateBack();
      await flush();
      answerDrillPrompt("confirm");
      await nav;
    } finally {
      platform.writeFile = originalWrite;
    }
    expect(statusMessages.at(-1)).toBe("Save error: disk full");
    // The child is still open — its edits were not lost to a discard.
    expect(tab.documentPath).toBe("components/card-fail.json");
    expect(tab.session.documentStack).toHaveLength(1);
  });

  test("popping restores the parent's UI context, not just its document", async () => {
    const tab = openShellTab();
    tab.session.documentStack = [
      frameFor("section", {
        activeMedia: "@md",
        activeSelector: ":hover",
        rightTab: "style",
        zoom: 0.5,
      }),
    ] as any;
    tab.documentPath = "components/card-ui.json";
    tab.session.ui.activeMedia = "@sm";
    tab.session.ui.activeSelector = "::before";
    tab.session.ui.rightTab = "properties";
    tab.session.ui.zoom = 2;
    await paneCtx.navigateBack();
    expect(tab.session.ui.activeMedia).toBe("@md");
    expect(tab.session.ui.activeSelector).toBe(":hover");
    expect(tab.session.ui.rightTab).toBe("style");
    expect(tab.session.ui.zoom).toBe(0.5);
  });
});

describe("navigateToLevel", () => {
  function frame(tagName: string) {
    return {
      dirty: false,
      document: { children: [], tagName },
      documentPath: `pages/${tagName}.json`,
      mode: null,
      selection: null,
      sourceFormat: null,
      ui: captureTabUi(createTab({ document: {}, id: "frame" }).session.ui),
    };
  }

  test("ignores out-of-range indexes", async () => {
    const tab = openShellTab();
    tab.session.documentStack = [frame("one")] as any;
    await paneCtx.navigateToLevel(-1);
    await paneCtx.navigateToLevel(5);
    expect(tab.session.documentStack).toHaveLength(1);
    expect(statusMessages).toHaveLength(0);
  });

  test("ignores calls when there is no stack at all", async () => {
    openShellTab();
    await paneCtx.navigateToLevel(0);
    expect(statusMessages).toHaveLength(0);
  });

  test("jumps to an ancestor level, truncating the stack", async () => {
    const tab = openShellTab();
    tab.session.documentStack = [frame("root"), frame("mid")] as any;
    await paneCtx.navigateToLevel(0);
    expect((tab.doc.document as any).tagName).toBe("root");
    expect(tab.documentPath).toBe("pages/root.json");
    expect(tab.session.documentStack).toHaveLength(0);
    expect(statusMessages.at(-1)).toBe("Returned to parent document");
  });

  test("Save on a dirty document writes it before jumping", async () => {
    const tab = openShellTab();
    tab.session.documentStack = [frame("root")] as any;
    tab.documentPath = "pages/deep-save.json";
    tab.doc.dirty = true;
    const nav = paneCtx.navigateToLevel(0);
    await flush();
    answerDrillPrompt("confirm");
    await nav;
    expect(state.files.has("pages/deep-save.json")).toBe(true);
    expect((tab.doc.document as any).tagName).toBe("root");
  });

  test("Discard jumps without writing the dirty document", async () => {
    const tab = openShellTab();
    tab.session.documentStack = [frame("root")] as any;
    tab.documentPath = "pages/deep-discard.json";
    tab.doc.dirty = true;
    const writes = () => state.calls.filter((c) => c[0] === "writeFile").length;
    const before = writes();
    const nav = paneCtx.navigateToLevel(0);
    await flush();
    answerDrillPrompt("secondary");
    await nav;
    expect(writes()).toBe(before);
    expect((tab.doc.document as any).tagName).toBe("root");
  });

  test("a failing save is reported and the jump is cancelled", async () => {
    const tab = openShellTab();
    tab.session.documentStack = [frame("root")] as any;
    tab.documentPath = "pages/deep-fail.json";
    tab.doc.dirty = true;
    const originalWrite = platform.writeFile;
    platform.writeFile = async () => {
      throw new Error("readonly fs");
    };
    try {
      const nav = paneCtx.navigateToLevel(0);
      await flush();
      answerDrillPrompt("confirm");
      await nav;
    } finally {
      platform.writeFile = originalWrite;
    }
    expect(statusMessages.at(-1)).toBe("Save error: readonly fs");
    // The jump was aborted — the deep doc is still active.
    expect(tab.documentPath).toBe("pages/deep-fail.json");
    expect(tab.session.documentStack).toHaveLength(1);
  });
});

describe("closeFunctionEditor", () => {
  test("no-op when nothing is being edited", async () => {
    openShellTab();
    const editor = { dispose: mock(() => {}), getValue: () => "x" };
    view.functionEditor = editor as any;
    await toolbarCtx.closeFunctionEditor();
    expect(editor.dispose).not.toHaveBeenCalled();
    expect(view.functionEditor).toBe(editor as any);
    view.functionEditor = null;
  });

  test("stores the edited def body (raw code when minify yields nothing)", async () => {
    const tab = openShellTab({
      children: [],
      state: { fn: { $prototype: "Function", body: "old" } },
      tagName: "div",
    });
    tab.session.ui.editingFunction = { defName: "fn", type: "def" };
    const editor = { dispose: mock(() => {}), getValue: () => "return 42;" };
    view.functionEditor = editor as any;
    await toolbarCtx.closeFunctionEditor();
    expect((tab.doc.document as any).state.fn.body).toBe("return 42;");
    expect(editor.dispose).toHaveBeenCalled();
    expect(view.functionEditor).toBeNull();
    expect(tab.session.ui.editingFunction).toBeNull();
  });

  test("uses the minified body when the code service provides one", async () => {
    const tab = openShellTab({
      children: [],
      state: { fn: { $prototype: "Function", body: "old" } },
      tagName: "div",
    });
    tab.session.ui.editingFunction = { defName: "fn", type: "def" };
    view.functionEditor = { dispose: mock(() => {}), getValue: () => "return 42 ;" } as any;
    const originalCodeService = platform.codeService;
    platform.codeService = (async () => ({ code: "return 42;" })) as any;
    try {
      await toolbarCtx.closeFunctionEditor();
    } finally {
      platform.codeService = originalCodeService;
    }
    expect((tab.doc.document as any).state.fn.body).toBe("return 42;");
  });

  test("merges an event handler body onto the existing binding", async () => {
    const tab = openShellTab({
      children: [{ onclick: { $prototype: "Function", arguments: ["e"] }, tagName: "button" }],
      tagName: "div",
    });
    tab.session.ui.editingFunction = { eventKey: "onclick", path: ["children", 0], type: "event" };
    view.functionEditor = { dispose: mock(() => {}), getValue: () => "go(e)" } as any;
    await toolbarCtx.closeFunctionEditor();
    const [node] = (tab.doc.document as any).children;
    expect(node.onclick.body).toBe("go(e)");
    expect(node.onclick.arguments).toEqual(["e"]);
    expect(node.onclick.$prototype).toBe("Function");
  });

  test("clears the editing flag even when no editor instance exists", async () => {
    const tab = openShellTab();
    tab.session.ui.editingFunction = { defName: "fn", type: "def" };
    view.functionEditor = null;
    await toolbarCtx.closeFunctionEditor();
    expect(tab.session.ui.editingFunction).toBeNull();
  });
});

describe("canvas render effects", () => {
  test("replacing the document schedules a canvas render", async () => {
    const tab = openShellTab();
    await flush();
    scheduleCanvasRenderMock.mockClear();
    tab.doc.document = { children: [], tagName: "span" } as any;
    expect(scheduleCanvasRenderMock).toHaveBeenCalled();
  });

  test("a surgically patched document skips the full render", async () => {
    const tab = openShellTab();
    await flush();
    consumePatchedReturn = true;
    scheduleCanvasRenderMock.mockClear();
    consumePatchedMock.mockClear();
    tab.doc.document = { children: [], tagName: "em" } as any;
    expect(consumePatchedMock).toHaveBeenCalled();
    const fromDocEffect = scheduleCanvasRenderMock.mock.calls.length;
    expect(fromDocEffect).toBe(0);
  });

  test("UI flag changes always schedule a render", async () => {
    openShellTab();
    await flush();
    scheduleCanvasRenderMock.mockClear();
    shell.settingsTab = "fonts";
    expect(scheduleCanvasRenderMock).toHaveBeenCalled();
  });
});

describe("openRecentProject", () => {
  test("loads project.json, rebuilds project state, and opens the project", async () => {
    await toolbarCtx.openRecentProject("/recent/site");
    expect(platform.projectRoot).toBe("/recent/site");
    expect(shell.leftTab).toBe("files");
    expect(statusMessages).toContain("Opened project: Recent Project");
  });

  test("expands and loads conventional directories found at the project root", async () => {
    const originalList = platform.listDirectory;
    const listed: string[] = [];
    platform.listDirectory = (async (dir: string) => {
      listed.push(dir);
      if (dir === ".") {
        return [
          { name: "pages", path: "pages", type: "directory" },
          { name: "vendor", path: "vendor", type: "directory" },
          { name: "readme.md", path: "readme.md", type: "file" },
        ];
      }
      return [];
    }) as any;
    try {
      await toolbarCtx.openRecentProject("/recent/site");
    } finally {
      platform.listDirectory = originalList;
    }
    expect(listed).toContain("pages");
    expect(listed).not.toContain("vendor");
    expect(statusMessages).toContain("Opened project: Recent Project");
  });

  test("switching projects refreshes the format registry (stale-cache regression)", async () => {
    const { formatForPath, loadFormats, setFormats } = await import("../src/format/format-host");
    // A fresh desktop launch caches a registry with no Markdown (no project open / previous root)…
    setFormats([]);
    expect(formatForPath("pages/contact.md")).toBeUndefined();
    // …and the newly-opened project's backend registry claims .md.
    (platform as any).listFormats = async () => [
      {
        capabilities: { parse: { identifier: "parse", timing: ["client"] } },
        documentKinds: ["page"],
        exportTarget: false,
        extensions: [".md"],
        mediaType: "text/markdown",
        name: "Markdown",
        remote: false,
        studio: null,
      },
    ];
    try {
      await toolbarCtx.openRecentProject("/recent/site");
      await loadFormats();
      // Without the refreshFormats() in openRecentProject the stale empty cache answers and
      // Opening any .md fails with "No format class imported".
      expect(formatForPath("pages/contact.md")?.name).toBe("Markdown");
    } finally {
      delete (platform as any).listFormats;
      setFormats([]);
    }
  });

  test("reports a missing project.json as an error", async () => {
    const saved = state.files.get("project.json")!;
    state.files.delete("project.json");
    try {
      await toolbarCtx.openRecentProject("/recent/site");
    } finally {
      state.files.set("project.json", saved);
    }
    expect(statusMessages.at(-1)).toStartWith("Error:");
  });
});

describe("project open delegates", () => {
  test("toolbar openProject delegates to the platform (user cancel path)", async () => {
    const before = state.calls.filter((c) => c[0] === "openProject").length;
    await toolbarCtx.openProject();
    const after = state.calls.filter((c) => c[0] === "openProject").length;
    expect(after).toBe(before + 1);
  });

  test("repo-list platforms route openProject through the picker, bypassing the backend dialog", async () => {
    pickerEnabled = true;
    pickerResult = { root: "/picked/repo" };
    const before = state.calls.filter((c) => c[0] === "openProject").length;
    try {
      await toolbarCtx.openProject();
      await waitFor(() => statusMessages.includes("Opened project: Recent Project"));
    } finally {
      pickerEnabled = false;
      pickerResult = null;
    }
    expect(state.calls.filter((c) => c[0] === "openProject")).toHaveLength(before);
    expect(platform.projectRoot).toBe("/picked/repo");
    expect(statusMessages).toContain("Opened project: Recent Project");
  });

  test("a cancelled repo picker is a no-op", async () => {
    pickerEnabled = true;
    pickerResult = null;
    const before = state.calls.filter((c) => c[0] === "openProject").length;
    try {
      await toolbarCtx.openProject();
    } finally {
      pickerEnabled = false;
    }
    expect(state.calls.filter((c) => c[0] === "openProject")).toHaveLength(before);
    expect(statusMessages).toHaveLength(0);
  });

  test("welcome openNewProject does nothing when the modal is cancelled", async () => {
    newProjectResult = null;
    await welcomeCtx.openNewProject();
    expect(statusMessages).toHaveLength(0);
  });

  test("welcome openNewProject opens the created project", async () => {
    newProjectResult = { root: "/new/site" };
    try {
      // OpenNewProject fires openRecentProject without awaiting it; poll for completion.
      await welcomeCtx.openNewProject();
      await waitFor(() => statusMessages.includes("Opened project: Recent Project"));
    } finally {
      newProjectResult = null;
    }
    expect(platform.projectRoot).toBe("/new/site");
    expect(statusMessages).toContain("Opened project: Recent Project");
  });

  test("welcome addExistingRepo does nothing when the modal is cancelled", async () => {
    addRepoResult = null;
    await welcomeCtx.addExistingRepo();
    expect(statusMessages).toHaveLength(0);
  });

  test("welcome addExistingRepo opens the imported repo", async () => {
    addRepoResult = { root: "/added/repo" };
    try {
      // AddExistingRepo fires openRecentProject without awaiting it; poll for completion.
      await welcomeCtx.addExistingRepo();
      await waitFor(() => statusMessages.includes("Opened project: Recent Project"));
    } finally {
      addRepoResult = null;
    }
    expect(platform.projectRoot).toBe("/added/repo");
    expect(statusMessages).toContain("Opened project: Recent Project");
  });
});

describe("openFileFromTree", () => {
  test("opens a JSON file from the platform in a new tab", async () => {
    closeAllTabs();
    resetStudioState({ selectedPath: null });
    await canvasRenderCtx.openFileFromTree("pages/a.json");
    expect(activeTab.value?.id).toBe("pages/a.json");
    expect((activeTab.value!.doc.document as any).tagName).toBe("main");
    expect(workspace.tabs.has("pages/a.json")).toBe(true);
  });
});

describe("right panel", () => {
  test("safeRenderRightPanel renders without throwing", () => {
    openShellTab();
    expect(() => toolbarCtx.safeRenderRightPanel()).not.toThrow();
  });
});

describe("wiring arrows", () => {
  test("toolbar renderCanvas delegates to the canvas renderer", () => {
    renderCanvasMock.mockClear();
    toolbarCtx.renderCanvas();
    expect(renderCanvasMock).toHaveBeenCalledTimes(1);
  });

  test("tab bar exposes parseMediaEntries from canvas-media utils", () => {
    expect(typeof paneCtx.parseMediaEntries).toBe("function");
    expect(paneCtx.parseMediaEntries(null)).toEqual({
      baseWidth: 320,
      featureQueries: [],
      sizeBreakpoints: [],
    });
  });

  test("welcome openProject delegates to the platform open flow", async () => {
    const before = state.calls.filter((c) => c[0] === "openProject").length;
    await welcomeCtx.openProject();
    expect(state.calls.filter((c) => c[0] === "openProject").length).toBe(before + 1);
  });

  test("tab bar exposes exportFile; canvas render ctx exposes the git-diff hooks", () => {
    expect(typeof paneCtx.exportFile).toBe("function");
    expect(typeof canvasRenderCtx.setCanvasMode).toBe("function");
    canvasRenderCtx.setGitDiffState({ path: "x" });
    expect(canvasRenderCtx.gitDiffState).toEqual({ path: "x" });
    canvasRenderCtx.setGitDiffState(null);
    expect(canvasRenderCtx.gitDiffState).toBeNull();
  });

  test("block action bar ctx shares the same canvas mode source", () => {
    openShellTab();
    toolbarCtx.setCanvasMode("content");
    expect(blockBarCtx.getCanvasMode()).toBe("content");
  });
});

describe("shortcuts context", () => {
  test("exposes live canvas state and pan setter", () => {
    openShellTab();
    toolbarCtx.setCanvasMode("design");
    const ctx = shortcutsGet!();
    expect(ctx.canvasMode).toBe("design");
    expect(typeof ctx.applyTransform).toBe("function");
    ctx.setPan(12, 34);
    expect(view.panX).toBe(12);
    expect(view.panY).toBe(34);
    expect(view.needsCenter).toBe(false);
  });

  /* Save / Open Project / Open in Browser are no longer read off the gesture context: they are the
     three command implementations the bootstrap has to reach outside `editor/shortcuts.ts` for, so
     they arrive once at registration instead of on every wheel event. */
  test("hands the command set the three verbs the bootstrap owns", () => {
    expect(shortcutHooks).not.toBeNull();
    expect(typeof shortcutHooks!.saveDocument).toBe("function");
    expect(typeof shortcutHooks!.openProject).toBe("function");
    expect(typeof shortcutHooks!.openInBrowser).toBe("function");
  });

  test("Open in Browser opens the resolved page, or states why it cannot", () => {
    const opened: string[] = [];
    const realOpen = window.open;
    (window as unknown as { open: unknown }).open = (url: string) => {
      opened.push(url);
      return null;
    };
    try {
      browserTarget = { url: "https://example.test/page" };
      (shortcutHooks!.openInBrowser as () => void)();
      expect(opened).toEqual(["https://example.test/page"]);

      // Never silently absent: with no page resolvable the reason is reported (toolbar.ts:173).
      browserTarget = { reason: "this document is not a page" };
      (shortcutHooks!.openInBrowser as () => void)();
      expect(opened).toHaveLength(1);
      expect(statusMessages.at(-1)).toBe("this document is not a page");
    } finally {
      (window as unknown as { open: unknown }).open = realOpen;
    }
  });
});

describe("zoom wiring", () => {
  test("setZoomDirect writes the zoom to the active tab session", () => {
    const tab = openShellTab();
    tab.session.ui.zoom = 2.5;
    const wrap = document.createElement("div");
    document.querySelector("#canvas-wrap")!.append(wrap);
    view.panzoomWrap = wrap;
    try {
      resetZoom();
      expect(tab.session.ui.zoom).toBe(1);
    } finally {
      view.panzoomWrap = null;
      wrap.remove();
    }
  });

  test("setZoomDirect is a no-op without an active tab", () => {
    closeAllTabs();
    const wrap = document.createElement("div");
    view.panzoomWrap = wrap;
    try {
      expect(() => resetZoom()).not.toThrow();
    } finally {
      view.panzoomWrap = null;
    }
  });
});

describe("unsaved-changes guard", () => {
  test("beforeunload is cancelled only while a tab has unsaved changes", () => {
    const tab = openShellTab();
    tab.doc.dirty = false;
    const clean = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(clean);
    expect(clean.defaultPrevented).toBe(false);

    tab.doc.dirty = true;
    const dirty = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(dirty);
    expect(dirty.defaultPrevented).toBe(true);
  });
});

describe("parent-chrome commit guard", () => {
  test("a chrome pointerdown with no live edit session is a harmless no-op", () => {
    // The capture-phase guard registered at init runs on every parent pointerdown; without an
    // Active edit host (getEditSnapshot().editing false) it must short-circuit silently.
    expect(() =>
      document.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })),
    ).not.toThrow();
    expect(commitEditMock).not.toHaveBeenCalled();
  });

  test("a chrome pointerdown during a live edit session commits it", () => {
    editingOverride = true;
    try {
      document.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
      expect(commitEditMock).toHaveBeenCalled();
    } finally {
      editingOverride = false;
      commitEditMock.mockClear();
    }
  });
});

describe("stylebook hit routing", () => {
  test("a tag hit selects the stylebook tag; a null hit clears the selection", () => {
    const tab = openShellTab();
    expect(stylebookHit).not.toBeNull();
    stylebookHit!("button", "sm");
    expect(shell.stylebook.selection).toBe("button");
    expect(tab.session.ui.activeSelector).toBe("button");
    expect(tab.session.ui.activeMedia).toBe("sm");
    stylebookHit!(null, null);
    expect(shell.stylebook.selection).toBeNull();
    expect(tab.session.ui.activeSelector).toBeNull();
  });
});

describe("left panel wiring", () => {
  test("mount ctx propagates git-diff state and canvas renders", () => {
    expect(leftPanelCtx).not.toBeNull();
    leftPanelCtx.setGitDiffState({ path: "z.json" });
    expect(canvasRenderCtx.gitDiffState).toEqual({ path: "z.json" });
    leftPanelCtx.setGitDiffState(null);
    expect(canvasRenderCtx.gitDiffState).toBeNull();

    renderCanvasMock.mockClear();
    leftPanelCtx.renderCanvas();
    expect(renderCanvasMock).toHaveBeenCalledTimes(1);
  });

  test("clone-repository delegates report unsupported platforms", async () => {
    // The in-memory platform has no gitClone, so both delegates hit the unsupported guard.
    await leftPanelCtx.cloneRepository();
    expect(statusMessages.at(-1)).toBe("Clone not supported on this platform");
    statusMessages.length = 0;
    await welcomeCtx.cloneRepository();
    expect(statusMessages.at(-1)).toBe("Clone not supported on this platform");
  });
});

describe("collab parser wiring", () => {
  test("parses JSON documents directly when no format claims the path", async () => {
    const tab = openShellTab();
    const result = await collabParser!(tab, '{"tagName":"div"}');
    expect(result.document).toEqual({ tagName: "div" });
  });

  test("routes format-claimed paths through the format host", async () => {
    const { setFormats } = await import("../src/format/format-host");
    setFormats([
      {
        capabilities: { parse: { identifier: "parse", timing: ["client"] } },
        documentKinds: ["page"],
        exportTarget: false,
        extensions: [".md"],
        mediaType: "text/markdown",
        name: "Markdown",
        remote: false,
        studio: null,
      } as never,
    ]);
    try {
      const tab = openShellTab(undefined, { documentPath: "pages/x.md", id: "md-tab" });
      // The stub format has no client parser class, so parseSourceForPath rejects — the
      // Format-dispatch branch of the parser still ran.
      let threw = false;
      try {
        await collabParser!(tab, "# hi");
      } catch {
        threw = true;
      }
      expect(threw).toBe(true);
    } finally {
      setFormats([]);
    }
  });
});

describe("multi-window project routing", () => {
  test("openRecentProject routes to a new window when this window holds a project", async () => {
    const openInNew = mock(async (_root: string) => {});
    (platform as any).openProjectInNewWindow = openInNew;
    try {
      const before = state.calls.filter((c) => c[0] === "readFile").length;
      await toolbarCtx.openRecentProject("/other/site");
      expect(openInNew).toHaveBeenCalledWith("/other/site");
      // Early return: this window's project stays put, no project.json read.
      expect(state.calls.filter((c) => c[0] === "readFile").length).toBe(before);
      expect(statusMessages).toHaveLength(0);
    } finally {
      delete (platform as any).openProjectInNewWindow;
    }
  });

  test("setWindowProject dedupe bails; a fresh bind proceeds to open", async () => {
    let deduped = true;
    (platform as any).setWindowProject = mock(async (_root: string) => ({ deduped }));
    try {
      await toolbarCtx.openRecentProject("/recent/site");
      expect(statusMessages).toHaveLength(0); // Focused the other window and bailed.

      deduped = false;
      await toolbarCtx.openRecentProject("/recent/site");
      expect(statusMessages).toContain("Opened project: Recent Project");
    } finally {
      delete (platform as any).setWindowProject;
    }
  });
});

describe("remaining wiring arrows", () => {
  test("toolbar saveFile writes the active document through the platform", async () => {
    const tab = openShellTab();
    tab.doc.dirty = true;
    const before = state.calls.filter((c) => c[0] === "writeFile").length;
    await toolbarCtx.saveFile();
    expect(state.calls.filter((c) => c[0] === "writeFile").length).toBe(before + 1);
  });

  test("tab bar closeFunctionEditor shares the toolbar delegate (no-op path)", async () => {
    const tab = openShellTab();
    tab.session.ui.editingFunction = null;
    await paneCtx.closeFunctionEditor();
    expect(tab.session.ui.editingFunction).toBeNull();
  });

  test("welcome openRecentProject opens the project directly", async () => {
    await welcomeCtx.openRecentProject("/recent/site");
    expect(statusMessages).toContain("Opened project: Recent Project");
  });

  test("the statusbar renderer arrow delegates to the statusbar module", () => {
    expect(statusbarRenderer).not.toBeNull();
    renderStatusbarMock.mockClear();
    statusbarRenderer!();
    expect(renderStatusbarMock).toHaveBeenCalledTimes(1);
  });
});
