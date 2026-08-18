/**
 * Check-workspace-links.ts — no workspace may resolve a dependency to a version its own manifest
 * rules out.
 *
 * The sibling of {@link ../scripts/check-shadowed-core.ts}. That one guards PROJECT roots against a
 * stale first-party copy; this one guards WORKSPACE roots (`packages/*`, `extensions/*`) against a
 * stale copy of anything, because the two hazards have different causes and only overlap by
 * accident.
 *
 * **Where the stale copies come from.** Bun's `isolated` linker builds a content-addressed store at
 * `node_modules/.bun/<pkg>@<version>/` and points a symlink at it from every workspace that depends
 * on the package. This repo switched to `linker = "hoisted"` (bunfig.toml, and see
 * oven-sh/bun#23615 for why), and a hoisted install writes real directories into the ROOT
 * `node_modules/` — reaching into a workspace's own `node_modules/` only when a genuine version
 * conflict cannot be hoisted.
 *
 * So a symlink left over from an isolated install is not something a later install rewrites. It is
 * not in the install's plan at all, so nothing removes it, and Node resolution walks UP from the
 * importing file — which means the leftover answers first and the correct root copy is never
 * reached. That is silent: the build succeeds, against the wrong code.
 *
 * It cost real time to find. `packages/schema` resolved `@webref/css` to 8.5.8 against a declared
 * `^8.7.1`, so `bun run schema:generate` dropped every CSS property added since — and
 * `schema:verify` failed locally with a diff nobody had authored, on a machine where every other
 * check was green. `packages/studio` was resolving `@atlaskit/pragmatic-drag-and-drop` 1.8.1
 * against `^3.0.0`: two majors, under the drag-and-drop tests.
 *
 * **What may be deleted, and what may not.** A nested copy is legitimate exactly when it exists to
 * satisfy a conflict the root cannot: `packages/import` declares `puppeteer-core: ^24.9.0` while
 * the root holds 25.7.0, so its own 24.x copy is the only correct answer and must survive. The rule
 * that separates them is the manifest, not the file type:
 *
 * - **Stale** — the nested version does not satisfy the range this workspace declares.
 * - **Legitimate** — it does satisfy it (whether or not the root also would).
 *
 * A leftover with no declared range is judged by where it points instead: a symlink into the
 * isolated store, under a hoisted linker, belongs to an install layout this repo no longer
 * produces.
 *
 * Removing one is a single `rm` of the entry, not of the tree: resolution then falls through to the
 * root copy, and no reinstall is needed.
 *
 * Usage: bun scripts/check-workspace-links.ts # report and exit 1 if any stale link exists bun
 * scripts/check-workspace-links.ts --fix # remove them, then exit 0
 */

import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, rmSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..");

/** Directories holding workspace members, relative to the repo root. */
export const WORKSPACE_PARENTS = ["packages", "extensions"];

/** Bun's isolated-linker store, relative to a repo root. */
const ISOLATED_STORE = join("node_modules", ".bun");

/** One dependency a workspace resolves to a version its own manifest rules out. */
export interface StaleLink {
  /** Absolute path to the offending entry under the workspace's `node_modules`. */
  path: string;
  /** `@webref/css` — the specifier it answers for. */
  specifier: string;
  /** The version it answers with, or `"unknown"` when the manifest will not parse. */
  version: string;
  /** The range the workspace declares, or `null` when it declares none (a transitive leftover). */
  declared: string | null;
  /** The version the root would answer with, or `null` when the root has no copy. */
  root: string | null;
  /** Why this entry is stale, for the report. */
  reason: "unsatisfied" | "dead-store-link";
  /** Absolute path to the workspace that holds it. */
  workspace: string;
}

/**
 * Every workspace directory that has a `node_modules` of its own.
 *
 * @param {string} [repoRoot] - Absolute repo root; defaults to this script's
 * @returns {string[]} Absolute paths, sorted
 */
