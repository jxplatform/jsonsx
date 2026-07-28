/**
 * Model-URI mapping for project files — deliberately Monaco-free.
 *
 * This lived in `monaco-setup`, whose top-level imports pull in Monaco's editor API and its
 * TypeScript/JSON/JavaScript language contributions. Anything importing this pure string helper
 * therefore dragged 12.6 MB back onto the cold-start path, defeating the lazy load. Kept separate
 * so `canvas-render` can address a model without loading an editor.
 */

export const ENTRY_SCHEMA_FILES = new Set(["project.schema.json", "document.schema.json"]);

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
