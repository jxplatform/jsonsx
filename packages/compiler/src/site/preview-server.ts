/**
 * Preview server — `jx preview` serves an already-built dist/ directory.
 *
 * Dependency-free node:http static server, so the Node-run `jx` bin needs neither Bun nor the
 * dev-server package. Maps directory URLs to index.html (the build's trailingSlash output) and
 * falls back to <dist>/404.html when present.
 *
 * @module preview-server
 */

import { createServer } from "node:http";
import type { Server } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize, resolve, sep } from "node:path";
import { MEDIA_TYPE_BY_EXTENSION } from "@jxsuite/schema/media-type";

/*
 * The extensions this server can be asked for. `MEDIA_TYPE_BY_EXTENSION` is spread in **last** so
 * the registered spellings win: `.md` carries the `variant` that says which markdown it is, and
 * `.yaml`/`.yml` are `application/yaml` rather than an `application/octet-stream` download prompt.
 * Everything else is this table's own, because a shared table for `image/png` would be a second
 * source of truth for something no standard is ambiguous about.
 */
const MIME_TYPES: Record<string, string> = {
  ".avif": "image/avif",
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
  ".xml": "application/xml; charset=utf-8",
  ...MEDIA_TYPE_BY_EXTENSION,
};

/**
 * Resolve a request pathname to a file inside distDir, or null. Directory URLs (with or without a
 * trailing slash) map to their index.html; traversal outside distDir is rejected.
 *
 * @param {string} distDir - Absolute dist directory
 * @param {string} pathname - Decoded URL pathname
 * @returns {string | null} Absolute file path to serve, or null
 */
export function resolvePreviewFile(distDir: string, pathname: string): string | null {
  const safe = normalize(pathname).replaceAll("\\", "/");
  const candidate = resolve(distDir, `.${safe.startsWith("/") ? safe : `/${safe}`}`);
  if (candidate !== distDir && !candidate.startsWith(distDir + sep)) {
    return null;
  }
  if (existsSync(candidate)) {
    if (statSync(candidate).isDirectory()) {
      const index = join(candidate, "index.html");
      return existsSync(index) ? index : null;
    }
    return candidate;
  }
  // Extensionless route without trailing slash → its directory index
  const index = join(candidate, "index.html");
  return existsSync(index) ? index : null;
}

/**
 * Start the preview server on the given port (0 picks a free port).
 *
 * @param {string} distDir - Absolute path to the built dist directory
 * @param {number} port - Port to listen on
 * @returns {Server} The listening node:http server
 */
export function startPreviewServer(distDir: string, port: number): Server {
  const dist = resolve(distDir);
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const filePath = resolvePreviewFile(dist, decodeURIComponent(url.pathname));

    if (filePath) {
      res.writeHead(200, {
        "Content-Type": MIME_TYPES[extname(filePath).toLowerCase()] ?? "application/octet-stream",
      });
      res.end(readFileSync(filePath));
      return;
    }

    const notFound = join(dist, "404.html");
    if (existsSync(notFound)) {
      res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
      res.end(readFileSync(notFound));
      return;
    }
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found");
  });
  server.listen(port);
  return server;
}
