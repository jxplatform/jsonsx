/// <reference lib="dom" />
/**
 * Block action bar — the floating toolbar above the selected element.
 *
 * The bar is a RENDERING of the command registry (plan §3.2 region ⑩, §5.5): its verb cluster is
 * `registry.forPlacement("blockbar")`, sliced at {@link BLOCKBAR_MAX_ITEMS} with the remainder
 * behind a `⋮` overflow menu. Every button's accessible name is its record's `title` and its
 * tooltip carries `keymap.formatBinding(id)`, so no action is named twice.
 *
 * `studio-ui-guidelines.md` §8.6 is normative about the shape: **ONE shape.** The bar does not
 * rearrange itself when the author starts typing, and a control that cannot act is DISABLED, not
 * removed — a toolbar whose buttons move under the cursor is worse than one with a greyed button.
 * That is why the parent selector, the drag handle and every verb render unconditionally and take
 * their disabled state (and its one-sentence reason) from the record's own `enablement`.
 *
 * This module is also the single definition site for the structural selection verbs — move
 * up/down/in/out and the component pair — because their implementations live here.
 * {@link registerSelectionCommands} is what a host bootstrap calls to put them in the app-wide
 * registry; until one exists, {@link selectionCommandRegistry} builds the surface's own.
 */

import { html, render as litRender, nothing } from "lit-html";
import { displayTagName } from "@jxsuite/schema/guards";
import { styleMap } from "lit-html/directives/style-map.js";
import { ref } from "lit-html/directives/ref.js";
import { draggable } from "@atlaskit/pragmatic-drag-and-drop/element/adapter";
import { disableNativeDragPreview } from "@atlaskit/pragmatic-drag-and-drop/element/disable-native-drag-preview";

import {
  VOID_ELEMENTS,
  childIndex,
  childList,
  getNodeAtPath,
  nodeLabel,
  parentElementPath,
} from "../store";
import { activeTab } from "../workspace/workspace";
import { activeCanvasSurface, stageContaining } from "../canvas/canvas-surface";
import { primarySelection, structuralBatch } from "../tabs/selection";
import {
  mutateDuplicateNodes,
  mutateMoveNode,
  mutateRemoveNodes,
  mutateUpdateProperty,
  transactDoc,
} from "../tabs/transact";
import { view } from "../view";
import { getInlineActions, isInlineElement } from "../editor/inline-edit";
import type { InlineAction } from "../editor/inline-edit";
import { buildMergeTags, buildRepeaterTagsFromFields } from "../editor/merge-tags";
import { findEnclosingRepeater, resolveRepeaterItemFields } from "../editor/repeater-scope";
import { projectState } from "../state";
import { componentRegistry } from "../files/components";
import { convertToComponent } from "../editor/convert-to-component";
import { getEditBarAnchorRect, getEditSnapshot, postApplyFormat } from "../canvas/iframe-host";
import { getLayerSlot, isModalOpen, renderPopover } from "../ui/layers";
import { showSlashMenu } from "../editor/slash-menu";
import { getConvertTargets } from "../editor/convert-targets";
import { rectOf } from "../utils/geometry";
import { createCommandRegistry } from "../commands/registry";
import { editorKindForMode, makeContext } from "../commands/context";
import { defaultCommands, noopCommandDeps } from "../commands/defaults";

import type { AnyCommand, CommandRegistry } from "../commands/registry";
import type { CommandContext } from "../commands/context";
import type { CommandDeps } from "../commands/defaults";
import type { ApplyFormatIntent } from "../canvas/iframe-protocol";
import type { JxPath } from "../state";
import type { JxMutableNode } from "@jxsuite/schema/types";
import type { TemplateResult } from "lit-html";
import type { SlashCommand } from "../editor/convert-targets.js";

/** The plain format commands (everything an action button posts except link/insertData). */
type FormatCommand = Extract<ApplyFormatIntent, { command: "bold" }>["command"];

/**
 * @type {{
 *   getCanvasMode: () => string;
 *   navigateToComponent: (path: string) => void;
 * } | null}
 */
let _ctx: {
  getCanvasMode: () => string;
  navigateToComponent: (path: string) => void;
} | null = null;

/**
 * Initialize the block action bar module.
 *
 * @param {{
 *   getCanvasMode: () => string;
 *   navigateToComponent: (path: string) => void;
 * }} ctx
 */
export function initBlockActionBar(ctx: {
  getCanvasMode: () => string;
  navigateToComponent: (path: string) => void;
}) {
  _ctx = ctx;
  if (!_formatShortcutBound) {
    document.addEventListener("keydown", handleParentFormatShortcut);
    // ⌥↑ is the keyboard way INTO the bar. The audit found it unreachable without a mouse.
    document.addEventListener("keydown", handleBlockBarEntryKey);
    // `scroll` doesn't bubble but IS deliverable capture-phase at the document — one app-lifetime
    // Listener covers .content-edit-canvas (edit mode), window scrolls, and any future scroll
    // Container, keeping the position:fixed bar tracking its (scrolling) anchor.
    document.addEventListener("scroll", onCanvasScroll, { capture: true, passive: true });
    _formatShortcutBound = true;
  }
}

/** Register the parent-document format-shortcut + scroll handlers exactly once. */
let _formatShortcutBound = false;

/** One reposition per frame, no matter how many scroll events land in it. */
let _scrollRafPending = false;

/**
 * Reposition the bar on a canvas-area scroll — rAF-throttled and via the style fast path ({@link
 * repositionBlockActionBar}), NOT a full lit re-render (which would tear down and re-create the
 * drag-handle's pragmatic-dnd registration every frame). Exported for tests.
 *
 * @param {Event} e
 */
export function onCanvasScroll(e: Event): void {
  if (!_ctx || _linkPopoverOpen) {
    return;
  }
  if (activeTab.value?.session.selection.length === 0) {
    return;
  }
  const mode = _ctx.getCanvasMode();
  if (mode !== "design" && mode !== "edit") {
    return;
  }
  // Only canvas-area scrolls (or the window itself) move the anchor; left/right panel scrolling
  // Never does.
  const isCanvasScroll =
    e.target === document || (e.target instanceof Node && stageContaining(e.target) !== null);
  if (!isCanvasScroll || _scrollRafPending) {
    return;
  }
  _scrollRafPending = true;
  requestAnimationFrame(() => {
    _scrollRafPending = false;
    repositionBlockActionBar();
  });
}

/**
 * Style-only fast path: move the existing bar to the anchor's current position (fresh
 * {@link getEditBarAnchorRect} — the iframe's GBCR moves with the scroll). Hides via `visibility`
 * when the anchor left the canvas area so the lit tree (and the drag handle's dnd registration)
 * survives; a bar hidden by the full render path (`nothing`) is resurrected with a full render.
 */
function repositionBlockActionBar(): void {
  const bar = view.blockActionBarEl?.firstElementChild as HTMLElement | null;
  if (!bar) {
    renderBlockActionBar();
    return;
  }
  const anchor = getEditBarAnchorRect();
  const pos = anchor ? barPosition(anchor) : null;
  if (!pos) {
    bar.style.visibility = "hidden";
    return;
  }
  bar.style.visibility = "";
  bar.style.left = `${pos.left}px`;
  bar.style.top = `${pos.top}px`;
  clampBarToWindow(bar);
}

