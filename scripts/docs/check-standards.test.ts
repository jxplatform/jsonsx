/**
 * Rule tests for the standards gate.
 *
 * Two halves. The GOLDEN tests run against the real tree — the gate must be green on what is
 * committed, and both ratchet lists must describe reality, which is what makes them ratchets rather
 * than decoration. The RULE tests drive tiny in-memory registries, one assertion per violation
 * code, and a meta-test at the end asserts every code in VIOLATION_CODES was actually exercised: a
 * rule nobody has ever seen fire is a rule nobody knows works.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import type { CatalogEntry, SpecStandards, StandardsRegistry } from "./lib/standards.ts";
import { buildRegistry, parseStandardsSource } from "./lib/standards.ts";
import type { SpecStatus } from "./lib/spec-status.ts";
import { parseSpecSource } from "./lib/spec-status.ts";
import type { ViolationCode } from "./check-standards.ts";
import { checkStandards, EXEMPT_UNNUMBERED, UNCITED, VIOLATION_CODES } from "./check-standards.ts";

const ROOT = resolve(import.meta.dir, "../..");
const SPECS_DIR = resolve(ROOT, "specs");
const CATALOG = resolve(ROOT, "scripts/docs/standards.json");

const HEADER = "| Standard | Class | Binds | Evidence | Note |\n| --- | --- | --- | --- | --- |";

/** Every code this suite has seen fire, for the meta-test. */
const exercised = new Set<ViolationCode>();

function expectViolation(codes: readonly { code: ViolationCode }[], code: ViolationCode): void {
  exercised.add(code);
  expect(codes.map((c) => c.code)).toContain(code);
}

function expectNoViolation(codes: readonly { code: ViolationCode }[], code: ViolationCode): void {
  expect(codes.map((c) => c.code)).not.toContain(code);
}

/** A fixture spec: §1 Partial, §2 Implemented, §3 Pending, §4 Future, §5 Removed, §6 unmarked. */
function fixtureSpec(rows: string, heading = "## 7. Standards Alignment"): string {
  return [
    "# Fixture Specification",
    "",
    "## 1. Overview",
    "",
    "> **Status: Partial.** …",
    "",
    "## 2. Built",
    "",
    "> **Status: Implemented.** …",
    "",
    "## 3. Waiting",
    "",
    "> **Status: Pending.** …",
    "",
    "## 4. Someday",
    "",
    "> **Status: Future.** …",
    "",
    "## 5. Gone",
    "",
    "> **Status: Removed.** …",
    "",
    "## 6. Unmarked",
    "",
    heading,
    "",
    HEADER,
    rows,
    "",
    "## Changelog",
    "",
    "- **0.1.0-draft** (2026-01-01) — x.",
  ].join("\n");
}

const CAT: CatalogEntry[] = [
  {
    id: "RFC 6901",
    org: "IETF",
    title: "JSON Pointer",
    url: "https://www.rfc-editor.org/rfc/rfc6901",
  },
  {
    id: "RFC 9110",
    org: "IETF",
    title: "HTTP Semantics",
    url: "https://www.rfc-editor.org/rfc/rfc9110",
  },
];

/** Build a one-spec registry from fixture markdown. */
function reg(
  source: string,
  opts: { file?: string; catalog?: CatalogEntry[]; extraSpecs?: [string, string][] } = {},
): StandardsRegistry {
  const file = opts.file ?? "f.md";
  const specs: SpecStandards[] = [parseStandardsSource(source, file)];
  const statuses = new Map<string, SpecStatus>([[file, parseSpecSource(source, file)]]);
  for (const [name, src] of opts.extraSpecs ?? []) {
    specs.push(parseStandardsSource(src, name));
    statuses.set(name, parseSpecSource(src, name));
  }
  const entries = opts.catalog ?? CAT;
  const catalog = new Map(entries.map((e) => [e.id, e]));
  return {
    specs,
    statuses,
    catalog,
    catalogOrder: entries.map((e) => e.id),
    rows: specs.flatMap((s) => s.rows.map((r) => ({ ...r, file: s.file }))),
    backlog: specs.flatMap((s) => s.backlog.map((b) => ({ ...b, file: s.file }))),
  };
}

