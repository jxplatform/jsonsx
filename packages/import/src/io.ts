/**
 * The sink every file an import produces goes through.
 *
 * The pipeline used to call `Bun.write(join(outDir, …))` at six sites, which made "run an import"
 * and "have a writable filesystem" the same requirement. Jx Cloud is a Cloudflare Worker: it has
 * neither `Bun` nor a disk, and commits the emitted project straight to git. So the destination is
 * a parameter now — `createLocalIo` is the disk implementation and the only one that imports
 * `node:fs`, and a Worker supplies its own without the pipeline knowing the difference.
 */

import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface ImportIo {
  /**
   * Write one file.
   *
   * `relPath` is PROJECT-RELATIVE and forward-slashed — `"pages/blog/post.json"`, never an absolute
   * path and never a backslash. A sink that has no filesystem uses it as a key verbatim; a sink
   * that does joins it onto its own root.
   */
  write: (relPath: string, data: string | Uint8Array) => Promise<void>;
  /**
   * Create an empty directory, if directories are a thing this sink has.
   *
   * Optional because they usually are not: a git tree, an object store and a zip all record only
   * the files, and an empty directory is unrepresentable in every one of them. The local import
   * still seeds `pages/`, `layouts/`, `components/` and `public/` up front so a host can open the
   * project the moment the run starts, which is what this exists for.
   */
  mkdir?: (relPath: string) => Promise<void>;
}

/** Split a project-relative path into segments, so a sink's own separator is the one used. */
function toSegments(relPath: string): string[] {
  return relPath.split("/").filter((segment) => segment !== "");
}

/** The disk sink: `outDir` plus the relative path, with parent directories created on demand. */
export function createLocalIo(outDir: string): ImportIo {
  const resolve = (relPath: string): string => join(outDir, ...toSegments(relPath));
  return {
    async write(relPath, data) {
      const path = resolve(relPath);
      await mkdir(dirname(path), { recursive: true });
      await Bun.write(path, data);
    },
    async mkdir(relPath) {
      await mkdir(resolve(relPath), { recursive: true });
    },
  };
}
