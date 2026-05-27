/**
 * Tab strip — renders open tabs above the canvas area.
 *
 * Uses the reactive workspace model: reads from workspace.tabOrder, workspace.tabs,
 * workspace.activeTabId. Clicks call activateTab/closeTab from workspace.js.
 */

import { html, render as litRender, nothing } from "lit-html";
import { classMap } from "lit-html/directives/class-map.js";
import { repeat } from "lit-html/directives/repeat.js";
import { effect, effectScope } from "../reactivity.js";
import { workspace, activateTab, closeTab } from "../workspace/workspace.js";

/** @typedef {import("../tabs/tab.js").Tab} Tab */

/** @type {HTMLElement | null} */
let _host = null;

/** @type {import("@vue/reactivity").EffectScope | null} */
let _scope = null;

/**
 * Mount the tab strip into the given host element.
 *
 * @param {HTMLElement} host
 */
export function mount(host) {
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
  if (!_host) return;

  if (workspace.tabOrder.length < 1) {
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
            if (!tab) return nothing;
            const isActive = id === workspace.activeTabId;
            const isDirty = tab.doc.dirty;
            const label = tabLabel(tab);
            return html`
              <div
                class=${classMap({ "tab-strip-tab": true, active: isActive })}
                @click=${() => activateTab(id)}
                @auxclick=${(/** @type {MouseEvent} */ e) => {
                  if (e.button === 1) {
                    e.preventDefault();
                    requestClose(id);
                  }
                }}
                title=${tab.documentPath || "Untitled"}
              >
                <span class="tab-strip-label">${label}</span>
                ${isDirty ? html`<span class="tab-strip-dirty">●</span>` : nothing}
                <button
                  class="tab-strip-close"
                  @click=${(/** @type {Event} */ e) => {
                    e.stopPropagation();
                    requestClose(id);
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
 * Derive a short label from the tab's documentPath.
 *
 * @param {Tab} tab
 * @returns {string}
 */
function tabLabel(tab) {
  if (tab.id === "welcome") return "Welcome";
  const path = tab.documentPath;
  if (!path) return "Untitled";
  const parts = path.split("/");
  return parts[parts.length - 1];
}

/**
 * Close a tab, prompting if dirty.
 *
 * @param {string} id
 */
function requestClose(id) {
  const tab = workspace.tabs.get(id);
  if (!tab) return;
  if (tab.doc.dirty) {
    const confirmed = window.confirm(
      `"${tabLabel(tab)}" has unsaved changes. Close without saving?`,
    );
    if (!confirmed) return;
  }
  closeTab(id);
}
