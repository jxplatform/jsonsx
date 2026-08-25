/**
 * Deterministic mapping from Function-def `$src` module specifiers to bundled asset URLs, plus the
 * asset-mount math that publishes files living outside the project root at a stable site URL.
 * Shared between the compiler's sidecar bundler (which writes the bundle) and extension `lower()`
 * implementations (which emit the URL into client code) so neither needs to depend on the other.
 *
 * The mapping is intentionally hash-free: the same specifier always yields the same URL, letting
 * lowered defs reference bundles the compiler produces later in the build. Distinct specifiers that
 * collide on a slug are rejected by the bundler at build time.
 *
 * Pure string math only — no node imports — so browser hosts can import this module.
 */

/** Prefix for npm package specifiers in `$src` (spec §12): `npm:<pkg>[/subpath]`. */
export const NPM_SPECIFIER_PREFIX = "npm:";

/** URL directory (under the site root) where bundled sidecars are written. */
export const SIDECAR_ASSET_DIR = "/assets/";

/** True when a `$src` specifier names an npm package rather than a project file. */
export function isNpmSpecifier(specifier: string): boolean {
  return specifier.startsWith(NPM_SPECIFIER_PREFIX);
}

/**
 * Map a Function-def `$src` specifier to its bundled asset URL.
 *
 * `npm:@jxsuite/search/client` → `/assets/jxsuite-search-client.js` `./lib/search-helpers.ts` →
 * `/assets/lib-search-helpers.js`
 */
