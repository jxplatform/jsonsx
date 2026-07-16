/**
 * In-iframe live expression evaluation (M6) — answers the parent's `evalExpr` requests against the
 * LIVE resolved scope of the current render (buildScope's `$defs`), so previews see real repeater
 * items, real `window#/` globals, and uncapped data values instead of the parent's serialized
 * snapshot.
 *
 * Safety: every expression evaluates against a fresh plain-data clone of the scope (a per-key JSON
 * round-trip, the serialize-scope idiom — it reads through the runtime's reactive proxies), so
 * mutating operators write into the clone and never touch the live canvas. Named-formula callables
 * (pure `$expression` entries with parameters) are kept BY REFERENCE so `call` nodes work; every
 * other function (side-effecting handlers, server fns) is dropped so a preview can never run one.
 */

import { evaluateExpression } from "@jxsuite/runtime/expression";
import { resolveRef } from "@jxsuite/runtime";
import { formatPreviewValue } from "../utils/preview-format";

import type { ExpressionNode } from "@jxsuite/runtime/expression";
import type { EvalExprResult } from "./iframe-protocol";

type Scope = Record<string, unknown>;

/** Whether the raw (document) state entry is a pure named-formula (`$expression` + parameters). */
function isNamedFormulaEntry(entry: unknown): boolean {
  return (
    typeof entry === "object" &&
    entry !== null &&
    !Array.isArray(entry) &&
    "$expression" in entry &&
    Array.isArray((entry as { parameters?: unknown }).parameters)
  );
}

/**
 * Clone the live `$defs` scope into a plain object safe to evaluate (and mutate) against. Data
 * values are JSON round-tripped per key (reads through reactive proxies, unwraps top-level refs);
 * functions survive only when their raw state entry is a pure named formula — anything else
 * callable (event handlers, structured-body functions, server fns) is dropped so a stray `call`
 * can't run a side effect against the live canvas.
 */
export function cloneLiveScope(defs: Scope, rawState: Record<string, unknown> | null): Scope {
  const out: Scope = {};
  for (const key of Object.keys(defs)) {
    try {
      // Reading through the reactive proxy auto-unwraps a top-level ref/computed — and can throw (a
      // Computed getter that throws), which maps the key to null instead of aborting the clone.
      const value = defs[key];
      if (typeof value === "function") {
        if (isNamedFormulaEntry(rawState?.[key])) {
          out[key] = value; // A pure formula callable — safe (and needed) for `call` nodes.
        }
        continue;
      }
      const json = JSON.stringify(value);
      out[key] = json === undefined ? null : (JSON.parse(json) as unknown);
    } catch {
      out[key] = null;
    }
  }
  return out;
}

/**
 * Bind repeater `$map` contexts for a node at `contextPath`: walk the shadow doc along the path
 * and, at every repeater crossing (a `$prototype: "Array"` node entered through its `map`
 * template), resolve the repeater's `items` against the scope built so far and layer the FIRST
 * item's `$map` context (item + index 0) over it — the same shape `renderMappedArrayInto` gives
 * rendered items, so `$map/item` / `$map/index` refs preview against real data. Nested repeaters
 * chain naturally (an inner `items` ref may read the outer `$map/item`).
 */
export function bindRepeaterContext(
  scope: Scope,
  shadowDoc: unknown,
  contextPath: (string | number)[] | null,
): Scope {
  if (!contextPath || contextPath.length === 0) {
    return scope;
  }
  let node: unknown = shadowDoc;
  let bound = scope;
  for (const seg of contextPath) {
    if (!node || typeof node !== "object") {
      break;
    }
    const rec = node as Record<string, unknown>;
    if (rec.$prototype === "Array" && seg === "map") {
      // Entering the repeater's template — bind the first item's context before descending.
      const itemsDef = rec.items;
      const items: unknown =
        itemsDef && typeof itemsDef === "object" && "$ref" in itemsDef
          ? resolveRef((itemsDef as { $ref: string }).$ref, bound)
          : itemsDef;
      if (Array.isArray(items) && items.length > 0) {
        let item: unknown;
        try {
          // Items resolved from the shadow doc (a literal array) must not be mutable through the
          // Preview scope — clone; scope-resolved items are already clone data, so this is free.
          item = structuredClone(items[0]);
        } catch {
          item = null;
        }
        const child = Object.create(bound) as Scope;
        child.$map = { index: 0, item };
        child["$map/item"] = item;
        child["$map/index"] = 0;
        bound = child;
      }
    }
    node = rec[seg as keyof typeof rec];
  }
  return bound;
}

/**
 * Evaluate each requested expression against a fresh clone of the live scope (with the repeater
 * context for `contextPath` bound), reporting every sub-node's value through the engine's trace
 * hook as pre-formatted display strings. Exceptions are guarded per expression into `error`.
 */
export function evaluateLiveExprs(
  exprs: { id: string; node: unknown }[],
  defs: Scope,
  shadowDoc: unknown,
  contextPath: (string | number)[] | null,
): EvalExprResult[] {
  const rawState =
    shadowDoc && typeof shadowDoc === "object"
      ? ((shadowDoc as { state?: Record<string, unknown> }).state ?? null)
      : null;
  return exprs.map(({ id, node }) => {
    const values = new Map<string, string>();
    // A fresh scope per expression: a mutating operator writes into this clone only, and can never
    // Leak into the next expression's evaluation (or the live canvas).
    let scope: Scope;
    try {
      scope = bindRepeaterContext(cloneLiveScope(defs, rawState), shadowDoc, contextPath);
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error), id, values: [] };
    }
    try {
      if (!node || typeof node !== "object" || !("operator" in node)) {
        throw new Error("not an expression node");
      }
      evaluateExpression(node as ExpressionNode, scope, null, undefined, {
        report: (path, value) => values.set(path.join("/"), formatPreviewValue(value)),
      });
      return { id, values: [...values.entries()] };
    } catch (error) {
      return {
        error: error instanceof Error ? error.message : String(error),
        id,
        values: [...values.entries()],
      };
    }
  });
}
