// Convert inline JSDoc @type annotations to TypeScript equivalents.
// Usage: bun run scripts/convert-jsdoc-casts.ts [--dry-run] [--file path] [packages/...]

import { Glob } from "bun";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const fileFlag = args.indexOf("--file");
let targets: string[] = [];

if (fileFlag >= 0 && args[fileFlag + 1]) {
  targets = [args[fileFlag + 1]];
} else {
  const dirs = args.filter((a) => !a.startsWith("--"));
  if (dirs.length === 0) dirs.push("packages");
  for (const dir of dirs) {
    const glob = new Glob("**/*.ts");
    for (const path of glob.scanSync({ cwd: dir, absolute: true })) {
      if (path.includes("node_modules") || path.includes("/dist/")) continue;
      targets.push(path);
    }
  }
}

interface Replacement {
  file: string;
  line: number;
  before: string;
  after: string;
}

const allReplacements: Replacement[] = [];
let filesModified = 0;
let totalReplacements = 0;

for (const filePath of targets) {
  const content = await Bun.file(filePath).text();
  if (!content.includes("@type")) continue;

  const result = convertFile(content, filePath);
  if (result.changed) {
    filesModified++;
    totalReplacements += result.replacements.length;
    allReplacements.push(...result.replacements);
    if (!dryRun) {
      await Bun.write(filePath, result.output);
    }
  }
}

if (dryRun) {
  console.log(
    `\n[DRY RUN] Would modify ${filesModified} files with ${totalReplacements} replacements\n`,
  );
  for (const r of allReplacements.slice(0, 50)) {
    console.log(`  ${r.file}:${r.line}`);
    console.log(`    - ${r.before.trim()}`);
    console.log(`    + ${r.after.trim()}`);
    console.log();
  }
  if (allReplacements.length > 50) {
    console.log(`  ... and ${allReplacements.length - 50} more`);
  }
} else {
  console.log(`Modified ${filesModified} files with ${totalReplacements} replacements`);
}

