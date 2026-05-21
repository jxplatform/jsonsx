import { $ } from "bun";
import { cp, mkdir } from "fs/promises";
import { join } from "path";

if (process.platform !== "win32") {
  console.log("[build-msi] Skipping MSI build (not Windows)");
  process.exit(0);
}

await $`electrobun-builder build --target wix --update --baseUrl https://github.com/jxsuite/jx/releases/download/`;

const distDir = join(import.meta.dir, "..", "dist");
const artifactsDir = join(import.meta.dir, "..", "artifacts");
await mkdir(artifactsDir, { recursive: true });

const distFiles = new Bun.Glob("*.{msi,json}");
for await (const file of distFiles.scan(distDir)) {
  await cp(join(distDir, file), join(artifactsDir, file));
  console.log(`[build-msi] Copied ${file} → artifacts/`);
}
