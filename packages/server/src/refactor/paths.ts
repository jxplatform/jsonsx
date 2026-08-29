/**
 * Paths.ts — pure, OS-independent path math for the rename-refactor engine.
 *
 * Everything here operates on forward-slash POSIX strings and never touches the filesystem, so it
 * unit-tests deterministically. Callers (apply.ts) normalise real paths with `fwd()` before handing
 * them in. The relative-path style mirrors `computeRelativePath` in the studio
 * (packages/studio/src/files/components.ts): "./" for same-dir/descendant targets, "../"-chains
 * otherwise.
 *
 * **A rooted reference is a site URL, not a project path.** `/images/hero.jpg` names whichever file
 * the host serves at that URL, and there are three places it can live: an extension's asset mount,
 * the project root, and `public/`. This module does not re-derive that mapping — it calls
 * `@jxsuite/schema/asset-paths`, the same lane math the canvas, the dev server and the build all
 * use. Resolving a rooted ref against the project root alone was how a rename of any file under
 * `public/` rewrote nothing while promising otherwise (issue 239).
 *
 * @docs studio/projects/pages-layouts-components
 */

import { BUILD_LANES, projectPathsForSiteUrl, siteUrlForPath } from "@jxsuite/schema/asset-paths";
import type { AssetLane, AssetMount } from "@jxsuite/schema/asset-paths";

/**
 * The lanes a rewritten site URL is re-emitted through, most-publishable first.
 *
 * {@link BUILD_LANES} first, so a file that a deployed build publishes keeps the URL that build
 * serves — `public/images/hero.jpg` re-emits as `/images/hero.jpg`, not the `/public/...` form the
 * dev server would also answer. The `root` lane is the fallback for a file only the dev server can
 * reach: that reference was already build-broken before the rename (the server says so at request
 * time), and preserving it is strictly better than leaving it pointing at a file that has moved.
 *
 * The consequence is that this is total for any non-empty in-project path — a rename can always
 * express its destination — so there is no "unrewritable reference" case to report.
 */
const AUTHORED_LANES: readonly AssetLane[] = [...BUILD_LANES, "root"];

/**
 * The lanes a rooted reference is READ through: every place the dev server would look.
 *
 * Deliberately wider than {@link AUTHORED_LANES} and unordered in effect, because the reader checks
 * all of them. Where two lanes both name an existing file, `/hero.jpg` genuinely is ambiguous, and
 * counting both is the safe side of a question asked to warn someone before a delete.
 */
const READ_LANES: readonly AssetLane[] = ["mounts", "root", "public"];

/** Classification of a reference string value. */
export type RefClass =
  | { kind: "none" }
  | { kind: "state" }
  | { kind: "external" }
  | { kind: "path"; core: string; suffix: string; rooted: boolean };

/** Split a trailing `?query` or `#fragment` off a path-like value. */
export function splitQueryHash(value: string): { core: string; suffix: string } {
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i];
    if (ch === "?" || ch === "#") {
      return { core: value.slice(0, i), suffix: value.slice(i) };
    }
  }
  return { core: value, suffix: "" };
}

/**
 * Classify a reference value. State-scope refs (`#/state/…`, `$map/…`, `parent#…`, `window#…`,
 * `document#…`) and external URLs (`http:`, `data:`, protocol-relative `//…`) are never file paths.
 * Everything else is treated as a `path`; the resolve-and-compare gate in `rewriteRef` provides the
 * actual precision, so bare npm specifiers (which never resolve to the renamed file) are simply
 * never matched.
 */
export function classifyRef(value: unknown): RefClass {
  if (typeof value !== "string" || value.length === 0) {
    return { kind: "none" };
  }
  if (
    value === "$map" ||
    value.startsWith("#") ||
    value.startsWith("$map/") ||
    value.startsWith("parent#") ||
    value.startsWith("window#") ||
    value.startsWith("document#")
  ) {
    return { kind: "state" };
  }
  // Absolute URL with a scheme (http:, data:, mailto:) or protocol-relative (//host).
  if (value.startsWith("//") || /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value)) {
    return { kind: "external" };
  }
  const { core, suffix } = splitQueryHash(value);
  if (core.length === 0) {
    return { kind: "none" };
  }
  return { core, kind: "path", rooted: core.startsWith("/"), suffix };
}

