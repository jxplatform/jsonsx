/**
 * Import-api.ts — the AI-guided site-import endpoint for Jx Studio.
 *
 * Handles POST /__studio/import-site: runs @jxsuite/import's importSite pipeline in the backend
 * (headless Chrome + filesystem) and streams progress back as NDJSON lines over the POST response —
 * the same streaming-fetch transport the AI chat proxy uses, so every platform (dev server,
 * Electrobun services server, Chromium loopback server) can mount it unchanged.
 *
 * Stream protocol (one JSON object per line):
 *   {"type":"progress","phase":"...","message":"...","current":n,"total":n}
 *   {"type":"heartbeat"}                       — keep-alives during silent phases
 *   {"type":"done","root":"...","config":{…},"result":{…}}  — terminal success
 *   {"type":"error","error":"..."}             — terminal failure
 *
 * LLM key flow (matches ai-api.ts): X-Api-Key / Authorization: Bearer header, falling back to the
 * OPENAI_API_KEY env var; base URL from X-Api-Base-URL / OPENAI_BASE_URL. When AI component naming
 * is requested but no key resolves, the import proceeds without the AI pass and emits a warning
 * line instead of failing.
 *
 * @license MIT
 */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { problem } from "./problem.ts";

export interface ImportApiOptions {
  /**
   * Validate and absolutize the request's destination directory. Must throw for paths the host does
   * not allow (the endpoint writes files and drives a browser — never pass through unchecked).
   */
  resolveDest: (directory: string) => string;
  /** Map the final absolute project dir onto the platform's project-root form (default identity). */
  toRoot?: (destPath: string) => string;
  /** Explicit browser binary for puppeteer (e.g. the desktop launcher's discovered Chromium). */
  chromePath?: string;
}

interface ImportRequestBody {
  url?: string;
  directory?: string;
  depth?: number;
  maxPages?: number;
  maxNodesPerPage?: number;
  aiComponents?: boolean;
  aiModel?: string;
  verify?: boolean;
  verifyThreshold?: number;
  verifyMinFidelity?: number;
}

/** Seconds between keep-alive lines while a phase is silent (browser launch is the longest gap). */
const HEARTBEAT_INTERVAL_MS = 15_000;

const MAX_DEPTH = 5;
const MAX_PAGES = 100;

/** Pixelmatch colour-tolerance bounds for the optional verify pass. */
const MIN_THRESHOLD = 0.01;
const MAX_THRESHOLD = 1;

/**
 * The fidelity bar's bounds, as a percentage.
 *
 * `0` is a legal answer and means "report only", which is what this transport did before the bar
 * existed — so the floor here is 0 rather than the CLI's default of 25.
 */
const MIN_FIDELITY_FLOOR = 0;
const MIN_FIDELITY_CEILING = 100;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function getAiConfig(req: Request): { apiKey: string | null; baseUrl: string | undefined } {
  const authHeader = req.headers.get("Authorization") || "";
  const apiKeyHeader = req.headers.get("X-Api-Key") || "";
  const baseUrlHeader = req.headers.get("X-Api-Base-URL") || "";

  let apiKey: string | null = null;
  if (authHeader.startsWith("Bearer ")) {
    apiKey = authHeader.slice(7).trim();
  }
  if (apiKeyHeader) {
    apiKey = apiKeyHeader.trim();
  }
  if (!apiKey && process.env.OPENAI_API_KEY) {
    apiKey = process.env.OPENAI_API_KEY;
  }

  const baseUrl = baseUrlHeader || process.env.OPENAI_BASE_URL || undefined;
  return { apiKey, baseUrl };
}

