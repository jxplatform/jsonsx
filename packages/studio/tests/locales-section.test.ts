/**
 * Tests for src/settings/locales-section.ts — the Locales settings section and `addProjectLocale`.
 *
 * Every write is asserted TWICE: against the live config and against `project.json` as it was
 * serialized. The two can disagree — `commitProjectConfig` merges at the top level only — and the
 * failure mode that matters here is a patch that lands in memory having quietly dropped
 * `defaultLocale` or `routing` from the file.
 */
import {
  flush,
  installMockPlatform,
  pointer,
  resetStudioState,
  resetWorkspaceWithTab,
} from "./harness";
import { beforeEach, describe, expect, test } from "bun:test";
import { projectState } from "../src/store";
import {
  addProjectLocale,
  LOCALE_ROUTINGS,
  renderLocalesSection,
} from "../src/settings/locales-section";
import { clearProblems, problems, toasts } from "../src/services/notify";
import type { MockPlatformState } from "./harness";
import type { StudioPlatform } from "../src/types";

type AnyConfig = Record<string, any>;

function setup(
  cfg: AnyConfig | null,
  overrides: Partial<StudioPlatform> = {},
): { container: HTMLElement; state: MockPlatformState } {
  const { state } = installMockPlatform(overrides);
  resetStudioState({ projectConfig: cfg as unknown });
  const container = document.createElement("div");
  document.body.append(container);
  renderLocalesSection(container);
  return { container, state };
}

function config(): AnyConfig {
  return (projectState as AnyConfig).projectConfig;
}

function written(state: MockPlatformState): AnyConfig {
  return JSON.parse(state.files.get("project.json")!) as AnyConfig;
}

function errorText(container: HTMLElement): string | undefined {
  return container.querySelector(".settings-field-error")?.textContent?.trim();
}

