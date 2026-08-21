/**
 * `bun.nix` is a pure function of `bun.lock`, and nothing in CI ever said so.
 *
 * Bun2nix derives every dependency hash from the lockfile — no network, no store, no aggregate
 * `node_modules` hash to chase — so the committed `bun.nix` is stale exactly when someone changed
 * `bun.lock` without regenerating it. The root `postinstall` does that for a human running `bun
 * install` locally, and the devShell's `update-nix-hashes` does it on demand; a bot that edits the
 * lockfile does neither. Dependabot in particular has no hook that could.
 *
 * The only thing that ever noticed was `nix build` — a ~90 second job whose failure is a `bun
 * install` aborting against a 404 from the offline registry shim (packages/desktop/package.nix
 * explains that path). That is a true answer delivered slowly and in the wrong vocabulary. This is
 * the same answer in under a second, naming the packages that moved and the command that fixes it.
 *
 * IT IS NOT A BLOCKING GATE ON EVERY PULL REQUEST, on purpose. Under the dependency-autopilot
 * policy (CLAUDE.md) a Dependabot pull request merges with `bun.lock` moved and `bun.nix` untouched
 * — no bot can regenerate it on a Dependabot branch and have the result re-checked — so `main`
 * carries a lagging `bun.nix` between releases and a gate here would simply block every dependency
 * update. Three callers use it instead, each asking a different question:
 *
 * - `.github/workflows/nix.yml` runs `--fix` in the WORKING TREE before every build, so the Nix check
 *   on a pull request answers "does this dependency set build?" rather than "did a bot remember to
 *   run a generator?".
 * - `.github/workflows/release-bun-nix.yml` runs `--fix` on the release pull request and commits the
 *   result — the one branch where the file must be right, because that tree becomes the tag.
 * - Nix.yml's release leg runs it BARE. At `publish` time a drift is a failure, not a fixup: `nix run
 *   github:jxsuite/jx/release` reads the committed file.
 *
 * The generator is invoked as a SUBPROCESS rather than through its module export on purpose:
 * importing `bun2nix` runs `sade`'s `prog.parse(process.argv)` at import time, i.e. the CLI itself,
 * which prints a 289 KB Nix expression to stdout as a side effect of being imported. The wasm
 * binding underneath (`bun2nix/bun2nix-wasm.js`) has no such side effect but is a private path.
 * `bun2nix` the command is the interface the postinstall and the devShell already use, so it is the
 * one this agrees with.
 *
 *     bun scripts/check-bun-nix.ts        # the gate
 *     bun scripts/check-bun-nix.ts --fix  # regenerate bun.nix, then exit 0
 */

import { existsSync, readFileSync } from "node:fs";

/** Repo-relative, and relative to nothing else: both are read from the repository root. */
export const LOCK_FILE = "bun.lock";
export const NIX_FILE = "bun.nix";

/** The `bun2nix` devDependency range, reduced to the bare version `bunx` will accept. */
export function pinnedGeneratorVersion(manifest: unknown): string | undefined {
  const dev = (manifest as { devDependencies?: Record<string, string> })?.devDependencies;
  const range = dev?.bun2nix;
  // Only an exact-or-caret pin names one version. A range like `>=2 <3` names none, and guessing
  // Would be worse than letting bunx resolve the latest and saying so in the output.
  const m = range && /^[\^~]?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(range);
  return m ? m[1] : undefined;
}

/**
 * Where the generator lives, in preference order. `node_modules/.bin` is what a workspace install
 * provides and is the only entry that cannot fetch a DIFFERENT bun2nix than the one `bun.lock`
 * pins. The fallback exists for a tree with no `node_modules` — which is the normal state inside
 * nix.yml, where `bun install` must NOT run: `packages/desktop/package.nix` builds `src =
 * lib.cleanSource ../..`, `lib.cleanSource` does not filter `node_modules`, and an install would
 * therefore drag the entire dependency tree into the derivation's inputs. `bunx` writes only to its
 * own global cache. It is version-pinned from the manifest so the fallback and the installed binary
 * cannot disagree.
 */
export function generatorCommand(hasLocalBin: boolean, pinnedVersion?: string): string[] {
  if (hasLocalBin) {
    return ["node_modules/.bin/bun2nix", "-l", LOCK_FILE];
  }
  return ["bunx", pinnedVersion ? `bun2nix@${pinnedVersion}` : "bun2nix", "-l", LOCK_FILE];
}

