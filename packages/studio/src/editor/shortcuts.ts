/// <reference lib="dom" />
/**
 * Shortcuts.ts — the pointer surface of the canvas, and the keyboard's one dispatcher.
 *
 * Two unrelated jobs share this file because they share the canvas element:
 *
 * 1. **Wheel, middle-mouse pan and resize.** Unchanged: these are gestures over `canvasWrap`, not
 *    commands, and there is no chord to register them under.
 * 2. **Keyboard.** Formerly a 403-line `keydown` switch — twelve modifier chords and seven bare keys
 *    hand-matched against the canvas mode, with three blanket guards in front. It is now a
 *    dispatcher of about thirty lines: build the scope stack from the command context, hand the
 *    event to the registry, and `preventDefault()` iff a command claimed it.
 *
 * The three guards did not move, they were replaced by mechanisms that generalise:
 *
 * | Old guard                                              | Now                                     |
 * | ------------------------------------------------------ | --------------------------------------- |
 * | `if (isModalOpen()) return`                            | `modal.open` → the `palette`-only stack |
 * | `canvasMode === "grid" && !["o","p","s","w","z","Z"]…` | the `grid` stack (see `keyScopeStack`)  |
 * | the caret / text-input early return                    | the `caret` stack, which drops `canvas` |
 *
 * A chord whose command's `when` is false is deliberately NOT swallowed: `handleKeyEvent` returns
 * `undefined`, nothing calls `preventDefault`, and the key falls through to the browser. That is
 * how ↑/↓ still scroll a surface with no selection, and how ⌘Z reaches a text field's native undo
 * when no document is open.
 *
 * This file is also the definition site for the commands it implements — the clipboard trio, the
 * three zoom verbs and the four selection-navigation verbs — plus the implementations behind the
 * document- and selection-level records declared in `commands/defaults.ts`. Registration lives next
 * to the code that runs, so a chord and its behaviour cannot drift apart again.
 */

import {
  canvasWrap,
  childIndex,
  childList,
  getNodeAtPath,
  parentElementPath,
  projectState,
} from "../store";
import { activeTab, closeTab, workspace } from "../workspace/workspace";
import { primarySelection } from "../tabs/selection";
import {
  mutateDuplicateNodes,
  mutateInsertNode,
  mutateRemoveNodes,
  redo as tabRedo,
  undo as tabUndo,
  transactDoc,
} from "../tabs/transact";
import {
  applyEditZoom,
  markExplicitZoom,
  requestEditZoom,
  setEditZoom,
} from "../canvas/canvas-utils";
import { openQuickSearch } from "../panels/quick-search";
import { inspectorTab } from "../panels/right-panel";
import { shouldWarnOnClose, tabLabel } from "../panels/tab-strip";
import { showConfirmDialog, showDialog } from "../ui/layers";
import { rectOf } from "../utils/geometry";
import { DOCK_IDS, setActivityTab, setBottomTab, setDockCollapsed, shell } from "../shell";
import { REGION_FOR_FOCUS, resolveRegion } from "../ui/regions";
import { getPlatform, hasPlatform } from "../platform";
import { notify } from "../services/notify";
import { panelFocusRoster } from "../panels/navigator-panels";
import { getPanel } from "../panels/panel-registry";
import { copyNode, cutNode, pasteNode } from "./context-menu";

import { keyScopeStack } from "../commands/context";
import { defaultCommands } from "../commands/defaults";
import { setActiveRegistry } from "../commands/active-registry";
import { CommandUnavailableError } from "../commands/registry";
import { html } from "lit-html";
import type { CommandContext } from "../commands/context";
import type { DockId as CommandDockId } from "../commands/defaults";
import type { AnyCommand, CommandRegistry } from "../commands/registry";
import type { DockId, FocusRegion } from "../shell";
import type { JxPath } from "../state";

/** What the pointer handlers need from `studio.ts` on every gesture. */
export interface ShortcutPointerContext {
  canvasMode: string;
  panX: number;
  panY: number;
  setPan: (x: number, y: number) => void;
  applyTransform: () => void;
}

/** Where a project the user is about to pick should open. */
export type ProjectOpenTarget = "thisWindow" | "newWindow";

/** The verbs the default command set needs that are not implemented in this file. */
export interface StudioCommandHooks {
  saveDocument: () => void | Promise<void>;
  /**
   * Open a project, in the window the user chose.
   *
   * The TARGET is the new half. `project.open` with a project already open used to route silently
   * to `platform.openProjectInNewWindow` and return, so the click looked like it did nothing when
   * the new window opened behind this one. The choice is now asked for ({@link openProjectFlow})
   * and reported; honouring it is the bootstrap's side of the contract.
   */
  openProject: (target: ProjectOpenTarget) => void | Promise<void>;
  openInBrowser: () => void | Promise<void>;
}

