/**
 * @example
 *   import { createDevServer } from "@jxsuite/server";
 *
 *   await createDevServer({
 *   root: import.meta.dir,
 *   builds: [{ entrypoints: ["./src/app.js"], outdir: "./dist", match: /src/, label: "app" }],
 *   });
 *
 *   jxsuite/server — Jx development server
 *
 *   Provides builds, live reload, $src module proxying, timing: "server" function
 *   proxying, and studio filesystem integration as a single createDevServer() call.
 */

import { join, resolve } from "node:path";
import { buildAll } from "./build.ts";
import { createWatcher, injectSSE } from "./watch.ts";
import { handleResolve, handleServerFunction } from "./resolve.ts";
import { handleStudioApi } from "./studio-api.ts";
import { handleCodeApi } from "./code-api.ts";
import { handleAiApi } from "./ai-api.js";
import { existsSync, readFileSync } from "node:fs";

/**
 * Resolve an npm-style bare specifier from a URL path via node_modules. Handles scoped packages
 * (@scope/pkg/subpath) and respects package.json exports. Strips leading directory segments (e.g.
 * /pages/@scope/pkg/file → @scope/pkg/file).
 *
 * @param {string} root - Absolute project root
 * @param {string} urlPath - URL pathname (e.g. "/pages/@jxsuite/parser/Foo.class.json")
 * @returns {string | null} Absolute file path or null
 */
interface PackageJson {
  exports?: Record<string, string | { import?: string; default?: string }>;
  customElements?: string;
  module?: string;
  main?: string;
  [key: string]: unknown;
}

function resolveNpmPath(rootDir: string, urlPath: string) {
  let root = rootDir;
  let segments = urlPath.split("/").filter(Boolean);

  // If "node_modules" appears in the path, use everything before it as a subdirectory
  // Prefix and everything after as the package specifier.
  // E.g. /examples/demo/node_modules/@scope/pkg → root=root/examples/demo, pkg=@scope/pkg
  const nmIdx = segments.indexOf("node_modules");
  if (nmIdx !== -1) {
    if (nmIdx > 0) {
      root = join(root, ...segments.slice(0, nmIdx));
    }
    segments = segments.slice(nmIdx + 1);
  }

  // Find the package start — either @scope/pkg or unscoped pkg
  let start = -1;
  let isScoped = false;
  for (let i = 0; i < segments.length; i++) {
    if (segments[i]!.startsWith("@")) {
      start = i;
      isScoped = true;
      break;
    }
  }

  let pkgDir = "";
  let subpath = "";

  if (isScoped) {
    if (start < 0 || start + 1 >= segments.length) {
      return null;
    }
    const scope = segments[start]!;
    const pkg = segments[start + 1]!;
    subpath = segments.slice(start + 2).join("/");
    pkgDir = join(root, "node_modules", scope, pkg);
  } else {
    // Unscoped: try each segment as a package name in node_modules
    for (let i = 0; i < segments.length; i++) {
      const candidate = join(root, "node_modules", segments[i]!);
      if (existsSync(join(candidate, "package.json"))) {
        start = i;
        pkgDir = candidate;
        subpath = segments.slice(i + 1).join("/");
        break;
      }
    }
    if (start < 0) {
      return null;
    }
  }

  const pkgJsonPath = join(pkgDir, "package.json");
  if (!existsSync(pkgJsonPath)) {
    return null;
  }

  // If there's a subpath, check package.json exports first
  if (subpath) {
    try {
      const pkgJson = JSON.parse(readFileSync(pkgJsonPath, "utf8")) as PackageJson;
      const exportKey = `./${subpath}`;
      const exportVal = pkgJson.exports?.[exportKey];
      if (typeof exportVal === "string") {
        const mapped = join(pkgDir, exportVal);
        if (existsSync(mapped)) {
          return mapped;
        }
      }
    } catch {}
    // Fall back to direct path
    const direct = join(pkgDir, subpath);
    if (existsSync(direct)) {
      return direct;
    }
    // CEM-relative: subpath may be relative to the custom elements manifest directory
    try {
      const pkgJson = JSON.parse(readFileSync(pkgJsonPath, "utf8")) as PackageJson;
      if (pkgJson.customElements) {
        const cemDir = pkgJson.customElements.replace(/\/[^/]+$/, "");
        const cemRelative = join(pkgDir, cemDir, subpath);
        if (existsSync(cemRelative)) {
          return cemRelative;
        }
      }
    } catch {}
  }

  // Bare package (no subpath): resolve entry point
  try {
    const pkgJson = JSON.parse(readFileSync(pkgJsonPath, "utf8")) as PackageJson;
    const exp = pkgJson.exports?.["."];
    const entry =
      (typeof exp === "object" ? (exp.import ?? exp.default) : exp) ??
      pkgJson.module ??
      pkgJson.main;
    if (entry && typeof entry === "string") {
      const resolved = join(pkgDir, entry);
      if (existsSync(resolved)) {
        return resolved;
      }
    }
  } catch {}

  return null;
}

