/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
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
  canvasPanels,
  canvasWrap,
  elToPath,
  projectState,
  updateSession,
  updateUi,
} from "../store";
import { activeTab } from "../workspace/workspace";
import { view } from "../view";
import { defineElement, setSkipServerFunctions } from "@jxsuite/runtime";
import { componentRegistry } from "../files/components";
import type { ComponentEntry } from "../files/components";
import { getEffectiveMedia, getEffectiveStyle } from "../site-context";
import { activeBreakpointsForWidth, parseMediaEntries } from "../utils/canvas-media";
import { mediaDisplayName } from "./shared";
import { panToCanvasEl } from "../canvas/canvas-utils";
import stylebookMeta from "../../data/stylebook-meta.json";
import type { TemplateResult } from "lit-html";
import type { CanvasPanel } from "../types";

export interface StylebookEntry {
  tag: string;
  text?: string;
  attributes?: Record<string, string>;
  style?: string;
  children?: StylebookEntry[];
}

interface StylebookPanel {
  mediaName: string | null;
  element: HTMLElement | null;
  canvas: HTMLElement;
  overlay: HTMLElement;
  overlayClk: HTMLElement;
  viewport: HTMLElement | null;
  scrollContainer: HTMLElement | null;
  dropLine: HTMLElement | null;
  _width: number | null;
  _lastHoverTag?: string | null;
}

interface StylebookCtx {
  canvasPanelTemplate: (
    mediaName: string | null,
    label: string | null,
    fullWidth: boolean,
    width?: number | null,
  ) => { tpl: TemplateResult; panel: CanvasPanel };
  applyTransform: () => void;
  observeCenterUntilStable: () => void;
  renderZoomIndicator: () => void;
  updateActivePanelHeaders: () => void;
  overlayBoxDescriptor: (
    el: Element,
    type: string,
    panel: CanvasPanel,
  ) => {
    cls: string;
    top: string;
    left: string;
    width: string;
    height: string;
  };
  effectiveZoom: () => number;
}

export { default as stylebookMeta } from "../../data/stylebook-meta.json";

/**
 * Resolve a nested tag path in a style object. e.g., "table th" → style["table"]["th"]
 *
 * @param {Record<string, unknown>} style
 * @param {string} tagPath
 * @returns {Record<string, unknown> | null}
 */
function _resolveNestedStyle(style: Record<string, unknown>, tagPath: string) {
  const parts = tagPath.split(" ");
  let obj = style;
  for (const part of parts) {
    if (!obj || typeof obj !== "object") {
      return null;
    }
    obj = obj[part] as Record<string, unknown>;
  }
  return obj && typeof obj === "object" ? (obj as Record<string, unknown>) : null;
}

let _ctx: StylebookCtx | null = null;

/** Lookup: tag → entry from stylebookMeta (built once) */
const _entryByTag = new Map<string, StylebookEntry>();
for (const section of stylebookMeta.$sections) {
  for (const entry of section.elements as StylebookEntry[]) {
    _entryByTag.set(entry.tag, entry);
  }
}

/**
 * Render the stylebook/settings mode into the canvas.
 *
 * @param {StylebookCtx} ctx
 */
