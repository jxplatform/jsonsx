/**
 * Function-editor panel tests (E9). Monaco cannot load in happy-dom, so editor.api is mocked with a
 * minimal fake editor that mirrors the bits editors.ts relies on (create/get/setValue/dispose/
 * change events, setValue firing onDidChangeModelContent like real Monaco). The tests then drive
 * the real renderFunctionEditor/registerFunctionCompletions flows: canvas teardown, format/lint on
 * open, target re-sync, debounced state sync for defs and events, and the state completion
 * provider.
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

  constructor(_el: unknown, options: Record<string, unknown>) {
    this.value = (options?.value as string) ?? "";
    this.options = options;
  }
  getValue() {
    return this.value;
  }
  /** Mirrors Monaco: programmatic setValue also fires onDidChangeModelContent. */
  setValue(v: string) {
    this.value = v;
    this.fire();
  }
  dispose() {
    this.disposed = true;
  }
  onDidChangeModelContent(fn: ChangeListener) {
    this.listeners.push(fn);
    return { dispose: () => {} };
  }
  getModel() {
    return this.model;
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

const { registerFunctionCompletions, renderFunctionEditor } = await import("../src/panels/editors");
const { canvasPanels, initShellRefs, registerRenderer } = await import("../src/store");
const { view } = await import("../src/view");
const { activeTab, closeAllTabs } = await import("../src/workspace/workspace");

document.body.innerHTML = `<div id="app"><div id="canvas-wrap"></div></div>`;
initShellRefs();

// Destructuring store.canvasWrap would snapshot the pre-initShellRefs null — query instead
const canvasWrap = document.querySelector("#canvas-wrap") as HTMLElement;

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

beforeEach(() => {
  codeServiceCalls = [];
  formatResult = null;
  lintResult = null;
  created.length = 0;
  toolbarRender.mockClear();
  leftPanelRender.mockClear();
  setModelMarkers.mockClear();
  view.functionEditor = null;
  view.monacoEditor = null;
  installMockPlatform({
    codeService: (async (action: string, payload: unknown) => {
      codeServiceCalls.push([action, payload]);
      return action === "format" ? formatResult : lintResult;
    }) as never,
  });
  resetWorkspaceWithTab(docFixture(), { documentPath: "/project/pages/index.json" });
});

describe("renderFunctionEditor — def target", () => {
  test("tears down canvas state and renders the editor", () => {
    const dndCleanup = mock(() => {});
    const eventCleanup = mock(() => {});
    view.canvasDndCleanups = [dndCleanup];
    view.canvasEventCleanups = [eventCleanup];
    canvasPanels.push({ id: "panel" } as never);
    setEditing({ defName: "greet", type: "def" });

    renderFunctionEditor();

    expect(dndCleanup).toHaveBeenCalledTimes(1);
    expect(eventCleanup).toHaveBeenCalledTimes(1);
    expect(view.canvasDndCleanups).toHaveLength(0);
    expect(view.canvasEventCleanups).toHaveLength(0);
    expect(canvasPanels).toHaveLength(0);

    // The editor surface is rendered; the Back button + breadcrumb live in the tab bar now.
    expect(canvasWrap.querySelector(".source-editor")).not.toBeNull();
    expect(canvasWrap.querySelector(".breadcrumb-item")).toBeNull();
    expect(canvasWrap.style.padding).toBe("0px");

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
    renderFunctionEditor();
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

  test("re-render with the same target re-syncs the buffer instead of recreating", () => {
    setEditing({ defName: "greet", type: "def" });
    renderFunctionEditor();
    expect(created).toHaveLength(1);
    const [ed] = created;

    // Buffer drifted from the document → re-sync writes the body back with the ignore flag
    ed!.value = "drifted()";
    renderFunctionEditor();
    expect(created).toHaveLength(1);
    expect(ed!.value).toBe("return 1;");

    // Buffer already in sync → nothing happens
    renderFunctionEditor();
    expect(created).toHaveLength(1);
    expect(ed!.value).toBe("return 1;");
    expect(ed!.disposed).toBe(false);
  });

  test("debounced edits write the body back to the state def and lint the new code", async () => {
    setEditing({ defName: "greet", type: "def" });
    renderFunctionEditor();
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

  test("renders an empty buffer for missing or non-function defs", () => {
    setEditing({ defName: "missing", type: "def" });
    renderFunctionEditor();
    expect(created.at(-1)!.value).toBe("");

    setEditing({ defName: "plain", type: "def" });
    renderFunctionEditor();
    expect(created.at(-1)!.value).toBe("");
    // Non-function defs fall back to the default arg names
    const formatCall = codeServiceCalls.findLast(([action]) => action === "format")!;
    expect(formatCall[1].args).toEqual(["state", "event"]);
  });
});

describe("renderFunctionEditor — event target", () => {
  test("switching targets disposes previous editors and loads the event body", () => {
    setEditing({ defName: "greet", type: "def" });
    renderFunctionEditor();
    const [first] = created;
    const strayMonaco = { dispose: mock(() => {}) };
    view.monacoEditor = strayMonaco as never;

    setEditing({ eventKey: "onclick", path: ["children", 0], type: "event" });
    renderFunctionEditor();

    expect(first!.disposed).toBe(true);
    expect(strayMonaco.dispose).toHaveBeenCalledTimes(1);
    expect(view.monacoEditor).toBeNull();
    expect(created).toHaveLength(2);
    expect(created[1]!.value).toBe("go()");
  });

  test("debounced edits update the event handler property preserving its shape", async () => {
    setEditing({ eventKey: "onclick", path: ["children", 0], type: "event" });
    renderFunctionEditor();
    const ed = created.at(-1)!;

    ed.type("doIt(state)");
    await sleep(600);
    // Field-by-field assertions — the document is a reactive proxy, which trips toMatchObject
    const [node] = activeTab.value!.doc.document.children as any[];
    expect(node.onclick.$prototype).toBe("Function");
    expect(node.onclick.body).toBe("doIt(state)");
    expect([...node.onclick.parameters]).toEqual(["state", "event"]);
  });

  test("renders an empty buffer for an unrecognized editing type", () => {
    setEditing({ type: "mystery" });
    renderFunctionEditor();
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
    renderFunctionEditor();
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

  test("renders an empty buffer when the event path resolves to nothing", () => {
    setEditing({ eventKey: "onclick", path: ["children", 99], type: "event" });
    renderFunctionEditor();
    expect(created.at(-1)!.value).toBe("");
  });
});

describe("registerFunctionCompletions", () => {
  test("registers once and suggests state members with kind by def shape", () => {
    view._completionRegistered = false;
    registerFunctionCompletions();
    registerFunctionCompletions();
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

  test("returns no suggestions without an active tab", () => {
    closeAllTabs();
    const [, provider] = registerCompletionItemProvider.mock.calls[0]! as any[];
    const model = { getWordUntilPosition: () => ({ endColumn: 1, startColumn: 1 }) };
    expect(provider.provideCompletionItems(model, { lineNumber: 1 }).suggestions).toEqual([]);
  });
});
