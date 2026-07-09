/**
 * Schema-command — `jx schema` implementation (specs/extensions.md §5.2)
 *
 * Composes the per-project entry documents (project.schema.json and document.schema.json) from the
 * core schemas and each enabled extension's shipped fragments, then writes them into the project
 * root as committed artifacts. All fragment refs are PROJECT-RELATIVE, POSIX-style `./` paths:
 * paths that resolve inside the project are emitted as-is; bare-specifier packages resolving
 * through workspace symlinks (outside the root) fall back to the conventional
 * `./node_modules/<package>/<subpath>` form, which resolves once dependencies are installed.
 */

import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import {
  bundleSchema,
  emitDocumentSchema,
  emitProjectSchema,
} from "@jxsuite/schema/project-schemas";
import { buildProjectExtensionRegistry } from "./format-host.ts";
import { loadProjectConfig } from "./site-loader.ts";
import type { ExtensionInfo } from "@jxsuite/schema/extension-registry";
import type { SchemaJsonLoader } from "@jxsuite/schema/project-schemas";

const CORE_PROJECT_SPECIFIER = "@jxsuite/schema/schemas/project.core.schema.json";
const CORE_DOCUMENT_SPECIFIER = "@jxsuite/schema/schema.json";

/**
 * Generate and write `<root>/project.schema.json` and `<root>/document.schema.json`.
 *
 * @param {string} projectRoot - Absolute path to the project directory
 * @returns {Promise<{ projectSchemaPath: string; documentSchemaPath: string }>} Written paths
 */
export async function writeProjectSchemas(projectRoot: string) {
  const { config } = loadProjectConfig(projectRoot);
  const registry = await buildProjectExtensionRegistry(projectRoot, config);

  const corePath = coreSchemaRef(projectRoot, CORE_PROJECT_SPECIFIER);
  const fragments: string[] = [];
  const pathsValueRefs: string[] = [];
  for (const ext of registry.extensions) {
    const projectFragment = ext.schemas.project;
    if (projectFragment) {
      fragments.push(fragmentRef(projectRoot, ext, projectFragment));
    }
    const documentFragment = ext.schemas.document;
    if (documentFragment) {
      pathsValueRefs.push(...documentPathsRefs(documentFragment));
    }
  }

  const projectSchema = emitProjectSchema({ corePath, fragments });
  const documentSchema = emitDocumentSchema({
    corePath: coreSchemaRef(projectRoot, CORE_DOCUMENT_SPECIFIER),
    pathsValueRefs,
  });

  const projectSchemaPath = resolve(projectRoot, "project.schema.json");
  const documentSchemaPath = resolve(projectRoot, "document.schema.json");
  writeFileSync(projectSchemaPath, `${JSON.stringify(projectSchema, null, 2)}\n`, "utf8");
  writeFileSync(documentSchemaPath, `${JSON.stringify(documentSchema, null, 2)}\n`, "utf8");
  return { documentSchemaPath, projectSchemaPath };
}

/**
 * Read the project's entry documents as PRE-BUNDLED, self-contained schemas — the payload behind
 * the studio's `fetchProjectSchemas` PAL member (dev server route and desktop RPC). Missing or
 * stale entry documents (older than project.json) are regenerated first via
 * {@link writeProjectSchemas}; each is then bundled with a loader restricted to the project root,
 * falling back to host resolution for `./node_modules/...` refs the way `jx validate` does
 * (workspace hoisting leaves in-repo projects without their own node_modules).
 *
 * @param {string} projectRoot - Absolute path to the project directory
 * @returns {Promise<{ project: Record<string, unknown>; document: Record<string, unknown> }>}
 */
export async function readBundledProjectSchemas(projectRoot: string) {
  const root = resolve(projectRoot);
  const projectJsonPath = resolve(root, "project.json");
  const projectSchemaPath = resolve(root, "project.schema.json");
  const documentSchemaPath = resolve(root, "document.schema.json");

  const stale = (path: string): boolean => {
    if (!existsSync(path)) {
      return true;
    }
    try {
      return statSync(projectJsonPath).mtimeMs > statSync(path).mtimeMs;
    } catch {
      return false;
    }
  };
  if (stale(projectSchemaPath) || stale(documentSchemaPath)) {
    await writeProjectSchemas(root);
  }

  const loadJson = restrictedSchemaLoader(root);
  const project = await bundleSchema(
    JSON.parse(readFileSync(projectSchemaPath, "utf8")) as Record<string, unknown>,
    loadJson,
    root,
  );
  const document = await bundleSchema(
    JSON.parse(readFileSync(documentSchemaPath, "utf8")) as Record<string, unknown>,
    loadJson,
    root,
  );
  return { document, project };
}

