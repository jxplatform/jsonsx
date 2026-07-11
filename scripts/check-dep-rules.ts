// Enforces the extension dependency rule from specs/extensions.md §2:
//
//   * `packages/*` are CORE, `extensions/*` are EXTENSIONS, `examples` and
//     `sites/*` are leaf apps (exempt consumers, like user projects).
//   * Extensions may depend on core packages and on each other.
//   * Core packages may NEVER list an extension package in `dependencies`,
//     `peerDependencies`, or `optionalDependencies` — and may never import
//     One from `src/`. The source scan matters because Bun hoists workspace
//     Packages to the root `node_modules`, so an undeclared import would
//     Still resolve at runtime and pass tests silently.
//   * `devDependencies` are permitted (test fixtures only); the publish
//     Graph uses runtime deps.
//
// Bundling carve-outs are explicit and carry a rationale (ALLOWLIST below).
// Run in the CI `checks` job: `bun scripts/check-dep-rules.ts`.

import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

// Dir → rationale. Keep this list short and honest: every entry weakens the
// Rule, so it must say why the exception is architecturally sound.
const ALLOWLIST: Record<string, string> = {
  "packages/desktop":
    "Bundling carve-out: an offline app shipping a complete environment as installers; " +
    "never published to npm. Extensions ship inside the app bundle by design.",
};

interface Pkg {
  dir: string; // Repo-relative, e.g. "packages/compiler"
  name: string;
  runtimeDeps: string[];
}

async function readTree(root: string): Promise<Pkg[]> {
  if (!existsSync(root)) {
    return [];
  }
  const pkgs: Pkg[] = [];
  for (const entry of readdirSync(root)) {
    const file = Bun.file(join(root, entry, "package.json"));
    if (!(await file.exists())) {
      continue;
    }
    const j = await file.json();
    pkgs.push({
      dir: `${root}/${entry}`,
      name: j.name,
      runtimeDeps: [
        ...Object.keys(j.dependencies ?? {}),
        ...Object.keys(j.peerDependencies ?? {}),
        ...Object.keys(j.optionalDependencies ?? {}),
      ],
    });
  }
  return pkgs;
}

function* walkSources(dir: string): Generator<string> {
  if (!existsSync(dir)) {
    return;
  }
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      yield* walkSources(path);
    } else if (/\.(ts|tsx|js|mjs)$/.test(entry)) {
      yield path;
    }
  }
}

const core = await readTree("packages");
const extensions = await readTree("extensions");
const extensionNames = new Set(extensions.map((p) => p.name));

const violations: string[] = [];

for (const pkg of core) {
  const allowReason = ALLOWLIST[pkg.dir];

  const badDeps = pkg.runtimeDeps.filter((d) => extensionNames.has(d));
  if (badDeps.length > 0 && !allowReason) {
    violations.push(
      `${pkg.dir}: core package declares extension runtime dep(s): ${badDeps.join(", ")}`,
    );
  }

  if (allowReason) {
    continue;
  }
  const srcDir = join(pkg.dir, "src");
  for (const file of walkSources(srcDir)) {
    const text = await Bun.file(file).text();
    for (const extName of extensionNames) {
      // Catches static imports, re-exports, and dynamic import()/require()
      // Specifiers only — quoted MENTIONS (error-message guidance, doc
      // Examples, degradation fallback literals) are not dependencies.
      const specifier = new RegExp(
        `(from\\s+|import\\s*\\(\\s*|require\\s*\\(\\s*)["'\`]${extName}(/[^"'\`]*)?["'\`]`,
      );
      if (specifier.test(text)) {
        violations.push(`${file}: core source imports extension package "${extName}"`);
      }
    }
  }
}

if (violations.length > 0) {
  console.error("Extension dependency rule violations (specs/extensions.md §2):\n");
  for (const v of violations) {
    console.error(`  ✗ ${v}`);
  }
  console.error(
    "\nCore packages may not depend on extensions. Invert the dependency " +
      "(registry/capability dispatch), move shared code into core, or — for " +
      "app-level bundling only — add an allowlist entry with a rationale.",
  );
  process.exit(1);
}

const allowed = Object.keys(ALLOWLIST).filter((dir) => core.some((p) => p.dir === dir));
console.log(
  `dep-rules OK: ${core.length} core, ${extensions.length} extension package(s); ` +
    `${allowed.length} allowlisted carve-out(s)${allowed.length > 0 ? ` (${allowed.join(", ")})` : ""}.`,
);
