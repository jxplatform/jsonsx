import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { handleStudioApi } from "../src/studio-api";
import { join, resolve } from "node:path";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";

const GIT_FIXTURE = resolve(import.meta.dir, "_git_new_endpoints_fixture");
const NON_GIT_FIXTURE = resolve("/tmp", `_jx_non_git_fixture_${process.pid}`);

/**
 * @param {string} path
 * @param {string} [method]
 * @param {Record<string, unknown>} [body]
 * @param {string} [cwd]
 * @returns {Promise<Response>}
 */
async function studioGitReq(
  path: string,
  method: string = "GET",
  body?: Record<string, unknown>,
  cwd: string = GIT_FIXTURE,
) {
  const urlStr = `http://localhost${path}`;
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers = { "Content-Type": "application/json" };
  }
  const res = await handleStudioApi(new Request(urlStr, init), new URL(urlStr), cwd);
  if (!res) {
    throw new Error(`No response from handleStudioApi for ${method} ${path}`);
  }
  return res;
}

/**
 * @param {string} cmd
 * @param {string} [cwd]
 * @returns {string}
 */
function git(cmd: string, cwd: string = GIT_FIXTURE) {
  return execSync(`git ${cmd}`, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_EMAIL: "test@test.com",
      GIT_AUTHOR_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@test.com",
      GIT_COMMITTER_NAME: "Test",
    },
  });
}

// ── git/status isRepo and remotes ─────────────────────────────────────────────

describe("git/status — isRepo and remotes fields", () => {
  beforeAll(() => {
    rmSync(GIT_FIXTURE, { force: true, recursive: true });
    mkdirSync(GIT_FIXTURE, { recursive: true });
    git("init -b main");
    git("config user.email test@test.com");
    git("config user.name Test");
    writeFileSync(join(GIT_FIXTURE, "file.txt"), "hello");
    git("add .");
    git("commit -m initial");
  });

  afterAll(() => {
    rmSync(GIT_FIXTURE, { force: true, recursive: true });
  });

  test("returns isRepo=true for a git repository", async () => {
    const res = await studioGitReq("/__studio/git/status");
    const data = await res.json();
    expect(data.isRepo).toBe(true);
  });

  test("returns remotes as empty array when no remotes configured", async () => {
    const res = await studioGitReq("/__studio/git/status");
    const data = await res.json();
    expect(data.remotes).toEqual([]);
  });

  test("returns remotes with entries after adding a remote", async () => {
    git("remote add origin https://example.com/repo.git");
    const res = await studioGitReq("/__studio/git/status");
    const data = await res.json();
    expect(data.remotes).toContain("origin");
    git("remote remove origin");
  });

  test("returns multiple remotes", async () => {
    git("remote add origin https://example.com/repo.git");
    git("remote add upstream https://example.com/upstream.git");
    const res = await studioGitReq("/__studio/git/status");
    const data = await res.json();
    expect(data.remotes).toContain("origin");
    expect(data.remotes).toContain("upstream");
    expect(data.remotes).toHaveLength(2);
    git("remote remove origin");
    git("remote remove upstream");
  });
});

describe("git/status — non-git directory", () => {
  beforeAll(() => {
    rmSync(NON_GIT_FIXTURE, { force: true, recursive: true });
    mkdirSync(NON_GIT_FIXTURE, { recursive: true });
    writeFileSync(join(NON_GIT_FIXTURE, "file.txt"), "not a git repo");
  });

  afterAll(() => {
    rmSync(NON_GIT_FIXTURE, { force: true, recursive: true });
  });

  test("returns isRepo=false for a non-git directory", async () => {
    const res = await studioGitReq("/__studio/git/status", "GET", undefined, NON_GIT_FIXTURE);
    const data = await res.json();
    expect(data.isRepo).toBe(false);
    expect(data.branch).toBe("");
    expect(data.files).toEqual([]);
    expect(data.ahead).toBe(0);
    expect(data.behind).toBe(0);
    expect(data.remotes).toEqual([]);
  });
});

// ── git/init ──────────────────────────────────────────────────────────────────

describe("git/init endpoint", () => {
  const INIT_FIXTURE = resolve(import.meta.dir, "_git_init_fixture");

  beforeAll(() => {
    rmSync(INIT_FIXTURE, { force: true, recursive: true });
    mkdirSync(INIT_FIXTURE, { recursive: true });
    writeFileSync(join(INIT_FIXTURE, "project.json"), '{"name":"test"}');
  });

  afterAll(() => {
    rmSync(INIT_FIXTURE, { force: true, recursive: true });
  });

  test("initializes a git repository", async () => {
    const res = await studioGitReq("/__studio/git/init", "POST", undefined, INIT_FIXTURE);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);

    const statusRes = await studioGitReq("/__studio/git/status", "GET", undefined, INIT_FIXTURE);
    const statusData = await statusRes.json();
    expect(statusData.isRepo).toBe(true);
  });

  test("can init on an already-initialized repo without error", async () => {
    const res = await studioGitReq("/__studio/git/init", "POST", undefined, INIT_FIXTURE);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
  });
});

