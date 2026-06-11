/**
 * Jx Markdown Transpiler — Browser-safe module
 *
 * Exports only the transpiler functions that work in browser environments
 * (no node:fs, node:path, or glob dependencies).
 *
 * Use `@jxsuite/parser/transpile` to import in browser contexts (e.g. studio).
 * Use `@jxsuite/parser` for the full parser including MarkdownFile/MarkdownCollection.
 *
 * @module @jxsuite/parser/transpile
 * @license MIT
 */

import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkFrontmatter from "remark-frontmatter";
import remarkParseFrontmatter from "remark-parse-frontmatter";
import remarkGfm from "remark-gfm";
import remarkDirective from "remark-directive";
import { htmlToJx } from "./html-to-jx.ts";
import type { MdastNode } from "./types.ts";
import type { JsonValue, JxAttributeValue, JxDocument, JxElement } from "@jxsuite/schema/types";

export { htmlToJx };

// ─── Dot-path expansion ─────────────────────────────────────────────────────

/**
 * Jx reserved keywords that need `$` prefix in directive attributes. Only includes keywords with no
 * DOM/HTML property collision.
 */
const JX_DOLLAR_KEYS = new Set(["prototype", "ref", "component", "props", "switch", "elements"]);

/**
 * Annotation keys written as `--key` in markdown directives, mapped to `$key` in JX JSON. These use
 * `--` prefix to avoid collision with HTML attributes like `title`.
 */
const JX_ANNOTATION_KEYS = new Set(["title", "description"]);

/**
 * Re-add `$` prefix to known Jx reserved keywords and annotation keys.
 *
 * @param {string} key
 * @returns {string}
 */
export function jxKey(key: string) {
  if (JX_DOLLAR_KEYS.has(key)) {
    return `$${key}`;
  }
  if (key.startsWith("--") && JX_ANNOTATION_KEYS.has(key.slice(2))) {
    return `$${key.slice(2)}`;
  }
  return key;
}

/**
 * Strip `$` prefix from Jx reserved keywords for markdown attribute output.
 *
 * @param {string} key
 * @returns {string}
 */
export function mdKey(key: string) {
  if (key.startsWith("$") && JX_DOLLAR_KEYS.has(key.slice(1))) {
    return key.slice(1);
  }
  if (key.startsWith("$") && JX_ANNOTATION_KEYS.has(key.slice(1))) {
    return `--${key.slice(1)}`;
  }
  return key;
}

/**
 * Expand dot-path attribute keys into nested objects.
 *
 * @param {Record<string, string>} attrs - Flat attribute map from remark-directive
 * @returns {Record<string, unknown>} Nested object
 */
export function expandDotPaths(attrs: Record<string, string>) {
  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(attrs)) {
    const dotIndex = key.indexOf(".");
    if (dotIndex === -1) {
      result[jxKey(key)] = value;
      continue;
    }

    const segments = key.split(".");
    let target = result;
    for (let i = 0; i < segments.length - 1; i++) {
      const seg = jxKey(segments[i]);
      if (!(seg in target) || typeof target[seg] !== "object") {
        target[seg] = {};
      }
      target = target[seg] as Record<string, unknown>;
    }
    target[jxKey(segments.at(-1) as string)] = value;
  }

  return result;
}

/**
 * Collapse a nested object back to dot-path flat attributes (inverse of expandDotPaths).
 *
 * @param {Record<string, unknown>} obj - Nested object
 * @returns {Record<string, string>} Flat attribute map
 */
export function collapseDotPaths(obj: Record<string, unknown>) {
  const result: Record<string, string> = {};

  function walk(node: Record<string, unknown>, prefix: string) {
    for (const [key, value] of Object.entries(node)) {
      const path = prefix ? `${prefix}.${key}` : key;
      if (value && typeof value === "object" && !Array.isArray(value)) {
        walk(value as Record<string, unknown>, path);
      } else {
        result[path] = String(value);
      }
    }
  }

  walk(obj, "");
  return result;
}

/** CSS pseudo-class / pseudo-element names (keys that become `:` prefixed in style objects). */
const CSS_PSEUDO_NAMES = new Set([
  "hover",
  "focus",
  "active",
  "visited",
  "disabled",
  "checked",
  "valid",
  "invalid",
  "required",
  "empty",
  "first-child",
  "last-child",
  "focus-within",
  "focus-visible",
  "placeholder",
  "selection",
  "before",
  "after",
]);

