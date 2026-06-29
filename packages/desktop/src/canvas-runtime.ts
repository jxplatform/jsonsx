/**
 * Canvas runtime gate (Phase 7). Decides whether the ELECTROBUN variant serves the canvas iframe
 * cross-origin from an in-process loopback createProjectServer (the new path) or keeps the views://
 * + data-URL shims (today's path).
 *
 * SAFETY INVARIANT: useLoopbackCanvas() DEFAULTS TO FALSE for commits 1-7. With the gate off,
 * electrobun stands up NO loopback server, sets NO platform canvasUrl, and the data-URL observer
 * keeps emitting data-URLs — byte-identical to today. Commit 9 flips the default to the runtime
 * probe result (after the user's electrobun CDP E2E).
 *
 * The probe + JX_CANVAS_HOST override are WIRED here now (so commit 9 is a one-line flip), but
 * useLoopbackCanvas() returns false unconditionally until then.
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

/**
 * One-shot self-loopback probe: bind a throwaway loopback server and fetch its own url. Succeeds on
 * an open host; fails on an AppContainer/firewall block (MSIX). Cached after the first call.
 */
let loopbackProbe: boolean | undefined;

export async function probeLoopback(): Promise<boolean> {
  if (loopbackProbe !== undefined) {
    return loopbackProbe;
  }
  let server: ReturnType<typeof Bun.serve> | undefined;
  try {
    server = Bun.serve({
      fetch: () => new Response("ok"),
      hostname: "127.0.0.1",
      port: 0,
    });
    const res = await fetch(`http://127.0.0.1:${server.port}/`);
    loopbackProbe = res.ok;
  } catch {
    loopbackProbe = false;
  } finally {
    void server?.stop(true);
  }
  return loopbackProbe;
}

/**
 * Whether the cross-origin loopback canvas is active for this run.
 *
 * COMMITS 1-7: DEFAULTS FALSE. JX_CANVAS_HOST=views is a hard off override (honored now). The probe
 * is wired but the result is NOT yet consulted — commit 9 changes the return to the probe result.
 */
export function useLoopbackCanvas(): boolean {
  if (process.env.JX_CANVAS_HOST === "views") {
    return false;
  }
  // Commit 9 flips this to `loopbackProbe ?? false`. Until then the gate is hard-off so nothing
  // Ships changed (see the SAFETY INVARIANT above).
  return false;
}

/** Reset the cached probe result. Test-only. */
export function _resetProbeCache(): void {
  loopbackProbe = undefined;
}
