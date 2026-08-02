/// <reference lib="dom" />
// ─── Data Explorer ──────────────────────────────────────────────────────────

import { html, nothing } from "lit-html";
import { classMap } from "lit-html/directives/class-map.js";
import type { TemplateResult } from "lit-html";
import { setActivityTab } from "../shell";
import { activeTab } from "../workspace/workspace";
import { booleanArg, stringArg, stringProperty } from "../commands/command-args";
import { renderEmptyState } from "./empty-state";
import type { AnyCommand, CommandRegistry } from "../commands/registry";

/** Expanded data entries set — persists across renders. */
const expandedDataKeys = new Set<string>();

/** Unwrap a Vue ref (has .value and .__v_isRef) to get the underlying value. */
export function unwrapSignal(value: unknown) {
  if (value && typeof value === "object" && (value as Record<string, unknown>).__v_isRef) {
    return (value as Record<string, unknown>).value;
  }
  return value;
}

/** Type label for a signal value in the data explorer. */
export function dataTypeLabel(value: unknown) {
  const v = unwrapSignal(value);
  if (v === null) {
    return "null";
  }
  if (v === undefined) {
    return "pending";
  }
  if (Array.isArray(v)) {
    return `Array(${v.length})`;
  }
  if (typeof v === "object") {
    return `{${Object.keys(v).length}}`;
  }
  return typeof v;
}

/**
 * Render the data explorer tab showing live resolved values.
 *
 * @param {Record<string, unknown>} state - S.document.state (the $defs definitions)
 * @param {Record<string, unknown> | null} liveScope - Cached live scope from runtime rendering
 * @param {{
 *   renderCanvas: () => void;
 *   refreshData: () => void;
 *   renderLeftPanel: () => void;
 *   defCategory: (def: unknown) => string;
 *   defBadgeLabel: (def: unknown) => string;
 * }} callbacks
 * @returns {import("lit-html").TemplateResult}
 */
