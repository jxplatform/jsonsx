/**
 * Tests for src/ui/choice-field.ts — the one labelled choice both the New File dialog and the
 * convert flow render.
 *
 * Two things are worth a test rather than a reading. The `live()` guard is invisible in the output
 * and its absence is a bug that only appears after a reader has touched the control, so it is
 * asserted against the SOURCE. And the collapse to static text is a rule ("one kind is not a
 * choice"), not a style: a picker whose menu holds one row invites the reader to open it and find
 * out there is nothing there.
 */
import "./harness";
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { render } from "lit-html";
import { choiceField } from "../src/ui/choice-field";

function draw(spec: Parameters<typeof choiceField>[0]): HTMLElement {
  const host = document.createElement("div");
  render(choiceField(spec), host);
  return host;
}

const TWO = [
  { label: "JSON (.json)", value: ".json" },
  { dividerBefore: true, label: "Other…", value: "__other__" },
];

describe("rendering", () => {
  test("two or more options draw a picker carrying every row and its divider", () => {
    const host = draw({ label: "Format", onChange: () => {}, options: TWO, value: ".json" });
    const picker = host.querySelector("sp-picker")!;
    expect(picker).not.toBeNull();
    expect(picker.getAttribute("label")).toBe("Format");
    expect(
      [...host.querySelectorAll("sp-menu-item")].map((el) => el.getAttribute("value")),
    ).toEqual([".json", "__other__"]);
    expect(host.querySelectorAll("sp-menu-divider")).toHaveLength(1);
    expect(host.querySelector("sp-field-label")?.textContent).toBe("Format");
  });

  test("one option is stated, not offered — and states the LABEL, not the raw value", () => {
    const host = draw({
      label: "Format",
      onChange: () => {},
      options: [{ label: "Markdown (.md)", value: ".md" }],
      value: ".md",
    });
    expect(host.querySelector("sp-picker")).toBeNull();
    expect(host.querySelector(".choice-static")?.textContent).toBe("Markdown (.md)");
  });

  test("a value no row declares falls back to the value itself rather than rendering blank", () => {
    const host = draw({
      label: "Format",
      onChange: () => {},
      options: [{ label: "Markdown (.md)", value: ".md" }],
      value: ".toml",
    });
    expect(host.querySelector(".choice-static")?.textContent).toBe(".toml");
  });

  test("no options at all still renders the label and says nothing false", () => {
    const host = draw({ label: "Format", onChange: () => {}, options: [], value: "" });
    expect(host.querySelector("sp-picker")).toBeNull();
    expect(host.querySelector(".choice-static")?.textContent).toBe("");
  });
});

describe("reporting a pick", () => {
  test("change reads the picker's own value", () => {
    const picks: string[] = [];
    const host = draw({
      label: "Format",
      onChange: (next) => picks.push(next),
      options: TWO,
      value: ".json",
    });
    const picker = host.querySelector("sp-picker") as HTMLElement & { value: string };
    picker.value = "__other__";
    picker.dispatchEvent(new Event("change", { bubbles: true }));
    expect(picks).toEqual(["__other__"]);
  });
});

/**
 * `sp-picker` writes its own `value` when the reader picks a row, so lit's dirty check sees the
 * value it last committed and skips the re-commit that would put the control back where the model
 * says it is. `scripts/check-lit-conventions.ts` fails the unguarded form; this says the same thing
 * where the person changing this file will read it.
 */
test("the picker's value binds through live()", () => {
  const source = readFileSync(new URL("../src/ui/choice-field.ts", import.meta.url), "utf8");
  expect(source).toContain(".value=${live(spec.value)}");
});