export function workspacesWithLinks(repoRoot: string = REPO_ROOT): string[] {
  const found: string[] = [];
  for (const parent of WORKSPACE_PARENTS) {
    const dir = resolve(repoRoot, parent);
    if (!existsSync(dir)) {
      continue;
    }
    for (const name of readdirSync(dir)) {
      const workspace = join(dir, name);
      if (
        existsSync(join(workspace, "package.json")) &&
        existsSync(join(workspace, "node_modules"))
      ) {
        found.push(workspace);
      }
    }
  }
  return found.toSorted();
}

/** The `version` field of a package manifest, or `"unknown"` when it will not parse. */
function versionAt(dir: string): string {
  try {
    const manifest = readFileSync(join(dir, "package.json"), "utf8");
    return (JSON.parse(manifest) as { version?: string }).version ?? "unknown";
  } catch {
    return "unknown";
  }
}

/** Every dependency range a workspace declares, across both dependency blocks. */
function declaredRanges(workspace: string): Record<string, string> {
  const ranges: Record<string, string> = {};
  try {
    const manifest = JSON.parse(readFileSync(join(workspace, "package.json"), "utf8")) as Record<
      string,
      Record<string, string> | undefined
    >;
    for (const block of ["dependencies", "devDependencies"]) {
      Object.assign(ranges, manifest[block] ?? {});
    }
  } catch {
    // An unreadable manifest declares nothing, which leaves every entry to the dead-link rule.
  }
  return ranges;
}

/** Every `<name>` and `<@scope>/<name>` entry directly under a `node_modules`. */
function entriesIn(nodeModules: string): string[] {
  const found: string[] = [];
  for (const name of readdirSync(nodeModules).toSorted()) {
    if (name === ".bin" || name === ".cache") {
      continue;
    }
    if (!name.startsWith("@")) {
      found.push(name);
      continue;
    }
    const scopeDir = join(nodeModules, name);
    if (!lstatSync(scopeDir).isDirectory()) {
      continue;
    }
    found.push(
      ...readdirSync(scopeDir)
        .toSorted()
        .map((inner) => `${name}/${inner}`),
    );
  }
  return found;
}

/**
 * Every stale link in one workspace.
 *
 * A `workspace:` range is skipped outright — that link points back into this repo, so it is the
 * correct answer by construction and its version is whatever the sibling currently declares.
 *
 * @param {string} workspace - Absolute path to a workspace member
 * @param {string} [repoRoot] - Absolute repo root; defaults to this script's
 * @returns {StaleLink[]}
 */
export function staleLinksIn(workspace: string, repoRoot: string = REPO_ROOT): StaleLink[] {
  const nodeModules = join(workspace, "node_modules");
  if (!existsSync(nodeModules)) {
    return [];
  }
  const ranges = declaredRanges(workspace);
  const found: StaleLink[] = [];

  for (const specifier of entriesIn(nodeModules)) {
    const path = join(nodeModules, ...specifier.split("/"));
    const declared = ranges[specifier] ?? null;
    if (declared?.startsWith("workspace:")) {
      continue;
    }
    const version = versionAt(path);
    const rootPath = join(repoRoot, "node_modules", ...specifier.split("/"));
    const root = existsSync(rootPath) ? versionAt(rootPath) : null;

    /*
     * The manifest decides. A nested copy that satisfies the declared range is the answer this
     * workspace asked for — `packages/import` pinning puppeteer-core to a major the root has moved
     * past is the case this must not delete.
     */
    if (declared !== null) {
      if (version === "unknown" || Bun.semver.satisfies(version, declared)) {
        continue;
      }
      found.push({ declared, path, reason: "unsatisfied", root, specifier, version, workspace });
      continue;
    }

    // No declared range: judge it by the layout it belongs to instead.
    if (isDeadStoreLink(path, repoRoot)) {
      found.push({
        declared,
        path,
        reason: "dead-store-link",
        root,
        specifier,
        version,
        workspace,
      });
    }
  }
  return found;
}

