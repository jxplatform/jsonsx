/**
 * Inline-edit.js — Contenteditable inline editing for content mode
 *
 * Manages the lifecycle of editing text-bearing block elements directly on the canvas. Handles rich
 * text formatting, Enter for new paragraphs, and slash commands for inserting elements.
 */

import elementsMeta from "../../data/elements-meta.json";
import { toggleInlineFormat, normalizeInlineContent } from "./inline-format";
import type { JxPath } from "../state";
import type { JxMutableNode } from "@jxsuite/schema/types";
export interface InlineAction {
  tag: string;
  label: string;
  icon?: string;
  command?: string;
  shortcut?: string;
}

interface ElementDef {
  $inlineChildren?: string[];
  $inlineActions?: InlineAction[] | string;
}

export interface SlashCommand {
  label: string;
  tag: string;
  description: string;
}

export interface JxContentResult {
  textContent?: string | null;
  children?: (JxMutableNode | string)[];
}

import {
  showSlashMenu as sharedShowSlashMenu,
  dismissSlashMenu as sharedDismissSlashMenu,
  isSlashMenuOpen,
} from "./slash-menu";

// ─── Inline tag set (tags that represent rich text formatting) ─────────────

/** Fallback set — used when parent context is unknown */
const INLINE_TAGS = new Set([
  "em",
  "strong",
  "del",
  "code",
  "a",
  "span",
  "br",
  "img",
  "b",
  "i",
  "u",
  "sub",
  "sup",
  "s",
]);

/** Tags that can be edited inline (text-bearing block elements) */
const EDITABLE_BLOCKS = new Set([
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "p",
  "li",
  "td",
  "th",
  "blockquote",
  "span",
  "a",
  "label",
]);

// ─── Context-aware inline scoping ─────────────────────────────────────────

/**
 * Check if a child tag is inline within the context of a given parent tag. Uses $inlineChildren
 * from elements-meta.json.
 *
 * @param {string} childTag
 * @param {string} parentTag
 * @returns {boolean}
 */
export function isInlineInContext(childTag: string, parentTag: string) {
  if (!parentTag) return INLINE_TAGS.has(childTag);
  const parentDef = (elementsMeta.$defs as Record<string, ElementDef>)[parentTag];
  if (!parentDef || !parentDef.$inlineChildren) return false;
  return parentDef.$inlineChildren.includes(childTag);
}

/**
 * Get the resolved $inlineActions for a given element tag. Follows string references (e.g., "h1" →
 * look up h1's actions).
 *
 * @param {string} tag
 * @returns {InlineAction[] | null}
 */
export function getInlineActions(tag: string) {
  const def = (elementsMeta.$defs as Record<string, ElementDef>)[tag];
  if (!def) return null;
  let actions = def.$inlineActions;
  if (typeof actions === "string") {
    const refDef = (elementsMeta.$defs as Record<string, ElementDef>)[actions];
    actions = refDef?.$inlineActions ?? undefined;
  }
  if (!Array.isArray(actions)) return null;
  return actions;
}

// ─── Editing state ─────────────────────────────────────────────────────────

let activeEl: HTMLElement | null = null; // currently contenteditable element
let activePath: JxPath | null = null; // JSON path to the active element
/**
 * @type {((
 *       path: JxPath,
 *       children: (JxMutableNode | string)[] | null,
 *       textContent: string | null,
 *     ) => void)
 *   | null}
 */
let commitFn:
  | ((
      path: JxPath,
      children: (JxMutableNode | string)[] | null,
      textContent: string | null,
    ) => void)
  | null = null; // function(path, newChildren, newTextContent) to commit changes
/**
 * @type {((path: JxPath, beforeChildren: JxContentResult, afterChildren: JxContentResult) => void)
 *   | null}
 */
let splitFn:
  | ((path: JxPath, beforeChildren: JxContentResult, afterChildren: JxContentResult) => void)
  | null = null; // function(path, beforeChildren, afterChildren) to split paragraph
/**
 * @type {((path: JxPath, elementDef: SlashCommand, commitData?: JxContentResult) => void)
 *   | null}
 */
