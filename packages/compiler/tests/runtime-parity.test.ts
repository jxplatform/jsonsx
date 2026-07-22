import { describe, expect, test } from "bun:test";
import { evaluateStaticTemplate, resolveRefValue } from "../src/shared.ts";

/**
 * Contract tests for the compiler's build-time evaluators. The compiler forks the runtime's
 * template/`$ref` evaluation (it must run at build time, over plain objects, without crashing the
 * build). These tests PIN the overlap where the two must agree, and — just as importantly — pin the
 * INTENTIONAL divergences so a future change to either side can't drift them silently.
 *
 * Agreement (runtime and compiler must match): static state values, single-variable interpolation,
 * `#/state/x` and `$map/…` refs.
 *
 * Intentional divergences (documented, not bugs): - error handling: static eval swallows exceptions
 * to `null` (the build must not crash); the runtime propagates them. - single-expression unwrap:
 * `"${expr}"` yields the RAW value at build time; the runtime always returns a string from a
 * template. - resolution schemes: the compiler resolves only `#/state/` and `$map/`; `window#/`,
 * `parent#/`, `document#/` have no build-time meaning and fall through to `null`.
 */

describe("evaluateStaticTemplate — agreement", () => {
  test("interpolates a state value into a multi-part template (string result)", () => {
    expect(evaluateStaticTemplate("count: ${state.n}", { n: 5 })).toBe("count: 5");
  });

  test("resolves a $map reference inside a template", () => {
    expect(evaluateStaticTemplate("${$map.item}", { $map: { item: "hi" } })).toBe("hi");
  });
});

describe("evaluateStaticTemplate — intentional divergences", () => {
  test("single-expression templates return the RAW value, not a string", () => {
    // Runtime returns "5"; the compiler returns 5 so downstream typing survives.
    expect(evaluateStaticTemplate("${state.n}", { n: 5 })).toBe(5);
    expect(evaluateStaticTemplate("${state.on}", { on: true })).toBe(true);
  });

  test("errors are swallowed to null so a bad expression cannot crash the build", () => {
    // Runtime would throw on `undefined.b`; the compiler yields null.
    expect(evaluateStaticTemplate("${state.missing.b}", {})).toBeNull();
  });
});

describe("resolveRefValue — agreement", () => {
  test("resolves #/state/x", () => {
    expect(resolveRefValue("#/state/count", { count: 7 })).toBe(7);
  });

  test("resolves a nested #/state/x/y path", () => {
    expect(resolveRefValue("#/state/user/name", { user: { name: "Ada" } })).toBe("Ada");
  });

  test("resolves $map/item", () => {
    expect(resolveRefValue("$map/item", { $map: { item: 42 } })).toBe(42);
  });
});

describe("resolveRefValue — intentional divergences", () => {
  test("non-state schemes have no build-time meaning (fall through to null)", () => {
    // The runtime resolves window#/parent#/document#/; the compiler cannot at build time.
    expect(resolveRefValue("window#/currentUser", {})).toBeNull();
    expect(resolveRefValue("parent#/shared", {})).toBeNull();
  });

  test("a non-string ref value is returned as-is", () => {
    expect(resolveRefValue(123, {})).toBe(123);
  });
});
