/// <reference lib="dom" />
/**
 * Layers panel — document tree view showing element hierarchy with collapse, selection, move
 * actions, and drag-and-drop reordering.
 */

import { html, nothing } from "lit-html";
import { classMap } from "lit-html/directives/class-map.js";
import { ifDefined } from "lit-html/directives/if-defined.js";
import { repeat } from "lit-html/directives/repeat.js";
import {
  VOID_ELEMENTS,
  childIndex,
  childList,
  flattenTree,
  getNodeAtPath,
  nodeLabel,
  parentElementPath,
  pathKey,
  pathsEqual,
} from "../store";
import { activeTab } from "../workspace/workspace";
import type { JxPath } from "../state";
import type { JxMutableNode } from "@jxsuite/schema/types";
import {
  mutateMoveNode,
  mutateRemoveNode,
  mutateUpdateProperty,
  transactDoc,
} from "../tabs/transact";
import { view } from "../view";
import { renderEmptyState } from "./empty-state";
import { isInlineElement } from "../editor/inline-edit";
import { showContextMenu } from "../editor/context-menu";
import { panToElement } from "../canvas/canvas-utils";
import type { TemplateResult } from "lit-html";

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
  input.placeholder = nodeLabel(nodeWithoutTitle);
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
            style="padding-left:${depth * 16 + 8}px; opacity: 0.6; font-style: italic;"
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
    const isSelected = pathsEqual(path, tab!.session.selection);
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
      labelText = nodeLabel(jxNode);
      labelItalic = false;
    }

    // Array (repeater) nodes are first-class structural nodes — movable/draggable/deletable like
    // Elements. Both sit at a numeric child index; templates (path tail "map") and case nodes do
    // Not, so they stay selectable/editable but not structurally manipulable.
    const isStructural =
      (nodeType === "element" || nodeType === "map") && typeof childIndex(path) === "number";
    const isRoot = tab?.doc.mode === "content" ? path.length === 0 : path.length < 2;
    const idx = isStructural ? (childIndex(path) as number) : 0;
    const parentPath = isStructural && !isRoot ? (parentElementPath(path) as JxPath) : null;
    const parentNode = parentPath ? getNodeAtPath(tab!.doc.document, parentPath) : null;
    const siblingCount = childList(parentNode).length;
    const canMoveUp = isStructural && !isRoot && idx > 0;
    const canMoveDown = isStructural && !isRoot && idx < siblingCount - 1;
    const prevSibling = canMoveUp && parentNode ? childList(parentNode)[idx - 1] : null;
    const prevIsContainer = (() => {
      if (!prevSibling || typeof prevSibling !== "object") {
        return false;
      }
      if (VOID_ELEMENTS.has((prevSibling.tagName || "div").toLowerCase())) {
        return false;
      }
      const ch = prevSibling.children;
      if (!ch) {
        return false;
      }
      if (
        typeof ch === "object" &&
        (ch as unknown as Record<string, unknown>).$prototype === "Array"
      ) {
        return true;
      }
      if (!Array.isArray(ch)) {
        return false;
      }
      if (ch.length === 0) {
        return true;
      }
      return ch.some(
        (c) => typeof c === "object" && c !== null && !isInlineElement(c, prevSibling),
      );
    })();
    const canMoveIn = isStructural && !isRoot && prevIsContainer;
    const grandparentPath =
      isStructural && parentPath && parentPath.length >= 2
        ? (parentElementPath(parentPath) as JxPath)
        : null;
    const canMoveOut = isStructural && !isRoot && Boolean(grandparentPath);

    layerRows.push({
      key,
      tpl: html`
        <div
          class=${classMap({ "layer-row": true, selected: isSelected })}
          data-path=${key}
          data-dnd-row=${isStructural ? key : nothing}
          data-dnd-depth=${isStructural ? depth : nothing}
          data-dnd-void=${isStructural && isVoidEl ? "" : nothing}
          data-dnd-expanded=${isStructural && isExpandable && !collapsed.has(key) ? "" : nothing}
          @click=${() => {
            activeTab.value!.session.selection = path;
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
          <span class="layer-indent" style="width:${depth * 16}px"></span>
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
            isStructural && !isRoot && isSelected
              ? html`
                  <span class="layer-actions">
                    ${
                      canMoveUp
                        ? html`<sp-action-button
                            quiet
                            size="xs"
                            title="Move up"
                            @click=${(e: MouseEvent) => {
                              e.stopPropagation();
                              (e.currentTarget as HTMLElement).blur();
                              const pp = parentPath as JxPath;
                              transactDoc(activeTab.value!, (t) =>
                                mutateMoveNode(t, path, pp, idx - 1),
                              );
                            }}
                          >
                            <sp-icon-arrow-up slot="icon"></sp-icon-arrow-up>
                          </sp-action-button>`
                        : nothing
                    }
                    ${
                      canMoveDown
                        ? html`<sp-action-button
                            quiet
                            size="xs"
                            title="Move down"
                            @click=${(e: MouseEvent) => {
                              e.stopPropagation();
                              (e.currentTarget as HTMLElement).blur();
                              const pp = parentPath as JxPath;
                              transactDoc(activeTab.value!, (t) =>
                                mutateMoveNode(t, path, pp, idx + 2),
                              );
                            }}
                          >
                            <sp-icon-arrow-down slot="icon"></sp-icon-arrow-down>
                          </sp-action-button>`
                        : nothing
                    }
                    ${
                      canMoveIn
                        ? html`<sp-action-button
                            quiet
                            size="xs"
                            title="Move into previous sibling"
                            @click=${(e: MouseEvent) => {
                              e.stopPropagation();
                              (e.currentTarget as HTMLElement).blur();
                              const pp = parentPath as JxPath;
                              const prevPath = [...pp, "children", idx - 1];
                              const prev = getNodeAtPath(activeTab.value!.doc.document, prevPath);
                              const len = childList(prev).length;
                              transactDoc(activeTab.value!, (t) =>
                                mutateMoveNode(t, path, prevPath, len),
                              );
                            }}
                          >
                            <sp-icon-arrow-right slot="icon"></sp-icon-arrow-right>
                          </sp-action-button>`
                        : nothing
                    }
                    ${
                      canMoveOut
                        ? html`<sp-action-button
                            quiet
                            size="xs"
                            title="Move out of parent"
                            @click=${(e: MouseEvent) => {
                              e.stopPropagation();
                              (e.currentTarget as HTMLElement).blur();
                              const gp = grandparentPath as JxPath;
                              const parentIdx = childIndex(parentPath!) as number;
                              transactDoc(activeTab.value!, (t) =>
                                mutateMoveNode(t, path, gp, parentIdx + 1),
                              );
                            }}
                          >
                            <sp-icon-arrow-left slot="icon"></sp-icon-arrow-left>
                          </sp-action-button>`
                        : nothing
                    }
                    <sp-action-button
                      quiet
                      size="xs"
                      class="layer-delete"
                      title="Delete"
                      @click=${(e: MouseEvent) => {
                        e.stopPropagation();
                        transactDoc(activeTab.value!, (t) => mutateRemoveNode(t, path));
                      }}
                    >
                      <sp-icon-close slot="icon"></sp-icon-close>
                    </sp-action-button>
                  </span>
                `
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
                      view.leftTab = "blocks";
                      ctx.rerender();
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
