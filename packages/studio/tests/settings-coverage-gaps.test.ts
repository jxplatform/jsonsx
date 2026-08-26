/**
 * Coverage-gap tests for the settings section renderers:
 *
 * - Dependencies-editor: listPackages failure, capability-gated no-ops, blank add, failed
 *   update/update-all/reinstall (progress-modal error view), and busy re-entrancy.
 * - Css-vars-editor: font/size row deletion and the scheme-override color swatch input.
 * - Contributed-section: template-less newEntry, array/number template leaves, stale delete clicks,
 *   and the entry-name keydown (Enter/Escape) handling.
 */
import { flush, installMockPlatform, key, pointer, resetStudioState } from "./harness";
import { problems, resetNotifications } from "../src/services/notify";
import { resetActivities } from "../src/panels/activity-panel";
import { afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import type { MockPlatformState } from "./harness";
import type { SettingsContribution } from "../src/settings/contributed-section";

void mock.module("../src/version", () => ({
  APP_NAME: "Jx Studio",
  BUILD_DATE: "",
  GIT_COMMIT: "test",
  LINKS: { docs: "", github: "", license: "" },
  VERSION: "0.30.1",
}));

const { initLayers } = await import("../src/ui/layers");
const { maybePromptJxsuiteUpdate } = await import("../src/packages/jxsuite-update");
const { renderDependenciesEditor } = await import("../src/settings/dependencies-editor");
const { renderCssVarsEditor } = await import("../src/settings/css-vars-editor");
const { renderContributedSection, resetContributedSectionState } =
  await import("../src/settings/contributed-section");
// Namespace import keeps the `projectState` binding live across resetStudioState calls.
const store = await import("../src/store");

type ValueEl = HTMLElement & { value: string };

beforeAll(() => {
  for (const id of ["layer-popover", "layer-modal", "layer-dialog"]) {
    if (!document.querySelector(`#${id}`)) {
      const el = document.createElement("div");
      el.id = id;
      document.body.append(el);
    }
  }
  initLayers();
});

afterEach(() => {
  resetNotifications();
  resetActivities();
  for (const d of document.querySelectorAll("body > div")) {
    if (!d.id) {
      d.remove();
    }
  }
  (document.querySelector("#layer-modal") as HTMLElement).innerHTML = "";
});

function makeContainer(): HTMLElement {
  const c = document.createElement("div");
  document.body.append(c);
  return c;
}

function buttonByText(scope: HTMLElement, text: string): HTMLElement {
  const el = [...scope.querySelectorAll("sp-action-button")].find(
    (b) => b.textContent?.trim() === text,
  );
  if (!el) {
    throw new Error(`no button "${text}"`);
  }
  return el as HTMLElement;
}

function modalLayer(): HTMLElement {
  return document.querySelector("#layer-modal") as HTMLElement;
}

// ─── Dependencies editor ─────────────────────────────────────────────────────

const TWO_DEPS = {
  listPackages: async () => [
    { dev: true, name: "@jxsuite/compiler", version: "^0.19.0" },
    { name: "hono", version: "^4.0.0" },
  ],
  packageVersions: async () => [{ current: "^4.0.0", latest: "4.6.0", name: "hono" }],
};

describe("dependencies editor gaps", () => {
  test("listPackages failure falls back to the empty state", async () => {
    installMockPlatform({
      listPackages: async () => {
        throw new Error("bun pm ls failed");
      },
    });
    const c = makeContainer();
    renderDependenciesEditor(c);
    await flush();
    expect(c.querySelector(".about-muted")?.textContent).toContain("No dependencies");
  });

  test("packageVersions failure keeps the table without latest versions", async () => {
    installMockPlatform({
      listPackages: TWO_DEPS.listPackages,
      packageVersions: async () => {
        throw new Error("registry unreachable");
      },
    });
    const c = makeContainer();
    renderDependenciesEditor(c);
    await flush();
    const rows = [...c.querySelectorAll("sp-table-row")];
    expect(rows).toHaveLength(2);
    // The rows still list; with no registry answer every Latest cell reads — and nothing is
    // Offered as an update. A best-effort lookup that fails must not invent a target.
    const cells = [...c.querySelectorAll("sp-table-row sp-table-cell")];
    expect(cells.some((cell) => cell.textContent?.includes("4.6.0"))).toBe(false);
    expect(c.querySelector('sp-action-button[title^="Update to"]')).toBeNull();
  });

  test("update, update all, and reinstall are no-ops without platform capabilities", async () => {
    const { state } = installMockPlatform(TWO_DEPS);
    const c = makeContainer();
    renderDependenciesEditor(c);
    await flush();
    pointer(c.querySelector('sp-action-button[title="Update to 4.6.0"]')!, "click");
    pointer(buttonByText(c, "Update all"), "click");
    pointer(c.querySelector('sp-action-button[title="Reinstall (bun install)"]')!, "click");
    await flush();
    // No capability → no busy run, no progress modal, no writes.
    expect(modalLayer().querySelector(".progress-modal")).toBeNull();
    expect(state.calls.some(([name]) => name === "writeFile")).toBe(false);
  });

  test("add with a blank name is a no-op", async () => {
    const { state } = installMockPlatform({ listPackages: async () => [] });
    const c = makeContainer();
    renderDependenciesEditor(c);
    await flush();
    pointer(buttonByText(c, "Add"), "click");
    await flush();
    expect(state.calls.some(([name]) => name === "addPackage")).toBe(false);
    expect(modalLayer().querySelector(".progress-modal")).toBeNull();
  });

  test("a failed row update surfaces the backend log in Problems", async () => {
    installMockPlatform({
      ...TWO_DEPS,
      setPackageVersions: async () => ({ log: "conflicting peer deps", ok: false }),
    });
    const c = makeContainer();
    renderDependenciesEditor(c);
    await flush();
    pointer(c.querySelector('sp-action-button[title="Update to 4.6.0"]')!, "click");
    await flush();
    expect(problems[0]?.message).toContain("conflicting peer deps");
  });

  test("update all skips current packages and reports a log-less failure", async () => {
    let received: { name: string }[] = [];
    installMockPlatform({
      listPackages: async () => [
        { name: "hono", version: "^4.0.0" },
        { name: "left-pad", version: "^1.3.0" },
      ],
      packageVersions: async () => [{ current: "^4.0.0", latest: "4.6.0", name: "hono" }],
      setPackageVersions: async (updates) => {
        received = updates;
        return { ok: false };
      },
    });
    const c = makeContainer();
    renderDependenciesEditor(c);
    await flush();
    pointer(buttonByText(c, "Update all"), "click");
    await flush();
    // The current package produced no update entry; the failure fell back to a generic message.
    expect(received.map((u) => u.name)).toEqual(["hono"]);
    expect(problems[0]?.message).toContain("Update failed");
  });

  test("a stale update-all click after the list refreshes to current is a no-op", async () => {
    installMockPlatform({
      ...TWO_DEPS,
      setPackageVersions: async () => ({ ok: true }),
    });
    const c = makeContainer();
    renderDependenciesEditor(c);
    await flush();
    const staleButton = buttonByText(c, "Update all");

    let called = 0;
    installMockPlatform({
      listPackages: async () => [],
      setPackageVersions: async () => {
        called += 1;
        return { ok: true };
      },
    });
    renderDependenciesEditor(makeContainer());
    await flush();

    pointer(staleButton, "click");
    await flush();
    expect(called).toBe(0);
    expect(modalLayer().querySelector(".progress-modal")).toBeNull();
  });

  test("a failed reinstall surfaces the install log in Problems", async () => {
    installMockPlatform({
      ...TWO_DEPS,
      installDependencies: async () => ({ log: "lockfile busted", ok: false }),
    });
    const c = makeContainer();
    renderDependenciesEditor(c);
    await flush();
    pointer(c.querySelector('sp-action-button[title="Reinstall (bun install)"]')!, "click");
    await flush();
    expect(problems[0]?.message).toContain("lockfile busted");
  });

  test("operations are ignored while another one is running", async () => {
    let releaseAdd: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseAdd = resolve;
    });
    let adds = 0;
    installMockPlatform({
      addPackage: async () => {
        adds += 1;
        await gate;
        return {};
      },
      listPackages: async () => [],
    });
    const c = makeContainer();
    renderDependenciesEditor(c);
    await flush();
    const field = c.querySelector("sp-textfield") as HTMLInputElement;
    field.value = "lodash";
    field.dispatchEvent(new Event("input", { bubbles: true }));
    const addButton = buttonByText(c, "Add");
    pointer(addButton, "click");
    // Second click lands while the first run holds the busy flag.
    pointer(addButton, "click");
    releaseAdd();
    await flush();
    expect(adds).toBe(1);
  });
});

