/**
 * Defaults.ts — the first real command records.
 *
 * These are not examples. Each one is a capability Studio already has, written out in the form
 * every surface will read it from, with the implementation taken by injection ({@link CommandDeps})
 * so this module imports no state and can be loaded by a CI check in a bare Bun process. Next wave
 * the bootstrap passes the real functions; nothing about the records changes.
 *
 * The one value import is `isSpliceablePath` — a four-token predicate over a path array, from the
 * module that also enforces it inside the mutators. An enablement predicate and the mutator it
 * guards disagreeing about which paths are editable is exactly how a Delete comes to be offered on
 * a selection it corrupts, so the two read the same function rather than the same sentence.
 *
 * Two of them exist to settle arguments the current code has with itself:
 *
 * - `document.close` is ⌘W. Today `editor/shortcuts.ts:192` refuses to close the last tab while
 *   `panels/tab-strip.ts:182`'s × closes it happily. Here the chord and the × button are the same
 *   record, so they cannot disagree again.
 * - `selection.duplicate` is "duplicate node", implemented four times today. Its `requires` string is
 *   what the block action bar's tooltip, the palette's grey subtitle and the agent's refusal all
 *   print — one sentence, three consumers.
 *
 * The primary Command Bar cluster is capped at five by `scripts/check-chrome-budget.ts`; four are
 * spent here (Save, Undo, Redo, Open in Browser) exactly as plan §3.2 region ① specifies.
 */

import { isSpliceablePath } from "../tabs/selection";

import type { AnyCommand } from "./registry";
import type { CommandContext } from "./context";

/**
 * Which dock {@link CommandDeps.toggleDock} addresses.
 *
 * The Command Bar draws three toggles, but only two come through this verb: the Bottom dock's is
 * `shell.ts`'s `view.toggleBottomDock`, which writes `shell.docks.bottom` directly now that the
 * dock is on the shell record. `"bottom"` survives in the union only because
 * `editor/shortcuts.ts`'s `toggleShellDock` still carries the branch that used to route ⌘J to the
 * Assistant — HANDOFF: that branch is now unreachable, and it goes with this member.
 */
export type DockId = "navigator" | "inspector" | "bottom";

/**
 * Palette modes, echoed as a removable chip in the input (plan §5.4).
 *
 * The value space is the palette's namespace, declared once here so a new mode is a new member
 * rather than a new widget: P4's Problems and P7's content search slot in beside these.
 */
export type PaletteMode = "picker" | "files" | "commands" | "nodes" | "projects";

/**
 * One panel, as the ⌘1–8 direct keys address it.
 *
 * Structurally the part of `panels/panel-registry.ts`'s `PanelRecord` a chord needs, declared here
 * rather than imported so this module keeps its one load-bearing property: it imports no state and
 * no DOM, which is what lets the three CI checks load the command set in a bare Bun process. The
 * ROSTER arrives by injection ({@link CommandDeps.panelRoster}) from the panel registry, so there
 * is still exactly one place a panel is named.
 */
export interface RailPanel {
  /** The panel's registry id — what `deps.focusPanel` is handed. */
  id: string;
  /** The panel's human name, which is also the command's title after "Show ". */
  title: string;
  /** `false` for a panel with no rail button — reachable by name, not by number. */
  rail?: boolean;
  /** The panel's own visibility predicate, composed into the command's. */
  when?: (ctx: CommandContext) => boolean;
}

/** How many rail panels get a ⌘N. §3.2 ② spends exactly this many slots, four per level group. */
export const RAIL_CHORD_LIMIT = 8;

/**
 * The Inspector's four tabs, in the order §3.2 ⑨ names them — which is the order ⌘⇧1–4 follow.
 *
 * `"assistant"` is a different dock (it is the Inspector's second instance until P3.6 folds the
 * column in), so it is not one of `shell.ts`'s `INSPECTOR_TAB_IDS`; the chord still belongs in the
 * same run of four, because a user counting tabs does not know that.
 */
