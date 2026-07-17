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

import { writeFileSync } from "node:fs";
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

export interface BundleOptions {
  /** Resolution/runtime target. Client sidecars use "browser"; the worker (follow-up) adds more. */
  target: "browser";
  /** Bare specifiers left unresolved in the output. */
  external?: string[];
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
      entryPoints: [request.entryPath],
      external,
      format: "esm",
      logLevel: "silent",
      minify: false,
      outfile: request.outfile,
      platform: opts.target,
    });
    return;
  }

  const result = await Bun.build({
    entrypoints: [request.entryPath],
    external,
    format: "esm",
    minify: false,
    target: opts.target,
    throw: false,
  });
  if (!result.success || result.outputs.length === 0) {
    const logs = result.logs.map(String).join("\n");
    throw new Error(`Bun.build failed for ${request.entryPath}:\n${logs}`);
  }
  writeFileSync(request.outfile, await result.outputs[0]!.text(), "utf8");
}
