/**
 * ⑪ · Logic — the code surface (`panels/editors.ts`). Monaco cannot load in happy-dom, so
 * editor.api is mocked with a minimal fake editor that mirrors the bits editors.ts relies on
 * (create/get/ setValue/dispose/change events, setValue firing onDidChangeModelContent like real
 * Monaco).
 *
 * The tests drive it the way the Bottom dock does — paint {@link functionEditorTemplate} into a
 * body, then call {@link syncFunctionEditor} as the panel's `afterRender` — and assert what the move
 * out of the canvas takeover has to get right: the canvas is left mounted, the editor is rebuilt
 * when lit replaces its container, and a Close still minifies and writes the body back. Format/lint
 * on open, debounced state sync for defs and events, and the completion provider are unchanged and
 * still covered here.
 */
import { flush, installMockPlatform, resetWorkspaceWithTab } from "./harness";
import { beforeEach, describe, expect, mock, test } from "bun:test";

type ChangeListener = () => void;

class FakeEditor {
  value: string;
  options: Record<string, unknown>;
  disposed = false;
  listeners: ChangeListener[] = [];
  model: Record<string, unknown> | null = { id: "fake-model" };
  _ignoreNextChange?: boolean;
  _editingTarget?: string | null;
  /**
   * Whether the caret is in this buffer — and it has to be able to answer TRUE.
   *
   * A double whose `hasTextFocus()` was hard-wired to `false` is a double in which nobody is ever
   * typing, and "the repaint reverted what I was typing" is precisely a defect of the typing case.
   * The tests below flip it the way a click into the editor does.
   */
  focused = false;

  _el: unknown;
  dom: HTMLElement | null = null;

  constructor(el: unknown, options: Record<string, unknown>) {
    this._el = el;
    this.value = (options?.value as string) ?? "";
    this.options = options;
  }
  /**
   * Mirrors Monaco, INCLUDING after a dispose.
   *
   * `CodeEditorWidget.getValue()` is `if (!this._modelData) return "";`, and `dispose()` runs
   * `_detachModel()`. So a disposed Monaco editor answers the empty string, not the buffer it held
   * — and a double that kept answering with the buffer is the reason an orphan debounce writing
   * `""` into the document read as green for two phases.
   */
  getValue() {
    return this.disposed ? "" : this.value;
  }
  /**
   * Mirrors Monaco: programmatic setValue also fires onDidChangeModelContent — and no-ops with no
   * model, which is what a disposed editor has.
   */
  setValue(v: string) {
    if (this.disposed) {
      return;
    }
    this.value = v;
    this.fire();
  }
  dispose() {
    this.disposed = true;
    this.model = null;
  }
  onDidChangeModelContent(fn: ChangeListener) {
    this.listeners.push(fn);
    return { dispose: () => {} };
  }
  getModel() {
    return this.model;
  }
  /** Mirrors Monaco: a disposed editor has no focus to report. */
  hasTextFocus() {
    return !this.disposed && this.focused;
  }
  /**
   * Monaco appends its own root to the container it was created in; `syncFunctionEditor` asks
   * whether that root is still attached, so the fake has to have one.
   */
  getDomNode() {
    const el = this._el as HTMLElement | null;
    if (el && !this.dom) {
      this.dom = el.ownerDocument.createElement("div");
      el.append(this.dom);
    }
    return this.dom;
  }
  /** Simulate a user edit (value change + change event, no ignore flag). */
  type(v: string) {
    this.value = v;
    this.fire();
  }
  fire() {
    for (const listener of this.listeners) {
      listener();
    }
  }
}

const created: FakeEditor[] = [];
const setModelMarkers = mock((_model: unknown, _owner: string, _markers: unknown[]) => {});
const registerCompletionItemProvider = mock((_lang: string, _provider: unknown) => ({
  dispose: () => {},
}));

void mock.module("monaco-editor/esm/vs/editor/editor.api.js", () => ({
  MarkerSeverity: { Error: 8, Warning: 4 },
  Uri: { parse: (u: string) => ({ target: u, toString: () => u }) },
  editor: {
    create: (el: unknown, options: Record<string, unknown>) => {
      const ed = new FakeEditor(el, options);
      created.push(ed);
      return ed;
    },
    setModelMarkers,
  },
  languages: {
    CompletionItemKind: { Function: 1, Property: 9, Variable: 4 },
    registerCompletionItemProvider,
  },
}));

const {
  closeFunctionEditor,
  functionEditorTemplate,
  registerFunctionCompletions,
  syncFunctionEditor,
} = await import("../src/panels/editors");
const { nothing, render: litRender } = await import("lit-html");
const { loadMonaco } = await import("../src/services/monaco-lazy");
const { initShellRefs, registerRenderer } = await import("../src/store");
const { activeCanvasSurface } = await import("../src/canvas/canvas-surface");
/* Panels belong to a pane's stage now (`src/canvas/canvas-surface.ts`), not to the app. */
const canvasPanels = activeCanvasSurface().panels;
const { view } = await import("../src/view");
const { commitTabBuffers, tabBufferUnsaved } = await import("../src/services/monaco-buffer");
const { setTransactGate } = await import("../src/tabs/transact");
const { resetNotifications, toasts } = await import("../src/services/notify");
const { activateTab, activeTab, closeAllTabs, closeTab, openTab } =
  await import("../src/workspace/workspace");
type StudioTab = NonNullable<typeof activeTab.value>;

document.body.innerHTML = `<div id="app"><div id="canvas-wrap"></div><div id="logic"></div></div>`;
initShellRefs();

// Destructuring store.canvasWrap would snapshot the pre-initShellRefs null — query instead
const canvasWrap = document.querySelector("#canvas-wrap") as HTMLElement;
/** Stands in for the dock's `.bd-body` — what the Logic tab's `afterRender` is handed. */
const dock = document.querySelector("#logic") as HTMLElement;

/**
 * One dock repaint: lit paints the tab's body, then the panel's `afterRender` runs against it.
 *
 * Nothing renders this surface on the canvas's behalf any more — the dock owns it — so every test
 * that used to call `renderFunctionEditor` drives the pair instead, which is exactly the sequence
 * `panels/bottom-dock.ts` runs.
 */
