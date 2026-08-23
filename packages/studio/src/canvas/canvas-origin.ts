/// <reference lib="dom" />
/**
 * Canvas origin derivation. The canvas iframe may load same-origin (dev server / chromium /
 * electrobun gate-off, where the platform canvasUrl is a relative path) or cross-origin (electrobun
 * loopback, where canvasUrl is an absolute http://127.0.0.1:<port> URL).
 *
 * CanvasBaseOrigin() returns the origin the canvas document lives on, so callers that build
 * absolute asset/doc URLs target the right server. For a relative canvasUrl this resolves to
 * location.origin — IDENTITY for the same-origin paths, so dev/chromium/electrobun-gate-off are
 * byte-identical to before.
 */

import { getPlatform, hasPlatform } from "../platform";

/**
 * The origin serving the canvas document. When the platform registers an absolute canvasUrl
 * (electrobun loopback), this is that URL's origin; otherwise it falls back to the parent's own
 * origin (a relative canvasUrl resolves against location.href to location.origin).
 */
export function canvasBaseOrigin(): string {
  const canvasUrl = hasPlatform() ? getPlatform().canvasUrl : undefined;
  if (canvasUrl) {
    return new URL(canvasUrl, location.href).origin;
  }
  return location.origin;
}

/**
 * The base the canvas fetches PROJECT FILES against — component `$ref`s, `$src` modules, images.
 *
 * Two shapes, and the platform chooses. Most hosts serve the project tree from their web root, so
 * `<canvas origin>/<projectRoot>/` is a real URL: the dev server serves by path (absolute
 * filesystem paths included) and the desktop loopback does the same. Those set nothing.
 *
 * A host whose `projectRoot` is an IDENTIFIER rather than a served path sets `documentBaseUrl`. Jx
 * Cloud is one — its root is `owner/repo@branch`, and the default produced a URL nothing answered,
 * so every `$ref` fetch fell through to the SPA fallback. That fallback returns the marketing page
 * at **HTTP 200**, so `res.ok` passed and the runtime's `res.json()` died on `Unexpected token
 * '<'`; images failed the same way and reported nothing.
 *
 * @param {string | undefined} projectRoot - The active project root, for the default shape.
 * @returns {string} A base URL ending in `/`, safe to pass to `new URL(relativePath, base)`.
 */
export function documentBase(projectRoot?: string): string {
  const declared = hasPlatform() ? getPlatform().documentBaseUrl : undefined;
  if (declared) {
    return declared.endsWith("/") ? declared : `${declared}/`;
  }
  const root = projectRoot || "";
  return `${canvasBaseOrigin()}/${root ? `${root}/` : ""}`;
}

/**
 * Build an absolute loopback-origin src for a PROJECT asset path referenced by a PARENT-realm
 * (shell) preview <img>. On the views:// shell a relative "/images/foo.png" resolves to
 * views://studio/images/foo.png, which the browser fetches immediately on paint — a stray request
 * the desktop MutationObserver only rewrites asynchronously. Rendering the src loopback-absolute up
 * front eliminates that race for direct-parent <img> sites.
 *
 * Guarded: this ONLY rewrites when a real cross-origin http(s) loopback is registered (electrobun
 * loopback, canvasUrl set to an absolute http URL) whose origin differs from location.origin.
 * Otherwise — dev server, chromium, electrobun gate-off, and the pre-activate window — it returns
 * the ORIGINAL relative path unchanged, keeping those cases byte-identical (an absolute
 * ${location.origin}/... on the shell would just reintroduce views://... — the exact bug).
 *
 * Only for PROJECT asset srcs; NEVER call it for shell-packaged views:// assets (sp-icons, bundled
 * chrome). Already-absolute inputs (data:/blob:/http/views://) are returned untouched, so it is
 * safe for user-typed media values too.
 *
 * @param {string} path — a project asset path (relative, e.g. "/public/logo.png" or "logo.png") or
 *   an already-absolute URL.
 * @returns {string} The loopback-absolute src when a cross-origin loopback is active, else `path`.
 */
export function loopbackAssetSrc(path: string): string {
  if (
    path.startsWith("data:") ||
    path.startsWith("blob:") ||
    path.startsWith("http") ||
    path.startsWith("views://")
  ) {
    return path;
  }
  const origin = canvasBaseOrigin();
  // Only rewrite when a real cross-origin http(s) loopback is registered. When canvasBaseOrigin()
  // Yields location.origin (the views:// shell / dev / chromium / gate-off) an absolute rewrite
  // Would produce views://... on the shell, so fall back to the relative path unchanged.
  if ((origin.startsWith("http:") || origin.startsWith("https:")) && origin !== location.origin) {
    return `${origin}/${path.replace(/^\.?\//, "")}`;
  }
  return path;
}
