/**
 * New Project modal tests (E9). Drives the real two-step wizard through the layer system: the
 * source tab strip, the Next/Back transitions, field input with directory-slug derivation,
 * validation, platform createProject success/failure, template/starter selection, and the various
 * dismissal paths.
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

/** Textfields in form order on the Parameters step: name, directory, description, url, …design. */
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

function goNext() {
  const next = footerButtons().find((b) => b.textContent?.includes("Next"));
  next!.dispatchEvent(new Event("click", { bubbles: true }));
}

function clickCreate() {
  const create = footerButtons().find((b) => b.textContent?.includes("Create Project"));
  create!.dispatchEvent(new Event("click", { bubbles: true }));
}

function errorText(): string | null {
  return document.querySelector("#layer-modal .new-project-error")?.textContent ?? null;
}

function switchTab(value: string) {
  const tabs: any = document.querySelector("#layer-modal sp-tabs");
  tabs.selected = value;
  tabs.dispatchEvent(new Event("change", { bubbles: true }));
}

function tabValues(): string[] {
  return [...document.querySelectorAll("#layer-modal sp-tab")].map(
    (t) => t.getAttribute("value") ?? "",
  );
}

function templateCards(): any[] {
  return [...document.querySelectorAll("#layer-modal .new-project-template")];
}

afterEach(() => {
  localStorage.clear();
  closeNewProjectModal();
});

describe("openNewProjectModal — wizard lifecycle", () => {
  test("step 1 shows the tab strip and source cards; Next reveals the Parameters step", () => {
    installMockPlatform();
    const promise = openNewProjectModal();
    expect(modal()).toBeTruthy();
    expect(document.querySelector("#layer-modal .new-project-modal-title")?.textContent).toBe(
      "Start new project from:",
    );
    // No importSite on the default mock platform → the Import tab is hidden.
    expect(tabValues()).toEqual(["template", "starter", "agent"]);
    // The source step carries no parameter fields — they live on step 2.
    expect(document.querySelectorAll("#layer-modal sp-textfield")).toHaveLength(0);
    expect(document.querySelector("#layer-modal sp-picker")).toBeNull();
    let labels = footerButtons().map((b) => b.textContent?.trim());
    expect(labels).toEqual(["Cancel", "Next"]);

    goNext();
    expect(document.querySelector("#layer-modal .new-project-step-heading")?.textContent).toBe(
      "New Project Parameters",
    );
    expect(document.querySelector("#layer-modal .new-project-step-context")?.textContent).toContain(
      "Template · Blank",
    );
    // Identity fields + adapter picker + the design quickstart sections.
    expect(document.querySelectorAll("#layer-modal sp-textfield").length).toBeGreaterThanOrEqual(4);
    expect(document.querySelector("#layer-modal sp-picker")).toBeTruthy();
    expect(document.querySelectorAll("#layer-modal .new-project-design-section")).toHaveLength(4);
    // The tab strip is hidden on the Parameters step.
    expect(document.querySelector("#layer-modal sp-tabs")).toBeNull();
    labels = footerButtons().map((b) => b.textContent?.trim());
    expect(labels).toEqual(["Back", "Create Project"]);

    // Back returns to the source step with the tabs restored.
    footerButtons()[0].dispatchEvent(new Event("click", { bubbles: true }));
    expect(document.querySelector("#layer-modal sp-tabs")).toBeTruthy();

    closeNewProjectModal();
    expect(modal()).toBeNull();
    return expect(promise).resolves.toBeNull();
  });

  test("shows the Import tab when the platform supports importSite", () => {
    installMockPlatform({
      importSite: (async () => ({ config: {}, root: "/r" })) as never,
    });
    void openNewProjectModal();
    expect(tabValues()).toEqual(["template", "starter", "import", "agent"]);
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
    goNext();
    typeInto(field(0), "My Cool Site!");
    expect(field(1).value).toBe("my-cool-site");
    typeInto(field(0), "Renamed Site");
    expect(field(1).value).toBe("renamed-site");
  });

  test("manual directory entry stops further derivation", () => {
    installMockPlatform();
    void openNewProjectModal();
    goNext();
    typeInto(field(1), "custom-dir");
    typeInto(field(0), "Some Project");
    expect(field(1).value).toBe("custom-dir");
  });
});

