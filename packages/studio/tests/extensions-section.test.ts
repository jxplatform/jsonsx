/**
 * The Extensions section — the surface that turns "install it, then enable it" into one gesture.
 *
 * The assertions that carry the weight are the ones about the ORDER of the two writes and about
 * what happens when one of them fails, because the state this section exists to eliminate is a
 * `project.json` that names a package which is not installed: that fails the next build, and the
 * old free-text field manufactured it routinely.
 */
import { flush, installMockPlatform, resetStudioState, resetWorkspaceWithTab } from "./harness";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { refreshFormats, setExtensionCatalog, setExtensions } from "../src/format/format-host";
import { renderExtensionsSection } from "../src/settings/extensions-section";
import type { MockPlatformState } from "./harness";
import type { ExtensionCatalogEntry, PackageInfo, StudioPlatform } from "../src/types";

type AnyConfig = Record<string, any>;

const PARSER: ExtensionCatalogEntry = {
  description: "File-based content collections with Markdown and CSV formats",
  installed: false,
  name: "@jxsuite/parser",
  sections: [{ key: "content", title: "Content Types" }],
  source: "first-party",
  title: "Content & Markdown",
};

let container: HTMLElement;

function mount(
  cfg: AnyConfig,
  catalog: ExtensionCatalogEntry[] = [PARSER],
  overrides: Partial<StudioPlatform> = {},
  packages: PackageInfo[] = [],
): MockPlatformState {
  const { state } = installMockPlatform({
    listPackages: async () => packages,
    ...overrides,
  });
  resetStudioState({ projectConfig: cfg as unknown });
  setExtensionCatalog(catalog);
  setExtensions([]);
  container = document.createElement("div");
  document.body.append(container);
  renderExtensionsSection(container);
  return state;
}

function toggles(): HTMLInputElement[] {
  return [...container.querySelectorAll("sp-switch")] as unknown as HTMLInputElement[];
}

function rowFor(name: string): HTMLElement | undefined {
  return [...container.querySelectorAll(".settings-toggle-row")].find((row) =>
    row.querySelector(".settings-toggle-package")?.textContent?.includes(name),
  ) as HTMLElement | undefined;
}

function switchIn(row: HTMLElement | undefined): HTMLInputElement {
  return row?.querySelector("sp-switch") as unknown as HTMLInputElement;
}

/** The order of platform writes, which is what the enable path is really about. */
function writeOrder(state: MockPlatformState): string[] {
  return state.calls
    .filter(
      ([name, path]) =>
        name === "addPackage" ||
        name === "removePackage" ||
        (name === "writeFile" && String(path).includes("project.json")),
    )
    .map(([name]) => String(name));
}

function written(state: MockPlatformState): AnyConfig | null {
  const raw = state.files.get("project.json");
  return raw === undefined ? null : (JSON.parse(raw) as AnyConfig);
}

beforeEach(() => {
  resetWorkspaceWithTab();
  refreshFormats();
});

afterEach(() => {
  container?.remove();
  refreshFormats();
});

