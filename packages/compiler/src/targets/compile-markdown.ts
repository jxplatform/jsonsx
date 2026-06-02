/**
 * Compile-markdown.js — Clean markdown export target
 *
 * Converts a fully-resolved Jx document tree to pure markdown, stripping all Jx-specific decoration
 * (styles, attributes, custom element wrappers). Components are inlined by resolving their
 * definitions with instance props.
 */

import { unified } from "unified";
import remarkStringify from "remark-stringify";
import remarkGfm from "remark-gfm";
import { buildInitialScope, evaluateStaticTemplate, isTemplateString } from "../shared";
import type {
  JxElement,
  JxDocument,
  JxStateDefinition,
  JxMutableNode,
} from "@jxsuite/schema/types";
import type { MdastNode } from "@jxsuite/parser/types";

// ─── Tag classification ────────────────────────────────────────────────────

/** Tags that map directly to mdast node types. */
const TAG_MDAST_MAP = {
  h1: "heading",
  h2: "heading",
  h3: "heading",
  h4: "heading",
  h5: "heading",
  h6: "heading",
  p: "paragraph",
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
} as Record<string, string>;

/** Wrapper tags that should be unwrapped — their children are promoted. */
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

// ─── Core conversion ────────────────────────────────────────────────────────

/**
 * Convert a Jx node to an array of mdast nodes. Returns an array because wrapper unwrapping can
 * produce multiple children.
 *
 * @param {JxElement | string} node
 * @param {Map<string, JxElement>} componentDefs
 * @param {Record<string, unknown> | null} [scope] - Current resolution scope
 * @returns {MdastNode[]}
 */
