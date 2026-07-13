/// <reference lib="dom" />
/**
 * Add Existing Repository modal — a filterable picker over `platform.listRepos` (every repo the
 * platform's account link can reach, personal and organization). Choosing a repo runs
 * `platform.importProject`, which adopts it as a Jx project (probes project.json, tags + catalogues
 * it) and resolves with the catalogue root key; the caller opens it through the same path as a
 * recent project. Repos without a project.json fail with the backend's structured message, shown
 * inline.
 */

import { html, nothing } from "lit-html";
import { errorMessage } from "@jxsuite/schema/parse";
import { getPlatform } from "../platform";
import { openModal } from "../ui/layers";
import type { RepoInfo } from "../types";

let _handle: ReturnType<typeof openModal> | null = null;
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

/** Open the picker. Resolves with the imported project's catalogue root key, or null when cancelled. */
export function openAddRepoModal(): Promise<{ root: string } | null> {
  if (_handle) {
    return Promise.resolve(null);
  }
  _repos = null;
  _filter = "";
  _error = "";
  _importing = "";

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
      renderModal();
    });

  return new Promise((resolve) => {
    _resolve = resolve;
    renderModal();
  });
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
  const repos = _repos ?? [];
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
      ${_importing === repo.fullName
        ? html`<span class="add-repo-busy">Importing…</span>`
        : nothing}
    </button>
  `;
}

function bodyTpl() {
  if (_repos === null) {
    return html`<div class="add-repo-empty">Loading repositories…</div>`;
  }
  const repos = visibleRepos();
  if (repos.length === 0) {
    return html`<div class="add-repo-empty">
      ${_filter
        ? "No repositories match the filter."
        : "No repositories are reachable. Install the GitHub App (or widen its repository access) and try again."}
    </div>`;
  }
  return html`<div class="add-repo-list">${repos.map((repo) => repoRowTpl(repo))}</div>`;
}

function renderModal() {
  const tpl = html`
    <sp-underlay open @close=${closeAddRepoModal}></sp-underlay>
    <div
      class="new-project-modal add-repo-modal"
      @keydown=${(e: KeyboardEvent) => {
        if (e.key === "Escape") {
          closeAddRepoModal();
        }
      }}
    >
      <div class="new-project-modal-header">
        <h2 class="new-project-modal-title">Add existing repository</h2>
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
      </div>
    </div>
  `;
  if (_handle) {
    _handle.update(tpl);
  } else {
    _handle = openModal(tpl);
  }
}
