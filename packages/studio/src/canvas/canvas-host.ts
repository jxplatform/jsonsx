/// <reference lib="dom" />
/**
 * Canvas host selector — chooses how the design canvas renders the user's document.
 *
 * `legacy-div` (the default): the document renders directly into the editor's own document, the
 * historical behavior. `iframe`: the document renders inside a same-runtime iframe served from a
 * real origin — the migration target (see the iframe-canvas migration plan) that fixes asset-scheme
 * resolution and gives JS/CSS isolation + true responsive preview.
 *
 * The two hosts run side by side behind this flag during the migration; opt into the iframe canvas
 * with `?canvasHost=iframe`. Tests use {@link setCanvasHostOverride}.
 */

export type CanvasHost = "legacy-div" | "iframe";

const HOSTS = new Set<CanvasHost>(["legacy-div", "iframe"]);

let override: CanvasHost | null = null;

/** Force the canvas host (tests only). Pass `null` to clear and fall back to the URL/default. */
export function setCanvasHostOverride(host: CanvasHost | null): void {
  override = host;
}

/** Read the host from `?canvasHost=`; returns null when absent/invalid or the DOM is unavailable. */
function canvasHostFromUrl(): CanvasHost | null {
  try {
    const value = new URLSearchParams(location.search).get("canvasHost");
    return value && HOSTS.has(value as CanvasHost) ? (value as CanvasHost) : null;
  } catch {
    return null;
  }
}

/**
 * The active canvas host. Defaults to `legacy-div`; opt into the iframe canvas via
 * `?canvasHost=iframe`. (The legacy path is being removed; the default flips to `iframe` once the
 * render spine is gone.)
 */
export function canvasHost(): CanvasHost {
  return override ?? canvasHostFromUrl() ?? "legacy-div";
}

/**
 * Convenience predicate for the iframe canvas host. The legacy in-realm canvas has been removed, so
 * the iframe is now the only canvas — this is unconditionally true. (The host machinery above is
 * retained only because `setCanvasHostOverride` is still referenced by the iframe patch-wire
 * test.)
 */
export function isIframeCanvas(): boolean {
  return true;
}
