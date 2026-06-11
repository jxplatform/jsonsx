/// <reference lib="dom" />
/**
 * Inline-format.js — Inline formatting engine for contenteditable editing
 *
 * Handles toggling inline formatting (bold, italic, code, etc.) with proper wrap/unwrap logic, DOM
 * normalization, and whitespace management.
 */

/** Tags considered inline formatting wrappers */
const FORMAT_TAGS = new Set([
  "strong",
  "em",
  "b",
  "i",
  "u",
  "del",
  "s",
  "strike",
  "code",
  "sub",
  "sup",
  "span",
]);

/**
 * Check whether `tag` is currently active on both ends of the selection. Walks from anchor and
 * focus nodes up to editableRoot looking for the tag. Returns false if selection is outside
 * editableRoot or in plaintext-only mode.
 *
 * @param {string} tag
 * @param {HTMLElement | null} editableRoot
 * @returns {boolean}
 */
export function isTagActiveInSelection(tag: string, editableRoot: HTMLElement | null) {
  if (!editableRoot) {
    return false;
  }
  if (editableRoot.contentEditable === "plaintext-only") {
    return false;
  }
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) {
    return false;
  }

  const anchor = sel.anchorNode;
  const focus = sel.focusNode;
  if (!anchor || !focus) {
    return false;
  }
  if (!editableRoot.contains(anchor) || !editableRoot.contains(focus)) {
    return false;
  }

  /**
   * @param {Node | null} node
   * @returns {boolean}
   */
  const hasTag = (node: Node | null) => {
    while (node && node !== editableRoot) {
      if (node.nodeType === Node.ELEMENT_NODE && (node as Element).tagName.toLowerCase() === tag) {
        return true;
      }
      node = node.parentNode;
    }
    return false;
  };

  return hasTag(anchor) && hasTag(focus);
}

/**
 * Toggle an inline format tag on/off for the current selection. If the tag is active → unwrap. If
 * not → wrap.
 *
 * @param {string} tag
 * @param {HTMLElement | null} editableRoot
 */
export function toggleInlineFormat(tag: string, editableRoot: HTMLElement | null) {
  if (!editableRoot) {
    return;
  }
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) {
    return;
  }
  const range = sel.getRangeAt(0);
  if (range.collapsed) {
    return;
  }
  if (!editableRoot.contains(range.commonAncestorContainer)) {
    return;
  }

  // Expand selection to fully include any partially-selected ${...} expressions
  expandRangeToTemplateExpressions(range);

  // Find all elements matching `tag` that intersect the selection
  const matches = findIntersectingElements(tag, range, editableRoot);

  if (matches.length > 0) {
    unwrapTagInRange(tag, range, editableRoot, matches);
  } else {
    wrapRangeInTag(tag, range, editableRoot);
  }

  normalizeInlineContent(editableRoot);
}

/**
 * Find all elements with the given tag that intersect the selection range.
 *
 * @param {string} tag
 * @param {Range} range
 * @param {HTMLElement} root
 * @returns {Element[]}
 */
function findIntersectingElements(tag: string, range: Range, root: HTMLElement) {
  const matches: Element[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, {
    /**
     * @param {Node} node
     * @returns {number}
     */
    acceptNode(node: Node) {
      if ((node as Element).tagName.toLowerCase() === tag && range.intersectsNode(node)) {
        return NodeFilter.FILTER_ACCEPT;
      }
      return NodeFilter.FILTER_SKIP;
    },
  });
  while (walker.nextNode()) {
    matches.push(walker.currentNode as Element);
  }
  return matches;
}

/**
 * Unwrap all instances of `tag` within the range. Processes in reverse document order to preserve
 * earlier offsets.
 *
 * @param {string} tag
 * @param {Range} range
 * @param {HTMLElement} editableRoot
 * @param {Element[]} matches
 */
function unwrapTagInRange(
  tag: string,
  range: Range,
  editableRoot: HTMLElement,
  matches: Element[],
) {
  // Process in reverse so DOM mutations don't shift later nodes
  for (let i = matches.length - 1; i >= 0; i--) {
    const el = matches[i];
    unwrapElement(el);
  }
}

/**
 * Replace an element with its children (unwrap).
 *
 * @param {Element} el
 */
function unwrapElement(el: Element) {
  const parent = el.parentNode;
  if (!parent) {
    return;
  }
  const frag = document.createDocumentFragment();
  while (el.firstChild) {
    frag.append(el.firstChild);
  }
  parent.replaceChild(frag, el);
}