/**
 * The bar's position for `anchor` (flipping below the element near the top edge), or null when the
 * anchor's vertical extent has left the canvas area — the popover layer has no clipping, so a
 * clamped bar would float detached over the app toolbar / panel headers.
 *
 * @param {{ left: number; top: number; height: number }} anchor
 */
function barPosition(anchor: {
  left: number;
  top: number;
  height: number;
}): { left: number; top: number } | null {
  /* Clipped against the stage the CARET is on. The bar anchors to one selection in one document,
     and the bar is one element, so "is the anchor still on screen" is a question about ONE pane's
     stage — and the pane is the FOCUSED one, because that is where the caret is. This asked
     "the stage showing the active tab", which was the same answer only while a tab could be on
     screen in one place; with a document displayed in two panes it picked whichever came first in
     the grid, and clipped the bar against a stage the author is not typing in. */
  const stage = activeCanvasSurface().wrap;
  if (stage) {
    const wrap = rectOf(stage);
    if (anchor.top + anchor.height < wrap.top || anchor.top > wrap.bottom) {
      return null;
    }
  }
  return {
    left: anchor.left,
    top: anchor.top < 80 ? anchor.top + anchor.height + 4 : anchor.top - 38,
  };
}

/**
 * Pull the bar back inside the window's right edge.
 *
 * @param {HTMLElement} bar
 */
function clampBarToWindow(bar: HTMLElement): void {
  const barRect = rectOf(bar);
  if (barRect.right > window.innerWidth) {
    bar.style.left = `${Math.max(0, window.innerWidth - barRect.width)}px`;
  }
}

/**
 * Route Ctrl/Cmd+B/I/`/K to the iframe while an inline-edit session is live but focus is on the
 * PARENT (the format toolbar or its link popover) — the keystroke never reaches the iframe's own
 * contenteditable handler. When focus is inside the canvas iframe, do nothing (the iframe handles
 * it and forwards globals via `forwardKey`). Exported so the unit test can dispatch it directly.
 *
 * @param {KeyboardEvent} e
 */
export function handleParentFormatShortcut(e: KeyboardEvent): void {
  if (!(e.ctrlKey || e.metaKey) || e.altKey) {
    return;
  }
  // Same rule as the global shortcuts: a modal surface owns the keyboard, so ⌘B never reformats the
  // Document behind an underlay the author cannot click through.
  if (isModalOpen() || !getEditSnapshot().editing) {
    return;
  }
  // Focus inside the cross-origin canvas iframe surfaces as the <iframe> element being active.
  const active = document.activeElement;
  if (active instanceof HTMLIFrameElement && active.classList.contains("jx-canvas-iframe")) {
    return;
  }
  const key = e.key.toLowerCase();
  if (key === "b") {
    e.preventDefault();
    postApplyFormat({ command: "bold" });
  } else if (key === "i") {
    e.preventDefault();
    postApplyFormat({ command: "italic" });
  } else if (key === "`") {
    e.preventDefault();
    postApplyFormat({ command: "code" });
  } else if (key === "k") {
    e.preventDefault();
    openLinkPopoverFromShortcut();
  }
}

// ─── The selection command layer ─────────────────────────────────────────────

/** Enough of a tab for the structural verbs. Mirrors `activeTab.value`'s non-null type. */
type ActiveTab = NonNullable<typeof activeTab.value>;

/**
 * The node the selection verbs act on, when it is not simply the selection.
 *
 * The block action bar's target IS the selection. An Outline row's target is the ROW'S node —
 * `PLACEMENT_MATRIX["outline/row"]` says so ("row actions act on the row's node"), and a hovered
 * row is not the selected one. Rather than teach every record a second argument, the surface
 * declares the target for the duration of one synchronous render or one click
 * ({@link withCommandTarget}); the records keep reading one function.
 */
let _commandTarget: JxPath | null = null;

/** The path the selection verbs currently address: an explicit target, else the selection. */
export function commandTargetPath(): JxPath | null {
  return _commandTarget ?? primarySelection(activeTab.value?.session.selection);
}

/**
 * The paths a BATCH verb addresses — Delete and Duplicate, the two that are meaningful on a set.
 *
 * An explicit target wins outright and is always exactly one path:
 * `PLACEMENT_MATRIX["outline/row"]` says a row action acts on the row's node, and a hovered row is
 * not the selection. With no explicit target this is the whole selection, so `length === 1` hands
 * back the single path the verbs have always received.
 *
 * The move verbs deliberately do NOT use this. "Move six nodes up one slot" has no single answer
 * when they are not siblings, and every one of them is `childIndex` arithmetic against a parent
 * that the previous move just renumbered.
 *
 * @returns {JxPath[]}
 */
export function commandTargetPaths(): JxPath[] {
  if (_commandTarget) {
    return [_commandTarget];
  }
  return activeTab.value?.session.selection ?? [];
}

/** Run `fn` with `path` as the command target. Synchronous — the target never outlives the call. */
export function withCommandTarget<T>(path: JxPath, fn: () => T): T {
  const previous = _commandTarget;
  _commandTarget = path;
  try {
    return fn();
  } finally {
    _commandTarget = previous;
  }
}

/** Whether `node` is an instance of a registered project component. */
function isComponentInstanceNode(node: JxMutableNode | null | undefined): boolean {
  const tag = node?.tagName;
  const literal = displayTagName(tag);
  return Boolean(literal.includes("-") && componentRegistry.some((c) => c.tagName === literal));
}

/**
 * The {@link CommandContext} the selection verbs are evaluated against.
 *
 * Only the groups these records read are populated; everything else keeps `emptyContext`'s honest
 * cold-start value. `isRoot` is `parentElementPath(path) === null`, which is the same test in both
 * document modes: a content root sits at `[]`, an element root at `[]` too, and every movable node
 * has a `[…, "children", i]` tail.
 */
export function selectionCommandContext(): CommandContext {
  const tab = activeTab.value;
  const path = commandTargetPath();
  const node = tab && path ? getNodeAtPath(tab.doc.document, path) : null;
  return makeContext({
    // The editor kind is part of the answer, not a default: `makeContext` fills it with "none",
    // Which now reads as "not a canvas" and would hide the bar's own verbs from itself.
    editor: { kind: tab ? editorKindForMode(tab.session.ui.canvasMode) : "none" },
    document: { open: Boolean(tab) },
    selection: {
      count: path ? 1 : 0,
      isComponentInstance: isComponentInstanceNode(node),
      isRoot: path ? parentElementPath(path) === null : false,
      kind: displayTagName(node?.tagName),
    },
  });
}

/** The structural facts a move verb needs. `null` when the target cannot be moved at all. */
interface StructuralTarget {
  tab: ActiveTab;
  path: JxPath;
  index: number;
  parentPath: JxPath;
  siblings: (JxMutableNode | string)[];
}

