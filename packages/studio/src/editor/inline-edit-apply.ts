/// <reference lib="dom" />
/**
 * Inline-edit apply logic — turns the serializable result of a contenteditable session (committed
 * children/text, a split, or a slash-insert) into `transactDoc` mutations. The inline editing
 * session lives inside the canvas iframe, which posts these plain-JSON results across the bridge
 * for this apply. Every input here is plain JSON — no DOM, no Range — so it crosses the frame
 * boundary.
 */

import { childIndex, getNodeAtPath, parentElementPath } from "../store";
import { isAncestor } from "../state";
import { isTabActive } from "../workspace/workspace";
import {
  mutateInsertNode,
  mutateRemoveNode,
  mutateUpdateProp,
  mutateUpdateProperty,
  transactDoc,
} from "../tabs/transact";
import { defaultDef } from "../panels/shared";

import { contentLength, contentOf, spliceAcross, toStored } from "./content-slice";
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
  opts: { coalesceKey?: string | null } = {},
): void {
  if (!tab) {
    return;
  }
  const node = getNodeAtPath(tab.doc.document, path);
  // Only clear the counterpart key when it actually exists: deleting an absent key is a semantic
  // No-op, but the recorded op isn't — a spurious `set-prop children` turns a cheap in-place text
  // Patch into a subtree re-render (and, pre-relaxation, forced a full render inside components).
  if (children) {
    if (node && JSON.stringify(node.children) === JSON.stringify(children)) {
      return;
    }
    transactDoc(
      tab,
      (t) => {
        if (node?.textContent != null) {
          mutateUpdateProperty(t, path, "textContent");
        }
        mutateUpdateProperty(t, path, "children", children);
      },
      { coalesceKey: opts.coalesceKey ?? null },
    );
  } else if (textContent != null) {
    if (node && node.textContent === textContent && !node.children) {
      return;
    }
    transactDoc(
      tab,
      (t) => {
        if (node?.children) {
          mutateUpdateProperty(t, path, "children");
        }
        mutateUpdateProperty(t, path, "textContent", textContent);
      },
      { coalesceKey: opts.coalesceKey ?? null },
    );
  }
}

/**
 * Commit a prop-bound inline edit: persist `value` into `$props[prop]` of the component instance at
 * `path`. The unchanged-value no-op is LOAD-BEARING, not cosmetic: Escape-cancel and
 * patch-disturbed sessions post unchanged values, and without the equality check a commit→patch→
 * disturb→re-commit cycle loops (and pollutes undo history). An empty value deletes the prop
 * (mutateUpdateProp), reverting the instance to the definition default — same as clearing the
 * sidebar field.
 *
 * @returns Whether it transacted. The caller needs to know: an in-place commit's patch is
 *   echo-suppressed so the caret survives, and the release that follows is expected to re-render
 *   the instance for real. When the release posts the same value it no-ops here, nothing
 *   re-renders, and the canvas keeps showing pre-edit output — see the reconcile in iframe-host.
 */
export function applyInlinePropCommit(
  tab: Tab | null,
  path: JxPath,
  prop: string,
  value: string,
): boolean {
  if (!tab) {
    return false;
  }
  const node = getNodeAtPath(tab.doc.document, path);
  if (!node) {
    return false;
  }
  const current = (node.$props as Record<string, unknown> | undefined)?.[prop];
  if (`${current ?? ""}` === value) {
    return false;
  }
  transactDoc(tab, (t) => {
    mutateUpdateProp(t, path, prop, value);
  });
  return true;
}

/**
 * Join the block at `fromPath` onto the end of the block at `intoPath`, removing the former.
 *
 * Backspace at a block's start and Delete at a block's end are the same operation approached from
 * either side, so both land here. Returns the caret's document position at the seam — the join
 * point, not the end — or null when the merge was refused.
 *
 * Refused when either block is missing, or when one contains the other: a `<li>` and the `<p>`
 * inside it are adjacent in document order but merging them would mean a node absorbing its own
 * parent.
 */