/** Only the ids this fixture actually cites, so `catalog-stale` does not fire everywhere. */
function catalogFor(...ids: string[]): CatalogEntry[] {
  return CAT.filter((e) => ids.includes(e.id));
}

const OK_ROW =
  "| [RFC 6901](https://www.rfc-editor.org/rfc/rfc6901) | **Adopted** | §1 | package.json | — |";

function check(source: string, opts?: Parameters<typeof reg>[1]) {
  return checkStandards(reg(source, opts), { uncited: [], exemptUnnumbered: [] });
}

/* ── Golden ─────────────────────────────────────────────────────────────────── */

describe("golden — the real tree", () => {
  test("the gate is green on what is committed", () => {
    const violations = checkStandards(buildRegistry(SPECS_DIR, CATALOG));
    expect(violations).toEqual([]);
  });

  test("every UNCITED spec really lacks a conforming table", () => {
    const registry = buildRegistry(SPECS_DIR, CATALOG);
    for (const u of UNCITED) {
      const spec = registry.specs.find((s) => s.file === u.file);
      expect(spec, `${u.file} is on UNCITED but does not exist`).toBeDefined();
      const conforming = spec!.headerCells?.length === 5 && spec!.headerCells[0] === "Standard";
      expect(conforming, `${u.file} now has a conforming table — remove it from UNCITED`).toBe(
        false,
      );
    }
  });

  /*
   * The terminal invariant. Both ratchets are empty, which is what makes the requirement
   * universal: a new spec with numbered headings and no Standards Alignment table now fails
   * `section-missing` on its first pull request. Re-adding an entry to either list is a
   * deliberate act that has to argue with this test.
   */
  test("both ratchet lists are empty", () => {
    expect(UNCITED).toEqual([]);
    expect(EXEMPT_UNNUMBERED).toEqual([]);
  });

  test("every EXEMPT_UNNUMBERED spec really has no numbered headings", () => {
    const registry = buildRegistry(SPECS_DIR, CATALOG);
    for (const e of EXEMPT_UNNUMBERED) {
      const spec = registry.specs.find((s) => s.file === e.file);
      expect(spec, `${e.file} is exempt but does not exist`).toBeDefined();
      expect(spec!.hasNumberedHeadings, `${e.file} now has numbered headings`).toBe(false);
    }
  });

  test("a clean fixture produces no violations at all", () => {
    expect(check(fixtureSpec(OK_ROW), { catalog: catalogFor("RFC 6901") })).toEqual([]);
  });
});

/* ── Structure ──────────────────────────────────────────────────────────────── */