export interface InspectorTab {
  /** The stored `session.ui.rightTab` value, or `"assistant"` for the assistant dock. */
  id: string;
  title: string;
}

export const INSPECTOR_TABS: readonly InspectorTab[] = [
  { id: "properties", title: "Content" },
  { id: "style", title: "Style" },
  { id: "events", title: "Logic" },
  { id: "assistant", title: "Assistant" },
];

/**
 * Everything the default command set needs from the rest of Studio.
 *
 * One flat interface of verbs, not a bag of modules: a command's `run` is allowed to know that
 * "save the document" exists, and nothing else.
 */
export interface CommandDeps {
  saveDocument: () => void | Promise<void>;
  undo: () => void;
  redo: () => void;
  openInBrowser: () => void | Promise<void>;
  closeDocument: () => void;
  duplicateSelection: () => void;
  deleteSelection: () => void;
  selectParent: () => void;
  toggleDock: (dock: DockId) => void;
  toggleZen: () => void;
  openPalette: (mode: PaletteMode) => void;
  openProject: () => void | Promise<void>;
  /**
   * Open a fresh window with no project — `StudioPlatform.newWindow`.
   *
   * A no-op on hosts that have one window; the record is gated on the same capability, so on those
   * hosts it is not offered at all rather than offered and inert.
   */
  newWindow: () => void | Promise<void>;
  /**
   * The rail's panels in rail order, then the rail-less ones — the roster ⌘1–8 is generated from.
   *
   * Every entry is a Navigator panel: the rail is the Navigator's, and a Bottom-dock tab is
   * addressed by `view.setBottomTab` instead — one door per surface. `panels/navigator-panels.ts`'s
   * `panelFocusRoster()` builds it.
   *
   * Injected rather than declared here so the panel registry stays the one place a panel is named,
   * levelled and gated. An empty roster (the no-op deps) simply yields no `panel.focus.*` records.
   */
  panelRoster: readonly RailPanel[];
  /**
   * Toggle-FOCUS a panel (plan §5.3): reveal it and take focus, or — when it already has focus —
   * collapse the dock hosting it and hand focus back to the pane. Deliberately not toggle-visible:
   * ⌘1 pressed from the canvas must land you in Files, not close it.
   */
  focusPanel: (panelId: string) => void;
  /** Show an Inspector tab and focus the dock. `"assistant"` addresses the assistant dock. */
  focusInspectorTab: (tabId: string) => void;
  /** F6 / ⇧F6 — move focus to the next (or previous) shell region. */
  cycleRegion: (direction: 1 | -1) => void;
}

/** A dependency set whose verbs do nothing — what the CI checks load the records with. */
export function noopCommandDeps(): CommandDeps {
  return {
    saveDocument: () => {},
    undo: () => {},
    redo: () => {},
    openInBrowser: () => {},
    closeDocument: () => {},
    duplicateSelection: () => {},
    deleteSelection: () => {},
    selectParent: () => {},
    toggleDock: () => {},
    toggleZen: () => {},
    openPalette: () => {},
    openProject: () => {},
    newWindow: () => {},
    panelRoster: [],
    focusPanel: () => {},
    focusInspectorTab: () => {},
    cycleRegion: () => {},
  };
}

/** A document is open and editable — the precondition most document-level verbs share. */
const documentOpen = (ctx: CommandContext) => ctx.document.open;

/**
 * At least one node is selected, **on a canvas**.
 *
 * The editor-kind conjunct is not belt-and-braces. `keyScope` gates `handleKeyEvent` and nothing
 * else, so a record reachable from the palette, the element menu, `__jxAutomation` or the assistant
 * is reachable regardless of scope — and the Outline renders whatever
 * `activeTab.value.doc.document` is, which with Project Settings open is the project CONFIGURATION
 * object drawn as a layer tree. Clicking a row there writes `session.selection`, so Delete and
 * Duplicate would transact against `project.json` and splice element nodes into the file that
 * defines the project.
 */