/**
 * Wrap the current selection range in a new element of the given tag. Handles whitespace:
 * leading/trailing whitespace stays outside the wrapper.
 *
 * @param {string} tag
 * @param {Range} range
 * @param {HTMLElement} _editableRoot
 */
function wrapRangeInTag(tag: string, range: Range, _editableRoot: HTMLElement) {
  const contents = range.extractContents();

  // Trim leading whitespace from the fragment
  const leadingWS = trimLeadingWhitespace(contents);
  // Trim trailing whitespace from the fragment
  const trailingWS = trimTrailingWhitespace(contents);

  // If nothing left after trimming, re-insert everything and bail
  if (!contents.hasChildNodes()) {
    if (leadingWS) {
      range.insertNode(document.createTextNode(leadingWS));
    }
    if (trailingWS) {
      const t = document.createTextNode(trailingWS);
      range.collapse(false);
      range.insertNode(t);
    }
    return;
  }

  const wrapper = document.createElement(tag);
  wrapper.append(contents);

  // Build the insertion fragment: [leadingWS] [wrapper] [trailingWS]
  const frag = document.createDocumentFragment();
  if (leadingWS) {
    frag.append(document.createTextNode(leadingWS));
  }
  frag.append(wrapper);
  if (trailingWS) {
    frag.append(document.createTextNode(trailingWS));
  }

  range.insertNode(frag);

  // Restore selection around the wrapper's contents
  const sel = window.getSelection();
  if (sel) {
    sel.removeAllRanges();
    const newRange = document.createRange();
    newRange.selectNodeContents(wrapper);
    sel.addRange(newRange);
  }
}

/**
 * Remove and return leading whitespace from a document fragment. Only trims if the first node is a
 * text node starting with whitespace.
 *
 * @param {DocumentFragment} frag
 * @returns {string | null}
 */
function trimLeadingWhitespace(frag: DocumentFragment) {
  const first = frag.firstChild;
  if (!first || first.nodeType !== Node.TEXT_NODE) {
    return null;
  }
  const text = first.textContent ?? "";
  const match = text.match(/^(\s+)/);
  if (!match) {
    return null;
  }
  const ws = match[1];
  if (text.length === ws.length) {
    // Entire node is whitespace — remove it
    frag.removeChild(first);
  } else {
    first.textContent = text.slice(ws.length);
  }
  return ws;
}

/**
 * Remove and return trailing whitespace from a document fragment. Only trims if the last node is a
 * text node ending with whitespace.
 *
 * @param {DocumentFragment} frag
 * @returns {string | null}
 */
function trimTrailingWhitespace(frag: DocumentFragment) {
  const last = frag.lastChild;
  if (!last || last.nodeType !== Node.TEXT_NODE) {
    return null;
  }
  const text = last.textContent ?? "";
  const match = text.match(/(\s+)$/);
  if (!match) {
    return null;
  }
  const ws = match[1];
  if (text.length === ws.length) {
    frag.removeChild(last);
  } else {
    last.textContent = text.slice(0, -ws.length);
  }
  return ws;
}

// ─── Normalization ─────────────────────────────────────────────────────────────

/**
 * Normalize the inline content of an editable root. Merges adjacent same-tag siblings, collapses
 * redundant nesting, removes empty inline elements, and lifts edge whitespace. Runs to
 * fixed-point.
 *
 * @param {HTMLElement | null} root
 */
export function normalizeInlineContent(root: HTMLElement | null) {
  if (!root) {
    return;
  }
  let changed = true;
  let iterations = 0;
  while (changed && iterations < 10) {
    changed = false;
    iterations++;

    // 1. Merge adjacent text nodes
    root.normalize();

    // 2. Merge adjacent same-tag siblings
    if (mergeAdjacentSiblings(root)) {
      changed = true;
    }

    // 3. Collapse redundant nesting (strong > strong → strong)
    if (collapseRedundantNesting(root)) {
      changed = true;
    }

    // 4. Remove empty inline elements
    if (removeEmptyInlines(root)) {
      changed = true;
    }

    // 5. Lift edge whitespace out of inline wrappers
    if (liftEdgeWhitespace(root)) {
      changed = true;
    }

    // 6. Unwrap bare <span> elements (no class, style, or attributes)
    if (unwrapBareSpans(root)) {
      changed = true;
    }
  }
}