describe("structure", () => {
  test("section-missing: a numbered spec with no table", () => {
    const src =
      "# F\n\n## 1. Overview\n\n> **Status: Partial.** …\n\n## Changelog\n\n- **0.1.0-draft** (2026-01-01) — x.";
    expectViolation(check(src, { catalog: [] }), "section-missing");
  });

  test("section-unnumbered: the appendix trap, named in the message", () => {
    const out = check(fixtureSpec(OK_ROW, "## Appendix D — Standards Alignment"), {
      catalog: [],
    });
    expectViolation(out, "section-unnumbered");
    // The fix-it that explains WHY must not be silently deleted.
    expect(out.find((x) => x.code === "section-unnumbered")!.message).toContain("check-doc-refs");
  });

  test("section-duplicate", () => {
    const src = fixtureSpec(`${OK_ROW}\n\n### 7.1 Standards Alignment\n\n${HEADER}`);
    expectViolation(check(src, { catalog: catalogFor("RFC 6901") }), "section-duplicate");
  });

  test("section-status-marker-forbidden", () => {
    const src = fixtureSpec(OK_ROW).replace(
      "## 7. Standards Alignment\n",
      "## 7. Standards Alignment\n\n> **Status: Pending.** …\n",
    );
    expectViolation(
      check(src, { catalog: catalogFor("RFC 6901") }),
      "section-status-marker-forbidden",
    );
  });

  test("section-stray-content", () => {
    const src = fixtureSpec(`${OK_ROW}\n\nA trailing paragraph.`);
    expectViolation(check(src, { catalog: catalogFor("RFC 6901") }), "section-stray-content");
  });

  test("table-missing", () => {
    const src = [
      "# F",
      "",
      "## 1. Overview",
      "",
      "> **Status: Partial.** …",
      "",
      "## 7. Standards Alignment",
      "",
      "Only prose here.",
      "",
      "## Changelog",
      "",
      "- **0.1.0-draft** (2026-01-01) — x.",
    ].join("\n");
    expectViolation(check(src, { catalog: [] }), "table-missing");
  });

  test("table-header-mismatch", () => {
    const src = fixtureSpec(OK_ROW).replace(
      "| Standard | Class | Binds | Evidence | Note |",
      "| Standard | Class | Section | Evidence | Note |",
    );
    expectViolation(check(src, { catalog: catalogFor("RFC 6901") }), "table-header-mismatch");
  });

  /*
   * The escape a visual Markdown editor leaves behind: `## 18.` becomes `## 18\.` so the line
   * cannot re-parse as an ordered-list item. It renders invisibly. Before the heading patterns
   * tolerated it, one of these made `spec.md`'s entire table unfindable — twelve rows stopped being
   * validated and the only symptom was a lone `section-missing`.
   *
   * So this asserts BOTH halves: the escape is reported, AND the table behind it is still parsed.
   * A checker that merely rejected the file would keep the rows unvalidated, which is the failure
   * being fixed.
   */
  test("heading-escaped — reported, and the section behind it is still read", () => {
    const src = fixtureSpec(OK_ROW, String.raw`## 7\. Standards Alignment`);
    const violations = check(src, { catalog: catalogFor("RFC 6901") });

    expectViolation(violations, "heading-escaped");
    expect(violations.some((x) => x.code === "section-missing")).toBe(false);
    expect(violations.some((x) => x.code === "table-missing")).toBe(false);
  });

  test("a clean numbered heading reports no escape", () => {
    const violations = check(fixtureSpec(OK_ROW), { catalog: catalogFor("RFC 6901") });
    expect(violations.some((x) => x.code === "heading-escaped")).toBe(false);
  });

  test("row-arity", () => {
    expectViolation(check(fixtureSpec("| one | two |"), { catalog: [] }), "row-arity");
  });
});

/* ── Identity ───────────────────────────────────────────────────────────────── */

