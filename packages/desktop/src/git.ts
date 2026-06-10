import { getProjectRoot } from "./handlers";
import type { GitStatusResult, GitBranchesResult, GitLogEntry } from "./rpc-schema";

async function git(...args: string[]): Promise<string> {
  const root = getProjectRoot();
  if (!root) throw new Error("No project open");
  const proc = Bun.spawn(["git", ...args], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  const exitCode = await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`git ${args[0]} failed: ${stderr.trim()}`);
  }
  return stdout;
}

export async function gitStatus(): Promise<GitStatusResult> {
  const root = getProjectRoot();
  if (!root) throw new Error("No project open");

  try {
    await git("rev-parse", "--is-inside-work-tree");
  } catch {
    return {
      branch: "",
      files: [],
      ahead: 0,
      behind: 0,
      isRepo: false,
      remotes: [],
    };
  }

  const branch = (await git("branch", "--show-current")).trim();
  const porcelain = await git("status", "--porcelain=v1");
  const files = porcelain
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => ({
      status: line.slice(0, 2).trim(),
      path: line.slice(3),
    }));

  let ahead = 0;
  let behind = 0;
  try {
    ahead = parseInt(await git("rev-list", "--count", "@{u}..HEAD")) || 0;
    behind = parseInt(await git("rev-list", "--count", "HEAD..@{u}")) || 0;
  } catch {
    // no upstream configured
  }

  let remotes: string[] = [];
  try {
    const remotesOut = await git("remote");
    remotes = remotesOut.trim().split("\n").filter(Boolean);
  } catch {
    // no remotes
  }

  return { branch, files, ahead, behind, isRepo: true, remotes };
}

export async function gitBranches(): Promise<GitBranchesResult> {
  const current = (await git("branch", "--show-current")).trim();
  const output = await git("branch", "-a", "--format=%(refname:short)");
  const branches = output.trim().split("\n").filter(Boolean);
  return { current, branches };
}

export async function gitLog(params: { limit?: number }): Promise<GitLogEntry[]> {
  const limit = params.limit ?? 50;
  const output = await git("log", `--max-count=${limit}`, "--format=%H%n%s%n%an%n%aI%n---");
  const entries: GitLogEntry[] = [];
  const chunks = output.trim().split("\n---\n").filter(Boolean);
  for (const chunk of chunks) {
    const [hash, message, author, date] = chunk.split("\n");
    if (hash && message && author && date) {
      entries.push({ hash, message, author, date });
    }
  }
  return entries;
}

export async function gitStage(params: { files: string[] }): Promise<void> {
  await git("add", "--", ...params.files);
}

export async function gitUnstage(params: { files: string[] }): Promise<void> {
  await git("restore", "--staged", "--", ...params.files);
}

export async function gitCommit(params: { message: string }): Promise<void> {
  await git("commit", "-m", params.message);
}

export async function gitPush(params?: { setUpstream?: boolean }): Promise<void> {
  if (params?.setUpstream) {
    const branch = (await git("rev-parse", "--abbrev-ref", "HEAD")).trim();
    await git("push", "-u", "origin", branch);
  } else {
    await git("push");
  }
}

export async function gitPull(): Promise<void> {
  await git("pull");
}

export async function gitFetch(): Promise<void> {
  await git("fetch");
}

export async function gitCheckout(params: { branch: string }): Promise<void> {
  await git("checkout", params.branch);
}

export async function gitCreateBranch(params: { name: string }): Promise<void> {
  await git("checkout", "-b", params.name);
}

export async function gitDiff(params: { path?: string }): Promise<string> {
  if (params.path) {
    return git("diff", "--", params.path);
  }
  return git("diff");
}

export async function gitShow(params: { path: string; ref?: string }): Promise<string> {
  const ref = params.ref || "HEAD";
  return git("show", `${ref}:${params.path}`);
}

export async function gitDiscard(params: { files: string[] }): Promise<void> {
  await git("checkout", "--", ...params.files);
}

export async function gitInit(): Promise<void> {
  await git("init");
}

export async function gitAddRemote(params: { name: string; url: string }): Promise<void> {
  await git("remote", "add", params.name, params.url);
}
