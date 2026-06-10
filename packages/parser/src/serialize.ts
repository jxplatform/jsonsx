/**
 * Jx Markdown Serializer — Browser-safe module
 *
 * The single Jx → markdown serializer, replacing the studio's md-convert and the
 * compiler's compile-markdown. Two modes over a shared tag map:
 *
 * - `roundtrip` (default) — lossless: YAML frontmatter from non-children doc keys,
 *   non-markdown elements emitted as remark directives with collapsed dot-path
 *   attributes. Inverse of `transpileJxMarkdown()`.
 * - `export` — lossy: strips all Jx decoration, unwraps wrapper tags, inlines custom
 *   elements via injected component definitions, evaluates template strings via
 *   injected hooks. Produces clean GFM with no directives or frontmatter.
 *
 * Template evaluation is injected (the compiler passes its static-template evaluator)
 * so this module stays free of compiler dependencies and browser-safe.
 *
 * @module @jxsuite/parser/serialize
 * @license MIT
 */

import { unified } from "unified";
import remarkStringify from "remark-stringify";
import remarkDirective from "remark-directive";
import remarkGfm from "remark-gfm";
import { stringify as stringifyYaml } from "yaml";
import { htmlToJx } from "./html-to-jx.ts";
import type {
  JxElement,
  JxDocument,
  JxStateDefinition,
  JxMutableNode,
} from "@jxsuite/schema/types";
import type { MdastNode } from "./types.ts";

// ─── Markdown element sets ──────────────────────────────────────────────────
// Source of truth for the `$studio.elements` block in Markdown.class.json — a parser
// test asserts the two stay in sync.

export const MD_ELEMENTS = {
  block: [
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "p",
    "blockquote",
    "ul",
    "ol",
    "li",
    "pre",
    "hr",
    "table",
    "thead",
    "tbody",
    "tr",
    "th",
    "td",
  ],
  inline: ["em", "strong", "del", "code", "a", "img", "br"],
  void: ["hr", "br", "img"],
  textOnly: ["code"],
  nesting: {
    _root: { block: true, inline: false, directive: true },
    h1: { block: false, inline: true, directive: false },
    h2: { block: false, inline: true, directive: false },
    h3: { block: false, inline: true, directive: false },
    h4: { block: false, inline: true, directive: false },
    h5: { block: false, inline: true, directive: false },
    h6: { block: false, inline: true, directive: false },
    p: { block: false, inline: true, directive: true },
    blockquote: { block: true, inline: false, directive: true },
    ul: { only: ["li"] },
    ol: { only: ["li"] },
    li: { block: true, inline: true, directive: true },
    pre: { only: ["code"] },
    table: { only: ["thead", "tbody"] },
    thead: { only: ["tr"] },
    tbody: { only: ["tr"] },
    tr: { only: ["th", "td"] },
    th: { block: false, inline: true, directive: false },
    td: { block: false, inline: true, directive: false },
    em: { block: false, inline: true, directive: false },
    strong: { block: false, inline: true, directive: false },
    del: { block: false, inline: true, directive: false },
    a: { block: false, inline: true, directive: false },
  } as Record<string, { block?: boolean; inline?: boolean; directive?: boolean; only?: string[] }>,
} as const;

/** Markdown-native block tags. */
export const MD_BLOCK: ReadonlySet<string> = new Set(MD_ELEMENTS.block);
/** Markdown-native inline tags. */
export const MD_INLINE: ReadonlySet<string> = new Set(MD_ELEMENTS.inline);
/** All markdown-native tags — everything else serializes as a directive. */
export const MD_ALL: ReadonlySet<string> = new Set([...MD_ELEMENTS.block, ...MD_ELEMENTS.inline]);
/** Tags that cannot contain children. */
export const MD_VOID: ReadonlySet<string> = new Set(MD_ELEMENTS.void);
/** Tags that contain only text. */
export const MD_TEXT_ONLY: ReadonlySet<string> = new Set(MD_ELEMENTS.textOnly);

// ─── Shared tag maps ────────────────────────────────────────────────────────

/** Jx tagName → mdast node-type. */
const TAG_MDAST_MAP: Record<string, string> = {
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
  br: "break",
  table: "table",
  thead: "thead",
  tbody: "tbody",
  tr: "tableRow",
  th: "tableCell",
  td: "tableCell",
};

/** Wrapper tags unwrapped in export mode — their children are promoted. */
const WRAPPER_TAGS = new Set([
  "div",
  "section",
  "span",
  "nav",
  "header",
  "footer",
  "main",
  "article",
  "aside",
  "figure",
  "figcaption",
  "slot",
]);

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

function isInlineType(type: string) {
  return ["text", "emphasis", "strong", "delete", "inlineCode", "link", "image", "break"].includes(
    type,
  );
}

/** Read a fenced-code child's language. Canonical: `className`; legacy: `attributes.class`. */
function codeLang(codeChild: JxElement | undefined): string | null {
  const cls = codeChild?.className ?? (codeChild?.attributes?.class as string | undefined) ?? "";
  const lang = String(cls).replace("language-", "");
  return lang || null;
}

// ─── Options ────────────────────────────────────────────────────────────────