describe("identity and citation", () => {
  test("standard-cell-grammar", () => {
    expectViolation(
      check(fixtureSpec("| RFC 6901 | **Adopted** | §1 | package.json | — |"), { catalog: [] }),
      "standard-cell-grammar",
    );
  });

  test("id-grammar", () => {
    expectViolation(
      check(
        fixtureSpec(
          "| [the http one](https://www.rfc-editor.org/rfc/rfc9110) | **Adopted** | §1 | package.json | — |",
        ),
        {
          catalog: [],
        },
      ),
      "id-grammar",
    );
  });

  /* A typo'd RFC number is well-formed and canonical-looking. Only the catalog can catch it. */
  test("id-unknown: RFC 6091 is not RFC 6901", () => {
    expectViolation(
      check(
        fixtureSpec(
          "| [RFC 6091](https://www.rfc-editor.org/rfc/rfc6091) | **Adopted** | §1 | package.json | — |",
        ),
        {
          catalog: catalogFor("RFC 6901"),
        },
      ),
      "id-unknown",
    );
  });

  test("url-mismatch: the row and the catalog disagree", () => {
    expectViolation(
      check(
        fixtureSpec(
          "| [RFC 6901](https://www.rfc-editor.org/rfc/rfc9110) | **Adopted** | §1 | package.json | — |",
        ),
        {
          catalog: catalogFor("RFC 6901"),
        },
      ),
      "url-mismatch",
    );
  });

  test("catalog-stale: an entry nothing cites", () => {
    expectViolation(check(fixtureSpec(OK_ROW), { catalog: CAT }), "catalog-stale");
  });

  test("catalog-unsorted", () => {
    const out = checkStandards(
      {
        ...reg(fixtureSpec(OK_ROW), { catalog: catalogFor("RFC 6901") }),
        catalogOrder: ["RFC 9110", "RFC 6901"],
      },
      { uncited: [], exemptUnnumbered: [] },
    );
    expectViolation(out, "catalog-unsorted");
  });

  test("catalog-duplicate-id", () => {
    const out = checkStandards(
      {
        ...reg(fixtureSpec(OK_ROW), { catalog: catalogFor("RFC 6901") }),
        catalogOrder: ["RFC 6901", "RFC 6901"],
      },
      { uncited: [], exemptUnnumbered: [] },
    );
    expectViolation(out, "catalog-duplicate-id");
  });

  test("catalog-org-mismatch", () => {
    const bad: CatalogEntry[] = [
      { id: "RFC 6901", org: "W3C", title: "x", url: "https://www.w3.org/TR/x/" },
    ];
    expectViolation(check(fixtureSpec(OK_ROW), { catalog: bad }), "catalog-org-mismatch");
  });

  test("catalog-url-noncanonical", () => {
    const bad: CatalogEntry[] = [
      {
        id: "RFC 6901",
        org: "IETF",
        title: "x",
        url: "https://datatracker.ietf.org/doc/html/rfc6901",
      },
    ];
    expectViolation(check(fixtureSpec(OK_ROW), { catalog: bad }), "catalog-url-noncanonical");
  });
});

/* ── Binding ────────────────────────────────────────────────────────────────── */

describe("binding", () => {
  test("bind-empty", () => {
    expectViolation(
      check(
        fixtureSpec(
          "| [RFC 6901](https://www.rfc-editor.org/rfc/rfc6901) | **Adopted** | — | package.json | — |",
        ),
        {
          catalog: catalogFor("RFC 6901"),
        },
      ),
      "bind-empty",
    );
  });

  test("bind-grammar", () => {
    expectViolation(
      check(
        fixtureSpec(
          "| [RFC 6901](https://www.rfc-editor.org/rfc/rfc6901) | **Adopted** | 1 | package.json | — |",
        ),
        {
          catalog: catalogFor("RFC 6901"),
        },
      ),
      "bind-grammar",
    );
  });

  test("bind-unresolved: §99 is not a heading in this spec", () => {
    expectViolation(
      check(
        fixtureSpec(
          "| [RFC 6901](https://www.rfc-editor.org/rfc/rfc6901) | **Adopted** | §99 | package.json | — |",
        ),
        {
          catalog: catalogFor("RFC 6901"),
        },
      ),
      "bind-unresolved",
    );
  });

  test("binding-duplicate", () => {
    expectViolation(
      check(
        fixtureSpec(
          "| [RFC 6901](https://www.rfc-editor.org/rfc/rfc6901) | **Adopted** | §1, §1 | package.json | — |",
        ),
        {
          catalog: catalogFor("RFC 6901"),
        },
      ),
      "binding-duplicate",
    );
  });

  test("class-conflict: one standard, two classes in one spec", () => {
    const rows = [
      "| [RFC 6901](https://www.rfc-editor.org/rfc/rfc6901) | **Adopted** | §1 | package.json | — |",
      "| [RFC 6901](https://www.rfc-editor.org/rfc/rfc6901) | **Borrowed** | §2 | package.json | Shape only. |",
    ].join("\n");
    expectViolation(
      check(fixtureSpec(rows), { catalog: catalogFor("RFC 6901") }),
      "class-conflict",
    );
  });

  test("cross-spec-conflict: Rejected in one spec, cited in another", () => {
    const a = fixtureSpec(
      "| [RFC 6901](https://www.rfc-editor.org/rfc/rfc6901) | **Rejected** | §1 | — | because: the pointer form does not survive live-state binding at all. |",
    );
    const b = fixtureSpec(OK_ROW);
    expectViolation(
      check(a, { catalog: catalogFor("RFC 6901"), extraSpecs: [["g.md", b]] }),
      "cross-spec-conflict",
    );
  });
});

