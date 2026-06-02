/** Properties panel — inspector for element attributes, component props, media, and frontmatter. */

import { html, nothing } from "lit-html";
import { live } from "lit-html/directives/live.js";
import { getNodeAtPath, debouncedStyleCommit, renderOnly, projectState } from "../store";
import type { JsonValue, DirEntry } from "../types";
import {
  transactDoc,
  mutateUpdateProperty,
  mutateUpdateAttribute,
  mutateUpdateProp,
  mutateUpdateMedia,
  mutateAddSwitchCase,
  mutateRemoveSwitchCase,
  mutateRenameSwitchCase,
} from "../tabs/transact";
import { activeTab } from "../workspace/workspace";
import { view } from "../view";
import { componentRegistry } from "../files/components";
import { widgetForType } from "./style-inputs";
import { renderFieldRow } from "../ui/field-row";
import {
  attrLabel,
  inferInputType,
  friendlyNameToVar,
  camelToLabel,
  parseCemType,
} from "../utils/studio-utils";
import { isCustomElementDoc, collectCssParts } from "./signals-panel";
import { mediaDisplayName } from "./shared";
import { getCssInitialMap } from "./style-utils";
import { renderMediaPicker } from "../ui/media-picker";
import { renderColorSelector } from "../ui/color-selector";
import { getEffectiveLayoutPath, invalidateLayoutCache } from "../site-context";
import { getPlatform } from "../platform";
import htmlMeta from "../../data/html-meta.json";

import type { JxPrototypeDef, JxMutableNode } from "@jxsuite/schema/types";
import type { JxPath } from "../state";

interface SignalOption {
  value: string;
  label: string;
}

interface HtmlMetaEntry {
  $section: string;
  $order: number;
  $elements?: string[];
  $label?: string;
  $input?: string;
  $shorthand?: boolean;
  type?: string;
  [key: string]: unknown;
}

/**
 * Convert a human-friendly name like "Tablet" to a $media key "--tablet"
 *
 * @param {string} name
 */
function friendlyNameToMedia(name: string) {
  return friendlyNameToVar(name, "--");
}

/** Check if a selection path is inside a $map template (contains [..., "children", "map", ...]). */
function isInsideMapTemplate(path: JxPath | null) {
  if (!path) return false;
  for (let i = 0; i < path.length - 1; i++) {
    if (path[i] === "children" && path[i + 1] === "map") return true;
  }
  return false;
}

/**
 * Field row with binding toggle — allows switching between static value and signal binding.
 * rawValue can be a string/bool (static) or { $ref: "..." } (bound).
 */
function bindableFieldRow(
  label: string,
  type: string,
  rawValue: string | number | boolean | { $ref: string } | null | undefined,
  onChange: (v: JsonValue) => void,
  filterFn: ((d: import("./signals-panel.js").SignalDef) => boolean) | null = null,
  extraSignals: SignalOption[] | null = null,
) {
  const tab = activeTab.value;
  const defs = tab!.doc.document.state || {};
  const isBound = typeof rawValue === "object" && rawValue !== null && rawValue.$ref;

  const signalDefs = Object.entries(defs).filter(([, d]) =>
    filterFn
      ? filterFn(d as import("./signals-panel.js").SignalDef)
      : !(d as Record<string, unknown>)?.$handler &&
        (d as JxPrototypeDef)?.$prototype !== "Function",
  );

  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let debounce: ReturnType<typeof setTimeout> | undefined;
  const onInput = (e: Event) => {
    clearTimeout(debounce);
    debounce = setTimeout(() => onChange((e.target as HTMLInputElement).value), 400);
  };

  const staticVal = isBound ? "" : (rawValue ?? "");
  const staticTpl =
    type === "textarea"
      ? html`<sp-textfield
          multiline
          size="s"
          .value=${live(staticVal)}
          @input=${onInput}
        ></sp-textfield>`
      : type === "checkbox"
        ? html`<sp-checkbox
            ?checked=${!!staticVal}
            @change=${(e: Event) => onChange((e.target as HTMLInputElement).checked)}
          ></sp-checkbox>`
        : html`<sp-textfield size="s" .value=${live(staticVal)} @input=${onInput}></sp-textfield>`;

  const boundTpl = html`
    <sp-picker
      size="s"
      quiet
      placeholder="— select signal —"
      value=${isBound && rawValue.$ref ? rawValue.$ref : nothing}
      @change=${(e: Event) => {
        if ((e.target as HTMLInputElement).value)
          onChange({ $ref: (e.target as HTMLInputElement).value });
        else onChange(undefined);
      }}
    >
      ${signalDefs.map(
        ([defName]) => html`<sp-menu-item value=${`#/state/${defName}`}>${defName}</sp-menu-item>`,
      )}
      ${extraSignals
        ? html`
            <sp-menu-divider></sp-menu-divider>
            ${extraSignals.map(
              (sig: SignalOption) =>
                html`<sp-menu-item value=${sig.value}>${sig.label}</sp-menu-item>`,
            )}
          `
        : nothing}
    </sp-picker>
  `;

  const onToggle = () => {
    if (isBound) {
      const ref = rawValue.$ref;
      const defName = ref.startsWith("#/state/") ? ref.slice(8) : ref;
      const def = defs[defName];
      let staticVal = "";
      if (def && def.default !== undefined)
        staticVal =
          typeof def.default === "object" ? JSON.stringify(def.default) : String(def.default);
      onChange(staticVal || undefined);
    } else {
      if (signalDefs.length > 0) {
        onChange({ $ref: `#/state/${signalDefs[0][0]}` });
      } else if (extraSignals && extraSignals.length > 0) {
        onChange({ $ref: extraSignals[0].value });
      }
    }
  };

  return html`
    <div class="field-row">
      <sp-field-label size="s">${label}</sp-field-label>
      ${isBound ? boundTpl : staticTpl}
      <sp-action-button
        size="xs"
        quiet
        title=${isBound ? "Unbind (switch to static)" : "Bind to signal"}
        @click=${onToggle}
        >${isBound ? "\u26A1" : "\u2194"}</sp-action-button
      >
    </div>
  `;
}

