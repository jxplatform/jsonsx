/// <reference lib="dom" />
/**
 * Parent-side live expression preview (spec §19.9).
 *
 * Evaluates an expression node against the canvas iframe's last dataScope snapshot
 * (tab.session.canvas.scope) on a structuredClone, so mutating operators are safe — they mutate the
 * clone, never the live canvas. The engine's trace hook reports every sub-node's value keyed by its
 * path within the tree; values are formatted to display strings at report time so later mutations
 * of the clone cannot retroactively change a badge.
 */

import { evaluateExpression, isMutating } from "@jxsuite/runtime/expression";
import { toRaw } from "../reactivity";
// Imported for local use AND re-exported below so existing consumers keep their import site.
// oxlint-disable-next-line unicorn/prefer-export-from
import { formatPreviewValue } from "../utils/preview-format";

import type { ExpressionNode } from "@jxsuite/runtime/expression";

export interface ExpressionPreview {
  /** Path-keyed display values: "" is the root node, "value/target" a nested operand, etc. */
  values: Map<string, string>;
  /** Evaluation error message, if the expression threw. */
  error: string | null;
  /** Whether the root operator mutates its target (badge renders as an effect, not a value). */
  mutating: boolean;
}

// The formatter is shared with the in-iframe live evaluator: it lives in utils/preview-format.ts
// (dependency-light, safe for the iframe bundle) and is re-exported here so existing consumers
// Keep their import site.
export { formatPreviewValue };

/**
 * Evaluate `node` against a scope snapshot for display. Returns null when no snapshot is available
 * (canvas not yet rendered) — the editor renders no badges rather than wrong ones.
 */
export function previewExpression(
  node: unknown,
  scope?: Record<string, unknown> | null,
): ExpressionPreview | null {
  if (!scope || !node || typeof node !== "object" || !("operator" in node)) {
    return null;
  }

  let state: Record<string, unknown>;
  try {
    // Callers hand over tab.session.canvas.scope, which the reactive session tree wraps in a
    // Proxy — structuredClone rejects proxies, so unwrap to the raw snapshot first.
    state = structuredClone(toRaw(scope));
  } catch {
    // Snapshot values are JSON-safe by construction (serialize-scope), but stay defensive.
    return null;
  }

  const values = new Map<string, string>();
  const expr = node as ExpressionNode;
  let errorMessage: string | null = null;
  try {
    evaluateExpression(expr, state, null, undefined, {
      report: (path, value) => values.set(path.join("/"), formatPreviewValue(value)),
    });
  } catch (error) {
    errorMessage = error instanceof Error ? error.message : String(error);
  }

  return { error: errorMessage, mutating: isMutating(expr.operator), values };
}
