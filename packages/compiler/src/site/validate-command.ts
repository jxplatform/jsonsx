/**
 * Validate-command — `jx validate` whole-project implementation.
 *
 * Extends the original project.json check into the full compliance walk:
 *
 * 1. `project.json` against the generated entry schema (validateProjectFile);
 * 2. The committed entry documents are SELF-CONTAINED (no residual relative `$ref`s — the
 *    editor-resolution guarantee of the bundled form, specs/extensions.md §5.4);
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

  // 1. project.json against the generated entry schema.
  const projectResult = await validateProjectFile(root);
  checked += 1;
  if (!projectResult.valid) {
    issues.push({ errors: projectResult.errors ?? [], file: "project.json" });
  }

  // 2. Committed entry documents must be self-contained (the editor-resolution guarantee).
  for (const name of ["project.schema.json", "document.schema.json"]) {
    const path = resolve(root, name);
    if (!existsSync(path)) {
      continue;
    }
    checked += 1;
    const residual: string[] = [];
    collectRelativeRefs(JSON.parse(readFileSync(path, "utf8")), residual);
    if (residual.length > 0) {
      issues.push({
        errors: residual.map((ref) => ({
          message:
            `relative $ref "${ref}" — committed entry documents must be self-contained; ` +
            `regenerate with \`jx schema\``,
        })),
        file: name,
      });
    }
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

/** Collect relative-path `$ref`s (anything without a URI scheme that isn't a `#` pointer). */
function collectRelativeRefs(node: unknown, out: string[]): void {
  if (Array.isArray(node)) {
    for (const item of node) {
      collectRelativeRefs(item, out);
    }
    return;
  }
  if (node === null || typeof node !== "object") {
    return;
  }
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (
      key === "$ref" &&
      typeof value === "string" &&
      !value.startsWith("#") &&
      !/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(value)
    ) {
      out.push(value);
    }
    collectRelativeRefs(value, out);
  }
}

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
