/**
 * Diff-gap tests for `src/editor/shortcuts.ts` and the "/" trigger in `src/editor/inline-edit.ts`.
 *
 * `tests/shortcuts.test.ts` drives the chord table through `document.dispatchEvent`, which is the
 * right way to describe a keyboard — and it is exactly why a family of guards inside the verbs is
 * invisible to it. A record's `when` is what decides whether a chord reaches `run` at all, so the
 * "there is no document / nothing is selected" arms of the verbs below can never be reached from a
 * keypress: the registry has already declined. They are reached here the way the palette, the
 * assistant and `__jxAutomation` reach a verb — through the RECORD (`canvasCommands` is exported
 * for this) or through the dependency the default set was registered with.
 *
 * Every case asserts both halves: the state the verb DOES produce when its precondition holds, and
 * the state it leaves untouched when it does not. A guard that stopped guarding throws; a guard
 * inverted stops acting. One test per line, so a mutation names its own case.
 */
import {
  caretAt,
  flush,
  installMockPlatform,
  registerPrimaryStage,
  resetStudioState,
  resetWorkspaceWithTab,
} from "./harness";
import { afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { notifyModule } from "./notify-mock";
import type { AnyCommand, CommandRegistry } from "../src/commands/registry";
import type { CommandContext } from "../src/commands/context";
import type { CommandDeps } from "../src/commands/defaults";
import type { JxMutableNode } from "@jxsuite/schema/types";
import type { ProjectOpenOutcome, ProjectOpenTarget } from "../src/editor/shortcuts";

// ─── Module mocks (must precede the shortcuts import) ─────────────────────────

const openQuickSearch = mock(() => {});
void mock.module("../src/panels/quick-search.js", () => ({ openQuickSearch }));

/* The clipboard trio is `editor/context-menu.ts`'s; `tests/context-menu.test.ts` owns it. Replacing
   a module means answering for all its exports, and the Outline panel — pulled in by the ⌘1–8
   roster — imports the menu helpers too. */
const copyNode = mock(async () => {});
const cutNode = mock(async () => {});
const pasteNode = mock(async () => {});
const showContextMenu = mock(() => {});
const dismissContextMenu = mock(() => {});
void mock.module("../src/editor/context-menu.js", () => ({
  clipboardCommands: () => [],
  copyNode,
  cutNode,
  dismissContextMenu,
  pasteNode,
  showContextMenu,
}));

void mock.module("../src/services/notify.js", () => notifyModule(() => {}));

/**
 * The `CommandDeps` object `registerStudioCommands` builds, captured on its way to the default set.
 *
 * `toggleShellDock`'s `"bottom"` arm is the ⌘J-to-the-Assistant branch, and `commands/defaults.ts`
 * says in as many words that no record calls it any more ("that branch is now unreachable") — the
 * Bottom dock is a real dock with its own `view.toggleBottomDock` in `shell.ts`. The dependency
 * still DECLARES `bottom` in its `DockId` union, so the injection point is the honest way in: the
 * real deps object, the real registry, the real `view.setAssistant`.
 */
const realDefaults = await import("../src/commands/defaults");
const realDefaultCommands = realDefaults.defaultCommands;
let studioDeps: CommandDeps | undefined;
void mock.module("../src/commands/defaults.js", () => ({
  ...realDefaults,
  defaultCommands: (deps: CommandDeps) => {
    studioDeps = deps;
    return realDefaultCommands(deps);
  },
}));

const { canvasCommands, initShortcuts, registerStudioCommands } =
  await import("../src/editor/shortcuts");
const { createCommandRegistry } = await import("../src/commands/registry");
const { makeContext } = await import("../src/commands/context");
const { activeTab, closeAllTabs } = await import("../src/workspace/workspace");
const { initShellRefs } = await import("../src/store");
const { initLayers } = await import("../src/ui/layers");
const { registerShellViewCommands, resetProjectShell, setDockCollapsed, shell } =
  await import("../src/shell");
const { inspectorTab, setInspectorTab } = await import("../src/panels/right-panel");
const { handleSlashTrigger, isEditing, setSlashController, startEditing, stopEditing } =
  await import("../src/editor/inline-edit");

// ─── Environment ──────────────────────────────────────────────────────────────

globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
  setTimeout(() => cb(0), 0);
  return 0;
}) as typeof requestAnimationFrame;

