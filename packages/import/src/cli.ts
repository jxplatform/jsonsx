#!/usr/bin/env bun

import { resolve } from "node:path";
import { capturePage, launchBrowser, closeBrowser } from "./capture.ts";
import { convertToJx } from "./to-jx.ts";
import { emitMultiPageProject } from "./emit.ts";
import { captureStyles } from "./style-capture.ts";
import { diffAllStyles, kebabToCamel } from "./style-diff.ts";
import { extractMedia } from "./media-extract.ts";
import { applyStylesToTree } from "./apply-styles.ts";
import { collectAssets } from "./asset-collect.ts";
import { downloadAssets } from "./asset-download.ts";
import { rewriteAssetUrls } from "./asset-rewrite.ts";
import { applyTokens } from "./css-tokens.ts";
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
  --no-scroll              Skip scroll-to-bottom (faster, may miss lazy content)
  --no-robots              Ignore robots.txt
  --no-components          Skip component extraction (Phase 4)
  --min-instances <n>      Min recurring instances to extract a component (default: 2)
  --min-depth <n>          Min subtree depth to consider for componentization (default: 2)
  --ai-components          Use LLM to refine component names and props (Phase 4 AI pass)
  --ai-model <model>       Model for AI componentization (default: gpt-4o-mini)
  --verify                 After import, build and screenshot-diff vs original (Phase 5)
  --verify-threshold <n>   Pixel diff threshold 0..1 (default: 0.15)

Environment:
  OPENAI_API_KEY           Required for --ai-components
  OPENAI_BASE_URL          Custom API base URL (default: https://api.openai.com/v1)

Examples:
  jx-import https://example.com
  jx-import https://example.com --depth 1 --max-pages 10
  jx-import https://example.com --no-crawl
  jx-import https://example.com --out sites/my-clone --no-styles
  jx-import https://example.com --verify
  jx-import https://example.com --ai-components`);
  process.exit(1);
}

