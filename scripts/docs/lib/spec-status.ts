// Shared parser for the spec status-marker vocabulary and per-spec release metadata. Used by
// Check-spec-status.ts (enforcement), check-spec-release.ts (the bump gate), spec-bump.ts (the
// Release CLI), and the implementation-status / spec-changelog generators. One canonical parser so
// A machine can read "what is built" and "what changed when" straight from the specs.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** The one canonical status vocabulary. */
export const STATUS_VOCAB = ["Implemented", "Partial", "Pending", "Future", "Removed"] as const;
export type Status = (typeof STATUS_VOCAB)[number];

export function isStatus(word: string): word is Status {
  return (STATUS_VOCAB as readonly string[]).includes(word);
}

/** A numbered section and the status marker (if any) that sits under its heading. */
export interface SectionStatus {
  anchor: string; // E.g. "13.1"
  title: string;
  status?: Status;
  line: number;
}

/** One release recorded in a spec's `## Changelog` section. */
export interface ChangelogEntry {
  version: string;
  date: string; // ISO YYYY-MM-DD
  summary: string;
  line: number;
}

export interface SpecStatus {
  file: string; // Basename, e.g. "spec.md"
  headerVersion?: string;
  headerStatus?: string; // Raw (may be off-vocab — the checker validates)
  headerUpdated?: string; // ISO YYYY-MM-DD from the **Updated:** line
  footerVersion?: string;
  sections: SectionStatus[];
  changelog: ChangelogEntry[]; // Newest first, as written
  /** Legacy / off-vocabulary forms found, for the checker to reject. */
  badForms: { line: number; text: string; reason: string }[];
}

/*
 * The dot after a top-level number is OPTIONAL, because the specs write both forms: `### 12.3
 * Incremental Builds` and `## 13. Internationalization`. Requiring whitespace straight after the
 * number made every `## N.` heading invisible — 141 of them across 13 specs — so a marker under a
 * top-level section was silently credited to the last SUBSECTION above it. `site-architecture.md`
 * §15's "Implemented" was being reported against §14.2, which carries no marker at all.
 * `check-doc-refs.ts:80` has always used `\b` here and resolved the same headings correctly.
 */
/*
 * `\\?` tolerates the backslash a WYSIWYG editor inserts before the dot (`## 18\.`). Same class of
 * bug as the `\b` note above: a heading pattern that fails to match does not report anything, it
 * just stops seeing sections. `check-standards.ts` reports the escape as `heading-escaped`.
 */
export const NUMBERED_HEADING = /^#{2,6}\s+(\d+(?:\.\d+)*[a-z]?)\\?\.?\s+(.*)$/;
const BLOCKQUOTE_STATUS = /^>\s*\*\*Status:\s*([A-Za-z]+)/;
const HEADER_VERSION = /^\*\*Version:\*\*\s*(.+)$/;
const HEADER_STATUS = /^\*\*Status:\*\*\s*(.+)$/;
const HEADER_UPDATED = /^\*\*Updated:\*\*\s*(.+)$/;
const FOOTER_VERSION = /Specification v([0-9][A-Za-z0-9.-]*)/;
const CHANGELOG_HEADING = /^##\s+Changelog\s*$/;
// `- **<version>** (<YYYY-MM-DD>) — <summary>` (em-dash or hyphen separator).
const CHANGELOG_ENTRY = /^-\s+\*\*([^*]+)\*\*\s*\((\d{4}-\d{2}-\d{2})\)\s*[—-]\s*(.+)$/;

/** Legacy forms the normalization removed; the checker rejects their reintroduction. */
const LEGACY = [
  {
    re: /\*\*Not implemented\*\*/,
    reason: 'use **Pending** (or **Future**), not "**Not implemented**"',
  },
  {
    re: /\*\*Partially implemented\*\*/,
    reason: 'use **Partial**, not "**Partially implemented**"',
  },
  { re: /^>\s*\*\*Current status:/, reason: 'use "> **Status: X.**", not "> **Current status:**"' },
  {
    re: /\(Not Yet Implemented\)/,
    reason: 'drop the heading suffix; add a "> **Status: Pending.**" line',
  },
  { re: /\|\s*Planned\s*\|/, reason: 'use a bold cell "**Pending**", not plain "Planned"' },
];

/** A `MAJOR.MINOR.PATCH` version, optionally a `-draft` prerelease. */
export interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  draft: boolean;
  raw: string;
}

