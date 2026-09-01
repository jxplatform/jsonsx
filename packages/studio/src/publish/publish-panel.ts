/// <reference lib="dom" />
/**
 * Publish panel — the one-click Cloudflare Pages publish flow, driven by the
 * PAL's cf* members. States: unsupported platform → info; no credential →
 * connect (hosted OAuth via cfConnect, or an API-token form backed by
 * cf-settings); connected without `build.deploy` → create-and-connect form;
 * connected → deployment status (publishing rides every commit).
 *
 * **The token was in the DOM, on every open.** `credentialTpl` rendered
 * `value=${getCfToken()}` into an `sp-textfield` whenever a token was stored and
 * the platform had no hosted broker — a control the reader had not asked to
 * edit, on a surface `scripts/screenshots` photographs. `type="password"` masks
 * pixels and nothing else: the value is in the attribute, in the serialized
 * HTML, in the accessibility tree and in every DOM dump. It is gone. A stored
 * token is now reported as *stored*, the field is only ever drawn empty for a
 * REPLACEMENT the reader asked for, and revoking lives where every other
 * credential's does — Preferences › Accounts (`studio.md` §15 rule 1: a surface
 * never prints the secret it describes).
 *
 * @license MIT
 */

import { html } from "lit-html";
import type { DeployConfig, ProjectConfig } from "@jxsuite/schema/types";
import { activeRegistry } from "../commands/active-registry";
import { currentDeploy, noteDeployment } from "./deploy-checklist";
import { getPlatform } from "../platform";
import { getCfToken, setCfToken } from "../services/cf-settings";
import { resetModelCache } from "../services/ai-models";
import { projectState } from "../store";
import type { CfConnection } from "../types";
import { openModal } from "../ui/layers";
import type { CfAccount, PagesDeploymentInfo } from "./pages-service";
import {
  connectDeploy,
  latestDeployment,
  listAccounts,
  platformSupportsPublish,
  writeDeployConfig,
} from "./pages-service";

const PAGES_APP_INSTALL_URL = "https://github.com/apps/cloudflare-pages/installations/new";

let _handle: ReturnType<typeof openModal> | null = null;
let _connection: CfConnection | null | "loading" = "loading";
let _accounts: CfAccount[] = [];
let _deployment: PagesDeploymentInfo | null = null;
let _error = "";
let _busy = false;
/** Whether the reader has asked to replace a token that is already stored. */
let _replacing = false;
let _form = { accountId: "", branch: "main", owner: "", projectName: "", repo: "" };

function currentConfig(): ProjectConfig | null {
  return (projectState?.projectConfig as ProjectConfig | undefined) ?? null;
}

function deriveSlug(name: string): string {
  return (
    name
      .toLowerCase()
      .replaceAll(/[^a-z0-9]+/g, "-")
      .replaceAll(/^-+|-+$/g, "")
      .slice(0, 58) || "site"
  );
}

/**
 * Prefill owner/repo from cloud root keys ("owner/repo@branch", or the older "owner/repo"); blank
 * elsewhere. The branch is part of the key the cloud adapter reports as its `projectRoot` — without
 * the optional suffix here, the whole key failed to match and the form opened empty.
 */
function prefillRepo(): { owner: string; repo: string } {
  const root = getPlatform().projectRoot;
  const match = /^([\w.-]+)\/([\w.-]+)(?:@.+)?$/.exec(root);
  return match ? { owner: match[1]!, repo: match[2]! } : { owner: "", repo: "" };
}

async function loadConnection(): Promise<void> {
  _connection = "loading";
  render();
  try {
    _connection = (await getPlatform().cfConnection?.()) ?? null;
    /*
     * A lapsed brokered connection is `connected: true`, and asking Cloudflare anything through one
     * is a guaranteed 401. Every such call landed in the catch below, which nulled the connection —
     * so the panel showed the FIRST-TIME "Connect Cloudflare" invitation next to a raw
     * "Cloudflare API: …" string, and never the one sentence that was true: it expired.
     */
    if (_connection?.connected && !_connection.needsReconnect) {
      _accounts = await listAccounts();
      _form.accountId = _connection.accountId ?? _accounts[0]?.id ?? "";
      const deploy = currentDeploy();
      if (deploy) {
        _deployment = await latestDeployment(deploy);
        // We ASKED, so the deploy checklist may stop saying "unknown" — including when the answer
        // Was "none", which is a fact and not an absence of one.
        noteDeployment(_deployment);
      }
    }
  } catch (error) {
    _connection = null;
    _error = error instanceof Error ? error.message : String(error);
  }
  render();
}

