/** Statusbar — status message display for Jx Studio */

import { statusbarEl, getNodeAtPath, nodeLabel, updateSession, renderOnly } from "../store";
import { effect, effectScope } from "../reactivity";
import { activeTab } from "../workspace/workspace";

// ─── Module state ────────────────────────────────────────────────────────────

let statusMsg = "";
/** @type {ReturnType<typeof setTimeout> | undefined} */
let statusTimeout: ReturnType<typeof setTimeout> | undefined;
let _rerender: (() => void) | null = null;
let _scope: import("@vue/reactivity").EffectScope | null = null;

/**
 * Register the callback used to re-render the statusbar. Called once from studio.js during init.
 *
 * @param {() => void} fn
 */
export function setStatusbarRenderer(fn: () => void) {
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

  statusbarEl?.addEventListener("click", _onStatusbarClick);
}

export function unmountStatusbar() {
  _scope?.stop();
  _scope = null;
  statusbarEl?.removeEventListener("click", _onStatusbarClick);
}

// ─── Statusbar ───────────────────────────────────────────────────────────────

/** @param {string} text */
function esc(text: string) {
  return String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Render the statusbar content. */
export function renderStatusbar() {
  const tab = activeTab.value;
  const parts = [];
  if (tab?.doc.mode === "content") parts.push("Content Mode");
  if (tab?.session.selection?.length) {
    const sel = tab.session.selection as JxPath;
    const node = getNodeAtPath(tab.doc.document, sel);
    parts.push(`Selected: ${esc(nodeLabel(node))}`);

    const pathSegments = [];
    for (let i = 0; i < sel.length; i += 2) {
      const subPath = sel.slice(0, i + 2);
      const childNode = getNodeAtPath(tab.doc.document, subPath);
      const label = childNode?.tagName || childNode?.tag || `[${sel[i + 1]}]`;
      const dataPath = JSON.stringify(subPath);
      pathSegments.push(
        `<span class="sb-path-seg" data-path='${esc(dataPath)}'>${esc(label)}</span>`,
      );
    }
    parts.push(`Path: ${pathSegments.join(' <span class="sb-path-sep">&gt;</span> ')}`);
  } else if (tab?.session.ui.stylebookSelection) {
    const sel = tab.session.ui.stylebookSelection;
    parts.push(`Style: ${esc(sel.replace(/ /g, " > "))}`);
  }
  if (statusMsg) parts.push(esc(statusMsg));
  statusbarEl.innerHTML = parts.join("  |  ") || "Jx Studio";
}

/** @param {Event} e */
function _onStatusbarClick(e: Event) {
  const target = e.target as HTMLElement;
  if (!target.classList.contains("sb-path-seg")) return;
  const pathStr = target.dataset.path;
  if (!pathStr) return;
  try {
    const path = JSON.parse(pathStr);
    updateSession({ selection: path });
    renderOnly("leftPanel", "rightPanel", "canvas");
  } catch {
    // ignore
  }
}

/**
 * Show a temporary status message.
 *
 * @param {string} msg
 * @param {number} [duration]
 */
export function statusMessage(msg: string, duration: number = 3000) {
  statusMsg = msg;
  _rerender?.();
  clearTimeout(statusTimeout);
  statusTimeout = setTimeout(() => {
    statusMsg = "";
    _rerender?.();
  }, duration);
}
