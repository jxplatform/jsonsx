/// <reference lib="dom" />
/**
 * Repository picker modal — a filterable picker over `platform.listRepos` (every repo the
 * platform's account link can reach, personal and organization). Two modes share the dialog:
 *
 * - "add" (Add Existing Repository): the unfiltered adoption path.
 * - "open" (Open Project on `openProjectPicker: "repo-list"` platforms): only write-access
 *   repositories, Jx-tagged ones first.
 *
 * Choosing a repo runs `platform.importProject`, which adopts it as a Jx project (probes
 * project.json, tags + catalogues it) and resolves with the catalogue root key; the caller opens it
 * through the same path as a recent project. Repos without a project.json fail with the backend's
 * structured message, shown inline.
 *
 * The list only ever shows what the Jx Suite GitHub App can reach, so the dialog also carries an
 * access footer: per-installation links to widen the App's repository selection, a link to install
 * it on another account, and Refresh — the user grants access in a GitHub tab, comes back, and
 * reloads the list without losing the dialog.
 */

import { html, nothing } from "lit-html";
import { errorMessage } from "@jxsuite/schema/parse";
import {
  getAccountStatus,
  getRepoAccessLinks,
  hydrateAccountStatus,
  needsAppInstall,
} from "../account-status";
import { getPlatform } from "../platform";
import { openModal } from "../ui/layers";
import type { RepoInfo } from "../types";

type PickerMode = "add" | "open";

let _handle: ReturnType<typeof openModal> | null = null;
let _mode: PickerMode = "add";
let _repos: RepoInfo[] | null = null;
let _filter = "";
let _error = "";
/** FullName of the repo currently importing ("" = idle). */
let _importing = "";
let _resolve: ((result: { root: string } | null) => void) | null = null;

/** True when the active platform can browse + adopt existing repositories. */
export function platformSupportsAddRepo(): boolean {
  const platform = getPlatform();
  return typeof platform.listRepos === "function" && typeof platform.importProject === "function";
}

/** True when the active platform routes Open Project through this repo picker. */
export function platformUsesRepoPicker(): boolean {
  return getPlatform().openProjectPicker === "repo-list" && platformSupportsAddRepo();
}

/**
 * Open the adoption picker. Resolves with the imported project's catalogue root key, or null when
 * cancelled.
 */
export function openAddRepoModal(): Promise<{ root: string } | null> {
  return openPicker("add");
}

/** Open Project as a repo picker (write-access repositories only). Null when cancelled. */
export function openProjectPickerModal(): Promise<{ root: string } | null> {
  return openPicker("open");
}

function openPicker(mode: PickerMode): Promise<{ root: string } | null> {
  if (_handle) {
    return Promise.resolve(null);
  }
  _mode = mode;
  _filter = "";
  _importing = "";

  loadRepos();

  return new Promise((resolve) => {
    _resolve = resolve;
    renderModal();
  });
}

/**
 * (Re)load the repository list and the App's installation coverage. Both feed the same question —
 * "which repositories can Jx see?" — so a refresh after a permission change re-reads both.
 */
function loadRepos(): void {
  _repos = null;
  _error = "";
  // Paints the loading state on a refresh; a no-op on open, where the caller renders next.
  renderIfOpen();

  void hydrateAccountStatus().then(renderIfOpen);

  void getPlatform()
    .listRepos?.()
    .then((repos) => {
      _repos = repos;
    })
    .catch((error: unknown) => {
      _repos = [];
      _error = errorMessage(error);
    })
    .finally(() => {
      renderIfOpen();
    });
}

/** Render only while the dialog is still up — a load settling after close must not reopen it. */
function renderIfOpen(): void {
  if (_resolve) {
    renderModal();
  }
}

export function closeAddRepoModal() {
  if (!_handle || _importing) {
    return;
  }
  _handle.close();
  _handle = null;
  if (_resolve) {
    _resolve(null);
    _resolve = null;
  }
}

function finish(result: { root: string }) {
  _importing = "";
  if (_handle) {
    _handle.close();
    _handle = null;
  }
  if (_resolve) {
    _resolve(result);
    _resolve = null;
  }
}

async function chooseRepo(repo: RepoInfo) {
  if (_importing) {
    return;
  }
  _importing = repo.fullName;
  _error = "";
  renderModal();
  try {
    const imported = await getPlatform().importProject?.({ name: repo.name, owner: repo.owner });
    if (imported) {
      finish(imported);
      return;
    }
    _error = "This platform cannot import repositories.";
  } catch (error) {
    _error = errorMessage(error);
  }
  _importing = "";
  renderModal();
}

