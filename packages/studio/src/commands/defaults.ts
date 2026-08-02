/**
 * Defaults.ts — the first real command records.
 *
 * These are not examples. Each one is a capability Studio already has, written out in the form
 * every surface will read it from, with the implementation taken by injection ({@link CommandDeps})
 * so this module imports no state and can be loaded by a CI check in a bare Bun process. Next wave
 * the bootstrap passes the real functions; nothing about the records changes.
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

import type { AnyCommand } from "./registry";
import type { CommandContext } from "./context";

/** Which dock a toggle addresses. Mirrors the three dock toggles in the Command Bar. */
export type DockId = "navigator" | "inspector" | "bottom";

/** Palette modes, echoed as a removable chip in the input (plan §5.4). */
export type PaletteMode = "picker" | "files" | "commands" | "nodes" | "signals";

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
  };
}

/** A document is open and editable — the precondition most document-level verbs share. */
const documentOpen = (ctx: CommandContext) => ctx.document.open;

/** At least one node is selected. */
const hasSelection = (ctx: CommandContext) => ctx.selection.count > 0;

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
      requires: "an element selection",
      aiTool: {
        name: "duplicate_node",
        description: "Duplicate the currently selected element, inserting the copy after it.",
      },
      run: () => deps.duplicateSelection(),
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
      // The document root is the document; deleting it is not an edit, it is an empty file.
      enablement: (ctx) => !ctx.selection.isRoot,
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
      keybinding: "escape",
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
    {
      id: "view.toggleBottomDock",
      title: "Toggle Bottom Dock",
      category: "View",
      level: "application",
      keybinding: "mod+j",
      menus: ["commandbar/overflow", "palette"],
      group: "4_docks",
      run: () => deps.toggleDock("bottom"),
    },
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
  ];
  return commands;
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
