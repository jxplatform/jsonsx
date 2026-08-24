/**
 * New Project modal tests (E9). Drives the real two-step wizard through the layer system: the
 * source tab strip, the starter gallery and its single "Start from scratch" card, the Next/Back/
 * Cancel transitions, the Name + Location step with directory-slug derivation, the destination
 * block (Location + Browse…, on a `createDestination: "path"` platform), validation, platform
 * createProject success/failure, the git-init that follows a create, and the dismissal paths.
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
  mountOverlayLayers,
} from "./harness";
import { afterEach, describe, expect, test } from "bun:test";

const { closeNewProjectModal, openNewProjectModal } =
  await import("../src/new-project/new-project-modal");
const { initLayers } = await import("../src/ui/layers");

mountOverlayLayers(document.body);
initLayers();

function modal(): HTMLElement | null {
  return document.querySelector("#layer-modal .new-project-modal");
}

function title(): string | undefined {
  return document.querySelector("#layer-modal .new-project-modal-title")?.textContent?.trim();
}

function footerButtons(): any[] {
  return [...document.querySelectorAll("#layer-modal .new-project-modal-footer sp-button")];
}

function footerLabels(): (string | undefined)[] {
  return footerButtons().map((b) => b.textContent?.trim());
}

function clickFooter(label: string) {
  const btn = footerButtons().find((b) => b.textContent?.includes(label));
  btn!.dispatchEvent(new Event("click", { bubbles: true }));
}

function goNext() {
  clickFooter("Next");
}

function clickCreate() {
  clickFooter("Create Project");
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

function cards(): any[] {
  return [...document.querySelectorAll("#layer-modal .new-project-template")];
}

const SAMPLE_STARTERS = [
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
  {
    description: "A shop.",
    features: [],
    id: "shop",
    industry: "Retail",
    name: "Corner Shop",
    tagline: "Products and a cart.",
    thumbnail: "data:image/png;base64,BBBB",
  },
];

afterEach(() => {
  localStorage.clear();
  closeNewProjectModal();
});

describe("openNewProjectModal — wizard lifecycle", () => {
  test("step 1 names the step and offers the gallery; Next reveals Name + Location", () => {
    installMockPlatform();
    const promise = openNewProjectModal();
    expect(modal()).toBeTruthy();
    expect(title()).toBe("Choose a starting point");
    // No importSite on the default mock platform → the Import tab is hidden.
    expect(tabValues()).toEqual(["starter", "agent"]);
    // The source step carries no parameter fields — they live on step 2.
    expect(document.querySelectorAll("#layer-modal sp-textfield")).toHaveLength(0);
    expect(footerLabels()).toEqual(["Cancel", "Next"]);

    goNext();
    expect(title()).toBe("Name your project");
    expect(document.querySelector("#layer-modal .new-project-step-context")?.textContent).toContain(
      "Start from scratch",
    );
    // Name + Location + Directory, and nothing else: no URL, no adapter, no design quickstart.
    expect(document.querySelectorAll("#layer-modal sp-textfield")).toHaveLength(3);
    expect(npName()).toBeTruthy();
    expect(npLocation()).toBeTruthy();
    expect(npSlug()).toBeTruthy();
    expect(document.querySelector("#layer-modal sp-picker")).toBeNull();
    expect(document.querySelector("#layer-modal .new-project-modal-body")?.textContent).toContain(
      "project settings",
    );
    // The tab strip is hidden on the Name step.
    expect(document.querySelector("#layer-modal sp-tabs")).toBeNull();
    expect(footerLabels()).toEqual(["Cancel", "Back", "Create Project"]);

    // Back returns to the source step with the tabs restored.
    clickFooter("Back");
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
    expect(tabValues()).toEqual(["starter", "import", "agent"]);
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

  test("Cancel works from the source step", async () => {
    installMockPlatform();
    const promise = openNewProjectModal();
    clickFooter("Cancel");
    expect(await promise).toBeNull();
    expect(modal()).toBeNull();
  });

  test("Cancel works from the Name step too", async () => {
    installMockPlatform();
    const promise = openNewProjectModal();
    goNext();
    expect(footerLabels()).toContain("Cancel");
    clickFooter("Cancel");
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

  test("the header close button dismisses it", async () => {
    installMockPlatform();
    const promise = openNewProjectModal();
    document
      .querySelector("#layer-modal .new-project-modal-header sp-action-button")!
      .dispatchEvent(new Event("click", { bubbles: true }));
    expect(await promise).toBeNull();
  });
});

describe("openNewProjectModal — the starter gallery", () => {
  test("offers only the scratch card when the platform ships no starters", () => {
    installMockPlatform();
    void openNewProjectModal();
    expect(cards()).toHaveLength(1);
    expect(cards()[0].textContent).toContain("Start from scratch");
    expect(cards()[0].classList.contains("selected")).toBe(true);
    // The four breakpoint templates are gone.
    expect(modal()?.textContent).not.toContain("Desktop First");
    expect(modal()?.textContent).not.toContain("breakpoints");
  });

  test("starters lead, with the first selected and the scratch card last", async () => {
    installMockPlatform({ listStarters: (async () => SAMPLE_STARTERS) as never });
    void openNewProjectModal();
    await flush();
    const all = cards();
    expect(all).toHaveLength(3);
    expect(all[0].textContent).toContain("Bistro & Café");
    expect(all[0].classList.contains("selected")).toBe(true);
    expect(all[1].textContent).toContain("Corner Shop");
    expect(all[2].textContent).toContain("Start from scratch");
    expect(all[2].classList.contains("selected")).toBe(false);
  });

  test("an arriving starter list does not override a card the user already picked", async () => {
    let release: (v: unknown) => void = () => {};
    installMockPlatform({
      listStarters: (() =>
        new Promise((resolve) => {
          release = resolve;
        })) as never,
    });
    void openNewProjectModal();
    // Scratch is the only card until the list lands; pick it explicitly.
    cards()[0].dispatchEvent(new Event("click", { bubbles: true }));
    release(SAMPLE_STARTERS);
    await flush();
    const all = cards();
    expect(all).toHaveLength(3);
    expect(all[0].classList.contains("selected")).toBe(false);
    expect(all[2].classList.contains("selected")).toBe(true);
  });

  test("selecting a starter threads its id into createProject", async () => {
    const { state } = installMockPlatform({
      listStarters: (async () => SAMPLE_STARTERS) as never,
    });
    void openNewProjectModal();
    await flush();
    cards()[1].dispatchEvent(new Event("click", { bubbles: true }));
    goNext();
    expect(document.querySelector("#layer-modal .new-project-step-context")?.textContent).toContain(
      "Corner Shop",
    );

    npType(npName(), "My Diner");
    npFillLocation();
    clickCreate();
    await flush();
    const call = state.calls.find((c) => c[0] === "createProject");
    expect(call?.[1]).toMatchObject({ name: "My Diner", starter: "shop" });
    expect((call![1] as { template?: string }).template).toBeUndefined();
  });

  test("the scratch card creates the blank template", async () => {
    const { state } = installMockPlatform({
      listStarters: (async () => SAMPLE_STARTERS) as never,
    });
    void openNewProjectModal();
    await flush();
    cards()[2].dispatchEvent(new Event("click", { bubbles: true }));
    goNext();
    npType(npName(), "Empty Site");
    npFillLocation();
    clickCreate();
    await flush();
    const call = state.calls.find((c) => c[0] === "createProject");
    expect(call?.[1]).toMatchObject({ name: "Empty Site", template: "blank" });
    expect((call![1] as { starter?: string }).starter).toBeUndefined();
  });

  test("openNewProjectModal({ tab: 'starter' }) opens on the gallery", async () => {
    installMockPlatform({ listStarters: (async () => SAMPLE_STARTERS) as never });
    void openNewProjectModal({ tab: "starter" });
    await flush();
    expect(document.querySelector("#layer-modal sp-tabs")?.getAttribute("selected")).toBe(
      "starter",
    );
    expect(cards()[0]?.textContent).toContain("Bistro & Café");
  });

  test("a failing listStarters leaves the gallery usable", async () => {
    installMockPlatform({
      listStarters: (async () => {
        throw new Error("nope");
      }) as never,
    });
    void openNewProjectModal();
    await flush();
    expect(modal()).toBeTruthy();
    expect(cards()).toHaveLength(1);
    expect(cards()[0].classList.contains("selected")).toBe(true);
  });

  test("switching tabs and back keeps the gallery", async () => {
    installMockPlatform({ listStarters: (async () => SAMPLE_STARTERS) as never });
    void openNewProjectModal();
    await flush();
    switchTab("agent");
    expect(cards()).toHaveLength(0);
    switchTab("starter");
    expect(cards()).toHaveLength(3);
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

  test("creates the project, shows progress, initialises git, and resolves", async () => {
    let resolveCreate: (v: unknown) => void = () => {};
    const created: any[] = [];
    const { state } = installMockPlatform({
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
    clickCreate();

    // While createProject is pending the Create button is disabled and shows progress; Cancel
    // Stays rendered beside it.
    expect(footerLabels()).toEqual(["Cancel", "Back", "Creating…"]);
    expect(footerButtons()[2].hasAttribute("disabled")).toBe(true);

    resolveCreate({ config: { name: "My Site" }, root: "/home/dev/Sites/my-site" });
    const result = await promise;
    expect(result).toEqual({
      config: { name: "My Site" },
      root: "/home/dev/Sites/my-site",
    } as never);
    expect(modal()).toBeNull();
    // Name + Location only — no url, adapter, description or design in the payload.
    expect(created[0]).toEqual({
      destination: { kind: "path", parent: "/home/dev/Sites" },
      directory: "my-site",
      name: "My Site",
      template: "blank",
    });
    // A scaffold is not a repository, so the create path makes it one.
    expect(state.calls.map((c) => c[0])).toContain("gitInit");
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
    expect(footerLabels()).toEqual(["Cancel", "Back", "Create Project"]);
    expect(footerButtons()[2].hasAttribute("disabled")).toBe(false);
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
