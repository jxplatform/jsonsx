/**
 * The Studio shell's Trusted Types policy: what it refuses, and the property that makes it a
 * control rather than a ceremony — the assertion runs whether or not the browser has the API.
 */

import "./harness";
import { afterEach, describe, expect, test } from "bun:test";
import {
  assertSanitized,
  resetStudioPolicy,
  STUDIO_POLICY_NAME,
  studioPolicy,
  trustedHtml,
} from "../src/services/trusted-types";

interface PolicyRules {
  createHTML?: (input: string) => string;
  createScript?: (input: string) => string;
  createScriptURL?: (input: string) => string;
}

/** Install a minimal `trustedTypes` stub and hand back what the policy was created with. */
function installTrustedTypes(): { name: string | null; rules: PolicyRules | null } {
  const captured: { name: string | null; rules: PolicyRules | null } = { name: null, rules: null };
  (globalThis as Record<string, unknown>).trustedTypes = {
    createPolicy(name: string, rules: PolicyRules) {
      captured.name = name;
      captured.rules = rules;
      return { createHTML: (input: string) => `TRUSTED:${rules.createHTML?.(input) ?? input}` };
    },
  };
  return captured;
}

afterEach(() => {
  resetStudioPolicy();
  delete (globalThis as Record<string, unknown>).trustedTypes;
});

describe("assertSanitized", () => {
  test("passes markup markdown legitimately produces", () => {
    const html = '<p>Hello <a href="https://example.com">there</a></p><pre><code>x</code></pre>';
    expect(assertSanitized(html)).toBe(html);
    expect(assertSanitized("")).toBe("");
  });

  test("refuses every shape an injection takes, and says which", () => {
    /*
     * These should all have been removed upstream. A value that reaches here still carrying one
     * means the sanitizer was bypassed — which is exactly when a pass-through policy would have
     * been silent.
     */
    expect(() => assertSanitized("<script>alert(1)</script>")).toThrow("<script> element");
    expect(() => assertSanitized('<iframe src="/x"></iframe>')).toThrow("<iframe> element");
    expect(() => assertSanitized("<object data=x></object>")).toThrow("<object> element");
    expect(() => assertSanitized("<embed src=x>")).toThrow("<embed> element");
    expect(() => assertSanitized('<img src=x onerror="alert(1)">')).toThrow("inline event handler");
    // oxlint-disable-next-line no-script-url -- the string under test IS the thing being refused
    expect(() => assertSanitized('<a href="javascript:alert(1)">x</a>')).toThrow("javascript: URL");
    expect(() => assertSanitized('<a href="data:text/html,<b>">x</a>')).toThrow("data: URL");
  });

  test("is case- and whitespace-insensitive, because an attacker is", () => {
    expect(() => assertSanitized("<  SCRIPT >x")).toThrow();
    expect(() => assertSanitized('<img src=x ONERROR ="1">')).toThrow();
    expect(() => assertSanitized('<a href="JaVaScRiPt:x">')).toThrow();
  });
});

describe("studioPolicy", () => {
  test("is null where the API does not exist, and the assertion still runs", () => {
    // The guard must not be contingent on a browser feature, or it never fires in a test.
    expect(studioPolicy()).toBeNull();
    expect(trustedHtml("<p>ok</p>")).toBe("<p>ok</p>");
    expect(() => trustedHtml("<script>x</script>")).toThrow();
  });

  test("creates one named policy whose createHTML is the assertion", () => {
    const captured = installTrustedTypes();
    expect(trustedHtml("<p>ok</p>")).toBe("TRUSTED:<p>ok</p>");
    expect(captured.name).toBe(STUDIO_POLICY_NAME);
    expect(captured.rules?.createHTML?.("<p>ok</p>")).toBe("<p>ok</p>");
    expect(() => captured.rules?.createHTML?.("<script>x</script>")).toThrow();
  });

  test("createScript and createScriptURL refuse", () => {
    /*
     * A permissive createScript is how Trusted Types becomes a rubber stamp: under the standard,
     * eval() and new Function() are gated too, and a pass-through default policy re-permits both.
     * Nothing in the shell builds either from a string, so both throw.
     */
    const captured = installTrustedTypes();
    studioPolicy();
    expect(() => captured.rules?.createScript?.("alert(1)")).toThrow("does not build scripts");
    expect(() => captured.rules?.createScriptURL?.("/x.js")).toThrow("does not build script URLs");
  });

  test("the policy is created once", () => {
    let created = 0;
    (globalThis as Record<string, unknown>).trustedTypes = {
      createPolicy(_name: string, rules: PolicyRules) {
        created += 1;
        return { createHTML: (input: string) => rules.createHTML?.(input) ?? input };
      },
    };
    studioPolicy();
    studioPolicy();
    // A second createPolicy with the same name throws where policies are restricted by CSP.
    expect(created).toBe(1);
  });
});
