/**
 * Typed parse boundary for Jx documents and configs.
 *
 * Raw `JSON.parse()` returns `any`, which silently disables checking for everything downstream.
 * These helpers are the single sanctioned crossing point: they parse, structurally verify, and
 * return the domain type — failures carry the source path.
 */

import type { JxClassDef, JxDocument, ProjectConfig } from "../types";
import { isJsonObject } from "./guards";

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
