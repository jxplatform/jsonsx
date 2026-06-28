/// <reference lib="dom" />
/**
 * Inline link + template-token application for contenteditable editing.
 *
 * Realm-agnostic: every DOM access uses ambient `window`/`document`, so bundled into the canvas
 * iframe these operate on the iframe realm where the edited DOM (and its Selection) live. The
 * parent format toolbar never calls these — it posts an `applyFormat` intent and the iframe applies
 * it here (Phase 4b-2).
 *
 * `document.execCommand` is uncoverable under happy-dom (no implementation), so it is wrapped in a
 * one-line shim {@link exec} that the branch logic calls; tests stub `document.execCommand` and
 * assert at the stub level (documented as stub-level, not behavioral).
 */

import { normalizeInlineContent } from "./inline-format";

/** The one uncoverable call, isolated so the surrounding branch logic stays unit-testable. */
const exec = (cmd: string, val?: string): boolean => document.execCommand(cmd, false, val);

/**
 * Read the link state of the current selection relative to `root`: walk the selection's anchor node
 * up to `root` looking for an `<a>`. Returns the author-entered `href` attribute (NOT the resolved
 * `.href` property), so relative/templated URLs round-trip unchanged.
 */
export function linkStateForSelection(root: HTMLElement): { active: boolean; href: string | null } {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) {
    return { active: false, href: null };
  }
  let node: Node | null = sel.anchorNode;
  while (node && node !== root) {
    if (node.nodeType === Node.ELEMENT_NODE && (node as Element).tagName.toLowerCase() === "a") {
      return { active: true, href: (node as Element).getAttribute("href") };
    }
    node = node.parentNode;
  }
  return { active: false, href: null };
}

/**
 * Find the `<a>` that contains the selection anchor (up to `root`), if any.
 *
 * @param {HTMLElement} root
 * @returns {HTMLAnchorElement | null}
 */
function anchorInSelection(root: HTMLElement): HTMLAnchorElement | null {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) {
    return null;
  }
  let node: Node | null = sel.anchorNode;
  while (node && node !== root) {
    if (node.nodeType === Node.ELEMENT_NODE && (node as Element).tagName.toLowerCase() === "a") {
      return node as HTMLAnchorElement;
    }
    node = node.parentNode;
  }
  return null;
}

/**
 * Apply (or remove) a link on the current selection within `root`. With an existing `<a>` in the
 * selection: rewrite its `href`, or unwrap it when `href` is null/empty. Otherwise create a link
 * via `execCommand("createLink")`. Always normalizes the inline content afterwards.
 */
export function applyLink(root: HTMLElement, href: string | null): void {
  const existing = anchorInSelection(root);
  if (existing) {
    if (href) {
      existing.setAttribute("href", href);
    } else {
      // Unwrap: replace the anchor with its children, preserving the text.
      const frag = document.createDocumentFragment();
      while (existing.firstChild) {
        frag.append(existing.firstChild);
      }
      existing.replaceWith(frag);
    }
  } else if (href) {
    exec("createLink", href);
  }
  normalizeInlineContent(root);
}

/** Insert a `${token}` template expression at the caret inside `root` (joins the native undo stack). */
export function insertTemplateToken(root: HTMLElement, token: string): void {
  root.focus();
  exec("insertText", `\${${token}}`);
}