function parseIntArg(args: string[], flag: string, fallback: number): number {
  const idx = args.indexOf(flag);
  if (idx === -1 || !args[idx + 1]) {
    return fallback;
  }
  const n = Math.trunc(Number(args[idx + 1]));
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
const noScroll = args.includes("--no-scroll");
const noRobots = args.includes("--no-robots");
const noComponents = args.includes("--no-components");
const doAiComponents = args.includes("--ai-components");
const aiModelIdx = args.indexOf("--ai-model");
const aiModel = aiModelIdx !== -1 && args[aiModelIdx + 1] ? args[aiModelIdx + 1] : undefined;
const doVerify = args.includes("--verify");
const verifyThresholdIdx = args.indexOf("--verify-threshold");
const verifyThreshold =
  verifyThresholdIdx !== -1 && args[verifyThresholdIdx + 1]
    ? Number(args[verifyThresholdIdx + 1]) || 0.15
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
    const capture = await capturePage(url, browser, { scrollToBottom: !noScroll });
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
    let styleTokens: Record<string, string> | undefined;

    if (!skipStyles) {
      console.log("  Capturing computed styles...");
      const styleResult = await captureStyles(capture.page);
      console.log(
        `  Captured styles for ${styleResult.elements.length} elements, ${Object.keys(styleResult.uaDefaults).length} tag baselines`,
      );

      console.log("  Diffing against UA defaults...");
      const diffed = diffAllStyles(styleResult.elements, styleResult.uaDefaults);
      console.log(`  ${diffed.length} elements with non-default styles`);

      // R5: Replace resolved values with var(--name) references
      const propCount = Object.keys(styleResult.customProperties).length;
      if (propCount > 0) {
        const tokenResult = applyTokens(diffed, styleResult.customProperties);
        if (tokenResult.replacements > 0) {
          styleTokens = tokenResult.tokens;
          console.log(
            `  Extracted ${Object.keys(tokenResult.tokens).length} design tokens (${tokenResult.replacements} replacements)`,
          );
        } else {
          console.log(`  ${propCount} custom properties found, but none matched computed values`);
        }
      }

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

      // Apply <html>/<body> computed styles to the root wrapper
      if (Object.keys(styleResult.documentStyles).length > 0) {
        if (!jx.document.style) {
          jx.document.style = {};
        }
        for (const [prop, val] of Object.entries(styleResult.documentStyles)) {
          const camel = kebabToCamel(prop);
          jx.document.style[camel] = val;
        }
        console.log(
          `  Applied ${Object.keys(styleResult.documentStyles).length} document-level styles to root`,
        );
      }
    }

    let fontFaceRules: string[] | undefined;
    let fontRewriteMap: Map<string, string> | undefined;

    if (!skipAssets) {
      console.log("  Collecting asset URLs...");
      const collected = await collectAssets(capture.page);
      console.log(
        `  Found ${collected.assets.length} assets (${collected.inlineSvgCount} inline SVGs kept, ${collected.stylesheets.length} stylesheets retained)`,
      );

      // Extract @font-face rules from retained stylesheets (R2)
      const allFontRules = collected.stylesheets.flatMap((s) => s.fontFaceRules);
      if (allFontRules.length > 0) {
        fontFaceRules = allFontRules;
        console.log(`  Found ${allFontRules.length} @font-face rules`);
      }

      if (collected.assets.length > 0) {
        console.log("  Downloading assets...");
        const downloaded = await downloadAssets(collected.assets, outDir, url);
        console.log(
          `  Downloaded ${downloaded.rewriteMap.size} assets (${formatBytes(downloaded.totalBytes)})`,
        );
        if (downloaded.failed.length > 0) {
          console.log(`  ⚠ ${downloaded.failed.length} assets failed to download`);
        }
        if (downloaded.skipped.length > 0) {
          console.log(`  Skipped ${downloaded.skipped.length} tracking/analytics URLs`);
        }

        // Build font-specific rewrite map for R2
        if (fontFaceRules) {
          fontRewriteMap = new Map<string, string>();
          for (const [originalUrl, localPath] of downloaded.rewriteMap) {
            if (localPath.includes("/fonts/") || /\.(woff2?|ttf|otf|eot)$/i.test(localPath)) {
              fontRewriteMap.set(originalUrl, localPath);
            }
          }
        }

        console.log("  Rewriting asset URLs...");
        const rewrites = rewriteAssetUrls(jx.document, downloaded.rewriteMap, url);
        console.log(`  Rewrote ${rewrites} URL references`);
      }
    }

    // Capture reference screenshot before closing the page (for --verify)
    let referenceScreenshot: Buffer | undefined;
    if (doVerify) {
      console.log("  Capturing reference screenshot...");
      const { captureReferenceScreenshot } = await import("./verify.ts");
      referenceScreenshot = await captureReferenceScreenshot(capture.page);
    }

    await capture.page.close();

    // Phase 4 AI pass: run heuristic componentize, then refine with LLM
    let precomputedComponents;
    if (doAiComponents && componentizeOptions !== false) {
      const { componentize } = await import("./componentize.ts");
      const { aiComponentize } = await import("./ai-componentize.ts");
      const apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey) {
        console.error("Error: --ai-components requires OPENAI_API_KEY environment variable");
        process.exit(1);
      }
      console.log("  Running heuristic componentization...");
      const pageMap = new Map([["pages/index.json", jx.document]]);
      const heuristic = componentize(pageMap, componentizeOptions ?? {});
      if (heuristic.components.size > 0) {
        console.log(`  Found ${heuristic.components.size} component(s), refining with AI...`);
        precomputedComponents = await aiComponentize(
          heuristic,
          {
            apiKey,
            baseUrl: process.env.OPENAI_BASE_URL,
            model: aiModel,
          },
          (msg) => console.log(`  ${msg}`),
        );
        console.log(`  AI refined ${precomputedComponents.components.size} component(s)`);
      }
    }

    console.log("  Writing project...");
    const { files } = await emitMultiPageProject({
      outDir,
      title: capture.title,
      pages: new Map([["pages/index.json", jx.document]]),
      sourceUrl: url,
      breakpoints,
      componentizeOptions: precomputedComponents ? false : componentizeOptions,
      precomputedComponents,
      fontFaceRules,
      fontRewriteMap,
      styleTokens,
    });
    console.log(`  Wrote ${files.length} files`);

    if (doVerify && referenceScreenshot) {
      console.log("\n  --- Phase 5: Verify ---");
      const { verifyProject } = await import("./verify.ts");
      const verifyPages = new Map([
        ["pages/index.json", { sourceUrl: url, screenshot: referenceScreenshot }],
      ]);
      const verifyResult = await verifyProject({
        projectDir: outDir,
        pages: verifyPages,
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
      noScroll,
      captureScreenshots: doVerify,
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

    // Phase 4 AI pass
    let precomputedComponentsMulti;
    if (doAiComponents && componentizeOptions !== false) {
      const { componentize } = await import("./componentize.ts");
      const { aiComponentize } = await import("./ai-componentize.ts");
      const apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey) {
        console.error("Error: --ai-components requires OPENAI_API_KEY environment variable");
        process.exit(1);
      }
      console.log("  Running heuristic componentization...");
      const heuristic = componentize(pageMap, componentizeOptions ?? {});
      if (heuristic.components.size > 0) {
        console.log(`  Found ${heuristic.components.size} component(s), refining with AI...`);
        precomputedComponentsMulti = await aiComponentize(
          heuristic,
          {
            apiKey,
            baseUrl: process.env.OPENAI_BASE_URL,
            model: aiModel,
          },
          (msg) => console.log(`  ${msg}`),
        );
        console.log(`  AI refined ${precomputedComponentsMulti.components.size} component(s)`);
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
      componentizeOptions: precomputedComponentsMulti ? false : componentizeOptions,
      precomputedComponents: precomputedComponentsMulti,
      fontFaceRules: result.fontFaceRules.length > 0 ? result.fontFaceRules : undefined,
      fontRewriteMap: result.fontRewriteMap.size > 0 ? result.fontRewriteMap : undefined,
      styleTokens: result.styleTokens,
    });

    console.log(`  Wrote ${files.length} files:`);
    for (const page of result.pages) {
      console.log(`    ${page.route} — "${page.title}" (${page.jx.nodeCount} nodes)`);
    }

    if (doVerify) {
      console.log("\n  --- Phase 5: Verify ---");
      const { verifyProject } = await import("./verify.ts");
      const verifyPages = new Map<string, { sourceUrl: string; screenshot: Buffer | string }>();
      for (const page of result.pages) {
        if (page.screenshot) {
          verifyPages.set(page.route, { sourceUrl: page.url, screenshot: page.screenshot });
        }
      }
      if (verifyPages.size === 0) {
        console.log("  No reference screenshots captured — skipping verify");
      }
      const verifyResult =
        verifyPages.size > 0
          ? await verifyProject({
              projectDir: outDir,
              pages: verifyPages,
              threshold: verifyThreshold,
              onProgress: (msg) => console.log(`  ${msg}`),
            })
          : null;
      if (verifyResult) {
        console.log(`\n  Verification complete:`);
        for (const page of verifyResult.pages) {
          const status = page.error ? `ERROR: ${page.error}` : `${page.fidelity}% fidelity`;
          console.log(`    ${page.route} — ${status}`);
        }
        console.log(`  Average fidelity: ${verifyResult.averageFidelity}%`);
        console.log(`  Report: ${verifyResult.reportDir}/report.json`);
      }
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