const setPan = mock((_x: number, _y: number) => {});
const applyTransform = mock(() => {});
const pointerContext = { applyTransform, canvasMode: "design", panX: 0, panY: 0, setPan };
const pointer = () => pointerContext;

const saveDocument = mock(() => {});
const openProject = mock(async (_target: ProjectOpenTarget) => "opened" as ProjectOpenOutcome);
const openInBrowser = mock(() => {});

/** How many times the refusal probe's `run` actually ran — 0 is what a refusal looks like. */
let probeRuns = 0;
/** Answers `test.refuseOnRun`'s `enablement` gives, in order. Empty = enabled. */
let probeEnablement: boolean[] = [];

function freshDoc(): JxMutableNode {
  return {
    children: [
      { tagName: "p", textContent: "one" },
      { children: [{ tagName: "span", textContent: "inner" }], tagName: "div" },
      { tagName: "p", textContent: "three" },
    ],
    tagName: "div",
  };
}

let ctx: CommandContext = makeContext();
let registry: CommandRegistry;
let canvasRecords: Map<string, AnyCommand>;

/** One of the records `canvasCommands` declares, addressed the way the palette addresses it. */
function canvasRecord(id: string): AnyCommand {
  const record = canvasRecords.get(id);
  if (!record) {
    throw new Error(`no canvas command "${id}"`);
  }
  return record;
}

/** Run a record directly — `when` is the registry's gate, and these cases are behind it. */
function runRecord(record: AnyCommand): void {
  void record.run(ctx, undefined as never);
}

function childCount(): number {
  return (activeTab.value!.doc.document.children as unknown[]).length;
}

function pressDoc(key: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key, ...init });
  document.dispatchEvent(event);
  return event;
}

beforeAll(() => {
  for (const id of [
    "activity-bar",
    "left-panel",
    "right-panel",
    "toolbar",
    "statusbar",
    "layer-popover",
    "layer-modal",
    "layer-dialog",
  ]) {
    const el = document.createElement("div");
    el.id = id;
    document.body.append(el);
  }
  initShellRefs();
  registerPrimaryStage();
  initLayers();
  installMockPlatform();
  resetStudioState({ isSiteProject: true });

  canvasRecords = new Map(canvasCommands(pointer).map((record) => [record.id, record]));

  registry = createCommandRegistry({ getContext: () => ctx, mac: false });
  registerStudioCommands(
    registry,
    { openInBrowser, openProject, saveDocument },
    () => pointerContext,
  );
  // ⌘J's legacy branch runs `view.setAssistant`, which is `shell.ts`'s record — the app's bootstrap
  // Composes it in, and so does this fixture, or the branch would be inert for a reason of the
  // Fixture's own making.
  registerShellViewCommands(registry, { inspectorTab, setInspectorTab });
  /* The dispatcher's refusal path needs a command that is enabled when the registry ASKS and
     refused when it RUNS — the TOCTOU `handleKeyEvent` cannot rule out, since `run` re-reads the
     context. Nothing in the shipped set can be made to do that on demand. */
  registry.register({
    category: "View",
    enablement: () => probeEnablement.shift() ?? true,
    id: "test.refuseOnRun",
    keybinding: "f9",
    level: "application",
    run: () => {
      probeRuns += 1;
    },
    title: "Refusal Probe",
  });
  /* A refusal is the ONLY error the dispatcher absorbs; anything else is a bug in a `run` and has
     to keep travelling. This probe is the other side of that `instanceof`: the error it throws even
     carries a `commandId`, so absorbing it by DUCK type instead of by class would show up as a
     claimed chord. */
  registry.register({
    category: "View",
    id: "test.throwOnRun",
    keybinding: "f10",
    level: "application",
    run: () => {
      throw Object.assign(new Error("probe blew up"), { commandId: "test.throwOnRun" });
    },
    title: "Throwing Probe",
  });
  initShortcuts(registry, () => pointerContext);
});