export interface SerializeOptions {
  /** `roundtrip` (lossless, default) or `export` (lossy clean markdown). */
  mode?: "roundtrip" | "export";
  /** Export mode: component definitions for inlining custom elements. */
  componentDefs?: Map<string, JxElement>;
  /**
   * Export mode: evaluate a template string against a scope. Return `undefined` to keep the
   * original string. Hosts inject their own evaluator (the compiler passes its static-template
   * machinery); default keeps templates verbatim.
   */
  evaluateTemplate?: (value: string, scope: Record<string, unknown>) => unknown;
  /** Export mode: build an evaluation scope from state definitions. */
  buildScope?: (state: Record<string, JxStateDefinition>) => Record<string, unknown> | null;
  /** Roundtrip mode: markdown-native tag set; anything else becomes a directive. */
  allowlist?: ReadonlySet<string> | string[];
  /** Roundtrip mode: emit YAML frontmatter from non-children doc keys (default true). */
  frontmatter?: boolean;
}

// ═════════════════════════════════════════════════════════════════════════════
// Roundtrip mode — mdast ↔ Jx (lossless, directive fallback)
// ═════════════════════════════════════════════════════════════════════════════

/** Mdast node-type → Jx tagName mapping (canvas-targeted; text → span). */
const MDAST_TAG_MAP: Record<string, (n: MdastNode) => string> = {
  heading: (n) => `h${n.depth}`,
  paragraph: () => "p",
  text: () => "span",
  emphasis: () => "em",
  strong: () => "strong",
  delete: () => "del",
  inlineCode: () => "code",
  link: () => "a",
  image: () => "img",
  blockquote: () => "blockquote",
  list: (n) => (n.ordered ? "ol" : "ul"),
  listItem: () => "li",
  code: () => "pre",
  thematicBreak: () => "hr",
  table: () => "table",
  tableRow: () => "tr",
  tableCell: (n) => (n.isHeader ? "th" : "td"),
  break: () => "br",
};

/**
 * Convert an mdast tree to a Jx element tree (canvas-targeted: text nodes become spans). Inverse of
 * {@link jxToMdast}.
 */
export function mdastToJx(mdast: MdastNode): JxElement {
  if (mdast.type === "root") {
    return {
      children: (mdast.children ?? [])
        .filter((n) => n.type !== "yaml" && n.type !== "toml")
        .flatMap(convertMdastNode)
        .filter(Boolean) as (JxElement | string)[],
    };
  }
  return convertMdastNode(mdast) as JxElement;
}

function convertMdastNode(node: MdastNode): JxElement | null {
  if (!node) return null;

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

  const childNodes = () =>
    (node.children ?? []).flatMap(convertMdastNode).filter(Boolean) as (JxElement | string)[];
  const flattenOrChildren = () => {
    if (node.children?.length === 1 && node.children[0].type === "text") {
      el.textContent = node.children[0].value ?? null;
    } else if (node.children?.length) {
      el.children = childNodes();
    }
  };

  switch (node.type) {
    case "heading":
    case "paragraph":
    case "emphasis":
    case "strong":
    case "delete":
    case "tableCell":
      flattenOrChildren();
      break;

    case "text":
    case "inlineCode":
      el.textContent = node.value ?? null;
      break;

    case "link":
      el.attributes = { href: node.url ?? "" };
      if (node.title) el.attributes.title = node.title;
      flattenOrChildren();
      break;

    case "image":
      el.attributes = { src: node.url ?? "", alt: node.alt ?? "" };
      if (node.title) el.attributes.title = node.title;
      break;

    case "blockquote":
    case "listItem":
    case "tableRow":
      if (node.children?.length) el.children = childNodes();
      break;

    case "list":
      if (node.children?.length) el.children = childNodes();
      if (node.start != null && node.start !== 1) {
        el.attributes = { start: String(node.start) };
      }
      break;

    case "code":
      el.children = [
        {
          tagName: "code",
          textContent: node.value ?? null,
          ...(node.lang ? { className: `language-${node.lang}` } : {}),
        },
      ];
      break;

    case "thematicBreak":
    case "break":
      break;

    case "table": {
      const rows = childNodes() as JxElement[];
      const thead =
        rows.length > 0
          ? { tagName: "thead", children: [rows[0]] as (JxElement | string)[] }
          : null;
      const tbody =
        rows.length > 1
          ? {
              tagName: "tbody",
              children: rows.slice(1) as (JxElement | string)[],
            }
          : null;
      el.children = [thead, tbody].filter(Boolean) as (JxElement | string)[];
      break;
    }
  }

  return el;
}

