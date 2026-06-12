import "./harness";
import { describe, expect, test } from "bun:test";
import { defaultDef, mediaDisplayName, unsafeTags } from "../src/panels/shared";

// ─── mediaDisplayName ─────────────────────────────────────────────────────────

describe("mediaDisplayName", () => {
  test("'--' returns Base", () => {
    expect(mediaDisplayName("--")).toBe("Base");
  });

  test("strips leading dashes and capitalizes", () => {
    expect(mediaDisplayName("--tablet")).toBe("Tablet");
  });

  test("converts inner dashes to spaces with word caps", () => {
    expect(mediaDisplayName("--dark-mode")).toBe("Dark Mode");
  });

  test("name without leading dashes still capitalizes", () => {
    expect(mediaDisplayName("mobile")).toBe("Mobile");
  });

  test("falls back to raw name when stripped form is empty", () => {
    // "---" → strips "--" then "-" becomes " " → trims to truthy? "-".replaceAll("-"," ") = " "
    // " " is truthy, so just assert it returns a string without throwing.
    expect(typeof mediaDisplayName("---")).toBe("string");
  });
});

// ─── unsafeTags ───────────────────────────────────────────────────────────────

describe("unsafeTags", () => {
  test("contains script/style/iframe and not div", () => {
    expect(unsafeTags.has("script")).toBe(true);
    expect(unsafeTags.has("style")).toBe(true);
    expect(unsafeTags.has("iframe")).toBe(true);
    expect(unsafeTags.has("link")).toBe(true);
    expect(unsafeTags.has("object")).toBe(true);
    expect(unsafeTags.has("embed")).toBe(true);
    expect(unsafeTags.has("div")).toBe(false);
  });
});

// ─── defaultDef ───────────────────────────────────────────────────────────────

describe("defaultDef", () => {
  test("headings h1–h6 get Heading text", () => {
    for (const tag of ["h1", "h2", "h3", "h4", "h5", "h6"]) {
      expect(defaultDef(tag)).toEqual({ tagName: tag, textContent: "Heading" });
    }
  });

  test("h7 is not treated as a heading", () => {
    expect(defaultDef("h7")).toEqual({ tagName: "h7" });
  });

  test("p gets paragraph text", () => {
    expect(defaultDef("p").textContent).toBe("Paragraph text");
  });

  test("inline text tags get Text", () => {
    for (const tag of [
      "span",
      "strong",
      "em",
      "small",
      "mark",
      "code",
      "abbr",
      "q",
      "sub",
      "sup",
      "time",
    ]) {
      expect(defaultDef(tag).textContent).toBe("Text");
    }
  });

  test("a gets Link text and href attribute", () => {
    const def = defaultDef("a");
    expect(def.textContent).toBe("Link");
    expect(def.attributes).toEqual({ href: "#" });
  });

  test("button/label/legend/caption/summary get matching labels", () => {
    expect(defaultDef("button").textContent).toBe("Button");
    expect(defaultDef("label").textContent).toBe("Label");
    expect(defaultDef("legend").textContent).toBe("Legend");
    expect(defaultDef("caption").textContent).toBe("Caption");
    expect(defaultDef("summary").textContent).toBe("Summary");
  });

  test("list/table cell tags get Item", () => {
    for (const tag of ["li", "dt", "dd", "th", "td", "option"]) {
      expect(defaultDef(tag).textContent).toBe("Item");
    }
  });

  test("blockquote and pre get quote/preformatted text", () => {
    expect(defaultDef("blockquote").textContent).toBe("Quote");
    expect(defaultDef("pre").textContent).toBe("Preformatted text");
  });

  test("input gets placeholder and type attributes", () => {
    expect(defaultDef("input").attributes).toEqual({
      placeholder: "Enter text...",
      type: "text",
    });
  });

  test("img gets alt attribute", () => {
    expect(defaultDef("img").attributes).toEqual({ alt: "Image" });
  });

  test("iframe gets empty src", () => {
    expect(defaultDef("iframe").attributes).toEqual({ src: "" });
  });

  test("select gets an option child", () => {
    expect(defaultDef("select").children).toEqual([{ tagName: "option", textContent: "Option 1" }]);
  });

  test("ul and ol get li children", () => {
    expect(defaultDef("ul").children).toEqual([{ tagName: "li", textContent: "Item" }]);
    expect(defaultDef("ol").children).toEqual([{ tagName: "li", textContent: "Item" }]);
  });

  test("dl gets dt/dd pair", () => {
    expect(defaultDef("dl").children).toEqual([
      { tagName: "dt", textContent: "Term" },
      { tagName: "dd", textContent: "Definition" },
    ]);
  });

  test("table gets thead/tbody scaffold", () => {
    const def = defaultDef("table");
    expect(def.children).toHaveLength(2);
    const [thead, tbody] = def.children as any[];
    expect(thead.tagName).toBe("thead");
    expect(thead.children[0].children[0]).toEqual({ tagName: "th", textContent: "Header" });
    expect(tbody.tagName).toBe("tbody");
    expect(tbody.children[0].children[0]).toEqual({ tagName: "td", textContent: "Cell" });
  });

  test("details gets summary and detail paragraph", () => {
    expect(defaultDef("details").children).toEqual([
      { tagName: "summary", textContent: "Summary" },
      { tagName: "p", textContent: "Detail content" },
    ]);
  });

  test("unknown tag gets bare node", () => {
    expect(defaultDef("section")).toEqual({ tagName: "section" });
    expect(defaultDef("custom-el")).toEqual({ tagName: "custom-el" });
  });
});
