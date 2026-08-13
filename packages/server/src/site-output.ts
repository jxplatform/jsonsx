/**
 * Serve a project's BUILT output at the routes the built pages actually reference.
 *
 * A built page is written for its published origin: `dist/basics/counter/index.html` links to
 * `/basics/counter` and pulls `/components/fetch-demo.css`, both root-absolute. Studio's `View:
 * Open in Browser` used to hand the browser `…/dist/basics/counter/index.html` — the file's path
 * rather than the page's URL — and the consequences were exactly what those two absolutes predict:
 * the HTML arrived, every stylesheet and script 404'd against the server root, and the first link
 * the reader clicked left the built site entirely. The page loaded and nothing else worked.
 *
 * So the fix is not in the URL alone. A site is only "as if published" when it is served AT A ROOT,
 * which is what this module does for whichever project a server is showing: `/basics/counter` and
 * `/basics/counter/` both resolve to `<outDir>/basics/counter/index.html`, `/` to
 * `<outDir>/index.html`, and every asset the page names resolves the same way it will in
 * production.
 *
 * **It is a LAST resort, deliberately.** `serveProjectFile` tries the mounts, the absolute path,
 * the root-relative source file and `public/` before it gets here, so this step can only answer
 * requests that were already going to 404 — it can never shadow a source file that resolves today.
 * That property is what makes it safe to mount for every project on every server rather than behind
 * a flag.
 *
 * `jx dev`'s own `createDistMiddleware` is a different thing and stays: it runs BEFORE the source
 * files (a site project's dev server is showing the built site, not its sources) and it injects the
 * live-reload client. This one is the fallback for the servers that are showing a project's sources
 * — the monorepo dev server and the desktop's project server — where the built site is something a
 * reader is visiting, not the thing being edited.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

import { serveContained } from "./net-guard.ts";

/** What `project.json` says the build writes to, cached per root against its mtime. */
const outDirCache = new Map<string, { mtime: number; outDir: string | null }>();

/** Reset the output-directory cache (test hook). */
export function resetSiteOutput(): void {
  outDirCache.clear();
}

/**
 * The project's absolute output directory, or `null` when it is not a site project.
 *
 * Read from `project.json` rather than assumed to be `dist`, because `build.outDir` is a documented
 * setting and a project that moved it would otherwise be served its stale old output for ever. The
 * mtime guard is the same idiom `jx-mounts.ts` uses: a config edit is picked up, a request is not a
 * file read.
 */
export function siteOutDir(projectRoot: string): string | null {
  const configPath = resolve(projectRoot, "project.json");
  if (!existsSync(configPath)) {
    return null;
  }
  const { mtimeMs } = statSync(configPath);
  const cached = outDirCache.get(projectRoot);
  if (cached && cached.mtime === mtimeMs) {
    return cached.outDir;
  }
  let outDir: string | null = null;
  try {
    const config = JSON.parse(readFileSync(configPath, "utf8")) as {
      build?: { outDir?: unknown };
    };
    const declared = config.build?.outDir;
    outDir = resolve(projectRoot, typeof declared === "string" && declared ? declared : "dist");
  } catch {
    // An unparseable project.json is the editor's problem to report, not this server's to guess
    // At. No output directory means this fallback simply declines, and the request 404s as before.
    outDir = null;
  }
  outDirCache.set(projectRoot, { mtime: mtimeMs, outDir });
  return outDir;
}

/**
 * Serve `decodedPath` from the project's built output, or `null` when it names nothing there.
 *
 * The mapping is the compiler's own, read backwards: a request for a route gets that route's
 * `index.html` whether or not the reader typed the trailing slash, because a built site is browsed
 * by its routes and a reader does not know which spelling the `trailingSlash` setting produced.
 * `<route>.html` is tried too, which is what `trailingSlash: "never"` writes.
 */
export async function serveSiteOutput(
  decodedPath: string,
  projectRoot: string,
): Promise<Response | null> {
  const outDir = siteOutDir(projectRoot);
  if (!outDir || !existsSync(outDir)) {
    return null;
  }
  const rel = decodedPath.replace(/^\/+/, "");
  const direct = resolve(outDir, `./${rel}`);

  // A file (an asset, or a page under `trailingSlash: "never"`).
  if (existsSync(direct) && statSync(direct).isFile()) {
    return serveContained(direct, outDir);
  }
  // A route: its directory's index.html, with or without the trailing slash the reader typed.
  const asIndex = join(direct, "index.html");
  if (existsSync(asIndex)) {
    return serveContained(asIndex, outDir);
  }
  // `trailingSlash: "never"` writes `<route>.html` beside its siblings.
  const asHtml = `${direct.replace(/\/+$/, "")}.html`;
  if (rel !== "" && existsSync(asHtml)) {
    return serveContained(asHtml, outDir);
  }
  return null;
}