function convertDirective(node: MdastNode): JxElement {
  const el: JxElement = { tagName: node.name ?? "div" };
  if (node.attributes && Object.keys(node.attributes).length > 0) {
    el.attributes = { ...node.attributes };
  }
  if (node.type === "textDirective") {
    if (node.children?.length === 1 && node.children[0].type === "text") {
      el.textContent = node.children[0].value ?? null;
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

// ─── Roundtrip: Jx → mdast ───────────────────────────────────────────────────

/**
 * Convert a Jx element tree to an mdast tree (lossless: non-markdown elements become directives).
 * Inverse of {@link mdastToJx}.
 */
export function jxToMdast(jx: JxElement, opts: SerializeOptions = {}): MdastNode {
  const allowlist = normalizeAllowlist(opts.allowlist);
  const childArray = Array.isArray(jx.children) ? jx.children : ([] as (JxElement | string)[]);
  const children = childArray
    .map((child) => convertJxNode(child, true, allowlist))
    .filter(Boolean) as MdastNode[];

  return { type: "root", children };
}

function normalizeAllowlist(allowlist?: ReadonlySet<string> | string[]): ReadonlySet<string> {
  if (!allowlist) return MD_ALL;
  return allowlist instanceof Set ? allowlist : new Set(allowlist);
}

/** Check if a Jx element has properties beyond the mdast-compatible ones. */
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

function convertJxNode(
  el: JxElement | string | number,
  isBlock: boolean,
  allowlist: ReadonlySet<string>,
): MdastNode | null {
  if (typeof el === "string" || typeof el === "number") {
    return { type: "text", value: String(el) };
  }
  if (!el || typeof el !== "object") return null;

  const tag = el.tagName ?? "div";

  // Not markdown-native or carries Jx-specific props → directive
  if (!allowlist.has(tag) || hasJxProps(el)) {
    return convertToDirective(el, isBlock, allowlist);
  }

  const mdastType = TAG_MDAST_MAP[tag];
  if (!mdastType) return null;

  const inline = (e: JxElement): MdastNode[] => {
    if (e.textContent != null) return [{ type: "text", value: String(e.textContent) }];
    return ((e.children ?? []) as (JxElement | string)[])
      .map((c) => convertJxNode(c, false, allowlist))
      .filter(Boolean) as MdastNode[];
  };
  const block = (e: JxElement): MdastNode[] => {
    if (e.textContent != null) {
      return [
        {
          type: "paragraph",
          children: [{ type: "text", value: String(e.textContent) }],
        },
      ];
    }
    return ((e.children ?? []) as (JxElement | string)[])
      .map((c) => convertJxNode(c, true, allowlist))
      .filter(Boolean) as MdastNode[];
  };

  switch (mdastType) {
    case "heading":
      return {
        type: "heading",
        depth: parseInt(tag.slice(1), 10),
        children: inline(el),
      };

    case "paragraph":
      return { type: "paragraph", children: inline(el) };

    case "text":
      return { type: "text", value: el.textContent ?? "" };

    case "emphasis":
    case "strong":
    case "delete":
      return { type: mdastType, children: inline(el) };

    case "inlineCode":
      return { type: "inlineCode", value: el.textContent ?? "" };

    case "link":
      return {
        type: "link",
        url: (el.attributes?.href as string) ?? "",
        title: (el.attributes?.title as string | null) ?? null,
        children: inline(el),
      };

    case "image":
      return {
        type: "image",
        url: (el.attributes?.src as string) ?? "",
        alt: (el.attributes?.alt as string) ?? "",
        title: (el.attributes?.title as string | null) ?? null,
      };

    case "blockquote":
      return { type: "blockquote", children: block(el) };

    case "list":
      return {
        type: "list",
        ordered: tag === "ol",
        start: tag === "ol" ? parseInt(el.attributes?.start as string, 10) || 1 : null,
        spread: false,
        children: ((el.children ?? []) as (JxElement | string)[])
          .map((c) => convertJxNode(c, true, allowlist))
          .filter(Boolean) as MdastNode[],
      };

    case "listItem":
      return { type: "listItem", spread: false, children: block(el) };

    case "code": {
      const codeChild = Array.isArray(el.children)
        ? (el.children[0] as JxElement | undefined)
        : undefined;
      return {
        type: "code",
        lang: codeLang(codeChild),
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
            const mdRow = convertJxNode(row, true, allowlist);
            if (mdRow) {
              if (section.tagName === "thead") {
                for (const cell of mdRow.children ?? []) cell.isHeader = true;
              }
              rows.push(mdRow);
            }
          }
        }
      }
      return { type: "table", children: rows };
    }

    case "tableRow":
      return {
        type: "tableRow",
        children: ((el.children ?? []) as (JxElement | string)[])
          .map((c) => convertJxNode(c, false, allowlist))
          .filter(Boolean) as MdastNode[],
      };

    case "tableCell":
      return { type: "tableCell", children: inline(el) };
  }

  return null;
}

// ─── Roundtrip: directive emission ───────────────────────────────────────────

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

function collectDirectiveAttrs(el: JxElement) {
  const propsObj: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(el)) {
    if (key === "tagName" || key === "textContent" || key === "innerHTML" || key === "attributes")
      continue;
    if (key === "children") {
      if (value && typeof value === "object" && !Array.isArray(value)) {
        propsObj.children = value;
      }
      continue;
    }
    propsObj[key] = value;
  }

  if (el.attributes) {
    for (const [key, value] of Object.entries(el.attributes as Record<string, unknown>)) {
      propsObj[key] = value;
    }
  }

  return collapsePropsToAttrMap(propsObj);
}

