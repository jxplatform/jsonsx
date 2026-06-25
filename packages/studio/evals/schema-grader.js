/**
 * Schema-grader.js — baseline structural grader for the eval harness.
 *
 * Thin wrapper over the same `validateDoc()` (ajv against @jxsuite/schema) that already runs inside
 * the live agent loop (ADR docs/ai-assistant-decision.md §6b). Free, deterministic structural
 * signal reported alongside the render critic so the scoreboard shows both.
 *
 * @license MIT
 */

import { validateDoc } from "../src/services/jx-validate";

/**
 * @param {unknown} doc
 * @returns {Promise<{ pass: boolean; errors: string[] }>}
 */
export async function schemaGrader(doc) {
  const errors = await validateDoc(doc);
  return { pass: errors.length === 0, errors };
}
