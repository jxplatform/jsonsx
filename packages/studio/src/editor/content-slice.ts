/**
 * Slicing a block's content by CHARACTER OFFSET, preserving inline markup.
 *
 * A selection that spans blocks cuts through the middle of the first and last of them, so deleting
 * it means keeping `[0, from)` of one block and `[to, end)` of another — by rendered character
 * position, across whatever nesting of `<strong>`, `<em>`, `<code>` and links the author has built.
 * Cutting "he**ll**o" at offset 3 has to yield "he" + a bold "l", not a truncated string.
 *
 * The offsets here are the same ones {@link file://../canvas/iframe-position.ts} produces from the
 * DOM, so a caret position and a content slice always agree on what "offset 3" means.
 *
 * Pure: no DOM, no document, no reactivity — the whole thing is exercisable as data.
 *
 * @docs studio/editing/writing
 */

import type { JxMutableNode } from "@jxsuite/schema/types";

/** A block's content as a children array — the form both storage shapes normalize to. */
export type Content = (JxMutableNode | string)[];

/**
 * The content of `node` as a children array, whichever way it is stored.
 *
 * A block holds its text either as `textContent` (all-plain) or as `children` (mixed inline
 * markup), and every operation that joins or cuts blocks has to handle both.
 */
export function contentOf(node: JxMutableNode | undefined | null): Content {
  if (!node) {
    return [];
  }
  if (Array.isArray(node.children)) {
    return node.children as Content;
  }
  return typeof node.textContent === "string" && node.textContent.length > 0
    ? [node.textContent]
    : [];
}

/** The rendered text length of a content array. */
export function contentLength(children: Content): number {
  let n = 0;
  for (const child of children) {
    n += typeof child === "string" ? child.length : contentLength(contentOf(child));
  }
  return n;
}

/**
 * The sub-content covering characters `[start, end)`, with inline elements preserved.
 *
 * An inline element that straddles a boundary is kept with its content clipped — so cutting a bold
 * run in half leaves a shorter bold run, not plain text. Elements that fall entirely outside the
 * range are dropped; empty results are omitted rather than left as empty tags.
 */
export function sliceContent(children: Content, start: number, end: number): Content {
  const out: Content = [];
  let pos = 0;
  for (const child of children) {
    if (pos >= end) {
      break;
    }
    if (typeof child === "string") {
      const childEnd = pos + child.length;
      if (childEnd > start) {
        const text = child.slice(
          Math.max(0, start - pos),
          Math.max(0, Math.min(end, childEnd) - pos),
        );
        if (text) {
          out.push(text);
        }
      }
      pos = childEnd;
      continue;
    }
    const inner = contentOf(child);
    const len = contentLength(inner);
    const childEnd = pos + len;
    if (len === 0) {
      // A void inline (a `<br>`, an `<img>`) contributes no characters, so it can never satisfy a
      // Length-based overlap test — it sits AT a position rather than spanning one. Keep it when
      // The range covers that position, or every slice would silently drop it.
      if (pos >= start && pos < end) {
        // Copied verbatim: giving a `<br>` an empty `textContent` would be noise in the source.
        out.push({ ...child });
      }
    } else if (childEnd > start) {
      const kept = sliceContent(inner, Math.max(0, start - pos), Math.min(end, childEnd) - pos);
      if (kept.length > 0) {
        out.push(withContent(child, kept));
      }
    }
    pos = childEnd;
  }
  return out;
}

/** A copy of `node` carrying `children`, folded back to `textContent` when it is all plain text. */
function withContent(node: JxMutableNode, children: Content): JxMutableNode {
  const { children: _drop, textContent: _dropText, ...rest } = node;
  if (children.length === 0) {
    return { ...rest, textContent: "" };
  }
  if (children.length === 1 && typeof children[0] === "string") {
    return { ...rest, textContent: children[0] };
  }
  return { ...rest, children };
}

/**
 * Merge adjacent plain strings and drop empties, so a spliced result does not carry the seams of
 * how it was built. Mirrors the normalization a contenteditable commit performs.
 */
export function normalizeContent(children: Content): Content {
  const out: Content = [];
  for (const child of children) {
    if (typeof child === "string") {
      if (child.length === 0) {
        continue;
      }
      const prev = out.at(-1);
      if (typeof prev === "string") {
        out[out.length - 1] = prev + child;
        continue;
      }
    }
    out.push(child);
  }
  return out;
}

/**
 * The content a block should hold after `[from, to)` is replaced by `text`, where `head` is the
 * block the range starts in and `tail` the block it ends in.
 *
 * Collapsing a cross-block range is the same shape as a merge: keep the head's prefix, keep the
 * tail's suffix, and join them — with any typed replacement between.
 */
export function spliceAcross(
  head: Content,
  from: number,
  tail: Content,
  to: number,
  text = "",
): Content {
  return normalizeContent([
    ...sliceContent(head, 0, from),
    ...(text ? [text] : []),
    ...sliceContent(tail, to, contentLength(tail)),
  ]);
}

/** `{ children }` when the content carries markup, else the folded `{ textContent }` form. */
export function toStored(children: Content): {
  children?: Content;
  textContent?: string;
} {
  const normalized = normalizeContent(children);
  if (normalized.length === 0) {
    return { textContent: "" };
  }
  if (normalized.length === 1 && typeof normalized[0] === "string") {
    return { textContent: normalized[0] };
  }
  return { children: normalized };
}
