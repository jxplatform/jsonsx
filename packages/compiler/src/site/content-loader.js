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

import { readFileSync } from "node:fs";
import { resolve, basename, extname } from "node:path";
import { globSync } from "glob";

// ─── CSV Parser (minimal, spec-compliant) ─────────────────────────────────────

/**
 * Parse a CSV string into an array of objects using the first row as headers. Handles quoted fields
 * with commas and newlines.
 *
 * @param {string} csv - Raw CSV text
 * @returns {Record<string, any>[]} Array of row objects
 */
function parseCSV(csv) {
  /** @type {Record<string, any>[]} */
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
    /** @type {Record<string, any>} */
    const obj = {};
    for (let j = 0; j < headers.length; j++) {
      obj[headers[j].trim()] = fields[j]?.trim() ?? "";
    }
    rows.push(obj);
  }
  return rows;
}

// ─── Markdown loader ──────────────────────────────────────────────────────────

/** @type {any} */
let _mdModule = null;

/**
 * Lazily import @jxsuite/parser for Markdown support. This avoids hard dependency — only loads when
 * MD content types exist.
 *
 * @returns {Promise<any>}
 */
async function getMarkdownModule() {
  if (!_mdModule) {
    _mdModule = await import("@jxsuite/parser");
  }
  return _mdModule;
}

/**
 * Load a single markdown file into a ContentEntry.
 *
 * @param {string} filePath - Absolute path to .md file
 * @returns {Promise<object>} ContentEntry shape
 */
/**
 * Load a markdown file into a ContentEntry. If directiveOptions are provided, they control which
 * custom element directives are available in the markdown.
 *
 * @param {string} filePath - Absolute path to .md file
 * @param {any} [directiveOptions] - Options for the MarkdownDirective plugin
 * @returns {Promise<object>} ContentEntry shape
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
 * @returns {object[]} Array of ContentEntry shapes
 */
function loadJSONEntries(filePath) {
  const raw = JSON.parse(readFileSync(filePath, "utf-8"));
  if (Array.isArray(raw)) {
    return raw.map((/** @type {any} */ item, /** @type {number} */ i) => ({
      id: item.id ?? basename(filePath, ".json") + "-" + i,
      data: item,
      body: null,
    }));
  }
  // Single object file — filename is the id
  return [
    {
      id: raw.id ?? basename(filePath, ".json"),
      data: raw,
      body: null,
    },
  ];
}

/**
 * Load a CSV file into ContentEntry(s).
 *
 * @param {string} filePath - Absolute path to .csv file
 * @param {any} [schema] - Content type schema (for type coercion)
 * @returns {object[]} Array of ContentEntry shapes
 */
function loadCSVEntries(filePath, schema) {
  const csv = readFileSync(filePath, "utf-8");
  const rows = parseCSV(csv);
  return rows.map((/** @type {Record<string, any>} */ row, /** @type {number} */ i) => {
    // Apply type coercion based on schema if available
    if (schema?.properties) {
      for (const [key, def] of Object.entries(schema.properties)) {
        const d = /** @type {any} */ (def);
        if (key in row) {
          if (d.type === "number") row[key] = Number(row[key]);
          else if (d.type === "boolean") row[key] = row[key] === "true";
        }
      }
    }
    // Use `id` column, `sku` column, or row index as the entry ID
    const id = row.id ?? row.sku ?? String(i);
    return { id, data: row, body: null };
  });
}

// ─── Content Config ───────────────────────────────────────────────────────────

/**
 * Load and parse content types config from project.json.
 *
 * @param {string} projectRoot - Project root directory
 * @param {Record<string, any>} [projectConfig] - Already-loaded project config with `contentTypes`
 *   key
 * @returns {{ config: any; contentDir: string } | null} Parsed config or null if no content dir
 */
export function loadContentConfig(projectRoot, projectConfig = undefined) {
  const contentDir = resolve(projectRoot, "content");

  /** @type {any} */
  const config = { contentTypes: projectConfig?.contentTypes ?? {} };

  return { config, contentDir };
}

// ─── Content Type Loading ────────────────────────────────────────────────────

/**
 * Load all content types defined in project.json.
 *
 * @param {string} projectRoot - Project root directory
 * @param {Record<string, any>} [projectConfig] - Already-loaded project config
 * @returns {Promise<Map<string, any[]>>} Map of content type name → array of ContentEntry
 */
export async function loadContentTypes(projectRoot, projectConfig = undefined) {
  const result = loadContentConfig(projectRoot, projectConfig);
  if (!result) return new Map();

  const { config } = result;
  /** @type {Map<string, any[]>} */
  const contentTypes = new Map();

  for (const [name, contentTypeDef] of Object.entries(config.contentTypes)) {
    const entries = await loadContentType(name, /** @type {any} */ (contentTypeDef), projectRoot);
    contentTypes.set(name, entries);
  }

  return contentTypes;
}

