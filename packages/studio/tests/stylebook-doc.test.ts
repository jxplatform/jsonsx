/**
 * Stylebook specimen-document generator (src/panels/stylebook-doc.ts) — the pure functions that
 * turn the element catalog + component registry + effective style into a JxDocument the iframe
 * canvas renders. Covers the two load-bearing style transforms (selector.@media hoisting, tag-rule
 * re-keying under the specimen scope) and the path↔tag maps that drive hit decoding.
 */
import "./with-dom.js";
import { describe, expect, test } from "bun:test";
import {
  buildStylebookDoc,
  hasTagStyle,
  transposeStylebookStyle,
} from "../src/panels/stylebook-doc";
import { serializeJxPath } from "../src/canvas/path-mapping";
import type { StylebookEntry } from "../src/panels/stylebook-panel";
import type { ComponentEntry } from "../src/files/components";
import type { JxMutableNode, JxStyle } from "@jxsuite/schema/types";

const META = {
  $sections: [
    {
      elements: [
        { tag: "h1", text: "Heading" },
        { tag: "p", text: "Paragraph" },
      ] as StylebookEntry[],
      label: "Text",
    },
    {
      elements: [
        {
          children: [
            { tag: "li", text: "One" },
            { tag: "li", text: "Two" },
          ],
          tag: "ul",
        },
      ] as StylebookEntry[],
      label: "List",
    },
  ],
};

function build(overrides: Partial<Parameters<typeof buildStylebookDoc>[0]> = {}) {
  return buildStylebookDoc({
    components: [],
    customizedOnly: false,
    effectiveMedia: { "--md": "(max-width: 768px)" },
    effectiveStyle: {} as JxStyle,
    filter: "",
    meta: META,
    projectRoot: "examples",
    ...overrides,
  });
}

const kids = (n: JxMutableNode) => n.children as JxMutableNode[];
const cls = (n: JxMutableNode) => (n.attributes as Record<string, string>).class;

describe("buildStylebookDoc — tree shape", () => {
  test("root carries sb-root, $media, and the transposed style; sections wrap labelled card bodies", () => {
    const { doc } = build({ effectiveStyle: { h1: { color: "red" } } as JxStyle });
    expect(cls(doc)).toBe("sb-root");
    expect((doc as { $media?: unknown }).$media).toEqual({ "--md": "(max-width: 768px)" });
    expect((doc.style as Record<string, unknown>)["& .element-card-preview h1"]).toEqual({
      color: "red",
    });

    const [textSection, listSection] = kids(doc);
    expect(cls(textSection!)).toBe("sb-section");
    expect(kids(textSection!)[0]!.textContent).toBe("Text");
    const body = kids(textSection!)[1]!;
    expect(cls(body)).toBe("sb-body");
    const card = kids(body)[0]!;
    expect(cls(card)).toBe("element-card");
    const preview = kids(card)[0]!;
    expect(cls(preview)).toBe("element-card-preview");
    expect(kids(preview)[0]).toMatchObject({ tagName: "h1", textContent: "Heading" });
    expect(kids(card)[1]).toMatchObject({ textContent: "<h1>" });
    expect(cls(kids(listSection!)[1]!)).toBe("sb-body");
  });

  test("entry attributes + inline style ride as the style ATTRIBUTE (legacy cssText parity)", () => {
    const { doc } = build({
      meta: {
        $sections: [
          {
            elements: [
              { attributes: { type: "text" }, style: "width: 40px", tag: "input" },
            ] as StylebookEntry[],
            label: "Forms",
          },
        ],
      },
    });
    const section = kids(doc)[0]!;
    const body = kids(section)[1]!;
    const card = kids(body)[0]!;
    const preview = kids(card)[0]!;
    const spec = kids(preview)[0]!;
    expect(spec.tagName).toBe("input");
    expect(spec.attributes).toEqual({ style: "width: 40px", type: "text" });
  });

  test("pathToTag maps card/preview/specimen paths; descendants get compounds; chrome is absent", () => {
    const { pathToTag, tagToCardPath } = build();
    // Section 1 ("List") → body → card 0 → preview → ul → li[0]
    const cardPath = ["children", 1, "children", 1, "children", 0];
    expect(pathToTag.get(serializeJxPath(cardPath))).toBe("ul");
    expect(pathToTag.get(serializeJxPath([...cardPath, "children", 0]))).toBe("ul");
    const ulPath = [...cardPath, "children", 0, "children", 0];
    expect(pathToTag.get(serializeJxPath(ulPath))).toBe("ul");
    expect(pathToTag.get(serializeJxPath([...ulPath, "children", 0]))).toBe("ul li");
    expect(pathToTag.get(serializeJxPath([...ulPath, "children", 1]))).toBe("ul li");
    // Chrome (section/label/body/root) paths are unmapped → hit = deselect.
    expect(pathToTag.get(serializeJxPath(["children", 1]))).toBeUndefined();
    expect(pathToTag.get(serializeJxPath([]))).toBeUndefined();
    // TagToCardPath points at the FIRST matching card.
    expect(tagToCardPath.get("ul")).toEqual(cardPath);
    expect(tagToCardPath.get("h1")).toEqual(["children", 0, "children", 1, "children", 0]);
  });

  test("filter narrows by tag or section label; customizedOnly keeps only styled tags", () => {
    const filtered = build({ filter: "h1" });
    expect(kids(filtered.doc)).toHaveLength(1);
    expect(filtered.tagToCardPath.has("ul")).toBe(false);

    const custom = build({
      customizedOnly: true,
      effectiveStyle: { "@md": { p: { color: "blue" } } } as JxStyle,
    });
    // Only <p> is customized (under a media block — hasTagStyle looks there too).
    expect(custom.tagToCardPath.has("p")).toBe(true);
    expect(custom.tagToCardPath.has("h1")).toBe(false);
  });

  test("empty result renders the sb-empty message node", () => {
    const none = build({ filter: "zzz-none" });
    expect(kids(none.doc)).toHaveLength(1);
    expect(cls(kids(none.doc)[0]!)).toBe("sb-empty");
    const customized = build({ customizedOnly: true, filter: "zzz-none" });
    expect(kids(customized.doc)[0]!.textContent).toBe("No customized elements");
  });

  test("project JSON components emit $elements refs + prop-default specimens; npm falls back", () => {
    const components: ComponentEntry[] = [
      {
        path: "components/user-card.json",
        props: [
          { default: "'Jane'", name: "name" },
          { default: "false", name: "compact" },
        ],
        source: "local",
        tagName: "user-card",
      } as never,
      { package: "sl", source: "npm", tagName: "sl-button" } as never,
    ];
    const { doc, tagToCardPath } = build({ components });
    expect((doc as { $elements?: unknown[] }).$elements).toEqual([
      { $ref: "/examples/components/user-card.json" },
    ]);
    // An ABSOLUTE projectRoot must not produce a protocol-relative "//home/…" ref.
    const absolute = build({ components, projectRoot: "/home/user/site" });
    expect((absolute.doc as { $elements?: { $ref: string }[] }).$elements?.[0]?.$ref).toBe(
      "/home/user/site/components/user-card.json",
    );
    const compSection = kids(doc).at(-1)!;
    expect(kids(compSection)[0]!.textContent).toBe("Components");
    const cards = kids(kids(compSection)[1]!);
    const userCardSpecimen = kids(kids(cards[0]!)[0]!)[0]!;
    expect(userCardSpecimen).toMatchObject({
      attributes: { name: "Jane" },
      tagName: "user-card",
    });
    const npmSpecimen = kids(kids(cards[1]!)[0]!)[0]!;
    expect(cls(npmSpecimen)).toBe("sb-fallback");
    expect(npmSpecimen.textContent).toBe("<sl-button>");
    expect(tagToCardPath.has("user-card")).toBe(true);
    expect(tagToCardPath.has("sl-button")).toBe(true);
  });
});

