import { describe, expect, test } from "bun:test";
import {
  escapeToken,
  objectKey,
  readPath,
  refAccessor,
  refBindingKey,
  refSegments,
  unescapeToken,
} from "../src/pointer.ts";

/*
 * These tests exist because five implementations of this grammar disagreed and the disagreement was
 * invisible: the compiler emitted JavaScript that could not parse while reporting a clean build.
 * So the assertions that matter most here are the equivalence ones at the bottom — a shape test
 * pins what one function returns, but only comparing the interpreter against the compiled accessor
 * catches the two drifting apart again.
 */

describe("refSegments", () => {
  test("splits on / and nothing else", () => {
    expect(refSegments("user/name")).toEqual(["user", "name"]);
    expect(refSegments("items/0")).toEqual(["items", "0"]);
    expect(refSegments("plain")).toEqual(["plain"]);
  });

  /*
   * RFC 6901 §3: a reference token is any character except `/` and `~`. A dot is ordinary, so this
   * is one member literally named `user.name` — not a nesting. Two of the five old implementations
   * split on `.` as well, which is why a write and its matching read could address different keys.
   */
  test("a dot is an ordinary character, not a separator", () => {
    expect(refSegments("user.name")).toEqual(["user.name"]);
    expect(refSegments("a.b/c.d")).toEqual(["a.b", "c.d"]);
  });

  test("an empty path is no segments, so #/state/ reads state itself", () => {
    expect(refSegments("")).toEqual([]);
  });

  test("unescapes the two reserved characters", () => {
    expect(refSegments("a~1b")).toEqual(["a/b"]);
    expect(refSegments("a~0b")).toEqual(["a~b"]);
  });

  // RFC 6901 §4 fixes the order: `~1` first, so `~01` is `~1` rather than `/`.
  test("applies the escapes in the order the RFC specifies", () => {
    expect(unescapeToken("~01")).toBe("~1");
    expect(unescapeToken("~1")).toBe("/");
  });

  test("escapeToken round-trips through unescapeToken", () => {
    for (const key of ["a/b", "a~b", "~", "/", "a~1b", "plain", "user.name", ""]) {
      expect(unescapeToken(escapeToken(key))).toBe(key);
    }
  });
});

describe("readPath", () => {
  const root = { items: ["a", "b"], nested: { deep: 1 }, "user.name": "LITERAL" };

  test("walks slash-separated segments", () => {
    expect(readPath(root, "nested/deep")).toBe(1);
    expect(readPath(root, "items/0")).toBe("a");
  });

  test("reads a dotted key as one member", () => {
    expect(readPath(root, "user.name")).toBe("LITERAL");
  });

  test("an empty path is the root", () => {
    expect(readPath(root, "")).toBe(root);
  });

  test("leaving the object is undefined, not a throw", () => {
    expect(readPath(root, "missing/deeper")).toBeUndefined();
    expect(readPath(null, "a")).toBeUndefined();
    expect(readPath(undefined, "a/b")).toBeUndefined();
  });
});

describe("refAccessor", () => {
  test("dots a segment that is genuinely an identifier", () => {
    expect(refAccessor("s", "user/name")).toBe("s.user.name");
    expect(refAccessor("_args", "price")).toBe("_args.price");
    expect(refAccessor("s", "$ok/_x")).toBe("s.$ok._x");
  });

  /*
   * The branch the bug was missing. Each of these produced broken output from a build that reported
   * success: `s.items.0` is a SyntaxError, `s.user.name` silently read a nesting that does not
   * exist, and `s.a-b` is a subtraction against an undeclared identifier.
   */
  test("brackets a segment that is not", () => {
    expect(refAccessor("s", "items/0")).toBe('s.items["0"]');
    expect(refAccessor("s", "user.name")).toBe('s["user.name"]');
    expect(refAccessor("s", "a-b")).toBe('s["a-b"]');
    expect(refAccessor("s", "has space")).toBe('s["has space"]');
    expect(refAccessor("s", "a~1b")).toBe('s["a/b"]');
  });

  // Reserved words are legal member names, so there is no reason to bracket them.
  test("leaves a reserved word dotted", () => {
    expect(refAccessor("s", "class/new/default")).toBe("s.class.new.default");
  });

  test("an empty path is the base alone", () => {
    expect(refAccessor("s", "")).toBe("s");
  });
});

