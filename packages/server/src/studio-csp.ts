/**
 * The Studio shell's report-only Trusted Types policy — the observation stage of `spec.md` §21.5.
 *
 * §21.5 stages Trusted Types in two halves and refuses to skip the first: ship the policy, observe
 * under `Content-Security-Policy-Report-Only`, then enforce. This module is that middle step, and
 * it is deliberately the smallest thing that can answer the question.
 *
 * **Report-only must be a response header.** A `<meta http-equiv>` policy with report-only
 * disposition is ignored outright (CSP3 §3.3) — verified in Chrome 151: an identical directive
 * delivered by meta produced zero violations and let a disallowed policy name be created, while the
 * enforcing meta produced five. That is why this lives in the servers and not in `index.html`.
 *
 * **One directive, no allow-list.** `require-trusted-types-for 'script'` alone reports every DOM
 * injection sink _and_ every `eval`/`new Function` — the second half is easy to get backwards, and
 * §21.5 exists because getting it backwards produces a plan that cannot be executed. Adding
 * `trusted-types <names>` would suppress nothing useful and cost something real: the shell's bundle
 * creates a dozen policies (lit-html's and ten of Monaco's, all pass-throughs), so an allow-list
 * would have to name them, and allow-listing a pass-through `createHTML: (s) => s` admits exactly
 * the rubber stamp §21.5 rejects. Omitting the directive leaves policy creation unrestricted, which
 * is verified to produce no policy-creation reports at all — so the run observes sinks and nothing
 * else.
 *
 * **The canvas never receives this.** `require-trusted-types-for 'script'` gates `new Function`,
 * and the canvas _is_ those call sites (§21.3) — an interpreter that does not compile at runtime is
 * a compiler. The two profiles are permanent, and they only stay separable because the canvas is a
 * real http document with its own response: a child frame served over http does **not** inherit its
 * parent's policy, while a `srcdoc` frame does. Verified in Chrome 151 — under an enforcing parent,
 * the `srcdoc` child threw `EvalError` and the http child evaluated normally. Were the canvas ever
 * moved to `srcdoc`, `blob:` or `about:blank`, enforcing on the shell would kill the interpreter.
 *
 * @docs framework/concepts/security
 */

/**
 * The report-only directive the Studio shell is served with.
 *
 * No `report-uri`/`report-to`: nothing in this repository receives CSP reports, and a report-only
 * run does not need one. `SecurityPolicyViolationEvent` fires in the document for every violation
 * under report disposition (verified), so the shell observes its own violations and files them
 * through the Problem channel it already has.
 */
export const STUDIO_REPORT_ONLY_CSP = "require-trusted-types-for 'script'";

/** The header name. Report-only, never enforcing — enforcement is the stage after this one. */
export const CSP_REPORT_ONLY_HEADER = "Content-Security-Policy-Report-Only";

/**
 * Whether a Studio asset path is the shell document, and therefore the one thing that receives the
 * policy.
 *
 * The discrimination is the point of this function existing rather than the header being set on the
 * whole Studio branch. That branch also serves `canvas.html` — which needs `'unsafe-eval'`
 * permanently — and the three Monaco worker scripts, which are separate global scopes taking their
 * policy from their own responses. A blanket header would apply the shell's profile to both.
 *
 * @param {string} assetRel - Studio-relative path, e.g. `index.html` or `canvas.html`
 * @returns {boolean}
 */
export function isStudioShellDocument(assetRel: string): boolean {
  return assetRel === "" || assetRel === "index.html";
}

/**
 * Add the report-only header to a response for the shell document, or return it untouched.
 *
 * @param {Response} res
 * @param {string} assetRel
 * @returns {Response}
 */
export function withStudioReportOnlyCsp(res: Response, assetRel: string): Response {
  if (!isStudioShellDocument(assetRel)) {
    return res;
  }
  const headers = new Headers(res.headers);
  headers.set(CSP_REPORT_ONLY_HEADER, STUDIO_REPORT_ONLY_CSP);
  return new Response(res.body, { headers, status: res.status });
}
