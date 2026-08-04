/**
 * Studio shell (C7): ?project= with an explicit ?file= parameter pointing at a source file no
 * format class claims, on a path that resolves to no site context. Covers the non-site branch, the
 * ?file= override, and the bootstrap catch handler in src/studio.ts.
 */
import "./harness";
import { describe, expect, test } from "bun:test";
import { bootStudio, statusMessages, waitFor } from "./studio-shell-fixture";
import { activeTab } from "../src/workspace/workspace";

const { platform, state } = await bootStudio({
  overrides: {
    resolveSiteContext: (async () => ({ sitePath: null })) as any,
  },
  seedFiles: {
    "docs/readme.weird": "# not a recognized format",
  },
  url: "http://localhost/?project=/abs/standalone&file=docs/readme.weird",
});

await waitFor(() => statusMessages.some((m) => m.startsWith("Could not open")));

describe("?project= without a site context and an unparseable ?file=", () => {
  test("skips site activation when no sitePath is resolved", () => {
    expect(platform.projectRoot).toBe("/project");
    expect(state.calls.some((c) => c[0] === "activate")).toBe(false);
  });

  test("reads the explicit ?file= path and surfaces the parse failure", () => {
    expect(state.calls.some((c) => c[0] === "readFile" && c[1] === "docs/readme.weird")).toBe(true);
    expect(statusMessages.some((m) => m.startsWith("Could not open"))).toBe(true);
    expect(activeTab.value).toBeNull();
  });
});
