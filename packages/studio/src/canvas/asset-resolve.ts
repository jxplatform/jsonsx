/**
 * Asset references, resolved for the canvas — the PURE half.
 *
 * Separate from `asset-refs.ts` for one reason, and it is a hard one: this module runs **inside the
 * canvas iframe**, which is a deliberately dependency-light bundle. `asset-refs.ts` reaches the
 * open project, the active tab and the registered platform, and importing any of that from the
 * iframe drags the entire editor shell in behind it. The build gate caught exactly that.
 *
 * So the split is by REALM, not by taste: everything here is a pure function of its arguments, and
 * everything that has to ask the running editor a question lives next door.
 *
 * A document names media in one of two shapes, and neither is a URL the canvas can use as written.
 *
 * A content entry references media relative to ITSELF — `![](./images/hero.png)` — so the file
 * reads correctly in a plain markdown editor and so collections sourced outside the project root
 * still reach their media (specs/site-architecture.md §9.3). On the built site the collection
 * loader rewrites those refs onto the content type's asset mount,
 * `/content/<type>/images/hero.png`. Studio opens an entry as a STANDALONE document, so that loader
 * never runs.
 *
 * A page references media by SITE URL — `/hero.jpg` — which is a file the project tree calls
 * `public/hero.jpg`. That works wherever the canvas is hosted by something that serves the site's
 * own URL space, which is what the dev server and the desktop loopback both are.
 *
 * {@link AssetContext} is the host's answer to "which of those two do you serve", and
 * {@link resolveAssetRef} is the whole of the resolution:
 *
 * - `"site"` — the origin already answers site URLs, so only the content-mount mapping is missing.
 *   This is what desktop and `jx dev` have always done, and the default when a host says nothing.
 * - `"repo"` — nothing answers a site URL, and the host serves PROJECT PATHS under a base instead.
 *   Every reference resolves to the file it names and is rebased onto that base. The mount detour
 *   disappears: a content entry's `./images/hero.png` is already `content/posts/images/hero.png`, a
 *   real path the host can serve.
 *
 * The SOURCE document is never touched in either case: the authored ref is what gets serialized
 * back to disk, and the properties panel shows the author what they wrote.
 *
 * One deliberate divergence from the content loader: it declines to rewrite a ref whose target does
 * not exist (`existsSync`), leaving an unresolvable path alone rather than changing its meaning.
 * The browser has no filesystem, so this resolves optimistically. A missing file is broken either
 * way; pointing at the URL the built site would have attempted is the more informative failure.
 *
 * @docs studio/projects/media
 */

import {
  assetUrlFor,
  encodeProjectPath,
  isNonRelativeRef,
  joinProjectPath,
  projectPathForRef,
  splitRefSuffix,
} from "@jxsuite/schema/asset-paths";
import type { AssetLane, AssetMount } from "@jxsuite/schema/asset-paths";
import type { ContentSectionEntry } from "../types";

/** Content type names safe in a URL path segment. Mirrors `SAFE_TYPE_NAME` in the content loader. */
const SAFE_TYPE_NAME = /^[\w.~-]+$/;

/** The project.json section key content types live under; also their URL namespace. */
const SECTION_KEY = "content";

/**
 * The placeholder a content type's `source` may carry to say "one directory per locale".
 *
 * Held here rather than imported out of the parser extension's content loader ({@link
 * file://../../../../extensions/parser/src/content-loader.ts}): that module reads the filesystem
 * and this one runs in a browser. It is also an extension, and core may not import one.
 */
const LOCALE_PLACEHOLDER = "{locale}";

/**
 * Everything the canvas needs to resolve one reference, as PLAIN DATA.
 *
 * Plain data because it has to cross a realm. The resolver itself is a function and cannot be
 * posted into the canvas iframe, so the parent posts this beside the render document and the iframe
 * builds the resolver from it locally.
 */
export interface AssetContext {
  /** What the canvas ORIGIN answers for a site URL — the platform's `assetSpace`, defaulted. */
  space: "site" | "repo";
  /**
   * Base URL under which the host serves PROJECT PATHS. Required by `"repo"` and inert without it:
   * a host that declares repo space and no base has told us its site URLs are wrong without telling
   * us what is right, and inventing an answer there would be worse than leaving the ref alone.
   */
  fileBaseUrl?: string | undefined;
  /** Project-relative directory of the document being rendered (`""` at the project root). */
  documentDir: string;
  /** Project-relative asset mounts that apply to this document. */
  mounts: AssetMount[];
  /**
   * The resolution order for a site-absolute URL.
   *
   * `BUILD_LANES` by default, and that is the deliberate answer rather than an omission: with no
   * filesystem to probe, a lane list has to collapse to ONE candidate, and the one that makes the
   * preview agree with the deployed site is the build's. See `DEV_SERVER_LANES` for the order the
   * editing servers actually use, and why the two differ.
   */
  lanes: readonly AssetLane[];
}

/**
 * The asset mount for the content type that owns `documentPath`, or null when the document is not a
 * directory-backed content entry.
 *
 * Only in-project sources can match: an entry Studio can address project-relatively is by
 * definition inside the project, and a source pointing elsewhere (`../../docs`) names files the
 * file tree cannot reach in the first place.
 *
 * @param {string | null | undefined} documentPath - Project-relative path of the open document
 * @param {Record<string, ContentSectionEntry> | null | undefined} content - Project.json `content`
 * @param {readonly string[]} [locales] - Canonical locale tags, for `{locale}` sources
 * @returns {AssetMount | null} The mount, project-relative
 */
