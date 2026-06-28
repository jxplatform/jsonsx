/**
 * Strip `on*` event-handler bindings from a Jx document tree (returns a shallow-rebuilt copy). Used
 * to neutralize handlers before edit/design rendering so the canvas never wires live behavior, and
 * to drop `timing: "server"` state entries the canvas can't run.
 *
 * Lives in its own dependency-light module (it pulls only the pure `@jxsuite/schema/guards`
 * predicate) so the slim canvas-iframe subtree renderer can import it without dragging in the
 * editor's reactive `store.ts`; `store.ts` re-exports it for the legacy in-realm patcher.
 */

import { isEventBinding } from "@jxsuite/schema/guards";
import type { JxMutableNode } from "@jxsuite/schema/types";

/** Strip all `on*` event-handler properties (and server-timed state) from a document tree. */
export function stripEventHandlers(node: JxMutableNode): JxMutableNode {
  if (!node || typeof node !== "object") {
    return node;
  }
  if (Array.isArray(node)) {
    // Arrays of nodes round-trip element-wise; the array itself is not a node.
    return node.map((n: JxMutableNode) => stripEventHandlers(n)) as unknown as JxMutableNode;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node)) {
    if (k.startsWith("on") && isEventBinding(v)) {
      continue;
    }
    if (k === "children") {
      out.children = Array.isArray(v)
        ? v.map((c: JxMutableNode) => stripEventHandlers(c))
        : stripEventHandlers(v as JxMutableNode);
    } else if (k === "cases" && typeof v === "object") {
      const cases: Record<string, unknown> = {};
      for (const [ck, cv] of Object.entries(v as Record<string, unknown>)) {
        cases[ck] = stripEventHandlers(cv as JxMutableNode);
      }
      out.cases = cases;
    } else if (k === "state" && typeof v === "object" && v !== null) {
      const state: Record<string, unknown> = {};
      for (const [sk, sv] of Object.entries(v as Record<string, unknown>)) {
        if (sv && typeof sv === "object" && (sv as Record<string, unknown>).timing === "server") {
          continue;
        }
        state[sk] = sv;
      }
      out.state = state;
    } else if (k === "style" || k === "attributes" || k === "$media") {
      out[k] = v;
    } else {
      out[k] = v;
    }
  }
  return out;
}
