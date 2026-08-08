/**
 * Studio shell (C7): import-time bootstrap and private callbacks of src/studio.ts.
 *
 * Studio.ts is a side-effect module: it wires panel modules together and never exports anything.
 * Heavy leaf modules (monaco, canvas renderer/patcher, toolbar, shortcuts, welcome screen, block
 * action bar, statusbar) are mocked so their init/mount calls capture the private studio callbacks
 * (navigateToComponent, openRecentProject, closeFunctionEditor, ...), which the tests then drive
 * directly.
 */
import { flush, installMockPlatform, resetStudioState } from "./harness";
import { nothing } from "lit-html";
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { notifyModule } from "./notify-mock";
import type { NotifyCall } from "./notify-mock";
import { projectState } from "../src/state";
import {
  activateTab,
  activeTab,
  closeAllTabs,
  closePane,
  focusPane,
  openTab,
  paneById,
  PRIMARY_PANE,
  SECONDARY_PANE,
  splitRight,
  workspace,
} from "../src/workspace/workspace";
import { setPaneDerivation } from "../src/workspace/pane-derive";
import { surfaceForPane } from "../src/canvas/canvas-surface";
import { view } from "../src/view";
import { bufferWrites } from "../src/services/monaco-buffer";
import { shell } from "../src/shell";
import { resetZoom } from "../src/canvas/canvas-utils";
import type { Tab } from "../src/tabs/tab";
import type { JxMutableNode } from "@jxsuite/schema/types";

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
    <div id="pane-grid"></div>
    <div id="activity-bar"></div>
    <div id="left-panel"></div>
    <div id="resize-left" class="resize-handle"></div>
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
let shortcutsGet: ((surface: unknown) => any) | null = null;
let shortcutHooks: Record<string, unknown> | null = null;

const statusMessages: string[] = [];
/** Records WHICH pane each render was scheduled for — the effects are per-pane now. */
const scheduleCanvasRenderMock = mock((_paneId?: string) => {});
const renderCanvasMock = mock(() => {});
let consumePatchedReturn = false;
const consumePatchedMock = mock((_doc: object, _paneId?: string) => consumePatchedReturn);
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

void mock.module("../src/panels/statusbar.ts", () => ({
  forgetSavedTimes: mock(() => {}),
  mountStatusbar: mock(() => {}),
  noteDocumentSaved: mock(() => {}),
  renderStatusbar: renderStatusbarMock,
  unmountStatusbar: mock(() => {}),
}));

/** Every notification, with its severity and options — the keyed ones need more than a string. */
const notifyCalls: NotifyCall[] = [];
void mock.module("../src/services/notify.ts", () =>
  notifyModule((call) => {
    notifyCalls.push(call);
    statusMessages.push(call.message);
  }),
);

/** Calls the `view.openInBrowser` hook forwards to the toolbar's own implementation. */
const openInBrowserRuns = mock(() => {});

void mock.module("../src/panels/toolbar.ts", () => ({
  mount: (_el: HTMLElement, ctx: unknown) => {
    toolbarCtx = ctx;
  },
  render: mock(() => {}),
  runOpenInBrowser: openInBrowserRuns,
  unmount: mock(() => {}),
}));

void mock.module("../src/panels/pane-context.ts", () => ({
  // The grid hands every cell its chrome host, so this is on the boot's import graph.
  attachPaneChromeHost: mock(() => {}),
  mount: (_el: HTMLElement, ctx: unknown) => {
    paneCtx = ctx;
  },
  render: mock(() => {}),
  // The bar's memo of a `$paths` enumeration is keyed on the project's file listing, so the boot
  // Drops it beside the other three derived caches when a watcher event lands.
  resetParamValues: mock(() => {}),
  unmount: mock(() => {}),
}));

void mock.module("../src/panels/welcome-screen.ts", () => ({
  initWelcome: (ctx: unknown) => {
    welcomeCtx = ctx;
  },
  renderWelcome: mock(() => {}),
}));

