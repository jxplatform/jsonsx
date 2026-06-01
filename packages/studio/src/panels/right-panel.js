/**
 * Right panel — orchestrates Properties / Events / Style tabs. The heavy sub-templates
 * (propertiesSidebarTemplate, renderStylePanelTemplate) remain in studio.js and are passed via ctx
 * to avoid moving ~2000 lines in one step.
 */

import { html, render as litRender } from "lit-html";
import { updateUi, rightPanel } from "../store.js";
import { effect, effectScope } from "../reactivity.js";
import { activeTab } from "../workspace/workspace.js";
import { tabIcon } from "./activity-bar.js";
import { eventsSidebarTemplate } from "./events-panel.js";
import { isCustomElementDoc } from "./signals-panel.js";

import { isColorPopoverOpen } from "../ui/color-selector.js";
import { renderStylePanelTemplate } from "./style-panel.js";
import { renderPropertiesPanelTemplate } from "./properties-panel.js";
import {
  renderAiPanelTemplate,
  mountAiPanel,
  mountQuikChat,
  registerRightPanelRender,
} from "./ai-panel.js";

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
let _hasFocus = false;

function _isTextInput(/** @type {Element | null} */ el) {
  if (!el) return false;
  const tag = el.tagName.toLowerCase();
  if (tag === "input" || tag === "textarea") return true;
  if (tag === "sp-textfield" || tag === "sp-number-field" || tag === "sp-search") return true;
  if (el.shadowRoot?.activeElement) return _isTextInput(el.shadowRoot.activeElement);
  return false;
}

function _onFocusIn(/** @type {FocusEvent} */ e) {
  _hasFocus = _isTextInput(/** @type {Element} */ (e.target));
}

function _onFocusOut() {
  _hasFocus = false;
  render();
}

/**
 * Mount the right panel.
 *
 * @param {RightPanelCtx} ctx
 */
export function mount(ctx) {
  _ctx = ctx;
  mountAiPanel();
  registerRightPanelRender(render);
  rightPanel.addEventListener("focusin", _onFocusIn);
  rightPanel.addEventListener("focusout", _onFocusOut);
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

      if (!_hasFocus && !isColorPopoverOpen()) {
        render();
      }
    });
  });
}

export function unmount() {
  _scope?.stop();
  _scope = null;
  _ctx = null;
  rightPanel.removeEventListener("focusin", _onFocusIn);
  rightPanel.removeEventListener("focusout", _onFocusOut);
  _hasFocus = false;
  _propsContainer = null;
  _eventsContainer = null;
  _styleContainer = null;
  _assistantContainer = null;
  _lastTab = null;
}

let _rafId = 0;

export function render() {
  if (!_ctx) return;
  if (_rendering) return;
  if (!_scheduled) {
    _scheduled = true;
    _rafId = requestAnimationFrame(_flush);
  }
}

/** @type {HTMLElement | null} */
let _propsContainer = null;
/** @type {HTMLElement | null} */
let _eventsContainer = null;
/** @type {HTMLElement | null} */
let _styleContainer = null;
/** @type {HTMLElement | null} */
let _assistantContainer = null;
/** @type {string | null} */
let _lastTab = null;

function _ensureContainers() {
  if (_propsContainer) return;
  _propsContainer = document.createElement("div");
  _propsContainer.className = "panel-body";
  _eventsContainer = document.createElement("div");
  _eventsContainer.className = "panel-body";
  _styleContainer = document.createElement("div");
  _styleContainer.className = "panel-body";
  _assistantContainer = document.createElement("div");
  _assistantContainer.className = "panel-body";
  _assistantContainer.style.cssText = "display:flex;flex-direction:column;overflow:hidden";
}

function _flush() {
  _scheduled = false;
  _rafId = 0;
  if (!_ctx) return;
  if (_rendering) return;
  if (_hasFocus || isColorPopoverOpen()) return;
  _rendering = true;
  try {
    const ctx = /** @type {RightPanelCtx} */ (_ctx);
    const aTab = activeTab.value;
    if (!aTab) {
      rightPanel.textContent = "";
      return;
    }
    const S = /**
     * @type {{
     *   ui: Record<string, unknown>;
     *   document: JxMutableNode;
     *   mode: string;
     *   selection: (string | number)[] | null;
     * }}
     */ ({
      ui: aTab.session.ui,
      document: aTab.doc.document,
      mode: aTab.doc.mode,
      selection: aTab.session.selection,
    });
    const tab = /** @type {string} */ (S.ui.rightTab);

    // Render tabs header
    const panelTabs = [
      { value: "properties", icon: "sp-icon-properties", label: "Properties" },
      { value: "events", icon: "sp-icon-event", label: "Events" },
      { value: "style", icon: "sp-icon-brush", label: "Style" },
      { value: "assistant", icon: "sp-icon-chat", label: "Assistant" },
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
              render();
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

    _ensureContainers();
    const containers = /** @type {HTMLElement[]} */ ([
      _propsContainer,
      _eventsContainer,
      _styleContainer,
      _assistantContainer,
    ]);
    const tabKeys = ["properties", "events", "style", "assistant"];

    // Show/hide containers
    for (let i = 0; i < containers.length; i++) {
      if (tabKeys[i] === tab) {
        containers[i].style.display = tabKeys[i] === "assistant" ? "flex" : "";
      } else {
        containers[i].style.display = "none";
      }
    }

    // Render tabs into the right panel, append containers
    litRender(tabsT, rightPanel);
    for (const c of containers) {
      if (!c.parentNode) rightPanel.appendChild(c);
    }

    // Only render the active panel's content
    if (tab === "properties") {
      litRender(
        renderPropertiesPanelTemplate({ navigateToComponent: ctx.navigateToComponent }),
        /** @type {HTMLElement} */ (_propsContainer),
      );
    } else if (tab === "events") {
      litRender(
        eventsSidebarTemplate({ isCustomElementDoc: () => isCustomElementDoc(S) }),
        /** @type {HTMLElement} */ (_eventsContainer),
      );
    } else if (tab === "style") {
      try {
        litRender(
          renderStylePanelTemplate({ getCanvasMode: ctx.getCanvasMode }),
          /** @type {HTMLElement} */ (_styleContainer),
        );
      } catch (/** @type {unknown} */ e) {
        console.error("[renderStylePanelTemplate]", e);
      }
    } else if (tab === "assistant") {
      litRender(renderAiPanelTemplate(), /** @type {HTMLElement} */ (_assistantContainer));
    }

    _lastTab = tab;
  } catch (e) {
    console.error("right-panel render error:", e);
  } finally {
    _rendering = false;
  }
  requestAnimationFrame(() => mountQuikChat());
  _ctx.updateForcedPseudoPreview();
}
