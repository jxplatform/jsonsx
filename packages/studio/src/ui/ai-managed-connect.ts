/// <reference lib="dom" />
/**
 * Ai-managed-connect.ts — the keyless "Connect Cloudflare" (Workers AI) option for credentials
 * gates.
 *
 * Companion to ai-credentials-form.ts: managed platforms broker Workers AI on the user's OWN
 * Cloudflare account, so a gate that renders only the key form strands them — they have no key, and
 * nothing on screen offers the hosted OAuth flow that would give them working AI. Both hosts that
 * gate on credentials (the assistant sidebar and the New Project modal's Import/Agent tabs) embed
 * this alongside the form so both real paths are always on offer.
 *
 * State is per-instance (closure-scoped) like the credentials form; the capability probe behind
 * `ensureProbe` is shared module-wide by services/ai-models.ts.
 *
 * @docs studio/ai
 * @license MIT
 */

import { html, nothing } from "lit-html";
import type { TemplateResult } from "lit-html";
import { getPlatform, hasPlatform } from "../platform";
import {
  ensureProxyProbe,
  fetchAvailableModels,
  isManagedProxy,
  isProxyConfigured,
} from "../services/ai-models";

export interface ManagedConnectOptions {
  /** Host re-render scheduler — called on connect start/finish and when the probe settles. */
  requestRender: () => void;
}

export interface ManagedConnect {
  /** Whether the keyless path is available and worth offering right now. */
  canOffer: () => boolean;
  /** Fire the shared capability probe, repainting the host when it settles. */
  ensureProbe: () => void;
  /** The CTA block, or `nothing` when the platform cannot broker AI. */
  render: () => TemplateResult | typeof nothing;
}

/**
 * Create a managed-connect controller bound to a host's render scheduler.
 *
 * @param {ManagedConnectOptions} opts
 * @returns {ManagedConnect}
 */
export function createManagedConnect(opts: ManagedConnectOptions): ManagedConnect {
  let busy = false;
  let connectError = "";

  /*
   * Offer the keyless path when the proxy says managed-but-unconfigured and the platform can run
   * the hosted OAuth flow (the PAL seam — desktop shells can implement cfConnect later). Guarded on
   * hasPlatform() because gates can render from modules that load before registration.
   */
  function canOffer(): boolean {
    return (
      isManagedProxy() && !isProxyConfigured() && hasPlatform() && Boolean(getPlatform().cfConnect)
    );
  }

  function ensureProbe() {
    ensureProxyProbe(opts.requestRender);
  }

  async function connect() {
    if (busy) {
      return;
    }
    busy = true;
    connectError = "";
    opts.requestRender();
    try {
      const connection = await getPlatform().cfConnect?.();
      if (connection) {
        // Re-probe: /models flips to configured once the connection lands, opening the gate.
        await fetchAvailableModels({ force: true });
      } else {
        connectError = "Cloudflare connection was not completed.";
      }
    } catch (error) {
      connectError = error instanceof Error ? error.message : String(error);
    }
    busy = false;
    opts.requestRender();
  }

  function render(): TemplateResult | typeof nothing {
    if (!canOffer()) {
      return nothing;
    }
    return html`
      <div class="ai-managed-connect">
        <div>Use Workers AI on your own Cloudflare account — no API key needed.</div>
        <sp-button size="s" ?disabled=${busy} @click=${() => void connect()}>
          ${busy ? "Connecting…" : "Connect Cloudflare"}
        </sp-button>
        ${connectError ? html`<div class="ai-managed-connect-error">${connectError}</div>` : nothing}
        <div class="ai-managed-connect-divider">— or bring your own key —</div>
      </div>
    `;
  }

  return { canOffer, ensureProbe, render };
}
