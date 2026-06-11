/// <reference lib="dom" />
/**
 * Pseudo-state preview — extracted from studio.js (Phase 4m). When a pseudo-selector (:hover,
 * :focus, etc.) is active in the style sidebar, force those styles onto the selected element.
 */

import { getNodeAtPath } from "../store";
import { getNestedStyle } from "@jxsuite/schema/guards";
import { activeTab } from "../workspace/workspace";
import { view } from "../view";
import { findCanvasElement, getActivePanel } from "../canvas/canvas-helpers";

import type { JxStyle } from "@jxsuite/schema/types";

const pseudoStyleHost = document.createElement("div");
pseudoStyleHost.style.display = "contents";
(document.querySelector("sp-theme") || document.body).append(pseudoStyleHost);

export function updateForcedPseudoPreview() {
  if (view.forcedStyleTag) {
    view.forcedStyleTag.remove();
    view.forcedStyleTag = null;
  }
  if (view.forcedAttrEl) {
    delete view.forcedAttrEl.dataset.studioForced;
    view.forcedAttrEl = null;
  }

  const tab = activeTab.value;
  const sel = tab?.session.ui?.activeSelector;
  if (!sel || !sel.startsWith(":") || !tab?.session.selection) {
    return;
  }

  const panel = getActivePanel();
  if (!panel) {
    return;
  }
  const el = findCanvasElement(tab.session.selection, panel.canvas);
  if (!el) {
    return;
  }

  const node = getNodeAtPath(tab.doc.document, tab.session.selection);
  if (!node?.style) {
    return;
  }
  const { activeMedia } = tab.session.ui;
  const ctx: JxStyle = activeMedia
    ? (getNestedStyle(node.style, `@${activeMedia}`) ?? {})
    : node.style;
  const rules = getNestedStyle(ctx, sel);
  if (!rules) {
    return;
  }

  const cssProps = Object.entries(rules)
    .filter(([k]) => typeof rules[k] === "string" || typeof rules[k] === "number")
    .map(
      ([k, v]) =>
        `${k.replaceAll(/[A-Z]/g, (c: string) => `-${c.toLowerCase()}`)}: ${v} !important`,
    )
    .join("; ");
  if (!cssProps) {
    return;
  }

  el.dataset.studioForced = "1";
  view.forcedAttrEl = el;

  const tag = document.createElement("style");
  tag.textContent = `[data-studio-forced] { ${cssProps} }`;
  pseudoStyleHost.append(tag);
  view.forcedStyleTag = tag;
}
