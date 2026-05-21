/**
 * Stylebook panel — renders the Settings mode canvas (element catalog, design variables,
 * definitions, content types). Extracted from studio.js Phase 4e.
 */

import { html, render as litRender, nothing } from "lit-html";
import { ref } from "lit-html/directives/ref.js";
import { styleMap } from "lit-html/directives/style-map.js";

import {
  updateSession,
  updateUi,
  canvasWrap,
  canvasPanels,
  elToPath,
  projectState,
} from "../store.js";
import { activeTab } from "../workspace/workspace.js";
import { transactDoc, mutateUpdateStyle } from "../tabs/transact.js";
import { view } from "../view.js";
import { defineElement, setSkipServerFunctions } from "@jxsuite/runtime";
import { componentRegistry } from "../files/components.js";
import { getEffectiveStyle, getEffectiveMedia } from "../site-context.js";
import { parseMediaEntries, activeBreakpointsForWidth } from "../utils/canvas-media.js";
import { mediaDisplayName } from "./shared.js";
import { friendlyNameToVar, varDisplayName } from "../utils/studio-utils.js";
import { renderDefsEditor } from "../settings/defs-editor.js";
import { renderContentTypesEditor } from "../settings/content-types-editor.js";
import stylebookMeta from "../../data/stylebook-meta.json";

export { stylebookMeta };

/** @type {any} */
let _ctx = null;

/**
 * Render the stylebook/settings mode into the canvas.
 *
 * @param {{
 *   canvasPanelTemplate: Function;
 *   applyTransform: Function;
 *   observeCenterUntilStable: Function;
 *   renderZoomIndicator: Function;
 *   updateActivePanelHeaders: Function;
 *   overlayBoxDescriptor: Function;
 *   effectiveZoom: Function;
 * }} ctx
 */
