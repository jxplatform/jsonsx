import "./harness";
import { afterEach, describe, expect, mock, test } from "bun:test";
import {
  createCloudPlatform,
  editUrl,
  parseEditPath,
  parseRootKey,
  projectRootKey,
  sessionBase,
} from "../src/platforms/cloud";

const PROJECT = { owner: "octocat", repo: "my-site", branch: "main" };
const BASE = "/api/v1/p/octocat/my-site/main/studio";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

interface Call {
  url: string;
  init?: RequestInit | undefined;
}

/** Route fetches by URL substring; unmatched calls get an empty 200. */
function mockFetch(routes: Record<string, { status?: number; body: unknown }> = {}): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = ((url: string, init?: RequestInit) => {
    calls.push({ url, init });
    for (const [needle, response] of Object.entries(routes)) {
      if (url.includes(needle)) {
        return Promise.resolve(Response.json(response.body, { status: response.status ?? 200 }));
      }
    }
    return Promise.resolve(Response.json({}));
  }) as unknown as typeof fetch;
  return calls;
}

describe("URL helpers", () => {
  test("sessionBase encodes each segment", () => {
    expect(sessionBase({ owner: "o", repo: "r", branch: "feat/x" })).toBe(
      "/api/v1/p/o/r/feat%2Fx/studio",
    );
  });

  test("editUrl and parseEditPath round-trip", () => {
    const url = editUrl(PROJECT);
    expect(url).toBe("/edit/octocat/my-site@main");
    expect(parseEditPath(url)).toEqual(PROJECT);
  });

  test("parseEditPath handles branch names with slashes and rejects non-edit paths", () => {
    expect(parseEditPath("/edit/o/r@feat/nested")).toEqual({
      owner: "o",
      repo: "r",
      branch: "feat/nested",
    });
    expect(parseEditPath("/")).toBeNull();
    expect(parseEditPath("/edit/only-owner")).toBeNull();
  });

  test("parseEditPath accepts the asset router's %40 normalization of @", () => {
    expect(parseEditPath("/edit/octocat/my-site%40main")).toEqual(PROJECT);
  });
});

describe("project binding", () => {
  test("openProject returns the pre-bound project from project-info", async () => {
    mockFetch({
      "/project-info": {
        body: {
          root: "octocat/my-site",
          name: "my-site",
          defaultBranch: "main",
          permission: "write",
          projectConfig: { name: "My Site" },
        },
      },
    });
    const platform = createCloudPlatform(PROJECT);
    const opened = await platform.openProject();
    expect(opened?.config.name).toBe("My Site");
    expect(opened?.handle.root).toBe("octocat/my-site");
  });

  test("open-project picking routes through the studio repo picker in both modes", () => {
    expect(createCloudPlatform(PROJECT).openProjectPicker).toBe("repo-list");
    expect(createCloudPlatform(null).openProjectPicker).toBe("repo-list");
  });

  test("probeRootProject reports a non-jx repo as not a site project", async () => {
    mockFetch({
      "/project-info": {
        body: {
          root: "octocat/my-site",
          name: "my-site",
          defaultBranch: "main",
          permission: "read",
          projectConfig: null,
        },
      },
    });
    const platform = createCloudPlatform(PROJECT);
    const probe = await platform.probeRootProject();
    expect(probe?.info.isSiteProject).toBe(false);
    expect(probe?.meta.name).toBe("my-site");
  });
});

describe("file operations", () => {
  test("readFile unwraps content and readFile errors surface the server message", async () => {
    mockFetch({
      "path=pages%2Findex.md": { body: { content: "# Hi" } },
      "path=missing.md": { status: 404, body: { error: "No such file: missing.md" } },
    });
    const platform = createCloudPlatform(PROJECT);
    expect(await platform.readFile("pages/index.md")).toBe("# Hi");
    expect(platform.readFile("missing.md")).rejects.toThrow("No such file: missing.md");
  });

  test("writeFile PUTs a JSON body against the session base", async () => {
    const calls = mockFetch({ "/file": { body: { ok: true } } });
    const platform = createCloudPlatform(PROJECT);
    await platform.writeFile("pages/a.md", "hello");
    expect(calls[0]?.url).toBe(`${BASE}/file`);
    expect(calls[0]?.init?.method).toBe("PUT");
    expect(JSON.parse(calls[0]?.init?.body as string)).toEqual({
      path: "pages/a.md",
      content: "hello",
    });
  });

  test("deleteFile tolerates 404", async () => {
    mockFetch({ "/file?path=": { status: 404, body: { error: "gone" } } });
    const platform = createCloudPlatform(PROJECT);
    await platform.deleteFile("gone.md");
  });
});

