/**
 * The first real command records, and the context they close over.
 *
 * Every assertion here is about the SET as a whole — it registers cleanly, its chords do not
 * collide, its placements satisfy the matrix, and each record's predicates and `run` do what the
 * record says. Wiring is next wave; the contract is now.
 */
import { describe, expect, test } from "bun:test";
import {
  defaultCommands,
  defaultCommandSet,
  INSPECTOR_TABS,
  noopCommandDeps,
  panelFocusCommands,
  RAIL_CHORD_LIMIT,
} from "../src/commands/defaults";
import type { CommandDeps, DockId, PaletteMode, RailPanel } from "../src/commands/defaults";
import { appCommandSet } from "../src/commands/app-commands";
import { navigatorPanelSet } from "../src/panels/navigator-panels";
import { createCommandRegistry } from "../src/commands/registry";
import { checkPlacements } from "../src/commands/levels";
import { checkChromeBudget } from "../src/commands/budget";
import { CAPABILITIES, emptyContext, makeContext } from "../src/commands/context";

/**
 * A stand-in rail, so the ⌘1–8 generator is testable without the panel registry.
 *
 * Four shapes in one list: two ordinary rail panels, one that holds a rail slot but is not built
 * yet (`when: () => false`), and one that is reachable by name with no rail button at all.
 */
const RAIL_PANELS: readonly RailPanel[] = [
  { id: "files", title: "Files" },
  { id: "layers", title: "Outline" },
  { id: "search", title: "Search", when: () => false },
  { id: "insert", title: "Insert", rail: false },
];

/** Deps that record what a `run` asked for, so a command's body is observable. */
function recordingDeps() {
  const calls: string[] = [];
  const deps: CommandDeps = {
    saveDocument: () => void calls.push("saveDocument"),
    undo: () => void calls.push("undo"),
    redo: () => void calls.push("redo"),
    openInBrowser: () => void calls.push("openInBrowser"),
    closeDocument: () => void calls.push("closeDocument"),
    duplicateSelection: () => void calls.push("duplicateSelection"),
    deleteSelection: () => void calls.push("deleteSelection"),
    selectParent: () => void calls.push("selectParent"),
    toggleDock: (dock: DockId) => void calls.push(`toggleDock:${dock}`),
    toggleZen: () => void calls.push("toggleZen"),
    openPalette: (mode: PaletteMode) => void calls.push(`openPalette:${mode}`),
    openProject: () => void calls.push("openProject"),
    navigatorPanels: RAIL_PANELS,
    focusPanel: (panelId: string) => void calls.push(`focusPanel:${panelId}`),
    focusInspectorTab: (tabId: string) => void calls.push(`focusInspectorTab:${tabId}`),
    cycleRegion: (direction: 1 | -1) => void calls.push(`cycleRegion:${direction}`),
  };
  return { calls, deps };
}

/** A context in which every default command is both visible and enabled. */
const everythingContext = () =>
  makeContext({
    project: { open: true, isSite: true, isRepo: true },
    document: { open: true, dirty: true, mode: "json", canUndo: true, canRedo: true },
    editor: { kind: "canvas" },
    selection: { count: 1, kind: "h1" },
  });

describe("the set as a whole", () => {
  test("registers cleanly — no duplicate id, no chord conflict, no misplacement", () => {
    const registry = createCommandRegistry({ getContext: everythingContext, mac: true });
    expect(() => registry.registerAll(defaultCommandSet())).not.toThrow();
    expect(registry.list().length).toBeGreaterThan(10);
  });

  test("satisfies the level × placement matrix", () => {
    expect(checkPlacements(defaultCommandSet())).toEqual([]);
  });

  test("satisfies the chrome budget", () => {
    expect(checkChromeBudget({ commands: defaultCommandSet() })).toEqual([]);
  });

  test("every record is named, categorised and levelled", () => {
    for (const command of defaultCommandSet()) {
      expect(command.title).not.toBe("");
      expect(command.category).toBeTruthy();
      expect(command.level).toBeTruthy();
    }
  });

  test("every gated record carries the sentence that explains the gate", () => {
    // Principle 4: no control may render permanently dead with no explanation.
    for (const command of defaultCommandSet()) {
      if (command.when || command.enablement) {
        expect(command.requires).toBeTruthy();
      }
    }
  });

  test("every selection-level record dispatches in the canvas scope, not globally", () => {
    // Level and keyScope are two fields: ⌘D acts on the selection but must not fire while a text
    // Caret owns the keyboard, and the caret scope simply omits "canvas".
    for (const command of defaultCommandSet()) {
      if (command.level === "selection") {
        expect(command.keyScope).toBe("canvas");
      }
    }
  });
});

