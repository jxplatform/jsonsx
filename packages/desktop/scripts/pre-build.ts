import { $ } from "bun";
import { join, resolve } from "node:path";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";

const desktopDir = resolve(import.meta.dir, "..");
const studioDir = resolve(desktopDir, "../studio");
const assetsDir = join(desktopDir, "assets");

// ── 1. Build studio ────────────────────────────────────────────────────────

console.log("[prebuild] Building @jxsuite/studio…");
await $`bun run build`.cwd(studioDir);

// ── 2. Build desktop init script ───────────────────────────────────────────

console.log("[prebuild] Building desktop init script…");
await $`bun build ./src/init.ts --outdir ./assets/studio/dist --target browser --sourcemap=linked`.cwd(
  desktopDir,
);

// ── 3. Copy + patch assets ─────────────────────────────────────────────────

console.log("[prebuild] Staging studio assets into packages/desktop/assets/…");
await mkdir(join(assetsDir, "studio", "dist"), { recursive: true });

await copyFile(
  join(studioDir, "dist", "studio.css"),
  join(assetsDir, "studio", "dist", "studio.css"),
);
await copyFile(
  join(studioDir, "dist", "studio.js"),
  join(assetsDir, "studio", "dist", "studio.js"),
);

const html = await readFile(join(studioDir, "index.html"), "utf8");
const patched = html.replace(
  '<script type="module" src="./dist/studio.js"></script>',
  '<script type="module" src="./dist/init.js"></script>\n  <script type="module" src="./dist/studio.js"></script>',
);
await writeFile(join(assetsDir, "studio", "index.html"), patched, "utf8");

console.log("[prebuild] Done.");
