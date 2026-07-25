/**
 * Monaco-setup wiring tests (E9). Monaco itself cannot load in happy-dom, so the ESM contribution
 * modules are mocked and the test asserts the wiring: worker environment registration and JX/
 * project JSON schema registration on jsonDefaults.
 */
import "./harness";
import { describe, expect, mock, test } from "bun:test";

const setDiagnosticsOptions = mock((_opts: unknown) => {});

void mock.module("monaco-editor/esm/vs/language/json/monaco.contribution.js", () => ({
  jsonDefaults: { setDiagnosticsOptions },
}));
void mock.module("monaco-editor/esm/vs/editor/editor.api.js", () => ({}));
void mock.module("monaco-editor/esm/vs/language/typescript/monaco.contribution.js", () => ({}));
void mock.module(
  "monaco-editor/esm/vs/basic-languages/javascript/javascript.contribution.js",
  () => ({}),
);

class FakeWorker {
  url: string;
  options: unknown;
  constructor(url: string, options?: unknown) {
    this.url = url;
    this.options = options;
  }
}
(globalThis as any).Worker = FakeWorker;
(globalThis as any).self ??= globalThis;

const { applyProjectSchemas, modelUriFor, resetProjectSchemas } =
  await import("../src/services/monaco-setup");

function diagnosticsArg(): any {
  const [opts] = setDiagnosticsOptions.mock.calls[0]!;
  return opts;
}

function latestDiagnosticsArg(): any {
  const call = setDiagnosticsOptions.mock.calls.at(-1)!;
  return call[0];
}

describe("monaco-setup — JSON diagnostics registration", () => {
  test("registers the bundled fallback once at import", () => {
    expect(setDiagnosticsOptions).toHaveBeenCalledTimes(1);
  });

  test("registers validation with comments disallowed", () => {
    const opts = diagnosticsArg();
    expect(opts.validate).toBe(true);
    expect(opts.allowComments).toBe(false);
    expect(opts.schemas).toHaveLength(4);
  });

  test("registers the JX document schema for document folders", () => {
    const [jx] = diagnosticsArg().schemas;
    expect(jx.uri).toBe("https://jxsuite.com/schema/v1");
    expect(jx.schema).toBeTruthy();
    expect(typeof jx.schema).toBe("object");
    for (const pattern of [
      "pages/*.json",
      "pages/**/*.json",
      "layouts/*.json",
      "layouts/**/*.json",
      "components/*.json",
      "components/**/*.json",
      "elements/*.json",
      "elements/**/*.json",
    ]) {
      expect(jx.fileMatch).toContain(pattern);
    }
  });

  test("registers the project schema for project.json", () => {
    const [, project] = diagnosticsArg().schemas;
    expect(project.uri).toBe("https://jxsuite.com/schema/project/v1");
    expect(project.fileMatch).toEqual(["project.json"]);
    expect(project.schema).toBeTruthy();
  });

  /* The committed entry documents are bound by a RELATIVE in-document `$schema` (extensions.md
     §5.2), which the language service resolves against the model's own directory — every studio
     model is mounted at file:///<project-relative-path>, so project.json's "./project.schema.json"
     lands on the project root. An in-document `$schema` also OVERRIDES fileMatch, so without these
     ids registered the resolution has nothing to hit, `enableSchemaRequest` being off turns that
     into "No schema request service available", and the file validates against an empty schema. */
  test("registers the same schemas under the entry-document file:// ids", () => {
    const [documentByPattern, projectByPattern, projectById, documentById] =
      diagnosticsArg().schemas;
    expect(projectById.uri).toBe("file:///project.schema.json");
    expect(projectById.schema).toBe(projectByPattern.schema);
    expect(documentById.uri).toBe("file:///document.schema.json");
    expect(documentById.schema).toBe(documentByPattern.schema);
  });

  test("the file:// registrations carry no fileMatch — they resolve by id only", () => {
    const byId = diagnosticsArg().schemas.filter((s: { uri: string }) =>
      s.uri.startsWith("file:///"),
    );
    expect(byId).toHaveLength(2);
    for (const entry of byId) {
      expect(entry.fileMatch).toBeUndefined();
    }
  });
});