async function paintLogic() {
  litRender(functionEditorTemplate(), dock);
  syncFunctionEditor(dock);
  // The mount awaits the lazy Monaco load, which is memoized: awaiting it here means the
  // Continuation inside `mountFunctionEditor` is already queued, and one turn runs it. Waiting a
  // Fixed number of turns instead made the first test in the file a race against a cold import.
  await loadMonaco();
  await flush();
}

const toolbarRender = mock(() => {});
const leftPanelRender = mock(() => {});
registerRenderer("toolbar", toolbarRender);
registerRenderer("leftPanel", leftPanelRender);

const sleep = (ms: number) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

function docFixture() {
  return {
    children: [
      {
        onclick: {
          $prototype: "Function",
          body: "go()",
          parameters: ["state", "event"],
        },
        tagName: "button",
        textContent: "Go",
      },
    ],
    state: {
      fetcher: { $prototype: "Request", url: "/x" },
      greet: {
        $prototype: "Function",
        body: "return 1;",
        parameters: [{ name: "state" }, { name: "name" }],
      },
      handler: { $handler: "h" },
      plain: "hello",
    },
    tagName: "div",
  } as never;
}

let codeServiceCalls: [string, any][] = [];
let formatResult: { code: string } | null = null;
let lintResult: { diagnostics: unknown[] } | null = null;

function setEditing(editing: Record<string, unknown> | null) {
  (activeTab.value!.session.ui as any).editingFunction = editing;
}

/** The target on a NAMED tab — the two-document tests set both before either is focused. */
function setEditingOn(tab: StudioTab, editing: Record<string, unknown> | null) {
  (tab.session.ui as any).editingFunction = editing;
}

/**
 * The collision the dock's commit could not see: two documents, one target string.
 *
 * `{"eventKey":"onclick","path":["children",0],"type":"event"}` is the same JSON for the first
 * button on ANY two pages, and `{defName:"greet",type:"def"}` for any two `greet`s. Nothing about
 * either string names a document.
 */
const SHARED_TARGET = { eventKey: "onclick", path: ["children", 0], type: "event" };

function twoPagesWithTheSameButton() {
  closeAllTabs();
  const a = openTab({
    document: docFixture(),
    documentPath: "/project/pages/a.json",
    id: "tab-a",
  });
  const b = openTab({
    document: docFixture(),
    documentPath: "/project/pages/b.json",
    id: "tab-b",
  });
  setEditingOn(a, { ...SHARED_TARGET });
  setEditingOn(b, { ...SHARED_TARGET });
  return { a, b };
}

/** `children[0].onclick.body` on a tab, which is what both documents' handlers live at. */
function handlerBody(tab: StudioTab) {
  return ((tab.doc.document.children as any[])[0] as any).onclick.body as string;
}

beforeEach(() => {
  codeServiceCalls = [];
  formatResult = null;
  lintResult = null;
  created.length = 0;
  toolbarRender.mockClear();
  leftPanelRender.mockClear();
  setModelMarkers.mockClear();
  // The function editor now registers completions when it MOUNTS (previously studio.ts did it at
  // Startup), so both the mock and the once-guard have to reset or the count depends on test order.
  registerCompletionItemProvider.mockClear();
  view._completionRegistered = false;
  view.functionEditor = null;
  view.monacoEditor = null;
  resetNotifications();
  installMockPlatform({
    codeService: (async (action: string, payload: unknown) => {
      codeServiceCalls.push([action, payload]);
      return action === "format" ? formatResult : lintResult;
    }) as never,
  });
  resetWorkspaceWithTab(docFixture(), { documentPath: "/project/pages/index.json" });
});

describe("the code surface — def target", () => {
  test("mounts into the dock body and leaves the canvas mounted", async () => {
    const dndCleanup = mock(() => {});
    const eventCleanup = mock(() => {});
    view.canvasDndCleanups = [dndCleanup];
    view.canvasEventCleanups = [eventCleanup];
    canvasPanels.push({ id: "panel" } as never);
    canvasWrap.textContent = "the rendered page";
    setEditing({ defName: "greet", type: "def" });

    await paintLogic();
    await flush();

    // The takeover tore all four of these down before drawing over the stage. The page whose
    // Handler this is stays rendered, patchable and on screen — the whole point of P8.5.
    expect(dndCleanup).not.toHaveBeenCalled();
    expect(eventCleanup).not.toHaveBeenCalled();
    expect(view.canvasDndCleanups).toHaveLength(1);
    expect(view.canvasEventCleanups).toHaveLength(1);
    expect(canvasPanels).toHaveLength(1);
    expect(canvasWrap.textContent).toBe("the rendered page");

    expect(dock.querySelector(".fw-code")).not.toBeNull();

    expect(created).toHaveLength(1);
    expect(created[0]!.options.language).toBe("javascript");
    expect(created[0]!.value).toBe("return 1;");
    expect(view.functionEditor).toBe(created[0] as never);
    expect(view.functionEditor!._editingTarget).toBe(
      JSON.stringify({ defName: "greet", type: "def" }),
    );
  });

  test("formats on open and applies lint markers from diagnostics", async () => {
    formatResult = { code: "return 1;\n" };
    lintResult = {
      diagnostics: [
        {
          code: "no-undef",
          help: "declare it",
          labels: [{ span: { column: 2, length: 3, line: 1 } }],
          message: "x is not defined",
          severity: "error",
          url: "https://oxc.rs/no-undef",
        },
        {
          labels: [{ span: { column: 1, line: 2 } }],
          message: "prefer const",
          severity: "warning",
        },
        { message: "no label, dropped", severity: "warning" },
      ],
    };
    setEditing({ defName: "greet", type: "def" });
    await paintLogic();
    await flush();

    // Format request carries the def's parameter names; formatted code replaces the buffer
    const formatCall = codeServiceCalls.find(([action]) => action === "format")!;
    expect(formatCall[1]).toEqual({ args: ["state", "name"], code: "return 1;" });
    expect(created[0]!.value).toBe("return 1;\n");

    expect(setModelMarkers).toHaveBeenCalledTimes(1);
    const [model, owner, markers] = setModelMarkers.mock.calls[0] as any[];
    expect(model).toEqual({ id: "fake-model" });
    expect(owner).toBe("oxlint");
    expect(markers).toHaveLength(2);
    expect(markers[0]).toMatchObject({
      endColumn: 5,
      endLineNumber: 1,
      message: "x is not defined\ndeclare it",
      severity: 8,
      source: "oxlint",
      startColumn: 2,
      startLineNumber: 1,
    });
    expect(markers[0].code.value).toBe("no-undef");
    expect(markers[1]).toMatchObject({ endColumn: 2, severity: 4, startColumn: 1 });
  });

  test("re-render with the same target re-syncs the buffer instead of recreating", async () => {
    setEditing({ defName: "greet", type: "def" });
    await paintLogic();
    await flush();
    expect(created).toHaveLength(1);
    const [ed] = created;

    // Buffer drifted from the document → re-sync writes the body back with the ignore flag
    ed!.value = "drifted()";
    await paintLogic();
    await flush();
    expect(created).toHaveLength(1);
    expect(ed!.value).toBe("return 1;");

    // Buffer already in sync → nothing happens
    await paintLogic();
    await flush();
    expect(created).toHaveLength(1);
    expect(ed!.value).toBe("return 1;");
    expect(ed!.disposed).toBe(false);
  });

  test("debounced edits write the body back to the state def and lint the new code", async () => {
    setEditing({ defName: "greet", type: "def" });
    await paintLogic();
    await flush();
    const [ed] = created;

    ed!.type("return 42;");
    await sleep(600);
    const { greet } = activeTab.value!.doc.document.state as any;
    expect(greet.body).toBe("return 42;");
    expect(greet.$prototype).toBe("Function");
    expect(leftPanelRender).toHaveBeenCalled();

    await sleep(300);
    await flush();
    const lints = codeServiceCalls.filter(([action]) => action === "lint");
    expect(lints.at(-1)![1]).toEqual({ args: ["state", "name"], code: "return 42;" });
  });

  test("renders an empty buffer for missing or non-function defs", async () => {
    setEditing({ defName: "missing", type: "def" });
    await paintLogic();
    await flush();
    expect(created.at(-1)!.value).toBe("");

    setEditing({ defName: "plain", type: "def" });
    await paintLogic();
    await flush();
    expect(created.at(-1)!.value).toBe("");
    // Non-function defs fall back to the default arg names
    const formatCall = codeServiceCalls.findLast(([action]) => action === "format")!;
    expect(formatCall[1].args).toEqual(["state", "event"]);
  });
});

