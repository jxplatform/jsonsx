/**
 * Md-convert.js — Bidirectional mdast ↔ Jx conversion
 *
 * MdToJx(mdast) → Jx element tree (for loading into the canvas) jxToMd(jx) → mdast (for saving back
 * to markdown)
 *
 * JxDocToMd(doc) → Jx Markdown string (for saving Jx component documents back to .md)
 *
 * Both are pure tree transformations. The remark ecosystem handles all actual parsing and
 * serialization.
 */

import { unified } from "unified";
import remarkStringify from "remark-stringify";
import remarkDirective from "remark-directive";
import remarkGfm from "remark-gfm";
import { MD_ALL } from "./md-allowlist";
import { htmlToJx } from "@jxsuite/parser/transpile";

// ─── mdast → Jx ──────────────────────────────────────────────────────────

/**
 * Mdast node-type → Jx tagName mapping
 *
 * @type {Record<string, (n: MdastNode) => string>}
 */
const MDAST_TAG_MAP: Record<string, (n: MdastNode) => string> = {
  heading: (n: MdastNode) => `h${n.depth}`,
  paragraph: () => "p",
  text: () => "span",
  emphasis: () => "em",
  strong: () => "strong",
  delete: () => "del",
  inlineCode: () => "code",
  link: () => "a",
  image: () => "img",
  blockquote: () => "blockquote",
  list: (n: MdastNode) => (n.ordered ? "ol" : "ul"),
  listItem: () => "li",
  code: () => "pre",
  thematicBreak: () => "hr",
  table: () => "table",
  tableRow: () => "tr",
  tableCell: (n: MdastNode) => (n.isHeader ? "th" : "td"),
  break: () => "br",
};

/**
 * Convert an mdast tree to a Jx element tree.
 *
 * @param {MdastNode} mdast - Root mdast node (type: 'root')
 * @returns {JxElement} Jx element tree
 */
export function mdToJx(mdast: MdastNode) {
  if (mdast.type === "root") {
    return {
      children: (mdast.children ?? [])
        .filter((n: MdastNode) => n.type !== "yaml" && n.type !== "toml")
        .flatMap(convertMdastNode)
        .filter(Boolean) as (JxElement | string)[],
    };
  }
  return convertMdastNode(mdast) as JxElement;
}

/**
 * @param {MdastNode} node
 * @returns {JxElement | null}
 */
