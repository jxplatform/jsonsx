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