const hasSelection = (ctx: CommandContext) =>
  ctx.selection.count > 0 && ctx.editor.kind === "canvas";

/**
 * Every selected path names a position a structural verb can act on.
 *
 * Two halves, because two surfaces answer this question with different halves of the context. A
 * menu opened over ONE node reports its verdict as `selection.isRoot` and carries no path list
 * (`editor/context-menu.ts` builds a synthetic context from its target); the running app carries
 * the real `selection.paths` and sets `isRoot` only for the document element. `isRoot` alone would
 * leave a ctrl-clicked repeater template enabled — and Delete on a selection that includes one used
 * to splice into a children ARRAY and throw, leaving the earlier removals applied and unrecorded.
 *
 * It is `every`, not `some`, deliberately: a batch that silently skips two of the five nodes the
 * user selected is a worse answer than a Delete that says why it is unavailable. Offering a verb
 * that cannot perform what the selection asks for is the defect, not the refusal.
 */
const structurallyEditable = (ctx: CommandContext) =>
  !ctx.selection.isRoot && ctx.selection.paths.every((path) => isSpliceablePath(path));

/**
 * The default command set.
 *
 * Order is the order surfaces iterate in, so it is the order these read in the palette and in the
 * Command Bar — grouped by category rather than alphabetised.
 */