export interface GenerateResult {
  ok: boolean;
  /** The Nix expression bun2nix produced, including its trailing newline. */
  text: string;
  /** Present when `ok` is false. */
  error?: string;
}

/** Run bun2nix over `bun.lock` and return what it printed. Never writes anything. */
export function generate(cwd = process.cwd()): GenerateResult {
  if (!existsSync(`${cwd}/${LOCK_FILE}`)) {
    return { ok: false, text: "", error: `${LOCK_FILE} does not exist` };
  }
  let pinned: string | undefined;
  try {
    pinned = pinnedGeneratorVersion(JSON.parse(readFileSync(`${cwd}/package.json`, "utf8")));
  } catch {
    pinned = undefined;
  }
  const cmd = generatorCommand(existsSync(`${cwd}/node_modules/.bin/bun2nix`), pinned);
  const run = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  if (run.exitCode !== 0) {
    return {
      ok: false,
      text: "",
      error: `${cmd.join(" ")} exited ${run.exitCode}: ${run.stderr.toString().trim()}`,
    };
  }
  return { ok: true, text: run.stdout.toString() };
}

/**
 * The report a stale file deserves: not a 289 KB diff, but which packages moved. bun2nix emits one
 * `"<name>@<version>" = fetch…` attribute per package, so the attribute NAMES are the dependency
 * set and diffing them says what the lockfile change did.
 */
export function attributeNames(nix: string): Set<string> {
  const names = new Set<string>();
  for (const line of nix.split("\n")) {
    const m = /^\s*"([^"]+)"\s*=\s*(?:fetchurl|fetchFromGitHub|fetchgit|copyPathToStore)/.exec(
      line,
    );
    if (m) {
      names.add(m[1]!);
    }
  }
  return names;
}

export interface Drift {
  added: string[];
  removed: string[];
  /** True when the two files differ but declare exactly the same packages (a hash or format move). */
  contentOnly: boolean;
}

export function diff(committed: string, generated: string): Drift | null {
  if (committed === generated) {
    return null;
  }
  const before = attributeNames(committed);
  const after = attributeNames(generated);
  const added = [...after].filter((n) => !before.has(n)).toSorted();
  const removed = [...before].filter((n) => !after.has(n)).toSorted();
  return { added, removed, contentOnly: added.length === 0 && removed.length === 0 };
}

/** A human-readable account of the drift, capped so a full dependency sweep stays readable. */
export function describe(drift: Drift, limit = 20): string {
  if (drift.contentOnly) {
    return (
      `  ${NIX_FILE} names the same packages as ${LOCK_FILE} but its contents differ — a hash, a\n` +
      `  URL or the generator's output format moved.`
    );
  }
  const lines: string[] = [];
  const say = (label: string, items: string[]) => {
    if (items.length === 0) {
      return;
    }
    lines.push(`  ${items.length} ${label}:`);
    for (const item of items.slice(0, limit)) {
      lines.push(`    ${label === "added" ? "+" : "-"} ${item}`);
    }
    if (items.length > limit) {
      lines.push(`    … and ${items.length - limit} more`);
    }
  };
  say("added", drift.added);
  say("removed", drift.removed);
  return lines.join("\n");
}

async function main(): Promise<void> {
  const fix = Bun.argv.includes("--fix");

  const result = generate();
  if (!result.ok) {
    console.error(`Could not regenerate ${NIX_FILE}: ${result.error}`);
    process.exit(1);
  }

  const committed = existsSync(NIX_FILE) ? await Bun.file(NIX_FILE).text() : "";
  const drift = diff(committed, result.text);

  if (drift === null) {
    console.log(`bun.nix OK: it is what bun2nix produces from ${LOCK_FILE}.`);
    process.exit(0);
  }

  if (fix) {
    await Bun.write(NIX_FILE, result.text);
    console.log(`Regenerated ${NIX_FILE} from ${LOCK_FILE}.`);
    console.log(describe(drift));
    process.exit(0);
  }

  console.error(`${NIX_FILE} is not what bun2nix produces from ${LOCK_FILE}:\n`);
  console.error(describe(drift));
  console.error(
    `\nThe Nix package is built from ${NIX_FILE}, so a stale one means \`nix build\` installs a\n` +
      `different dependency set than \`bun install\` does — in practice it aborts, because the\n` +
      `offline registry shim answers the missing tarball with a 404.\n` +
      `Run \`bun run nix:sync\` and commit ${NIX_FILE} alongside ${LOCK_FILE}.`,
  );
  process.exit(1);
}

if (import.meta.main) {
  await main();
}
