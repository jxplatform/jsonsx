/**
 * Add Existing Repository modal tests — drives the real picker through the layer system: repo list
 * rendering with badges, filtering, import success resolving the catalogue root key, the structured
 * not_jx_project failure staying inline, and dismissal.
 */
import { flush, installMockPlatform } from "./harness";
import { afterEach, describe, expect, mock, test } from "bun:test";
import type { RepoInfo } from "../src/types";

const { closeAddRepoModal, openAddRepoModal, platformSupportsAddRepo } =
  await import("../src/new-project/add-repo-modal");
const { initLayers } = await import("../src/ui/layers");

document.body.innerHTML = `
  <div id="layer-popover"></div>
  <div id="layer-modal"></div>
  <div id="layer-dialog"></div>
`;
initLayers();

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

function modal(): HTMLElement | null {
  return document.querySelector("#layer-modal .add-repo-modal");
}

function errorText(): string | null {
  return document.querySelector("#layer-modal .new-project-error")?.textContent?.trim() ?? null;
}

afterEach(() => {
  closeAddRepoModal();
});

describe("platformSupportsAddRepo", () => {
  test("requires both listRepos and importProject", () => {
    installMockPlatform();
    expect(platformSupportsAddRepo()).toBe(false);
    installMockPlatform({ listRepos: () => Promise.resolve(REPOS) });
    expect(platformSupportsAddRepo()).toBe(false);
    installMockPlatform({
      importProject: () => Promise.resolve({ root: "octocat/site@main" }),
      listRepos: () => Promise.resolve(REPOS),
    });
    expect(platformSupportsAddRepo()).toBe(true);
  });
});

describe("openAddRepoModal", () => {
  test("lists repos with badges and filters by full name", async () => {
    installMockPlatform({
      importProject: () => Promise.resolve({ root: "octocat/site@main" }),
      listRepos: () => Promise.resolve(REPOS),
    });
    const promise = openAddRepoModal();
    await flush();
    expect(modal()).toBeTruthy();
    expect(rows()).toHaveLength(2);
    expect(rows()[0]!.textContent).toContain("octocat/site");
    expect(rows()[0]!.textContent).toContain("Jx");
    expect(rows()[0]!.textContent).toContain("private");
    expect(rows()[1]!.textContent).toContain("trunk · write");

    const filter = document.querySelector("#layer-modal .add-repo-filter") as HTMLInputElement;
    filter.value = "acme";
    filter.dispatchEvent(new Event("input", { bubbles: true }));
    expect(rows()).toHaveLength(1);
    expect(rows()[0]!.textContent).toContain("acme/marketing");

    closeAddRepoModal();
    expect(await promise).toBeNull();
  });

  test("importing a repo resolves with its catalogue root key", async () => {
    const importProject = mock((opts: { owner: string; name: string }) =>
      Promise.resolve({ root: `${opts.owner}/${opts.name}@main` }),
    );
    installMockPlatform({
      importProject: importProject as never,
      listRepos: () => Promise.resolve(REPOS),
    });
    const promise = openAddRepoModal();
    await flush();
    rows()[0]!.dispatchEvent(new Event("click", { bubbles: true }));
    await flush();
    expect(importProject).toHaveBeenCalledWith({ name: "site", owner: "octocat" });
    expect(await promise).toEqual({ root: "octocat/site@main" });
    expect(modal()).toBeNull();
  });

  test("a not_jx_project failure stays inline and the picker remains open", async () => {
    installMockPlatform({
      importProject: () =>
        Promise.reject(
          Object.assign(new Error("acme/marketing has no readable project.json"), {
            code: "not_jx_project",
          }),
        ),
      listRepos: () => Promise.resolve(REPOS),
    });
    const promise = openAddRepoModal();
    await flush();
    rows()[1]!.dispatchEvent(new Event("click", { bubbles: true }));
    await flush();
    expect(modal()).toBeTruthy();
    expect(errorText()).toContain("no readable project.json");

    closeAddRepoModal();
    expect(await promise).toBeNull();
  });

  test("a failed repo listing shows the error with an empty list", async () => {
    installMockPlatform({
      importProject: () => Promise.resolve({ root: "r" }),
      listRepos: () => Promise.reject(new Error("GitHub authorization expired")),
    });
    const promise = openAddRepoModal();
    await flush();
    expect(rows()).toHaveLength(0);
    expect(errorText()).toContain("GitHub authorization expired");
    closeAddRepoModal();
    expect(await promise).toBeNull();
  });
});
