/**
 * Tests for src/settings/css-vars-editor.ts — form-based design-token editor.
 *
 * Renders against projectState.projectConfig.style, asserts grouping (colors / fonts / sizes /
 * other), value updates, deletion, the add rows, and media-aware overrides. Persistence goes
 * through updateSiteConfig → platform.writeFile("project.json").
 */
import { flush, installMockPlatform, pointer, resetStudioState } from "./harness";
import { describe, expect, test } from "bun:test";
import { renderCssVarsEditor } from "../src/settings/css-vars-editor";
import { projectState } from "../src/store";

import type { MockPlatformState } from "./harness";

type AnyConfig = Record<string, any>;

function setup(
  styleObj: AnyConfig,
  media?: Record<string, string>,
): { container: HTMLElement; state: MockPlatformState } {
  const { state } = installMockPlatform();
  resetStudioState({
    projectConfig: { style: styleObj, ...(media ? { $media: media } : {}) } as unknown,
  });
  const container = document.createElement("div");
  renderCssVarsEditor(container);
  return { container, state };
}

function style(): AnyConfig {
  return (projectState as AnyConfig).projectConfig.style;
}

function groupByTitle(container: HTMLElement, title: string): HTMLElement {
  const group = [...container.querySelectorAll(".css-vars-group")].find(
    (g) => g.querySelector(".css-vars-group-title")?.textContent?.trim() === title,
  );
  if (!group) {
    throw new Error(`no css-vars group titled "${title}"`);
  }
  return group as HTMLElement;
}

function rowByName(group: HTMLElement, displayName: string): HTMLElement {
  const row = [...group.querySelectorAll(".css-var-row")].find(
    (r) => r.querySelector(".css-var-name")?.textContent?.trim() === displayName,
  );
  if (!row) {
    throw new Error(`no css-var row named "${displayName}"`);
  }
  return row as HTMLElement;
}

function setAndFire(el: Element, value: string, type = "change"): void {
  (el as HTMLInputElement).value = value;
  el.dispatchEvent(new Event(type, { bubbles: true }));
}

function baseStyle(): AnyConfig {
  return {
    "--color-accent": "tomato",
    "--color-primary": "#007acc",
    "--font-body": "'Georgia', serif",
    "--radius-md": 8,
    "--shadow-soft": "0 1px 2px rgba(0,0,0,.2)",
    "--size-gap": "16px",
    "--spacing-lg": "32px",
    "@--sm": { "--size-gap": "8px" },
    color: "blue", // Not a custom property — skipped
    "--weird": { nested: true }, // Object value — skipped
  };
}

// ─── Grouping ────────────────────────────────────────────────────────────────

describe("css vars grouping", () => {
  test("vars are bucketed into Colors / Fonts / Sizes / Other", () => {
    const { container } = setup(baseStyle());
    expect(groupByTitle(container, "Colors").querySelectorAll(".css-var-row").length).toBe(2);
    expect(groupByTitle(container, "Fonts").querySelectorAll(".css-var-row").length).toBe(1);
    expect(groupByTitle(container, "Sizes & Spacing").querySelectorAll(".css-var-row").length).toBe(
      3,
    );
    expect(groupByTitle(container, "Other").querySelectorAll(".css-var-row").length).toBe(1);
  });

  test("non-custom-property keys and object values are skipped", () => {
    const { container } = setup(baseStyle());
    const names = [...container.querySelectorAll(".css-var-name")].map((n) =>
      n.textContent?.trim(),
    );
    expect(names).not.toContain("color");
    expect(names).not.toContain("--weird");
  });

  test("Other group is omitted when empty", () => {
    const { container } = setup({ "--color-primary": "#fff" });
    expect(() => groupByTitle(container, "Other")).toThrow();
    expect(() => groupByTitle(container, "Colors")).not.toThrow();
  });

  test("renders with a missing project config without crashing", () => {
    installMockPlatform();
    resetStudioState({ projectConfig: null });
    const container = document.createElement("div");
    expect(() => renderCssVarsEditor(container)).not.toThrow();
    expect(container.querySelectorAll(".css-var-row").length).toBe(0);
  });

  test("size names fall back through size/spacing/radius prefixes", () => {
    const { container } = setup(baseStyle());
    const group = groupByTitle(container, "Sizes & Spacing");
    const names = [...group.querySelectorAll(".css-var-name")].map((n) => n.textContent?.trim());
    expect(names).toContain("Gap");
    expect(names).toContain("Spacing Lg");
    expect(names).toContain("Radius Md");
  });
});