function nodeToMdast(
  node: JxElement | string,
  componentDefs: Map<string, JxElement>,
  scope?: Record<string, unknown> | null,
): MdastNode[] {
  // Bare text
  if (typeof node === "string") {
    return node.trim() ? [{ type: "text", value: node }] : [];
  }
  if (typeof node === "number") {
    return [{ type: "text", value: String(node) }];
  }
  if (!node || typeof node !== "object") return [];

  // Array descriptor — expand mapped arrays
  if (node.$prototype === "Array") {
    return expandArray(node, componentDefs, scope);
  }

  const tag = node.tagName ?? "div";

  // Resolve text content
  const text = resolveText(node.textContent, scope);

  // innerHTML — if present, convert HTML content to mdast
  if (typeof node.innerHTML === "string" && node.innerHTML.trim()) {
    const htmlNodes = htmlToMdast(node.innerHTML);
    if (htmlNodes.length > 0) return htmlNodes;
  }

  // Custom elements — inline component content
  if (tag.includes("-")) {
    return inlineComponent(node, tag, componentDefs);
  }

  // Wrapper tags — unwrap, promote children
  if (WRAPPER_TAGS.has(tag)) {
    // If wrapper has only textContent, wrap in paragraph for block structure
    if (text != null) {
      return text.trim() ? [{ type: "paragraph", children: [{ type: "text", value: text }] }] : [];
    }
    return convertChildren(node, componentDefs, scope);
  }

  const mdastType = TAG_MDAST_MAP[tag];
  if (!mdastType) {
    // Unknown tag — wrap textContent in paragraph, or unwrap children
    if (text != null) {
      return text.trim() ? [{ type: "paragraph", children: [{ type: "text", value: text }] }] : [];
    }
    return convertChildren(node, componentDefs, scope);
  }

  // Standard markdown elements
  switch (mdastType) {
    case "heading": {
      const depth = parseInt(tag.slice(1), 10);
      const children =
        text != null
          ? [{ type: "text", value: text }]
          : convertChildrenInline(node, componentDefs, scope);
      return [{ type: "heading", depth, children }];
    }

    case "paragraph": {
      const children =
        text != null
          ? [{ type: "text", value: text }]
          : convertChildrenInline(node, componentDefs, scope);
      if (children.length === 0) return [];
      return [{ type: "paragraph", children }];
    }

    case "emphasis":
    case "strong":
    case "delete": {
      const children =
        text != null
          ? [{ type: "text", value: text }]
          : convertChildrenInline(node, componentDefs, scope);
      return [{ type: mdastType, children }];
    }

    case "inlineCode":
      return [{ type: "inlineCode", value: text ?? "" }];

    case "link": {
      const href = String(node.attributes?.href ?? "");
      const title = (node.attributes?.title as string | null) ?? null;
      const children =
        text != null
          ? [{ type: "text", value: text }]
          : convertChildrenInline(node, componentDefs, scope);
      return [{ type: "link", url: href, title, children }];
    }

    case "image": {
      const src = String(node.attributes?.src ?? "");
      const alt = String(node.attributes?.alt ?? "");
      const title = (node.attributes?.title as string | null) ?? null;
      return [{ type: "image", url: src, alt, title }];
    }

    case "blockquote": {
      const children = convertChildren(node, componentDefs, scope);
      // Wrap bare text in paragraph if needed
      const wrapped = children.map((c) =>
        c.type === "text" ? { type: "paragraph", children: [c] } : c,
      );
      return [{ type: "blockquote", children: wrapped }];
    }

    case "list": {
      const ordered = tag === "ol";
      const children = convertChildren(node, componentDefs, scope);
      // Only keep listItem children
      const items = children.filter((c) => c.type === "listItem");
      if (items.length === 0) return [];
      return [{ type: "list", ordered, spread: false, children: items }];
    }

    case "listItem": {
      let children = convertChildren(node, componentDefs, scope);
      // Wrap bare text/inline nodes in paragraph
      if (children.length > 0 && children.every((c) => c.type === "text" || isInlineType(c.type))) {
        children = [{ type: "paragraph", children }];
      }
      return [{ type: "listItem", spread: false, children }];
    }

    case "code": {
      // pre > code → fenced code block
      const codeChild = Array.isArray(node.children)
        ? node.children.find((c: JxElement | string) => (c as JxMutableNode)?.tagName === "code")
        : null;
      const value = (codeChild as JxElement | undefined)?.textContent ?? text ?? "";
      const lang =
        (codeChild as JxElement | undefined)?.className?.replace("language-", "") ?? null;
      return [{ type: "code", lang, value }];
    }

    case "thematicBreak":
      return [{ type: "thematicBreak" }];

    case "break":
      return [{ type: "break" }];

    case "table":
      return convertTable(node, componentDefs, scope);

    case "thead":
    case "tbody":
      // Unwrap — promote rows
      return convertChildren(node, componentDefs, scope);

    case "tableRow": {
      const cells = convertChildren(node, componentDefs, scope);
      return [{ type: "tableRow", children: cells.filter((c) => c.type === "tableCell") }];
    }

    case "tableCell": {
      const children =
        text != null
          ? [{ type: "text", value: text }]
          : convertChildrenInline(node, componentDefs, scope);
      return [{ type: "tableCell", children }];
    }
  }

  return [];
}

/**
 * @param {string} type
 * @returns {boolean}
 */
function isInlineType(type: string) {
  return ["text", "emphasis", "strong", "delete", "inlineCode", "link", "image", "break"].includes(
    type,
  );
}

/**
 * Convert a node's children to mdast nodes (block context).
 *
 * @param {JxElement} node
 * @param {Map<string, JxElement>} componentDefs
 * @param {Record<string, unknown> | null} [scope]
 * @returns {MdastNode[]}
 */
function convertChildren(
  node: JxElement,
  componentDefs: Map<string, JxElement>,
  scope?: Record<string, unknown> | null,
): MdastNode[] {
  if (node.textContent != null) {
    const text = resolveText(node.textContent, scope);
    if (text) return [{ type: "text", value: text }];
    return [];
  }
  if (!Array.isArray(node.children)) return [];
  return node.children.flatMap((c: JxElement | string) => nodeToMdast(c, componentDefs, scope));
}

/**
 * Convert children in inline context — same as convertChildren but for inline content.
 *
 * @param {JxElement} node
 * @param {Map<string, JxElement>} componentDefs
 * @param {Record<string, unknown> | null} [scope]
 * @returns {MdastNode[]}
 */
