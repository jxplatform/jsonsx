/**
 * The design-quickstart section of the New Project Parameters step: color/font/logo/breakpoint
 * overrides threaded into createProject as `design` alongside the chosen `destination`,
 * prefill-suppression (untouched values are not sent), and the logo file gate.
 */
import { flush, installMockPlatform, npFillLocation, npLocation, npName, npType } from "./harness";
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

/** The Location the design tests create into (mirrors the harness default). */
const LOCATION = "/home/dev/Sites";

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

function mediaRows(): NodeListOf<Element> {
  return document.querySelectorAll("#layer-modal .new-project-media-row");
}

function mediaRow(index: number): { name: any; value: any } {
  const rows = mediaRows();
  return {
    name: rows[index]?.querySelector(".new-project-media-name"),
    value: rows[index]?.querySelector(".new-project-media-value"),
  };
}

/** The first inline error in the modal body (destination errors precede the design sections). */
function inlineError(): string {
  return document.querySelector("#layer-modal .new-project-error")?.textContent ?? "";
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
    npType(npName(), "Styled Site");
    npFillLocation(LOCATION);

    npType(colorField(0), "#ff2200"); // Accent
    npType(colorField(1), "#fffbe6"); // Background
    npType(colorField(2), "#222222"); // Text
    npType(fontField(0), "'Inter', sans-serif");
    npType(fontField(1), "'Fraunces', serif");
    // Edit one of the prefilled breakpoint rows (blank template preset: --, --lg, --md, --sm).
    npType(mediaRow(1).value, "(max-width: 1100px)");

    clickFooter("Create Project");
    await promise;

    const opts = created[0] as { design: Record<string, unknown>; destination: unknown };
    // The design overrides ride alongside the destination the user chose, not instead of it.
    expect(opts.destination).toEqual({ kind: "path", parent: LOCATION });
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
    npType(npName(), "Break Site");
    npFillLocation(LOCATION);

    // Remove the last prefilled row, then add a custom one.
    const removeButtons = [
      ...document.querySelectorAll("#layer-modal .new-project-media-row sp-action-button"),
    ];
    removeButtons.at(-1)!.dispatchEvent(new Event("click", { bubbles: true }));
    const addBtn = [...document.querySelectorAll("#layer-modal sp-button")].find((b) =>
      b.textContent?.includes("Add Breakpoint"),
    );
    addBtn!.dispatchEvent(new Event("click", { bubbles: true }));
    const last = mediaRow(mediaRows().length - 1);
    npType(last.name, "--xl");
    npType(last.value, "(max-width: 1600px)");

    clickFooter("Create Project");
    await promise;

    const { design } = created[0] as { design: { media: Record<string, string> } };
    expect(design.media["--xl"]).toBe("(max-width: 1600px)");
    expect(design.media["--sm"]).toBeUndefined();
  });

  test("a selected logo file is base64-encoded into the payload; bad extensions are rejected", async () => {
    const promise = openToParams();
    npType(npName(), "Logo Site");
    npFillLocation(LOCATION);

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
    expect(inlineError()).toContain("SVG, PNG");

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
    npType(npName(), "Plain Site");
    npFillLocation(LOCATION);
    clickFooter("Create Project");
    await promise;
    const opts = created[0] as { design?: unknown; destination: unknown };
    expect(opts.design).toBeUndefined();
    expect(opts.destination).toEqual({ kind: "path", parent: LOCATION });
  });

  test("a missing Location blocks the create and keeps the design edits for the retry", async () => {
    const promise = openToParams();
    npType(npName(), "Homeless Site");
    npType(colorField(0), "#0a84ff");

    clickFooter("Create Project");
    await flush();
    expect(created).toHaveLength(0);
    expect(inlineError()).toContain("Choose a location for the project folder");

    // A relative path is refused too — the backend only ever writes to an absolute parent.
    npType(npLocation(), "sites");
    clickFooter("Create Project");
    await flush();
    expect(created).toHaveLength(0);
    expect(inlineError()).toContain("Location must be an absolute path");

    npFillLocation(LOCATION);
    clickFooter("Create Project");
    await promise;

    const opts = created[0] as { design: { accent: string }; destination: unknown };
    expect(opts.destination).toEqual({ kind: "path", parent: LOCATION });
    expect(opts.design.accent).toBe("#0a84ff");
  });
});
