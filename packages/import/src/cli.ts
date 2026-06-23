#!/usr/bin/env bun

import { resolve } from "node:path";
import { capturePage, launchBrowser, closeBrowser } from "./capture.ts";
import { convertToJx } from "./to-jx.ts";
import { emitMultiPageProject } from "./emit.ts";
import { captureStyles } from "./style-capture.ts";
import { diffAllStyles } from "./style-diff.ts";
import { extractMedia } from "./media-extract.ts";
import { applyStylesToTree } from "./apply-styles.ts";
import { collectAssets } from "./asset-collect.ts";
import { downloadAssets } from "./asset-download.ts";
import { rewriteAssetUrls } from "./asset-rewrite.ts";
import { crawlSite } from "./crawl.ts";
import { detectLayout } from "./layout-detect.ts";
import type { JxElement } from "@jxsuite/schema/types";

function usage(): never {
  console.log(`Usage: jx-import <url> [options]

Clone a live website into a Jx project.

Options:
  --out <dir>              Output directory (default: sites/<hostname>)
  --depth <n>              Max crawl depth (default: 2, 0 = single page)
  --max-pages <n>          Max pages to capture (default: 25)
  --max-nodes-per-page <n> Skip styles/assets for pages above this (default: 5000)
  --no-styles              Skip CSS capture
  --no-assets              Skip asset download
  --no-crawl               Single page only (equivalent to --depth 0)
  --no-robots              Ignore robots.txt
  --no-components          Skip component extraction (Phase 4)
  --min-instances <n>      Min recurring instances to extract a component (default: 2)
  --min-depth <n>          Min subtree depth to consider for componentization (default: 2)
  --verify                 After import, build and screenshot-diff vs original (Phase 5)
  --verify-threshold <n>   Pixel diff threshold 0..1 (default: 0.15)

Examples:
  jx-import https://example.com
  jx-import https://example.com --depth 1 --max-pages 10
  jx-import https://example.com --no-crawl
  jx-import https://example.com --out sites/my-clone --no-styles
  jx-import https://example.com --verify`);
  process.exit(1);
}