// ─── Shared predicates ────────────────────────────────────────────────────────

/**
 * The artboard is the editor on screen — the precondition every predicate below shares.
 *
 * `keyScope: "canvas"` gates the KEYBOARD and nothing else: the palette, `__jxAutomation` and the
 * assistant all reach a command through `when` / `enablement`, so a scope is not an availability
 * rule. `edit.paste` declared only `ctx.document.open`, which is true of a Code pane, a Grid pane
 * and Project Settings alike — and running it over Project Settings inserted an element node at the
 * root of `project.json`. Every verb below addresses a NODE IN A DOCUMENT TREE, and the editor
 * showing one is the Canvas.
 */
const inCanvas = (ctx: CommandContext) => ctx.editor.kind === "canvas";

/** A document is open, on the canvas. */
const inDocument = (ctx: CommandContext) => ctx.document.open && inCanvas(ctx);

/** Something is selected — including the document root, which is a selection of one. */
const hasSelection = (ctx: CommandContext) => inCanvas(ctx) && ctx.selection.count > 0;

/** A selection that is not the document element, i.e. a node with a parent to act relative to. */
const hasElementSelection = (ctx: CommandContext) => hasSelection(ctx) && !ctx.selection.isRoot;

// ─── Selection verbs ──────────────────────────────────────────────────────────

/**
 * Move the selection to the previous (`-1`) or next (`+1`) sibling.
 *
 * With nothing selected, either direction selects the document element: the first arrow press from
 * a cold canvas has to put the cursor somewhere, and the root is the only node guaranteed to
 * exist.
 */
function navigateSelection(direction: -1 | 1): void {
  const tab = activeTab.value;
  if (!tab) {
    return;
  }
  const selected = primarySelection(tab.session.selection);
  if (!selected) {
    tab.session.selection = [[]];
    return;
  }
  if (selected.length < 2) {
    return;
  }
  const parentPath = parentElementPath(selected) as JxPath;
  const parent = getNodeAtPath(tab.doc.document, parentPath);
  const newIndex = (childIndex(selected) as number) + direction;
  if (newIndex >= 0 && newIndex < childList(parent).length) {
    tab.session.selection = [[...parentPath, "children", newIndex]];
  }
}

/** Descend into the first child of the selected node. */
function selectFirstChild(): void {
  const tab = activeTab.value;
  const selected = primarySelection(tab?.session.selection);
  if (!tab || !selected) {
    return;
  }
  const node = getNodeAtPath(tab.doc.document, selected);
  if (childList(node).length > 0) {
    tab.session.selection = [[...selected, "children", 0]];
  }
}

/**
 * Walk out of the selection by one rung.
 *
 * This is the Escape ladder (plan §5.3), and it is one rung short of complete: the block action bar
 * is not on the registry yet, so "Escape returns to the bar's selection" has nowhere to read focus
 * from. What ships is the rest of it — a nested selection selects its parent, the document element
 * clears — which replaces an Escape that always cleared regardless of depth and so threw away the
 * whole path to get out of one node.
 */
function selectParent(): void {
  const tab = activeTab.value;
  const selected = primarySelection(tab?.session.selection);
  if (!tab || !selected) {
    return;
  }
  // Escape collapses a multi-selection to the primary's parent, exactly as it collapses one — the
  // Ladder is about depth, and walking out of a batch of siblings lands on the one thing above it.
  const parent = parentElementPath(selected);
  tab.session.selection = selected.length >= 2 && parent ? [parent] : [];
}

/** Insert an empty paragraph after the selection and select it. */
function insertSiblingParagraph(): void {
  const tab = activeTab.value;
  const selected = primarySelection(tab?.session.selection);
  if (!tab || !selected || selected.length < 2) {
    return;
  }
  const parentPath = parentElementPath(selected) as JxPath;
  const index = childIndex(selected) as number;
  const newPath = [...parentPath, "children", index + 1];
  transactDoc(tab, (t) => {
    mutateInsertNode(t, parentPath, index + 1, { tagName: "p", textContent: "" });
    t.session.selection = [newPath];
  });
  // The iframe canvas re-enters inline edit for the freshly-selected node via its own posted
  // EnterEdit flow, so no parent-side enterEditOnPath is needed here.
}

