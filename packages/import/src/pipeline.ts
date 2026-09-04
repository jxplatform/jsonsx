/**
 * The import pipeline: capture → styles → assets → layout → componentize → emit.
 *
 * Everything here is portable. It takes the browser it drives and the sink it writes to as
 * parameters, and it touches nothing else — no `node:fs`, no `Bun.*`, no `process.env`, and no
 * VALUE import of `puppeteer-core` anywhere in its graph. That last one is the reason the module
 * exists: a Worker bundler follows value imports transitively, `puppeteer-core` cannot load in
 * workerd, and the phases had it in reach through `capture.ts`. Type-only imports are erased, so
 * they are fine.
 *
 * Two things are deliberately NOT here. Verification builds the project with `@jxsuite/compiler`
 * and serves it over `Bun.serve` to screenshot it — it executes the project's own JavaScript, which
 * a hosted platform never does — so it stays a local phase, in `run.ts`. And the empty-directory
 * guard and the `project.json` seed are filesystem questions, which is the same answer.
 */

import { capturePage } from "./capture.ts";
import type { ImportBrowser, ImportPage } from "./capture.ts";
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
import { applyFamilyAliases, planImageFamilies } from "./image-family.ts";
import { rewriteAssetUrls } from "./asset-rewrite.ts";
import { applyTokens } from "./css-tokens.ts";
import { crawlSite } from "./crawl.ts";
import { detectLayout } from "./layout-detect.ts";
import { applyAccordions } from "./apply-accordions.ts";
import { applyPopovers } from "./apply-popovers.ts";
import { applyDisclosures } from "./apply-disclosures.ts";
import type { ImportIo } from "./io.ts";
import type { JxElement } from "@jxsuite/schema/types";
import type { ComponentizeResult } from "./componentize.ts";

export type { ImportIo } from "./io.ts";
export type { ImportBrowser, ImportPage } from "./capture.ts";

export interface ImportPipelineOptions {
  /** The page to import; must be http(s). */
  url: string;
  /** The browser to drive. Anything providing `newPage` — a local Chrome, a remote session. */
  browser: ImportBrowser;
  /** Where every emitted file and downloaded asset goes. */
  io: ImportIo;
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
  /**
   * LLM refinement of component/prop names; false/undefined to skip.
   *
   * `model` is required here for the reason `AiComponentizeOptions` gives: a default openai model
   * id is a 404 on any other provider, and the caller is the one that knows which it is talking
   * to.
   */
  ai?: false | { apiKey: string; baseUrl?: string | undefined; model: string };
  /**
   * Screenshot each captured page and return the bytes; false to skip (default false).
   *
   * The pipeline never diffs them — that is `verify.ts`, which is local-only. It captures them
   * because they can only be taken while the ORIGINAL page is still open, which is inside here.
   */
  referenceScreenshots?: false | { fullPage?: boolean };
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
  | "convert"
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
   * welcome screen for the several minutes a crawl takes. Only a caller that HAS a root emits it;
   * the pipeline does not know whether it is writing to one.
   */
  root?: string;
}

