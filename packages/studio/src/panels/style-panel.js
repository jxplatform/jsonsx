/**
 * Style panel — CSS property editor with media breakpoint tabs, selector dropdown, section
 * accordion, shorthand expand/compress, and filter.
 */

import { html, nothing } from "lit-html";
import { live } from "lit-html/directives/live.js";
import { ifDefined } from "lit-html/directives/if-defined.js";
import {
  getNodeAtPath,
  COMMON_SELECTORS,
  isNestedSelector,
  debouncedStyleCommit,
} from "../store.js";
import { activeTab } from "../workspace/workspace.js";
import {
  transactDoc,
  mutateUpdateStyle,
  mutateUpdateMediaStyle,
  mutateUpdateNestedStyle,
  mutateUpdateMediaNestedStyle,
} from "../tabs/transact.js";
import { inferInputType, propLabel } from "../utils/studio-utils.js";
import { renderFieldRow } from "../ui/field-row.js";
import { parseMediaEntries } from "../utils/canvas-media.js";
import { getEffectiveMedia } from "../site-context.js";
import { computeInheritedStyle } from "../utils/inherited-style.js";
import { mediaDisplayName } from "./shared.js";
import {
  cssMeta,
  getCssInitialMap,
  allConditionsPass,
  autoOpenSections,
  getLonghands,
  expandShorthand,
  compressShorthand,
  expandBorderSide,
  compressBorderSide,
} from "./style-utils.js";
import { widgetForType } from "./style-inputs.js";

// ─── Row renderers ──────────────────────────────────────────────────────────

function renderStyleRow(
  /** @type {any} */ entry,
  /** @type {any} */ prop,
  /** @type {any} */ value,
  /** @type {any} */ onCommit,
  /** @type {any} */ onDelete,
  /** @type {any} */ isWarning,
  /** @type {any} */ gridMode,
  /** @type {any} */ inheritedValue,
) {
  const type = inferInputType(entry);
  const hasVal = value !== undefined && value !== "";
  const placeholder = !hasVal && inheritedValue ? String(inheritedValue) : "";
  return renderFieldRow({
    prop,
    label: propLabel(entry, prop),
    hasValue: hasVal,
    onClear: onDelete,
    widget: widgetForType(type, entry, prop, value, onCommit, { placeholder }),
    span: gridMode && entry.$span === 2 ? 2 : undefined,
    warning: isWarning,
  });
}

/**
 * @param {any} shortProp @param {any} entry @param {any} style @param {any} mutateFn
 * @param {any} _deleteFn @param {Record<string, any>} inherited
 */
