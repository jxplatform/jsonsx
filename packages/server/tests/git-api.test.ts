import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { parseGitStatus, handleStudioApi } from "../src/studio-api";
import { join, resolve } from "node:path";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";

// ── parseGitStatus unit tests ───────────────────────────────────────────────

describe("parseGitStatus", () => {
  test("parses branch name", () => {
    const out = "# branch.head main\n# branch.oid abc123\n";
    const result = parseGitStatus(out);
    expect(result.branch).toBe("main");
    expect(result.files).toEqual([]);
  });

  test("parses ahead/behind counts", () => {
    const out = ["# branch.oid abc123", "# branch.head feature", "# branch.ab +3 -1"].join("\n");
    const result = parseGitStatus(out);
    expect(result.branch).toBe("feature");
    expect(result.ahead).toBe(3);
    expect(result.behind).toBe(1);
  });

  test("defaults ahead/behind to 0", () => {
    const out = "# branch.head main\n";
    const result = parseGitStatus(out);
    expect(result.ahead).toBe(0);
    expect(result.behind).toBe(0);
  });

  test("parses staged modified file (type 1)", () => {
    const out = "1 M. N... 100644 100644 100644 abc123 def456 src/app.js\n";
    const result = parseGitStatus(out);
    expect(result.files).toEqual([{ path: "src/app.js", status: "M", staged: true }]);
  });

  test("parses unstaged modified file (type 1)", () => {
    const out = "1 .M N... 100644 100644 100644 abc123 def456 src/app.js\n";
    const result = parseGitStatus(out);
    expect(result.files).toEqual([{ path: "src/app.js", status: "M", staged: false }]);
  });

  test("parses file modified in both index and worktree", () => {
    const out = "1 MM N... 100644 100644 100644 abc123 def456 src/app.js\n";
    const result = parseGitStatus(out);
    expect(result.files).toHaveLength(2);
    expect(result.files[0]).toEqual({ path: "src/app.js", status: "M", staged: true });
    expect(result.files[1]).toEqual({ path: "src/app.js", status: "M", staged: false });
  });

  test("parses staged added file", () => {
    const out = "1 A. N... 000000 100644 100644 0000000 abc123 newfile.js\n";
    const result = parseGitStatus(out);
    expect(result.files).toEqual([{ path: "newfile.js", status: "A", staged: true }]);
  });

  test("parses staged deleted file", () => {
    const out = "1 D. N... 100644 000000 000000 abc123 0000000 old.js\n";
    const result = parseGitStatus(out);
    expect(result.files).toEqual([{ path: "old.js", status: "D", staged: true }]);
  });

  test("parses untracked file", () => {
    const out = "? todo.txt\n";
    const result = parseGitStatus(out);
    expect(result.files).toEqual([{ path: "todo.txt", status: "U", staged: false }]);
  });

  test("parses rename entry (type 2)", () => {
    const out = "2 R. N... 100644 100644 100644 abc123 def456 R100\told.js\tnew.js\n";
    const result = parseGitStatus(out);
    expect(result.files).toEqual([{ path: "new.js", status: "R", staged: true }]);
  });

  test("parses file paths with spaces", () => {
    const out = "1 M. N... 100644 100644 100644 abc123 def456 path with spaces/file name.js\n";
    const result = parseGitStatus(out);
    expect(result.files[0].path).toBe("path with spaces/file name.js");
  });

  test("handles empty output", () => {
    const result = parseGitStatus("");
    expect(result).toEqual({ branch: "", ahead: 0, behind: 0, files: [] });
  });

  test("parses full realistic output", () => {
    const out = [
      "# branch.oid 38d753e",
      "# branch.head main",
      "# branch.upstream origin/main",
      "# branch.ab +2 -0",
      "1 M. N... 100644 100644 100644 abc123 def456 src/index.js",
      "1 .M N... 100644 100644 100644 abc123 def456 src/utils.js",
      "1 A. N... 000000 100644 100644 0000000 abc123 src/new.js",
      "? untracked.txt",
      "",
    ].join("\n");
    const result = parseGitStatus(out);
    expect(result.branch).toBe("main");
    expect(result.ahead).toBe(2);
    expect(result.behind).toBe(0);
    expect(result.files).toHaveLength(4);
    expect(result.files[0]).toEqual({ path: "src/index.js", status: "M", staged: true });
    expect(result.files[1]).toEqual({ path: "src/utils.js", status: "M", staged: false });
    expect(result.files[2]).toEqual({ path: "src/new.js", status: "A", staged: true });
    expect(result.files[3]).toEqual({ path: "untracked.txt", status: "U", staged: false });
  });
});

// ── Git endpoint integration tests ──────────────────────────────────────────

/**
 * @param {string} path
 * @param {string} [method]
 * @param {Record<string, unknown>} [body]
 * @returns {Promise<Response>}
 */
