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
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { isNpmSpecifier, NPM_SPECIFIER_PREFIX } from "@jxsuite/schema/asset-paths";
import type { BunPlugin } from "bun";

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
export function useNodeFallback(): boolean {
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

/**
 * A resolution hook, in the one shape both backends accept.
 *
 * `external: true` leaves the import in the output **as the source wrote it** — Bun ignores a
 * rewritten `path` for an external, so a caller that needs the two backends to agree returns the
 * specifier it was given and plans around the original text.
 */
export interface BundleResolver {
  /** Which specifiers the hook is consulted for. */
  filter: RegExp;
  /** `undefined` falls through to the bundler's own resolution. */
  resolve: (args: {
    path: string;
    importer: string;
  }) => { path: string; external: true } | undefined;
}

export interface BundleOptions {
  target: BundleTargetName;
  /** Bare specifiers left unresolved in the output. */
  external?: string[];
  /** Package.json export conditions for resolution (e.g. ["workerd", "worker"]). */
  conditions?: string[];
  /** Resolution hooks, applied before the bundler's own resolution. */
  resolver?: BundleResolver;
  /**
   * Whether to minify the bundle.
   *
   * Defaults to true for `target: "browser"` and false everywhere else: browser output is parsed on
   * someone else's phone, server output is read off a stack trace. Callers override it — the site
   * build from `build.minify`, and `jx dev` to keep a breakpoint on a line somebody wrote.
   */
  minify?: boolean;
  /**
   * Called with the absolute path of every file the bundler loads.
   *
   * The only way to ask a backend where a bare specifier _actually_ lands: resolution depends on
   * the target, the export conditions and the `NODE_ENV` define, so a caller that resolves the
   * specifier itself gets a different file than the bundle did — which is how the client runtime
   * used to hand pages the `node` build of a browser package.
   */
  onFileLoaded?: (path: string) => void;
}

interface PluginBuild {
  onResolve: (
    options: { filter: RegExp },
    callback: (args: { path: string; importer: string }) => unknown,
  ) => void;
  onLoad: (options: { filter: RegExp }, callback: (args: { path: string }) => unknown) => void;
}

/** Wrap the hooks as the one-plugin array both backends take. */
function hookPlugins(opts: BundleOptions): NonNullable<Parameters<typeof Bun.build>[0]["plugins"]> {
  const { onFileLoaded, resolver } = opts;
  if (resolver === undefined && onFileLoaded === undefined) {
    return [];
  }
  const setup = (build: PluginBuild): void => {
    if (resolver !== undefined) {
      build.onResolve({ filter: resolver.filter }, (args) => resolver.resolve(args));
    }
    if (onFileLoaded !== undefined) {
      // Returning nothing hands the file back to the backend's own loader — this only observes.
      build.onLoad({ filter: /.*/ }, (args) => {
        onFileLoaded(args.path);
      });
    }
  };
  return [{ name: "jx-bundle-hooks", setup } as unknown as BunPlugin];
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

/**
 * Substitutions applied to browser bundles.
 *
 * `process` does not exist in a browser, so `process.env.NODE_ENV` has to be replaced by something
 * — but the value also decides which `exports` condition a package resolves to, and that is the
 * part that mattered. Bun reads it from the build's own `define` (it ignores a `NODE_ENV` set after
 * the process started), and with no answer it assumes development: `lit-html` was resolving to its
 * 31 kB dev build, which logs "Lit is in dev mode" into every visitor's console, instead of the 10
 * kB production one. esbuild already chose production, so the two backends were shipping different
 * code — exactly what this module exists to prevent.
 */
const BROWSER_DEFINE = { "process.env.NODE_ENV": '"production"' } as const;

/**
 * Whether this bundle is minified.
 *
 * Browser output defaults to minified and everything else to readable. Measured on jxsuite.com's
 * own deployed bytes, the six scripts a page loads go from 155,254 B to 64,994 B — and it is the 90
 * kB of source a phone no longer has to parse, not the 16 kB it no longer downloads, that moves
 * Total Blocking Time.
 *
 * This widens the backend divergence {@link BROWSER_DEFINE} warns about: the two minifiers agree on
 * semantics, not on bytes. A build that diffs `dist/` must pin one backend (`JX_BUNDLER=esbuild`).
 */
function shouldMinify(opts: BundleOptions): boolean {
  return opts.minify ?? opts.target === "browser";
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
  const plugins = hookPlugins(opts);

  if (useNodeFallback()) {
    // Dynamic import keeps esbuild (a native-binary dependency) out of Bun-run builds entirely.
    const esbuild = await import("esbuild");
    await esbuild.build({
      bundle: true,
      ...(opts.conditions ? { conditions: opts.conditions } : {}),
      ...(opts.target === "browser" ? { define: { ...BROWSER_DEFINE } } : {}),
      entryPoints: [request.entryPath],
      external,
      format: "esm",
      logLevel: "silent",
      minify: shouldMinify(opts),
      outfile: request.outfile,
      platform: esbuildPlatform(opts.target),
      plugins: plugins as unknown as NonNullable<Parameters<typeof esbuild.build>[0]["plugins"]>,
    });
    return;
  }

  const result = await Bun.build({
    ...(opts.conditions ? { conditions: opts.conditions } : {}),
    ...(opts.target === "browser" ? { define: { ...BROWSER_DEFINE } } : {}),
    entrypoints: [request.entryPath],
    external,
    format: "esm",
    minify: shouldMinify(opts),
    plugins,
    target: bunTarget(opts.target),
    throw: false,
  });
  if (!result.success || result.outputs.length === 0) {
    const logs = result.logs.map(String).join("\n");
    throw new Error(`Bun.build failed for ${request.entryPath}:\n${logs}`);
  }
  writeFileSync(request.outfile, await result.outputs[0]!.text(), "utf8");
}

/** Basename prefix of the throwaway entry {@link bundleSource} writes for the Bun backend. */
const TRANSIENT_ENTRY_PREFIX = ".jx-entry-";

/**
 * True for the throwaway entry a {@link bundleSource} call is bundling, under either backend.
 *
 * A resolver hook needs it to tell the entry's OWN import apart from the imports of whatever that
 * import pulled in — the two want opposite answers, and only the importer distinguishes them.
 * esbuild bundles the string from stdin and names it `<stdin>`; Bun has no stdin input and writes a
 * real file.
 */
export function isTransientEntry(importer: string): boolean {
  return importer === "<stdin>" || basename(importer).startsWith(TRANSIENT_ENTRY_PREFIX);
}

/**
 * The file a bare specifier resolves to **through the bundler** — under the same target, export
 * conditions and `NODE_ENV` define the real bundle uses.
 *
 * `Bun.resolveSync` and `createRequire` answer a different question. Neither applies the export
 * conditions a browser bundle does, so both hand back the `node` or `development` build of a
 * package a page asked for the browser build of — the bug {@link BROWSER_DEFINE} exists to prevent,
 * reintroduced one layer up. Returns `undefined` when the specifier does not resolve at all.
 */
export async function resolveThroughBundler(
  specifier: string,
  resolveDir: string,
  opts: BundleOptions,
): Promise<string | undefined> {
  const loaded: string[] = [];
  const outfile = join(tmpdir(), `jx-resolve-${process.pid}.js`);
  try {
    await bundleSource(
      `export * from ${JSON.stringify(specifier)};\n`,
      { outfile, resolveDir },
      // The output is deleted in `finally` — this only wants the resolution, so never pay to minify.
      { ...opts, minify: false, onFileLoaded: (path) => loaded.push(path) },
    );
  } catch {
    return undefined;
  } finally {
    rmSync(outfile, { force: true });
  }
  return loaded.find((path) => !isTransientEntry(path));
}

/**
 * Bundle a source string rather than a file, resolving its imports from `resolveDir`.
 *
 * The indirection buys resolution control: what a bare specifier means depends on where you stand,
 * and the two callers stand in different places. Worker source resolves from the project root,
 * exactly as the unbundled source would have; the client runtime resolves from the compiler's own
 * directory, because the compiler is what depends on it.
 */
export async function bundleSource(
  source: string,
  { resolveDir, outfile }: { resolveDir: string; outfile: string },
  opts: BundleOptions,
): Promise<void> {
  if (useNodeFallback()) {
    const esbuild = await import("esbuild");
    await esbuild.build({
      bundle: true,
      ...(opts.conditions ? { conditions: opts.conditions } : {}),
      ...(opts.target === "browser" ? { define: { ...BROWSER_DEFINE } } : {}),
      external: opts.external ?? [],
      format: "esm",
      logLevel: "silent",
      minify: shouldMinify(opts),
      outfile,
      platform: esbuildPlatform(opts.target),
      stdin: { contents: source, loader: "js", resolveDir, sourcefile: "jx-entry.js" },
    });
    return;
  }

  // Bun.build has no stdin input — write a transient entry in `resolveDir` so resolution matches
  // The stdin/resolveDir behavior, and always remove it.
  const entryPath = join(resolveDir, `${TRANSIENT_ENTRY_PREFIX}${process.pid}.mjs`);
  writeFileSync(entryPath, source, "utf8");
  try {
    await bundleEntry({ entryPath, outfile }, opts);
  } finally {
    rmSync(entryPath, { force: true });
  }
}

/**
 * Bundle generated worker source into a self-contained module for the adapter's runtime. Bare and
 * relative specifiers resolve from the project root — exactly how the unbundled source would have
 * resolved when served from within the project.
 */
export async function bundleWorkerSource(
  source: string,
  { projectRoot, outfile, adapter }: { projectRoot: string; outfile: string; adapter: string },
): Promise<void> {
  await bundleSource(source, { outfile, resolveDir: projectRoot }, workerBundleOptions(adapter));
}
