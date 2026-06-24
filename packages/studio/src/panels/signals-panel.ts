/// <reference lib="dom" />
/**
 * Signals panel — signal/def helpers, signals template, CEM editors, plugin schema forms.
 *
 * Extracted from studio.js to reduce file size.
 */

import { html, nothing } from "lit-html";
import { classMap } from "lit-html/directives/class-map.js";
import { ifDefined } from "lit-html/directives/if-defined.js";
import { styleMap } from "lit-html/directives/style-map.js";
import { projectState } from "../state";
import type { JsonValue } from "../types";
import { activeTab } from "../workspace/workspace";
import {
  mutateAddDef,
  mutateRemoveDef,
  mutateRenameDef,
  mutateUpdateDef,
  transactDoc,
} from "../tabs/transact";
import { renderFieldRow } from "../ui/field-row";
import { rawTextArea, spTextField } from "../ui/field-input";
import { expressionHint, renderExpressionEditor } from "../ui/expression-editor";
import { renderMediaPicker } from "../ui/media-picker";
import type { TabUi } from "../tabs/tab";
import type {
  CemEvent,
  CemParameter,
  JxMutableNode,
  JxStateDefinition,
} from "@jxsuite/schema/types";
import { fetchPluginSchema, pluginSchemaCache } from "../services/code-services";
import type { TemplateResult } from "lit-html";

interface SignalsPanelState {
  document: JxMutableNode;
  ui?: TabUi | Record<string, unknown>;
  mode?: string;
  selection?: (string | number)[] | null;
  canvas?: Record<string, unknown>;
  _collapsedSignalCats?: Set<string>;
  documentPath?: string | null | undefined;
}

interface SignalsPanelCtx {
  renderLeftPanel: () => void;
  renderCanvas: () => void;
  updateSession: (patch: Record<string, unknown>) => void;
}

interface JsonSchema {
  type?: string;
  properties?: Record<string, SchemaProperty>;
  required?: string[];
  description?: string;
}

interface SchemaProperty {
  type?: string;
  enum?: string[];
  default?: unknown;
  format?: string;
  minimum?: number;
  maximum?: number;
  description?: string;
  examples?: string[];
  name?: string;
  items?: {
    type?: string;
    properties?: Record<string, Record<string, unknown>>;
    required?: string[];
  };
}

export interface SignalDef {
  $prototype?: string;
  $src?: string;
  $export?: string;
  $compute?: string;
  $deps?: string[];
  $expression?: Record<string, unknown>;
  $handler?: string;
  type?: string;
  default?: unknown;
  body?: string;
  parameters?: string[];
  timing?: string;
  description?: string;
  fields?: Record<string, unknown>;
  url?: string;
  method?: string;
  key?: string;
  database?: string;
  store?: string;
  version?: number;
  name?: string;
  attribute?: string;
  reflects?: boolean;
  deprecated?: string | boolean;
  format?: string;
  emits?: CemEvent[];
  [key: string]: unknown;
}

// ─── Module-local state ─────────────────────────────────────────────────────

/** Expanded signal editor state (persists across renders). */
let expandedSignal: string | null = null;

/** Track which functions have the advanced param editor open. */
const advancedParamOpen = new Set();

/** Default templates for creating new signal definitions. */
const DEF_TEMPLATES = {
  computed: { $compute: "", $deps: [] },
  cookie: { $prototype: "Cookie", default: "", name: "" },
  expression: { $expression: { operator: "=", target: null } },
  external: { $prototype: "", $src: "" },
  formData: { $prototype: "FormData", fields: {} },
  function: { $prototype: "Function", body: "", parameters: [] },
  indexedDB: { $prototype: "IndexedDB", database: "", store: "", version: 1 },
  localStorage: { $prototype: "LocalStorage", default: null, key: "" },
  map: { $prototype: "Map", default: {} },
  request: { $prototype: "Request", method: "GET", timing: "client", url: "" },
  sessionStorage: { $prototype: "SessionStorage", default: null, key: "" },
  set: { $prototype: "Set", default: [] },
  state: { default: "", type: "string" },
} as Record<string, SignalDef>;

/** Keys handled by the framework — skip when rendering schema fields. */
const STUDIO_RESERVED_KEYS = new Set([
  "$prototype",
  "$src",
  "$export",
  "timing",
  "default",
  "description",
  "body",
  "parameters",
  "name",
  "attribute",
  "reflects",
  "deprecated",
  "emits",
]);

// ─── Signals / defs helpers ──────────────────────────────────────────────────

/**
 * View a state entry through the panel's flattened editing lens. Naked primitive and array entries
 * surface as an empty view — the renderers guard every field access.
 *
 * @param {import("@jxsuite/schema/types").JxStateDefinition} def
 * @returns {SignalDef}
 */
function asSignalDef(def: JxStateDefinition): SignalDef {
  return (typeof def === "object" && def !== null && !Array.isArray(def) ? def : {}) as SignalDef;
}

/**
 * Classify a state entry into a category string.
 *
 * @param {SignalDef | unknown} def
 */
export function defCategory(def: SignalDef | unknown) {
  if (!def) {
    return "state";
  }
  const d = def as SignalDef;
  if (d.$expression) {
    return "expression";
  }
  if (d.$handler || d.$prototype === "Function") {
    return "function";
  }
  if (d.$compute) {
    return "computed";
  }
  if (d.$prototype) {
    return "data";
  }
  return "state";
}

/**
 * Badge label for a def category.
 *
 * @param {SignalDef | unknown} def
 */
export function defBadgeLabel(def: SignalDef | unknown) {
  if (!def) {
    return "S";
  }
  const d = def as SignalDef;
  if (d.$expression) {
    return "E";
  }
  if (d.$handler || d.$prototype === "Function") {
    return "F";
  }
  if (d.$compute) {
    return "C";
  }
  if (d.$prototype) {
    return d.$prototype.charAt(0);
  }
  return "S";
}

/**
 * Hint text for a signal row.
 *
 * @param {string} name
 * @param {SignalDef | null | undefined} def
 */
export function defHint(_name: string, def: SignalDef | null | undefined) {
  if (!def) {
    return "";
  }
  if (def.$expression) {
    return expressionHint(def.$expression);
  }
  if (def.$prototype === "Function") {
    if (def.body) {
      return def.body.length > 20 ? `${def.body.slice(0, 20)}...` : def.body;
    }
    if (def.$src) {
      return def.$src;
    }
    return "function";
  }
  if (def.$handler) {
    return "handler (legacy)";
  }
  if (def.$compute) {
    return `=${def.$compute.length > 20 ? `${def.$compute.slice(0, 20)}...` : def.$compute}`;
  }
  if (def.$prototype === "Request") {
    return `${def.method || "GET"} ${(def.url || "").slice(0, 20)}`;
  }
  if (def.$prototype === "LocalStorage" || def.$prototype === "SessionStorage") {
    return def.key || "";
  }
  if (def.$prototype === "IndexedDB") {
    return def.database || "";
  }
  if (def.$prototype === "Cookie") {
    return def.name || "";
  }
  if (def.$prototype) {
    return def.$prototype;
  }
  if (def.attribute) {
    return `[${def.attribute}] ${def.type || ""}`;
  }
  return def.type || "";
}

