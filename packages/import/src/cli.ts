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
  --min-fidelity <n>       Fail (exit 1) below this average fidelity 0..100 (default: 25)
  --verify-threshold <n>   Per-pixel colour tolerance 0..1 for the diff (default: 0.15).
                           Moves the score; it is NOT the pass bar — --min-fidelity is.
  --verify-viewport-only   Diff only the first viewport instead of the whole page

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
/*
 * The floor below which the output is not a clone of anything.
 *
 * It is deliberately low rather than a quality bar: a real import of a complicated site lands well
 * under 100 for reasons nobody can fix from here (a rotating hero, a font that renders a hair
 * differently), and failing those would train people to pass `--min-fidelity 0` and stop looking.
 * Under a quarter of pixels matching is a different question — that is the 8%-fidelity Wix clone
 * that printed `Done!` and exited 0, which is worse than a failure because the only way to see it
 * is to open the result (issue #232).
 */
const minFidelity = parseIntArg(args, "--min-fidelity", 25);
const verifyFullPage = !args.includes("--verify-viewport-only");

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
        verify: doVerify
          ? { threshold: verifyThreshold, minFidelity, fullPage: verifyFullPage }
          : false,
      },
      (e) => console.log(`  ${e.message}`),
    );

    console.log(`\n  Imported ${result.pages.length} page${result.pages.length === 1 ? "" : "s"}:`);
    for (const page of result.pages) {
      console.log(`    ${page.route} — "${page.title}" (${page.nodeCount} nodes)`);
    }
    if (result.verify) {
      console.log(`  Average fidelity: ${result.verify.averageFidelity}%`);
      for (const page of result.verify.pages) {
        const misses = [
          page.failedRequests > 0 ? `${page.failedRequests} failed request(s)` : "",
          page.consoleErrors > 0 ? `${page.consoleErrors} console error(s)` : "",
        ].filter(Boolean);
        if (misses.length > 0) {
          console.log(`    ${page.route}: ${misses.join(", ")}`);
        }
      }
      console.log(`  Report: ${result.verify.reportDir}/report.json`);
    }

    /*
     * A verify that cannot fail is a report, not a gate. An import nobody opens and looks at is
     * exactly the case the exit code exists for, so a build error or a fidelity under the floor
     * ends the run non-zero and says which one it was.
     */
    if (result.verify && !result.verify.passed) {
      for (const error of result.verify.buildErrors) {
        console.error(`Build error: ${error}`);
      }
      console.error(
        `\nVerification FAILED — the project is at ${outDir}, but it does not match the original.`,
      );
      if (result.verify.buildErrors.length === 0) {
        console.error(
          `  Average fidelity ${result.verify.averageFidelity}% is below the ` +
            `${result.verify.minFidelity}% minimum. Pass --min-fidelity to change it.`,
        );
      }
      console.error(`  Report: ${result.verify.reportDir}/report.json`);
      process.exitCode = 1;
      return;
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
