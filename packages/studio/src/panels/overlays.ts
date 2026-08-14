/// <reference lib="dom" />
/**
 * Overlays panel — the iframe canvas owns hit-testing and draws its own hover/selection boxes (from
 * posted rects, inside each host's overlay layer), so this panel only keeps panel-header
 * highlighting in sync and delegates the block-action-bar render on tracked session changes.
 */

import { effect, effectScope } from "../reactivity";
import { activeTab } from "../workspace/workspace";
import { updateActivePanelHeaders } from "../canvas/canvas-utils";
import type { EffectScope } from "@vue/reactivity";

interface OverlaysCtx {
  // No `getCanvasMode`. It was declared here and supplied by the bootstrap for as long as this
  // Interface has existed, and this module never called it — a focus reader wired into a surface
  // With no use for it, which is one more edge for the pane rule to walk and one more thing a
  // Reader has to rule out.
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
      // Track selection, hover, mode, and the active panel (a hit in another breakpoint panel — or
      // A header click — re-anchors the block action bar even when the selection path is unchanged).
      // The whole SET, joined — a bare property read would not re-trigger when the selection
      // Changes WITHIN the array, and §6.5's helpers always replace it but nothing enforces that.
      void tab.session.selection.map((path) => path.join("/")).join("|");
      void tab.session.hover;
      void tab.doc.mode;
      void tab.session.ui.activeMedia;
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

  // Header highlighting follows hit-driven activation immediately (it otherwise only refreshes on
  // Full canvas renders).
  updateActivePanelHeaders();

  _ctx.renderBlockActionBar();
}
