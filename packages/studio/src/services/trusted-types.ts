/**
 * The one place a string becomes markup in the Studio shell — Trusted Types (W3C).
 *
 * **What the standard actually gates, verified rather than assumed.** The tempting reading is that
 * `require-trusted-types-for 'script'` governs DOM injection sinks and leaves `eval` to
 * `script-src`. That is wrong: under Trusted Types, `eval()` and `new Function()` are gated too,
 * and throw when no default policy exists. Getting that backwards produces a plan that cannot be
 * executed — which is why the shell does **not** enforce Trusted Types yet, and why this module
 * ships the policy first (see `spec.md` §21.5).
 *
 * **This policy refuses to be a rubber stamp.** A `createHTML` that returns its input unchanged
 * satisfies the API and defends nothing; it converts a real control into a type-level ceremony. So
 * `createHTML` asserts, and throws on anything that looks like an injection — the value is meant to
 * have come from `markdownToHtml`, which already drops raw HTML and `javascript:` URLs, and this is
 * the check that says so out loud rather than trusting a call site to have remembered.
 *
 * **`createScript` and `createScriptURL` throw.** Nothing in the shell builds either from a string.
 * The canvas interpreter does evaluate expressions, but it runs in the canvas iframe under its own
 * policy — a permissive `createScript` here would re-permit evaluation for the whole shell to buy
 * something the shell does not use.
 *
 * @docs studio/interface/problems-and-progress
 */

/** The subset of the Trusted Types API this module uses — typed here so no DOM lib is required. */
interface TrustedTypesApi {
  createPolicy: (
    name: string,
    rules: {
      createHTML?: (input: string) => string;
      createScript?: (input: string) => string;
      createScriptURL?: (input: string) => string;
    },
  ) => { createHTML: (input: string) => unknown };
}

/** The policy name, which a CSP `trusted-types` directive would have to allow. */
export const STUDIO_POLICY_NAME = "jx-studio";

/**
 * Patterns that must never survive sanitization.
 *
 * Deliberately a small, explicit list rather than a parser: this is an **assertion** over output
 * that is already sanitized, not a sanitizer of its own. A second sanitizer here would be a second
 * thing to keep correct, and the failure mode of a wrong one is a false sense of safety.
 */
const FORBIDDEN: readonly { pattern: RegExp; what: string }[] = [
  { pattern: /<\s*script\b/i, what: "a <script> element" },
  { pattern: /<\s*iframe\b/i, what: "an <iframe> element" },
  { pattern: /<\s*object\b/i, what: "an <object> element" },
  { pattern: /<\s*embed\b/i, what: "an <embed> element" },
  { pattern: /\son[a-z]+\s*=/i, what: "an inline event handler attribute" },
  { pattern: /javascript:/i, what: "a javascript: URL" },
  { pattern: /data:text\/html/i, what: "a data: URL carrying HTML" },
];

/**
 * Assert that a string is markup this app is willing to inject.
 *
 * @param {string} value
 * @returns {string} The same string, when it passes.
 * @throws {Error} Naming what it found, so the failure is diagnosable rather than a blank refusal.
 */
export function assertSanitized(value: string): string {
  for (const { pattern, what } of FORBIDDEN) {
    if (pattern.test(value)) {
      throw new Error(
        `Refusing to inject markup containing ${what}. This value should have come from ` +
          "markdownToHtml, which removes it — a value that reaches here with it still present " +
          "means the sanitizer was bypassed, not that this check is too strict.",
      );
    }
  }
  return value;
}

/** Created once. A second `createPolicy` with the same name throws when policies are restricted. */
let policy: { createHTML: (input: string) => unknown } | null = null;

/**
 * The shell's Trusted Types policy, or null where the API does not exist.
 *
 * @returns {{ createHTML: (input: string) => unknown } | null}
 */
export function studioPolicy(): { createHTML: (input: string) => unknown } | null {
  if (policy) {
    return policy;
  }
  const api = (globalThis as unknown as { trustedTypes?: TrustedTypesApi }).trustedTypes;
  if (!api) {
    return null;
  }
  policy = api.createPolicy(STUDIO_POLICY_NAME, {
    createHTML: assertSanitized,
    createScript: () => {
      throw new Error("The Studio shell does not build scripts from strings.");
    },
    createScriptURL: () => {
      throw new Error("The Studio shell does not build script URLs from strings.");
    },
  });
  return policy;
}

/**
 * Turn already-sanitized markup into something an injection sink accepts.
 *
 * Returns a `TrustedHTML` where the API exists and the plain string where it does not — and in
 * **both** cases the assertion has run, so the check is not contingent on a browser feature. A
 * guard that only fires under Trusted Types would be a guard that never fires in the tests.
 *
 * @param {string} value Markup from `markdownToHtml`.
 * @returns {unknown} A `TrustedHTML`, or the asserted string.
 */
export function trustedHtml(value: string): unknown {
  const active = studioPolicy();
  return active ? active.createHTML(value) : assertSanitized(value);
}

/** Forget the memoized policy. Tests only — each one installs its own `trustedTypes` stub. */
export function resetStudioPolicy(): void {
  policy = null;
}
