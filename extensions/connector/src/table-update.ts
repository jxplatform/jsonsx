/**
 * Table-update — the TableUpdate action class (PATCH /_jx/data/:table/:id).
 *
 * The id may be a literal, a `${...}` template, or `{ "$ref": "#/$params/<name>" }` (resolved
 * against the route at lower time). Payload = form FormData merged under the def's `values`. See
 * table-actions.ts for the shared machinery.
 */

import { lowerActionDef, makeActionHandler } from "./table-actions.ts";
import type { ActionDef } from "./table-actions.ts";
import type { LowerContext } from "./table-state.ts";

export class TableUpdate {
  config: ActionDef;

  constructor(config: ActionDef) {
    this.config = config;
  }

  /** Resolve to the live update handler (interpreter path). */
  resolve() {
    return makeActionHandler("PATCH", this.config);
  }

  /** Static `lower` capability: compile away into an inline Function def. */
  static lower(def: ActionDef, context: LowerContext = {}): Record<string, unknown> {
    return lowerActionDef("PATCH", def, context);
  }
}
