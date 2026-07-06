/**
 * The design-quickstart section of the New Project Parameters step: color/font/logo/breakpoint
 * overrides threaded into createProject as `design`, prefill-suppression (untouched values are not
 * sent), and the logo file gate.
 */
import { flush, installMockPlatform } from "./harness";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

const { closeNewProjectModal, openNewProjectModal } =
  await import("../src/new-project/new-project-modal");
const { initLayers } = await import("../src/ui/layers");

document.body.innerHTML = `
  <div id="layer-popover"></div>
  <div id="layer-modal"></div>
  <div id="layer-dialog"></div>
`;
initLayers();

function field(index: number): any {
  return document.querySelectorAll("#layer-modal sp-textfield")[index];
}

function typeInto(el: any, value: string) {
  el.value = value;
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

function footerButtons(): any[] {
  return [...document.querySelectorAll("#layer-modal .new-project-modal-footer sp-button")];
}

function clickFooter(label: string) {
  const btn = footerButtons().find((b) => b.textContent?.includes(label));
  btn!.dispatchEvent(new Event("click", { bubbles: true }));
}

function colorField(index: number): any {
  return document.querySelectorAll("#layer-modal .new-project-color-row sp-textfield")[index];
}

/** The two font textfields inside the Fonts design section. */
function fontField(index: number): any {
  const sections = document.querySelectorAll("#layer-modal .new-project-design-section");
  return sections[1]?.querySelectorAll("sp-textfield")[index];
}

function mediaRow(index: number): { name: any; value: any } {
  const rows = document.querySelectorAll("#layer-modal .new-project-media-row");
  return {
    name: rows[index]?.querySelector(".new-project-media-name"),
    value: rows[index]?.querySelector(".new-project-media-value"),
  };
}

let created: Record<string, unknown>[] = [];

function openToParams() {
  installMockPlatform({
    createProject: (async (opts: Record<string, unknown>) => {
      created.push(opts);
      return { config: { name: "X" }, root: "/projects/x" };
    }) as never,
  });
  const promise = openNewProjectModal();
  clickFooter("Next");
  return promise;
}

beforeEach(() => {
  created = [];
  localStorage.clear();
});

afterEach(() => {
  closeNewProjectModal();
});

describe("design quickstart", () => {
  test("colors, fonts, and edited breakpoints travel as the design payload", async () => {
    const promise = openToParams();
    typeInto(field(0), "Styled Site");

    typeInto(colorField(0), "#ff2200"); // Accent
    typeInto(colorField(1), "#fffbe6"); // Background
    typeInto(colorField(2), "#222222"); // Text
    typeInto(fontField(0), "'Inter', sans-serif");
    typeInto(fontField(1), "'Fraunces', serif");
    // Edit one of the prefilled breakpoint rows (blank template preset: --, --lg, --md, --sm).
    typeInto(mediaRow(1).value, "(max-width: 1100px)");

    clickFooter("Create Project");
    await promise;

    const opts = created[0] as { design: Record<string, unknown> };
    expect(opts.design).toEqual({
      accent: "#ff2200",
      background: "#fffbe6",
      text: "#222222",
      bodyFont: "'Inter', sans-serif",
      headingFont: "'Fraunces', serif",
      media: {
        "--": "1280px",
        "--lg": "(max-width: 1100px)",
        "--md": "(max-width: 768px)",
        "--sm": "(max-width: 640px)",
      },
    });
  });

  test("removing and adding breakpoint rows counts as an edit", async () => {
    const promise = openToParams();
    typeInto(field(0), "Break Site");

    // Remove the last prefilled row, then add a custom one.
    const removeButtons = [
      ...document.querySelectorAll("#layer-modal .new-project-media-row sp-action-button"),
    ];
    removeButtons.at(-1)!.dispatchEvent(new Event("click", { bubbles: true }));
    const addBtn = [...document.querySelectorAll("#layer-modal sp-button")].find((b) =>
      b.textContent?.includes("Add Breakpoint"),
    );
    addBtn!.dispatchEvent(new Event("click", { bubbles: true }));
    const rows = [...document.querySelectorAll("#layer-modal .new-project-media-row")];
    const last = rows.at(-1)!;
    typeInto(last.querySelector(".new-project-media-name"), "--xl");
    typeInto(last.querySelector(".new-project-media-value"), "(max-width: 1600px)");

    clickFooter("Create Project");
    await promise;

    const { design } = created[0] as { design: { media: Record<string, string> } };
    expect(design.media["--xl"]).toBe("(max-width: 1600px)");
    expect(design.media["--sm"]).toBeUndefined();
  });

  test("a selected logo file is base64-encoded into the payload; bad extensions are rejected", async () => {
    const promise = openToParams();
    typeInto(field(0), "Logo Site");

    const input = document.querySelector(
      "#layer-modal .new-project-logo-row input[type=file]",
    ) as HTMLInputElement;

    // A disallowed extension shows an inline error and keeps the logo unset.
    Object.defineProperty(input, "files", {
      configurable: true,
      value: [new File(["MZ"], "logo.exe")],
    });
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await flush();
    expect(document.querySelector("#layer-modal .new-project-error")?.textContent).toContain(
      "SVG, PNG",
    );

    // A valid image is read and encoded.
    Object.defineProperty(input, "files", {
      configurable: true,
      value: [new File(["<svg/>"], "logo.svg", { type: "image/svg+xml" })],
    });
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await flush();

    clickFooter("Create Project");
    await promise;

    const { design } = created[0] as { design: { logo: { name: string; base64: string } } };
    expect(design.logo.name).toBe("logo.svg");
    expect(atob(design.logo.base64)).toBe("<svg/>");
  });

  test("an untouched Parameters step sends no design payload at all", async () => {
    const promise = openToParams();
    typeInto(field(0), "Plain Site");
    clickFooter("Create Project");
    await promise;
    expect((created[0] as { design?: unknown }).design).toBeUndefined();
  });
});