describe("the code surface — event target", () => {
  test("switching targets disposes the previous editor and loads the event body", async () => {
    setEditing({ defName: "greet", type: "def" });
    await paintLogic();
    await flush();
    const [first] = created;
    // Source mode's Monaco belongs to the PANE. The takeover disposed it on its way over the
    // Stage; a dock tab shares the screen with it and must leave it alone.
    const paneMonaco = { dispose: mock(() => {}) };
    view.monacoEditor = paneMonaco as never;

    setEditing({ eventKey: "onclick", path: ["children", 0], type: "event" });
    await paintLogic();
    await flush();

    expect(first!.disposed).toBe(true);
    expect(paneMonaco.dispose).not.toHaveBeenCalled();
    expect(view.monacoEditor).toBe(paneMonaco as never);
    expect(created).toHaveLength(2);
    expect(created[1]!.value).toBe("go()");
  });

  test("debounced edits update the event handler property preserving its shape", async () => {
    setEditing({ eventKey: "onclick", path: ["children", 0], type: "event" });
    await paintLogic();
    await flush();
    const ed = created.at(-1)!;

    ed.type("doIt(state)");
    await sleep(600);
    // Field-by-field assertions — the document is a reactive proxy, which trips toMatchObject
    const [node] = activeTab.value!.doc.document.children as any[];
    expect(node.onclick.$prototype).toBe("Function");
    expect(node.onclick.body).toBe("doIt(state)");
    expect([...node.onclick.parameters]).toEqual(["state", "event"]);
  });

  test("renders an empty buffer for an unrecognized editing type", async () => {
    setEditing({ type: "mystery" });
    await paintLogic();
    await flush();
    expect(created.at(-1)!.value).toBe("");
  });

  test("discards stale lint results when a newer edit superseded them", async () => {
    const pendingLints: ((value: unknown) => void)[] = [];
    installMockPlatform({
      codeService: ((action: string) =>
        action === "lint"
          ? new Promise((resolve) => {
              pendingLints.push(resolve);
            })
          : Promise.resolve(null)) as never,
    });
    setEditing({ defName: "greet", type: "def" });
    await paintLogic();
    await flush();
    const ed = created.at(-1)!;
    setModelMarkers.mockClear();

    ed.type("first()");
    await sleep(800); // First lint timer fires; its request stays pending
    const staleIdx = pendingLints.length - 1;
    ed.type("second()");
    await sleep(800); // Second lint timer fires with a newer generation
    const freshIdx = pendingLints.length - 1;
    expect(freshIdx).toBeGreaterThan(staleIdx);

    // Resolve the stale request first — its generation lost, so no markers are applied
    pendingLints[staleIdx]!({
      diagnostics: [
        { labels: [{ span: { column: 1, line: 1 } }], message: "stale", severity: "warning" },
      ],
    });
    await flush();
    expect(setModelMarkers).not.toHaveBeenCalled();

    // The current generation still lands
    pendingLints[freshIdx]!({
      diagnostics: [
        { labels: [{ span: { column: 1, line: 1 } }], message: "fresh", severity: "warning" },
      ],
    });
    await flush();
    expect(setModelMarkers).toHaveBeenCalledTimes(1);
  });

  test("renders an empty buffer when the event path resolves to nothing", async () => {
    setEditing({ eventKey: "onclick", path: ["children", 99], type: "event" });
    await paintLogic();
    await flush();
    expect(created.at(-1)!.value).toBe("");
  });
});

