/// <reference lib="dom" />
/**
 * Publish panel — the one-click Cloudflare Pages publish flow, driven by the
 * PAL's cf* members. States: unsupported platform → info; no credential →
 * connect (hosted OAuth via cfConnect, or an API-token form backed by
 * cf-settings); connected without `build.deploy` → create-and-connect form;
 * connected → deployment status (publishing rides every commit).
 *
 * @license MIT
 */

import { html } from "lit-html";
import type { DeployConfig, ProjectConfig } from "@jxsuite/schema/types";
import { getPlatform } from "../platform";
import { getCfToken, setCfToken } from "../services/cf-settings";
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
let _form = { accountId: "", branch: "main", owner: "", projectName: "", repo: "" };

function currentConfig(): ProjectConfig | null {
  return (projectState?.projectConfig as ProjectConfig | undefined) ?? null;
}

function currentDeploy(): DeployConfig | undefined {
  return currentConfig()?.build?.deploy;
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

/** Prefill owner/repo from cloud roots ("owner/repo"); blank elsewhere. */
function prefillRepo(): { owner: string; repo: string } {
  const root = getPlatform().projectRoot;
  const match = /^([\w.-]+)\/([\w.-]+)$/.exec(root);
  return match ? { owner: match[1]!, repo: match[2]! } : { owner: "", repo: "" };
}

async function loadConnection(): Promise<void> {
  _connection = "loading";
  render();
  try {
    _connection = (await getPlatform().cfConnection?.()) ?? null;
    if (_connection?.connected) {
      _accounts = await listAccounts();
      _form.accountId = _connection.accountId ?? _accounts[0]?.id ?? "";
      const deploy = currentDeploy();
      if (deploy) {
        _deployment = await latestDeployment(deploy);
      }
    }
  } catch (error) {
    _connection = null;
    _error = error instanceof Error ? error.message : String(error);
  }
  render();
}

async function saveToken(host: HTMLElement): Promise<void> {
  const input = host.querySelector<HTMLInputElement>("#cf-token-input");
  setCfToken(input?.value ?? "");
  _error = "";
  await loadConnection();
}

async function hostedConnect(): Promise<void> {
  _busy = true;
  render();
  try {
    await getPlatform().cfConnect?.();
  } catch (error) {
    _error = error instanceof Error ? error.message : String(error);
  }
  _busy = false;
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

function credentialTpl() {
  const platform = getPlatform();
  if (platform.cfConnect) {
    return html`
      <p>Connect your Cloudflare account to publish this site.</p>
      <sp-button ?disabled=${_busy} @click=${() => void hostedConnect()}>
        Connect Cloudflare
      </sp-button>
    `;
  }
  return html`
    <p>
      Paste a Cloudflare API token (permissions: Account Settings Read, Pages Read/Write). It is
      stored locally and only sent to the same-origin proxy.
    </p>
    ${fieldRow(
      "API token",
      html`<sp-textfield
        id="cf-token-input"
        type="password"
        value=${getCfToken()}
        placeholder="cf_..."
      ></sp-textfield>`,
    )}
    <sp-button ?disabled=${_busy} @click=${(e: Event) => void saveToken(hostOf(e))}>
      Verify & Connect
    </sp-button>
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
    <sp-button ?disabled=${_busy} @click=${() => void submitConnect()}>
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
      <sp-button variant="secondary" ?disabled=${_busy} @click=${() => void loadConnection()}>
        Refresh
      </sp-button>
      <sp-button variant="negative" ?disabled=${_busy} @click=${() => void disconnect()}>
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
    <div class="new-project-modal publish-modal">
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
  _error = "";
  _busy = false;
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
