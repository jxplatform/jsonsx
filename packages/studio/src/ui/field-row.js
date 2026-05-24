/**
 * Field-row.js — Universal field row layout for all Studio panels.
 *
 * Renders the consistent pattern: indicator dot + label + widget slot. Used by style panel,
 * attributes panel, frontmatter panel, signals panel, etc.
 */

import { html, nothing } from "lit-html";
import { classMap } from "lit-html/directives/class-map.js";

/**
 * Render a universal field row with indicator dot, label, and widget.
 *
 * @param {{
 *   prop: string;
 *   label: string;
 *   hasValue: boolean;
 *   onClear?: () => void;
 *   widget: any;
 *   span?: number;
 *   warning?: boolean;
 * }} opts
 * @returns {any}
 */
export function renderFieldRow({ prop, label, hasValue, onClear, widget, span, warning }) {
  return html`
    <div
      class=${classMap({ "style-row": true, "style-row--warning": warning })}
      data-prop=${prop}
      style=${span === 2 ? "grid-column: 1 / -1" : ""}
    >
      <div class="style-row-label">
        ${hasValue && onClear
          ? html`<span
              class="set-dot"
              title="Clear ${prop}"
              @click=${(/** @type {any} */ e) => {
                e.stopPropagation();
                onClear();
              }}
            ></span>`
          : nothing}
        <sp-field-label size="s" title=${prop}>${label}</sp-field-label>
      </div>
      ${widget}
    </div>
  `;
}
