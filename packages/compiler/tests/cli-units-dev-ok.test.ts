/**
 * Cli-units-dev-ok.test.ts — jx dev success footprint (incl. --port parsing)
 *
 * See _cli-harness.ts for the one-footprint-per-process constraint.
 */

import { describe, expect, it } from "bun:test";
import { resolve } from "node:path";
import { runDevCalls, runEntry, setRunDev } from "./_cli-harness.ts";

describe("jx cli — dev", () => {
  it("runs the dev command with the resolved root and parsed --port", async () => {
    runDevCalls.length = 0;
    setRunDev(() => ({}));
    const result = await runEntry("cli", ["dev", "/tmp/jx-dev-site", "--port", "5000"]);
    expect(result.exited).toBe(false);
    expect(runDevCalls).toHaveLength(1);
    expect(runDevCalls[0]?.root).toBe(resolve("/tmp/jx-dev-site"));
    expect(runDevCalls[0]?.port).toBe(5000);
  });
});