/**
 * Duplicate the whole selection in ONE transaction, so a batch is one undo step (§6.5).
 *
 * With one path selected this is `mutateDuplicateNode` on that path and nothing else — the batch
 * form calls the single form, it does not reimplement it.
 */
function duplicateSelection(): void {
  const tab = activeTab.value;
  const selection = tab?.session.selection ?? [];
  if (tab && selection.length > 0) {
    transactDoc(tab, (t) => mutateDuplicateNodes(t, selection));
  }
}

/** Delete the whole selection in ONE transaction. The document element is never deletable. */
function deleteSelection(): void {
  const tab = activeTab.value;
  const deletable = (tab?.session.selection ?? []).filter((path) => path.length >= 2);
  if (tab && deletable.length > 0) {
    transactDoc(tab, (t) => mutateRemoveNodes(t, deletable));
  }
}

// ─── Document verbs ───────────────────────────────────────────────────────────

/**
 * Close the focused document — the ⌘W half of the bug this registry exists to prevent.
 *
 * The old chord refused to close the last tab (`shortcuts.ts:192`) while the tab strip's × closed
 * it happily (`tab-strip.ts:182`): two implementations of one action, disagreeing for a release
 * cycle. This is the ×'s behaviour, and it is now the only one — including its `tabLabel` wording,
 * so the confirm dialog reads identically whichever way the document is closed.
 *
 * The tab id is captured BEFORE the dialog opens. The old code re-read `workspace.activeTabId` in
 * the `.then`, so confirming after switching tabs closed whichever document happened to be focused
 * by then.
 */
function closeDocument(): void {
  const id = workspace.activeTabId;
  const tab = id ? workspace.tabs.get(id) : undefined;
  if (!id || !tab) {
    return;
  }
  if (!shouldWarnOnClose(tab)) {
    closeTab(id);
    return;
  }
  void showConfirmDialog(
    "Unsaved Changes",
    `"${tabLabel(tab)}" has unsaved changes. Close without saving?`,
    { confirmLabel: "Close", destructive: true },
  ).then((confirmed) => {
    if (confirmed) {
      closeTab(id);
    }
  });
}

function undoDocument(): void {
  const tab = activeTab.value;
  if (tab) {
    tabUndo(tab);
  }
}

function redoDocument(): void {
  const tab = activeTab.value;
  if (tab) {
    tabRedo(tab);
  }
}

// ─── Canvas zoom ──────────────────────────────────────────────────────────────

/** Design-mode zoom bounds. Edit mode clamps inside `canvas-utils`. */
const ZOOM_MIN = 0.05;
const ZOOM_MAX = 5;
const ZOOM_STEP = 1.2;

/** Whether the zoom verbs address the reflowing content zoom rather than the artboard transform. */
function isContentZoom(ctx: CommandContext): boolean {
  return ctx.canvas.view === "edit";
}

function zoomReset(ctx: CommandContext, resetPan: () => void): void {
  if (isContentZoom(ctx)) {
    setEditZoom(1);
    return;
  }
  const tab = activeTab.value;
  if (!tab) {
    return;
  }
  tab.session.ui.zoom = 1;
  resetPan();
}

function zoomBy(ctx: CommandContext, factor: number, redraw: () => void): void {
  const tab = activeTab.value;
  if (!tab) {
    return;
  }
  if (isContentZoom(ctx)) {
    setEditZoom((tab.session.ui.editZoom ?? 1) * factor);
    return;
  }
  const next = (tab.session.ui.zoom ?? 1) * factor;
  tab.session.ui.zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, next));
  redraw();
}

// ─── Shell verbs ──────────────────────────────────────────────────────────────

/**
 * The Command Bar's dock toggles, mapped onto the two docks that exist.
 *
 * `"bottom"` is the plan's Problems/Terminal dock (§3.1) and has no shell row yet, so it is absent
 * here and {@link toggleShellDock} routes ⌘J to the Assistant instead — which is no longer a dock at
 * all but the Inspector's fourth tab, and is still the third thing that chord could mean. When the
 * bottom dock lands it gets a row here and that branch goes away.
 */
const DOCK_FOR_COMMAND: Readonly<Record<Exclude<CommandDockId, "bottom">, DockId>> = {
  inspector: "right",
  navigator: "left",
};

/**
 * Flip one of the Command Bar's three toggles.
 *
 * ⌘J is the odd one: the assistant it addresses is a TAB, so "toggle" means select it or step off
 * it, and it runs through `view.setAssistant` rather than through a dock flag so the registry stays
 * the one place that behaviour is written down.
 */