/**
 * Take the token straight from the live control to storage.
 *
 * It is read from the DOM and never written back to it, which is the whole asymmetry: a secret may
 * pass through a field the user typed it into, and may not be painted into one they did not.
 */
async function saveToken(host: HTMLElement): Promise<void> {
  const input = host.querySelector<HTMLInputElement>("#cf-token-input");
  const value = (input?.value ?? "").trim();
  if (!value) {
    _error = "Paste a token, or use Preferences › Accounts to forget the stored one.";
    render();
    return;
  }
  setCfToken(value);
  if (input) {
    input.value = "";
  }
  _replacing = false;
  _error = "";
  await loadConnection();
}

/** Open Preferences on Accounts — the one place a credential is listed and forgotten. */
function openAccounts(): void {
  void activeRegistry()?.run("app.preferences", { section: "accounts" });
}

/**
 * Run the hosted OAuth flow and act on how it ended.
 *
 * The four endings are not interchangeable, and collapsing them is what left a user staring at an
 * unchanged panel: a deadline that passed and a popup the browser turned into a full-page redirect
 * both resolved null, and both were reported as "not completed" — one of them while the document
 * was already navigating away.
 */
async function hostedConnect(): Promise<void> {
  _busy = true;
  _error = "";
  render();
  try {
    const outcome = (await getPlatform().cfConnect?.()) ?? null;
    if (outcome?.status === "timeout") {
      _error =
        "The Cloudflare window didn't finish. Sign in there, then reconnect — nothing was changed.";
    } else if (outcome?.status === "connected" && !outcome.connection.accountId) {
      /* Lazily: this module is the publish modal, and the picker drags the dialog layer with it. */
      const { openCfAccountPicker } = await import("../ui/cf-account-picker");
      await openCfAccountPicker();
    }
    /* `canceled` and `redirect` say nothing. The user closed the popup, or the page is on its way
       to Cloudflare — an apology painted over either one is noise. */
  } catch (error) {
    _error = error instanceof Error ? error.message : String(error);
  }
  _busy = false;
  // The assistant's gate reads the same grant through /models, so a reconnect it does not hear
  // About leaves it insisting the connection is dead.
  resetModelCache();
  await loadConnection();
}

async function submitConnect(): Promise<void> {
  const config = currentConfig();
  if (!config) {
    return;
  }
  if (!_form.projectName || !_form.owner || !_form.repo || !_form.accountId) {
    _error = "Account, project name, and the GitHub owner/repo are all required.";
    render();
    return;
  }
  _busy = true;
  _error = "";
  render();
  try {
    const deploy = await connectDeploy(config, {
      accountId: _form.accountId,
      owner: _form.owner,
      productionBranch: _form.branch || "main",
      projectName: _form.projectName,
      repo: _form.repo,
    });
    _deployment = await latestDeployment(deploy).catch(() => null);
  } catch (error) {
    _error = error instanceof Error ? error.message : String(error);
  }
  _busy = false;
  render();
}

async function disconnect(): Promise<void> {
  const config = currentConfig();
  if (!config) {
    return;
  }
  _busy = true;
  render();
  try {
    await writeDeployConfig(config, null);
    _deployment = null;
  } catch (error) {
    _error = error instanceof Error ? error.message : String(error);
  }
  _busy = false;
  render();
}

function close(): void {
  _handle?.close();
  _handle = null;
}

function fieldRow(label: string, input: unknown) {
  return html`
    <label class="publish-field">
      <span>${label}</span>
      ${input}
    </label>
  `;
}

/**
 * The connection exists and has lapsed.
 *
 * Its own template rather than a line inside {@link credentialTpl}, because the honest words are the
 * opposite of that one's: nothing needs to be set up, nothing was lost, and the only action is to
 * sign in again. The panel used to say "Connect your Cloudflare account to publish this site" to a
 * user who had already done exactly that.
 */
