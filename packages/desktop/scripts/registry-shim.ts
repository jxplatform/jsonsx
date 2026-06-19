/*
 * Offline npm-registry shim for the Nix build.
 *
 * Bun re-resolves a workspace's *directly declared* dependencies against the
 * registry on every clean install — even with `--frozen-lockfile` / `--offline`
 * and a fully populated package cache (it reports a phantom "updated N
 * dependencies" for the workspace packages and refuses to trust the lockfile
 * for them). In the Nix sandbox there is no network, so those manifest fetches
 * fail with `ConnectionRefused` and the build dies.
 *
 * Rather than fight Bun's resolver, we give it exactly what it asks for: a tiny
 * HTTP registry, served on loopback during the build, that answers manifest
 * (packument) requests with data synthesized straight from `bun.lock` and
 * serves tarballs from a Nix-store tree of the already-fetched `.tgz` files.
 * Everything is derived from the lockfile, so there is no extra hash to
 * maintain and nothing that drifts when upstream publishes new versions.
 *
 *   bun registry-shim.ts <bun.lock> <tarballTreeDir> [port]
 *
 * The tarball tree mirrors npm registry paths: <name>/-/<basename>-<ver>.tgz.
 */

import { file, serve } from "bun";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const [lockPath, treeDir, portArg] = process.argv.slice(2);
if (!lockPath || !treeDir) {
  throw new Error("usage: bun registry-shim.ts <bun.lock> <tarballTreeDir> [port]");
}
const port = Number(portArg ?? 48_732);

interface Versioned {
  info: Record<string, unknown>;
  integrity: string | undefined;
}

// Reach Bun's built-in JSONC loader, as bun2nix's catalog resolver does
// (bun.lock has trailing commas, so plain JSON.parse would choke).
const lock = (
  (await import(pathToFileURL(resolve(lockPath)).href, {
    with: { type: "jsonc" },
  })) as { default: { packages?: Record<string, [string, ...unknown[]]> } }
).default;
const packages = lock.packages ?? {};

// Name -> { version -> {info, integrity} }, built from every `packages` entry
// (top-level and nested), so multi-version deps expose all their versions.
const byName: Record<string, Record<string, Versioned>> = {};
for (const entry of Object.values(packages)) {
  const spec = entry?.[0];
  if (typeof spec !== "string") {
    continue;
  }
  const at = spec.lastIndexOf("@");
  if (at <= 0) {
    continue;
  }
  const name = spec.slice(0, at);
  const version = spec.slice(at + 1);
  const info =
    entry[2] && typeof entry[2] === "object" ? (entry[2] as Record<string, unknown>) : {};
  const integrity = typeof entry[3] === "string" ? entry[3] : undefined;
  (byName[name] ??= {})[version] = { info, integrity };
}

const unscoped = (name: string): string =>
  name.includes("/") ? name.slice(name.indexOf("/") + 1) : name;
const tarballPath = (name: string, version: string): string =>
  `/${name}/-/${unscoped(name)}-${version}.tgz`;

// Crude but sufficient semver ordering for picking dist-tags.latest.
const cmpVersion = (a: string, b: string): number => {
  const pa = a.split(/[.+-]/).map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.split(/[.+-]/).map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) {
      return d;
    }
  }
  return 0;
};

function packument(name: string): unknown {
  const vers = byName[name];
  if (!vers) {
    return null;
  }
  const versions: Record<string, unknown> = {};
  for (const [v, { info, integrity }] of Object.entries(vers)) {
    versions[v] = {
      ...info,
      name,
      version: v,
      dist: { tarball: `http://localhost:${port}${tarballPath(name, v)}`, integrity },
    };
  }
  const latest = Object.keys(vers).toSorted(cmpVersion).at(-1);
  return { name, "dist-tags": { latest }, versions };
}

serve({
  port,
  fetch(req) {
    const { pathname } = new URL(req.url);
    const p = decodeURIComponent(pathname);
    if (/^\/.+\/-\/[^/]+\.tgz$/.test(p)) {
      const tarball = join(treeDir, p);
      if (existsSync(tarball)) {
        return new Response(file(tarball));
      }
      return new Response(`no tarball: ${p}`, { status: 404 });
    }
    const pm = packument(p.replace(/^\//, ""));
    if (pm) {
      return Response.json(pm);
    }
    return new Response(`not found: ${p}`, { status: 404 });
  },
});

console.error(`registry-shim listening on http://localhost:${port}`);