let insertFn:
  | ((path: JxPath, elementDef: SlashCommand, commitData?: JxContentResult) => void)
  | null = null; // function(path, elementDef, commitData?) to insert after current block
let endFn: (() => void) | null = null; // function() called when editing stops

/**
 * Check if an element is a text-bearing editable block.
 *
 * @param {HTMLElement} el
 * @returns {boolean}
 */
export function isEditableBlock(el: HTMLElement) {
  return EDITABLE_BLOCKS.has(el.tagName.toLowerCase());
}

/**
 * Check if a node is an inline child. When parentNode is provided, uses context-aware scoping from
 * metadata. Without parent, uses the fallback INLINE_TAGS set.
 *
 * @param {JxMutableNode} node
 * @param {JxMutableNode} [parentNode]
 * @returns {boolean}
 */
export function isInlineElement(node: JxMutableNode, parentNode?: JxMutableNode) {
  if (!node || typeof node !== "object") return false;
  const childTag = (node.tagName ?? "div").toLowerCase();
  if (parentNode) {
    const parentTag = (parentNode.tagName ?? "div").toLowerCase();
    return isInlineInContext(childTag, parentTag);
  }
  return INLINE_TAGS.has(childTag);
}

/**
 * Start inline editing on a canvas element.
 *
 * @param {HTMLElement} el - The canvas DOM element to edit
 * @param {JxPath} path - JSON path to the element
 * @param {{
 *   onCommit: (
 *     path: JxPath,
 *     children: (JxMutableNode | string)[] | null,
 *     textContent: string | null,
 *   ) => void;
 *   onSplit: (
 *     path: JxPath,
 *     beforeChildren: JxContentResult,
 *     afterChildren: JxContentResult,
 *   ) => void;
 *   onInsert: (path: JxPath, elementDef: SlashCommand, commitData?: JxContentResult) => void;
 *   onEnd: () => void;
 * }} callbacks
 */
export function startEditing(
  el: HTMLElement,
  path: JxPath,
  callbacks: {
    onCommit: (
      path: JxPath,
      children: (JxMutableNode | string)[] | null,
      textContent: string | null,
    ) => void;
    onSplit: (
      path: JxPath,
      beforeChildren: JxContentResult,
      afterChildren: JxContentResult,
    ) => void;
    onInsert: (path: JxPath, elementDef: SlashCommand, commitData?: JxContentResult) => void;
    onEnd: () => void;
  },
) {
  if (activeEl) stopEditing();

  activeEl = el;
  activePath = path;
  commitFn = callbacks.onCommit;
  splitFn = callbacks.onSplit;
  insertFn = callbacks.onInsert;
  endFn = callbacks.onEnd;

  // Enable editing
  el.contentEditable = "true";
  el.style.pointerEvents = "auto";
  el.style.outline = "2px solid var(--accent, #4a9eff)";
  el.style.outlineOffset = "1px";
  el.style.cursor = "text";
  el.focus();

  // Place cursor at end
  const sel = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(el);
  range.collapse(false);
  if (sel) {
    sel.removeAllRanges();
    sel.addRange(range);
  }

  el.addEventListener("keydown", handleKeydown);
  el.addEventListener("input", handleInput);
  el.addEventListener("blur", handleBlur);
  el.addEventListener("paste", handlePaste);
}

/** Stop editing and commit changes. */
export function stopEditing() {
  if (!activeEl) return;

  commitChanges();
  sharedDismissSlashMenu();

  activeEl.contentEditable = "false";
  activeEl.style.pointerEvents = "";
  activeEl.style.outline = "";
  activeEl.style.outlineOffset = "";
  activeEl.style.cursor = "";

  activeEl.removeEventListener("keydown", handleKeydown);
  activeEl.removeEventListener("input", handleInput);
  activeEl.removeEventListener("blur", handleBlur);
  activeEl.removeEventListener("paste", handlePaste);

  activeEl = null;
  activePath = null;
  commitFn = null;
  splitFn = null;
  insertFn = null;

  if (endFn) {
    const fn = endFn;
    endFn = null;
    fn();
  }
}

/**
 * Whether inline editing is currently active.
 *
 * @returns {boolean}
 */