/**
 * Merge adjacent sibling elements with the same tag name. E.g.,
 * <strong>a</strong><strong>b</strong> → <strong>ab</strong>
 *
 * @param {HTMLElement} root
 * @returns {boolean}
 */
function mergeAdjacentSiblings(root: HTMLElement) {
  let changed = false;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
  const toMerge: [Element, Element][] = [];

  // Collect pairs first to avoid mutation during walk
  while (walker.nextNode()) {
    const el = walker.currentNode as Element;
    const next = el.nextSibling;
    if (
      next &&
      next.nodeType === Node.ELEMENT_NODE &&
      (next as Element).tagName === el.tagName &&
      FORMAT_TAGS.has(el.tagName.toLowerCase()) &&
      attributesMatch(el, next as Element)
    ) {
      toMerge.push([el, next as Element]);
    }
  }

  // Process in reverse to preserve earlier offsets
  for (let i = toMerge.length - 1; i >= 0; i--) {
    const [el, next] = toMerge[i];
    // Move all children from next into el
    while (next.firstChild) {
      el.append(next.firstChild);
    }
    next.remove();
    changed = true;
  }
  return changed;
}

/**
 * Collapse redundant nesting where a parent and its only child share the same tag. E.g.,
 * <strong><strong>x</strong></strong> → <strong>x</strong>
 *
 * @param {HTMLElement} root
 * @returns {boolean}
 */
function collapseRedundantNesting(root: HTMLElement) {
  let changed = false;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
  const toCollapse: Element[] = [];

  while (walker.nextNode()) {
    const el = walker.currentNode as Element;
    if (!FORMAT_TAGS.has(el.tagName.toLowerCase())) {
      continue;
    }
    // Check if only child is an element with the same tag
    if (
      el.childNodes.length === 1 &&
      el.firstChild !== null &&
      el.firstChild.nodeType === Node.ELEMENT_NODE &&
      (el.firstChild as Element).tagName === el.tagName
    ) {
      toCollapse.push(el);
    }
  }

  for (const el of toCollapse) {
    const inner = el.firstChild as Element;
    // Replace outer with inner's children
    while (inner.firstChild) {
      el.insertBefore(inner.firstChild, inner);
    }
    el.removeChild(inner);
    changed = true;
  }
  return changed;
}

/**
 * Remove empty inline elements.
 *
 * @param {HTMLElement} root
 * @returns {boolean}
 */
function removeEmptyInlines(root: HTMLElement) {
  let changed = false;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
  const toRemove: Element[] = [];

  while (walker.nextNode()) {
    const el = walker.currentNode as Element;
    if (!FORMAT_TAGS.has(el.tagName.toLowerCase())) {
      continue;
    }
    if (el.childNodes.length === 0 && !el.textContent) {
      toRemove.push(el);
    }
  }

  for (const el of toRemove) {
    el.remove();
    changed = true;
  }
  return changed;
}

/**
 * Lift leading/trailing whitespace out of inline wrapper elements. E.g., <strong> text </strong> →
 * " "<strong>text</strong>" "
 *
 * @param {HTMLElement} root
 * @returns {boolean}
 */
function liftEdgeWhitespace(root: HTMLElement) {
  let changed = false;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
  /** @type {{ type: string; el: Element; ws: string }[]} */
  const ops = [];

  while (walker.nextNode()) {
    const el = walker.currentNode as Element;
    if (!FORMAT_TAGS.has(el.tagName.toLowerCase())) {
      continue;
    }
    if (el === root) {
      continue;
    }

    const first = el.firstChild;
    if (first && first.nodeType === Node.TEXT_NODE) {
      const text = first.textContent ?? "";
      const m = text.match(/^(\s+)/);
      if (m && text.length > m[1].length) {
        ops.push({ el, type: "lift-leading", ws: m[1] });
      }
    }

    const last = el.lastChild;
    if (last && last.nodeType === Node.TEXT_NODE && last !== first) {
      const text = last.textContent ?? "";
      const m = text.match(/(\s+)$/);
      if (m && text.length > m[1].length) {
        ops.push({ el, type: "lift-trailing", ws: m[1] });
      }
    }
  }

  for (const op of ops) {
    if (op.type === "lift-leading") {
      const firstChild = op.el.firstChild as Text;
      firstChild.textContent = (firstChild.textContent ?? "").slice(op.ws.length);
      op.el.parentNode?.insertBefore(document.createTextNode(op.ws), op.el);
      changed = true;
    } else if (op.type === "lift-trailing") {
      const lastChild = op.el.lastChild as Text;
      lastChild.textContent = (lastChild.textContent ?? "").slice(0, -op.ws.length);
      op.el.parentNode?.insertBefore(document.createTextNode(op.ws), op.el.nextSibling);
      changed = true;
    }
  }
  return changed;
}