export function applyBlockMerge(
  tab: Tab | null,
  fromPath: JxPath,
  intoPath: JxPath,
): { path: JxPath; offset: number } | null {
  if (!tab) {
    return null;
  }
  const from = getNodeAtPath(tab.doc.document, fromPath) as JxMutableNode | undefined;
  const into = getNodeAtPath(tab.doc.document, intoPath) as JxMutableNode | undefined;
  if (!from || !into) {
    return null;
  }
  if (isAncestor(fromPath, intoPath) || isAncestor(intoPath, fromPath)) {
    return null;
  }

  const head = contentOf(into);
  const tail = contentOf(from);
  const seam = contentLength(head);
  const merged = toStored([...head, ...tail]);

  transactDoc(tab, (t) => {
    // Write the joined content BEFORE removing the source: updating a node never shifts indices,
    // So `fromPath` is still valid when the removal runs.
    if (merged.children) {
      if (into.textContent != null) {
        mutateUpdateProperty(t, intoPath, "textContent");
      }
      mutateUpdateProperty(t, intoPath, "children", merged.children);
    } else {
      if (into.children) {
        mutateUpdateProperty(t, intoPath, "children");
      }
      mutateUpdateProperty(t, intoPath, "textContent", merged.textContent ?? "");
    }
    mutateRemoveNode(t, fromPath);
    // A container emptied by the removal (the `<ul>` behind a list's last item) would otherwise
    // Linger as invisible structure that still occupies layout and shows up in the layers panel.
    pruneEmptyAncestors(t, parentElementPath(fromPath) as JxPath);
    if (isTabActive(tab)) {
      t.session.selection = [intoPath];
    }
  });

  return { offset: seam, path: intoPath };
}

/**
 * Remove `path` and its now-childless ancestors, stopping at the document root or the first
 * ancestor that still has content.
 */
function pruneEmptyAncestors(tab: Tab, path: JxPath): void {
  let cur = path;
  while (cur.length > 0) {
    const node = getNodeAtPath(tab.doc.document, cur) as JxMutableNode | undefined;
    const kids = node?.children;
    if (!node || !Array.isArray(kids) || kids.length > 0) {
      return;
    }
    const parent = parentElementPath(cur) as JxPath | null;
    mutateRemoveNode(tab, cur);
    if (!parent) {
      return;
    }
    cur = parent;
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
      t.session.selection = [newPath];
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
        t.session.selection = [path];
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
      t.session.selection = [newPath];
    }
  });
  return newPath;
}

/**
 * Replace a selection that spans blocks with `text` (empty for a deletion).
 *
 * Collapsing a cross-block range is a merge with both ends clipped: the first block keeps what
 * precedes the selection, the last keeps what follows it, the two are joined, and every block
 * between them is removed. `between` is supplied by the iframe because document order lives in the
 * rendered DOM — the same reason a boundary merge names its neighbour there.
 *
 * Returns the caret's position after the collapse (the join point, plus any typed text), or null
 * when the range does not resolve.
 */
export function applyRangeReplace(
  tab: Tab | null,
  from: { path: JxPath; offset: number },
  to: { path: JxPath; offset: number },
  between: JxPath[],
  text: string,
): { path: JxPath; offset: number } | null {
  if (!tab) {
    return null;
  }
  const head = getNodeAtPath(tab.doc.document, from.path) as JxMutableNode | undefined;
  const tail = getNodeAtPath(tab.doc.document, to.path) as JxMutableNode | undefined;
  if (!head || !tail) {
    return null;
  }
  if (isAncestor(from.path, to.path) || isAncestor(to.path, from.path)) {
    return null;
  }

  const joined = toStored(
    spliceAcross(contentOf(head), from.offset, contentOf(tail), to.offset, text),
  );
  // Remove the deepest/last paths first so an earlier removal cannot shift a later one's index.
  const removals = [...between, to.path].toSorted(comparePathsDescending);

  transactDoc(tab, (t) => {
    if (joined.children) {
      if (head.textContent != null) {
        mutateUpdateProperty(t, from.path, "textContent");
      }
      mutateUpdateProperty(t, from.path, "children", joined.children);
    } else {
      if (head.children) {
        mutateUpdateProperty(t, from.path, "children");
      }
      mutateUpdateProperty(t, from.path, "textContent", joined.textContent ?? "");
    }
    for (const path of removals) {
      if (getNodeAtPath(t.doc.document, path)) {
        mutateRemoveNode(t, path);
        pruneEmptyAncestors(t, parentElementPath(path) as JxPath);
      }
    }
    if (isTabActive(tab)) {
      t.session.selection = [from.path];
    }
  });

  return { offset: from.offset + text.length, path: from.path };
}

/**
 * Order two paths so the LATER one in the document sorts first — the order removals must run in,
 * since removing an earlier sibling renumbers every path after it.
 */
function comparePathsDescending(a: JxPath, b: JxPath): number {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const av = a[i];
    const bv = b[i];
    if (av === bv) {
      continue;
    }
    if (typeof av === "number" && typeof bv === "number") {
      return bv - av;
    }
    return String(bv).localeCompare(String(av));
  }
  return b.length - a.length;
}
