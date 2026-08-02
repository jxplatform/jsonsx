/**
 * Gap coverage for src/panels/git-panel.ts — interactive behavior: refreshGitStatus,
 * cloneRepository dialog flow, gitAction error handling, branch switching, commit /
 * commit-and-sync, split menu, file diff clicks, stage/unstage/discard, history tab, poll timer,
 * and cleanup.
 *
 * Complements tests/git-panel-states.test.ts which only asserts static template output.
 */
import "./with-dom.js";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { render as litRender } from "lit-html";

// ─── Controllable module state (captured by mock.module factories) ───────────

let mockPlatform: any;
const activeTabRef: { value: any } = { value: { session: { ui: {} } } };
let calls: [string, ...unknown[]][] = [];
let statusMessages: string[] = [];
let confirmCalls: string[] = [];
let confirmResult = true;
let publishCalls: unknown[] = [];
let dialogHosts: HTMLElement[] = [];
let promptCalls: { headline: string; opts: Record<string, any> }[] = [];
let promptResult: string | null = null;

void mock.module("../src/platform.js", () => ({
  getPlatform: () => mockPlatform,
  hasPlatform: () => true,
  registerPlatform: () => {},
}));

void mock.module("../src/workspace/workspace.js", () => ({
  activeTab: activeTabRef,
  closeAllTabs: () => {},
  closeTab: () => {},
  openTab: () => {},
  renameTab: () => {},
}));

void mock.module("../src/ui/layers.js", () => ({
  // Reached transitively (progress-modal, quick-search); the panel never calls them.
  getLayerSlot: (_kind: string, id: string) => {
    const el = document.createElement("div");
    el.id = id;
    return el;
  },
  openModal: () => Promise.resolve(null),
  showConfirmDialog: async (headline: string) => {
    confirmCalls.push(headline);
    return confirmResult;
  },
  showDialog: (templateFn: any) =>
    new Promise((resolve) => {
      const host = document.createElement("div");
      document.body.append(host);
      dialogHosts.push(host);
      litRender(
        templateFn((value: any) => {
          host.remove();
          resolve(value);
        }),
        host,
      );
    }),
  // The prompt dialog's own rendering/validation is covered in tests/ui-layers-gaps.test.ts; here
  // Only the options the panel passes and how it handles the resolved value matter.
  showPromptDialog: async (headline: string, opts: Record<string, any> = {}) => {
    promptCalls.push({ headline, opts });
    return promptResult;
  },
}));

void mock.module("../src/panels/statusbar.js", () => ({
  statusMessage: (msg: string) => statusMessages.push(msg),
}));

void mock.module("../src/github/github-publish.js", () => ({
  publishToGithub: async (opts: unknown) => {
    publishCalls.push(opts);
    return true;
  },
}));

let pullSyncCalls = 0;
let pullSyncImpl: () => Promise<void> = async () => {};

void mock.module("../src/packages/pull-package-sync.js", () => ({
  autoSyncProjectOnOpen: async () => {},
  isAutomatedPackageDiff: () => false,
  planPackageDiscard: async () => ({ automated: true, discard: [], removeUntracked: [] }),
  pullWithPackageSync: () => {
    pullSyncCalls += 1;
    return pullSyncImpl();
  },
}));

const { setProjectState } = (await import("../src/state.js")) as any;
const { resetProjectShell, shell } = await import("../src/shell.js");
const { cleanupGitPanel, cloneRepository, refreshGitStatus, renderGitPanel } =
  await import("../src/panels/git-panel.js");

// Source control is project state now; `shell.git` is where the panel reads and writes it.
const git = shell.git as unknown as Record<string, any>;

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function flush(turns = 3) {
  for (let i = 0; i < turns; i++) {
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
  }
}

function log(name: string, impl: (...args: any[]) => any) {
  return (...args: any[]) => {
    calls.push([name, ...args]);
    return impl(...args);
  };
}

const baseFiles = () => [
  { path: "src/page.json", staged: false, status: "M" },
  { path: "src/new.json", staged: false, status: "A" },
  { path: "src/gone.json", staged: false, status: "D" },
  { path: "assets/logo.png", staged: false, status: "M" },
  { path: "untracked.txt", staged: false, status: "U" },
  { path: "staged.json", staged: true, status: "M" },
];

