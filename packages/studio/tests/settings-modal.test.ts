/**
 * Tests for src/settings/settings-modal.ts — the site-wide settings modal.
 *
 * Renders into the real modal layer (initLayers + #layer-modal), drives section navigation, and
 * exercises every close path (Escape, close button, underlay close, programmatic close). The
 * section renderers are the real editors, fed by a minimal projectConfig via the harness.
 */
import { flush, installMockPlatform, key, pointer, resetStudioState } from "./harness";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { closeSettingsModal, openSettingsModal } from "../src/settings/settings-modal";
import { resetExtensionSettingsSections } from "../src/settings/extension-sections";
import { refreshFormats, setExtensions } from "../src/format/format-host";
import { initLayers } from "../src/ui/layers";
import "../src/ui/form-controls";
import type { ExtensionsInfo } from "../src/types";

// ─── Environment setup ───────────────────────────────────────────────────────

for (const id of ["layer-popover", "layer-modal", "layer-dialog"]) {
  if (!document.querySelector(`#${id}`)) {
    const el = document.createElement("div");
    el.id = id;
    document.body.append(el);
  }
}
initLayers();

// Deterministic rAF: run callbacks on the next macrotask so flush() picks them up.
globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
  setTimeout(() => cb(0), 0);
  return 0;
}) as typeof requestAnimationFrame;

function modalLayer(): HTMLElement {
  return document.querySelector("#layer-modal") as HTMLElement;
}

function modal(): HTMLElement | null {
  return modalLayer().querySelector(".settings-modal");
}

function content(): HTMLElement {
  return modal()!.querySelector(".settings-modal-content") as HTMLElement;
}

function navButton(label: string): HTMLElement {
  const button = [...modal()!.querySelectorAll(".settings-nav-item")].find(
    (b) => b.textContent?.trim() === label,
  );
  if (!button) {
    throw new Error(`no nav item "${label}"`);
  }
  return button as HTMLElement;
}

async function openAndSettle() {
  openSettingsModal();
  await flush(4);
}

/** A parser-like extensions payload contributing the Content Types section (order 50). */
const parserExtensions: ExtensionsInfo[] = [
  {
    contributions: [
      {
        className: "Content",
        entrySchema: {
          additionalProperties: {
            properties: {
              format: { type: "string" },
              schema: { type: "object" },
              source: { type: "string" },
            },
            type: "object",
          },
          type: "object",
        },
        project: { key: "content", title: "Content Types" },
        studio: {
          settings: {
            entry: {
              newEntry: { schema: { properties: {}, required: [], type: "object" } },
              ui: { schema: { control: "schema-builder" } },
            },
            icon: "sp-icon-view-grid",
            label: "Content Types",
            layout: "map",
            order: 50,
          },
        },
      },
    ],
    name: "@jxsuite/parser",
    specifier: "@jxsuite/parser",
    title: "Content & Markdown",
  },
];

beforeEach(() => {
  resetExtensionSettingsSections();
  refreshFormats();
  installMockPlatform();
  resetStudioState({
    projectConfig: {
      $defs: { Author: { properties: {}, required: [], type: "object" } },
      $media: { "--": "1280px", "--sm": "(max-width: 600px)" },
      content: {},
      style: { "--color-primary": "#007acc" },
    } as unknown,
  });
});

afterEach(async () => {
  closeSettingsModal();
  await flush();
});

// ─── Open / initial render ───────────────────────────────────────────────────

describe("open", () => {
  test("renders the modal with header, nav, and the General section active", async () => {
    await openAndSettle();
    expect(modal()).not.toBeNull();
    expect(modal()!.querySelector(".settings-modal-title")?.textContent).toBe("Settings");

    const navLabels = [...modal()!.querySelectorAll(".settings-nav-item")].map((b) =>
      b.textContent?.trim(),
    );
    expect(navLabels).toEqual(["General", "Head", "CSS Variables", "Definitions", "Dependencies"]);
    expect(navButton("General").classList.contains("active")).toBe(true);

    // The deferred rAF render filled the content area with the General section
    expect(content().querySelector(".settings-section-title")?.textContent).toBe("General");
  });

  test("opening twice is a no-op (single modal instance)", async () => {
    await openAndSettle();
    openSettingsModal();
    await flush();
    expect(modalLayer().querySelectorAll(".settings-modal").length).toBe(1);
  });

  test("reopening after close resets the active section to General", async () => {
    await openAndSettle();
    pointer(navButton("Definitions"), "click");
    await flush();
    closeSettingsModal();
    await flush();
    await openAndSettle();
    expect(navButton("General").classList.contains("active")).toBe(true);
    expect(content().querySelector(".settings-section-title")?.textContent).toBe("General");
  });
});