function toggleShellDock(registry: CommandRegistry, dock: CommandDockId): void {
  if (dock === "bottom") {
    const showing = !shell.docks.right.collapsed && inspectorTab() === "assistant";
    runIfPresent(registry, "view.setAssistant", { open: !showing });
    return;
  }
  const target = DOCK_FOR_COMMAND[dock];
  setDockCollapsed(target, !shell.docks[target].collapsed);
}

/**
 * Run a record from ANOTHER module's registration, if this registry has it.
 *
 * `view.setAssistant` and `view.setRightTab` are `shell.ts`'s, composed into the app's registry by
 * the bootstrap — a reduced registry (a test, a future second window kind) may not carry them, and
 * a missing id must be inert rather than an exception thrown out of a keydown handler.
 */
function runIfPresent(registry: CommandRegistry, id: string, args: Record<string, unknown>): void {
  if (registry.get(id) && registry.isEnabled(id)) {
    void registry.run(id, args);
  }
}

/** The dock state Zen collapsed, or null when Zen is off. */
let zenRestore: Partial<Record<DockId, boolean>> | null = null;

/**
 * Collapse every dock; the same chord puts them back exactly as they were.
 *
 * "Reversible by the same key" (plan §5.3) is the whole requirement, and it is why the previous
 * state is snapshotted rather than assumed: an author who had the assistant closed does not want
 * leaving Zen to open it.
 */
function toggleZen(): void {
  if (zenRestore) {
    const restore = zenRestore;
    zenRestore = null;
    for (const id of DOCK_IDS) {
      setDockCollapsed(id, restore[id] ?? false);
    }
    return;
  }
  const snapshot: Partial<Record<DockId, boolean>> = {};
  for (const id of DOCK_IDS) {
    snapshot[id] = shell.docks[id].collapsed;
    setDockCollapsed(id, true);
  }
  zenRestore = snapshot;
}

// ─── Region focus (F6) ────────────────────────────────────────────────────────

/**
 * The F6 ring, in reading order: rail → navigator → pane → inspector → dock → status (plan §5.3).
 *
 * `shell.focusRegion` has enumerated these six values since the shell record landed and nothing
 * could act on it, because there was no map from the enum to the DOM. `ui/regions.ts` is that map;
 * this is its consumer, and the reason `REGION_FOR_FOCUS` exists.
 */
export const REGION_CYCLE: readonly FocusRegion[] = [
  "rail",
  "navigator",
  "pane",
  "inspector",
  "dock",
  "status",
];

/**
 * The next region in the ring that is actually on screen, or `null` when none is.
 *
 * Absent regions are SKIPPED rather than focused-and-lost: the bottom dock does not exist until P4
 * and a collapsed Navigator has no host, so a ring that did not skip would strand the caret every
 * second press. Pure, and injectable, so the walk is testable without a shell.
 */
export function nextRegion(
  current: FocusRegion,
  direction: 1 | -1,
  isPresent: (region: FocusRegion) => boolean,
): FocusRegion | null {
  const start = REGION_CYCLE.indexOf(current);
  const size = REGION_CYCLE.length;
  for (let step = 1; step <= size; step++) {
    const candidate = REGION_CYCLE[(start + direction * step + size * size) % size]!;
    if (isPresent(candidate)) {
      return candidate;
    }
  }
  return null;
}

/** The first element inside a region that can take the caret. */
const REGION_FOCUSABLE =
  'a[href], button, input, textarea, select, sp-action-button, sp-tab, sp-textfield, sp-picker, [tabindex]:not([tabindex="-1"])';

/**
 * Move focus into a region and record that it moved.
 *
 * The record and the DOM are written together, deliberately: `focus.region` is a command-context
 * key that the keyboard's own scope stack reads (`keyScopeStack` returns the dock stack for
 * anything but the pane), so a focus move the record did not hear about would silently change which
 * chords are live.
 */
export function focusShellRegion(region: FocusRegion): boolean {
  const host = resolveRegion(REGION_FOR_FOCUS[region]);
  if (!host) {
    return false;
  }
  shell.focusRegion = region;
  const inner = host.querySelector<HTMLElement>(REGION_FOCUSABLE);
  if (inner) {
    inner.focus();
    return true;
  }
  // A bare `<div id>` shell host is not focusable on its own. Making it programmatically focusable
  // Is the standard fix and costs nothing: -1 keeps it out of the Tab order, which is the point —
  // F6 is the way in, Tab is the way around inside.
  host.tabIndex = -1;
  host.focus();
  return true;
}