/** Key-value pair row for styles / attributes */
function kvRow(
  key: string,
  value: string,
  onChange: (newKey: string, newVal: string) => void,
  onDelete: () => void,
  /** @type {string | null} */ datalistId = null,
) {
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;
  let currentKey = key;
  let currentVal = value;
  const commit = () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => onChange(currentKey, currentVal), 400);
  };
  const placeholder = datalistId === "css-props" ? getCssInitialMap().get(key) || "" : "";
  return html`
    <div class="kv-row">
      <sp-textfield
        size="s"
        class="kv-key"
        .value=${live(key)}
        @input=${(e: Event) => {
          currentKey = (e.target as HTMLInputElement).value;
          commit();
        }}
        @change=${datalistId === "css-props"
          ? (e: Event) => {
              const el = (e.target as HTMLInputElement)
                .closest(".kv-row")
                ?.querySelector(".kv-val");
              if (el)
                el.setAttribute(
                  "placeholder",
                  getCssInitialMap().get((e.target as HTMLInputElement).value) || "",
                );
            }
          : nothing}
      ></sp-textfield>
      <sp-textfield
        size="s"
        class="kv-val"
        .value=${live(value)}
        placeholder=${placeholder}
        @input=${(e: Event) => {
          currentVal = (e.target as HTMLInputElement).value;
          commit();
        }}
      ></sp-textfield>
      <sp-action-button size="xs" quiet @click=${onDelete}>
        <sp-icon-close slot="icon"></sp-icon-close>
      </sp-action-button>
    </div>
  `;
}

// ─── Sub-templates ──────────────────────────────────────────────────────────

/** Repeater fields template */
function renderRepeaterFieldsTemplate(
  node: JxMutableNode,
  path: JxPath,
  _mapSignals: SignalOption[] | null,
) {
  return html`
    ${bindableFieldRow("Items", "text", node.items, (v: JsonValue) =>
      transactDoc(activeTab.value, (t) => mutateUpdateProperty(t, path, "items", v)),
    )}
    ${node.filter
      ? bindableFieldRow("Filter", "text", node.filter, (v: JsonValue) =>
          transactDoc(activeTab.value, (t) =>
            mutateUpdateProperty(t, path, "filter", v || undefined),
          ),
        )
      : nothing}
    ${node.sort
      ? bindableFieldRow("Sort", "text", node.sort, (v: JsonValue) =>
          transactDoc(activeTab.value, (t) =>
            mutateUpdateProperty(t, path, "sort", v || undefined),
          ),
        )
      : nothing}
    <div style="display:flex;gap:8px;margin-top:4px">
      ${!node.filter
        ? html`<span
            class="kv-add"
            @click=${() =>
              transactDoc(activeTab.value, (t) =>
                mutateUpdateProperty(t, path, "filter", { $ref: "#/state/" }),
              )}
            >+ Add filter</span
          >`
        : nothing}
      ${!node.sort
        ? html`<span
            class="kv-add"
            @click=${() =>
              transactDoc(activeTab.value, (t) =>
                mutateUpdateProperty(t, path, "sort", { $ref: "#/state/" }),
              )}
            >+ Add sort</span
          >`
        : nothing}
    </div>
    ${node.map
      ? html`
          <sp-action-button
            size="s"
            style="margin-top:8px;width:100%"
            @click=${() => {
              activeTab.value!.session.selection = [...path, "map"];
            }}
            >Edit template →</sp-action-button
          >
        `
      : nothing}
  `;
}

/** Switch fields template */
function renderSwitchFieldsTemplate(
  node: JxMutableNode,
  path: JxPath,
  mapSignals: SignalOption[] | null,
) {
  const caseNames = Object.keys(node.cases || {});
  return html`
    ${bindableFieldRow(
      "Expression",
      "text",
      node.$switch,
      (v: JsonValue) =>
        transactDoc(activeTab.value, (t) => mutateUpdateProperty(t, path, "$switch", v)),
      null,
      mapSignals,
    )}
    <div
      style="font-size:11px;font-weight:600;color:var(--fg-dim);margin:8px 0 4px;text-transform:uppercase;letter-spacing:0.05em"
    >
      Cases
    </div>
    ${caseNames.map((caseName) => {
      /** @type {ReturnType<typeof setTimeout> | undefined} */
      let debounce: ReturnType<typeof setTimeout> | undefined;
      return html`
        <div class="field-row" style="display:flex;align-items:center;gap:4px;margin-bottom:3px">
          <input
            class="field-input"
            .value=${live(caseName)}
            style="flex:1"
            @input=${(e: Event) => {
              clearTimeout(debounce);
              debounce = setTimeout(() => {
                if (
                  (e.target as HTMLInputElement).value &&
                  (e.target as HTMLInputElement).value !== caseName
                )
                  transactDoc(activeTab.value, (t) =>
                    mutateRenameSwitchCase(t, path, caseName, (e.target as HTMLInputElement).value),
                  );
              }, 500);
            }}
          />
          <span
            class="bind-toggle"
            title="Edit case"
            style="cursor:pointer"
            @click=${(e: Event) => {
              e.stopPropagation();
              activeTab.value!.session.selection = [...path, "cases", caseName];
            }}
            >→</span
          >
          <span
            style="cursor:pointer;color:var(--danger);font-size:11px"
            @click=${(e: Event) => {
              e.stopPropagation();
              transactDoc(activeTab.value!, (t) => mutateRemoveSwitchCase(t, path, caseName));
            }}
            >✕</span
          >
        </div>
      `;
    })}
    <span
      class="kv-add"
      @click=${() => {
        transactDoc(activeTab.value, (t) =>
          mutateAddSwitchCase(t, path, `case${caseNames.length + 1}`),
        );
      }}
      >+ Add case</span
    >
  `;
}

