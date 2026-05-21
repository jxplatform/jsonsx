/**
 * Layers panel — document tree view showing element hierarchy with collapse, selection, move
 * actions, and drag-and-drop reordering.
 */

import { html, nothing } from "lit-html";
import {
  flattenTree,
  getNodeAtPath,
  pathKey,
  pathsEqual,
  parentElementPath,
  childIndex,
  nodeLabel,
  VOID_ELEMENTS,
} from "../store.js";
import { activeTab } from "../workspace/workspace.js";
import { transactDoc, mutateMoveNode, mutateRemoveNode } from "../tabs/transact.js";
import { view } from "../view.js";
import { isInlineElement } from "../editor/inline-edit.js";
import { showContextMenu } from "../editor/context-menu.js";

/**
 * @param {{ navigateToComponent: any; rerender: () => void }} ctx
 * @returns {import("lit-html").TemplateResult}
 */
export function renderLayersTemplate(ctx) {
  const tab = activeTab.value;

  for (const fn of view.dndCleanups) fn();
  view.dndCleanups = [];

  const rows = flattenTree(tab?.doc.document);
  const collapsed = view._layersCollapsed || (view._layersCollapsed = new Set());

  /** @type {any[]} */
  const layerRows = [];
  for (const { node, path, depth, nodeType } of rows) {
    let hidden = false;
    for (let d = 1; d <= path.length; d++) {
      const sub = path.slice(0, d);
      if (d < path.length && collapsed.has(pathKey(sub))) {
        hidden = true;
        break;
      }
    }
    if (hidden) continue;

    if (tab?.doc.mode === "content" && path.length === 0) continue;

    if (nodeType === "text") {
      const textPreview = String(node).length > 40 ? String(node).slice(0, 40) + "…" : String(node);
      layerRows.push(html`
        <div
          class="layer-row"
          style="padding-left:${depth * 16 + 8}px; opacity: 0.6; font-style: italic;"
        >
          <span class="layer-tag" style="background: #64748b; font-size: 0.65rem;">text</span>
          <span class="layer-label">${textPreview}</span>
        </div>
      `);
      continue;
    }

    if (path.length >= 2 && nodeType === "element") {
      const pPath = parentElementPath(path);
      const parentNode = pPath ? getNodeAtPath(tab?.doc.document, pPath) : null;
      if (parentNode && isInlineElement(node, parentNode)) continue;
    }

    const key = pathKey(path);
    const isSelected = pathsEqual(path, tab?.session.selection);
    const hasChildren = Array.isArray(node.children) && node.children.length > 0;
    const hasMapChildren =
      node.children && typeof node.children === "object" && node.children.$prototype === "Array";
    const hasCases =
      node.$switch &&
      node.cases &&
      typeof node.cases === "object" &&
      Object.keys(node.cases).length > 0;
    const isExpandable =
      hasChildren || hasMapChildren || hasCases || (nodeType === "map" && node.map);
    const isVoidEl = VOID_ELEMENTS.has((node.tagName || "div").toLowerCase());

    /** @type {any} */
    let badgeClass, badgeText, badgeTitle;
    if (nodeType === "map") {
      badgeClass = "layer-tag map-tag";
      badgeText = "↻";
      badgeTitle = "Repeater (mapped array)";
    } else if (nodeType === "case" || nodeType === "case-ref") {
      badgeClass = "layer-tag case-tag";
      badgeText = path[path.length - 1];
      badgeTitle = `$switch case: ${path[path.length - 1]}`;
    } else if (node.$switch) {
      badgeClass = "layer-tag switch-tag";
      badgeText = "⇄";
      badgeTitle = "$switch";
    } else {
      badgeClass = "layer-tag";
      badgeText = node.tagName || "div";
      badgeTitle = undefined;
    }

    /** @type {any} */
    let labelText, labelItalic;
    if (nodeType === "case-ref") {
      labelText = node.$ref || "external";
      labelItalic = true;
    } else {
      labelText = nodeLabel(node);
      labelItalic = false;
    }

    const isElement = nodeType === "element";
    const isRoot = tab?.doc.mode === "content" ? path.length === 0 : path.length < 2;
    const idx = isElement ? /** @type {number} */ (childIndex(path)) : 0;
    const parentPath = isElement && !isRoot ? /** @type {any} */ (parentElementPath(path)) : null;
    const parentNode = parentPath ? getNodeAtPath(tab?.doc.document, parentPath) : null;
    const siblingCount = parentNode?.children?.length || 0;
    const canMoveUp = isElement && !isRoot && idx > 0;
    const canMoveDown = isElement && !isRoot && idx < siblingCount - 1;
    const prevSibling = canMoveUp && parentNode ? parentNode.children[idx - 1] : null;
    const canMoveIn =
      isElement &&
      !isRoot &&
      prevSibling &&
      !VOID_ELEMENTS.has((prevSibling.tagName || "div").toLowerCase());
    const grandparentPath =
      isElement && parentPath && parentPath.length >= 2
        ? /** @type {any} */ (parentElementPath(parentPath))
        : null;
    const canMoveOut = isElement && !isRoot && !!grandparentPath;

    layerRows.push(html`
      <div
        class="layer-row${isSelected ? " selected" : ""}"
        data-path=${key}
        data-dnd-row=${isElement ? key : nothing}
        data-dnd-depth=${isElement ? depth : nothing}
        data-dnd-void=${isElement && isVoidEl ? "" : nothing}
        @click=${() => (activeTab.value.session.selection = path)}
        @contextmenu=${isElement
          ? (/** @type {any} */ e) =>
              showContextMenu(e, path, {
                onEditComponent: ctx.navigateToComponent,
              })
          : nothing}
      >
        <span class="layer-indent" style="width:${depth * 16}px"></span>
        <span class="layer-toggle"
          >${isExpandable
            ? html`
                ${collapsed.has(key)
                  ? html`<sp-icon-chevron-right></sp-icon-chevron-right>`
                  : html`<sp-icon-chevron-down></sp-icon-chevron-down>`}
              `
            : nothing}</span
        >
        <span class=${badgeClass} title=${badgeTitle ?? nothing}>${badgeText}</span>
        <span class="layer-label" style=${labelItalic ? "font-style:italic" : nothing}
          >${labelText}</span
        >
        ${isElement && !isRoot
          ? html`
              <span class="layer-actions">
                ${canMoveUp
                  ? html`<sp-action-button
                      quiet
                      size="xs"
                      title="Move up"
                      @click=${(/** @type {any} */ e) => {
                        e.stopPropagation();
                        /** @type {HTMLElement} */ (e.currentTarget).blur();
                        transactDoc(activeTab.value, (t) =>
                          mutateMoveNode(t, path, parentPath, idx - 1),
                        );
                      }}
                    >
                      <sp-icon-arrow-up slot="icon"></sp-icon-arrow-up>
                    </sp-action-button>`
                  : nothing}
                ${canMoveDown
                  ? html`<sp-action-button
                      quiet
                      size="xs"
                      title="Move down"
                      @click=${(/** @type {any} */ e) => {
                        e.stopPropagation();
                        /** @type {HTMLElement} */ (e.currentTarget).blur();
                        transactDoc(activeTab.value, (t) =>
                          mutateMoveNode(t, path, parentPath, idx + 2),
                        );
                      }}
                    >
                      <sp-icon-arrow-down slot="icon"></sp-icon-arrow-down>
                    </sp-action-button>`
                  : nothing}
                ${canMoveIn
                  ? html`<sp-action-button
                      quiet
                      size="xs"
                      title="Move into previous sibling"
                      @click=${(/** @type {any} */ e) => {
                        e.stopPropagation();
                        /** @type {HTMLElement} */ (e.currentTarget).blur();
                        const prevPath = [...parentPath, idx - 1];
                        const prev = getNodeAtPath(activeTab.value?.doc.document, prevPath);
                        const len = prev?.children?.length || 0;
                        transactDoc(activeTab.value, (t) => mutateMoveNode(t, path, prevPath, len));
                      }}
                    >
                      <sp-icon-arrow-right slot="icon"></sp-icon-arrow-right>
                    </sp-action-button>`
                  : nothing}
                ${canMoveOut
                  ? html`<sp-action-button
                      quiet
                      size="xs"
                      title="Move out of parent"
                      @click=${(/** @type {any} */ e) => {
                        e.stopPropagation();
                        /** @type {HTMLElement} */ (e.currentTarget).blur();
                        const parentIdx = /** @type {number} */ (childIndex(parentPath));
                        transactDoc(activeTab.value, (t) =>
                          mutateMoveNode(t, path, grandparentPath, parentIdx + 1),
                        );
                      }}
                    >
                      <sp-icon-arrow-left slot="icon"></sp-icon-arrow-left>
                    </sp-action-button>`
                  : nothing}
                <sp-action-button
                  quiet
                  size="xs"
                  class="layer-delete"
                  title="Delete"
                  @click=${(/** @type {any} */ e) => {
                    e.stopPropagation();
                    transactDoc(activeTab.value, (t) => mutateRemoveNode(t, path));
                  }}
                >
                  <sp-icon-close slot="icon"></sp-icon-close>
                </sp-action-button>
              </span>
            `
          : nothing}
      </div>
    `);
  }

  return html`
    <div class="layers-container" style="position:relative">
      <div
        class="layers-tree"
        @click=${(/** @type {any} */ e) => {
          const toggle = e.target.closest(".layer-toggle");
          if (!toggle) return;
          e.stopPropagation();
          const row = toggle.closest(".layer-row");
          if (!row) return;
          const key = row.dataset.path;
          if (!key) return;
          if (collapsed.has(key)) collapsed.delete(key);
          else collapsed.add(key);
          ctx.rerender();
        }}
      >
        ${layerRows}
      </div>
    </div>
  `;
}
