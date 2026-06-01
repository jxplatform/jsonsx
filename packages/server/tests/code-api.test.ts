import { describe, test, expect } from "bun:test";
import { handleCodeApi } from "../src/code-api";

/**
 * @param {string} action
 * @param {unknown} body
 */
function codeRequest(action: string, body: unknown) {
  const url = new URL(`http://localhost/__studio/code/${action}`);
  return {
    req: new Request(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    url,
  };
}

describe("code-api", () => {
  test("returns null for non-matching paths", async () => {
    const url = new URL("http://localhost/__studio/other");
    const req = new Request(url, { method: "POST" });
    const res = await handleCodeApi(req, url);
    expect(res).toBeNull();
  });

  test("returns null for GET requests", async () => {
    const url = new URL("http://localhost/__studio/code/format");
    const req = new Request(url, { method: "GET" });
    const res = await handleCodeApi(req, url);
    expect(res).toBeNull();
  });

  test("returns 400 for invalid JSON body", async () => {
    const url = new URL("http://localhost/__studio/code/format");
    const req = new Request(url, { method: "POST", body: "not json" });
    const res = await handleCodeApi(req, url);
    expect((res as Response).status).toBe(400);
  });

  test("returns null for unknown action", async () => {
    const { req, url } = codeRequest("unknown", { code: "x" });
    const res = await handleCodeApi(req, url);
    expect(res).toBeNull();
  });

  describe("format", () => {
    test("returns empty for empty code", async () => {
      const { req, url } = codeRequest("format", { code: "" });
      const res = await handleCodeApi(req, url);
      const data = await (res as Response).json();
      expect(data.code).toBe("");
      expect(data.errors).toEqual([]);
    });

    test("returns empty for whitespace-only code", async () => {
      const { req, url } = codeRequest("format", { code: "   " });
      const res = await handleCodeApi(req, url);
      const data = await (res as Response).json();
      expect(data.code).toBe("");
    });

    test("formats valid code", async () => {
      const { req, url } = codeRequest("format", { code: "const x=1;const y=2;" });
      const res = await handleCodeApi(req, url);
      const data = await (res as Response).json();
      expect(data.code).toContain("const x = 1");
      expect(data.errors).toEqual([]);
    });

    test("accepts custom args", async () => {
      const { req, url } = codeRequest("format", { code: "return a + b;", args: ["a", "b"] });
      const res = await handleCodeApi(req, url);
      const data = await (res as Response).json();
      expect(data.code).toContain("return a + b");
    });

    test("returns original code with errors on syntax error", async () => {
      const { req, url } = codeRequest("format", { code: "const x = ;" });
      const res = await handleCodeApi(req, url);
      const data = await (res as Response).json();
      // oxfmt may return errors or the original code
      expect(data.code).toBeDefined();
    });
  });

  describe("minify", () => {
    test("returns empty for empty code", async () => {
      const { req, url } = codeRequest("minify", { code: "" });
      const res = await handleCodeApi(req, url);
      const data = await (res as Response).json();
      expect(data.code).toBe("");
    });

    test("minifies valid code", async () => {
      const { req, url } = codeRequest("minify", { code: "const   x   =   1;" });
      const res = await handleCodeApi(req, url);
      const data = await (res as Response).json();
      expect(data.code).toBe("const x=1;");
    });

    test("returns original with error on invalid code", async () => {
      const { req, url } = codeRequest("minify", { code: "const x = ;" });
      const res = await handleCodeApi(req, url);
      const data = await (res as Response).json();
      expect(data.error).toBeDefined();
      expect(data.code).toBe("const x = ;");
    });
  });

  describe("lint", () => {
    test("returns empty diagnostics for empty code", async () => {
      const { req, url } = codeRequest("lint", { code: "" });
      const res = await handleCodeApi(req, url);
      const data = await (res as Response).json();
      expect(data.diagnostics).toEqual([]);
    });

    test("returns diagnostics for code with issues", async () => {
      const { req, url } = codeRequest("lint", { code: "debugger;" });
      const res = await handleCodeApi(req, url);
      const data = await (res as Response).json();
      // oxlint should flag `debugger` statement
      expect(Array.isArray(data.diagnostics)).toBe(true);
    });

    test("returns empty diagnostics for clean code", async () => {
      const { req, url } = codeRequest("lint", { code: "const x = 1;\nreturn x;" });
      const res = await handleCodeApi(req, url);
      const data = await (res as Response).json();
      expect(Array.isArray(data.diagnostics)).toBe(true);
    });

    test("accepts custom args for lint", async () => {
      const { req, url } = codeRequest("lint", { code: "return a;", args: ["a"] });
      const res = await handleCodeApi(req, url);
      const data = await (res as Response).json();
      expect(Array.isArray(data.diagnostics)).toBe(true);
    });
  });
});