// ── git/add-remote ────────────────────────────────────────────────────────────

describe("git/add-remote endpoint", () => {
  const REMOTE_FIXTURE = resolve(import.meta.dir, "_git_remote_fixture");

  beforeAll(() => {
    rmSync(REMOTE_FIXTURE, { force: true, recursive: true });
    mkdirSync(REMOTE_FIXTURE, { recursive: true });
    execSync("git init -b main", { cwd: REMOTE_FIXTURE });
    execSync("git config user.email test@test.com", { cwd: REMOTE_FIXTURE });
    execSync("git config user.name Test", { cwd: REMOTE_FIXTURE });
    writeFileSync(join(REMOTE_FIXTURE, "file.txt"), "content");
    execSync("git add . && git commit -m initial", { cwd: REMOTE_FIXTURE });
  });

  afterAll(() => {
    rmSync(REMOTE_FIXTURE, { force: true, recursive: true });
  });

  test("adds a remote", async () => {
    const res = await studioGitReq(
      "/__studio/git/add-remote",
      "POST",
      { name: "origin", url: "https://github.com/user/repo.git" },
      REMOTE_FIXTURE,
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);

    const statusRes = await studioGitReq("/__studio/git/status", "GET", undefined, REMOTE_FIXTURE);
    const statusData = await statusRes.json();
    expect(statusData.remotes).toContain("origin");
  });

  test("rejects missing name", async () => {
    const res = await studioGitReq(
      "/__studio/git/add-remote",
      "POST",
      { name: "", url: "https://github.com/user/repo.git" },
      REMOTE_FIXTURE,
    );
    expect(res.status).toBe(400);
  });

  test("rejects missing url", async () => {
    const res = await studioGitReq(
      "/__studio/git/add-remote",
      "POST",
      { name: "upstream", url: "" },
      REMOTE_FIXTURE,
    );
    expect(res.status).toBe(400);
  });

  test("fails when remote already exists", async () => {
    const res = await studioGitReq(
      "/__studio/git/add-remote",
      "POST",
      { name: "origin", url: "https://github.com/other/repo.git" },
      REMOTE_FIXTURE,
    );
    expect(res.status).toBe(500);
    const data = await res.json();
    expect(data.error).toBeTruthy();
  });
});

// ── git/push with setUpstream ─────────────────────────────────────────────────

describe("git/push — setUpstream option", () => {
  const PUSH_FIXTURE = resolve(import.meta.dir, "_git_push_fixture");
  const BARE_FIXTURE = resolve(import.meta.dir, "_git_push_bare");

  beforeAll(() => {
    rmSync(PUSH_FIXTURE, { force: true, recursive: true });
    rmSync(BARE_FIXTURE, { force: true, recursive: true });

    mkdirSync(BARE_FIXTURE, { recursive: true });
    execSync("git init --bare", { cwd: BARE_FIXTURE });

    mkdirSync(PUSH_FIXTURE, { recursive: true });
    execSync("git init -b main", { cwd: PUSH_FIXTURE });
    execSync("git config user.email test@test.com", { cwd: PUSH_FIXTURE });
    execSync("git config user.name Test", { cwd: PUSH_FIXTURE });
    writeFileSync(join(PUSH_FIXTURE, "file.txt"), "content");
    execSync("git add . && git commit -m initial", { cwd: PUSH_FIXTURE });
    execSync(`git remote add origin ${BARE_FIXTURE}`, { cwd: PUSH_FIXTURE });
  });

  afterAll(() => {
    rmSync(PUSH_FIXTURE, { force: true, recursive: true });
    rmSync(BARE_FIXTURE, { force: true, recursive: true });
  });

  test("push with setUpstream=true sets upstream and pushes", async () => {
    const res = await studioGitReq(
      "/__studio/git/push",
      "POST",
      { setUpstream: true },
      PUSH_FIXTURE,
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);

    const upstream = execSync("git rev-parse --abbrev-ref @{u}", {
      cwd: PUSH_FIXTURE,
      encoding: "utf8",
    }).trim();
    expect(upstream).toBe("origin/main");
  });

  test("push without setUpstream works after upstream is set", async () => {
    writeFileSync(join(PUSH_FIXTURE, "file2.txt"), "more");
    execSync("git add . && git commit -m second", {
      cwd: PUSH_FIXTURE,
      env: {
        ...process.env,
        GIT_AUTHOR_EMAIL: "test@test.com",
        GIT_AUTHOR_NAME: "Test",
        GIT_COMMITTER_EMAIL: "test@test.com",
        GIT_COMMITTER_NAME: "Test",
      },
    });

    const res = await studioGitReq("/__studio/git/push", "POST", {}, PUSH_FIXTURE);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
  });

  test("push with empty body works (backwards compat)", async () => {
    const urlStr = "http://localhost/__studio/git/push";
    const req = new Request(urlStr, { method: "POST" });
    const res = await handleStudioApi(req, new URL(urlStr), PUSH_FIXTURE);
    expect(res).not.toBeNull();
    expect((res as Response).status).toBe(200);
  });
});
