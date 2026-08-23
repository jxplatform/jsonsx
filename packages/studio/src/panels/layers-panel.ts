/// <reference lib="dom" />
/**
 * Layers panel — the Outline: the document tree, with collapse, selection, drag-and-drop
 * reordering, and per-row actions that are RENDERINGS of the command registry.
 *
 * Three things this file is deliberate about.
 *
 * **Rows are `registry.forPlacement("outline/row")`.** Every row used to carry five hand-built
 * action buttons, always visible, on every row — five custom elements with shadow roots per visible
 * row. They now collapse to the selected row plus the hovered one, which is Gutenberg's rule and
 * the one plan §3.2 ⑩ codifies: the floating bar owns selection-scoped verbs, the inspector owns
 * values. The verbs, their names, their chords and their disabled reasons all come from the records
 * in `block-action-bar.ts` — the surface renders, it does not decide.
 *
 * The hovered row's cluster is mounted imperatively ({@link mountHoverActions}) rather than by a
 * `display: none` CSS rule, because a hidden `sp-action-button` is still an upgraded custom element
 * with a shadow root: CSS reveal would have kept the whole cost the collapse exists to remove. At
 * most two clusters exist at any moment — the selected row's, and the one under the pointer.
 *
 * **A row says something.** On a real page the tree was a wall of rows all reading "div": only
 * text-bearing nodes got a preview and containers got the tag they already wear as a coloured
 * badge. {@link outlineLabel} derives an identity instead — a title, an `$id`, a class, a landmark
 * name, the first text inside — and returns "" rather than repeat the badge.
 *
 * **It is a tree, and it is reachable.** `role="tree"` / `role="treeitem"` with a roving tabindex
 * and the arrow-key model ARIA specifies: ↑↓ walk the visible rows, → expands then descends, ←
 * collapses then ascends, Enter/F2 renames.
 *
 * **The rows are a MODEL, and the DOM holds a window onto it** ({@link OutlineRow}, `ui/
 * virtual-window.ts`). A 5 000-node page drew 5 000 rows, each carrying an `sp-icon` custom
 * element, on every repaint. It now draws the viewport plus three rows of overscan — and because
 * the DOM is no longer the whole list, nothing may ASK the DOM what the whole list is. Every
 * question about "which rows exist, and in what order" — the shift-range, the arrow walk, Home/End,
 * ←'s climb to the parent, the reveal that follows the selection — is answered from the array
 * {@link buildOutlineRows} produces. A shift-range read off the DOM would silently select the wrong
 * set the moment either end of it scrolled out of the window: a correctness bug wearing a
 * performance change's clothes.
 */

import { html, render as litRender, nothing } from "lit-html";
import { displayTagName, isTagExpression, tagNameCandidates } from "@jxsuite/schema/guards";
import { classMap } from "lit-html/directives/class-map.js";
import { ifDefined } from "lit-html/directives/if-defined.js";
import { ref } from "lit-html/directives/ref.js";
import { repeat } from "lit-html/directives/repeat.js";
import {
  VOID_ELEMENTS,
  childIndex,
  flattenTree,
  getNodeAtPath,
  nodeLabel,
  parentElementPath,
  pathKey,
  pathsEqual,
} from "../store";
import { activeTab } from "../workspace/workspace";
import {
  isSelected as isPathSelected,
  primarySelection,
  rangeSelection,
  selectionAnchor,
  toggleSelected,
} from "../tabs/selection";
import type { JxPath } from "../state";
import type { JxMutableNode } from "@jxsuite/schema/types";
import { mutateUpdateProperty, transactDoc } from "../tabs/transact";
import { view } from "../view";
import { setActivityTab } from "../shell";
import { renderEmptyState } from "./empty-state";
import { registerPanel } from "./panel-registry";
import { renderStylebookLayersTemplate } from "./stylebook-layers-panel";
import { selectStylebookTag, stylebookMeta } from "./stylebook-panel";
import { isInlineElement } from "../editor/inline-edit";
import { showContextMenu } from "../editor/context-menu";
import { panToElement } from "../canvas/canvas-utils";
import {
  commandIcon,
  commandTooltip,
  runCommand,
  selectionCommandRegistry,
  showCommandOverflow,
  withCommandTarget,
} from "./block-action-bar";
import {
  listWindow,
  measuredRowHeight,
  revealListRow,
  watchListWindow,
} from "../ui/virtual-window";
import type { CommandRegistry } from "../commands/registry";
import type { ListWindowWatch } from "../ui/virtual-window";
import type { TemplateResult } from "lit-html";

// ─── What a row says ─────────────────────────────────────────────────────────

/** How much of a text preview a 240px column can carry before it is just noise. */
const LABEL_MAX = 32;

/**
 * Tags whose human name is worth more than the tag itself.
 *
 * Deliberately short. `section`, `ul` and `table` are omitted: "Section" next to a `section` badge
 * is the repetition this function exists to remove.
 */
const LANDMARK_NAMES: Readonly<Record<string, string>> = {
  article: "Article",
  aside: "Sidebar",
  dialog: "Dialog",
  figure: "Figure",
  footer: "Footer",
  form: "Form",
  header: "Header",
  main: "Main",
  nav: "Navigation",
};

/** Trim and ellipsize to {@link LABEL_MAX}. */
function truncate(text: string): string {
  const clean = text.replaceAll(/\s+/gu, " ").trim();
  return clean.length > LABEL_MAX ? `${clean.slice(0, LABEL_MAX)}…` : clean;
}

/**
 * The first text anywhere under `node`, or "".
 *
 * Bounded at three levels and short-circuited on the first hit: a container's identity is usually
 * its heading or its first line, and walking a whole subtree per row would cost the render what the
 * five-buttons-per-row build already cost it.
 */
function firstText(node: JxMutableNode, depth = 0): string {
  if (typeof node.textContent === "string" && node.textContent.trim()) {
    return node.textContent.trim();
  }
  if (depth >= 3 || !Array.isArray(node.children)) {
    return "";
  }
  for (const child of node.children) {
    if (typeof child === "string" && child.trim()) {
      return child.trim();
    }
    if (child && typeof child === "object") {
      const found = firstText(child, depth + 1);
      if (found) {
        return found;
      }
    }
  }
  return "";
}

