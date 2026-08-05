/// <reference lib="dom" />
/**
 * Signals panel — signal/def helpers, signals template, CEM editors, plugin schema forms.
 *
 * Extracted from studio.js to reduce file size.
 */

import { html, nothing } from "lit-html";
import { classMap } from "lit-html/directives/class-map.js";
import { dynamicRouteParams } from "../page-params";
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
import { renderEmptyState } from "./empty-state";
import { bindableSignalNames } from "./properties-panel";
import { registerPanel } from "./panel-registry";
import { renderStatementEditor } from "./statement-editor";
import { livePreviewExpression } from "../services/live-preview";
import { renderMediaPicker } from "../ui/media-picker";
import { renderOnly, updateSession } from "../store";
import { renderForm } from "../ui/schema-form";
import { resolveContextPointer } from "../services/context-resolver";
import type { JsonSchema } from "../ui/schema-form";
import type { TabUi } from "../tabs/tab";
import type {
  CemEvent,
  CemParameter,
  JxMutableNode,
  JxStatement,
  JxStateDefinition,
} from "@jxsuite/schema/types";
import { fetchPluginSchema, pluginSchemaCache } from "../services/code-services";
import { getExtensions, loadExtensions } from "../format/format-host";
import { argsSchema, optionalStringArg, stringArg, stringProperty } from "../commands/command-args";
import type { TemplateResult } from "lit-html";
import type { AnyCommand, CommandRegistry } from "../commands/registry";

interface SignalsPanelState {
  document: JxMutableNode;
  ui?: TabUi | Record<string, unknown>;
  mode?: string;
  selection?: (string | number)[][];
  canvas?: Record<string, unknown>;
  _collapsedSignalCats?: Set<string>;
  documentPath?: string | null | undefined;
}

interface SignalsPanelCtx {
  renderLeftPanel: () => void;
  renderCanvas: () => void;
  updateSession: (patch: Record<string, unknown>) => void;
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
  body?: string | unknown[];
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
 * Extension-manifest state classes for the add-state picker: plain `$prototype` targets (no
 * admission blocks) across the enabled extensions, each with its `$studio.stateDefaults` hint
 * (specs/extensions.md §10). Manifest classes need no `$src` — the registry resolves them.
 */
export function extensionStateClasses(): {
  name: string;
  stateDefaults?: Record<string, unknown>;
}[] {
  const out: { name: string; stateDefaults?: Record<string, unknown> }[] = [];
  for (const ext of getExtensions()) {
    for (const cls of ext.classes ?? []) {
      if (cls.state) {
        out.push({
          name: cls.name,
          ...(cls.stateDefaults === undefined ? {} : { stateDefaults: cls.stateDefaults }),
        });
      }
    }
  }
  return out;
}

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
    if (Array.isArray(def.body)) {
      return `${def.body.length} statement${def.body.length === 1 ? "" : "s"}`;
    }
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
 * Add a def from one of the built-in templates under a free name, and expand it for editing. Shared
 * by the "+ Add…" picker and the panel's empty state, so both create the same thing.
 */
function addTemplateDef(type: string, S: SignalsPanelState, ctx: SignalsPanelCtx) {
  const template = DEF_TEMPLATES[type];
  if (!template) {
    return;
  }
  const nameBase = type === "function" ? "newFunction" : "$newSignal";
  let n = nameBase;
  let i = 1;
  while (S.document.state && S.document.state[n]) {
    n = nameBase + i;
    i += 1;
  }
  transactDoc(activeTab.value, (t) =>
    mutateAddDef(t, n, structuredClone(template) as Record<string, JsonValue>),
  );
  selectSignal(n);
  ctx.renderLeftPanel();
}

/**
 * @param {SignalsPanelState} S
 * @param {SignalsPanelCtx} ctx
 */
export function renderSignalsTemplate(S: SignalsPanelState, ctx: SignalsPanelCtx) {
  const defs = S.document.state || {};
  const entries = Object.entries(defs);

  // Warm the extensions payload so manifest state classes appear in the add picker (the panel
  // Re-renders constantly; loadExtensions memoizes, so this is a one-time fetch per project).
  void loadExtensions();

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
                  selectSignal(isExpanded ? null : name);
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
              ${
                isExpanded
                  ? html`<div class="signal-editor">
                      ${renderSignalEditorTemplate(S, name, def, ctx)}
                    </div>`
                  : nothing
              }
            `;
          })}
        </sp-accordion-item>
      `,
    );

