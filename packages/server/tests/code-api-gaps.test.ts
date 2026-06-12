import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { handleCodeApi } from "../src/code-api";
import { dirname, resolve } from "node:path";
import { existsSync, mkdirSync, rmSync, rmdirSync, symlinkSync } from "node:fs";

// Code-api resolves the oxlint binary relative to its own source directory:
// Packages/server/src/../../node_modules/.bin/oxlint → packages/node_modules/.bin.
// That directory does not exist in a workspace layout, so link the repo-root
// Binary there for the duration of this test file.
const OXLINT_EXPECTED = resolve(
  import.meta.dir,
  "../src/../../node_modules/.bin",
  process.platform === "win32" ? "oxlint.exe" : "oxlint",
);
const OXLINT_REAL = resolve(
  import.meta.dir,
  "../../../node_modules/.bin",
  process.platform === "win32" ? "oxlint.exe" : "oxlint",
);

let createdLink = false;
let createdBinDir = false;
let createdModulesDir = false;

beforeAll(() => {
  if (!existsSync(OXLINT_EXPECTED) && existsSync(OXLINT_REAL)) {
    createdModulesDir = !existsSync(dirname(dirname(OXLINT_EXPECTED)));
    createdBinDir = !existsSync(dirname(OXLINT_EXPECTED));
    mkdirSync(dirname(OXLINT_EXPECTED), { recursive: true });
    symlinkSync(OXLINT_REAL, OXLINT_EXPECTED);
    createdLink = true;
  }
});

afterAll(() => {
  try {
    if (createdLink) {
      rmSync(OXLINT_EXPECTED, { force: true });
    }
    if (createdBinDir) {
      rmdirSync(dirname(OXLINT_EXPECTED));
    }
    if (createdModulesDir) {
      rmdirSync(dirname(dirname(OXLINT_EXPECTED)));
    }
  } catch {}
});

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
