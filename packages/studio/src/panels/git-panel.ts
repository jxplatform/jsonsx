/// <reference lib="dom" />
/**
 * Git panel — Source control sidebar with sync status, branch selector, Local Changes / History
 * tabs, commit form, and changed-components view.
 */

import { html, nothing } from "lit-html";
import { live } from "lit-html/directives/live.js";
import { repeat } from "lit-html/directives/repeat.js";
import { getPlatform } from "../platform";
import { updateUi, renderOnly, projectState } from "../store";
import { activeTab } from "../workspace/workspace";
import { view } from "../view";
import { showDialog, showConfirmDialog } from "../ui/layers";
import { statusMessage } from "./statusbar";
import { publishToGithub } from "../github/github-publish";
import type { StudioPlatform } from "../types";

interface GitFileEntry {
  path: string;
  status: string;
  staged: boolean;
}

interface GitLogEntry {
  hash: string;
  message: string;
  author: string;
  date: string;
}

interface GitUiState {
  gitStatus?: {
    files?: GitFileEntry[];
    branch?: string;
    ahead?: number;
    behind?: number;
    isRepo?: boolean;
    remotes?: string[];
  } | null;
  gitBranches?: { current?: string; branches?: string[] } | null;
  gitLoading?: boolean;
  gitError?: string | null;
  gitCommitMessage?: string;
  gitLogEntries?: GitLogEntry[] | null;
  [key: string]: unknown;
}

export async function refreshGitStatus() {
  if (!projectState) return;
  const plat = getPlatform();
  updateUi("gitLoading", true);
  updateUi("gitError", null);
  try {
    const [status, branches] = await Promise.all([plat.gitStatus(), plat.gitBranches()]);
    updateUi("gitStatus", status);
    updateUi("gitBranches", branches);
    _lastUpdated = new Date();
  } catch (e) {
    updateUi("gitError", (e as Error).message);
  } finally {
    updateUi("gitLoading", false);
    renderOnly("leftPanel");
  }
}

/**
 * Show a dialog to clone a git repository. Returns the cloned project root on success, or null.
 *
 * @param {{ openRecentProject: (root: string) => Promise<void> }} ctx
 */
export async function cloneRepository(ctx: { openRecentProject: (root: string) => Promise<void> }) {
  const platform = getPlatform();
  if (!platform.gitClone) {
    statusMessage("Clone not supported on this platform");
    return;
  }

  const url = await showDialog<string | null>(
    (done) => html`
      <sp-underlay open @close=${() => done(null)}></sp-underlay>
      <sp-dialog-wrapper
        headline="Clone Git Repository"
        confirmLabel="Clone"
        cancelLabel="Cancel"
        open
        @confirm=${(e: Event) => {
          const input = ((e.target as HTMLElement).parentElement as HTMLElement).querySelector(
            "sp-textfield",
          ) as HTMLInputElement | null;
          done(input?.value?.trim() || null);
        }}
        @cancel=${() => done(null)}
        @close=${() => done(null)}
      >
        <sp-textfield
          label="Repository URL"
          placeholder="https://github.com/user/repo.git"
          style="width: 100%"
          autofocus
        ></sp-textfield>
      </sp-dialog-wrapper>
    `,
  );

  if (!url) return;

  try {
    statusMessage("Cloning repository...");
    const result = await platform.gitClone(url);
    if (result?.root) {
      statusMessage("Clone complete");
      await ctx.openRecentProject(result.root);
    }
  } catch (e) {
    statusMessage(`Clone failed: ${(e as Error).message}`);
  }
}

/** @returns {boolean} */
export function platformSupportsClone() {
  return !!getPlatform().gitClone;
}

/**
 * @param {string} action
 * @param {unknown} [body]
 */
async function gitAction(action: string, body?: unknown) {
  const plat = getPlatform() as Record<string, Function> & StudioPlatform;
  updateUi("gitLoading", true);
  updateUi("gitError", null);
  try {
    await plat[action](body);
    await refreshGitStatus();
  } catch (e) {
    updateUi("gitError", (e as Error).message);
    updateUi("gitLoading", false);
    renderOnly("leftPanel");
  }
}

let _pollTimer = null as ReturnType<typeof setInterval> | null;
let _lastUpdated = null as Date | null;
let _gitSubTab = "changes";

async function fetchGitLog() {
  const plat = getPlatform();
  try {
    const entries = await plat.gitLog(30);
    updateUi("gitLogEntries", entries);
    renderOnly("leftPanel");
  } catch (e) {
    updateUi("gitError", (e as Error).message);
    renderOnly("leftPanel");
  }
}

