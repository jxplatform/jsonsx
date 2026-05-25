// ─── Data Explorer ──────────────────────────────────────────────────────────

import { html, nothing } from "lit-html";
import { classMap } from "lit-html/directives/class-map.js";

/** Expanded data entries set — persists across renders. */
const expandedDataKeys = new Set();

/** Unwrap a Vue ref (has .value and .__v_isRef) to get the underlying value. */
function unwrapSignal(/** @type {any} */ value) {
  if (value && typeof value === "object" && value.__v_isRef) return value.value;
  return value;
}

/** Type label for a signal value in the data explorer. */
function dataTypeLabel(/** @type {any} */ value) {
  const v = unwrapSignal(value);
  if (v === null) return "null";
  if (v === undefined) return "pending";
  if (Array.isArray(v)) return `Array(${v.length})`;
  if (typeof v === "object") return `{${Object.keys(v).length}}`;
  return typeof v;
}

/**
 * Render the data explorer tab showing live resolved values.
 *
 * @param {Record<string, any>} state - S.document.state (the $defs definitions)
 * @param {Record<string, any> | null} liveScope - Cached live scope from runtime rendering
 * @param {{
 *   renderCanvas: () => void;
 *   renderLeftPanel: () => void;
 *   defCategory: (def: any) => string;
 *   defBadgeLabel: (def: any) => string;
 * }} callbacks
 * @returns {any}
 */
export function renderDataExplorerTemplate(state, liveScope, callbacks) {
  const { renderCanvas, renderLeftPanel, defCategory, defBadgeLabel } = callbacks;

  const defs = state || {};
  const entries = Object.entries(defs);
  const scope = liveScope || {};

  return html`
    <div class="data-explorer-toolbar">
      <sp-action-button
        quiet
        size="s"
        class="data-refresh-btn"
        @click=${() => {
          renderCanvas();
          setTimeout(() => renderLeftPanel(), 200);
        }}
      >
        <sp-icon-refresh slot="icon"></sp-icon-refresh>
        Refresh
      </sp-action-button>
    </div>
    ${entries.length === 0
      ? html`<div class="empty-state">No state defined</div>`
      : entries.map(([name, def]) => {
          const value = scope[name];
          const unwrapped = unwrapSignal(value);
          const isExpanded = expandedDataKeys.has(name);
          return html`
            <div class="data-row">
              <div
                class=${classMap({ "data-row-header": true, expanded: isExpanded })}
                @click=${() => {
                  if (expandedDataKeys.has(name)) expandedDataKeys.delete(name);
                  else expandedDataKeys.add(name);
                  renderLeftPanel();
                }}
              >
                <span class="signal-badge ${defCategory(def)}">${defBadgeLabel(def)}</span>
                <span class="data-name">${name}</span>
                <span class=${classMap({ "data-type": true, "data-pending": unwrapped === null })}
                  >${dataTypeLabel(value)}</span
                >
              </div>
              ${isExpanded
                ? html`<div class="data-tree">${renderDataTreeTemplate(unwrapped, 0)}</div>`
                : nothing}
            </div>
          `;
        })}
  `;
}

/**
 * Recursively render a JSON value as a tree view (Lit template).
 *
 * @returns {any}
 */
export function renderDataTreeTemplate(
  /** @type {any} */ value,
  /** @type {any} */ depth,
  maxDepth = 5,
) {
  const indent = `${(depth + 1) * 12}px`;

  if (depth > maxDepth) {
    return html`<div class="data-leaf data-ellipsis" style="padding-left:${indent}">…</div>`;
  }

  if (value === null || value === undefined) {
    return html`<div class="data-leaf data-null" style="padding-left:${indent}">
      ${String(value)}
    </div>`;
  }

  if (typeof value !== "object") {
    const text =
      typeof value === "string" && value.length > 200
        ? `"${value.slice(0, 200)}\u2026"`
        : JSON.stringify(value);
    return html`<div class="data-leaf data-${typeof value}" style="padding-left:${indent}">
      ${text}
    </div>`;
  }

  if (Array.isArray(value)) {
    const cap = 20;
    const items = value.slice(0, cap).map((item, i) => {
      if (item === null || item === undefined || typeof item !== "object") {
        const valText =
          typeof item === "string" && item.length > 80
            ? `"${item.slice(0, 80)}\u2026"`
            : JSON.stringify(item);
        return html`<div class="data-branch" style="padding-left:${indent}">
          <span class="data-key">[${i}] </span
          ><span class="data-value data-${item === null ? "null" : typeof item}">${valText}</span>
        </div>`;
      }
      const label = Array.isArray(item) ? `Array(${item.length})` : `{${Object.keys(item).length}}`;
      return html`
        <div class="data-branch" style="padding-left:${indent}">
          <span class="data-key">[${i}] </span
          ><span class="data-value data-object-label">${label}</span>
        </div>
        ${renderDataTreeTemplate(item, depth + 1, maxDepth)}
      `;
    });
    return html`${items}${value.length > cap
      ? html`<div class="data-leaf data-ellipsis" style="padding-left:${indent}">
          … ${value.length - cap} more
        </div>`
      : nothing}`;
  }

  // Object
  const keys = Object.keys(value);
  const cap = 30;
  const items = keys.slice(0, cap).map((key) => {
    const v = value[key];
    if (v === null || v === undefined || typeof v !== "object") {
      const valText =
        typeof v === "string" && v.length > 80 ? `"${v.slice(0, 80)}\u2026"` : JSON.stringify(v);
      return html`<div class="data-branch" style="padding-left:${indent}">
        <span class="data-key">${key}: </span
        ><span class="data-value data-${v === null ? "null" : typeof v}">${valText}</span>
      </div>`;
    }
    const label = Array.isArray(v) ? `Array(${v.length})` : `{${Object.keys(v).length}}`;
    return html`
      <div class="data-branch" style="padding-left:${indent}">
        <span class="data-key">${key}: </span
        ><span class="data-value data-object-label">${label}</span>
      </div>
      ${renderDataTreeTemplate(v, depth + 1, maxDepth)}
    `;
  });
  return html`${items}${keys.length > cap
    ? html`<div class="data-leaf data-ellipsis" style="padding-left:${indent}">
        … ${keys.length - cap} more
      </div>`
    : nothing}`;
}