/** The node's first class name, when it has a plain (unbound) `class` attribute. */
function firstClass(node: JxMutableNode): string {
  const value = node.attributes?.class;
  return typeof value === "string" ? (value.trim().split(/\s+/u)[0] ?? "") : "";
}

/**
 * What an Outline row says about `node`, beyond the tag its badge already shows.
 *
 * Returns "" when the node has no identity of its own — the badge is then the whole answer, which
 * is honest, and quieter than a column of "div".
 *
 * This is NOT `nodeLabel()`. `nodeLabel` answers "name this node anywhere" and prefixes the tag (`p
 * — Hello`), which is right for the canvas overlay and the status bar and wrong here, where the tag
 * is already a coloured badge two pixels to the left. Those surfaces are unchanged.
 */
export function outlineLabel(node: JxMutableNode): string {
  if (node.$title) {
    return truncate(node.$title);
  }
  // Repeaters and slots have a real name of their own; nodeLabel already composes it.
  if (node.$prototype === "Array" || node.tagName === "slot") {
    return nodeLabel(node);
  }
  if (node.$id) {
    return `#${truncate(node.$id)}`;
  }
  if (typeof node.textContent === "string" && node.textContent.trim()) {
    return truncate(node.textContent);
  }
  const cls = firstClass(node);
  if (cls) {
    return `.${truncate(cls)}`;
  }
  const landmark = LANDMARK_NAMES[displayTagName(node.tagName).toLowerCase()];
  if (landmark) {
    return landmark;
  }
  const inner = firstText(node);
  if (inner) {
    return `“${truncate(inner)}”`;
  }
  const count = Array.isArray(node.children) ? node.children.length : 0;
  return count > 0 ? `${count} item${count === 1 ? "" : "s"}` : "";
}

// ─── Row actions, from the registry ──────────────────────────────────────────

/**
 * Verbs shown inline on a row before the rest fold into `⋮`. A 240px column is the budget.
 *
 * Four is what the Outline's own verbs cost: the moves (up, down, into previous, out of parent),
 * which are the reason a document tree has rows you can grab at all. Duplicate and Delete sort
 * after them (`3_structure`, `9_danger`) and so ride in the `⋮` menu with their names and chords
 * intact — they are also on the block action bar, in the row's context menu, and on ⌘D / Delete.
 * The four moves are on none of those.
 */
export const OUTLINE_ROW_MAX_ITEMS = 4;

/**
 * The row's action cluster.
 *
 * Wrapped in {@link withCommandTarget} so every record is evaluated against THIS ROW'S node rather
 * than the selection — `PLACEMENT_MATRIX["outline/row"]` says row actions act on the row's node,
 * and the hovered row is not the selected one.
 */
export function renderRowCommands(registry: CommandRegistry, path: JxPath) {
  return withCommandTarget(path, () => {
    const placed = registry.forPlacement("outline/row");
    const shown = placed.slice(0, OUTLINE_ROW_MAX_ITEMS);
    const overflow = placed.slice(OUTLINE_ROW_MAX_ITEMS);
    return html`${shown.map(
      (command) => html`<sp-action-button
        quiet
        size="xs"
        class=${command.destructive ? "layer-action layer-delete" : "layer-action"}
        data-command=${command.id}
        aria-label=${command.title}
        title=${commandTooltip(registry, command)}
        ?disabled=${registry.disabledReason(command.id) !== undefined}
        @click=${(e: MouseEvent) => {
          e.stopPropagation();
          (e.currentTarget as HTMLElement).blur();
          runCommand(registry, command.id, path);
        }}
        >${commandIcon(command)}</sp-action-button
      >`,
    )}
    ${
      overflow.length === 0
        ? nothing
        : html`<sp-action-button
            quiet
            size="xs"
            class="layer-action layer-overflow"
            aria-label="More actions"
            aria-haspopup="menu"
            title="More actions"
            @click=${(e: MouseEvent) => {
              e.stopPropagation();
              showCommandOverflow(e.currentTarget as HTMLElement, registry, overflow, path);
            }}
          >
            <sp-icon-more slot="icon"></sp-icon-more>
          </sp-action-button>`
    }`;
  });
}

// ─── The hovered row's cluster ───────────────────────────────────────────────

/**
 * The row whose cluster this module mounted on hover, so it can be taken down again.
 *
 * One at a time: the pointer is in one place. The SELECTED row's cluster is lit's (it is in the row
 * template), and is never touched from here.
 */
let _hoverActionsRow: HTMLElement | null = null;

/** The empty span a non-selected row keeps for {@link mountHoverActions} to render into. */
function actionSlot(row: HTMLElement): HTMLElement | null {
  return row.classList.contains("selected")
    ? null
    : row.querySelector<HTMLElement>(".layer-actions");
}

/** Take down the hover cluster, if one is up. */
export function clearHoverActions(): void {
  const slot = _hoverActionsRow ? actionSlot(_hoverActionsRow) : null;
  if (slot) {
    litRender(nothing, slot);
  }
  _hoverActionsRow = null;
}

/** Build `row`'s cluster into its slot, replacing whatever was there. */
function mountHoverActions(row: HTMLElement): void {
  const slot = actionSlot(row);
  const key = row.dataset.path;
  if (!slot || key === undefined) {
    return;
  }
  _hoverActionsRow = row;
  litRender(renderRowCommands(selectionCommandRegistry(), pathFromKey(key)), slot);
}

/**
 * Delegated `mouseover` (which bubbles; `mouseenter` does not): reveal the cluster on the row under
 * the pointer, and only that row.
 */
export function onTreeHover(e: Event): void {
  const row = (e.target as HTMLElement | null)?.closest<HTMLElement>('.layer-row[role="treeitem"]');
  if (!row || row === _hoverActionsRow) {
    return;
  }
  clearHoverActions();
  mountHoverActions(row);
}