describe("living in a dock tab", () => {
  test("rebuilds when lit replaces the container out from under the editor", async () => {
    setEditing({ defName: "greet", type: "def" });
    await paintLogic();
    const [first] = created;
    expect(first!.disposed).toBe(false);

    // What switching to the formula surface and back does: a NEW `.fw-code`, same target. The
    // Takeover only compared the target string, so it would have kept a detached editor holding
    // The user's unsaved body and shown them an empty box.
    dock.textContent = "";
    // @ts-expect-error -- _$litPart$ is Lit's private render-part marker, not in the DOM types
    delete dock["_$litPart$"];
    await paintLogic();

    expect(first!.disposed).toBe(true);
    expect(created).toHaveLength(2);
    expect(created[1]!.value).toBe("return 1;");
  });

  test("a repaint with no target disposes the editor instead of leaking it", async () => {
    setEditing({ defName: "greet", type: "def" });
    await paintLogic();
    const [ed] = created;

    setEditing(null);
    litRender(functionEditorTemplate(), dock);
    syncFunctionEditor(dock);

    expect(ed!.disposed).toBe(true);
    expect(view.functionEditor).toBeNull();
  });

  /**
   * A6 — ⌘W one keystroke after the last one.
   *
   * The 500ms commit is the only thing that carries this buffer into the document, and until it
   * lands nothing is dirty — so `shouldWarnOnClose` said there was nothing to lose, the tab closed
   * with no prompt, and the handler kept its pre-typing body. The disposer cannot help: `closeTab`
   * deletes the tab first, and `bodyWriter` then correctly refuses to write into it.
   */
  test("typing is visible to the close path, and the close path can land it", async () => {
    setEditing({ defName: "greet", type: "def" });
    await paintLogic();
    const ed = created.at(-1)!;
    const tab = activeTab.value!;

    ed.type("typed();");
    expect(tab.doc.dirty).toBe(false);
    expect(tabBufferUnsaved(tab)).toBe(true);

    await commitTabBuffers(tab);
    expect((tab.doc.document.state as any).greet.body).toBe("typed();");
    expect(tab.doc.dirty).toBe(true);
    expect(tabBufferUnsaved(tab)).toBe(false);
  });

  /**
   * The REPAINT got more frequent in P8 too, and it is the rate that matters most: it is the one
   * that runs while the author's hands are on the keyboard.
   *
   * `syncFunctionEditor` is the Logic tab's `afterRender`, and the dock's render effect tracks
   * every badge in the strip — Problems' count, Activity's running list, Source Control's file
   * count, which git re-polls every 30 seconds. None of those are the code surface, and all of them
   * repaint it. The re-sync branch then compares the BUFFER to the DOCUMENT and resolves a
   * difference in the document's favour — but between a keystroke and the 500ms commit they differ
   * by definition, so what it resolved was the word being typed.
   */
  test("a repaint mid-keystroke does not revert what is being typed", async () => {
    setEditing({ defName: "greet", type: "def" });
    await paintLogic();
    const ed = created.at(-1)!;

    ed.focused = true;
    ed.type("return 42;"); // Buffer is ahead of the document until the 500ms commit

    // Source Control's git poll ticks / a notification raises the Problems count: the dock
    // Repaints, the Logic tab's afterRender runs, same target, same container.
    await paintLogic();

    expect(ed.value).toBe("return 42;");
    expect(created).toHaveLength(1); // Same editor — the revert was a setValue, not a remount

    // And the armed commit is still the user's. `_ignoreNextChange` makes the change listener
    // Return BEFORE it re-arms, so a revert left the original timer running and it wrote the
    // Reverted body half a second later — the repaint's opinion outliving the repaint.
    await sleep(900); // Past both the 500ms commit and the 750ms lint
    expect((activeTab.value!.doc.document.state as any).greet.body).toBe("return 42;");
  });

  /**
   * Clause 3 of the rule, and the reason `hasTextFocus()` alone is not the rule.
   *
   * Type, then click the canvas — focus leaves the editor while the commit is still armed. The
   * buffer is ahead of the document for the rest of that window, and the canvas's original
   * one-clause spelling of this guard would let a repaint inside it revert the edit.
   */
  test("a repaint after a blur, with the commit still armed, does not revert either", async () => {
    setEditing({ defName: "greet", type: "def" });
    await paintLogic();
    const ed = created.at(-1)!;

    ed.focused = true;
    ed.type("return 42;");
    ed.focused = false; // Clicked away; the 500ms commit is still pending

    await paintLogic();
    expect(ed.value).toBe("return 42;");

    await sleep(900);
    expect((activeTab.value!.doc.document.state as any).greet.body).toBe("return 42;");
  });

  /**
   * The teardown got MORE FREQUENT in P8, and neither of the two things it tried was right.
   *
   * The canvas takeover was torn down by exactly one thing — closing it. A dock tab is disposed by
   * five: selecting Problems, collapsing the dock, moving the pane, opening another target, and the
   * Close. Each runs `disposeFunctionEditor()` synchronously while up to two `setTimeout`s are
   * still armed over the editor it just killed, and a disposed Monaco editor answers `getValue()`
   * with `""`. So the 500ms sync timer wrote an EMPTY BODY into the document — the handler deleted,
   * the tab dirty, half a second after the surface was gone.
   *
   * Cancelling the timer fixed the corruption by making the loss quieter. The last half-second of
   * typing was simply dropped, and because the document never received it `doc.dirty` stayed
   * `false`, so nothing on screen said an edit had gone missing. Measured: open → type → switch
   * dock tab → reopen showed the PRE-TYPING body with Logic still sitting on the strip.
   *
   * Neither "the dead buffer's `""`" nor "nothing" is the contract. **The edit survives the
   * teardown**, and the dead buffer is never read.
   */
  test("a teardown mid-edit flushes the armed commit instead of dropping the edit", async () => {
    setEditing({ defName: "greet", type: "def" });
    await paintLogic();
    const [ed] = created;

    ed!.type("return 42;"); // Arms the 500ms commit and the 750ms lint
    // Click the Problems tab / the dock's × / ⌘\ to another pane: the Logic tab repaints with no
    // Target and `syncFunctionEditor` disposes on the spot.
    setEditing(null);
    litRender(functionEditorTemplate(), dock);
    syncFunctionEditor(dock);
    expect(ed!.disposed).toBe(true);
    expect(ed!.getValue()).toBe(""); // What a surviving timer would have read

    const { greet } = activeTab.value!.doc.document.state as any;
    // The flush happened INSIDE the dispose, before the model was detached — synchronously, so the
    // Body is already written by the time the teardown returns.
    expect(greet.body).toBe("return 42;");
    expect(greet.$prototype).toBe("Function");
    expect(activeTab.value!.doc.dirty).toBe(true);

    await sleep(900);
    // And nothing fires afterwards to undo it: the flush dropped the timer it ran, and `cancel`
    // Dropped the rest. `""` never reaches the document.
    expect((activeTab.value!.doc.document.state as any).greet.body).toBe("return 42;");
    // The lint is NOT flushed — a round trip started for an editor being disposed answers to
    // Nobody, so the only lint is the one format-on-open made.
    expect(codeServiceCalls.filter(([action]) => action === "lint")).toHaveLength(1);
  });

  /**
   * Format-on-open, and the repaint that used to undo it.
   *
   * The formatted body is written into the buffer and deliberately never committed, so the buffer
   * is ahead of the document with no timer armed. Clause 3 spelled as "is a commit pending?" called
   * that settled, and the re-sync branch then resolved the difference in the document's favour —
   * un-formatting the code in front of the author, on a repaint they never connected to their
   * editor (the Problems badge, Activity, a 30-second git poll).
   */
  test("format on open is not un-done by the next repaint", async () => {
    formatResult = { code: "return 1;\n" };
    setEditing({ defName: "greet", type: "def" });
    await paintLogic();
    const ed = created.at(-1)!;
    expect(ed.value).toBe("return 1;\n");

    // Nothing is armed, the caret is elsewhere, the editor is live and attached — every clause of
    // The old spelling says "settled", and the document still holds "return 1;".
    await paintLogic();
    await paintLogic();

    expect(ed.value).toBe("return 1;\n");
    expect(created).toHaveLength(1); // Same editor: the revert was a setValue, not a remount
  });
});