export function sidecarAssetPath(specifier: string): string {
  let base = specifier;
  if (isNpmSpecifier(base)) {
    base = base.slice(NPM_SPECIFIER_PREFIX.length);
  }
  base = base
    .replace(/^\.\//, "")
    .replace(/\.(js|ts|mjs|mts)$/, "")
    .replaceAll("@", "")
    .replaceAll(/[/\\]+/g, "-")
    .replaceAll(/[^\w.-]/g, "-")
    .replaceAll(/-+/g, "-")
    .replaceAll(/^-|-$/g, "");
  return `${SIDECAR_ASSET_DIR}${base}.js`;
}

/**
 * Map a bare npm specifier naming a **file** — a stylesheet, a font, a prebuilt script — to the URL
 * the build copies it to.
 *
 * Unlike {@link sidecarAssetPath} this keeps the extension, because the file is copied rather than
 * bundled and both the browser and the host dispatch on it.
 *
 * @docs framework/site/seo
 */
export function npmAssetPath(specifier: string): string {
  const ext = /\.(\w+)$/.exec(specifier)?.[1] ?? "";
  const base = specifier
    .replace(/\.\w+$/, "")
    .replaceAll("@", "")
    .replaceAll(/[/\\]+/g, "-")
    .replaceAll(/[^\w.-]/g, "-")
    .replaceAll(/-+/g, "-")
    .replaceAll(/^-|-$/g, "");
  return ext === "" ? `${SIDECAR_ASSET_DIR}${base}` : `${SIDECAR_ASSET_DIR}${base}.${ext}`;
}

// ─── Asset mounts (specs/extensions.md §8.5) ─────────────────────────────────

/**
 * A site URL prefix backed by a real directory. Extensions declaring the `assets` capability return
 * mounts so hosts can publish files that live outside the project root (an external content
 * source's co-located images) without knowing anything about the section that owns them.
 */
export interface AssetMount {
  /** Site-absolute URL prefix, e.g. `/content/docs` (no trailing slash). */
  urlPrefix: string;
  /** Absolute directory the prefix maps onto. */
  dir: string;
}

/** Normalize a path or prefix for comparison: forward slashes, no trailing slash. */
function normalizeDir(value: string): string {
  const forward = value.replaceAll("\\", "/");
  return forward.length > 1 && forward.endsWith("/") ? forward.slice(0, -1) : forward;
}

/** Normalize a mount's URL prefix: leading slash, no trailing slash. */
export function normalizeAssetPrefix(prefix: string): string {
  const forward = normalizeDir(prefix);
  return forward.startsWith("/") ? forward : `/${forward}`;
}

/** Mounts sorted so the most specific (longest) candidate matches first. */
function bySpecificity(mounts: readonly AssetMount[], key: "dir" | "urlPrefix"): AssetMount[] {
  return [...mounts].toSorted((a, b) => b[key].length - a[key].length);
}

/** True when `path` is `dir` itself or sits underneath it (both already normalized). */
function isUnder(path: string, dir: string): boolean {
  return path === dir || path.startsWith(`${dir}/`);
}

/**
 * Map an absolute file path to its mounted site URL, or null when no mount contains it. Path
 * segments are percent-encoded so the URL survives HTML attributes; `resolveAssetUrl` reverses it.
 *
 * @param {readonly AssetMount[]} mounts
 * @param {string} absolutePath - Absolute filesystem path
 * @returns {string | null}
 */
export function assetUrlFor(mounts: readonly AssetMount[], absolutePath: string): string | null {
  const path = normalizeDir(absolutePath);
  for (const mount of bySpecificity(mounts, "dir")) {
    const dir = normalizeDir(mount.dir);
    if (!isUnder(path, dir) || path === dir) {
      continue;
    }
    const rest = path.slice(dir.length + 1);
    const encoded = rest
      .split("/")
      .map((segment) => encodeURIComponent(segment))
      .join("/");
    return `${normalizeAssetPrefix(mount.urlPrefix)}/${encoded}`;
  }
  return null;
}

/**
 * Map a mounted site URL back to its absolute file path, or null when it matches no mount. Query
 * and hash are dropped, the path is decoded ONCE (a still-encoded dot or slash after that decode is
 * a bypass attempt and is rejected), and `.`/`..` segments are refused outright — so the result can
 * never escape the mount directory.
 *
 * @param {readonly AssetMount[]} mounts
 * @param {string} url - Site-absolute URL (e.g. `/content/docs/images/hero.png`)
 * @returns {string | null}
 */
export function resolveAssetUrl(mounts: readonly AssetMount[], url: string): string | null {
  const pathname = url.split("#")[0]!.split("?")[0]!;
  if (!pathname.startsWith("/")) {
    return null;
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (/%2e|%2f/i.test(decoded)) {
    return null;
  }
  for (const mount of bySpecificity(mounts, "urlPrefix")) {
    const prefix = normalizeAssetPrefix(mount.urlPrefix);
    if (!decoded.startsWith(`${prefix}/`)) {
      continue;
    }
    const rest = decoded.slice(prefix.length + 1);
    const segments = rest.split("/");
    if (segments.some((s) => s === "" || s === "." || s === "..")) {
      return null;
    }
    return `${normalizeDir(mount.dir)}/${segments.join("/")}`;
  }
  return null;
}

/** Characters that terminate a URL inside markup: quotes, whitespace, CSS `url()` parens, `<>`. */
const URL_TERMINATOR = String.raw`"'\s<>()\\`;

/**
 * Collect every mounted URL referenced by a compiled artifact (HTML, CSS, JSON-LD). Scanning output
 * text rather than the document tree catches references wherever they came from — markdown images,
 * hand-authored pages, `$head` metadata, `url()` in stylesheets — with no per-attribute knowledge.
 *
 * @param {string} text - Compiled HTML or CSS
 * @param {readonly AssetMount[]} mounts
 * @returns {string[]} Unique mounted URLs, in first-seen order
 */
export function collectAssetUrls(text: string, mounts: readonly AssetMount[]): string[] {
  const found = new Set<string>();
  for (const mount of mounts) {
    const prefix = normalizeAssetPrefix(mount.urlPrefix);
    const pattern = new RegExp(
      `${prefix.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`)}/[^${URL_TERMINATOR}]+`,
      "g",
    );
    for (const match of text.matchAll(pattern)) {
      const url = match[0].split("#")[0]!.split("?")[0]!;
      // A trailing slash names a directory, not a file — prose quoting the mount prefix
      // ("published under /content/docs/images/") is a mention, not a reference.
      if (!url.endsWith("/")) {
        found.add(url);
      }
    }
  }
  return [...found].filter(Boolean);
}

// ─── Project paths ↔ site URLs (specs/site-architecture.md §9.3) ─────────────

/**
 * The project directory whose contents publish at the site root.
 *
 * A convention rather than a setting: `public/logo.png` is `/logo.png` on the built site, which is
 * why an authored `/logo.png` names a file the project tree calls something else.
 */
export const PUBLIC_DIR = "public";

/** Node keys whose value is a media reference. Mirrors `ASSET_KEYS` in the content loader. */
export const ASSET_KEYS = ["src", "poster"] as const;

/**
 * One step in a host's resolution order for a site-absolute URL.
 *
 * - `"mounts"` — an extension asset mount publishes a directory at a URL prefix (extensions.md §8.5).
 * - `"root"` — the URL path is a project-relative path as written.
 * - `"public"` — the URL path is relative to {@link PUBLIC_DIR}.
 */
export type AssetLane = "mounts" | "root" | "public";

/**
 * What a BUILD resolves — mounts, then `public/`, and nothing else.
 *
 * This is the published contract (site-architecture.md §9.3): a file at `<root>/hero.jpg` is not
 * addressable at `/hero.jpg` on a deployed site, because nothing copies it there.
 */
export const BUILD_LANES: readonly AssetLane[] = ["mounts", "public"];

/**
 * What the editing servers resolve — mounts, then the project root, then `public/`.
 *
 * It is deliberately NOT {@link BUILD_LANES}, and the difference is a real one rather than an
 * implementation detail: `serveProjectFile` in `@jxsuite/server` tries the project root BEFORE
 * `public/`, so `<root>/hero.jpg` loads at `/hero.jpg` in a preview and 404s in production. A test
 * asserts the two constants differ, so nobody can quietly assume they agree.
 */
export const DEV_SERVER_LANES: readonly AssetLane[] = ["mounts", "root", "public"];

/**
 * Split a reference into the path part and the `?query#hash` suffix.
 *
 * The suffix must survive every rewrite untouched: `./hero.png?v=2` is one file plus a
 * cache-buster, and a rewrite that drops the buster changes what the browser requests.
 *
 * @param {string} value - An authored reference
 * @returns {{ path: string; suffix: string }} The bare path and everything from the first `?`/`#`
 */
export function splitRefSuffix(value: string): { path: string; suffix: string } {
  const cut = value.search(/[#?]/);
  return cut === -1
    ? { path: value, suffix: "" }
    : { path: value.slice(0, cut), suffix: value.slice(cut) };
}

/**
 * True when `value` is already a URL, a template, a fragment, or empty — never a project file.
 *
 * Mirrors `isNonRelativeRef` in the content loader. A root-relative `/hero.jpg` counts as
 * non-relative here because it is a SITE URL, not a path relative to the document.
 *
 * @param {string} value - An authored reference
 * @returns {boolean}
 */
export function isNonRelativeRef(value: string): boolean {
  return (
    value === "" ||
    value.startsWith("/") ||
    value.startsWith("#") ||
    value.includes("${") ||
    /^[a-z][\w+.-]*:/i.test(value)
  );
}

/**
 * Normalize a project-relative path: forward slashes, no `./` prefix, no leading or trailing slash.
 *
 * @param {string} path - A project-relative path in any spelling
 * @returns {string} The canonical spelling
 */
export function normalizeProjectPath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\.\//, "").replace(/^\/+/, "").replace(/\/+$/, "");
}

/** The directory portion of a project-relative path (`""` for a root-level file). */
export function dirOfPath(path: string): string {
  const normalized = normalizeProjectPath(path);
  const slash = normalized.lastIndexOf("/");
  return slash === -1 ? "" : normalized.slice(0, slash);
}

/**
 * Resolve `ref` against `dir` in a pure, POSIX-ish way — no `node:path`, and no leading-slash
 * assumption, because project paths are relative to a root the browser does not have.
 *
 * @param {string} dir - Project-relative directory (`""` for the root)
 * @param {string} ref - A relative reference
 * @returns {string | null} The project-relative result, or null when it climbs above the root
 */
export function joinProjectPath(dir: string, ref: string): string | null {
  const base = dir === "" || dir === "." ? [] : normalizeProjectPath(dir).split("/");
  const out = base.filter((segment) => segment !== "" && segment !== ".");
  for (const segment of ref.replaceAll("\\", "/").split("/")) {
    if (segment === "" || segment === ".") {
      continue;
    }
    if (segment === "..") {
      if (out.length === 0) {
        return null; // Escapes the project root.
      }
      out.pop();
      continue;
    }
    out.push(segment);
  }
  return out.join("/");
}

/**
 * The site URL a project file publishes at under `lanes`, or null when nothing publishes it.
 *
 * The lanes are tried in order, so the answer is the URL the host would resolve FIRST — which is
 * what makes {@link projectPathsForSiteUrl} its inverse. Under {@link DEV_SERVER_LANES} that means
 * `public/logo.png` answers `/public/logo.png` (the root lane, which the server tries first) rather
 * than `/logo.png`; both work there, and only one round-trips.
 *
 * @param {string} path - Project-relative path
 * @param {readonly AssetMount[]} mounts - Project-relative asset mounts
 * @param {readonly AssetLane[]} lanes - The host's resolution order
 * @returns {string | null} A site-absolute URL, or null
 */
export function siteUrlForPath(
  path: string,
  mounts: readonly AssetMount[],
  lanes: readonly AssetLane[],
): string | null {
  const normalized = normalizeProjectPath(path);
  if (normalized === "") {
    return null;
  }
  for (const lane of lanes) {
    if (lane === "mounts") {
      const url = assetUrlFor(mounts, normalized);
      if (url) {
        return url;
      }
      continue;
    }
    if (lane === "root") {
      return `/${encodeProjectPath(normalized)}`;
    }
    if (normalized === PUBLIC_DIR || normalized.startsWith(`${PUBLIC_DIR}/`)) {
      return `/${encodeProjectPath(normalized.slice(PUBLIC_DIR.length + 1))}`;
    }
  }
  return null;
}

/**
 * Every project path a site-absolute URL could name under `lanes`, in the order the host tries
 * them.
 *
 * A list rather than one answer because the lanes genuinely overlap: `/hero.jpg` is `hero.jpg` to
 * the root lane and `public/hero.jpg` to the public lane, and only a filesystem can say which
 * exists. Callers with no filesystem — the Studio canvas — take the first.
 *
 * @param {string} url - A site-absolute URL (query and hash are ignored)
 * @param {readonly AssetMount[]} mounts - Project-relative asset mounts
 * @param {readonly AssetLane[]} lanes - The host's resolution order
 * @returns {string[]} Candidate project-relative paths, most-preferred first
 */
export function projectPathsForSiteUrl(
  url: string,
  mounts: readonly AssetMount[],
  lanes: readonly AssetLane[],
): string[] {
  const { path } = splitRefSuffix(url);
  if (!path.startsWith("/")) {
    return [];
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    return [];
  }
  // A still-encoded dot or slash after one decode is a traversal attempt, not a filename.
  if (/%2e|%2f/i.test(decoded)) {
    return [];
  }
  const rest = decoded.replace(/^\/+/, "");
  if (rest === "" || rest.split("/").some((segment) => segment === "." || segment === "..")) {
    return [];
  }
  const out: string[] = [];
  for (const lane of lanes) {
    if (lane === "mounts") {
      const mounted = resolveAssetUrl(mounts, path);
      // Only a mount INSIDE the project is addressable by path; `../../docs` is not.
      if (mounted !== null && !mounted.startsWith("/") && !/^[A-Za-z]:/.test(mounted)) {
        out.push(normalizeProjectPath(mounted));
      }
      continue;
    }
    out.push(lane === "root" ? rest : `${PUBLIC_DIR}/${rest}`);
  }
  return [...new Set(out)];
}

/**
 * The project file an authored reference names, seen from the document that wrote it.
 *
 * The two shapes an author writes resolve differently and neither goes through a site URL:
 *
 * - A content-relative `./images/hero.png` resolves against the document's own directory, which IS a
 *   project path already — `content/posts/images/hero.png`. The mount detour that the built site
 *   performs is not needed to name the file, only to publish it.
 * - A root-relative `/hero.jpg` is a site URL, so it resolves through {@link projectPathsForSiteUrl}
 *   and takes the host's first lane.
 *
 * Everything else — an absolute URL, a `data:` URI, a `${…}` template, a bare fragment — names no
 * project file and returns null, which callers read as "leave it exactly as written".
 *
 * @param {string} value - The authored reference
 * @param {string} documentDir - Project-relative directory of the document that wrote it
 * @param {readonly AssetMount[]} mounts - Project-relative asset mounts
 * @param {readonly AssetLane[]} lanes - The host's resolution order
 * @returns {string | null} A project-relative path, or null
 */
export function projectPathForRef(
  value: string,
  documentDir: string,
  mounts: readonly AssetMount[],
  lanes: readonly AssetLane[],
): string | null {
  const { path } = splitRefSuffix(value);
  if (path === "") {
    return null;
  }
  if (isNonRelativeRef(value)) {
    return path.startsWith("/") ? (projectPathsForSiteUrl(path, mounts, lanes)[0] ?? null) : null;
  }
  // A reference ending in a slash names a DIRECTORY, and no directory is a media file.
  if (path.endsWith("/")) {
    return null;
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    return null;
  }
  const joined = joinProjectPath(documentDir, decoded);
  if (joined === null || joined === "" || joined === normalizeProjectPath(documentDir)) {
    return null;
  }
  return joined;
}

/**
 * Percent-encode each path segment so the result survives an HTML attribute.
 *
 * Segment by segment, so the separators stay separators: `encodeURIComponent` on the whole path
 * would turn every `/` into `%2F` and produce one very long filename.
 *
 * @param {string} path - A project-relative path
 * @returns {string} The same path, each segment encoded
 */
export function encodeProjectPath(path: string): string {
  return path
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

// ─── srcset ──────────────────────────────────────────────────────────────────

/** One `srcset` candidate: a URL and the descriptor that selects it (`""` when there is none). */
export interface SrcsetCandidate {
  url: string;
  descriptor: string;
}

/**
 * Parse a `srcset` attribute into its candidates.
 *
 * Splitting on `","` is wrong and quietly so: a `data:` URL contains commas, and so does any URL
 * with a query list. This follows HTML's own algorithm instead — collect non-whitespace as the URL,
 * and if it ends in commas, the descriptor is empty and the next candidate starts immediately.
 *
 * @param {string} value - The attribute value
 * @returns {SrcsetCandidate[]} Candidates in source order
 */
export function parseSrcset(value: string): SrcsetCandidate[] {
  const out: SrcsetCandidate[] = [];
  let i = 0;
  while (i < value.length) {
    while (i < value.length && (/\s/.test(value[i]!) || value[i] === ",")) {
      i += 1;
    }
    if (i >= value.length) {
      break;
    }
    const start = i;
    while (i < value.length && !/\s/.test(value[i]!)) {
      i += 1;
    }
    let url = value.slice(start, i);
    if (url.endsWith(",")) {
      out.push({ descriptor: "", url: url.replace(/,+$/, "") });
      continue;
    }
    while (i < value.length && /\s/.test(value[i]!)) {
      i += 1;
    }
    const descStart = i;
    while (i < value.length && value[i] !== ",") {
      i += 1;
    }
    const descriptor = value.slice(descStart, i).trim();
    i += 1; // Consume the separating comma.
    url = url.replace(/,+$/, "");
    if (url !== "") {
      out.push({ descriptor, url });
    }
  }
  return out;
}

/**
 * Serialize candidates back into a `srcset` attribute value.
 *
 * @param {readonly SrcsetCandidate[]} candidates
 * @returns {string} The attribute value
 */
export function formatSrcset(candidates: readonly SrcsetCandidate[]): string {
  return candidates
    .map(({ url, descriptor }) => (descriptor ? `${url} ${descriptor}` : url))
    .join(", ");
}