function convertChildrenInline(
  node: JxElement,
  componentDefs: Map<string, JxElement>,
  scope?: Record<string, unknown> | null,
): MdastNode[] {
  if (node.textContent != null) {
    const text = resolveText(node.textContent, scope);
    if (text) return [{ type: "text", value: text }];
    return [];
  }
  if (!Array.isArray(node.children)) return [];
  return node.children.flatMap((c: JxElement | string) => nodeToMdast(c, componentDefs, scope));
}

// ─── Component inlining ─────────────────────────────────────────────────────

/**
 * Inline a custom element by resolving its component definition.
 *
 * @param {JxElement} node - The element instance (with $props, children, etc.)
 * @param {string} tag - The tagName
 * @param {Map<string, JxElement>} componentDefs
 * @returns {MdastNode[]}
 */
function inlineComponent(
  node: JxElement,
  tag: string,
  componentDefs: Map<string, JxElement>,
): MdastNode[] {
  const def = componentDefs.get(tag);
  if (!def) {
    // No definition — unwrap any children the instance has
    return convertChildren(node, componentDefs);
  }

  // Merge instance $props into component state
  const props = node.$props ?? {};
  let stateDefs = { ...def.state };
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

  const scope = buildInitialScope(stateDefs, null);

  // Resolve the component's children with the merged scope
  if (!Array.isArray(def.children)) return [];

  // Deep-resolve template expressions in the component's children
  const resolved = deepResolve(def.children, scope);

  // Convert to mdast, passing instance's own children as potential slot content
  const instanceChildren = node.children;
  return resolved.flatMap((child: JxElement | string): MdastNode[] => {
    // Replace slot elements with instance children
    if (typeof child !== "string" && child?.tagName === "slot" && Array.isArray(instanceChildren)) {
      return instanceChildren.flatMap((c: JxElement | string): MdastNode[] =>
        nodeToMdast(c, componentDefs),
      );
    }
    return nodeToMdast(child, componentDefs, scope);
  });
}

/**
 * Deep-resolve template expressions in a node tree.
 *
 * @param {(JxElement | string)[]} nodes
 * @param {Record<string, unknown>} scope
 * @returns {(JxElement | string)[]}
 */
function deepResolve(nodes: (JxElement | string)[], scope: Record<string, unknown>) {
  if (!Array.isArray(nodes)) return [];
  return nodes.map((node: JxElement | string) => resolveNode(node, scope));
}

/**
 * Resolve template expressions in a single node.
 *
 * @param {JxElement | string} node
 * @param {Record<string, unknown>} scope
 * @returns {JxElement | string}
 */
function resolveNode(node: JxElement | string, scope: Record<string, unknown>) {
  if (typeof node === "string") {
    return isTemplateString(node) ? String(evaluateStaticTemplate(node, scope) ?? node) : node;
  }
  if (!node || typeof node !== "object") return node;

  const result = { ...node };

  if (typeof result.textContent === "string" && isTemplateString(result.textContent)) {
    result.textContent = String(
      evaluateStaticTemplate(result.textContent, scope) ?? result.textContent,
    );
  }
  if (typeof result.innerHTML === "string" && isTemplateString(result.innerHTML)) {
    result.innerHTML = String(evaluateStaticTemplate(result.innerHTML, scope) ?? result.innerHTML);
  }
  if (result.attributes) {
    result.attributes = { ...result.attributes };
    for (const [k, v] of Object.entries(result.attributes)) {
      if (typeof v === "string" && isTemplateString(v)) {
        result.attributes[k] = evaluateStaticTemplate(v, scope) ?? v;
      }
    }
  }
  if (Array.isArray(result.children)) {
    result.children = deepResolve(result.children, scope);
  }

  return result;
}

// ─── Array expansion ────────────────────────────────────────────────────────

/**
 * Expand a $prototype: "Array" descriptor into concrete mdast nodes.
 *
 * @param {JxElement} arrayDef
 * @param {Map<string, JxElement>} componentDefs
 * @param {Record<string, unknown> | null} [scope]
 * @returns {MdastNode[]}
 */
