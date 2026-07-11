/**
 * Jx-mounts — registry-driven `/_jx/*` dispatch for the dev server (specs/extensions.md §11).
 *
 * Extension classes with a `server` block mount the same fetch-style handlers here that the
 * generated site worker mounts in production: one shared context object per project, handlers built
 * once via the static `mount(options, ctx)` capability and dispatched by basePath prefix.
 *
 * Dev conveniences over the production worker:
 *
 * - `env` is process.env merged under the project's `.dev.vars` plus `JX_PROJECT_ROOT`;
 * - Connector classes with `local: "<provider>"` are stood in by the registry's class for that
 *   provider (e.g. D1 → sqlite at `<project>/.jx/data/<connection>.sqlite`);
 * - Mount options set `autoSync: true`, so table schemas sync additively on first touch.
 *
 * The runtime is cached per project root and invalidated when project.json changes on disk.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { buildProjectExtensionRegistry } from "@jxsuite/compiler/format-host";
import { loadDevVars } from "./dev-vars.ts";
import type { ExtensionRegistry } from "@jxsuite/schema/extension-registry";
import type { FormatEntry } from "@jxsuite/schema/format-registry";
import type { ProjectConfig } from "@jxsuite/schema/types";

type MountHandler = (request: Request, env: Record<string, unknown>) => Promise<Response>;

interface MountRuntime {
  handlers: { basePath: string; handler: MountHandler }[];
  env: Record<string, unknown>;
}

/** Per-project runtime cache, invalidated when project.json's mtime moves. */
const runtimeCache = new Map<string, { mtime: number; runtime: Promise<MountRuntime | null> }>();

/** Reset the runtime cache (test hook). */
export function resetJxMounts(): void {
  runtimeCache.clear();
}

/**
 * Dispatch a `/_jx/*` request to the project's extension mounts.
 *
 * @param {Request} req
 * @param {URL} url
 * @param {string} projectRoot - Absolute project root (the active studio project, or the server
 *   root)
 * @returns {Promise<Response | null>} A response, or null when no mount claims the path
 */
export async function handleJxMounts(
  req: Request,
  url: URL,
  projectRoot: string,
): Promise<Response | null> {
  if (!url.pathname.startsWith("/_jx/")) {
    return null;
  }
  const runtime = await getRuntime(projectRoot);
  if (!runtime) {
    return null;
  }
  for (const { basePath, handler } of runtime.handlers) {
    if (url.pathname === basePath || url.pathname.startsWith(`${basePath}/`)) {
      return handler(req, runtime.env);
    }
  }
  return null;
}

/** Load (or reuse) the mount runtime for a project root. */
function getRuntime(projectRoot: string): Promise<MountRuntime | null> {
  const projectJsonPath = resolve(projectRoot, "project.json");
  if (!existsSync(projectJsonPath)) {
    return Promise.resolve(null);
  }
  const { mtimeMs } = statSync(projectJsonPath);
  const cached = runtimeCache.get(projectRoot);
  if (cached && cached.mtime === mtimeMs) {
    return cached.runtime;
  }
  const runtime = buildRuntime(projectRoot, projectJsonPath).catch((error) => {
    console.warn(
      `jx-mounts: failed to build extension mounts for ${projectRoot}:`,
      error instanceof Error ? error.message : String(error),
    );
    return null;
  });
  runtimeCache.set(projectRoot, { mtime: mtimeMs, runtime });
  return runtime;
}

/** Build the runtime: registry, sections, connector stand-ins, and the ordered mount handlers. */
async function buildRuntime(
  projectRoot: string,
  projectJsonPath: string,
): Promise<MountRuntime | null> {
  const config = JSON.parse(readFileSync(projectJsonPath, "utf8")) as ProjectConfig;
  const registry = await buildProjectExtensionRegistry(projectRoot, config);
  const mounts = registry.serverMounts();
  if (mounts.length === 0) {
    return null;
  }

  const sections: Record<string, unknown> = {};
  for (const contribution of registry.projectContributions()) {
    const { key } = contribution.project!;
    if (key in config) {
      sections[key] = config[key];
    }
  }

  const connectors = await resolveConnectorStandins(registry);
  const env: Record<string, unknown> = {
    ...process.env,
    ...loadDevVars(projectRoot),
    JX_PROJECT_ROOT: projectRoot,
  };

  // One shared mutable context, passed to every mount in order (specs/extensions.md §11).
  const ctx: Record<string, unknown> = {};
  const handlers: MountRuntime["handlers"] = [];
  for (const entry of mounts) {
    const { basePath } = entry.server!;
    const handler = (await entry.call(
      "mount",
      { autoSync: true, basePath, connectors, sections },
      ctx,
    )) as MountHandler;
    handlers.push({ basePath, handler });
  }
  return { env, handlers };
}

/**
 * Resolve connector implementation classes keyed by provider id, applying the dev-server `local`
 * stand-in rule: a connector declaring `local: "<provider>"` is served by the registry's class for
 * that provider instead of its own (specs/extensions.md §12).
 *
 * @param {ExtensionRegistry} registry
 * @returns {Promise<Record<string, unknown>>}
 */
async function resolveConnectorStandins(
  registry: ExtensionRegistry,
): Promise<Record<string, unknown>> {
  const entries = registry.connectors();
  const out: Record<string, unknown> = {};
  for (const entry of entries) {
    const provider = String(entry.connector!.provider);
    const { local } = entry.connector!;
    const target =
      typeof local === "string"
        ? (entries.find((e) => e.connector!.provider === local) ?? entry)
        : entry;
    out[provider] = await implementationClass(target);
  }
  return out;
}

/** Import a connector entry's implementation module and pick the export named by its title. */
async function implementationClass(entry: FormatEntry): Promise<unknown> {
  const mod = await entry.implementation();
  const title = (entry.classDef.title as string | undefined) ?? entry.name;
  const fromDefault = (mod.default as Record<string, unknown> | undefined)?.[title];
  return mod[title] ?? fromDefault ?? mod.default;
}