function cycleRegion(direction: 1 | -1): void {
  const target = nextRegion(shell.focusRegion, direction, (region) =>
    Boolean(resolveRegion(REGION_FOR_FOCUS[region])),
  );
  if (target) {
    focusShellRegion(target);
  }
}

// ─── Panel and inspector focus (⌘1–8, ⌘⇧1–4) ─────────────────────────────────

/**
 * Toggle-FOCUS, not toggle-visible (plan §5.3).
 *
 * ⌘1 from the canvas reveals Files and puts the caret in it; ⌘1 again — with Files already focused
 * — collapses the dock and hands the caret back to the pane. The distinction matters because the
 * common case is "take me there", and a toggle-visible binding makes that a coin flip on whichever
 * panel happened to be showing.
 *
 * The chord roster follows the RAIL, and the rail spans two docks: ⌘4 is Problems, whose body is
 * the Bottom dock's first tab (plan §7.2). So the panel's own record decides which dock is opened
 * and which region takes focus — `panels/activity-bar.ts` makes the same branch for the click. A
 * roster id with no record falls back to the Navigator, which is what `view.setActivity`'s enum
 * already guarantees for every id that can reach here.
 */
function focusPanel(panelId: string): void {
  if (getPanel(panelId)?.dock === "bottom") {
    const showing =
      shell.bottomTab === panelId && !shell.docks.bottom.collapsed && shell.focusRegion === "dock";
    if (showing) {
      setDockCollapsed("bottom", true);
      focusShellRegion("pane");
      return;
    }
    setBottomTab(panelId);
    focusShellRegion("dock");
    return;
  }
  const alreadyThere =
    shell.leftTab === panelId && !shell.docks.left.collapsed && shell.focusRegion === "navigator";
  if (alreadyThere) {
    setDockCollapsed("left", true);
    focusShellRegion("pane");
    return;
  }
  setActivityTab(panelId);
  focusShellRegion("navigator");
}

/**
 * ⌘⇧1–4 — show an Inspector tab and focus the dock.
 *
 * All four are tabs of the same dock now. `"assistant"` still routes to its own record because that
 * record is application-level and works with no document open — `view.setRightTab` is
 * document-level and correctly refuses when there is nothing to inspect.
 */
function focusInspectorTab(registry: CommandRegistry, tabId: string): void {
  setDockCollapsed("right", false);
  if (tabId === "assistant") {
    runIfPresent(registry, "view.setAssistant", { open: true });
  } else {
    runIfPresent(registry, "view.setRightTab", { tab: tabId });
  }
  focusShellRegion("inspector");
}

// ─── Project: Open… ───────────────────────────────────────────────────────────

/**
 * Ask where the project should open, then say what happened.
 *
 * With no project open, or on a platform with one window, there is no choice to make and none is
 * offered. With one open there IS a choice, and it was previously being made silently in the user's
 * name: `openRecentProject` saw a live `projectState`, called `openProjectInNewWindow` and
 * returned, so a window opened behind this one and the click read as a no-op.
 */
export async function openProjectFlow(hooks: StudioCommandHooks): Promise<void> {
  const platform = hasPlatform() ? getPlatform() : null;
  const multiWindow = typeof platform?.openProjectInNewWindow === "function";
  if (!projectState || !multiWindow) {
    await hooks.openProject("thisWindow");
    return;
  }
  const openName = projectState.name;
  const choice = await showDialog<ProjectOpenTarget | "cancel">(
    (done) => html`
      <sp-dialog-wrapper
        open
        underlay
        headline="Open Project"
        confirm-label="New Window"
        secondary-label="This Window"
        cancel-label="Cancel"
        size="s"
        @confirm=${() => done("newWindow")}
        @secondary=${() => done("thisWindow")}
        @cancel=${() => done("cancel")}
        @close=${() => done("cancel")}
      >
        <p>${openName} is open in this window. Where should the project you pick open?</p>
      </sp-dialog-wrapper>
    `,
  );
  if (choice === "cancel") {
    return;
  }
  await hooks.openProject(choice);
  notify.info(
    choice === "newWindow" ? "Opening the project in a new window…" : "Opening the project…",
    { key: "project.open", source: "Project" },
  );
}

// ─── Command records owned by this file ───────────────────────────────────────

