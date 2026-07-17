/**
 * Bundler.js — timing-aware module bundling for compiled sites
 *
 * One backend abstraction serving every bundling need of the build (spec.md §12, compiler.md):
 * client-timing `$src` sidecars today, the server worker in a follow-up. Backend selection is
 * runtime-adaptive: `Bun.build` when the build runs under Bun, esbuild (dynamically imported) under
 * plain Node. Options are kept minimal and identical across backends so output stays as stable as
 * possible; set `JX_BUNDLER=esbuild` to force the fallback (e.g. for parity checks).
 *
 * `timing: "compiler"` code is never bundled — it executes in the build host via the extension
 * registry's `importImplementation` path.
 */

import { rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { isNpmSpecifier, NPM_SPECIFIER_PREFIX } from "@jxsuite/schema/asset-paths";

/** Import specifiers left external in client bundles — provided by the page importmap. */
export const CLIENT_EXTERNALS = ["@vue/reactivity", "lit-html"];

/**
 * True when a Function-def `$src` specifier is bundled by the build: `npm:` package specifiers and
 * project-relative files. Absolute URL paths (`/lib/x.js`, `https://…`) are served as-is.
 */
export function isBundleableSrc(specifier: string): boolean {
  return isNpmSpecifier(specifier) || specifier.startsWith("./") || specifier.startsWith("../");
}

/**
 * True when the Node code path (createRequire resolution, esbuild backend) should be used: always
 * under plain Node, or when `JX_BUNDLER=esbuild` forces it for parity checks.
 */
function useNodeFallback(): boolean {
  return typeof Bun === "undefined" || process.env.JX_BUNDLER === "esbuild";
}

/**
 * Resolve a bundleable `$src` specifier to the absolute entry file the bundler starts from. `npm:`
 * specifiers resolve from the project root (project node_modules first, then up-tree); relative
 * specifiers resolve against the directory of the document that declared them.
 */
export function resolveSidecarEntry(
  specifier: string,
  docDir: string,
  projectRoot: string,
): string {
  if (isNpmSpecifier(specifier)) {
    const bare = specifier.slice(NPM_SPECIFIER_PREFIX.length);
    if (useNodeFallback()) {
      return createRequire(join(projectRoot, "package.json")).resolve(bare);
    }
    return Bun.resolveSync(bare, projectRoot);
  }
  return resolve(docDir, specifier);
}

export interface BundleRequest {
  /** Absolute path of the module to bundle. */
  entryPath: string;
  /** Absolute path of the bundled output file. */
  outfile: string;
}

/** Resolution/runtime targets: client sidecars use "browser"; the site worker uses the rest. */
export type BundleTargetName = "browser" | "node" | "bun" | "workerd";

export interface BundleOptions {
  target: BundleTargetName;
  /** Bare specifiers left unresolved in the output. */
  external?: string[];
  /** Package.json export conditions for resolution (e.g. ["workerd", "worker"]). */
  conditions?: string[];
}

/**
 * Per-adapter bundle options for the generated site worker (WinterTC runtimes). Cloudflare resolves
 * with workerd conditions and keeps `cloudflare:*`/`node:*` imports external (nodejs_compat
 * provides node builtins at runtime); node/bun bundle platform-native with builtins external by
 * construction.
 */
export function workerBundleOptions(adapter: string): BundleOptions {
  if (adapter === "cloudflare-workers" || adapter === "cloudflare-pages") {
    return {
      conditions: ["workerd", "worker"],
      external: ["cloudflare:*", "node:*"],
      target: "workerd",
    };
  }
  return { target: adapter === "bun" ? "bun" : "node" };
}

/** Map a bundle target to esbuild's platform (conditions carry the workerd specifics). */
function esbuildPlatform(target: BundleTargetName): "browser" | "node" {
  return target === "node" || target === "bun" ? "node" : "browser";
}

/** Map a bundle target to Bun.build's target. */
function bunTarget(target: BundleTargetName): "browser" | "node" | "bun" {
  if (target === "workerd") {
    return "browser";
  }
  return target;
}

/**
 * Bundle one entry module into a single self-contained ESM file. Throws with the backend's
 * diagnostics on failure.
 */
export async function bundleEntry(request: BundleRequest, opts: BundleOptions): Promise<void> {
  const external = opts.external ?? [];

  if (useNodeFallback()) {
    // Dynamic import keeps esbuild (a native-binary dependency) out of Bun-run builds entirely.
    const esbuild = await import("esbuild");
    await esbuild.build({
      bundle: true,
      ...(opts.conditions ? { conditions: opts.conditions } : {}),
      entryPoints: [request.entryPath],
      external,
      format: "esm",
      logLevel: "silent",
      minify: false,
      outfile: request.outfile,
      platform: esbuildPlatform(opts.target),
    });
    return;
  }

  const result = await Bun.build({
    ...(opts.conditions ? { conditions: opts.conditions } : {}),
    entrypoints: [request.entryPath],
    external,
    format: "esm",
    minify: false,
    target: bunTarget(opts.target),
    throw: false,
  });
  if (!result.success || result.outputs.length === 0) {
    const logs = result.logs.map(String).join("\n");
    throw new Error(`Bun.build failed for ${request.entryPath}:\n${logs}`);
  }
  writeFileSync(request.outfile, await result.outputs[0]!.text(), "utf8");
}

/**
 * Bundle generated worker source (a string, not a file) into a self-contained module for the
 * adapter's runtime. Bare and relative specifiers resolve from the project root — exactly how the
 * unbundled source would have resolved when served from within the project.
 */
export async function bundleWorkerSource(
  source: string,
  { projectRoot, outfile, adapter }: { projectRoot: string; outfile: string; adapter: string },
): Promise<void> {
  const opts = workerBundleOptions(adapter);

  if (useNodeFallback()) {
    const esbuild = await import("esbuild");
    await esbuild.build({
      bundle: true,
      ...(opts.conditions ? { conditions: opts.conditions } : {}),
      external: opts.external ?? [],
      format: "esm",
      logLevel: "silent",
      minify: false,
      outfile,
      platform: esbuildPlatform(opts.target),
      stdin: {
        contents: source,
        loader: "js",
        resolveDir: projectRoot,
        sourcefile: "jx-worker-entry.js",
      },
    });
    return;
  }

  // Bun.build has no stdin input — write a transient entry at the project root so resolution
  // Matches the stdin/resolveDir behavior, and always remove it.
  const entryPath = join(projectRoot, ".jx-worker-entry.mjs");
  writeFileSync(entryPath, source, "utf8");
  try {
    await bundleEntry({ entryPath, outfile }, opts);
  } finally {
    rmSync(entryPath, { force: true });
  }
}
