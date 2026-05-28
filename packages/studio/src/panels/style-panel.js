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
import { selectStylebookTag } from "./stylebook-panel.js";
import {
  transactDoc,
  mutateUpdateStyle,
  mutateUpdateMediaStyle,
  mutateUpdateNestedStyle,
  mutateUpdateMediaNestedStyle,
  mutateUpdateNestedStylePath,
  mutateUpdateMediaNestedStylePath,
} from "../tabs/transact.js";
import { inferInputType, propLabel } from "../utils/studio-utils.js";
import { renderFieldRow } from "../ui/field-row.js";
import { parseMediaEntries } from "../utils/canvas-media.js";
import { getEffectiveMedia, getEffectiveStyle } from "../site-context.js";
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

/**
 * @typedef {{ name: string; entry: Record<string, unknown> }} CssLonghand
 *
 * @typedef {Record<string, unknown>} CssPropertyEntry
 *
 * @typedef {import("../tabs/tab.js").Tab} Tab
 *
 * @typedef {import("../state.js").JxPath} JxPath
 */

/**
 * Check if a selector is a stylebook tag path (e.g., "table" or "table th"). Tag paths don't start
 * with selector prefixes (`:`, `.`, `&`, `[`, `@`).
 *
 * @param {string} selector
 * @returns {boolean}
 */
function isTagPath(selector) {
  return /^[a-z]/.test(selector);
}

/**
 * Resolve a style object by traversing a nested tag path. e.g., "table th" → style["table"]["th"]
 *
 * @param {Record<string, unknown>} style
 * @param {string} tagPath
 * @returns {Record<string, unknown>}
 */
function resolveNestedTagStyle(style, tagPath) {
  const parts = tagPath.split(" ");
  /** @type {unknown} */
  let obj = style;
  for (const part of parts) {
    if (!obj || typeof obj !== "object") return {};
    obj = /** @type {Record<string, unknown>} */ (obj)[part];
  }
  return obj && typeof obj === "object" ? /** @type {Record<string, unknown>} */ (obj) : {};
}

// ─── Row renderers ──────────────────────────────────────────────────────────

function renderStyleRow(
  /** @type {CssPropertyEntry} */ entry,
  /** @type {string} */ prop,
  /** @type {string} */ value,
  /** @type {(v: string | undefined) => void} */ onCommit,
  /** @type {() => void} */ onDelete,
  /** @type {boolean} */ isWarning,
  /** @type {boolean} */ gridMode,
  /** @type {string | undefined} */ inheritedValue,
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
    span: gridMode && /** @type {Record<string, unknown>} */ (entry).$span === 2 ? 2 : undefined,
    warning: isWarning,
  });
}

/**
 * @param {string} shortProp
 * @param {CssPropertyEntry} entry
 * @param {Record<string, unknown>} style
 * @param {(t: Tab, prop: string, val: string | Record<string, unknown> | undefined) => void} mutateFn
 * @param {() => void} _deleteFn
 * @param {Record<string, string | number>} inherited
 */
