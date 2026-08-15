// Shared parser for the `## N. Standards Alignment` tables and the standards catalog. Used by
// Check-standards.ts (enforcement) and the standards docs generator. Modelled on spec-status.ts:
// One canonical parser, so a machine can read "which external standards Jx binds itself to, and
// How" straight from the specs themselves rather than from a registry that lives beside them.
//
// The specs own the tables. This file only reads them. See specs/standards.md for the contract.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { SpecStatus, Status } from "./spec-status.ts";
import { NUMBERED_HEADING, parseSpecStatuses } from "./spec-status.ts";

/* ── Vocabulary ─────────────────────────────────────────────────────────────── */

/** The one canonical conformance vocabulary. See specs/standards.md §3. */
export const CONFORMANCE_VOCAB = [
  "Adopted",
  "Subset",
  "Divergent",
  "Borrowed",
  "Pending",
  "Rejected",
] as const;
export type Conformance = (typeof CONFORMANCE_VOCAB)[number];

export function isConformance(word: string): word is Conformance {
  return (CONFORMANCE_VOCAB as readonly string[]).includes(word);
}

/**
 * Present-tense truth claims. These four assert something about the code as it stands, so they owe
 * committed evidence. `Pending` and `Rejected` are forward and negative claims — they CANNOT have
 * evidence, and owe prose instead. Both of the violations worth catching (an Adopted row with no
 * evidence, a Pending row carrying evidence) fall out of this one set.
 */
export const CITED: ReadonlySet<Conformance> = new Set([
  "Adopted",
  "Subset",
  "Divergent",
  "Borrowed",
]);

/**
 * Gap tiers are DERIVED from the bound section's status marker, never authored. Zero new metadata,
 * and a tier moves automatically when the status marker moves.
 */
export const GAP_TIER_BY_STATUS = {
  Partial: "Near",
  Pending: "Next",
  Future: "Later",
} as const satisfies Partial<Record<Status, string>>;

export const TIER_ORDER = ["Near", "Next", "Later"] as const;
export type GapTier = (typeof TIER_ORDER)[number];

export function tierOf(status: Status | undefined): GapTier | null {
  if (status === undefined) {
    return null;
  }
  return (GAP_TIER_BY_STATUS as Partial<Record<Status, GapTier>>)[status] ?? null;
}

/* ── Grammar ────────────────────────────────────────────────────────────────── */

/** `## 22. Standards Alignment` — the trailing dot is optional, as everywhere else in the specs. */
export const STANDARDS_HEADING = /^(#{2,6})\s+(\d+(?:\.\d+)*[a-z]?)\.?\s+Standards Alignment\s*$/;

/**
 * The appendix trap: an UNNUMBERED heading with this title. `check-doc-refs.ts`'s HEADING_RE and
 * `spec-status.ts`'s NUMBERED_HEADING are both blind to it, so it is not an anchor, it never
 * reaches implementation-status.md, and a `> **Status:**` under it is credited to the last numbered
 * section ABOVE it. Matched so the checker can name the trap by line number.
 */
export const UNNUMBERED_STANDARDS_HEADING = /^#{2,6}\s+(?!\d)[^\n]*Standards Alignment\s*$/;

export const STANDARD_CELL = /^\[([^\]]+)\]\((https:\/\/[^\s)]+)\)$/;
export const CLASS_CELL = /^\*\*([A-Za-z]+)\*\*$/;
export const BIND_ENTRY = /^§(\d+(?:\.\d+)*[a-z]?)$/;
export const GAP_NOTE = /^`gap:([a-z0-9]+(?:-[a-z0-9]+)*)`\s+(\S.*)$/;
export const REJECTION_NOTE = /^because:\s+(\S.*)$/;
export const GAP_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** The one canonical header row. */
export const HEADER_CELLS = ["Standard", "Class", "Binds", "Evidence", "Note"] as const;

/** The empty-cell sentinel, matching the specs' existing table idiom. */
export const EMPTY_CELL = "—";