export function renderStylebookMode(ctx) {
  _ctx = ctx;

  const settingsTab = activeTab.value?.session.ui.settingsTab || "stylebook";

  const settingsChromeBarTpl = html`
    <div
      class="sb-chrome settings-top-chrome"
      style="position:absolute;top:0;left:0;right:0;z-index:16;background:var(--bg-panel);border-bottom:1px solid var(--border)"
    >
      <sp-tabs
        size="s"
        selected=${settingsTab}
        @change=${(/** @type {any} */ e) => {
          updateUi("settingsTab", e.target.selected);
        }}
      >
        <sp-tab label="Stylebook" value="stylebook"></sp-tab>
        <sp-tab label="Definitions" value="definitions"></sp-tab>
        <sp-tab label="Content Types" value="contentTypes"></sp-tab>
      </sp-tabs>
    </div>
  `;

  if (settingsTab === "definitions" || settingsTab === "contentTypes") {
    /** @type {any} */ (canvasWrap).style.overflow = "hidden";

    litRender(
      html`${settingsChromeBarTpl}
        <div
          class="settings-editor-container"
          style="position:absolute;inset:40px 0 0 0;overflow:auto"
        ></div>`,
      /** @type {any} */ (canvasWrap),
    );

    const container = /** @type {HTMLElement} */ (
      canvasWrap.querySelector(".settings-editor-container")
    );
    if (settingsTab === "definitions") renderDefsEditor(container);
    else renderContentTypesEditor(container);
    return;
  }

  // Stylebook tab — element catalog / variables
  view.stylebookElToTag = new WeakMap();
  const tab = activeTab.value;
  const rootStyle = getEffectiveStyle(tab?.doc.document?.style);
  const filter = (tab?.session.ui.stylebookFilter || "").toLowerCase();
  const customizedOnly = tab?.session.ui.stylebookCustomizedOnly;

  const { sizeBreakpoints, baseWidth } = parseMediaEntries(
    getEffectiveMedia(tab?.doc.document?.$media),
  );
  const hasMedia = sizeBreakpoints.length > 0;

  const onTabClick = (/** @type {string} */ t) => {
    updateUi("stylebookTab", t);
  };

  const onFilterInput = (/** @type {any} */ e) => {
    updateUi("stylebookFilter", e.target.value);
  };

  const onCustomizedToggle = () => {
    updateUi("stylebookCustomizedOnly", !tab?.session.ui.stylebookCustomizedOnly);
  };

  const chromeBarTpl = html`
    ${settingsChromeBarTpl}
    <div
      class="sb-chrome"
      style="position:absolute;top:36px;left:0;right:0;z-index:15;background:var(--bg-panel);border-bottom:1px solid var(--border)"
    >
      <sp-tabs
        size="s"
        selected=${tab?.session.ui.stylebookTab || "elements"}
        @change=${(/** @type {any} */ e) => {
          onTabClick(e.target.selected);
        }}
      >
        ${["elements", "variables"].map(
          (t) => html`
            <sp-tab label=${t.charAt(0).toUpperCase() + t.slice(1)} value=${t}></sp-tab>
          `,
        )}
      </sp-tabs>
      ${tab?.session.ui.stylebookTab === "elements"
        ? html`
            <input
              class="field-input"
              style="flex:1;max-width:200px;margin-left:8px"
              placeholder="Filter…"
              .value=${tab?.session.ui.stylebookFilter}
              @input=${onFilterInput}
            />
            <button
              class="tb-toggle${tab?.session.ui.stylebookCustomizedOnly ? " active" : ""}"
              style="margin-left:4px"
              @click=${onCustomizedToggle}
            >
              Customized
            </button>
          `
        : nothing}
    </div>
  `;

  /** @type {any} */ (canvasWrap).style.overflow = "hidden";

  /** @type {any[]} */
  const allPanelDefs = [];
  if (hasMedia) {
    allPanelDefs.push({
      name: "base",
      displayName: mediaDisplayName("--"),
      width: baseWidth,
      activeSet: activeBreakpointsForWidth(sizeBreakpoints, baseWidth),
    });
    for (const bp of sizeBreakpoints) {
      allPanelDefs.push({
        name: bp.name,
        displayName: mediaDisplayName(bp.name),
        width: bp.width,
        activeSet: activeBreakpointsForWidth(sizeBreakpoints, bp.width),
      });
    }
  }

  const renderIntoPanel = (/** @type {any} */ panel, /** @type {any} */ activeBreakpoints) => {
    panel.canvas.classList.add("sb-canvas");
    if (tab?.session.ui.stylebookTab === "elements") {
      renderStylebookElementsIntoCanvas(
        panel.canvas,
        rootStyle,
        filter,
        customizedOnly,
        activeBreakpoints,
      );
      for (const child of panel.canvas.querySelectorAll("*")) {
        child.style.pointerEvents = "none";
      }
      registerStylebookPanelEvents(panel);
    } else {
      renderStylebookVarsIntoCanvas(panel.canvas, rootStyle);
      panel.overlayClk.style.pointerEvents = "none";
    }
  };

  /** @type {{ tpl: any; panel: any; activeSet: any }[]} */
  let panelEntries;
  if (!hasMedia) {
    const effectiveMedia = getEffectiveMedia(tab?.doc.document?.$media);
    const hasBaseWidth = effectiveMedia && effectiveMedia["--"];
    const label = hasBaseWidth ? `${mediaDisplayName("--")} (${baseWidth}px)` : null;
    const entry = ctx.canvasPanelTemplate(
      hasBaseWidth ? "base" : null,
      label,
      !hasBaseWidth,
      hasBaseWidth ? baseWidth : undefined,
    );
    panelEntries = [{ tpl: entry.tpl, panel: entry.panel, activeSet: new Set() }];
  } else {
    panelEntries = allPanelDefs.map((def) => {
      const label = `${def.displayName} (${def.width}px)`;
      const { tpl, panel } = ctx.canvasPanelTemplate(def.name, label, false, def.width);
      return { tpl, panel, activeSet: def.activeSet };
    });
  }

  litRender(
    html`
      ${chromeBarTpl}
      <div
        class="panzoom-wrap"
        style="transform-origin:0 0;padding-top:72px"
        ${ref((el) => {
          if (el) view.panzoomWrap = /** @type {HTMLDivElement} */ (el);
        })}
      >
        ${panelEntries.map((e) => e.tpl)}
      </div>
    `,
    /** @type {any} */ (canvasWrap),
  );

  for (const { panel, activeSet } of panelEntries) {
    canvasPanels.push(panel);
    renderIntoPanel(panel, activeSet);
  }
  if (hasMedia) {
    ctx.updateActivePanelHeaders();
  }

  ctx.applyTransform();
  ctx.observeCenterUntilStable();
  ctx.renderZoomIndicator();
}

/**
 * Select a tag in the stylebook — shared by layers panel click and canvas click.
 *
 * @param {string} tag
 * @param {string | null} [media]
 */
