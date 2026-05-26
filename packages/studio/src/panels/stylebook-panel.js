/**
 * Stylebook panel — renders the Stylebook mode canvas (element catalog with per-file style
 * defaults). Extracted from studio.js Phase 4e.
 */

import { html, render as litRender, nothing } from "lit-html";
import { ref } from "lit-html/directives/ref.js";
import { classMap } from "lit-html/directives/class-map.js";
import { styleMap } from "lit-html/directives/style-map.js";
import { live } from "lit-html/directives/live.js";

import {
  updateSession,
  updateUi,
  canvasWrap,
  canvasPanels,
  elToPath,
  projectState,
} from "../store.js";
import { activeTab } from "../workspace/workspace.js";
import { view } from "../view.js";
import { defineElement, setSkipServerFunctions } from "@jxsuite/runtime";
import { componentRegistry } from "../files/components.js";
import { getEffectiveStyle, getEffectiveMedia } from "../site-context.js";
import { parseMediaEntries, activeBreakpointsForWidth } from "../utils/canvas-media.js";
import { mediaDisplayName } from "./shared.js";
import { panToCanvasEl } from "../canvas/canvas-utils.js";
import stylebookMeta from "../../data/stylebook-meta.json";

export { stylebookMeta };

/**
 * @typedef {{
 *   tag: string;
 *   text?: string;
 *   attributes?: Record<string, string>;
 *   style?: string;
 *   children?: StylebookEntry[];
 * }} StylebookEntry
 */

/**
 * @typedef {{
 *   mediaName: string | null;
 *   element: HTMLElement | null;
 *   canvas: HTMLElement;
 *   overlay: HTMLElement;
 *   overlayClk: HTMLElement;
 *   viewport: HTMLElement | null;
 *   scrollContainer: HTMLElement | null;
 *   dropLine: HTMLElement | null;
 *   _width: number | null;
 *   _lastHoverTag?: string | null;
 * }} StylebookPanel
 */

/**
 * @typedef {{
 *   canvasPanelTemplate: Function;
 *   applyTransform: Function;
 *   observeCenterUntilStable: Function;
 *   renderZoomIndicator: Function;
 *   updateActivePanelHeaders: Function;
 *   overlayBoxDescriptor: Function;
 *   effectiveZoom: Function;
 * }} StylebookCtx
 */

/**
 * @typedef {{
 *   source?: string;
 *   tagName: string;
 *   path?: string;
 *   props?: Array<{ name: string; default?: string }>;
 * }} ComponentEntry
 */

/**
 * Resolve a nested tag path in a style object. e.g., "table th" → style["table"]["th"]
 *
 * @param {Record<string, unknown>} style
 * @param {string} tagPath
 * @returns {Record<string, unknown> | null}
 */
function _resolveNestedStyle(style, tagPath) {
  const parts = tagPath.split(" ");
  let obj = style;
  for (const part of parts) {
    if (!obj || typeof obj !== "object") return null;
    obj = /** @type {Record<string, unknown>} */ (obj[part]);
  }
  return obj && typeof obj === "object" ? /** @type {Record<string, unknown>} */ (obj) : null;
}

/** @type {StylebookCtx | null} */
let _ctx = null;

/** Lookup: tag → entry from stylebookMeta (built once) */
const _entryByTag = new Map();
for (const section of stylebookMeta.$sections) {
  for (const entry of /** @type {StylebookEntry[]} */ (section.elements)) {
    _entryByTag.set(entry.tag, entry);
  }
}

/**
 * Render the stylebook/settings mode into the canvas.
 *
 * @param {StylebookCtx} ctx
 */