describe("monaco-setup — MonacoEnvironment workers", () => {
  const getWorker = (label: string): FakeWorker =>
    (self as any).MonacoEnvironment.getWorker(undefined, label);

  /** Workers resolve against the MODULE, so the expected base is monaco-setup.ts's own directory. */
  const expected = (file: string) =>
    new URL(`../src/services/workers/${file}`, import.meta.url).href;

  test("maps known labels to their worker bundles as module workers", () => {
    const json = getWorker("json");
    expect(json).toBeInstanceOf(FakeWorker);
    expect(json.url).toBe(expected("json.worker.js"));
    expect(json.options).toEqual({ type: "module" });

    expect(getWorker("typescript").url).toBe(expected("ts.worker.js"));
    expect(getWorker("javascript").url).toBe(expected("ts.worker.js"));
    expect(getWorker("editorWorkerService").url).toBe(expected("editor.worker.js"));
  });

  test("falls back to the editor worker for unknown labels", () => {
    expect(getWorker("made-up-label").url).toBe(expected("editor.worker.js"));
  });

  /* Regression guard for every packaged host. The old root-absolute /monaco-editor/… path resolved
     on the repo dev server alone; on desktop (views://studio/, /__studio__/) and in the cloud it
     404s, and a worker that never starts takes the whole JSON language service — schema validation
     included — down silently. Self-location is the only rule that holds for all of them, and it is
     the ONLY one that survives the cloud's deep /edit/:owner/:repo@:branch shell path, where a
     document-relative URL would resolve into /edit/:owner/. */
  test("worker urls are absolute and module-relative, never root-absolute", () => {
    for (const label of ["json", "typescript", "editorWorkerService", "made-up-label"]) {
      const { url } = getWorker(label);
      expect(url.startsWith("/monaco-editor/")).toBe(false);
      expect(new URL(url).href).toBe(url);
      // Sibling of the bundle, NOT of the HTML document that happens to load it.
      const file = url.slice(url.lastIndexOf("/") + 1);
      expect(url).toBe(expected(file));
    }
  });
});

describe("monaco-setup — applyProjectSchemas", () => {
  const bundledDocumentSchema = diagnosticsArg().schemas[0].schema;
  const bundledProjectSchema = diagnosticsArg().schemas[1].schema;

  test("a null or empty payload leaves the bundled registration untouched", () => {
    const before = setDiagnosticsOptions.mock.calls.length;
    expect(applyProjectSchemas(null)).toBe(false);
    expect(applyProjectSchemas({})).toBe(false);
    expect(setDiagnosticsOptions.mock.calls.length).toBe(before);
  });

  test("registers fetched schemas inline, keeping fileMatch and uris stable", () => {
    const project = { allOf: [{ $ref: "https://jxsuite.com/schema/project/core/v2" }] };
    const documentSchema = { $ref: "https://jxsuite.com/schema/v1" };
    expect(applyProjectSchemas({ document: documentSchema, project })).toBe(true);
    const opts = latestDiagnosticsArg();
    expect(opts.schemas[0].schema).toBe(documentSchema);
    expect(opts.schemas[0].uri).toBe("https://jxsuite.com/schema/v1");
    expect(opts.schemas[0].fileMatch).toContain("pages/**/*.json");
    expect(opts.schemas[1].schema).toBe(project);
    expect(opts.schemas[1].uri).toBe("https://jxsuite.com/schema/project/v1");
    expect(opts.schemas[1].fileMatch).toEqual(["project.json"]);
    // The per-project pair must ALSO reach the ids the committed entry documents bind by,
    // Otherwise the `$schema` pointer keeps resolving to the core fallback.
    expect(opts.schemas[2]).toEqual({ schema: project, uri: "file:///project.schema.json" });
    expect(opts.schemas[3]).toEqual({
      schema: documentSchema,
      uri: "file:///document.schema.json",
    });
  });

  test("a partial payload falls back to the bundled schema for the missing half", () => {
    const project = { type: "object" };
    expect(applyProjectSchemas({ project })).toBe(true);
    const opts = latestDiagnosticsArg();
    expect(opts.schemas[0].schema).toBe(bundledDocumentSchema);
    expect(opts.schemas[1].schema).toBe(project);
    expect(opts.schemas[3].schema).toBe(bundledDocumentSchema);
  });

  /* Monaco's JSON adapter calls resetSchema(model.uri) when a model is disposed, which drops the
     inline content of the handle registered under the SAME id. Mounting the generated entry
     documents at their natural path would mean opening project.schema.json in the source view and
     closing it silently un-registers the project schema for the rest of the session. */
  test("the generated entry documents mount off the registered ids", () => {
    const ids = diagnosticsArg()
      .schemas.map((s: { uri: string }) => s.uri)
      .filter((uri: string) => uri.startsWith("file:///"));
    for (const name of ["project.schema.json", "document.schema.json"]) {
      expect(modelUriFor(name)).toBe(`file:///.jx/generated/${name}`);
      expect(ids).not.toContain(modelUriFor(name));
      expect(ids).toContain(`file:///${name}`);
    }
  });

  test("every other file keeps its project-relative uri", () => {
    // The relative `$schema` of a document is resolved against THIS uri's directory, so the path
    // Has to stay faithful to where the file actually lives.
    expect(modelUriFor("project.json")).toBe("file:///project.json");
    expect(modelUriFor("pages/index.json")).toBe("file:///pages/index.json");
    expect(modelUriFor("pages/blog/post.json")).toBe("file:///pages/blog/post.json");
    // Only the project ROOT copies are reserved — a same-named file in a subfolder is not one.
    expect(modelUriFor("schemas/project.schema.json")).toBe("file:///schemas/project.schema.json");
  });

  test("resetProjectSchemas restores the bundled pair", () => {
    resetProjectSchemas();
    const opts = latestDiagnosticsArg();
    expect(opts.schemas[0].schema).toBe(bundledDocumentSchema);
    expect(opts.schemas[1].schema).toBe(bundledProjectSchema);
  });
});
