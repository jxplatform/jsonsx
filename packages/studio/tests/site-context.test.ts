import "./with-dom.js";
import { beforeEach, describe, expect, test } from "bun:test";
import { setProjectState } from "../src/store";
import type { ProjectState } from "../src/types";
import type { JxStyle } from "@jxsuite/schema/types";
import {
  getEffectiveElements,
  getEffectiveHead,
  getEffectiveImports,
  getEffectiveLocales,
  getEffectiveMedia,
  getEffectiveStyle,
} from "../src/site-context";

beforeEach(() => {
  setProjectState({ projectConfig: null } as unknown as ProjectState);
});

// ─── getEffectiveMedia ─────────────────────────────────────────────────────

describe("getEffectiveMedia", () => {
  test("returns doc media when no project config", () => {
    const docMedia = { "--sm": "(min-width: 640px)" };
    expect(getEffectiveMedia(docMedia)).toEqual(docMedia);
  });

  test("returns empty object when no doc media and no project config", () => {
    expect(getEffectiveMedia()).toEqual({});
  });

  test("returns site media when no doc media", () => {
    setProjectState({
      projectConfig: { $media: { "--lg": "(min-width: 1024px)" } },
    } as unknown as ProjectState);
    expect(getEffectiveMedia()).toEqual({
      "--lg": "(min-width: 1024px)",
    });
  });

  test("merges site and doc media (doc wins)", () => {
    setProjectState({
      projectConfig: {
        $media: { "--lg": "(min-width: 1024px)", "--md": "(min-width: 768px)" },
      },
    } as unknown as ProjectState);
    const docMedia = { "--md": "(min-width: 800px)" };
    const result = getEffectiveMedia(docMedia);
    expect(result["--md"]).toBe("(min-width: 800px)");
    expect(result["--lg"]).toBe("(min-width: 1024px)");
  });
});

// ─── getEffectiveStyle ─────────────────────────────────────────────────────

describe("getEffectiveStyle", () => {
  test("returns doc style when no project config", () => {
    const docStyle = { color: "red" };
    expect(getEffectiveStyle(docStyle)).toEqual(docStyle);
  });

  test("returns empty object when nothing defined", () => {
    expect(getEffectiveStyle()).toEqual({});
  });

  test("returns site style when no doc style", () => {
    setProjectState({
      projectConfig: { style: { margin: "0" } },
    } as unknown as ProjectState);
    expect(getEffectiveStyle()).toEqual({ margin: "0" });
  });

  test("merges styles (doc wins for flat values)", () => {
    setProjectState({
      projectConfig: { style: { color: "blue", margin: "0" } },
    } as unknown as ProjectState);
    const result = getEffectiveStyle({ color: "red" });
    expect(result.color).toBe("red");
    expect(result.margin).toBe("0");
  });

  test("shallow-merges nested selector objects", () => {
    setProjectState({
      projectConfig: { style: { ":hover": { color: "blue", opacity: "0.8" } } },
    } as unknown as ProjectState);
    const result = getEffectiveStyle({ ":hover": { color: "red" } });
    expect((result[":hover"] as JxStyle).color).toBe("red");
    expect((result[":hover"] as JxStyle).opacity).toBe("0.8");
  });
});

// ─── getEffectiveImports ───────────────────────────────────────────────────

describe("getEffectiveImports", () => {
  test("returns doc imports when no project config", () => {
    const imports = { MyComp: "./comp.json" };
    expect(getEffectiveImports(imports)).toEqual(imports);
  });

  test("returns empty object when nothing defined", () => {
    expect(getEffectiveImports()).toEqual({});
  });

  test("returns site imports when no doc imports", () => {
    setProjectState({
      projectConfig: { imports: { Parser: "@jx/parser" } },
    } as unknown as ProjectState);
    expect(getEffectiveImports()).toEqual({ Parser: "@jx/parser" });
  });

  test("merges imports (doc wins)", () => {
    setProjectState({
      projectConfig: { imports: { A: "a.json", B: "b.json" } },
    } as unknown as ProjectState);
    const result = getEffectiveImports({ A: "override.json" });
    expect(result.A).toBe("override.json");
    expect(result.B).toBe("b.json");
  });
});

// ─── getEffectiveElements ──────────────────────────────────────────────────