describe("manifest-only package operations", () => {
  const manifest = (deps: Record<string, string>, devDeps: Record<string, string> = {}) => ({
    "/file?path=package.json": {
      body: { content: JSON.stringify({ dependencies: deps, devDependencies: devDeps }) },
    },
  });

  test("listPackages parses dependencies and devDependencies", async () => {
    mockFetch(manifest({ hono: "^4" }, { wrangler: "^4" }));
    const platform = createCloudPlatform(PROJECT);
    expect(await platform.listPackages()).toEqual([
      { name: "hono", version: "^4" },
      { name: "wrangler", version: "^4", dev: true },
    ]);
  });

  test("addPackage writes the dependency and parses scoped@version specs", async () => {
    const calls = mockFetch(manifest({}));
    const platform = createCloudPlatform(PROJECT);
    await platform.addPackage("@jxsuite/compiler@0.34.0");
    const write = calls.find((call) => call.init?.method === "PUT");
    const body = JSON.parse(write?.init?.body as string) as { content: string };
    const written = JSON.parse(body.content) as { dependencies: Record<string, string> };
    expect(written.dependencies["@jxsuite/compiler"]).toBe("0.34.0");
  });

  test("addPackage defaults bare names to latest", async () => {
    const calls = mockFetch(manifest({}));
    const platform = createCloudPlatform(PROJECT);
    await platform.addPackage("hono");
    const write = calls.find((call) => call.init?.method === "PUT");
    const body = JSON.parse(write?.init?.body as string) as { content: string };
    expect(
      (JSON.parse(body.content) as { dependencies: Record<string, string> }).dependencies,
    ).toEqual({ hono: "latest" });
  });

  test("removePackage drops the entry from either section", async () => {
    const calls = mockFetch(manifest({ hono: "^4" }, { wrangler: "^4" }));
    const platform = createCloudPlatform(PROJECT);
    await platform.removePackage("wrangler");
    const write = calls.find((call) => call.init?.method === "PUT");
    const body = JSON.parse(write?.init?.body as string) as { content: string };
    const written = JSON.parse(body.content) as {
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    expect(written.dependencies).toEqual({ hono: "^4" });
    expect(written.devDependencies).toEqual({});
  });
});

describe("git surface", () => {
  test("gitCommit posts the message and surfaces conflict errors", async () => {
    mockFetch({
      "/git/commit": {
        status: 409,
        body: { error: "Remote branch moved; fetch and retry", code: "remote_moved" },
      },
    });
    const platform = createCloudPlatform(PROJECT);
    expect(platform.gitCommit("msg")).rejects.toThrow("Remote branch moved");
  });

  test("gitDiff unwraps the patch text", async () => {
    mockFetch({ "/git/diff": { body: { diff: "--- a/x\n+++ b/x\n" } } });
    const platform = createCloudPlatform(PROJECT);
    expect(await platform.gitDiff()).toBe("--- a/x\n+++ b/x\n");
  });

  test("aiChatUrl points at the platform Workers AI proxy", () => {
    const platform = createCloudPlatform(PROJECT);
    expect(platform.aiChatUrl()).toBe("/api/v1/ai/chat");
  });
});

describe("root keys", () => {
  test("projectRootKey/parseRootKey round-trip, including branch slashes", () => {
    const project = { owner: "octocat", repo: "site", branch: "feat/x" };
    expect(parseRootKey(projectRootKey(project))).toEqual(project);
  });

  test("parseRootKey rejects malformed keys", () => {
    expect(parseRootKey("no-branch")).toBeNull();
    expect(parseRootKey("owner-only@main")).toBeNull();
    expect(parseRootKey("a/b/c@main")).toBeNull();
  });
});

describe("project catalogue", () => {
  test("listProjects maps platform projects to catalogue root keys", async () => {
    mockFetch({
      "/api/v1/projects": {
        body: [
          {
            fullName: "octocat/site",
            owner: "octocat",
            name: "site",
            defaultBranch: "main",
            permission: "admin",
          },
        ],
      },
    });
    const p = createCloudPlatform(null);
    expect(await p.listProjects?.()).toEqual([
      { name: "octocat/site", root: "octocat/site@main", description: "main · admin" },
    ]);
  });

  test("listProjects and listStarters return [] on error responses", async () => {
    mockFetch({
      "/api/v1/projects": { status: 500, body: { error: "boom" } },
      "/api/v1/starters": { status: 500, body: { error: "boom" } },
    });
    const p = createCloudPlatform(null);
    expect(await p.listProjects?.()).toEqual([]);
    expect(await p.listStarters?.()).toEqual([]);
  });

  test("listStarters passes the platform starter meta through", async () => {
    const starter = {
      id: "blank",
      name: "Blank",
      industry: "General",
      tagline: "t",
      description: "d",
      features: [],
      accent: "#3b82f6",
      thumbnail: "",
    };
    mockFetch({ "/api/v1/starters": { body: [starter] } });
    const p = createCloudPlatform(null);
    expect(await p.listStarters?.()).toEqual([starter]);
  });

  test("the platform collects a repository destination, not a folder", () => {
    expect(createCloudPlatform(null).createDestination).toBe("repo");
    expect(createCloudPlatform(PROJECT).createDestination).toBe("repo");
  });

  test("createProject posts the chosen repository plus the starter selection", async () => {
    const calls = mockFetch({
      "/api/v1/projects": {
        body: { owner: "octocat", name: "my-site", defaultBranch: "main" },
      },
    });
    const p = createCloudPlatform(null);
    const created = await p.createProject({
      name: "My Site",
      description: "hello",
      directory: "my-site",
      destination: { kind: "repo", owner: "octocat", repo: "my-site", private: true },
      starter: "portfolio",
    });
    expect(created.root).toBe("octocat/my-site@main");
    expect(created.config.name).toBe("My Site");
    const post = calls.find((c) => c.init?.method === "POST");
    expect(JSON.parse(String(post?.init?.body))).toEqual({
      name: "My Site",
      description: "hello",
      starter: "portfolio",
      owner: "octocat",
      repo: "my-site",
      private: true,
    });
  });

  test("createProject keys the created project off the SERVER's repo, not the request", async () => {
    // The API may slugify the requested name and pick its own default branch.
    mockFetch({
      "/api/v1/projects": {
        body: { owner: "acme-org", name: "my-site", defaultBranch: "trunk" },
      },
    });
    const p = createCloudPlatform(null);
    const created = await p.createProject({
      name: "My Site",
      directory: "my-site",
      destination: { kind: "repo", owner: "acme-org", repo: "My Site!", private: false },
    });
    expect(created.root).toBe("acme-org/my-site@trunk");
  });

  test("createProject refuses a destination that names no repository", () => {
    const calls = mockFetch({
      "/api/v1/projects": {
        body: { owner: "octocat", name: "my-site", defaultBranch: "main" },
      },
    });
    const p = createCloudPlatform(null);
    // A folder destination belongs to a "path" platform; cloud writes to a repository.
    expect(
      p.createProject({
        name: "My Site",
        directory: "my-site",
        destination: { kind: "path", parent: "/home/dev/Sites" },
      }),
    ).rejects.toThrow("A destination repository is required.");
    expect(
      p.createProject({
        name: "My Site",
        directory: "my-site",
        destination: { kind: "repo", owner: "", repo: "my-site", private: false },
      }),
    ).rejects.toThrow("A destination repository is required.");
    expect(
      p.createProject({
        name: "My Site",
        directory: "my-site",
        destination: { kind: "repo", owner: "octocat", repo: "", private: false },
      }),
    ).rejects.toThrow("A destination repository is required.");
    // Nothing was created server-side.
    expect(calls).toHaveLength(0);
  });

  test("createProject surfaces the server's error message", async () => {
    mockFetch({
      "/api/v1/projects": {
        status: 403,
        body: { error: "GitHub blocked repository creation", code: "needs_installation_access" },
      },
    });
    const p = createCloudPlatform(null);
    expect(
      p.createProject({
        name: "X",
        directory: "x",
        destination: { kind: "repo", owner: "octocat", repo: "x", private: false },
      }),
    ).rejects.toThrow(/GitHub blocked repository creation/);
  });
});

describe("project-less mode (/studio)", () => {
  test("open/probe/activate resolve empty without touching the network", async () => {
    const calls = mockFetch();
    const p = createCloudPlatform(null);
    await p.activate();
    expect(await p.openProject()).toBeNull();
    expect(await p.probeRootProject()).toBeNull();
    expect(calls).toHaveLength(0);
  });

  test("session-bound methods reject with a clear error", async () => {
    mockFetch();
    const p = createCloudPlatform(null);
    expect(p.readFile("project.json")).rejects.toThrow(/No project is open/);
    expect(p.gitStatus()).rejects.toThrow(/No project is open/);
  });

  test("setWindowProject reports deduped so callers stop after navigation", async () => {
    mockFetch();
    const p = createCloudPlatform(null);
    expect(await p.setWindowProject?.("octocat/site@main")).toEqual({
      deduped: true,
      config: null,
    });
  });
});

describe("identity & cloudflare surface", () => {
  test("getUser maps the platform identity and nulls on 401", async () => {
    mockFetch({
      "/api/v1/me": {
        body: { user: { login: "octocat", name: "Octo Cat", avatar_url: "https://a/i.png" } },
      },
    });
    const p = createCloudPlatform(null);
    expect(await p.getUser?.()).toEqual({
      login: "octocat",
      name: "Octo Cat",
      avatarUrl: "https://a/i.png",
    });

    mockFetch({ "/api/v1/me": { status: 401, body: { error: "nope" } } });
    expect(await p.getUser?.()).toBeNull();
  });

  test("createPullRequest posts against the bound session", async () => {
    const calls = mockFetch({
      "/git/pr": { body: { url: "https://github.com/o/r/pull/7", number: 7 } },
    });
    const p = createCloudPlatform(PROJECT);
    const pr = await p.createPullRequest?.({ title: "Propose changes" });
    expect(pr).toEqual({ url: "https://github.com/o/r/pull/7", number: 7 });
    expect(calls[0]?.url).toBe(`${BASE}/git/pr`);
  });

  test("listRepos maps the installation-repo browse list", async () => {
    mockFetch({
      "/api/v1/repos": {
        body: [
          {
            repoId: 9,
            owner: "acme",
            name: "site",
            fullName: "acme/site",
            private: true,
            defaultBranch: "main",
            permission: "write",
            isJxProject: false,
            pushedAt: "2026-07-01T00:00:00Z",
          },
        ],
      },
    });
    const p = createCloudPlatform(null);
    expect(await p.listRepos?.()).toEqual([
      {
        owner: "acme",
        name: "site",
        fullName: "acme/site",
        private: true,
        defaultBranch: "main",
        permission: "write",
        isJxProject: false,
      },
    ]);

    mockFetch({ "/api/v1/repos": { status: 401, body: { error: "sign in again" } } });
    expect(p.listRepos?.()).rejects.toThrow(/sign in again/);
  });

  test("importProject resolves the catalogue root key; failures carry the backend message", async () => {
    const calls = mockFetch({
      "/api/v1/projects/import": {
        body: { repoId: 9, root: "acme/site", owner: "acme", name: "site", defaultBranch: "main" },
      },
    });
    const p = createCloudPlatform(null);
    expect(await p.importProject?.({ owner: "acme", name: "site" })).toEqual({
      root: "acme/site@main",
    });
    expect(calls[0]?.url).toBe("/api/v1/projects/import");

    mockFetch({
      "/api/v1/projects/import": {
        status: 422,
        body: { error: "acme/plain has no readable project.json", code: "not_jx_project" },
      },
    });
    expect(p.importProject?.({ owner: "acme", name: "plain" })).rejects.toThrow(
      /no readable project.json/,
    );
  });

  test("getAccountStatus surfaces installations + install URL, null on failure", async () => {
    mockFetch({
      "/api/v1/me": {
        body: {
          user: { login: "octocat" },
          installations: [{ id: 1, account: "octocat" }],
          appInstallUrl: "https://github.com/apps/jx-suite/installations/new",
        },
      },
    });
    const p = createCloudPlatform(null);
    expect(await p.getAccountStatus?.()).toEqual({
      installations: [{ id: 1, account: "octocat" }],
      appInstallUrl: "https://github.com/apps/jx-suite/installations/new",
    });

    mockFetch({ "/api/v1/me": { status: 401, body: { error: "nope" } } });
    expect(await p.getAccountStatus?.()).toBeNull();
  });

  test("getAccountStatus carries each installation's manage URL through", async () => {
    mockFetch({
      "/api/v1/me": {
        body: {
          user: { login: "octocat" },
          installations: [
            {
              id: 1,
              account: "octocat",
              manageUrl: "https://github.com/settings/installations/1",
            },
            { id: 2, account: "acme" },
          ],
          appInstallUrl: "https://github.com/apps/jx-suite/installations/new",
        },
      },
    });
    expect(await createCloudPlatform(null).getAccountStatus?.()).toEqual({
      installations: [
        { id: 1, account: "octocat", manageUrl: "https://github.com/settings/installations/1" },
        { id: 2, account: "acme" },
      ],
      appInstallUrl: "https://github.com/apps/jx-suite/installations/new",
    });
  });

  test("createProject preserves the structured needs_installation_access failure", async () => {
    mockFetch({
      "/api/v1/projects": {
        status: 403,
        body: {
          error: "GitHub blocked repository creation for this app installation.",
          code: "needs_installation_access",
          installUrl: "https://github.com/apps/jx-suite/installations/new",
        },
      },
    });
    const p = createCloudPlatform(null);
    const failure = await p
      .createProject({
        directory: "site",
        name: "Site",
        destination: { kind: "repo", owner: "acme", repo: "site", private: false },
      })
      .then(() => null)
      .catch((error: unknown) => error as Error & { code?: string; installUrl?: string });
    expect(failure?.message).toContain("blocked repository creation");
    expect(failure?.code).toBe("needs_installation_access");
    expect(failure?.installUrl).toBe("https://github.com/apps/jx-suite/installations/new");
  });

  test("cfConnection maps the brokered connection and nulls when absent", async () => {
    mockFetch({
      "/api/v1/cf/connection": {
        body: { connected: true, accountId: "acct", accountName: "Acme" },
      },
    });
    const p = createCloudPlatform(null);
    expect(await p.cfConnection?.()).toEqual({
      connected: true,
      accountId: "acct",
      accountName: "Acme",
    });

    mockFetch({ "/api/v1/cf/connection": { body: { connected: false } } });
    expect(await p.cfConnection?.()).toBeNull();

    mockFetch({ "/api/v1/cf/connection": { status: 500, body: {} } });
    expect(await p.cfConnection?.()).toBeNull();
  });

  test("cfApi unwraps the envelope and surfaces joined error messages", async () => {
    const calls = mockFetch({
      "/api/v1/cf/proxy/accounts": { body: { success: true, result: [{ id: "a1" }] } },
    });
    const p = createCloudPlatform(null);
    expect(await p.cfApi?.("/accounts")).toEqual([{ id: "a1" }]);
    expect(calls[0]?.url).toBe("/api/v1/cf/proxy/accounts");

    mockFetch({
      "/api/v1/cf/proxy": {
        status: 403,
        body: { success: false, errors: [{ message: "denied" }, { message: "scope" }] },
      },
    });
    expect(p.cfApi?.("/accounts")).rejects.toThrow(/denied; scope/);
  });

  test("cfConnect falls back to a full-page redirect when the popup is blocked", async () => {
    mockFetch({});
    const realOpen = window.open;
    (window as { open: unknown }).open = mock(() => null);
    try {
      const p = createCloudPlatform(null);
      expect(await p.cfConnect?.()).toBeNull();
    } finally {
      (window as { open: unknown }).open = realOpen;
    }
  });

  test("cfConnect resolves on the home shell's jx-cf success relay", async () => {
    mockFetch({
      "/api/v1/cf/connection": { body: { connected: true, accountId: "acct" } },
    });
    const realOpen = window.open;
    const popup = { close: mock(() => {}), closed: false };
    (window as { open: unknown }).open = mock(() => popup);
    try {
      const p = createCloudPlatform(null);
      const pending = p.cfConnect?.();
      // Foreign-source noise is ignored; the jx-cf relay settles the promise.
      window.dispatchEvent(
        new MessageEvent("message", { data: { source: "other" }, origin: location.origin }),
      );
      window.dispatchEvent(
        new MessageEvent("message", {
          data: { source: "jx-cf", status: "connected", reason: null },
          origin: location.origin,
        }),
      );
      expect(await pending).toEqual({ connected: true, accountId: "acct" });
    } finally {
      (window as { open: unknown }).open = realOpen;
    }
  });

  test("cfConnect rejects with the relayed OAuth error reason", async () => {
    mockFetch({});
    const realOpen = window.open;
    const popup = { close: mock(() => {}), closed: false };
    (window as { open: unknown }).open = mock(() => popup);
    try {
      const p = createCloudPlatform(null);
      const pending = p.cfConnect?.();
      window.dispatchEvent(
        new MessageEvent("message", {
          data: {
            source: "jx-cf",
            status: "error",
            reason: "The OAuth 2.0 Client is not allowed to request scope 'offline_access'.",
          },
          origin: location.origin,
        }),
      );
      expect(pending).rejects.toThrow(/offline_access/);
    } finally {
      (window as { open: unknown }).open = realOpen;
    }
  });
});

describe("bound session surface", () => {
  test("activate posts to the session; misc file ops round-trip", async () => {
    const calls = mockFetch({
      "/file/upload": { body: { ok: true, path: "a.png", size: 3 } },
      "/file/rename": { body: { ok: true, from: "a.md", to: "b.md" } },
    });
    const p = createCloudPlatform(PROJECT);
    await p.activate();
    expect(calls[0]?.url).toBe(`${BASE}/activate`);

    await p.uploadFile("a.png", new Uint8Array([1, 2, 3]).buffer);
    expect(calls.some((c) => c.url.includes("/file/upload?path=a.png"))).toBe(true);

    const renamed = await p.renameFile("a.md", "b.md");
    expect(renamed.ok).toBe(true);

    await p.createDirectory("pages/sub");
    await p.deleteFile("gone.md"); // Default mock 200 → resolves.
  });

  test("error bodies surface their message; non-JSON errors fall back", async () => {
    mockFetch({ "/file?path=x": { status: 500, body: { error: "disk full" } } });
    const p = createCloudPlatform(PROJECT);
    expect(p.readFile("x")).rejects.toThrow(/disk full/);

    globalThis.fetch = (() =>
      Promise.resolve(new Response("plain text", { status: 500 }))) as unknown as typeof fetch;
    expect(p.readFile("x")).rejects.toThrow(/Failed to read file/);
  });

  test("locate, search, and resolveSiteContext map their wire shapes", async () => {
    mockFetch({
      "/locate": { body: { path: "pages/index.md" } },
      "/search": { body: [{ name: "index.md", path: "pages/index.md", type: "file" }] },
      "/project-info": {
        body: {
          root: "octocat/my-site",
          name: "my-site",
          defaultBranch: "main",
          permission: "admin",
          projectConfig: { name: "My Site" },
        },
      },
    });
    const p = createCloudPlatform(PROJECT);
    expect(await p.locateFile("index.md")).toBe("pages/index.md");
    expect(await p.searchFiles("index", [".md"])).toHaveLength(1);
    const ctx = await p.resolveSiteContext("pages/index.md");
    expect(ctx.sitePath).toBe("octocat/my-site");
    expect(ctx.fileRelPath).toBe("pages/index.md");
  });

  test("resolveSiteContext/locate/search degrade on failing routes", async () => {
    mockFetch({
      "/project-info": { status: 500, body: { error: "boom" } },
      "/locate": { status: 500, body: { error: "boom" } },
      "/search": { status: 500, body: { error: "boom" } },
    });
    const p = createCloudPlatform(PROJECT);
    expect(await p.resolveSiteContext("x")).toEqual({ sitePath: null });
    expect(await p.locateFile("nope")).toBeNull();
    expect(await p.searchFiles("nope")).toEqual([]);
  });
});

describe("session events (WebSocket)", () => {
  interface WsInstance {
    url: string;
    listeners: Record<string, ((ev: unknown) => void)[]>;
    closed: boolean;
  }
  const instances: WsInstance[] = [];

  class MockWebSocket {
    url: string;
    listeners: Record<string, ((ev: unknown) => void)[]> = {};
    closed = false;
    constructor(url: string) {
      this.url = url;
      instances.push(this as unknown as WsInstance);
    }
    addEventListener(type: string, handler: (ev: unknown) => void) {
      (this.listeners[type] ??= []).push(handler);
    }
    emit(type: string, ev: unknown) {
      for (const handler of this.listeners[type] ?? []) {
        handler(ev);
      }
    }
    close() {
      this.closed = true;
    }
  }

  test("dispatches fs batches, ignores git notices and junk, unsubscribes cleanly", () => {
    const realWs = (globalThis as Record<string, unknown>)["WebSocket"];
    (globalThis as Record<string, unknown>)["WebSocket"] = MockWebSocket;
    instances.length = 0;
    try {
      const p = createCloudPlatform(PROJECT);
      const batches: unknown[] = [];
      const unsubscribe = p.subscribeFileEvents?.((events) => batches.push(events));
      const socket = instances[0] as unknown as MockWebSocket;
      expect(socket.url).toContain(`${BASE}/events`);

      socket.emit("open", {});
      socket.emit("message", {
        data: JSON.stringify({ kind: "fs", events: [{ type: "add", path: "a.md", isDir: false }] }),
      });
      socket.emit("message", { data: JSON.stringify({ kind: "git", event: "committed" }) });
      socket.emit("message", { data: "{not json" });
      expect(batches).toHaveLength(1);

      unsubscribe?.();
      expect(socket.closed).toBe(true);
    } finally {
      (globalThis as Record<string, unknown>)["WebSocket"] = realWs;
    }
  });

  test("opens no socket without a project (hub: empty base would be a bare /events)", () => {
    const realWs = (globalThis as Record<string, unknown>)["WebSocket"];
    (globalThis as Record<string, unknown>)["WebSocket"] = MockWebSocket;
    instances.length = 0;
    try {
      const p = createCloudPlatform(null);
      const unsubscribe = p.subscribeFileEvents?.(() => {});
      expect(instances).toHaveLength(0);
      unsubscribe?.();
    } finally {
      (globalThis as Record<string, unknown>)["WebSocket"] = realWs;
    }
  });
});

describe("formats (session backend registry)", () => {
  test("listFormats and listExtensions read the session formats route", async () => {
    const calls = mockFetch({
      "/formats": {
        body: {
          formats: [{ name: "Markdown", extensions: [".md"] }],
          extensions: [
            {
              specifier: "@jxsuite/parser",
              name: "@jxsuite/parser",
              contributions: [],
              classes: [{ name: "Markdown", path: "/deps/parser/src/Markdown.class.json" }],
            },
          ],
        },
      },
    });
    const p = createCloudPlatform(PROJECT);
    const formats = (await p.listFormats?.()) as { name: string; extensions: string[] }[];
    expect(formats[0]?.name).toBe("Markdown");
    expect(formats[0]?.extensions).toEqual([".md"]);
    const extensions = await p.listExtensions?.();
    expect(extensions?.[0]?.classes?.[0]?.name).toBe("Markdown");
    expect(calls.every((c) => c.url === `${BASE}/formats`)).toBe(true);
  });

  test("both registry reads degrade to empty lists on backends without the route", async () => {
    mockFetch({ "/formats": { status: 404, body: { error: "no such route" } } });
    const p = createCloudPlatform(PROJECT);
    expect(await p.listFormats?.()).toEqual([]);
    expect(await p.listExtensions?.()).toEqual([]);
    // Project-less mode has no session to ask.
    const projectless = createCloudPlatform(null);
    expect(await projectless.listFormats?.()).toEqual([]);
    expect(await projectless.listExtensions?.()).toEqual([]);
  });

  /* The cloud composes the entry documents server-side from bundled artifacts (it has no
     node_modules and no filesystem), so the studio just registers what it is handed. Before this
     member existed the cloud always fell back to the core schemas, and extension sections got no
     editor validation at all. */
  test("fetchProjectSchemas reads the session's pre-bundled entry documents", async () => {
    const project = { $comment: "generated", allOf: [{ $ref: "#/$defs/project-core-v2" }] };
    const document = { $comment: "generated", allOf: [{ $ref: "#/$defs/v1" }] };
    const calls = mockFetch({ "/project-schemas": { body: { document, project } } });
    const p = createCloudPlatform(PROJECT);
    expect(await p.fetchProjectSchemas?.()).toEqual({ document, project });
    expect(calls.every((c) => c.url === `${BASE}/project-schemas`)).toBe(true);
  });

  test("fetchProjectSchemas degrades to the core-schema fallback, never throwing", async () => {
    mockFetch({ "/project-schemas": { status: 404, body: { error: "no such route" } } });
    expect(await createCloudPlatform(PROJECT).fetchProjectSchemas?.()).toEqual({});
    // Project-less mode has no session to ask.
    expect(await createCloudPlatform(null).fetchProjectSchemas?.()).toEqual({});
  });

  test("formatAction posts to the session format route and unwraps result", async () => {
    const calls = mockFetch({
      "/format": { body: { result: { children: [{ tagName: "h1", textContent: "Hello" }] } } },
    });
    const p = createCloudPlatform(PROJECT);
    const doc = (await p.formatAction?.({
      action: "parse",
      format: "Markdown",
      source: "# Hello",
    })) as { children?: unknown[] };
    expect(JSON.stringify(doc)).toContain("Hello");
    expect(calls[0]?.url).toBe(`${BASE}/format`);
    expect(calls[0]?.init?.method).toBe("POST");
  });

  test("formatAction surfaces backend errors and the missing-route fallback", async () => {
    mockFetch({ "/format": { status: 400, body: { error: 'Unsupported action "discover"' } } });
    const p = createCloudPlatform(PROJECT);
    expect(p.formatAction?.({ action: "discover" })).rejects.toThrow(/Unsupported action/);

    globalThis.fetch = (() =>
      Promise.resolve(new Response("not found", { status: 404 }))) as unknown as typeof fetch;
    expect(p.formatAction?.({ action: "parse", source: "" })).rejects.toThrow(
      /cannot run format actions yet/,
    );
  });
});

describe("static-posture members", () => {
  test("component discovery and code services are inert", async () => {
    mockFetch({});
    const p = createCloudPlatform(PROJECT);
    expect(await p.discoverComponents()).toEqual([]);
    expect(await p.codeService("lint", {})).toBeNull();
    expect(await p.fetchPluginSchema("src")).toBeNull();
    expect(p.aiChatUrl()).toBe("/api/v1/ai/chat");
  });

  test("package reads tolerate unreadable manifests", async () => {
    mockFetch({ "/file?path=package.json": { status: 404, body: { error: "gone" } } });
    const p = createCloudPlatform(PROJECT);
    expect(await p.listPackages()).toEqual([]);
  });
});

describe("git surface (full sweep)", () => {
  test("read endpoints map their wire shapes", async () => {
    mockFetch({
      "/git/status": {
        body: { isRepo: true, branch: "main", files: [], ahead: 0, behind: 0, remotes: ["origin"] },
      },
      "/git/branches": { body: { current: "main", branches: ["main", "dev"] } },
      "/git/log": { body: [{ hash: "abc", message: "m", author: "a", date: "d" }] },
      "/git/diff": { body: { diff: "--- a/x" } },
      "/git/show": { body: { content: "old text" } },
    });
    const p = createCloudPlatform(PROJECT);
    const status = await p.gitStatus();
    expect(status.branch).toBe("main");
    const branches = await p.gitBranches();
    expect(branches.branches).toContain("dev");
    expect(await p.gitLog(5)).toHaveLength(1);
    expect(await p.gitLog()).toHaveLength(1);
    expect(await p.gitDiff("x")).toBe("--- a/x");
    expect(await p.gitShow({ path: "x", ref: "HEAD~1" })).toBe("old text");
    expect(await p.gitShow({ path: "x" })).toBe("old text");
  });

  test("write endpoints post and surface failures", async () => {
    const calls = mockFetch({ "/git/pull": { status: 409, body: { error: "pull_conflict" } } });
    const p = createCloudPlatform(PROJECT);
    await p.gitStage(["a.md"]);
    await p.gitUnstage(["a.md"]);
    await p.gitPush();
    await p.gitFetch();
    await p.gitDiscard(["a.md"]);
    await p.gitCreateBranch("feat/x");
    await p.gitInit();
    await p.gitAddRemote("origin", "https://github.com/o/r");
    expect(p.gitPull()).rejects.toThrow(/pull_conflict/);
    expect(calls.filter((c) => c.init?.method === "POST").length).toBeGreaterThanOrEqual(7);
  });

  test("checkout navigates bound sessions and no-ops without a project", async () => {
    mockFetch({});
    await createCloudPlatform(null).gitCheckout("dev"); // Guard path.
    await createCloudPlatform(PROJECT).gitCheckout("dev"); // Covers the happy-dom location.assign path.
  });
});

describe("navigation members under a DOM", () => {
  test("openProjectInNewWindow opens the editor URL", async () => {
    mockFetch({});
    const realOpen = window.open;
    const openMock = mock(() => null);
    (window as { open: unknown }).open = openMock;
    try {
      const p = createCloudPlatform(null);
      await p.openProjectInNewWindow?.("octocat/site@main");
      expect(openMock).toHaveBeenCalled();
      await p.openProjectInNewWindow?.("malformed"); // Parse-fail path: no call.
      expect(openMock).toHaveBeenCalledTimes(1);
    } finally {
      (window as { open: unknown }).open = realOpen;
    }
  });

  test("getUser omits absent optional fields", async () => {
    mockFetch({
      "/api/v1/me": { body: { user: { login: "octo", name: null, avatar_url: null } } },
    });
    const p = createCloudPlatform(null);
    expect(await p.getUser?.()).toEqual({ login: "octo" });
  });
});

describe("collab capability", () => {
  test("project-less sessions have no co-editing", async () => {
    expect(await createCloudPlatform(null).collab!("pages/index.md")).toBeNull();
  });

  test("opens ONE multiplexed socket at the gateway's /collab path", async () => {
    const seen: string[] = [];
    class RecordingWebSocket {
      binaryType = "";
      readyState = 0;
      onopen: (() => void) | null = null;
      onclose: (() => void) | null = null;
      onerror: (() => void) | null = null;
      onmessage: ((ev: unknown) => void) | null = null;
      sent = 0;
      constructor(url: string) {
        seen.push(url);
      }
      send(): void {
        this.sent += 1;
      }
      close(): void {
        this.sent = -1;
      }
    }
    const realWs = (globalThis as Record<string, unknown>)["WebSocket"];
    (globalThis as Record<string, unknown>)["WebSocket"] = RecordingWebSocket;
    try {
      const p = createCloudPlatform(PROJECT);
      // Two opens share the connection; neither resolves (the socket never answers) — the
      // Session-level timeout owns fallback. Only the URL/multiplexing contract is under test.
      void p.collab!("pages/a.md");
      void p.collab!("pages/b.md");
      const deadline = Date.now() + 3000;
      while (seen.length === 0 && Date.now() < deadline) {
        await new Promise((resolve) => {
          setTimeout(resolve, 10);
        });
      }
      expect(seen).toEqual([`ws://${location.host}${BASE}/collab`]);
    } finally {
      (globalThis as Record<string, unknown>)["WebSocket"] = realWs;
    }
  });
});
