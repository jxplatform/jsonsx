/**
 * Studio-asset directory resolution for the per-window loopback canvas server. Electrobun always
 * stands up an in-process loopback createProjectServer that serves the canvas iframe (canvas.html +
 * dist/iframe-entry.js) cross-origin; {@link studioDir} locates the staged studio assets it
 * serves.
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Resolve the directory holding the studio shell + canvas.html + dist/ for the loopback server's
 * studio-asset namespace. Honors JX_STUDIO_ASSETS, then the packaged electrobun layout
 * (Resources/app/views/studio, mirroring electrobun's own ../Resources/ resolve), then the dev
 * checkout layout (packages/desktop/assets/studio). Returns the first candidate that exists.
 */
export function studioDir(): string {
  // Dev checkout: this module lives in packages/desktop/src, assets stage to packages/desktop/assets.
  const devDir = resolve(import.meta.dir, "../assets/studio");
  const probed = [
    process.env.JX_STUDIO_ASSETS,
    // Packaged electrobun: bun runs with cwd under Resources/app, views land at app/views/studio.
    resolve("../Resources/app/views/studio"),
    resolve("views/studio"),
  ].filter(Boolean) as string[];
  for (const dir of probed) {
    if (existsSync(resolve(dir, "canvas.html"))) {
      return dir;
    }
  }
  // None of the probed candidates had canvas.html → fall back to the dev path (the assets stage there
  // In a checkout; under MSIX the packaged probe above wins, so this is the dev/test-time default).
  return devDir;
}
