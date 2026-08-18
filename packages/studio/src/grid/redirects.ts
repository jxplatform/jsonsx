/**
 * Redirect rules — the model, the three validations, and the two import formats.
 *
 * Pure: no platform, no DOM, no project state. `redirects-grid.ts` is what puts this in front of an
 * author; everything decidable about a redirect is decided here, where it can be tested with a
 * literal array instead of a project.
 *
 * **Why three validations and not a lint pass.** `project.json`'s `redirects` map is the one part
 * of a Jx project that is invisible in the thing it configures: nothing in the site renders it, and
 * a rule that is wrong looks exactly like a rule that is right (specs/site-architecture.md §11.4
 * asks for precisely these three). Each has a different cost and a different fix:
 *
 * - **Chain** — `/a → /b` where `/b` is itself a rule. The visitor pays a second round trip, and
 *   every hop is separately cacheable, so the last one to be corrected wins for a while. Fix: point
 *   the first rule at the final destination.
 * - **Loop** — a cycle. The page is unreachable. This is the only one filed as an error.
 * - **Shadow** — the project has a real route the rule's source covers. On a host that serves static
 *   assets before consulting `_redirects` (Netlify, Cloudflare Pages) the page wins and the rule is
 *   dead config; in `dist/` the compiler's own meta-refresh file overwrites the page and warns
 *   (§11.1). Two hosts, two answers, and neither is what the author intended by writing both.
 *
 * **What is deliberately NOT decided.** A destination containing `:param` or `*` is not followed:
 * its concrete target depends on the request, so calling it a chain would be a guess. Nothing is
 * reported about it either way — see {@link validateRedirects}.
 */

import { REDIRECT_STATUSES } from "@jxsuite/schema/defs";
import { parseCsv } from "./csv-codec";

/** One redirect rule, flattened out of `project.json`'s two accepted spellings. */
/**
 * A rule's target: an RFC 9110 §15.4 redirection status, or a rewrite.
 *
 * A rewrite is NOT status 200. It serves the destination's content at the source URL, and the 200
 * that reaches `_redirects` is the host's convention for saying so. Modelling it as a status is
 * what let the compiler emit a meta-refresh page for one — see site-architecture.md §11.3.
 */
export const REWRITE = "rewrite";
export type RedirectTarget = (typeof REDIRECT_STATUSES)[number] | typeof REWRITE;

export interface RedirectRule {
  source: string;
  destination: string;
  status: RedirectTarget;
}

/** What the status column offers, in the order it offers them. */
export const REDIRECT_TARGETS: readonly RedirectTarget[] = [...REDIRECT_STATUSES, REWRITE];

/** The status `project.json` means when a rule is written as a bare string. */
export const DEFAULT_REDIRECT_STATUS = 301;

/** The status a rewrite is written as in `_redirects`, and read back from an import. */
export const REWRITE_WIRE_STATUS = 200;

/** `project.json`'s redirects map, as the schema types it. */
export type RedirectConfig = Record<
  string,
  string | { destination: string; status?: number } | { destination: string; rewrite: true }
>;

// ─── Paths and patterns ───────────────────────────────────────────────────────

/** Trailing-slash-insensitive form, matching the compiler's own `normalizeUrl` in `site-build.ts`. */
export function normalizePath(path: string): string {
  const trimmed = path.trim();
  return trimmed.length > 1 && trimmed.endsWith("/") ? trimmed.slice(0, -1) : trimmed;
}

/** Whether a path is a URLPattern rather than a literal — `:param` or `*` (§11.2). */
export function isPattern(path: string): boolean {
  return path.includes(":") || path.includes("*");
}

/** Whether a path leaves the site: a scheme, a protocol-relative URL, or a mailto/tel. */
export function isExternal(path: string): boolean {
  return /^[a-z][\d+.a-z-]*:/i.test(path) || path.startsWith("//");
}

/**
 * Whether `path` is covered by `pattern`.
 *
 * URLPattern-lite over pathname segments, which is all §11.2 uses: `:name` matches exactly one
 * non-empty segment and `*` matches the rest, including nothing. Enough to answer "does this rule
 * ever fire for that request", which is the only question chain, loop and shadow ask.
 */
export function matchesPattern(pattern: string, path: string): boolean {
  const p = normalizePath(pattern).split("/");
  const s = normalizePath(path).split("/");
  for (const [i, segment] of p.entries()) {
    if (segment === "*") {
      return true;
    }
    if (i >= s.length) {
      return false;
    }
    if (segment.startsWith(":")) {
      if (s[i] === "") {
        return false;
      }
      continue;
    }
    if (segment !== s[i]) {
      return false;
    }
  }
  return s.length === p.length;
}

/**
 * A page route as a pattern: `/blog/[slug]` → `/blog/:slug`.
 *
 * File-based routing spells a dynamic segment with brackets and a redirect spells it with a colon.
 * The shadow check compares the two, so one of them has to be translated, and translating the route
 * leaves the author's own rule text untouched in every message.
 */
export function routePattern(route: string): string {
  return route.replaceAll(/\[([^\]]+)]/g, ":$1");
}