function convertMdastNode(node: MdastNode) {
  if (!node) return null;

  // Directive nodes → custom elements
  if (
    node.type === "containerDirective" ||
    node.type === "leafDirective" ||
    node.type === "textDirective"
  ) {
    return convertDirective(node);
  }

  if (node.type === "html") {
    if (!node.value) return null;
    const nodes = htmlToJx(node.value);
    return nodes.length === 1 ? (nodes[0] as JxElement) : { tagName: "div", children: nodes };
  }

  const tagFn = MDAST_TAG_MAP[node.type];
  if (!tagFn) return null;

  const tag = tagFn(node);
  const el: JxElement = { tagName: tag };

  switch (node.type) {
    case "heading":
    case "paragraph": {
      // If contains only a single text child, flatten to textContent
      if (node.children?.length === 1 && node.children[0].type === "text") {
        el.textContent = node.children[0].value;
      } else if (node.children?.length) {
        el.children = node.children.flatMap(convertMdastNode).filter(Boolean) as (
          | JxElement
          | string
        )[];
      }
      break;
    }

    case "text":
      el.textContent = node.value;
      break;

    case "emphasis":
    case "strong":
    case "delete": {
      if (node.children?.length === 1 && node.children[0].type === "text") {
        el.textContent = node.children[0].value;
      } else if (node.children?.length) {
        el.children = node.children.flatMap(convertMdastNode).filter(Boolean) as (
          | JxElement
          | string
        )[];
      }
      break;
    }

    case "inlineCode":
      el.textContent = node.value;
      break;

    case "link":
      el.attributes = { href: node.url ?? "" };
      if (node.title) el.attributes.title = node.title;
      if (node.children?.length === 1 && node.children[0].type === "text") {
        el.textContent = node.children[0].value;
      } else if (node.children?.length) {
        el.children = node.children.flatMap(convertMdastNode).filter(Boolean) as (
          | JxElement
          | string
        )[];
      }
      break;

    case "image":
      el.attributes = { src: node.url ?? "", alt: node.alt ?? "" };
      if (node.title) el.attributes.title = node.title;
      break;

    case "blockquote":
    case "listItem":
      if (node.children?.length) {
        el.children = node.children.flatMap(convertMdastNode).filter(Boolean) as (
          | JxElement
          | string
        )[];
      }
      break;

    case "list":
      if (node.children?.length) {
        el.children = node.children.flatMap(convertMdastNode).filter(Boolean) as (
          | JxElement
          | string
        )[];
      }
      if (node.start != null && node.start !== 1) {
        el.attributes = { start: String(node.start) };
      }
      break;

    case "code":
      // Fenced code → pre > code
      el.children = [
        {
          tagName: "code",
          textContent: node.value,
          ...(node.lang ? { attributes: { class: `language-${node.lang}` } } : {}),
        },
      ];
      break;

    case "thematicBreak":
    case "break":
      // Void elements — no content
      break;

    case "table": {
      // Mdast tables have rows directly; split into thead/tbody
      const rows = (node.children ?? []).flatMap(convertMdastNode).filter(Boolean) as JxElement[];
      const thead =
        rows.length > 0
          ? { tagName: "thead", children: [rows[0]] as (JxElement | string)[] }
          : null;
      const tbody =
        rows.length > 1
          ? { tagName: "tbody", children: rows.slice(1) as (JxElement | string)[] }
          : null;
      el.children = [thead, tbody].filter(Boolean) as (JxElement | string)[];
      break;
    }

    case "tableRow":
      if (node.children?.length) {
        el.children = node.children.flatMap(convertMdastNode).filter(Boolean) as (
          | JxElement
          | string
        )[];
      }
      break;

    case "tableCell":
      if (node.children?.length === 1 && node.children[0].type === "text") {
        el.textContent = node.children[0].value;
      } else if (node.children?.length) {
        el.children = node.children.flatMap(convertMdastNode).filter(Boolean) as (
          | JxElement
          | string
        )[];
      }
      break;
  }

  return el;
}

/**
 * @param {MdastNode} node
 * @returns {JxElement | null}
 */
function convertDirective(node: MdastNode) {
  const el: JxElement = { tagName: node.name };
  if (node.attributes && Object.keys(node.attributes).length > 0) {
    el.attributes = { ...node.attributes };
  }
  if (node.type === "textDirective") {
    // Text directives place label as textContent
    if (node.children?.length === 1 && node.children[0].type === "text") {
      el.textContent = node.children[0].value;
    } else if (node.children?.length) {
      el.children = node.children.flatMap(convertMdastNode).filter(Boolean) as (
        | JxElement
        | string
      )[];
    }
  } else if (node.type === "containerDirective" && node.children?.length) {
    el.children = node.children.flatMap(convertMdastNode).filter(Boolean) as (JxElement | string)[];
  }
  return el;
}

// ─── Jx → mdast ──────────────────────────────────────────────────────────

/**
 * Jx tagName → mdast node-type mapping (inverse of MDAST_TAG_MAP)
 *
 * @type {Record<string, string>}
 */
/** Tags whose content model is inline (phrasing content). */
const INLINE_CONTENT_TAGS = new Set([
  "p",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "em",
  "strong",
  "del",
  "a",
  "td",
  "th",
]);

