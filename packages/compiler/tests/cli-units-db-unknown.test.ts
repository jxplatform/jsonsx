/** `jx db <not-push>` — unknown db subcommands exit 1 with usage guidance. */

import { expect, test } from "bun:test";
import { runEntry } from "./_cli-harness";

test("unknown db subcommands exit 1 with usage", async () => {
  const run = await runEntry("cli", ["db", "pull"]);
  expect(run.exited).toBe(true);
  expect(run.exitCode).toBe(1);
  expect(run.errors.some((e) => e.includes("Unknown db subcommand: pull"))).toBe(true);
  expect(run.errors.some((e) => e.includes("jx db push [root]"))).toBe(true);
});
