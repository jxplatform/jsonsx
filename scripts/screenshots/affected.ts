/**
 * Decides which shots a pull request can actually change, and emits that decision as GitHub Actions
 * job outputs. Consumed by the `capture` job in .github/workflows/screenshots.yml.
 *
 * The lane costs a container boot plus ~3 minutes of browser for all 61 shots, and it pushes its
 * result onto your branch. So the cost of running it too eagerly is not just minutes — it is bytes
 * in a diff nobody opened the PR to review. The `paths:` filter decides WHETHER the lane runs; this
 * decides HOW MUCH of it runs once it has.
 *
 * The mapping is derived, not declared: a shot names the project it opens (`open.project`), so a
 * change confined to project roots can only move the pictures of shots that open them. Anything
 * touching Studio itself, the runner, or the lock's definition can move any picture, so it runs
 * everything. The one edge that is NOT derivable carries its reason and is asserted on startup —
 * see REGISTRY_SHOTS.
 *
 * Three properties matter more than any minute saved, and they are the same three
 * `scripts/ci/affected.ts` is built on:
 *
 * 1. The mapping is DERIVED from the manifest. Re-point a shot at another starter and this follows it;
 *    there is no second list to forget.
 * 2. Unknown paths FAIL OPEN. A changed file matching no rule runs every shot rather than quietly
 *    narrowing the run — a missed re-capture is a wrong picture shipped, which is the expensive
 *    direction to be wrong in.
 * 3. It says what it SKIPPED. A narrowed run that does not name what it left out reads exactly like a
 *    full one.
 *
 * To see what a working diff would select:
 *
 *     git diff --name-only origin/main... | bun scripts/screenshots/affected.ts --stdin
 */

import { resolve } from "node:path";

import { validateManifest } from "./lib/types.ts";
import type { Manifest, Shot } from "./lib/types.ts";

/**
 * A change to any of these can move any pixel, so every shot runs. The decider's own inputs are in
 * here on purpose: a PR that edits this file must not be graded by it.
 */
const GLOBAL = [
  "package.json",
  "bun.lock",
  "bunfig.toml",
  "tsconfig.json",
  "packages/studio/**",
  "scripts/screenshots/affected.ts",
  "scripts/screenshots/run.ts",
  "scripts/screenshots/lib/**",
  "scripts/screenshots/manifest.json",
  "scripts/check-image-lock.ts",
  "scripts/lib/png.ts",
  ".github/workflows/screenshots.yml",
];

/**
 * Shots whose picture depends on a file no `open.project` names. Each carries the reason, and the
 * names are asserted against the manifest on startup — so renaming the shot reds this script rather
 * than silently un-gating the picture.
 */
const REGISTRY_SHOTS = {
  path: "packages/starters/registry.json",
  shots: ["new-project"],
  why:
    "`new-project` photographs the new-project modal, whose gallery is `platform.listStarters()` " +
    "reading registry.json — so ALL twelve starters are in that one picture, whatever it opens.",
} as const;

export interface ShotDecision {
  /** `all` runs the whole manifest; `subset` runs `shots`; `none` skips the capture entirely. */
  mode: "all" | "subset" | "none";
  reason: string;
  /** Shot names to pass to `--only`. Empty when the mode is `all` or `none`. */
  shots: string[];
  /** Shots the run will NOT take, so the summary can name them. */
  skipped: string[];
}

function matches(path: string, pattern: string): boolean {
  if (pattern.endsWith("/**")) {
    return path.startsWith(pattern.slice(0, -2));
  }
  return path === pattern;
}

function isGlobal(path: string): boolean {
  return GLOBAL.some((p) => matches(path, p));
}

/** The project a shot opens, or null for the one shot that opens nothing (`welcome-screen`). */
function projectOf(shot: Shot): string | null {
  return shot.open?.project ?? null;
}

function quarantined(shot: Shot): boolean {
  return shot.status?.state === "quarantined";
}

