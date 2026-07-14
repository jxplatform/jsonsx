/// <reference lib="dom" />
/**
 * Tab strip — renders open tabs above the canvas area.
 *
 * Uses the reactive workspace model: reads from workspace.tabOrder, workspace.tabs,
 * workspace.activeTabId. Clicks call activateTab/closeTab from workspace.js.
 */

import { html, render as litRender, nothing } from "lit-html";
import { classMap } from "lit-html/directives/class-map.js";
import { repeat } from "lit-html/directives/repeat.js";
import { effect, effectScope } from "../reactivity";
import { activateTab, closeTab, workspace } from "../workspace/workspace";
import { gridTabLabel } from "../grid/grid-source";
import type { Tab } from "../tabs/tab";
import { showConfirmDialog } from "../ui/layers";
import { collabState } from "../collab/collab-state";
import type { EffectScope } from "@vue/reactivity";

let _host: HTMLElement | null = null;

let _scope: EffectScope | null = null;

/**
 * Mount the tab strip into the given host element.
 *
 * @param {HTMLElement} host
 */
export function mount(host: HTMLElement) {
  _host = host;
  _scope = effectScope();
  _scope.run(() => {
    effect(() => {
      void workspace.tabOrder;
      void workspace.activeTabId;
      for (const tab of workspace.tabs.values()) {
        void tab.doc.dirty;
        void tab.documentPath;
      }
      render();
    });
  });
}

export function unmount() {
  _scope?.stop();
  _scope = null;
  _host = null;
}

function render() {
  if (!_host) {
    return;
  }

  if (workspace.tabOrder.length === 0) {
    litRender(nothing, _host);
    return;
  }

  litRender(
    html`
      <div class="tab-strip">
        ${repeat(
          workspace.tabOrder,
          (id) => id,
          (id) => {
            const tab = workspace.tabs.get(id);
            if (!tab) {
              return nothing;
            }
            const isActive = id === workspace.activeTabId;
            const isDirty = tab.doc.dirty;
            const label = tabLabel(tab);
            return html`
              <div
                class=${classMap({ active: isActive, "tab-strip-tab": true })}
                @click=${() => activateTab(id)}
                @auxclick=${(e: MouseEvent) => {
                  if (e.button === 1) {
                    e.preventDefault();
                    void requestClose(id);
                  }
                }}
                title=${tab.documentPath || gridTabLabel(tab.id) || "Untitled"}
              >
                <span class="tab-strip-label">${label}</span>
                ${isDirty ? html`<span class="tab-strip-dirty">●</span>` : nothing}
                <button
                  class="tab-strip-close"
                  @click=${(e: Event) => {
                    e.stopPropagation();
                    void requestClose(id);
                  }}
                >
                  ×
                </button>
              </div>
            `;
          },
        )}
      </div>
    `,
    _host,
  );
}

/**
 * Derive a short label from the tab's documentPath (virtual grid tabs label from their id).
 *
 * @param {Tab} tab
 * @returns {string}
 */
function tabLabel(tab: Tab) {
  const path = tab.documentPath;
  if (!path) {
    return gridTabLabel(tab.id) ?? "Untitled";
  }
  const parts = path.split("/");
  return parts.at(-1);
}

/**
 * True when closing this tab would lose unsaved work the user must be warned about: the tab is
 * dirty AND either it is not co-edited, or this client is the last active collaborator on the doc
 * (no other peer is focused on its path). When peers remain, the shared session lives on and the
 * edits are still on the server, so closing is safe.
 *
 * @param {Tab} tab
 */
export function shouldWarnOnClose(tab: Tab): boolean {
  if (!tab.doc.dirty) {
    return false;
  }
  const state = collabState(tab);
  if (!state.active) {
    return true;
  }
  const peersHere = state.peers.filter((p) => p.state?.focusedPath === tab.documentPath);
  return peersHere.length === 0;
}

/**
 * Close a tab, prompting if closing would lose unsaved work.
 *
 * @param {string} id
 */
async function requestClose(id: string) {
  const tab = workspace.tabs.get(id);
  if (!tab) {
    return;
  }
  if (shouldWarnOnClose(tab)) {
    const confirmed = await showConfirmDialog(
      "Unsaved Changes",
      `"${tabLabel(tab)}" has unsaved changes. Close without saving?`,
      { confirmLabel: "Close", destructive: true },
    );
    if (!confirmed) {
      return;
    }
  }
  closeTab(id);
}
