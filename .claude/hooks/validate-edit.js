// PostToolUse validator — runs after Edit/Write/MultiEdit and ALERTS on any
// codebase-rule violation in the file that was just edited.
//
// Covers BOTH source families, because both have CI gates that only ever spoke
// at push time:
//   • .ts/.js/.json/.css — oxfmt --check, oxlint, oxlint --type-aware
//   • .md               — oxfmt --check, `docs:prose`, `docs:markdown`
// The markdown half exists because `docs:prose` bans the em dash outright and
// nothing said so until CI did. See the prose section below.
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
import { readFileSync, realpathSync } from "node:fs";
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
const bin = (name) => (name === "bun" ? "bun" : `${process.cwd()}/node_modules/.bin/${name}`);
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

/*
 * 4) Prose rules, for the Markdown that CI actually gates. (.md only.)
 *
 * `scripts/docs/check-prose.ts` bans the em dash and seven other patterns, and
 * `prose.json` budgets nothing any more — so a single `—` typed into a docs page
 * is a hard CI failure with no local signal until push. That is the gap this
 * closes.
 *
 * The corpus is IMPORTED rather than re-described here. It is a specific set —
 * docs/**.md minus generated pages, the shipped READMEs, and the marketing pages
 * — and `specs/**` is deliberately NOT in it, so the specs keep their own voice.
 * A regex approximating that here would drift and start flagging files the gate
 * permits, which is worse than staying quiet.
 *
 * Named files put `check()` in per-page mode (`full = false`), which is what
 * suppresses the whole-corpus staleness sweep over budgets and allow entries —
 * the script's own docstring calls that "the per-page workflow".
 */
if (file.endsWith(".md")) {
  try {
    const { check: checkProse, corpusFiles } = await import(
      `${process.cwd()}/scripts/docs/check-prose.ts`
    );
    if (corpusFiles().includes(rel)) {
      const config = JSON.parse(readFileSync(`${process.cwd()}/scripts/docs/prose.json`, "utf8"));
      const { violations } = checkProse(config, [rel], false);
      if (violations.length > 0) {
        problems.push(`• Prose rules (\`bun run docs:prose\`):\n${violations.join("\n")}`);
      }
    }
  } catch (error) {
    // A missing/renamed script must not wedge every markdown edit. Stay silent:
    // CI still owns the verdict, and a hook that shouts about its own plumbing
    // trains you to ignore it.
    void error;
  }
}

/*
 * 5) The markdown formatter's own gate. (.md only.)
 *
 * Invoked as `bun run docs:markdown <file>` — the same script with the same
 * flags CI runs — rather than by importing `normalizeMarkdown` and judging its
 * result here. The flags are the reason: that gate is `--check --no-wrap` today
 * because the one-line-per-paragraph rule is landed but DORMANT, and when the
 * sweep lands and `--no-wrap` goes, a hook that had imported the escape half
 * would silently stay narrower than the thing it claims to mirror. Going through
 * the script also gets `isFormattable`'s exemptions (CHANGELOG, fixtures,
 * vendor) for free.
 *
 * The escape half is worth the subprocess on its own: CLAUDE.md's Specs policy
 * notes the escape and the UNRECOVERABLE link/bold flattening are the same
 * event, so this firing is the prompt to check the file's links survived.
 */
if (file.endsWith(".md")) {
  const markdown = check("bun", ["run", "docs:markdown", file]);
  if (markdown) {
    problems.push(`• Markdown format (\`bun run docs:markdown\`):\n${markdown}`);
  }
}

if (problems.length > 0) {
  console.error(
    `⚠ Codebase-rule check failed for ${file} (the edit was kept; please fix):\n\n${problems.join("\n\n")}`,
  );
  process.exit(2); // alert — non-destructive, the file is NOT reverted
}
