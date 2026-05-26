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
import { MD_ALL } from "./md-allowlist.js";
import { htmlToJx } from "@jxsuite/parser/transpile";

// ─── mdast → Jx ──────────────────────────────────────────────────────────

/**
 * Mdast node-type → Jx tagName mapping
 *
 * @type {Record<string, (n: MdastNode) => string>}
 */
const MDAST_TAG_MAP = {
  heading: (/** @type {MdastNode} */ n) => `h${n.depth}`,
  paragraph: () => "p",
  text: () => "span",
  emphasis: () => "em",
  strong: () => "strong",
  delete: () => "del",
  inlineCode: () => "code",
  link: () => "a",
  image: () => "img",
  blockquote: () => "blockquote",
  list: (/** @type {MdastNode} */ n) => (n.ordered ? "ol" : "ul"),
  listItem: () => "li",
  code: () => "pre",
  thematicBreak: () => "hr",
  table: () => "table",
  tableRow: () => "tr",
  tableCell: (/** @type {MdastNode} */ n) => (n.isHeader ? "th" : "td"),
  break: () => "br",
};

/**
 * Convert an mdast tree to a Jx element tree.
 *
 * @param {MdastNode} mdast - Root mdast node (type: 'root')
 * @returns {JxElement} Jx element tree
 */
export function mdToJx(mdast) {
  if (mdast.type === "root") {
    return {
      children: /** @type {(JxElement | string)[]} */ (
        (mdast.children ?? [])
          .filter((/** @type {MdastNode} */ n) => n.type !== "yaml" && n.type !== "toml")
          .flatMap(convertMdastNode)
          .filter(Boolean)
      ),
    };
  }
  return /** @type {JxElement} */ (convertMdastNode(mdast));
}

/**
 * @param {MdastNode} node
 * @returns {JxElement | null}
 */
function convertMdastNode(node) {
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
    return nodes.length === 1
      ? /** @type {JxElement} */ (nodes[0])
      : { tagName: "div", children: nodes };
  }

  const tagFn = MDAST_TAG_MAP[node.type];
  if (!tagFn) return null;

  const tag = tagFn(node);
  /** @type {JxElement} */
  const el = { tagName: tag };

  switch (node.type) {
    case "heading":
    case "paragraph": {
      // If contains only a single text child, flatten to textContent
      if (node.children?.length === 1 && node.children[0].type === "text") {
        el.textContent = node.children[0].value;
      } else if (node.children?.length) {
        el.children = /** @type {(JxElement | string)[]} */ (
          node.children.flatMap(convertMdastNode).filter(Boolean)
        );
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
        el.children = /** @type {(JxElement | string)[]} */ (
          node.children.flatMap(convertMdastNode).filter(Boolean)
        );
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
        el.children = /** @type {(JxElement | string)[]} */ (
          node.children.flatMap(convertMdastNode).filter(Boolean)
        );
      }
      break;

    case "image":
      el.attributes = { src: node.url ?? "", alt: node.alt ?? "" };
      if (node.title) el.attributes.title = node.title;
      break;

    case "blockquote":
    case "listItem":
      if (node.children?.length) {
        el.children = /** @type {(JxElement | string)[]} */ (
          node.children.flatMap(convertMdastNode).filter(Boolean)
        );
      }
      break;

    case "list":
      if (node.children?.length) {
        el.children = /** @type {(JxElement | string)[]} */ (
          node.children.flatMap(convertMdastNode).filter(Boolean)
        );
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
      const rows = /** @type {JxElement[]} */ (
        (node.children ?? []).flatMap(convertMdastNode).filter(Boolean)
      );
      const thead =
        rows.length > 0
          ? { tagName: "thead", children: /** @type {(JxElement | string)[]} */ ([rows[0]]) }
          : null;
      const tbody =
        rows.length > 1
          ? { tagName: "tbody", children: /** @type {(JxElement | string)[]} */ (rows.slice(1)) }
          : null;
      el.children = /** @type {(JxElement | string)[]} */ ([thead, tbody].filter(Boolean));
      break;
    }

    case "tableRow":
      if (node.children?.length) {
        el.children = /** @type {(JxElement | string)[]} */ (
          node.children.flatMap(convertMdastNode).filter(Boolean)
        );
      }
      break;

    case "tableCell":
      if (node.children?.length === 1 && node.children[0].type === "text") {
        el.textContent = node.children[0].value;
      } else if (node.children?.length) {
        el.children = /** @type {(JxElement | string)[]} */ (
          node.children.flatMap(convertMdastNode).filter(Boolean)
        );
      }
      break;
  }

  return el;
}

