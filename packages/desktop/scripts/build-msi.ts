import { $ } from "bun";

if (process.platform !== "win32") {
  console.log("[build-msi] Skipping MSI build (not Windows)");
  process.exit(0);
}

await $`electrobun-builder build --target wix --update --baseUrl https://github.com/jxsuite/jx/releases/download/`;