function baseStatus(files = baseFiles()) {
  return {
    ahead: 1,
    behind: 2,
    branch: "main",
    files,
    isRepo: true,
    remotes: ["origin"],
  };
}

function freshPlatform(): any {
  return {
    gitBranches: log("gitBranches", async () => ({ branches: ["main", "dev"], current: "main" })),
    gitCheckout: log("gitCheckout", async () => {}),
    gitCommit: log("gitCommit", async () => {}),
    gitCreateBranch: log("gitCreateBranch", async () => {}),
    gitDiscard: log("gitDiscard", async () => {}),
    gitFetch: log("gitFetch", async () => {}),
    gitInit: log("gitInit", async () => {}),
    gitLog: log("gitLog", async () => []),
    gitPull: log("gitPull", async () => {}),
    gitPush: log("gitPush", async () => {}),
    gitShow: log("gitShow", async () => "ORIGINAL"),
    gitStage: log("gitStage", async () => {}),
    gitStatus: log("gitStatus", async () => baseStatus()),
    gitUnstage: log("gitUnstage", async () => {}),
    readFile: log("readFile", async () => "CURRENT"),
  };
}

function seedRepoUi(overrides: Record<string, unknown> = {}) {
  git.branches = { branches: ["main", "dev"], current: "main" };
  git.status = baseStatus();
  Object.assign(git, overrides);
}

function renderPanel(ctx: any = {}) {
  const div = document.createElement("div");
  litRender(renderGitPanel(ctx), div);
  return div;
}

function click(el: Element | null | undefined) {
  expect(el).toBeTruthy();
  el!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
}

function callNames() {
  return calls.map((c) => c[0]);
}

function findButton(div: HTMLElement, text: string) {
  return [...div.querySelectorAll("sp-action-button")].find((b) => b.textContent!.includes(text));
}

function fileRowAction(div: HTMLElement, path: string, title: string) {
  const name = div.querySelector(`.git-file-name[title="${path}"]`);
  expect(name).toBeTruthy();
  return name!.closest(".git-file-row")!.querySelector(`[title="${title}"]`);
}

beforeEach(() => {
  resetProjectShell();
  activeTabRef.value = { session: { ui: {} } };
  calls = [];
  statusMessages = [];
  confirmCalls = [];
  confirmResult = true;
  publishCalls = [];
  promptCalls = [];
  promptResult = null;
  for (const host of dialogHosts) {
    host.remove();
  }
  dialogHosts = [];
  shell.leftTab = "git";
  mockPlatform = freshPlatform();
  pullSyncCalls = 0;
  pullSyncImpl = async () => {};
  setProjectState({ name: "proj" });
  cleanupGitPanel();
});

afterEach(() => {
  cleanupGitPanel();
});

// ─── refreshGitStatus ─────────────────────────────────────────────────────────

describe("refreshGitStatus", () => {
  test("populates status and branches, clears loading", async () => {
    await refreshGitStatus();
    expect(git.status.branch).toBe("main");
    expect(git.branches).toEqual({ branches: ["main", "dev"], current: "main" });
    expect(git.loading).toBe(false);
    expect(git.error).toBeNull();
    expect(callNames()).toContain("gitStatus");
    expect(callNames()).toContain("gitBranches");
  });

  test("records error message on failure", async () => {
    mockPlatform.gitStatus = log("gitStatus", async () => {
      throw new Error("status boom");
    });
    await refreshGitStatus();
    expect(String(git.error)).toContain("status boom");
    expect(git.loading).toBe(false);
  });

  test("does nothing when no project is open", async () => {
    setProjectState(null);
    await refreshGitStatus();
    expect(calls).toEqual([]);
  });

  test("keeps the status when the branch lookup fails on a repo-less project", async () => {
    // `git branch` exits non-zero outside a work tree while `git status` answers isRepo:false.
    mockPlatform.gitStatus = log("gitStatus", async () => ({
      ahead: 0,
      behind: 0,
      branch: "",
      files: [],
      isRepo: false,
      remotes: [],
    }));
    mockPlatform.gitBranches = log("gitBranches", async () => {
      throw new Error("not a git repository");
    });
    await refreshGitStatus();
    expect(git.status.isRepo).toBe(false);
    expect(git.error).toBeNull();
  });

  test("surfaces a branch failure on a project that IS a repo", async () => {
    mockPlatform.gitBranches = log("gitBranches", async () => {
      throw new Error("branches boom");
    });
    await refreshGitStatus();
    expect(git.status.isRepo).toBe(true);
    expect(String(git.error)).toContain("branches boom");
  });
});