export function selectStylebookTag(tag, media) {
  updateSession({
    selection: [],
    ui: {
      stylebookSelection: tag,
      rightTab: "style",
      activeSelector: `& ${tag}`,
      ...(media !== undefined ? { activeMedia: media } : {}),
    },
  });
  renderStylebookOverlays();
}

/** Draw selection + hover overlays for stylebook elements */
export function renderStylebookOverlays() {
  if (!_ctx) return;
  if (canvasPanels.length === 0) return;

  const selectedTag = activeTab.value?.session.ui.stylebookSelection;

  for (const panel of canvasPanels) {
    const hoverTag = /** @type {any} */ (panel)._lastHoverTag;
    /**
     * @type {{
     *   cls: string;
     *   top: string;
     *   left: string;
     *   width: string;
     *   height: string;
     *   label?: string;
     * }[]}
     */
    const boxes = [];

    if (hoverTag && hoverTag !== selectedTag) {
      const el = findStylebookEl(panel.canvas, hoverTag);
      if (el) boxes.push({ ..._ctx.overlayBoxDescriptor(el, "hover", panel), label: undefined });
    }

    if (selectedTag) {
      const el = findStylebookEl(panel.canvas, selectedTag);
      if (el)
        boxes.push({
          ..._ctx.overlayBoxDescriptor(el, "selection", panel),
          label: `<${selectedTag}>`,
        });
    }

    litRender(
      html`
        ${panel.dropLine}
        ${boxes.map(
          (b) => html`
            <div
              class=${b.cls}
              style="top:${b.top};left:${b.left};width:${b.width};height:${b.height}"
            >
              ${b.label ? html`<div class="overlay-label">${b.label}</div>` : nothing}
            </div>
          `,
        )}
      `,
      panel.overlay,
    );
  }
}

// ─── Internal helpers (exported for testing) ─────────────────────────────────

/**
 * Build a DOM element tree from a stylebook-meta.json entry.
 *
 * @param {any} entry
 * @param {any} rootStyle
 * @param {any} activeBreakpoints
 * @param {string | null} [parentTag]
 */
export function buildStylebookElement(entry, rootStyle, activeBreakpoints, parentTag = null) {
  const el = document.createElement(entry.tag);
  if (entry.text) el.textContent = entry.text;
  if (entry.attributes) {
    for (const [k, v] of Object.entries(entry.attributes)) {
      try {
        el.setAttribute(k, /** @type {string} */ (v));
      } catch {}
    }
  }
  if (entry.style) el.style.cssText = entry.style;
  const compoundSelector =
    parentTag && parentTag !== entry.tag ? `& ${parentTag} ${entry.tag}` : null;
  const tagStyle = (compoundSelector && rootStyle[compoundSelector]) || rootStyle[`& ${entry.tag}`];
  if (tagStyle) {
    for (const [prop, val] of Object.entries(tagStyle)) {
      if (typeof val === "string" || typeof val === "number") {
        try {
          /** @type {any} */ (el.style)[prop] = val;
        } catch {}
      }
    }
    if (activeBreakpoints) {
      // Check media overrides nested inside the tag style (selector wraps media)
      for (const [key, val] of Object.entries(tagStyle)) {
        if (!key.startsWith("@") || typeof val !== "object") continue;
        const mediaName = key.slice(1);
        if (mediaName === "--") continue;
        if (activeBreakpoints.has(mediaName)) {
          for (const [prop, v] of Object.entries(/** @type {any} */ (val))) {
            if (typeof v === "string" || typeof v === "number") {
              try {
                /** @type {any} */ (el.style)[prop] = v;
              } catch {}
            }
          }
        }
      }
    }
  }
  // Check top-level @media keys for tag-specific overrides (media wraps selector)
  if (activeBreakpoints) {
    const selector = compoundSelector || `& ${entry.tag}`;
    for (const [key, val] of Object.entries(rootStyle)) {
      if (!key.startsWith("@") || typeof val !== "object") continue;
      const mediaName = key.slice(1);
      if (mediaName === "--") continue;
      if (activeBreakpoints.has(mediaName)) {
        const mediaTagStyle = /** @type {any} */ (val)[selector];
        if (mediaTagStyle && typeof mediaTagStyle === "object") {
          for (const [prop, v] of Object.entries(mediaTagStyle)) {
            if (typeof v === "string" || typeof v === "number") {
              try {
                /** @type {any} */ (el.style)[prop] = v;
              } catch {}
            }
          }
        }
      }
    }
  }
  if (entry.children) {
    for (const child of entry.children) {
      el.appendChild(buildStylebookElement(child, rootStyle, activeBreakpoints, entry.tag));
    }
  }
  return el;
}

