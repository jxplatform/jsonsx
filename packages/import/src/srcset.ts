/**
 * Where one `srcset` entry ends and the next begins.
 *
 * Its own module because two passes have to agree about it: `asset-collect.ts` decides from it what
 * gets DOWNLOADED, and `asset-rewrite.ts` reassembles the attribute from it. If they disagreed the
 * importer would fetch one set of URLs and rewrite another.
 */

/**
 * A `srcset` separator is a comma that starts a NEW URL. A comma inside a URL never is.
 *
 * Splitting on every comma shreds any URL carrying commas in its own path, and Wix, Cloudinary and
 * imgix all encode image transforms exactly that way — `.../fill/w_375,h_127,al_c,q_85/logo.png`
 * became a dozen unfetchable fragments. On one Wix site that was 109 failed downloads, and because
 * a failed download leaves the reference untouched, 46 `static.wixstatic.com` URLs stayed in the
 * emitted page: the "clone" served its images from the host it had cloned (issue #231).
 *
 * The lookahead lists the ways a URL can begin — absolute, `data:`, protocol-relative, root- or
 * dot-relative, or a bare `name.ext` — which is what distinguishes a separator from a transform
 * parameter. No `g` flag: `String.split` needs none, and a sticky `lastIndex` shared across calls
 * is a bug waiting to happen.
 */
export const SRCSET_SEPARATOR =
  /,(?=\s*(?:https?:\/\/|data:|\/\/|\/|\.{1,2}\/|[A-Za-z0-9_-]+\.[A-Za-z]{2,5}[/?#\s]))/;

/** The URL of each entry in a `srcset`, descriptors (`2x`, `800w`) dropped. */
export function parseSrcset(srcset: string): string[] {
  return srcset
    .split(SRCSET_SEPARATOR)
    .map((entry) => entry.trim().split(/\s+/)[0] ?? "")
    .filter(Boolean);
}