// ─── Color section ───────────────────────────────────────────────────────────

describe("color section", () => {
  test("hex values seed the swatch color input; non-hex falls back", () => {
    const { container } = setup(baseStyle());
    const colors = groupByTitle(container, "Colors");
    const primary = rowByName(colors, "Primary").querySelector(
      'input[type="color"]',
    ) as HTMLInputElement;
    const accent = rowByName(colors, "Accent").querySelector(
      'input[type="color"]',
    ) as HTMLInputElement;
    expect(primary.value).toBe("#007acc");
    expect(accent.value).toBe("#3b82f6"); // Fallback for "tomato"
  });

  test("swatch input updates the var and persists", async () => {
    const { container, state } = setup(baseStyle());
    const row = rowByName(groupByTitle(container, "Colors"), "Primary");
    setAndFire(row.querySelector('input[type="color"]')!, "#ff0000", "input");
    expect(style()["--color-primary"]).toBe("#ff0000");
    await flush();
    const written = JSON.parse(state.files.get("project.json")!);
    expect(written.style["--color-primary"]).toBe("#ff0000");
  });

  test("textfield change updates the var", async () => {
    const { container } = setup(baseStyle());
    const row = rowByName(groupByTitle(container, "Colors"), "Accent");
    setAndFire(row.querySelector("sp-textfield")!, "rebeccapurple");
    expect(style()["--color-accent"]).toBe("rebeccapurple");
    await flush();
    expect((projectState as AnyConfig).projectConfig.style["--color-accent"]).toBe("rebeccapurple");
  });

  test("delete removes the var and re-renders without the row", async () => {
    const { container, state } = setup(baseStyle());
    const row = rowByName(groupByTitle(container, "Colors"), "Accent");
    pointer(row.querySelector("sp-action-button")!, "click");
    expect(style()["--color-accent"]).toBeUndefined();
    expect(() => rowByName(groupByTitle(container, "Colors"), "Accent")).toThrow();
    await flush();
    expect(JSON.parse(state.files.get("project.json")!).style["--color-accent"]).toBeUndefined();
  });

  test("add row creates a slugged var; empty name or value is a no-op", async () => {
    const { container, state } = setup(baseStyle());
    const addRow = groupByTitle(container, "Colors").querySelector(".css-var-add-row")!;
    const [nameEl, valEl] = addRow.querySelectorAll("sp-textfield");

    (nameEl as HTMLInputElement).value = "Brand Green!";
    (valEl as HTMLInputElement).value = "#00aa55";
    pointer(addRow.querySelector("sp-action-button")!, "click");
    expect(style()["--color-brand-green"]).toBe("#00aa55");
    await flush();
    expect(JSON.parse(state.files.get("project.json")!).style["--color-brand-green"]).toBe(
      "#00aa55",
    );

    // Name that slugs to "" → no-op
    const writes = state.calls.filter(([n]) => n === "writeFile").length;
    const addRow2 = groupByTitle(container, "Colors").querySelector(".css-var-add-row")!;
    const [name2, val2] = addRow2.querySelectorAll("sp-textfield");
    (name2 as HTMLInputElement).value = "$$$";
    (val2 as HTMLInputElement).value = "#123456";
    pointer(addRow2.querySelector("sp-action-button")!, "click");

    // Empty value → no-op
    const addRow3 = groupByTitle(container, "Colors").querySelector(".css-var-add-row")!;
    const [name3, val3] = addRow3.querySelectorAll("sp-textfield");
    (name3 as HTMLInputElement).value = "Ghost";
    (val3 as HTMLInputElement).value = "";
    pointer(addRow3.querySelector("sp-action-button")!, "click");

    expect(state.calls.filter(([n]) => n === "writeFile").length).toBe(writes);
    expect(style()["--color-ghost"]).toBeUndefined();
  });
});

// ─── Font section ────────────────────────────────────────────────────────────