// ─── Jxsuite update prompt with unavailable storage ──────────────────────────

describe("jxsuite-update dismissal storage", () => {
  test("the prompt still shows when localStorage access throws (never remembered)", async () => {
    installMockPlatform({
      packageVersions: async () => [
        { current: "^0.1.0", latest: "0.4.0", name: "@jxsuite/runtime" },
      ],
      setPackageVersions: async () => ({ ok: true }),
    });
    const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get() {
        throw new Error("storage denied");
      },
    });
    try {
      const pending = maybePromptJxsuiteUpdate("/proj");
      await flush();
      const dialog = document.querySelector("#layer-dialog sp-dialog-wrapper");
      expect(dialog).not.toBeNull();
      dialog!.dispatchEvent(new Event("cancel")); // Declines → setDismissed also hits the catch.
      await pending;
    } finally {
      if (original) {
        Object.defineProperty(globalThis, "localStorage", original);
      }
      (document.querySelector("#layer-dialog") as HTMLElement).innerHTML = "";
    }
  });
});

// ─── CSS variables editor ────────────────────────────────────────────────────

describe("css vars editor gaps", () => {
  function setupVars(media?: Record<string, string>): HTMLElement {
    installMockPlatform();
    resetStudioState({
      projectConfig: {
        style: {
          "--color-primary": "#007acc",
          "--font-body": "'Georgia', serif",
          "--size-gap": "16px",
        },
        ...(media ? { $media: media } : {}),
      } as unknown,
    });
    const container = document.createElement("div");
    renderCssVarsEditor(container);
    return container;
  }

  function style(): Record<string, unknown> {
    return (store.projectState as unknown as { projectConfig: { style: Record<string, unknown> } })
      .projectConfig.style;
  }

  function groupByTitle(container: HTMLElement, title: string): HTMLElement {
    const group = [...container.querySelectorAll(".css-vars-group")].find(
      (g) => g.querySelector(".css-vars-group-title")?.textContent?.trim() === title,
    );
    if (!group) {
      throw new Error(`no css-vars group titled "${title}"`);
    }
    return group as HTMLElement;
  }

  test("font row delete removes the token", () => {
    const container = setupVars();
    const fonts = groupByTitle(container, "Fonts");
    pointer(fonts.querySelector(".css-var-row sp-action-button")!, "click");
    expect(style()["--font-body"]).toBeUndefined();
  });

  test("size row delete removes the token", () => {
    const container = setupVars();
    const sizes = groupByTitle(container, "Sizes & Spacing");
    pointer(sizes.querySelector(".css-var-row sp-action-button")!, "click");
    expect(style()["--size-gap"]).toBeUndefined();
  });

  test("scheme override swatch input writes into the scheme block", () => {
    const container = setupVars({ "--dark": "(prefers-color-scheme: dark)" });
    const swatchInput = container.querySelector(
      '.css-var-scheme-row input[type="color"]',
    ) as HTMLInputElement;
    swatchInput.value = "#222222";
    swatchInput.dispatchEvent(new Event("input", { bubbles: true }));
    expect((style()["@--dark"] as Record<string, unknown>)["--color-primary"]).toBe("#222222");
  });
});

