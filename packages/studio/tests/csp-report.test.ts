import "./harness";
import { beforeEach, describe, expect, test } from "bun:test";
import {
  CSP_PROBLEM_SOURCE,
  observeCspViolations,
  reportCspViolation,
} from "../src/services/csp-report";
import { clearProblems, problems } from "../src/services/notify";
import type { Notification } from "../src/services/notify";

/*
 * This module is instrumentation for spec.md §21.5's observation stage, so the tests are about what
 * it must NOT do as much as what it does: a run that floods the Problems list, or that files a
 * blocked violation as though it were an observed one, tells the reader nothing.
 */

/** A SecurityPolicyViolationEvent is not constructible in happy-dom; the fields are what matter. */
const violation = (over: Partial<SecurityPolicyViolationEvent> = {}) =>
  ({
    columnNumber: 7,
    disposition: "report",
    effectiveDirective: "require-trusted-types-for",
    lineNumber: 42,
    sample: "Function|(\n) {\nreturn 40 + 2\n})",
    sourceFile: "http://localhost:3000/packages/studio/dist/studio.js",
    violatedDirective: "require-trusted-types-for",
    ...over,
  }) as SecurityPolicyViolationEvent;

const rows = (): Notification[] => problems.filter((n) => n.source === CSP_PROBLEM_SOURCE);

beforeEach(() => {
  clearProblems((record) => record.source === CSP_PROBLEM_SOURCE);
});

describe("reportCspViolation", () => {
  test("files a Problem naming the sink the sample identifies", () => {
    reportCspViolation(violation());
    expect(rows()).toHaveLength(1);
    expect(rows()[0]!.message).toContain("Function");
    expect(rows()[0]!.tier).toBe("problem");
  });

  /*
   * `warn`, not `error`. Under report-only nothing is broken, and §16 picks a tier by what the
   * outcome asks of the reader — a decision before enforcement, not a fix now. Filing these as
   * errors would put a red count in the status bar for a policy that is not enforcing.
   */
  test("is a warning, because report-only breaks nothing", () => {
    reportCspViolation(violation());
    expect(rows()[0]!.severity).toBe("warn");
  });

  test("carries the directive, the sample and the source position", () => {
    reportCspViolation(violation());
    const { detail } = rows()[0]!;
    expect(detail).toContain("require-trusted-types-for");
    expect(detail).toContain("return 40 + 2");
    expect(detail).toContain("studio.js:42:7");
  });

  /*
   * The sample is a fragment of the offending script or markup, so it carries author content and a
   * whole function body. Truncation is what keeps a Problems row readable and stops a violating
   * `innerHTML` write pasting a document into the panel.
   */
  test("truncates a long sample", () => {
    reportCspViolation(violation({ sample: `eval|${"x".repeat(500)}` }));
    expect(rows()[0]!.detail!.length).toBeLessThan(500);
  });

  /*
   * The dedup rule that decides whether a run is readable. A loop evaluating a hundred templates
   * from one call site is ONE finding; keying on the sample would file it a hundred times and bury
   * every other violation under it.
   */
  test("one row per call site, however many times it fires", () => {
    for (let i = 0; i < 50; i++) {
      reportCspViolation(violation({ sample: `Function|(){return ${i}}` }));
    }
    expect(rows()).toHaveLength(1);
  });

  test("a different call site is a different row", () => {
    reportCspViolation(violation());
    reportCspViolation(violation({ lineNumber: 99 }));
    expect(rows()).toHaveLength(2);
  });

  /*
   * An enforced violation is a different event with a different meaning: the thing is already
   * broken on screen, and a Problem row is not the response. This module observes; it does not
   * become the shell's security console when someone flips the header.
   */
  test("ignores an enforced violation", () => {
    reportCspViolation(violation({ disposition: "enforce" }));
    expect(rows()).toHaveLength(0);
  });

  test("survives a report with no sample or source", () => {
    reportCspViolation(violation({ sample: "", sourceFile: "" }));
    expect(rows()).toHaveLength(1);
    expect(rows()[0]!.message).toContain("require-trusted-types-for");
  });
});

describe("observeCspViolations", () => {
  test("files a Problem for an event dispatched on the document", () => {
    const stop = observeCspViolations();
    const event = new Event("securitypolicyviolation");
    Object.assign(event, violation());
    document.dispatchEvent(event);
    expect(rows()).toHaveLength(1);
    stop();
  });

  // Idempotent: a second call must not double-file every violation.
  test("registers once", () => {
    const stop = observeCspViolations();
    const second = observeCspViolations();
    const event = new Event("securitypolicyviolation");
    Object.assign(event, violation());
    document.dispatchEvent(event);
    expect(rows()).toHaveLength(1);
    second();
    stop();
  });

  test("stops when told to", () => {
    const stop = observeCspViolations();
    stop();
    const event = new Event("securitypolicyviolation");
    Object.assign(event, violation());
    document.dispatchEvent(event);
    expect(rows()).toHaveLength(0);
  });
});