describe("font section", () => {
  test("renders a preview line and updates on change", () => {
    const { container } = setup(baseStyle());
    const fonts = groupByTitle(container, "Fonts");
    const preview = fonts.querySelector(".css-var-font-preview") as HTMLElement;
    expect(preview.textContent).toContain("quick brown fox");
    expect(preview.getAttribute("style")).toContain("'Georgia', serif");

    setAndFire(rowByName(fonts, "Body").querySelector("sp-textfield")!, "monospace");
    expect(style()["--font-body"]).toBe("monospace");
  });

  test("add row creates a font var", () => {
    const { container } = setup(baseStyle());
    const addRow = groupByTitle(container, "Fonts").querySelector(".css-var-add-row")!;
    const [nameEl, valEl] = addRow.querySelectorAll("sp-textfield");
    (nameEl as HTMLInputElement).value = "Heading Sans";
    (valEl as HTMLInputElement).value = "system-ui";
    pointer(addRow.querySelector("sp-action-button")!, "click");
    expect(style()["--font-heading-sans"]).toBe("system-ui");
  });
});

// ─── Size section + media overrides ──────────────────────────────────────────

describe("size section and media overrides", () => {
  const media = { "--": "1280px", "--sm": "(max-width: 600px)" };

  test("no media names → no overrides UI", () => {
    const { container } = setup(baseStyle());
    expect(container.querySelector(".css-var-media-overrides")).toBeNull();
  });

  test("vars with a media-block override show the override row", () => {
    const { container } = setup(baseStyle(), media);
    const overrides = container.querySelectorAll(".css-var-media-overrides");
    expect(overrides.length).toBe(1); // Only --size-gap has an @--sm entry
    const label = overrides[0]!.querySelector(".css-var-media-label");
    expect(label?.textContent).toBe("@--sm");
    expect(
      (overrides[0]!.querySelector("sp-textfield") as HTMLInputElement).getAttribute("value"),
    ).toBeNull(); // Value bound via property, not attribute
  });

  test("changing an override writes into the media block and persists", async () => {
    const { container, state } = setup(baseStyle(), media);
    const field = container.querySelector(".css-var-media-overrides sp-textfield")!;
    setAndFire(field, "12px");
    expect(style()["@--sm"]["--size-gap"]).toBe("12px");
    await flush();
    expect(JSON.parse(state.files.get("project.json")!).style["@--sm"]["--size-gap"]).toBe("12px");
  });

  test("override change recreates a media block deleted after render", () => {
    const { container } = setup(baseStyle(), media);
    const field = container.querySelector(".css-var-media-overrides sp-textfield")!;
    delete style()["@--sm"];
    setAndFire(field, "10px");
    expect(style()["@--sm"]).toEqual({ "--size-gap": "10px" });
  });

  test("size textfield change and add row work", () => {
    const { container } = setup(baseStyle(), media);
    const sizes = groupByTitle(container, "Sizes & Spacing");
    setAndFire(rowByName(sizes, "Gap").querySelector("sp-textfield")!, "20px");
    expect(style()["--size-gap"]).toBe("20px");

    const addRow = sizes.querySelector(".css-var-add-row")!;
    const [nameEl, valEl] = addRow.querySelectorAll("sp-textfield");
    (nameEl as HTMLInputElement).value = "Gutter";
    (valEl as HTMLInputElement).value = "24px";
    pointer(addRow.querySelector("sp-action-button")!, "click");
    expect(style()["--size-gutter"]).toBe("24px");
  });
});

// ─── Other section ───────────────────────────────────────────────────────────

describe("other section", () => {
  test("shows raw names, updates values, and supports media overrides", () => {
    const styleWithOtherOverride = {
      ...baseStyle(),
      "@--sm": { "--shadow-soft": "none", "--size-gap": "8px" },
    };
    const { container } = setup(styleWithOtherOverride, {
      "--": "1280px",
      "--sm": "(max-width: 600px)",
    });
    const other = groupByTitle(container, "Other");
    expect(other.querySelector(".css-var-name")?.textContent?.trim()).toBe("--shadow-soft");
    expect(other.querySelector(".css-var-media-overrides")).not.toBeNull();

    setAndFire(rowByName(other, "--shadow-soft").querySelector("sp-textfield")!, "none");
    expect(style()["--shadow-soft"]).toBe("none");

    pointer(rowByName(other, "--shadow-soft").querySelectorAll("sp-action-button")[0]!, "click");
    expect(style()["--shadow-soft"]).toBeUndefined();
  });

  test("add row in Other uses the bare -- prefix", () => {
    const { container } = setup(baseStyle());
    const addRow = groupByTitle(container, "Other").querySelector(".css-var-add-row")!;
    const [nameEl, valEl] = addRow.querySelectorAll("sp-textfield");
    (nameEl as HTMLInputElement).value = "Z Index Modal";
    (valEl as HTMLInputElement).value = "100";
    pointer(addRow.querySelector("sp-action-button")!, "click");
    expect(style()["--z-index-modal"]).toBe("100");
  });
});