export function renderStylebookMode(ctx: StylebookCtx) {
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

  const onFilterInput = (e: Event) => {
    updateUi("stylebookFilter", (e.target as HTMLInputElement).value);
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
          class=${classMap({
            active: Boolean(tab?.session.ui.stylebookCustomizedOnly),
            "tb-toggle": true,
          })}
          @click=${onCustomizedToggle}
        >
          Customized
        </button>
      </div>
    </div>
  `;

  (canvasWrap as HTMLElement).style.overflow = "hidden";

  /** @type {{ name: string; displayName: string; width: number; activeSet: Set<string> }[]} */
  const allPanelDefs = [];
  if (hasMedia) {
    allPanelDefs.push({
      activeSet: activeBreakpointsForWidth(sizeBreakpoints, baseWidth),
      displayName: mediaDisplayName("--"),
      name: "base",
      width: baseWidth,
    });
    for (const bp of sizeBreakpoints) {
      allPanelDefs.push({
        activeSet: activeBreakpointsForWidth(sizeBreakpoints, bp.width),
        displayName: mediaDisplayName(bp.name),
        name: bp.name,
        width: bp.width,
      });
    }
  }

  const renderIntoPanel = (panel: StylebookPanel, activeBreakpoints: Set<string>) => {
    panel.canvas.classList.add("sb-canvas");
    renderStylebookElementsIntoCanvas(
      panel.canvas,
      rootStyle,
      filter,
      customizedOnly,
      activeBreakpoints,
    );
    for (const child of panel.canvas.querySelectorAll("*")) {
      (child as HTMLElement).style.pointerEvents = "none";
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
    panelEntries = [{ activeSet: new Set<string>(), panel: entry.panel, tpl: entry.tpl }];
  } else {
    panelEntries = allPanelDefs.map((def) => {
      const label = `${def.displayName} (${def.width}px)`;
      const { tpl, panel } = ctx.canvasPanelTemplate(def.name, label, false, def.width);
      return { activeSet: def.activeSet, panel, tpl };
    });
  }

  litRender(
    html`
      ${chromeBarTpl}
      <div
        class="panzoom-wrap"
        style="transform-origin:0 0;padding-top:40px"
        ${ref((el) => {
          if (el) {
            view.panzoomWrap = el as HTMLDivElement;
          }
        })}
      >
        ${panelEntries.map((e) => e.tpl)}
      </div>
    `,
    /** @type {HTMLElement} */ canvasWrap,
  );

  for (const { panel, activeSet } of panelEntries) {
    canvasPanels.push(/** @type {import("./canvas-dnd.js").CanvasPanel} */ panel);
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
  if (!tab) {
    return;
  }
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
      ? activeBreakpointsForWidth(sizeBreakpoints, panel._width as number)
      : new Set<string>();

    // Re-apply styles to each element in the canvas
    const allEls = canvas.querySelectorAll("*");
    for (const el of allEls) {
      const tag = view.stylebookElToTag.get(el);
      if (!tag) {
        continue;
      }
      const htmlEl = el as HTMLElement;
      // Determine if it's a compound selector (e.g. "ul li") or simple tag
      const parts = tag.split(" ");
      const leafTag = parts.at(-1)!;
      const entry = _entryByTag.get(leafTag);

      // Reset to base style
      htmlEl.style.cssText = entry?.style || "";

      // Apply root style for this tag (nested path)
      const tagStyle = _resolveNestedStyle(rootStyle, tag);
      if (tagStyle) {
        for (const [prop, val] of Object.entries(tagStyle)) {
          if (typeof val === "string" || typeof val === "number") {
            try {
              (htmlEl.style as unknown as Record<string, string | number>)[prop] = val;
            } catch {}
          }
        }
        // Media overrides nested in tag style
        if (activeBreakpoints.size > 0) {
          for (const [key, val] of Object.entries(tagStyle)) {
            if (!key.startsWith("@") || typeof val !== "object" || val === null) {
              continue;
            }
            const mediaName = key.slice(1);
            if (mediaName === "--") {
              continue;
            }
            if (activeBreakpoints.has(mediaName)) {
              for (const [prop, v] of Object.entries(val as Record<string, unknown>)) {
                if (typeof v === "string" || typeof v === "number") {
                  try {
                    (htmlEl.style as unknown as Record<string, string | number>)[prop] = v;
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
          if (!key.startsWith("@") || typeof val !== "object" || val === null) {
            continue;
          }
          const mediaName = key.slice(1);
          if (mediaName === "--") {
            continue;
          }
          if (activeBreakpoints.has(mediaName)) {
            const mediaTagStyle = _resolveNestedStyle(
              /** @type {Record<string, unknown>} */ val,
              tag,
            );
            if (mediaTagStyle && typeof mediaTagStyle === "object") {
              for (const [prop, v] of Object.entries(mediaTagStyle)) {
                if (typeof v === "string" || typeof v === "number") {
                  try {
                    (htmlEl.style as unknown as Record<string, string | number>)[prop] = v;
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
export function selectStylebookTag(tag: string, media?: string | null, { panCanvas = false } = {}) {
  updateSession({
    selection: [],
    ui: {
      activeSelector: tag,
      rightTab: "style",
      stylebookSelection: tag,
      ...(media !== undefined ? { activeMedia: media } : {}),
    },
  });
  renderStylebookOverlays();

  if (tag && panCanvas && canvasPanels.length > 0) {
    const el = findStylebookEl(canvasPanels[0]!.canvas, tag);
    if (el) {
      panToCanvasEl(el);
    }
  }
}

/** Draw selection + hover overlays for stylebook elements */
export function renderStylebookOverlays() {
  if (!_ctx) {
    return;
  }
  if (canvasPanels.length === 0) {
    return;
  }

  const selectedTag = activeTab.value?.session.ui.stylebookSelection;

  for (const panel of canvasPanels) {
    const hoverTag = (panel as StylebookPanel)._lastHoverTag;
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
      if (el) {
        boxes.push({
          ..._ctx.overlayBoxDescriptor(el, "hover", panel),
          label: undefined,
        });
      }
    }

    if (selectedTag) {
      const el = findStylebookEl(panel.canvas, selectedTag);
      if (el) {
        boxes.push({
          ..._ctx.overlayBoxDescriptor(el, "selection", panel),
          label: `<${selectedTag}>`,
        });
      }
    }

    litRender(
      html`
        ${panel.dropLine}
        ${boxes.map(
          (b) => html`
            <div
              class=${b.cls}
              style=${styleMap({
                height: b.height,
                left: b.left,
                top: b.top,
                width: b.width,
              })}
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
export function buildStylebookElement(
  entry: StylebookEntry,
  rootStyle: Record<string, unknown>,
  activeBreakpoints: Set<string> | null,
  parentTag: string | null = null,
) {
  const el = document.createElement(entry.tag);
  if (entry.text) {
    el.textContent = entry.text;
  }
  if (entry.attributes) {
    for (const [k, v] of Object.entries(entry.attributes)) {
      try {
        el.setAttribute(k, /** @type {string} */ v);
      } catch {}
    }
  }
  if (entry.style) {
    el.style.cssText = entry.style;
  }
  const compoundTag = parentTag && parentTag !== entry.tag ? `${parentTag} ${entry.tag}` : null;
  const tagStyle =
    (compoundTag && _resolveNestedStyle(rootStyle, compoundTag)) ||
    _resolveNestedStyle(rootStyle, entry.tag);
  if (tagStyle) {
    for (const [prop, val] of Object.entries(tagStyle)) {
      if (typeof val === "string" || typeof val === "number") {
        try {
          (el.style as unknown as Record<string, string | number>)[prop] = val;
        } catch {}
      }
    }
    if (activeBreakpoints) {
      // Check media overrides nested inside the tag style (selector wraps media)
      for (const [key, val] of Object.entries(tagStyle)) {
        if (!key.startsWith("@") || typeof val !== "object" || val === null) {
          continue;
        }
        const mediaName = key.slice(1);
        if (mediaName === "--") {
          continue;
        }
        if (activeBreakpoints.has(mediaName)) {
          for (const [prop, v] of Object.entries(val as Record<string, unknown>)) {
            if (typeof v === "string" || typeof v === "number") {
              try {
                (el.style as unknown as Record<string, string | number>)[prop] = v;
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
      if (!key.startsWith("@") || typeof val !== "object" || val === null) {
        continue;
      }
      const mediaName = key.slice(1);
      if (mediaName === "--") {
        continue;
      }
      if (activeBreakpoints.has(mediaName)) {
        const mediaTagStyle = _resolveNestedStyle(val as Record<string, unknown>, tagPath);
        if (mediaTagStyle && typeof mediaTagStyle === "object") {
          for (const [prop, v] of Object.entries(mediaTagStyle)) {
            if (typeof v === "string" || typeof v === "number") {
              try {
                (el.style as unknown as Record<string, string | number>)[prop] = v;
              } catch {}
            }
          }
        }
      }
    }
  }
  if (entry.children) {
    for (const child of entry.children) {
      el.append(buildStylebookElement(child, rootStyle, activeBreakpoints, entry.tag));
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
export async function renderComponentPreview(comp: ComponentEntry) {
  setSkipServerFunctions(true);
  try {
    if (comp.source === "npm") {
      if (!customElements.get(comp.tagName)) {
        return _componentFallback(comp.tagName);
      }
    } else {
      if (comp.path && !comp.path.endsWith(".json")) {
        // Format-class component sources (e.g. markdown) can't be imported as modules
        return _componentFallback(comp.tagName);
      }
      const root = projectState?.projectRoot;
      const url = `${location.origin}/${root ? `${root}/` : ""}${comp.path}`;
      await defineElement(url);
    }
    const el = document.createElement(comp.tagName);
    for (const p of comp.props || []) {
      if (p.default !== undefined && p.default !== "false" && p.default !== "''") {
        const val = String(p.default).replaceAll(/^'|'$/g, "");
        el.setAttribute(p.name, val);
      }
    }
    return el;
  } catch (error) {
    console.warn("Component preview failed:", comp.tagName, error);
    return _componentFallback(comp.tagName);
  }
}

/** @param {string} tagName */
function _componentFallback(tagName: string) {
  const fallback = document.createElement("div");
  fallback.style.cssText =
    "padding:12px;border:1px dashed var(--border);border-radius:var(--radius);color:var(--fg-dim)";
  fallback.textContent = `<${tagName}>`;
  return fallback;
}

/**
 * @param {Record<string, unknown>} rootStyle
 * @param {string} tag
 */
function hasTagStyle(rootStyle: Record<string, unknown>, tag: string) {
  const s = _resolveNestedStyle(rootStyle, tag);
  if (s && typeof s === "object" && Object.keys(s).length > 0) {
    return true;
  }
  for (const [key, val] of Object.entries(rootStyle)) {
    if (!key.startsWith("@") || typeof val !== "object" || val === null) {
      continue;
    }
    const ms = _resolveNestedStyle(val as Record<string, unknown>, tag);
    if (ms && typeof ms === "object" && Object.keys(ms).length > 0) {
      return true;
    }
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
  canvasEl: HTMLElement,
  rootStyle: Record<string, unknown>,
  filter: string,
  customizedOnly: boolean | undefined,
  activeBreakpoints: Set<string> | null,
) {
  for (const [k, v] of Object.entries(rootStyle)) {
    if (k.startsWith("--") && (typeof v === "string" || typeof v === "number")) {
      canvasEl.style.setProperty(k, String(v));
    }
  }

  const sectionTemplates: TemplateResult[] = [];

  for (const section of stylebookMeta.$sections) {
    let entries = section.elements as StylebookEntry[];
    if (filter) {
      entries = entries.filter(
        (e: StylebookEntry) =>
          e.tag.includes(filter) || section.label.toLowerCase().includes(filter),
      );
    }
    if (customizedOnly) {
      entries = entries.filter((e: StylebookEntry) => hasTagStyle(rootStyle, e.tag));
    }
    if (entries.length === 0) {
      continue;
    }

    const cardTemplates = entries.map((entry: StylebookEntry) => {
      const el = buildStylebookElement(entry, rootStyle, activeBreakpoints);
      return html`
        <div
          class="element-card"
          ${ref((card) => {
            if (!card) {
              return;
            }
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
                c.append(el);
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
    if (filter) {
      comps = comps.filter((c: ComponentEntry) => c.tagName.toLowerCase().includes(filter));
    }
    if (customizedOnly) {
      comps = comps.filter((c: ComponentEntry) => hasTagStyle(rootStyle, c.tagName));
    }
    if (comps.length > 0) {
      const compCards = comps.map((comp: ComponentEntry) => {
        let previewEl: HTMLDivElement | null = null;
        const cardTpl = html`
          <div
            class="element-card"
            style="display:inline-flex;width:auto"
            ${ref((card) => {
              if (!card) {
                return;
              }
              view.stylebookElToTag.set(card, comp.tagName);
              elToPath.set(card, ["__sb", comp.tagName]);
            })}
          >
            <div
              class="element-card-preview"
              ${ref((c) => {
                if (c) {
                  previewEl = c as HTMLDivElement;
                }
              })}
            ></div>
            <div class="element-card-label">&lt;${comp.tagName}&gt;</div>
          </div>
        `;
        renderComponentPreview(comp)
          .then((el) => {
            if (previewEl) {
              previewEl.append(el);
            }
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
function registerStylebookPanelEvents(panel: StylebookPanel) {
  const { canvas, overlayClk } = panel;

  overlayClk.addEventListener("click", (e: MouseEvent) => {
    const els = canvas.querySelectorAll("*");
    for (const el of els) {
      (el as HTMLElement).style.pointerEvents = "auto";
    }
    overlayClk.style.display = "none";
    const elements = document.elementsFromPoint(e.clientX, e.clientY);
    overlayClk.style.display = "";
    for (const el of els) {
      (el as HTMLElement).style.pointerEvents = "none";
    }

    for (const el of elements) {
      if (!canvas.contains(el) || el === canvas) {
        continue;
      }
      let cur = el as Element | null;
      while (cur && cur !== canvas) {
        const tag = view.stylebookElToTag.get(cur);
        if (tag) {
          const newMedia = panel.mediaName === "base" ? null : (panel.mediaName ?? null);
          selectStylebookTag(tag, newMedia);
          if (_ctx) {
            _ctx.updateActivePanelHeaders();
          }
          return;
        }
        cur = cur.parentElement;
      }
    }
    updateSession({ ui: { activeSelector: null, stylebookSelection: null } });
    renderStylebookOverlays();
  });

  overlayClk.addEventListener("mousemove", (e: MouseEvent) => {
    const els = canvas.querySelectorAll("*");
    for (const el of els) {
      (el as HTMLElement).style.pointerEvents = "auto";
    }
    overlayClk.style.display = "none";
    const elements = document.elementsFromPoint(e.clientX, e.clientY);
    overlayClk.style.display = "";
    for (const el of els) {
      (el as HTMLElement).style.pointerEvents = "none";
    }

    let hoverTag = null;
    for (const el of elements) {
      if (!canvas.contains(el) || el === canvas) {
        continue;
      }
      let cur = el as Element | null;
      while (cur && cur !== canvas) {
        const tag = view.stylebookElToTag.get(cur);
        if (tag) {
          hoverTag = tag;
          break;
        }
        cur = cur.parentElement;
      }
      if (hoverTag) {
        break;
      }
    }

    if (hoverTag !== panel._lastHoverTag) {
      panel._lastHoverTag = hoverTag;
      renderStylebookOverlays();
    }
  });
}

/** Find a stylebook element by tag in the canvas */
function findStylebookEl(canvasEl: HTMLElement, tag: string) {
  for (const child of canvasEl.querySelectorAll("*")) {
    if (view.stylebookElToTag.get(child) === tag) {
      return child as HTMLElement;
    }
  }
  return null;
}
