/**
 * Pages-service: Cloudflare Pages publish domain logic over the PAL cfApi passthrough — project
 * lookup/create, deployment mapping, and the build.deploy + wrangler.jsonc persistence.
 */
import { installMockPlatform, resetStudioState } from "./harness";
import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { DeployConfig } from "@jxsuite/schema/types";

const {
  connectDeploy,
  createPagesProject,
  getPagesProject,
  latestDeployment,
  listAccounts,
  platformSupportsPublish,
  writeDeployConfig,
} = await import("../src/publish/pages-service");

const DEPLOY: DeployConfig = {
  provider: "cloudflare-pages",
  accountId: "a".repeat(32),
  projectName: "my-site",
};

interface CfCall {
  path: string;
  init?: { method?: string; body?: unknown };
}

/** Install a mock platform whose cfApi answers from a path-keyed table. */
function withCfApi(
  routes: Record<string, unknown | ((init?: { method?: string; body?: unknown }) => unknown)>,
  overrides: Record<string, unknown> = {},
) {
  const calls: CfCall[] = [];
  const cfApi = mock((path: string, init?: { method?: string; body?: unknown }) => {
    calls.push({ path, ...(init === undefined ? {} : { init }) });
    for (const [needle, response] of Object.entries(routes)) {
      if (path.includes(needle)) {
        const value = typeof response === "function" ? response(init) : response;
        return value instanceof Error ? Promise.reject(value) : Promise.resolve(value);
      }
    }
    return Promise.reject(new Error(`no route: ${path}`));
  });
  const { state } = installMockPlatform({ cfApi, ...overrides });
  return { calls, cfApi, state };
}

beforeEach(() => {
  resetStudioState({ projectConfig: { build: { adapter: "cloudflare-pages" }, name: "My Site" } });
});

describe("platformSupportsPublish", () => {
  test("mirrors the presence of cfApi", () => {
    installMockPlatform();
    expect(platformSupportsPublish()).toBe(false);
    withCfApi({});
    expect(platformSupportsPublish()).toBe(true);
  });
});

describe("Cloudflare API wrappers", () => {
  test("listAccounts passes through", async () => {
    withCfApi({ "/accounts": [{ id: "a1", name: "Acme" }] });
    expect(await listAccounts()).toEqual([{ id: "a1", name: "Acme" }]);
  });

  test("getPagesProject returns null when the project does not exist", async () => {
    withCfApi({ "/pages/projects/missing": new Error("404") });
    expect(await getPagesProject(DEPLOY.accountId, "missing")).toBeNull();
  });

  test("createPagesProject sends the GitHub-connected jx build config", async () => {
    const { calls } = withCfApi({
      "/pages/projects": { name: "my-site", subdomain: "my-site.pages.dev" },
    });
    await createPagesProject({
      accountId: DEPLOY.accountId,
      owner: "octocat",
      productionBranch: "main",
      projectName: "my-site",
      repo: "site",
    });
    const post = calls.find((c) => c.init?.method === "POST");
    const body = post?.init?.body as {
      build_config: { build_command: string; destination_dir: string };
      source: { type: string; config: { owner: string; repo_name: string } };
    };
    expect(body.build_config).toEqual({ build_command: "bunx jx build", destination_dir: "dist" });
    expect(body.source.type).toBe("github");
    expect(body.source.config.owner).toBe("octocat");
    expect(body.source.config.repo_name).toBe("site");
  });

  test("latestDeployment maps the newest deployment and handles none", async () => {
    withCfApi({
      "/deployments": [
        {
          id: "d1",
          url: "https://abc.my-site.pages.dev",
          environment: "production",
          latest_stage: { name: "deploy", status: "success" },
          created_on: "2026-07-06T00:00:00Z",
        },
      ],
    });
    expect(await latestDeployment(DEPLOY)).toEqual({
      id: "d1",
      url: "https://abc.my-site.pages.dev",
      environment: "production",
      stage: "deploy",
      status: "success",
      createdOn: "2026-07-06T00:00:00Z",
    });
    withCfApi({ "/deployments": [] });
    expect(await latestDeployment(DEPLOY)).toBeNull();
  });
});

describe("writeDeployConfig", () => {
  test("writes build.deploy into project.json and syncs wrangler.jsonc", async () => {
    const { state } = withCfApi({});
    await writeDeployConfig({ build: { adapter: "cloudflare-pages" }, name: "My Site" }, DEPLOY);
    const writes = state.calls.filter((c) => c[0] === "writeFile");
    const project = writes.find((c) => c[1] === "project.json");
    const wrangler = writes.find((c) => c[1] === "wrangler.jsonc");
    const config = JSON.parse(String(project?.[2])) as {
      build: { adapter: string; deploy: DeployConfig };
    };
    expect(config.build.deploy).toEqual(DEPLOY);
    expect(config.build.adapter).toBe("cloudflare-pages");
    const wranglerConfig = JSON.parse(String(wrangler?.[2])) as {
      name: string;
      pages_build_output_dir: string;
    };
    expect(wranglerConfig.name).toBe("my-site");
    expect(wranglerConfig.pages_build_output_dir).toBe("./dist");
  });

  test("disconnecting removes the block and leaves wrangler.jsonc alone", async () => {
    const { state } = withCfApi({});
    await writeDeployConfig(
      { build: { adapter: "cloudflare-pages", deploy: DEPLOY }, name: "My Site" },
      null,
    );
    const writes = state.calls.filter((c) => c[0] === "writeFile");
    expect(writes.some((c) => c[1] === "wrangler.jsonc")).toBe(false);
    const config = JSON.parse(String(writes[0]?.[2])) as { build: Record<string, unknown> };
    expect(config.build["deploy"]).toBeUndefined();
    expect(config.build["adapter"]).toBe("cloudflare-pages");
  });
});

describe("connectDeploy", () => {
  const OPTS = {
    accountId: DEPLOY.accountId,
    owner: "octocat",
    productionBranch: "main",
    projectName: "my-site",
    repo: "site",
  };

  test("reuses an existing Pages project without creating", async () => {
    const { calls } = withCfApi({
      "/pages/projects/my-site": { name: "my-site", subdomain: "my-site.pages.dev" },
    });
    const deploy = await connectDeploy({ build: {}, name: "My Site" }, OPTS);
    expect(deploy.productionUrl).toBe("https://my-site.pages.dev");
    expect(calls.some((c) => c.init?.method === "POST")).toBe(false);
  });

  test("creates the project when missing", async () => {
    const { calls } = withCfApi({
      "/pages/projects/my-site": new Error("404"),
      "/pages/projects": (init?: { method?: string }) =>
        init?.method === "POST" ? { name: "my-site" } : new Error("404"),
    });
    const deploy = await connectDeploy({ build: {}, name: "My Site" }, OPTS);
    expect(deploy).toEqual({
      provider: "cloudflare-pages",
      accountId: DEPLOY.accountId,
      projectName: "my-site",
    });
    expect(calls.some((c) => c.init?.method === "POST")).toBe(true);
  });
});