export function contentMountFor(
  documentPath: string | null | undefined,
  content: Record<string, ContentSectionEntry> | null | undefined,
  locales: readonly string[] = [],
): AssetMount | null {
  if (!documentPath || !content) {
    return null;
  }
  const path = documentPath.replaceAll("\\", "/").replace(/^\.\//, "");
  let best: AssetMount | null = null;
  const consider = (dir: string, urlPrefix: string): void => {
    if (path.startsWith(`${dir}/`) && (!best || dir.length > best.dir.length)) {
      best = { dir, urlPrefix };
    }
  };
  for (const [name, def] of Object.entries(content)) {
    if (!def?.source || !SAFE_TYPE_NAME.test(name)) {
      continue;
    }
    const dir = normalizeSource(def.source);
    // A single-file source is not a collection directory — its siblings are not its assets.
    if (dir === "" || dir.startsWith("..")) {
      continue;
    }
    if (dir.includes(LOCALE_PLACEHOLDER)) {
      const mount = localeMountFor(path, dir, name, locales);
      if (mount) {
        consider(mount.dir, mount.urlPrefix);
      }
      continue;
    }
    if (/\.[a-z0-9]+$/i.test(dir)) {
      continue;
    }
    consider(dir, `/${SECTION_KEY}/${name}`);
  }
  return best;
}

/**
 * The mount for ONE locale of a `{locale}` source — the locale being whichever one `path` is in.
 *
 * A localized content type is N directories, not N content types, and each publishes separately at
 * `/content/<type>/<locale>` so a French post's `./hero.png` and its English translation's cannot
 * collide at one URL. The content loader picks the directory by probing the disk (`localeSource`);
 * Studio has no disk, so it reads the locale out of the document path it was given and checks that
 * against the project's declared tags. That is not a weaker test — the path IS the file, so the
 * only question left is whether its directory is a locale the project declares.
 *
 * Matched case-insensitively, for the same reason the loader does: two writers name that directory
 * and they differ. A project that declared `fr-CA` most likely typed `fr-CA/`, while Studio creates
 * `fr-ca/` because a page directory becomes a URL and the site's URLs are lowercase. The mount's
 * `dir` is the spelling on disk and its `urlPrefix` is the CANONICAL tag, exactly as the loader
 * publishes it.
 */
function localeMountFor(
  path: string,
  source: string,
  name: string,
  locales: readonly string[],
): AssetMount | null {
  const cut = source.indexOf(LOCALE_PLACEHOLDER);
  const head = source.slice(0, cut);
  const tail = source.slice(cut + LOCALE_PLACEHOLDER.length);
  if (!path.startsWith(head)) {
    return null;
  }
  const segment = path.slice(head.length).split("/")[0] ?? "";
  if (segment === "" || !SAFE_TYPE_NAME.test(segment)) {
    return null;
  }
  const canonical = locales.find((tag) => tag.toLowerCase() === segment.toLowerCase());
  if (canonical === undefined || !SAFE_TYPE_NAME.test(canonical)) {
    return null;
  }
  const dir = `${head}${segment}${tail}`.replace(/\/+$/, "");
  return { dir, urlPrefix: `/${SECTION_KEY}/${name}/${canonical}` };
}

/** Strip `./` and any trailing slash from a configured `source`, the way collectionDirs does. */
function normalizeSource(source: string): string {
  return source.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/+$/, "");
}

/**
 * The URL the canvas should load for one authored reference, or null to leave it as written.
 *
 * Null is not a failure — it is most of the answers. An absolute URL, a `data:` URI, a `${…}`
 * template that did not resolve to a project file, a `../` escape out of the collection: each one
 * already means what it says, and changing it would be the bug.
 *
 * @param {string} value - The reference as the author wrote it
 * @param {AssetContext | null} ctx - The host's asset context, or null for no resolution at all
 * @returns {string | null} The URL to load, or null to leave `value` untouched
 */
export function resolveAssetRef(value: string, ctx: AssetContext | null): string | null {
  if (!ctx || value === "") {
    return null;
  }
  if (ctx.space === "repo") {
    if (!ctx.fileBaseUrl) {
      return null;
    }
    const path = projectPathForRef(value, ctx.documentDir, ctx.mounts, ctx.lanes);
    if (path === null) {
      return null;
    }
    const { suffix } = splitRefSuffix(value);
    return `${ctx.fileBaseUrl}${encodeProjectPath(path)}${suffix}`;
  }
  const [mount] = ctx.mounts;
  return mount ? mountedRefFor(value, ctx.documentDir, mount) : null;
}

/**
 * The mounted URL for one content-relative reference, or null to leave it as written. A ref is
 * rewritten only when it is relative and lands inside the collection directory — anything else (an
 * absolute URL, a project-root path, a bound template, a `../` escape out of the collection) keeps
 * the meaning it already had.
 */
export function mountedRefFor(value: string, entryDir: string, mount: AssetMount): string | null {
  if (isNonRelativeRef(value)) {
    return null;
  }
  const { path: bare, suffix } = splitRefSuffix(value);
  let decoded: string;
  try {
    decoded = decodeURIComponent(bare);
  } catch {
    return null;
  }
  const target = joinProjectPath(entryDir, decoded);
  if (target === null) {
    return null;
  }
  const url = assetUrlFor([mount], target);
  if (!url) {
    return null; // Outside the collection — not the mount's to publish.
  }
  return `${url}${suffix}`;
}