export function defaultCommands(deps: CommandDeps): AnyCommand[] {
  const commands: AnyCommand[] = [
    // ── File / Document ──
    {
      id: "file.save",
      title: "Save",
      category: "File",
      level: "document",
      icon: "save",
      keybinding: "mod+s",
      menus: ["commandbar/primary", "statusbar/document", "palette"],
      group: "1_file",
      undo: "none",
      when: documentOpen,
      requires: "an open document",
      run: () => deps.saveDocument(),
    },
    {
      id: "document.close",
      title: "Close Document",
      category: "Document",
      level: "document",
      keybinding: "mod+w",
      menus: ["context/tab", "palette"],
      group: "1_file",
      when: documentOpen,
      requires: "an open document",
      run: () => deps.closeDocument(),
    },
    {
      id: "view.openInBrowser",
      title: "Open in Browser",
      category: "View",
      level: "document",
      icon: "browser",
      keybinding: "mod+shift+o",
      menus: ["commandbar/primary", "statusbar/document", "palette"],
      group: "2_output",
      when: (ctx) => ctx.project.isSite,
      enablement: documentOpen,
      requires: "a built page to open",
      run: () => deps.openInBrowser(),
    },

    // ── Edit ──
    {
      id: "edit.undo",
      title: "Undo",
      category: "Edit",
      level: "document",
      icon: "undo",
      keybinding: "mod+z",
      menus: ["commandbar/primary", "palette"],
      group: "1_history",
      when: documentOpen,
      enablement: (ctx) => ctx.document.canUndo,
      requires: "a change to undo",
      run: () => deps.undo(),
    },
    {
      id: "edit.redo",
      title: "Redo",
      category: "Edit",
      level: "document",
      icon: "redo",
      keybinding: ["mod+shift+z", "mod+y"],
      menus: ["commandbar/primary", "palette"],
      group: "1_history",
      when: documentOpen,
      enablement: (ctx) => ctx.document.canRedo,
      requires: "a change to redo",
      run: () => deps.redo(),
    },

    // ── Selection ──
    // KeyScope "canvas", not "global": these chords must not fire while a text caret owns the
    // Keyboard. ⌘D inside a paragraph duplicates the word, not the paragraph's element.
    {
      id: "selection.duplicate",
      title: "Duplicate",
      category: "Selection",
      level: "selection",
      keyScope: "canvas",
      keybinding: "mod+d",
      menus: ["blockbar", "context/element", "context/layer", "outline/row", "palette"],
      group: "3_structure",
      undo: "document",
      when: hasSelection,
      // Same gate as `selection.delete`: duplicating needs a sibling position to insert into. The
      // Document root, a repeater template and a `$switch` case have none, and `mutateDuplicateNode`
      // Would splice at a non-numeric index there — a live button that silently corrupts the
      // Document. Both surfaces that render this record had to hand-guard it before the record
      // Said so.
      enablement: structurallyEditable,
      requires: "an element that has a sibling position",
      aiTool: {
        name: "duplicate_node",
        description: "Duplicate the currently selected element, inserting the copy after it.",
      },
      run: () => deps.duplicateSelection(),
    },
    {
      id: "selection.repeat",
      title: "Repeat...",
      category: "Selection",
      level: "selection",
      keyScope: "canvas",
      menus: ["context/element", "palette"],
      group: "3_structure",
      undo: "document",
      when: hasSelection,
      // Two ways to mean nothing: an element with no sibling position (`mutateInsertNode`'s
      // Coordinate is the same splice index Duplicate needs), and an element that IS the repeater
      // Already — its content is the single `map` template, not a child list.
      enablement: (ctx) => structurallyEditable(ctx) && !ctx.selection.isRepeater,
      requires: "an element with a sibling position that is not already a repeater",
      aiTool: {
        name: "repeat_node",
        description:
          "Turn the selected element into a repeater template, rendering it once per item of a " +
          "data collection the author picks in the dialog this opens.",
      },
      /*
       * The one record here whose implementation is not injected, and the reason is a property of
       * the implementation rather than of this record: `convertToRepeater()` is self-contained —
       * it reads the active tab, opens its own dialog and commits its own transaction — so there
       * is no bootstrap state for a `CommandDeps` verb to carry, and injecting it would only mean
       * the bootstrap re-exporting a function that needs nothing from the bootstrap.
       *
       * Imported at CALL time, which is what keeps this module's one load-bearing property intact:
       * it still imports no state at module scope, so `scripts/check-command-levels.ts` and its two
       * sibling checks still load the command set in a bare Bun process with no DOM.
       *
       * Deliberately NOT awaited, exactly as `selection.convertToComponent` is not: the promise
       * resolves when a HUMAN answers the dialog, and a command whose promise waits on a person is
       * a command nothing automated can call — `run()` means "start this flow".
       */
      run: () => {
        void import("../editor/convert-to-repeater").then(({ convertToRepeater }) =>
          convertToRepeater(),
        );
      },
    },
    {
      id: "selection.delete",
      title: "Delete",
      category: "Selection",
      level: "selection",
      keyScope: "canvas",
      keybinding: ["delete", "backspace"],
      menus: ["blockbar", "context/element", "context/layer", "outline/row", "palette"],
      group: "9_danger",
      destructive: true,
      undo: "document",
      when: hasSelection,
      // The document root is the document; deleting it is not an edit, it is an empty file. The
      // Outline's other unspliceable rows — a repeater's map template, a `$switch` case — are
      // Refused by the same gate, and refusing the whole batch is why a mixed selection can no
      // Longer half-apply.
      enablement: structurallyEditable,
      requires: "an element selection that is not the document root",
      aiTool: {
        name: "delete_node",
        description: "Delete the currently selected element from the document.",
      },
      run: () => deps.deleteSelection(),
    },
    {
      id: "selection.selectParent",
      title: "Select Parent",
      category: "Selection",
      level: "selection",
      keyScope: "canvas",
      // Two spellings of ONE action, in the record rather than in a second `keymap.add` call beside
      // The registration — which is what `editor/shortcuts.ts` had to do while this file was another
      // Workstream's, and is exactly the second definition site the registry exists to prevent.
      keybinding: ["escape", "arrowleft"],
      menus: ["palette"],
      group: "2_navigate",
      when: hasSelection,
      requires: "an element selection",
      run: () => deps.selectParent(),
    },

    // ── View ──
    {
      id: "view.toggleNavigator",
      title: "Toggle Navigator Dock",
      category: "View",
      level: "application",
      keybinding: "mod+b",
      menus: ["commandbar/overflow", "palette"],
      group: "4_docks",
      run: () => deps.toggleDock("navigator"),
    },
    {
      id: "view.toggleInspector",
      title: "Toggle Inspector Dock",
      category: "View",
      level: "application",
      keybinding: "mod+alt+b",
      menus: ["commandbar/overflow", "palette"],
      group: "4_docks",
      run: () => deps.toggleDock("inspector"),
    },
    // `view.toggleBottomDock` (⌘J) is NOT here. It moved to `shell.ts`, beside `view.setBottomDock`
    // And the `shell.docks.bottom` record both of them write: the Bottom dock is a dock now, so its
    // Verbs are declared where the other two docks' are, and the toggle no longer needs a `deps`
    // Hop through a dock id this module cannot resolve.
    {
      id: "view.zen",
      title: "Zen Mode",
      category: "View",
      level: "application",
      keybinding: "mod+.",
      menus: ["commandbar/overflow", "palette"],
      group: "4_docks",
      run: () => deps.toggleZen(),
    },

    // ── Palette ──
    {
      id: "palette.open",
      title: "Open Command Center",
      category: "View",
      level: "application",
      keybinding: "mod+k",
      menus: ["palette"],
      group: "5_palette",
      run: () => deps.openPalette("picker"),
    },
    {
      id: "palette.openFiles",
      title: "Go to File…",
      category: "File",
      level: "application",
      keybinding: "mod+p",
      menus: ["palette"],
      group: "5_palette",
      run: () => deps.openPalette("files"),
    },
    {
      id: "palette.openCommands",
      title: "Run Command…",
      category: "View",
      level: "application",
      keybinding: "mod+shift+p",
      menus: ["palette"],
      group: "5_palette",
      run: () => deps.openPalette("commands"),
    },

    {
      id: "palette.openNodes",
      title: "Go to Symbol in Document…",
      category: "Selection",
      level: "document",
      menus: ["palette"],
      group: "5_palette",
      when: documentOpen,
      requires: "an open document",
      run: () => deps.openPalette("nodes"),
    },

    // ── Project ──
    {
      id: "project.open",
      title: "Open Project…",
      category: "Project",
      level: "project",
      keybinding: "mod+o",
      menus: ["commandbar/overflow", "statusbar/project", "palette"],
      group: "1_file",
      run: () => deps.openProject(),
    },
    {
      /*
       * The other half of multi-window, and the half that had no door.
       *
       * "Open a project ELSEWHERE" is reachable from Open Project and from Recents (§4.2a); "open
       * an EMPTY window" was reachable only from the ElectroBun launcher's native application menu
       * — so on a launcher whose window has no menu bar, `newWindow` existed on the platform and
       * could not be run. Gated on the same capability every other multi-window verb is, so a host
       * with one window does not offer it.
       */
      id: "view.newWindow",
      title: "New Window",
      category: "View",
      level: "application",
      keybinding: "mod+shift+n",
      menus: ["commandbar/overflow", "palette"],
      group: "1_file",
      when: (ctx: CommandContext) => ctx.capability.windowControls,
      requires: "a host that can hold more than one window",
      run: () => deps.newWindow(),
    },
    {
      // The no-project palette stops being a hidden domain swap on `!projectState` and becomes a
      // NAMED mode that works either way (plan §5.4) — same trigger, same chrome, stated feature.
      id: "project.openRecent",
      title: "Open Recent…",
      category: "Project",
      level: "project",
      menus: ["commandbar/overflow", "statusbar/project", "palette"],
      group: "1_file",
      run: () => deps.openPalette("projects"),
    },

    // ── Direct keys (plan §5.3) ──
    ...panelFocusCommands(deps),
    ...inspectorFocusCommands(deps),
    {
      id: "view.cycleRegion",
      title: "Focus Next Region",
      category: "View",
      level: "application",
      keybinding: "f6",
      menus: ["palette"],
      group: "4_docks",
      run: () => deps.cycleRegion(1),
    },
    {
      id: "view.cycleRegionBack",
      title: "Focus Previous Region",
      category: "View",
      level: "application",
      keybinding: "shift+f6",
      menus: ["palette"],
      group: "4_docks",
      run: () => deps.cycleRegion(-1),
    },
  ];
  return commands;
}