function renderShorthandRow(shortProp, entry, style, mutateFn, _deleteFn, inherited = {}) {
  const tab = activeTab.value;
  const longhands = getLonghands(shortProp);
  const shortVal = style[shortProp];
  const hasLonghands = longhands.some((/** @type {any} */ l) => style[l.name] !== undefined);
  const isExpanded = tab.session.ui.styleShorthands[shortProp] ?? hasLonghands;
  const hasAnyVal =
    shortVal !== undefined || longhands.some((/** @type {any} */ l) => style[l.name] !== undefined);

  return html`
    <div class="style-row" data-prop=${shortProp}>
      <div class="style-row-label">
        ${hasAnyVal
          ? html`<span
              class="set-dot"
              title="Clear ${shortProp}"
              @click=${(/** @type {any} */ e) => {
                e.stopPropagation();
                transactDoc(activeTab.value, (t) => {
                  if (shortVal !== undefined) mutateFn(t, shortProp, undefined);
                  for (const l of longhands) {
                    if (style[l.name] !== undefined) mutateFn(t, l.name, undefined);
                  }
                });
              }}
            ></span>`
          : nothing}
        <sp-field-label size="s" title=${shortProp}>${propLabel(entry, shortProp)}</sp-field-label>
      </div>
      <div class="style-shorthand-header">
        <sp-textfield
          size="s"
          .value=${live(shortVal || "")}
          placeholder=${!shortVal && hasLonghands
            ? longhands.map((/** @type {any} */ l) => style[l.name] || "0").join(" ")
            : !shortVal && inherited[shortProp]
              ? inherited[shortProp]
              : !shortVal && longhands.some((/** @type {any} */ l) => inherited[l.name])
                ? longhands.map((/** @type {any} */ l) => inherited[l.name] || "0").join(" ")
                : ""}
          @input=${debouncedStyleCommit(`short:${shortProp}`, 400, (/** @type {any} */ e) => {
            transactDoc(activeTab.value, (t) => {
              for (const l of longhands) {
                if (style[l.name] !== undefined) mutateFn(t, l.name, undefined);
              }
              mutateFn(t, shortProp, e.target.value || undefined);
            });
          })}
        ></sp-textfield>
        <sp-action-button
          size="xs"
          quiet
          @click=${(/** @type {any} */ e) => {
            e.stopPropagation();
            activeTab.value.session.ui.styleShorthands = {
              ...activeTab.value.session.ui.styleShorthands,
              [shortProp]: !isExpanded,
            };
          }}
        >
          ${isExpanded
            ? html`<sp-icon-chevron-down slot="icon"></sp-icon-chevron-down>`
            : html`<sp-icon-chevron-right slot="icon"></sp-icon-chevron-right>`}
        </sp-action-button>
      </div>
    </div>
    ${isExpanded
      ? (() => {
          const isBorderSide = entry.$shorthandType === "border-side";
          const expanded = shortVal
            ? isBorderSide
              ? expandBorderSide(shortVal)
              : expandShorthand(shortVal, longhands.length)
            : null;
          const compress = isBorderSide ? compressBorderSide : compressShorthand;
          const emptyVal = isBorderSide ? "" : "0";
          return longhands.map(
            (/** @type {any} */ { name, entry: lEntry }, /** @type {any} */ idx) => {
              const lVal = style[name] ?? (expanded ? expanded[idx] : "");
              return html`
                <div class="style-row style-row--child" data-prop=${name}>
                  <div class="style-row-label">
                    ${lVal !== undefined && lVal !== ""
                      ? html`<span
                          class="set-dot"
                          title="Clear ${name}"
                          @click=${(/** @type {any} */ e) => {
                            e.stopPropagation();
                            const vals = longhands.map(
                              (/** @type {any} */ l, /** @type {any} */ i) =>
                                i === idx
                                  ? emptyVal
                                  : (style[l.name] ?? (expanded ? expanded[i] : emptyVal)),
                            );
                            transactDoc(activeTab.value, (t) => {
                              for (const l of longhands) {
                                if (style[l.name] !== undefined) mutateFn(t, l.name, undefined);
                              }
                              mutateFn(t, shortProp, compress(vals));
                            });
                          }}
                        ></span>`
                      : nothing}
                    <sp-field-label size="s" title=${name}
                      >${propLabel(lEntry, name)}</sp-field-label
                    >
                  </div>
                  ${widgetForType(
                    inferInputType(lEntry),
                    lEntry,
                    name,
                    lVal,
                    (/** @type {any} */ newVal) => {
                      const vals = longhands.map((/** @type {any} */ l, /** @type {any} */ i) =>
                        i === idx
                          ? newVal || emptyVal
                          : (style[l.name] ?? (expanded ? expanded[i] : emptyVal)),
                      );
                      transactDoc(activeTab.value, (t) => {
                        for (const l of longhands) {
                          if (style[l.name] !== undefined) mutateFn(t, l.name, undefined);
                        }
                        mutateFn(t, shortProp, compress(vals));
                      });
                    },
                    { placeholder: !lVal && inherited[name] ? String(inherited[name]) : "" },
                  )}
                </div>
              `;
            },
          );
        })()
      : nothing}
  `;
}

// ─── Main template ──────────────────────────────────────────────────────────

/**
 * @param {any} node
 * @param {any} activeMediaTab
 * @param {any} activeSelector
 */
