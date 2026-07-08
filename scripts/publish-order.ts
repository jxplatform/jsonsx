// Emits, one per line to stdout, the package directories to publish for a
// Release run, in topological order (a dependency always precedes its
// Dependents). Consumed by .github/workflows/publish.yml.
//
// The publish set is *derived*, never hand-maintained:
//   * A package is npm-publishable when it is not `private` AND declares a
//     `publishConfig` (every @jxsuite npm package sets publishConfig.provenance;
//     `desktop`, which ships as installers and never to npm, is the only one
//     Without a publishConfig, so it drops out automatically).
//   * Only packages release-please actually released this run — passed as the
//     JSON array in $PATHS_RELEASED — are emitted.
//
// This replaces the previous hardcoded `order` array in publish.yml, whose
// Omissions silently dropped newly-added packages (protocol, collab) from the
// Publish even when release-please released them, leaving already-published
// Dependents (server, studio) pointing at versions that never reached npm.
//
// Usage: PATHS_RELEASED='["packages/server","packages/collab"]' bun scripts/publish-order.ts

import { readdirSync } from "node:fs";
import { join } from "node:path";

const PACKAGES_DIR = "packages";

interface Pkg {
  dir: string;
  name: string;
  publishable: boolean;
  deps: string[]; // @jxsuite/* runtime dependency package names (deduped)
}

const pkgs: Pkg[] = [];
for (const dir of readdirSync(PACKAGES_DIR)) {
  const file = Bun.file(join(PACKAGES_DIR, dir, "package.json"));
  if (!(await file.exists())) {
    continue;
  }
  const j = await file.json();
  const deps = new Set(
    [
      ...Object.keys(j.dependencies ?? {}),
      ...Object.keys(j.peerDependencies ?? {}),
      ...Object.keys(j.optionalDependencies ?? {}),
    ].filter((d) => d.startsWith("@jxsuite/")),
  );
  pkgs.push({
    dir,
    name: j.name,
    publishable: j.private !== true && j.publishConfig != null,
    deps: [...deps],
  });
}

const byName = new Map(pkgs.map((p) => [p.name, p]));
const publishable = pkgs.filter((p) => p.publishable);
const pubNames = new Set(publishable.map((p) => p.name));

// Kahn topological sort over the publishable graph. Edge dep -> dependent; a
// Package's in-degree is its count of publishable @jxsuite deps. Alphabetical
// Tie-break keeps the emitted order deterministic across runs.
const indeg = new Map<string, number>();
const dependents = new Map<string, string[]>();
for (const p of publishable) {
  indeg.set(p.dir, 0);
  dependents.set(p.dir, []);
}
for (const p of publishable) {
  const deps = p.deps.filter((d) => pubNames.has(d)).map((d) => byName.get(d)!.dir);
  indeg.set(p.dir, deps.length);
  for (const dep of deps) {
    dependents.get(dep)!.push(p.dir);
  }
}

let queue = publishable
  .map((p) => p.dir)
  .filter((d) => indeg.get(d) === 0)
  .toSorted();
const sorted: string[] = [];
while (queue.length > 0) {
  const dir = queue.shift()!;
  sorted.push(dir);
  const freed: string[] = [];
  for (const dep of dependents.get(dir)!) {
    const n = indeg.get(dep)! - 1;
    indeg.set(dep, n);
    if (n === 0) {
      freed.push(dep);
    }
  }
  queue = [...queue, ...freed].toSorted();
}

if (sorted.length !== publishable.length) {
  const cyclic = publishable.map((p) => p.dir).filter((d) => !sorted.includes(d));
  console.error(`Dependency cycle among publishable packages: ${cyclic.join(", ")}`);
  process.exit(1);
}

const releasedRaw = process.env.PATHS_RELEASED ?? "";
let releasedPaths: string[] = [];
if (releasedRaw.trim()) {
  try {
    releasedPaths = JSON.parse(releasedRaw);
  } catch {
    console.error(`PATHS_RELEASED is not valid JSON: ${releasedRaw}`);
    process.exit(1);
  }
}
const released = new Set(releasedPaths.map((p) => p.replace(/^packages\//, "")));

// Surface released paths we are NOT publishing, so a legitimate skip (desktop)
// Or a mistake (a released package that lost its publishConfig) is visible in
// The log rather than silently dropped — the exact failure mode this fixes.
for (const relDir of released) {
  const p = pkgs.find((x) => x.dir === relDir);
  if (!p) {
    console.error(`released path 'packages/${relDir}' has no package.json — not publishing`);
  } else if (!p.publishable) {
    console.error(`skipping ${p.name} — not an npm package (private or no publishConfig)`);
  }
}

for (const d of sorted.filter((dir) => released.has(dir))) {
  console.log(d);
}
