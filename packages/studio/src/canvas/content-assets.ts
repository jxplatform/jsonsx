/**
 * Content-relative asset references, resolved for the canvas.
 *
 * A content entry references media relative to ITSELF — `![](./images/hero.png)` — so the file
 * reads correctly in a plain markdown editor and so collections sourced outside the project root
 * still reach their media (specs/site-architecture.md §9.3). On the built site the collection
 * loader rewrites those refs onto the content type's asset mount,
 * `/content/<type>/images/hero.png`.
 *
 * Studio opens an entry as a STANDALONE document, so that loader never runs and the canvas would
 * render the authored path verbatim — which the browser resolves against `canvas.html`, not the
 * entry. This module applies the same mount mapping to the render document so the canvas previews
 * the URL production actually serves.
 *
 * The URL math is `assetUrlFor` from `@jxsuite/schema/asset-paths` — the same function the loader
 * and the compiler use — so the three cannot drift. It is pure string containment, which works
 * unchanged on the project-relative paths Studio deals in.
 *
 * The SOURCE document is never touched: the authored relative ref is what gets serialized back to
 * disk, and the properties panel shows the author what they wrote.
 *
 * One deliberate divergence from the loader: it declines to rewrite a ref whose target does not
 * exist (`existsSync`), leaving an unresolvable path alone rather than changing its meaning. The
 * browser has no filesystem, so this rewrites optimistically. A missing file is broken either way;
 * pointing at the mount URL is the more informative failure, and it is the URL the built site would
 * have attempted.
 *
 * @docs studio/projects/media
 */

import { assetUrlFor } from "@jxsuite/schema/asset-paths";
import { projectState } from "../store";
import { activeTab } from "../workspace/workspace";
import type { AssetMount } from "@jxsuite/schema/asset-paths";
import type { ContentSectionEntry } from "../types";
import type { JxMutableNode } from "@jxsuite/schema/types";

/** Node keys whose value is a media reference. Mirrors `ASSET_KEYS` in the content loader. */
const ASSET_KEYS = ["src", "poster"] as const;

/** Content type names safe in a URL path segment. Mirrors `SAFE_TYPE_NAME` in the content loader. */
const SAFE_TYPE_NAME = /^[\w.~-]+$/;

/** The project.json section key content types live under; also their URL namespace. */
const SECTION_KEY = "content";

/**
 * A value that is already a URL, a template, or a fragment — never a content-relative file. Mirrors
 * `isNonRelativeRef` in the content loader.
 */
function isNonRelativeRef(value: string): boolean {
  return (
    value === "" ||
    value.startsWith("/") ||
    value.startsWith("#") ||
    value.includes("${") ||
    /^[a-z][\w+.-]*:/i.test(value)
  );
}

/** Strip `./` and any trailing slash from a configured `source`, the way collectionDirs does. */
function normalizeSource(source: string): string {
  return source.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/+$/, "");
}

/**
 * Resolve `ref` against `dir` in a pure, POSIX-ish way — no `node:path`, and no leading-slash
 * assumption, because Studio's paths are project-relative. Returns null when the result would climb
 * above the project root (`../` past the top), which can never name a mounted file.
 */
export function resolveRelativePath(dir: string, ref: string): string | null {
  const segments = dir === "" || dir === "." ? [] : dir.replaceAll("\\", "/").split("/");
  const out = segments.filter((s) => s !== "" && s !== ".");
  for (const segment of ref.replaceAll("\\", "/").split("/")) {
    if (segment === "" || segment === ".") {
      continue;
    }
    if (segment === "..") {
      if (out.length === 0) {
        return null; // Escapes the project root.
      }
      out.pop();
      continue;
    }
    out.push(segment);
  }
  return out.join("/");
}

