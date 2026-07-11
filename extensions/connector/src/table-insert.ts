/**
 * Table-insert — the TableInsert action class (POST /_jx/data/:table).
 *
 * Wire it to a form: `"onsubmit": { "$ref": "#/state/addComment" }`. The handler merges the form's
 * FormData under the def's literal `values`, POSTs the row, resets the form, and bumps `state._v`
 * so lowered queries refetch. See table-actions.ts for the shared machinery.
 */

import { lowerActionDef, makeActionHandler } from "./table-actions.ts";
import type { ActionDef } from "./table-actions.ts";
import type { LowerContext } from "./table-state.ts";

export class TableInsert {
  config: ActionDef;

  constructor(config: ActionDef) {
    this.config = config;
  }

  /** Resolve to the live insert handler (interpreter path). */
  resolve() {
    return makeActionHandler("POST", this.config);
  }

  /** Static `lower` capability: compile away into an inline Function def. */
  static lower(def: ActionDef, context: LowerContext = {}): Record<string, unknown> {
    return lowerActionDef("POST", def, context);
  }
}