/** Resolve the current command target to its parent/index/siblings, or `null` if it has none. */
function structuralTarget(path: JxPath | null = commandTargetPath()): StructuralTarget | null {
  const tab = activeTab.value;
  if (!tab || !path) {
    return null;
  }
  /* THE SAME CONJUNCT `hasSelection` CARRIES, and for the same reason it gives. Four movers gate on
     this function and none of them asked what editor is open, while their peers Delete and
     Duplicate did — so with Project Settings focused the Outline row menu dropped Delete and
     Duplicate and still rendered Move Up / Move Down / Move Into Previous / Move Out of Parent.
     Those four `transactDoc` element splices straight into `project.json` through the transaction
     log and then rewrite `session.selection`; the write lands and is saved. One surface, two rules,
     and the loose ones were the mutating majority. Asked once, here, because all four share it. */
  if (editorKindForMode(tab.session.ui.canvasMode) !== "canvas") {
    return null;
  }
  const index = childIndex(path);
  const parentPath = parentElementPath(path);
  if (typeof index !== "number" || !parentPath) {
    return null;
  }
  const parentNode = getNodeAtPath(tab.doc.document, parentPath);
  if (!parentNode) {
    return null;
  }
  return { index, parentPath, path, siblings: childList(parentNode), tab };
}

/**
 * Whether `node` can accept a dropped-in sibling — the precondition for "move into previous".
 *
 * A void element cannot; an element whose only children are inline (a paragraph's `<em>`) is a text
 * block, not a container, and nesting a block inside it produces invalid markup.
 */
function isContainerNode(node: JxMutableNode | string | null | undefined): boolean {
  if (!node || typeof node !== "object") {
    return false;
  }
  if (VOID_ELEMENTS.has((displayTagName(node.tagName) || "div").toLowerCase())) {
    return false;
  }
  const { children } = node;
  if (!children) {
    return false;
  }
  if (!Array.isArray(children)) {
    return (children as unknown as Record<string, unknown>).$prototype === "Array";
  }
  return (
    children.length === 0 ||
    children.some((c) => typeof c === "object" && c !== null && !isInlineElement(c, node))
  );
}

function canMoveUp(): boolean {
  const target = structuralTarget();
  return target !== null && target.index > 0;
}

function canMoveDown(): boolean {
  const target = structuralTarget();
  return target !== null && target.index < target.siblings.length - 1;
}

function canMoveIn(): boolean {
  const target = structuralTarget();
  return target !== null && target.index > 0 && isContainerNode(target.siblings[target.index - 1]);
}

function canMoveOut(): boolean {
  const target = structuralTarget();
  return (
    target !== null &&
    parentElementPath(target.parentPath) !== null &&
    typeof childIndex(target.parentPath) === "number"
  );
}

/** Move the target up one slot among its siblings, keeping it selected. */
function moveTargetUp(): void {
  const target = structuralTarget();
  if (!target || target.index === 0) {
    return;
  }
  const { index, parentPath, path, tab } = target;
  transactDoc(tab, (t) => mutateMoveNode(t, path, parentPath, index - 1));
  tab.session.selection = [[...parentPath, "children", index - 1]];
}

/** Move the target down one slot among its siblings, keeping it selected. */
function moveTargetDown(): void {
  const target = structuralTarget();
  if (!target || target.index >= target.siblings.length - 1) {
    return;
  }
  const { index, parentPath, path, tab } = target;
  // `index + 2`: mutateMoveNode removes before it inserts, so a same-parent move down needs the
  // Post-removal index of the slot AFTER the next sibling.
  transactDoc(tab, (t) => mutateMoveNode(t, path, parentPath, index + 2));
  tab.session.selection = [[...parentPath, "children", index + 1]];
}

/** Append the target to its previous sibling, making it that element's last child. */
function moveTargetIn(): void {
  const target = structuralTarget();
  if (!canMoveIn() || !target) {
    return;
  }
  const { index, parentPath, path, tab } = target;
  const prevPath = [...parentPath, "children", index - 1];
  const { length } = childList(getNodeAtPath(tab.doc.document, prevPath));
  transactDoc(tab, (t) => mutateMoveNode(t, path, prevPath, length));
  tab.session.selection = [[...prevPath, "children", length]];
}

/** Lift the target out of its parent, landing it directly after that parent. */
function moveTargetOut(): void {
  const target = structuralTarget();
  if (!target) {
    return;
  }
  const grandparent = parentElementPath(target.parentPath);
  const parentIndex = childIndex(target.parentPath);
  if (!grandparent || typeof parentIndex !== "number") {
    return;
  }
  transactDoc(target.tab, (t) => mutateMoveNode(t, target.path, grandparent, parentIndex + 1));
  target.tab.session.selection = [[...grandparent, "children", parentIndex + 1]];
}

/**
 * Delete every targeted node, leaving the primary's parent selected (never a dangling path).
 *
 * One transaction, therefore one undo step — a six-node delete that produced six history entries
 * would make ⌘Z a rebuild rather than a reversal.
 *
 * **A delete that removes nothing moves nothing.** The selection jump is the visible half of this
 * verb, and running it over an unchanged document is the app telling the author something happened
 * when nothing did. There are two ways to remove nothing, and each is checked on its own side of
 * the transaction:
 *
 * - `mutateRemoveNodes` removes exactly {@link structuralBatch}, which drops every path that names no
 *   splice coordinate — the document element, a repeater's map template, a `$switch` case. A target
 *   made only of those filters out entirely, and calling `transactDoc` anyway would ALSO mark the
 *   tab dirty and push an undo step that reverses nothing. So an empty batch returns before the
 *   transaction rather than after it.
 * - `transactDoc` itself declines while a peer holds source-canonical, and says so by leaving the
 *   document root reference — which it otherwise always replaces — exactly as it found it.
 */
function deleteTarget(): void {
  const tab = activeTab.value;
  const paths = commandTargetPaths();
  const path = commandTargetPath();
  // An empty target and a target of nothing-spliceable are the same answer: `structuralBatch([])`
  // Is `[]`, so one test covers both.
  if (!tab || !path || structuralBatch(paths).length === 0) {
    return;
  }
  const documentBefore = tab.doc.document;
  transactDoc(tab, (t) => mutateRemoveNodes(t, paths));
  if (tab.doc.document === documentBefore) {
    return;
  }
  const parentPath = parentElementPath(path);
  tab.session.selection = parentPath ? [parentPath] : [];
}

/** Duplicate every targeted node in one transaction, selecting the copies. */
function duplicateTarget(): void {
  const tab = activeTab.value;
  const paths = commandTargetPaths();
  if (!tab || paths.length === 0) {
    return;
  }
  transactDoc(tab, (t) => mutateDuplicateNodes(t, paths));
}

/** Select the target's parent element. */
function selectParentOfTarget(): void {
  const tab = activeTab.value;
  const path = commandTargetPath();
  const parentPath = path ? parentElementPath(path) : null;
  if (tab && parentPath) {
    tab.session.selection = [parentPath];
  }
}

/** What the structural selection verbs need that this module does not own. */
export interface SelectionCommandDeps {
  /** Open the component definition behind the selected instance. */
  navigateToComponent: (path: string) => void;
  /** Lift the selection into a new component file. */
  convertToComponent: () => void;
}

