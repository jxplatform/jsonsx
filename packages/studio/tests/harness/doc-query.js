/**
 * Doc-query.js — tiny read helpers for writing outcome assertions against a final Jx document.
 *
 * Outcome assertions (testing-plan §3.1 Completeness) check _what the document became_, independent
 * of which tools the model used to get there.
 *
 * See docs/ai-assistant-headless-harness.md §3 Step 3.
 */

/** Depth-first list of every node in the document (root included). @param {any} doc */
export function allNodes(doc) {
  const out = [];
  const walk = (n) => {
    if (!n || typeof n !== "object") return;
    out.push(n);
    if (Array.isArray(n.children)) for (const c of n.children) walk(c);
  };
  walk(doc);
  return out;
}

/** Concatenated visible text — `t` node `text` fields plus any `textContent`. @param {any} doc */
export function textOf(doc) {
  return allNodes(doc)
    .map((n) => n.text ?? n.textContent ?? "")
    .filter(Boolean)
    .join(" ");
}

/**
 * True if any node has a style property satisfying `pred` (a predicate or a substring).
 *
 * @param {any} doc
 * @param {string} prop - CamelCase style key, e.g. "fontSize"
 * @param {((value: string) => boolean) | string} pred
 */
export function anyStyle(doc, prop, pred) {
  const test =
    typeof pred === "function" ? pred : (v) => String(v).toLowerCase().includes(pred.toLowerCase());
  return allNodes(doc).some(
    (n) => n.style && n.style[prop] !== undefined && test(String(n.style[prop])),
  );
}

/** True if any node matches `pred`. @param {any} doc @param {(node: any) => boolean} pred */
export function anyNode(doc, pred) {
  return allNodes(doc).some(pred);
}
