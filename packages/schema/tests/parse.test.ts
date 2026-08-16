import { describe, expect, test } from "bun:test";

import {
  errorMessage,
  parseClassDef,
  parseJxDocument,
  parseProjectConfig,
  toError,
} from "../src/parse";

describe("errorMessage", () => {
  test("returns the message of an Error instance", () => {
    expect(errorMessage(new Error("boom"))).toBe("boom");
  });

  test("stringifies non-Error values", () => {
    expect(errorMessage("plain string")).toBe("plain string");
    expect(errorMessage(42)).toBe("42");
    expect(errorMessage(null)).toBe("null");
    expect(errorMessage({ code: 1 })).toBe("[object Object]");
  });
});

describe("toError", () => {
  test("returns the same Error instance untouched", () => {
    const original = new TypeError("bad type");
    expect(toError(original)).toBe(original);
  });

  test("wraps non-Error values in an Error", () => {
    const wrapped = toError("oops");
    expect(wrapped).toBeInstanceOf(Error);
    expect(wrapped.message).toBe("oops");

    const wrappedNumber = toError(7);
    expect(wrappedNumber).toBeInstanceOf(Error);
    expect(wrappedNumber.message).toBe("7");
  });
});

describe("parseJxDocument", () => {
  test("parses a valid document object", () => {
    const doc = parseJxDocument(
      JSON.stringify({ children: ["hi"], tagName: "div" }),
      "/site/pages/index.json",
    );
    expect(doc).toEqual({ children: ["hi"], tagName: "div" });
  });

  test("throws with the source path and cause on malformed JSON", () => {
    let caught: Error | undefined;
    try {
      parseJxDocument("{ not json", "/site/pages/broken.json");
    } catch (error) {
      caught = error as Error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught?.message).toContain("Failed to parse Jx document at /site/pages/broken.json");
    expect(caught?.cause).toBeInstanceOf(Error);
  });

  test("throws when the JSON is not an object", () => {
    expect(() => parseJxDocument("[1, 2]", "/p/arr.json")).toThrow(
      "Invalid Jx document at /p/arr.json: expected a JSON object",
    );
    expect(() => parseJxDocument('"str"', "/p/str.json")).toThrow("expected a JSON object");
    expect(() => parseJxDocument("null", "/p/null.json")).toThrow("expected a JSON object");
  });
});

describe("parseProjectConfig", () => {
  test("parses a valid project config", () => {
    const config = parseProjectConfig(
      JSON.stringify({ name: "My Site", url: "https://example.com" }),
      "/site/project.json",
    );
    expect(config.name).toBe("My Site");
  });

  test("labels failures as project config", () => {
    expect(() => parseProjectConfig("nope", "/site/project.json")).toThrow(
      "Failed to parse project config at /site/project.json",
    );
    expect(() => parseProjectConfig("3", "/site/project.json")).toThrow(
      "Invalid project config at /site/project.json: expected a JSON object",
    );
  });
});

describe("parseClassDef", () => {
  test("parses a class definition with the canonical discriminator", () => {
    const def = parseClassDef(
      JSON.stringify({ $prototype: "Class", title: "MarkdownFile" }),
      "/site/md.class.json",
    );
    expect(def.title).toBe("MarkdownFile");
  });

  test("parses class files that omit $prototype", () => {
    const def = parseClassDef(JSON.stringify({ title: "Calculator" }), "/site/calc.class.json");
    expect(def.title).toBe("Calculator");
  });

  test("labels failures as class definition", () => {
    expect(() => parseClassDef("{", "/site/bad.class.json")).toThrow(
      "Failed to parse class definition at /site/bad.class.json",
    );
    expect(() => parseClassDef("true", "/site/bool.class.json")).toThrow(
      "Invalid class definition at /site/bool.class.json: expected a JSON object",
    );
  });
});

describe("the I-JSON boundary", () => {
  /*
   * A duplicate key parses cleanly and loses the first value. That matters more here than in most
   * codebases: a Jx document is rebuilt from the parsed value every time it crosses into markdown
   * frontmatter or the CRDT, so whatever `JSON.parse` dropped never comes back.
   */
  test("a duplicate key is a parse failure, naming the key", () => {
    expect(() =>
      parseJxDocument(`{"state":{"a":1},"state":{"b":2}}`, "/site/pages/dup.json"),
    ).toThrow(/duplicate key "state"/);
  });

  test("an integer a double cannot hold is a parse failure", () => {
    expect(() => parseProjectConfig(`{"id":9007199254740993}`, "/site/project.json")).toThrow(
      /9007199254740993/,
    );
  });

  test("the message names the file and cites the RFC", () => {
    expect(() => parseJxDocument(`{"k":1,"k":2}`, "/site/pages/x.json")).toThrow(
      /Invalid Jx document at \/site\/pages\/x\.json.*RFC 7493/,
    );
  });

  test("an ordinary document still parses", () => {
    expect(parseJxDocument(`{"tagName":"div","state":{"n":1}}`, "/site/ok.json").tagName).toBe(
      "div",
    );
  });
});
