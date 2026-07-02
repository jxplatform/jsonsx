/// <reference lib="dom" />
/**
 * Inline-edit apply logic — turns the serializable result of a contenteditable session (committed
 * children/text, a split, or a slash-insert) into `transactDoc` mutations. The inline editing
 * session lives inside the canvas iframe, which posts these plain-JSON results across the bridge
 * for this apply. Every input here is plain JSON — no DOM, no Range — so it crosses the frame
 * boundary.
 */

import { childIndex, getNodeAtPath, parentElementPath } from "../store";
import { isTabActive } from "../workspace/workspace";
import { mutateInsertNode, mutateUpdateProperty, transactDoc } from "../tabs/transact";
import { defaultDef } from "../panels/shared";

import type { JxContentResult, SlashCommand } from "./inline-edit";
import type { JxPath } from "../state";
import type { Tab } from "../tabs/tab";
import type { JxMutableNode } from "@jxsuite/schema/types";

/**
 * Whether a committed inline-edit result is effectively empty (blank text / lone whitespace /
 * `<br>`).
 */
export function isEmptyContent(commitData?: JxContentResult): boolean {
  if (!commitData) {
    return true;
  }
  if (commitData.textContent != null && commitData.textContent.trim() === "") {
    return true;
  }
  const kids = commitData.children;
  if (!kids) {
    return false;
  }
  if (kids.length === 0) {
    return true;
  }
  if (kids.length === 1 && typeof kids[0] === "string" && kids[0].trim() === "") {
    return true;
  }
  return kids.length === 1 && typeof kids[0] === "object" && kids[0]?.tagName === "br";
}

/**
 * Commit edited content to the node at `path` of `tab`'s document (children when rich, else
 * textContent). No-op if unchanged or the originating tab is gone. `tab` is the tab the edit
 * session belonged to (resolved host-side from the posting iframe) — NEVER the active tab at
 * message time, which may have changed while the commit was in flight.
 */
export function applyInlineCommit(
  tab: Tab | null,
  path: JxPath,
  children: (JxMutableNode | string)[] | null,
  textContent: string | null,
): void {
  if (!tab) {
    return;
  }
  const node = getNodeAtPath(tab.doc.document, path);
  if (children) {
    if (node && JSON.stringify(node.children) === JSON.stringify(children)) {
      return;
    }
    transactDoc(tab, (t) => {
      mutateUpdateProperty(t, path, "textContent");
      mutateUpdateProperty(t, path, "children", children);
    });
  } else if (textContent != null) {
    if (node && node.textContent === textContent && !node.children) {
      return;
    }
    transactDoc(tab, (t) => {
      mutateUpdateProperty(t, path, "children");
      mutateUpdateProperty(t, path, "textContent", textContent);
    });
  }
}

/**
 * Apply a paragraph split to `tab`'s document: keep `before` in the node, insert a new `<p>` with
 * `after`. Returns its path (unchanged when `tab` is gone — the caller may still use it for
 * bookkeeping, but nothing is mutated).
 */
export function applyInlineSplit(
  tab: Tab | null,
  path: JxPath,
  before: JxContentResult,
  after: JxContentResult,
): JxPath {
  const parentPath = parentElementPath(path) as JxPath;
  const idx = childIndex(path) as number;
  const newPath = [...parentPath, "children", idx + 1];
  if (!tab) {
    return newPath;
  }
  const newNode: JxMutableNode = { tagName: "p" };
  if (after.textContent != null) {
    newNode.textContent = after.textContent;
  } else if (after.children) {
    newNode.children = after.children;
  } else {
    newNode.textContent = "";
  }

  transactDoc(tab, (t) => {
    if (before.textContent != null) {
      mutateUpdateProperty(t, path, "children");
      mutateUpdateProperty(t, path, "textContent", before.textContent);
    } else if (before.children) {
      mutateUpdateProperty(t, path, "textContent");
      mutateUpdateProperty(t, path, "children", before.children);
    }
    mutateInsertNode(t, parentPath, idx + 1, newNode);
    // A background tab's selection stays exactly as the user left it — only the visible tab's
    // Selection follows the split.
    if (isTabActive(tab)) {
      t.session.selection = newPath;
    }
  });
  return newPath;
}

/**
 * Apply a slash-insert at `path` of `tab`'s document: swap the (empty) node's tag in place, or
 * commit pending content and insert a new element after it. Returns the path to edit next (the
 * swapped node or the new one); nothing is mutated when `tab` is gone.
 */
export function applyInlineInsert(
  tab: Tab | null,
  path: JxPath,
  cmd: SlashCommand,
  commitData: JxContentResult | undefined,
): JxPath {
  if (isEmptyContent(commitData)) {
    if (!tab) {
      return path;
    }
    transactDoc(tab, (t) => {
      mutateUpdateProperty(t, path, "tagName", cmd.tag);
      mutateUpdateProperty(t, path, "children");
      const def = defaultDef(cmd.tag);
      if (def.textContent && def.textContent !== "Paragraph text") {
        mutateUpdateProperty(t, path, "textContent", def.textContent);
      } else {
        mutateUpdateProperty(t, path, "textContent");
      }
      if (isTabActive(tab)) {
        t.session.selection = path;
      }
    });
    return path;
  }

  const parentPath = parentElementPath(path) as JxPath;
  const idx = childIndex(path) as number;
  const newPath = [...parentPath, "children", idx + 1];
  if (!tab) {
    return newPath;
  }
  const elementDef = defaultDef(cmd.tag);

  transactDoc(tab, (t) => {
    if (commitData?.children) {
      mutateUpdateProperty(t, path, "textContent");
      mutateUpdateProperty(t, path, "children", commitData.children);
    } else if (commitData?.textContent != null) {
      mutateUpdateProperty(t, path, "children");
      mutateUpdateProperty(t, path, "textContent", commitData.textContent);
    }
    mutateInsertNode(t, parentPath, idx + 1, structuredClone(elementDef));
    if (isTabActive(tab)) {
      t.session.selection = newPath;
    }
  });
  return newPath;
}
