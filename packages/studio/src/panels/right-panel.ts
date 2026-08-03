/// <reference lib="dom" />
/**
 * Right panel — the Inspector dock: four tabs, one dock, one column.
 *
 * **Content · Style · Logic · Assistant**, text-labelled. Three of those are renames of what was
 * here (Properties→Content, Events→Logic) and the fourth is the assistant, folded in from the fifth
 * grid column it used to own — which is the point of plan §3.2 ⑨: an inspector tab costs zero
 * additional width, so the canvas gets the ~300px back and the assistant is still one key away.
 *
 * Two things changed shape to make that work:
 *
 * - **The tabs are words, not icons.** Three icon-only tabs with `title` attributes meant three hover
 *   probes to learn a dock you look at all day, and the icons were `sp-icon-properties` /
 *   `sp-icon-event` / `sp-icon-brush` — a form, a lightning bolt and a paintbrush, none of which
 *   says "this is where the link target lives".
 * - **The containers are permanent.** The no-document state used to drop and rebuild them; it now
 *   renders INTO the three document tabs, because the Assistant's DOM (composer draft, scroll
 *   position, streaming part cache) must survive a document closing — the assistant works with no
 *   project at all, which is exactly the New Project hand-off's requirement.
 *
 * Every tab renders under a header naming its target (§3.2 ⑨), the same treatment wave A gave the
 * Navigator panels. The Target Line proper — provenance-coded, cascade-aware — is §6 and P5; this
 * is its honest predecessor: the tab's name, and what it is pointed at.
 *
 * The heavy sub-templates (properties, style) remain in their own modules and are passed the ctx
 * they need.
 */

import { html, render as litRender } from "lit-html";
import { getNodeAtPath, nodeLabel, rightPanel } from "../store";
import { effect, effectScope, reactive } from "../reactivity";
import { createPanelScheduler } from "./panel-scheduler";
import type { PanelScheduler } from "./panel-scheduler";
import { activeTab } from "../workspace/workspace";
import { openPageAction, renderEmptyState } from "./empty-state";
import { eventsSidebarTemplate } from "./events-panel";
import { isCustomElementDoc } from "./signals-panel";

import { DEFAULT_INSPECTOR_TAB, isInspectorTabId } from "../shell";
import { INSPECTOR_TABS } from "../commands/defaults";
import { inspectorTabRegion, REGION_ATTR } from "../ui/regions";
import { isColorPopoverOpen } from "../ui/color-selector";
import { renderStylePanelTemplate } from "./style-panel";
import { renderPropertiesPanelTemplate } from "./properties-panel";

import type { InspectorTabId } from "../shell";
import type { TemplateResult } from "lit-html";
import type { EffectScope } from "@vue/reactivity";

interface RightPanelCtx {
  navigateToComponent: (path: string) => void;
  getCanvasMode: () => string;
  renderCanvas: () => void;
  /**
   * Hand the Assistant tab's body to whoever owns the assistant, once.
   *
   * Injected rather than imported so the dependency runs one way: `chat-panel.ts` reaches back into
   * this module to SELECT its tab, and a matching import here would be a cycle between the host and
   * its tenant. `studio.ts` already composes both, so it is the natural place to join them.
   */
  mountAssistant: (host: HTMLElement) => void;
}

let _ctx: RightPanelCtx | null = null;

let _scope: EffectScope | null = null;

let _scheduler: PanelScheduler | null = null;

/**
 * The selected tab while NO document is open.
 *
 * `session.ui.rightTab` is per-document — the tab you were on comes back with the file — and with
 * no file there is nowhere per-document to put it. The Assistant is usable in exactly that state
 * (the New Project flow hands it a brief before any document exists), so the selection falls back
 * here rather than being refused.
 *
 * Reactive, because it is read by surfaces outside this module: the Command Bar's assistant toggle
 * reports whether the assistant is showing, and a plain field would leave that button lying on the
 * welcome screen — which is the whole class of bug `shell.ts` was split out to end.
 */
const _detached = reactive({ tab: DEFAULT_INSPECTOR_TAB as InspectorTabId });

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
  _detached.tab = DEFAULT_INSPECTOR_TAB;
}

/**
 * Request a render. Coalesced and deferred while a text input in the panel is focused or a color
 * popover is open (so explicit callers can never clobber a field mid-edit).
 */
export function render() {
  _scheduler?.schedule();
}

/**
 * The tab showing right now — the stored value, coerced to a declared one.
 *
 * Coercion rather than trust because the value is persisted session state: a build that spelled a
 * tab differently, or an automation step that guessed, must land on Content rather than on a blank
 * dock with no tab selected.
 */