export function isEditing() {
  return activeEl !== null;
}

/**
 * Get the currently editing element.
 *
 * @returns {HTMLElement | null}
 */
export function getActiveElement() {
  return activeEl;
}

// ─── Event handlers ────────────────────────────────────────────────────────

/** @param {KeyboardEvent} e */
function handleKeydown(e: KeyboardEvent) {
  if (e.key === "Escape") {
    e.preventDefault();
    e.stopPropagation();
    stopEditing();
    return;
  }

  if (e.key === "Enter" && !e.shiftKey) {
    if (isSlashMenuOpen()) return; // shared slash menu captures Enter
    e.preventDefault();
    e.stopPropagation();
    handleEnterKey();
    return;
  }

  // Slash command trigger
  if (e.key === "/" && !e.ctrlKey && !e.metaKey) {
    // Check if at start of empty block or after a space/newline
    const sel = window.getSelection();
    if (sel && sel.rangeCount > 0) {
      const range = sel.getRangeAt(0);
      const textBefore = getTextBeforeCursor(range);
      if (textBefore === "" || textBefore.endsWith(" ") || textBefore.endsWith("\n")) {
        // Let the / character be typed, then show menu on next input
        requestAnimationFrame(() => openSlashMenu());
        return;
      }
    }
  }

  // Rich text shortcuts
  if (e.ctrlKey || e.metaKey) {
    switch (e.key) {
      case "b":
        e.preventDefault();
        toggleInlineFormat("strong", activeEl);
        break;
      case "i":
        e.preventDefault();
        toggleInlineFormat("em", activeEl);
        break;
      case "`":
        e.preventDefault();
        toggleInlineFormat("code", activeEl);
        break;
    }
  }

  // Dismiss slash menu on non-matching keys
  if (
    isSlashMenuOpen() &&
    !["ArrowUp", "ArrowDown", "Enter", "Backspace", "Delete"].includes(e.key)
  ) {
    // Let the input handler deal with filtering
  }
}

function handleInput() {
  // Check if slash menu should update or dismiss
  if (isSlashMenuOpen()) {
    updateSlashMenu();
  }
}

/** @param {FocusEvent} _e */
function handleBlur(_e: FocusEvent) {
  // Don't close if focus moved to slash menu
  if (isSlashMenuOpen()) return;

  // Delay to allow click events to fire
  setTimeout(() => {
    if (activeEl && document.activeElement !== activeEl) {
      stopEditing();
    }
  }, 150);
}

/** @param {ClipboardEvent} e */
function handlePaste(e: ClipboardEvent) {
  e.preventDefault();
  // Paste as plain text to avoid foreign HTML
  const text = e.clipboardData?.getData("text/plain") ?? "";
  document.execCommand("insertText", false, text);
}

// ─── Enter key: split paragraph ────────────────────────────────────────────

function handleEnterKey() {
  if (!splitFn || !activeEl || !activePath) return;

  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return;

  const range = sel.getRangeAt(0);

  // Create two ranges: before cursor and after cursor
  const beforeRange = document.createRange();
  beforeRange.setStart(activeEl, 0);
  beforeRange.setEnd(range.startContainer, range.startOffset);

  const afterRange = document.createRange();
  afterRange.setStart(range.endContainer, range.endOffset);
  afterRange.setEnd(activeEl, activeEl.childNodes.length);

  // Extract content from both ranges
  const beforeFrag = beforeRange.cloneContents();
  const afterFrag = afterRange.cloneContents();

  const beforeChildren = fragmentToJx(beforeFrag);
  const afterChildren = fragmentToJx(afterFrag);

  // Stop editing before mutating state (which will re-render)
  const path = [...activePath];
  const split = splitFn;

  activeEl.contentEditable = "false";
  activeEl.removeEventListener("keydown", handleKeydown);
  activeEl.removeEventListener("input", handleInput);
  activeEl.removeEventListener("blur", handleBlur);
  activeEl.removeEventListener("paste", handlePaste);
  activeEl = null;
  activePath = null;
  commitFn = null;
  splitFn = null;
  insertFn = null;

  if (endFn) {
    const fn = endFn;
    endFn = null;
    fn();
  }

  split(path, beforeChildren, afterChildren);
}