/** The directory portion of a project-relative file path (`""` for a root-level file). */
export function dirOf(path: string): string {
  const normalized = path.replaceAll("\\", "/");
  const slash = normalized.lastIndexOf("/");
  return slash === -1 ? "" : normalized.slice(0, slash);
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

/**
 * The mounted URL for one authored reference, or null to leave it as written. A ref is rewritten
 * only when it is relative and lands inside the collection directory — anything else (an absolute
 * URL, a project-root path, a bound template, a `../` escape out of the collection) keeps the
 * meaning it already had.
 */
export function mountedRefFor(value: string, entryDir: string, mount: AssetMount): string | null {
  if (isNonRelativeRef(value)) {
    return null;
  }
  const bare = value.split("#")[0]!.split("?")[0]!;
  let decoded: string;
  try {
    decoded = decodeURIComponent(bare);
  } catch {
    return null;
  }
  const target = resolveRelativePath(entryDir, decoded);
  if (target === null) {
    return null;
  }
  const url = assetUrlFor([mount], target);
  if (!url) {
    return null; // Outside the collection — not the mount's to publish.
  }
  return `${url}${value.slice(bare.length)}`;
}

/**
 * Rewrite one node's media refs, returning the node unchanged when nothing applies.
 *
 * PURE REBUILD: a node with a rewritten ref is replaced by a shallow copy, and so is every ancestor
 * on the path to it. Untouched subtrees keep their original references, so the render doc still
 * shares the vast majority of its nodes with the source doc.
 */
function rewriteNode(node: JxMutableNode, entryDir: string, mount: AssetMount): JxMutableNode {
  const record = node as unknown as Record<string, unknown>;
  /** Accumulated changed keys; stays null (and the node is returned as-is) when nothing applies. */
  let patch: Record<string, unknown> | null = null;

  for (const key of ASSET_KEYS) {
    const value = record[key];
    if (typeof value === "string") {
      const rewritten = mountedRefFor(value, entryDir, mount);
      if (rewritten) {
        patch ??= {};
        patch[key] = rewritten;
      }
    }
  }

  const attributes = record.attributes as Record<string, unknown> | undefined;
  if (attributes) {
    let nextAttrs: Record<string, unknown> | null = null;
    for (const key of ASSET_KEYS) {
      const value = attributes[key];
      if (typeof value === "string") {
        const rewritten = mountedRefFor(value, entryDir, mount);
        if (rewritten) {
          nextAttrs ??= { ...attributes };
          nextAttrs[key] = rewritten;
        }
      }
    }
    if (nextAttrs) {
      patch ??= {};
      patch.attributes = nextAttrs;
    }
  }

  const children = record.children as unknown[] | undefined;
  if (Array.isArray(children)) {
    let nextChildren: unknown[] | null = null;
    for (const [i, child] of children.entries()) {
      if (!child || typeof child !== "object") {
        continue;
      }
      const rewrittenChild = rewriteNode(child as JxMutableNode, entryDir, mount);
      if (rewrittenChild !== child) {
        nextChildren ??= [...children];
        nextChildren[i] = rewrittenChild;
      }
    }
    if (nextChildren) {
      patch ??= {};
      patch.children = nextChildren;
    }
  }

  return patch ? ({ ...node, ...patch } as JxMutableNode) : node;
}

/**
 * Map a content entry's relative media refs onto its content type's asset mount, for rendering.
 *
 * Returns `doc` itself when the document is not a content entry or carries no rewritable ref, so
 * the common case costs one walk and allocates nothing.
 */
export function rewriteContentAssets(
  doc: JxMutableNode,
  documentPath: string | null | undefined,
  content: Record<string, ContentSectionEntry> | null | undefined,
): JxMutableNode {
  const mount = contentMountFor(documentPath, content);
  if (!mount) {
    return doc;
  }
  return rewriteNode(doc, dirOf(documentPath!.replaceAll("\\", "/").replace(/^\.\//, "")), mount);
}

/**
 * The src a PARENT-REALM preview (a media-picker thumbnail) should load for an authored value.
 *
 * The canvas gets its mapping through {@link rewriteContentAssets} on the render doc, but panel
 * chrome renders in the parent document, where a content-relative value would resolve against
 * `index.html` and 404 exactly as it did in the canvas. Same mapping, same rule — resolved against
 * the ACTIVE tab, which is the entry whose field is being edited.
 *
 * Non-content documents and already-absolute values pass through untouched.
 */
export function previewAssetSrc(value: string): string {
  if (!value) {
    return value;
  }
  const documentPath = activeTab.value?.documentPath;
  const mount = contentMountFor(
    documentPath,
    projectState?.projectConfig?.content as Record<string, ContentSectionEntry> | undefined,
  );
  if (!mount) {
    return value;
  }
  return mountedRefFor(value, dirOf(documentPath!), mount) ?? value;
}
