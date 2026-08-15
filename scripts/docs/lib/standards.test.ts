/**
 * Parser tests for the `## N. Standards Alignment` tables.
 *
 * Fixtures are inline strings, because the parser's job is to read markdown that does not exist in
 * the repo yet. The one exception is the determinism pair at the bottom, which runs against the
 * real `specs/` — a generated page that is diffed by CI must not depend on iteration order.
 */

import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import {
  buildRegistry,
  canonicalUrlProblem,
  compareIds,
  GAP_TIER_BY_STATUS,
  isConformance,
  orgOfId,
  parseStandardsSource,
  splitRow,
  tierOf,
} from "./standards.ts";
import { parseSpecSource, STATUS_VOCAB } from "./spec-status.ts";

const ROOT = resolve(import.meta.dir, "../../..");
const SPECS_DIR = resolve(ROOT, "specs");
const CATALOG = resolve(ROOT, "scripts/docs/standards.json");

const HEADER = "| Standard | Class | Binds | Evidence | Note |\n| --- | --- | --- | --- | --- |";

function spec(body: string): string {
  return `# Fixture Specification\n\n## 1. Overview\n\n> **Status: Partial.** …\n\n## 2. Later\n\n${body}\n\n## Changelog\n\n- **0.1.0-draft** (2026-01-01) — x.\n`;
}

describe("section discovery", () => {
  test("finds a numbered Standards Alignment section", () => {
    const r = parseStandardsSource(spec(`## 3. Standards Alignment\n\n${HEADER}`), "f.md");
    expect(r.section?.anchor).toBe("3");
    expect(r.section?.depth).toBe(2);
    expect(r.sectionCount).toBe(1);
  });

  test("finds it at subsection depth", () => {
    const r = parseStandardsSource(spec(`### 2.5 Standards Alignment\n\n${HEADER}`), "f.md");
    expect(r.section?.anchor).toBe("2.5");
    expect(r.section?.depth).toBe(3);
  });

  test("stops at the next heading of equal or shallower depth", () => {
    const src = spec(
      `## 3. Standards Alignment\n\n${HEADER}\n| [RFC 1](https://x/) | **Adopted** | §1 | a.ts | — |\n\n## 4. Other\n\n${HEADER}\n| [RFC 2](https://x/) | **Adopted** | §1 | a.ts | — |`,
    );
    const r = parseStandardsSource(src, "f.md");
    expect(r.rows.map((x) => x.id)).toEqual(["RFC 1"]);
  });

  test("stops at ## Changelog", () => {
    const r = parseStandardsSource(
      `## 3. Standards Alignment\n\n${HEADER}\n\n## Changelog\n\n| [RFC 9](https://x/) | **Adopted** | §1 | a.ts | — |\n`,
      "f.md",
    );
    expect(r.rows).toEqual([]);
  });

  /*
   * THE REGRESSION TEST FOR THE APPENDIX TRAP. An unnumbered heading is invisible to
   * check-doc-refs.ts and spec-status.ts alike, so it is not an anchor, it never reaches
   * implementation-status.md, and a `> **Status:**` under it is credited to the last NUMBERED
   * section above it. If this test is ever deleted, that whole class of silence comes back.
   */
  test("an unnumbered 'Standards Alignment' heading is recorded as the trap, not as the section", () => {
    const r = parseStandardsSource(
      spec(`## Appendix D — Standards Alignment\n\n${HEADER}`),
      "f.md",
    );
    expect(r.section).toBeUndefined();
    expect(r.unnumberedHeadingLine).toBeGreaterThan(0);
  });

  test("a plain unnumbered heading is caught too", () => {
    const r = parseStandardsSource(spec(`## Standards Alignment\n\n${HEADER}`), "f.md");
    expect(r.section).toBeUndefined();
    expect(r.unnumberedHeadingLine).toBeGreaterThan(0);
  });

  test("counts duplicates so the checker can report them", () => {
    const r = parseStandardsSource(
      spec(`## 3. Standards Alignment\n\n${HEADER}\n\n### 3.1 Standards Alignment\n\n${HEADER}`),
      "f.md",
    );
    expect(r.sectionCount).toBe(2);
  });
});

describe("fenced examples are not rows", () => {
  test("a table inside a fence produces no rows", () => {
    const src = spec(
      "## 3. Standards Alignment\n\n```markdown\n" +
        `${HEADER}\n| [RFC 1](https://x/) | **Adopted** | §1 | a.ts | — |\n` +
        "```\n\n" +
        `${HEADER}\n| [RFC 2](https://x/) | **Adopted** | §1 | a.ts | — |`,
    );
    const r = parseStandardsSource(src, "f.md");
    expect(r.rows.map((x) => x.id)).toEqual(["RFC 2"]);
  });
});

