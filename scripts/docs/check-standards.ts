// Gate for the `## N. Standards Alignment` tables. Every spec that has numbered headings declares
// Which external standards it binds itself to and how; this checks that each row cites a KNOWN
// Standard at its canonical URL, binds a real numbered section, backs a present-tense claim with
// Committed evidence, and — the part that keeps two lists from drifting — that its class agrees
// With the `> **Status:**` marker on the section it binds.
//
// Usage: bun scripts/docs/check-standards.ts
// Contract: specs/standards.md. Parser: scripts/docs/lib/standards.ts.

import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import type { SpecStandards, StandardsRegistry, StandardsRow } from "./lib/standards.ts";
import {
  BACKLOG_HEADER_CELLS,
  BIND_ENTRY,
  buildRegistry,
  CITED,
  CLASS_CELL,
  compareIds,
  canonicalUrlProblem,
  EMPTY_CELL,
  GAP_SLUG,
  HEADER_CELLS,
  isConformance,
  orgOfId,
  sectionAnchors,
  STANDARD_CELL,
  STANDARD_ID,
  statusOfAnchor,
} from "./lib/standards.ts";

const ROOT = resolve(import.meta.dir, "../..");
const SPECS_DIR = resolve(ROOT, "specs");
const CATALOG_PATH = resolve(ROOT, "scripts/docs/standards.json");

/** Minimum prose length after `because:` — enough that "because: no" fails. */
const MIN_REJECTION_CHARS = 24;

export const VIOLATION_CODES = [
  // Structure
  "section-missing",
  "heading-escaped",
  "section-unnumbered",
  "section-duplicate",
  "section-status-marker-forbidden",
  "section-stray-content",
  "table-missing",
  "table-header-mismatch",
  "row-arity",
  // Identity and citation
  "standard-cell-grammar",
  "id-grammar",
  "id-unknown",
  "url-mismatch",
  "catalog-url-noncanonical",
  "catalog-org-mismatch",
  "catalog-stale",
  "catalog-unsorted",
  "catalog-duplicate-id",
  // Binding
  "bind-empty",
  "bind-grammar",
  "bind-unresolved",
  "binding-duplicate",
  "class-conflict",
  "cross-spec-conflict",
  // Class ↔ evidence
  "class-grammar",
  "class-unknown",
  "evidence-required",
  "evidence-forbidden",
  "evidence-path-missing",
  "evidence-not-a-file",
  "evidence-spec-anchor-unresolved",
  // Class ↔ status join
  "pending-needs-marked-section",
  "pending-section-removed",
  "cited-section-unbuilt",
  // Notes
  "note-required",
  "note-pipe",
  "gap-id-missing",
  "gap-id-grammar",
  "gap-id-duplicate",
  "gap-id-on-non-pending",
  "rejection-missing",
  // Adoption backlog
  "backlog-header-mismatch",
  "backlog-row-arity",
  "backlog-standard-cell-grammar",
  "backlog-id-unknown",
  "backlog-url-mismatch",
  "backlog-duplicate",
  "backlog-already-cited",
  "backlog-target-unknown",
  "backlog-why-missing",
  "backlog-misplaced",
  // Ratchets
  "uncited-stale",
  "exempt-stale",
  // Parser-reported legacy forms
  "bad-form",
] as const;

export type ViolationCode = (typeof VIOLATION_CODES)[number];

export interface Violation {
  code: ViolationCode;
  file: string;
  line?: number;
  message: string;
}

export interface UncitedEntry {
  file: string;
  why: string;
}

/**
 * Specs that have not yet grown a `## N. Standards Alignment` section. This list only SHRINKS: a
 * Spec that gains a section must be removed from it in the same PR (`uncited-stale`), so the
 * Foundation can land before the citations without leaving the requirement unenforced afterwards.
 * When it reaches empty, a new spec with numbered headings and no table fails on its first PR.
 */
export const UNCITED: UncitedEntry[] = [];

/** Specs with no numbered headings at all: there is no anchor a `Binds` cell could name. */
export const EXEMPT_UNNUMBERED: UncitedEntry[] = [];

function v(code: ViolationCode, file: string, message: string, line?: number): Violation {
  return line === undefined ? { code, file, message } : { code, file, line, message };
}

