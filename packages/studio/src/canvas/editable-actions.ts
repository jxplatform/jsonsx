/**
 * The `beforeinput` chokepoint — pure policy, no DOM.
 *
 * With `contenteditable` on the canvas root, the browser natively gives us caret-from-click,
 * line-aware arrow motion, Home/End, IME, and cross-block drag-select. What it must NOT be allowed
 * to do is RESTRUCTURE the document: splitting a paragraph, merging two blocks, or deleting across
 * a block boundary are document mutations that have to go through `transactDoc` so they land in the
 * source, the undo history, and the collab stream.
 *
 * So every `beforeinput` is classified here. Edits confined to one block run natively (the browser
 * is better at text insertion than we are, and preventing them would break IME); everything
 * structural is prevented and re-expressed as a document mutation. Keeping the decision pure means
 * the whole matrix is unit-testable as plain data — happy-dom cannot faithfully dispatch
 * `beforeinput`, so this is the layer where correctness is actually pinned down.
 *
 * Reference: the `inputType` vocabulary is the UI Events / Input Events spec.
 *
 * @docs studio/editing/writing
 */

import { samePath } from "./iframe-position";
import type { DocPos } from "./iframe-position";

/** What the editable root should do with a `beforeinput` event. */
export type EditAction =
  /** Let the browser apply it — the edit stays inside one block. */
  | { kind: "native" }
  /** Split the block at `from`, first removing `[from, to)` when the selection was not collapsed. */
  | { kind: "split"; from: DocPos; to: DocPos }
  /** Backspace at the start of a block: merge it into the previous block. */
  | { kind: "mergeBackward"; at: DocPos }
  /** Delete at the end of a block: merge the next block into it. */
  | { kind: "mergeForward"; at: DocPos }
  /** Replace everything in `[from, to)` with `text` (possibly spanning blocks). */
  | { kind: "replaceRange"; from: DocPos; to: DocPos; text: string }
  /** Suppress entirely — the browser must not act, and neither do we. */
  | { kind: "reject" };

/** Everything the classifier needs about one `beforeinput`, resolved to model coordinates. */
export interface BeforeInputContext {
  inputType: string;
  /** Start of the affected range in document coordinates; null when outside any editable block. */
  from: DocPos | null;
  /** End of the affected range; equals `from` for a collapsed caret. */
  to: DocPos | null;
  /** Whether `from` sits at offset 0 of its block. */
  atBlockStart: boolean;
  /** Whether `to` sits at the end of its block's text. */
  atBlockEnd: boolean;
  /** The event's `data` (inserted text), empty for deletions. */
  data: string;
}

/**
 * Deletions that walk BACKWARD. At a block start every one of them means the same thing — join this
 * block onto the previous — regardless of how much text the granularity would have eaten.
 */
const DELETE_BACKWARD = new Set([
  "deleteContentBackward",
  "deleteWordBackward",
  "deleteSoftLineBackward",
  "deleteHardLineBackward",
]);

/** Deletions that walk FORWARD; at a block end they all mean "pull the next block up into this one". */
const DELETE_FORWARD = new Set([
  "deleteContentForward",
  "deleteWordForward",
  "deleteSoftLineForward",
  "deleteHardLineForward",
]);

/** Deletions with an explicit range that never collapse into a boundary merge on their own. */
const DELETE_RANGE = new Set(["deleteByCut", "deleteContent"]);

/** Insertions that put plain text at the selection (the paste handler has already sanitized). */
const INSERT_TEXT = new Set([
  "insertText",
  "insertReplacementText",
  "insertFromPaste",
  "insertFromPasteAsQuotation",
  "insertFromYank",
  "insertTranspose",
]);

/**
 * Formatting the browser would apply itself (native ⌘B, the macOS text menu, a spellcheck panel).
 * Jx owns inline formatting through `toggleInlineFormat`, which emits the tags the document model
 * expects — letting the engine insert its own `<b>`/`<font>` would put foreign markup in the
 * source.
 */
const NATIVE_FORMAT_PREFIX = "format";

/**
 * Classify one `beforeinput`.
 *
 * The order of the checks is the contract: 1. composition is untouchable (preventing it breaks IME
 * mid-word), 2. positions must resolve, else nothing may happen, 3. structural intents (paragraph
 * split, boundary merge) are recognised BEFORE 4. the cross-block test, which catches every
 * remaining multi-block edit, and finally 5. anything left is confined to one block and runs
 * natively.
 */
export function classifyBeforeInput(ctx: BeforeInputContext): EditAction {
  const { inputType, from, to } = ctx;

  // 1. IME composition — never intercept. The browser owns the composing region until it commits,
  // And a preventDefault here strands the candidate window.
  if (inputType === "insertCompositionText" || inputType === "insertFromComposition") {
    return { kind: "native" };
  }

  // History belongs to `transactDoc`'s op log, not the contenteditable's own undo stack — letting
  // The engine undo would desync the DOM from the document.
  if (inputType === "historyUndo" || inputType === "historyRedo") {
    return { kind: "reject" };
  }

  if (inputType.startsWith(NATIVE_FORMAT_PREFIX)) {
    return { kind: "reject" };
  }

  // Drag-and-drop inside the canvas is the block action bar's drag handle, not a text drag.
  if (inputType === "insertFromDrop" || inputType === "deleteByDrag") {
    return { kind: "reject" };
  }

  // 2. No resolvable position means the caret is in canvas chrome or a `contenteditable="false"`
  // Island — there is no document node to write to.
  if (!from || !to) {
    return { kind: "reject" };
  }

  const collapsed = samePath(from, to) && from.offset === to.offset;
  const crossBlock = !samePath(from, to);

  // 3a. Enter — always a split, whether or not it replaces a selection.
  if (inputType === "insertParagraph") {
    return { from, kind: "split", to };
  }

  // 3b. Shift+Enter inserts a `<br>` inside the block; only a cross-block selection makes it
  // Structural, and that case falls through to the range replace below.
  if (inputType === "insertLineBreak" && !crossBlock) {
    return { kind: "native" };
  }

  // 3c. Boundary merges — only for a COLLAPSED caret. With a selection, the deletion has real
  // Content to remove and is a range operation instead.
  if (collapsed && DELETE_BACKWARD.has(inputType) && ctx.atBlockStart) {
    return { at: from, kind: "mergeBackward" };
  }
  if (collapsed && DELETE_FORWARD.has(inputType) && ctx.atBlockEnd) {
    return { at: from, kind: "mergeForward" };
  }

  // 4. Anything still spanning two blocks is a range replace: insertions carry their text, deletions
  // Replace with nothing.
  if (crossBlock) {
    if (INSERT_TEXT.has(inputType) || inputType === "insertLineBreak") {
      return { from, kind: "replaceRange", text: ctx.data, to };
    }
    if (
      DELETE_BACKWARD.has(inputType) ||
      DELETE_FORWARD.has(inputType) ||
      DELETE_RANGE.has(inputType)
    ) {
      return { from, kind: "replaceRange", text: "", to };
    }
    // An unrecognised inputType across a block boundary is not worth guessing at.
    return { kind: "reject" };
  }

  // 5. Single-block text edits — the browser does them better than we would.
  if (
    INSERT_TEXT.has(inputType) ||
    DELETE_BACKWARD.has(inputType) ||
    DELETE_FORWARD.has(inputType) ||
    DELETE_RANGE.has(inputType)
  ) {
    return { kind: "native" };
  }

  // Unknown inputType inside one block: allow it. New engine behaviours are far more often ordinary
  // Text editing than structural surgery, and the MutationObserver net catches the exceptions.
  return { kind: "native" };
}
