/** Metadata and $media presets for the built-in project templates. */
import { describe, expect, test } from "bun:test";
import { TEMPLATES, isTemplateId, listTemplates, mediaForTemplate } from "../templates";

describe("template metadata", () => {
  test("exposes the four built-in templates with unique ids", () => {
    expect(TEMPLATES.map((t) => t.id)).toEqual([
      "blank",
      "desktop-first",
      "mobile-first",
      "mobile-app",
    ]);
    for (const t of TEMPLATES) {
      expect(t.name.length).toBeGreaterThan(0);
      expect(t.description.length).toBeGreaterThan(0);
    }
  });

  test("listTemplates returns a fresh copy", () => {
    const list = listTemplates();
    expect(list).toEqual([...TEMPLATES]);
    expect(list).not.toBe(TEMPLATES);
  });

  test("isTemplateId accepts template ids and rejects everything else", () => {
    expect(isTemplateId("blank")).toBe(true);
    expect(isTemplateId("mobile-app")).toBe(true);
    expect(isTemplateId("restaurant")).toBe(false);
    expect(isTemplateId("")).toBe(false);
  });
});

describe("mediaForTemplate", () => {
  test("desktop-first templates use max-width queries with the widest base", () => {
    for (const id of ["blank", "desktop-first"] as const) {
      expect(mediaForTemplate(id)).toEqual({
        "--": "1280px",
        "--lg": "(max-width: 1024px)",
        "--md": "(max-width: 768px)",
        "--sm": "(max-width: 640px)",
      });
    }
  });

  test("mobile-first templates use min-width queries with the narrowest base", () => {
    for (const id of ["mobile-first", "mobile-app"] as const) {
      expect(mediaForTemplate(id)).toEqual({
        "--": "375px",
        "--sm": "(min-width: 640px)",
        "--md": "(min-width: 768px)",
        "--lg": "(min-width: 1024px)",
      });
    }
  });

  test("returns a fresh object each call", () => {
    const a = mediaForTemplate("blank");
    a["--"] = "clobbered";
    expect(mediaForTemplate("blank")["--"]).toBe("1280px");
  });
});