function styleSidebarTemplate(node, activeMediaTab, activeSelector) {
  const tab = activeTab.value;
  const sel = /** @type {import("../state.js").JxPath} */ (tab.session.selection);
  const style = node.style || {};
  const { sizeBreakpoints } = parseMediaEntries(getEffectiveMedia(tab.doc.document.$media));
  const mediaNames = sizeBreakpoints.map((bp) => bp.name);
  const mediaTab = activeMediaTab;

  // ── Media tabs template ──────────────────────────────────────────────────
  const mediaTabsT =
    mediaNames.length > 0
      ? html`
          <sp-tabs
            size="s"
            selected=${mediaTab || "base"}
            @change=${(/** @type {any} */ e) => {
              const val = e.target.selected;
              const newMedia = val === "base" ? null : val;
              if (newMedia !== tab.session.ui.activeMedia) {
                tab.session.ui.activeMedia = newMedia;
              }
            }}
          >
            <sp-tab label="Base" value="base"></sp-tab>
            ${mediaNames.map(
              (name) => html` <sp-tab label=${mediaDisplayName(name)} value=${name}></sp-tab> `,
            )}
          </sp-tabs>
        `
      : nothing;

  // ── Selector dropdown ──────────────────────────────────────────────────────
  const contextStyle = mediaTab ? style[`@${mediaTab}`] || {} : style;
  const existingSelectors = Object.keys(contextStyle).filter(isNestedSelector);
  const existingSet = new Set(existingSelectors);
  const commonSet = new Set(COMMON_SELECTORS);
  const extraSelectors = existingSelectors.filter((s) => !commonSet.has(s));
  if (activeSelector && !commonSet.has(activeSelector) && !existingSet.has(activeSelector)) {
    extraSelectors.unshift(activeSelector);
  }

  const _selectorVal = activeSelector || "__base__";
  const selectorT = html`
    <sp-picker
      size="s"
      class="selector-select"
      quiet
      .value=${live(_selectorVal)}
      @change=${(/** @type {any} */ e) => {
        const val = e.target.value;
        if (val === "__add_custom__") {
          requestAnimationFrame(() => {
            e.target.value = activeSelector || "__base__";
          });
          const picker = e.target;
          const bar = picker.closest(".style-toolbar");
          picker.style.display = "none";
          const inp = document.createElement("input");
          inp.type = "text";
          inp.className = "selector-custom-input";
          inp.placeholder = ":hover, .child, &.active, [attr]";
          bar.appendChild(inp);
          inp.focus();
          let done = false;
          const finish = (/** @type {any} */ accept) => {
            if (done) return;
            done = true;
            const v = inp.value.trim();
            inp.remove();
            picker.style.display = "";
            if (accept && v && isNestedSelector(v)) {
              activeTab.value.session.ui.activeSelector = v;
            }
          };
          inp.addEventListener("keydown", (ev) => {
            if (ev.key === "Enter") finish(true);
            else if (ev.key === "Escape") finish(false);
          });
          inp.addEventListener("blur", () => finish(inp.value.trim().length > 0));
          return;
        }
        const newSelector = val === "__base__" ? null : val;
        activeTab.value.session.ui.activeSelector = newSelector;
      }}
    >
      <sp-menu-item value="__base__">(base)</sp-menu-item>
      <sp-menu-divider></sp-menu-divider>
      ${COMMON_SELECTORS.map(
        (s) => html`
          <sp-menu-item value=${s}>${existingSet.has(s) ? `${s}  \u25CF` : s}</sp-menu-item>
        `,
      )}
      ${extraSelectors.length > 0
        ? html`
            <sp-menu-divider></sp-menu-divider>
            ${extraSelectors.map((s) => html` <sp-menu-item value=${s}>${s} ●</sp-menu-item> `)}
          `
        : nothing}
      <sp-menu-divider></sp-menu-divider>
      <sp-menu-item value="__add_custom__">+ Add custom…</sp-menu-item>
    </sp-picker>
  `;

  // ── Combined toolbar (media tabs + selector) ───────────────────────────────
  const toolbarT = html`
    <div class="style-toolbar">
      <div class="style-toolbar-tabs">${mediaTabsT}</div>
      ${selectorT}
    </div>
  `;

  // ── Filter bar ─────────────────────────────────────────────────────────────
  const filterBarT = html`
    <div class="style-filter-bar">
      <sp-textfield
        size="s"
        class="style-filter-input"
        placeholder="Filter properties…"
        .value=${live(tab.session.ui.styleFilter || "")}
        @input=${(/** @type {any} */ e) => {
          activeTab.value.session.ui.styleFilter = e.target.value;
        }}
      ></sp-textfield>
      <sp-action-button
        size="xs"
        class="style-filter-toggle"
        ?selected=${tab.session.ui.styleFilterActive}
        @click=${() => {
          activeTab.value.session.ui.styleFilterActive =
            !activeTab.value.session.ui.styleFilterActive;
        }}
      >
        Active
      </sp-action-button>
    </div>
  `;

  // ── Determine the active style object ──────────────────────────────────────
  /** @type {Record<string, any>} */
  let activeStyle;
  /** @type {(prop: any, val: any) => void} */
  let commitStyle;
  /** @type {(t: any, prop: any, val: any) => void} */
  let commitMutate;
  if (activeSelector && mediaTab && mediaNames.length > 0) {
    activeStyle = (style[`@${mediaTab}`] || {})[activeSelector] || {};
    commitMutate = (/** @type {any} */ t, /** @type {any} */ prop, /** @type {any} */ val) =>
      mutateUpdateMediaNestedStyle(t, sel, mediaTab, activeSelector, prop, val);
    commitStyle = (/** @type {any} */ prop, /** @type {any} */ val) =>
      transactDoc(activeTab.value, (t) => commitMutate(t, prop, val));
  } else if (activeSelector) {
    activeStyle = style[activeSelector] || {};
    commitMutate = (/** @type {any} */ t, /** @type {any} */ prop, /** @type {any} */ val) =>
      mutateUpdateNestedStyle(t, sel, activeSelector, prop, val);
    commitStyle = (/** @type {any} */ prop, /** @type {any} */ val) =>
      transactDoc(activeTab.value, (t) => commitMutate(t, prop, val));
  } else if (mediaTab !== null && mediaNames.length > 0) {
    activeStyle = {};
    for (const [p, v] of Object.entries(style[`@${mediaTab}`] || {})) {
      if (typeof v !== "object") activeStyle[p] = v;
    }
    commitMutate = (/** @type {any} */ t, /** @type {any} */ prop, /** @type {any} */ val) =>
      mutateUpdateMediaStyle(t, sel, mediaTab, prop, val);
    commitStyle = (/** @type {any} */ prop, /** @type {any} */ val) =>
      transactDoc(activeTab.value, (t) => commitMutate(t, prop, val));
  } else {
    activeStyle = {};
    for (const [p, v] of Object.entries(style)) {
      if (typeof v !== "object") activeStyle[p] = v;
    }
    commitMutate = (/** @type {any} */ t, /** @type {any} */ prop, /** @type {any} */ val) =>
      mutateUpdateStyle(t, sel, prop, val);
    commitStyle = (/** @type {any} */ prop, /** @type {any} */ val) =>
      transactDoc(activeTab.value, (t) => commitMutate(t, prop, val));
  }

  // ── Compute inherited style from higher breakpoints ──────────────────────
  /** @type {Record<string, any>} */
  const inheritedStyle = computeInheritedStyle(style, mediaNames, mediaTab, activeSelector);

  // Auto-open sections that have properties
  const newSections = autoOpenSections({ style: activeStyle }, tab.session.ui.styleSections);
  if (JSON.stringify(newSections) !== JSON.stringify(tab.session.ui.styleSections)) {
    tab.session.ui.styleSections = newSections;
  }

  // Partition properties into sections
  const sectionProps = /** @type {Record<string, any[]>} */ ({});
  for (const sec of cssMeta.$sections) sectionProps[sec.key] = [];

  for (const [prop, entry] of /** @type {[string, any][]} */ (Object.entries(cssMeta.$defs))) {
    if (typeof entry.$shorthand === "string") continue;
    const sec = entry.$section || "other";
    sectionProps[sec].push({ prop, entry });
  }
  for (const sec of cssMeta.$sections) {
    sectionProps[sec.key].sort(
      (/** @type {any} */ a, /** @type {any} */ b) => a.entry.$order - b.entry.$order,
    );
  }

  const otherProps = [];
  for (const prop of Object.keys(activeStyle)) {
    if (!(/** @type {Record<string, any>} */ (cssMeta.$defs)[prop])) otherProps.push(prop);
  }

  // ── Filter state ─────────────────────────────────────────────────────────
  const filterText = (tab.session.ui.styleFilter || "").toLowerCase();
  const filterActive = tab.session.ui.styleFilterActive;
  const isFiltering = filterText.length > 0 || filterActive;

  // ── Section templates ────────────────────────────────────────────────────
  const sectionTemplates = cssMeta.$sections
    .filter((sec) => sec.key !== "other")
    .map((sec) => {
      const entries = sectionProps[sec.key];

      const sectionActiveProps = entries.filter((/** @type {any} */ { prop, entry }) => {
        if (activeStyle[prop] !== undefined) return true;
        if (inferInputType(entry) === "shorthand") {
          return getLonghands(prop).some(
            (/** @type {any} */ l) => activeStyle[l.name] !== undefined,
          );
        }
        return false;
      });

      const rows = [];
      for (const { prop, entry } of entries) {
        const val = activeStyle[prop];
        const hasVal = val !== undefined;
        const condMet = allConditionsPass(entry, activeStyle);
        const type = inferInputType(entry);
        if (!hasVal && !condMet) continue;

        if (filterText) {
          const label = propLabel(entry, prop).toLowerCase();
          if (!prop.includes(filterText) && !label.includes(filterText)) continue;
        }
        if (filterActive) {
          if (type === "shorthand") {
            const longhands = getLonghands(prop);
            const hasAnySet =
              hasVal || longhands.some((/** @type {any} */ l) => activeStyle[l.name] !== undefined);
            if (!hasAnySet) continue;
          } else if (!hasVal) continue;
        }

        if (type === "shorthand") {
          const longhands = getLonghands(prop);
          const hasAny =
            hasVal || longhands.some((/** @type {any} */ l) => activeStyle[l.name] !== undefined);
          if (!hasAny && !condMet) continue;
          rows.push(
            renderShorthandRow(prop, entry, activeStyle, commitMutate, () => {}, inheritedStyle),
          );
        } else {
          const isWarning = hasVal && !condMet;
          if (hasVal || condMet) {
            rows.push(
              renderStyleRow(
                entry,
                prop,
                val ?? "",
                (/** @type {any} */ newVal) => commitStyle(prop, newVal || undefined),
                () => commitStyle(prop, undefined),
                isWarning,
                sec.$layout === "grid",
                inheritedStyle[prop],
              ),
            );
          }
        }
      }

      if (isFiltering && rows.length === 0) return nothing;
      const isOpen = isFiltering ? true : (tab.session.ui.styleSections[sec.key] ?? false);

      return html`
        <sp-accordion-item
          label=${sec.label}
          .open=${isOpen}
          @sp-accordion-item-toggle=${(/** @type {any} */ e) => {
            activeTab.value.session.ui.styleSections = {
              ...activeTab.value.session.ui.styleSections,
              [sec.key]: e.target.open,
            };
          }}
        >
          ${sectionActiveProps.length > 0
            ? html`
                <span slot="heading" style="display:flex;align-items:center;gap:6px">
                  ${sec.label}
                  <span
                    class="set-dot set-dot--section"
                    title="Clear all ${sec.label.toLowerCase()} properties"
                    @click=${(/** @type {any} */ e) => {
                      e.stopPropagation();
                      e.preventDefault();
                      transactDoc(activeTab.value, (t) => {
                        for (const { prop, entry } of sectionActiveProps) {
                          if (activeStyle[prop] !== undefined) commitMutate(t, prop, undefined);
                          if (inferInputType(entry) === "shorthand") {
                            for (const l of getLonghands(prop)) {
                              if (activeStyle[l.name] !== undefined)
                                commitMutate(t, l.name, undefined);
                            }
                          }
                        }
                      });
                    }}
                  ></span>
                </span>
              `
            : nothing}
          <div class=${sec.$layout === "grid" ? "style-section-body--grid" : ""}>${rows}</div>
        </sp-accordion-item>
      `;
    });

  // ── Custom section ─────────────────────────────────────────────────────────
  const cssInitialMap = getCssInitialMap();
  const customIsOpen = tab.session.ui.styleSections.other ?? otherProps.length > 0;
  const customSectionT = html`
    <sp-accordion-item
      label="Custom"
      .open=${customIsOpen}
      @sp-accordion-item-toggle=${(/** @type {any} */ e) => {
        activeTab.value.session.ui.styleSections = {
          ...activeTab.value.session.ui.styleSections,
          other: e.target.open,
        };
      }}
    >
      <div>
        ${otherProps.map(
          (prop) => html`
            <div class="kv-row">
              <sp-textfield
                size="s"
                class="kv-key"
                .value=${live(prop)}
                @change=${(/** @type {any} */ e) => {
                  const newProp = e.target.value.trim();
                  if (newProp && newProp !== prop) {
                    transactDoc(activeTab.value, (t) => {
                      commitMutate(t, prop, undefined);
                      commitMutate(t, newProp, String(activeStyle[prop]));
                    });
                  }
                }}
              ></sp-textfield>
              <sp-textfield
                size="s"
                class="kv-val"
                .value=${live(String(activeStyle[prop]))}
                placeholder=${ifDefined(cssInitialMap.get(prop))}
                @input=${debouncedStyleCommit(`custom:${prop}`, 400, (/** @type {any} */ e) => {
                  commitStyle(prop, e.target.value);
                })}
              ></sp-textfield>
              <sp-action-button size="xs" quiet @click=${() => commitStyle(prop, undefined)}>
                <sp-icon-close slot="icon"></sp-icon-close>
              </sp-action-button>
            </div>
          `,
        )}
        <div style="display:flex;gap:4px;padding-top:4px">
          <sp-textfield
            size="s"
            placeholder="Property name…"
            style="flex:1"
            @keydown=${(/** @type {any} */ e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                const prop = e.target.value.trim();
                if (prop) {
                  const initial = cssInitialMap.get(prop) || "";
                  commitStyle(prop, initial || "");
                  e.target.value = "";
                }
              }
            }}
          ></sp-textfield>
        </div>
      </div>
    </sp-accordion-item>
  `;

  return html`
    <div class="style-sidebar">
      ${toolbarT} ${filterBarT}
      <sp-accordion allow-multiple size="s"> ${sectionTemplates} ${customSectionT} </sp-accordion>
    </div>
  `;
}