/**
 * Render a live component preview by registering its custom element and instantiating it.
 *
 * @param {any} comp
 * @returns {Promise<HTMLElement>}
 */
export async function renderComponentPreview(comp) {
  setSkipServerFunctions(true);
  try {
    if (comp.source === "npm") {
      if (!customElements.get(comp.tagName)) {
        throw new Error("not registered");
      }
    } else {
      const root = projectState?.projectRoot;
      const url = `${location.origin}/${root ? root + "/" : ""}${comp.path}`;
      await defineElement(url);
    }
    const el = document.createElement(comp.tagName);
    for (const p of comp.props || []) {
      if (p.default !== undefined && p.default !== "false" && p.default !== "''") {
        const val = String(p.default).replace(/^'|'$/g, "");
        el.setAttribute(p.name, val);
      }
    }
    return el;
  } catch (/** @type {any} */ e) {
    console.warn("Component preview failed:", comp.tagName, e);
    const fallback = document.createElement("div");
    fallback.style.cssText =
      "padding:12px;border:1px dashed var(--border);border-radius:4px;color:var(--fg-dim)";
    fallback.textContent = `<${comp.tagName}>`;
    return fallback;
  }
}

/**
 * @param {any} rootStyle
 * @param {any} tag
 */
function hasTagStyle(rootStyle, tag) {
  const s = rootStyle[`& ${tag}`];
  if (s && typeof s === "object" && Object.keys(s).length > 0) return true;
  const selector = `& ${tag}`;
  for (const [key, val] of Object.entries(rootStyle)) {
    if (!key.startsWith("@") || typeof val !== "object") continue;
    if (/** @type {any} */ (val)[selector]) return true;
  }
  return false;
}

/**
 * @param {any} canvasEl
 * @param {any} rootStyle
 * @param {any} filter
 * @param {any} customizedOnly
 * @param {any} activeBreakpoints
 */
export function renderStylebookElementsIntoCanvas(
  canvasEl,
  rootStyle,
  filter,
  customizedOnly,
  activeBreakpoints,
) {
  for (const [k, v] of Object.entries(rootStyle)) {
    if (k.startsWith("--") && (typeof v === "string" || typeof v === "number")) {
      canvasEl.style.setProperty(k, String(v));
    }
  }

  /** @type {import("lit-html").TemplateResult[]} */
  const sectionTemplates = [];

  for (const section of stylebookMeta.$sections) {
    let entries = /** @type {any} */ (section.elements);
    if (filter) {
      entries = entries.filter(
        (/** @type {any} */ e) =>
          e.tag.includes(filter) || section.label.toLowerCase().includes(filter),
      );
    }
    if (customizedOnly) {
      entries = entries.filter((/** @type {any} */ e) => hasTagStyle(rootStyle, e.tag));
    }
    if (entries.length === 0) continue;

    const cardTemplates = entries.map((/** @type {any} */ entry) => {
      const el = buildStylebookElement(entry, rootStyle, activeBreakpoints);
      return html`
        <div
          class="element-card"
          ${ref((card) => {
            if (!card) return;
            view.stylebookElToTag.set(card, entry.tag);
            elToPath.set(card, ["__sb", entry.tag]);
            for (const child of el.querySelectorAll("*")) {
              const childTag = child.tagName.toLowerCase();
              if (!view.stylebookElToTag.has(child)) {
                const compound = childTag === entry.tag ? entry.tag : `${entry.tag} ${childTag}`;
                view.stylebookElToTag.set(child, compound);
                elToPath.set(child, ["__sb", compound]);
              }
            }
          })}
        >
          <div
            class="element-card-preview"
            ${ref((c) => {
              if (c) {
                c.textContent = "";
                c.appendChild(el);
              }
            })}
          ></div>
          <div class="element-card-label">&lt;${entry.tag}&gt;</div>
        </div>
      `;
    });

    sectionTemplates.push(html`
      <div class="sb-section">
        <div class="sb-label">${section.label}</div>
        <div class="sb-body">${cardTemplates}</div>
      </div>
    `);
  }

  // Custom components from registry
  if (componentRegistry.length > 0) {
    let comps = componentRegistry;
    if (filter)
      comps = comps.filter((/** @type {any} */ c) => c.tagName.toLowerCase().includes(filter));
    if (customizedOnly)
      comps = comps.filter((/** @type {any} */ c) => hasTagStyle(rootStyle, c.tagName));
    if (comps.length > 0) {
      const compCards = comps.map((/** @type {any} */ comp) => {
        /** @type {HTMLDivElement | null} */
        let previewEl = null;
        const cardTpl = html`
          <div
            class="element-card"
            style="display:inline-flex;width:auto"
            ${ref((card) => {
              if (!card) return;
              view.stylebookElToTag.set(card, comp.tagName);
              elToPath.set(card, ["__sb", comp.tagName]);
            })}
          >
            <div
              class="element-card-preview"
              ${ref((c) => {
                if (c) previewEl = /** @type {HTMLDivElement} */ (c);
              })}
            ></div>
            <div class="element-card-label">&lt;${comp.tagName}&gt;</div>
          </div>
        `;
        renderComponentPreview(comp).then((el) => {
          if (previewEl) previewEl.appendChild(el);
        });
        return cardTpl;
      });

      sectionTemplates.push(html`
        <div class="sb-section">
          <div class="sb-label">Components</div>
          <div class="sb-body">${compCards}</div>
        </div>
      `);
    }
  }

  if (sectionTemplates.length === 0) {
    litRender(
      html`
        <div style="padding:48px;text-align:center;color:var(--fg-dim);font-size:13px">
          ${customizedOnly ? "No customized elements" : "No matching elements"}
        </div>
      `,
      canvasEl,
    );
  } else {
    litRender(html`${sectionTemplates}`, canvasEl);
  }
}