/**
 * True when `path` is a symlink into the isolated-linker store while the repo links hoisted.
 *
 * Gated on the configured linker so that switching back makes this rule stop firing, rather than
 * deleting the layout the switch just asked for.
 *
 * @param {string} path - Absolute path to a `node_modules` entry
 * @param {string} repoRoot - Absolute repo root
 * @returns {boolean}
 */
export function isDeadStoreLink(path: string, repoRoot: string): boolean {
  if (!linksHoisted(repoRoot)) {
    return false;
  }
  try {
    if (!lstatSync(path).isSymbolicLink()) {
      return false;
    }
    const target = resolve(join(path, ".."), readlinkSync(path));
    return target.startsWith(join(repoRoot, ISOLATED_STORE));
  } catch {
    return false;
  }
}

/** Whether `bunfig.toml` selects the hoisted linker. */
function linksHoisted(repoRoot: string): boolean {
  try {
    const bunfig = readFileSync(join(repoRoot, "bunfig.toml"), "utf8");
    return /^\s*linker\s*=\s*"hoisted"/m.test(bunfig);
  } catch {
    return false;
  }
}

/**
 * Every stale link across every workspace.
 *
 * @param {string[]} workspaces - Absolute workspace paths
 * @param {string} [repoRoot] - Absolute repo root; defaults to this script's
 * @returns {StaleLink[]}
 */
export function findStaleLinks(workspaces: string[], repoRoot: string = REPO_ROOT): StaleLink[] {
  return workspaces.flatMap((workspace) => staleLinksIn(workspace, repoRoot));
}

/**
 * Remove one stale entry, and the scope directory it leaves empty.
 *
 * The entry only, never the tree: a workspace's `node_modules` may also hold copies that are the
 * correct answer, and resolution falls through to the root the moment this one is gone.
 *
 * @param {StaleLink} link
 * @returns {void}
 */
export function removeStaleLink(link: StaleLink): void {
  rmSync(link.path, { force: true, recursive: true });
  const [scope] = link.specifier.split("/");
  if (!link.specifier.startsWith("@") || scope === undefined) {
    return;
  }
  const scopeDir = join(link.workspace, "node_modules", scope);
  try {
    if (readdirSync(scopeDir).length === 0) {
      rmSync(scopeDir, { recursive: true });
    }
  } catch {
    // Already gone, or not a directory. Either way there is nothing left to tidy.
  }
}

/** One report line: what answered, what was asked for, and what will answer instead. */
function describe(link: StaleLink): string {
  const asked = link.declared === null ? "not declared here" : `declared ${link.declared}`;
  const instead = link.root === null ? "nothing at the root" : `root ${link.root}`;
  return `  ${relative(REPO_ROOT, link.path)}\n      resolves ${link.version} — ${asked}; falls through to ${instead}`;
}

if (import.meta.main) {
  const fix = process.argv.includes("--fix");
  const stale = findStaleLinks(workspacesWithLinks());

  if (stale.length === 0) {
    console.log("workspace links: every workspace resolves its dependencies as its manifest says.");
    process.exit(0);
  }

  if (fix) {
    for (const link of stale) {
      removeStaleLink(link);
    }
    const names = [...new Set(stale.map((link) => link.specifier))];
    const shown = `${names.slice(0, 4).join(", ")}${names.length > 4 ? ", …" : ""}`;
    console.log(
      `workspace links: removed ${stale.length} stale entr${stale.length === 1 ? "y" : "ies"} ` +
        `(${shown}). Resolution now falls through to the root; no reinstall needed.`,
    );
    process.exit(0);
  }

  const lines = stale.map((link) => describe(link)).join("\n");
  console.error(
    `workspace links: ${stale.length} stale entr${stale.length === 1 ? "y" : "ies"} ` +
      `${stale.length === 1 ? "shadows" : "shadow"} the root install, so this tree builds against ` +
      `code its manifests rule out:\n${lines}\n\n` +
      "Run `bun run links:clean` to remove them.",
  );
  process.exit(1);
}
