// PostToolUse validator — runs after Edit/Write/MultiEdit and ALERTS on any
// codebase-rule violation in the file that was just edited.
//
// NON-DESTRUCTIVE by design: it only READS the file (oxfmt --check, oxlint with
// no --fix). It never writes, never `git add`s, never reverts. Contrast with
// nano-staged, which backs up the tree and restores it on task failure — correct
// for the commit gate in .husky/pre-commit, but catastrophic as a live per-edit
// hook (that "forceful revert" wipes in-progress edits).
//
// On a violation it prints a report to stderr and exits 2, which surfaces the
// problem back into the session as feedback. The edit itself is left untouched.

import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { relative as relativePath, resolve as resolvePath } from "node:path";

const raw = await new Promise((resolve) => {
  let data = "";
  process.stdin.on("data", (chunk) => (data += chunk));
  process.stdin.on("end", () => resolve(data));
});

let input;
try {
  input = JSON.parse(raw);
} catch {
  process.exit(0); // no/invalid payload — nothing to validate
}

// Edit/Write/MultiEdit expose tool_input.file_path; NotebookEdit uses notebook_path.
const file = input.tool_input?.file_path ?? input.tool_input?.notebook_path ?? "";

// Only files oxfmt/oxlint understand. Anything else (e.g. .ipynb, images) is skipped.
if (!file || !/\.(ts|tsx|js|jsx|json|css|md)$/.test(file)) {
  process.exit(0);
}

// The wrapper in settings.json only proves the SESSION is rooted in this repo; the
// edit itself may land anywhere — plan-mode writes go to ~/.claude/plans/*.md, and
// linting those is pure noise. Validate only files that actually live under the
// project root. Both sides are realpath'd so a symlinked checkout still matches.
const realOrSelf = (path) => {
  try {
    return realpathSync(path);
  } catch {
    return path; // unreadable/removed since the edit — fall back to the literal path
  }
};
const root = realOrSelf(process.cwd());
const target = realOrSelf(resolvePath(process.cwd(), file));
const rel = relativePath(root, target);
if (rel === "" || rel.startsWith("..") || resolvePath(root, rel) !== target) {
  process.exit(0); // outside the source tree — not ours to police
}

// Call the locally-installed binaries directly (fast; no bunx re-resolution).
const bin = (name) => `${process.cwd()}/node_modules/.bin/${name}`;
const check = (name, args) => {
  try {
    execFileSync(bin(name), args, { stdio: ["ignore", "pipe", "pipe"] });
    return null; // exit 0 → clean
  } catch (error) {
    return `${error.stdout?.toString() ?? ""}${error.stderr?.toString() ?? ""}`.trim();
  }
};

const problems = [];

// 1) Formatting drift — check only, never write.
if (check("oxfmt", ["--check", file]) !== null) {
  problems.push(`• Not formatted — run \`oxfmt ${file}\` (or \`bun run format\`).`);
}

// 2) Lint violations — no --fix, just report. (JS/TS only.)
if (/\.(ts|tsx|js|jsx)$/.test(file)) {
  const lint = check("oxlint", [file]);
  if (lint) {
    problems.push(`• Lint violations:\n${lint}`);
  }
}

// 3) Lint typecheck errors — no --fix, just report. (JS/TS only.)
if (/\.(ts|tsx)$/.test(file)) {
  const typecheck = check("oxlint", ["--type-aware", "-c", ".oxlintrc.typecheck.json", file]);
  if (typecheck) {
    problems.push(`• Type errors:\n${typecheck}`);
  }
}

if (problems.length > 0) {
  console.error(
    `⚠ Codebase-rule check failed for ${file} (the edit was kept; please fix):\n\n${problems.join("\n\n")}`,
  );
  process.exit(2); // alert — non-destructive, the file is NOT reverted
}
