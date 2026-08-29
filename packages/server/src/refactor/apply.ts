/**
 * Apply.ts — IO orchestrator for rename-refactoring, shared by the dev-server endpoint
 * (studio-api.ts) and the desktop project session.
 *
 * The caller performs the filesystem move first, then calls `applyRename`, which globs the
 * project's document + content files, runs the pure engines from refs.ts against each, writes back
 * only the files that changed, and returns a `RenameReport`. When the renamed file is a component,
 * the tag is auto-derived from the new filename and renamed everywhere it is used (Pillar C).
 */

import { basename, dirname, extname, relative, resolve } from "node:path";
import { stat, writeFile } from "node:fs/promises";
import { errorMessage } from "@jxsuite/schema/parse";
import { isUnder } from "./paths.ts";
import { rewriteDocRefs, rewriteTagName } from "./refs.ts";
import { documentGlob, fwd, loadDoc, skipScanPath } from "./scan.ts";
import { refactorMounts } from "./mounts.ts";
import type { RefChange } from "./refs.ts";
import type { AssetMount } from "@jxsuite/schema/asset-paths";
import type { FormatRegistry } from "@jxsuite/schema/format-registry";

export interface FileChange {
  path: string;
  count: number;
  changes: RefChange[];
}

export interface RenameReport {
  ok: boolean;
  from: string;
  to: string;
  isDir: boolean;
  references: {
    filesChanged: number;
    refsUpdated: number;
    files: FileChange[];
  };
  errors: { path: string; error: string }[];
  tag?: { from: string; to: string; filesChanged: number; refsUpdated: number };
  tagSkipped?: string;
}

export interface ApplyRenameOptions {
  /** Absolute project root to scan. */
  root: string;
  /** Absolute path of the renamed file/dir, before the move. */
  absFrom: string;
  /** Absolute path of the renamed file/dir, after the move (already on disk). */
  absTo: string;
  /** Format registry for the project (parse/serialize of non-JSON documents). */
  registry: FormatRegistry;
  /**
   * Project-relative asset mounts, for rewriting rooted references through the mount lane. Omitted,
   * the engine loads them from `root` — see `mounts.ts` for why that is the default and not the
   * exception.
   */
  mounts?: readonly AssetMount[];
}

/** Derive a custom-element tag from a component filename (strips `.class.json` or the extension). */
export function deriveTag(absPath: string): string {
  const base = basename(absPath);
  if (base.endsWith(".class.json")) {
    return base.slice(0, -".class.json".length);
  }
  const ext = extname(base);
  return ext ? base.slice(0, -ext.length) : base;
}

/**
 * Rewrite references (and, for components, the tag) across the project after a rename. The caller
 * must have already moved the file on disk.
 */
export async function applyRename(opts: ApplyRenameOptions): Promise<RenameReport> {
  const root = fwd(opts.root);
  const absFrom = fwd(opts.absFrom);
  const absTo = fwd(opts.absTo);
  const mounts = opts.mounts ?? (await refactorMounts(opts.root));

  let isDir = false;
  try {
    const stats = await stat(absTo);
    isDir = stats.isDirectory();
  } catch {
    isDir = false;
  }

  const report: RenameReport = {
    errors: [],
    from: fwd(relative(opts.root, opts.absFrom)),
    isDir,
    ok: true,
    references: { files: [], filesChanged: 0, refsUpdated: 0 },
    to: fwd(relative(opts.root, opts.absTo)),
  };

  // For a component file rename, derive the new tag from the new filename (Pillar C).
  let tagRename: { from: string; to: string } | null = null;
  if (!isDir) {
    try {
      const { doc } = await loadDoc(absTo, opts.registry);
      const oldTag = (doc as { tagName?: unknown }).tagName;
      const newTag = deriveTag(absTo);
      if (typeof oldTag === "string" && oldTag.includes("-") && newTag !== oldTag) {
        if (newTag.includes("-")) {
          tagRename = { from: oldTag, to: newTag };
        } else {
          report.tagSkipped = `Tag "${oldTag}" left unchanged: "${newTag}" is not a valid custom-element name`;
        }
      }
    } catch {
      // Not a parseable component — skip tag derivation.
    }
  }

  let tagFilesChanged = 0;
  let tagRefsUpdated = 0;

  for await (const match of documentGlob(opts.registry).scan({ cwd: opts.root, dot: false })) {
    if (skipScanPath(match)) {
      continue;
    }
    const fp = fwd(resolve(opts.root, match));
    try {
      const { doc, rewrite, serialize } = await loadDoc(fp, opts.registry);
      const docNewDir = dirname(fp);
      const docOldDir = isUnder(fp, absTo) ? dirname(absFrom + fp.slice(absTo.length)) : docNewDir;

      const { changes } = rewriteDocRefs(doc, {
        docNewDir,
        docOldDir,
        mounts,
        newAbs: absTo,
        oldAbs: absFrom,
        root,
      });
      const tagCount = tagRename ? rewriteTagName(doc, tagRename.from, tagRename.to).count : 0;

      if (changes.length === 0 && tagCount === 0) {
        continue;
      }
      /*
       * Two ways to write a document back, and the narrower one is not a fallback for a broken
       * format — it is the only honest promise a load-only format can make. A CSV collection has a
       * parser and deliberately no serializer, so a reference living in one used to be COUNTED and
       * then reported as a remainder the author had to repair by hand (issue 246). `rewrite`
       * replaces the authored values in the file's own bytes and changes nothing else, which is all
       * a rename ever needed.
       *
       * `serialize` still wins where it exists: a full round trip can express a change a list of
       * value edits cannot. A TAG rename is exactly such a change, so a document carrying one and
       * no serializer is still named in the report rather than half-written.
       */
      const written =
        serialize === null
          ? tagCount === 0 && rewrite !== null
            ? await rewrite(changes)
            : null
          : await serialize(doc);
      if (written === null) {
        report.errors.push({ error: `No serializer for "${match}"`, path: fwd(match) });
        continue;
      }
      await writeFile(fp, written);

      if (changes.length > 0) {
        report.references.files.push({ changes, count: changes.length, path: fwd(match) });
        report.references.filesChanged += 1;
        report.references.refsUpdated += changes.length;
      }
      if (tagCount > 0) {
        tagFilesChanged += 1;
        tagRefsUpdated += tagCount;
      }
    } catch (error) {
      report.errors.push({ error: errorMessage(error), path: fwd(match) });
    }
  }

  if (tagRename) {
    report.tag = {
      filesChanged: tagFilesChanged,
      from: tagRename.from,
      refsUpdated: tagRefsUpdated,
      to: tagRename.to,
    };
  }
  return report;
}
