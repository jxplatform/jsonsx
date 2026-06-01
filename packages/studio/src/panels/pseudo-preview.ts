/**
 * Pseudo-state preview — extracted from studio.js (Phase 4m). When a pseudo-selector (:hover,
 * :focus, etc.) is active in the style sidebar, force those styles onto the selected element.
 */

import { getNodeAtPath } from "../store";
import { activeTab } from "../workspace/workspace";
import { view } from "../view";
import { getActivePanel, findCanvasElement } from "../canvas/canvas-helpers";

const pseudoStyleHost = document.createElement("div");
pseudoStyleHost.style.display = "contents";
(document.querySelector("sp-theme") || document.body).appendChild(pseudoStyleHost);

export function updateForcedPseudoPreview() {
  if (view.forcedStyleTag) {
    view.forcedStyleTag.remove();
    view.forcedStyleTag = null;
  }
  if (view.forcedAttrEl) {
    view.forcedAttrEl.removeAttribute("data-studio-forced");
    view.forcedAttrEl = null;
  }

  const tab = activeTab.value;
  const sel = tab?.session.ui?.activeSelector;
  if (!sel || !sel.startsWith(":") || !tab?.session.selection) return;

  const panel = getActivePanel();
  if (!panel) return;
  const el = findCanvasElement(tab.session.selection, panel.canvas);
  if (!el) return;

  const node = getNodeAtPath(tab.doc.document, tab.session.selection);
  if (!node?.style) return;
  const activeMedia = tab.session.ui.activeMedia;
  const ctx: JxStyle = activeMedia ? node.style[`@${activeMedia}`] || {} : node.style;
  const rules = ctx[sel];
  if (!rules || typeof rules !== "object") return;

  const cssProps = Object.entries(rules)
    .filter(([k]) => typeof rules[k] === "string" || typeof rules[k] === "number")
    .map(
      ([k, v]) => `${k.replace(/[A-Z]/g, (c: string) => `-${c.toLowerCase()}`)}: ${v} !important`,
    )
    .join("; ");
  if (!cssProps) return;

  el.setAttribute("data-studio-forced", "1");
  view.forcedAttrEl = el;

  const tag = document.createElement("style");
  tag.textContent = `[data-studio-forced] { ${cssProps} }`;
  pseudoStyleHost.appendChild(tag);
  view.forcedStyleTag = tag;
}