// ─── project.json ↔ rules ─────────────────────────────────────────────────────

/** Flatten `project.json`'s redirects map into rules, in declaration order. */
export function rulesFromConfig(config: RedirectConfig | undefined): RedirectRule[] {
  return Object.entries(config ?? {}).map(([source, target]) => {
    if (typeof target === "string") {
      return { destination: target, source, status: DEFAULT_REDIRECT_STATUS };
    }
    if ("rewrite" in target) {
      return { destination: target.destination, source, status: REWRITE };
    }
    return {
      destination: target.destination,
      source,
      status: (target.status ?? DEFAULT_REDIRECT_STATUS) as RedirectTarget,
    };
  });
}

/**
 * Rules back to the map `project.json` holds.
 *
 * A 301 collapses to the string spelling, because that is what the file already says for every rule
 * an author wrote by hand and expanding them all to objects would rewrite the whole block on the
 * first edit — the same "a no-op edit writes nothing" rule `tabs/project-config.ts` enforces one
 * level down. A later duplicate source wins, which is what a JSON object means anyway; the grid
 * refuses duplicates before they get here.
 */
export function configFromRules(rules: readonly RedirectRule[]): RedirectConfig {
  const config: RedirectConfig = {};
  for (const rule of rules) {
    if (rule.status === REWRITE) {
      config[rule.source] = { destination: rule.destination, rewrite: true };
    } else if (rule.status === DEFAULT_REDIRECT_STATUS) {
      config[rule.source] = rule.destination;
    } else {
      config[rule.source] = { destination: rule.destination, status: rule.status };
    }
  }
  return config;
}

// ─── Validation ───────────────────────────────────────────────────────────────

/** Which of the three rules a finding names. Printed in the Problem, so it is part of the contract. */
export type RedirectRuleName = "chain" | "loop" | "shadow";

export interface RedirectProblem {
  rule: RedirectRuleName;
  /** The rule's source path — the row the author has to look at. */
  source: string;
  /** One line, naming the rule and the path it walks. */
  message: string;
  /** Why it costs something, and what to do instead. */
  detail: string;
}

/** The rule a request for `path` would hit: a literal source first, then the first matching pattern. */
function ruleFor(rules: readonly RedirectRule[], path: string): RedirectRule | undefined {
  const target = normalizePath(path);
  return (
    rules.find((rule) => !isPattern(rule.source) && normalizePath(rule.source) === target) ??
    rules.find((rule) => isPattern(rule.source) && matchesPattern(rule.source, target))
  );
}

/** Follow destinations from a rule until they stop resolving. Returns the path walked. */
function walk(
  rules: readonly RedirectRule[],
  start: RedirectRule,
): { path: string[]; looped: boolean } {
  const path = [start.source];
  const seen = new Set([normalizePath(start.source)]);
  let current = start;
  for (;;) {
    if (isPattern(current.destination) || isExternal(current.destination)) {
      return { looped: false, path };
    }
    const next = ruleFor(rules, current.destination);
    path.push(current.destination);
    if (!next) {
      return { looped: false, path };
    }
    const key = normalizePath(next.source);
    if (seen.has(key)) {
      return { looped: true, path };
    }
    seen.add(key);
    current = next;
  }
}

/**
 * Every chain, loop and shadow in a rule set.
 *
 * `routes` are the site's real routes with their file-based spelling (`/blog/[slug]`); they are
 * translated by {@link routePattern} here so callers hand over what the project actually has rather
 * than a pre-massaged list. An empty `routes` produces no shadow findings — which is honest only
 * because the caller knows whether it enumerated them; a caller that could not read `pages/` must
 * say so rather than pass `[]` and let this report a clean bill.
 */
export function validateRedirects(
  rules: readonly RedirectRule[],
  routes: readonly string[],
): RedirectProblem[] {
  const problems: RedirectProblem[] = [];
  const reportedLoops = new Set<string>();

  for (const rule of rules) {
    const { looped, path } = walk(rules, rule);
    if (looped) {
      // One cycle, one Problem: every rule on it walks the same ring, and three copies of the same
      // Finding is three things to fix where there is one.
      const ring = [...new Set(path.map((step) => normalizePath(step)))].toSorted().join(">");
      if (!reportedLoops.has(ring)) {
        reportedLoops.add(ring);
        problems.push({
          detail:
            `Following the rules from ${rule.source} returns to a source already visited, so a ` +
            `request for it never reaches a page. Break the cycle by pointing one of these rules ` +
            `at a real route.`,
          // The walk already closes the ring — its last step IS the source it returned to.
          message: `Redirect loop: ${path.join(" → ")}`,
          rule: "loop",
          source: rule.source,
        });
      }
    } else if (path.length > 2) {
      problems.push({
        detail:
          `Each hop is a separate request and is cached separately, so a visitor pays for the ` +
          `whole chain and a correction to the last hop can be masked by a cached earlier one. ` +
          `Point ${rule.source} straight at ${path.at(-1)}.`,
        message: `Redirect chain: ${path.join(" → ")}`,
        rule: "chain",
        source: rule.source,
      });
    }
  }

  for (const rule of rules) {
    const covered = routes.filter((route) =>
      isPattern(rule.source)
        ? matchesPattern(rule.source, routePattern(route))
        : matchesPattern(routePattern(route), rule.source),
    );
    const [first] = covered;
    if (first === undefined) {
      continue;
    }
    problems.push({
      detail:
        `This project has a page at ${first}${covered.length > 1 ? ` (and ${covered.length - 1} more)` : ""}. ` +
        `A host that serves static files before consulting _redirects answers with the page and ` +
        `this rule never fires; the build meanwhile writes its meta-refresh file over that page in ` +
        `dist/ and warns (site-architecture.md §11.1). Remove the rule or the page.`,
      message: `Redirect shadowed by a page: ${rule.source}`,
      rule: "shadow",
      source: rule.source,
    });
  }

  return problems;
}

