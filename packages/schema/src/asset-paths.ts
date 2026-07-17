/**
 * Deterministic mapping from Function-def `$src` module specifiers to bundled asset URLs. Shared
 * between the compiler's sidecar bundler (which writes the bundle) and extension `lower()`
 * implementations (which emit the URL into client code) so neither needs to depend on the other.
 *
 * The mapping is intentionally hash-free: the same specifier always yields the same URL, letting
 * lowered defs reference bundles the compiler produces later in the build. Distinct specifiers that
 * collide on a slug are rejected by the bundler at build time.
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
