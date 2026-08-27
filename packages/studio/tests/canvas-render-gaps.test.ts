/**
 * Canvas render gaps — the grid-mode dispatch paths and the source-mode collab binding
 * (createSourceCollabBinding + the collabCtx branch), which canvas-render.test.ts leaves uncovered.
 * Heavy collaborators (monaco, grid panel, iframe host, the collab binding, collab session) are
 * mocked so the dispatch runs deterministically.
 */
import { flush, registerPrimaryStage, resetStudioState, resetWorkspaceWithTab } from "./harness";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { initShellRefs } from "../src/store";
import { activeCanvasSurface } from "../src/canvas/canvas-surface";
import { activeTab, closeAllTabs } from "../src/workspace/workspace";
import { view } from "../src/view";
import { setFormats } from "../src/format/format-host";
import type { Tab } from "../src/tabs/tab";
import { surfaceForPane } from "../src/canvas/surface-registry";
import type { CanvasSurface } from "../src/canvas/surface-registry";

/* The panels of the FOCUSED pane's stage. Panels belong to a pane's surface now, not to the
   app (`src/canvas/canvas-surface.ts`); the array identity is stable, so a module-level
   binding still sees what the render mutated. */
const surface = activeCanvasSurface();
const canvasPanels = surface.panels;

// ─── Controllable mock behavior ───────────────────────────────────────────────

/**
 * THE SAME DOUBLE `canvas-render.test.ts` USES, and this is the file that needed it more.
 *
 * It used to be the earlier, cruder copy: `onDidChangeModelContent: () => {}` threw the handler
 * away, and `setValue` assigned `_model._value` directly rather than going through the model. A
 * keystroke could therefore not be EXPRESSED here — no change handler existed to fire, and a
 * programmatic write fired nothing either — in the one test file that owns the collab surface,
 * where "a peer typed" and "the author typed" are the whole subject. Repaired to match: handlers
 * are kept, `editor.setValue` goes through `model.setValue`, and `model.setValue` fires the
 * adopting editor's handlers exactly as Monaco's does (which is why `_ignoreNextChange` exists).
 */
interface FakeModel {
  _value: string;
  /** A model carries the file identity Monaco validates against; the repaint compares it. */
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
  updateOptions: ReturnType<typeof mock>;
}
const createdEditors: FakeEditor[] = [];

/** A keystroke, which the old double had no way to say. */
function typeInto(editor: FakeEditor, text: string) {
  editor._model!._value = text;
  for (const cb of editor._changeHandlers) {
    cb();
  }
}