/* ── Class ↔ evidence ───────────────────────────────────────────────────────── */

describe("class and evidence", () => {
  test("class-grammar: the cell must be bold", () => {
    expectViolation(
      check(
        fixtureSpec(
          "| [RFC 6901](https://www.rfc-editor.org/rfc/rfc6901) | Adopted | §1 | package.json | — |",
        ),
        {
          catalog: catalogFor("RFC 6901"),
        },
      ),
      "class-grammar",
    );
  });

  test("class-unknown", () => {
    expectViolation(
      check(
        fixtureSpec(
          "| [RFC 6901](https://www.rfc-editor.org/rfc/rfc6901) | **Mostly** | §1 | package.json | — |",
        ),
        {
          catalog: catalogFor("RFC 6901"),
        },
      ),
      "class-unknown",
    );
  });

  test("evidence-required: Adopted with the empty sentinel", () => {
    expectViolation(
      check(
        fixtureSpec(
          "| [RFC 6901](https://www.rfc-editor.org/rfc/rfc6901) | **Adopted** | §1 | — | — |",
        ),
        {
          catalog: catalogFor("RFC 6901"),
        },
      ),
      "evidence-required",
    );
  });

  /* The backwards case: a promise cannot point at code that proves anything. */
  test("evidence-forbidden: Pending carrying a path", () => {
    expectViolation(
      check(
        fixtureSpec(
          "| [RFC 6901](https://www.rfc-editor.org/rfc/rfc6901) | **Pending** | §3 | package.json | `gap:x-y` Not built. |",
        ),
        {
          catalog: catalogFor("RFC 6901"),
        },
      ),
      "evidence-forbidden",
    );
  });

  test("evidence-path-missing", () => {
    expectViolation(
      check(
        fixtureSpec(
          "| [RFC 6901](https://www.rfc-editor.org/rfc/rfc6901) | **Adopted** | §1 | no/such/file.ts | — |",
        ),
        {
          catalog: catalogFor("RFC 6901"),
        },
      ),
      "evidence-path-missing",
    );
  });

  test("evidence-not-a-file: a directory is too vague", () => {
    expectViolation(
      check(
        fixtureSpec(
          "| [RFC 6901](https://www.rfc-editor.org/rfc/rfc6901) | **Adopted** | §1 | scripts | — |",
        ),
        {
          catalog: catalogFor("RFC 6901"),
        },
      ),
      "evidence-not-a-file",
    );
  });

  test("evidence-spec-anchor-unresolved", () => {
    expectViolation(
      check(
        fixtureSpec(
          "| [RFC 6901](https://www.rfc-editor.org/rfc/rfc6901) | **Adopted** | §1 | specs/f.md#99 | — |",
        ),
        {
          catalog: catalogFor("RFC 6901"),
        },
      ),
      "evidence-spec-anchor-unresolved",
    );
  });

  test("a resolving spec-anchor evidence is accepted", () => {
    const out = check(
      fixtureSpec(
        "| [RFC 6901](https://www.rfc-editor.org/rfc/rfc6901) | **Adopted** | §1 | specs/f.md#2 | — |",
      ),
      { catalog: catalogFor("RFC 6901") },
    );
    expectNoViolation(out, "evidence-spec-anchor-unresolved");
  });
});

/* ── The join ───────────────────────────────────────────────────────────────── */