// ─── cloneRepository ──────────────────────────────────────────────────────────

describe("cloneRepository", () => {
  const noopCtx = { openRecentProject: async () => {} };

  test("reports unsupported platform when gitClone is missing", async () => {
    await cloneRepository(noopCtx);
    expect(statusMessages).toContain("Clone not supported on this platform");
    expect(promptCalls).toEqual([]);
  });

  test("asks for the URL through the Spectrum prompt dialog", async () => {
    mockPlatform.gitClone = log("gitClone", async () => ({ ok: true, root: "/x" }));
    await cloneRepository(noopCtx);
    expect(promptCalls).toHaveLength(1);
    const { headline, opts } = promptCalls[0]!;
    expect(headline).toBe("Clone Git Repository");
    expect(opts.confirmLabel).toBe("Clone");
    expect(opts.placeholder).toBe("https://github.com/user/repo.git");
    expect(opts.validate("")).toBe("Enter a repository URL.");
    expect(opts.validate("https://github.com/u/r.git")).toBe("");
  });

  test("a confirmed URL clones and opens the project", async () => {
    mockPlatform.gitClone = log("gitClone", async () => ({ ok: true, root: "/tmp/clone" }));
    promptResult = "https://github.com/u/r.git";
    const opened: string[] = [];
    await cloneRepository({
      openRecentProject: async (root: string) => {
        opened.push(root);
      },
    });
    expect(calls).toContainEqual(["gitClone", "https://github.com/u/r.git"]);
    expect(opened).toEqual(["/tmp/clone"]);
    expect(statusMessages).toContain("Cloning repository...");
    expect(statusMessages).toContain("Clone complete");
  });

  test("a dismissed dialog clones nothing", async () => {
    mockPlatform.gitClone = log("gitClone", async () => ({ ok: true, root: "/x" }));
    promptResult = null;
    await cloneRepository(noopCtx);
    expect(callNames()).not.toContain("gitClone");
  });

  test("clone failure surfaces a status message", async () => {
    mockPlatform.gitClone = log("gitClone", async () => {
      throw new Error("denied");
    });
    promptResult = "https://github.com/u/r.git";
    await cloneRepository(noopCtx);
    expect(statusMessages.some((m) => m.includes("Clone failed") && m.includes("denied"))).toBe(
      true,
    );
  });

  test("clone result without root does not open a project", async () => {
    mockPlatform.gitClone = log("gitClone", async () => ({ ok: false, root: "" }));
    promptResult = "https://github.com/u/r.git";
    const opened: string[] = [];
    await cloneRepository({
      openRecentProject: async (root: string) => {
        opened.push(root);
      },
    });
    expect(opened).toEqual([]);
    expect(statusMessages).not.toContain("Clone complete");
  });
});

// ─── Panel bootstrap branches ────────────────────────────────────────────────