export function inspectorTab(): InspectorTabId {
  const tab = activeTab.value;
  if (!tab) {
    return _detached.tab;
  }
  const stored: unknown = tab.session.ui.rightTab;
  return isInspectorTabId(stored) ? stored : DEFAULT_INSPECTOR_TAB;
}

/**
 * Select a tab. The ONE writer — the strip, `view.setRightTab`, `view.setAssistant` and the
 * assistant's own pending-prompt hand-off all come through here.
 */
export function setInspectorTab(tab: InspectorTabId): void {
  const aTab = activeTab.value;
  if (aTab) {
    aTab.session.ui.rightTab = tab;
  } else {
    _detached.tab = tab;
  }
  render();
}

/** Tab value → its body container, built once and reused across renders. */
let _containers: Map<InspectorTabId, HTMLElement> | null = null;

function _ensureContainers(ctx: RightPanelCtx): Map<InspectorTabId, HTMLElement> {
  if (_containers) {
    return _containers;
  }
  _containers = new Map(
    INSPECTOR_TABS.map((t) => {
      const el = document.createElement("div");
      el.className = "panel-body";
      el.setAttribute(REGION_ATTR, inspectorTabRegion(t.id));
      return [t.id as InspectorTabId, el] as const;
    }),
  );
  // The assistant owns its container for the life of the window: it is bound as lit's render host
  // For a streaming rAF loop, and rebuilding it would drop the transcript and the composer draft.
  ctx.mountAssistant(_containers.get("assistant")!);
  return _containers;
}

/**
 * What the selected tab is pointed AT, in the fewest words that are true.
 *
 * A tag name when a node is selected, the document's own name when nothing is, and "no document"
 * when there is nothing open. The dock spent its whole life unable to answer this — three icon tabs
 * and no statement of target anywhere — which is how "why is this field disabled" became a question
 * with no on-screen answer.
 */
function inspectorTarget(): string {
  const tab = activeTab.value;
  if (!tab) {
    return "no document";
  }
  const { selection } = tab.session;
  if (selection) {
    return nodeLabel(getNodeAtPath(tab.doc.document, selection));
  }
  const path = tab.documentPath;
  return path ? (path.split("/").at(-1) ?? "document") : "document";
}

/** The dock's header: which tab you are in, and what it is pointed at. */
function headerTpl(tab: InspectorTabId): TemplateResult {
  const title = INSPECTOR_TABS.find((t) => t.id === tab)?.title ?? tab;
  return html`
    <header class="panel-header">
      <span class="panel-header-title">${title}</span>
      <span class="panel-header-level">${inspectorTarget()}</span>
    </header>
  `;
}

/** The four-tab strip. Text labels: a dock you read all day should not need to be hovered. */
function tabsTpl(tab: InspectorTabId): TemplateResult {
  return html`
    <div class="panel-tabs inspector-tabs">
      <sp-tabs
        selected=${tab}
        quiet
        size="s"
        @change=${(e: Event & { target: { selected: string } }) => {
          const sel = e.target.selected;
          if (sel && sel !== tab && isInspectorTabId(sel)) {
            setInspectorTab(sel);
          }
        }}
      >
        ${INSPECTOR_TABS.map((t) => html`<sp-tab value=${t.id} label=${t.title}></sp-tab>`)}
      </sp-tabs>
    </div>
  `;
}

/** The inspector's no-document state, rendered into a document tab's own body. */
function noDocumentTpl(): TemplateResult {
  return renderEmptyState({
    actions: [openPageAction()],
    message: "Open a page to inspect and style what you click.",
  });
}

function _doRender() {
  if (!_ctx) {
    return;
  }
  try {
    const ctx = _ctx as RightPanelCtx;
    const aTab = activeTab.value;
    const tab = inspectorTab();

    litRender(html`${headerTpl(tab)}${tabsTpl(tab)}`, rightPanel);

    const containers = _ensureContainers(ctx);
    // Show/hide containers, and attach any that a fresh build has not mounted yet.
    for (const [key, el] of containers) {
      el.style.display = key === tab ? "" : "none";
      if (!el.parentNode) {
        rightPanel.append(el);
      }
    }

    const body = containers.get(tab)!;
    // The assistant paints itself through its own rAF loop into this very container (streaming has
    // To repaint while the composer is focused), so the host must not render over it.
    if (tab === "assistant") {
      return;
    }
    if (!aTab) {
      litRender(noDocumentTpl(), body);
      return;
    }
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
          isCustomElementDoc: () =>
            isCustomElementDoc({
              document: aTab.doc.document,
              mode: aTab.doc.mode,
              selection: aTab.session.selection,
              ui: aTab.session.ui,
            }),
        }),
        body,
      );
    } else {
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