const TAG_MDAST_MAP = {
  h1: "heading",
  h2: "heading",
  h3: "heading",
  h4: "heading",
  h5: "heading",
  h6: "heading",
  p: "paragraph",
  span: "text",
  em: "emphasis",
  strong: "strong",
  del: "delete",
  code: "inlineCode",
  a: "link",
  img: "image",
  blockquote: "blockquote",
  ul: "list",
  ol: "list",
  li: "listItem",
  pre: "code",
  hr: "thematicBreak",
  table: "table",
  tr: "tableRow",
  th: "tableCell",
  td: "tableCell",
  br: "break",
};

/**
 * Convert a Jx element tree to an mdast tree.
 *
 * @param {JxElement} jx - Jx element tree (root content div)
 * @returns {MdastNode} Mdast root node
 */
export function jxToMd(jx: JxElement) {
  const childArray = Array.isArray(jx.children) ? jx.children : ([] as (JxElement | string)[]);
  const children = childArray
    .map((child: JxElement | string) => convertJxNode(child, true))
    .filter(Boolean) as MdastNode[];

  return { type: "root", children };
}

/**
 * Check if a Jx element has extra properties beyond the standard mdast-compatible ones. Elements
 * with style, event handlers, state bindings, etc. need directive syntax.
 *
 * @param {JxElement} el
 * @returns {boolean}
 */
function hasJxProps(el: JxElement) {
  for (const key of Object.keys(el)) {
    if (
      key === "tagName" ||
      key === "children" ||
      key === "textContent" ||
      key === "innerHTML" ||
      key === "attributes"
    )
      continue;
    return true;
  }
  return false;
}

/**
 * Convert a single Jx element to an mdast node.
 *
 * @param {JxElement | string | number} el - Jx element
 * @param {boolean} isBlock - Whether this element is in a block context
 * @returns {MdastNode | null} Mdast node
 */
function convertJxNode(el: JxElement | string | number, isBlock: boolean): MdastNode | null {
  // Bare string/number text nodes → mdast text nodes
  if (typeof el === "string" || typeof el === "number") {
    return { type: "text", value: String(el) };
  }
  if (!el || typeof el !== "object") return null;

  const tag = el.tagName ?? "div";

  // If not in the markdown allowlist or has Jx-specific props, convert to directive
  if (!MD_ALL.has(tag) || hasJxProps(el)) {
    return convertToDirective(el, isBlock);
  }

  const mdastType = (TAG_MDAST_MAP as Record<string, string>)[tag];
  if (!mdastType) return null;

  switch (mdastType) {
    case "heading":
      return {
        type: "heading",
        depth: parseInt(tag.slice(1), 10),
        children: inlineChildren(el),
      };

    case "paragraph":
      return {
        type: "paragraph",
        children: inlineChildren(el),
      };

    case "text":
      return { type: "text", value: el.textContent ?? "" };

    case "emphasis":
    case "strong":
    case "delete":
      return {
        type: mdastType,
        children: inlineChildren(el),
      };

    case "inlineCode":
      return { type: "inlineCode", value: el.textContent ?? "" };

    case "link":
      return {
        type: "link",
        url: (el.attributes?.href as string) ?? "",
        title: (el.attributes?.title as string | null) ?? null,
        children: inlineChildren(el),
      };

    case "image":
      return {
        type: "image",
        url: (el.attributes?.src as string) ?? "",
        alt: (el.attributes?.alt as string) ?? "",
        title: (el.attributes?.title as string | null) ?? null,
      };

    case "blockquote":
      return {
        type: "blockquote",
        children: blockChildren(el),
      };

    case "list":
      return {
        type: "list",
        ordered: tag === "ol",
        start: tag === "ol" ? parseInt(el.attributes?.start as string, 10) || 1 : null,
        spread: false,
        children: ((el.children ?? []) as (JxElement | string)[])
          .map((c: JxElement | string) => convertJxNode(c, true))
          .filter(Boolean) as MdastNode[],
      };

    case "listItem":
      return {
        type: "listItem",
        spread: false,
        children: blockChildren(el),
      };

    case "code": {
      // pre > code → fenced code block
      const codeChild = Array.isArray(el.children)
        ? (el.children[0] as JxElement | undefined)
        : undefined;
      const langClass = (codeChild?.attributes?.class as string) ?? "";
      const lang = langClass.replace("language-", "") || null;
      return {
        type: "code",
        lang,
        value: codeChild?.textContent ?? el.textContent ?? "",
      };
    }

    case "thematicBreak":
      return { type: "thematicBreak" };

    case "break":
      return { type: "break" };

    case "table": {
      // Flatten thead/tbody back to rows
      const rows: MdastNode[] = [];
      for (const section of (el.children ?? []) as (JxElement | string)[]) {
        if (typeof section === "string") continue;
        if (section.tagName === "thead" || section.tagName === "tbody") {
          for (const row of (section.children ?? []) as (JxElement | string)[]) {
            const mdRow = convertJxNode(row, true);
            if (mdRow) {
              // Mark header cells
              if (section.tagName === "thead") {
                for (const cell of mdRow.children ?? []) {
                  cell.isHeader = true;
                }
              }
              rows.push(mdRow);
            }
          }
        }
      }
      return {
        type: "table",
        children: rows,
      };
    }

    case "tableRow":
      return {
        type: "tableRow",
        children: ((el.children ?? []) as (JxElement | string)[])
          .map((c: JxElement | string) => convertJxNode(c, false))
          .filter(Boolean) as MdastNode[],
      };

    case "tableCell":
      return {
        type: "tableCell",
        children: inlineChildren(el),
      };
  }

  return null;
}