/**
 * Whether the current document defines a custom element (hyphenated tagName).
 *
 * @param {SignalsPanelState} S
 */
export function isCustomElementDoc(S: SignalsPanelState) {
  return (S.document.tagName || "").includes("-");
}

/**
 * Recursively collect CSS `part` attributes from the document tree.
 *
 * @param {JxMutableNode | null | undefined} node
 * @param {{ name: string; tag: string }[]} [parts]
 */
export function collectCssParts(
  node: JxMutableNode | null | undefined,
  parts: { name: string; tag: string }[] = [],
) {
  const part = node?.attributes?.part;
  if (typeof part === "string" && part) {
    parts.push({ name: part, tag: node?.tagName || "div" });
  }
  if (Array.isArray(node?.children)) {
    for (const c of node.children) {
      if (typeof c !== "string") {
        collectCssParts(c, parts);
      }
    }
  }
  return parts;
}

/**
 * Resolve a $ref value to a display string using signal defaults. Used by the canvas to show real
 * values instead of raw refs.
 *
 * @param {unknown} value
 * @param {Record<string, SignalDef> | null | undefined} defs
 */
export function resolveDefaultForCanvas(
  value: unknown,
  defs: Record<string, JxStateDefinition> | null | undefined,
) {
  if (!value || typeof value !== "object" || !(value as Record<string, unknown>).$ref) {
    return value;
  }
  const ref = (value as Record<string, unknown>).$ref as string;
  /** @type {string | undefined} */
  let defName;
  if (ref.startsWith("#/state/")) {
    defName = ref.slice(8);
  } else if (ref.startsWith("$")) {
    defName = ref;
  } else {
    return `{${ref}}`;
  }

  const rawDef = defs?.[defName];
  if (!rawDef) {
    return `{${defName}}`;
  }
  const def = asSignalDef(rawDef);

  // State signal → use default
  if (!def.$compute && !def.$prototype) {
    if (def.default !== undefined && def.default !== null) {
      if (typeof def.default === "object") {
        return JSON.stringify(def.default);
      }
      return String(def.default);
    }
    return "";
  }
  // Computed → expression indicator
  if (def.$compute) {
    return `\u0192(${defName})`;
  }
  // Request → URL hint
  if (def.$prototype === "Request") {
    return `\u27F3 ${def.url || "fetch"}`;
  }
  // Storage → use default or key
  if (def.$prototype === "LocalStorage" || def.$prototype === "SessionStorage") {
    if (def.default !== undefined && def.default !== null) {
      if (typeof def.default === "object") {
        return JSON.stringify(def.default);
      }
      return String(def.default);
    }
    return `[${def.key || "storage"}]`;
  }
  if (def.$prototype) {
    return `{${def.$prototype}}`;
  }
  return `{${defName}}`;
}

// ─── Simple field row ────────────────────────────────────────────────────────

/** Simple field row for signal editors — vertical stacked layout. */
export function signalFieldRow(label: string, value: string, onChange: (value: string) => void) {
  return renderFieldRow({
    prop: label,
    label,
    hasValue: false,
    // CommitMode "blur": signal fields (rename, src, etc.) commit on blur/Enter only — a debounced
    // Mid-typing commit would, e.g., rename the signal on every keystroke pause.
    widget: spTextField(
      `sig:${label}`,
      value,
      (v: string) => {
        if (v !== value) {
          onChange(v);
        }
      },
      { commitMode: "blur" },
    ),
  });
}

/** Normalize a parameter entry to a CEM object. */
export function normParam(p: string | CemParameter): CemParameter {
  return typeof p === "string" ? { name: p } : p;
}

/** Extract the display text from a CEM `{ text }` type value, if present. */
function cemTypeText(type: JsonValue | undefined): string {
  if (typeof type === "object" && type !== null && !Array.isArray(type)) {
    const { text } = type;
    if (typeof text === "string") {
      return text;
    }
  }
  return "";
}

// ─── Left panel: Signals ─────────────────────────────────────────────────────

/**
 * @param {SignalsPanelState} S
 * @param {SignalsPanelCtx} ctx
 */
