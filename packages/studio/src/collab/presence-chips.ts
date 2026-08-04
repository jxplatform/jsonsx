/**
 * Presence chips — who else is in this co-editing session, the sync-status pill that replaces the
 * dirty dot for collab tabs, and the two states co-editing had no way to announce (§7.4).
 *
 * Pure lit templates over `collabState(tab)`; the toolbar includes them and its render effect
 * tracks the underlying reactive state.
 *
 * **What was invisible.** Three things:
 *
 * - **The source-canonical freeze.** While a peer holds the code view, structural edits are refused.
 *   The whole rendering of that was a three-second grey status line the moment you tried — which is
 *   precisely what a bug looks like. It gets a persistent indicator, so the refusal has a visible
 *   cause standing beside it for as long as it is true.
 * - **Read-only guests.** Their edits applied locally and were dropped at the publish gate. They now
 *   get a banner that says so before they type, not a silence after.
 * - **A failed attach.** It set `status = "detached"` — the same value a solo document carries — so a
 *   dead relay was indistinguishable from nobody having shared the file. `"failed"` and
 *   `"unavailable"` are now separate states with separate sentences.
 *
 * **Undo says what it does.** The Y.UndoManager is constructed with `trackedOrigins:
 * {LOCAL_ORIGIN}`, so ⌘Z reaches your own actions and never a peer's. That is the correct behaviour
 * and it is also surprising, so the status pill's title states it — §13 lists this as adopted
 * precisely because silently undoing someone else's work is worse than not undoing.
 */

import { html, nothing } from "lit-html";
import type { TemplateResult } from "lit-html";
import { collabState } from "./collab-state";
import type { CollabTabStatus, PeerPresence } from "./collab-state";
import type { Tab } from "../tabs/tab";

function initialOf(peer: PeerPresence): string {
  const name = peer.state.user.name ?? peer.state.user.login;
  return (name[0] ?? "?").toUpperCase();
}

function titleOf(peer: PeerPresence, docPath: string | null): string {
  const { user } = peer.state;
  const who = user.name ? `${user.name} (${user.login})` : user.login;
  const here = peer.state.focusedPath && peer.state.focusedPath === docPath;
  return here ? who : `${who} — ${peer.state.focusedPath ?? "browsing"}`;
}

/** One line per status. Every state says what it is; none of them say nothing. */
const STATUS_LABEL: Readonly<Record<CollabTabStatus, string>> = {
  connecting: "Connecting…",
  detached: "Solo",
  failed: "Not connected",
  offline: "Offline — changes sync on reconnect",
  synced: "Live",
  unavailable: "",
};

/**
 * The sentence behind the pill — including the one undo fact nobody would guess.
 *
 * @param {CollabTabStatus} status
 * @param {string} attachError
 * @returns {string}
 */
export function statusTitle(status: CollabTabStatus, attachError: string): string {
  if (status === "failed") {
    return (
      `Live collaboration could not start${attachError ? ` — ${attachError}` : ""}. ` +
      "Your edits are saved to this machine as usual."
    );
  }
  if (status === "synced" || status === "offline") {
    return `${STATUS_LABEL[status]}. Undo only takes back your own edits, never a collaborator's.`;
  }
  return STATUS_LABEL[status];
}

/** Chips + status pill for the toolbar; `nothing` while the tab has no collaboration to report. */
export function presenceChipsTemplate(tab: Tab | null): TemplateResult | typeof nothing {
  if (!tab) {
    return nothing;
  }
  const state = collabState(tab);
  /* "unavailable" is the only silent state: this build has no collaboration, so there is nothing to
     be honest ABOUT. Every other state — including solo and failed — says which one it is. */
  if (state.status === "unavailable") {
    return nothing;
  }
  const label = STATUS_LABEL[state.status] || state.status;
  return html`
    <div class="jx-presence" title=${statusTitle(state.status, state.attachError)}>
      <span class="jx-presence-status" data-status=${state.status}>${label}</span>
      ${
        state.readOnly
          ? html`<span
              class="jx-presence-flag"
              data-flag="read-only"
              title="You have read access to this session. Your edits show here but are not published to the others."
              >Read-only</span
            >`
          : nothing
      }
      ${
        state.sourceCanonical
          ? html`<span
              class="jx-presence-flag"
              data-flag="frozen"
              title="Someone is editing the code view. Structural edits are paused until they stop — this is not an error."
              >Code view held</span
            >`
          : nothing
      }
      ${state.peers.map(
        (peer) => html`
          <span
            class="jx-presence-chip"
            style="background:${peer.state.user.color}"
            title=${titleOf(peer, tab.documentPath)}
            >${
              peer.state.user.avatarUrl
                ? html`<img src=${peer.state.user.avatarUrl} alt=${initialOf(peer)} />`
                : initialOf(peer)
            }</span
          >
        `,
      )}
    </div>
  `;
}

/**
 * The read-only banner — a standing statement, not an after-the-fact refusal.
 *
 * A guest without write access used to watch their edits apply locally and be dropped silently at
 * the publish gate, which reads as the app losing work. The sentence has to be there before the
 * first keystroke, so it is rendered by the PANE CHROME (`panels/pane-context.ts`) rather than by
 * the toolbar the chips ride in: the chrome is per-pane and per-document, it sits directly above
 * the editing surface, and the stage is offset by the band it lives in — so the banner pushes the
 * document down instead of covering it.
 */
export function readOnlyBannerTemplate(tab: Tab | null): TemplateResult | typeof nothing {
  if (!tab) {
    return nothing;
  }
  const state = collabState(tab);
  if (!state.active || !state.readOnly) {
    return nothing;
  }
  return html`
    <div class="jx-collab-banner" role="status" data-kind="read-only">
      You have read access to this session. You can explore and edit locally, but your changes are
      not published to the other people in it.
    </div>
  `;
}
