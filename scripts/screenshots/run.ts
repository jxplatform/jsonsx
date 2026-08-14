/**
 * The screenshot runner.
 *
 * Reads `scripts/screenshots/manifest.json`, spawns the repo dev server (so the bundle in the
 * picture is the working tree's), materialises a writable overlay of every project a shot opens,
 * drives Jx Studio in headless Chromium through `window.__jxAutomation`, and writes PNGs to the
 * manifest's `outDir`.
 *
 * The contract the manifest is written in is documented in `scripts/screenshots/README.md` and
 * enforced statically, without a browser, by `scripts/check-shot-contract.ts`.
 *
 * ```bash
 * bun run screenshots                  # all shots
 * bun run screenshots --only hero      # one shot (repeatable / comma-separated)
 * bun run screenshots --headed         # visible browser, for tuning shot definitions
 * bun run screenshots --force          # re-baseline: overwrite every image
 * bun run screenshots --reuse-server   # photograph an already-running dev server (interactive only)
 * CHROMIUM_BIN=/path/to/chromium bun run screenshots
 * ```
 */

import { mkdir, readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { parseArgs } from "./lib/args";
import { launchBrowser, newShotContext } from "./lib/browser";
import { ensureDevServer, overlayProject } from "./lib/server";
import { executeShot } from "./lib/shot";
import { resolveShot, validateManifest } from "./lib/types";
import {
  captureOrigin,
  captureRuntime,
  describeImage,
  emptyLock,
  manifestImageNames,
  readLock,
  shotDefinitionHashes,
  writeLock,
} from "../check-image-lock";
import type { ShotContext } from "./lib/shot";
import type { CaptureLock } from "../check-image-lock";

const repoRoot = resolve(import.meta.dir, "../..");

const { force, headed, manifestPath, only, reuseServer } = parseArgs(
  process.argv.slice(2),
  resolve(import.meta.dir, "manifest.json"),
);
const manifest = validateManifest(await Bun.file(manifestPath).json());

const selected = manifest.shots.filter((shot) => only.size === 0 || only.has(shot.name));
if (selected.length === 0) {
  throw new Error(`no shots matched --only ${[...only].join(",")}`);
}
// A quarantined shot is one the repo ADMITS is broken (§13.5). Running it is a guaranteed failure
// That says nothing new, so it is skipped and NAMED — `docs:check` is what fails if a page still
// Illustrates itself with one, and Lane 1 re-checks its ids the moment the quarantine is lifted.
const shots = selected.filter((shot) => shot.status?.state !== "quarantined");
for (const shot of selected) {
  if (shot.status?.state === "quarantined") {
    console.log(`[shot:${shot.name}] SKIPPED — quarantined: ${shot.status.reason}`);
  }
}

const outDir = resolve(repoRoot, manifest.outDir);
await mkdir(outDir, { recursive: true });

const studioPath = manifest.server?.studioPath ?? "/packages/studio/index.html";
const server = await ensureDevServer({
  repoRoot,
  reuse: reuseServer,
  studioPath,
  url: manifest.server?.url ?? "http://127.0.0.1:3000",
});

/**
 * The capture lock, updated in place (§13.5).
 *
 * Read-modify-write rather than rebuild, because `--only hero` is a legitimate way to run this and
 * a lock that forgot the other sixty images would fail `docs:images:check` on every partial run.
 * Entries for images the manifest no longer produces are dropped first: deleting a shot has to
 * delete its lock entry, or the gate goes red naming a picture nobody asked for.
 */
const lockPath = relative(repoRoot, resolve(import.meta.dir, "capture.lock.json"));
const manifestRel = relative(repoRoot, manifestPath);
const lock: CaptureLock = readLock(lockPath) ?? emptyLock(manifestRel);
lock.manifest = manifestRel;
const definitions = shotDefinitionHashes(manifest);
const producible = manifestImageNames(manifest);
for (const path of Object.keys(lock.images)) {
  const name = path.slice(path.lastIndexOf("/") + 1).replace(/\.png$/, "");
  if (!producible.has(name)) {
    delete lock.images[path];
  }
}

let failed = 0;
const browser = await launchBrowser({ headed });
const runtime = captureRuntime(await browser.version());
const capturedBy = captureOrigin();
try {
  for (const shot of shots) {
    const resolved = resolveShot(manifest, shot);
    // No shot opens a committed project. The overlay is materialised once per project per run and
    // Reset after each shot, so a step that edits a starter page is undone by construction rather
    // Than by a cleanup pass the shot has to remember to carry.
    const overlay = resolved.open.project
      ? await overlayProject(repoRoot, resolved.open.project)
      : null;
    // A context per shot, not a page per shot: the HTTP cache is context-scoped, so sharing one
    // Made every shot's warmth a function of which shots preceded it.
    const { dispose, page } = await newShotContext(browser);
    try {
      const ctx: ShotContext = {
        force,
        log: console.log,
        outDir,
        repoRoot,
        serverUrl: server.url,
        studioPath,
        ...(overlay ? { projectRoot: overlay.root } : {}),
      };
      // The lock records the bytes that are ON DISK, read back after the shot: `writeIfChanged`
      // Legitimately keeps the committed PNG when the re-render is visually identical, and a lock
      // Built from the buffer the camera produced would then disagree with the file it names.
      for (const outPath of await executeShot(page, resolved, ctx)) {
        const key = relative(repoRoot, outPath).replaceAll("\\", "/");
        const bytes = new Uint8Array(await readFile(outPath));
        const entry = describeImage(bytes, {
          capturedBy,
          definition: definitions.get(shot.name) ?? "",
          runtime,
          shot: shot.name,
        });
        const previous = lock.images[key];
        // An unchanged picture keeps its ORIGINAL entry, `capturedAt` included. Re-stamping the
        // Timestamp on every run would make the lock churn in git on a run that moved no pixel —
        // The same reason `writeIfChanged` leaves the PNG alone.
        lock.images[key] =
          previous?.sha256 === entry.sha256 && previous.definition === entry.definition
            ? previous
            : entry;
      }
    } catch (error) {
      failed += 1;
      console.error(`[shot:${shot.name}] FAILED:`, error instanceof Error ? error.message : error);
    } finally {
      if (headed) {
        // Leave the last page open long enough to inspect when tuning interactively.
        await Bun.sleep(15_000);
      }
      await dispose();
      await overlay?.reset();
    }
  }
} finally {
  await browser.close();
  await server.dispose();
  // Written even after a failure: the shots that DID capture produced real bytes, and a lock that
  // Omitted them would report them as hand-taken on the next `docs:images:check`.
  await writeLock(lock, lockPath);
  console.log(`[lock] ${Object.keys(lock.images).length} image(s) → ${lockPath}`);
}

if (failed > 0) {
  console.error(`${failed}/${shots.length} shots failed`);
  process.exit(1);
}
console.log(`${shots.length} shot(s) captured to ${manifest.outDir}`);