export function renderSignalsTemplate(S: SignalsPanelState, ctx: SignalsPanelCtx) {
  const defs = S.document.state || {};
  const entries = Object.entries(defs);

  // Group by category
  const groups = {
    computed: [],
    data: [],
    expression: [],
    function: [],
    state: [],
  } as Record<string, [string, SignalDef][]>;
  for (const [name, def] of entries) {
    groups[defCategory(def)]!.push([name, asSignalDef(def)]);
  }

  const categories = [
    { items: groups.state!, key: "state", label: "State" },
    { items: groups.computed!, key: "computed", label: "Computed" },
    { items: groups.data!, key: "data", label: "Data" },
    { items: groups.expression!, key: "expression", label: "Expressions" },
    { items: groups.function!, key: "function", label: "Functions" },
  ];

  const collapsedCats = (S._collapsedSignalCats ||= new Set());

  const catTemplates = categories
    .filter((c) => c.items.length > 0)
    .map(
      ({ key, label, items }) => html`
        <sp-accordion-item
          label="${label} (${items.length})"
          ?open=${!collapsedCats.has(key)}
          @sp-accordion-item-toggle=${() => {
            if (collapsedCats.has(key)) {
              collapsedCats.delete(key);
            } else {
              collapsedCats.add(key);
            }
            ctx.renderLeftPanel();
          }}
        >
          ${items.map(([name, def]) => {
            const isExpanded: boolean = expandedSignal === name;
            return html`
              <div
                class=${classMap({ expanded: isExpanded, "signal-row": true })}
                @click=${() => {
                  expandedSignal = isExpanded ? null : name;
                  ctx.renderLeftPanel();
                }}
              >
                <span class="signal-badge ${defCategory(def)}">${defBadgeLabel(def)}</span>
                <span class="signal-name">${name}</span>
                <span class="signal-hint">${defHint(name, def)}</span>
                <sp-action-button
                  quiet
                  size="xs"
                  class="signal-del"
                  @click=${(e: Event) => {
                    e.stopPropagation();
                    transactDoc(activeTab.value, (t) => mutateRemoveDef(t, name));
                  }}
                >
                  <sp-icon-delete slot="icon"></sp-icon-delete>
                </sp-action-button>
              </div>
              ${isExpanded
                ? html`<div class="signal-editor">
                    ${renderSignalEditorTemplate(S, name, def, ctx)}
                  </div>`
                : nothing}
            `;
          })}
        </sp-accordion-item>
      `,
    );

  return html`
    <div class="signals-panel">
      <sp-accordion allow-multiple size="s"> ${catTemplates} </sp-accordion>
      ${entries.length === 0 ? html`<div class="empty-state">No state defined</div>` : nothing}
      <div class="signals-add">
        <sp-picker
          size="s"
          label="+ Add…"
          placeholder="+ Add…"
          @change=${(e: Event) => {
            const type = (e.target as HTMLInputElement).value;
            if (!type) {
              return;
            }

            // Handle import-based prototypes (e.g., "import:ContentCollection")
            if (type.startsWith("import:")) {
              const protoName = type.slice(7);
              const src = projectState?.projectConfig?.imports?.[protoName];
              let n = `$${protoName.charAt(0).toLowerCase()}${protoName.slice(1)}`;
              let i = 1;
              const base = n;
              while (S.document.state && S.document.state[n]) {
                n = base + i;
                i += 1;
              }
              transactDoc(activeTab.value, (t) =>
                mutateAddDef(
                  t,
                  n,
                  /** @type {Record<string, JsonValue>} */ {
                    $prototype: protoName,
                  },
                ),
              );
              expandedSignal = n;
              if (src) {
                void fetchPluginSchema(
                  { $prototype: protoName, $src: src },
                  {
                    ...(S.documentPath != null && {
                      documentPath: S.documentPath,
                    }),
                  },
                ).then(() => ctx.renderLeftPanel());
              } else {
                ctx.renderLeftPanel();
              }
              return;
            }

            const template = DEF_TEMPLATES[type];
            if (!template) {
              return;
            }
            const isFunction = type === "function";
            const nameBase = isFunction ? "newFunction" : "$newSignal";
            let n = nameBase;
            let i = 1;
            while (S.document.state && S.document.state[n]) {
              n = nameBase + i;
              i += 1;
            }
            transactDoc(activeTab.value, (t) =>
              mutateAddDef(t, n, structuredClone(template) as Record<string, JsonValue>),
            );
            expandedSignal = n;
            ctx.renderLeftPanel();
          }}
        >
          <sp-menu-item value="state">State Signal</sp-menu-item>
          <sp-menu-item value="computed">Computed</sp-menu-item>
          <sp-menu-divider></sp-menu-divider>
          <sp-menu-item value="request">Fetch (Request)</sp-menu-item>
          <sp-menu-item value="localStorage">LocalStorage</sp-menu-item>
          <sp-menu-item value="sessionStorage">SessionStorage</sp-menu-item>
          <sp-menu-item value="indexedDB">IndexedDB</sp-menu-item>
          <sp-menu-item value="cookie">Cookie</sp-menu-item>
          <sp-menu-item value="set">Set</sp-menu-item>
          <sp-menu-item value="map">Map</sp-menu-item>
          <sp-menu-item value="formData">FormData</sp-menu-item>
          <sp-menu-item value="external">External Module…</sp-menu-item>
          ${projectState?.projectConfig?.imports
            ? html`<sp-menu-divider></sp-menu-divider>${Object.keys(
                  projectState.projectConfig.imports,
                ).map((k: string) => html`<sp-menu-item value="import:${k}">${k}</sp-menu-item>`)}`
            : nothing}
          <sp-menu-divider></sp-menu-divider>
          <sp-menu-item value="expression">Expression</sp-menu-item>
          <sp-menu-item value="function">Function</sp-menu-item>
        </sp-picker>
      </div>
    </div>
  `;
}

