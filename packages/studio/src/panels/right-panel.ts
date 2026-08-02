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
import { openPageAction, renderEmptyState } from "./empty-state";
import { eventsSidebarTemplate } from "./events-panel";
import { isCustomElementDoc } from "./signals-panel";

import { inspectorTabRegion, REGION_ATTR } from "../ui/regions";
import { isColorPopoverOpen } from "../ui/color-selector";
import { renderStylePanelTemplate } from "./style-panel";
import { renderPropertiesPanelTemplate } from "./properties-panel";

import type { EffectScope } from "@vue/reactivity";

interface RightPanelCtx {
  navigateToComponent: (path: string) => void;
  getCanvasMode: () => string;
  renderCanvas: () => void;
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
      // No tab is a state the inspector renders (its no-document empty state), not one it skips.
      if (tab) {
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
      }
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
  _containers = null;
}

/**
 * Request a render. Coalesced and deferred while a text input in the panel is focused or a color
 * popover is open (so explicit callers can never clobber a field mid-edit).
 */
export function render() {
  _scheduler?.schedule();
}

/**
 * The Inspector's tabs, in order — one record per tab.
 *
 * The `value` is the single source of the tab: it is what `ui.rightTab` stores, what the tab strip
 * selects by, which container is shown, AND the region `inspector/tab:<value>` that addresses that
 * container. Three parallel arrays used to encode that (`panelTabs`, `containers`, `tabKeys`), and
 * a fourth thing — the region — would have been a fourth place to keep in step.
 */
const INSPECTOR_TABS = [
  { icon: "sp-icon-properties", label: "Properties", value: "properties" },
  { icon: "sp-icon-event", label: "Events", value: "events" },
  { icon: "sp-icon-brush", label: "Style", value: "style" },
] as const;

/** Tab value → its body container, built once and reused across renders. */
let _containers: Map<string, HTMLElement> | null = null;

function _ensureContainers(): Map<string, HTMLElement> {
  if (_containers) {
    return _containers;
  }
  _containers = new Map(
    INSPECTOR_TABS.map((t) => {
      const el = document.createElement("div");
      el.className = "panel-body";
      el.setAttribute(REGION_ATTR, inspectorTabRegion(t.value));
      return [t.value, el] as const;
    }),
  );
  return _containers;
}

/**
 * Paint the inspector's own no-document state. The three tab containers are dropped rather than
 * hidden so the next real render rebuilds them, and lit's part is cleared alongside the DOM so the
 * emptied root can be rendered into again.
 */
function _renderNoDocument() {
  _containers = null;
  rightPanel.textContent = "";
  // @ts-expect-error — clear Lit's internal state so the cleared root re-renders cleanly
  delete rightPanel["_$litPart$"];
  litRender(
    html`<div class="panel-body">
      ${renderEmptyState({
        actions: [openPageAction()],
        message: "Open a page to inspect and style what you click.",
      })}
    </div>`,
    rightPanel,
  );
}

function _doRender() {
  if (!_ctx) {
    return;
  }
  try {
    const ctx = _ctx as RightPanelCtx;
    const aTab = activeTab.value;
    if (!aTab) {
      _renderNoDocument();
      return;
    }
    const S = {
      document: aTab.doc.document,
      mode: aTab.doc.mode,
      selection: aTab.session.selection,
      ui: aTab.session.ui,
    };
    // Coerce stale values ("assistant" moved to the persistent chat sidebar; automation or a
    // Restored session may still carry it).
    const tab = INSPECTOR_TABS.some((t) => t.value === S.ui.rightTab)
      ? S.ui.rightTab
      : INSPECTOR_TABS[0].value;

    // Render tabs header
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
          ${INSPECTOR_TABS.map(
            (t) => html`
              <sp-tab value=${t.value} title=${t.label} aria-label=${t.label}>
                ${tabIcon(t.icon, "xs")}
              </sp-tab>
            `,
          )}
        </sp-tabs>
      </div>
    `;

    const containers = _ensureContainers();

    // Show/hide containers, and attach any that a fresh build has not mounted yet.
    litRender(tabsT, rightPanel);
    for (const [key, el] of containers) {
      el.style.display = key === tab ? "" : "none";
      if (!el.parentNode) {
        rightPanel.append(el);
      }
    }

    // Only render the active panel's content
    const body = containers.get(tab)!;
    if (tab === "properties") {
      litRender(
        renderPropertiesPanelTemplate({
          navigateToComponent: ctx.navigateToComponent,
        }),
        body,
      );
    } else if (tab === "events") {
      litRender(
        eventsSidebarTemplate({
          isCustomElementDoc: () => isCustomElementDoc(S),
        }),
        body,
      );
    } else if (tab === "style") {
      try {
        litRender(renderStylePanelTemplate({ getCanvasMode: ctx.getCanvasMode }), body);
      } catch (error) {
        console.error("[renderStylePanelTemplate]", error);
      }
    }
  } catch (error) {
    console.error("right-panel render error:", error);
  }
}
