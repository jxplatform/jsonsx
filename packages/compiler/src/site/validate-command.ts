/**
 * Validate-command — `jx validate` whole-project implementation.
 *
 * Extends the original project.json check into the full compliance walk:
 *
 * 1. The committed entry documents are SELF-CONTAINED and SINGLE-RESOURCE: every `$ref` is a
 *    root-relative JSON Pointer that resolves inside the file — the editor-resolution guarantee of
 *    the committed form (specs/extensions.md §5.4). Checked first and fatal, since walks 2–4
 *    compile those documents;
 * 2. `project.json` against the generated entry schema (validateProjectFile);
 * 3. Every document under `components/`, `pages/`, and `layouts/` against the bundled document schema
 *    (core + extension `$paths` union — the same schema the studio consumes);
 * 4. Every project-local `*.class.json` against the generated class schema;
 * 5. Every enabled extension's schema fragments compile standalone against the shipped default union
 *    resources.
 *
 * Validation failures are data (issues in the result); infrastructure failures throw.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { join, relative, resolve } from "node:path";
import { generateClassSchema } from "@jxsuite/schema";
import { validateProjectFile } from "@jxsuite/schema/validate-project";
import { buildProjectExtensionRegistry } from "./format-host.ts";
import { loadProjectConfig } from "./site-loader.ts";
import { readBundledProjectSchemas } from "./schema-command.ts";

/** Directories that hold Jx documents validated against the document schema. */
const DOCUMENT_DIRS = ["components", "pages", "layouts"] as const;

/** Directory names never walked for class files. */
const SKIP_DIRS = new Set(["node_modules", "dist", ".git"]);

/** Shipped default union resources fragments may reference by canonical URI. */
const SHIPPED_RESOURCE_SPECIFIERS = [
  "@jxsuite/schema/schemas/project.core.schema.json",
  "@jxsuite/schema/schemas/project.fields.schema.json",
  "@jxsuite/schema/schemas/document.paths.schema.json",
];

export interface ProjectTreeIssue {
  /** Project-relative file path (or absolute for extension fragments outside the root). */
  file: string;
  /** Ajv error objects, or `{ message }` records for structural issues. */
  errors: unknown[];
}

export interface ProjectTreeValidationResult {
  valid: boolean;
  /** Number of files checked across all five walks. */
  checked: number;
  issues: ProjectTreeIssue[];
}

// Minimal structural types for the optional `ajv` dependency (same pattern as validate-project).
interface AjvValidateFn {
  (doc: unknown): boolean;
  errors?: unknown[] | null;
}
interface AjvInstance {
  compile: (schema: unknown) => AjvValidateFn;
  addSchema: (schema: unknown) => AjvInstance;
}
type AjvCtor = new (opts: {
  allErrors: boolean;
  ownProperties: boolean;
  strict: boolean;
}) => AjvInstance;
type AddFormatsFn = (ajv: AjvInstance) => void;

async function loadAjv(): Promise<{ Ajv: AjvCtor; addFormats: AddFormatsFn }> {
  try {
    // The schemas are JSON Schema 2020-12, so use the matching Ajv build.
    const { default: Ajv } = (await import("ajv/dist/2020")) as unknown as { default: AjvCtor };
    // @ts-expect-error — resolved through @jxsuite/schema's dependency
    const { default: addFormats } = (await import("ajv-formats")) as { default: AddFormatsFn };
    return { addFormats, Ajv };
  } catch (error) {
    throw new Error("Project validation requires ajv and ajv-formats: bun add ajv ajv-formats", {
      cause: error,
    });
  }
}

/**
 * Validate a whole project tree. See the module docstring for the five walks.
 *
 * @param {string} projectRoot - Absolute path to the project directory
 * @returns {Promise<ProjectTreeValidationResult>}
 */
