import "./with-dom.js";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { StudioPlatform } from "../src/types";

if (globalThis.localStorage === undefined) {
  const store = new Map();
  globalThis.localStorage = {
    clear: () => store.clear(),
    getItem: (k: string) => store.get(k) ?? null,
    removeItem: (k: string) => store.delete(k),
    setItem: (k: string, v: string) => store.set(k, v),
  } as any;
}

const STORAGE_KEY = "jx_github_token";

let mockFetchResponses: { ok?: boolean; json: unknown; status?: number }[] = [];
let mockFetchCalls: {
  url: string;
  opts: { body: string; headers: Record<string, string> };
}[] = [];
const originalFetch = globalThis.fetch;

/** @param {{ ok?: boolean; json: unknown; status?: number }[]} responses */
function setupFetch(responses: { ok?: boolean; json: unknown; status?: number }[]) {
  mockFetchResponses = [...responses];
  mockFetchCalls = [];
  // @ts-expect-error -- minimal fetch mock does not implement the full fetch type
  globalThis.fetch = async (url: any, opts: any) => {
    mockFetchCalls.push({ opts, url: String(url) });
    const next = mockFetchResponses.shift();
    if (!next) {
      throw new Error(`Unexpected fetch to ${url}`);
    }
    return {
      json: async () => next.json,
      ok: next.ok ?? true,
      status: next.status ?? 200,
    };
  };
}

let mockPlatform: Partial<StudioPlatform>;
let statusMessages: string[] = [];
let showDialogResult: any = null;

void mock.module("../src/ui/layers.js", () => ({
  showConfirmDialog: async () => true,
  showDialog: async () => showDialogResult,
}));

void mock.module("../src/github/github-auth.js", () => ({
  authenticateGithub: async () => localStorage.getItem(STORAGE_KEY),
  clearGithubToken: () => localStorage.removeItem(STORAGE_KEY),
  getGithubToken: () => localStorage.getItem(STORAGE_KEY),
}));

void mock.module("../src/platform.js", () => ({
  getPlatform: () => mockPlatform,
  registerPlatform: () => {},
}));

void mock.module("../src/panels/git-panel.js", () => ({
  platformSupportsClone: () => false,
  refreshGitStatus: async () => {},
  renderGitPanel: () => null,
}));

void mock.module("../src/panels/statusbar.js", () => ({
  statusMessage: (msg: string) => statusMessages.push(msg),
}));

const { publishToGithub } = await import("../src/github/github-publish.js");

describe("publishToGithub", () => {
  beforeEach(() => {
    localStorage.removeItem(STORAGE_KEY);
    statusMessages = [];
    showDialogResult = null;
    mockPlatform = {
      gitAddRemote: mock(() => Promise.resolve()),
      gitPush: mock(() => Promise.resolve()),
    };
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("returns false when auth returns no token", async () => {
    const result = await publishToGithub({ projectName: "test-project" });
    expect(result).toBe(false);
  });

  test("returns false when repo dialog is cancelled", async () => {
    localStorage.setItem(STORAGE_KEY, "ghp_test_token");
    showDialogResult = null;
    const result = await publishToGithub({ projectName: "test-project" });
    expect(result).toBe(false);
  });

  test("creates repo, adds remote, and pushes on success", async () => {
    localStorage.setItem(STORAGE_KEY, "ghp_test_token");
    showDialogResult = {
      description: "A test",
      isPrivate: true,
      name: "my-repo",
    };

    setupFetch([
      {
        json: {
          clone_url: "https://github.com/user/my-repo.git",
          html_url: "https://github.com/user/my-repo",
        },
        ok: true,
      },
    ]);

    const result = await publishToGithub({ projectName: "test-project" });
    expect(result).toBe(true);

    expect(mockFetchCalls[0]!.url).toBe("https://api.github.com/user/repos");
    const body = JSON.parse(mockFetchCalls[0]!.opts.body);
    expect(body.name).toBe("my-repo");
    expect(body.private).toBe(true);
    expect(body.auto_init).toBe(false);

    const authHeader = mockFetchCalls[0]!.opts.headers.Authorization;
    expect(authHeader).toBe("Bearer ghp_test_token");

    expect(mockPlatform.gitAddRemote).toHaveBeenCalledWith(
      "origin",
      "https://github.com/user/my-repo.git",
    );
    expect(mockPlatform.gitPush).toHaveBeenCalledWith({ setUpstream: true });
    expect(statusMessages.some((m) => m.includes("Published to GitHub"))).toBe(true);
  });

  test("returns false and reports error when GitHub API fails", async () => {
    localStorage.setItem(STORAGE_KEY, "ghp_test_token");
    showDialogResult = { description: "", isPrivate: false, name: "my-repo" };

    setupFetch([
      {
        json: {
          errors: [{ message: "name already exists" }],
          message: "Validation Failed",
        },
        ok: false,
        status: 422,
      },
    ]);

    const result = await publishToGithub({ projectName: "test" });
    expect(result).toBe(false);
    expect(statusMessages.some((m) => m.includes("name already exists"))).toBe(true);
  });

  test("returns false when push fails", async () => {
    localStorage.setItem(STORAGE_KEY, "ghp_test_token");
    showDialogResult = {
      description: "",
      isPrivate: true,
      name: "push-fail-repo",
    };
    mockPlatform.gitPush = mock(() => Promise.reject(new Error("push rejected")));

    setupFetch([
      {
        json: {
          clone_url: "https://github.com/user/push-fail-repo.git",
          html_url: "https://github.com/user/push-fail-repo",
        },
        ok: true,
      },
    ]);

    const result = await publishToGithub({ projectName: "test" });
    expect(result).toBe(false);
    expect(statusMessages.some((m) => m.includes("Push failed"))).toBe(true);
  });

  test("sends correct Accept header to GitHub API", async () => {
    localStorage.setItem(STORAGE_KEY, "ghp_test_token");
    showDialogResult = {
      description: "desc",
      isPrivate: false,
      name: "header-test",
    };

    setupFetch([
      {
        json: {
          clone_url: "https://github.com/user/header-test.git",
          html_url: "https://github.com/user/header-test",
        },
        ok: true,
      },
    ]);

    await publishToGithub({ projectName: "test" });
    expect(mockFetchCalls.length).toBeGreaterThan(0);
    expect(mockFetchCalls[0]!.opts.headers.Accept).toBe("application/vnd.github+json");
  });
});