/** Parse a spec version string; returns null if it is not `X.Y.Z` (optionally `-draft`). */
export function splitVersion(v: string): ParsedVersion | null {
  const m = v.trim().match(/^(\d+)\.(\d+)\.(\d+)(-draft)?$/);
  if (!m) {
    return null;
  }
  return {
    major: Number(m[1]!),
    minor: Number(m[2]!),
    patch: Number(m[3]!),
    draft: Boolean(m[4]),
    raw: v.trim(),
  };
}

/**
 * Compare two spec versions. Negative if a < b, 0 if equal, positive if a > b. A `-draft`
 * Prerelease sorts below the same released tuple (2.1.0-draft < 2.1.0). Returns null if either
 * String is not a valid spec version.
 */
export function compareSpecVersion(a: string, b: string): number | null {
  const pa = splitVersion(a);
  const pb = splitVersion(b);
  if (!pa || !pb) {
    return null;
  }
  if (pa.major !== pb.major) {
    return pa.major - pb.major;
  }
  if (pa.minor !== pb.minor) {
    return pa.minor - pb.minor;
  }
  if (pa.patch !== pb.patch) {
    return pa.patch - pb.patch;
  }
  if (pa.draft === pb.draft) {
    return 0;
  }
  return pa.draft ? -1 : 1;
}

/** Parse one spec file's status markers and release metadata. */
export function parseSpecFile(path: string, file: string): SpecStatus {
  return parseSpecSource(readFileSync(path, "utf8"), file);
}

/** Parse spec source text (shared by parseSpecFile and callers that already hold the text). */
export function parseSpecSource(source: string, file: string): SpecStatus {
  const lines = source.split("\n");
  const out: SpecStatus = { file, sections: [], changelog: [], badForms: [] };
  let currentSection: SectionStatus | null = null;
  let inChangelog = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const lineNo = i + 1;

    // Header/footer metadata (guards keep the first match; harmless to retry in the changelog).
    const v = line.match(HEADER_VERSION);
    if (v && out.headerVersion === undefined) {
      out.headerVersion = v[1]!.trim();
    }
    const u = line.match(HEADER_UPDATED);
    if (u && out.headerUpdated === undefined) {
      out.headerUpdated = u[1]!.trim();
    }
    const hs = line.match(HEADER_STATUS);
    if (hs && out.headerStatus === undefined && !line.startsWith(">")) {
      out.headerStatus = hs[1]!.trim().replace(/\.$/, "");
    }
    const fv = line.match(FOOTER_VERSION);
    if (fv) {
      out.footerVersion = fv[1]!;
    }

    // The `## Changelog` section ends spec-body scanning; the rest is release metadata.
    if (CHANGELOG_HEADING.test(line)) {
      inChangelog = true;
      currentSection = null;
      continue;
    }
    if (inChangelog) {
      const ce = line.match(CHANGELOG_ENTRY);
      if (ce) {
        out.changelog.push({
          version: ce[1]!.trim(),
          date: ce[2]!,
          summary: ce[3]!.trim(),
          line: lineNo,
        });
      }
      continue;
    }

    const h = line.match(NUMBERED_HEADING);
    if (h) {
      currentSection = { anchor: h[1]!, title: h[2]!.trim(), line: lineNo };
      out.sections.push(currentSection);
    }

    const bq = line.match(BLOCKQUOTE_STATUS);
    if (bq) {
      const word = bq[1]!;
      if (!isStatus(word)) {
        out.badForms.push({
          line: lineNo,
          text: line.trim(),
          reason: `"${word}" is not in the status vocabulary`,
        });
      } else if (currentSection && currentSection.status === undefined) {
        currentSection.status = word;
      }
    }

    // Off-vocabulary bold cells (e.g. **Not implemented**) are caught by the LEGACY scan.
    for (const l of LEGACY) {
      if (l.re.test(line)) {
        out.badForms.push({ line: lineNo, text: line.trim(), reason: l.reason });
      }
    }
  }
  return out;
}

/**
 * Parse every spec file in `specsDir` (top-level only; `README.md`, design-notes, and subdirs are
 * Exempt).
 */
export function parseSpecStatuses(specsDir: string): SpecStatus[] {
  return readdirSync(specsDir)
    .filter((f) => f.endsWith(".md") && f !== "README.md")
    .toSorted()
    .map((f) => parseSpecFile(join(specsDir, f), f));
}
