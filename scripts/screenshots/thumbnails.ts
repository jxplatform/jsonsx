/**
 * Regenerate starter-site preview images from real rendered homepages.
 *
 * For each starter the New Project picker offers, this builds the site (image optimization OFF —
 * Sharp is unavailable on some hosts, and raw images render fine), serves dist/ as a root, and
 * screenshots the hero viewport in headless Chromium. From that one capture it writes two things,
 * replacing the earlier thematic stock-photo crops with the template's actual page:
 *
 * 1. A small JPEG data URI into packages/starters/registry.json's `thumbnail` — the New Project picker
 *    renders that string directly (no extra asset plumbing), and
 * 2. A full-res JPEG into sites/jxsuite.com/public/starters/<id>.jpg — the /templates showcase page
 *    (and the site's srcset/webp pipeline) consume it.
 *
 * Usage: bun scripts/screenshots/thumbnails.ts # all starters
 *
 *     bun scripts/screenshots/thumbnails.ts saas,blog  # a subset
 *     CHROMIUM_BIN=/path/to/chrome bun scripts/screenshots/thumbnails.ts
 */

import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import type { Page } from "puppeteer-core";
import { buildSite } from "@jxsuite/compiler/site";
import { launchBrowser } from "./lib/browser";

const repoRoot = resolve(import.meta.dir, "../..");
const sitesDir = join(repoRoot, "packages/starters/sites");
const registryPath = join(repoRoot, "packages/starters/registry.json");
const showcaseDir = join(repoRoot, "sites/jxsuite.com/public/starters");

/** Hero viewport captured (16:10, 2×), the picker data-URI thumbnail, the showcase file, quality. */
const CAPTURE = { deviceScaleFactor: 2, height: 800, width: 1280 };
const THUMB = { height: 400, quality: 0.72, width: 640 };
const SHOWCASE = { height: 800, quality: 0.82, width: 1280 };
const COPY_SKIP = new Set(["node_modules", "dist", ".cache", ".jx-cache", ".git"]);

interface StarterEntry {
  id: string;
  thumbnail: string;
  [k: string]: unknown;
}

/** Copy a starter to a temp dir, force image optimization off, and build it. Returns the dist dir. */
async function buildToTemp(slug: string): Promise<{ dist: string; tmp: string }> {
  const src = join(sitesDir, slug);
  const tmp = join(tmpdir(), `jx-thumb-${slug}-${process.pid}`);
  await rm(tmp, { force: true, recursive: true });
  await cp(src, tmp, {
    filter: (p) => {
      const rel = relative(src, p);
      return rel === "" || !rel.split(sep).some((s) => COPY_SKIP.has(s));
    },
    recursive: true,
  });
  const cfgPath = join(tmp, "project.json");
  const cfg = JSON.parse(await readFile(cfgPath, "utf8")) as Record<string, unknown>;
  cfg.images = { ...(cfg.images as object), optimize: false };
  await writeFile(cfgPath, `${JSON.stringify(cfg, null, 2)}\n`);

  const result = await buildSite(tmp, { clean: true });
  if (result.errors.length > 0) {
    throw new Error(`build failed for "${slug}": ${result.errors[0]}`);
  }
  return { dist: join(tmp, "dist"), tmp };
}

/** Serve a directory as an origin root (so the page's absolute /images/… links resolve). */
function serveDir(dir: string) {
  return Bun.serve({
    async fetch(req) {
      let path = decodeURIComponent(new URL(req.url).pathname);
      if (path.endsWith("/")) {
        path += "index.html";
      }
      let file = Bun.file(join(dir, path));
      if (!(await file.exists())) {
        file = Bun.file(join(dir, path, "index.html"));
      }
      return (await file.exists())
        ? new Response(file)
        : new Response("Not Found", { status: 404 });
    },
    port: 0,
  });
}

/**
 * Decode a PNG (base64) in the browser, downscale it to w×h on a canvas, and return the re-encoded
 * JPEG as bare base64 (no `data:` prefix). No native image deps — Sharp is unavailable on some
 * hosts.
 */
async function downscaleJpeg(
  page: Page,
  srcB64: string,
  w: number,
  h: number,
  q: number,
): Promise<string> {
  return page.evaluate(
    async (b64, tw, th, quality) => {
      const img = new Image();
      await new Promise<void>((res, rej) => {
        img.addEventListener("load", () => res());
        img.addEventListener("error", () => rej(new Error("decode failed")));
        img.src = `data:image/png;base64,${b64}`;
      });
      const canvas = document.createElement("canvas");
      canvas.width = tw;
      canvas.height = th;
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        throw new Error("no 2d context");
      }
      ctx.drawImage(img, 0, 0, tw, th);
      return canvas.toDataURL("image/jpeg", quality).split(",")[1] ?? "";
    },
    srcB64,
    w,
    h,
    q,
  );
}

async function main(): Promise<void> {
  const registry = JSON.parse(await readFile(registryPath, "utf8")) as StarterEntry[];
  const only = new Set(
    (process.argv[2] ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
  const targets = registry.filter((r) => only.size === 0 || only.has(r.id));
  if (targets.length === 0) {
    throw new Error(`no starters matched "${process.argv[2]}"`);
  }
  await mkdir(showcaseDir, { recursive: true });

  const browser = await launchBrowser();
  let failed = 0;
  try {
    for (const entry of targets) {
      let tmp: string | null = null;
      try {
        const { dist, tmp: builtTmp } = await buildToTemp(entry.id);
        tmp = builtTmp;
        const server = serveDir(dist);
        const page = await browser.newPage();
        try {
          await page.setViewport(CAPTURE);
          await page.goto(`http://localhost:${server.port}/`, {
            timeout: 60_000,
            waitUntil: "networkidle2",
          });
          await page.evaluate(() => document.fonts.ready);
          await Bun.sleep(300);
          const srcB64 = Buffer.from(
            await page.screenshot({
              clip: { height: CAPTURE.height, width: CAPTURE.width, x: 0, y: 0 },
            }),
          ).toString("base64");

          // Full-res showcase file for sites/jxsuite.com/templates.
          const showcaseB64 = await downscaleJpeg(
            page,
            srcB64,
            SHOWCASE.width,
            SHOWCASE.height,
            SHOWCASE.quality,
          );
          await writeFile(join(showcaseDir, `${entry.id}.jpg`), Buffer.from(showcaseB64, "base64"));

          // Small data-URI thumbnail for the New Project picker.
          const thumbB64 = await downscaleJpeg(
            page,
            srcB64,
            THUMB.width,
            THUMB.height,
            THUMB.quality,
          );
          entry.thumbnail = `data:image/jpeg;base64,${thumbB64}`;

          const kb = (b64: string) => Math.round((b64.length * 3) / 4 / 1024);
          console.log(`✓ ${entry.id} (thumb ${kb(thumbB64)}KB · showcase ${kb(showcaseB64)}KB)`);
        } finally {
          await page.close();
          server.stop(true);
        }
      } catch (error) {
        failed += 1;
        console.error(`✗ ${entry.id}: ${error instanceof Error ? error.message : error}`);
      } finally {
        if (tmp) {
          await rm(tmp, { force: true, recursive: true });
        }
      }
    }
  } finally {
    await browser.close();
  }

  await writeFile(registryPath, `${JSON.stringify(registry, null, 2)}\n`);
  console.log(
    `\nUpdated ${targets.length - failed}/${targets.length} starter(s): registry thumbnails + showcase images.`,
  );
  if (failed > 0) {
    process.exit(1);
  }
}

await main();
