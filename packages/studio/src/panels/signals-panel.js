/**
 * Signals panel — signal/def helpers, signals template, CEM editors, plugin schema forms.
 *
 * Extracted from studio.js to reduce file size.
 */

import { html, nothing } from "lit-html";
import { classMap } from "lit-html/directives/class-map.js";
import { ifDefined } from "lit-html/directives/if-defined.js";
import { styleMap } from "lit-html/directives/style-map.js";
import { activeTab } from "../workspace/workspace.js";
import {
  transactDoc,
  mutateUpdateDef,
  mutateAddDef,
  mutateRemoveDef,
  mutateRenameDef,
} from "../tabs/transact.js";
import { renderFieldRow } from "../ui/field-row.js";
import { renderMediaPicker } from "../ui/media-picker.js";
import { fetchPluginSchema, pluginSchemaCache } from "../services/code-services.js";

/**
 * @typedef {{
 *   document: JxMutableNode;
 *   ui?: Record<string, unknown>;
 *   mode?: string;
 *   selection?: (string | number)[] | null;
 *   canvas?: Record<string, unknown>;
 *   _collapsedSignalCats?: Set<string>;
 *   documentPath?: string | null;
 * }} SignalsPanelState
 *
 * @typedef {{ renderLeftPanel(): void; renderCanvas(): void; updateSession(patch: object): void }} SignalsPanelCtx
 *
 * @typedef {Record<string, unknown> & {
 *   $prototype?: string;
 *   $compute?: string;
 *   $deps?: string[];
 *   $handler?: unknown;
 *   $src?: string;
 *   $export?: string;
 *   type?: string;
 *   default?: unknown;
 *   description?: string;
 *   attribute?: string;
 *   reflects?: boolean;
 *   deprecated?: string | boolean;
 *   format?: string;
 *   url?: string;
 *   method?: string;
 *   timing?: string;
 *   key?: string;
 *   database?: string;
 *   store?: string;
 *   version?: number;
 *   name?: string;
 *   body?: string;
 *   parameters?: Record<string, unknown>[];
 *   emits?: Record<string, unknown>[];
 *   fields?: unknown;
 * }} SignalDef
 *
 * @typedef {{ name: string; type?: { text?: string }; description?: string; optional?: boolean }} CemParameter
 *
 * @typedef {{ name: string; type?: { text?: string }; description?: string }} CemEvent
 *
 * @typedef {{
 *   type?: string;
 *   properties?: Record<string, SchemaProperty>;
 *   required?: string[];
 *   description?: string;
 * }} JsonSchema
 *
 * @typedef {{
 *   type?: string;
 *   enum?: string[];
 *   default?: unknown;
 *   format?: string;
 *   minimum?: number;
 *   maximum?: number;
 *   description?: string;
 *   examples?: string[];
 *   name?: string;
 * }} SchemaProperty
 */

// ─── Module-local state ─────────────────────────────────────────────────────

/** Expanded signal editor state (persists across renders). */
/** @type {string | null} */
let expandedSignal = null;

/** Track which functions have the advanced param editor open. */
const advancedParamOpen = new Set();

/** Default templates for creating new signal definitions. */
const DEF_TEMPLATES = /** @type {Record<string, SignalDef>} */ ({
  state: { type: "string", default: "" },
  computed: { $compute: "", $deps: [] },
  request: { $prototype: "Request", url: "", method: "GET", timing: "client" },
  localStorage: { $prototype: "LocalStorage", key: "", default: null },
  sessionStorage: { $prototype: "SessionStorage", key: "", default: null },
  indexedDB: { $prototype: "IndexedDB", database: "", store: "", version: 1 },
  cookie: { $prototype: "Cookie", name: "", default: "" },
  set: { $prototype: "Set", default: [] },
  map: { $prototype: "Map", default: {} },
  formData: { $prototype: "FormData", fields: {} },
  function: { $prototype: "Function", body: "", parameters: [] },
  external: { $prototype: "", $src: "" },
});

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
 * Classify a state entry into a category string.
 *
 * @param {SignalDef | unknown} def
 */
export function defCategory(def) {
  if (!def) return "state";
  const d = /** @type {SignalDef} */ (def);
  if (d.$handler || d.$prototype === "Function") return "function";
  if (d.$compute) return "computed";
  if (d.$prototype) return "data";
  return "state";
}

/**
 * Badge label for a def category.
 *
 * @param {SignalDef | unknown} def
 */
export function defBadgeLabel(def) {
  if (!def) return "S";
  const d = /** @type {SignalDef} */ (def);
  if (d.$handler || d.$prototype === "Function") return "F";
  if (d.$compute) return "C";
  if (d.$prototype) return d.$prototype.charAt(0);
  return "S";
}

