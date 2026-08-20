// Enforces the spec status-marker vocabulary and the per-spec release metadata so "what is built"
// And "what changed when" are machine-readable and cannot drift back into ad-hoc phrasings or
// Silently-restamped versions. Companion to check-doc-refs.ts (docs), check-site-claims.ts
// (marketing), and check-spec-release.ts (the bump gate). Fails (exit 1) on any violation.
//
// Rules:
//   - every specs/*.md has a header **Version:**, **Status:**, and **Updated:** block
//   - every status (header, section blockquote) uses the vocabulary
//     Implemented | Partial | Pending | Future | Removed
//   - no legacy forms (**Not implemented**, **Partially implemented**, "Current status:",
//     "(Not Yet Implemented)" heading suffixes, plain "Planned" cells)
//   - a footer version line, when present, equals the header version
//   - every spec has a `## Changelog` whose newest entry matches the header version and **Updated:**
//   - changelog entries run newest-first: strictly descending versions, non-increasing dates
//   - the `-draft` suffix is carried exactly by the specs whose status is not Implemented
//   - if any spec uses an all-capitals BCP 14 keyword, standards.md still declares them (§12)
//
// Usage: bun scripts/docs/check-spec-status.ts

import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import {
  compareSpecVersion,
  isStatus,
  parseSpecStatuses,
  splitVersion,
} from "./lib/spec-status.ts";

const ROOT = resolve(import.meta.dir, "../..");
const SPECS_DIR = resolve(ROOT, "specs");

const violations: string[] = [];
const fail = (file: string, message: string) => violations.push(`specs/${file}: ${message}`);

/** True for a real calendar date written as YYYY-MM-DD. */
function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

const specs = parseSpecStatuses(SPECS_DIR);

for (const spec of specs) {
  // ─── Header block ──────────────────────────────────────────────────────────
  if (!spec.headerVersion) {
    fail(spec.file, "missing a header **Version:** line");
  } else if (!splitVersion(spec.headerVersion)) {
    fail(
      spec.file,
      `header **Version:** "${spec.headerVersion}" is not MAJOR.MINOR.PATCH (optionally -draft)`,
    );
  }
  if (!spec.headerStatus) {
    fail(spec.file, "missing a header **Status:** line");
  } else if (!isStatus(spec.headerStatus)) {
    fail(
      spec.file,
      `header **Status:** "${spec.headerStatus}" is not in the vocabulary (Implemented | Partial | Pending | Future | Removed)`,
    );
  }
  if (!spec.headerUpdated) {
    fail(spec.file, "missing a header **Updated:** line (ISO YYYY-MM-DD)");
  } else if (!isIsoDate(spec.headerUpdated)) {
    fail(spec.file, `header **Updated:** "${spec.headerUpdated}" is not an ISO YYYY-MM-DD date`);
  }
  if (spec.footerVersion && spec.headerVersion && spec.footerVersion !== spec.headerVersion) {
    fail(
      spec.file,
      `footer version "v${spec.footerVersion}" != header version "${spec.headerVersion}"`,
    );
  }

  // ─── The -draft suffix tracks the header status ────────────────────────────
  if (spec.headerVersion && spec.headerStatus && isStatus(spec.headerStatus)) {
    const draft = spec.headerVersion.endsWith("-draft");
    if (spec.headerStatus === "Implemented" && draft) {
      fail(
        spec.file,
        `status is Implemented, so **Version:** must drop the -draft suffix (got "${spec.headerVersion}")`,
      );
    }
    if (spec.headerStatus !== "Implemented" && !draft) {
      fail(
        spec.file,
        `status is ${spec.headerStatus}, so **Version:** must carry the -draft suffix (got "${spec.headerVersion}")`,
      );
    }
  }

  // ─── Changelog ─────────────────────────────────────────────────────────────
  const [top] = spec.changelog;
  if (!top) {
    fail(
      spec.file,
      "missing a `## Changelog` section with at least one `- **<version>** (<YYYY-MM-DD>) — <summary>` entry",
    );
  } else {
    if (spec.headerVersion && top.version !== spec.headerVersion) {
      fail(
        spec.file,
        `${top.line}: newest changelog entry "${top.version}" != header version "${spec.headerVersion}"`,
      );
    }
    if (spec.headerUpdated && top.date !== spec.headerUpdated) {
      fail(
        spec.file,
        `${top.line}: newest changelog date "${top.date}" != header **Updated:** "${spec.headerUpdated}"`,
      );
    }
  }

  for (const entry of spec.changelog) {
    if (!splitVersion(entry.version)) {
      fail(
        spec.file,
        `${entry.line}: changelog version "${entry.version}" is not MAJOR.MINOR.PATCH (optionally -draft)`,
      );
    }
    if (!isIsoDate(entry.date)) {
      fail(
        spec.file,
        `${entry.line}: changelog date "${entry.date}" is not a real YYYY-MM-DD date`,
      );
    }
  }

  // Newest-first ordering: strictly descending versions, non-increasing dates.
  for (let i = 1; i < spec.changelog.length; i++) {
    const newer = spec.changelog[i - 1]!;
    const older = spec.changelog[i]!;
    const cmp = compareSpecVersion(newer.version, older.version);
    if (cmp !== null && cmp <= 0) {
      fail(
        spec.file,
        `${older.line}: changelog must run newest-first — "${older.version}" is not older than "${newer.version}"`,
      );
    }
    if (isIsoDate(newer.date) && isIsoDate(older.date) && older.date > newer.date) {
      fail(
        spec.file,
        `${older.line}: changelog date "${older.date}" is newer than the entry above it ("${newer.date}")`,
      );
    }
  }

  for (const bad of spec.badForms) {
    fail(spec.file, `${bad.line}: ${bad.reason} — "${bad.text.slice(0, 80)}"`);
  }
}

