/**
 * Paths.ts — pure, OS-independent path math for the rename-refactor engine.
 *
 * Everything here operates on forward-slash POSIX strings and never touches the filesystem, so it
 * unit-tests deterministically. Callers (apply.ts) normalise real paths with `fwd()` before handing
 * them in. The relative-path style mirrors `computeRelativePath` in the studio
 * (packages/studio/src/files/components.ts): "./" for same-dir/descendant targets, "../"-chains
 * otherwise.
 */

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
  const startsRel = core.startsWith("./") || core.startsWith("../");
  const useRoot = rooted || (rootRelativeBare && !startsRel);
  const baseOld = useRoot ? ctx.root : ctx.docOldDir;
  const baseNew = useRoot ? ctx.root : ctx.docNewDir;

  const targetOld = joinPosix(useRoot ? ctx.root : baseOld, core);
  const targetNew = remapTarget(targetOld, ctx.oldAbs, ctx.newAbs);
  if (targetNew === targetOld && baseOld === baseNew) {
    return null;
  }

  let out: string;
  if (rooted) {
    out = `/${relativeChain(ctx.root, targetNew)}`;
  } else {
    const rel = relativeChain(baseNew, targetNew);
    if (rel.startsWith("..")) {
      out = rel;
    } else if (core.startsWith("./")) {
      out = `./${rel}`;
    } else {
      out = rel;
    }
  }
  out += suffix;
  return out === core + suffix ? null : out;
}