// ─── Content sync: DOM → Jx ────────────────────────────────────────────

function commitChanges() {
  if (!commitFn || !activeEl || !activePath) return;

  normalizeInlineContent(activeEl);
  const result = elementToJx(activeEl);
  commitFn(activePath, result.children ?? null, result.textContent ?? null);
}

/**
 * Normalize a node's children array: merge adjacent text nodes and fold all-text children into
 * textContent. Returns `{ textContent }` or `{ children }`.
 *
 * @param {{ children?: (JxMutableNode | string)[] }} node
 * @returns {JxContentResult}
 */
export function normalizeChildren(node: { children?: (JxMutableNode | string)[] }) {
  if (!Array.isArray(node.children) || node.children.length === 0) return { textContent: "" };

  // Step 1: Merge adjacent text nodes
  const merged = [];
  for (const child of node.children) {
    if (
      typeof child === "string" &&
      merged.length > 0 &&
      typeof merged[merged.length - 1] === "string"
    ) {
      merged[merged.length - 1] += child;
    } else {
      merged.push(child);
    }
  }

  // Step 2: If all children are text, fold into textContent
  if (merged.every((c: JxMutableNode | string) => typeof c === "string")) {
    return { textContent: merged.join("") };
  }

  return { children: merged };
}

/**
 * Convert a contenteditable element's content to Jx children/textContent. Returns { textContent }
 * for plain text or { children } for rich content.
 *
 * @param {HTMLElement} el
 * @returns {JxContentResult}
 */
function elementToJx(el: HTMLElement): JxContentResult {
  const nodes = el.childNodes;

  // If just a single text node, use textContent
  if (nodes.length === 0) return { textContent: "" };
  if (nodes.length === 1 && nodes[0].nodeType === Node.TEXT_NODE) {
    return { textContent: nodes[0].textContent };
  }

  // Mixed content → children array
  const children: (JxMutableNode | string)[] = [];
  for (const child of nodes) {
    const jsx = domNodeToJx(child);
    if (jsx !== null && jsx !== undefined) children.push(jsx);
  }

  // Normalize: merge adjacent text nodes + fold all-text to textContent
  return normalizeChildren({ children });
}

/**
 * Convert a DOM node to a Jx element definition.
 *
 * @param {Node} node
 * @returns {JxMutableNode | string | null}
 */
function domNodeToJx(node: Node) {
  if (node.nodeType === Node.TEXT_NODE) {
    const text = node.textContent;
    if (!text) return null;
    return text; // Bare string — text node child
  }

  if (node.nodeType !== Node.ELEMENT_NODE) return null;

  const el = node as HTMLElement;
  const tag = el.tagName.toLowerCase();
  const result: JxMutableNode = { tagName: tag };

  // Map browser execCommand output to our tag conventions
  const tagMap: Record<string, string> = { b: "strong", i: "em", s: "del", strike: "del" };
  if (tagMap[tag]) result.tagName = tagMap[tag];

  // Attributes
  if (tag === "a" && (el as HTMLAnchorElement).href) {
    result.attributes = { href: el.getAttribute("href") };
    if ((el as HTMLAnchorElement).title) result.attributes.title = (el as HTMLAnchorElement).title;
  }
  if (tag === "code") {
    result.textContent = el.textContent;
    return result;
  }

  // Recurse children
  const childNodes = el.childNodes;
  if (childNodes.length === 0) {
    result.textContent = "";
  } else if (childNodes.length === 1 && childNodes[0].nodeType === Node.TEXT_NODE) {
    result.textContent = childNodes[0].textContent;
  } else {
    result.children = [];
    for (const child of childNodes) {
      const jsx = domNodeToJx(child);
      if (jsx) result.children.push(/** @type {JxMutableNode} */ (jsx));
    }
  }

  return result;
}

/**
 * Convert a DocumentFragment to a Jx-compatible structure. Returns { textContent } or { children }.
 *
 * @param {DocumentFragment} frag
 * @returns {JxContentResult}
 */