function parseIntArg(args: string[], flag: string, fallback: number): number {
  const idx = args.indexOf(flag);
  if (idx === -1 || !args[idx + 1]) {
    return fallback;
  }
  const n = Number.parseInt(args[idx + 1], 10);
  return Number.isNaN(n) ? fallback : n;
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
const noCrawl = args.includes("--no-crawl");
const noRobots = args.includes("--no-robots");
const noComponents = args.includes("--no-components");
const doVerify = args.includes("--verify");
const verifyThresholdIdx = args.indexOf("--verify-threshold");
const verifyThreshold =
  verifyThresholdIdx !== -1 && args[verifyThresholdIdx + 1]
    ? Number.parseFloat(args[verifyThresholdIdx + 1]) || 0.15
    : 0.15;

const maxDepth = noCrawl ? 0 : parseIntArg(args, "--depth", 2);
const maxPages = parseIntArg(args, "--max-pages", 25);
const maxNodesPerPage = parseIntArg(args, "--max-nodes-per-page", 5000);
const minInstances = parseIntArg(args, "--min-instances", 2);
const minDepthArg = parseIntArg(args, "--min-depth", 2);

const componentizeOptions = noComponents
  ? (false as const)
  : { minInstances, minDepth: minDepthArg };

let outDir: string;
const outIdx = args.indexOf("--out");
if (outIdx !== -1 && args[outIdx + 1]) {
  outDir = resolve(args[outIdx + 1]);
} else {
  const hostname = new URL(url).hostname.replace(/^www\./, "");
  outDir = resolve("sites", hostname);
}

console.log(`Importing ${url} → ${outDir}`);
if (maxDepth > 0) {
  console.log(`  Crawl: depth=${maxDepth}, max-pages=${maxPages}, max-nodes=${maxNodesPerPage}\n`);
} else {
  console.log(`  Single page mode\n`);
}

// Single-page mode: original Phase 0–2 pipeline (faster, no crawl overhead)
if (maxDepth === 0) {
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

    if (jx.nodeCount > maxNodesPerPage) {
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
    const { files } = await emitMultiPageProject({
      outDir,
      title: capture.title,
      pages: new Map([["pages/index.json", jx.document]]),
      sourceUrl: url,
      breakpoints,
      componentizeOptions,
    });
    console.log(`  Wrote ${files.length} files`);

    if (doVerify) {
      console.log("\n  --- Phase 5: Verify ---");
      const { verifyProject } = await import("./verify.ts");
      const pageUrls = new Map([["pages/index.json", url]]);
      const verifyResult = await verifyProject({
        projectDir: outDir,
        pageUrls,
        threshold: verifyThreshold,
        onProgress: (msg) => console.log(`  ${msg}`),
        browser,
      });
      console.log(`\n  Verification complete:`);
      for (const page of verifyResult.pages) {
        const status = page.error ? `ERROR: ${page.error}` : `${page.fidelity}% fidelity`;
        console.log(`    ${page.route} — ${status}`);
      }
      console.log(`  Average fidelity: ${verifyResult.averageFidelity}%`);
      console.log(`  Report: ${verifyResult.reportDir}/report.json`);
    }

    console.log(`\nDone! Open in Studio:`);
    console.log(
      `  http://localhost:3000/packages/studio/index.html?project=${outDir}/project.json`,
    );
  } finally {
    await closeBrowser();
  }
} else {
  // Multi-page crawl mode (Phase 3)
  try {
    const result = await crawlSite({
      url,
      outDir,
      maxDepth,
      maxPages,
      maxNodesPerPage,
      skipStyles,
      skipAssets,
      respectRobots: !noRobots,
      onProgress: console.log,
    });

    console.log(`\n  Crawled ${result.pages.length} page${result.pages.length !== 1 ? "s" : ""}`);
    if (result.skippedByRobots.length > 0) {
      console.log(`  Skipped ${result.skippedByRobots.length} URLs (robots.txt)`);
    }
    if (result.skippedByNodeCap.length > 0) {
      console.log(
        `  ⚠ ${result.skippedByNodeCap.length} pages exceeded node cap (styles/assets skipped)`,
      );
    }

    // Build page map
    const pageMap = new Map<string, JxElement>();
    for (const page of result.pages) {
      pageMap.set(page.route, page.jx.document);
    }

    // Layout detection
    let layout: JxElement | undefined;
    if (result.pages.length >= 2) {
      console.log("  Detecting shared layout (header/footer)...");
      const layoutResult = detectLayout(pageMap);
      if (layoutResult) {
        ({ layout } = layoutResult);
        const headerFooterCount = (Array.isArray(layout.children) ? layout.children.length : 0) - 1; // Minus the slot
        console.log(`  Found shared layout with ${headerFooterCount} shared elements`);
        // Replace pages with stripped versions
        for (const [route, stripped] of layoutResult.strippedPages) {
          pageMap.set(route, stripped);
        }
      } else {
        console.log("  No shared layout detected");
      }
    }

    console.log("  Writing project...");
    const title = result.pages[0]?.title || new URL(url).hostname;
    const { files } = await emitMultiPageProject({
      outDir,
      title,
      sourceUrl: url,
      pages: pageMap,
      layout,
      breakpoints: result.breakpoints,
      componentizeOptions,
    });

    console.log(`  Wrote ${files.length} files:`);
    for (const page of result.pages) {
      console.log(`    ${page.route} — "${page.title}" (${page.jx.nodeCount} nodes)`);
    }

    if (doVerify) {
      console.log("\n  --- Phase 5: Verify ---");
      const { verifyProject } = await import("./verify.ts");
      const pageUrls = new Map<string, string>();
      for (const page of result.pages) {
        pageUrls.set(page.route, page.url);
      }
      const verifyResult = await verifyProject({
        projectDir: outDir,
        pageUrls,
        threshold: verifyThreshold,
        onProgress: (msg) => console.log(`  ${msg}`),
      });
      console.log(`\n  Verification complete:`);
      for (const page of verifyResult.pages) {
        const status = page.error ? `ERROR: ${page.error}` : `${page.fidelity}% fidelity`;
        console.log(`    ${page.route} — ${status}`);
      }
      console.log(`  Average fidelity: ${verifyResult.averageFidelity}%`);
      console.log(`  Report: ${verifyResult.reportDir}/report.json`);
    }

    console.log(`\nDone! Open in Studio:`);
    console.log(
      `  http://localhost:3000/packages/studio/index.html?project=${outDir}/project.json`,
    );
  } finally {
    await closeBrowser();
  }
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
