import { htmlToJx } from "@jxsuite/parser/html-to-jx";
import type { JxElement } from "@jxsuite/schema/types";

export interface ToJxResult {
  /** The page document root — a wrapper div with the converted children. */
  document: JxElement;
  /** Element count in the emitted tree. */
  nodeCount: number;
  /** Inline <style> contents collected for Phase 1 CSS resolution. */
  collectedStyles: string[];
}

const STRIP_TAGS = new Set(["script", "noscript", "iframe", "object", "embed", "link", "meta"]);

function countNodes(node: JxElement | string): number {
  if (typeof node === "string") {
    return 0;
  }
  let n = 1;
  if (Array.isArray(node.children)) {
    for (const c of node.children) {
      n += countNodes(c as JxElement | string);
    }
  }
  return n;
}

function stripTags(nodes: (JxElement | string)[]): {
  cleaned: (JxElement | string)[];
  styles: string[];
} {
  const cleaned: (JxElement | string)[] = [];
  const styles: string[] = [];

  for (const node of nodes) {
    if (typeof node === "string") {
      cleaned.push(node);
      continue;
    }

    const tag = String(node.tagName ?? "").toLowerCase();

    // Collect inline <style> content for Phase 1
    if (tag === "style") {
      if (typeof node.textContent === "string") {
        styles.push(node.textContent);
      }
      if (Array.isArray(node.children)) {
        for (const c of node.children) {
          if (typeof c === "string") {
            styles.push(c);
          }
        }
      }
      continue;
    }

    if (STRIP_TAGS.has(tag)) {
      continue;
    }

    // Recurse into children
    if (Array.isArray(node.children)) {
      const sub = stripTags(node.children as (JxElement | string)[]);
      node.children = sub.cleaned as JxElement[];
      styles.push(...sub.styles);
    }

    cleaned.push(node);
  }

  return { cleaned, styles };
}

export function convertToJx(bodyHtml: string): ToJxResult {
  const rawNodes = htmlToJx(bodyHtml);
  const { cleaned, styles } = stripTags(rawNodes);

  const document: JxElement = {
    tagName: "div",
    children: cleaned as JxElement[],
  };

  return {
    document,
    nodeCount: countNodes(document),
    collectedStyles: styles,
  };
}
