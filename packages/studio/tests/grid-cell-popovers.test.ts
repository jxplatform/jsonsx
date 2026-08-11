import { flush, installMockPlatform, resetStudioState } from "./harness";
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { html, render } from "lit-html";
import type { GridColumn } from "../src/grid/grid-source";
import type { TemplateResult } from "lit-html";

// Capture popovers into a live host instead of the layer system.
const popoverHosts: HTMLElement[] = [];
let dismissed = 0;
void mock.module("../src/ui/layers.js", () => ({
  clearLayerSlot: () => {},
  getLayerSlot: () => document.createElement("div"),
  initLayers: () => {},
  openModal: () => ({ close: () => {}, update: () => {} }),
  // The media picker asks which layer its anchor sits in; these fields are in a panel.
  popoverLayerFor: () => "popover",
  renderPopover: (template: TemplateResult) => {
    const host = document.createElement("div");
    document.body.append(host);
    render(template, host);
    popoverHosts.push(host);
    return {
      dismiss: () => {
        dismissed += 1;
        host.remove();
      },
    };
  },
  showConfirmDialog: async () => true,
  showDialog: async () => null,
}));

// The real media picker drags in caches/timers — a stub input keeps the contract observable.
void mock.module("../src/ui/media-picker.js", () => ({
  renderMediaPicker: (_prop: string, value: string, onCommit: (val: string) => void) =>
    html`<input
      class="fake-media-input"
      .value=${value}
      @change=${(e: Event) => onCommit((e.target as HTMLInputElement).value)}
    />`,
}));

const { hasPopoverEditor, openCellValuePopover, referenceTargetType } =
  await import("../src/grid/cell-popovers");
const { setFormats } = await import("../src/format/format-host");

const MD_FORMAT = {
  capabilities: { parse: { identifier: "parse", timing: [] } },
  documentKinds: ["content"],
  exportTarget: false,
  extensions: [".md"],
  mediaType: "text/markdown",
  name: "Markdown",
  remote: false,
  studio: null,
} as never;

const col = (kind: GridColumn["kind"], schema?: GridColumn["schema"]): GridColumn => ({
  editable: true,
  field: "f",
  kind,
  title: "Field",
  ...(schema ? { schema } : {}),
});

beforeEach(() => {
  resetStudioState();
  setFormats([MD_FORMAT]);
  popoverHosts.length = 0;
  dismissed = 0;
});

describe("popover editor selection", () => {
  test("image and reference kinds use popovers; others do not", () => {
    expect(hasPopoverEditor(col("image"))).toBeTrue();
    expect(hasPopoverEditor(col("reference"))).toBeTrue();
    expect(hasPopoverEditor(col("string"))).toBeFalse();
    expect(hasPopoverEditor(col("array"))).toBeFalse();
  });

  test("referenceTargetType parses #/content/<name> schema refs only", () => {
    expect(referenceTargetType(col("reference", { $ref: "#/content/authors" } as never))).toBe(
      "authors",
    );
    expect(referenceTargetType(col("reference", { $ref: "#/data/users" } as never))).toBeNull();
    expect(referenceTargetType(col("reference"))).toBeNull();
  });
});

describe("openCellValuePopover — reference", () => {
  test("lists target-collection entry ids and commits picks (— clears)", async () => {
    installMockPlatform(
      {},
      {
        "content/authors/jane.md": "---\ntitle: Jane\n---\n",
        "content/authors/mark.md": "---\ntitle: Mark\n---\n",
      },
    );
    resetStudioState({
      projectConfig: {
        content: { authors: { format: "Markdown", schema: {}, source: "./content/authors/" } },
      },
    });

    const commits: unknown[] = [];
    await openCellValuePopover({
      anchor: { bottom: 40, left: 10 },
      column: col("reference", { $ref: "#/content/authors" } as never),
      commit: (v) => commits.push(v),
      value: "jane",
    });
    await flush();

    const host = popoverHosts.at(-1)!;
    const select = host.querySelector("select")!;
    const options = [...select.querySelectorAll("option")].map((o) => o.value);
    expect(options).toEqual(["", "jane", "mark"]);
    expect((select.querySelector('option[value="jane"]') as HTMLOptionElement).selected).toBeTrue();

    select.value = "mark";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    expect(commits).toEqual(["mark"]);

    select.value = "";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    expect(commits).toEqual(["mark", null]);
  });

  test("custom-id input commits free text; Done dismisses", async () => {
    installMockPlatform();
    resetStudioState({ projectConfig: { content: {} } });
    const commits: unknown[] = [];
    await openCellValuePopover({
      anchor: { bottom: 0, left: 0 },
      column: col("reference"),
      commit: (v) => commits.push(v),
      value: null,
    });
    await flush();

    const host = popoverHosts.at(-1)!;
    const input = host.querySelector("input.jx-grid-input") as HTMLInputElement;
    input.value = "  custom-entry ";
    input.dispatchEvent(new Event("change", { bubbles: true }));
    expect(commits).toEqual(["custom-entry"]);

    (host.querySelector("sp-button") as HTMLElement).click();
    expect(dismissed).toBe(1);
  });
});

describe("openCellValuePopover — image", () => {
  test("renders the media picker with the current path and commits changes (empty clears)", async () => {
    installMockPlatform();
    const commits: unknown[] = [];
    await openCellValuePopover({
      anchor: { bottom: 0, left: 0 },
      column: col("image"),
      commit: (v) => commits.push(v),
      value: "/img/a.png",
    });
    await flush();

    const host = popoverHosts.at(-1)!;
    const input = host.querySelector(".fake-media-input") as HTMLInputElement;
    expect(input.value).toBe("/img/a.png");
    input.value = "/img/b.png";
    input.dispatchEvent(new Event("change", { bubbles: true }));
    input.value = "";
    input.dispatchEvent(new Event("change", { bubbles: true }));
    expect(commits).toEqual(["/img/b.png", null]);
  });
});
