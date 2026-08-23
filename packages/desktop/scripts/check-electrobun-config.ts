#!/usr/bin/env bun
/**
 * Prove `electrobun.config.ts` is a config the electrobun CLI can actually load, and that
 * everything it names exists — without building anything.
 *
 * WHY THIS EXISTS, precisely. The CLI is a compiled single-file Bun binary that loads this repo's
 * config at runtime through its own resolver. That resolver is NARROWER than the one `bun test`
 * uses: `node:` builtins and relative paths resolve, bare specifiers do not. So
 *
 *     import { STUDIO_ASSETS } from "@jxsuite/studio/hosting/layout";
 *
 * Imported fine everywhere in this repo — including in `tests/electrobun-config.test.ts`, which
 * loads the config directly and stayed green — and failed inside the CLI with "Cannot find module".
 * Measured on electrobun 1.18.1, on linux-x64 and win-x64 alike; a relative import of the same file
 * loads.
 *
 * And the CLI FAILS OPEN. It prints `Failed to load config file: … / using default config instead`
 * and keeps going, so the build dies much later on the DEFAULT config's entrypoint — `failed to
 * bundle src/bun/index.ts because it doesn't exist` — naming a path this package has never
 * declared. Two log lines apart, and only the second one looks like an error. Every desktop build
 * was broken for the whole window, on all three platforms, and the first thing to notice was a
 * release.
 *
 * So the rules below are split by what they defend:
 *
 * RESOLVABLE — the value imports are ones the CLI's resolver can follow. This is the rule that
 * broke. It is checked STATICALLY, on the import statements, because the only faithful dynamic
 * check is the CLI itself and that means a 50 MB download and a real build on every pull request.
 * DECLARED — the entrypoint, hook scripts and icons the config names are on disk. These are the
 * things whose absence produced the confusing message, and they are cheap. DERIVED — the studio
 * copy rows still cover the manifest. A config can load perfectly and still derive an EMPTY copy
 * list (`Object.fromEntries([])` throws nothing), which would ship an app with no studio in it and
 * no error anywhere.
 *
 * SCOPE: this rule is about `electrobun.config.ts` and nothing else. The `preBuild`/`postBuild`
 * hooks are SPAWNED as ordinary bun processes, so `scripts/stage-studio-assets.ts` and
 * `scripts/verify-bundle.ts` import `@jxsuite/studio/hosting` by package name and should keep doing
 * so — that is the exports map being used as intended. Only the config is loaded inside the CLI's
 * own resolver.
 *
 * Runs in `checks`: no build, no network, no electrobun download.
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { STUDIO_ASSETS } from "../../studio/src/hosting/layout";

export const DESKTOP_DIR = resolve(import.meta.dir, "..");

/** The entrypoint the CLI falls back to. Named so a failure can say "this is the fallback". */
export const DEFAULT_CONFIG_ENTRYPOINT = "src/bun/index.ts";

/** A copy source the config lists that pre-build writes, so it is absent in a clean checkout. */
const PREBUILD_OUTPUT = "assets/";

export interface ConfigShape {
  readonly build: {
    readonly bun: { readonly entrypoint: string };
    readonly copy: Readonly<Record<string, string>>;
    readonly linux?: { readonly icon?: string | undefined } | undefined;
    readonly win?: { readonly icon?: string | undefined } | undefined;
  };
  readonly scripts: {
    readonly preBuild?: string | undefined;
    readonly postBuild?: string | undefined;
  };
}

export interface Inputs {
  /** The config module's default export. */
  readonly config: ConfigShape;
  /** `electrobun.config.ts`, as text — the import rule reads statements, not values. */
  readonly source: string;
  /** Injected so the rules are testable without a fixture tree. */
  readonly exists: (packageRelativePath: string) => boolean;
}

/**
 * A value import's specifier, in source order. Type-only imports are ERASED before the CLI ever
 * resolves anything, so `import type { ElectrobunConfig } from "electrobun"` is legal and must stay
 * legal — it is the config's own type and there is no relative path to it.
 */
