/**
 * Content-loader.js — Content type loader
 *
 * Loads content types defined in project.json's `contentTypes` key. Supports Markdown (.md), JSON
 * (.json), and CSV (.csv) source files.
 *
 * Phase 2 implementation of site-architecture spec §6.
 *
 * @module content-loader
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { resolve, basename, extname } from "node:path";

// ─── CSV Parser (minimal, spec-compliant) ─────────────────────────────────────

/**
 * Parse a CSV string into an array of objects using the first row as headers. Handles quoted fields
 * with commas and newlines.
 *
 * @param {string} csv - Raw CSV text
 * @returns {Record<string, string>[]} Array of row objects
 */
function parseCSV(csv) {
  /** @type {Record<string, string>[]} */
  const rows = [];
  let current = "";
  let inQuotes = false;
  /** @type {string[]} */
  const lines = [];

  // Split into rows respecting quoted newlines (preserve raw characters)
  for (let i = 0; i < csv.length; i++) {
    const ch = csv[i];
    if (ch === '"') {
      current += ch;
      if (inQuotes && csv[i + 1] === '"') {
        current += csv[i + 1];
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if ((ch === "\n" || (ch === "\r" && csv[i + 1] === "\n")) && !inQuotes) {
      lines.push(current);
      current = "";
      if (ch === "\r") i++;
    } else {
      current += ch;
    }
  }
  if (current.trim()) lines.push(current);

  if (lines.length === 0) return [];

  /** @param {string} line */
  const parseRow = (line) => {
    /** @type {string[]} */
    const fields = [];
    let field = "";
    let q = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (q && line[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          q = !q;
        }
      } else if (ch === "," && !q) {
        fields.push(field);
        field = "";
      } else {
        field += ch;
      }
    }
    fields.push(field);
    return fields;
  };

  const headers = parseRow(lines[0]);
  for (let i = 1; i < lines.length; i++) {
    const fields = parseRow(lines[i]);
    /** @type {Record<string, string>} */
    const obj = {};
    for (let j = 0; j < headers.length; j++) {
      obj[headers[j].trim()] = fields[j]?.trim() ?? "";
    }
    rows.push(obj);
  }
  return rows;
}

// ─── Markdown loader ──────────────────────────────────────────────────────────

/**
 * @type {{
 *   MarkdownFile: new (opts: Record<string, unknown>) => { resolve(): MarkdownFileResult };
 * } | null}
 */
let _mdModule = null;

/**
 * Lazily import @jxsuite/parser for Markdown support. This avoids hard dependency — only loads when
 * MD content types exist.
 *
 * @returns {Promise<{
 *   MarkdownFile: new (opts: Record<string, unknown>) => { resolve(): MarkdownFileResult };
 * }>}
 */
async function getMarkdownModule() {
  if (!_mdModule) {
    _mdModule = /** @type {any} */ (await import("@jxsuite/parser"));
  }
  return /** @type {NonNullable<typeof _mdModule>} */ (_mdModule);
}

/**
 * Load a markdown file into a ContentEntry. If directiveOptions are provided, they control which
 * custom element directives are available in the markdown.
 *
 * @param {string} filePath - Absolute path to .md file
 * @param {unknown} [directiveOptions] - Options for the MarkdownDirective plugin
 * @returns {Promise<ContentLoaderEntry>} ContentEntry shape
 */
async function loadMarkdownEntry(filePath, directiveOptions) {
  const { MarkdownFile } = await getMarkdownModule();
  const file = new MarkdownFile({ src: filePath, directiveOptions });
  const result = file.resolve();
  return {
    id: result.slug,
    data: result.frontmatter,
    body: readFileSync(filePath, "utf-8"),
    $children: result.$children,
    _meta: {
      excerpt: result.$excerpt,
      toc: result.$toc,
      readingTime: result.$readingTime,
      wordCount: result.$wordCount,
    },
  };
}

/**
 * Load a JSON file into ContentEntry(s). If the file is an array, each element is an entry. If it's
 * an object with an `id` field, it's a single entry.
 *
 * @param {string} filePath - Absolute path to .json file
 * @returns {ContentLoaderEntry[]} Array of ContentEntry shapes
 */
function loadJSONEntries(filePath) {
  const raw = JSON.parse(readFileSync(filePath, "utf-8"));
  if (Array.isArray(raw)) {
    return raw.map((/** @type {Record<string, unknown>} */ item, /** @type {number} */ i) => ({
      id: /** @type {string} */ (item.id) ?? basename(filePath, ".json") + "-" + i,
      data: item,
      body: null,
    }));
  }
  // Single object file — filename is the id
  /** @type {Record<string, unknown>} */
  const rawObj = raw;
  return [
    {
      id: /** @type {string} */ (rawObj.id) ?? basename(filePath, ".json"),
      data: rawObj,
      body: null,
    },
  ];
}

/**
 * Load a CSV file into ContentEntry(s).
 *
 * @param {string} filePath - Absolute path to .csv file
 * @param {ContentTypeSchema} [schema] - Content type schema (for type coercion)
 * @returns {ContentLoaderEntry[]} Array of ContentEntry shapes
 */
function loadCSVEntries(filePath, schema) {
  const csv = readFileSync(filePath, "utf-8");
  const rows = parseCSV(csv);
  return rows.map((/** @type {Record<string, string>} */ row, /** @type {number} */ i) => {
    // Apply type coercion based on schema if available
    /** @type {Record<string, unknown>} */
    const data = { ...row };
    if (schema?.properties) {
      for (const [key, def] of Object.entries(schema.properties)) {
        if (key in data) {
          if (def.type === "number") data[key] = Number(data[key]);
          else if (def.type === "boolean") data[key] = data[key] === "true";
        }
      }
    }
    // Use `id` column, `sku` column, or row index as the entry ID
    const id = /** @type {string | undefined} */ (data.id) ??
    /** @type {string | undefined} */ (data.sku) ??
    String(i);
    return { id, data, body: null };
  });
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
export function loadContentConfig(projectRoot, projectConfig = undefined) {
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
 * @returns {Promise<Map<string, ContentLoaderEntry[]>>} Map of content type name → array of
 *   ContentEntry
 */
export async function loadContentTypes(projectRoot, projectConfig = undefined) {
  const result = loadContentConfig(projectRoot, projectConfig);
  if (!result) return new Map();

  const { config } = result;
  /** @type {Map<string, ContentLoaderEntry[]>} */
  const contentTypes = new Map();

  for (const [name, contentTypeDef] of Object.entries(config.contentTypes)) {
    const entries = await loadContentType(name, contentTypeDef, projectRoot);
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
export function getContentTypeElements(projectRoot, contentTypeName, projectConfig = undefined) {
  const result = loadContentConfig(projectRoot, projectConfig);
  if (!result) return undefined;
  const def = result.config.contentTypes?.[contentTypeName];
  return def?.$elements;
}

/**
 * Load a single content type by its definition.
 *
 * @param {string} name - Content type name
 * @param {ContentTypeDef} contentTypeDef - Content type definition from project.json
 * @param {string} projectRoot - Absolute path to project root directory
 * @returns {Promise<ContentLoaderEntry[]>} Array of ContentEntry
 */
async function loadContentType(name, contentTypeDef, projectRoot) {
  const source = contentTypeDef.source;
  const schema = contentTypeDef.schema;

  // Derive directive allowedNames from content type $elements (tag names from npm packages)
  const directiveOptions = contentTypeDef.$elements?.length
    ? {
        allowedNames: contentTypeDef.$elements
          .filter(
            (e) =>
              typeof e === "string" ||
              (typeof e === "object" && /** @type {JxMutableNode} */ (e)?.$ref),
          )
          .map((e) => (typeof e === "string" ? e : /** @type {JxMutableNode} */ (e).$ref)),
      }
    : undefined;

  // Resolve source path and discover files
  const resolvedSource = resolve(projectRoot, source).split("\\").join("/");
  /** @type {string[]} */
  let files;

  if (source.includes("*") || source.includes("?")) {
    // Glob pattern — use Bun.Glob or manual directory scan
    const glob = new Bun.Glob(source);
    files = [...glob.scanSync({ cwd: projectRoot, absolute: true })];
  } else if (extname(source)) {
    files = existsSync(resolvedSource) ? [resolvedSource] : [];
  } else {
    const format = contentTypeDef.format || "md";
    const ext = `.${format}`;
    const dir = resolvedSource.endsWith("/") ? resolvedSource : resolvedSource + "/";
    try {
      files = readdirSync(dir, { recursive: true })
        .filter((f) => String(f).endsWith(ext))
        .map((f) => resolve(dir, String(f)));
    } catch {
      files = [];
    }
  }

  /** @type {ContentLoaderEntry[]} */
  const entries = [];

  for (const filePath of files) {
    const ext = extname(filePath).toLowerCase();

    if (ext === ".md") {
      entries.push(await loadMarkdownEntry(filePath, directiveOptions));
    } else if (ext === ".json") {
      entries.push(...loadJSONEntries(filePath));
    } else if (ext === ".csv") {
      entries.push(...loadCSVEntries(filePath, schema));
    }
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
function validateEntries(entries, schema, contentTypeName) {
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
      if (value == null) continue;

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

// ─── Content Type Querying ───────────────────────────────────────────────────

/**
 * Query a loaded content type with filter, sort, and limit. Implements the ContentCollection
 * $prototype resolution.
 *
 * @param {ContentLoaderEntry[]} entries - Full content type entries
 * @param {{
 *   filter?: Record<string, unknown>;
 *   sort?: { field: string; order?: string };
 *   limit?: number;
 * }} [query]
 *   - Query options
 * @returns {ContentLoaderEntry[]} Filtered, sorted, limited entries
 */
export function queryContentType(entries, query = {}) {
  let result = [...entries];

  // Filter
  if (query.filter && typeof query.filter === "object") {
    result = result.filter((entry) => {
      for (const [key, expected] of Object.entries(
        /** @type {Record<string, unknown>} */ (query.filter),
      )) {
        const actual = entry.data[key];
        if (actual !== expected) return false;
      }
      return true;
    });
  }

  // Sort
  if (query.sort) {
    const { field, order = "asc" } = query.sort;
    result.sort((a, b) => {
      const aVal = /** @type {string | number} */ (a.data[field] ?? "");
      const bVal = /** @type {string | number} */ (b.data[field] ?? "");
      if (aVal < bVal) return order === "asc" ? -1 : 1;
      if (aVal > bVal) return order === "asc" ? 1 : -1;
      return 0;
    });
  }

  // Limit
  if (query.limit && query.limit > 0) {
    result = result.slice(0, query.limit);
  }

  return result;
}

/**
 * Find a single entry by ID in a content type. Implements the ContentEntry $prototype resolution.
 *
 * @param {ContentLoaderEntry[]} entries - Full content type entries
 * @param {string} id - Entry ID to find
 * @returns {ContentLoaderEntry | null} The matching entry or null
 */
export function findEntry(entries, id) {
  return entries.find((e) => e.id === id) ?? null;
}

// ─── Content Type Reference Resolution ──────────────────────────────────────

/**
 * Resolve cross-content-type $ref references in entry data. For example, a blog post's `author:
 * "jane-doe"` with a schema `$ref` to the authors content type gets resolved to the full author
 * entry.
 *
 * @param {Map<string, ContentLoaderEntry[]>} contentTypes - All loaded content types @param {{
 * contentTypes: Record<string, ContentTypeDef> }} config - Content config
 */
export function resolveContentTypeRefs(contentTypes, config) {
  for (const [name, contentTypeDef] of Object.entries(config.contentTypes)) {
    const schema = contentTypeDef.schema;
    if (!schema?.properties) continue;

    const entries = contentTypes.get(name);
    if (!entries) continue;

    for (const [field, def] of Object.entries(schema.properties)) {
      if (!def.$ref?.startsWith("#/contentTypes/")) continue;
      const refContentType = def.$ref.replace("#/contentTypes/", "");
      const refEntries = contentTypes.get(refContentType);
      if (!refEntries) continue;

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
