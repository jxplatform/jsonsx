/**
 * Content-loader — format-agnostic loader for the `content` project section
 *
 * Implements the parser extension's `project` capabilities (specs/extensions.md §9): `Content` owns
 * the project.json `content` section. JSON sources are handled natively (Jx IS JSON); every other
 * format dispatches through the format registry view of the extension registry — the format class's
 * `discover` capability lists entry files and its `load` capability parses each into
 * ContentLoaderEntry[].
 *
 * There are no implicit format defaults: a content type either names a format class provided by an
 * enabled extension via its `format` key, or its source extension must match a registered format.
 * Remote http(s) sources require an explicit `format` whose class declares `format.remote: true`.
 *
 * Runs with `timing: ["compiler", "server"]` only (node `fs` on the code path, like
 * Markdown.discover).
 *
 * @module @jxsuite/parser/content-loader
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, extname, resolve } from "node:path";
import type { ExtensionRegistry } from "@jxsuite/schema/extension-registry";
import type { FormatEntry, FormatHostIO, FormatRegistry } from "@jxsuite/schema/format-registry";
import type { ContentTypeSchema, JxMutableNode, ProjectConfig } from "@jxsuite/schema/types";
import type { ContentLoaderEntry, ContentTypeDef } from "./types.ts";

export type { ContentEntry, ContentLoaderEntry, TocEntry } from "./types.ts";

// ─── Context and section shapes ──────────────────────────────────────────────

/** The value of the project.json `content` section: content type name → definition. */
export type ContentSection = Record<string, ContentTypeDef>;

/** Host context passed to `Content.projectData` (specs/extensions.md §8). */
export interface ProjectDataContext {
  projectConfig?: ProjectConfig;
  /** Absolute project root directory. */
  root: string;
  /** The project's extension registry; format dispatch goes through its `formats` view. */
  registry: ExtensionRegistry;
  /** Injected host I/O (unused here — this loader is node-only by its declared timing). */
  io?: FormatHostIO;
}

/** Host context passed to `Content.resolvePaths` (specs/extensions.md §8). */
export interface ResolvePathsContext {
  /** The loaded section data, as returned by `Content.projectData`. */
  data: Map<string, ContentLoaderEntry[]>;
  projectConfig?: ProjectConfig;
  /** Absolute project root directory. */
  root: string;
}

/** The `$paths` value shape routed to this extension by its `contentType` discriminator. */
export interface ContentPathsSource {
  contentType: string;
  param?: string;
  field?: string;
}

// ─── JSON loader (the single native built-in format) ─────────────────────────

/**
 * Load a JSON file into ContentEntry(s). If the file is an array, each element is an entry. If it's
 * an object with an `id` field, it's a single entry.
 *
 * @param {string} filePath - Absolute path to .json file
 * @returns {ContentLoaderEntry[]} Array of ContentEntry shapes
 */
function loadJSONEntries(filePath: string): ContentLoaderEntry[] {
  const raw = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
  if (Array.isArray(raw)) {
    return (raw as Record<string, unknown>[]).map((item: Record<string, unknown>, i: number) => ({
      body: null,
      data: item,
      id: (item.id as string) ?? `${basename(filePath, ".json")}-${i}`,
    }));
  }
  // Single object file — filename is the id
  const rawObj = raw as Record<string, unknown>;
  return [
    {
      body: null,
      data: rawObj,
      id: (rawObj.id as string) ?? basename(filePath, ".json"),
    },
  ];
}

/** Discover .json entry files for a source (single file or directory). */
function discoverJSONFiles(resolvedSource: string): string[] {
  if (extname(resolvedSource)) {
    return existsSync(resolvedSource) ? [resolvedSource] : [];
  }
  try {
    return readdirSync(resolvedSource, { recursive: true })
      .filter((f) => String(f).endsWith(".json"))
      .map((f) => resolve(resolvedSource, String(f)));
  } catch {
    return [];
  }
}

// ─── Content Config ───────────────────────────────────────────────────────────

/**
 * Read the `content` section out of an already-loaded project config.
 *
 * @param {string} projectRoot - Project root directory
 * @param {ProjectConfig} [projectConfig] - Already-loaded project config with a `content` key
 * @returns {{ config: { content: ContentSection }; contentDir: string }} Parsed section and the
 *   conventional content directory
 */