// ─── Contributed sections ────────────────────────────────────────────────────

describe("contributed section gaps", () => {
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

  function config(): Record<string, unknown> {
    return store.projectState!.projectConfig as unknown as Record<string, unknown>;
  }

  const mapContribution: SettingsContribution = {
    entrySchema: { properties: { label: { type: "string" } } },
    key: "connections",
    settings: { layout: "map" },
    title: "Connections",
  };

  function createEntry(name: string): void {
    pointer(buttonByText(container, "New Entry"), "click");
    const field = container.querySelector(".settings-inline-form sp-textfield")!;
    (field as ValueEl).value = name;
    field.dispatchEvent(new Event("input", { bubbles: true }));
    pointer(buttonByText(container, "Create"), "click");
  }

  test("create without a newEntry template starts from an empty entry", async () => {
    renderContributedSection(container, mapContribution);
    createEntry("Fresh One");
    await flush();
    expect((config().connections as Record<string, unknown>)["fresh-one"]).toEqual({});
  });

  test("newEntry templates substitute inside arrays and keep non-string leaves", async () => {
    renderContributedSection(container, {
      ...mapContribution,
      settings: {
        entry: {
          newEntry: { depth: 2, enabled: true, tags: ["${key}", 7, { ref: "${key}" }] },
        },
        layout: "map",
      },
    });
    createEntry("tagged");
    await flush();
    expect((config().connections as Record<string, unknown>).tagged).toEqual({
      depth: 2,
      enabled: true,
      tags: ["tagged", 7, { ref: "tagged" }],
    });
  });

  test("a stale delete click after the entry is gone is a no-op", async () => {
    renderContributedSection(container, mapContribution);
    pointer(buttonByText(container, "main"), "click");
    const deleteButton = container.querySelector('[title="Delete entry"]') as HTMLElement;
    pointer(deleteButton, "click");
    await flush();
    const writes = platformState.calls.filter(
      (c) => c[0] === "writeFile" && c[1] === "project.json",
    ).length;
    // The detached button's listener still fires, but the entry is already gone.
    pointer(deleteButton, "click");
    await flush();
    expect(config().connections).toEqual({});
    expect(
      platformState.calls.filter((c) => c[0] === "writeFile" && c[1] === "project.json"),
    ).toHaveLength(writes);
  });

  test("Enter blurs the entry-name field and Escape restores the current key", () => {
    renderContributedSection(container, mapContribution);
    pointer(buttonByText(container, "main"), "click");
    const nameInput = container.querySelector(".entry-name-input") as ValueEl;
    let blurs = 0;
    (nameInput as unknown as { blur: () => void }).blur = () => {
      blurs += 1;
    };

    key(nameInput, "Enter");
    expect(blurs).toBe(1);

    nameInput.value = "half-typed";
    key(nameInput, "Escape");
    expect(blurs).toBe(2);
    expect(nameInput.value).toBe("main");
    // No rename happened — the entry key is untouched.
    expect(Object.keys(config().connections as Record<string, unknown>)).toEqual(["main"]);
  });
});