beforeEach(() => {
  ctx = makeContext();
  probeRuns = 0;
  probeEnablement = [];
  for (const m of [setPan, applyTransform, saveDocument, openProject, openInBrowser]) {
    m.mockClear();
  }
  resetProjectShell();
  resetWorkspaceWithTab(freshDoc());
});

// ─── The selection verbs, past the record's `when` ────────────────────────────

describe("selection verbs with no open document", () => {
  test("Select Next Sibling moves the selection, and stands down with no tab", () => {
    const tab = activeTab.value!;
    tab.session.selection = [["children", 0]];
    runRecord(canvasRecord("selection.selectNext"));
    expect(tab.session.selection).toEqual([["children", 1]]);

    // Nothing to navigate: the verb reads `activeTab` itself, and the palette can still call it.
    closeAllTabs();
    expect(() => runRecord(canvasRecord("selection.selectNext"))).not.toThrow();
    expect(activeTab.value).toBeFalsy();
  });

  test("Select All selects the siblings, and stands down with no tab", () => {
    const tab = activeTab.value!;
    tab.session.selection = [["children", 0]];
    runRecord(canvasRecord("selection.selectAll"));
    expect(tab.session.selection).toEqual([
      ["children", 0],
      ["children", 1],
      ["children", 2],
    ]);

    closeAllTabs();
    expect(() => runRecord(canvasRecord("selection.selectAll"))).not.toThrow();
    expect(activeTab.value).toBeFalsy();
  });

  test("Select First Child descends, and stands down with nothing selected", () => {
    const tab = activeTab.value!;
    tab.session.selection = [["children", 1]];
    runRecord(canvasRecord("selection.selectFirstChild"));
    expect(tab.session.selection).toEqual([["children", 1, "children", 0]]);

    // No primary selection: there is no node to descend FROM, and inventing one would select a
    // Path the author never pointed at.
    tab.session.selection = [];
    runRecord(canvasRecord("selection.selectFirstChild"));
    expect(tab.session.selection).toEqual([]);
  });

  test("Select Parent walks out a rung, and stands down with nothing selected", () => {
    const tab = activeTab.value!;
    tab.session.selection = [["children", 1, "children", 0]];
    runRecord(registry.get("selection.selectParent")!);
    expect(tab.session.selection).toEqual([["children", 1]]);

    tab.session.selection = [];
    runRecord(registry.get("selection.selectParent")!);
    expect(tab.session.selection).toEqual([]);
  });

  test("Insert Paragraph After inserts for a child, and refuses the document element", () => {
    const tab = activeTab.value!;
    tab.session.selection = [["children", 0]];
    runRecord(canvasRecord("selection.insertSibling"));
    expect(childCount()).toBe(4);
    expect((tab.doc.document.children as unknown[])[1]).toEqual({ tagName: "p", textContent: "" });
    expect(tab.session.selection).toEqual([["children", 1]]);

    // The document element has no sibling slot to insert into.
    tab.session.selection = [[]];
    runRecord(canvasRecord("selection.insertSibling"));
    expect(childCount()).toBe(4);
    expect(tab.session.selection).toEqual([[]]);
  });
});

// ─── Zoom with no open document ───────────────────────────────────────────────

describe("zoom verbs with no open document", () => {
  test("Zoom In scales the artboard, and leaves the stage alone with no tab", () => {
    const tab = activeTab.value!;
    runRecord(canvasRecord("canvas.zoomIn"));
    expect(tab.session.ui.zoom).toBeCloseTo(1.2);
    expect(applyTransform).toHaveBeenCalledTimes(1);

    // The zoom is per-TAB state; with no tab there is nothing to write and nothing to redraw.
    closeAllTabs();
    applyTransform.mockClear();
    expect(() => runRecord(canvasRecord("canvas.zoomIn"))).not.toThrow();
    expect(applyTransform).not.toHaveBeenCalled();
    expect(setPan).not.toHaveBeenCalled();
  });
});

// ─── ⌘J's legacy Assistant branch ─────────────────────────────────────────────

