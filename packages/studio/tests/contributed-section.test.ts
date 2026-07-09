/**
 * Tests for src/settings/contributed-section.ts — the generic renderer for `$studio.settings`
 * sections: form layout (schema form over the whole section value) and map layout (master-detail
 * with add/rename/delete, slugified keys, and newEntry templates), both persisting through
 * projectState.projectConfig + platform.writeFile("project.json", …).
 */
import { flush, installMockPlatform, key, pointer, resetStudioState } from "./harness";
import { beforeEach, describe, expect, test } from "bun:test";
import { html } from "lit-html";
import {
  renderContributedSection,
  resetContributedSectionState,
} from "../src/settings/contributed-section";
import { registerFormControl } from "../src/ui/schema-form";
import { projectState } from "../src/store";
import type { MockPlatformState } from "./harness";
import type { SettingsContribution } from "../src/settings/contributed-section";

type ValueEl = HTMLElement & { value: string };

function commitValue(el: Element, value: string): void {
  (el as ValueEl).value = value;
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

function inputValue(el: Element, value: string): void {
  (el as ValueEl).value = value;
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

function buttonByText(scope: HTMLElement, text: string): Element {
  const el = [...scope.querySelectorAll("sp-action-button")].find(
    (b) => b.textContent?.trim() === text,
  );
  if (!el) {
    throw new Error(`no button "${text}"`);
  }
  return el;
}

function config(): Record<string, unknown> {
  return projectState!.projectConfig as unknown as Record<string, unknown>;
}

/** Project.json writes captured by the mock platform. */
function projectWrites(state: MockPlatformState): string[] {
  return state.calls
    .filter((c) => c[0] === "writeFile" && c[1] === "project.json")
    .map((c) => c[2] as string);
}

let platformState: MockPlatformState;
let container: HTMLElement;

beforeEach(() => {
  resetContributedSectionState();
  ({ state: platformState } = installMockPlatform());
  resetStudioState({
    projectConfig: {
      connections: { main: { provider: "d1" } },
      name: "site",
    } as unknown,
  });
  container = document.createElement("div");
});

// ─── Form layout ─────────────────────────────────────────────────────────────

const formContribution: SettingsContribution = {
  entrySchema: {
    properties: {
      enabled: { type: "boolean" },
      id: { type: "string" },
      mode: { enum: ["auto", "manual"] },
    },
  },
  key: "analytics",
  settings: { layout: "form" },
  title: "Analytics",
};

describe("form layout", () => {
  test("renders the title and one form over the section value", () => {
    renderContributedSection(container, formContribution);
    expect(container.querySelector(".settings-section-title")?.textContent).toBe("Analytics");
    expect(container.querySelectorAll(".settings-form-panel .style-row")).toHaveLength(3);
    expect(container.querySelector('[data-prop="enabled"] sp-checkbox')).not.toBeNull();
    expect(container.querySelector('[data-prop="mode"] sp-picker')).not.toBeNull();
  });

  test("title falls back to the section key", () => {
    renderContributedSection(container, { ...formContribution, title: undefined });
    expect(container.querySelector(".settings-section-title")?.textContent).toBe("analytics");
  });

  test("edits mutate projectConfig[key] and persist via writeFile", async () => {
    renderContributedSection(container, formContribution);
    const check = container.querySelector('[data-prop="enabled"] sp-checkbox') as HTMLElement & {
      checked: boolean;
    };
    check.checked = true;
    check.dispatchEvent(new Event("change", { bubbles: true }));
    await flush();

    expect(config().analytics).toEqual({ enabled: true });
    const writes = projectWrites(platformState);
    expect(writes).toHaveLength(1);
    expect(JSON.parse(writes[0]!)).toMatchObject({ analytics: { enabled: true } });
  });

  test("undefined patches unset keys; the form rerenders with current values", async () => {
    config().analytics = { mode: "auto" };
    renderContributedSection(container, formContribution);
    const picker = container.querySelector('[data-prop="mode"] sp-picker') as ValueEl;
    expect(picker.getAttribute("value")).toBe("auto");
    commitValue(picker, "__none__");
    await flush();
    expect(config().analytics).toEqual({});
    expect(projectWrites(platformState)).toHaveLength(1);
  });

  test("entry.ui control overrides apply to the form", () => {
    registerFormControl(
      "stub-section-control",
      ({ key: prop }) => html`<div class="stub-section-control">${prop}</div>`,
    );
    renderContributedSection(container, {
      ...formContribution,
      settings: { entry: { ui: { id: { control: "stub-section-control" } } }, layout: "form" },
    });
    expect(container.querySelector(".stub-section-control")?.textContent).toBe("id");
  });

  test("renders without a project config and drops edits silently", () => {
    resetStudioState({ projectConfig: null });
    renderContributedSection(container, formContribution);
    const check = container.querySelector('[data-prop="enabled"] sp-checkbox') as HTMLElement & {
      checked: boolean;
    };
    check.checked = true;
    check.dispatchEvent(new Event("change", { bubbles: true }));
    expect(projectWrites(platformState)).toHaveLength(0);
  });
});

// ─── Map layout ──────────────────────────────────────────────────────────────

const mapContribution: SettingsContribution = {
  entrySchema: {
    properties: {
      label: { type: "string" },
      provider: { enum: ["d1", "sqlite"] },
    },
  },
  key: "connections",
  settings: {
    entry: {
      newEntry: { label: "${key} connection", nested: { source: "./data/${key}" }, provider: "d1" },
    },
    layout: "map",
  },
  title: "Connections",
};

describe("map layout", () => {
  test("lists entry keys on the left with an empty state until one is selected", () => {
    renderContributedSection(container, mapContribution);
    const keys = [...container.querySelectorAll(".settings-list-panel sp-action-button")]
      .map((b) => b.textContent?.trim())
      .filter((t) => t !== "New Entry");
    expect(keys).toEqual(["main"]);
    expect(container.querySelector(".settings-empty-state")).not.toBeNull();
  });

  test("selecting an entry renders its form; edits persist to the entry", async () => {
    renderContributedSection(container, mapContribution);
    pointer(buttonByText(container, "main"), "click");
    expect(container.querySelector(".settings-editor-panel")).not.toBeNull();

    const picker = container.querySelector('[data-prop="provider"] sp-picker') as ValueEl;
    expect(picker.getAttribute("value")).toBe("d1");
    commitValue(picker, "sqlite");
    await flush();

    expect(config().connections).toEqual({ main: { provider: "sqlite" } });
    expect(projectWrites(platformState)).toHaveLength(1);
  });

  test("creates slugified entries from the newEntry template with ${key} substitution", async () => {
    renderContributedSection(container, mapContribution);
    pointer(buttonByText(container, "New Entry"), "click");

    const nameField = container.querySelector(".settings-inline-form sp-textfield")!;
    inputValue(nameField, "My DB!");
    pointer(buttonByText(container, "Create"), "click");
    await flush();

    expect((config().connections as Record<string, unknown>)["my-db"]).toEqual({
      label: "my-db connection",
      nested: { source: "./data/my-db" },
      provider: "d1",
    });
    // The new entry is selected and editable
    expect((container.querySelector(".entry-name-input") as ValueEl).getAttribute("value")).toBe(
      "my-db",
    );
    expect(projectWrites(platformState)).toHaveLength(1);
  });

  test("Enter creates, Escape closes, blanks and duplicates are ignored", async () => {
    renderContributedSection(container, mapContribution);
    pointer(buttonByText(container, "New Entry"), "click");
    const nameField = () => container.querySelector(".settings-inline-form sp-textfield")!;

    inputValue(nameField(), "!!!");
    key(nameField(), "Enter");
    expect(Object.keys(config().connections as Record<string, unknown>)).toEqual(["main"]);

    inputValue(nameField(), "main");
    key(nameField(), "Enter");
    expect(Object.keys(config().connections as Record<string, unknown>)).toEqual(["main"]);

    key(nameField(), "Escape");
    expect(container.querySelector(".settings-inline-form")).toBeNull();

    pointer(buttonByText(container, "New Entry"), "click");
    inputValue(nameField(), "Backup Store");
    key(nameField(), "Enter");
    await flush();
    expect(Object.keys(config().connections as Record<string, unknown>)).toEqual([
      "main",
      "backup-store",
    ]);
  });

  test("renames slugify, preserve entry order, and skip collisions", async () => {
    config().connections = { alpha: { provider: "d1" }, beta: { provider: "sqlite" } };
    renderContributedSection(container, mapContribution);
    pointer(buttonByText(container, "alpha"), "click");

    commitValue(container.querySelector(".entry-name-input")!, "Primary DB");
    await flush();
    expect(Object.keys(config().connections as Record<string, unknown>)).toEqual([
      "primary-db",
      "beta",
    ]);
    expect(projectWrites(platformState)).toHaveLength(1);

    // Renaming onto an existing key (or to a blank slug) is ignored
    commitValue(container.querySelector(".entry-name-input")!, "beta");
    commitValue(container.querySelector(".entry-name-input")!, "!!!");
    expect(Object.keys(config().connections as Record<string, unknown>)).toEqual([
      "primary-db",
      "beta",
    ]);
    expect(projectWrites(platformState)).toHaveLength(1);
    expect((container.querySelector(".entry-name-input") as ValueEl).value).toBe("primary-db");
  });

  test("delete removes the entry and returns to the empty state", async () => {
    renderContributedSection(container, mapContribution);
    pointer(buttonByText(container, "main"), "click");
    pointer(container.querySelector('[title="Delete entry"]')!, "click");
    await flush();

    expect(config().connections).toEqual({});
    expect(container.querySelector(".settings-empty-state")).not.toBeNull();
    expect(projectWrites(platformState)).toHaveLength(1);
  });

  test("entry.ui overrides apply to the entry form", () => {
    registerFormControl(
      "stub-entry-control",
      ({ value }) => html`<div class="stub-entry-control">${String(value)}</div>`,
    );
    renderContributedSection(container, {
      ...mapContribution,
      settings: {
        entry: { ui: { provider: { control: "stub-entry-control" } } },
        layout: "map",
      },
    });
    pointer(buttonByText(container, "main"), "click");
    expect(container.querySelector(".stub-entry-control")?.textContent).toBe("d1");
  });

  test("creates the section object on demand when missing", () => {
    delete config().connections;
    renderContributedSection(container, mapContribution);
    expect(container.querySelector(".settings-empty-state")).not.toBeNull();
    expect(config().connections).toEqual({});
  });
});