function convertFile(
  content: string,
  filePath: string,
): { output: string; changed: boolean; replacements: Replacement[] } {
  const replacements: Replacement[] = [];
  let output = content;
  let changed = false;

  // Pattern 5: catch (/** @type {unknown} */ e) → catch (e)
  output = output.replace(
    /catch\s*\(\s*\/\*\*\s*@type\s*\{unknown\}\s*\*\/\s*(\w+)\s*\)/g,
    (match, name, offset) => {
      const line = lineAt(content, offset);
      const replacement = `catch (${name})`;
      replacements.push({ file: filePath, line, before: match, after: replacement });
      return replacement;
    },
  );

  // Pattern 3: Double cast — /** @type {Outer} */ (/** @type {Inner} */ (expr))
  // → (expr as Inner as Outer)
  output = output.replace(
    /\/\*\*\s*@type\s*\{([^}]+)\}\s*\*\/\s*\(\s*\/\*\*\s*@type\s*\{([^}]+)\}\s*\*\/\s*\(([^)]*)\)\s*\)/g,
    (match, outerType, innerType, expr, offset) => {
      const line = lineAt(output, offset);
      const replacement = `(${expr.trim()} as ${innerType.trim()} as ${outerType.trim()})`;
      replacements.push({ file: filePath, line, before: match, after: replacement });
      return replacement;
    },
  );

  // Pattern 1-REST: Rest parameter: (/** @type {T} */ ...name) → (...name: T)
  output = output.replace(
    /(\((?:[^()]*,\s*)?)\/\*\*\s*@type\s*\{([^}]+)\}\s*\*\/\s*(\.\.\.(\w+))((?:\s*[,)])?)/g,
    (match, prefix, type, fullParam, _name, suffix, offset) => {
      const trimmedPrefix = prefix.trimEnd();
      if (!trimmedPrefix.endsWith("(") && !trimmedPrefix.endsWith(",")) {
        return match;
      }
      const line = lineAt(output, offset);
      const replacement = `${prefix}${fullParam}: ${type.trim()}${suffix}`;
      replacements.push({ file: filePath, line, before: match.trim(), after: replacement.trim() });
      return replacement;
    },
  );

  // Pattern 1-DESTRUCTURED: Destructured parameter: (/** @type {T} */ [a, b]) or (/** @type {T} */ {x, y})
  output = output.replace(
    /(\((?:[^()]*,\s*)?)\/\*\*\s*@type\s*\{([^}]+)\}\s*\*\/\s*(\[[^\]]*\]|\{[^}]*\})((?:\s*[,)])?)/g,
    (match, prefix, type, destructured, suffix, offset) => {
      const trimmedPrefix = prefix.trimEnd();
      if (!trimmedPrefix.endsWith("(") && !trimmedPrefix.endsWith(",")) {
        return match;
      }
      const line = lineAt(output, offset);
      const replacement = `${prefix}${destructured}: ${type.trim()}${suffix}`;
      replacements.push({ file: filePath, line, before: match.trim(), after: replacement.trim() });
      return replacement;
    },
  );

  // Pattern 1a: Function/callback parameter: /** @type {T} */ name where preceded by ( or ,
  // Also handles multi-line function params. Multiple passes to handle sequential params.
  let prevOutput = "";
  while (prevOutput !== output) {
    prevOutput = output;
    output = output.replace(
      /\/\*\*\s*@type\s*\{([^}]+)\}\s*\*\/\s*(\w+)(\s*[,):]?)/g,
      (match, type, name, suffix, offset) => {
        // Check what non-whitespace char precedes this comment
        const beforeSlice = output.slice(Math.max(0, offset - 80), offset);
        const trimmedBefore = beforeSlice.trimEnd();
        const lastChar = trimmedBefore[trimmedBefore.length - 1];
        // It's a param if preceded by ( or ,
        if (lastChar !== "(" && lastChar !== ",") return match;
        // If preceded by , — check wider context to distinguish function params from object properties
        // Object properties: the preceding , is inside { ... }
        // Function params: the preceding , is inside ( ... )
        if (lastChar === ",") {
          // Look back further to find the opening ( or {
          const widerBefore = output.slice(Math.max(0, offset - 500), offset);
          let parenDepth = 0;
          let braceDepth = 0;
          for (let k = widerBefore.length - 1; k >= 0; k--) {
            const ch = widerBefore[k];
            if (ch === ")") parenDepth++;
            else if (ch === "(") {
              if (parenDepth === 0) {
                break;
              } // found unmatched ( — we're in function params
              parenDepth--;
            } else if (ch === "}") braceDepth++;
            else if (ch === "{") {
              if (braceDepth === 0) {
                return match;
              } // found unmatched { — we're in object literal
              braceDepth--;
            }
          }
        }
        // If followed by : it's an object property annotation, not a param
        if (suffix.trimStart().startsWith(":")) return match;
        // Confirm it's followed by , or ) or has a newline-then-) pattern (end of params)
        const afterMatch = output
          .slice(offset + match.length, offset + match.length + 20)
          .trimStart();
        if (
          suffix.trimEnd().endsWith(",") ||
          suffix.trimEnd().endsWith(")") ||
          afterMatch.startsWith(",") ||
          afterMatch.startsWith(")") ||
          afterMatch.startsWith("{") ||
          afterMatch.startsWith("=>")
        ) {
          const line = lineAt(output, offset);
          const replacement = `${name}: ${type.trim()}${suffix}`;
          replacements.push({
            file: filePath,
            line,
            before: match.trim(),
            after: replacement.trim(),
          });
          return replacement;
        }
        return match;
      },
    );
  }

  // Pattern 6: Arrow/function param standalone: .map((/** @type {T} */ item) => ...)
  // Also handles: (/** @type {T} */ item, ...) multi-param where first wasn't caught
  output = output.replace(
    /\(\s*\/\*\*\s*@type\s*\{([^}]+)\}\s*\*\/\s*(\w+)\s*\)/g,
    (match, type, name, offset) => {
      const after = output.slice(offset + match.length, offset + match.length + 5).trimStart();
      if (after.startsWith("=>") || after.startsWith(",") || after.startsWith(")")) {
        const line = lineAt(output, offset);
        const replacement = `(${name}: ${type.trim()})`;
        replacements.push({ file: filePath, line, before: match, after: replacement });
        return replacement;
      }
      return match;
    },
  );

  // Pattern 4: Variable declaration: /** @type {T} */\n[const|let|var] name = ...
  // Or same-line variant: /** @type {T} */ const name = ...
  output = output.replace(
    /\/\*\*\s*@type\s*\{([^}]+)\}\s*\*\/\s*\n?(\s*)(export\s+)?(const|let|var)\s+(\w+)\s*=/g,
    (match, type, indent, exportKw, decl, name, offset) => {
      const line = lineAt(output, offset);
      const exportPrefix = exportKw || "";
      const replacement = `${indent}${exportPrefix}${decl} ${name}: ${type.trim()} =`;
      replacements.push({ file: filePath, line, before: match.trim(), after: replacement.trim() });
      return replacement;
    },
  );

  // Pattern 4b: Destructured declaration: /** @type {T} */ const { a, b } = ... or /** @type {T} */ const [a, b] = ...
  output = output.replace(
    /\/\*\*\s*@type\s*\{([^}]+)\}\s*\*\/\s*\n?(\s*)(export\s+)?(const|let|var)\s+(\{[^}]*\}|\[[^\]]*\])\s*=/g,
    (match, type, indent, exportKw, decl, destructured, offset) => {
      const line = lineAt(output, offset);
      const exportPrefix = exportKw || "";
      const replacement = `${indent}${exportPrefix}${decl} ${destructured}: ${type.trim()} =`;
      replacements.push({ file: filePath, line, before: match.trim(), after: replacement.trim() });
      return replacement;
    },
  );

  // Pattern 2: Expression cast: /** @type {T} */ (expr)
  // Use manual paren balancing to handle arbitrarily nested expressions
  output = replaceExprCasts(output, filePath, replacements);

  // Pattern 2b: Remaining simple casts: /** @type {T} */ identifier (not a param, not a keyword)
  const JS_KEYWORDS = new Set([
    "const",
    "let",
    "var",
    "function",
    "class",
    "return",
    "throw",
    "new",
    "typeof",
    "void",
    "delete",
    "if",
    "else",
    "for",
    "while",
    "do",
    "switch",
    "case",
    "break",
    "continue",
    "try",
    "catch",
    "finally",
    "import",
    "export",
    "default",
    "yield",
    "await",
    "in",
    "of",
    "instanceof",
  ]);
  output = output.replace(
    /\/\*\*\s*@type\s*\{([^}]+)\}\s*\*\/\s+([\w.[\]"']+)/g,
    (match, type, expr, offset) => {
      // Skip keywords — these are declaration annotations handled elsewhere
      if (JS_KEYWORDS.has(expr)) return match;
      const before = output.slice(Math.max(0, offset - 30), offset);
      if (/(?:const|let|var)\s*$/.test(before)) return match;
      const afterPos = offset + match.length;
      const afterChar = output.slice(afterPos, afterPos + 3).trimStart();
      if (afterChar.startsWith("=") && !afterChar.startsWith("==")) return match;
      // If followed by : it's an object property type annotation — skip (leave for manual fix)
      if (afterChar.startsWith(":")) return match;
      // If expr is a simple identifier and followed by , or ) — could be param OR object property
      // Only convert to param annotation if preceded by ( (unambiguous function start)
      if (/^\w+$/.test(expr) && (afterChar.startsWith(",") || afterChar.startsWith(")"))) {
        const beforeTrimmed = before.replace(/\s+/g, " ").trimEnd();
        const lastNonWs = beforeTrimmed[beforeTrimmed.length - 1];
        // Only convert if preceded by ( — comma is ambiguous (could be object or params)
        if (lastNonWs === "(") {
          const line = lineAt(output, offset);
          const replacement = `${expr}: ${type.trim()}`;
          replacements.push({ file: filePath, line, before: match, after: replacement });
          return replacement;
        }
        return match;
      }
      const line = lineAt(output, offset);
      const replacement = `(${expr} as ${type.trim()})`;
      replacements.push({ file: filePath, line, before: match, after: replacement });
      return replacement;
    },
  );

  changed = output !== content;
  return { output, changed, replacements };
}

