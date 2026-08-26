/**
 * Bun-driven package operations, parameterized by a project root. Shared by the desktop app
 * (`createPackageOps`) and the dev server's `/__studio/packages*` endpoints so both backends behave
 * identically. Every function is pure with respect to its `root` argument and spawns `bun` in that
 * directory.
 */

import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

export interface PackageInfo {
  name: string;
  version: string;
  /** True when the dependency lives in `devDependencies` rather than `dependencies`. */
  dev?: boolean;
}

/**
 * A dependency's pinned range beside the newest version published for it on the registry.
 *
 * Every registry-range dependency gets a row, behind or not. Deciding whether a row is an upgrade
 * needs a semver comparison against the range's base, and the caller — which has to make that
 * comparison anyway to tell an upgrade from a project deliberately pinned ahead — is where it
 * belongs. A backend that filtered here could only describe an up-to-date package as an absence.
 */
export interface PackageVersionInfo {
  name: string;
  /** The version range pinned in package.json (e.g. "^0.19.0"). */
  current: string;
  /** The newest version published for this package on the registry. */
  latest: string;
  dev?: boolean;
}

/** Result of a package mutation that runs `bun install` (install / set-versions). */
export interface PackageOpResult {
  ok: boolean;
  /** Combined stdout/stderr from the bun invocation, surfaced to the user on failure. */
  log?: string;
}

interface PackageJson {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  [key: string]: unknown;
}

/** Minimal fetch signature (injectable for tests; the global `fetch` satisfies it). */
type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** Strip a semver range prefix to its base version: "^0.19.0" → "0.19.0". */
export function stripRange(range: string): string {
  const base = range.replace(/^[\^~>=<v\s]+/, "").trim();
  return base.split(/\s+/)[0] ?? "";
}

/**
 * Whether a version spec points at the npm registry (a plain semver range). Skips workspace:,
 * file:, link:, npm:, git, and URL specs, plus wildcards like "*" or "latest".
 */
export function isRegistryRange(spec: string): boolean {
  if (spec.includes(":")) {
    return false;
  }
  return /^\d/.test(stripRange(spec));
}

async function readPackageJson(root: string): Promise<PackageJson | null> {
  const pkgPath = resolve(root, "package.json");
  if (!existsSync(pkgPath)) {
    return null;
  }
  try {
    return JSON.parse(await readFile(pkgPath, "utf8")) as PackageJson;
  } catch {
    return null;
  }
}

/** List the project's dependencies and devDependencies (devDeps tagged with `dev: true`). */
export async function listPackages(root: string): Promise<PackageInfo[]> {
  const pkg = await readPackageJson(root);
  if (!pkg) {
    return [];
  }
  const out: PackageInfo[] = [];
  for (const [name, version] of Object.entries(pkg.dependencies ?? {})) {
    out.push({ name, version });
  }
  for (const [name, version] of Object.entries(pkg.devDependencies ?? {})) {
    out.push({ dev: true, name, version });
  }
  return out;
}

/** Whether the project has a package.json but no installed node_modules. */
export function dependenciesNeedInstall(root: string): boolean {
  if (!existsSync(resolve(root, "package.json"))) {
    return false;
  }
  return !existsSync(resolve(root, "node_modules"));
}

/**
 * Path to the bun executable. Uses the bun running the current process (`process.execPath`) so a
 * packaged desktop app spawns the bun bundled with its Electrobun distribution rather than relying
 * on a system-wide `bun` in `$PATH` (which end users may not have). Falls back to a PATH lookup if
 * `execPath` is somehow unset.
 */
export function bunExecutable(): string {
  return process.execPath || "bun";
}

