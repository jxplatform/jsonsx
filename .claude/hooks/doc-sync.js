// Stop hook — advisory docs/spec sync check. When the session's uncommitted
// changes touch source files that user docs declare (via `code:` frontmatter or
// `@docs` tags), surface the affected pages/specs back to Claude ONCE per stop
// chain so behavior changes ship with their documentation. stop_hook_active
// guards the loop: after Claude has seen the report and stops again, we let it.
//
// It also runs the two MARKDOWN gates over the session's own changed `.md`
// files, and that placement is the point. `.claude/hooks/validate-edit.js` runs
// the same two per edit, but ONLY on an Edit/Write/MultiEdit tool call — a page
// rewritten through Bash (a `sed`, a heredoc, `format:md`) never reaches it.
// That is not hypothetical: it is how seven em dashes reached CI. A Stop hook
// asks about the WORKING TREE, so the editing route stops mattering.
//
// Advisory by design — exit 2 feeds the report back as feedback; Claude either
// updates the docs or states why no update is needed. Never blocks repeatedly.

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

// Import-safe: both scripts guard their CLI behind `import.meta.main`.
const proseCorpus = await import(`${process.cwd()}/scripts/docs/check-prose.ts`)
  .then((m) => m.corpusFiles())
  .catch(() => []);

const raw = await new Promise((resolve) => {
  let data = "";
  process.stdin.on("data", (chunk) => (data += chunk));
  process.stdin.on("end", () => resolve(data));
});

let input = {};
try {
  input = JSON.parse(raw);
} catch {
  // No/invalid payload — treat as a fresh stop.
}

if (input.stop_hook_active) {
  process.exit(0); // Already continued once for this report — let the stop through.
}

/** Run a checker that exits non-zero with its report on stdout/stderr; return the report. */
function reportOf(script, args = []) {
  try {
    execFileSync("bun", [script, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    return "";
  } catch (error) {
    return `${error.stdout?.toString() ?? ""}${error.stderr?.toString() ?? ""}`.trim();
  }
}

/** Markdown files this session has touched, still present on disk. */
function changedMarkdown() {
  try {
    const out = execFileSync("git", ["status", "--porcelain", "-z"], {
      stdio: ["ignore", "pipe", "pipe"],
    }).toString();
    // NUL-delimited so a path with a space or quote needs no unquoting. A rename
    // Emits `R  new\0old\0`; the extra field is a path too, so filtering on the
    // Suffix and on existence is enough without modelling the status codes.
    return out
      .split("\0")
      .map((entry) => (entry.length > 3 && entry[2] === " " ? entry.slice(3) : entry))
      .filter((path) => path.endsWith(".md") && existsSync(path));
  } catch {
    return []; // not a repo, or git unavailable — nothing to scope to
  }
}

/**
 * The two markdown gates, over this session's changed pages only.
 *
 * Scoped rather than swept: a full-corpus run would report every pre-existing violation in the tree
 * as though this session had caused it. Both scripts take named files, and `check-prose.ts` treats
 * a named run as its "per-page workflow" — it skips the staleness sweep that only makes sense over
 * the whole corpus.
 */
function markdownReports() {
  const changed = changedMarkdown();
  if (changed.length === 0) {
    return [];
  }
  const out = [];
  // The prose corpus is a specific set — docs minus generated pages, the shipped
  // READMEs, the marketing pages — and `specs/**` is deliberately outside it, so
  // the specs keep their own voice. Import the definition rather than restate it;
  // an empty list means the import failed, and the honest response to "I could
  // not learn which files this gate covers" is to check none of them, never all.
  const corpus = changed.filter((path) => proseCorpus.includes(path));
  if (corpus.length > 0) {
    out.push(reportOf("scripts/docs/check-prose.ts", corpus));
  }
  // Through the npm script, so the flags track the gate. Calling the script directly with only
  // `--check` would enforce the one-line-per-paragraph rule, which is landed but DORMANT
  // (`docs:markdown` is `--check --no-wrap`) — that would flag nearly every file.
  out.push(reportOf("run", ["docs:markdown", ...changed]));
  return out.filter(Boolean);
}

// --strict exits 1 when findings exist, with the report on stderr.
const reports = [
  reportOf("scripts/docs/check-doc-sync.ts", ["--strict"]),
  // Specs edited this session must also be released (version + **Updated:** + changelog).
  reportOf("scripts/docs/check-spec-release.ts"),
  ...markdownReports(),
].filter(Boolean);

if (reports.length > 0) {
  console.error(
    `${reports.join("\n\n")}\n\nBefore finishing: update the listed docs page(s) and spec ` +
      `section(s) if this session's changes altered behavior, release any spec whose body ` +
      `changed (\`bun run spec:bump\`), or state explicitly that no update is needed.`,
  );
  process.exit(2);
}
process.exit(0);
