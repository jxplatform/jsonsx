/** Stylebook layers panel — shows element/variable tree when in stylebook (settings) mode. */

import { html, nothing } from "lit-html";
import { classMap } from "lit-html/directives/class-map.js";
import { activeTab } from "../workspace/workspace.js";
import { componentRegistry } from "../files/components.js";

/**
 * @param {any} rootStyle
 * @param {string} tag
 */
function hasTagStyle(rootStyle, tag) {
  const s = rootStyle[`& ${tag}`];
  return s && typeof s === "object" && Object.keys(s).length > 0;
}

/**
 * @param {{
 *   selectStylebookTag: (
 *     tag: string,
 *     media?: string | null,
 *     opts?: { panCanvas?: boolean },
 *   ) => void;
 *   stylebookMeta: any;
 * }} ctx
 * @returns {import("lit-html").TemplateResult}
 */
export function renderStylebookLayersTemplate(ctx) {
  const tab = activeTab.value;
  const rootStyle = tab?.doc.document?.style || {};
  const selectedTag = tab?.session.ui.stylebookSelection;
  const selectedLeaf = selectedTag?.includes(" ") ? selectedTag.split(" ").pop() : selectedTag;

  if (tab?.session.ui.stylebookTab === "elements") {
    /**
     * @param {any} entry
     * @param {number} depth
     * @param {string} parentPath
     * @returns {any}
     */
    const renderEntryRow = (entry, depth = 0, parentPath = "") => {
      const tag = entry.tag;
      const fullPath = parentPath ? `${parentPath} ${tag}` : tag;
      const uniqueChildren = entry.children
        ? [...new Map(entry.children.map((/** @type {any} */ c) => [c.tag, c])).values()]
        : [];
      return html`
        <div
          class=${classMap({ "layer-row": true, selected: tag === selectedLeaf })}
          style="padding-left:${8 + depth * 16}px"
          @click=${(/** @type {any} */ e) => {
            e.stopPropagation();
            ctx.selectStylebookTag(fullPath, undefined, { panCanvas: true });
          }}
        >
          <span class="layer-tag">${tag}</span>
          <span
            class="layer-label"
            style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1"
            >${entry.text || `<${tag}>`}</span
          >
          ${hasTagStyle(rootStyle, tag)
            ? html`<span
                style="width:6px;height:6px;border-radius:50%;background:var(--accent);flex-shrink:0"
              ></span>`
            : nothing}
        </div>
        ${uniqueChildren.map((/** @type {any} */ child) =>
          renderEntryRow(child, depth + 1, fullPath),
        )}
      `;
    };

    /** @type {any[]} */
    const elementRows = [];
    for (const section of ctx.stylebookMeta.$sections) {
      for (const entry of /** @type {any[]} */ (section.elements)) {
        elementRows.push(renderEntryRow(entry, 0));
      }
    }
    const compRows = componentRegistry.map(
      /** @param {any} comp */ (comp) => html`
        <div
          class=${classMap({ "layer-row": true, selected: comp.tagName === selectedTag })}
          @click=${() => ctx.selectStylebookTag(comp.tagName, undefined, { panCanvas: true })}
        >
          <span class="layer-tag component-tag" style="background:var(--accent)">⬡</span>
          <span class="layer-label">${comp.tagName}</span>
        </div>
      `,
    );
    return html`${elementRows}${compRows}`;
  } else {
    const style = rootStyle;
    const vars = Object.entries(style).filter(([k]) => k.startsWith("--"));
    if (vars.length === 0) {
      return html`<div style="padding:16px;text-align:center;color:var(--fg-dim);font-size:12px">
        No variables defined
      </div>`;
    }
    return html`${vars.map(
      ([k, v]) => html`
        <div class="layer-row">
          <span class="layer-tag" style="font-size:10px;font-family:'SF Mono','Fira Code',monospace"
            >var</span
          >
          <span class="layer-label">${k}</span>
          <span
            style="font-size:11px;color:var(--fg-dim);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:80px"
            >${String(v)}</span
          >
        </div>
      `,
    )}`;
  }
}