export const STANDARD_ID =
  /^(?:RFC \d{3,5}|BCP \d{1,3}|STD \d{1,3}|UAX #\d{1,3}|UTS #\d{1,3}|UTR #\d{1,3}|ECMA-\d{2,3}|ISO(?:\/IEC)? \d{4,5}(?::\d{4})?|[A-Z][A-Za-z0-9-]*(?:[ /][A-Za-z0-9.#+-]+)*)$/;

/** Legacy / near-miss forms the checker rejects, in spec-status.ts's `badForms` idiom. */
const LEGACY = [
  {
    re: /\|\s*Planned\s*\|/,
    reason: 'use a bold cell "**Pending**", not plain "Planned" (it also trips docs:status)',
  },
  { re: /\|\s*\*\*Planned\*\*\s*\|/, reason: 'the gap class is "**Pending**", not "**Planned**"' },
  { re: /\|\s*\*\*Conformant\*\*\s*\|/, reason: 'use "**Adopted**"' },
  {
    re: /\|\s*\*\*N\/A\*\*\s*\|/,
    reason: 'use "**Rejected**" with a "because:" note',
  },
  {
    re: /https?:\/\/tools\.ietf\.org\//,
    reason: "tools.ietf.org is retired — cite https://www.rfc-editor.org/rfc/rfcNNNN",
  },
  {
    re: /https?:\/\/datatracker\.ietf\.org\/doc\/html\/rfc/,
    reason: "cite the RFC Editor URL: https://www.rfc-editor.org/rfc/rfcNNNN",
  },
  {
    re: /https?:\/\/(?:www\.)?w3\.org\/TR\/\d{4}\//,
    reason: "cite the /TR/<shortname>/ latest-version URL, not a dated snapshot",
  },
];

/* ── Data shapes ────────────────────────────────────────────────────────────── */

export interface StandardsRow {
  /** E.g. "RFC 6901". */
  id: string;
  /** Exactly as written in the row — compared against the catalog. */
  url: string;
  /** Undefined when the cell is off-vocabulary; `badForms` carries the reason. */
  conformance?: Conformance;
  rawClass: string;
  /** Section anchors in THIS spec, `§` stripped. */
  binds: string[];
  /** Empty when the cell is the `—` sentinel. */
  evidence: string[];
  /** Empty string when the cell is the `—` sentinel. */
  note: string;
  gapId?: string;
  gapText?: string;
  rejection?: string;
  /** How many cells the row actually had — the arity check reads this, not a heuristic. */
  cellCount: number;
  /** 1-based, in the spec file. */
  line: number;
}

export interface StandardsSection {
  anchor: string;
  title: string;
  line: number;
  depth: number;
}

export interface SpecStandards {
  /** Basename, e.g. "spec.md". */
  file: string;
  section?: StandardsSection;
  /** Line of an unnumbered "Standards Alignment" heading, if one was found (the appendix trap). */
  unnumberedHeadingLine?: number;
  hasNumberedHeadings: boolean;
  hasSectionStatusMarker: boolean;
  /** Non-table, non-blank lines beyond one leading prose paragraph. */
  strayLines: number[];
  sectionCount: number;
  headerCells?: string[];
  rows: StandardsRow[];
  badForms: { line: number; text: string; reason: string }[];
}

export type Org =
  | "IETF"
  | "W3C"
  | "WHATWG"
  | "Unicode"
  | "Ecma"
  | "IANA"
  | "ISO"
  | "JSON Schema"
  | "Other";

export interface CatalogEntry {
  id: string;
  org: Org;
  title: string;
  url: string;
  note?: string;
}

export interface Catalog {
  standards: CatalogEntry[];
}

export interface StandardsRegistry {
  /** Sorted by file. */
  specs: SpecStandards[];
  /** Keyed by spec filename. The join that keeps ONE source of truth for "is it built". */
  statuses: Map<string, SpecStatus>;
  catalog: Map<string, CatalogEntry>;
  /** Catalog ids in file order, so the checker can verify the file is sorted. */
  catalogOrder: string[];
  /** Flattened rows, in (file, line) order. */
  rows: (StandardsRow & { file: string })[];
}

/* ── Cell helpers ───────────────────────────────────────────────────────────── */

/** Split a markdown table row into trimmed cells, or null if the line is not a row. */
export function splitRow(line: string): string[] | null {
  const t = line.trim();
  if (!t.startsWith("|") || !t.endsWith("|") || t.length < 2) {
    return null;
  }
  // Cells are trimmed because oxfmt pads every committed table to its column width.
  return t
    .slice(1, -1)
    .split("|")
    .map((c) => c.trim());
}

export function isSeparatorRow(cells: readonly string[]): boolean {
  return cells.length > 0 && cells.every((c) => /^:?-{3,}:?$/.test(c));
}

/** Codepoint order. Never `localeCompare` — generated output must not depend on ICU or locale. */
export function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Infer the issuing body from the identifier alone, so a mislabelled catalog entry fails. */
export function orgOfId(id: string): Org | null {
  if (/^RFC \d+$/.test(id) || /^(BCP|STD) \d+$/.test(id)) {
    return "IETF";
  }
  if (/^(UAX|UTS|UTR) #\d+$/.test(id)) {
    return "Unicode";
  }
  if (/^ECMA-\d+$/.test(id)) {
    return "Ecma";
  }
  if (/^ISO(\/IEC)? \d+/.test(id)) {
    return "ISO";
  }
  return null;
}

const CANONICAL: Record<Org, { test: RegExp; form: string } | null> = {
  IETF: {
    test: /^https:\/\/www\.rfc-editor\.org\/(rfc\/rfc\d+|info\/(bcp|std)\d+)$/,
    form: "https://www.rfc-editor.org/rfc/rfcNNNN (or /info/bcpNN)",
  },
  W3C: {
    test: /^https:\/\/www\.w3\.org\/TR\/[A-Za-z0-9.-]+\/$/,
    form: "https://www.w3.org/TR/<shortname>/",
  },
  WHATWG: {
    test: /^https:\/\/[a-z]+\.spec\.whatwg\.org\/(#[A-Za-z0-9-]+)?$/,
    form: "https://<spec>.spec.whatwg.org/",
  },
  Unicode: {
    test: /^https:\/\/www\.unicode\.org\/reports\/tr\d+\/$/,
    form: "https://www.unicode.org/reports/trNN/",
  },
  Ecma: {
    test: /^https:\/\/ecma-international\.org\/publications-and-standards\/standards\/ecma-\d+\/$/,
    form: "https://ecma-international.org/publications-and-standards/standards/ecma-NNN/",
  },
  IANA: {
    test: /^https:\/\/www\.iana\.org\/assignments\/[A-Za-z0-9-]+\/?$/,
    form: "https://www.iana.org/assignments/<registry>",
  },
  ISO: {
    test: /^https:\/\/www\.iso\.org\/standard\/\d+\.html$/,
    form: "https://www.iso.org/standard/NNNNN.html",
  },
  "JSON Schema": {
    test: /^https:\/\/json-schema\.org\/[A-Za-z0-9/-]+$/,
    form: "https://json-schema.org/…",
  },
  Other: null,
};

/** Returns a human-readable problem string, or null when the URL is canonical for its body. */
export function canonicalUrlProblem(org: Org, url: string): string | null {
  const rule = CANONICAL[org];
  if (!rule) {
    return null;
  }
  return rule.test.test(url) ? null : `expected the form ${rule.form}`;
}

/* ── Parsing ────────────────────────────────────────────────────────────────── */

const CHANGELOG_HEADING = /^##\s+Changelog\s*$/;
const ANY_HEADING = /^(#{1,6})\s+\S/;
const FENCE = /^\s*(```|~~~)/;
const BLOCKQUOTE_STATUS = /^>\s*\*\*Status:/;

/** Parse one spec's Standards Alignment section from its source text. */
export function parseStandardsSource(source: string, file: string): SpecStandards {
  const lines = source.split("\n");
  const out: SpecStandards = {
    file,
    hasNumberedHeadings: false,
    hasSectionStatusMarker: false,
    strayLines: [],
    sectionCount: 0,
    rows: [],
    badForms: [],
  };

  // Pass 1 — locate the section, and note the appendix trap wherever it appears.
  let inFence = false;
  let sectionStart = -1;
  let sectionDepth = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (FENCE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      continue;
    }
    if (CHANGELOG_HEADING.test(line)) {
      break;
    }
    if (NUMBERED_HEADING.test(line)) {
      out.hasNumberedHeadings = true;
    }
    const h = line.match(STANDARDS_HEADING);
    if (h) {
      out.sectionCount += 1;
      if (sectionStart === -1) {
        sectionStart = i;
        sectionDepth = h[1]!.length;
        out.section = {
          anchor: h[2]!,
          title: "Standards Alignment",
          line: i + 1,
          depth: sectionDepth,
        };
      }
      continue;
    }
    if (out.unnumberedHeadingLine === undefined && UNNUMBERED_STANDARDS_HEADING.test(line)) {
      out.unnumberedHeadingLine = i + 1;
    }
  }

  if (sectionStart === -1) {
    return out;
  }

  // Pass 2 — walk the section body: at most one leading prose paragraph, then exactly one table.
  let sawTable = false;
  let sawProse = false;
  let headerSeen = false;
  inFence = false;

  for (let i = sectionStart + 1; i < lines.length; i++) {
    const line = lines[i]!;
    const lineNo = i + 1;

    if (FENCE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      continue;
    }
    if (CHANGELOG_HEADING.test(line)) {
      break;
    }
    // The section ends at the next heading of equal or shallower depth.
    const hh = line.match(ANY_HEADING);
    if (hh && hh[1]!.length <= sectionDepth) {
      break;
    }
    if (line.trim() === "" || line.trim() === "---") {
      continue;
    }

    if (BLOCKQUOTE_STATUS.test(line)) {
      out.hasSectionStatusMarker = true;
      continue;
    }

    for (const l of LEGACY) {
      if (l.re.test(line)) {
        out.badForms.push({ line: lineNo, text: line.trim(), reason: l.reason });
      }
    }

    const cells = splitRow(line);
    if (!cells) {
      if (sawTable) {
        out.strayLines.push(lineNo);
      } else {
        sawProse = true;
      }
      continue;
    }

    if (isSeparatorRow(cells)) {
      continue;
    }
    if (!headerSeen) {
      out.headerCells = cells;
      headerSeen = true;
      sawTable = true;
      continue;
    }
    sawTable = true;
    out.rows.push(parseRow(cells, lineNo));
  }

  void sawProse;
  return out;
}

function parseRow(cells: readonly string[], line: number): StandardsRow {
  const [standard = "", cls = "", binds = "", evidence = "", note = ""] = cells;

  const sm = standard.match(STANDARD_CELL);
  const cm = cls.match(CLASS_CELL);
  const word = cm?.[1] ?? "";

  const row: StandardsRow = {
    id: sm?.[1]?.trim() ?? standard,
    url: sm?.[2] ?? "",
    rawClass: cls,
    binds:
      binds === EMPTY_CELL || binds === ""
        ? []
        : binds
            .split(",")
            .map((b) => b.trim())
            .filter(Boolean),
    evidence:
      evidence === EMPTY_CELL || evidence === ""
        ? []
        : evidence
            .split(",")
            .map((e) => e.trim())
            .filter(Boolean),
    note: note === EMPTY_CELL ? "" : note,
    cellCount: cells.length,
    line,
  };
  if (isConformance(word)) {
    row.conformance = word;
  }

  const g = row.note.match(GAP_NOTE);
  if (g) {
    row.gapId = g[1]!;
    row.gapText = g[2]!.trim();
  }
  const r = row.note.match(REJECTION_NOTE);
  if (r) {
    row.rejection = r[1]!.trim();
  }
  return row;
}

export function parseStandardsFile(path: string, file: string): SpecStandards {
  return parseStandardsSource(readFileSync(path, "utf8"), file);
}

/** Parse every top-level spec (README.md and subdirectories exempt), sorted by filename. */
export function parseSpecStandards(specsDir: string): SpecStandards[] {
  return readdirSync(specsDir)
    .filter((f) => f.endsWith(".md") && f !== "README.md")
    .toSorted()
    .map((f) => parseStandardsFile(join(specsDir, f), f));
}

export function readCatalog(path: string): Catalog {
  return JSON.parse(readFileSync(path, "utf8")) as Catalog;
}

/** Build the whole registry: the specs' tables, their status markers, and the catalog. */
export function buildRegistry(specsDir: string, catalogPath: string): StandardsRegistry {
  const specs = parseSpecStandards(specsDir);
  const statuses = new Map(parseSpecStatuses(specsDir).map((s) => [s.file, s]));
  const cat = readCatalog(catalogPath);
  const catalog = new Map<string, CatalogEntry>();
  for (const e of cat.standards) {
    if (!catalog.has(e.id)) {
      catalog.set(e.id, e);
    }
  }
  const rows = specs.flatMap((s) => s.rows.map((r) => ({ ...r, file: s.file })));
  return {
    specs,
    statuses,
    catalog,
    catalogOrder: cat.standards.map((e) => e.id),
    rows,
  };
}

/** The bind targets that actually resolve, for a given spec: its numbered section anchors. */
export function sectionAnchors(status: SpecStatus | undefined): Set<string> {
  return new Set((status?.sections ?? []).map((s) => s.anchor));
}

/** The status marker on a bound section, or undefined when the section carries no opinion. */
export function statusOfAnchor(status: SpecStatus | undefined, anchor: string): Status | undefined {
  return status?.sections.find((s) => s.anchor === anchor)?.status;
}
