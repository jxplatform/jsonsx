/// <reference lib="dom" />
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
 *   widget: unknown;
 *   labelExtra?: unknown;
 *   span?: number;
 *   warning?: boolean;
 * }} opts
 * @returns {import("lit-html").TemplateResult}
 */
export function renderFieldRow({
  prop,
  label,
  hasValue,
  onClear,
  widget,
  labelExtra,
  span,
  warning,
}: {
  prop: string;
  label: string;
  hasValue: boolean;
  onClear?: () => void;
  widget: unknown;
  /** Rendered after the label inside the label cell (e.g. the dynamic-slot mode button). */
  labelExtra?: unknown;
  span?: number;
  warning?: boolean;
}) {
  return html`
    <div
      class=${classMap({ "style-row": true, "style-row--warning": Boolean(warning) })}
      data-prop=${prop}
      style=${span === 2 ? "grid-column: 1 / -1" : ""}
    >
      <div class="style-row-label">
        ${
          hasValue && onClear
            ? html`<span
                class="set-dot"
                title="Clear ${prop}"
                @click=${(e: Event) => {
                  e.stopPropagation();
                  onClear();
                }}
              ></span>`
            : nothing
        }
        <sp-field-label size="s" title=${prop}>${label}</sp-field-label>
        ${labelExtra ?? nothing}
      </div>
      ${widget}
    </div>
  `;
}