/**
 * The two things that can only be decided once the rows are in the document.
 *
 * Deferred by a microtask on purpose. A `ref` on the tree element commits BEFORE the child part
 * holding the rows, so on a first render the callback sees an empty tree; and the template this
 * module returns is rendered by its caller, so a microtask is the first tick at which the new DOM
 * exists either way.
 *
 * - The roving tabindex needs to know which rows survived their collapsed ancestors.
 * - The hover cluster needs re-mounting: rows are keyed by path, so a document edit can leave the
 *   pointer on a DOM row that now stands for a different node, with different disabled reasons.
 */
export function afterTreeRender(tree: HTMLElement): void {
  const row = _hoverActionsRow;
  queueMicrotask(() => {
    adoptOutlineTree(tree);
    applyTreeRovingTabindex(tree);
    // A keyboard jump that had to scroll first left its target here, for the render it provoked.
    const wanted = _pendingFocusKey;
    if (wanted !== null) {
      _pendingFocusKey = null;
      focusRow(tree, rowElementFor(tree, wanted) ?? undefined);
    }
    if (!row || _hoverActionsRow !== row) {
      return;
    }
    if (row.isConnected && !row.classList.contains("selected")) {
      mountHoverActions(row);
    } else {
      _hoverActionsRow = null;
    }
  });
}

// ─── The tree, as a keyboard surface ─────────────────────────────────────────

/** Pixels of indent per level, and the depth past which the column stops paying for more. */
const INDENT_STEP = 16;
const INDENT_MAX_DEPTH = 6;

/**
 * The indent for `depth`, capped.
 *
 * Uncapped, a depth-12 row pushed 192px of empty space in front of a badge and a label inside a
 * 240px column, which is what made the panel scroll sideways instead of reading as a tree.
 */
export function indentWidth(depth: number): number {
  return Math.min(depth, INDENT_MAX_DEPTH) * INDENT_STEP;
}

/** The inverse of {@link pathKey}: numeric segments come back as numbers, as the doc stores them. */
function pathFromKey(key: string): JxPath {
  return key ? (key.split("/").map((s) => (/^\d+$/u.test(s) ? Number(s) : s)) as JxPath) : [];
}

// ─── The row model, and the window onto it ───────────────────────────────────

/**
 * One row the Outline WOULD draw, whether or not it is currently in the window.
 *
 * Built in a first pass that decides visibility (collapsed ancestors, inline elements, the content
 * root) and costs nothing but the decision; the templates are built in a second pass, for the
 * window only. Splitting the two is the whole saving — the expensive half is the `sp-icon` and
 * `sp-action-button` custom elements a row template mounts, not the walk that finds it.
 */
interface OutlineRow {
  /** `pathKey(path)` — the drag-and-drop and roving-tabindex key, and lit's `repeat` key. */
  key: string;
  path: JxPath;
  depth: number;
  /** Index of this row's parent in the model, or -1 at the top level. Feeds ← and `aria-setsize`. */
  parent: number;
  /**
   * Whether this row is a `role="treeitem"`.
   *
   * Text-node rows are drawn but are not tree items, and were never part of the keyboard walk or a
   * shift-range: `treeRows()` selected on the role, so moving those questions to the model has to
   * carry the same distinction rather than quietly start selecting text nodes.
   */
  item: boolean;
  node: JxMutableNode | string | number | boolean;
  nodeType: string;
  /** 1-based position among the row's `role="treeitem"` siblings — see {@link numberOutlineSets}. */
  posInSet: number;
  /** How many `role="treeitem"` siblings the row has, itself included. */
  setSize: number;
}

/**
 * The declared height of one row — `styles/panels.css` `.layer-row { block-size: 24px }`.
 *
 * A window needs a row height BEFORE the first row exists, so this constant is what the first paint
 * windows by; {@link outlineRowHeight} measures a real row afterwards and believes the measurement.
 * The stylesheet declares the height explicitly so the two cannot drift apart in silence.
 */
export const OUTLINE_ROW_HEIGHT = 24;

/** The rows the Outline last built, in display order. */
let _outlineRows: OutlineRow[] = [];
/** The `.layers-tree` element, kept between renders so a window can be computed for the next one. */
let _outlineList: HTMLElement | null = null;
/** The scroll watch that repaints the Outline as its scroller moves. */
let _outlineWatch: ListWindowWatch | null = null;
/** The Navigator repaint, captured per render so the scroll watch never holds a stale one. */
let _outlineRerender: (() => void) | null = null;

/** The height one row actually has; the declared constant until a row has been laid out. */
function outlineRowHeight(): number {
  return measuredRowHeight(_outlineList, ".layer-row", OUTLINE_ROW_HEIGHT);
}

/** The model index of the row keyed `key`, or -1. */
function outlineIndexOfKey(key: string | undefined): number {
  return key === undefined ? -1 : _outlineRows.findIndex((row) => row.key === key);
}

/** The model index of `path`, or -1. Used by the reveal, which is given a path and not a row. */
function outlineIndexOfPath(path: JxPath | null): number {
  return path === null ? -1 : _outlineRows.findIndex((row) => pathsEqual(row.path, path));
}

/**
 * The next `role="treeitem"` row from `index`, walking by `step`; -1 at the ends.
 *
 * The step is over the MODEL, so ↓ at the bottom of the window moves to the row below the window
 * rather than stopping dead — which is what a DOM-indexed walk did the moment the tree windowed.
 */
function outlineStep(index: number, step: 1 | -1): number {
  for (let i = index + step; i >= 0 && i < _outlineRows.length; i += step) {
    if (_outlineRows[i]!.item) {
      return i;
    }
  }
  return -1;
}

/**
 * The visible rows' paths, in display order — the list a shift-range is a range OF.
 *
 * Read from the MODEL, not from the DOM. It used to walk `data-jx-path` off the rendered rows,
 * which was exact while every row was rendered and became a silent lie the moment the tree
 * windowed: `rangeSelection` degenerates to `[target]` when the anchor is absent from the list it
 * is given (`tabs/selection.ts`), so shift-clicking with a scrolled-past anchor would have selected
 * one row and said nothing. "Visible" still means what it always meant — a collapsed ancestor
 * removes its descendants from the model too — it just no longer means "painted".
 */
