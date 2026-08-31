/**
 * Tests for src/settings/project-sections.ts — the Deploy and Raw JSON sections.
 *
 * Both write through `updateSiteConfig`, so what is pinned here is the same contract the rest of
 * the settings tree keeps: the value lands in the live config AND in `project.json`, and a rejected
 * write is shown rather than dropped. Extensions moved to `extensions-section.test.ts` when it grew
 * a catalogue and an install path.
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