/**
 * ONE BUFFER BELONGS TO ONE DOCUMENT, and the commit had no way to say which.
 *
 * `activeTab.value` inside the 500ms callback is "whatever tab is focused when the timer fires",
 * which is the tab the buffer was read from only when nothing happened in between. Two tabs collide
 * whenever their target strings match — `{defName:"greet",type:"def"}`, or the far more ordinary
 * first-button-on-the-page event handler — and the re-sync could not save it either: refusing to
 * overwrite a buffer that is ahead is right, and it means the buffer still holds A's text when the
 * timer hands it to B.
 */
describe("a commit names the tab its editor was mounted for", () => {
  test("the debounce writes to the mounted tab, not the focused one", async () => {
    const { a, b } = twoPagesWithTheSameButton();
    activateTab(a.id);

    await paintLogic();
    const ed = created.at(-1)!;
    ed.type("fromA(state)"); // Arms the 500ms commit over A's buffer

    // Click B's tab inside the window. No repaint yet — this is the raw race the timer runs in.
    activateTab(b.id);
    expect(activeTab.value!.id).toBe("tab-b");
    await sleep(700);

    expect(handlerBody(a)).toBe("fromA(state)");
    expect(handlerBody(b)).toBe("go()");
    expect(b.doc.dirty).toBe(false);
    expect(a.doc.dirty).toBe(true);
  });

  test("a repaint after the switch rebuilds for the new tab and carries A's edit home", async () => {
    const { a, b } = twoPagesWithTheSameButton();
    activateTab(a.id);
    await paintLogic();
    const first = created.at(-1)!;
    first.type("fromA(state)");

    // The dock repaints on the switch. Same target string, different document: the re-sync branch
    // Used to match on the string alone and keep an editor holding the other page's handler.
    activateTab(b.id);
    await paintLogic();

    expect(created).toHaveLength(2);
    expect(first.disposed).toBe(true);
    expect(created[1]!.value).toBe("go()"); // B's own body, not A's buffer
    expect(handlerBody(a)).toBe("fromA(state)"); // The teardown flushed it where it belonged
    expect(handlerBody(b)).toBe("go()");
    expect(b.doc.dirty).toBe(false);
  });

  test("a commit whose tab was closed writes nowhere at all", async () => {
    const { a, b } = twoPagesWithTheSameButton();
    activateTab(a.id);
    await paintLogic();
    const ed = created.at(-1)!;
    ed.type("fromA(state)");

    // ⌘W on A while the commit is armed. Nothing will ever read what is written into a tab
    // `workspace.tabs` no longer holds — but `transactDoc` would still push history and mark it
    // Dirty, and the fallback this replaces would have written it into B.
    closeTab(a.id);
    await sleep(700);

    expect(handlerBody(a)).toBe("go()");
    expect(handlerBody(b)).toBe("go()");
    expect(a.doc.dirty).toBe(false);
    expect(b.doc.dirty).toBe(false);
  });
});

