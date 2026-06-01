/**
 * Convert JSDoc @typedef blocks in .ts files to proper TypeScript declarations.
 *
 * Handles three patterns: 1. Import typedefs: @typedef {import("./path").Type} Name → import type {
 * Type } from "./path" 2. Object typedefs: @typedef {Object} Name + @property lines → interface
 * Name { ... } 3. Inline typedefs: @typedef {{ prop: type }} Name → interface Name { ... } 4. Alias
 * typedefs: @typedef {SomeType} Name → type Name = SomeType
 *
 * Usage: bun scripts/convert-typedefs.ts [--dry-run] [path...]
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve, relative } from "node:path";
import { Glob } from "bun";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const paths = args.filter((a) => !a.startsWith("--"));

// Find all .ts files with @typedef
async function findFiles(): Promise<string[]> {
  if (paths.length > 0) return paths.map((p) => resolve(p));

  const glob = new Glob("packages/**/src/**/*.ts");
  const testGlob = new Glob("packages/**/tests/**/*.ts");
  const files: string[] = [];

  for await (const path of glob.scan({ cwd: process.cwd(), absolute: true })) {
    const content = readFileSync(path, "utf-8");
    if (content.includes("@typedef")) files.push(path);
  }
  for await (const path of testGlob.scan({ cwd: process.cwd(), absolute: true })) {
    const content = readFileSync(path, "utf-8");
    if (content.includes("@typedef")) files.push(path);
  }

  return files;
}

interface ImportTypedef {
  kind: "import";
  localName: string;
  importedName: string;
  modulePath: string;
}

interface ObjectTypedef {
  kind: "object";
  name: string;
  properties: { name: string; type: string; optional: boolean; description: string }[];
}

interface InlineTypedef {
  kind: "inline";
  name: string;
  body: string;
}

interface AliasTypedef {
  kind: "alias";
  name: string;
  target: string;
}

type TypedefBlock = ImportTypedef | ObjectTypedef | InlineTypedef | AliasTypedef;

/**
 * Strip JSDoc comment artifacts from a multi-line block. Removes leading " * " or " *" from each
 * line, and the opening/closing markers.
 */
function stripCommentArtifacts(text: string): string {
  return text
    .replace(/^\s*\/\*\*\s*/, "")
    .replace(/\s*\*\/\s*$/, "")
    .split("\n")
    .map((line) => line.replace(/^\s*\*\s?/, ""))
    .join("\n")
    .trim();
}

/** Parse a single @typedef entry (may be part of a multi-typedef comment block) */
function parseTypedef(block: string): TypedefBlock | null {
  // Strip JSDoc artifacts for cleaner parsing
  const clean = stripCommentArtifacts(block);

  // Pattern 1: import typedef
  const importMatch = clean.match(/@typedef\s+\{import\(["']([^"']+)["']\)\.([^}]+)\}\s+(\w+)/);
  if (importMatch) {
    return {
      kind: "import",
      modulePath: importMatch[1],
      importedName: importMatch[2].trim(),
      localName: importMatch[3],
    };
  }

  // Pattern 2: object typedef with @property lines
  const objectMatch = clean.match(/@typedef\s+\{[Oo]bject\}\s+(\w+)/);
  if (objectMatch) {
    const name = objectMatch[1];
    const properties: { name: string; type: string; optional: boolean; description: string }[] = [];

    const propRegex = /@property\s+\{([^}]+)\}\s+(\[)?([^\]\s-]+)\]?\s*-?\s*(.*)/g;
    let match;
    while ((match = propRegex.exec(clean)) !== null) {
      const type = match[1].trim();
      const optional = match[2] === "[";
      const propName = match[3].replace(/^\./, "");
      const description = match[4]?.trim() || "";
      properties.push({ name: propName, type, optional, description });
    }

    return { kind: "object", name, properties };
  }

  // Pattern 3: inline multi-line typedef  @typedef {{ ... }} Name
  // Need to match balanced braces across multiple lines
  const inlineStart = clean.match(/@typedef\s+(\{\{)/);
  if (inlineStart) {
    // Find the matching closing }} and the Name after it
    const startIdx = clean.indexOf("{{", clean.indexOf("@typedef"));
    let depth = 0;
    let endIdx = startIdx;
    for (let i = startIdx; i < clean.length; i++) {
      if (clean[i] === "{") depth++;
      if (clean[i] === "}") {
        depth--;
        if (depth === 0) {
          endIdx = i;
          break;
        }
      }
    }
    const body = clean.slice(startIdx + 1, endIdx); // strip outer { }, keep inner { }
    const afterBrace = clean.slice(endIdx + 1).trim();
    const nameMatch = afterBrace.match(/^(\w+)/);
    if (nameMatch) {
      const name = nameMatch[1];
      // Clean up the body - it's already TS syntax inside
      const cleanBody = "{ " + body.trim().replace(/^\{/, "").replace(/\}$/, "").trim() + " }";
      return { kind: "inline", name, body: cleanBody };
    }
  }

  // Pattern 3b: single-line inline typedef  @typedef {{ key: type }} Name
  const singleInlineMatch = clean.match(/@typedef\s+(\{\{[^}]*\}\})\s+(\w+)/);
  if (singleInlineMatch) {
    const body = singleInlineMatch[1];
    const name = singleInlineMatch[2];
    // {{ x: T }} → { x: T }
    const cleanBody = body.replace(/^\{\{/, "{").replace(/\}\}$/, "}");
    return { kind: "inline", name, body: cleanBody };
  }

  // Pattern 4: simple alias  @typedef {SomeType} Name
  const aliasMatch = clean.match(/@typedef\s+\{([^}]+)\}\s+(\w+)/);
  if (aliasMatch) {
    const target = aliasMatch[1].trim();
    const name = aliasMatch[2];
    if (target === "object" || target === "Object") {
      // Object with no properties — just use Record<string, unknown>
      return { kind: "alias", name, target: "Record<string, unknown>" };
    }
    if (target.startsWith("import(")) return null; // handled above
    return { kind: "alias", name, target };
  }

  return null;
}

