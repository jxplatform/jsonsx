/// <reference lib="dom" />
/**
 * A blocking progress modal for long-running package operations (bun install / dependency updates).
 * Shows an indeterminate spinner with a status line; on failure it swaps to an error view with the
 * captured log and a Close button. Built on the persistent-modal layer helper.
 */

import { html } from "lit-html";
import type { TemplateResult } from "lit-html";
import { openModal } from "./layers";

export interface ProgressModalHandle {
  /** Update the status line shown under the title. */
  setStatus: (text: string) => void;
  /** Replace the spinner with an error view (log shown) that the user dismisses. */
  fail: (message: string) => void;
  /** Close the modal (success path). */
  done: () => void;
}

function card(body: TemplateResult): TemplateResult {
  return html`
    <sp-underlay open></sp-underlay>
    <div
      class="progress-modal"
      role="dialog"
      aria-live="polite"
      style="position:fixed;inset:0;margin:auto;width:min(420px,calc(100vw - 48px));max-height:calc(100vh - 96px);height:max-content;background:var(--bg-panel,#1e1e1e);border:1px solid var(--border,#3a3a3a);border-radius:var(--spectrum-corner-radius-200,8px);padding:24px;display:flex;flex-direction:column;gap:16px;box-shadow:0 8px 32px rgba(0,0,0,.4)"
    >
      ${body}
    </div>
  `;
}

function runningView(title: string, status: string): TemplateResult {
  return card(html`
    <div style="display:flex;align-items:center;gap:14px">
      <sp-progress-circle indeterminate size="m" aria-label=${title}></sp-progress-circle>
      <div style="display:flex;flex-direction:column;gap:2px">
        <strong style="font-size:var(--spectrum-font-size-100, 14px)">${title}</strong>
        ${status
          ? html`<span style="font-size:var(--spectrum-font-size-75, 12px);color:var(--fg-dim,#aaa)"
              >${status}</span
            >`
          : ""}
      </div>
    </div>
  `);
}

function errorView(title: string, message: string, onClose: () => void): TemplateResult {
  return card(html`
    <div style="display:flex;flex-direction:column;gap:8px">
      <strong style="font-size:var(--spectrum-font-size-100, 14px);color:var(--danger,#e34850)"
        >${title} failed</strong
      >
      <pre
        style="font-size:var(--spectrum-font-size-50, 11px);white-space:pre-wrap;overflow:auto;max-height:240px;margin:0;color:var(--fg-dim,#aaa)"
      >
${message}</pre
      >
    </div>
    <div style="display:flex;justify-content:flex-end">
      <sp-button size="s" @click=${onClose}>Close</sp-button>
    </div>
  `);
}

export function showProgressModal(opts: { title: string; status?: string }): ProgressModalHandle {
  const modal = openModal(runningView(opts.title, opts.status ?? ""));
  let closed = false;

  const close = () => {
    if (closed) {
      return;
    }
    closed = true;
    modal.close();
  };

  return {
    done: close,
    fail(message: string) {
      if (!closed) {
        modal.update(errorView(opts.title, message || "Unknown error", close));
      }
    },
    setStatus(text: string) {
      if (!closed) {
        modal.update(runningView(opts.title, text));
      }
    },
  };
}
