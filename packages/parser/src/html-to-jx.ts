import { fromHtml } from "hast-util-from-html";
import { whitespace } from "hast-util-whitespace";
import { find, html as htmlInfo } from "property-information";

import type { Nodes as HastNode } from "hast";
import type { JxElement } from "@jxsuite/schema/types";

/**
 * Convert an HTML string into an array of Jx tree nodes.
 *
 * @param {string} htmlString
 * @returns {(JxElement | string)[]}
 */
export function htmlToJx(htmlString: string) {
  const hast = fromHtml(htmlString, { fragment: true });
  return convertHastChildren(hast.children as HastNode[]);
}

/**
 * @param {HastNode[]} children
 * @returns {(JxElement | string)[]}
 */
function convertHastChildren(children: HastNode[]) {
  const result: (JxElement | string)[] = [];
  for (const child of children) {
    const converted = convertHastNode(child);
    if (converted != null) {
      result.push(converted);
    }
  }
  return result;
}

/**
 * @param {HastNode} node
 * @returns {JxElement | string | null}
 */
function convertHastNode(node: HastNode) {
  if (node.type === "text") {
    if (whitespace(node as unknown as HastNode)) {
      return null;
    }
    return node.value ?? null;
  }

  if (node.type === "element") {
    const el: JxElement = { tagName: node.tagName };

    if (node.properties && Object.keys(node.properties).length > 0) {
      const { style, attrs } = hastPropsToJx(node.properties);
      if (Object.keys(attrs).length > 0) {
        el.attributes = attrs;
      }
      if (Object.keys(style).length > 0) {
        el.style = style;
      }
    }

    const kids = node.children ? convertHastChildren(node.children) : [];

    if (kids.length === 1 && typeof kids[0] === "string") {
      [el.textContent] = kids;
    } else if (kids.length > 0) {
      el.children = kids as JxElement[];
    }

    return el;
  }

  return null;
}

/**
 * @param {Record<string, unknown>} properties
 * @returns {{ style: Record<string, string>; attrs: Record<string, string> }}
 */
function hastPropsToJx(properties: Record<string, unknown>) {
  const attrs: Record<string, string> = {};
  const style: Record<string, string> = {};

  for (const [key, value] of Object.entries(properties)) {
    if (value === false || value === undefined || value === null) {
      continue;
    }

    const info = find(htmlInfo, key);
    const name = info.attribute;

    if (name === "style" && typeof value === "string") {
      parseInlineStyle(value, style);
      continue;
    }

    if (value === true) {
      attrs[name] = "";
    } else if (Array.isArray(value)) {
      attrs[name] = value.join(info.commaSeparated ? ", " : " ");
    } else {
      attrs[name] = String(value);
    }
  }
  return { attrs, style };
}

/**
 * @param {string} styleStr
 * @param {Record<string, string>} out
 */
function parseInlineStyle(styleStr: string, out: Record<string, string>) {
  for (const decl of styleStr.split(";")) {
    const colon = decl.indexOf(":");
    if (colon === -1) {
      continue;
    }
    const prop = decl.slice(0, colon).trim();
    const val = decl.slice(colon + 1).trim();
    if (prop && val) {
      out[prop] = val;
    }
  }
}
