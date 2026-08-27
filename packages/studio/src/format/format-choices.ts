/**
 * Format-choices — the two derived predicates behind "which format may I create?" and "which format
 * may I convert to?".
 *
 * Both are computed from what a format class DECLARES — `capabilities.parse`,
 * `capabilities.serialize`, `format.documentKinds` — so a third format extension appears in the New
 * File picker and in Convert To with no edit to this file, which is the same contract
 * `format/format-host.ts` already keeps for opening and saving.
 *
 * Pure and synchronous over the loaded registry and `projectState`, because the Files tree's
 * context menu is built during a render and cannot await anything.
 */

import { collectionForFile } from "../content/collection-match";
import { documentExtensions, formatByExtension, formatForPath, getFormats } from "./format-host";
import { projectState } from "../store";

/** One row of a format picker: the extension it writes, and the name the reader sees. */
export interface FormatChoiceRow {
  ext: string;
  label: string;
}

/**
 * The document kinds that mean "this format's `parse` returns a Jx document".
 *
 * There is no separate declaration for the SHAPE `parse` returns, and none is needed: the compiler
 * builds its page and component globs from `documentExtensions("page")` /
 * `documentExtensions("component")` and casts every `parse` result to `JxDocument`
 * (`packages/compiler/src/site/pages-discovery.ts`). So declaring either kind IS the claim, already
 * relied upon by the build. A `content`-only format — Csv, whose `parse` returns
 * `ContentLoaderEntry[]` rows — makes no such claim and is excluded by the same test.
 */
const DOCUMENT_KINDS = ["page", "component"] as const;

/**
 * Where a Jx document lives.
 *
 * Both keys are conventions the build hard-codes rather than reads (`site-build.ts` resolves
 * `pages` against the project root), so a convert may lean on them. It is deliberately
 * conservative: a component kept in `shared/` is not offered a conversion, which is a smaller wrong
 * than offering one for `package.json`, `tsconfig.json` or a `nav.json` that no format and no
 * schema claims.
 */
const DOCUMENT_ROOTS = { components: "component", pages: "page" } as const;

/** Normalise a project-relative path for prefix comparison. */
function normalize(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\.\//, "");
}

/** Which document root a path sits under, or null. */
function documentRootOf(path: string): "page" | "component" | null {
  const lower = normalize(path).toLowerCase();
  for (const [dir, kind] of Object.entries(DOCUMENT_ROOTS)) {
    if (lower.startsWith(`${dir}/`)) {
      return kind;
    }
  }
  return null;
}

/** Whether a format declares at least one of the document kinds. */
function declaresDocumentKind(kinds: readonly string[]): boolean {
  return DOCUMENT_KINDS.some((kind) => kinds.includes(kind));
}

/**
 * Whether this path is (or is used as) a layout.
 *
 * Layouts are JSON at BOTH readers — `packages/compiler/src/site/layout-resolver.ts` `JSON.parse`s
 * and throws, `packages/studio/src/site-context.ts` `JSON.parse`s and silently returns null — and
 * there is no `"layout"` document kind for a format to declare, so this clause is hand-written and
 * cannot be derived. `layouts/` is excluded by {@link DOCUMENT_ROOTS} already; what remains is a
 * project whose `layout` points somewhere inside a document root.
 */
function isLayoutPath(path: string): boolean {
  const declared = projectState?.projectConfig?.layout;
  if (typeof declared !== "string") {
    return false;
  }
  return normalize(declared).toLowerCase() === normalize(path).toLowerCase();
}

/**
 * The rows the New File format picker offers, `.json` first.
 *
 * A format qualifies only when SOME registered class can both `parse` and `serialize` its
 * extension. Both halves are load-bearing and neither is cosmetic:
 *
 * - Without `parse`, opening the file that was just created throws `noFormatError`
 *   (`files/file-ops.ts`'s `parseSourceForPath`);
 * - Without `serialize`, the first save falls through to `defaultContentFormat()` and writes ANOTHER
 *   format's bytes into the file (`files/file-ops.ts`'s `serializeDocument`).
 *
 * Looked up per `(extension, capability)` rather than per format row because the registry
 * deliberately legalises a split claim — one class parsing an extension, another serializing it.
 *
 * @param kind - Restrict to formats declaring this document kind (the Library's New ▸ Page).
 * @returns The picker's format rows, without the caller's own sentinel rows.
 */
