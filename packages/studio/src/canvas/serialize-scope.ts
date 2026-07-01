/**
 * Serialize the iframe's resolved `$defs` scope (buildScope's output) into a structured-clone-safe
 * plain object the iframe can postMessage to the parent editor. The data-explorer panel reads this
 * from `S.canvas.scope` to show each data source's live value; the iframe (not the parent) resolves
 * the scope since the iframe canvas migration moved buildScope into the iframe realm.
 *
 * The input is the resolved `$defs` — typically a Vue reactive proxy. Reading `defs[key]`
 * auto-unwraps a top-level `ref`/`computed` to its current value; a JSON round-trip then reads
 * THROUGH any nested reactive proxies and drops non-cloneable residue (nested functions, symbols,
 * proxy artifacts) so the result crosses postMessage without a DataCloneError.
 *
 * Pure and DOM-free — no reactivity/runtime imports — so it stays trivially unit-testable.
 */

/**
 * Per-value size cap (in JSON-string chars). A single large content collection can be tens of KB;
 * past this cap we store a small placeholder so one big data source can't bloat every render's
 * postMessage. Generous on purpose — most scope values are far smaller.
 */
const MAX_VALUE_CHARS = 256_000;

/** The placeholder stored in place of a value whose JSON string exceeds {@link MAX_VALUE_CHARS}. */
const LARGE_VALUE_PLACEHOLDER = "[large value omitted]";

/**
 * Produce a structured-clone-safe snapshot of `defs` for the data-explorer.
 *
 * For each own enumerable key: - functions (`typeof v === "function"`) are SKIPPED entirely
 * (handlers/server fns aren't data); - other values are JSON deep-cloned
 * (`JSON.parse(JSON.stringify(v))`) inside try/catch — a throw (e.g. a computed getter that throws)
 * or a circular/unserializable value maps the key to `null`; - a value whose JSON string exceeds
 * the size cap is replaced with a short placeholder string.
 *
 * @param defs The resolved `$defs` scope (may be a Vue reactive proxy).
 * @returns A plain object safe to `postMessage` (every value is JSON-round-trippable).
 */
export function serializeDataScope(defs: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(defs)) {
    try {
      // Reading through the reactive proxy auto-unwraps a top-level ref/computed to its value, and
      // Can THROW (a computed getter that throws) — done inside the try so that maps the key to null
      // Rather than aborting the whole snapshot.
      const value = defs[key];
      if (typeof value === "function") {
        continue; // Data sources only — a resolved server/handler fn isn't a "value".
      }
      const json = JSON.stringify(value);
      if (json === undefined) {
        // JSON.stringify returns undefined for a bare function/symbol/undefined at the top level.
        out[key] = null;
        continue;
      }
      if (json.length > MAX_VALUE_CHARS) {
        out[key] = LARGE_VALUE_PLACEHOLDER;
        continue;
      }
      out[key] = JSON.parse(json) as unknown;
    } catch {
      // A circular structure or a throwing getter → the key exists but carries no serializable value.
      out[key] = null;
    }
  }
  return out;
}