/** Convert a parsed typedef to TypeScript source */
function typedefToTS(td: TypedefBlock): string {
  switch (td.kind) {
    case "import": {
      const mod = td.modulePath.replace(/\.js$/, ".ts");
      if (td.importedName === td.localName) {
        return `import type { ${td.importedName} } from "${mod}";`;
      }
      return `import type { ${td.importedName} as ${td.localName} } from "${mod}";`;
    }
    case "object": {
      const lines = [`interface ${td.name} {`];
      for (const prop of td.properties) {
        const opt = prop.optional ? "?" : "";
        const comment = prop.description ? ` // ${prop.description}` : "";
        lines.push(`  ${prop.name}${opt}: ${convertJSDocType(prop.type)};${comment}`);
      }
      lines.push("}");
      return lines.join("\n");
    }
    case "inline": {
      // Convert {{ key: type; key2: type }} to interface
      return `interface ${td.name} ${td.body}`;
    }
    case "alias": {
      return `type ${td.name} = ${td.target};`;
    }
  }
}

/** Convert JSDoc type syntax to TS type syntax */
function convertJSDocType(jsdocType: string): string {
  let t = jsdocType;
  // JSDoc nullable: ?Type → Type | null
  if (t.startsWith("?")) {
    t = t.slice(1) + " | null";
  }
  // JSDoc optional: Type= → Type | undefined (but this is usually handled by [])
  if (t.endsWith("=")) {
    t = t.slice(0, -1) + " | undefined";
  }
  // Array.<Type> → Type[]
  t = t.replace(/Array\.<([^>]+)>/g, "$1[]");
  t = t.replace(/Array<([^>]+)>/g, "$1[]");
  // Object.<K, V> → Record<K, V>
  t = t.replace(/Object\.<([^,>]+),\s*([^>]+)>/g, "Record<$1, $2>");
  // * → unknown
  t = t.replace(/^\*$/, "unknown");
  return t;
}

/** Extract JSDoc comment blocks from source */
function extractCommentBlocks(source: string): { start: number; end: number; text: string }[] {
  const blocks: { start: number; end: number; text: string }[] = [];
  const regex = /\/\*\*[\s\S]*?\*\//g;
  let match;
  while ((match = regex.exec(source)) !== null) {
    if (match[0].includes("@typedef")) {
      blocks.push({ start: match.index, end: match.index + match[0].length, text: match[0] });
    }
  }
  return blocks;
}

