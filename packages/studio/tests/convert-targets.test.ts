import "./with-dom.js";
import { describe, expect, test } from "bun:test";
import { getConvertTargets } from "../src/editor/convert-targets";

describe("getConvertTargets", () => {
  describe("text elements with content", () => {
    test("h1 returns other text group tags", () => {
      const targets = getConvertTargets("h1", false);
      const tags = targets.map((t) => t.tag);
      expect(tags).toContain("p");
      expect(tags).toContain("h2");
      expect(tags).toContain("h3");
      expect(tags).toContain("blockquote");
      expect(tags).not.toContain("h1");
    });

    test("p with content returns text group only", () => {
      const targets = getConvertTargets("p", false);
      const tags = targets.map((t) => t.tag);
      expect(tags).toContain("h1");
      expect(tags).toContain("h2");
      expect(tags).toContain("blockquote");
      expect(tags).not.toContain("p");
      expect(tags).not.toContain("div");
      expect(tags).not.toContain("section");
    });

    test("h2 excludes itself", () => {
      const targets = getConvertTargets("h2", false);
      const tags = targets.map((t) => t.tag);
      expect(tags).not.toContain("h2");
      expect(tags).toContain("h1");
      expect(tags).toContain("p");
    });

    test("blockquote returns text group", () => {
      const targets = getConvertTargets("blockquote", false);
      const tags = targets.map((t) => t.tag);
      expect(tags).toContain("p");
      expect(tags).toContain("h1");
      expect(tags).not.toContain("blockquote");
    });
  });

  describe("text elements when empty", () => {
    test("empty p returns text + container groups", () => {
      const targets = getConvertTargets("p", true);
      const tags = targets.map((t) => t.tag);
      expect(tags).toContain("h1");
      expect(tags).toContain("h2");
      expect(tags).toContain("blockquote");
      expect(tags).toContain("div");
      expect(tags).toContain("section");
      expect(tags).toContain("article");
      expect(tags).not.toContain("p");
    });

    test("empty h1 returns text group only (no $convertToWhenEmpty)", () => {
      const targets = getConvertTargets("h1", true);
      const tags = targets.map((t) => t.tag);
      expect(tags).toContain("p");
      expect(tags).toContain("h2");
      expect(tags).not.toContain("div");
    });
  });

  describe("container elements", () => {
    test("div with content returns container group", () => {
      const targets = getConvertTargets("div", false);
      const tags = targets.map((t) => t.tag);
      expect(tags).toContain("section");
      expect(tags).toContain("article");
      expect(tags).toContain("aside");
      expect(tags).toContain("main");
      expect(tags).toContain("header");
      expect(tags).toContain("footer");
      expect(tags).toContain("nav");
      expect(tags).not.toContain("div");
      expect(tags).not.toContain("p");
    });

    test("empty div returns container + text groups", () => {
      const targets = getConvertTargets("div", true);
      const tags = targets.map((t) => t.tag);
      expect(tags).toContain("section");
      expect(tags).toContain("p");
      expect(tags).toContain("h1");
      expect(tags).not.toContain("div");
    });

    test("section returns container group", () => {
      const targets = getConvertTargets("section", false);
      const tags = targets.map((t) => t.tag);
      expect(tags).toContain("div");
      expect(tags).toContain("article");
      expect(tags).not.toContain("section");
    });
  });

  describe("list elements", () => {
    test("ul returns ol", () => {
      const targets = getConvertTargets("ul", false);
      const tags = targets.map((t) => t.tag);
      expect(tags).toContain("ol");
      expect(tags).not.toContain("ul");
      expect(tags.length).toBe(1);
    });

    test("ol returns ul", () => {
      const targets = getConvertTargets("ol", false);
      const tags = targets.map((t) => t.tag);
      expect(tags).toContain("ul");
      expect(tags).not.toContain("ol");
      expect(tags.length).toBe(1);
    });
  });

  describe("elements without conversion rules", () => {
    test("img returns empty array", () => {
      expect(getConvertTargets("img", false)).toEqual([]);
    });

    test("table returns empty array", () => {
      expect(getConvertTargets("table", false)).toEqual([]);
    });

    test("unknown tag returns empty array", () => {
      expect(getConvertTargets("custom-element", false)).toEqual([]);
    });
  });

  describe("return format", () => {
    test("each target has label, tag, description", () => {
      const targets = getConvertTargets("h1", false);
      for (const target of targets) {
        expect(target).toHaveProperty("label");
        expect(target).toHaveProperty("tag");
        expect(target).toHaveProperty("description");
        expect(typeof target.label).toBe("string");
        expect(typeof target.tag).toBe("string");
        expect(target.label.length).toBeGreaterThan(0);
      }
    });

    test("labels are human-readable", () => {
      const targets = getConvertTargets("h1", false);
      const pTarget = targets.find((t) => t.tag === "p");
      expect(pTarget?.label).toBe("Paragraph");
      const h2Target = targets.find((t) => t.tag === "h2");
      expect(h2Target?.label).toBe("Heading 2");
    });
  });
});
