/// <reference lib="dom" />
/**
 * Panel-scheduler.ts — Shared focus-aware render scheduler for Studio panels.
 *
 * Generalizes the guard that previously lived only in the right panel: render requests are
 * coalesced via requestAnimationFrame and DEFERRED while a text input inside the panel root is
 * focused, then flushed on focusout. Routing every render path (reactive effect, renderOnly(...),
 * explicit calls) through one scheduler means a focused field is never rebuilt mid-edit — which is
 * what previously truncated or dropped characters in the document/head sidebar.
 */

/**
 * Is the element (or its shadow-DOM active descendant) a text-entry control whose value would be
 * clobbered by a re-render? Covers native inputs and the Spectrum web components used in panels.
 *
 * @param {Element | null} el
 * @returns {boolean}
 */
export function isTextInput(el: Element | null): boolean {
  if (!el) return false;
  const tag = el.tagName.toLowerCase();
  if (tag === "input" || tag === "textarea") return true;
  if (tag === "sp-textfield" || tag === "sp-number-field" || tag === "sp-search") return true;
  if (el.shadowRoot?.activeElement) return isTextInput(el.shadowRoot.activeElement);
  return false;
}

export interface PanelScheduler {
  /** Request a render. Coalesced; deferred while a text input in the panel is focused. */
  schedule(): void;
  /** True when a render would currently be deferred (text input focused or blockWhile()). */
  isEditing(): boolean;
  /** Attach focusin/focusout listeners to the panel root. */
  bindFocus(): void;
  /** Detach listeners and cancel any pending frame. */
  unbind(): void;
  /** Render immediately, bypassing the rAF coalescing (still respects the focus guard). */
  flushNow(): void;
}

/**
 * Create a focus-aware render scheduler bound to a panel root.
 *
 * @param {{
 *   root: HTMLElement;
 *   render: () => void;
 *   blockWhile?: () => boolean;
 * }} opts
 *   - `render` does the actual DOM paint; `blockWhile` is an extra defer predicate (e.g. a color
 *     popover being open).
 * @returns {PanelScheduler}
 */
export function createPanelScheduler(opts: {
  root: HTMLElement;
  render: () => void;
  blockWhile?: () => boolean;
}): PanelScheduler {
  const { root, render, blockWhile } = opts;
  let editing = false;
  let scheduled = false;
  let pending = false;
  let rendering = false;
  let rafId = 0;

  const blocked = () => editing || (blockWhile ? blockWhile() : false);

  function flush() {
    scheduled = false;
    rafId = 0;
    if (rendering) return;
    // Defer while a field is focused — flushed later by focusout (or the next schedule()).
    if (blocked()) {
      pending = true;
      return;
    }
    pending = false;
    rendering = true;
    try {
      render();
    } finally {
      rendering = false;
    }
  }

  function schedule() {
    if (scheduled) return;
    scheduled = true;
    rafId = requestAnimationFrame(flush);
  }

  function onFocusIn(e: FocusEvent) {
    editing = isTextInput(e.target as Element);
  }

  function onFocusOut() {
    // Clear the editing flag and schedule a flush. If focus is merely moving to another field in
    // the same panel, the synchronous focusin that follows re-sets `editing` before the rAF runs,
    // so the deferred render keeps waiting (no mid-edit clobber).
    editing = false;
    if (pending) schedule();
  }

  return {
    schedule,
    isEditing: () => blocked(),
    bindFocus() {
      root.addEventListener("focusin", onFocusIn);
      root.addEventListener("focusout", onFocusOut);
    },
    unbind() {
      root.removeEventListener("focusin", onFocusIn);
      root.removeEventListener("focusout", onFocusOut);
      if (rafId) cancelAnimationFrame(rafId);
      scheduled = false;
      pending = false;
      editing = false;
      rendering = false;
    },
    flushNow() {
      if (rafId) cancelAnimationFrame(rafId);
      rafId = 0;
      scheduled = false;
      flush();
    },
  };
}
