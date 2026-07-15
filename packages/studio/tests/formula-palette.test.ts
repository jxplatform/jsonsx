/**
 * Tests for src/ui/formula-palette.ts — the command-palette overlay over the formula catalog:
 * rendering, grouped results, search filtering, keyboard navigation, and picking.
 */
import "./with-dom.js";
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { initLayers } from "../src/ui/layers";
import { closeFormulaPalette, openFormulaPalette } from "../src/ui/formula-palette";
import type { FormulaCatalogEntry } from "../src/ui/formula-catalog";

// Layer DOM is set up once — getLayerSlot caches its slot element, so the body must not be
// Replaced between tests (the cached slot would keep pointing into a detached subtree).
document.body.innerHTML = `
  <div id="layer-popover"></div>
  <div id="layer-modal"></div>
  <div id="layer-dialog"></div>
`;
initLayers();

// Happy-dom may not provide requestAnimationFrame in all versions.
(globalThis as Record<string, unknown>).requestAnimationFrame ??= (cb: (t: number) => void) =>
  setTimeout(() => cb(0), 0);

function entry(overrides: Partial<FormulaCatalogEntry>): FormulaCatalogEntry {
  return {
    description: "desc",
    group: "Group",
    insert: () => ({ operator: "!", target: null }),
    kind: "operator",
    label: "op",
    name: "op",
    parameters: [],
    ...overrides,
  };
}

const ENTRIES: FormulaCatalogEntry[] = [
  entry({ description: "Nullish coalescing", group: "Logical", label: "??", name: "??" }),
  entry({ description: "Conditional operator", group: "Conditional", label: "?:", name: "?:" }),
  entry({
    description: "Largest of the arguments",
    group: "Math",
    kind: "global",
    label: "Math.max",
    name: "Math/max",
  }),
];

const onPick = mock((_entry: FormulaCatalogEntry) => {});

function overlay(): HTMLElement | null {
  return document.querySelector(".formula-palette-overlay");
}

function searchInput(): HTMLInputElement {
  return document.querySelector(".formula-palette-input") as HTMLInputElement;
}

function items(): HTMLElement[] {
  return [...document.querySelectorAll(".quick-search-item")] as HTMLElement[];
}

function typeQuery(q: string) {
  const input = searchInput();
  input.value = q;
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function keydown(keyName: string) {
  searchInput().dispatchEvent(
    new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: keyName }),
  );
}

beforeEach(() => {
  onPick.mockClear();
  closeFormulaPalette();
});

describe("formula palette — open/close", () => {
  test("open renders entries grouped with kind badges; close removes the overlay", () => {
    openFormulaPalette({ entries: ENTRIES, onPick });
    expect(overlay()).toBeTruthy();
    expect(items().length).toBe(3);
    const groups = [...document.querySelectorAll(".quick-search-section-label")].map(
      (g) => g.textContent,
    );
    expect(groups).toEqual(["Logical", "Conditional", "Math"]);
    const badges = [...document.querySelectorAll(".quick-search-badge")].map((b) => b.textContent);
    expect(badges).toEqual(["operator", "operator", "global"]);

    closeFormulaPalette();
    expect(overlay()).toBeNull();
  });

  test("clicking the backdrop closes; clicks inside the panel do not", () => {
    openFormulaPalette({ entries: ENTRIES, onPick });
    const panel = document.querySelector(".formula-palette") as HTMLElement;
    panel.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(overlay()).toBeTruthy();
    overlay()!.dispatchEvent(new MouseEvent("click", { bubbles: false }));
    expect(overlay()).toBeNull();
  });

  test("Escape closes without picking", () => {
    openFormulaPalette({ entries: ENTRIES, onPick });
    keydown("Escape");
    expect(overlay()).toBeNull();
    expect(onPick).not.toHaveBeenCalled();
  });

  test("empty entries render the empty state", () => {
    openFormulaPalette({ entries: [], onPick });
    expect(document.querySelector(".quick-search-empty")?.textContent).toContain(
      "No entries available",
    );
  });
});

describe("formula palette — filtering", () => {
  test("filters by label, name, group, and description substrings", () => {
    openFormulaPalette({ entries: ENTRIES, onPick });

    typeQuery("max");
    expect(items().length).toBe(1);
    expect(items()[0]!.textContent).toContain("Math.max");

    typeQuery("conditional");
    expect(items().length).toBe(1);
    expect(items()[0]!.textContent).toContain("?:");

    typeQuery("??");
    expect(items().length).toBe(1);

    typeQuery("no-such-thing");
    expect(items().length).toBe(0);
    expect(document.querySelector(".quick-search-empty")?.textContent).toContain("No results");

    typeQuery("");
    expect(items().length).toBe(3);
  });
});

describe("formula palette — picking", () => {
  test("Enter picks the keyboard-selected entry and closes", () => {
    openFormulaPalette({ entries: ENTRIES, onPick });
    keydown("ArrowDown");
    keydown("Enter");
    expect(onPick).toHaveBeenCalledTimes(1);
    expect(onPick.mock.calls[0]![0]!.label).toBe("?:");
    expect(overlay()).toBeNull();
  });

  test("arrow navigation clamps at the ends", () => {
    openFormulaPalette({ entries: ENTRIES, onPick });
    keydown("ArrowUp");
    keydown("ArrowDown");
    keydown("ArrowDown");
    keydown("ArrowDown");
    keydown("Enter");
    expect(onPick.mock.calls[0]![0]!.label).toBe("Math.max");
  });

  test("clicking an entry picks it; mouseenter moves the selection", () => {
    openFormulaPalette({ entries: ENTRIES, onPick });
    items()[2]!.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
    expect(items()[2]!.classList.contains("selected")).toBe(true);
    items()[0]!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onPick).toHaveBeenCalledTimes(1);
    expect(onPick.mock.calls[0]![0]!.label).toBe("??");
    expect(overlay()).toBeNull();
  });

  test("Enter with no matching entries is a no-op", () => {
    openFormulaPalette({ entries: ENTRIES, onPick });
    typeQuery("zzz");
    keydown("Enter");
    expect(onPick).not.toHaveBeenCalled();
    expect(overlay()).toBeTruthy();
  });
});
