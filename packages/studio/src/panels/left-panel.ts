/// <reference lib="dom" />
/**
 * Left panel — the Navigator dock's host.
 *
 * It no longer knows what a panel is. The eight-branch `if (tab === …)` chain, the eight-key
 * no-document copy table and the two post-render special cases are gone: this file resolves ONE
 * record from the panel registry, draws its header, calls its `render`, and calls its
 * `afterRender`. Everything a panel is — its name, its level, its empty state, its drag
 * registrations — is declared beside the state it writes (plan §2 principle 1).
 *
 * What stays here is what genuinely belongs to the host: the DOM root, the focus-aware scheduler,
 * the error boundary with its Lit-marker recovery, and the region stamp.
 */

import { html, render as litRender } from "lit-html";
import type { TemplateResult } from "lit-html";
import { leftPanel } from "../store";
import { effect, effectScope } from "../reactivity";
import { createPanelScheduler } from "./panel-scheduler";
import type { PanelScheduler } from "./panel-scheduler";
import { activeTab } from "../workspace/workspace";
import { shell } from "../shell";

import { navigatorPanelRegion } from "../ui/regions";
import { openPageAction, renderEmptyState } from "./empty-state";
import { getPanel, isPanelVisible, panelContext } from "./panel-registry";
import { registerNavigatorPanels } from "./navigator-panels";
import type {
  NavigatorDocument,
  NavigatorPanelContext,
  NavigatorPanelDeps,
  PanelRecord,
} from "./panel-registry";
import type { EffectScope } from "@vue/reactivity";

let _deps: NavigatorPanelDeps | null = null;

let _scope: EffectScope | null = null;

let _scheduler: PanelScheduler | null = null;

/**
 * Mount the Navigator dock.
 *
 * @param {NavigatorPanelDeps} deps
 */
export function mount(deps: NavigatorPanelDeps) {
  _deps = deps;
  registerNavigatorPanels();
  _scheduler = createPanelScheduler({ render: _doRender, root: leftPanel });
  _scheduler.bindFocus();
  _scope = effectScope();
  _scope.run(() => {
    effect(() => {
      // Shell state is tracked with no tab open — which panel is showing, and the project-level
      // State the project-level panels draw from. A document-less rail tab still repaints.
      void shell.leftTab;
      void shell.settingsTab;
      void shell.git.status;
      void shell.git.loading;
      void shell.git.error;
      void shell.git.subTab;
      void shell.git.logEntries;
      const tab = activeTab.value;
      if (tab) {
        // Track properties the Navigator's panels read
        void tab.doc.document;
        void tab.doc.mode;
        // The whole SET, joined — a bare property read would not re-trigger when the selection
        // Changes WITHIN the array, and §6.5's helpers always replace it but nothing enforces that.
        void tab.session.selection.map((path) => path.join("/")).join("|");
      }
      render();
    });
  });
}

export function unmount() {
  _scope?.stop();
  _scope = null;
  _deps = null;
  _scheduler?.unbind();
  _scheduler = null;
}

/**
 * Request a render. Coalesced and deferred while a text input in the panel is focused (so explicit
 * callers — renderOnly("leftPanel"), tab switches, etc. — can never clobber a field mid-edit).
 */
export function render() {
  _scheduler?.schedule();
}

/** Actual DOM paint, invoked by the scheduler. Includes a Lit-marker-corruption recovery retry. */
function _doRender() {
  if (!_deps) {
    return;
  }
  try {
    _render();
  } catch (error) {
    console.error("left-panel render error:", error);
    try {
      leftPanel.textContent = "";
      // @ts-expect-error — clear Lit's internal state to recover from marker corruption
      delete leftPanel["_$litPart$"];
      _render();
    } catch (retryError) {
      console.error("left-panel retry failed:", retryError);
    }
  }
}

/**
 * The panel header — the fix for "which panel am I in?".
 *
 * Six of eight panels had no header at all, and the Imports panel silently changed meaning based on
 * whether the focused document was `project.json`. Every panel now renders under its title AND its
 * level ("FILES · project"), so the containment model is legible from the screen rather than only
 * from the matrix: a badge on a `project` panel does not go away when the last tab closes, and a
 * `document` panel says out loud that it is about the file in front of you.
 */
function panelHeader(panel: PanelRecord): TemplateResult {
  return html`
    <header class="panel-header">
      <span class="panel-header-title">${panel.title}</span>
      <span class="panel-header-level">${panel.level}</span>
    </header>
  `;
}

/**
 * The Navigator's one panel host.
 *
 * Every panel renders through this, which is what makes `navigator/panel:<id>` **derived**: the
 * region is stamped once, from the same id the rail routes by, so every panel is addressable
 * without anyone authoring an id — and renaming a panel renames its region in the same edit,
 * instead of leaving a stale selector that photographs the wrong box.
 */
function panelBody(panel: PanelRecord, content: unknown): TemplateResult {
  return html`<div class="panel-body" data-jx-region=${navigatorPanelRegion(panel.id)}>
    ${panelHeader(panel)}
    <div class="panel-content">${content}</div>
  </div>`;
}

/** The whole Navigator when `shell.leftTab` names nothing the registry declares. */
function unknownPanel(id: string): void {
  litRender(
    html`<div class="panel-body">
      ${renderEmptyState({ message: `No Navigator panel is registered as "${id}".` })}
    </div>`,
    leftPanel,
  );
}

function _render() {
  const deps = _deps as NavigatorPanelDeps;
  const panel = getPanel(shell.leftTab);
  if (!panel || !isPanelVisible(panel, panelContext())) {
    unknownPanel(shell.leftTab);
    return;
  }

  const aTab = activeTab.value;
  const doc: NavigatorDocument | null = aTab
    ? {
        canvas: aTab.session.canvas as Record<string, unknown> | null,
        content: aTab.doc.content,
        document: aTab.doc.document,
        documentPath: aTab.documentPath,
        mode: aTab.doc.mode,
        selection: aTab.session.selection,
        ui: aTab.session.ui,
      }
    : null;

  const ctx: NavigatorPanelContext = { deps, doc, rerender: render };

  // A panel that declares what it needs renders the sentence instead of an empty box.
  const content =
    doc === null && panel.requiresDocument
      ? renderEmptyState({ actions: [openPageAction()], message: panel.requiresDocument })
      : panel.render(ctx);

  litRender(panelBody(panel, content), leftPanel);

  const host = leftPanel.querySelector(".panel-body") as HTMLElement | null;
  if (host && (doc !== null || !panel.requiresDocument)) {
    panel.afterRender?.(ctx, host);
  }
}
