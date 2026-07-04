/*
 * Authoring-time helper: download each starter site's photos from the Pexels API and record
 * attribution. Photos are pinned by id in the site's images.json so re-runs fetch the *same*
 * images (search results drift over time). Committed output is plain image files — scaffolded user
 * projects have no Pexels/network dependency.
 *
 * Usage:  PEXELS_API_KEY=… bun packages/starters/scripts/fetch-photos.ts <site-id> [--force]
 *
 * The key is read from the environment and never committed. `--force` re-picks even pinned images.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

const SITES_DIR = join(import.meta.dirname, "..", "sites");
const CREDITS_PATH = join(import.meta.dirname, "..", "CREDITS.md");
const REGISTRY_PATH = join(import.meta.dirname, "..", "registry.json");
const PEXELS_API = "https://api.pexels.com/v1";

export interface ImageSpec {
  role: string;
  query: string;
  orientation?: "landscape" | "portrait" | "square";
  photoId?: number;
}

export interface ImagesManifest {
  site: string;
  thumbnail?: string;
  images: ImageSpec[];
}

export interface PexelsPhoto {
  id: number;
  photographer: string;
  photographer_url: string;
  url: string;
  alt?: string;
  avg_color?: string;
  src: { original: string; large2x: string; large: string };
}

/** Pexels "square" isn't a real orientation — map it to landscape for the search, crop on download. */
export function searchOrientation(o: ImageSpec["orientation"]): "landscape" | "portrait" {
  return o === "portrait" ? "portrait" : "landscape";
}

/** Build the Pexels search URL for a spec. */
export function buildSearchUrl(spec: ImageSpec, perPage = 15): string {
  const params = new URLSearchParams({
    orientation: searchOrientation(spec.orientation),
    per_page: String(perPage),
    query: spec.query,
  });
  return `${PEXELS_API}/search?${params}`;
}

/**
 * Derive a sized, cropped download URL from a photo's original src. Pexels honours `w`/`h`/`fit`
 * query params, so we resize server-side rather than depending on a local Sharp binary.
 */
export function sizedUrl(
  photo: PexelsPhoto,
  orientation: ImageSpec["orientation"],
  opts?: { w?: number; h?: number },
): string {
  const base = photo.src.original;
  const params = new URLSearchParams({ auto: "compress", cs: "tinysrgb" });
  if (opts?.w && opts.h) {
    params.set("w", String(opts.w));
    params.set("h", String(opts.h));
    params.set("fit", "crop");
  } else if (orientation === "square") {
    params.set("w", "1000");
    params.set("h", "1000");
    params.set("fit", "crop");
  } else if (orientation === "portrait") {
    params.set("w", "1000");
    params.set("h", "1400");
    params.set("fit", "crop");
  } else {
    params.set("w", "1600");
  }
  return `${base}?${params}`;
}

/** One line of attribution for CREDITS.md. */
export function creditLine(role: string, photo: PexelsPhoto): string {
  return `- \`${role}\` — [photo](${photo.url}) by [${photo.photographer}](${photo.photographer_url}) on Pexels`;
}

/**
 * Replace (or insert) a site's block in CREDITS.md between HTML comment markers so re-running is
 * idempotent and other sites' blocks are untouched.
 */
export function upsertCreditsBlock(existing: string, site: string, block: string): string {
  const start = `<!-- site:${site}:start -->`;
  const end = `<!-- site:${site}:end -->`;
  const section = `${start}\n${block}\n${end}`;
  const re = new RegExp(`${start}[\\s\\S]*?${end}`);
  if (re.test(existing)) {
    return existing.replace(re, section);
  }
  const header =
    existing.trim().length > 0
      ? existing.trimEnd()
      : "# Photo credits\n\nAll photos from [Pexels](https://www.pexels.com) under the [Pexels License](https://www.pexels.com/license/).";
  return `${header}\n\n${section}\n`;
}

async function pexelsGet<T>(url: string, key: string): Promise<T> {
  const res = await fetch(url, { headers: { Authorization: key } });
  if (!res.ok) {
    throw new Error(`Pexels ${res.status} for ${url}`);
  }
  return (await res.json()) as T;
}

async function download(url: string, dest: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Download ${res.status} for ${url}`);
  }
  await writeFile(dest, Buffer.from(await res.arrayBuffer()));
}

async function main(): Promise<void> {
  const [siteId, ...rest] = process.argv.slice(2);
  const force = rest.includes("--force");
  if (!siteId) {
    console.error("Usage: PEXELS_API_KEY=… bun scripts/fetch-photos.ts <site-id> [--force]");
    process.exit(1);
  }
  const key = process.env.PEXELS_API_KEY;
  if (!key) {
    console.error("PEXELS_API_KEY is not set.");
    process.exit(1);
  }

  const siteDir = join(SITES_DIR, siteId);
  const manifestPath = join(siteDir, "images.json");
  if (!existsSync(manifestPath)) {
    console.error(`No images.json at ${manifestPath}`);
    process.exit(1);
  }
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as ImagesManifest;
  const imagesDir = join(siteDir, "public", "images");
  await mkdir(imagesDir, { recursive: true });

  const credits: string[] = [];
  let thumbnailPhoto: PexelsPhoto | null = null;

  for (const spec of manifest.images) {
    let photo: PexelsPhoto;
    if (spec.photoId && !force) {
      photo = await pexelsGet<PexelsPhoto>(`${PEXELS_API}/photos/${spec.photoId}`, key);
    } else {
      const data = await pexelsGet<{ photos: PexelsPhoto[] }>(buildSearchUrl(spec), key);
      if (data.photos.length === 0) {
        throw new Error(`No Pexels results for "${spec.query}" (role ${spec.role})`);
      }
      [photo] = data.photos;
      spec.photoId = photo.id;
    }
    await download(sizedUrl(photo, spec.orientation), join(imagesDir, `${spec.role}.jpg`));
    credits.push(creditLine(spec.role, photo));
    if (spec.role === manifest.thumbnail) {
      thumbnailPhoto = photo;
    }
    console.log(`✓ ${spec.role} (photo ${photo.id})`);
  }

  // Pin the chosen ids back into images.json for reproducibility.
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  // Update CREDITS.md.
  const existingCredits = existsSync(CREDITS_PATH) ? await readFile(CREDITS_PATH, "utf8") : "";
  const block = `## ${siteId}\n\n${credits.join("\n")}`;
  await writeFile(CREDITS_PATH, upsertCreditsBlock(existingCredits, siteId, block));

  // Regenerate the registry thumbnail (small cropped crop → data URI).
  if (thumbnailPhoto) {
    const thumbRes = await fetch(sizedUrl(thumbnailPhoto, "landscape", { h: 320, w: 480 }));
    const b64 = Buffer.from(await thumbRes.arrayBuffer()).toString("base64");
    const dataUri = `data:image/jpeg;base64,${b64}`;
    const registry = JSON.parse(await readFile(REGISTRY_PATH, "utf8")) as {
      id: string;
      thumbnail: string;
    }[];
    const entry = registry.find((r) => r.id === siteId);
    if (entry) {
      entry.thumbnail = dataUri;
      await writeFile(REGISTRY_PATH, `${JSON.stringify(registry, null, 2)}\n`);
      console.log("✓ registry thumbnail updated");
    }
  }

  console.log(`\nDone: ${manifest.images.length} photos → ${imagesDir}`);
}

if (import.meta.main) {
  await main();
}
