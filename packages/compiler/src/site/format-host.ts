/**
 * Format-host — node-side FormatHostIO and project registry construction
 *
 * Provides the filesystem/module I/O the shared extension registry needs to run inside the compiler
 * (and dev server). Extensions are declared explicitly in project.json's `extensions` array and
 * discovered through their jx-extension.json manifests; see specs/extensions.md.
 */

import { readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { buildExtensionRegistry } from "@jxsuite/schema/extension-registry";
import type { ExtensionRegistry } from "@jxsuite/schema/extension-registry";
import type { FormatHostIO, FormatRegistry, ProjectBlock } from "@jxsuite/schema/format-registry";
import type { ProjectConfig } from "@jxsuite/schema/types";

export type { ExtensionRegistry } from "@jxsuite/schema/extension-registry";
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
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
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
      // Bare specifier — prefer the project's own node_modules, then fall back to the host's
      // Resolution (the desktop app and dev server ship @jxsuite/parser, so format classes work
      // Even when the project's dependencies are not installed).
      const projRequire = createRequire(resolve(projectRoot, "package.json"));
      try {
        return projRequire.resolve(ref);
      } catch {
        const selfRequire = createRequire(import.meta.url);
        return selfRequire.resolve(ref);
      }
    },
  };
}

/** Build the extension registry for a project from its project.json `extensions` array. */
export async function buildProjectExtensionRegistry(
  projectRoot: string,
  projectConfig?: ProjectConfig,
): Promise<ExtensionRegistry> {
  return buildExtensionRegistry(
    projectConfig?.extensions,
    createNodeFormatIO(projectRoot),
    resolve(projectRoot, "project.json"),
  );
}

/**
 * Format-dispatch view of the project's extension registry.
 *
 * @deprecated Part-3 cleanup: the desktop app still imports this; use
 *   `buildProjectExtensionRegistry(...).then((r) => r.formats)` instead.
 */
export async function buildProjectFormatRegistry(
  projectRoot: string,
  projectConfig?: ProjectConfig,
): Promise<FormatRegistry> {
  const registry = await buildProjectExtensionRegistry(projectRoot, projectConfig);
  return registry.formats;
}

// ─── Studio extensions payload ────────────────────────────────────────────────

/** One project-section contribution on the studio wire (specs/extensions.md §9/§9.1). */
export interface ExtensionsPayloadContribution {
  /** The $prototype-visible class name declaring the `project` block. */
  className: string;
  /** The class descriptor's `project` admission block. */
  project: ProjectBlock;
  /** The class descriptor's `$studio` block (settings section vocabulary), when declared. */
  studio: Record<string, unknown> | null;
  /**
   * The section's value schema — `properties[<key>]` of the extension's project fragment — or null
   * when the extension ships no project fragment (or it lacks the key).
   */
  entrySchema: Record<string, unknown> | null;
}

/** One extension package on the studio wire (the formats route's `extensions` sibling array). */
export interface ExtensionsPayloadEntry {
  specifier: string;
  name: string;
  title?: string;
  description?: string;
  contributions: ExtensionsPayloadContribution[];
}

/**
 * Build the studio-facing extensions payload from a project's extension registry: per extension,
 * its manifest identity plus every project-section contribution paired with the entry schema read
 * from the extension's shipped project fragment. Unreadable fragments degrade to a null entrySchema
 * (the studio renders the section without field metadata).
 *
 * @param {ExtensionRegistry} registry
 * @returns {ExtensionsPayloadEntry[]}
 */
export function buildExtensionsPayload(registry: ExtensionRegistry): ExtensionsPayloadEntry[] {
  const payload: ExtensionsPayloadEntry[] = [];
  for (const ext of registry.extensions) {
    let fragmentProperties: Record<string, Record<string, unknown>> = {};
    if (ext.schemas.project) {
      try {
        const fragment = JSON.parse(readFileSync(ext.schemas.project, "utf8")) as {
          properties?: Record<string, Record<string, unknown>>;
        };
        fragmentProperties = fragment.properties ?? {};
      } catch {
        fragmentProperties = {};
      }
    }
    const contributions: ExtensionsPayloadContribution[] = [];
    for (const cls of ext.classes) {
      if (!cls.project) {
        continue;
      }
      contributions.push({
        className: cls.name,
        entrySchema: fragmentProperties[cls.project.key] ?? null,
        project: cls.project,
        studio: cls.studio,
      });
    }
    payload.push({
      contributions,
      name: ext.manifest.name,
      specifier: ext.specifier,
      ...(ext.manifest.title === undefined ? {} : { title: ext.manifest.title }),
      ...(ext.manifest.description === undefined ? {} : { description: ext.manifest.description }),
    });
  }
  return payload;
}

/** Error message for an unregistered non-JSON extension, naming the fix. */
export function unknownFormatError(path: string, ext: string): Error {
  return new Error(
    `No format class registered for "${ext}" (${path}). ` +
      `Enable an extension providing this format in project.json "extensions", ` +
      `e.g. "@jxsuite/parser".`,
  );
}