function lapsedTpl() {
  return html`
    <p>
      Your Cloudflare connection has expired, so publishing cannot reach your account. Reconnect to
      restore it — this site's Pages project and its settings are untouched.
    </p>
    <sp-button
      variant="accent"
      ?disabled=${_busy}
      @click=${() => {
        void hostedConnect();
      }}
    >
      ${_busy ? "Reconnecting…" : "Reconnect Cloudflare"}
    </sp-button>
  `;
}

function credentialTpl() {
  const platform = getPlatform();
  if (platform.cfConnect) {
    return html`
      <p>Connect your Cloudflare account to publish this site.</p>
      <sp-button
        ?disabled=${_busy}
        @click=${() => {
          void hostedConnect();
        }}
      >
        Connect Cloudflare
      </sp-button>
    `;
  }
  const stored = getCfToken() !== "";
  if (stored && !_replacing) {
    // The token is STORED, and that is the whole of what this says. It was rejected or has expired
    // — otherwise `_connection.connected` would be true and this branch unreachable — so the two
    // Honest moves are to replace it or to forget it, and neither needs to see it.
    return html`
      <p>
        A Cloudflare API token is stored on this machine, and Cloudflare did not accept it. It may
        have been revoked, or it may be missing the Account Settings Read and Pages Read/Write
        permissions.
      </p>
      <div class="publish-actions">
        <sp-button
          ?disabled=${_busy}
          @click=${() => {
            _replacing = true;
            _error = "";
            render();
          }}
        >
          Replace token
        </sp-button>
        <sp-button variant="secondary" @click=${openAccounts}>Preferences › Accounts</sp-button>
      </div>
    `;
  }
  return html`
    <p>
      Paste a Cloudflare API token (permissions: Account Settings Read, Pages Read/Write). It is
      stored on this machine and only sent to the same-origin proxy — Studio never renders it back.
    </p>
    ${fieldRow(
      "API token",
      html`<sp-textfield
        id="cf-token-input"
        type="password"
        value=""
        placeholder="cf_..."
      ></sp-textfield>`,
    )}
    <div class="publish-actions">
      <sp-button
        ?disabled=${_busy}
        @click=${(e: Event) => {
          void saveToken(hostOf(e));
        }}
      >
        Verify &amp; Connect
      </sp-button>
      <sp-button variant="secondary" @click=${openAccounts}>Preferences › Accounts</sp-button>
    </div>
  `;
}

function hostOf(e: Event): HTMLElement {
  return (e.target as HTMLElement).closest(".publish-modal") ?? document.body;
}

function connectFormTpl() {
  return html`
    <p>
      Create a Cloudflare Pages project connected to this repository. Every commit then builds and
      publishes automatically (<code>bunx jx build</code>).
    </p>
    ${fieldRow(
      "Account",
      html`
        <sp-picker
          value=${_form.accountId}
          @change=${(e: Event) => {
            _form.accountId = (e.target as HTMLInputElement).value;
          }}
        >
          ${_accounts.map((a) => html`<sp-menu-item value=${a.id}>${a.name}</sp-menu-item>`)}
        </sp-picker>
      `,
    )}
    ${fieldRow(
      "Pages project name",
      html`<sp-textfield
        value=${_form.projectName}
        @input=${(e: Event) => {
          _form.projectName = (e.target as HTMLInputElement).value;
        }}
      ></sp-textfield>`,
    )}
    ${fieldRow(
      "GitHub owner",
      html`<sp-textfield
        value=${_form.owner}
        @input=${(e: Event) => {
          _form.owner = (e.target as HTMLInputElement).value;
        }}
      ></sp-textfield>`,
    )}
    ${fieldRow(
      "GitHub repository",
      html`<sp-textfield
        value=${_form.repo}
        @input=${(e: Event) => {
          _form.repo = (e.target as HTMLInputElement).value;
        }}
      ></sp-textfield>`,
    )}
    ${fieldRow(
      "Production branch",
      html`<sp-textfield
        value=${_form.branch}
        @input=${(e: Event) => {
          _form.branch = (e.target as HTMLInputElement).value;
        }}
      ></sp-textfield>`,
    )}
    <sp-button
      ?disabled=${_busy}
      @click=${() => {
        void submitConnect();
      }}
    >
      ${_busy ? "Connecting…" : "Create & Connect"}
    </sp-button>
  `;
}

