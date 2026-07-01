/**
 * Tests for src/utils/link-target.ts — the pure classifyHref/composeHref helpers behind the
 * properties-panel Link-target control. No DOM: these are total, dependency-free functions.
 */
import { describe, expect, test } from "bun:test";
import { classifyHref, composeHref } from "../src/utils/link-target";
import type { LinkKind } from "../src/utils/link-target";

describe("classifyHref", () => {
  test("internal absolute paths", () => {
    expect(classifyHref("/about/")).toEqual({ kind: "internal", value: "/about/" });
    expect(classifyHref("/")).toEqual({ kind: "internal", value: "/" });
    expect(classifyHref("/blog/:slug")).toEqual({ kind: "internal", value: "/blog/:slug" });
  });

  test("external absolute URLs", () => {
    expect(classifyHref("https://x.com")).toEqual({ kind: "external", value: "https://x.com" });
    expect(classifyHref("http://x.com/a")).toEqual({ kind: "external", value: "http://x.com/a" });
    expect(classifyHref("ftp://host/file")).toEqual({ kind: "external", value: "ftp://host/file" });
  });

  test("protocol-relative URLs are external", () => {
    expect(classifyHref("//cdn.example.com/x")).toEqual({
      kind: "external",
      value: "//cdn.example.com/x",
    });
  });

  test("anchors strip the leading hash", () => {
    expect(classifyHref("#sec")).toEqual({ kind: "anchor", value: "sec" });
    expect(classifyHref("#")).toEqual({ kind: "anchor", value: "" });
  });

  test("mailto strips the scheme (case-insensitive)", () => {
    expect(classifyHref("mailto:a@b.com")).toEqual({ kind: "mailto", value: "a@b.com" });
    expect(classifyHref("MAILTO:a@b.com")).toEqual({ kind: "mailto", value: "a@b.com" });
  });

  test("tel strips the scheme", () => {
    expect(classifyHref("tel:+1")).toEqual({ kind: "tel", value: "+1" });
  });

  test("bare relative strings fall back to external", () => {
    expect(classifyHref("about")).toEqual({ kind: "external", value: "about" });
    expect(classifyHref("../up")).toEqual({ kind: "external", value: "../up" });
  });

  test("empty and missing input classify as empty external", () => {
    expect(classifyHref("")).toEqual({ kind: "external", value: "" });
    expect(classifyHref()).toEqual({ kind: "external", value: "" });
  });
});

describe("composeHref", () => {
  test("prefixes schemes and hash", () => {
    expect(composeHref("mailto", "a@b.com")).toBe("mailto:a@b.com");
    expect(composeHref("tel", "+1")).toBe("tel:+1");
    expect(composeHref("anchor", "sec")).toBe("#sec");
    // Already-prefixed anchor is left as-is (not double-hashed).
    expect(composeHref("anchor", "#sec")).toBe("#sec");
  });

  test("internal and external pass through verbatim", () => {
    expect(composeHref("internal", "/about/")).toBe("/about/");
    expect(composeHref("external", "https://x.com")).toBe("https://x.com");
    expect(composeHref("external", "//cdn/x")).toBe("//cdn/x");
  });

  test("empty or whitespace-only value yields empty string for every kind", () => {
    const kinds: LinkKind[] = ["internal", "external", "anchor", "mailto", "tel"];
    for (const kind of kinds) {
      expect(composeHref(kind, "")).toBe("");
      expect(composeHref(kind, "   ")).toBe("");
    }
  });
});

describe("round-trips (composeHref ∘ classifyHref === identity)", () => {
  const cases: [string, LinkKind][] = [
    ["/about/", "internal"],
    ["https://x.com", "external"],
    ["//cdn.example.com/x", "external"],
    ["#sec", "anchor"],
    ["mailto:a@b.com", "mailto"],
    ["tel:+1", "tel"],
    ["", "external"],
  ];

  for (const [href, expectedKind] of cases) {
    test(`round-trips ${JSON.stringify(href)}`, () => {
      const { kind, value } = classifyHref(href);
      expect(kind).toBe(expectedKind);
      expect(composeHref(kind, value)).toBe(href);
    });
  }
});
