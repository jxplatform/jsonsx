/// <reference lib="dom" />
/**
 * In-iframe keyboard forwarding. Studio's shortcuts are bound to the EDITOR document, so once focus
 * moves into the canvas iframe (a click selects a node there) undo/redo/save/delete/duplicate/arrow
 * navigation stop firing. This captures the global-shortcut subset inside the iframe, prevents the
 * browser default, and posts a flattened event the parent re-dispatches to its shortcut handler.
 *
 * The subset mirrors `editor/shortcuts.ts`: any Ctrl/Cmd combo, plus the bare editing/navigation
 * keys. Keystrokes while an editable element (input / contenteditable — e.g. a future inline edit)
 * is focused inside the iframe are left alone so typing still works.
 */

import { cancelIframeDrag, isDragActive } from "./iframe-drop";
import type { IframeChannel } from "./iframe-channel";
import type { IframeToParent, ParentToIframe, SerializedKey } from "./iframe-protocol";

/** Bare (non-modifier) keys the editor's shortcut handler acts on. */
const BARE_FORWARD_KEYS: ReadonlySet<string> = new Set([
  "Delete",
  "Backspace",
  "Escape",
  "Enter",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
]);

/** Whether `el` is a text-entry target whose own keystrokes must not be hijacked. */
function isEditableTarget(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) {
    return false;
  }
  if (el.isContentEditable) {
    return true;
  }
  return el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT";
}

/** Whether this keydown belongs to the global-shortcut subset the parent handles. */
export function shouldForwardKey(e: KeyboardEvent): boolean {
  if (isEditableTarget(e.target)) {
    return false;
  }
  return e.ctrlKey || e.metaKey || BARE_FORWARD_KEYS.has(e.key);
}

/** Flatten a KeyboardEvent to the structured-cloneable subset the bridge carries. */
export function serializeKey(e: KeyboardEvent): SerializedKey {
  return {
    altKey: e.altKey,
    code: e.code,
    ctrlKey: e.ctrlKey,
    key: e.key,
    metaKey: e.metaKey,
    shiftKey: e.shiftKey,
  };
}

/**
 * Listen for global-shortcut keystrokes on the iframe document, prevent their default, and forward
 * them to the parent. Returns a teardown function.
 */
export function startKeyForwarding(
  channel: IframeChannel<IframeToParent, ParentToIframe>,
  doc: Document = document,
): () => void {
  const onKey = (e: KeyboardEvent) => {
    // Escape during a flow-3 (iframe-originated) drag cancels locally — the iframe owns cancel for
    // That case (single-sourced through iframe-drop), so it must NOT also forward Escape to the
    // Parent (which would tear down via a second path and double-fire).
    if (e.key === "Escape" && isDragActive()) {
      e.preventDefault();
      cancelIframeDrag();
      return;
    }
    if (!shouldForwardKey(e)) {
      return;
    }
    e.preventDefault();
    channel.post({ event: serializeKey(e), kind: "forwardKey" });
  };
  doc.addEventListener("keydown", onKey, true);
  return () => doc.removeEventListener("keydown", onKey, true);
}
