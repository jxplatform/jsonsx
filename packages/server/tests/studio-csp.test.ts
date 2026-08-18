import { describe, expect, test } from "bun:test";
import {
  CSP_REPORT_ONLY_HEADER,
  isStudioShellDocument,
  STUDIO_REPORT_ONLY_CSP,
  withStudioReportOnlyCsp,
} from "../src/studio-csp.ts";

/*
 * The whole value of this module is a discrimination, so most of these tests assert what does NOT
 * get the header. spec.md §21.5 keeps two permanent CSP profiles: the shell may one day enforce
 * Trusted Types, and the canvas never can, because `require-trusted-types-for 'script'` gates
 * `new Function` and the interpreter IS those call sites. Both documents are served by the same
 * branch, so a header set one line too high is how the two profiles silently become one.
 */

describe("the directive itself", () => {
  /*
   * One token, deliberately. A `trusted-types <names>` allow-list would have to name the dozen
   * policies the bundle creates (lit-html's and ten of Monaco's) and allow-listing a pass-through
   * `createHTML: (s) => s` is the rubber stamp §21.5 rejects. Verified in Chrome 151: with this
   * directive alone, sinks and eval report and policy creation produces no violations at all.
   */
  test("is require-trusted-types-for alone, with no allow-list", () => {
    expect(STUDIO_REPORT_ONLY_CSP).toBe("require-trusted-types-for 'script'");
    expect(STUDIO_REPORT_ONLY_CSP).not.toContain("trusted-types ");
  });

  /*
   * A report-uri/report-to would need a collector this repository does not have. The shell observes
   * its own SecurityPolicyViolationEvents instead — see studio/src/services/csp-report.ts.
   */
  test("names no reporting endpoint", () => {
    expect(STUDIO_REPORT_ONLY_CSP).not.toContain("report-uri");
    expect(STUDIO_REPORT_ONLY_CSP).not.toContain("report-to");
  });

  /*
   * The header name carries the entire staging decision. Sending the enforcing header instead would
   * skip the observation stage §21.5 exists to mandate — and would break the shell, which is now
   * known to evaluate strings (the interpreter runs there for Library preview and render-check).
   */
  test("is the report-only header, never the enforcing one", () => {
    expect(CSP_REPORT_ONLY_HEADER).toBe("Content-Security-Policy-Report-Only");
  });
});

describe("isStudioShellDocument", () => {
  test("the shell document, by either spelling", () => {
    expect(isStudioShellDocument("index.html")).toBe(true);
    expect(isStudioShellDocument("")).toBe(true);
  });

  /*
   * The canvas is the reason this function exists. It evaluates `${}` templates and `body`
   * functions as it reads them (§21.3) and needs `'unsafe-eval'` permanently.
   */
  test("never the canvas", () => {
    expect(isStudioShellDocument("canvas.html")).toBe(false);
  });

  /*
   * A worker is its own global scope and takes its policy from its own response, so the shell's
   * header would neither reach it nor describe it. Three of them ship with Monaco.
   */
  test("never a worker or a bundle", () => {
    for (const rel of [
      "dist/workers/editor.worker.js",
      "dist/workers/json.worker.js",
      "dist/workers/ts.worker.js",
      "dist/studio.js",
      "dist/iframe-entry.js",
    ]) {
      expect(isStudioShellDocument(rel)).toBe(false);
    }
  });

  // Nothing clever about prefixes: `index.html.map` is not the shell.
  test("matches exactly, not by prefix", () => {
    expect(isStudioShellDocument("index.html.map")).toBe(false);
    expect(isStudioShellDocument("sub/index.html")).toBe(false);
  });
});

describe("withStudioReportOnlyCsp", () => {
  const res = () => new Response("<!doctype html>", { headers: { "X-Kept": "yes" } });

  test("adds the header to the shell and keeps the existing ones", async () => {
    const out = withStudioReportOnlyCsp(res(), "index.html");
    expect(out.headers.get(CSP_REPORT_ONLY_HEADER)).toBe(STUDIO_REPORT_ONLY_CSP);
    expect(out.headers.get("X-Kept")).toBe("yes");
    expect(await out.text()).toBe("<!doctype html>");
  });

  test("returns the canvas response untouched", () => {
    const out = withStudioReportOnlyCsp(res(), "canvas.html");
    expect(out.headers.get(CSP_REPORT_ONLY_HEADER)).toBeNull();
  });

  // A 404 is still a response; the status must survive the header rewrite.
  test("preserves the status", () => {
    const notFound = new Response("nope", { status: 404 });
    expect(withStudioReportOnlyCsp(notFound, "index.html").status).toBe(404);
  });

  /*
   * The one thing that must never appear: the enforcing header. Enforcement is a later stage and a
   * separate decision, and shipping it here would break the shell rather than observe it.
   */
  test("never emits the enforcing header", () => {
    const out = withStudioReportOnlyCsp(res(), "index.html");
    expect(out.headers.get("Content-Security-Policy")).toBeNull();
  });
});