/** A target exists at all — the `when` every selection verb shares. */
const hasTarget = (ctx: CommandContext) => ctx.selection.count > 0;

/**
 * The structural selection verbs, defined once.
 *
 * `group` keys are ordering keys, not categories: the four moves sort ahead of `3_structure`
 * (Duplicate, from `commands/defaults.ts`) and `9_danger` (Delete, likewise), which is the order
 * the bar and the Outline rows both render in.
 *
 * No `keybinding` is claimed here on purpose. The chord table is `editor/shortcuts.ts`'s port (plan
 * P2 workstream 4); claiming chords from a panel would decide that port's outcome by accident. The
 * buttons still print the chords of the records that DO carry them.
 */
export function registerSelectionCommands(
  registry: CommandRegistry,
  deps: SelectionCommandDeps,
): void {
  registry.registerAll([
    {
      category: "Selection",
      enablement: canMoveUp,
      group: "1_move_1",
      icon: "sp-icon-arrow-up",
      id: "selection.moveUp",
      keyScope: "canvas",
      level: "selection",
      menus: ["blockbar", "outline/row"],
      requires: "an element with a sibling above it",
      run: () => moveTargetUp(),
      title: "Move Up",
      undo: "document",
      when: hasTarget,
    },
    {
      category: "Selection",
      enablement: canMoveDown,
      group: "1_move_2",
      icon: "sp-icon-arrow-down",
      id: "selection.moveDown",
      keyScope: "canvas",
      level: "selection",
      menus: ["blockbar", "outline/row"],
      requires: "an element with a sibling below it",
      run: () => moveTargetDown(),
      title: "Move Down",
      undo: "document",
      when: hasTarget,
    },
    {
      category: "Selection",
      enablement: canMoveIn,
      group: "1_move_3",
      icon: "sp-icon-arrow-right",
      id: "selection.moveIn",
      keyScope: "canvas",
      level: "selection",
      menus: ["outline/row"],
      requires: "a container directly above the element",
      run: () => moveTargetIn(),
      title: "Move Into Previous",
      undo: "document",
      when: hasTarget,
    },
    {
      category: "Selection",
      enablement: canMoveOut,
      group: "1_move_4",
      icon: "sp-icon-arrow-left",
      id: "selection.moveOut",
      keyScope: "canvas",
      level: "selection",
      menus: ["outline/row"],
      requires: "an element nested inside another",
      run: () => moveTargetOut(),
      title: "Move Out of Parent",
      undo: "document",
      when: hasTarget,
    },
    // Convert / Edit are one slot with two states, not two optional buttons: `when` splits them on
    // "is this a component instance", so exactly one of the pair renders for any selection and the
    // Bar keeps its shape.
    {
      category: "Selection",
      // …and the same conjunct here: Convert to Component starts a project-level flow, so it must
      // Not be reachable from a config node drawn as a layer tree.
      enablement: (ctx) =>
        Boolean(ctx.selection.kind) && !ctx.selection.isRoot && ctx.editor.kind === "canvas",
      group: "4_component",
      icon: "sp-icon-box",
      id: "selection.convertToComponent",
      level: "selection",
      // Three surfaces, ONE record. `editor/context-menu.ts` carried a second `convertToComponent`
      // With the same title and a different `when`, invisible to every registry but its own popover.
      menus: ["blockbar", "context/element", "palette"],
      requires: "an element that is not the document root",
      // Deliberately NOT awaited: `convertToComponent()` resolves when the human answers the name
      // Dialog, and a command whose promise waits on a person is a command nothing automated can
      // Call. `run()` means "start this flow", the same as `settings.open` and `project.new`.
      run: () => {
        void deps.convertToComponent();
      },
      title: "Convert to Component",
      undo: "project",
      when: (ctx) => ctx.selection.count > 0 && !ctx.selection.isComponentInstance,
    },
    {
      category: "Selection",
      group: "4_component",
      icon: "sp-icon-edit",
      id: "selection.editComponent",
      level: "selection",
      menus: ["blockbar", "context/element", "palette"],
      requires: "a component instance",
      run: () => {
        const node = componentOfTarget();
        if (node) {
          deps.navigateToComponent(node);
        }
      },
      title: "Edit Component",
      undo: "none",
      when: (ctx) => ctx.selection.isComponentInstance,
    },
  ] satisfies AnyCommand[]);
}

/** The component file behind the current target, when it is an instance. */
function componentOfTarget(): string | null {
  const tab = activeTab.value;
  const path = commandTargetPath();
  const node = tab && path ? getNodeAtPath(tab.doc.document, path) : null;
  const entry = componentRegistry.find((c) => c.tagName === node?.tagName);
  return entry?.path ?? null;
}

/** The registry the two selection surfaces render. Injected by a host, or built on first use. */
let _registry: CommandRegistry | null = null;

/**
 * Hand the surfaces the app-wide registry (or `null` to drop back to the surface's own).
 *
 * A host that injects one is responsible for two things: registering
 * {@link registerSelectionCommands}, and building its `getContext` so it honours
 * {@link commandTargetPath} — otherwise an Outline row's buttons report the SELECTION's enablement
 * rather than the row's.
 */
export function useCommandRegistry(registry: CommandRegistry | null): void {
  _registry = registry;
}

/**
 * The registry the block action bar and the Outline rows render.
 *
 * Until a host bootstrap injects one there is no app-wide registry, so this builds the surface's
 * own: the SELECTION-level slice of `commands/defaults.ts` (which is where Delete, Duplicate and
 * Select Parent are defined, with `blockbar` / `outline/row` already declared) plus the structural
 * verbs above. The other levels are filtered out rather than stubbed — Save is not this surface's
 * to own, and a registry holding a no-op `file.save` would be a lie.
 */
export function selectionCommandRegistry(): CommandRegistry {
  if (_registry) {
    return _registry;
  }
  const registry = createCommandRegistry({ getContext: selectionCommandContext });
  const deps: CommandDeps = {
    ...noopCommandDeps(),
    deleteSelection: deleteTarget,
    duplicateSelection: duplicateTarget,
    selectParent: selectParentOfTarget,
  };
  registry.registerAll(defaultCommands(deps).filter((command) => command.level === "selection"));
  registerSelectionCommands(registry, {
    convertToComponent: () => convertToComponent(),
    navigateToComponent: (path) => _ctx?.navigateToComponent(path),
  });
  _registry = registry;
  return registry;
}

/** How many verb buttons the bar renders before the rest fold into `⋮` (plan §3.2 ⑩). */
export const BLOCKBAR_MAX_ITEMS = 5;

/**
 * Icons for command records, keyed by the record's own `icon`.
 *
 * A record with no icon renders its title as text rather than an unlabelled blank: the surface is
 * allowed to choose how a name is drawn, never what it is.
 */
