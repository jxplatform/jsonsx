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

describe("Unicode normalization at the parse boundary (UAX #31 §R4)", () => {
  const NFD_ETAT = "e\u0301tat";
  const NFC_ETAT = "\u00E9tat";

  /*
   * The defect, stated as a test. These are two different JavaScript property names, so before the
   * boundary normalized them a document whose declaration and reference were typed on different
   * machines built cleanly and rendered nothing.
   */
  test("the two spellings really are different strings", () => {
    expect(NFD_ETAT).not.toBe(NFC_ETAT);
    expect(NFD_ETAT.normalize("NFC")).toBe(NFC_ETAT);
  });

  test("a decomposed state key arrives composed", () => {
    const doc = parseJxDocument(`{"state":{"${NFD_ETAT}":"bonjour"}}`, "/site/x.json");
    const state = doc.state as Record<string, unknown>;
    expect(Object.keys(state)).toEqual([NFC_ETAT]);
    expect(state[NFC_ETAT]).toBe("bonjour");
  });

  test("a decomposed reference in a template arrives composed, so it matches the key", () => {
    const doc = parseJxDocument(
      `{"state":{"${NFC_ETAT}":"bonjour"},"children":[{"tagName":"p","textContent":"\${state.${NFD_ETAT}}"}]}`,
      "/site/x.json",
    );
    const [child] = doc.children as { textContent: string }[];
    expect(child?.textContent).toBe(`\${state.${NFC_ETAT}}`);
  });

  test("a decomposed $ref pointer arrives composed", () => {
    const doc = parseJxDocument(
      `{"children":[{"tagName":"p","textContent":{"$ref":"#/state/${NFD_ETAT}"}}]}`,
      "/site/x.json",
    );
    const [child] = doc.children as { textContent: { $ref: string } }[];
    expect(child?.textContent.$ref).toBe(`#/state/${NFC_ETAT}`);
  });

  test("normalization reaches nested objects and arrays", () => {
    const doc = parseJxDocument(
      `{"children":[{"tagName":"ul","children":[{"tagName":"li","${NFD_ETAT}":1}]}]}`,
      "/site/x.json",
    );
    const [ul] = doc.children as { children: Record<string, unknown>[] }[];
    const [li] = ul?.children ?? [];
    expect(Object.keys(li ?? {})).toContain(NFC_ETAT);
  });

  test("project configs and class definitions cross the same boundary", () => {
    const config = parseProjectConfig(`{"name":"${NFD_ETAT}"}`, "/site/project.json");
    expect(config.name).toBe(NFC_ETAT);
    const cls = parseClassDef(`{"${NFD_ETAT}":true}`, "/site/X.class.json") as unknown as Record<
      string,
      unknown
    >;
    expect(Object.keys(cls)).toEqual([NFC_ETAT]);
  });

  /*
   * Canonical equivalence is symmetric, so a value that is ALREADY composed must be left exactly as
   * it is — the walk must not round-trip text through some other form on the way past.
   */
  test("already-composed text is returned unchanged", () => {
    const doc = parseJxDocument(`{"title":"${NFC_ETAT}","state":{"${NFC_ETAT}":1}}`, "/x.json");
    expect(doc.title).toBe(NFC_ETAT);
    expect(Object.keys(doc.state as object)).toEqual([NFC_ETAT]);
  });

  /*
   * NFC is composition, not folding or stripping. A CJK document, an emoji, and a script with no
   * composed forms at all must survive byte-for-byte; anything else would be losing content in the
   * name of fixing identifiers.
   */
  test("text with nothing to compose survives untouched", () => {
    const doc = parseJxDocument(
      `{"title":"\u8A08\u6570 \uD83C\uDF89 \u0627\u0644\u0639\u0631\u0628\u064A\u0629"}`,
      "/x.json",
    );
    expect(doc.title).toBe("\u8A08\u6570 \uD83C\uDF89 \u0627\u0644\u0639\u0631\u0628\u064A\u0629");
  });

  test("non-string leaves are untouched", () => {
    const doc = parseJxDocument(`{"state":{"n":1,"ok":true,"nothing":null}}`, "/x.json");
    expect(doc.state).toEqual({ n: 1, nothing: null, ok: true });
  });
});
