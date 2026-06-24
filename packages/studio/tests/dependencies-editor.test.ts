/** Tests for src/settings/dependencies-editor.ts — the outdated-aware dependency table. */
import { flush, installMockPlatform, pointer } from "./harness";
import { afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { initLayers } from "../src/ui/layers";

void mock.module("../src/version", () => ({
  APP_NAME: "Jx Studio",
  BUILD_DATE: "",
  GIT_COMMIT: "test",
  LINKS: { docs: "", github: "", license: "" },
  VERSION: "0.30.1",
}));

const { renderDependenciesEditor } = await import("../src/settings/dependencies-editor");

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

function makeContainer(): HTMLElement {
  const c = document.createElement("div");
  document.body.append(c);
  return c;
}

function buttonByText(c: HTMLElement, text: string): HTMLElement | undefined {
  return [...c.querySelectorAll("sp-action-button")].find((b) => b.textContent?.trim() === text) as
    | HTMLElement
    | undefined;
}

afterEach(() => {
  for (const d of document.querySelectorAll("body > div")) {
    if (!d.id) {
      d.remove();
    }
  }
  (document.querySelector("#layer-modal") as HTMLElement).innerHTML = "";
});

const TWO_DEPS = {
  listPackages: async () => [
    { dev: true, name: "@jxsuite/compiler", version: "^0.19.0" },
    { name: "hono", version: "^4.0.0" },
  ],
  outdatedPackages: async () => [{ current: "^4.0.0", latest: "4.6.0", name: "hono" }],
};

describe("renderDependenciesEditor", () => {
  test("shows a loading state then a table with current + latest", async () => {
    installMockPlatform(TWO_DEPS);
    const c = makeContainer();
    renderDependenciesEditor(c);
    expect(c.querySelector(".about-muted")?.textContent).toContain("Loading");

    await flush();
    const rows = [...c.querySelectorAll("sp-table-row")];
    expect(rows).toHaveLength(2);
    const cellsByName = new Map(
      rows.map((r) => {
        const cells = [...r.querySelectorAll("sp-table-cell")];
        return [cells[0]?.textContent?.trim().split(/\s/)[0], cells];
      }),
    );
    // @jxsuite row targets the embedded VERSION; hono targets the registry latest.
    expect(cellsByName.get("@jxsuite/compiler")?.[2]?.textContent?.trim()).toBe("0.30.1");
    expect(cellsByName.get("hono")?.[2]?.textContent?.trim()).toBe("4.6.0");
  });

  test("renders the empty state when there are no dependencies", async () => {
    installMockPlatform({ listPackages: async () => [] });
    const c = makeContainer();
    renderDependenciesEditor(c);
    await flush();
    expect(c.querySelector(".about-muted")?.textContent).toContain("No dependencies");
  });

  test("update sends a ^latest bump for the row", async () => {
    let received: unknown;
    installMockPlatform({
      ...TWO_DEPS,
      setPackageVersions: async (u) => {
        received = u;
        return { ok: true };
      },
    });
    const c = makeContainer();
    renderDependenciesEditor(c);
    await flush();
    const updateBtn = c.querySelector('sp-action-button[title="Update to 4.6.0"]') as HTMLElement;
    pointer(updateBtn, "click");
    await flush();
    expect(received).toEqual([{ dev: false, name: "hono", version: "^4.6.0" }]);
  });

  test("update all bumps every outdated dependency", async () => {
    let received: { name: string }[] = [];
    installMockPlatform({
      ...TWO_DEPS,
      setPackageVersions: async (u) => {
        received = u;
        return { ok: true };
      },
    });
    const c = makeContainer();
    renderDependenciesEditor(c);
    await flush();
    pointer(buttonByText(c, "Update all")!, "click");
    await flush();
    expect(received.map((u) => u.name).toSorted()).toEqual(["@jxsuite/compiler", "hono"]);
  });

  test("remove calls removePackage", async () => {
    let removed: string | undefined;
    installMockPlatform({
      ...TWO_DEPS,
      removePackage: async (name) => {
        removed = name;
        return {};
      },
    });
    const c = makeContainer();
    renderDependenciesEditor(c);
    await flush();
    const removeBtn = c.querySelector('sp-action-button[title="Remove"]') as HTMLElement;
    pointer(removeBtn, "click");
    await flush();
    expect(removed).toBe("@jxsuite/compiler");
  });

  test("add installs the typed package name", async () => {
    let added: string | undefined;
    installMockPlatform({
      listPackages: async () => [],
      addPackage: async (name) => {
        added = name;
        return {};
      },
    });
    const c = makeContainer();
    renderDependenciesEditor(c);
    await flush();
    const field = c.querySelector("sp-textfield") as HTMLInputElement;
    field.value = "lodash";
    field.dispatchEvent(new Event("input", { bubbles: true }));
    pointer(buttonByText(c, "Add")!, "click");
    await flush();
    expect(added).toBe("lodash");
  });

  test("reinstall runs installDependencies", async () => {
    let reinstalled = 0;
    installMockPlatform({
      ...TWO_DEPS,
      installDependencies: async () => {
        reinstalled += 1;
        return { ok: true };
      },
    });
    const c = makeContainer();
    renderDependenciesEditor(c);
    await flush();
    const reinstallBtn = c.querySelector(
      'sp-action-button[title="Reinstall (bun install)"]',
    ) as HTMLElement;
    pointer(reinstallBtn, "click");
    await flush();
    expect(reinstalled).toBe(1);
  });
});
