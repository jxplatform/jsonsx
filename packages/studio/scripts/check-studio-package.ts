/**
 * What the package promises about itself, checked against the tree.
 *
 * Source-only: no build, no type-checker, about a second. It lives here rather than in the repo's
 * root `scripts/` so `scripts/ci/affected.ts` classifies it by its owning workspace instead of
 * failing open into the whole matrix.
 *
 * Four rules, each closing something that has gone wrong or that nothing else can see:
 *
 * 1. **The stylesheet list is the stylesheets.** `STUDIO_STYLESHEETS` must equal `styles/*.css` on
 *    disk. The document's link tags are generated from that list, so a sheet added to the directory
 *    and not to the list is never loaded — which is the 2.1.0 outage exactly, where the cloud
 *    editor shipped seven dead links and the build exited 0.
 * 2. **`files` covers what the package needs.** Every manifest path, every `PUBLISHED_EXTRAS` entry,
 *    and every relative import that escapes `src/`. `dist/codicon.ttf` was referenced by the
 *    shipped CSS and listed nowhere; `data/` is imported by six modules including `src/studio.ts`,
 *    so the package's own `.` export has never resolved from a tarball.
 * 3. **The layering rule.** `@jxsuite/studio` declares no backend package in any dependency field, and
 *    no module under `src/` imports one. `@jxsuite/server` is one PAL implementation's backend;
 *    depending on it would make the abstraction depend on an implementation, and would put
 *    compiler, create, import and starters into every studio install, the cloud's included.
 *    `scripts/check-dep-rules.ts` cannot catch this — it forbids only core-to-extension edges, and
 *    server and studio are both core, so the edge passes it silently.
 * 4. **The purity rule.** Only `src/hosting/stage.ts` may import `node:`. The other hosting modules
 *    are the contract, and a subscriber in a Worker, a Vite plugin or a Deno host must be able to
 *    read them.
 *
 * Run in the CI `checks` job. Every rule is a pure function over an injected listing, so
 * `tests/check-studio-package.test.ts` can drive them with fixtures under `bun test`, which never
 * builds.
 */

import { Glob } from "bun";
import { readFileSync } from "node:fs";
import { join, posix, resolve } from "node:path";
import { PUBLISHED_EXTRAS, STUDIO_ASSETS, STUDIO_STYLESHEETS } from "../src/hosting/layout";

const PKG_DIR = resolve(import.meta.dir, "..");

/** Packages that are a PAL implementation's backend rather than part of the abstraction. */
export const BACKEND_PACKAGES = ["@jxsuite/server", "@jxsuite/desktop"] as const;

export interface Problem {
  rule: string;
  detail: string;
}

/** @param onDisk POSIX `styles/*.css` paths found in the package. */
export function stylesheetDrift(onDisk: readonly string[]): Problem[] {
  const declared = new Set(STUDIO_STYLESHEETS);
  const found = new Set(onDisk);
  const problems: Problem[] = [];
  for (const path of onDisk) {
    if (!declared.has(path)) {
      problems.push({
        detail: `${path} exists but is not in STUDIO_STYLESHEETS, so no document links it`,
        rule: "stylesheets",
      });
    }
  }
  for (const path of STUDIO_STYLESHEETS) {
    if (!found.has(path)) {
      problems.push({
        detail: `STUDIO_STYLESHEETS names ${path}, which is not on disk`,
        rule: "stylesheets",
      });
    }
  }
  return problems;
}