describe("what the section shows", () => {
  test("renders a row per catalogue entry with its identity and sections", async () => {
    mount({ extensions: [] });
    await flush();
    const row = rowFor("@jxsuite/parser");
    expect(row).toBeDefined();
    expect(row?.querySelector(".settings-toggle-title")?.textContent).toContain(
      "Content & Markdown",
    );
    expect(row?.querySelector(".settings-toggle-desc")?.textContent).toContain(
      "content collections",
    );
    expect(row?.querySelector(".settings-toggle-section")?.textContent).toBe("content");
  });

  test("the switch reflects project.json, not the catalogue", async () => {
    mount({ extensions: ["@jxsuite/parser"] });
    await flush();
    expect(switchIn(rowFor("@jxsuite/parser")).checked).toBe(true);
  });

  test("a switch moved by hand is corrected on the next render", async () => {
    /*
     * The `live()` proof, and the one assertion that fails under `?checked=`. `sp-switch` moves its
     * own `checked` when the reader touches it and never reflects that to the attribute, so an
     * attribute binding is dirty-checked away on exactly the render that needed to correct it —
     * which is what a half-succeeded install produces.
     */
    mount({ extensions: [] });
    await flush();
    const sw = switchIn(rowFor("@jxsuite/parser"));
    sw.checked = true;
    renderExtensionsSection(container);
    await flush();
    expect(switchIn(rowFor("@jxsuite/parser")).checked).toBe(false);
  });

  test("an extension project.json names but nothing describes still gets a row", async () => {
    mount({ extensions: ["@acme/mystery"] }, []);
    await flush();
    // It can still be turned OFF, which matters most for the rows nothing can explain.
    const row = rowFor("@acme/mystery");
    expect(row).toBeDefined();
    expect(switchIn(row).checked).toBe(true);
    expect(switchIn(row).hasAttribute("disabled")).toBe(false);
  });

  test("enabled but not installed renders as broken and says why", async () => {
    mount({ extensions: ["@jxsuite/parser"] });
    await flush();
    const row = rowFor("@jxsuite/parser");
    expect(row?.classList.contains("settings-toggle-row--broken")).toBe(true);
    expect(row?.querySelector(".settings-toggle-note--warn")?.textContent).toContain(
      "the next build will fail",
    );
  });

  test("an unavailable entry is disabled WITH its reason, not hidden", async () => {
    mount({ extensions: [] }, [
      { ...PARSER, installed: true, problem: "this backend bundles no parser" },
    ]);
    await flush();
    const row = rowFor("@jxsuite/parser");
    expect(row).toBeDefined();
    expect(switchIn(row).hasAttribute("disabled")).toBe(true);
    expect(switchIn(row).getAttribute("title")).toContain("bundles no parser");
    // And the same sentence is visible, because a title on a control that already has an
    // Aria-label is announced by almost nothing.
    expect(row?.querySelector(".settings-toggle-note")?.textContent).toContain("bundles no parser");
  });

  test("a bundled entry says it needs no install", async () => {
    mount({ extensions: [] }, [{ ...PARSER, bundled: true }]);
    await flush();
    expect(
      rowFor("@jxsuite/parser")?.querySelector(".settings-toggle-note")?.textContent,
    ).toContain("needs no install");
  });

  test("an empty catalogue teaches rather than reporting absence", async () => {
    mount({}, []);
    await flush();
    const empty = container.querySelector(".empty-state");
    expect(empty).toBeDefined();
    expect(empty?.classList.contains("empty-state--compact")).toBe(true);
    // Says what the region is FOR, never "no extensions".
    expect(empty?.textContent).toContain("Extensions add what the core does not do");
    expect(container.querySelector(".empty-state-actions")).toBeNull();
  });
});

