/// <reference lib="dom" />
/**
 * Right panel — orchestrates Properties / Events / Style tabs. The heavy sub-templates
 * (propertiesSidebarTemplate, renderStylePanelTemplate) remain in studio.js and are passed via ctx
 * to avoid moving ~2000 lines in one step.
 */

import { html, render as litRender } from "lit-html";
import { rightPanel, updateUi } from "../store";
import { effect, effectScope } from "../reactivity";
import { createPanelScheduler } from "./panel-scheduler";
import type { PanelScheduler } from "./panel-scheduler";
import { activeTab } from "../workspace/workspace";
import { tabIcon } from "./activity-bar";
import { eventsSidebarTemplate } from "./events-panel";
import { isCustomElementDoc } from "./signals-panel";

import { isColorPopoverOpen } from "../ui/color-selector";
import { renderStylePanelTemplate } from "./style-panel";
import { renderPropertiesPanelTemplate } from "./properties-panel";

import type { EffectScope } from "@vue/reactivity";
import {
  renderAiPanelTemplate,
  mountAiPanel,
  mountQuikChat,
  registerRightPanelRender,
} from "./ai-panel";

interface RightPanelCtx {
  navigateToComponent: (path: string) => void;
  getCanvasMode: () => string;
  renderCanvas: () => void;
  updateForcedPseudoPreview: () => void;
}

let _ctx: RightPanelCtx | null = null;

let _scope: EffectScope | null = null;

let _scheduler: PanelScheduler | null = null;

/**
 * Mount the right panel.
 *
 * @param {RightPanelCtx} ctx
 */
export function mount(ctx: RightPanelCtx) {
  _ctx = ctx;
  mountAiPanel();
  registerRightPanelRender(render);
  _scheduler = createPanelScheduler({
    blockWhile: isColorPopoverOpen,
    render: _doRender,
    root: rightPanel,
  });
  _scheduler.bindFocus();
  _scope = effectScope();
  _scope.run(() => {
    effect(() => {
      const tab = activeTab.value;
      if (!tab) {
        return;
      }
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

      render();
    });
  });
}

export function unmount() {
  _scope?.stop();
  _scope = null;
  _ctx = null;
  _scheduler?.unbind();
  _scheduler = null;
  _propsContainer = null;
  _eventsContainer = null;
  _styleContainer = null;
  _assistantContainer = null;
  _lastTab = null;
}

/**
 * Request a render. Coalesced and deferred while a text input in the panel is focused or a color
 * popover is open (so explicit callers can never clobber a field mid-edit).
 */
export function render() {
  _scheduler?.schedule();
}

let _propsContainer: HTMLElement | null = null;
let _eventsContainer: HTMLElement | null = null;
let _styleContainer: HTMLElement | null = null;
let _assistantContainer: HTMLElement | null = null;
let _lastTab: string | null = null;

function _ensureContainers() {
  if (_propsContainer) {
    return;
  }
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

function _doRender() {
  if (!_ctx) {
    return;
  }
  try {
    const ctx = _ctx as RightPanelCtx;
    const aTab = activeTab.value;
    if (!aTab) {
      rightPanel.textContent = "";
      return;
    }
    const S = {
      document: aTab.doc.document,
      mode: aTab.doc.mode,
      selection: aTab.session.selection,
      ui: aTab.session.ui,
    };
    const tab = S.ui.rightTab;

    // Render tabs header
    const panelTabs = [
      { icon: "sp-icon-properties", label: "Properties", value: "properties" },
      { icon: "sp-icon-event", label: "Events", value: "events" },
      { icon: "sp-icon-brush", label: "Style", value: "style" },
      { icon: "sp-icon-chat", label: "Assistant", value: "assistant" },
    ];
    const tabsT = html`
      <div class="panel-tabs">
        <sp-tabs
          selected=${tab}
          quiet
          @change=${(e: Event & { target: { selected: string } }) => {
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
    const containers = [
      _propsContainer,
      _eventsContainer,
      _styleContainer,
      _assistantContainer,
    ] as HTMLElement[];
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
      if (!c.parentNode) {
        rightPanel.append(c);
      }
    }

    // Only render the active panel's content
    if (tab === "properties") {
      litRender(
        renderPropertiesPanelTemplate({
          navigateToComponent: ctx.navigateToComponent,
        }),
        _propsContainer!,
      );
    } else if (tab === "events") {
      litRender(
        eventsSidebarTemplate({
          isCustomElementDoc: () => isCustomElementDoc(S),
        }),
        _eventsContainer!,
      );
    } else if (tab === "style") {
      try {
        litRender(renderStylePanelTemplate({ getCanvasMode: ctx.getCanvasMode }), _styleContainer!);
      } catch (error) {
        console.error("[renderStylePanelTemplate]", error);
      }
    } else if (tab === "assistant") {
      litRender(renderAiPanelTemplate(), _assistantContainer!);
    }

    _lastTab = tab;
  } catch (error) {
    console.error("right-panel render error:", error);
  }
  requestAnimationFrame(() => mountQuikChat());
  _ctx.updateForcedPseudoPreview();
}
