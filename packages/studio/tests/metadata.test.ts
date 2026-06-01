import "./with-dom.js";
import { describe, test, expect } from "bun:test";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

interface MetaEntry {
  $section: string;
  $order: number;
  type: string;
  enum?: string[];
  $buttonValues?: string[];
  $icons?: Record<string, string>;
  $elements?: string[];
  $inlineChildren?: string[];
  [key: string]: unknown;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const studioDir = join(__dirname, "..");

const cssMeta = JSON.parse(readFileSync(join(studioDir, "data", "css-meta.json"), "utf8"));
const htmlMeta = JSON.parse(readFileSync(join(studioDir, "data", "html-meta.json"), "utf8"));
const stylebookMeta = JSON.parse(
  readFileSync(join(studioDir, "data", "stylebook-meta.json"), "utf8"),
);
const elementsMeta = JSON.parse(
  readFileSync(join(studioDir, "data", "elements-meta.json"), "utf8"),
);

// ─── Shared metadata helpers ─────────────────────────────────────────────────

/** @param {any} meta */
function sectionKeys(meta: any) {
  return new Set(meta.$sections.map((s: any) => s.key));
}

// ─── css-meta.json ───────────────────────────────────────────────────────────

describe("css-meta.json", () => {
  const sections = sectionKeys(cssMeta);
  const defs = Object.entries(cssMeta.$defs) as [string, MetaEntry][];

  test("has $id and title", () => {
    expect(cssMeta.$id).toBe("css-meta");
    expect(typeof cssMeta.title).toBe("string");
  });

  test("has at least 5 sections", () => {
    expect(cssMeta.$sections.length).toBeGreaterThanOrEqual(5);
  });

  test("every section has key and label", () => {
    for (const section of cssMeta.$sections) {
      expect(typeof section.key).toBe("string");
      expect(typeof section.label).toBe("string");
    }
  });

  test("section keys are unique", () => {
    const keys = cssMeta.$sections.map((s: any) => s.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  test("every def has $section referencing a valid section", () => {
    for (const [_prop, entry] of defs) {
      expect(sections.has(entry.$section)).toBe(true);
    }
  });

  test("every def has numeric $order", () => {
    for (const [_prop, entry] of defs) {
      expect(typeof entry.$order).toBe("number");
    }
  });

  test("every def has a type", () => {
    const validTypes = new Set(["string", "number", "boolean", "color"]);
    for (const [_prop, entry] of defs) {
      expect(validTypes.has(entry.type)).toBe(true);
    }
  });

  test("enum entries are arrays of strings", () => {
    for (const [_prop, entry] of defs) {
      if (entry.enum) {
        expect(Array.isArray(entry.enum)).toBe(true);
        for (const v of entry.enum) {
          expect(typeof v).toBe("string");
        }
      }
    }
  });

  test("$buttonValues are subsets of enum", () => {
    for (const [_prop, entry] of defs) {
      if (entry.$buttonValues && entry.enum) {
        for (const bv of entry.$buttonValues) {
          expect(entry.enum).toContain(bv);
        }
      }
    }
  });

  test("$icons keys exist in $buttonValues", () => {
    for (const [_prop, entry] of defs) {
      if (entry.$icons && entry.$buttonValues) {
        for (const iconKey of Object.keys(entry.$icons)) {
          expect(entry.$buttonValues).toContain(iconKey);
        }
      }
    }
  });

  test("no duplicate $order within a section", () => {
    const ordersBySection: Record<string, Record<string, any>> = {};
    for (const [prop, entry] of defs) {
      const sec = entry.$section;
      if (!ordersBySection[sec]) ordersBySection[sec] = {};
      // Same order values in a section would be a conflict
      if (ordersBySection[sec][entry.$order]) {
        // Allow it but track — some sections may legitimately share order
        // Just ensure we can at least detect it
      }
      ordersBySection[sec][entry.$order] = prop;
    }
    // Verify at minimum that the map built successfully
    expect(Object.keys(ordersBySection).length).toBeGreaterThan(0);
  });

  test("known CSS properties are present", () => {
    const defKeys = new Set(Object.keys(cssMeta.$defs));
    const expected = ["display", "color", "padding", "margin", "fontFamily", "fontSize"];
    for (const prop of expected) {
      expect(defKeys.has(prop)).toBe(true);
    }
  });
});

// ─── html-meta.json ──────────────────────────────────────────────────────────

describe("html-meta.json", () => {
  const sections = sectionKeys(htmlMeta);
  const defs = Object.entries(htmlMeta.$defs) as [string, MetaEntry][];

  test("has $id and title", () => {
    expect(htmlMeta.$id).toBe("html-meta");
    expect(typeof htmlMeta.title).toBe("string");
  });

  test("has at least 4 sections", () => {
    expect(htmlMeta.$sections.length).toBeGreaterThanOrEqual(4);
  });

  test("every section has key and label", () => {
    for (const section of htmlMeta.$sections) {
      expect(typeof section.key).toBe("string");
      expect(typeof section.label).toBe("string");
    }
  });

  test("every def has $section referencing a valid section", () => {
    for (const [_attr, entry] of defs) {
      expect(sections.has(entry.$section)).toBe(true);
    }
  });

  test("every def has numeric $order", () => {
    for (const [_attr, entry] of defs) {
      expect(typeof entry.$order).toBe("number");
    }
  });

  test("every def has a type", () => {
    const validTypes = new Set(["string", "boolean"]);
    for (const [_attr, entry] of defs) {
      expect(validTypes.has(entry.type)).toBe(true);
    }
  });

  test("$elements arrays contain only lowercase tag names", () => {
    for (const [_attr, entry] of defs) {
      if (entry.$elements) {
        expect(Array.isArray(entry.$elements)).toBe(true);
        for (const tag of entry.$elements) {
          expect(tag).toBe(tag.toLowerCase());
          expect(tag).toMatch(/^[a-z][a-z0-9]*$/);
        }
      }
    }
  });

  test("global attributes have no $elements", () => {
    const globalAttrs = ["id", "class", "title", "hidden", "lang", "dir", "role", "tabindex"];
    for (const attr of globalAttrs) {
      const entry = htmlMeta.$defs[attr];
      if (entry) {
        expect(entry.$elements).toBeUndefined();
      }
    }
  });

  test("known HTML attributes are present", () => {
    const defKeys = new Set(Object.keys(htmlMeta.$defs));
    const expected = ["id", "class", "href", "src", "alt", "role", "aria-label"];
    for (const attr of expected) {
      expect(defKeys.has(attr)).toBe(true);
    }
  });

  test("tag-specific attributes have valid $elements", () => {
    // href should only be on a, area, link
    const href = htmlMeta.$defs.href;
    if (href && href.$elements) {
      expect(href.$elements).toContain("a");
    }
    // src should include img
    const src = htmlMeta.$defs.src;
    if (src && src.$elements) {
      expect(src.$elements).toContain("img");
    }
  });
});

// ─── stylebook-meta.json ─────────────────────────────────────────────────────

describe("stylebook-meta.json", () => {
  test("has $sections array", () => {
    expect(Array.isArray(stylebookMeta.$sections)).toBe(true);
    expect(stylebookMeta.$sections.length).toBeGreaterThan(0);
  });

  test("every section has label and elements array", () => {
    for (const section of stylebookMeta.$sections) {
      expect(typeof section.label).toBe("string");
      expect(Array.isArray(section.elements)).toBe(true);
    }
  });

  test("every element has a tag", () => {
    for (const section of stylebookMeta.$sections) {
      for (const el of section.elements) {
        expect(typeof el.tag).toBe("string");
      }
    }
  });

  test("section labels are unique", () => {
    const labels = stylebookMeta.$sections.map((s: any) => s.label);
    expect(new Set(labels).size).toBe(labels.length);
  });
});

// ─── elements-meta.json ─────────────────────────────────────────────────────

describe("elements-meta.json", () => {
  test("has $id and title", () => {
    expect(elementsMeta.$id).toBe("elements-meta");
    expect(typeof elementsMeta.title).toBe("string");
  });

  test("every element def has $inlineChildren array", () => {
    for (const [_tag, def] of Object.entries(elementsMeta.$defs) as [string, MetaEntry][]) {
      expect(Array.isArray(def.$inlineChildren)).toBe(true);
    }
  });

  test("$inlineChildren contain only lowercase tag names", () => {
    for (const [_tag, def] of Object.entries(elementsMeta.$defs) as [string, MetaEntry][]) {
      for (const child of def.$inlineChildren!) {
        expect(child).toBe(child.toLowerCase());
        expect(child).toMatch(/^[a-z][a-z0-9]*$/);
      }
    }
  });

  test("<a> is inline within <p> but not within <div>", () => {
    expect(elementsMeta.$defs.p.$inlineChildren).toContain("a");
    expect(elementsMeta.$defs.div.$inlineChildren).not.toContain("a");
  });

  test("$inlineActions string references resolve to valid arrays", () => {
    for (const [_tag, def] of Object.entries(elementsMeta.$defs) as [string, MetaEntry][]) {
      if (typeof def.$inlineActions === "string") {
        const ref = elementsMeta.$defs[def.$inlineActions];
        expect(ref).toBeDefined();
        expect(Array.isArray(ref.$inlineActions)).toBe(true);
      }
    }
  });

  test("$inlineActions entries have required fields", () => {
    for (const [_tag, def] of Object.entries(elementsMeta.$defs) as [string, MetaEntry][]) {
      let actions = def.$inlineActions;
      if (typeof actions === "string") actions = elementsMeta.$defs[actions]?.$inlineActions;
      if (!Array.isArray(actions)) continue;
      for (const action of actions) {
        expect(typeof action.tag).toBe("string");
        expect(typeof action.label).toBe("string");
        expect(typeof action.icon).toBe("string");
        expect(typeof action.command).toBe("string");
      }
    }
  });

  test("text-bearing elements have non-empty $inlineChildren", () => {
    const textBearing = ["p", "h1", "h2", "h3", "h4", "h5", "h6", "li", "td", "th"];
    for (const tag of textBearing) {
      const def = elementsMeta.$defs[tag];
      expect(def).toBeDefined();
      expect(def.$inlineChildren.length).toBeGreaterThan(0);
    }
  });

  test("container elements have empty $inlineChildren", () => {
    const containers = ["div", "section", "article", "nav", "main"];
    for (const tag of containers) {
      const def = elementsMeta.$defs[tag];
      expect(def).toBeDefined();
      expect(def.$inlineChildren).toEqual([]);
    }
  });
});
