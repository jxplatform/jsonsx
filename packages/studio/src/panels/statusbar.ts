/// <reference lib="dom" />
/** Statusbar — status message display for Jx Studio */

import { getNodeAtPath, nodeLabel, renderOnly, statusbarEl, updateSession } from "../store";
import { shell } from "../shell";
import { effect, effectScope } from "../reactivity";
import { STATUS_MESSAGE } from "../ui/timing";
import { activeTab } from "../workspace/workspace";
import type { JxPath } from "../state";
import type { EffectScope } from "@vue/reactivity";

// ─── Module state ────────────────────────────────────────────────────────────

let statusMsg = "";
/** @type {ReturnType<typeof setTimeout> | undefined} */
let statusTimeout: ReturnType<typeof setTimeout> | undefined;
let _rerender: (() => void) | null = null;
let _scope: EffectScope | null = null;

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
      void shell.stylebook.selection;
      const tab = activeTab.value;
      if (!tab) {
        return;
      }
      // Track relevant reactive properties
      void tab.doc.document;
      void tab.doc.mode;
      void tab.session.selection;
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
  return String(text).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/** Render the statusbar content. */
export function renderStatusbar() {
  const tab = activeTab.value;
  const parts = [];
  if (tab?.doc.mode === "content") {
    parts.push("Content Mode");
  }
  // The bar's SELECTION field, kept apart from the rest of the line.
  //
  // `statusbar/selection` is one of the three placements the level x placement matrix already
  // Declares for this bar, and it is the only one this bar renders today. Emitting it as its own
  // Element makes the placement addressable — for a focus move, for the F6 walk, for a crop —
  // Without inventing the project and document fields the bar does not have yet.
  const selectionParts: string[] = [];
  if (tab?.session.selection?.length) {
    const sel = tab.session.selection as JxPath;
    const node = getNodeAtPath(tab.doc.document, sel);
    selectionParts.push(`Selected: ${esc(nodeLabel(node))}`);

    // Walk the path one structural step at a time. Most steps are `["children", index]` or
    // `["cases", name]` pairs, but a repeater template is reached by a lone `"map"` segment — so the
    // Step width varies. Emitting a crumb per node keeps the array pseudo-element ("Repeater") and
    // Its template both visible instead of collapsing the array into a bare `[index]`.
    const pathSegments = [];
    for (let i = 0; i < sel.length;) {
      const seg = sel[i];
      const step = seg === "map" ? 1 : 2;
      const subPath = sel.slice(0, i + step);
      const childNode = getNodeAtPath(tab.doc.document, subPath);
      const fallbackTag = childNode?.tag;
      const label =
        childNode?.$prototype === "Array"
          ? "Repeater"
          : childNode?.tagName ||
            (typeof fallbackTag === "string" ? fallbackTag : "") ||
            (seg === "cases" ? String(sel[i + 1]) : `[${sel[i + 1]}]`);
      const dataPath = JSON.stringify(subPath);
      pathSegments.push(
        `<span class="sb-path-seg" data-path='${esc(dataPath)}'>${esc(label)}</span>`,
      );
      i += step;
    }
    selectionParts.push(`Path: ${pathSegments.join(' <span class="sb-path-sep">&gt;</span> ')}`);
  } else if (shell.stylebook.selection) {
    const sel = shell.stylebook.selection;
    selectionParts.push(`Style: ${esc(sel.replaceAll(" ", " > "))}`);
  }
  if (selectionParts.length > 0) {
    parts.push(`<span data-jx-region="statusbar/selection">${selectionParts.join("  |  ")}</span>`);
  }
  if (statusMsg) {
    parts.push(esc(statusMsg));
  }
  statusbarEl.innerHTML = parts.join("  |  ") || "Jx Studio";
}

/** @param {Event} e */
function _onStatusbarClick(e: Event) {
  const target = e.target as HTMLElement;
  if (!target.classList.contains("sb-path-seg")) {
    return;
  }
  const pathStr = target.dataset.path;
  if (!pathStr) {
    return;
  }
  try {
    const path = JSON.parse(pathStr) as JxPath;
    updateSession({ selection: path });
    renderOnly("leftPanel", "rightPanel", "canvas");
  } catch {
    // Ignore
  }
}

/**
 * Show a temporary status message.
 *
 * @param {string} msg
 * @param {number} [duration]
 */
export function statusMessage(msg: string, duration = STATUS_MESSAGE) {
  statusMsg = msg;
  _rerender?.();
  clearTimeout(statusTimeout);
  statusTimeout = setTimeout(() => {
    statusMsg = "";
    _rerender?.();
  }, duration);
}