describe("openNewProjectModal — Template tab", () => {
  test("always offers the four built-in templates with Blank selected", () => {
    installMockPlatform();
    void openNewProjectModal();
    const cards = templateCards();
    expect(cards).toHaveLength(4);
    expect(cards[0].textContent).toContain("Blank");
    expect(cards[0].classList.contains("selected")).toBe(true);
    expect(cards[1].textContent).toContain("Desktop First");
    expect(cards[2].textContent).toContain("Mobile First");
    expect(cards[3].textContent).toContain("Mobile App");
  });

  test("selecting a template threads its id into createProject without a design payload", async () => {
    const { state } = installMockPlatform();
    void openNewProjectModal();
    templateCards()[3].dispatchEvent(new Event("click", { bubbles: true }));
    expect(templateCards()[3].classList.contains("selected")).toBe(true);

    goNext();
    // The template's breakpoint preset prefills the editor rows.
    const mediaNames = [
      ...document.querySelectorAll("#layer-modal .new-project-media-row .new-project-media-name"),
    ].map((el: any) => el.value);
    expect(mediaNames).toEqual(["--", "--sm", "--md", "--lg"]);

    typeInto(field(0), "My App");
    clickCreate();
    await flush();
    const call = state.calls.find((c) => c[0] === "createProject");
    expect(call?.[1]).toMatchObject({ name: "My App", template: "mobile-app" });
    // Untouched design prefills are not sent — the template stays as authored.
    const opts = call![1] as { design?: unknown };
    expect(opts.design).toBeUndefined();
  });
});

describe("openNewProjectModal — Starter Site tab", () => {
  const sampleStarters = [
    {
      accent: "#b45309",
      description: "Full description of the bistro starter.",
      features: ["Menu collection"],
      id: "restaurant",
      industry: "Restaurant & Food",
      name: "Bistro & Café",
      tagline: "A menu-driven site.",
      thumbnail: "data:image/png;base64,AAAA",
    },
  ];

  test("shows an empty note when the platform has no starters", async () => {
    installMockPlatform();
    void openNewProjectModal();
    await flush();
    switchTab("starter");
    expect(templateCards()).toHaveLength(0);
    expect(document.querySelector("#layer-modal .new-project-tab-intro")?.textContent).toContain(
      "No starter sites",
    );
  });

  test("renders starter cards with the first auto-selected", async () => {
    installMockPlatform({ listStarters: (async () => sampleStarters) as never });
    void openNewProjectModal();
    await flush();
    switchTab("starter");
    const cards = templateCards();
    expect(cards).toHaveLength(1);
    expect(cards[0].textContent).toContain("Bistro & Café");
    expect(cards[0].classList.contains("selected")).toBe(true);
  });

  test("Next prefills description and accent from the starter; create threads the starter id", async () => {
    const { state } = installMockPlatform({ listStarters: (async () => sampleStarters) as never });
    void openNewProjectModal();
    await flush();
    switchTab("starter");
    goNext();
    expect(document.querySelector("#layer-modal .new-project-step-context")?.textContent).toContain(
      "Bistro & Café",
    );
    // Description prefilled from the tagline; accent prefilled from the registry accent.
    expect(field(2).value).toBe("A menu-driven site.");
    const accentField: any = document.querySelector(
      "#layer-modal .new-project-color-row sp-textfield",
    );
    expect(accentField.value).toBe("#b45309");

    typeInto(field(0), "My Diner");
    clickCreate();
    await flush();
    const call = state.calls.find((c) => c[0] === "createProject");
    expect(call?.[1]).toMatchObject({ name: "My Diner", starter: "restaurant" });
    const opts = call![1] as { template?: string; design?: unknown };
    expect(opts.template).toBeUndefined();
    // The untouched accent prefill is not sent as an override.
    expect(opts.design).toBeUndefined();
  });

  test("a failing listStarters leaves the modal usable", async () => {
    installMockPlatform({
      listStarters: (async () => {
        throw new Error("nope");
      }) as never,
    });
    void openNewProjectModal();
    await flush();
    expect(modal()).toBeTruthy();
    switchTab("starter");
    expect(templateCards()).toHaveLength(0);
  });
});

describe("openNewProjectModal — submit", () => {
  test("rejects an empty project name with an inline error", () => {
    const { state } = installMockPlatform();
    void openNewProjectModal();
    goNext();
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
    goNext();
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
      template: "blank",
      url: "https://example.com",
    });
  });

  test("re-derives the directory at submit time when it was cleared", async () => {
    const { state } = installMockPlatform();
    const promise = openNewProjectModal();
    goNext();
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
    goNext();
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
    goNext();
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
