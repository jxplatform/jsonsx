/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
/**
 * Inline-edit.js — Contenteditable inline editing for content mode
 *
 * Manages the lifecycle of editing text-bearing block elements directly on the canvas. Handles rich
 * text formatting, Enter for new paragraphs, and slash commands for inserting elements.
 */

import elementsMeta from "../../data/elements-meta.json";
import { displayTagName } from "@jxsuite/schema/guards";
import { normalizeInlineContent } from "./inline-format";
import { isEditableTag } from "./editable-tags";
import type { EditableVerdicts } from "./editable-tags";
import type { JxPath } from "../state";
import type { JxMutableNode } from "@jxsuite/schema/types";

/**
 * The slash-menu surface inline editing drives. Injected (rather than imported) so this module
 * stays free of the menu's heavy `lit-html` / `ui/layers` dependencies — the editor realm wires the
 * real menu, the canvas iframe supplies its own (or a no-op) without bloating the slim iframe
 * bundle.
 */
export interface SlashController {
  show: (
    anchorEl: HTMLElement,
    filter: string,
    cbs: { onSelect: (cmd: SlashCommand) => void; showFilter?: boolean; commands?: SlashCommand[] },
  ) => void;
  dismiss: () => void;
  isOpen: () => boolean;
}

const noopSlash: SlashController = {
  dismiss: () => {
    // No slash controller wired in this realm.
  },
  isOpen: () => false,
  show: () => {
    // No slash controller wired in this realm.
  },
};
let slash: SlashController = noopSlash;

/** Inject the slash-menu controller inline editing should drive (call once at realm init). */
export function setSlashController(controller: SlashController): void {
  slash = controller;
}

export interface InlineAction {
  tag: string;
  label: string;
  icon?: string;
  command?: string;
  /**
   * REMOVED from the data, and the field stays only so an older `elements-meta.json` still parses.
   *
   * It held `"Cmd+B"` — a mac spelling, printed verbatim into every tooltip on every platform,
   * which is the hardcoded-chord defect plan §5.3 exists to kill. The chord now lives on the
   * `format.*` record (`panels/block-action-bar.ts`) and is formatted by the keymap's one
   * formatter. Nothing reads this.
   */
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
  if (!parentTag) {
    return INLINE_TAGS.has(childTag);
  }
  const parentDef = (elementsMeta.$defs as Record<string, ElementDef>)[parentTag];
  if (!parentDef || !parentDef.$inlineChildren) {
    return false;
  }
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
  if (!def) {
    return null;
  }
  let actions = def.$inlineActions;
  if (typeof actions === "string") {
    const refDef = (elementsMeta.$defs as Record<string, ElementDef>)[actions];
    actions = refDef?.$inlineActions ?? undefined;
  }
  if (!Array.isArray(actions)) {
    return null;
  }
  return actions;
}

// ─── Editing state ─────────────────────────────────────────────────────────

let activeEl: HTMLElement | null = null; // Currently contenteditable element
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
      inPlace: boolean,
    ) => void)
  | null = null; // Function(path, newChildren, newTextContent, inPlace) to commit changes
/**
 * @type {((path: JxPath, beforeChildren: JxContentResult, afterChildren: JxContentResult) => void)
 *   | null}
 */
let splitFn:
  | ((path: JxPath, beforeChildren: JxContentResult, afterChildren: JxContentResult) => void)
  | null = null; // Function(path, beforeChildren, afterChildren) to split paragraph
/**
 * @type {((path: JxPath, elementDef: SlashCommand, commitData?: JxContentResult) => void)
 *   | null}
 */
let insertFn:
  | ((path: JxPath, elementDef: SlashCommand, commitData?: JxContentResult) => void)
  | null = null; // Function(path, elementDef, commitData?) to insert after current block
let endFn: (() => void) | null = null; // Function() called when editing stops