function convertToDirective(
  el: JxElement,
  isBlock: boolean,
  allowlist: ReadonlySet<string>,
): MdastNode {
  const tag = (el.tagName as string) ?? "div";
  const attrs = collectDirectiveAttrs(el);

  if (!isBlock) {
    return {
      type: "textDirective",
      name: tag,
      attributes: attrs,
      children:
        el.textContent != null
          ? [{ type: "text", value: String(el.textContent) }]
          : (((el.children ?? []) as (JxElement | string)[])
              .map((c) => convertJxNode(c, false, allowlist))
              .filter(Boolean) as MdastNode[]),
    };
  }

  const rawChildren = el.children;
  const childrenIsObject =
    rawChildren && typeof rawChildren === "object" && !Array.isArray(rawChildren);
  const childArray = childrenIsObject
    ? undefined
    : (rawChildren as (JxElement | string)[] | undefined);
  if (!childArray?.length && el.textContent == null) {
    return {
      type: "leafDirective",
      name: tag,
      attributes: attrs,
      children: [],
    };
  }

  let directiveChildren: MdastNode[];
  if (el.textContent != null) {
    directiveChildren = [
      {
        type: "paragraph",
        children: [{ type: "text", value: String(el.textContent) }],
      },
    ];
  } else if (INLINE_CONTENT_TAGS.has(tag)) {
    // Inline content model: wrap children in one paragraph for continuous flow
    const inlineNodes = ((el.children ?? []) as (JxElement | string)[])
      .map((c) => convertJxNode(c, false, allowlist))
      .filter(Boolean) as MdastNode[];
    directiveChildren =
      inlineNodes.length > 0 ? [{ type: "paragraph", children: inlineNodes }] : [];
  } else {
    directiveChildren = ((el.children ?? []) as (JxElement | string)[])
      .map((c) => convertJxNode(c, true, allowlist))
      .filter(Boolean) as MdastNode[];
  }

  return {
    type: "containerDirective",
    name: tag,
    attributes: attrs,
    children: directiveChildren,
  };
}