function renderShorthandRow(shortProp, entry, style, mutateFn, _deleteFn, inherited = {}) {
  const tab = activeTab.value;
  const longhands = /** @type {CssLonghand[]} */ (getLonghands(shortProp));
  const shortVal = style[shortProp];
  const hasLonghands = longhands.some(
    (/** @type {CssLonghand} */ l) => style[l.name] !== undefined,
  );
  const isExpanded = tab.session.ui.styleShorthands[shortProp] ?? hasLonghands;
  const hasAnyVal =
    shortVal !== undefined ||
    longhands.some((/** @type {CssLonghand} */ l) => style[l.name] !== undefined);

  return html`
    <div class="style-row" data-prop=${shortProp}>
      <div class="style-row-label">
        ${hasAnyVal
          ? html`<span
              class="set-dot"
              title="Clear ${shortProp}"
              @click=${(/** @type {Event} */ e) => {
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
            ? longhands.map((/** @type {CssLonghand} */ l) => style[l.name] || "0").join(" ")
            : !shortVal && inherited[shortProp]
              ? inherited[shortProp]
              : !shortVal && longhands.some((/** @type {CssLonghand} */ l) => inherited[l.name])
                ? longhands
                    .map((/** @type {CssLonghand} */ l) => inherited[l.name] || "0")
                    .join(" ")
                : ""}
          @input=${debouncedStyleCommit(`short:${shortProp}`, 400, (/** @type {Event} */ e) => {
            transactDoc(activeTab.value, (t) => {
              for (const l of longhands) {
                if (style[l.name] !== undefined) mutateFn(t, l.name, undefined);
              }
              mutateFn(t, shortProp, /** @type {HTMLInputElement} */ (e.target).value || undefined);
            });
          })}
        ></sp-textfield>
        <sp-action-button
          size="xs"
          quiet
          @click=${(/** @type {Event} */ e) => {
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
          const isBorderSide = /** @type {Record<string, unknown>} */ (entry).$shorthandType ===
          "border-side";
          const expanded = shortVal
            ? isBorderSide
              ? expandBorderSide(/** @type {string} */ (shortVal))
              : expandShorthand(/** @type {string} */ (shortVal), longhands.length)
            : null;
          const compress = isBorderSide ? compressBorderSide : compressShorthand;
          const emptyVal = isBorderSide ? "" : "0";
          return longhands.map(
            (/** @type {CssLonghand} */ { name, entry: lEntry }, /** @type {number} */ idx) => {
              const lVal = style[name] ?? (expanded ? expanded[idx] : "");
              return html`
                <div class="style-row style-row--child" data-prop=${name}>
                  <div class="style-row-label">
                    ${lVal !== undefined && lVal !== ""
                      ? html`<span
                          class="set-dot"
                          title="Clear ${name}"
                          @click=${(/** @type {Event} */ e) => {
                            e.stopPropagation();
                            const vals = longhands.map(
                              (/** @type {CssLonghand} */ l, /** @type {number} */ i) =>
                                i === idx
                                  ? emptyVal
                                  : (style[l.name] ?? (expanded ? expanded[i] : emptyVal)),
                            );
                            transactDoc(activeTab.value, (t) => {
                              for (const l of longhands) {
                                if (style[l.name] !== undefined) mutateFn(t, l.name, undefined);
                              }
                              mutateFn(t, shortProp, compress(/** @type {string[]} */ (vals)));
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
                    (/** @type {string} */ newVal) => {
                      const vals = longhands.map(
                        (/** @type {CssLonghand} */ l, /** @type {number} */ i) =>
                          i === idx
                            ? newVal || emptyVal
                            : (style[l.name] ?? (expanded ? expanded[i] : emptyVal)),
                      );
                      transactDoc(activeTab.value, (t) => {
                        for (const l of longhands) {
                          if (style[l.name] !== undefined) mutateFn(t, l.name, undefined);
                        }
                        mutateFn(t, shortProp, compress(/** @type {string[]} */ (vals)));
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
 * @param {JxMutableNode} node
 * @param {string | null} activeMediaTab
 * @param {string | null} activeSelector
 * @param {Record<string, unknown>} [effectiveStyle]
 */
function styleSidebarTemplate(node, activeMediaTab, activeSelector, effectiveStyle) {
  const tab = activeTab.value;
  const sel = /** @type {JxPath} */ (tab.session.selection);
  const style = effectiveStyle || node.style || {};
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
            @change=${(/** @type {Event} */ e) => {
              const val = /** @type {HTMLElement & { selected: string }} */ (e.target).selected;
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
  const contextStyle = mediaTab
    ? /** @type {Record<string, unknown>} */ (style[`@${mediaTab}`]) || {}
    : style;
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
      @change=${(/** @type {Event} */ e) => {
        const val = /** @type {HTMLElement & { value: string }} */ (e.target).value;
        if (val === "__add_custom__") {
          requestAnimationFrame(() => {
            /** @type {HTMLElement & { value: string }} */ (e.target).value =
              activeSelector || "__base__";
          });
          const picker = /** @type {HTMLElement} */ (e.target);
          const bar = /** @type {HTMLElement} */ (picker.closest(".style-toolbar"));
          picker.style.display = "none";
          const inp = document.createElement("input");
          inp.type = "text";
          inp.className = "selector-custom-input";
          inp.placeholder = ":hover, .child, &.active, [attr]";
          bar.appendChild(inp);
          inp.focus();
          let done = false;
          const finish = (/** @type {boolean} */ accept) => {
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
        @input=${(/** @type {Event} */ e) => {
          activeTab.value.session.ui.styleFilter = /** @type {HTMLInputElement} */ (e.target).value;
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
  /** @type {Record<string, unknown>} */
  let activeStyle;
  /** @type {(prop: string, val: string | Record<string, unknown> | undefined) => void} */
  let commitStyle;
  /** @type {(t: Tab, prop: string, val: string | Record<string, unknown> | undefined) => void} */
  let commitMutate;
  if (activeSelector && isTagPath(activeSelector) && mediaTab && mediaNames.length > 0) {
    const mediaObj = /** @type {Record<string, unknown>} */ (style[`@${mediaTab}`]) || {};
    activeStyle = resolveNestedTagStyle(mediaObj, activeSelector);
    const stylePath = activeSelector.split(" ");
    commitMutate = (
      /** @type {Tab} */ t,
      /** @type {string} */ prop,
      /** @type {string | Record<string, unknown> | undefined} */ val,
    ) =>
      mutateUpdateMediaNestedStylePath(
        t,
        sel,
        mediaTab,
        stylePath,
        prop,
        /** @type {string | undefined} */ (val),
      );
    commitStyle = (
      /** @type {string} */ prop,
      /** @type {string | Record<string, unknown> | undefined} */ val,
    ) => transactDoc(activeTab.value, (t) => commitMutate(t, prop, val));
  } else if (activeSelector && isTagPath(activeSelector)) {
    activeStyle = resolveNestedTagStyle(style, activeSelector);
    const stylePath = activeSelector.split(" ");
    commitMutate = (
      /** @type {Tab} */ t,
      /** @type {string} */ prop,
      /** @type {string | Record<string, unknown> | undefined} */ val,
    ) =>
      mutateUpdateNestedStylePath(t, sel, stylePath, prop, /** @type {string | undefined} */ (val));
    commitStyle = (
      /** @type {string} */ prop,
      /** @type {string | Record<string, unknown> | undefined} */ val,
    ) => transactDoc(activeTab.value, (t) => commitMutate(t, prop, val));
  } else if (activeSelector && mediaTab && mediaNames.length > 0) {
    activeStyle = /** @type {Record<string, unknown>} */ (
      /** @type {Record<string, unknown>} */ (style[`@${mediaTab}`] || {})[activeSelector]
    ) || {};
    commitMutate = (
      /** @type {Tab} */ t,
      /** @type {string} */ prop,
      /** @type {string | Record<string, unknown> | undefined} */ val,
    ) =>
      mutateUpdateMediaNestedStyle(
        t,
        sel,
        mediaTab,
        activeSelector,
        prop,
        /** @type {string | undefined} */ (val),
      );
    commitStyle = (
      /** @type {string} */ prop,
      /** @type {string | Record<string, unknown> | undefined} */ val,
    ) => transactDoc(activeTab.value, (t) => commitMutate(t, prop, val));
  } else if (activeSelector) {
    activeStyle = /** @type {Record<string, unknown>} */ (style[activeSelector]) || {};
    commitMutate = (
      /** @type {Tab} */ t,
      /** @type {string} */ prop,
      /** @type {string | Record<string, unknown> | undefined} */ val,
    ) =>
      mutateUpdateNestedStyle(
        t,
        sel,
        activeSelector,
        prop,
        /** @type {string | undefined} */ (val),
      );
    commitStyle = (
      /** @type {string} */ prop,
      /** @type {string | Record<string, unknown> | undefined} */ val,
    ) => transactDoc(activeTab.value, (t) => commitMutate(t, prop, val));
  } else if (mediaTab !== null && mediaNames.length > 0) {
    activeStyle = {};
    for (const [p, v] of Object.entries(
      /** @type {Record<string, unknown>} */ (style[`@${mediaTab}`]) || {},
    )) {
      if (typeof v !== "object") activeStyle[p] = v;
    }
    commitMutate = (
      /** @type {Tab} */ t,
      /** @type {string} */ prop,
      /** @type {string | Record<string, unknown> | undefined} */ val,
    ) => mutateUpdateMediaStyle(t, sel, mediaTab, prop, /** @type {string | undefined} */ (val));
    commitStyle = (
      /** @type {string} */ prop,
      /** @type {string | Record<string, unknown> | undefined} */ val,
    ) => transactDoc(activeTab.value, (t) => commitMutate(t, prop, val));
  } else {
    activeStyle = {};
    for (const [p, v] of Object.entries(style)) {
      if (typeof v !== "object") activeStyle[p] = v;
    }
    commitMutate = (
      /** @type {Tab} */ t,
      /** @type {string} */ prop,
      /** @type {string | Record<string, unknown> | undefined} */ val,
    ) => mutateUpdateStyle(t, sel, prop, /** @type {string | undefined} */ (val));
    commitStyle = (
      /** @type {string} */ prop,
      /** @type {string | Record<string, unknown> | undefined} */ val,
    ) => transactDoc(activeTab.value, (t) => commitMutate(t, prop, val));
  }

  // ── Compute inherited style from higher breakpoints ──────────────────────
  /** @type {Record<string, string | number>} */
  const inheritedStyle = computeInheritedStyle(style, mediaNames, mediaTab, activeSelector);

  // Auto-open sections that have properties
  const newSections = autoOpenSections({ style: activeStyle }, tab.session.ui.styleSections);
  if (JSON.stringify(newSections) !== JSON.stringify(tab.session.ui.styleSections)) {
    tab.session.ui.styleSections = newSections;
  }

  // Partition properties into sections
  const sectionProps =
    /** @type {Record<string, { prop: string; entry: CssPropertyEntry }[]>} */ ({});
  for (const sec of cssMeta.$sections) sectionProps[sec.key] = [];

  for (const [prop, entry] of /** @type {[string, CssPropertyEntry][]} */ (
    Object.entries(cssMeta.$defs)
  )) {
    if (typeof (/** @type {Record<string, unknown>} */ (entry).$shorthand) === "string") continue;
    const sec = /** @type {string} */ (/** @type {Record<string, unknown>} */ (entry).$section) ||
    "other";
    sectionProps[sec].push({ prop, entry });
  }
  for (const sec of cssMeta.$sections) {
    sectionProps[sec.key].sort(
      (
        /** @type {{ prop: string; entry: CssPropertyEntry }} */ a,
        /** @type {{ prop: string; entry: CssPropertyEntry }} */ b,
      ) =>
        /** @type {number} */ (/** @type {Record<string, unknown>} */ (a.entry).$order) -
        /** @type {number} */ (/** @type {Record<string, unknown>} */ (b.entry).$order),
    );
  }

  const otherProps = [];
  for (const prop of Object.keys(activeStyle)) {
    if (!(/** @type {Record<string, unknown>} */ (cssMeta.$defs)[prop])) {
      const val = activeStyle[prop];
      if (val !== null && typeof val === "object") continue;
      otherProps.push(prop);
    }
  }

  /** @type {string[]} */
  const nestedRules = [];
  for (const [prop, val] of Object.entries(activeStyle)) {
    if (val !== null && typeof val === "object" && !Array.isArray(val) && !prop.startsWith("@")) {
      nestedRules.push(prop);
    }
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

      const sectionActiveProps = entries.filter(
        (/** @type {{ prop: string; entry: CssPropertyEntry }} */ { prop, entry }) => {
          if (activeStyle[prop] !== undefined) return true;
          if (inferInputType(entry) === "shorthand") {
            return /** @type {CssLonghand[]} */ (getLonghands(prop)).some(
              (/** @type {CssLonghand} */ l) => activeStyle[l.name] !== undefined,
            );
          }
          return false;
        },
      );

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
            const longhands = /** @type {CssLonghand[]} */ (getLonghands(prop));
            const hasAnySet =
              hasVal ||
              longhands.some((/** @type {CssLonghand} */ l) => activeStyle[l.name] !== undefined);
            if (!hasAnySet) continue;
          } else if (!hasVal) continue;
        }

        if (type === "shorthand") {
          const longhands = /** @type {CssLonghand[]} */ (getLonghands(prop));
          const hasAny =
            hasVal ||
            longhands.some((/** @type {CssLonghand} */ l) => activeStyle[l.name] !== undefined);
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
                /** @type {string} */ (val) ?? "",
                (/** @type {string | undefined} */ newVal) =>
                  commitStyle(prop, newVal || undefined),
                () => commitStyle(prop, undefined),
                isWarning,
                sec.$layout === "grid",
                /** @type {string | undefined} */ (inheritedStyle[prop]),
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
          @sp-accordion-item-toggle=${(/** @type {Event} */ e) => {
            activeTab.value.session.ui.styleSections = {
              ...activeTab.value.session.ui.styleSections,
              [sec.key]: /** @type {HTMLElement & { open: boolean }} */ (e.target).open,
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
                    @click=${(/** @type {Event} */ e) => {
                      e.stopPropagation();
                      e.preventDefault();
                      transactDoc(activeTab.value, (t) => {
                        for (const { prop, entry } of sectionActiveProps) {
                          if (activeStyle[prop] !== undefined) commitMutate(t, prop, undefined);
                          if (inferInputType(entry) === "shorthand") {
                            for (const l of /** @type {CssLonghand[]} */ (getLonghands(prop))) {
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
      @sp-accordion-item-toggle=${(/** @type {Event} */ e) => {
        activeTab.value.session.ui.styleSections = {
          ...activeTab.value.session.ui.styleSections,
          other: /** @type {HTMLElement & { open: boolean }} */ (e.target).open,
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
                @change=${(/** @type {Event} */ e) => {
                  const newProp = /** @type {HTMLInputElement} */ (e.target).value.trim();
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
                @input=${debouncedStyleCommit(`custom:${prop}`, 400, (/** @type {Event} */ e) => {
                  commitStyle(prop, /** @type {HTMLInputElement} */ (e.target).value);
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
            @keydown=${(/** @type {KeyboardEvent} */ e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                const prop = /** @type {HTMLInputElement} */ (e.target).value.trim();
                if (prop) {
                  const initial = cssInitialMap.get(prop) || "";
                  commitStyle(prop, initial || "");
                  /** @type {HTMLInputElement} */ (e.target).value = "";
                }
              }
            }}
          ></sp-textfield>
        </div>
      </div>
    </sp-accordion-item>
  `;

  // ── Relative Styling section (nested rules) ───────────────────────────────
  const nestedIsOpen = tab.session.ui.styleSections.nested ?? nestedRules.length > 0;
  const nestedSectionT =
    nestedRules.length > 0
      ? html`
          <sp-accordion-item
            label="Relative Styling"
            .open=${nestedIsOpen}
            @sp-accordion-item-toggle=${(/** @type {Event} */ e) => {
              activeTab.value.session.ui.styleSections = {
                ...activeTab.value.session.ui.styleSections,
                nested: /** @type {HTMLElement & { open: boolean }} */ (e.target).open,
              };
            }}
          >
            <div style="display:flex;flex-direction:column;gap:4px;padding:4px 0">
              ${nestedRules.map(
                (rule) => html`
                  <div style="display:flex;align-items:center;gap:4px">
                    <button
                      style="flex:1;text-align:left;padding:6px 10px;background:var(--spectrum-gray-200, #1a1a1a);border:none;border-radius:4px;color:var(--spectrum-gray-900, #fafafa);font-size:12px;cursor:pointer"
                      @click=${() => {
                        const newSelector = activeSelector ? `${activeSelector} ${rule}` : rule;
                        selectStylebookTag(newSelector, undefined, { panCanvas: true });
                      }}
                    >
                      ${rule}
                    </button>
                    <sp-action-button size="xs" quiet @click=${() => commitStyle(rule, undefined)}>
                      <sp-icon-delete slot="icon"></sp-icon-delete>
                    </sp-action-button>
                  </div>
                `,
              )}
              <button
                style="padding:6px 10px;background:none;border:1px dashed var(--spectrum-gray-400, #333);border-radius:4px;color:var(--spectrum-gray-700, #a1a1aa);font-size:12px;cursor:pointer"
                @click=${() => {
                  const name = prompt("Selector name (e.g. th, :hover, .active):");
                  if (name && name.trim()) {
                    commitStyle(name.trim(), {});
                  }
                }}
              >
                + Add
              </button>
            </div>
          </sp-accordion-item>
        `
      : nothing;

  return html`
    <div class="style-sidebar">
      ${toolbarT} ${filterBarT}
      <sp-accordion allow-multiple size="s">
        ${sectionTemplates} ${nestedSectionT} ${customSectionT}
      </sp-accordion>
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
  if (ctx.getCanvasMode() === "stylebook" && tab.session.ui.stylebookSelection) {
    const node = tab.doc.document;
    if (!node) return html`<div class="empty-state">No document loaded</div>`;
    return html`
      <div class="stylebook-style-header">
        Styling: &lt;${tab.session.ui.stylebookSelection}&gt;
      </div>
      ${styleSidebarTemplate(
        node,
        tab.session.ui.activeMedia,
        tab.session.ui.activeSelector,
        getEffectiveStyle(node.style),
      )}
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
  /** @type {string} */ label,
  /** @type {string} */ type,
  /** @type {string} */ value,
  /** @type {(v: string | boolean) => void} */ onChange,
  /** @type {string | undefined} */ _datalistId,
) {
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let debounceTimer;
  const onInput = (/** @type {Event} */ e) => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(
      () => onChange(/** @type {HTMLInputElement} */ (e.target).value),
      400,
    );
  };
  const inputTpl =
    type === "textarea"
      ? html`<sp-textfield
          multiline
          size="s"
          .value=${live(value ?? "")}
          @input=${onInput}
        ></sp-textfield>`
      : type === "checkbox"
        ? html`<sp-checkbox
            ?checked=${!!value}
            @change=${(/** @type {Event} */ e) =>
              onChange(/** @type {HTMLInputElement} */ (e.target).checked)}
          ></sp-checkbox>`
        : html`<sp-textfield
            size="s"
            .value=${live(value ?? "")}
            @input=${onInput}
          ></sp-textfield>`;
  return html`
    <div class="field-row">
      <sp-field-label size="s">${label}</sp-field-label>
      ${inputTpl}
    </div>
  `;
}
