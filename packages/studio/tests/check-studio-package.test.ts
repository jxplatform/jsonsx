/**
 * The packaging gate proves itself before it gates anything. The rules are pure functions over an
 * injected listing, driven here with fixtures; `tests/hosting-stage.test.ts` covers the individual
 * rules, and this file covers assembling and reporting them.
 */
import { describe, expect, test } from "bun:test";
import { analyze, report } from "../scripts/check-studio-package";

describe("report", () => {
  test("a clean tree says what it checked, not just that it passed", () => {
    const lines = report([]).join("\n");
    expect(lines).toContain("stylesheet(s) declared and present");
    expect(lines).toContain("no backend dependency");
  });

  /* Grouped by rule so a reader sees the categories, and each line names the rule that produced
     it — the header explains what each rule is for. */
  test("problems are listed by rule, with the pointer to what they mean", () => {
    const lines = report([
      { detail: "src/a.ts imports @jxsuite/server", rule: "layering" },
      { detail: "styles/x.css is not in STUDIO_STYLESHEETS", rule: "stylesheets" },
    ]).join("\n");
    expect(lines).toContain("[layering]");
    expect(lines).toContain("[stylesheets]");
    expect(lines).toContain("check-studio-package.ts");
  });
});

describe("analyze", () => {
  /* The real package. This is the assertion the CI job makes, and having it here means a
     violation is a red test as well as a red job. */
  test("the committed package keeps its own promises", () => {
    expect(analyze()).toEqual([]);
  });
});