function collapsePropsToAttrMap(propsObj: Record<string, unknown>) {
  const result: Record<string, string> = {};

  function walk(obj: Record<string, unknown>, prefix: string) {
    for (const [key, value] of Object.entries(obj)) {
      let mdAttrKey = key;
      if (JX_DOLLAR_KEYS.has(key)) {
        mdAttrKey = key.slice(1);
      }
      if (JX_ANNOTATION_KEYS.has(key)) {
        mdAttrKey = `--${key.slice(1)}`;
      }
      if (key.startsWith(":") && CSS_PSEUDO_NAMES.has(key.slice(1))) {
        mdAttrKey = key.slice(1);
      }
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

// ═════════════════════════════════════════════════════════════════════════════
// Export mode — clean markdown (lossy, no directives)
// ═════════════════════════════════════════════════════════════════════════════

interface ExportContext {
  componentDefs: Map<string, JxElement>;
  evaluateTemplate?: SerializeOptions["evaluateTemplate"];
  buildScope?: SerializeOptions["buildScope"];
}

function nodeToMdast(
  node: JxElement | string,
  ctx: ExportContext,
  scope?: Record<string, unknown> | null,
): MdastNode[] {
  if (typeof node === "string") {
    return node.trim() ? [{ type: "text", value: node }] : [];
  }
  if (typeof node === "number") {
    return [{ type: "text", value: String(node) }];
  }
  if (!node || typeof node !== "object") return [];

  // Array descriptor — expand mapped arrays
  if (node.$prototype === "Array") {
    return expandArray(node, ctx, scope);
  }

  const tag = node.tagName ?? "div";
  const text = resolveText(node.textContent, ctx, scope);

  // innerHTML — convert HTML content to mdast
  if (typeof node.innerHTML === "string" && node.innerHTML.trim()) {
    const htmlNodes = htmlToMdast(node.innerHTML);
    if (htmlNodes.length > 0) return htmlNodes;
  }

  // Custom elements — inline component content
  if (tag.includes("-")) {
    return inlineComponent(node, tag, ctx);
  }

  // Wrapper tags — unwrap, promote children
  if (WRAPPER_TAGS.has(tag)) {
    if (text != null) {
      return text.trim() ? [{ type: "paragraph", children: [{ type: "text", value: text }] }] : [];
    }
    return exportChildren(node, ctx, scope);
  }

  const mdastType = TAG_MDAST_MAP[tag];
  if (!mdastType) {
    if (text != null) {
      return text.trim() ? [{ type: "paragraph", children: [{ type: "text", value: text }] }] : [];
    }
    return exportChildren(node, ctx, scope);
  }

  switch (mdastType) {
    case "heading": {
      const depth = parseInt(tag.slice(1), 10);
      const children =
        text != null ? [{ type: "text", value: text }] : exportChildren(node, ctx, scope);
      return [{ type: "heading", depth, children }];
    }

    case "paragraph": {
      const children =
        text != null ? [{ type: "text", value: text }] : exportChildren(node, ctx, scope);
      if (children.length === 0) return [];
      return [{ type: "paragraph", children }];
    }

    case "emphasis":
    case "strong":
    case "delete": {
      const children =
        text != null ? [{ type: "text", value: text }] : exportChildren(node, ctx, scope);
      return [{ type: mdastType, children }];
    }

    case "inlineCode":
      return [{ type: "inlineCode", value: text ?? "" }];

    case "link": {
      const href = String(node.attributes?.href ?? "");
      const title = (node.attributes?.title as string | null) ?? null;
      const children =
        text != null ? [{ type: "text", value: text }] : exportChildren(node, ctx, scope);
      return [{ type: "link", url: href, title, children }];
    }

    case "image": {
      const src = String(node.attributes?.src ?? "");
      const alt = String(node.attributes?.alt ?? "");
      const title = (node.attributes?.title as string | null) ?? null;
      return [{ type: "image", url: src, alt, title }];
    }

    case "blockquote": {
      const children = exportChildren(node, ctx, scope);
      const wrapped = children.map((c) =>
        c.type === "text" ? { type: "paragraph", children: [c] } : c,
      );
      return [{ type: "blockquote", children: wrapped }];
    }

    case "list": {
      const ordered = tag === "ol";
      const children = exportChildren(node, ctx, scope);
      const items = children.filter((c) => c.type === "listItem");
      if (items.length === 0) return [];
      return [{ type: "list", ordered, spread: false, children: items }];
    }

    case "listItem": {
      let children = exportChildren(node, ctx, scope);
      if (children.length > 0 && children.every((c) => c.type === "text" || isInlineType(c.type))) {
        children = [{ type: "paragraph", children }];
      }
      return [{ type: "listItem", spread: false, children }];
    }

    case "code": {
      const codeChild = Array.isArray(node.children)
        ? node.children.find((c: JxElement | string) => (c as JxMutableNode)?.tagName === "code")
        : null;
      const value = (codeChild as JxElement | undefined)?.textContent ?? text ?? "";
      return [
        {
          type: "code",
          lang: codeLang(codeChild as JxElement | undefined),
          value,
        },
      ];
    }

    case "thematicBreak":
      return [{ type: "thematicBreak" }];

    case "break":
      return [{ type: "break" }];

    case "table": {
      const rows = exportChildren(node, ctx, scope).filter((c) => c.type === "tableRow");
      if (rows.length === 0) return [];
      return [{ type: "table", children: rows }];
    }

    case "thead":
    case "tbody":
      // Unwrap — promote rows
      return exportChildren(node, ctx, scope);

    case "tableRow": {
      const cells = exportChildren(node, ctx, scope);
      return [
        {
          type: "tableRow",
          children: cells.filter((c) => c.type === "tableCell"),
        },
      ];
    }

    case "tableCell": {
      const children =
        text != null ? [{ type: "text", value: text }] : exportChildren(node, ctx, scope);
      return [{ type: "tableCell", children }];
    }
  }

  return [];
}

function exportChildren(
  node: JxElement,
  ctx: ExportContext,
  scope?: Record<string, unknown> | null,
): MdastNode[] {
  if (node.textContent != null) {
    const text = resolveText(node.textContent, ctx, scope);
    if (text) return [{ type: "text", value: text }];
    return [];
  }
  if (!Array.isArray(node.children)) return [];
  return node.children.flatMap((c: JxElement | string) => nodeToMdast(c, ctx, scope));
}

// ─── Export: component inlining ──────────────────────────────────────────────

function inlineComponent(node: JxElement, tag: string, ctx: ExportContext): MdastNode[] {
  const def = ctx.componentDefs.get(tag);
  if (!def) {
    return exportChildren(node, ctx);
  }

  // Merge instance $props into component state
  const props = node.$props ?? {};
  const stateDefs = { ...def.state };
  for (const [key, value] of Object.entries(props)) {
    if (key in stateDefs) {
      const existing = stateDefs[key];
      if (
        existing &&
        typeof existing === "object" &&
        !Array.isArray(existing) &&
        "default" in existing
      ) {
        stateDefs[key] = { ...existing, default: value };
      } else {
        stateDefs[key] = value as JxStateDefinition;
      }
    } else {
      stateDefs[key] = value as JxStateDefinition;
    }
  }

  const scope = ctx.buildScope?.(stateDefs) ?? null;

  if (!Array.isArray(def.children)) return [];

  const resolved = deepResolve(def.children, scope ?? {}, ctx);

  const instanceChildren = node.children;
  return resolved.flatMap((child: JxElement | string): MdastNode[] => {
    // Replace slot elements with instance children
    if (typeof child !== "string" && child?.tagName === "slot" && Array.isArray(instanceChildren)) {
      return instanceChildren.flatMap((c: JxElement | string): MdastNode[] => nodeToMdast(c, ctx));
    }
    return nodeToMdast(child, ctx, scope);
  });
}

function deepResolve(
  nodes: (JxElement | string)[],
  scope: Record<string, unknown>,
  ctx: ExportContext,
) {
  if (!Array.isArray(nodes)) return [];
  return nodes.map((node) => resolveNode(node, scope, ctx));
}

function resolveNode(
  node: JxElement | string,
  scope: Record<string, unknown>,
  ctx: ExportContext,
): JxElement | string {
  if (typeof node === "string") {
    const evaluated = ctx.evaluateTemplate?.(node, scope);
    return evaluated !== undefined ? String(evaluated) : node;
  }
  if (!node || typeof node !== "object") return node;

  const result = { ...node };

  if (typeof result.textContent === "string") {
    const evaluated = ctx.evaluateTemplate?.(result.textContent, scope);
    if (evaluated !== undefined) result.textContent = String(evaluated);
  }
  if (typeof result.innerHTML === "string") {
    const evaluated = ctx.evaluateTemplate?.(result.innerHTML, scope);
    if (evaluated !== undefined) result.innerHTML = String(evaluated);
  }
  if (result.attributes) {
    result.attributes = { ...result.attributes };
    for (const [k, v] of Object.entries(result.attributes)) {
      if (typeof v === "string") {
        const evaluated = ctx.evaluateTemplate?.(v, scope);
        if (evaluated !== undefined) result.attributes[k] = evaluated;
      }
    }
  }
  if (Array.isArray(result.children)) {
    result.children = deepResolve(result.children, scope, ctx);
  }

  return result;
}

// ─── Export: array expansion ─────────────────────────────────────────────────

function expandArray(
  arrayDef: JxElement,
  ctx: ExportContext,
  scope?: Record<string, unknown> | null,
): MdastNode[] {
  const itemsRef = (arrayDef as JxMutableNode).items?.$ref;
  if (!itemsRef || !scope) return [];

  const items = resolveRef(itemsRef, scope);
  if (!Array.isArray(items)) return [];

  const mapTemplate = (arrayDef as JxMutableNode).map;
  if (!mapTemplate) return [];

  return items.flatMap((item: JxMutableNode): MdastNode[] => {
    const resolved = resolveMapNode(mapTemplate, item);
    return nodeToMdast(resolved as JxElement | string, ctx, scope);
  });
}

function resolveMapNode(node: JxMutableNode, item: Record<string, unknown>) {
  if (typeof node === "string") return node;
  if (!node || typeof node !== "object") return node;

  const result = { ...node };

  for (const [key, value] of Object.entries(result)) {
    if (value && typeof value === "object" && (value as JxMutableNode).$ref) {
      const ref = (value as JxMutableNode).$ref as string;
      if (ref.startsWith("$map/")) {
        const path = ref.slice("$map/".length);
        result[key] = resolvePath(
          item,
          path.startsWith("item/") ? path.slice("item/".length) : path,
        );
      }
    }
  }

  if (result.$props) {
    result.$props = resolveMapNode(result.$props, item);
  }

  if (typeof result.textContent === "string" && result.textContent.startsWith("$map/")) {
    result.textContent = resolvePath(item, result.textContent.slice("$map/".length)) as unknown as
      | string
      | null;
  }

  if (Array.isArray(result.children)) {
    result.children = result.children.map((c) =>
      resolveMapNode(c as unknown as JxMutableNode, item),
    );
  }

  return result;
}

function resolvePath(obj: unknown, path: string) {
  const parts = path.split(/[/.]/);
  let current = obj as JxMutableNode;
  for (const part of parts) {
    if (current == null) return undefined;
    current = current[part];
  }
  return current;
}

function resolveRef(ref: string, scope: Record<string, unknown>) {
  if (ref.startsWith("#/state/")) {
    return resolvePath(scope, ref.slice("#/state/".length));
  }
  return resolvePath(scope, ref);
}

function resolveText(
  value: unknown,
  ctx: ExportContext,
  scope?: Record<string, unknown> | null,
): string | null {
  if (value == null) return null;
  if (typeof value === "string") {
    if (scope) {
      const evaluated = ctx.evaluateTemplate?.(value, scope);
      if (evaluated !== undefined) return String(evaluated);
    }
    return value;
  }
  return String(value);
}

// ─── Export: HTML → mdast (innerHTML handling) ──────────────────────────────

function htmlToMdast(html: string) {
  const nodes: MdastNode[] = [];

  const parts = splitHtmlBlocks(html);
  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const parsed = parseHtmlElement(trimmed);
    if (parsed) nodes.push(...parsed);
  }

  return nodes;
}

function splitHtmlBlocks(html: string) {
  const blocks: string[] = [];
  const trimmed = html.trim();

  const pattern =
    /(<(?:h[1-6]|p|blockquote|pre|ul|ol|hr|table|div|section|article|aside|figure|nav|header|footer|main)[\s>][\s\S]*?<\/(?:h[1-6]|p|blockquote|pre|ul|ol|table|div|section|article|aside|figure|nav|header|footer|main)>|<hr\s*\/?>)/gi;
  let lastIdx = 0;
  let m;
  while ((m = pattern.exec(trimmed)) !== null) {
    if (m.index > lastIdx) {
      const between = trimmed.slice(lastIdx, m.index).trim();
      if (between) blocks.push(between);
    }
    blocks.push(m[0]);
    lastIdx = pattern.lastIndex;
  }
  if (lastIdx < trimmed.length) {
    const tail = trimmed.slice(lastIdx).trim();
    if (tail) blocks.push(tail);
  }

  return blocks;
}

function parseHtmlElement(html: string) {
  const hMatch = html.match(/^<(h[1-6])(?:\s[^>]*)?>(.+?)<\/\1>$/is);
  if (hMatch) {
    const depth = parseInt(hMatch[1].slice(1), 10);
    const children = parseInlineHtml(hMatch[2]);
    return [{ type: "heading", depth, children }];
  }

  const pMatch = html.match(/^<p(?:\s[^>]*)?>(.+?)<\/p>$/is);
  if (pMatch) {
    const children = parseInlineHtml(pMatch[1]);
    if (children.length === 0) return null;
    return [{ type: "paragraph", children }];
  }

  if (/^<hr\s*\/?>$/i.test(html)) {
    return [{ type: "thematicBreak" }];
  }

  const preMatch = html.match(
    /^<pre(?:\s[^>]*)?>\s*<code(?:\s+class="language-(\w+)")?(?:\s[^>]*)?>([^]*?)<\/code>\s*<\/pre>$/is,
  );
  if (preMatch) {
    const lang = preMatch[1] ?? null;
    const value = decodeHtmlEntities(preMatch[2]);
    return [{ type: "code", lang, value }];
  }

  const bqMatch = html.match(/^<blockquote(?:\s[^>]*)?>([^]*?)<\/blockquote>$/is);
  if (bqMatch) {
    const inner = htmlToMdast(bqMatch[1]);
    const children = inner.map((c) =>
      c.type === "text" ? { type: "paragraph", children: [c] } : c,
    );
    return [{ type: "blockquote", children }];
  }

  const ulMatch = html.match(/^<ul(?:\s[^>]*)?>([^]*?)<\/ul>$/is);
  if (ulMatch) {
    const items = parseListItems(ulMatch[1]);
    if (items.length === 0) return null;
    return [{ type: "list", ordered: false, spread: false, children: items }];
  }

  const olMatch = html.match(/^<ol(?:\s[^>]*)?>([^]*?)<\/ol>$/is);
  if (olMatch) {
    const items = parseListItems(olMatch[1]);
    if (items.length === 0) return null;
    return [{ type: "list", ordered: true, spread: false, children: items }];
  }

  const tableMatch = html.match(/^<table(?:\s[^>]*)?>([^]*?)<\/table>$/is);
  if (tableMatch) {
    return parseHtmlTable(tableMatch[1]);
  }

  const wrapperMatch = html.match(
    /^<(?:div|section|article|aside|figure|nav|header|footer|main)(?:\s[^>]*)?>([^]*?)<\/(?:div|section|article|aside|figure|nav|header|footer|main)>$/is,
  );
  if (wrapperMatch) {
    return htmlToMdast(wrapperMatch[1]);
  }

  const text = stripHtmlTags(html).trim();
  if (text) return [{ type: "paragraph", children: parseInlineHtml(html) }];

  return null;
}

function parseInlineHtml(html: string) {
  const nodes: MdastNode[] = [];
  let pos = 0;

  while (pos < html.length) {
    const tagStart = html.indexOf("<", pos);
    if (tagStart === -1) {
      const text = decodeHtmlEntities(html.slice(pos));
      if (text.trim()) nodes.push({ type: "text", value: text });
      break;
    }

    if (tagStart > pos) {
      const text = decodeHtmlEntities(html.slice(pos, tagStart));
      if (text.trim()) nodes.push({ type: "text", value: text });
    }

    const brMatch = html.slice(tagStart).match(/^<br\s*\/?>/i);
    if (brMatch) {
      nodes.push({ type: "break" });
      pos = tagStart + brMatch[0].length;
      continue;
    }

    const imgMatch = html.slice(tagStart).match(/^<img(\s[^>]*?)\/?>/i);
    if (imgMatch) {
      const attrs = imgMatch[1] ?? "";
      const src = attrs.match(/src="([^"]*)"/)?.[1] ?? "";
      const alt = attrs.match(/alt="([^"]*)"/)?.[1] ?? "";
      nodes.push({
        type: "image",
        url: decodeHtmlEntities(src),
        alt: decodeHtmlEntities(alt),
      });
      pos = tagStart + imgMatch[0].length;
      continue;
    }

    const openMatch = html.slice(tagStart).match(/^<(a|em|strong|del|code|b|i|s)(\s[^>]*)?>/);
    if (openMatch) {
      const tag = openMatch[1].toLowerCase();
      const attrs = openMatch[2] ?? "";
      const innerStart = tagStart + openMatch[0].length;
      const closeTag = `</${tag}>`;
      const closeIdx = findMatchingClose(html, innerStart, tag);
      if (closeIdx === -1) {
        pos = tagStart + 1;
        continue;
      }
      const inner = html.slice(innerStart, closeIdx);
      pos = closeIdx + closeTag.length;

      switch (tag) {
        case "a": {
          const href = attrs.match(/href="([^"]*)"/)?.[1] ?? "";
          const title = attrs.match(/title="([^"]*)"/)?.[1] ?? null;
          const children = parseInlineHtml(inner);
          if (children.length === 0)
            children.push({ type: "text", value: decodeHtmlEntities(inner) });
          nodes.push({
            type: "link",
            url: decodeHtmlEntities(href),
            title,
            children,
          });
          break;
        }
        case "em":
        case "i":
          nodes.push({ type: "emphasis", children: parseInlineHtml(inner) });
          break;
        case "strong":
        case "b":
          nodes.push({ type: "strong", children: parseInlineHtml(inner) });
          break;
        case "del":
        case "s":
          nodes.push({ type: "delete", children: parseInlineHtml(inner) });
          break;
        case "code":
          nodes.push({ type: "inlineCode", value: decodeHtmlEntities(inner) });
          break;
      }
      continue;
    }

    const skipMatch = html.slice(tagStart).match(/^<[^>]*>/);
    if (skipMatch) {
      pos = tagStart + skipMatch[0].length;
    } else {
      pos = tagStart + 1;
    }
  }

  return nodes;
}

