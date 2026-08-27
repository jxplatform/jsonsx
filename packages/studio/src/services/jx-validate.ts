/**
 * Jx-validate.js — cached Jx schema validation for the AI assistant.
 *
 * Validates against the ACTIVE project's generated entry documents (`document.schema.json` /
 * `project.schema.json`, extensions.md §5.2) once {@link applyProjectSchemas} has been handed them,
 * and against `@jxsuite/schema`'s pre-generated core schemas until then. Matching what Monaco shows
 * in the code view is the point: the entry documents close the composition with
 * `unevaluatedProperties: false` and union in each enabled extension's shapes, so validating the
 * agent loop against core alone lets the model write a `$paths` source or a `search:` section that
 * its own tool call reports clean and the editor paints red the moment a human opens the file.
 *
 * We import the generated JSON rather than the generator itself: `generateSchema()` pulls in
 * `@webref/*` + Node builtins (node:path/process) and would crash a browser bundle. Validators are
 * compiled once per schema swap — `@jxsuite/schema`'s `validateDocument` recompiles on every call,
 * which is too slow to run after every mutation in the loop.
 *
 * @license MIT
 */

import coreDocumentSchema from "@jxsuite/schema/schema.json";
import coreProjectSchema from "@jxsuite/schema/project-schema.json";

type ValidateFn = ((doc: unknown) => boolean) & {
  errors?: { instancePath?: string; message?: string; params?: Record<string, unknown> }[] | null;
};

/** Which of the two entry documents a validator covers. */
type SchemaKind = "document" | "project";

const CORE: Record<SchemaKind, object> = {
  document: coreDocumentSchema as object,
  project: coreProjectSchema as object,
};

const active: Record<SchemaKind, object> = { ...CORE };
const compiling: Record<SchemaKind, Promise<ValidateFn | null> | null> = {
  document: null,
  project: null,
};

/**
 * One console report per session — a validator that cannot compile is otherwise indistinguishable
 * from a clean document, in the agent loop AND in the eval scoreboard.
 */
let reportedFailure = false;

/**
 * Compile (once per active schema) and return the ajv validate function, or null when ajv is
 * unavailable or the schema will not compile.
 *
 * @param {SchemaKind} kind - Which entry document to compile
 * @returns {Promise<ValidateFn | null>} The compiled validator, or null when unavailable
 */
function getValidator(kind: SchemaKind): Promise<ValidateFn | null> {
  compiling[kind] ??= (async () => {
    try {
      // The generated schemas are JSON Schema draft 2020-12, so they need Ajv's 2020 build —
      // The default export only knows draft-07 and throws on the 2020 meta-schema ref.
      // Optional peer dependency: validation degrades to a no-op if ajv is absent or the
      // Schema fails to compile.
      const { default: Ajv2020 } = await import("ajv/dist/2020.js");
      const { default: addFormats } = await import("ajv-formats");
      const ajv = new Ajv2020({ allErrors: true, strict: false, allowUnionTypes: true });
      addFormats(ajv);
      return ajv.compile(active[kind]) as ValidateFn;
    } catch (error) {
      if (!reportedFailure) {
        reportedFailure = true;
        console.error(
          `[jx] ${kind} schema validation is unavailable — the AI assistant's schema gate is a ` +
            `no-op for this session:`,
          error,
        );
      }
      return null;
    }
  })();
  return compiling[kind];
}

/**
 * Swap in the active project's pre-bundled entry documents (the payload behind the platform's
 * `fetchProjectSchemas` member). Each half falls back to its core schema when absent, so a partial
 * payload still upgrades the half it carries. Discards the compiled validators so the next call
 * recompiles.
 *
 * @param {object | null} schemas - Pre-bundled `{ document, project }`, or null to restore core
 * @returns {boolean} True when at least one per-project schema was applied
 */
export function applyProjectSchemas(
  schemas: { project?: unknown; document?: unknown } | null,
): boolean {
  const document = (schemas?.document as object | undefined) ?? CORE.document;
  const project = (schemas?.project as object | undefined) ?? CORE.project;
  if (document === active.document && project === active.project) {
    return Boolean(schemas?.document || schemas?.project);
  }
  active.document = document;
  active.project = project;
  compiling.document = null;
  compiling.project = null;
  return Boolean(schemas?.document || schemas?.project);
}

/** Restore the core schemas (project closed / tests). */
export function resetProjectSchemas(): void {
  applyProjectSchemas(null);
}

/**
 * The keys ajv uses to name the property an error is ABOUT, in the order they can appear.
 *
 * `message` alone is not a diagnosis for any of these three. "must NOT have unevaluated properties"
 * says a key is unrecognised without saying which key — and at the root of a `project.json` that is
 * the difference between a fixable problem and a mystery. An imported project once produced that
 * line three times over, naming nothing, and the only way to learn it meant `title`, `description`
 * and `$style` was to compile the schema by hand.
 */
const ERROR_PROPERTY_KEYS = ["unevaluatedProperty", "additionalProperty", "missingProperty"];

/**
 * Format ajv errors the way the agent loop consumes them (see ai-tools.ts
 * `translateValidationError`).
 *
 * @param {ValidateFn} validate - The validator that just ran
 * @returns {string[]} One formatted string per error
 */
function formatErrors(validate: ValidateFn): string[] {
  return (validate.errors || []).map((e) => {
    const key = ERROR_PROPERTY_KEYS.find((name) => typeof e.params?.[name] === "string");
    const property = key ? ` (${String(e.params?.[key])})` : "";
    return `${e.instancePath || "(root)"}: ${e.message}${property}`;
  });
}

/**
 * Validate a Jx document against the active document schema.
 *
 * @param {unknown} doc - Parsed document
 * @returns {Promise<string[]>} Formatted error strings; empty when valid or validation unavailable
 */
export async function validateDoc(doc: unknown): Promise<string[]> {
  const validate = await getValidator("document");
  if (!validate || validate(doc)) {
    return [];
  }
  return formatErrors(validate);
}

/**
 * Validate a `project.json` config against the active project schema. The per-project entry
 * document is what closes the composition (`unevaluatedProperties: false` over core + every enabled
 * extension's fragment), so this is the only gate that catches a typo'd section key or a misshapen
 * extension section before the write lands.
 *
 * @param {unknown} config - Parsed project.json
 * @returns {Promise<string[]>} Formatted error strings; empty when valid or validation unavailable
 */
export async function validateProjectConfig(config: unknown): Promise<string[]> {
  const validate = await getValidator("project");
  if (!validate || validate(config)) {
    return [];
  }
  return formatErrors(validate);
}