/**
 * Apply CSS pseudo-class and media query key mapping to a style object's top-level keys.
 *
 * Transforms keys that cannot use `:` or `@` prefixes in remark-directive attributes: - `hover` →
 * `:hover` (for known CSS pseudo-class names) - `--dark` → `@--dark` (for custom property / media
 * query keys)
 *
 * @param {Record<string, unknown>} styleObj
 * @returns {Record<string, unknown>}
 */
export function applyStyleKeyMapping(styleObj: Record<string, unknown>) {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(styleObj)) {
    if (CSS_PSEUDO_NAMES.has(key)) {
      result[`:${key}`] = value;
    } else if (key.startsWith("--")) {
      result[`@${key}`] = value;
    } else {
      result[key] = value;
    }
  }
  return result;
}

/**
 * Expand dot-path attributes with style-aware key mapping.
 *
 * Maps known CSS pseudo-class names → `:` prefix and `--` keys → `@` prefix, since `:` and `@`
 * cannot appear at the start of remark-directive attribute keys.
 *
 * @param {Record<string, string>} attrs
 * @returns {Record<string, unknown>}
 */
export function expandStylePaths(attrs: Record<string, string>) {
  return applyStyleKeyMapping(expandDotPaths(attrs));
}

/**
 * Collapse a style object back to flat dot-path attributes (inverse of expandStylePaths).
 *
 * Strips `:` prefix from pseudo-class keys and `@` prefix from media keys before flattening with
 * collapseDotPaths.
 *
 * @param {Record<string, unknown>} styleObj
 * @returns {Record<string, string>}
 */
export function collapseStylePaths(styleObj: Record<string, unknown>) {
  const normalized: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(styleObj)) {
    if (key.startsWith(":") && CSS_PSEUDO_NAMES.has(key.slice(1))) {
      normalized[key.slice(1)] = value;
    } else if (key.startsWith("@--")) {
      normalized[key.slice(1)] = value;
    } else {
      normalized[key] = value;
    }
  }

  return collapseDotPaths(normalized);
}

// ─── Detection ──────────────────────────────────────────────────────────────

/**
 * Check if a markdown source string is a Jx component (vs content markdown). Returns true if
 * frontmatter contains a `tagName` key with a hyphen.
 *
 * @param {string} source - Raw markdown string
 * @returns {boolean}
 */
export function isJxMarkdown(source: string) {
  const fmMatch = source.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fmMatch) {
    return false;
  }
  return /^tagName:\s*.+-.+/m.test(fmMatch[1]);
}

// ─── Transpiler ─────────────────────────────────────────────────────────────

/** HTML attributes that go into the `attributes` sub-object (not top-level DOM properties). */
const HTML_ATTR_PATTERN = /^(?:aria-|data-|slot$)/;

/**
 * Elements with phrasing content model — cannot contain <p> elements. When these appear as
 * container directives, paragraph children from the markdown parser are unwrapped (their inline
 * children promoted directly).
 */
const PHRASING_ELEMENTS = new Set([
  "p",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "span",
  "a",
  "em",
  "strong",
  "b",
  "i",
  "u",
  "s",
  "small",
  "sub",
  "sup",
  "mark",
  "abbr",
  "cite",
  "q",
  "dfn",
  "time",
  "var",
  "samp",
  "kbd",
  "data",
  "code",
  "label",
  "button",
  "legend",
  "summary",
  "dt",
]);

/**
 * Route directive attributes to their correct Jx locations.
 *
 * @param {Record<string, string>} attrs
 * @returns {{ props: Record<string, unknown>; attributes: Record<string, string> }}
 */
function routeAttributes(attrs: Record<string, string>) {
  const expanded = expandDotPaths(attrs);

  // Apply style-key mapping (pseudo-classes, media queries) to the style sub-object
  if (expanded.style && typeof expanded.style === "object") {
    expanded.style = applyStyleKeyMapping(expanded.style as Record<string, unknown>);
  }

  const props: Record<string, unknown> = {};
  const attributes: Record<string, string> = {};

  for (const [key, value] of Object.entries(expanded)) {
    if (HTML_ATTR_PATTERN.test(key)) {
      attributes[key] = value as string;
    } else {
      props[key] = value;
    }
  }

  return { attributes, props };
}

/**
 * Mdast node-type → Jx tagName mapping.
 *
 * @type {Record<string, (n: MdastNode) => string>}
 */
const JX_TAG_MAP: Record<string, (n: MdastNode) => string> = {
  blockquote: () => "blockquote",
  break: () => "br",
  code: () => "pre",
  delete: () => "del",
  emphasis: () => "em",
  heading: (n: MdastNode) => `h${n.depth}`,
  image: () => "img",
  inlineCode: () => "code",
  link: () => "a",
  list: (n: MdastNode) => (n.ordered ? "ol" : "ul"),
  listItem: () => "li",
  paragraph: () => "p",
  strong: () => "strong",
  table: () => "table",
  tableCell: (n: MdastNode) => (n.isHeader ? "th" : "td"),
  tableRow: () => "tr",
  thematicBreak: () => "hr",
};