// ─── Scheme-aware color tokens (spec §9.5) ───────────────────────────────────

describe("color scheme overrides", () => {
  const SCHEME_MEDIA = { "--dark": "(prefers-color-scheme: dark)" };

  test("scheme rows render per color token with the current override or an inherits placeholder", () => {
    const { container } = setup(
      { ...baseStyle(), "@--dark": { "--color-primary": "#111111" } },
      SCHEME_MEDIA,
    );
    const colors = groupByTitle(container, "Colors");
    const schemeRows = [...colors.querySelectorAll(".css-var-scheme-row")];
    // One Dark row per color token (accent + primary).
    expect(schemeRows).toHaveLength(2);
    expect(schemeRows[0]!.querySelector(".css-var-media-label")?.textContent?.trim()).toBe("Dark");
    const values = schemeRows.map(
      (r) => (r.querySelector("sp-textfield") as HTMLInputElement).value,
    );
    expect(values).toContain("#111111");
    expect(values).toContain("");
  });

  test("editing a scheme row writes the token into the @--dark block", () => {
    const { container } = setup(baseStyle(), SCHEME_MEDIA);
    const colors = groupByTitle(container, "Colors");
    const darkRow = colors.querySelector(".css-var-scheme-row")!;
    setAndFire(darkRow.querySelector("sp-textfield")!, "#0a0a0a");
    expect((style()["@--dark"] as AnyConfig)["--color-accent"]).toBe("#0a0a0a");
  });

  test("clearing a scheme override deletes the key and drops the emptied block", () => {
    const { container } = setup(
      { ...baseStyle(), "@--dark": { "--color-accent": "#0a0a0a" } },
      SCHEME_MEDIA,
    );
    const colors = groupByTitle(container, "Colors");
    const darkRow = [...colors.querySelectorAll(".css-var-scheme-row")].find(
      (r) => (r.querySelector("sp-textfield") as HTMLInputElement).value === "#0a0a0a",
    )!;
    setAndFire(darkRow.querySelector("sp-textfield")!, "");
    expect(style()["@--dark"]).toBeUndefined();
  });

  test("scheme queries are excluded from size-token media overrides", () => {
    const { container } = setup(
      { ...baseStyle(), "@--dark": { "--size-gap": "4px" } },
      { "--dark": "(prefers-color-scheme: dark)", "--sm": "(max-width: 600px)" },
    );
    const sizes = groupByTitle(container, "Sizes & Spacing");
    const labels = [...sizes.querySelectorAll(".css-var-media-label")].map((l) =>
      l.textContent?.trim(),
    );
    expect(labels).toContain("@--sm");
    expect(labels).not.toContain("@--dark");
  });

  test("Enable dark scheme writes the scheme query into $media", async () => {
    const { container } = setup(baseStyle(), { "--sm": "(max-width: 600px)" });
    const colors = groupByTitle(container, "Colors");
    expect(colors.querySelectorAll(".css-var-scheme-row")).toHaveLength(0);
    pointer(colors.querySelector(".css-vars-enable-dark")!, "click");
    await flush();
    expect((projectState as AnyConfig).projectConfig.$media["--dark"]).toBe(
      "(prefers-color-scheme: dark)",
    );
    // The editor re-rendered with the scheme rows now visible.
    expect(
      groupByTitle(container, "Colors").querySelectorAll(".css-var-scheme-row").length,
    ).toBeGreaterThan(0);
  });

  test("no scheme UI without a declared scheme query", () => {
    const { container } = setup(baseStyle(), { "--sm": "(max-width: 600px)" });
    expect(container.querySelectorAll(".css-var-scheme-row")).toHaveLength(0);
    expect(container.querySelector(".css-vars-enable-dark")).not.toBeNull();
  });
});
