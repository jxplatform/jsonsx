/** Monaco editor setup — workers, language contributions, and JX schema registration. */

// @ts-expect-error — Monaco ESM contribution has no type declarations for named exports
import { jsonDefaults } from "monaco-editor/esm/vs/language/json/monaco.contribution.js";
import "monaco-editor/esm/vs/editor/editor.api.js";
import "monaco-editor/esm/vs/language/typescript/monaco.contribution.js";
import "monaco-editor/esm/vs/basic-languages/javascript/javascript.contribution.js";

import { flattenSchema } from "@jxsuite/schema/project-schemas";
import jxSchema from "@jxsuite/schema/schema.json";
import projectSchema from "@jxsuite/schema/project-schema.json";

const WORKER_PATHS: Record<string, string> = {
  editorWorkerService: "/monaco-editor/esm/vs/editor/editor.worker.js",
  javascript: "/monaco-editor/esm/vs/language/typescript/ts.worker.js",
  json: "/monaco-editor/esm/vs/language/json/json.worker.js",
  typescript: "/monaco-editor/esm/vs/language/typescript/ts.worker.js",
};

self.MonacoEnvironment = {
  getWorker(_, label: string) {
    const path = WORKER_PATHS[label] || WORKER_PATHS.editorWorkerService!;
    return new Worker(path, { type: "module" });
  },
};

/* Monaco caches glyph widths when an editor is created. JetBrains Mono is a
   vendored webfont (index.html @font-face) and may finish loading after the
   first editor mounts, so remeasure once all document fonts are ready to keep
   cursor and selection alignment correct. */
if (typeof document !== "undefined" && document.fonts?.ready) {
  // oxlint-disable-next-line unicorn/prefer-top-level-await -- fire-and-forget: awaiting fonts.ready at top level would block module evaluation (and studio startup) until webfonts load
  void document.fonts.ready.then(async () => {
    const monaco = await import("monaco-editor/esm/vs/editor/editor.api.js");
    monaco.editor.remeasureFonts();
  });
}

/** Folder globs whose JSON files validate against the (per-project or core) document schema. */
const DOCUMENT_FILE_MATCH = [
  "pages/*.json",
  "pages/**/*.json",
  "layouts/*.json",
  "layouts/**/*.json",
  "components/*.json",
  "components/**/*.json",
  "elements/*.json",
  "elements/**/*.json",
];

/**
 * Register the JSON diagnostics schemas. Fetched per-project schemas are inline OBJECTS (never URLs
 * — `enableSchemaRequest` stays off), so backends must serve them PRE-BUNDLED; the bundled core
 * schemas remain the offline fallback.
 */
function applyJsonSchemas(documentSchema: unknown, projectJsonSchema: unknown) {
  // oxlint-disable-next-line typescript/no-unsafe-call, typescript/no-unsafe-member-access -- jsonDefaults is imported from Monaco's untyped ESM contribution (see @ts-expect-error above); no type declarations exist for this named export
  jsonDefaults.setDiagnosticsOptions({
    allowComments: false,
    schemas: [
      {
        fileMatch: DOCUMENT_FILE_MATCH,
        schema: documentSchema,
        uri: "https://jxsuite.com/schema/v1",
      },
      {
        fileMatch: ["project.json"],
        schema: projectJsonSchema,
        uri: "https://jxsuite.com/schema/project/v1",
      },
    ],
    validate: true,
  });
}

/* Flattened once at module load: the shipped core schemas reference the well-known union resources
   by canonical $id (the `$paths` source union, extensions.md §5.3), and Monaco resolves anything with
   a URI before the `#` by FETCHING it — with `enableSchemaRequest` off that just fails, leaving
   `$paths` reporting an unresolvable ref. Flattening rewrites those refs onto the shipped defaults
   embedded in the same document, which is exactly the right fallback semantics. */
const FALLBACK_DOCUMENT_SCHEMA = flattenSchema(jxSchema as Record<string, unknown>);
const FALLBACK_PROJECT_SCHEMA = flattenSchema(projectSchema as Record<string, unknown>);

// Bundled core schemas register at module init — the offline fallback every platform starts from.
applyJsonSchemas(FALLBACK_DOCUMENT_SCHEMA, FALLBACK_PROJECT_SCHEMA);

/**
 * Swap Monaco's JSON schemas to the ACTIVE project's generated entry documents, fetched pre-bundled
 * through the platform's optional `fetchProjectSchemas` member (dev server:
 * `/__studio/project-schemas`; desktop: RPC into the project session). Call on project activation
 * and after project.json `extensions` changes.
 *
 * @param {object} platform - The studio platform (only `fetchProjectSchemas` is consulted)
 * @returns {Promise<boolean>} True when per-project schemas were applied; false on fallback
 */
export async function refreshProjectSchemas(platform: {
  fetchProjectSchemas?: () => Promise<{ project?: unknown; document?: unknown }>;
}): Promise<boolean> {
  const fetcher = platform.fetchProjectSchemas;
  if (!fetcher) {
    return false;
  }
  let schemas: { project?: unknown; document?: unknown };
  try {
    schemas = (await fetcher.call(platform)) ?? {};
  } catch {
    // Editor degradation: keep the bundled core schemas.
    return false;
  }
  const { document, project } = schemas;
  if (!document && !project) {
    return false;
  }
  applyJsonSchemas(document ?? FALLBACK_DOCUMENT_SCHEMA, project ?? FALLBACK_PROJECT_SCHEMA);
  return true;
}

/** Restore the bundled core schemas (project closed / tests). */
export function resetProjectSchemas(): void {
  applyJsonSchemas(FALLBACK_DOCUMENT_SCHEMA, FALLBACK_PROJECT_SCHEMA);
}
