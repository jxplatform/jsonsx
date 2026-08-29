/**
 * Scan.ts — the project document sweep the refactor engines share.
 *
 * `applyRename` (write pass) and `findReferences` (read pass) walk exactly the same file set: every
 * JSON document plus every extension the project's format registry claims, minus the vendored /
 * build / agent directories. Keeping one definition of "the project's documents" is the point — a
 * rename that rewrites a file the usage count never looked at is a lie in both directions.
 */

import { extname } from "node:path";
import { readFile } from "node:fs/promises";
import type { FormatRegistry } from "@jxsuite/schema/format-registry";

/** Normalise a path to forward slashes (Windows `path` returns backslashes). */
export const fwd = (p: string) => p.replaceAll("\\", "/");

/** One authored value to replace in a document's own source text. */
export interface ValueEdit {
  from: string;
  to: string;
}

/** A parsed document and the two ways it might be written back. */
export interface LoadedDoc {
  doc: unknown;
  /** Round-trips the whole document. Null when the format declares no `serialize`. */
  serialize: ((doc: unknown) => Promise<string>) | null;
  /**
   * Replaces authored values in the file's own bytes, changing nothing else. Null when the format
   * declares no `rewrite`.
   *
   * The narrower of the two, and the only one a load-only format can offer: a CSV collection is a
   * data source entries are read FROM, so there is no document to serialize — but one cell's text
   * can be changed without inventing a quoting style. `applyRename` prefers `serialize` where it
   * exists, because a full round trip can express a change (a tag rename) that a list of value
   * edits cannot.
   */
  rewrite: ((edits: readonly ValueEdit[]) => Promise<string>) | null;
}

const isJsonPath = (p: string) => p.endsWith(".json");

/**
 * Skip vendored / build / agent directories (mirrors the component-discovery filter), and generated
 * schema artifacts.
 *
 * Every committed `*.schema.json` in a project is a build output — `bun run schema:generate-all`
 * composes the `project.schema.json` / `document.schema.json` pair into each project root — and the
 * generators embed live `examples` blocks. `project.core.schema.json`'s `$head` example carries
 * `/favicon.svg`, and the per-project entry schema enumerates the project's own layouts, so a sweep
 * that reads them makes every project report its own schema as a referrer of its favicon and its
 * base layout. Those are not references anyone authored, and nobody should be told a rename will
 * break one.
 *
 * The stale-schema problem a skipped file leaves behind already has an owner: `bun run
 * schema:verify` catches it and `schema:sync` regenerates it. A rewrite here would be a second
 * writer on a generated file.
 */
export function skipScanPath(match: string): boolean {
  const f = fwd(match);
  return (
    match.includes("node_modules") ||
    f.includes("dist/") ||
    f.includes(".claude/") ||
    f.endsWith(".schema.json")
  );
}

/** Build the recursive glob covering JSON plus every registered document/content extension. */
export function documentGlob(registry: FormatRegistry): Bun.Glob {
  const exts = new Set(["json"]);
  for (const ext of registry.documentExtensions()) {
    exts.add(ext.replace(/^\./, ""));
  }
  return new Bun.Glob(`**/*.{${[...exts].join(",")}}`);
}

/**
 * Read + parse a file, returning the doc and whichever write-back paths the format declares. Throws
 * when no parser claims the extension.
 */
export async function loadDoc(fp: string, registry: FormatRegistry): Promise<LoadedDoc> {
  const raw = await readFile(fp, "utf8");
  if (isJsonPath(fp)) {
    const trailingNewline = raw.endsWith("\n");
    return {
      doc: JSON.parse(raw) as unknown,
      rewrite: null,
      serialize: (doc) =>
        Promise.resolve(JSON.stringify(doc, null, 2) + (trailingNewline ? "\n" : "")),
    };
  }
  const ext = extname(fp);
  const parseEntry = registry.byExtension(ext, "parse");
  if (!parseEntry) {
    throw new Error(`No parser for "${ext}"`);
  }
  const doc = await parseEntry.call("parse", raw);
  const serializeEntry = registry.byExtension(ext, "serialize");
  const rewriteEntry = registry.byExtension(ext, "rewrite");
  return {
    doc,
    rewrite: rewriteEntry
      ? async (edits) => {
          const out = await rewriteEntry.call("rewrite", raw, edits);
          return typeof out === "string" ? out : String(out);
        }
      : null,
    serialize: serializeEntry
      ? async (d) => {
          const out = await serializeEntry.call("serialize", d);
          return typeof out === "string" ? out : String(out);
        }
      : null,
  };
}