function visibleRowPaths(): JxPath[] {
  const paths: JxPath[] = [];
  for (const row of _outlineRows) {
    if (row.item) {
      paths.push(row.path);
    }
  }
  return paths;
}

/**
 * Scroll the model row at `index` into the window, and say whether the scroller moved.
 *
 * The repaint is the scroll watch's, not this function's — see `revealListRow`.
 */
function revealOutlineRow(index: number): boolean {
  return revealListRow(_outlineList, index, outlineRowHeight());
}

/**
 * Repaint the Outline because its window changed.
 *
 * Deferred to a microtask so a scroll that arrives while lit is committing cannot re-enter the
 * render that is producing the rows.
 *
 * **Never during a drag.** `panels/dnd.ts` holds the drop targets it registered on the rendered
 * rows and shifts the rows either side of the pointer by a transform; re-rendering underneath it
 * would drop both. A wheel-scroll mid-drag therefore keeps the window the drag started with, and
 * the drop's own repaint restores it.
 *
 * **Never for a tree that is gone.** The stylebook draws a different panel into the same dock,
 * whose scroller is the one this watch is still listening to.
 */
function outlineWindowChanged(): void {
  if (_outlineList?.isConnected !== true || _outlineList.querySelector(".layer-row.dragging")) {
    return;
  }
  queueMicrotask(() => _outlineRerender?.());
}

/**
 * Adopt the rendered tree: remember it, and keep it watching its scroller.
 *
 * Called from {@link afterTreeRender}, one microtask after the rows are committed — the first moment
 * they exist AND the element can be resolved to whatever scrolls it (`#left-panel`, or the bottom
 * dock). The first paint of a session therefore draws every row, because nothing can be measured
 * before it; the watch's opening measurement is what asks for the second, windowed one.
 *
 * Idempotent by construction: `watchListWindow` hands back the same watch for the same element and
 * scroller, so calling this after every render costs a comparison.
 */
function adoptOutlineTree(tree: HTMLElement): void {
  _outlineList = tree;
  _outlineWatch = watchListWindow(_outlineWatch, tree, {
    count: () => _outlineRows.length,
    onChange: outlineWindowChanged,
    rowHeight: outlineRowHeight,
  });
}

/**
 * The node an Outline row stands for, read back off the row.
 *
 * Rows carry their `JxPath` verbatim, as JSON, in `data-jx-path` — node IDENTITY in the DOM. That
 * is a different thing from the neighbouring `data-path`, which is `pathKey`'s lossy `join("/")`
 * string and exists as the drag-and-drop and roving-tabindex Map key; `["children", "0"]` and
 * `["children", 0]` share a key and are different nodes, and a segment containing a slash has no
 * key at all.
 *
 * Everything that has to point at a node from outside the render — shift-range multi-select,
 * drag-reorder, canvas to Outline sync, a collaborator's cursor, a jump from Problems — needs the
 * unambiguous one.
 */
export function outlineRowPath(el: Element | null): JxPath | null {
  const row = el?.closest<HTMLElement>("[data-jx-path]");
  if (!row?.dataset.jxPath) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(row.dataset.jxPath);
    return Array.isArray(parsed) ? (parsed as JxPath) : null;
  } catch {
    return null;
  }
}

/** Every row currently on screen, in visual order. */
function treeRows(tree: HTMLElement): HTMLElement[] {
  return [...tree.querySelectorAll<HTMLElement>('.layer-row[role="treeitem"]')];
}

/**
 * Roving tabindex over the rows: the selected row is the tab stop, else the first.
 *
 * Applied after every render ({@link afterTreeRender}) rather than baked into each row's template,
 * because "is the selected row actually on screen" is only known once the collapsed ancestors have
 * been skipped — a selection inside a collapsed branch would otherwise leave the tree with no tab
 * stop at all.
 */
export function applyTreeRovingTabindex(tree: HTMLElement): void {
  const rows = treeRows(tree);
  if (rows.length === 0) {
    return;
  }
  // The PRIMARY row is the tab stop, not merely the first selected one: a multi-selection has one
  // Keyboard position, and it is the row the author last pointed at. `data-primary` is stamped by
  // The row template, so the two never have to re-derive the same answer.
  const primary = rows.find((row) => row.dataset.primary !== undefined);
  const selected = primary ?? rows.find((row) => row.getAttribute("aria-selected") === "true");
  const stop = selected ?? rows[0]!;
  for (const row of rows) {
    row.tabIndex = row === stop ? 0 : -1;
  }
}

/** Focus `row`, and make it the tree's single tab stop. */
function focusRow(tree: HTMLElement, row: HTMLElement | undefined): void {
  if (!row) {
    return;
  }
  for (const other of treeRows(tree)) {
    other.tabIndex = other === row ? 0 : -1;
  }
  row.focus();
}

/** The rendered row for a model key, or null when the window does not currently hold it. */
function rowElementFor(tree: HTMLElement, key: string): HTMLElement | null {
  return tree.querySelector<HTMLElement>(`.layer-row[data-path="${CSS.escape(key)}"]`);
}

/**
 * The row a repaint should hand the keyboard to, once it exists.
 *
 * A keyboard jump can name a row the window does not hold — End on a 5 000-row page, or ← climbing
 * to a parent far above the viewport. Scrolling to it is immediate; DRAWING it is the Navigator
 * scheduler's business, and `ctx.rerender` is explicitly "not a synchronous re-render". So the
 * request outlives the keystroke by exactly one render: {@link afterTreeRender} spends it, and
 * spends it once — a focus request that survived its own repaint is stale, and stealing the
 * keyboard later is worse than not having moved it.
 */
let _pendingFocusKey: string | null = null;