/**
 * The nine verbs the old switch implemented inline and no other surface had a name for.
 *
 * All nine are `keyScope: "canvas"`: they act on a node in the artboard, so they must not fire
 * while a caret owns the keyboard, while the grid engine does, or while Preview is showing a page
 * with no overlays to aim at. That is one field per record instead of two ad-hoc refusal sets.
 *
 * Each is ALSO gated on {@link inCanvas}, through the three shared predicates. The `keyScope`
 * answers "may this chord fire here"; the `when` answers "does this verb exist here at all", which
 * is the question the palette, `__jxAutomation` and the assistant ask instead.
 */
function canvasCommands(pointer: () => ShortcutPointerContext): AnyCommand[] {
  const resetPan = () => {
    pointer().setPan(16, 16);
    pointer().applyTransform();
  };
  const redraw = () => pointer().applyTransform();
  return [
    {
      category: "Edit",
      group: "1_clipboard",
      id: "edit.copy",
      keybinding: "mod+c",
      keyScope: "canvas",
      level: "selection",
      requires: "an element selection",
      run: () => {
        void copyNode();
      },
      title: "Copy",
      undo: "none",
      when: hasSelection,
    },
    {
      category: "Edit",
      destructive: true,
      group: "1_clipboard",
      id: "edit.cut",
      keybinding: "mod+x",
      keyScope: "canvas",
      level: "selection",
      requires: "an element selection that is not the document root",
      run: () => {
        void cutNode();
      },
      title: "Cut",
      undo: "document",
      when: hasElementSelection,
    },
    {
      category: "Edit",
      group: "1_clipboard",
      id: "edit.paste",
      keybinding: "mod+v",
      keyScope: "canvas",
      level: "document",
      requires: "an open document",
      run: () => {
        void pasteNode();
      },
      title: "Paste",
      undo: "document",
      when: inDocument,
    },
    {
      category: "Selection",
      group: "3_structure",
      id: "selection.insertSibling",
      keybinding: "enter",
      keyScope: "canvas",
      level: "selection",
      requires: "an element selection that is not the document root",
      run: () => insertSiblingParagraph(),
      title: "Insert Paragraph After",
      undo: "document",
      when: hasElementSelection,
    },
    {
      category: "Selection",
      group: "2_navigate",
      id: "selection.selectPrevious",
      keybinding: "arrowup",
      keyScope: "canvas",
      level: "selection",
      requires: "an open document",
      run: () => navigateSelection(-1),
      title: "Select Previous Sibling",
      undo: "none",
      when: inDocument,
    },
    {
      category: "Selection",
      group: "2_navigate",
      id: "selection.selectNext",
      keybinding: "arrowdown",
      keyScope: "canvas",
      level: "selection",
      requires: "an open document",
      run: () => navigateSelection(1),
      title: "Select Next Sibling",
      undo: "none",
      when: inDocument,
    },
    {
      category: "Selection",
      group: "2_navigate",
      id: "selection.selectFirstChild",
      keybinding: "arrowright",
      keyScope: "canvas",
      level: "selection",
      requires: "an element selection with children",
      run: () => selectFirstChild(),
      title: "Select First Child",
      undo: "none",
      when: hasSelection,
    },
    {
      category: "View",
      group: "6_zoom",
      id: "canvas.zoomReset",
      keybinding: "mod+0",
      keyScope: "canvas",
      level: "document",
      requires: "an open document",
      run: (ctx) => zoomReset(ctx, resetPan),
      title: "Reset Zoom",
      undo: "none",
      when: inDocument,
    },
    {
      category: "View",
      group: "6_zoom",
      id: "canvas.zoomIn",
      // ⌘+ needs Shift on most layouts, and `KeyboardEvent.key` is then "+" with `shiftKey` set —
      // Three spellings of one gesture, which is why the old switch had `case "=": case "+":`.
      keybinding: ["mod+=", "mod++", "mod+shift++"],
      keyScope: "canvas",
      level: "document",
      requires: "an open document",
      run: (ctx) => zoomBy(ctx, ZOOM_STEP, redraw),
      title: "Zoom In",
      undo: "none",
      when: inDocument,
    },
    {
      category: "View",
      group: "6_zoom",
      id: "canvas.zoomOut",
      keybinding: "mod+-",
      keyScope: "canvas",
      level: "document",
      requires: "an open document",
      run: (ctx) => zoomBy(ctx, 1 / ZOOM_STEP, redraw),
      title: "Zoom Out",
      undo: "none",
      when: inDocument,
    },
  ];
}

