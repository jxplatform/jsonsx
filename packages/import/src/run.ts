/**
 * Programmatic import pipeline — the orchestrator behind both the jx-import CLI and the Studio
 * import endpoint. Runs the same phase sequence as the CLI (capture → styles → assets →
 * componentize → emit → verify), reporting progress through a callback instead of the console.
 */

import { existsSync, readdirSync } from "node:fs";
import { isAbsolute } from "node:path";
import { capturePage, closeBrowser, launchBrowser } from "./capture.ts";
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
import type { Browser } from "puppeteer-core";
import type { JxElement } from "@jxsuite/schema/types";
import type { ComponentizeResult } from "./componentize.ts";

export interface ImportSiteOptions {
  /** The page to import; must be http(s). */
  url: string;
  /** Absolute path to the (empty or absent) project directory to write. */
  outDir: string;
  /** Max crawl depth; 0 = single-page pipeline (default 2). */
  maxDepth?: number;
  /** Max pages to capture in crawl mode (default 25). */
  maxPages?: number;
  /** Skip styles/assets for pages above this node count (default 5000). */
  maxNodesPerPage?: number;
  /** Capture computed styles (default true). */
  styles?: boolean;
  /** Download and rewrite assets (default true). */
  assets?: boolean;
  /** Scroll to the bottom before capture to trigger lazy content (default true). */
  scroll?: boolean;
  /** Respect robots.txt in crawl mode (default true). */
  respectRobots?: boolean;
  /** Heuristic component extraction; false to skip (default on with standard thresholds). */
  componentize?: false | { minInstances?: number; minDepth?: number };
  /** LLM refinement of component/prop names; false/undefined to skip. */
  ai?: false | { apiKey: string; baseUrl?: string | undefined; model?: string | undefined };
  /** Build + screenshot-diff the emitted project against the original; false to skip. */
  verify?: false | { threshold?: number };
  /** Explicit browser binary (wins over CHROME_PATH and PATH discovery). */
  chromePath?: string;
  /** Aborts between phases (and between crawled pages). */
  signal?: AbortSignal;
}

export type ImportPhase =
  | "launch"
  | "capture"
  | "crawl"
  | "styles"
  | "assets"
  | "layout"
  | "components"
  | "ai"
  | "emit"
  | "verify"
  | "done";

export interface ImportProgressEvent {
  phase: ImportPhase;
  message: string;
  current?: number;
  total?: number;
}

