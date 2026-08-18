import { describe, expect, test } from "bun:test";
import { describeIJsonProblem, findIJsonProblems, isSafeJsonNumber } from "../src/ijson.ts";

/** Every fixture must be valid JSON — this checks what `JSON.parse` accepts but distorts. */
const problems = (text: string) => {
  JSON.parse(text);
  return findIJsonProblems(text);
};

describe("findIJsonProblems — duplicate names", () => {
  test("an ordinary document is clean", () => {
    expect(problems(`{"a":1,"b":[{"c":2}],"d":"x","e":null,"f":true}`)).toEqual([]);
  });

  /*
   * The failure this exists for: `JSON.parse` keeps the last duplicate and says nothing, so the
   * first `state` object simply vanishes — and a Jx document is rebuilt from the parsed value
   * every time it crosses into markdown or the CRDT, so it never comes back.
   */
  test("catches a repeated key at the root", () => {
    expect(problems(`{"state":{"a":1},"tagName":"div","state":{"b":2}}`)).toEqual([
      { detail: "state", kind: "duplicate-key", path: "" },
    ]);
  });

  test("names the containing object", () => {
    expect(problems(`{"outer":{"k":1,"k":2}}`)[0]?.path).toBe("outer");
  });

  test("looks inside arrays, and paths through them", () => {
    expect(problems(`{"items":[{"id":1,"id":2}]}`)[0]).toEqual({
      detail: "id",
      kind: "duplicate-key",
      path: "items",
    });
    expect(problems(`{"a":{"b":[[{"x":1,"x":2}]]}}`)[0]?.path).toBe("a.b");
  });

  test("the same key in two different objects is not a duplicate", () => {
    expect(problems(`{"a":{"k":1},"b":{"k":2}}`)).toEqual([]);
  });

  // A string on the right of a `:` is a value, and a `:` inside one is just a character.
  test("a colon inside a string value is not a key separator", () => {
    expect(problems(`{"a":"b:c","d":1}`)).toEqual([]);
    expect(problems(`{"a":["b:c","b:c"],"d":1}`)).toEqual([]);
  });

  // Keys are compared after unescaping, because that is what they are.
  test("an escaped key and its plain spelling are the same key", () => {
    expect(problems(String.raw`{"ab":1,"ab":2}`)).toHaveLength(1);
    expect(problems(String.raw`{"a\nb":1,"a\nb":2}`)).toHaveLength(1);
  });

  test("a brace inside a string does not open an object", () => {
    expect(problems(`{"a":"{\\"k\\":1,\\"k\\":2}","b":2}`)).toEqual([]);
  });

  // A `\uXXXX` key is decoded before comparison, so `\u0062` and `b` are the same name.
  test("a unicode-escaped key matches its decoded spelling", () => {
    expect(problems(String.raw`{"a\u0062":1,"ab":2}`)).toHaveLength(1);
    expect(problems(String.raw`{"a\u0062":1,"ac":2}`)).toEqual([]);
  });

  test("whitespace between a key and its colon does not hide the key", () => {
    expect(problems(`{ "k" : 1 , "k" : 2 }`)).toHaveLength(1);
  });

  test("an unterminated string does not hang the scan", () => {
    // Not valid JSON, so it bypasses the fixture helper — the scanner must still terminate.
    expect(findIJsonProblems(`{"a":"unclosed`)).toEqual([]);
  });
});

describe("findIJsonProblems — literals", () => {
  test("true, false and null are consumed without being mistaken for keys", () => {
    expect(problems(`{"a":true,"b":false,"c":null,"a2":[true,null]}`)).toEqual([]);
  });

  test("a stray character is skipped rather than looping", () => {
    expect(findIJsonProblems("@")).toEqual([]);
  });
});

describe("findIJsonProblems — number precision", () => {
  /*
   * `9007199254740993` parses to `...992`, and the next serialization writes the wrong number
   * back to disk. That is data loss in the same class as a dropped key.
   */
  test("catches an integer beyond what a double holds", () => {
    expect(problems(`{"id":9007199254740993}`)[0]).toMatchObject({
      detail: "9007199254740993",
      kind: "unsafe-number",
    });
  });

  test("the largest safe integer is fine", () => {
    expect(problems(`{"id":9007199254740991}`)).toEqual([]);
  });

  /*
   * Fractions are never judged. `0.1` is not exactly representable either, so flagging them would
   * flag most real documents while saying nothing about whether the author's value survived.
   */
  test("says nothing about fractions or exponents", () => {
    expect(problems(`{"x":0.1,"y":1e10,"z":-3.5,"w":1.7976931348623157e308}`)).toEqual([]);
  });

  test("paths a number to the key that holds it, or to its array", () => {
    expect(problems(`{"nested":{"id":9007199254740993}}`)[0]?.path).toBe("nested.id");
    expect(problems(`{"ids":[9007199254740993]}`)[0]?.path).toBe("ids");
  });

  test("negative integers are judged the same way", () => {
    expect(problems(`{"id":-9007199254740993}`)).toHaveLength(1);
    expect(problems(`{"id":-9007199254740991}`)).toEqual([]);
  });
});

describe("isSafeJsonNumber", () => {
  test("integers round-trip or they do not", () => {
    expect(isSafeJsonNumber("42")).toBe(true);
    expect(isSafeJsonNumber("9007199254740993")).toBe(false);
    // A leading zero run is not JSON, but the scanner is defensive rather than a second parser.
    expect(isSafeJsonNumber("0")).toBe(true);
  });

  test("anything with a fraction or exponent passes", () => {
    expect(isSafeJsonNumber("0.1")).toBe(true);
    expect(isSafeJsonNumber("1e400")).toBe(true);
  });
});

describe("describeIJsonProblem", () => {
  test("cites the section and says what is lost", () => {
    expect(describeIJsonProblem({ detail: "k", kind: "duplicate-key", path: "a" })).toContain(
      "RFC 7493 §2.3",
    );
    expect(describeIJsonProblem({ detail: "1", kind: "unsafe-number", path: "" })).toContain(
      "the document root",
    );
  });
});

describe("isSafeJsonNumber — integers JavaScript cannot hold", () => {
  /*
   * An integer literal is safe only when `String(Number(x))` reproduces it: that is the round trip
   * a parse-then-serialize performs, and anything it changes is a value the document no longer
   * says. A literal too large to be finite loses everything, not just precision.
   */
  test("a literal that overflows to Infinity is not safe", () => {
    expect(isSafeJsonNumber("9".repeat(400))).toBe(false);
    expect(isSafeJsonNumber(`-${"9".repeat(400)}`)).toBe(false);
  });

  test("a float literal is left alone — only integers are round-tripped", () => {
    expect(isSafeJsonNumber("1e999")).toBe(true);
  });
});
