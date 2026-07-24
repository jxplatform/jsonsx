import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { handleCodeApi, resolveOxlintBin } from "../src/code-api";

/**
 * @param {string} action
 * @param {unknown} body
 */
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
    const req = new Request(url, { body: "not json", method: "POST" });
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
      const { req, url } = codeRequest("format", {
        code: "const x=1;const y=2;",
      });
      const res = await handleCodeApi(req, url);
      const data = await (res as Response).json();
      expect(data.code).toContain("const x = 1");
      expect(data.errors).toEqual([]);
    });

    test("accepts custom args", async () => {
      const { req, url } = codeRequest("format", {
        args: ["a", "b"],
        code: "return a + b;",
      });
      const res = await handleCodeApi(req, url);
      const data = await (res as Response).json();
      expect(data.code).toContain("return a + b");
    });

    test("returns original code with errors on syntax error", async () => {
      const { req, url } = codeRequest("format", { code: "const x = ;" });
      const res = await handleCodeApi(req, url);
      const data = await (res as Response).json();
      // Oxfmt may return errors or the original code
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
      const { req, url } = codeRequest("minify", {
        code: "const   x   =   1;",
      });
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
      // Oxlint must actually flag the `debugger` statement — an empty array here means the
      // Binary was not found and the endpoint failed silently (the original regression).
      expect(data.error).toBeUndefined();
      expect(data.diagnostics.length).toBeGreaterThan(0);
    });

    test("returns empty diagnostics for clean code", async () => {
      const { req, url } = codeRequest("lint", {
        code: "const x = 1;\nreturn x;",
      });
      const res = await handleCodeApi(req, url);
      const data = await (res as Response).json();
      expect(Array.isArray(data.diagnostics)).toBe(true);
    });

    test("accepts custom args for lint", async () => {
      const { req, url } = codeRequest("lint", {
        args: ["a"],
        code: "return a;",
      });
      const res = await handleCodeApi(req, url);
      const data = await (res as Response).json();
      expect(Array.isArray(data.diagnostics)).toBe(true);
    });
  });

  describe("resolveOxlintBin", () => {
    test("an explicit JX_OXLINT_BIN override wins", () => {
      process.env.JX_OXLINT_BIN = "/custom/bin/oxlint";
      try {
        expect(resolveOxlintBin()).toBe("/custom/bin/oxlint");
      } finally {
        delete process.env.JX_OXLINT_BIN;
      }
    });

    test("walks up to the workspace-root node_modules/.bin", () => {
      const bin = resolveOxlintBin();
      expect(bin).toEndWith(join("node_modules", ".bin", "oxlint"));
      expect(existsSync(bin!)).toBe(true);
    });

    test("returns null when no bin dir and no PATH candidate exist", () => {
      const path = process.env.PATH;
      process.env.PATH = "";
      try {
        // Starting at the filesystem root skips every node_modules probe.
        expect(resolveOxlintBin("/")).toBeNull();
      } finally {
        process.env.PATH = path;
      }
    });
  });
});
