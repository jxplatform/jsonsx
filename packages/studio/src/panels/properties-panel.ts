/// <reference lib="dom" />
/** Properties panel — inspector for element attributes, component props, media, and frontmatter. */

import { html, nothing } from "lit-html";
import { live } from "lit-html/directives/live.js";
import { debouncedStyleCommit, getNodeAtPath, projectState, renderOnly } from "../store";
import { isRef } from "@jxsuite/schema/guards";
import type { DirEntry, JsonValue } from "../types";
import {
  mutateAddSwitchCase,
  mutateRemoveSwitchCase,
  mutateRenameSwitchCase,
  mutateUpdateAttribute,
  mutateUpdateMedia,
  mutateUpdateProp,
  mutateUpdateProperty,
  transactDoc,
} from "../tabs/transact";
import { activeTab } from "../workspace/workspace";
import { setLayoutSelection, view } from "../view";
import type { LayoutSelection } from "../view";
import { componentRegistry } from "../files/components";
import { widgetForType } from "./style-inputs";
import { renderFieldRow } from "../ui/field-row";
import { renderDynamicSlot, slotMode } from "../ui/dynamic-slot";
import { spTextArea, spTextField } from "../ui/field-input";
import {
  attrLabel,
  camelToLabel,
  friendlyNameToVar,
  inferInputType,
  parseCemType,
} from "../utils/studio-utils";
import { classifyHref, composeHref } from "../utils/link-target";
import type { LinkKind } from "../utils/link-target";
import {
  clickAnythingTo,
  openPageAction,
  renderEmptyState,
  staleSelectionMessage,
} from "./empty-state";
import { collectCssParts, isCustomElementDoc } from "./signals-panel";
import { mediaDisplayName } from "./shared";
import { getCssInitialMap } from "./style-utils";
import { renderMediaPicker } from "../ui/media-picker";
import { renderColorSelector } from "../ui/color-selector";
import { getEffectiveLayoutPath, invalidateLayoutCache } from "../site-context";
import { getPlatform } from "../platform";
import htmlMeta from "../../data/html-meta.json";

import type {
  JxAttributeValue,
  JxMutableNode,
  JxPrototypeDef,
  JxStateDefinition,
  JxStateObject,
} from "@jxsuite/schema/types";
import type { SlotMode } from "../ui/dynamic-slot";
import type { JxPath } from "../state";
import type { SignalDef } from "./signals-panel.js";

interface SignalOption {
  value: string;
  label: string;
}

interface HtmlMetaEntry {
  $section: string;
  $order: number;
  $attr?: string;
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
  if (!path) {
    return false;
  }
  // A "map" segment addresses a repeater template (`[…, "children", i, "map", …]`, or the legacy
  // `[…, "children", "map", …]`), so anything at or below it is inside a map template.
  return path.includes("map");
}

/**
 * Render a state entry's default value as the static input text when unbinding.
 *
 * @param {import("@jxsuite/schema/types").JxStateDefinition | undefined} def
 * @returns {string}
 */
function defaultAsString(def: JxStateDefinition | undefined) {
  if (!def || typeof def !== "object" || Array.isArray(def)) {
    return "";
  }
  const dv = (def as JxStateObject).default;
  if (dv === undefined) {
    return "";
  }
  return typeof dv === "object" ? JSON.stringify(dv) : String(dv);
}

/**
 * Field row with binding toggle — allows switching between static value and signal binding.
 * rawValue can be a JSON literal (static) or { $ref: "..." } (bound).
 */