/**
 * @param {{ ui: GitUiState }} S
 * @param {{
 *   setCanvasMode?: (mode: string) => void;
 *   setGitDiffState?: (state: unknown) => void;
 *   cloneRepository?: () => void;
 * }} ctx
 */
export function renderGitPanel(
  S: { ui: GitUiState },
  ctx: {
    setCanvasMode?: (mode: string) => void;
    setGitDiffState?: (state: unknown) => void;
    cloneRepository?: () => void;
  },
) {
  if (!projectState) {
    return html`<div class="git-panel git-panel-empty">
      <div class="git-empty-state">
        <p>Open a project to use source control.</p>
        ${platformSupportsClone()
          ? html`<sp-action-button size="m" @click=${() => ctx.cloneRepository?.()}>
              <sp-icon-download slot="icon"></sp-icon-download>
              Clone Git Repository
            </sp-action-button>`
          : nothing}
      </div>
    </div>`;
  }
  const status = S.ui.gitStatus;
  const branches = S.ui.gitBranches;
  const loading = S.ui.gitLoading;

  if (!status && !loading) {
    refreshGitStatus();
    return html`<div class="git-panel"><div class="git-loading">Loading...</div></div>`;
  }

  if (status && !status.isRepo) {
    return html`<div class="git-panel git-panel-empty">
      <div class="git-empty-state">
        <p>This project is not yet a git repository.</p>
        <sp-action-button
          size="m"
          @click=${async () => {
            statusMessage("Initializing repository…");
            await getPlatform().gitInit();
            statusMessage("Repository initialized");
            await refreshGitStatus();
          }}
          ?disabled=${loading}
        >
          <sp-icon-add slot="icon"></sp-icon-add>
          Initialize Repository
        </sp-action-button>
        <sp-action-button
          size="m"
          @click=${() => publishToGithub({ projectName: projectState?.name || "my-project" })}
          ?disabled=${loading}
        >
          <sp-icon-share slot="icon"></sp-icon-share>
          Publish to GitHub
        </sp-action-button>
      </div>
    </div>`;
  }

  if (!_pollTimer) {
    _pollTimer = setInterval(() => {
      if (view.leftTab === "git" && !S.ui.gitLoading) refreshGitStatus();
    }, 30000);
  }

  const stagedFiles = status?.files?.filter((f: GitFileEntry) => f.staged) || [];
  const unstagedFiles = status?.files?.filter((f: GitFileEntry) => !f.staged) || [];
  const totalChanges = status?.files?.length || 0;

  const doCommit = async () => {
    const tab = activeTab.value;
    const msg = tab?.session.ui.gitCommitMessage?.trim();
    if (!msg) return;
    updateUi("gitCommitMessage", "");
    await gitAction("gitCommit", msg);
  };

  const doCommitAndSync = async () => {
    const tab = activeTab.value;
    const msg = tab?.session.ui.gitCommitMessage?.trim();
    if (!msg) return;
    updateUi("gitCommitMessage", "");
    updateUi("gitLoading", true);
    updateUi("gitError", null);
    const plat = getPlatform();
    try {
      await plat.gitCommit(msg);
      await plat.gitPush();
      await refreshGitStatus();
    } catch (e) {
      updateUi("gitError", (e as Error).message);
      updateUi("gitLoading", false);
      renderOnly("leftPanel");
    }
  };

  // ─── 1. Sync status bar ──────────────────────────────────────────────────
  const isUpToDate = !status?.ahead && !status?.behind;
  const syncLabel = isUpToDate
    ? "Up to date"
    : `${status?.ahead ? `${status.ahead} ahead` : ""}${status?.ahead && status?.behind ? ", " : ""}${status?.behind ? `${status.behind} behind` : ""}`;
  const lastUpdatedStr = _lastUpdated
    ? _lastUpdated.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : "";

  const hasRemotes = (status?.remotes?.length ?? 0) > 0;

  const syncBarT = hasRemotes
    ? html`
        <div class="git-sync-bar">
          <sp-action-button
            size="s"
            quiet
            class="git-sync-icon"
            title="Refresh"
            @click=${() => refreshGitStatus()}
            ?disabled=${loading}
          >
            <sp-icon-refresh slot="icon"></sp-icon-refresh>
          </sp-action-button>
          <div class="git-sync-text">
            <span class="git-sync-label">${syncLabel}</span>
            ${lastUpdatedStr
              ? html`<span class="git-sync-time">Last updated ${lastUpdatedStr}</span>`
              : nothing}
          </div>
          <sp-action-group size="xs" quiet class="git-sync-actions">
            <sp-action-button
              title="Fetch"
              @click=${() => gitAction("gitFetch")}
              ?disabled=${loading}
            >
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
          </sp-action-group>
        </div>
      `
    : html`
        <div class="git-sync-bar git-sync-bar--no-remote">
          <sp-action-button
            size="s"
            quiet
            class="git-sync-icon"
            title="Refresh"
            @click=${() => refreshGitStatus()}
            ?disabled=${loading}
          >
            <sp-icon-refresh slot="icon"></sp-icon-refresh>
          </sp-action-button>
          <div class="git-sync-text">
            <span class="git-sync-label">Local only (no remote)</span>
          </div>
          <sp-action-button
            size="s"
            @click=${() => publishToGithub({ projectName: projectState?.name || "my-project" })}
            ?disabled=${loading}
          >
            <sp-icon-share slot="icon"></sp-icon-share>
            Publish to GitHub
          </sp-action-button>
        </div>
      `;

  // ─── 2. Branch selector ──────────────────────────────────────────────────
  const branchSelectorT = html`
    <div class="git-branch-row">
      <svg
        class="git-branch-icon"
        xmlns="http://www.w3.org/2000/svg"
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        <line x1="6" y1="3" x2="6" y2="15"></line>
        <circle cx="18" cy="6" r="3"></circle>
        <circle cx="6" cy="18" r="3"></circle>
        <path d="M18 9a9 9 0 0 1-9 9"></path>
      </svg>
      <div class="git-branch-text">
        <span class="git-branch-label">Active branch</span>
        <span class="git-branch-name">${branches?.current || status?.branch || "—"}</span>
      </div>
      <sp-picker
        size="s"
        quiet
        class="git-branch-picker"
        .value=${live(branches?.current || "")}
        @change=${async (e: Event) => {
          const val = (e.target as HTMLInputElement).value;
          if (val === "__new__") {
            (e.target as HTMLInputElement).value = branches?.current || "";
            const name = prompt("New branch name:");
            if (name?.trim()) await gitAction("gitCreateBranch", name.trim());
            return;
          }
          if (val !== branches?.current) await gitAction("gitCheckout", val);
        }}
      >
        ${(branches?.branches || []).map(
          (b: string) => html`<sp-menu-item value=${b}>${b}</sp-menu-item>`,
        )}
        <sp-menu-divider></sp-menu-divider>
        <sp-menu-item value="__new__">+ New branch...</sp-menu-item>
      </sp-picker>
    </div>
  `;

  // ─── 3. Tabs: Local Changes / History ────────────────────────────────────
  const switchTab = (tab: string) => {
    _gitSubTab = tab;
    if (tab === "history" && !S.ui.gitLogEntries) fetchGitLog();
    renderOnly("leftPanel");
  };

  const tabsT = html`
    <div class="git-tabs">
      <button
        class="git-tab ${_gitSubTab === "changes" ? "active" : ""}"
        @click=${() => switchTab("changes")}
      >
        Local Changes${totalChanges > 0 ? ` (${totalChanges})` : ""}
      </button>
      <button
        class="git-tab ${_gitSubTab === "history" ? "active" : ""}"
        @click=${() => switchTab("history")}
      >
        History
      </button>
    </div>
  `;

  // ─── 4. Commit form ──────────────────────────────────────────────────────
  const commitT = html`
    <div class="git-commit-area">
      <label class="git-commit-label">Please write a commit message</label>
      <sp-textfield
        size="s"
        multiline
        class="git-commit-input"
        placeholder="Describe your changes"
        .value=${live(S.ui.gitCommitMessage || "")}
        @input=${(e: Event) => updateUi("gitCommitMessage", (e.target as HTMLInputElement).value)}
        @keydown=${(e: KeyboardEvent) => {
          if (e.ctrlKey && e.key === "Enter") {
            e.preventDefault();
            doCommit();
          }
        }}
      ></sp-textfield>
      <div class="git-commit-actions">
        <div class="git-split-btn">
          <sp-action-button
            class="git-commit-btn"
            size="s"
            @click=${doCommitAndSync}
            ?disabled=${loading}
          >
            Commit and sync
          </sp-action-button>
          <sp-action-button
            class="git-split-trigger"
            size="s"
            @click=${(e: Event) => {
              const menu = (
                (e.currentTarget as HTMLElement).parentElement as HTMLElement
              ).querySelector(".git-split-menu");
              if (menu) menu.toggleAttribute("hidden");
            }}
          >
            <sp-icon-chevron-down slot="icon" size="xs"></sp-icon-chevron-down>
          </sp-action-button>
          <div class="git-split-menu" hidden>
            <button
              class="git-split-menu-item"
              @click=${(e: Event) => {
                ((e.currentTarget as HTMLElement).parentElement as HTMLElement).setAttribute(
                  "hidden",
                  "",
                );
                doCommit();
              }}
            >
              Commit (don't sync)
            </button>
          </div>
        </div>
      </div>
    </div>
  `;

  // ─── 5. Changed Components ───────────────────────────────────────────────
  const fileRowT = (file: GitFileEntry) => {
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
      } catch (e) {
        updateUi("gitError", `Failed to load diff: ${(e as Error).message}`);
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
                    const confirmed = await showConfirmDialog(
                      "Discard Changes",
                      `Discard changes to ${file.path}?`,
                      { confirmLabel: "Discard", destructive: true },
                    );
                    if (!confirmed) return;
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

  /** Group files by component (parent directory for .json/.class.json, or "Other") */
  const groupFilesByComponent = (files: GitFileEntry[]) => {
    const groups: Map<string, GitFileEntry[]> = new Map();
    for (const f of files) {
      const parts = f.path.split("/");
      let component;
      if (f.path.endsWith(".json") || f.path.endsWith(".class.json") || f.path.endsWith(".md")) {
        component = parts.length > 1 ? `/${parts[parts.length - 2]}` : `/${parts[0]}`;
      } else {
        component = "Other";
      }
      if (!groups.has(component)) groups.set(component, []);
      (groups.get(component) as GitFileEntry[]).push(f);
    }
    return groups;
  };

  const allFiles = [...stagedFiles, ...unstagedFiles];
  const componentGroups = groupFilesByComponent(allFiles);

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
                    stagedFiles.map((f: GitFileEntry) => f.path),
                  )}
              >
                <sp-icon-remove slot="icon" size="xs"></sp-icon-remove>
              </sp-action-button>
            </div>
            ${repeat(stagedFiles, (f: GitFileEntry) => f.path, fileRowT)}
          </div>
        `
      : nothing}
    <div class="git-section">
      <div class="git-section-header">
        <span>Changed Components</span>
        <span class="git-count">${allFiles.length}</span>
        ${unstagedFiles.length > 0
          ? html`
              <sp-action-button
                size="xs"
                quiet
                title="Stage all"
                @click=${() =>
                  gitAction(
                    "gitStage",
                    unstagedFiles.map((f: GitFileEntry) => f.path),
                  )}
              >
                <sp-icon-add slot="icon" size="xs"></sp-icon-add>
              </sp-action-button>
            `
          : nothing}
      </div>
      ${allFiles.length > 0
        ? html`
            ${[...componentGroups.entries()].map(
              ([comp, files]) => html`
                <div class="git-component-group">
                  <div class="git-component-header">
                    <sp-action-button
                      size="xs"
                      quiet
                      class="git-component-overflow"
                      title="Actions"
                    >
                      <sp-icon-more slot="icon" size="xs"></sp-icon-more>
                    </sp-action-button>
                    <span class="git-component-name">${comp}</span>
                  </div>
                  ${repeat(files, (f: GitFileEntry) => f.path, fileRowT)}
                </div>
              `,
            )}
          `
        : html`<div class="git-empty">No changes</div>`}
    </div>
  `;

  // ─── 6. History tab content ──────────────────────────────────────────────
  const logEntries = S.ui.gitLogEntries || [];
  const historyT = html`
    <div class="git-history">
      ${logEntries.length === 0
        ? html`<div class="git-empty">No history</div>`
        : repeat(
            logEntries,
            (e: GitLogEntry) => e.hash,
            (entry: GitLogEntry) => html`
              <div class="git-history-entry">
                <span class="git-history-hash">${entry.hash.slice(0, 7)}</span>
                <span class="git-history-message">${entry.message}</span>
                <span class="git-history-meta">${entry.author} · ${_relativeDate(entry.date)}</span>
              </div>
            `,
          )}
    </div>
  `;

  return html`
    <div class="git-panel">
      ${syncBarT} ${branchSelectorT} ${tabsT}
      ${_gitSubTab === "changes" ? html`${commitT}${changesT}` : historyT}
      ${loading ? html`<div class="git-loading">Loading...</div>` : nothing}
      ${S.ui.gitError ? html`<div class="git-error">${S.ui.gitError}</div>` : nothing}
    </div>
  `;
}

/** @param {string} iso */
function _relativeDate(iso: string) {
  const d = new Date(iso);
  const now = Date.now();
  const diff = now - d.getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return d.toLocaleDateString();
}

export function cleanupGitPanel() {
  if (_pollTimer) {
    clearInterval(_pollTimer);
    _pollTimer = null;
  }
}