/**
 * Plain (plaintext-only) session state — used for prop-bound text, where the committed value is a
 * plain string (a directive attribute), so rich formatting, Enter-split, and the slash menu are all
 * disabled: Enter commits, Escape restores `_plainOriginal` and commits unchanged (the host no-ops
 * an unchanged prop value).
 */
let _plainMode = false;
let _plainOriginal = "";

/**
 * The live document's format overrides for which tags hold a caret. Injected per render (the same
 * shape as `setSlashController`), because the answer depends on the document's format class — a
 * `.md` page and a native `.json` component have different vocabularies.
 */
let editableVerdicts: EditableVerdicts = null;

/** Adopt the format's per-tag caret verdicts for the live render (null = built-in metadata only). */
export function setEditableVerdicts(verdicts: EditableVerdicts): void {
  editableVerdicts = verdicts;
}

/**
 * Whether an element can hold a text caret.
 *
 * Derived from the document's element vocabulary rather than a hand-maintained list — see
 * {@link file://./editable-tags.ts}.
 */
export function isEditableBlock(el: HTMLElement) {
  return isEditableTag(el.tagName, editableVerdicts);
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
  if (!node || typeof node !== "object") {
    return false;
  }
  const childTag = (displayTagName(node.tagName) || "div").toLowerCase();
  if (parentNode) {
    const parentTag = (displayTagName(parentNode.tagName) || "div").toLowerCase();
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
 * @param {{ plainText?: boolean }} [opts] - `plainText` runs a plaintext-only session (prop-bound
 *   text: no rich formatting/split/slash; Enter commits, Escape cancels)
 */
export function startEditing(
  el: HTMLElement,
  path: JxPath,
  callbacks: {
    onCommit: (
      path: JxPath,
      children: (JxMutableNode | string)[] | null,
      textContent: string | null,
      inPlace: boolean,
    ) => void;
    onSplit: (
      path: JxPath,
      beforeChildren: JxContentResult,
      afterChildren: JxContentResult,
    ) => void;
    onInsert: (path: JxPath, elementDef: SlashCommand, commitData?: JxContentResult) => void;
    onEnd: () => void;
  },
  opts?: { plainText?: boolean },
) {
  if (activeEl) {
    // Re-enter (e.g. after a split/insert re-render): tear the old session down WITHOUT firing the
    // User-visible `onEnd` — a re-enter must not reset the parent toolbar via a stray `editEnd`.
    stopEditing(true);
  }

  activeEl = el;
  activePath = path;
  commitFn = callbacks.onCommit;
  splitFn = callbacks.onSplit;
  insertFn = callbacks.onInsert;
  endFn = callbacks.onEnd;
  _plainMode = opts?.plainText === true;
  _plainOriginal = _plainMode ? (el.textContent ?? "") : "";

  // Mark the caret's block so the empty-block slash hint can target it. The editing host itself is
  // The canvas container (see syncEditableRoot) — activating a block does NOT make it a separate
  // Contenteditable, which is exactly what lets the caret cross block boundaries natively.
  //
  // A prop-bound block is the one exception: it lives inside a `contenteditable="false"` component
  // Island, so it needs its own nested editing host to be reachable at all.
  el.dataset.jxActiveBlock = "";
  if (_plainMode) {
    try {
      el.contentEditable = "plaintext-only";
    } catch {
      // Engines without plaintext-only support throw on assignment; paste is already plain via
      // HandlePaste, and the keydown plain branch inertifies the format shortcuts.
      el.contentEditable = "true";
    }
    el.focus();
  }

  // The caret is NOT moved here. It is already wherever the user clicked or arrowed to — moving it
  // To the end of the block (as this used to) is precisely what made editing feel modal.

  el.addEventListener("keydown", handleKeydown);
  el.addEventListener("input", handleInput);
  el.addEventListener("paste", handlePaste);
}

/**
 * Stop editing and commit changes. Pass `silent` to skip the `onEnd` callback (used by the re-enter
 * path so a stop→start sequence doesn't post a user-visible `editEnd`).
 *
 * @param {boolean} [silent]
 */
export function stopEditing(silent = false) {
  if (!activeEl) {
    return;
  }

  commitChanges(false);
  slash.dismiss();

  delete activeEl.dataset.jxActiveBlock;
  // Only a prop-bound block ever claimed its own editing host; page blocks are edited through the
  // Container's, which must stay editable after the caret leaves this block.
  if (_plainMode) {
    activeEl.contentEditable = "false";
  }

  activeEl.removeEventListener("keydown", handleKeydown);
  activeEl.removeEventListener("input", handleInput);
  activeEl.removeEventListener("paste", handlePaste);

  activeEl = null;
  activePath = null;
  commitFn = null;
  splitFn = null;
  insertFn = null;
  _plainMode = false;
  _plainOriginal = "";

  if (silent) {
    endFn = null;
  } else if (endFn) {
    const fn = endFn;
    endFn = null;
    fn();
  }
}

/**
 * Commit the active block's content to the document WITHOUT releasing it.
 *
 * The idle-tick counterpart to {@link stopEditing}: the caret stays exactly where it is and the
 * block stays active, so typing continues uninterrupted while the document keeps up. Callers are
 * responsible for preserving the caret across the DOM normalization this performs — the editing
 * host does that in model coordinates (see `commitTick`).
 *
 * A no-op when nothing is active, and the apply side no-ops an unchanged value, so calling this on
 * every pause is cheap.
 */
export function commitActiveBlock(): void {
  commitChanges(true);
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

/**
 * Get the document path of the currently editing element (null when no session is live).
 *
 * @returns {JxPath | null}
 */
export function getActivePath() {
  return activePath;
}

/**
 * Whether the DI'd slash menu reports itself open — session-lifecycle guards must not commit-and-
 * end on a pointerdown that is really a slash-menu interaction.
 *
 * @returns {boolean}
 */
export function isSlashActive() {
  return slash.isOpen();
}

// ─── Event handlers ────────────────────────────────────────────────────────

/** @param {KeyboardEvent} e */
function handleKeydown(e: KeyboardEvent) {
  if (_plainMode) {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      if (activeEl) {
        // Cancel: restore the original text; the commit posts the unchanged value (host no-ops).
        activeEl.textContent = _plainOriginal;
      }
      stopEditing();
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      stopEditing();
      return;
    }
    // Inertify the browser's native rich shortcuts for the contentEditable="true" fallback.
    if ((e.ctrlKey || e.metaKey) && ["b", "i", "u", "`"].includes(e.key)) {
      e.preventDefault();
    }
  }

  // Escape and Enter are NOT handled here. Enter arrives as a `beforeinput` (`insertParagraph`),
  // Which is the one place structural intent is classified; Escape belongs to the editing host,
  // Which owns dismissing the caret. See {@link file://../canvas/iframe-editable-root.ts}.
  //
  // Neither is the "/" gesture, and neither are the format chords. Both used to be here, and
  // Both were DEAD: this listener is attached to the BLOCK, and for an ordinary block the editing
  // Host is the canvas container (see {@link startEditing}), so the focused element — and every
  // Keydown's target — is the container, never a descendant of it. The "/" trigger is
  // {@link handleSlashTrigger}, driven from the host; the format chords are `format.*` records
  // Whose chords the frame forwards (`canvas/iframe-keys.ts`). A revived copy here would have
  // Toggled bold twice per press.
}

function handleInput() {
  // Check if slash menu should update or dismiss
  if (slash.isOpen()) {
    refreshSlashMenu();
  }
}

/** @param {ClipboardEvent} e */
function handlePaste(e: ClipboardEvent) {
  e.preventDefault();
  // Paste as plain text to avoid foreign HTML
  const text = e.clipboardData?.getData("text/plain") ?? "";
  document.execCommand("insertText", false, text);
}

// ─── Enter: split the active block ─────────────────────────────────────────

/**
 * Split the active block at the caret, reporting the two halves through `onSplit`.
 *
 * Called from the editing host's `beforeinput` chokepoint (`insertParagraph`), never from a keydown
 * — Enter is a structural intent, and `beforeinput` is the one place those are recognised.
 *
 * A non-collapsed selection INSIDE the block is dropped by construction: the "before" half ends at
 * the selection's start and the "after" half begins at its end. A selection spanning two blocks is
 * the caller's to reject (the `after` range could not be built against this block).
 *
 * The active block is released WITHOUT committing — the split writes both halves itself, and a
 * commit racing it would re-apply the pre-split text over the first one. Returns false when there
 * is nothing to split.
 */
export function splitActiveBlock(): boolean {
  if (!splitFn || !activeEl || !activePath) {
    return false;
  }

  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) {
    return false;
  }

  const range = sel.getRangeAt(0);

  const beforeRange = document.createRange();
  beforeRange.setStart(activeEl, 0);
  beforeRange.setEnd(range.startContainer, range.startOffset);

  const afterRange = document.createRange();
  afterRange.setStart(range.endContainer, range.endOffset);
  afterRange.setEnd(activeEl, activeEl.childNodes.length);

  const beforeChildren = fragmentToJx(beforeRange.cloneContents());
  const afterChildren = fragmentToJx(afterRange.cloneContents());

  const path = [...activePath];
  const split = splitFn;

  releaseWithoutCommit();
  split(path, beforeChildren, afterChildren);
  return true;
}

/**
 * Drop the active block's bookkeeping without committing it, firing `onEnd`. Used by the paths that
 * write the block's content themselves (split, slash-insert) — a commit afterwards would clobber
 * what they just wrote.
 */
function releaseWithoutCommit(): void {
  if (!activeEl) {
    return;
  }
  delete activeEl.dataset.jxActiveBlock;
  if (_plainMode) {
    activeEl.contentEditable = "false";
  }
  activeEl.removeEventListener("keydown", handleKeydown);
  activeEl.removeEventListener("input", handleInput);
  activeEl.removeEventListener("paste", handlePaste);
  activeEl = null;
  activePath = null;
  commitFn = null;
  splitFn = null;
  insertFn = null;
  _plainMode = false;
  _plainOriginal = "";

  if (endFn) {
    const fn = endFn;
    endFn = null;
    fn();
  }
}

// ─── Content sync: DOM → Jx ────────────────────────────────────────────

/**
 * Serialize the active block and hand it to `onCommit`.
 *
 * `inPlace` distinguishes the idle tick (the caret is still in this block) from a release. The
 * parent uses it to suppress the DOM half of the echoed patch, so a commit mid-typing cannot
 * re-render the subtree the caret lives in.
 */
function commitChanges(inPlace: boolean) {
  if (!commitFn || !activeEl || !activePath) {
    return;
  }

  if (_plainMode) {
    // A prop value is a plain single-line string (a directive attribute) — flatten any newline
    // That survived plaintext editing and skip the rich DOM→Jx serialization entirely.
    commitFn(activePath, null, (activeEl.textContent ?? "").replaceAll("\n", " "), inPlace);
    return;
  }

  normalizeInlineContent(activeEl);
  const result = elementToJx(activeEl);
  commitFn(activePath, result.children ?? null, result.textContent ?? null, inPlace);
}

/**
 * Normalize a node's children array: merge adjacent text nodes and fold all-text children into
 * textContent. Returns `{ textContent }` or `{ children }`.
 *
 * @param {{ children?: (JxMutableNode | string)[] }} node
 * @returns {JxContentResult}
 */
export function normalizeChildren(node: { children?: (JxMutableNode | string)[] }) {
  if (!Array.isArray(node.children) || node.children.length === 0) {
    return { textContent: "" };
  }

  // Step 1: Merge adjacent text nodes
  const merged = [];
  for (const child of node.children) {
    if (typeof child === "string" && merged.length > 0 && typeof merged.at(-1) === "string") {
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
  if (nodes.length === 0) {
    return { textContent: "" };
  }
  if (nodes.length === 1 && nodes[0]!.nodeType === Node.TEXT_NODE) {
    return { textContent: nodes[0]!.textContent };
  }

  // Mixed content → children array
  const children: (JxMutableNode | string)[] = [];
  for (const child of nodes) {
    const jsx = domNodeToJx(child);
    if (jsx !== null && jsx !== undefined) {
      children.push(jsx);
    }
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
    if (!text) {
      return null;
    }
    return text; // Bare string — text node child
  }

  if (node.nodeType !== Node.ELEMENT_NODE) {
    return null;
  }

  const el = node as HTMLElement;
  const tag = el.tagName.toLowerCase();
  const result: JxMutableNode = { tagName: tag };

  // Map browser execCommand output to our tag conventions
  const tagMap: Record<string, string> = {
    b: "strong",
    i: "em",
    s: "del",
    strike: "del",
  };
  if (tagMap[tag]) {
    result.tagName = tagMap[tag];
  }

  // Attributes
  // A canvas anchor is DE-LINKED in design/edit: the runtime stamps its URL as `data-jx-href` so a
  // Click selects the anchor instead of navigating the iframe (see setCanvasDelinkAnchors). Reading
  // Only `href` here would serialize every edited link as `[text]()` — silently destroying the URL
  // Of any paragraph that happens to contain one.
  const href = el.dataset.jxHref ?? el.getAttribute("href");
  if (tag === "a" && href != null) {
    result.attributes = { href };
    if ((el as HTMLAnchorElement).title) {
      result.attributes.title = (el as HTMLAnchorElement).title;
    }
  }
  if (tag === "code") {
    result.textContent = el.textContent;
    return result;
  }

  // Recurse children
  const { childNodes } = el;
  if (childNodes.length === 0) {
    result.textContent = "";
  } else if (childNodes.length === 1 && childNodes[0]!.nodeType === Node.TEXT_NODE) {
    result.textContent = childNodes[0]!.textContent;
  } else {
    result.children = [];
    for (const child of childNodes) {
      const jsx = domNodeToJx(child);
      if (jsx) {
        result.children.push(/** @type {JxMutableNode} */ jsx);
      }
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
  if (nodes.length === 0) {
    return { textContent: "" };
  }
  if (nodes.length === 1 && nodes[0]!.nodeType === Node.TEXT_NODE) {
    return { textContent: nodes[0]!.textContent };
  }

  const children: (JxMutableNode | string)[] = [];
  for (const child of nodes) {
    const jsx = domNodeToJx(child);
    if (jsx) {
      children.push(jsx);
    }
  }

  if (
    children.length === 1 &&
    typeof children[0] !== "string" &&
    children[0]!.tagName === "span" &&
    typeof children[0]!.textContent === "string"
  ) {
    return { textContent: children[0]!.textContent };
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

/**
 * Whether a literal "/" in the block anchors the open menu.
 *
 * False when the menu was opened BY NAME — `insert.openSlashMenu`, the palette, the automation
 * runner — where there is no slash in the text at all. Two behaviours hang off it, and both are
 * wrong without it: the filter would be re-derived from the text before the caret and dismiss the
 * menu on the very next keystroke, and selecting a block would delete everything from the previous
 * slash in the line ("and/or…") back to the caret. A command-opened menu filters in its own field
 * and deletes nothing.
 */
let _slashAnchored = true;

/**
 * Open the slash menu at the caret.
 *
 * Exported because the block-level `keydown` listener that used to call it never fires: for an
 * ordinary block the editing host is the canvas container, so the "/" gesture is recognised at the
 * host ({@link handleSlashTrigger}) and a command opens it from the other realm entirely.
 *
 * @param opts.anchored Whether a literal "/" precedes the caret. See {@link _slashAnchored}.
 */
export function openSlashMenu(opts?: { anchored?: boolean }): void {
  if (!activeEl || !insertFn || !activePath) {
    return;
  }

  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) {
    return;
  }
  const range = sel.getRangeAt(0);
  _slashAnchored = opts?.anchored !== false;
  _slashFilterStart = getTextBeforeCursor(range).length;

  // An unanchored menu carries its own filter field: there is no "/…" run in the document for the
  // Author to type into, so without one the list could only ever be filtered by scrolling it.
  slash.show(activeEl, "", {
    onSelect: handleSlashSelect,
    ...(_slashAnchored ? {} : { showFilter: true }),
  });
}

/**
 * The "/" gesture, driven from the EDITING HOST.
 *
 * A slash opens the menu at the start of a block or after a space — anywhere else it is punctuation
 * ("and/or"), and a menu there would be an ambush. The character is allowed to land first, so the
 * document holds what the author typed whether or not they pick anything from the list.
 */
export function handleSlashTrigger(e: KeyboardEvent): void {
  if (e.key !== "/" || e.ctrlKey || e.metaKey || !activeEl) {
    return;
  }
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) {
    return;
  }
  const textBefore = getTextBeforeCursor(sel.getRangeAt(0));
  if (textBefore === "" || textBefore.endsWith(" ") || textBefore.endsWith("\n")) {
    requestAnimationFrame(() => openSlashMenu());
  }
}

/**
 * Re-filter an open menu from the text the author has typed after the "/".
 *
 * Exported for the same reason {@link openSlashMenu} is: the `input` listener that called it is on
 * the block, and a contenteditable's `input` targets the editing HOST.
 */
export function refreshSlashMenu(): void {
  if (!activeEl || !_slashAnchored) {
    // The menu owns its own filter field; the document has no "/…" run to derive one from, and
    // Deriving one would dismiss the menu on the first character.
    return;
  }

  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) {
    slash.dismiss();
    return;
  }

  const range = sel.getRangeAt(0);
  const fullText = getTextBeforeCursor(range);
  const slashIdx = fullText.lastIndexOf("/");

  if (slashIdx === -1 || fullText.length < _slashFilterStart - 1) {
    slash.dismiss();
    return;
  }

  const filter = fullText.slice(slashIdx + 1).toLowerCase();
  slash.show(activeEl, filter, { onSelect: handleSlashSelect });
}

/** @param {SlashCommand} cmd */
function handleSlashSelect(cmd: SlashCommand) {
  if (!activeEl || !insertFn || !activePath) {
    return;
  }

  /* Remove the "/command" run the author typed — but ONLY when a "/" is what opened the menu.
     An unanchored menu (opened by name, from the palette or `insert.openSlashMenu`) has no such
     run, and this walk would delete from the last slash ANYWHERE earlier in the block back to the
     caret: type "and/or" and pick Heading, and "or" goes with it. */
  const sel = _slashAnchored ? window.getSelection() : null;
  if (sel && sel.rangeCount) {
    const range = sel.getRangeAt(0);
    const fullText = getTextBeforeCursor(range);
    const slashIdx = fullText.lastIndexOf("/");
    if (slashIdx !== -1) {
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
  // Update() call that would race with the insertFn update() (two concurrent async renders).
  normalizeInlineContent(activeEl);
  const commitResult = elementToJx(activeEl);

  const path = [...activePath];
  const insert = insertFn;

  // The insert carries `commitResult`, so it writes this block's content itself — releasing without
  // A commit keeps the two from racing.
  releaseWithoutCommit();

  // Pass commit data so onInsert can batch commit + insert into a single update()
  insert(path, cmd, commitResult);
}
