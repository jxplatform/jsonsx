/** Style utilities — pure CSS helper functions used by the style panel. */

import { getNodeAtPath } from "../store.js";
import { activeTab } from "../workspace/workspace.js";
import { camelToKebab } from "../utils/studio-utils.js";
import cssMeta from "../../data/css-meta.json";

/** @type {Map<string, string>} */
let cssInitialMap = new Map();

/** Initialise cssInitialMap from webdata — call once during bootstrap. */
export function initCssData(/** @type {any} */ webdata) {
  cssInitialMap = new Map(/** @type {any} */ (webdata.cssProps));
}

/** Get the CSS initial-value map (populated by initCssData). */
export function getCssInitialMap() {
  return cssInitialMap;
}

// ─── Condition helpers ──────────────────────────────────────────────────────

/** @param {any} cond @param {any} styles */
export function conditionPasses(cond, styles) {
  const val = styles[cond.prop] ?? "";
  if (cond.values.length === 0) return val !== "" && val !== "initial";
  return cond.values.includes(val);
}

/** @param {any} entry @param {any} styles */
export function allConditionsPass(entry, styles) {
  return (entry.$show ?? []).every((/** @type {any} */ c) => conditionPasses(c, styles));
}

// ─── Auto-open sections ─────────────────────────────────────────────────────

/** @param {any} node @param {any} currentSections */
export function autoOpenSections(node, currentSections) {
  const style = node.style || {};
  const result = { ...currentSections };
  for (const prop of Object.keys(style)) {
    if (typeof style[prop] === "object") continue;
    const entry = /** @type {Record<string, any>} */ (cssMeta.$defs)[prop];
    const section = entry?.$section ?? "other";
    if (!result[section]) result[section] = true;
  }
  return result;
}

// ─── Shorthand expand/compress ──────────────────────────────────────────────

/** Get longhands for a shorthand property from css-meta */
export function getLonghands(/** @type {any} */ shorthandProp) {
  const entry = /** @type {Record<string, any>} */ (cssMeta.$defs)[shorthandProp];
  if (entry?.$longhands) {
    return entry.$longhands
      .map((/** @type {string} */ name) => ({
        name,
        entry: /** @type {Record<string, any>} */ (cssMeta.$defs)[name] || { $order: 0 },
      }))
      .sort((/** @type {any} */ a, /** @type {any} */ b) => a.entry.$order - b.entry.$order);
  }
  const result = [];
  for (const [name, e] of /** @type {[string, any][]} */ (Object.entries(cssMeta.$defs))) {
    if (e.$shorthand === shorthandProp) result.push({ name, entry: e });
  }
  result.sort((a, b) => a.entry.$order - b.entry.$order);
  return result;
}

/**
 * Expand a CSS shorthand value into individual longhand values following the standard 1–4 value
 * TRBL pattern.
 */
export function expandShorthand(/** @type {string} */ shortVal, /** @type {number} */ count) {
  if (!shortVal) return Array(count).fill("");
  const parts = shortVal.trim().split(/\s+/);
  if (count !== 4 || parts.length === 0) return Array(count).fill("");
  if (parts.length === 1) return [parts[0], parts[0], parts[0], parts[0]];
  if (parts.length === 2) return [parts[0], parts[1], parts[0], parts[1]];
  if (parts.length === 3) return [parts[0], parts[1], parts[2], parts[1]];
  return [parts[0], parts[1], parts[2], parts[3]];
}

/** Compress 4 TRBL values back into the shortest valid CSS shorthand string. */
export function compressShorthand(/** @type {string[]} */ vals) {
  const [t, r, b, l] = vals;
  if (t === r && r === b && b === l) return t;
  if (t === b && r === l) return `${t} ${r}`;
  if (r === l) return `${t} ${r} ${b}`;
  return `${t} ${r} ${b} ${l}`;
}

// ─── Border-side shorthand parsing ──────────────────────────────────────────

export const BORDER_STYLES = new Set([
  "none",
  "solid",
  "dashed",
  "dotted",
  "double",
  "groove",
  "ridge",
  "inset",
  "outset",
  "hidden",
]);

/**
 * Parse a border-side shorthand value into [width, style, color].
 *
 * @param {string} value
 * @returns {string[]}
 */
export function expandBorderSide(value) {
  if (!value) return ["", "", ""];
  const tokens = [];
  let current = "";
  let depth = 0;
  for (const ch of value.trim()) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === " " && depth === 0) {
      if (current) tokens.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  if (current) tokens.push(current);

  let width = "";
  let style = "";
  let color = "";

  for (const tok of tokens) {
    if (!style && BORDER_STYLES.has(tok)) {
      style = tok;
    } else if (!width && /^[\d.]/.test(tok)) {
      width = tok;
    } else {
      color = color ? `${color} ${tok}` : tok;
    }
  }

  return [width, style, color];
}

/**
 * Recompose border-side longhand values into a shorthand string.
 *
 * @param {string[]} vals
 * @returns {string}
 */
export function compressBorderSide(/** @type {string[]} */ vals) {
  return vals.filter((v) => v && v.trim()).join(" ");
}

// ─── Font helpers ───────────────────────────────────────────────────────────

/** Extract --font-* CSS custom properties from the document root style. */
export function getFontVars() {
  const style = activeTab.value?.doc.document?.style;
  if (!style) return [];
  const vars = [];
  for (const [k, v] of Object.entries(style)) {
    if (k.startsWith("--font") && (typeof v === "string" || typeof v === "number")) {
      vars.push({ name: k, value: String(v) });
    }
  }
  return vars;
}

/** Typography CSS properties that should preview their values in-menu */
export const TYPO_PREVIEW_PROPS = new Set([
  "fontStyle",
  "fontVariant",
  "textTransform",
  "textDecoration",
]);

/** Resolve the current font family for typography preview (handles var() references) */
export function currentFontFamily() {
  const tab = activeTab.value;
  const node = tab?.session.selection
    ? getNodeAtPath(tab.doc.document, tab.session.selection)
    : null;
  const raw = node?.style?.fontFamily;
  if (!raw) return "";
  const m = typeof raw === "string" && raw.match(/^var\((--[^)]+)\)$/);
  if (m) return tab?.doc.document?.style?.[m[1]] || "";
  return raw;
}

export { cssMeta, camelToKebab };