/** Render inline editor fields for a specific signal/def type. */
function renderSignalEditorTemplate(
  S: SignalsPanelState,
  name: string,
  defArg: SignalDef,
  ctx: SignalsPanelCtx,
) {
  const def = typeof defArg === "object" && defArg !== null ? defArg : { default: defArg };
  const cat = defCategory(def);

  // Helper for picker rows
  const pickerRow = (
    label: string,
    options: string[],
    currentVal: string,
    onChange: (value: string) => void,
  ) =>
    renderFieldRow({
      hasValue: false,
      label,
      prop: label,
      widget: html`
        <sp-picker
          size="s"
          value=${currentVal}
          @change=${(e: Event) => onChange((e.target as HTMLInputElement).value)}
        >
          ${options.map((opt: string) => html`<sp-menu-item value=${opt}>${opt}</sp-menu-item>`)}
        </sp-picker>
      `,
    });

  // Helper for textarea rows — uses the shared draft layer (commits on blur/Enter and a 500ms
  // Debounce) so a panel re-render mid-edit can't truncate the in-progress text.
  const textareaRow = (
    label: string,
    value: string,
    onChange: (value: string) => void,
    opts: { minHeight?: string; mono?: boolean } = {},
  ) =>
    renderFieldRow({
      hasValue: false,
      label,
      prop: label,
      widget: rawTextArea(`sig:${label}`, value, onChange, {
        debounceMs: 500,
        ...(opts.minHeight != null && { minHeight: opts.minHeight }),
        ...(opts.mono != null && { mono: opts.mono }),
      }),
    });

  // Name field (common to all)
  const nameField = signalFieldRow("Name", name, (v: string) => {
    if (v && v !== name && !(S.document.state && S.document.state[v])) {
      expandedSignal = v;
      transactDoc(activeTab.value, (t) => mutateRenameDef(t, name, v));
    }
  });

  let fields: TemplateResult | typeof nothing = nothing;

  if (cat === "state") {
    const defaultVal =
      def.default !== undefined && def.default !== null
        ? typeof def.default === "object"
          ? JSON.stringify(def.default)
          : String(def.default)
        : "";

    const cemFields = isCustomElementDoc(S)
      ? html`
          ${signalFieldRow("Attribute", def.attribute || "", (v: string) =>
            transactDoc(activeTab.value, (t) =>
              mutateUpdateDef(t, name, { attribute: v || undefined }),
            ),
          )}
          ${renderFieldRow({
            hasValue: false,
            label: "Reflects",
            prop: "reflects",
            widget: html`
              <sp-checkbox
                class="field-check"
                ?checked=${Boolean(def.reflects)}
                @change=${(e: Event) =>
                  transactDoc(activeTab.value, (t) =>
                    mutateUpdateDef(t, name, {
                      reflects: (e.target as HTMLInputElement).checked || undefined,
                    }),
                  )}
              ></sp-checkbox>
            `,
          })}
          ${signalFieldRow(
            "Deprecated",
            typeof def.deprecated === "string" ? def.deprecated : "",
            (v: string) =>
              transactDoc(activeTab.value, (t) =>
                mutateUpdateDef(t, name, { deprecated: v || undefined }),
              ),
          )}
        `
      : nothing;

    fields = html`
      ${pickerRow(
        "Type",
        ["string", "integer", "number", "boolean", "array", "object"],
        def.type || "string",
        (v: string) => transactDoc(activeTab.value, (t) => mutateUpdateDef(t, name, { type: v })),
      )}
      ${def.type === "string" || !def.type
        ? pickerRow("Format", ["", "image", "date", "color"], def.format || "", (v: string) =>
            transactDoc(activeTab.value, (t) =>
              mutateUpdateDef(t, name, { format: v || undefined }),
            ),
          )
        : nothing}
      ${def.format === "image"
        ? renderFieldRow({
            hasValue: false,
            label: "Default",
            prop: "Default",
            widget: renderMediaPicker("default", defaultVal, (v: string) => {
              transactDoc(activeTab.value, (t) =>
                mutateUpdateDef(t, name, { default: v || undefined }),
              );
            }),
          })
        : signalFieldRow("Default", defaultVal, (v: string) => {
            let parsed: unknown = v;
            if (def.type === "integer") {
              parsed = Math.trunc(Number(v)) || 0;
            } else if (def.type === "number") {
              parsed = Number(v) || 0;
            } else if (def.type === "boolean") {
              parsed = v === "true";
            } else if (def.type === "array" || def.type === "object") {
              try {
                parsed = JSON.parse(v);
              } catch {
                parsed = v;
              }
            }
            transactDoc(activeTab.value, (t) =>
              mutateUpdateDef(t, name, { default: parsed as JsonValue }),
            );
          })}
      ${signalFieldRow("Description", def.description || "", (v: string) =>
        transactDoc(activeTab.value, (t) =>
          mutateUpdateDef(t, name, { description: v || undefined }),
        ),
      )}
      ${cemFields}
    `;
  } else if (cat === "computed") {
    let debounce: ReturnType<typeof setTimeout> | undefined;
    fields = html`
      ${renderFieldRow({
        hasValue: false,
        label: "Expression",
        prop: "expression",
        widget: html`
          <textarea
            class="field-input"
            style="min-height:40px"
            .value=${def.$compute || ""}
            @input=${(e: Event) => {
              clearTimeout(debounce);
              debounce = setTimeout(() => {
                const expr = (e.target as HTMLInputElement).value;
                const depMatches = expr.match(/\$[a-zA-Z_]\w*/g) || [];
                const deps = [...new Set(depMatches)].map((d) => `#/state/${d}`);
                transactDoc(activeTab.value, (t) =>
                  mutateUpdateDef(t, name, { $compute: expr, $deps: deps }),
                );
              }, 500);
            }}
          ></textarea>
        `,
      })}
      ${def.$deps && def.$deps.length > 0
        ? renderFieldRow({
            hasValue: false,
            label: "Dependencies",
            prop: "dependencies",
            widget: html`
              <span class="signal-hint" style="flex:1;max-width:none"
                >${def.$deps.map((d: string) => d.replace("#/state/", "")).join(", ")}</span
              >
            `,
          })
        : nothing}
    `;
  } else if (cat === "data") {
    fields = renderDataSourceFields(S, name, def, textareaRow, pickerRow, ctx);
  } else if (cat === "function") {
    fields = renderFunctionFields(S, name, def, textareaRow, ctx);
  } else if (cat === "expression") {
    const exprNode = def.$expression || { operator: "=", target: null };
    fields = html`
      ${renderExpressionEditor(
        exprNode,
        (newNode: unknown) =>
          transactDoc(activeTab.value, (t) =>
            // Expression editors emit JSON expression nodes.
            mutateUpdateDef(t, name, { $expression: newNode as JsonValue }),
          ),
        {
          allowEventRef: false,
          stateDefs: Object.keys(S.document.state || {}),
        },
      )}
    `;
  }

  return html`${nameField}${fields}`;
}

/** Data source fields for signal editor */
function renderDataSourceFields(
  S: SignalsPanelState,
  name: string,
  def: SignalDef,
  textareaRow: (
    label: string,
    value: string,
    onChange: (value: string) => void,
    opts?: { minHeight?: string; mono?: boolean },
  ) => TemplateResult,
  pickerRow: (
    label: string,
    options: string[],
    currentVal: string,
    onChange: (value: string) => void,
  ) => TemplateResult,
  ctx: SignalsPanelCtx,
) {
  const proto = def.$prototype;

  if (proto === "Request") {
    return html`
      ${signalFieldRow("URL", def.url || "", (v: string) =>
        transactDoc(activeTab.value, (t) => mutateUpdateDef(t, name, { url: v })),
      )}
      ${pickerRow(
        "Method",
        ["GET", "POST", "PUT", "DELETE", "PATCH"],
        def.method || "GET",
        (v: string) => transactDoc(activeTab.value, (t) => mutateUpdateDef(t, name, { method: v })),
      )}
      ${pickerRow("Timing", ["client", "server"], def.timing || "client", (v: string) =>
        transactDoc(activeTab.value, (t) => mutateUpdateDef(t, name, { timing: v })),
      )}
    `;
  }
  if (proto === "LocalStorage" || proto === "SessionStorage") {
    const defaultStr =
      def.default !== undefined && def.default !== null
        ? typeof def.default === "object"
          ? JSON.stringify(def.default, null, 2)
          : String(def.default)
        : "";
    return html`
      ${signalFieldRow("Key", def.key || "", (v: string) =>
        transactDoc(activeTab.value, (t) => mutateUpdateDef(t, name, { key: v })),
      )}
      ${textareaRow("Default", defaultStr, (v: string) => {
        try {
          transactDoc(activeTab.value, (t) => mutateUpdateDef(t, name, { default: JSON.parse(v) }));
        } catch {
          transactDoc(activeTab.value, (t) => mutateUpdateDef(t, name, { default: v }));
        }
      })}
    `;
  }
  if (proto === "IndexedDB") {
    return html`
      ${signalFieldRow("Database", def.database || "", (v: string) =>
        transactDoc(activeTab.value, (t) => mutateUpdateDef(t, name, { database: v })),
      )}
      ${signalFieldRow("Store", def.store || "", (v: string) =>
        transactDoc(activeTab.value, (t) => mutateUpdateDef(t, name, { store: v })),
      )}
      ${signalFieldRow("Version", String(def.version || 1), (v: string) =>
        transactDoc(activeTab.value, (t) =>
          mutateUpdateDef(t, name, { version: Math.trunc(Number(v)) || 1 }),
        ),
      )}
    `;
  }
  if (proto === "Cookie") {
    return html`
      ${signalFieldRow("Cookie", def.name || "", (v: string) =>
        transactDoc(activeTab.value, (t) => mutateUpdateDef(t, name, { name: v })),
      )}
      ${signalFieldRow("Default", String(def.default || ""), (v: string) =>
        transactDoc(activeTab.value, (t) => mutateUpdateDef(t, name, { default: v })),
      )}
    `;
  }
  if (proto === "Set" || proto === "Map" || proto === "FormData") {
    const fieldName = proto === "FormData" ? "fields" : "default";
    const fieldLabel = proto === "FormData" ? "Fields" : "Default";
    const defaultStr =
      def.default !== undefined && def.default !== null
        ? JSON.stringify(def.default, null, 2)
        : proto === "FormData"
          ? JSON.stringify(def.fields || {}, null, 2)
          : "";
    return textareaRow(fieldLabel, defaultStr, (v: string) => {
      try {
        transactDoc(activeTab.value, (t) =>
          mutateUpdateDef(t, name, { [fieldName]: JSON.parse(v) as unknown }),
        );
      } catch {}
    });
  }
  // Schema-driven fallback
  return renderExternalPrototypeEditorTemplate(S, name, def, ctx);
}