function findMatchingClose(html: string, start: number, tag: string) {
  let depth = 1;
  const openRe = new RegExp(`<${tag}[\\s>]`, "gi");
  const closeRe = new RegExp(`</${tag}>`, "gi");
  openRe.lastIndex = start;
  closeRe.lastIndex = start;

  while (depth > 0) {
    const openMatch = openRe.exec(html);
    const closeMatch = closeRe.exec(html);

    if (!closeMatch) return -1;

    if (openMatch && openMatch.index < closeMatch.index) {
      depth++;
      openRe.lastIndex = openMatch.index + openMatch[0].length;
      closeRe.lastIndex = closeMatch.index; // re-check this close
    } else {
      depth--;
      if (depth === 0) return closeMatch.index;
    }
  }
  return -1;
}

function parseListItems(html: string) {
  const items: MdastNode[] = [];
  const liPattern = /<li(?:\s[^>]*)?>([\s\S]*?)<\/li>/gi;
  let m;
  while ((m = liPattern.exec(html)) !== null) {
    const inner = m[1].trim();
    const innerNodes = /<(?:p|ul|ol|blockquote|pre)[\s>]/i.test(inner)
      ? htmlToMdast(inner)
      : [{ type: "paragraph", children: parseInlineHtml(inner) }];
    items.push({ type: "listItem", spread: false, children: innerNodes });
  }
  return items;
}