/**
 * ⌘1–8 — one record per panel, generated from {@link CommandDeps.panelRoster}.
 *
 * Generated rather than written out eight times for the reason the whole registry exists: the rail,
 * the chord, the palette row and the generated shortcut sheet are then four renderings of one list.
 * Only the first eight get a chord; a ninth panel keeps its name and its palette row, which is the
 * cost §2 principle 9 puts on chrome.
 */
export function panelFocusCommands(deps: CommandDeps): AnyCommand[] {
  let chordsSpent = 0;
  return deps.panelRoster.map((panel) => {
    const command: AnyCommand = {
      id: `panel.focus.${panel.id}`,
      title: `Show ${panel.title}`,
      category: "View",
      // Application, like `view.setActivity`: revealing a panel arranges the workspace. What the
      // PANEL acts on is the panel record's own level, and that is `registerPanel()`'s field.
      level: "application",
      menus: ["palette"],
      group: "4_docks",
      requires: "an open project",
      // The panel's OWN `when` composes in, so a declared-but-unbuilt surface (Search, Problems)
      // Has no palette row and no live chord — the record exists, the affordance does not.
      when: (ctx: CommandContext) => ctx.project.open && (panel.when?.(ctx) ?? true),
      run: () => deps.focusPanel(panel.id),
    };
    if (panel.rail !== false && chordsSpent < RAIL_CHORD_LIMIT) {
      chordsSpent += 1;
      command.keybinding = `mod+${chordsSpent}`;
    }
    return command;
  });
}

