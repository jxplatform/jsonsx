/**
 * Git panel — Source control sidebar with status, staging, commit, push/pull, and branch
 * management.
 */

import { html, nothing } from "lit-html";
import { live } from "lit-html/directives/live.js";
import { repeat } from "lit-html/directives/repeat.js";
import { getPlatform } from "../platform.js";
import { updateUi, renderOnly } from "../store.js";
import { activeTab } from "../workspace/workspace.js";
import { view } from "../view.js";

async function refreshGitStatus() {
  const plat = getPlatform();
  updateUi("gitLoading", true);
  updateUi("gitError", null);
  try {
    const [status, branches] = await Promise.all([plat.gitStatus(), plat.gitBranches()]);
    updateUi("gitStatus", status);
    updateUi("gitBranches", branches);
  } catch (/** @type {any} */ e) {
    updateUi("gitError", e.message);
  } finally {
    updateUi("gitLoading", false);
    renderOnly("leftPanel");
  }
}

/**
 * @param {string} action
 * @param {any} [body]
 */
async function gitAction(action, body) {
  const plat = getPlatform();
  updateUi("gitLoading", true);
  updateUi("gitError", null);
  try {
    await plat[action](body);
    await refreshGitStatus();
  } catch (/** @type {any} */ e) {
    updateUi("gitError", e.message);
    updateUi("gitLoading", false);
    renderOnly("leftPanel");
  }
}

let _pollTimer = /** @type {any} */ (null);

/**
 * @param {any} S
 * @param {any} ctx
 */