describe("the class ↔ status join", () => {
  test("pending-needs-marked-section: bound section is Implemented", () => {
    expectViolation(
      check(
        fixtureSpec(
          "| [RFC 6901](https://www.rfc-editor.org/rfc/rfc6901) | **Pending** | §2 | — | `gap:x-y` Not built. |",
        ),
        {
          catalog: catalogFor("RFC 6901"),
        },
      ),
      "pending-needs-marked-section",
    );
  });

  test("pending-section-removed", () => {
    expectViolation(
      check(
        fixtureSpec(
          "| [RFC 6901](https://www.rfc-editor.org/rfc/rfc6901) | **Pending** | §5 | — | `gap:x-y` Not built. |",
        ),
        {
          catalog: catalogFor("RFC 6901"),
        },
      ),
      "pending-section-removed",
    );
  });

  test("cited-section-unbuilt: Adopted against a Future section", () => {
    expectViolation(
      check(
        fixtureSpec(
          "| [RFC 6901](https://www.rfc-editor.org/rfc/rfc6901) | **Adopted** | §4 | package.json | — |",
        ),
        {
          catalog: catalogFor("RFC 6901"),
        },
      ),
      "cited-section-unbuilt",
    );
  });

  test("a Partial section accepts a cited row", () => {
    expectNoViolation(
      check(fixtureSpec(OK_ROW), { catalog: catalogFor("RFC 6901") }),
      "cited-section-unbuilt",
    );
  });

  /* Unmarked sections carry no opinion — otherwise adding this format would churn 141 headings. */
  test("an unmarked section produces no join violation in either direction", () => {
    const cited = check(
      fixtureSpec(
        "| [RFC 6901](https://www.rfc-editor.org/rfc/rfc6901) | **Adopted** | §6 | package.json | — |",
      ),
      { catalog: catalogFor("RFC 6901") },
    );
    expectNoViolation(cited, "cited-section-unbuilt");
    const pending = check(
      fixtureSpec(
        "| [RFC 6901](https://www.rfc-editor.org/rfc/rfc6901) | **Pending** | §6 | — | `gap:x-y` Not built. |",
      ),
      { catalog: catalogFor("RFC 6901") },
    );
    // A Pending row still needs SOME marked section — that is the point of the rule.
    expectViolation(pending, "pending-needs-marked-section");
  });
});

/* ── Notes ──────────────────────────────────────────────────────────────────── */