describe("toggleDock's dock ids", () => {
  test('"bottom" routes to the Assistant tab rather than to a dock flag', () => {
    const tab = activeTab.value!;
    setDockCollapsed("right", true);
    setInspectorTab("properties");

    // Not showing → show it: reveal the Inspector and select the Assistant tab.
    studioDeps!.toggleDock("bottom");
    expect(shell.docks.right.collapsed).toBe(false);
    expect(inspectorTab()).toBe("assistant");

    // Showing → step off it. Idempotent by state, so the dock stays where the author left it.
    studioDeps!.toggleDock("bottom");
    expect(inspectorTab()).toBe("properties");
    expect(shell.docks.right.collapsed).toBe(false);
    expect(tab.session.ui.rightTab).toBe("properties");
  });

  test('"navigator" flips its dock and leaves the Assistant alone', () => {
    setDockCollapsed("left", false);
    setInspectorTab("style");

    studioDeps!.toggleDock("navigator");
    expect(shell.docks.left.collapsed).toBe(true);
    expect(inspectorTab()).toBe("style");

    studioDeps!.toggleDock("navigator");
    expect(shell.docks.left.collapsed).toBe(false);
  });
});

// ─── The dispatcher's refusal path ────────────────────────────────────────────

describe("dispatcher", () => {
  test("a chord whose command is enabled runs it and claims the key", () => {
    const event = pressDoc("F9");
    expect(probeRuns).toBe(1);
    expect(event.defaultPrevented).toBe(true);
  });

  test("a command that refuses between the check and the run still claims the key", () => {
    // Enabled when `handleKeyEvent` asks, refused when `run` re-reads the context: the registry
    // Throws `CommandUnavailableError` out of `handleKeyEvent`, and the chord is still spoken for.
    probeEnablement = [true, false];
    const event = pressDoc("F9");
    expect(probeRuns).toBe(0);
    expect(event.defaultPrevented).toBe(true);
  });

  test("any other error from a run keeps travelling", () => {
    // The realm's error channel is where an escaped listener error lands; happy-dom reports it
    // There rather than letting `dispatchEvent` rethrow, exactly as a browser does.
    const seen: string[] = [];
    const onError = (event: Event) => {
      seen.push((event as ErrorEvent).message);
    };
    window.addEventListener("error", onError);
    const quiet = console.error;
    console.error = () => {};
    const event = pressDoc("F10");
    console.error = quiet;
    window.removeEventListener("error", onError);

    expect(seen).toEqual(["probe blew up"]);
    // And the chord is NOT claimed: only a refusal — a command that exists and cannot act — is.
    expect(event.defaultPrevented).toBe(false);
  });
});

// ─── The "/" trigger, driven from the editing host ────────────────────────────

describe("handleSlashTrigger", () => {
  /** Filters the injected controller was asked to show — one entry per menu open. */
  const opens: string[] = [];
  let block: HTMLElement;

  setSlashController({
    dismiss: () => {},
    isOpen: () => false,
    show: (_anchor, filter) => {
      opens.push(filter);
    },
  });

  function slashKey(init: KeyboardEventInit = {}): void {
    handleSlashTrigger(
      new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "/", ...init }),
    );
  }

  beforeEach(() => {
    opens.length = 0;
    block = document.createElement("p");
    block.textContent = "";
    document.body.append(block);
    startEditing(block, ["children", 0], {
      onCommit: () => {},
      onEnd: () => {},
      onInsert: () => {},
      onSplit: () => {},
    });
  });

  afterEach(() => {
    if (isEditing()) {
      stopEditing();
    }
    block.remove();
  });

  test("another key, or a modified slash, is left as typing", async () => {
    caretAt(block, 0);

    handleSlashTrigger(new KeyboardEvent("keydown", { bubbles: true, key: "x" }));
    slashKey({ ctrlKey: true });
    slashKey({ metaKey: true });
    await flush();
    expect(opens).toEqual([]);

    // The same caret, the same block: only the bare "/" opens the list.
    slashKey();
    await flush();
    expect(opens).toEqual([""]);
  });

  test("a slash with no caret range in this realm opens nothing", async () => {
    caretAt(block, 0);
    window.getSelection()!.removeAllRanges();

    slashKey();
    await flush();
    expect(opens).toEqual([]);

    // Put the caret back and the same key opens the menu — the refusal was the missing range.
    caretAt(block, 0);
    slashKey();
    await flush();
    expect(opens).toEqual([""]);
  });
});