// ─── BCP 14 normative keywords ────────────────────────────────────────────────
//
// RFC 8174's "and only when they appear in all capitals" clause is what lets the corpus write
// "must" and "should" in their ordinary English senses on every page. That clause only holds while
// The declaration exists: delete standards.md §12 and every capitalized MUST in the corpus quietly
// Stops being a conformance requirement, with nothing anywhere to notice. This is that notice.
//
// Lowercase prose is deliberately not judged. A gate guessing at which "must" was meant normatively
// Would be wrong on most pages, and would push authors toward capitalizing everything — the outcome
// RFC 8174 exists to prevent.

/** The BCP 14 keyword set, longest-first so `MUST NOT` is matched before `MUST`. */
const BCP14_KEYWORDS = [
  "MUST NOT",
  "SHALL NOT",
  "SHOULD NOT",
  "NOT RECOMMENDED",
  "RECOMMENDED",
  "REQUIRED",
  "OPTIONAL",
  "MUST",
  "SHALL",
  "SHOULD",
  "MAY",
] as const;

const KEYWORD_PATTERN = new RegExp(`\\b(${BCP14_KEYWORDS.join("|")})\\b`, "g");
const DECLARING_SPEC = "standards.md";
const DECLARING_HEADING = "## 12. Normative Keywords";

const keywordUsers: string[] = [];
let declaration = "";
for (const file of readdirSync(SPECS_DIR).filter((f) => f.endsWith(".md"))) {
  const text = readFileSync(resolve(SPECS_DIR, file), "utf8");
  if (file === DECLARING_SPEC) {
    declaration = text;
    continue; // The declaration necessarily contains every keyword it defines.
  }
  if (KEYWORD_PATTERN.test(text)) {
    keywordUsers.push(file);
  }
  KEYWORD_PATTERN.lastIndex = 0;
}

if (keywordUsers.length > 0) {
  if (!declaration.includes(DECLARING_HEADING)) {
    fail(
      DECLARING_SPEC,
      `${keywordUsers.join(", ")} use all-capitals BCP 14 keywords, but "${DECLARING_HEADING}" is ` +
        `missing — those requirements are now undefined`,
    );
  } else {
    // The declared set must be the whole set: a section that quietly dropped SHALL would leave a
    // Future use of it undefined while still looking like a declaration.
    const missing = BCP14_KEYWORDS.filter((word) => !declaration.includes(`**${word}**`));
    if (missing.length > 0) {
      fail(
        DECLARING_SPEC,
        `${DECLARING_HEADING} does not declare ${missing.join(", ")} — declare the full BCP 14 set ` +
          `or stop using the missing keyword(s)`,
      );
    }
  }
}

if (violations.length > 0) {
  console.error(`\nspec status: ${violations.length} violation(s):`);
  for (const v of violations) {
    console.error(`  ${v}`);
  }
  process.exit(1);
}
console.log(
  `spec status: ${specs.length} spec(s) — headers, vocabulary, footer versions, and changelogs all agree.`,
);