function lineAt(content: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < content.length; i++) {
    if (content[i] === "\n") line++;
  }
  return line;
}

function replaceExprCasts(input: string, filePath: string, replacements: Replacement[]): string {
  const marker = /\/\*\*\s*@type\s*\{([^}]+)\}\s*\*\//g;
  let result = "";
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = marker.exec(input)) !== null) {
    const typeStr = match[1].trim();
    const matchEnd = match.index + match[0].length;

    // Skip whitespace after the comment
    let i = matchEnd;
    while (
      i < input.length &&
      (input[i] === " " || input[i] === "\t" || input[i] === "\n" || input[i] === "\r")
    )
      i++;

    // Must be followed by an opening paren to be an expression cast
    if (i >= input.length || input[i] !== "(") continue;

    // Balance parens to find the matching close
    let depth = 0;
    const exprStart = i;
    let j = i;
    while (j < input.length) {
      if (input[j] === "(") depth++;
      else if (input[j] === ")") {
        depth--;
        if (depth === 0) break;
      }
      // Skip string literals
      else if (input[j] === '"' || input[j] === "'" || input[j] === "`") {
        const quote = input[j];
        j++;
        while (j < input.length && input[j] !== quote) {
          if (input[j] === "\\") j++;
          j++;
        }
      }
      j++;
    }

    if (depth !== 0) continue;

    const exprEnd = j + 1;
    const innerExpr = input.slice(exprStart + 1, j).trim();

    // Check if this is a parameter context:
    // 1. Followed by => (arrow function param)
    const afterClose = input.slice(exprEnd, exprEnd + 10).trimStart();
    if (afterClose.startsWith("=>")) continue;

    // 2. If innerExpr is a simple identifier (no operators/dots/calls), and it's in a
    //    function parameter position, treat it as a param, not a cast.
    //    A simple identifier followed by , or ) after the balanced group = param
    if (/^\w+$/.test(innerExpr)) {
      if (afterClose.startsWith(",") || afterClose.startsWith(")")) continue;
      // Check if we're inside a function/arrow param list by looking at context before
      const beforeCtx = input.slice(Math.max(0, match.index - 60), match.index);
      // If preceded by ( or , it's a param
      if (/[,(]\s*$/.test(beforeCtx)) continue;
    }

    // 3. If innerExpr is a rest param (...name) skip
    if (/^\.\.\.\w+$/.test(innerExpr)) continue;

    // 4. If innerExpr is a destructured param
    if (/^\[.*\]$/.test(innerExpr) || /^\{.*\}$/.test(innerExpr)) {
      if (afterClose.startsWith("=>") || afterClose.startsWith(",") || afterClose.startsWith(")"))
        continue;
    }

    // Skip variable declaration patterns (same-line or next-line)
    const afterComment = input.slice(matchEnd, matchEnd + 40).replace(/^\s*/, "");
    if (/^(export\s+)?(const|let|var)\s/.test(afterComment)) continue;

    const line = lineAt(input, match.index);
    const fullMatch = input.slice(match.index, exprEnd);
    // If innerExpr ends with } (arrow/function body), use (expr) as T to avoid syntax error
    const trimmedInner = innerExpr.trimEnd();
    let replacement: string;
    if (trimmedInner.endsWith("}")) {
      replacement = `(${innerExpr}) as ${typeStr}`;
    } else {
      replacement = `(${innerExpr} as ${typeStr})`;
    }
    replacements.push({
      file: filePath,
      line,
      before: fullMatch.slice(0, 80),
      after: replacement.slice(0, 80),
    });

    result += input.slice(lastIndex, match.index) + replacement;
    lastIndex = exprEnd;
    marker.lastIndex = lastIndex;
  }

  result += input.slice(lastIndex);
  return result;
}
