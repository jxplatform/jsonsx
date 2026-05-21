/**
 * Signals panel — signal/def helpers, signals template, CEM editors, plugin schema forms.
 *
 * Extracted from studio.js to reduce file size.
 */

import { html, nothing } from "lit-html";
import { activeTab } from "../workspace/workspace.js";
import {
  transactDoc,
  mutateUpdateDef,
  mutateAddDef,
  mutateRemoveDef,
  mutateRenameDef,
} from "../tabs/transact.js";
import { renderFieldRow } from "../ui/field-row.js";
import { fetchPluginSchema, pluginSchemaCache } from "../services/code-services.js";

// ─── Module-local state ─────────────────────────────────────────────────────

/** Expanded signal editor state (persists across renders). */
/** @type {any} */
let expandedSignal = null;

/** Track which functions have the advanced param editor open. */
const advancedParamOpen = new Set();

/** Default templates for creating new signal definitions. */
const DEF_TEMPLATES = /** @type {Record<string, any>} */ ({
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
 * @param {any} def
 */
export function defCategory(def) {
  if (!def) return "state";
  if (def.$handler || def.$prototype === "Function") return "function";
  if (def.$compute) return "computed";
  if (def.$prototype) return "data";
  return "state";
}

/**
 * Badge label for a def category.
 *
 * @param {any} def
 */
export function defBadgeLabel(def) {
  if (!def) return "S";
  if (def.$handler || def.$prototype === "Function") return "F";
  if (def.$compute) return "C";
  if (def.$prototype) return def.$prototype.charAt(0);
  return "S";
}

/**
 * Hint text for a signal row.
 *
 * @param {any} name
 * @param {any} def
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
  if (def.$prototype === "Request") return def.method + " " + (def.url || "").slice(0, 20);
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
 * @param {any} S
 */
export function isCustomElementDoc(S) {
  return (S.document.tagName || "").includes("-");
}

/**
 * Recursively collect CSS `part` attributes from the document tree.
 *
 * @param {any} node
 * @param {any[]} [parts]
 */
export function collectCssParts(node, parts = []) {
  if (node?.attributes?.part)
    parts.push({ name: node.attributes.part, tag: node.tagName || "div" });
  if (Array.isArray(node?.children))
    node.children.forEach((/** @type {any} */ c) => collectCssParts(c, parts));
  return parts;
}

/**
 * Resolve a $ref value to a display string using signal defaults. Used by the canvas to show real
 * values instead of raw refs.
 *
 * @param {any} value
 * @param {any} defs
 */
export function resolveDefaultForCanvas(value, defs) {
  if (!value || typeof value !== "object" || !value.$ref) return value;
  const ref = value.$ref;
  /** @type {any} */
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
  /** @type {any} */ label,
  /** @type {any} */ value,
  /** @type {any} */ onChange,
) {
  /** @type {any} */
  let debounce;
  return renderFieldRow({
    prop: label,
    label,
    hasValue: false,
    widget: html`
      <sp-textfield
        size="s"
        value=${value}
        @input=${(/** @type {any} */ e) => {
          clearTimeout(debounce);
          debounce = setTimeout(() => onChange(e.target.value), 400);
        }}
      ></sp-textfield>
    `,
  });
}

/** Normalize a parameter entry to a CEM object. */
export function normParam(/** @type {any} */ p) {
  return typeof p === "string" ? { name: p } : p;
}

// ─── Left panel: Signals ─────────────────────────────────────────────────────

/**
 * @param {any} S
 * @param {any} ctx
 */
export function renderSignalsTemplate(S, ctx) {
  const defs = S.document.state || {};
  const entries = Object.entries(defs);

  // Group by category
  const groups = /** @type {Record<string, any[]>} */ ({
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
            /** @type {any} */
            const isExpanded = expandedSignal === name;
            return html`
              <div
                class="signal-row${isExpanded ? " expanded" : ""}"
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
                  @click=${(/** @type {any} */ e) => {
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
          @change=${(/** @type {any} */ e) => {
            const type = e.target.value;
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
            transactDoc(activeTab.value, (t) => mutateAddDef(t, n, structuredClone(template)));
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
  /** @type {any} */ S,
  /** @type {any} */ name,
  /** @type {any} */ def,
  /** @type {any} */ ctx,
) {
  const cat = defCategory(def);

  // Helper for picker rows
  const pickerRow = (
    /** @type {any} */ label,
    /** @type {any} */ options,
    /** @type {any} */ currentVal,
    /** @type {any} */ onChange,
  ) => {
    return renderFieldRow({
      prop: label,
      label,
      hasValue: false,
      widget: html`
        <sp-picker
          size="s"
          value=${currentVal}
          @change=${(/** @type {any} */ e) => onChange(e.target.value)}
        >
          ${options.map(
            (/** @type {any} */ opt) => html`<sp-menu-item value=${opt}>${opt}</sp-menu-item>`,
          )}
        </sp-picker>
      `,
    });
  };

  // Helper for textarea rows
  const textareaRow = (
    /** @type {any} */ label,
    /** @type {any} */ value,
    /** @type {any} */ onChange,
    /** @type {any} */ opts = {},
  ) => {
    /** @type {any} */
    let debounce;
    return renderFieldRow({
      prop: label,
      label,
      hasValue: false,
      widget: html`
        <textarea
          class="field-input"
          style="min-height:${opts.minHeight || "40px"};${opts.mono
            ? "font-family:'SF Mono','Fira Code','Consolas',monospace;font-size:11px;"
            : ""}"
          .value=${value}
          @input=${(/** @type {any} */ e) => {
            clearTimeout(debounce);
            debounce = setTimeout(() => onChange(e.target.value), 500);
          }}
        ></textarea>
      `,
    });
  };

  // Name field (common to all)
  const nameField = signalFieldRow("Name", name, (/** @type {any} */ v) => {
    if (v && v !== name && !(S.document.state && S.document.state[v])) {
      expandedSignal = v;
      transactDoc(activeTab.value, (t) => mutateRenameDef(t, name, v));
    }
  });

  /** @type {any} */
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
          ${signalFieldRow("Attribute", def.attribute || "", (/** @type {any} */ v) =>
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
                @change=${(/** @type {any} */ e) =>
                  transactDoc(activeTab.value, (t) =>
                    mutateUpdateDef(t, name, { reflects: e.target.checked || undefined }),
                  )}
              ></sp-checkbox>
            `,
          })}
          ${signalFieldRow(
            "Deprecated",
            typeof def.deprecated === "string" ? def.deprecated : "",
            (/** @type {any} */ v) =>
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
        (/** @type {any} */ v) =>
          transactDoc(activeTab.value, (t) => mutateUpdateDef(t, name, { type: v })),
      )}
      ${def.type === "string" || !def.type
        ? pickerRow(
            "Format",
            ["", "image", "date", "color"],
            def.format || "",
            (/** @type {any} */ v) =>
              transactDoc(activeTab.value, (t) =>
                mutateUpdateDef(t, name, { format: v || undefined }),
              ),
          )
        : nothing}
      ${signalFieldRow("Default", defaultVal, (/** @type {any} */ v) => {
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
        transactDoc(activeTab.value, (t) => mutateUpdateDef(t, name, { default: parsed }));
      })}
      ${signalFieldRow("Description", def.description || "", (/** @type {any} */ v) =>
        transactDoc(activeTab.value, (t) =>
          mutateUpdateDef(t, name, { description: v || undefined }),
        ),
      )}
      ${cemFields}
    `;
  } else if (cat === "computed") {
    /** @type {any} */
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
            @input=${(/** @type {any} */ e) => {
              clearTimeout(debounce);
              debounce = setTimeout(() => {
                const expr = e.target.value;
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
                  .map((/** @type {any} */ d) => d.replace("#/state/", ""))
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
  /** @type {any} */ S,
  /** @type {any} */ name,
  /** @type {any} */ def,
  /** @type {any} */ textareaRow,
  /** @type {any} */ pickerRow,
  /** @type {any} */ ctx,
) {
  const proto = def.$prototype;

  if (proto === "Request") {
    return html`
      ${signalFieldRow("URL", def.url || "", (/** @type {any} */ v) =>
        transactDoc(activeTab.value, (t) => mutateUpdateDef(t, name, { url: v })),
      )}
      ${pickerRow(
        "Method",
        ["GET", "POST", "PUT", "DELETE", "PATCH"],
        def.method || "GET",
        (/** @type {any} */ v) =>
          transactDoc(activeTab.value, (t) => mutateUpdateDef(t, name, { method: v })),
      )}
      ${pickerRow("Timing", ["client", "server"], def.timing || "client", (/** @type {any} */ v) =>
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
      ${signalFieldRow("Key", def.key || "", (/** @type {any} */ v) =>
        transactDoc(activeTab.value, (t) => mutateUpdateDef(t, name, { key: v })),
      )}
      ${textareaRow("Default", defaultStr, (/** @type {any} */ v) => {
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
      ${signalFieldRow("Database", def.database || "", (/** @type {any} */ v) =>
        transactDoc(activeTab.value, (t) => mutateUpdateDef(t, name, { database: v })),
      )}
      ${signalFieldRow("Store", def.store || "", (/** @type {any} */ v) =>
        transactDoc(activeTab.value, (t) => mutateUpdateDef(t, name, { store: v })),
      )}
      ${signalFieldRow("Version", String(def.version || 1), (/** @type {any} */ v) =>
        transactDoc(activeTab.value, (t) =>
          mutateUpdateDef(t, name, { version: parseInt(v, 10) || 1 }),
        ),
      )}
    `;
  }
  if (proto === "Cookie") {
    return html`
      ${signalFieldRow("Cookie", def.name || "", (/** @type {any} */ v) =>
        transactDoc(activeTab.value, (t) => mutateUpdateDef(t, name, { name: v })),
      )}
      ${signalFieldRow("Default", def.default || "", (/** @type {any} */ v) =>
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
    return textareaRow(fieldLabel, defaultStr, (/** @type {any} */ v) => {
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
  /** @type {any} */ S,
  /** @type {any} */ name,
  /** @type {any} */ def,
  /** @type {any} */ textareaRow,
  /** @type {any} */ ctx,
) {
  const srcFields = def.$src
    ? html`
        ${signalFieldRow("Source", def.$src || "", (/** @type {any} */ v) =>
          transactDoc(activeTab.value, (t) => mutateUpdateDef(t, name, { $src: v || undefined })),
        )}
        ${signalFieldRow("Export", def.$export || "", (/** @type {any} */ v) =>
          transactDoc(activeTab.value, (t) =>
            mutateUpdateDef(t, name, { $export: v || undefined }),
          ),
        )}
      `
    : textareaRow(
        "Body",
        def.body || "",
        (/** @type {any} */ v) =>
          transactDoc(activeTab.value, (t) => mutateUpdateDef(t, name, { body: v })),
        { minHeight: "60px", mono: true },
      );

  return html`
    ${srcFields} ${renderParameterEditorTemplate(S, name, def, ctx)}
    ${isCustomElementDoc(S) ? renderEmitsEditorTemplate(S, name, def) : nothing}
    ${!def.$src
      ? html`
          <button
            class="kv-add"
            style="margin-top:4px"
            @click=${() => {
              ctx.updateSession({ ui: { editingFunction: { type: "def", defName: name } } });
              ctx.renderCanvas();
            }}
          >
            Open in editor
          </button>
        `
      : nothing}
    ${signalFieldRow("Description", def.description || "", (/** @type {any} */ v) =>
      transactDoc(activeTab.value, (t) =>
        mutateUpdateDef(t, name, { description: v || undefined }),
      ),
    )}
  `;
}

// ─── CEM Editors ─────────────────────────────────────────────────────────────

/** Render CEM parameter editor with basic/advanced toggle. */
function renderParameterEditorTemplate(
  /** @type {any} */ S,
  /** @type {any} */ name,
  /** @type {any} */ def,
  /** @type {any} */ ctx,
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
            (/** @type {any} */ p, /** @type {any} */ i) => html`
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
                          (/** @type {any} */ _, /** @type {any} */ j) => j !== i,
                        ).length
                          ? params.filter((/** @type {any} */ _, /** @type {any} */ j) => j !== i)
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
            @keydown=${(/** @type {any} */ e) => {
              if (e.key === "Enter" && e.target.value.trim()) {
                transactDoc(activeTab.value, (t) =>
                  mutateUpdateDef(t, name, {
                    parameters: [...params, { name: e.target.value.trim() }],
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
          (/** @type {any} */ p, /** @type {any} */ i) => html`
            <div style="display:flex;gap:4px;align-items:center">
              <input
                class="field-input"
                .value=${p.name || ""}
                placeholder="name"
                style="flex:1"
                @change=${(/** @type {any} */ e) => {
                  const next = [...params];
                  next[i] = { ...next[i], name: e.target.value };
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
                @change=${(/** @type {any} */ e) => {
                  const next = [...params];
                  next[i] = {
                    ...next[i],
                    type: e.target.value ? { text: e.target.value } : undefined,
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
                @change=${(/** @type {any} */ e) => {
                  const next = [...params];
                  next[i] = { ...next[i], description: e.target.value || undefined };
                  transactDoc(activeTab.value, (t) =>
                    mutateUpdateDef(t, name, { parameters: next }),
                  );
                }}
              />
              <input
                type="checkbox"
                title="optional"
                .checked=${!!p.optional}
                @change=${(/** @type {any} */ e) => {
                  const next = [...params];
                  next[i] = { ...next[i], optional: e.target.checked || undefined };
                  transactDoc(activeTab.value, (t) =>
                    mutateUpdateDef(t, name, { parameters: next }),
                  );
                }}
              />
              <span
                style="cursor:pointer;opacity:0.5"
                @click=${() => {
                  const next = params.filter(
                    (/** @type {any} */ _, /** @type {any} */ j) => j !== i,
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
  /** @type {any} */ S,
  /** @type {any} */ name,
  /** @type {any} */ def,
) {
  const emits = def.emits || [];
  if (emits.length === 0 && !isCustomElementDoc(S)) return nothing;

  return html`
    <div
      style="font-size:11px;font-weight:600;color:var(--fg-dim);margin:8px 0 4px;text-transform:uppercase;letter-spacing:0.05em"
    >
      Emits
    </div>
    ${emits.map(
      (/** @type {any} */ ev, /** @type {any} */ i) => html`
        <div style="display:flex;gap:4px;align-items:center;margin-bottom:4px">
          <input
            class="field-input"
            .value=${ev.name || ""}
            placeholder="event name"
            style="flex:1"
            @change=${(/** @type {any} */ e) => {
              const next = [...emits];
              next[i] = { ...next[i], name: e.target.value };
              transactDoc(activeTab.value, (t) => mutateUpdateDef(t, name, { emits: next }));
            }}
          />
          <input
            class="field-input"
            .value=${ev.type?.text || ""}
            placeholder="type"
            style="flex:1"
            @change=${(/** @type {any} */ e) => {
              const next = [...emits];
              next[i] = { ...next[i], type: e.target.value ? { text: e.target.value } : undefined };
              transactDoc(activeTab.value, (t) => mutateUpdateDef(t, name, { emits: next }));
            }}
          />
          <input
            class="field-input"
            .value=${ev.description || ""}
            placeholder="description"
            style="flex:2"
            @change=${(/** @type {any} */ e) => {
              const next = [...emits];
              next[i] = { ...next[i], description: e.target.value || undefined };
              transactDoc(activeTab.value, (t) => mutateUpdateDef(t, name, { emits: next }));
            }}
          />
          <span
            style="cursor:pointer;opacity:0.5"
            @click=${() => {
              transactDoc(activeTab.value, (t) =>
                mutateUpdateDef(t, name, {
                  emits: emits.filter((/** @type {any} */ _, /** @type {any} */ j) => j !== i)
                    .length
                    ? emits.filter((/** @type {any} */ _, /** @type {any} */ j) => j !== i)
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
  /** @type {any} */ schema,
  /** @type {any} */ def,
  /** @type {any} */ name,
  /** @type {any} */ _S,
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
            @change=${(/** @type {any} */ e) =>
              transactDoc(activeTab.value, (t) =>
                mutateUpdateDef(t, name, {
                  [prop]: e.target.value === "__none__" ? undefined : e.target.value,
                }),
              )}
          >
            ${!required.has(prop) ? html`<sp-menu-item value="__none__">—</sp-menu-item>` : nothing}
            ${ps.enum.map(
              (/** @type {any} */ val) => html`<sp-menu-item value=${val}>${val}</sp-menu-item>`,
            )}
          </sp-picker>
        `;
      } else if (ps.type === "boolean") {
        control = html`<sp-checkbox
          ?checked=${currentValue ?? ps.default ?? false}
          @change=${(/** @type {any} */ e) =>
            transactDoc(activeTab.value, (t) =>
              mutateUpdateDef(t, name, { [prop]: e.target.checked }),
            )}
        ></sp-checkbox>`;
      } else if (ps.type === "integer" || ps.type === "number") {
        /** @type {any} */
        let debounce;
        control = html`<sp-number-field
          size="s"
          min=${ps.minimum !== undefined ? ps.minimum : nothing}
          max=${ps.maximum !== undefined ? ps.maximum : nothing}
          step=${ps.type === "integer" ? "1" : nothing}
          .value=${currentValue !== undefined ? currentValue : nothing}
          placeholder=${ps.default !== undefined ? String(ps.default) : nothing}
          @change=${(/** @type {any} */ e) => {
            clearTimeout(debounce);
            debounce = setTimeout(() => {
              const parsed =
                ps.type === "integer" ? parseInt(e.target.value, 10) : parseFloat(e.target.value);
              transactDoc(activeTab.value, (t) =>
                mutateUpdateDef(t, name, { [prop]: isNaN(parsed) ? undefined : parsed }),
              );
            }, 400);
          }}
        ></sp-number-field>`;
      } else if (ps.format === "json-schema") {
        const hasValue =
          currentValue && typeof currentValue === "object" && Object.keys(currentValue).length > 0;
        const isRef = currentValue && typeof currentValue === "object" && currentValue.$ref;
        /** @type {any} */
        let debounce;
        control = html`
          <div class="schema-param-editor">
            ${hasValue && !isRef && currentValue.properties
              ? html`
                  <div style="display:flex;flex-wrap:wrap;gap:3px;margin-bottom:4px">
                    ${Object.entries(currentValue.properties).map(
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
              style="min-height:${hasValue ? "80px" : "40px"};font-family:monospace;font-size:11px"
              .value=${currentValue !== undefined ? JSON.stringify(currentValue, null, 2) : ""}
              placeholder=${ps.description ?? "JSON Schema defining the data shape\u2026"}
              @input=${(/** @type {any} */ e) => {
                clearTimeout(debounce);
                debounce = setTimeout(() => {
                  try {
                    transactDoc(activeTab.value, (t) =>
                      mutateUpdateDef(t, name, { [prop]: JSON.parse(e.target.value) }),
                    );
                  } catch {}
                }, 500);
              }}
            ></sp-textfield>
          </div>
        `;
      } else if (ps.type === "array" || ps.type === "object") {
        /** @type {any} */
        let debounce;
        control = html`<sp-textfield
          multiline
          size="s"
          style="min-height:40px"
          .value=${currentValue !== undefined ? JSON.stringify(currentValue, null, 2) : ""}
          placeholder=${ps.default !== undefined ? JSON.stringify(ps.default) : nothing}
          @input=${(/** @type {any} */ e) => {
            clearTimeout(debounce);
            debounce = setTimeout(() => {
              try {
                transactDoc(activeTab.value, (t) =>
                  mutateUpdateDef(t, name, { [prop]: JSON.parse(e.target.value) }),
                );
              } catch {}
            }, 500);
          }}
        ></sp-textfield>`;
      } else {
        /** @type {any} */
        let debounce;
        const ph = ps.default !== undefined ? String(ps.default) : (ps.examples?.[0] ?? "");
        control = html`<sp-textfield
          size="s"
          .value=${currentValue ?? ""}
          placeholder=${ph || nothing}
          title=${ps.description || nothing}
          @input=${(/** @type {any} */ e) => {
            clearTimeout(debounce);
            debounce = setTimeout(
              () =>
                transactDoc(activeTab.value, (t) =>
                  mutateUpdateDef(t, name, { [prop]: e.target.value || undefined }),
                ),
              400,
            );
          }}
        ></sp-textfield>`;
      }

      return renderFieldRow({
        prop: ps.name,
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
  /** @type {any} */ S,
  /** @type {any} */ name,
  /** @type {any} */ def,
  /** @type {any} */ ctx,
) {
  // Schema-driven config fields (async with cache)
  /** @type {any} */
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
      fetchPluginSchema(def, S).then((schema) => {
        if (schema) ctx.renderLeftPanel();
      });
    }
  }

  return html`
    ${signalFieldRow("Source", def.$src || "", (/** @type {any} */ v) => {
      transactDoc(activeTab.value, (t) => mutateUpdateDef(t, name, { $src: v || undefined }));
      pluginSchemaCache.delete(`${v}::${def.$prototype}`);
    })}
    ${signalFieldRow("Prototype", def.$prototype || "", (/** @type {any} */ v) => {
      transactDoc(activeTab.value, (t) => mutateUpdateDef(t, name, { $prototype: v || undefined }));
      pluginSchemaCache.delete(`${def.$src}::${v}`);
    })}
    ${def.$export
      ? signalFieldRow("Export", def.$export || "", (/** @type {any} */ v) =>
          transactDoc(activeTab.value, (t) =>
            mutateUpdateDef(t, name, { $export: v || undefined }),
          ),
        )
      : nothing}
    ${schemaContent}
  `;
}
