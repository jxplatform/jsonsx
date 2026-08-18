/**
 * The two modules every interactive page imports, served from the site rather than from a CDN.
 *
 * They used to resolve to `https://esm.sh/…` in the emitted import map. That put a third party in
 * the load path of every interactive Jx site — no integrity metadata, no availability guarantee —
 * and it made a strict Content-Security-Policy impossible, because `default-src 'self'` would have
 * broken every one of those pages. The old argument for a shared CDN was a shared browser cache,
 * and that argument expired when browsers partitioned the HTTP cache by top-level site: a visitor
 * arriving from another esm.sh site downloads it again regardless.
 *
 * Bundled, not copied, and resolved from **this package's** directory rather than the project's:
 * `@jxsuite/compiler` is what depends on these versions, so a project that never installed them
 * still gets the runtime its compiled output was built against.
 *
 * @docs framework/build
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import type { BundleResolver } from "./bundler.ts";
import {
  bundleSource,
  isTransientEntry,
  resolveThroughBundler,
  useNodeFallback,
} from "./bundler.ts";
import { DEFAULT_LIT_HTML_SRC, DEFAULT_REACTIVITY_SRC } from "../shared.ts";

/** One import-map entry the build can satisfy itself. */
interface RuntimeModule {
  specifier: string;
  assetPath: string;
  /** Where the entry points when this package cannot be resolved at all. */
  fallback: string;
  /**
   * Directory this package's SUBPATHS are served from, and the value of its import-map prefix key.
   *
   * A third-party component does not import only `lit-html`; it imports
   * `lit-html/directives/class-map.js` too. Those stay external in its bundle — a package-name
   * external covers the package's subpaths as well — so without a prefix key the page dies on
   * `Failed to resolve module specifier`. Trailing slashes on both sides are required: that is what
   * makes it a prefix mapping rather than an exact one.
   */
  assetDir: string;
}

export const CLIENT_RUNTIME_MODULES: readonly RuntimeModule[] = [
  {
    assetDir: "/assets/@vue/reactivity/",
    assetPath: "/assets/vue-reactivity.js",
    fallback: DEFAULT_REACTIVITY_SRC,
    specifier: "@vue/reactivity",
  },
  {
    assetDir: "/assets/lit-html/",
    assetPath: "/assets/lit-html.js",
    fallback: DEFAULT_LIT_HTML_SRC,
    specifier: "lit-html",
  },
];

/** An import-map prefix key — `"lit-html/"` — as opposed to an exact specifier. */
export function isPrefixSpecifier(specifier: string): boolean {
  return specifier.endsWith("/");
}

export interface ClientRuntime {
  /** The import map's `imports` object. */
  imports: Record<string, string>;
  /** Warnings for any module that fell back to the CDN. */
  warnings: string[];
  /** Site-relative asset paths this build must write. Empty when everything fell back. */
  assetPaths: string[];
}

/**
 * Resolve where each runtime module will be served from, without writing anything yet.
 *
 * Split from the write so the import map can be built before the first page is compiled while the
 * bundles are only produced if some page actually emitted one — the same shape the sidecar bundler
 * uses.
 *
 * @param {string} [resolveDir] - Directory bare specifiers resolve from; defaults to this package
 * @returns {ClientRuntime}
 */
export function resolveClientRuntime(resolveDir: string = import.meta.dir): ClientRuntime {
  const imports: Record<string, string> = {};
  const warnings: string[] = [];
  const assetPaths: string[] = [];

  for (const mod of CLIENT_RUNTIME_MODULES) {
    if (canResolve(mod.specifier, resolveDir)) {
      imports[mod.specifier] = mod.assetPath;
      /*
       * The prefix key is emitted whether or not any subpath turns out to be used. It costs two
       * lines of JSON, and the alternative is knowing the subpath set before the first page is
       * compiled — which is impossible, since the set is discovered from the bundles themselves.
       */
      imports[`${mod.specifier}/`] = mod.assetDir;
      assetPaths.push(mod.assetPath);
    } else {
      imports[mod.specifier] = mod.fallback;
      warnings.push(
        `Could not resolve "${mod.specifier}" — the import map falls back to ${mod.fallback}. ` +
          "Interactive pages will load it from a third party, and a `default-src 'self'` policy " +
          "will block them.",
      );
    }
  }
  return { assetPaths, imports, warnings };
}

/**
 * Write the runtime bundles this build resolved locally.
 *
 * @param {ClientRuntime} runtime
 * @param {string} outDir
 * @param {string} [resolveDir]
 * @returns {Promise<{ written: number; errors: string[] }>}
 */
