/**
 * Declarative Studio screenshot runner.
 *
 * Reads scripts/screenshots/manifest.json, boots (or reuses) the repo dev server, drives Jx Studio
 * in headless Chromium through the gated window.__jxAutomation hook, and writes PNGs to the
 * manifest outDir (sites/jxsuite.com/public/screenshots/ by default).
 *
 * Usage: bun run screenshots # all shots bun run screenshots --only hero # one shot (repeatable /
 * comma-separated) bun run screenshots --headed # visible browser, for tuning shot definitions
 * CHROMIUM_BIN=/path/to/chromium bun run screenshots
 */

import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { launchBrowser } from "./lib/browser";
import { ensureDevServer } from "./lib/server";
import { executeShot } from "./lib/shot";
import { resolveShot, validateManifest } from "./lib/types";

const repoRoot = resolve(import.meta.dir, "../..");

function parseArgs(argv: string[]) {
  const only = new Set<string>();
  let headed = false;
  let manifestPath = resolve(import.meta.dir, "manifest.json");
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "--only") {
      i += 1;
      const value = argv[i];
      if (!value) {
        throw new Error("--only requires a shot name");
      }
      for (const name of value.split(",")) {
        only.add(name.trim());
      }
    } else if (arg === "--headed") {
      headed = true;
    } else if (arg === "--manifest") {
      i += 1;
      const value = argv[i];
      if (!value) {
        throw new Error("--manifest requires a path");
      }
      manifestPath = resolve(process.cwd(), value);
    } else {
      throw new Error(`unknown argument "${arg}" (expected --only, --headed, --manifest)`);
    }
  }
  return { headed, manifestPath, only };
}

const { headed, manifestPath, only } = parseArgs(process.argv.slice(2));
const manifest = validateManifest(await Bun.file(manifestPath).json());

const shots = manifest.shots.filter((shot) => only.size === 0 || only.has(shot.name));
if (shots.length === 0) {
  throw new Error(`no shots matched --only ${[...only].join(",")}`);
}

const outDir = resolve(repoRoot, manifest.outDir);
await mkdir(outDir, { recursive: true });

const server = await ensureDevServer({
  repoRoot,
  studioPath: manifest.server.studioPath,
  url: manifest.server.url,
});

let failed = 0;
const browser = await launchBrowser({ headed });
try {
  for (const shot of shots) {
    const resolved = resolveShot(manifest, shot);
    const page = await browser.newPage();
    try {
      const written = await executeShot(page, resolved, {
        log: console.log,
        outDir,
        repoRoot,
        serverUrl: server.url,
        studioPath: manifest.server.studioPath,
      });
      for (const file of written) {
        console.log(`[shot:${shot.name}] wrote ${file}`);
      }
    } catch (error) {
      failed += 1;
      console.error(`[shot:${shot.name}] FAILED:`, error instanceof Error ? error.message : error);
    } finally {
      if (headed) {
        // Leave the last page open long enough to inspect when tuning interactively.
        await Bun.sleep(15_000);
      }
      await page.close();
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
