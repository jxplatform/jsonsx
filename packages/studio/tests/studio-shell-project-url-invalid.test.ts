/**
 * Studio shell (C7): the ?open= alias of the project URL parameter with a relative path, which
 * src/studio.ts rejects with a statusbar error before any platform probing.
 */
import "./harness";
import { describe, expect, test } from "bun:test";
import { bootStudio, statusMessages } from "./studio-shell-fixture";

const { state } = await bootStudio({
  url: "http://localhost/?open=relative/dir",
});

describe("?open= with a relative path", () => {
  test("reports the path as invalid without probing the platform", () => {
    expect(statusMessages).toContain(
      'Error: ?project= requires an absolute path (got "relative/dir")',
    );
    expect(state.calls.some((c) => c[0] === "resolveSiteContext")).toBe(false);
    expect(state.calls.some((c) => c[0] === "probeRootProject")).toBe(false);
    expect(state.calls.some((c) => c[0] === "readFile")).toBe(false);
  });
});
