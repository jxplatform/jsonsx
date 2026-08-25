/**
 * Coverage-gap tests for the New Project wizard and the Add Existing Repository picker:
 *
 * - New-project-modal: the credentials-gate re-render callbacks, the Template context label, starter
 *   selection + missing-selection validation, the busy guards on Back/tab-change, the agent
 *   submit's directory derivation + failure surface, and the destination fields surviving a
 *   Back/Next round-trip.
 * - Add-repo-modal: double-open, double-import, import-less platforms, and Escape dismissal.
 */
import {
  clearSeededSettings,
  flush,
  installMockPlatform,
  mountOverlayLayers,
  npFillLocation,
  npLocation,
  npName,
  npPreview,
  npSlug,
  npType,
  seedSettings,
} from "./harness";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { RepoInfo, StarterInfo } from "../src/types";

const { closeNewProjectModal, openNewProjectModal } =
  await import("../src/new-project/new-project-modal");
const { closeAddRepoModal, openAddRepoModal } = await import("../src/new-project/add-repo-modal");
const { initLayers } = await import("../src/ui/layers");

mountOverlayLayers(document.body);
initLayers();

type AnyEl = HTMLElement & { value?: string; selected?: string };

/**
 * A Parameters-step textfield addressed by its visible label. The identity and destination fields
 * carry stable classes (see the harness `np*` accessors); the remaining ones don't, and positional
 * indexing is not stable now that a destination block sits between the name and the description.
 */
function labelledField(label: string): AnyEl {
  const match = [...document.querySelectorAll("#layer-modal .new-project-field")].find(
    (f) => f.querySelector(".new-project-label")?.textContent?.trim() === label,
  );
  return match!.querySelector("sp-textfield") as AnyEl;
}

function footerButtons(): AnyEl[] {
  return [
    ...document.querySelectorAll("#layer-modal .new-project-modal-footer sp-button"),
  ] as AnyEl[];
}

function clickFooter(label: string) {
  const btn = footerButtons().find((b) => b.textContent?.includes(label));
  btn!.dispatchEvent(new Event("click", { bubbles: true }));
}

function switchTab(value: string) {
  const tabs = document.querySelector("#layer-modal sp-tabs") as AnyEl;
  tabs.selected = value;
  tabs.dispatchEvent(new Event("change", { bubbles: true }));
}

function errorText(): string | null {
  return document.querySelector("#layer-modal .new-project-error")?.textContent?.trim() ?? null;
}

function contextText(): string | null {
  return (
    document.querySelector("#layer-modal .new-project-step-context")?.textContent?.trim() ?? null
  );
}

const STARTERS: StarterInfo[] = [
  {
    accent: "#3b82f6",
    description: "d1",
    features: [],
    id: "portfolio",
    industry: "General",
    name: "Portfolio",
    tagline: "Show your work",
    thumbnail: "",
  },
  {
    accent: "#10b981",
    description: "d2",
    features: [],
    id: "bakery",
    industry: "Food",
    name: "Bakery",
    tagline: "Fresh daily",
    thumbnail: "",
  },
];

beforeEach(() => {
  localStorage.clear();
  clearSeededSettings();
});

afterEach(() => {
  closeNewProjectModal();
  closeAddRepoModal();
});

