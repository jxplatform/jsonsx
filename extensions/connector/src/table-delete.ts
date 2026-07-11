/**
 * Table-delete — the TableDelete action class (DELETE /_jx/data/:table/:id).
 *
 * No payload; the id resolves like TableUpdate's. On success `state._v` bumps so lowered queries
 * refetch. See table-actions.ts for the shared machinery.
 */

import { lowerActionDef, makeActionHandler } from "./table-actions.ts";
import type { ActionDef } from "./table-actions.ts";
import type { LowerContext } from "./table-state.ts";

export class TableDelete {
  config: ActionDef;

  constructor(config: ActionDef) {
    this.config = config;
  }

  /** Resolve to the live delete handler (interpreter path). */
  resolve() {
    return makeActionHandler("DELETE", this.config);
  }

  /** Static `lower` capability: compile away into an inline Function def. */
  static lower(def: ActionDef, context: LowerContext = {}): Record<string, unknown> {
    return lowerActionDef("DELETE", def, context);
  }
}
