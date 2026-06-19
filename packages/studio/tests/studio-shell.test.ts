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
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { activeTab, closeAllTabs, openTab, workspace } from "../src/workspace/workspace";
import { view } from "../src/view";
import { canvasPanels } from "../src/store";
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
let tabBarCtx: any = null;
let welcomeCtx: any = null;
let blockBarCtx: any = null;
let canvasRenderCtx: any = null;
let canvasPatcherCtx: any = null;
let shortcutsGet: (() => any) | null = null;

const statusMessages: string[] = [];
const scheduleCanvasRenderMock = mock(() => {});
const renderCanvasMock = mock(() => {});
let consumePatchedReturn = false;
const consumePatchedMock = mock((_doc: object) => consumePatchedReturn);
let newProjectResult: { root: string } | null = null;

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

void mock.module("../src/panels/statusbar.ts", () => ({
  mountStatusbar: mock(() => {}),
  renderStatusbar: mock(() => {}),
  setStatusbarRenderer: mock(() => {}),
  statusMessage: (msg: string) => {
    statusMessages.push(msg);
  },
  unmountStatusbar: mock(() => {}),
}));

void mock.module("../src/panels/toolbar.ts", () => ({
  mount: (_el: HTMLElement, ctx: unknown) => {
    toolbarCtx = ctx;
  },
  render: mock(() => {}),
  unmount: mock(() => {}),
}));

