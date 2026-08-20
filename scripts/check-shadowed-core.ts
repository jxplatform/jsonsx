/**
 * Check-shadowed-core.ts — no project root may ship its own copy of a first-party Jx package.
 *
 * Iterating a starter inside Studio means `bun install` inside that starter, and a starter's
 * `package.json` names PUBLISHED versions — it has to, because it is a template a user scaffolds
 * from. So the install materialises a real `@jxsuite/schema` (and friends) into
 * `<starter>/node_modules/`, beside a workspace that is several minor versions ahead. The starter
 * is then a project whose idea of the Jx document contract is whatever npm last published.
 *
 * That is not hypothetical: a 25 July install in `packages/starters/sites/shop` left
 * `@jxsuite/schema@0.35.0` next to a 1.5.0 workspace, and every regeneration of that starter's
 * entry documents from that machine composed them against the older core — dropping `Statement`,
 * `StatementList`, `PathsValue` and the three admission blocks, cutting `ClassMethodDef.role` from
 * 16 members to 6, and cutting `ChildrenValue.oneOf` from 3 to 2, which removed the
 * computed-children branch and made the starter's own `pages/products/[sku].json` invalid against
 * its own committed schema. It went unnoticed for six weeks because the artifact was only ever
 * regenerated on the one machine that had the shadow.
 *
 * **Why this lives here and not in the starter.** `@jxsuite/starters` publishes `sites/`, so every
 * starter's `package.json` is shipped to end users. A `preschema` or `postinstall` hook there would
 * run on THEIR machine, deleting the dependencies they had just installed. The monorepo is what has
 * a workspace to be shadowed, so the monorepo owns the cleanup.
 *
 * **Why only `@jxsuite/*` and not the whole directory.** The install is wanted — it is how a
 * starter previews. Third-party dependencies are inert with respect to the Jx contract and removing
 * them would break the very iteration loop that triggered the install. Only the first-party
 * packages can answer for the workspace, so only they are removed.
 *
 * A workspace SYMLINK is not a shadow — that is `examples/`, which is a workspace member and
 * therefore immune. Only a real directory counts.
 *
 * `packages/compiler`'s schema loader is independently hermetic (a first-party `*.json` schema
 * resolves from the host or throws), so schema composition is already safe. This exists for
 * everything else that resolves normally — `jx build`, `jx dev`, the runtime, the bundler — and to
 * keep the working tree honest.
 *
 * Usage: bun scripts/check-shadowed-core.ts # report and exit 1 if any shadow exists bun
 * scripts/check-shadowed-core.ts --fix # remove them, then exit 0
 */