describe("closeFunctionEditor", () => {
  test("minifies the buffer into the state def and clears the target", async () => {
    setEditing({ defName: "greet", type: "def" });
    await paintLogic();
    created.at(-1)!.type("return    2;");

    await closeFunctionEditor();

    const { greet } = activeTab.value!.doc.document.state as any;
    // The mock code service answers null for "minify", so the raw buffer is what is stored — the
    // Point is that the CLOSE is what writes, rather than losing whatever the debounce had not.
    expect(greet.body).toBe("return    2;");
    expect(activeTab.value!.session.ui.editingFunction).toBeNull();
    expect(view.functionEditor).toBeNull();

    // AND IT STAYS WRITTEN. The keystroke above armed a 500ms sync timer over the editor Close
    // Then disposed; this assertion used to be made 100ms into that window and stopped there,
    // Certifying the corrupting path. The timer read `""` off the dead editor and overwrote the
    // Correct body with it — the intended action destroying the work it exists to save.
    await sleep(900);
    expect((activeTab.value!.doc.document.state as any).greet.body).toBe("return    2;");
  });

  test("writes an event binding back with its Function shape intact", async () => {
    setEditing({ eventKey: "onclick", path: ["children", 0], type: "event" });
    await paintLogic();
    created.at(-1)!.type("bye()");

    await closeFunctionEditor();

    const [node] = activeTab.value!.doc.document.children as any[];
    expect(node.onclick.$prototype).toBe("Function");
    expect(node.onclick.body).toBe("bye()");
    expect(activeTab.value!.session.ui.editingFunction).toBeNull();
  });

  /**
   * A REFUSED WRITE, and the button that destroyed the body because it could not see one.
   *
   * The collab gate pauses structural editing while anyone holds source-canonical — the lock holder
   * included, since the CRDT owns the text the tree is derived from. `transactDoc` returned the
   * same `undefined` for that refusal as for a write that landed, so the Close carried on: minify,
   * refused write, `cancelBufferWrites` (the armed commit gone with it), dispose, target cleared.
   * The one action whose entire purpose is to save the body deleted it, and the standing "frozen"
   * chip in the presence strip does not say that a button just did nothing.
   */
  test("a refused write leaves the body on screen and says so", async () => {
    setEditing({ defName: "greet", type: "def" });
    await paintLogic();
    const ed = created.at(-1)!;
    ed.type("return 42;");
    const editor = view.functionEditor;

    setTransactGate(() => "source-canonical");
    try {
      await closeFunctionEditor();
    } finally {
      setTransactGate(null);
    }

    // The document never received it — and neither the editor nor the target went away, so the
    // Author is still looking at the text they typed.
    expect((activeTab.value!.doc.document.state as any).greet.body).toBe("return 1;");
    expect(view.functionEditor).toBe(editor);
    expect(ed.disposed).toBe(false);
    expect(activeTab.value!.session.ui.editingFunction).toEqual({
      defName: "greet",
      type: "def",
    });
    // And it is still unsaved work, so ⌘W and ⌘Q will both stop for it.
    expect(tabBufferUnsaved(activeTab.value!)).toBe(true);
    // A toast, not a Problem: the author just pressed a button and is looking at the surface it
    // Failed to close. The durable half of the fact is the buffer itself, which now reports the
    // Work honestly to every close gate; a Problems row would outlive the freeze it describes.
    expect(toasts.some((t) => t.key === "logic.close-refused")).toBe(true);
  });

  /**
   * The debounce's half of the same fact. Nothing here is destroyed, so there is nothing to keep —
   * but settling the buffer would have told every close gate the document had the text.
   */
  test("a refused debounce does not settle the buffer", async () => {
    setEditing({ defName: "greet", type: "def" });
    await paintLogic();
    const tab = activeTab.value!;

    setTransactGate(() => "source-canonical");
    try {
      created.at(-1)!.type("return 42;");
      await commitTabBuffers(tab);
    } finally {
      setTransactGate(null);
    }

    expect((tab.doc.document.state as any).greet.body).toBe("return 1;");
    expect(tabBufferUnsaved(tab)).toBe(true);

    // And the moment the freeze lifts, the same buffer commits normally.
    created.at(-1)!.type("return 43;");
    await commitTabBuffers(tab);
    expect((tab.doc.document.state as any).greet.body).toBe("return 43;");
    expect(tabBufferUnsaved(tab)).toBe(false);
  });

  /**
   * THE FIVE EXITS THAT ARE NOT THE CLOSE BUTTON, and what a refusal costs them.
   *
   * `closeFunctionEditor` can refuse: the surface is standing, so keeping the text on screen IS an
   * answer. A DISPOSER has no such option — every one of its callers is a repaint or a mode
   * transition that has already replaced the container, so a Monaco kept alive over one is
   * unreachable rather than rescued. Its two remaining choices were to say the text went or to say
   * nothing, and it said nothing: the flush's answer was discarded, the next line detached the
   * model, and `buffersForTab` then stopped finding the buffer — so `tabBufferUnsaved`,
   * `shouldWarnOnClose` and `hasUnsavedTabs` all went back to "nothing to lose" about a handler
   * that no longer existed anywhere. The author saw only the freeze's standing "structural edits
   * are paused" toast, which does not say that a surface just deleted their work.
   */
  test("a dock tab switch under the freeze reports the handler it discarded", async () => {
    setEditing({ defName: "greet", type: "def" });
    await paintLogic();
    const ed = created.at(-1)!;
    ed.type("return 42;");
    const tab = activeTab.value!;
    expect(tabBufferUnsaved(tab)).toBe(true);
    resetNotifications();

    setTransactGate(() => "source-canonical");
    try {
      // Selecting Problems: lit replaced the Logic tab's body, so `afterRender` finds no container.
      litRender(nothing, dock);
      syncFunctionEditor(dock);
    } finally {
      setTransactGate(null);
    }

    expect(ed.disposed).toBe(true);
    expect(view.functionEditor).toBeNull();
    expect((tab.doc.document.state as any).greet.body).toBe("return 1;");
    // The buffer went with the text, so nothing else can ever report this.
    expect(tabBufferUnsaved(tab)).toBe(false);
    const toast = toasts.find((t) => t.key === `buffer-discarded:logic:${tab.id}`);
    expect(toast?.message).toBe(
      'The handler you were typing was discarded — it was never written into "/project/pages/index.json".',
    );
  });

  /** The pair the last round left half-done: the Close kept the text, and the next exit ate it. */
  test("a refused Close keeps the text, and the teardown that follows says it is gone", async () => {
    setEditing({ defName: "greet", type: "def" });
    await paintLogic();
    const ed = created.at(-1)!;
    ed.type("return 42;");
    const tab = activeTab.value!;

    setTransactGate(() => "source-canonical");
    try {
      await closeFunctionEditor();
      // Refused: the surface is exactly as it was, which is the whole point of the refusal.
      expect(ed.disposed).toBe(false);
      expect(tabBufferUnsaved(tab)).toBe(true);
      resetNotifications();

      // Now collapse the dock. Nothing is armed any more — the Close cancelled it — so the buffer
      // Is simply detached, and the only thing that can speak is the disposer.
      litRender(nothing, dock);
      syncFunctionEditor(dock);
    } finally {
      setTransactGate(null);
    }

    expect(ed.disposed).toBe(true);
    expect(tabBufferUnsaved(tab)).toBe(false);
    expect(toasts.some((t) => t.key === `buffer-discarded:logic:${tab.id}`)).toBe(true);
  });

  test("a teardown that carried the body says nothing at all", async () => {
    setEditing({ defName: "greet", type: "def" });
    await paintLogic();
    created.at(-1)!.type("return 42;");
    const tab = activeTab.value!;
    resetNotifications();

    litRender(nothing, dock);
    syncFunctionEditor(dock);

    expect((tab.doc.document.state as any).greet.body).toBe("return 42;");
    expect(toasts.filter((t) => t.key?.startsWith("buffer-discarded:"))).toEqual([]);
  });

  /**
   * THE NODE UNDER THE HANDLER CAN GO WHILE THE HANDLER IS OPEN.
   *
   * A collaborator deleting the button — or the author's own ⌘Z — leaves `editing.path` resolving
   * to nothing, and `mutateUpdateProperty` read `getNodeAtPath(...)[key]` straight through it. The
   * `undefined is not an object` escaped the commit, `commitBufferWrites` and
   * `disposeFunctionEditor` and came out of the dock panel's `afterRender`: the repaint aborted
   * mid-way with `cancel()` unrun, `dispose()` unrun, and a live 500ms timer left over an editor
   * whose container lit was about to replace — a timer that would read `""` off a detached model,
   * which is the exact defect this module was created to prevent.
   */
  test("the element the handler hangs off being deleted neither throws nor loses the alarm", async () => {
    setEditing({ eventKey: "onclick", path: ["children", 0], type: "event" });
    await paintLogic();
    const ed = created.at(-1)!;
    ed.type("boom()");
    const tab = activeTab.value!;
    // The delete arrives — over the wire, or from undo.
    (tab.doc.document.children as any[]).length = 0;
    resetNotifications();

    litRender(nothing, dock);
    expect(() => syncFunctionEditor(dock)).not.toThrow();

    // The teardown completed: no orphan editor, no orphan timer.
    expect(ed.disposed).toBe(true);
    expect(view.functionEditor).toBeNull();
    // And the write was reported as the non-event it was, rather than as a success.
    expect(toasts.some((t) => t.key === `buffer-discarded:logic:${tab.id}`)).toBe(true);
  });

  test("is a no-op with no target, and clears the target when no editor was mounted", async () => {
    setEditing(null);
    await closeFunctionEditor();
    expect(activeTab.value!.session.ui.editingFunction).toBeNull();

    setEditing({ defName: "greet", type: "def" });
    await closeFunctionEditor();
    expect(activeTab.value!.session.ui.editingFunction).toBeNull();
  });

  test("closing with no tab open returns without touching anything", async () => {
    closeAllTabs();
    expect(await closeFunctionEditor()).toBeUndefined();
  });

  /**
   * The Close reads its buffer and its target BEFORE the minify and tears down AFTER it, and a
   * retarget fits in between. The write belongs to the def whose buffer it is; the teardown belongs
   * to whatever is mounted when it runs — and those stopped being the same editor.
   */
  test("a retarget during a slow minify writes the old body and leaves the new editor alone", async () => {
    let resolveMinify: ((value: unknown) => void) | undefined;
    installMockPlatform({
      codeService: ((action: string) =>
        action === "minify"
          ? new Promise((resolve) => {
              resolveMinify = resolve;
            })
          : Promise.resolve(null)) as never,
    });
    setEditing({ defName: "greet", type: "def" });
    await paintLogic();
    const first = created.at(-1)!;
    first.type("return 42;");

    const closing = closeFunctionEditor();
    await flush();

    // "Open in editor" on an event binding while the minify is still in flight.
    setEditing({ eventKey: "onclick", path: ["children", 0], type: "event" });
    await paintLogic();
    const second = created.at(-1)!;
    expect(second).not.toBe(first);
    expect(first.disposed).toBe(true);

    resolveMinify!({ code: "return 42;" });
    await closing;

    // The buffer landed where it came from …
    expect((activeTab.value!.doc.document.state as any).greet.body).toBe("return 42;");
    // … and the surface the user is actually looking at is untouched.
    expect(second.disposed).toBe(false);
    expect(view.functionEditor).toBe(second as never);
    const stillOpen = activeTab.value!.session.ui.editingFunction as any;
    expect(stillOpen?.type).toBe("event");
    expect(stillOpen?.eventKey).toBe("onclick");
  });

  /**
   * The OTHER thing that fits inside the minify, and it is the ordinary one.
   *
   * Guarding the whole tail on `view.functionEditor === editor` conflates two obligations with two
   * different owners. Disposing belongs to the instance, and a retarget has a real claim on it.
   * Clearing the target belongs to the target, and the only thing with a claim on THAT is a
   * retarget that already replaced it — which is not what happens here. Collapse the dock, select
   * Problems, or ⌘\ to another pane during the minify and the editor is disposed and NOT replaced,
   * so the identity guard bailed and `editingFunction` was never cleared: the Logic tab stayed on
   * the strip, and re-opening the dock restored the body the user had just dismissed.
   */
  test("a Close whose editor is torn down mid-minify still clears the target", async () => {
    let resolveMinify: ((value: unknown) => void) | undefined;
    installMockPlatform({
      codeService: ((action: string) =>
        action === "minify"
          ? new Promise((resolve) => {
              resolveMinify = resolve;
            })
          : Promise.resolve(null)) as never,
    });
    setEditing({ defName: "greet", type: "def" });
    await paintLogic();
    const ed = created.at(-1)!;
    ed.type("return 42;");

    const closing = closeFunctionEditor();
    await flush();

    // The dock collapses / Problems is selected while the minify is in flight: the Logic tab
    // Repaints without a `.fw-code`, so `syncFunctionEditor` disposes on the spot. Nothing
    // Retargets, so nothing else will ever clear `editingFunction`.
    dock.textContent = "";
    // @ts-expect-error -- _$litPart$ is Lit's private render-part marker, not in the DOM types
    delete dock["_$litPart$"];
    syncFunctionEditor(dock);
    expect(ed.disposed).toBe(true);
    expect(view.functionEditor).toBeNull();

    resolveMinify!({ code: "return 42;" });
    await closing;

    expect(activeTab.value!.session.ui.editingFunction).toBeNull();
    expect((activeTab.value!.doc.document.state as any).greet.body).toBe("return 42;");
    expect(view.functionEditor).toBeNull();
  });
});

