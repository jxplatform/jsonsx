/**
 * Integration tests for the secret commit path: a contributed section whose descriptor marks a
 * field with the "secret" control stores the typed VALUE via platform.setSecrets under a derived
 * env name and persists only the env NAME to project.json (specs/extensions.md §13). Also covers
 * the ContributedSectionOptions.actions slot carrying the data-domain actions.
 */
import { flush, installMockPlatform, pointer, resetStudioState } from "./harness";
import { beforeEach, describe, expect, test } from "bun:test";
import "../src/ui/form-controls";
import {
  renderContributedSection,
  resetContributedSectionState,
} from "../src/settings/contributed-section";
import { dataSectionActions, resetDataGridState } from "../src/panels/data-grid";
import { initLayers } from "../src/ui/layers";
import { projectState } from "../src/store";
import type { MockPlatformState } from "./harness";
import type { SecretsSetRequest, StudioPlatform } from "../src/types";
import type { SettingsContribution } from "../src/settings/contributed-section";

for (const id of ["layer-popover", "layer-modal", "layer-dialog"]) {
  if (!document.querySelector(`#${id}`)) {
    const el = document.createElement("div");
    el.id = id;
    document.body.append(el);
  }
}
initLayers();

const CONNECTIONS_CONTRIBUTION: SettingsContribution = {
  entrySchema: {
    properties: {
      provider: { type: "string" },
      urlEnv: { type: "string" },
    },
    type: "object",
  },
  key: "connections",
  settings: {
    entry: { ui: { urlEnv: { control: "secret" } } },
    layout: "map",
  },
  title: "Connections",
};

function commitValue(el: Element, value: string): void {
  (el as HTMLElement & { value: string }).value = value;
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

function config(): Record<string, unknown> {
  return projectState!.projectConfig as unknown as Record<string, unknown>;
}

let container: HTMLElement;

function mount(
  overrides: Partial<StudioPlatform> = {},
  opts: Parameters<typeof renderContributedSection>[2] = {},
): MockPlatformState {
  const { state } = installMockPlatform(overrides);
  container = document.createElement("div");
  renderContributedSection(container, CONNECTIONS_CONTRIBUTION, opts);
  return state;
}

function selectEntry(name: string): void {
  const button = [...container.querySelectorAll(".settings-list-panel sp-action-button")].find(
    (b) => b.textContent?.trim() === name,
  );
  expect(button).toBeDefined();
  pointer(button!, "click");
}

beforeEach(() => {
  resetContributedSectionState();
  resetDataGridState();
  resetStudioState({
    projectConfig: { connections: { main: { provider: "supabase" } }, name: "Site" },
  });
});

describe("secret control inside a contributed section", () => {
  test("stores the VALUE via setSecrets and the derived env NAME in project.json", async () => {
    const secretWrites: SecretsSetRequest[] = [];
    const state = mount({
      setSecrets: async (req) => {
        secretWrites.push(req);
        return { names: Object.keys(req.set ?? {}), ok: true };
      },
    });
    selectEntry("main");
    const field = container.querySelector(".secret-field")!;
    expect(field.hasAttribute("disabled")).toBe(false);
    expect(field.getAttribute("placeholder")).toBe("Not set");

    commitValue(field, "postgres://user:pw@host/db");
    await flush();

    // The VALUE went to the platform secret store under the derived env name…
    expect(secretWrites).toEqual([{ set: { MAIN_URL: "postgres://user:pw@host/db" } }]);
    // …and project.json carries only the NAME.
    const connections = config().connections as Record<string, Record<string, unknown>>;
    expect(connections.main!.urlEnv).toBe("MAIN_URL");
    const written = state.calls.find((c) => c[0] === "writeFile" && c[1] === "project.json");
    expect(written).toBeDefined();
    expect(written![2] as string).toContain('"urlEnv": "MAIN_URL"');
    expect(written![2] as string).not.toContain("postgres://");

    // The rerendered field advertises where the secret lives.
    const after = container.querySelector(".secret-field")!;
    expect(after.getAttribute("placeholder")).toBe("Stored as MAIN_URL");
  });

  test("renders disabled when the platform has no setSecrets surface", () => {
    mount();
    selectEntry("main");
    const field = container.querySelector(".secret-field")!;
    expect(field.hasAttribute("disabled")).toBe(true);
  });
});

describe("actions slot", () => {
  test("data-domain actions render under the section title via opts.actions", () => {
    // The platform must be data-capable BEFORE resolving the actions renderer.
    installMockPlatform({
      dataConnectionTest: async () => ({ ok: true }),
      dataPush: async () => ({ applied: true, plan: [] }),
      dataRows: async () => ({ columns: [], rows: [], total: 0 }),
    });
    const actions = dataSectionActions("connections");
    expect(actions).not.toBeNull();
    container = document.createElement("div");
    renderContributedSection(container, CONNECTIONS_CONTRIBUTION, { actions: actions! });
    expect(container.querySelector(".data-section-actions")).not.toBeNull();
    expect(container.querySelector(".data-action-push")).not.toBeNull();
    // No entry selected yet: Test Connection is present but disabled.
    expect(container.querySelector(".data-action-test")!.hasAttribute("disabled")).toBe(true);
    selectEntry("main");
    expect(container.querySelector(".data-action-test")!.hasAttribute("disabled")).toBe(false);
  });

  test("sections without an actions option render actions-free", () => {
    mount();
    expect(container.querySelector(".data-section-actions")).toBeNull();
  });
});