// ─── Entry point ────────────────────────────────────────────────────────────

/**
 * Top-level Style panel — returns a lit-html template.
 *
 * @param {{ getCanvasMode: () => string }} ctx
 * @returns {import("lit-html").TemplateResult}
 */
export function renderStylePanelTemplate(ctx) {
  const tab = activeTab.value;
  if (!tab) return html`<div class="empty-state">No document loaded</div>`;
  if (ctx.getCanvasMode() === "settings" && tab.session.ui.stylebookSelection) {
    const node = tab.doc.document;
    if (!node) return html`<div class="empty-state">No document loaded</div>`;
    return html`
      <div class="stylebook-style-header">
        Styling: &lt;${tab.session.ui.stylebookSelection}&gt;
      </div>
      ${styleSidebarTemplate(node, tab.session.ui.activeMedia, tab.session.ui.activeSelector)}
    `;
  }
  if (!tab.session.selection)
    return html`<div class="empty-state">Select an element to style</div>`;
  const node = getNodeAtPath(tab.doc.document, tab.session.selection);
  if (!node) return html`<div class="empty-state">Select an element to style</div>`;
  return styleSidebarTemplate(node, tab.session.ui.activeMedia, tab.session.ui.activeSelector);
}

/** Single property input row (generic field row helper) */
export function _fieldRow(
  /** @type {any} */ label,
  /** @type {any} */ type,
  /** @type {any} */ value,
  /** @type {any} */ onChange,
  /** @type {any} */ _datalistId,
) {
  /** @type {any} */
  let debounceTimer;
  const onInput = (/** @type {any} */ e) => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => onChange(e.target.value), 400);
  };
  const inputTpl =
    type === "textarea"
      ? html`<sp-textfield
          multiline
          size="s"
          value=${value ?? ""}
          @input=${onInput}
        ></sp-textfield>`
      : type === "checkbox"
        ? html`<sp-checkbox
            ?checked=${!!value}
            @change=${(/** @type {any} */ e) => onChange(e.target.checked)}
          ></sp-checkbox>`
        : html`<sp-textfield size="s" value=${value ?? ""} @input=${onInput}></sp-textfield>`;
  return html`
    <div class="field-row">
      <sp-field-label size="s">${label}</sp-field-label>
      ${inputTpl}
    </div>
  `;
}
