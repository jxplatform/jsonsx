/// <reference lib="dom" />
// ─── Data Explorer ──────────────────────────────────────────────────────────

import { html, nothing } from "lit-html";
import type { TemplateResult } from "lit-html";
import { activeTab } from "../workspace/workspace";
import { renderOnly } from "../store";
import { booleanArg, stringArg, stringProperty } from "../commands/command-args";
import { registerPanel } from "./panel-registry";
import type { AnyCommand, CommandRegistry } from "../commands/registry";

/**
 * The focused tab's expansion record, created on first write.
 *
 * `ui.dataRows` rather than a module Set: expansion is a property of the document you are reading,
 * and a module-global one followed you to the next tab and showed rows open that that document does
 * not define.
 */
function rowsUi(): Record<string, boolean> | null {
  const ui = activeTab.value?.session.ui;
  if (!ui) {
    return null;
  }
  return (ui.dataRows ??= {});
}

/*
 * ── The truncation markers, which are now BUTTONS ────────────────────────────
 *
 * The tree caps arrays at 20, objects at 30 and depth at 5, and printed "… 5 more" as inert text.
 * That is the panel telling you it has the answer and will not show it — the exact case a user
 * opens this panel for is the fetch that returned something unexpected at item 40. Plan §11.2:
 * "truncation markers gain real expand actions."
 *
 * Raising a limit is remembered per marker rather than globally, so opening one long array does not
 * re-render every other one at full length, and it never lowers: a step is a step.
 */
const MORE_STEP = 50;

/** The focused tab's raised-limit record, created on first write. */
function limitsUi(): Record<string, number> | null {
  const ui = activeTab.value?.session.ui;
  if (!ui) {
    return null;
  }
  return (ui.dataLimits ??= {});
}

/** The cap for one marker: the default, plus whatever the reader has asked for. */
function capFor(path: string, kind: "items" | "keys" | "depth", base: number): number {
  return base + (limitsUi()?.[`${path}\u0000${kind}`] ?? 0);
}

/** Raise one marker's limit by a step. Exported for the tests. */
export function raiseDataLimit(path: string, kind: "items" | "keys" | "depth"): void {
  const limits = limitsUi();
  if (!limits) {
    return;
  }
  const key = `${path}\u0000${kind}`;
  limits[key] = (limits[key] ?? 0) + MORE_STEP;
}

/**
 * One truncation marker: a button that shows more of what is already in hand.
 *
 * It repaints through `renderOnly("leftPanel")` rather than a callback, because this renderer is
 * called from three places and threading a repaint through all of them to reach one `<button>`
 * would put a required callback on a pure formatter.
 */
function moreTemplate(
  path: string,
  kind: "items" | "keys" | "depth",
  indent: string,
  label: string,
  after?: () => string,
) {
  return html`<button
    type="button"
    class="data-leaf data-ellipsis data-more"
    style="padding-left:${indent}"
    title=${after?.() ?? `Show ${MORE_STEP} more`}
    @click=${(e: Event) => {
      e.stopPropagation();
      raiseDataLimit(path, kind);
      renderOnly("leftPanel");
    }}
  >
    ${label}
  </button>`;
}

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

/* THE VALUE LIST IS GONE, AND ITS ROWS ARE THE DEFINITION ROWS — `panels/signals-panel.ts`.
   It listed every state entry with its badge and what it resolved to, one rail tab away from a
   panel listing every state entry with its badge and how it is defined: the same names twice, and
   you read one to understand the other. Plan §11.2 asks for "definitions + live values in one row",
   so the definition row now carries the resolved type and expands to the value tree, and what is
   left here is the tree renderer, the type label and the row-expansion record the merged rows read.
   `renderDataTreeTemplate` is unchanged — it was never the redundant half. */
/**
 * Recursively render a JSON value as a tree view (Lit template).
 *
 * @returns {import("lit-html").TemplateResult}
 */
export function renderDataTreeTemplate(
  value: unknown,
  depth: number,
  maxDepth = 5,
  path = "",
): TemplateResult {
  const indent = `${(depth + 1) * 12}px`;

  if (depth > capFor(path, "depth", maxDepth)) {
    return moreTemplate(path, "depth", indent, "…", () => `Show ${MORE_STEP} more levels`);
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
    const cap = capFor(path, "items", 20);
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
        ${renderDataTreeTemplate(item, depth + 1, maxDepth, `${path}/${i}`)}
      `;
    });
    return html`${items}${
      value.length > cap
        ? moreTemplate(path, "items", indent, `… ${value.length - cap} more`)
        : nothing
    }`;
  }

  // Object
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj);
  const cap = capFor(path, "keys", 30);
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
      ${renderDataTreeTemplate(v, depth + 1, maxDepth, `${path}/${key}`)}
    `;
  });
  return html`${items}${
    keys.length > cap ? moreTemplate(path, "keys", indent, `… ${keys.length - cap} more`) : nothing
  }`;
}

// ─── Commands ─────────────────────────────────────────────────────────────────

/** Expand (or collapse) one data row's value tree. Idempotent — expanding twice is expanding once. */
export function setDataRowExpanded(name: string, expanded: boolean): void {
  const rows = rowsUi();
  if (!rows) {
    return;
  }
  if (expanded) {
    rows[name] = true;
  } else {
    delete rows[name];
  }
}

/** Whether a data row is currently expanded. Exported for the tests and the command's idempotence. */
export function isDataRowExpanded(name: string): boolean {
  return rowsUi()?.[name] === true;
}

/** The expanded rows, in no particular order — `formula.openWorkspace` asks when it has no target. */
export function expandedDataRows(): string[] {
  return Object.keys(rowsUi() ?? {});
}

/** Drop every expansion AND every raised limit on the focused tab — a fresh document, and tests. */
export function resetDataRowExpansion(): void {
  const ui = activeTab.value?.session.ui;
  if (ui) {
    ui.dataRows = {};
    ui.dataLimits = {};
  }
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

/**
 * Contribute the Data panel — the DEFINITIONS and the values they resolve to, in one place.
 *
 * `level: "document"`, because both belong to the open document.
 *
 * **This is where the State editor lives now.** Plan §11.2 always said so ("State panel + inline
 * editor → Navigator › Data"), but the two halves shipped apart: the rail button was taken away to
 * keep the DOCUMENT group at four, the merge was deferred, and the editor was left reachable only
 * by typing its name into the palette. So the one surface for declaring a state variable — or a
 * component property, which is a state entry with a default — became unfindable, which is a
 * capability lost rather than a control moved.
 *
 * Defining and watching are the same task interrupted: you add an entry, then look at what it
 * resolved to. Two panels made that two panels.
 */
export function registerDataPanel(): void {
  registerPanel({
    id: "data",
    title: "Data",
    level: "document",
    dock: "navigator",
    icon: "sp-icon-data",
    requiresDocument: "Open a page to give it data — values it can read, compute or fetch.",
    render: (ctx) =>
      // `ctx.doc!` — `requiresDocument` means the registry renders the empty state instead of
      // Calling this, the same assertion `head-panel.ts` makes for the same reason.
      ctx.deps.renderSignalsTemplate(ctx.doc!, {
        refreshData: ctx.deps.refreshData,
        renderLeftPanel: ctx.rerender,
      }),
  });
}