/**
 * A code-service round trip outlives the editor it was made for.
 *
 * Every one of these continuations used to answer through `view.functionEditor` — "whichever editor
 * is mounted right now" — which is only the requesting editor when nothing happened in between.
 * Retarget inside the round trip and the previous body's formatting, or the previous body's
 * diagnostics, land on the def you just opened.
 */
describe("continuations that outlive their editor", () => {
  test("a format that lands after a retarget does not write into its successor", async () => {
    const pendingFormats: ((value: unknown) => void)[] = [];
    installMockPlatform({
      codeService: ((action: string) =>
        action === "format"
          ? new Promise((resolve) => {
              pendingFormats.push(resolve);
            })
          : Promise.resolve(null)) as never,
    });
    setEditing({ defName: "greet", type: "def" });
    await paintLogic();
    const first = created.at(-1)!;

    setEditing({ defName: "plain", type: "def" });
    await paintLogic();
    const second = created.at(-1)!;
    expect(second).not.toBe(first);
    expect(second.value).toBe(""); // `plain` is not a function — empty body

    pendingFormats[0]!({ code: "return 1;\n" });
    await flush();

    expect(second.value).toBe("");
    expect(second._ignoreNextChange).toBeUndefined();
  });

  /**
   * …and the case identity cannot see at all, which is the COMMON one.
   *
   * Format-on-open is a cold code-service round trip over a 12.6 MB editor that has just appeared:
   * typing into it immediately is the normal thing to do. No remount happens, so
   * `view.functionEditor === editor` is true and every identity check in the continuation passes —
   * and what lands is the pre-typing body, formatted, on top of what the user wrote. Identity is
   * "is this the same editor"; staleness is "is this the same text", and `body` is exactly the text
   * the request was computed from.
   */
  test("a format that lands after the user typed does not overwrite them", async () => {
    const pendingFormats: ((value: unknown) => void)[] = [];
    installMockPlatform({
      codeService: ((action: string) =>
        action === "format"
          ? new Promise((resolve) => {
              pendingFormats.push(resolve);
            })
          : Promise.resolve(null)) as never,
    });
    setEditing({ defName: "greet", type: "def" });
    await paintLogic();
    const ed = created.at(-1)!;
    expect(ed.value).toBe("return 1;");

    ed.focused = true;
    ed.type("return 1; // mine");

    pendingFormats[0]!({ code: "return 1;\n" });
    await flush();

    expect(ed.value).toBe("return 1; // mine");
    // The guard that was there is still true — which is the whole point.
    expect(view.functionEditor).toBe(ed as never);
    expect(ed.disposed).toBe(false);
  });

  test("a lint from the previous mount does not mark the editor that replaced it", async () => {
    const pendingLints: ((value: unknown) => void)[] = [];
    installMockPlatform({
      codeService: ((action: string) =>
        action === "lint"
          ? new Promise((resolve) => {
              pendingLints.push(resolve);
            })
          : Promise.resolve(null)) as never,
    });
    setEditing({ defName: "greet", type: "def" });
    await paintLogic();
    const first = created.at(-1)!;

    first.type("first()");
    await sleep(800); // The debounced lint fired; its request is pending
    const staleIdx = pendingLints.length - 1;
    setModelMarkers.mockClear();

    setEditing({ defName: "plain", type: "def" });
    await paintLogic();
    expect(created.at(-1)).not.toBe(first);

    pendingLints[staleIdx]!({
      diagnostics: [
        { labels: [{ span: { column: 1, line: 1 } }], message: "stale", severity: "warning" },
      ],
    });
    await flush();

    // `lintGen` counts within ONE mount, so the stale closure's generation still matches its own
    // Counter — nothing but the editor identity can tell this result apart from a current one.
    expect(setModelMarkers).not.toHaveBeenCalled();
  });
});

