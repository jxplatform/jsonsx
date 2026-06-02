/** Style utilities — pure CSS helper functions used by the style panel. */

import type { JxMutableNode } from "@jxsuite/schema/types";

import { getNodeAtPath } from "../store";
import { activeTab } from "../workspace/workspace";
import { camelToKebab } from "../utils/studio-utils";
import cssMeta from "../../data/css-meta.json";

let cssInitialMap: Map<string, string> = new Map();

/** Initialise cssInitialMap from webdata — call once during bootstrap. */
export function initCssData(webdata: { cssProps: string[][] }) {
  cssInitialMap = new Map(webdata.cssProps as [string, string][]);
}

/** Get the CSS initial-value map (populated by initCssData). */
export function getCssInitialMap() {
  return cssInitialMap;
}

// ─── Condition helpers ──────────────────────────────────────────────────────

/** @param {{ prop: string; values: string[] }} cond @param {Record<string, unknown>} styles */
export function conditionPasses(
  cond: { prop: string; values: string[] },
  styles: Record<string, unknown>,
) {
  const val = (styles[cond.prop] ?? "") as string;
  if (cond.values.length === 0) return val !== "" && val !== "initial";
  return cond.values.includes(val);
}

/**
 * @param {{ $show?: { prop: string; values: string[] }[] }} entry @param {Record<string, unknown>}
 *   styles
 */
export function allConditionsPass(
  entry: { $show?: { prop: string; values: string[] }[] },
  styles: Record<string, unknown>,
) {
  return (entry.$show ?? []).every((/** @type {{ prop: string; values: string[] }} */ c) =>
    conditionPasses(c, styles),
  );
}

// ─── Auto-open sections ─────────────────────────────────────────────────────

/** @param {JxMutableNode} node @param {Record<string, boolean>} currentSections */
export function autoOpenSections(node: JxMutableNode, currentSections: Record<string, boolean>) {
  const style = node.style || {};
  const result = { ...currentSections };
  for (const prop of Object.keys(style)) {
    if (typeof style[prop] === "object") continue;
    const entry = (cssMeta.$defs as Record<string, Record<string, unknown>>)[prop];
    const section = (entry?.$section as string) ?? "other";
    if (!result[section]) result[section] = true;
  }
  return result;
}

// ─── Shorthand expand/compress ──────────────────────────────────────────────

/** Get longhands for a shorthand property from css-meta */
export function getLonghands(shorthandProp: string) {
  const entry = (cssMeta.$defs as Record<string, Record<string, unknown>>)[shorthandProp];
  if (entry?.$longhands) {
    return (entry.$longhands as string[])
      .map((name: string) => ({
        name,
        entry: (cssMeta.$defs as Record<string, Record<string, unknown>>)[name] || {
          $order: 0,
        },
      }))
      .sort(
        (
          /** @type {{ entry: Record<string, unknown> }} */ a,
          /** @type {{ entry: Record<string, unknown> }} */ b,
        ) => (a.entry.$order as number) - (b.entry.$order as number),
      );
  }
  const result = [];
  for (const [name, e] of Object.entries(cssMeta.$defs) as [string, Record<string, unknown>][]) {
    if (e.$shorthand === shorthandProp) result.push({ name, entry: e });
  }
  result.sort((a, b) => (a.entry.$order as number) - (b.entry.$order as number));
  return result;
}

/**
 * Expand a CSS shorthand value into individual longhand values following the standard 1–4 value
 * TRBL pattern.
 */
export function expandShorthand(shortVal: string, count: number) {
  if (!shortVal) return Array(count).fill("");
  const parts = shortVal.trim().split(/\s+/);
  if (count !== 4 || parts.length === 0) return Array(count).fill("");
  if (parts.length === 1) return [parts[0], parts[0], parts[0], parts[0]];
  if (parts.length === 2) return [parts[0], parts[1], parts[0], parts[1]];
  if (parts.length === 3) return [parts[0], parts[1], parts[2], parts[1]];
  return [parts[0], parts[1], parts[2], parts[3]];
}

/** Compress 4 TRBL values back into the shortest valid CSS shorthand string. */
export function compressShorthand(vals: string[]) {
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
export function expandBorderSide(value: string) {
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
export function compressBorderSide(vals: string[]) {
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
