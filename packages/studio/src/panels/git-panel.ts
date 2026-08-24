/// <reference lib="dom" />
/**
 * Git panel — Source control sidebar with sync status, branch selector, Local Changes / History
 * tabs, commit form, and changed-components view.
 */

import { html, nothing } from "lit-html";
import { errorMessage } from "@jxsuite/schema/parse";
import { flushAllCollab } from "../collab/collab-session";
import type { GitDiffState, GitFileStatus, StudioPlatform } from "../types";
import { live } from "lit-html/directives/live.js";
import { repeat } from "lit-html/directives/repeat.js";
import { getPlatform } from "../platform";
import { now } from "../services/clock";
import { formatForPath } from "../format/format-host";
import { projectState, renderOnly } from "../store";
import { activeTab } from "../workspace/workspace";
import type { Tab } from "../tabs/tab";
import { shell } from "../shell";
import type { GitLogEntry } from "../shell";
import { showConfirmDialog, showPromptDialog } from "../ui/layers";
import { POLL_GIT } from "../ui/timing";
import { renderEmptyState } from "./empty-state";
import { registerPanel } from "./panel-registry";
import { notify } from "../services/notify";
import { authenticateGithub } from "../github/github-auth";
import { createGithubRepository } from "../github/github-publish";
import { pullWithPackageSync } from "../packages/pull-package-sync";
import type { AnyCommand, CommandRegistry } from "../commands/registry";

type GitFileEntry = GitFileStatus;

export async function refreshGitStatus() {
  if (!projectState) {
    return;
  }
  const plat = getPlatform();
  const { git } = shell;
  git.loading = true;
  git.error = null;
  try {
    // Settled independently, not Promise.all: outside a work tree `git branch` exits non-zero
    // While `git status` answers cleanly with isRepo:false. Letting the branch lookup reject the
    // Pair discarded that status, so the panel re-rendered its "no status yet" branch, refreshed
    // Again, and span — a request per render for as long as the tab stayed open.
    const [status, branches] = await Promise.allSettled([plat.gitStatus(), plat.gitBranches()]);
    if (status.status === "fulfilled") {
      git.status = status.value;
    }
    if (branches.status === "fulfilled") {
      git.branches = branches.value;
    }
    // A branch lookup that fails on a repo-less project is expected, not an error worth showing;
    // Anything else (including a failed status) surfaces.
    const failure: unknown =
      status.status === "rejected"
        ? status.reason
        : branches.status === "rejected" && status.value?.isRepo
          ? branches.reason
          : null;
    if (failure) {
      git.error = errorMessage(failure);
    }
    git.lastUpdated = now();
  } catch (error) {
    git.error = errorMessage(error);
  } finally {
    git.loading = false;
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
    notify.warn("Cloning is not supported on this platform.", { source: "Source Control" });
    return;
  }

  const url = await showPromptDialog("Clone Git Repository", {
    confirmLabel: "Clone",
    message: "Repository URL",
    placeholder: "https://github.com/user/repo.git",
    validate: (v) => (v.trim() ? "" : "Enter a repository URL."),
  });

  if (!url) {
    return;
  }

  try {
    notify.info("Cloning repository…", { key: "git.clone", source: "Source Control" });
    const result = await platform.gitClone(url);
    if (result?.root) {
      notify.success("Clone complete.", { key: "git.clone" });
      await ctx.openRecentProject(result.root);
    }
  } catch (error) {
    notify.error("Could not clone the repository.", {
      detail: errorMessage(error),
      key: "git.clone",
      source: "Source Control",
    });
  }
}

/** @returns {boolean} */
export function platformSupportsClone() {
  return Boolean(getPlatform().gitClone);
}

/**
 * One file's comparison against HEAD: the committed text and the working copy.
 *
 * **One definition site, because there are now two callers.** This panel's row click has always
 * made this pair of reads; `workspace/pane-derive.ts`'s Diff lens needs the same answer for the
 * document its source pane is showing, and it must not reach `shell.git.diffState` — that slot
 * holds whatever THIS panel last opened, which is a different file (§18.4, finding 4). A second
 * copy of these five lines is how the panel and the lens would come to disagree about what "the
 * diff of this file" means, which is the rule {@link initRepository} is written under too.
 *
 * `A` (added) has no `HEAD` copy, so its original is the empty string rather than a `gitShow` that
 * would throw. Callers narrow to `M`/`A` before asking.
 *
 * @param {string} path
 * @param {string} fileStatus
 * @returns {Promise<GitDiffState>}
 */