/** Does an npm `files` pattern cover `path`? A directory entry covers everything beneath it. */
export function filesCovers(patterns: readonly string[], path: string): boolean {
  return patterns.some((pattern) => {
    const p = pattern.replace(/^\.?\//, "").replace(/\/$/, "");
    if (p === path || path.startsWith(`${p}/`)) {
      return true;
    }
    if (p.includes("*") && new Glob(p).match(path)) {
      return true;
    }
    /* A manifest DIRECTORY is covered when patterns reach inside it. `dist/chunks` ships as
       `dist/chunks/*.js` and `dist/chunks/*.css` rather than wholesale, deliberately: the directory
       also holds about 24 MB of source maps, and a `files` entry cannot subtract. */
    return p.startsWith(`${path}/`);
  });
}

/** Source with comments removed, so prose that quotes an import is not read as one. */
function code(source: string): string {
  return source.replaceAll(/\/\*[\s\S]*?\*\//g, "").replaceAll(/^[ \t]*\/\/.*$/gm, "");
}

/** Relative imports in `src/**` that escape `src/` — `../data/webdata.json` and its five siblings. */
export function escapingImports(sources: Record<string, string>): string[] {
  const out = new Set<string>();
  for (const [file, source] of Object.entries(sources)) {
    for (const m of code(source).matchAll(/from\s+"(\.\.[^"]*)"|import\s+"(\.\.[^"]*)"/g)) {
      const spec = m[1] ?? m[2]!;
      const resolved = posix.normalize(posix.join(posix.dirname(`src/${file}`), spec));
      if (!resolved.startsWith("src/") && !resolved.startsWith("..")) {
        out.add(resolved);
      }
    }
  }
  return [...out].toSorted();
}

export function publishGaps(patterns: readonly string[], escaping: readonly string[]): Problem[] {
  const needed = [...STUDIO_ASSETS.map((a) => a.path), ...PUBLISHED_EXTRAS, ...escaping];
  return needed
    .filter((path) => !filesCovers(patterns, path))
    .map((path) => ({
      detail: `${path} is needed but no "files" pattern covers it`,
      rule: "files",
    }));
}

export function backendDependencies(pkg: Record<string, unknown>): Problem[] {
  const problems: Problem[] = [];
  for (const field of ["dependencies", "peerDependencies", "optionalDependencies"]) {
    const deps = (pkg[field] ?? {}) as Record<string, string>;
    for (const name of BACKEND_PACKAGES) {
      if (name in deps) {
        problems.push({
          detail: `${field} names ${name} — a PAL implementation's backend. The abstraction must not depend on an implementation`,
          rule: "layering",
        });
      }
    }
  }
  return problems;
}

export function backendImports(sources: Record<string, string>): Problem[] {
  const problems: Problem[] = [];
  for (const [file, source] of Object.entries(sources)) {
    for (const name of BACKEND_PACKAGES) {
      if (new RegExp(String.raw`from\s+"${name}(?:/|")`).test(code(source))) {
        problems.push({ detail: `src/${file} imports ${name}`, rule: "layering" });
      }
    }
  }
  return problems;
}

/** The one module allowed to bind a runtime. Everything else under `src/` runs in a browser. */
export const NODE_IMPORT_ALLOWED = new Set(["hosting/stage.ts"]);

export function nodeImports(sources: Record<string, string>): Problem[] {
  const problems: Problem[] = [];
  for (const [file, source] of Object.entries(sources)) {
    if (NODE_IMPORT_ALLOWED.has(file)) {
      continue;
    }
    const stripped = source.replaceAll(/\/\*[\s\S]*?\*\//g, "").replaceAll(/^[ \t]*\/\/.*$/gm, "");
    if (/from\s+"node:/.test(stripped)) {
      problems.push({
        detail: `src/${file} imports node: — the hosting contract has to be readable from a Worker, a Vite plugin or a Deno host`,
        rule: "purity",
      });
    }
  }
  return problems;
}

function readSources(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rel of new Glob("**/*.ts").scanSync(dir)) {
    out[rel.replaceAll("\\", "/")] = readFileSync(join(dir, rel), "utf8");
  }
  return out;
}

export function analyze(root = PKG_DIR): Problem[] {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as Record<
    string,
    unknown
  >;
  const sources = readSources(join(root, "src"));
  const sheets = [...new Glob("styles/*.css").scanSync(root)]
    .map((f) => f.replaceAll("\\", "/"))
    .toSorted();
  return [
    ...stylesheetDrift(sheets),
    ...publishGaps((pkg.files ?? []) as string[], escapingImports(sources)),
    ...backendDependencies(pkg),
    ...backendImports(sources),
    ...nodeImports(sources),
  ];
}

/** The report, as lines. Pure, so the runner is one call and the test does not spy on a console. */
export function report(problems: readonly Problem[]): string[] {
  if (problems.length === 0) {
    return [
      `✓ check-studio-package: ${STUDIO_STYLESHEETS.length} stylesheet(s) declared and present, ` +
        `${STUDIO_ASSETS.length} manifest entr(ies) publishable, no backend dependency, ` +
        `node: confined to the stager.`,
    ];
  }
  return [
    "",
    "@jxsuite/studio does not keep its own promises:",
    "",
    ...problems
      .toSorted((a, b) => a.rule.localeCompare(b.rule))
      .map((p) => `  [${p.rule}] ${p.detail}`),
    "",
    "  See the header of scripts/check-studio-package.ts for what each rule is for.",
  ];
}

if (import.meta.main) {
  const problems = analyze();
  console.log(report(problems).join("\n"));
  process.exit(problems.length > 0 ? 1 : 0);
}