describe("panel bootstrap", () => {
  test("no status and not loading triggers a background refresh", async () => {
    const div = renderPanel();
    expect(div.textContent).toContain("Loading...");
    await flush();
    expect(callNames()).toContain("gitStatus");
    expect(git.status.isRepo).toBe(true);
  });

  test("a failed refresh does not re-arm the background fetch", async () => {
    // Otherwise the render triggered by the failure is the next render's reason to fetch again.
    git.error = "status boom";
    const div = renderPanel();
    await flush();
    expect(callNames()).not.toContain("gitStatus");
    expect(div.textContent).toContain("status boom");
  });

  test("initialize repository button runs gitInit and refreshes", async () => {
    git.status = { ahead: 0, behind: 0, branch: "", files: [], isRepo: false, remotes: [] };
    const div = renderPanel();
    click(findButton(div, "Initialize Repository"));
    await flush();
    expect(callNames()).toContain("gitInit");
    expect(callNames()).toContain("gitStatus");
    expect(statusMessages).toContain("Initializing repository…");
    expect(statusMessages).toContain("Repository initialized");
  });

  test("publish button in non-repo state calls publishToGithub with project name", async () => {
    git.status = { ahead: 0, behind: 0, branch: "", files: [], isRepo: false, remotes: [] };
    const div = renderPanel();
    click(findButton(div, "Create GitHub repository"));
    await flush();
    expect(publishCalls).toEqual([{ projectName: "proj" }]);
  });

  test("no-remote sync bar publish falls back to default project name", async () => {
    setProjectState({});
    seedRepoUi();
    git.status.remotes = [];
    const div = renderPanel();
    click(findButton(div, "Create GitHub repository"));
    await flush();
    expect(publishCalls).toEqual([{ projectName: "my-project" }]);
  });

  test("sync bar shows last-updated time after a successful refresh", async () => {
    await refreshGitStatus();
    seedRepoUi();
    const div = renderPanel();
    expect(div.textContent).toContain("Last updated");
  });

  test("an empty file list teaches what lands in the changes tab", () => {
    seedRepoUi();
    git.status.files = [];
    const div = renderPanel();
    expect(div.textContent).toContain("Nothing to commit.");
    expect(div.querySelector('[title="Stage all"]')).toBeNull();
  });

  test("error and loading indicators render from ui state", () => {
    seedRepoUi({ error: "broken pipe", loading: true });
    const div = renderPanel();
    expect(div.querySelector(".git-error")!.textContent).toContain("broken pipe");
    expect(div.textContent).toContain("Loading...");
  });
});

// ─── Sync bar actions + gitAction ────────────────────────────────────────────

describe("sync bar actions", () => {
  test("refresh button re-fetches status", async () => {
    seedRepoUi();
    const div = renderPanel();
    click(div.querySelector('[title="Refresh"]'));
    await flush();
    expect(callNames()).toContain("gitStatus");
  });

  test("fetch, pull, and push buttons dispatch git actions then refresh", async () => {
    seedRepoUi();
    const div = renderPanel();
    click(div.querySelector('[title="Fetch"]'));
    await flush();
    click(div.querySelector('[title^="Pull"]'));
    await flush();
    click(div.querySelector('[title^="Push"]'));
    await flush();
    const names = callNames();
    expect(names).toContain("gitFetch");
    expect(names).toContain("gitPush");
    // Pull goes through the package-aware orchestrator, not a raw platform gitPull.
    expect(pullSyncCalls).toBe(1);
    expect(names).not.toContain("gitPull");
    expect(names.filter((n) => n === "gitStatus").length).toBe(3);
  });

  test("failing pull records error and stops loading", async () => {
    seedRepoUi();
    pullSyncImpl = async () => {
      throw new Error("pull broke");
    };
    const div = renderPanel();
    click(div.querySelector('[title^="Pull"]'));
    await flush();
    expect(pullSyncCalls).toBe(1);
    expect(String(git.error)).toContain("pull broke");
    expect(git.loading).toBe(false);
  });

  test("failing git action records error and stops loading", async () => {
    seedRepoUi();
    mockPlatform.gitFetch = log("gitFetch", async () => {
      throw new Error("net down");
    });
    const div = renderPanel();
    click(div.querySelector('[title="Fetch"]'));
    await flush();
    expect(String(git.error)).toContain("net down");
    expect(git.loading).toBe(false);
  });
});

// ─── Branch selector ─────────────────────────────────────────────────────────

describe("branch selector", () => {
  function changeBranch(div: HTMLElement, value: string) {
    const picker = div.querySelector("sp-picker") as any;
    picker.value = value;
    picker.dispatchEvent(new Event("change", { bubbles: true }));
    return picker;
  }

  test("selecting another branch checks it out", async () => {
    seedRepoUi();
    const div = renderPanel();
    changeBranch(div, "dev");
    await flush();
    expect(calls).toContainEqual(["gitCheckout", "dev"]);
  });

  test("selecting the current branch is a no-op", async () => {
    seedRepoUi();
    const div = renderPanel();
    changeBranch(div, "main");
    await flush();
    expect(callNames()).not.toContain("gitCheckout");
  });

  test("new-branch option opens the prompt dialog and creates the branch", async () => {
    seedRepoUi();
    const div = renderPanel();
    promptResult = "feat-x";
    const picker = changeBranch(div, "__new__");
    await flush();

    expect(picker.value).toBe("main");
    expect(promptCalls).toHaveLength(1);
    const { headline, opts } = promptCalls[0]!;
    expect(headline).toBe("New Branch");
    expect(opts.confirmLabel).toBe("Create");
    expect(opts.message).toContain("main");
    expect(opts.validate("  ")).toBe("Enter a branch name.");
    expect(opts.validate("feat-x")).toBe("");
    expect(calls).toContainEqual(["gitCreateBranch", "feat-x"]);
  });

  test("a dismissed new-branch dialog creates nothing", async () => {
    seedRepoUi();
    const div = renderPanel();
    promptResult = null;
    changeBranch(div, "__new__");
    await flush();
    expect(callNames()).not.toContain("gitCreateBranch");
  });
});