export function renderGitPanel(S, ctx) {
  const status = S.ui.gitStatus;
  const branches = S.ui.gitBranches;
  const loading = S.ui.gitLoading;

  if (!status && !loading) {
    refreshGitStatus();
    return html`<div class="git-panel"><div class="git-loading">Loading...</div></div>`;
  }

  if (!_pollTimer) {
    _pollTimer = setInterval(() => {
      if (view.leftTab === "git" && !S.ui.gitLoading) refreshGitStatus();
    }, 30000);
  }

  const stagedFiles = status?.files?.filter((/** @type {any} */ f) => f.staged) || [];
  const unstagedFiles = status?.files?.filter((/** @type {any} */ f) => !f.staged) || [];
  const totalChanges = status?.files?.length || 0;

  const doCommit = async () => {
    const tab = activeTab.value;
    const msg = tab?.session.ui.gitCommitMessage?.trim();
    if (!msg) return;
    updateUi("gitCommitMessage", "");
    await gitAction("gitCommit", msg);
  };

  const branchPickerT = html`
    <sp-picker
      size="s"
      quiet
      class="git-branch-picker"
      .value=${live(branches?.current || "")}
      @change=${async (/** @type {any} */ e) => {
        const val = e.target.value;
        if (val === "__new__") {
          e.target.value = branches?.current || "";
          const name = prompt("New branch name:");
          if (name?.trim()) await gitAction("gitCreateBranch", name.trim());
          return;
        }
        if (val !== branches?.current) await gitAction("gitCheckout", val);
      }}
    >
      ${(branches?.branches || []).map(
        (/** @type {string} */ b) => html`<sp-menu-item value=${b}>${b}</sp-menu-item>`,
      )}
      <sp-menu-divider></sp-menu-divider>
      <sp-menu-item value="__new__">+ New branch...</sp-menu-item>
    </sp-picker>
  `;

  const toolbarT = html`
    <div class="git-toolbar">
      ${branchPickerT}
      <sp-action-group size="xs" quiet>
        <sp-action-button title="Fetch" @click=${() => gitAction("gitFetch")} ?disabled=${loading}>
          <sp-icon-download slot="icon" size="xs"></sp-icon-download>
        </sp-action-button>
        <sp-action-button
          title="Pull${status?.behind ? ` (${status.behind} behind)` : ""}"
          @click=${() => gitAction("gitPull")}
          ?disabled=${loading}
        >
          <sp-icon-arrow-down slot="icon" size="xs"></sp-icon-arrow-down>
        </sp-action-button>
        <sp-action-button
          title="Push${status?.ahead ? ` (${status.ahead} ahead)` : ""}"
          @click=${() => gitAction("gitPush")}
          ?disabled=${loading}
        >
          <sp-icon-arrow-up slot="icon" size="xs"></sp-icon-arrow-up>
        </sp-action-button>
        <sp-action-button title="Refresh" @click=${() => refreshGitStatus()} ?disabled=${loading}>
          <sp-icon-refresh slot="icon" size="xs"></sp-icon-refresh>
        </sp-action-button>
      </sp-action-group>
    </div>
  `;

  const commitT = html`
    <div class="git-commit-area">
      <sp-textfield
        size="s"
        multiline
        class="git-commit-input"
        placeholder='Message (Ctrl+Enter to commit on "${status?.branch || ""}")'
        .value=${live(S.ui.gitCommitMessage || "")}
        @input=${(/** @type {any} */ e) => updateUi("gitCommitMessage", e.target.value)}
        @keydown=${(/** @type {any} */ e) => {
          if (e.ctrlKey && e.key === "Enter") {
            e.preventDefault();
            doCommit();
          }
        }}
      ></sp-textfield>
      <sp-action-button class="git-commit-btn" @click=${doCommit} ?disabled=${loading}>
        <sp-icon-checkmark slot="icon" size="xs"></sp-icon-checkmark>
        Commit
      </sp-action-button>
    </div>
  `;

  const fileRowT = (/** @type {any} */ file) => {
    const parts = file.path.split("/");
    const name = parts.pop();
    const dir = parts.join("/");

    const onFileClick = async () => {
      if (file.status !== "M" && file.status !== "A") return;
      if (!file.path.endsWith(".md") && !file.path.endsWith(".json")) return;

      try {
        const plat = getPlatform();
        updateUi("gitLoading", true);

        const [originalContent, currentContent] = await Promise.all([
          file.status === "A"
            ? Promise.resolve("")
            : plat.gitShow({ path: file.path, ref: "HEAD" }),
          plat.readFile(file.path),
        ]);

        const isMarkdown = file.path.endsWith(".md");
        const diffState = {
          filePath: file.path,
          originalContent,
          currentContent,
          isMarkdown,
          fileStatus: file.status,
        };

        updateUi("gitDiffState", diffState);

        if (ctx?.setCanvasMode) {
          if (ctx.setGitDiffState) ctx.setGitDiffState(diffState);
          ctx.setCanvasMode("git-diff");
        }
      } catch (/** @type {any} */ e) {
        updateUi("gitError", `Failed to load diff: ${e.message}`);
      } finally {
        updateUi("gitLoading", false);
      }
    };

    return html`
      <div class="git-file-row">
        <span
          class="git-file-info"
          style="cursor: pointer; flex: 1;"
          title="Click to view diff"
          @click=${onFileClick}
        >
          <span class="git-file-name" title=${file.path}>${name}</span>
          ${dir ? html`<span class="git-file-dir">${dir}</span>` : nothing}
        </span>
        <span class="git-file-actions">
          ${file.staged
            ? html`
                <sp-action-button
                  size="xs"
                  quiet
                  title="Unstage"
                  @click=${() => gitAction("gitUnstage", [file.path])}
                >
                  <sp-icon-remove slot="icon" size="xs"></sp-icon-remove>
                </sp-action-button>
              `
            : html`
                <sp-action-button
                  size="xs"
                  quiet
                  title="Discard changes"
                  @click=${async () => {
                    if (file.status === "U") return;
                    if (!confirm(`Discard changes to ${file.path}?`)) return;
                    await gitAction("gitDiscard", [file.path]);
                  }}
                  ?disabled=${file.status === "U"}
                >
                  <sp-icon-undo slot="icon" size="xs"></sp-icon-undo>
                </sp-action-button>
                <sp-action-button
                  size="xs"
                  quiet
                  title="Stage"
                  @click=${() => gitAction("gitStage", [file.path])}
                >
                  <sp-icon-add slot="icon" size="xs"></sp-icon-add>
                </sp-action-button>
              `}
        </span>
        <span class="git-file-badge git-status-${file.status}">${file.status}</span>
      </div>
    `;
  };

  const changesT = html`
    ${stagedFiles.length > 0
      ? html`
          <div class="git-section">
            <div class="git-section-header">
              <span>Staged Changes</span>
              <span class="git-count">${stagedFiles.length}</span>
              <sp-action-button
                size="xs"
                quiet
                title="Unstage all"
                @click=${() =>
                  gitAction(
                    "gitUnstage",
                    stagedFiles.map((/** @type {any} */ f) => f.path),
                  )}
              >
                <sp-icon-remove slot="icon" size="xs"></sp-icon-remove>
              </sp-action-button>
            </div>
            ${repeat(stagedFiles, (/** @type {any} */ f) => f.path, fileRowT)}
          </div>
        `
      : nothing}
    ${unstagedFiles.length > 0
      ? html`
          <div class="git-section">
            <div class="git-section-header">
              <span>Changes</span>
              <span class="git-count">${unstagedFiles.length}</span>
              <sp-action-button
                size="xs"
                quiet
                title="Stage all"
                @click=${() =>
                  gitAction(
                    "gitStage",
                    unstagedFiles.map((/** @type {any} */ f) => f.path),
                  )}
              >
                <sp-icon-add slot="icon" size="xs"></sp-icon-add>
              </sp-action-button>
            </div>
            ${repeat(unstagedFiles, (/** @type {any} */ f) => f.path, fileRowT)}
          </div>
        `
      : nothing}
    ${totalChanges === 0 && !loading ? html`<div class="git-empty">No changes</div>` : nothing}
  `;

  const syncInfoT =
    status?.ahead || status?.behind
      ? html`
          <div class="git-sync-info">
            ${status.ahead ? html`<span title="Commits ahead">↑${status.ahead}</span>` : nothing}
            ${status.behind ? html`<span title="Commits behind">↓${status.behind}</span>` : nothing}
          </div>
        `
      : nothing;

  return html`
    <div class="git-panel">
      ${toolbarT} ${syncInfoT} ${commitT}
      ${loading ? html`<div class="git-loading">Loading...</div>` : nothing}
      ${S.ui.gitError ? html`<div class="git-error">${S.ui.gitError}</div>` : nothing} ${changesT}
    </div>
  `;
}

export function cleanupGitPanel() {
  if (_pollTimer) {
    clearInterval(_pollTimer);
    _pollTimer = null;
  }
}
