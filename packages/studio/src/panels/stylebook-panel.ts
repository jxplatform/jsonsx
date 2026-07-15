/// <reference lib="dom" />
/**
 * Stylebook panel — renders the Stylebook mode canvas (element catalog with per-file style
 * defaults) through the IFRAME canvas pipeline: a specimen document is generated parent-side
 * ({@link file://./stylebook-doc.ts}) and mounted per breakpoint panel via `mountStylebookCanvas`,
 * so each panel is a real width-sized viewport and `@media` blocks evaluate for real (no JS
 * flatten). Hits decode to tags in the host and route back here through the injected stylebook-hit
 * handler (`setStylebookHitHandler` in studio.ts).
 */

import { html, render as litRender } from "lit-html";
import { ref } from "lit-html/directives/ref.js";
import { classMap } from "lit-html/directives/class-map.js";
import { live } from "lit-html/directives/live.js";

import { canvasPanels, canvasWrap, projectState, updateSession, updateUi } from "../store";
import { activeTab } from "../workspace/workspace";
import { view } from "../view";
import { componentRegistry } from "../files/components";
import { getEffectiveMedia, getEffectiveStyle } from "../site-context";
import { parseMediaEntries } from "../utils/canvas-media";
import { mediaDisplayName } from "./shared";
import { buildStylebookDoc } from "./stylebook-doc";
import { mountStylebookCanvas, panToStylebookTag } from "../canvas/iframe-host";
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

interface StylebookCtx {
  canvasPanelTemplate: (
    mediaName: string | null,
    label: string | null,
    fullWidth: boolean,
    width?: number | null,
  ) => { tpl: TemplateResult; panel: CanvasPanel };
  applyTransform: () => void;
  observeCenterUntilStable: () => void;
  updateActivePanelHeaders: () => void;
}

export { default as stylebookMeta } from "../../data/stylebook-meta.json";

/**
 * Render the stylebook mode into the canvas: chrome bar + one iframe panel per breakpoint, all
 * mounting the SAME generated specimen document.
 *
 * @param {StylebookCtx} ctx
 */
export function renderStylebookMode(ctx: StylebookCtx) {
  const tab = activeTab.value;
  const filter = (tab?.session.ui.stylebookFilter || "").toLowerCase();
  const customizedOnly = tab?.session.ui.stylebookCustomizedOnly;

  const effectiveMedia = getEffectiveMedia(tab?.doc.document?.$media);
  const { sizeBreakpoints, baseWidth } = parseMediaEntries(effectiveMedia);
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

  /** @type {{ name: string; displayName: string; width: number }[]} */
  const allPanelDefs = [];
  if (hasMedia) {
    allPanelDefs.push({
      displayName: mediaDisplayName("--"),
      name: "base",
      width: baseWidth,
    });
    for (const bp of sizeBreakpoints) {
      allPanelDefs.push({
        displayName: mediaDisplayName(bp.name),
        name: bp.name,
        width: bp.width,
      });
    }
  }

  /** @type {{ tpl: import("lit-html").TemplateResult; panel: CanvasPanel }[]} */
  let panelEntries;
  if (!hasMedia) {
    const hasBaseWidth = effectiveMedia && effectiveMedia["--"];
    const label = hasBaseWidth ? `${mediaDisplayName("--")} (${baseWidth}px)` : null;
    const entry = ctx.canvasPanelTemplate(
      hasBaseWidth ? "base" : null,
      label,
      !hasBaseWidth,
      hasBaseWidth ? baseWidth : undefined,
    );
    panelEntries = [{ panel: entry.panel, tpl: entry.tpl }];
  } else {
    panelEntries = allPanelDefs.map((def) => {
      const label = `${def.displayName} (${def.width}px)`;
      const { tpl, panel } = ctx.canvasPanelTemplate(def.name, label, false, def.width);
      return { panel, tpl };
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

  // ONE generated doc shared by every panel — per-panel @media differentiation comes from each
  // Iframe's real viewport width, not from a per-panel style flatten.
  const generated = buildStylebookDoc({
    components: componentRegistry,
    customizedOnly: Boolean(customizedOnly),
    effectiveMedia: effectiveMedia ?? {},
    effectiveStyle: getEffectiveStyle(tab?.doc.document?.style),
    filter,
    meta: stylebookMeta as { $sections: { label: string; elements: StylebookEntry[] }[] },
    projectRoot: projectState?.projectRoot ?? null,
  });

  for (const { panel } of panelEntries) {
    canvasPanels.push(panel);
    mountStylebookCanvas(
      view.renderGeneration,
      generated,
      panel.canvas as HTMLElement,
      panel._width,
    );
  }
  if (hasMedia) {
    ctx.updateActivePanelHeaders();
  }

  ctx.applyTransform();
  ctx.observeCenterUntilStable();
}

/**
 * Select a tag in the stylebook — shared by the canvas hit handler (via studio's
 * setStylebookHitHandler wiring), the stylebook layers panel, and the style panel. The host's
 * selection watcher tracks `ui.stylebookSelection` and measures the selected tag's card, so no
 * direct overlay drawing happens here.
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

  if (tag && panCanvas) {
    panToStylebookTag(tag);
  }
}

/** Re-exported for legacy consumers (the preview now lives in component-preview.ts). */
export { renderComponentPreview } from "./component-preview";