describe("cells", () => {
  test("oxfmt padding is trimmed away", () => {
    const src = spec(
      `## 3. Standards Alignment\n\n${HEADER}\n|  [RFC 6901](https://www.rfc-editor.org/rfc/rfc6901)   |  **Adopted**   |  §7.1   |  a.ts   |  —   |`,
    );
    const row = parseStandardsSource(src, "f.md").rows[0]!;
    expect(row.id).toBe("RFC 6901");
    expect(row.url).toBe("https://www.rfc-editor.org/rfc/rfc6901");
    expect(row.conformance).toBe("Adopted");
    expect(row.binds).toEqual(["§7.1"]);
    expect(row.evidence).toEqual(["a.ts"]);
    expect(row.note).toBe("");
  });

  test("multiple binds and multiple evidence paths split on comma", () => {
    const src = spec(
      `## 3. Standards Alignment\n\n${HEADER}\n| [RFC 1](https://x/) | **Subset** | §7, §19.4a | a.ts, b.ts | Partly. |`,
    );
    const row = parseStandardsSource(src, "f.md").rows[0]!;
    expect(row.binds).toEqual(["§7", "§19.4a"]);
    expect(row.evidence).toEqual(["a.ts", "b.ts"]);
    expect(row.note).toBe("Partly.");
  });

  test("the em-dash sentinel means empty", () => {
    const src = spec(
      `## 3. Standards Alignment\n\n${HEADER}\n| [RFC 1](https://x/) | **Pending** | §1 | — | \`gap:a-b\` Not built. |`,
    );
    const row = parseStandardsSource(src, "f.md").rows[0]!;
    expect(row.evidence).toEqual([]);
    expect(row.gapId).toBe("a-b");
    expect(row.gapText).toBe("Not built.");
  });

  test("a rejection note is extracted", () => {
    const src = spec(
      `## 3. Standards Alignment\n\n${HEADER}\n| [RFC 1](https://x/) | **Rejected** | §1 | — | because: the producer already escapes newlines. |`,
    );
    const row = parseStandardsSource(src, "f.md").rows[0]!;
    expect(row.rejection).toBe("the producer already escapes newlines.");
  });

  test("an off-vocabulary class leaves conformance undefined", () => {
    const src = spec(
      `## 3. Standards Alignment\n\n${HEADER}\n| [RFC 1](https://x/) | **Mostly** | §1 | a.ts | — |`,
    );
    const row = parseStandardsSource(src, "f.md").rows[0]!;
    expect(row.conformance).toBeUndefined();
    expect(row.rawClass).toBe("**Mostly**");
  });

  test("splitRow rejects a non-row and splits a row", () => {
    expect(splitRow("not a row")).toBeNull();
    expect(splitRow("| a | b |")).toEqual(["a", "b"]);
  });
});

describe("legacy forms", () => {
  /*
   * The two parsers must not disagree about the same line. `spec-status.ts` already rejects a bare
   * `Planned` table cell, with a message about an unrelated subsystem; if this table format ever
   * admitted one, an author would be told the wrong thing by the wrong checker.
   */
  test("a bare Planned cell is a bad form to BOTH parsers", () => {
    const src = spec(
      `## 3. Standards Alignment\n\n${HEADER}\n| [RFC 1](https://x/) | Planned | §1 | — | x |`,
    );
    expect(parseStandardsSource(src, "f.md").badForms.length).toBeGreaterThan(0);
    expect(parseSpecSource(src, "f.md").badForms.length).toBeGreaterThan(0);
  });

  test("a retired IETF URL names its replacement", () => {
    const src = spec(
      `## 3. Standards Alignment\n\n${HEADER}\n| [RFC 1](https://tools.ietf.org/html/rfc1) | **Adopted** | §1 | a.ts | — |`,
    );
    const bad = parseStandardsSource(src, "f.md").badForms;
    expect(bad[0]?.reason).toContain("rfc-editor.org");
  });

  test("a dated W3C snapshot is rejected", () => {
    const src = spec(
      `## 3. Standards Alignment\n\n${HEADER}\n| [CSP3](https://www.w3.org/TR/2021/WD-CSP3/) | **Adopted** | §1 | a.ts | — |`,
    );
    expect(parseStandardsSource(src, "f.md").badForms.length).toBeGreaterThan(0);
  });
});

