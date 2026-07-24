/**
 * Lint graceful degradation — the packaged desktop app ships no node_modules and no oxlint on PATH,
 * so the lint endpoint must return empty diagnostics cleanly instead of erroring. An empty
 * JX_OXLINT_BIN is the explicit disable switch and drives the same null-resolution branch.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { handleCodeApi, resolveOxlintBin } from "../src/code-api";

afterEach(() => {
  delete process.env.JX_OXLINT_BIN;
});

describe("code-api — oxlint unavailable", () => {
  test("lint returns empty diagnostics without an error", async () => {
    process.env.JX_OXLINT_BIN = "";
    expect(resolveOxlintBin()).toBeNull();

    const url = new URL("http://localhost/__studio/code/lint");
    const req = new Request(url, {
      body: JSON.stringify({ code: "debugger;" }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    const res = await handleCodeApi(req, url);
    const data = await (res as Response).json();
    expect(data).toEqual({ diagnostics: [] });
  });
});
