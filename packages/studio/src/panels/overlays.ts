/// <reference lib="dom" />
/**
 * Overlays panel — renders hover/selection overlay boxes on canvas panels. Delegates block action
 * bar rendering to studio.js via ctx callback.
 */

import { render as litRender, nothing } from "lit-html";
import { canvasPanels } from "../store";
import { effect, effectScope } from "../reactivity";
import { activeTab } from "../workspace/workspace";
import type { EffectScope } from "@vue/reactivity";

interface OverlaysCtx {
  getCanvasMode: () => string;
  isEditing: () => boolean;
  renderBlockActionBar: () => void;
}

let _ctx: OverlaysCtx | null = null;

let _scope: EffectScope | null = null;

let _scheduled = false;

/**
 * Mount the overlays panel.
 *
 * @param {OverlaysCtx} ctx
 */
export function mount(ctx: OverlaysCtx) {
  _ctx = ctx;
  _scope = effectScope();
  _scope.run(() => {
    effect(() => {
      const tab = activeTab.value;
      if (!tab) {
        return;
      }
      // Track selection, hover, and mode
      void tab.session.selection;
      void tab.session.hover;
      void tab.doc.mode;
      render();
    });
  });
}

export function unmount() {
  _scope?.stop();
  _scope = null;
  _ctx = null;
}

export function render() {
  if (!_ctx) {
    return;
  }
  if (!_scheduled) {
    _scheduled = true;
    queueMicrotask(_flush);
  }
}

function _flush() {
  _scheduled = false;
  if (!_ctx) {
    return;
  }
  const tab = activeTab.value;
  if (!tab) {
    return;
  }

  // The iframe owns hit-testing and draws its own selection/hover overlays (from posted rects).
  // Clear any parent-side overlay layer and disable the legacy click-catcher so pointer events
  // Reach the iframe.
  for (const p of canvasPanels) {
    litRender(nothing, p.overlay);
    p.overlayClk.style.pointerEvents = "none";
  }

  _ctx.renderBlockActionBar();
}