export interface ImportSiteResult {
  outDir: string;
  pages: { route: string; title: string; nodeCount: number }[];
  fileCount: number;
  verify: { averageFidelity: number; reportDir: string } | null;
  warnings: string[];
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new Error("Import aborted");
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

/**
 * Run the heuristic componentize pass and refine it with the LLM. Returns undefined when the AI
 * pass is off, componentization is disabled, or the heuristic found nothing (the emit step then
 * runs its own heuristic pass as usual).
 */
async function maybeAiComponentize(
  pageMap: Map<string, JxElement>,
  componentizeOptions: false | { minInstances?: number; minDepth?: number },
  ai: ImportSiteOptions["ai"],
  progress: (phase: ImportPhase, message: string) => void,
): Promise<ComponentizeResult | undefined> {
  if (!ai || componentizeOptions === false) {
    return undefined;
  }
  const { componentize } = await import("./componentize.ts");
  const { aiComponentize } = await import("./ai-componentize.ts");
  progress("components", "Running heuristic componentization...");
  const heuristic = componentize(pageMap, componentizeOptions);
  if (heuristic.components.size === 0) {
    return undefined;
  }
  progress("ai", `Found ${heuristic.components.size} component(s), refining with AI...`);
  const refined = await aiComponentize(
    heuristic,
    { apiKey: ai.apiKey, baseUrl: ai.baseUrl, model: ai.model },
    (msg) => progress("ai", msg),
  );
  progress("ai", `AI refined ${refined.components.size} component(s)`);
  return refined;
}

/**
 * Import a live website into a Jx project at `outDir`.
 *
 * @param {ImportSiteOptions} options
 * @param {(e: ImportProgressEvent) => void} [onProgress]
 */
export async function importSite(
  options: ImportSiteOptions,
  onProgress?: (e: ImportProgressEvent) => void,
): Promise<ImportSiteResult> {
  const {
    url,
    outDir,
    maxDepth = 2,
    maxPages = 25,
    maxNodesPerPage = 5000,
    styles = true,
    assets = true,
    scroll = true,
    respectRobots = true,
    componentize: componentizeOptions = {},
    ai = false,
    verify = false,
    chromePath,
    signal,
  } = options;

  if (!url.startsWith("http://") && !url.startsWith("https://")) {
    throw new Error("URL must start with http:// or https://");
  }
  if (!isAbsolute(outDir)) {
    throw new Error(`outDir must be an absolute path, got "${outDir}"`);
  }
  if (existsSync(outDir) && readdirSync(outDir).length > 0) {
    throw new Error(`Directory "${outDir}" is not empty`);
  }

  const progress = (
    phase: ImportPhase,
    message: string,
    counts?: { current?: number; total?: number },
  ) => {
    onProgress?.({ phase, message, ...counts });
  };
  const warnings: string[] = [];
  const warn = (phase: ImportPhase, message: string) => {
    warnings.push(message);
    progress(phase, `⚠ ${message}`);
  };
  const verifyThreshold = verify === false ? 0.15 : (verify.threshold ?? 0.15);

  try {
    if (maxDepth === 0) {
      return await runSinglePage();
    }
    return await runCrawl();
  } finally {
    await closeBrowser();
  }

  // ─── Single-page mode: Phase 0-2 pipeline, no crawl overhead ────────────────
  async function runSinglePage(): Promise<ImportSiteResult> {
    progress("launch", "Launching browser...");
    const browser = await launchBrowser(
      chromePath === undefined ? {} : { executablePath: chromePath },
    );

    throwIfAborted(signal);
    progress("capture", "Capturing page...");
    const capture = await capturePage(url, browser, { scrollToBottom: scroll });
    progress("capture", `Captured: "${capture.title}" (${capture.links.length} links found)`);

    progress("capture", "Converting to Jx...");
    const jx = convertToJx(capture.bodyHtml);
    progress(
      "capture",
      `Converted: ${jx.nodeCount} nodes, ${jx.collectedStyles.length} inline stylesheets collected`,
    );
    if (jx.nodeCount > maxNodesPerPage) {
      warn("capture", `Large page (${jx.nodeCount} nodes). Studio may be slow.`);
    }

    let breakpoints: Record<string, string> | undefined;
    let styleTokens: Record<string, string> | undefined;

    if (styles) {
      throwIfAborted(signal);
      progress("styles", "Capturing computed styles...");
      const styleResult = await captureStyles(capture.page);
      progress(
        "styles",
        `Captured styles for ${styleResult.elements.length} elements, ${Object.keys(styleResult.uaDefaults).length} tag baselines`,
      );

      progress("styles", "Diffing against UA defaults...");
      const diffed = diffAllStyles(styleResult.elements, styleResult.uaDefaults);
      progress("styles", `${diffed.length} elements with non-default styles`);

      // Replace resolved values with var(--name) references
      const propCount = Object.keys(styleResult.customProperties).length;
      if (propCount > 0) {
        const tokenResult = applyTokens(diffed, styleResult.customProperties);
        if (tokenResult.replacements > 0) {
          styleTokens = tokenResult.tokens;
          progress(
            "styles",
            `Extracted ${Object.keys(tokenResult.tokens).length} design tokens (${tokenResult.replacements} replacements)`,
          );
        } else {
          progress(
            "styles",
            `${propCount} custom properties found, but none matched computed values`,
          );
        }
      }

      if (styleResult.mediaQueries.length > 0) {
        progress(
          "styles",
          `Extracting @media breakpoints (${styleResult.mediaQueries.length} queries found)...`,
        );
        const media = await extractMedia(
          capture.page,
          styleResult.elements,
          styleResult.uaDefaults,
          styleResult.mediaQueries,
        );
        const bpCount = Object.keys(media.breakpoints).length;
        if (bpCount > 0) {
          progress("styles", `${bpCount} breakpoints with style changes`);
          ({ breakpoints } = media);
          applyStylesToTree(jx.document, diffed, media.deltas);
        } else {
          progress("styles", "No responsive breakpoints with style changes");
          applyStylesToTree(jx.document, diffed);
        }
      } else {
        progress("styles", "No @media queries found");
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
        progress(
          "styles",
          `Applied ${Object.keys(styleResult.documentStyles).length} document-level styles to root`,
        );
      }
    }

    let fontFaceRules: string[] | undefined;
    let fontRewriteMap: Map<string, string> | undefined;

    if (assets) {
      throwIfAborted(signal);
      progress("assets", "Collecting asset URLs...");
      const collected = await collectAssets(capture.page);
      progress(
        "assets",
        `Found ${collected.assets.length} assets (${collected.inlineSvgCount} inline SVGs kept, ${collected.stylesheets.length} stylesheets retained)`,
      );

      const allFontRules = collected.stylesheets.flatMap((s) => s.fontFaceRules);
      if (allFontRules.length > 0) {
        fontFaceRules = allFontRules;
        progress("assets", `Found ${allFontRules.length} @font-face rules`);
      }

      if (collected.assets.length > 0) {
        progress("assets", "Downloading assets...");
        const downloaded = await downloadAssets(collected.assets, outDir, url);
        progress(
          "assets",
          `Downloaded ${downloaded.rewriteMap.size} assets (${formatBytes(downloaded.totalBytes)})`,
        );
        if (downloaded.failed.length > 0) {
          warn("assets", `${downloaded.failed.length} assets failed to download`);
        }
        if (downloaded.skipped.length > 0) {
          progress("assets", `Skipped ${downloaded.skipped.length} tracking/analytics URLs`);
        }

        if (fontFaceRules) {
          fontRewriteMap = new Map<string, string>();
          for (const [originalUrl, localPath] of downloaded.rewriteMap) {
            if (localPath.includes("/fonts/") || /\.(woff2?|ttf|otf|eot)$/i.test(localPath)) {
              fontRewriteMap.set(originalUrl, localPath);
            }
          }
        }

        progress("assets", "Rewriting asset URLs...");
        const rewrites = rewriteAssetUrls(jx.document, downloaded.rewriteMap, url);
        progress("assets", `Rewrote ${rewrites} URL references`);
      }
    }

    // Capture the reference screenshot before closing the page (for verify)
    let referenceScreenshot: Buffer | undefined;
    if (verify !== false) {
      progress("verify", "Capturing reference screenshot...");
      const { captureReferenceScreenshot } = await import("./verify.ts");
      referenceScreenshot = await captureReferenceScreenshot(capture.page);
    }

    await capture.page.close();

    throwIfAborted(signal);
    const pageMap = new Map([["pages/index.json", jx.document]]);
    const precomputedComponents = await maybeAiComponentize(
      pageMap,
      componentizeOptions,
      ai,
      progress,
    );

    throwIfAborted(signal);
    progress("emit", "Writing project...");
    const { files } = await emitMultiPageProject({
      outDir,
      title: capture.title,
      pages: pageMap,
      sourceUrl: url,
      breakpoints,
      componentizeOptions: precomputedComponents ? false : componentizeOptions,
      precomputedComponents,
      fontFaceRules,
      fontRewriteMap,
      styleTokens,
    });
    progress("emit", `Wrote ${files.length} files`);

    let verifySummary: ImportSiteResult["verify"] = null;
    if (verify !== false && referenceScreenshot) {
      verifySummary = await runVerify(
        new Map([["pages/index.json", { sourceUrl: url, screenshot: referenceScreenshot }]]),
        browser,
      );
    }

    progress("done", `Imported ${url} → ${outDir}`);
    return {
      outDir,
      pages: [{ route: "pages/index.json", title: capture.title, nodeCount: jx.nodeCount }],
      fileCount: files.length,
      verify: verifySummary,
      warnings,
    };
  }

  // ─── Multi-page crawl mode (Phase 3) ────────────────────────────────────────
  async function runCrawl(): Promise<ImportSiteResult> {
    progress("launch", "Launching browser...");
    await launchBrowser(chromePath === undefined ? {} : { executablePath: chromePath });

    throwIfAborted(signal);
    const result = await crawlSite({
      url,
      outDir,
      maxDepth,
      maxPages,
      maxNodesPerPage,
      skipStyles: !styles,
      skipAssets: !assets,
      respectRobots,
      noScroll: !scroll,
      captureScreenshots: verify !== false,
      onProgress: (msg) => progress("crawl", msg.trim()),
      ...(signal === undefined ? {} : { signal }),
    });

    progress(
      "crawl",
      `Crawled ${result.pages.length} page${result.pages.length === 1 ? "" : "s"}`,
      { current: result.pages.length, total: maxPages },
    );
    if (result.skippedByRobots.length > 0) {
      progress("crawl", `Skipped ${result.skippedByRobots.length} URLs (robots.txt)`);
    }
    if (result.skippedByNodeCap.length > 0) {
      warn(
        "crawl",
        `${result.skippedByNodeCap.length} pages exceeded node cap (styles/assets skipped)`,
      );
    }

    const pageMap = new Map<string, JxElement>();
    for (const page of result.pages) {
      pageMap.set(page.route, page.jx.document);
    }

    // Layout detection
    let layout: JxElement | undefined;
    if (result.pages.length >= 2) {
      throwIfAborted(signal);
      progress("layout", "Detecting shared layout (header/footer)...");
      const layoutResult = detectLayout(pageMap);
      if (layoutResult) {
        ({ layout } = layoutResult);
        const sharedCount = (Array.isArray(layout.children) ? layout.children.length : 0) - 1; // Minus the slot
        progress("layout", `Found shared layout with ${sharedCount} shared elements`);
        for (const [route, stripped] of layoutResult.strippedPages) {
          pageMap.set(route, stripped);
        }
      } else {
        progress("layout", "No shared layout detected");
      }
    }

    throwIfAborted(signal);
    const precomputedComponents = await maybeAiComponentize(
      pageMap,
      componentizeOptions,
      ai,
      progress,
    );

    throwIfAborted(signal);
    progress("emit", "Writing project...");
    const title = result.pages[0]?.title || new URL(url).hostname;
    const { files } = await emitMultiPageProject({
      outDir,
      title,
      sourceUrl: url,
      pages: pageMap,
      layout,
      breakpoints: result.breakpoints,
      componentizeOptions: precomputedComponents ? false : componentizeOptions,
      precomputedComponents,
      fontFaceRules: result.fontFaceRules.length > 0 ? result.fontFaceRules : undefined,
      fontRewriteMap: result.fontRewriteMap.size > 0 ? result.fontRewriteMap : undefined,
      styleTokens: result.styleTokens,
    });
    progress("emit", `Wrote ${files.length} files`);

    let verifySummary: ImportSiteResult["verify"] = null;
    if (verify !== false) {
      const verifyPages = new Map<string, { sourceUrl: string; screenshot: Buffer | string }>();
      for (const page of result.pages) {
        if (page.screenshot) {
          verifyPages.set(page.route, { sourceUrl: page.url, screenshot: page.screenshot });
        }
      }
      if (verifyPages.size === 0) {
        progress("verify", "No reference screenshots captured — skipping verify");
      } else {
        verifySummary = await runVerify(verifyPages);
      }
    }

    progress("done", `Imported ${url} → ${outDir}`);
    return {
      outDir,
      pages: result.pages.map((p) => ({
        route: p.route,
        title: p.title,
        nodeCount: p.jx.nodeCount,
      })),
      fileCount: files.length,
      verify: verifySummary,
      warnings,
    };
  }

  // ─── Phase 5: build + screenshot-diff against the original ─────────────────
  async function runVerify(
    verifyPages: Map<string, { sourceUrl: string; screenshot: Buffer | string }>,
    browser?: Browser,
  ): Promise<ImportSiteResult["verify"]> {
    throwIfAborted(signal);
    progress("verify", "Verifying against the original...");
    const { verifyProject } = await import("./verify.ts");
    const verifyResult = await verifyProject({
      projectDir: outDir,
      pages: verifyPages,
      threshold: verifyThreshold,
      onProgress: (msg) => progress("verify", msg),
      ...(browser === undefined ? {} : { browser }),
    });
    for (const page of verifyResult.pages) {
      const status = page.error ? `ERROR: ${page.error}` : `${page.fidelity}% fidelity`;
      progress("verify", `${page.route} — ${status}`);
    }
    progress("verify", `Average fidelity: ${verifyResult.averageFidelity}%`);
    return {
      averageFidelity: verifyResult.averageFidelity,
      reportDir: verifyResult.reportDir,
    };
  }
}
