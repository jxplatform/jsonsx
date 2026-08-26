/**
 * `vendor/electrobun` is the Electrobun SDK's TypeScript sources, and this is the one thing that
 * puts them there and proves they are the right ones.
 *
 * Electrobun 2 publishes no SDK to npm. `node_modules/electrobun` is a CLI bootstrap whose
 * `exports` map sends every specifier — `electrobun`, `electrobun/main`, `electrobun/view`, types
 * and all — to a module whose entire body is `throw new Error(...)`. The sources reach a project
 * only when Hutch downloads that release's core archive and copies them into a gitignored
 * `.hutch/devkit`. That is a network step, so before this script existed a fresh `git clone && bun
 * install` could not typecheck `packages/desktop` at all, and CI had to run `electrobun prepare`
 * just to reach `tsc`.
 *
 * The submodule replaces that for TYPECHECKING only. Hutch's `.hutch/devkit` remains the build
 * sysroot, and the two agree by construction: the devkit is a verbatim copy of the same five
 * directories (196 of 197 files byte-identical at 2.0.1 — the exception is a Linux-only null guard
 * in `webGPU.ts` with no type surface). So the gate here asserts they name the same RELEASE rather
 * than the same bytes; demanding byte equality would fail on upstream's own release-versus-tag
 * slop, which is not ours to police. `--fix` reports those byte differences anyway, because a
 * growing list is the signal that the assumption stopped holding.
 *
 * The version has two writers — the `electrobun` devDependency pin and this submodule's gitlink —
 * so the gate is what keeps them together. A Dependabot bump moves the pin alone, goes red here,
 * and `bun run electrobun:sync` is the one-command follow-up.
 *
 *     bun scripts/check-electrobun-vendor.ts                # the gate
 *     bun scripts/check-electrobun-vendor.ts --init         # check out/sparsify/stub, then gate
 *     bun scripts/check-electrobun-vendor.ts --fix          # …and move to the pinned tag
 *     bun scripts/check-electrobun-vendor.ts --fix --soft   # …and never exit non-zero
 *
 * `--init` is what CI uses. It deliberately stops short of moving the gitlink, because moving it is
 * exactly how a Dependabot bump would stop looking like a mismatch — CI has to materialise the
 * submodule to typecheck at all, and still report the disagreement it was sent to find.
 *
 * `--fix --soft` is what the root `postinstall` uses: a contributor without the submodule should
 * get an actionable line, not a failed `bun install`. It also suppresses the drift report, which is
 * a note for someone who asked rather than something to print on every install.
 *
 * @docs extending/contributing/monorepo
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** Repo-relative. Everything here is resolved from the repository root. */
export const VENDOR_DIR = "vendor/electrobun";
export const DESKTOP_MANIFEST = "packages/desktop/package.json";
export const VENDOR_MANIFEST = `${VENDOR_DIR}/package/package.json`;
export const DEVKIT_PROJECTION = "packages/desktop/.hutch/devkit/projection.json";

/**
 * The SDK's own source root inside the submodule. Upstream's build is a plain recursive copy of
 * five directories under here into `dist/api`, and Hutch's projection copies that same tree again,
 * so `package/src` IS the devkit's `api` with one level of indirection removed.
 */
export const SDK_SRC = `${VENDOR_DIR}/package/src`;

/**
 * The entry points `packages/desktop` imports, and therefore the only `paths` targets its tsconfig
 * needs. Kept here as well so the gate fails on a missing file with a useful name rather than
 * leaving `tsc` to report `TS2307` a step later. Add an entry when the desktop package imports a
 * fourth subpath — `packages/desktop/tests/electrobun-config.test.ts` asserts the two lists agree.
 */
export const SDK_ENTRY_POINTS = [
  `${SDK_SRC}/sdks/main/index.ts`,
  `${SDK_SRC}/browser/index.ts`,
] as const;