describe("the records that settle an existing argument", () => {
  test("⌘W is document.close — one record, so the chord and the tab × cannot disagree", () => {
    const registry = createCommandRegistry({ getContext: everythingContext, mac: true });
    registry.registerAll(defaultCommandSet());
    expect(registry.keymap.resolveChord("mod+w", ["global"])?.commandId).toBe("document.close");
    expect(registry.keymap.formatBinding("document.close")).toBe("⌘W");
  });

  test("duplicate is defined once and projected to the assistant from the same record", () => {
    const duplicate = defaultCommandSet().find((c) => c.id === "selection.duplicate");
    expect(duplicate?.aiTool?.name).toBe("duplicate_node");
    expect(duplicate?.requires).toBe("an element that has a sibling position");
    expect(duplicate?.undo).toBe("document");
  });

  test("duplicate refuses the document root, like delete", () => {
    // Duplicating needs a sibling position to insert into; the root and a repeater template have
    // None, and mutateDuplicateNode would splice at a non-numeric index. Both rendering surfaces
    // Hand-guarded this before the record declared it.
    const registry = createCommandRegistry({
      getContext: () => makeContext({ selection: { count: 1, isRoot: true } }),
      mac: true,
    });
    registry.registerAll(defaultCommandSet());
    expect(registry.isVisible("selection.duplicate")).toBe(true);
    expect(registry.isEnabled("selection.duplicate")).toBe(false);
    expect(registry.disabledReason("selection.duplicate")).toContain("sibling position");
  });

  test("delete is destructive, undoable, and refuses the document root", () => {
    const registry = createCommandRegistry({
      getContext: () => makeContext({ selection: { count: 1, isRoot: true } }),
      mac: true,
    });
    registry.registerAll(defaultCommandSet());
    const remove = registry.get("selection.delete");
    expect(remove?.destructive).toBe(true);
    expect(remove?.group).toBe("9_danger");
    expect(registry.isVisible("selection.delete")).toBe(true);
    expect(registry.isEnabled("selection.delete")).toBe(false);
    expect(registry.disabledReason("selection.delete")).toContain("not the document root");
  });

  test("the Command Bar's primary cluster is Save, Undo, Redo and Open in Browser", () => {
    const registry = createCommandRegistry({ getContext: everythingContext, mac: true });
    registry.registerAll(defaultCommandSet());
    expect(
      registry
        .forPlacement("commandbar/primary")
        .map((c) => c.id)
        .toSorted(),
    ).toEqual(["edit.redo", "edit.undo", "file.save", "view.openInBrowser"]);
  });
});

describe("gating", () => {
  test("with nothing open, only the application-level commands are live", () => {
    const registry = createCommandRegistry({ getContext: emptyContext, mac: true });
    registry.registerAll(defaultCommandSet());
    const live = registry.visible().map((c) => c.id);
    expect(live).toContain("palette.open");
    expect(live).toContain("project.open");
    expect(live).not.toContain("file.save");
    expect(live).not.toContain("selection.duplicate");
  });

  test("Open in Browser hides on a non-site project and disables without a document", () => {
    const registry = createCommandRegistry({
      getContext: () => makeContext({ project: { open: true, isSite: true } }),
      mac: true,
    });
    registry.registerAll(defaultCommandSet());
    expect(registry.isVisible("view.openInBrowser")).toBe(true);
    expect(registry.isEnabled("view.openInBrowser")).toBe(false);
    expect(registry.disabledReason("view.openInBrowser")).toBe("a built page to open");
  });

  test("Undo is visible but disabled on an open document with no history", () => {
    const registry = createCommandRegistry({
      getContext: () => makeContext({ document: { open: true } }),
      mac: true,
    });
    registry.registerAll(defaultCommandSet());
    expect(registry.isVisible("edit.undo")).toBe(true);
    expect(registry.isEnabled("edit.undo")).toBe(false);
    expect(registry.disabledReason("edit.undo")).toBe("a change to undo");
  });
});

