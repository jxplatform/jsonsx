/**
 * New Project modal tests (E9). Drives the real two-step wizard through the layer system: the
 * source tab strip, the Next/Back transitions, field input with directory-slug derivation, the
 * destination block (Location + Browse…, on a `createDestination: "path"` platform), validation,
 * platform createProject success/failure, template/starter selection, and the various dismissal
 * paths.
 */
import {
  flush,
  installMockPlatform,
  npFillLocation,
  npLocation,
  npName,
  npPreview,
  npSlug,
  npType,
} from "./harness";
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

/**
 * Textfields in form order on the Parameters step of a `createDestination: "path"` platform: name,
 * location, directory, description, url, …design. The identity and destination fields carry stable
 * classes (use the harness accessors); only the unclassed description/url fields need an index.
 */
function field(index: number): any {
  return document.querySelectorAll("#layer-modal sp-textfield")[index];
}

/** The Description textfield — it follows the whole destination block. */
function npDescription(): any {
  return field(3);
}

/** The Production URL textfield. */
function npUrl(): any {
  return field(4);
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
  return document.querySelector("#layer-modal .new-project-error")?.textContent?.trim() ?? null;
}

/** The inline destination-validation message rendered under the Location/Directory fields. */
function destinationError(): string | null {
  return (
    document
      .querySelector("#layer-modal .new-project-modal-body .new-project-error")
      ?.textContent?.trim() ?? null
  );
}

/** The Browse… button beside the Location field (absent without `platform.pickDirectory`). */
function browseButton(): any {
  return document.querySelector("#layer-modal .new-project-location-row sp-button");
}

/** The inline validation message slotted into the Project Name textfield. */
function nameError(): string | null {
  return (
    document
      .querySelector('#layer-modal sp-textfield sp-help-text[slot="negative-help-text"]')
      ?.textContent?.trim() ?? null
  );
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
    // Identity + destination fields, adapter picker, and the design quickstart sections.
    expect(document.querySelectorAll("#layer-modal sp-textfield").length).toBeGreaterThanOrEqual(5);
    expect(npName()).toBeTruthy();
    expect(npLocation()).toBeTruthy();
    expect(npSlug()).toBeTruthy();
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
    npType(npName(), "My Cool Site!");
    expect(npSlug().value).toBe("my-cool-site");
    npType(npName(), "Renamed Site");
    expect(npSlug().value).toBe("renamed-site");
  });

  test("manual directory entry stops further derivation", () => {
    installMockPlatform();
    void openNewProjectModal();
    goNext();
    npType(npSlug(), "custom-dir");
    npType(npName(), "Some Project");
    expect(npSlug().value).toBe("custom-dir");
  });
});