/**
 * Get inline children from a Jx element as mdast nodes. Handles both textContent shorthand and
 * explicit children array.
 *
 * @param {JxElement} el
 * @returns {MdastNode[]}
 */
function inlineChildren(el: JxElement): MdastNode[] {
  if (el.textContent != null) {
    return [{ type: "text", value: String(el.textContent) }];
  }
  return ((el.children ?? []) as (JxElement | string)[])
    .map((c: JxElement | string) => convertJxNode(c, false))
    .filter(Boolean) as MdastNode[];
}

/**
 * Get block children from a Jx element as mdast nodes.
 *
 * @param {JxElement} el
 * @returns {MdastNode[]}
 */
function blockChildren(el: JxElement): MdastNode[] {
  if (el.textContent != null) {
    // Wrap bare text in a paragraph
    return [{ type: "paragraph", children: [{ type: "text", value: String(el.textContent) }] }];
  }
  return ((el.children ?? []) as (JxElement | string)[])
    .map((c: JxElement | string) => convertJxNode(c, true))
    .filter(Boolean) as MdastNode[];
}

/**
 * Collect all directive attributes from a Jx element. Merges Jx-specific properties (style, event
 * handlers, etc.) and HTML attributes into a flat dot-path attribute map suitable for
 * remark-directive.
 *
 * @param {JxElement} el
 * @returns {Record<string, string>}
 */
function collectDirectiveAttrs(el: JxElement) {
  const propsObj: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(el)) {
    if (
      key === "tagName" ||
      key === "children" ||
      key === "textContent" ||
      key === "innerHTML" ||
      key === "attributes"
    )
      continue;
    propsObj[key] = value;
  }

  // Merge HTML attributes
  if (el.attributes) {
    for (const [key, value] of Object.entries(el.attributes as Record<string, unknown>)) {
      propsObj[key] = value;
    }
  }

  return collapsePropsToAttrMap(propsObj);
}

/**
 * Convert a Jx element to a directive node, preserving all Jx-specific properties as collapsed
 * dot-path directive attributes.
 *
 * @param {JxElement} el
 * @param {boolean} isBlock
 * @returns {MdastNode}
 */