const commandIconMap: Record<string, TemplateResult> = {
  "sp-icon-arrow-down": html`<sp-icon-arrow-down slot="icon"></sp-icon-arrow-down>`,
  "sp-icon-arrow-left": html`<sp-icon-arrow-left slot="icon"></sp-icon-arrow-left>`,
  "sp-icon-arrow-right": html`<sp-icon-arrow-right slot="icon"></sp-icon-arrow-right>`,
  "sp-icon-arrow-up": html`<sp-icon-arrow-up slot="icon"></sp-icon-arrow-up>`,
  "sp-icon-box": html`<sp-icon-box slot="icon" size="xs"></sp-icon-box>`,
  "sp-icon-delete": html`<sp-icon-delete slot="icon"></sp-icon-delete>`,
  "sp-icon-duplicate": html`<sp-icon-duplicate slot="icon"></sp-icon-duplicate>`,
  "sp-icon-edit": html`<sp-icon-edit slot="icon" size="xs"></sp-icon-edit>`,
};

/** The record's icon, or its title drawn as a compact label. */
export function commandIcon(command: AnyCommand): TemplateResult {
  return (
    (command.icon ? commandIconMap[command.icon] : undefined) ??
    html`<span class="cmd-label">${command.title}</span>`
  );
}

/**
 * The tooltip: the chord when the control can act, the `requires` sentence when it cannot.
 *
 * Both strings come from the record. The accessible name stays the bare `title` either way, so a
 * screen reader announces "Delete", not "Delete, requires an element selection".
 */
export function commandTooltip(registry: CommandRegistry, command: AnyCommand): string {
  const reason = registry.disabledReason(command.id);
  if (reason !== undefined) {
    return `${command.title} — requires ${reason}`;
  }
  const chord = registry.keymap.formatBinding(command.id);
  return chord ? `${command.title} (${chord})` : command.title;
}

/** Run a command, swallowing the refusal a disabled control should never have produced. */
export function runCommand(registry: CommandRegistry, id: string, target?: JxPath | null): void {
  const invoke = () => {
    if (registry.isEnabled(id)) {
      void registry.run(id);
    }
  };
  if (target) {
    withCommandTarget(target, invoke);
  } else {
    invoke();
  }
}

/** Pre-built icon templates for inline format buttons (avoids unsafeStatic) */
const formatIconMap = {
  "sp-icon-code": html`<sp-icon-code slot="icon"></sp-icon-code>`,
  "sp-icon-link": html`<sp-icon-link slot="icon"></sp-icon-link>`,
  "sp-icon-text-bold": html`<sp-icon-text-bold slot="icon"></sp-icon-text-bold>`,
  "sp-icon-text-italic": html`<sp-icon-text-italic slot="icon"></sp-icon-text-italic>`,
  "sp-icon-text-strikethrough": html`<sp-icon-text-strikethrough
    slot="icon"
  ></sp-icon-text-strikethrough>`,
  "sp-icon-text-subscript": html`<sp-icon-text-subscript slot="icon"></sp-icon-text-subscript>`,
  "sp-icon-text-superscript": html`<sp-icon-text-superscript
    slot="icon"
  ></sp-icon-text-superscript>`,
  "sp-icon-text-underline": html`<sp-icon-text-underline slot="icon"></sp-icon-text-underline>`,
} as Record<string, TemplateResult>;

/**
 * Prevent the bar from stealing focus from contenteditable
 *
 * @param {MouseEvent} e
 */
function onBarMousedown(e: MouseEvent) {
  if ((e.target as HTMLElement).closest("sp-textfield")) {
    return;
  }
  if ((e.target as HTMLElement).closest(".bar-drag-handle")) {
    return;
  }
  if ((e.target as HTMLElement).closest(".bar-tag--interactive")) {
    return;
  }
  e.preventDefault();
}

/**
 * @param {MouseEvent} e
 * @param {import("../editor/convert-targets.js").SlashCommand[]} targets
 * @param {JxPath} selection
 */
function onTagBadgeClick(e: MouseEvent, targets: SlashCommand[], selection: JxPath) {
  e.stopPropagation();
  const anchorEl = e.currentTarget as HTMLElement;
  showSlashMenu(anchorEl, "", {
    commands: targets,
    onSelect: (cmd) => {
      transactDoc(activeTab.value, (t) => {
        mutateUpdateProperty(t, selection, "tagName", cmd.tag);
      });
    },
    showFilter: targets.length > 6,
  });
}

/**
 * Handle a format-button click. The iframe owns the Selection — link opens the parent popover;
 * every other command posts an `applyFormat` intent across the bridge.
 *
 * @param {MouseEvent} e
 * @param {InlineAction} action
 */
function onFormatClick(e: MouseEvent, action: InlineAction) {
  e.stopPropagation();
  if (action.command === "link") {
    showLinkPopover((e.target as HTMLElement).closest("sp-action-button") as HTMLElement);
  } else if (action.command) {
    postApplyFormat({ command: action.command as FormatCommand });
  }
}

/**
 * The parent selector.
 *
 * It renders the `selection.selectParent` record — its name, its chord and its handler — but as
 * fixed chrome rather than from `forPlacement("blockbar")`, because that record does not declare
 * the placement. Its disabled state is "the selection has no parent", which the record's own
 * `enablement` (a bare "there is a selection") cannot express yet.
 */
function renderParentButton(registry: CommandRegistry) {
  const tab = activeTab.value;
  const selection = primarySelection(tab?.session.selection);
  const parentPath = selection ? parentElementPath(selection) : null;
  const parentNode = tab && parentPath ? getNodeAtPath(tab.doc.document, parentPath) : null;
  const command = registry.get("selection.selectParent");
  const name = command?.title ?? "Select Parent";
  const chord = command ? registry.keymap.formatBinding(command.id) : undefined;
  const label = parentNode ? `Select parent: ${nodeLabel(parentNode)}` : name;
  return html`
    <sp-action-button
      size="xs"
      quiet
      data-toolbar-item
      tabindex="-1"
      aria-label=${label}
      title=${chord ? `${label} (${chord})` : label}
      ?disabled=${!parentPath}
      @click=${(e: MouseEvent) => {
        e.stopPropagation();
        runCommand(registry, "selection.selectParent");
      }}
    >
      <sp-icon-back slot="icon"></sp-icon-back>
    </sp-action-button>
  `;
}

/** One verb, rendered from its record. */
function renderCommandButton(registry: CommandRegistry, command: AnyCommand) {
  const disabled = registry.disabledReason(command.id) !== undefined;
  return html`<sp-action-button
    size="xs"
    quiet
    class=${command.destructive ? "bar-cmd bar-cmd--danger" : "bar-cmd"}
    data-toolbar-item
    data-command=${command.id}
    tabindex="-1"
    aria-label=${command.title}
    title=${commandTooltip(registry, command)}
    ?disabled=${disabled}
    @mousedown=${(e: MouseEvent) => e.preventDefault()}
    @click=${(e: MouseEvent) => {
      e.stopPropagation();
      runCommand(registry, command.id);
    }}
    >${commandIcon(command)}</sp-action-button
  >`;
}