describe("new-project modal gaps", () => {
  test("saving a key through the agent gate re-renders past it", async () => {
    installMockPlatform();
    void openNewProjectModal();
    switchTab("agent");
    const creds = document.querySelector("#layer-modal .ai-creds-form") as HTMLElement;
    expect(creds).toBeTruthy();

    const keyInput = creds.querySelector('sp-textfield[type="password"]') as HTMLInputElement;
    keyInput.value = "sk-fresh-key";
    keyInput.dispatchEvent(new Event("input", { bubbles: true }));
    const save = [...creds.querySelectorAll("sp-button")].find((b) =>
      b.textContent?.includes("Save"),
    ) as HTMLElement;
    save.dispatchEvent(new Event("click", { bubbles: true }));
    await flush();

    // The gate lifted: the prompt field replaced the credentials form.
    expect(document.querySelector("#layer-modal .ai-creds-form")).toBeNull();
    expect(document.querySelector("#layer-modal .new-project-agent-prompt")).toBeTruthy();
  });

  test("the Name step labels the scratch source when no starters exist", () => {
    installMockPlatform(); // No listStarters → the scratch card is the whole gallery.
    void openNewProjectModal();
    clickFooter("Next");
    expect(contextText()).toBe("Start from scratch");
    // Nothing blocks Next: there is always a valid selection.
    expect(errorText()).toBeNull();
  });

  test("starter cards select on click and label the Name step", async () => {
    installMockPlatform({ listStarters: async () => STARTERS });
    void openNewProjectModal();
    await flush();
    const cards = [...document.querySelectorAll("#layer-modal .new-project-template")];
    // Two starters plus the trailing scratch card.
    expect(cards).toHaveLength(3);
    (cards[1] as HTMLElement).dispatchEvent(new Event("click", { bubbles: true }));
    await flush();
    const reCards = [...document.querySelectorAll("#layer-modal .new-project-template")];
    expect(reCards[1]!.classList.contains("selected")).toBe(true);

    clickFooter("Next");
    expect(contextText()).toContain("Starter site · Bakery");
    // Step 2 is Name + Location only — the description field left with the design quickstart.
    expect(labelledField("Project Name *")).toBeTruthy();
    expect(labelledField("Location *")).toBeTruthy();
  });

  test("Back and tab switches are ignored while a create is in flight", async () => {
    let releaseCreate: () => void = () => {};
    installMockPlatform({
      createProject: (async () => {
        await new Promise<void>((resolve) => {
          releaseCreate = resolve;
        });
        return { config: { name: "Slow Site" }, root: "/projects/slow-site" };
      }) as never,
    });
    const promise = openNewProjectModal();
    const staleTabs = document.querySelector("#layer-modal sp-tabs") as AnyEl;
    clickFooter("Next");
    npType(npName(), "Slow Site");
    npFillLocation();
    clickFooter("Create Project");
    expect(footerButtons().some((b) => b.textContent?.includes("Creating…"))).toBe(true);

    clickFooter("Back"); // Guarded: the wizard must stay on the Name step.
    expect(document.querySelector("#layer-modal .new-project-name")).toBeTruthy();

    staleTabs.selected = "agent"; // A stale tab strip cannot hijack the flow mid-create.
    staleTabs.dispatchEvent(new Event("change", { bubbles: true }));
    expect(document.querySelector("#layer-modal .new-project-name")).toBeTruthy();

    releaseCreate();
    expect(await promise).toEqual({
      config: { name: "Slow Site" },
      root: "/projects/slow-site",
    } as never);
  });

  test("agent submit derives a blank directory and surfaces create failures", async () => {
    seedSettings({ "jx.ai.openaiKey": "sk-agent-test" });
    const attempts: Record<string, unknown>[] = [];
    installMockPlatform({
      createProject: (async (opts: Record<string, unknown>) => {
        attempts.push(opts);
        throw new Error("quota exceeded for this account");
      }) as never,
    });
    void openNewProjectModal();
    switchTab("agent");
    npType(
      document.querySelector("#layer-modal .new-project-agent-prompt") as HTMLInputElement,
      "A tiny site",
    );
    clickFooter("Next");
    npType(npName(), "Failing Agent Site");
    npType(npSlug(), ""); // Clear the derived directory — submit must re-derive it.
    npFillLocation("/home/dev/Sites");
    clickFooter("Create & Start Agent");
    await flush();

    expect(attempts[0]).toMatchObject({
      destination: { kind: "path", parent: "/home/dev/Sites" },
      directory: "failing-agent-site",
      name: "Failing Agent Site",
      template: "blank",
    });
    expect(errorText()).toContain("quota exceeded");
  });

  test("the chosen Location survives a Back → Next round-trip", () => {
    installMockPlatform();
    void openNewProjectModal();
    clickFooter("Next");
    npType(npName(), "Round Trip");
    npFillLocation("/home/dev/Sites");
    expect(npPreview()).toContain("/home/dev/Sites/round-trip");

    clickFooter("Back");
    expect(document.querySelector("#layer-modal .new-project-location")).toBeNull();
    clickFooter("Next");

    // The destination fields keep the user's edits, like the rest of the Parameters step.
    expect(npLocation().value).toBe("/home/dev/Sites");
    expect(npSlug().value).toBe("round-trip");
    expect(npPreview()).toContain("/home/dev/Sites/round-trip");
  });
});

describe("add-repo modal gaps", () => {
  const REPOS: RepoInfo[] = [
    {
      defaultBranch: "main",
      fullName: "octocat/site",
      isJxProject: true,
      name: "site",
      owner: "octocat",
      permission: "admin",
      private: true,
    },
    {
      defaultBranch: "trunk",
      fullName: "acme/marketing",
      isJxProject: false,
      name: "marketing",
      owner: "acme",
      permission: "write",
      private: false,
    },
  ];

  function rows(): HTMLButtonElement[] {
    return [...document.querySelectorAll("#layer-modal .add-repo-row")] as HTMLButtonElement[];
  }

  test("a second open while the picker is up resolves null immediately", async () => {
    installMockPlatform({
      importProject: () => Promise.resolve({ root: "octocat/site@main" }),
      listRepos: () => Promise.resolve(REPOS),
    });
    const first = openAddRepoModal();
    await flush();
    expect(await openAddRepoModal()).toBeNull();
    closeAddRepoModal();
    expect(await first).toBeNull();
  });

  test("clicking another repo while an import runs is ignored", async () => {
    let releaseImport: () => void = () => {};
    let imports = 0;
    installMockPlatform({
      importProject: (() => {
        imports += 1;
        return new Promise((resolve) => {
          releaseImport = () => resolve({ root: "octocat/site@main" });
        });
      }) as never,
      listRepos: () => Promise.resolve(REPOS),
    });
    const promise = openAddRepoModal();
    await flush();
    rows()[0]!.dispatchEvent(new Event("click", { bubbles: true }));
    await flush();
    rows()[1]!.dispatchEvent(new Event("click", { bubbles: true }));
    await flush();
    expect(imports).toBe(1);
    releaseImport();
    expect(await promise).toEqual({ root: "octocat/site@main" });
  });

  test("platforms that cannot import surface the inline notice", async () => {
    installMockPlatform({ listRepos: () => Promise.resolve(REPOS) });
    const promise = openAddRepoModal();
    await flush();
    rows()[0]!.dispatchEvent(new Event("click", { bubbles: true }));
    await flush();
    expect(document.querySelector("#layer-modal .new-project-error")?.textContent).toContain(
      "cannot import repositories",
    );
    closeAddRepoModal();
    expect(await promise).toBeNull();
  });

  test("Escape dismisses the picker", async () => {
    installMockPlatform({
      importProject: () => Promise.resolve({ root: "r" }),
      listRepos: () => Promise.resolve(REPOS),
    });
    const promise = openAddRepoModal();
    await flush();
    const modal = document.querySelector("#layer-modal .add-repo-modal") as HTMLElement;
    modal.dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Escape" }),
    );
    expect(document.querySelector("#layer-modal .add-repo-modal")).toBeNull();
    expect(await promise).toBeNull();
  });
});
