/**
 * Dev-server CLI entry — what `jx dev` spawns under Bun in a standalone project.
 *
 * Usage: bun @jxsuite/server/dev [--root <dir>] [--port <n>]
 *
 * For a site project (a project.json at the root), the entry builds the site up front, serves the
 * built pages from dist/ ahead of the static-source fallback, and rebuilds before each live-reload
 * broadcast so the browser always reloads into fresh output. Argument parsing and the middleware
 * factory are exported for tests; the server boot runs only when executed directly
 * (import.meta.main).
 *
 * @module @jxsuite/server/dev
 */

import { existsSync, statSync } from "node:fs";
import { join, normalize, resolve, sep } from "node:path";
import { createDevServer } from "./server.ts";
import { injectSSE } from "./watch.ts";

export interface DevArgs {
  port: number;
  root: string;
}

/**
 * Parse `--root`/`--port` (plus an optional positional root) into dev-server options.
 *
 * @param {string[]} argv - Raw arguments (process.argv.slice(2))
 * @returns {DevArgs} Resolved root and port (default 3000)
 */
export function parseDevArgs(argv: string[]): DevArgs {
  let root = ".";
  let port = 3000;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === "--root") {
      index += 1;
      root = argv[index] ?? root;
    } else if (arg === "--port") {
      index += 1;
      const parsed = Math.trunc(Number(argv[index] ?? ""));
      if (Number.isFinite(parsed) && parsed >= 0) {
        port = parsed;
      }
    } else if (!arg.startsWith("--")) {
      root = arg;
    }
  }
  return { port, root: resolve(root) };
}

/**
 * Middleware serving built pages from `<root>/dist` for page-like GET requests. Directory URLs
 * (with or without a trailing slash) map to their index.html; anything not present in dist falls
 * through to the dev server's static-source handling.
 *
 * @param {string} root - Absolute project root
 * @returns {(req: Request, url: URL) => Response | null}
 */
export function createDistMiddleware(
  root: string,
): (req: Request, url: URL) => Promise<Response | null> {
  const distDir = join(root, "dist");
  return async (req, url) => {
    if (req.method !== "GET") {
      return null;
    }
    const safe = normalize(decodeURIComponent(url.pathname)).replaceAll("\\", "/");
    const candidate = resolve(distDir, `.${safe.startsWith("/") ? safe : `/${safe}`}`);
    if (candidate !== distDir && !candidate.startsWith(distDir + sep)) {
      return null;
    }
    let filePath: string | null = null;
    if (existsSync(candidate)) {
      filePath = statSync(candidate).isDirectory() ? join(candidate, "index.html") : candidate;
    } else {
      filePath = join(candidate, "index.html");
    }
    if (!filePath || !existsSync(filePath)) {
      return null;
    }
    // Built pages get the live-reload client, like the server's own .html responses
    if (filePath.endsWith(".html")) {
      const html = await Bun.file(filePath).text();
      return new Response(injectSSE(html), {
        headers: { "Cache-Control": "no-cache", "Content-Type": "text/html; charset=utf-8" },
      });
    }
    return new Response(Bun.file(filePath), { headers: { "Cache-Control": "no-cache" } });
  };
}

if (import.meta.main) {
  const { port, root } = parseDevArgs(process.argv.slice(2));
  const isSite = existsSync(join(root, "project.json"));

  let building = Promise.resolve();
  const rebuild = () => {
    building = building.then(async () => {
      const { buildSite } = await import("@jxsuite/compiler/site");
      const result = await buildSite(root, { verbose: false });
      if (result.errors.length > 0) {
        for (const err of result.errors) {
          console.error(`  build error: ${err}`);
        }
      }
    });
    return building;
  };

  if (isSite) {
    console.log(`Building ${root}...`);
    await rebuild();
  }

  const server = (await createDevServer({
    port,
    root,
    ...(isSite && {
      middleware: createDistMiddleware(root),
      watch: { preReload: () => rebuild(), reloadOnAnyChange: true },
    }),
  })) as { port: number };
  console.log(`Jx dev server running at http://localhost:${server.port} (root: ${root})`);
}
