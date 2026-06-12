import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { handleStudioApi } from "../src/studio-api";
import { join, resolve } from "node:path";
import { execSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";

const FIXTURES = resolve(import.meta.dir, "_git_gaps_fixtures");
const REPO = join(FIXTURES, "repo");
const WORKSPACE = join(FIXTURES, "workspace");

function git(cmd: string, cwd: string = REPO) {
  return execSync(`git ${cmd}`, { cwd, encoding: "utf8", stdio: "pipe" });
}

async function gitReq(path: string, method = "GET", body?: unknown) {
  const url = new URL(`http://localhost${path}`);
  const req = new Request(url, {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const res = await handleStudioApi(req, url, REPO, null);
  if (!res) {
    throw new Error("handleStudioApi returned null");
  }
  return res;
}

beforeAll(() => {
  rmSync(FIXTURES, { force: true, recursive: true });
  mkdirSync(REPO, { recursive: true });
  mkdirSync(WORKSPACE, { recursive: true });
  git("init -b main");
  git("config user.email test@test.com");
  git("config user.name Test");
  writeFileSync(join(REPO, "tracked.txt"), "original content\n");
  git("add tracked.txt");
  git("commit -m initial");
});

afterAll(() => {
  rmSync(FIXTURES, { force: true, recursive: true });
});

describe("git validation — gaps", () => {
  test("unstage rejects missing files", async () => {
    const res = await gitReq("/__studio/git/unstage", "POST", { files: [] });
    expect(res.status).toBe(400);
    const payload = await res.json();
    expect(payload.error).toBe("Missing files");
  });

  test("checkout rejects missing branch", async () => {
    const res = await gitReq("/__studio/git/checkout", "POST", {});
    expect(res.status).toBe(400);
    const payload = await res.json();
    expect(payload.error).toBe("Missing branch");
  });

  test("create-branch rejects missing name", async () => {
    const res = await gitReq("/__studio/git/create-branch", "POST", {});
    expect(res.status).toBe(400);
    const payload = await res.json();
    expect(payload.error).toBe("Missing name");
  });

  test("diff rejects missing path", async () => {
    const res = await gitReq("/__studio/git/diff");
    expect(res.status).toBe(400);
    const payload = await res.json();
    expect(payload.error).toBe("Missing path");
  });

  test("diff rejects traversal paths", async () => {
    const res = await gitReq("/__studio/git/diff?path=../evil.txt");
    expect(res.status).toBe(400);
    const payload = await res.json();
    expect(payload.error).toBe("Invalid path");
  });

  test("discard rejects missing files", async () => {
    const res = await gitReq("/__studio/git/discard", "POST", { files: [] });
    expect(res.status).toBe(400);
    const payload = await res.json();
    expect(payload.error).toBe("Missing files");
  });

  test("discard rejects traversal paths", async () => {
    const res = await gitReq("/__studio/git/discard", "POST", { files: ["../evil.txt"] });
    expect(res.status).toBe(400);
    const payload = await res.json();
    expect(payload.error).toBe("Invalid path");
  });
});

describe("git discard", () => {
  test("restores modified files to HEAD content", async () => {
    writeFileSync(join(REPO, "tracked.txt"), "dirty edit\n");
    const res = await gitReq("/__studio/git/discard", "POST", { files: ["tracked.txt"] });
    expect(res.status).toBe(200);
    const payload = await res.json();
    expect(payload.ok).toBe(true);
    expect(readFileSync(join(REPO, "tracked.txt"), "utf8")).toBe("original content\n");
  });
});

describe("git clone", () => {
  test("rejects missing url", async () => {
    const res = await gitReq("/__studio/git/clone", "POST", {});
    expect(res.status).toBe(400);
    const payload = await res.json();
    expect(payload.error).toBe("Missing url");
  });

  test("clones a local repository into the project root", async () => {
    // Clone the fixture repo into the workspace via activeProjectRoot
    const url = new URL("http://localhost/__studio/git/clone");
    const req = new Request(url, { body: JSON.stringify({ url: REPO }), method: "POST" });
    const res = await handleStudioApi(req, url, FIXTURES, WORKSPACE);
    if (!res) {
      throw new Error("handleStudioApi returned null");
    }
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.root).toBe(join(WORKSPACE, "repo"));
    expect(readFileSync(join(WORKSPACE, "repo", "tracked.txt"), "utf8")).toBe("original content\n");
  });

  test("returns 500 when the clone source does not exist", async () => {
    const res = await gitReq("/__studio/git/clone", "POST", {
      url: join(FIXTURES, "no-such-repo"),
    });
    expect(res.status).toBe(500);
    const payload = await res.json();
    expect(payload.error).toBeDefined();
  });
});
