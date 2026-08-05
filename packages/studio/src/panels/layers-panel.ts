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
 */

import { html, render as litRender, nothing } from "lit-html";
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
import type { CommandRegistry } from "../commands/registry";
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
  const landmark = LANDMARK_NAMES[(node.tagName ?? "").toLowerCase()];
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
    applyTreeRovingTabindex(tree);
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

/**
 * The visible rows' paths, in display order — the list a shift-range is a range OF.
 *
 * Read from the DOM rather than from a captured array, because "visible" is exactly what the DOM
 * knows: a collapsed ancestor removes its descendants' rows, and the range must skip what the
 * author cannot see. `data-jx-path` is the serialized path the P5 plan put on every row for this.
 *
 * @param {HTMLElement} tree
 * @returns {JxPath[]}
 */
function visibleRowPaths(tree: HTMLElement): JxPath[] {
  const paths: JxPath[] = [];
  for (const row of treeRows(tree)) {
    const raw = row.dataset.jxPath;
    if (raw) {
      paths.push(JSON.parse(raw) as JxPath);
    }
  }
  return paths;
}

/**
 * Apply one row activation to the selection, honouring the two accumulate gestures (§6.5).
 *
 * - Plain: replace the selection with this path. **This is the only branch a keyboard walk or an
 *   unmodified click can reach, and it is byte-identical to what the Outline always did.**
 * - Ctrl/Cmd: toggle this path in or out, leaving the rest alone.
 * - Shift: the contiguous run of VISIBLE rows from the anchor to here.
 *
 * @param {HTMLElement | null} tree The tree element, needed only to resolve a shift-range.
 * @param {JxPath} path
 * @param {{ additive?: boolean; range?: boolean }} gesture
 */