/** The `⋮` button and the menu of everything past {@link BLOCKBAR_MAX_ITEMS}. */
function renderOverflowButton(registry: CommandRegistry, commands: readonly AnyCommand[]) {
  return html`<sp-action-button
    size="xs"
    quiet
    class="bar-overflow"
    data-toolbar-item
    tabindex="-1"
    aria-label="More block actions"
    aria-haspopup="menu"
    title="More block actions"
    @mousedown=${(e: MouseEvent) => e.preventDefault()}
    @click=${(e: MouseEvent) => {
      e.stopPropagation();
      showCommandOverflow(e.currentTarget as HTMLElement, registry, commands);
    }}
  >
    <sp-icon-more slot="icon"></sp-icon-more>
  </sp-action-button>`;
}

/** The open overflow menu, so a second press (or a re-render) closes rather than stacks it. */
let _overflowHandle: { dismiss: () => void; host: HTMLElement } | null = null;

/** Close the block action bar's `⋮` menu if it is open. */
export function dismissBlockBarOverflow(): void {
  _overflowHandle?.dismiss();
  _overflowHandle = null;
}

/**
 * Show the `⋮` menu under `anchor`. Rows carry the same names, chords and refusals as the buttons.
 *
 * Shared by the block action bar and the Outline rows — one menu is open at a time, so `target`
 * (the Outline row's node) is captured per row and re-applied when a row is chosen.
 */
export function showCommandOverflow(
  anchor: HTMLElement,
  registry: CommandRegistry,
  commands: readonly AnyCommand[],
  target: JxPath | null = null,
): void {
  dismissBlockBarOverflow();
  const rect = rectOf(anchor);
  // Resolve every row's name / chord / refusal against the TARGET, not the selection, before the
  // Template is built — lit evaluates these eagerly, so the wrap has to cover the whole projection.
  const project = () =>
    commands.map((command) => ({
      chord: registry.keymap.formatBinding(command.id),
      destructive: command.destructive === true,
      disabled: registry.disabledReason(command.id) !== undefined,
      id: command.id,
      title: command.title,
      tooltip: commandTooltip(registry, command),
    }));
  const rows = target ? withCommandTarget(target, project) : project();
  _overflowHandle = renderPopover(
    html`<sp-popover
      open
      class="bar-overflow-menu"
      style=${styleMap({
        left: `${rect.left}px`,
        position: "fixed",
        top: `${rect.bottom + 4}px`,
        zIndex: "101",
      })}
    >
      <sp-menu>
        ${rows.map(
          (row) => html`<sp-menu-item
            ?disabled=${row.disabled}
            data-command=${row.id}
            title=${row.tooltip}
            style=${row.destructive ? "color: var(--danger)" : nothing}
            @click=${() => {
              dismissBlockBarOverflow();
              runCommand(registry, row.id, target);
            }}
            >${row.title}${
              row.chord ? html`<kbd slot="value" class="cmd-chord">${row.chord}</kbd>` : nothing
            }</sp-menu-item
          >`,
        )}
      </sp-menu>
    </sp-popover>`,
    {
      dismissOnOutsideClick: true,
      onDismiss: () => {
        _overflowHandle = null;
      },
    },
  );
}

// ─── Toolbar keyboard model ──────────────────────────────────────────────────

/** The bar's focusable items, in DOM order, skipping the ones that cannot act. */
function toolbarItems(bar: HTMLElement): HTMLElement[] {
  return [...bar.querySelectorAll<HTMLElement>("[data-toolbar-item]")].filter(
    (el) => !el.hasAttribute("disabled") && el.getAttribute("aria-disabled") !== "true",
  );
}

/**
 * Apply the roving tabindex: exactly one item is in the tab order at a time.
 *
 * Called after every render, so the survivor is whichever item still holds focus and otherwise the
 * first — a toolbar that resets to its first control on every keystroke is not navigable.
 */
export function applyRovingTabindex(bar: HTMLElement): void {
  const items = toolbarItems(bar);
  const focused = items.findIndex(
    (el) => el === document.activeElement || el.contains(document.activeElement),
  );
  const active = focused === -1 ? 0 : focused;
  for (const [index, el] of items.entries()) {
    el.tabIndex = index === active ? 0 : -1;
  }
}

/** Move focus to item `index` (wrapping), and make it the one in the tab order. */
function focusToolbarItem(bar: HTMLElement, index: number): void {
  const items = toolbarItems(bar);
  if (items.length === 0) {
    return;
  }
  const wrapped = ((index % items.length) + items.length) % items.length;
  for (const [i, el] of items.entries()) {
    el.tabIndex = i === wrapped ? 0 : -1;
  }
  items[wrapped]!.focus();
}

/** Put the keyboard back where it came from — the canvas iframe, else its wrapper. */
function returnFocusToCanvas(): void {
  // The FOCUSED pane's stage: the keyboard came from there and is going back there. Resolving it
  // From the active tab answered with whichever pane displays that document first.
  const stage = activeCanvasSurface().wrap;
  const iframe = stage?.querySelector<HTMLElement>("iframe.jx-canvas-iframe");
  (iframe ?? stage)?.focus();
}

/** `role="toolbar"` navigation: ←/→ between items, Home/End to the ends, Esc back to the canvas. */
export function onToolbarKeydown(e: KeyboardEvent): void {
  const bar = e.currentTarget as HTMLElement;
  const items = toolbarItems(bar);
  const current = items.findIndex(
    (el) => el === document.activeElement || el.contains(document.activeElement),
  );
  if (e.key === "ArrowRight") {
    e.preventDefault();
    focusToolbarItem(bar, current + 1);
  } else if (e.key === "ArrowLeft") {
    e.preventDefault();
    focusToolbarItem(bar, current - 1);
  } else if (e.key === "Home") {
    e.preventDefault();
    focusToolbarItem(bar, 0);
  } else if (e.key === "End") {
    e.preventDefault();
    focusToolbarItem(bar, items.length - 1);
  } else if (e.key === "Escape") {
    e.preventDefault();
    dismissBlockBarOverflow();
    returnFocusToCanvas();
  }
}

/**
 * ⌥↑ enters the bar from the canvas.
 *
 * Bound on the PARENT document, so it fires whenever the parent chrome owns focus. A press from
 * inside the canvas iframe does not arrive: `canvas/iframe-keys.ts` forwards bare navigation keys
 * only when the target is not editable, and the canvas root is permanently `contenteditable`.
 * Exported so a test can dispatch it directly.
 */
export function handleBlockBarEntryKey(e: KeyboardEvent): void {
  if (e.key !== "ArrowUp" || !e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) {
    return;
  }
  if (isModalOpen()) {
    return;
  }
  const bar = view.blockActionBarEl?.querySelector<HTMLElement>(".block-action-bar");
  if (!bar) {
    return;
  }
  e.preventDefault();
  focusToolbarItem(bar, 0);
}

/**
 * Open the merge-tag menu — a searchable list of `${…}` template tokens for the data available in
 * the current state. Reuses the shared slash-menu popover (filter + keyboard nav + dismiss).
 * Selecting a token posts an `insertData` intent the iframe applies at its caret.
 *
 * @param {MouseEvent} e
 */
