import { describe, expect, test } from "bun:test";
import {
  formatMediaType,
  isUnregisteredMediaType,
  MEDIA_TYPE_BY_EXTENSION,
  mediaTypeEssence,
  mediaTypeForPath,
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

/*
 * The IANA charset name. `utf-8` is the registration and the only spelling valid in a media type's
 * `charset` parameter; the lint rule that prefers `utf8` is about Node's Buffer encodings, a
 * different namespace that happens to share the string.
 */
// oxlint-disable-next-line unicorn/text-encoding-identifier-case -- IANA charset name, not a Buffer encoding.
const CHARSET = "utf-8";

describe("MEDIA_TYPE_BY_EXTENSION", () => {
  /*
   * The table exists to CORRECT a host's own lookup, so its two failure modes are opposite: an
   * entry that is wrong (asserted below against the registrations) and an entry that should not be
   * there at all. The second is the one worth guarding — a general MIME table here would become a
   * second source of truth for types no standard is ambiguous about.
   */
  test("holds only the extensions whose platform answer is wrong", () => {
    expect(Object.keys(MEDIA_TYPE_BY_EXTENSION).toSorted()).toEqual([
      ".markdown",
      ".md",
      ".yaml",
      ".yml",
    ]);
  });

  test("markdown names its variant, per RFC 7763 and RFC 7764", () => {
    const parsed = parseMediaType(MEDIA_TYPE_BY_EXTENSION[".md"]);
    expect(parsed?.type).toBe("text");
    expect(parsed?.subtype).toBe("markdown");
    expect(parsed?.parameters).toEqual({ charset: CHARSET, variant: "GFM" });
  });

  // RFC 9512 §5: `text/yaml` and friends are the pre-registration spellings. This must not be one.
  test("yaml is application/yaml, not the deprecated text/yaml", () => {
    expect(mediaTypeEssence(MEDIA_TYPE_BY_EXTENSION[".yaml"] ?? null)).toBe("application/yaml");
    expect(mediaTypeEssence(MEDIA_TYPE_BY_EXTENSION[".yml"] ?? null)).toBe("application/yaml");
  });

  test("every entry is a well-formed media type", () => {
    for (const value of Object.values(MEDIA_TYPE_BY_EXTENSION)) {
      expect(mediaTypeProblem(value)).toBeNull();
    }
  });
});

describe("mediaTypeForPath", () => {
  test("answers for the extensions it corrects, in any case", () => {
    expect(mediaTypeForPath("/site/post.md")).toBe(
      `text/markdown; variant=GFM; charset=${CHARSET}`,
    );
    expect(mediaTypeForPath("data.YAML")).toBe(`application/yaml; charset=${CHARSET}`);
  });

  /*
   * Null is the common answer and the contract: a host calls this to override its own table, so an
   * extension absent here must leave that table alone rather than fall back to octet-stream.
   */
  test("answers null for everything else, so the host's own table stays in charge", () => {
    expect(mediaTypeForPath("/img/hero.png")).toBeNull();
    expect(mediaTypeForPath("README")).toBeNull();
    expect(mediaTypeForPath("/some.dir/README")).toBeNull();
    expect(mediaTypeForPath(String.raw`C:\some.dir\README`)).toBeNull();
    expect(mediaTypeForPath("")).toBeNull();
  });
});