/**
 * Render variables into the canvas (card-based layout matching Elements tab)
 *
 * @param {any} canvasEl
 * @param {any} rootStyle
 */
function renderStylebookVarsIntoCanvas(canvasEl, rootStyle) {
  const varCats = stylebookMeta.$variables;

  /** @type {Record<string, any>} */
  const groups = {};
  for (const key of Object.keys(varCats)) groups[key] = [];
  for (const [k, v] of Object.entries(rootStyle)) {
    if (!k.startsWith("--")) continue;
    if (typeof v !== "string" && typeof v !== "number") continue;
    if (k.startsWith("--color")) groups.color.push([k, v]);
    else if (k.startsWith("--font")) groups.font.push([k, v]);
    else if (k.startsWith("--size") || k.startsWith("--spacing") || k.startsWith("--radius"))
      groups.size.push([k, v]);
    else groups.other.push([k, v]);
  }

  /** @type {Map<string, HTMLElement | null>} */
  const bodyRefs = new Map();

  const sectionTemplates = Object.entries(varCats).map(([catKey, catMeta]) => {
    const vars = groups[catKey];

    const onAdd = () => {
      const bodyEl = bodyRefs.get(catKey);
      if (!bodyEl) return;
      const addBtn = bodyEl.querySelector(".sb-var-add-btn");
      const row = renderVarRow(catKey, /** @type {any} */ (catMeta), null, "", true);
      bodyEl.insertBefore(row, addBtn);
      if (addBtn) /** @type {any} */ (addBtn).style.display = "none";
      const nameField = /** @type {any} */ (row.querySelector("sp-textfield"));
      if (nameField) requestAnimationFrame(() => nameField.focus());
    };

    return html`
      <div class="sb-section">
        <div class="sb-label">${/** @type {any} */ (catMeta).label}</div>
        <div
          class="sb-body"
          ${ref((el) => {
            if (el) bodyRefs.set(catKey, /** @type {HTMLElement} */ (el));
          })}
        >
          ${vars.length > 0
            ? vars.map((/** @type {[string, any]} */ [varName, varVal]) =>
                renderVarRow(catKey, /** @type {any} */ (catMeta), varName, String(varVal), false),
              )
            : html`<div class="sb-var-empty">
                No ${/** @type {any} */ (catMeta).label.toLowerCase()} variables yet.
              </div>`}
          <button class="sb-var-add-btn" @click=${onAdd}>
            <span class="sb-var-add-icon">+</span> Add ${/** @type {any} */ (catMeta).label}
          </button>
        </div>
      </div>
    `;
  });

  litRender(html`${sectionTemplates}`, canvasEl);
}