export function decide(changed: string[], manifest: Manifest): ShotDecision {
  const runnable = manifest.shots.filter((s) => !quarantined(s));
  const all = runnable.map((s) => s.name);

  if (changed.length === 0) {
    return { mode: "all", reason: "no diff to narrow by", shots: [], skipped: [] };
  }

  // Classification is deliberately built from EVERY shot, quarantined ones included. Build it from
  // `runnable` and quarantining the last shot of a project makes that project's paths unclassifiable
  // — which fails open to all 61 shots for a diff that provably cannot change a picture.
  const projects = new Set<string>();
  for (const shot of manifest.shots) {
    const project = projectOf(shot);
    if (project) {
      projects.add(project);
    }
  }

  const selected = new Set<string>();
  const unclassified: string[] = [];

  for (const path of changed) {
    if (isGlobal(path)) {
      return {
        mode: "all",
        reason: `\`${path}\` can move any picture`,
        shots: [],
        skipped: [],
      };
    }

    if (path === REGISTRY_SHOTS.path) {
      for (const name of REGISTRY_SHOTS.shots) {
        selected.add(name);
      }
      continue;
    }

    // A project root the manifest names. Longest match wins, so that `first-collection` does not
    // Swallow `first-collection-state`.
    const [owner] = [...projects]
      .filter((p) => path === p || path.startsWith(`${p}/`))
      .toSorted((a, b) => b.length - a.length);
    if (owner) {
      for (const shot of runnable) {
        if (projectOf(shot) === owner) {
          selected.add(shot.name);
        }
      }
      continue;
    }

    unclassified.push(path);
  }

  if (unclassified.length > 0) {
    // FAIL OPEN. Listing the paths matters: this is the line that tells someone a new directory
    // Needs classifying, and without it the full run looks like a deliberate choice.
    return {
      mode: "all",
      reason: `unclassified path(s), so nothing is assumed: ${unclassified
        .slice(0, 5)
        .map((p) => `\`${p}\``)
        .join(", ")}${unclassified.length > 5 ? ` (+${unclassified.length - 5} more)` : ""}`,
      shots: [],
      skipped: [],
    };
  }

  const shots = all.filter((name) => selected.has(name));
  if (shots.length === 0) {
    // Reachable only when every shot the diff maps to is quarantined. An empty `--only` would mean
    // ALL shots to the runner, so this must be its own mode rather than an empty subset.
    return {
      mode: "none",
      reason: "every shot this diff could change is quarantined",
      shots: [],
      skipped: all,
    };
  }

  return {
    mode: "subset",
    reason: `${shots.length} of ${all.length} shots open the project roots this diff touches`,
    shots,
    skipped: all.filter((name) => !selected.has(name)),
  };
}

/** Fails loudly if a declared edge names a shot the manifest no longer has. */
export function assertAnchors(manifest: Manifest): void {
  const names = new Set(manifest.shots.map((s) => s.name));
  const missing = REGISTRY_SHOTS.shots.filter((n) => !names.has(n));
  if (missing.length > 0) {
    throw new Error(
      `screenshots/affected.ts: REGISTRY_SHOTS names ${missing
        .map((n) => `"${n}"`)
        .join(", ")}, which the manifest does not define. ${REGISTRY_SHOTS.why}`,
    );
  }
}

async function changedFiles(): Promise<string[]> {
  if (Bun.argv.includes("--stdin")) {
    const text = await Bun.stdin.text();
    return text
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
  }

  const baseRef = process.env.BASE_REF || "main";
  const base = `origin/${baseRef}`;
  const mergeBase = Bun.spawnSync(["git", "merge-base", base, "HEAD"]);
  if (mergeBase.exitCode !== 0) {
    console.error(`screenshots/affected.ts: no merge base with ${base}; capturing everything`);
    return [];
  }
  const diff = Bun.spawnSync([
    "git",
    "diff",
    "--name-only",
    mergeBase.stdout.toString().trim(),
    "HEAD",
  ]);
  if (diff.exitCode !== 0) {
    console.error("screenshots/affected.ts: git diff failed; capturing everything");
    return [];
  }
  return diff.stdout
    .toString()
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

async function main(): Promise<void> {
  const manifestPath = resolve(import.meta.dir, "manifest.json");
  const manifest = validateManifest(await Bun.file(manifestPath).json());
  assertAnchors(manifest);

  const event = process.env.GITHUB_EVENT_NAME ?? "";

  // The nightly and `workflow_dispatch` are never narrowed. The nightly exists to catch drift no
  // PR caused — a base-image rebuild, a font package — which by definition maps to no diff.
  const decision: ShotDecision =
    event && event !== "pull_request"
      ? { mode: "all", reason: `${event} is never narrowed`, shots: [], skipped: [] }
      : decide(await changedFiles(), manifest);

  const outputs: Record<string, string> = {
    mode: decision.mode,
    // Consumed as `bun run screenshots ${{ steps.scope.outputs.only }}` — empty for `all`.
    only: decision.mode === "subset" ? `--only ${decision.shots.join(",")}` : "",
    reason: decision.reason,
    shots: decision.shots.join(","),
  };

  const outFile = process.env.GITHUB_OUTPUT;
  if (outFile) {
    await Bun.write(
      outFile,
      `${
        ((await Bun.file(outFile).exists()) ? await Bun.file(outFile).text() : "") +
        Object.entries(outputs)
          .map(([k, v]) => `${k}=${v}`)
          .join("\n")
      }\n`,
    );
  } else {
    for (const [k, v] of Object.entries(outputs)) {
      console.log(`${k}=${v}`);
    }
  }

  // A narrowed run is only trustworthy if it says what it left out.
  const table = [
    `### Screenshot scope — \`${decision.mode}\``,
    "",
    decision.reason,
    "",
    decision.mode === "subset"
      ? [
          `**Capturing ${decision.shots.length}:** ${decision.shots.map((s) => `\`${s}\``).join(", ")}`,
          "",
          `**Not captured (${decision.skipped.length}):** ${decision.skipped
            .map((s) => `\`${s}\``)
            .join(", ")}`,
        ].join("\n")
      : decision.mode === "none"
        ? "Nothing to capture."
        : "Capturing every shot.",
  ].join("\n");

  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary) {
    await Bun.write(
      summary,
      `${((await Bun.file(summary).exists()) ? await Bun.file(summary).text() : "") + table}\n`,
    );
  } else {
    console.error(`\n${table}`);
  }
}

if (import.meta.main) {
  await main();
}
