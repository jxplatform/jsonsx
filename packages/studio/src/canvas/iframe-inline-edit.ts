/// <reference lib="dom" />
/**
 * In-iframe inline editing — runs the contenteditable session INSIDE the canvas iframe (Selection /
 * Range / execCommand are per-realm singletons bound to their document, so the editing must happen
 * where the edited DOM lives) and posts the serializable results to the parent, which applies them
 * via transactDoc. Double-click enters editing; the parent posts `enterEdit` to re-enter on the new
 * element after a split/insert re-renders.
 *
 * The session machinery (`inline-edit.ts` + `inline-format.ts`) is pure-DOM and uses ambient
 * `window`/`document`, so bundled here it operates on the iframe realm. The slash menu stays a
 * no-op in the iframe for now (the controller is injectable; an in-iframe menu is a later step).
 */

import { isEditableBlock, isEditing, startEditing, stopEditing } from "../editor/inline-edit";
import { restoreTemplateExpressions } from "../utils/edit-display";
import { parseJxPath, serializeJxPath } from "./path-mapping";
import type { IframeChannel } from "./iframe-channel";
import type { IframeToParent, ParentToIframe } from "./iframe-protocol";
import type { JxPath } from "../state";

/** Walk up from an event target to the nearest editable element carrying a `data-jx-path`. */
function findEditableTarget(target: EventTarget | null): { el: HTMLElement; path: JxPath } | null {
  let el = target instanceof Element ? target : null;
  while (el) {
    if (el instanceof HTMLElement && el.dataset.jxPath && isEditableBlock(el)) {
      return { el, path: parseJxPath(el.dataset.jxPath) };
    }
    el = el.parentElement;
  }
  return null;
}

/** Locate the rendered element for a document path via its stamped `data-jx-path`. */
function elementForPath(container: HTMLElement, path: JxPath): HTMLElement | null {
  const serialized = serializeJxPath(path);
  const esc = serialized.replaceAll("\\", String.raw`\\`).replaceAll("'", String.raw`\'`);
  const el = container.querySelector(`[data-jx-path='${esc}']`);
  return el instanceof HTMLElement ? el : null;
}

/**
 * Wire double-click → inline editing on `container`'s editable elements, and handle parent
 * `enterEdit` re-entry. The session's onCommit/onSplit/onInsert/onEnd results are posted to the
 * parent. Returns a teardown function.
 */
export function startIframeInlineEdit(
  channel: IframeChannel<IframeToParent, ParentToIframe>,
  container: HTMLElement,
): () => void {
  const enterEditAt = (el: HTMLElement, path: JxPath) => {
    // Show raw `${expr}` syntax for editing (the render displays it as ❪ expr ❫).
    restoreTemplateExpressions(el);
    channel.post({ kind: "editStart", path });
    startEditing(el, path, {
      onCommit: (p, children, textContent) =>
        channel.post({ children, kind: "editCommit", path: p, textContent }),
      onEnd: () => channel.post({ kind: "editEnd" }),
      onInsert: (p, cmd, commitData) =>
        channel.post({ cmd, commitData, kind: "editInsert", path: p }),
      onSplit: (p, before, after) => channel.post({ after, before, kind: "editSplit", path: p }),
    });
  };

  const doc = container.ownerDocument;
  const onDblClick = (e: Event) => {
    const hit = findEditableTarget(e.target);
    if (hit) {
      enterEditAt(hit.el, hit.path);
    }
  };
  doc.addEventListener("dblclick", onDblClick, true);

  const off = channel.onMessage((msg) => {
    if (msg.kind !== "enterEdit") {
      return;
    }
    const el = elementForPath(container, msg.path);
    if (el && isEditableBlock(el)) {
      enterEditAt(el, msg.path);
    }
  });

  return () => {
    doc.removeEventListener("dblclick", onDblClick, true);
    off();
    if (isEditing()) {
      stopEditing();
    }
  };
}
