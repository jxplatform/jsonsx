import { getProjectRoot } from "./handlers";
import type { GitBranchesResult, GitLogEntry, GitStatusResult } from "./rpc-schema";

/** Build git operations bound to one project session (its projectRoot is the git cwd). */
export function createGitOps(session: { readonly projectRoot: string | null }) {
  async function git(...args: string[]): Promise<string> {
    const root = session.projectRoot;
    if (!root) {
      throw new Error("No project open");
    }
    const proc = Bun.spawn(["git", ...args], {
      cwd: root,
      stderr: "pipe",
      stdout: "pipe",
    });
    const exitCode = await proc.exited;
    const stdout = await new Response(proc.stdout).text();
    if (exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text();
      throw new Error(`git ${args[0]} failed: ${stderr.trim()}`);
    }
    return stdout;
  }

  async function gitStatus(): Promise<GitStatusResult> {
    if (!session.projectRoot) {
      throw new Error("No project open");
    }

    try {
      await git("rev-parse", "--is-inside-work-tree");
    } catch {
      return {
        ahead: 0,
        behind: 0,
        branch: "",
        files: [],
        isRepo: false,
        remotes: [],
      };
    }

    const branchRaw = await git("branch", "--show-current");
    const branch = branchRaw.trim();
    const porcelain = await git("status", "--porcelain=v1");
    const files = porcelain
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => ({
        path: line.slice(3),
        status: line.slice(0, 2).trim(),
      }));

    let ahead = 0;
    let behind = 0;
    try {
      ahead = Number.parseInt(await git("rev-list", "--count", "@{u}..HEAD"), 10) || 0;
      behind = Number.parseInt(await git("rev-list", "--count", "HEAD..@{u}"), 10) || 0;
    } catch {
      // No upstream configured
    }

    let remotes: string[] = [];
    try {
      const remotesOut = await git("remote");
      remotes = remotesOut.trim().split("\n").filter(Boolean);
    } catch {
      // No remotes
    }

    return { ahead, behind, branch, files, isRepo: true, remotes };
  }

  async function gitBranches(): Promise<GitBranchesResult> {
    const currentRaw = await git("branch", "--show-current");
    const current = currentRaw.trim();
    const output = await git("branch", "-a", "--format=%(refname:short)");
    const branches = output.trim().split("\n").filter(Boolean);
    return { branches, current };
  }

  async function gitLog(params: { limit?: number }): Promise<GitLogEntry[]> {
    const limit = params.limit ?? 50;
    const output = await git("log", `--max-count=${limit}`, "--format=%H%n%s%n%an%n%aI%n---");
    const entries: GitLogEntry[] = [];
    const chunks = output.trim().split("\n---\n").filter(Boolean);
    for (const chunk of chunks) {
      const [hash, message, author, date] = chunk.split("\n");
      if (hash && message && author && date) {
        entries.push({ author, date, hash, message });
      }
    }
    return entries;
  }

  async function gitStage(params: { files: string[] }): Promise<void> {
    await git("add", "--", ...params.files);
  }

  async function gitUnstage(params: { files: string[] }): Promise<void> {
    await git("restore", "--staged", "--", ...params.files);
  }

  async function gitCommit(params: { message: string }): Promise<void> {
    await git("commit", "-m", params.message);
  }

  async function gitPush(params?: { setUpstream?: boolean }): Promise<void> {
    if (params?.setUpstream) {
      const branchRaw = await git("rev-parse", "--abbrev-ref", "HEAD");
      const branch = branchRaw.trim();
      await git("push", "-u", "origin", branch);
    } else {
      await git("push");
    }
  }

  async function gitPull(): Promise<void> {
    await git("pull");
  }

  async function gitFetch(): Promise<void> {
    await git("fetch");
  }

  async function gitCheckout(params: { branch: string }): Promise<void> {
    await git("checkout", params.branch);
  }

  async function gitCreateBranch(params: { name: string }): Promise<void> {
    await git("checkout", "-b", params.name);
  }

  async function gitDiff(params: { path?: string }): Promise<string> {
    if (params.path) {
      return git("diff", "--", params.path);
    }
    return git("diff");
  }

  async function gitShow(params: { path: string; ref?: string }): Promise<string> {
    const ref = params.ref || "HEAD";
    return git("show", `${ref}:${params.path}`);
  }

  async function gitDiscard(params: { files: string[] }): Promise<void> {
    await git("checkout", "--", ...params.files);
  }

  async function gitInit(): Promise<void> {
    await git("init");
  }

  async function gitAddRemote(params: { name: string; url: string }): Promise<void> {
    await git("remote", "add", params.name, params.url);
  }

  return {
    gitStatus,
    gitBranches,
    gitLog,
    gitStage,
    gitUnstage,
    gitCommit,
    gitPush,
    gitPull,
    gitFetch,
    gitCheckout,
    gitCreateBranch,
    gitDiff,
    gitShow,
    gitDiscard,
    gitInit,
    gitAddRemote,
  };
}

// ─── Legacy free functions (default process-global session via getProjectRoot) ──
// Used by the chromium/ dev launcher and the test suite.

const _legacy = createGitOps({
  get projectRoot() {
    return getProjectRoot();
  },
});

export const { gitStatus } = _legacy;
export const { gitBranches } = _legacy;
export const { gitLog } = _legacy;
export const { gitStage } = _legacy;
export const { gitUnstage } = _legacy;
export const { gitCommit } = _legacy;
export const { gitPush } = _legacy;
export const { gitPull } = _legacy;
export const { gitFetch } = _legacy;
export const { gitCheckout } = _legacy;
export const { gitCreateBranch } = _legacy;
export const { gitDiff } = _legacy;
export const { gitShow } = _legacy;
export const { gitDiscard } = _legacy;
export const { gitInit } = _legacy;
export const { gitAddRemote } = _legacy;