/**
 * Narrows a 26 MB checkout to 1 MB.
 *
 * The five directories are exactly what upstream's `copyApiFiles()` projects, and they are
 * inseparable: `sdks/main` reaches sideways into `../../config`, `../../../shared` and
 * `../../../preload`. The exclusions are ours. Upstream interleaves ~40 `*.test.ts` files with its
 * sources and ships one `.md` among them; left in the tree those would be collected by a root-level
 * `bun test`, normalized by `bun run format:md`, and globbed by `check-coverage-manifest.ts`. None
 * of them is reachable from an entry point, so dropping them costs nothing and removes three
 * collisions with repo-wide gates.
 *
 * Non-cone mode is required — cone mode cannot express the `!` exclusions.
 */
export const SPARSE_PATTERNS = [
  "/LICENSE",
  "/package/package.json",
  "/package/src/browser/",
  "/package/src/config/",
  "/package/src/preload/",
  "/package/src/shared/",
  "/package/src/sdks/main/",
  "!*.test.ts",
  "!**/__tests__/**",
  "!*.md",
] as const;

/**
 * `sdks/main/proc/native.ts` imports `../../../preload/.generated/compiled`, which upstream
 * generates by bundling the preload and gitignores (`/package/src/preload/.generated`). Nothing in
 * a typecheck reads the strings, so the stub upstream's OWN contract tests use is enough — and
 * because the path is ignored, writing it leaves both the submodule and this repo clean.
 */
export const STUB_PATH = `${SDK_SRC}/preload/.generated/compiled.ts`;
export const STUB_CONTENTS =
  'export const preloadScript = "";\nexport const preloadScriptSandboxed = "";\n';

/**
 * The pin must name ONE version. `electrobun` is a devDependency of `packages/desktop` and is
 * pinned exactly there; a range would name a set of releases and no single tag to check out, so it
 * is rejected rather than guessed at.
 */
export function pinnedVersion(manifest: unknown): string | undefined {
  const dev = (manifest as { devDependencies?: Record<string, string> })?.devDependencies;
  const range = dev?.electrobun;
  return range && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(range) ? range : undefined;
}

/** The version the checked-out submodule declares. Read from a file, never from `git describe`. */
export function vendoredVersion(manifest: unknown): string | undefined {
  const version = (manifest as { version?: unknown })?.version;
  return typeof version === "string" ? version : undefined;
}

/** The tag upstream publishes for a given release. */
export function tagFor(version: string): string {
  return `v${version}`;
}

export interface Status {
  ok: boolean;
  /** The exact version `packages/desktop` depends on, or undefined when the pin is unreadable. */
  pinned?: string;
  /** The version the submodule is checked out at, or undefined when it is not initialised. */
  vendored?: string;
  /** Entry points named by `SDK_ENTRY_POINTS` that are not on disk. */
  missing: string[];
  problem?: "no-pin" | "not-initialised" | "version-mismatch" | "missing-sources" | "no-stub";
}

/**
 * Decide, from facts already gathered, whether the vendored SDK is usable. Split out from the
 * filesystem so the interesting combinations are testable without a git checkout.
 */
export function evaluate(facts: {
  pinned?: string;
  vendored?: string;
  missing: string[];
  hasStub: boolean;
}): Status {
  const { pinned, vendored, missing, hasStub } = facts;
  const base = { pinned, vendored, missing } as const;
  if (!pinned) {
    return { ...base, ok: false, problem: "no-pin" };
  }
  if (!vendored) {
    return { ...base, ok: false, problem: "not-initialised" };
  }
  if (vendored !== pinned) {
    return { ...base, ok: false, problem: "version-mismatch" };
  }
  if (missing.length > 0) {
    return { ...base, ok: false, problem: "missing-sources" };
  }
  if (!hasStub) {
    return { ...base, ok: false, problem: "no-stub" };
  }
  return { ...base, ok: true };
}