/**
 * Hint text for a signal row.
 *
 * @param {string} name
 * @param {SignalDef | null | undefined} def
 */
export function defHint(name, def) {
  if (!def) return "";
  if (def.$prototype === "Function") {
    if (def.body) return def.body.length > 20 ? def.body.slice(0, 20) + "..." : def.body;
    if (def.$src) return def.$src;
    return "function";
  }
  if (def.$handler) return "handler (legacy)";
  if (def.$compute)
    return "=" + (def.$compute.length > 20 ? def.$compute.slice(0, 20) + "..." : def.$compute);
  if (def.$prototype === "Request")
    return (def.method || "GET") + " " + (def.url || "").slice(0, 20);
  if (def.$prototype === "LocalStorage" || def.$prototype === "SessionStorage")
    return def.key || "";
  if (def.$prototype === "IndexedDB") return def.database || "";
  if (def.$prototype === "Cookie") return def.name || "";
  if (def.$prototype) return def.$prototype;
  if (def.attribute) return `[${def.attribute}] ${def.type || ""}`;
  return def.type || "";
}

/**
 * Whether the current document defines a custom element (hyphenated tagName).
 *
 * @param {SignalsPanelState} S
 */
export function isCustomElementDoc(S) {
  return (S.document.tagName || "").includes("-");
}

/**
 * Recursively collect CSS `part` attributes from the document tree.
 *
 * @param {JxMutableNode | null | undefined} node
 * @param {{ name: string; tag: string }[]} [parts]
 */
export function collectCssParts(node, parts = []) {
  if (node?.attributes?.part)
    parts.push({ name: node.attributes.part, tag: node.tagName || "div" });
  if (Array.isArray(node?.children))
    node.children.forEach((c) => {
      if (typeof c !== "string") collectCssParts(c, parts);
    });
  return parts;
}

/**
 * Resolve a $ref value to a display string using signal defaults. Used by the canvas to show real
 * values instead of raw refs.
 *
 * @param {unknown} value
 * @param {Record<string, SignalDef> | null | undefined} defs
 */
export function resolveDefaultForCanvas(value, defs) {
  if (!value || typeof value !== "object" || !(/** @type {Record<string, unknown>} */ (value).$ref))
    return value;
  const ref = /** @type {string} */ (/** @type {Record<string, unknown>} */ (value).$ref);
  /** @type {string | undefined} */
  let defName;
  if (ref.startsWith("#/state/")) defName = ref.slice(8);
  else if (ref.startsWith("$")) defName = ref;
  else return `{${ref}}`;

  const def = defs?.[defName];
  if (!def) return `{${defName}}`;

  // State signal → use default
  if (!def.$compute && !def.$prototype) {
    if (def.default !== undefined && def.default !== null) {
      if (typeof def.default === "object") return JSON.stringify(def.default);
      return String(def.default);
    }
    return "";
  }
  // Computed → expression indicator
  if (def.$compute) return `\u0192(${defName})`;
  // Request → URL hint
  if (def.$prototype === "Request") return `\u27F3 ${def.url || "fetch"}`;
  // Storage → use default or key
  if (def.$prototype === "LocalStorage" || def.$prototype === "SessionStorage") {
    if (def.default !== undefined && def.default !== null) {
      if (typeof def.default === "object") return JSON.stringify(def.default);
      return String(def.default);
    }
    return `[${def.key || "storage"}]`;
  }
  if (def.$prototype) return `{${def.$prototype}}`;
  return `{${defName}}`;
}

// ─── Simple field row ────────────────────────────────────────────────────────

/** Simple field row for signal editors — vertical stacked layout. */
export function signalFieldRow(
  /** @type {string} */ label,
  /** @type {string} */ value,
  /** @type {(value: string) => void} */ onChange,
) {
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let debounce;
  return renderFieldRow({
    prop: label,
    label,
    hasValue: false,
    widget: html`
      <sp-textfield
        size="s"
        value=${value}
        @input=${(/** @type {Event} */ e) => {
          clearTimeout(debounce);
          debounce = setTimeout(
            () => onChange(/** @type {HTMLInputElement} */ (e.target).value),
            400,
          );
        }}
      ></sp-textfield>
    `,
  });
}

/** Normalize a parameter entry to a CEM object. */
export function normParam(/** @type {string | Record<string, unknown>} */ p) {
  return typeof p === "string" ? { name: p } : /** @type {CemParameter} */ (p);
}

// ─── Left panel: Signals ─────────────────────────────────────────────────────

/**
 * @param {SignalsPanelState} S
 * @param {SignalsPanelCtx} ctx
 */