  return html`
    <div class="signals-panel">
      <sp-accordion allow-multiple size="s"> ${catTemplates} </sp-accordion>
      ${
        entries.length === 0
          ? renderEmptyState({
              actions: [{ label: "Add a value", run: () => addTemplateDef("state", S, ctx) }],
              message:
                "Data lives here — values this page can read, compute or fetch, " +
                "ready to bind to any element.",
            })
          : nothing
      }
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

            // Extension-manifest state classes ("ext:Session"): no $src needed — the registry
            // Resolves them; the descriptor's stateDefaults seed the def (e.g. timing "client").
            if (type.startsWith("ext:")) {
              const protoName = type.slice(4);
              const cls = extensionStateClasses().find((c) => c.name === protoName);
              let n = `$${protoName.charAt(0).toLowerCase()}${protoName.slice(1)}`;
              let i = 1;
              const base = n;
              while (S.document.state && S.document.state[n]) {
                n = base + i;
                i += 1;
              }
              transactDoc(activeTab.value, (t) =>
                mutateAddDef(t, n, {
                  $prototype: protoName,
                  ...cls?.stateDefaults,
                } as Record<string, JsonValue>),
              );
              selectSignal(n);
              ctx.renderLeftPanel();
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
              selectSignal(n);
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

            addTemplateDef(type, S, ctx);
          }}
        >
          <sp-menu-item value="state">Value</sp-menu-item>
          <sp-menu-item value="computed">Computed</sp-menu-item>
          <sp-menu-divider></sp-menu-divider>
          <sp-menu-item value="request">Fetch from a URL</sp-menu-item>
          <sp-menu-item value="localStorage">LocalStorage</sp-menu-item>
          <sp-menu-item value="sessionStorage">SessionStorage</sp-menu-item>
          <sp-menu-item value="indexedDB">IndexedDB</sp-menu-item>
          <sp-menu-item value="cookie">Cookie</sp-menu-item>
          <sp-menu-item value="set">Set</sp-menu-item>
          <sp-menu-item value="map">Map</sp-menu-item>
          <sp-menu-item value="formData">FormData</sp-menu-item>
          <sp-menu-item value="external">From a module…</sp-menu-item>
          ${
            projectState?.projectConfig?.imports
              ? html`<sp-menu-divider></sp-menu-divider>${Object.keys(
                    projectState.projectConfig.imports,
                  ).map(
                    (k: string) => html`<sp-menu-item value="import:${k}">${k}</sp-menu-item>`,
                  )}`
              : nothing
          }
          ${
            extensionStateClasses().length > 0
              ? html`<sp-menu-divider></sp-menu-divider>${extensionStateClasses().map(
                    (cls) => html`<sp-menu-item value="ext:${cls.name}">${cls.name}</sp-menu-item>`,
                  )}`
              : nothing
          }
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
      selectSignal(v);
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
      ${
        def.type === "string" || !def.type
          ? pickerRow("Format", ["", "image", "date", "color"], def.format || "", (v: string) =>
              transactDoc(activeTab.value, (t) =>
                mutateUpdateDef(t, name, { format: v || undefined }),
              ),
            )
          : nothing
      }
      ${
        def.format === "image"
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
            })
      }
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
      ${
        def.$deps && def.$deps.length > 0
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
          : nothing
      }
    `;
  } else if (cat === "data") {
    fields = renderDataSourceFields(S, name, def, textareaRow, pickerRow, ctx);
  } else if (cat === "function") {
    fields = renderFunctionFields(S, name, def, textareaRow, ctx);
  } else if (cat === "expression") {
    const exprNode = def.$expression || { operator: "=", target: null };
    fields = html`
      <div style="display:flex;align-items:center;gap:4px">
        <span class="field-label" style="flex:1">Expression</span>
        <sp-action-button
          size="xs"
          quiet
          title="Open in formula workspace"
          @click=${() => {
            ctx.updateSession({
              ui: { editingFormula: { defName: name, type: "def" } },
            });
            ctx.renderCanvas();
          }}
        >
          <sp-icon-full-screen slot="icon"></sp-icon-full-screen>
        </sp-action-button>
      </div>
      ${renderExpressionEditor(
        exprNode,
        (newNode: unknown) =>
          transactDoc(activeTab.value, (t) =>
            // Expression editors emit JSON expression nodes.
            mutateUpdateDef(t, name, { $expression: newNode as JsonValue }),
          ),
        {
          allowEventRef: false,
          // Live-context evaluation in the canvas iframe, snapshot fallback (M6). The signals
          // Panel lives in the left panel — re-render it when a fresh live result lands.
          preview: livePreviewExpression(activeTab.value, `def:${name}`, exprNode, null, () =>
            renderOnly("leftPanel"),
          ),
          onInsertDef: (defName, vendored) =>
            transactDoc(activeTab.value, (t) =>
              mutateAddDef(t, defName, vendored as Record<string, JsonValue>),
            ),
          stateDefs: Object.keys(S.document.state || {}),
          stateEntries: S.document.state || {},
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

  // Structured bodies (spec §20) are a body MODE of the function category, not a new entity:
  // "Statements" renders the statement-card editor over `body: JxStatement[]`; "Code" is the
  // Textarea/Monaco path over `body: string`. Switching modes replaces the body with the other
  // Representation's empty seed — an explicit mode change, nothing is converted.
  const bodyIsStatements = Array.isArray(def.body);
  const bodyModeToggle = html`
    <sp-action-group size="s" compact class="body-mode-toggle">
      <sp-action-button
        size="s"
        class="body-mode-statements"
        ?selected=${bodyIsStatements}
        @click=${() => {
          if (!bodyIsStatements) {
            transactDoc(activeTab.value, (t) => mutateUpdateDef(t, name, { body: [] }));
            ctx.renderLeftPanel();
          }
        }}
      >
        Statements
      </sp-action-button>
      <sp-action-button
        size="s"
        class="body-mode-code"
        ?selected=${!bodyIsStatements}
        @click=${() => {
          if (bodyIsStatements) {
            transactDoc(activeTab.value, (t) => mutateUpdateDef(t, name, { body: "" }));
            ctx.renderLeftPanel();
          }
        }}
      >
        Code
      </sp-action-button>
    </sp-action-group>
  `;

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
          ${bodyModeToggle}
          ${
            bodyIsStatements
              ? nothing
              : html`
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
                `
          }
        </div>
        ${
          bodyIsStatements
            ? renderStatementEditor(
                def.body as JxStatement[],
                (next) => {
                  transactDoc(activeTab.value, (t) =>
                    mutateUpdateDef(t, name, { body: next as unknown as JsonValue }),
                  );
                  ctx.renderLeftPanel();
                },
                {
                  allowEventRef: true,
                  emits: def.emits ?? [],
                  stateDefs: Object.keys(S.document.state || {}),
                  stateEntries: S.document.state || {},
                },
              )
            : html`
                <textarea
                  class="field-input"
                  style="min-height:60px;font-family:var(--font-mono);font-size:var(--spectrum-font-size-50, 11px)"
                  .value=${typeof def.body === "string" ? def.body : ""}
                  @input=${(e: Event) => {
                    const v = (e.target as HTMLInputElement).value;
                    transactDoc(activeTab.value, (t) => mutateUpdateDef(t, name, { body: v }));
                  }}
                ></textarea>
              `
        }
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
 * Resolve a schema context pointer for signal config forms — a thin wrapper over the generic
 * `resolveContextPointer` making the content-type roots always-present (a missing section resolves
 * to `{}` → empty choices rather than a plain textfield): the parser's real descriptors point at
 * the `#/$context/content` root, while the deprecated `"$contentTypes"` string sentinel and the
 * legacy `#/$context/contentTypes` root keep resolving bit-for-bit for old class descriptors.
 *
 * @param {string} pointer
 * @param {Record<string, unknown>} [scope] - Parent def for `{@param}` substitution
 * @returns {unknown}
 */
function resolveSignalsContextPointer(pointer: string, scope?: Record<string, unknown>): unknown {
  if (pointer === "#/$context/content") {
    return projectState?.projectConfig?.content ?? {};
  }
  if (pointer === "$contentTypes" || pointer === "#/$context/contentTypes") {
    return projectState?.projectConfig?.contentTypes ?? {};
  }
  return resolveContextPointer(pointer, {
    projectConfig: (projectState?.projectConfig ?? {}) as Record<string, unknown>,
    ...(scope !== undefined && { scope }),
  });
}

/**
 * Render config form fields from a JSON Schema `properties` object — a thin wrapper over the shared
 * schema-form engine. Skips studio-reserved keys, resolves enum/context refs against the project
 * config, and commits every patch through transactDoc/mutateUpdateDef.
 */
export function renderSchemaFieldsTemplate(
  schema: JsonSchema | null | undefined,
  def: SignalDef,
  name: string,
  S: SignalsPanelState,
  ctx: SignalsPanelCtx | null = null,
) {
  if (!schema?.properties) {
    return nothing;
  }

  const properties = Object.fromEntries(
    Object.entries(schema.properties).filter(([prop]) => !STUDIO_RESERVED_KEYS.has(prop)),
  );

  return renderForm({ ...schema, properties }, def as Record<string, unknown>, {
    context: {
      fieldKeyPrefix: name,
      params: dynamicRouteParams(S.documentPath),
      resolvePointer: resolveSignalsContextPointer,
      // A config value may point at any signal but this one — a def that reads itself is a cycle.
      signals: bindableSignalNames(S.document).filter((signal) => signal !== name),
    },
    onChange: (patch) => transactDoc(activeTab.value, (t) => mutateUpdateDef(t, name, patch)),
    ...(ctx && { rerender: () => ctx.renderLeftPanel() }),
  });
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
          ${
            schema.description
              ? html`<div class="signal-hint" style="padding:4px 0 8px">${schema.description}</div>`
              : nothing
          }
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
    ${
      importedPath
        ? html`<div
            class="signal-hint"
            style="padding:4px 0 2px;font-size:var(--spectrum-font-size-50, 11px);color:var(--fg-dim)"
          >
            ${def.$prototype}
          </div>`
        : html`
            ${signalFieldRow("Source", def.$src || "", (v: string) => {
              transactDoc(activeTab.value, (t) =>
                mutateUpdateDef(t, name, { $src: v || undefined }),
              );
              pluginSchemaCache.delete(`${v}::${def.$prototype}`);
            })}
            ${signalFieldRow("Kind", def.$prototype || "", (v: string) => {
              transactDoc(activeTab.value, (t) =>
                mutateUpdateDef(t, name, { $prototype: v || undefined }),
              );
              pluginSchemaCache.delete(`${def.$src}::${v}`);
            })}
          `
    }
    ${
      def.$export
        ? signalFieldRow("Export", def.$export || "", (v: string) =>
            transactDoc(activeTab.value, (t) =>
              mutateUpdateDef(t, name, { $export: v || undefined }),
            ),
          )
        : nothing
    }
    ${schemaContent}
  `;
}

// ─── Commands ─────────────────────────────────────────────────────────────────

/** Which signal's editor is expanded, or `null`. Exported for the command's idempotence and tests. */
export function selectedSignal(): string | null {
  return expandedSignal;
}

/**
 * Expand one signal's editor (or collapse all with `null`).
 *
 * One writer for a field seven call sites used to assign directly, which is what makes
 * `state.selectSignal` and the row's own click the same action rather than two that agree by
 * coincidence.
 */
export function selectSignal(name: string | null): void {
  expandedSignal = name;
}

/** The state entries the open document defines. */
function definedSignalNames(): string[] {
  return Object.keys(activeTab.value?.doc.document?.state ?? {});
}

/** What the State panel's verbs need that this module does not own. */
export interface SignalsCommandDeps {
  /** Repaint the Navigator — `left-panel.ts`'s `render`. */
  renderLeftPanel: () => void;
  /** Repaint the canvas, which is what the formula workspace takes over. */
  renderCanvas: () => void;
}

/**
 * The State panel's verbs — select a signal, and open its formula full-screen.
 *
 * Both used to be XPath presses matching the row's RENDERED NAME, which plan §13's R1 forbids
 * outright: a panel that starts eliding long names, or grouping differently, breaks a shot by
 * improving the app. The document defines these names, so the document is what validates them.
 *
 * `formula.openWorkspace` defaults its target to the selected signal — the button it replaces is
 * rendered inside that signal's own editor, so "the one that is open" is what a reader means. It
 * REFUSES a signal with no `$expression`: the workspace edits an expression tree, and opening it
 * over a plain state entry used to paint an empty canvas takeover.
 *
 * @param {SignalsCommandDeps} deps
 * @returns {AnyCommand[]}
 */
export function signalsCommands(deps: SignalsCommandDeps): AnyCommand[] {
  /** The named entry, or a refusal listing what the document does define. */
  function requireDef(commandId: string, name: string): SignalDef {
    const defs = (activeTab.value?.doc.document?.state ?? {}) as Record<string, SignalDef>;
    const def = defs[name];
    if (!def) {
      const defined = definedSignalNames();
      throw new RangeError(
        `command "${commandId}" argument "name": "${name}" is not a state entry this document ` +
          `defines — it defines: ${defined.length > 0 ? defined.join(", ") : "nothing"}`,
      );
    }
    return def;
  }

  return [
    {
      args: argsSchema({
        name: stringProperty("The state entry's name, as the document defines it."),
      }),
      category: "Document",
      id: "state.selectSignal",
      level: "document",
      menus: ["palette"],
      group: "5_data",
      requires: "an open document that defines state",
      when: (ctx) => ctx.document.open,
      run: (_commandCtx, args) => {
        const name = stringArg("state.selectSignal", args, "name");
        requireDef("state.selectSignal", name);
        selectSignal(name);
        deps.renderLeftPanel();
      },
      title: "Select State Entry",
    },
    {
      args: {
        additionalProperties: false,
        properties: {
          defName: stringProperty(
            "The state entry whose $expression to edit. Defaults to the selected one.",
          ),
        },
        required: [],
        type: "object",
      },
      category: "Document",
      id: "formula.openWorkspace",
      level: "document",
      menus: ["palette"],
      group: "5_data",
      requires: "a selected state entry that holds a formula",
      when: (ctx) => ctx.document.open,
      run: (_commandCtx, args) => {
        const named = optionalStringArg("formula.openWorkspace", args, "defName");
        const defName = named ?? expandedSignal;
        if (defName === null) {
          throw new RangeError(
            `command "formula.openWorkspace" needs a target: pass "defName", or select a state ` +
              `entry first with state.selectSignal`,
          );
        }
        const def = requireDef("formula.openWorkspace", defName);
        if (!def.$expression) {
          throw new RangeError(
            `command "formula.openWorkspace" argument "defName": "${defName}" holds no ` +
              `$expression — the workspace edits formulas, and this entry is not one`,
          );
        }
        // The workspace reads its target off the tab; `renderCanvas` is what performs the takeover.
        const tab = activeTab.value;
        if (tab) {
          tab.session.ui.editingFormula = { defName, type: "def" };
        }
        deps.renderCanvas();
      },
      title: "Open Formula Workspace",
    },
  ];
}

/**
 * Register the State panel's verbs.
 *
 * @param {CommandRegistry} registry
 * @param {SignalsCommandDeps} deps
 */
export function registerSignalsCommands(registry: CommandRegistry, deps: SignalsCommandDeps): void {
  registry.registerAll(signalsCommands(deps));
}

/**
 * Contribute the State panel — **off the rail** (`rail: false`).
 *
 * `level: "document"`: it writes the open document's `state` block. §3.2's DOCUMENT group is
 * Outline · Page · Data · Packages, and §11.2 folds this panel's editing into Data ("definitions +
 * live values in one row"). That merge is not this change, so the record keeps its id, its region
 * and its command reachability and gives up the rail button rather than pushing the group to five.
 */
export function registerStatePanel(): void {
  registerPanel({
    id: "state",
    title: "State",
    level: "document",
    dock: "navigator",
    icon: "sp-icon-brackets",
    rail: false,
    requiresDocument: "Open a page to give it data — values it can read, compute or fetch.",
    render: (ctx) =>
      ctx.deps.renderSignalsTemplate(ctx.doc as SignalsPanelState, {
        renderCanvas: ctx.deps.renderCanvas,
        renderLeftPanel: ctx.rerender,
        updateSession,
      }),
  });
}