/**
 * Get the $elements array for a specific content type, if defined in project.json contentTypes.
 *
 * @param {string} projectRoot - Project root directory
 * @param {string} contentTypeName - Name of the content type
 * @param {Record<string, any>} [projectConfig] - Already-loaded project config
 * @returns {any[] | undefined}
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
 * @param {any} contentTypeDef - Content type definition from project.json
 * @param {string} projectRoot - Absolute path to project root directory
 * @returns {Promise<any[]>} Array of ContentEntry
 */
async function loadContentType(name, contentTypeDef, projectRoot) {
  const source = contentTypeDef.source;
  const schema = contentTypeDef.schema;

  // Derive directive allowedNames from content type $elements (tag names from npm packages)
  /** @type {any} */
  const directiveOptions = contentTypeDef.$elements?.length
    ? {
        allowedNames: contentTypeDef.$elements
          .filter((/** @type {any} */ e) => typeof e === "string" || e?.$ref)
          .map((/** @type {any} */ e) => (typeof e === "string" ? e : e.$ref)),
      }
    : undefined;

  // Resolve the glob pattern relative to project root
  const pattern = resolve(projectRoot, source).split("\\").join("/");
  const files = globSync(pattern, { absolute: true });

  /** @type {any[]} */
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
 * @param {any[]} entries - Array of ContentEntry
 * @param {any} schema - JSON Schema for the content type
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
      const d = /** @type {any} */ (def);
      const value = entry.data[field];
      if (value == null) continue;

      if (d.type === "string" && typeof value !== "string") {
        console.warn(
          `Content validation: "${contentTypeName}/${entry.id}" field "${field}" expected string, got ${typeof value}`,
        );
      } else if (d.type === "number" && typeof value !== "number") {
        console.warn(
          `Content validation: "${contentTypeName}/${entry.id}" field "${field}" expected number, got ${typeof value}`,
        );
      } else if (d.type === "boolean" && typeof value !== "boolean") {
        console.warn(
          `Content validation: "${contentTypeName}/${entry.id}" field "${field}" expected boolean, got ${typeof value}`,
        );
      } else if (d.type === "array" && !Array.isArray(value)) {
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
 * @param {any[]} entries - Full content type entries
 * @param {any} [query] - Query options
 * @returns {any[]} Filtered, sorted, limited entries
 */
export function queryContentType(entries, query = {}) {
  let result = [...entries];

  // Filter
  if (query.filter && typeof query.filter === "object") {
    result = result.filter((/** @type {any} */ entry) => {
      for (const [key, expected] of Object.entries(
        /** @type {Record<string, any>} */ (query.filter),
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
    result.sort((/** @type {any} */ a, /** @type {any} */ b) => {
      const aVal = a.data[field] ?? "";
      const bVal = b.data[field] ?? "";
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
 * @param {any[]} entries - Full content type entries
 * @param {string} id - Entry ID to find
 * @returns {any | null} The matching entry or null
 */
export function findEntry(entries, id) {
  return entries.find((/** @type {any} */ e) => e.id === id) ?? null;
}

// ─── Content Type Reference Resolution ──────────────────────────────────────

/**
 * Resolve cross-content-type $ref references in entry data. For example, a blog post's `author:
 * "jane-doe"` with a schema `$ref` to the authors content type gets resolved to the full author
 * entry.
 *
 * @param {Map<string, any[]>} contentTypes - All loaded content types @param {any} config -
 * Content.config.json
 */
export function resolveContentTypeRefs(contentTypes, config) {
  for (const [name, contentTypeDef] of Object.entries(config.contentTypes)) {
    const cd = /** @type {any} */ (contentTypeDef);
    const schema = cd.schema;
    if (!schema?.properties) continue;

    const entries = contentTypes.get(name);
    if (!entries) continue;

    for (const [field, def] of Object.entries(schema.properties)) {
      const d = /** @type {any} */ (def);
      if (!d.$ref?.startsWith("#/contentTypes/")) continue;
      const refContentType = d.$ref.replace("#/contentTypes/", "");
      const refEntries = contentTypes.get(refContentType);
      if (!refEntries) continue;

      for (const entry of entries) {
        const refId = entry.data[field];
        if (typeof refId === "string") {
          const resolved = refEntries.find((/** @type {any} */ e) => e.id === refId);
          if (resolved) {
            entry.data[field] = resolved;
          }
        }
      }
    }
  }
}
