/**
 * Unit tests for shared.ts — section normalization, URL building, text extraction, and
 * heading-section splitting.
 */

import { describe, expect, test } from "bun:test";
import {
  DEFAULT_FIELDS,
  entryUrl,
  jxTreeToText,
  normalizeSearchConfig,
  splitSections,
} from "../src/shared";
import type { JxElement } from "@jxsuite/schema/types";

describe("normalizeSearchConfig", () => {
  test("applies engine/output/collection defaults", () => {
    const config = normalizeSearchConfig({ collections: { docs: { basePath: "/docs/" } } });
    expect(config.engine).toBe("minisearch");
    expect(config.output).toBe("/search-index.json");
    expect(config.collections.docs).toEqual({
      basePath: "/docs/",
      boost: {},
      fields: DEFAULT_FIELDS,
      sectionDepth: 3,
      sections: true,
    });
  });

  test("normalizes basePath to leading and trailing slashes", () => {
    const config = normalizeSearchConfig({ collections: { blog: { basePath: "blog" } } });
    expect(config.collections.blog!.basePath).toBe("/blog/");
  });

  test("preserves explicit settings", () => {
    const config = normalizeSearchConfig({
      collections: {
        docs: {
          basePath: "/d/",
          boost: { title: 4 },
          fields: ["title"],
          sectionDepth: 2,
          sections: false,
        },
      },
      engine: "minisearch",
      output: "/idx.json",
    });
    expect(config.output).toBe("/idx.json");
    expect(config.collections.docs).toEqual({
      basePath: "/d/",
      boost: { title: 4 },
      fields: ["title"],
      sectionDepth: 2,
      sections: false,
    });
  });

  test("tolerates a null/empty section", () => {
    expect(normalizeSearchConfig(null).collections).toEqual({});
    expect(normalizeSearchConfig().output).toBe("/search-index.json");
  });
});

describe("entryUrl", () => {
  test("honors trailingSlash always and never", () => {
    expect(entryUrl("/docs/", "framework/site", "always")).toBe("/docs/framework/site/");
    expect(entryUrl("/docs/", "framework/site", "never")).toBe("/docs/framework/site");
  });
});

describe("jxTreeToText", () => {
  test("concatenates strings, textContent, and nested children with collapsed whitespace", () => {
    const tree: (JxElement | string)[] = [
      { tagName: "p", textContent: "Hello   world" },
      "loose",
      { children: [{ tagName: "code", textContent: "jx build" }, " runs"], tagName: "p" },
    ];
    expect(jxTreeToText(tree)).toBe("Hello world loose jx build runs");
  });

  test("empty and undefined trees yield empty text", () => {
    expect(jxTreeToText([])).toBe("");
    expect(jxTreeToText()).toBe("");
  });
});

describe("splitSections", () => {
  const tree: (JxElement | string)[] = [
    { tagName: "p", textContent: "Preamble text." },
    { id: "install", tagName: "h2", textContent: "Install" },
    "loose text inside a section",
    { tagName: "p", textContent: "Run bun install." },
    { id: "usage", tagName: "h2", textContent: "Usage" },
    { tagName: "p", textContent: "Import the client." },
    { id: "advanced-tips", tagName: "h4", textContent: "Advanced tips" },
    { tagName: "p", textContent: "Tune the boosts." },
  ];

  test("splits at headings within sectionDepth; preamble belongs to no section", () => {
    const sections = splitSections(tree, 3);
    expect(sections.map((s) => s.anchor)).toEqual(["install", "usage"]);
    expect(sections[0]).toEqual({
      anchor: "install",
      depth: 2,
      heading: "Install",
      text: "loose text inside a section Run bun install.",
    });
    // The h4 exceeds sectionDepth, so its heading + text stay inside "Usage".
    expect(sections[1]!.text).toBe("Import the client. Advanced tips Tune the boosts.");
  });

  test("a larger sectionDepth promotes deeper headings to their own sections", () => {
    const sections = splitSections(tree, 4);
    expect(sections.map((s) => s.anchor)).toEqual(["install", "usage", "advanced-tips"]);
    expect(sections[2]!.text).toBe("Tune the boosts.");
  });

  test("headings without an id never start a section", () => {
    const anonymous: (JxElement | string)[] = [
      { tagName: "h2", textContent: "No anchor" },
      { tagName: "p", textContent: "text" },
    ];
    expect(splitSections(anonymous, 3)).toEqual([]);
  });

  test("empty tree yields no sections", () => {
    expect(splitSections(undefined, 3)).toEqual([]);
  });
});
