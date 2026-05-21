import { $ } from "bun";
import { cp, mkdir } from "fs/promises";
import { join } from "path";

if (process.platform !== "win32") {
  console.log("[build-msix] Skipping MSIX build (not Windows)");
  process.exit(0);
}

await $`electrobun-builder build --target msix --update --baseUrl https://github.com/jxsuite/jx/releases/download/`;

const distDir = join(import.meta.dir, "..", "dist");
const artifactsDir = join(import.meta.dir, "..", "artifacts");
await mkdir(artifactsDir, { recursive: true });

const distFiles = new Bun.Glob("*.{msix,json}");
for await (const file of distFiles.scan(distDir)) {
  await cp(join(distDir, file), join(artifactsDir, file));
  console.log(`[build-msix] Copied ${file} → artifacts/`);
}