// ─── Section navigation ──────────────────────────────────────────────────────

describe("section navigation", () => {
  test("Head section renders the head editor", async () => {
    await openAndSettle();
    pointer(navButton("Head"), "click");
    await flush();
    expect(navButton("Head").classList.contains("active")).toBe(true);
    expect(navButton("General").classList.contains("active")).toBe(false);
    const titles = [...content().querySelectorAll(".settings-section-title")].map(
      (t) => t.textContent,
    );
    expect(titles).toContain("Head");
  });

  test("CSS Variables section renders the css-vars editor with project vars", async () => {
    await openAndSettle();
    pointer(navButton("CSS Variables"), "click");
    await flush();
    expect(content().querySelector(".settings-section-title")?.textContent).toBe("CSS Variables");
    expect(content().querySelectorAll(".css-var-row").length).toBe(1);
  });

  test("Definitions section renders the defs editor with the project $defs", async () => {
    await openAndSettle();
    pointer(navButton("Definitions"), "click");
    await flush();
    const labels = [...content().querySelectorAll(".settings-list-panel sp-action-button")].map(
      (b) => b.textContent?.trim(),
    );
    expect(labels).toContain("Author");
  });

  test("a $studio.settings contribution adds Content Types at its declared order", async () => {
    setExtensions(parserExtensions);
    await openAndSettle();
    const navLabels = [...modal()!.querySelectorAll(".settings-nav-item")].map((b) =>
      b.textContent?.trim(),
    );
    // Order 50 lands between Definitions (40) and Dependencies (60) — the historical position.
    expect(navLabels).toEqual([
      "General",
      "Head",
      "CSS Variables",
      "Definitions",
      "Content Types",
      "Dependencies",
    ]);
    pointer(navButton("Content Types"), "click");
    await flush();
    expect(content().querySelector(".settings-section-title")?.textContent).toBe("Content Types");
    expect(content().querySelector(".settings-empty-state")?.textContent).toContain(
      "Select or create an entry",
    );
  });

  test("Dependencies section renders the dependency editor", async () => {
    await openAndSettle();
    pointer(navButton("Dependencies"), "click");
    await flush();
    expect(content().querySelector(".settings-section-title")?.textContent).toBe("Dependencies");
  });
});

// ─── Close paths ─────────────────────────────────────────────────────────────

describe("close", () => {
  test("Escape inside the modal closes it", async () => {
    await openAndSettle();
    key(modal()!, "Escape");
    await flush();
    expect(modal()).toBeNull();
  });

  test("other keys inside the modal do not close it", async () => {
    await openAndSettle();
    key(modal()!, "Enter");
    await flush();
    expect(modal()).not.toBeNull();
  });

  test("the header close button closes the modal", async () => {
    await openAndSettle();
    pointer(modal()!.querySelector('.settings-modal-header [title="Close"]')!, "click");
    await flush();
    expect(modal()).toBeNull();
  });

  test("the underlay close event closes the modal", async () => {
    await openAndSettle();
    modalLayer()
      .querySelector("sp-underlay")!
      .dispatchEvent(new Event("close", { bubbles: false }));
    await flush();
    expect(modal()).toBeNull();
  });

  test("closeSettingsModal when nothing is open is a no-op", async () => {
    expect(() => closeSettingsModal()).not.toThrow();
    expect(modal()).toBeNull();
  });

  test("close before the deferred section render leaves no orphan render", async () => {
    openSettingsModal();
    // The rAF callback has not fired yet; closing first must make it a guarded no-op.
    closeSettingsModal();
    await flush(4);
    expect(modal()).toBeNull();
    expect(modalLayer().childNodes.length).toBe(0);
  });
});
