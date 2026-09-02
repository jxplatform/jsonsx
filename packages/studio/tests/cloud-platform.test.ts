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
import { recordCollabSockets } from "./collab-socket-recorder";

const PROJECT = { owner: "octocat", repo: "my-site", branch: "main" };
const BASE = "/api/v1/p/octocat/my-site/main/studio";

const realFetch = globalThis.fetch;
/* Captured before any test stubs window.setTimeout — `until` must keep running on the real clock
   even inside a test that has replaced the platform's one. */
const realSetTimeout = globalThis.setTimeout;

afterEach(() => {
  globalThis.fetch = realFetch;
});

/**
 * Wait for something cfConnect does asynchronously.
 *
 * CfConnect reads a BASELINE connection before it opens the popup, so neither the popup, the
 * message listener nor the poll timer exists synchronously any more — a test that dispatches its
 * relay in the same turn dispatches it into nothing.
 */
async function until(done: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    if (done()) {
      return;
    }
    await new Promise((resolve) => {
      realSetTimeout(resolve, 0);
    });
  }
  throw new Error(`timed out waiting for ${what}`);
}

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
    expect(opened?.handle.root).toBe("octocat/my-site@main");
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

  /* The Recent list is written from `probeRootProject`'s meta.root and re-opened by parsing it back
     as a root key, so a branchless root here was a Recent row that did nothing when clicked while
     the catalogue's row for the same project — built by `projectRootKey` — opened it. */
  test("the bound project's root is the catalogue root key, branch included", async () => {
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
    expect(platform.projectRoot).toBe(projectRootKey(PROJECT));
    const probe = await platform.probeRootProject();
    expect(probe?.meta.root).toBe(projectRootKey(PROJECT));
    expect(parseRootKey(platform.projectRoot)).toEqual(PROJECT);
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

  /* Recent rows written by studios that shipped before the root key carried a branch are still in
     people's browsers. They name a project but not a branch, so the catalogue answers with the one
     that project's Projects row opens. */
  test("setWindowProject resolves a branchless recent through the catalogue", async () => {
    const calls = mockFetch({
      "/api/v1/projects": {
        body: [
          {
            fullName: "octocat/site",
            owner: "octocat",
            name: "site",
            defaultBranch: "trunk",
            permission: "admin",
          },
        ],
      },
    });
    const realAssign = location.assign;
    const assigned: string[] = [];
    (location as { assign: unknown }).assign = (url: string) => {
      assigned.push(url);
    };
    try {
      const p = createCloudPlatform(null);
      expect(await p.setWindowProject?.("octocat/site")).toEqual({ deduped: true, config: null });
      expect(calls.some((c) => c.url.includes("/api/v1/projects"))).toBe(true);
      expect(assigned).toEqual([editUrl({ owner: "octocat", repo: "site", branch: "trunk" })]);
    } finally {
      (location as { assign: unknown }).assign = realAssign;
    }
  });

  test("setWindowProject fails on a key that names nothing openable", async () => {
    mockFetch({ "/api/v1/projects": { body: [] } });
    const p = createCloudPlatform(null);
    expect(p.setWindowProject?.("octocat/gone")).rejects.toThrow(/No project to open/);
    expect(p.setWindowProject?.("not a root key")).rejects.toThrow(/No project to open/);
  });
});

/**
 * What the canvas origin answers for a site URL — the declaration the whole media fix turns on.
 *
 * Studio.jxsuite.com is a multi-tenant SPA origin: `/hero.jpg` misses Workers Static Assets and the
 * single-page-app fallback answers index.html at HTTP 200, so the `<img>` gets HTML, renders
 * broken, and logs nothing. `"repo"` is how the adapter says so.
 */
