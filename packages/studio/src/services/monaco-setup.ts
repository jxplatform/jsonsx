/** Monaco editor setup — workers, language contributions, and JX schema registration. */

// @ts-expect-error — Monaco ESM contribution has no type declarations for named exports
import { jsonDefaults } from "monaco-editor/esm/vs/language/json/monaco.contribution.js";
import "monaco-editor/esm/vs/editor/editor.api.js";
import "monaco-editor/esm/vs/language/typescript/monaco.contribution.js";
import "monaco-editor/esm/vs/basic-languages/javascript/javascript.contribution.js";

import { flattenSchema } from "@jxsuite/schema/project-schemas";
import jxSchema from "@jxsuite/schema/schema.json";
import projectSchema from "@jxsuite/schema/project-schema.json";

const WORKER_FILES: Record<string, string> = {
  editorWorkerService: "editor.worker.js",
  javascript: "ts.worker.js",
  json: "json.worker.js",
  typescript: "ts.worker.js",
};

/**
 * Resolve a Monaco worker to the PRE-BUNDLED copy that ships NEXT TO this bundle — `workers/`
 * beside `dist/studio.js`, written by scripts/build-workers.ts.
 *
 * Self-location via `import.meta.url` (Bun emits it verbatim for browser targets) is what makes one
 * expression correct on every host, because none of them agree on a prefix and two of them cannot
 * be served by one: the repo dev server mounts the shell at `/packages/studio/index.html`, the
 * packaged desktop app at `views://studio/index.html`, the desktop loopback server under
 * `/__studio__/`, and the cloud at `/edit/:owner/:repo@:branch` — a DEEP path, so even a
 * document-relative URL would resolve into the wrong directory there. The only invariant is the
 * bundle's own location.
 *
 * A root-absolute `/monaco-editor/esm/vs/...` (what this used to emit) resolved on exactly one of
 * them, the repo dev server, which serves bare specifiers out of the monorepo's `node_modules`.
 * Everywhere else it 404s — and a Monaco worker that fails to start takes the whole JSON language
 * service with it: no schema validation, no completion, no hover, and no error the user can see.
 *
 * @param {string} label - Monaco worker label ("json", "typescript", …)
 * @returns {string} Absolute URL of the worker bundle
 */
export function workerUrl(label: string): string {
  const file = WORKER_FILES[label] || WORKER_FILES.editorWorkerService!;
  return new URL(`workers/${file}`, import.meta.url).href;
}

self.MonacoEnvironment = {
  getWorker(_, label: string) {
    return new Worker(workerUrl(label), { type: "module" });
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
 * Model ids the committed entry documents are bound by. A Jx project binds its files with a
 * RELATIVE in-document pointer (extensions.md §5.2/§5.4) — `project.json` carries `"$schema":
 * "./project.schema.json"` — and Monaco mounts every studio model at
 * `file:///<project-relative-path>` (canvas/canvas-render.ts), so the language service resolves
 * that pointer against the model's own directory and lands on the project root.
 *
 * The document id is the same target for a document that spells its pointer at the RIGHT depth
 * (`../document.schema.json` from `pages/`, `../../` from `pages/blog/`). A pointer with too few
 * `../` resolves to a file that does not exist and fails everywhere — Monaco, VS Code and ajv alike
 * — so it is an authoring error, not something to paper over with extra registrations.
 */
const PROJECT_ENTRY_SCHEMA_ID = "file:///project.schema.json";
const DOCUMENT_ENTRY_SCHEMA_ID = "file:///document.schema.json";

/** The project-root files those ids belong to (`jx schema` writes exactly these two names). */
const ENTRY_SCHEMA_FILES = new Set(["project.schema.json", "document.schema.json"]);

/**
 * The model URI to mount a project file at. Normally `file:///<project-relative-path>`, which is
 * what makes a document's relative `$schema` resolve against its own directory — EXCEPT for the two
 * generated entry documents, which get a reserved prefix instead.
 *
 * Their natural URIs collide with the schema ids above, and Monaco's JSON adapter calls
 * `resetSchema(model.uri)` on `onWillDisposeModel` (jsonMode.js). That reaches
 * `JSONSchemaService.onResourceChange`, which drops the inline content of the handle registered
 * under the SAME id — so opening `project.schema.json` in the source view and closing it again
 * silently un-registers the project schema, and every `project.json` goes back to reporting `No
 * schema request service available` for the rest of the session. Re-registering on disposal cannot
 * fix this reliably (the adapter's reset is async and listener order is not ours to pick); keeping
 * the two namespaces disjoint can.
 *
 * @param {string} path - Project-relative file path
 * @returns {string} Model URI string
 */
export function modelUriFor(path: string): string {
  return ENTRY_SCHEMA_FILES.has(path) ? `file:///.jx/generated/${path}` : `file:///${path}`;
}

/**
 * Register the JSON diagnostics schemas. Fetched per-project schemas are inline OBJECTS (never URLs
 * — `enableSchemaRequest` stays off), so backends must serve them PRE-BUNDLED; the bundled core
 * schemas remain the offline fallback.
 *
 * Each schema registers TWICE: once under its canonical `https://jxsuite.com/…` uri with the
 * fileMatch patterns that cover documents carrying no `$schema` of their own, and again under the
 * `file:///…` id above. The second registration is what makes the `$schema` binding work offline.
 * An in-document `$schema` takes ABSOLUTE precedence over fileMatch in the language service
 * (`getSchemaForResource` consults it first and returns early), and resolution goes through
 * `getOrAddSchemaHandle`, which checks the by-id registry BEFORE reaching for a request service.
 * Without the id registered there is no service to reach for, so every `project.json` reported
 * `Unable to load schema from '/project.schema.json'. No schema request service available` — and,
 * worse, resolved to an empty schema, so the fileMatch registration never ran and REAL violations
 * went unreported behind that one diagnostic.
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
      { schema: projectJsonSchema, uri: PROJECT_ENTRY_SCHEMA_ID },
      { schema: documentSchema, uri: DOCUMENT_ENTRY_SCHEMA_ID },
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
 * Swap Monaco's JSON diagnostics to the ACTIVE project's generated entry documents — the
 * pre-bundled payload behind the platform's optional `fetchProjectSchemas` member (dev server:
 * `/__studio/project-schemas`; desktop: RPC into the project session). Called on project
 * activation, after a `project.json` write, and on `extensions` changes.
 *
 * Takes an ALREADY-FETCHED payload rather than the platform, so ONE fetch can feed both Monaco and
 * the AI assistant's validator (format/format-host.ts). The backends regenerate stale entry
 * documents on demand and write them to disk, so a second concurrent fetch is not a harmless
 * duplicate — it races the first on the same two files.
 *
 * @param {object | null} schemas - Pre-bundled `{ document, project }` payload
 * @returns {boolean} True when per-project schemas were applied; false on fallback
 */
export function applyProjectSchemas(
  schemas: { project?: unknown; document?: unknown } | null | undefined,
): boolean {
  const { document, project } = schemas ?? {};
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
