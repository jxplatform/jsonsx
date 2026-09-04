import { htmlToJx } from "@jxsuite/markup/html-to-jx";
import type { JxElement } from "@jxsuite/schema/types";

export interface ToJxResult {
  /** The page document root — a wrapper div with the converted children. */
  document: JxElement;
  /** Element count in the emitted tree. */
  nodeCount: number;
  /** Inline <style> contents collected for Phase 1 CSS resolution. */
  collectedStyles: string[];
}

/**
 * Tags removed from the converted tree — and therefore tags the style capture must skip too.
 *
 * Exported because two passes have to agree about it. `style-capture.ts` walks the LIVE DOM to
 * build each element's child-index path; `apply-styles.ts` looks those paths up in the STRIPPED
 * tree. Anything dropped here but present during the walk shifts every following sibling by one,
 * and the shift cascades through the subtree, so the lookup misses and the node gets no style at
 * all. On a WordPress page carrying sixteen in-body `<style>` blocks and an `<iframe>`, that was
 * 62.8% of elements unstyled.
 *
 * `style` is a member: it is stripped in `stripTags` by its own branch (its text is harvested into
 * `collectedStyles` first), which is exactly the kind of second exit that made the sets diverge.
 *
 * The live DOM must NOT have these removed before capture — `getComputedStyle` is about to read the
 * cascade that `<style>` and `<link>` define. Skipping them in the walk is the correct fix;
 * removing them from the page is not.
 */
export const STRIP_TAGS = new Set([
  "script",
  "noscript",
  "iframe",
  "object",
  "embed",
  "link",
  "meta",
  "style",
]);

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

    // Collect inline <style> content for Phase 1. Style elements hold raw text, which htmlToJx
    // Always collapses into textContent (never string children).
    if (tag === "style") {
      if (typeof node.textContent === "string") {
        styles.push(node.textContent);
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
