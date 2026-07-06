#!/usr/bin/env bun

import { resolve } from "node:path";
import { homedir } from "node:os";
import { importSite } from "./run.ts";

function usage(): never {
  console.log(`Usage: jx-import <url> [options]

Clone a live website into a Jx project.

Options:
  --out <dir>              Output directory (default: ~/jx-imports/<hostname>)
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
  CHROME_PATH              Explicit Chrome/Chromium binary

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
if (!url || (!url.startsWith("http://") && !url.startsWith("https://"))) {
  console.error("Error: URL must start with http:// or https://");
  process.exit(1);
}

const noCrawl = args.includes("--no-crawl");
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
const minDepth = parseIntArg(args, "--min-depth", 2);

let ai: false | { apiKey: string; baseUrl?: string | undefined; model?: string | undefined } =
  false;
if (doAiComponents) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.error("Error: --ai-components requires OPENAI_API_KEY environment variable");
    process.exit(1);
  }
  ai = { apiKey, baseUrl: process.env.OPENAI_BASE_URL, model: aiModel };
}

let outDir: string;
const outIdx = args.indexOf("--out");
const outArg = args[outIdx + 1];
if (outIdx !== -1 && outArg) {
  outDir = resolve(outArg);
} else {
  const hostname = new URL(url).hostname.replace(/^www\./, "");
  outDir = resolve(homedir(), "jx-imports", hostname);
}

console.log(`Importing ${url} → ${outDir}`);
if (maxDepth > 0) {
  console.log(`  Crawl: depth=${maxDepth}, max-pages=${maxPages}, max-nodes=${maxNodesPerPage}\n`);
} else {
  console.log(`  Single page mode\n`);
}

// The interactive flow runs inside an async function rather than via top-level await so a test can
// Dynamic-import this entry and await the same sequence (see create/index.ts for the rationale).
async function main() {
  try {
    const result = await importSite(
      {
        url: url as string,
        outDir,
        maxDepth,
        maxPages,
        maxNodesPerPage,
        styles: !args.includes("--no-styles"),
        assets: !args.includes("--no-assets"),
        scroll: !args.includes("--no-scroll"),
        respectRobots: !args.includes("--no-robots"),
        componentize: noComponents ? false : { minInstances, minDepth },
        ai,
        verify: doVerify ? { threshold: verifyThreshold } : false,
      },
      (e) => console.log(`  ${e.message}`),
    );

    console.log(`\n  Imported ${result.pages.length} page${result.pages.length === 1 ? "" : "s"}:`);
    for (const page of result.pages) {
      console.log(`    ${page.route} — "${page.title}" (${page.nodeCount} nodes)`);
    }
    if (result.verify) {
      console.log(`  Average fidelity: ${result.verify.averageFidelity}%`);
      console.log(`  Report: ${result.verify.reportDir}/report.json`);
    }

    console.log(`\nDone! Open in Studio:`);
    console.log(
      `  http://localhost:3000/packages/studio/index.html?project=${outDir}/project.json`,
    );
  } catch (error) {
    console.error(`Error: ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  }
}

// oxlint-disable-next-line unicorn/prefer-top-level-await
export const ready = main();
