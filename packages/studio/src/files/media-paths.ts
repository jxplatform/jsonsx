/**
 * Media path math — the file, the URL it is published at, and the shapes an author writes.
 *
 * One media file has up to three names, and they are not interchangeable:
 *
 * | name             | example                          | who writes it                      |
 * | ---------------- | -------------------------------- | ---------------------------------- |
 * | the FILE         | `public/hero.jpg`                | the file tree, `uploadAssets`      |
 * | the SITE URL     | `/hero.jpg`                      | the browser, a preview `<img src>` |
 * | the AUTHORED ref | `/hero.jpg`, `./images/hero.png` | the document on disk               |
 *
 * `public/` is served from the site root, so a document that uses `public/hero.jpg` says
 * `/hero.jpg` — a string that shares not one path segment with the file it names. A content entry
 * says `./images/hero.png` and the collection loader republishes it at the content type's asset
 * mount (specs/site-architecture.md §9.3), so the same file can also be named
 * `/content/blog/images/hero.png` when the collection's `source` is not already `content/blog`.
 *
 * **Why this module exists at all.** `findReferences` resolves each authored ref the way the
 * compiler does — rooted values against the project root, relative ones against the referencing
 * document — and compares the RESULT to the path it was asked about. Ask it about `public/hero.jpg`
 * and every `/hero.jpg` in the project resolves to `hero.jpg`, matches nothing, and the answer is a
 * confident zero. That is the exact shape of bug that makes a delete look safe: seven pages break
 * and the dialog says nothing else refers to it. {@link authoredRefTargets} is the fix — it
 * enumerates what an authored reference to this file RESOLVES to, so the query is keyed on the ref
 * as written rather than on the file as stored.
 *
 * Everything here is pure string math over project-relative, forward-slashed paths. The only input
 * from outside is the open project's content sections, read the same way `canvas/asset-refs.ts`
 * reads them.
 *
 * @docs studio/projects/media
 */

import { normalizeProjectPath, PUBLIC_DIR } from "@jxsuite/schema/asset-paths";
import { contentMountFor } from "../canvas/asset-refs";
import { loopbackAssetSrc } from "../canvas/canvas-origin";
import { projectState } from "../store";
import type { AssetMount } from "@jxsuite/schema/asset-paths";
import type { ContentSectionEntry } from "../types";

/* Re-exported rather than redefined: the same normalization is what the compiler, the servers and
   the canvas resolver all key on, so there is one definition of it in `@jxsuite/schema`. */
export { normalizeProjectPath } from "@jxsuite/schema/asset-paths";

/** The filename of a project-relative path. */
export function baseName(path: string): string {
  const normalized = normalizeProjectPath(path);
  const slash = normalized.lastIndexOf("/");
  return slash === -1 ? normalized : normalized.slice(slash + 1);
}

/** The directory of a project-relative path, or `"."` for a file at the project root. */
export function dirName(path: string): string {
  const normalized = normalizeProjectPath(path);
  const slash = normalized.lastIndexOf("/");
  return slash === -1 ? "." : normalized.slice(0, slash);
}

/** The open project's content sections, or null when no project (or no `content:`) is loaded. */
function contentSections(): Record<string, ContentSectionEntry> | null {
  const content = projectState?.projectConfig?.content;
  return (content as Record<string, ContentSectionEntry> | undefined) ?? null;
}

/**
 * The mount that publishes `path`, or null when it is not inside a content collection.
 *
 * `contentMountFor` takes a DOCUMENT path, but the test it performs — which collection directory
 * contains this path — is exactly the one an asset needs, so the media file is passed straight in
 * rather than duplicating the loop.
 */
function mountOf(path: string): AssetMount | null {
  return contentMountFor(path, contentSections());
}

/**
 * The path a content-mounted file is published under, project-root-relative and WITHOUT the leading
 * slash — `content/blog/images/hero.png` for `posts/images/hero.png` mounted at `/content/blog`.
 *
 * Built by string surgery rather than through `assetUrlFor` on purpose: that function
 * percent-encodes each segment for use in an HTML attribute, and this value is compared against
 * paths resolved from raw document strings, which are never decoded on the way in.
 */
function mountedPath(path: string, mount: AssetMount): string {
  const prefix = normalizeProjectPath(mount.urlPrefix);
  return `${prefix}/${path.slice(mount.dir.length + 1)}`;
}

/**
 * The site URL a media file is published at — what a preview `<img>` in panel chrome should load.
 *
 * `public/` contents are served from the root, a content asset from its collection's mount, and
 * anything else from its own project-relative path (which is what the dev server serves).
 */
export function mediaSiteUrl(path: string): string {
  const normalized = normalizeProjectPath(path);
  if (normalized.startsWith(`${PUBLIC_DIR}/`)) {
    return `/${normalized.slice(PUBLIC_DIR.length + 1)}`;
  }
  const mount = mountOf(normalized);
  return mount ? `/${mountedPath(normalized, mount)}` : `/${normalized}`;
}

/**
 * Every path an authored reference to this media file resolves to — the keys a usage query must ask
 * about, most literal first.
 *
 * 1. The file itself. A sibling's `./images/hero.png`, a rooted `/content/blog/images/hero.png` and a
 *    bare `assets/logo.svg` all land here.
 * 2. Its served path, for `public/` media. `/hero.jpg` resolves to `hero.jpg`, which is not a file on
 *    disk and does not need to be — the sweep compares resolved strings, and this is the string
 *    every reference to a public asset produces.
 * 3. Its asset-mount path, when a collection's `source` differs from its mount prefix. Identical to
 *    (1) for the ordinary `content/<type>/` layout, and deduplicated when it is.
 *
 * The list is a UNION and is deliberately generous: over-counting a reference makes a delete dialog
 * more alarming than it needs to be, while missing one makes it lie.
 */
export function authoredRefTargets(path: string): string[] {
  const normalized = normalizeProjectPath(path);
  if (normalized === "") {
    return [];
  }
  const targets = [normalized];
  if (normalized.startsWith(`${PUBLIC_DIR}/`)) {
    targets.push(normalized.slice(PUBLIC_DIR.length + 1));
  }
  const mount = mountOf(normalized);
  if (mount) {
    const mounted = mountedPath(normalized, mount);
    if (!targets.includes(mounted)) {
      targets.push(mounted);
    }
  }
  return targets;
}

/**
 * The src a PARENT-REALM preview should load for a PROJECT FILE PATH — a library thumbnail, a
 * media-browser tile.
 *
 * The sibling of `previewAssetSrc` in `canvas/asset-refs`, and separate from it because the two
 * take different things and confusing them is silent. A file path is NOT an authored reference:
 * `public/hero.jpg` is written `/hero.jpg`, a string that shares not one segment with it. The
 * library grid built its `<img src>` by prefixing the path with a slash, so every `public/` image
 * asked for `/public/hero.jpg` — a URL the site does not publish — and every content-collection
 * image skipped its mount entirely.
 *
 * @param {string} path - A project-relative file path, as the file tree spells it
 * @returns {string} A src the parent realm can load
 */
export function previewFileSrc(path: string): string {
  const normalized = normalizeProjectPath(path);
  if (normalized === "") {
    return path;
  }
  return loopbackAssetSrc(mediaSiteUrl(normalized));
}
