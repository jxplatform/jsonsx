/**
 * Right panel — orchestrates Properties / Events / Style tabs. The heavy sub-templates
 * (propertiesSidebarTemplate, renderStylePanelTemplate) remain in studio.js and are passed via ctx
 * to avoid moving ~2000 lines in one step.
 */

import { html, render as litRender, nothing } from "lit-html";
import { updateUi, rightPanel } from "../store.js";
import { effect, effectScope } from "../reactivity.js";
import { activeTab } from "../workspace/workspace.js";
import { tabIcon } from "./activity-bar.js";
import { eventsSidebarTemplate } from "./events-panel.js";
import { isCustomElementDoc } from "./signals-panel.js";

import { isColorPopoverOpen } from "../ui/color-selector.js";
import { renderStylePanelTemplate } from "./style-panel.js";
import { renderPropertiesPanelTemplate } from "./properties-panel.js";

/**
 * @typedef {{
 *   navigateToComponent: (path: string) => void;
 *   getCanvasMode: () => string;
 *   renderCanvas: () => void;
 *   updateForcedPseudoPreview: () => void;
 * }} RightPanelCtx
 */

/** @type {RightPanelCtx | null} */
let _ctx = null;

/** @type {import("@vue/reactivity").EffectScope | null} */
let _scope = null;

let _rendering = false;
let _scheduled = false;

/**
 * Mount the right panel.
 *
 * @param {RightPanelCtx} ctx
 */
export function mount(ctx) {
  _ctx = ctx;
  _scope = effectScope();
  _scope.run(() => {
    effect(() => {
      const tab = activeTab.value;
      if (!tab) return;
      // Track properties the right panel reads
      void tab.doc.document;
      void tab.session.selection;
      void tab.session.ui.rightTab;
      void tab.session.ui.activeMedia;
      void tab.session.ui.activeSelector;
      void tab.session.ui.styleSections;
      void tab.session.ui.styleShorthands;
      void tab.session.ui.styleFilter;
      void tab.session.ui.styleFilterActive;
      void tab.session.ui.inspectorSections;

      const colorPopoverOpen = isColorPopoverOpen();
      const activeTag = document.activeElement?.tagName;
      const rightHasFocus =
        !colorPopoverOpen &&
        rightPanel.contains(document.activeElement) &&
        (activeTag === "INPUT" ||
          activeTag === "TEXTAREA" ||
          activeTag === "SP-TEXTFIELD" ||
          activeTag === "SP-NUMBER-FIELD" ||
          activeTag === "SP-PICKER" ||
          activeTag === "SP-COMBOBOX" ||
          activeTag === "SP-SEARCH");

      if (!rightHasFocus) {
        render();
      }
    });
  });
}

export function unmount() {
  _scope?.stop();
  _scope = null;
  _ctx = null;
}

export function render() {
  if (!_ctx) return;
  if (_rendering) return;
  if (!_scheduled) {
    _scheduled = true;
    queueMicrotask(_flush);
  }
}

function _flush() {
  _scheduled = false;
  if (!_ctx) return;
  if (_rendering) return;
  _rendering = true;
  try {
    litRender(rightPanelTemplate(), rightPanel);
  } catch (e) {
    console.error("right-panel render error:", e);
    try {
      rightPanel.textContent = "";
      // @ts-ignore
      delete rightPanel["_$litPart$"];
      litRender(rightPanelTemplate(), rightPanel);
    } catch (e2) {
      console.error("right-panel retry failed:", e2);
    }
  } finally {
    _rendering = false;
  }
  _ctx.updateForcedPseudoPreview();
}

function rightPanelTemplate() {
  const ctx = /** @type {RightPanelCtx} */ (_ctx);
  const aTab = activeTab.value;
  if (!aTab) return nothing;
  const S = /** @type {any} */ ({
    ui: aTab.session.ui,
    document: aTab.doc.document,
    mode: aTab.doc.mode,
    selection: aTab.session.selection,
  });
  const tab = S.ui.rightTab;

  const panelTabs = [
    { value: "properties", icon: "sp-icon-properties", label: "Properties" },
    { value: "events", icon: "sp-icon-event", label: "Events" },
    { value: "style", icon: "sp-icon-brush", label: "Style" },
  ];

  const tabsT = html`
    <div class="panel-tabs">
      <sp-tabs
        selected=${tab}
        quiet
        @change=${(/** @type {Event & { target: { selected: string } }} */ e) => {
          const sel = e.target.selected;
          if (sel && sel !== tab) {
            updateUi("rightTab", sel);
          }
        }}
      >
        ${panelTabs.map(
          (t) => html`
            <sp-tab value=${t.value} title=${t.label} aria-label=${t.label}>
              ${tabIcon(t.icon, "xs")}
            </sp-tab>
          `,
        )}
      </sp-tabs>
    </div>
  `;

  /** @type {import("lit-html").TemplateResult | typeof nothing} */
  let bodyT = nothing;
  if (tab === "properties") {
    bodyT = renderPropertiesPanelTemplate({ navigateToComponent: ctx.navigateToComponent });
  } else if (tab === "events") {
    bodyT = eventsSidebarTemplate({
      isCustomElementDoc: () => isCustomElementDoc(S),
    });
  } else if (tab === "style") {
    try {
      bodyT = renderStylePanelTemplate({ getCanvasMode: ctx.getCanvasMode });
    } catch (/** @type {unknown} */ e) {
      console.error("[renderStylePanelTemplate]", e);
    }
  }

  return html`
    ${tabsT}
    <div class="panel-body">${bodyT}</div>
  `;
}