/**
 * Convert a standard mdast node to a Jx element definition.
 *
 * @param {MdastNode} node
 * @returns {JxElement | string | (JxElement | string)[] | null} Jx element or null
 */
export function mdastNodeToJx(node: MdastNode) {
  if (!node || typeof node !== "object") {
    return null;
  }

  if (node.type === "yaml" || node.type === "toml") {
    return null;
  }

  if (
    node.type === "containerDirective" ||
    node.type === "leafDirective" ||
    node.type === "textDirective"
  ) {
    return directiveToJx(node);
  }

  if (node.type === "text") {
    return node.value ?? null;
  }

  if (node.type === "html") {
    if (node.value) {
      return htmlToJx(node.value);
    }
    return null;
  }

  const tagFn = JX_TAG_MAP[node.type];
  if (!tagFn) {
    return null;
  }

  const tag = tagFn(node);
  const el: JxElement = { tagName: tag };

  switch (node.type) {
    case "heading":
    case "paragraph":
    case "emphasis":
    case "strong":
    case "delete":
    case "blockquote":
    case "listItem":
    case "tableRow":
    case "tableCell": {
      const children = convertChildren(node.children ?? []);
      if (children.length === 1 && typeof children[0] === "string") {
        [el.textContent] = children;
      } else if (children.length > 0) {
        el.children = children;
      }
      break;
    }

    case "inlineCode": {
      el.textContent = node.value ?? null;
      break;
    }

    case "link": {
      {
        const linkAttrs: Record<string, JxAttributeValue> = {
          href: node.url ?? "",
        };
        if (node.title) {
          linkAttrs.title = node.title;
        }
        el.attributes = linkAttrs;
      }
      {
        const children = convertChildren(node.children ?? []);
        if (children.length === 1 && typeof children[0] === "string") {
          [el.textContent] = children;
        } else if (children.length > 0) {
          el.children = children;
        }
      }
      break;
    }

    case "image": {
      const imageAttrs: Record<string, JxAttributeValue> = {
        alt: node.alt ?? "",
        src: node.url ?? "",
      };
      if (node.title) {
        imageAttrs.title = node.title;
      }
      el.attributes = imageAttrs;
      break;
    }

    case "list": {
      if (node.children && node.children.length > 0) {
        el.children = convertChildren(node.children);
      }
      if (node.start != null && node.start !== 1) {
        el.attributes = { start: String(node.start) };
      }
      break;
    }

    case "code": {
      el.children = [
        {
          tagName: "code",
          textContent: node.value ?? null,
          ...(node.lang ? { className: `language-${node.lang}` } : {}),
        },
      ];
      break;
    }

    case "thematicBreak":
    case "break": {
      break;
    }

    case "table": {
      const rows = convertChildren(node.children ?? []);
      const thead = rows.length > 0 ? { children: [rows[0]], tagName: "thead" } : null;
      const tbody = rows.length > 1 ? { children: rows.slice(1), tagName: "tbody" } : null;
      el.children = [thead, tbody].filter(Boolean) as JxElement[];
      break;
    }
    default: {
      break;
    }
  }

  return el;
}

/**
 * Convert a directive mdast node to a Jx element.
 *
 * @param {MdastNode} node
 * @returns {JxElement}
 */
