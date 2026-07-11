/** `jx db push --dry-run --connection main` — happy path through the mocked dbPush. */

import { expect, test } from "bun:test";
import { dbPushCalls, runEntry, setDbPush } from "./_cli-harness";

test("db push forwards flags, prints statements/warnings, and reports bindings", async () => {
  setDbPush(async () => ({
    bindingsPatched: true,
    results: [
      {
        applied: false,
        connection: "main",
        provider: "d1",
        statements: ['create table "comments" (...)'],
        tables: ["comments"],
        warnings: ["comments.legacy: column exists in the database but not in the schema"],
      },
    ],
    wranglerPath: "/proj/wrangler.jsonc",
  }));

  const run = await runEntry("cli", ["db", "push", "/proj", "--dry-run", "--connection", "main"]);
  expect(run.exited).toBe(false);
  expect(dbPushCalls).toEqual([{ opts: { connection: "main", dryRun: true }, root: "/proj" }]);
  expect(run.logs.some((l) => l.includes("main (d1) — 1 table(s), 1 statement(s) [dry-run]"))).toBe(
    true,
  );
  expect(run.logs.some((l) => l.includes('create table "comments"'))).toBe(true);
  expect(run.logs.some((l) => l.includes("Updated bindings in"))).toBe(true);
});
