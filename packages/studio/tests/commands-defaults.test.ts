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
import { navigatorPanelSet, panelFocusRoster } from "../src/panels/navigator-panels";
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
    panelRoster: RAIL_PANELS,
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
      getContext: () =>
        makeContext({ editor: { kind: "canvas" }, selection: { count: 1, isRoot: true } }),
      mac: true,
    });
    registry.registerAll(defaultCommandSet());
    expect(registry.isVisible("selection.duplicate")).toBe(true);
    expect(registry.isEnabled("selection.duplicate")).toBe(false);
    expect(registry.disabledReason("selection.duplicate")).toContain("sibling position");
  });

  /*
   * `selection.repeat` used to live in `editor/context-menu.ts`'s OWN registry, which is why the
   * two `repeat-dialog` shots were quarantined: the app registry never held it, so the palette
   * could not list it and `__jxAutomation.run("selection.repeat")` answered "unknown command".
   * Beside Duplicate and Delete it is one record with three renderings.
   */
  test("repeat is a context-menu row AND a palette entry AND an assistant tool", () => {
    const repeat = defaultCommandSet().find((c) => c.id === "selection.repeat");
    expect(repeat?.menus).toEqual(["context/element", "palette"]);
    expect(repeat?.aiTool?.name).toBe("repeat_node");
    expect(repeat?.undo).toBe("document");
    expect(repeat?.group).toBe("3_structure");
  });

  test("repeat refuses the document root and refuses a repeater", () => {
    const gate = (selection: { isRoot?: boolean; isRepeater?: boolean }) => {
      const registry = createCommandRegistry({
        getContext: () =>
          makeContext({ editor: { kind: "canvas" }, selection: { count: 1, ...selection } }),
        mac: true,
      });
      registry.registerAll(defaultCommandSet());
      return registry;
    };
    expect(gate({}).isEnabled("selection.repeat")).toBe(true);
    expect(gate({ isRoot: true }).isEnabled("selection.repeat")).toBe(false);
    // The one the old private record needed a node for: a repeater's content is its single `map`
    // Template, so repeating it again means nothing. The context now carries the fact.
    const onArray = gate({ isRepeater: true });
    expect(onArray.isVisible("selection.repeat")).toBe(true);
    expect(onArray.isEnabled("selection.repeat")).toBe(false);
    expect(onArray.disabledReason("selection.repeat")).toBe(
      "an element with a sibling position that is not already a repeater",
    );
  });

  test("repeat runs the converter it does not import at module scope", async () => {
    const registry = createCommandRegistry({
      getContext: () => makeContext({ editor: { kind: "canvas" }, selection: { count: 1 } }),
      mac: true,
    });
    registry.registerAll(defaultCommandSet());
    // No tab is open, so `convertToRepeater` returns on its own first guard — what is asserted is
    // That the lazy import RESOLVES, which is the half a bare-Bun record could get wrong.
    await registry.run("selection.repeat");
  });

  test("delete is destructive, undoable, and refuses the document root", () => {
    const registry = createCommandRegistry({
      getContext: () =>
        makeContext({ editor: { kind: "canvas" }, selection: { count: 1, isRoot: true } }),
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

  test("delete and duplicate refuse a selection holding a row no splice can perform", () => {
    // The Outline draws a repeater's map template as its own row, so a ctrl-click puts
    // `["children", 1, "map"]` in the selection beside an ordinary element. `parentElementPath` of
    // It is the children ARRAY, and the splice used to throw mid-batch — after earlier removals had
    // Already landed, and before anything was recorded. The records refuse the whole selection:
    // Doing four fifths of what the user asked for is worse than saying why it cannot.
    const gate = (paths: (string | number)[][]) => {
      const registry = createCommandRegistry({
        getContext: () =>
          makeContext({ editor: { kind: "canvas" }, selection: { count: paths.length, paths } }),
        mac: true,
      });
      registry.registerAll(defaultCommandSet());
      return registry;
    };
    const mixed = gate([
      ["children", 0],
      ["children", 1, "map"],
    ]);
    expect(mixed.isEnabled("selection.delete")).toBe(false);
    expect(mixed.isEnabled("selection.duplicate")).toBe(false);
    // A `$switch` case is the same shape of row, and the document element is refused by `isRoot`.
    expect(gate([["children", 1, "cases", "warn"]]).isEnabled("selection.delete")).toBe(false);
    // Every path a splice coordinate — the multi-select case the batch mutators exist for.
    const spliceable = gate([
      ["children", 0],
      ["children", 2, "children", 1],
    ]);
    expect(spliceable.isEnabled("selection.delete")).toBe(true);
    expect(spliceable.isEnabled("selection.duplicate")).toBe(true);
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
    registry.registerAll(defaultCommands({ ...noopCommandDeps(), panelRoster: RAIL_PANELS }));
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
    const deps = { ...noopCommandDeps(), panelRoster: many };
    const bound = panelFocusCommands(deps).filter((command) => command.keybinding !== undefined);
    expect(bound).toHaveLength(RAIL_CHORD_LIMIT);
    expect(bound.at(-1)?.keybinding).toBe("mod+8");
  });

  test("the running app binds ⌘1–8 to the panel registry's own rail order", () => {
    const registry = createCommandRegistry({ getContext: everythingContext, mac: true });
    registry.registerAll(appCommandSet());
    const rail = panelFocusRoster().filter((panel) => panel.rail !== false);
    for (const [index, panel] of rail.slice(0, RAIL_CHORD_LIMIT).entries()) {
      expect(registry.keymap.resolveChord(`mod+${index + 1}`, ["global"])?.commandId).toBe(
        `panel.focus.${panel.id}`,
      );
    }
  });

  test("⌘4 is Problems, whose body is the Bottom dock's — the rail groups by level, not by dock", () => {
    const registry = createCommandRegistry({ getContext: everythingContext, mac: true });
    registry.registerAll(appCommandSet());
    expect(registry.keymap.resolveChord("mod+4", ["global"])?.commandId).toBe(
      "panel.focus.problems",
    );
    expect(panelFocusRoster().find((panel) => panel.id === "problems")?.dock).toBe("bottom");
    // The Navigator's own set no longer contains it, so it cannot be opened in the left dock.
    expect(navigatorPanelSet().map((panel) => panel.id)).not.toContain("problems");
  });

  test("the Bottom dock's rail-less tabs get no panel.focus command of their own", () => {
    const registry = createCommandRegistry({ getContext: everythingContext, mac: true });
    registry.registerAll(appCommandSet());
    for (const id of ["diff", "logic", "activity"]) {
      expect(registry.get(`panel.focus.${id}`)).toBeUndefined();
    }
    // …and the two rail-less NAVIGATOR panels still do, because that is what `rail: false` buys.
    expect(registry.get("panel.focus.insert")?.title).toBe("Show Insert");
    expect(registry.get("panel.focus.state")?.title).toBe("Show State");
  });

  test("panel focus hides with no project, and says what it needs", () => {
    const registry = createCommandRegistry({ getContext: emptyContext, mac: true });
    registry.registerAll(defaultCommands({ ...noopCommandDeps(), panelRoster: RAIL_PANELS }));
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

describe("canvas verbs do not reach the project configuration document", () => {
  // `keyScope` gates `handleKeyEvent` and nothing else, so a record reachable from the palette, the
  // Element menu or the assistant is reachable whatever the scope stack says. The Outline renders
  // Whatever `activeTab.value.doc.document` is — with Project Settings open that is the CONFIG
  // Object drawn as a layer tree — and a click there writes `session.selection`. Delete and
  // Duplicate would then transact against project.json and splice element nodes into the file that
  // Defines the project.
  const gateFor = (kind: "canvas" | "config") => {
    const registry = createCommandRegistry({
      getContext: () =>
        makeContext({
          document: { open: true },
          editor: { kind },
          selection: { count: 1, paths: [["children", 0]] },
        }),
      mac: true,
    });
    registry.registerAll(defaultCommandSet());
    return registry;
  };

  test("selection verbs are unavailable over a config editor, and available on a canvas", () => {
    const config = gateFor("config");
    const canvas = gateFor("canvas");
    for (const id of ["selection.delete", "selection.duplicate", "selection.repeat"]) {
      expect(config.isVisible(id), `${id} over config`).toBe(false);
      // The control case, so neither assertion can pass by the record simply being absent.
      expect(canvas.isVisible(id), `${id} over canvas`).toBe(true);
    }
  });
});
