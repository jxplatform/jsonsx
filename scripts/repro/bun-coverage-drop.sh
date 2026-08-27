#!/usr/bin/env bash
# Standalone reproduction of a Bun 1.4.0 (+34cbb9a40) coverage defect: a source file that IS
# loaded and executed is omitted from `bun test --isolate --coverage` output.
#
# Kept in the tree because it is the evidence behind a rule in CLAUDE.md and behind the
# adjudication in ../check-coverage-manifest.ts, and because it is what an upstream fix should
# be checked against. It writes only under its own scratch directory and needs nothing from
# this repo — no node_modules, no jx packages, five files in total.
#
# jxsuite/jx#240 is the report; the trigger is gone from this repo (see
# packages/studio/tests/commands-defaults.test.ts), so this script is the only place the defect
# can still be observed here.
#
# Conditions, all three required:
#   1. test file A runs BEFORE test file B (bun IGNORES CLI argument order and uses the
#      tests/ directory's readdir order, so the only lever is readdir position);
#   2. A triggers TWO OR MORE un-awaited dynamic `import("M")` calls, in separate tests;
#   3. B imports M for real and asserts against it.
# Result: M is absent from coverage/lcov.info AND from the printed coverage table, while
# B's tests pass against the real M. One fire in A is not enough; two is.
#
# usage: synthetic-repro.sh [dir]   (default /tmp/bun-coverage-drop)
set -u
root=${1:-/tmp/bun-coverage-drop}

build() { # $1=root  $2=which test file to create LAST  $3=number of lazy fires
  local r=$1 last=$2 fires=$3
  rm -rf "$r"; mkdir -p "$r/src" "$r/tests"
  printf '{ "name": "bun-coverage-drop", "private": true, "type": "module" }\n' > "$r/package.json"
  printf '[test]\ncoverageReporter = ["text", "lcov"]\ncoverageSkipTestFiles = true\n' > "$r/bunfig.toml"
  cat > "$r/src/target.ts" <<'T'
export async function target(): Promise<string> {
  const parts: string[] = [];
  for (let i = 0; i < 3; i += 1) parts.push(`p${i}`);
  return parts.join("-");
}
T
  cat > "$r/src/holder.ts" <<'H'
export interface Rec { id: string; run: () => void }
export const records: readonly Rec[] = [
  { id: "repeat_node", run: () => { void import("./target").then(({ target }) => target()); } },
];
H
  { echo 'import { expect, test } from "bun:test";'
    echo 'import { records } from "../src/holder";'
    for i in $(seq 1 "$fires"); do
      echo "test(\"lazy fire $i\", () => { void records[0]!.run(); expect(1).toBe(1); });"
    done
  } > /tmp/.h4_decl.ts
  cat > /tmp/.h4_load.ts <<'L'
import { expect, test } from "bun:test";
const { target } = await import("../src/target");
test("target runs for real", async () => { expect(await target()).toBe("p0-p1-p2"); });
L
  # tmpfs prepends on create, btrfs/ext4 append -- so "created last" lands first on tmpfs and
  # last elsewhere. Both branches are run below, so whichever the local fs does, both orders
  # get measured.
  if [ "$last" = declarer ]; then
    cp /tmp/.h4_load.ts "$r/tests/b-loader.test.ts"; cp /tmp/.h4_decl.ts "$r/tests/a-declarer.test.ts"
  else
    cp /tmp/.h4_decl.ts "$r/tests/a-declarer.test.ts"; cp /tmp/.h4_load.ts "$r/tests/b-loader.test.ts"
  fi
}

run() {
  cd "$root" || exit 2
  rm -rf coverage
  bun test --isolate --coverage --reporter=junit --reporter-outfile=/tmp/.h4_j.xml >/tmp/.h4_o.txt 2>&1
  local order
  order=$(grep -o 'file="[^"]*"' /tmp/.h4_j.xml | sed 's/file="//;s/"//' | awk '!seen[$0]++' | tr '\n' ' ')
  printf '  %-56s src/target.ts in lcov: %s   (%s)\n' "$order" \
    "$(grep -c 'SF:src/target.ts' coverage/lcov.info)" \
    "$(grep -E '^ [0-9]+ pass' /tmp/.h4_o.txt | tr -d '\n' | tr -s ' ')"
}

echo "bun $(bun --revision)   fs: $(stat -f -c %T "$(dirname "$root")")"
for fires in 1 2; do
  echo "with $fires un-awaited lazy import(s) in the declarer:"
  build "$root" declarer "$fires"; run
  build "$root" loader   "$fires"; run
done