/** Move the keyboard to the model row at `index`, bringing it into the window if it is outside one. */
function focusModelRow(tree: HTMLElement, index: number): void {
  const row = _outlineRows[index];
  if (!row) {
    return;
  }
  const el = rowElementFor(tree, row.key);
  if (el) {
    focusRow(tree, el);
    return;
  }
  if (revealOutlineRow(index)) {
    _pendingFocusKey = row.key;
    _outlineRerender?.();
  }
}

/** Select the model row at `index`, so the canvas and the inspector follow the keyboard. */
function selectModelRow(index: number, gesture: { range?: boolean } = {}): void {
  const row = _outlineRows[index];
  if (row) {
    applyRowSelection(row.path, gesture);
  }
}

/**
 * Apply one row activation to the selection, honouring the two accumulate gestures (§6.5).
 *
 * - Plain: replace the selection with this path. **This is the only branch a keyboard walk or an
 *   unmodified click can reach, and it is byte-identical to what the Outline always did.**
 * - Ctrl/Cmd: toggle this path in or out, leaving the rest alone.
 * - Shift: the contiguous run of VISIBLE rows from the anchor to here.
 *
 * It took the tree element as its first parameter while a range was resolved by reading the rows
 * out of the DOM. It no longer is ({@link visibleRowPaths}), and the parameter went with the read —
 * a signature that still asked for the tree would suggest the answer depends on what is painted.
 *
 * @param {JxPath} path
 * @param {{ additive?: boolean; range?: boolean }} gesture
 */
export function applyRowSelection(
  path: JxPath,
  gesture: { additive?: boolean; range?: boolean } = {},
): void {
  const tab = activeTab.value;
  if (!tab) {
    return;
  }
  if (gesture.range) {
    tab.session.selection = rangeSelection(
      visibleRowPaths(),
      selectionAnchor(tab.session.selection),
      path,
    );
    return;
  }
  if (gesture.additive) {
    tab.session.selection = toggleSelected(tab.session.selection, path);
    return;
  }
  tab.session.selection = [path];
}

/**
 * The ARIA tree keyboard model.
 *
 * ↑ / ↓ walk the visible rows and take the selection with them — in an outline, "focus follows
 * selection" is what an author means by pressing Down. → expands a collapsed row and otherwise
 * descends into it; ← collapses an expanded one and otherwise climbs to its parent. Enter and F2
 * rename. Delete is deliberately absent: it is `selection.delete`'s chord, and the registry owns
 * it.
 *
 * Every one of those moves is an index into {@link outlineRows}, not into the rendered rows. The DOM
 * answer and the model answer agreed exactly while the tree drew everything; now the DOM holds a
 * window, and asking it for "the row after this one" would stop the walk at the window's edge and
 * make ← climb to whichever ancestor happened to be painted.
 */
export function onTreeKeydown(
  e: KeyboardEvent,
  collapsed: Set<string>,
  rerender: () => void,
): void {
  const tree = e.currentTarget as HTMLElement;
  const row = (e.target as HTMLElement).closest<HTMLElement>('.layer-row[role="treeitem"]');
  if (!row) {
    return;
  }
  const key = row.dataset.path ?? "";
  const index = outlineIndexOfKey(row.dataset.path);
  const expanded = row.getAttribute("aria-expanded");

  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    const next = outlineStep(index, e.key === "ArrowDown" ? 1 : -1);
    if (next >= 0) {
      // Shift+Arrow extends the range, the same gesture shift-click makes and through the same
      // Function. Without Shift the walk replaces the selection, exactly as it always has.
      selectModelRow(next, { range: e.shiftKey });
      focusModelRow(tree, next);
    }
  } else if (e.key === "ArrowRight") {
    e.preventDefault();
    if (expanded === "false") {
      collapsed.delete(key);
      rerender();
    } else if (expanded === "true") {
      focusModelRow(tree, outlineStep(index, 1));
    }
  } else if (e.key === "ArrowLeft") {
    e.preventDefault();
    if (expanded === "true") {
      collapsed.add(key);
      rerender();
    } else {
      // The model records each row's parent as it builds them, so the climb is exact rather than a
      // Backwards scan for a smaller `aria-level` — which could only ever see painted rows.
      const parent = _outlineRows[index]?.parent ?? -1;
      if (parent >= 0) {
        selectModelRow(parent);
        focusModelRow(tree, parent);
      }
    }
  } else if (e.key === "Home" || e.key === "End") {
    e.preventDefault();
    const target = e.key === "Home" ? outlineStep(-1, 1) : outlineStep(_outlineRows.length, -1);
    if (target >= 0) {
      selectModelRow(target);
      focusModelRow(tree, target);
    }
  } else if (e.key === "Enter" || e.key === "F2") {
    e.preventDefault();
    selectModelRow(index);
    if (row.dataset.path !== undefined) {
      startLayerTitleEdit(pathFromKey(row.dataset.path), rerender);
    }
  }
}

/**
 * Start inline title editing on a layer row.
 *
 * @param {JxPath} path
 * @param {() => void} rerender
 */
