/**
 * Studio-utils.js — Pure utility functions extracted from studio.js
 *
 * These are all side-effect-free functions used by style/properties/events panels.
 */

/**
 * CamelCase → kebab-case for inline style attributes
 *
 * @param {string} str
 * @returns {string}
 */
export function camelToKebab(str) {
  return str.replace(/[A-Z]/g, (/** @type {string} */ c) => "-" + c.toLowerCase());
}

/**
 * Convert camelCase property name to "Title Case" label (e.g. "backgroundColor" → "Background
 * Color")
 *
 * @param {string} prop
 * @returns {string}
 */
export function camelToLabel(prop) {
  return prop
    .replace(/([A-Z])/g, " $1")
    .replace(/^./, (/** @type {string} */ c) => c.toUpperCase());
}

/**
 * Convert a kebab-case CSS value to Title Case for picker display (e.g. "border-box" → "Border
 * Box")
 *
 * @param {string} val
 * @returns {string}
 */
export function kebabToLabel(val) {
  return val.replace(
    /(^|-)(\w)/g,
    (/** @type {string} */ _, /** @type {string} */ sep, /** @type {string} */ c) =>
      (sep ? " " : "") + c.toUpperCase(),
  );
}

/**
 * Get display label from metadata entry or prop name
 *
 * @param {{ $label?: string; [key: string]: unknown } | null | undefined} entry
 * @param {string} prop
 * @returns {string}
 */
export function propLabel(entry, prop) {
  return entry?.$label || camelToLabel(prop);
}

/**
 * Label for HTML attributes — handles kebab-case (aria-label → "Aria Label")
 *
 * @param {{ $label?: string; [key: string]: unknown } | null | undefined} entry
 * @param {string} attr
 * @returns {string}
 */
export function attrLabel(entry, attr) {
  if (entry?.$label) return entry.$label;
  if (attr.includes("-"))
    return attr.replace(
      /(^|-)(\w)/g,
      (/** @type {string} */ _, /** @type {string} */ sep, /** @type {string} */ c) =>
        (sep ? " " : "") + c.toUpperCase(),
    );
  return camelToLabel(attr);
}

/**
 * Abbreviate a CSS value for button-group display
 *
 * @param {string} val
 * @returns {string}
 */
export function abbreviateValue(val) {
  /** @type {Record<string, string>} */
  const map = {
    inline: "inl",
    "inline-block": "i-blk",
    "inline-flex": "i-flx",
    "inline-grid": "i-grd",
    contents: "cnt",
    "flow-root": "flow",
    nowrap: "no-wr",
    "wrap-reverse": "wr-rev",
    "flex-start": "start",
    "flex-end": "end",
    "space-between": "betw",
    "space-around": "arnd",
    "space-evenly": "even",
    stretch: "str",
    baseline: "base",
    normal: "norm",
    "row-reverse": "row-r",
    "column-reverse": "col-r",
    column: "col",
  };
  return map[val] || val;
}

/**
 * Determine input widget type from a css-meta entry
 *
 * @param {Record<string, unknown>} entry
 * @returns {string}
 */
export function inferInputType(entry) {
  if (entry.$shorthand === true) return "shorthand";
  if (entry.$input === "button-group") return "button-group";
  if (entry.$input === "media") return "media";
  if (entry.format === "color") return "color";
  if (entry.format === "uri-reference") return "media";
  if (entry.$units !== undefined) return "number-unit";
  if (entry.type === "number") return "number";
  if (Array.isArray(entry.enum)) return "select";
  if (Array.isArray(entry.examples) || Array.isArray(entry.presets)) return "combobox";
  return "text";
}

/**
 * Match a document path to a content type and return its schema. Compares the content type's
 * `source` directory against the document path prefix, using `format` for extension matching.
 *
 * @param {string | null} documentPath — project-relative path (e.g. "content/products/widget.md")
 * @param {ProjectConfig | null | undefined} projectConfig — parsed project.json
 * @returns {{ name: string; schema: ContentTypeSchema } | null}
 */
export function findContentTypeSchema(documentPath, projectConfig) {
  if (!documentPath || !projectConfig?.contentTypes) return null;
  for (const [name, def] of Object.entries(
    /** @type {Record<string, ContentTypeDef>} */ (projectConfig.contentTypes),
  )) {
    if (!def.source || !def.schema) continue;
    const src = def.source.replace(/^\.\//, "").replace(/\/$/, "");
    const hasExt = src.includes(".") && !src.endsWith("/");
    if (hasExt) {
      if (documentPath === src || documentPath.endsWith("/" + src)) {
        return { name, schema: def.schema };
      }
    } else {
      const ext = `.${def.format || "md"}`;
      if (documentPath.startsWith(src + "/") && documentPath.endsWith(ext)) {
        return { name, schema: def.schema };
      }
    }
  }
  return null;
}

/**
 * Convert a human-readable name to a CSS variable name. E.g. "Geometric Humanist" →
 * "--font-geometric-humanist"
 *
 * @param {string} name
 * @param {string} prefix - E.g. "--font-"
 * @returns {string}
 */
export function friendlyNameToVar(name, prefix) {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  if (!slug) return "";
  return `${prefix}${slug}`;
}

/**
 * Convert a CSS variable name back to a display name. E.g. "--font-geometric-humanist" with prefix
 * "--font-" → "Geometric Humanist"
 *
 * @param {string} varName
 * @param {string} prefix
 * @returns {string}
 */
export function varDisplayName(varName, prefix) {
  return (
    varName
      .replace(new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`), "")
      .replace(/^--/, "")
      .replace(/-/g, " ")
      .replace(/\b\w/g, (/** @type {string} */ c) => c.toUpperCase()) || varName
  );
}

/**
 * Parse a CEM type.text string into a structured descriptor.
 *
 * @param {string | undefined | null} typeText
 * @returns {{ kind: "combobox"; options: string[] }
 *   | { kind: "boolean" }
 *   | { kind: "number" }
 *   | { kind: "text" }}
 */
export function parseCemType(typeText) {
  if (!typeText) return { kind: "text" };
  const t = typeText
    .trim()
    .replace(/\s*\|\s*undefined\b/g, "")
    .trim();
  if (t === "boolean") return { kind: "boolean" };
  if (t === "number") return { kind: "number" };
  // Detect enum: "'a' | 'b' | 'c'" — pipe-separated quoted literals
  const enumMatch = t.match(/^'[^']*'(\s*\|\s*'[^']*')+$/);
  if (enumMatch) {
    const options = [...t.matchAll(/'([^']*)'/g)].map((m) => m[1]);
    return { kind: "combobox", options };
  }
  return { kind: "text" };
}