void mock.module("../src/editor/shortcuts.ts", () => ({
  // The registry is the first argument; the STAGE-context reader is the second — it takes a
  // Surface now, because a wheel belongs to the stage the pointer is over rather than to the
  // Focused pane.
  initShortcuts: (_registry: unknown, get: (surface: unknown) => unknown) => {
    shortcutsGet = get as (surface: unknown) => any;
  },
  // The grid installs one disposer per cell; the fixture only has to hand one back.
  installStageGestures: () => () => {},
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
/** The freeze notifier studio injects — the other half of the same injection. */
let collabNotifier: ((message: string) => void) | null = null;
void mock.module("../src/collab/collab-session.ts", () => ({
  ...collabSnapshot,
  configureCollabNotifier: (fn: ((message: string) => void) | null) => {
    collabNotifier = fn;
    collabSnapshot.configureCollabNotifier(fn as never);
  },
  configureCollabParser: (fn: CollabParserFn | null) => {
    collabParser = fn;
    collabSnapshot.configureCollabParser(fn as never);
  },
}));

// ─── Platform (must be registered before import so devserver PAL is skipped) ──

const CARD_DOC = JSON.stringify({ children: [], tagName: "my-card" });

/**
 * The backend watcher the bootstrap's `ensureFsSync()` subscribes to.
 *
 * Held here so a test can fire an event at the real subscription the boot installed, rather than
 * building a second one — `startFsSync` returns an inert no-op when the platform has no watcher,
 * and an inert subscription proves nothing about what the boot wired into it.
 */
let fsWatcher: ((events: { isDir: boolean; path: string; type: string }[]) => void) | null = null;

const { platform, state } = installMockPlatform(
  {
    subscribeFileEvents: ((handler: typeof fsWatcher) => {
      fsWatcher = handler;
      return () => {
        fsWatcher = null;
      };
    }) as never,
  },
  {
    "components/card.json": CARD_DOC,
    "components/empty.json": "",
    "pages/a.json": JSON.stringify({ children: [], tagName: "main" }),
    "project.json": JSON.stringify({ name: "Recent Project" }),
  },
);

await import("../src/studio");
const { renderLayoutPickerRow } = await import("../src/panels/head-panel");

await flush();

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Whether `openRecentProject` has run to completion.
 *
 * It used to be `statusMessages.includes("Opened project: …")` — the project's NAME is permanent
 * state in the status bar's PROJECT field now, so the completion signal is the state itself.
 */
function recentProjectOpened(): boolean {
  return projectState?.name === "Recent Project";
}

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

/** Two multi-mode tabs, so a `splitRight()` puts one in each pane. `[primary, secondary]`. */
function openTwoShellTabs(): [Tab, Tab] {
  const modes = ["edit", "design", "source", "git-diff"];
  const home = openShellTab(undefined, { capabilities: { modes } });
  const away = openTab({
    capabilities: { modes },
    document: { children: [{ tagName: "p", textContent: "Away" }], tagName: "div" },
    documentPath: "pages/away.json",
    id: "shell-tab-away",
  });
  return [home, away];
}

beforeEach(() => {
  closeAllTabs();
  resetStudioState();
  statusMessages.length = 0;
  scheduleCanvasRenderMock.mockClear();
  consumePatchedMock.mockClear();
  consumePatchedReturn = false;
  view.functionEditor = null;
  surfaceForPane("primary").panX = 0;
  surfaceForPane("primary").panY = 0;
  surfaceForPane("primary").needsCenter = true;
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

  test("setCanvasMode writes through to the tab it is GIVEN", () => {
    const tab = openShellTab();
    toolbarCtx.setCanvasMode(tab, "code");
    expect(tab.session.ui.canvasMode).toBe("code");
    expect(toolbarCtx.getCanvasMode()).toBe("code");
  });

  test("setCanvasMode writes the UNFOCUSED pane's tab when that is the tab it is handed", () => {
    /* The signature IS the fix. It used to take only a mode and open with `activeTab.value`, so
       every caller wrote whichever pane had focus — and the pane context bar, drawn once per pane
       from `tabOfPane(paneId)`, is a caller. Clicking "Code" in the SIDE pane's Editor picker moved
       the PRIMARY's document into the Code editor and left the side pane drawing Design. */
    const [home, away] = openTwoShellTabs();
    splitRight();
    expect(workspace.activePaneId).toBe(SECONDARY_PANE);
    expect(paneById(SECONDARY_PANE)!.activeTabId).toBe(away.id);

    // The tab in the pane the keyboard is NOT in.
    toolbarCtx.setCanvasMode(home, "source");

    expect(home.session.ui.canvasMode).toBe("source");
    expect(away.session.ui.canvasMode).not.toBe("source");
    // And the focused pane's own read is untouched — the two answers are allowed to differ now.
    expect(toolbarCtx.getCanvasMode()).toBe(away.session.ui.canvasMode);
  });

  test("setCanvasMode is a no-op without a tab", () => {
    expect(() => toolbarCtx.setCanvasMode(null, "code")).not.toThrow();
  });

  test("leaving git-diff mode clears gitDiffState", () => {
    const tab = openShellTab();
    toolbarCtx.setCanvasMode(tab, "git-diff");
    canvasRenderCtx.setGitDiffState({ path: "a.json" });
    expect(canvasRenderCtx.gitDiffState).toEqual({ path: "a.json" });
    toolbarCtx.setCanvasMode(tab, "design");
    expect(canvasRenderCtx.gitDiffState).toBeNull();
  });

  test("the git-diff check reads the TAB being moved, not the focused pane", () => {
    /* `if (getCanvasMode() === "git-diff")` asked the focused pane. So moving the PRIMARY's tab out
       of some other mode, while the side pane sat in git-diff, threw away the diff the side pane
       was still drawing — and moving the side pane's tab out of git-diff while the primary was in
       Design left `shell.git.diffState` alive with nothing showing it. */
    const [home, away] = openTwoShellTabs();
    splitRight();
    toolbarCtx.setCanvasMode(away, "git-diff");
    canvasRenderCtx.setGitDiffState({ path: "side.json" });

    // The PRIMARY's tab moves. It was never in git-diff, so the side pane's diff must survive.
    toolbarCtx.setCanvasMode(home, "design");
    expect(canvasRenderCtx.gitDiffState).toEqual({ path: "side.json" });

    // The tab that IS in git-diff moving out of it is what clears it.
    toolbarCtx.setCanvasMode(away, "design");
    expect(canvasRenderCtx.gitDiffState).toBeNull();
  });

  /*
   * The cap on the side pane is a fact about a PANE, so the writer asks it too. Enforced only at
   * the split, it was one context-bar click from being undone: a tab moved into the side pane could
   * be switched straight back to Design, putting a second live Canvas host in the pane the cap
   * exists to keep cheap.
   */
  test("setCanvasMode does not care WHICH pane the tab is in — the kind cap is lifted", () => {
    /* This used to be a refusal. `splitRight` capped the tab to Code on its way across and
       `setCanvasMode` refused Design back, because the side pane hosted only the cheap editor
       kinds. Both halves are deleted: `panels/pane-grid.ts` draws a live stage per pane, so the
       mode a document declares is the whole answer wherever the document is. */
    const tab = openShellTab(undefined, { capabilities: { modes: ["edit", "design", "source"] } });
    const before = tab.session.ui.canvasMode;
    splitRight();
    expect(workspace.activePaneId).toBe(SECONDARY_PANE);
    // The split moved it AS IT WAS — no rewrite of the mode on the way over.
    expect(tab.session.ui.canvasMode).toBe(before);
    toolbarCtx.setCanvasMode(tab, "design");
    expect(tab.session.ui.canvasMode).toBe("design");
    // And the same call still goes through back in the primary.
    closePane(SECONDARY_PANE);
    toolbarCtx.setCanvasMode(tab, "source");
    expect(tab.session.ui.canvasMode).toBe("source");
  });

  test("entering git-diff mode preserves gitDiffState", () => {
    const tab = openShellTab();
    canvasRenderCtx.setGitDiffState({ path: "b.json" });
    toolbarCtx.setCanvasMode(tab, "git-diff");
    expect(canvasRenderCtx.gitDiffState).toEqual({ path: "b.json" });
    canvasRenderCtx.setGitDiffState(null);
  });
});

/* The background-click deselect is no longer the bootstrap's, so it is no longer tested here.
   It compared against the app's one `#canvas-wrap` and one `view.panzoomWrap` and cleared
   `activeTab`'s selection — three reads that all name the FOCUSED pane rather than the pane that
   was clicked. It is a stage gesture, installed per cell by `editor/shortcuts.ts`'s
   `installStageGestures`, and `tests/shortcuts.test.ts` owns it. */

/* There is no "the single stage follows the focused pane" block, because the stage no longer
   follows anything. It proved that `studio.ts` re-answered "which pane owns `#canvas-wrap`" on
   every focus move — the workaround for a shell with one stage and a model with two panes.
   `panels/pane-grid.ts` builds a cell per pane and registers its stage as part of building it, so
   the question has a static answer and `tests/pane-grid.test.ts` is where it is asked. */

describe("navigateToComponent", () => {
  test("opens the component BESIDE the page, as a preview tab, without taking the keyboard", async () => {
    const parent = openShellTab();
    parent.session.selection = [["children", 0]];
    await blockBarCtx.navigateToComponent("components/card.json");

    // The parent is still open, still on its own document, still holding its selection.
    expect(parent.documentPath).toBe("pages/current.json");
    expect(parent.session.selection).toEqual([["children", 0]]);

    /* TO THE SIDE. §8.2 has promised this since P3 and the chain `openFileInTab → openTab →
       activePane()` opened it in place instead — over the page it is teaching about. */
    expect(workspace.panes.map((pane) => pane.tabOrder)).toEqual([
      ["shell-tab"],
      ["components/card.json"],
    ]);
    const side = workspace.panes[1]!;
    expect(side.activeTabId).toBe("components/card.json");

    /* AND THE FOCUS DOES NOT FOLLOW. An assistant pane that takes the keyboard means the author's
       next keystroke edits the definition instead of the page — and a following pane would
       immediately have nothing to follow. */
    expect(workspace.activePaneId).toBe(PRIMARY_PANE);
    expect(workspace.activeTabId).toBe("shell-tab");

    const child = workspace.tabs.get("components/card.json")!;
    expect(child.documentPath).toBe("components/card.json");
    // A PREVIEW tab: drilling in is browsing, so the second drill-in takes the same slot.
    expect(child.preview).toBe(true);
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

  test("drilling into an already-open component leaves it exactly where it is", async () => {
    openShellTab();
    await blockBarCtx.navigateToComponent("components/card.json");
    const child = workspace.tabs.get("components/card.json")!;
    activateTab("shell-tab");
    await blockBarCtx.navigateToComponent("components/card.json");
    // Still one tab, still one copy of the id, still in the side pane — and the keyboard is still
    // In the page. This is `openFileInTab`'s third dedupe branch: the tab IS its pane's active tab,
    // So there is nothing to do and moving it would only oscillate.
    expect(workspace.tabs.get("components/card.json")).toBe(child);
    expect(workspace.panes[1]!.tabOrder).toEqual(["components/card.json"]);
    expect(workspace.activePaneId).toBe(PRIMARY_PANE);
  });

  /* {@link receivingPane}, not `sidePane`. "Edit definition" is an ordinary tab, and the pane
     beside this one may be a LENS — which owns no tab by invariant D2, so the open landed in a
     `tabOrder` that `tabOfPane` hops straight past. The read-back below then got the SOURCE tab,
     `opened.documentPath !== componentPath`, and the one relationship this function exists to
     record (§14.2) was skipped without a sound; `applyDerivation` handed the tab back on its next
     frame, so the definition ended up behind the page in the primary's strip. Both halves are
     asserted, because the tab moving is what makes the missing `openedFrom` invisible. */
  test("drilling in RELEASES a lens beside the page, so the definition lands in a real pane", async () => {
    const parent = openShellTab();
    openTab({ document: { tagName: "div" }, documentPath: "pages/side.json", id: "side-tab" });
    splitRight();
    focusPane(PRIMARY_PANE);
    setPaneDerivation(SECONDARY_PANE, {
      diff: null,
      kind: "lens",
      media: null,
      mode: "source",
      preset: "code",
      reason: "",
      sourcePaneId: PRIMARY_PANE,
      status: "ready",
      zoom: 1,
    });

    await blockBarCtx.navigateToComponent("components/card.json");

    // The projection is over, and the pane it was borrowing owns the definition.
    expect(paneById(SECONDARY_PANE)!.derived).toBeNull();
    expect(paneById(SECONDARY_PANE)!.tabOrder).toContain("components/card.json");
    // …and §14.2's relationship was recorded, which is the half a lens made unobservable.
    expect(workspace.tabs.get("components/card.json")!.session.openedFrom).toEqual({
      documentPath: parent.documentPath,
      tabId: "shell-tab",
    });
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
    expect(statusMessages.at(-1)).toStartWith("Could not open");
  });

  test("still opens the component when no tab was open to drill from", async () => {
    closeAllTabs();
    await blockBarCtx.navigateToComponent("components/card.json");
    const child = workspace.tabs.get("components/card.json")!;
    expect(child).toBeDefined();
    expect(child.session.openedFrom).toBeNull();
  });
});

/* There is no `navigateBack` / `navigateToLevel` suite here any more.
   Both callbacks, and the Save/Discard/Cancel prompt they shared, existed to pop
   `session.documentStack` — a stack nothing in `src/` could push onto, so every case below drove
   a frame the app itself could never have produced. Leaving a drilled-in document is closing a
   tab now, and `tab-strip` owns that prompt. See `tabs/tab.ts`. */

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

  /* EACH PANE ASKS ABOUT ITSELF. The mark a surgical patch leaves is a `Set` of pane ids, and this
     effect is installed once per pane — so a hard-coded id makes the side pane's doc-effect consume
     the primary's mark: one pane skips a full render it owed, the other repeats one it did not, and
     `skippedFullRenders` reports the same number either way. The argument IS the behaviour, and
     `canvas-patcher.ts` is mocked here, so the argument is exactly what this can see. */
  test("each pane's doc-effect consumes ITS OWN patch mark", async () => {
    openShellTab();
    openTab({ document: { tagName: "div" }, documentPath: "pages/side.json", id: "side-tab" });
    await flush();
    splitRight();
    await flush();
    consumePatchedReturn = false;
    consumePatchedMock.mockClear();

    // One document root replaced in each pane, so both doc-effects run.
    paneById(PRIMARY_PANE)!.activeTabId = "shell-tab";
    workspace.tabs.get("shell-tab")!.doc.document = { children: [], tagName: "b" } as never;
    workspace.tabs.get("side-tab")!.doc.document = { children: [], tagName: "i" } as never;
    await flush();

    const asked = consumePatchedMock.mock.calls.map(([, paneId]) => paneId);
    expect(new Set(asked)).toEqual(new Set([PRIMARY_PANE, SECONDARY_PANE]));
  });

  /* A LENS'S MODE AND MEDIA live on the derivation rather than on the tab, so the fifteen
     `tab.session.ui.*` reads beside them see neither. Re-deriving a pane at another breakpoint
     writes exactly these two fields and nothing else reactive that this pane draws — untracked, the
     stage goes on drawing the artboard the lens was created with under a chip naming another. */
  test("changing only a lens's mode and media repaints that pane", async () => {
    openShellTab();
    openTab({ document: { tagName: "div" }, documentPath: "pages/side.json", id: "side-tab" });
    await flush();
    splitRight();
    await flush();
    paneById(SECONDARY_PANE)!.derived = {
      diff: null,
      kind: "lens",
      media: null,
      mode: "design",
      preset: "breakpoint",
      reason: "",
      sourcePaneId: PRIMARY_PANE,
      status: "ready",
      zoom: 1,
    };
    await flush();
    scheduleCanvasRenderMock.mockClear();

    const lens = paneById(SECONDARY_PANE)!.derived as { media: string | null };
    lens.media = "tablet";
    await flush();

    expect(scheduleCanvasRenderMock.mock.calls.map(([paneId]) => paneId)).toContain(SECONDARY_PANE);
    paneById(SECONDARY_PANE)!.derived = null;
  });

  test("UI flag changes always schedule a render", async () => {
    openShellTab();
    await flush();
    scheduleCanvasRenderMock.mockClear();
    shell.settingsTab = "fonts";
    expect(scheduleCanvasRenderMock).toHaveBeenCalled();
  });

  /*
   * The effects are keyed on the PANE, and this is the bug that proves why.
   *
   * Both used to read `activeTab` and schedule "the" canvas. A split moves a tab between panes
   * without changing which tab is active, so neither effect re-ran: the pane the tab LEFT went on
   * displaying it, and the pane it arrived in — which had no stage at all until the grid drew one —
   * was never asked to paint. Unsplit was the same shape from the other side: `closePane` changes
   * the survivor's `activeTabId` and leaves `activeTab` identical, so split → open B in the side
   * pane → unsplit left the primary showing A while the strip, the jump bar and the Inspector all
   * said B.
   */
  test("a split schedules BOTH panes — the one that lost the tab and the one that gained it", async () => {
    openShellTab();
    openTab({ document: { tagName: "div" }, documentPath: "pages/side.json", id: "side-tab" });
    await flush();
    scheduleCanvasRenderMock.mockClear();

    splitRight();
    await flush();

    const panes = scheduleCanvasRenderMock.mock.calls.map(([paneId]) => paneId);
    expect(panes).toContain(PRIMARY_PANE);
    expect(panes).toContain(SECONDARY_PANE);
  });

  /* A derived pane's SENTENCE is a render input, because the stage prints it.
     `canvas/canvas-render.ts` draws `derived.reason` for an unavailable derivation, and `status`
     alone does not move when the reason does: a diff lens whose comparison could not be read, whose
     file the author then saves back to HEAD, stays `unavailable` while the sentence becomes
     "Nothing to compare". The pane context bar tracked `reason` from the start; the CANVAS effect
     did not, because until this phase nothing on a stage read it. */
  test("changing only a derivation's reason repaints that pane", async () => {
    openShellTab();
    openTab({ document: { tagName: "div" }, documentPath: "pages/side.json", id: "side-tab" });
    await flush();
    splitRight();
    await flush();
    paneById(SECONDARY_PANE)!.derived = {
      diff: null,
      kind: "lens",
      media: null,
      mode: "design",
      preset: "breakpoint",
      reason: "Nothing to compare — this file matches HEAD.",
      sourcePaneId: PRIMARY_PANE,
      status: "unavailable",
      zoom: 1,
    };
    await flush();
    scheduleCanvasRenderMock.mockClear();

    paneById(SECONDARY_PANE)!.derived!.reason =
      "Could not read this file's comparison against HEAD.";
    await flush();

    expect(scheduleCanvasRenderMock.mock.calls.map(([paneId]) => paneId)).toContain(SECONDARY_PANE);
    paneById(SECONDARY_PANE)!.derived = null;
  });

  /* …AND ITS STATUS, which is the sibling one line up and the one that decides WHICH branch of
     `renderCanvasImpl` runs at all. `reason` picks the words; `status` picks between the notice and
     the stage. A diff lens whose comparison lands goes `loading` → `ready` with no other reactive
     write anywhere near this pane — the comparison lives on `derived.diff`, the tab did not move,
     the mode did not move — so untracked, the pane goes on drawing "Loading this file's changes…"
     over a comparison it is already holding until something unrelated repaints it. */
  test("changing only a derivation's status repaints that pane", async () => {
    openShellTab();
    openTab({ document: { tagName: "div" }, documentPath: "pages/side.json", id: "side-tab" });
    await flush();
    splitRight();
    await flush();
    paneById(SECONDARY_PANE)!.derived = {
      diff: null,
      kind: "lens",
      media: null,
      mode: "git-diff",
      preset: "diff",
      reason: "",
      sourcePaneId: PRIMARY_PANE,
      status: "loading",
      zoom: 1,
    };
    await flush();
    scheduleCanvasRenderMock.mockClear();

    paneById(SECONDARY_PANE)!.derived!.status = "ready";
    await flush();

    expect(scheduleCanvasRenderMock.mock.calls.map(([paneId]) => paneId)).toContain(SECONDARY_PANE);
    paneById(SECONDARY_PANE)!.derived = null;
  });

  /* THE FOLLOW IS ACTUALLY INSTALLED, AND ITS READER IS ACTUALLY THE GIT ONE. Two lines of this
     file's own wiring — `installDerivationEffects(paneId, derivationDeps)` inside
     `installPaneRenderEffects`, and `loadDiff: loadDiffForLens` in the dependency set — and until
     this test only `reachability.test.ts` could see either: delete the first and the whole §18.4
     follow stops running, delete the second and a Diff lens asks a stub that always answers `null`.
     `pane-derive.test.ts` proves the follow WORKS when something installs it and hands it a reader;
     nothing proved the shell does. Both halves die here, and the assertion is the one an author
     would make — a Diff lens on a changed file ends up holding that file's comparison.

     Everything below the derivation is real: no mock of `panels/git-panel.ts`, so `loadDiffForLens`
     runs `gitShow(HEAD)` and `readFile` against the mock platform, and `pages/a.json` is a file it
     actually has. */
  test("the shell installs the follow, and a Diff lens loads its own comparison through it", async () => {
    closeAllTabs();
    const modes = ["edit", "design", "source", "git-diff"];
    openTab({
      capabilities: { modes },
      document: { children: [], tagName: "main" },
      documentPath: "pages/a.json",
      id: "pages/a.json",
    });
    openTab({
      capabilities: { modes },
      document: { tagName: "div" },
      documentPath: "pages/side.json",
      id: "side-tab",
    });
    await flush();
    splitRight();
    await flush();
    focusPane(PRIMARY_PANE);
    shell.git.status = {
      ahead: 0,
      behind: 0,
      branch: "main",
      files: [{ path: "pages/a.json", status: "M" }],
      isRepo: true,
      remotes: [],
    } as never;
    try {
      setPaneDerivation(SECONDARY_PANE, {
        diff: null,
        kind: "lens",
        media: null,
        mode: "git-diff",
        preset: "diff",
        reason: "",
        sourcePaneId: PRIMARY_PANE,
        status: "loading",
        zoom: 1,
      });

      const lens = () =>
        paneById(SECONDARY_PANE)?.derived as {
          diff: { filePath: string } | null;
          status: string;
        } | null;
      // Nothing was driven by hand: the rAF the follow schedules is the only thing that runs.
      await waitFor(() => lens()?.diff != null);

      expect(lens()?.diff?.filePath).toBe("pages/a.json");
      expect(lens()?.status).toBe("ready");
    } finally {
      const side = paneById(SECONDARY_PANE);
      if (side) {
        side.derived = null;
      }
      shell.git.status = null;
    }
  });

  test("unsplit repaints the survivor, whose active tab changed under an unchanged `activeTab`", async () => {
    openShellTab();
    openTab({ document: { tagName: "div" }, documentPath: "pages/side.json", id: "side-tab" });
    await flush();
    splitRight();
    await flush();
    // The keyboard is in the side pane, showing "side-tab"; the primary still holds "shell-tab".
    expect(workspace.activePaneId).toBe(SECONDARY_PANE);
    expect(paneById(PRIMARY_PANE)!.activeTabId).toBe("shell-tab");
    const before = activeTab.value;
    scheduleCanvasRenderMock.mockClear();

    closePane(SECONDARY_PANE);
    await flush();

    // `activeTab` did NOT move — which is exactly why the old effects stayed silent.
    expect(activeTab.value).toBe(before);
    expect(paneById(PRIMARY_PANE)!.activeTabId).toBe("side-tab");
    expect(scheduleCanvasRenderMock.mock.calls.map(([paneId]) => paneId)).toContain(PRIMARY_PANE);
  });
});

describe("openRecentProject", () => {
  test("loads project.json, rebuilds project state, and opens the project", async () => {
    await toolbarCtx.openRecentProject("/recent/site");
    expect(platform.projectRoot).toBe("/recent/site");
    expect(shell.leftTab).toBe("files");
    expect(statusMessages).toHaveLength(0);
  });

  test("the whole open is ONE Activity entry with steps, not three surfaces", async () => {
    // Opening a project used to chain a blocking spinner (dependencies), a transient status line
    // (git sync) and a confirm-plus-spinner (@jxsuite update): three surfaces for three phases of
    // One operation, none of them cancellable, none surviving the frame they were drawn in. Spec
    // Studio.md §16.4.
    const { activities, resetActivities } = await import("../src/panels/activity-panel");
    resetActivities();
    await toolbarCtx.openRecentProject("/recent/site");

    expect(activities).toHaveLength(1);
    const entry = activities[0]!;
    expect(entry.title).toBe("Opening site");
    expect(entry.source).toBe("Open Project");
    expect(entry.state).toBe("done");
    expect(entry.steps.map((step) => step.label)).toEqual([
      "Sync with the remote",
      "Install dependencies",
      "Read the project",
      "Open the home page",
    ]);
    // Every step ran, so none is left claiming to be in flight after the entry finished.
    expect(entry.steps.every((step) => step.state === "done")).toBe(true);
  });

  test("a failed open raises ONE Problem — the entry reports, the catch does not also notify", async () => {
    const { activities, resetActivities } = await import("../src/panels/activity-panel");
    resetActivities();
    const originalRead = platform.readFile;
    platform.readFile = (async () => {
      throw new Error("project.json is not there");
    }) as never;
    try {
      await toolbarCtx.openRecentProject("/gone/site");
    } finally {
      platform.readFile = originalRead;
    }

    expect(activities[0]?.state).toBe("failed");
    // ONE notification, not two: `fail()` raises the Problem, so the catch does not also call
    // `notify.error` — §13.3 rule 3. The success cases above assert the other half, zero.
    expect(statusMessages).toEqual(["Could not open the project at /gone/site."]);
    // The reason is on the entry's log, which `fail()` hands to the Problem as its detail.
    expect(activities[0]?.log.join("\n")).toContain("project.json is not there");
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
    expect(statusMessages).toHaveLength(0);
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
    expect(statusMessages.at(-1)).toStartWith("Could not open");
  });

  /**
   * THE PROJECT SWITCH WAS THE LAST EXIT WITH NO GATE, and it is the one that takes everything.
   *
   * `closeAllTabs()` disposes every open document with no prompt anywhere on the path — ⌘W, the tab
   * ×, quitting and the preview slot's replacement each acquired one over eight rounds, and the
   * gesture that throws away the whole workspace at once never had one.
   *
   * The prompt is asked BEFORE the switch begins, because everything the switch does is one-way:
   * `setWindowProject` binds this window's backend to the new root and `platform.projectRoot` moves
   * the base every relative path resolves against. A prompt after either of those can be answered
   * "keep editing" and leave the app pointing at a project it is not showing.
   */
  describe("unsaved documents", () => {
    function dialog(): HTMLElement | null {
      return document.querySelector("#layer-dialog sp-dialog-wrapper");
    }

    test("Cancel abandons the switch with the workspace untouched", async () => {
      const root = platform.projectRoot;
      const readsBefore = state.calls.filter((c) => c[0] === "readFile").length;
      const tab = openShellTab();
      tab.doc.dirty = true;
      const opening = toolbarCtx.openRecentProject("/recent/site");
      await flush(4);

      const el = dialog()!;
      expect(el).not.toBeNull();
      expect(el.textContent).toContain("Opening another project closes every open document");
      el.dispatchEvent(new Event("cancel"));
      await opening;

      // Nothing moved: not the root, not the tab, not the document.
      expect(platform.projectRoot).toBe(root);
      expect(workspace.tabs.has("shell-tab")).toBe(true);
      expect(tab.doc.dirty).toBe(true);
      expect(state.calls.filter((c) => c[0] === "readFile")).toHaveLength(readsBefore);
    });

    test("Close Without Saving lets the switch proceed", async () => {
      const tab = openShellTab();
      tab.doc.dirty = true;
      const opening = toolbarCtx.openRecentProject("/recent/site");
      await flush(4);
      dialog()!.dispatchEvent(new Event("secondary"));
      await opening;

      expect(platform.projectRoot).toBe("/recent/site");
      expect(workspace.tabs.has("shell-tab")).toBe(false);
    });

    test("a clean workspace is switched with no prompt at all", async () => {
      openShellTab();
      await toolbarCtx.openRecentProject("/recent/site");
      expect(dialog()).toBeNull();
      expect(platform.projectRoot).toBe("/recent/site");
    });

    /*
     * The directory picker is a SECOND destroyer, and it was ungated for as long as the first was.
     * `openRecentProject` asks and then calls `closeAllTabs`; this branch reaches `files.ts`'s
     * `replaceAllTabs`, which throws the same documents away under a different name — so an
     * enumeration of "who calls closeAllTabs" reported the matrix complete while ⌘O, the toolbar
     * button and the welcome screen all discarded unsaved work in silence. `platformUsesRepoPicker`
     * is true only for the cloud platform, so desktop and browser both arrived here.
     */
    test("Open Project… asks too, and Cancel never reaches the platform", async () => {
      const before = state.calls.filter((c) => c[0] === "openProject").length;
      const tab = openShellTab();
      tab.doc.dirty = true;
      const opening = toolbarCtx.openProject();
      await flush(4);

      const el = dialog()!;
      expect(el).not.toBeNull();
      expect(el.textContent).toContain("Opening another project closes every open document");
      el.dispatchEvent(new Event("cancel"));
      await opening;

      // The picker is never even shown: the question comes before the gesture that destroys.
      expect(state.calls.filter((c) => c[0] === "openProject")).toHaveLength(before);
      expect(workspace.tabs.has("shell-tab")).toBe(true);
      expect(tab.doc.dirty).toBe(true);
    });

    test("Open Project… proceeds to the picker once the answer allows it", async () => {
      const before = state.calls.filter((c) => c[0] === "openProject").length;
      const tab = openShellTab();
      tab.doc.dirty = true;
      const opening = toolbarCtx.openProject();
      await flush(4);
      dialog()!.dispatchEvent(new Event("secondary"));
      await opening;

      expect(state.calls.filter((c) => c[0] === "openProject")).toHaveLength(before + 1);
    });
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
      await waitFor(() => recentProjectOpened());
    } finally {
      pickerEnabled = false;
      pickerResult = null;
    }
    expect(state.calls.filter((c) => c[0] === "openProject")).toHaveLength(before);
    expect(platform.projectRoot).toBe("/picked/repo");
    expect(statusMessages).toHaveLength(0);
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
      await waitFor(() => recentProjectOpened());
    } finally {
      newProjectResult = null;
    }
    expect(platform.projectRoot).toBe("/new/site");
    expect(statusMessages).toHaveLength(0);
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
      await waitFor(() => recentProjectOpened());
    } finally {
      addRepoResult = null;
    }
    expect(platform.projectRoot).toBe("/added/repo");
    expect(statusMessages).toHaveLength(0);
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
    const tab = openShellTab();
    toolbarCtx.setCanvasMode(tab, "content");
    expect(blockBarCtx.getCanvasMode()).toBe("content");
  });
});

