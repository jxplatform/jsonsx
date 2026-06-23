/// <reference lib="dom" />
/**
 * About modal — shows app version, build metadata, external links, the resolved `@jxsuite/*`
 * package versions, and (on desktop) the release channel / update status.
 *
 * Build metadata comes from src/version.ts (injected at bundle time). Package versions are fetched
 * lazily via the platform; desktop update info is shown only when the active platform implements
 * the optional `getAppInfo` method.
 */

import { html } from "lit-html";
import type { TemplateResult } from "lit-html";
import { openModal } from "../ui/layers";
import { getPlatform } from "../platform";
import { APP_NAME, BUILD_DATE, GIT_COMMIT, LINKS, VERSION } from "../version";
import type { AppInfo, PackageInfo } from "../types";

let _handle: ReturnType<typeof openModal> | null = null;

let _packages: PackageInfo[] | null = null;
let _appInfo: AppInfo | null = null;

export function openAboutModal() {
  if (_handle) {
    return;
  }
  _packages = null;
  _appInfo = null;
  renderModal();
  void loadDetails();
}

export function closeAboutModal() {
  if (!_handle) {
    return;
  }
  _handle.close();
  _handle = null;
  _packages = null;
  _appInfo = null;
}

async function loadDetails() {
  const platform = getPlatform();
  try {
    _packages = await platform.listPackages();
  } catch {
    _packages = [];
  }
  if (platform.getAppInfo) {
    try {
      _appInfo = await platform.getAppInfo();
    } catch {
      _appInfo = null;
    }
  }
  if (_handle) {
    renderModal();
  }
}

function formatBuildDate(iso: string) {
  if (!iso) {
    return "—";
  }
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}

function metaRows() {
  const rows: [string, string][] = [
    ["Version", VERSION],
    ["Build date", formatBuildDate(BUILD_DATE)],
    ["Commit", GIT_COMMIT],
  ];
  if (_appInfo) {
    rows.push(["Channel", _appInfo.channel]);
    if (_appInfo.updateStatus) {
      rows.push(["Updates", _appInfo.updateStatus]);
    }
  }
  return rows;
}

function renderPackages(): TemplateResult {
  if (_packages === null) {
    return html`<p class="about-muted">Loading packages…</p>`;
  }
  if (_packages.length === 0) {
    return html`<p class="about-muted">No packages reported.</p>`;
  }
  return html`
    <ul class="about-packages">
      ${_packages.map(
        (p) => html`
          <li class="about-package-row">
            <span class="about-package-name">${p.name}</span>
            <span class="about-package-version">${p.version}</span>
          </li>
        `,
      )}
    </ul>
  `;
}

function renderModal() {
  const tpl = html`
    <sp-underlay open @close=${closeAboutModal}></sp-underlay>
    <div
      class="about-modal"
      role="dialog"
      aria-label="About ${APP_NAME}"
      @keydown=${(e: KeyboardEvent) => {
        if (e.key === "Escape") {
          closeAboutModal();
        }
      }}
    >
      <div class="settings-modal-header">
        <h2 class="settings-modal-title">About ${APP_NAME}</h2>
        <sp-action-button quiet size="s" @click=${closeAboutModal} title="Close">
          <sp-icon-close slot="icon"></sp-icon-close>
        </sp-action-button>
      </div>
      <div class="about-modal-body">
        <dl class="about-meta">
          ${metaRows().map(
            ([label, value]) => html`
              <div class="about-meta-row">
                <dt class="about-meta-label">${label}</dt>
                <dd class="about-meta-value">${value}</dd>
              </div>
            `,
          )}
        </dl>

        <div class="about-links">
          <a href=${LINKS.github} target="_blank" rel="noreferrer noopener">GitHub</a>
          <a href=${LINKS.docs} target="_blank" rel="noreferrer noopener">Documentation</a>
          <a href=${LINKS.license} target="_blank" rel="noreferrer noopener">License</a>
        </div>

        <section class="about-section">
          <h3 class="about-section-title">Packages</h3>
          ${renderPackages()}
        </section>
      </div>
    </div>
  `;

  if (_handle) {
    _handle.update(tpl);
  } else {
    _handle = openModal(tpl);
  }
}
