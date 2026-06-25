/**
 * Jx-validate.js — cached Jx document schema validation for the AI assistant.
 *
 * Reuses `@jxsuite/schema`'s generated schema as the eval signal for the agent loop
 * (ADR docs/ai-assistant-decision.md §6b, shared with the jx-harness project). The ajv validator
 * is compiled once per session — `@jxsuite/schema`'s `validateDocument` recompiles on every call,
 * which is too slow to run after every mutation in the loop.
 *
 * @license MIT
 */

import { generateSchema } from "@jxsuite/schema";

/**
 * @type {(((doc: unknown) => boolean) & { errors?: { instancePath?: string; message?: string }[] })
 *   | null}
 */
let _validate = null;
/** @type {Promise<((doc: unknown) => boolean) | null> | null} */
let _loading = null;

/** Compile (once) and return the ajv validate function, or null if ajv is unavailable. */
function getValidator() {
  if (_validate) {
    return Promise.resolve(_validate);
  }
  if (!_loading) {
    _loading = (async () => {
      try {
        // The generated schema is JSON Schema draft 2020-12, so it needs Ajv's 2020 build —
        // The default export only knows draft-07 and throws on the 2020 meta-schema ref.
        // Optional peer dependency: validation degrades to a no-op if ajv is absent or the
        // Schema fails to compile.
        const { default: Ajv2020 } = await import("ajv/dist/2020.js");
        const { default: addFormats } = await import("ajv-formats");
        const ajv = new Ajv2020({ allErrors: true, strict: false, allowUnionTypes: true });
        addFormats(ajv);
        const schema = await generateSchema();
        _validate = ajv.compile(schema);
        return _validate;
      } catch {
        return null;
      }
    })();
  }
  return _loading;
}

/**
 * Validate a Jx document against the schema.
 *
 * @param {unknown} doc
 * @returns {Promise<string[]>} Formatted error strings; empty when valid or validation unavailable
 */
export async function validateDoc(doc) {
  const validate = await getValidator();
  if (!validate) {
    return [];
  }
  const valid = validate(doc);
  if (valid) {
    return [];
  }
  return (validate.errors || []).map((e) => `${e.instancePath || "(root)"}: ${e.message}`);
}