export function renderStylebookMode(ctx) {
  _ctx = ctx;

  // Stylebook mode — element catalog only
  view.stylebookElToTag = new WeakMap();
  const tab = activeTab.value;
  const rootStyle = getEffectiveStyle(tab?.doc.document?.style);
  const filter = (tab?.session.ui.stylebookFilter || "").toLowerCase();
  const customizedOnly = tab?.session.ui.stylebookCustomizedOnly;

  const { sizeBreakpoints, baseWidth } = parseMediaEntries(
    getEffectiveMedia(tab?.doc.document?.$media),
  );
  const hasMedia = sizeBreakpoints.length > 0;

  const onFilterInput = (/** @type {Event} */ e) => {
    updateUi("stylebookFilter", /** @type {HTMLInputElement} */ (e.target).value);
  };

  const onCustomizedToggle = () => {
    updateUi("stylebookCustomizedOnly", !tab?.session.ui.stylebookCustomizedOnly);
  };

  const chromeBarTpl = html`
    <div
      class="sb-chrome"
      style="position:absolute;top:0;left:0;right:0;z-index:15;background:var(--bg-panel);border-bottom:1px solid var(--border)"
    >
      <div style="display:flex;align-items:center;padding:4px 8px;gap:4px">
        <input
          class="field-input"
          style="flex:1;max-width:200px"
          placeholder="Filter…"
          .value=${live(tab?.session.ui.stylebookFilter)}
          @input=${onFilterInput}
        />
        <button
          class=${classMap({ "tb-toggle": true, active: tab?.session.ui.stylebookCustomizedOnly })}
          @click=${onCustomizedToggle}
        >
          Customized
        </button>
      </div>
    </div>
  `;

  /** @type {HTMLElement} */ (canvasWrap).style.overflow = "hidden";

  /** @type {{ name: string; displayName: string; width: number; activeSet: Set<string> }[]} */
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

  const renderIntoPanel = (
    /** @type {StylebookPanel} */ panel,
    /** @type {Set<string>} */ activeBreakpoints,
  ) => {
    panel.canvas.classList.add("sb-canvas");
    renderStylebookElementsIntoCanvas(
      panel.canvas,
      rootStyle,
      filter,
      customizedOnly,
      activeBreakpoints,
    );
    for (const child of panel.canvas.querySelectorAll("*")) {
      /** @type {HTMLElement} */ (child).style.pointerEvents = "none";
    }
    registerStylebookPanelEvents(panel);
  };

  /**
   * @type {{
   *   tpl: import("lit-html").TemplateResult;
   *   panel: StylebookPanel;
   *   activeSet: Set<string>;
   * }[]}
   */
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
        style="transform-origin:0 0;padding-top:40px"
        ${ref((el) => {
          if (el) view.panzoomWrap = /** @type {HTMLDivElement} */ (el);
        })}
      >
        ${panelEntries.map((e) => e.tpl)}
      </div>
    `,
    /** @type {HTMLElement} */ (canvasWrap),
  );

  for (const { panel, activeSet } of panelEntries) {
    canvasPanels.push(/** @type {any} */ (panel));
    renderIntoPanel(panel, activeSet);
  }
  if (hasMedia) {
    ctx.updateActivePanelHeaders();
  }

  ctx.applyTransform();
  ctx.observeCenterUntilStable();
  ctx.renderZoomIndicator();
}

/** Fast-path: re-apply styles to existing stylebook elements without rebuilding the DOM. */
export function refreshStylebookStyles() {
  const tab = activeTab.value;
  if (!tab) return;
  const rootStyle = getEffectiveStyle(tab.doc.document?.style);

  for (const panel of canvasPanels) {
    const { canvas } = panel;
    // Re-apply CSS custom properties
    for (const [k, v] of Object.entries(rootStyle)) {
      if (k.startsWith("--") && (typeof v === "string" || typeof v === "number")) {
        canvas.style.setProperty(k, String(v));
      }
    }

    const { sizeBreakpoints } = parseMediaEntries(getEffectiveMedia(tab.doc.document?.$media));
    const activeBreakpoints = panel.mediaName
      ? activeBreakpointsForWidth(sizeBreakpoints, /** @type {number} */ (panel._width))
      : new Set();

    // Re-apply styles to each element in the canvas
    const allEls = canvas.querySelectorAll("*");
    for (const el of allEls) {
      const tag = view.stylebookElToTag.get(el);
      if (!tag) continue;
      const htmlEl = /** @type {HTMLElement} */ (el);
      // Determine if it's a compound selector (e.g. "ul li") or simple tag
      const parts = tag.split(" ");
      const leafTag = parts[parts.length - 1];
      const entry = _entryByTag.get(leafTag);

      // Reset to base style
      htmlEl.style.cssText = entry?.style || "";

      // Apply root style for this tag (nested path)
      const tagStyle = _resolveNestedStyle(rootStyle, tag);
      if (tagStyle) {
        for (const [prop, val] of Object.entries(tagStyle)) {
          if (typeof val === "string" || typeof val === "number") {
            try {
              /** @type {Record<string, string | number>} */ (
                /** @type {unknown} */ (htmlEl.style)
              )[prop] = val;
            } catch {}
          }
        }
        // Media overrides nested in tag style
        if (activeBreakpoints.size > 0) {
          for (const [key, val] of Object.entries(tagStyle)) {
            if (!key.startsWith("@") || typeof val !== "object") continue;
            const mediaName = key.slice(1);
            if (mediaName === "--") continue;
            if (activeBreakpoints.has(mediaName)) {
              for (const [prop, v] of Object.entries(
                /** @type {Record<string, unknown>} */ (val),
              )) {
                if (typeof v === "string" || typeof v === "number") {
                  try {
                    /** @type {Record<string, string | number>} */ (
                      /** @type {unknown} */ (htmlEl.style)
                    )[prop] = v;
                  } catch {}
                }
              }
            }
          }
        }
      }
      // Top-level @media keys
      if (activeBreakpoints.size > 0) {
        for (const [key, val] of Object.entries(rootStyle)) {
          if (!key.startsWith("@") || typeof val !== "object") continue;
          const mediaName = key.slice(1);
          if (mediaName === "--") continue;
          if (activeBreakpoints.has(mediaName)) {
            const mediaTagStyle = _resolveNestedStyle(
              /** @type {Record<string, unknown>} */ (val),
              tag,
            );
            if (mediaTagStyle && typeof mediaTagStyle === "object") {
              for (const [prop, v] of Object.entries(mediaTagStyle)) {
                if (typeof v === "string" || typeof v === "number") {
                  try {
                    /** @type {Record<string, string | number>} */ (
                      /** @type {unknown} */ (htmlEl.style)
                    )[prop] = v;
                  } catch {}
                }
              }
            }
          }
        }
      }
    }
  }

  renderStylebookOverlays();
}

/**
 * Select a tag in the stylebook — shared by layers panel click and canvas click.
 *
 * @param {string} tag
 * @param {string | null} [media]
 */
export function selectStylebookTag(tag, media, { panCanvas = false } = {}) {
  updateSession({
    selection: [],
    ui: {
      stylebookSelection: tag,
      rightTab: "style",
      activeSelector: tag,
      ...(media !== undefined ? { activeMedia: media } : {}),
    },
  });
  renderStylebookOverlays();

  if (tag && panCanvas && canvasPanels.length > 0) {
    const el = findStylebookEl(canvasPanels[0].canvas, tag);
    if (el) panToCanvasEl(el);
  }
}

/** Draw selection + hover overlays for stylebook elements */
export function renderStylebookOverlays() {
  if (!_ctx) return;
  if (canvasPanels.length === 0) return;

  const selectedTag = activeTab.value?.session.ui.stylebookSelection;

  for (const panel of canvasPanels) {
    const hoverTag = /** @type {StylebookPanel} */ (panel)._lastHoverTag;
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
              style=${styleMap({ top: b.top, left: b.left, width: b.width, height: b.height })}
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
 * @param {StylebookEntry} entry
 * @param {Record<string, unknown>} rootStyle
 * @param {Set<string> | null} activeBreakpoints
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
  const compoundTag = parentTag && parentTag !== entry.tag ? `${parentTag} ${entry.tag}` : null;
  const tagStyle =
    (compoundTag && _resolveNestedStyle(rootStyle, compoundTag)) ||
    _resolveNestedStyle(rootStyle, entry.tag);
  if (tagStyle) {
    for (const [prop, val] of Object.entries(tagStyle)) {
      if (typeof val === "string" || typeof val === "number") {
        try {
          /** @type {Record<string, string | number>} */ (/** @type {unknown} */ (el.style))[prop] =
            val;
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
          for (const [prop, v] of Object.entries(/** @type {Record<string, unknown>} */ (val))) {
            if (typeof v === "string" || typeof v === "number") {
              try {
                /** @type {Record<string, string | number>} */ (/** @type {unknown} */ (el.style))[
                  prop
                ] = v;
              } catch {}
            }
          }
        }
      }
    }
  }
  // Check top-level @media keys for tag-specific overrides (media wraps selector)
  if (activeBreakpoints) {
    const tagPath = compoundTag || entry.tag;
    for (const [key, val] of Object.entries(rootStyle)) {
      if (!key.startsWith("@") || typeof val !== "object") continue;
      const mediaName = key.slice(1);
      if (mediaName === "--") continue;
      if (activeBreakpoints.has(mediaName)) {
        const mediaTagStyle = _resolveNestedStyle(
          /** @type {Record<string, unknown>} */ (val),
          tagPath,
        );
        if (mediaTagStyle && typeof mediaTagStyle === "object") {
          for (const [prop, v] of Object.entries(mediaTagStyle)) {
            if (typeof v === "string" || typeof v === "number") {
              try {
                /** @type {Record<string, string | number>} */ (/** @type {unknown} */ (el.style))[
                  prop
                ] = v;
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
 * @param {ComponentEntry} comp
 * @returns {Promise<HTMLElement>}
 */
export async function renderComponentPreview(comp) {
  setSkipServerFunctions(true);
  try {
    if (comp.source === "npm") {
      if (!customElements.get(comp.tagName)) {
        return _componentFallback(comp.tagName);
      }
    } else {
      if (comp.path && /\.md$/i.test(comp.path)) {
        return _componentFallback(comp.tagName);
      }
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
  } catch (/** @type {unknown} */ e) {
    console.warn("Component preview failed:", comp.tagName, e);
    return _componentFallback(comp.tagName);
  }
}

/** @param {string} tagName */
function _componentFallback(tagName) {
  const fallback = document.createElement("div");
  fallback.style.cssText =
    "padding:12px;border:1px dashed var(--border);border-radius:4px;color:var(--fg-dim)";
  fallback.textContent = `<${tagName}>`;
  return fallback;
}

/**
 * @param {Record<string, unknown>} rootStyle
 * @param {string} tag
 */
function hasTagStyle(rootStyle, tag) {
  const s = _resolveNestedStyle(rootStyle, tag);
  if (s && typeof s === "object" && Object.keys(s).length > 0) return true;
  for (const [key, val] of Object.entries(rootStyle)) {
    if (!key.startsWith("@") || typeof val !== "object") continue;
    const ms = _resolveNestedStyle(/** @type {Record<string, unknown>} */ (val), tag);
    if (ms && typeof ms === "object" && Object.keys(ms).length > 0) return true;
  }
  return false;
}

/**
 * @param {HTMLElement} canvasEl
 * @param {Record<string, unknown>} rootStyle
 * @param {string} filter
 * @param {boolean | undefined} customizedOnly
 * @param {Set<string> | null} activeBreakpoints
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
    let entries = /** @type {StylebookEntry[]} */ (section.elements);
    if (filter) {
      entries = entries.filter(
        (/** @type {StylebookEntry} */ e) =>
          e.tag.includes(filter) || section.label.toLowerCase().includes(filter),
      );
    }
    if (customizedOnly) {
      entries = entries.filter((/** @type {StylebookEntry} */ e) => hasTagStyle(rootStyle, e.tag));
    }
    if (entries.length === 0) continue;

    const cardTemplates = entries.map((/** @type {StylebookEntry} */ entry) => {
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
      comps = comps.filter((/** @type {ComponentEntry} */ c) =>
        c.tagName.toLowerCase().includes(filter),
      );
    if (customizedOnly)
      comps = comps.filter((/** @type {ComponentEntry} */ c) => hasTagStyle(rootStyle, c.tagName));
    if (comps.length > 0) {
      const compCards = comps.map((/** @type {ComponentEntry} */ comp) => {
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
        renderComponentPreview(comp)
          .then((el) => {
            if (previewEl) previewEl.appendChild(el);
          })
          .catch(() => {});
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
 * Click handler for stylebook canvas — selects elements via elToPath/view.stylebookElToTag mapping
 *
 * @param {StylebookPanel} panel
 */
function registerStylebookPanelEvents(panel) {
  const { canvas, overlayClk } = panel;

  overlayClk.addEventListener("click", (/** @type {MouseEvent} */ e) => {
    const els = canvas.querySelectorAll("*");
    for (const el of els) /** @type {HTMLElement} */ (el).style.pointerEvents = "auto";
    overlayClk.style.display = "none";
    const elements = document.elementsFromPoint(e.clientX, e.clientY);
    overlayClk.style.display = "";
    for (const el of els) /** @type {HTMLElement} */ (el).style.pointerEvents = "none";

    for (const el of elements) {
      if (!canvas.contains(el) || el === canvas) continue;
      let cur = /** @type {Element | null} */ (el);
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

  overlayClk.addEventListener("mousemove", (/** @type {MouseEvent} */ e) => {
    const els = canvas.querySelectorAll("*");
    for (const el of els) /** @type {HTMLElement} */ (el).style.pointerEvents = "auto";
    overlayClk.style.display = "none";
    const elements = document.elementsFromPoint(e.clientX, e.clientY);
    overlayClk.style.display = "";
    for (const el of els) /** @type {HTMLElement} */ (el).style.pointerEvents = "none";

    let hoverTag = null;
    for (const el of elements) {
      if (!canvas.contains(el) || el === canvas) continue;
      let cur = /** @type {Element | null} */ (el);
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
function findStylebookEl(/** @type {HTMLElement} */ canvasEl, /** @type {string} */ tag) {
  for (const child of canvasEl.querySelectorAll("*")) {
    if (view.stylebookElToTag.get(child) === tag) return /** @type {HTMLElement} */ (child);
  }
  return null;
}
