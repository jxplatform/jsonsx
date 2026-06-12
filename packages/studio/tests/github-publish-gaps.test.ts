/**
 * Gap coverage for src/github/github-publish.ts — the repo-options dialog template (refs,
 * confirm/cancel/close handlers, value fallbacks) which tests/github-publish.test.ts bypasses by
 * stubbing showDialog with a canned result. Here showDialog actually renders the template so the
 * dialog DOM and its event handlers execute.
 */
import "./with-dom.js";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { render as litRender } from "lit-html";

let statusMessages: string[] = [];
let refreshCalls = 0;
let dialogHosts: HTMLElement[] = [];
let authToken: string | null = "ghp_gap_token";
let remoteCalls: unknown[][] = [];
let pushCalls: unknown[][] = [];

let fetchCalls: { url: string; opts: any }[] = [];
let fetchResponses: { ok: boolean; json: unknown }[] = [];
const originalFetch = globalThis.fetch;

mock.module("../src/ui/layers.js", () => ({
  showConfirmDialog: async () => true,
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
}));

mock.module("../src/github/github-auth.js", () => ({
  authenticateGithub: async () => authToken,
  clearGithubToken: () => {},
  getGithubToken: () => authToken,
}));

mock.module("../src/platform.js", () => ({
  getPlatform: () => ({
    gitAddRemote: (...args: unknown[]) => {
      remoteCalls.push(args);
      return Promise.resolve();
    },
    gitPush: (...args: unknown[]) => {
      pushCalls.push(args);
      return Promise.resolve();
    },
  }),
  registerPlatform: () => {},
}));

mock.module("../src/panels/git-panel.js", () => ({
  cleanupGitPanel: () => {},
  cloneRepository: async () => {},
  platformSupportsClone: () => false,
  refreshGitStatus: async () => {
    refreshCalls += 1;
  },
  renderGitPanel: () => null,
}));

mock.module("../src/panels/statusbar.js", () => ({
  statusMessage: (msg: string) => statusMessages.push(msg),
}));

const { publishToGithub } = await import("../src/github/github-publish.js");

async function flush(turns = 3) {
  for (let i = 0; i < turns; i++) {
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
  }
}

function stubFetch(responses: { ok: boolean; json: unknown }[]) {
  fetchResponses = [...responses];
  fetchCalls = [];
  // @ts-expect-error -- minimal fetch mock does not implement the full fetch type
  globalThis.fetch = async (url: any, opts: any) => {
    fetchCalls.push({ opts, url: String(url) });
    const next = fetchResponses.shift();
    if (!next) {
      throw new Error(`Unexpected fetch to ${url}`);
    }
    return { json: async () => next.json, ok: next.ok, status: next.ok ? 201 : 422 };
  };
}

/** Start the publish flow and wait for the dialog to appear. */
async function openPublishDialog(projectName = "proj") {
  const promise = publishToGithub({ projectName });
  await flush();
  const host = dialogHosts.at(-1)!;
  expect(host).toBeTruthy();
  return { host, promise, wrapper: host.querySelector("sp-dialog-wrapper")! };
}

beforeEach(() => {
  statusMessages = [];
  refreshCalls = 0;
  remoteCalls = [];
  pushCalls = [];
  authToken = "ghp_gap_token";
  for (const host of dialogHosts) {
    host.remove();
  }
  dialogHosts = [];
  stubFetch([]);
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("publishToGithub dialog", () => {
  test("confirm with edited fields creates the repo with those values", async () => {
    stubFetch([
      {
        json: {
          clone_url: "https://github.com/u/custom-repo.git",
          html_url: "https://github.com/u/custom-repo",
        },
        ok: true,
      },
    ]);
    const { host, promise, wrapper } = await openPublishDialog("proj");

    (host.querySelector("#repo-name") as any).value = "custom-repo";
    (host.querySelector("#repo-desc") as any).value = "My description";
    (host.querySelector("sp-switch") as any).checked = false;
    wrapper.dispatchEvent(new Event("confirm"));

    const result = await promise;
    expect(result).toBe(true);
    expect(fetchCalls.length).toBe(1);
    const body = JSON.parse(fetchCalls[0]!.opts.body);
    expect(body).toEqual({
      auto_init: false,
      description: "My description",
      name: "custom-repo",
      private: false,
    });
    expect(fetchCalls[0]!.opts.headers.Authorization).toBe("Bearer ghp_gap_token");
    expect(remoteCalls).toEqual([["origin", "https://github.com/u/custom-repo.git"]]);
    expect(pushCalls).toEqual([[{ setUpstream: true }]]);
    expect(refreshCalls).toBe(1);
    expect(
      statusMessages.some((m) =>
        m.includes("Published to GitHub: https://github.com/u/custom-repo"),
      ),
    ).toBe(true);
  });

  test("confirm with untouched fields falls back to project name and private repo", async () => {
    stubFetch([
      {
        json: { clone_url: "https://github.com/u/proj.git", html_url: "https://github.com/u/proj" },
        ok: true,
      },
    ]);
    const { host, promise, wrapper } = await openPublishDialog("proj");

    // The name field is pre-filled via attribute from the project name.
    expect(host.querySelector("#repo-name")!.getAttribute("value")).toBe("proj");

    wrapper.dispatchEvent(new Event("confirm"));
    const result = await promise;
    expect(result).toBe(true);
    const body = JSON.parse(fetchCalls[0]!.opts.body);
    expect(body.name).toBe("proj");
    expect(body.description).toBe("");
    expect(body.private).toBe(true);
  });

  test("cancel resolves false without any API call", async () => {
    const { promise, wrapper } = await openPublishDialog();
    wrapper.dispatchEvent(new Event("cancel"));
    expect(await promise).toBe(false);
    expect(fetchCalls).toEqual([]);
    expect(remoteCalls).toEqual([]);
  });

  test("close resolves false without any API call", async () => {
    const { promise, wrapper } = await openPublishDialog();
    wrapper.dispatchEvent(new Event("close"));
    expect(await promise).toBe(false);
    expect(fetchCalls).toEqual([]);
  });

  test("API error without field errors falls back to top-level message", async () => {
    stubFetch([{ json: { message: "nope" }, ok: false }]);
    const { promise, wrapper } = await openPublishDialog();
    wrapper.dispatchEvent(new Event("confirm"));
    expect(await promise).toBe(false);
    expect(statusMessages).toContain("Error: nope");
    expect(remoteCalls).toEqual([]);
  });

  test("API error without any message uses the generic fallback", async () => {
    stubFetch([{ json: {}, ok: false }]);
    const { promise, wrapper } = await openPublishDialog();
    wrapper.dispatchEvent(new Event("confirm"));
    expect(await promise).toBe(false);
    expect(statusMessages).toContain("Error: Failed to create repository");
  });

  test("no token short-circuits before showing the dialog", async () => {
    authToken = null;
    const result = await publishToGithub({ projectName: "proj" });
    expect(result).toBe(false);
    expect(dialogHosts).toEqual([]);
    expect(fetchCalls).toEqual([]);
  });
});