export interface ImportPipelineResult {
  pages: { route: string; title: string; nodeCount: number }[];
  /** Project-relative paths of every file the emit phase wrote. */
  files: string[];
  /** The emitted `project.json` text, so a caller with no filesystem need not read it back. */
  projectJson: string;
  /**
   * Reference screenshots by route, when `referenceScreenshots` asked for them.
   *
   * Empty otherwise, and possibly empty even then — a crawl that captured nothing renderable has
   * nothing to verify against, which is a real outcome rather than an error.
   */
  references: Map<string, { sourceUrl: string; screenshot: Uint8Array }>;
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

/** The height the reference screenshot is framed at before a full-page capture expands it. */
const CAPTURE_HEIGHT = 900;

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
 * Frame and shoot the original page.
 *
 * Inlined rather than reached for in `verify.ts`, which is where the equivalent used to live: that
 * module builds and serves the project, so importing it for two calls would have put a compiler and
 * `Bun.serve` in the pipeline's graph.
 */
async function captureReference(page: ImportPage, fullPage: boolean): Promise<Uint8Array> {
  await page.setViewport({ width: CAPTURE_WIDTH, height: CAPTURE_HEIGHT });
  return page.screenshot({ fullPage, type: "png" });
}

/**
 * Run the heuristic componentize pass and refine it with the LLM. Returns undefined when the AI
 * pass is off, componentization is disabled, or the heuristic found nothing (the emit step then
 * runs its own heuristic pass as usual).
 */
async function maybeAiComponentize(
  pageMap: Map<string, JxElement>,
  componentizeOptions: false | { minInstances?: number; minDepth?: number },
  ai: ImportPipelineOptions["ai"],
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
 * Import a live website into a Jx project, writing every file through `io`.
 *
 * @param {ImportPipelineOptions} options
 * @param {(e: ImportProgressEvent) => void} [onProgress]
 */
export async function runImportPipeline(
  options: ImportPipelineOptions,
  onProgress?: (e: ImportProgressEvent) => void,
): Promise<ImportPipelineResult> {
  const {
    url,
    browser,
    io,
    maxDepth = 2,
    maxPages = 25,
    maxNodesPerPage = 5000,
    styles = true,
    assets = true,
    scroll = true,
    respectRobots = true,
    componentize: componentizeOptions = {},
    ai = false,
    referenceScreenshots = false,
    signal,
    breakpoints: breakpointPolicy = DEFAULT_BREAKPOINT_POLICY,
  } = options;

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
  const referenceFullPage =
    referenceScreenshots === false ? true : (referenceScreenshots.fullPage ?? true);

  return maxDepth === 0 ? runSinglePage() : runCrawl();

  // ─── Single-page mode: Phase 0-2 pipeline, no crawl overhead ────────────────
  async function runSinglePage(): Promise<ImportPipelineResult> {
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
          applyStylesToTree(jx.document, diffed, media.deltas, media.breakpoints);
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
        /* One member per responsive family reaches the network; every dropped derivative is
           aliased onto the file that WAS written, so a reference to any rung of the ladder still
           resolves. The compiler regenerates the sizes from the original it now owns. */
        const families = planImageFamilies(collected.assets);
        const downloaded = await downloadAssets(families.keep, io, url);
        applyFamilyAliases(downloaded.rewriteMap, families.alias);
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

    // The reference has to be taken before the page closes — that is the whole reason it is here.
    const references = new Map<string, { sourceUrl: string; screenshot: Uint8Array }>();
    if (referenceScreenshots !== false) {
      progress("verify", "Capturing reference screenshot...");
      references.set("pages/index.json", {
        sourceUrl: url,
        screenshot: await captureReference(capture.page, referenceFullPage),
      });
    }

    await capture.page.close();

    throwIfAborted(signal);
    /* Widgets become native markup BEFORE layout detection, which replaces the pages it extracts a
       layout from - a pass after it would see the site's widgets in neither half. */
    const singleConverted = applyAccordions(jx.document);
    const singleDisclosures = applyDisclosures(jx.document);
    if (singleDisclosures.converted > 0) {
      progress(
        "convert",
        `Converted ${singleDisclosures.converted} disclosure${singleDisclosures.converted === 1 ? "" : "s"} to native <details>`,
      );
    }
    const singleOverlays = applyPopovers(jx.document);
    if (singleOverlays.converted > 0) {
      progress(
        "convert",
        `Converted ${singleOverlays.converted} dropdown${singleOverlays.converted === 1 ? "" : "s"} to popovers`,
      );
    }
    if (singleConverted.converted > 0) {
      progress(
        "convert",
        `Converted ${singleConverted.converted} accordion${singleConverted.converted === 1 ? "" : "s"} ` +
          `(${singleConverted.rows} rows) to native <details>`,
      );
    }

    const pageMap = new Map([["pages/index.json", jx.document]]);
    const precomputedComponents = await maybeAiComponentize(
      pageMap,
      componentizeOptions,
      ai,
      progress,
    );

    throwIfAborted(signal);
    progress("emit", "Writing project...");
    const emitted = await emitMultiPageProject({
      io,
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
    reportEmit(emitted.files.length, emitted.classesStripped);

    return {
      pages: [{ route: "pages/index.json", title: capture.title, nodeCount: jx.nodeCount }],
      files: emitted.files,
      projectJson: emitted.projectJson,
      references,
      warnings,
    };
  }

  // ─── Multi-page crawl mode (Phase 3) ────────────────────────────────────────
  async function runCrawl(): Promise<ImportPipelineResult> {
    throwIfAborted(signal);
    const result = await crawlSite({
      url,
      browser,
      io,
      maxDepth,
      maxPages,
      maxNodesPerPage,
      skipStyles: !styles,
      skipAssets: !assets,
      respectRobots,
      noScroll: !scroll,
      captureScreenshots: referenceScreenshots !== false,
      // The reference and the render must be framed the same way, or the diff pads one of them.
      fullPageScreenshots: referenceFullPage,
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

    /* Widgets become native markup BEFORE layout detection, which replaces the pages it extracts a
       layout from - a pass after it would see the site's widgets in neither half. */
    let convertedWidgets = 0;
    let convertedRows = 0;
    let convertedOverlays = 0;
    let convertedDisclosures = 0;
    for (const document of pageMap.values()) {
      const converted = applyAccordions(document);
      convertedWidgets += converted.converted;
      convertedRows += converted.rows;
      convertedDisclosures += applyDisclosures(document).converted;
      convertedOverlays += applyPopovers(document).converted;
    }
    if (convertedDisclosures > 0) {
      progress(
        "convert",
        `Converted ${convertedDisclosures} disclosure${convertedDisclosures === 1 ? "" : "s"} to native <details>`,
      );
    }
    if (convertedOverlays > 0) {
      progress(
        "convert",
        `Converted ${convertedOverlays} dropdown${convertedOverlays === 1 ? "" : "s"} to popovers`,
      );
    }
    if (convertedWidgets > 0) {
      progress(
        "convert",
        `Converted ${convertedWidgets} accordion${convertedWidgets === 1 ? "" : "s"} ` +
          `(${convertedRows} rows) to native <details>`,
      );
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
    const emitted = await emitMultiPageProject({
      io,
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
    reportEmit(emitted.files.length, emitted.classesStripped);

    const references = new Map<string, { sourceUrl: string; screenshot: Uint8Array }>();
    for (const page of result.pages) {
      if (page.screenshot) {
        references.set(page.route, { sourceUrl: page.url, screenshot: page.screenshot });
      }
    }

    return {
      pages: result.pages.map((p) => ({
        route: p.route,
        title: p.title,
        nodeCount: p.jx.nodeCount,
      })),
      files: emitted.files,
      projectJson: emitted.projectJson,
      references,
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
}
