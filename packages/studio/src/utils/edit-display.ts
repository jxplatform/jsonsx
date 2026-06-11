/// <reference lib="dom" />
/**
 * Edit-mode display transforms — extracted from studio.js (Phase 4i). Pure stateless functions that
 * convert document trees for visual editing (template expressions, $map, $switch, empty
 * placeholders).
 */

import type { JxMutableNode } from "@jxsuite/schema/types";

const mediaTags = new Set(["img", "video", "source", "iframe", "audio"]);
const TRANSPARENT_PX =
  "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

/**
 * Convert a template string to a displayable expression for edit mode. Replaces ${expr} with ❮ expr
 * ❯ so the runtime renders it as literal text.
 *
 * @param {string} str
 */
export function templateToEditDisplay(str: string) {
  return str.replaceAll(/\$\{([^}]+)\}/g, "\u276A $1 \u276B");
}

/**
 * Reverse templateToEditDisplay: walk all text nodes in `el` and replace ❪ expr ❫ back to ${expr}
 * so the user edits raw template syntax.
 *
 * @param {HTMLElement} el
 */
export function restoreTemplateExpressions(el: HTMLElement) {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    if (node.data.includes("\u276A")) {
      node.data = node.data.replaceAll(/\u276A\s*(.*?)\s*\u276B/g, "${$1}");
    }
  }
}

/**
 * Prepare a document for edit-mode rendering. Replaces template strings with readable literal text,
 * $prototype:Array with placeholders, and $ref bindings with display labels. Preserves state so the
 * runtime can still initialise scope.
 *
 * @param {JxMutableNode} node
 * @returns {JxMutableNode}
 */
