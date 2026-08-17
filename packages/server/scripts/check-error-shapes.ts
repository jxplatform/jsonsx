/**
 * Guard the one failure shape.
 *
 * `src/` used to say a request failed in four different ways — `Response.json({error}, {status})`,
 * a bare-text body, a 200 carrying an `upstreamError` field, and a thrown string that became an
 * empty 500 — and the Studio client grew a separate reader for each. The cost of that was not the
 * inconsistency, it was that a failure could surface with **no detail at all**, because the reader
 * that ran was not the one for the shape that arrived.
 *
 * Every one of those is now `problem(...)` from `src/problem.ts`, which emits RFC 9457
 * `application/problem+json`. This file is what stops them regrowing, because a wide, shallow
 * change like that comes back one convenient call at a time.
 *
 * Three rules, each with the reason it exists:
 *
 * 1. **No `{ error: … }` response body.** The shape the client had to guess at. A problem carries
 *    `detail`; `error` survives only as the deprecated alias `problemDetails` writes for one
 *    release, which is emitted from one place and never hand-written.
 * 2. **No bare-text 4xx/5xx.** `new Response("Missing path", { status: 400 })` gives a client a string
 *    it cannot key on and a media type that says it is prose.
 * 3. **No `Access-Control-Allow-*` anywhere.** This one is not about shape. The whole loopback
 *    security model rests on the browser refusing cross-origin reads (`server.md` §4.2), so a
 *    single CORS header would hand that containment away. There is no such header in the repository
 *    today and that fact is load-bearing rather than incidental — which is exactly the kind of
 *    property that needs a check, since nothing about the code makes it visible.
 *
 * Allow-lists ratchet: an entry that no longer matches anything fails too, so the backlog cannot
 * silently become a permanent exemption.
 *
 * Run: bun run scripts/check-error-shapes.ts
 */

import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const SRC = join(ROOT, "src");

/**
 * Files permitted to build a failure body by hand, and why.
 *
 * `problem.ts` is the constructor itself. The RPC bridge in `project-server.ts` is a WebSocket
 * envelope rather than an HTTP response — RFC 9457 describes a response body, and a frame that
 * arrives after the socket is up has no status to carry — so its `{error, id}` shape stays, and
 * §4.3 of the spec says why.
 */
const HAND_WRITTEN_ALLOWED = new Set(["problem.ts", "project-server.ts"]);

/**
 * `Response.json({ … error: … }, { status: 4xx|5xx })` — the pre-RFC-9457 FAILURE body.
 *
 * Two things narrow it, and both are the difference between the rule and its keyword:
 *
 * - **Anchored on `Response.json(`**, because `{error, path}` is also the shape of a per-file entry
 *   in a refactor report. A report is data the client asked for, not a statement that the request
 *   failed.
 * - **Anchored on a failure status**, because three routes deliberately answer **200 with an `error`
 *   field**: the code services (a syntax error in the author's snippet is the RESULT, not a
 *   transport failure), the rename report (a partial success), and the schema probe (a degraded
 *   answer that still carries `schema: null`). Converting those to problem documents would tell a
 *   client the request failed when it did not. `server.md` §4.3 records all three by name.
 */
const ERROR_BODY =
  /Response\.json\(\s*\{[^}]*\berror:[\s\S]{0,400}?\}\s*,\s*\{[^}]*status:\s*[45]\d\d/;

/** `new Response("<text>", { status: 4xx|5xx })`. */
const BARE_TEXT_FAILURE = /new Response\(\s*[`"'][^`"']*[`"']\s*,\s*\{\s*status:\s*[45]\d\d/;

/** Any CORS grant. */
const CORS_HEADER = /Access-Control-Allow-/;

interface Violation {
  file: string;
  line: number;
  rule: string;
  text: string;
}

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...sources(full));
    } else if (entry.name.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

const violations: Violation[] = [];
const usedAllowances = new Set<string>();

for (const file of sources(SRC)) {
  const rel = relative(ROOT, file);
  const name = rel.split("/").pop()!;
  const allowed = HAND_WRITTEN_ALLOWED.has(name);
  if (allowed) {
    usedAllowances.add(name);
  }

  const source = readFileSync(file, "utf8");
  const lines = source.split("\n");

  for (const [index, raw] of lines.entries()) {
    const text = raw.trim();
    // A comment describing the old shape is not the old shape.
    if (text.startsWith("*") || text.startsWith("//")) {
      continue;
    }
    if (CORS_HEADER.test(raw)) {
      violations.push({ file: rel, line: index + 1, rule: "no-cors", text });
    }
  }

  if (allowed) {
    continue;
  }

  /*
   * Whole-file rather than line-by-line: the reformatter breaks a long response body across lines,
   * and a rule that only ever saw one line at a time would be satisfied by reformatting.
   */
  for (const [rule, pattern] of [
    ["no-error-body", ERROR_BODY],
    ["no-bare-text-failure", BARE_TEXT_FAILURE],
  ] as const) {
    for (const match of source.matchAll(new RegExp(pattern, "g"))) {
      const line = source.slice(0, match.index).split("\n").length;
      violations.push({ file: rel, line, rule, text: (lines[line - 1] ?? "").trim() });
    }
  }
}

// Ratchet: an allowance that stopped applying is an allowance that should be deleted.
for (const name of HAND_WRITTEN_ALLOWED) {
  if (!usedAllowances.has(name)) {
    violations.push({
      file: `scripts/check-error-shapes.ts`,
      line: 0,
      rule: "stale-allowance",
      text: `HAND_WRITTEN_ALLOWED names "${name}", which no longer exists — remove the entry`,
    });
  }
}

const EXPLANATION: Record<string, string> = {
  "no-bare-text-failure":
    "a bare-text 4xx/5xx gives the client a string it cannot key on — use problem(...)",
  "no-cors":
    "the loopback model rests on the browser refusing cross-origin reads (server.md §4.2); a CORS grant hands that away",
  "no-error-body": "{ error: … } is the pre-RFC-9457 shape — use problem(...) from src/problem.ts",
  "stale-allowance": "the allow-list ratchets down, never sideways",
};

if (violations.length > 0) {
  console.error(`\nerror shapes: ${violations.length} violation(s):`);
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line} [${v.rule}] ${EXPLANATION[v.rule]}`);
    console.error(`    ${v.text.slice(0, 110)}`);
  }
  process.exit(1);
}

console.log(
  `error shapes: src/ answers every failure as application/problem+json, and grants no CORS.`,
);