describe("registerFunctionCompletions", () => {
  test("registers once and suggests state members with kind by def shape", async () => {
    view._completionRegistered = false;
    await registerFunctionCompletions();
    await registerFunctionCompletions();
    expect(registerCompletionItemProvider).toHaveBeenCalledTimes(1);

    const [language, provider] = registerCompletionItemProvider.mock.calls[0] as any[];
    expect(language).toBe("javascript");
    expect(provider.triggerCharacters).toEqual(["."]);

    const model = { getWordUntilPosition: () => ({ endColumn: 4, startColumn: 1 }) };
    const { suggestions } = provider.provideCompletionItems(model, { lineNumber: 7 });
    const byLabel = Object.fromEntries(suggestions.map((s: any) => [s.label, s]));
    expect(byLabel["state.greet"].kind).toBe(1); // Function via $prototype
    expect(byLabel["state.handler"].kind).toBe(1); // Function via $handler
    expect(byLabel["state.fetcher"].kind).toBe(9); // Property via other $prototype
    expect(byLabel["state.plain"].kind).toBe(4); // Variable
    expect(byLabel["state.greet"].insertText).toBe("state.greet");
    expect(byLabel["state.greet"].range).toEqual({
      endColumn: 4,
      endLineNumber: 7,
      startColumn: 1,
      startLineNumber: 7,
    });
  });

  test("appends blessed-global completions with catalog descriptions", async () => {
    view._completionRegistered = false;
    await registerFunctionCompletions();
    const [, provider] = registerCompletionItemProvider.mock.calls.at(-1)! as any[];
    const model = { getWordUntilPosition: () => ({ endColumn: 4, startColumn: 1 }) };
    const { suggestions } = provider.provideCompletionItems(model, { lineNumber: 2 });
    const byLabel = Object.fromEntries(suggestions.map((s: any) => [s.label, s]));
    expect(byLabel["Math.max"].insertText).toBe("window.Math.max");
    expect(byLabel["Math.max"].kind).toBe(1);
    expect(byLabel["Math.max"].documentation).toContain("window#/Math/max");
    expect(byLabel["JSON.parse"].insertText).toBe("window.JSON.parse");
  });

  test("named formulas complete as functions with their description as documentation", async () => {
    const tab = activeTab.value!;
    (tab.doc.document as any).state.lineTotal = {
      $expression: { operator: "*", target: { $ref: "$args/a" }, value: 2 },
      description: "Multiplies by two.",
      parameters: ["a"],
    };
    view._completionRegistered = false;
    await registerFunctionCompletions();
    const [, provider] = registerCompletionItemProvider.mock.calls.at(-1)! as any[];
    const model = { getWordUntilPosition: () => ({ endColumn: 4, startColumn: 1 }) };
    const { suggestions } = provider.provideCompletionItems(model, { lineNumber: 2 });
    const byLabel = Object.fromEntries(suggestions.map((s: any) => [s.label, s]));
    expect(byLabel["state.lineTotal"].kind).toBe(1);
    expect(byLabel["state.lineTotal"].documentation).toBe("Multiplies by two.");
    // Plain signals stay undocumented variables
    expect(byLabel["state.plain"].kind).toBe(4);
    expect(byLabel["state.plain"].documentation).toBeUndefined();
  });

  test("returns no suggestions without an active tab", async () => {
    // Register our own provider rather than borrowing one a previous test happened to leave behind.
    await registerFunctionCompletions();
    closeAllTabs();
    const [, provider] = registerCompletionItemProvider.mock.calls.at(-1)! as any[];
    const model = { getWordUntilPosition: () => ({ endColumn: 1, startColumn: 1 }) };
    expect(provider.provideCompletionItems(model, { lineNumber: 1 }).suggestions).toEqual([]);
  });
});