/** Function fields for signal editor */
function renderFunctionFields(
  S: SignalsPanelState,
  name: string,
  def: SignalDef,
  _textareaRow: (
    label: string,
    value: string,
    onChange: (value: string) => void,
    opts?: { minHeight?: string; mono?: boolean },
  ) => TemplateResult,
  ctx: SignalsPanelCtx,
) {
  const descriptionField = signalFieldRow("Description", def.description || "", (v: string) =>
    transactDoc(activeTab.value, (t) => mutateUpdateDef(t, name, { description: v || undefined })),
  );

  const bodyField = def.$src
    ? html`
        ${signalFieldRow("Source", def.$src || "", (v: string) =>
          transactDoc(activeTab.value, (t) => mutateUpdateDef(t, name, { $src: v || undefined })),
        )}
        ${signalFieldRow("Export", def.$export || "", (v: string) =>
          transactDoc(activeTab.value, (t) =>
            mutateUpdateDef(t, name, { $export: v || undefined }),
          ),
        )}
      `
    : html`
        <div style="display:flex;align-items:center;gap:4px">
          <span class="field-label" style="flex:1">Body</span>
          <sp-action-button
            size="xs"
            quiet
            title="Open in code editor"
            @click=${() => {
              ctx.updateSession({
                ui: { editingFunction: { defName: name, type: "def" } },
              });
              ctx.renderCanvas();
            }}
          >
            <sp-icon-code slot="icon"></sp-icon-code>
          </sp-action-button>
        </div>
        <textarea
          class="field-input"
          style="min-height:60px;font-family:var(--font-mono);font-size:var(--spectrum-font-size-50, 11px)"
          .value=${def.body || ""}
          @input=${(e: Event) => {
            const v = (e.target as HTMLInputElement).value;
            transactDoc(activeTab.value, (t) => mutateUpdateDef(t, name, { body: v }));
          }}
        ></textarea>
      `;

  return html`
    ${descriptionField} ${renderParameterEditorTemplate(S, name, def, ctx)}
    ${isCustomElementDoc(S) ? renderEmitsEditorTemplate(S, name, def) : nothing} ${bodyField}
  `;
}

// ─── CEM Editors ─────────────────────────────────────────────────────────────

/** Render CEM parameter editor with basic/advanced toggle. */
function renderParameterEditorTemplate(
  _S: SignalsPanelState,
  name: string,
  def: SignalDef,
  ctx: SignalsPanelCtx,
) {
  const params = (def.parameters || []).map((p) => normParam(p));
  const isAdvanced = advancedParamOpen.has(name);

  if (!isAdvanced) {
    // Basic mode: name chips
    return renderFieldRow({
      hasValue: false,
      label: "Parameters",
      prop: "parameters",
      widget: html`
        <div style="display:flex;flex-wrap:wrap;gap:4px;align-items:center">
          ${params.map(
            (p: CemParameter, i: number) => html`
              <span
                style="display:inline-flex;align-items:center;gap:2px;padding:1px 6px;border-radius:var(--radius);background:var(--hover-bg);font-size:var(--spectrum-font-size-50, 11px);font-family:var(--font-mono)"
              >
                ${p.name || "?"}
                <span
                  style="cursor:pointer;opacity:0.5;margin-left:2px"
                  @click=${() => {
                    transactDoc(activeTab.value, (t) =>
                      mutateUpdateDef(t, name, {
                        parameters: params.some((_: unknown, j: number) => j !== i)
                          ? params.filter((_: unknown, j: number) => j !== i)
                          : undefined,
                      }),
                    );
                  }}
                  >×</span
                >
              </span>
            `,
          )}
          <input
            class="field-input"
            style="width:60px;flex:0 0 auto;font-size:var(--spectrum-font-size-50, 11px)"
            placeholder="+"
            @keydown=${(e: KeyboardEvent) => {
              if (e.key === "Enter" && (e.target as HTMLInputElement).value.trim()) {
                transactDoc(activeTab.value, (t) =>
                  mutateUpdateDef(t, name, {
                    parameters: [...params, { name: (e.target as HTMLInputElement).value.trim() }],
                  }),
                );
              }
            }}
          />
        </div>
        <span
          style="font-size:10px;color:var(--fg-dim);cursor:pointer;width:100%;margin-top:2px"
          @click=${() => {
            advancedParamOpen.add(name);
            ctx.renderLeftPanel();
          }}
          >▸ Advanced</span
        >
      `,
    });
  }

  // Advanced mode: full rows
  return renderFieldRow({
    hasValue: false,
    label: "Parameters",
    prop: "parameters",
    widget: html`
      <div style="display:flex;flex-direction:column;gap:4px">
        ${params.map(
          (p: CemParameter, i: number) => html`
            <div style="display:flex;gap:4px;align-items:center">
              <input
                class="field-input"
                .value=${p.name || ""}
                placeholder="name"
                style="flex:1"
                @change=${(e: Event) => {
                  const next = [...params];
                  next[i] = {
                    ...next[i],
                    name: (e.target as HTMLInputElement).value,
                  };
                  transactDoc(activeTab.value, (t) =>
                    mutateUpdateDef(t, name, { parameters: next }),
                  );
                }}
              />
              <input
                class="field-input"
                .value=${cemTypeText(p.type)}
                placeholder="type"
                style="flex:1"
                @change=${(e: Event) => {
                  const next = [...params];
                  const val = (e.target as HTMLInputElement).value;
                  const { type: _t, ...rest } = next[i]!;
                  next[i] = val ? { ...rest, type: { text: val } } : rest;
                  transactDoc(activeTab.value, (t) =>
                    mutateUpdateDef(t, name, { parameters: next }),
                  );
                }}
              />
              <input
                class="field-input"
                .value=${p.description || ""}
                placeholder="desc"
                style="flex:2"
                @change=${(e: Event) => {
                  const next = [...params];
                  const val = (e.target as HTMLInputElement).value;
                  const { description: _d, ...rest } = next[i]!;
                  next[i] = val ? { ...rest, description: val } : rest;
                  transactDoc(activeTab.value, (t) =>
                    mutateUpdateDef(t, name, { parameters: next }),
                  );
                }}
              />
              <input
                type="checkbox"
                title="optional"
                .checked=${Boolean(p.optional)}
                @change=${(e: Event) => {
                  const next = [...params];
                  const { checked } = e.target as HTMLInputElement;
                  const { optional: _o, ...rest } = next[i]!;
                  next[i] = checked ? { ...rest, optional: true } : rest;
                  transactDoc(activeTab.value, (t) =>
                    mutateUpdateDef(t, name, { parameters: next }),
                  );
                }}
              />
              <span
                style="cursor:pointer;opacity:0.5"
                @click=${() => {
                  const next = params.filter((_: unknown, j: number) => j !== i);
                  transactDoc(activeTab.value, (t) =>
                    mutateUpdateDef(t, name, {
                      parameters: next.length > 0 ? next : undefined,
                    }),
                  );
                }}
                >×</span
              >
            </div>
          `,
        )}
        <button
          class="kv-add"
          @click=${() =>
            transactDoc(activeTab.value, (t) =>
              mutateUpdateDef(t, name, {
                parameters: [...params, { name: "" }],
              }),
            )}
        >
          + Add parameter
        </button>
      </div>
      <span
        style="font-size:10px;color:var(--fg-dim);cursor:pointer;width:100%;margin-top:2px"
        @click=${() => {
          advancedParamOpen.delete(name);
          ctx.renderLeftPanel();
        }}
        >▾ Basic</span
      >
    `,
  });
}

