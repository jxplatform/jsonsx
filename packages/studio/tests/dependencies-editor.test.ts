/**
 * Tests for src/settings/dependencies-editor.ts — the dependency table.
 *
 * The Latest column is the registry's answer for EVERY row. The `../src/version` mock below is
 * deliberately a version no package in these fixtures is at: it is what the `@jxsuite/*` rows used
 * to be pinned to, so a row showing it again is the regression these tests exist to catch.
 */
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
  packageVersions: async () => [
    { current: "^0.19.0", dev: true, latest: "0.22.0", name: "@jxsuite/compiler" },
    { current: "^4.0.0", latest: "4.6.0", name: "hono" },
  ],
};

/** The rendered table, keyed by package name → its cells. */
function cellsByName(c: HTMLElement): Map<string | undefined, Element[]> {
  return new Map(
    [...c.querySelectorAll("sp-table-row")].map((r) => {
      const cells = [...r.querySelectorAll("sp-table-cell")];
      return [cells[0]?.textContent?.trim().split(/\s/)[0], cells];
    }),
  );
}

describe("renderDependenciesEditor", () => {
  test("shows a loading state then a table with current + latest", async () => {
    installMockPlatform(TWO_DEPS);
    const c = makeContainer();
    renderDependenciesEditor(c);
    expect(c.querySelector(".about-muted")?.textContent).toContain("Loading");

    await flush();
    const cells = cellsByName(c);
    expect(cells.size).toBe(2);
    // Every row reads its OWN newest publish — including the @jxsuite one, which used to read the
    // Version this Studio build embeds (mocked to 0.30.1 above) whatever npm actually had.
    expect(cells.get("@jxsuite/compiler")?.[2]?.textContent?.trim()).toBe("0.22.0");
    expect(cells.get("hono")?.[2]?.textContent?.trim()).toBe("4.6.0");
  });

  test("a package already AT its latest shows that version, with no update button", async () => {
    /*
     * The reported defect. The backend was asked for OUTDATED packages, so a current dependency
     * arrived as an absence and the Latest column read `—` — the registry's answer was known and
     * discarded. It is a version now, and only the update affordance is conditional.
     */
    installMockPlatform({
      listPackages: async () => [{ name: "hono", version: "^4.6.0" }],
      packageVersions: async () => [{ current: "^4.6.0", latest: "4.6.0", name: "hono" }],
    });
    const c = makeContainer();
    renderDependenciesEditor(c);
    await flush();
    expect(cellsByName(c).get("hono")?.[2]?.textContent?.trim()).toBe("4.6.0");
    expect(c.querySelector('sp-action-button[title^="Update to"]')).toBeNull();
    expect(buttonByText(c, "Update all")).toBeUndefined();
  });

  test("a package pinned AHEAD of the registry shows latest but is not offered a downgrade", async () => {
    installMockPlatform({
      listPackages: async () => [{ name: "hono", version: "^5.0.0-rc.1" }],
      packageVersions: async () => [{ current: "^5.0.0-rc.1", latest: "4.6.0", name: "hono" }],
    });
    const c = makeContainer();
    renderDependenciesEditor(c);
    await flush();
    expect(cellsByName(c).get("hono")?.[2]?.textContent?.trim()).toBe("4.6.0");
    expect(c.querySelector('sp-action-button[title^="Update to"]')).toBeNull();
  });

  test("a package the registry cannot answer for reads —", async () => {
    // A workspace:/file:/git spec, or a name npm does not serve: no row comes back for it at all.
    installMockPlatform({
      listPackages: async () => [{ name: "local-thing", version: "workspace:^" }],
      packageVersions: async () => [],
    });
    const c = makeContainer();
    renderDependenciesEditor(c);
    await flush();
    expect(cellsByName(c).get("local-thing")?.[2]?.textContent?.trim()).toBe("—");
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

  test("update all bumps every dependency that is actually behind", async () => {
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
