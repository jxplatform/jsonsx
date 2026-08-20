/**
 * Electrobun preBuild hook: build the studio bundle and the desktop init script, then stage both
 * into assets/ for `build.copy` to place in the bundle.
 *
 * Runs under HUTCH's runtime (Cottontail), not Bun — Hutch executes project TypeScript and shell
 * tasks with Cottontail regardless of the app's own `build.mainProcess`. Cottontail ships a `bun`
 * module shim, but its `$` shell fails on the `.cwd()` form this script used to use, so the
 * subprocesses go through node:child_process instead. That is portable across both runtimes, which
 * is what a build hook wants; the sibling chromium hook (pre-build-rpc.ts) is invoked by `bun run`
 * directly and is free to keep using Bun's shell.
 */
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { stageStudioAssets } from "./stage-studio-assets";

const desktopDir = resolve(import.meta.dirname, "..");

/** Run a command to completion, failing the build (non-zero exit) the way the hook contract wants. */
function run(command: string, args: string[], cwd: string) {
  const result = spawnSync(command, args, { cwd, shell: true, stdio: "inherit" });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} exited with ${result.status ?? result.signal}`);
  }
}

// ── 1. Build studio ────────────────────────────────────────────────────────

console.log("[prebuild] Building @jxsuite/studio…");
run("bun", ["run", "build"], resolve(desktopDir, "../studio"));

// ── 2. Build desktop init script ───────────────────────────────────────────

console.log("[prebuild] Building desktop init script…");
run(
  "bun",
  [
    "build",
    "./src/init.ts",
    "--outdir",
    "./assets/studio/dist",
    "--target",
    "browser",
    "--sourcemap=linked",
  ],
  desktopDir,
);

// ── 3. Copy + patch assets (shared with the chromium pre-build) ────────────

console.log("[prebuild] Staging studio assets into packages/desktop/assets/…");
await stageStudioAssets(desktopDir);

console.log("[prebuild] Done.");
