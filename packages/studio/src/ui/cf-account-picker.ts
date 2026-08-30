/// <reference lib="dom" />
/**
 * Cf-account-picker.ts — "which Cloudflare account?", the question nothing in Studio asked.
 *
 * A Cloudflare grant can reach several accounts, and the broker stores exactly one id per
 * connection. Until one is chosen every Cloudflare-backed call answers `cf_account_required`, so a
 * multi-account user finished the hosted OAuth flow and landed in a state that reads as connected
 * and behaves as broken: the assistant 401s, publishing 401s, and no surface says why. The broker
 * has had `/cf/accounts` and `/cf/select-account` the whole time; this is the first caller.
 *
 * ONE picker, invoked wherever a connect resolves account-less — the assistant's managed-connect
 * CTA, the publish panel, and a button on the Preferences row. A second picker per surface is how
 * three surfaces end up disagreeing about what "connected" means.
 *
 * Cloud-only by construction: the PAL members it drives are the brokered ones, so a platform
 * holding a pasted API token (desktop, dev server) keeps its own local account field and this
 * resolves null without opening anything.
 *
 * @docs studio/ai
 * @license MIT
 */

import { html, render as litRender, nothing } from "lit-html";
import { ref } from "lit-html/directives/ref.js";
import type { TemplateResult } from "lit-html";
import { getPlatform, hasPlatform } from "../platform";
import { notifyCredentialsChanged } from "../settings/preferences-accounts";
import { showDialog } from "./layers";
import { overlayRegion } from "./regions";
import type { CfAccountSummary } from "../types";

/** Whether this platform brokers the connection, and so can be asked which accounts it reaches. */
function canPick(): boolean {
  if (!hasPlatform()) {
    return false;
  }
  const platform = getPlatform();
  return Boolean(platform.cfAccounts && platform.cfSelectAccount);
}

/**
 * Ask which Cloudflare account this connection should use, and store the answer.
 *
 * Resolves the chosen account, or null — dismissed, or a platform that does not broker connections
 * at all. A caller treats null as "still unusable" rather than as a failure: nothing was changed,
 * and the surface that opened this is the one that knows what to say about it.
 *
 * @returns {Promise<CfAccountSummary | null>}
 */
export function openCfAccountPicker(): Promise<CfAccountSummary | null> {
  if (!canPick()) {
    return Promise.resolve(null);
  }
  return showDialog<CfAccountSummary | null>(
    (done) => {
      let accounts: CfAccountSummary[] = [];
      let loading = true;
      /** The last refusal — a listing that failed, or an account the broker would not accept. */
      let failure = "";
      /** The id being committed, so its own row can say so rather than the whole list going grey. */
      let choosing = "";
      let settled = false;
      let wrapperEl: HTMLElement | null = null;

      function finish(account: CfAccountSummary | null): void {
        settled = true;
        done(account);
      }

      function repaint(): void {
        /* Resolved lazily, and only while the dialog is still up: `done` releases the slot, so a
           late `load()` landing after a dismissal would otherwise paint into a detached host. */
        const host = settled ? null : wrapperEl?.parentElement;
        if (host) {
          litRender(build(), host);
        }
      }

      async function load(): Promise<void> {
        loading = true;
        failure = "";
        repaint();
        try {
          accounts = (await getPlatform().cfAccounts?.()) ?? [];
        } catch (error) {
          failure = error instanceof Error ? error.message : String(error);
        }
        loading = false;
        repaint();
      }

      async function choose(account: CfAccountSummary): Promise<void> {
        choosing = account.id;
        failure = "";
        repaint();
        try {
          await getPlatform().cfSelectAccount?.({ id: account.id, name: account.name });
        } catch (error) {
          failure = error instanceof Error ? error.message : String(error);
          choosing = "";
          repaint();
          return;
        }
        /* The stored account is a credential like any other: the assistant's gate, the publish
           panel and the Preferences row all re-read from the same announcement. */
        notifyCredentialsChanged();
        finish(account);
      }

      function listTpl(): TemplateResult | typeof nothing {
        if (loading) {
          return html`<p class="cf-account-picker-empty">Reading your Cloudflare accounts…</p>`;
        }
        /* Nothing to show and a reason why. The retry is offered only here: a commit that was
           refused (below) keeps the list, because listing again is not what would fix it. */
        if (accounts.length === 0) {
          return html`
            <p class="cf-account-picker-empty">
              ${
                failure
                  ? `Cloudflare could not be reached: ${failure}`
                  : "This Cloudflare login reaches no accounts. Create one at dash.cloudflare.com, then try again."
              }
            </p>
            ${
              failure
                ? html`<sp-button
                    size="s"
                    treatment="outline"
                    @click=${() => {
                      void load();
                    }}
                  >
                    Try again
                  </sp-button>`
                : nothing
            }
          `;
        }
        /* The row shape is Preferences › Accounts', deliberately reused: this IS an account list,
           and a second stylesheet entry for the same shape is how two lists drift apart. */
        return html`
          ${failure ? html`<p class="cf-account-picker-error">${failure}</p>` : nothing}
          <div class="prefs-accounts">
            ${accounts.map(
              (account) => html`
                <div class="prefs-account" data-account=${account.id}>
                  <div class="prefs-account-text">
                    <span class="prefs-account-label">${account.name}</span>
                    <span class="prefs-account-detail">${account.id}</span>
                  </div>
                  <sp-button
                    size="s"
                    variant="accent"
                    ?disabled=${choosing !== ""}
                    @click=${() => {
                      void choose(account);
                    }}
                  >
                    ${choosing === account.id ? "Selecting…" : "Use this account"}
                  </sp-button>
                </div>
              `,
            )}
          </div>
        `;
      }

      function build(): TemplateResult {
        return html`
          <sp-dialog-wrapper
            open
            underlay
            headline="Choose a Cloudflare account"
            cancel-label="Cancel"
            @cancel=${() => finish(null)}
            @close=${() => finish(null)}
            ${ref((el?: Element) => {
              if (el) {
                wrapperEl = el as HTMLElement;
              }
            })}
          >
            <div class="cf-account-picker">
              <p class="cf-account-picker-lede">
                Your Cloudflare login reaches more than one account. Publishing and the assistant
                both run against the one you pick; you can change it in Preferences › Accounts.
              </p>
              ${listTpl()}
            </div>
          </sp-dialog-wrapper>
        `;
      }

      void load();
      return build();
    },
    { region: overlayRegion("dialog", "cf-accounts") },
  );
}
