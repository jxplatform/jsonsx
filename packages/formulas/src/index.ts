/**
 * The `jxsuite formulas` package — composite pure formulas, authored as declarative $expression
 * JSON.
 *
 * Each catalog entry is a named formula (spec §19.4c): a pure body over $args/<name> parameters
 * built from blessed operators, pure standard-library methods (§19.4d), and blessed globals.
 * `formulaEntries()` returns them as ready-to-merge `state` entries — drop them into a document or
 * project `state` and invoke via the `call` operator.
 */

import { catalog } from "./catalog.ts";

import type { JxExpressionDef } from "@jxsuite/schema/types";

export { catalog } from "./catalog.ts";
export type { FormulaCatalogEntry } from "./catalog.ts";

/** The catalog as named-formula state entries, keyed by formula name. */
export function formulaEntries(): Record<string, JxExpressionDef> {
  const entries: Record<string, JxExpressionDef> = {};
  for (const formula of catalog) {
    entries[formula.name] = {
      $description: formula.description,
      $expression: formula.expression,
      parameters: formula.parameters,
    };
  }
  return entries;
}
