// oxlint-disable typescript/await-thenable -- bun test .resolves/.rejects matchers are typed `void` but return real Promises at runtime; the await is required.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { setProjectRoot } from "../src/handlers";
import {
  gitBranches,
  gitCheckout,
  gitCommit,
  gitCreateBranch,
  gitDiff,
  gitDiscard,
  gitFetch,
  gitLog,
  gitPull,
  gitPush,
  gitShow,
  gitStage,
  gitStatus,
  gitUnstage,
} from "../src/git";

const FIXTURES = join(import.meta.dir, "_fixtures_git");

let defaultBranch: string;

function run(args: string[]) {
  const proc = Bun.spawnSync(args, {
    cwd: FIXTURES,
    stderr: "pipe",
    stdout: "pipe",
  });
  if (proc.exitCode !== 0) {
    throw new Error(`${args.join(" ")} failed: ${proc.stderr.toString()}`);
  }
  return proc.stdout.toString().trim();
}

beforeAll(() => {
  mkdirSync(FIXTURES, { recursive: true });
  run(["git", "init"]);
  run(["git", "config", "user.email", "test@test.com"]);
  run(["git", "config", "user.name", "Test"]);
  writeFileSync(join(FIXTURES, "initial.txt"), "hello");
  run(["git", "add", "."]);
  run(["git", "commit", "-m", "initial commit"]);
  defaultBranch = run(["git", "branch", "--show-current"]);
  setProjectRoot(FIXTURES);
});

afterAll(() => {
  setProjectRoot(null);
  rmSync(FIXTURES, { force: true, recursive: true });
});

// ─── gitStatus ──────────────────────────────────────────────────────────────

describe("gitStatus", () => {
  test("reports clean state", async () => {
    const result = await gitStatus();
    expect(result.branch).toBe(defaultBranch);
    expect(result.files).toHaveLength(0);
    expect(result.ahead).toBe(0);
    expect(result.behind).toBe(0);
  });

  test("reports modified files", async () => {
    writeFileSync(join(FIXTURES, "initial.txt"), "modified");
    const result = await gitStatus();
    expect(result.files.length).toBeGreaterThan(0);
    // The status and path are parsed from porcelain output
    const [file] = result.files;
    expect(file.status).toBeTruthy();
    expect(file.path.length).toBeGreaterThan(0);
    run(["git", "checkout", "--", "initial.txt"]);
  });

  test("reports untracked files", async () => {
    writeFileSync(join(FIXTURES, "untracked.txt"), "new");
    const result = await gitStatus();
    const untracked = result.files.find((f) => f.path === "untracked.txt");
    expect(untracked).toBeDefined();
    expect(untracked!.status).toBe("??");
    rmSync(join(FIXTURES, "untracked.txt"));
  });
});

// ─── gitBranches ────────────────────────────────────────────────────────────

describe("gitBranches", () => {
  test("lists branches including current", async () => {
    const result = await gitBranches();
    expect(result.current).toBe(defaultBranch);
    expect(result.branches).toContain(defaultBranch);
  });
});

// ─── gitLog ─────────────────────────────────────────────────────────────────

describe("gitLog", () => {
  test("returns commit entries", async () => {
    const entries = await gitLog({});
    expect(entries.length).toBeGreaterThanOrEqual(1);
    expect(entries[0].message).toBe("initial commit");
    expect(entries[0].author).toBe("Test");
    expect(entries[0].hash).toHaveLength(40);
    expect(entries[0].date).toMatch(/^\d{4}-\d{2}-\d{2}/);
  });

  test("respects limit parameter", async () => {
    writeFileSync(join(FIXTURES, "second.txt"), "s");
    run(["git", "add", "."]);
    run(["git", "commit", "-m", "second commit"]);

    const all = await gitLog({});
    expect(all.length).toBe(2);

    const limited = await gitLog({ limit: 1 });
    expect(limited.length).toBe(1);
    expect(limited[0].message).toBe("second commit");
  });
});

// ─── gitStage / gitUnstage ──────────────────────────────────────────────────

