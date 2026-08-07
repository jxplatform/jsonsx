/**
 * Studio shell boot gaps — booting with NO pre-registered platform (the dev-server PAL fallback),
 * the idle-time css-props datalist guard when the datalist is gone, and the files-tab left-panel
 * template wiring (renderFilesTemplate through renderOnly). Uses its own boot replica instead of
 * bootStudio because both gaps need control the fixture deliberately hides: a captured (not
 * auto-run) requestIdleCallback queue and an import with no platform installed.
 */
import { flush, installMockPlatform } from "./harness";
import { expect, mock, test } from "bun:test";
import { notifyModule } from "./notify-mock";
import { nothing } from "lit-html";
import { hasPlatform, getPlatform } from "../src/platform";
import { renderOnly, setProjectState } from "../src/store";
import { shell } from "../src/shell";

(globalThis as unknown as { happyDOM: { setURL: (u: string) => void } }).happyDOM.setURL(
  "http://localhost:3000/",
);

// Captured idle callbacks — NOT auto-run, so the test controls when the datalist filler fires.
const idleCallbacks: (() => void)[] = [];
(globalThis as Record<string, unknown>).requestIdleCallback = (cb: (d: unknown) => void) => {
  idleCallbacks.push(() => cb({ didTimeout: false, timeRemaining: () => 50 }));
  return idleCallbacks.length;
};
(globalThis as Record<string, unknown>).cancelIdleCallback = () => {};

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
(globalThis as Record<string, unknown>).EventSource = StubEventSource;
globalThis.fetch = mock(async () => new Response("{}", { status: 404 })) as unknown as typeof fetch;

document.body.innerHTML = `
  <div id="app">
    <div id="toolbar"></div>
    <div id="tab-strip"></div>
    <div id="activity-bar"></div>
    <div id="left-panel"></div>
    <div id="resize-left" class="resize-handle"></div>
    <div class="pane-stage" data-jx-region="pane.primary"></div>
    <div id="resize-right" class="resize-handle"></div>
    <div id="right-panel"></div>
    <div id="statusbar"></div>
  </div>
  <div id="layer-popover"></div>
  <div id="layer-modal"></div>
  <div id="layer-dialog"></div>
`;

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

void mock.module("../src/services/notify.ts", () => notifyModule(() => {}));

void mock.module("../src/panels/toolbar.ts", () => ({
  mount: mock(() => {}),
  render: mock(() => {}),
  unmount: mock(() => {}),
}));

void mock.module("../src/panels/welcome-screen.ts", () => ({
  initWelcome: mock(() => {}),
  renderWelcome: mock(() => {}),
}));

void mock.module("../src/editor/shortcuts.ts", () => ({
  initShortcuts: mock(() => {}),
  // The grid installs one stage-gesture disposer per cell; without it the boot fails at import.
  installStageGestures: () => () => {},
  registerStudioCommands: mock(() => {}),
}));

// `panels/layers-panel.ts` renders its row verbs from the bar's command records, so this mock has
// To carry them too or the boot fails at import time.
void mock.module("../src/panels/block-action-bar.ts", () => ({
  commandIcon: mock(() => nothing),
  commandTooltip: mock(() => ""),
  dismissBlockActionBar: mock(() => {}),
  dismissLinkPopover: mock(() => {}),
  initBlockActionBar: mock(() => {}),
  isEditChromeTarget: mock(() => false),
  registerSelectionCommands: mock(() => {}),
  renderBlockActionBar: mock(() => {}),
  runCommand: mock(() => {}),
  selectionCommandRegistry: () => ({
    disabledReason: () => {},
    forPlacement: () => [],
    keymap: { formatBinding: () => {} },
  }),
  showCommandOverflow: mock(() => {}),
  withCommandTarget: <T>(_path: unknown, fn: () => T) => fn(),
}));

interface PaneContextCtx {
  exportFile: () => Promise<void> | void;
  parseMediaEntries: (media: Record<string, string> | null | undefined) => unknown;
  setCanvasMode: (tab: unknown, mode: string) => void;
}
let paneCtx: PaneContextCtx | null = null;
void mock.module("../src/panels/pane-context.ts", () => ({
  // The grid hands every cell its chrome host, so this is on the boot's import graph.
  attachPaneChromeHost: mock(() => {}),
  mount: (_host: HTMLElement, ctx: PaneContextCtx) => {
    paneCtx = ctx;
  },
  render: mock(() => {}),
  unmount: mock(() => {}),
}));

void mock.module("../src/canvas/canvas-render.ts", () => ({
  handOverCanvasStage: mock(() => {}),
  initCanvasRender: mock(() => {}),
  registerSelectionSetCommand: mock(() => {}),
  renderCanvas: mock(() => {}),
  renderOverlays: mock(() => {}),
  scheduleCanvasRender: mock(() => {}),
}));

void mock.module("../src/canvas/canvas-patcher.ts", () => ({
  applyPatchBatch: mock(() => {}),
  classifyOps: mock(() => ({ patchable: false, reason: "mock" })),
  consumePatchedDocument: mock(() => false),
  escalateToFullRender: mock(() => {}),
  initCanvasPatcher: mock(() => {}),
}));

// The gap under test: NO platform is registered before the import, so studio.ts must fall back to
// Registering the dev-server PAL itself.
delete (globalThis as { __jxPlatform?: unknown }).__jxPlatform;

await import("../src/studio");
await flush();

const rafTurn = () =>
  new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });

test("boot without a platform registers the dev-server PAL", () => {
  expect(hasPlatform()).toBe(true);
  expect(getPlatform().id).toBe("devserver");
});

test("the idle css-props filler is a no-op once the datalist is gone", () => {
  // The datalist rendered at import time; the filler was queued but has not run yet.
  expect(idleCallbacks).toHaveLength(1);
  const dl = document.querySelector("#css-props")!;
  expect(dl).not.toBeNull();
  dl.remove();
  expect(() => idleCallbacks[0]!()).not.toThrow();
  // Nothing re-created it — the filler bailed on the missing datalist.
  expect(document.querySelector("#css-props")).toBeNull();
});

test("the pane-context bar is wired to the three callbacks it still takes", async () => {
  expect(paneCtx).not.toBeNull();
  /* It took four more — `navigateBack`, `navigateToLevel` and the two logic-editor closes — for a
     breadcrumb and a Back this bar no longer draws. `getCanvasMode` is the fifth to go, and it went
     for a different reason: it answered for the FOCUSED pane, and this bar is drawn once per pane.
     What is left is the axes' own wiring, and with no active tab every one of them is a guarded
     no-op. */
  expect(Object.keys(paneCtx!).toSorted()).toEqual([
    "exportFile",
    "parseMediaEntries",
    "setCanvasMode",
  ]);
  await paneCtx!.exportFile();
  // The write takes its target: no tab, nothing written, and no throw.
  expect(() => paneCtx!.setCanvasMode(null, "edit")).not.toThrow();
});

test("the bootstrap paints the statusbar once, directly", () => {
  // `setStatusbarRenderer` went with `statusMessage`: it existed only so a transient message could
  // Ask the bar to repaint, and the bar's own effect owns that now.
  expect(renderStatusbarMock).toHaveBeenCalled();
});

test("the files tab renders through studio's renderFilesTemplate wiring", async () => {
  installMockPlatform();
  setProjectState(null);
  shell.leftTab = "files";
  renderOnly("leftPanel");
  await rafTurn();
  await flush();
  const leftPanel = document.querySelector("#left-panel")!;
  expect(leftPanel.textContent).toContain("No project loaded");
});