/** Render CEM emits editor for function state entries. */
function renderEmitsEditorTemplate(S: SignalsPanelState, name: string, def: SignalDef) {
  const emits = def.emits || ([] as CemEvent[]);
  if (emits.length === 0 && !isCustomElementDoc(S)) {
    return nothing;
  }

  return html`
    <div
      style="font-size:var(--spectrum-font-size-50, 11px);font-weight:600;color:var(--fg-dim);margin:8px 0 4px;text-transform:uppercase;letter-spacing:0.05em"
    >
      Emits
    </div>
    ${emits.map(
      (ev: CemEvent, i: number) => html`
        <div style="display:flex;gap:4px;align-items:center;margin-bottom:4px">
          <input
            class="field-input"
            .value=${ev.name || ""}
            placeholder="event name"
            style="flex:1"
            @change=${(e: Event) => {
              const next = [...emits];
              next[i] = {
                ...next[i],
                name: (e.target as HTMLInputElement).value,
              };
              transactDoc(activeTab.value, (t) => mutateUpdateDef(t, name, { emits: next }));
            }}
          />
          <input
            class="field-input"
            .value=${cemTypeText(ev.type)}
            placeholder="type"
            style="flex:1"
            @change=${(e: Event) => {
              const next = [...emits];
              const val = (e.target as HTMLInputElement).value;
              const { type: _t, ...rest } = next[i]!;
              next[i] = val ? { ...rest, type: { text: val } } : rest;
              transactDoc(activeTab.value, (t) => mutateUpdateDef(t, name, { emits: next }));
            }}
          />
          <input
            class="field-input"
            .value=${ev.description || ""}
            placeholder="description"
            style="flex:2"
            @change=${(e: Event) => {
              const next = [...emits];
              const val = (e.target as HTMLInputElement).value;
              const { description: _d, ...rest } = next[i]!;
              next[i] = val ? { ...rest, description: val } : rest;
              transactDoc(activeTab.value, (t) => mutateUpdateDef(t, name, { emits: next }));
            }}
          />
          <span
            style="cursor:pointer;opacity:0.5"
            @click=${() => {
              transactDoc(activeTab.value, (t) =>
                mutateUpdateDef(t, name, {
                  emits: emits.some((_: unknown, j: number) => j !== i)
                    ? emits.filter((_: unknown, j: number) => j !== i)
                    : undefined,
                }),
              );
            }}
            >×</span
          >
        </div>
      `,
    )}
    <button
      class="kv-add"
      @click=${() =>
        transactDoc(activeTab.value, (t) =>
          mutateUpdateDef(t, name, { emits: [...emits, { name: "" }] }),
        )}
    >
      + Add event
    </button>
  `;
}

// ─── Plugin schema-driven form rendering ────────────────────────────────────

/**
 * Resolve a schema enum value. Handles: - Plain arrays (pass through) - `$ref` objects pointing to
 * `#/$context/contentTypes` (resolves to project content type keys) - `$ref` objects pointing to
 * `#/$context/contentTypes/{@param}/schema/properties` (dependent enum) - Legacy `"$contentTypes"`
 * string sentinel (deprecated)
 *
 * @param {unknown} enumDef
 * @param {Record<string, unknown>} [parentDef] - Parent def for resolving dependent refs
 * @returns {string[] | undefined}
 */