/** ⌘⇧1–4 — one record per Inspector tab, generated from {@link INSPECTOR_TABS}. */
export function inspectorFocusCommands(deps: CommandDeps): AnyCommand[] {
  return INSPECTOR_TABS.map((tab, index) => {
    const command: AnyCommand = {
      id: `inspector.focus.${tab.id}`,
      title: `Show ${tab.title}`,
      category: "View",
      // DOCUMENT-level, like `view.setRightTab`, which writes the same field. These carried no
      // `when`, no `enablement` and no `requires` at all, so with nothing open ⌘⇧2 reported success,
      // Opening the right dock and moving focus there while silently NOT switching the tab —
      // The delegate `focusInspectorTab` goes through `runIfPresent`, which checks `isEnabled` and skips.
      // One gesture, three outcomes across the family: a loud refusal, a full write, and a
      // Half-applied success with no message. The Inspector's tabs are per-document session state
      // (`session.ui.rightTab`), so the document is the honest precondition.
      level: "document",
      keybinding: `mod+shift+${index + 1}`,
      menus: ["palette"],
      group: "4_docks",
      requires: "an open document",
      when: (ctx: CommandContext) => ctx.document.open,
      run: () => deps.focusInspectorTab(tab.id),
    };
    return command;
  });
}

/**
 * The default set with no-op implementations — the shape the CI checks validate.
 *
 * `scripts/check-command-levels.ts` and `scripts/check-chrome-budget.ts` both call this by name; a
 * fixture module passed with `--source` exports the same function.
 */
export function defaultCommandSet(): AnyCommand[] {
  return defaultCommands(noopCommandDeps());
}