function visibleRepos(): RepoInfo[] {
  const query = _filter.trim().toLowerCase();
  let repos = _repos ?? [];
  if (_mode === "open") {
    // Open Project offers only repos the user can write to; Jx-tagged repos surface first.
    // The topic is an accelerator, not ground truth — untagged repos still open via importProject.
    const writable = repos.filter((r) => r.permission === "admin" || r.permission === "write");
    repos = [...writable.filter((r) => r.isJxProject), ...writable.filter((r) => !r.isJxProject)];
  }
  return query ? repos.filter((r) => r.fullName.toLowerCase().includes(query)) : repos;
}

function repoRowTpl(repo: RepoInfo) {
  return html`
    <button
      class="add-repo-row"
      ?disabled=${Boolean(_importing)}
      title=${repo.fullName}
      @click=${() => void chooseRepo(repo)}
    >
      <span class="add-repo-name">${repo.fullName}</span>
      <span class="add-repo-meta">
        ${repo.isJxProject ? html`<span class="add-repo-badge">Jx</span>` : nothing}
        ${repo.private ? html`<span class="add-repo-badge">private</span>` : nothing}
        <span>${repo.defaultBranch} · ${repo.permission}</span>
      </span>
      ${
        _importing === repo.fullName ? html`<span class="add-repo-busy">Importing…</span>` : nothing
      }
    </button>
  `;
}

function emptyTpl() {
  if (_filter) {
    return html`<div class="add-repo-empty">No repositories match the filter.</div>`;
  }
  if (_mode === "open" && (_repos ?? []).length > 0) {
    return html`<div class="add-repo-empty">
      No repositories with write access. Widen the Jx Suite GitHub App's repository access below, or
      ask a repository admin for write access.
    </div>`;
  }
  if (needsAppInstall()) {
    return html`<div class="add-repo-empty">
      No repositories are reachable yet.
      <a
        class="add-repo-install"
        href=${getAccountStatus()?.appInstallUrl ?? "#"}
        target="_blank"
        rel="noreferrer"
      >
        Install the Jx Suite GitHub App
      </a>
      to grant repository access, then use Refresh below.
    </div>`;
  }
  return html`<div class="add-repo-empty">
    No repositories are reachable. Install the GitHub App (or widen its repository access) and try
    again.
  </div>`;
}

function bodyTpl() {
  if (_repos === null) {
    return html`<div class="add-repo-empty">Loading repositories…</div>`;
  }
  const repos = visibleRepos();
  if (repos.length === 0) {
    return emptyTpl();
  }
  return html`<div class="add-repo-list">${repos.map((repo) => repoRowTpl(repo))}</div>`;
}

/**
 * Repository-access footer: the list is bounded by what the Jx Suite App was granted, so every mode
 * offers a way out of that boundary — widen an existing installation, install on another account,
 * then Refresh to pick up the newly reachable repositories.
 */
function accessTpl() {
  const links = getRepoAccessLinks();
  if (!links) {
    return nothing;
  }
  return html`
    <div class="add-repo-access">
      <span class="add-repo-access-note">
        Missing a repository? Grant the Jx Suite GitHub App access to more of them:
      </span>
      <span class="add-repo-access-links">
        ${links.manage.map(
          (entry) => html`
            <a
              class="add-repo-access-link"
              href=${entry.url}
              target="_blank"
              rel="noreferrer"
              title="Manage repository access for ${entry.account}"
            >
              ${entry.account}
            </a>
          `,
        )}
        ${
          links.installUrl
            ? html`<a
                class="add-repo-access-link"
                href=${links.installUrl}
                target="_blank"
                rel="noreferrer"
                title="Install the Jx Suite GitHub App on another account"
              >
                Another account…
              </a>`
            : nothing
        }
      </span>
      <button
        class="add-repo-refresh"
        ?disabled=${_repos === null || Boolean(_importing)}
        @click=${() => loadRepos()}
      >
        Refresh
      </button>
    </div>
  `;
}

function renderModal() {
  const tpl = html`
    <sp-underlay open @close=${closeAddRepoModal}></sp-underlay>
    <div class="new-project-modal add-repo-modal">
      <div class="new-project-modal-header">
        <h2 class="new-project-modal-title">
          ${_mode === "open" ? "Open Project" : "Add existing repository"}
        </h2>
        <sp-action-button quiet size="s" @click=${closeAddRepoModal} title="Close">
          <sp-icon-close slot="icon"></sp-icon-close>
        </sp-action-button>
      </div>
      <div class="new-project-modal-body">
        <sp-textfield
          class="add-repo-filter"
          placeholder="Filter repositories…"
          value=${_filter}
          @input=${(e: Event) => {
            _filter = (e.target as HTMLInputElement).value;
            renderModal();
          }}
        ></sp-textfield>
        ${bodyTpl()} ${_error ? html`<div class="new-project-error">${_error}</div>` : nothing}
        ${accessTpl()}
      </div>
    </div>
  `;
  if (_handle) {
    _handle.update(tpl);
  } else {
    _handle = openModal(tpl, {
      label: _mode === "open" ? "Open Project" : "Add existing repository",
      onDismiss: closeAddRepoModal,
    });
  }
}