/** Evidence of the form `specs/<file>#<anchor>`, mirroring check-site-claims.ts. */
const SPEC_ANCHOR = /^specs\/([^#]+\.md)#(\d+(?:\.\d+)*[a-z]?)$/;

function checkEvidence(
  reg: StandardsRegistry,
  spec: SpecStandards,
  row: StandardsRow,
  out: Violation[],
): void {
  for (const e of row.evidence) {
    const anchor = e.match(SPEC_ANCHOR);
    if (anchor) {
      const target = reg.statuses.get(anchor[1]!);
      if (!target || !sectionAnchors(target).has(anchor[2]!)) {
        out.push(
          v(
            "evidence-spec-anchor-unresolved",
            spec.file,
            `${row.id}: evidence "${e}" names no numbered section`,
            row.line,
          ),
        );
      }
      continue;
    }
    const abs = resolve(ROOT, e);
    if (!existsSync(abs)) {
      out.push(
        v(
          "evidence-path-missing",
          spec.file,
          `${row.id}: evidence "${e}" does not exist`,
          row.line,
        ),
      );
      continue;
    }
    if (statSync(abs).isDirectory()) {
      out.push(
        v(
          "evidence-not-a-file",
          spec.file,
          `${row.id}: evidence "${e}" is a directory — too vague to be evidence`,
          row.line,
        ),
      );
    }
  }
}

/** Validate a gap slug and claim it repo-wide. Shared by the Pending and Subset branches. */
function recordGapId(
  spec: SpecStandards,
  row: StandardsRow,
  gapIds: Map<string, string>,
  out: Violation[],
): void {
  const id = row.gapId!;
  if (!GAP_SLUG.test(id)) {
    out.push(v("gap-id-grammar", spec.file, `"gap:${id}" is not a kebab-case slug`, row.line));
  }
  const owner = gapIds.get(id);
  if (owner) {
    out.push(
      v("gap-id-duplicate", spec.file, `gap id "${id}" is already used by ${owner}`, row.line),
    );
  } else {
    gapIds.set(id, `${spec.file}:${row.line}`);
  }
}

/**
 * The adoption backlog: standards the audit found relevant whose owning spec section does not exist
 * yet, so no row can bind them. It lives in standards.md alone, and every entry must still name a
 * catalog identifier and a real target spec — otherwise "we will get to it" is a note nobody can
 * act on and a typo nobody catches.
 */
function checkBacklog(reg: StandardsRegistry, out: Violation[]): void {
  const citedIds = new Set(reg.rows.map((r) => r.id));
  const specFiles = new Set(reg.specs.map((sp) => sp.file));
  const seen = new Map<string, number>();

  for (const spec of reg.specs) {
    if (spec.backlog.length === 0 && spec.backlogHeaderCells === undefined) {
      continue;
    }
    if (spec.file !== "standards.md") {
      out.push(
        v(
          "backlog-misplaced",
          spec.file,
          "the adoption backlog lives in standards.md alone — a spec tracks what it binds, not " +
            "what some other spec might one day bind",
          spec.backlog[0]?.line,
        ),
      );
      continue;
    }
    const header = spec.backlogHeaderCells ?? [];
    if (
      header.length !== BACKLOG_HEADER_CELLS.length ||
      header.some((c, i) => c !== BACKLOG_HEADER_CELLS[i])
    ) {
      out.push(
        v(
          "backlog-header-mismatch",
          spec.file,
          `backlog header must be exactly | ${BACKLOG_HEADER_CELLS.join(" | ")} |`,
        ),
      );
    }
    for (const b of spec.backlog) {
      if (b.cellCount !== BACKLOG_HEADER_CELLS.length) {
        out.push(
          v("backlog-row-arity", spec.file, `backlog row has ${b.cellCount} cell(s)`, b.line),
        );
      }
      if (!STANDARD_CELL.test(`[${b.id}](${b.url})`) || b.url === "") {
        out.push(
          v(
            "backlog-standard-cell-grammar",
            spec.file,
            `the Standard cell must be [<id>](https://…), found "${b.id}"`,
            b.line,
          ),
        );
      }
      const entry = reg.catalog.get(b.id);
      if (!entry) {
        out.push(v("backlog-id-unknown", spec.file, `"${b.id}" is not in the catalog`, b.line));
      } else if (b.url !== "" && b.url !== entry.url) {
        out.push(
          v(
            "backlog-url-mismatch",
            spec.file,
            `"${b.id}" cites ${b.url}, catalog has ${entry.url}`,
            b.line,
          ),
        );
      }
      const prior = seen.get(b.id);
      if (prior !== undefined) {
        out.push(
          v(
            "backlog-duplicate",
            spec.file,
            `"${b.id}" is already on the backlog at line ${prior}`,
            b.line,
          ),
        );
      }
      seen.set(b.id, b.line);
      if (citedIds.has(b.id)) {
        out.push(
          v(
            "backlog-already-cited",
            spec.file,
            `"${b.id}" is on the backlog and also bound by a real row — a standard is one or the ` +
              "other, and the row is the stronger claim",
            b.line,
          ),
        );
      }
      if (!specFiles.has(b.target)) {
        out.push(
          v(
            "backlog-target-unknown",
            spec.file,
            `"${b.id}" targets \`${b.target}\`, which is not a spec — an adoption target must name ` +
              "the spec that will own the standard",
            b.line,
          ),
        );
      }
      if (b.why.trim() === "" || b.why.trim() === EMPTY_CELL) {
        out.push(
          v(
            "backlog-why-missing",
            spec.file,
            `"${b.id}" must say why it is not yet bindable`,
            b.line,
          ),
        );
      }
    }
  }
}

function checkCatalog(reg: StandardsRegistry, out: Violation[]): void {
  const cited = new Set([...reg.rows.map((r) => r.id), ...reg.backlog.map((b) => b.id)]);
  const seen = new Set<string>();
  for (const id of reg.catalogOrder) {
    if (seen.has(id)) {
      out.push(v("catalog-duplicate-id", "standards.json", `duplicate catalog id "${id}"`));
    }
    seen.add(id);
  }
  const sorted = [...reg.catalogOrder].toSorted(compareIds);
  for (let i = 0; i < sorted.length; i++) {
    if (sorted[i] !== reg.catalogOrder[i]) {
      out.push(
        v(
          "catalog-unsorted",
          "standards.json",
          `entries must be sorted by id (codepoint order); "${reg.catalogOrder[i]}" is out of place`,
        ),
      );
      break;
    }
  }
  for (const [id, entry] of reg.catalog) {
    const inferred = orgOfId(id);
    if (inferred !== null && inferred !== entry.org) {
      out.push(
        v(
          "catalog-org-mismatch",
          "standards.json",
          `"${id}" is a ${inferred} identifier but the catalog says ${entry.org}`,
        ),
      );
    }
    const problem = canonicalUrlProblem(entry.org, entry.url);
    if (problem) {
      out.push(
        v("catalog-url-noncanonical", "standards.json", `"${id}" URL is not canonical: ${problem}`),
      );
    }
    if (!cited.has(id)) {
      out.push(
        v(
          "catalog-stale",
          "standards.json",
          `"${id}" is in the catalog but no spec cites it — remove it or cite it`,
        ),
      );
    }
  }
}

function checkStructure(spec: SpecStandards, exempt: boolean, uncited: boolean, out: Violation[]) {
  if (spec.unnumberedHeadingLine !== undefined && !spec.section) {
    out.push(
      v(
        "section-unnumbered",
        spec.file,
        "a 'Standards Alignment' heading exists but is UNNUMBERED. check-doc-refs.ts and " +
          "spec-status.ts are both blind to unnumbered headings: it is not an anchor, it never " +
          "reaches implementation-status.md, and a '> **Status:**' under it is credited to the " +
          "last numbered section above it. Number it.",
        spec.unnumberedHeadingLine,
      ),
    );
    return;
  }
  /*
   * The escape renders invisibly, so nothing looks wrong — and until the heading patterns learned
   * to tolerate it, one of these silently disabled every check below. Reported even though parsing
   * now survives it, because a visual editor that escaped a heading has usually also flattened
   * `[id](url)` cells to bare text and `**Adopted**` to plain, which IS unrecoverable.
   */
  for (const line of spec.escapedHeadings) {
    out.push(
      v(
        "heading-escaped",
        spec.file,
        "numbered heading carries a `\\.` escape from a visual Markdown editor — run " +
          "`bun run format:md` to normalize, then check this file's links and bold survived",
        line,
      ),
    );
  }
  if (!spec.section) {
    if (!exempt && !uncited && spec.hasNumberedHeadings) {
      out.push(
        v(
          "section-missing",
          "heading-escaped",
          spec.file,
          "no `## N. Standards Alignment` section — every spec with numbered headings declares " +
            "which standards it binds itself to (specs/standards.md §4)",
        ),
      );
    }
    return;
  }
  if (spec.sectionCount > 1) {
    out.push(
      v(
        "section-duplicate",
        spec.file,
        `${spec.sectionCount} 'Standards Alignment' sections — there must be exactly one`,
        spec.section.line,
      ),
    );
  }
  if (spec.hasSectionStatusMarker) {
    out.push(
      v(
        "section-status-marker-forbidden",
        spec.file,
        "the Standards Alignment section must not carry a '> **Status:**' marker — a registry is " +
          "not a feature, and its state is the union of its rows",
        spec.section.line,
      ),
    );
  }
  for (const line of spec.strayLines) {
    out.push(
      v(
        "section-stray-content",
        spec.file,
        "the section holds at most one prose paragraph followed by exactly one table",
        line,
      ),
    );
  }
  if (!spec.headerCells) {
    out.push(v("table-missing", spec.file, "the section contains no table", spec.section.line));
    return;
  }
  if (
    spec.headerCells.length !== HEADER_CELLS.length ||
    spec.headerCells.some((c, i) => c !== HEADER_CELLS[i])
  ) {
    out.push(
      v(
        "table-header-mismatch",
        spec.file,
        `header must be exactly | ${HEADER_CELLS.join(" | ")} |, found | ${spec.headerCells.join(" | ")} |`,
        spec.section.line,
      ),
    );
  }
}

function checkRow(
  reg: StandardsRegistry,
  spec: SpecStandards,
  row: StandardsRow,
  seenBindings: Set<string>,
  classById: Map<string, string>,
  gapIds: Map<string, string>,
  out: Violation[],
): void {
  const status = reg.statuses.get(spec.file);

  if (row.cellCount !== HEADER_CELLS.length) {
    out.push(
      v(
        "row-arity",
        spec.file,
        `row has ${row.cellCount} cell(s); the table has ${HEADER_CELLS.length} columns`,
        row.line,
      ),
    );
  }

  // ── Identity ──
  if (!STANDARD_CELL.test(`[${row.id}](${row.url})`) || row.url === "") {
    out.push(
      v(
        "standard-cell-grammar",
        spec.file,
        `the Standard cell must be [<id>](https://…), found "${row.id}"`,
        row.line,
      ),
    );
  }
  if (!STANDARD_ID.test(row.id)) {
    out.push(v("id-grammar", spec.file, `"${row.id}" is not a standard identifier`, row.line));
  }
  const entry = reg.catalog.get(row.id);
  if (!entry) {
    out.push(
      v(
        "id-unknown",
        spec.file,
        `"${row.id}" is not in scripts/docs/standards.json — add it there (with its issuing body, ` +
          "title and canonical URL) or fix the identifier",
        row.line,
      ),
    );
  } else if (row.url !== "" && row.url !== entry.url) {
    out.push(
      v(
        "url-mismatch",
        spec.file,
        `"${row.id}" cites ${row.url} but the catalog vouches for ${entry.url}`,
        row.line,
      ),
    );
  }

  // ── Class ──
  if (!CLASS_CELL.test(row.rawClass)) {
    out.push(
      v(
        "class-grammar",
        spec.file,
        `the Class cell must be bold, e.g. **Adopted**, found "${row.rawClass}"`,
        row.line,
      ),
    );
  }
  const word = row.rawClass.match(CLASS_CELL)?.[1] ?? "";
  if (word !== "" && !isConformance(word)) {
    out.push(v("class-unknown", spec.file, `"${word}" is not a conformance class`, row.line));
  }
  const cls = row.conformance;
  const prior = classById.get(row.id);
  if (cls && prior && prior !== cls) {
    out.push(
      v(
        "class-conflict",
        spec.file,
        `"${row.id}" is ${prior} elsewhere in this spec and ${cls} here`,
        row.line,
      ),
    );
  }
  if (cls) {
    classById.set(row.id, cls);
  }

  // ── Binding ──
  if (row.binds.length === 0) {
    out.push(v("bind-empty", spec.file, `"${row.id}" binds no section`, row.line));
  }
  for (const b of row.binds) {
    const m = b.match(BIND_ENTRY);
    if (!m) {
      out.push(v("bind-grammar", spec.file, `"${b}" is not a §<anchor> reference`, row.line));
      continue;
    }
    const anchor = m[1]!;
    if (!sectionAnchors(status).has(anchor)) {
      out.push(
        v(
          "bind-unresolved",
          spec.file,
          `"${row.id}" binds §${anchor}, which is not a numbered heading in this spec`,
          row.line,
        ),
      );
      continue;
    }
    const key = `${row.id} ${anchor}`;
    if (seenBindings.has(key)) {
      out.push(v("binding-duplicate", spec.file, `"${row.id}" binds §${anchor} twice`, row.line));
    }
    seenBindings.add(key);

    // ── The join: class ↔ the section's own status marker ──
    const sectionStatus = statusOfAnchor(status, anchor);
    if (cls === "Pending" && sectionStatus === "Removed") {
      out.push(
        v(
          "pending-section-removed",
          spec.file,
          `"${row.id}" is Pending against §${anchor}, which is Removed`,
          row.line,
        ),
      );
    }
    if (cls && CITED.has(cls) && (sectionStatus === "Pending" || sectionStatus === "Future")) {
      out.push(
        v(
          "cited-section-unbuilt",
          spec.file,
          `"${row.id}" claims ${cls} against §${anchor}, which is marked ${sectionStatus}`,
          row.line,
        ),
      );
    }
  }
  if (cls === "Pending") {
    const anyMarked = row.binds.some((b) => {
      const anchor = b.match(BIND_ENTRY)?.[1];
      if (!anchor) {
        return false;
      }
      const s = statusOfAnchor(status, anchor);
      return s !== undefined && s !== "Implemented";
    });
    if (!anyMarked) {
      out.push(
        v(
          "pending-needs-marked-section",
          spec.file,
          `"${row.id}" is Pending but no section it binds carries a non-Implemented ` +
            "'> **Status:**' marker — mark the section, or the promise is untracked",
          row.line,
        ),
      );
    }
  }

  // ── Evidence ──
  const wantsEvidence = cls !== undefined && CITED.has(cls);
  if (wantsEvidence && row.evidence.length === 0) {
    out.push(
      v(
        "evidence-required",
        spec.file,
        `"${row.id}" claims ${cls}, which is a present-tense claim and owes committed evidence`,
        row.line,
      ),
    );
  }
  if (!wantsEvidence && cls !== undefined && row.evidence.length > 0) {
    out.push(
      v(
        "evidence-forbidden",
        spec.file,
        `"${row.id}" is ${cls} — a forward or negative claim cannot have evidence; use ${EMPTY_CELL}`,
        row.line,
      ),
    );
  }
  checkEvidence(reg, spec, row, out);

  // ── Notes ──
  if (row.note.includes("|")) {
    out.push(
      v(
        "note-pipe",
        spec.file,
        `"${row.id}": a note may not contain a literal | — reword`,
        row.line,
      ),
    );
  }
  const needsNote = cls !== undefined && cls !== "Adopted";
  if (needsNote && row.note.trim() === "") {
    out.push(
      v("note-required", spec.file, `"${row.id}" is ${cls} and must say what that means`, row.line),
    );
  }
  if (cls === "Subset" && row.gapId !== undefined) {
    recordGapId(spec, row, gapIds, out);
  }
  if (cls === "Pending") {
    if (row.gapId === undefined) {
      out.push(
        v(
          "gap-id-missing",
          spec.file,
          `"${row.id}" is Pending, so its note must open with \`gap:<slug>\``,
          row.line,
        ),
      );
    } else {
      recordGapId(spec, row, gapIds, out);
    }
  } else if (row.gapId !== undefined && cls !== "Subset") {
    // A Subset MAY carry a gap id: the part of the standard it does not implement is a real,
    // Trackable absence. A Divergent's deviations are deliberate and an Adopted has nothing
    // Missing, so a gap id on either is a sign the class is wrong.
    out.push(
      v(
        "gap-id-on-non-pending",
        spec.file,
        `"${row.id}" is ${cls ?? "off-vocabulary"} and carries a gap id — only Pending (required) ` +
          "and Subset (optional) may name a gap",
        row.line,
      ),
    );
  }
  if (cls === "Rejected") {
    if (row.rejection === undefined) {
      out.push(
        v(
          "rejection-missing",
          spec.file,
          `"${row.id}" is Rejected, so its note must open with "because: " and say why`,
          row.line,
        ),
      );
    } else if (row.rejection.length < MIN_REJECTION_CHARS) {
      out.push(
        v(
          "rejection-missing",
          spec.file,
          `"${row.id}": the reason after "because:" must be a real sentence`,
          row.line,
        ),
      );
    }
  }
}

export function checkStandards(
  reg: StandardsRegistry,
  opts: { uncited?: readonly UncitedEntry[]; exemptUnnumbered?: readonly UncitedEntry[] } = {},
): Violation[] {
  const uncited = opts.uncited ?? UNCITED;
  const exempt = opts.exemptUnnumbered ?? EXEMPT_UNNUMBERED;
  const out: Violation[] = [];
  const uncitedFiles = new Set(uncited.map((u) => u.file));
  const exemptFiles = new Set(exempt.map((u) => u.file));
  const gapIds = new Map<string, string>();
  const classByIdGlobal = new Map<string, { cls: string; where: string }>();

  for (const spec of reg.specs) {
    // A spec on UNCITED has not adopted the format yet, so its prose is not measured against it.
    // Several specs already carry a heading titled "Standards Alignment" holding a hand-written
    // Table of a different shape — reporting thirty grammar violations against those would be
    // Noise, and the thing that actually matters is that the list reaches empty.
    if (uncitedFiles.has(spec.file)) {
      continue;
    }
    for (const b of spec.badForms) {
      out.push(v("bad-form", spec.file, b.reason, b.line));
    }
    checkStructure(spec, exemptFiles.has(spec.file), false, out);

    const seenBindings = new Set<string>();
    const classById = new Map<string, string>();
    for (const row of spec.rows) {
      checkRow(reg, spec, row, seenBindings, classById, gapIds, out);
      if (row.conformance) {
        const prior = classByIdGlobal.get(row.id);
        const isRejection = row.conformance === "Rejected";
        if (prior && (prior.cls === "Rejected") !== isRejection) {
          out.push(
            v(
              "cross-spec-conflict",
              spec.file,
              `"${row.id}" is ${prior.cls} in ${prior.where} and ${row.conformance} here — ` +
                "declining a standard is a repo-wide decision",
              row.line,
            ),
          );
        }
        classByIdGlobal.set(row.id, { cls: row.conformance, where: spec.file });
      }
    }
  }

  // ── Ratchets ──
  for (const u of uncited) {
    const spec = reg.specs.find((s) => s.file === u.file);
    // The trigger is a CONFORMING header row, not merely a heading with that title: several specs
    // Already carry a hand-written "Standards Alignment" table of a different shape, and only the
    // Five-column header means the spec has actually adopted the format.
    const adopted =
      spec?.headerCells !== undefined &&
      spec.headerCells.length === HEADER_CELLS.length &&
      spec.headerCells.every((c, i) => c === HEADER_CELLS[i]);
    if (adopted) {
      out.push(
        v(
          "uncited-stale",
          u.file,
          "this spec now carries a conforming Standards Alignment table — remove it from UNCITED " +
            "in scripts/docs/check-standards.ts (the list only shrinks)",
          spec.section?.line,
        ),
      );
    }
  }
  for (const e of exempt) {
    const spec = reg.specs.find((s) => s.file === e.file);
    if (spec?.hasNumberedHeadings) {
      out.push(
        v(
          "exempt-stale",
          e.file,
          "this spec now has numbered headings — remove it from EXEMPT_UNNUMBERED and cite it",
        ),
      );
    }
  }

  checkBacklog(reg, out);
  checkCatalog(reg, out);
  return out;
}

if (import.meta.main) {
  const registry = buildRegistry(SPECS_DIR, CATALOG_PATH);
  const violations = checkStandards(registry);
  if (violations.length > 0) {
    for (const x of violations) {
      const where = x.line === undefined ? x.file : `${x.file}:${x.line}`;
      console.error(`${where} [${x.code}] ${x.message}`);
    }
    console.error(`\n${violations.length} standards-alignment violation(s).`);
    process.exit(1);
  }
  const uncited = new Set(UNCITED.map((u) => u.file));
  const adopted = registry.specs.filter((s) => s.section && !uncited.has(s.file));
  const bindings = adopted.reduce((n, s) => n + s.rows.reduce((m, r) => m + r.binds.length, 0), 0);
  const owed = UNCITED.length > 0 ? `; ${UNCITED.length} spec(s) still owed (UNCITED).` : ".";
  console.log(
    `standards: ${bindings} binding(s) across ${adopted.length} spec(s); catalog is clean${owed}`,
  );
}