export async function readGitDiff(path: string, fileStatus: string): Promise<GitDiffState> {
  const plat = getPlatform();
  const [originalContent, currentContent] = await Promise.all([
    fileStatus === "A" ? Promise.resolve("") : plat.gitShow({ path, ref: "HEAD" }),
    plat.readFile(path),
  ]);
  return { currentContent, filePath: path, fileStatus, originalContent };
}

/**
 * The Diff lens's reader: {@link readGitDiff}, with a failure the PANE can state.
 *
 * A rejection here is not an error the shell should raise — the author asked to see a comparison
 * beside their page, and "could not read it" is a sentence the derived pane draws in its own empty
 * state. `applyDerivation` turns the `null` into exactly that.
 *
 * @param {string} path
 * @param {string} fileStatus
 * @returns {Promise<GitDiffState | null>}
 */
export async function loadDiffForLens(
  path: string,
  fileStatus: string,
): Promise<GitDiffState | null> {
  try {
    return await readGitDiff(path, fileStatus);
  } catch (error) {
    // Reported where it can be acted on — the pane says so — rather than as a toast over a
    // Document the author did not ask about.
    console.warn("loadDiffForLens:", errorMessage(error));
    return null;
  }
}

/**
 * Start tracking this project with git.
 *
 * A function rather than an inline click handler because it is now also a command ({@link
 * sourceControlCommands}) and the first step of the deploy checklist, and three call sites of the
 * same three lines is how the panel and the palette come to disagree about what a verb does.
 */
export async function initRepository(): Promise<void> {
  try {
    notify.info("Initializing repository…", { key: "git.init" });
    await getPlatform().gitInit();
    notify.success("Repository initialized.", { key: "git.init" });
  } catch (error) {
    notify.error("Could not initialize the repository.", {
      action: "git.init",
      detail: errorMessage(error),
      key: "git.init",
      source: "Source Control",
    });
    return;
  }
  await refreshGitStatus();
}

/** Push the current branch. Same loading/error contract as every other panel verb. */
export async function pushCurrentBranch(): Promise<void> {
  await gitAction("gitPush");
}

/**
 * Sign in to GitHub, or report why it could not.
 *
 * The report belongs to `github/github-auth.ts` — this only says what a SUCCESS was, which that
 * module cannot, because it is also called mid-flow by "Create GitHub Repository" where a toast
 * saying "Signed in" in front of a half-finished operation would be noise.
 */
export async function signInToGithub(): Promise<void> {
  const token = await authenticateGithub();
  if (token) {
    notify.success("Signed in to GitHub.", { key: "github.auth" });
  }
}

/**
 * @param {string} action
 * @param {unknown} [body]
 */
async function gitAction(action: string, body?: unknown) {
  const plat = getPlatform() as Record<string, (...args: unknown[]) => Promise<unknown>> &
    StudioPlatform;
  shell.git.loading = true;
  shell.git.error = null;
  try {
    await plat[action]!(body);
    await refreshGitStatus();
  } catch (error) {
    shell.git.error = errorMessage(error);
    shell.git.loading = false;
  }
}

/** Pull via the package-aware orchestrator; same loading/error contract as gitAction. */
async function doPull() {
  shell.git.loading = true;
  shell.git.error = null;
  try {
    await pullWithPackageSync();
    await refreshGitStatus();
  } catch (error) {
    shell.git.error = errorMessage(error);
    shell.git.loading = false;
  }
}

/**
 * The background refresh handle. The interval itself is infrastructure, not state — the sub-tab and
 * the "last updated" stamp it used to sit beside are on `shell.git`, so opening a second project no
 * longer inherits the first one's History selection and timestamp.
 */
let _pollTimer = null as ReturnType<typeof setInterval> | null;

/**
 * Whether the commit button's split menu is showing.
 *
 * State rather than a `hidden` attribute toggled on a node found by selector. The two were fighting
 * by construction: the template declared the menu `hidden` unconditionally, so lit had committed
 * that attribute, and every repaint of the panel — the 30-second git poll among them — would leave
 * whatever the handler had last done to it standing, with no way for the template to take it back.
 */
