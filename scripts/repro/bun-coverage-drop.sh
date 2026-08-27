#!/usr/bin/env bash
# Reproduction of a Bun 1.4.0 (+34cbb9a40) coverage defect: `bun test --coverage` omits a source
# file from BOTH the lcov and the printed table when two or more dynamic `import()`s of that module
# are in flight at once. The module body evaluates exactly once and its exports work; only the
# coverage RECORD is lost.
#
# The severity is worse than a missing row. An omitted file is ABSENT rather than reported at 0%,
# so no per-file `coverageThreshold` can fire on it and the aggregate is computed as though it did
# not exist — a coverage gate silently turned into a no-op for that file. That is what
# `scripts/check-coverage-manifest.ts` is standing in front of.
#
# Two cases, because the second is the shape that actually bit this repo (jxsuite/jx#240):
#
#   A. Concurrency, minimal. `Promise.all([import(M), import(M)])` drops it; the same two imports
#      awaited in sequence do not. One test file, no ordering, no jx code.
#   B. The same defect reached indirectly, which is how it looks in real code. A command record
#      whose `run()` fires `void import(M).then(...)` and never awaits it, invoked from two tests:
#      the first floating import has not settled when the second starts, so they overlap.
#
# Case B is why `packages/studio/tests/commands-defaults.test.ts` doubles its converter with
# `mock.module()` — a double resolves from the registry, so no two real imports ever overlap.
#
# Needs nothing from this repo: no node_modules, no jx packages. Writes only under its own scratch
# directory. usage: bun-coverage-drop.sh [dir]   (default /tmp/bun-coverage-drop)
set -u
root=${1:-/tmp/bun-coverage-drop}
evidence=$root/.module-body-ran

scaffold() {
  rm -rf "$root"
  mkdir -p "$root/src" "$root/tests"
  printf '{ "name": "bun-coverage-drop", "private": true, "type": "module" }\n' >"$root/package.json"
  printf '[test]\ncoverageReporter = ["text", "lcov"]\n' >"$root/bunfig.toml"
  cat >"$root/src/target.ts" <<T
// The oracle: this line proves the module body executed, whatever coverage decides to report.
import { appendFileSync } from "node:fs";

appendFileSync("$evidence", "ran\\n");

export function target(): string {
  return "REAL";
}
T
  cat >"$root/src/command.ts" <<'T'
// A command record shaped like the real thing: `run` starts a flow and returns, so the import it
// fires is floating. Nothing downstream can await it.
export const record = {
  id: "repeat_node",
  run: () => {
    void import("./target").then(({ target }) => target());
  },
};
T
}

# $1 = human label, $2 = the test file body
measure() {
  printf '%s\n' "$2" >"$root/tests/only.test.ts"
  rm -rf "$root/coverage"
  rm -f "$evidence"
  (cd "$root" && bun test --coverage >/dev/null 2>&1)
  # `grep -c` prints 0 AND exits non-zero on no match, so an `|| echo 0` fallback would double it.
  local ran records
  ran=$(wc -l <"$evidence" 2>/dev/null) || ran=0
  records=$(grep -c '^SF:src/target.ts' "$root/coverage/lcov.info" 2>/dev/null) || true
  printf '  %-46s body ran: %s   lcov records: %s\n' "$1" "${ran:-0}" "${records:-0}"
}

scaffold
echo "bun $(bun --revision)"
echo
echo "A. directly — two imports of one module, overlapping vs not:"
measure "Promise.all([import(M), import(M)])  BUG" 'import { expect, test } from "bun:test";

test("concurrent", async () => {
  const [a, b] = await Promise.all([import("../src/target"), import("../src/target")]);
  expect(a.target()).toBe("REAL");
  expect(b.target()).toBe("REAL");
});'
measure "await import(M); await import(M)  control" 'import { expect, test } from "bun:test";

test("sequential", async () => {
  const a = await import("../src/target");
  const b = await import("../src/target");
  expect(a.target()).toBe("REAL");
  expect(b.target()).toBe("REAL");
});'

echo
echo "B. indirectly — a command whose run() fires a floating import, called from N tests:"
measure "run() from two tests  BUG" 'import { expect, test } from "bun:test";
import { record } from "../src/command";

test("fire one", () => {
  record.run();
  expect(1).toBe(1);
});
test("fire two", () => {
  record.run();
  expect(1).toBe(1);
});
test("let them settle", async () => {
  await new Promise((done) => {
    setTimeout(done, 50);
  });
  expect(1).toBe(1);
});'
measure "run() from one test  control" 'import { expect, test } from "bun:test";
import { record } from "../src/command";

test("fire one", () => {
  record.run();
  expect(1).toBe(1);
});
test("let it settle", async () => {
  await new Promise((done) => {
    setTimeout(done, 50);
  });
  expect(1).toBe(1);
});'

echo
echo "In every row the module body ran exactly once. A 0 in the last column is the defect:"
echo "the file is absent from the report, not present at 0%, so no threshold can fire on it."
