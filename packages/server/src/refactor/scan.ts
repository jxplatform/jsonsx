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

/** A parsed document plus the serializer that round-trips it back to disk (null when none). */
export interface LoadedDoc {
  doc: unknown;
  serialize: ((doc: unknown) => Promise<string>) | null;
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
 * Read + parse a file, returning the doc and a matching serializer (null when the format can parse
 * but not serialize). Throws when no parser claims the extension.
 */
export async function loadDoc(fp: string, registry: FormatRegistry): Promise<LoadedDoc> {
  const raw = await readFile(fp, "utf8");
  if (isJsonPath(fp)) {
    const trailingNewline = raw.endsWith("\n");
    return {
      doc: JSON.parse(raw) as unknown,
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
  return {
    doc,
    serialize: serializeEntry
      ? async (d) => {
          const out = await serializeEntry.call("serialize", d);
          return typeof out === "string" ? out : String(out);
        }
      : null,
  };
}
