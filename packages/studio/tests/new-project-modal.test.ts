/**
 * New Project modal tests (E9). Drives the real modal through the layer system: field input with
 * directory-slug derivation, validation, platform createProject success/failure, and the various
 * dismissal paths (cancel, Escape, underlay close, double-open).
 */
import { flush, installMockPlatform } from "./harness";
import { afterEach, describe, expect, test } from "bun:test";

const { closeNewProjectModal, openNewProjectModal } =
  await import("../src/new-project/new-project-modal");
const { initLayers } = await import("../src/ui/layers");

document.body.innerHTML = `
  <div id="layer-popover"></div>
  <div id="layer-modal"></div>
  <div id="layer-dialog"></div>
`;
initLayers();

function modal(): HTMLElement | null {
  return document.querySelector("#layer-modal .new-project-modal");
}

/** Textfields in form order: name, directory, description, url. */
function field(index: number): any {
  return document.querySelectorAll("#layer-modal sp-textfield")[index];
}

function typeInto(el: any, value: string) {
  el.value = value;
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

function footerButtons(): any[] {
  return [...document.querySelectorAll("#layer-modal .new-project-modal-footer sp-button")];
}

function clickCreate() {
  footerButtons()[1].dispatchEvent(new Event("click", { bubbles: true }));
}

function errorText(): string | null {
  return document.querySelector("#layer-modal .new-project-error")?.textContent ?? null;
}

afterEach(() => {
  closeNewProjectModal();
});

describe("openNewProjectModal — lifecycle", () => {
  test("renders the form with all fields and footer actions", () => {
    installMockPlatform();
    const promise = openNewProjectModal();
    expect(modal()).toBeTruthy();
    expect(document.querySelector("#layer-modal .new-project-modal-title")?.textContent).toBe(
      "New Project",
    );
    expect(document.querySelectorAll("#layer-modal sp-textfield")).toHaveLength(4);
    expect(document.querySelector("#layer-modal sp-picker")).toBeTruthy();
    const buttons = footerButtons();
    expect(buttons[0].textContent).toContain("Cancel");
    expect(buttons[1].textContent).toContain("Create Project");

    closeNewProjectModal();
    expect(modal()).toBeNull();
    return expect(promise).resolves.toBeNull();
  });

  test("a second open while one is active resolves null immediately", async () => {
    installMockPlatform();
    const first = openNewProjectModal();
    expect(await openNewProjectModal()).toBeNull();
    expect(modal()).toBeTruthy();
    closeNewProjectModal();
    expect(await first).toBeNull();
  });

  test("closeNewProjectModal is a no-op when nothing is open", () => {
    expect(modal()).toBeNull();
    closeNewProjectModal();
    expect(modal()).toBeNull();
  });

  test("Cancel button resolves null and removes the modal", async () => {
    installMockPlatform();
    const promise = openNewProjectModal();
    footerButtons()[0].dispatchEvent(new Event("click", { bubbles: true }));
    expect(await promise).toBeNull();
    expect(modal()).toBeNull();
  });

  test("Escape key inside the modal dismisses it", async () => {
    installMockPlatform();
    const promise = openNewProjectModal();
    modal()!.dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Escape" }),
    );
    expect(await promise).toBeNull();
    expect(modal()).toBeNull();
  });

  test("underlay close event dismisses the modal", async () => {
    installMockPlatform();
    const promise = openNewProjectModal();
    document
      .querySelector("#layer-modal sp-underlay")!
      .dispatchEvent(new Event("close", { bubbles: false }));
    expect(await promise).toBeNull();
  });
});

describe("openNewProjectModal — directory derivation", () => {
  test("derives a slug from the project name while directory is untouched", () => {
    installMockPlatform();
    void openNewProjectModal();
    typeInto(field(0), "My Cool Site!");
    expect(field(1).value).toBe("my-cool-site");
    typeInto(field(0), "Renamed Site");
    expect(field(1).value).toBe("renamed-site");
  });

  test("manual directory entry stops further derivation", () => {
    installMockPlatform();
    void openNewProjectModal();
    typeInto(field(1), "custom-dir");
    typeInto(field(0), "Some Project");
    expect(field(1).value).toBe("custom-dir");
  });
});

describe("openNewProjectModal — submit", () => {
  test("rejects an empty project name with an inline error", () => {
    const { state } = installMockPlatform();
    void openNewProjectModal();
    clickCreate();
    expect(errorText()).toBe("Project name is required");
    expect(modal()).toBeTruthy();
    expect(state.calls.filter((c) => c[0] === "createProject")).toHaveLength(0);
  });

  test("creates the project, shows progress, and resolves with the result", async () => {
    let resolveCreate: (v: unknown) => void = () => {};
    const created: any[] = [];
    installMockPlatform({
      createProject: ((opts: any) => {
        created.push(opts);
        return new Promise((resolve) => {
          resolveCreate = resolve;
        });
      }) as never,
    });

    const promise = openNewProjectModal();
    typeInto(field(0), "My Site");
    typeInto(field(2), "A demo site");
    typeInto(field(3), "https://example.com");
    clickCreate();

    // While createProject is pending the button is disabled and shows progress
    expect(footerButtons()[1].textContent).toContain("Creating…");
    expect(footerButtons()[1].hasAttribute("disabled")).toBe(true);

    resolveCreate({ config: { name: "My Site" }, root: "/projects/my-site" });
    const result = await promise;
    expect(result).toEqual({ config: { name: "My Site" }, root: "/projects/my-site" } as never);
    expect(modal()).toBeNull();
    expect(created[0]).toEqual({
      adapter: "static",
      description: "A demo site",
      directory: "my-site",
      name: "My Site",
      url: "https://example.com",
    });
  });

  test("re-derives the directory at submit time when it was cleared", async () => {
    const { state } = installMockPlatform();
    const promise = openNewProjectModal();
    typeInto(field(0), "Site X");
    typeInto(field(1), ""); // User clears the derived value
    clickCreate();
    await promise;
    const call = state.calls.find((c) => c[0] === "createProject") as any[];
    expect(call[1].directory).toBe("site-x");
  });

  test("passes the selected adapter to createProject", async () => {
    const { state } = installMockPlatform();
    const promise = openNewProjectModal();
    typeInto(field(0), "Node Site");
    const picker: any = document.querySelector("#layer-modal sp-picker");
    picker.value = "node";
    picker.dispatchEvent(new Event("change", { bubbles: true }));
    clickCreate();
    await promise;
    const call = state.calls.find((c) => c[0] === "createProject") as any[];
    expect(call[1].adapter).toBe("node");
  });

  test("createProject failure surfaces the error and keeps the modal open", async () => {
    installMockPlatform({
      createProject: (async () => {
        throw new Error("disk full");
      }) as never,
    });
    let settled = false;
    const promise = openNewProjectModal();
    void promise.then(() => {
      settled = true;
    });
    typeInto(field(0), "Doomed");
    clickCreate();
    await flush();

    expect(modal()).toBeTruthy();
    expect(errorText()).toContain("disk full");
    // Button returns to its idle state for a retry
    expect(footerButtons()[1].hasAttribute("disabled")).toBe(false);
    expect(footerButtons()[1].textContent).toContain("Create Project");
    expect(settled).toBe(false);

    closeNewProjectModal();
    expect(await promise).toBeNull();
  });
});