void mock.module("../src/panels/tab-bar.ts", () => ({
  mount: (_el: HTMLElement, ctx: unknown) => {
    tabBarCtx = ctx;
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
  initShortcuts: (get: () => unknown) => {
    shortcutsGet = get as () => any;
  },
}));

void mock.module("../src/panels/block-action-bar.ts", () => ({
  dismissBlockActionBar: mock(() => {}),
  dismissLinkPopover: mock(() => {}),
  initBlockActionBar: (ctx: unknown) => {
    blockBarCtx = ctx;
  },
  renderBlockActionBar: mock(() => {}),
}));

void mock.module("../src/canvas/canvas-render.ts", () => ({
  applyCanvasMediaOverrides: mock(() => {}),
  initCanvasRender: (ctx: unknown) => {
    canvasRenderCtx = ctx;
  },
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
  view.autosaveTimer = null;
  view.panX = 0;
  view.panY = 0;
  view.needsCenter = true;
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("bootstrap", () => {
  test("captures wiring contexts for every mocked panel module", () => {
    expect(toolbarCtx).not.toBeNull();
    expect(tabBarCtx).not.toBeNull();
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
  test("pushes the current document onto the stack and loads the component", async () => {
    const tab = openShellTab();
    tab.session.selection = ["children", 0];
    await blockBarCtx.navigateToComponent("components/card.json");
    expect(tab.documentPath).toBe("components/card.json");
    expect((tab.doc.document as any).tagName).toBe("my-card");
    expect(tab.session.documentStack).toHaveLength(1);
    expect((tab.session.documentStack![0] as any).documentPath).toBe("pages/current.json");
    expect(tab.session.selection).toBeNull();
    expect(view.leftTab).toBe("layers");
    expect(statusMessages.at(-1)).toBe("Editing component: my-card");
  });

  test("creates the document stack when the session has none", async () => {
    const tab = openShellTab();
    tab.session.documentStack = undefined as any;
    await blockBarCtx.navigateToComponent("components/card.json");
    expect(tab.session.documentStack).toHaveLength(1);
    expect(tab.documentPath).toBe("components/card.json");
  });

  test("returns silently when the file is empty", async () => {
    const tab = openShellTab();
    await blockBarCtx.navigateToComponent("components/empty.json");
    expect(tab.documentPath).toBe("pages/current.json");
    expect(statusMessages).toHaveLength(0);
  });

  test("reports read errors via the statusbar", async () => {
    openShellTab();
    await blockBarCtx.navigateToComponent("components/missing.json");
    expect(statusMessages.at(-1)).toStartWith("Error:");
  });

  test("returns silently when no tab is open", async () => {
    closeAllTabs();
    await blockBarCtx.navigateToComponent("components/card.json");
    expect(statusMessages).toHaveLength(0);
  });
});

describe("navigateBack", () => {
  function frameFor(tagName: string) {
    return {
      dirty: false,
      document: { children: [], tagName },
      documentPath: "pages/parent.json",
      mode: null,
      selection: null,
      sourceFormat: null,
    };
  }

  test("no-op when the document stack is empty", async () => {
    openShellTab();
    await tabBarCtx.navigateBack();
    expect(statusMessages).toHaveLength(0);
  });

  test("saves a dirty document then restores the parent frame", async () => {
    const tab = openShellTab();
    tab.session.documentStack = [frameFor("section")] as any;
    tab.documentPath = "components/card.json";
    tab.doc.dirty = true;
    await tabBarCtx.navigateBack();
    expect(state.files.get("components/card.json")).toContain('"tagName"');
    expect((tab.doc.document as any).tagName).toBe("section");
    expect(tab.documentPath).toBe("pages/parent.json");
    expect(tab.session.documentStack).toHaveLength(0);
    expect(statusMessages.at(-1)).toBe("Returned to parent document");
  });

  test("a failing save is reported but navigation still proceeds", async () => {
    const tab = openShellTab();
    tab.session.documentStack = [frameFor("article")] as any;
    tab.doc.dirty = true;
    const originalWrite = platform.writeFile;
    platform.writeFile = async () => {
      throw new Error("disk full");
    };
    try {
      await tabBarCtx.navigateBack();
    } finally {
      platform.writeFile = originalWrite;
    }
    expect(statusMessages[0]).toBe("Save error: disk full");
    expect((tab.doc.document as any).tagName).toBe("article");
    expect(statusMessages.at(-1)).toBe("Returned to parent document");
  });

  test("a stack holding an undefined frame is popped without applying it", async () => {
    const tab = openShellTab();
    tab.session.documentStack = [undefined] as any;
    tab.doc.dirty = false;
    const before = tab.doc.document;
    await tabBarCtx.navigateBack();
    expect(tab.doc.document).toBe(before);
    expect(statusMessages).toHaveLength(0);
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
    };
  }

  test("ignores out-of-range indexes", async () => {
    const tab = openShellTab();
    tab.session.documentStack = [frame("one")] as any;
    await tabBarCtx.navigateToLevel(-1);
    await tabBarCtx.navigateToLevel(5);
    expect(tab.session.documentStack).toHaveLength(1);
    expect(statusMessages).toHaveLength(0);
  });

  test("ignores calls when there is no stack at all", async () => {
    openShellTab();
    await tabBarCtx.navigateToLevel(0);
    expect(statusMessages).toHaveLength(0);
  });

  test("jumps to an ancestor level, truncating the stack", async () => {
    const tab = openShellTab();
    tab.session.documentStack = [frame("root"), frame("mid")] as any;
    await tabBarCtx.navigateToLevel(0);
    expect((tab.doc.document as any).tagName).toBe("root");
    expect(tab.documentPath).toBe("pages/root.json");
    expect(tab.session.documentStack).toHaveLength(0);
    expect(statusMessages.at(-1)).toBe("Returned to parent document");
  });

  test("saves a dirty document before jumping", async () => {
    const tab = openShellTab();
    tab.session.documentStack = [frame("root")] as any;
    tab.documentPath = "pages/deep.json";
    tab.doc.dirty = true;
    await tabBarCtx.navigateToLevel(0);
    expect(state.files.has("pages/deep.json")).toBe(true);
    expect((tab.doc.document as any).tagName).toBe("root");
  });

  test("reports save errors but still jumps", async () => {
    const tab = openShellTab();
    tab.session.documentStack = [frame("root")] as any;
    tab.documentPath = "pages/deep.json";
    tab.doc.dirty = true;
    const originalWrite = platform.writeFile;
    platform.writeFile = async () => {
      throw new Error("readonly fs");
    };
    try {
      await tabBarCtx.navigateToLevel(0);
    } finally {
      platform.writeFile = originalWrite;
    }
    expect(statusMessages[0]).toBe("Save error: readonly fs");
    expect((tab.doc.document as any).tagName).toBe("root");
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
    const tab = openShellTab();
    await flush();
    scheduleCanvasRenderMock.mockClear();
    tab.session.ui.settingsTab = "fonts";
    expect(scheduleCanvasRenderMock).toHaveBeenCalled();
  });
});

describe("openRecentProject", () => {
  test("loads project.json, rebuilds project state, and opens the project", async () => {
    await toolbarCtx.openRecentProject("/recent/site");
    expect(platform.projectRoot).toBe("/recent/site");
    expect(view.leftTab).toBe("files");
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
    expect(typeof tabBarCtx.parseMediaEntries).toBe("function");
    expect(tabBarCtx.parseMediaEntries(null)).toEqual({
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
    expect(typeof tabBarCtx.exportFile).toBe("function");
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
    expect(typeof ctx.saveFile).toBe("function");
    expect(typeof ctx.openProject).toBe("function");
    ctx.setPan(12, 34);
    expect(view.panX).toBe(12);
    expect(view.panY).toBe(34);
    expect(view.needsCenter).toBe(false);
  });

  test("enterEditOnPath defers via rAF and tolerates a missing canvas panel", async () => {
    openShellTab();
    const origRaf = globalThis.requestAnimationFrame;
    let ran = false;
    (globalThis as any).requestAnimationFrame = (cb: FrameRequestCallback) => {
      ran = true;
      cb(0);
      return 0;
    };
    try {
      const ctx = shortcutsGet!();
      expect(() => ctx.enterEditOnPath(["children", 0])).not.toThrow();
    } finally {
      globalThis.requestAnimationFrame = origRaf;
    }
    expect(ran).toBe(true);
  });

  test("enterEditOnPath resolves the element through the active canvas panel", () => {
    openShellTab();
    const canvas = document.createElement("div");
    canvas.innerHTML = "<div><jx-widget>nope</jx-widget></div>";
    canvasPanels.push({ canvas, mediaName: "base" } as any);
    const origRaf = globalThis.requestAnimationFrame;
    (globalThis as any).requestAnimationFrame = (cb: FrameRequestCallback) => {
      cb(0);
      return 0;
    };
    try {
      const ctx = shortcutsGet!();
      // Path resolves to <jx-widget>, which is not an editable block — no edit session starts.
      expect(() => ctx.enterEditOnPath(["children", 0])).not.toThrow();
      expect(view.componentInlineEdit).toBeNull();
    } finally {
      globalThis.requestAnimationFrame = origRaf;
      canvasPanels.length = 0;
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

describe("autosave", () => {
  function makeFileHandle(behavior: { failCreate?: boolean } = {}) {
    const write = mock(async (_: string) => {});
    const close = mock(async () => {});
    const handle = {
      createWritable: async () => {
        if (behavior.failCreate) {
          throw new Error("no permission");
        }
        return { close, write };
      },
    };
    return { close, handle, write };
  }

  /** Capture the 2s autosave callback by patching setTimeout around a dirty toggle. */
  function captureAutosave(trigger: () => void): (() => Promise<void>) | null {
    const origSetTimeout = globalThis.setTimeout;
    let captured: (() => Promise<void>) | null = null;
    (globalThis as any).setTimeout = (cb: () => Promise<void>, ms?: number) => {
      if (ms === 2000) {
        captured = cb;
        return 0;
      }
      return origSetTimeout(cb, ms);
    };
    try {
      trigger();
    } finally {
      globalThis.setTimeout = origSetTimeout;
    }
    return captured;
  }

  test("does not schedule when the tab has no file handle", () => {
    const tab = openShellTab();
    const captured = captureAutosave(() => {
      tab.doc.dirty = true;
    });
    expect(captured).toBeNull();
  });

  test("writes the document through the file handle and clears dirty", async () => {
    const { close, handle, write } = makeFileHandle();
    const tab = openShellTab(undefined, { fileHandle: handle, id: "autosave-tab" });
    // Pre-existing timer exercises the clearTimeout branch.
    view.autosaveTimer = setTimeout(() => {}, 60_000);
    const captured = captureAutosave(() => {
      tab.doc.dirty = true;
    });
    expect(captured).not.toBeNull();
    await captured!();
    expect(write).toHaveBeenCalledTimes(1);
    expect(String(write.mock.calls[0]![0])).toContain('"tagName"');
    expect(close).toHaveBeenCalledTimes(1);
    expect(tab.doc.dirty).toBe(false);
    expect(statusMessages).toContain("Auto-saved");
  });

  test("skips the write when the document is clean by the time the timer fires", async () => {
    const { handle, write } = makeFileHandle();
    const tab = openShellTab(undefined, { fileHandle: handle, id: "autosave-clean" });
    const captured = captureAutosave(() => {
      tab.doc.dirty = true;
    });
    tab.doc.dirty = false;
    await captured!();
    expect(write).not.toHaveBeenCalled();
  });

  test("swallows save failures and leaves the document dirty", async () => {
    const { handle, write } = makeFileHandle({ failCreate: true });
    const tab = openShellTab(undefined, { fileHandle: handle, id: "autosave-fail" });
    const captured = captureAutosave(() => {
      tab.doc.dirty = true;
    });
    await captured!();
    expect(write).not.toHaveBeenCalled();
    expect(tab.doc.dirty).toBe(true);
  });
});
