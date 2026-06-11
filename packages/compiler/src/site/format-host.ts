/**
 * Format-host — node-side FormatHostIO and project registry construction
 *
 * Provides the filesystem/module I/O the shared format registry needs to run inside the compiler
 * (and dev server). Format classes are auto-discovered from the project-level imports map; see
 * specs/extensions.md.
 */

import { readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { buildFormatRegistry } from "@jxsuite/schema/format-registry";
import type { FormatHostIO, FormatRegistry } from "@jxsuite/schema/format-registry";
import type { ProjectConfig } from "@jxsuite/schema/types";

export type { FormatRegistry, FormatEntry } from "@jxsuite/schema/format-registry";

/**
 * Import a class $implementation module by absolute path, tolerating source-vs-built layouts. A
 * `.class.json` typically declares `"$implementation": "./markdown.js"` next to its TypeScript
 * source: under Bun the sibling `.ts` resolves directly, while under node the built module lives in
 * the package's `dist/` directory. Tries, in order: the literal path, src/ → dist/, .js → .ts.
 *
 * @param {string} path - Absolute path to the implementation module
 * @returns {Promise<Record<string, unknown>>}
 */
export async function importImplementation(path: string): Promise<Record<string, unknown>> {
  const candidates = [path];
  const srcSeg = `${sep}src${sep}`;
  const distSeg = `${sep}dist${sep}`;
  if (path.includes(srcSeg)) {
    candidates.push(path.replace(srcSeg, distSeg));
  }
  if (path.endsWith(".js")) {
    candidates.push(`${path.slice(0, -3)}.ts`);
  }

  let lastError: unknown;
  for (const candidate of candidates) {
    try {
      return await import(pathToFileURL(candidate).href);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

/** Create a node FormatHostIO rooted at a project (bare specifiers resolve via node_modules). */
export function createNodeFormatIO(projectRoot: string): FormatHostIO {
  return {
    importModule: (path) => importImplementation(path),
    loadJson: async (path) => JSON.parse(readFileSync(path, "utf8")),
    resolvePath: (base, ref) => {
      if (ref.startsWith("./") || ref.startsWith("../")) {
        return resolve(dirname(base), ref);
      }
      if (isAbsolute(ref)) {
        return ref;
      }
      const require = createRequire(resolve(projectRoot, "package.json"));
      return require.resolve(ref);
    },
  };
}

/** Build the format registry for a project from its project.json imports map. */
export async function buildProjectFormatRegistry(
  projectRoot: string,
  projectConfig?: ProjectConfig,
): Promise<FormatRegistry> {
  return buildFormatRegistry(
    projectConfig?.imports as Record<string, string> | undefined,
    createNodeFormatIO(projectRoot),
    resolve(projectRoot, "project.json"),
  );
}

/** Error message for an unregistered non-JSON extension, naming the fix. */
export function unknownFormatError(path: string, ext: string): Error {
  return new Error(
    `No format class imported for "${ext}" (${path}). ` +
      `Add a format class to project.json imports, e.g. ` +
      `"Markdown": "@jxsuite/parser/Markdown.class.json".`,
  );
}
