/**
 * Programmatic import pipeline — the orchestrator behind both the jx-import CLI and the Studio
 * import endpoint. Runs the same phase sequence as the CLI (capture → styles → assets →
 * componentize → emit → verify), reporting progress through a callback instead of the console.
 */

import { existsSync, readdirSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { mkdir } from "node:fs/promises";
import { capturePage, closeBrowser, launchBrowser } from "./capture.ts";
import { convertToJx } from "./to-jx.ts";
import { emitMultiPageProject } from "./emit.ts";
import { captureStyles } from "./style-capture.ts";
import { extractMedia } from "./media-extract.ts";
import {
  DEFAULT_BREAKPOINT_POLICY,
  analyzeMediaQueries,
  planBreakpoints,
  skippedWidthQueries,
} from "./breakpoint-plan.ts";
import type { BreakpointPolicy } from "./breakpoint-plan.ts";
import { diffAllStyles, kebabToCamel } from "./style-diff.ts";
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
  /**
   * Which of the site's declared breakpoints the project keeps (default: three, evenly spaced).
   *
   * A real site declares as many breakpoints as it has accumulated frameworks; nine `$media`
   * entries is nine canvas sizes in Studio and nine columns in every style editor, and nobody
   * authors against that. See `breakpoint-plan.ts`.
   */
  breakpoints?: BreakpointPolicy;
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
  /**
   * Build + screenshot-diff the emitted project against the original; false to skip.
   *
   * `threshold` is pixelmatch's per-pixel COLOUR tolerance, not a bar; `minFidelity` is the bar,
   * and the run reports `passed` against it. `fullPage` compares the whole scrollable page (default
   * true) rather than the first viewport.
   */
  verify?: false | { threshold?: number; minFidelity?: number; fullPage?: boolean | undefined };
  /** Explicit browser binary (wins over CHROME_PATH and PATH discovery). */
  chromePath?: string;
  /** Aborts between phases (and between crawled pages). */
  signal?: AbortSignal;
}

export type ImportPhase =
  | "seed"
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
  /**
   * The project root, on the `seed` event alone.
   *
   * The destination exists and holds a valid `project.json` from that moment, which is what lets a
   * host OPEN it and watch the rest of the run land in its own file tree — rather than staring at a
   * welcome screen for the several minutes a crawl takes.
   */
  root?: string;
}

export interface ImportSiteResult {
  outDir: string;
  pages: { route: string; title: string; nodeCount: number }[];
  fileCount: number;
  verify: {
    averageFidelity: number;
    reportDir: string;
    /**
     * Whether the run met its bar — it built cleanly, every page rendered, and the average reached
     * `minFidelity`. Nothing about verify could fail before this existed: a clone scoring 8%
     * finished exactly like one scoring 95% (issue #232).
     */
    passed: boolean;
    /** The bar `passed` was measured against. */
    minFidelity: number;
    /** Errors the compiler reported building the project — recorded, and now also enforced. */
    buildErrors: string[];
    /**
     * Per page, because the average cannot name one.
     *
     * "Average fidelity 84%" is a fact nobody can act on; "the pricing page renders at 61%" is a
     * decision — retry it, patch it by hand, or accept it. The verifier computed both and only the
     * average was reported, so the actionable half was thrown away one level below the caller.
     *
     * The counts alongside it are what a percentage cannot say: a page that 404s on fifteen images
     * scores badly, and only `failedRequests` says why.
     */
    pages: {
      route: string;
      fidelity: number;
      consoleErrors: number;
      failedRequests: number;
      error?: string;
    }[];
  } | null;
  warnings: string[];
}

/**
 * The viewport the base capture runs at, and therefore the project's base width.
 *
 * It is `capture.ts`'s own default; naming it here is what lets the emitted `$media` carry a `"--"`
 * base entry that agrees with the styles actually sampled. Without one, Studio's canvas falls back
 * to 320px — narrower than every breakpoint an import discovers.
 */
