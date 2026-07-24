import { describe, expect, test } from "bun:test";
import { handleCodeApi } from "../src/code-api";

// Code-api locates the oxlint binary by walking up from its own directory probing
// Node_modules/.bin, so in the workspace layout it finds the repo-root hoisted bin directly —
// No staging or symlinking is needed for these tests to exercise the real linter.

function codeRequest(action: string, body: unknown) {
  const url = new URL(`http://localhost/__studio/code/${action}`);
  return {
    req: new Request(url, {
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    }),
    url,
  };
}

describe("code-api — lint diagnostics adjustment", () => {
  test("reports diagnostics with line numbers adjusted past the wrapper header", async () => {
    const { req, url } = codeRequest("lint", { code: "debugger;" });
    const res = await handleCodeApi(req, url);
    const data = await (res as Response).json();
    expect(data.error).toBeUndefined();
    expect(data.diagnostics.length).toBeGreaterThan(0);
    // The wrapper adds `function __jx_fn__(...) {` as line 1; spans are shifted back
    const label = data.diagnostics[0].labels?.[0];
    expect(label.span.line).toBe(1);
  });

  test("adjusts offsets by the header length", async () => {
    const { req, url } = codeRequest("lint", { code: "debugger;" });
    const res = await handleCodeApi(req, url);
    const data = await (res as Response).json();
    const label = data.diagnostics[0].labels?.[0];
    // `debugger` starts at the beginning of the snippet
    expect(label.span.offset).toBe(0);
  });

  test("returns no diagnostics for clean code", async () => {
    const { req, url } = codeRequest("lint", { code: "return state;" });
    const res = await handleCodeApi(req, url);
    const data = await (res as Response).json();
    expect(data.error).toBeUndefined();
    expect(data.diagnostics).toEqual([]);
  });

  test("diagnostics on later lines shift accordingly", async () => {
    const { req, url } = codeRequest("lint", { code: "const ok = 1;\ndebugger;\nreturn ok;" });
    const res = await handleCodeApi(req, url);
    const data = await (res as Response).json();
    expect(data.diagnostics.length).toBeGreaterThan(0);
    const label = data.diagnostics[0].labels?.[0];
    expect(label.span.line).toBe(2);
  });
});

describe("code-api — format error path", () => {
  test("returns original code with an error when wrapping fails", async () => {
    // Args is not an array → wrapBody throws before formatting
    const { req, url } = codeRequest("format", { args: 123, code: "return 1;" });
    const res = await handleCodeApi(req, url);
    const data = await (res as Response).json();
    expect(data.code).toBe("return 1;");
    expect(data.errors.length).toBe(1);
    expect(typeof data.errors[0].message).toBe("string");
  });
});
