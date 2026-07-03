/**
 * Unit tests for the pure {@link serializeDataScope} helper: it turns the iframe's resolved `$defs`
 * (a Vue reactive proxy in production) into a structured-clone-safe plain object for postMessage.
 * No DOM/reactivity needed — the module is DOM-free — so this suite imports it directly.
 */
import { describe, expect, test } from "bun:test";
import { serializeDataScope } from "../src/canvas/serialize-scope";

/** Fake a Vue ref so the top-level auto-unwrap path is exercised (mirrors merge-tags.test.ts). */
function ref<T>(value: T) {
  return { __v_isRef: true, value };
}

describe("serializeDataScope", () => {
  test("passes through primitives, arrays, objects, and null", () => {
    const out = serializeDataScope({
      arr: [1, 2, 3],
      bool: true,
      nada: null,
      num: 42,
      obj: { a: 1, nested: { b: 2 } },
      str: "hello",
    });
    expect(out).toEqual({
      arr: [1, 2, 3],
      bool: true,
      nada: null,
      num: 42,
      obj: { a: 1, nested: { b: 2 } },
      str: "hello",
    });
  });

  test("drops function-valued keys entirely (handlers/server fns aren't data)", () => {
    const out = serializeDataScope({
      keep: "yes",
      onClick: () => "nope",
    });
    expect(out).toEqual({ keep: "yes" });
    expect("onClick" in out).toBe(false);
  });

  test("a top-level ref-shaped value is JSON-cloned (the ref object survives as data)", () => {
    // Production reads through the reactive proxy so `defs[key]` is already the unwrapped value; when
    // A ref object is present it is still a plain serializable object and round-trips intact.
    const out = serializeDataScope({ profile: ref({ name: "Bob" }) });
    expect(out.profile).toEqual({ __v_isRef: true, value: { name: "Bob" } });
  });

  test("a circular object maps that key to null (no throw)", () => {
    const circular: Record<string, unknown> = { a: 1 };
    circular.self = circular;
    const out = serializeDataScope({ circular, ok: "fine" });
    expect(out.circular).toBeNull();
    expect(out.ok).toBe("fine");
  });

  test("a throwing getter maps that key to null (no throw)", () => {
    const out = serializeDataScope({
      get boom(): unknown {
        throw new Error("computed exploded");
      },
      safe: 1,
    });
    expect(out.boom).toBeNull();
    expect(out.safe).toBe(1);
  });

  test("an over-cap large value is replaced with a placeholder string", () => {
    const huge = "x".repeat(300_000); // JSON string > 256_000-char cap.
    const out = serializeDataScope({ huge, small: "ok" });
    expect(out.huge).toBe("[large value omitted]");
    expect(out.small).toBe("ok");
  });

  test("an over-cap large ARRAY value is also replaced with the placeholder", () => {
    const bigArray = Array.from({ length: 100_000 }, (_, i) => i); // JSON well over the cap.
    const out = serializeDataScope({ bigArray });
    expect(out.bigArray).toBe("[large value omitted]");
  });

  test("a value that JSON.stringify serializes to undefined maps to null", () => {
    // A bare undefined/symbol at the top level stringifies to `undefined` (not a string).
    const out = serializeDataScope({ sym: Symbol("x"), undef: undefined });
    expect(out.sym).toBeNull();
    expect(out.undef).toBeNull();
  });

  test("empty defs → empty object", () => {
    expect(serializeDataScope({})).toEqual({});
  });

  test("output is structured-clone-safe (no functions/proxies left)", () => {
    const out = serializeDataScope({
      a: [1, { b: 2 }],
      c: null,
      d: "str",
      fn: () => 0,
    });
    // StructuredClone throws (DataCloneError) on a function/proxy; a clean clone proves every
    // Retained value is plain, structured-clone-friendly data.
    expect(structuredClone(out)).toEqual(out);
  });
});