export async function writeClientRuntime(
  runtime: ClientRuntime,
  outDir: string,
  resolveDir: string = import.meta.dir,
): Promise<{ written: number; errors: string[] }> {
  const errors: string[] = [];
  let written = 0;

  for (const mod of CLIENT_RUNTIME_MODULES) {
    if (!runtime.assetPaths.includes(mod.assetPath)) {
      continue;
    }
    const outfile = resolve(outDir, mod.assetPath.replace(/^\//, ""));
    mkdirSync(dirname(outfile), { recursive: true });
    try {
      /*
       * Re-export rather than copy: the published file may be the `node` condition of a package
       * with several, and only a bundler standing in the right place with the right conditions
       * picks the browser one.
       */
      await bundleSource(
        `export * from ${JSON.stringify(mod.specifier)};\n`,
        { outfile, resolveDir },
        { target: "browser" },
      );
      written += 1;
    } catch (error) {
      errors.push(`Bundling client runtime "${mod.specifier}": ${(error as Error).message}`);
    }
  }
  return { errors, written };
}

/** Render the `<script type="importmap">` block for a resolved runtime. */
export function renderImportMap(imports: Record<string, string>): string {
  const entries = Object.entries(imports)
    .map(([name, url]) => `      ${JSON.stringify(name)}: ${JSON.stringify(url)}`)
    .join(",\n");
  return `<script type="importmap">\n  {\n    "imports": {\n${entries}\n    }\n  }\n  </script>`;
}

/**
 * True when a bare specifier resolves from `resolveDir` under either backend.
 *
 * The backend choice is `bundler.ts`'s to make, not a second inline `typeof Bun` check: resolution
 * and bundling must agree about which one they are on, or the import map promises a module the
 * bundle then fails to produce.
 */
function canResolve(specifier: string, resolveDir: string): boolean {
  try {
    if (useNodeFallback()) {
      return typeof createRequire(join(resolveDir, "x.js")).resolve(specifier) === "string";
    }
    return typeof Bun.resolveSync(specifier, resolveDir) === "string";
  } catch {
    return false;
  }
}

/** How many discovery passes may run before the scan is declared cyclic rather than deep. */
const MAX_SUBPATH_PASSES = 10;

/**
 * Emit the package subpaths the built bundles actually import, so the prefix keys resolve.
 *
 * The subpath set cannot be known before the build: it is a property of whichever third-party
 * components a page happens to register. So it is discovered _from the output_ — every emitted
 * `.js` asset is scanned for an import of `<runtime package>/<subpath>`, each is bundled to the
 * directory its prefix key names, and the scan repeats over what that produced. Bundling can
 * introduce new subpaths (a directive importing another directive), so the pass runs to closure
 * rather than once.
 *
 * **The subpath itself must be bundled, and only the core kept external.** A package-name external
 * covers the package's subpaths too, so listing `lit-html` in `external` externalises the entry —
 * and the emitted asset is then a re-export of the very specifier the import map points back at it.
 * That file imports itself: `export * from "lit-html/directives/class-map.js"` served AS
 * `/assets/lit-html/directives/class-map.js`. A self-referential module has an empty namespace, so
 * every page using a directive died on an undefined import while the build reported success. The
 * externals are therefore decided by a resolver hook that can see the importer, not by a name
 * list.
 *
 * The core stays shared, which is the part that must not regress: two copies of lit on a page is a
 * documented breakage, not a waste. A package imports its own core by RELATIVE path from inside
 * itself (`../lit-html.js`), and a bundler keeps an external's specifier exactly as the source
 * wrote it — so the shared copy is reached by emitting a stub at the place that relative path lands
 * in the OUTPUT tree, re-exporting the bare specifier the import map already resolves.
 *
 * @param {string} outDir - Build output root
 * @param {string} [resolveDir] - Directory bare specifiers resolve from
 * @returns {Promise<{ written: number; errors: string[] }>}
 */
export async function writeRuntimeSubpaths(
  outDir: string,
  resolveDir: string = import.meta.dir,
): Promise<{ written: number; errors: string[] }> {
  const errors: string[] = [];
  const done = new Set<string>();
  /** Output path of a core re-export stub → the bare specifier it must re-export. */
  const mirrors = new Map<string, string>();
  /** Runtime package specifier → the core file the bundler resolves it to. */
  const cores = new Map<string, string | undefined>();
  const assetsDir = resolve(outDir, "assets");
  let written = 0;

  const coreOf = async (mod: RuntimeModule): Promise<string | undefined> => {
    if (!cores.has(mod.specifier)) {
      cores.set(
        mod.specifier,
        await resolveThroughBundler(mod.specifier, resolveDir, { target: "browser" }),
      );
    }
    return cores.get(mod.specifier);
  };

  /** `from "lit-html/directives/class-map.js"` — the import forms a bundler emits. */
  const importedSpecifiers = async (file: string): Promise<string[]> => {
    const text = await Bun.file(file).text();
    return [...text.matchAll(/(?:from|import)\s*["']([^"']+)["']/g)].map((m) => m[1] as string);
  };

  for (let pass = 0; pass < MAX_SUBPATH_PASSES; pass++) {
    let discovered = 0;
    let files: string[] = [];
    try {
      files = await Array.fromAsync(
        new Bun.Glob("**/*.js").scan({ absolute: true, cwd: assetsDir }),
      );
    } catch {
      return finish(outDir, mirrors, errors, written);
    }

    for (const file of files) {
      let specifiers: string[] = [];
      try {
        specifiers = await importedSpecifiers(file);
      } catch {
        continue;
      }
      for (const specifier of specifiers) {
        const mod = CLIENT_RUNTIME_MODULES.find((m) => specifier.startsWith(`${m.specifier}/`));
        if (!mod || done.has(specifier)) {
          continue;
        }
        done.add(specifier);
        const subpath = specifier.slice(mod.specifier.length + 1);
        const outfile = resolve(outDir, `${mod.assetDir.replace(/^\//, "")}${subpath}`);
        mkdirSync(dirname(outfile), { recursive: true });
        try {
          await bundleSource(
            `export * from ${JSON.stringify(specifier)};\n`,
            { outfile, resolveDir },
            {
              resolver: shareRuntimeCore(mod, outfile, await coreOf(mod), mirrors),
              target: "browser",
            },
          );
          written += 1;
          discovered += 1;
        } catch (error) {
          errors.push(`Bundling runtime subpath "${specifier}": ${(error as Error).message}`);
        }
      }
    }
    if (discovered === 0) {
      return finish(outDir, mirrors, errors, written);
    }
  }
  errors.push(
    `Runtime subpath resolution did not settle in ${MAX_SUBPATH_PASSES} passes — a package subpath ` +
      "graph this deep is more likely a cycle in the scan than a real dependency chain.",
  );
  return finish(outDir, mirrors, errors, written);
}

/**
 * Keep a runtime package's core out of the subpath bundle, and note where the shared copy has to
 * appear for the specifier the bundler will leave behind to reach it.
 *
 * @param {RuntimeModule} owner - The runtime package this subpath belongs to
 * @param {string} outfile - Where this subpath's bundle is being written
 * @param {string | undefined} core - The package's core file, or undefined if it did not resolve
 * @param {Map<string, string>} mirrors - Collects the core re-export stubs the build must write
 * @returns {BundleResolver}
 */
function shareRuntimeCore(
  owner: RuntimeModule,
  outfile: string,
  core: string | undefined,
  mirrors: Map<string, string>,
): BundleResolver {
  return {
    filter: /.*/,
    resolve: ({ importer, path }) => {
      /*
       * The entry's own import is the subpath being bundled. It must resolve — externalising it
       * is what made the emitted asset import itself.
       */
      if (isTransientEntry(importer)) {
        return;
      }
      const runtime = CLIENT_RUNTIME_MODULES.find(
        (mod) => path === mod.specifier || path.startsWith(`${mod.specifier}/`),
      );
      if (runtime !== undefined) {
        // Another runtime package, or another of this one's subpaths: the next pass emits it.
        return { external: true, path };
      }
      if (core === undefined || !path.startsWith(".")) {
        return;
      }
      /*
       * Package-internal relative imports are resolved by path rather than by asking a backend:
       * the runtime packages are ESM and write their extensions, and the hook has to give the same
       * answer under Bun and under esbuild.
       */
      if (resolve(dirname(importer), path) !== core) {
        return;
      }
      mirrors.set(resolve(dirname(outfile), path), owner.specifier);
      return { external: true, path };
    },
  };
}

/**
 * Write the core re-export stubs the emitted subpaths point at, and report the totals.
 *
 * A stub is skipped when a real bundle already occupies its path — that file is a subpath the build
 * was asked for, and the request outranks the shim.
 */
function finish(
  outDir: string,
  mirrors: Map<string, string>,
  errors: string[],
  written: number,
): { written: number; errors: string[] } {
  let total = written;
  for (const [path, specifier] of mirrors) {
    if (existsSync(path)) {
      continue;
    }
    try {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, `export * from ${JSON.stringify(specifier)};\n`, "utf8");
      total += 1;
    } catch (error) {
      errors.push(
        `Writing shared core stub ${relative(outDir, path)}: ${(error as Error).message}`,
      );
    }
  }
  return { errors, written: total };
}
