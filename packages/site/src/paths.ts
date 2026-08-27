/**
 * What a site origin serves, and — the part that matters — what it refuses.
 *
 * A previewed page runs the project's own JavaScript, which routinely includes third-party script,
 * and it runs it on an origin that also answers for the project tree. The rendered site gives away
 * its own content by design; a project's `.dev.vars` does not, and neither does the `project.json`
 * that names the user's deployment. So this list is an ALLOWLIST and it defaults closed. A denylist
 * would be the wrong shape: it has to be complete to be correct, and the cost of forgetting an
 * entry is a secret readable by whatever the page loaded.
 *
 * This is deliberately NOT the rule an editing server uses. `@jxsuite/server`'s `serveProjectFile`
 * serves the whole project root, which is Studio's protocol working — the editor addresses files it
 * already holds paths for. The same latitude on an origin running project script is a hole, so the
 * two rules stay apart even though they answer some of the same URLs.
 *
 * The mapping mirrors what `jx build` writes into `dist/`:
 *
 * - `public/**` is copied to the site root, so `/favicon.svg` is `public/favicon.svg`.
 * - Everything else keeps its project path, so `/components/card.json` is that file — which is what
 *   makes the runtime's own `$ref` and `$elements` resolution work with no rewriting at all.
 */

/** Project directories a site origin may read from. Everything else is not servable. */
export const SERVABLE_ROOTS: readonly string[] = [
  "public/",
  "components/",
  "layouts/",
  "pages/",
  "assets/",
  "media/",
  "content/",
  "data/",
  "styles/",
];

/**
 * Files that are never servable however they are addressed.
 *
 * Belt and braces over {@link SERVABLE_ROOTS} — these all sit at the project root and so are
 * already excluded, but they are the exact files whose exposure would matter and the cost of naming
 * them twice is nothing.
 */
export const NEVER_SERVABLE: ReadonlySet<string> = new Set([
  "project.json",
  "package.json",
  "package-lock.json",
  "bun.lock",
  "bun.lockb",
  "wrangler.jsonc",
  "wrangler.toml",
  ".dev.vars",
]);

/** A path segment that must never appear: dotfiles, traversal, and empty interior segments. */
function segmentIsSafe(segment: string): boolean {
  return segment !== "" && segment !== "." && segment !== ".." && !segment.startsWith(".");
}

/**
 * Normalise a request path into a project-relative path, or null when it is not one.
 *
 * Traversal is rejected rather than resolved: a `..` that a decode produced is not a path a site
 * ever legitimately asks for, and answering it — even correctly — means the check has to be right
 * about what it collapsed to.
 */
export function normalizeRequestPath(pathname: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes("\0") || decoded.includes("\\")) {
    return null;
  }
  /* A TRAILING slash is stripped rather than rejected. `build.trailingSlash` defaults to `always`,
     so `/blog/hello/` is the ordinary form of a page URL and the one Open in Browser hands over —
     treating its empty last segment as a malformed path 404'd every page on the site. Leading and
     interior empty segments are still refused; only the final one is a writing convention. */
  const clean = decoded.replace(/^\/+/, "").replace(/\/+$/, "");
  if (clean === "") {
    return "";
  }
  return clean.split("/").every((segment) => segmentIsSafe(segment)) ? clean : null;
}

/**
 * The project paths a request path could be asking for, in the order a built site would answer.
 *
 * `public/` first, because that is where the build copies from and an author who put `robots.txt`
 * in both meant the one they publish.
 */
export function candidatePaths(requestPath: string): string[] {
  if (requestPath === "" || NEVER_SERVABLE.has(requestPath)) {
    return [];
  }
  const candidates = [`public/${requestPath}`];
  if (SERVABLE_ROOTS.some((root) => requestPath.startsWith(root))) {
    candidates.push(requestPath);
  }
  return candidates;
}

/** Content types a site origin serves by extension. Anything unlisted is served as a download. */
const CONTENT_TYPES: Record<string, string> = {
  avif: "image/avif",
  css: "text/css; charset=utf-8",
  csv: "text/csv; charset=utf-8",
  gif: "image/gif",
  htm: "text/html; charset=utf-8",
  html: "text/html; charset=utf-8",
  ico: "image/x-icon",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  js: "text/javascript; charset=utf-8",
  json: "application/json; charset=utf-8",
  map: "application/json; charset=utf-8",
  md: "text/markdown; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  mp4: "video/mp4",
  otf: "font/otf",
  pdf: "application/pdf",
  png: "image/png",
  svg: "image/svg+xml",
  ttf: "font/ttf",
  txt: "text/plain; charset=utf-8",
  webm: "video/webm",
  webp: "image/webp",
  woff: "font/woff",
  woff2: "font/woff2",
  xml: "application/xml; charset=utf-8",
};

/**
 * The Content-Type a site origin serves a path as.
 *
 * Unlike an editor's raw-file mount — which never says `text/html` and attaches everything, because
 * it answers on an origin that holds a session — this serves real types. That is the whole point of
 * giving a preview an origin of its own: an HTML file executing here is the site working, not a
 * privilege escalation, because there is nothing on this origin to escalate to.
 */
export function contentTypeFor(path: string): string {
  const dot = path.lastIndexOf(".");
  const extension = dot === -1 ? "" : path.slice(dot + 1).toLowerCase();
  return CONTENT_TYPES[extension] ?? "application/octet-stream";
}