export async function validateProjectTree(
  projectRoot: string,
): Promise<ProjectTreeValidationResult> {
  const root = resolve(projectRoot);
  const issues: ProjectTreeIssue[] = [];
  let checked = 0;

  /* 1. Committed entry documents must be self-contained (the editor-resolution guarantee). This
     runs FIRST because every later walk compiles one of them: an unresolvable ref surfaces from ajv
     as a thrown MissingRefError, so diagnosing it here turns a stack trace into "regenerate with
     `jx schema`". Nothing downstream is meaningful until it holds, hence the early return. */
  for (const name of ["project.schema.json", "document.schema.json"]) {
    const path = resolve(root, name);
    if (!existsSync(path)) {
      continue;
    }
    checked += 1;
    const entry = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    const unresolvable = collectUnresolvableRefs(entry);
    if (unresolvable.length > 0) {
      issues.push({
        errors: unresolvable.map(({ reason, ref }) => ({
          message:
            `$ref "${ref}" ${reason} — committed entry documents must be self-contained ` +
            `single-resource schemas; regenerate with \`jx schema\``,
        })),
        file: name,
      });
    }
  }
  if (issues.length > 0) {
    return { checked, issues, valid: false };
  }

  // 2. project.json against the generated entry schema.
  const projectResult = await validateProjectFile(root);
  checked += 1;
  if (!projectResult.valid) {
    issues.push({ errors: projectResult.errors ?? [], file: "project.json" });
  }

  const { addFormats, Ajv } = await loadAjv();

  // 3. Documents against the bundled document schema (the same schema the studio consumes).
  const { document: documentSchema } = await readBundledProjectSchemas(root);
  const docAjv = new Ajv({ allErrors: true, ownProperties: true, strict: false });
  addFormats(docAjv);
  const validateDoc = docAjv.compile(documentSchema);
  for (const dir of DOCUMENT_DIRS) {
    for (const file of walkJsonFiles(resolve(root, dir))) {
      if (file.endsWith(".class.json")) {
        continue; // Validated against the class schema below.
      }
      checked += 1;
      const doc = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
      if (!validateDoc(doc)) {
        issues.push({ errors: validateDoc.errors ?? [], file: relative(root, file) });
      }
    }
  }

  // 4. Project-local class definitions against the generated class schema.
  const classAjv = new Ajv({ allErrors: true, ownProperties: true, strict: false });
  addFormats(classAjv);
  const validateClass = classAjv.compile(generateClassSchema());
  for (const file of walkClassFiles(root)) {
    checked += 1;
    const doc = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    if (!validateClass(doc)) {
      issues.push({ errors: validateClass.errors ?? [], file: relative(root, file) });
    }
  }

  // 5. Enabled extensions' schema fragments compile standalone against the shipped defaults.
  const { config } = loadProjectConfig(root);
  const registry = await buildProjectExtensionRegistry(root, config);
  const selfRequire = createRequire(import.meta.url);
  for (const ext of registry.extensions) {
    for (const kind of ["project", "document", "fields"] as const) {
      const fragmentPath = ext.schemas[kind];
      if (!fragmentPath) {
        continue;
      }
      checked += 1;
      const fragAjv = new Ajv({ allErrors: true, ownProperties: true, strict: false });
      addFormats(fragAjv);
      for (const specifier of SHIPPED_RESOURCE_SPECIFIERS) {
        const resourcePath = selfRequire.resolve(specifier);
        const resource = JSON.parse(readFileSync(resourcePath, "utf8")) as Record<string, unknown>;
        fragAjv.addSchema(resource);
      }
      try {
        fragAjv.compile(JSON.parse(readFileSync(fragmentPath, "utf8")));
      } catch (error) {
        issues.push({
          errors: [{ message: error instanceof Error ? error.message : String(error) }],
          file: `${ext.specifier} (${kind} fragment)`,
        });
      }
    }
  }

  return { checked, issues, valid: issues.length === 0 };
}

/**
 * Every `$ref` a committed entry document may carry must be a root-relative JSON Pointer that
 * resolves inside the same file. Three ways that fails, all of which break editor resolution: a
 * relative path (needs Node module resolution), a URI (VS Code fetches it over the network instead
 * of matching an embedded `$id`), and a pointer with no node at the other end.
 *
 * Walks only subschema keyword positions, since `examples`/`default`/`const`/`enum` hold instance
 * data and Jx document examples legitimately contain `$ref` strings of their own.
 *
 * @param {Record<string, unknown>} entry - Parsed committed entry document
 * @returns {{ ref: string; reason: string }[]} One entry per offending `$ref`
 */
