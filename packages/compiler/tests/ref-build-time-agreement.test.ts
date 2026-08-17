import { describe, expect, test } from "bun:test";
import { resolveRefValue } from "../src/shared.ts";
import { resolveRef } from "@jxsuite/runtime";
import type { JxScope } from "@jxsuite/runtime/types";

/*
 * `resolveRefValue` is the *fourth* resolver of the same `$ref` grammar: the compiler evaluates a
 * ref at build time to prerender it into the HTML, and the runtime evaluates the same ref in the
 * browser. When those two disagree the failure is invisible in the worst way — the prerendered page
 * shows one value, then hydration replaces it with another, and no build error is ever emitted.
 *
 * So this file asserts the build-time resolver against the runtime one rather than against a
 * literal. A shape assertion here would pass while the two drifted apart, which is what happened:
 * the build-time reader took the leading token literally without unescaping it, and read an
 * unrecognized scheme as a single key while the emitted client module walked it as a path.
 */

const scope = () => ({
  "a/b": "slash-key",
  items: ["zero", "one"],
  plain: "flat",
  user: { name: "Ada" },
  "user.name": "LITERAL",
});

describe("the build-time resolver agrees with the runtime one", () => {
  test.each([
    ["#/state/plain", "flat"],
    ["#/state/user/name", "Ada"],
    // A dot is an ordinary character (RFC 6901 §3), so this is one member, not a walk.
    ["#/state/user.name", "LITERAL"],
    // `~1` is a literal `/`. The hand-split leading token never unescaped it.
    ["#/state/a~1b", "slash-key"],
    ["#/state/items/0", "zero"],
    // No recognized scheme is still a path, as everywhere else.
    ["user/name", "Ada"],
    ["plain", "flat"],
  ])("%p prerenders as %p, the same value hydration will produce", (ref, expected) => {
    expect(resolveRefValue(ref, scope())).toEqual(expected);
    expect(resolveRef(ref, scope() as unknown as JxScope)).toEqual(expected);
  });

  // A non-string ref is a literal value and passes straight through, unlike every case above.
  test("a value that is not a ref string is returned unchanged", () => {
    expect(resolveRefValue(42, scope())).toBe(42);
    expect(resolveRefValue(null, scope())).toBeNull();
  });
});