/** Type into the add field, the way the author does. */
function typeTag(container: HTMLElement, value: string): void {
  const input = container.querySelector(".settings-locale-name")!;
  (input as unknown as { value: string }).value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

/** Press Add. Re-queried after every render — the button is a new element each time. */
function pressAdd(container: HTMLElement): void {
  pointer([...container.querySelectorAll("sp-action-button")].at(-1)!, "click");
}

/** A platform whose every write is refused. */
const failing = {
  writeFile: () => Promise.reject(new Error("EROFS: read-only file system")),
} as unknown as Partial<StudioPlatform>;

beforeEach(() => {
  resetWorkspaceWithTab();
  toasts.length = 0;
  clearProblems();
});

describe("the Locales section", () => {
  test("lists each declared language by its own name, beside its tag", () => {
    const { container } = setup({ i18n: { defaultLocale: "en", locales: ["en", "fr"] } });
    expect([...container.querySelectorAll(".settings-row-name")].map((n) => n.textContent)).toEqual(
      ["English", "français"],
    );
    expect(
      [...container.querySelectorAll(".settings-locale-tag")].map((n) => n.textContent),
    ).toEqual(["en", "fr"]);
  });

  test("a project with no i18n block is the empty case, not a crash", () => {
    const { container } = setup({});
    expect(container.querySelector(".settings-empty-state")?.textContent).toContain("No languages");
    expect(container.querySelector("sp-picker")?.hasAttribute("disabled")).toBe(true);
  });

  test("Add appends the canonical tag to the live config and to project.json", async () => {
    const { container, state } = setup({ i18n: { locales: ["en"] } });
    typeTag(container, "  FR-ca  ");
    pressAdd(container);
    await flush(4);
    expect(config().i18n.locales).toEqual(["en", "fr-CA"]);
    expect(written(state).i18n.locales).toEqual(["en", "fr-CA"]);
  });

  test("Enter in the field adds it too", async () => {
    const { container } = setup({ i18n: { locales: ["en"] } });
    typeTag(container, "de");
    container
      .querySelector(".settings-locale-name")!
      .dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }));
    await flush(4);
    expect(config().i18n.locales).toEqual(["en", "de"]);
  });

  test("the sibling keys survive the add — the merge is top-level only", async () => {
    const { container, state } = setup({
      i18n: { defaultLocale: "en", locales: ["en"], routing: "prefix-always" },
    });
    typeTag(container, "fr");
    pressAdd(container);
    await flush(4);
    expect(written(state).i18n).toEqual({
      defaultLocale: "en",
      locales: ["en", "fr"],
      routing: "prefix-always",
    });
  });

  test("a malformed tag is refused with words and writes nothing", async () => {
    const { container, state } = setup({ i18n: { locales: ["en"] } });
    typeTag(container, "en_US");
    await flush(2);
    expect(errorText(container)).toContain("not a well-formed language tag");
    pressAdd(container);
    await flush(4);
    expect(config().i18n.locales).toEqual(["en"]);
    expect(state.files.has("project.json")).toBe(false);
  });

  test("a tag already declared says so and is not added twice", async () => {
    const { container, state } = setup({ i18n: { locales: ["en"] } });
    typeTag(container, "EN");
    await flush(2);
    expect(errorText(container)).toContain("already declared");
    pressAdd(container);
    await flush(4);
    expect(config().i18n.locales).toEqual(["en"]);
    expect(state.files.has("project.json")).toBe(false);
  });

  test("a blank field adds nothing and shows nothing", async () => {
    const { container, state } = setup({ i18n: { locales: ["en"] } });
    typeTag(container, "   ");
    await flush(2);
    expect(errorText(container)).toBeUndefined();
    pressAdd(container);
    await flush(4);
    expect(state.files.has("project.json")).toBe(false);
  });

  test("removing a language keeps the rest and the block", async () => {
    const { container, state } = setup({
      i18n: { defaultLocale: "en", locales: ["en", "fr", "de"] },
    });
    pointer(container.querySelector('[title="Remove fr"]')!, "click");
    await flush(4);
    expect(config().i18n.locales).toEqual(["en", "de"]);
    expect(written(state).i18n.defaultLocale).toBe("en");
  });

  test("removing the default language moves the default rather than orphaning it", async () => {
    const { container, state } = setup({ i18n: { defaultLocale: "en", locales: ["en", "fr"] } });
    pointer(container.querySelector('[title="Remove en"]')!, "click");
    await flush(4);
    // Left alone, `resolveI18n` would unshift "en" back into the list and the removal would do
    // Nothing at all.
    expect(written(state).i18n).toEqual({ defaultLocale: "fr", locales: ["fr"] });
  });

  test("removing the last language removes the whole block", async () => {
    const { container, state } = setup({
      i18n: { defaultLocale: "fr", locales: ["fr"], routing: "prefix-always" },
    });
    pointer(container.querySelector('[title="Remove fr"]')!, "click");
    await flush(4);
    expect(config().i18n).toBeUndefined();
    expect("i18n" in written(state)).toBe(false);
  });

  test("the default picker offers the declared list and persists a choice", async () => {
    const { container, state } = setup({ i18n: { locales: ["en", "fr"] } });
    const picker = container.querySelector(".settings-default-locale")!;
    expect(
      [...picker.querySelectorAll("sp-menu-item")].map((m) => m.getAttribute("value")),
    ).toEqual(["en", "fr"]);
    (picker as unknown as { value: string }).value = "fr";
    picker.dispatchEvent(new Event("change", { bubbles: true }));
    await flush(4);
    expect(config().i18n.defaultLocale).toBe("fr");
    expect(written(state).i18n).toEqual({ defaultLocale: "fr", locales: ["en", "fr"] });
  });

  test("the routing picker offers both modes and persists a choice", async () => {
    const { container, state } = setup({ i18n: { defaultLocale: "en", locales: ["en", "fr"] } });
    const picker = container.querySelector(".settings-locale-routing")!;
    expect(
      [...picker.querySelectorAll("sp-menu-item")].map((m) => m.getAttribute("value")),
    ).toEqual(LOCALE_ROUTINGS.map((r) => r.value));
    (picker as unknown as { value: string }).value = "prefix-always";
    picker.dispatchEvent(new Event("change", { bubbles: true }));
    await flush(4);
    expect(config().i18n.routing).toBe("prefix-always");
    expect(written(state).i18n.defaultLocale).toBe("en");
  });

  test("a rejected write is shown under the title instead of being dropped", async () => {
    const { container } = setup({ i18n: { locales: ["en", "fr"] } }, failing);
    pointer(container.querySelector('[title="Remove fr"]')!, "click");
    await flush(4);
    const shown = container.querySelector('[role="alert"]')!;
    expect(shown.textContent).toContain("EROFS: read-only file system");
    // A direct child of the section, not of a field: the whole file failed to save, so the message
    // Belongs under the title rather than pinned to one control.
    expect(shown.parentElement?.className).toBe("settings-section");
  });

  test("a later success clears the parked error", async () => {
    const { container, state } = setup({ i18n: { locales: ["en", "fr"] } }, failing);
    pointer(container.querySelector('[title="Remove fr"]')!, "click");
    await flush(4);
    expect(container.querySelector('[role="alert"]')).not.toBeNull();

    /* The failed remove still landed in MEMORY — `commitProjectConfig` mutates and then writes, so
       the parked error is the only thing telling the author that the file disagrees. */
    expect(config().i18n.locales).toEqual(["en"]);

    const { state: writable } = installMockPlatform();
    typeTag(container, "de");
    pressAdd(container);
    await flush(4);
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(config().i18n.locales).toEqual(["en", "de"]);
    expect(written(writable).i18n.locales).toEqual(["en", "de"]);
    expect(state.files.has("project.json")).toBe(false);
  });
});