function parseHtmlTable(html: string) {
  const rows: MdastNode[] = [];
  const trPattern = /<tr(?:\s[^>]*)?>([\s\S]*?)<\/tr>/gi;
  let m;
  while ((m = trPattern.exec(html)) !== null) {
    const cellPattern = /<(?:th|td)(?:\s[^>]*)?>([\s\S]*?)<\/(?:th|td)>/gi;
    const cells: MdastNode[] = [];
    let c;
    while ((c = cellPattern.exec(m[1])) !== null) {
      cells.push({ type: "tableCell", children: parseInlineHtml(c[1]) });
    }
    if (cells.length > 0) rows.push({ type: "tableRow", children: cells });
  }
  if (rows.length === 0) return [];
  return [{ type: "table", children: rows }];
}

function stripHtmlTags(html: string) {
  return html.replace(/<[^>]+>/g, "");
}

function decodeHtmlEntities(str: string) {
  return str
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#36;/g, "$")
    .replace(/&nbsp;/g, " ");
}

// ═════════════════════════════════════════════════════════════════════════════
// Public entry point
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Serialize a Jx document to markdown source.
 *
 * - `mode: "roundtrip"` (default) — frontmatter + directives; inverse of `transpileJxMarkdown()`.
 * - `mode: "export"` — clean GFM: Jx decoration stripped, wrappers unwrapped, custom elements inlined
 *   via `componentDefs`, templates evaluated via injected hooks.
 */