/**
 * Unwrap bare <span> elements that have no class, style, or meaningful attributes. These are
 * semantically empty wrappers left over from formatting operations.
 *
 * @param {HTMLElement} root
 * @returns {boolean}
 */
function unwrapBareSpans(root: HTMLElement) {
  let changed = false;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
  const toUnwrap: Element[] = [];

  while (walker.nextNode()) {
    const el = walker.currentNode as Element;
    if (el.tagName.toLowerCase() !== "span") {
      continue;
    }
    if (el === root) {
      continue;
    }
    // Keep spans with class, style, or any attributes
    if (el.attributes.length > 0) {
      continue;
    }
    toUnwrap.push(el);
  }

  for (const el of toUnwrap) {
    unwrapElement(el);
    changed = true;
  }
  return changed;
}

/**
 * Check if two elements have matching attributes (for merge eligibility). For simple formatting
 * tags, attributes don't matter. For <a>, href must match.
 *
 * @param {Element} a
 * @param {Element} b
 * @returns {boolean}
 */
function attributesMatch(a: Element, b: Element) {
  const tag = a.tagName.toLowerCase();
  if (tag === "a") {
    return a.getAttribute("href") === b.getAttribute("href");
  }
  // For simple format tags, always match
  return true;
}

// ─── Template expression preservation ─────────────────────────────────────────

/**
 * Expand a Range so that it fully includes any `${...}` template expressions that are partially
 * selected. Template expressions are atomic in Jx — if split across inline elements, the template
 * string breaks.
 *
 * Scans the text content of the start and end containers for `${...}` patterns and adjusts the
 * range boundaries outward to include the complete expression.
 *
 * @param {Range} range
 */
export function expandRangeToTemplateExpressions(range: Range) {
  expandBoundary(range, true); // Start
  expandBoundary(range, false); // End
}

/**
 * Expand one boundary (start or end) of a range to avoid splitting a ${...}. `isStart` = true
 * adjusts startContainer/startOffset, `isStart` = false adjusts endContainer/endOffset.
 *
 * @param {Range} range
 * @param {boolean} isStart
 */
function expandBoundary(range: Range, isStart: boolean) {
  const node = isStart ? range.startContainer : range.endContainer;
  const offset = isStart ? range.startOffset : range.endOffset;
  if (node.nodeType !== Node.TEXT_NODE) {
    return;
  }

  const text = node.textContent ?? "";

  // Find all ${...} expression spans in this text node (supporting nested braces)
  const exprs = findTemplateExpressions(text);
  for (const expr of exprs) {
    // Expr = { start, end } — character indices of "$" and the closing "}" + 1
    if (isStart) {
      // If the range starts inside this expression, move it to include the whole expr
      if (offset > expr.start && offset < expr.end) {
        range.setStart(node, expr.start);
      }
    } else {
      // If the range ends inside this expression, expand to include the whole expr
      if (offset > expr.start && offset < expr.end) {
        range.setEnd(node, expr.end);
      }
    }
  }
}

/**
 * Find all `${...}` expression spans in a string, handling nested braces. Returns array of { start,
 * end } where start is the index of '$' and end is one past the closing '}'.
 *
 * @param {string} text
 * @returns {{ start: number; end: number }[]}
 */
export function findTemplateExpressions(text: string) {
  /** @type {{ start: number; end: number }[]} */
  const results = [];
  let i = 0;
  while (i < text.length - 1) {
    if (text[i] === "$" && text[i + 1] === "{") {
      const start = i;
      let depth = 1;
      let j = i + 2;
      while (j < text.length && depth > 0) {
        if (text[j] === "{") {
          depth++;
        } else if (text[j] === "}") {
          depth--;
        }
        j++;
      }
      if (depth === 0) {
        results.push({ end: j, start });
        i = j;
        continue;
      }
    }
    i++;
  }
  return results;
}