describe("assetSpace", () => {
  test("a bound session serves project paths under /raw", () => {
    const p = createCloudPlatform(PROJECT);
    expect(p.assetSpace).toBe("repo");
    expect(p.documentBaseUrl).toBe(`${BASE}/raw/`);
  });

  /* Both or neither. Until a project is bound there is no /raw to address, and a declaration that
     said "your site URLs are wrong" without saying what is right would leave the hub resolving
     every reference to a base that does not exist. */
  test("the project-less hub declares NEITHER", () => {
    const p = createCloudPlatform(null);
    expect(p.assetSpace).toBeUndefined();
    expect(p.documentBaseUrl).toBeUndefined();
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

  test("cfConnection surfaces a lapsed grant instead of flattening it into a healthy row", async () => {
    mockFetch({
      "/api/v1/cf/connection": {
        body: {
          code: "cf_reconnect_required",
          connected: true,
          expiresAt: 1_700_000_000,
          hasRefreshToken: false,
          needsAccount: false,
          needsReconnect: true,
          reason: "refresh_failed",
        },
      },
    });
    const p = createCloudPlatform(null);
    // Dropping needsReconnect here is what let cfConnect's poll close the popup over a dead row.
    expect(await p.cfConnection?.()).toEqual({
      code: "cf_reconnect_required",
      connected: true,
      expiresAt: 1_700_000_000,
      hasRefreshToken: false,
      needsReconnect: true,
      reason: "refresh_failed",
    });
  });

  test("cfConnection carries needsAccount through for a connection with no account chosen", async () => {
    mockFetch({
      "/api/v1/cf/connection": {
        body: { code: "cf_account_required", connected: true, needsAccount: true },
      },
    });
    const p = createCloudPlatform(null);
    expect(await p.cfConnection?.()).toEqual({
      code: "cf_account_required",
      connected: true,
      needsAccount: true,
    });
  });

  test("cfAccounts lists the grant's accounts and surfaces the broker's unusable payload", async () => {
    const calls = mockFetch({
      "/api/v1/cf/accounts": { body: [{ id: "a1", name: "Acme" }] },
    });
    const p = createCloudPlatform(null);
    expect(await p.cfAccounts?.()).toEqual([{ id: "a1", name: "Acme" }]);
    expect(calls[0]?.url).toBe("/api/v1/cf/accounts");
    expect(calls[0]?.init?.credentials).toBe("include");

    mockFetch({
      "/api/v1/cf/accounts": {
        status: 401,
        body: {
          code: "cf_reconnect_required",
          error: "Your Cloudflare connection has expired — reconnect to continue",
        },
      },
    });
    expect(p.cfAccounts?.()).rejects.toThrow(/has expired/);
  });

  test("cfSelectAccount posts the chosen account and surfaces a refusal", async () => {
    const calls = mockFetch({ "/api/v1/cf/select-account": { body: { ok: true } } });
    const p = createCloudPlatform(null);
    await p.cfSelectAccount?.({ id: "a1", name: "Acme" });
    expect(calls[0]?.url).toBe("/api/v1/cf/select-account");
    expect(calls[0]?.init?.method).toBe("POST");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      accountId: "a1",
      accountName: "Acme",
    });

    mockFetch({
      "/api/v1/cf/select-account": {
        status: 401,
        body: { code: "cf_not_connected", error: "Cloudflare not connected" },
      },
    });
    expect(p.cfSelectAccount?.({ id: "a1" })).rejects.toThrow(/not connected/);
  });

  test("cfDisconnect deletes the brokered connection and surfaces a failure", async () => {
    const calls = mockFetch({ "/api/v1/cf/connection": { body: { ok: true } } });
    const p = createCloudPlatform(null);
    await p.cfDisconnect?.();
    expect(calls[0]?.url).toBe("/api/v1/cf/connection");
    expect(calls[0]?.init?.method).toBe("DELETE");
    expect(calls[0]?.init?.credentials).toBe("include");

    mockFetch({ "/api/v1/cf/connection": { status: 500, body: { error: "D1 unavailable" } } });
    expect(p.cfDisconnect?.()).rejects.toThrow(/D1 unavailable/);
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
    const realAssign = location.assign;
    const assigned: string[] = [];
    (location as { assign: unknown }).assign = (url: string) => {
      assigned.push(url);
    };
    (window as { open: unknown }).open = mock(() => null);
    try {
      const p = createCloudPlatform(null);
      // Not null and not a failure: the page itself is navigating, so the caller renders nothing.
      expect(await p.cfConnect?.()).toEqual({ status: "redirect" });
      expect(assigned).toEqual(["/api/v1/cf/connect"]);
    } finally {
      (window as { open: unknown }).open = realOpen;
      (location as { assign: unknown }).assign = realAssign;
    }
  });

  test("cfConnect resolves on the home shell's jx-cf success relay", async () => {
    mockFetch({
      "/api/v1/cf/connection": { body: { connected: true, accountId: "acct" } },
    });
    const realOpen = window.open;
    const popup = { close: mock(() => {}), closed: false };
    const open = mock(() => popup);
    (window as { open: unknown }).open = open;
    try {
      const p = createCloudPlatform(null);
      const pending = p.cfConnect?.();
      await until(() => open.mock.calls.length > 0, "the connect popup");
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
      expect(await pending).toEqual({
        connection: { connected: true, accountId: "acct" },
        status: "connected",
      });
    } finally {
      (window as { open: unknown }).open = realOpen;
    }
  });

  test("cfConnect rejects with the relayed OAuth error reason", async () => {
    mockFetch({});
    const realOpen = window.open;
    const popup = { close: mock(() => {}), closed: false };
    const open = mock(() => popup);
    (window as { open: unknown }).open = open;
    try {
      const p = createCloudPlatform(null);
      const pending = p.cfConnect?.();
      await until(() => open.mock.calls.length > 0, "the connect popup");
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

  test("findReferences is computed server-side — cloud never degrades to unknown", async () => {
    const calls = mockFetch({
      "/references": {
        body: {
          errors: [],
          files: [{ count: 2, path: "pages/index.json", refs: [] }],
          filesReferencing: 1,
          path: "components/card.json",
          refsTotal: 2,
          tagName: "my-card",
        },
      },
    });
    const p = createCloudPlatform(PROJECT);
    const result = await p.findReferences!({ path: "components/card.json", tagName: "my-card" });
    expect(result.refsTotal).toBe(2);
    const call = calls.find((c) => c.url.includes("/references"))!;
    expect(call.url).toContain("path=components%2Fcard.json");
    expect(call.url).toContain("tag=my-card");
  });

  test("findReferences surfaces a failure rather than answering zero", async () => {
    mockFetch({ "/references": { status: 500, body: { error: "walker exploded" } } });
    const p = createCloudPlatform(PROJECT);
    expect(p.findReferences!({ tagName: "my-card" })).rejects.toThrow(/walker exploded/);
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
    expect(ctx.sitePath).toBe("octocat/my-site@main");
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

  /*
   * The catalogue is a CAPABILITY rather than a constant precisely because of this backend: a
   * Worker ships a fixed set of extension packages (specs/extensions.md §5.5), decided by the
   * platform build rather than by this repository's extensions/ tree. So cloud asks its gateway,
   * and never serves the shipped first-party list.
   */
  test("listExtensionCatalog asks the gateway and marks everything bundled", async () => {
    const calls = mockFetch({
      "/catalog": {
        body: [
          { name: "@jxsuite/parser", sections: [{ key: "content" }], source: "first-party" },
          { name: "@jxsuite/feed", sections: [{ key: "feed" }], source: "first-party" },
        ],
      },
      "/file?path=package.json": {
        body: { content: JSON.stringify({ dependencies: { "@jxsuite/parser": "^1.7.0" } }) },
      },
    });
    const p = createCloudPlatform(PROJECT);
    const catalog = await p.listExtensionCatalog?.();

    // Nothing resolves a module in a Worker, so enabling one of these is a project.json write
    // Alone — which is what `bundled` means.
    expect(catalog?.every((e) => e.bundled === true)).toBe(true);
    // `installed` degrades to DECLARED, the only fact this adapter has.
    expect(catalog?.find((e) => e.name === "@jxsuite/parser")?.installed).toBe(true);
    expect(catalog?.find((e) => e.name === "@jxsuite/feed")?.installed).toBe(false);
    expect(calls.some((c) => c.url === `${BASE}/catalog`)).toBe(true);
  });

  test("the catalogue degrades to nothing rather than to the shipped list", async () => {
    /*
     * The whole contract. A session whose gateway predates the route must offer NOTHING: offering
     * five extensions three of which the Worker cannot load would put a toggle in front of the
     * reader that silently does not work.
     */
    mockFetch({ "/catalog": { status: 404, body: { error: "no such route" } } });
    expect(await createCloudPlatform(PROJECT).listExtensionCatalog?.()).toEqual([]);
    expect(await createCloudPlatform(null).listExtensionCatalog?.()).toEqual([]);
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
  test("code services stay inert — those DO need project JS", async () => {
    mockFetch({});
    const p = createCloudPlatform(PROJECT);
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
      // Unresolvable: it must fail rather than answer, because the caller reports "Opened in
      // Another window" for any call that returns.
      expect(p.openProjectInNewWindow?.("malformed")).rejects.toThrow(/No project to open/);
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
    mockFetch();
    // Two opens share the connection.
    const seen = await recordCollabSockets(() => createCloudPlatform(PROJECT), 2);
    expect(seen).toEqual([{ url: `ws://${location.host}${BASE}/collab` }]);
  });

  test("a gateway that does not answer the probe still gets a socket, offering nothing", async () => {
    /*
     * The gateway ships separately from this bundle, so an unanswered probe means "older gateway",
     * not "no collaboration". Treating it as a refusal would take working co-editing away from
     * every session pointed at one — and offering nothing is also the only handshake-safe answer
     * to a server that would echo nothing (RFC 6455 §4.1).
     */
    mockFetch({ "/collab": { body: { error: "Not Found" }, status: 404 } });
    const seen = await recordCollabSockets(() => createCloudPlatform(PROJECT));
    expect(seen).toEqual([{ url: `ws://${location.host}${BASE}/collab` }]);
  });

  test("offers the subprotocol the gateway advertises", async () => {
    mockFetch({ "/collab": { body: { collab: true, protocols: ["jx.collab.v1"], version: 1 } } });
    const seen = await recordCollabSockets(() => createCloudPlatform(PROJECT));
    expect(seen).toEqual([
      { protocols: ["jx.collab.v1"], url: `ws://${location.host}${BASE}/collab` },
    ]);
  });

  test("refuses a gateway speaking an envelope this build cannot parse", async () => {
    mockFetch({ "/collab": { body: { collab: true, protocols: ["jx.collab.v9"], version: 9 } } });
    const realWarn = console.warn;
    console.warn = () => {};
    try {
      expect(await createCloudPlatform(PROJECT).collab!("pages/a.md")).toBeNull();
    } finally {
      console.warn = realWarn;
    }
  });
});

/**
 * Component discovery, by reading rather than executing.
 *
 * This returned `[]` under a blanket "no execution of project JS" posture, and the canvas paid for
 * it: `canvas-live-render` injects the `$elements` a document's tags need only when the registry is
 * non-empty, so nothing was ever registered, no component was ever fetched, and every instance
 * rendered as an unregistered custom element — blank space where the component should be.
 */
describe("discoverComponents", () => {
  /** A session whose tree is `dirs` and whose files answer with `files`. */
  function session(dirs: Record<string, unknown[]>, files: Record<string, unknown>) {
    globalThis.fetch = ((url: string) => {
      const listed = /\/files\?dir=([^&]*)/u.exec(url);
      if (listed) {
        return Promise.resolve(Response.json(dirs[decodeURIComponent(listed[1] ?? "")] ?? []));
      }
      const read = /\/file\?path=([^&]*)/u.exec(url);
      if (read) {
        const path = decodeURIComponent(read[1] ?? "");
        return path in files
          ? Promise.resolve(Response.json({ content: JSON.stringify(files[path]) }))
          : Promise.resolve(Response.json({ error: "gone" }, { status: 404 }));
      }
      return Promise.resolve(Response.json({}));
    }) as unknown as typeof fetch;
  }

  const dir = (name: string, path: string) => ({ name, path, type: "directory" });
  const file = (name: string, path: string) => ({ name, path, type: "file" });

  test("finds a component nested in the tree, and reports its props", async () => {
    session(
      {
        "": [dir("components", "components"), file("package.json", "package.json")],
        components: [file("card.json", "components/card.json")],
      },
      {
        "components/card.json": { state: { title: "Hi" }, tagName: "my-card" },
        "package.json": { name: "site" },
      },
    );
    const found = await createCloudPlatform(PROJECT).discoverComponents();
    expect(found).toEqual([
      {
        $id: null,
        hasElements: false,
        path: "components/card.json",
        props: [{ default: "Hi", name: "title", type: "string" }],
        tagName: "my-card",
      },
    ]);
  });

  test("a JSON file that is not a component is not reported", async () => {
    // Most of what a whole-tree scan reads is pages and data. The hyphen test is what separates
    // Them, and it lives in the shared extractor rather than here.
    session(
      { "": [file("index.json", "pages/index.json")] },
      { "pages/index.json": { children: [], tagName: "main" } },
    );
    expect(await createCloudPlatform(PROJECT).discoverComponents()).toEqual([]);
  });

  test("unreadable or non-JSON files are skipped, not fatal", async () => {
    // A scan reads whatever it finds; one bad file must not lose every other component.
    session(
      {
        "": [file("broken.json", "broken.json"), file("ok.json", "ok.json")],
      },
      { "ok.json": { tagName: "a-b" } },
    );
    const found = await createCloudPlatform(PROJECT).discoverComponents();
    expect(found.map((c) => c.tagName)).toEqual(["a-b"]);
  });

  test("node_modules and build output are never walked", async () => {
    /* Not a nicety: a session tree with node_modules in it would turn opening a project into
       thousands of HTTP reads against a remote Durable Object. */
    const calls: string[] = [];
    session(
      {
        "": [dir("node_modules", "node_modules"), dir("dist", "dist"), dir("src", "src")],
        dist: [file("a.json", "dist/a.json")],
        node_modules: [file("b.json", "node_modules/b.json")],
        src: [],
      },
      {},
    );
    const inner = globalThis.fetch;
    globalThis.fetch = ((url: string, init?: RequestInit) => {
      calls.push(url);
      return (inner as (u: string, i?: RequestInit) => Promise<Response>)(url, init);
    }) as unknown as typeof fetch;

    await createCloudPlatform(PROJECT).discoverComponents();
    expect(calls.some((u) => u.includes("node_modules"))).toBe(false);
    expect(calls.some((u) => u.includes("dist"))).toBe(false);
  });

  test("a dot-directory is skipped too", async () => {
    const calls: string[] = [];
    session({ "": [dir(".git", ".git"), dir(".claude", ".claude")] }, {});
    const inner = globalThis.fetch;
    globalThis.fetch = ((url: string, init?: RequestInit) => {
      calls.push(url);
      return (inner as (u: string, i?: RequestInit) => Promise<Response>)(url, init);
    }) as unknown as typeof fetch;
    await createCloudPlatform(PROJECT).discoverComponents();
    expect(calls.some((u) => u.includes(".git") || u.includes(".claude"))).toBe(false);
  });

  test("a directory that fails to list does not abort the walk", async () => {
    session({ "": [dir("components", "components")] }, {});
    const inner = globalThis.fetch;
    globalThis.fetch = ((url: string, init?: RequestInit) => {
      if (url.includes("dir=components")) {
        return Promise.resolve(Response.json({ error: "gone" }, { status: 500 }));
      }
      return (inner as (u: string, i?: RequestInit) => Promise<Response>)(url, init);
    }) as unknown as typeof fetch;
    expect(await createCloudPlatform(PROJECT).discoverComponents()).toEqual([]);
  });
});

// ─── buildSite: the cloud's live preview ─────────────────────────────────────

describe("the cloud adapter's buildSite", () => {
  test("posts to the session's /build and returns what the backend reported", async () => {
    const reply = {
      errors: [],
      files: 42,
      mode: "live" as const,
      routes: 7,
      url: "https://a7f3c9e2b81d4x.jxly.dev",
    };
    const calls = mockFetch({ "/build": { body: reply } });
    const result = await createCloudPlatform(PROJECT).buildSite!();
    expect(result).toEqual(reply);
    const call = calls.find((c) => c.url.includes("/build"))!;
    expect(call.url).toBe(`${BASE}/build`);
    expect(call.init?.method).toBe("POST");
    expect(call.init?.credentials).toBe("include");
  });

  test("declares itself as a live preview, not as build output", async () => {
    /* The backend runs no project JS and has no bundler, no sharp and no disk. What it serves is
       the working tree rendered as a site, and Open in Browser must say so. */
    mockFetch({
      "/build": {
        body: { errors: [], files: 1, mode: "live", routes: 1, url: "https://x.jxly.dev" },
      },
    });
    const result = await createCloudPlatform(PROJECT).buildSite!();
    expect(result.mode).toBe("live");
  });

  test("a backend failure surfaces its own sentence", async () => {
    mockFetch({ "/build": { body: { detail: "This preview link has expired." }, status: 410 } });
    let failure: unknown;
    try {
      await createCloudPlatform(PROJECT).buildSite!();
    } catch (error) {
      failure = error;
    }
    expect((failure as Error | undefined)?.message).toContain("expired");
  });

  test("with no project open there is nothing to preview", async () => {
    let failure: unknown;
    try {
      await createCloudPlatform(null).buildSite!();
    } catch (error) {
      failure = error;
    }
    expect((failure as Error | undefined)?.message).toContain("No project is open");
  });
});

describe("importSite", () => {
  /** An NDJSON body, since `streamImport` reads a stream rather than a JSON document. */
  function ndjson(lines: string[]): Call[] {
    const calls: Call[] = [];
    globalThis.fetch = ((url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return Promise.resolve(
        new Response(lines.map((line) => `${line}\n`).join(""), {
          headers: { "Content-Type": "application/x-ndjson" },
          status: 200,
        }),
      );
    }) as unknown as typeof fetch;
    return calls;
  }

  test("posts to the platform route with no project open, and adopts on done", async () => {
    /* Importing is how a cloud project comes into existence, so the ONE mode it has to work in is
       the project-less hub — where a session-scoped path has no base to be scoped to. The route is
       deliberately not under /p/<owner>/<repo>/<branch>/studio for exactly that reason.

       And this backend sends no `ready` line: adopting mid-run would navigate the page to the
       editor and abort the request still writing the import. A caller that waited for `ready`
       would hang forever, so the adoption has to come off `done`. */
    const calls = ndjson([
      '{"type":"progress","phase":"crawl","message":"Reading the site"}',
      '{"type":"done","root":"acme/site@main","config":{"name":"Site"}}',
    ]);
    const phases: string[] = [];
    const ready: string[] = [];
    const result = await createCloudPlatform(null).importSite!(
      {
        aiComponents: false,
        depth: 0,
        directory: "acme/site",
        maxPages: 1,
        name: "Site",
        url: "https://clone.example/",
      },
      (evt) => phases.push(evt.phase),
      undefined,
      ({ root }) => ready.push(root),
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("/api/v1/import/site");
    expect(calls[0]!.init?.method).toBe("POST");
    expect(phases).toEqual(["crawl"]);
    expect(ready).toEqual([]);
    expect(result.root).toBe("acme/site@main");
  });

  test("a bring-your-own-key run forwards its key and base URL", async () => {
    /* The hosted backend brokers Workers AI, but a user who has typed their own key is entitled to
       spend it here too — and the only way the backend learns that is these two headers, which the
       shared client already sets. A cloud-shaped option would have been a second way to say it. */
    const calls = ndjson(['{"type":"done","root":"acme/site@main","config":{"name":"Site"}}']);
    await createCloudPlatform(null).importSite!(
      {
        aiComponents: true,
        apiKey: "sk-test",
        baseUrl: "https://llm.example/v1",
        depth: 0,
        directory: "acme/site",
        maxPages: 1,
        name: "Site",
        url: "https://clone.example/",
      },
      () => {},
    );

    const headers = calls[0]!.init?.headers as Record<string, string>;
    expect(headers["X-Api-Key"]).toBe("sk-test");
    expect(headers["X-Api-Base-URL"]).toBe("https://llm.example/v1");
  });
});