/**
 * Render a single variable row — used for both existing and add-new.
 *
 * @param {string} catKey
 * @param {any} catMeta
 * @param {string | null} varName
 * @param {string} varVal
 * @param {boolean} isNew
 */
function renderVarRow(catKey, catMeta, varName, varVal, isNew) {
  const row = document.createElement("div");
  row.className = isNew ? "sb-var-row is-new" : "sb-var-row";

  /** @type {any} */
  let colorPicker = null;
  /** @type {any} */
  let nameField = null;
  /** @type {any} */
  let getValueFn;
  /** @type {any} */
  let hexField = null;

  const swatchTpl =
    catKey === "color"
      ? html`
          <div
            class="sb-var-swatch"
            style=${styleMap({ backgroundColor: varVal || "var(--accent)" })}
          >
            <input
              type="color"
              .value=${varVal && varVal.startsWith("#") ? varVal : "#007acc"}
              ${ref((el) => {
                if (el) colorPicker = el;
              })}
              @input=${() => {
                if (!colorPicker || !hexField) return;
                hexField.value = colorPicker.value;
                const swatch = /** @type {any} */ (row.querySelector(".sb-var-swatch"));
                if (swatch) swatch.style.backgroundColor = colorPicker.value;
                if (!isNew && varName) {
                  transactDoc(activeTab.value, (t) =>
                    mutateUpdateStyle(t, [], varName, colorPicker.value),
                  );
                }
              }}
            />
          </div>
        `
      : nothing;

  const namePlaceholder =
    catKey === "color"
      ? "Primary Blue"
      : catKey === "font"
        ? "Body Serif"
        : catKey === "size"
          ? "Spacing Large"
          : "Border Radius";

  const nameColTpl = isNew
    ? html`
        <div class="sb-var-col-name">
          <div class="sb-var-col-label">Name</div>
          <sp-textfield
            size="s"
            placeholder=${namePlaceholder}
            style="pointer-events:auto"
            ${ref((el) => {
              if (el) nameField = el;
            })}
          ></sp-textfield>
        </div>
      `
    : nothing;

  /** @type {any} */
  let valueContent;

  if (catKey === "color") {
    /** @type {any} */
    let debounce;
    valueContent = html`
      <sp-textfield
        size="s"
        .value=${varVal || "#007acc"}
        placeholder="#007acc"
        style="pointer-events:auto"
        ${ref((el) => {
          if (el) hexField = el;
        })}
        @input=${() => {
          clearTimeout(debounce);
          debounce = setTimeout(() => {
            if (!hexField) return;
            const v = hexField.value;
            try {
              if (colorPicker) colorPicker.value = v.startsWith("#") ? v : colorPicker.value;
            } catch {}
            const swatch = /** @type {any} */ (row.querySelector(".sb-var-swatch"));
            if (swatch) swatch.style.backgroundColor = v;
            if (!isNew && varName) {
              transactDoc(activeTab.value, (t) => mutateUpdateStyle(t, [], varName, v));
            }
          }, 400);
        }}
      ></sp-textfield>
    `;
    getValueFn = () => hexField?.value?.trim() || "";
  } else if (catKey === "size") {
    const ui = createUnitInput(varVal || "16px", {
      onChange: (/** @type {any} */ newVal) => {
        const bar = /** @type {any} */ (row.querySelector(".sb-var-size-bar"));
        if (bar) bar.style.width = newVal;
        if (!isNew && varName) {
          transactDoc(activeTab.value, (t) => mutateUpdateStyle(t, [], varName, newVal));
        }
      },
    });
    if (isNew) ui.textfield.value = "";
    valueContent = html`<div
      ${ref((el) => {
        if (el && !el.firstChild) el.appendChild(ui.wrap);
      })}
    ></div>`;
    getValueFn = () => ui.getValue();
  } else {
    /** @type {any} */
    let textFieldEl = null;
    /** @type {any} */
    let debounce;
    valueContent = html`
      <sp-textfield
        size="s"
        .value=${varVal}
        placeholder=${catMeta.placeholder}
        style="pointer-events:auto"
        ${ref((el) => {
          if (el) textFieldEl = el;
        })}
        @input=${() => {
          if (!textFieldEl || isNew || !varName) return;
          clearTimeout(debounce);
          debounce = setTimeout(() => {
            const v = textFieldEl.value;
            const fontPrev = /** @type {any} */ (row.querySelector(".sb-var-font-preview"));
            if (fontPrev) fontPrev.style.fontFamily = v;
            transactDoc(activeTab.value, (t) => mutateUpdateStyle(t, [], varName, v));
          }, 400);
        }}
      ></sp-textfield>
    `;
    getValueFn = () => textFieldEl?.value?.trim() || "";
  }

  const valColTpl = html`
    <div class="sb-var-col-value">
      ${isNew ? html`<div class="sb-var-col-label">Value</div>` : nothing} ${valueContent}
    </div>
  `;

  const actionsTpl = isNew
    ? html`
        <div class="sb-var-add-actions">
          <sp-action-button
            size="s"
            style="pointer-events:auto"
            @click=${() => {
              const name = (nameField?.value || "").trim();
              const val = getValueFn();
              const generatedVar = friendlyNameToVar(name, catMeta.prefix);
              if (!generatedVar || !val) return;
              transactDoc(activeTab.value, (t) => mutateUpdateStyle(t, [], generatedVar, val));
            }}
            >Add</sp-action-button
          >
          <sp-action-button
            size="s"
            quiet
            style="pointer-events:auto"
            @click=${() => {
              const body = row.parentElement;
              row.remove();
              const addBtn = /** @type {any} */ (body?.querySelector(".sb-var-add-btn"));
              if (addBtn) addBtn.style.display = "";
            }}
          >
            <sp-icon-close slot="icon"></sp-icon-close>
          </sp-action-button>
        </div>
      `
    : nothing;

  const headerTpl =
    !isNew && varName
      ? html`
          <div class="sb-var-row-header">
            <span class="sb-var-row-title">${varDisplayName(varName, catMeta.prefix)}</span>
            <span class="sb-var-row-ref">${varName}</span>
            <sp-action-button
              size="s"
              quiet
              class="sb-var-del"
              style="pointer-events:auto"
              @click=${() => {
                transactDoc(activeTab.value, (t) => mutateUpdateStyle(t, [], varName, undefined));
              }}
            >
              <sp-icon-delete slot="icon"></sp-icon-delete>
            </sp-action-button>
          </div>
        `
      : nothing;

  const addPreviewTpl = isNew
    ? html`
        <div
          class="sb-var-add-preview"
          ${ref((el) => {
            if (!el || !nameField) return;
            nameField.addEventListener("input", () => {
              el.textContent = friendlyNameToVar(nameField.value || "", catMeta.prefix);
            });
          })}
        ></div>
      `
    : nothing;

  const typePrevTpl =
    catKey === "font" && varVal
      ? html`
          <div class="sb-var-preview">
            <div class="sb-var-font-preview" style=${styleMap({ fontFamily: varVal })}>
              The quick brown fox jumps over the lazy dog
            </div>
          </div>
        `
      : catKey === "size" && varVal
        ? html`
            <div class="sb-var-preview">
              <div class="sb-var-size-track">
                <div class="sb-var-size-bar" style=${styleMap({ width: varVal })}></div>
              </div>
            </div>
          `
        : nothing;

  litRender(
    html`
      ${headerTpl}
      <div class="sb-var-input-row">${swatchTpl} ${nameColTpl} ${valColTpl} ${actionsTpl}</div>
      ${addPreviewTpl} ${typePrevTpl}
    `,
    row,
  );

  return row;
}