describe("turning one on", () => {
  test("installs first, then writes project.json", async () => {
    const state = mount({ extensions: [] });
    await flush();
    switchIn(rowFor("@jxsuite/parser")).dispatchEvent(new Event("change"));
    await flush(6);

    // The order is the whole point: a project.json naming an uninstalled package fails the next
    // Build, so config-first would open a window in which the project is broken.
    expect(writeOrder(state)).toEqual(["addPackage", "writeFile"]);
    expect(written(state)?.extensions).toEqual(["@jxsuite/parser"]);
  });

  test("an already-installed extension is enabled without installing", async () => {
    const state = mount({ extensions: [] }, [{ ...PARSER, installed: true }]);
    await flush();
    switchIn(rowFor("@jxsuite/parser")).dispatchEvent(new Event("change"));
    await flush(6);
    expect(writeOrder(state)).toEqual(["writeFile"]);
    expect(written(state)?.extensions).toEqual(["@jxsuite/parser"]);
  });

  test("a bundled extension is enabled without installing", async () => {
    const state = mount({ extensions: [] }, [{ ...PARSER, bundled: true }]);
    await flush();
    switchIn(rowFor("@jxsuite/parser")).dispatchEvent(new Event("change"));
    await flush(6);
    expect(writeOrder(state)).toEqual(["writeFile"]);
  });

  test("a failed install does NOT write project.json", async () => {
    /*
     * The defect the section exists to remove. Writing the entry anyway would manufacture exactly
     * the enabled-but-missing row asserted above.
     */
    const state: MockPlatformState = mount({ extensions: [] }, [PARSER], {
      addPackage: () => {
        state.calls.push(["addPackage"]);
        return Promise.reject(new Error("registry unreachable"));
      },
    });
    await flush();
    switchIn(rowFor("@jxsuite/parser")).dispatchEvent(new Event("change"));
    await flush(6);

    expect(writeOrder(state)).toEqual(["addPackage"]);
    expect(written(state)).toBeNull();
    expect(switchIn(rowFor("@jxsuite/parser")).checked).toBe(false);
  });

  test("a failed config write leaves the package installed rather than rolling it back", async () => {
    const state: MockPlatformState = mount({ extensions: [] }, [PARSER], {
      writeFile: () => {
        state.calls.push(["writeFile", "project.json"]);
        return Promise.reject(new Error("EROFS: read-only file system"));
      },
    });
    await flush();
    switchIn(rowFor("@jxsuite/parser")).dispatchEvent(new Event("change"));
    await flush(6);

    // An automatic uninstall triggered by an unrelated failure is a destructive act nobody asked
    // For; an unused dependency is inert.
    expect(state.calls.some(([name]) => name === "removePackage")).toBe(false);
    // The rejection is shown at the control rather than dropped. The switch stays ON because
    // `commitProjectConfig` mutates the document before it writes and leaves the change in place
    // When the write fails: the document really does say "enabled", it is just unsaved, and ⌘S
    // Retries it. That is the same contract every settings section keeps.
    expect(container.querySelector(".settings-field-error[role=alert]")?.textContent).toContain(
      "read-only file system",
    );
  });
});

describe("turning one off", () => {
  test("removes the project.json entry and leaves the package installed", async () => {
    const state = mount({ extensions: ["@jxsuite/parser"] }, [{ ...PARSER, installed: true }]);
    await flush();
    switchIn(rowFor("@jxsuite/parser")).dispatchEvent(new Event("change"));
    await flush(6);

    expect(written(state)?.extensions).toEqual([]);
    expect(state.calls.some(([name]) => name === "removePackage")).toBe(false);
  });
});

describe("removing the package", () => {
  test("is refused while the extension is still enabled, with the reason on the control", async () => {
    mount({ extensions: ["@jxsuite/parser"] }, [{ ...PARSER, installed: true }]);
    await flush();
    const remove = rowFor("@jxsuite/parser")?.querySelector(".settings-extension-remove");
    expect(remove?.hasAttribute("disabled")).toBe(true);
    expect(remove?.getAttribute("title")).toContain("Turn Content & Markdown off first");
  });

  test("is offered once the extension is disabled", async () => {
    mount({ extensions: [] }, [{ ...PARSER, installed: true }]);
    await flush();
    const remove = rowFor("@jxsuite/parser")?.querySelector(".settings-extension-remove");
    expect(remove?.hasAttribute("disabled")).toBe(false);
  });

  test("is not offered for a package the project never installed", async () => {
    mount({ extensions: [] });
    await flush();
    expect(rowFor("@jxsuite/parser")?.querySelector(".settings-extension-remove")).toBeNull();
  });
});

describe("installed-ness can come from the package list", () => {
  test("a catalogue entry with no `installed` flag falls back to the dependencies", async () => {
    /*
     * A backend may answer the catalogue without answering installed-ness (the field is optional).
     * The package list is then the fallback, which is why the row model takes it: without it a row
     * would offer to install something the project already has.
     */
    const bare = { ...PARSER };
    delete (bare as { installed?: boolean }).installed;
    mount({ extensions: [] }, [bare], {}, [{ name: "@jxsuite/parser", version: "1.7.0" }]);
    await flush(4);
    const row = rowFor("@jxsuite/parser");
    // No "Not installed" note, and Remove is offered — both derived from the package list.
    expect(row?.querySelector(".settings-toggle-note")).toBeNull();
    expect(row?.querySelector(".settings-extension-remove")).not.toBeNull();
  });
});