export function loadContentConfig(projectRoot: string, projectConfig?: ProjectConfig) {
  const contentDir = resolve(projectRoot, "content");

  const config = { content: (projectConfig?.content as ContentSection | undefined) ?? {} };

  return { config, contentDir };
}

// ─── Content Type Loading ────────────────────────────────────────────────────

/**
 * Load every content type in a `content` section value.
 *
 * @param {ContentSection} section - The project.json `content` section value
 * @param {string} root - Project root directory
 * @param {FormatRegistry} formats - Format-dispatch view of the extension registry
 * @returns {Promise<Map<string, ContentLoaderEntry[]>>} Map of content type name → entries
 */
export async function loadContentSection(
  section: ContentSection,
  root: string,
  formats: FormatRegistry,
): Promise<Map<string, ContentLoaderEntry[]>> {
  const contentTypes = new Map<string, ContentLoaderEntry[]>();
  for (const [name, contentTypeDef] of Object.entries(section)) {
    const entries = await loadContentType(name, contentTypeDef, root, formats);
    contentTypes.set(name, entries);
  }
  return contentTypes;
}

/**
 * Get the $elements array for a specific content type, if defined in the project's `content`
 * section.
 *
 * @param {string} projectRoot - Project root directory
 * @param {string} contentTypeName - Name of the content type
 * @param {ProjectConfig} [projectConfig] - Already-loaded project config
 * @returns {(string | { $ref: string })[] | undefined}
 */
export function getContentTypeElements(
  projectRoot: string,
  contentTypeName: string,
  projectConfig?: ProjectConfig,
) {
  const { config } = loadContentConfig(projectRoot, projectConfig);
  const def = config.content[contentTypeName];
  return def?.$elements;
}

/**
 * Load a single content type by its definition, dispatching through the format registry.
 *
 * @param {string} name - Content type name
 * @param {ContentTypeDef} contentTypeDef - Content type definition from the `content` section
 * @param {string} projectRoot - Absolute path to project root directory
 * @param {FormatRegistry} registry - Format-dispatch view of the extension registry
 * @returns {Promise<ContentLoaderEntry[]>} Array of ContentEntry
 */
async function loadContentType(
  name: string,
  contentTypeDef: ContentTypeDef,
  projectRoot: string,
  registry: FormatRegistry,
) {
  const { source } = contentTypeDef;
  if (!source) {
    return [];
  }
  const schema = contentTypeDef.schema as ContentTypeSchema | undefined;

  // Derive directive allowedNames from content type $elements (tag names from npm packages)
  const directiveOptions = contentTypeDef.$elements?.length
    ? {
        allowedNames: contentTypeDef.$elements
          .filter(
            (e) => typeof e === "string" || (typeof e === "object" && (e as JxMutableNode)?.$ref),
          )
          .map((e) => (typeof e === "string" ? e : (e as JxMutableNode).$ref)),
      }
    : undefined;

  // Resolve the format class: explicit `format` (an extension class name) wins; "json" is native
  const formatName = contentTypeDef.format;
  let entry: FormatEntry | undefined;
  if (formatName && formatName !== "json") {
    entry = registry.byName(formatName);
    if (!entry) {
      throw new Error(
        `Content type "${name}": format "${formatName}" is not a registered format class. ` +
          `Enable an extension providing it in project.json "extensions", e.g. "@jxsuite/parser".`,
      );
    }
  }

  // Remote URL source — requires an explicit remote-capable format (no implicit fallback)
  if (source.startsWith("http://") || source.startsWith("https://")) {
    if (!entry) {
      throw new Error(
        `Content type "${name}": remote sources require an explicit "format" naming a ` +
          `format class with "remote": true (e.g. "Csv").`,
      );
    }
    if (!entry.remote) {
      throw new Error(
        `Content type "${name}": format "${entry.name}" does not support remote sources ` +
          `(its format block lacks "remote": true).`,
      );
    }
    try {
      const entries = (await entry.call("load", source, {
        directiveOptions,
        schema,
      })) as ContentLoaderEntry[];
      if (schema) {
        validateEntries(entries, schema, name);
      }
      return entries;
    } catch (error) {
      console.warn(`Content type "${name}": ${errorMessage(error)}`);
      return [];
    }
  }

  const resolvedSource = resolve(projectRoot, source).split("\\").join("/");
  const ext = extname(source).toLowerCase();

  // JSON — the native built-in
  if (formatName === "json" || (!entry && ext === ".json")) {
    const files = discoverJSONFiles(resolvedSource);
    const entries: ContentLoaderEntry[] = [];
    for (const filePath of files) {
      entries.push(...loadJSONEntries(filePath));
    }
    if (schema) {
      validateEntries(entries, schema, name);
    }
    return entries;
  }

  // Derive the format from the source extension when no explicit format is named
  if (!entry && ext) {
    entry = registry.byExtension(ext, "load");
  }
  if (!entry) {
    throw unknownFormatError(
      source,
      ext || `content type "${name}" (directory sources need an explicit "format")`,
    );
  }

  // Discover entry files via the class, then load each
  const files = entry.capabilities.discover
    ? ((await entry.call("discover", source, {
        baseDir: projectRoot,
      })) as string[])
    : [resolvedSource];

  // Directory sources pass their resolved root so formats can derive path-based ids for nested files
  const sourceRoot = extname(source) ? undefined : resolvedSource;
  const entries: ContentLoaderEntry[] = [];
  for (const filePath of files) {
    entries.push(
      ...((await entry.call("load", filePath, {
        directiveOptions,
        schema,
        ...(sourceRoot !== undefined && { sourceRoot }),
      })) as ContentLoaderEntry[]),
    );
  }

  // Validate entries against schema if present
  if (schema) {
    validateEntries(entries, schema, name);
  }

  return entries;
}

