import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { setProjectRoot } from "../src/handlers";
import { gitStatus, gitInit, gitAddRemote, gitPush } from "../src/git";

const FIXTURES = join(import.meta.dir, "_fixtures_git_new");

function run(args: string[]) {
  const proc = Bun.spawnSync(args, {
    cwd: FIXTURES,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (proc.exitCode !== 0) {
    throw new Error(`${args.join(" ")} failed: ${proc.stderr.toString()}`);
  }
  return proc.stdout.toString().trim();
}

afterAll(() => {
  setProjectRoot(null);
  rmSync(FIXTURES, { recursive: true, force: true });
});

// ─── gitStatus — isRepo / remotes ────────────────────────────────────────────

describe("gitStatus — isRepo and remotes", () => {
  beforeAll(() => {
    rmSync(FIXTURES, { recursive: true, force: true });
    mkdirSync(FIXTURES, { recursive: true });
    run(["git", "init"]);
    run(["git", "config", "user.email", "test@test.com"]);
    run(["git", "config", "user.name", "Test"]);
    writeFileSync(join(FIXTURES, "initial.txt"), "hello");
    run(["git", "add", "."]);
    run(["git", "commit", "-m", "initial commit"]);
    setProjectRoot(FIXTURES);
  });

  test("reports isRepo=true for a git repo", async () => {
    const result = await gitStatus();
    expect(result.isRepo).toBe(true);
  });

  test("reports remotes as empty array when no remotes", async () => {
    const result = await gitStatus();
    expect(result.remotes).toEqual([]);
  });

  test("reports remotes after adding one", async () => {
    run(["git", "remote", "add", "origin", "https://example.com/repo.git"]);
    const result = await gitStatus();
    expect(result.remotes).toContain("origin");
    run(["git", "remote", "remove", "origin"]);
  });
});

// ─── gitStatus — non-git directory ────────────────────────────────────────────

describe("gitStatus — non-git directory", () => {
  const NON_GIT = join("/tmp", `_jx_non_git_${process.pid}`);

  beforeAll(() => {
    rmSync(NON_GIT, { recursive: true, force: true });
    mkdirSync(NON_GIT, { recursive: true });
    writeFileSync(join(NON_GIT, "file.txt"), "not a repo");
    setProjectRoot(NON_GIT);
  });

  afterAll(() => {
    setProjectRoot(FIXTURES);
    rmSync(NON_GIT, { recursive: true, force: true });
  });

  test("returns isRepo=false for non-git directory", async () => {
    const result = await gitStatus();
    expect(result.isRepo).toBe(false);
    expect(result.branch).toBe("");
    expect(result.files).toEqual([]);
    expect(result.ahead).toBe(0);
    expect(result.behind).toBe(0);
    expect(result.remotes).toEqual([]);
  });
});

// ─── gitInit ─────────────────────────────────────────────────────────────────

describe("gitInit", () => {
  const INIT_DIR = join(import.meta.dir, "_fixtures_git_init");

  beforeAll(() => {
    rmSync(INIT_DIR, { recursive: true, force: true });
    mkdirSync(INIT_DIR, { recursive: true });
    writeFileSync(join(INIT_DIR, "file.txt"), "hello");
    setProjectRoot(INIT_DIR);
  });

  afterAll(() => {
    setProjectRoot(FIXTURES);
    rmSync(INIT_DIR, { recursive: true, force: true });
  });

  test("initializes a git repository", async () => {
    await gitInit();
    const result = await gitStatus();
    expect(result.isRepo).toBe(true);
  });

  test("reports untracked files after init", async () => {
    const result = await gitStatus();
    expect(result.files.length).toBeGreaterThan(0);
  });

  test("does not throw on re-init", async () => {
    await expect(gitInit()).resolves.toBeUndefined();
  });
});

// ─── gitAddRemote ────────────────────────────────────────────────────────────

describe("gitAddRemote", () => {
  const REMOTE_DIR = join(import.meta.dir, "_fixtures_git_addremote");

  beforeAll(() => {
    rmSync(REMOTE_DIR, { recursive: true, force: true });
    mkdirSync(REMOTE_DIR, { recursive: true });
    const proc = Bun.spawnSync(["git", "init"], {
      cwd: REMOTE_DIR,
      stdout: "pipe",
      stderr: "pipe",
    });
    if (proc.exitCode !== 0) throw new Error("git init failed");
    Bun.spawnSync(["git", "config", "user.email", "test@test.com"], {
      cwd: REMOTE_DIR,
    });
    Bun.spawnSync(["git", "config", "user.name", "Test"], { cwd: REMOTE_DIR });
    writeFileSync(join(REMOTE_DIR, "file.txt"), "hello");
    Bun.spawnSync(["git", "add", "."], { cwd: REMOTE_DIR });
    Bun.spawnSync(["git", "commit", "-m", "init"], {
      cwd: REMOTE_DIR,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "Test",
        GIT_AUTHOR_EMAIL: "test@test.com",
        GIT_COMMITTER_NAME: "Test",
        GIT_COMMITTER_EMAIL: "test@test.com",
      },
    });
    setProjectRoot(REMOTE_DIR);
  });

  afterAll(() => {
    setProjectRoot(FIXTURES);
    rmSync(REMOTE_DIR, { recursive: true, force: true });
  });

  test("adds a remote successfully", async () => {
    await gitAddRemote({
      name: "origin",
      url: "https://github.com/test/repo.git",
    });
    const result = await gitStatus();
    expect(result.remotes).toContain("origin");
  });

  test("throws when remote already exists", async () => {
    await expect(
      gitAddRemote({
        name: "origin",
        url: "https://github.com/other/repo.git",
      }),
    ).rejects.toThrow();
  });

  test("can add a second remote with different name", async () => {
    await gitAddRemote({
      name: "upstream",
      url: "https://github.com/upstream/repo.git",
    });
    const result = await gitStatus();
    expect(result.remotes).toContain("origin");
    expect(result.remotes).toContain("upstream");
  });
});

// ─── gitPush with setUpstream ────────────────────────────────────────────────

describe("gitPush — setUpstream option", () => {
  const PUSH_DIR = join(import.meta.dir, "_fixtures_git_push_new");
  const BARE_DIR = join(import.meta.dir, "_fixtures_git_push_bare");

  beforeAll(() => {
    rmSync(PUSH_DIR, { recursive: true, force: true });
    rmSync(BARE_DIR, { recursive: true, force: true });

    mkdirSync(BARE_DIR, { recursive: true });
    Bun.spawnSync(["git", "init", "--bare"], { cwd: BARE_DIR });

    mkdirSync(PUSH_DIR, { recursive: true });
    Bun.spawnSync(["git", "init", "-b", "main"], { cwd: PUSH_DIR });
    Bun.spawnSync(["git", "config", "user.email", "test@test.com"], {
      cwd: PUSH_DIR,
    });
    Bun.spawnSync(["git", "config", "user.name", "Test"], { cwd: PUSH_DIR });
    writeFileSync(join(PUSH_DIR, "file.txt"), "content");
    Bun.spawnSync(["git", "add", "."], { cwd: PUSH_DIR });
    Bun.spawnSync(["git", "commit", "-m", "initial"], {
      cwd: PUSH_DIR,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "Test",
        GIT_AUTHOR_EMAIL: "test@test.com",
        GIT_COMMITTER_NAME: "Test",
        GIT_COMMITTER_EMAIL: "test@test.com",
      },
    });
    Bun.spawnSync(["git", "remote", "add", "origin", BARE_DIR], {
      cwd: PUSH_DIR,
    });
    setProjectRoot(PUSH_DIR);
  });

  afterAll(() => {
    setProjectRoot(FIXTURES);
    rmSync(PUSH_DIR, { recursive: true, force: true });
    rmSync(BARE_DIR, { recursive: true, force: true });
  });

  test("pushes with upstream tracking when setUpstream=true", async () => {
    await gitPush({ setUpstream: true });

    const proc = Bun.spawnSync(["git", "rev-parse", "--abbrev-ref", "@{u}"], {
      cwd: PUSH_DIR,
      stdout: "pipe",
    });
    expect(proc.stdout.toString().trim()).toBe("origin/main");
  });

  test("pushes without options after upstream is set", async () => {
    writeFileSync(join(PUSH_DIR, "file2.txt"), "more content");
    Bun.spawnSync(["git", "add", "."], { cwd: PUSH_DIR });
    Bun.spawnSync(["git", "commit", "-m", "second"], {
      cwd: PUSH_DIR,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "Test",
        GIT_AUTHOR_EMAIL: "test@test.com",
        GIT_COMMITTER_NAME: "Test",
        GIT_COMMITTER_EMAIL: "test@test.com",
      },
    });

    await expect(gitPush()).resolves.toBeUndefined();
  });
});