/** Collapse `.`/`..` segments in a POSIX path. Absolute paths cannot escape above root. */
export function normalizeSegments(path: string): string {
  const isAbs = path.startsWith("/");
  const out: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") {
      continue;
    }
    if (part === "..") {
      if (out.length > 0 && out.at(-1) !== "..") {
        out.pop();
      } else if (!isAbs) {
        out.push("..");
      }
      continue;
    }
    out.push(part);
  }
  return (isAbs ? "/" : "") + out.join("/");
}

/**
 * Join `rel` onto an absolute POSIX `base` and normalise (a leading "/" on rel still joins to
 * base).
 */
export function joinPosix(base: string, rel: string): string {
  return normalizeSegments(`${base}/${rel}`);
}

/**
 * Relative path from directory `fromDir` to `to` (both absolute POSIX). Returns a bare path for
 * descendants ("a/b.json") and "../"-chains otherwise — without a leading "./" (callers add it to
 * preserve author style).
 */
export function relativeChain(fromDir: string, to: string): string {
  const fromParts = fromDir.split("/").filter(Boolean);
  const toParts = to.split("/").filter(Boolean);
  let common = 0;
  while (
    common < fromParts.length &&
    common < toParts.length &&
    fromParts[common] === toParts[common]
  ) {
    common += 1;
  }
  const ups = fromParts.length - common;
  const remaining = toParts.slice(common);
  return (ups > 0 ? "../".repeat(ups) : "") + remaining.join("/");
}

/** True when `p` is `dir` itself or nested under it. */
export function isUnder(p: string, dir: string): boolean {
  return p === dir || p.startsWith(`${dir}/`);
}

/**
 * Remap a resolved absolute target across a rename. If the target is the renamed file (or under the
 * renamed directory), re-root it onto the new location; otherwise it is unaffected.
 */
export function remapTarget(targetOld: string, oldAbs: string, newAbs: string): string {
  if (targetOld === oldAbs) {
    return newAbs;
  }
  if (isUnder(targetOld, oldAbs)) {
    return newAbs + targetOld.slice(oldAbs.length);
  }
  return targetOld;
}

/**
 * Every project-relative path a rooted (site-URL) reference could name, most-preferred first.
 *
 * @param {string} core - The reference with any `?query`/`#fragment` already split off
 * @param {readonly AssetMount[]} mounts - Project-relative asset mounts
 * @returns {string[]} Candidate project-relative paths
 */
export function projectPathsForRootedRef(core: string, mounts: readonly AssetMount[]): string[] {
  return projectPathsForSiteUrl(core, mounts, READ_LANES);
}

/** A final path segment must carry an extension, and the extension must contain a letter. */
const FILE_SEGMENT_RE = /^[^.][^/]*\.[A-Za-z0-9]{0,7}[A-Za-z][A-Za-z0-9]{0,7}$/;

/**
 * True when a string is shaped like a file a document could reference.
 *
 * The walker in refs.ts knows eleven keys that carry references by name. The commonest media
 * reference in a real project is under none of them — a schema-typed component prop (`$props.bg`),
 * a content entry's frontmatter (`cover:`), `project.json`'s `defaults.layout` — so the walker
 * falls back to SHAPE for every other key, and this is the shape test.
 *
 * It is deliberately not schema-aware. `walkDocRefs` is pure and schema-blind by design, and the
 * write side shares it; a schema oracle would have to be threaded through `applyRename` too, would
 * need a project-wide `tagName → media prop` index from a second pass, and would still miss a prop
 * whose component definition failed to parse.
 *
 * Precision does not come from here. It comes from the resolve-and-compare gate the callers already
 * apply: a candidate only counts when it resolves to the exact file queried. This just has to be
 * cheap and to refuse prose. The extension requirement is what does that — it rejects routes
 * (`/pricing`), bare words, MIME types (`image/png`) and identifiers, and the letter-in-extension
 * rule additionally rejects version strings (`1.2.3`), which are otherwise file-shaped.
 *
 * @param {string} value
 * @returns {boolean}
 */
export function looksLikeFileRef(value: string): boolean {
  if (value.length === 0 || /\s/.test(value) || value.includes("${")) {
    return false;
  }
  const cls = classifyRef(value);
  if (cls.kind !== "path") {
    return false;
  }
  const last = cls.core.slice(cls.core.lastIndexOf("/") + 1);
  return FILE_SEGMENT_RE.test(last);
}

