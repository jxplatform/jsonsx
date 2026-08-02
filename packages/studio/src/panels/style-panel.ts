/// <reference lib="dom" />
/**
 * Style panel — CSS property editor with media breakpoint tabs, selector dropdown, section
 * accordion, shorthand expand/compress, and filter.
 */

import { html, nothing } from "lit-html";
import { getNestedStyle } from "@jxsuite/schema/guards";
import { live } from "lit-html/directives/live.js";
import { ifDefined } from "lit-html/directives/if-defined.js";
import { COMMON_SELECTORS, debouncedStyleCommit, getNodeAtPath, isNestedSelector } from "../store";
import { activeTab } from "../workspace/workspace";
import { shell } from "../shell";
import { selectStylebookTag } from "./stylebook-panel";
import {
  mutateUpdateMediaNestedStyle,
  mutateUpdateMediaNestedStylePath,
  mutateUpdateMediaStyle,
  mutateUpdateNestedStyle,
  mutateUpdateNestedStylePath,
  mutateUpdateStyle,
  transactDoc,
} from "../tabs/transact";
import { inferInputType, propLabel } from "../utils/studio-utils";
import { renderFieldRow } from "../ui/field-row";
import { showPromptDialog } from "../ui/layers";
import { renderDynamicSlot } from "../ui/dynamic-slot";
import { parseMediaEntries, schemeOfQuery } from "../utils/canvas-media";
import { getEffectiveMedia, getEffectiveStyle } from "../site-context";
import { computeInheritedStyle } from "../utils/inherited-style";
import { mediaDisplayName } from "./shared";
import {
  clickAnythingTo,
  openPageAction,
  renderEmptyState,
  staleSelectionMessage,
} from "./empty-state";
import {
  allConditionsPass,
  autoOpenSections,
  compressBorderSide,
  compressShorthand,
  cssMeta,
  expandBorderSide,
  expandShorthand,
  getCssInitialMap,
  getLonghands,
} from "./style-utils";
import { widgetForType } from "./style-inputs";

import type { Tab } from "../tabs/tab";
import type { JxPath } from "../state";
import type { JsonValue } from "../types";
import type { JxMutableNode, JxStyle } from "@jxsuite/schema/types";

interface CssLonghand {
  name: string;
  entry: Record<string, unknown>;
}

type CssPropertyEntry = Record<string, unknown>;

type StyleMutateFn = (
  t: Tab,
  prop: string,
  val?: string | Record<string, unknown> | undefined,
) => void;

/**
 * Check if a selector is a stylebook tag path (e.g., "table" or "table th"). Tag paths don't start
 * with selector prefixes (`:`, `.`, `&`, `[`, `@`).
 *
 * @param {string} selector
 * @returns {boolean}
 */
function isTagPath(selector: string) {
  return /^[a-z]/.test(selector);
}

/**
 * Resolve a style object by traversing a nested tag path. e.g., "table th" → style["table"]["th"]
 *
 * @param {JxStyle} style
 * @param {string} tagPath
 * @returns {JxStyle}
 */
function resolveNestedTagStyle(style: JxStyle, tagPath: string): JxStyle {
  let obj: JxStyle | undefined = style;
  for (const part of tagPath.split(" ")) {
    obj = getNestedStyle(obj, part);
    if (!obj) {
      return {};
    }
  }
  return obj;
}

// ─── Row renderers ──────────────────────────────────────────────────────────

