/**
 * Tests for the settings-modal section registry — built-in registration order, custom section
 * registration/ordering, replacement semantics, and rendering of registered sections.
 */
import { flush, installMockPlatform, pointer, resetStudioState } from "./harness";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { html, render } from "lit-html";
import {
  closeSettingsModal,
  openSettingsModal,
  registerSettingsSection,
  unregisterSettingsSection,
} from "../src/settings/settings-modal";
import { initLayers } from "../src/ui/layers";

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

function modal(): HTMLElement | null {
  return (document.querySelector("#layer-modal") as HTMLElement).querySelector(".settings-modal");
}

function navLabels(): (string | undefined)[] {
  return [...modal()!.querySelectorAll(".settings-nav-item")].map((b) => b.textContent?.trim());
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

// Content Types is no longer built-in — @jxsuite/parser contributes it via $studio.settings.
const BUILTIN_LABELS = ["General", "Head", "CSS Variables", "Definitions", "Dependencies"];

beforeEach(() => {
  installMockPlatform();
  resetStudioState({ projectConfig: { content: {} } as unknown });
});

afterEach(async () => {
  closeSettingsModal();
  await flush();
});

describe("built-in sections", () => {
  test("register at module init in the historical display order", async () => {
    openSettingsModal();
    await flush(4);
    expect(navLabels()).toEqual(BUILTIN_LABELS);
  });
});

describe("registerSettingsSection", () => {
  test("custom sections slot into the nav by order and render on click", async () => {
    const rendered: HTMLElement[] = [];
    registerSettingsSection({
      icon: "sp-icon-plug",
      key: "customSection",
      label: "Custom",
      order: 35,
      render: (container) => {
        rendered.push(container);
        render(html`<div class="custom-section-body">Hello custom</div>`, container);
      },
    });

    openSettingsModal();
    await flush(4);
    // Order 35 lands between CSS Variables (30) and Definitions (40)
    expect(navLabels()).toEqual([
      "General",
      "Head",
      "CSS Variables",
      "Custom",
      "Definitions",
      "Dependencies",
    ]);

    pointer(navButton("Custom"), "click");
    await flush();
    expect(navButton("Custom").classList.contains("active")).toBe(true);
    // Nav clicks render the modal shell and then the section (ref re-render included)
    expect(rendered.length).toBeGreaterThanOrEqual(1);
    expect(rendered.every((el) => el.classList.contains("settings-modal-content"))).toBe(true);
    expect(modal()!.querySelector(".custom-section-body")?.textContent).toBe("Hello custom");
  });

  test("re-registering a key replaces the section instead of duplicating it", async () => {
    registerSettingsSection({
      key: "customSection",
      label: "Custom v2",
      order: 70,
      render: (container) => {
        render(html`<div class="custom-v2">v2</div>`, container);
      },
    });

    openSettingsModal();
    await flush(4);
    expect(navLabels()).toEqual([...BUILTIN_LABELS, "Custom v2"]);

    pointer(navButton("Custom v2"), "click");
    await flush();
    expect(modal()!.querySelector(".custom-v2")).not.toBeNull();
  });

  test("built-ins still render through the registry (General active by default)", async () => {
    openSettingsModal();
    await flush(4);
    expect(navButton("General").classList.contains("active")).toBe(true);
    expect(
      modal()!.querySelector(".settings-modal-content .settings-section-title")?.textContent,
    ).toBe("General");
  });
});

describe("unregisterSettingsSection", () => {
  test("removes a registered section and resets an active selection to General", async () => {
    // The registry is module-global — drop the custom section earlier tests registered.
    unregisterSettingsSection("customSection");
    registerSettingsSection({
      key: "ephemeral",
      label: "Ephemeral",
      order: 55,
      render: (container) => {
        render(html`<div class="ephemeral-body">gone soon</div>`, container);
      },
    });
    openSettingsModal();
    await flush(4);
    pointer(navButton("Ephemeral"), "click");
    await flush();
    expect(navButton("Ephemeral").classList.contains("active")).toBe(true);

    unregisterSettingsSection("ephemeral");
    closeSettingsModal();
    await flush();
    openSettingsModal();
    await flush(4);
    expect(navLabels()).toEqual(BUILTIN_LABELS);
    expect(navButton("General").classList.contains("active")).toBe(true);
  });

  test("unregistering an unknown key is a no-op", () => {
    expect(() => unregisterSettingsSection("never-registered")).not.toThrow();
  });
});