function convertToDirective(el: JxElement, isBlock: boolean): MdastNode {
  const tag = (el.tagName as string) ?? "div";
  const attrs = collectDirectiveAttrs(el);

  if (!isBlock) {
    // Inline → textDirective
    return {
      type: "textDirective",
      name: tag,
      attributes: attrs,
      children:
        el.textContent != null
          ? [{ type: "text", value: String(el.textContent) }]
          : (((el.children ?? []) as (JxElement | string)[])
              .map((c: JxElement | string) => convertJxNode(c, false))
              .filter(Boolean) as MdastNode[]),
    };
  }

  // Block without children → leafDirective
  const childArray = el.children as (JxElement | string)[] | undefined;
  if (!childArray?.length && el.textContent == null) {
    return {
      type: "leafDirective",
      name: tag,
      attributes: attrs,
      children: [],
    };
  }

  // Block with children → containerDirective
  /** @type {MdastNode[]} */
  let directiveChildren;
  if (el.textContent != null) {
    directiveChildren = [
      { type: "paragraph", children: [{ type: "text", value: String(el.textContent) }] },
    ];
  } else if (INLINE_CONTENT_TAGS.has(tag)) {
    // Tags with inline content model: wrap all children in a single paragraph
    // so remark serializes them as one continuous inline flow
    const inlineNodes = ((el.children ?? []) as (JxElement | string)[])
      .map((c: JxElement | string) => convertJxNode(c, false))
      .filter(Boolean) as MdastNode[];
    directiveChildren =
      inlineNodes.length > 0 ? [{ type: "paragraph", children: inlineNodes }] : [];
  } else {
    directiveChildren = ((el.children ?? []) as (JxElement | string)[])
      .map((c: JxElement | string) => convertJxNode(c, true))
      .filter(Boolean) as MdastNode[];
  }

  return {
    type: "containerDirective",
    name: tag,
    attributes: attrs,
    children: directiveChildren,
  };
}

// ─── Jx Document → Jx Markdown ─────────────────────────────────────────────

/** CSS pseudo-class names that need `:` stripped for markdown attributes. */
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

/** Jx `$`-prefixed keys that become unprefixed in directive attributes. */
const JX_DOLLAR_KEYS = new Set([
  "$prototype",
  "$ref",
  "$component",
  "$props",
  "$switch",
  "$elements",
]);

const JX_ANNOTATION_KEYS = new Set(["$title", "$description"]);

/**
 * Convert a Jx JSON document back to Jx Markdown source string.
 *
 * Inverse of `transpileJxMarkdown()` from @jxsuite/parser/transpile. Emits YAML frontmatter from
 * top-level props and uses remark-stringify with remark-directive for the body — standard markdown
 * elements emit as native syntax, Jx-decorated elements emit as directives.
 *
 * @param {JxMutableNode} doc - Jx JSON document
 * @returns {string} Jx Markdown source
 */
export function jxDocToMd(doc: JxMutableNode) {
  const { stringify: stringifyYaml } = yamlImport();

  const lines: string[] = [];

  // Emit YAML frontmatter
  const frontmatter: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(doc)) {
    if (key === "children") continue;
    frontmatter[key] = value;
  }

  if (Object.keys(frontmatter).length > 0) {
    lines.push("---");
    lines.push(stringifyYaml(frontmatter).trim());
    lines.push("---");
    lines.push("");
  }

  // Convert children to mdast and stringify with remark
  if (Array.isArray(doc.children) && doc.children.length > 0) {
    const mdastChildren = doc.children
      .map((child: JxMutableNode | string) => convertJxNode(child as JxElement | string, true))
      .filter(Boolean) as MdastNode[];

    const mdast = { type: "root", children: mdastChildren };
    const md = unified()
      .use(remarkGfm)
      .use(remarkDirective)
      .use(remarkStringify, { bullet: "-", emphasis: "*", strong: "*" })
      .stringify(mdast as unknown as import("mdast").Root);

    lines.push(/** @type {string} */ (md));
  }

  return (
    lines
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim() + "\n"
  );
}