const CAPTURE_WIDTH = 1440;

/** The one file the seed writes, and the only thing the empty-directory guard tolerates. */
const PROJECT_FILE = "project.json";

/** A placeholder project name from the URL, replaced by the page title at emit. */
function seedName(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "") || "Imported Site";
  } catch {
    return "Imported Site";
  }
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
    breakpoints: breakpointPolicy = DEFAULT_BREAKPOINT_POLICY,
  } = options;

  if (!url.startsWith("http://") && !url.startsWith("https://")) {
    throw new Error("URL must start with http:// or https://");
  }
  if (!isAbsolute(outDir)) {
    throw new Error(`outDir must be an absolute path, got "${outDir}"`);
  }
  /* The guard admits the run's OWN seed and nothing else. It has to: the destination is created and
     given a `project.json` before the browser launches, so a host can open the project and watch the
     rest of the run arrive in its file tree — and a guard that could not tell that seed from a
     stranger's files would refuse every import at its second statement. */
  if (existsSync(outDir) && readdirSync(outDir).some((entry) => entry !== PROJECT_FILE)) {
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
  const verifyMinFidelity = verify === false ? 0 : (verify.minFidelity ?? 0);
  const verifyFullPage = verify === false ? true : (verify.fullPage ?? true);

  try {
    await seedProject();
    if (maxDepth === 0) {
      return await runSinglePage();
    }
    return await runCrawl();
  } finally {
    await closeBrowser();
  }

  /**
   * Create the destination and give it a `project.json` valid enough to open.
   *
   * The emit phase rewrites this file completely, so nothing here is a guess at what the import
   * will find — it is the minimum that makes the directory a PROJECT, so the caller can open it now
   * instead of at the end. Everything a crawl writes then lands in a file tree somebody is
   * watching.
   */
  async function seedProject(): Promise<void> {
    await mkdir(outDir, { recursive: true });
    const seed = { name: seedName(url), imports: {}, images: { optimize: false } };
    await Bun.write(join(outDir, PROJECT_FILE), `${JSON.stringify(seed, null, 2)}\n`);
    onProgress?.({
      message: `Created ${outDir}`,
      phase: "seed",
      root: outDir,
    });
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
        reportBreakpointPlan(styleResult.mediaQueries);
        const media = await extractMedia(
          capture.page,
          styleResult.elements,
          styleResult.uaDefaults,
          styleResult.mediaQueries,
          { policy: breakpointPolicy },
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
      referenceScreenshot = await captureReferenceScreenshot(
        capture.page,
        undefined,
        undefined,
        verifyFullPage,
      );
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
    const { files, classesStripped } = await emitMultiPageProject({
      outDir,
      title: capture.title,
      pages: pageMap,
      sourceUrl: url,
      breakpoints,
      baseWidth: CAPTURE_WIDTH,
      componentizeOptions: precomputedComponents ? false : componentizeOptions,
      precomputedComponents,
      fontFaceRules,
      fontRewriteMap,
      styleTokens,
    });
    reportEmit(files.length, classesStripped);

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
      // The reference and the render must be framed the same way, or the diff pads one of them.
      fullPageScreenshots: verifyFullPage,
      breakpoints: breakpointPolicy,
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
    const { files, classesStripped } = await emitMultiPageProject({
      outDir,
      title,
      sourceUrl: url,
      pages: pageMap,
      layout,
      breakpoints: result.breakpoints,
      baseWidth: CAPTURE_WIDTH,
      componentizeOptions: precomputedComponents ? false : componentizeOptions,
      precomputedComponents,
      fontFaceRules: result.fontFaceRules.length > 0 ? result.fontFaceRules : undefined,
      fontRewriteMap: result.fontRewriteMap.size > 0 ? result.fontRewriteMap : undefined,
      styleTokens: result.styleTokens,
    });
    reportEmit(files.length, classesStripped);

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

  /** One emit line, naming what the strip pass removed — silence would read as "nothing to do". */
  function reportEmit(fileCount: number, classesStripped: number): void {
    const classes =
      classesStripped > 0
        ? `, stripped ${classesStripped} source class name${classesStripped === 1 ? "" : "s"}`
        : "";
    progress("emit", `Wrote ${fileCount} files${classes}`);
  }

  /**
   * Say which breakpoints the project is getting, and where the others went.
   *
   * The plan is a decision made ON THE AUTHOR'S BEHALF — nine declared widths become three — so it
   * has to be visible. "9 breakpoints found, keeping 3" with the fold spelled out is the difference
   * between a project that mysteriously has different breakpoints from its source and one whose
   * import said so at the time.
   */
  function reportBreakpointPlan(mediaQueries: readonly string[]): void {
    const skipped = skippedWidthQueries(mediaQueries);
    if (skipped.length > 0) {
      warn(
        "styles",
        `${skipped.length} width media ${skipped.length === 1 ? "query" : "queries"} could not be ` +
          `read (only single-clause px min-width/max-width is supported): ${skipped.join(", ")}`,
      );
    }
    const discovered = analyzeMediaQueries(mediaQueries);
    if (discovered.length === 0) {
      return;
    }
    const { keep, fold } = planBreakpoints(discovered, breakpointPolicy);
    if (keep.length === discovered.length) {
      progress("styles", `Keeping all ${keep.length} declared breakpoints`);
      return;
    }
    const folded = new Map<string, string[]>();
    for (const [from, to] of fold) {
      if (from === to) {
        continue;
      }
      folded.set(to, [...(folded.get(to) ?? []), from.replace(/^--/, "")]);
    }
    const detail = keep
      .map((bp) => {
        const into = folded.get(bp.name) ?? [];
        return into.length > 0 ? `${bp.name} (+${into.join(", ")})` : bp.name;
      })
      .join(", ");
    progress(
      "styles",
      `${discovered.length} breakpoints declared, keeping ${keep.length}: ${detail}`,
    );
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
      minFidelity: verifyMinFidelity,
      fullPage: verifyFullPage,
      onProgress: (msg) => progress("verify", msg),
      ...(browser === undefined ? {} : { browser }),
    });
    /*
     * Build errors were logged inside the verifier and dropped there. They are warnings on the
     * import as a whole: a project that did not compile is not a clone of anything, however the
     * pixels happen to score.
     */
    for (const error of verifyResult.buildErrors) {
      warn("verify", `Build error: ${error}`);
    }
    for (const page of verifyResult.pages) {
      const status = page.error ? `ERROR: ${page.error}` : `${page.fidelity}% fidelity`;
      const misses =
        page.failedRequests.length > 0 ? `, ${page.failedRequests.length} failed request(s)` : "";
      progress("verify", `${page.route} — ${status}${misses}`);
    }
    progress("verify", `Average fidelity: ${verifyResult.averageFidelity}%`);
    if (!verifyResult.passed) {
      warn(
        "verify",
        `Verification failed: average fidelity ${verifyResult.averageFidelity}% ` +
          `(minimum ${verifyMinFidelity}%). See ${verifyResult.reportDir}/report.json`,
      );
    }
    return {
      averageFidelity: verifyResult.averageFidelity,
      reportDir: verifyResult.reportDir,
      passed: verifyResult.passed,
      minFidelity: verifyMinFidelity,
      buildErrors: verifyResult.buildErrors,
      pages: verifyResult.pages.map((page) => {
        const entry: {
          route: string;
          fidelity: number;
          consoleErrors: number;
          failedRequests: number;
          error?: string;
        } = {
          route: page.route,
          fidelity: page.fidelity,
          consoleErrors: page.consoleErrors.length,
          failedRequests: page.failedRequests.length,
        };
        if (page.error !== undefined) {
          entry.error = page.error;
        }
        return entry;
      }),
    };
  }
}