async function runBun(args: string[], cwd: string): Promise<PackageOpResult> {
  const proc = Bun.spawn([bunExecutable(), ...args], { cwd, stderr: "pipe", stdout: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  const log = `${stdout}${stderr}`.trim();
  return { ok: exitCode === 0, ...(log ? { log } : {}) };
}

/** Run `bun install` in the project root. */
export async function installDependencies(root: string): Promise<PackageOpResult> {
  return runBun(["install"], root);
}

/** Run `bun add` (with `-d` for a dev dependency). */
export async function addPackage(
  root: string,
  name: string,
  dev = false,
): Promise<PackageOpResult> {
  return runBun(dev ? ["add", "-d", name] : ["add", name], root);
}

/** Run `bun remove`. */
export async function removePackage(root: string, name: string): Promise<PackageOpResult> {
  return runBun(["remove", name], root);
}

/**
 * Fetch the newest published version for a package from the npm registry, or null on any failure.
 *
 * **`application/json`, not the abbreviated `install-v1` format.** That format is defined for the
 * PACKUMENT endpoint (`/<name>`), and asking for it on the version endpoint (`/<name>/latest`)
 * returns an EMPTY BODY for most packages — verified against `@jxsuite/schema`, `@jxsuite/parser`
 * and `lit`, while `wrangler` happens to answer normally. An empty body fails `res.json()`, the
 * catch below turns that into `null`, and a null reads as "nothing newer" — so this silently
 * under-reported outdated dependencies for everything it was asked about, and looked like a quiet
 * registry rather than a broken request. The injected-fetch tests could not see it: they return a
 * body regardless of the header.
 */
export async function fetchLatestVersion(
  name: string,
  fetchImpl: FetchLike = fetch,
): Promise<string | null> {
  try {
    const res = await fetchImpl(`https://registry.npmjs.org/${name}/latest`, {
      headers: { accept: "application/json" },
    });
    if (!res.ok) {
      return null;
    }
    const data = (await res.json()) as { version?: string };
    return data.version ?? null;
  } catch {
    return null;
  }
}

/**
 * The newest published version of every dependency, asked of the registry package by package.
 *
 * Lookups run concurrently; non-registry specs (workspace:, file:, …) and lookup failures are
 * skipped, because there is no honest answer for either and a guess is worse than a blank.
 *
 * This used to be `outdatedPackages`, which dropped any package whose latest matched its pinned
 * base. Two assumptions were folded into that filter and both have since gone: that the only caller
 * wanted a to-do list, and that `latest !== base` is the same question as "is there an upgrade" (it
 * is not — a project pinned ahead of the registry, on a prerelease or a range bumped before the
 * publish landed, differs from latest in the other direction). Reporting the registry's answer for
 * every package leaves both judgements to the caller and lets the Packages table show a Latest
 * column for rows that are already current.
 */
export async function packageVersions(
  root: string,
  fetchImpl: FetchLike = fetch,
): Promise<PackageVersionInfo[]> {
  const pkgs = await listPackages(root);
  const checks = await Promise.all(
    pkgs.map(async (p): Promise<PackageVersionInfo | null> => {
      if (!isRegistryRange(p.version)) {
        return null;
      }
      const latest = await fetchLatestVersion(p.name, fetchImpl);
      if (!latest) {
        return null;
      }
      const entry: PackageVersionInfo = { current: p.version, latest, name: p.name };
      if (p.dev) {
        entry.dev = true;
      }
      return entry;
    }),
  );
  return checks.filter((entry): entry is PackageVersionInfo => entry !== null);
}

/**
 * Rewrite the version range of each named package in whichever section it already occupies
 * (preserving dependencies/devDependencies placement; new names default to the caller's `dev`
 * flag), then run a single `bun install`.
 */
export async function setPackageVersions(
  root: string,
  updates: { name: string; version: string; dev?: boolean }[],
): Promise<PackageOpResult> {
  if (updates.length === 0) {
    return { ok: true };
  }
  const pkgPath = resolve(root, "package.json");
  if (!existsSync(pkgPath)) {
    return { log: "No package.json in project root", ok: false };
  }
  let pkg: PackageJson;
  try {
    pkg = JSON.parse(await readFile(pkgPath, "utf8")) as PackageJson;
  } catch (error) {
    return { log: `Unparseable package.json: ${String(error)}`, ok: false };
  }
  for (const update of updates) {
    if (pkg.devDependencies && update.name in pkg.devDependencies) {
      pkg.devDependencies[update.name] = update.version;
    } else if (pkg.dependencies && update.name in pkg.dependencies) {
      pkg.dependencies[update.name] = update.version;
    } else {
      const bucket = update.dev ? "devDependencies" : "dependencies";
      pkg[bucket] = { ...(pkg[bucket] as Record<string, string> | undefined) };
      (pkg[bucket] as Record<string, string>)[update.name] = update.version;
    }
  }
  await writeFile(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, "utf8");
  return installDependencies(root);
}
