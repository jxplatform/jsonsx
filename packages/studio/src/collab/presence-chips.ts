/**
 * Presence chips — who else is in this co-editing session, plus the sync-status pill that replaces
 * the dirty dot for collab tabs. Pure lit templates over collabState(tab); the toolbar includes
 * them and its render effect tracks the underlying reactive state.
 */

import { html, nothing } from "lit-html";
import type { TemplateResult } from "lit-html";
import { collabState } from "./collab-state";
import type { PeerPresence } from "./collab-state";
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

const STATUS_LABEL: Record<string, string> = {
  connecting: "Connecting…",
  offline: "Offline — changes sync on reconnect",
  synced: "Live",
};

/** Chips + status pill for the toolbar; `nothing` while the tab isn't co-editing. */
export function presenceChipsTemplate(tab: Tab | null): TemplateResult | typeof nothing {
  if (!tab) {
    return nothing;
  }
  const state = collabState(tab);
  if (state.status === "detached") {
    return nothing;
  }
  const label = STATUS_LABEL[state.status] ?? state.status;
  return html`
    <div class="jx-presence" title=${label}>
      <span class="jx-presence-status" data-status=${state.status}>${label}</span>
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