describe("the implementations", () => {
  test("every command's run reaches its injected dependency", () => {
    const { calls, deps } = recordingDeps();
    const registry = createCommandRegistry({ getContext: everythingContext, mac: true });
    registry.registerAll(defaultCommands(deps));
    for (const command of registry.list()) {
      // `panel.focus.search` stands for a declared-but-unbuilt surface: its own `when` refuses it,
      // Which is the composition this loop should skip rather than assert against.
      if (registry.isEnabled(command.id)) {
        void registry.run(command.id);
      }
    }
    expect(calls).toEqual([
      "saveDocument",
      "closeDocument",
      "openInBrowser",
      "undo",
      "redo",
      "duplicateSelection",
      "deleteSelection",
      "selectParent",
      "toggleDock:navigator",
      "toggleDock:inspector",
      "toggleDock:bottom",
      "toggleZen",
      "openPalette:picker",
      "openPalette:files",
      "openPalette:commands",
      "openPalette:nodes",
      "openProject",
      "openPalette:projects",
      ...RAIL_PANELS.filter((panel) => panel.when?.(everythingContext()) !== false).map(
        (panel) => `focusPanel:${panel.id}`,
      ),
      ...INSPECTOR_TABS.map((tab) => `focusInspectorTab:${tab.id}`),
      "cycleRegion:1",
      "cycleRegion:-1",
    ]);
  });

  test("every predicate is exercised by the all-enabled context", () => {
    const ctx = everythingContext();
    for (const command of defaultCommandSet()) {
      expect(command.when?.(ctx) ?? true).toBe(true);
      expect(command.enablement?.(ctx) ?? true).toBe(true);
    }
  });

  test("the no-op deps are callable — the CI checks load the set with them", () => {
    const deps = noopCommandDeps();
    expect(() => {
      void deps.saveDocument();
      deps.undo();
      deps.redo();
      void deps.openInBrowser();
      deps.closeDocument();
      deps.duplicateSelection();
      deps.deleteSelection();
      deps.selectParent();
      deps.toggleDock("navigator");
      deps.toggleZen();
      deps.openPalette("files");
      void deps.openProject();
      deps.focusPanel("files");
      deps.focusInspectorTab("style");
      deps.cycleRegion(1);
    }).not.toThrow();
  });
});

