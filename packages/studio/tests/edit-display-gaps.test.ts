/** Gap coverage for src/utils/edit-display.ts — edit-mode display transforms. */
import "./harness";
import { describe, expect, test } from "bun:test";
import {
  computeEmptyPlaceholderClass,
  EMPTY_PLACEHOLDER_CLASSES,
  prepareForEditMode,
  restoreTemplateExpressions,
  templateToEditDisplay,
} from "../src/utils/edit-display";
import type { JxMutableNode } from "@jxsuite/schema/types";

const TRANSPARENT_PX =
  "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

const prep = (node: unknown) => prepareForEditMode(node as JxMutableNode) as Record<string, any>;

// ─── computeEmptyPlaceholderClass ─────────────────────────────────────────────

describe("computeEmptyPlaceholderClass", () => {
  test("empty text tag gets text placeholder", () => {
    expect(computeEmptyPlaceholderClass({ tagName: "p" } as JxMutableNode)).toBe(
      "empty-text-placeholder",
    );
  });

  test("empty container tag gets container placeholder", () => {
    expect(computeEmptyPlaceholderClass({ tagName: "section" } as JxMutableNode)).toBe(
      "empty-container-placeholder",
    );
  });

  test("returns null without tagName", () => {
    expect(computeEmptyPlaceholderClass({} as JxMutableNode)).toBeNull();
  });

  test("returns null when textContent present", () => {
    expect(
      computeEmptyPlaceholderClass({ tagName: "p", textContent: "hi" } as JxMutableNode),
    ).toBeNull();
  });

  test("returns null when innerHTML present", () => {
    expect(
      computeEmptyPlaceholderClass({ innerHTML: "<b>x</b>", tagName: "p" } as JxMutableNode),
    ).toBeNull();
  });

  test("returns null when children non-empty", () => {
    expect(
      computeEmptyPlaceholderClass({
        children: [{ tagName: "span" }],
        tagName: "div",
      } as JxMutableNode),
    ).toBeNull();
  });

  test("empty children array still counts as empty", () => {
    expect(computeEmptyPlaceholderClass({ children: [], tagName: "div" } as JxMutableNode)).toBe(
      "empty-container-placeholder",
    );
  });

  test("non-text non-container tag returns null", () => {
    expect(computeEmptyPlaceholderClass({ tagName: "img" } as JxMutableNode)).toBeNull();
  });

  test("layout-originated empty text tag returns null", () => {
    expect(
      computeEmptyPlaceholderClass({ $__layout: true, tagName: "span" } as JxMutableNode),
    ).toBeNull();
  });

  test("layout-originated empty container tag returns null", () => {
    expect(
      computeEmptyPlaceholderClass({ $__layout: true, tagName: "div" } as JxMutableNode),
    ).toBeNull();
  });

  test("exported placeholder class list matches the two classes", () => {
    expect([...EMPTY_PLACEHOLDER_CLASSES]).toEqual([
      "empty-text-placeholder",
      "empty-container-placeholder",
    ]);
  });
});

// ─── templateToEditDisplay / restoreTemplateExpressions ──────────────────────

describe("template display round-trip", () => {
  test("templateToEditDisplay wraps expressions in display brackets", () => {
    expect(templateToEditDisplay("Hello ${name}!")).toBe("Hello ❪ name ❫!");
  });

  test("handles multiple expressions", () => {
    expect(templateToEditDisplay("${a} and ${b}")).toBe("❪ a ❫ and ❪ b ❫");
  });

  test("leaves plain strings untouched", () => {
    expect(templateToEditDisplay("plain")).toBe("plain");
  });

  test("restoreTemplateExpressions converts display brackets back in text nodes", () => {
    const el = document.createElement("div");
    el.textContent = "Hello ❪ name ❫!";
    restoreTemplateExpressions(el);
    expect(el.textContent).toBe("Hello ${name}!");
  });

  test("restores expressions inside nested elements", () => {
    const el = document.createElement("div");
    const span = document.createElement("span");
    span.textContent = "❪ a.b ❫";
    el.append(document.createTextNode("plain "), span);
    restoreTemplateExpressions(el);
    expect(span.textContent).toBe("${a.b}");
    expect(el.textContent).toBe("plain ${a.b}");
  });
});

// ─── prepareForEditMode ───────────────────────────────────────────────────────