void mock.module("monaco-editor/editor", () => ({
  MarkerSeverity: { Error: 8, Warning: 4 },
  Uri: { parse: (s: string) => ({ toString: () => s }) },
  editor: {
    create: (_el: HTMLElement, opts: { model?: FakeModel }) => {
      const ed: FakeEditor = {
        _changeHandlers: [],
        _focused: false,
        _ignoreNextChange: false,
        _model: opts?.model ?? null,
        // Mirrors Monaco: `dispose()` runs `_detachModel()`, so `getModel()` is null and
        // `getValue()` is `""` afterwards. See `tests/canvas-render.test.ts` for why that matters.
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
          ed._model?.setValue(v);
        },
        updateOptions: mock(() => {}),
      };
      // A model belongs to the editor that adopts it, and `model.setValue` reaches that editor's
      // Change handlers — which is how the source view's initial load fires one.
      if (ed._model) {
        ed._model._fire = () => {
          for (const cb of ed._changeHandlers) {
            cb();
          }
        };
      }
      createdEditors.push(ed);
      return ed;
    },
    createModel: (value: string, _lang: string, uri: unknown) => {
      const m: FakeModel = {
        _fire: () => {},
        _value: value,
        dispose: mock(() => {}),
        getValue: () => m._value,
        setValue: (v: string) => {
          m._value = v;
          m._fire();
        },
        uri,
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
  // `insert.openSlashMenu`'s poster; a PARTIAL mock of a module the graph reaches is a load
  // Error, not a missing stub at call time.
  postOpenSlash: () => {},
  postApplyFormat: () => {},
  postStyleUpdateToStylebookHosts: () => 0,
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
}));

void mock.module("../src/files/serialize-document.js", () => ({
  serializeDocument: async () => "{}",
}));

void mock.module("../src/files/file-ops.js", () => ({
  parseSourceForPath: async () => ({ document: { tagName: "div" }, frontmatter: {} }),
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

/* The Monaco↔Y.Text binding: record what it was asked to bind, and whether it was released. The
   binding itself is covered by `monaco-binding.test.ts`; what this file owns is the DISPATCH around
   it — which options the call site passes, and every path on which the lock must be handed back. */
interface RecordedBinding {
  destroyed: boolean;
  options: {
    awareness?: unknown;
    editors?: Iterable<unknown>;
    model?: unknown;
    origin?: unknown;
    text?: unknown;
  };
}
const bindings: RecordedBinding[] = [];
/** Set by a test to make `bindMonacoToYText(...)` throw — the module loading and then failing. */
let bindingShouldThrow = false;
void mock.module("../src/collab/monaco-binding.js", () => ({
  bindMonacoToYText: (options: RecordedBinding["options"]) => {
    if (bindingShouldThrow) {
      throw new Error("binding unavailable");
    }
    const record: RecordedBinding = { destroyed: false, options };
    bindings.push(record);
    return () => {
      record.destroyed = true;
    };
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
  for (const id of ["activity-bar", "left-panel", "right-panel", "toolbar"]) {
    const el = document.createElement("div");
    el.id = id;
    document.body.append(el);
  }
  initShellRefs();
  registerPrimaryStage();
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
  bindingShouldThrow = false;
  createdEditors.length = 0;
  renderGridMode.mockClear();
  detachGridPanel.mockClear();
  canvasPanels.length = 0;
  surface.prevCanvasMode = null;
  surfaceForPane("primary").panzoomWrap = null;
  surfaceForPane("primary").monacoEditor = null;
  view.functionEditor = null;
  surfaceForPane("primary").centerObserver = null;
  surfaceForPane("primary").renderGeneration = 0;
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
    // The SURFACE is the first argument, not a host element: the grid draws into one pane's stage,
    // And `#canvas-wrap` could only ever have named the primary's.
    const [drawnOn, tab] = renderGridMode.mock.calls[0]! as unknown as [CanvasSurface, Tab];
    expect(drawnOn).toBe(surfaceForPane("primary"));
    expect(tab).toBe(activeTab.value!);
    expect(drawnOn.wrap.style.display).toBe("block");
    expect(drawnOn.wrap.style.padding).toBe("0px");
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

/**
 * Flush turns until `ready()` holds, then stop.
 *
 * The source editor mounts behind one dynamic import and its collab binding behind a second, so a
 * fixed count of flushes is a guess about how long a module loader takes — one that holds on a warm
 * run and misses on a cold one. That is how every test below failed together, once in six runs of
 * this file, and passed the other five. Waiting for the state each test is about removes the guess
 * without softening it: a real regression still runs out of turns and still fails.
 */
async function settle(ready: () => boolean, turns = 100): Promise<void> {
  for (let i = 0; i < turns && !ready(); i += 1) {
    await flush(1);
  }
}

/** The source editor has mounted — the first of the two imports has landed. */
const editorMounted = () => createdEditors.length > 0;
/** …and the collab binding has been constructed — the second. */
const bindingLanded = () => bindings.length > 0;

describe("source-mode collab binding", () => {
  test("binds the buffer to the shared Y.Text and applies read-only for observers", async () => {
    collabCtx = makeCollabCtx({ readOnly: true });
    setMode("source");
    renderCanvas();
    await settle(bindingLanded);

    // The binding was constructed against the ctx text/awareness and the editor's model.
    expect(bindings).toHaveLength(1);
    const { awareness, editors, model, origin, text } = bindings[0]!.options;
    expect(text).toBe(collabCtx.text);
    expect(model).toBe(createdEditors[0]!.getModel()!);
    expect([...(editors as Iterable<FakeEditor>)][0]).toBe(createdEditors[0]);
    expect(awareness).toBe(collabCtx.awareness);
    /* Local keystrokes transact under the session's own origin, not an opaque binding instance —
       the value the collab UndoManager and the source reconciler both filter on. */
    expect(origin).toBe(collabCtx.localOrigin);
    // Remote-cursor styles attached for the roster.
    expect(document.head.querySelector("style[data-jx-collab-cursors]")).not.toBeNull();
    // Read-only identity → the editor buffer locks.
    expect(createdEditors[0]!.updateOptions).toHaveBeenCalledWith({ readOnly: true });
  });

  test("switching away tears the binding down: destroy + leave + style detach", async () => {
    collabCtx = makeCollabCtx();
    setMode("source");
    renderCanvas();
    await settle(bindingLanded);
    expect(bindings).toHaveLength(1);
    expect(createdEditors[0]!.updateOptions).not.toHaveBeenCalled();

    const ctx = collabCtx;
    setMode("design");
    renderCanvas();
    await settle(() => bindings[0]?.destroyed === true);
    expect(bindings[0]!.destroyed).toBe(true);
    expect(ctx.leave).toHaveBeenCalledTimes(1);
    expect(document.head.querySelector("style[data-jx-collab-cursors]")).toBeNull();
  });

  test("an editor replaced while the binding module loads unbinds immediately", async () => {
    let release!: () => void;
    collabCtx = makeCollabCtx();
    collabCtx.enter = () =>
      new Promise<void>((resolve) => {
        release = resolve;
      });
    setMode("source");
    renderCanvas();
    await settle(editorMounted);
    const ctx = collabCtx;
    release();
    // Let the enter() continuation reach the dynamic binding import, then yank the editor.
    await Promise.resolve();
    surfaceForPane("primary").monacoEditor = null;
    await flush();
    // The binding was built but immediately destroyed (cleanup ran, session left).
    expect(bindings).toHaveLength(1);
    expect(bindings[0]!.destroyed).toBe(true);
    expect(ctx.leave).toHaveBeenCalledTimes(1);
  });

  /**
   * THE CONTROL, and the reason the assertions in the next test mean anything.
   *
   * A SOLO source mount installs `onDidChangeModelContent`, so a keystroke marks the buffer typed
   * and arms its commit. The double in this file could not say that until it was repaired to match
   * `canvas-render.test.ts`'s — it discarded every handler, and its `setValue` bypassed the model,
   * so `_ignoreNextChange` was never consumed and the first real keystroke would have been eaten.
   */
  test("a keystroke into a SOLO source buffer marks it typed", async () => {
    collabCtx = null;
    setMode("source");
    renderCanvas();
    await settle(editorMounted);
    await flush(); // …and the initial serialization lands, consuming `_ignoreNextChange`.
    expect(surfaceForPane("primary").monacoEditor!._writes!.typed()).toBe(false);

    typeInto(createdEditors[0]!, "# typed");
    expect(surfaceForPane("primary").monacoEditor!._writes!.typed()).toBe(true);
  });

  /**
   * THE FIFTH WRITER, and the only one whose text reaches other people's machines.
   *
   * Y-monaco binds the model to the shared `Y.Text`, so peers' keystrokes arrive here saying
   * nothing — and the binding is two-way, so a local `setValue` is a whole-document replace
   * PUBLISHED to every peer. The repaint's fast path would do exactly that: it serializes the
   * structure tree, which is what `sourceParseNow` parsed OUT of this same shared text, so every
   * round trip that is not byte-stable republished the document to the room, on every repaint.
   * `hasTextFocus()` protected only the person currently typing.
   */
  test("a repaint never replaces a co-edited buffer — the CRDT owns that text", async () => {
    collabCtx = makeCollabCtx();
    setMode("source");
    renderCanvas();
    await settle(bindingLanded);
    expect(bindings).toHaveLength(1);

    const editor = createdEditors[0]!;
    expect(surfaceForPane("primary").monacoEditor!._writes!.shared()).toBe(true);
    // A peer types. the binding writes it straight into the model — a real keystroke, which the double
    // In this file could not express until it was repaired to match `canvas-render.test.ts`'s.
    typeInto(editor, "# from a peer");
    // And it declared NOTHING: the co-edited mount installs no change handler at all, so the buffer
    // Is not "typed", not "ahead", and clause 3 has nothing to say. That is precisely why clause 5
    // Is its own fact rather than a use of clause 3.
    expect(surfaceForPane("primary").monacoEditor!._writes!.typed()).toBe(false);
    expect(surfaceForPane("primary").monacoEditor!._writes!.ahead()).toBe(false);

    // An ordinary repaint — the source reconciler's parse arriving as a structure change is one.
    renderCanvas();
    await flush();

    expect(editor.getValue()).toBe("# from a peer");
  });

  /**
   * A BINDING FAILURE HOLDS A LOCK AND CARRIES NOTHING, and both halves are losses.
   *
   * `enter()` flips the room's canonical lock to "source" before the binding module is even
   * imported, and `ctx.leave()` lives in exactly one place — the cleanup the binding returns. So a
   * failure past that point left the lock held by a client with no binding, and now that the freeze
   * includes the lock holder (`collab-session.ts`'s transact gate), nobody in the room can edit the
   * structure and nobody can edit the source either, until someone reloads.
   *
   * The buffer is the other half. The co-edited mount returns before installing its change handler,
   * so on this path a keystroke arms no commit and marks nothing: `tabBufferUnsaved` stays false
   * and the next repaint replaces the author's words — with clause 5 unable to help, because
   * `markShared` is exactly what never ran. A surface that carries nothing says so.
   */
  test("an enter() failure hands the lock back and stops pretending to be an editor", async () => {
    collabCtx = makeCollabCtx({ enter: () => Promise.reject(new Error("room unavailable")) });
    const ctx = collabCtx;
    setMode("source");
    expect(() => renderCanvas()).not.toThrow();
    await settle(() => ctx.leave.mock.calls.length > 0);
    expect(bindings).toHaveLength(0);
    expect(surfaceForPane("primary").monacoEditor).toBe(createdEditors[0] as never);
    expect(ctx.leave).toHaveBeenCalledTimes(1);
    expect(createdEditors[0]!.updateOptions).toHaveBeenCalledWith({ readOnly: true });
  });

  test("a binding failure after enter() hands the lock back too", async () => {
    collabCtx = makeCollabCtx();
    const ctx = collabCtx;
    bindingShouldThrow = true;
    setMode("source");
    renderCanvas();
    await settle(() => ctx.leave.mock.calls.length > 0);
    expect(bindings).toHaveLength(0);
    expect(ctx.leave).toHaveBeenCalledTimes(1);
    expect(createdEditors[0]!.updateOptions).toHaveBeenCalledWith({ readOnly: true });
  });

  /* The editor can also simply be gone by the time `enter()` resolves — the lock was taken for a
     surface that no longer exists, and the cleanup that would release it is never constructed. */
  test("an editor torn down before enter() resolves hands the lock back", async () => {
    let release!: () => void;
    collabCtx = makeCollabCtx({
      enter: () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    });
    const ctx = collabCtx;
    setMode("source");
    renderCanvas();
    await settle(editorMounted);
    surfaceForPane("primary").monacoEditor = null;
    release();
    await settle(() => ctx.leave.mock.calls.length > 0);
    expect(bindings).toHaveLength(0);
    expect(ctx.leave).toHaveBeenCalledTimes(1);
  });
});