describe("openNewProjectModal — destination", () => {
  test("blocks create with an inline error when the Location is empty", async () => {
    const { state } = installMockPlatform();
    void openNewProjectModal();
    goNext();
    npType(npName(), "Homeless Site");
    clickCreate();

    // The destination message replaces the name error and the modal stays open for a fix.
    expect(destinationError()).toBe("Choose a location for the project folder");
    expect(nameError()).toBeNull();
    expect(modal()).toBeTruthy();
    expect(state.calls.filter((c) => c[0] === "createProject")).toHaveLength(0);
    // The scroll-to-top + focus helper runs without throwing.
    await flush();
  });

  test("rejects a relative Location as not an absolute path", async () => {
    const { state } = installMockPlatform();
    void openNewProjectModal();
    goNext();
    npType(npName(), "Relative Site");
    npType(npLocation(), "sites/relative");
    clickCreate();

    expect(destinationError()).toBe("Location must be an absolute path");
    expect(modal()).toBeTruthy();
    expect(state.calls.filter((c) => c[0] === "createProject")).toHaveLength(0);
    await flush();
  });

  test("typing a Location clears the inline destination error", async () => {
    installMockPlatform();
    void openNewProjectModal();
    goNext();
    npType(npName(), "Fixable Site");
    clickCreate();
    expect(destinationError()).toBe("Choose a location for the project folder");
    npFillLocation();
    expect(destinationError()).toBeNull();
    await flush();
  });

  test("the preview tracks the location and the slug", () => {
    installMockPlatform();
    void openNewProjectModal();
    goNext();
    // Both halves are still unknown before anything is typed.
    expect(npPreview()).toBe("Creates: …/…");

    npType(npName(), "My Cool Site");
    expect(npPreview()).toBe("Creates: …/my-cool-site");

    // A trailing separator on the typed location is not doubled up.
    npFillLocation("/home/dev/Sites/");
    expect(npPreview()).toBe("Creates: /home/dev/Sites/my-cool-site");

    npType(npSlug(), "cool-dir");
    expect(npPreview()).toBe("Creates: /home/dev/Sites/cool-dir");
  });

  test("createProject receives the typed Location as a path destination", async () => {
    const { state } = installMockPlatform();
    const promise = openNewProjectModal();
    goNext();
    npType(npName(), "Placed Site");
    npFillLocation("/home/dev/Sites/");
    clickCreate();

    const result = await promise;
    const call = state.calls.find((c) => c[0] === "createProject") as any[];
    expect(call[1].destination).toEqual({ kind: "path", parent: "/home/dev/Sites" });
    expect(call[1].directory).toBe("placed-site");
    // The mock scaffolds under exactly the parent the user named.
    expect(result?.root).toBe("/home/dev/Sites/placed-site");
  });

  test("no Browse… button when the platform cannot open a directory dialog", () => {
    installMockPlatform();
    void openNewProjectModal();
    goNext();
    expect(browseButton()).toBeNull();
    expect(npLocation().getAttribute("placeholder")).toBe("/absolute/path/to/your/projects");
  });

  test("Browse… fills the Location from pickDirectory", async () => {
    let picks = 0;
    installMockPlatform({
      pickDirectory: (async () => {
        picks += 1;
        return "/Users/dev/Projects";
      }) as never,
    });
    void openNewProjectModal();
    goNext();
    expect(npLocation().getAttribute("placeholder")).toBe(
      "Choose a folder to create the project in",
    );
    expect(browseButton()).toBeTruthy();

    browseButton().dispatchEvent(new Event("click", { bubbles: true }));
    // While the native dialog is open the button is busy and further clicks are ignored.
    expect(browseButton().textContent).toContain("Choosing…");
    expect(browseButton().hasAttribute("disabled")).toBe(true);
    browseButton().dispatchEvent(new Event("click", { bubbles: true }));
    await flush();

    expect(picks).toBe(1);
    expect(npLocation().value).toBe("/Users/dev/Projects");
    expect(npPreview()).toBe("Creates: /Users/dev/Projects/…");
    expect(browseButton().textContent).toContain("Browse…");
    expect(browseButton().hasAttribute("disabled")).toBe(false);
  });

  test("a cancelled Browse… leaves the typed Location untouched", async () => {
    installMockPlatform({ pickDirectory: (async () => null) as never });
    void openNewProjectModal();
    goNext();
    npFillLocation("/home/dev/Sites");

    browseButton().dispatchEvent(new Event("click", { bubbles: true }));
    await flush();

    expect(npLocation().value).toBe("/home/dev/Sites");
    expect(npPreview()).toBe("Creates: /home/dev/Sites/…");
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

    npType(npName(), "My App");
    npFillLocation();
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
    expect(npDescription().value).toBe("A menu-driven site.");
    const accentField: any = document.querySelector(
      "#layer-modal .new-project-color-row sp-textfield",
    );
    expect(accentField.value).toBe("#b45309");

    npType(npName(), "My Diner");
    npFillLocation();
    clickCreate();
    await flush();
    const call = state.calls.find((c) => c[0] === "createProject");
    expect(call?.[1]).toMatchObject({ name: "My Diner", starter: "restaurant" });
    const opts = call![1] as { template?: string; design?: unknown };
    expect(opts.template).toBeUndefined();
    // The untouched accent prefill is not sent as an override.
    expect(opts.design).toBeUndefined();
  });

  test("openNewProjectModal({ tab: 'starter' }) opens directly on the Starter Site tab", async () => {
    installMockPlatform({ listStarters: (async () => sampleStarters) as never });
    void openNewProjectModal({ tab: "starter" });
    await flush();
    expect(document.querySelector("#layer-modal sp-tabs")?.getAttribute("selected")).toBe(
      "starter",
    );
    expect(templateCards()[0]?.textContent).toContain("Bistro & Café");
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
  test("rejects an empty project name with an inline error at the field", async () => {
    const { state } = installMockPlatform();
    void openNewProjectModal();
    goNext();
    clickCreate();
    // The message renders inside the name field, not in the global strip.
    expect(nameError()).toBe("Project name is required");
    expect(npName().hasAttribute("invalid")).toBe(true);
    // The name is checked before the destination, so no location complaint yet.
    expect(destinationError()).toBeNull();
    expect(errorText()).toBeNull();
    expect(modal()).toBeTruthy();
    expect(state.calls.filter((c) => c[0] === "createProject")).toHaveLength(0);
    // The scroll-to-top + focus helper runs without throwing.
    await flush();
  });

  test("typing into the name field clears the inline error", () => {
    installMockPlatform();
    void openNewProjectModal();
    goNext();
    clickCreate();
    expect(nameError()).toBe("Project name is required");
    npType(npName(), "My Site");
    expect(nameError()).toBeNull();
    expect(npName().hasAttribute("invalid")).toBe(false);
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
    npType(npName(), "My Site");
    npFillLocation();
    npType(npDescription(), "A demo site");
    npType(npUrl(), "https://example.com");
    clickCreate();

    // While createProject is pending the button is disabled and shows progress
    expect(footerButtons()[1].textContent).toContain("Creating…");
    expect(footerButtons()[1].hasAttribute("disabled")).toBe(true);

    resolveCreate({ config: { name: "My Site" }, root: "/home/dev/Sites/my-site" });
    const result = await promise;
    expect(result).toEqual({
      config: { name: "My Site" },
      root: "/home/dev/Sites/my-site",
    } as never);
    expect(modal()).toBeNull();
    expect(created[0]).toEqual({
      adapter: "static",
      description: "A demo site",
      destination: { kind: "path", parent: "/home/dev/Sites" },
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
    npType(npName(), "Site X");
    npType(npSlug(), ""); // User clears the derived value
    npFillLocation();
    clickCreate();
    await promise;
    const call = state.calls.find((c) => c[0] === "createProject") as any[];
    expect(call[1].directory).toBe("site-x");
  });

  test("passes the selected adapter to createProject", async () => {
    const { state } = installMockPlatform();
    const promise = openNewProjectModal();
    goNext();
    npType(npName(), "Node Site");
    npFillLocation();
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
    npType(npName(), "Doomed");
    npFillLocation();
    clickCreate();
    await flush();

    expect(modal()).toBeTruthy();
    expect(errorText()).toContain("disk full");
    // The backend error lives OUTSIDE the scroll body so it is visible at any scroll position.
    expect(document.querySelector("#layer-modal .new-project-modal-body .new-project-error")) //
      .toBeNull();
    expect(document.querySelector("#layer-modal .new-project-error--global")).toBeTruthy();
    // Button returns to its idle state for a retry
    expect(footerButtons()[1].hasAttribute("disabled")).toBe(false);
    expect(footerButtons()[1].textContent).toContain("Create Project");
    expect(settled).toBe(false);

    closeNewProjectModal();
    expect(await promise).toBeNull();
  });

  test("a structured needs_installation_access failure renders the install link", async () => {
    const installUrl = "https://github.com/apps/jx-suite/installations/new";
    installMockPlatform({
      createProject: (async () => {
        throw Object.assign(new Error("GitHub blocked repository creation."), {
          code: "needs_installation_access",
          installUrl,
        });
      }) as never,
    });
    const promise = openNewProjectModal();
    goNext();
    npType(npName(), "Blocked");
    npFillLocation();
    clickCreate();
    await flush();

    expect(errorText()).toContain("blocked repository creation");
    const link = document.querySelector<HTMLAnchorElement>("#layer-modal .new-project-error a");
    expect(link?.getAttribute("href")).toBe(installUrl);
    expect(link?.textContent).toContain("Install the Jx Suite GitHub App");

    closeNewProjectModal();
    expect(await promise).toBeNull();
  });
});