describe("shortcuts context", () => {
  test("exposes live canvas state and pan setter, for the STAGE it was asked about", () => {
    const tab = openShellTab();
    toolbarCtx.setCanvasMode(tab, "design");
    // The reader takes a surface: the pan offsets and the mode it reports are that pane's, not
    // Whichever pane the keyboard happens to be in.
    const ctx = shortcutsGet!(surfaceForPane("primary"));
    expect(ctx.canvasMode).toBe("design");
    expect(typeof ctx.applyTransform).toBe("function");
    ctx.setPan(12, 34);
    expect(surfaceForPane("primary").panX).toBe(12);
    expect(surfaceForPane("primary").panY).toBe(34);
    expect(surfaceForPane("primary").needsCenter).toBe(false);
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

  test("Open in Browser runs the toolbar's implementation, not a second copy of it", () => {
    // The bootstrap must DELEGATE. An inline `window.open(target.url)` here would look identical
    // In this suite and be wrong on the desktop, where `runOpenInBrowser` routes through the
    // Launcher's preview-navigate seam to the OS browser instead of a webview with no address bar.
    // Resolving the target and reporting the blocking reason are the toolbar's, and are tested in
    // `toolbar.test.ts` against the real module.
    openInBrowserRuns.mockClear();

    (shortcutHooks!.openInBrowser as () => void)();

    expect(openInBrowserRuns).toHaveBeenCalledTimes(1);
  });
});

describe("filesystem events drop the derived caches", () => {
  test("a watcher event makes the layout picker re-read layouts/ from disk", async () => {
    // Three caches are keyed on WHICH FILES EXIST — the page-route list behind the Link-target
    // Picker, the layout picker plus the effective layout's `$head`, and the `$paths` value
    // Enumerations. Each had an invalidator and no caller, so a layout deleted outside Studio kept
    // Being offered and its `$head` kept being attributed to the open page.
    //
    // Asserted through the platform call log rather than the module-private cache: what matters is
    // That the next paint goes back to DISK, which is the thing the stale answer prevented.
    expect(fsWatcher, "the boot must subscribe to the backend watcher").not.toBeNull();
    state.files.set("layouts/base.json", JSON.stringify({ tagName: "html" }));

    const doc = { tagName: "main" } as unknown as JxMutableNode;
    const apply = () => {};
    // First paint populates the cache; the second is served from it.
    renderLayoutPickerRow(doc, apply);
    await waitFor(() => state.calls.some((c) => c[0] === "listDirectory" && c[1] === "layouts"));
    const afterFirst = state.calls.filter(
      (c) => c[0] === "listDirectory" && c[1] === "layouts",
    ).length;
    renderLayoutPickerRow(doc, apply);
    await flush();
    expect(state.calls.filter((c) => c[0] === "listDirectory" && c[1] === "layouts")).toHaveLength(
      afterFirst,
    );

    // A file appears on disk. The next paint must go back and look.
    fsWatcher!([{ isDir: false, path: "layouts/marketing.json", type: "add" }]);
    renderLayoutPickerRow(doc, apply);
    await waitFor(
      () =>
        state.calls.filter((c) => c[0] === "listDirectory" && c[1] === "layouts").length >
        afterFirst,
    );
    expect(
      state.calls.filter((c) => c[0] === "listDirectory" && c[1] === "layouts").length,
    ).toBeGreaterThan(afterFirst);
  });
});

describe("zoom wiring", () => {
  test("setZoomDirect writes the zoom to the active tab session", () => {
    const tab = openShellTab();
    tab.session.ui.zoom = 2.5;
    const wrap = document.createElement("div");
    surfaceForPane("primary").wrap.append(wrap);
    surfaceForPane("primary").panzoomWrap = wrap;
    try {
      resetZoom();
      expect(tab.session.ui.zoom).toBe(1);
    } finally {
      surfaceForPane("primary").panzoomWrap = null;
      wrap.remove();
    }
  });

  test("setZoomDirect is a no-op without an active tab", () => {
    closeAllTabs();
    const wrap = document.createElement("div");
    surfaceForPane("primary").panzoomWrap = wrap;
    try {
      expect(() => resetZoom()).not.toThrow();
    } finally {
      surfaceForPane("primary").panzoomWrap = null;
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

  /**
   * Quitting is the one exit no disposer follows, and `dirty` could not see a Monaco buffer.
   *
   * The last 500ms (dock) / 600ms (source) of typing lives in an armed commit the document has not
   * received, so ⌘Q left with no prompt at all. There is nothing to flush here — `beforeunload`
   * cannot await, and the source commit parses through the format host before it assigns — so the
   * gate asks the buffer instead.
   */
  test("and while a buffer holds typing the document has not been given", () => {
    const tab = openShellTab();
    tab.doc.dirty = false;
    const buffer = {
      _editingTab: tab,
      getModel: () => ({}),
      getValue: () => "typed();",
      hasTextFocus: () => false,
    };
    const writes = bufferWrites(buffer);
    writes.markTyped();
    view.functionEditor = buffer as never;
    try {
      const typed = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(typed);
      expect(typed.defaultPrevented).toBe(true);

      // The commit lands: the document has the text, and the buffer says so. Nothing to warn about
      // Beyond the ordinary dirty flag, which this tab does not have.
      writes.markSettled();
      const settled = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(settled);
      expect(settled.defaultPrevented).toBe(false);

      // And format-on-open — ahead, never committed, nothing an author loses — is not a prompt.
      writes.markAhead();
      const formatted = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(formatted);
      expect(formatted.defaultPrevented).toBe(false);
    } finally {
      view.functionEditor = null;
    }
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
    expect(statusMessages.at(-1)).toBe("Cloning is not supported on this platform.");
    statusMessages.length = 0;
    await welcomeCtx.cloneRepository();
    expect(statusMessages.at(-1)).toBe("Cloning is not supported on this platform.");
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

  test("the freeze notifier is a KEYED warning, not a stack of identical toasts", () => {
    /* A source-canonical freeze is a STATE the author is being held in, not an error, and a run of
       them is one message. The bootstrap is the only place that decides that — `collab-session.ts`
       hands it a string and knows nothing about toasts — so the injection is what has to be
       checked, not the sentence. */
    expect(collabNotifier).not.toBeNull();
    statusMessages.length = 0;
    collabNotifier!("Source is canonical while the file is open in Code view.");
    expect(statusMessages.at(-1)).toBe("Source is canonical while the file is open in Code view.");
    expect(notifyCalls.at(-1)).toMatchObject({
      options: { key: "collab.freeze", source: "Collaboration" },
      severity: "warn",
    });
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
      expect(statusMessages).toHaveLength(0);
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

  test("welcome openRecentProject opens the project directly", async () => {
    await welcomeCtx.openRecentProject("/recent/site");
    expect(statusMessages).toHaveLength(0);
  });

  test("the bootstrap paints the statusbar once, directly", () => {
    // `setStatusbarRenderer` is gone with `statusMessage`: it existed only so a transient message
    // Could ask the bar to repaint. The bar's own effect owns that now.
    expect(renderStatusbarMock).toHaveBeenCalled();
  });

  test("an upload refreshes all three caches that list project files", async () => {
    // Every upload surface funnels through uploadAssets, and the three caches it has to invalidate
    // Live in modules that all import media-upload — so the bootstrap injects the refresher rather
    // Than media-upload importing them back. This is the only place that closure is exercised.
    const { uploadAssets } = await import("../src/files/media-upload");
    // The refresher re-reads a directory into `projectState.dirs`, so a project has to be open —
    // Which is the real precondition too: there is nowhere to upload to without one.
    await welcomeCtx.openRecentProject("/recent/site");
    await waitFor(recentProjectOpened);
    const before = state.calls.filter((c) => c[0] === "listDirectory").length;

    const uploaded = await uploadAssets([
      new File([new Uint8Array([1, 2, 3])], "hero.png", { type: "image/png" }),
    ]);

    expect(uploaded).toHaveLength(1);
    expect(state.calls.some((c) => c[0] === "uploadFile")).toBe(true);
    // The handler re-reads the upload directory after the write — one more listDirectory than the
    // Pre-flight name check alone would make.
    expect(state.calls.filter((c) => c[0] === "listDirectory").length).toBeGreaterThan(before + 1);
  });
});
