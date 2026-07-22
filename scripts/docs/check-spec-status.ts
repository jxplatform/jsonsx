// Enforces the spec status-marker vocabulary so "what is built" is machine-readable and cannot drift
// Back into ad-hoc phrasings. Companion to check-doc-refs.ts (docs) and check-site-claims.ts
// (marketing). Fails (exit 1) on any violation.
//
// Rules:
//   - every specs/*.md has a header **Version:** and **Status:** block
//   - every status (header, section blockquote) uses the vocabulary
//     Implemented | Partial | Pending | Future | Removed
//   - no legacy forms (**Not implemented**, **Partially implemented**, "Current status:",
//     "(Not Yet Implemented)" heading suffixes, plain "Planned" cells)
//   - a footer version line, when present, equals the header version
//
// Usage: bun scripts/docs/check-spec-status.ts

import { resolve } from "node:path";
import { isStatus, parseSpecStatuses } from "./lib/spec-status.ts";

const ROOT = resolve(import.meta.dir, "../..");
const SPECS_DIR = resolve(ROOT, "specs");

const violations: string[] = [];
const fail = (file: string, message: string) => violations.push(`specs/${file}: ${message}`);

for (const spec of parseSpecStatuses(SPECS_DIR)) {
  if (!spec.headerVersion) {
    fail(spec.file, "missing a header **Version:** line");
  }
  if (!spec.headerStatus) {
    fail(spec.file, "missing a header **Status:** line");
  } else if (!isStatus(spec.headerStatus)) {
    fail(
      spec.file,
      `header **Status:** "${spec.headerStatus}" is not in the vocabulary (Implemented | Partial | Pending | Future | Removed)`,
    );
  }
  if (spec.footerVersion && spec.headerVersion && spec.footerVersion !== spec.headerVersion) {
    fail(
      spec.file,
      `footer version "v${spec.footerVersion}" != header version "${spec.headerVersion}"`,
    );
  }
  for (const bad of spec.badForms) {
    fail(spec.file, `${bad.line}: ${bad.reason} — "${bad.text.slice(0, 80)}"`);
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
  `spec status: ${parseSpecStatuses(SPECS_DIR).length} spec(s) — headers, vocabulary, and footer versions all agree.`,
);
