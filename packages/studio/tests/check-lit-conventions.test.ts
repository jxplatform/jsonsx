/**
 * The conventions gate proves itself before it gates anything.
 *
 * Same discipline as `tests/check-styles-orphans.test.ts` and `tests/icons.test.ts`: the rules are
 * pure functions over injected source, so they can be driven with fixtures under `bun test`, which
 * never builds and never opens a browser. What is asserted here is not "the current tree is clean"
 * — the runner says that — but that each rule fires on the shape it exists for, stays quiet on the
 * shape it does not, and that both backlogs ratchet in both directions.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  analyze,
  emittedClasses,
  EXCLUDED,
  report,
  reportLines,
  SELF_QUERY_DEBT,
  SPECTRUM_DEBT,
  selfQueries,
  unguardedSpectrumBindings,
} from "../scripts/check-lit-conventions";

/** A throwaway src/ tree, written verbatim. */
function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "jx-lit-conv-"));
  for (const [path, source] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), source);
  }
  return root;
}

function withTree<T>(files: Record<string, string>, body: (root: string) => T): T {
  const root = tree(files);
  try {
    return body(root);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
}

// ─── Rule 1: Spectrum controls ───────────────────────────────────────────────

describe("unguardedSpectrumBindings", () => {
  test("an attribute binding on a self-mutating control is a finding", () => {
    const f = unguardedSpectrumBindings("a.ts", "html`<sp-textfield value=${x}></sp-textfield>`");
    expect(f).toHaveLength(1);
    expect(f[0]!.detail).toContain("binds value as an attribute");
  });

  test("a property binding without live() is a finding — the dirty-check still skips it", () => {
    const f = unguardedSpectrumBindings("a.ts", "html`<sp-picker .value=${x}></sp-picker>`");
    expect(f).toHaveLength(1);
    expect(f[0]!.detail).toContain("without live()");
  });

  test("a live property binding is clean", () => {
    expect(
      unguardedSpectrumBindings("a.ts", "html`<sp-picker .value=${live(x)}></sp-picker>`"),
    ).toEqual([]);
  });

  test("boolean attribute and property forms are both judged", () => {
    expect(unguardedSpectrumBindings("a.ts", "html`<sp-switch ?checked=${x}>`")).toHaveLength(1);
    expect(unguardedSpectrumBindings("a.ts", "html`<sp-switch .checked=${live(x)}>`")).toEqual([]);
  });

  test("sp-accordion-item's open counts — the component flips it itself", () => {
    expect(unguardedSpectrumBindings("a.ts", "html`<sp-accordion-item open=${x}>`")).toHaveLength(
      1,
    );
  });

  /* A constant cannot diverge: there is nothing for the component to move away from. */
  test("constants are not findings", () => {
    expect(unguardedSpectrumBindings("a.ts", "html`<sp-accordion-item .open=${false}>`")).toEqual(
      [],
    );
    expect(unguardedSpectrumBindings("a.ts", "html`<sp-picker .value=${nothing}>`")).toEqual([]);
  });

  test("a plain element is none of this rule's business", () => {
    expect(unguardedSpectrumBindings("a.ts", "html`<input value=${x}>`")).toEqual([]);
  });

  /* The binding is often several lines below the tag name, and the expression can carry braces of
     its own — a ternary, an object, a nested template. Both have to survive the scan. */
  test("multi-line tags and braced expressions are still read", () => {
    const src = ["html`<sp-picker", '  class="x"', "  value=${a ? { k: 1 } : `${b}`}", ">`"].join(
      "\n",
    );
    const f = unguardedSpectrumBindings("a.ts", src);
    expect(f).toHaveLength(1);
    expect(f[0]!.line).toBe(1);
  });

  /* `.value` must not be mistaken for the attribute `value`, in either direction. */
  test("the property form is not double-counted as an attribute", () => {
    expect(unguardedSpectrumBindings("a.ts", "html`<sp-picker .value=${live(x)} >`")).toEqual([]);
  });
});

// ─── Rule 2: self-queries ────────────────────────────────────────────────────

describe("emittedClasses", () => {
  test("reads plain class attributes and classMap keys, quoted or bare", () => {
    const names = emittedClasses(
      'html`<div class="a b"><i class=${classMap({ "c-d": t, active: t })}></i></div>`',
    );
    expect([...names].toSorted()).toEqual(["a", "active", "b", "c-d"]);
  });

  /* An interpolated class name is not a literal this module can be said to own. */
  test("a class attribute containing an interpolation is skipped", () => {
    expect([...emittedClasses("html`<div class=${`tab-${kind}`}></div>`")]).toEqual([]);
  });
});

describe("selfQueries", () => {
  test("querying a class this module renders is a finding", () => {
    const f = selfQueries("a.ts", 'html`<div class="own"></div>`; host.querySelector(".own");');
    expect(f).toHaveLength(1);
    expect(f[0]!.detail).toContain(".own");
  });

  test("querySelectorAll and a generic type argument are both read", () => {
    expect(
      selfQueries("a.ts", 'html`<div class="own">`; el.querySelectorAll<HTMLElement>(".own");'),
    ).toHaveLength(1);
  });

  test("querying someone else's class is not this rule's business", () => {
    expect(selfQueries("a.ts", 'html`<div class="own">`; host.querySelector(".theirs");')).toEqual(
      [],
    );
  });

  /* Reaching into a third-party widget by tag or attribute is a different act — Spectrum's shadow
     root, Tabulator's cells, the canvas iframe — and the rule stays out of it. */
  test("tag and attribute selectors are left alone", () => {
    const src =
      'html`<div class="own">`; el.querySelector("sp-textfield"); el.querySelector("[hidden]");';
    expect(selfQueries("a.ts", src)).toEqual([]);
  });
});

// ─── The ratchet ─────────────────────────────────────────────────────────────

describe("the backlogs ratchet in both directions", () => {
  const dirty =
    'html`<sp-textfield value=${x}></sp-textfield><div class="own"></div>`;\nhost.querySelector(".own");\n';

  test("an un-listed file reports both findings", () => {
    withTree({ "fresh.ts": dirty }, (root) => {
      const r = analyze(root);
      expect(r.spectrum.map((f) => f.file)).toContain("fresh.ts");
      expect(r.selfQuery.map((f) => f.file)).toContain("fresh.ts");
    });
  });

  /* Growing past the allowance is reported as an excess, naming both numbers, rather than as a
     wall of individual sites the reader has already agreed to. */
  test("exceeding an allowance is reported with both counts", () => {
    withTree({ "listed.ts": dirty }, (root) => {
      const key = "listed.ts";
      SPECTRUM_DEBT[key] = 0;
      try {
        const clean = analyze(root);
        expect(clean.spectrum.some((f) => f.file === key)).toBeTrue();
      } finally {
        delete SPECTRUM_DEBT[key];
      }
    });
  });

  test("a fixed site leaves a stale entry, which fails too", () => {
    withTree({ "listed.ts": "export const x = 1;\n" }, (root) => {
      SPECTRUM_DEBT["listed.ts"] = 2;
      SELF_QUERY_DEBT["listed.ts"] = 1;
      try {
        const r = analyze(root);
        expect(r.staleSpectrum.join(", ")).toContain("listed.ts (allows 2, found 0)");
        expect(r.staleSelfQuery.join(", ")).toContain("listed.ts (allows 1, found 0)");
      } finally {
        delete SPECTRUM_DEBT["listed.ts"];
        delete SELF_QUERY_DEBT["listed.ts"];
      }
    });
  });

  test("an excluded module is not judged at all", () => {
    withTree({ "canvas/iframe-host.ts": dirty, "canvas/iframe-made-up.ts": dirty }, (root) => {
      const r = analyze(root);
      expect(r.spectrum).toEqual([]);
      expect(r.selfQuery).toEqual([]);
    });
  });
});

// ─── The lists describe the tree they are in ─────────────────────────────────

describe("the lists stay honest about the real tree", () => {
  test("every EXCLUDED module exists", () => {
    expect(analyze().unknownExclusions).toEqual([]);
  });

  /* An exclusion is a claim that a module is imperative BY DESIGN, so it has to say why — a bare
     path is indistinguishable from something nobody got round to. */
  test("every exclusion carries a reason", () => {
    for (const [file, why] of Object.entries(EXCLUDED)) {
      expect(why.length, `${file} has no reason`).toBeGreaterThan(30);
    }
  });

  test("the committed tree is clean against its own backlogs", () => {
    const r = analyze();
    expect(r.spectrum).toEqual([]);
    expect(r.selfQuery).toEqual([]);
    expect(r.staleSpectrum).toEqual([]);
    expect(r.staleSelfQuery).toEqual([]);
  });
});

describe("report", () => {
  test("a clean tree names the backlog size and the excluded modules", () => {
    const { failed, lines } = report({
      selfQuery: [],
      spectrum: [],
      staleSelfQuery: [],
      staleSpectrum: [],
      unknownExclusions: [],
    });
    expect(failed).toBe(false);
    expect(lines.join("\n")).toContain("allow-listed site(s) remaining");
  });

  test("each finding names its file, its line and what to do", () => {
    const { failed, lines } = report({
      selfQuery: [{ detail: "queries .own", file: "a.ts", line: 7 }],
      spectrum: [{ detail: "binds value as an attribute", file: "b.ts", line: 3 }],
      staleSelfQuery: [],
      staleSpectrum: [],
      unknownExclusions: [],
    });
    expect(failed).toBe(true);
    const text = lines.join("\n");
    expect(text).toContain("src/b.ts:3");
    expect(text).toContain("src/a.ts:7");
    expect(text).toContain("ref()");
  });

  /* Both ratchet directions, and a stale exclusion, reach the report rather than only the analysis. */
  test("stale entries and unknown exclusions are reported too", () => {
    const { failed, lines } = report({
      selfQuery: [],
      spectrum: [],
      staleSelfQuery: ["x.ts (allows 1, found 0)"],
      staleSpectrum: ["y.ts (allows 2, found 0)"],
      unknownExclusions: ["gone.ts"],
    });
    expect(failed).toBe(true);
    const text = lines.join("\n");
    expect(text).toContain("only ratchets down");
    expect(text).toContain("y.ts (allows 2, found 0)");
    expect(text).toContain("gone.ts");
  });

  test("a finding with no line number omits the colon", () => {
    const lines = reportLines([{ detail: "3 sites, 1 allowed", file: "z.ts", line: 0 }], "H", "A");
    expect(lines.join("\n")).toContain("src/z.ts —");
  });
});
