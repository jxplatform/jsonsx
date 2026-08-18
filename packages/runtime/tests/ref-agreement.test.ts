import { describe, expect, test } from "bun:test";
import { compileOperandSource, evaluateOperand } from "../src/expression.ts";
import { resolveRef } from "../src/runtime.ts";
import type { JxScope } from "../src/types.ts";

/*
 * Jx resolves a `$ref` three ways — `resolveRef` interpreting in the browser, `evaluateOperand`
 * interpreting inside an expression, and `compileOperandSource` lowering to JavaScript the compiler
 * writes into a built site. All three must answer the same thing for the same ref, and for a long
 * time they did not: each had its own idea of where a segment ended, so a document could behave one
 * way in Studio's live preview and another way once built.
 *
 * These tests run one ref through all three and compare. That is deliberately different from
 * asserting each function's output shape — a shape test passes happily while two implementations
 * drift apart, which is exactly what happened.
 */

const scope = () =>
  ({
    "a/b": "slash-key",
    items: ["zero", "one"],
    plain: "flat",
    user: { name: "Ada" },
    "user.name": "LITERAL",
  }) as unknown as JxScope;

/** Evaluate the lowered source the way a built site would, with `state` in scope. */
const runCompiled = (ref: string, state: JxScope): unknown => {
  const source = compileOperandSource({ $ref: ref }, { statePrefix: "state" });
  return new Function("state", `return ${source}`)(state) as unknown;
};

describe("all three resolvers agree", () => {
  test.each([
    // The case that started this: a numeric index lowered to `s.items.0`, a syntax error.
    ["#/state/items/0", "zero"],
    ["#/state/items/1", "one"],
    ["#/state/plain", "flat"],
    ["#/state/user/name", "Ada"],
    // A dot is an ordinary character, so this is one member — not a walk into `user`.
    ["#/state/user.name", "LITERAL"],
    // RFC 6901 §4: `~1` is a literal `/`. Previously unreachable by any ref.
    ["#/state/a~1b", "slash-key"],
    // A prop reaches the element through state, so `parent#/` reads the same place `#/state/` does.
    ["parent#/plain", "flat"],
    ["parent#/user/name", "Ada"],
    // No recognized scheme is still a path. This used to lower to `state.user/name` — a division.
    ["user/name", "Ada"],
    ["plain", "flat"],
  ])("%p resolves to %p everywhere", (ref, expected) => {
    const state = scope();
    expect(resolveRef(ref, state)).toEqual(expected);
    expect(evaluateOperand({ $ref: ref }, state, null)).toEqual(expected);
    expect(runCompiled(ref, state)).toEqual(expected);
  });

  /*
   * Every lowered ref must parse. This is the assertion the compiler never made: it emitted
   * `s.items.0` into a real site and reported the build a success, because nothing between the
   * string concatenation and the browser ever tried to parse the result.
   */
  test.each([
    "#/state/items/0",
    "#/state/user.name",
    "#/state/a~1b",
    "#/state/has space",
    "#/state/kebab-case",
    "parent#/user/name",
    "window#/location/href",
    "document#/title",
    "user/name",
  ])("%p lowers to source that parses", (ref) => {
    const source = compileOperandSource({ $ref: ref }, { statePrefix: "state" });
    expect(() => new Function("state", "window", "document", `return ${source}`)).not.toThrow();
  });
});

describe("a ref that reaches nothing", () => {
  // Both interpreters agree on the miss; see pointer.test.ts for where the compiled form differs.
  test("is undefined rather than a throw", () => {
    const state = scope();
    expect(resolveRef("#/state/nope/deeper", state)).toBeUndefined();
    expect(evaluateOperand({ $ref: "#/state/nope/deeper" }, state, null)).toBeUndefined();
  });
});