/**
 * Restore a trailing slash the path math dropped, when the author wrote one.
 *
 * `normalizeSegments` discards empty segments, so `./content/posts/` resolves and re-emits as
 * `./content/posts`. For a file that is invisible; for a DIRECTORY reference — a content
 * collection's `source` — it is a gratuitous edit to a line the rename had no business restyling,
 * and `rewriteRef`'s contract is to preserve the authored style. A bare `/` is left alone: it is
 * already only a slash.
 */
function keepTrailingSlash(out: string, core: string): string {
  return core.endsWith("/") && core !== "/" && !out.endsWith("/") ? `${out}/` : out;
}

/** Context describing a single rename, shared by every reference rewrite within one document. */
export interface RemapCtx {
  /** Absolute POSIX project root. */
  root: string;
  /** Absolute POSIX path of the renamed file/dir, before the move. */
  oldAbs: string;
  /** Absolute POSIX path of the renamed file/dir, after the move. */
  newAbs: string;
  /** Directory the referencing document lived in before the move. */
  docOldDir: string;
  /**
   * Directory the referencing document lives in after the move (differs from docOldDir only when
   * the document itself is inside the moved subtree).
   */
  docNewDir: string;
  /**
   * Project-relative asset mounts, for resolving rooted references through the mount lane. Absent
   * is the same as none, which leaves the `root` and `public/` lanes.
   */
  mounts?: readonly AssetMount[];
}

/**
 * Recompute a single path reference for a rename, preserving its original style. Returns the new
 * string, or null when nothing changes.
 *
 * `rootRelativeBare` makes a bare value (no "./" or "../") resolve against the project root rather
 * than the document directory — used for `$layout`, which the compiler resolves against projectRoot
 * (layout-resolver.ts), and for site-relative conventions.
 */
export function rewriteRef(
  cls: { core: string; suffix: string; rooted: boolean },
  ctx: RemapCtx,
  rootRelativeBare = false,
): string | null {
  const { core, rooted, suffix } = cls;
  if (rooted) {
    return rewriteSiteUrl(core, suffix, ctx);
  }
  const startsRel = core.startsWith("./") || core.startsWith("../");
  const useRoot = rootRelativeBare && !startsRel;
  const baseOld = useRoot ? ctx.root : ctx.docOldDir;
  const baseNew = useRoot ? ctx.root : ctx.docNewDir;

  const targetOld = joinPosix(baseOld, core);
  const targetNew = remapTarget(targetOld, ctx.oldAbs, ctx.newAbs);
  if (targetNew === targetOld && baseOld === baseNew) {
    return null;
  }

  const rel = relativeChain(baseNew, targetNew);
  let out: string;
  if (rel.startsWith("..")) {
    out = rel;
  } else if (core.startsWith("./")) {
    out = `./${rel}`;
  } else {
    out = rel;
  }
  out = keepTrailingSlash(out, core) + suffix;
  return out === core + suffix ? null : out;
}

/**
 * Rewrite a rooted reference — a site URL — across a rename, through the lanes that give it
 * meaning.
 *
 * Each lane is tried on its own so the MATCHED one is known: a lane is only a candidate when the
 * file it names is the one that moved. The answer is then re-derived from the destination through
 * {@link AUTHORED_LANES}, which is what turns a `public/` move into the right URL rather than a
 * root-relative path that would 404 on the deployed site.
 *
 * Returns null when no lane names the moved file, which is the overwhelmingly common case — most
 * references in a document have nothing to do with any given rename.
 */
function rewriteSiteUrl(core: string, suffix: string, ctx: RemapCtx): string | null {
  const mounts = ctx.mounts ?? [];
  for (const lane of READ_LANES) {
    const [candidate] = projectPathsForSiteUrl(core, mounts, [lane]);
    if (candidate === undefined) {
      continue;
    }
    const targetOld = joinPosix(ctx.root, candidate);
    const targetNew = remapTarget(targetOld, ctx.oldAbs, ctx.newAbs);
    if (targetNew === targetOld) {
      continue;
    }
    const url = siteUrlForPath(relativeChain(ctx.root, targetNew), mounts, AUTHORED_LANES);
    if (url === null) {
      continue;
    }
    const out = keepTrailingSlash(url, core) + suffix;
    return out === core + suffix ? null : out;
  }
  return null;
}
