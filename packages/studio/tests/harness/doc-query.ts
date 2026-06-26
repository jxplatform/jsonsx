/**
 * Doc-query.js — tiny read helpers for writing outcome assertions against a final Jx document.
 *
 * Outcome assertions (testing-plan §3.1 Completeness) check _what the document became_, independent
 * of which tools the model used to get there.
 *
 * See docs/ai-assistant-headless-harness.md §3 Step 3.
 */

/** Depth-first list of every node in the document (root included). */
export function allNodes(doc: any): any[] {
  const out: any[] = [];
  const walk = (n: any) => {
    if (!n || typeof n !== "object") {
      return;
    }
    out.push(n);
    if (Array.isArray(n.children)) {
      for (const c of n.children) {
        walk(c);
      }
    }
  };
  walk(doc);
  return out;
}

/** Concatenated visible text — text nodes, textContent, and string children. */
export function textOf(doc: any): string {
  const parts: any[] = [];
  const walk = (n: any) => {
    if (typeof n === "string") {
      parts.push(n);
      return;
    }
    if (!n || typeof n !== "object") {
      return;
    }
    if (n.text) {
      parts.push(n.text);
    }
    if (n.textContent) {
      parts.push(n.textContent);
    }
    if (Array.isArray(n.children)) {
      for (const c of n.children) {
        walk(c);
      }
    }
  };
  walk(doc);
  return parts.join(" ");
}

/**
 * True if any node has a style property satisfying `pred` (a predicate or a substring).
 *
 * @param prop - CamelCase style key, e.g. "fontSize"
 */
export function anyStyle(
  doc: any,
  prop: string,
  pred: ((value: string) => boolean) | string,
): boolean {
  const test =
    typeof pred === "function"
      ? pred
      : (v: string) => String(v).toLowerCase().includes(pred.toLowerCase());
  return allNodes(doc).some(
    (n) => n.style && n.style[prop] !== undefined && test(String(n.style[prop])),
  );
}

/** True if any node matches `pred`. */
export function anyNode(doc: any, pred: (node: any) => boolean): boolean {
  return allNodes(doc).some((node) => pred(node));
}
