#!/usr/bin/env bun

import { resolve } from "node:path";
import { capturePage, launchBrowser, closeBrowser } from "./capture.ts";
import { convertToJx } from "./to-jx.ts";
import { emitProject } from "./emit.ts";
import { captureStyles } from "./style-capture.ts";
import { diffAllStyles } from "./style-diff.ts";
import { extractMedia } from "./media-extract.ts";
import { applyStylesToTree } from "./apply-styles.ts";
import { collectAssets } from "./asset-collect.ts";
import { downloadAssets } from "./asset-download.ts";
import { rewriteAssetUrls } from "./asset-rewrite.ts";

function usage(): never {
  console.log(`Usage: jx-import <url> [--out <dir>] [--no-styles] [--no-assets]

Clone a live website into a Jx project.

Options:
  --out <dir>    Output directory (default: sites/<hostname>)
  --no-styles    Skip CSS capture (Phase 0 behavior)
  --no-assets    Skip asset download (Phase 1 behavior)

Examples:
  jx-import https://example.com
  jx-import https://example.com --out sites/my-clone
  jx-import https://example.com --no-styles`);
  process.exit(1);
}

const args = process.argv.slice(2);
if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
  usage();
}

const [url] = args;
if (!url.startsWith("http://") && !url.startsWith("https://")) {
  console.error("Error: URL must start with http:// or https://");
  process.exit(1);
}

const skipStyles = args.includes("--no-styles");
const skipAssets = args.includes("--no-assets");

let outDir: string | undefined;
const outIdx = args.indexOf("--out");
if (outIdx !== -1 && args[outIdx + 1]) {
  outDir = resolve(args[outIdx + 1]);
} else {
  const hostname = new URL(url).hostname.replace(/^www\./, "");
  outDir = resolve("sites", hostname);
}

console.log(`Importing ${url} → ${outDir}\n`);

console.log("  Launching browser...");
const browser = await launchBrowser();

try {
  console.log("  Capturing page...");
  const capture = await capturePage(url, browser);
  console.log(`  Captured: "${capture.title}" (${capture.links.length} links found)`);

  console.log("  Converting to Jx...");
  const jx = convertToJx(capture.bodyHtml);
  console.log(
    `  Converted: ${jx.nodeCount} nodes, ${jx.collectedStyles.length} inline stylesheets collected`,
  );

  if (jx.nodeCount > 5000) {
    console.log(
      `  ⚠ Large page (${jx.nodeCount} nodes). Studio may be slow — see docs/studio-state-model-improvements.md`,
    );
  }

  let breakpoints: Record<string, string> | undefined;

  if (!skipStyles) {
    console.log("  Capturing computed styles...");
    const styleResult = await captureStyles(capture.page);
    console.log(
      `  Captured styles for ${styleResult.elements.length} elements, ${Object.keys(styleResult.uaDefaults).length} tag baselines`,
    );

    console.log("  Diffing against UA defaults...");
    const diffed = diffAllStyles(styleResult.elements, styleResult.uaDefaults);
    console.log(`  ${diffed.length} elements with non-default styles`);

    if (styleResult.mediaQueries.length > 0) {
      console.log(
        `  Extracting @media breakpoints (${styleResult.mediaQueries.length} queries found)...`,
      );
      const media = await extractMedia(
        capture.page,
        styleResult.elements,
        styleResult.uaDefaults,
        styleResult.mediaQueries,
      );
      const bpCount = Object.keys(media.breakpoints).length;
      if (bpCount > 0) {
        console.log(`  ${bpCount} breakpoints with style changes`);
        ({ breakpoints } = media);
        applyStylesToTree(jx.document, diffed, media.deltas);
      } else {
        console.log("  No responsive breakpoints with style changes");
        applyStylesToTree(jx.document, diffed);
      }
    } else {
      console.log("  No @media queries found");
      applyStylesToTree(jx.document, diffed);
    }
  }

  // Phase 2: Asset download & URL rewrite
  if (!skipAssets) {
    console.log("  Collecting asset URLs...");
    const collected = await collectAssets(capture.page);
    console.log(
      `  Found ${collected.assets.length} assets (${collected.inlineSvgCount} inline SVGs kept)`,
    );

    if (collected.assets.length > 0) {
      console.log("  Downloading assets...");
      const downloaded = await downloadAssets(collected.assets, outDir);
      console.log(
        `  Downloaded ${downloaded.rewriteMap.size} assets (${formatBytes(downloaded.totalBytes)})`,
      );
      if (downloaded.failed.length > 0) {
        console.log(`  ⚠ ${downloaded.failed.length} assets failed to download`);
      }
      if (downloaded.skipped.length > 0) {
        console.log(`  Skipped ${downloaded.skipped.length} tracking/analytics URLs`);
      }

      console.log("  Rewriting asset URLs...");
      const rewrites = rewriteAssetUrls(jx.document, downloaded.rewriteMap);
      console.log(`  Rewrote ${rewrites} URL references`);
    }
  }

  await capture.page.close();

  console.log("  Writing project...");
  const { files } = await emitProject({
    outDir,
    title: capture.title,
    document: jx.document,
    sourceUrl: url,
    breakpoints,
  });
  console.log(`  Wrote ${files.length} files`);

  console.log(`\nDone! Open in Studio:`);
  console.log(`  http://localhost:3000/packages/studio/index.html?project=${outDir}/project.json`);
} finally {
  await closeBrowser();
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