describe("addProjectLocale — the write both doors make", () => {
  test("declares the first language of a project that had no i18n block", async () => {
    const { state } = installMockPlatform();
    resetStudioState({ projectConfig: {} });
    await addProjectLocale("pt-br");
    expect(config().i18n).toEqual({ locales: ["pt-BR"] });
    expect(written(state).i18n.locales).toEqual(["pt-BR"]);
  });

  test("spreads the parent, so defaultLocale and routing survive", async () => {
    const { state } = installMockPlatform();
    resetStudioState({
      projectConfig: { i18n: { defaultLocale: "en", locales: ["en"], routing: "prefix-always" } },
    });
    await addProjectLocale("fr");
    expect(written(state).i18n).toEqual({
      defaultLocale: "en",
      locales: ["en", "fr"],
      routing: "prefix-always",
    });
  });

  test("a malformed tag is notified, never written", async () => {
    const { state } = installMockPlatform();
    resetStudioState({ projectConfig: { i18n: { locales: ["en"] } } });
    await addProjectLocale("en US");
    expect(config().i18n.locales).toEqual(["en"]);
    expect(state.files.has("project.json")).toBe(false);
    // `error` files a Problem rather than a toast — a refusal that must be fixed, not one that
    // Rests and fades.
    expect(problems.some((p) => p.message.includes("not a well-formed language tag"))).toBe(true);
  });

  test("a tag already declared in another case is a no-op that says so", async () => {
    const { state } = installMockPlatform();
    resetStudioState({ projectConfig: { i18n: { locales: ["FR-ca"] } } });
    await addProjectLocale("fr-CA");
    expect(config().i18n.locales).toEqual(["FR-ca"]);
    expect(state.files.has("project.json")).toBe(false);
    expect(toasts.some((t) => t.message.includes("already one of this project's"))).toBe(true);
  });

  test("a failed write rejects, so a caller can park it on the control that caused it", async () => {
    installMockPlatform(failing);
    resetStudioState({ projectConfig: { i18n: { locales: ["en"] } } });
    expect(addProjectLocale("fr")).rejects.toThrow(/EROFS/);
  });
});