export function creationFormats(kind?: "page" | "component" | "content"): FormatChoiceRow[] {
  const rows: FormatChoiceRow[] = [{ ext: ".json", label: "JSON (.json)" }];
  for (const ext of documentExtensions(kind)) {
    const reader = formatByExtension(ext, "parse");
    if (reader && formatByExtension(ext, "serialize")) {
      rows.push({ ext, label: `${reader.name} (${ext})` });
    }
  }
  return rows;
}

/**
 * Every extension the studio recognises as a document — `.json` plus everything any registered
 * format claims, whether or not it is creatable.
 *
 * This is the set a name is tested against, not {@link creationFormats}: a typed `notes.csv` must be
 * recognised as naming a format the picker did not offer, rather than treated as an unremarkable
 * suffix.
 */
export function knownDocumentExtensions(): Set<string> {
  return new Set([".json", ...getFormats().flatMap((format) => format.extensions)]);
}

/**
 * The formats this file may be converted INTO, or an empty list when it may not be converted at
 * all.
 *
 * Empty is the answer for, and only for:
 *
 * - A file outside `pages/` and `components/` — including every `.json` that is configuration rather
 *   than a document, and every `layouts/` file;
 * - The project's declared `layout`, wherever it lives;
 * - Anything inside a content collection, in EITHER direction. Converting an entry drops it out of
 *   its collection's discovery glob; converting a co-located file INTO the collection's format
 *   enlists it as an entry nobody seeded. Source and target share a directory, so one test covers
 *   both;
 * - A source whose format cannot `parse`, or declares no document kind (Csv);
 * - A source for which no OTHER format can `serialize` a document.
 *
 * @param path - Project-relative file path.
 * @returns The target rows, or `[]`.
 */
export function convertTargets(path: string | null | undefined): FormatChoiceRow[] {
  if (path === null || path === undefined || path === "") {
    return [];
  }
  const root = documentRootOf(path);
  if (root === null || isLayoutPath(path) || collectionForFile(path)) {
    return [];
  }

  const source = formatForPath(path);
  const readable = source
    ? Boolean(source.capabilities.parse) && declaresDocumentKind(source.documentKinds)
    : normalize(path).toLowerCase().endsWith(".json");
  if (!readable) {
    return [];
  }

  const rows: FormatChoiceRow[] = [];
  if (source) {
    rows.push({ ext: ".json", label: "JSON (.json)" });
  }
  for (const ext of documentExtensions()) {
    const writer = formatByExtension(ext, "serialize");
    if (
      !writer ||
      writer.name === source?.name ||
      !declaresDocumentKind(writer.documentKinds) ||
      !writer.documentKinds.includes(root)
    ) {
      continue;
    }
    rows.push({ ext, label: `${writer.name} (${ext})` });
  }
  return rows;
}

/**
 * Every extension that is a conversion target SOMEWHERE in this project — the enum behind
 * `file.convertFormat`'s `format` argument.
 *
 * Necessarily broader than {@link convertTargets}, which is answered per file: a command argument's
 * declared values cannot depend on another argument. The per-file rule still decides, and
 * `convertFile` re-checks it, so this list is what may be ASKED for and not what will be accepted.
 */
export function convertTargetExtensions(): string[] {
  const exts = new Set<string>([".json"]);
  for (const format of getFormats()) {
    if (!format.capabilities.serialize || !declaresDocumentKind(format.documentKinds)) {
      continue;
    }
    for (const ext of format.extensions) {
      exts.add(ext);
    }
  }
  return [...exts].toSorted();
}
