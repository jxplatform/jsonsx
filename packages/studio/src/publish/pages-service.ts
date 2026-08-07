/// <reference lib="dom" />
/**
 * Pages-service — Cloudflare Pages publish domain logic over the PAL's
 * `cfApi` passthrough. Works identically on every platform that provides it:
 * the dev server / desktop (user API token via cf-settings → /__studio/cf/proxy)
 * and the cloud platform (hosted OAuth). Publish state is written to
 * project.json `build.deploy` — it travels with the repo, so any Studio can
 * tell whether the publish workflow already exists.
 *
 * @license MIT
 */

import { updateWranglerConfig } from "@jxsuite/create/scaffold";
import type { DeployConfig, ProjectConfig } from "@jxsuite/schema/types";
import { getPlatform } from "../platform";
import { updateSiteConfig } from "../site-context";

export interface CfAccount {
  id: string;
  name: string;
}

export interface PagesDeploymentInfo {
  id: string;
  url: string;
  environment: string;
  /** Latest stage name/status, e.g. "deploy: success" or "build: failure". */
  stage: string;
  status: string;
  createdOn: string;
}

export interface ConnectOptions {
  accountId: string;
  projectName: string;
  productionBranch: string;
  owner: string;
  repo: string;
}

/** True when the active platform can reach the Cloudflare API. */
export function platformSupportsPublish(): boolean {
  // Answers false before a platform is registered rather than throwing. This is read by ambient
  // Surfaces — the status bar's deploy item, the Activity tab's checklist — which paint during boot
  // And in tests that register no platform, and neither has any business crashing because
  // Publishing is not available yet. "Can this host publish?" has a truthful answer before the host
  // Exists, and it is no.
  try {
    return typeof getPlatform().cfApi === "function";
  } catch {
    return false;
  }
}

async function cfApi<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const api = getPlatform().cfApi;
  if (!api) {
    throw new Error("This platform cannot reach the Cloudflare API");
  }
  return (await api(path, init)) as T;
}

export async function listAccounts(): Promise<CfAccount[]> {
  return cfApi<CfAccount[]>("/accounts");
}

interface PagesProjectWire {
  name: string;
  subdomain?: string;
  domains?: string[];
}

/** The Pages project, or null when it does not exist yet. */
export async function getPagesProject(
  accountId: string,
  projectName: string,
): Promise<PagesProjectWire | null> {
  try {
    return await cfApi<PagesProjectWire>(`/accounts/${accountId}/pages/projects/${projectName}`);
  } catch {
    return null;
  }
}

/**
 * Create a GitHub-connected Pages project that builds `bunx jx build` on every push. Requires the
 * Cloudflare Pages GitHub App on the repo — the characteristic failure is surfaced to the caller
 * with an install hint.
 */
export async function createPagesProject(opts: ConnectOptions): Promise<PagesProjectWire> {
  return cfApi<PagesProjectWire>(`/accounts/${opts.accountId}/pages/projects`, {
    method: "POST",
    body: {
      name: opts.projectName,
      production_branch: opts.productionBranch,
      build_config: {
        build_command: "bunx jx build",
        destination_dir: "dist",
      },
      source: {
        type: "github",
        config: {
          owner: opts.owner,
          repo_name: opts.repo,
          production_branch: opts.productionBranch,
          deployments_enabled: true,
        },
      },
    },
  });
}

interface DeploymentWire {
  id: string;
  url: string;
  environment: string;
  latest_stage?: { name?: string; status?: string };
  created_on: string;
}

/** The most recent deployment of the connected project, or null when none. */
export async function latestDeployment(deploy: DeployConfig): Promise<PagesDeploymentInfo | null> {
  const deployments = await cfApi<DeploymentWire[]>(
    `/accounts/${deploy.accountId}/pages/projects/${deploy.projectName}/deployments`,
  );
  const [latest] = deployments;
  if (!latest) {
    return null;
  }
  return {
    id: latest.id,
    url: latest.url,
    environment: latest.environment,
    stage: latest.latest_stage?.name ?? "unknown",
    status: latest.latest_stage?.status ?? "unknown",
    createdOn: latest.created_on,
  };
}

/**
 * Write (or with null, remove) the `build.deploy` block, preserving the rest of `build`. On
 * connect, wrangler.jsonc is patched so its `name` matches the connected Pages project
 * (comment-bearing JSONC is left alone).
 */
export async function writeDeployConfig(
  config: ProjectConfig,
  deploy: DeployConfig | null,
): Promise<void> {
  const build: NonNullable<ProjectConfig["build"]> = { ...config.build };
  if (deploy === null) {
    delete build.deploy;
  } else {
    build.deploy = deploy;
  }
  await updateSiteConfig({ build });

  if (deploy !== null) {
    const platform = getPlatform();
    let existing: string | null = null;
    try {
      existing = await platform.readFile("wrangler.jsonc");
    } catch {
      existing = null;
    }
    const adapter =
      build.adapter === "cloudflare-workers" ? "cloudflare-workers" : "cloudflare-pages";
    const { content, patched } = updateWranglerConfig(existing, {
      adapter,
      slug: deploy.projectName,
    });
    if (patched) {
      await platform.writeFile("wrangler.jsonc", content);
    }
  }
}

/**
 * The whole connect flow: reuse the Pages project when it already exists, create it otherwise, then
 * persist `build.deploy` (+ wrangler.jsonc sync).
 */
export async function connectDeploy(
  config: ProjectConfig,
  opts: ConnectOptions,
): Promise<DeployConfig> {
  const existing = await getPagesProject(opts.accountId, opts.projectName);
  const project = existing ?? (await createPagesProject(opts));
  const deploy: DeployConfig = {
    provider: "cloudflare-pages",
    accountId: opts.accountId,
    projectName: opts.projectName,
    ...(project.subdomain ? { productionUrl: `https://${project.subdomain}` } : {}),
  };
  await writeDeployConfig(config, deploy);
  return deploy;
}