/** What went wrong and what to type. One paragraph per problem, never a stack trace. */
export function describe(status: Status): string {
  switch (status.problem) {
    case "no-pin": {
      return (
        `The \`electrobun\` devDependency in ${DESKTOP_MANIFEST} is missing or is a range.\n` +
        `It must be an exact version, because it names the submodule tag to check out.`
      );
    }
    case "not-initialised": {
      return (
        `${VENDOR_DIR} is not checked out, so \`electrobun/*\` resolves to nothing and\n` +
        `\`bun run --cwd packages/desktop typecheck\` cannot run.\n` +
        `Run \`bun run electrobun:sync\`.`
      );
    }
    case "version-mismatch": {
      return (
        `${VENDOR_DIR} is at ${status.vendored}, but ${DESKTOP_MANIFEST} depends on ` +
        `${status.pinned}.\n` +
        `The submodule is the typecheck sysroot for that release, so the two must agree.\n` +
        `Run \`bun run electrobun:sync\` to move the submodule to ${tagFor(status.pinned!)}, then\n` +
        `commit the moved gitlink.`
      );
    }
    case "missing-sources": {
      const files = status.missing.map((file) => `  ${file}`).join("\n");
      return (
        `${VENDOR_DIR} is checked out at ${status.vendored} but ${status.missing.length} entry ` +
        `point(s) are absent:\n${files}\n` +
        `The sparse-checkout is probably narrower than the SDK now needs.\n` +
        `Run \`bun run electrobun:sync\`.`
      );
    }
    case "no-stub": {
      return (
        `${STUB_PATH} is absent. The SDK's \`proc/native.ts\` imports it, so every\n` +
        `\`electrobun/main\` import fails to resolve without it. It is generated, not committed.\n` +
        `Run \`bun run electrobun:sync\`.`
      );
    }
    default: {
      return `electrobun vendor OK: ${VENDOR_DIR} is at ${status.vendored}, matching ${DESKTOP_MANIFEST}.`;
    }
  }
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

/** Gather the facts `evaluate` judges. Reads only; creates nothing. */
export function inspect(cwd = process.cwd()): Status {
  const at = (path: string) => join(cwd, path);
  const desktop = readJson(at(DESKTOP_MANIFEST));
  const vendor = readJson(at(VENDOR_MANIFEST));
  return evaluate({
    pinned: pinnedVersion(desktop),
    vendored: vendoredVersion(vendor),
    missing: SDK_ENTRY_POINTS.filter((file) => !existsSync(at(file))),
    hasStub: existsSync(at(STUB_PATH)),
  });
}

function git(args: string[], cwd: string): { ok: boolean; stdout: string; stderr: string } {
  const run = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  return {
    ok: run.exitCode === 0,
    stdout: run.stdout.toString().trim(),
    stderr: run.stderr.toString().trim(),
  };
}

/**
 * Materialise the submodule: check it out, narrow it, write the stub — and, when `pin` is set, move
 * it to the tag the `electrobun` devDependency names.
 *
 * `pin` is the whole difference between the two callers. A human running `electrobun:sync` wants
 * the submodule brought to whatever the pin now says; CI must NOT, because moving it is precisely
 * how a Dependabot bump would stop looking like a mismatch. So CI passes `--init`, which leaves the
 * committed gitlink alone and lets the check that follows report the disagreement.
 *
 * Order matters. Sparse patterns are applied BEFORE the tag checkout so the full 26 MB tree is
 * materialised at most once, by the initial clone, and never again. The shallow fetch asks for the
 * tag by name; if the host will not serve an arbitrary shallow ref the deepening fallback is a
 * plain unshallowed fetch rather than a hard failure.
 */
export function repair(
  cwd = process.cwd(),
  options: { pin?: boolean } = {},
): { ok: boolean; log: string[]; error?: string } {
  const log: string[] = [];
  const submodule = join(cwd, VENDOR_DIR);

  if (!existsSync(join(submodule, ".git"))) {
    log.push(`Initialising ${VENDOR_DIR}…`);
    const init = git(["submodule", "update", "--init", "--depth", "1", VENDOR_DIR], cwd);
    if (!init.ok) {
      const full = git(["submodule", "update", "--init", VENDOR_DIR], cwd);
      if (!full.ok) {
        return { ok: false, log, error: `git submodule update --init failed: ${full.stderr}` };
      }
    }
  }

  const sparse = git(["sparse-checkout", "set", "--no-cone", ...SPARSE_PATTERNS], submodule);
  if (!sparse.ok) {
    return { ok: false, log, error: `git sparse-checkout failed: ${sparse.stderr}` };
  }

  const pinned = pinnedVersion(readJson(join(cwd, DESKTOP_MANIFEST)));
  if (options.pin && !pinned) {
    return { ok: false, log, error: describe({ ok: false, missing: [], problem: "no-pin" }) };
  }
  const vendored = vendoredVersion(readJson(join(cwd, VENDOR_MANIFEST)));
  if (options.pin && pinned && vendored !== pinned) {
    const tag = tagFor(pinned);
    log.push(`Pinning ${VENDOR_DIR} to ${tag}…`);
    const fetch = git(
      ["fetch", "--depth", "1", "origin", `refs/tags/${tag}:refs/tags/${tag}`],
      submodule,
    );
    if (!fetch.ok && !git(["rev-parse", "--verify", `refs/tags/${tag}`], submodule).ok) {
      const deep = git(["fetch", "--unshallow", "--tags", "origin"], submodule);
      if (!deep.ok) {
        return { ok: false, log, error: `could not fetch ${tag}: ${fetch.stderr || deep.stderr}` };
      }
    }
    const checkout = git(["checkout", "--detach", `refs/tags/${tag}`], submodule);
    if (!checkout.ok) {
      return { ok: false, log, error: `could not check out ${tag}: ${checkout.stderr}` };
    }
  }

  mkdirSync(dirname(join(cwd, STUB_PATH)), { recursive: true });
  writeFileSync(join(cwd, STUB_PATH), STUB_CONTENTS);
  return { ok: true, log };
}

/**
 * What the vendored tree and a locally projected devkit disagree about, if both are present.
 *
 * Informational, never a failure. Today it prints one file. A list that starts growing means the
 * "the devkit is a copy of these sources" assumption is weakening and the `paths` should probably
 * follow the devkit again — which is a judgement, not something a gate can make.
 */
export function devkitDrift(cwd = process.cwd()): string[] {
  const projection = readJson(join(cwd, DEVKIT_PROJECTION)) as
    | { product?: { version?: string } }
    | undefined;
  const devkitVersion = projection?.product?.version;
  if (!devkitVersion) {
    return [];
  }
  const notes: string[] = [];
  const vendored = vendoredVersion(readJson(join(cwd, VENDOR_MANIFEST)));
  if (devkitVersion !== vendored) {
    notes.push(`.hutch/devkit is at ${devkitVersion}; ${VENDOR_DIR} is at ${vendored}.`);
    return notes;
  }
  const api = join(cwd, "packages/desktop/.hutch/devkit/api");
  for (const relative of new Bun.Glob("**/*.ts").scanSync({
    cwd: join(cwd, SDK_SRC),
    onlyFiles: true,
  })) {
    // The devkit's `api/` has the same layout as the SDK's source tree, so a relative path maps
    // Across unchanged. Two things are skipped rather than reported: the stub, which is ours by
    // Construction, and any file the devkit does not carry — this checkout is sparse, so an absence
    // Is a difference in what we chose to keep, not a difference in the release.
    const mine = join(cwd, SDK_SRC, relative);
    const theirs = join(api, relative);
    if (relative.includes(".generated") || !existsSync(theirs)) {
      continue;
    }
    if (readFileSync(mine, "utf8") !== readFileSync(theirs, "utf8")) {
      notes.push(relative);
    }
  }
  return notes;
}

async function main(): Promise<void> {
  const fix = Bun.argv.includes("--fix");
  const init = fix || Bun.argv.includes("--init");
  const soft = Bun.argv.includes("--soft");
  const done = (code: number) => process.exit(soft ? 0 : code);

  if (init) {
    const repaired = repair(process.cwd(), { pin: fix });
    for (const line of repaired.log) {
      console.log(line);
    }
    if (!repaired.ok) {
      console.error(`Could not prepare ${VENDOR_DIR}:\n${repaired.error}`);
      done(1);
      return;
    }
  }

  const status = inspect();
  if (!status.ok) {
    console.error(describe(status));
    done(1);
    return;
  }

  console.log(describe(status));
  if (init && !soft) {
    const drift = devkitDrift();
    if (drift.length > 0) {
      console.log(
        `\n${drift.length} file(s) differ from the projected .hutch/devkit at the same version:`,
      );
      for (const line of drift) {
        console.log(`  ${line}`);
      }
      console.log(`This is upstream's release-versus-tag difference, not a failure.`);
    }
  }
  process.exit(0);
}

if (import.meta.main) {
  await main();
}