export function prepareForEditMode(node: JxMutableNode): JxMutableNode {
  if (!node || typeof node !== "object") {
    return node;
  }
  if (Array.isArray(node)) {
    // Arrays of nodes round-trip element-wise; the array itself is not a node.
    return node.map((n) => prepareForEditMode(n)) as unknown as JxMutableNode;
  }

  const /** @type {Record<string, unknown>} */ obj = node as Record<string, unknown>;

  const out: Record<string, unknown> = {};
  let needsMediaPlaceholder = false;
  const isMediaElement = mediaTags.has((obj.tagName as string) || "");

  // Check if this media element lacks a resolvable src (top-level or in attributes)
  if (isMediaElement) {
    const attrs = obj.attributes as Record<string, unknown> | undefined;
    const topSrc = obj.src;
    const attrSrc = attrs?.src;
    const topPoster = obj.poster;
    const attrPoster = attrs?.poster;
    const hasSrc = (topSrc && topSrc !== "") || (attrSrc && attrSrc !== "");
    const hasPoster = (topPoster && topPoster !== "") || (attrPoster && attrPoster !== "");
    if (!hasSrc && !hasPoster) {
      needsMediaPlaceholder = true;
    }
  }

  for (const [k, v] of Object.entries(obj)) {
    if (k === "state" || k === "$media" || k === "$elements") {
      out[k] = v; // Preserve as-is for runtime resolution
    } else if (k === "$props" && v && typeof v === "object") {
      // Process $props values: convert template strings to display format
      const propsOut: Record<string, unknown> = {};
      for (const [pk, pv] of Object.entries(v)) {
        if (typeof pv === "string" && pv.includes("${")) {
          const isUrlAttr = pk === "src" || pk === "href" || pk === "poster" || pk === "action";
          propsOut[pk] = isUrlAttr ? "" : templateToEditDisplay(pv);
        } else if (pv && typeof pv === "object" && (pv as Record<string, unknown>).$ref) {
          const ref = (pv as Record<string, unknown>).$ref as string;
          const label = ref.startsWith("#/state/") ? ref.slice(8) : ref;
          propsOut[pk] = `{${label}}`;
        } else {
          propsOut[pk] = pv;
        }
      }
      out[k] = propsOut;
    } else if (k === "children") {
      if (Array.isArray(v)) {
        out.children = v.map((c) => prepareForEditMode(c));
      } else if (
        v &&
        typeof v === "object" &&
        (v as Record<string, unknown>).$prototype === "Array"
      ) {
        // Wrap the map template in a visual repeater perimeter
        const vObj = v as Record<string, unknown>;
        const template = vObj.map;
        out.children =
          template && typeof template === "object"
            ? [
                {
                  children: [prepareForEditMode(template as JxMutableNode)],
                  className: "repeater-perimeter",
                  tagName: "div",
                },
              ]
            : [];
      } else {
        out.children = prepareForEditMode(v as JxMutableNode);
      }
    } else if (k === "cases" && obj.$switch && v && typeof v === "object") {
      // Replace $switch cases with a placeholder showing the first case or a label
      const caseKeys = Object.keys(v);
      if (caseKeys.length > 0) {
        const firstCase = (v as Record<string, unknown>)[caseKeys[0]];
        out.children =
          firstCase && typeof firstCase === "object" && !(firstCase as Record<string, unknown>).$ref
            ? [prepareForEditMode(firstCase as JxMutableNode)]
            : [
                {
                  style: {
                    background: "color-mix(in srgb, var(--danger) 8%, transparent)",
                    border: "1px dashed color-mix(in srgb, var(--danger) 40%, transparent)",
                    borderRadius: "4px",
                    color: "var(--danger)",
                    fontFamily: "'SF Mono', 'Fira Code', monospace",
                    fontSize: "11px",
                    fontStyle: "italic",
                    padding: "6px 10px",
                  },
                  tagName: "div",
                  textContent: `[$switch: ${caseKeys.join(" | ")}]`,
                },
              ];
      }
    } else if (k === "attributes" && isMediaElement && v && typeof v === "object") {
      // Process attributes for media elements: replace src/poster with transparent pixel
      const attrs = v as Record<string, unknown>;
      const processed: Record<string, unknown> = {};
      for (const [ak, av] of Object.entries(attrs)) {
        if (ak === "src" || ak === "poster") {
          if (typeof av === "string" && av !== "" && !av.includes("${")) {
            processed[ak] = av;
          } else {
            needsMediaPlaceholder = true;
            processed[ak] = TRANSPARENT_PX;
          }
        } else if (typeof av === "string" && av.includes("${")) {
          const isUrlAttr = ak === "href" || ak === "action";
          processed[ak] = isUrlAttr ? "" : templateToEditDisplay(av);
        } else if (av && typeof av === "object" && (av as Record<string, unknown>).$ref) {
          const ref = (av as Record<string, unknown>).$ref as string;
          const label = ref.startsWith("#/state/") ? ref.slice(8) : ref;
          processed[ak] = `{${label}}`;
        } else {
          processed[ak] = av;
        }
      }
      out.attributes = processed;
    } else if (k === "style") {
      // Replace template strings in style values with empty strings
      if (v && typeof v === "object") {
        const s: Record<string, unknown> = {};
        for (const [sk, sv] of Object.entries(v)) {
          s[sk] = typeof sv === "string" && sv.includes("${") ? "" : sv;
        }
        out.style = s;
      } else {
        out.style = v;
      }
    } else if (typeof v === "string" && v.includes("${")) {
      // Template string in a display property → show raw expression
      const isMediaSrc =
        (k === "src" || k === "poster") && mediaTags.has((obj.tagName as string) || "");
      if (isMediaSrc) {
        needsMediaPlaceholder = true;
        out[k] = TRANSPARENT_PX;
      } else {
        const isUrlAttr = k === "src" || k === "href" || k === "poster" || k === "action";
        out[k] = isUrlAttr ? "" : templateToEditDisplay(v);
      }
    } else if (v && typeof v === "object" && (v as Record<string, unknown>).$ref) {
      // $ref binding → show ref path as literal text
      const ref = (v as Record<string, unknown>).$ref as string;
      const label = ref.startsWith("#/state/") ? ref.slice(8) : ref;
      const isMediaSrc =
        (k === "src" || k === "poster") && mediaTags.has((obj.tagName as string) || "");
      if (isMediaSrc) {
        needsMediaPlaceholder = true;
        out[k] = TRANSPARENT_PX;
      } else {
        out[k] = `{${label}}`;
      }
    } else {
      // Empty src/poster on media elements → use transparent pixel placeholder
      if (
        (k === "src" || k === "poster") &&
        v === "" &&
        mediaTags.has((obj.tagName as string) || "")
      ) {
        needsMediaPlaceholder = true;
        out[k] = TRANSPARENT_PX;
      } else {
        out[k] = prepareForEditMode(v as JxMutableNode);
      }
    }
  }

  // Mark empty elements with placeholder classes for design-mode visibility
  if (out.tagName && !out.textContent && !out.innerHTML) {
    const hasChildren = Array.isArray(out.children) && out.children.length > 0;
    if (!hasChildren) {
      const tag = out.tagName as string;
      const textTags = new Set([
        "p",
        "h1",
        "h2",
        "h3",
        "h4",
        "h5",
        "h6",
        "blockquote",
        "li",
        "dt",
        "dd",
        "th",
        "td",
        "span",
        "strong",
        "em",
        "small",
        "mark",
        "code",
        "abbr",
        "q",
        "sub",
        "sup",
        "time",
        "a",
        "button",
        "label",
        "legend",
        "caption",
        "summary",
        "pre",
        "option",
      ]);
      const containerTags = new Set([
        "div",
        "section",
        "article",
        "aside",
        "header",
        "footer",
        "main",
        "nav",
        "figure",
        "figcaption",
        "details",
        "fieldset",
        "form",
        "ul",
        "ol",
        "dl",
        "table",
      ]);
      if (textTags.has(tag)) {
        out.className = out.className
          ? `${out.className} empty-text-placeholder`
          : "empty-text-placeholder";
      } else if (containerTags.has(tag)) {
        out.className = out.className
          ? `${out.className} empty-container-placeholder`
          : "empty-container-placeholder";
      }
    }
  }

  // Media elements with missing/dynamic src get a placeholder class
  if (needsMediaPlaceholder) {
    const cls = (out.className as string) || "";
    if (!cls.includes("empty-media-placeholder")) {
      out.className = cls ? `${cls} empty-media-placeholder` : "empty-media-placeholder";
    }
  }

  return out;
}
