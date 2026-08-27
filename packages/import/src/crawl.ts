import { launchBrowser, capturePage } from "./capture.ts";
import type { CaptureResult } from "./capture.ts";
import { convertToJx } from "./to-jx.ts";
import type { ToJxResult } from "./to-jx.ts";
import { captureStyles } from "./style-capture.ts";
import { diffAllStyles, kebabToCamel } from "./style-diff.ts";
import { extractMedia } from "./media-extract.ts";
import {
  DEFAULT_BREAKPOINT_POLICY,
  analyzeMediaQueries,
  planBreakpoints,
} from "./breakpoint-plan.ts";
import type { Breakpoint, BreakpointPolicy } from "./breakpoint-plan.ts";
import { applyStylesToTree } from "./apply-styles.ts";
import { collectAssets } from "./asset-collect.ts";
import { downloadAssets } from "./asset-download.ts";
import { rewriteAssetUrls } from "./asset-rewrite.ts";
import { applyTokens } from "./css-tokens.ts";

export interface CrawlOptions {
  url: string;
  outDir: string;
  maxDepth: number;
  maxPages: number;
  maxNodesPerPage: number;
  skipStyles: boolean;
  skipAssets: boolean;
  respectRobots: boolean;
  /** Skip scroll-to-bottom before capture (default: false). */
  noScroll?: boolean;
  /** Capture a reference screenshot of each page before closing (for --verify). */
  captureScreenshots?: boolean;
  /**
   * Capture the whole scrollable page rather than the viewport (default true).
   *
   * It has to agree with what `verifyProject` screenshots on the other side. A viewport reference
   * diffed against a full-page render is compared by padding the shorter image, so the two would
   * disagree over everything below the fold before a single style was compared.
   */
  fullPageScreenshots?: boolean;
  /** Which of the site's declared breakpoints the project keeps (see `breakpoint-plan.ts`). */
  breakpoints?: BreakpointPolicy | undefined;
  onProgress?: (msg: string) => void;
  /** Abort the crawl between pages; the loop throws before capturing the next page. */
  signal?: AbortSignal;
}

export interface CrawledPage {
  url: string;
  route: string;
  title: string;
  jx: ToJxResult;
  depth: number;
  links: string[];
  /** Reference screenshot PNG buffer, present when captureScreenshots is true. */
  screenshot?: Buffer | undefined;
}

export interface CrawlResult {
  pages: CrawledPage[];
  breakpoints: Record<string, string> | undefined;
  skippedByRobots: string[];
  skippedByNodeCap: string[];
  /** Collected @font-face rules from all pages (R2). */
  fontFaceRules: string[];
  /** Font URL → local path rewrite map (R2). */
  fontRewriteMap: Map<string, string>;
  /** CSS custom property tokens merged across all pages (R5). */
  styleTokens: Record<string, string> | undefined;
}

/**
 * Normalize a URL for deduplication: strip hash, trailing slash, tracking params, sort remaining
 * params.
 */
export function normalizeUrl(raw: string): string {
  try {
    const u = new URL(raw);
    u.hash = "";

    const TRACKING_PARAMS = new Set([
      "utm_source",
      "utm_medium",
      "utm_campaign",
      "utm_term",
      "utm_content",
      "ref",
      "fbclid",
      "gclid",
      "mc_cid",
      "mc_eid",
    ]);
    for (const p of TRACKING_PARAMS) {
      u.searchParams.delete(p);
    }

    u.searchParams.sort();

    let path = u.pathname;
    if (path.length > 1 && path.endsWith("/")) {
      path = path.slice(0, -1);
    }
    u.pathname = path;

    return u.toString();
  } catch {
    return raw;
  }
}

/**
 * Convert a URL path to a Jx page file path under pages/. / → pages/index.json /about →
 * pages/about.json /blog/post → pages/blog/post.json
 */
export function routeToFilePath(url: string, _baseOrigin?: string): string {
  const u = new URL(url);
  let path = u.pathname;

  if (path.length > 1 && path.endsWith("/")) {
    path = path.slice(0, -1);
  }

  if (path === "" || path === "/") {
    return "pages/index.json";
  }

  // Remove leading slash, sanitize segments
  const segments = path
    .slice(1)
    .split("/")
    .map((s) => s.replaceAll(/[^a-zA-Z0-9._-]/g, "_"));

  // If the last segment has an extension (like .html), strip it
  const last = segments.at(-1)!;
  const dotIdx = last.lastIndexOf(".");
  if (dotIdx > 0) {
    segments[segments.length - 1] = last.slice(0, dotIdx);
  }

  return `pages/${segments.join("/")}.json`;
}

