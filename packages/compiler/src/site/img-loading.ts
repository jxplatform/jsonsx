/**
 * One decision, three callers: which loading attributes an `<img>` ends up with.
 *
 * It used to be three decisions. The static emitter added `loading="lazy"` to every `<img>` that
 * did not already carry one — unconditionally, outside `images.optimize` and outside the image
 * pipeline, so it reached the LCP image too, which is the one image on a page that must never be
 * lazy. The pipeline then made the same decision again for the nodes it rewrote, and a third time
 * for `<img>` tags sitting inside pre-rendered `innerHTML`. Only two of the three consulted
 * `images.lazyLoad`, and none of them knew what `fetchpriority` meant.
 *
 * The compiler cannot know which image is the largest contentful paint — that depends on the
 * viewport, not the document — so it does not guess. It honours the author's answer instead.
 *
 * @docs framework/site/images
 */

/** WHATWG HTML: `fetchpriority` values. `high` is the one that means "this is the LCP image". */
export const HIGH_PRIORITY = "high";

/** Attributes an `<img>` already carries, as far as this decision is concerned. */
export interface ImgLoadingState {
  loading?: unknown;
  decoding?: unknown;
  fetchpriority?: unknown;
}

/** Attributes to add. Empty when the author has already decided, or when lazy loading is off. */
export interface ImgLoadingAttrs {
  loading?: "lazy";
  decoding?: "async";
}

const present = (value: unknown) => value !== undefined && value !== null && value !== "";

/**
 * Decide the loading attributes for one `<img>`.
 *
 * Three ways to end up with nothing added: `lazyLoad` is off, the author set `loading` themselves,
 * or the author marked the image `fetchpriority="high"`. That last one is not a stylistic
 * preference — a high-priority lazy image is a contradiction the browser resolves by ignoring the
 * priority, so honouring both would silently discard the author's only lever over LCP.
 *
 * @param {ImgLoadingState} attrs - Attributes the image already carries
 * @param {boolean} lazyLoad - `images.lazyLoad`
 * @returns {ImgLoadingAttrs}
 */
export function imgLoadingAttrs(attrs: ImgLoadingState, lazyLoad: boolean): ImgLoadingAttrs {
  if (!lazyLoad || present(attrs.loading)) {
    return {};
  }
  if (String(attrs.fetchpriority ?? "").toLowerCase() === HIGH_PRIORITY) {
    return {};
  }
  return present(attrs.decoding) ? { loading: "lazy" } : { decoding: "async", loading: "lazy" };
}