export function startLayerTitleEdit(path: JxPath, rerender: () => void) {
  const key = pathKey(path);
  /* Scoped to THIS panel's tree, and escaped, through the same helper every other row lookup in
     this file uses. The predecessor was a bare `document.querySelector` with the key interpolated
     raw, which is wrong twice over: a second pane — or the stylebook, which draws a layer tree of
     its own — puts more than one `.layer-row[data-path=…]` in the document, and the first match
     wins rather than the right one; and an unescaped key containing a quote or a bracket is not a
     selector the parser accepts, so a legitimately-named node throws instead of renaming.
     `_outlineList` is null before the first render, which is the same "row the window does not
     hold" case the reveal-and-repaint path below already handles. */
  const row = _outlineList ? rowElementFor(_outlineList, key) : null;
  if (!row) {
    // Renaming through a command (⌘↵, the palette, the block bar) can name a row the window does
    // Not hold. Scroll to it and repaint; the row exists on the next pass, and the caller's own
    // Chord is the one gesture in the app where re-pressing it is obvious.
    const index = outlineIndexOfPath(path);
    if (index >= 0 && revealOutlineRow(index)) {
      rerender();
    }
    return;
  }
  const label = row.querySelector(".layer-label") as HTMLElement | null;
  if (!label) {
    return;
  }

  const tab = activeTab.value;
  if (!tab) {
    return;
  }
  const node = getNodeAtPath(tab.doc.document, path);
  if (!node) {
    return;
  }

  label.style.display = "none";
  const input = document.createElement("input");
  input.className = "layer-title-input";
  input.value = node.$title || "";
  const { $title: _, ...nodeWithoutTitle } = node;
  input.placeholder = outlineLabel(nodeWithoutTitle) || displayTagName(node.tagName) || "div";
  label.after(input);
  input.focus();
  input.select();

  let committed = false;
  const cleanup = () => {
    input.remove();
    label.style.display = "";
  };
  const commit = () => {
    if (committed) {
      return;
    }
    committed = true;
    cleanup();
    const val = input.value.trim();
    transactDoc(tab, (t) => mutateUpdateProperty(t, path, "$title", val || undefined));
    rerender();
  };
  const cancel = () => {
    if (committed) {
      return;
    }
    committed = true;
    cleanup();
    rerender();
  };
  input.addEventListener("blur", commit);
  input.addEventListener("keydown", (e: KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      input.blur();
    }
    if (e.key === "Escape") {
      e.preventDefault();
      cancel();
    }
  });
}

/**
 * Pass one: the rows the Outline WOULD draw, in display order.
 *
 * Every line here is a decision about VISIBILITY — a collapsed ancestor, an inline element the
 * canvas edits as text rather than as a block, the root the content mode does not own — and no line
 * here builds a template. That split is the whole saving: the walk is O(nodes) and costs a few
 * comparisons per node, while the half it defers mounts an `sp-icon` per row and an action cluster
 * on the selected one. Only the rows in the window ever pay it.
 *
 * @param {JxMutableNode} doc @param {string} mode @param {Set<string>} collapsed
 */
function buildOutlineRows(doc: JxMutableNode, mode: string, collapsed: Set<string>): OutlineRow[] {
  const rows: OutlineRow[] = [];
  /** Indices of the rows still open above the row being decided; the last of them is its parent. */
  const ancestors: number[] = [];
  // Rows arrive in pre-order, so "is any ancestor collapsed?" is a running depth comparison rather
  // Than a per-row walk back up the path. The old form did `path.slice(0, d)` + `pathKey(sub)` for
  // Every ancestor of every row — O(depth) array copies and string joins per row, on every render.
  let collapsedAtDepth: number | null = null;
  for (const { node, path, depth, nodeType } of flattenTree(doc)) {
    if (collapsedAtDepth !== null && depth > collapsedAtDepth) {
      continue;
    }
    // Back at or above the collapsed ancestor's depth: it no longer covers this row.
    collapsedAtDepth = null;
    const key = pathKey(path);
    if (collapsed.has(key)) {
      collapsedAtDepth = depth;
    }

    if (mode === "content" && path.length === 0) {
      continue;
    }

    const isText = nodeType === "text";
    if (!isText) {
      // After the text-node branch, a row's node is a JxMutableNode or it is not a row at all.
      if (typeof node !== "object" || node === null) {
        continue;
      }
      if (path.length >= 2 && nodeType === "element") {
        const parentPath = parentElementPath(path);
        const parentNode = parentPath ? getNodeAtPath(doc, parentPath) : null;
        if (parentNode && isInlineElement(node, parentNode)) {
          continue;
        }
      }
    }

    while (ancestors.length > 0 && rows[ancestors.at(-1)!]!.depth >= depth) {
      ancestors.pop();
    }
    rows.push({
      depth,
      item: !isText,
      key,
      node,
      nodeType,
      parent: ancestors.at(-1) ?? -1,
      path,
      posInSet: 0,
      setSize: 0,
    });
    ancestors.push(rows.length - 1);
  }
  return numberOutlineSets(rows);
}

/**
 * Stamp each row's position among its siblings — the two attributes a WINDOWED tree cannot omit.
 *
 * A tree that draws every row lets the assistive technology count them itself. A windowed one hands
 * it eleven rows out of five thousand, and without `aria-posinset`/`aria-setsize` it will read
 * "item 3 of 11" for a document with hundreds of sections: not a missing nicety, a false statement.
 * Only `role="treeitem"` rows are counted — a text-node row is drawn, but it is not in the set.
 */
function numberOutlineSets(rows: OutlineRow[]): OutlineRow[] {
  const totals = new Map<number, number>();
  for (const row of rows) {
    if (row.item) {
      totals.set(row.parent, (totals.get(row.parent) ?? 0) + 1);
    }
  }
  const seen = new Map<number, number>();
  for (const row of rows) {
    if (!row.item) {
      continue;
    }
    const position = (seen.get(row.parent) ?? 0) + 1;
    seen.set(row.parent, position);
    row.posInSet = position;
    row.setSize = totals.get(row.parent) ?? position;
  }
  return rows;
}

/** A text node's row: drawn, and deliberately not a tree item — there is nothing to do to it. */
function textRowTemplate(row: OutlineRow): TemplateResult {
  const text = String(row.node);
  const preview = text.length > 40 ? `${text.slice(0, 40)}…` : text;
  return html`
    <div
      class="layer-row"
      data-jx-path=${JSON.stringify(row.path)}
      style="padding-left:${indentWidth(row.depth) + 8}px; opacity: 0.6; font-style: italic;"
    >
      <span
        class="layer-tag"
        style="background: var(--spectrum-gray-500, #64748b); font-size: 0.65rem;"
        >text</span
      >
      <span class="layer-label">${preview}</span>
    </div>
  `;
}

/**
 * Pass two: one row, drawn.
 *
 * Called for the rows in the window and for no others, which is why it takes the document facts it
 * needs (`selection`, `mode`) as arguments instead of reading `activeTab` for each row.
 */
