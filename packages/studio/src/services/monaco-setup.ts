/**
 * Monaco editor setup — workers, the editor feature set, language services, and JX schema
 * registration.
 *
 * **The list below is Studio's STATEMENT of what the code editor can do.** Monaco 0.55 had no way
 * to say it: importing `language/json/monaco.contribution.js` transitively dragged in every one of
 * the 59 editor contributions, so the editor Studio shipped was whatever the language services
 * happened to reach. 0.56 puts a supported export map in front of them (`"./*" → ./esm/vs/*.js`)
 * with one `register` module per capability, so adding an editor capability means adding its import
 * here.
 *
 * Three things about that, and none of them is discoverable from the code:
 *
 * - **A missing register is SILENT.** The editor simply lacks the capability: no error, no warning,
 *   no console line. `specs/studio.md` §11.1 makes the list normative for that reason, and the
 *   browser pass in a Studio change set is the gate. `monaco-editor/features/register.all` restores
 *   the whole set exactly if you ever need to bisect against it.
 * - **`features/suggest/register` is not what makes completion work.** It registers the provider that
 *   turns suggest items into inline (ghost) text; the suggest WIDGET is
 *   `contrib/suggest/browser/suggestController.js`, and the only public entry that reaches it is
 *   `features/inlineCompletions/register`. Without that line, `jsonDefaults`' schema completions
 *   and the `state.*` completions in the Logic tab (`panels/editors.ts`) both register successfully
 *   and then never appear.
 * - **THE EXCLUSIONS DO NOT TAKE EFFECT YET, and it is worth knowing before you try to make them.**
 *   In 0.56.0 the contrib modules import one another densely, and the suggest stack this file
 *   cannot do without reaches almost all of them: every one of the 33 features named "not
 *   registered" below is still in the bundle and still calls `registerEditorContribution` at module
 *   scope. Measured on the built output — `register.all` 14,186,780 B, this list 14,189,667 B, this
 *   list with a deep `suggestController` import instead of `inlineCompletions` 14,192,867 B.
 *   Curating costs about 3 KB and currently saves nothing.
 *
 *   It is kept because it is the true statement of intent and it is where the saving lands the day
 *   monaco untangles that graph. Do not cite it as evidence that a feature is off — check the
 *   metafile. The only variant where the exclusions bite drops the suggest widget too, which takes
 *   schema completion with it.
 */

import "monaco-editor/editor";
// Core widget, icons, tokenization.
import "monaco-editor/features/codeEditor/register";
import "monaco-editor/features/codicon/register";
import "monaco-editor/features/tokenization/register";
// Editing. `linesOperations` is also what pulls in `browser/coreCommands.js`.
import "monaco-editor/features/clipboard/register";
import "monaco-editor/features/comment/register";
import "monaco-editor/features/cursorUndo/register";
import "monaco-editor/features/dnd/register";
import "monaco-editor/features/indentation/register";
import "monaco-editor/features/lineSelection/register";
import "monaco-editor/features/linesOperations/register";
import "monaco-editor/features/multicursor/register";
import "monaco-editor/features/smartSelect/register";
import "monaco-editor/features/wordOperations/register";
import "monaco-editor/features/wordPartOperations/register";
// Navigation & search.
import "monaco-editor/features/find/register";
import "monaco-editor/features/folding/register";
import "monaco-editor/features/gotoError/register"; // F8 over the oxlint markers
import "monaco-editor/features/gotoLine/register";
// The surfaces the JSON / TypeScript language services feed.
import "monaco-editor/features/bracketMatching/register";
import "monaco-editor/features/codeAction/register";
import "monaco-editor/features/format/register";
import "monaco-editor/features/hover/register";
import "monaco-editor/features/links/register";
import "monaco-editor/features/parameterHints/register";
import "monaco-editor/features/snippet/register";
import "monaco-editor/features/suggest/register";
import "monaco-editor/features/inlineCompletions/register"; // Carries the suggest WIDGET — see above
// Chrome & safety.
import "monaco-editor/features/contextmenu/register";
import "monaco-editor/features/readOnlyMessage/register"; // ReadOnly is set on collab failure
import "monaco-editor/features/toggleTabFocusMode/register";
import "monaco-editor/features/unicodeHighlighter/register";
// Languages.
import { jsonDefaults } from "monaco-editor/languages/features/json/register";
import "monaco-editor/languages/features/typescript/register";
import "monaco-editor/languages/definitions/javascript/register";

import { flattenSchema } from "@jxsuite/schema/project-schemas";
import jxSchema from "@jxsuite/schema/schema.json";
import projectSchema from "@jxsuite/schema/project-schema.json";
import { bundleUrl } from "./bundle-base";

/* Re-exported for the modules that already imported it from here. New callers should reach for
   `./model-uri` directly — it is Monaco-free, and importing this module loads the editor. */
export { modelUriFor } from "./model-uri";

const WORKER_FILES: Record<string, string> = {
  editorWorkerService: "editor.worker.js",
  javascript: "ts.worker.js",
  json: "json.worker.js",
  typescript: "ts.worker.js",
};

/**
 * Resolve a Monaco worker to the PRE-BUNDLED copy that ships NEXT TO THE ENTRY — `dist/workers/`
 * beside `dist/studio.js`, written by scripts/build-workers.ts.
 *
 * Self-location is what makes one expression correct on every host, because none of them agree on a
 * prefix and two of them cannot be served by one: the repo dev server mounts the shell at
 * `/packages/studio/index.html`, the packaged desktop app at `views://studio/index.html`, the
 * desktop loopback server under `/__studio__/`, and a cloud host under whatever prefix it staged
 * the tree at. The only invariant is the bundle's own location.
 *
 * **But `import.meta.url` is not that location, and this function used to think it was.** It is
 * THIS MODULE's url, and since the code-split (78d85ba2) this module is emitted into
 * `dist/chunks/monaco-setup-<hash>.js` — so the expression resolved to `chunks/workers/<name>`, a
 * directory that has never existed in any distribution. Only the two entries have a contractual
 * emitted path (studio.md §11.1), which is exactly what `services/bundle-base` records.
 *
 * The bug this closes is invisible by construction, which is why it survived: a Monaco worker that
 * 404s takes the whole JSON language service with it — no schema validation, no completion, no
 * hover — and surfaces no error at all. The same silence covered the predecessor of the
 * `import.meta.url` form, a root-absolute `/monaco-editor/esm/vs/...` that resolved on the repo dev
 * server alone.
 *
 * @param {string} label - Monaco worker label ("json", "typescript", …)
 * @returns {string} Absolute URL of the worker bundle
 */
export function workerUrl(label: string): string {
  const file = WORKER_FILES[label] || WORKER_FILES.editorWorkerService!;
  return bundleUrl(`workers/${file}`);
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
    const monaco = await import("monaco-editor/editor");
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