describe("the direct keys (plan §5.3)", () => {
  /** The default set built over the stand-in rail, in a context where everything is live. */
  function registryWithRail() {
    const registry = createCommandRegistry({ getContext: everythingContext, mac: true });
    registry.registerAll(defaultCommands({ ...noopCommandDeps(), navigatorPanels: RAIL_PANELS }));
    return registry;
  }

  test("⌘1–8 are spent on rail panels, in rail order", () => {
    const registry = registryWithRail();
    expect(registry.keymap.resolveChord("mod+1", ["global"])?.commandId).toBe("panel.focus.files");
    expect(registry.keymap.resolveChord("mod+2", ["global"])?.commandId).toBe("panel.focus.layers");
    expect(registry.get("panel.focus.layers")?.title).toBe("Show Outline");
  });

  test("a rail-less panel keeps its name and its palette row, and spends no chord", () => {
    // Principle 9's price for losing chrome, paid exactly: a name, a palette row, no number.
    const registry = registryWithRail();
    expect(registry.get("panel.focus.insert")?.title).toBe("Show Insert");
    expect(registry.keymap.bindingsFor("panel.focus.insert")).toEqual([]);
    // Search holds a rail slot even though it is not built, so it still consumes ⌘3.
    expect(registry.keymap.resolveChord("mod+3", ["global"])?.commandId).toBe("panel.focus.search");
  });

  test("a declared-but-unbuilt panel has no live command", () => {
    const registry = registryWithRail();
    expect(registry.isVisible("panel.focus.search")).toBe(false);
    expect(registry.isVisible("panel.focus.files")).toBe(true);
  });

  test("only the first eight rail panels get a chord", () => {
    const many: RailPanel[] = Array.from({ length: 11 }, (_unused, index) => ({
      id: `p${index}`,
      title: `P${index}`,
    }));
    const deps = { ...noopCommandDeps(), navigatorPanels: many };
    const bound = panelFocusCommands(deps).filter((command) => command.keybinding !== undefined);
    expect(bound).toHaveLength(RAIL_CHORD_LIMIT);
    expect(bound.at(-1)?.keybinding).toBe("mod+8");
  });

  test("the running app binds ⌘1–8 to the panel registry's own rail order", () => {
    const registry = createCommandRegistry({ getContext: everythingContext, mac: true });
    registry.registerAll(appCommandSet());
    const rail = navigatorPanelSet().filter((panel) => panel.rail !== false);
    for (const [index, panel] of rail.slice(0, RAIL_CHORD_LIMIT).entries()) {
      expect(registry.keymap.resolveChord(`mod+${index + 1}`, ["global"])?.commandId).toBe(
        `panel.focus.${panel.id}`,
      );
    }
  });

  test("panel focus hides with no project, and says what it needs", () => {
    const registry = createCommandRegistry({ getContext: emptyContext, mac: true });
    registry.registerAll(defaultCommands({ ...noopCommandDeps(), navigatorPanels: RAIL_PANELS }));
    expect(registry.isVisible("panel.focus.files")).toBe(false);
    expect(registry.get("panel.focus.files")?.requires).toBe("an open project");
  });

  test("⌘⇧1–4 are the four Inspector tabs, in the order §3.2 ⑨ names them", () => {
    const registry = registryWithRail();
    expect(INSPECTOR_TABS.map((tab) => tab.title)).toEqual([
      "Content",
      "Style",
      "Logic",
      "Assistant",
    ]);
    for (const [index, tab] of INSPECTOR_TABS.entries()) {
      expect(registry.keymap.resolveChord(`mod+shift+${index + 1}`, ["global"])?.commandId).toBe(
        `inspector.focus.${tab.id}`,
      );
    }
  });

  test("F6 and ⇧F6 cycle regions, and format for both platforms", () => {
    const registry = registryWithRail();
    expect(registry.keymap.resolveChord("f6", ["global"])?.commandId).toBe("view.cycleRegion");
    expect(registry.keymap.resolveChord("shift+f6", ["global"])?.commandId).toBe(
      "view.cycleRegionBack",
    );
    expect(registry.keymap.formatBinding("view.cycleRegionBack")).toBe("⇧F6");
  });

  test("Select Parent owns both its spellings — Escape and ←", () => {
    // One ACTION, one definition site, two chords. The second used to be a bare `keymap.add` call
    // Beside the registration in `editor/shortcuts.ts`, which is a second definition site.
    const registry = registryWithRail();
    expect(registry.keymap.bindingsFor("selection.selectParent")).toEqual(["escape", "arrowleft"]);
    expect(registry.keymap.resolveChord("arrowleft", ["canvas", "global"])?.commandId).toBe(
      "selection.selectParent",
    );
  });

  test("Open Recent is a named mode that works with a project already open", () => {
    const registry = registryWithRail();
    expect(registry.isEnabled("project.openRecent")).toBe(true);
    expect(registry.get("project.openRecent")?.title).toBe("Open Recent…");
  });
});

describe("the context record", () => {
  test("the empty context is the honest cold start", () => {
    const ctx = emptyContext();
    expect(ctx.project.open).toBe(false);
    expect(ctx.document.open).toBe(false);
    expect(ctx.selection.count).toBe(0);
    expect(ctx.caret.active).toBe(false);
    expect(ctx.editor.kind).toBe("none");
    for (const capability of CAPABILITIES) {
      expect(ctx.capability[capability]).toBe(false);
    }
  });

  test("makeContext overrides one group and leaves the rest at zero", () => {
    const ctx = makeContext({ selection: { count: 2 }, capability: { findReferences: true } });
    expect(ctx.selection.count).toBe(2);
    expect(ctx.selection.isRoot).toBe(false);
    expect(ctx.capability.findReferences).toBe(true);
    expect(ctx.capability.gitClone).toBe(false);
    expect(ctx.project.open).toBe(false);
  });

  test("makeContext with no patch is the empty context, and each call is a fresh record", () => {
    const first = makeContext();
    expect(first).toEqual(emptyContext());
    first.project.open = true;
    expect(emptyContext().project.open).toBe(false);
  });
});