// ─── Commit form ─────────────────────────────────────────────────────────────

describe("commit form", () => {
  test("typing in the message field updates ui state", () => {
    seedRepoUi();
    const div = renderPanel();
    const input = div.querySelector(".git-commit-input") as any;
    input.value = "hello commit";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(git.commitMessage).toBe("hello commit");
  });

  test("Ctrl+Enter commits and clears the message", async () => {
    seedRepoUi({ commitMessage: "  quick fix  " });
    const div = renderPanel();
    const input = div.querySelector(".git-commit-input")!;
    input.dispatchEvent(
      new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        ctrlKey: true,
        key: "Enter",
      }),
    );
    await flush();
    expect(calls).toContainEqual(["gitCommit", "quick fix"]);
    expect(git.commitMessage).toBe("");
    expect(callNames()).toContain("gitStatus");
  });

  test("Cmd+Enter commits on macOS", async () => {
    seedRepoUi({ commitMessage: "mac commit" });
    const div = renderPanel();
    const input = div.querySelector(".git-commit-input")!;
    input.dispatchEvent(
      new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key: "Enter",
        metaKey: true,
      }),
    );
    await flush();
    expect(calls).toContainEqual(["gitCommit", "mac commit"]);
  });

  test("Ctrl+Enter without a message does nothing", async () => {
    seedRepoUi();
    const div = renderPanel();
    div.querySelector(".git-commit-input")!.dispatchEvent(
      new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        ctrlKey: true,
        key: "Enter",
      }),
    );
    await flush();
    expect(callNames()).not.toContain("gitCommit");
  });

  test("commit and sync commits, pushes, then refreshes", async () => {
    seedRepoUi({ commitMessage: "sync msg" });
    const div = renderPanel();
    click(div.querySelector(".git-commit-btn"));
    await flush();
    expect(calls).toContainEqual(["gitCommit", "sync msg"]);
    expect(callNames()).toContain("gitPush");
    expect(callNames()).toContain("gitStatus");
    expect(git.commitMessage).toBe("");
  });

  test("commit and sync without a message does nothing", async () => {
    seedRepoUi();
    const div = renderPanel();
    click(div.querySelector(".git-commit-btn"));
    await flush();
    expect(callNames()).not.toContain("gitCommit");
    expect(callNames()).not.toContain("gitPush");
  });

  test("commit and sync records error when push fails", async () => {
    seedRepoUi({ commitMessage: "doomed" });
    mockPlatform.gitPush = log("gitPush", async () => {
      throw new Error("push boom");
    });
    const div = renderPanel();
    click(div.querySelector(".git-commit-btn"));
    await flush();
    expect(String(git.error)).toContain("push boom");
    expect(git.loading).toBe(false);
  });

  test("split menu toggles and commit-only item commits without pushing", async () => {
    seedRepoUi({ commitMessage: "menu msg" });
    const div = renderPanel();
    const menu = div.querySelector(".git-split-menu")!;
    expect(menu.hasAttribute("hidden")).toBe(true);
    click(div.querySelector(".git-split-trigger"));
    expect(menu.hasAttribute("hidden")).toBe(false);
    click(div.querySelector(".git-split-menu-item"));
    await flush();
    expect(menu.hasAttribute("hidden")).toBe(true);
    expect(calls).toContainEqual(["gitCommit", "menu msg"]);
    expect(callNames()).not.toContain("gitPush");
  });
});

// ─── File rows: diff click, stage, unstage, discard ──────────────────────────

