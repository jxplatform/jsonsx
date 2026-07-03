import { $ } from "bun";
import { resolve } from "node:path";
import { stageStudioAssets } from "./stage-studio-assets";

const desktopDir = resolve(import.meta.dir, "..");

// ── 1. Build studio ────────────────────────────────────────────────────────

console.log("[prebuild-rpc] Building @jxsuite/studio…");
await $`bun run build`.cwd(resolve(desktopDir, "../studio"));

// ── 2. Build chromium init script ────────────────────────────────────────

console.log("[prebuild-rpc] Building chromium init script…");
await $`bun build ./src/chromium/init.ts --outdir ./assets/studio/dist --target browser --sourcemap=linked`.cwd(
  desktopDir,
);

// ── 3. Copy + patch assets (shared with the electrobun pre-build) ──────────

console.log("[prebuild-rpc] Staging studio assets…");
await stageStudioAssets(desktopDir);

console.log("[prebuild-rpc] Done.");