function onMergeTagClick(e: MouseEvent) {
  e.stopPropagation();
  const anchorEl = e.currentTarget as HTMLElement;
  const tab = activeTab.value;
  const state = (tab?.doc.document.state ?? {}) as Record<string, unknown>;
  // The live resolved scope lives inside the iframe realm and is not threaded out, so the parent
  // Offers only top-level `state.*` tokens (buildMergeTags tolerates the null scopes).
  const tags = buildMergeTags(state, null, null);

  // When the caret sits inside a repeater, offer its local scope (item/index + item fields). There is
  // No live `$map` in edit mode — the perimeter renders one glyph template — so fields resolve
  // Parent-side from schema, keyed off the selected element's doc path (which carries a `map` segment).
  const selPath = getEditSnapshot().snapshot?.path ?? primarySelection(tab?.session.selection);
  const arrayNode = tab && selPath ? findEnclosingRepeater(tab.doc.document, selPath) : null;
  if (arrayNode) {
    const tokens = resolveRepeaterItemFields(
      arrayNode,
      tab!.doc.document.state as Record<string, unknown>,
      projectState?.projectConfig,
    );
    tags.push(...buildRepeaterTagsFromFields(tokens));
  }

  const commands = tags.map((t) => ({
    description: t.hint,
    label: t.label,
    tag: t.token,
  }));

  showSlashMenu(anchorEl, "", {
    commands,
    onSelect: (cmd) => postApplyFormat({ command: "insertData", token: cmd.tag }),
    showFilter: true,
  });
}

/** Dismiss the link popover if open. */
export function dismissLinkPopover() {
  _linkPopoverOpen = false;
  const host = getLayerSlot("popover", "link-popover");
  litRender(nothing, host);
}

/** Dismiss the block action bar. */
export function dismissBlockActionBar() {
  dismissBlockBarOverflow();
  if (view.blockActionBarEl) {
    litRender(nothing, view.blockActionBarEl);
  }
}

/**
 * Whether the link popover is open. A snapshot-driven {@link renderBlockActionBar} must NOT
 * re-render (and so re-mount) the open popover — typing the URL would re-create the field and lose
 * focus/caret. Guarded around the toolbar re-render.
 */
let _linkPopoverOpen = false;

/** True while the link URL popover is open (so the toolbar refresh skips a disruptive re-render). */
export function isLinkPopoverOpen(): boolean {
  return _linkPopoverOpen;
}

/**
 * Whether `target` sits inside the edit-session chrome — the block action bar, its link popover, or
 * the slash menu. The parent's pointerdown commit-guard must NOT end the inline-edit session for
 * clicks on these (they operate ON the session); any other parent-chrome press commits it. This
 * module owns those popover roots, hence the helper lives here.
 *
 * @param {EventTarget | null} target
 */
export function isEditChromeTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Node)) {
    return false;
  }
  const roots = [
    view.blockActionBarEl,
    _overflowHandle?.host ?? null,
    getLayerSlot("popover", "link-popover"),
    getLayerSlot("popover", "slash-menu"),
  ];
  return roots.some((root) => root != null && root.contains(target));
}

/**
 * Show the link URL popover. The iframe owns the Selection, so the existing-link state comes from
 * the latest selection snapshot; Apply/Remove post `applyFormat` link intents the iframe applies.
 *
 * @param {HTMLElement} anchorBtn
 */
function showLinkPopover(anchorBtn: HTMLElement) {
  const host = getLayerSlot("popover", "link-popover");
  litRender(nothing, host);

  const link = getEditSnapshot().snapshot?.link ?? { active: false, href: null };
  const existing = link.active;

  const rect = rectOf(anchorBtn);

  let _linkField: HTMLInputElement | null = null;

  const close = () => {
    _linkPopoverOpen = false;
    litRender(nothing, host);
  };

  const onApply = () => {
    const url = _linkField?.value || "";
    // Apply then let the popover close itself (do not steal focus back into the iframe here).
    postApplyFormat({ command: "link", href: url || "" });
    close();
  };

  const onRemove = () => {
    postApplyFormat({ command: "link", href: null });
    close();
  };

  const onKeydown = (e: KeyboardEvent) => {
    if (e.key === "Enter") {
      onApply();
    } else if (e.key === "Escape") {
      close();
    }
  };

  _linkPopoverOpen = true;
  litRender(
    html`
      <sp-popover
        class="link-popover"
        open
        style=${styleMap({
          left: `${rect.left}px`,
          position: "fixed",
          top: `${rect.bottom + 4}px`,
          zIndex: "30",
        })}
      >
        <sp-textfield
          placeholder="https://..."
          size="s"
          style="width:200px"
          value=${link.href || ""}
          @keydown=${onKeydown}
          ${ref((el) => {
            _linkField = (el as HTMLInputElement | null) || null;
            if (el) {
              requestAnimationFrame(() => (el as HTMLElement).focus());
            }
          })}
        ></sp-textfield>
        <sp-action-button size="xs" @click=${onApply}>
          ${existing ? "Update" : "Apply"}
        </sp-action-button>
        ${
          existing
            ? html` <sp-action-button size="xs" @click=${onRemove}>Remove</sp-action-button> `
            : nothing
        }
      </sp-popover>
    `,
    host,
  );
}

/**
 * Open the link popover from the Ctrl/Cmd+K shortcut (anchored to the toolbar's Link button if it
 * is on screen, else the bar itself). Used by the parent-focus format-shortcut handler.
 */
export function openLinkPopoverFromShortcut(): void {
  const bar = view.blockActionBarEl?.querySelector(".block-action-bar") as HTMLElement | null;
  const linkBtn =
    (bar?.querySelector('sp-action-button[title^="Link"]') as HTMLElement | null) ?? bar;
  if (linkBtn) {
    showLinkPopover(linkBtn);
  }
}