export function renderDataExplorerTemplate(
  state: Record<string, unknown>,
  liveScope: Record<string, unknown> | null,
  callbacks: {
    renderCanvas: () => void;
    /** Re-render the canvas AND let automatic `Request` entries fetch (the Refresh button). */
    refreshData: () => void;
    renderLeftPanel: () => void;
    defCategory: (def: unknown) => string;
    defBadgeLabel: (def: unknown) => string;
  },
) {
  const { refreshData, renderLeftPanel, defCategory, defBadgeLabel } = callbacks;

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
          // Edit/design suppress automatic `Request` fetches (a full render re-resolves every state
          // Entry, so authoring would refetch constantly). Re-firing them on demand is exactly what
          // This button is for, which is why it goes through refreshData rather than renderCanvas.
          refreshData();
          setTimeout(() => renderLeftPanel(), 200);
        }}
      >
        <sp-icon-refresh slot="icon"></sp-icon-refresh>
        Refresh
      </sp-action-button>
    </div>
    ${
      entries.length === 0
        ? renderEmptyState({
            actions: [
              {
                label: "Define data",
                run: () => {
                  // The definitions live one rail tab over; this is the panel that fills this one.
                  setActivityTab("state");
                },
              },
            ],
            message: "Every value this page defines shows up here with what it resolved to.",
          })
        : entries.map(([name, def]) => {
            const value = scope[name];
            const unwrapped = unwrapSignal(value);
            const isExpanded = expandedDataKeys.has(name);
            return html`
              <div class="data-row">
                <div
                  class=${classMap({
                    "data-row-header": true,
                    expanded: isExpanded,
                  })}
                  @click=${() => {
                    // One writer: the row's click and `data.expandRow` land in the same function.
                    setDataRowExpanded(name, !isExpanded);
                    renderLeftPanel();
                  }}
                >
                  <span class="signal-badge ${defCategory(def)}">${defBadgeLabel(def)}</span>
                  <span class="data-name">${name}</span>
                  <span
                    class=${classMap({
                      "data-pending": unwrapped === null,
                      "data-type": true,
                    })}
                    >${dataTypeLabel(value)}</span
                  >
                </div>
                ${
                  isExpanded
                    ? html`<div class="data-tree">${renderDataTreeTemplate(unwrapped, 0)}</div>`
                    : nothing
                }
              </div>
            `;
          })
    }
  `;
}

/**
 * Recursively render a JSON value as a tree view (Lit template).
 *
 * @returns {import("lit-html").TemplateResult}
 */
export function renderDataTreeTemplate(
  value: unknown,
  depth: number,
  maxDepth = 5,
): TemplateResult {
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
    const items: TemplateResult[] = value.slice(0, cap).map((item, i) => {
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
      const label = Array.isArray(item)
        ? `Array(${item.length})`
        : `{${Object.keys(item as object).length}}`;
      return html`
        <div class="data-branch" style="padding-left:${indent}">
          <span class="data-key">[${i}] </span
          ><span class="data-value data-object-label">${label}</span>
        </div>
        ${renderDataTreeTemplate(item, depth + 1, maxDepth)}
      `;
    });
    return html`${items}${
      value.length > cap
        ? html`<div class="data-leaf data-ellipsis" style="padding-left:${indent}">
            … ${value.length - cap} more
          </div>`
        : nothing
    }`;
  }

  // Object
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj);
  const cap = 30;
  const items: TemplateResult[] = keys.slice(0, cap).map((key) => {
    const v = obj[key];
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
  return html`${items}${
    keys.length > cap
      ? html`<div class="data-leaf data-ellipsis" style="padding-left:${indent}">
          … ${keys.length - cap} more
        </div>`
      : nothing
  }`;
}

// ─── Commands ─────────────────────────────────────────────────────────────────

/** Expand (or collapse) one data row's value tree. Idempotent — expanding twice is expanding once. */
export function setDataRowExpanded(name: string, expanded: boolean): void {
  if (expanded) {
    expandedDataKeys.add(name);
  } else {
    expandedDataKeys.delete(name);
  }
}

/** Whether a data row is currently expanded. Exported for the tests and the command's idempotence. */
export function isDataRowExpanded(name: string): boolean {
  return expandedDataKeys.has(name);
}

/** Drop every expansion — a fresh document, and the tests. */
export function resetDataRowExpansion(): void {
  expandedDataKeys.clear();
}

/** The state entry names the open document defines — what a row can be named by. */
function definedDataNames(): string[] {
  return Object.keys(activeTab.value?.doc.document?.state ?? {});
}

/** What the data verb needs that this module does not own. */
export interface DataExplorerCommandDeps {
  /** Repaint the Navigator so the expanded row's tree appears — `left-panel.ts`'s `render`. */
  renderLeftPanel: () => void;
}

/**
 * The Data panel's row verb.
 *
 * `expandRow` reads as a delta but is not one: it names the state it ends in, which is why it
 * survives `__jxAutomation`'s `/\.toggle[A-Z]/` refusal and why running it twice photographs the
 * same picture. The collapse direction is `{ expanded: false }` on the same record rather than a
 * second id.
 *
 * REFUSES a name the open document does not define. The predecessor matched the row by its rendered
 * label through an XPath, so a document without that entry silently pressed nothing and the shot
 * recorded a collapsed panel as if it were the feature.
 *
 * @param {DataExplorerCommandDeps} deps
 * @returns {AnyCommand[]}
 */
export function dataExplorerCommands(deps: DataExplorerCommandDeps): AnyCommand[] {
  return [
    {
      args: {
        additionalProperties: false,
        properties: {
          expanded: {
            default: true,
            description: "True to expand the row's value tree, false to collapse it.",
            type: "boolean",
          },
          name: stringProperty("The state entry's name, as the document defines it."),
        },
        required: ["name"],
        type: "object",
      },
      category: "Document",
      id: "data.expandRow",
      level: "document",
      menus: ["palette"],
      group: "5_data",
      requires: "an open document that defines data",
      when: (ctx) => ctx.document.open,
      run: (_commandCtx, args) => {
        const name = stringArg("data.expandRow", args, "name");
        const defined = definedDataNames();
        if (!defined.includes(name)) {
          throw new RangeError(
            `command "data.expandRow" argument "name": "${name}" is not defined by this ` +
              `document — it defines: ${defined.length > 0 ? defined.join(", ") : "nothing"}`,
          );
        }
        const { expanded } = args as { expanded?: unknown };
        // `expanded` defaults to true but is never COERCED: `{ expanded: "no" }` would otherwise
        // Read as a collapse, which is the class of silent wrong answer this whole record exists
        // To stop.
        setDataRowExpanded(
          name,
          expanded === undefined || booleanArg("data.expandRow", args, "expanded"),
        );
        deps.renderLeftPanel();
      },
      title: "Expand Data Row",
    },
  ];
}

/**
 * Register the Data panel's row verb.
 *
 * @param {CommandRegistry} registry
 * @param {DataExplorerCommandDeps} deps
 */
export function registerDataExplorerCommands(
  registry: CommandRegistry,
  deps: DataExplorerCommandDeps,
): void {
  registry.registerAll(dataExplorerCommands(deps));
}