let _splitMenuOpen = false;

async function fetchGitLog() {
  const plat = getPlatform();
  try {
    shell.git.logEntries = await plat.gitLog(30);
  } catch (error) {
    shell.git.error = errorMessage(error);
  }
}

/**
 * Render the Source Control panel.
 *
 * Takes no state argument: everything it reads is project-level and lives on `shell.git`, which is
 * the whole point of the hoist — the panel renders identically with no document open.
 *
 * @param {{
 *   setCanvasMode?: (tab: Tab | null, mode: string) => void;
 *   setGitDiffState?: (state: GitDiffState | null) => void;
 *   cloneRepository?: () => void;
 * }} ctx
 */
export function renderGitPanel(ctx: {
  setCanvasMode?: (tab: Tab | null, mode: string) => void;
  setGitDiffState?: (state: GitDiffState | null) => void;
  cloneRepository?: () => void;
}) {
  if (!projectState) {
    return html`<div class="git-panel git-panel-empty">
      ${renderEmptyState({
        actions: platformSupportsClone()
          ? [
              {
                icon: html`<sp-icon-download slot="icon"></sp-icon-download>`,
                label: "Clone Git Repository",
                run: () => ctx.cloneRepository?.(),
              },
            ]
          : [],
        message:
          "Source control keeps every version of a project, so any change can be undone. " +
          "Open a project to see its history.",
      })}
    </div>`;
  }
  const { branches, loading, status } = shell.git;

  // First paint kicks off the fetch. A refresh that already failed must NOT re-arm it here, or the
  // Render it triggers becomes the next render's reason to fetch again; the Refresh button and the
  // Poll timer are the ways back.
  if (!status && !loading && !shell.git.error) {
    void refreshGitStatus();
    return html`<div class="git-panel">
      <div class="git-loading">Loading...</div>
    </div>`;
  }

  if (status && !status.isRepo) {
    return html`<div class="git-panel git-panel-empty">
      ${renderEmptyState({
        actions: [
          {
            disabled: Boolean(loading),
            icon: html`<sp-icon-add slot="icon"></sp-icon-add>`,
            label: "Initialize Repository",
            run: () => {
              void initRepository();
            },
          },
          {
            disabled: Boolean(loading),
            icon: html`<sp-icon-share slot="icon"></sp-icon-share>`,
            label: "Create GitHub repository",
            run: () => {
              void createGithubRepository({ projectName: projectState?.name || "my-project" });
            },
          },
        ],
        message:
          "This project is not tracked by git yet. Start tracking it to keep a history " +
          "of every change and to publish it anywhere.",
      })}
    </div>`;
  }

  if (!_pollTimer) {
    _pollTimer = setInterval(() => {
      if (shell.leftTab === "git" && !shell.git.loading) {
        void refreshGitStatus();
      }
    }, POLL_GIT);
  }

  const stagedFiles = status?.files?.filter((f: GitFileEntry) => f.staged) || [];
  const unstagedFiles = status?.files?.filter((f: GitFileEntry) => !f.staged) || [];
  const totalChanges = status?.files?.length || 0;

  const doCommit = async () => {
    const msg = shell.git.commitMessage.trim();
    if (!msg) {
      return;
    }
    shell.git.commitMessage = "";
    // Fold co-editing sessions into the backend's tree first so the commit never misses
    // Trailing keystrokes (the mirror is debounced).
    await flushAllCollab();
    await gitAction("gitCommit", msg);
  };

  const doCommitAndSync = async () => {
    const msg = shell.git.commitMessage.trim();
    if (!msg) {
      return;
    }
    shell.git.commitMessage = "";
    shell.git.loading = true;
    shell.git.error = null;
    await flushAllCollab();
    const plat = getPlatform();
    try {
      await plat.gitCommit(msg);
      await plat.gitPush();
      await refreshGitStatus();
    } catch (error) {
      shell.git.error = errorMessage(error);
      shell.git.loading = false;
    }
  };

  // ─── 1. Sync status bar ──────────────────────────────────────────────────
  const isUpToDate = !status?.ahead && !status?.behind;
  const syncLabel = isUpToDate
    ? "Up to date"
    : `${status?.ahead ? `${status.ahead} ahead` : ""}${status?.ahead && status?.behind ? ", " : ""}${status?.behind ? `${status.behind} behind` : ""}`;
  const lastUpdatedStr = shell.git.lastUpdated
    ? new Date(shell.git.lastUpdated).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      })
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
            ${
              lastUpdatedStr
                ? html`<span class="git-sync-time">Last updated ${lastUpdatedStr}</span>`
                : nothing
            }
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
              @click=${() => {
                void doPull();
              }}
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
            @click=${() =>
              createGithubRepository({
                projectName: projectState?.name || "my-project",
              })}
            ?disabled=${loading}
          >
            <sp-icon-share slot="icon"></sp-icon-share>
            Create GitHub repository
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
            const name = await showPromptDialog("New Branch", {
              confirmLabel: "Create",
              message: `Branching from ${branches?.current || status?.branch || "the current branch"}.`,
              placeholder: "feature/my-change",
              validate: (v) => (v.trim() ? "" : "Enter a branch name."),
            });
            if (name) {
              await gitAction("gitCreateBranch", name);
            }
            return;
          }
          if (val !== branches?.current) {
            await gitAction("gitCheckout", val);
          }
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
    shell.git.subTab = tab;
    if (tab === "history" && !shell.git.logEntries) {
      void fetchGitLog();
    }
  };

  const tabsT = html`
    <div class="git-tabs">
      <button
        class="git-tab ${shell.git.subTab === "changes" ? "active" : ""}"
        @click=${() => switchTab("changes")}
      >
        Local Changes${totalChanges > 0 ? ` (${totalChanges})` : ""}
      </button>
      <button
        class="git-tab ${shell.git.subTab === "history" ? "active" : ""}"
        @click=${() => switchTab("history")}
      >
        History
      </button>
    </div>
  `;

  // ─── 4. Commit form ──────────────────────────────────────────────────────
  // `navigator/panel:git/commit` is a HAND-STAMPED leaf: the panel host derives
  // `navigator/panel:git`, but nothing derives the parts inside a panel body. Leaves are the one
  // Category of region id that is authored, and they are counted for exactly that reason.
  const commitT = html`
    <div class="git-commit-area" data-jx-region="navigator/panel:git/commit">
      <label class="git-commit-label">Please write a commit message</label>
      <sp-textfield
        size="s"
        multiline
        class="git-commit-input"
        placeholder="Describe your changes"
        .value=${live(shell.git.commitMessage)}
        @input=${(e: Event) => {
          shell.git.commitMessage = (e.target as HTMLInputElement).value;
        }}
        @keydown=${(e: KeyboardEvent) => {
          if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
            e.preventDefault();
            void doCommit();
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
            @click=${() => {
              _splitMenuOpen = !_splitMenuOpen;
              renderOnly("leftPanel");
            }}
          >
            <sp-icon-chevron-down slot="icon" size="xs"></sp-icon-chevron-down>
          </sp-action-button>
          <div class="git-split-menu" ?hidden=${!_splitMenuOpen}>
            <button
              class="git-split-menu-item"
              @click=${() => {
                _splitMenuOpen = false;
                void doCommit();
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
      if (file.status !== "M" && file.status !== "A") {
        return;
      }
      if (!file.path.endsWith(".json") && !formatForPath(file.path)) {
        return;
      }

      try {
        shell.git.loading = true;

        const diffState = await readGitDiff(file.path, file.status);

        shell.git.diffState = diffState;

        if (ctx?.setCanvasMode) {
          if (ctx.setGitDiffState) {
            ctx.setGitDiffState(diffState);
          }
          ctx.setCanvasMode(activeTab.value, "git-diff");
        }
      } catch (error) {
        shell.git.error = `Failed to load diff: ${errorMessage(error)}`;
      } finally {
        shell.git.loading = false;
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
          ${
            file.staged
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
                      if (file.status === "U") {
                        return;
                      }
                      const confirmed = await showConfirmDialog(
                        "Discard Changes",
                        `Discard changes to ${file.path}?`,
                        { confirmLabel: "Discard", destructive: true },
                      );
                      if (!confirmed) {
                        return;
                      }
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
                `
          }
        </span>
        <span class="git-file-badge git-status-${file.status}">${file.status}</span>
      </div>
    `;
  };

  /** Group files by component (parent directory for .json/.class.json, or "Other") */
  const groupFilesByComponent = (files: GitFileEntry[]) => {
    const groups = new Map<string, GitFileEntry[]>();
    for (const f of files) {
      const parts = f.path.split("/");
      let component;
      if (f.path.endsWith(".json") || f.path.endsWith(".class.json") || formatForPath(f.path)) {
        component = parts.length > 1 ? `/${parts.at(-2)}` : `/${parts[0]}`;
      } else {
        component = "Other";
      }
      if (!groups.has(component)) {
        groups.set(component, []);
      }
      (groups.get(component) as GitFileEntry[]).push(f);
    }
    return groups;
  };

  const allFiles = [...stagedFiles, ...unstagedFiles];
  const componentGroups = groupFilesByComponent(allFiles);

  const changesT = html`
    ${
      stagedFiles.length > 0
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
        : nothing
    }
    <div class="git-section">
      <div class="git-section-header">
        <span>Changed Components</span>
        <span class="git-count">${allFiles.length}</span>
        ${
          unstagedFiles.length > 0
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
            : nothing
        }
      </div>
      ${
        allFiles.length > 0
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
          : renderEmptyState({
              compact: true,
              message: "Nothing to commit. Files you edit and save show up here.",
            })
      }
    </div>
  `;

  // ─── 6. History tab content ──────────────────────────────────────────────
  const logEntries = shell.git.logEntries || [];
  const historyT = html`
    <div class="git-history">
      ${
        logEntries.length === 0
          ? renderEmptyState({
              compact: true,
              message: "No commits yet. Each commit you make is a version you can come back to.",
            })
          : repeat(
              logEntries,
              (e: GitLogEntry) => e.hash,
              (entry: GitLogEntry) => html`
                <div class="git-history-entry">
                  <span class="git-history-hash">${entry.hash.slice(0, 7)}</span>
                  <span class="git-history-message">${entry.message}</span>
                  <span class="git-history-meta"
                    >${entry.author} · ${relativeDate(entry.date)}</span
                  >
                </div>
              `,
            )
      }
    </div>
  `;

  return html`
    <div class="git-panel">
      ${syncBarT} ${branchSelectorT} ${tabsT}
      ${shell.git.subTab === "changes" ? html`${commitT}${changesT}` : historyT}
      ${loading ? html`<div class="git-loading">Loading...</div>` : nothing}
      ${shell.git.error ? html`<div class="git-error">${shell.git.error}</div>` : nothing}
    </div>
  `;
}

/**
 * A commit age, relative to {@link now}.
 *
 * Exported so it is testable at all: reading the wall clock inline meant "yesterday" and the
 * locale-date fallback could only be asserted against an offset from the real present, and two
 * captures minutes apart legitimately disagreed.
 *
 * @param {string} iso
 */
export function relativeDate(iso: string) {
  const d = new Date(iso);
  const diff = now() - d.getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) {
    return "just now";
  }
  if (mins < 60) {
    return `${mins}m ago`;
  }
  const hours = Math.floor(mins / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }
  const days = Math.floor(hours / 24);
  if (days < 30) {
    return `${days}d ago`;
  }
  return d.toLocaleDateString();
}

/**
 * The `Source Control:` family — the four verbs that were only ever buttons.
 *
 * Every one of them was reachable from exactly one place: two from an empty state that disappears
 * the moment the repository exists, one from a 20px icon with a `title` attribute, and the fourth —
 * signing in to GitHub — from nowhere at all, because it only ever happened as a side effect of
 * something else. That is why a failed sign-in had no Retry to name: there was no record to point
 * at. Naming them here gives the palette, `__jxAutomation`, the assistant, the deploy checklist and
 * every `notify` Retry the same four ids.
 *
 * `git.signInToGithub` is `application`-level and the other three are `project`-level, and the
 * split is the credential's: a GitHub token is one per machine and is revoked in Preferences ›
 * Accounts, while a branch, a remote and a push belong to one repository.
 */
export function sourceControlCommands(): AnyCommand[] {
  return [
    {
      category: "Source Control",
      id: "git.init",
      level: "project",
      menus: ["commandbar/overflow", "palette"],
      group: "7_scm",
      requires: "an open project that git is not already tracking",
      when: (ctx) => ctx.project.open,
      // `when` already asked about the project; an `enablement` that re-asks is the same rule
      // Written twice, and the two places drift.
      enablement: (ctx) => !ctx.project.isRepo,
      aiTool: {
        description:
          "Run git init in the project root so the project has a history and can be pushed.",
        name: "init_repository",
      },
      run: async () => {
        await initRepository();
      },
      title: "Initialize Repository",
    },
    {
      category: "Source Control",
      id: "git.createGithubRepository",
      level: "project",
      menus: ["commandbar/overflow", "palette"],
      group: "7_scm",
      /* THE STRICTEST OF THE THREE, because it is the one that leaves something behind on a
         server. It declared no `enablement` at all while `git.push` — which does strictly less —
         required a tracked repository, so on an untracked project Push was correctly disabled and
         this was fully live from the palette, the overflow, the deploy checklist and the
         `create_github_repository` AI tool. Its flow creates the repository on GitHub BEFORE it
         touches the local one, so `gitAddRemote` then throws and it reports "The repository was
         created, but the remote could not be added." The refused verb leaves nothing behind; the
         unrefused one leaves an empty repository on the user's account. */
      requires: "a project tracked by git",
      when: (ctx) => ctx.project.open,
      enablement: (ctx) => ctx.project.isRepo,
      aiTool: {
        description:
          "Create a new GitHub repository for this project, add it as the origin remote, and push. " +
          "This creates a repository; it does not deploy a site — that is publish.setUp.",
        name: "create_github_repository",
      },
      run: async () => {
        await createGithubRepository({ projectName: projectState?.name || "my-project" });
      },
      title: "Create GitHub Repository",
    },
    {
      category: "Source Control",
      id: "git.push",
      level: "project",
      menus: ["commandbar/overflow", "palette"],
      group: "7_scm",
      requires: "a project tracked by git",
      when: (ctx) => ctx.project.open,
      enablement: (ctx) => ctx.project.isRepo,
      aiTool: {
        description: "Push the current branch to its remote.",
        name: "git_push",
      },
      run: async () => {
        await pushCurrentBranch();
      },
      title: "Push",
    },
    {
      category: "Source Control",
      id: "git.signInToGithub",
      level: "application",
      menus: ["palette"],
      group: "7_scm",
      run: async () => {
        await signInToGithub();
      },
      title: "Sign In to GitHub",
    },
  ];
}

/** Register the `Source Control:` family. */
export function registerSourceControlCommands(registry: CommandRegistry): void {
  registry.registerAll(sourceControlCommands());
}

/** Stop the background refresh. Called on unmount and whenever a different project is opened. */
export function cleanupGitPanel() {
  if (_pollTimer) {
    clearInterval(_pollTimer);
    _pollTimer = null;
  }
}

/**
 * Contribute the Source Control panel.
 *
 * `level: "project"` — a branch, a working tree and a commit belong to the repository, not to
 * whichever document happens to be focused. That is why the badge below reads `ctx.git.dirtyCount`
 * (sourced from the hoisted `shell.git` record) and why this panel's render ignores `ctx.doc`
 * entirely: the count used to come from `activeTab.session.ui.gitStatus`, so it vanished when the
 * last tab closed and two tabs could disagree about the branch.
 */
export function registerGitPanel(): void {
  registerPanel({
    id: "git",
    title: "Source Control",
    level: "project",
    dock: "navigator",
    // A KEY into `activity-bar.ts`'s `tabIcon()` map, not a tag: this one resolves to
    // `gitBranchIcon`, a hand-drawn inline SVG, because the workflow set has no Git family.
    icon: "sp-icon-git-branch",
    badge: (ctx) => ctx.git.dirtyCount || null,
    // Through `deps`, not the local binding: `studio.ts` owns the wiring (the clone action and the
    // Diff-state setter come from the bootstrap), and the Navigator has injected it all along.
    render: (ctx) => ctx.deps.renderGitPanel(ctx.deps),
  });
}