/**
 * Bundler loader restricted to the project root, with the validate-project host fallback: a missing
 * `<root>/node_modules/<specifier>` file resolves the specifier project-first, then through the
 * host (workspace symlinks resolve transparently).
 *
 * @param {string} root - Absolute project root
 * @returns {SchemaJsonLoader}
 */
function restrictedSchemaLoader(root: string): SchemaJsonLoader {
  return async (path) => {
    const abs = resolve(path);
    const rel = relative(root, abs);
    if (rel.startsWith("..") || isAbsolute(rel)) {
      throw new Error(`Schema ref "${path}" escapes the project root ${root}`);
    }
    if (existsSync(abs)) {
      return JSON.parse(readFileSync(abs, "utf8")) as Record<string, unknown>;
    }
    const posixRel = rel.split(sep).join("/");
    const marker = "node_modules/";
    const markerIndex = posixRel.lastIndexOf(marker);
    if (markerIndex === -1) {
      throw new Error(`Schema ref "${path}" does not exist`);
    }
    const specifier = posixRel.slice(markerIndex + marker.length);
    let resolved: string;
    try {
      const projRequire = createRequire(resolve(root, "package.json"));
      resolved = projRequire.resolve(specifier);
    } catch {
      try {
        const selfRequire = createRequire(import.meta.url);
        resolved = selfRequire.resolve(specifier);
      } catch (error) {
        throw new Error(
          `Schema ref "${path}" does not exist and "${specifier}" is not resolvable from the ` +
            `project or the host`,
          { cause: error },
        );
      }
    }
    return JSON.parse(readFileSync(resolved, "utf8")) as Record<string, unknown>;
  };
}

/**
 * Project-relative ref for a core schema file: resolve the specifier project-first (then host) and
 * relativize; escape from the root (workspace symlinks) falls back to the conventional
 * `./node_modules/...` path.
 *
 * @param {string} projectRoot
 * @param {string} specifier - Bare specifier of the shipped core schema file
 * @returns {string}
 */
function coreSchemaRef(projectRoot: string, specifier: string): string {
  let resolved: string | null = null;
  try {
    const projRequire = createRequire(resolve(projectRoot, "package.json"));
    resolved = projRequire.resolve(specifier);
  } catch {
    try {
      const selfRequire = createRequire(import.meta.url);
      resolved = selfRequire.resolve(specifier);
    } catch {
      resolved = null;
    }
  }
  const conventional = `./node_modules/${specifier}`;
  return resolved ? projectRelativeRef(projectRoot, resolved, conventional) : conventional;
}

/**
 * Project-relative ref for an extension's fragment file. Local (relative-path) extensions live
 * inside the project; bare-specifier packages use the conventional node_modules path built from the
 * specifier and the fragment's manifest-relative location.
 *
 * @param {string} projectRoot
 * @param {ExtensionInfo} ext
 * @param {string} fragmentPath - Resolved absolute fragment path
 * @returns {string}
 */
function fragmentRef(projectRoot: string, ext: ExtensionInfo, fragmentPath: string): string {
  const manifestRel = relative(dirname(ext.manifestPath), fragmentPath).split(sep).join("/");
  const conventional = `./node_modules/${ext.specifier}/${manifestRel}`;
  return projectRelativeRef(projectRoot, fragmentPath, conventional);
}

/**
 * Relativize an absolute path against the project root as a POSIX `./` ref, or fall back to the
 * given conventional path when it escapes the root.
 *
 * @param {string} projectRoot
 * @param {string} absPath
 * @param {string} conventional
 * @returns {string}
 */
function projectRelativeRef(projectRoot: string, absPath: string, conventional: string): string {
  const rel = relative(projectRoot, absPath).split(sep).join("/");
  if (rel.startsWith("..")) {
    return conventional;
  }
  return rel.startsWith("./") ? rel : `./${rel}`;
}

/**
 * Canonical "uri#/pointer" refs into a document fragment's paths shapes: one per `$defs` entry,
 * addressed by the fragment's own `$id` (refs inside the entry document's embed resolve against
 * canonical URIs, never file locations).
 *
 * @param {string} fragmentPath - Resolved absolute document-fragment path
 * @returns {string[]}
 */
function documentPathsRefs(fragmentPath: string): string[] {
  let fragment: { $id?: unknown; $defs?: Record<string, unknown> };
  try {
    fragment = JSON.parse(readFileSync(fragmentPath, "utf8")) as typeof fragment;
  } catch {
    return [];
  }
  const { $id } = fragment;
  if (typeof $id !== "string" || !fragment.$defs) {
    return [];
  }
  return Object.keys(fragment.$defs).map((name) => `${$id}#/$defs/${name}`);
}
