/**
 * Studio shell boot fixture (C7) — shared by the studio-shell-project-url*.test.ts files.
 *
 * Studio.ts reads location.search once at import time, so each URL scenario needs its own test
 * process (bun test --isolate). This fixture centralizes the global stubs, shell DOM scaffold,
 * leaf-module mocks, and the mocked statusbar message log, then imports src/studio.ts with the
 * requested URL and platform behavior.
 */
import { flush, installMockPlatform } from "./harness";
import { mock } from "bun:test";
import { notifyModule } from "./notify-mock";
import { nothing } from "lit-html";
import type { MockPlatformState } from "./harness";
import type { StudioPlatform } from "../src/types";

/** Statusbar messages captured by the mocked statusbar module. */
export const statusMessages: string[] = [];

export const captured: {
  toolbarCtx: any;
  welcomeCtx: any;
  blockBarCtx: any;
  canvasRenderCtx: any;
  shortcutsGet: (() => any) | null;
} = {
  blockBarCtx: null,
  canvasRenderCtx: null,
  shortcutsGet: null,
  toolbarCtx: null,
  welcomeCtx: null,
};

export const scheduleCanvasRenderMock = mock(() => {});

/** Poll until cond() is true (bounded), flushing microtasks between checks. */
export async function waitFor(cond: () => boolean, tries = 50): Promise<void> {
  for (let i = 0; i < tries && !cond(); i++) {
    await flush(1);
  }
}

export interface BootResult {
  platform: StudioPlatform;
  state: MockPlatformState;
}

/**
 * Stub globals, scaffold the shell DOM, mock the heavy leaf modules, register an in-memory
 * platform, then import src/studio.ts under the given URL.
 */
export async function bootStudio(opts: {
  url: string;
  overrides?: Partial<StudioPlatform>;
  seedFiles?: Record<string, string>;
}): Promise<BootResult> {
  (globalThis as any).happyDOM.setURL(opts.url);

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
  globalThis.fetch = mock(
    async () => new Response("{}", { status: 404 }),
  ) as unknown as typeof fetch;

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
    forgetSavedTimes: mock(() => {}),
    mountStatusbar: mock(() => {}),
    noteDocumentSaved: mock(() => {}),
    renderStatusbar: mock(() => {}),
    unmountStatusbar: mock(() => {}),
  }));

  // Outcomes reach `notify` now; the fixture collects the SENTENCE each one reports.
  void mock.module("../src/services/notify.ts", () =>
    notifyModule((call) => statusMessages.push(call.message)),
  );

  void mock.module("../src/panels/toolbar.ts", () => ({
    mount: (_el: HTMLElement, ctx: unknown) => {
      captured.toolbarCtx = ctx;
    },
    render: mock(() => {}),
    unmount: mock(() => {}),
  }));

  void mock.module("../src/panels/welcome-screen.ts", () => ({
    initWelcome: (ctx: unknown) => {
      captured.welcomeCtx = ctx;
    },
    renderWelcome: mock(() => {}),
  }));

  void mock.module("../src/editor/shortcuts.ts", () => ({
    // The registry is the first argument now; the pointer/pan thunk is the second.
    initShortcuts: (_registry: unknown, get: () => unknown) => {
      captured.shortcutsGet = get as () => any;
    },
    registerStudioCommands: mock(() => {}),
  }));

  void mock.module("../src/panels/block-action-bar.ts", () => ({
    // The bar owns the selection command records, so `panels/layers-panel.ts` imports its verb
    // Rendering from here too: a mock that stops at the bar's own five exports fails the boot at
    // Import time ("Export named 'commandIcon' not found"). The registry stub places nothing, so
    // The row-rendering helpers below are never reached — they exist to satisfy the import.
    commandIcon: mock(() => nothing),
    commandTooltip: mock(() => ""),
    dismissBlockActionBar: mock(() => {}),
    dismissLinkPopover: mock(() => {}),
    initBlockActionBar: (ctx: unknown) => {
      captured.blockBarCtx = ctx;
    },
    isEditChromeTarget: mock(() => false),
    // The bootstrap composes the bar's structural selection verbs into the app-wide registry so
    // The palette, the keyboard and `__jxAutomation` can reach them (plan §13.3).
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

  void mock.module("../src/canvas/canvas-render.ts", () => ({
    handOverCanvasStage: mock(() => {}),
    initCanvasRender: (ctx: unknown) => {
      captured.canvasRenderCtx = ctx;
    },
    registerSelectionSetCommand: mock(() => {}),
    renderCanvas: mock(() => {}),
    renderOverlays: mock(() => {}),
    scheduleCanvasRender: scheduleCanvasRenderMock,
  }));

  void mock.module("../src/canvas/canvas-patcher.ts", () => ({
    applyPatchBatch: mock(() => {}),
    classifyOps: mock(() => ({ patchable: false, reason: "mock" })),
    consumePatchedDocument: mock(() => false),
    escalateToFullRender: mock(() => {}),
    initCanvasPatcher: mock(() => {}),
  }));

  const { platform, state } = installMockPlatform(opts.overrides ?? {}, opts.seedFiles ?? {});

  await import("../src/studio");
  await flush();

  return { platform, state };
}