async function studioGitReq(path: string, method: string = "GET", body?: Record<string, unknown>) {
  const urlStr = `http://localhost${path}`;
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers = { "Content-Type": "application/json" };
  }
  const res = await handleStudioApi(new Request(urlStr, init), new URL(urlStr), GIT_FIXTURE);
  if (!res) throw new Error(`No response from handleStudioApi for ${method} ${path}`);
  return res;
}

const GIT_FIXTURE = resolve(import.meta.dir, "_git_fixture");

/**
 * @param {string} cmd
 * @returns {string}
 */
function git(cmd: string) {
  return execSync(`git ${cmd}`, {
    cwd: GIT_FIXTURE,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@test.com",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@test.com",
    },
  });
}

describe("git endpoints", () => {
  beforeAll(() => {
    rmSync(GIT_FIXTURE, { recursive: true, force: true });
    mkdirSync(GIT_FIXTURE, { recursive: true });
    git("init -b main");
    git("config user.email test@test.com");
    git("config user.name Test");
    writeFileSync(join(GIT_FIXTURE, "hello.txt"), "hello");
    git("add hello.txt");
    git("commit -m initial");
  });

  afterAll(() => {
    rmSync(GIT_FIXTURE, { recursive: true, force: true });
  });

  test("GET status returns branch and empty files on clean repo", async () => {
    const res = await studioGitReq("/__studio/git/status");
    const data = /** @type {{ branch: string; files: unknown[] }} */ (await res.json());
    expect(data.branch).toBeTruthy();
    expect(data.files).toEqual([]);
  });

  test("GET status shows untracked file", async () => {
    writeFileSync(join(GIT_FIXTURE, "new.txt"), "new");
    const res = await studioGitReq("/__studio/git/status");
    const data = (await res.json()) as {
      files: { path: string; status: string; staged: boolean }[];
    };
    const untracked = data.files.find((f) => f.path === "new.txt");
    expect(untracked).toBeTruthy();
    expect(untracked?.status).toBe("U");
    expect(untracked?.staged).toBe(false);
  });

  test("POST stage adds file to index", async () => {
    const stageRes = await studioGitReq("/__studio/git/stage", "POST", { files: ["new.txt"] });
    const stageData = /** @type {{ ok: boolean }} */ (await stageRes.json());
    expect(stageData.ok).toBe(true);

    const statusRes = await studioGitReq("/__studio/git/status");
    const data = (await statusRes.json()) as {
      files: { path: string; status: string; staged: boolean }[];
    };
    const staged = data.files.find((f) => f.path === "new.txt" && f.staged);
    expect(staged).toBeTruthy();
    expect(staged?.status).toBe("A");
  });

  test("POST unstage removes file from index", async () => {
    await studioGitReq("/__studio/git/unstage", "POST", { files: ["new.txt"] });
    const res = await studioGitReq("/__studio/git/status");
    const data = (await res.json()) as {
      files: { path: string; status: string; staged: boolean }[];
    };
    const file = data.files.find((f) => f.path === "new.txt");
    expect(file?.staged).toBe(false);
  });

  test("POST commit creates a commit", async () => {
    git("add new.txt");
    const res = await studioGitReq("/__studio/git/commit", "POST", { message: "add new file" });
    const data = /** @type {{ ok: boolean; hash: string }} */ (await res.json());
    expect(data.ok).toBe(true);
    expect(data.hash).toBeTruthy();

    const statusRes = await studioGitReq("/__studio/git/status");
    const statusData = /** @type {{ files: unknown[] }} */ (await statusRes.json());
    expect(statusData.files).toEqual([]);
  });

  test("POST commit rejects empty message", async () => {
    const res = await studioGitReq("/__studio/git/commit", "POST", { message: "" });
    expect(res.status).toBe(400);
  });

  test("POST stage rejects path traversal", async () => {
    const res = await studioGitReq("/__studio/git/stage", "POST", { files: ["../etc/passwd"] });
    expect(res.status).toBe(400);
  });

  test("POST stage rejects empty files", async () => {
    const res = await studioGitReq("/__studio/git/stage", "POST", { files: [] });
    expect(res.status).toBe(400);
  });

  test("GET branches returns current branch", async () => {
    const res = await studioGitReq("/__studio/git/branches");
    const data = /** @type {{ current: string; branches: string[] }} */ (await res.json());
    expect(data.current).toBeTruthy();
    expect(data.branches).toContain(data.current);
  });

  test("POST create-branch creates and switches", async () => {
    const res = await studioGitReq("/__studio/git/create-branch", "POST", { name: "test-branch" });
    const data = /** @type {{ ok: boolean }} */ (await res.json());
    expect(data.ok).toBe(true);

    const branchRes = await studioGitReq("/__studio/git/branches");
    const branchData = /** @type {{ current: string; branches: string[] }} */ (
      await branchRes.json()
    );
    expect(branchData.current).toBe("test-branch");
    expect(branchData.branches).toContain("test-branch");
  });

  test("POST checkout switches branch", async () => {
    const res = await studioGitReq("/__studio/git/checkout", "POST", { branch: "main" });
    const data = /** @type {{ ok: boolean }} */ (await res.json());
    expect(data.ok).toBe(true);

    const branchRes = await studioGitReq("/__studio/git/branches");
    const branchData = /** @type {{ current: string }} */ (await branchRes.json());
    expect(branchData.current).toBe("main");
  });

  test("GET log returns commit history", async () => {
    const res = await studioGitReq("/__studio/git/log?limit=5");
    const data = /** @type {{ hash: string; message: string; author: string; date: string }[]} */ (
      await res.json()
    );
    expect(data.length).toBeGreaterThanOrEqual(2);
    expect(data[0].hash).toBeTruthy();
    expect(data[0].message).toBeTruthy();
    expect(data[0].author).toBe("Test");
  });

  test("GET diff returns diff for modified file", async () => {
    writeFileSync(join(GIT_FIXTURE, "hello.txt"), "hello world");
    const res = await studioGitReq("/__studio/git/diff?path=hello.txt");
    const data = /** @type {{ diff: string }} */ (await res.json());
    expect(data.diff).toContain("hello world");
  });

  test("POST discard restores file", async () => {
    await studioGitReq("/__studio/git/discard", "POST", { files: ["hello.txt"] });
    const res = await studioGitReq("/__studio/git/status");
    const data = (await res.json()) as { files: { path: string }[] };
    const modified = data.files.find((f) => f.path === "hello.txt");
    expect(modified).toBeUndefined();
  });

  test("POST push fails without remote (500)", async () => {
    const res = await studioGitReq("/__studio/git/push", "POST");
    expect(res.status).toBe(500);
    const data = (await res.json()) as any;
    expect(data.error).toBeTruthy();
  });

  test("POST pull fails without remote (500)", async () => {
    const res = await studioGitReq("/__studio/git/pull", "POST");
    expect(res.status).toBe(500);
    const data = (await res.json()) as any;
    expect(data.error).toBeTruthy();
  });

  test("POST fetch succeeds with no remotes (no-op)", async () => {
    // git fetch exits 0 when there are no remotes configured — it is a silent no-op
    const res = await studioGitReq("/__studio/git/fetch", "POST");
    expect(res.status).toBe(200);
    const data = (await res.json()) as any;
    expect(data.ok).toBe(true);
  });

  test("GET show returns file content at HEAD", async () => {
    const res = await studioGitReq("/__studio/git/show?path=hello.txt&ref=HEAD");
    expect(res.status).toBe(200);
    const data = /** @type {{ content: string; format: string }} */ (await res.json());
    expect(data.content).toBe("hello");
    expect(data.format).toBe("json");
  });

  test("GET show returns json format for .json files", async () => {
    writeFileSync(join(GIT_FIXTURE, "doc.json"), '{"tagName":"div"}');
    git("add doc.json");
    git('commit -m "add json"');
    const res = await studioGitReq("/__studio/git/show?path=doc.json&ref=HEAD");
    expect(res.status).toBe(200);
    const data = /** @type {{ content: string; format: string }} */ (await res.json());
    expect(data.content).toBe('{"tagName":"div"}');
    expect(data.format).toBe("json");
  });

  test("GET show returns markdown format for .md files", async () => {
    writeFileSync(join(GIT_FIXTURE, "page.md"), "# Hello");
    git("add page.md");
    git('commit -m "add md"');
    const res = await studioGitReq("/__studio/git/show?path=page.md&ref=HEAD");
    expect(res.status).toBe(200);
    const data = /** @type {{ content: string; format: string }} */ (await res.json());
    expect(data.content).toBe("# Hello");
    expect(data.format).toBe("markdown");
  });

  test("GET show rejects missing path parameter", async () => {
    const res = await studioGitReq("/__studio/git/show?ref=HEAD");
    expect(res.status).toBe(400);
  });

  test("GET show rejects path traversal", async () => {
    const res = await studioGitReq("/__studio/git/show?path=../etc/passwd&ref=HEAD");
    expect(res.status).toBe(400);
  });

  test("GET show fails for non-existent file", async () => {
    const res = await studioGitReq("/__studio/git/show?path=no-such-file.txt&ref=HEAD");
    expect(res.status).toBe(500);
  });

  test("GET show defaults ref to HEAD when omitted", async () => {
    const res = await studioGitReq("/__studio/git/show?path=hello.txt");
    expect(res.status).toBe(200);
    const data = /** @type {{ content: string }} */ (await res.json());
    expect(data.content).toBe("hello");
  });
});
