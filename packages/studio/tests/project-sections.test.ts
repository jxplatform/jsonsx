/**
 * Tests for src/settings/project-sections.ts — the Extensions, Deploy and Raw JSON sections.
 *
 * All three write through `updateSiteConfig`, so what is pinned here is the same contract the rest
 * of the settings tree keeps: the value lands in the live config AND in `project.json`, and a
 * rejected write is shown rather than dropped.
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
import { activeTab } from "../src/workspace/workspace";
import {
  BUILD_ADAPTERS,
  renderDeploySection,
  renderExtensionsSection,
  renderRawJsonSection,
} from "../src/settings/project-sections";
import type { MockPlatformState } from "./harness";
import type { StudioPlatform } from "../src/types";

type AnyConfig = Record<string, any>;

function setup(
  cfg: AnyConfig | null,
  render: (container: HTMLElement) => void,
  overrides: Partial<StudioPlatform> = {},
): { container: HTMLElement; state: MockPlatformState } {
  const { state } = installMockPlatform(overrides);
  resetStudioState({ projectConfig: cfg as unknown });
  const container = document.createElement("div");
  document.body.append(container);
  render(container);
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

/** A platform whose every write is refused. */
const failing = {
  writeFile: () => Promise.reject(new Error("EROFS: read-only file system")),
} as unknown as Partial<StudioPlatform>;

beforeEach(() => {
  resetWorkspaceWithTab();
});

// ─── Extensions ──────────────────────────────────────────────────────────────

describe("the Extensions section", () => {
  test("lists the declared packages", () => {
    const { container } = setup(
      { extensions: ["@jxsuite/parser", "@jxsuite/search"] },
      renderExtensionsSection,
    );
    const names = [...container.querySelectorAll(".settings-row-name")].map((n) => n.textContent);
    expect(names).toEqual(["@jxsuite/parser", "@jxsuite/search"]);
  });

  test("an empty array says so rather than rendering nothing", () => {
    const { container } = setup({ extensions: [] }, renderExtensionsSection);
    expect(container.querySelector(".settings-empty-state")?.textContent).toContain(
      "No extensions",
    );
  });

  test("a project with no extensions key is the empty case, not a crash", () => {
    const { container } = setup({}, renderExtensionsSection);
    expect(container.querySelector(".settings-empty-state")).not.toBeNull();
  });

  test("Add appends the package to the live config and to project.json", async () => {
    const { container, state } = setup(
      { extensions: ["@jxsuite/parser"] },
      renderExtensionsSection,
    );
    const input = container.querySelector(".settings-extension-name")!;
    (input as unknown as { value: string }).value = "  @acme/jx-guestbook  ";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    pointer([...container.querySelectorAll("sp-action-button")].at(-1)!, "click");
    await flush(4);
    expect(config().extensions).toEqual(["@jxsuite/parser", "@acme/jx-guestbook"]);
    expect(written(state).extensions).toEqual(["@jxsuite/parser", "@acme/jx-guestbook"]);
  });

  test("Enter in the name field adds it too", async () => {
    const { container } = setup({ extensions: [] }, renderExtensionsSection);
    const input = container.querySelector(".settings-extension-name")!;
    (input as unknown as { value: string }).value = "@acme/one";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }));
    await flush(4);
    expect(config().extensions).toEqual(["@acme/one"]);
  });

  test("a blank name, and one already listed, are both refused silently", async () => {
    const { container, state } = setup({ extensions: ["@acme/one"] }, renderExtensionsSection);
    const input = container.querySelector(".settings-extension-name")!;
    (input as unknown as { value: string }).value = "   ";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }));
    (input as unknown as { value: string }).value = "@acme/one";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }));
    // A key that is not Enter does nothing at all.
    input.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "a" }));
    await flush(4);
    expect(config().extensions).toEqual(["@acme/one"]);
    expect(state.files.has("project.json")).toBe(false);
  });

  test("the delete button removes one package", async () => {
    const { container } = setup(
      { extensions: ["@jxsuite/parser", "@jxsuite/search"] },
      renderExtensionsSection,
    );
    pointer(container.querySelector('[title="Remove @jxsuite/parser"]')!, "click");
    await flush(4);
    expect(config().extensions).toEqual(["@jxsuite/search"]);
  });

  test("a rejected write is shown in the section instead of being dropped", async () => {
    const { container } = setup({ extensions: ["@acme/one"] }, renderExtensionsSection, failing);
    pointer(container.querySelector('[title="Remove @acme/one"]')!, "click");
    await flush(4);
    expect(errorText(container)).toBe("Could not save project.json — EROFS: read-only file system");
  });
});

// ─── Deploy ──────────────────────────────────────────────────────────────────

describe("the Deploy section", () => {
  test("the adapter picker defaults to static and lists every adapter", () => {
    const { container } = setup({}, renderDeploySection);
    const options = [...container.querySelectorAll("sp-menu-item")].map((m) =>
      m.getAttribute("value"),
    );
    expect(options).toEqual(BUILD_ADAPTERS.map((a) => a.value));
    expect((container.querySelector("sp-picker") as unknown as { value: string }).value).toBe(
      "static",
    );
  });

  test("changing it merges into build config and persists", async () => {
    const { container, state } = setup({ build: { outDir: "dist" } }, renderDeploySection);
    const picker = container.querySelector("sp-picker")!;
    (picker as unknown as { value: string }).value = "bun";
    picker.dispatchEvent(new Event("change", { bubbles: true }));
    await flush(4);
    expect(config().build).toEqual({ adapter: "bun", outDir: "dist" });
    expect(written(state).build.adapter).toBe("bun");
  });

  test("a rejected write is shown under the section title", async () => {
    const { container } = setup({ build: { adapter: "static" } }, renderDeploySection, failing);
    const picker = container.querySelector("sp-picker")!;
    (picker as unknown as { value: string }).value = "node";
    picker.dispatchEvent(new Event("change", { bubbles: true }));
    await flush(4);
    const shown = container.querySelector(".settings-field-error")!;
    expect(shown.previousElementSibling?.tagName.toLowerCase()).toBe("h3");
  });

  test("a later success clears the error", async () => {
    const { container } = setup({ build: {} }, renderDeploySection, failing);
    const fire = (value: string) => {
      const picker = container.querySelector("sp-picker")!;
      (picker as unknown as { value: string }).value = value;
      picker.dispatchEvent(new Event("change", { bubbles: true }));
    };
    fire("node");
    await flush(4);
    expect(errorText(container)).toBeDefined();
    installMockPlatform();
    fire("bun");
    await flush(4);
    expect(errorText(container)).toBeUndefined();
  });
});

// ─── Raw JSON ────────────────────────────────────────────────────────────────

describe("the Raw JSON section", () => {
  test("shows the file exactly as the chokepoint serialises it", () => {
    const { container } = setup({ extensions: [], name: "Bistro" }, renderRawJsonSection);
    expect(container.querySelector(".settings-raw-json")?.textContent).toBe(
      '{\n  "extensions": [],\n  "name": "Bistro"\n}',
    );
  });

  test("Edit as code switches the same tab to the Code editor", () => {
    const { container } = setup({ name: "Bistro" }, renderRawJsonSection);
    pointer(container.querySelector(".settings-edit-as-code")!, "click");
    expect(activeTab.value?.session.ui.canvasMode).toBe("source");
  });

  test("with no project open it renders an empty object rather than throwing", () => {
    const { container } = setup(null, renderRawJsonSection);
    expect(container.querySelector(".settings-raw-json")?.textContent).toBe("{}");
  });
});