/**
 * Register every command the keyboard dispatches, with its real implementation.
 *
 * The default set's `CommandDeps` are wired here rather than in the bootstrap because nine of the
 * twelve verbs are implemented in this file; the three that reach outside it arrive as
 * {@link StudioCommandHooks}.
 *
 * **This is the KEYBOARD's registry, not yet the app's.** Three other contribution points landed in
 * the same wave and each built its own registry over its own context — `editor/context-menu.ts`
 * (the element menu, over the node the open MENU addresses), `panels/block-action-bar.ts` and
 * `workspace/workspace.ts`. Composing all four into one app-wide registry is the follow-up PR, and
 * these four records are what it has to reconcile:
 *
 * | Here                      | There                                       | Keep                                                                                                                                             |
 * | ------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
 * | `edit.copy` / `edit.cut`  | same ids in `context-menu.ts`               | THEIRS — the implementation lives there; it needs a selection-derived `target()`                                                                 |
 * | `edit.paste`              | `edit.pasteAfter` / `edit.pasteInside`      | theirs, once one of them covers "paste into the root with nothing selected", which ⌘V does today                                                 |
 * | `selection.insertSibling` | `selection.insertAfter` (unbound, no chord) | theirs, once it SELECTS the inserted node — the canvas re-enters inline edit off that selection, and Enter-to-add-a-paragraph is dead without it |
 *
 * Until then the two registries are separate objects, so the duplicate ids are not a runtime
 * conflict; they are a debt with a name.
 */
export function registerStudioCommands(
  registry: CommandRegistry,
  hooks: StudioCommandHooks,
  pointer: () => ShortcutPointerContext,
): void {
  registry.registerAll(
    defaultCommands({
      closeDocument,
      cycleRegion,
      deleteSelection,
      duplicateSelection,
      focusInspectorTab: (tabId) => focusInspectorTab(registry, tabId),
      focusPanel,
      openInBrowser: () => hooks.openInBrowser(),
      openPalette: (mode) => {
        openQuickSearch(mode);
      },
      panelRoster: panelFocusRoster(),
      openProject: () => openProjectFlow(hooks),
      redo: redoDocument,
      saveDocument: () => hooks.saveDocument(),
      selectParent,
      toggleDock: (dock) => {
        toggleShellDock(registry, dock);
      },
      toggleZen,
      undo: undoDocument,
    }),
  );
  registry.registerAll(canvasCommands(pointer));
}

// ─── The dispatcher ───────────────────────────────────────────────────────────

/**
 * Resolve one keydown through the registry.
 *
 * `preventDefault()` iff a command claimed the chord. A command that is VISIBLE but disabled — ⌘Z
 * with nothing to undo, Delete on the document element — still counts as claiming it: the registry
 * throws {@link CommandUnavailableError} from `run`, and swallowing the key is the honest outcome,
 * because the chord is spoken for and letting the browser act on it instead would be a surprise.
 *
 * HANDOFF: `registry.handleKeyEvent` reports the hit and runs it in one step, so a refusal can only
 * be observed by catching. It would be better for it to consult `isEnabled` itself and return the
 * id without running; `commands/registry.ts` is another workstream's file this wave.
 */
function dispatchKey(registry: CommandRegistry, event: KeyboardEvent): string | undefined {
  const commandId = claimChord(registry, event);
  if (commandId) {
    event.preventDefault();
  }
  return commandId;
}

/** The id of the command that claimed the chord, whether it ran or refused. */
function claimChord(registry: CommandRegistry, event: KeyboardEvent): string | undefined {
  const stack = keyScopeStack(registry.context());
  try {
    return registry.handleKeyEvent(event, stack);
  } catch (error) {
    if (error instanceof CommandUnavailableError) {
      return error.commandId;
    }
    throw error;
  }
}

// ─── Pointer and wheel gestures ───────────────────────────────────────────────

/**
 * Install the canvas gestures and the keyboard dispatcher.
 *
 * @param registry The app's command registry, already populated.
 * @param getContext Live pointer/pan state, read fresh on every gesture.
 */