function expandArray(
  arrayDef: JxElement,
  componentDefs: Map<string, JxElement>,
  scope?: Record<string, unknown> | null,
): MdastNode[] {
  const itemsRef = (arrayDef as JxMutableNode).items?.$ref;
  if (!itemsRef || !scope) return [];

  // Resolve the items array from scope
  const items = resolveRef(itemsRef, scope);
  if (!Array.isArray(items)) return [];

  const mapTemplate = (arrayDef as JxMutableNode).map;
  if (!mapTemplate) return [];

  return items.flatMap((item: JxMutableNode, index: number): MdastNode[] => {
    // Create a scope with $map values
    const mapScope = Object.create(scope);
    mapScope.item = item;
    mapScope.index = index;

    // Resolve the map template with $map refs
    const resolved = resolveMapNode(mapTemplate, item);
    return nodeToMdast(resolved as JxElement | string, componentDefs, scope);
  });
}

/**
 * Resolve $map/ references in a map template node.
 *
 * @param {JxMutableNode} node
 * @param {Record<string, unknown>} item
 * @returns {any}
 */
function resolveMapNode(node: JxMutableNode, item: Record<string, unknown>) {
  if (typeof node === "string") return node;
  if (!node || typeof node !== "object") return node;

  const result = { ...node };

  // Resolve $ref values
  for (const [key, value] of Object.entries(result)) {
    if (value && typeof value === "object" && (value as JxMutableNode).$ref) {
      const ref = (value as JxMutableNode).$ref as string;
      if (ref.startsWith("$map/")) {
        const path = ref.slice("$map/".length);
        result[key] = resolvePath(
          path === "item" ? item : item,
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

/**
 * Resolve a dot/slash-separated path on an object.
 *
 * @param {unknown} obj
 * @param {string} path
 * @returns {any}
 */
function resolvePath(obj: unknown, path: string) {
  const parts = path.split(/[/.]/);
  let current = obj as JxMutableNode;
  for (const part of parts) {
    if (current == null) return undefined;
    current = current[part];
  }
  return current;
}

/**
 * Resolve a $ref string against a scope.
 *
 * @param {string} ref
 * @param {Record<string, unknown>} scope
 * @returns {unknown}
 */
function resolveRef(ref: string, scope: Record<string, unknown>) {
  if (ref.startsWith("#/state/")) {
    return resolvePath(scope, ref.slice("#/state/".length));
  }
  return resolvePath(scope, ref);
}

// ─── Table conversion ───────────────────────────────────────────────────────

/**
 * Convert a table element to mdast table node.
 *
 * @param {JxElement} node
 * @param {Map<string, JxElement>} componentDefs
 * @param {Record<string, unknown> | null} [scope]
 * @returns {MdastNode[]}
 */
function convertTable(
  node: JxElement,
  componentDefs: Map<string, JxElement>,
  scope?: Record<string, unknown> | null,
) {
  // Flatten thead/tbody wrappers to get rows
  const rows = convertChildren(node, componentDefs, scope).filter((c) => c.type === "tableRow");
  if (rows.length === 0) return [];
  return [{ type: "table", children: rows }];
}

// ─── Text resolution ────────────────────────────────────────────────────────

/**
 * Resolve text content, handling template strings if a scope is available.
 *
 * @param {unknown} value
 * @param {Record<string, unknown> | null} [scope]
 * @returns {string | null}
 */
function resolveText(value: unknown, scope?: Record<string, unknown> | null) {
  if (value == null) return null;
  if (typeof value === "string") {
    if (scope && isTemplateString(value)) {
      const resolved = evaluateStaticTemplate(value, scope);
      return resolved != null ? String(resolved) : value;
    }
    return value;
  }
  return String(value);
}

// ─── HTML → mdast conversion ──────────────────────────────────────────────

/**
 * Convert an HTML string to mdast nodes. Handles common block and inline elements from rendered
 * markdown content.
 *
 * @param {string} html
 * @returns {MdastNode[]}
 */
function htmlToMdast(html: string) {
  const nodes: MdastNode[] = [];

  // Simple top-level block parser
  const parts = splitHtmlBlocks(html);
  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const parsed = parseHtmlElement(trimmed);
    if (parsed) nodes.push(...parsed);
  }

  return nodes;
}

/**
 * Split HTML into top-level block chunks.
 *
 * @param {string} html
 * @returns {string[]}
 */
function splitHtmlBlocks(html: string) {
  const blocks: string[] = [];
  const trimmed = html.trim();

  // Simple regex: split on top-level block boundaries
  // Match each top-level element or bare text
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

/**
 * Parse a single HTML element string into mdast node(s).
 *
 * @param {string} html
 * @returns {MdastNode[] | null}
 */
function parseHtmlElement(html: string) {
  // Heading
  const hMatch = html.match(/^<(h[1-6])(?:\s[^>]*)?>(.+?)<\/\1>$/is);
  if (hMatch) {
    const depth = parseInt(hMatch[1].slice(1), 10);
    const children = parseInlineHtml(hMatch[2]);
    return [{ type: "heading", depth, children }];
  }

  // Paragraph
  const pMatch = html.match(/^<p(?:\s[^>]*)?>(.+?)<\/p>$/is);
  if (pMatch) {
    const children = parseInlineHtml(pMatch[1]);
    if (children.length === 0) return null;
    return [{ type: "paragraph", children }];
  }

  // Horizontal rule
  if (/^<hr\s*\/?>$/i.test(html)) {
    return [{ type: "thematicBreak" }];
  }

  // Code block (pre > code)
  const preMatch = html.match(
    /^<pre(?:\s[^>]*)?>\s*<code(?:\s+class="language-(\w+)")?(?:\s[^>]*)?>([^]*?)<\/code>\s*<\/pre>$/is,
  );
  if (preMatch) {
    const lang = preMatch[1] ?? null;
    const value = decodeHtmlEntities(preMatch[2]);
    return [{ type: "code", lang, value }];
  }

  // Blockquote
  const bqMatch = html.match(/^<blockquote(?:\s[^>]*)?>([^]*?)<\/blockquote>$/is);
  if (bqMatch) {
    const inner = htmlToMdast(bqMatch[1]);
    const children = inner.map((c) =>
      c.type === "text" ? { type: "paragraph", children: [c] } : c,
    );
    return [{ type: "blockquote", children }];
  }

  // Unordered list
  const ulMatch = html.match(/^<ul(?:\s[^>]*)?>([^]*?)<\/ul>$/is);
  if (ulMatch) {
    const items = parseListItems(ulMatch[1]);
    if (items.length === 0) return null;
    return [{ type: "list", ordered: false, spread: false, children: items }];
  }

  // Ordered list
  const olMatch = html.match(/^<ol(?:\s[^>]*)?>([^]*?)<\/ol>$/is);
  if (olMatch) {
    const items = parseListItems(olMatch[1]);
    if (items.length === 0) return null;
    return [{ type: "list", ordered: true, spread: false, children: items }];
  }

  // Table
  const tableMatch = html.match(/^<table(?:\s[^>]*)?>([^]*?)<\/table>$/is);
  if (tableMatch) {
    return parseHtmlTable(tableMatch[1]);
  }

  // Wrapper elements (div, section, etc.) — unwrap
  const wrapperMatch = html.match(
    /^<(?:div|section|article|aside|figure|nav|header|footer|main)(?:\s[^>]*)?>([^]*?)<\/(?:div|section|article|aside|figure|nav|header|footer|main)>$/is,
  );
  if (wrapperMatch) {
    return htmlToMdast(wrapperMatch[1]);
  }

  // Bare text / inline content
  const text = stripHtmlTags(html).trim();
  if (text) return [{ type: "paragraph", children: parseInlineHtml(html) }];

  return null;
}

/**
 * Parse inline HTML content to mdast inline nodes.
 *
 * @param {string} html
 * @returns {MdastNode[]}
 */
function parseInlineHtml(html: string) {
  const nodes: MdastNode[] = [];
  let pos = 0;

  while (pos < html.length) {
    const tagStart = html.indexOf("<", pos);
    if (tagStart === -1) {
      // Remaining text
      const text = decodeHtmlEntities(html.slice(pos));
      if (text.trim()) nodes.push({ type: "text", value: text });
      break;
    }

    // Text before tag
    if (tagStart > pos) {
      const text = decodeHtmlEntities(html.slice(pos, tagStart));
      if (text.trim()) nodes.push({ type: "text", value: text });
    }

    // Self-closing tags
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
      nodes.push({ type: "image", url: decodeHtmlEntities(src), alt: decodeHtmlEntities(alt) });
      pos = tagStart + imgMatch[0].length;
      continue;
    }

    // Paired inline tags
    const openMatch = html.slice(tagStart).match(/^<(a|em|strong|del|code|b|i|s)(\s[^>]*)?>/);
    if (openMatch) {
      const tag = openMatch[1].toLowerCase();
      const attrs = openMatch[2] ?? "";
      const innerStart = tagStart + openMatch[0].length;
      const closeTag = `</${tag}>`;
      const closeIdx = findMatchingClose(html, innerStart, tag);
      if (closeIdx === -1) {
        // No matching close — treat as text
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
          nodes.push({ type: "link", url: decodeHtmlEntities(href), title, children });
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

    // Unknown tag — skip it
    const skipMatch = html.slice(tagStart).match(/^<[^>]*>/);
    if (skipMatch) {
      pos = tagStart + skipMatch[0].length;
    } else {
      pos = tagStart + 1;
    }
  }

  return nodes;
}

/**
 * Find the matching closing tag, handling nested same-name tags.
 *
 * @param {string} html
 * @param {number} start - Position after the opening tag
 * @param {string} tag - Tag name to match
 * @returns {number} Position of the matching closing tag, or -1
 */
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

/**
 * Parse <li> elements from list HTML.
 *
 * @param {string} html
 * @returns {MdastNode[]}
 */
function parseListItems(html: string) {
  const items: MdastNode[] = [];
  const liPattern = /<li(?:\s[^>]*)?>([\s\S]*?)<\/li>/gi;
  let m;
  while ((m = liPattern.exec(html)) !== null) {
    const inner = m[1].trim();
    // Check for nested block content
    const innerNodes = /<(?:p|ul|ol|blockquote|pre)[\s>]/i.test(inner)
      ? htmlToMdast(inner)
      : [{ type: "paragraph", children: parseInlineHtml(inner) }];
    items.push({ type: "listItem", spread: false, children: innerNodes });
  }
  return items;
}

/**
 * Parse an HTML table to mdast table node.
 *
 * @param {string} html
 * @returns {MdastNode[]}
 */
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

/**
 * Strip all HTML tags from a string.
 *
 * @param {string} html
 * @returns {string}
 */
function stripHtmlTags(html: string) {
  return html.replace(/<[^>]+>/g, "");
}

/**
 * Decode common HTML entities.
 *
 * @param {string} str
 * @returns {string}
 */
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

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Compile a fully-resolved Jx document to clean markdown.
 *
 * @param {JxDocument} doc - Resolved Jx document (post layout, context, prototypes, templates)
 * @param {Map<string, JxElement>} [componentDefs] - Component definitions for inlining
 * @returns {{ content: string }}
 */
export function compileMarkdown(
  doc: JxDocument,
  componentDefs: Map<string, JxElement> = new Map(),
) {
  if (!Array.isArray(doc.children) || doc.children.length === 0) {
    return { content: "" };
  }

  // Build scope from resolved state for any remaining template expressions
  const scope = doc.state ? buildInitialScope(doc.state, null) : null;

  // Convert to mdast
  const mdastChildren = doc.children.flatMap((child: JxElement | string) =>
    nodeToMdast(child, componentDefs, scope),
  );

  // Clean up: ensure block-level structure (no bare inline nodes at root)
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

  const mdast = { type: "root", children: cleaned } as unknown as import("mdast").Root;

  const md = unified()
    .use(remarkGfm)
    .use(remarkStringify, { bullet: "-", emphasis: "*", strong: "*", setext: false })
    .stringify(mdast);

  // Clean up excessive whitespace
  const content = md.replace(/\n{3,}/g, "\n\n").trim() + "\n";

  return { content };
}