function collectUnresolvableRefs(
  entry: Record<string, unknown>,
): { ref: string; reason: string }[] {
  const out: { ref: string; reason: string }[] = [];
  const seen = new Set<Record<string, unknown>>();

  const resolvePointer = (pointer: string): boolean => {
    let current: unknown = entry;
    for (const raw of pointer.slice(1).split("/")) {
      if (raw === "") {
        continue;
      }
      const segment = raw.replaceAll("~1", "/").replaceAll("~0", "~");
      if (typeof current !== "object" || current === null) {
        return false;
      }
      current = (current as Record<string, unknown>)[segment];
      if (current === undefined) {
        return false;
      }
    }
    return true;
  };

  const walk = (node: unknown): void => {
    if (!isRecord(node) || seen.has(node)) {
      return;
    }
    seen.add(node);
    const ref = node.$ref;
    if (typeof ref === "string") {
      if (/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(ref)) {
        out.push({ reason: "is an absolute URI editors resolve over the network", ref });
      } else if (!ref.startsWith("#")) {
        out.push({ reason: "is a relative path only Node module resolution can follow", ref });
      } else if (ref.length > 1 && !ref.startsWith("#/")) {
        out.push({ reason: "is an $anchor reference, which has no root-pointer form", ref });
      } else if (ref.length > 1 && !resolvePointer(ref.slice(1))) {
        out.push({ reason: "points at no node in this document", ref });
      }
    }
    for (const [keyword, value] of Object.entries(node)) {
      if (!SUBSCHEMA_KEYWORDS.has(keyword)) {
        continue;
      }
      if (Array.isArray(value)) {
        for (const item of value) {
          walk(item);
        }
      } else if (isRecord(value)) {
        // Map-valued keywords hold subschemas one level down; single-valued ones are the schema.
        walk(value);
        if (MAP_SUBSCHEMA_KEYWORDS.has(keyword)) {
          for (const item of Object.values(value)) {
            walk(item);
          }
        }
      }
    }
  };
  walk(entry);
  return out;
}

/** True for a plain object (a candidate subschema node). */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Keywords whose values map names to subschemas. */
const MAP_SUBSCHEMA_KEYWORDS = new Set([
  "$defs",
  "definitions",
  "dependencies",
  "dependentSchemas",
  "patternProperties",
  "properties",
]);

/** Every keyword position a subschema can occupy (see {@link MAP_SUBSCHEMA_KEYWORDS} for maps). */
const SUBSCHEMA_KEYWORDS = new Set([
  ...MAP_SUBSCHEMA_KEYWORDS,
  "additionalItems",
  "additionalProperties",
  "allOf",
  "anyOf",
  "contains",
  "contentSchema",
  "else",
  "if",
  "items",
  "not",
  "oneOf",
  "prefixItems",
  "propertyNames",
  "then",
  "unevaluatedItems",
  "unevaluatedProperties",
]);

/** Recursively list `.json` files under a directory (absent directories yield nothing). */
function walkJsonFiles(dir: string): string[] {
  if (!existsSync(dir)) {
    return [];
  }
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      out.push(...walkJsonFiles(path));
    } else if (name.endsWith(".json")) {
      out.push(path);
    }
  }
  return out.toSorted();
}

/** Recursively list `*.class.json` files under the root, skipping vendored/output dirs. */
function walkClassFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (SKIP_DIRS.has(name)) {
        continue;
      }
      const path = join(dir, name);
      if (statSync(path).isDirectory()) {
        walk(path);
      } else if (name.endsWith(".class.json")) {
        out.push(path);
      }
    }
  };
  walk(root);
  return out.toSorted();
}

/** Format a result's issues as printable lines (one per error) for the CLI. */
export function formatProjectTreeIssues(result: ProjectTreeValidationResult): string[] {
  const lines: string[] = [];
  for (const issue of result.issues) {
    lines.push(`${issue.file}:`);
    for (const error of issue.errors) {
      const { instancePath, message } = (error ?? {}) as {
        instancePath?: string;
        message?: string;
      };
      lines.push(`  - ${instancePath || "/"}: ${message ?? JSON.stringify(error)}`);
    }
  }
  return lines;
}
