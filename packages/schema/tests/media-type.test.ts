import { describe, expect, test } from "bun:test";
import {
  formatMediaType,
  isUnregisteredMediaType,
  mediaTypeEssence,
  mediaTypeProblem,
  parseMediaType,
} from "../src/media-type.ts";

describe("parseMediaType", () => {
  test("splits type and subtype", () => {
    expect(parseMediaType("text/markdown")).toEqual({
      parameters: {},
      subtype: "markdown",
      suffix: null,
      tree: null,
      type: "text",
    });
  });

  // RFC 6838 §4.2 makes both halves case-insensitive, so one spelling reaches every comparison.
  test("lower-cases both halves and the parameter names", () => {
    const parsed = parseMediaType("TEXT/Markdown; Variant=GFM");
    expect(parsed?.type).toBe("text");
    expect(parsed?.subtype).toBe("markdown");
    // The value is left alone: `GFM` is a name from RFC 7764, not a token to normalize.
    expect(parsed?.parameters).toEqual({ variant: "GFM" });
  });

  test("recognizes the registration trees", () => {
    expect(parseMediaType("application/vnd.acme.thing")?.tree).toBe("vnd");
    expect(parseMediaType("application/prs.acme")?.tree).toBe("prs");
    expect(parseMediaType("application/x.jx-doc")?.tree).toBe("x");
    // A dot that is not a known facet stays part of the subtype.
    expect(parseMediaType("application/acme.thing")?.tree).toBeNull();
    expect(parseMediaType("application/acme.thing")?.subtype).toBe("acme.thing");
  });

  // `+suffix` binds last, so a dotted vendor subtype keeps its dots.
  test("splits the structured suffix after the tree", () => {
    const parsed = parseMediaType("application/vnd.acme.thing+json");
    expect(parsed).toMatchObject({ subtype: "acme.thing", suffix: "json", tree: "vnd" });
  });

  test("unquotes a quoted parameter value", () => {
    const quoted = 'text/plain; charset="us-ascii"';
    expect(parseMediaType(quoted)?.parameters.charset).toBe("us-ascii");
  });

  test("rejects what is not a media type", () => {
    for (const value of ["texthtml", "text/", "/json", "", "  ", 42, null]) {
      expect(parseMediaType(value)).toBeNull();
    }
  });

  // The mistake this whole module exists to catch: one missing `=` in a header value.
  test("rejects a parameter with no value", () => {
    expect(parseMediaType("text/markdown;variant GFM")).toBeNull();
    expect(parseMediaType("text/markdown;=GFM")).toBeNull();
  });

  test("rejects an empty suffix", () => {
    expect(parseMediaType("application/thing+")).toBeNull();
  });

  // A facet with nothing after it names no subtype, however well-formed the characters are.
  test("rejects a tree facet with no subtype", () => {
    expect(parseMediaType("application/vnd.")).toBeNull();
    expect(parseMediaType("application/x.")).toBeNull();
  });

  test("rejects a name longer than the restricted 127 characters", () => {
    expect(parseMediaType(`text/${"a".repeat(128)}`)).toBeNull();
    expect(parseMediaType(`text/${"a".repeat(127)}`)).not.toBeNull();
  });
});

describe("formatMediaType", () => {
  test("round-trips a parsed type", () => {
    for (const value of [
      "text/markdown",
      "application/feed+json",
      "application/vnd.acme.thing+json",
      "text/markdown; variant=GFM",
    ]) {
      expect(formatMediaType(parseMediaType(value)!)).toBe(value);
    }
  });
});

describe("mediaTypeEssence", () => {
  /*
   * The distinction that made this necessary: a File System Access `accept` key and a Monaco
   * language id are both *keys*, and `text/markdown; variant=GFM` is not a key. Both call sites
   * broke the moment a format declared the RFC 7763 parameter.
   */
  test("drops the parameters and keeps everything else", () => {
    expect(mediaTypeEssence("text/markdown; variant=GFM")).toBe("text/markdown");
    expect(mediaTypeEssence("application/vnd.acme.thing+json; v=1")).toBe(
      "application/vnd.acme.thing+json",
    );
    expect(mediaTypeEssence("text/csv")).toBe("text/csv");
  });

  test("is null for a value that is not a media type", () => {
    expect(mediaTypeEssence("nonsense")).toBeNull();
  });
});

describe("mediaTypeProblem", () => {
  test("null when the value is fine", () => {
    expect(mediaTypeProblem("text/markdown; variant=GFM")).toBeNull();
  });

  test("names the missing slash specifically", () => {
    expect(mediaTypeProblem("texthtml")).toContain('has no "/"');
  });

  test("falls back to a general message, citing the section", () => {
    expect(mediaTypeProblem("text/markdown;variant GFM")).toContain("RFC 6838 §4.2");
  });

  test("an empty or non-string value says so", () => {
    expect(mediaTypeProblem("")).toBe("expected a media type string");
    expect(mediaTypeProblem(42)).toBe("expected a media type string");
  });
});

describe("isUnregisteredMediaType", () => {
  test("true for the x. tree and the deprecated x- convention", () => {
    expect(isUnregisteredMediaType("application/x.jx-doc")).toBe(true);
    expect(isUnregisteredMediaType("application/x-jx-doc")).toBe(true);
  });

  test("false for registered and vendor types", () => {
    expect(isUnregisteredMediaType("text/markdown")).toBe(false);
    expect(isUnregisteredMediaType("application/vnd.acme.thing")).toBe(false);
    expect(isUnregisteredMediaType("nonsense")).toBe(false);
  });
});
