/**
 * The observing half of the Trusted Types run — `spec.md` §21.5's middle stage, seen from the page.
 *
 * The servers send the shell `Content-Security-Policy-Report-Only: require-trusted-types-for
 * 'script'` (`@jxsuite/server`'s `studio-csp.ts`). Under report disposition nothing is blocked, so
 * the only evidence a run produces is `SecurityPolicyViolationEvent`, which fires in the document
 * for every violation. This listener turns those into Problems.
 *
 * **Why in the page rather than at an endpoint.** `report-to` would need a collector, a route and a
 * storage decision, and would deliver reports to a terminal nobody is reading. The author who can
 * act on "the Library preview evaluates a string" is the one running Studio, and §16's Problems
 * panel is already the surface for "something must be fixed" — with grouping by `source`, dedup by
 * `key`, and an announcement for free. Reusing it costs one listener.
 *
 * **This is instrumentation, and it is temporary by design.** It exists to answer one question:
 * what does the shell actually do that enforcement would break? When §21.5's enforcement stage
 * lands, the violations are either fixed or accepted, and this module goes with the report-only
 * header that feeds it. It must not grow into a general security console.
 *
 * @docs framework/concepts/security
 */

import { notify } from "./notify";

/** Groups these rows in the Problems list, and is what a later run clears by. */
export const CSP_PROBLEM_SOURCE = "Trusted Types";

/**
 * A sample is a fragment of the offending script or markup. It is the most useful field in the
 * report and the most dangerous to render whole — a violating `innerHTML` write carries author
 * content, and a violating `eval` carries a whole function body.
 */
const SAMPLE_LIMIT = 120;

/**
 * One row per (directive, sink, source position). The sample is deliberately NOT in the key: a loop
 * evaluating a hundred different templates from one call site is one finding, and keying on the
 * sample would file it a hundred times and bury everything else.
 */
function keyFor(event: SecurityPolicyViolationEvent): string {
  const where =
    event.sourceFile === "" || event.sourceFile === undefined
      ? "unknown"
      : `${event.sourceFile}:${event.lineNumber}`;
  return `csp.${event.effectiveDirective || event.violatedDirective}.${where}`;
}

/**
 * What the violation was, in the words of the thing that has to change.
 *
 * The sample's own prefix names the sink — Chromium sends `Function|…`, `eval|…`, `Element
 * innerHTML|…` — which is more precise than anything this module could infer, so it is used when
 * present rather than re-derived.
 */
function describe(event: SecurityPolicyViolationEvent): string {
  const [sink] = (event.sample ?? "").split("|");
  if (sink !== undefined && sink !== "") {
    return `${sink} would be blocked under Trusted Types enforcement`;
  }
  return `${event.effectiveDirective || event.violatedDirective} would block this under enforcement`;
}

/**
 * File one violation as a Problem.
 *
 * `warn`, not `error`: under report-only nothing is broken right now. Calling it an error would put
 * a red count in the status bar for a policy that is not enforcing, and §16's tiers are chosen by
 * what the outcome requires of the reader — here, a decision before enforcement, not a fix now.
 *
 * @param {SecurityPolicyViolationEvent} event
 */
export function reportCspViolation(event: SecurityPolicyViolationEvent): void {
  /*
   * Enforced violations are somebody else's story. This module is instrumentation for the
   * report-only run; if a policy is ever enforced on the shell, a Problem row is not the right
   * response to it — the thing is already broken on screen.
   */
  if (event.disposition !== "report") {
    return;
  }
  const where =
    event.sourceFile === "" || event.sourceFile === undefined
      ? ""
      : `\nAt ${event.sourceFile}:${event.lineNumber}:${event.columnNumber}`;
  const sample = (event.sample ?? "").slice(0, SAMPLE_LIMIT);
  notify.warn(describe(event), {
    detail:
      `Directive: ${event.effectiveDirective || event.violatedDirective}` +
      `${sample === "" ? "" : `\nSample: ${sample}`}${where}` +
      "\n\nReported, not blocked — spec.md §21.5's observation stage. Nothing is broken; this is " +
      "what enforcement would stop.",
    key: keyFor(event),
    source: CSP_PROBLEM_SOURCE,
    tier: "problem",
  });
}

let listening = false;

/**
 * Start observing. Idempotent, and a no-op outside a document.
 *
 * Registered unconditionally rather than behind a check for the header: a document with no
 * report-only policy simply never fires the event, and probing for the header from script is not
 * possible anyway. The cost of being wrong in this direction is one unused listener.
 *
 * @returns {() => void} Stop observing — for tests, and for a shell that tears itself down.
 */
export function observeCspViolations(): () => void {
  if (listening || typeof document === "undefined") {
    return () => {};
  }
  listening = true;
  const handler = (event: Event) => {
    reportCspViolation(event as SecurityPolicyViolationEvent);
  };
  document.addEventListener("securitypolicyviolation", handler);
  return () => {
    document.removeEventListener("securitypolicyviolation", handler);
    listening = false;
  };
}