export function initShortcuts(
  registry: CommandRegistry,
  getContext: () => ShortcutPointerContext,
): void {
  // Publish the composed registry to the chrome. `studio.ts` mounts the Command Bar and the Palette
  // At the top of its body and builds the registry at the bottom, so this — the last bootstrap call
  // Before the automation hook — is the point at which "the registry" exists to be rendered.
  setActiveRegistry(registry);
  // Wheel handler: Ctrl+Scroll = zoom (cursor-centered), plain scroll = pan
  canvasWrap.addEventListener(
    "wheel",
    (e: WheelEvent) => {
      const { canvasMode, panX, panY, setPan, applyTransform } = getContext();
      // Edit (content) mode: ctrl/cmd+wheel drives the content zoom (browser-page-zoom semantics —
      // The footprint stays fixed, content reflows); plain wheel scrolls the edit-mode container
      // Ourselves. The canvas iframe is sized to its content (no internal scroll) and a cross-origin
      // OOPIF doesn't bubble wheel to the parent, so the wheel reaches us forwarded (or over the
      // Canvas chrome) but never triggers native scroll.
      if (canvasMode === "edit") {
        if (e.ctrlKey || e.metaKey) {
          e.preventDefault();
          const editZoom = activeTab.value?.session.ui.editZoom ?? 1;
          requestEditZoom(editZoom * (1 + -e.deltaY * 0.005));
          return;
        }
        const sc = canvasWrap.querySelector<HTMLElement>(".content-edit-canvas");
        if (sc) {
          e.preventDefault();
          sc.scrollTop += e.deltaY;
          sc.scrollLeft += e.deltaX;
        }
        return;
      }
      /* Surfaces that scroll themselves. The grid is a Tabulator viewport with its own virtual
         scroller and the browse table is an ordinary overflow container — panning a transform over
         either is why neither could be scrolled with the wheel at all. */
      if (canvasMode === "grid" || canvasMode === "manage") {
        return;
      }
      /* Preview scrolls for real. Its frame is a normally-sized viewport over its own document, so
         the wheel belongs to that document — panning a transform here is exactly what stopped
         `position:sticky`, scroll-driven animation and IntersectionObserver reveals from ever
         firing. Nothing is preventDefaulted, and there is no artboard to zoom. */
      if (canvasMode === "preview") {
        return;
      }
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) {
        // Zoom towards cursor
        const rect = rectOf(canvasWrap);
        const cursorX = e.clientX - rect.left;
        const cursorY = e.clientY - rect.top;
        const oldZoom = activeTab.value?.session.ui.zoom ?? 1;
        const delta = -e.deltaY * 0.005;
        const newZoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, oldZoom * (1 + delta)));
        const ratio = newZoom / oldZoom;
        // Adjust pan so the point under cursor stays stationary
        setPan(cursorX - (cursorX - panX) * ratio, cursorY - (cursorY - panY) * ratio);
        activeTab.value!.session.ui.zoom = newZoom;
        // The author chose this zoom, so re-entering Design keeps it instead of auto-fitting.
        markExplicitZoom();
      } else if (e.shiftKey) {
        // Shift+scroll = horizontal pan
        setPan(panX - e.deltaY, panY);
      } else {
        // Pan
        setPan(panX - e.deltaX, panY - e.deltaY);
      }
      applyTransform();
    },
    { passive: false },
  );

  // Middle-mouse drag panning
  canvasWrap.addEventListener("pointerdown", (e: PointerEvent) => {
    const ctx = getContext();
    if (ctx.canvasMode === "edit" || ctx.canvasMode === "preview") {
      return;
    } // No panning in edit mode, and preview scrolls its own frame rather than panning
    if (e.button !== 1) {
      return;
    } // Middle button only
    e.preventDefault();
    canvasWrap.setPointerCapture(e.pointerId);
    let lastX = e.clientX,
      lastY = e.clientY;
    const onMove = (ev: PointerEvent) => {
      const { panX, panY, setPan, applyTransform } = getContext();
      setPan(panX + (ev.clientX - lastX), panY + (ev.clientY - lastY));
      lastX = ev.clientX;
      lastY = ev.clientY;
      applyTransform();
    };
    const onUp = () => {
      canvasWrap.releasePointerCapture(e.pointerId);
      canvasWrap.removeEventListener("pointermove", onMove);
      canvasWrap.removeEventListener("pointerup", onUp);
    };
    canvasWrap.addEventListener("pointermove", onMove);
    canvasWrap.addEventListener("pointerup", onUp);
  });

  // Re-fit the edit-mode content zoom on resize: its layout width derives from the LIVE column
  // Width, which tracks the studio window.
  window.addEventListener("resize", () => {
    if (getContext().canvasMode === "edit") {
      applyEditZoom();
    }
  });

  document.addEventListener("keydown", (e) => {
    dispatchKey(registry, e);
  });

  // Block ctrl+scroll (browser zoom) on all non-canvas areas
  document.addEventListener(
    "wheel",
    (e: WheelEvent) => {
      if ((e.ctrlKey || e.metaKey) && !canvasWrap.contains(e.target as Node)) {
        e.preventDefault();
      }
    },
    { passive: false },
  );
}