describe("gitStage / gitUnstage", () => {
  test("stages a file", async () => {
    writeFileSync(join(FIXTURES, "staged.txt"), "to stage");
    await gitStage({ files: ["staged.txt"] });
    const status = await gitStatus();
    const file = status.files.find((f) => f.path === "staged.txt");
    expect(file).toBeDefined();
    expect(file!.status).toBe("A");
  });

  test("unstages a file", async () => {
    await gitUnstage({ files: ["staged.txt"] });
    const status = await gitStatus();
    const file = status.files.find((f) => f.path === "staged.txt");
    expect(file).toBeDefined();
    expect(file!.status).toBe("??");
    rmSync(join(FIXTURES, "staged.txt"));
  });
});

// ─── gitCommit ──────────────────────────────────────────────────────────────

describe("gitCommit", () => {
  test("commits staged changes", async () => {
    writeFileSync(join(FIXTURES, "committed.txt"), "data");
    await gitStage({ files: ["committed.txt"] });
    await gitCommit({ message: "test commit" });

    const log = await gitLog({ limit: 1 });
    expect(log[0].message).toBe("test commit");

    const status = await gitStatus();
    expect(status.files.find((f) => f.path === "committed.txt")).toBeUndefined();
  });
});

// ─── gitDiff ────────────────────────────────────────────────────────────────

describe("gitDiff", () => {
  test("shows diff for modified file", async () => {
    writeFileSync(join(FIXTURES, "committed.txt"), "changed data");
    const diff = await gitDiff({ path: "committed.txt" });
    expect(diff).toContain("-data");
    expect(diff).toContain("+changed data");
  });

  test("shows full diff without path", async () => {
    const diff = await gitDiff({});
    expect(diff).toContain("committed.txt");
  });
});

// ─── gitDiscard ─────────────────────────────────────────────────────────────

describe("gitDiscard", () => {
  test("discards changes to a file", async () => {
    writeFileSync(join(FIXTURES, "committed.txt"), "discarded");
    await gitDiscard({ files: ["committed.txt"] });
    const content = await Bun.file(join(FIXTURES, "committed.txt")).text();
    expect(content).toBe("data");
  });
});

// ─── gitCreateBranch / gitCheckout ──────────────────────────────────────────

describe("gitCreateBranch / gitCheckout", () => {
  test("creates and switches to a new branch", async () => {
    await gitCreateBranch({ name: "feature-test" });
    const status = await gitStatus();
    expect(status.branch).toBe("feature-test");

    const branches = await gitBranches();
    expect(branches.branches).toContain("feature-test");
  });

  test("checks out an existing branch", async () => {
    await gitCheckout({ branch: defaultBranch });
    const status = await gitStatus();
    expect(status.branch).toBe(defaultBranch);
  });
});

// ─── gitShow ───────────────────────────────────────────────────────────────

describe("gitShow", () => {
  test("shows file content at HEAD", async () => {
    const content = await gitShow({ path: "initial.txt" });
    expect(content.trim()).toBe("hello");
  });

  test("shows file at a specific ref", async () => {
    const log = await gitLog({ limit: 1 });
    const content = await gitShow({ path: "initial.txt", ref: log[0].hash });
    expect(content.trim()).toBe("hello");
  });

  test("throws for non-existent path", async () => {
    await expect(gitShow({ path: "nonexistent.txt" })).rejects.toThrow();
  });
});

// ─── gitPush / gitPull / gitFetch ──────────────────────────────────────────

describe("gitPush / gitPull / gitFetch", () => {
  test("gitPush throws when no remote configured", async () => {
    await expect(gitPush()).rejects.toThrow();
  });

  test("gitPull throws when no remote configured", async () => {
    await expect(gitPull()).rejects.toThrow();
  });

  test("gitFetch succeeds even without remote", async () => {
    await gitFetch();
  });
});

// ─── Error cases ────────────────────────────────────────────────────────────

describe("error handling", () => {
  test("throws when no project root set", async () => {
    setProjectRoot(null);
    await expect(gitStatus()).rejects.toThrow("No project open");
    setProjectRoot(FIXTURES);
  });

  test("throws on invalid git operations", async () => {
    await expect(gitCheckout({ branch: "nonexistent-branch-xyz" })).rejects.toThrow();
  });
});
