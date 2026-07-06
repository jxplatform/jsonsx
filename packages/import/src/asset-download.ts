/**
 * Download discovered assets to public/assets/ and build a URL rewrite map.
 *
 * Skips tracking/analytics domains. Dedupes by URL. Preserves file extensions. Organizes into
 * subdirectories by type: images/, fonts/, icons/.
 */

import { join, extname } from "node:path";
import { mkdir } from "node:fs/promises";
import type { DiscoveredAsset } from "./asset-collect.ts";

export interface DownloadResult {
  /**
   * Maps original absolute URL → relative path from project root (e.g.
   * "public/assets/images/hero.jpg").
   */
  rewriteMap: Map<string, string>;
  /** URLs that failed to download. */
  failed: string[];
  /** URLs skipped (tracking, analytics, etc.). */
  skipped: string[];
  /** Total bytes downloaded. */
  totalBytes: number;
}

const BLOCKED_DOMAINS = new Set([
  "www.google-analytics.com",
  "google-analytics.com",
  "googletagmanager.com",
  "www.googletagmanager.com",
  "analytics.google.com",
  "stats.g.doubleclick.net",
  "www.facebook.com",
  "connect.facebook.net",
  "px.ads.linkedin.com",
  "bat.bing.com",
  "snap.licdn.com",
  "tr.snapchat.com",
  "cdn.segment.com",
  "api.segment.io",
  "static.hotjar.com",
  "script.hotjar.com",
  "plausible.io",
  "cdn.amplitude.com",
]);

const FONT_EXTENSIONS = new Set([".woff", ".woff2", ".ttf", ".otf", ".eot"]);
const IMAGE_EXTENSIONS = new Set([
  ".jpg",
  ".jpeg",
  ".png",
  ".gif",
  ".webp",
  ".avif",
  ".svg",
  ".ico",
  ".bmp",
  ".tiff",
]);

function classifyAsset(
  url: string,
  source: DiscoveredAsset["source"],
): "images" | "fonts" | "icons" | "other" {
  if (source === "font-face") {
    return "fonts";
  }
  if (source === "favicon") {
    return "icons";
  }

  const [ext = ""] = extname(new URL(url).pathname).toLowerCase().split("?");
  if (FONT_EXTENSIONS.has(ext)) {
    return "fonts";
  }
  if (IMAGE_EXTENSIONS.has(ext)) {
    return "images";
  }
  return "other";
}

function sanitizeFilename(url: string): string {
  const parsed = new URL(url);
  let { pathname } = parsed;

  // Remove leading slash
  if (pathname.startsWith("/")) {
    pathname = pathname.slice(1);
  }

  // Use just the filename part, not the full path
  const parts = pathname.split("/");
  let filename = parts.at(-1) || "asset";

  // Strip query params from extension
  const qIdx = filename.indexOf("?");
  if (qIdx !== -1) {
    filename = filename.slice(0, qIdx);
  }

  // Sanitize: keep alphanumeric, hyphens, dots, underscores
  filename = filename.replaceAll(/[^a-zA-Z0-9._-]/g, "_");

  // Ensure it has an extension
  if (!extname(filename)) {
    filename += ".bin";
  }

  // Cap length
  if (filename.length > 100) {
    const ext = extname(filename);
    filename = filename.slice(0, 96) + ext;
  }

  return filename;
}

function isBlocked(url: string): boolean {
  try {
    const { hostname } = new URL(url);
    return BLOCKED_DOMAINS.has(hostname);
  } catch {
    return true;
  }
}

export async function downloadAssets(
  assets: DiscoveredAsset[],
  outDir: string,
  sourceUrl?: string,
): Promise<DownloadResult> {
  const rewriteMap = new Map<string, string>();
  const failed: string[] = [];
  const skipped: string[] = [];
  let totalBytes = 0;

  // Dedupe by URL
  const unique = new Map<string, DiscoveredAsset>();
  for (const asset of assets) {
    if (!unique.has(asset.url)) {
      unique.set(asset.url, asset);
    }
  }

  // Create subdirectories
  const assetsDir = join(outDir, "public", "assets");
  await mkdir(join(assetsDir, "images"), { recursive: true });
  await mkdir(join(assetsDir, "fonts"), { recursive: true });
  await mkdir(join(assetsDir, "icons"), { recursive: true });
  await mkdir(join(assetsDir, "other"), { recursive: true });

  // Track filenames to avoid collisions
  const usedNames = new Map<string, number>();

  for (const [url, asset] of unique) {
    if (isBlocked(url)) {
      skipped.push(url);
      continue;
    }

    const subdir = classifyAsset(url, asset.source);
    let filename = sanitizeFilename(url);

    // Dedupe filenames within subdirectory
    const nameKey = `${subdir}/${filename}`;
    const count = usedNames.get(nameKey) ?? 0;
    if (count > 0) {
      const ext = extname(filename);
      const base = filename.slice(0, -ext.length || undefined);
      filename = `${base}-${count}${ext}`;
    }
    usedNames.set(nameKey, count + 1);

    const destPath = join(assetsDir, subdir, filename);
    const relativePath = `public/assets/${subdir}/${filename}`;

    try {
      const headers: Record<string, string> = {
        "User-Agent":
          "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      };
      if (sourceUrl) {
        headers["Referer"] = sourceUrl;
      }
      const response = await fetch(url, { headers, redirect: "follow" });
      if (!response.ok) {
        failed.push(url);
        continue;
      }

      const buffer = await response.arrayBuffer();
      totalBytes += buffer.byteLength;
      await Bun.write(destPath, buffer);
      rewriteMap.set(url, relativePath);
    } catch {
      failed.push(url);
    }
  }

  return { rewriteMap, failed, skipped, totalBytes };
}