/** Error message for an unregistered non-JSON extension, naming the fix. */
function unknownFormatError(path: string, ext: string): Error {
  return new Error(
    `No format class registered for "${ext}" (${path}). ` +
      `Enable an extension providing this format in project.json "extensions", ` +
      `e.g. "@jxsuite/parser".`,
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ─── Schema Validation ────────────────────────────────────────────────────────

/**
 * Validate content entries against their content type schema. Logs warnings for missing required
 * fields and type mismatches.
 *
 * @param {ContentLoaderEntry[]} entries - Array of ContentEntry
 * @param {ContentTypeSchema} schema - JSON Schema for the content type
 * @param {string} contentTypeName - For error messages
 */
function validateEntries(
  entries: ContentLoaderEntry[],
  schema: ContentTypeSchema,
  contentTypeName: string,
) {
  const required = schema.required ?? [];
  const properties = schema.properties ?? {};

  for (const entry of entries) {
    // Check required fields
    for (const field of required) {
      if (!(field in entry.data) || entry.data[field] == null) {
        console.warn(
          `Content validation: "${contentTypeName}/${entry.id}" missing required field "${field}"`,
        );
      }
    }

    // Check types
    for (const [field, def] of Object.entries(properties)) {
      const value = entry.data[field];
      if (value == null) {
        continue;
      }

      if (def.type === "string" && typeof value !== "string") {
        console.warn(
          `Content validation: "${contentTypeName}/${entry.id}" field "${field}" expected string, got ${typeof value}`,
        );
      } else if (def.type === "number" && typeof value !== "number") {
        console.warn(
          `Content validation: "${contentTypeName}/${entry.id}" field "${field}" expected number, got ${typeof value}`,
        );
      } else if (def.type === "boolean" && typeof value !== "boolean") {
        console.warn(
          `Content validation: "${contentTypeName}/${entry.id}" field "${field}" expected boolean, got ${typeof value}`,
        );
      } else if (def.type === "array" && !Array.isArray(value)) {
        console.warn(
          `Content validation: "${contentTypeName}/${entry.id}" field "${field}" expected array, got ${typeof value}`,
        );
      }
    }
  }
}

// ─── Content Type Reference Resolution ──────────────────────────────────────

/** Relationship pointers into the `content` section read `#/content/<name>`. */
const CONTENT_REF_PREFIX = "#/content/";

/** Extract the target content type name from a `#/content/<name>` relationship pointer. */
function refTargetName(ref: string | undefined): string | undefined {
  if (!ref?.startsWith(CONTENT_REF_PREFIX)) {
    return undefined;
  }
  return ref.slice(CONTENT_REF_PREFIX.length);
}

/**
 * Resolve cross-content-type relationship references in entry data (specs/relationships.md). A bare
 * field `$ref` is to-one: a blog post's `author: "jane-doe"` with a schema `$ref` of
 * `#/content/authors` gets replaced by the full author entry. An array field whose `items` carry
 * the `$ref` is to-many: each id in the stored array is replaced by its entry. Unresolvable ids are
 * left untouched.
 *
 * @param {Map<string, ContentLoaderEntry[]>} contentTypes - All loaded content types
 * @param {ContentSection} section - The `content` section value the types were loaded from
 */
export function resolveContentTypeRefs(
  contentTypes: Map<string, ContentLoaderEntry[]>,
  section: ContentSection,
) {
  for (const [name, contentTypeDef] of Object.entries(section)) {
    const schema = contentTypeDef.schema as ContentTypeSchema | undefined;
    if (!schema?.properties) {
      continue;
    }

    const entries = contentTypes.get(name);
    if (!entries) {
      continue;
    }

    for (const [field, def] of Object.entries(schema.properties)) {
      const toOne = refTargetName(def.$ref);
      const toMany = toOne ? undefined : refTargetName(def.items?.$ref);
      const target = toOne ?? toMany;
      if (!target) {
        continue;
      }
      const refEntries = contentTypes.get(target);
      if (!refEntries) {
        continue;
      }

      for (const entry of entries) {
        const value = entry.data[field];
        if (toOne && typeof value === "string") {
          const resolved = refEntries.find((e) => e.id === value);
          if (resolved) {
            entry.data[field] = resolved;
          }
        } else if (toMany && Array.isArray(value)) {
          entry.data[field] = value.map((id) =>
            typeof id === "string" ? (refEntries.find((e) => e.id === id) ?? id) : id,
          );
        }
      }
    }
  }
}

// ─── The Content project-section class ───────────────────────────────────────

/**
 * `Content` — the parser extension's project-section class (Content.class.json). Owns the
 * project.json `content` section: `projectData` loads it into `_project.content`, `resolvePaths`
 * expands `$paths` values carrying the `contentType` discriminator.
 */
// oxlint-disable-next-line typescript/no-extraneous-class, unicorn/no-static-only-class -- the extension capability contract dispatches static methods on the class export named by the descriptor title (specs/extensions.md §6.1)
export class Content {
  /**
   * Load the `content` section: every content type's entries, with relationship references already
   * resolved.
   *
   * @param {unknown} sectionValue - The project.json `content` section value
   * @param {ProjectDataContext} ctx - Host context ({ projectConfig, root, registry, io })
   * @returns {Promise<Map<string, ContentLoaderEntry[]>>} Content type name → entries
   */
  static async projectData(
    sectionValue: unknown,
    ctx: ProjectDataContext,
  ): Promise<Map<string, ContentLoaderEntry[]>> {
    const section = (sectionValue ?? {}) as ContentSection;
    const data = await loadContentSection(section, ctx.root, ctx.registry.formats);
    resolveContentTypeRefs(data, section);
    return data;
  }

  /**
   * Expand a content-type `$paths` source into route-param maps: one `{ [param]: value }` per
   * entry, with `param` defaulting to "slug" and `field` to "id" (the entry id).
   *
   * @param {ContentPathsSource} pathsDef - The `$paths` value ({ contentType, param?, field? })
   * @param {ResolvePathsContext} ctx - Host context ({ data, projectConfig, root })
   * @returns {Promise<Record<string, unknown>[]>} Array of route-param objects
   */
  static async resolvePaths(
    pathsDef: ContentPathsSource,
    ctx: ResolvePathsContext,
  ): Promise<Record<string, unknown>[]> {
    const entries = ctx.data.get(pathsDef.contentType);
    if (!entries || entries.length === 0) {
      console.warn(
        `Warning: $paths references content type "${pathsDef.contentType}" but it has no entries`,
      );
      return [];
    }
    const param = pathsDef.param ?? "slug";
    const field = pathsDef.field ?? "id";
    return entries
      .map((entry) => ({
        [param]: field === "id" ? entry.id : (entry.data[field] ?? entry.id),
      }))
      .filter((p) => p[param]);
  }
}