function resolveSchemaEnum(
  enumDef: unknown,
  parentDef?: Record<string, unknown>,
): string[] | undefined {
  if (Array.isArray(enumDef)) {
    return enumDef;
  }
  if (enumDef && typeof enumDef === "object") {
    const ref = (enumDef as Record<string, unknown>).$ref;
    if (ref === "#/$context/contentTypes") {
      return Object.keys(projectState?.projectConfig?.contentTypes ?? {});
    }
    if (typeof ref === "string" && ref.startsWith("#/$context/contentTypes/{@")) {
      const match = ref.match(/#\/\$context\/contentTypes\/\{@(\w+)\}\/schema\/properties/);
      if (match && parentDef) {
        const [, paramName] = match;
        const typeName = parentDef[paramName!] as string | undefined;
        if (typeName) {
          const ct = projectState?.projectConfig?.contentTypes?.[typeName] as
            | Record<string, unknown>
            | undefined;
          const schema = ct?.schema as Record<string, unknown> | undefined;
          const props = schema?.properties as Record<string, unknown> | undefined;
          if (props) {
            return Object.keys(props);
          }
        }
      }
      return undefined;
    }
  }
  if (enumDef === "$contentTypes") {
    return Object.keys(projectState?.projectConfig?.contentTypes ?? {});
  }
  return undefined;
}

/**
 * Render a single inline field within an array-of-objects row. Dispatches by schema type: enum →
 * picker, boolean → switch, number → number-field, else → textfield.
 *
 * @param {string} key
 * @param {Record<string, unknown>} schema
 * @param {unknown} value
 * @param {(val: unknown) => void} onChange
 * @param {Record<string, unknown>} [parentDef] - Parent def for resolving dependent enum refs
 */
/** Parse a numeric field value, returning NaN for blank input (so callers can treat it as unset). */
function parseNumericField(raw: string, integer: boolean): number {
  if (raw.trim() === "") {
    return Number.NaN;
  }
  return integer ? Math.trunc(Number(raw)) : Number(raw);
}

function renderInlineField(
  key: string,
  schema: Record<string, unknown>,
  value: unknown,
  onChange: (val: unknown) => void,
  parentDef?: Record<string, unknown>,
) {
  const enumValues = resolveSchemaEnum(schema.enum, parentDef);

  if (enumValues) {
    return html`<sp-picker
      size="s"
      label=${key}
      value=${value !== undefined ? String(value) : "__none__"}
      @change=${(e: Event) =>
        onChange(
          (e.target as HTMLInputElement).value === "__none__"
            ? undefined
            : (e.target as HTMLInputElement).value,
        )}
    >
      <sp-menu-item value="__none__">—</sp-menu-item>
      ${enumValues.map((v: string) => html`<sp-menu-item value=${v}>${v}</sp-menu-item>`)}
    </sp-picker>`;
  }
  if (schema.type === "boolean") {
    return html`<sp-switch
      size="s"
      ?checked=${Boolean(value)}
      @change=${(e: Event) => onChange((e.target as HTMLInputElement).checked)}
      >${key}</sp-switch
    >`;
  }
  if (schema.type === "integer" || schema.type === "number") {
    return html`<sp-number-field
      size="s"
      label=${key}
      .value=${value !== undefined ? value : nothing}
      step=${schema.type === "integer" ? "1" : nothing}
      @change=${(e: Event) => {
        const parsed = parseNumericField(
          (e.target as HTMLInputElement).value,
          schema.type === "integer",
        );
        onChange(Number.isNaN(parsed) ? undefined : parsed);
      }}
    ></sp-number-field>`;
  }
  return html`<sp-textfield
    size="s"
    label=${key}
    placeholder=${key}
    .value=${value ?? ""}
    @input=${(e: Event) => onChange((e.target as HTMLInputElement).value || undefined)}
  ></sp-textfield>`;
}

/** Render a debounced multiline JSON text field for array/object schema properties. */
function renderJsonTextField(
  currentValue: unknown,
  ps: SchemaProperty,
  name: string,
  prop: string,
) {
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let debounce: ReturnType<typeof setTimeout> | undefined;
  return html`<sp-textfield
    multiline
    size="s"
    style="min-height:40px"
    .value=${currentValue !== undefined ? JSON.stringify(currentValue, null, 2) : ""}
    placeholder=${ps.default !== undefined ? JSON.stringify(ps.default) : nothing}
    @input=${(e: Event) => {
      clearTimeout(debounce);
      debounce = setTimeout(() => {
        try {
          transactDoc(activeTab.value, (t) =>
            mutateUpdateDef(t, name, {
              [prop]: JSON.parse((e.target as HTMLInputElement).value) as unknown,
            }),
          );
        } catch {}
      }, 500);
    }}
  ></sp-textfield>`;
}

/**
 * Render config form fields from a JSON Schema `properties` object. Maps schema types to
 * appropriate form controls.
 */
export function renderSchemaFieldsTemplate(
  schema: JsonSchema | null | undefined,
  def: SignalDef,
  name: string,
  _S: SignalsPanelState,
  ctx: SignalsPanelCtx | null = null,
) {
  if (!schema?.properties) {
    return nothing;
  }

  const required = new Set(schema.required);

  const propertyFields = Object.entries(schema.properties)
    .filter(([prop]) => !STUDIO_RESERVED_KEYS.has(prop))
    .map(([prop, ps]) => {
      const currentValue = def[prop];
      const labelText = prop + (required.has(prop) ? " *" : "");

      let control;
      const enumValues = resolveSchemaEnum(ps.enum, def);
      if (enumValues) {
        control = html`
          <sp-picker
            size="s"
            value=${currentValue !== undefined
              ? String(currentValue)
              : ps.default !== undefined
                ? String(ps.default)
                : "__none__"}
            @change=${(e: Event) =>
              transactDoc(activeTab.value, (t) =>
                mutateUpdateDef(t, name, {
                  [prop]:
                    (e.target as HTMLInputElement).value === "__none__"
                      ? undefined
                      : (e.target as HTMLInputElement).value,
                }),
              )}
          >
            ${!required.has(prop) ? html`<sp-menu-item value="__none__">—</sp-menu-item>` : nothing}
            ${enumValues.map(
              (val: string) => html`<sp-menu-item value=${val}>${val}</sp-menu-item>`,
            )}
          </sp-picker>
        `;
      } else if (ps.type === "boolean") {
        control = html`<sp-checkbox
          ?checked=${currentValue ?? ps.default ?? false}
          @change=${(e: Event) =>
            transactDoc(activeTab.value, (t) =>
              mutateUpdateDef(t, name, {
                [prop]: (e.target as HTMLInputElement).checked,
              }),
            )}
        ></sp-checkbox>`;
      } else if (ps.type === "integer" || ps.type === "number") {
        /** @type {ReturnType<typeof setTimeout> | undefined} */
        let debounce: ReturnType<typeof setTimeout> | undefined;
        control = html`<sp-number-field
          size="s"
          min=${ifDefined(ps.minimum)}
          max=${ifDefined(ps.maximum)}
          step=${ps.type === "integer" ? "1" : nothing}
          .value=${currentValue !== undefined ? currentValue : nothing}
          placeholder=${ps.default != null ? String(ps.default) : nothing}
          @change=${(e: Event) => {
            clearTimeout(debounce);
            debounce = setTimeout(() => {
              const parsed = parseNumericField(
                (e.target as HTMLInputElement).value,
                ps.type === "integer",
              );
              transactDoc(activeTab.value, (t) =>
                mutateUpdateDef(t, name, {
                  [prop]: Number.isNaN(parsed) ? undefined : parsed,
                }),
              );
            }, 400);
          }}
        ></sp-number-field>`;
      } else if (ps.format === "json-schema") {
        const hasValue =
          currentValue && typeof currentValue === "object" && Object.keys(currentValue).length > 0;
        const cv = currentValue as Record<string, unknown>;
        const isRef = hasValue && cv.$ref;
        /** @type {ReturnType<typeof setTimeout> | undefined} */
        let debounce: ReturnType<typeof setTimeout> | undefined;
        control = html`
          <div class="schema-param-editor">
            ${hasValue && !isRef && cv.properties
              ? html`
                  <div style="display:flex;flex-wrap:wrap;gap:3px;margin-bottom:4px">
                    ${Object.entries(cv.properties as Record<string, Record<string, unknown>>).map(
                      ([k, v]) => html`
                        <span
                          style="background:var(--bg);padding:1px 6px;border-radius:var(--radius);font-size:10px;color:var(--fg-dim)"
                          >${k}: ${v.type ?? "any"}</span
                        >
                      `,
                    )}
                  </div>
                `
              : nothing}
            <sp-textfield
              multiline
              size="s"
              style=${styleMap({
                fontFamily: "monospace",
                fontSize: "11px",
                minHeight: hasValue ? "80px" : "40px",
              })}
              .value=${currentValue !== undefined ? JSON.stringify(currentValue, null, 2) : ""}
              placeholder=${ps.description ?? "JSON Schema defining the data shape\u2026"}
              @input=${(e: Event) => {
                clearTimeout(debounce);
                debounce = setTimeout(() => {
                  try {
                    transactDoc(activeTab.value, (t) =>
                      mutateUpdateDef(t, name, {
                        [prop]: JSON.parse((e.target as HTMLInputElement).value) as unknown,
                      }),
                    );
                  } catch {}
                }, 500);
              }}
            ></sp-textfield>
          </div>
        `;
      } else if (ps.type === "array" && ps.items?.type === "object" && ps.items?.properties) {
        // Array of objects with defined schema → multi-row inline form
        const rows: Record<string, unknown>[] = Array.isArray(currentValue)
          ? (currentValue as Record<string, unknown>[])
          : [];
        const itemProps = ps.items.properties as Record<string, Record<string, unknown>>;
        control = html`
          <div class="array-object-field">
            ${rows.map(
              (row: Record<string, unknown>, idx: number) => html`
                <div
                  class="array-object-row"
                  style="display:flex;gap:4px;align-items:center;margin-bottom:4px"
                >
                  ${Object.entries(itemProps).map(([propKey, propSchema]) =>
                    renderInlineField(
                      propKey,
                      propSchema,
                      row[propKey],
                      (val) => {
                        const updated = [...rows];
                        updated[idx] = { ...updated[idx], [propKey]: val };
                        transactDoc(activeTab.value, (t) =>
                          mutateUpdateDef(t, name, { [prop]: updated }),
                        );
                      },
                      def,
                    ),
                  )}
                  <sp-action-button
                    quiet
                    size="s"
                    @click=${() => {
                      const updated = rows.filter((_: unknown, i: number) => i !== idx);
                      transactDoc(activeTab.value, (t) =>
                        mutateUpdateDef(t, name, {
                          [prop]: updated.length > 0 ? updated : undefined,
                        }),
                      );
                      ctx?.renderLeftPanel();
                    }}
                  >
                    <sp-icon-delete slot="icon"></sp-icon-delete>
                  </sp-action-button>
                </div>
              `,
            )}
            <sp-action-button
              quiet
              size="s"
              @click=${(e: Event) => {
                e.stopPropagation();
                const newRow: Record<string, unknown> = {};
                for (const [k, v] of Object.entries(itemProps)) {
                  if ((v as Record<string, unknown>).default !== undefined) {
                    newRow[k] = (v as Record<string, unknown>).default;
                  }
                }
                transactDoc(activeTab.value, (t) =>
                  mutateUpdateDef(t, name, { [prop]: [...rows, newRow] }),
                );
                ctx?.renderLeftPanel();
              }}
              >+ Add</sp-action-button
            >
          </div>
        `;
      } else if (ps.type === "array" || ps.type === "object") {
        control = renderJsonTextField(currentValue, ps, name, prop);
      } else {
        /** @type {ReturnType<typeof setTimeout> | undefined} */
        let debounce: ReturnType<typeof setTimeout> | undefined;
        const ph = ps.default !== undefined ? String(ps.default) : (ps.examples?.[0] ?? "");
        control = html`<sp-textfield
          size="s"
          .value=${currentValue ?? ""}
          placeholder=${ph || nothing}
          title=${ps.description || nothing}
          @input=${(e: Event) => {
            clearTimeout(debounce);
            debounce = setTimeout(
              () =>
                transactDoc(activeTab.value, (t) =>
                  mutateUpdateDef(t, name, {
                    [prop]: (e.target as HTMLInputElement).value || undefined,
                  }),
                ),
              400,
            );
          }}
        ></sp-textfield>`;
      }

      return renderFieldRow({
        hasValue: false,
        label: labelText,
        prop: ps.name || prop,
        widget: control,
      });
    });

  return html`${propertyFields}`;
}

/**
 * Render editor fields for an external $prototype + $src plugin. Shows $src/$export inputs plus
 * schema-driven config fields.
 */
export function renderExternalPrototypeEditorTemplate(
  S: SignalsPanelState,
  name: string,
  def: SignalDef,
  ctx: SignalsPanelCtx,
) {
  // Schema-driven config fields (async with cache)
  let schemaContent: TemplateResult | typeof nothing = nothing;
  const importedPath = def.$prototype
    ? projectState?.projectConfig?.imports?.[def.$prototype]
    : null;
  const resolvedSrc = def.$src || importedPath;
  if (resolvedSrc && def.$prototype) {
    const cacheKey = `${resolvedSrc}::${def.$prototype}`;
    if (pluginSchemaCache.has(cacheKey)) {
      const schema = pluginSchemaCache.get(cacheKey);
      if (schema) {
        schemaContent = html`
          ${schema.description
            ? html`<div class="signal-hint" style="padding:4px 0 8px">${schema.description}</div>`
            : nothing}
          ${renderSchemaFieldsTemplate(schema as JsonSchema, def, name, S, ctx)}
        `;
      }
    } else {
      // Trigger async load — will re-render when cached
      schemaContent = html`<div
        style="padding:4px 0;font-size:var(--spectrum-font-size-50, 11px);color:var(--fg-dim);font-style:italic"
      >
        Loading schema…
      </div>`;
      void fetchPluginSchema(def, {
        ...(S.documentPath != null && { documentPath: S.documentPath }),
      }).then((schema) => {
        if (schema) {
          ctx.renderLeftPanel();
        }
      });
    }
  }

  return html`
    ${importedPath
      ? html`<div
          class="signal-hint"
          style="padding:4px 0 2px;font-size:var(--spectrum-font-size-50, 11px);color:var(--fg-dim)"
        >
          ${def.$prototype}
        </div>`
      : html`
          ${signalFieldRow("Source", def.$src || "", (v: string) => {
            transactDoc(activeTab.value, (t) => mutateUpdateDef(t, name, { $src: v || undefined }));
            pluginSchemaCache.delete(`${v}::${def.$prototype}`);
          })}
          ${signalFieldRow("Prototype", def.$prototype || "", (v: string) => {
            transactDoc(activeTab.value, (t) =>
              mutateUpdateDef(t, name, { $prototype: v || undefined }),
            );
            pluginSchemaCache.delete(`${def.$src}::${v}`);
          })}
        `}
    ${def.$export
      ? signalFieldRow("Export", def.$export || "", (v: string) =>
          transactDoc(activeTab.value, (t) =>
            mutateUpdateDef(t, name, { $export: v || undefined }),
          ),
        )
      : nothing}
    ${schemaContent}
  `;
}