function directiveToJx(node: MdastNode) {
  const el: JxElement = { tagName: node.name as string };

  if (node.attributes && Object.keys(node.attributes).length > 0) {
    const { props, attributes } = routeAttributes(node.attributes);
    const isCustomElement = (node.name as string).includes("-");
    if (isCustomElement) {
      // For custom elements:
      //   - style, children, textContent, innerHTML, $-prefixed → element-level
      //   - props (from props.X dot-path) → $props (component state)
      //   - everything else → HTML attributes
      for (const [key, value] of Object.entries(props)) {
        if (
          key === "style" ||
          key === "children" ||
          key === "textContent" ||
          key === "innerHTML" ||
          key.startsWith("$")
        ) {
          el[key] = value;
        } else if (key === "props") {
          el.$props = value as Record<string, JsonValue>;
        } else {
          if (!el.attributes) {
            el.attributes = {};
          }
          el.attributes[key] = value as JxAttributeValue;
        }
      }
    } else {
      // For standard HTML elements:
      //   - Jx structural keys (style, children, textContent, innerHTML, $-prefixed) → element-level
      //   - Known DOM properties that buildAttrs handles → element-level
      //   - Everything else → HTML attributes (src, href, width, height, type, alt, etc.)
      for (const [key, value] of Object.entries(props)) {
        if (
          key === "style" ||
          key === "children" ||
          key === "textContent" ||
          key === "innerHTML" ||
          key === "id" ||
          key === "className" ||
          key === "hidden" ||
          key === "tabIndex" ||
          key === "lang" ||
          key === "dir" ||
          key.startsWith("$") ||
          key.startsWith("on")
        ) {
          el[key] = value;
        } else {
          if (!el.attributes) {
            el.attributes = {};
          }
          el.attributes[key] = value as JxAttributeValue;
        }
      }
    }
    if (Object.keys(attributes).length > 0) {
      el.attributes = { ...el.attributes, ...attributes };
    }
  }

  if (node.type === "textDirective") {
    if (node.children && node.children.length > 0) {
      const children = convertChildren(node.children ?? []);
      if (children.length === 1 && typeof children[0] === "string") {
        [el.textContent] = children;
      } else if (children.length > 0) {
        el.children = children;
      }
    }
    return el;
  }

  if (node.type === "leafDirective") {
    return el;
  }

  if (node.children && node.children.length > 0) {
    const jxChildren: (JxElement | string)[] = [];
    const isPhrasingParent = PHRASING_ELEMENTS.has(node.name as string);

    for (const child of node.children) {
      if (isPhrasingParent && child.type === "paragraph") {
        // Unwrap: promote paragraph's inline children directly
        for (const inline of child.children ?? []) {
          const converted = mdastNodeToJx(inline);
          if (converted == null) {
            continue;
          }
          if (Array.isArray(converted)) {
            jxChildren.push(...converted);
          } else {
            jxChildren.push(converted);
          }
        }
      } else {
        const converted = mdastNodeToJx(child);
        if (converted == null) {
          continue;
        }
        if (Array.isArray(converted)) {
          jxChildren.push(...converted);
        } else {
          jxChildren.push(converted);
        }
      }
    }

    // Don't overwrite children if already set as an object by dot-path attributes
    // (e.g. children.prototype="Array" children.items.ref="...")
    if (el.children && typeof el.children === "object" && !Array.isArray(el.children)) {
      // Children was set to a descriptor object by dot-path expansion — keep it
    } else if (jxChildren.length === 1 && typeof jxChildren[0] === "string") {
      [el.textContent] = jxChildren;
    } else if (jxChildren.length > 0) {
      el.children = jxChildren;
    }
  }

  return el;
}

/**
 * Convert an array of mdast children to Jx elements/strings.
 *
 * @param {MdastNode[]} children
 * @returns {(JxElement | string)[]}
 */
export function convertChildren(children: MdastNode[]) {
  if (!children) {
    return [];
  }
  return children.flatMap((n) => mdastNodeToJx(n)).filter((c) => c != null) as (
    | JxElement
    | string
  )[];
}

/**
 * Transpile a Jx Markdown source string into a complete Jx JSON document.
 *
 * Uses the standard remark-parse + remark-frontmatter + remark-directive pipeline (no rehype).
 * Walks the mdast tree and emits a Jx document with the same shape as a .json component file.
 *
 * @param {string} source - Raw markdown string
 * @returns {object} Complete Jx JSON document
 */
export function transpileJxMarkdown(source: string) {
  const processor = unified()
    .use(remarkParse)
    .use(remarkFrontmatter, ["yaml"])
    .use(remarkParseFrontmatter)
    .use(remarkGfm)
    .use(remarkDirective);

  const tree = processor.parse(source);
  const vfile = { data: {} };
  processor.runSync(tree, vfile);

  const frontmatter = (vfile.data as unknown as Record<string, unknown>)?.frontmatter ?? {};

  const doc: JxDocument = {};

  for (const [key, value] of Object.entries(frontmatter)) {
    doc[key] = value;
  }

  const bodyNodes = tree.children.filter(
    (n: MdastNode) => n.type !== "yaml" && n.type !== "toml",
  ) as unknown as MdastNode[];

  const children: (JxElement | string)[] = [];

  for (const node of bodyNodes) {
    const converted = mdastNodeToJx(node);
    if (converted == null) {
      continue;
    }
    if (Array.isArray(converted)) {
      children.push(...converted);
    } else {
      children.push(converted);
    }
  }

  if (children.length > 0) {
    doc.children = children;
  }

  return doc;
}