export { resolveNpmPath };

/**
 * Create and start a Jx development server.
 *
 * @param {object} options
 * @param {string} options.root - Project root (absolute or relative)
 * @param {number} [options.port] - Server port. Default is `3000`
 * @param {{
 *   entrypoints: string[];
 *   outdir: string;
 *   match?: Function | RegExp;
 *   label?: string;
 * }[]} [options.builds]
 *   - Bun.build entries with optional match regex
 * @param {boolean | object} [options.watch] - Watch config or false to disable. Default is `true`
 * @param {boolean} [options.studio] - Enable /**studio/* endpoints. Default is `true`
 * @param {Function} [options.middleware] - Custom route handler (req, url) => Response|null
 * @returns {Promise<object>} The Bun.serve server object
 */
export async function createDevServer(options: {
  root: string;
  port?: number;
  builds?: {
    entrypoints: string[];
    outdir: string;
    match?: ((path: string) => boolean) | RegExp;
    label?: string;
  }[];
  watch?: boolean | object;
  studio?: boolean;
  middleware?: (req: Request, url: URL) => Response | null | Promise<Response | null>;
}) {
  const {
    root,
    port = 3000,
    builds = [],
    watch = true,
    studio: enableStudio = true,
    middleware,
  } = options;

  if (!root) {
    throw new Error("@jxsuite/server: root is required");
  }
  const absRoot = resolve(root);

  // ─── Build pipeline ─────────────────────────────────────────────────────────

  if (builds.length > 0) {
    await buildAll(builds);
  }

  // ─── File watcher + SSE ─────────────────────────────────────────────────────

  let handleSSE = null;
  if (watch !== false) {
    const watchOpts = typeof watch === "object" ? watch : {};
    const watcher = createWatcher(absRoot, builds, watchOpts);
    ({ handleSSE } = watcher);
  }

  // Bundle cache for npm packages (bare specifier → bundled JS)
  const bundleCache = new Map<string, string>();

  // Active studio project root (set via /__studio/activate, used for static file fallback)
  let activeProjectRoot: string | null = null;

  // ─── HTTP server ────────────────────────────────────────────────────────────

  const server = Bun.serve({
    async fetch(req) {
      const url = new URL(req.url);
      let path = decodeURIComponent(url.pathname);
      if (path.endsWith("/")) {
        path += "index.html";
      } else if (path === "") {
        path = "/index.html";
      }

      // SSE live reload
      if (handleSSE && path === "/__reload") {
        return handleSSE();
      }

      // $prototype + $src proxy
      if (path === "/__jx_resolve__" && req.method === "POST") {
        return handleResolve(req, absRoot, activeProjectRoot);
      }

      // Timing: "server" function proxy
      if (path === "/__jx_server__" && req.method === "POST") {
        return handleServerFunction(req, absRoot);
      }

      // Studio filesystem API
      if (enableStudio && path.startsWith("/__studio/")) {
        // Activate project — tells the server which project root to use for static file fallback
        if (path === "/__studio/activate" && req.method === "POST") {
          const body = (await req.json()) as { root?: string };
          const raw = body.root || null;
          // Always store as absolute path
          activeProjectRoot = raw ? resolve(absRoot, raw) : null;
          return Response.json({ ok: true, root: activeProjectRoot });
        }

        // AI proxy endpoints (/__studio/ai/chat, /__studio/ai/models)
        const aiRes = await handleAiApi(req, url);
        if (aiRes) {
          return aiRes;
        }

        const codeRes = await handleCodeApi(req, url);
        if (codeRes) {
          return codeRes;
        }

        const res = await handleStudioApi(req, url, absRoot, activeProjectRoot);
        if (res) {
          return res;
        }
      }

      // Custom middleware
      if (middleware) {
        const res = await middleware(req, url);
        if (res) {
          return res;
        }
      }

      // Static files

      // If the URL path is an absolute filesystem path under the active project, serve directly.
      // A POSIX absolute path arrives as "//abs/path"; a Windows one as "/C:/dir/file" (leading
      // Slash + forward slashes), so drop the slash before the drive letter. Compare with
      // Separators normalised, since activeProjectRoot is OS-native (backslashes on Windows).
      const fsPath = path.startsWith("//") ? path.slice(1) : path.replace(/^\/([A-Za-z]:)/, "$1");
      const normSep = (p: string) => p.replaceAll("\\", "/");
      if (activeProjectRoot && normSep(fsPath).startsWith(normSep(activeProjectRoot))) {
        const file = Bun.file(fsPath);
        if (await file.exists()) {
          return new Response(file);
        }
      }

      const file = Bun.file(resolve(absRoot, `.${path}`));
      if (!(await file.exists())) {
        // Try resolving relative to active studio project root
        if (activeProjectRoot) {
          const projectFile = Bun.file(resolve(activeProjectRoot, `.${path}`));
          if (await projectFile.exists()) {
            return new Response(projectFile);
          }
          // Mirror production: public/ contents are served at root
          const publicFile = Bun.file(resolve(activeProjectRoot, "public", `.${path}`));
          if (await publicFile.exists()) {
            return new Response(publicFile);
          }
        }

        // Resolve npm-style bare specifiers via node_modules.
        // Bundle on-demand so internal bare specifiers (e.g. lit/...) resolve.
        const resolved = resolveNpmPath(absRoot, path);
        if (resolved) {
          const cacheKey = resolved;
          if (!bundleCache.has(cacheKey)) {
            try {
              const result = await Bun.build({
                entrypoints: [resolved],
                format: "esm",
                minify: false,
              });
              if (result.success && result.outputs.length > 0) {
                bundleCache.set(cacheKey, await result.outputs[0]!.text());
              }
            } catch (error) {
              console.error("Bundle failed for", resolved, error);
            }
          }
          const bundled = bundleCache.get(cacheKey);
          if (bundled) {
            return new Response(bundled, {
              headers: {
                "Content-Type": "application/javascript; charset=utf-8",
              },
            });
          }
        }
        return new Response("Not found", { status: 404 });
      }

      // Inject the live-reload script into served HTML — but NOT into the Studio editor.
      // Studio manages its own state (open tabs, undo history, chat) and refreshes
      // Edited files in-place; a blanket location.reload() would destroy that, e.g. when
      // The AI assistant writes a file matching a build glob inside the watched root.
      if (handleSSE && path.endsWith(".html") && !path.startsWith("/packages/studio/")) {
        const html = await file.text();
        return new Response(injectSSE(html), {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }

      return new Response(file);
    },

    port,
    // Keep SSE connections alive — heartbeats are every 15 s, and AI streaming/
    // Claude auth checks can take 30+ s. Default 10 s kills them prematurely.
    idleTimeout: 120,
  });

  console.log(`\n@jxsuite/server listening on http://localhost:${server.port}`);

  return server;
}