/**
 * Creates a combined textfield + quiet sp-picker for CSS values with units.
 *
 * @param {any} initialValue
 * @param {any} [options]
 */
function createUnitInput(initialValue, { onChange, size = "s" } = {}) {
  const match = String(initialValue).match(
    /^(-?[\d.]+)\s*(px|em|rem|vw|vh|%|ch|ex|vmin|vmax|pt|cm|mm|in)?$/,
  );
  let numVal = match ? match[1] : initialValue;
  let unitVal = match ? match[2] || "px" : "";
  const isNumeric = !!match;

  const wrap = document.createElement("div");
  wrap.className = "sb-unit-input";
  wrap.style.pointerEvents = "auto";

  /** @type {any} */
  let textfield = null;
  /** @type {any} */
  let picker = null;

  const units = [
    { value: "px", label: "px" },
    { value: "rem", label: "rem" },
    { value: "em", label: "em" },
    { value: "%", label: "%" },
    { value: "vw", label: "vw" },
    { value: "vh", label: "vh" },
    { value: "ch", label: "ch" },
    { value: "pt", label: "pt" },
    { divider: true },
    { value: "auto", label: "auto" },
    { value: "fit-content", label: "fit-content" },
  ];

  /** @type {any} */
  let debounce;

  function getValue() {
    const num = textfield?.value;
    const unit = picker?.value;
    if (unit === "auto" || unit === "fit-content") return unit;
    return num ? `${num}${unit}` : "";
  }

  litRender(
    html`
      <sp-textfield
        .value=${numVal}
        size=${size}
        ${ref((el) => {
          if (el) textfield = el;
        })}
        @input=${() => {
          clearTimeout(debounce);
          const raw = textfield?.value?.trim();
          const looksNumeric = /^-?[\d.]+$/.test(raw || "");
          if (picker) picker.style.display = looksNumeric ? "" : "none";
          debounce = setTimeout(() => {
            if (onChange) onChange(looksNumeric ? `${raw}${picker?.value}` : raw);
          }, 400);
        }}
      ></sp-textfield>
      <sp-picker
        quiet
        size=${size}
        style=${styleMap({ display: isNumeric ? "" : "none" })}
        ${ref((el) => {
          if (el) {
            picker = el;
            requestAnimationFrame(() => {
              /** @type {any} */ (el).value = unitVal || "px";
            });
          }
        })}
        @change=${() => {
          const unit = picker?.value;
          if (unit === "auto" || unit === "fit-content") {
            if (textfield) textfield.value = unit;
            if (picker) picker.style.display = "none";
            if (onChange) onChange(unit);
          } else {
            unitVal = unit;
            if (onChange) onChange(getValue());
          }
        }}
      >
        ${units.map((u) =>
          u.divider
            ? html`<sp-menu-divider></sp-menu-divider>`
            : html`<sp-menu-item value=${u.value}>${u.label}</sp-menu-item>`,
        )}
      </sp-picker>
    `,
    wrap,
  );

  return { wrap, textfield, picker, getValue };
}

