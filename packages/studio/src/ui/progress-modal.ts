/// <reference lib="dom" />
/**
 * The one surface in Studio that still BLOCKS while it works — and now the only one (plan §7.3).
 *
 * What changed. This modal used to be four things at once: the running state, the error view, the
 * log and the operation's entire memory. It blocked the whole app, offered no way out, and took all
 * four with it when it closed — so a failed `bun install` could be read exactly once, and a hung
 * one could not be escaped at all. §7.3 splits those apart:
 *
 * - The **record** moves to `panels/activity-panel.ts`, which keeps the entry, its steps and its log
 *   after the modal is gone;
 * - The **error view** is promoted into Problems — {@link ProgressModalHandle.fail} raises a
 *   `notify.error` carrying the captured log as its `detail`, so the failure persists, is grouped
 *   by source, and carries a Retry built from a command record;
 * - And the **exit** arrives twice: `Run in the background` hands the app back while the operation
 *   keeps going in Activity, and an operation that passed a `cancel` gets a real Cancel button.
 *
 * What did NOT change is which operations block. §7.3 keeps blocking for dependency install and
 * nothing else, and this module's four call sites are exactly that — `packages/ensure-deps.ts`,
 * `packages/pull-package-sync.ts`, `packages/jxsuite-update.ts` and
 * `settings/dependencies-editor.ts`. Every other long operation calls `beginActivity` directly and
 * blocks nobody.
 */

import { html } from "lit-html";
import { beginActivity } from "../panels/activity-panel";
import { setBottomTab } from "../shell";
import { openModal } from "./layers";
import type { ActivityHandle } from "../panels/activity-panel";
import type { TemplateResult } from "lit-html";

export interface ProgressModalHandle {
  /** Update the status line shown under the title. Also the Activity entry's status. */
  setStatus: (text: string) => void;
  /** Append captured output. It is the Activity entry's log and a failure's `detail`. */
  log: (chunk: string) => void;
  /** Record the failure as a Problem (message + captured log) and close the modal. */
  fail: (message: string) => void;
  /** Close the modal and mark the operation done (success path). */
  done: () => void;
  /** The Activity entry this operation is recorded in, which outlives the modal. */
  activity: ActivityHandle;
}

export interface ProgressModalOptions {
  title: string;
  status?: string;
  /** Who is running it — "Packages" for all four of today's call sites. */
  source?: string;
  /**
   * Stop the operation. Draws Cancel, here and on the Activity row.
   *
   * Absent means the operation genuinely cannot be stopped, and no button claims otherwise — but
   * `Run in the background` is offered regardless, because "let me use the app" is a promise this
   * module can always keep.
   */
  cancel?: () => void;
}

function card(body: TemplateResult): TemplateResult {
  return html`
    <sp-underlay open></sp-underlay>
    <div class="progress-modal" aria-live="polite">${body}</div>
  `;
}

/**
 * The running view: the spinner, the status line, and the two ways out.
 *
 * `Run in the background` is not a cancel and does not pretend to be — it dismisses the BLOCKING
 * part and leaves the operation running where it can be watched, which is the affordance a modal
 * with no exit never had.
 */
function runningView(
  title: string,
  status: string,
  actions: { background: () => void; cancel?: (() => void) | undefined },
): TemplateResult {
  return card(html`
    <div class="progress-head">
      <sp-progress-circle indeterminate size="m" aria-label=${title}></sp-progress-circle>
      <div class="progress-lines">
        <strong class="progress-title">${title}</strong>
        ${status ? html`<span class="progress-status">${status}</span>` : ""}
      </div>
    </div>
    <div class="progress-actions">
      <sp-button size="s" variant="secondary" treatment="outline" @click=${actions.background}>
        Run in the background
      </sp-button>
      ${
        actions.cancel
          ? html`<sp-button size="s" variant="negative" @click=${actions.cancel}>Cancel</sp-button>`
          : ""
      }
    </div>
  `);
}

/**
 * Show a blocking progress modal, and record the operation in Activity either way.
 *
 * @param {ProgressModalOptions} opts
 * @returns {ProgressModalHandle}
 */
export function showProgressModal(opts: ProgressModalOptions): ProgressModalHandle {
  let closed = false;

  const activity = beginActivity({
    title: opts.title,
    ...(opts.status === undefined ? {} : { status: opts.status }),
    ...(opts.source === undefined ? {} : { source: opts.source }),
    ...(opts.cancel === undefined ? {} : { cancel: opts.cancel }),
  });

  const close = () => {
    if (closed) {
      return;
    }
    closed = true;
    modal.close();
  };

  /** Hand the app back and put the operation where it can be watched. */
  const background = () => {
    close();
    setBottomTab("activity");
  };

  const cancel = opts.cancel
    ? () => {
        close();
        opts.cancel?.();
      }
    : undefined;

  const view = (status: string) => runningView(opts.title, status, { background, cancel });

  const modal = openModal(view(opts.status ?? ""), {
    label: opts.title,
    // Escape means the same thing the button does: stop BLOCKING, not stop working. The operation
    // Owned the modal outright before, and swallowing Escape was the only honest thing a surface
    // With nowhere to put a running operation could do.
    onDismiss: background,
  });

  return {
    activity,
    done() {
      activity.done();
      close();
    },
    fail(message: string) {
      // The error view is not rendered here any more: it is the Problems row, with the log as its
      // `detail`, and it is still on screen tomorrow. Three of the four call sites hand over a
      // CAPTURED LOG as their message — `result.log ?? "bun install failed"` — so a multi-line one
      // Is split the way the old view split it: "<title> failed" as the headline, the whole text
      // As the detail. A Problems list whose first row is 400 lines of `bun` output is not a list.
      const text = (message ?? "").trim();
      if (text === "" || text.includes("\n")) {
        activity.log(text);
        activity.fail(`${opts.title} failed`);
      } else {
        activity.fail(text);
      }
      close();
    },
    log(chunk: string) {
      activity.log(chunk);
    },
    setStatus(text: string) {
      activity.setStatus(text);
      if (!closed) {
        modal.update(view(text));
      }
    },
  };
}