describe("an enabled extension is described by what the backend resolved", () => {
  test("its sections come from the extensions payload, not the catalogue", async () => {
    /*
     * The split the row model exists for: for an OFFER the catalogue is the only source that can
     * describe a package the project has not installed, but once an extension is enabled the
     * backend has resolved it for real and that answer wins.
     */
    mount({ extensions: ["@jxsuite/parser"] }, [{ ...PARSER, installed: true }]);
    setExtensions([
      {
        contributions: [
          {
            className: "Content",
            project: { key: "resolved-content", title: "Content Types" },
          },
        ],
        description: "Resolved by the backend",
        name: "@jxsuite/parser",
        specifier: "@jxsuite/parser",
        title: "Resolved Parser",
      },
    ]);
    renderExtensionsSection(container);
    await flush();
    const row = rowFor("@jxsuite/parser");
    expect(row?.querySelector(".settings-toggle-section")?.textContent).toBe("resolved-content");
    // Identity still comes from the catalogue — only the SECTIONS are the resolved answer, because
    // Only they change with what the backend could actually load.
    expect(row?.querySelector(".settings-toggle-title")?.textContent).toContain(
      "Content & Markdown",
    );
  });

  test("a configured-only extension the backend resolved is described too", async () => {
    mount({ extensions: ["@acme/mystery"] }, []);
    setExtensions([
      {
        contributions: [{ className: "Guest", project: { key: "guestbook" } }],
        description: "A third-party guestbook",
        name: "@acme/mystery",
        specifier: "@acme/mystery",
        title: "Guestbook",
      },
    ]);
    renderExtensionsSection(container);
    await flush();
    const row = rowFor("@acme/mystery");
    expect(row?.querySelector(".settings-toggle-title")?.textContent).toContain("Guestbook");
    expect(row?.querySelector(".settings-toggle-section")?.textContent).toBe("guestbook");
    expect(row?.querySelector(".settings-toggle-desc")?.textContent).toContain("guestbook");
  });
});

describe("removing actually removes", () => {
  test("the Remove button uninstalls the package once the extension is off", async () => {
    const state = mount({ extensions: [] }, [{ ...PARSER, installed: true }]);
    await flush();
    const remove = rowFor("@jxsuite/parser")?.querySelector(
      ".settings-extension-remove",
    ) as HTMLElement;
    remove.dispatchEvent(new Event("click"));
    await flush(6);
    expect(
      state.calls.some(([name, arg]) => name === "removePackage" && arg === "@jxsuite/parser"),
    ).toBe(true);
  });

  test("a failed removal is shown inline rather than dropped", async () => {
    mount({ extensions: [] }, [{ ...PARSER, installed: true }], {
      removePackage: () => Promise.reject(new Error("EPERM: operation not permitted")),
    });
    await flush();
    const remove = rowFor("@jxsuite/parser")?.querySelector(
      ".settings-extension-remove",
    ) as HTMLElement;
    remove.dispatchEvent(new Event("click"));
    await flush(6);
    expect(container.querySelector(".settings-field-error[role=alert]")?.textContent).toContain(
      "operation not permitted",
    );
  });
});

describe("a backend that cannot list packages", () => {
  test("still renders the catalogue rather than failing the section", async () => {
    // Installed-ness degrades to "what the catalogue said", which is the honest fallback.
    mount({ extensions: [] }, [PARSER], {
      listPackages: () => Promise.reject(new Error("no package backend")),
    });
    await flush(4);
    expect(rowFor("@jxsuite/parser")).toBeDefined();
  });
});

describe("one operation at a time", () => {
  test("every switch is disabled while an install runs, naming the package", async () => {
    let release: (() => void) | undefined;
    mount({ extensions: [] }, [PARSER, { ...PARSER, name: "@jxsuite/feed", title: "Feeds" }], {
      addPackage: () =>
        new Promise<void>((r) => {
          release = r;
        }) as Promise<unknown>,
    });
    await flush();
    switchIn(rowFor("@jxsuite/parser")).dispatchEvent(new Event("change"));
    await flush(2);

    for (const sw of toggles()) {
      expect(sw.hasAttribute("disabled")).toBe(true);
    }
    expect(switchIn(rowFor("@jxsuite/feed")).getAttribute("title")).toContain("@jxsuite/parser");
    release?.();
    await flush(6);
  });
});
