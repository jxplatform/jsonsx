/** `jx db push` — dbPush failures exit 1 with the error message. */

import { expect, test } from "bun:test";
import { runEntry, setDbPush } from "./_cli-harness";

test("db push failures exit 1", async () => {
  setDbPush(() => Promise.reject(new Error('Unknown connection "ghost"')));
  const run = await runEntry("cli", ["db", "push", "/proj", "--connection", "ghost"]);
  expect(run.exited).toBe(true);
  expect(run.exitCode).toBe(1);
  expect(run.errors.some((e) => e.includes('db push failed: Unknown connection "ghost"'))).toBe(
    true,
  );
});