describe("transposeStylebookStyle", () => {
  test("keeps flat scalars + custom props at the top; re-keys tag rules under the specimen scope", () => {
    const out = transposeStylebookStyle({
      "--accent": "#f00",
      "font-family": "serif",
      h1: { "font-size": "2rem" },
      "table th": undefined as never,
      table: { th: { padding: "4px" } },
    } as JxStyle) as Record<string, unknown>;
    expect(out["--accent"]).toBe("#f00");
    expect(out["font-family"]).toBe("serif");
    expect(out["& .element-card-preview h1"]).toEqual({ "font-size": "2rem" });
    // Nested tag rules stay nested (the builder descends them relative to the re-keyed parent).
    expect(out["& .element-card-preview table"]).toEqual({ th: { padding: "4px" } });
    // No bare tag keys survive (a bare `div` rule would restyle the card chrome).
    expect(out.h1).toBeUndefined();
    expect(out.table).toBeUndefined();
  });

  test("a nested @media stays where the author wrote it — the hoist is gone", () => {
    /* This used to hoist `selector → @media` into the top-level `@media → selector` block, because
       the runtime emitted only the latter. The runtime composes both orders now, so the workaround
       became a rewrite of the author's own structure for no reason. */
    const out = transposeStylebookStyle({
      h1: { "@md": { color: "green" }, color: "red" },
      ul: { li: { "@md": { margin: "0" } } },
    } as JxStyle) as Record<string, unknown>;
    expect(out["& .element-card-preview h1"]).toEqual({ "@md": { color: "green" }, color: "red" });
    expect(out["& .element-card-preview ul"]).toEqual({ li: { "@md": { margin: "0" } } });
    expect(out["@md"]).toBeUndefined();
  });

  test("a top-level @media block still re-keys the tag rules inside it", () => {
    // Still needed: a bare `h1` rule on the generated root would reach the card chrome.
    const out = transposeStylebookStyle({
      "@md": { h1: { "font-weight": "700" }, "line-height": "1.4" },
    } as JxStyle) as Record<string, unknown>;
    expect(out["@md"]).toEqual({
      "& .element-card-preview h1": { "font-weight": "700" },
      "line-height": "1.4",
    });
  });

  test("pseudo/class sub-rules ride along; @-- base-width markers are dropped", () => {
    const out = transposeStylebookStyle({
      "@--": { width: "1280px" },
      a: { ":hover": { color: "blue" }, "@--": { x: "y" }, color: "navy" },
    } as JxStyle) as Record<string, unknown>;
    expect(out["& .element-card-preview a"]).toEqual({
      ":hover": { color: "blue" },
      color: "navy",
    });
    expect(out["@--"]).toBeUndefined();
  });
});

describe("hasTagStyle", () => {
  test("finds direct, compound, and media-scoped customization; misses empty rules", () => {
    const style = {
      "@md": { p: { color: "blue" } },
      table: { th: { padding: "2px" } },
      ul: {},
    } as JxStyle;
    expect(hasTagStyle(style, "table th")).toBe(true);
    expect(hasTagStyle(style, "p")).toBe(true);
    expect(hasTagStyle(style, "ul")).toBe(false);
    expect(hasTagStyle(style, "h1")).toBe(false);
  });
});