function statusTpl(deploy: DeployConfig) {
  return html`
    <p>
      Connected to Pages project <strong>${deploy.projectName}</strong>
      ${
        deploy.productionUrl
          ? html` —
              <a href=${deploy.productionUrl} target="_blank" rel="noreferrer">
                ${deploy.productionUrl}
              </a>`
          : ""
      }
    </p>
    ${
      _deployment
        ? html`
            <p>
              Latest deployment: <strong>${_deployment.stage}: ${_deployment.status}</strong>
              (${_deployment.environment}) —
              <a href=${_deployment.url} target="_blank" rel="noreferrer">preview</a>
            </p>
          `
        : html`<p>No deployments yet — the first commit after connecting triggers one.</p>`
    }
    <p class="publish-hint">Publishing happens automatically on every commit.</p>
    <div class="publish-actions">
      <sp-button
        variant="secondary"
        ?disabled=${_busy}
        @click=${() => {
          void loadConnection();
        }}
      >
        Refresh
      </sp-button>
      <sp-button
        variant="negative"
        ?disabled=${_busy}
        @click=${() => {
          void disconnect();
        }}
      >
        Disconnect
      </sp-button>
    </div>
  `;
}

function bodyTpl() {
  if (!platformSupportsPublish()) {
    return html`
      <p>
        This platform cannot reach the Cloudflare API. Publish by committing and pushing — your host
        builds <code>bunx jx build</code> and serves <code>dist/</code>.
      </p>
    `;
  }
  if (_connection === "loading") {
    return html`<p>Checking Cloudflare connection…</p>`;
  }
  // Before the credential template, and that order is the fix: a lapsed row is `connected: true`,
  // So neither branch below could ever have claimed it.
  if (_connection?.connected && _connection.needsReconnect) {
    return lapsedTpl();
  }
  if (!_connection?.connected) {
    return credentialTpl();
  }
  const deploy = currentDeploy();
  return deploy ? statusTpl(deploy) : connectFormTpl();
}

function errorTpl() {
  if (!_error) {
    return "";
  }
  const needsPagesApp = /github/i.test(_error) && /app|install|source|repo/i.test(_error);
  return html`
    <p class="publish-error">
      ${_error}
      ${
        needsPagesApp
          ? html` — if the Cloudflare Pages GitHub App is not installed on the repository,
              <a href=${PAGES_APP_INSTALL_URL} target="_blank" rel="noreferrer">install it</a> and
              retry.`
          : ""
      }
    </p>
  `;
}

function render(): void {
  const tpl = html`
    <div class="new-project-modal publish-modal" data-jx-region="overlay.dialog:publish">
      <div class="new-project-modal-header">
        <h2 class="new-project-modal-title">Publish</h2>
        <sp-action-button size="s" quiet @click=${close}>✕</sp-action-button>
      </div>
      <div class="new-project-modal-body">${bodyTpl()} ${errorTpl()}</div>
    </div>
  `;
  if (_handle) {
    _handle.update(tpl);
  } else {
    _handle = openModal(tpl, { label: "Publish", onDismiss: close });
  }
}

/**
 * Automation-only seam (scripts/screenshots): open the modal directly in its connected state with a
 * canned deployment, bypassing {@link loadConnection} so no Cloudflare request ever fires. The
 * active project's `build.deploy` block still supplies the connected project/URL line.
 */
export function seedPublishConnected(options: {
  accountId?: string;
  deployment: PagesDeploymentInfo;
}): void {
  _connection = { accountId: options.accountId ?? "demo-account", connected: true };
  _accounts = [];
  _deployment = options.deployment;
  noteDeployment(options.deployment);
  _error = "";
  _busy = false;
  _replacing = false;
  render();
}

/** Open the publish modal for the active project. */
export function openPublishPanel(): void {
  const config = currentConfig();
  const { owner, repo } = prefillRepo();
  _connection = "loading";
  _accounts = [];
  _deployment = null;
  _error = "";
  _busy = false;
  _replacing = false;
  _form = {
    accountId: "",
    branch: "main",
    owner,
    projectName: currentDeploy()?.projectName ?? deriveSlug(config?.name ?? ""),
    repo,
  };
  render();
  void loadConnection();
}
