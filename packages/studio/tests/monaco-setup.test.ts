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

const { refreshProjectSchemas, resetProjectSchemas } = await import("../src/services/monaco-setup");

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
    expect(opts.schemas).toHaveLength(2);
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
});

describe("monaco-setup — MonacoEnvironment workers", () => {
  const getWorker = (label: string): FakeWorker =>
    (self as any).MonacoEnvironment.getWorker(undefined, label);

  test("maps known labels to their worker bundles as module workers", () => {
    const json = getWorker("json");
    expect(json).toBeInstanceOf(FakeWorker);
    expect(json.url).toBe("/monaco-editor/esm/vs/language/json/json.worker.js");
    expect(json.options).toEqual({ type: "module" });

    expect(getWorker("typescript").url).toBe(
      "/monaco-editor/esm/vs/language/typescript/ts.worker.js",
    );
    expect(getWorker("javascript").url).toBe(
      "/monaco-editor/esm/vs/language/typescript/ts.worker.js",
    );
    expect(getWorker("editorWorkerService").url).toBe(
      "/monaco-editor/esm/vs/editor/editor.worker.js",
    );
  });

  test("falls back to the editor worker for unknown labels", () => {
    expect(getWorker("made-up-label").url).toBe("/monaco-editor/esm/vs/editor/editor.worker.js");
  });
});

describe("monaco-setup — refreshProjectSchemas", () => {
  const bundledDocumentSchema = diagnosticsArg().schemas[0].schema;
  const bundledProjectSchema = diagnosticsArg().schemas[1].schema;

  test("platforms without fetchProjectSchemas keep the bundled registration", async () => {
    const before = setDiagnosticsOptions.mock.calls.length;
    expect(await refreshProjectSchemas({})).toBe(false);
    expect(setDiagnosticsOptions.mock.calls.length).toBe(before);
  });

  test("fetch failures and empty payloads leave the registration untouched", async () => {
    const before = setDiagnosticsOptions.mock.calls.length;
    expect(
      await refreshProjectSchemas({
        fetchProjectSchemas: () => Promise.reject(new Error("offline")),
      }),
    ).toBe(false);
    expect(await refreshProjectSchemas({ fetchProjectSchemas: async () => ({}) })).toBe(false);
    expect(setDiagnosticsOptions.mock.calls.length).toBe(before);
  });

  test("registers fetched schemas inline, keeping fileMatch and uris stable", async () => {
    const project = { allOf: [{ $ref: "https://jxsuite.com/schema/project/core/v2" }] };
    const documentSchema = { $ref: "https://jxsuite.com/schema/v1" };
    expect(
      await refreshProjectSchemas({
        fetchProjectSchemas: async () => ({ document: documentSchema, project }),
      }),
    ).toBe(true);
    const opts = latestDiagnosticsArg();
    expect(opts.schemas[0].schema).toBe(documentSchema);
    expect(opts.schemas[0].uri).toBe("https://jxsuite.com/schema/v1");
    expect(opts.schemas[0].fileMatch).toContain("pages/**/*.json");
    expect(opts.schemas[1].schema).toBe(project);
    expect(opts.schemas[1].uri).toBe("https://jxsuite.com/schema/project/v1");
    expect(opts.schemas[1].fileMatch).toEqual(["project.json"]);
  });

  test("a partial payload falls back to the bundled schema for the missing half", async () => {
    const project = { type: "object" };
    expect(await refreshProjectSchemas({ fetchProjectSchemas: async () => ({ project }) })).toBe(
      true,
    );
    const opts = latestDiagnosticsArg();
    expect(opts.schemas[0].schema).toBe(bundledDocumentSchema);
    expect(opts.schemas[1].schema).toBe(project);
  });

  test("resetProjectSchemas restores the bundled pair", () => {
    resetProjectSchemas();
    const opts = latestDiagnosticsArg();
    expect(opts.schemas[0].schema).toBe(bundledDocumentSchema);
    expect(opts.schemas[1].schema).toBe(bundledProjectSchema);
  });
});