describe("prepareForEditMode basics", () => {
  test("returns primitives unchanged", () => {
    expect(prepareForEditMode("text" as unknown as JxMutableNode)).toBe(
      "text" as unknown as JxMutableNode,
    );
    expect(prepareForEditMode(null as unknown as JxMutableNode)).toBeNull();
  });

  test("maps arrays element-wise", () => {
    const out = prepareForEditMode([
      { tagName: "p", textContent: "${x}" },
    ] as unknown as JxMutableNode) as unknown as Record<string, any>[];
    expect(Array.isArray(out)).toBe(true);
    expect(out[0].textContent).toBe("❪ x ❫");
  });

  test("preserves state, $media and $elements untouched", () => {
    const state = { count: { default: 1 } };
    const $media = { md: "(min-width: 768px)" };
    const $elements = { "x-c": "./x.json" };
    const out = prep({ $elements, $media, state, tagName: "div", textContent: "x" });
    expect(out.state).toBe(state);
    expect(out.$media).toBe($media);
    expect(out.$elements).toBe($elements);
  });

  test("converts template textContent to display form", () => {
    const out = prep({ tagName: "p", textContent: "Hi ${user}" });
    expect(out.textContent).toBe("Hi ❪ user ❫");
  });

  test("blanks template strings in url attributes (href/action)", () => {
    const a = prep({ href: "${url}", tagName: "a", textContent: "go" });
    expect(a.href).toBe("");
    const form = prep({ action: "${ep}", tagName: "form", textContent: "f" });
    expect(form.action).toBe("");
  });

  test("$ref top-level value becomes display label", () => {
    const out = prep({ tagName: "p", textContent: { $ref: "#/state/title" } });
    expect(out.textContent).toBe("{title}");
  });

  test("$ref outside #/state/ keeps full path label", () => {
    const out = prep({ tagName: "p", textContent: { $ref: "#/$defs/foo" } });
    expect(out.textContent).toBe("{#/$defs/foo}");
  });
});

describe("prepareForEditMode $props", () => {
  test("processes template strings, url props, refs and passthrough values", () => {
    const out = prep({
      $props: {
        label: "${t}",
        link: { $ref: "#/state/url" },
        other: { $ref: "raw.path" },
        plain: 5,
        src: "${s}",
      },
      tagName: "x-card",
    });
    expect(out.$props.label).toBe("❪ t ❫");
    expect(out.$props.src).toBe("");
    expect(out.$props.link).toBe("{url}");
    expect(out.$props.other).toBe("{raw.path}");
    expect(out.$props.plain).toBe(5);
  });
});

describe("prepareForEditMode children", () => {
  test("recurses into array children", () => {
    const out = prep({
      children: [{ tagName: "p", textContent: "${a}" }],
      tagName: "div",
    });
    expect(out.children[0].textContent).toBe("❪ a ❫");
  });

  test("wraps mapped-array children in a repeater perimeter", () => {
    const out = prep({
      children: {
        $prototype: "Array",
        map: { tagName: "li", textContent: "${item}" },
      },
      tagName: "ul",
    });
    expect(out.children).toHaveLength(1);
    expect(out.children[0].className).toBe("repeater-perimeter");
    expect(out.children[0].tagName).toBe("div");
    expect(out.children[0].children[0].textContent).toBe("❪ item ❫");
  });

  test("mapped-array children without a template become empty", () => {
    const out = prep({
      children: { $prototype: "Array" },
      tagName: "ul",
    });
    expect(out.children).toEqual([]);
  });

  test("single object children recurse", () => {
    const out = prep({
      children: { tagName: "span", textContent: "${x}" },
      tagName: "div",
    });
    expect(out.children.textContent).toBe("❪ x ❫");
  });
});

describe("prepareForEditMode $switch cases", () => {
  test("renders first case inline when it is a plain node", () => {
    const out = prep({
      $switch: "${mode}",
      cases: {
        edit: { tagName: "section", textContent: "Edit" },
        view: { tagName: "p", textContent: "View" },
      },
      tagName: "div",
    });
    expect(out.$switch).toBe("❪ mode ❫");
    expect(out.children[0].tagName).toBe("section");
    expect(out.children[0].textContent).toBe("Edit");
    expect(out.cases).toBeUndefined();
  });

  test("renders placeholder when first case is a $ref", () => {
    const out = prep({
      $switch: "${page}",
      cases: {
        about: { $ref: "./about.json" },
        home: { $ref: "./home.json" },
      },
      tagName: "div",
    });
    expect(out.children).toHaveLength(1);
    expect(out.children[0].textContent).toBe("[$switch: about | home]");
    expect(out.children[0].style.color).toBe("var(--danger)");
  });

  test("empty cases object leaves children unset", () => {
    const out = prep({ $switch: "${x}", cases: {}, tagName: "div" });
    expect(out.children).toBeUndefined();
  });
});