import { existsSync, lstatSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..");

/** The npm scope whose packages define the Jx contract rather than a project's own content. */
export const FIRST_PARTY_SCOPE = "@jxsuite";

/**
 * Every directory the schema generator treats as a project root.
 *
 * Kept in step with `scripts/generate-schemas.ts` by hand, because both are lists of the same four
 * places and a shared helper would be a module for two callers that never disagree in practice.
 *
 * @param {string} parent - Repo-relative directory holding project roots
 * @returns {string[]}
 */
function projectRootsIn(parent: string): string[] {
  const dir = resolve(REPO_ROOT, parent);
  if (!existsSync(dir)) {
    return [];
  }
  return readdirSync(dir)
    .map((name) => join(dir, name))
    .filter((path) => existsSync(join(path, "project.json")))
    .toSorted();
}

/**
 * Project roots to inspect: the same set `schema:generate-all` walks.
 *
 * @returns {string[]}
 */
export function generatorRoots(): string[] {
  return [
    resolve(REPO_ROOT, "examples"),
    ...projectRootsIn("sites"),
    ...projectRootsIn("packages/starters/sites"),
    ...projectRootsIn("scripts/screenshots/fixtures"),
  ];
}

/** One first-party package entry under a project root that beats this workspace on resolution. */
export interface Shadow {
  /**
   * `shadow` — a real directory holding a published copy. `dangling` — a symlink whose target no
   * longer exists, usually because the package moved. The remedies differ, which is why they are
   * distinguished: a shadow is deleted, a dangling link means the install is stale.
   */
  kind: "shadow" | "dangling";
  /** Absolute path to the offending package directory or link. */
  path: string;
  /** `@jxsuite/schema` — the specifier it answers for. */
  specifier: string;
  /** The version it would answer with, when readable. `unresolvable` for a dangling link. */
  version: string;
  /** Absolute path to the project root that holds it. */
  root: string;
}

/**
 * Every first-party package installed as a real directory under `root/node_modules`.
 *
 * A symlink is skipped only when it RESOLVES: that is a workspace link pointing back into this
 * repo, which is the correct answer rather than a stale one. A symlink whose target is gone is not
 * correct — it is a stale answer that still beats the correct one on the resolution path, because a
 * nested `node_modules` entry wins over the root link that replaced it.
 *
 * @param {string} root - Absolute project root
 * @returns {Shadow[]}
 */
export function shadowsIn(root: string): Shadow[] {
  const scopeDir = join(root, "node_modules", FIRST_PARTY_SCOPE);
  if (!existsSync(scopeDir)) {
    return [];
  }
  const found: Shadow[] = [];
  for (const name of readdirSync(scopeDir).toSorted()) {
    const path = join(scopeDir, name);
    const specifier = `${FIRST_PARTY_SCOPE}/${name}`;
    if (lstatSync(path).isSymbolicLink()) {
      // `existsSync` follows the link, so this is exactly "does the target still exist".
      if (existsSync(path)) {
        continue;
      }
      found.push({ kind: "dangling", path, root, specifier, version: "unresolvable" });
      continue;
    }
    let version = "unknown";
    try {
      const manifest = readFileSync(join(path, "package.json"), "utf8");
      version = (JSON.parse(manifest) as { version?: string }).version ?? "unknown";
    } catch {
      // A half-written install still shadows; report it without a version rather than skipping it.
    }
    found.push({ kind: "shadow", path, root, specifier, version });
  }
  return found;
}

/**
 * Every shadow across every generator root.
 *
 * @param {string[]} roots
 * @returns {Shadow[]}
 */
export function findShadows(roots: readonly string[] = generatorRoots()): Shadow[] {
  return roots.flatMap((root) => shadowsIn(root));
}

/**
 * Remove a shadow, and the stray lockfile the same install dropped beside it.
 *
 * The lockfile goes too because leaving it means the next `bun install` in that root faithfully
 * reproduces the shadow that was just removed.
 *
 * @param {Shadow} shadow
 * @returns {void}
 */
export function removeShadow(shadow: Shadow): void {
  rmSync(shadow.path, { force: true, recursive: true });
  /*
   * A dangling link is not the residue of an install that shipped a published copy — it is an
   * install that has simply gone stale, so the lockfile is innocent and removing it would force a
   * needless reinstall. Deleting the link is the whole repair: resolution then falls through to
   * the root workspace link that superseded it.
   */
  if (shadow.kind === "shadow") {
    rmSync(join(shadow.root, "bun.lock"), { force: true });
    rmSync(join(shadow.root, "bun.lockb"), { force: true });
  }

  // Prune the scope directory once it is empty, then `node_modules` itself if that emptied it. An
  // Empty `@jxsuite/` shadows nothing — resolution walks past it — but leaving skeletons behind
  // Makes the next person wonder what is in them.
  for (const dir of [
    join(shadow.root, "node_modules", FIRST_PARTY_SCOPE),
    join(shadow.root, "node_modules"),
  ]) {
    if (existsSync(dir) && readdirSync(dir).length === 0) {
      rmSync(dir, { recursive: true });
    }
  }
}

if (import.meta.main) {
  const fix = process.argv.includes("--fix");
  const shadows = findShadows();

  if (shadows.length === 0) {
    console.log("shadowed-core OK: no project root ships its own copy of a first-party package.");
    process.exit(0);
  }

  const label = (shadow: Shadow) =>
    `  ${relative(REPO_ROOT, shadow.root)} → ${shadow.specifier}@${shadow.version}${
      shadow.kind === "dangling" ? " (dangling link)" : ""
    }`;

  if (fix) {
    for (const shadow of shadows) {
      removeShadow(shadow);
      console.log(`removed${label(shadow).slice(1)}`);
    }
    console.log(
      `shadowed-core: removed ${shadows.length} shadowing package(s). ` +
        `The install itself is fine — only the first-party copies are gone.`,
    );
    process.exit(0);
  }

  console.error(
    `\n❌ ${shadows.length} first-party package entr(ies) beat this workspace on resolution:\n`,
  );
  for (const shadow of shadows) {
    console.error(label(shadow));
  }
  if (shadows.some((s) => s.kind === "shadow")) {
    console.error(
      `\nAnything that resolves normally from those roots — jx build, jx dev, the runtime — will ` +
        `read the published copy instead of this repo's.`,
    );
  }
  if (shadows.some((s) => s.kind === "dangling")) {
    console.error(
      `\nA dangling link resolves to nothing at all, so the import fails outright — the package ` +
        `it points at moved, and that root's install predates the move.`,
    );
  }
  console.error(
    `\nRun \`bun scripts/check-shadowed-core.ts --fix\` to remove them (the rest of the install ` +
      `stays).`,
  );
  process.exit(1);
}