/** Handle POST /__studio/import-site — run the import pipeline, streaming NDJSON progress. */
async function handleImportSite(req: Request, opts: ImportApiOptions): Promise<Response> {
  let body: ImportRequestBody;
  try {
    body = (await req.json()) as ImportRequestBody;
  } catch {
    return problem("invalidRequest", "Invalid JSON body");
  }

  const { url, directory } = body;
  if (!url || !directory) {
    return problem("invalidRequest", "url and directory are required");
  }
  if (!url.startsWith("http://") && !url.startsWith("https://")) {
    return problem("invalidRequest", "url must start with http:// or https://");
  }

  let destPath: string;
  try {
    destPath = opts.resolveDest(directory);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return problem("invalidRequest", message);
  }

  const depth = clamp(body.depth ?? 1, 0, MAX_DEPTH);
  /*
   * `verify` builds the emitted project and screenshot-diffs every page, so it roughly doubles the
   * run — opt-in, and never a default. It is worth the option because it produces the one number
   * the caller can act on: every other finding is a count of things that were skipped, and "the
   * pricing page renders at 61%" is a question worth putting to a person.
   */
  const verify: false | { threshold: number; minFidelity: number } = body.verify
    ? {
        /*
         * Two different numbers, and conflating them is what let a run scoring 8% report success.
         * `threshold` is pixelmatch's per-pixel COLOUR tolerance and only moves the score;
         * `minFidelity` is the bar the run's `passed` is measured against.
         */
        threshold: Math.min(
          MAX_THRESHOLD,
          Math.max(MIN_THRESHOLD, Number(body.verifyThreshold ?? 0.15) || 0.15),
        ),
        minFidelity: clamp(
          Number(body.verifyMinFidelity ?? 0) || 0,
          MIN_FIDELITY_FLOOR,
          MIN_FIDELITY_CEILING,
        ),
      }
    : false;
  const maxPages = clamp(body.maxPages ?? 20, 1, MAX_PAGES);
  const maxNodesPerPage = clamp(body.maxNodesPerPage ?? 5000, 100, 50_000);
  const { apiKey, baseUrl } = getAiConfig(req);
  const toRoot = opts.toRoot ?? ((p: string) => p);

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      let closed = false;
      const writeLine = (obj: unknown) => {
        if (closed) {
          return;
        }
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(obj)}\n`));
        } catch {
          closed = true;
        }
      };
      const heartbeat = setInterval(() => writeLine({ type: "heartbeat" }), HEARTBEAT_INTERVAL_MS);

      try {
        // Loaded lazily so the server never pays for puppeteer unless an import runs.
        const { importSite } = await import("@jxsuite/import/run");

        let ai:
          | false
          | { apiKey: string; baseUrl?: string | undefined; model?: string | undefined } = false;
        if (body.aiComponents) {
          if (apiKey) {
            ai = { apiKey, baseUrl, model: body.aiModel };
          } else {
            writeLine({
              type: "progress",
              phase: "ai",
              message:
                "⚠ AI component naming requested but no API key is configured — continuing with heuristic names",
            });
          }
        }

        const result = await importSite(
          {
            url,
            outDir: destPath,
            maxDepth: depth,
            maxPages,
            maxNodesPerPage,
            ai,
            verify,
            signal: req.signal,
            ...(opts.chromePath === undefined ? {} : { chromePath: opts.chromePath }),
          },
          (e) => writeLine({ type: "progress", ...e }),
        );

        const config = JSON.parse(
          await readFile(resolve(result.outDir, "project.json"), "utf8"),
        ) as Record<string, unknown>;
        /*
         * The result travels with the `done` line. It used to be discarded here: the pipeline had
         * computed the page list, the file count, the warnings and (with verify) a per-page
         * fidelity score, and the caller learned only that an import had happened. A caller that
         * cannot see what a run found cannot report it, and cannot ask about it either.
         */
        writeLine({
          type: "done",
          root: toRoot(result.outDir),
          config,
          result: {
            pages: result.pages,
            fileCount: result.fileCount,
            warnings: result.warnings,
            ...(result.verify ? { verify: result.verify } : {}),
          },
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        writeLine({ type: "error", error: message });
      } finally {
        clearInterval(heartbeat);
        if (!closed) {
          closed = true;
          try {
            controller.close();
          } catch {
            /* Already closed by a client abort. */
          }
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson",
      "Cache-Control": "no-cache",
    },
  });
}

/**
 * Main handler for the import route.
 *
 * @returns Response if handled, null if the route doesn't match
 */
export async function handleImportApi(
  req: Request,
  url: URL,
  opts: ImportApiOptions,
): Promise<Response | null> {
  if (url.pathname === "/__studio/import-site" && req.method === "POST") {
    return handleImportSite(req, opts);
  }
  return null;
}