describe("prepareForEditMode media elements", () => {
  test("empty src gets transparent pixel and media placeholder class", () => {
    const out = prep({ src: "", tagName: "img" });
    expect(out.src).toBe(TRANSPARENT_PX);
    expect(out.className).toBe("empty-media-placeholder");
  });

  test("template src gets transparent pixel", () => {
    const out = prep({ src: "${url}", tagName: "video" });
    expect(out.src).toBe(TRANSPARENT_PX);
    expect(out.className).toContain("empty-media-placeholder");
  });

  test("$ref src gets transparent pixel", () => {
    const out = prep({ src: { $ref: "#/state/cover" }, tagName: "img" });
    expect(out.src).toBe(TRANSPARENT_PX);
    expect(out.className).toContain("empty-media-placeholder");
  });

  test("media element with no src at all gets placeholder class", () => {
    const out = prep({ tagName: "img" });
    expect(out.className).toBe("empty-media-placeholder");
  });

  test("media element with a real src keeps it and gets no placeholder", () => {
    const out = prep({ src: "/photo.png", tagName: "img" });
    expect(out.src).toBe("/photo.png");
    expect(out.className).toBeUndefined();
  });

  test("poster in attributes counts as resolvable media source", () => {
    const out = prep({ attributes: { poster: "/poster.jpg" }, tagName: "video" });
    expect(out.attributes.poster).toBe("/poster.jpg");
    expect(out.className).toBeUndefined();
  });

  test("attributes: template src replaced, other templates displayed, refs labelled", () => {
    const out = prep({
      attributes: {
        alt: { $ref: "#/state/altText" },
        "data-cap": "${caption}",
        href: "${u}",
        src: "${url}",
      },
      tagName: "img",
    });
    expect(out.attributes.src).toBe(TRANSPARENT_PX);
    expect(out.attributes["data-cap"]).toBe("❪ caption ❫");
    expect(out.attributes.href).toBe("");
    expect(out.attributes.alt).toBe("{altText}");
    expect(out.className).toContain("empty-media-placeholder");
  });

  test("attributes: empty src replaced with pixel", () => {
    const out = prep({ attributes: { src: "" }, tagName: "img" });
    expect(out.attributes.src).toBe(TRANSPARENT_PX);
  });

  test("does not duplicate the media placeholder class", () => {
    const out = prep({ className: "empty-media-placeholder", src: "", tagName: "img" });
    expect(out.className).toBe("empty-media-placeholder");
  });
});

describe("prepareForEditMode style handling", () => {
  test("blanks template strings in style values, keeps the rest", () => {
    const out = prep({
      style: { color: "red", width: "${w}px" },
      tagName: "div",
      textContent: "x",
    });
    expect(out.style.color).toBe("red");
    expect(out.style.width).toBe("");
  });

  test("non-object style passes through", () => {
    const out = prep({ style: null, tagName: "div", textContent: "x" });
    expect(out.style).toBeNull();
  });
});

describe("prepareForEditMode empty placeholders", () => {
  test("empty text tag gains placeholder class merged with existing className", () => {
    const out = prep({ className: "lead", tagName: "p" });
    expect(out.className).toBe("lead empty-text-placeholder");
  });

  test("empty container without className gets bare placeholder class", () => {
    const out = prep({ tagName: "section" });
    expect(out.className).toBe("empty-container-placeholder");
  });

  test("layout-marked empty elements get no placeholder class", () => {
    // Regression: decorative hamburger-bar spans in a page's layout shell rendered
    // Overlapping "Click here to add text..." placeholders.
    const out = prep({
      $__layout: true,
      children: [
        { $__layout: true, style: { height: "3px" }, tagName: "span" },
        { $__layout: true, style: { height: "3px" }, tagName: "span" },
        { $__layout: true, style: { height: "3px" }, tagName: "span" },
      ],
      tagName: "button",
    });
    for (const bar of out.children) {
      expect(bar.className).toBeUndefined();
      expect(bar.$__layout).toBe(true);
    }
  });

  test("identical non-layout empty span still gets text placeholder", () => {
    const out = prep({ style: { height: "3px" }, tagName: "span" });
    expect(out.className).toBe("empty-text-placeholder");
  });
});