export function serializeJxMarkdown(doc: JxDocument, opts: SerializeOptions = {}): string {
  const mode = opts.mode ?? "roundtrip";

  if (mode === "export") {
    return serializeExport(doc, opts);
  }
  return serializeRoundtrip(doc, opts);
}

function serializeRoundtrip(doc: JxDocument, opts: SerializeOptions): string {
  const lines: string[] = [];

  if (opts.frontmatter !== false) {
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
  }

  if (Array.isArray(doc.children) && doc.children.length > 0) {
    const mdast = jxToMdast(doc as JxElement, opts);
    const md = unified()
      .use(remarkGfm)
      .use(remarkDirective)
      .use(remarkStringify, { bullet: "-", emphasis: "*", strong: "*" })
      .stringify(mdast as unknown as import("mdast").Root);

    lines.push(md as string);
  }

  return (
    lines
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim() + "\n"
  );
}

function serializeExport(doc: JxDocument, opts: SerializeOptions): string {
  if (!Array.isArray(doc.children) || doc.children.length === 0) {
    return "";
  }

  const ctx: ExportContext = {
    componentDefs: opts.componentDefs ?? new Map(),
    evaluateTemplate: opts.evaluateTemplate,
    buildScope: opts.buildScope,
  };

  // Build scope from resolved state for any remaining template expressions
  const scope = doc.state ? (opts.buildScope?.(doc.state) ?? null) : null;

  const mdastChildren = doc.children.flatMap((child: JxElement | string) =>
    nodeToMdast(child, ctx, scope),
  );

  // Ensure block-level structure at root (no bare inline nodes)
  const cleaned: MdastNode[] = [];
  let inlineBuf: MdastNode[] = [];

  const flushInline = () => {
    if (inlineBuf.length > 0) {
      cleaned.push({ type: "paragraph", children: inlineBuf });
      inlineBuf = [];
    }
  };

  for (const node of mdastChildren) {
    if (isInlineType(node.type)) {
      inlineBuf.push(node);
    } else {
      flushInline();
      cleaned.push(node);
    }
  }
  flushInline();

  const mdast = {
    type: "root",
    children: cleaned,
  } as unknown as import("mdast").Root;

  const md = unified()
    .use(remarkGfm)
    .use(remarkStringify, {
      bullet: "-",
      emphasis: "*",
      strong: "*",
      setext: false,
    })
    .stringify(mdast);

  return md.replace(/\n{3,}/g, "\n\n").trim() + "\n";
}