/**
 * Lazy import of yaml stringify — avoids importing at module load.
 *
 * @returns {{ stringify: (v: unknown) => string }}
 */
let _yaml: { stringify: (v: unknown) => string } | null = null;
function yamlImport() {
  if (!_yaml) {
    // Dynamic require avoided; use the yaml package already available in studio
    _yaml = { stringify: yamlStringifySimple };
  }
  return _yaml;
}

/**
 * Simple YAML stringifier for frontmatter. Handles the subset of YAML needed for Jx frontmatter
 * (scalars, arrays, nested objects).
 *
 * @param {unknown} value
 * @param {number} indent
 * @returns {string}
 */
function yamlStringifySimple(value: unknown, indent: number = 0): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "boolean") return String(value);
  if (typeof value === "number") return String(value);
  if (typeof value === "string") {
    // Quote if it contains special characters
    if (/[:#[\]{}&*!|>'"%@`\n]/.test(value) || value === "" || value.trim() !== value) {
      return JSON.stringify(value);
    }
    return value;
  }

  const prefix = "  ".repeat(indent);

  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    return value
      .map((item) => {
        const itemStr: string = yamlStringifySimple(item, indent + 1);
        if (typeof item === "object" && item !== null && !Array.isArray(item)) {
          // Object items: first key on same line as -, rest indented
          const objLines: string[] = itemStr.split("\n");
          return `${prefix}- ${objLines[0]}\n${objLines
            .slice(1)
            .map((l: string) => `${prefix}  ${l}`)
            .join("\n")}`;
        }
        return `${prefix}- ${itemStr}`;
      })
      .join("\n");
  }

  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return "{}";
    return entries
      .map(([k, v]) => {
        const valStr: string = yamlStringifySimple(v, indent + 1);
        if (typeof v === "object" && v !== null) {
          return `${prefix}${k}:\n${valStr}`;
        }
        return `${prefix}${k}: ${valStr}`;
      })
      .join("\n");
  }

  return String(value);
}

/**
 * Collapse a Jx props object to a flat directive attribute map. Applies key mapping: strips `$`
 * from Jx keywords, `:` from pseudo-classes, `@` from media queries.
 *
 * @param {Record<string, unknown>} propsObj
 * @returns {Record<string, string>}
 */
function collapsePropsToAttrMap(propsObj: Record<string, unknown>) {
  const result: Record<string, string> = {};

  function walk(obj: Record<string, unknown>, prefix: string) {
    for (const [key, value] of Object.entries(obj)) {
      let mdAttrKey = key;
      // Strip $ prefix for Jx keywords
      if (JX_DOLLAR_KEYS.has(key)) {
        mdAttrKey = key.slice(1);
      }
      // Convert $title/$description to --title/--description
      if (JX_ANNOTATION_KEYS.has(key)) {
        mdAttrKey = `--${key.slice(1)}`;
      }
      // Strip : prefix for CSS pseudo-classes (inside style.* paths)
      if (key.startsWith(":") && CSS_PSEUDO_NAMES.has(key.slice(1))) {
        mdAttrKey = key.slice(1);
      }
      // Strip @ prefix for media queries (inside style.* paths)
      if (key === "@") {
        // Bare "@" (no media name) — treat contents as base-level style props
        if (value && typeof value === "object" && !Array.isArray(value)) {
          walk(value as Record<string, unknown>, prefix);
        }
        continue;
      }
      if (key.startsWith("@--")) {
        mdAttrKey = key.slice(1);
      }

      const fullKey = prefix ? `${prefix}.${mdAttrKey}` : mdAttrKey;

      if (value && typeof value === "object" && !Array.isArray(value)) {
        walk(value as Record<string, unknown>, fullKey);
      } else {
        result[fullKey] = String(value);
      }
    }
  }

  walk(propsObj, "");
  return result;
}