function bindableFieldRow(
  label: string,
  type: string,
  rawValue: unknown,
  onChange: (v?: JsonValue) => void,
  filterFn: ((d: SignalDef) => boolean) | null = null,
  extraSignals: SignalOption[] | null = null,
  fieldKey = `prop:${label}`,
  caps: SlotMode[] = ["literal", "ref"],
) {
  const tab = activeTab.value;
  const defs = tab!.doc.document.state || {};
  const boundRef = isRef(rawValue) ? rawValue.$ref : null;
  const isDynamic = slotMode(rawValue) !== "literal";

  const signalDefs = Object.entries(defs).filter(([, d]) =>
    filterFn
      ? filterFn(d as SignalDef)
      : !(d as Record<string, unknown>)?.$handler &&
        (d as JxPrototypeDef)?.$prototype !== "Function",
  );

  const staticVal = isDynamic ? "" : (rawValue ?? "");
  const draftKey = `prop:${label}`;
  const staticTpl =
    type === "textarea"
      ? spTextArea(draftKey, String(staticVal), (v: string) => onChange(v))
      : type === "checkbox"
        ? html`<sp-checkbox
            ?checked=${Boolean(staticVal)}
            @change=${(e: Event) => onChange((e.target as HTMLInputElement).checked)}
          ></sp-checkbox>`
        : spTextField(draftKey, String(staticVal), (v: string) => onChange(v));

  // De-escalating to literal restores the bound signal's declared default (old unbind behavior).
  const literalDefault = boundRef
    ? defaultAsString(defs[boundRef.startsWith("#/state/") ? boundRef.slice(8) : boundRef]) ||
      undefined
    : undefined;

  const slot = renderDynamicSlot({
    caps,
    extraSignals,
    fieldKey,
    literalDefault,
    onChange,
    staticWidget: staticTpl,
    stateDefs: signalDefs.map(([defName]) => defName),
    value: rawValue,
  });
  return html`
    <div class="field-row">
      <sp-field-label size="s">${label}</sp-field-label>
      ${slot.modeButton} ${slot.widget}
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
        @change=${
          datalistId === "css-props"
            ? (e: Event) => {
                const el = (e.target as HTMLInputElement)
                  .closest(".kv-row")
                  ?.querySelector(".kv-val");
                if (el) {
                  el.setAttribute(
                    "placeholder",
                    getCssInitialMap().get((e.target as HTMLInputElement).value) || "",
                  );
                }
              }
            : nothing
        }
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
    ${bindableFieldRow(
      "Items",
      "text",
      node.items,
      (v: JsonValue) =>
        transactDoc(activeTab.value, (t) => mutateUpdateProperty(t, path, "items", v)),
      null,
      null,
      `prop|${path.join("/")}|items`,
    )}
    ${
      node.filter
        ? bindableFieldRow(
            "Filter",
            "text",
            node.filter,
            (v: JsonValue) =>
              transactDoc(activeTab.value, (t) =>
                mutateUpdateProperty(t, path, "filter", v || undefined),
              ),
            null,
            null,
            `prop|${path.join("/")}|filter`,
          )
        : nothing
    }
    ${
      node.sort
        ? bindableFieldRow(
            "Sort",
            "text",
            node.sort,
            (v: JsonValue) =>
              transactDoc(activeTab.value, (t) =>
                mutateUpdateProperty(t, path, "sort", v || undefined),
              ),
            null,
            null,
            `prop|${path.join("/")}|sort`,
          )
        : nothing
    }
    <div style="display:flex;gap:8px;margin-top:4px">
      ${
        !node.filter
          ? html`<span
              class="kv-add"
              @click=${() =>
                transactDoc(activeTab.value, (t) =>
                  mutateUpdateProperty(t, path, "filter", { $ref: "#/state/" }),
                )}
              >+ Add filter</span
            >`
          : nothing
      }
      ${
        !node.sort
          ? html`<span
              class="kv-add"
              @click=${() =>
                transactDoc(activeTab.value, (t) =>
                  mutateUpdateProperty(t, path, "sort", { $ref: "#/state/" }),
                )}
              >+ Add sort</span
            >`
          : nothing
      }
    </div>
    ${
      node.map
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
        : nothing
    }
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
      `prop|${path.join("/")}|$switch`,
      // No literal rung: a $switch is inherently dynamic.
      // De-escalating to literal would delete the key and demote the node mid-cycle.
      ["ref", "template"],
    )}
    <div
      style="font-size:var(--spectrum-font-size-50, 11px);font-weight:600;color:var(--fg-dim);margin:8px 0 4px;text-transform:uppercase;letter-spacing:0.05em"
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
                ) {
                  transactDoc(activeTab.value, (t) =>
                    mutateRenameSwitchCase(t, path, caseName, (e.target as HTMLInputElement).value),
                  );
                }
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
            style="cursor:pointer;color:var(--danger);font-size:var(--spectrum-font-size-50, 11px)"
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
  if (!comp || !comp.props) {
    return renderEmptyState({
      compact: true,
      message: "This component is not in the project's library, so it has no settings to show.",
    });
  }
  const isNpm = comp.source === "npm";
  const currentVals = isNpm ? node.attributes || {} : node.$props || {};
  const updateFn = isNpm
    ? (name: string, v?: JsonValue) =>
        transactDoc(activeTab.value, (t) =>
          mutateUpdateAttribute(
            t,
            path,
            name,
            v === "" ? undefined : (v as JxAttributeValue | undefined),
          ),
        )
    : (name: string, v?: JsonValue) =>
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
        const boundRef = isRef(rawValue) ? rawValue.$ref : null;
        const hasVal = rawValue !== undefined && rawValue !== null;
        const parsed = parseCemType(prop.type);
        const onChange = (v?: JsonValue) => updateFn(prop.name, v);
        const staticVal = slotMode(rawValue) === "literal" ? String(rawValue ?? "") : "";

        const clearProp = (e: Event) => {
          e.stopPropagation();
          updateFn(prop.name);
        };

        // De-escalating to literal restores the bound signal's declared default (old unbind behavior).
        const literalDefault = boundRef
          ? defaultAsString(defs[boundRef.startsWith("#/state/") ? boundRef.slice(8) : boundRef]) ||
            undefined
          : undefined;

        /** @type {ReturnType<typeof setTimeout> | undefined} */
        let debounce: ReturnType<typeof setTimeout> | undefined;
        let widgetTpl;
        if (prop.format === "image") {
          widgetTpl = renderMediaPicker(prop.name, staticVal, onChange);
        } else if (prop.format === "color") {
          widgetTpl = renderColorSelector(prop.name, staticVal, onChange);
        } else if (prop.format === "date") {
          widgetTpl = spTextField(
            `cprop:${prop.name}`,
            String(staticVal),
            (v: string) => onChange(v),
            {
              placeholder: "YYYY-MM-DD",
            },
          );
        } else if (parsed.kind === "boolean") {
          widgetTpl = html`<sp-checkbox
            size="s"
            .checked=${live(Boolean(staticVal))}
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
          const options = /** @type {{ options?: string[] }} */ parsed.options as string[];
          widgetTpl = html`<jx-value-selector
            .value=${String(staticVal)}
            size="s"
            placeholder="—"
            .options=${options.map((o) => ({
              label: camelToLabel(o),
              value: o,
            }))}
            @change=${(e: Event & { detail?: { value?: string } }) =>
              onChange(e.detail?.value ?? (e.target as HTMLInputElement).value)}
          ></jx-value-selector>`;
        } else {
          widgetTpl = spTextField(`cprop:${prop.name}`, String(staticVal), (v: string) =>
            onChange(v),
          );
        }

        const slot = renderDynamicSlot({
          caps: ["literal", "ref", "template"],
          extraSignals,
          fieldKey: `cprop|${path.join("/")}|${prop.name}`,
          literalDefault,
          onChange,
          staticWidget: widgetTpl,
          stateDefs: signalDefs.map(([defName]) => defName),
          value: rawValue,
        });
        return html`
          <div class="style-row" data-prop=${prop.name}>
            <div class="style-row-label">
              ${
                hasVal
                  ? html`<span
                      class="set-dot"
                      title="Clear ${prop.name}"
                      @click=${clearProp}
                    ></span>`
                  : nothing
              }
              <sp-field-label size="s" title=${prop.description || prop.name}
                >${camelToLabel(prop.name)}</sp-field-label
              >
              ${slot.modeButton}
            </div>
            ${slot.widget}
          </div>
        `;
      },
    )}
    ${
      comp.props.length === 0
        ? renderEmptyState({
            compact: true,
            message: "This component has no settings to fill in yet.",
          })
        : nothing
    }
    ${
      comp.path
        ? html`<span class="kv-add" @click=${() => navigateToComponent(comp.path!)}
            >→ Edit definition</span
          >`
        : nothing
    }
  `;
}

/** Custom attrs fields template */
function renderCustomAttrsFieldsTemplate(
  _node: JxMutableNode,
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
              mutateUpdateAttribute(t, path, attr);
              mutateUpdateAttribute(t, path, newAttr, newVal);
            });
          } else {
            transactDoc(activeTab.value, (t) => mutateUpdateAttribute(t, path, attr, newVal));
          }
        },
        () => transactDoc(activeTab.value, (t) => mutateUpdateAttribute(t, path, attr)),
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
      ${
        media["--"]
          ? html`<span
              class="kv-del"
              @click=${() => transactDoc(activeTab.value, (t) => mutateUpdateMedia(t, "--"))}
              >✕</span
            >`
          : nothing
      }
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
      ${
        view.showAddBreakpointForm
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
                    style="font-size:10px;color:var(--fg-dim);font-family:var(--font-mono);white-space:nowrap"
                    >${view.addBreakpointPreview}</span
                  >
                </div>
                <div style="display:flex;gap:4px;margin-bottom:3px;align-items:center">
                  <input
                    class="field-input add-bp-query"
                    value="(min-width: 768px)"
                    style="flex:1"
                  />
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
          : nothing
      }
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
          style="flex:1;font-weight:600;font-size:var(--spectrum-font-size-75, 12px)"
          @input=${(e: Event) => {
            const newKey = friendlyNameToMedia((e.target as HTMLInputElement).value);
            currentRawLabel = newKey || "";
            const rawEl = (e.target as HTMLElement).parentElement?.querySelector(".bp-raw-label");
            if (rawEl) {
              rawEl.textContent = currentRawLabel;
            }
            clearTimeout(debounceTimer);
            debounceTimer = setTimeout(() => {
              if (newKey && newKey !== name) {
                const queryEl = (e.target as HTMLElement)
                  .closest("div[style]")
                  ?.parentElement?.querySelector(".bp-query-input") as HTMLInputElement | null;
                transactDoc(activeTab.value, (t) => {
                  mutateUpdateMedia(t, name);
                  mutateUpdateMedia(t, newKey, queryEl?.value || query);
                });
              }
            }, 600);
          }}
        />
        <span
          class="bp-raw-label"
          style="font-size:10px;color:var(--fg-dim);font-family:var(--font-mono);white-space:nowrap"
          >${name}</span
        >
        <span
          class="kv-del"
          @click=${() => transactDoc(activeTab.value, (t) => mutateUpdateMedia(t, name))}
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
  if (!documentPath || !projectState?.isSiteProject) {
    return false;
  }
  return documentPath.startsWith("pages/") || documentPath.startsWith("./pages/");
}

// ─── Page-route enumeration (for the Link-target Internal picker) ─────────────

/** @type {string[] | null} — cached list of internal routes derived from the pages/ tree. */
let pageRouteEntries: string[] | null = null;

/**
 * Derive a site route from a page file path relative to `pages/`, following the file-based routing
 * convention: `index.json` → the directory route, `[slug].json` → `:slug`, all others drop their
 * extension. Directory routes get a trailing slash (`/about/`); the root is `/`.
 *
 * @param {string} relPath — path relative to `pages/`, forward-slashed (e.g. "blog/[slug].json").
 * @returns {string}
 */
function routeForPagePath(relPath: string): string {
  const withoutExt = relPath.replace(/\.[^./]+$/, "");
  const segments = withoutExt
    .split("/")
    .map((seg) => (seg.startsWith("[") ? `:${seg.slice(1, -1)}` : seg));
  const isIndex = segments.at(-1) === "index";
  if (isIndex) {
    segments.pop();
  }
  const body = segments.join("/");
  if (!body) {
    return "/";
  }
  // Dynamic routes keep no trailing slash; static routes are directory-style (trailing slash).
  return isIndex || body.includes(":") ? `/${body}${isIndex ? "/" : ""}` : `/${body}/`;
}

/** Recursively walk the pages/ tree and populate {@link pageRouteEntries} with derived routes. */
async function loadPageRouteEntries() {
  const platform = getPlatform();
  const routes: string[] = [];
  const docExts = new Set([".json", ".md", ".html"]);
  async function walk(dir: string, rel: string) {
    let listing: DirEntry[];
    try {
      listing = await platform.listDirectory(dir);
    } catch {
      return;
    }
    for (const entry of listing) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.type === "directory") {
        await walk(entry.path ?? `${dir}/${entry.name}`, childRel);
      } else if (docExts.has(entry.name.slice(entry.name.lastIndexOf(".")))) {
        routes.push(routeForPagePath(childRel));
      }
    }
  }
  await walk("pages", "");
  pageRouteEntries = [...new Set(routes)].toSorted((a, b) => a.localeCompare(b));
  renderOnly("rightPanel");
}

export function invalidatePageRouteCache() {
  pageRouteEntries = null;
}

/**
 * Composite Link-target control for an anchor's `href` — a kind selector (Internal / External /
 * Anchor / Email / Phone) plus the matching input, backed by classifyHref/composeHref so edits
 * round-trip. Internal targets render an sp-picker of page routes enumerated from the pages/ tree.
 *
 * @param {JxMutableNode} node
 * @param {JxPath} path
 */
function renderLinkTargetField(node: JxMutableNode, path: JxPath) {
  const raw = typeof node.attributes?.href === "string" ? node.attributes.href : "";
  const { kind, value } = classifyHref(raw);

  const commit = (nextKind: LinkKind, nextValue: string) => {
    const composed = composeHref(nextKind, nextValue);
    transactDoc(activeTab.value!, (t) =>
      mutateUpdateAttribute(t, path, "href", composed || undefined),
    );
  };

  const kindOptions: { value: LinkKind; label: string }[] = [
    { label: "Internal Page", value: "internal" },
    { label: "External URL", value: "external" },
    { label: "Anchor", value: "anchor" },
    { label: "Email", value: "mailto" },
    { label: "Phone", value: "tel" },
  ];

  const kindSelector = html`
    <sp-picker
      class="link-target-kind"
      size="s"
      value=${kind}
      @change=${(e: Event) => {
        const nextKind = (e.target as HTMLInputElement).value as LinkKind;
        // Switching kind reinterprets the current value under the new kind.
        commit(nextKind, value);
      }}
    >
      ${kindOptions.map((o) => html`<sp-menu-item value=${o.value}>${o.label}</sp-menu-item>`)}
    </sp-picker>
  `;

  let valueInput;
  if (kind === "internal") {
    if (pageRouteEntries === null) {
      void loadPageRouteEntries();
    }
    const routes = pageRouteEntries ?? [];
    const knownValue = value !== "" && !routes.includes(value);
    valueInput = html`
      <sp-picker
        class="link-target-value"
        size="s"
        value=${value}
        @change=${(e: Event) => commit("internal", (e.target as HTMLInputElement).value)}
      >
        ${knownValue ? html`<sp-menu-item value=${value}>${value}</sp-menu-item>` : nothing}
        ${routes.map((r) => html`<sp-menu-item value=${r}>${r}</sp-menu-item>`)}
      </sp-picker>
    `;
  } else {
    const placeholder =
      kind === "mailto"
        ? "name@example.com"
        : kind === "tel"
          ? "+15551234567"
          : kind === "anchor"
            ? "section-id"
            : "https://example.com";
    valueInput = html`
      <sp-textfield
        class="link-target-value"
        size="s"
        placeholder=${placeholder}
        .value=${live(value)}
        @input=${debouncedStyleCommit("link:href", 400, (e: Event) =>
          commit(kind, (e.target as HTMLInputElement).value),
        )}
      ></sp-textfield>
    `;
  }

  return renderFieldRow({
    hasValue: raw !== "",
    label: "Link",
    onClear: () => transactDoc(activeTab.value, (t) => mutateUpdateAttribute(t, path, "href")),
    prop: "href",
    widget: html`<div class="link-target-field">${kindSelector}${valueInput}</div>`,
  });
}

/**
 * Real enum picker (sp-picker) for the anchor `target` attribute, replacing the generic
 * jx-value-selector so the four browsing-context keywords are offered as a dropdown.
 *
 * @param {JxMutableNode} node
 * @param {JxPath} path
 * @param {HtmlMetaEntry} entry
 */
function renderTargetField(node: JxMutableNode, path: JxPath, entry: HtmlMetaEntry) {
  const options = Array.isArray(entry.enum) ? (entry.enum as string[]) : [];
  const current = typeof node.attributes?.target === "string" ? node.attributes.target : "";
  return renderFieldRow({
    hasValue: current !== "",
    label: attrLabel(entry, "target"),
    onClear: () => transactDoc(activeTab.value, (t) => mutateUpdateAttribute(t, path, "target")),
    prop: "target",
    widget: html`
      <sp-picker
        class="link-target-window"
        size="s"
        value=${current}
        @change=${(e: Event) =>
          transactDoc(activeTab.value!, (t) =>
            mutateUpdateAttribute(
              t,
              path,
              "target",
              (e.target as HTMLInputElement).value || undefined,
            ),
          )}
      >
        ${options.map((o) => html`<sp-menu-item value=${o}>${o}</sp-menu-item>`)}
      </sp-picker>
    `,
  });
}

/**
 * True when an attribute value is a binding (a `$ref` object or a template string containing
 * `${…}`), so the Link-target special-case must fall back to the raw widget to keep it editable.
 */
function isBoundAttrValue(value: unknown): boolean {
  return isRef(value) || (typeof value === "string" && value.includes("${"));
}

function renderPageSection(node: JxMutableNode) {
  const tab = activeTab.value;
  if (!isPageDocument(tab!.documentPath)) {
    return nothing;
  }

  if (layoutEntries === null) {
    void loadLayoutEntries();
    return nothing;
  }

  const currentLayout = node.$layout;
  const defaultLayout = projectState?.projectConfig?.defaults?.layout;
  const effectivePath = getEffectiveLayoutPath(currentLayout);
  const displayValue = currentLayout === false ? "__none__" : currentLayout || "__default__";

  return html`
    <sp-accordion-item label="Page" open>
      <div class="style-section-body">
        <div class="style-row" data-prop="$layout">
          <div class="style-row-label">
            ${
              currentLayout !== undefined
                ? html`<span
                    class="set-dot"
                    title="Reset to default"
                    @click=${(e: Event) => {
                      e.stopPropagation();
                      transactDoc(activeTab.value, (t) => mutateUpdateProperty(t, [], "$layout"));
                    }}
                  ></span>`
                : nothing
            }
            <sp-field-label size="s">Layout</sp-field-label>
          </div>
          <sp-picker
            size="s"
            value=${displayValue}
            @change=${(e: Event) => {
              const val = (e.target as HTMLInputElement).value;
              if (val === "__default__") {
                transactDoc(activeTab.value, (t) => mutateUpdateProperty(t, [], "$layout"));
              } else if (val === "__none__") {
                transactDoc(activeTab.value, (t) => mutateUpdateProperty(t, [], "$layout", false));
              } else {
                transactDoc(activeTab.value, (t) => mutateUpdateProperty(t, [], "$layout", val));
              }
              invalidateLayoutCache();
            }}
          >
            <sp-menu-item value="__default__"
              >Default${
                defaultLayout
                  ? ` (${defaultLayout.replace(/^\.\/layouts\//, "").replace(/\.json$/, "")})`
                  : ""
              }</sp-menu-item
            >
            <sp-menu-item value="__none__">None</sp-menu-item>
            <sp-menu-divider></sp-menu-divider>
            ${layoutEntries!.map(
              (l: { name: string; path: string }) =>
                html`<sp-menu-item value=${l.path}>${l.name}</sp-menu-item>`,
            )}
          </sp-picker>
        </div>
        ${
          effectivePath
            ? html`<div style="font-size:10px;color:var(--fg-dim);padding:2px 0;font-style:italic">
                Wraps page content via &lt;slot&gt; distribution
              </div>`
            : nothing
        }
      </div>
    </sp-accordion-item>
  `;
}

// ─── Layout selection panel ─────────────────────────────────────────────────

/**
 * Open the layout file the selection came from, WITH the clicked node selected.
 *
 * `navigateToComponent` swaps the tab's document (pushing the page onto the document stack) and
 * clears the selection, so the node has to be re-selected once it resolves — otherwise "Open Layout
 * →" dropped the author into a layout file with nothing selected and left them to find the header
 * again by eye. The layout selection is released either way: the layout is now the open document,
 * so its nodes are ordinary editable content.
 */
async function openLayoutAtNode(
  navigate: (path: string) => void | Promise<void>,
  selection: LayoutSelection,
): Promise<void> {
  await navigate(selection.layoutFile || "layout");
  setLayoutSelection(null);
  const tab = activeTab.value;
  if (tab && tab.documentPath === selection.layoutFile) {
    tab.session.selection = selection.layoutPath;
  }
  renderOnly("rightPanel");
}

function renderLayoutSelectionPanel(ctx: {
  navigateToComponent: (path: string) => void | Promise<void>;
}) {
  const selection = view.layoutSelection as LayoutSelection;
  const tagName = selection.tagName || "element";
  const { className } = selection;
  const displayPath = selection.layoutFile || "layout";

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
              <code
                style="font-size:var(--spectrum-font-size-75, 12px);font-family:var(--font-mono)"
                >&lt;${tagName}&gt;</code
              >
            </div>
            ${
              className
                ? html`<div class="style-row">
                    <div class="style-row-label">
                      <sp-field-label size="s">Class</sp-field-label>
                    </div>
                    <span
                      style="font-size:var(--spectrum-font-size-50, 11px);color:var(--fg-dim);word-break:break-all"
                      >${className}</span
                    >
                  </div>`
                : nothing
            }
            <div style="font-size:10px;color:var(--fg-dim);padding:4px 0;font-style:italic">
              This element comes from ${displayPath}, which wraps every page that uses it. Open the
              layout to edit it.
            </div>
            <span
              class="kv-add"
              @click=${() => void openLayoutAtNode(ctx.navigateToComponent, selection)}
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
  if (!tab) {
    return renderEmptyState({
      actions: [openPageAction()],
      message: "Open a page to inspect and style what you click.",
    });
  }

  // Layout element selected — show read-only info with link to open layout
  if (view.layoutSelection) {
    return renderLayoutSelectionPanel(ctx);
  }

  if (!tab.session.selection) {
    return renderEmptyState({ message: clickAnythingTo("edit its content") });
  }
  const node = getNodeAtPath(tab.doc.document, tab.session.selection);
  if (!node) {
    return renderEmptyState({ message: staleSelectionMessage() });
  }

  const path = tab.session.selection;
  const isMapNode = node.$prototype === "Array";
  const isSwitchNode = Boolean(node.$switch);
  const isCustomInstance = (node.tagName || "").includes("-");
  const isRoot = path.length === 0;
  const tagName = node.tagName || "div";
  const attrs = node.attributes || {};

  const mapSignals = isInsideMapTemplate(path)
    ? [
        { label: "$map/item", value: "$map/item" },
        { label: "$map/index", value: "$map/index" },
      ]
    : null;

  // Signals offered to attribute/textContent bindings (handlers and Functions excluded).
  const bindableSignals = Object.entries(tab.doc.document.state || {})
    .filter(
      ([, d]) =>
        !(d as Record<string, unknown>)?.$handler &&
        (d as JxPrototypeDef)?.$prototype !== "Function",
    )
    .map(([defName]) => defName);

  function renderAttrRow(attr: string, entry: HtmlMetaEntry, value: unknown) {
    const type = inferInputType(entry);
    const hasVal = value !== undefined && value !== "";
    const commitAttr = (v?: JsonValue) =>
      transactDoc(activeTab.value!, (t) =>
        mutateUpdateAttribute(t, path, attr, v as JxAttributeValue | undefined),
      );

    // Enhanced Link handling: only for anchors (a/area) with a plain (non-binding) value. Bindings
    // ($ref objects or ${…} template strings) fall through to the raw widget to stay editable.
    const isAnchor = tagName === "a" || tagName === "area";
    if (isAnchor && !isBoundAttrValue(value)) {
      if (attr === "href") {
        return renderLinkTargetField(node, path);
      }
      if (attr === "target") {
        return renderTargetField(node, path, entry);
      }
    }

    // Attribute strings are schema-legal at three rungs: literal, $ref binding, ${} template.
    const attrSlot = (staticWidget: unknown) =>
      renderDynamicSlot({
        caps: ["literal", "ref", "template"],
        extraSignals: mapSignals,
        fieldKey: `attr|${path.join("/")}|${attr}`,
        onChange: commitAttr,
        staticWidget,
        stateDefs: bindableSignals,
        value,
      });

    if (entry.type === "boolean") {
      const checkboxWidget = html`
        <sp-checkbox
          size="s"
          .checked=${live(Boolean(value))}
          @change=${(e: Event) =>
            commitAttr((e.target as HTMLInputElement).checked ? "" : undefined)}
        >
        </sp-checkbox>
      `;
      const slot = attrSlot(checkboxWidget);
      return renderFieldRow({
        hasValue: hasVal,
        label: attrLabel(entry, attr),
        labelExtra: slot.modeButton,
        onClear: () => transactDoc(activeTab.value, (t) => mutateUpdateAttribute(t, path, attr)),
        prop: attr,
        widget: slot.widget,
      });
    }

    const literalWidget = widgetForType(
      type,
      entry,
      attr,
      isRef(value) ? "" : String(value || ""),
      (v: string) => commitAttr(v || undefined),
    );
    const slot = attrSlot(literalWidget);
    return renderFieldRow({
      hasValue: hasVal,
      label: attrLabel(entry, attr),
      labelExtra: slot.modeButton,
      onClear: () => transactDoc(activeTab.value, (t) => mutateUpdateAttribute(t, path, attr)),
      prop: attr,
      widget: slot.widget,
    });
  }

  // ── Collect applicable attributes from html-meta ──
  const applicableAttrs = {} as Record<string, HtmlMetaEntry>;
  for (const [attr, entry] of Object.entries(htmlMeta.$defs) as [string, HtmlMetaEntry][]) {
    if (!entry.$elements || entry.$elements.includes(tagName)) {
      // The $attr field aliases a $defs key to a different attribute name.
      // This lets the same attribute (e.g. "name") carry per-element metadata.
      applicableAttrs[entry.$attr ?? attr] = entry;
    }
  }

  const attrSections: Record<string, { name: string; entry: HtmlMetaEntry }[]> = {};
  for (const sec of htmlMeta.$sections) {
    attrSections[sec.key] = [];
  }
  for (const [attr, entry] of Object.entries(applicableAttrs)) {
    const secKey = entry.$section;
    if (attrSections[secKey]) {
      attrSections[secKey].push({ entry, name: attr });
    }
  }
  for (const sec of htmlMeta.$sections) {
    attrSections[sec.key]!.sort(
      (a: { name: string; entry: HtmlMetaEntry }, b: { name: string; entry: HtmlMetaEntry }) =>
        a.entry.$order - b.entry.$order,
    );
  }

  const knownAttrNames = new Set(Object.keys(applicableAttrs));
  if (isCustomInstance) {
    const comp = componentRegistry.find((c) => c.tagName === node.tagName);
    if (comp?.props) {
      for (const p of comp.props) {
        knownAttrNames.add(p.name);
      }
    }
  }
  const customAttrs = Object.entries(attrs).filter(([k]) => !knownAttrNames.has(k));

  const autoOpen = new Set();
  for (const [attr] of Object.entries(attrs)) {
    const entry = applicableAttrs[attr];
    if (entry) {
      autoOpen.add(entry.$section);
    }
  }
  if (customAttrs.length > 0) {
    autoOpen.add("__custom");
  }

  function isSectionOpen(key: string) {
    if (tab!.session.ui.inspectorSections[key] !== undefined) {
      return tab!.session.ui.inspectorSections[key];
    }
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

  const textSlot = renderDynamicSlot({
    caps: ["literal", "ref", "template"],
    extraSignals: mapSignals,
    fieldKey: `prop|${path.join("/")}|textContent`,
    onChange: (v?: JsonValue) =>
      transactDoc(activeTab.value, (t) => mutateUpdateProperty(t, path, "textContent", v)),
    staticWidget: spTextArea(
      "prop:textContent",
      typeof node.textContent === "string" ? node.textContent : "",
      (v: string) =>
        transactDoc(activeTab.value, (t) =>
          mutateUpdateProperty(t, path, "textContent", v || undefined),
        ),
    ),
    stateDefs: bindableSignals,
    value: node.textContent,
  });

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
            ${
              node.$id
                ? html`<span
                    class="set-dot"
                    title="Clear ID"
                    @click=${(e: Event) => {
                      e.stopPropagation();
                      transactDoc(activeTab.value, (t) => mutateUpdateProperty(t, path, "$id"));
                    }}
                  ></span>`
                : nothing
            }
            <sp-field-label size="s">ID</sp-field-label>
          </div>
          ${spTextField("prop:$id", String(node.$id || ""), (v: string) =>
            transactDoc(activeTab.value, (t) =>
              mutateUpdateProperty(t, path, "$id", v || undefined),
            ),
          )}
        </div>
        <div class="style-row" data-prop="className">
          <div class="style-row-label">
            ${
              node.className
                ? html`<span
                    class="set-dot"
                    title="Clear class"
                    @click=${(e: Event) => {
                      e.stopPropagation();
                      transactDoc(activeTab.value, (t) =>
                        mutateUpdateProperty(t, path, "className"),
                      );
                    }}
                  ></span>`
                : nothing
            }
            <sp-field-label size="s">Class</sp-field-label>
          </div>
          ${spTextField("prop:className", String(node.className || ""), (v: string) =>
            transactDoc(activeTab.value, (t) =>
              mutateUpdateProperty(t, path, "className", v || undefined),
            ),
          )}
        </div>
        ${
          !Array.isArray(node.children) || node.children.length === 0
            ? html`
                <div class="style-row" data-prop="textContent">
                  <div class="style-row-label">
                    ${
                      node.textContent !== undefined
                        ? html`<span
                            class="set-dot"
                            title="Clear text"
                            @click=${(e: Event) => {
                              e.stopPropagation();
                              transactDoc(activeTab.value, (t) =>
                                mutateUpdateProperty(t, path, "textContent"),
                              );
                            }}
                          ></span>`
                        : nothing
                    }
                    <sp-field-label size="s">Text Content</sp-field-label>
                    ${textSlot.modeButton}
                  </div>
                  ${textSlot.widget}
                </div>
              `
            : nothing
        }
        <div class="style-row" data-prop="hidden">
          <div class="style-row-label">
            ${
              node.hidden
                ? html`<span
                    class="set-dot"
                    title="Clear hidden"
                    @click=${(e: Event) => {
                      e.stopPropagation();
                      transactDoc(activeTab.value, (t) => mutateUpdateProperty(t, path, "hidden"));
                    }}
                  ></span>`
                : nothing
            }
            <sp-field-label size="s">Hidden</sp-field-label>
          </div>
          <sp-checkbox
            size="s"
            .checked=${live(Boolean(node.hidden))}
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
      </div>
    </sp-accordion-item>
  `;

  const repeaterT = isMapNode
    ? html`
        <sp-accordion-item label="Repeating list" open>
          <div class="style-section-body">
            ${renderRepeaterFieldsTemplate(node, path, mapSignals)}
          </div>
        </sp-accordion-item>
      `
    : nothing;

  const switchT = isSwitchNode
    ? html`
        <sp-accordion-item label="Condition" open>
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
                ${
                  entries.length === 0
                    ? renderEmptyState({
                        compact: true,
                        message:
                          "Attributes let a page set this component from markup. " +
                          'Name an "attribute" on a data entry to expose it here.',
                      })
                    : entries.map(([key, d]) => {
                        const def = d as Record<string, unknown>;
                        return html`
                          <div
                            style="display:flex;gap:6px;align-items:center;padding:2px 0;font-size:var(--spectrum-font-size-50, 11px)"
                          >
                            <code style="font-family:var(--font-mono);color:var(--accent)"
                              >${def.attribute}</code
                            >
                            <span style="color:var(--fg-dim)"> → </span>
                            <span>${key}</span>
                            ${
                              def.type
                                ? html`<span
                                    style="margin-left:auto;color:var(--fg-dim);font-size:10px"
                                    >${def.type}</span
                                  >`
                                : nothing
                            }
                            ${
                              def.reflects
                                ? html`<span
                                    style="font-size:9px;background:var(--hover-bg);padding:1px 4px;border-radius:var(--radius)"
                                    >reflects</span
                                  >`
                                : nothing
                            }
                          </div>
                        `;
                      })
                }
              </div>
            </sp-accordion-item>
          `;
        })()
      : nothing;

  const compPropsT = isCustomInstance
    ? html`
        <sp-accordion-item label="Component Settings" open>
          <div class="style-section-body">
            ${renderComponentPropsFieldsTemplate(node, path, mapSignals, ctx.navigateToComponent)}
          </div>
        </sp-accordion-item>
      `
    : nothing;

  const attrSectionTemplates = htmlMeta.$sections
    .filter((sec) => attrSections[sec.key]!.length > 0)
    .map((sec) => {
      const sectionAttrs = attrSections[sec.key]!;
      const hasAnySet = sectionAttrs.some(
        (a: { name: string; entry: HtmlMetaEntry }) => attrs[a.name] !== undefined,
      );
      return html`
        <sp-accordion-item
          label=${sec.label}
          ?open=${isSectionOpen(sec.key)}
          @sp-accordion-item-toggle=${() => toggleSection(sec.key)}
        >
          ${
            hasAnySet
              ? html`<span slot="heading" class="set-dot set-dot--section"></span>`
              : nothing
          }
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
            ${
              customAttrs.length > 0
                ? html`<span slot="heading" class="set-dot set-dot--section"></span>`
                : nothing
            }
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
          if (cssProps.length === 0) {
            return nothing;
          }
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
                      style="display:flex;gap:6px;align-items:center;padding:2px 0;font-size:var(--spectrum-font-size-50, 11px)"
                    >
                      <code style="font-family:var(--font-mono);color:var(--accent)">${prop}</code>
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
          if (parts.length === 0) {
            return nothing;
          }
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
                      style="display:flex;gap:6px;align-items:center;padding:2px 0;font-size:var(--spectrum-font-size-50, 11px)"
                    >
                      <code style="font-family:var(--font-mono);color:var(--accent)"
                        >${p.name}</code
                      >
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
