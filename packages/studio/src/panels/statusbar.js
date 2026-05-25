/** Statusbar — status message display for Jx Studio */

import { statusbarEl, getNodeAtPath, nodeLabel } from "../store.js";
import { effect, effectScope } from "../reactivity.js";
import { activeTab } from "../workspace/workspace.js";

// ─── Module state ────────────────────────────────────────────────────────────

let statusMsg = "";
/** @type {any} */
let statusTimeout;
/** @type {(() => void) | null} */
let _rerender = null;
/** @type {import("@vue/reactivity").EffectScope | null} */
let _scope = null;

/**
 * Register the callback used to re-render the statusbar. Called once from studio.js during init.
 *
 * @param {() => void} fn
 */
export function setStatusbarRenderer(fn) {
  _rerender = fn;
}

/** Subscribe the statusbar to state changes via reactive effect. */
export function mountStatusbar() {
  _scope = effectScope();
  _scope.run(() => {
    effect(() => {
      const tab = activeTab.value;
      if (!tab) return;
      // Track relevant reactive properties
      void tab.doc.document;
      void tab.doc.mode;
      void tab.session.selection;
      void tab.session.ui.stylebookSelection;
      renderStatusbar();
    });
  });
}

export function unmountStatusbar() {
  _scope?.stop();
  _scope = null;
}

// ─── Statusbar ───────────────────────────────────────────────────────────────

/** Render the statusbar text. */
export function renderStatusbar() {
  const tab = activeTab.value;
  const parts = [];
  if (tab?.doc.mode === "content") parts.push("Content Mode");
  if (tab?.session.selection?.length) {
    const node = getNodeAtPath(tab.doc.document, tab.session.selection);
    parts.push(`Selected: ${nodeLabel(node)}`);
    parts.push(`Path: ${tab.session.selection.join(" > ") || "root"}`);
  } else if (tab?.session.ui.stylebookSelection) {
    const sel = tab.session.ui.stylebookSelection;
    parts.push(`Style: ${sel.replace(/ /g, " > ")}`);
  }
  if (statusMsg) parts.push(statusMsg);
  statusbarEl.textContent = parts.join("  |  ") || "Jx Studio";
}

/**
 * Show a temporary status message.
 *
 * @param {any} msg
 * @param {number} [duration]
 */
export function statusMessage(msg, duration = 3000) {
  statusMsg = msg;
  _rerender?.();
  clearTimeout(statusTimeout);
  statusTimeout = setTimeout(() => {
    statusMsg = "";
    _rerender?.();
  }, duration);
}
