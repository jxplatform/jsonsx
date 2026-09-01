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

/**
 * The two model URIs a comparison's Monaco diff editor mounts at.
 *
 * **A reserved namespace, because the collision is otherwise unrepresentable-by-luck rather than
 * unrepresentable.** Two models on one URI throws (`Cannot create model because a model with the
 * same URI already exists`), and `workspace/pane-derive.ts` refuses a Code lens on a file whose
 * source editor is already open for exactly that reason. A diff editor is a THIRD claimant on the
 * same path, and neither existing guard can see it: one asks about panes, the other about presets.
 * Disjoint URIs make the collision impossible instead of refused.
 *
 * **Per pane**, because the primary can hold a comparison in Code while a Diff lens beside it holds
 * the same file's — two diff editors over one file, four models, all four distinct.
 *
 * The cost, stated: a relative `$schema` resolves against the model URI, so the HEAD side gets no
 * JSON validation. That is correct rather than merely tolerable — a comparison is read-only, and
 * red squiggles on a git object nobody can edit would be noise. The Code lens on the real URI keeps
 * its markers.
 *
 * @param {string} paneId
 * @param {string} path - Project-relative file path
 * @returns {{ head: string; work: string }}
 */
export function diffModelUrisFor(paneId: string, path: string): { head: string; work: string } {
  return {
    head: `file:///.jx/diff/${paneId}/head/${path}`,
    work: `file:///.jx/diff/${paneId}/work/${path}`,
  };
}

/**
 * Monaco's language id for a path, for a buffer with no tab and no format class behind it.
 *
 * `sourceLang` answers from a Tab's format class, which a comparison may not have: a diff can be
 * over a `.ts`, a `.css` or a `.gitignore`, none of which opens as a document at all. Unknown
 * extensions resolve to `plaintext` rather than being forced into a registered language —
 * `monaco-setup` contributes only JSON, TypeScript and JavaScript, and the red/green line
 * decorations come from the diff algorithm rather than from a tokenizer, so plaintext loses
 * highlighting and nothing else.
 */
export function monacoLangForPath(path: string): string {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  switch (ext) {
    case "cjs":
    case "js":
    case "mjs": {
      return "javascript";
    }
    case "css": {
      return "css";
    }
    case "htm":
    case "html": {
      return "html";
    }
    case "json": {
      return "json";
    }
    case "md": {
      return "markdown";
    }
    case "cts":
    case "mts":
    case "ts": {
      return "typescript";
    }
    case "yaml":
    case "yml": {
      return "yaml";
    }
    default: {
      return "plaintext";
    }
  }
}