function outlineRowTemplate(
  row: OutlineRow,
  doc: { selection: JxPath[]; mode: string },
  collapsed: Set<string>,
  registry: CommandRegistry,
  ctx: { rerender: () => void },
): TemplateResult {
  if (!row.item) {
    return textRowTemplate(row);
  }
  const { depth, key, nodeType, path } = row;
  const jxNode = row.node as JxMutableNode;

  // Every member of the set draws selected; the PRIMARY additionally carries the roving tab stop,
  // So a batch has one keyboard position rather than six.
  const isSelected = isPathSelected(doc.selection, path);
  const isPrimary = pathsEqual(path, primarySelection(doc.selection));
  const hasChildren = Array.isArray(jxNode.children) && jxNode.children.length > 0;
  const hasMapChildren =
    jxNode.children &&
    typeof jxNode.children === "object" &&
    (jxNode.children as unknown as Record<string, unknown>).$prototype === "Array";
  const hasCases =
    jxNode.$switch &&
    jxNode.cases &&
    typeof jxNode.cases === "object" &&
    Object.keys(jxNode.cases).length > 0;
  const isExpandable =
    hasChildren || hasMapChildren || hasCases || (nodeType === "map" && jxNode.map);
  // Array nodes can't accept dropped children (their content is the single map template), so they
  // Block the make-child drop instruction like void elements do.
  const isVoidEl =
    VOID_ELEMENTS.has((displayTagName(jxNode.tagName) || "div").toLowerCase()) ||
    nodeType === "map";

  /** @type {string} */
  let badgeClass;
  /** @type {string | number} */
  let badgeText;
  /** @type {string | undefined} */
  let badgeTitle;
  if (nodeType === "map") {
    badgeClass = "layer-tag map-tag";
    badgeText = "↻";
    badgeTitle = "Repeating list — one copy per item";
  } else if (nodeType === "case" || nodeType === "case-ref") {
    badgeClass = "layer-tag case-tag";
    badgeText = path.at(-1);
    badgeTitle = `Condition case: ${path.at(-1)}`;
  } else if (jxNode.$switch) {
    badgeClass = "layer-tag switch-tag";
    badgeText = "⇄";
    badgeTitle = "Condition";
  } else if (jxNode.tagName === "slot") {
    const slotName = jxNode.attributes?.name;
    badgeClass = "layer-tag slot-tag";
    badgeText = "▣";
    badgeTitle =
      typeof slotName === "string" && slotName.trim()
        ? `Slot "${slotName.trim()}"`
        : "Default slot";
  } else {
    badgeClass = "layer-tag";
    /* The ROW BADGE, which is the one place the tag is shown as itself rather than folded into a
       label — so it is the one that rendered `[object Object]` for a chosen tag after the other
       reads were fixed. `outlineLabel` never returns a tag (it prefers a title, an id, text, a
       class, a landmark), which is why fixing `nodeLabel` did not reach here. */
    badgeText = displayTagName(jxNode.tagName) || "div";
    badgeTitle = isTagExpression(jxNode.tagName)
      ? `Tag chosen when the element is created: ${tagNameCandidates(jxNode.tagName).join(" or ")}`
      : undefined;
  }

  /** @type {string} */
  let labelText;
  /** @type {boolean} */
  let labelItalic;
  if (nodeType === "case-ref") {
    labelText = jxNode.$ref || "external";
    labelItalic = true;
  } else {
    labelText = outlineLabel(jxNode);
    labelItalic = false;
  }

  // Array (repeater) nodes are first-class structural nodes — movable/draggable/deletable like
  // Elements. Both sit at a numeric child index; templates (path tail "map") and case nodes do
  // Not, so they stay selectable/editable but not structurally manipulable.
  const isStructural =
    (nodeType === "element" || nodeType === "map") && typeof childIndex(path) === "number";
  const isRoot = doc.mode === "content" ? path.length === 0 : path.length < 2;

  return html`
    <div
      class=${classMap({ "layer-row": true, selected: isSelected })}
      role="treeitem"
      aria-level=${depth + 1}
      aria-posinset=${row.posInSet}
      aria-setsize=${row.setSize}
      aria-selected=${isSelected ? "true" : "false"}
      aria-expanded=${isExpandable ? (collapsed.has(key) ? "false" : "true") : nothing}
      tabindex=${isPrimary ? "0" : "-1"}
      data-primary=${isPrimary ? "" : nothing}
      data-jx-path=${JSON.stringify(path)}
      data-path=${key}
      data-dnd-row=${isStructural ? key : nothing}
      data-dnd-depth=${isStructural ? depth : nothing}
      data-dnd-void=${isStructural && isVoidEl ? "" : nothing}
      data-dnd-expanded=${isStructural && isExpandable && !collapsed.has(key) ? "" : nothing}
      @click=${(e: MouseEvent) => {
        applyRowSelection(path, { additive: e.ctrlKey || e.metaKey, range: e.shiftKey });
        panToElement(path);
      }}
      @dblclick=${
        isStructural
          ? (e: MouseEvent) => {
              e.stopPropagation();
              startLayerTitleEdit(path, ctx.rerender);
            }
          : nothing
      }
      @contextmenu=${
        isStructural
          ? (e: MouseEvent) =>
              showContextMenu(e, path, {
                rerender: ctx.rerender,
              })
          : nothing
      }
    >
      <span class="layer-indent" style="width:${indentWidth(depth)}px"></span>
      <span class="layer-toggle"
        >${
          isExpandable
            ? html`
                ${
                  collapsed.has(key)
                    ? html`<sp-icon-chevron-right></sp-icon-chevron-right>`
                    : html`<sp-icon-chevron-down></sp-icon-chevron-down>`
                }
              `
            : nothing
        }</span
      >
      <span class=${badgeClass} title=${ifDefined(badgeTitle ?? undefined)}>${badgeText}</span>
      <span class="layer-label" style=${labelItalic ? "font-style:italic" : nothing}
        >${labelText}</span
      >
      ${
        isStructural && !isRoot
          ? html`<span class="layer-drag-handle" title="Drag to reorder">⠿</span>`
          : nothing
      }
      ${
        // The selected row's cluster is declared here so it survives every re-render; every
        // Other structural row keeps an EMPTY slot, which the pointer fills (mountHoverActions)
        // And empties again. The two branches are different templates, so lit swaps the DOM
        // Between them and a hover cluster can never outlive the row becoming selected.
        isStructural && !isRoot
          ? isSelected
            ? html`<span class="layer-actions">${renderRowCommands(registry, path)}</span>`
            : html`<span class="layer-actions"></span>`
          : nothing
      }
    </div>
  `;
}

