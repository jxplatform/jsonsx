import { $ } from "bun";
import { resolve } from "node:path";
import { stageStudioAssets } from "./stage-studio-assets";

const desktopDir = resolve(import.meta.dir, "..");

// ── 1. Build studio ────────────────────────────────────────────────────────

console.log("[prebuild] Building @jxsuite/studio…");
await $`bun run build`.cwd(resolve(desktopDir, "../studio"));

// ── 2. Build desktop init script ───────────────────────────────────────────

console.log("[prebuild] Building desktop init script…");
await $`bun build ./src/init.ts --outdir ./assets/studio/dist --target browser --sourcemap=linked`.cwd(
  desktopDir,
);

// ── 3. Copy + patch assets (shared with the chromium pre-build) ────────────

console.log("[prebuild] Staging studio assets into packages/desktop/assets/…");
await stageStudioAssets(desktopDir);

console.log("[prebuild] Done.");
