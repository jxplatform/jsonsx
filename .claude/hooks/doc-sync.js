// Stop hook — advisory docs/spec sync check. When the session's uncommitted
// changes touch source files that user docs declare (via `code:` frontmatter or
// `@docs` tags), surface the affected pages/specs back to Claude ONCE per stop
// chain so behavior changes ship with their documentation. stop_hook_active
// guards the loop: after Claude has seen the report and stops again, we let it.
//
// Advisory by design — exit 2 feeds the report back as feedback; Claude either
// updates the docs or states why no update is needed. Never blocks repeatedly.

import { execFileSync } from "node:child_process";

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

// --strict exits 1 when findings exist, with the report on stderr.
const reports = [
  reportOf("scripts/docs/check-doc-sync.ts", ["--strict"]),
  // Specs edited this session must also be released (version + **Updated:** + changelog).
  reportOf("scripts/docs/check-spec-release.ts"),
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