export function valueImportSpecifiers(source: string): readonly string[] {
  const found: string[] = [];
  const statement = /^import\s+(?<clause>[^;]*?)\s*from\s*["'](?<from>[^"']+)["']/gmu;
  for (const match of source.matchAll(statement)) {
    const clause = match.groups?.clause ?? "";
    const from = match.groups?.from;
    if (from === undefined || /^type\b/u.test(clause)) {
      continue;
    }
    found.push(from);
  }
  return found;
}

/** What the CLI's resolver can follow from a config file. */
export function isResolvableByCli(specifier: string): boolean {
  return specifier.startsWith("node:") || specifier.startsWith(".");
}

export interface Failure {
  readonly rule: "resolvable" | "declared" | "derived";
  readonly message: string;
}

/** Every rule, over injected inputs. Empty means the config is sound. */
export function report(inputs: Inputs): readonly Failure[] {
  const { config, exists, source } = inputs;
  const failures: Failure[] = [];

  for (const specifier of valueImportSpecifiers(source)) {
    if (!isResolvableByCli(specifier)) {
      failures.push({
        message:
          `electrobun.config.ts imports "${specifier}", a bare specifier. The electrobun CLI ` +
          `resolves only node: builtins and relative paths from a config file, and it FAILS OPEN — ` +
          `it will fall back to a default config whose entrypoint is ${DEFAULT_CONFIG_ENTRYPOINT}, ` +
          `and the build will die there instead of here. Import it relatively.`,
        rule: "resolvable",
      });
    }
  }

  const declared: readonly (readonly [string, string | undefined])[] = [
    ["build.bun.entrypoint", config.build.bun.entrypoint],
    ["scripts.preBuild", config.scripts.preBuild],
    ["scripts.postBuild", config.scripts.postBuild],
    ["build.linux.icon", config.build.linux?.icon],
    ["build.win.icon", config.build.win?.icon],
  ];
  for (const [field, value] of declared) {
    if (value !== undefined && !exists(value)) {
      failures.push({
        message: `${field} names ${value}, which is not on disk.`,
        rule: "declared",
      });
    }
  }

  if (config.build.bun.entrypoint === DEFAULT_CONFIG_ENTRYPOINT) {
    failures.push({
      message:
        `build.bun.entrypoint is ${DEFAULT_CONFIG_ENTRYPOINT}, which is the electrobun DEFAULT — ` +
        `the value a failed config load leaves behind. If that is genuinely wanted, rename the file.`,
      rule: "declared",
    });
  }

  const copySources = new Set(Object.keys(config.build.copy));
  const missing = STUDIO_ASSETS.filter(
    (asset) => !copySources.has(`assets/studio/${asset.path}`),
  ).map((asset) => asset.path);
  if (missing.length > 0) {
    failures.push({
      message:
        `build.copy is missing ${missing.length} studio manifest entr${missing.length === 1 ? "y" : "ies"}: ` +
        `${missing.join(", ")}. The copy rows are derived from STUDIO_ASSETS; a partial or empty ` +
        `derivation packages an app with no studio in it and reports nothing.`,
      rule: "derived",
    });
  }

  for (const src of copySources) {
    if (!src.startsWith(PREBUILD_OUTPUT) && !exists(src)) {
      failures.push({
        message: `build.copy source ${src} is not a prebuild output and is not on disk.`,
        rule: "declared",
      });
    }
  }

  return failures;
}

export function summary(failures: readonly Failure[], copyRows: number): string {
  return failures.length === 0
    ? `✓ check-electrobun-config: imports are CLI-resolvable, every declared path exists, ` +
        `${copyRows} copy row(s) cover ${STUDIO_ASSETS.length} manifest entr(ies).`
    : failures.map((f) => `[${f.rule}] ${f.message}`).join("\n");
}

/** Read the real config off disk and judge it. Returns the number of failures. */
export async function main(log: (line: string) => void = console.log): Promise<number> {
  const [{ default: config }, source] = await Promise.all([
    import("../electrobun.config") as Promise<{ default: ConfigShape }>,
    Bun.file(resolve(DESKTOP_DIR, "electrobun.config.ts")).text(),
  ]);
  const failures = report({
    config,
    exists: (path) => existsSync(resolve(DESKTOP_DIR, path)),
    source,
  });
  log(summary(failures, Object.keys(config.build.copy).length));
  return failures.length;
}

if (import.meta.main) {
  process.exit((await main()) > 0 ? 1 : 0);
}