/**
 * Click handler for stylebook canvas — selects elements via elToPath/view.stylebookElToTag mapping
 *
 * @param {any} panel
 */
function registerStylebookPanelEvents(panel) {
  const { canvas, overlayClk } = panel;

  overlayClk.addEventListener("click", (/** @type {any} */ e) => {
    const els = canvas.querySelectorAll("*");
    for (const el of els) el.style.pointerEvents = "auto";
    overlayClk.style.display = "none";
    const elements = document.elementsFromPoint(e.clientX, e.clientY);
    overlayClk.style.display = "";
    for (const el of els) el.style.pointerEvents = "none";

    for (const el of elements) {
      if (!canvas.contains(el) || el === canvas) continue;
      let cur = /** @type {any} */ (el);
      while (cur && cur !== canvas) {
        const tag = view.stylebookElToTag.get(cur);
        if (tag) {
          const newMedia = panel.mediaName === "base" ? null : (panel.mediaName ?? null);
          selectStylebookTag(tag, newMedia);
          if (_ctx) _ctx.updateActivePanelHeaders();
          return;
        }
        cur = cur.parentElement;
      }
    }
    updateSession({ ui: { stylebookSelection: null, activeSelector: null } });
    renderStylebookOverlays();
  });

  overlayClk.addEventListener("mousemove", (/** @type {any} */ e) => {
    const els = canvas.querySelectorAll("*");
    for (const el of els) el.style.pointerEvents = "auto";
    overlayClk.style.display = "none";
    const elements = document.elementsFromPoint(e.clientX, e.clientY);
    overlayClk.style.display = "";
    for (const el of els) el.style.pointerEvents = "none";

    let hoverTag = null;
    for (const el of elements) {
      if (!canvas.contains(el) || el === canvas) continue;
      let cur = /** @type {any} */ (el);
      while (cur && cur !== canvas) {
        const tag = view.stylebookElToTag.get(cur);
        if (tag) {
          hoverTag = tag;
          break;
        }
        cur = cur.parentElement;
      }
      if (hoverTag) break;
    }

    if (hoverTag !== panel._lastHoverTag) {
      panel._lastHoverTag = hoverTag;
      renderStylebookOverlays();
    }
  });
}

/** Find a stylebook element by tag in the canvas */
function findStylebookEl(/** @type {any} */ canvasEl, /** @type {any} */ tag) {
  for (const child of canvasEl.querySelectorAll("*")) {
    if (view.stylebookElToTag.get(child) === tag) return child;
  }
  return null;
}