// ─── Import ───────────────────────────────────────────────────────────────────

export interface RedirectImport {
  /** Which reader ran. Reported to the author, because the sniff can be wrong. */
  format: "_redirects" | "csv";
  rules: RedirectRule[];
  /** One line per input line that could not be read. Never silently dropped. */
  errors: string[];
}

/** A status token, tolerating Netlify's forcing `!` suffix. Null when it is not a status at all. */
function parseStatus(token: string | undefined): RedirectTarget | null {
  if (token === undefined || token === "") {
    return DEFAULT_REDIRECT_STATUS;
  }
  const raw = token.trim().replace(/!$/, "");
  // An imported `_redirects` writes a rewrite as 200, and a pasted CSV may say so in words.
  if (raw.toLowerCase() === REWRITE || Number(raw) === REWRITE_WIRE_STATUS) {
    return REWRITE;
  }
  const value = Number(raw);
  return (REDIRECT_STATUSES as readonly number[]).includes(value)
    ? (value as RedirectTarget)
    : null;
}

/** Netlify/Cloudflare `_redirects`: `source destination [status]`, `#` comments, blank lines. */
export function parseRedirectsFile(text: string): RedirectImport {
  const rules: RedirectRule[] = [];
  const errors: string[] = [];
  for (const [index, raw] of text.split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) {
      continue;
    }
    const [source, destination, status] = line.split(/\s+/);
    if (!source || !destination) {
      errors.push(`Line ${index + 1}: "${line}" — expected "source destination [status]".`);
      continue;
    }
    const code = parseStatus(status);
    if (code === null) {
      errors.push(`Line ${index + 1}: "${status}" is not an HTTP status.`);
      continue;
    }
    rules.push({ destination, source, status: code });
  }
  return { errors, format: "_redirects", rules };
}

/** Header spellings each column answers to. First match wins, left to right. */
const CSV_HEADERS: Readonly<Record<"source" | "destination" | "status", readonly string[]>> = {
  destination: ["destination", "to", "new", "target"],
  source: ["source", "from", "old", "path"],
  status: ["status", "code"],
};

/** CSV with a `source,destination[,status]` header, or the same three columns positionally. */
export function parseRedirectsCsv(text: string): RedirectImport {
  const doc = parseCsv(text);
  const errors: string[] = [];
  const rules: RedirectRule[] = [];
  const headers = doc.headers.map((header) => header.trim().toLowerCase());
  const indexOf = (names: readonly string[]) => headers.findIndex((h) => names.includes(h));

  const sourceAt = indexOf(CSV_HEADERS.source);
  const destinationAt = indexOf(CSV_HEADERS.destination);
  const headed = sourceAt !== -1 && destinationAt !== -1;
  // No recognizable header means the first record is data, not names — the two-column paste.
  const records = headed ? doc.rows : [doc.headers, ...doc.rows];
  const columns = headed
    ? { destination: destinationAt, source: sourceAt, status: indexOf(CSV_HEADERS.status) }
    : { destination: 1, source: 0, status: 2 };

  for (const [index, record] of records.entries()) {
    const source = (record[columns.source] ?? "").trim();
    const destination = (record[columns.destination] ?? "").trim();
    if (source === "" && destination === "") {
      continue;
    }
    const line = headed ? index + 2 : index + 1;
    if (source === "" || destination === "") {
      errors.push(`Row ${line}: both a source and a destination are required.`);
      continue;
    }
    const code = parseStatus(
      columns.status === -1 ? undefined : (record[columns.status] ?? "").trim(),
    );
    if (code === null) {
      errors.push(
        `Row ${line}: "${record[columns.status]}" is not one of ${REDIRECT_TARGETS.join(", ")}.`,
      );
      continue;
    }
    rules.push({ destination, source, status: code });
  }
  return { errors, format: "csv", rules };
}

/**
 * Read pasted text as whichever format it looks like.
 *
 * The sniff is one rule — a comma on the first content line means CSV — and the result SAYS which
 * reader ran, because a `_redirects` line with a comma in a query string would be read as CSV and
 * the author is the only one who can tell that the answer is wrong.
 */
export function parseRedirectImport(text: string): RedirectImport {
  const first = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line !== "" && !line.startsWith("#"));
  return first?.includes(",") ? parseRedirectsCsv(text) : parseRedirectsFile(text);
}