/** Fetch and parse robots.txt for a given origin. Returns a set of disallowed path prefixes. */
export async function fetchRobotsTxt(origin: string): Promise<Set<string>> {
  const disallowed = new Set<string>();
  try {
    const res = await fetch(`${origin}/robots.txt`);
    if (!res.ok) {
      return disallowed;
    }

    const text = await res.text();
    let inUserAgent = false;
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.startsWith("#") || trimmed === "") {
        continue;
      }

      if (trimmed.toLowerCase().startsWith("user-agent:")) {
        const agent = trimmed.slice("user-agent:".length).trim();
        inUserAgent = agent === "*";
      } else if (inUserAgent && trimmed.toLowerCase().startsWith("disallow:")) {
        const path = trimmed.slice("disallow:".length).trim();
        if (path) {
          disallowed.add(path);
        }
      }
    }
  } catch {
    // Robots.txt unavailable — allow everything
  }
  return disallowed;
}

function isDisallowed(url: string, disallowedPaths: Set<string>): boolean {
  const path = new URL(url).pathname;
  for (const prefix of disallowedPaths) {
    if (path.startsWith(prefix)) {
      return true;
    }
  }
  return false;
}

/** BFS crawl a site starting from `url`. Captures each page, converts to Jx, applies styles/assets. */
export async function crawlSite(options: CrawlOptions): Promise<CrawlResult> {
  const {
    url,
    outDir,
    maxDepth,
    maxPages,
    maxNodesPerPage,
    skipStyles,
    skipAssets,
    respectRobots,
    fullPageScreenshots = true,
    onProgress = console.log,
  } = options;

  const { origin } = new URL(url);
  const browser = await launchBrowser();

  // Fetch robots.txt
  let disallowedPaths = new Set<string>();
  if (respectRobots) {
    onProgress("  Fetching robots.txt...");
    disallowedPaths = await fetchRobotsTxt(origin);
    if (disallowedPaths.size > 0) {
      onProgress(`  robots.txt: ${disallowedPaths.size} disallowed paths`);
    }
  }

  const visited = new Set<string>();
  const queue: { url: string; depth: number }[] = [{ url: normalizeUrl(url), depth: 0 }];
  visited.add(normalizeUrl(url));

  const pages: CrawledPage[] = [];
  const skippedByRobots: string[] = [];
  const skippedByNodeCap: string[] = [];
  let mergedBreakpoints: Record<string, string> | undefined;
  /* Decided on the first page that declares a width query, then reused. See ExtractMediaOptions.plan
     — a per-page plan would union back up to the count the policy just refused. */
  let breakpointPlan: Breakpoint[] | undefined;
  let mergedTokens: Record<string, string> | undefined;
  const allFontFaceRules: string[] = [];
  const fontRewriteMap = new Map<string, string>();
  const seenFontRules = new Set<string>();

  while (queue.length > 0 && pages.length < maxPages) {
    if (options.signal?.aborted) {
      throw new Error("Import aborted");
    }
    const entry = queue.shift()!;

    if (respectRobots && isDisallowed(entry.url, disallowedPaths)) {
      skippedByRobots.push(entry.url);
      onProgress(`  Skipped (robots.txt): ${entry.url}`);
      continue;
    }

    onProgress(
      `  [${pages.length + 1}/${maxPages}] Capturing ${entry.url} (depth ${entry.depth})...`,
    );

    let capture: CaptureResult;
    try {
      capture = await capturePage(entry.url, browser, { scrollToBottom: !options.noScroll });
    } catch (error) {
      onProgress(
        `  ⚠ Failed to capture ${entry.url}: ${error instanceof Error ? error.message : error}`,
      );
      continue;
    }

    const jx = convertToJx(capture.bodyHtml);
    onProgress(`  Converted: ${jx.nodeCount} nodes`);

    if (jx.nodeCount > maxNodesPerPage) {
      onProgress(
        `  ⚠ Page exceeds node cap (${jx.nodeCount} > ${maxNodesPerPage}), skipping styles/assets`,
      );
      skippedByNodeCap.push(entry.url);
      let screenshot: Buffer | undefined;
      if (options.captureScreenshots) {
        screenshot = Buffer.from(
          await capture.page.screenshot({ fullPage: fullPageScreenshots, type: "png" }),
        );
      }
      await capture.page.close();

      pages.push({
        url: entry.url,
        route: routeToFilePath(entry.url, origin),
        title: capture.title,
        jx,
        depth: entry.depth,
        links: capture.links,
        screenshot,
      });
      continue;
    }

    // Style capture (Phase 1)
    if (!skipStyles) {
      try {
        const styleResult = await captureStyles(capture.page);
        const diffed = diffAllStyles(styleResult.elements, styleResult.uaDefaults);

        // R5: Replace resolved values with var(--name) references
        if (Object.keys(styleResult.customProperties).length > 0) {
          const tokenResult = applyTokens(diffed, styleResult.customProperties);
          if (tokenResult.replacements > 0) {
            if (!mergedTokens) {
              mergedTokens = {};
            }
            Object.assign(mergedTokens, tokenResult.tokens);
          }
        }

        if (styleResult.mediaQueries.length > 0) {
          if (!breakpointPlan) {
            const declared = analyzeMediaQueries(styleResult.mediaQueries);
            breakpointPlan = planBreakpoints(
              declared,
              options.breakpoints ?? DEFAULT_BREAKPOINT_POLICY,
            ).keep;
            if (breakpointPlan.length < declared.length) {
              onProgress?.(
                `  ${declared.length} breakpoints declared, keeping ` +
                  `${breakpointPlan.length}: ${breakpointPlan.map((b) => b.name).join(", ")}\n`,
              );
            }
          }
          const media = await extractMedia(
            capture.page,
            styleResult.elements,
            styleResult.uaDefaults,
            styleResult.mediaQueries,
            { plan: breakpointPlan },
          );
          const bpCount = Object.keys(media.breakpoints).length;
          if (bpCount > 0) {
            if (!mergedBreakpoints) {
              mergedBreakpoints = {};
            }
            Object.assign(mergedBreakpoints, media.breakpoints);
            applyStylesToTree(jx.document, diffed, media.deltas);
          } else {
            applyStylesToTree(jx.document, diffed);
          }
        } else {
          applyStylesToTree(jx.document, diffed);
        }

        // Apply <html>/<body> computed styles to the root wrapper
        if (Object.keys(styleResult.documentStyles).length > 0) {
          if (!jx.document.style) {
            jx.document.style = {};
          }
          for (const [prop, val] of Object.entries(styleResult.documentStyles)) {
            jx.document.style[kebabToCamel(prop)] = val;
          }
        }
      } catch (error) {
        onProgress(`  ⚠ Style capture failed: ${error instanceof Error ? error.message : error}`);
      }
    }

    // Asset download (Phase 2)
    if (!skipAssets) {
      try {
        const collected = await collectAssets(capture.page);

        // Accumulate @font-face rules (R2) — dedupe across pages
        for (const sheet of collected.stylesheets) {
          for (const rule of sheet.fontFaceRules) {
            if (!seenFontRules.has(rule)) {
              seenFontRules.add(rule);
              allFontFaceRules.push(rule);
            }
          }
        }

        if (collected.assets.length > 0) {
          const downloaded = await downloadAssets(collected.assets, outDir, entry.url);
          if (downloaded.rewriteMap.size > 0) {
            rewriteAssetUrls(jx.document, downloaded.rewriteMap, entry.url);
            // Collect font rewrites (R2)
            for (const [originalUrl, localPath] of downloaded.rewriteMap) {
              if (localPath.includes("/fonts/") || /\.(woff2?|ttf|otf|eot)$/i.test(localPath)) {
                fontRewriteMap.set(originalUrl, localPath);
              }
            }
          }
        }
      } catch (error) {
        onProgress(
          `  ⚠ Asset collection failed: ${error instanceof Error ? error.message : error}`,
        );
      }
    }

    let screenshot: Buffer | undefined;
    if (options.captureScreenshots) {
      screenshot = Buffer.from(
        await capture.page.screenshot({ fullPage: fullPageScreenshots, type: "png" }),
      );
    }
    await capture.page.close();

    const route = routeToFilePath(entry.url, origin);
    pages.push({
      url: entry.url,
      route,
      title: capture.title,
      jx,
      depth: entry.depth,
      links: capture.links,
      screenshot,
    });

    // Enqueue discovered links (BFS)
    if (entry.depth < maxDepth) {
      for (const link of capture.links) {
        const normalized = normalizeUrl(link);
        if (!normalized.startsWith(origin)) {
          continue;
        }
        if (visited.has(normalized)) {
          continue;
        }

        visited.add(normalized);
        queue.push({ url: normalized, depth: entry.depth + 1 });
      }
    }
  }

  return {
    pages,
    breakpoints: mergedBreakpoints,
    skippedByRobots,
    skippedByNodeCap,
    fontFaceRules: allFontFaceRules,
    fontRewriteMap,
    styleTokens: mergedTokens,
  };
}