describe("file rows", () => {
  test("clicking a modified .json file loads a diff and switches canvas mode", async () => {
    seedRepoUi();
    const modes: string[] = [];
    const diffs: any[] = [];
    const div = renderPanel({
      setCanvasMode: (m: string) => modes.push(m),
      setGitDiffState: (s: any) => diffs.push(s),
    });
    click(div.querySelector('.git-file-name[title="src/page.json"]'));
    await flush();
    expect(calls).toContainEqual(["gitShow", { path: "src/page.json", ref: "HEAD" }]);
    expect(calls).toContainEqual(["readFile", "src/page.json"]);
    expect(git.diffState).toEqual({
      currentContent: "CURRENT",
      filePath: "src/page.json",
      fileStatus: "M",
      originalContent: "ORIGINAL",
    });
    expect(modes).toEqual(["git-diff"]);
    expect(diffs.length).toBe(1);
    expect(git.loading).toBe(false);
  });

  test("clicking an added file uses an empty original without gitShow", async () => {
    seedRepoUi();
    const div = renderPanel({ setCanvasMode: () => {} });
    click(div.querySelector('.git-file-name[title="src/new.json"]'));
    await flush();
    expect(callNames()).not.toContain("gitShow");
    expect(git.diffState.originalContent).toBe("");
    expect(git.diffState.fileStatus).toBe("A");
  });

  test("diff state is stored even without canvas-mode context", async () => {
    seedRepoUi();
    const div = renderPanel({});
    click(div.querySelector('.git-file-name[title="src/page.json"]'));
    await flush();
    expect(git.diffState.filePath).toBe("src/page.json");
  });

  test("deleted files and non-format files are ignored on click", async () => {
    seedRepoUi();
    const div = renderPanel({});
    click(div.querySelector('.git-file-name[title="src/gone.json"]'));
    click(div.querySelector('.git-file-name[title="assets/logo.png"]'));
    await flush();
    expect(callNames()).not.toContain("gitShow");
    expect(callNames()).not.toContain("readFile");
  });

  test("diff load failure records a friendly error", async () => {
    seedRepoUi();
    mockPlatform.readFile = log("readFile", async () => {
      throw new Error("read fail");
    });
    const div = renderPanel({});
    click(div.querySelector('.git-file-name[title="src/page.json"]'));
    await flush();
    expect(String(git.error)).toContain("Failed to load diff");
    expect(String(git.error)).toContain("read fail");
    expect(git.loading).toBe(false);
  });

  test("discard asks for confirmation then discards", async () => {
    seedRepoUi();
    const div = renderPanel();
    click(fileRowAction(div, "src/page.json", "Discard changes"));
    await flush();
    expect(confirmCalls).toContain("Discard Changes");
    expect(calls).toContainEqual(["gitDiscard", ["src/page.json"]]);
  });

  test("declined confirmation leaves the file alone", async () => {
    seedRepoUi();
    confirmResult = false;
    const div = renderPanel();
    click(fileRowAction(div, "src/page.json", "Discard changes"));
    await flush();
    expect(callNames()).not.toContain("gitDiscard");
  });

  test("untracked files cannot be discarded", async () => {
    seedRepoUi();
    const div = renderPanel();
    click(fileRowAction(div, "untracked.txt", "Discard changes"));
    await flush();
    expect(confirmCalls).toEqual([]);
    expect(callNames()).not.toContain("gitDiscard");
  });

  test("stage and unstage buttons act on single files", async () => {
    seedRepoUi();
    const div = renderPanel();
    click(fileRowAction(div, "src/page.json", "Stage"));
    await flush();
    click(fileRowAction(div, "staged.json", "Unstage"));
    await flush();
    expect(calls).toContainEqual(["gitStage", ["src/page.json"]]);
    expect(calls).toContainEqual(["gitUnstage", ["staged.json"]]);
  });

  test("stage all and unstage all act on the full lists", async () => {
    seedRepoUi();
    const div = renderPanel();
    click(div.querySelector('[title="Stage all"]'));
    await flush();
    click(div.querySelector('[title="Unstage all"]'));
    await flush();
    expect(calls).toContainEqual([
      "gitStage",
      ["src/page.json", "src/new.json", "src/gone.json", "assets/logo.png", "untracked.txt"],
    ]);
    expect(calls).toContainEqual(["gitUnstage", ["staged.json"]]);
  });

  test("files group by component directory with non-json under Other", () => {
    seedRepoUi();
    const div = renderPanel();
    const groups = [...div.querySelectorAll(".git-component-name")].map((el) => el.textContent);
    expect(groups).toContain("/src");
    expect(groups).toContain("Other");
    expect(groups).toContain("/staged.json");
  });
});