/**
 * @param {{ navigateToComponent: (path: string) => void; rerender: () => void }} ctx
 * @returns {import("lit-html").TemplateResult}
 */
export function renderLayersTemplate(ctx: {
  navigateToComponent: (path: string) => void;
  rerender: () => void;
}) {
  const tab = activeTab.value;
  // The scroll watch outlives this call and must never repaint through a closure from an earlier
  // One — the Navigator's scheduler is the only thing that knows how to draw the Outline.
  _outlineRerender = ctx.rerender;

  for (const fn of view.dndCleanups) {
    fn();
  }
  view.dndCleanups = [];

  view._layersCollapsed ||= new Set();
  const collapsed = view._layersCollapsed;
  const registry = selectionCommandRegistry();

  _outlineRows = buildOutlineRows(tab!.doc.document, tab?.doc.mode ?? "", collapsed);
  // The window is computed from the PREVIOUS render's tree element, because that is the only one
  // That exists while this template is being built. On the first paint of a session there is none
  // And `listWindow` answers "all of them" — which is exactly what the Outline did before it
  // Windowed, and what the panel's `afterRender` then measures in order to ask for a second pass.
  const range = listWindow(_outlineList, {
    count: _outlineRows.length,
    rowHeight: outlineRowHeight(),
  });
  const doc = { mode: tab?.doc.mode ?? "", selection: tab!.session.selection };
  const layerRows = _outlineRows
    .slice(range.start, range.end)
    .map((row) => ({ key: row.key, tpl: outlineRowTemplate(row, doc, collapsed, registry, ctx) }));

  return html`
    <div class="layers-container" style="position:relative">
      <div
        class="layers-tree"
        role="tree"
        aria-label="Document outline"
        ${ref((el) => {
          if (el) {
            afterTreeRender(el as HTMLElement);
          }
        })}
        @keydown=${(e: KeyboardEvent) => onTreeKeydown(e, collapsed, ctx.rerender)}
        @mouseover=${onTreeHover}
        @mouseleave=${clearHoverActions}
        @click=${(e: MouseEvent) => {
          const toggle = (e.target as HTMLElement).closest(".layer-toggle");
          if (!toggle) {
            return;
          }
          e.stopPropagation();
          const row = toggle.closest(".layer-row");
          if (!row) {
            return;
          }
          const key = (row as HTMLElement).dataset.path;
          if (!key) {
            return;
          }
          if (collapsed.has(key)) {
            collapsed.delete(key);
          } else {
            collapsed.add(key);
          }
          ctx.rerender();
        }}
      >
        ${
          _outlineRows.length === 0
            ? renderEmptyState({
                actions: [
                  {
                    label: "Add an element",
                    run: () => {
                      // `"insert"`, not `"blocks"`. The panel was renamed in P3.1 and this call
                      // Kept the old id for three phases, so the one action an empty page offers
                      // Landed the Navigator on "No Navigator panel is registered as blocks".
                      // `setActivityTab` takes a `NavigatorPanelId` now, so this cannot recur.
                      setActivityTab("insert");
                    },
                  },
                ],
                message: "This page is empty. Everything you add to it is listed here, in order.",
              })
            : html`
                <!-- The rows the window left above and below, as the height they would have
                     occupied: the scrollbar stays the length of the whole document, and
                     aria-hidden keeps two empty spacers out of a tree that owns treeitems. -->
                <div style="height:${range.padTop}px" aria-hidden="true"></div>
                ${repeat(
                  layerRows,
                  (r) => r.key,
                  (r) => r.tpl,
                )}
                <div style="height:${range.padBottom}px" aria-hidden="true"></div>
              `
        }
      </div>
    </div>
  `;
}

/**
 * Keep the selected row on screen after a repaint.
 *
 * Two cases now, where there used to be one. If the row is drawn, it scrolls itself into view, as
 * it always has. If it is NOT — the canvas selected a node three thousand rows down, a jump from
 * Problems, a collaborator's edit — then the row the author is meant to see is precisely the one
 * with no element to call `scrollIntoView` on, and the reveal has to be arithmetic: scroll to where
 * the model says the row is, and let the scroll watch draw it. Silently doing nothing would be the
 * windowing bug that looks like a selection bug.
 */
function revealSelectedRow(host: HTMLElement): void {
  const drawn = host.querySelector(".layer-row.selected");
  if (drawn) {
    drawn.scrollIntoView({ behavior: "smooth", block: "nearest" });
    return;
  }
  revealOutlineRow(outlineIndexOfPath(primarySelection(activeTab.value?.session.selection)));
}

/**
 * Contribute the Outline panel.
 *
 * `level: "document"` — it writes the open document's tree (reorder, rename, delete, duplicate).
 * "Outline" rather than "Layers" is §3.2 ③'s name for it; the id stays `layers` because that is
 * what `view.setActivity` and 26 screenshot steps address it by, and an id is not a label.
 */
export function registerLayersPanel(): void {
  registerPanel({
    id: "layers",
    title: "Outline",
    level: "document",
    dock: "navigator",
    icon: "sp-icon-layers",
    requiresDocument: "Open a page to see the elements it is built from.",
    render: (ctx) =>
      ctx.deps.getCanvasMode() === "stylebook"
        ? renderStylebookLayersTemplate({
            selectStylebookTag,
            stylebookMeta,
          } as Parameters<typeof renderStylebookLayersTemplate>[0])
        : renderLayersTemplate({
            navigateToComponent: ctx.deps.navigateToComponent,
            rerender: ctx.rerender,
          }),
    afterRender: (ctx, host) => {
      if (ctx.deps.getCanvasMode() !== "stylebook") {
        ctx.deps.registerLayersDnD();
      }
      revealSelectedRow(host);
    },
  });
}
