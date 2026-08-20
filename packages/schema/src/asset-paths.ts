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