describe("getEffectiveElements", () => {
  test("returns doc elements when no project config", () => {
    const els = [{ $ref: "./a.json" }];
    expect(getEffectiveElements(els)).toEqual(els);
  });

  test("returns empty array when nothing defined", () => {
    expect(getEffectiveElements()).toEqual([]);
  });

  test("returns site elements when no doc elements", () => {
    setProjectState({
      projectConfig: { $elements: [{ $ref: "./site.json" }] },
    } as unknown as ProjectState);
    expect(getEffectiveElements()).toEqual([{ $ref: "./site.json" }]);
  });

  test("deduplicates by $ref", () => {
    setProjectState({
      projectConfig: {
        $elements: [{ $ref: "./a.json" }, { $ref: "./b.json" }],
      },
    } as unknown as ProjectState);
    const result = getEffectiveElements([{ $ref: "./a.json" }, { $ref: "./c.json" }]);
    expect(result).toHaveLength(3);
    const refs = result.map((e) => (e as { $ref: string }).$ref);
    expect(refs).toContain("./a.json");
    expect(refs).toContain("./b.json");
    expect(refs).toContain("./c.json");
  });

  test("handles string entries", () => {
    setProjectState({
      projectConfig: { $elements: ["./global.json"] },
    } as unknown as ProjectState);
    const result = getEffectiveElements(["./global.json", "./local.json"]);
    expect(result).toHaveLength(2);
  });
});

// ─── getEffectiveHead ──────────────────────────────────────────────────────

describe("getEffectiveHead", () => {
  test("returns doc head when no project config", () => {
    const head = [{ attributes: { href: "/style.css" }, tagName: "link" }];
    expect(getEffectiveHead(head)).toEqual(head);
  });

  test("returns empty array when nothing defined", () => {
    expect(getEffectiveHead()).toEqual([]);
  });

  test("returns site head when no doc head", () => {
    const siteHead = [{ attributes: { href: "/global.css" }, tagName: "link" }];
    setProjectState({
      projectConfig: { $head: siteHead },
    } as unknown as ProjectState);
    expect(getEffectiveHead()).toEqual(siteHead);
  });

  test("deduplicates by href", () => {
    setProjectState({
      projectConfig: {
        $head: [
          { attributes: { href: "/a.css" }, tagName: "link" },
          { attributes: { href: "/b.css" }, tagName: "link" },
        ],
      },
    } as unknown as ProjectState);
    const result = getEffectiveHead([
      { attributes: { href: "/a.css" }, tagName: "link" },
      { attributes: { href: "/c.css" }, tagName: "link" },
    ]);
    expect(result).toHaveLength(3);
  });

  test("deduplicates by src", () => {
    setProjectState({
      projectConfig: {
        $head: [{ attributes: { src: "/app.js" }, tagName: "script" }],
      },
    } as unknown as ProjectState);
    const result = getEffectiveHead([{ attributes: { src: "/app.js" }, tagName: "script" }]);
    expect(result).toHaveLength(1);
  });

  test("deduplicates by JSON.stringify for entries without href/src", () => {
    const meta = {
      attributes: { content: "width=device-width", name: "viewport" },
      tagName: "meta",
    };
    setProjectState({
      projectConfig: { $head: [meta] },
    } as unknown as ProjectState);
    const result = getEffectiveHead([meta]);
    expect(result).toHaveLength(1);
  });
});

// ─── getEffectiveLocales ───────────────────────────────────────────────────

/*
 * These are NOT a restatement of the compiler's locale rules. Studio and the compiler call the
 * same `resolveI18n` out of `@jxsuite/schema/locale`, so the two cannot disagree about what a tag
 * means. What is asserted here is only what this wrapper adds: that it hands the resolver the LIVE
 * project config, and that it answers a render rather than throwing on one.
 */
describe("getEffectiveLocales", () => {
  test("no project, and a project that declares none, are both null", () => {
    expect(getEffectiveLocales()).toBeNull();
    setProjectState({ projectConfig: { name: "Demo" } } as unknown as ProjectState);
    expect(getEffectiveLocales()).toBeNull();
  });

  test("reads the live config, resolved the way the build resolves it", () => {
    setProjectState({
      projectConfig: { i18n: { defaultLocale: "EN-us", locales: ["en-US", "fr-ca", "not_a_tag"] } },
    } as unknown as ProjectState);
    expect(getEffectiveLocales()).toEqual({
      defaultLocale: "en-US",
      locales: ["en-US", "fr-CA"],
      routing: "prefix-except-default",
    });
  });

  /*
   * A malformed tag is a build error, and the resolver returns it as one. A render has nowhere to
   * put a sentence, so the sentence belongs to Project Settings — what this must not do is throw
   * on the way to drawing a menu.
   */
  test("a malformed tag is dropped rather than thrown, and the rest survives", () => {
    setProjectState({
      projectConfig: { i18n: { locales: ["en_US", "fr"] } },
    } as unknown as ProjectState);
    expect(getEffectiveLocales()?.locales).toEqual(["fr"]);
  });

  // `projectState` is replaced wholesale on a project switch, so a cached answer would describe a
  // Project that is no longer open.
  test("follows a project switch", () => {
    setProjectState({
      projectConfig: { i18n: { locales: ["en", "fr"] } },
    } as unknown as ProjectState);
    expect(getEffectiveLocales()?.locales).toHaveLength(2);
    setProjectState({ projectConfig: { name: "Other" } } as unknown as ProjectState);
    expect(getEffectiveLocales()).toBeNull();
  });
});
