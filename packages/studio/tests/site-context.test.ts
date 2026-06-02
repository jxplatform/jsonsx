import "./with-dom.js";
import { describe, test, expect, beforeEach } from "bun:test";
import { setProjectState } from "../src/store";
import type { ProjectState } from "../src/types";
import {
  getEffectiveMedia,
  getEffectiveStyle,
  getEffectiveImports,
  getEffectiveElements,
  getEffectiveHead,
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
    expect(getEffectiveMedia(undefined)).toEqual({});
  });

  test("returns site media when no doc media", () => {
    setProjectState({
      projectConfig: { $media: { "--lg": "(min-width: 1024px)" } },
    } as unknown as ProjectState);
    expect(getEffectiveMedia(undefined)).toEqual({ "--lg": "(min-width: 1024px)" });
  });

  test("merges site and doc media (doc wins)", () => {
    setProjectState({
      projectConfig: { $media: { "--md": "(min-width: 768px)", "--lg": "(min-width: 1024px)" } },
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
    expect(getEffectiveStyle(undefined)).toEqual({});
  });

  test("returns site style when no doc style", () => {
    setProjectState({ projectConfig: { style: { margin: "0" } } } as unknown as ProjectState);
    expect(getEffectiveStyle(undefined)).toEqual({ margin: "0" });
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
    expect(getEffectiveImports(undefined)).toEqual({});
  });

  test("returns site imports when no doc imports", () => {
    setProjectState({
      projectConfig: { imports: { Parser: "@jx/parser" } },
    } as unknown as ProjectState);
    expect(getEffectiveImports(undefined)).toEqual({ Parser: "@jx/parser" });
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
    expect(getEffectiveElements(undefined)).toEqual([]);
  });

  test("returns site elements when no doc elements", () => {
    setProjectState({
      projectConfig: { $elements: [{ $ref: "./site.json" }] },
    } as unknown as ProjectState);
    expect(getEffectiveElements(undefined)).toEqual([{ $ref: "./site.json" }]);
  });

  test("deduplicates by $ref", () => {
    setProjectState({
      projectConfig: { $elements: [{ $ref: "./a.json" }, { $ref: "./b.json" }] },
    } as unknown as ProjectState);
    const result = getEffectiveElements([{ $ref: "./a.json" }, { $ref: "./c.json" }]);
    expect(result).toHaveLength(3);
    const refs = result.map((e) => (e as { $ref: string }).$ref);
    expect(refs).toContain("./a.json");
    expect(refs).toContain("./b.json");
    expect(refs).toContain("./c.json");
  });

  test("handles string entries", () => {
    setProjectState({ projectConfig: { $elements: ["./global.json"] } } as unknown as ProjectState);
    const result = getEffectiveElements(["./global.json", "./local.json"]);
    expect(result).toHaveLength(2);
  });
});

// ─── getEffectiveHead ──────────────────────────────────────────────────────

describe("getEffectiveHead", () => {
  test("returns doc head when no project config", () => {
    const head = [{ tagName: "link", attributes: { href: "/style.css" } }];
    expect(getEffectiveHead(head)).toEqual(head);
  });

  test("returns empty array when nothing defined", () => {
    expect(getEffectiveHead(undefined)).toEqual([]);
  });

  test("returns site head when no doc head", () => {
    const siteHead = [{ tagName: "link", attributes: { href: "/global.css" } }];
    setProjectState({ projectConfig: { $head: siteHead } } as unknown as ProjectState);
    expect(getEffectiveHead(undefined)).toEqual(siteHead);
  });

  test("deduplicates by href", () => {
    setProjectState({
      projectConfig: {
        $head: [
          { tagName: "link", attributes: { href: "/a.css" } },
          { tagName: "link", attributes: { href: "/b.css" } },
        ],
      },
    } as unknown as ProjectState);
    const result = getEffectiveHead([
      { tagName: "link", attributes: { href: "/a.css" } },
      { tagName: "link", attributes: { href: "/c.css" } },
    ]);
    expect(result).toHaveLength(3);
  });

  test("deduplicates by src", () => {
    setProjectState({
      projectConfig: {
        $head: [{ tagName: "script", attributes: { src: "/app.js" } }],
      },
    } as unknown as ProjectState);
    const result = getEffectiveHead([{ tagName: "script", attributes: { src: "/app.js" } }]);
    expect(result).toHaveLength(1);
  });

  test("deduplicates by JSON.stringify for entries without href/src", () => {
    const meta = {
      tagName: "meta",
      attributes: { name: "viewport", content: "width=device-width" },
    };
    setProjectState({ projectConfig: { $head: [meta] } } as unknown as ProjectState);
    const result = getEffectiveHead([meta]);
    expect(result).toHaveLength(1);
  });
});
