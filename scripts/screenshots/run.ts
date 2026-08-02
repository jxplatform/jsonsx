/**
 * Declarative Studio screenshot runner.
 *
 * Reads scripts/screenshots/manifest.json, spawns the repo dev server (so the bundle in the picture
 * is the working tree's), drives Jx Studio in headless Chromium through the gated
 * window.__jxAutomation hook, and writes PNGs to the manifest outDir.
 *
 * Usage: bun run screenshots # all shots bun run screenshots --only hero # one shot (repeatable /
 * comma-separated) bun run screenshots --headed # visible browser, for tuning shot definitions bun
 * run screenshots --reuse-server # photograph an already-running dev server (interactive only)
 * CHROMIUM_BIN=/path/to/chromium bun run screenshots
 */

import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseArgs } from "./lib/args";
import { launchBrowser, newShotContext } from "./lib/browser";
import { ensureDevServer } from "./lib/server";
import { executeShot } from "./lib/shot";
import { resolveShot, validateManifest } from "./lib/types";

const repoRoot = resolve(import.meta.dir, "../..");

const { force, headed, manifestPath, only, reuseServer } = parseArgs(
  process.argv.slice(2),
  resolve(import.meta.dir, "manifest.json"),
);
const manifest = validateManifest(await Bun.file(manifestPath).json());

const shots = manifest.shots.filter((shot) => only.size === 0 || only.has(shot.name));
if (shots.length === 0) {
  throw new Error(`no shots matched --only ${[...only].join(",")}`);
}

const outDir = resolve(repoRoot, manifest.outDir);
await mkdir(outDir, { recursive: true });

const server = await ensureDevServer({
  repoRoot,
  reuse: reuseServer,
  studioPath: manifest.server.studioPath,
  url: manifest.server.url,
});

let failed = 0;
const browser = await launchBrowser({ headed });
try {
  for (const shot of shots) {
    const resolved = resolveShot(manifest, shot);
    // A context per shot, not a page per shot: the HTTP cache is context-scoped, so sharing one
    // Made every shot's warmth a function of which shots preceded it.
    const { dispose, page } = await newShotContext(browser);
    try {
      await executeShot(page, resolved, {
        force,
        log: console.log,
        outDir,
        repoRoot,
        serverUrl: server.url,
        studioPath: manifest.server.studioPath,
      });
    } catch (error) {
      failed += 1;
      console.error(`[shot:${shot.name}] FAILED:`, error instanceof Error ? error.message : error);
    } finally {
      if (headed) {
        // Leave the last page open long enough to inspect when tuning interactively.
        await Bun.sleep(15_000);
      }
      await dispose();
    }
  }
} finally {
  await browser.close();
  await server.dispose();
}

if (failed > 0) {
  console.error(`${failed}/${shots.length} shots failed`);
  process.exit(1);
}
console.log(
  `${shots.length} shot(s) captured to ${dirname(outDir)}/${manifest.outDir.split("/").pop()}`,
);
