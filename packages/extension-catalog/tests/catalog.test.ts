import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { getCatalogEntry, listCatalog } from "../index";

const ROOT = resolve(import.meta.dirname, "../../..");

describe("listCatalog", () => {
  test("parses the committed catalogue", () => {
    const catalog = listCatalog();
    expect(catalog.length).toBeGreaterThan(0);
    for (const entry of catalog) {
      expect(typeof entry.name).toBe("string");
      expect(typeof entry.title).toBe("string");
      expect(typeof entry.description).toBe("string");
      expect(Array.isArray(entry.sections)).toBe(true);
      expect(typeof entry.docs).toBe("string");
    }
  });

  test("memoizes — a second call hands back the same array", () => {
    expect(listCatalog()).toBe(listCatalog());
  });

  test("package names are unique", () => {
    const names = listCatalog().map((entry) => entry.name);
    expect(new Set(names).size).toBe(names.length);
  });

  test("is sorted by package name, so a regeneration is a stable diff", () => {
    const names = listCatalog().map((entry) => entry.name);
    expect(names).toEqual(names.toSorted());
  });
});

describe("the committed bytes are held to the extensions tree", () => {
  test("every entry names a real extension whose manifest agrees", () => {
    for (const entry of listCatalog()) {
      const dir = entry.name.replace("@jxsuite/", "");
      const manifestPath = join(ROOT, "extensions", dir, "jx-extension.json");
      expect(existsSync(manifestPath)).toBe(true);
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
        name: string;
        title: string;
        description: string;
      };
      expect(manifest.name).toBe(entry.name);
      expect(manifest.title).toBe(entry.title);
      expect(manifest.description).toBe(entry.description);
    }
  });

  test("every section key is claimed by exactly one extension (specs/extensions.md §3.1)", () => {
    const owner = new Map<string, string>();
    for (const entry of listCatalog()) {
      for (const section of entry.sections) {
        expect(owner.get(section.key)).toBeUndefined();
        owner.set(section.key, entry.name);
      }
    }
    expect(owner.size).toBeGreaterThan(0);
  });

  test("every `requires` edge names another catalogue member", () => {
    const names = new Set(listCatalog().map((entry) => entry.name));
    for (const entry of listCatalog()) {
      for (const dep of entry.requires ?? []) {
        expect(names.has(dep)).toBe(true);
      }
    }
  });

  test("every docs link points at a heading the page actually publishes", async () => {
    const { headingsOf } = await import("../../../scripts/docs/lib/headings.ts");
    const page = join(ROOT, "docs/extending/extensions/first-party.md");
    const anchors = new Set(headingsOf(readFileSync(page, "utf8")).map((h) => h.slug));
    for (const entry of listCatalog()) {
      const [, anchor] = entry.docs.split("#");
      expect(anchor).toBeDefined();
      expect(anchors.has(anchor as string)).toBe(true);
    }
  });
});

/*
 * The rule this file exists to make expensive to break. `settings/dependencies-editor.ts` records
 * what a version here costs: a range pinned at build time "proposed a version that may never have
 * been published, for a package whose real latest the table had not looked at" — and a catalogue
 * inside a packaged desktop app is read months after it is written. `addPackage(name)` already
 * means "latest", resolved at install time.
 */
describe("no version rides the catalogue", () => {
  test("no entry carries a version or a semver range", () => {
    for (const entry of listCatalog()) {
      const keys = Object.keys(entry);
      expect(keys).not.toContain("version");
      expect(keys).not.toContain("range");
      expect(keys).not.toContain("minimumJx");
    }
  });
});

describe("getCatalogEntry", () => {
  test("finds an entry by package name", () => {
    expect(getCatalogEntry("@jxsuite/parser")?.title).toBe("Content & Markdown");
  });

  test("returns undefined for a package that is not in the catalogue", () => {
    expect(getCatalogEntry("@acme/nope")).toBeUndefined();
  });
});
