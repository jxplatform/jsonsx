import "./with-dom.js";
import { describe, expect, test } from "bun:test";
import {
  abbreviateValue,
  attrLabel,
  camelToKebab,
  camelToLabel,
  findContentTypeSchema,
  friendlyNameToVar,
  inferInputType,
  isMediaFormat,
  kebabToLabel,
  propLabel,
  varDisplayName,
} from "../src/utils/studio-utils";

// ─── camelToKebab ────────────────────────────────────────────────────────────

describe("camelToKebab", () => {
  test("single word unchanged", () => {
    expect(camelToKebab("color")).toBe("color");
  });

  test("converts camelCase", () => {
    expect(camelToKebab("backgroundColor")).toBe("background-color");
  });

  test("multiple humps", () => {
    expect(camelToKebab("marginTopLeft")).toBe("margin-top-left");
  });

  test("already kebab (no uppercase)", () => {
    expect(camelToKebab("font-size")).toBe("font-size");
  });

  test("single char prefix", () => {
    expect(camelToKebab("zIndex")).toBe("z-index");
  });
});

// ─── camelToLabel ────────────────────────────────────────────────────────────

describe("camelToLabel", () => {
  test("simple property", () => {
    expect(camelToLabel("color")).toBe("Color");
  });

  test("camelCase to spaced", () => {
    expect(camelToLabel("backgroundColor")).toBe("Background Color");
  });

  test("multiple humps", () => {
    expect(camelToLabel("marginTopLeft")).toBe("Margin Top Left");
  });

  test("single char prefix", () => {
    expect(camelToLabel("zIndex")).toBe("Z Index");
  });

  test("all lowercase", () => {
    expect(camelToLabel("display")).toBe("Display");
  });
});

// ─── kebabToLabel ────────────────────────────────────────────────────────────

describe("kebabToLabel", () => {
  test("simple value", () => {
    expect(kebabToLabel("auto")).toBe("Auto");
  });

  test("kebab-case", () => {
    expect(kebabToLabel("border-box")).toBe("Border Box");
  });

  test("multiple dashes", () => {
    expect(kebabToLabel("flex-start")).toBe("Flex Start");
  });

  test("three segments", () => {
    expect(kebabToLabel("inline-flex-box")).toBe("Inline Flex Box");
  });

  test("small-caps", () => {
    expect(kebabToLabel("small-caps")).toBe("Small Caps");
  });
});

// ─── propLabel ───────────────────────────────────────────────────────────────

describe("propLabel", () => {
  test("returns $label when present", () => {
    expect(propLabel({ $label: "Font Size" }, "fontSize")).toBe("Font Size");
  });

  test("falls back to camelToLabel", () => {
    expect(propLabel({}, "backgroundColor")).toBe("Background Color");
  });

  test("handles null entry", () => {
    expect(propLabel(null, "color")).toBe("Color");
  });
});

// ─── attrLabel ───────────────────────────────────────────────────────────────

describe("attrLabel", () => {
  test("returns $label when present", () => {
    expect(attrLabel({ $label: "ID" }, "id")).toBe("ID");
  });

  test("converts kebab-case attribute", () => {
    expect(attrLabel({}, "aria-label")).toBe("Aria Label");
  });

  test("converts kebab-case with multiple dashes", () => {
    expect(attrLabel(null, "data-custom-value")).toBe("Data Custom Value");
  });

  test("falls back to camelToLabel for non-kebab", () => {
    expect(attrLabel({}, "tabindex")).toBe("Tabindex");
  });

  test("handles entry with no $label and camelCase", () => {
    expect(attrLabel({}, "maxLength")).toBe("Max Length");
  });
});

// ─── abbreviateValue ─────────────────────────────────────────────────────────

describe("abbreviateValue", () => {
  test("known abbreviations", () => {
    expect(abbreviateValue("inline")).toBe("inl");
    expect(abbreviateValue("flex-start")).toBe("start");
    expect(abbreviateValue("space-between")).toBe("betw");
    expect(abbreviateValue("column")).toBe("col");
    expect(abbreviateValue("baseline")).toBe("base");
  });

  test("unknown values returned as-is", () => {
    expect(abbreviateValue("center")).toBe("center");
    expect(abbreviateValue("flex")).toBe("flex");
    expect(abbreviateValue("grid")).toBe("grid");
  });

  test("reverse variants", () => {
    expect(abbreviateValue("row-reverse")).toBe("row-r");
    expect(abbreviateValue("column-reverse")).toBe("col-r");
  });
});

// ─── isMediaFormat ───────────────────────────────────────────────────────────

/**
 * Two spellings for one thing, and both are real: `"uri-reference"` is JSON Schema's own and the
 * one the SPEC uses (it is what `rewriteEntryAssets` keys its asset rewrite on), while `"image"` is
 * Studio's shorthand for component props and settings schemas.
 *
 * They used to be accepted in DIFFERENT places, so which editor a field got depended on which panel
 * was asking: a frontmatter field declared the documented way got a plain text box while the same
 * declaration in the properties panel got a media picker.
 */
describe("isMediaFormat", () => {
  test("accepts both spellings", () => {
    expect(isMediaFormat("image")).toBe(true);
    expect(isMediaFormat("uri-reference")).toBe(true);
  });

  test("and nothing else", () => {
    for (const format of ["color", "date", "date-time", "uri", "", undefined, null, 0]) {
      expect(isMediaFormat(format)).toBe(false);
    }
  });
});

// ─── inferInputType ──────────────────────────────────────────────────────────

