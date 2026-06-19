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

if (problems.length > 0) {
  console.error(
    `⚠ Codebase-rule check failed for ${file} (the edit was kept; please fix):\n\n${problems.join("\n\n")}`,
  );
  process.exit(2); // alert — non-destructive, the file is NOT reverted
}