export function renderSignalsTemplate(S, ctx) {
  const defs = S.document.state || {};
  const entries = Object.entries(defs);

  // Group by category
  const groups = /** @type {Record<string, [string, SignalDef][]>} */ ({
    state: [],
    computed: [],
    data: [],
    function: [],
  });
  for (const [name, def] of entries) {
    groups[defCategory(def)].push([name, def]);
  }

  const categories = [
    { key: "state", label: "State", items: groups.state },
    { key: "computed", label: "Computed", items: groups.computed },
    { key: "data", label: "Data", items: groups.data },
    { key: "function", label: "Functions", items: groups.function },
  ];

  const collapsedCats = S._collapsedSignalCats || (S._collapsedSignalCats = new Set());

  const catTemplates = categories
    .filter((c) => c.items.length > 0)
    .map(
      ({ key, label, items }) => html`
        <sp-accordion-item
          label="${label} (${items.length})"
          ?open=${!collapsedCats.has(key)}
          @sp-accordion-item-toggle=${() => {
            if (collapsedCats.has(key)) collapsedCats.delete(key);
            else collapsedCats.add(key);
            ctx.renderLeftPanel();
          }}
        >
          ${items.map(([name, def]) => {
            /** @type {boolean} */
            const isExpanded = expandedSignal === name;
            return html`
              <div
                class=${classMap({ "signal-row": true, expanded: isExpanded })}
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
                  @click=${(/** @type {Event} */ e) => {
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
          @change=${(/** @type {Event} */ e) => {
            const type = /** @type {HTMLInputElement} */ (e.target).value;
            if (!type) return;
            const template = DEF_TEMPLATES[type];
            if (!template) return;
            const isFunction = type === "function";
            let nameBase = isFunction ? "newFunction" : "$newSignal";
            let n = nameBase;
            let i = 1;
            while (S.document.state && S.document.state[n]) {
              n = nameBase + i++;
            }
            transactDoc(activeTab.value, (t) =>
              mutateAddDef(
                t,
                n,
                /** @type {Record<string, JsonValue>} */ (structuredClone(template)),
              ),
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
          <sp-menu-divider></sp-menu-divider>
          <sp-menu-item value="function">Function</sp-menu-item>
        </sp-picker>
      </div>
    </div>
  `;
}

/** Render inline editor fields for a specific signal/def type. */
function renderSignalEditorTemplate(
  /** @type {SignalsPanelState} */ S,
  /** @type {string} */ name,
  /** @type {SignalDef} */ def,
  /** @type {SignalsPanelCtx} */ ctx,
) {
  if (typeof def !== "object" || def === null) {
    def = { default: def };
  }
  const cat = defCategory(def);

  // Helper for picker rows
  const pickerRow = (
    /** @type {string} */ label,
    /** @type {string[]} */ options,
    /** @type {string} */ currentVal,
    /** @type {(value: string) => void} */ onChange,
  ) => {
    return renderFieldRow({
      prop: label,
      label,
      hasValue: false,
      widget: html`
        <sp-picker
          size="s"
          value=${currentVal}
          @change=${(/** @type {Event} */ e) =>
            onChange(/** @type {HTMLInputElement} */ (e.target).value)}
        >
          ${options.map(
            (/** @type {string} */ opt) => html`<sp-menu-item value=${opt}>${opt}</sp-menu-item>`,
          )}
        </sp-picker>
      `,
    });
  };

  // Helper for textarea rows
  const textareaRow = (
    /** @type {string} */ label,
    /** @type {string} */ value,
    /** @type {(value: string) => void} */ onChange,
    /** @type {{ minHeight?: string; mono?: boolean }} */ opts = {},
  ) => {
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let debounce;
    return renderFieldRow({
      prop: label,
      label,
      hasValue: false,
      widget: html`
        <textarea
          class="field-input"
          style=${styleMap({
            minHeight: opts.minHeight || "40px",
            ...(opts.mono && {
              fontFamily: "'SF Mono','Fira Code','Consolas',monospace",
              fontSize: "11px",
            }),
          })}
          .value=${value}
          @input=${(/** @type {Event} */ e) => {
            clearTimeout(debounce);
            debounce = setTimeout(
              () => onChange(/** @type {HTMLInputElement} */ (e.target).value),
              500,
            );
          }}
        ></textarea>
      `,
    });
  };

  // Name field (common to all)
  const nameField = signalFieldRow("Name", name, (/** @type {string} */ v) => {
    if (v && v !== name && !(S.document.state && S.document.state[v])) {
      expandedSignal = v;
      transactDoc(activeTab.value, (t) => mutateRenameDef(t, name, v));
    }
  });

  /** @type {import("lit-html").TemplateResult | typeof nothing} */
  let fields = nothing;

  if (cat === "state") {
    const defaultVal =
      def.default !== undefined && def.default !== null
        ? typeof def.default === "object"
          ? JSON.stringify(def.default)
          : String(def.default)
        : "";

    const cemFields = isCustomElementDoc(S)
      ? html`
          ${signalFieldRow("Attribute", def.attribute || "", (/** @type {string} */ v) =>
            transactDoc(activeTab.value, (t) =>
              mutateUpdateDef(t, name, { attribute: v || undefined }),
            ),
          )}
          ${renderFieldRow({
            prop: "reflects",
            label: "Reflects",
            hasValue: false,
            widget: html`
              <sp-checkbox
                class="field-check"
                ?checked=${!!def.reflects}
                @change=${(/** @type {Event} */ e) =>
                  transactDoc(activeTab.value, (t) =>
                    mutateUpdateDef(t, name, {
                      reflects: /** @type {HTMLInputElement} */ (e.target).checked || undefined,
                    }),
                  )}
              ></sp-checkbox>
            `,
          })}
          ${signalFieldRow(
            "Deprecated",
            typeof def.deprecated === "string" ? def.deprecated : "",
            (/** @type {string} */ v) =>
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
        (/** @type {string} */ v) =>
          transactDoc(activeTab.value, (t) => mutateUpdateDef(t, name, { type: v })),
      )}
      ${def.type === "string" || !def.type
        ? pickerRow(
            "Format",
            ["", "image", "date", "color"],
            def.format || "",
            (/** @type {string} */ v) =>
              transactDoc(activeTab.value, (t) =>
                mutateUpdateDef(t, name, { format: v || undefined }),
              ),
          )
        : nothing}
      ${def.format === "image"
        ? renderFieldRow({
            prop: "Default",
            label: "Default",
            hasValue: false,
            widget: renderMediaPicker("default", defaultVal, (/** @type {string} */ v) => {
              transactDoc(activeTab.value, (t) =>
                mutateUpdateDef(t, name, { default: v || undefined }),
              );
            }),
          })
        : signalFieldRow("Default", defaultVal, (/** @type {string} */ v) => {
            /** @type {unknown} */
            let parsed = v;
            if (def.type === "integer") parsed = parseInt(v, 10) || 0;
            else if (def.type === "number") parsed = parseFloat(v) || 0;
            else if (def.type === "boolean") parsed = v === "true";
            else if (def.type === "array" || def.type === "object") {
              try {
                parsed = JSON.parse(v);
              } catch {
                parsed = v;
              }
            }
            transactDoc(activeTab.value, (t) =>
              mutateUpdateDef(t, name, { default: /** @type {JsonValue} */ (parsed) }),
            );
          })}
      ${signalFieldRow("Description", def.description || "", (/** @type {string} */ v) =>
        transactDoc(activeTab.value, (t) =>
          mutateUpdateDef(t, name, { description: v || undefined }),
        ),
      )}
      ${cemFields}
    `;
  } else if (cat === "computed") {
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let debounce;
    fields = html`
      ${renderFieldRow({
        prop: "expression",
        label: "Expression",
        hasValue: false,
        widget: html`
          <textarea
            class="field-input"
            style="min-height:40px"
            .value=${def.$compute || ""}
            @input=${(/** @type {Event} */ e) => {
              clearTimeout(debounce);
              debounce = setTimeout(() => {
                const expr = /** @type {HTMLInputElement} */ (e.target).value;
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
            prop: "dependencies",
            label: "Dependencies",
            hasValue: false,
            widget: html`
              <span class="signal-hint" style="flex:1;max-width:none"
                >${def.$deps
                  .map((/** @type {string} */ d) => d.replace("#/state/", ""))
                  .join(", ")}</span
              >
            `,
          })
        : nothing}
    `;
  } else if (cat === "data") {
    fields = renderDataSourceFields(S, name, def, textareaRow, pickerRow, ctx);
  } else if (cat === "function") {
    fields = renderFunctionFields(S, name, def, textareaRow, ctx);
  }

  return html`${nameField}${fields}`;
}

/** Data source fields for signal editor */
function renderDataSourceFields(
  /** @type {SignalsPanelState} */ S,
  /** @type {string} */ name,
  /** @type {SignalDef} */ def,
  /** @type {Function} */ textareaRow,
  /** @type {Function} */ pickerRow,
  /** @type {SignalsPanelCtx} */ ctx,
) {
  const proto = def.$prototype;

  if (proto === "Request") {
    return html`
      ${signalFieldRow("URL", def.url || "", (/** @type {string} */ v) =>
        transactDoc(activeTab.value, (t) => mutateUpdateDef(t, name, { url: v })),
      )}
      ${pickerRow(
        "Method",
        ["GET", "POST", "PUT", "DELETE", "PATCH"],
        def.method || "GET",
        (/** @type {string} */ v) =>
          transactDoc(activeTab.value, (t) => mutateUpdateDef(t, name, { method: v })),
      )}
      ${pickerRow(
        "Timing",
        ["client", "server"],
        def.timing || "client",
        (/** @type {string} */ v) =>
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
      ${signalFieldRow("Key", def.key || "", (/** @type {string} */ v) =>
        transactDoc(activeTab.value, (t) => mutateUpdateDef(t, name, { key: v })),
      )}
      ${textareaRow("Default", defaultStr, (/** @type {string} */ v) => {
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
      ${signalFieldRow("Database", def.database || "", (/** @type {string} */ v) =>
        transactDoc(activeTab.value, (t) => mutateUpdateDef(t, name, { database: v })),
      )}
      ${signalFieldRow("Store", def.store || "", (/** @type {string} */ v) =>
        transactDoc(activeTab.value, (t) => mutateUpdateDef(t, name, { store: v })),
      )}
      ${signalFieldRow("Version", String(def.version || 1), (/** @type {string} */ v) =>
        transactDoc(activeTab.value, (t) =>
          mutateUpdateDef(t, name, { version: parseInt(v, 10) || 1 }),
        ),
      )}
    `;
  }
  if (proto === "Cookie") {
    return html`
      ${signalFieldRow("Cookie", def.name || "", (/** @type {string} */ v) =>
        transactDoc(activeTab.value, (t) => mutateUpdateDef(t, name, { name: v })),
      )}
      ${signalFieldRow("Default", String(def.default || ""), (/** @type {string} */ v) =>
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
    return textareaRow(fieldLabel, defaultStr, (/** @type {string} */ v) => {
      try {
        transactDoc(activeTab.value, (t) =>
          mutateUpdateDef(t, name, { [fieldName]: JSON.parse(v) }),
        );
      } catch {}
    });
  }
  // Schema-driven fallback
  return renderExternalPrototypeEditorTemplate(S, name, def, ctx);
}

/** Function fields for signal editor */
function renderFunctionFields(
  /** @type {SignalsPanelState} */ S,
  /** @type {string} */ name,
  /** @type {SignalDef} */ def,
  /** @type {Function} */ textareaRow,
  /** @type {SignalsPanelCtx} */ ctx,
) {
  const descriptionField = signalFieldRow(
    "Description",
    def.description || "",
    (/** @type {string} */ v) =>
      transactDoc(activeTab.value, (t) =>
        mutateUpdateDef(t, name, { description: v || undefined }),
      ),
  );

  const bodyField = def.$src
    ? html`
        ${signalFieldRow("Source", def.$src || "", (/** @type {string} */ v) =>
          transactDoc(activeTab.value, (t) => mutateUpdateDef(t, name, { $src: v || undefined })),
        )}
        ${signalFieldRow("Export", def.$export || "", (/** @type {string} */ v) =>
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
              ctx.updateSession({ ui: { editingFunction: { type: "def", defName: name } } });
              ctx.renderCanvas();
            }}
          >
            <sp-icon-code slot="icon"></sp-icon-code>
          </sp-action-button>
        </div>
        <textarea
          class="field-input"
          style="min-height:60px;font-family:monospace;font-size:11px"
          .value=${def.body || ""}
          @input=${(/** @type {Event} */ e) => {
            const v = /** @type {HTMLInputElement} */ (e.target).value;
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
  /** @type {SignalsPanelState} */ S,
  /** @type {string} */ name,
  /** @type {SignalDef} */ def,
  /** @type {SignalsPanelCtx} */ ctx,
) {
  const params = (def.parameters || []).map(normParam);
  const isAdvanced = advancedParamOpen.has(name);

  if (!isAdvanced) {
    // Basic mode: name chips
    return renderFieldRow({
      prop: "parameters",
      label: "Parameters",
      hasValue: false,
      widget: html`
        <div style="display:flex;flex-wrap:wrap;gap:4px;align-items:center">
          ${params.map(
            (/** @type {CemParameter} */ p, /** @type {number} */ i) => html`
              <span
                style="display:inline-flex;align-items:center;gap:2px;padding:1px 6px;border-radius:3px;background:var(--bg-hover);font-size:11px;font-family:monospace"
              >
                ${p.name || "?"}
                <span
                  style="cursor:pointer;opacity:0.5;margin-left:2px"
                  @click=${() => {
                    transactDoc(activeTab.value, (t) =>
                      mutateUpdateDef(t, name, {
                        parameters: params.filter(
                          (/** @type {unknown} */ _, /** @type {number} */ j) => j !== i,
                        ).length
                          ? params.filter(
                              (/** @type {unknown} */ _, /** @type {number} */ j) => j !== i,
                            )
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
            style="width:60px;flex:0 0 auto;font-size:11px"
            placeholder="+"
            @keydown=${(/** @type {KeyboardEvent} */ e) => {
              if (e.key === "Enter" && /** @type {HTMLInputElement} */ (e.target).value.trim()) {
                transactDoc(activeTab.value, (t) =>
                  mutateUpdateDef(t, name, {
                    parameters: [
                      ...params,
                      { name: /** @type {HTMLInputElement} */ (e.target).value.trim() },
                    ],
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
    prop: "parameters",
    label: "Parameters",
    hasValue: false,
    widget: html`
      <div style="display:flex;flex-direction:column;gap:4px">
        ${params.map(
          (/** @type {CemParameter} */ p, /** @type {number} */ i) => html`
            <div style="display:flex;gap:4px;align-items:center">
              <input
                class="field-input"
                .value=${p.name || ""}
                placeholder="name"
                style="flex:1"
                @change=${(/** @type {Event} */ e) => {
                  const next = [...params];
                  next[i] = { ...next[i], name: /** @type {HTMLInputElement} */ (e.target).value };
                  transactDoc(activeTab.value, (t) =>
                    mutateUpdateDef(t, name, { parameters: next }),
                  );
                }}
              />
              <input
                class="field-input"
                .value=${p.type?.text || ""}
                placeholder="type"
                style="flex:1"
                @change=${(/** @type {Event} */ e) => {
                  const next = [...params];
                  next[i] = {
                    ...next[i],
                    type: /** @type {HTMLInputElement} */ (e.target).value
                      ? { text: /** @type {HTMLInputElement} */ (e.target).value }
                      : undefined,
                  };
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
                @change=${(/** @type {Event} */ e) => {
                  const next = [...params];
                  next[i] = {
                    ...next[i],
                    description: /** @type {HTMLInputElement} */ (e.target).value || undefined,
                  };
                  transactDoc(activeTab.value, (t) =>
                    mutateUpdateDef(t, name, { parameters: next }),
                  );
                }}
              />
              <input
                type="checkbox"
                title="optional"
                .checked=${!!p.optional}
                @change=${(/** @type {Event} */ e) => {
                  const next = [...params];
                  next[i] = {
                    ...next[i],
                    optional: /** @type {HTMLInputElement} */ (e.target).checked || undefined,
                  };
                  transactDoc(activeTab.value, (t) =>
                    mutateUpdateDef(t, name, { parameters: next }),
                  );
                }}
              />
              <span
                style="cursor:pointer;opacity:0.5"
                @click=${() => {
                  const next = params.filter(
                    (/** @type {unknown} */ _, /** @type {number} */ j) => j !== i,
                  );
                  transactDoc(activeTab.value, (t) =>
                    mutateUpdateDef(t, name, { parameters: next.length ? next : undefined }),
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
              mutateUpdateDef(t, name, { parameters: [...params, { name: "" }] }),
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
function renderEmitsEditorTemplate(
  /** @type {SignalsPanelState} */ S,
  /** @type {string} */ name,
  /** @type {SignalDef} */ def,
) {
  const emits = /** @type {CemEvent[]} */ (def.emits || []);
  if (emits.length === 0 && !isCustomElementDoc(S)) return nothing;

  return html`
    <div
      style="font-size:11px;font-weight:600;color:var(--fg-dim);margin:8px 0 4px;text-transform:uppercase;letter-spacing:0.05em"
    >
      Emits
    </div>
    ${emits.map(
      (/** @type {CemEvent} */ ev, /** @type {number} */ i) => html`
        <div style="display:flex;gap:4px;align-items:center;margin-bottom:4px">
          <input
            class="field-input"
            .value=${ev.name || ""}
            placeholder="event name"
            style="flex:1"
            @change=${(/** @type {Event} */ e) => {
              const next = [...emits];
              next[i] = { ...next[i], name: /** @type {HTMLInputElement} */ (e.target).value };
              transactDoc(activeTab.value, (t) => mutateUpdateDef(t, name, { emits: next }));
            }}
          />
          <input
            class="field-input"
            .value=${ev.type?.text || ""}
            placeholder="type"
            style="flex:1"
            @change=${(/** @type {Event} */ e) => {
              const next = [...emits];
              next[i] = {
                ...next[i],
                type: /** @type {HTMLInputElement} */ (e.target).value
                  ? { text: /** @type {HTMLInputElement} */ (e.target).value }
                  : undefined,
              };
              transactDoc(activeTab.value, (t) => mutateUpdateDef(t, name, { emits: next }));
            }}
          />
          <input
            class="field-input"
            .value=${ev.description || ""}
            placeholder="description"
            style="flex:2"
            @change=${(/** @type {Event} */ e) => {
              const next = [...emits];
              next[i] = {
                ...next[i],
                description: /** @type {HTMLInputElement} */ (e.target).value || undefined,
              };
              transactDoc(activeTab.value, (t) => mutateUpdateDef(t, name, { emits: next }));
            }}
          />
          <span
            style="cursor:pointer;opacity:0.5"
            @click=${() => {
              transactDoc(activeTab.value, (t) =>
                mutateUpdateDef(t, name, {
                  emits: emits.filter(
                    (/** @type {unknown} */ _, /** @type {number} */ j) => j !== i,
                  ).length
                    ? emits.filter((/** @type {unknown} */ _, /** @type {number} */ j) => j !== i)
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
 * Render config form fields from a JSON Schema `properties` object. Maps schema types to
 * appropriate form controls.
 */
export function renderSchemaFieldsTemplate(
  /** @type {JsonSchema | null | undefined} */ schema,
  /** @type {SignalDef} */ def,
  /** @type {string} */ name,
  /** @type {SignalsPanelState} */ _S,
) {
  if (!schema?.properties) return nothing;

  const required = new Set(schema.required ?? []);

  return Object.entries(schema.properties)
    .filter(([prop]) => !STUDIO_RESERVED_KEYS.has(prop))
    .map(([prop, ps]) => {
      const currentValue = def[prop];
      const labelText = prop + (required.has(prop) ? " *" : "");

      let control;
      if (ps.enum) {
        control = html`
          <sp-picker
            size="s"
            value=${currentValue !== undefined
              ? String(currentValue)
              : ps.default !== undefined
                ? String(ps.default)
                : "__none__"}
            @change=${(/** @type {Event} */ e) =>
              transactDoc(activeTab.value, (t) =>
                mutateUpdateDef(t, name, {
                  [prop]: /** @type {HTMLInputElement} */ (e.target).value === "__none__"
                    ? undefined
                    : /** @type {HTMLInputElement} */ (e.target).value,
                }),
              )}
          >
            ${!required.has(prop) ? html`<sp-menu-item value="__none__">—</sp-menu-item>` : nothing}
            ${ps.enum.map(
              (/** @type {string} */ val) => html`<sp-menu-item value=${val}>${val}</sp-menu-item>`,
            )}
          </sp-picker>
        `;
      } else if (ps.type === "boolean") {
        control = html`<sp-checkbox
          ?checked=${currentValue ?? ps.default ?? false}
          @change=${(/** @type {Event} */ e) =>
            transactDoc(activeTab.value, (t) =>
              mutateUpdateDef(t, name, {
                [prop]: /** @type {HTMLInputElement} */ (e.target).checked,
              }),
            )}
        ></sp-checkbox>`;
      } else if (ps.type === "integer" || ps.type === "number") {
        /** @type {ReturnType<typeof setTimeout> | undefined} */
        let debounce;
        control = html`<sp-number-field
          size="s"
          min=${ifDefined(ps.minimum)}
          max=${ifDefined(ps.maximum)}
          step=${ps.type === "integer" ? "1" : nothing}
          .value=${currentValue !== undefined ? currentValue : nothing}
          placeholder=${ps.default !== undefined ? String(ps.default) : nothing}
          @change=${(/** @type {Event} */ e) => {
            clearTimeout(debounce);
            debounce = setTimeout(() => {
              const parsed =
                ps.type === "integer"
                  ? parseInt(/** @type {HTMLInputElement} */ (e.target).value, 10)
                  : parseFloat(/** @type {HTMLInputElement} */ (e.target).value);
              transactDoc(activeTab.value, (t) =>
                mutateUpdateDef(t, name, { [prop]: isNaN(parsed) ? undefined : parsed }),
              );
            }, 400);
          }}
        ></sp-number-field>`;
      } else if (ps.format === "json-schema") {
        const hasValue =
          currentValue && typeof currentValue === "object" && Object.keys(currentValue).length > 0;
        const cv = /** @type {Record<string, unknown>} */ (currentValue);
        const isRef = hasValue && cv.$ref;
        /** @type {ReturnType<typeof setTimeout> | undefined} */
        let debounce;
        control = html`
          <div class="schema-param-editor">
            ${hasValue && !isRef && cv.properties
              ? html`
                  <div style="display:flex;flex-wrap:wrap;gap:3px;margin-bottom:4px">
                    ${Object.entries(
                      /** @type {Record<string, Record<string, unknown>>} */ (cv.properties),
                    ).map(
                      ([k, v]) => html`
                        <span
                          style="background:var(--bg-alt);padding:1px 6px;border-radius:3px;font-size:10px;color:var(--fg-dim)"
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
                minHeight: hasValue ? "80px" : "40px",
                fontFamily: "monospace",
                fontSize: "11px",
              })}
              .value=${currentValue !== undefined ? JSON.stringify(currentValue, null, 2) : ""}
              placeholder=${ps.description ?? "JSON Schema defining the data shape\u2026"}
              @input=${(/** @type {Event} */ e) => {
                clearTimeout(debounce);
                debounce = setTimeout(() => {
                  try {
                    transactDoc(activeTab.value, (t) =>
                      mutateUpdateDef(t, name, {
                        [prop]: JSON.parse(/** @type {HTMLInputElement} */ (e.target).value),
                      }),
                    );
                  } catch {}
                }, 500);
              }}
            ></sp-textfield>
          </div>
        `;
      } else if (ps.type === "array" || ps.type === "object") {
        /** @type {ReturnType<typeof setTimeout> | undefined} */
        let debounce;
        control = html`<sp-textfield
          multiline
          size="s"
          style="min-height:40px"
          .value=${currentValue !== undefined ? JSON.stringify(currentValue, null, 2) : ""}
          placeholder=${ps.default !== undefined ? JSON.stringify(ps.default) : nothing}
          @input=${(/** @type {Event} */ e) => {
            clearTimeout(debounce);
            debounce = setTimeout(() => {
              try {
                transactDoc(activeTab.value, (t) =>
                  mutateUpdateDef(t, name, {
                    [prop]: JSON.parse(/** @type {HTMLInputElement} */ (e.target).value),
                  }),
                );
              } catch {}
            }, 500);
          }}
        ></sp-textfield>`;
      } else {
        /** @type {ReturnType<typeof setTimeout> | undefined} */
        let debounce;
        const ph = ps.default !== undefined ? String(ps.default) : (ps.examples?.[0] ?? "");
        control = html`<sp-textfield
          size="s"
          .value=${currentValue ?? ""}
          placeholder=${ph || nothing}
          title=${ps.description || nothing}
          @input=${(/** @type {Event} */ e) => {
            clearTimeout(debounce);
            debounce = setTimeout(
              () =>
                transactDoc(activeTab.value, (t) =>
                  mutateUpdateDef(t, name, {
                    [prop]: /** @type {HTMLInputElement} */ (e.target).value || undefined,
                  }),
                ),
              400,
            );
          }}
        ></sp-textfield>`;
      }

      return renderFieldRow({
        prop: ps.name || prop,
        label: labelText,
        hasValue: false,
        widget: control,
      });
    });
}

/**
 * Render editor fields for an external $prototype + $src plugin. Shows $src/$export inputs plus
 * schema-driven config fields.
 */
export function renderExternalPrototypeEditorTemplate(
  /** @type {SignalsPanelState} */ S,
  /** @type {string} */ name,
  /** @type {SignalDef} */ def,
  /** @type {SignalsPanelCtx} */ ctx,
) {
  // Schema-driven config fields (async with cache)
  /** @type {import("lit-html").TemplateResult | typeof nothing} */
  let schemaContent = nothing;
  if (def.$src && def.$prototype) {
    const cacheKey = `${def.$src}::${def.$prototype}`;
    if (pluginSchemaCache.has(cacheKey)) {
      const schema = pluginSchemaCache.get(cacheKey);
      if (schema) {
        schemaContent = html`
          ${schema.description
            ? html`<div class="signal-hint" style="padding:4px 0 8px">${schema.description}</div>`
            : nothing}
          ${renderSchemaFieldsTemplate(schema, def, name, S)}
        `;
      }
    } else {
      // Trigger async load — will re-render when cached
      schemaContent = html`<div
        style="padding:4px 0;font-size:11px;color:var(--fg-dim);font-style:italic"
      >
        Loading schema…
      </div>`;
      fetchPluginSchema(def, /** @type {{ documentPath?: string }} */ (S)).then((schema) => {
        if (schema) ctx.renderLeftPanel();
      });
    }
  }

  return html`
    ${signalFieldRow("Source", def.$src || "", (/** @type {string} */ v) => {
      transactDoc(activeTab.value, (t) => mutateUpdateDef(t, name, { $src: v || undefined }));
      pluginSchemaCache.delete(`${v}::${def.$prototype}`);
    })}
    ${signalFieldRow("Prototype", def.$prototype || "", (/** @type {string} */ v) => {
      transactDoc(activeTab.value, (t) => mutateUpdateDef(t, name, { $prototype: v || undefined }));
      pluginSchemaCache.delete(`${def.$src}::${v}`);
    })}
    ${def.$export
      ? signalFieldRow("Export", def.$export || "", (/** @type {string} */ v) =>
          transactDoc(activeTab.value, (t) =>
            mutateUpdateDef(t, name, { $export: v || undefined }),
          ),
        )
      : nothing}
    ${schemaContent}
  `;
}