function fragmentToJx(frag: DocumentFragment) {
  const nodes = frag.childNodes;
  if (nodes.length === 0) return { textContent: "" };
  if (nodes.length === 1 && nodes[0].nodeType === Node.TEXT_NODE) {
    return { textContent: nodes[0].textContent };
  }

  const children: (JxMutableNode | string)[] = [];
  for (const child of nodes) {
    const jsx = domNodeToJx(child);
    if (jsx) children.push(jsx);
  }

  if (
    children.length === 1 &&
    typeof children[0] !== "string" &&
    children[0].tagName === "span" &&
    children[0].textContent != null
  ) {
    return { textContent: children[0].textContent };
  }

  return children.length > 0 ? { children } : { textContent: "" };
}

// ─── Rich text helpers ─────────────────────────────────────────────────────

/**
 * @param {Range} range
 * @returns {string}
 */
function getTextBeforeCursor(range: Range) {
  const preRange = document.createRange();
  preRange.setStart(activeEl!, 0);
  preRange.setEnd(range.startContainer, range.startOffset);
  return preRange.toString();
}

// ─── Slash command menu (delegates to shared slash-menu.js) ──────────────

/** Track the character offset where "/" was typed so we can detect backspace-past-slash */
let _slashFilterStart = 0;

function openSlashMenu() {
  if (!activeEl || !insertFn || !activePath) return;

  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return;
  const range = sel.getRangeAt(0);
  _slashFilterStart = getTextBeforeCursor(range).length;

  sharedShowSlashMenu(activeEl, "", { onSelect: handleSlashSelect });
}

function updateSlashMenu() {
  if (!activeEl) return;

  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) {
    sharedDismissSlashMenu();
    return;
  }

  const range = sel.getRangeAt(0);
  const fullText = getTextBeforeCursor(range);
  const slashIdx = fullText.lastIndexOf("/");

  if (slashIdx < 0 || fullText.length < _slashFilterStart - 1) {
    sharedDismissSlashMenu();
    return;
  }

  const filter = fullText.slice(slashIdx + 1).toLowerCase();
  sharedShowSlashMenu(activeEl, filter, { onSelect: handleSlashSelect });
}

/** @param {SlashCommand} cmd */
function handleSlashSelect(cmd: SlashCommand) {
  if (!activeEl || !insertFn || !activePath) return;

  // Remove the /command text from the element
  const sel = window.getSelection();
  if (sel && sel.rangeCount) {
    const range = sel.getRangeAt(0);
    const fullText = getTextBeforeCursor(range);
    const slashIdx = fullText.lastIndexOf("/");
    if (slashIdx >= 0) {
      const walker = document.createTreeWalker(activeEl, NodeFilter.SHOW_TEXT);
      let charCount = 0;
      let slashNode: Text | null = null;
      let slashOffset = 0;
      while (walker.nextNode()) {
        const node = walker.currentNode as Text;
        if (charCount + node.length > slashIdx) {
          slashNode = node;
          slashOffset = slashIdx - charCount;
          break;
        }
        charCount += node.length;
      }
      if (slashNode) {
        const delRange = document.createRange();
        delRange.setStart(slashNode, slashOffset);
        delRange.setEnd(range.startContainer, range.startOffset);
        delRange.deleteContents();
      }
    }
  }

  // Compute commit data inline instead of calling commitChanges() — avoids a separate
  // update() call that would race with the insertFn update() (two concurrent async renders).
  normalizeInlineContent(activeEl);
  const commitResult = elementToJx(activeEl);

  const path = [...activePath];
  const insert = insertFn;

  activeEl.contentEditable = "false";
  activeEl.removeEventListener("keydown", handleKeydown);
  activeEl.removeEventListener("input", handleInput);
  activeEl.removeEventListener("blur", handleBlur);
  activeEl.removeEventListener("paste", handlePaste);
  activeEl = null;
  activePath = null;
  commitFn = null;
  splitFn = null;
  insertFn = null;

  if (endFn) {
    const fn = endFn;
    endFn = null;
    fn();
  }

  // Pass commit data so onInsert can batch commit + insert into a single update()
  insert(path, cmd, commitResult);
}