/**
 * @param {MdastNode} node
 * @returns {JxElement | null}
 */
function convertDirective(node) {
  /** @type {JxElement} */
  const el = { tagName: node.name };
  if (node.attributes && Object.keys(node.attributes).length > 0) {
    el.attributes = { ...node.attributes };
  }
  if (node.type === "textDirective") {
    // Text directives place label as textContent
    if (node.children?.length === 1 && node.children[0].type === "text") {
      el.textContent = node.children[0].value;
    } else if (node.children?.length) {
      el.children = /** @type {(JxElement | string)[]} */ (
        node.children.flatMap(convertMdastNode).filter(Boolean)
      );
    }
  } else if (node.type === "containerDirective" && node.children?.length) {
    el.children = /** @type {(JxElement | string)[]} */ (
      node.children.flatMap(convertMdastNode).filter(Boolean)
    );
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
export function jxToMd(jx) {
  const childArray = /** @type {(JxElement | string)[]} */ (
    Array.isArray(jx.children) ? jx.children : []
  );
  const children = /** @type {MdastNode[]} */ (
    childArray
      .map((/** @type {JxElement | string} */ child) => convertJxNode(child, true))
      .filter(Boolean)
  );

  return { type: "root", children };
}

/**
 * Check if a Jx element has extra properties beyond the standard mdast-compatible ones. Elements
 * with style, event handlers, state bindings, etc. need directive syntax.
 *
 * @param {JxElement} el
 * @returns {boolean}
 */
function hasJxProps(el) {
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
function convertJxNode(el, isBlock) {
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

  const mdastType = /** @type {Record<string, string>} */ (TAG_MDAST_MAP)[tag];
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
        url: /** @type {string} */ (el.attributes?.href) ?? "",
        title: /** @type {string | null} */ (el.attributes?.title) ?? null,
        children: inlineChildren(el),
      };

    case "image":
      return {
        type: "image",
        url: /** @type {string} */ (el.attributes?.src) ?? "",
        alt: /** @type {string} */ (el.attributes?.alt) ?? "",
        title: /** @type {string | null} */ (el.attributes?.title) ?? null,
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
        start:
          tag === "ol" ? parseInt(/** @type {string} */ (el.attributes?.start), 10) || 1 : null,
        spread: false,
        children: /** @type {MdastNode[]} */ (
          /** @type {(JxElement | string)[]} */ (el.children ?? [])
            .map((/** @type {JxElement | string} */ c) => convertJxNode(c, true))
            .filter(Boolean)
        ),
      };

    case "listItem":
      return {
        type: "listItem",
        spread: false,
        children: blockChildren(el),
      };

    case "code": {
      // pre > code → fenced code block
      const codeChild = /** @type {JxElement | undefined} */ (
        Array.isArray(el.children) ? el.children[0] : undefined
      );
      const langClass = /** @type {string} */ (codeChild?.attributes?.class) ?? "";
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
      /** @type {MdastNode[]} */
      const rows = [];
      for (const section of /** @type {(JxElement | string)[]} */ (el.children ?? [])) {
        if (typeof section === "string") continue;
        if (section.tagName === "thead" || section.tagName === "tbody") {
          for (const row of /** @type {(JxElement | string)[]} */ (section.children ?? [])) {
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
        children: /** @type {MdastNode[]} */ (
          /** @type {(JxElement | string)[]} */ (el.children ?? [])
            .map((/** @type {JxElement | string} */ c) => convertJxNode(c, false))
            .filter(Boolean)
        ),
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
function inlineChildren(el) {
  if (el.textContent != null) {
    return [{ type: "text", value: String(el.textContent) }];
  }
  return /** @type {MdastNode[]} */ (
    /** @type {(JxElement | string)[]} */ (el.children ?? [])
      .map((/** @type {JxElement | string} */ c) => convertJxNode(c, false))
      .filter(Boolean)
  );
}

/**
 * Get block children from a Jx element as mdast nodes.
 *
 * @param {JxElement} el
 * @returns {MdastNode[]}
 */
function blockChildren(el) {
  if (el.textContent != null) {
    // Wrap bare text in a paragraph
    return [{ type: "paragraph", children: [{ type: "text", value: String(el.textContent) }] }];
  }
  return /** @type {MdastNode[]} */ (
    /** @type {(JxElement | string)[]} */ (el.children ?? [])
      .map((/** @type {JxElement | string} */ c) => convertJxNode(c, true))
      .filter(Boolean)
  );
}

/**
 * Collect all directive attributes from a Jx element. Merges Jx-specific properties (style, event
 * handlers, etc.) and HTML attributes into a flat dot-path attribute map suitable for
 * remark-directive.
 *
 * @param {JxElement} el
 * @returns {Record<string, string>}
 */
function collectDirectiveAttrs(el) {
  /** @type {Record<string, unknown>} */
  const propsObj = {};

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
    for (const [key, value] of Object.entries(
      /** @type {Record<string, unknown>} */ (el.attributes),
    )) {
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
function convertToDirective(el, isBlock) {
  const tag = /** @type {string} */ (el.tagName) ?? "div";
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
          : /** @type {MdastNode[]} */ (
              /** @type {(JxElement | string)[]} */ (el.children ?? [])
                .map((/** @type {JxElement | string} */ c) => convertJxNode(c, false))
                .filter(Boolean)
            ),
    };
  }

  // Block without children → leafDirective
  const childArray = /** @type {(JxElement | string)[] | undefined} */ (el.children);
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
    const inlineNodes = /** @type {MdastNode[]} */ (
      /** @type {(JxElement | string)[]} */ (el.children ?? [])
        .map((/** @type {JxElement | string} */ c) => convertJxNode(c, false))
        .filter(Boolean)
    );
    directiveChildren =
      inlineNodes.length > 0 ? [{ type: "paragraph", children: inlineNodes }] : [];
  } else {
    directiveChildren = /** @type {MdastNode[]} */ (
      /** @type {(JxElement | string)[]} */ (el.children ?? [])
        .map((/** @type {JxElement | string} */ c) => convertJxNode(c, true))
        .filter(Boolean)
    );
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
export function jxDocToMd(doc) {
  const { stringify: stringifyYaml } = yamlImport();

  /** @type {string[]} */
  const lines = [];

  // Emit YAML frontmatter
  /** @type {Record<string, unknown>} */
  const frontmatter = {};
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
    const mdastChildren = /** @type {MdastNode[]} */ (
      doc.children
        .map((/** @type {JxMutableNode | string} */ child) =>
          convertJxNode(/** @type {JxElement | string} */ (child), true),
        )
        .filter(Boolean)
    );

    const mdast = { type: "root", children: mdastChildren };
    const md = unified()
      .use(remarkDirective)
      .use(remarkStringify, { bullet: "-", emphasis: "*", strong: "*" })
      .stringify(/** @type {any} */ (mdast));

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
let _yaml = /** @type {{ stringify: (v: unknown) => string } | null} */ (null);
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
function yamlStringifySimple(value, indent = 0) {
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
        const itemStr = yamlStringifySimple(item, indent + 1);
        if (typeof item === "object" && item !== null && !Array.isArray(item)) {
          // Object items: first key on same line as -, rest indented
          const objLines = itemStr.split("\n");
          return `${prefix}- ${objLines[0]}\n${objLines
            .slice(1)
            .map((l) => `${prefix}  ${l}`)
            .join("\n")}`;
        }
        return `${prefix}- ${itemStr}`;
      })
      .join("\n");
  }

  if (typeof value === "object") {
    const entries = Object.entries(/** @type {Record<string, unknown>} */ (value));
    if (entries.length === 0) return "{}";
    return entries
      .map(([k, v]) => {
        const valStr = yamlStringifySimple(v, indent + 1);
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
function collapsePropsToAttrMap(propsObj) {
  /** @type {Record<string, string>} */
  const result = {};

  function walk(/** @type {Record<string, unknown>} */ obj, /** @type {string} */ prefix) {
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
      if (key.startsWith("@--")) {
        mdAttrKey = key.slice(1);
      }

      const fullKey = prefix ? `${prefix}.${mdAttrKey}` : mdAttrKey;

      if (value && typeof value === "object" && !Array.isArray(value)) {
        walk(/** @type {Record<string, unknown>} */ (value), fullKey);
      } else {
        result[fullKey] = String(value);
      }
    }
  }

  walk(propsObj, "");
  return result;
}