// ─── History tab ─────────────────────────────────────────────────────────────

describe("history tab", () => {
  function tabButtons(div: HTMLElement) {
    return div.querySelectorAll(".git-tab");
  }

  test("switching to history fetches the log and renders relative dates", async () => {
    seedRepoUi();
    const now = Date.now();
    const entries = [
      { author: "ada", date: new Date(now).toISOString(), hash: "aaaaaaa1111", message: "fresh" },
      {
        author: "ada",
        date: new Date(now - 5 * 60_000 - 2000).toISOString(),
        hash: "bbbbbbb2222",
        message: "minutes",
      },
      {
        author: "bob",
        date: new Date(now - 3 * 3_600_000 - 60_000).toISOString(),
        hash: "ccccccc3333",
        message: "hours",
      },
      {
        author: "bob",
        date: new Date(now - 2 * 86_400_000 - 3_600_000).toISOString(),
        hash: "ddddddd4444",
        message: "days",
      },
      {
        author: "eve",
        date: "2020-01-02T00:00:00.000Z",
        hash: "eeeeeee5555",
        message: "ancient",
      },
    ];
    mockPlatform.gitLog = log("gitLog", async () => entries);
    let div = renderPanel();
    click(tabButtons(div)[1]);
    await flush();
    expect(calls).toContainEqual(["gitLog", 30]);
    expect(git.logEntries).toEqual(entries);

    div = renderPanel();
    const text = div.textContent!;
    expect(text).toContain("just now");
    expect(text).toContain("5m ago");
    expect(text).toContain("3h ago");
    expect(text).toContain("2d ago");
    expect(text).toContain("2020");
    expect(text).toContain("aaaaaaa");
    expect(div.querySelectorAll(".git-history-entry").length).toBe(5);

    click(tabButtons(div)[0]); // Restore module sub-tab state
  });

  test("history with cached empty entries teaches what a commit is, without refetch", async () => {
    seedRepoUi({ logEntries: [] });
    let div = renderPanel();
    click(tabButtons(div)[1]);
    await flush();
    expect(callNames()).not.toContain("gitLog");
    div = renderPanel();
    expect(div.textContent).toContain("No commits yet.");
    click(tabButtons(div)[0]);
  });

  test("log fetch failure records the error", async () => {
    seedRepoUi();
    mockPlatform.gitLog = log("gitLog", async () => {
      throw new Error("log boom");
    });
    const div = renderPanel();
    click(tabButtons(div)[1]);
    await flush();
    expect(String(git.error)).toContain("log boom");
    click(renderPanel().querySelectorAll(".git-tab")[0]);
  });

  test("tab label includes the change count", () => {
    seedRepoUi();
    const div = renderPanel();
    expect(tabButtons(div)[0]!.textContent).toContain("Local Changes (6)");
  });
});

// ─── Poll timer + cleanup ────────────────────────────────────────────────────

describe("poll timer", () => {
  test("interval refreshes only when the git tab is visible and idle", async () => {
    cleanupGitPanel();
    const realSetInterval = globalThis.setInterval;
    let pollCb: (() => void) | null = null;
    let pollMs = 0;
    (globalThis as any).setInterval = (fn: () => void, ms: number) => {
      pollCb = fn;
      pollMs = ms;
      return 123_456;
    };
    try {
      seedRepoUi();
      renderPanel();
    } finally {
      globalThis.setInterval = realSetInterval;
    }
    expect(pollCb).toBeTruthy();
    expect(pollMs).toBe(30_000);

    calls = [];
    git.loading = false;
    pollCb!();
    await flush();
    expect(callNames()).toContain("gitStatus");

    calls = [];
    git.loading = true;
    pollCb!();
    await flush();
    expect(calls).toEqual([]);

    calls = [];
    git.loading = false;
    shell.leftTab = "layers";
    pollCb!();
    await flush();
    expect(calls).toEqual([]);

    cleanupGitPanel();
  });

  test("cleanupGitPanel is idempotent", () => {
    seedRepoUi();
    renderPanel(); // Arms the timer
    cleanupGitPanel();
    cleanupGitPanel(); // Second call hits the no-timer branch
  });
});