/** Component props fields template */
function renderComponentPropsFieldsTemplate(
  node: JxMutableNode,
  path: JxPath,
  mapSignals: SignalOption[] | null,
  navigateToComponent: (path: string) => void,
) {
  const tab = activeTab.value;
  const comp = componentRegistry.find((c) => c.tagName === node.tagName);
  if (!comp || !comp.props) return html`<div class="empty-state">Component not found</div>`;
  const isNpm = comp.source === "npm";
  const currentVals = isNpm ? node.attributes || {} : node.$props || {};
  const updateFn = isNpm
    ? (name: string, v: JsonValue) =>
        transactDoc(activeTab.value, (t) =>
          mutateUpdateAttribute(t, path, name, v === "" ? undefined : (v as string | undefined)),
        )
    : (name: string, v: JsonValue) =>
        transactDoc(activeTab.value, (t) => mutateUpdateProp(t, path, name, v));

  const defs = tab!.doc.document.state || {};
  const signalDefs = Object.entries(defs).filter(
    ([, d]) =>
      !(d as Record<string, unknown>)?.$handler && (d as JxPrototypeDef)?.$prototype !== "Function",
  );
  const extraSignals = mapSignals;

  return html`
    ${comp.props.map(
      (
        /** @type {{ name: string; type?: string; format?: string; description?: string }} */ prop,
      ) => {
        const rawValue = currentVals[prop.name];
        const isBound = typeof rawValue === "object" && rawValue !== null && rawValue.$ref;
        const hasVal = rawValue !== undefined && rawValue !== null;
        const parsed = parseCemType(prop.type);
        const onChange = (v: JsonValue) => updateFn(prop.name, v);
        const staticVal = isBound ? "" : String(rawValue ?? "");

        const clearProp = (e: Event) => {
          e.stopPropagation();
          updateFn(prop.name, undefined);
        };

        const onToggleBind = () => {
          if (isBound) {
            const ref = rawValue.$ref;
            const defName = ref.startsWith("#/state/") ? ref.slice(8) : ref;
            const def = defs[defName];
            let staticVal = "";
            if (def && def.default !== undefined)
              staticVal =
                typeof def.default === "object" ? JSON.stringify(def.default) : String(def.default);
            onChange(staticVal || undefined);
          } else {
            if (signalDefs.length > 0) {
              onChange({ $ref: `#/state/${signalDefs[0][0]}` });
            } else if (extraSignals && extraSignals.length > 0) {
              onChange({ $ref: extraSignals[0].value });
            }
          }
        };

        const boundTpl = html`
          <sp-picker
            size="s"
            quiet
            placeholder="— select signal —"
            value=${isBound && rawValue.$ref ? rawValue.$ref : nothing}
            @change=${(e: Event) => {
              if ((e.target as HTMLInputElement).value)
                onChange({ $ref: (e.target as HTMLInputElement).value });
              else onChange(undefined);
            }}
          >
            ${signalDefs.map(
              ([defName]) =>
                html`<sp-menu-item value=${`#/state/${defName}`}>${defName}</sp-menu-item>`,
            )}
            ${extraSignals
              ? html`
                  <sp-menu-divider></sp-menu-divider>
                  ${extraSignals.map(
                    (sig: SignalOption) =>
                      html`<sp-menu-item value=${sig.value}>${sig.label}</sp-menu-item>`,
                  )}
                `
              : nothing}
          </sp-picker>
        `;

        /** @type {ReturnType<typeof setTimeout> | undefined} */
        let debounce: ReturnType<typeof setTimeout> | undefined;
        let widgetTpl;
        if (prop.format === "image") {
          widgetTpl = renderMediaPicker(prop.name, staticVal, onChange);
        } else if (prop.format === "color") {
          widgetTpl = renderColorSelector(prop.name, staticVal, onChange);
        } else if (prop.format === "date") {
          widgetTpl = html`<sp-textfield
            size="s"
            placeholder="YYYY-MM-DD"
            .value=${live(staticVal)}
            @input=${(e: Event) => {
              clearTimeout(debounce);
              debounce = setTimeout(() => onChange((e.target as HTMLInputElement).value), 400);
            }}
          ></sp-textfield>`;
        } else if (parsed.kind === "boolean") {
          widgetTpl = html`<sp-checkbox
            size="s"
            .checked=${live(!!staticVal)}
            @change=${(e: Event) => onChange((e.target as HTMLInputElement).checked || undefined)}
          ></sp-checkbox>`;
        } else if (parsed.kind === "number") {
          widgetTpl = html`<sp-number-field
            size="s"
            .value=${live(staticVal)}
            @input=${(e: Event) => {
              clearTimeout(debounce);
              debounce = setTimeout(() => onChange((e.target as HTMLInputElement).value), 400);
            }}
          ></sp-number-field>`;
        } else if (parsed.kind === "combobox") {
          const options = /** @type {{ options?: string[] }} */ (parsed).options as string[];
          widgetTpl = html`<jx-value-selector
            .value=${String(staticVal)}
            size="s"
            placeholder="—"
            .options=${options.map((o) => ({ value: o, label: camelToLabel(o) }))}
            @change=${(e: Event & { detail?: { value?: string } }) =>
              onChange(e.detail?.value ?? (e.target as HTMLInputElement).value)}
          ></jx-value-selector>`;
        } else {
          widgetTpl = html`<sp-textfield
            size="s"
            .value=${live(staticVal)}
            @input=${(e: Event) => {
              clearTimeout(debounce);
              debounce = setTimeout(() => onChange((e.target as HTMLInputElement).value), 400);
            }}
          ></sp-textfield>`;
        }

        return html`
          <div class="style-row" data-prop=${prop.name}>
            <div class="style-row-label">
              ${hasVal
                ? html`<span class="set-dot" title="Clear ${prop.name}" @click=${clearProp}></span>`
                : nothing}
              <sp-field-label size="s" title=${prop.description || prop.name}
                >${camelToLabel(prop.name)}</sp-field-label
              >
              <sp-action-button
                size="xs"
                quiet
                title=${isBound ? "Unbind (switch to static)" : "Bind to signal"}
                @click=${onToggleBind}
                >${isBound ? "\u26A1" : "\u2194"}</sp-action-button
              >
            </div>
            ${isBound ? boundTpl : widgetTpl}
          </div>
        `;
      },
    )}
    ${comp.props.length === 0 ? html`<div class="empty-state">No props defined</div>` : nothing}
    ${comp.path
      ? html`<span class="kv-add" @click=${() => navigateToComponent(comp.path)}
          >→ Edit definition</span
        >`
      : nothing}
  `;
}

/** Custom attrs fields template */
function renderCustomAttrsFieldsTemplate(
  node: JxMutableNode,
  path: JxPath,
  attrs: Record<string, unknown>,
  knownAttrNames: Set<string>,
) {
  const customAttrs = Object.entries(attrs).filter(([k]) => !knownAttrNames.has(k));
  return html`
    ${customAttrs.map(([attr, val]) =>
      kvRow(
        attr,
        String(val),
        (newAttr: string, newVal: string) => {
          if (newAttr !== attr) {
            transactDoc(activeTab.value, (t) => {
              mutateUpdateAttribute(t, path, attr, undefined);
              mutateUpdateAttribute(t, path, newAttr, newVal);
            });
          } else {
            transactDoc(activeTab.value, (t) => mutateUpdateAttribute(t, path, attr, newVal));
          }
        },
        () => transactDoc(activeTab.value, (t) => mutateUpdateAttribute(t, path, attr, undefined)),
      ),
    )}
    <span
      class="kv-add"
      @click=${() =>
        transactDoc(activeTab.value, (t) => mutateUpdateAttribute(t, path, "data-", ""))}
      >+ Add attribute</span
    >
  `;
}

// ─── Media breakpoints ──────────────────────────────────────────────────────

/** Media breakpoint fields template */
function renderMediaFieldsTemplate(node: JxMutableNode) {
  const media = node.$media || {};
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let baseDebounce: ReturnType<typeof setTimeout> | undefined;
  const breakpoints = Object.entries(media).filter(([k]) => k !== "--");

  return html`
    <div class="kv-row" style="align-items:center">
      <span class="field-label" style="width:auto;margin-right:4px">Base width</span>
      <input
        class="field-input"
        style="width:70px;flex:none"
        placeholder="320px"
        .value=${live(media["--"] || "")}
        @input=${(e: Event) => {
          clearTimeout(baseDebounce);
          baseDebounce = setTimeout(() => {
            const val = (e.target as HTMLInputElement).value.trim();
            transactDoc(activeTab.value, (t) => mutateUpdateMedia(t, "--", val || undefined));
          }, 400);
        }}
      />
      ${media["--"]
        ? html`<span
            class="kv-del"
            @click=${() =>
              transactDoc(activeTab.value, (t) => mutateUpdateMedia(t, "--", undefined))}
            >✕</span
          >`
        : nothing}
    </div>

    ${breakpoints.map(([name, query]) => mediaBreakpointRowTemplate(name, query))}

    <div>
      <span
        class="kv-add"
        style=${view.showAddBreakpointForm ? "display:none" : ""}
        @click=${(_e: Event) => {
          view.showAddBreakpointForm = true;
          renderOnly("rightPanel");
        }}
        >+ Add breakpoint</span
      >
      ${view.showAddBreakpointForm
        ? html`
            <div style="margin-top:4px">
              <div style="display:flex;gap:4px;margin-bottom:3px;align-items:center">
                <input
                  class="field-input"
                  placeholder="Name (e.g. Tablet)"
                  style="flex:1"
                  @input=${(e: Event) => {
                    view.addBreakpointPreview =
                      friendlyNameToMedia((e.target as HTMLInputElement).value) || "";
                    renderOnly("rightPanel");
                  }}
                />
                <span
                  style="font-size:10px;color:var(--fg-dim);font-family:'SF Mono','Fira Code',monospace;white-space:nowrap"
                  >${view.addBreakpointPreview}</span
                >
              </div>
              <div style="display:flex;gap:4px;margin-bottom:3px;align-items:center">
                <input class="field-input add-bp-query" value="(min-width: 768px)" style="flex:1" />
              </div>
              <div style="display:flex;gap:4px">
                <button
                  class="kv-add"
                  style="padding:2px 10px;cursor:pointer"
                  @click=${(e: Event) => {
                    const wrap = (e.target as HTMLElement).closest("div")?.parentElement;
                    const nameVal = wrap?.querySelector("input")?.value;
                    const queryVal = (
                      wrap?.querySelector(".add-bp-query") as HTMLInputElement | null
                    )?.value?.trim();
                    const key = friendlyNameToMedia(nameVal || "");
                    if (key && queryVal) {
                      view.showAddBreakpointForm = false;
                      view.addBreakpointPreview = "";
                      transactDoc(activeTab.value, (t) => mutateUpdateMedia(t, key, queryVal));
                    }
                  }}
                >
                  Add
                </button>
                <button
                  class="kv-add"
                  style="padding:2px 10px;cursor:pointer;color:var(--fg-dim)"
                  @click=${() => {
                    view.showAddBreakpointForm = false;
                    view.addBreakpointPreview = "";
                    renderOnly("rightPanel");
                  }}
                >
                  Cancel
                </button>
              </div>
            </div>
          `
        : nothing}
    </div>
  `;
}

/** Single media breakpoint row template */
function mediaBreakpointRowTemplate(name: string, query: string) {
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;
  let currentRawLabel = name;
  return html`
    <div style="margin-bottom:6px;padding:4px 0;border-bottom:1px solid var(--border)">
      <div style="display:flex;align-items:center;gap:4px;margin-bottom:2px">
        <input
          class="field-input"
          .value=${live(mediaDisplayName(name))}
          style="flex:1;font-weight:600;font-size:12px"
          @input=${(e: Event) => {
            const newKey = friendlyNameToMedia((e.target as HTMLInputElement).value);
            currentRawLabel = newKey || "";
            const rawEl = (e.target as HTMLElement).parentElement?.querySelector(".bp-raw-label");
            if (rawEl) rawEl.textContent = currentRawLabel;
            clearTimeout(debounceTimer);
            debounceTimer = setTimeout(() => {
              if (newKey && newKey !== name) {
                const queryEl = (e.target as HTMLElement)
                  .closest("div[style]")
                  ?.parentElement?.querySelector(".bp-query-input") as HTMLInputElement | null;
                transactDoc(activeTab.value, (t) => {
                  mutateUpdateMedia(t, name, undefined);
                  mutateUpdateMedia(t, newKey, queryEl?.value || query);
                });
              }
            }, 600);
          }}
        />
        <span
          class="bp-raw-label"
          style="font-size:10px;color:var(--fg-dim);font-family:'SF Mono','Fira Code',monospace;white-space:nowrap"
          >${name}</span
        >
        <span
          class="kv-del"
          @click=${() => transactDoc(activeTab.value, (t) => mutateUpdateMedia(t, name, undefined))}
          >✕</span
        >
      </div>
      <div style="display:flex;gap:4px;align-items:center">
        <input
          class="field-input bp-query-input"
          .value=${live(query)}
          style="flex:1"
          @input=${(e: Event) => {
            clearTimeout(debounceTimer);
            debounceTimer = setTimeout(
              () =>
                transactDoc(activeTab.value, (t) =>
                  mutateUpdateMedia(t, name, (e.target as HTMLInputElement).value),
                ),
              400,
            );
          }}
        />
      </div>
    </div>
  `;
}

// ─── Layout picker ──────────────────────────────────────────────────────────

/** @type {{ name: string; path: string }[] | null} */
let layoutEntries: { name: string; path: string }[] | null = null;

async function loadLayoutEntries() {
  try {
    const platform = getPlatform();
    const listing = await platform.listDirectory("layouts");
    layoutEntries = listing
      .filter((f: DirEntry) => f.type === "file" && f.name.endsWith(".json"))
      .map((f: DirEntry) => ({
        name: f.name.replace(/\.json$/, ""),
        path: `./layouts/${f.name}`,
      }));
  } catch {
    layoutEntries = [];
  }
  renderOnly("rightPanel");
}

export function invalidateLayoutPickerCache() {
  layoutEntries = null;
}

function isPageDocument(documentPath: string | undefined | null) {
  if (!documentPath || !projectState?.isSiteProject) return false;
  return documentPath.startsWith("pages/") || documentPath.startsWith("./pages/");
}

function renderPageSection(node: JxMutableNode) {
  const tab = activeTab.value;
  if (!isPageDocument(tab!.documentPath)) return nothing;

  if (layoutEntries === null) {
    loadLayoutEntries();
    return nothing;
  }

  const currentLayout = node.$layout;
  const defaultLayout = projectState?.projectConfig?.defaults?.layout;
  const effectivePath = getEffectiveLayoutPath(currentLayout);
  const displayValue =
    currentLayout === false ? "__none__" : currentLayout ? currentLayout : "__default__";

  return html`
    <sp-accordion-item label="Page" open>
      <div class="style-section-body">
        <div class="style-row" data-prop="$layout">
          <div class="style-row-label">
            ${currentLayout !== undefined
              ? html`<span
                  class="set-dot"
                  title="Reset to default"
                  @click=${(e: Event) => {
                    e.stopPropagation();
                    transactDoc(activeTab.value, (t) =>
                      mutateUpdateProperty(t, [], "$layout", undefined),
                    );
                  }}
                ></span>`
              : nothing}
            <sp-field-label size="s">Layout</sp-field-label>
          </div>
          <sp-picker
            size="s"
            value=${displayValue}
            @change=${(e: Event) => {
              const val = (e.target as HTMLInputElement).value;
              if (val === "__default__") {
                transactDoc(activeTab.value, (t) =>
                  mutateUpdateProperty(t, [], "$layout", undefined),
                );
              } else if (val === "__none__") {
                transactDoc(activeTab.value, (t) => mutateUpdateProperty(t, [], "$layout", false));
              } else {
                transactDoc(activeTab.value, (t) => mutateUpdateProperty(t, [], "$layout", val));
              }
              invalidateLayoutCache();
            }}
          >
            <sp-menu-item value="__default__"
              >Default${defaultLayout
                ? ` (${defaultLayout.replace(/^\.\/layouts\//, "").replace(/\.json$/, "")})`
                : ""}</sp-menu-item
            >
            <sp-menu-item value="__none__">None</sp-menu-item>
            <sp-menu-divider></sp-menu-divider>
            ${layoutEntries!.map(
              (l: { name: string; path: string }) =>
                html`<sp-menu-item value=${l.path}>${l.name}</sp-menu-item>`,
            )}
          </sp-picker>
        </div>
        ${effectivePath
          ? html`<div style="font-size:10px;color:var(--fg-dim);padding:2px 0;font-style:italic">
              Wraps page content via &lt;slot&gt; distribution
            </div>`
          : nothing}
      </div>
    </sp-accordion-item>
  `;
}

// ─── Layout selection panel ─────────────────────────────────────────────────

function renderLayoutSelectionPanel(ctx: { navigateToComponent: (path: string) => void }) {
  const { el, layoutPath } = view.layoutSelection as { el: HTMLElement; layoutPath: string };
  const tagName = el?.tagName?.toLowerCase() || "element";
  const className = el?.className || "";
  const displayPath = layoutPath || "layout";

  return html`
    <div class="style-sidebar">
      <sp-accordion allow-multiple size="s">
        <sp-accordion-item label="Layout Element" open>
          <div class="style-section-body">
            <div style="display:flex;align-items:center;gap:6px;margin-bottom:8px">
              <span
                style="font-size:9px;padding:2px 6px;background:var(--spectrum-purple-600);color:white;border-radius:3px;text-transform:uppercase;letter-spacing:0.5px"
                >Layout</span
              >
              <code style="font-size:12px;font-family:monospace">&lt;${tagName}&gt;</code>
            </div>
            ${className
              ? html`<div class="style-row">
                  <div class="style-row-label">
                    <sp-field-label size="s">Class</sp-field-label>
                  </div>
                  <span style="font-size:11px;color:var(--fg-dim);word-break:break-all"
                    >${className}</span
                  >
                </div>`
              : nothing}
            <div style="font-size:10px;color:var(--fg-dim);padding:4px 0;font-style:italic">
              This element is part of the page layout. Edit it by opening the layout file.
            </div>
            <span class="kv-add" @click=${() => ctx.navigateToComponent(displayPath)}
              >Open Layout →</span
            >
          </div>
        </sp-accordion-item>
      </sp-accordion>
    </div>
  `;
}

// ─── Main entry point ───────────────────────────────────────────────────────

/**
 * Properties panel — lit-html template with accordion sections.
 *
 * @param {{ navigateToComponent: (path: string) => void }} ctx
 */
export function renderPropertiesPanelTemplate(ctx: {
  navigateToComponent: (path: string) => void;
}) {
  const tab = activeTab.value;
  if (!tab) return html`<div class="empty-state">No document loaded</div>`;

  // Layout element selected — show read-only info with link to open layout
  if (view.layoutSelection) {
    return renderLayoutSelectionPanel(ctx);
  }

  if (!tab.session.selection) {
    return html`<div class="empty-state">Select an element to inspect</div>`;
  }
  const node = getNodeAtPath(tab.doc.document, tab.session.selection);
  if (!node) return html`<div class="empty-state">Node not found</div>`;

  const path = tab.session.selection;
  const isMapNode = node.$prototype === "Array";
  const isMapParent =
    node.children &&
    typeof node.children === "object" &&
    (node.children as unknown as { $prototype?: string }).$prototype === "Array";
  const isSwitchNode = !!node.$switch;
  const isCustomInstance = (node.tagName || "").includes("-");
  const isRoot = path.length === 0;
  const tagName = node.tagName || "div";
  const attrs = node.attributes || {};

  const mapSignals = isInsideMapTemplate(path)
    ? [
        { value: "$map/item", label: "$map/item" },
        { value: "$map/index", label: "$map/index" },
      ]
    : null;

  function renderAttrRow(attr: string, entry: HtmlMetaEntry, value: unknown) {
    const type = inferInputType(entry);
    const hasVal = value !== undefined && value !== "";

    if (entry.type === "boolean") {
      return renderFieldRow({
        prop: attr,
        label: attrLabel(entry, attr),
        hasValue: hasVal,
        onClear: () =>
          transactDoc(activeTab.value, (t) => mutateUpdateAttribute(t, path, attr, undefined)),
        widget: html`
          <sp-checkbox
            size="s"
            .checked=${live(!!value)}
            @change=${(e: Event) =>
              transactDoc(activeTab.value, (t) =>
                mutateUpdateAttribute(
                  t,
                  path,
                  attr,
                  (e.target as HTMLInputElement).checked ? "" : undefined,
                ),
              )}
          >
          </sp-checkbox>
        `,
      });
    }

    return renderFieldRow({
      prop: attr,
      label: attrLabel(entry, attr),
      hasValue: hasVal,
      onClear: () =>
        transactDoc(activeTab.value, (t) => mutateUpdateAttribute(t, path, attr, undefined)),
      widget: widgetForType(type, entry, attr, String(value || ""), (v: string) =>
        transactDoc(activeTab.value!, (t) => mutateUpdateAttribute(t, path, attr, v || undefined)),
      ),
    });
  }

  // ── Collect applicable attributes from html-meta ──
  const applicableAttrs = {} as Record<string, HtmlMetaEntry>;
  for (const [attr, entry] of Object.entries(htmlMeta.$defs) as [string, HtmlMetaEntry][]) {
    if (!entry.$elements || entry.$elements.includes(tagName)) {
      applicableAttrs[attr] = entry;
    }
  }

  const attrSections: Record<string, { name: string; entry: HtmlMetaEntry }[]> = {};
  for (const sec of htmlMeta.$sections) attrSections[sec.key] = [];
  for (const [attr, entry] of Object.entries(applicableAttrs)) {
    const secKey = entry.$section;
    if (attrSections[secKey]) attrSections[secKey].push({ name: attr, entry });
  }
  for (const sec of htmlMeta.$sections) {
    attrSections[sec.key].sort(
      (a: { name: string; entry: HtmlMetaEntry }, b: { name: string; entry: HtmlMetaEntry }) =>
        a.entry.$order - b.entry.$order,
    );
  }

  const knownAttrNames = new Set(Object.keys(applicableAttrs));
  if (isCustomInstance) {
    const comp = componentRegistry.find((c) => c.tagName === node.tagName);
    if (comp?.props) for (const p of comp.props) knownAttrNames.add(p.name);
  }
  const customAttrs = Object.entries(attrs).filter(([k]) => !knownAttrNames.has(k));

  const autoOpen = new Set();
  for (const [attr] of Object.entries(attrs)) {
    const entry = applicableAttrs[attr];
    if (entry) autoOpen.add(entry.$section);
  }
  if (customAttrs.length > 0) autoOpen.add("__custom");

  function isSectionOpen(key: string) {
    if (tab!.session.ui.inspectorSections[key] !== undefined)
      return tab!.session.ui.inspectorSections[key];
    return autoOpen.has(key);
  }

  function toggleSection(key: string) {
    const current = isSectionOpen(key);
    activeTab.value!.session.ui.inspectorSections = {
      ...activeTab.value!.session.ui.inspectorSections,
      [key]: !current,
    };
  }

  // ── Build section templates ─────────────────────────────────────────

  const elemT = html`
    <sp-accordion-item
      label="Element"
      ?open=${isSectionOpen("__element") !== false}
      @sp-accordion-item-toggle=${() => toggleSection("__element")}
    >
      <div class="style-section-body">
        <div class="style-row" data-prop="tagName">
          <div class="style-row-label">
            <sp-field-label size="s">Tag</sp-field-label>
          </div>
          <sp-textfield
            size="s"
            .value=${live(tagName)}
            autocomplete="off"
            list="tag-names"
            @input=${debouncedStyleCommit("prop:tagName", 400, (e: Event) => {
              transactDoc(activeTab.value, (t) =>
                mutateUpdateProperty(
                  t,
                  path,
                  "tagName",
                  (e.target as HTMLInputElement).value || undefined,
                ),
              );
            })}
          ></sp-textfield>
        </div>
        <div class="style-row" data-prop="$id">
          <div class="style-row-label">
            ${node.$id
              ? html`<span
                  class="set-dot"
                  title="Clear $id"
                  @click=${(e: Event) => {
                    e.stopPropagation();
                    transactDoc(activeTab.value, (t) =>
                      mutateUpdateProperty(t, path, "$id", undefined),
                    );
                  }}
                ></span>`
              : nothing}
            <sp-field-label size="s">ID</sp-field-label>
          </div>
          <sp-textfield
            size="s"
            .value=${live(node.$id || "")}
            @input=${debouncedStyleCommit("prop:$id", 400, (e: Event) => {
              transactDoc(activeTab.value, (t) =>
                mutateUpdateProperty(
                  t,
                  path,
                  "$id",
                  (e.target as HTMLInputElement).value || undefined,
                ),
              );
            })}
          ></sp-textfield>
        </div>
        <div class="style-row" data-prop="className">
          <div class="style-row-label">
            ${node.className
              ? html`<span
                  class="set-dot"
                  title="Clear class"
                  @click=${(e: Event) => {
                    e.stopPropagation();
                    transactDoc(activeTab.value, (t) =>
                      mutateUpdateProperty(t, path, "className", undefined),
                    );
                  }}
                ></span>`
              : nothing}
            <sp-field-label size="s">Class</sp-field-label>
          </div>
          <sp-textfield
            size="s"
            .value=${live(node.className || "")}
            @input=${debouncedStyleCommit("prop:className", 400, (e: Event) => {
              transactDoc(activeTab.value, (t) =>
                mutateUpdateProperty(
                  t,
                  path,
                  "className",
                  (e.target as HTMLInputElement).value || undefined,
                ),
              );
            })}
          ></sp-textfield>
        </div>
        ${!Array.isArray(node.children) || node.children.length === 0
          ? html`
              <div class="style-row" data-prop="textContent">
                <div class="style-row-label">
                  ${node.textContent !== undefined
                    ? html`<span
                        class="set-dot"
                        title="Clear text"
                        @click=${(e: Event) => {
                          e.stopPropagation();
                          transactDoc(activeTab.value, (t) =>
                            mutateUpdateProperty(t, path, "textContent", undefined),
                          );
                        }}
                      ></span>`
                    : nothing}
                  <sp-field-label size="s">Text Content</sp-field-label>
                </div>
                <sp-textfield
                  size="s"
                  multiline
                  .value=${live(
                    typeof node.textContent === "string"
                      ? node.textContent
                      : (node.textContent ?? ""),
                  )}
                  @input=${debouncedStyleCommit("prop:textContent", 400, (e: Event) => {
                    transactDoc(activeTab.value, (t) =>
                      mutateUpdateProperty(
                        t,
                        path,
                        "textContent",
                        (e.target as HTMLInputElement).value || undefined,
                      ),
                    );
                  })}
                ></sp-textfield>
              </div>
            `
          : nothing}
        <div class="style-row" data-prop="hidden">
          <div class="style-row-label">
            ${node.hidden
              ? html`<span
                  class="set-dot"
                  title="Clear hidden"
                  @click=${(e: Event) => {
                    e.stopPropagation();
                    transactDoc(activeTab.value, (t) =>
                      mutateUpdateProperty(t, path, "hidden", undefined),
                    );
                  }}
                ></span>`
              : nothing}
            <sp-field-label size="s">Hidden</sp-field-label>
          </div>
          <sp-checkbox
            size="s"
            .checked=${live(!!node.hidden)}
            @change=${(e: Event) =>
              transactDoc(activeTab.value, (t) =>
                mutateUpdateProperty(
                  t,
                  path,
                  "hidden",
                  (e.target as HTMLInputElement).checked || undefined,
                ),
              )}
          >
          </sp-checkbox>
        </div>
        ${isMapParent
          ? html`
              <div style="font-size:10px;color:var(--fg-dim);padding:4px 0;font-style:italic">
                Children: Repeater (select in layers to configure)
              </div>
            `
          : nothing}
      </div>
    </sp-accordion-item>
  `;

  const repeaterT = isMapNode
    ? html`
        <sp-accordion-item label="Repeater" open>
          <div class="style-section-body">
            ${renderRepeaterFieldsTemplate(node, path, mapSignals)}
          </div>
        </sp-accordion-item>
      `
    : nothing;

  const switchT = isSwitchNode
    ? html`
        <sp-accordion-item label="Switch" open>
          <div class="style-section-body">
            ${renderSwitchFieldsTemplate(node, path, mapSignals)}
          </div>
        </sp-accordion-item>
      `
    : nothing;

  const observedAttrsT =
    isCustomElementDoc({ document: tab.doc.document }) && isRoot
      ? (() => {
          const state = tab.doc.document.state || {};
          const entries = Object.entries(state).filter(
            ([, d]) => (d as Record<string, unknown>).attribute,
          );
          return html`
            <sp-accordion-item label="Observed Attributes" ?open=${isSectionOpen("__observed")}>
              <div class="style-section-body">
                ${entries.length === 0
                  ? html`<div class="empty-state">
                      No attributes declared. Set "attribute" on a state entry.
                    </div>`
                  : entries.map(([key, d]) => {
                      const def = d as Record<string, unknown>;
                      return html`
                        <div
                          style="display:flex;gap:6px;align-items:center;padding:2px 0;font-size:11px"
                        >
                          <code style="font-family:monospace;color:var(--accent)"
                            >${def.attribute}</code
                          >
                          <span style="color:var(--fg-dim)"> → </span>
                          <span>${key}</span>
                          ${def.type
                            ? html`<span style="margin-left:auto;color:var(--fg-dim);font-size:10px"
                                >${def.type}</span
                              >`
                            : nothing}
                          ${def.reflects
                            ? html`<span
                                style="font-size:9px;background:var(--bg-hover);padding:1px 4px;border-radius:3px"
                                >reflects</span
                              >`
                            : nothing}
                        </div>
                      `;
                    })}
              </div>
            </sp-accordion-item>
          `;
        })()
      : nothing;

  const compPropsT = isCustomInstance
    ? html`
        <sp-accordion-item label="Component Props" open>
          <div class="style-section-body">
            ${renderComponentPropsFieldsTemplate(node, path, mapSignals, ctx.navigateToComponent)}
          </div>
        </sp-accordion-item>
      `
    : nothing;

  const attrSectionTemplates = htmlMeta.$sections
    .filter((sec) => attrSections[sec.key].length > 0)
    .map((sec) => {
      const sectionAttrs = attrSections[sec.key];
      const hasAnySet = sectionAttrs.some(
        (a: { name: string; entry: HtmlMetaEntry }) => attrs[a.name] !== undefined,
      );
      return html`
        <sp-accordion-item
          label=${sec.label}
          ?open=${isSectionOpen(sec.key)}
          @sp-accordion-item-toggle=${() => toggleSection(sec.key)}
        >
          ${hasAnySet
            ? html`<span slot="heading" class="set-dot set-dot--section"></span>`
            : nothing}
          <div class="style-section-body">
            ${sectionAttrs.map((a: { name: string; entry: HtmlMetaEntry }) =>
              renderAttrRow(a.name, a.entry, attrs[a.name]),
            )}
          </div>
        </sp-accordion-item>
      `;
    });

  const customSectionT =
    customAttrs.length > 0 || Object.keys(attrs).length > 0
      ? html`
          <sp-accordion-item
            label="Custom"
            ?open=${isSectionOpen("__custom")}
            @sp-accordion-item-toggle=${() => toggleSection("__custom")}
          >
            ${customAttrs.length > 0
              ? html`<span slot="heading" class="set-dot set-dot--section"></span>`
              : nothing}
            <div class="style-section-body">
              ${renderCustomAttrsFieldsTemplate(node, path, attrs, knownAttrNames)}
            </div>
          </sp-accordion-item>
        `
      : nothing;

  const mediaT = isRoot
    ? html`
        <sp-accordion-item
          label="Media"
          ?open=${isSectionOpen("__media")}
          @sp-accordion-item-toggle=${() => toggleSection("__media")}
        >
          <div class="style-section-body">${renderMediaFieldsTemplate(node)}</div>
        </sp-accordion-item>
      `
    : nothing;

  const cssPropsT =
    isCustomElementDoc({ document: tab.doc.document }) && isRoot
      ? (() => {
          const style = node.style || {};
          const cssProps = Object.entries(style).filter(([k]) => k.startsWith("--"));
          if (cssProps.length === 0) return nothing;
          return html`
            <sp-accordion-item
              label="CSS Properties"
              ?open=${isSectionOpen("__cssprops")}
              @sp-accordion-item-toggle=${() => toggleSection("__cssprops")}
            >
              <div class="style-section-body">
                ${cssProps.map(
                  ([prop, val]) => html`
                    <div
                      style="display:flex;gap:6px;align-items:center;padding:2px 0;font-size:11px"
                    >
                      <code style="font-family:monospace;color:var(--accent)">${prop}</code>
                      <span style="margin-left:auto;color:var(--fg-dim)">${String(val)}</span>
                    </div>
                  `,
                )}
              </div>
            </sp-accordion-item>
          `;
        })()
      : nothing;

  const cssPartsT =
    isCustomElementDoc({ document: tab.doc.document }) && isRoot
      ? (() => {
          const parts = collectCssParts(tab.doc.document);
          if (parts.length === 0) return nothing;
          return html`
            <sp-accordion-item
              label="CSS Parts"
              ?open=${isSectionOpen("__cssparts")}
              @sp-accordion-item-toggle=${() => toggleSection("__cssparts")}
            >
              <div class="style-section-body">
                ${parts.map(
                  (p) => html`
                    <div
                      style="display:flex;gap:6px;align-items:center;padding:2px 0;font-size:11px"
                    >
                      <code style="font-family:monospace;color:var(--accent)">${p.name}</code>
                      <span style="color:var(--fg-dim)">&lt;${p.tag}&gt;</span>
                    </div>
                  `,
                )}
              </div>
            </sp-accordion-item>
          `;
        })()
      : nothing;

  const pageT = isRoot ? renderPageSection(node) : nothing;

  // ── Assemble ──
  const tpl = html`
    <div class="style-sidebar">
      <sp-accordion allow-multiple size="s">
        ${pageT} ${isMapNode ? repeaterT : elemT} ${isMapNode ? nothing : observedAttrsT}
        ${isMapNode ? nothing : switchT} ${isMapNode ? nothing : compPropsT}
        ${isMapNode ? nothing : attrSectionTemplates} ${isMapNode ? nothing : customSectionT}
        ${isMapNode ? nothing : mediaT} ${isMapNode ? nothing : cssPropsT}
        ${isMapNode ? nothing : cssPartsT}
      </sp-accordion>
    </div>
  `;

  return tpl;
}
