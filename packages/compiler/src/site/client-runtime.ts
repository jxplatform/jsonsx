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

import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { bundleSource } from "./bundler.ts";
import { DEFAULT_LIT_HTML_SRC, DEFAULT_REACTIVITY_SRC } from "../shared.ts";

/** One import-map entry the build can satisfy itself. */
interface RuntimeModule {
  specifier: string;
  assetPath: string;
  /** Where the entry points when this package cannot be resolved at all. */
  fallback: string;
}

export const CLIENT_RUNTIME_MODULES: readonly RuntimeModule[] = [
  {
    assetPath: "/assets/vue-reactivity.js",
    fallback: DEFAULT_REACTIVITY_SRC,
    specifier: "@vue/reactivity",
  },
  { assetPath: "/assets/lit-html.js", fallback: DEFAULT_LIT_HTML_SRC, specifier: "lit-html" },
];

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

/** True when a bare specifier resolves from `resolveDir` under either backend. */
function canResolve(specifier: string, resolveDir: string): boolean {
  try {
    if (typeof Bun === "undefined") {
      return typeof createRequire(join(resolveDir, "x.js")).resolve(specifier) === "string";
    }
    return typeof Bun.resolveSync(specifier, resolveDir) === "string";
  } catch {
    return false;
  }
}