describe("inferInputType", () => {
  test("media, in either spelling", () => {
    expect(inferInputType({ format: "image" })).toBe("media");
    expect(inferInputType({ format: "uri-reference" })).toBe("media");
    expect(inferInputType({ $input: "media" })).toBe("media");
  });

  test("shorthand", () => {
    expect(inferInputType({ $shorthand: true })).toBe("shorthand");
  });

  test("button-group", () => {
    expect(inferInputType({ $input: "button-group" })).toBe("button-group");
  });

  test("color", () => {
    expect(inferInputType({ format: "color" })).toBe("color");
  });

  test("number-unit", () => {
    expect(inferInputType({ $units: ["px", "rem"] })).toBe("number-unit");
  });

  test("number", () => {
    expect(inferInputType({ type: "number" })).toBe("number");
  });

  test("select (enum)", () => {
    expect(inferInputType({ enum: ["a", "b"] })).toBe("select");
  });

  test("combobox (examples)", () => {
    expect(inferInputType({ examples: ["serif", "sans-serif"] })).toBe("combobox");
  });

  test("combobox (presets)", () => {
    expect(inferInputType({ presets: [{ label: "A", value: "a" }] })).toBe("combobox");
  });

  test("text (default)", () => {
    expect(inferInputType({ type: "string" })).toBe("text");
  });

  test("priority: shorthand > button-group > color > number-unit", () => {
    // Shorthand wins over everything
    expect(
      inferInputType({
        $input: "button-group",
        $shorthand: true,
        format: "color",
      }),
    ).toBe("shorthand");
    // Button-group wins over color
    expect(inferInputType({ $input: "button-group", format: "color" })).toBe("button-group");
    // Color wins over number-unit
    expect(inferInputType({ $units: ["px"], format: "color" })).toBe("color");
  });
});

// ─── friendlyNameToVar ──────────────────────────────────────────────────────

describe("friendlyNameToVar", () => {
  test("converts display name to CSS variable", () => {
    expect(friendlyNameToVar("Geometric Humanist", "--font-")).toBe("--font-geometric-humanist");
  });

  test("handles single word", () => {
    expect(friendlyNameToVar("Monospace", "--font-")).toBe("--font-monospace");
  });

  test("handles multiple spaces", () => {
    expect(friendlyNameToVar("Old  Style", "--font-")).toBe("--font-old-style");
  });

  test("strips special characters", () => {
    expect(friendlyNameToVar("Neo-Grotesque!", "--font-")).toBe("--font-neo-grotesque");
  });

  test("trims whitespace", () => {
    expect(friendlyNameToVar("  System UI  ", "--font-")).toBe("--font-system-ui");
  });

  test("returns empty string for empty input", () => {
    expect(friendlyNameToVar("", "--font-")).toBe("");
  });

  test("works with different prefixes", () => {
    expect(friendlyNameToVar("Primary Blue", "--color-")).toBe("--color-primary-blue");
  });
});

// ─── varDisplayName ─────────────────────────────────────────────────────────

describe("varDisplayName", () => {
  test("converts CSS variable back to display name", () => {
    expect(varDisplayName("--font-geometric-humanist", "--font-")).toBe("Geometric Humanist");
  });

  test("handles single word", () => {
    expect(varDisplayName("--font-monospace", "--font-")).toBe("Monospace");
  });

  test("roundtrips with friendlyNameToVar for single-cased names", () => {
    // VarDisplayName uses Title Case (\b\w), so acronyms like "UI" become "Ui"
    // This is fine — preset matching uses title directly, not reconstructed names
    const names = ["Geometric Humanist", "Old Style", "Classical Humanist"];
    for (const name of names) {
      const varName = friendlyNameToVar(name, "--font-");
      expect(varDisplayName(varName, "--font-")).toBe(name);
    }
  });

  test("title-cases each word (acronyms become title case)", () => {
    // "System UI" → --font-system-ui → "System Ui"
    expect(varDisplayName("--font-system-ui", "--font-")).toBe("System Ui");
  });

  test("returns original if prefix doesn't match", () => {
    expect(varDisplayName("--color-blue", "--font-")).toBe("Color Blue");
  });
});

// ─── findContentTypeSchema ───────────────────────────────────────────────────

/**
 * Which content type owns a document, and therefore which schema its frontmatter is edited against.
 *
 * A `{locale}` source is N directories and ONE content type — a translation is the same post, with
 * the same schema. The placeholder used to be compared literally, so `content/posts/{locale}` was
 * tested as a path prefix nobody has ever had and a translated entry showed no frontmatter fields
 * at all.
 */
describe("findContentTypeSchema", () => {
  const SCHEMA = { properties: { hero: { format: "uri-reference", type: "string" } } };
  const config = (source: string) => ({
    content: { posts: { format: "json", schema: SCHEMA, source } },
  });

  test("a plain directory source", () => {
    expect(findContentTypeSchema("content/posts/hello.json", config("./content/posts"))).toEqual({
      name: "posts",
      schema: SCHEMA,
    });
    expect(findContentTypeSchema("pages/index.json", config("./content/posts"))).toBeNull();
  });

  test("a localized source matches any locale directory under it", () => {
    const c = config("./content/posts/{locale}");
    expect(findContentTypeSchema("content/posts/fr/hello.json", c)?.name).toBe("posts");
    expect(findContentTypeSchema("content/posts/en-US/hello.json", c)?.name).toBe("posts");
  });

  test("and not the collection root, which holds no entries", () => {
    expect(
      findContentTypeSchema("content/posts/hello.json", config("./content/posts/{locale}")),
    ).toBeNull();
  });

  test("a single-file source is matched as a file, not as a prefix", () => {
    expect(findContentTypeSchema("data/site.json", config("./data/site.json"))?.name).toBe("posts");
  });

  test("no document and no content section answer nothing", () => {
    expect(findContentTypeSchema(null, config("./content/posts"))).toBeNull();
    expect(findContentTypeSchema("content/posts/a.json", {})).toBeNull();
  });
});
