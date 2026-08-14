/**
 * Schema-command — `jx schema` implementation (specs/extensions.md §5.2)
 *
 * Composes the per-project entry documents (project.schema.json and document.schema.json) from the
 * core schemas and each enabled extension's shipped fragments, then writes them into the project
 * root as committed, SELF-CONTAINED, SINGLE-RESOURCE schemas: every fragment ref is resolved
 * through {@link bundleSchema} (embedding the core + fragment resources under `$defs`) and then
 * collapsed by {@link flattenSchema}, which drops the embedded `$id`s and rewrites every ref to a
 * root-relative JSON Pointer. Both passes are needed for one resolution behavior across all
 * consumers: relative `./node_modules/...` refs only resolve through Node module resolution, which
 * editors do not perform (hoisted workspaces leave projects without their own node_modules), while
 * `$id`-scoped refs inside a compound document resolve only in a fully compliant validator — VS
 * Code's JSON language service and Monaco resolve `#/...` against the document root and fetch
 * anything with a URI before the `#` over the network. Root pointers are what ajv, the language
 * service, and Monaco all agree on.
 */

import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import {
  bundleSchema,
  composeProjectSchemas,
  flattenSchema,
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
export async function composeEntryDocuments(projectRoot: string) {
  const { config } = loadProjectConfig(projectRoot);
  const registry = await buildProjectExtensionRegistry(projectRoot, config);

  /* Composition itself is host-agnostic (@jxsuite/schema `composeProjectSchemas`) — the filesystem
     appears only in what this host contributes: project-relative refs for the fragments the
     registry resolved, and a loader restricted to the project root. The cloud session composes the
     same two documents from bundled artifacts through the same function. */
  const root = resolve(projectRoot);
  const { document: documentSchema, project: projectSchema } = await composeProjectSchemas({
    baseDir: root,
    coreDocumentRef: coreSchemaRef(projectRoot, CORE_DOCUMENT_SPECIFIER),
    coreProjectRef: coreSchemaRef(projectRoot, CORE_PROJECT_SPECIFIER),
    extensions: registry.extensions.map((ext) => ({
      document: ext.schemas.document && fragmentRef(projectRoot, ext, ext.schemas.document),
      fields: ext.schemas.fields && fragmentRef(projectRoot, ext, ext.schemas.fields),
      project: ext.schemas.project && fragmentRef(projectRoot, ext, ext.schemas.project),
    })),
    loadJson: restrictedSchemaLoader(root),
  });

  return { documentSchema, projectSchema };
}

/**
 * Compose the entry documents and WRITE them to the project root.
 *
 * @param {string} projectRoot - Absolute path to the project directory
 * @returns {Promise<{ projectSchemaPath: string; documentSchemaPath: string }>} Written paths
 */
export async function writeProjectSchemas(projectRoot: string) {
  const { documentSchema, projectSchema } = await composeEntryDocuments(projectRoot);
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
export async function readBundledProjectSchemas(
  projectRoot: string,
  options: { write?: boolean } = {},
) {
  const { write = true } = options;
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
  const isStale = stale(projectSchemaPath) || stale(documentSchemaPath);
  // `write: false` is what a VALIDATOR passes. A stale entry document is regenerated in memory and
  // The committed file is left exactly as it is: `jx validate` reports on the repository, and a
  // Checker that edits what it is checking is not a checker. This mattered — running
  // `schema:validate-all` on a machine with a shadowed core silently rewrote the committed
  // Artifact with a narrower one, and it was green either way, because it validated against
  // Whatever it had just written.
  const composed = isStale ? await composeEntryDocuments(root) : null;
  if (composed && write) {
    writeFileSync(
      projectSchemaPath,
      `${JSON.stringify(composed.projectSchema, null, 2)}\n`,
      "utf8",
    );
    writeFileSync(
      documentSchemaPath,
      `${JSON.stringify(composed.documentSchema, null, 2)}\n`,
      "utf8",
    );
  }

  const loadJson = restrictedSchemaLoader(root);
  const projectFile =
    composed?.projectSchema ??
    (JSON.parse(readFileSync(projectSchemaPath, "utf8")) as Record<string, unknown>);
  const documentFile =
    composed?.documentSchema ??
    (JSON.parse(readFileSync(documentSchemaPath, "utf8")) as Record<string, unknown>);
  const project = flattenSchema(await bundleSchema(projectFile, loadJson, root));
  const document = flattenSchema(await bundleSchema(documentFile, loadJson, root));
  return { document, project };
}

/** Packages whose schemas define the Jx document contract itself, never a project's own content. */
const FIRST_PARTY_SCHEMA_SCOPE = "@jxsuite/";

/**
 * Is this specifier one of the shipped core schemas, as opposed to a project-local fragment?
 *
 * @param {string} specifier - Bare specifier, e.g. `@jxsuite/schema/schema.json`
 * @returns {boolean}
 */
export function isFirstPartySchema(specifier: string): boolean {
  return specifier.startsWith(FIRST_PARTY_SCHEMA_SCOPE) && specifier.endsWith(".json");
}

/**
 * Resolve a first-party schema from the HOST — the workspace running the generator.
 *
 * Throws rather than falling back to the project, because a fallback is exactly the behaviour that
 * let a stale published core answer for the workspace one. A generator that cannot find its own
 * schema must stop, not improvise.
 *
 * @param {string} specifier
 * @param {string} path - The original ref, for the error message
 * @returns {string} Absolute path to the resolved schema file
 */
function hostResolve(specifier: string, path: string): string {
  try {
    return createRequire(import.meta.url).resolve(specifier);
  } catch (error) {
    throw new Error(
      `Schema ref "${path}" names the first-party schema "${specifier}", which must resolve from ` +
        `the host workspace and does not. The project's own copy is deliberately not consulted, so ` +
        `the host install is missing "${specifier.split("/").slice(0, 2).join("/")}" — check that ` +
        `the package ships with this build`,
      { cause: error },
    );
  }
}

/**
 * Bundler loader restricted to the project root, with the validate-project host fallback: a missing
 * `<root>/node_modules/<specifier>` file resolves the specifier project-first, then through the
 * host (workspace symlinks resolve transparently).
 *
 * Exported for test: both refusals below are reachable only through a project whose `node_modules`
 * has been arranged to provoke them, and a fixture that arranges an extension registry as well says
 * less about the rule than a call that states the path directly.
 *
 * @param {string} root - Absolute project root
 * @returns {SchemaJsonLoader}
 */
export function restrictedSchemaLoader(root: string): SchemaJsonLoader {
  return async (path) => {
    const abs = resolve(path);
    const rel = relative(root, abs);
    if (rel.startsWith("..") || isAbsolute(rel)) {
      throw new Error(`Schema ref "${path}" escapes the project root ${root}`);
    }
    const posixRel = rel.split(sep).join("/");
    const marker = "node_modules/";
    const markerIndex = posixRel.lastIndexOf(marker);
    const specifier = markerIndex === -1 ? null : posixRel.slice(markerIndex + marker.length);
    // A FIRST-PARTY core comes from the host, always — before the project-local file is even
    // Looked at. A project may legitimately carry its own fragments, which is what the rest of this
    // Loader is for; what it may not do is answer for `@jxsuite/schema` itself.
    //
    // This is not hypothetical. A stray `bun install` in packages/starters/sites/shop left a
    // Gitignored node_modules holding @jxsuite/schema@0.35.0 beside a 1.5.0 workspace, and BOTH the
    // `existsSync` shortcut below and the project-first `createRequire` resolved to it. The
    // Generator then emitted a shop document schema missing Statement, StatementList, PathsValue
    // And the three admission blocks, with ClassMethodDef.role down from 16 members to 6 and
    // ChildrenValue.oneOf down from 3 to 2 — dropping the computed-children branch, which made
    // Shop's own pages/products/[sku].json invalid against its own committed schema. Nothing
    // Noticed for six weeks, because the artifact was only ever regenerated on the machine that
    // Had the shadow.
    if (specifier !== null && isFirstPartySchema(specifier)) {
      return JSON.parse(readFileSync(hostResolve(specifier, path), "utf8")) as Record<
        string,
        unknown
      >;
    }
    if (existsSync(abs)) {
      return JSON.parse(readFileSync(abs, "utf8")) as Record<string, unknown>;
    }
    if (specifier === null) {
      throw new Error(`Schema ref "${path}" does not exist`);
    }
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
