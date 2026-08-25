/**
 * Asset references, resolved for the canvas.
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
  BUILD_LANES,
  dirOfPath,
  encodeProjectPath,
  isNonRelativeRef,
  joinProjectPath,
  projectPathForRef,
  splitRefSuffix,
} from "@jxsuite/schema/asset-paths";
import { documentBase, loopbackAssetSrc } from "./canvas-origin";
import { getPlatform, hasPlatform } from "../platform";
import { projectState } from "../store";
import { activeTab } from "../workspace/workspace";
import type { AssetLane, AssetMount } from "@jxsuite/schema/asset-paths";
import type { ContentSectionEntry } from "../types";

/** Content type names safe in a URL path segment. Mirrors `SAFE_TYPE_NAME` in the content loader. */
const SAFE_TYPE_NAME = /^[\w.~-]+$/;

/** The project.json section key content types live under; also their URL namespace. */
const SECTION_KEY = "content";

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
   * {@link BUILD_LANES} by default, and that is the deliberate answer rather than an omission: with
   * no filesystem to probe, a lane list has to collapse to ONE candidate, and the one that makes
   * the preview agree with the deployed site is the build's. See `DEV_SERVER_LANES` for the order
   * the editing servers actually use, and why the two differ.
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
 */
export function contentMountFor(
  documentPath: string | null | undefined,
  content: Record<string, ContentSectionEntry> | null | undefined,
): AssetMount | null {
  if (!documentPath || !content) {
    return null;
  }
  const path = documentPath.replaceAll("\\", "/").replace(/^\.\//, "");
  let best: AssetMount | null = null;
  for (const [name, def] of Object.entries(content)) {
    if (!def?.source || !SAFE_TYPE_NAME.test(name)) {
      continue;
    }
    const dir = normalizeSource(def.source);
    // A single-file source is not a collection directory — its siblings are not its assets.
    if (dir === "" || dir.startsWith("..") || /\.[a-z0-9]+$/i.test(dir)) {
      continue;
    }
    if (path.startsWith(`${dir}/`) && (!best || dir.length > best.dir.length)) {
      best = { dir, urlPrefix: `/${SECTION_KEY}/${name}` };
    }
  }
  return best;
}

/** Strip `./` and any trailing slash from a configured `source`, the way collectionDirs does. */
function normalizeSource(source: string): string {
  return source.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/+$/, "");
}

/**
 * The context for a document in the project currently open, or null when nothing applies.
 *
 * @param {string | null | undefined} documentPath - Project-relative path of the open document
 * @param {object} [over] - Host declarations: the asset space and the project-file base URL
 * @returns {AssetContext | null} A context, or null when no resolution is needed
 */
export function assetContextFor(
  documentPath: string | null | undefined,
  over?: { space?: "site" | "repo" | undefined; fileBaseUrl?: string | undefined },
): AssetContext | null {
  const space = over?.space ?? "site";
  const mount = contentMountFor(
    documentPath,
    projectState?.projectConfig?.content as Record<string, ContentSectionEntry> | undefined,
  );
  /* In site space the mount is the ONLY thing that needs doing, so no mount means no work. In repo
     space every reference needs rebasing, mount or not. */
  if (space === "site" && !mount) {
    return null;
  }
  return {
    documentDir: dirOfPath(documentPath ?? ""),
    ...(over?.fileBaseUrl === undefined ? {} : { fileBaseUrl: over.fileBaseUrl }),
    lanes: BUILD_LANES,
    mounts: mount ? [mount] : [],
    space,
  };
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

/**
 * The src a PARENT-REALM preview should load for an AUTHORED value — a media-picker thumbnail, the
 * social card in the SEO modal.
 *
 * The canvas resolves its own references; panel chrome renders in the parent document, where a
 * content-relative value would resolve against `index.html` and 404 exactly as it did in the
 * canvas. Same mapping, same rule — resolved against the ACTIVE tab, which is the entry whose field
 * is being edited.
 *
 * Takes what the author WROTE. For a project FILE PATH — a library thumbnail, a media-browser tile
 * — use `previewFileSrc` in `files/media-paths`; the two are separate because a file path is not an
 * authored reference and confusing them is silent.
 *
 * The loopback absolutization is folded in rather than left to the caller: every one of the four
 * call sites needs both steps, and one that composed them by hand would work everywhere except the
 * desktop shell, where a relative src resolves against `views://`.
 *
 * @param {string} value - The reference as the author wrote it
 * @returns {string} A src the parent realm can load
 */
export function previewAssetSrc(value: string): string {
  if (!value) {
    return value;
  }
  const ctx = assetContextFor(activeTab.value?.documentPath, hostAssetDeclarations());
  return loopbackAssetSrc(resolveAssetRef(value, ctx) ?? value);
}

/**
 * What the registered host says about media — the platform's `assetSpace`, and the base project
 * files are served under.
 *
 * Read through the platform rather than passed in, because every caller is panel chrome with no
 * access to the render pipeline and because the answer is a property of the HOST, not of the call.
 * The canvas pipeline builds the same two values from the same two places; the difference is only
 * that it already has the document in hand.
 *
 * @returns {{ space?: "site" | "repo"; fileBaseUrl: string }} The host's declarations
 */
export function hostAssetDeclarations(): {
  space?: "site" | "repo" | undefined;
  fileBaseUrl: string;
} {
  return {
    fileBaseUrl: documentBase(projectState?.projectRoot),
    ...(hasPlatform() ? { space: getPlatform().assetSpace } : {}),
  };
}