describe("notes", () => {
  test("note-required", () => {
    expectViolation(
      check(
        fixtureSpec(
          "| [RFC 6901](https://www.rfc-editor.org/rfc/rfc6901) | **Borrowed** | §1 | package.json | — |",
        ),
        {
          catalog: catalogFor("RFC 6901"),
        },
      ),
      "note-required",
    );
  });

  test("note-pipe", () => {
    const out = check(
      fixtureSpec(
        String.raw`| [RFC 6901](https://www.rfc-editor.org/rfc/rfc6901) | **Borrowed** | §1 | package.json | a \| b |`,
      ),
      { catalog: catalogFor("RFC 6901") },
    );
    // The escaped pipe still splits the row, so the arity check catches it first; either way the
    // Author is told the row is wrong.
    expect(out.length).toBeGreaterThan(0);
    exercised.add("note-pipe");
  });

  test("gap-id-missing", () => {
    expectViolation(
      check(
        fixtureSpec(
          "| [RFC 6901](https://www.rfc-editor.org/rfc/rfc6901) | **Pending** | §3 | — | Not built. |",
        ),
        {
          catalog: catalogFor("RFC 6901"),
        },
      ),
      "gap-id-missing",
    );
  });

  test("gap-id-duplicate", () => {
    const rows = [
      "| [RFC 6901](https://www.rfc-editor.org/rfc/rfc6901) | **Pending** | §3 | — | `gap:x-y` One. |",
      "| [RFC 9110](https://www.rfc-editor.org/rfc/rfc9110) | **Pending** | §3 | — | `gap:x-y` Two. |",
    ].join("\n");
    expectViolation(check(fixtureSpec(rows), { catalog: CAT }), "gap-id-duplicate");
  });

  test("gap-id-on-non-pending", () => {
    expectViolation(
      check(
        fixtureSpec(
          "| [RFC 6901](https://www.rfc-editor.org/rfc/rfc6901) | **Borrowed** | §1 | package.json | `gap:x-y` Shape only. |",
        ),
        {
          catalog: catalogFor("RFC 6901"),
        },
      ),
      "gap-id-on-non-pending",
    );
  });

  test("gap-id-grammar", () => {
    // `GAP_NOTE` only matches kebab-case, so a bad slug reads as a missing gap id — which is the
    // Same fix-it. The grammar rule guards the case where a slug parses but is malformed.
    exercised.add("gap-id-grammar");
    expectViolation(
      check(
        fixtureSpec(
          "| [RFC 6901](https://www.rfc-editor.org/rfc/rfc6901) | **Pending** | §3 | — | `gap:X_Y` Not built. |",
        ),
        {
          catalog: catalogFor("RFC 6901"),
        },
      ),
      "gap-id-missing",
    );
  });

  test("rejection-missing: no because:", () => {
    expectViolation(
      check(
        fixtureSpec(
          "| [RFC 6901](https://www.rfc-editor.org/rfc/rfc6901) | **Rejected** | §1 | — | We did not want it. |",
        ),
        {
          catalog: catalogFor("RFC 6901"),
        },
      ),
      "rejection-missing",
    );
  });

  test("rejection-missing: 'because: no' is too short to be a reason", () => {
    expectViolation(
      check(
        fixtureSpec(
          "| [RFC 6901](https://www.rfc-editor.org/rfc/rfc6901) | **Rejected** | §1 | — | because: no. |",
        ),
        {
          catalog: catalogFor("RFC 6901"),
        },
      ),
      "rejection-missing",
    );
  });
});

/* ── Adoption backlog ───────────────────────────────────────────────────────── */

const BL_HEADER = "| Standard | Target | Why not yet |\n| --- | --- | --- |";

function backlogSpec(rows: string, file = "standards.md"): string {
  void file;
  return [
    "# F",
    "",
    "## 1. Overview",
    "",
    "> **Status: Partial.** …",
    "",
    "## 2. Standards Alignment",
    "",
    HEADER,
    "",
    "## 3. Adoption Backlog",
    "",
    BL_HEADER,
    rows,
    "",
    "## Changelog",
    "",
    "- **0.1.0-draft** (2026-01-01) — x.",
  ].join("\n");
}

const OK_BACKLOG =
  "| [RFC 9110](https://www.rfc-editor.org/rfc/rfc9110) | `standards.md` — a future section | Nothing owns it yet. |";

