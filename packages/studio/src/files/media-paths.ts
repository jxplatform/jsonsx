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
 * **Why this module exists at all.** A surface that has a FILE and needs a URL cannot get one by
 * prefixing a slash. The library grid did exactly that, so every `public/` image asked for
 * `/public/hero.jpg` — a URL the site does not publish — and every content-collection image skipped
 * its mount entirely. {@link mediaSiteUrl} and {@link previewFileSrc} are the answer, and they take
 * a FILE PATH: an authored reference is a different thing and resolves through
 * `canvas/asset-refs`.
 *
 * This module used to carry a third function, `authoredRefTargets`, enumerating every path an
 * authored reference to a file could resolve to, so a usage query could ask about all of them and
 * union the answers. That existed because `findReferences` resolved a rooted reference against the
 * project root alone; the engine now resolves every lane itself (`site-architecture.md` §9.3), on
 * the write side as well as the read side, which a client-side union never could. Asking once is
 * both simpler and more correct, so the helper is gone.
 *
 * Everything here is pure string math over project-relative, forward-slashed paths. The only input
 * from outside is the open project's content sections, read the same way `canvas/asset-refs.ts`
 * reads them.
 *
 * @docs studio/projects/media
 */

import { encodeProjectPath, normalizeProjectPath, PUBLIC_DIR } from "@jxsuite/schema/asset-paths";
import { contentMountFor, hostAssetDeclarations, projectLocales } from "../canvas/asset-refs";
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
  return contentMountFor(path, contentSections(), projectLocales());
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
  /* In repo space nothing answers a site URL, so the site URL is the wrong question entirely: the
     host serves the FILE, at its own path, under the declared base. */
  const { space, fileBaseUrl } = hostAssetDeclarations();
  if (space === "repo") {
    return `${fileBaseUrl}${encodeProjectPath(normalized)}`;
  }
  return loopbackAssetSrc(mediaSiteUrl(normalized));
}
