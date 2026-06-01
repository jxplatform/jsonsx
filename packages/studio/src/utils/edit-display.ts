/**
 * Edit-mode display transforms — extracted from studio.js (Phase 4i). Pure stateless functions that
 * convert document trees for visual editing (template expressions, $map, $switch, empty
 * placeholders).
 */

/**
 * Convert a template string to a displayable expression for edit mode. Replaces ${expr} with ❮ expr
 * ❯ so the runtime renders it as literal text.
 *
 * @param {string} str
 */
export function templateToEditDisplay(str: string) {
  return str.replace(/\$\{([^}]+)\}/g, "\u276A $1 \u276B");
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
      node.data = node.data.replace(/\u276A\s*(.*?)\s*\u276B/g, "${$1}");
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
  if (!node || typeof node !== "object") return node;
  if (Array.isArray(node)) return node.map(prepareForEditMode);

  const /** @type {Record<string, unknown>} */ obj = node as Record<string, unknown>;

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (k === "state" || k === "$media" || k === "$props" || k === "$elements") {
      out[k] = v; // preserve as-is for runtime resolution
    } else if (k === "children") {
      if (Array.isArray(v)) {
        out.children = v.map(prepareForEditMode);
      } else if (
        v &&
        typeof v === "object" &&
        (v as Record<string, unknown>).$prototype === "Array"
      ) {
        // Wrap the map template in a visual repeater perimeter
        const vObj = v as Record<string, unknown>;
        const template = vObj.map;
        if (template && typeof template === "object") {
          out.children = [
            {
              tagName: "div",
              className: "repeater-perimeter",
              children: [prepareForEditMode(template as JxMutableNode)],
            },
          ];
        } else {
          out.children = [];
        }
      } else {
        out.children = prepareForEditMode(v as JxMutableNode);
      }
    } else if (k === "cases" && obj.$switch && v && typeof v === "object") {
      // Replace $switch cases with a placeholder showing the first case or a label
      const caseKeys = Object.keys(v);
      if (caseKeys.length > 0) {
        const firstCase = (v as Record<string, unknown>)[caseKeys[0]];
        if (
          firstCase &&
          typeof firstCase === "object" &&
          !(firstCase as Record<string, unknown>).$ref
        ) {
          out.children = [prepareForEditMode(firstCase)];
        } else {
          out.children = [
            {
              tagName: "div",
              textContent: `[$switch: ${caseKeys.join(" | ")}]`,
              style: {
                fontFamily: "'SF Mono', 'Fira Code', monospace",
                fontSize: "11px",
                padding: "6px 10px",
                background: "color-mix(in srgb, var(--danger) 8%, transparent)",
                border: "1px dashed color-mix(in srgb, var(--danger) 40%, transparent)",
                borderRadius: "4px",
                color: "var(--danger)",
                fontStyle: "italic",
              },
            },
          ];
        }
      }
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
      out[k] = templateToEditDisplay(v);
    } else if (v && typeof v === "object" && (v as Record<string, unknown>).$ref) {
      // $ref binding → show ref path as literal text
      const ref = (v as Record<string, unknown>).$ref as string;
      const label = ref.startsWith("#/state/") ? ref.slice(8) : ref;
      out[k] = `{${label}}`;
    } else {
      out[k] = prepareForEditMode(v as JxMutableNode);
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
          ? out.className + " empty-text-placeholder"
          : "empty-text-placeholder";
      } else if (containerTags.has(tag)) {
        out.className = out.className
          ? out.className + " empty-container-placeholder"
          : "empty-container-placeholder";
      }
    }
  }

  return out;
}