function renderStyleRow(
  entry: CssPropertyEntry,
  prop: string,
  value: string,
  onCommit: (v: string | undefined) => void,
  onDelete: () => void,
  isWarning: boolean,
  gridMode: boolean,
  inheritedValue: string | undefined,
  templateSignals: string[] = [],
  fieldKey: string = prop,
) {
  const type = inferInputType(entry);
  const hasVal = value !== undefined && value !== "";
  const placeholder = !hasVal && inheritedValue ? String(inheritedValue) : "";
  const spanVal = gridMode && (entry as Record<string, unknown>).$span === 2 ? 2 : undefined;
  // Style values are schema-legal at two rungs: literal and ${} template (no $ref in JxStyle).
  const slot = renderDynamicSlot({
    caps: ["literal", "template"],
    fieldKey,
    onChange: (v?: JsonValue) => onCommit(v === undefined || v === "" ? undefined : String(v)),
    staticWidget: widgetForType(type, entry, prop, value, onCommit, { placeholder }),
    stateDefs: templateSignals,
    value,
  });
  return renderFieldRow({
    prop,
    label: propLabel(entry, prop),
    hasValue: hasVal,
    onClear: onDelete,
    widget: slot.widget,
    labelExtra: slot.modeButton,
    ...(spanVal != null && { span: spanVal }),
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
function renderShorthandRow(
  shortProp: string,
  entry: CssPropertyEntry,
  style: Record<string, unknown>,
  mutateFn: StyleMutateFn,
  _deleteFn: () => void,
  inherited: Record<string, string | number> = {},
) {
  const tab = activeTab.value!;
  const longhands = getLonghands(shortProp) as CssLonghand[];
  const shortVal = style[shortProp];
  const hasLonghands = longhands.some((l: CssLonghand) => style[l.name] !== undefined);
  const isExpanded = tab.session.ui.styleShorthands[shortProp] ?? hasLonghands;
  const hasAnyVal =
    shortVal !== undefined || longhands.some((l: CssLonghand) => style[l.name] !== undefined);

  return html`
    <div class="style-row" data-prop=${shortProp}>
      <div class="style-row-label">
        ${
          hasAnyVal
            ? html`<span
                class="set-dot"
                title="Clear ${shortProp}"
                @click=${(e: Event) => {
                  e.stopPropagation();
                  transactDoc(activeTab.value, (t) => {
                    if (shortVal !== undefined) {
                      mutateFn(t, shortProp);
                    }
                    for (const l of longhands) {
                      if (style[l.name] !== undefined) {
                        mutateFn(t, l.name);
                      }
                    }
                  });
                }}
              ></span>`
            : nothing
        }
        <sp-field-label size="s" title=${shortProp}>${propLabel(entry, shortProp)}</sp-field-label>
      </div>
      <div class="style-shorthand-header">
        <sp-textfield
          size="s"
          .value=${live(shortVal || "")}
          placeholder=${
            !shortVal && hasLonghands
              ? longhands.map((l: CssLonghand) => style[l.name] || "0").join(" ")
              : !shortVal && inherited[shortProp]
                ? inherited[shortProp]
                : !shortVal && longhands.some((l: CssLonghand) => inherited[l.name])
                  ? longhands.map((l: CssLonghand) => inherited[l.name] || "0").join(" ")
                  : ""
          }
          @input=${debouncedStyleCommit(`short:${shortProp}`, 400, (e: Event) => {
            transactDoc(activeTab.value, (t) => {
              for (const l of longhands) {
                if (style[l.name] !== undefined) {
                  mutateFn(t, l.name);
                }
              }
              mutateFn(t, shortProp, (e.target as HTMLInputElement).value || undefined);
            });
          })}
        ></sp-textfield>
        <sp-action-button
          size="xs"
          quiet
          @click=${(e: Event) => {
            e.stopPropagation();
            activeTab.value!.session.ui.styleShorthands = {
              ...activeTab.value!.session.ui.styleShorthands,
              [shortProp]: !isExpanded,
            };
          }}
        >
          ${
            isExpanded
              ? html`<sp-icon-chevron-down slot="icon"></sp-icon-chevron-down>`
              : html`<sp-icon-chevron-right slot="icon"></sp-icon-chevron-right>`
          }
        </sp-action-button>
      </div>
    </div>
    ${
      isExpanded
        ? (() => {
            const isBorderSide =
              (entry as Record<string, unknown>).$shorthandType === "border-side";
            const expanded = shortVal
              ? isBorderSide
                ? expandBorderSide(shortVal as string)
                : expandShorthand(shortVal as string, longhands.length)
              : null;
            const compress = isBorderSide ? compressBorderSide : compressShorthand;
            const emptyVal = isBorderSide ? "" : "0";
            return longhands.map(({ name, entry: lEntry }: CssLonghand, idx: number) => {
              const lVal = style[name] ?? (expanded ? expanded[idx] : "");
              return html`
                <div class="style-row style-row--child" data-prop=${name}>
                  <div class="style-row-label">
                    ${
                      lVal !== undefined && lVal !== ""
                        ? html`<span
                            class="set-dot"
                            title="Clear ${name}"
                            @click=${(e: Event) => {
                              e.stopPropagation();
                              const vals = longhands.map((l: CssLonghand, i: number) =>
                                i === idx
                                  ? emptyVal
                                  : (style[l.name] ?? (expanded ? expanded[i] : emptyVal)),
                              );
                              transactDoc(activeTab.value, (t) => {
                                for (const l of longhands) {
                                  if (style[l.name] !== undefined) {
                                    mutateFn(t, l.name);
                                  }
                                }
                                mutateFn(t, shortProp, compress(vals as string[]));
                              });
                            }}
                          ></span>`
                        : nothing
                    }
                    <sp-field-label size="s" title=${name}
                      >${propLabel(lEntry, name)}</sp-field-label
                    >
                  </div>
                  ${widgetForType(
                    inferInputType(lEntry),
                    lEntry,
                    name,
                    lVal as string,
                    (newVal: string) => {
                      const vals = longhands.map((l: CssLonghand, i: number) =>
                        i === idx
                          ? newVal || emptyVal
                          : (style[l.name] ?? (expanded ? expanded[i] : emptyVal)),
                      );
                      transactDoc(activeTab.value, (t) => {
                        for (const l of longhands) {
                          if (style[l.name] !== undefined) {
                            mutateFn(t, l.name);
                          }
                        }
                        mutateFn(t, shortProp, compress(vals as string[]));
                      });
                    },
                    {
                      placeholder: !lVal && inherited[name] ? String(inherited[name]) : "",
                    },
                  )}
                </div>
              `;
            });
          })()
        : nothing
    }
  `;
}

// ─── Main template ──────────────────────────────────────────────────────────

/**
 * @param {JxMutableNode} node
 * @param {string | null} activeMediaTab
 * @param {string | null} activeSelector
 * @param {JxStyle} [effectiveStyle]
 */
function styleSidebarTemplate(
  node: JxMutableNode,
  activeMediaTab: string | null,
  activeSelector: string | null,
  effectiveStyle?: JxStyle,
) {
  const tab = activeTab.value!;
  const sel = tab.session.selection as JxPath;
  const style = effectiveStyle || node.style || {};
  // Signals seeding the ${} template default when a style value escalates (no $ref in JxStyle).
  const templateSignals = Object.entries(tab.doc.document.state || {})
    .filter(
      ([, d]) =>
        !(d as Record<string, unknown>)?.$handler &&
        (d as Record<string, unknown>)?.$prototype !== "Function",
    )
    .map(([defName]) => defName);
  const { sizeBreakpoints } = parseMediaEntries(getEffectiveMedia(tab.doc.document.$media));
  const mediaNames = sizeBreakpoints.map((bp) => bp.name);
  const mediaTab = activeMediaTab || null;

  // ── Scheme-layer routing (spec §9.5) ────────────────────────────────────────
  // With the tab-bar scheme control forcing a scheme that has a matching declared scheme query,
  // Base-context edits target that scheme's `@--name` block — no extra sidebar tabs. Breakpoint
  // Tabs stay breakpoint-scoped (scheme × breakpoint compound blocks are unsupported).
  const forcedScheme = tab.session.ui.previewColorScheme;
  const schemeLayer =
    mediaTab === null && (forcedScheme === "light" || forcedScheme === "dark")
      ? (Object.entries(getEffectiveMedia(tab.doc.document.$media) ?? {}).find(
          ([, q]) => schemeOfQuery(String(q)) === forcedScheme,
        )?.[0] ?? null)
      : null;
  // The media context edits actually target: a valid breakpoint tab, else the scheme layer.
  const editMedia = mediaTab && mediaNames.length > 0 ? mediaTab : schemeLayer;

  // ── Media tabs template ──────────────────────────────────────────────────
  const mediaTabsT =
    mediaNames.length > 0
      ? html`
          <sp-tabs
            size="s"
            selected=${mediaTab || "base"}
            @change=${(e: Event) => {
              const val = (e.target as HTMLElement & { selected: string }).selected;
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
  const contextStyle = editMedia
    ? (style[`@${editMedia}`] as Record<string, unknown>) || {}
    : style;
  const existingSelectors = Object.keys(contextStyle).filter((s) => isNestedSelector(s));
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
      @change=${(e: Event) => {
        const val = (e.target as HTMLElement & { value: string }).value;
        if (val === "__add_custom__") {
          requestAnimationFrame(() => {
            (e.target as HTMLElement & { value: string }).value = activeSelector || "__base__";
          });
          const picker = e.target as HTMLElement;
          const bar = picker.closest(".style-toolbar") as HTMLElement;
          picker.style.display = "none";
          const inp = document.createElement("input");
          inp.type = "text";
          inp.className = "selector-custom-input";
          inp.placeholder = ":hover, .child, &.active, [attr]";
          bar.append(inp);
          inp.focus();
          let done = false;
          const finish = (accept: boolean) => {
            if (done) {
              return;
            }
            done = true;
            const v = inp.value.trim();
            inp.remove();
            picker.style.display = "";
            if (accept && v && isNestedSelector(v)) {
              activeTab.value!.session.ui.activeSelector = v;
            }
          };
          inp.addEventListener("keydown", (ev) => {
            if (ev.key === "Enter") {
              finish(true);
            } else if (ev.key === "Escape") {
              finish(false);
            }
          });
          inp.addEventListener("blur", () => finish(inp.value.trim().length > 0));
          return;
        }
        const newSelector = val === "__base__" ? null : val;
        activeTab.value!.session.ui.activeSelector = newSelector;
      }}
    >
      <sp-menu-item value="__base__">(base)</sp-menu-item>
      <sp-menu-divider></sp-menu-divider>
      ${COMMON_SELECTORS.map(
        (s) => html`
          <sp-menu-item value=${s}>${existingSet.has(s) ? `${s}  \u25CF` : s}</sp-menu-item>
        `,
      )}
      ${
        extraSelectors.length > 0
          ? html`
              <sp-menu-divider></sp-menu-divider>
              ${extraSelectors.map((s) => html` <sp-menu-item value=${s}>${s} ●</sp-menu-item> `)}
            `
          : nothing
      }
      <sp-menu-divider></sp-menu-divider>
      <sp-menu-item value="__add_custom__">+ Add custom…</sp-menu-item>
    </sp-picker>
  `;

  // ── Combined toolbar (media tabs + scheme badge + selector) ────────────────
  // No scheme tabs — the tab-bar control is the one switch; the badge shows where edits land.
  const schemeBadgeT = schemeLayer
    ? html`
        <span
          class="style-scheme-badge"
          title="Edits target the @${schemeLayer} variant — set the tab-bar scheme control to Auto to edit base styles"
        >
          ${mediaDisplayName(schemeLayer)} variant
        </span>
      `
    : nothing;
  const toolbarT = html`
    <div class="style-toolbar">
      <div class="style-toolbar-tabs">${mediaTabsT} ${schemeBadgeT}</div>
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
        @input=${(e: Event) => {
          activeTab.value!.session.ui.styleFilter = (e.target as HTMLInputElement).value;
        }}
      ></sp-textfield>
      <sp-action-button
        size="xs"
        class="style-filter-toggle"
        ?selected=${tab.session.ui.styleFilterActive}
        @click=${() => {
          activeTab.value!.session.ui.styleFilterActive =
            !activeTab.value!.session.ui.styleFilterActive;
        }}
      >
        Active
      </sp-action-button>
    </div>
  `;

  // ── Determine the active style object ──────────────────────────────────────
  let activeStyle: JxStyle;
  let commitMutate: StyleMutateFn;
  if (activeSelector && isTagPath(activeSelector) && editMedia) {
    const mediaObj = getNestedStyle(style, `@${editMedia}`) ?? {};
    activeStyle = resolveNestedTagStyle(mediaObj, activeSelector);
    const stylePath = activeSelector.split(" ");
    commitMutate = (t: Tab, prop: string, val: string | Record<string, unknown> | undefined) =>
      mutateUpdateMediaNestedStylePath(
        t,
        sel,
        editMedia,
        stylePath,
        prop,
        val as string | undefined,
      );
  } else if (activeSelector && isTagPath(activeSelector)) {
    activeStyle = resolveNestedTagStyle(style, activeSelector);
    const stylePath = activeSelector.split(" ");
    commitMutate = (t: Tab, prop: string, val: string | Record<string, unknown> | undefined) =>
      mutateUpdateNestedStylePath(t, sel, stylePath, prop, val as string | undefined);
  } else if (activeSelector && editMedia) {
    const mediaObj = getNestedStyle(style, `@${editMedia}`) ?? {};
    activeStyle = getNestedStyle(mediaObj, activeSelector) ?? {};
    commitMutate = (t: Tab, prop: string, val: string | Record<string, unknown> | undefined) =>
      mutateUpdateMediaNestedStyle(
        t,
        sel,
        editMedia,
        activeSelector,
        prop,
        val as string | undefined,
      );
  } else if (activeSelector) {
    activeStyle = getNestedStyle(style, activeSelector) ?? {};
    commitMutate = (t: Tab, prop: string, val: string | Record<string, unknown> | undefined) =>
      mutateUpdateNestedStyle(t, sel, activeSelector, prop, val as string | undefined);
  } else {
    activeStyle = {};
    const inMediaCtx = editMedia !== null;
    const flatSource = inMediaCtx ? (getNestedStyle(style, `@${editMedia}`) ?? {}) : style;
    for (const [p, v] of Object.entries(flatSource)) {
      if (typeof v !== "object") {
        activeStyle[p] = v;
      }
    }
    commitMutate = inMediaCtx
      ? (t: Tab, prop: string, val: string | Record<string, unknown> | undefined) =>
          mutateUpdateMediaStyle(t, sel, editMedia, prop, val as string | undefined)
      : (t: Tab, prop: string, val: string | Record<string, unknown> | undefined) =>
          mutateUpdateStyle(t, sel, prop, val as string | undefined);
  }
  const commitStyle = (prop: string, val?: string | Record<string, unknown> | undefined) =>
    transactDoc(activeTab.value, (t) => commitMutate(t, prop, val));

  // ── Compute inherited style ────────────────────────────────────────────────
  // Scheme layer: the base styles show through as inherited (placeholders); breakpoint tabs
  // Inherit from higher breakpoints as before.
  const inheritedStyle: Record<string, string | number> = schemeLayer
    ? (Object.fromEntries(
        Object.entries(
          activeSelector ? (getNestedStyle(style, activeSelector) ?? {}) : style,
        ).filter(([, v]) => typeof v !== "object"),
      ) as Record<string, string | number>)
    : computeInheritedStyle(style, mediaNames, mediaTab, activeSelector);

  // Auto-open sections that have properties
  const newSections = autoOpenSections({ style: activeStyle }, tab.session.ui.styleSections);
  if (JSON.stringify(newSections) !== JSON.stringify(tab.session.ui.styleSections)) {
    tab.session.ui.styleSections = newSections;
  }

  // Partition properties into sections
  const sectionProps: Record<string, { prop: string; entry: CssPropertyEntry }[]> = {};
  for (const sec of cssMeta.$sections) {
    sectionProps[sec.key] = [];
  }

  for (const [prop, entry] of Object.entries(cssMeta.$defs) as [string, CssPropertyEntry][]) {
    if (typeof (entry as Record<string, unknown>).$shorthand === "string") {
      continue;
    }
    const sec = ((entry as Record<string, unknown>).$section as string) || "other";
    sectionProps[sec]!.push({ entry, prop });
  }
  for (const sec of cssMeta.$sections) {
    sectionProps[sec.key]!.sort(
      (
        a: { prop: string; entry: CssPropertyEntry },
        b: { prop: string; entry: CssPropertyEntry },
      ) =>
        ((a.entry as Record<string, unknown>).$order as number) -
        ((b.entry as Record<string, unknown>).$order as number),
    );
  }

  const otherProps = [];
  for (const prop of Object.keys(activeStyle)) {
    if (!(cssMeta.$defs as Record<string, unknown>)[prop]) {
      const val = activeStyle[prop];
      if (val !== null && typeof val === "object") {
        continue;
      }
      otherProps.push(prop);
    }
  }

  const nestedRules: string[] = [];
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
      const entries = sectionProps[sec.key]!;

      const sectionActiveProps = entries.filter(
        ({ prop, entry }: { prop: string; entry: CssPropertyEntry }) => {
          if (activeStyle[prop] !== undefined) {
            return true;
          }
          if (inferInputType(entry) === "shorthand") {
            return (getLonghands(prop) as CssLonghand[]).some(
              (l: CssLonghand) => activeStyle[l.name] !== undefined,
            );
          }
          return false;
        },
      );

      const isOpen = isFiltering ? true : (tab.session.ui.styleSections[sec.key] ?? false);

      if (!isOpen) {
        return html`
          <sp-accordion-item
            label=${sec.label}
            .open=${false}
            @sp-accordion-item-toggle=${(e: Event) => {
              activeTab.value!.session.ui.styleSections = {
                ...activeTab.value!.session.ui.styleSections,
                [sec.key]: (e.target as HTMLElement & { open: boolean }).open,
              };
            }}
          >
            ${
              sectionActiveProps.length > 0
                ? html`
                    <span slot="heading" style="display:flex;align-items:center;gap:6px">
                      ${sec.label}
                      <span
                        class="set-dot set-dot--section"
                        title="Clear all ${sec.label.toLowerCase()} properties"
                        @click=${(e: Event) => {
                          e.stopPropagation();
                          e.preventDefault();
                          transactDoc(activeTab.value, (t) => {
                            for (const { prop, entry } of sectionActiveProps) {
                              if (activeStyle[prop] !== undefined) {
                                commitMutate(t, prop);
                              }
                              if (inferInputType(entry) === "shorthand") {
                                for (const l of getLonghands(prop) as CssLonghand[]) {
                                  if (activeStyle[l.name] !== undefined) {
                                    commitMutate(t, l.name);
                                  }
                                }
                              }
                            }
                          });
                        }}
                      ></span>
                    </span>
                  `
                : nothing
            }
          </sp-accordion-item>
        `;
      }

      const rows = [];
      for (const { prop, entry } of entries) {
        const val = activeStyle[prop];
        const hasVal = val !== undefined;
        const condMet = allConditionsPass(entry, activeStyle);
        const type = inferInputType(entry);
        if (!hasVal && !condMet) {
          continue;
        }

        if (filterText) {
          const label = propLabel(entry, prop).toLowerCase();
          if (!prop.includes(filterText) && !label.includes(filterText)) {
            continue;
          }
        }
        if (filterActive) {
          if (type === "shorthand") {
            const longhands = getLonghands(prop) as CssLonghand[];
            const hasAnySet =
              hasVal || longhands.some((l: CssLonghand) => activeStyle[l.name] !== undefined);
            if (!hasAnySet) {
              continue;
            }
          } else if (!hasVal) {
            continue;
          }
        }

        if (type === "shorthand") {
          const longhands = getLonghands(prop) as CssLonghand[];
          const hasAny =
            hasVal || longhands.some((l: CssLonghand) => activeStyle[l.name] !== undefined);
          if (!hasAny && !condMet) {
            continue;
          }
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
                (val as string) ?? "",
                (newVal: string | undefined) => commitStyle(prop, newVal || undefined),
                () => commitStyle(prop),
                isWarning,
                sec.$layout === "grid",
                inheritedStyle[prop] as string | undefined,
                templateSignals,
                `style|${sel.join("/")}|${editMedia ?? ""}|${activeSelector ?? ""}|${prop}`,
              ),
            );
          }
        }
      }

      if (isFiltering && rows.length === 0) {
        return nothing;
      }

      return html`
        <sp-accordion-item
          label=${sec.label}
          .open=${isOpen}
          @sp-accordion-item-toggle=${(e: Event) => {
            activeTab.value!.session.ui.styleSections = {
              ...activeTab.value!.session.ui.styleSections,
              [sec.key]: (e.target as HTMLElement & { open: boolean }).open,
            };
          }}
        >
          ${
            sectionActiveProps.length > 0
              ? html`
                  <span slot="heading" style="display:flex;align-items:center;gap:6px">
                    ${sec.label}
                    <span
                      class="set-dot set-dot--section"
                      title="Clear all ${sec.label.toLowerCase()} properties"
                      @click=${(e: Event) => {
                        e.stopPropagation();
                        e.preventDefault();
                        transactDoc(activeTab.value, (t) => {
                          for (const { prop, entry } of sectionActiveProps) {
                            if (activeStyle[prop] !== undefined) {
                              commitMutate(t, prop);
                            }
                            if (inferInputType(entry) === "shorthand") {
                              for (const l of getLonghands(prop) as CssLonghand[]) {
                                if (activeStyle[l.name] !== undefined) {
                                  commitMutate(t, l.name);
                                }
                              }
                            }
                          }
                        });
                      }}
                    ></span>
                  </span>
                `
              : nothing
          }
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
      @sp-accordion-item-toggle=${(e: Event) => {
        activeTab.value!.session.ui.styleSections = {
          ...activeTab.value!.session.ui.styleSections,
          other: (e.target as HTMLElement & { open: boolean }).open,
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
                @change=${(e: Event) => {
                  const newProp = (e.target as HTMLInputElement).value.trim();
                  if (newProp && newProp !== prop) {
                    transactDoc(activeTab.value, (t) => {
                      commitMutate(t, prop);
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
                @input=${debouncedStyleCommit(`custom:${prop}`, 400, (e: Event) => {
                  commitStyle(prop, (e.target as HTMLInputElement).value);
                })}
              ></sp-textfield>
              <sp-action-button size="xs" quiet @click=${() => commitStyle(prop)}>
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
            @keydown=${(e: KeyboardEvent) => {
              if (e.key === "Enter") {
                e.preventDefault();
                const prop = (e.target as HTMLInputElement).value.trim();
                if (prop) {
                  const initial = cssInitialMap.get(prop) || "";
                  commitStyle(prop, initial || "");
                  (e.target as HTMLInputElement).value = "";
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
            @sp-accordion-item-toggle=${(e: Event) => {
              activeTab.value!.session.ui.styleSections = {
                ...activeTab.value!.session.ui.styleSections,
                nested: (e.target as HTMLElement & { open: boolean }).open,
              };
            }}
          >
            <div style="display:flex;flex-direction:column;gap:4px;padding:4px 0">
              ${nestedRules.map(
                (rule) => html`
                  <div style="display:flex;align-items:center;gap:4px">
                    <button
                      style="flex:1;text-align:left;padding:6px 10px;background:var(--spectrum-gray-200, #1a1a1a);border:none;border-radius:var(--radius);color:var(--spectrum-gray-900, #fafafa);font-size:var(--spectrum-font-size-75, 12px);cursor:pointer"
                      @click=${() => {
                        const newSelector = activeSelector ? `${activeSelector} ${rule}` : rule;
                        selectStylebookTag(newSelector, undefined, {
                          panCanvas: true,
                        });
                      }}
                    >
                      ${rule}
                    </button>
                    <sp-action-button size="xs" quiet @click=${() => commitStyle(rule)}>
                      <sp-icon-delete slot="icon"></sp-icon-delete>
                    </sp-action-button>
                  </div>
                `,
              )}
              <button
                style="padding:6px 10px;background:none;border:1px dashed var(--spectrum-gray-400, #333);border-radius:var(--radius);color:var(--spectrum-gray-700, #a1a1aa);font-size:var(--spectrum-font-size-75, 12px);cursor:pointer"
                @click=${async () => {
                  const name = await showPromptDialog("Add Nested Selector", {
                    confirmLabel: "Add",
                    message: "Enter a selector to nest under the current rule.",
                    placeholder: "th, :hover, .active",
                    validate: (v) => (v.trim() ? "" : "Enter a selector."),
                  });
                  if (name) {
                    commitStyle(name, {});
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
export function renderStylePanelTemplate(ctx: { getCanvasMode: () => string }) {
  const tab = activeTab.value;
  const noDocument = () =>
    renderEmptyState({
      actions: [openPageAction()],
      message: "Open a page to style what you click.",
    });
  if (!tab) {
    return noDocument();
  }
  if (ctx.getCanvasMode() === "stylebook" && shell.stylebook.selection) {
    const node = tab.doc.document;
    if (!node) {
      return noDocument();
    }
    return html`
      <div class="stylebook-style-header">Styling: &lt;${shell.stylebook.selection}&gt;</div>
      ${styleSidebarTemplate(
        node,
        tab.session.ui.activeMedia,
        tab.session.ui.activeSelector,
        getEffectiveStyle(node.style),
      )}
    `;
  }
  if (!tab.session.selection) {
    return renderEmptyState({ message: clickAnythingTo("style it") });
  }
  const node = getNodeAtPath(tab.doc.document, tab.session.selection);
  if (!node) {
    return renderEmptyState({ message: staleSelectionMessage() });
  }
  return styleSidebarTemplate(node, tab.session.ui.activeMedia, tab.session.ui.activeSelector);
}

/** Single property input row (generic field row helper) */
export function _fieldRow(
  label: string,
  type: string,
  value: string,
  onChange: (v: string | boolean) => void,
  _datalistId: string | undefined,
) {
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;
  const onInput = (e: Event) => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => onChange((e.target as HTMLInputElement).value), 400);
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
            ?checked=${Boolean(value)}
            @change=${(e: Event) => onChange((e.target as HTMLInputElement).checked)}
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
