/**
 * An `ImportIo` that keeps everything in a Map — the sink a caller with no filesystem supplies.
 *
 * Shared by the emit, asset-download and pipeline suites so all three assert the same contract:
 * project-relative forward-slashed keys, and nothing touching disk.
 */
import type { ImportIo } from "../src/io.ts";

export interface MemoryIo {
  io: ImportIo;
  /** Everything written, keyed by the project-relative path it was written under. */
  files: Map<string, string | Uint8Array>;
  /** Directories the sink was asked to create, in order. */
  dirs: string[];
  /** The text of one written file, for the common case of a JSON document. */
  text: (relPath: string) => string;
}

export function memoryIo(): MemoryIo {
  const files = new Map<string, string | Uint8Array>();
  const dirs: string[] = [];
  return {
    files,
    dirs,
    text(relPath) {
      const data = files.get(relPath);
      if (data === undefined) {
        throw new Error(`nothing was written to "${relPath}"`);
      }
      return typeof data === "string" ? data : new TextDecoder().decode(data);
    },
    io: {
      write(relPath, data) {
        files.set(relPath, data);
        return Promise.resolve();
      },
      mkdir(relPath) {
        dirs.push(relPath);
        return Promise.resolve();
      },
    },
  };
}