export function applyRowSelection(
  tree: HTMLElement | null,
  path: JxPath,
  gesture: { additive?: boolean; range?: boolean } = {},
): void {
  const tab = activeTab.value;
  if (!tab) {
    return;
  }
  if (gesture.range && tree) {
    tab.session.selection = rangeSelection(
      visibleRowPaths(tree),
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

/** Select the node a row stands for, so the canvas and the inspector follow the keyboard. */
function selectRow(row: HTMLElement, gesture: { additive?: boolean; range?: boolean } = {}): void {
  const key = row.dataset.path;
  if (key === undefined) {
    return;
  }
  applyRowSelection(row.closest<HTMLElement>('[role="tree"]'), pathFromKey(key), gesture);
}

/**
 * The ARIA tree keyboard model.
 *
 * ↑ / ↓ walk the visible rows and take the selection with them — in an outline, "focus follows
 * selection" is what an author means by pressing Down. → expands a collapsed row and otherwise
 * descends into it; ← collapses an expanded one and otherwise climbs to its parent. Enter and F2
 * rename. Delete is deliberately absent: it is `selection.delete`'s chord, and the registry owns
 * it.
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
  const rows = treeRows(tree);
  const index = rows.indexOf(row);
  const key = row.dataset.path ?? "";
  const expanded = row.getAttribute("aria-expanded");

  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    const next = rows[index + (e.key === "ArrowDown" ? 1 : -1)];
    if (next) {
      // Shift+Arrow extends the range, the same gesture shift-click makes and through the same
      // Function. Without Shift the walk replaces the selection, exactly as it always has.
      selectRow(next, { range: e.shiftKey });
      focusRow(tree, next);
    }
  } else if (e.key === "ArrowRight") {
    e.preventDefault();
    if (expanded === "false") {
      collapsed.delete(key);
      rerender();
    } else if (expanded === "true") {
      focusRow(tree, rows[index + 1]);
    }
  } else if (e.key === "ArrowLeft") {
    e.preventDefault();
    if (expanded === "true") {
      collapsed.add(key);
      rerender();
    } else {
      const level = Number(row.getAttribute("aria-level") ?? "1");
      const parent = rows
        .slice(0, index)
        .toReversed()
        .find((candidate) => Number(candidate.getAttribute("aria-level") ?? "1") < level);
      if (parent) {
        selectRow(parent);
        focusRow(tree, parent);
      }
    }
  } else if (e.key === "Home" || e.key === "End") {
    e.preventDefault();
    const target = e.key === "Home" ? rows[0] : rows.at(-1);
    if (target) {
      selectRow(target);
      focusRow(tree, target);
    }
  } else if (e.key === "Enter" || e.key === "F2") {
    e.preventDefault();
    selectRow(row);
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
  const row = document.querySelector(`.layer-row[data-path="${key}"]`);
  if (!row) {
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
  input.placeholder = outlineLabel(nodeWithoutTitle) || (node.tagName ?? "div");
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
 * @param {{ navigateToComponent: (path: string) => void; rerender: () => void }} ctx
 * @returns {import("lit-html").TemplateResult}
 */
export function renderLayersTemplate(ctx: {
  navigateToComponent: (path: string) => void;
  rerender: () => void;
}) {
  const tab = activeTab.value;

  for (const fn of view.dndCleanups) {
    fn();
  }
  view.dndCleanups = [];

  const rows = flattenTree(tab!.doc.document);
  const collapsed = (view._layersCollapsed ||= new Set());
  const registry = selectionCommandRegistry();

  const layerRows: { key: string; tpl: TemplateResult }[] = [];
  // Rows arrive in pre-order, so "is any ancestor collapsed?" is a running depth comparison rather
  // Than a per-row walk back up the path. The old form did `path.slice(0, d)` + `pathKey(sub)` for
  // Every ancestor of every row — O(depth) array copies and string joins per row, on every render.
  let collapsedAtDepth: number | null = null;
  for (const { node, path, depth, nodeType } of rows) {
    if (collapsedAtDepth !== null && depth > collapsedAtDepth) {
      continue;
    }
    // Back at or above the collapsed ancestor's depth: it no longer covers this row.
    collapsedAtDepth = null;
    const rowKey = pathKey(path);
    if (collapsed.has(rowKey)) {
      collapsedAtDepth = depth;
    }

    if (tab?.doc.mode === "content" && path.length === 0) {
      continue;
    }

    if (nodeType === "text") {
      const textPreview = String(node).length > 40 ? `${String(node).slice(0, 40)}…` : String(node);
      layerRows.push({
        key: rowKey,
        tpl: html`
          <div
            class="layer-row"
            data-jx-path=${JSON.stringify(path)}
            style="padding-left:${indentWidth(depth) + 8}px; opacity: 0.6; font-style: italic;"
          >
            <span
              class="layer-tag"
              style="background: var(--spectrum-gray-500, #64748b); font-size: 0.65rem;"
              >text</span
            >
            <span class="layer-label">${textPreview}</span>
          </div>
        `,
      });
      continue;
    }

    // After text-node skip, node is guaranteed to be JxMutableNode (not a primitive)
    if (typeof node !== "object" || node === null) {
      continue;
    }
    const jxNode: JxMutableNode = node as JxMutableNode;

    if (path.length >= 2 && nodeType === "element") {
      const pPath = parentElementPath(path);
      const parentNode = pPath ? getNodeAtPath(tab!.doc.document, pPath) : null;
      if (parentNode && isInlineElement(jxNode, parentNode)) {
        continue;
      }
    }

    const key = rowKey;
    // Every member of the set draws selected; the PRIMARY additionally carries the roving tab stop,
    // So a batch has one keyboard position rather than six.
    const isSelected = isPathSelected(tab!.session.selection, path);
    const isPrimary = pathsEqual(path, primarySelection(tab!.session.selection));
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
      VOID_ELEMENTS.has((jxNode.tagName || "div").toLowerCase()) || nodeType === "map";

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
      badgeText = jxNode.tagName || "div";
      badgeTitle = undefined;
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
    const isRoot = tab?.doc.mode === "content" ? path.length === 0 : path.length < 2;

    layerRows.push({
      key,
      tpl: html`
        <div
          class=${classMap({ "layer-row": true, selected: isSelected })}
          role="treeitem"
          aria-level=${depth + 1}
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
            applyRowSelection(
              (e.currentTarget as HTMLElement).closest<HTMLElement>('[role="tree"]'),
              path,
              { additive: e.ctrlKey || e.metaKey, range: e.shiftKey },
            );
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
                    onEditComponent: ctx.navigateToComponent,
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
      `,
    });
  }

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
          layerRows.length === 0
            ? renderEmptyState({
                actions: [
                  {
                    label: "Add an element",
                    run: () => {
                      setActivityTab("blocks");
                    },
                  },
                ],
                message: "This page is empty. Everything you add to it is listed here, in order.",
              })
            : repeat(
                layerRows,
                (r) => r.key,
                (r) => r.tpl,
              )
        }
      </div>
    </div>
  `;
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
      host
        .querySelector(".layer-row.selected")
        ?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    },
  });
}