describe("objectKey", () => {
  test("bare where it is an identifier, quoted where it is not", () => {
    expect(objectKey("count")).toBe("count");
    expect(objectKey("$map")).toBe("$map");
    expect(objectKey("user.name")).toBe('"user.name"');
    expect(objectKey("0")).toBe('"0"');
    expect(objectKey("a-b")).toBe('"a-b"');
  });

  test("every result is a parseable object literal", () => {
    for (const key of ["count", "user.name", "0", "a-b", "has space", '"', "\\", ""]) {
      const literal = new Function(`return {${objectKey(key)}: 1}`)() as Record<string, number>;
      expect(literal[key]).toBe(1);
    }
  });
});

describe("refBindingKey", () => {
  // The corpus is pure-slash, and those keys must not move — they are also HTML attribute values.
  test("a pure-slash ref keeps the key it already had", () => {
    expect(refBindingKey("user/name")).toBe("user_name");
    expect(refBindingKey("items/0")).toBe("items_0");
    expect(refBindingKey("plain")).toBe("plain");
  });

  /*
   * `$` is an identifier character and folding it was a real regression: the `on` map kept its
   * `$handler` key while the emitted call site became `on.handler`, so the handler was silently
   * unbound with no error at build time or in the browser.
   */
  test("keeps $, which is an identifier character", () => {
    expect(refBindingKey("$handler")).toBe("$handler");
    expect(refBindingKey("$map/item")).toBe("$map_item");
  });

  // Collapsing runs of `_` made `a__b` and `a_b` collide for purely cosmetic reasons.
  test("does not collapse or trim underscores", () => {
    expect(refBindingKey("a__b")).toBe("a__b");
    expect(refBindingKey("_leading")).toBe("_leading");
    expect(refBindingKey("trailing_")).toBe("trailing_");
  });

  test("folds everything else and never starts with a digit", () => {
    expect(refBindingKey("user.name")).toBe("user_name");
    expect(refBindingKey("a-b")).toBe("a_b");
    expect(refBindingKey("0abc")).toBe("_0abc");
    expect(refBindingKey("")).toBe("ref");
  });

  test("every result is a usable identifier", () => {
    for (const ref of ["user/name", "$handler", "0abc", "a-b", "user.name", "", "///"]) {
      const key = refBindingKey(ref);
      expect(new Function(`const ${key} = 1; return ${key}`)()).toBe(1);
    }
  });
});

/*
 * The property the whole module exists for. Whatever a ref means, the interpreter walking it and
 * the compiler's emitted accessor must agree — that equivalence is what silently broke.
 */
describe("the interpreter and the emitted accessor agree", () => {
  const state = {
    "a-b": "hyphen",
    "a/b": "slashed-key",
    items: ["zero", "one"],
    nested: { deep: { deeper: 42 } },
    "user.name": "LITERAL",
  };

  test.each([
    "items/0",
    "items/1",
    "nested/deep/deeper",
    "user.name",
    "a-b",
    "a~1b",
    "missing",
    "",
  ])("%p reads the same value both ways", (path) => {
    const compiled = new Function("s", `return ${refAccessor("s", path)}`)(state) as unknown;
    expect(compiled).toEqual(readPath(state, path));
  });

  /*
   * The one case where they do not agree, pinned so it is a known divergence rather than a
   * discovery. Walking past a missing intermediate is undefined to the interpreter and a TypeError
   * to the compiled accessor, because the emitted member access is not optional-chained. That
   * predates this module and is left alone here: making `s.a?.b` the emitted form is a change to
   * what every compiled site does at runtime, not a fix to how a ref is tokenized.
   */
  test("a missing intermediate is undefined interpreted and a throw compiled", () => {
    expect(readPath(state, "missing/deeper")).toBeUndefined();
    expect(() => new Function("s", `return ${refAccessor("s", "missing/deeper")}`)(state)).toThrow(
      TypeError,
    );
  });
});
