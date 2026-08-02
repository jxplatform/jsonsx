/// <reference lib="dom" />
/**
 * The one empty-state pattern.
 *
 * Every region in the shell that can be empty renders through {@link renderEmptyState} instead of
 * hand-writing its own block, so the copy rules below are inherited rather than re-decided:
 *
 * 1. **One sentence saying what the region is _for_.** Not what is absent — "No state defined" is a
 *    dead end, "Data this page can read, compute or fetch lives here" tells you what it is.
 * 2. **The action that fills it**, as a real button that does the thing. Compact states that sit
 *    directly above their own add form are the one exception: the form _is_ the action.
 * 3. **One shared verb across equivalent surfaces.** Everything that wants a canvas selection says
 *    {@link clickAnythingTo}; everything that wants an open document offers
 *    {@link openPageAction}.
 *
 * A region with no object to show renders one of these in its own words — it never paints a bare
 * container.
 */

import { html, nothing } from "lit-html";
import { classMap } from "lit-html/directives/class-map.js";
import type { TemplateResult } from "lit-html";

/** A button offered by an empty state. */
export interface EmptyStateAction {
  /** Imperative naming what happens — "Add a value", not "Go to the Data panel". */
  label: string;
  /** Optional Spectrum icon. Must carry `slot="icon"`. */
  icon?: TemplateResult;
  run: () => void;
  disabled?: boolean;
}

export interface EmptyStateSpec {
  /** One sentence: what this region is for. */
  message: string;
  /** Optional second sentence: where its content comes from. */
  detail?: string;
  /** The action(s) that fill the region. */
  actions?: EmptyStateAction[];
  /** An inline section inside an otherwise populated panel — tighter and left-aligned. */
  compact?: boolean;
}

/** The one verb every selection-driven surface shares. */
export const CANVAS_VERB = "Click anything on the canvas";

/**
 * The shared selection prompt. `outcome` completes "…to ⟨outcome⟩": "edit its content", "style it",
 * "wire it up". Every inspector surface phrases its requirement this way so the rail does not read
 * as three different requirements.
 */
export function clickAnythingTo(outcome: string): string {
  return `${CANVAS_VERB} to ${outcome}.`;
}

/** Told the user something is gone: name it, then hand back the shared verb. */
export function staleSelectionMessage(): string {
  return `That element is no longer on the page. ${clickAnythingTo("pick another one")}`;
}

/**
 * The one action every "needs an open document" empty state offers.
 *
 * Quick Access is reached through a lazy import on purpose: this module is imported by every panel
 * in the shell, and a static edge would drag the file browser, the format host and the recents
 * store into all of them. P2 replaces the closure with a command id.
 */
export function openPageAction(label = "Open a page…"): EmptyStateAction {
  return {
    label,
    run: () => {
      void import("./quick-search.js").then((m) => {
        m.openQuickSearch();
      });
    },
  };
}

/** Render an empty state. */
export function renderEmptyState(spec: EmptyStateSpec): TemplateResult {
  const actions = spec.actions ?? [];
  return html`
    <div
      class=${classMap({
        "empty-state": true,
        "empty-state--compact": Boolean(spec.compact),
        "empty-state--teach": true,
      })}
    >
      <p class="empty-state-message">${spec.message}</p>
      ${spec.detail ? html`<p class="empty-state-detail">${spec.detail}</p>` : nothing}
      ${
        actions.length > 0
          ? html`<div class="empty-state-actions">
              ${actions.map(
                (action) => html`
                  <sp-action-button
                    size="s"
                    class="empty-state-action"
                    ?disabled=${Boolean(action.disabled)}
                    @click=${() => action.run()}
                    >${action.icon ?? nothing}${action.label}</sp-action-button
                  >
                `,
              )}
            </div>`
          : nothing
      }
    </div>
  `;
}