describe("status marker and stray content", () => {
  test("a status marker on the section is recorded", () => {
    const r = parseStandardsSource(
      spec(`## 3. Standards Alignment\n\n> **Status: Pending.** …\n\n${HEADER}`),
      "f.md",
    );
    expect(r.hasSectionStatusMarker).toBe(true);
  });

  test("prose before the table is fine; prose after it is stray", () => {
    const before = parseStandardsSource(
      spec(`## 3. Standards Alignment\n\nA sentence.\n\n${HEADER}`),
      "f.md",
    );
    expect(before.strayLines).toEqual([]);
    const after = parseStandardsSource(
      spec(`## 3. Standards Alignment\n\n${HEADER}\n\nA trailing sentence.`),
      "f.md",
    );
    expect(after.strayLines.length).toBe(1);
  });
});

describe("pure helpers", () => {
  test("orgOfId infers the issuing body from the identifier", () => {
    expect(orgOfId("RFC 9110")).toBe("IETF");
    expect(orgOfId("BCP 47")).toBe("IETF");
    expect(orgOfId("STD 90")).toBe("IETF");
    expect(orgOfId("UAX #15")).toBe("Unicode");
    expect(orgOfId("UTS #46")).toBe("Unicode");
    expect(orgOfId("ECMA-402")).toBe("Ecma");
    expect(orgOfId("ISO/IEC 8859-1")).toBe("ISO");
    expect(orgOfId("WebAuthn Level 3")).toBeNull();
  });

  test("canonicalUrlProblem accepts the canonical form and rejects the rest", () => {
    expect(canonicalUrlProblem("IETF", "https://www.rfc-editor.org/rfc/rfc9110")).toBeNull();
    expect(canonicalUrlProblem("IETF", "https://www.rfc-editor.org/info/bcp47")).toBeNull();
    expect(
      canonicalUrlProblem("IETF", "https://datatracker.ietf.org/doc/html/rfc9110"),
    ).not.toBeNull();
    expect(canonicalUrlProblem("W3C", "https://www.w3.org/TR/wcag22/")).toBeNull();
    expect(
      canonicalUrlProblem("W3C", "https://www.w3.org/TR/2023/REC-wcag22-20231005/"),
    ).not.toBeNull();
    expect(canonicalUrlProblem("Unicode", "https://www.unicode.org/reports/tr15/")).toBeNull();
    expect(canonicalUrlProblem("WHATWG", "https://dom.spec.whatwg.org/")).toBeNull();
    expect(canonicalUrlProblem("Other", "https://anything/")).toBeNull();
  });

  test("tierOf maps only the unbuilt statuses", () => {
    expect(tierOf("Partial")).toBe("Near");
    expect(tierOf("Pending")).toBe("Next");
    expect(tierOf("Future")).toBe("Later");
    expect(tierOf("Implemented")).toBeNull();
    expect(tierOf("Removed")).toBeNull();
    expect(tierOf(([] as (typeof STATUS_VOCAB)[number][])[0])).toBeNull();
  });

  /*
   * The tier table is keyed by the status vocabulary. If a status is ever renamed, this reds here
   * rather than silently dropping a tier from the generated gap list.
   */
  test("every tier key is in the status vocabulary", () => {
    for (const key of Object.keys(GAP_TIER_BY_STATUS)) {
      expect(STATUS_VOCAB as readonly string[]).toContain(key);
    }
  });

  test("isConformance knows the vocabulary", () => {
    expect(isConformance("Adopted")).toBe(true);
    expect(isConformance("Planned")).toBe(false);
  });

  test("compareIds is codepoint order, not locale order", () => {
    expect(compareIds("RFC 2", "RFC 10")).toBeGreaterThan(0);
    expect(compareIds("BCP 14", "RFC 3986")).toBeLessThan(0);
  });
});

describe("determinism against the real specs", () => {
  test("buildRegistry returns identical data twice", () => {
    const a = buildRegistry(SPECS_DIR, CATALOG);
    const b = buildRegistry(SPECS_DIR, CATALOG);
    expect(a.rows).toEqual(b.rows);
    expect(a.specs.map((s) => s.file)).toEqual(b.specs.map((s) => s.file));
    expect(a.catalogOrder).toEqual(b.catalogOrder);
  });

  test("specs are sorted by filename", () => {
    const reg = buildRegistry(SPECS_DIR, CATALOG);
    expect(reg.specs.map((s) => s.file)).toEqual(reg.specs.map((s) => s.file).toSorted());
  });
});
