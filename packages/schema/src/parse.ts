/**
 * Typed parse boundary for Jx documents and configs.
 *
 * Raw `JSON.parse()` returns `any`, which silently disables checking for everything downstream.
 * These helpers are the single sanctioned crossing point: they parse, structurally verify, and
 * return the domain type — failures carry the source path.
 *
 * Being the single crossing point is also what makes it the right place to enforce I-JSON (RFC
 * 7493). `JSON.parse` accepts documents that mean something other than what they say — a repeated
 * key whose first value it discards, an integer it rounds — and a Jx document does not stay JSON:
 * it round-trips through markdown frontmatter and a CRDT, each rebuilding the object from the
 * parsed value. Whatever was dropped here is dropped for good.
 */

import type { JxClassDef, JxDocument, ProjectConfig } from "../types";
import { isJsonObject } from "./guards";
import { describeIJsonProblem, findIJsonProblems } from "./ijson";

// ─── Error helpers ──────────────────────────────────────────────────────────────

/** Extract a human-readable message from a caught `unknown`. */
export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Coerce a caught `unknown` to an Error without losing the original. */
export function toError(e: unknown): Error {
  return e instanceof Error ? e : new Error(String(e));
}

// ─── Parse helpers ──────────────────────────────────────────────────────────────

function parseObject(text: string, sourcePath: string, what: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`Failed to parse ${what} at ${sourcePath}: ${errorMessage(error)}`, {
      cause: error,
    });
  }
  if (!isJsonObject(parsed)) {
    throw new Error(`Invalid ${what} at ${sourcePath}: expected a JSON object`);
  }
  /*
   * An error rather than a warning, because both problems are silent data loss and neither has a
   * reading under which the author got what they wrote. The whole repository — 375 documents —
   * was already clean when this landed, so this rejects mistakes rather than existing work.
   */
  const problems = findIJsonProblems(text);
  if (problems.length > 0) {
    const described = problems.map((problem) => describeIJsonProblem(problem)).join("; ");
    throw new Error(`Invalid ${what} at ${sourcePath}: ${described}`);
  }
  return parsed;
}

/** Parse a Jx document (.json page/layout/component source). */
export function parseJxDocument(text: string, sourcePath: string): JxDocument {
  return parseObject(text, sourcePath, "Jx document") as JxDocument;
}

/** Parse a project.json site configuration. */
export function parseProjectConfig(text: string, sourcePath: string): ProjectConfig {
  return parseObject(text, sourcePath, "project config") as ProjectConfig;
}

/**
 * Parse a .class.json schema-defined class. Note: `$prototype: "Class"` is the canonical
 * discriminator but is not required — existing class files omit it.
 */
export function parseClassDef(text: string, sourcePath: string): JxClassDef {
  return parseObject(text, sourcePath, "class definition") as unknown as JxClassDef;
}