/** Process a single file */
function processFile(filePath: string): {
  modified: boolean;
  imports: string[];
  interfaces: string[];
  removals: { start: number; end: number }[];
} {
  const source = readFileSync(filePath, "utf-8");
  const blocks = extractCommentBlocks(source);

  if (blocks.length === 0) return { modified: false, imports: [], interfaces: [], removals: [] };

  const imports: string[] = [];
  const interfaces: string[] = [];
  const removals: { start: number; end: number }[] = [];

  for (const block of blocks) {
    // Strip the comment markers to work with clean text
    const cleanBlock = stripCommentArtifacts(block.text);

    // Split on @typedef boundaries (each one starts a new typedef)
    const entries: string[] = [];
    const parts = cleanBlock.split(/(?=@typedef\s)/);
    for (const part of parts) {
      if (part.includes("@typedef")) entries.push(part.trim());
    }

    // Check if the whole block is only typedefs
    const hasNonTypedefContent = cleanBlock.match(/@(?!typedef\b|property\b)\w+/);
    let parsedAny = false;

    for (const entry of entries) {
      const parsed = parseTypedef("/**\n * " + entry + "\n */");
      if (!parsed) continue;

      parsedAny = true;
      const ts = typedefToTS(parsed);

      if (parsed.kind === "import") {
        imports.push(ts);
      } else {
        interfaces.push(ts);
      }
    }

    // Only remove the comment block if it ONLY contains @typedef content
    if (parsedAny && !hasNonTypedefContent) {
      removals.push({ start: block.start, end: block.end });
    }
  }

  return { modified: imports.length > 0 || interfaces.length > 0, imports, interfaces, removals };
}

/** Apply transformations to a file's source */
function applyTransformations(filePath: string, result: ReturnType<typeof processFile>): string {
  let source = readFileSync(filePath, "utf-8");

  // Remove typedef comment blocks (reverse order to preserve offsets)
  const sortedRemovals = [...result.removals].sort((a, b) => b.start - a.start);
  for (const { start, end } of sortedRemovals) {
    // Also remove trailing newline after the block
    let removeEnd = end;
    while (source[removeEnd] === "\n" || source[removeEnd] === "\r") removeEnd++;
    source = source.slice(0, start) + source.slice(removeEnd);
  }

  // Find insertion point for imports (after existing imports)
  let lastImportEnd = 0;
  const importRegex = /^import\s.+?(?:from\s+["'][^"']+["']|["'][^"']+["'])\s*;?\s*$/gm;
  let importMatch;
  while ((importMatch = importRegex.exec(source)) !== null) {
    lastImportEnd = importMatch.index + importMatch[0].length;
  }

  // Deduplicate imports against existing ones
  const existingImports = source.slice(0, lastImportEnd);
  const newImports = result.imports.filter((imp) => {
    // Extract the type name being imported
    const nameMatch = imp.match(/\{\s*(\w+)(?:\s+as\s+(\w+))?\s*\}/);
    if (!nameMatch) return true;
    const name = nameMatch[2] || nameMatch[1];
    // Check if already imported
    return !existingImports.includes(name);
  });

  // Build the insertion text
  const parts: string[] = [];
  if (newImports.length > 0) {
    parts.push(newImports.join("\n"));
  }
  if (result.interfaces.length > 0) {
    parts.push(result.interfaces.join("\n\n"));
  }

  if (parts.length === 0) return source;

  // Insert after last import, or at top of file after any initial comments
  if (lastImportEnd > 0) {
    const insertion = "\n" + parts.join("\n\n") + "\n";
    source = source.slice(0, lastImportEnd) + insertion + source.slice(lastImportEnd);
  } else {
    // No imports — put after initial comment block if any
    const headerMatch = source.match(/^\/\*\*[\s\S]*?\*\/\s*\n?/);
    const insertAt = headerMatch ? headerMatch[0].length : 0;
    const insertion = parts.join("\n\n") + "\n\n";
    source = source.slice(0, insertAt) + insertion + source.slice(insertAt);
  }

  return source;
}

// Also convert inline @type casts: /** @type {X} */ → remove (TS already typed)
// And @type in variable declarations: /** @type {X} */ const y = ... → const y: X = ...

async function main() {
  const files = await findFiles();
  console.log(`Found ${files.length} files with @typedef annotations`);

  let totalConverted = 0;

  for (const file of files) {
    const result = processFile(file);
    if (!result.modified) continue;

    const newSource = applyTransformations(file, result);
    const relPath = relative(process.cwd(), file);

    if (dryRun) {
      console.log(
        `[dry-run] ${relPath}: ${result.imports.length} imports, ${result.interfaces.length} interfaces`,
      );
      if (result.interfaces.length > 0) {
        console.log(result.interfaces.join("\n\n"));
        console.log("---");
      }
    } else {
      writeFileSync(file, newSource);
      console.log(
        `✓ ${relPath}: ${result.imports.length} imports, ${result.interfaces.length} interfaces`,
      );
    }

    totalConverted += result.imports.length + result.interfaces.length;
  }

  console.log(`\nTotal: ${totalConverted} typedef blocks converted across ${files.length} files`);
}

main();
