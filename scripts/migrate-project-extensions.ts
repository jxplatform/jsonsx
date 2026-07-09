/**
 * One-shot migration of a Jx project from the legacy imports/contentTypes model to the extension
 * model (specs/extensions.md v2). Self-contained and disposable — delete once every in-repo project
 * is migrated.
 *
 * Usage: bun scripts/migrate-project-extensions.ts <project-dir> [...more]
 *
 * Per project: drops @jxsuite/parser entries from `imports` (manifest-provided now), adds
 * `"extensions": ["@jxsuite/parser"]`, renames `contentTypes` → `content`, rewrites
 * `#/contentTypes/` ref strings across project.json and every pages JSON document, rewrites
 * `$context/contentTypes` in local class descriptors, and inserts `"$schema":
 * "./project.schema.json"` as the first key — preserving key order and the file's indentation.
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const PARSER_PREFIX = "@jxsuite/parser/";

function detectIndent(text: string): string {
  const match = text.match(/\n([\t ]+)"/);
  return match?.[1] ?? "  ";
}

/** Recursively rewrite `#/contentTypes/...` pointer strings to `#/content/...`. */
function rewriteRefs(value: unknown): unknown {
  if (typeof value === "string") {
    return value.startsWith("#/contentTypes/")
      ? value.replace("#/contentTypes/", "#/content/")
      : value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => rewriteRefs(item));
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = rewriteRefs(v);
    }
    return out;
  }
  return value;
}

function listFiles(dir: string, suffix: string): string[] {
  if (!existsSync(dir)) {
    return [];
  }
  return readdirSync(dir, { recursive: true })
    .map(String)
    .filter((f) => f.endsWith(suffix) && !f.includes("node_modules"))
    .map((f) => join(dir, f));
}

function migrateProject(root: string): void {
  const projectPath = join(root, "project.json");
  if (!existsSync(projectPath)) {
    console.error(`skip ${root}: no project.json`);
    return;
  }
  const text = readFileSync(projectPath, "utf8");
  const indent = detectIndent(text);
  const raw = JSON.parse(text) as Record<string, unknown>;

  // Drop parser imports (manifest-provided classes) but keep everything else.
  let droppedParserImport = false;
  const imports = raw.imports as Record<string, string> | undefined;
  if (imports) {
    for (const [name, target] of Object.entries(imports)) {
      if (typeof target === "string" && target.startsWith(PARSER_PREFIX)) {
        delete imports[name];
        droppedParserImport = true;
      }
    }
    if (Object.keys(imports).length === 0) {
      delete raw.imports;
    }
  }

  const hadContentTypes = "contentTypes" in raw;
  const needsParser = droppedParserImport || hadContentTypes;

  // Rebuild with $schema first, contentTypes renamed in place, and refs rewritten.
  const migrated: Record<string, unknown> = { $schema: "./project.schema.json" };
  for (const [key, value] of Object.entries(raw)) {
    if (key === "$schema") {
      continue;
    }
    if (key === "contentTypes") {
      migrated.content = rewriteRefs(value);
      continue;
    }
    if (key === "extensions") {
      continue; // Re-inserted below so parser can be appended exactly once
    }
    migrated[key] = rewriteRefs(value);
  }
  const extensions = Array.isArray(raw.extensions) ? ([...raw.extensions] as string[]) : [];
  if (needsParser && !extensions.includes("@jxsuite/parser")) {
    extensions.push("@jxsuite/parser");
  }
  if (extensions.length > 0) {
    migrated.extensions = extensions;
  }

  writeFileSync(projectPath, `${JSON.stringify(migrated, null, indent)}\n`, "utf8");
  console.log(`migrated ${projectPath}`);

  // Rewrite #/contentTypes/ pointers in page documents and $context/contentTypes in local class
  // Descriptors (none exist in-repo today, but local projects may carry them).
  for (const file of listFiles(join(root, "pages"), ".json")) {
    const pageText = readFileSync(file, "utf8");
    if (pageText.includes("#/contentTypes/")) {
      writeFileSync(file, pageText.replaceAll("#/contentTypes/", "#/content/"), "utf8");
      console.log(`  rewrote refs in ${file}`);
    }
  }
  for (const file of listFiles(root, ".class.json")) {
    const classText = readFileSync(file, "utf8");
    if (classText.includes("$context/contentTypes")) {
      writeFileSync(
        file,
        classText.replaceAll("$context/contentTypes", "$context/content"),
        "utf8",
      );
      console.log(`  rewrote $context refs in ${file}`);
    }
  }

  console.log(`  reminder: run \`jx schema ${root}\` to (re)generate the entry schemas`);
}

const roots = process.argv.slice(2);
if (roots.length === 0) {
  console.error("Usage: bun scripts/migrate-project-extensions.ts <project-dir> [...more]");
  process.exit(1);
}
for (const root of roots) {
  migrateProject(resolve(root));
}
