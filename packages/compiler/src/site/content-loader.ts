/**
 * Content-loader.js — Format-agnostic content type loader
 *
 * Loads content types defined in project.json's `contentTypes` key. JSON sources are handled
 * natively (Jx IS JSON); every other format dispatches through the format registry built from the
 * project's imports map — the class's `discover` capability lists entry files and its `load`
 * capability parses each into ContentLoaderEntry[].
 *
 * There are no implicit format defaults: a content type either names an imported format class via
 * its `format` key, or its source extension must match a registered format. Remote http(s) sources
 * require an explicit `format` whose class declares `format.remote: true`.
 *
 * @module content-loader
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { errorMessage } from "@jxsuite/schema/parse";
import { basename, extname, resolve } from "node:path";
import { buildProjectFormatRegistry, unknownFormatError } from "./format-host.ts";
import type { FormatEntry, FormatRegistry } from "@jxsuite/schema/format-registry";
import type {
  ContentTypeDef,
  ContentTypeSchema,
  JxMutableNode,
  ProjectConfig,
} from "@jxsuite/schema/types";
import type { ContentLoaderEntry } from "@jxsuite/parser/types";

// ─── JSON loader (the single native built-in format) ─────────────────────────

/**
 * Load a JSON file into ContentEntry(s). If the file is an array, each element is an entry. If it's
 * an object with an `id` field, it's a single entry.
 *
 * @param {string} filePath - Absolute path to .json file
 * @returns {ContentLoaderEntry[]} Array of ContentEntry shapes
 */
function loadJSONEntries(filePath: string) {
  const raw = JSON.parse(readFileSync(filePath, "utf8"));
  if (Array.isArray(raw)) {
    return raw.map((item: Record<string, unknown>, i: number) => ({
      body: null,
      data: item,
      id: (item.id as string) ?? `${basename(filePath, ".json")}-${i}`,
    }));
  }
  // Single object file — filename is the id
  const rawObj: Record<string, unknown> = raw;
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
 * Load and parse content types config from project.json.
 *
 * @param {string} projectRoot - Project root directory
 * @param {ProjectConfig} [projectConfig] - Already-loaded project config with `contentTypes` key
 * @returns {{
 *   config: { contentTypes: Record<string, ContentTypeDef> };
 *   contentDir: string;
 * } | null}
 *   Parsed config or null if no content dir
 */
export function loadContentConfig(projectRoot: string, projectConfig?: ProjectConfig) {
  const contentDir = resolve(projectRoot, "content");

  const config = { contentTypes: projectConfig?.contentTypes ?? {} };

  return { config, contentDir };
}

// ─── Content Type Loading ────────────────────────────────────────────────────

/**
 * Load all content types defined in project.json.
 *
 * @param {string} projectRoot - Project root directory
 * @param {ProjectConfig} [projectConfig] - Already-loaded project config
 * @param {FormatRegistry} [registry] - Pre-built format registry (built from imports if omitted)
 * @returns {Promise<Map<string, ContentLoaderEntry[]>>} Map of content type name → array of
 *   ContentEntry
 */
export async function loadContentTypes(
  projectRoot: string,
  projectConfig?: ProjectConfig,
  registry?: FormatRegistry,
) {
  const result = loadContentConfig(projectRoot, projectConfig);
  if (!result) {
    return new Map();
  }

  const { config } = result;
  const contentTypes = new Map<string, ContentLoaderEntry[]>();
  if (Object.keys(config.contentTypes).length === 0) {
    return contentTypes;
  }

  const formats = registry ?? (await buildProjectFormatRegistry(projectRoot, projectConfig));

  for (const [name, contentTypeDef] of Object.entries(config.contentTypes)) {
    const entries = await loadContentType(name, contentTypeDef, projectRoot, formats);
    contentTypes.set(name, entries);
  }

  return contentTypes;
}

/**
 * Get the $elements array for a specific content type, if defined in project.json contentTypes.
 *
 * @param {string} projectRoot - Project root directory
 * @param {string} contentTypeName - Name of the content type
 * @param {ProjectConfig} [projectConfig] - Already-loaded project config
 * @returns {(string | JxElement)[] | undefined}
 */
export function getContentTypeElements(
  projectRoot: string,
  contentTypeName: string,
  projectConfig?: ProjectConfig,
) {
  const result = loadContentConfig(projectRoot, projectConfig);
  if (!result) {
    return;
  }
  const def = result.config.contentTypes?.[contentTypeName];
  return def?.$elements;
}

/**
 * Load a single content type by its definition, dispatching through the format registry.
 *
 * @param {string} name - Content type name
 * @param {ContentTypeDef} contentTypeDef - Content type definition from project.json
 * @param {string} projectRoot - Absolute path to project root directory
 * @param {FormatRegistry} registry - Format registry built from project imports
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
  const { schema } = contentTypeDef;

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

  // Resolve the format class: explicit `format` (an import name) wins; "json" is native
  const formatName = contentTypeDef.format;
  let entry: FormatEntry | undefined;
  if (formatName && formatName !== "json") {
    entry = registry.byName(formatName);
    if (!entry) {
      throw new Error(
        `Content type "${name}": format "${formatName}" is not an imported format class. ` +
          `Add it to project.json imports, e.g. "${formatName}": "@jxsuite/parser/${formatName}.class.json".`,
      );
    }
  }

  // Remote URL source — requires an explicit remote-capable format (no implicit fallback)
  if (source.startsWith("http://") || source.startsWith("https://")) {
    if (!entry) {
      throw new Error(
        `Content type "${name}": remote sources require an explicit "format" naming an ` +
          `imported format class with "remote": true (e.g. "Csv").`,
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

  const entries: ContentLoaderEntry[] = [];
  for (const filePath of files) {
    entries.push(
      ...((await entry.call("load", filePath, {
        directiveOptions,
        schema,
      })) as ContentLoaderEntry[]),
    );
  }

  // Validate entries against schema if present
  if (schema) {
    validateEntries(entries, schema, name);
  }

  return entries;
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

// ─── Content Type Querying (re-exported from @jxsuite/parser/content) ────────

export { queryContentType, findEntry } from "@jxsuite/parser/content";

// ─── Content Type Reference Resolution ──────────────────────────────────────

/**
 * Resolve cross-content-type $ref references in entry data. For example, a blog post's `author:
 * "jane-doe"` with a schema `$ref` to the authors content type gets resolved to the full author
 * entry.
 *
 * @param {Map<string, ContentLoaderEntry[]>} contentTypes - All loaded content types @param {{
 * contentTypes: Record<string, ContentTypeDef> }} config - Content config
 */
export function resolveContentTypeRefs(
  contentTypes: Map<string, ContentLoaderEntry[]>,
  config: { contentTypes: Record<string, ContentTypeDef> },
) {
  for (const [name, contentTypeDef] of Object.entries(config.contentTypes)) {
    const { schema } = contentTypeDef;
    if (!schema?.properties) {
      continue;
    }

    const entries = contentTypes.get(name);
    if (!entries) {
      continue;
    }

    for (const [field, def] of Object.entries(schema.properties)) {
      if (!def.$ref?.startsWith("#/contentTypes/")) {
        continue;
      }
      const refContentType = def.$ref.replace("#/contentTypes/", "");
      const refEntries = contentTypes.get(refContentType);
      if (!refEntries) {
        continue;
      }

      for (const entry of entries) {
        const refId = entry.data[field];
        if (typeof refId === "string") {
          const resolved = refEntries.find((e) => e.id === refId);
          if (resolved) {
            entry.data[field] = resolved;
          }
        }
      }
    }
  }
}
