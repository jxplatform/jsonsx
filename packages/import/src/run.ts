/**
 * The local import — the orchestrator behind both the jx-import CLI and the Studio import endpoint.
 *
 * Everything portable moved to `pipeline.ts`. What is left is what only a machine with a disk and a
 * Chrome can do: the empty-directory guard, the `project.json` seed, the local write sink, the
 * browser launch, and the verify phase (which builds the project with `@jxsuite/compiler` and
 * serves it over `Bun.serve` to screenshot it — a hosted platform never executes a project's own
 * JavaScript, so verification does not follow the pipeline anywhere).
 */

import { existsSync, readdirSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { mkdir } from "node:fs/promises";
import { closeBrowser, launchBrowser } from "./browser-local.ts";
import { createLocalIo } from "./io.ts";
import { runImportPipeline } from "./pipeline.ts";
import type { BreakpointPolicy } from "./breakpoint-plan.ts";
import type { ImportPhase, ImportProgressEvent } from "./pipeline.ts";
import type { Browser } from "puppeteer-core";

export type { ImportPhase, ImportProgressEvent } from "./pipeline.ts";

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
 * What the CLI and the OSS server ask for when the caller named no model.
 *
 * It lives at the call site rather than inside `ai-componentize.ts`, because a default belongs to
 * whoever knows the provider. This path talks to an OpenAI-compatible endpoint; a backend brokering
 * Workers AI would 404 on this id, which is exactly why the module below it demands one.
 */
const DEFAULT_AI_MODEL = "gpt-4o-mini";

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
  const { url, outDir, maxDepth = 2, ai = false, verify = false, chromePath, signal } = options;

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

  const progress = (phase: ImportPhase, message: string) => {
    onProgress?.({ phase, message });
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

    progress("launch", "Launching browser...");
    const browser = await launchBrowser(
      chromePath === undefined ? {} : { executablePath: chromePath },
    );

    const result = await runImportPipeline(
      {
        url,
        browser,
        io: createLocalIo(outDir),
        maxDepth,
        /* The model default is applied here so the pipeline can require one. See DEFAULT_AI_MODEL. */
        ai: ai === false ? false : { ...ai, model: ai.model ?? DEFAULT_AI_MODEL },
        referenceScreenshots: verify === false ? false : { fullPage: verifyFullPage },
        ...pick(options, [
          "maxPages",
          "maxNodesPerPage",
          "breakpoints",
          "styles",
          "assets",
          "scroll",
          "respectRobots",
          "componentize",
          "signal",
        ]),
      },
      onProgress,
    );
    warnings.push(...result.warnings);

    let verifySummary: ImportSiteResult["verify"] = null;
    if (verify !== false) {
      if (result.references.size === 0) {
        progress("verify", "No reference screenshots captured — skipping verify");
      } else {
        /* Only the single-page run hands the verifier its browser. A crawl's pages were captured
           and closed one at a time, so by now the connection has outlived every page it opened and
           `verifyProject` launching its own is the same cost either way. */
        verifySummary = await runVerify(result.references, maxDepth === 0 ? browser : undefined);
      }
    }

    progress("done", `Imported ${url} → ${outDir}`);
    return {
      outDir,
      pages: result.pages,
      fileCount: result.files.length,
      verify: verifySummary,
      warnings,
    };
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

  // ─── Phase 5: build + screenshot-diff against the original ─────────────────
  async function runVerify(
    references: Map<string, { sourceUrl: string; screenshot: Uint8Array }>,
    browser?: Browser,
  ): Promise<ImportSiteResult["verify"]> {
    throwIfAborted(signal);
    progress("verify", "Verifying against the original...");
    const { verifyProject } = await import("./verify.ts");
    const verifyPages = new Map<string, { sourceUrl: string; screenshot: Buffer | string }>();
    for (const [route, ref] of references) {
      verifyPages.set(route, { sourceUrl: ref.sourceUrl, screenshot: Buffer.from(ref.screenshot) });
    }
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

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new Error("Import aborted");
  }
}

/**
 * Forward the options this wrapper shares with the pipeline, and only the ones actually given.
 *
 * `exactOptionalPropertyTypes` is on, so `{ signal: undefined }` is a different thing from an
 * absent `signal` and the pipeline would reject it. Copying present keys is also what keeps every
 * default in ONE place — restating `maxPages = 25` here is how the CLI and the cloud drift apart.
 */
function pick<T extends object, K extends keyof T>(source: T, keys: readonly K[]): Pick<T, K> {
  const out = {} as Pick<T, K>;
  for (const key of keys) {
    if (source[key] !== undefined) {
      out[key] = source[key];
    }
  }
  return out;
}
