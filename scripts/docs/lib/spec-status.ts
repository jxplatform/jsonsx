// Shared parser for the spec status-marker vocabulary. Used by check-spec-status.ts (enforcement)
// And generators/implementation-status.ts (the generated status page). One canonical vocabulary so
// A machine can read "what is built" straight from the specs.

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

export interface SpecStatus {
  file: string; // Basename, e.g. "spec.md"
  headerVersion?: string;
  headerStatus?: string; // Raw (may be off-vocab — the checker validates)
  footerVersion?: string;
  sections: SectionStatus[];
  /** Legacy / off-vocabulary forms found, for the checker to reject. */
  badForms: { line: number; text: string; reason: string }[];
}

const NUMBERED_HEADING = /^#{2,6}\s+(\d+(?:\.\d+)*[a-z]?)\s+(.*)$/;
const BLOCKQUOTE_STATUS = /^>\s*\*\*Status:\s*([A-Za-z]+)/;
const HEADER_VERSION = /^\*\*Version:\*\*\s*(.+)$/;
const HEADER_STATUS = /^\*\*Status:\*\*\s*(.+)$/;
const FOOTER_VERSION = /Specification v([0-9][A-Za-z0-9.-]*)/;

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

/** Parse one spec file's status markers. */
export function parseSpecFile(path: string, file: string): SpecStatus {
  const lines = readFileSync(path, "utf8").split("\n");
  const out: SpecStatus = { file, sections: [], badForms: [] };
  let currentSection: SectionStatus | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const lineNo = i + 1;

    const v = line.match(HEADER_VERSION);
    if (v && out.headerVersion === undefined) {
      out.headerVersion = v[1]!.trim();
    }
    const hs = line.match(HEADER_STATUS);
    if (hs && out.headerStatus === undefined && !line.startsWith(">")) {
      out.headerStatus = hs[1]!.trim().replace(/\.$/, "");
    }
    const fv = line.match(FOOTER_VERSION);
    if (fv) {
      out.footerVersion = fv[1]!;
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

/** Parse every spec file in `specsDir` (top-level only; design-notes and subdirs are exempt). */
export function parseSpecStatuses(specsDir: string): SpecStatus[] {
  return readdirSync(specsDir)
    .filter((f) => f.endsWith(".md"))
    .toSorted()
    .map((f) => parseSpecFile(join(specsDir, f), f));
}