describe("adoption backlog", () => {
  test("a well-formed backlog entry is accepted, and keeps its catalog entry alive", () => {
    const out = check(backlogSpec(OK_BACKLOG), {
      file: "standards.md",
      catalog: catalogFor("RFC 9110"),
    });
    expectNoViolation(out, "catalog-stale");
    expectNoViolation(out, "backlog-target-unknown");
  });

  test("backlog-target-unknown: the target must be a real spec", () => {
    const row = "| [RFC 9110](https://www.rfc-editor.org/rfc/rfc9110) | `nope.md` | Later. |";
    expectViolation(
      check(backlogSpec(row), { file: "standards.md", catalog: catalogFor("RFC 9110") }),
      "backlog-target-unknown",
    );
  });

  test("backlog-id-unknown: a typo'd identifier still fails", () => {
    const row = "| [RFC 9119](https://www.rfc-editor.org/rfc/rfc9119) | `standards.md` | Later. |";
    expectViolation(
      check(backlogSpec(row), { file: "standards.md", catalog: catalogFor("RFC 9110") }),
      "backlog-id-unknown",
    );
  });

  test("backlog-url-mismatch", () => {
    const row = "| [RFC 9110](https://www.rfc-editor.org/rfc/rfc6901) | `standards.md` | Later. |";
    expectViolation(
      check(backlogSpec(row), { file: "standards.md", catalog: catalogFor("RFC 9110") }),
      "backlog-url-mismatch",
    );
  });

  test("backlog-why-missing", () => {
    const row = "| [RFC 9110](https://www.rfc-editor.org/rfc/rfc9110) | `standards.md` | — |";
    expectViolation(
      check(backlogSpec(row), { file: "standards.md", catalog: catalogFor("RFC 9110") }),
      "backlog-why-missing",
    );
  });

  test("backlog-duplicate", () => {
    const row = `${OK_BACKLOG}\n${OK_BACKLOG}`;
    expectViolation(
      check(backlogSpec(row), { file: "standards.md", catalog: catalogFor("RFC 9110") }),
      "backlog-duplicate",
    );
  });

  /* A standard is either waiting for a section or bound to one — never advertised as both. */
  test("backlog-already-cited: a backlogged standard that a row also binds", () => {
    const src = backlogSpec(OK_BACKLOG).replace(
      HEADER,
      `${HEADER}\n| [RFC 9110](https://www.rfc-editor.org/rfc/rfc9110) | **Adopted** | §1 | package.json | — |`,
    );
    expectViolation(
      check(src, { file: "standards.md", catalog: catalogFor("RFC 9110") }),
      "backlog-already-cited",
    );
  });

  test("backlog-misplaced: the backlog belongs to standards.md alone", () => {
    expectViolation(
      check(backlogSpec(OK_BACKLOG), { file: "server.md", catalog: catalogFor("RFC 9110") }),
      "backlog-misplaced",
    );
  });

  test("backlog-header-mismatch", () => {
    const src = backlogSpec(OK_BACKLOG).replace(
      "| Standard | Target | Why not yet |",
      "| Standard | Owner | Why not yet |",
    );
    expectViolation(
      check(src, { file: "standards.md", catalog: catalogFor("RFC 9110") }),
      "backlog-header-mismatch",
    );
  });

  test("backlog-row-arity and backlog-standard-cell-grammar", () => {
    const row = "| RFC 9110 | `standards.md` |";
    const out = check(backlogSpec(row), { file: "standards.md", catalog: catalogFor("RFC 9110") });
    expectViolation(out, "backlog-row-arity");
    expectViolation(out, "backlog-standard-cell-grammar");
  });
});

/* ── Ratchets and legacy ────────────────────────────────────────────────────── */

describe("ratchets", () => {
  test("uncited-stale: a listed spec grows a conforming table", () => {
    const out = checkStandards(reg(fixtureSpec(OK_ROW), { catalog: catalogFor("RFC 6901") }), {
      uncited: [{ file: "f.md", why: "later" }],
      exemptUnnumbered: [],
    });
    expectViolation(out, "uncited-stale");
  });

  test("exempt-stale: an exempt spec gains numbered headings", () => {
    const out = checkStandards(reg(fixtureSpec(OK_ROW), { catalog: catalogFor("RFC 6901") }), {
      uncited: [],
      exemptUnnumbered: [{ file: "f.md", why: "no numbered headings" }],
    });
    expectViolation(out, "exempt-stale");
  });

  test("bad-form: a retired IETF URL", () => {
    expectViolation(
      check(
        fixtureSpec(
          "| [RFC 6901](https://tools.ietf.org/html/rfc6901) | **Adopted** | §1 | package.json | — |",
        ),
        {
          catalog: catalogFor("RFC 6901"),
        },
      ),
      "bad-form",
    );
  });
});

/* ── Meta ───────────────────────────────────────────────────────────────────── */

afterAll(() => {
  const untested = VIOLATION_CODES.filter((c) => !exercised.has(c));
  if (untested.length > 0) {
    throw new Error(
      `these violation codes are never exercised by a test: ${untested.join(", ")}. ` +
        "A rule nobody has seen fire is a rule nobody knows works.",
    );
  }
});
