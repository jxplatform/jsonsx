import { installMockPlatform } from "./harness";
import { beforeEach, describe, expect, test } from "bun:test";
import {
  distributePageIntoLayout,
  invalidateLayoutCache,
  resolveLayoutDoc,
} from "../src/site-context";
import type { JxMutableNode } from "@jxsuite/schema/types";

beforeEach(() => {
  invalidateLayoutCache();
});

describe("distributePageIntoLayout", () => {
  test("fills default/named/fallback slots and merges page-level config", () => {
    const layoutDoc = {
      attributes: { lang: "en" },
      $media: { "--m": "x" },
      children: [
        null,
        { tagName: "slot" },
        { attributes: { name: "side" }, tagName: "slot" },
        {
          attributes: { name: "empty" },
          children: [{ tagName: "span", textContent: "fallback" }],
          tagName: "slot",
        },
        { children: [{ attributes: { name: "deep" }, tagName: "slot" }], tagName: "section" },
      ],
      state: { a: 1 },
      style: { color: "red" },
      tagName: "div",
    } as unknown as JxMutableNode;

    const pageDoc = {
      attributes: { dir: "ltr" },
      $media: { "--n": "y" },
      children: [
        { tagName: "p", textContent: "main" },
        { attributes: { slot: "side" }, tagName: "aside", textContent: "sidebar" },
      ],
      state: { b: 2 },
      style: { margin: "0" },
      tagName: "div",
    } as unknown as JxMutableNode;

    const merged = distributePageIntoLayout(layoutDoc, pageDoc) as Record<string, any>;

    // Page-level blocks merged onto the layout.
    expect(merged.state).toEqual({ a: 1, b: 2 });
    expect(merged.$media).toEqual({ "--m": "x", "--n": "y" });
    expect(merged.style).toEqual({ color: "red", margin: "0" });
    expect(merged.attributes).toEqual({ dir: "ltr", lang: "en" });

    const flat = JSON.stringify(merged);
    // Default slot received the page's default child.
    expect(flat).toContain("main");
    // Named slot received the page's slotted child.
    expect(flat).toContain("sidebar");
    // Unmatched named slot fell back to its own children.
    expect(flat).toContain("fallback");
  });
});

describe("resolveLayoutDoc", () => {
  test("returns a clone from the cache on repeated resolution", async () => {
    const { state } = installMockPlatform();
    state.files.set(
      "layouts/base.json",
      JSON.stringify({ children: [{ tagName: "slot" }], tagName: "div" }),
    );

    const first = await resolveLayoutDoc("./layouts/base.json");
    expect(first).not.toBeNull();
    // Second resolution hits the in-memory cache (and returns a distinct clone).
    const second = await resolveLayoutDoc("layouts/base.json");
    expect(second).not.toBeNull();
    expect(second).not.toBe(first);
    expect(second).toEqual(first);
  });

  test("returns null when the layout file cannot be read", async () => {
    installMockPlatform();
    const result = await resolveLayoutDoc("./layouts/missing.json");
    expect(result).toBeNull();
  });
});
