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
 *   {"type":"done","root":"...","config":{…}}  — terminal success
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
}

/** Seconds between keep-alive lines while a phase is silent (browser launch is the longest gap). */
const HEARTBEAT_INTERVAL_MS = 15_000;

const MAX_DEPTH = 5;
const MAX_PAGES = 100;

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
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { url, directory } = body;
  if (!url || !directory) {
    return Response.json({ error: "url and directory are required" }, { status: 400 });
  }
  if (!url.startsWith("http://") && !url.startsWith("https://")) {
    return Response.json({ error: "url must start with http:// or https://" }, { status: 400 });
  }

  let destPath: string;
  try {
    destPath = opts.resolveDest(directory);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return Response.json({ error: message }, { status: 400 });
  }

  const depth = clamp(body.depth ?? 1, 0, MAX_DEPTH);
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
            signal: req.signal,
            ...(opts.chromePath === undefined ? {} : { chromePath: opts.chromePath }),
          },
          (e) => writeLine({ type: "progress", ...e }),
        );

        const config = JSON.parse(
          await readFile(resolve(result.outDir, "project.json"), "utf8"),
        ) as Record<string, unknown>;
        writeLine({ type: "done", root: toRoot(result.outDir), config });
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