/** Render the unified block action bar above the selected element. */
export function renderBlockActionBar() {
  if (!_ctx) {
    return;
  }
  if (!view.blockActionBarEl) {
    view.blockActionBarEl = getLayerSlot("popover", "block-action-bar");
  }

  if (view.selDragCleanup) {
    view.selDragCleanup();
    view.selDragCleanup = null;
  }

  const tab = activeTab.value;
  const canvasMode = _ctx.getCanvasMode();

  const selection = primarySelection(tab?.session.selection);
  if (!tab || !selection || (canvasMode !== "design" && canvasMode !== "edit")) {
    litRender(nothing, view.blockActionBarEl);
    return;
  }

  // A snapshot-driven refresh must not re-mount an open link popover (it would re-create the URL
  // Field and lose the caret) — preserve it by skipping this render pass.
  if (_linkPopoverOpen) {
    return;
  }

  const node = getNodeAtPath(tab.doc.document, selection);
  if (!node) {
    litRender(nothing, view.blockActionBarEl);
    return;
  }

  // Position from the iframe-host's viewport-space anchor (the bar is position:fixed). The parent
  // Never reads the iframe DOM, so geometry crosses the bridge as the selection snapshot's rect.
  const anchor = getEditBarAnchorRect();
  const pos = anchor ? barPosition(anchor) : null;
  if (!pos) {
    litRender(nothing, view.blockActionBarEl);
    return;
  }

  const tag = (displayTagName(node.tagName) || "div").toLowerCase();

  // Inline format state, sourced from the iframe's selection snapshot.
  const { editingProp, snapshot } = getEditSnapshot();
  const actions = getInlineActions(tag) || [];
  // ONE bar, one shape. The format group used to appear only during an "inline edit session", so
  // The toolbar rearranged itself under the author's cursor the moment they started typing. With a
  // Document-wide caret there is no session to be in or out of: the group is shown whenever the
  // Selected block can carry inline markup, and the buttons enable when there is a range to apply
  // Them to.
  //
  // A prop-bound block still suppresses it — it edits a single plain string (belt and braces:
  // Component tags have no $inlineActions, so `actions` is empty there anyway).
  const showFormat = !editingProp && actions.length > 0;
  const activeValues =
    showFormat && snapshot
      ? actions.filter((a) => snapshot.activeTags.includes(a.tag)).map((a) => a.tag)
      : [];
  // Formatting applies to a RANGE: disabled for a collapsed caret, and for a block selected without
  // One at all (from the layers panel, or by a structural edit moving the selection).
  const formatDisabled = snapshot?.collapsed ?? true;

  // Conversion targets for badge click
  const isComponent =
    displayTagName(node.tagName).includes("-") &&
    componentRegistry.some((/** @type {{ tagName: string }} */ c) => c.tagName === node.tagName);
  const children = childList(node);
  const isEmpty =
    !node.textContent &&
    (children.length === 0 ||
      (children.length === 1 && typeof children[0] === "object" && children[0]?.tagName === "br"));
  // Repeater ($prototype:"Array") pseudo-elements have no tagName — show the "Repeater → items" label
  // (not a bare "div") and don't offer tag-conversion targets, which are meaningless for a repeater.
  const isRepeater = node.$prototype === "Array";
  const convertTargets = !isComponent && !isRepeater ? getConvertTargets(tag, isEmpty) : [];
  const badgeInteractive = convertTargets.length > 0;

  // The verb cluster, sliced at the cap. `forPlacement` already dropped the records whose `when` is
  // False and sorted the rest by group; everything past the cap keeps its name and its chord in the
  // `⋮` menu rather than being silently unavailable.
  const registry = selectionCommandRegistry();
  const placed = registry.forPlacement("blockbar");
  const shown = placed.slice(0, BLOCKBAR_MAX_ITEMS);
  const overflow = placed.slice(BLOCKBAR_MAX_ITEMS);
  // The handle is chrome, not a verb, so it renders on every selection; only a node that actually
  // Sits at a child index can be dragged, and at the root it is a disabled affordance rather than a
  // Missing one (§8.6: ONE shape).
  const canDragSelection = structuralTarget(selection) !== null;

  litRender(
    html`
      <div
        class="block-action-bar"
        data-jx-region="overlay.menu:block-action-bar"
        role="toolbar"
        aria-label="Block actions"
        aria-orientation="horizontal"
        style=${styleMap({ left: `${pos.left}px`, top: `${pos.top}px` })}
        @mousedown=${onBarMousedown}
        @keydown=${onToolbarKeydown}
      >
        ${renderParentButton(registry)}

        <span
          class="bar-tag${badgeInteractive ? " bar-tag--interactive" : ""}"
          role=${badgeInteractive ? "button" : nothing}
          data-toolbar-item=${badgeInteractive ? "" : nothing}
          tabindex=${badgeInteractive ? "-1" : nothing}
          title=${badgeInteractive ? "Change element type" : nothing}
          @click=${
            badgeInteractive
              ? (e: MouseEvent) => onTagBadgeClick(e, convertTargets, selection)
              : nothing
          }
          >${isRepeater ? nodeLabel(node) : node.$id || displayTagName(node.tagName) || "div"}${
            editingProp ? ` · ${editingProp}` : ""
          }</span
        >

        <span
          class="bar-drag-handle${canDragSelection ? "" : " bar-drag-handle--disabled"}"
          title=${canDragSelection ? "Drag to reorder" : "Drag to reorder — the document root cannot move"}
          aria-disabled=${canDragSelection ? nothing : "true"}
          data-toolbar-item
          tabindex="-1"
          ${ref((handleEl) => {
            if (!handleEl || !canDragSelection) {
              return;
            }
            if (view.selDragCleanup) {
              view.selDragCleanup();
              view.selDragCleanup = null;
            }
            view.selDragCleanup = draggable({
              element: handleEl as HTMLElement,
              getInitialData: () => ({
                // Snapshot the selection: the live array is a Vue reactive proxy, which
                // Structured clone rejects when the src crosses postMessage (DataCloneError
                // Killed the whole handle drag), and a live reference would also mutate the
                // Retained srcData if the selection changed mid-drag.
                path: [...(primarySelection(activeTab.value?.session.selection) ?? [])],
                type: "tree-node",
              }),
              onGenerateDragPreview: ({
                nativeSetDragImage,
              }: {
                nativeSetDragImage: ((image: Element, x: number, y: number) => void) | null;
              }) => {
                // Suppress the native drag image; the cross-frame ghost is the drag affordance.
                disableNativeDragPreview({ nativeSetDragImage });
              },
            });
          })}
          >⠿</span
        >

        <sp-divider size="s" vertical></sp-divider>
        ${shown.map((command) => renderCommandButton(registry, command))}
        ${overflow.length > 0 ? renderOverflowButton(registry, overflow) : nothing}
        ${
          showFormat
            ? html`
                <sp-divider size="s" vertical></sp-divider>
                <sp-action-group
                  size="xs"
                  compact
                  emphasized
                  selects="multiple"
                  selected=${activeValues.length > 0 ? JSON.stringify(activeValues) : nothing}
                >
                  ${actions.map(
                    (action) => html`
                      <sp-action-button
                        size="xs"
                        value=${action.tag}
                        data-toolbar-item
                        tabindex="-1"
                        aria-label=${action.label}
                        title="${action.label}${action.shortcut ? ` (${action.shortcut})` : ""}"
                        ?disabled=${formatDisabled && action.command !== "link"}
                        @mousedown=${(e: MouseEvent) => e.preventDefault()}
                        @click=${(e: MouseEvent) => onFormatClick(e, action)}
                      >
                        ${action.icon ? (formatIconMap[action.icon] ?? nothing) : nothing}
                      </sp-action-button>
                    `,
                  )}
                </sp-action-group>
                <sp-action-button
                  size="xs"
                  quiet
                  data-toolbar-item
                  data-jx-region="overlay.menu:block-action-bar/insertData"
                  tabindex="-1"
                  aria-label="Insert data"
                  title="Insert data"
                  @mousedown=${(e: MouseEvent) => e.preventDefault()}
                  @click=${onMergeTagClick}
                >
                  <sp-icon-data slot="icon"></sp-icon-data>
                </sp-action-button>
              `
            : nothing
        }
      </div>
    `,
    view.blockActionBarEl,
  );

  const rendered = view.blockActionBarEl.querySelector<HTMLElement>(".block-action-bar");
  if (rendered) {
    applyRovingTabindex(rendered);
  }

  // Post-render side effects
  requestAnimationFrame(() => {
    const bar = view.blockActionBarEl?.firstElementChild as HTMLElement | null;
    if (!bar) {
      return;
    }
    clampBarToWindow(bar);
  });
}
